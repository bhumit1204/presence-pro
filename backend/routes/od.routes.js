const express = require("express");
const router  = express.Router();
const { admin, db } = require("../config/firebase");
const multer  = require("multer");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const path    = require("path");
const { notify } = require("../services/notify");
const { guard, allow, teacherIdForUid, fromBody, fromParams } = require("../middleware/auth");
const { TTLCache } = require("../utils/cache");
const { limitConcurrent } = require("../utils/limiter");
const { looksLikeItsType } = require("../utils/upload");
const { commitInBatches } = require("../utils/firestore");
const { todayIST, datesInRange, getLectureSessionsForSubject, lectureDateSet } = require("../utils/lectureDays");

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

// At most 10 uploads buffered in RAM at the same time per process (10 x 10 MB).
const uploadSlot = limitConcurrent(10);

// ─── small caches ────────────────────────────────────────────────────────────
const subjectCache  = new TTLCache({ max: 5000, ttlMs: 30_000 });
const enrolledCache = new TTLCache({ max: 20000, ttlMs: 30_000 });
const teacherListCache = new TTLCache({ max: 2000, ttlMs: 5_000 }); // "<teacher>|<subject>|<status>"

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OD_DAYS = 366;

const getSubject = (id) =>
  subjectCache.memo(id, 30_000, async () => {
    const d = await db.collection("subjects").doc(id).get();
    return d.exists ? d.data() : null;
  });

async function isEnrolled(uid, subject_id) {
  const list = await enrolledCache.memo(uid, 30_000, async () => {
    let d = await db.collection("students").doc(uid).get();
    if (!d.exists) {
      const q = await db.collection("students").where("uid", "==", uid).limit(1).get();
      if (q.empty) return null;
      d = q.docs[0];
    }
    return d.data().enrolled_subjects || [];
  });
  return !!list && list.includes(subject_id);
}

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

async function deleteFromR2(key) {
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (e) {
    console.error("R2 delete failed for key:", key, e.message);
  }
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

// Attendance docs written when an OD is approved (one per non-Sunday day in range).
// Only days on which a lecture was held are marked now; days still to come are stored too and start
// counting the moment a lecture is held that day (reports ignore OD rows on days without a lecture).
// Past days with no lecture are skipped: there was nothing to be excused from, and counting them is what
// pushed attendance past 100%.
function buildOdAttendance(od, od_id, now, lectureDays) {
  const records = [];
  const today = todayIST();
  let marked = 0, upcoming = 0, skipped = 0;

  for (const ymd of datesInRange(od.from_date, od.to_date)) {
    if (lectureDays.has(ymd)) marked++;
    else if (ymd > today) upcoming++;
    else { skipped++; continue; }

    // Deterministic doc id so we can upsert without duplicates
    const recId = `${od.student_uid}_${od.subject_id}_${ymd}`;
    records.push({
      ref: db.collection("attendance_records").doc(recId),
      data: {
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
        note:          `OD approved - ${od.reason}`,
        created_at:    now,
        updated_at:    now,
      },
    });
  }
  return { records, marked, upcoming, skipped };
}

function odApprovalMessage({ marked, upcoming, skipped }) {
  const parts = [];
  if (marked) parts.push(`marked as OD on ${marked} lecture day${marked === 1 ? "" : "s"}`);
  if (upcoming) parts.push(`${upcoming} upcoming day${upcoming === 1 ? "" : "s"} will count once a lecture is held`);
  if (skipped) parts.push(`${skipped} day${skipped === 1 ? "" : "s"} skipped (no lecture was held)`);
  return parts.length ? `OD approved: ${parts.join("; ")}.` : "OD approved. No attendance was changed.";
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
  uploadSlot,
  (req, res, next) => upload.single("proof")(req, res, (err) => {
    if (handleMulterError(err, res)) return;
    next();
  }),
  // multipart bodies only exist after multer ran, so the identity check comes after it
  guard.student(fromBody("student_uid")),
  async (req, res) => {
    let uploaded = null;
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
      for (const v of [student_uid, subject_id, teacher_id, course_id, student_name, reason, from_date]) {
        if (typeof v !== "string") {
          return res.status(400).json({
            success: false,
            error: "student_uid, subject_id, teacher_id, course_id, student_name, reason, from_date are required",
          });
        }
      }

      if (!req.file) {
        return res.status(400).json({ success: false, error: "Proof document is required" });
      }
      if (!looksLikeItsType(req.file.buffer, req.file.mimetype)) {
        return res.status(400).json({ success: false, error: "The uploaded file does not match its file type" });
      }

      const effectiveTo = to_date || from_date;
      if (!YMD.test(from_date) || !YMD.test(effectiveTo)) {
        return res.status(400).json({ success: false, error: "Dates must be in YYYY-MM-DD format" });
      }
      if (effectiveTo < from_date) {
        return res.status(400).json({ success: false, error: "to_date cannot be before from_date" });
      }
      const spanDays = (Date.parse(effectiveTo) - Date.parse(from_date)) / 86400000 + 1;
      if (!(spanDays >= 1) || spanDays > MAX_OD_DAYS) {
        return res.status(400).json({ success: false, error: `An OD request can cover at most ${MAX_OD_DAYS} days` });
      }

      // The request must go to the teacher of that subject, for a subject the student takes.
      // (checked only for authenticated callers; enforced when AUTH_MODE=enforce)
      if (req.auth) {
        const subj = await getSubject(subject_id);
        if (!allow(req, res, !!subj && subj.teacher_assigned === teacher_id, "od-teacher-subject")) return;
        if (!allow(req, res, await isEnrolled(student_uid, subject_id), "od-enrolled")) return;
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

      // An OD only makes sense for days with a lecture. Past days with no lecture, or a range that is
      // entirely in the past with no lecture at all, are refused before anything is uploaded.
      {
        const lectureDays = lectureDateSet(await getLectureSessionsForSubject(subject_id));
        const days = datesInRange(from_date, effectiveTo);
        if (!days.length) {
          return res.status(422).json({ success: false, error: "The selected dates only contain Sundays." });
        }
        const today = todayIST();
        if (!days.some((d) => lectureDays.has(d) || d > today)) {
          return res.status(422).json({
            success: false,
            error: "No lecture was held for this subject on the selected dates, so there is nothing to apply OD to.",
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
      uploaded = proof.key;
      req.file.buffer = null; // let the 10 MB buffer be collected right away

      const now = admin.firestore.FieldValue.serverTimestamp();

      await odRef.set({
        od_id:        odId,
        student_uid,
        student_name: student_name.slice(0, 200),
        subject_id,
        teacher_id,
        course_id,
        reason:       reason.trim().slice(0, 2000),
        from_date,
        to_date:      effectiveTo,
        proof,                        // { key, url, name, size, type }
        status:       "pending",      // pending | approved | rejected
        teacher_note: null,
        created_at:   now,
        updated_at:   now,
      });
      uploaded = null; // persisted -> keep the file
      teacherListCache.delPrefix(`${teacher_id}|`);

      // ── Notify teacher ────────────────────────────────────────────
      notify({
        userIds: [teacher_id],
        title:   "New OD request",
        body:    `${student_name} submitted an OD request (${from_date}${effectiveTo !== from_date ? " → " + effectiveTo : ""})`,
        data: {
          screen: "ODRequestsTeacher",
          params: { subject_id, course_id },
        },
      });

      return res.status(201).json({ success: true, od_id: odId, message: "OD request submitted" });
    } catch (error) {
      console.error("OD REQUEST ERROR:", error);
      if (uploaded) deleteFromR2(uploaded); // don't leave an orphaned proof behind
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
router.get("/student/:student_uid", guard.selfOrTeacher(fromParams("student_uid")), async (req, res) => {
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
// Teacher identity: when ?uid= is given it is resolved to the teacher doc
// (the original only matched teachers.teacher_id == uid, which can never match
// a Firebase auth uid; user_id is now tried as well). Otherwise the URL param is used.
//
// Query: subject_id (optional), status (optional: pending|approved|rejected)
// ═══════════════════════════════════════════════════════════════════
router.get("/teacher/:teacher_id", async (req, res) => {
  try {
    const uid = req.user?.uid || req.query.uid;

    let resolvedTeacherId = req.params.teacher_id; // fallback

    if (uid) {
      let teacherDoc;
      const byField = await db
        .collection("teachers")
        .where("teacher_id", "==", uid)
        .limit(1)
        .get();
      if (!byField.empty) {
        teacherDoc = byField.docs[0];
      } else {
        const byUser = await db
          .collection("teachers")
          .where("user_id", "==", uid)
          .limit(1)
          .get();
        if (!byUser.empty) teacherDoc = byUser.docs[0];
      }

      if (!teacherDoc) {
        return res.status(404).json({ success: false, error: "Teacher profile not found" });
      }
      resolvedTeacherId = teacherDoc.id; // Firestore document ID — matches teacher_assigned field
    }

    // the token owner must be that teacher (enforced when AUTH_MODE=enforce)
    if (req.auth) {
      const mine = await teacherIdForUid(req.auth.uid);
      if (!allow(req, res, mine === resolvedTeacherId, "od-teacher-list")) return;
    }

    const { subject_id, status } = req.query;

    const payload = await teacherListCache.memo(
      `${resolvedTeacherId}|${subject_id || ""}|${status || ""}`,
      5_000,
      async () => {
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
        return { requests, summary: { pending, approved, rejected } };
      }
    );

    return res.json({
      success:            true,
      count:              payload.requests.length,
      resolved_teacher_id: resolvedTeacherId, // helpful for debugging
      summary:            payload.summary,
      requests:           payload.requests,
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
// The "is it still pending?" check and the status change now happen in ONE
// transaction together with the attendance writes, so two clicks (or two
// browser tabs) can no longer approve the same request twice.
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

    // ── Resolve teacher from Firestore ──────────────────────────────────
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

    // the token owner must be that teacher (enforced when AUTH_MODE=enforce)
    if (req.auth) {
      const mine = await teacherIdForUid(req.auth.uid);
      if (!allow(req, res, mine === teacher_id, "od-review")) return;
    }

    const note = typeof teacher_note === "string" ? (teacher_note.trim().slice(0, 1000) || null) : null;
    const odRef = db.collection("od_requests").doc(od_id);
    const now = admin.firestore.FieldValue.serverTimestamp();

    let od = null;
    let overflow = null; // attendance docs that did not fit into the transaction
    let odStats = { marked: 0, upcoming: 0, skipped: 0 };

    // lecture days of the subject (read before the transaction: it is a cached, read-only lookup)
    let lectureDays = new Set();
    if (action === "approved") {
      const pre = await odRef.get();
      if (pre.exists && typeof pre.data().subject_id === "string") {
        lectureDays = lectureDateSet(await getLectureSessionsForSubject(pre.data().subject_id));
      }
    }

    const failure = await db.runTransaction(async (t) => {
      overflow = null;
      const odDoc = await t.get(odRef);

      if (!odDoc.exists) return { code: 404, error: "OD request not found" };

      od = odDoc.data();

      if (od.teacher_id !== teacher_id) return { code: 403, error: "Not authorised to review this request" };
      if (od.status !== "pending")      return { code: 400, error: `OD request is already ${od.status}` };

      // ── Update OD request ────────────────────────────────────────────
      t.update(odRef, { status: action, teacher_note: note, updated_at: now });

      // ── If approved: upsert attendance_records with status "od" ──────
      if (action === "approved") {
        const built = buildOdAttendance(od, od_id, now, lectureDays);
        const recs = built.records;
        odStats = { marked: built.marked, upcoming: built.upcoming, skipped: built.skipped };
        if (recs.length <= 450) {
          recs.forEach((r) => t.set(r.ref, r.data, { merge: true }));
        } else {
          overflow = recs; // very long legacy request: written in batches below
        }
      }
      return null;
    });

    if (failure) {
      return res.status(failure.code).json({ success: false, error: failure.error });
    }
    if (overflow) {
      await commitInBatches(overflow.map((r) => (b) => b.set(r.ref, r.data, { merge: true })));
    }

    teacherListCache.delPrefix(`${teacher_id}|`);

    // ── Notify student ───────────────────────────────────────────────
        const statusLabel = action === "approved" ? "Approved" : "Rejected";

    notify({
      userIds: [od.student_uid],
      title:   `OD request ${statusLabel.toLowerCase()}`,
      body:    action === "approved"
        ? `Your OD for ${od.from_date}${od.to_date !== od.from_date ? " → " + od.to_date : ""} has been approved. Attendance marked as OD.`
        : `Your OD request for ${od.from_date}${od.to_date !== od.from_date ? " → " + od.to_date : ""} was rejected.${typeof teacher_note === "string" && teacher_note ? " Note: " + teacher_note : ""}`,
      data: {
        screen: "StudentAttendance",
        params: { subject_id: od.subject_id },
      },
    });

    return res.json({
      success: true,
      message: action === "approved"
        ? odApprovalMessage(odStats)
        : "OD request rejected",
      ...(action === "approved" ? { od_summary: odStats } : {}),
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
router.delete("/:od_id", guard.student(fromBody("student_uid")), async (req, res) => {
  try {
    const { od_id }     = req.params;
    const { student_uid } = req.body;

    const odRef = db.collection("od_requests").doc(od_id);

    // check + delete atomically, so a request the teacher approves a moment
    // earlier can not be cancelled afterwards (attendance would already be written)
    let od = null;
    const failure = await db.runTransaction(async (t) => {
      const odDoc = await t.get(odRef);

      if (!odDoc.exists) {
        return { code: 404, error: "OD request not found" };
      }

      od = odDoc.data();

      if (od.student_uid !== student_uid) {
        return { code: 403, error: "Not authorised" };
      }

      if (od.status !== "pending") {
        return { code: 400, error: "Only pending requests can be cancelled" };
      }

      t.delete(odRef);
      return null;
    });

    if (failure) {
      return res.status(failure.code).json({ success: false, error: failure.error });
    }

    if (od.proof?.key) deleteFromR2(od.proof.key); // best effort, not awaited
    teacherListCache.delPrefix(`${od.teacher_id}|`);

    return res.json({ success: true, message: "OD request cancelled" });
  } catch (error) {
    console.error("OD DELETE ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to cancel OD request" });
  }
});

module.exports = router;