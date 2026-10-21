/**
 * routes/web/student.routes.js
 * Mount: app.use("/api/web/student", require("./routes/web/student.routes"));
 *
 * Read-only aggregate endpoints for the STUDENT WEB PORTAL. Everything that already has an
 * endpoint (quizzes, submissions, broadcasts, OD ...) is reused from the mobile API as it is;
 * these three exist because the mobile app reads the data straight from Firestore:
 *
 *   GET /subjects?uid=    my subjects incl. teacher name/id (needed for OD requests)
 *   GET /feed?uid=        assignments + announcements of ALL my subjects, with my submission
 *                         status on every assignment (1 request instead of 2 per subject)
 *   GET /attendance?uid=  per-subject attendance + recent records
 *   GET /timetable?uid=   MY weekly timetable (my semester, division, lab batch, chosen electives) + the one-day changes of the next 14 days
 *   GET /calendar?uid=    the academic calendar of my department (holidays, exams, events)
 *
 * Identity: `uid` = Firebase Auth uid of the student. guard.self() makes sure it is the caller's own.
 */

const express = require("express");
const router = express.Router();
const { db } = require("../../config/firebase");
const { guard, fromQuery } = require("../../middleware/auth");
const { TTLCache } = require("../../utils/cache");
const { chunk, getDocsByIds, tsISO, isIndexMissing } = require("../../utils/firestore");
const { getStudentByUid } = require("../../utils/students");
const { inBatch, rollOf, batchFields } = require("../../utils/batches");
const { buildStudentTimetable } = require("../../utils/studentTimetable");

const subjectsCache = new TTLCache({ max: 5000, ttlMs: 30_000 });
const feedCache = new TTLCache({ max: 5000, ttlMs: 10_000 });
const attCache = new TTLCache({ max: 5000, ttlMs: 20_000 });

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 200 && !v.includes("/");
const teacherName = (d) =>
  d.name || d.full_name || (d.first_name ? `${d.first_name} ${d.last_name || ""}`.trim() : null) || "Teacher";

function selfUid(req) {
  const uid = req.query.uid || req.auth?.uid;
  return isId(uid) ? uid : null;
}

/** subjects the student is enrolled in (+ teacher + course name) */
function loadSubjects(uid) {
  return subjectsCache.memo(uid, 30_000, async () => {
    const student = await getStudentByUid(uid);
    if (!student) return null;
    const ids = [...new Set((Array.isArray(student.enrolled_subjects) ? student.enrolled_subjects : []).filter(isId))];
    if (!ids.length) return [];

    const subjectSnaps = await getDocsByIds("subjects", ids);
    const subjects = [];
    for (const id of ids) {
      const s = subjectSnaps.get(id);
      if (s) subjects.push({ id, ...s.data() });
    }

    const courseIds = [...new Set(subjects.map((s) => s.course_id || student.course_id).filter(Boolean))];
    const teacherIds = [...new Set(subjects.map((s) => s.teacher_assigned || s.teacher_id || s.created_by).filter(isId))];
    const [courses, teachers] = await Promise.all([
      getDocsByIds("courses", courseIds, ["course_name"]),
      getDocsByIds("teachers", teacherIds, ["name", "full_name", "first_name", "last_name"]),
    ]);

    return subjects.map((s) => {
      const course_id = s.course_id || student.course_id || null;
      const teacher_id = s.teacher_assigned || s.teacher_id || s.created_by || null;
      const t = teacher_id ? teachers.get(teacher_id) : null;
      return {
        subject_id: s.id,
        subject_name: s.subject_name || s.name || s.id,
        subject_code: s.subject_code || null,
        course_id,
        course_name: (course_id && courses.get(course_id)?.data().course_name) || student.course_name || null,
        teacher_id,
        teacher_name: t ? teacherName(t.data()) : null,
      };
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
router.get("/subjects", guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const uid = selfUid(req);
    if (!uid) return res.status(400).json({ success: false, error: "uid required" });
    const subjects = await loadSubjects(uid);
    if (!subjects) return res.status(404).json({ success: false, error: "Student not found" });
    res.json({ success: true, subjects });
  } catch (e) {
    console.error("WEB STUDENT SUBJECTS:", e);
    res.status(500).json({ success: false, error: "Failed to load subjects" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
router.get("/feed", guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const uid = selfUid(req);
    if (!uid) return res.status(400).json({ success: false, error: "uid required" });

    const payload = await feedCache.memo(uid, 10_000, async () => {
      const subjects = await loadSubjects(uid);
      if (!subjects) return null;
      const subjectIds = subjects.map((s) => s.subject_id);
      if (!subjectIds.length) return { subjects, assignments: [], announcements: [] };
      const bySubject = new Map(subjects.map((s) => [s.subject_id, s]));

      const runIn = async (collection) => {
        const parts = await Promise.all(
          chunk(subjectIds, 30).map((c) => db.collection(collection).where("subject_id", "in", c).get())
        );
        return parts.flatMap((p) => p.docs.map((d) => d.data()));
      };

      const [assignmentDocs, announcementDocs, submissionSnap] = await Promise.all([
        runIn("assignments"),
        runIn("announcements"),
        db.collection("submissions").where("student_uid", "==", uid).get(),
      ]);

      const mySubs = new Map();
      submissionSnap.docs.forEach((d) => {
        const s = d.data();
        mySubs.set(s.assignment_id, {
          submission_id: s.submission_id || d.id,
          status: s.status || "submitted",
          submitted_at: tsISO(s.submitted_at),
          graded_at: tsISO(s.graded_at),
          marks_obtained: s.marks_obtained ?? null,
          feedback: s.feedback ?? null,
          attachments: Array.isArray(s.attachments) ? s.attachments : [],
          links: Array.isArray(s.links) ? s.links : [],
        });
      });

      const sameCourse = (d) => {
        const sub = bySubject.get(d.subject_id);
        return !sub || !sub.course_id || !d.course_id || sub.course_id === d.course_id;
      };

      const assignments = assignmentDocs
        .filter(sameCourse)
        .map((d) => ({
          assignment_id: d.assignment_id,
          subject_id: d.subject_id,
          subject_name: bySubject.get(d.subject_id)?.subject_name || null,
          course_id: d.course_id || null,
          teacher_id: d.teacher_id || null,
          title: d.title,
          kind: d.kind === "lab_work" ? "lab_work" : "assignment",   // lab work is shown as such
          instructions: d.instructions || null,
          questions: d.questions || null,
          marks: d.marks ?? null,
          due_date: tsISO(d.due_date),
          allow_late: !!d.allow_late,
          attachments: Array.isArray(d.attachments) ? d.attachments : [],
          links: Array.isArray(d.links) ? d.links : [],
          created_at: tsISO(d.created_at),
          updated_at: tsISO(d.updated_at),
          my_submission: mySubs.get(d.assignment_id) || null,
        }))
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, 300);

      const announcements = announcementDocs
        .filter(sameCourse)
        .map((d) => ({
          announcement_id: d.announcement_id,
          subject_id: d.subject_id,
          subject_name: bySubject.get(d.subject_id)?.subject_name || null,
          teacher_id: d.teacher_id || null,
          title: d.title,
          text: d.text,
          is_pinned: !!d.is_pinned,
          attachments: Array.isArray(d.attachments) ? d.attachments : [],
          links: Array.isArray(d.links) ? d.links : [],
          created_at: tsISO(d.created_at),
          updated_at: tsISO(d.updated_at),
        }))
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, 200);

      return { subjects, assignments, announcements };
    });

    if (!payload) return res.status(404).json({ success: false, error: "Student not found" });
    res.json({ success: true, ...payload, server_time: new Date().toISOString() });
  } catch (e) {
    console.error("WEB STUDENT FEED:", e);
    res.status(500).json({ success: false, error: "Failed to load your classes" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Attendance: same rules as the mobile app (completed lecture sessions are the denominator;
// late counts as present; manual rows without a session add to the total; approved OD days
// count as present).
router.get("/attendance", guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const uid = selfUid(req);
    if (!uid) return res.status(400).json({ success: false, error: "uid required" });

    const payload = await attCache.memo(uid, 20_000, async () => {
      const subjects = await loadSubjects(uid);
      if (!subjects) return null;
      const me = await getStudentByUid(uid);
      const subjectIds = subjects.map((s) => s.subject_id);
      const nameOf = new Map(subjects.map((s) => [s.subject_id, s.subject_name]));

      // lectures of my subjects -> lecture_id -> subject_id (+ the division / lab batch the lecture is held for)
      const lectureSubject = new Map();
      const lectureFor = new Map();
      if (subjectIds.length) {
        const parts = await Promise.all(
          chunk(subjectIds, 30).map((c) => db.collection("lectures").where("subject_id", "in", c).select("subject_id", "division_id", "batch", "batch_no", "batch_of", "batch_after", "batch_upto").get())
        );
        parts.forEach((p) => p.docs.forEach((d) => {
          lectureSubject.set(d.id, d.data().subject_id);
          lectureFor.set(d.id, { division_id: d.data().division_id || null, ...(d.data().batch_no ? batchFields(d.data()) : {}) });
        }));
      }
      // is a session (or, for older ones, its lecture) meant for me? my division, and for a lab my batch
      const myDivision = (me && me.division_id) || null;
      const myRoll = rollOf(me);
      const meantForMe = (sess) => {
        const f = { ...(lectureFor.get(sess.lecture_id) || {}) };
        if (sess.division_id) f.division_id = sess.division_id;
        if (sess.batch_no) Object.assign(f, batchFields(sess));
        return (!f.division_id || f.division_id === myDivision) && inBatch(f, myRoll);
      };

      // completed sessions of those lectures -> session_id -> subject_id
      const sessionSubject = new Map();
      const mySessions = new Set();
      const lectureIds = [...lectureSubject.keys()];
      if (lectureIds.length) {
        const runChunk = async (c) => {
          try {
            return (await db.collection("lecture_sessions").where("lecture_id", "in", c).where("status", "==", "completed").select("lecture_id", "division_id", "batch", "batch_no", "batch_of", "batch_after", "batch_upto").get()).docs;
          } catch (e) {
            if (!isIndexMissing(e)) throw e;
            const all = await db.collection("lecture_sessions").where("lecture_id", "in", c).select("lecture_id", "status", "division_id", "batch", "batch_no", "batch_of", "batch_after", "batch_upto").get();
            return all.docs.filter((d) => d.data().status === "completed");
          }
        };
        const parts = await Promise.all(chunk(lectureIds, 30).map(runChunk));
        parts.forEach((docs) => docs.forEach((d) => {
          sessionSubject.set(d.id, lectureSubject.get(d.data().lecture_id));
          if (meantForMe(d.data())) mySessions.add(d.id);
        }));
      }

      const recordsSnap = await db.collection("attendance_records").where("student_uid", "==", uid).get();

      const stats = new Map(subjectIds.map((id) => [id, { present: 0, absent: 0, late: 0, total: 0 }]));
      for (const [sessId, sid] of sessionSubject) if (mySessions.has(sessId) && stats.has(sid)) stats.get(sid).total += 1;

      const recent = [];
      recordsSnap.docs.forEach((doc) => {
        const r = doc.data();
        let sid = null;
        let kind = null;

        const sessSid = r.lecture_session_id ? sessionSubject.get(r.lecture_session_id) : null;
        if (sessSid && stats.has(sessSid)) {
          sid = sessSid;
          kind = "session";
        } else if (r.source === "manual" && stats.has(r.subject_id)) {
          sid = r.subject_id;
          kind = "manual";
        } else if (r.source === "od" && stats.has(r.subject_id)) {
          sid = r.subject_id;
          kind = "od";
        }
        if (!sid) return;

        const st = stats.get(sid);
        if (kind === "od") {
          st.total += 1;
          st.present += 1;
        } else {
          if (kind === "manual" && !r.lecture_session_id) st.total += 1;
          if (r.status === "present") st.present += 1;
          else if (r.status === "late") {
            st.late += 1;
            st.present += 1;
          } else if (r.status === "absent") st.absent += 1;
        }

        recent.push({
          subject_id: sid,
          subject_name: nameOf.get(sid) || sid,
          status: kind === "od" ? "od" : r.status || "present",
          method: kind === "od" ? "od" : r.method || r.source || null,
          at: tsISO(r.marked_at) || tsISO(r.created_at) || (typeof r.date === "string" ? r.date : null),
        });
      });
      recent.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

      const rows = subjects.map((s) => {
        const a = stats.get(s.subject_id);
        return {
          subject_id: s.subject_id,
          subject_name: s.subject_name,
          subject_code: s.subject_code,
          teacher_name: s.teacher_name,
          present: a.present,
          absent: a.absent,
          late: a.late,
          total: a.total,
          percentage: a.total > 0 ? Math.round((a.present / a.total) * 1000) / 10 : null,
        };
      });

      const sum = rows.reduce((acc, r) => ({ present: acc.present + r.present, total: acc.total + r.total }), { present: 0, total: 0 });
      return {
        overall: { present: sum.present, total: sum.total, percentage: sum.total ? Math.round((sum.present / sum.total) * 1000) / 10 : null },
        subjects: rows,
        recent: recent.slice(0, 60),
      };
    });

    if (!payload) return res.status(404).json({ success: false, error: "Student not found" });
    res.json({ success: true, ...payload });
  } catch (e) {
    console.error("WEB STUDENT ATTENDANCE:", e);
    res.status(500).json({ success: false, error: "Failed to load attendance" });
  }
});

/* ───────────────────────── timetable + academic calendar ───────────────────────── */
const ttCache = new TTLCache({ max: 3000, ttlMs: 30_000 });
const IST_MS = 5.5 * 3600 * 1000;
const todayIST = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
const up = (v) => String(v || "").trim().toUpperCase();

/** the course document of a student ({ id, ...data }) */
async function courseOfStudent(student) {
  if (isId(student.course_id)) {
    const s = await db.collection("courses").doc(student.course_id).get();
    if (s.exists) return { id: s.id, ...s.data() };
  }
  if (student.course_name && student.aishe_code) {
    const q = await db.collection("courses").where("course_name", "==", student.course_name).where("aishe_code", "==", student.aishe_code).limit(1).get();
    if (!q.empty) return { id: q.docs[0].id, ...q.docs[0].data() };
  }
  return null;
}

router.get("/timetable", guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const uid = selfUid(req);
    if (!uid) return res.status(400).json({ success: false, error: "uid required" });
    const body = await ttCache.memo(uid, 30_000, async () => {
      const student = await getStudentByUid(uid);
      if (!student) return null;
      const course = await courseOfStudent(student);
      const today = todayIST();
      const info = {
        course_name: student.course_name || (course && course.course_name) || "",
        course_abbr: (course && course.abbr) || "",
        semester: student.semester ?? null,
        division_id: student.division_id || null,
        division_name: "",
        roll_no: rollOf(student) || null,
      };
      if (!course) return { success: true, today, student: info, days: {}, lectures: [], changes: [] };

      const [lecSnap, subjSnap, ovSnap, divSnap] = await Promise.all([
        db.collection("lectures").where("course_id", "==", course.id).get(),
        db.collection("subjects").where("course_id", "==", course.id).get(),
        db.collection("timetable_overrides").where("course_id", "==", course.id).get(),
        student.division_id ? db.collection("divisions").doc(student.division_id).get() : Promise.resolve(null),
      ]);
      if (divSnap && divSnap.exists) info.division_name = divSnap.data().name || "";
      const lectures = lecSnap.docs.map((d) => ({ ...d.data(), lecture_id: d.id }));
      const subjects = subjSnap.docs.map((d) => ({ ...d.data(), subject_id: d.id }));
      const overrides = ovSnap.docs.map((d) => ({ ...d.data(), override_id: d.id }));

      const tIds = [...new Set([...lectures.map((l) => l.teacher_id), ...overrides.map((o) => o.special && o.special.teacher_id), ...overrides.map((o) => o.changes && o.changes.teacher_id)].filter(isId))];
      const teacherNames = {};
      if (tIds.length) {
        const docs = await getDocsByIds("teachers", tIds, ["name", "full_name", "first_name", "last_name"]);
        for (const [id, snap] of docs) teacherNames[id] = teacherName(snap.data());
      }
      const t = buildStudentTimetable({ student, lectures, subjects, overrides, teacherNames, today });
      return { success: true, today, student: info, ...t };
    });
    if (!body) return res.status(404).json({ success: false, error: "Student not found" });
    res.json(body);
  } catch (e) {
    console.error("WEB STUDENT TIMETABLE:", e);
    res.status(500).json({ success: false, error: "Failed to load the timetable" });
  }
});

const academicYearOf = (d) => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return m >= 6 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`; };

router.get("/calendar", guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const uid = selfUid(req);
    if (!uid) return res.status(400).json({ success: false, error: "uid required" });
    const body = await ttCache.memo(`cal:${uid}`, 30_000, async () => {
      const student = await getStudentByUid(uid);
      if (!student) return null;
      const course = await courseOfStudent(student);
      const dept = up(course && (course.department || course.abbr));
      const snap = await db.collection("academic_calendar").where("aishe_code", "==", student.aishe_code).get();
      const events = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((e) => (e.event_type || "general") !== "defaulter")                           // internal: the head's defaulter runs
        .filter((e) => !e.department || (dept && up(e.department) === dept))                 // college-wide, or my department's
        .map((e) => {
          const start = e.start_date || e.date || null;
          return {
            event_id: e.id, title: e.title || "", event_type: e.event_type || "general",
            start_date: start, end_date: e.end_date || start, description: e.description || "",
            academic_year: e.academic_year || (start ? academicYearOf(start) : null),
            scope: e.department ? "department" : "college",
          };
        })
        .filter((e) => e.start_date)
        .sort((a, b) => a.start_date.localeCompare(b.start_date));
      return { success: true, today: todayIST(), events, academic_years: [...new Set(events.map((e) => e.academic_year).filter(Boolean))].sort() };
    });
    if (!body) return res.status(404).json({ success: false, error: "Student not found" });
    res.json(body);
  } catch (e) {
    console.error("WEB STUDENT CALENDAR:", e);
    res.status(500).json({ success: false, error: "Failed to load the calendar" });
  }
});

module.exports = router;