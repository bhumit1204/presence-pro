const express = require("express");
const router  = express.Router();
const { admin, db } = require("../config/firebase");
const multer  = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const path    = require("path");
const { notify } = require("../services/notify");

// ─── R2 client (same pattern as assignment_routes.js) ────────────────────────
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

// ─── Multer: memory storage, 10 MB limit ────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ALLOWED = [
      "application/pdf",
      "image/jpeg", "image/png", "image/webp",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not allowed: ${file.mimetype}`), false);
  },
});

// ─── Upload to R2 under  od_proofs/<od_id>/<filename> ───────────────────────
async function uploadProofToR2(buffer, originalName, mimeType, odId) {
  const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._\-() ]/g, "_");
  const key      = `od_proofs/${odId}/${safeName}`;

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
    name: originalName,
    size: buffer.length,
    type: mimeType,
  };
}

function handleMulterError(err, res) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(400).json({ success: false, error: "File too large. Max 10 MB." });
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) return res.status(400).json({ success: false, error: err.message });
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// POST /api/od/request
// Student submits an OD leave request with proof document.
//
// Form-data fields:
//   student_uid  string   (required)
//   subject_id   string   (required)
//   teacher_id   string   (required)
//   course_id    string   (required)
//   student_name string   (required)
//   reason       string   (required)
//   from_date    string   YYYY-MM-DD (required)
//   to_date      string   YYYY-MM-DD (optional — same as from_date if omitted)
//   proof        file     (required — image or PDF)
// ═══════════════════════════════════════════════════════════════════
router.post(
  "/request",
  (req, res, next) => upload.single("proof")(req, res, (err) => {
    if (handleMulterError(err, res)) return;
    next();
  }),
  async (req, res) => {
    try {
      const {
        student_uid, subject_id, teacher_id, course_id,
        student_name, reason, from_date, to_date,
      } = req.body;

      if (!student_uid || !subject_id || !teacher_id || !course_id ||
          !student_name || !reason || !from_date) {
        return res.status(400).json({
          success: false,
          error: "student_uid, subject_id, teacher_id, course_id, student_name, reason, from_date are required",
        });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, error: "Proof document is required" });
      }

      const effectiveTo = to_date || from_date;
      if (effectiveTo < from_date) {
        return res.status(400).json({ success: false, error: "to_date cannot be before from_date" });
      }

      // Check for existing pending/approved request in same date range & subject
      const existing = await db.collection("od_requests")
        .where("student_uid", "==", student_uid)
        .where("subject_id",  "==", subject_id)
        .where("status",      "in", ["pending", "approved"])
        .get();

      for (const doc of existing.docs) {
        const d = doc.data();
        // Overlap check: new[from..to] overlaps existing[from..to]
        if (from_date <= d.to_date && effectiveTo >= d.from_date) {
          return res.status(409).json({
            success: false,
            error:   "An OD request already exists for overlapping dates in this subject",
          });
        }
      }

      // Generate OD id upfront so we can use it as the R2 subfolder
      const odRef = db.collection("od_requests").doc();
      const odId  = odRef.id;

      // Upload proof to R2
      const proof = await uploadProofToR2(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        odId,
      );

      const now = admin.firestore.FieldValue.serverTimestamp();

      await odRef.set({
        od_id:        odId,
        student_uid,
        student_name,
        subject_id,
        teacher_id,
        course_id,
        reason:       reason.trim(),
        from_date,
        to_date:      effectiveTo,
        proof,                        // { key, url, name, size, type }
        status:       "pending",      // pending | approved | rejected
        teacher_note: null,
        created_at:   now,
        updated_at:   now,
      });

      // ── Notify teacher ────────────────────────────────────────────
      notify({
        userIds: [teacher_id],
        title:   "📋 New OD Request",
        body:    `${student_name} submitted an OD request (${from_date}${effectiveTo !== from_date ? " → " + effectiveTo : ""})`,
        data: {
          screen: "ODRequestsTeacher",
          params: { subject_id, course_id },
        },
      });

      return res.status(201).json({ success: true, od_id: odId, message: "OD request submitted" });
    } catch (error) {
      console.error("OD REQUEST ERROR:", error);
      return res.status(500).json({ success: false, error: "Failed to submit OD request" });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// GET /api/od/student/:student_uid
// Returns all OD requests for a student, optionally filtered by subject.
//
// Query: subject_id (optional)
// ═══════════════════════════════════════════════════════════════════
router.get("/student/:student_uid", async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { subject_id }  = req.query;

    let q = db.collection("od_requests").where("student_uid", "==", student_uid);
    if (subject_id) q = q.where("subject_id", "==", subject_id);

    const snap = await q.get();
    const requests = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        created_at: d.created_at?.toDate?.()?.toISOString() || null,
        updated_at: d.updated_at?.toDate?.()?.toISOString() || null,
      };
    });

    requests.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    return res.json({ success: true, count: requests.length, requests });
  } catch (error) {
    console.error("GET OD (STUDENT):", error);
    return res.status(500).json({ success: false, error: "Failed to fetch OD requests" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/od/teacher/:teacher_id
// Returns all OD requests for a teacher's subjects.
//
// Resolves teacher identity from Firestore (teachers collection, keyed
// by user_id from auth token) the same way lecture_routes does, so the
// correct teacher_id (Firestore doc ID) is always used — not whatever
// string the client happens to pass.
//
// Query: subject_id (optional), status (optional: pending|approved|rejected)
// ═══════════════════════════════════════════════════════════════════
router.get("/teacher/:teacher_id", async (req, res) => {
  try {
    // ── Resolve teacher from Firestore (mirrors lecture_routes /today) ──
    // Prefer the authenticated uid; fall back to the URL param for
    // backwards-compatibility with unauthenticated dev calls.
    const uid = req.user?.uid || req.query.uid;

    let resolvedTeacherId = req.params.teacher_id; // fallback

    if (uid) {
      const teacherSnap = await db
        .collection("teachers")
        .where("teacher_id", "==", uid)
        .limit(1)
        .get();

      if (teacherSnap.empty) {
        return res.status(404).json({ success: false, error: "Teacher profile not found" });
      }

      const teacherDoc  = teacherSnap.docs[0];
      resolvedTeacherId = teacherDoc.id; // Firestore document ID — matches teacher_assigned field
    }

    const { subject_id, status } = req.query;

    let q = db.collection("od_requests").where("teacher_id", "==", resolvedTeacherId);
    if (subject_id) q = q.where("subject_id", "==", subject_id);
    if (status)     q = q.where("status", "==", status);

    const snap = await q.get();
    const requests = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        created_at: d.created_at?.toDate?.()?.toISOString() || null,
        updated_at: d.updated_at?.toDate?.()?.toISOString() || null,
      };
    });

    requests.sort((a, b) => {
      // Pending first, then by date desc
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (b.status === "pending" && a.status !== "pending") return 1;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

    const pending  = requests.filter((r) => r.status === "pending").length;
    const approved = requests.filter((r) => r.status === "approved").length;
    const rejected = requests.filter((r) => r.status === "rejected").length;

    return res.json({
      success:            true,
      count:              requests.length,
      resolved_teacher_id: resolvedTeacherId, // helpful for debugging
      summary:            { pending, approved, rejected },
      requests,
    });
  } catch (error) {
    console.error("GET OD (TEACHER):", error);
    return res.status(500).json({ success: false, error: "Failed to fetch OD requests" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PUT /api/od/:od_id/review
// Teacher approves or rejects an OD request.
// On approval, creates/upserts attendance_records with status "od"
// for each weekday in the date range.
//
// Body (JSON):
//   action       "approved" | "rejected"  (required)
//   teacher_note string                   (optional)
//   teacher_id   string  (optional fallback — resolved from auth token when possible)
// ═══════════════════════════════════════════════════════════════════
router.put("/:od_id/review", async (req, res) => {
  try {
    const { od_id } = req.params;
    const { action, teacher_note } = req.body;
    let { teacher_id } = req.body;

    if (!["approved", "rejected"].includes(action)) {
      return res.status(400).json({
        success: false,
        error:   "action (approved|rejected) is required",
      });
    }

    // ── Resolve teacher from Firestore (mirrors lecture_routes) ──────────
    const uid = req.user?.uid || req.query.uid;
    if (uid) {
      const teacherSnap = await db
        .collection("teachers")
        .where("user_id", "==", uid)
        .limit(1)
        .get();

      if (teacherSnap.empty) {
        return res.status(404).json({ success: false, error: "Teacher profile not found" });
      }

      teacher_id = teacherSnap.docs[0].id; // authoritative Firestore doc ID
    }

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id is required" });
    }

    const odRef = db.collection("od_requests").doc(od_id);
    const odDoc = await odRef.get();

    if (!odDoc.exists) {
      return res.status(404).json({ success: false, error: "OD request not found" });
    }

    const od = odDoc.data();

    if (od.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Not authorised to review this request" });
    }

    if (od.status !== "pending") {
      return res.status(400).json({ success: false, error: `OD request is already ${od.status}` });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    // ── Update OD request ────────────────────────────────────────────
    await odRef.update({
      status:       action,
      teacher_note: teacher_note?.trim() || null,
      updated_at:   now,
    });

    // ── If approved: upsert attendance_records with status "od" ──────
    if (action === "approved") {
      const batch = db.batch();
      const from  = new Date(od.from_date + "T06:30:00Z");
      const to    = new Date(od.to_date   + "T06:30:00Z");

      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        // Skip Sundays (0)
        if (d.getDay() === 0) continue;

        const ymd = d.toISOString().slice(0, 10);
        // Deterministic doc id so we can upsert without duplicates
        const recId = `${od.student_uid}_${od.subject_id}_${ymd}`;
        const recRef = db.collection("attendance_records").doc(recId);

        batch.set(recRef, {
          attendance_id: recId,
          student_uid:   od.student_uid,
          subject_id:    od.subject_id,
          teacher_id:    od.teacher_id,
          date:          ymd,
          status:        "od",
          method:        "od",
          marked_by:     "od_approval",
          source:        "od",
          od_id,
          note:          `OD approved — ${od.reason}`,
          created_at:    now,
          updated_at:    now,
        }, { merge: true });
      }

      await batch.commit();
    }

    // ── Notify student ───────────────────────────────────────────────
    const statusEmoji = action === "approved" ? "" : "❌";
    const statusLabel = action === "approved" ? "Approved" : "Rejected";

    notify({
      userIds: [od.student_uid],
      title:   `${statusEmoji} OD Request ${statusLabel}`,
      body:    action === "approved"
        ? `Your OD for ${od.from_date}${od.to_date !== od.from_date ? " → " + od.to_date : ""} has been approved. Attendance marked as OD.`
        : `Your OD request for ${od.from_date}${od.to_date !== od.from_date ? " → " + od.to_date : ""} was rejected.${teacher_note ? " Note: " + teacher_note : ""}`,
      data: {
        screen: "StudentAttendance",
        params: { subject_id: od.subject_id },
      },
    });

    return res.json({
      success: true,
      message: action === "approved"
        ? "OD approved and attendance marked as OD"
        : "OD request rejected",
    });
  } catch (error) {
    console.error("OD REVIEW ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to review OD request" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/od/:od_id
// Student cancels their own pending OD request.
//
// Body: { student_uid }
// ═══════════════════════════════════════════════════════════════════
router.delete("/:od_id", async (req, res) => {
  try {
    const { od_id }     = req.params;
    const { student_uid } = req.body;

    const odRef = db.collection("od_requests").doc(od_id);
    const odDoc = await odRef.get();

    if (!odDoc.exists) {
      return res.status(404).json({ success: false, error: "OD request not found" });
    }

    const od = odDoc.data();

    if (od.student_uid !== student_uid) {
      return res.status(403).json({ success: false, error: "Not authorised" });
    }

    if (od.status !== "pending") {
      return res.status(400).json({ success: false, error: "Only pending requests can be cancelled" });
    }

    await odRef.delete();

    return res.json({ success: true, message: "OD request cancelled" });
  } catch (error) {
    console.error("OD DELETE ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to cancel OD request" });
  }
});

module.exports = router;