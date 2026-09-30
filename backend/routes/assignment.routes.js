const express  = require("express");
const router   = express.Router();
const { admin, db } = require("../config/firebase");
const multer   = require("multer");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const path     = require("path");
const { notify, getStudentUidsForSubject } = require("../services/notify");

const r2 = new S3Client({
  region:   "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET    = process.env.R2_BUCKET;
const R2_PUBLIC = process.env.R2_PUBLIC_URL;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ALLOWED = [
      "application/pdf",
      "image/jpeg", "image/png", "image/gif", "image/webp",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain",
    ];
    if (ALLOWED.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`), false);
    }
  },
});

// ─── Upload a single buffer to R2 ────────────────────────────────
// Path structure: {folder}/{entity_id}/{originalName}
// entity_id is optional — pass null to use a uuid subfolder
async function uploadToR2(buffer, originalName, mimeType, folder, entityId = null) {
  // Sanitise filename: strip path separators, keep extension, preserve name
  const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._\-() ]/g, "_");
  const subDir   = entityId || uuidv4();
  const key      = `${folder}/${subDir}/${safeName}`;

  await r2.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimeType,
    ContentDisposition: `inline; filename="${safeName}"`,
  }));

  return {
    key,
    url:  `${R2_PUBLIC}/${key}`,
    name: originalName,   // keep original name for display
    size: buffer.length,
    type: mimeType,
  };
}

// ─── Delete a key from R2 (best-effort, never throws) ────────────
async function deleteFromR2(key) {
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (e) {
    console.error("R2 delete failed for key:", key, e.message);
  }
}

// ─── Multer error handler ─────────────────────────────────────────
function handleMulterError(err, res) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(400).json({ success: false, error: "File too large. Max 10 MB per file." });
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) return res.status(400).json({ success: false, error: err.message });
  return null;
}

// ─── Validate links array ─────────────────────────────────────────
function parseLinks(raw) {
  // raw can be a JSON string or an array sent via form-data
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((l) => l && typeof l.url === "string" && l.url.trim())
      .map((l) => ({
        url:   l.url.trim(),
        label: l.label?.trim() || l.url.trim(),
      }));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
// 📌 POST /api/assignments/upload
// Standalone file upload — returns URLs immediately.
// Use this BEFORE creating an assignment/announcement so the
// frontend can attach the returned URLs to the create payload.
//
// Form-data fields:
//   files[]  — one or more files (required)
//   folder   — "assignments" | "announcements" | "submissions"  (required)
// ═══════════════════════════════════════════════════════════════════
router.post(
  "/upload",
  (req, res, next) => upload.array("files", 10)(req, res, (err) => {
    if (handleMulterError(err, res)) return;
    next();
  }),
  async (req, res) => {
    try {
      const { folder, entity_id } = req.body;
      const VALID_FOLDERS = ["assignments", "announcements", "submissions"];

      if (!folder || !VALID_FOLDERS.includes(folder)) {
        return res.status(400).json({
          success: false,
          error: `folder must be one of: ${VALID_FOLDERS.join(", ")}`,
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, error: "No files provided" });
      }

      // entity_id creates a dedicated subfolder: assignments/assign_abc123/filename.pdf
      // This keeps all files for one entity together and prevents name collisions.
      const uploaded = await Promise.all(
        req.files.map((f) => uploadToR2(f.buffer, f.originalname, f.mimetype, folder, entity_id || null))
      );

      return res.status(201).json({ success: true, files: uploaded });
    } catch (error) {
      console.error("UPLOAD ERROR:", error);
      return res.status(500).json({ success: false, error: "File upload failed" });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// ───────────────────────────────────────────────────────────────────
//  ANNOUNCEMENTS
// ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// 📌 POST /api/assignments/announcements
// Teacher creates an announcement.
//
// Form-data or JSON body:
//   teacher_id        string   (required)
//   course_id         string   (required)
//   subject_id        string   (required)
//   title             string   (required)
//   text              string   (required)
//   is_pinned         boolean  (default false)
//   attachments       JSON string → [{ url, key, name, size, type }]
//   links             JSON string → [{ url, label }]
// ─────────────────────────────────────────────────────────────────
router.post("/announcements", async (req, res) => {
  try {
    const {
      teacher_id, course_id, subject_id,
      title, text,
      is_pinned   = false,
      attachments,
      links,
    } = req.body;

    if (!teacher_id || !course_id || !subject_id || !title || !text) {
      return res.status(400).json({
        success: false,
        error: "teacher_id, course_id, subject_id, title and text are required",
      });
    }

    // Parse attachments — either pre-uploaded objects or empty
    let parsedAttachments = [];
    try {
      parsedAttachments = attachments
        ? (typeof attachments === "string" ? JSON.parse(attachments) : attachments)
        : [];
    } catch {
      parsedAttachments = [];
    }

    const parsedLinks = parseLinks(links);

    const ref = db.collection("announcements").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();

    await ref.set({
      announcement_id:   ref.id,
      teacher_id,
      course_id,
      subject_id,
      announcement_type: "class_announcement",
      title:             title.trim(),
      text:              text.trim(),
      is_pinned:         Boolean(is_pinned),
      attachments:       parsedAttachments,
      links:             parsedLinks,
      created_at:        now,
      updated_at:        now,
    });

    const announcementStudentIds = await getStudentUidsForSubject(subject_id);
    notify({
      userIds: announcementStudentIds,
      title: "📢 New Announcement",
      body: title.trim(),
      data: { screen: "StudentWork", params: { subject_id, course_id } },
    });

    return res.status(201).json({
      success:         true,
      announcement_id: ref.id,
      message:         "Announcement created",
    });
  } catch (error) {
    console.error("CREATE ANNOUNCEMENT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to create announcement" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments/announcements
// Fetch announcements for a subject. Pinned first, then by date.
//
// Query params:
//   subject_id   string  (required)
//   course_id    string  (required)
//   limit        number  (default 30)
// ─────────────────────────────────────────────────────────────────
router.get("/announcements", async (req, res) => {
  try {
    const { subject_id, course_id, limit = 30 } = req.query;

    if (!subject_id || !course_id) {
      return res.status(400).json({
        success: false,
        error: "subject_id and course_id are required",
      });
    }

    const snap = await db
      .collection("announcements")
      .where("subject_id", "==", subject_id)
      .where("course_id",  "==", course_id)
      .get();

    let announcements = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        created_at: d.created_at?.toDate?.()?.toISOString() || null,
        updated_at: d.updated_at?.toDate?.()?.toISOString() || null,
      };
    });

    // Sort in memory: pinned first, then by date desc — avoids composite index
    announcements.sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });

    // Apply limit in memory
    announcements = announcements.slice(0, Number(limit));

    return res.json({ success: true, count: announcements.length, announcements });
  } catch (error) {
    console.error("GET ANNOUNCEMENTS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch announcements" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 PUT /api/assignments/announcements/:id
// Teacher edits an announcement.
//
// Body (all optional — only provided fields are updated):
//   teacher_id   string   (required for ownership check)
//   title        string
//   text         string
//   is_pinned    boolean
//   attachments  JSON     full replacement array
//   links        JSON     full replacement array
//   deleted_keys string[] R2 keys to delete (old files)
// ─────────────────────────────────────────────────────────────────
router.put("/announcements/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { teacher_id, title, text, is_pinned, attachments, links, deleted_keys } = req.body;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }

    const ref = db.collection("announcements").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Announcement not found" });
    }

    if (snap.data().teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const updates = { updated_at: admin.firestore.FieldValue.serverTimestamp() };
    if (title       !== undefined) updates.title       = title.trim();
    if (text        !== undefined) updates.text        = text.trim();
    if (is_pinned   !== undefined) updates.is_pinned   = Boolean(is_pinned);
    if (attachments !== undefined) {
      updates.attachments = typeof attachments === "string" ? JSON.parse(attachments) : attachments;
    }
    if (links !== undefined) updates.links = parseLinks(links);

    await ref.update(updates);

    // Clean up deleted R2 files (best-effort, non-blocking)
    if (Array.isArray(deleted_keys) && deleted_keys.length > 0) {
      Promise.all(deleted_keys.map(deleteFromR2)).catch(() => {});
    }

    return res.json({ success: true, message: "Announcement updated" });
  } catch (error) {
    console.error("UPDATE ANNOUNCEMENT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to update announcement" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 DELETE /api/assignments/announcements/:id
// Teacher deletes an announcement and its R2 files.
//
// Query: teacher_id  (required for ownership check)
// ─────────────────────────────────────────────────────────────────
router.delete("/announcements/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }

    const ref  = db.collection("announcements").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Announcement not found" });
    }

    if (snap.data().teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const keys = (snap.data().attachments || []).map((a) => a.key).filter(Boolean);

    await ref.delete();

    // Clean up R2 files (best-effort)
    if (keys.length > 0) {
      Promise.all(keys.map(deleteFromR2)).catch(() => {});
    }

    return res.json({ success: true, message: "Announcement deleted" });
  } catch (error) {
    console.error("DELETE ANNOUNCEMENT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to delete announcement" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ───────────────────────────────────────────────────────────────────
//  ASSIGNMENTS
// ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// 📌 POST /api/assignments
// Teacher creates an assignment.
//
// Body (JSON):
//   teacher_id          string   (required)
//   course_id           string   (required)
//   subject_id          string   (required)
//   title               string   (required)
//   instructions        string   (optional)
//   questions           string   (optional — plain text)
//   marks               number   (required)
//   due_date            ISO str  (required)
//   allow_late          boolean  (default false)
//   attachments         array    [{ url, key, name, size, type }]  pre-uploaded
//   links               array    [{ url, label }]
// ─────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      teacher_id, course_id, subject_id,
      title, instructions, questions,
      marks, due_date, allow_late = false,
      attachments, links,
    } = req.body;

    if (!teacher_id || !course_id || !subject_id || !title || !marks || !due_date) {
      return res.status(400).json({
        success: false,
        error: "teacher_id, course_id, subject_id, title, marks and due_date are required",
      });
    }

    const marksNum = Number(marks);
    if (isNaN(marksNum) || marksNum < 1) {
      return res.status(400).json({ success: false, error: "marks must be a positive number" });
    }

    const dueDateObj = new Date(due_date);
    if (isNaN(dueDateObj.getTime())) {
      return res.status(400).json({ success: false, error: "due_date must be a valid ISO date string" });
    }

    let parsedAttachments = [];
    try {
      parsedAttachments = attachments
        ? (typeof attachments === "string" ? JSON.parse(attachments) : attachments)
        : [];
    } catch {
      parsedAttachments = [];
    }

    const parsedLinks = parseLinks(links);

    const ref = db.collection("assignments").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();

    await ref.set({
      assignment_id:    ref.id,
      teacher_id,
      course_id,
      subject_id,
      title:            title.trim(),
      instructions:     instructions?.trim() || null,
      questions:        questions?.trim()    || null,
      marks:            marksNum,
      due_date:         admin.firestore.Timestamp.fromDate(dueDateObj),
      allow_late:       Boolean(allow_late),
      attachments:      parsedAttachments,
      links:            parsedLinks,
      submissions_count: 0,
      created_at:       now,
      updated_at:       now,
    });

    const assignmentStudentIds = await getStudentUidsForSubject(subject_id);
    notify({
      userIds: assignmentStudentIds,
      title: "📝 New Assignment",
      body: `${title.trim()} — Due ${new Date(due_date).toLocaleDateString()}`,
      data: { screen: "StudentWork", params: { subject_id, course_id } },
    });

    return res.status(201).json({
      success:       true,
      assignment_id: ref.id,
      message:       "Assignment created",
    });
  } catch (error) {
    console.error("CREATE ASSIGNMENT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to create assignment" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments
// Fetch assignments for a subject.
//
// Query params:
//   subject_id   string  (required)
//   course_id    string  (required)
//   limit        number  (default 30)
// ─────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { subject_id, course_id, limit = 30 } = req.query;

    if (!subject_id || !course_id) {
      return res.status(400).json({ success: false, error: "subject_id and course_id are required" });
    }

    const snap = await db
      .collection("assignments")
      .where("subject_id", "==", subject_id)
      .where("course_id",  "==", course_id)
      .get();

    let assignments = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        due_date:   d.due_date?.toDate?.()?.toISOString()   || null,
        created_at: d.created_at?.toDate?.()?.toISOString() || null,
        updated_at: d.updated_at?.toDate?.()?.toISOString() || null,
      };
    });

    // Sort by due_date desc in memory — avoids composite index
    assignments.sort((a, b) =>
      new Date(b.due_date || 0).getTime() - new Date(a.due_date || 0).getTime()
    );

    // Apply limit in memory
    assignments = assignments.slice(0, Number(limit));

    return res.json({ success: true, count: assignments.length, assignments });
  } catch (error) {
    console.error("GET ASSIGNMENTS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch assignments" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments/my-submissions
// Student fetches all their submissions (with assignment details),
// optionally filtered by subject_id.
// IMPORTANT: Must be registered before GET /:id to avoid shadowing.
//
// Query:
//   student_uid   string  (required)
//   subject_id    string  (optional filter)
// ─────────────────────────────────────────────────────────────────
router.get("/my-submissions", async (req, res) => {
  try {
    const { student_uid, subject_id } = req.query;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    const subsSnap = await db
      .collection("submissions")
      .where("student_uid", "==", student_uid)
      .orderBy("submitted_at", "desc")
      .get();

    const assignmentIds = [...new Set(subsSnap.docs.map((d) => d.data().assignment_id))];
    const assignmentMap = {};

    await Promise.all(
      assignmentIds.map(async (aid) => {
        const snap = await db.collection("assignments").doc(aid).get();
        if (snap.exists) {
          const a = snap.data();
          assignmentMap[aid] = {
            title:      a.title,
            marks:      a.marks,
            due_date:   a.due_date?.toDate?.()?.toISOString() || null,
            subject_id: a.subject_id,
            course_id:  a.course_id,
          };
        }
      })
    );

    let submissions = subsSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        submitted_at:       d.submitted_at?.toDate?.()?.toISOString() || null,
        graded_at:          d.graded_at?.toDate?.()?.toISOString()    || null,
        assignment_details: assignmentMap[d.assignment_id] || null,
      };
    });

    if (subject_id) {
      submissions = submissions.filter(
        (s) => s.assignment_details?.subject_id === subject_id
      );
    }

    return res.json({ success: true, count: submissions.length, submissions });
  } catch (error) {
    console.error("MY SUBMISSIONS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch submissions" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments/student/:student_uid
// Student fetches all their submissions across all assignments.
// Useful for a "My Submissions" history screen.
// IMPORTANT: Must be registered before GET /:id to avoid shadowing.
//
// Query: subject_id  (optional filter)
// ─────────────────────────────────────────────────────────────────
router.get("/student/:student_uid", async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { subject_id }  = req.query;

    const subsSnap = await db
      .collection("submissions")
      .where("student_uid", "==", student_uid)
      .orderBy("submitted_at", "desc")
      .get();

    const assignmentIds = [...new Set(subsSnap.docs.map((d) => d.data().assignment_id))];
    const assignmentMap = {};

    await Promise.all(
      assignmentIds.map(async (aid) => {
        const snap = await db.collection("assignments").doc(aid).get();
        if (snap.exists) {
          const a = snap.data();
          assignmentMap[aid] = {
            title:      a.title,
            marks:      a.marks,
            due_date:   a.due_date?.toDate?.()?.toISOString() || null,
            subject_id: a.subject_id,
            course_id:  a.course_id,
          };
        }
      })
    );

    let submissions = subsSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        submitted_at:       d.submitted_at?.toDate?.()?.toISOString() || null,
        graded_at:          d.graded_at?.toDate?.()?.toISOString()    || null,
        assignment_details: assignmentMap[d.assignment_id] || null,
      };
    });

    if (subject_id) {
      submissions = submissions.filter(
        (s) => s.assignment_details?.subject_id === subject_id
      );
    }

    return res.json({ success: true, count: submissions.length, submissions });
  } catch (error) {
    console.error("STUDENT SUBMISSIONS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch student submissions" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments/:id
// Fetch a single assignment by ID.
// IMPORTANT: Registered here (after all static-prefix GET routes)
// so it does not shadow /my-submissions, /student/:uid, etc.
// ─────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const snap = await db.collection("assignments").doc(id).get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    const d = snap.data();
    return res.json({
      success: true,
      assignment: {
        ...d,
        due_date:   d.due_date?.toDate?.()?.toISOString()   || null,
        created_at: d.created_at?.toDate?.()?.toISOString() || null,
        updated_at: d.updated_at?.toDate?.()?.toISOString() || null,
      },
    });
  } catch (error) {
    console.error("GET ASSIGNMENT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch assignment" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 PUT /api/assignments/:id
// Teacher edits an assignment.
//
// Body (all optional — only provided fields are updated):
//   teacher_id    string   (required for ownership check)
//   title         string
//   instructions  string
//   questions     string
//   marks         number
//   due_date      ISO str
//   allow_late    boolean
//   attachments   array    full replacement
//   links         array    full replacement
//   deleted_keys  string[] R2 keys to delete
// ─────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      teacher_id, title, instructions, questions,
      marks, due_date, allow_late,
      attachments, links, deleted_keys,
    } = req.body;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }

    const ref  = db.collection("assignments").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    if (snap.data().teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const updates = { updated_at: admin.firestore.FieldValue.serverTimestamp() };

    if (title        !== undefined) updates.title        = title.trim();
    if (instructions !== undefined) updates.instructions = instructions?.trim() || null;
    if (questions    !== undefined) updates.questions    = questions?.trim()    || null;
    if (allow_late   !== undefined) updates.allow_late   = Boolean(allow_late);

    if (marks !== undefined) {
      const marksNum = Number(marks);
      if (isNaN(marksNum) || marksNum < 1)
        return res.status(400).json({ success: false, error: "marks must be a positive number" });
      updates.marks = marksNum;
    }

    if (due_date !== undefined) {
      const d = new Date(due_date);
      if (isNaN(d.getTime()))
        return res.status(400).json({ success: false, error: "due_date must be a valid ISO date string" });
      updates.due_date = admin.firestore.Timestamp.fromDate(d);
    }

    if (attachments !== undefined) {
      updates.attachments = typeof attachments === "string" ? JSON.parse(attachments) : attachments;
    }
    if (links !== undefined) updates.links = parseLinks(links);

    await ref.update(updates);

    if (Array.isArray(deleted_keys) && deleted_keys.length > 0) {
      Promise.all(deleted_keys.map(deleteFromR2)).catch(() => {});
    }

    return res.json({ success: true, message: "Assignment updated" });
  } catch (error) {
    console.error("UPDATE ASSIGNMENT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to update assignment" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 DELETE /api/assignments/:id
// Teacher deletes an assignment and cleans up R2 + submissions.
//
// Query: teacher_id  (required)
// ─────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }

    const ref  = db.collection("assignments").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    if (snap.data().teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    // Collect all R2 keys — assignment attachments + all submission attachments
    const r2Keys = (snap.data().attachments || []).map((a) => a.key).filter(Boolean);

    const subsSnap = await db
      .collection("submissions")
      .where("assignment_id", "==", id)
      .get();

    subsSnap.docs.forEach((doc) => {
      (doc.data().attachments || []).forEach((a) => {
        if (a.key) r2Keys.push(a.key);
      });
    });

    // Firestore batch delete submissions
    const batch = db.batch();
    subsSnap.docs.forEach((doc) => batch.delete(doc.ref));
    batch.delete(ref);
    await batch.commit();

    // R2 cleanup (best-effort)
    if (r2Keys.length > 0) {
      Promise.all(r2Keys.map(deleteFromR2)).catch(() => {});
    }

    return res.json({ success: true, message: "Assignment and all submissions deleted" });
  } catch (error) {
    console.error("DELETE ASSIGNMENT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to delete assignment" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ───────────────────────────────────────────────────────────────────
//  SUBMISSIONS
// ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// 📌 POST /api/assignments/:id/submit
// Student submits to an assignment. Files must be pre-uploaded via
// POST /api/assignments/upload first.
//
// JSON body:
//   student_uid   string   (required)
//   attachments   array    (optional) → [{ url, key, name, size, type }]
//   links         array    (optional) → [{ url, label }]
// ─────────────────────────────────────────────────────────────────
// NOTE: Files must be pre-uploaded via POST /api/assignments/upload.
// This endpoint accepts a JSON body with pre-uploaded attachment objects.
router.post("/:id/submit", async (req, res) => {
  try {
    const assignment_id = req.params.id;
    const { student_uid, attachments, links } = req.body;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    // ── 1. Fetch assignment ──────────────────────────────────────
    const assignmentRef  = db.collection("assignments").doc(assignment_id);
    const assignmentSnap = await assignmentRef.get();

    if (!assignmentSnap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    const assignment = assignmentSnap.data();

    // ── 2. Duplicate check ───────────────────────────────────────
    const dupSnap = await db
      .collection("submissions")
      .where("assignment_id", "==", assignment_id)
      .where("student_uid",   "==", student_uid)
      .limit(1)
      .get();

    if (!dupSnap.empty) {
      return res.status(409).json({
        success:       false,
        error:         "You have already submitted this assignment. Use the resubmit endpoint to update.",
        submission_id: dupSnap.docs[0].id,
      });
    }

    // ── 3. Late detection ────────────────────────────────────────
    const now     = new Date();
    const dueDate = assignment.due_date?.toDate?.();
    const isLate  = dueDate && now > dueDate;

    if (isLate && !assignment.allow_late) {
      return res.status(403).json({
        success: false,
        error:   "Submission deadline has passed and late submissions are not allowed",
      });
    }

    // ── 4. Validate pre-uploaded attachments + links ─────────────
    const uploadedFiles = Array.isArray(attachments) ? attachments : [];
    const parsedLinks   = parseLinks(links);

    if (uploadedFiles.length === 0 && parsedLinks.length === 0) {
      return res.status(400).json({
        success: false,
        error:   "Submission must include at least one file or link",
      });
    }

    // ── 5. Write submission + increment counter (transaction) ────
    const subRef = db.collection("submissions").doc();

    await db.runTransaction(async (t) => {
      t.set(subRef, {
        submission_id:  subRef.id,
        assignment_id,
        student_uid,
        attachments:    uploadedFiles,
        links:          parsedLinks,
        status:         isLate ? "late" : "submitted",
        marks_obtained: null,
        feedback:       null,
        submitted_at:   admin.firestore.FieldValue.serverTimestamp(),
        graded_at:      null,
      });

      t.update(assignmentRef, {
        submissions_count: admin.firestore.FieldValue.increment(1),
      });
    });

    return res.status(201).json({
      success:       true,
      submission_id: subRef.id,
      status:        isLate ? "late" : "submitted",
      message:       isLate ? "Submitted (late)" : "Submitted successfully",
    });
  } catch (error) {
    console.error("SUBMIT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to submit assignment" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 PUT /api/assignments/:id/resubmit
// Student replaces their existing submission (before grading).
// New files must be pre-uploaded via POST /api/assignments/upload first.
//
// JSON body:
//   student_uid     string   (required)
//   attachments     array    (optional) new pre-uploaded files to add
//   links           array    (optional) → [{ url, label }]
//   deleted_keys    string[] R2 keys to remove from previous upload
// ─────────────────────────────────────────────────────────────────
// NOTE: New files must be pre-uploaded via POST /api/assignments/upload.
// This endpoint accepts a JSON body with pre-uploaded attachment objects.
router.put("/:id/resubmit", async (req, res) => {
  try {
    const assignment_id = req.params.id;
    const { student_uid, attachments, links, deleted_keys } = req.body;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    // ── 1. Find existing submission ──────────────────────────────
    const subSnap = await db
      .collection("submissions")
      .where("assignment_id", "==", assignment_id)
      .where("student_uid",   "==", student_uid)
      .limit(1)
      .get();

    if (subSnap.empty) {
      return res.status(404).json({
        success: false,
        error:   "No existing submission found. Use the submit endpoint first.",
      });
    }

    const subDoc  = subSnap.docs[0];
    const subData = subDoc.data();

    // Block resubmission once graded
    if (subData.status === "graded") {
      return res.status(403).json({
        success: false,
        error:   "Submission has already been graded and cannot be changed",
      });
    }

    // ── 2. Fetch assignment for late check ───────────────────────
    const assignmentSnap = await db.collection("assignments").doc(assignment_id).get();
    if (!assignmentSnap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    const assignment = assignmentSnap.data();
    const now        = new Date();
    const dueDate    = assignment.due_date?.toDate?.();
    const isLate     = dueDate && now > dueDate;

    if (isLate && !assignment.allow_late) {
      return res.status(403).json({
        success: false,
        error:   "Submission deadline has passed and late submissions are not allowed",
      });
    }

    // ── 3. Resolve new files and merge with existing ─────────────
    const newFiles    = Array.isArray(attachments) ? attachments : [];
    const parsedLinks = parseLinks(links);

    let keysToDelete = [];
    try {
      keysToDelete = Array.isArray(deleted_keys) ? deleted_keys : [];
    } catch { keysToDelete = []; }

    const existingFiles = (subData.attachments || []).filter(
      (a) => !keysToDelete.includes(a.key)
    );
    const mergedFiles = [...existingFiles, ...newFiles];

    if (mergedFiles.length === 0 && parsedLinks.length === 0) {
      return res.status(400).json({
        success: false,
        error:   "Resubmission must include at least one file or link",
      });
    }

    await subDoc.ref.update({
      attachments:    mergedFiles,
      links:          parsedLinks,
      status:         isLate ? "late" : "submitted",
      submitted_at:   admin.firestore.FieldValue.serverTimestamp(),
      graded_at:      null,
      marks_obtained: null,
      feedback:       null,
    });

    // Delete old R2 files (best-effort)
    if (keysToDelete.length > 0) {
      Promise.all(keysToDelete.map(deleteFromR2)).catch(() => {});
    }

    return res.json({
      success:       true,
      submission_id: subDoc.id,
      status:        isLate ? "late" : "submitted",
      message:       "Submission updated",
    });
  } catch (error) {
    console.error("RESUBMIT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to resubmit" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments/:id/submissions
// Teacher fetches all submissions for an assignment.
//
// Query: teacher_id  (required — ownership check)
// ─────────────────────────────────────────────────────────────────
router.get("/:id/submissions", async (req, res) => {
  try {
    const assignment_id = req.params.id;
    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }

    // Ownership check
    const assignmentSnap = await db.collection("assignments").doc(assignment_id).get();
    if (!assignmentSnap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    if (assignmentSnap.data().teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const subsSnap = await db
      .collection("submissions")
      .where("assignment_id", "==", assignment_id)
      .orderBy("submitted_at", "desc")
      .get();

    // Batch-fetch student names
    const studentUids = [...new Set(subsSnap.docs.map((d) => d.data().student_uid))];
    const studentMap  = {};

    await Promise.all(
      studentUids.map(async (uid) => {
        const snap = await db.collection("students").where("uid", "==", uid).limit(1).get();
        if (!snap.empty) {
          const s = snap.docs[0].data();
          studentMap[uid] = {
            name:    s.name    || `${s.first_name} ${s.last_name}`,
            roll_no: s.roll_no || null,
          };
        }
      })
    );

    const submissions = subsSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        student_name:  studentMap[d.student_uid]?.name    || null,
        student_roll:  studentMap[d.student_uid]?.roll_no || null,
        submitted_at:  d.submitted_at?.toDate?.()?.toISOString() || null,
        graded_at:     d.graded_at?.toDate?.()?.toISOString()    || null,
      };
    });

    return res.json({
      success: true,
      count:   submissions.length,
      submissions,
    });
  } catch (error) {
    console.error("GET SUBMISSIONS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch submissions" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments/:id/my-submission
// Student fetches their own submission for an assignment.
//
// Query: student_uid  (required)
// ─────────────────────────────────────────────────────────────────
router.get("/:id/my-submission", async (req, res) => {
  try {
    const assignment_id = req.params.id;
    const { student_uid } = req.query;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    const subSnap = await db
      .collection("submissions")
      .where("assignment_id", "==", assignment_id)
      .where("student_uid",   "==", student_uid)
      .limit(1)
      .get();

    if (subSnap.empty) {
      return res.json({ success: true, submission: null });
    }

    const d = subSnap.docs[0].data();
    return res.json({
      success: true,
      submission: {
        ...d,
        submitted_at: d.submitted_at?.toDate?.()?.toISOString() || null,
        graded_at:    d.graded_at?.toDate?.()?.toISOString()    || null,
      },
    });
  } catch (error) {
    console.error("GET MY SUBMISSION ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch submission" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ───────────────────────────────────────────────────────────────────
//  GRADING
// ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

router.post("/grade/:submission_id", async (req, res) => {
  try {
    const { submission_id } = req.params;
    const { teacher_id, marks_obtained, feedback, returned } = req.body;

    if (!teacher_id || marks_obtained === undefined) {
      return res.status(400).json({
        success: false,
        error:   "teacher_id and marks_obtained are required",
      });
    }

    const marksNum = Number(marks_obtained);
    if (isNaN(marksNum) || marksNum < 0) {
      return res.status(400).json({ success: false, error: "marks_obtained must be a non-negative number" });
    }

    // ── 1. Fetch submission ──────────────────────────────────────
    const subRef  = db.collection("submissions").doc(submission_id);
    const subSnap = await subRef.get();

    if (!subSnap.exists) {
      return res.status(404).json({ success: false, error: "Submission not found" });
    }

    const sub = subSnap.data();

    // ── 2. Fetch assignment for ownership + max marks check ──────
    const assignmentSnap = await db.collection("assignments").doc(sub.assignment_id).get();

    if (!assignmentSnap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    const assignment = assignmentSnap.data();

    if (assignment.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    if (marksNum > assignment.marks) {
      return res.status(400).json({
        success: false,
        error:   `marks_obtained (${marksNum}) cannot exceed assignment total marks (${assignment.marks})`,
      });
    }

    // ── 3. Write grade ───────────────────────────────────────────
    await subRef.update({
      marks_obtained: marksNum,
      feedback:       feedback?.trim() || null,
      returned:       returned === true || returned === "true",
      status:         "graded",
      graded_at:      admin.firestore.FieldValue.serverTimestamp(),
    });

    notify({
      userIds: [sub.student_uid],
      title: "Assignment Graded",
      body: `You scored ${marksNum}/${assignment.marks} on "${assignment.title}"`,
      data: { screen: "StudentWork" },
    });

    return res.json({
      success:        true,
      submission_id,
      marks_obtained: marksNum,
      out_of:         assignment.marks,
      returned:       returned === true || returned === "true",
      message:        "Submission graded",
    });
  } catch (error) {
    console.error("GRADE ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to grade submission" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 PUT /api/assignments/grade/:submission_id
// Teacher updates an already-graded submission.
// Same body as POST /grade.
// ─────────────────────────────────────────────────────────────────
router.put("/grade/:submission_id", async (req, res) => {
  try {
    const { submission_id } = req.params;
    const { teacher_id, marks_obtained, feedback, returned } = req.body;

    if (!teacher_id || marks_obtained === undefined) {
      return res.status(400).json({ success: false, error: "teacher_id and marks_obtained are required" });
    }

    const marksNum = Number(marks_obtained);
    if (isNaN(marksNum) || marksNum < 0) {
      return res.status(400).json({ success: false, error: "marks_obtained must be a non-negative number" });
    }

    const subRef  = db.collection("submissions").doc(submission_id);
    const subSnap = await subRef.get();

    if (!subSnap.exists) {
      return res.status(404).json({ success: false, error: "Submission not found" });
    }

    const assignmentSnap = await db
      .collection("assignments")
      .doc(subSnap.data().assignment_id)
      .get();

    if (!assignmentSnap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    const assignment = assignmentSnap.data();

    if (assignment.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    if (marksNum > assignment.marks) {
      return res.status(400).json({
        success: false,
        error:   `marks_obtained cannot exceed assignment total marks (${assignment.marks})`,
      });
    }

    await subRef.update({
      marks_obtained: marksNum,
      feedback:       feedback?.trim() || null,
      returned:       returned === true || returned === "true",  // ← ADD THIS
      status:         "graded",
      graded_at:      admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, submission_id, marks_obtained: marksNum, message: "Grade updated" });
  } catch (error) {
    console.error("UPDATE GRADE ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to update grade" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments/:id/summary
// Teacher gets a grading summary for an assignment.
// ─────────────────────────────────────────────────────────────────
router.get("/:id/summary", async (req, res) => {
  try {
    const { id } = req.params;
    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }

    const assignmentSnap = await db.collection("assignments").doc(id).get();
    if (!assignmentSnap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    if (assignmentSnap.data().teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const subsSnap = await db
      .collection("submissions")
      .where("assignment_id", "==", id)
      .get();

    const subs = subsSnap.docs.map((d) => d.data());

    const total_submissions = subs.length;
    const graded            = subs.filter((s) => s.status === "graded").length;
    const late              = subs.filter((s) => s.status === "late").length;
    const pending           = total_submissions - graded;
    const gradedSubs        = subs.filter((s) => s.marks_obtained !== null);
    const avg_marks         = gradedSubs.length
      ? parseFloat((gradedSubs.reduce((sum, s) => sum + s.marks_obtained, 0) / gradedSubs.length).toFixed(2))
      : null;

    return res.json({
      success: true,
      summary: {
        total_submissions,
        graded,
        pending,
        late,
        avg_marks,
        total_marks: assignmentSnap.data().marks,
      },
    });
  } catch (error) {
    console.error("SUMMARY ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch summary" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 POST /api/assignments/:id/unsubmit
// Student retracts their submission (sets status back to unsubmitted).
// Not allowed once graded.
//
// JSON body:
//   student_uid   string  (required)
// ─────────────────────────────────────────────────────────────────
router.post("/:id/unsubmit", async (req, res) => {
  try {
    const assignment_id = req.params.id;
    const { student_uid } = req.body;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    // Find submission
    const subSnap = await db
      .collection("submissions")
      .where("assignment_id", "==", assignment_id)
      .where("student_uid",   "==", student_uid)
      .limit(1)
      .get();

    if (subSnap.empty) {
      return res.status(404).json({ success: false, error: "No submission found to unsubmit" });
    }

    const subDoc  = subSnap.docs[0];
    const subData = subDoc.data();

    if (subData.status === "graded") {
      return res.status(403).json({
        success: false,
        error:   "Submission has already been graded and cannot be unsubmitted",
      });
    }

    // Delete the submission document and decrement counter atomically
    const assignmentRef = db.collection("assignments").doc(assignment_id);

    await db.runTransaction(async (t) => {
      t.delete(subDoc.ref);
      t.update(assignmentRef, {
        submissions_count: admin.firestore.FieldValue.increment(-1),
      });
    });

    return res.json({ success: true, message: "Submission retracted successfully" });
  } catch (error) {
    console.error("UNSUBMIT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to unsubmit" });
  }
});

module.exports = router;