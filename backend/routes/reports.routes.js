// reports_routes.js
// Mount as: app.use("/api/reports", require("./routes/reports_routes"));

const express = require("express");
const router = express.Router();
const { admin, db } = require("../config/firebase");
const { guard, fromQuery, fromBody } = require("../middleware/auth");
const { TTLCache } = require("../utils/cache");
const { getSubject } = require("../utils/ownership");
const { chunk, commitInBatches } = require("../utils/firestore");

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

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

// ─────────────────────────────────────────────────────────────────────────────
// SHARED LOOKUPS
//
// The original recomputed the lecture sessions, the attendance sessions and the
// session->date map for EVERY student of a class report (100 students = the same
// thousands of documents read 100 times). They are now loaded once per request;
// concurrent identical requests share the same load for a few seconds.
// ─────────────────────────────────────────────────────────────────────────────
const sessionsCache   = new TTLCache({ max: 500, ttlMs: 3_000 });   // subject_id -> [{sessionId,date,data}]
const attSessionCache = new TTLCache({ max: 500, ttlMs: 3_000 });   // subject_id -> [attendance_session docs]
const studentsCache   = new TTLCache({ max: 500, ttlMs: 10_000 });  // subject_id -> [approved enrolled students]
const classCache      = new TTLCache({ max: 300, ttlMs: 5_000 });   // "teacher|subject" -> class report

/** ownership check shared by all routes; returns true when the teacher may see this subject */
async function ownsSubject(teacher_id, subject_id) {
  if (typeof subject_id !== "string" || !subject_id || subject_id.includes("/")) return false;
  const s = await getSubject(subject_id);
  return !!s && s.teacher_assigned === teacher_id;
}

const nameOf = (d) => d.name || `${d.first_name || ""} ${d.last_name || ""}`.trim();

/** approved students enrolled in a subject (raw docs data) */
function enrolledStudents(subject_id) {
  return studentsCache.memo(subject_id, 10_000, async () => {
    const snap = await db
      .collection("students")
      .where("enrolled_subjects", "array-contains", subject_id)
      .where("approval_status", "==", "approved")
      .get();
    return snap.docs.map((doc) => doc.data());
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/students/search
// ─────────────────────────────────────────────────────────────────────────────
router.get("/students/search", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { teacher_id, subject_id, query = "", limit: lim = 20 } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    if (!(await ownsSubject(teacher_id, subject_id)))
      return res.status(403).json({ success: false, error: "Access denied" });

    const raw = await enrolledStudents(subject_id);

    let students = raw.map((d) => ({
      uid: d.uid,
      name: nameOf(d),
      email: d.email || null,
      roll_no: d.roll_no || null,
      course_name: d.course_name || null,
      semester: d.semester || null,
      division: d.division || null,
    }));

    const qs = typeof query === "string" ? query : "";
    if (qs.trim()) {
      const q = qs.trim().toLowerCase();
      students = students.filter(
        (s) =>
          s.name?.toLowerCase().includes(q) ||
          s.email?.toLowerCase().includes(q) ||
          String(s.roll_no ?? "").toLowerCase().includes(q)
      );
    }
    const n = Number(lim);
    students = students.slice(0, Number.isNaN(n) ? 0 : Math.min(n, 500));
    return res.json({ success: true, count: students.length, students });
  } catch (e) {
    console.error("STUDENT SEARCH ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/students/by-qr
// ─────────────────────────────────────────────────────────────────────────────
router.get("/students/by-qr", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { uid, teacher_id, subject_id } = req.query;
    if (!uid || !teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "uid, teacher_id and subject_id are required" });

    if (!(await ownsSubject(teacher_id, subject_id)))
      return res.status(403).json({ success: false, error: "Access denied" });

    if (typeof uid !== "string" || uid.includes("/"))
      return res.status(404).json({ success: false, error: "Student not found" });
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
        name: nameOf(d),
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

// `in` queries are limited to 30 values: run all chunks AT THE SAME TIME (the original ran them one by one)
async function inChunks(values, build) {
  const out = await Promise.all(chunk(values, 30).map((c) => build(c).get()));
  return out.flatMap((s) => s.docs);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/student/:student_uid/quiz
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student/:student_uid/quiz", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { teacher_id, subject_id } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    if (!(await ownsSubject(teacher_id, subject_id)))
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

    const submissionMap = {};
    const subDocs = await inChunks(quizzes.map((q) => q.quiz_id), (c) =>
      db.collection("quiz_submissions").where("quiz_id", "in", c).where("student_uid", "==", student_uid)
    );
    subDocs.forEach((doc) => {
      const d = doc.data();
      submissionMap[d.quiz_id] = { submission_id: d.submission_id, marks_obtained: d.marks_obtained, percentage: d.percentage, submitted_at: toISO(d.submitted_at) };
    });

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
router.get("/student/:student_uid/assignments", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { teacher_id, subject_id } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    if (!(await ownsSubject(teacher_id, subject_id)))
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

    const submissionMap = {};
    const subDocs = await inChunks(assignments.map((a) => a.assignment_id), (c) =>
      db.collection("submissions").where("assignment_id", "in", c).where("student_uid", "==", student_uid)
    );
    subDocs.forEach((doc) => {
      const d = doc.data();
      submissionMap[d.assignment_id] = { submission_id: d.submission_id, status: d.status, marks_obtained: d.marks_obtained, feedback: d.feedback || null, submitted_at: toISO(d.submitted_at), graded_at: toISO(d.graded_at) };
    });

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
function getLectureSessionsForSubject(subject_id) {
  return sessionsCache.memo(subject_id, 3_000, async () => {
    const lecturesSnap = await db
      .collection("lectures")
      .where("subject_id", "==", subject_id)
      .select("division_id")
      .get();

    const lectureIds = lecturesSnap.docs.map((d) => d.id);
    if (!lectureIds.length) return [];
    const lectureDiv = Object.fromEntries(lecturesSnap.docs.map((d) => [d.id, d.data().division_id || null]));

    const docs = await inChunks(lectureIds, (c) =>
      db.collection("lecture_sessions")
        .where("lecture_id", "in", c)
        .where("status", "==", "completed")
        .select("date", "started_at", "attendance_session_id", "lecture_id", "division_id")
    );

    return docs.map((doc) => {
      const data = doc.data();
      const date = data.date || toISO(data.started_at)?.split("T")[0] || null;
      // a session held for one division (null = for everybody)
      return { sessionId: doc.id, date, data, division: data.division_id || lectureDiv[data.lecture_id] || null };
    });
  });
}

/** the sessions a student of `divisionId` was expected to attend: common ones + their division's own */
const sessionsForDivision = (sessions, divisionId) => sessions.filter((x) => !x.division || x.division === (divisionId || null));

/** division of one student (cached profile lookup); null when unknown */
async function divisionOfStudent(uid) {
  try {
    const st = await require("../utils/students").getStudentByUid(uid);
    return (st && st.division_id) || null;
  } catch { return null; }
}

// Convenience wrapper — only IDs
async function getLectureSessionIdsForSubject(subject_id) {
  return (await getLectureSessionsForSubject(subject_id)).map((s) => s.sessionId);
}

/** attendance_sessions of the given lecture sessions (loaded once, shared by every student) */
function getAttendanceSessions(subject_id, sessionIds) {
  return attSessionCache.memo(subject_id, 3_000, async () => {
    if (!sessionIds.length) return [];
    return (await inChunks(sessionIds, (c) =>
      db.collection("attendance_sessions")
        .where("lecture_session_id", "in", c)
        .select("lecture_session_id", "present_students", "started_at")
    )).map((doc) => ({ id: doc.id, data: doc.data() }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Build unified attendance records for a student + subject.
//
// Priority (first hit for a given date wins):
//   1. attendance_records WHERE source == "manual"
//   2. attendance_records WHERE source == "od"  (approved OD leave)
//   3. attendance_sessions.present_students  (mark-code / mark-bio)
//   4. attendance_records (all non-manual, non-od)
//
// The four sources are independent reads, so they are fetched together; the
// merge below is exactly the original priority logic.
// ─────────────────────────────────────────────────────────────────────────────
function sourceRows(manualDocs, odDocs, attSessions, recordDocs, sessionDateMap, student_uid) {
  const byDate = {};

  // Source 1 — manual records (stored directly on attendance_records)
  manualDocs.forEach((doc) => {
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
  odDocs.forEach((doc) => {
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

  // Source 3 — present_students arrays
  for (const { id, data: d } of attSessions) {
    const dateStr = sessionDateMap[d.lecture_session_id] || toISO(d.started_at)?.split("T")[0] || null;
    if ((d.present_students || []).includes(student_uid) && dateStr && !byDate[dateStr]) {
      byDate[dateStr] = { attendance_id: id, date: dateStr, status: "present", marked_by: "auto", note: null, marked_at: toISO(d.started_at) };
    }
  }

  // Source 4 — non-manual, non-od attendance_records (QR / IoT / biometric)
  recordDocs.forEach((doc) => {
    const d = doc.data();
    if (d.source === "manual" || d.source === "od") return;
    const dateStr = sessionDateMap[d.lecture_session_id] || toISO(d.marked_at)?.split("T")[0] || null;
    if (!dateStr || byDate[dateStr]) return;
    byDate[dateStr] = { attendance_id: doc.id, date: dateStr, status: d.status || "present", marked_by: d.method || d.marked_by || "auto", note: null, marked_at: toISO(d.marked_at) };
  });

  return Object.values(byDate);
}

const RECORD_FIELDS = ["lecture_session_id", "student_uid", "source", "status", "method", "marked_by", "marked_at", "date"];

async function buildAttendanceRecords(student_uid, subject_id, sessionIds, sessions) {
  const [manualSnap, odSnap] = await Promise.all([
    db.collection("attendance_records")
      .where("student_uid", "==", student_uid).where("subject_id", "==", subject_id).where("source", "==", "manual").get(),
    db.collection("attendance_records")
      .where("student_uid", "==", student_uid).where("subject_id", "==", subject_id).where("source", "==", "od").get(),
  ]);

  if (!sessionIds.length) return sourceRows(manualSnap.docs, odSnap.docs, [], [], {}, student_uid);

  const sessionDateMap = {};
  for (const s of sessions) sessionDateMap[s.sessionId] = s.date;

  const [attSessions, recordDocs] = await Promise.all([
    getAttendanceSessions(subject_id, sessionIds),
    inChunks(sessionIds, (c) =>
      db.collection("attendance_records").where("lecture_session_id", "in", c).where("student_uid", "==", student_uid)
    ),
  ]);

  return sourceRows(manualSnap.docs, odSnap.docs, attSessions, recordDocs, sessionDateMap, student_uid);
}

const isPresentish = (r) => r.status === "present" || r.status === "late" || r.status === "od";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/student/:student_uid/attendance
// Summary card is always full-picture; records list respects date filter.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student/:student_uid/attendance", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { teacher_id, subject_id, from_date, to_date } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    if (!(await ownsSubject(teacher_id, subject_id)))
      return res.status(403).json({ success: false, error: "Access denied" });

    const sessions    = sessionsForDivision(await getLectureSessionsForSubject(subject_id), await divisionOfStudent(student_uid));
    const sessionIds  = sessions.map((s) => s.sessionId);
    const allRecords  = await buildAttendanceRecords(student_uid, subject_id, sessionIds, sessions);

    const presentAll  = allRecords.filter(isPresentish).length;
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
router.post("/attendance/manual", guard.teacher(fromBody("teacher_id")), async (req, res) => {
  try {
    const { teacher_id, subject_id, student_uid, date, end_date, status, note } = req.body;

    if (!teacher_id || !subject_id || !student_uid || !date || !status)
      return res.status(400).json({ success: false, error: "teacher_id, subject_id, student_uid, date and status are required" });

    const validStatuses = ["present", "absent", "late"];
    if (!validStatuses.includes(status))
      return res.status(400).json({ success: false, error: `status must be one of: ${validStatuses.join(", ")}` });

    if (typeof student_uid !== "string" || student_uid.includes("/") ||
        typeof date !== "string" || !YMD.test(date) ||
        (end_date && (typeof end_date !== "string" || !YMD.test(end_date))) ||
        (note != null && (typeof note !== "string" || note.length > 1000)))
      return res.status(400).json({ success: false, error: "date and end_date must be YYYY-MM-DD, note must be text (max 1000 characters)" });

    // Ownership check
    if (!(await ownsSubject(teacher_id, subject_id)))
      return res.status(403).json({ success: false, error: "Access denied" });

    // Fetch student profile — needed to mirror lecture_routes field structure
    const studentDoc = await db.collection("students").doc(student_uid).get();
    if (!studentDoc.exists)
      return res.status(404).json({ success: false, error: "Student not found" });
    const sd = studentDoc.data();
    const student_name = sd.name || `${sd.first_name || ""} ${sd.last_name || ""}`.trim();
    const student_roll = sd.roll_no || sd.roll_number || null;

    // ── Attendance count guard ──────────────────────────────────────────────
    const allSessions    = sessionsForDivision(await getLectureSessionsForSubject(subject_id), sd.division_id || null);
    const totalLectures  = allSessions.length;
    const existingAll    = await buildAttendanceRecords(student_uid, subject_id, allSessions.map((s) => s.sessionId), allSessions);
    const currentPresent = existingAll.filter(isPresentish).length;

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
    const lastDate = end_date || date;
    if ((Date.parse(lastDate) - Date.parse(date)) / 86400000 > MAX_RANGE_DAYS)
      return res.status(400).json({ success: false, error: `Date range is too long (max ${MAX_RANGE_DAYS} days)` });
    const datesToMark = getDateRange(date, lastDate);
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

    // Decide per date; the documents that might exist are fetched in ONE batched read
    // (the original did a read and a write per date, one after the other).
    const plan = [];
    for (const dateStr of datesToMark) {
      const existing = existingByDate[dateStr];

      // Never overwrite auto-generated attendance
      if (existing && existing.marked_by !== "manual") {
        plan.push({ dateStr, skip: true });
        continue;
      }

      const info = sessionByDate[dateStr] || {};
      const lecture_session_id    = info.lecture_session_id    || null;
      const attendance_session_id = info.attendance_session_id || null;

      // Doc ID mirrors lecture_routes.js convention
      const docId = attendance_session_id
        ? `${attendance_session_id}_${student_uid}`
        : `manual_${subject_id}_${dateStr}_${student_uid}`;

      plan.push({ dateStr, docId, lecture_session_id, attendance_session_id });
    }

    const refs = plan.filter((p) => !p.skip).map((p) => db.collection("attendance_records").doc(p.docId));
    const snaps = refs.length ? await db.getAll(...refs) : [];
    const snapById = new Map(snaps.map((s) => [s.id, s]));

    const ops = [];
    for (const p of plan) {
      if (p.skip) {
        results.push({ date: p.dateStr, action: "skipped", reason: "auto_record_exists" });
        continue;
      }
      const recordSnap = snapById.get(p.docId);

      // Double-check the doc is not an auto record
      if (recordSnap && recordSnap.exists && recordSnap.data().source !== "manual") {
        results.push({ date: p.dateStr, action: "skipped", reason: "auto_record_exists" });
        continue;
      }

      const payload = {
        // ── Session linkage (matches lecture_routes.js exactly)
        attendance_session_id: p.attendance_session_id || null,
        lecture_session_id:    p.lecture_session_id    || null,
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
        date: p.dateStr,
        // ── Note
        note: note || null,
        // ── Timestamps
        marked_at:  now,
        updated_at: now,
      };

      const recordRef = db.collection("attendance_records").doc(p.docId);
      if (recordSnap && recordSnap.exists) {
        ops.push((b) => b.update(recordRef, payload));
        results.push({ date: p.dateStr, action: "updated", attendance_id: p.docId });
      } else {
        ops.push((b) => b.set(recordRef, payload));
        results.push({ date: p.dateStr, action: "created", attendance_id: p.docId });
      }
    }
    await commitInBatches(ops);
    classCache.clear();

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
router.get("/attendance/by-date", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { teacher_id, subject_id, date } = req.query;
    if (!teacher_id || !subject_id || !date)
      return res.status(400).json({ success: false, error: "teacher_id, subject_id and date are required" });

    if (!(await ownsSubject(teacher_id, subject_id)))
      return res.status(403).json({ success: false, error: "Access denied" });

    const [rawStudents, manualSnap, odSnap, allSessions] = await Promise.all([
      enrolledStudents(subject_id),
      // Source 1 — manual records for this exact date
      db.collection("attendance_records")
        .where("subject_id", "==", subject_id).where("source", "==", "manual").where("date", "==", date).get(),
      // Source 2 — OD records for this exact date (approved OD leave)
      db.collection("attendance_records")
        .where("subject_id", "==", subject_id).where("source", "==", "od").where("date", "==", date).get(),
      getLectureSessionsForSubject(subject_id),
    ]);

    const students = rawStudents.map((d) => ({ uid: d.uid, name: nameOf(d), roll_no: d.roll_no || null, division_id: d.division_id || null, division: d.division || null }));

    const attMap = {};

    manualSnap.docs.forEach((doc) => {
      const d = doc.data();
      attMap[d.student_uid] = { attendance_id: doc.id, status: d.status, marked_by: "manual" };
    });

    odSnap.docs.forEach((doc) => {
      const d = doc.data();
      if (!attMap[d.student_uid]) { // manual takes priority
        attMap[d.student_uid] = { attendance_id: doc.id, status: "od", marked_by: "od_approval" };
      }
    });

    // Sources 2 & 3 — live lecture flows for sessions on this date only
    const matchingSessionIds  = allSessions.filter((s) => s.date === date).map((s) => s.sessionId);
    const hasLecture          = matchingSessionIds.length > 0;

    if (matchingSessionIds.length) {
      const [sessSnaps, recSnaps] = await Promise.all([
        inChunks(matchingSessionIds, (c) => db.collection("attendance_sessions").where("lecture_session_id", "in", c)),
        inChunks(matchingSessionIds, (c) => db.collection("attendance_records").where("lecture_session_id", "in", c)),
      ]);

      sessSnaps.forEach((doc) => {
        (doc.data().present_students || []).forEach((uid) => {
          if (!attMap[uid]) attMap[uid] = { attendance_id: doc.id, status: "present", marked_by: "auto" };
        });
      });

      recSnaps.forEach((doc) => {
        const d = doc.data();
        if (d.source === "manual" || d.source === "od") return;
        if (!attMap[d.student_uid])
          attMap[d.student_uid] = { attendance_id: doc.id, status: d.status || "present", marked_by: d.method || "auto" };
      });
    }

    const todays = allSessions.filter((x) => x.date === date);
    const result = students.map((s) => ({
      ...s,
      status: (hasLecture && sessionsForDivision(todays, s.division_id || null).length > 0) ? (attMap[s.uid]?.status || "absent") : "no_class",
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
router.get("/student/:student_uid/full", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { student_uid } = req.params;
    const { teacher_id, subject_id } = req.query;
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    if (!(await ownsSubject(teacher_id, subject_id)))
      return res.status(403).json({ success: false, error: "Access denied" });

    if (typeof student_uid !== "string" || student_uid.includes("/"))
      return res.status(404).json({ success: false, error: "Student not found" });
    const studentDoc = await db.collection("students").doc(student_uid).get();
    if (!studentDoc.exists)
      return res.status(404).json({ success: false, error: "Student not found" });

    const s = studentDoc.data();
    const profile = {
      uid: s.uid,
      name: nameOf(s),
      email: s.email || null,
      roll_no: s.roll_no || null,
      course_name: s.course_name || null,
      semester: s.semester || null,
      college_name: s.college_name || null,
    };

    const [quizzesSnap, assignmentsSnap, sessions] = await Promise.all([
      db.collection("quizzes").where("subject_id", "==", subject_id).where("teacher_id", "==", teacher_id).select("quiz_id").get(),
      db.collection("assignments").where("subject_id", "==", subject_id).where("teacher_id", "==", teacher_id).select("assignment_id").get(),
      getLectureSessionsForSubject(subject_id).then((all) => sessionsForDivision(all, s.division_id || null)),
    ]);
    const sessionIds = sessions.map((x) => x.sessionId);

    const quizIds       = quizzesSnap.docs.map((d) => d.data().quiz_id);
    const assignmentIds = assignmentsSnap.docs.map((d) => d.data().assignment_id);

    const [quizSubsSnap, assSubsSnap, attRecords] = await Promise.all([
      quizIds.length
        ? db.collection("quiz_submissions").where("student_uid", "==", student_uid).where("quiz_id", "in", quizIds.slice(0, 30)).get()
        : Promise.resolve({ docs: [] }),
      assignmentIds.length
        ? db.collection("submissions").where("student_uid", "==", student_uid).where("assignment_id", "in", assignmentIds.slice(0, 30)).get()
        : Promise.resolve({ docs: [] }),
      buildAttendanceRecords(student_uid, subject_id, sessionIds, sessions),
    ]);

    const quizSubs    = quizSubsSnap.docs.map((d) => d.data());
    const quizAvgPct  = quizSubs.length ? parseFloat((quizSubs.reduce((s, q) => s + (q.percentage || 0), 0) / quizSubs.length).toFixed(2)) : null;

    const assSubs     = assSubsSnap.docs.map((d) => d.data());
    const gradedSubs  = assSubs.filter((s) => s.status === "graded");
    const assAvgMarks = gradedSubs.length ? parseFloat((gradedSubs.reduce((s, a) => s + (a.marks_obtained || 0), 0) / gradedSubs.length).toFixed(2)) : null;

    const present    = attRecords.filter(isPresentish).length;
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
//
// For a class of N students the original read the attendance data N times over
// (one full set of queries per student). Everything is now read ONCE for the whole
// class and sorted into students in memory; the numbers are identical.
// ─────────────────────────────────────────────────────────────────────────────
async function buildClassReport(teacher_id, subject_id, divisionFilter = "") {
  const rawStudents = await enrolledStudents(subject_id);

  let students = rawStudents.map((d) => ({
    uid: d.uid,
    name: nameOf(d),
    email: d.email || null,
    roll_no: d.roll_no || null,
    course_name: d.course_name || null,
    semester: d.semester || null,
    division_id: d.division_id || null,
    division: d.division || null,
  }));
  // the divisions that actually sit in this subject (for the filter chips)
  const divisions = [...new Map(students.filter((x) => x.division_id).map((x) => [x.division_id, { division_id: x.division_id, name: x.division }])).values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  if (divisionFilter === "none") students = students.filter((x) => !x.division_id);
  else if (divisionFilter) students = students.filter((x) => x.division_id === divisionFilter);

  if (!students.length) {
    return {
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
      divisions,
      students: [],
    };
  }

  // ── Everything the report needs, fetched together ──────────────────────
  const [sessions, quizzesSnap, assignmentsSnap, manualSnap, odSnap] = await Promise.all([
    getLectureSessionsForSubject(subject_id),
    db.collection("quizzes").where("subject_id", "==", subject_id).where("teacher_id", "==", teacher_id).select("quiz_id").get(),
    db.collection("assignments").where("subject_id", "==", subject_id).where("teacher_id", "==", teacher_id).select("assignment_id").get(),
    db.collection("attendance_records").where("subject_id", "==", subject_id).where("source", "==", "manual").get(),
    db.collection("attendance_records").where("subject_id", "==", subject_id).where("source", "==", "od").get(),
  ]);

  const sessionIds = sessions.map((s) => s.sessionId);
  const totalLectures = sessionIds.length;
  const quizzes = quizzesSnap.docs.map((d) => ({ quiz_id: d.data().quiz_id }));
  const totalQuizzes = quizzes.length;
  const assignments = assignmentsSnap.docs.map((d) => ({ assignment_id: d.data().assignment_id }));
  const totalAssignments = assignments.length;

  const sessionDateMap = {};
  for (const s of sessions) sessionDateMap[s.sessionId] = s.date;

  const [attSessions, recordDocs, quizSubDocs, assSubDocs] = await Promise.all([
    getAttendanceSessions(subject_id, sessionIds),
    sessionIds.length
      ? inChunks(sessionIds, (c) =>
          db.collection("attendance_records").where("lecture_session_id", "in", c).select(...RECORD_FIELDS))
      : [],
    quizzes.length
      ? inChunks(quizzes.map((q) => q.quiz_id), (c) =>
          db.collection("quiz_submissions").where("quiz_id", "in", c).select("quiz_id", "student_uid", "percentage"))
      : [],
    assignments.length
      ? inChunks(assignments.map((a) => a.assignment_id), (c) =>
          db.collection("submissions").where("assignment_id", "in", c).select("assignment_id", "student_uid", "status", "marks_obtained"))
      : [],
  ]);

  // ── Sort the shared data into per-student piles ────────────────────────
  const pile = () => new Map();
  const manualBy = pile(), odBy = pile(), recBy = pile();
  const push = (map, uid, v) => { let a = map.get(uid); if (!a) map.set(uid, (a = [])); a.push(v); };
  manualSnap.docs.forEach((d) => push(manualBy, d.data().student_uid, d));
  odSnap.docs.forEach((d) => push(odBy, d.data().student_uid, d));
  recordDocs.forEach((d) => push(recBy, d.data().student_uid, d));

  const quizSubMap = {}; // uid → quiz_id → sub
  quizSubDocs.forEach((doc) => {
    const d = doc.data();
    if (!quizSubMap[d.student_uid]) quizSubMap[d.student_uid] = {};
    quizSubMap[d.student_uid][d.quiz_id] = d;
  });
  const assSubMap = {}; // uid → assignment_id → sub
  assSubDocs.forEach((doc) => {
    const d = doc.data();
    if (!assSubMap[d.student_uid]) assSubMap[d.student_uid] = {};
    assSubMap[d.student_uid][d.assignment_id] = d;
  });

  const heldCache = new Map();
  const held_of = (div) => {
    const k = div || "";
    if (!heldCache.has(k)) heldCache.set(k, sessionsForDivision(sessions, div || null).length);
    return heldCache.get(k);
  };

  const studentResults = students.map((s) => {
    // ── Attendance ──────────────────────────────────────────────────
    const attRecords = sessionIds.length
      ? sourceRows(manualBy.get(s.uid) || [], odBy.get(s.uid) || [], attSessions, recBy.get(s.uid) || [], sessionDateMap, s.uid)
      : sourceRows(manualBy.get(s.uid) || [], odBy.get(s.uid) || [], [], [], {}, s.uid);
    const present = attRecords.filter(isPresentish).length;
    const held = held_of(s.division_id);                    // lectures meant for this student's division
    const absent = Math.max(0, held - present);
    const late = attRecords.filter((r) => r.status === "late").length;
    const attendance_pct =
      held > 0 ? parseFloat((Math.min(100, (present / held) * 100)).toFixed(1)) : null;

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
  });

  // ── Class-level aggregates ─────────────────────────────────────────────
  const withAtt = studentResults.filter((s) => s.attendance_pct !== null);
  const withQuiz = studentResults.filter((s) => s.quiz_avg_pct !== null);
  const withAss = studentResults.filter((s) => s.assignment_avg_marks !== null);

  const avg_attendance_pct =
    withAtt.length
      ? parseFloat((withAtt.reduce((a, s) => a + (s.attendance_pct || 0), 0) / withAtt.length).toFixed(1))
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

  return {
    success: true,
    class_summary: {
      total_students: students.length,
      total_lectures: divisionFilter && divisionFilter !== "none" ? held_of(divisionFilter) : totalLectures,
      total_quizzes: totalQuizzes,
      total_assignments: totalAssignments,
      avg_attendance_pct,
      avg_quiz_pct,
      avg_assignment_marks,
      below_75_attendance,
    },
    divisions,
    students: studentResults,
  };
}

router.get("/class", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { teacher_id, subject_id } = req.query;
    const division = typeof req.query.division_id === "string" ? req.query.division_id.slice(0, 80) : "";
    if (!teacher_id || !subject_id)
      return res.status(400).json({ success: false, error: "teacher_id and subject_id are required" });

    // ── Ownership check ────────────────────────────────────────────────────
    if (!(await ownsSubject(teacher_id, subject_id)))
      return res.status(403).json({ success: false, error: "Access denied" });

    // Refreshing / several teachers asking for the same class within a few seconds share one computation.
    const report = await classCache.memo(`${teacher_id}|${subject_id}|${division}`, 5_000, () => buildClassReport(teacher_id, subject_id, division));
    return res.json(report);
  } catch (e) {
    console.error("CLASS REPORT ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

module.exports = router;