/**
 * routes/web/teacher.routes.js
 * Mount: app.use("/api/web/teacher", require("./routes/web/teacher.routes"));
 *
 * Identity: all routes accept ?uid= (Firebase Auth UID).
 * Backend resolves teacher Firestore doc ID internally — client never needs to pass teacher_id.
 *
 * Collections used:
 *   teachers        — user_id == uid → doc.id is the authoritative teacher_id
 *   subjects        — teacher_assigned == teacher_id
 *   lectures        — teacher_id == teacher_id, day == todayDay
 *   lecture_sessions — lecture_id in lectureIds, status == "completed"
 *   attendance_sessions — lecture_session_id in sessionIds
 *   attendance_records  — student_uid, subject_id, source
 *   od_requests     — teacher_id == teacher_id
 *   quizzes         — subject_id, teacher_id
 *   assignments     — subject_id, teacher_id
 *   quiz_submissions, submissions — for per-student stats
 *   lecture_assignments — assigned_teacher_id == teacher_id, status == "pending"
 *   cancelled_lectures  — teacher_id, date
 *   lecture_sessions (temp) — teacher_id, is_temporary, date
 */

const express = require("express");
const router  = express.Router();
const { admin, db } = require("../../config/firebase");
const { guard, allow, fromAny, fromQuery } = require("../../middleware/auth");
const { TTLCache } = require("../../utils/cache");
const { chunk, commitInBatches } = require("../../utils/firestore");
const { assignmentStudentsHandler } = require("../../utils/assignmentStudents");

// ─── Timezone helpers (IST = UTC+5:30) ───────────────────────────────────────
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_NAMES     = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function nowIST()           { return new Date(Date.now() + IST_OFFSET_MS); }
function istDateStr(d)      { return d.toISOString().slice(0, 10); }   // d is already IST Date
function dayName(dateStr)   { return DAY_NAMES[new Date(dateStr + "T06:30:00Z").getUTCDay()]; }
function toMinutes(t)       { if (!t) return 0; const [h,m] = t.split(":").map(Number); return h*60+m; }
function toISO(val)         {
  if (!val) return null;
  if (typeof val?.toDate === "function") return val.toDate().toISOString();
  if (val instanceof Date)  return val.toISOString();
  return String(val);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Same wording as before for expected errors; anything unexpected no longer leaks internal text.
function sendError(res, err, label) {
  if (err && err.status) return res.status(err.status).json({ success: false, error: err.message });
  console.error(label, err);
  return res.status(500).json({ success: false, error: "Internal server error" });
}

// ─── Small caches ────────────────────────────────────────────────────────────
const teacherCache    = new TTLCache({ max: 5000, ttlMs: 60_000 });  // uid -> { teacher_id, data, aishe_code } | null
const trimIndexCache  = new TTLCache({ max: 2,    ttlMs: 60_000 });  // trimmed user_id -> doc (whitespace fallback)
const subjectsCache   = new TTLCache({ max: 3000, ttlMs: 15_000 });  // teacher_id -> subjects[]
const dayLecturesCache = new TTLCache({ max: 6000, ttlMs: 15_000 }); // teacher|aishe|day -> lectures
const courseNameCache = new TTLCache({ max: 2000, ttlMs: 300_000 }); // course_id -> name | null
const classCache      = new TTLCache({ max: 300,  ttlMs: 5_000 });   // "teacher|subject" -> report

// ─── Resolve teacher from Firebase Auth UID ───────────────────────────────────
// Mirrors the exact logic in auth_routes.js login.
// The result is remembered for a minute: the dashboard, schedule and timetable each call this,
// and the "not found" fallback used to scan the whole teachers collection on every call.
async function resolveTeacher(uid) {
  if (!uid || typeof uid !== "string") throw Object.assign(new Error("uid is required"), { status: 400 });

  const found = await teacherCache.memo(uid, 60_000, async () => {
    // Try direct query first
    const snap1 = await db.collection("teachers").where("user_id", "==", uid).limit(1).get();
    if (!snap1.empty) {
      const doc = snap1.docs[0];
      return { teacher_id: doc.id, data: doc.data(), aishe_code: doc.data().aishe_code };
    }

    // Fallback: scan and trim-match (handles whitespace issues) - the scan result is shared/cached
    const index = await trimIndexCache.memo("all", 60_000, async () => {
      const allSnap = await db.collection("teachers").where("aishe_code", "!=", "").get();
      const m = new Map();
      for (const d of allSnap.docs) {
        const key = (d.data().user_id || "").trim();
        if (!m.has(key)) m.set(key, d);
      }
      return m;
    });
    const matched = index.get(uid.trim());
    if (matched) {
      return { teacher_id: matched.id, data: matched.data(), aishe_code: matched.data().aishe_code };
    }
    return null;
  }, { cacheNull: true });

  if (!found) throw Object.assign(new Error("Teacher profile not found"), { status: 404 });
  return found;
}

function subjectsOf(teacher_id) {
  return subjectsCache.memo(teacher_id, 15_000, async () => {
    const snap = await db.collection("subjects").where("teacher_assigned", "==", teacher_id).get();
    return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  });
}

function lecturesOnDay(teacher_id, aishe_code, day) {
  return dayLecturesCache.memo(`${teacher_id}|${aishe_code}|${day}`, 15_000, async () => {
    const snap = await db.collection("lectures")
      .where("teacher_id", "==", teacher_id)
      .where("aishe_code", "==", aishe_code)
      .where("day", "==", day)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  });
}

/** swap-assigned temporary sessions -> lecture objects (all parent lectures read in ONE batch) */
async function enrichTempSessions(tempDocs) {
  const sessions = tempDocs.map((d) => d.data()).filter((s) => s.lecture_id);
  const ids = [...new Set(sessions.map((s) => s.lecture_id))];
  const byId = new Map();
  for (const part of chunk(ids, 200)) {
    const refs = part.map((id) => db.collection("lectures").doc(id));
    for (const snap of await db.getAll(...refs)) if (snap.exists) byId.set(snap.id, snap);
  }
  return sessions.map((s) => {
    const lDoc = byId.get(s.lecture_id);
    if (!lDoc) return null;
    const l = lDoc.data();
    return {
      id:           lDoc.id,
      ...l,
      teacher_id:   s.teacher_id,
      start_time:   s.start_time || l.start_time,
      end_time:     s.end_time   || l.end_time,
      is_temporary: true,
    };
  }).filter(Boolean);
}

const odSort = (a, b) => {
  if (a.status === "pending" && b.status !== "pending") return -1;
  if (b.status === "pending" && a.status !== "pending") return  1;
  return new Date(b.created_at || 0) - new Date(a.created_at || 0);
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/web/teacher/dashboard?uid=
//
// One request returns:
//  - subjects[]         (all subjects where teacher_assigned == teacher_id)
//  - today schedule     (lectures + temp sessions, cancelled filtered, live/next tagged)
//  - od { summary, requests }
//  - swaps { pending_count, requests }
//  - profile            (teacher name, designation, departments)
//
// Collections: teachers, subjects, lectures, lecture_sessions(temp),
//              cancelled_lectures, od_requests, lecture_assignments
// ─────────────────────────────────────────────────────────────────────────────
router.get("/dashboard", guard.self(fromAny("uid")), async (req, res) => {
  try {
    const uid = req.query.uid;
    const { teacher_id, data: teacherData, aishe_code } = await resolveTeacher(uid);

    // IST "today"
    const ist           = nowIST();
    const todayStr      = istDateStr(ist);
    const todayDay      = dayName(todayStr);
    const nowMin        = ist.getUTCHours() * 60 + ist.getUTCMinutes();

    // Fire all queries in parallel
    const [
      subjectDocs,
      regularRaw,
      cancelledSnap,
      tempSessionsSnap,
      odSnap,
      swapSnap,
    ] = await Promise.all([
      // subjects where this teacher is assigned (rarely changes -> 15 s memory)
      subjectsOf(teacher_id),

      // regular lectures scheduled today (rarely changes -> 15 s memory)
      lecturesOnDay(teacher_id, aishe_code, todayDay),

      // cancelled lecture IDs for today
      db.collection("cancelled_lectures")
        .where("teacher_id", "==", teacher_id)
        .where("date", "==", todayStr)
        .get(),

      // temp (swap-assigned) sessions for today
      db.collection("lecture_sessions")
        .where("teacher_id",   "==", teacher_id)
        .where("is_temporary", "==", true)
        .where("date",         "==", todayStr)
        .get(),

      // all OD requests for this teacher
      db.collection("od_requests")
        .where("teacher_id", "==", teacher_id)
        .get(),

      // pending lecture swap assignments (inbox)
      db.collection("lecture_assignments")
        .where("assigned_teacher_id", "==", teacher_id)
        .where("status",              "==", "pending")
        .get(),
    ]);

    // ── Subjects ─────────────────────────────────────────────────────────────
    // Spread full doc so no field is ever lost, then add doc.id as subject_id
    const subjects = subjectDocs.map(({ id, data }) => ({
      ...data,
      subject_id: id,
      // ensure aishe_code fallback if not on subject doc
      aishe_code: data.aishe_code || aishe_code,
    }));

    // ── Today's schedule ──────────────────────────────────────────────────────
    const cancelledIds = new Set(
      cancelledSnap.docs.map((d) => d.data().lecture_id).filter(Boolean)
    );

    const regularLectures = regularRaw.filter((l) => !cancelledIds.has(l.id));

    // Enrich temp sessions by reading parent lecture docs (one batched read)
    const tempLectures = await enrichTempSessions(tempSessionsSnap.docs);

    const existingIds = new Set(regularLectures.map((l) => l.id));
    const allLectures = [
      ...regularLectures,
      ...tempLectures.filter((l) => !existingIds.has(l.id)),
    ].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));

    let ongoingLecture = null;
    let nextLecture    = null;
    for (const lec of allLectures) {
      const s = toMinutes(lec.start_time);
      const e = toMinutes(lec.end_time);
      if (nowMin >= s && nowMin < e && !ongoingLecture) ongoingLecture = lec;
      else if (nowMin < s && !nextLecture)              nextLecture    = lec;
    }

    // ── OD ────────────────────────────────────────────────────────────────────
    const odRequests = odSnap.docs.map((doc) => {
      const d = doc.data();
      return { ...d, created_at: toISO(d.created_at), updated_at: toISO(d.updated_at) };
    }).sort(odSort);

    const odSummary = {
      pending:  odRequests.filter((r) => r.status === "pending").length,
      approved: odRequests.filter((r) => r.status === "approved").length,
      rejected: odRequests.filter((r) => r.status === "rejected").length,
    };

    // ── Swaps ─────────────────────────────────────────────────────────────────
    const now = Date.now();
    const pendingSwaps = swapSnap.docs
      .map((doc) => {
        const d = doc.data();
        return { assignment_id: doc.id, ...d, expires_at: toISO(d.expires_at), created_at: toISO(d.created_at) };
      })
      .filter((s) => !s.expires_at || new Date(s.expires_at).getTime() > now);

    return res.json({
      success:    true,
      teacher_id,
      profile: {
        first_name:  teacherData.first_name,
        last_name:   teacherData.last_name,
        designation: teacherData.designation,
        departments: teacherData.departments || [],
        aishe_code,
      },
      subjects,
      today: {
        date:           todayStr,
        day:            todayDay,
        allLectures,
        ongoingLecture,
        nextLecture,
      },
      od: {
        summary:  odSummary,
        requests: odRequests,
      },
      swaps: {
        pending_count: pendingSwaps.length,
        requests:      pendingSwaps,
      },
    });

  } catch (err) {
    return sendError(res, err, "TEACHER DASHBOARD ERROR:");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/web/teacher/class-report?uid=&subject_id=
//
// Full class stats + per-student breakdown for one subject.
//
// Ownership check: subjects.teacher_assigned must equal teacher_id.
//
// Collections: subjects, students, lecture_sessions, lectures,
//              attendance_sessions, attendance_records,
//              quizzes, quiz_submissions, assignments, submissions
//
// Attendance rule (unchanged): a student is "present" for a DATE when any of
//   A) attendance_sessions.present_students of that day's lecture session,
//   B) attendance_records of that session with status present/late/od,
//   C) an OD record (source "od") of that date,
//   D) a manual record (source "manual") of that date - manual "absent" removes the date
// says so. (The original also ran a first, unused attendance pass that read every
// attendance document twice more; it is gone, the numbers never depended on it.)
// ─────────────────────────────────────────────────────────────────────────────
async function buildClassReport(teacher_id, subject_id, subjData) {
  const CHUNK = 30;
  const inChunks = async (values, build) =>
    (await Promise.all(chunk(values, CHUNK).map((c) => build(c).get()))).flatMap((s) => s.docs);

  // Fetch everything in parallel
  const [studentsSnap, lecturesSnap, quizzesSnap, assignmentsSnap] = await Promise.all([
    // enrolled students — students.enrolled_subjects array-contains subject_id
    db.collection("students")
      .where("enrolled_subjects", "array-contains", subject_id)
      .where("approval_status", "==", "approved")
      .get(),
    // lectures for this subject — to find lecture_sessions
    db.collection("lectures")
      .where("subject_id", "==", subject_id)
      .select()
      .get(),
    // quizzes for this subject
    db.collection("quizzes")
      .where("subject_id",  "==", subject_id)
      .where("teacher_id",  "==", teacher_id)
      .select("quiz_id")
      .get(),
    // assignments for this subject
    db.collection("assignments")
      .where("subject_id",  "==", subject_id)
      .where("teacher_id",  "==", teacher_id)
      .select("assignment_id")
      .get(),
  ]);

  const students    = studentsSnap.docs.map((d) => {
    const data = d.data();
    return {
      uid:         data.uid || d.id,
      name:        data.name || `${data.first_name || ""} ${data.last_name || ""}`.trim(),
      email:       data.email    || null,
      roll_no:     data.roll_no  || null,
      course_name: data.course_name || null,
      semester:    data.semester || null,
    };
  });

  const lectureIds  = lecturesSnap.docs.map((d) => d.id);
  const quizzes     = quizzesSnap.docs.map((d) => ({ quiz_id: d.data().quiz_id || d.id }));
  const assignments = assignmentsSnap.docs.map((d) => ({ assignment_id: d.data().assignment_id || d.id }));

  // Empty class
  if (students.length === 0) {
    return {
      success: true,
      teacher_id,
      subject_id,
      subject_name: subjData.subject_name,
      class_summary: {
        total_students: 0, total_lectures: 0,
        total_quizzes: quizzes.length, total_assignments: assignments.length,
        avg_attendance_pct: null, avg_quiz_pct: null,
        avg_assignment_marks: null, below_75_attendance: 0,
      },
      students: [],
    };
  }

  // ── Completed lecture sessions (id + date in the same read) ───────────────
  const sessionDocs = lectureIds.length
    ? await inChunks(lectureIds, (c) =>
        db.collection("lecture_sessions")
          .where("lecture_id", "in", c)
          .where("status", "==", "completed")
          .select("date", "started_at"))
    : [];
  const sessionIds = sessionDocs.map((d) => d.id);
  const totalLectures = sessionIds.length;

  const sessionDateMap = {};
  for (const doc of sessionDocs) {
    const d = doc.data();
    sessionDateMap[doc.id] = d.date || toISO(d.started_at)?.split("T")[0] || doc.id;
  }

  // ── Everything else, all at once ──────────────────────────────────────────
  const [attSessDocs, attRecDocs, quizSubDocs, assSubDocs, odAttSnap, manualAttSnap] = await Promise.all([
    sessionIds.length
      ? inChunks(sessionIds, (c) =>
          db.collection("attendance_sessions").where("lecture_session_id", "in", c)
            .select("lecture_session_id", "present_students"))
      : [],
    sessionIds.length
      ? inChunks(sessionIds, (c) =>
          db.collection("attendance_records").where("lecture_session_id", "in", c)
            .select("lecture_session_id", "student_uid", "status", "date"))
      : [],
    quizzes.length
      ? inChunks(quizzes.map((q) => q.quiz_id), (c) =>
          db.collection("quiz_submissions").where("quiz_id", "in", c)
            .select("quiz_id", "student_uid", "percentage"))
      : [],
    assignments.length
      ? inChunks(assignments.map((a) => a.assignment_id), (c) =>
          db.collection("submissions").where("assignment_id", "in", c)
            .select("assignment_id", "student_uid", "status", "marks_obtained"))
      : [],
    // Source C: OD attendance_records (no lecture_session_id, source == "od")
    db.collection("attendance_records")
      .where("subject_id", "==", subject_id)
      .where("source",     "==", "od")
      .select("student_uid", "date", "created_at")
      .get(),
    // Source D: manual attendance_records (source == "manual")
    db.collection("attendance_records")
      .where("subject_id", "==", subject_id)
      .where("source",     "==", "manual")
      .select("student_uid", "date", "status", "marked_at")
      .get(),
  ]);

  // quizSubMap:  uid → quiz_id → submission
  // assSubMap:   uid → assignment_id → submission
  const quizSubMap = {};
  const assSubMap  = {};
  quizSubDocs.forEach((doc) => {
    const d = doc.data();
    if (!quizSubMap[d.student_uid]) quizSubMap[d.student_uid] = {};
    quizSubMap[d.student_uid][d.quiz_id] = d;
  });
  assSubDocs.forEach((doc) => {
    const d = doc.data();
    if (!assSubMap[d.student_uid]) assSubMap[d.student_uid] = {};
    assSubMap[d.student_uid][d.assignment_id] = d;
  });

  // attCountMap: uid → Set of counted dates (avoids double counting)
  const attCountMap = Object.create(null);
  students.forEach((s) => { attCountMap[s.uid] = new Set(); });
  const tracked = (uid) => Object.prototype.hasOwnProperty.call(attCountMap, uid);

  // Source A: attendance_sessions.present_students
  attSessDocs.forEach((doc) => {
    const d    = doc.data();
    const date = sessionDateMap[d.lecture_session_id] || doc.id;
    (d.present_students || []).forEach((uid) => {
      if (tracked(uid)) attCountMap[uid].add(date);
    });
  });

  // Source B: attendance_records with lecture_session_id
  attRecDocs.forEach((doc) => {
    const d    = doc.data();
    const uid  = d.student_uid;
    const st   = d.status;
    const date = sessionDateMap[d.lecture_session_id] || d.date || doc.id;
    if (tracked(uid) && (st === "present" || st === "late" || st === "od")) {
      attCountMap[uid].add(date);
    }
  });

  odAttSnap.docs.forEach((doc) => {
    const d    = doc.data();
    const uid  = d.student_uid;
    const date = d.date || toISO(d.created_at)?.split("T")[0];
    if (date && tracked(uid)) attCountMap[uid].add(date);
  });

  manualAttSnap.docs.forEach((doc) => {
    const d    = doc.data();
    const uid  = d.student_uid;
    const date = d.date || toISO(d.marked_at)?.split("T")[0];
    if (date && tracked(uid)) {
      if (d.status === "present" || d.status === "late" || d.status === "od") {
        attCountMap[uid].add(date);
      } else if (d.status === "absent") {
        attCountMap[uid].delete(date); // manual absent overrides
      }
    }
  });

  // ── Per-student stats ─────────────────────────────────────────────────────
  const studentResults = students.map((s) => {
    const uid     = s.uid;
    const present = attCountMap[uid]?.size ?? 0;
    const attendance_pct = totalLectures > 0
      ? parseFloat(((present / totalLectures) * 100).toFixed(1))
      : null;

    // Quiz stats
    const myQuizSubs      = quizSubMap[uid] || {};
    const attempted       = quizzes.filter((q) => myQuizSubs[q.quiz_id]);
    const quiz_avg_pct    = attempted.length > 0
      ? parseFloat((attempted.reduce((acc, q) => acc + (myQuizSubs[q.quiz_id]?.percentage || 0), 0) / attempted.length).toFixed(1))
      : null;

    // Assignment stats
    const myAssSubs       = assSubMap[uid] || {};
    const graded          = assignments.filter((a) => myAssSubs[a.assignment_id]?.status === "graded");
    const assignment_avg_marks = graded.length > 0
      ? parseFloat((graded.reduce((acc, a) => acc + (myAssSubs[a.assignment_id]?.marks_obtained || 0), 0) / graded.length).toFixed(1))
      : null;

    return {
      uid,
      name:                 s.name,
      roll_no:              s.roll_no,
      email:                s.email,
      course_name:          s.course_name,
      semester:             s.semester,
      present,
      absent:               Math.max(0, totalLectures - present),
      attendance_pct,
      quiz_attempted:       attempted.length,
      quiz_avg_pct,
      assignment_submitted: Object.keys(myAssSubs).length,
      assignment_avg_marks,
    };
  });

  // ── Class aggregates ──────────────────────────────────────────────────────
  const withAtt  = studentResults.filter((s) => s.attendance_pct !== null);
  const withQuiz = studentResults.filter((s) => s.quiz_avg_pct !== null);
  const withAss  = studentResults.filter((s) => s.assignment_avg_marks !== null);
  const avg      = (arr, key) => arr.length
    ? parseFloat((arr.reduce((a, s) => a + (s[key] || 0), 0) / arr.length).toFixed(1))
    : null;

  return {
    success:      true,
    teacher_id,
    subject_id,
    subject_name: subjData.subject_name,
    class_summary: {
      total_students:       students.length,
      total_lectures:       totalLectures,
      total_quizzes:        quizzes.length,
      total_assignments:    assignments.length,
      avg_attendance_pct:   avg(withAtt,  "attendance_pct"),
      avg_quiz_pct:         avg(withQuiz, "quiz_avg_pct"),
      avg_assignment_marks: avg(withAss,  "assignment_avg_marks"),
      below_75_attendance:  studentResults.filter((s) => s.attendance_pct !== null && s.attendance_pct < 75).length,
    },
    students: studentResults,
  };
}

router.get("/class-report", guard.self(fromAny("uid")), async (req, res) => {
  try {
    const { uid, subject_id } = req.query;
    if (!subject_id) return res.status(400).json({ success: false, error: "subject_id is required" });

    const { teacher_id } = await resolveTeacher(uid);

    // Ownership check
    if (typeof subject_id !== "string" || subject_id.includes("/"))
      return res.status(404).json({ success: false, error: "Subject not found" });
    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists)
      return res.status(404).json({ success: false, error: "Subject not found" });

    const subjData = subjectDoc.data();
    if (subjData.teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied — you are not assigned to this subject" });

    // Refresh-happy users / the same teacher on two tabs share one computation for a few seconds.
    const report = await classCache.memo(`${teacher_id}|${subject_id}`, 5_000, () => buildClassReport(teacher_id, subject_id, subjData));
    return res.json(report);

  } catch (err) {
    return sendError(res, err, "TEACHER CLASS-REPORT ERROR:");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/web/teacher/od?uid=&status=
//
// All OD requests for this teacher.
// Optional ?status=pending|approved|rejected
// ─────────────────────────────────────────────────────────────────────────────
router.get("/od", guard.self(fromAny("uid")), async (req, res) => {
  try {
    const { uid, status } = req.query;
    const { teacher_id } = await resolveTeacher(uid);

    let q = db.collection("od_requests").where("teacher_id", "==", teacher_id);
    if (status && typeof status === "string") q = q.where("status", "==", status);

    const snap = await q.get();
    const requests = snap.docs.map((doc) => {
      const d = doc.data();
      return { ...d, created_at: toISO(d.created_at), updated_at: toISO(d.updated_at) };
    }).sort(odSort);

    return res.json({
      success:  true,
      teacher_id,
      summary: {
        pending:  requests.filter((r) => r.status === "pending").length,
        approved: requests.filter((r) => r.status === "approved").length,
        rejected: requests.filter((r) => r.status === "rejected").length,
      },
      requests,
    });

  } catch (err) {
    return sendError(res, err, "TEACHER OD ERROR:");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/web/teacher/od/:od_id/review
//
// Approve or reject an OD request.
// Body: { uid, action: "approved"|"rejected", teacher_note? }
//
// On approval: writes attendance_records with status "od" for each weekday
// in the OD date range — mirrors od_routes.js exactly.
//
// The status check and the writes now happen in ONE transaction: two clicks /
// two tabs at the same moment can no longer both "approve" the same request.
// ─────────────────────────────────────────────────────────────────────────────
router.put("/od/:od_id/review", guard.self(fromAny("uid")), async (req, res) => {
  try {
    const { od_id }                     = req.params;
    const { uid, action, teacher_note } = req.body;

    if (!["approved", "rejected"].includes(action))
      return res.status(400).json({ success: false, error: "action must be 'approved' or 'rejected'" });

    const { teacher_id } = await resolveTeacher(uid);

    if (typeof od_id !== "string" || !od_id || od_id.includes("/"))
      return res.status(404).json({ success: false, error: "OD request not found" });

    const odRef = db.collection("od_requests").doc(od_id);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const note = typeof teacher_note === "string" ? (teacher_note.trim().slice(0, 1000) || null) : null;

    let overflow = null;

    const failure = await db.runTransaction(async (t) => {
      overflow = null;
      const odDoc = await t.get(odRef);

      if (!odDoc.exists) return { code: 404, error: "OD request not found" };

      const od = odDoc.data();

      if (od.teacher_id !== teacher_id) return { code: 403, error: "Not authorised to review this request" };
      if (od.status !== "pending")      return { code: 400, error: `OD is already ${od.status}` };

      t.update(odRef, { status: action, teacher_note: note, updated_at: now });

      // On approval: write OD attendance records for each weekday in the date range
      if (action === "approved") {
        const recs = [];
        const from  = new Date(od.from_date + "T06:30:00Z");
        const to    = new Date(od.to_date   + "T06:30:00Z");

        for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
          if (d.getUTCDay() === 0) continue; // skip Sundays
          const ymd    = d.toISOString().slice(0, 10);
          const recId  = `${od.student_uid}_${od.subject_id}_${ymd}`;
          recs.push({
            ref: db.collection("attendance_records").doc(recId),
            data: {
              attendance_id: recId,
              student_uid:   od.student_uid,
              subject_id:    od.subject_id,
              teacher_id:    od.teacher_id,
              date:          ymd,
              status:        "od",
              method:        "od",
              source:        "od",
              od_id,
              note:          `OD approved — ${od.reason}`,
              created_at:    now,
              updated_at:    now,
            },
          });
        }
        if (recs.length <= 450) recs.forEach((r) => t.set(r.ref, r.data, { merge: true }));
        else overflow = recs;
      }
      return null;
    });

    if (failure) return res.status(failure.code).json({ success: false, error: failure.error });
    if (overflow) await commitInBatches(overflow.map((r) => (b) => b.set(r.ref, r.data, { merge: true })));

    return res.json({
      success: true,
      message: action === "approved" ? "OD approved and attendance marked" : "OD rejected",
    });

  } catch (err) {
    return sendError(res, err, "TEACHER OD REVIEW ERROR:");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/web/teacher/schedule?uid=&date=YYYY-MM-DD
//
// Schedule for a specific date (defaults to today).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/schedule", guard.self(fromAny("uid")), async (req, res) => {
  try {
    const { uid, date } = req.query;
    const { teacher_id, aishe_code } = await resolveTeacher(uid);

    const targetDate = date || istDateStr(nowIST());
    if (typeof targetDate !== "string" || !YMD.test(targetDate))
      return res.status(400).json({ success: false, error: "date must be YYYY-MM-DD" });
    const targetDay  = dayName(targetDate);

    const [regularRaw, cancelledSnap, tempSnap] = await Promise.all([
      lecturesOnDay(teacher_id, aishe_code, targetDay),
      db.collection("cancelled_lectures")
        .where("teacher_id", "==", teacher_id)
        .where("date", "==", targetDate)
        .get(),
      db.collection("lecture_sessions")
        .where("teacher_id",   "==", teacher_id)
        .where("is_temporary", "==", true)
        .where("date",         "==", targetDate)
        .get(),
    ]);

    const cancelledIds = new Set(cancelledSnap.docs.map((d) => d.data().lecture_id).filter(Boolean));

    const regular = regularRaw.filter((l) => !cancelledIds.has(l.id));
    const temps = await enrichTempSessions(tempSnap.docs);

    const existingIds = new Set(regular.map((l) => l.id));
    const all = [
      ...regular,
      ...temps.filter((l) => !existingIds.has(l.id)),
    ].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));

    return res.json({ success: true, date: targetDate, day: targetDay, lectures: all });

  } catch (err) {
    return sendError(res, err, "TEACHER SCHEDULE ERROR:");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/web/teacher/timetable?uid=
//
// Returns ALL recurring lectures for this teacher across all days.
// Groups by day so the frontend can render a weekly timetable grid.
//
// Response:
// {
//   teacher_id, aishe_code,
//   lectures: [ { id, subject_name, subject_code, course_id, day, start_time,
//                 end_time, room, subject_id } ],
//   by_day: { Monday: [...], Tuesday: [...], ... }
// }
//
// (The original file contained a second /timetable handler further down. Express always
// answered with this first one, so the second was unreachable and has been removed.)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/timetable", guard.self(fromAny("uid")), async (req, res) => {
  try {
    const { uid } = req.query;
    const { teacher_id, aishe_code } = await resolveTeacher(uid);

    // All recurring lectures for this teacher — no day filter
    const snap = await db.collection("lectures")
      .where("teacher_id", "==", teacher_id)
      .where("aishe_code", "==", aishe_code)
      .get();

    const rawLectures = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Resolve course names — unique course_ids, remembered for a few minutes, the rest read in one batch
    const courseIds = [...new Set(rawLectures.map((l) => l.course_id).filter(Boolean))];
    const courseMap = {};
    const missing = [];
    for (const cid of courseIds) {
      if (courseNameCache.has(cid)) {
        const v = courseNameCache.get(cid);
        if (v) courseMap[cid] = v;
      } else missing.push(cid);
    }
    for (const part of chunk(missing, 200)) {
      const refs = part.map((id) => db.collection("courses").doc(id));
      for (const doc of await db.getAll(...refs)) {
        let name = null;
        if (doc.exists) {
          const d = doc.data();
          name = d.course_name || d.abbr || doc.id;
          courseMap[doc.id] = name;
        }
        courseNameCache.set(doc.id, name, 300_000);
      }
    }

    const lectures = rawLectures.map((l) => ({
      ...l,
      course_name: courseMap[l.course_id] || null,
    })).sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));

    // Group by day
    const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const by_day = {};
    DAYS.forEach((d) => { by_day[d] = []; });
    lectures.forEach((l) => {
      if (by_day[l.day]) by_day[l.day].push(l);
    });

    return res.json({ success: true, teacher_id, aishe_code, lectures, by_day });

  } catch (err) {
    return sendError(res, err, "TEACHER TIMETABLE ERROR:");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/web/teacher/debug?uid=
// A debugging aid that dumps raw subject and OD documents. It is OFF unless the
// server is started with ENABLE_DEBUG_ROUTES=1 (it would otherwise hand out full
// OD requests of a teacher to anyone who knows the uid).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/debug", guard.self(fromAny("uid")), async (req, res) => {
  if (process.env.ENABLE_DEBUG_ROUTES !== "1")
    return res.status(404).json({ error: "Not found" });
  try {
    const uid = req.query.uid;
    if (!uid) return res.status(400).json({ error: "uid required" });

    const { teacher_id, data: teacherData, aishe_code } = await resolveTeacher(uid);

    // Raw subjects query
    const subjectsSnap = await db.collection("subjects")
      .where("teacher_assigned", "==", teacher_id)
      .get();

    const subjects = subjectsSnap.docs.map((doc) => ({
      doc_id:           doc.id,
      subject_name:     doc.data().subject_name,
      subject_code:     doc.data().subject_code,
      teacher_assigned: doc.data().teacher_assigned,
      aishe_code:       doc.data().aishe_code,
      course_id:        doc.data().course_id,
      semester:         doc.data().semester,
      // raw fields so nothing is hidden
      _raw:             doc.data(),
    }));

    // OD requests
    const odSnap = await db.collection("od_requests")
      .where("teacher_id", "==", teacher_id)
      .get();

    return res.json({
      resolved: { uid, teacher_id, aishe_code },
      teacher_profile: {
        first_name:   teacherData.first_name,
        last_name:    teacherData.last_name,
        user_id:      teacherData.user_id,
        designation:  teacherData.designation,
        departments:  teacherData.departments,
      },
      subjects_count: subjects.length,
      subjects,
      od_count:       odSnap.size,
      od_requests:    odSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    });

  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/web/teacher/:id/students?teacher_id=
// Returns all enrolled students for an assignment's subject.
// Used by the web dashboard to show "not submitted" rows in the register.
// (The same handler is also served at GET /api/assignments/:id/students.)
// ─────────────────────────────────────────────────────────────────
router.get("/:id/students", guard.teacher(fromQuery("teacher_id")), assignmentStudentsHandler);

module.exports = router;
