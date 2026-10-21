const express  = require("express");
const router   = express.Router();
const { admin, db } = require("../config/firebase");
const multer   = require("multer");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const path     = require("path");
const { notify, getStudentUidsForSubject } = require("../services/notify");
const { guard, allow, fromBody, fromQuery, fromParams } = require("../middleware/auth");
const { TTLCache } = require("../utils/cache");
const { queueConcurrent, rateLimit, byUidOrIp } = require("../utils/limiter");
const { createCoalescer } = require("../utils/coalesce");
const { looksLikeItsType } = require("../utils/upload");
const { teacherOwnsSubject, studentEnrolled } = require("../utils/ownership");
const { assignmentStudentsHandler } = require("../utils/assignmentStudents");
const {
  getDocsByIds, queryInChunks, commitInBatches, isIndexMissing, isAlreadyExists, tsISO,
} = require("../utils/firestore");

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
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
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

// ─── Load protection ─────────────────────────────────────────────
// Every upload sits in RAM (up to 10 files x 10 MB). A whole class uploading in
// the same minute must not exhaust the server, so uploads wait in a short queue
// for one of N slots instead of all running at once.
const UPLOAD_SLOTS = Math.max(2, Number(process.env.UPLOAD_CONCURRENCY) || 12);
const uploadSlot   = queueConcurrent(UPLOAD_SLOTS, { maxWaitMs: 20_000, maxQueue: 600 });
// Generous: a campus shares one public IP (and soft-auth mode has no uid yet).
const uploadLimit  = rateLimit({ name: "asg-upload", windowMs: 60_000, max: 900, key: byUidOrIp,
                                 message: "Too many uploads, please wait a moment." });
const submitLimit  = rateLimit({ name: "asg-submit", windowMs: 60_000, max: 1500, key: byUidOrIp });

// ─── Small caches (per process, short TTL, invalidated on every write) ───────
const assignmentCache = new TTLCache({ max: 5000,  ttlMs: 10_000 });  // id -> doc data | null
const listCache       = new TTLCache({ max: 3000,  ttlMs: 5_000 });   // "a|subject|course" / "n|subject|course"
const studentCache    = new TTLCache({ max: 20000, ttlMs: 60_000 });  // uid -> {name, roll_no} | null
const summaryCache    = new TTLCache({ max: 1000,  ttlMs: 3_000 });   // assignment id -> summary

function getAssignment(id) {
  return assignmentCache.memo(id, 10_000, async () => {
    const s = await db.collection("assignments").doc(id).get();
    return s.exists ? s.data() : null;
  });
}
function dropAssignment(id) {
  assignmentCache.del(id);
  summaryCache.del(id);
}
function dropLists(subject_id, course_id) {
  listCache.del(`a|${subject_id}|${course_id}`);
  listCache.del(`n|${subject_id}|${course_id}`);
}

// submissions_count is incremented by every student submitting. Hundreds of
// students submitting within a minute would otherwise fight over ONE document
// (Firestore sustains ~1 write/s per document), so the changes are summed up
// and written once per short window.
const counter = createCoalescer(async (assignment_id, deltas) => {
  const sum = deltas.reduce((s, x) => s + x.d, 0);
  if (!sum) return;
  try {
    await db.collection("assignments").doc(assignment_id)
      .update({ submissions_count: admin.firestore.FieldValue.increment(sum) });
  } catch (e) {
    if (e && (e.code === 5 || /NOT_FOUND/.test(e.message || ""))) return; // assignment deleted meanwhile
    throw e;
  }
  assignmentCache.del(assignment_id);
}, { windowMs: 400, maxItems: 5000, retries: 2 });
const bumpCounter = (assignment_id, d) =>
  counter.add(assignment_id, { d }).catch((e) => console.error("submissions_count update failed:", assignment_id, e.message));

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

// Delete in the background, a few at a time. Only keys inside the folders this
// module writes to are ever deleted (a forged key can no longer remove e.g. OD proofs).
const R2_FOLDERS = ["assignments/", "announcements/", "submissions/"];
function cleanupKeys(keys) {
  const list = [...new Set((keys || []).filter((k) => typeof k === "string" && !k.includes("..") && R2_FOLDERS.some((f) => k.startsWith(f))))];
  if (!list.length) return;
  (async () => {
    for (let i = 0; i < list.length; i += 5) {
      await Promise.all(list.slice(i, i + 5).map(deleteFromR2));
    }
  })().catch(() => {});
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
const BAD_SCHEME = /^\s*(javascript|data|vbscript|file):/i;
function parseLinks(raw) {
  // raw can be a JSON string or an array sent via form-data
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr
      .slice(0, 20)
      .filter((l) => l && typeof l.url === "string" && l.url.trim() && !BAD_SCHEME.test(l.url) && l.url.length <= 2000)
      .map((l) => ({
        url:   l.url.trim(),
        label: (typeof l.label === "string" && l.label.trim().slice(0, 300)) || l.url.trim(),
      }));
  } catch {
    return [];
  }
}

// Attachments are pre-uploaded file objects { url, key, name, size, type }.
// Keep what the client sent, but bound the count/size so a request cannot store junk.
function cleanAttachments(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const a of arr.slice(0, 25)) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    let size = 0;
    try { size = JSON.stringify(a).length; } catch { continue; }
    if (size > 4000) continue;
    if (typeof a.url === "string" && BAD_SCHEME.test(a.url)) continue;
    out.push(a);
  }
  return out;
}
// like the original: JSON string or array. Returns null when a string is not valid JSON.
function parseAttachmentsLoose(raw) {
  if (typeof raw === "string") {
    try { return cleanAttachments(JSON.parse(raw)); } catch { return null; }
  }
  return cleanAttachments(raw);
}

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 200 && !v.includes("/");
const sortByTimeDesc = (docs, field) =>
  docs.sort((a, b) => {
    const ta = a.data()[field]?.toMillis?.() ?? 0;
    const tb = b.data()[field]?.toMillis?.() ?? 0;
    return tb - ta;
  });

function publicDate(v) {
  return v?.toDate?.()?.toISOString() || null;
}

function wantedLimit(limit) {
  const n = Number(limit);
  // original: slice(0, NaN) -> empty list, negative -> from the end. Keep NaN -> [] but cap huge values.
  return Number.isNaN(n) ? 0 : Math.min(n, 500);
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
  uploadLimit,
  uploadSlot,
  (req, res, next) => upload.array("files", 10)(req, res, (err) => {
    if (handleMulterError(err, res)) return;
    next();
  }),
  async (req, res) => {
    let uploaded = [];
    try {
      const { folder } = req.body;
      let { entity_id } = req.body;
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

      for (const f of req.files) {
        if (!looksLikeItsType(f.buffer, f.mimetype)) {
          return res.status(400).json({ success: false, error: `"${f.originalname}" does not match its file type` });
        }
      }

      // entity ids are Firestore ids; anything else must not be able to climb out of the folder
      entity_id = typeof entity_id === "string" && entity_id
        ? entity_id.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 128)
        : null;

      // entity_id creates a dedicated subfolder: assignments/assign_abc123/filename.pdf
      // This keeps all files for one entity together and prevents name collisions.
      const results = await Promise.allSettled(
        req.files.map((f) => uploadToR2(f.buffer, f.originalname, f.mimetype, folder, entity_id))
      );
      uploaded = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const failed = results.find((r) => r.status === "rejected");
      if (failed) {
        // do not leave half of a batch behind in the bucket
        cleanupKeys(uploaded.map((u) => u.key));
        throw failed.reason;
      }

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
router.post("/announcements", guard.teacher(fromBody("teacher_id")), async (req, res) => {
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
    if (typeof title !== "string" || typeof text !== "string"
        || typeof subject_id !== "string" || typeof course_id !== "string") {
      return res.status(400).json({ success: false, error: "title, text, subject_id and course_id must be text" });
    }
    if (title.length > 300 || text.length > 20000) {
      return res.status(400).json({ success: false, error: "Title or text is too long" });
    }

    if (!allow(req, res, await teacherOwnsSubject(teacher_id, subject_id), "announce-subject")) return;

    // Parse attachments — either pre-uploaded objects or empty
    const parsedAttachments = parseAttachmentsLoose(attachments) || [];
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
    dropLists(subject_id, course_id);

    res.status(201).json({
      success:         true,
      announcement_id: ref.id,
      message:         "Announcement created",
    });

    // Push notification is done after the response: the teacher does not wait for it.
    try {
      const ids = await getStudentUidsForSubject(subject_id);
      notify({
        userIds: ids,
        title: "📢 New Announcement",
        body: title.trim(),
        data: { screen: "StudentWork", params: { subject_id, course_id } },
      });
    } catch (e) {
      console.error("ANNOUNCEMENT NOTIFY ERROR:", e.message);
    }
  } catch (error) {
    console.error("CREATE ANNOUNCEMENT ERROR:", error);
    if (!res.headersSent) return res.status(500).json({ success: false, error: "Failed to create announcement" });
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
    if (typeof subject_id !== "string" || typeof course_id !== "string") {
      return res.status(400).json({ success: false, error: "subject_id and course_id are required" });
    }

    // One Firestore read per subject per few seconds, however many students open the screen.
    const all = await listCache.memo(`n|${subject_id}|${course_id}`, 5_000, async () => {
      const snap = await db
        .collection("announcements")
        .where("subject_id", "==", subject_id)
        .where("course_id",  "==", course_id)
        .get();

      const items = snap.docs.map((doc) => {
        const d = doc.data();
        return {
          ...d,
          created_at: tsISO(d.created_at),
          updated_at: tsISO(d.updated_at),
        };
      });

      // Sort in memory: pinned first, then by date desc — avoids composite index
      items.sort((a, b) => {
        if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      });
      return items;
    });

    const announcements = all.slice(0, wantedLimit(limit));

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
router.put("/announcements/:id", guard.teacher(fromBody("teacher_id")), async (req, res) => {
  try {
    const { id } = req.params;
    const { teacher_id, title, text, is_pinned, attachments, links, deleted_keys } = req.body;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }
    if (!isId(id)) return res.status(404).json({ success: false, error: "Announcement not found" });

    const ref = db.collection("announcements").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Announcement not found" });
    }

    const existing = snap.data();
    if (existing.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const updates = { updated_at: admin.firestore.FieldValue.serverTimestamp() };
    if (title !== undefined) {
      if (typeof title !== "string" || title.length > 300) return res.status(400).json({ success: false, error: "Invalid title" });
      updates.title = title.trim();
    }
    if (text !== undefined) {
      if (typeof text !== "string" || text.length > 20000) return res.status(400).json({ success: false, error: "Invalid text" });
      updates.text = text.trim();
    }
    if (is_pinned   !== undefined) updates.is_pinned   = Boolean(is_pinned);
    if (attachments !== undefined) {
      const parsed = parseAttachmentsLoose(attachments);
      if (parsed === null) return res.status(400).json({ success: false, error: "attachments must be valid JSON" });
      updates.attachments = parsed;
    }
    if (links !== undefined) updates.links = parseLinks(links);

    await ref.update(updates);
    dropLists(existing.subject_id, existing.course_id);

    // Clean up deleted R2 files (best-effort, non-blocking) — only files that belonged to this announcement
    if (Array.isArray(deleted_keys) && deleted_keys.length > 0) {
      const own = new Set((existing.attachments || []).map((a) => a && a.key).filter(Boolean));
      cleanupKeys(deleted_keys.filter((k) => own.has(k)));
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
router.delete("/announcements/:id", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { id } = req.params;
    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }
    if (!isId(id)) return res.status(404).json({ success: false, error: "Announcement not found" });

    const ref  = db.collection("announcements").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Announcement not found" });
    }

    const data = snap.data();
    if (data.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const keys = (data.attachments || []).map((a) => a && a.key).filter(Boolean);

    await ref.delete();
    dropLists(data.subject_id, data.course_id);

    // Clean up R2 files (best-effort)
    cleanupKeys(keys);

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
router.post("/", guard.teacher(fromBody("teacher_id")), async (req, res) => {
  try {
    const {
      teacher_id, course_id, subject_id,
      title, instructions, questions,
      marks, due_date, allow_late = false,
      attachments, links,
    } = req.body;
    const kind = req.body.kind === undefined || req.body.kind === null || req.body.kind === "" ? "assignment" : req.body.kind;
    if (kind !== "assignment" && kind !== "lab_work") {
      return res.status(400).json({ success: false, error: "kind must be assignment or lab_work" });
    }

    if (!teacher_id || !course_id || !subject_id || !title || !marks || !due_date) {
      return res.status(400).json({
        success: false,
        error: "teacher_id, course_id, subject_id, title, marks and due_date are required",
      });
    }
    if (typeof title !== "string" || typeof subject_id !== "string" || typeof course_id !== "string"
        || (instructions != null && typeof instructions !== "string")
        || (questions != null && typeof questions !== "string")) {
      return res.status(400).json({ success: false, error: "title, instructions, questions, subject_id and course_id must be text" });
    }
    if (title.length > 300 || (instructions || "").length > 20000 || (questions || "").length > 50000) {
      return res.status(400).json({ success: false, error: "Title, instructions or questions are too long" });
    }

    const marksNum = Number(marks);
    if (isNaN(marksNum) || marksNum < 1) {
      return res.status(400).json({ success: false, error: "marks must be a positive number" });
    }

    const dueDateObj = new Date(due_date);
    if (isNaN(dueDateObj.getTime())) {
      return res.status(400).json({ success: false, error: "due_date must be a valid ISO date string" });
    }

    if (!allow(req, res, await teacherOwnsSubject(teacher_id, subject_id), "assignment-subject")) return;
    if (kind === "lab_work") {
      // lab work lives in a lab's classroom: a lab subject, or a subject that has a lab
      const sd = await db.collection("subjects").doc(subject_id).get();
      const sj = sd.exists ? sd.data() : {};
      if (sj.kind !== "lab" && sj.has_lab !== true) {
        return res.status(400).json({ success: false, error: "This subject has no lab, so it can't have lab work" });
      }
    }

    const parsedAttachments = parseAttachmentsLoose(attachments) || [];
    const parsedLinks = parseLinks(links);

    const ref = db.collection("assignments").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();

    await ref.set({
      assignment_id:    ref.id,
      teacher_id,
      course_id,
      subject_id,
      kind,
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
    dropLists(subject_id, course_id);

    res.status(201).json({
      success:       true,
      assignment_id: ref.id,
      message:       "Assignment created",
    });

    try {
      const ids = await getStudentUidsForSubject(subject_id);
      notify({
        userIds: ids,
        title: kind === "lab_work" ? "🧪 New Lab Work" : "📝 New Assignment",
        body: `${title.trim()} — Due ${new Date(due_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}`,
        data: { screen: "StudentWork", params: { subject_id, course_id } },
      });
    } catch (e) {
      console.error("ASSIGNMENT NOTIFY ERROR:", e.message);
    }
  } catch (error) {
    console.error("CREATE ASSIGNMENT ERROR:", error);
    if (!res.headersSent) return res.status(500).json({ success: false, error: "Failed to create assignment" });
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
    if (typeof subject_id !== "string" || typeof course_id !== "string") {
      return res.status(400).json({ success: false, error: "subject_id and course_id are required" });
    }

    const all = await listCache.memo(`a|${subject_id}|${course_id}`, 5_000, async () => {
      const snap = await db
        .collection("assignments")
        .where("subject_id", "==", subject_id)
        .where("course_id",  "==", course_id)
        .get();

      const items = snap.docs.map((doc) => {
        const d = doc.data();
        return {
          ...d,
          due_date:   tsISO(d.due_date),
          created_at: tsISO(d.created_at),
          updated_at: tsISO(d.updated_at),
        };
      });

      // Sort by due_date desc in memory — avoids composite index
      items.sort((a, b) =>
        new Date(b.due_date || 0).getTime() - new Date(a.due_date || 0).getTime()
      );
      return items;
    });

    const assignments = all.slice(0, wantedLimit(limit));

    return res.json({ success: true, count: assignments.length, assignments });
  } catch (error) {
    console.error("GET ASSIGNMENTS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch assignments" });
  }
});

// Shared by GET /my-submissions and GET /student/:student_uid (identical in the original).
async function studentSubmissions(student_uid, subject_id) {
  let subDocs;
  try {
    const snap = await db
      .collection("submissions")
      .where("student_uid", "==", student_uid)
      .orderBy("submitted_at", "desc")
      .get();
    subDocs = snap.docs;
  } catch (e) {
    if (!isIndexMissing(e)) throw e;
    console.warn("[assignments] composite index submissions(student_uid, submitted_at) missing - sorting in memory");
    const snap = await db.collection("submissions").where("student_uid", "==", student_uid).get();
    subDocs = sortByTimeDesc(snap.docs, "submitted_at");
  }

  // one batched read instead of one read per assignment, and only the fields we show
  const assignmentIds = [...new Set(subDocs.map((d) => d.data().assignment_id))];
  const fetched = await getDocsByIds("assignments", assignmentIds, ["title", "marks", "due_date", "subject_id", "course_id"]);
  const assignmentMap = {};
  for (const [aid, snap] of fetched) {
    const a = snap.data();
    assignmentMap[aid] = {
      title:      a.title,
      marks:      a.marks,
      due_date:   tsISO(a.due_date),
      subject_id: a.subject_id,
      course_id:  a.course_id,
    };
  }

  let submissions = subDocs.map((doc) => {
    const d = doc.data();
    return {
      ...d,
      submitted_at:       tsISO(d.submitted_at),
      graded_at:          tsISO(d.graded_at),
      assignment_details: assignmentMap[d.assignment_id] || null,
    };
  });

  if (subject_id) {
    submissions = submissions.filter(
      (s) => s.assignment_details?.subject_id === subject_id
    );
  }
  return submissions;
}

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
router.get("/my-submissions", guard.student(fromQuery("student_uid")), async (req, res) => {
  try {
    const { student_uid, subject_id } = req.query;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }
    if (typeof student_uid !== "string") {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    const submissions = await studentSubmissions(student_uid, subject_id);
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
router.get("/student/:student_uid", guard.selfOrTeacher(fromParams("student_uid")), async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { subject_id }  = req.query;

    const submissions = await studentSubmissions(student_uid, subject_id);
    return res.json({ success: true, count: submissions.length, submissions });
  } catch (error) {
    console.error("STUDENT SUBMISSIONS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch student submissions" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments/:id/students?teacher_id=
// Enrolled students of an assignment's subject (used by the web register to
// show "not submitted" rows). The original code had this handler in the web
// teacher router by mistake; it is available at both URLs now.
// ─────────────────────────────────────────────────────────────────
router.get("/:id/students", guard.teacher(fromQuery("teacher_id")), assignmentStudentsHandler);

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments/:id
// Fetch a single assignment by ID.
// IMPORTANT: Registered here (after all static-prefix GET routes)
// so it does not shadow /my-submissions, /student/:uid, etc.
// ─────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const d = isId(id) ? await getAssignment(id) : null;

    if (!d) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    return res.json({
      success: true,
      assignment: {
        ...d,
        due_date:   tsISO(d.due_date),
        created_at: tsISO(d.created_at),
        updated_at: tsISO(d.updated_at),
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
router.put("/:id", guard.teacher(fromBody("teacher_id")), async (req, res) => {
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
    if (!isId(id)) return res.status(404).json({ success: false, error: "Assignment not found" });

    const ref  = db.collection("assignments").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    const existing = snap.data();
    if (existing.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const updates = { updated_at: admin.firestore.FieldValue.serverTimestamp() };
    if (req.body.kind !== undefined) {
      if (req.body.kind !== "assignment" && req.body.kind !== "lab_work") {
        return res.status(400).json({ success: false, error: "kind must be assignment or lab_work" });
      }
      if (req.body.kind === "lab_work" && (existing.kind || "assignment") !== "lab_work") {
        const sd = await db.collection("subjects").doc(existing.subject_id).get();
        const sj = sd.exists ? sd.data() : {};
        if (sj.kind !== "lab" && sj.has_lab !== true) return res.status(400).json({ success: false, error: "This subject has no lab, so it can't have lab work" });
      }
      updates.kind = req.body.kind;
    }

    const textOk = (v, max) => v === null || (typeof v === "string" && v.length <= max);
    if (title !== undefined) {
      if (typeof title !== "string" || title.length > 300) return res.status(400).json({ success: false, error: "Invalid title" });
      updates.title = title.trim();
    }
    if (instructions !== undefined) {
      if (!textOk(instructions, 20000)) return res.status(400).json({ success: false, error: "Invalid instructions" });
      updates.instructions = instructions?.trim() || null;
    }
    if (questions !== undefined) {
      if (!textOk(questions, 50000)) return res.status(400).json({ success: false, error: "Invalid questions" });
      updates.questions = questions?.trim() || null;
    }
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
      const parsed = parseAttachmentsLoose(attachments);
      if (parsed === null) return res.status(400).json({ success: false, error: "attachments must be valid JSON" });
      updates.attachments = parsed;
    }
    if (links !== undefined) updates.links = parseLinks(links);

    await ref.update(updates);
    dropAssignment(id);
    dropLists(existing.subject_id, existing.course_id);

    if (Array.isArray(deleted_keys) && deleted_keys.length > 0) {
      const own = new Set((existing.attachments || []).map((a) => a && a.key).filter(Boolean));
      cleanupKeys(deleted_keys.filter((k) => own.has(k)));
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
router.delete("/:id", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { id } = req.params;
    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }
    if (!isId(id)) return res.status(404).json({ success: false, error: "Assignment not found" });

    const ref  = db.collection("assignments").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    const data = snap.data();
    if (data.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    // Collect all R2 keys — assignment attachments + all submission attachments
    const r2Keys = (data.attachments || []).map((a) => a && a.key).filter(Boolean);

    const subsSnap = await db
      .collection("submissions")
      .where("assignment_id", "==", id)
      .select("attachments")
      .get();

    subsSnap.docs.forEach((doc) => {
      (doc.data().attachments || []).forEach((a) => {
        if (a && a.key) r2Keys.push(a.key);
      });
    });

    // Submissions first, the assignment last: if something fails halfway a retry can finish the job.
    // (The original single batch broke for more than 500 submissions.)
    const ops = subsSnap.docs.map((doc) => (batch) => batch.delete(doc.ref));
    ops.push((batch) => batch.delete(ref));
    await commitInBatches(ops);
    dropAssignment(id);
    dropLists(data.subject_id, data.course_id);

    // R2 cleanup (best-effort)
    cleanupKeys(r2Keys);

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

// One submission per (assignment, student): the id is derived from both, so two
// taps / two devices at the same moment cannot create two documents.
// (Older submissions have random ids; they are found through the query below.)
const submissionId = (assignment_id, student_uid) => `${assignment_id}__${student_uid}`;

async function findSubmission(assignment_id, student_uid) {
  const snap = await db
    .collection("submissions")
    .where("assignment_id", "==", assignment_id)
    .where("student_uid",   "==", student_uid)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

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
router.post("/:id/submit", submitLimit, guard.student(fromBody("student_uid")), async (req, res) => {
  try {
    const assignment_id = req.params.id;
    const { student_uid, attachments, links } = req.body;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }
    if (!isId(student_uid)) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    // ── 1. Fetch assignment ──────────────────────────────────────
    const assignment = isId(assignment_id) ? await getAssignment(assignment_id) : null;

    if (!assignment) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    // ── 2. Duplicate check ───────────────────────────────────────
    const dup = await findSubmission(assignment_id, student_uid);
    if (dup) {
      return res.status(409).json({
        success:       false,
        error:         "You have already submitted this assignment. Use the resubmit endpoint to update.",
        submission_id: dup.id,
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
    const uploadedFiles = cleanAttachments(attachments);
    const parsedLinks   = parseLinks(links);

    if (uploadedFiles.length === 0 && parsedLinks.length === 0) {
      return res.status(400).json({
        success: false,
        error:   "Submission must include at least one file or link",
      });
    }

    if (!allow(req, res, await studentEnrolled(student_uid, assignment.subject_id), "submit-enrolled")) return;

    // ── 5. Write submission (create() fails if it already exists) ─
    const subRef = db.collection("submissions").doc(submissionId(assignment_id, student_uid));

    try {
      await subRef.create({
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
    } catch (e) {
      if (isAlreadyExists(e)) {
        return res.status(409).json({
          success:       false,
          error:         "You have already submitted this assignment. Use the resubmit endpoint to update.",
          submission_id: subRef.id,
        });
      }
      throw e;
    }

    bumpCounter(assignment_id, 1);   // written in the background, summed with other students' submissions

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
router.put("/:id/resubmit", submitLimit, guard.student(fromBody("student_uid")), async (req, res) => {
  try {
    const assignment_id = req.params.id;
    const { student_uid, attachments, links, deleted_keys } = req.body;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }
    if (!isId(student_uid)) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    // ── 1. Find existing submission ──────────────────────────────
    const subDoc = await findSubmission(assignment_id, student_uid);

    if (!subDoc) {
      return res.status(404).json({
        success: false,
        error:   "No existing submission found. Use the submit endpoint first.",
      });
    }

    // Block resubmission once graded
    if (subDoc.data().status === "graded") {
      return res.status(403).json({
        success: false,
        error:   "Submission has already been graded and cannot be changed",
      });
    }

    // ── 2. Fetch assignment for late check ───────────────────────
    const assignment = await getAssignment(assignment_id);
    if (!assignment) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

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
    const newFiles    = cleanAttachments(attachments);
    const parsedLinks = parseLinks(links);
    const requestedDeletes = Array.isArray(deleted_keys) ? deleted_keys : [];

    // The graded-check and the write happen in one transaction, so a teacher
    // grading at the same moment can never be overwritten by a resubmit.
    const outcome = await db.runTransaction(async (t) => {
      const fresh = await t.get(subDoc.ref);
      if (!fresh.exists) return { code: "gone" };
      const cur = fresh.data();
      if (cur.status === "graded") return { code: "graded" };

      // only files that belong to this submission can be removed
      const ownKeys = new Set((cur.attachments || []).map((a) => a && a.key).filter(Boolean));
      const keysToDelete = requestedDeletes.filter((k) => ownKeys.has(k));

      const existingFiles = (cur.attachments || []).filter((a) => !keysToDelete.includes(a && a.key));
      const mergedFiles = [...existingFiles, ...newFiles];

      if (mergedFiles.length === 0 && parsedLinks.length === 0) return { code: "empty" };

      t.update(subDoc.ref, {
        attachments:    mergedFiles,
        links:          parsedLinks,
        status:         isLate ? "late" : "submitted",
        submitted_at:   admin.firestore.FieldValue.serverTimestamp(),
        graded_at:      null,
        marks_obtained: null,
        feedback:       null,
      });
      return { code: "ok", keysToDelete };
    });

    if (outcome.code === "gone") {
      return res.status(404).json({
        success: false,
        error:   "No existing submission found. Use the submit endpoint first.",
      });
    }
    if (outcome.code === "graded") {
      return res.status(403).json({
        success: false,
        error:   "Submission has already been graded and cannot be changed",
      });
    }
    if (outcome.code === "empty") {
      return res.status(400).json({
        success: false,
        error:   "Resubmission must include at least one file or link",
      });
    }

    // Delete old R2 files (best-effort)
    cleanupKeys(outcome.keysToDelete);

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
router.get("/:id/submissions", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const assignment_id = req.params.id;
    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }

    // Ownership check
    const assignment = isId(assignment_id) ? await getAssignment(assignment_id) : null;
    if (!assignment) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    if (assignment.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    let subDocs;
    try {
      const snap = await db
        .collection("submissions")
        .where("assignment_id", "==", assignment_id)
        .orderBy("submitted_at", "desc")
        .get();
      subDocs = snap.docs;
    } catch (e) {
      if (!isIndexMissing(e)) throw e;
      console.warn("[assignments] composite index submissions(assignment_id, submitted_at) missing - sorting in memory");
      const snap = await db.collection("submissions").where("assignment_id", "==", assignment_id).get();
      subDocs = sortByTimeDesc(snap.docs, "submitted_at");
    }

    // Student names: a few `in` queries in parallel (not one query per student),
    // remembered for a minute because the same class is looked up again and again.
    const studentUids = [...new Set(subDocs.map((d) => d.data().student_uid))];
    const studentMap  = {};
    const missing = [];
    for (const uid of studentUids) {
      const hit = studentCache.has(uid) ? studentCache.get(uid) : undefined;
      if (hit !== undefined) { if (hit) studentMap[uid] = hit; }
      else missing.push(uid);
    }
    if (missing.length) {
      const docs = await queryInChunks(missing, (c) =>
        db.collection("students").where("uid", "in", c).select("uid", "name", "first_name", "last_name", "roll_no")
      );
      for (const doc of docs) {
        const s = doc.data();
        if (studentMap[s.uid]) continue; // first match wins (as `limit(1)` did)
        studentMap[s.uid] = {
          name:    s.name    || `${s.first_name} ${s.last_name}`,
          roll_no: s.roll_no || null,
        };
      }
      for (const uid of missing) studentCache.set(uid, studentMap[uid] || null, 60_000);
    }

    const submissions = subDocs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        student_name:  studentMap[d.student_uid]?.name    || null,
        student_roll:  studentMap[d.student_uid]?.roll_no || null,
        submitted_at:  tsISO(d.submitted_at),
        graded_at:     tsISO(d.graded_at),
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
router.get("/:id/my-submission", guard.student(fromQuery("student_uid")), async (req, res) => {
  try {
    const assignment_id = req.params.id;
    const { student_uid } = req.query;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }
    if (typeof student_uid !== "string") {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    const doc = await findSubmission(assignment_id, student_uid);

    if (!doc) {
      return res.json({ success: true, submission: null });
    }

    const d = doc.data();
    return res.json({
      success: true,
      submission: {
        ...d,
        submitted_at: tsISO(d.submitted_at),
        graded_at:    tsISO(d.graded_at),
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

// POST and PUT /grade/:submission_id were two copies of the same logic; they only
// differ in two error texts and in the reply / push notification.
async function gradeSubmission(req, res, { isUpdate }) {
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
  if (feedback != null && (typeof feedback !== "string" || feedback.length > 5000)) {
    return res.status(400).json({ success: false, error: "feedback must be text (max 5000 characters)" });
  }
  if (!isId(submission_id)) {
    return res.status(404).json({ success: false, error: "Submission not found" });
  }

  // ── 1. Fetch submission ──────────────────────────────────────
  const subRef  = db.collection("submissions").doc(submission_id);
  const subSnap = await subRef.get();

  if (!subSnap.exists) {
    return res.status(404).json({ success: false, error: "Submission not found" });
  }

  const sub = subSnap.data();

  // ── 2. Fetch assignment for ownership + max marks check ──────
  const assignment = await getAssignment(sub.assignment_id);

  if (!assignment) {
    return res.status(404).json({ success: false, error: "Assignment not found" });
  }

  if (assignment.teacher_id !== teacher_id) {
    return res.status(403).json({ success: false, error: "Access denied" });
  }

  if (marksNum > assignment.marks) {
    return res.status(400).json({
      success: false,
      error:   isUpdate
        ? `marks_obtained cannot exceed assignment total marks (${assignment.marks})`
        : `marks_obtained (${marksNum}) cannot exceed assignment total marks (${assignment.marks})`,
    });
  }

  // ── 3. Write grade ───────────────────────────────────────────
  const isReturned = returned === true || returned === "true";
  await subRef.update({
    marks_obtained: marksNum,
    feedback:       feedback?.trim() || null,
    returned:       isReturned,
    status:         "graded",
    graded_at:      admin.firestore.FieldValue.serverTimestamp(),
  });
  summaryCache.del(sub.assignment_id);

  if (isUpdate) {
    return res.json({ success: true, submission_id, marks_obtained: marksNum, message: "Grade updated" });
  }

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
    returned:       isReturned,
    message:        "Submission graded",
  });
}

router.post("/grade/:submission_id", guard.teacher(fromBody("teacher_id")), async (req, res) => {
  try {
    return await gradeSubmission(req, res, { isUpdate: false });
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
router.put("/grade/:submission_id", guard.teacher(fromBody("teacher_id")), async (req, res) => {
  try {
    return await gradeSubmission(req, res, { isUpdate: true });
  } catch (error) {
    console.error("UPDATE GRADE ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to update grade" });
  }
});

// ─────────────────────────────────────────────────────────────────
// 📌 GET /api/assignments/:id/summary
// Teacher gets a grading summary for an assignment.
// ─────────────────────────────────────────────────────────────────
router.get("/:id/summary", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { id } = req.params;
    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }

    const assignment = isId(id) ? await getAssignment(id) : null;
    if (!assignment) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    if (assignment.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const summary = await summaryCache.memo(id, 3_000, async () => {
      // only the two fields the numbers need
      const subsSnap = await db
        .collection("submissions")
        .where("assignment_id", "==", id)
        .select("status", "marks_obtained")
        .get();

      const subs = subsSnap.docs.map((d) => d.data());

      const total_submissions = subs.length;
      const graded            = subs.filter((s) => s.status === "graded").length;
      const late              = subs.filter((s) => s.status === "late").length;
      const pending           = total_submissions - graded;
      const gradedSubs        = subs.filter((s) => s.marks_obtained !== null && s.marks_obtained !== undefined);
      const avg_marks         = gradedSubs.length
        ? parseFloat((gradedSubs.reduce((sum, s) => sum + s.marks_obtained, 0) / gradedSubs.length).toFixed(2))
        : null;
      return { total_submissions, graded, pending, late, avg_marks };
    });

    return res.json({
      success: true,
      summary: { ...summary, total_marks: assignment.marks },
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
router.post("/:id/unsubmit", submitLimit, guard.student(fromBody("student_uid")), async (req, res) => {
  try {
    const assignment_id = req.params.id;
    const { student_uid } = req.body;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }
    if (!isId(student_uid)) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    // Find submission
    const subDoc = await findSubmission(assignment_id, student_uid);

    if (!subDoc) {
      return res.status(404).json({ success: false, error: "No submission found to unsubmit" });
    }

    // status check + delete in one transaction (a grade written meanwhile wins)
    const outcome = await db.runTransaction(async (t) => {
      const fresh = await t.get(subDoc.ref);
      if (!fresh.exists) return "gone";
      if (fresh.data().status === "graded") return "graded";
      t.delete(subDoc.ref);
      return "ok";
    });

    if (outcome === "graded") {
      return res.status(403).json({
        success: false,
        error:   "Submission has already been graded and cannot be unsubmitted",
      });
    }
    if (outcome === "gone") {
      return res.status(404).json({ success: false, error: "No submission found to unsubmit" });
    }

    bumpCounter(assignment_id, -1);

    return res.json({ success: true, message: "Submission retracted successfully" });
  } catch (error) {
    console.error("UNSUBMIT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to unsubmit" });
  }
});

// Let the process flush pending counter updates when it is asked to stop.
router.flushPending = () => counter.flushAll();

module.exports = router;