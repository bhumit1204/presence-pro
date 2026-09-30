// reports_routes.js
// Mount as: app.use("/api/reports", require("./routes/reports_routes"));

const express = require("express");
const router = express.Router();
const { admin, db } = require("../config/firebase");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function toISO(val) {
  if (!val) return null;
  if (typeof val?.toDate === "function") return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

/**
 * Parse a YYYY-MM-DD string into { year, month, day } WITHOUT timezone
 * conversion.  new Date("2026-04-01") is parsed as UTC midnight → in IST
 * (+5:30) that becomes March 31 at 18:30, so .toISOString() returns the
 * wrong date.  This helper avoids that problem entirely.
 */
function parseYMD(str) {
  const [y, m, d] = str.split("-").map(Number);
  return { y, m, d };
}

/**
 * Advance a YYYY-MM-DD string by one calendar day.
 * Uses Date.UTC so DST can never shift the result.
 */
function nextDay(str) {
  const { y, m, d } = parseYMD(str);
  const utc = new Date(Date.UTC(y, m - 1, d + 1));
  return utc.toISOString().split("T")[0];
}

/**
 * Day-of-week (0=Sun…6=Sat) for a YYYY-MM-DD string, computed in UTC.
 */
function dowUTC(str) {
  const { y, m, d } = parseYMD(str);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Returns every YYYY-MM-DD from startStr to endStr inclusive, skipping Sundays.
 */
function getDateRange(startStr, endStr) {
  const dates = [];
  let cur = startStr;
  while (cur <= endStr) {
    if (dowUTC(cur) !== 0) dates.push(cur);
    cur = nextDay(cur);
  }
  return dates;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE LOG
//
// 1. DATE RANGE BUG FIXED
//    new Date("2026-04-01") is midnight UTC = March 31 18:30 IST, so
//    toISOString().split("T")[0] returns "2026-03-31".  All date maths
//    now uses parseYMD / nextDay / dowUTC which operate in UTC and never
//    touch the local timezone.
//
// 2. MANUAL MARKING ALLOWED WITHOUT A LECTURE SESSION
//    Manual marking is a teacher override — it is permitted regardless of
//    whether a lecture session exists for that date.
//
// 3. ATTENDANCE COUNT GUARD
//    Before writing, the route counts the student's current present/late
//    records versus total completed lecture sessions.  If already at the
//    limit, the whole request is rejected with HTTP 409.
//
// 4. AUTO ATTENDANCE IS NEVER OVERWRITTEN
//    Per-date: if a non-manual attendance_record already exists for the
//    student, that date is skipped (action: "skipped").  Only genuinely
//    missing or previously-manual dates get a new/updated record.
//
// 5. RECORD STRUCTURE MATCHES lecture_routes.js EXACTLY
//    Fields: attendance_session_id, lecture_session_id, student_uid,
//    student_name, student_roll, status, verified_by_teacher, marked_at,
//    source:"manual", subject_id, date.
//    Doc ID = "${attendance_session_id}_${student_uid}" when a session is
//    found, else "manual_${subject_id}_${date}_${student_uid}".
//
// 6. AUTO-DETECTION OF lecture_session + attendance_session
//    For each date in the range the route looks up whether a completed
//    lecture_session exists for this subject on that date, then reads its
//    attendance_session_id.  Both IDs are embedded in the written record.
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/students/search
// ─────────────────────────────────────────────────────────────────────────────
router.get("/students/search", async (req, res) => {
  try {
    const { teacher_id, subject_id, query = "", limit: lim = 20 } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists || subjectDoc.data().teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    const studentsSnap = await db
      .collection("students")
      .where("enrolled_subjects", "array-contains", subject_id)
      .where("approval_status", "==", "approved")
      .get();

    let students = studentsSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        uid: d.uid,
        name: d.name || `${d.first_name || ""} ${d.last_name || ""}`.trim(),
        email: d.email || null,
        roll_no: d.roll_no || null,
        course_name: d.course_name || null,
        semester: d.semester || null,
      };
    });

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      students = students.filter(
        (s) =>
          s.name?.toLowerCase().includes(q) ||
          s.email?.toLowerCase().includes(q) ||
          s.roll_no?.toLowerCase().includes(q)
      );
    }
    students = students.slice(0, Number(lim));
    return res.json({ success: true, count: students.length, students });
  } catch (e) {
    console.error("STUDENT SEARCH ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/students/by-qr
// ─────────────────────────────────────────────────────────────────────────────
router.get("/students/by-qr", async (req, res) => {
  try {
    const { uid, teacher_id, subject_id } = req.query;
    if (!uid || !teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "uid, teacher_id and subject_id are required" });

    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists || subjectDoc.data().teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    const studentDoc = await db.collection("students").doc(uid).get();
    if (!studentDoc.exists)
      return res.status(404).json({ success: false, error: "Student not found" });

    const d = studentDoc.data();
    if (!d.enrolled_subjects?.includes(subject_id))
      return res.status(403).json({ success: false, error: "Student is not enrolled in this subject" });

    return res.json({
      success: true,
      student: {
        uid: d.uid,
        name: d.name || `${d.first_name || ""} ${d.last_name || ""}`.trim(),
        email: d.email || null,
        roll_no: d.roll_no || null,
        course_name: d.course_name || null,
        semester: d.semester || null,
      },
    });
  } catch (e) {
    console.error("QR RESOLVE ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/student/:student_uid/quiz
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student/:student_uid/quiz", async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { teacher_id, subject_id } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists || subjectDoc.data().teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    const quizzesSnap = await db
      .collection("quizzes")
      .where("subject_id", "==", subject_id)
      .where("teacher_id", "==", teacher_id)
      .get();

    const quizzes = quizzesSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        quiz_id: d.quiz_id,
        title: d.title,
        total_marks: d.total_marks,
        question_count: d.question_count,
        scheduled_start: toISO(d.scheduled_start),
        scheduled_end: toISO(d.scheduled_end),
      };
    });

    if (!quizzes.length)
      return res.json({ success: true, summary: { total_quizzes: 0, attempted: 0, skipped: 0, avg_marks: null, avg_percentage: null }, quizzes: [] });

    const CHUNK = 30;
    const submissionMap = {};
    for (let i = 0; i < quizzes.length; i += CHUNK) {
      const chunk = quizzes.slice(i, i + CHUNK).map((q) => q.quiz_id);
      const subsSnap = await db
        .collection("quiz_submissions")
        .where("quiz_id", "in", chunk)
        .where("student_uid", "==", student_uid)
        .get();
      subsSnap.docs.forEach((doc) => {
        const d = doc.data();
        submissionMap[d.quiz_id] = { submission_id: d.submission_id, marks_obtained: d.marks_obtained, percentage: d.percentage, submitted_at: toISO(d.submitted_at) };
      });
    }

    const now = new Date();
    const enriched = quizzes.map((q) => {
      const sub = submissionMap[q.quiz_id] || null;
      const ended = new Date(q.scheduled_end) < now;
      return { ...q, submission: sub, status: sub ? "attempted" : ended ? "missed" : "upcoming" };
    });

    const attempted = enriched.filter((q) => q.submission);
    const skipped   = enriched.filter((q) => !q.submission && new Date(q.scheduled_end) < now);
    const avgMarks  = attempted.length ? parseFloat((attempted.reduce((s, q) => s + (q.submission?.marks_obtained || 0), 0) / attempted.length).toFixed(2)) : null;
    const avgPct    = attempted.length ? parseFloat((attempted.reduce((s, q) => s + (q.submission?.percentage    || 0), 0) / attempted.length).toFixed(2)) : null;

    return res.json({ success: true, summary: { total_quizzes: quizzes.length, attempted: attempted.length, skipped: skipped.length, avg_marks: avgMarks, avg_percentage: avgPct }, quizzes: enriched });
  } catch (e) {
    console.error("QUIZ REPORT ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/student/:student_uid/assignments
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student/:student_uid/assignments", async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { teacher_id, subject_id } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists || subjectDoc.data().teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    const assignmentsSnap = await db
      .collection("assignments")
      .where("subject_id", "==", subject_id)
      .where("teacher_id", "==", teacher_id)
      .get();

    const assignments = assignmentsSnap.docs.map((doc) => {
      const d = doc.data();
      return { assignment_id: d.assignment_id, title: d.title, marks: d.marks, due_date: toISO(d.due_date), allow_late: d.allow_late || false, created_at: toISO(d.created_at) };
    });

    if (!assignments.length)
      return res.json({ success: true, summary: { total: 0, submitted: 0, skipped: 0, late: 0, graded: 0, avg_marks: null }, assignments: [] });

    const CHUNK = 30;
    const submissionMap = {};
    for (let i = 0; i < assignments.length; i += CHUNK) {
      const chunk = assignments.slice(i, i + CHUNK).map((a) => a.assignment_id);
      const subsSnap = await db
        .collection("submissions")
        .where("assignment_id", "in", chunk)
        .where("student_uid", "==", student_uid)
        .get();
      subsSnap.docs.forEach((doc) => {
        const d = doc.data();
        submissionMap[d.assignment_id] = { submission_id: d.submission_id, status: d.status, marks_obtained: d.marks_obtained, feedback: d.feedback || null, submitted_at: toISO(d.submitted_at), graded_at: toISO(d.graded_at) };
      });
    }

    const now = new Date();
    const enriched = assignments.map((a) => {
      const sub = submissionMap[a.assignment_id] || null;
      const pastDue = new Date(a.due_date) < now;
      return { ...a, submission: sub, display_status: sub ? sub.status : pastDue ? "missed" : "pending" };
    });
    enriched.sort((a, b) => new Date(b.due_date) - new Date(a.due_date));

    const submitted  = enriched.filter((a) => a.submission);
    const gradedSubs = submitted.filter((a) => a.submission?.status === "graded");
    const lateSubs   = submitted.filter((a) => a.submission?.status === "late");
    const skipped    = enriched.filter((a) => !a.submission && new Date(a.due_date) < now);
    const avgMarks   = gradedSubs.length ? parseFloat((gradedSubs.reduce((s, a) => s + (a.submission?.marks_obtained || 0), 0) / gradedSubs.length).toFixed(2)) : null;

    return res.json({ success: true, summary: { total: assignments.length, submitted: submitted.length, skipped: skipped.length, late: lateSubs.length, graded: gradedSubs.length, avg_marks: avgMarks }, assignments: enriched });
  } catch (e) {
    console.error("ASSIGNMENT REPORT ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Get all completed lecture sessions for a subject.
// Returns [{ sessionId, date, data }] — richer than just IDs.
// ─────────────────────────────────────────────────────────────────────────────
async function getLectureSessionsForSubject(subject_id) {
  const lecturesSnap = await db
    .collection("lectures")
    .where("subject_id", "==", subject_id)
    .get();

  const lectureIds = lecturesSnap.docs.map((d) => d.id);
  if (!lectureIds.length) return [];

  const sessions = [];
  const CHUNK = 30;
  for (let i = 0; i < lectureIds.length; i += CHUNK) {
    const chunk = lectureIds.slice(i, i + CHUNK);
    const snap = await db
      .collection("lecture_sessions")
      .where("lecture_id", "in", chunk)
      .where("status", "==", "completed")
      .get();

    snap.docs.forEach((doc) => {
      const data = doc.data();
      const date = data.date || toISO(data.started_at)?.split("T")[0] || null;
      sessions.push({ sessionId: doc.id, date, data });
    });
  }
  return sessions;
}

// Convenience wrapper — only IDs
async function getLectureSessionIdsForSubject(subject_id) {
  return (await getLectureSessionsForSubject(subject_id)).map((s) => s.sessionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Build unified attendance records for a student + subject.
//
// Priority (first hit for a given date wins):
//   1. attendance_records WHERE source == "manual"
//   2. attendance_records WHERE source == "od"  (approved OD leave)
//   3. attendance_sessions.present_students  (mark-code / mark-bio)
//   4. attendance_records (all non-manual, non-od)
// ─────────────────────────────────────────────────────────────────────────────
async function buildAttendanceRecords(student_uid, subject_id, sessionIds) {
  const byDate = {};

  // Source 1 — manual records (stored directly on attendance_records)
  const manualSnap = await db
    .collection("attendance_records")
    .where("student_uid", "==", student_uid)
    .where("subject_id", "==", subject_id)
    .where("source", "==", "manual")
    .get();

  manualSnap.docs.forEach((doc) => {
    const d = doc.data();
    const dateStr = d.date || toISO(d.marked_at)?.split("T")[0] || null;
    if (!dateStr) return;
    byDate[dateStr] = {
      attendance_id: doc.id,
      date: dateStr,
      status: d.status,
      marked_by: "manual",
      note: d.note || null,
      marked_at: toISO(d.marked_at),
    };
  });

  // Source 2 — OD records (approved OD leave; no lecture_session_id, source=="od")
  // These count as present and should always appear regardless of session list.
  const odSnap = await db
    .collection("attendance_records")
    .where("student_uid", "==", student_uid)
    .where("subject_id", "==", subject_id)
    .where("source", "==", "od")
    .get();

  odSnap.docs.forEach((doc) => {
    const d = doc.data();
    const dateStr = d.date || toISO(d.marked_at)?.split("T")[0] || null;
    if (!dateStr || byDate[dateStr]) return; // manual takes priority
    byDate[dateStr] = {
      attendance_id: doc.id,
      date: dateStr,
      status: "od",
      marked_by: "od_approval",
      note: d.note || null,
      marked_at: toISO(d.marked_at || d.created_at),
    };
  });

  if (!sessionIds.length) return Object.values(byDate);

  const CHUNK = 30;

  // Build sessionId → date map
  const sessionDateMap = {};
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const chunk = sessionIds.slice(i, i + CHUNK);
    const snap = await db
      .collection("lecture_sessions")
      .where(admin.firestore.FieldPath.documentId(), "in", chunk)
      .get();
    snap.docs.forEach((doc) => {
      const d = doc.data();
      sessionDateMap[doc.id] = d.date || toISO(d.started_at)?.split("T")[0] || null;
    });
  }

  // Source 3 — present_students arrays
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const chunk = sessionIds.slice(i, i + CHUNK);
    const snap = await db
      .collection("attendance_sessions")
      .where("lecture_session_id", "in", chunk)
      .get();
    snap.docs.forEach((doc) => {
      const d = doc.data();
      const dateStr = sessionDateMap[d.lecture_session_id] || toISO(d.started_at)?.split("T")[0] || null;
      if ((d.present_students || []).includes(student_uid) && dateStr && !byDate[dateStr]) {
        byDate[dateStr] = { attendance_id: doc.id, date: dateStr, status: "present", marked_by: "auto", note: null, marked_at: toISO(d.started_at) };
      }
    });
  }

  // Source 4 — non-manual, non-od attendance_records (QR / IoT / biometric)
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const chunk = sessionIds.slice(i, i + CHUNK);
    const snap = await db
      .collection("attendance_records")
      .where("lecture_session_id", "in", chunk)
      .where("student_uid", "==", student_uid)
      .get();
    snap.docs.forEach((doc) => {
      const d = doc.data();
      if (d.source === "manual" || d.source === "od") return;
      const dateStr = sessionDateMap[d.lecture_session_id] || toISO(d.marked_at)?.split("T")[0] || null;
      if (!dateStr || byDate[dateStr]) return;
      byDate[dateStr] = { attendance_id: doc.id, date: dateStr, status: d.status || "present", marked_by: d.method || d.marked_by || "auto", note: null, marked_at: toISO(d.marked_at) };
    });
  }

  return Object.values(byDate);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/student/:student_uid/attendance
// Summary card is always full-picture; records list respects date filter.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student/:student_uid/attendance", async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { teacher_id, subject_id, from_date, to_date } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists || subjectDoc.data().teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    const sessionIds  = await getLectureSessionIdsForSubject(subject_id);
    const allRecords  = await buildAttendanceRecords(student_uid, subject_id, sessionIds);

    const presentAll  = allRecords.filter((r) => r.status === "present" || r.status === "late" || r.status === "od").length;
    const absentAll   = allRecords.filter((r) => r.status === "absent").length;
    const lateAll     = allRecords.filter((r) => r.status === "late").length;
    const odAll       = allRecords.filter((r) => r.status === "od").length;
    const percentage  = sessionIds.length > 0 ? parseFloat(((presentAll / sessionIds.length) * 100).toFixed(2)) : null;

    let display = [...allRecords];
    if (from_date) display = display.filter((r) => r.date && r.date >= from_date);
    if (to_date)   display = display.filter((r) => r.date && r.date <= to_date);
    display.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    return res.json({
      success: true,
      summary: { total_lectures: sessionIds.length, present: presentAll, absent: absentAll, late: lateAll, od: odAll, percentage },
      records: display,
    });
  } catch (e) {
    console.error("ATTENDANCE REPORT ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reports/attendance/manual
// ─────────────────────────────────────────────────────────────────────────────
router.post("/attendance/manual", async (req, res) => {
  try {
    const { teacher_id, subject_id, student_uid, date, end_date, status, note } = req.body;

    if (!teacher_id || !subject_id || !student_uid || !date || !status)
      return res.status(400).json({ success: false, error: "teacher_id, subject_id, student_uid, date and status are required" });

    const validStatuses = ["present", "absent", "late"];
    if (!validStatuses.includes(status))
      return res.status(400).json({ success: false, error: `status must be one of: ${validStatuses.join(", ")}` });

    // Ownership check
    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists || subjectDoc.data().teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    // Fetch student profile — needed to mirror lecture_routes field structure
    const studentDoc = await db.collection("students").doc(student_uid).get();
    if (!studentDoc.exists)
      return res.status(404).json({ success: false, error: "Student not found" });
    const sd = studentDoc.data();
    const student_name = sd.name || `${sd.first_name || ""} ${sd.last_name || ""}`.trim();
    const student_roll = sd.roll_no || sd.roll_number || null;

    // ── Attendance count guard ──────────────────────────────────────────────
    const allSessions    = await getLectureSessionsForSubject(subject_id);
    const totalLectures  = allSessions.length;
    const existingAll    = await buildAttendanceRecords(student_uid, subject_id, allSessions.map((s) => s.sessionId));
    const currentPresent = existingAll.filter((r) => r.status === "present" || r.status === "late" || r.status === "od").length;

    if (
      (status === "present" || status === "late") &&
      totalLectures > 0 &&
      currentPresent >= totalLectures
    ) {
      return res.status(409).json({
        success: false,
        error: `Cannot mark present: ${currentPresent} present record(s) already exist and there are only ${totalLectures} completed lecture(s).`,
      });
    }

    // ── Date list (Sunday-safe, timezone-safe) ──────────────────────────────
    const datesToMark = getDateRange(date, end_date || date);
    if (!datesToMark.length)
      return res.status(400).json({ success: false, error: "No valid dates in range (all Sundays?)" });

    // ── date → session lookup ───────────────────────────────────────────────
    // Maps a date string to the lecture_session and attendance_session for it.
    const sessionByDate = {};
    for (const s of allSessions) {
      if (s.date && !sessionByDate[s.date]) {
        sessionByDate[s.date] = {
          lecture_session_id:    s.sessionId,
          attendance_session_id: s.data.attendance_session_id || null,
        };
      }
    }

    // ── existing record lookup (by date) ────────────────────────────────────
    const existingByDate = {};
    for (const r of existingAll) {
      if (r.date) existingByDate[r.date] = r;
    }

    const now     = admin.firestore.FieldValue.serverTimestamp();
    const results = [];

    for (const dateStr of datesToMark) {
      const existing = existingByDate[dateStr];

      // Never overwrite auto-generated attendance
      if (existing && existing.marked_by !== "manual") {
        results.push({ date: dateStr, action: "skipped", reason: "auto_record_exists" });
        continue;
      }

      const info = sessionByDate[dateStr] || {};
      const lecture_session_id    = info.lecture_session_id    || null;
      const attendance_session_id = info.attendance_session_id || null;

      // Doc ID mirrors lecture_routes.js convention
      const docId = attendance_session_id
        ? `${attendance_session_id}_${student_uid}`
        : `manual_${subject_id}_${dateStr}_${student_uid}`;

      const recordRef  = db.collection("attendance_records").doc(docId);
      const recordSnap = await recordRef.get();

      // Double-check the doc is not an auto record
      if (recordSnap.exists && recordSnap.data().source !== "manual") {
        results.push({ date: dateStr, action: "skipped", reason: "auto_record_exists" });
        continue;
      }

      const payload = {
        // ── Session linkage (matches lecture_routes.js exactly)
        attendance_session_id: attendance_session_id || null,
        lecture_session_id:    lecture_session_id    || null,
        // ── Student
        student_uid,
        student_name,
        student_roll,
        // ── Status
        status,
        // ── Manual markers
        source:              "manual",
        verified_by_teacher: true,
        marked_by:           "manual",
        marked_by_teacher:   teacher_id,
        // ── Subject + date (allows filter without session join)
        subject_id,
        date: dateStr,
        // ── Note
        note: note || null,
        // ── Timestamps
        marked_at:  now,
        updated_at: now,
      };

      if (recordSnap.exists) {
        await recordRef.update(payload);
        results.push({ date: dateStr, action: "updated", attendance_id: docId });
      } else {
        await recordRef.set(payload);
        results.push({ date: dateStr, action: "created", attendance_id: docId });
      }
    }

    const created = results.filter((r) => r.action === "created").length;
    const updated = results.filter((r) => r.action === "updated").length;
    const skipped = results.filter((r) => r.action === "skipped").length;

    return res.status(201).json({
      success: true,
      message: `Processed ${results.length} date(s): ${created} created, ${updated} updated, ${skipped} skipped (auto record already exists).`,
      dates_processed: results.length,
      results,
    });
  } catch (e) {
    console.error("MANUAL ATTENDANCE ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/attendance/by-date
// ─────────────────────────────────────────────────────────────────────────────
router.get("/attendance/by-date", async (req, res) => {
  try {
    const { teacher_id, subject_id, date } = req.query;
    if (!teacher_id || !subject_id || !date)
      return res.status(400).json({ success: false, error: "teacher_id, subject_id and date are required" });

    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists || subjectDoc.data().teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    const studentsSnap = await db
      .collection("students")
      .where("enrolled_subjects", "array-contains", subject_id)
      .where("approval_status", "==", "approved")
      .get();

    const students = studentsSnap.docs.map((doc) => {
      const d = doc.data();
      return { uid: d.uid, name: d.name || `${d.first_name || ""} ${d.last_name || ""}`.trim(), roll_no: d.roll_no || null };
    });

    const attMap = {};

    // Source 1 — manual records for this exact date
    const manualSnap = await db
      .collection("attendance_records")
      .where("subject_id", "==", subject_id)
      .where("source", "==", "manual")
      .where("date", "==", date)
      .get();
    manualSnap.docs.forEach((doc) => {
      const d = doc.data();
      attMap[d.student_uid] = { attendance_id: doc.id, status: d.status, marked_by: "manual" };
    });

    // Source 2 — OD records for this exact date (approved OD leave)
    const odSnap = await db
      .collection("attendance_records")
      .where("subject_id", "==", subject_id)
      .where("source", "==", "od")
      .where("date", "==", date)
      .get();
    odSnap.docs.forEach((doc) => {
      const d = doc.data();
      if (!attMap[d.student_uid]) { // manual takes priority
        attMap[d.student_uid] = { attendance_id: doc.id, status: "od", marked_by: "od_approval" };
      }
    });

    // Sources 2 & 3 — live lecture flows for sessions on this date only
    const allSessions         = await getLectureSessionsForSubject(subject_id);
    const matchingSessionIds  = allSessions.filter((s) => s.date === date).map((s) => s.sessionId);
    const hasLecture          = matchingSessionIds.length > 0;

    if (matchingSessionIds.length) {
      const CHUNK = 30;

      for (let i = 0; i < matchingSessionIds.length; i += CHUNK) {
        const chunk = matchingSessionIds.slice(i, i + CHUNK);
        const snap = await db.collection("attendance_sessions").where("lecture_session_id", "in", chunk).get();
        snap.docs.forEach((doc) => {
          (doc.data().present_students || []).forEach((uid) => {
            if (!attMap[uid]) attMap[uid] = { attendance_id: doc.id, status: "present", marked_by: "auto" };
          });
        });
      }

      for (let i = 0; i < matchingSessionIds.length; i += CHUNK) {
        const chunk = matchingSessionIds.slice(i, i + CHUNK);
        const snap = await db.collection("attendance_records").where("lecture_session_id", "in", chunk).get();
        snap.docs.forEach((doc) => {
          const d = doc.data();
          if (d.source === "manual" || d.source === "od") return;
          if (!attMap[d.student_uid])
            attMap[d.student_uid] = { attendance_id: doc.id, status: d.status || "present", marked_by: d.method || "auto" };
        });
      }
    }

    const result = students.map((s) => ({
      ...s,
      status: hasLecture ? (attMap[s.uid]?.status || "absent") : "no_class",
      attendance_id: attMap[s.uid]?.attendance_id || null,
      marked_by: attMap[s.uid]?.marked_by || null,
    }));

    return res.json({ success: true, date, count: result.length, students: result });
  } catch (e) {
    console.error("ATTENDANCE BY DATE ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/student/:student_uid/full
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student/:student_uid/full", async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { teacher_id, subject_id } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists || subjectDoc.data().teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    const studentDoc = await db.collection("students").doc(student_uid).get();
    if (!studentDoc.exists)
      return res.status(404).json({ success: false, error: "Student not found" });

    const s = studentDoc.data();
    const profile = {
      uid: s.uid,
      name: s.name || `${s.first_name || ""} ${s.last_name || ""}`.trim(),
      email: s.email || null,
      roll_no: s.roll_no || null,
      course_name: s.course_name || null,
      semester: s.semester || null,
      college_name: s.college_name || null,
    };

    const [quizzesSnap, assignmentsSnap, sessionIds] = await Promise.all([
      db.collection("quizzes").where("subject_id", "==", subject_id).where("teacher_id", "==", teacher_id).get(),
      db.collection("assignments").where("subject_id", "==", subject_id).where("teacher_id", "==", teacher_id).get(),
      getLectureSessionIdsForSubject(subject_id),
    ]);

    const quizIds       = quizzesSnap.docs.map((d) => d.data().quiz_id);
    const assignmentIds = assignmentsSnap.docs.map((d) => d.data().assignment_id);

    const [quizSubsSnap, assSubsSnap, attRecords] = await Promise.all([
      quizIds.length
        ? db.collection("quiz_submissions").where("student_uid", "==", student_uid).where("quiz_id", "in", quizIds.slice(0, 30)).get()
        : Promise.resolve({ docs: [] }),
      assignmentIds.length
        ? db.collection("submissions").where("student_uid", "==", student_uid).where("assignment_id", "in", assignmentIds.slice(0, 30)).get()
        : Promise.resolve({ docs: [] }),
      buildAttendanceRecords(student_uid, subject_id, sessionIds),
    ]);

    const quizSubs    = quizSubsSnap.docs.map((d) => d.data());
    const quizAvgPct  = quizSubs.length ? parseFloat((quizSubs.reduce((s, q) => s + (q.percentage || 0), 0) / quizSubs.length).toFixed(2)) : null;

    const assSubs     = assSubsSnap.docs.map((d) => d.data());
    const gradedSubs  = assSubs.filter((s) => s.status === "graded");
    const assAvgMarks = gradedSubs.length ? parseFloat((gradedSubs.reduce((s, a) => s + (a.marks_obtained || 0), 0) / gradedSubs.length).toFixed(2)) : null;

    const present    = attRecords.filter((r) => r.status === "present" || r.status === "late" || r.status === "od").length;
    const attPct     = sessionIds.length ? parseFloat(((present / sessionIds.length) * 100).toFixed(2)) : null;

    return res.json({
      success: true,
      profile,
      quiz_summary:       { total: quizIds.length,       attempted: quizSubs.length,  skipped: quizIds.length - quizSubs.length,  avg_percentage: quizAvgPct  },
      assignment_summary: { total: assignmentIds.length, submitted: assSubs.length,   skipped: assignmentIds.length - assSubs.length, avg_marks: assAvgMarks },
      attendance_summary: { total_lectures: sessionIds.length, present, absent: sessionIds.length - present, percentage: attPct },
    });
  } catch (e) {
    console.error("FULL REPORT ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/class
// Returns a full class-level report for a subject:
//   - class_summary: aggregate stats
//   - students[]:    per-student rolled-up attendance, quiz, assignment data
//
// Query params: teacher_id, subject_id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/class", async (req, res) => {
  try {
    const { teacher_id, subject_id } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    // ── Ownership check ────────────────────────────────────────────────────
    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists || subjectDoc.data().teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    // ── Fetch enrolled students ────────────────────────────────────────────
    const studentsSnap = await db
      .collection("students")
      .where("enrolled_subjects", "array-contains", subject_id)
      .where("approval_status", "==", "approved")
      .get();

    const students = studentsSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        uid: d.uid,
        name: d.name || `${d.first_name || ""} ${d.last_name || ""}`.trim(),
        email: d.email || null,
        roll_no: d.roll_no || null,
        course_name: d.course_name || null,
        semester: d.semester || null,
      };
    });

    if (!students.length) {
      return res.json({
        success: true,
        class_summary: {
          total_students: 0,
          total_lectures: 0,
          total_quizzes: 0,
          total_assignments: 0,
          avg_attendance_pct: null,
          avg_quiz_pct: null,
          avg_assignment_marks: null,
          below_75_attendance: 0,
        },
        students: [],
      });
    }

    // ── Fetch lecture sessions ─────────────────────────────────────────────
    const sessionIds = await getLectureSessionIdsForSubject(subject_id);
    const totalLectures = sessionIds.length;

    // ── Fetch quizzes ──────────────────────────────────────────────────────
    const quizzesSnap = await db
      .collection("quizzes")
      .where("subject_id", "==", subject_id)
      .where("teacher_id", "==", teacher_id)
      .get();
    const quizzes = quizzesSnap.docs.map((d) => ({
      quiz_id: d.data().quiz_id,
      scheduled_end: toISO(d.data().scheduled_end),
    }));
    const totalQuizzes = quizzes.length;

    // ── Fetch assignments ──────────────────────────────────────────────────
    const assignmentsSnap = await db
      .collection("assignments")
      .where("subject_id", "==", subject_id)
      .where("teacher_id", "==", teacher_id)
      .get();
    const assignments = assignmentsSnap.docs.map((d) => ({
      assignment_id: d.data().assignment_id,
    }));
    const totalAssignments = assignments.length;

    // ── Per-student data ───────────────────────────────────────────────────
    const CHUNK = 30;
    const now = new Date();

    // Quiz submissions — batch across all students
    const quizSubMap = {}; // uid → quiz_id → sub
    if (quizzes.length) {
      for (let i = 0; i < quizzes.length; i += CHUNK) {
        const chunk = quizzes.slice(i, i + CHUNK).map((q) => q.quiz_id);
        const snap = await db.collection("quiz_submissions").where("quiz_id", "in", chunk).get();
        snap.docs.forEach((doc) => {
          const d = doc.data();
          if (!quizSubMap[d.student_uid]) quizSubMap[d.student_uid] = {};
          quizSubMap[d.student_uid][d.quiz_id] = d;
        });
      }
    }

    // Assignment submissions — batch across all students
    const assSubMap = {}; // uid → assignment_id → sub
    if (assignments.length) {
      for (let i = 0; i < assignments.length; i += CHUNK) {
        const chunk = assignments.slice(i, i + CHUNK).map((a) => a.assignment_id);
        const snap = await db.collection("submissions").where("assignment_id", "in", chunk).get();
        snap.docs.forEach((doc) => {
          const d = doc.data();
          if (!assSubMap[d.student_uid]) assSubMap[d.student_uid] = {};
          assSubMap[d.student_uid][d.assignment_id] = d;
        });
      }
    }

    // Build per-student result (attendance fetched individually since it needs session join)
    const studentResults = await Promise.all(
      students.map(async (s) => {
        // ── Attendance ──────────────────────────────────────────────────
        const attRecords = await buildAttendanceRecords(s.uid, subject_id, sessionIds);
        const present = attRecords.filter((r) => r.status === "present" || r.status === "late" || r.status === "od").length;
        const absent = totalLectures - present;
        const late = attRecords.filter((r) => r.status === "late").length;
        const attendance_pct =
          totalLectures > 0 ? parseFloat(((present / totalLectures) * 100).toFixed(1)) : null;

        // ── Quizzes ─────────────────────────────────────────────────────
        const mySubs = quizSubMap[s.uid] || {};
        const attemptedQuizzes = quizzes.filter((q) => mySubs[q.quiz_id]);
        const quiz_attempted = attemptedQuizzes.length;
        const quiz_avg_pct =
          quiz_attempted > 0
            ? parseFloat(
                (
                  attemptedQuizzes.reduce((acc, q) => acc + (mySubs[q.quiz_id]?.percentage || 0), 0) /
                  quiz_attempted
                ).toFixed(1)
              )
            : null;

        // ── Assignments ─────────────────────────────────────────────────
        const myAssSubs = assSubMap[s.uid] || {};
        const submittedAss = assignments.filter((a) => myAssSubs[a.assignment_id]);
        const gradedAss = submittedAss.filter((a) => myAssSubs[a.assignment_id]?.status === "graded");
        const assignment_submitted = submittedAss.length;
        const assignment_avg_marks =
          gradedAss.length > 0
            ? parseFloat(
                (
                  gradedAss.reduce((acc, a) => acc + (myAssSubs[a.assignment_id]?.marks_obtained || 0), 0) /
                  gradedAss.length
                ).toFixed(1)
              )
            : null;

        return {
          ...s,
          present,
          absent,
          late,
          attendance_pct,
          quiz_attempted,
          quiz_avg_pct,
          assignment_submitted,
          assignment_avg_marks,
        };
      })
    );

    // ── Class-level aggregates ─────────────────────────────────────────────
    const withAtt = studentResults.filter((s) => s.attendance_pct !== null);
    const withQuiz = studentResults.filter((s) => s.quiz_avg_pct !== null);
    const withAss = studentResults.filter((s) => s.assignment_avg_marks !== null);

    const avg_attendance_pct =
  withAtt.length
    ? parseFloat(
        (withAtt.reduce((a, s) => a + (s.attendance_pct || 0), 0) / withAtt.length).toFixed(1)
      )
    : null;
    const avg_quiz_pct =
      withQuiz.length
        ? parseFloat((withQuiz.reduce((a, s) => a + (s.quiz_avg_pct || 0), 0) / withQuiz.length).toFixed(1))
        : null;
    const avg_assignment_marks =
      withAss.length
        ? parseFloat((withAss.reduce((a, s) => a + (s.assignment_avg_marks || 0), 0) / withAss.length).toFixed(1))
        : null;
    const below_75_attendance = studentResults.filter(
      (s) => s.attendance_pct !== null && s.attendance_pct < 75
    ).length;

    return res.json({
      success: true,
      class_summary: {
        total_students: students.length,
        total_lectures: totalLectures,
        total_quizzes: totalQuizzes,
        total_assignments: totalAssignments,
        avg_attendance_pct,
        avg_quiz_pct,
        avg_assignment_marks,
        below_75_attendance,
      },
      students: studentResults,
    });
  } catch (e) {
    console.error("CLASS REPORT ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

module.exports = router;