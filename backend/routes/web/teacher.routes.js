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

// ─── Resolve teacher from Firebase Auth UID ───────────────────────────────────
// Mirrors the exact logic in auth_routes.js login
async function resolveTeacher(uid) {
  if (!uid) throw Object.assign(new Error("uid is required"), { status: 400 });

  // Try direct query first
  const snap1 = await db.collection("teachers").where("user_id", "==", uid).limit(1).get();
  if (!snap1.empty) {
    const doc = snap1.docs[0];
    return { teacher_id: doc.id, data: doc.data(), aishe_code: doc.data().aishe_code };
  }

  // Fallback: scan and trim-match (handles whitespace issues)
  const allSnap = await db.collection("teachers").where("aishe_code", "!=", "").get();
  const matched = allSnap.docs.find(d => (d.data().user_id || "").trim() === uid.trim());
  if (matched) {
    return { teacher_id: matched.id, data: matched.data(), aishe_code: matched.data().aishe_code };
  }

  throw Object.assign(new Error("Teacher profile not found"), { status: 404 });
}

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
router.get("/dashboard", async (req, res) => {
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
      subjectsSnap,
      lecturesSnap,
      cancelledSnap,
      tempSessionsSnap,
      odSnap,
      swapSnap,
    ] = await Promise.all([
      // subjects where this teacher is assigned
      db.collection("subjects")
        .where("teacher_assigned", "==", teacher_id)
        .get(),

      // regular lectures scheduled today
      db.collection("lectures")
        .where("teacher_id", "==", teacher_id)
        .where("aishe_code", "==", aishe_code)
        .where("day", "==", todayDay)
        .get(),

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
    const subjects = subjectsSnap.docs.map((doc) => ({
      ...doc.data(),
      subject_id: doc.id,
      // ensure aishe_code fallback if not on subject doc
      aishe_code: doc.data().aishe_code || aishe_code,
    }));

    // ── Today's schedule ──────────────────────────────────────────────────────
    const cancelledIds = new Set(
      cancelledSnap.docs.map((d) => d.data().lecture_id).filter(Boolean)
    );

    const regularLectures = lecturesSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((l) => !cancelledIds.has(l.id));

    // Enrich temp sessions by reading parent lecture doc
    const tempLectures = (
      await Promise.all(
        tempSessionsSnap.docs.map(async (doc) => {
          const s = doc.data();
          if (!s.lecture_id) return null;
          const lDoc = await db.collection("lectures").doc(s.lecture_id).get();
          if (!lDoc.exists) return null;
          const l = lDoc.data();
          return {
            id:           lDoc.id,
            ...l,
            teacher_id:   s.teacher_id,
            start_time:   s.start_time || l.start_time,
            end_time:     s.end_time   || l.end_time,
            is_temporary: true,
          };
        })
      )
    ).filter(Boolean);

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
    }).sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (b.status === "pending" && a.status !== "pending") return  1;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

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
    console.error("TEACHER DASHBOARD ERROR:", err);
    return res.status(err.status || 500).json({ success: false, error: err.message });
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
// ─────────────────────────────────────────────────────────────────────────────
router.get("/class-report", async (req, res) => {
  try {
    const { uid, subject_id } = req.query;
    if (!subject_id) return res.status(400).json({ success: false, error: "subject_id is required" });

    const { teacher_id } = await resolveTeacher(uid);

    // Ownership check
    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists)
      return res.status(404).json({ success: false, error: "Subject not found" });

    const subjData = subjectDoc.data();
    if (subjData.teacher_assigned !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied — you are not assigned to this subject" });

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
        .get(),
      // quizzes for this subject
      db.collection("quizzes")
        .where("subject_id",  "==", subject_id)
        .where("teacher_id",  "==", teacher_id)
        .get(),
      // assignments for this subject
      db.collection("assignments")
        .where("subject_id",  "==", subject_id)
        .where("teacher_id",  "==", teacher_id)
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
    const quizzes     = quizzesSnap.docs.map((d) => ({ quiz_id: d.data().quiz_id || d.id, ...d.data() }));
    const assignments = assignmentsSnap.docs.map((d) => ({ assignment_id: d.data().assignment_id || d.id, ...d.data() }));

    // Empty class
    if (students.length === 0) {
      return res.json({
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
      });
    }

    // ── Get completed lecture sessions ────────────────────────────────────────
    // lecture_sessions.lecture_id in lectureIds AND status == "completed"
    let sessionIds = [];
    const CHUNK    = 30;

    if (lectureIds.length > 0) {
      for (let i = 0; i < lectureIds.length; i += CHUNK) {
        const chunk = lectureIds.slice(i, i + CHUNK);
        const snap  = await db.collection("lecture_sessions")
          .where("lecture_id", "in", chunk)
          .where("status", "==", "completed")
          .get();
        snap.docs.forEach((d) => sessionIds.push(d.id));
      }
    }
    const totalLectures = sessionIds.length;

    // ── Batch fetch quiz + assignment submissions ──────────────────────────────
    // quizSubMap:  uid → quiz_id → submission
    // assSubMap:   uid → assignment_id → submission
    const quizSubMap = {};
    const assSubMap  = {};

    if (quizzes.length) {
      for (let i = 0; i < quizzes.length; i += CHUNK) {
        const chunk = quizzes.slice(i, i + CHUNK).map((q) => q.quiz_id);
        const snap  = await db.collection("quiz_submissions").where("quiz_id", "in", chunk).get();
        snap.docs.forEach((doc) => {
          const d = doc.data();
          if (!quizSubMap[d.student_uid]) quizSubMap[d.student_uid] = {};
          quizSubMap[d.student_uid][d.quiz_id] = d;
        });
      }
    }

    if (assignments.length) {
      for (let i = 0; i < assignments.length; i += CHUNK) {
        const chunk = assignments.slice(i, i + CHUNK).map((a) => a.assignment_id);
        const snap  = await db.collection("submissions").where("assignment_id", "in", chunk).get();
        snap.docs.forEach((doc) => {
          const d = doc.data();
          if (!assSubMap[d.student_uid]) assSubMap[d.student_uid] = {};
          assSubMap[d.student_uid][d.assignment_id] = d;
        });
      }
    }

    // ── Build attendance lookup ────────────────────────────────────────────────
    // For each lecture_session, check attendance_sessions.present_students[]
    // and attendance_records (QR/IoT/manual/OD)
    //
    // attMap: uid → Set of session IDs where student was present/late/od
    const attMap = {}; // uid → count of present/late/od sessions
    students.forEach((s) => { attMap[s.uid] = 0; });

    if (sessionIds.length > 0) {
      // Source A: attendance_sessions.present_students (mark-code / mark-bio)
      for (let i = 0; i < sessionIds.length; i += CHUNK) {
        const chunk = sessionIds.slice(i, i + CHUNK);
        const snap  = await db.collection("attendance_sessions")
          .where("lecture_session_id", "in", chunk)
          .get();
        snap.docs.forEach((doc) => {
          const presentList = doc.data().present_students || [];
          presentList.forEach((uid) => {
            if (attMap.hasOwnProperty(uid)) attMap[uid]++;
          });
        });
      }

      // Source B: attendance_records (QR/IoT/manual/OD)
      // Use lecture_session_id to match sessions
      for (let i = 0; i < sessionIds.length; i += CHUNK) {
        const chunk = sessionIds.slice(i, i + CHUNK);
        const snap  = await db.collection("attendance_records")
          .where("lecture_session_id", "in", chunk)
          .get();
        snap.docs.forEach((doc) => {
          const d   = doc.data();
          const uid = d.student_uid;
          const st  = d.status;
          if (attMap.hasOwnProperty(uid) && (st === "present" || st === "late" || st === "od")) {
            // Only count if not already counted via attendance_sessions
            // We'll de-dup by using a Set per student
          }
        });
      }
    }

    // Better approach: use attendance_records queried by subject_id directly
    // (mirrors buildAttendanceRecords in reports_routes.js)
    // Reset and recount properly
    const attCountMap = {}; // uid → Set of "counted dates" to avoid double-counting
    students.forEach((s) => { attCountMap[s.uid] = new Set(); });

    if (sessionIds.length > 0) {
      // Get session → date mapping
      const sessionDateMap = {};
      for (let i = 0; i < sessionIds.length; i += CHUNK) {
        const chunk = sessionIds.slice(i, i + CHUNK);
        const snap  = await db.collection("lecture_sessions")
          .where(admin.firestore.FieldPath.documentId(), "in", chunk)
          .get();
        snap.docs.forEach((doc) => {
          const d = doc.data();
          sessionDateMap[doc.id] = d.date || toISO(d.started_at)?.split("T")[0] || doc.id;
        });
      }

      // Source A: attendance_sessions.present_students
      for (let i = 0; i < sessionIds.length; i += CHUNK) {
        const chunk = sessionIds.slice(i, i + CHUNK);
        const snap  = await db.collection("attendance_sessions")
          .where("lecture_session_id", "in", chunk)
          .get();
        snap.docs.forEach((doc) => {
          const d    = doc.data();
          const date = sessionDateMap[d.lecture_session_id] || doc.id;
          (d.present_students || []).forEach((uid) => {
            if (attCountMap.hasOwnProperty(uid)) attCountMap[uid].add(date);
          });
        });
      }

      // Source B: attendance_records with lecture_session_id
      for (let i = 0; i < sessionIds.length; i += CHUNK) {
        const chunk = sessionIds.slice(i, i + CHUNK);
        const snap  = await db.collection("attendance_records")
          .where("lecture_session_id", "in", chunk)
          .get();
        snap.docs.forEach((doc) => {
          const d    = doc.data();
          const uid  = d.student_uid;
          const st   = d.status;
          const date = sessionDateMap[d.lecture_session_id] || d.date || doc.id;
          if (attCountMap.hasOwnProperty(uid) && (st === "present" || st === "late" || st === "od")) {
            attCountMap[uid].add(date);
          }
        });
      }
    }

    // Source C: OD attendance_records (no lecture_session_id, source == "od")
    const odAttSnap = await db.collection("attendance_records")
      .where("subject_id", "==", subject_id)
      .where("source",     "==", "od")
      .get();
    odAttSnap.docs.forEach((doc) => {
      const d    = doc.data();
      const uid  = d.student_uid;
      const date = d.date || toISO(d.created_at)?.split("T")[0];
      if (date && attCountMap.hasOwnProperty(uid)) attCountMap[uid].add(date);
    });

    // Source D: manual attendance_records (source == "manual")
    const manualAttSnap = await db.collection("attendance_records")
      .where("subject_id", "==", subject_id)
      .where("source",     "==", "manual")
      .get();
    manualAttSnap.docs.forEach((doc) => {
      const d    = doc.data();
      const uid  = d.student_uid;
      const date = d.date || toISO(d.marked_at)?.split("T")[0];
      if (date && attCountMap.hasOwnProperty(uid)) {
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

    return res.json({
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
    });

  } catch (err) {
    console.error("TEACHER CLASS-REPORT ERROR:", err);
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/web/teacher/od?uid=&status=
//
// All OD requests for this teacher.
// Optional ?status=pending|approved|rejected
// ─────────────────────────────────────────────────────────────────────────────
router.get("/od", async (req, res) => {
  try {
    const { uid, status } = req.query;
    const { teacher_id } = await resolveTeacher(uid);

    let q = db.collection("od_requests").where("teacher_id", "==", teacher_id);
    if (status) q = q.where("status", "==", status);

    const snap = await q.get();
    const requests = snap.docs.map((doc) => {
      const d = doc.data();
      return { ...d, created_at: toISO(d.created_at), updated_at: toISO(d.updated_at) };
    }).sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (b.status === "pending" && a.status !== "pending") return  1;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

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
    console.error("TEACHER OD ERROR:", err);
    return res.status(err.status || 500).json({ success: false, error: err.message });
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
// ─────────────────────────────────────────────────────────────────────────────
router.put("/od/:od_id/review", async (req, res) => {
  try {
    const { od_id }                     = req.params;
    const { uid, action, teacher_note } = req.body;

    if (!["approved", "rejected"].includes(action))
      return res.status(400).json({ success: false, error: "action must be 'approved' or 'rejected'" });

    const { teacher_id } = await resolveTeacher(uid);

    const odRef = db.collection("od_requests").doc(od_id);
    const odDoc = await odRef.get();

    if (!odDoc.exists)
      return res.status(404).json({ success: false, error: "OD request not found" });

    const od = odDoc.data();

    if (od.teacher_id !== teacher_id)
      return res.status(403).json({ success: false, error: "Not authorised to review this request" });

    if (od.status !== "pending")
      return res.status(400).json({ success: false, error: `OD is already ${od.status}` });

    const now = admin.firestore.FieldValue.serverTimestamp();

    await odRef.update({ status: action, teacher_note: teacher_note?.trim() || null, updated_at: now });

    // On approval: write OD attendance records for each weekday in the date range
    if (action === "approved") {
      const batch = db.batch();
      const from  = new Date(od.from_date + "T06:30:00Z");
      const to    = new Date(od.to_date   + "T06:30:00Z");

      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        if (d.getUTCDay() === 0) continue; // skip Sundays
        const ymd    = d.toISOString().slice(0, 10);
        const recId  = `${od.student_uid}_${od.subject_id}_${ymd}`;
        const recRef = db.collection("attendance_records").doc(recId);
        batch.set(recRef, {
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
        }, { merge: true });
      }
      await batch.commit();
    }

    return res.json({
      success: true,
      message: action === "approved" ? "OD approved and attendance marked" : "OD rejected",
    });

  } catch (err) {
    console.error("TEACHER OD REVIEW ERROR:", err);
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/web/teacher/schedule?uid=&date=YYYY-MM-DD
//
// Schedule for a specific date (defaults to today).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/schedule", async (req, res) => {
  try {
    const { uid, date } = req.query;
    const { teacher_id, aishe_code } = await resolveTeacher(uid);

    const targetDate = date || istDateStr(nowIST());
    const targetDay  = dayName(targetDate);

    const [lecturesSnap, cancelledSnap, tempSnap] = await Promise.all([
      db.collection("lectures")
        .where("teacher_id", "==", teacher_id)
        .where("aishe_code", "==", aishe_code)
        .where("day", "==", targetDay)
        .get(),
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

    const regular = lecturesSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((l) => !cancelledIds.has(l.id));

    const temps = (
      await Promise.all(
        tempSnap.docs.map(async (doc) => {
          const s = doc.data();
          if (!s.lecture_id) return null;
          const lDoc = await db.collection("lectures").doc(s.lecture_id).get();
          if (!lDoc.exists) return null;
          const l = lDoc.data();
          return { id: lDoc.id, ...l, teacher_id: s.teacher_id, start_time: s.start_time || l.start_time, end_time: s.end_time || l.end_time, is_temporary: true };
        })
      )
    ).filter(Boolean);

    const existingIds = new Set(regular.map((l) => l.id));
    const all = [
      ...regular,
      ...temps.filter((l) => !existingIds.has(l.id)),
    ].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));

    return res.json({ success: true, date: targetDate, day: targetDay, lectures: all });

  } catch (err) {
    console.error("TEACHER SCHEDULE ERROR:", err);
    return res.status(err.status || 500).json({ success: false, error: err.message });
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
// ─────────────────────────────────────────────────────────────────────────────
router.get("/timetable", async (req, res) => {
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

    // Resolve course names — batch fetch unique course_ids
    const courseIds = [...new Set(rawLectures.map((l) => l.course_id).filter(Boolean))];
    const courseMap = {};
    await Promise.all(
      courseIds.map(async (cid) => {
        const doc = await db.collection("courses").doc(cid).get();
        if (doc.exists) {
          const d = doc.data();
          courseMap[cid] = d.course_name || d.abbr || cid;
        }
      })
    );

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
    console.error("TEACHER TIMETABLE ERROR:", err);
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/web/teacher/debug?uid=
// Remove after debugging. Shows exactly what the backend resolves.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/debug", async (req, res) => {
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
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ADD THIS to assignment_routes.js — paste before module.exports
//
// 📌 GET /api/assignments/:id/students?teacher_id=
// Returns all enrolled students for an assignment's subject.
// Used by the web dashboard to show "not submitted" rows in the register.
// ─────────────────────────────────────────────────────────────────
router.get("/:id/students", async (req, res) => {
  try {
    const { id }          = req.params;
    const { teacher_id }  = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }

    // Ownership check
    const assignSnap = await db.collection("assignments").doc(id).get();
    if (!assignSnap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }
    if (assignSnap.data().teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const subject_id = assignSnap.data().subject_id;

    // All approved students enrolled in this subject
    const snap = await db.collection("students")
      .where("enrolled_subjects", "array-contains", subject_id)
      .where("approval_status", "==", "approved")
      .get();

    const students = snap.docs.map((d) => {
      const s = d.data();
      return {
        uid:  s.uid  || d.id,
        name: s.name || `${s.first_name || ""} ${s.last_name || ""}`.trim() || "Unknown",
        roll: s.roll_no || s.roll_number || null,
      };
    }).sort((a, b) =>
      (a.roll || a.name).localeCompare(b.roll || b.name, undefined, { numeric: true })
    );

    return res.json({ success: true, count: students.length, students });

  } catch (err) {
    console.error("ASSIGNMENT STUDENTS ERROR:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/web/teacher/timetable?uid=
//
// Returns the teacher's full weekly timetable — all lectures across all days,
// grouped by day. Used by the schedule/timetable page.
//
// Response:
// {
//   success: true,
//   teacher_id,
//   timetable: {
//     Monday:    [{ lecture_id, subject_name, subject_code, room, start_time, end_time, course_id, subject_id }],
//     Tuesday:   [...],
//     ...
//   },
//   all_lectures: [...],   // flat array for convenience
//   subjects: [...]        // unique subjects this teacher teaches
// }
// ─────────────────────────────────────────────────────────────────────────────
router.get("/timetable", async (req, res) => {
  try {
    const uid = req.query.uid;
    const { teacher_id, data: teacherData, aishe_code } = await resolveTeacher(uid);

    // All lectures assigned to this teacher at this college
    const lecturesSnap = await db.collection("lectures")
      .where("teacher_id", "==", teacher_id)
      .where("aishe_code", "==", aishe_code)
      .get();

    const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

    // Build flat list
    const allLectures = lecturesSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        lecture_id:   doc.id,
        subject_id:   d.subject_id   || null,
        subject_name: d.subject_name || null,
        subject_code: d.subject_code || null,
        course_id:    d.course_id    || null,
        room:         d.room         || null,
        day:          d.day          || null,
        start_time:   d.start_time   || null,
        end_time:     d.end_time     || null,
        aishe_code:   d.aishe_code   || aishe_code,
      };
    }).sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));

    // Group by day
    const timetable = {};
    DAYS.forEach((d) => { timetable[d] = []; });
    allLectures.forEach((lec) => {
      if (lec.day && timetable[lec.day]) {
        timetable[lec.day].push(lec);
      }
    });

    // Unique subjects
    const subjectMap = {};
    allLectures.forEach((l) => {
      if (l.subject_id) subjectMap[l.subject_id] = { subject_id: l.subject_id, subject_name: l.subject_name, subject_code: l.subject_code };
    });

    return res.json({
      success:      true,
      teacher_id,
      timetable,
      all_lectures: allLectures,
      subjects:     Object.values(subjectMap),
    });

  } catch (err) {
    console.error("TEACHER TIMETABLE ERROR:", err);
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
});