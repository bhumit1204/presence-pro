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

const subjectsCache = new TTLCache({ max: 5000, ttlMs: 30_000 });
const feedCache = new TTLCache({ max: 5000, ttlMs: 10_000 });

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

module.exports = router;
