const express = require("express");
const router  = express.Router();
const { FieldValue } = require("firebase-admin/firestore");
const { workingDb, instituteDb, COLLECTIONS } = require("../config/firebase");
const { requireAuth, requireAishe, rateLimit, wrap } = require("../middleware/security");
const { emailMatches } = require("../utils/autoApprove");

// Everything here needs a signed-in institute that owns an AISHE code.
// req.institute.aishe_code comes from the database record, never from the request.
router.use(requireAuth, requireAishe);

// ids in a URL are plain Firestore ids; anything else is rejected before it reaches the database
router.param("id", (req, res, next, id) =>
  /^[A-Za-z0-9_-]{1,128}$/.test(id) ? next() : res.status(400).json({ error: "Invalid id." }));

const writeLimiter = rateLimit({
  windowMs: 60_000, max: 120, name: "inst-write", key: (req) => req.institute.institute_id,
});
const bulkLimiter = rateLimit({
  windowMs: 60_000, max: 6, name: "inst-bulk", key: (req) => req.institute.institute_id,
});
router.use((req, res, next) => (req.method === "GET" ? next() : writeLimiter(req, res, next)));

// ── small helpers ─────────────────────────────────────────────────────
const BATCH_SAFE = 400;                       // Firestore allows 500 writes per batch
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const personName = (t) => `${t.first_name || ""} ${t.last_name || ""}`.trim();
const SEM_RE = /^Sem \d{1,2}$/;

// push tokens, secrets etc. never go to the portal
const SECRET_KEY = /token|secret|password/i;
function publicDoc(data) {
  const out = {};
  for (const k of Object.keys(data)) if (!SECRET_KEY.test(k)) out[k] = data[k];
  return out;
}

// Pagination: when the caller sends no page/limit, return everything (up to `cap`),
// so dropdowns that just want "all approved teachers" are not cut off at 10.
function pager(q, { def, cap }) {
  const explicit = q.page !== undefined || q.limit !== undefined;
  const limit = explicit ? Math.min(cap, Math.max(1, parseInt(q.limit, 10) || def)) : cap;
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  return { explicit, limit, page };
}
const slicePage = (rows, { limit, page }) => rows.slice((page - 1) * limit, page * limit);
const pageInfo = (total, { limit, page }) => ({ total, page, limit, total_pages: Math.ceil(total / limit) });

// count() is one cheap aggregation read; fall back to reading ids on old SDKs
async function countOf(query) {
  try {
    const s = await query.count().get();
    return s.data().count;
  } catch {
    return (await query.select().get()).size;
  }
}

// One document that must belong to this institute. 404 for both "missing" and
// "someone else's", so ids of other colleges cannot be probed.
async function owned(res, collection, id, aishe_code, label) {
  const doc = await workingDb.collection(collection).doc(id).get();
  if (!doc.exists || doc.data().aishe_code !== aishe_code) {
    res.status(404).json({ error: `${label} not found.` });
    return null;
  }
  return doc;
}

// e-mails live in users/{uid}; read them for ONE page only
async function emailsFor(uids) {
  const map = {};
  const ids = [...new Set(uids.filter((u) => typeof u === "string" && u))];
  for (let i = 0; i < ids.length; i += 300) {
    const refs = ids.slice(i, i + 300).map((u) => workingDb.collection("users").doc(u));
    const docs = await workingDb.getAll(...refs);
    docs.forEach((d) => { if (d.exists) map[d.id] = d.data().email || null; });
  }
  return map;
}

async function commitInChunks(refs, patch) {
  for (let i = 0; i < refs.length; i += BATCH_SAFE) {
    const batch = workingDb.batch();
    refs.slice(i, i + BATCH_SAFE).forEach((r) => batch.update(r, patch));
    await batch.commit();
  }
}

// ── Subject <-> lectures consistency ──────────────────────────────────
// `lectures` (the timetable teachers/students see) repeat a few fields of their
// subject. The subject is the source of truth, so every write to a subject's
// teacher / name / code / semester is pushed into its lectures in the same batch.
// Fields a lecture does not already carry (teacher_name, subject_code, semester)
// are never added; teacher_id and subject_name always exist.

// Teacher must exist, belong to this institute and be usable.
async function checkTeacher(aishe_code, teacher_id) {
  if (typeof teacher_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(teacher_id)) {
    return { ok: false, status: 400, error: "Invalid teacher id." };
  }
  const doc = await workingDb.collection("teachers").doc(teacher_id).get();
  if (!doc.exists) return { ok: false, status: 404, error: "Teacher not found." };
  const t = doc.data();
  if (t.aishe_code !== aishe_code) return { ok: false, status: 403, error: "Teacher belongs to another institute." };
  if (t.approval_status !== "approved" || t.is_active === false) {
    return { ok: false, status: 400, error: "Teacher is not approved or is deactivated." };
  }
  return { ok: true, name: personName(t) };
}

function lecturePatch(l, subject, teacherName) {
  const p = {};
  // A slot the head gave its own teacher (teacher_pinned), or one with a temporary
  // one-day change running (override_id), keeps its teacher.
  const ownTeacher = l.teacher_pinned === true || !!l.override_id;
  if (ownTeacher) {
    // teacher untouched
  } else if (subject.teacher_assigned) {
    if (l.teacher_id !== subject.teacher_assigned) p.teacher_id = subject.teacher_assigned;
    if (teacherName && "teacher_name" in l && l.teacher_name !== teacherName) p.teacher_name = teacherName;
  } else {
    // subject unassigned -> the lecture no longer belongs to any teacher
    if (l.teacher_id) p.teacher_id = null;
    if ("teacher_name" in l && l.teacher_name) p.teacher_name = FieldValue.delete();
  }
  const name = subject.subject_name || "";
  if ((l.subject_name || "") !== name) p.subject_name = name;
  if ("subject_code" in l && subject.subject_code && l.subject_code !== subject.subject_code) p.subject_code = subject.subject_code;
  if ("semester" in l && subject.semester && l.semester !== subject.semester) p.semester = subject.semester;
  return p;
}

// Writes `subjectUpdate` to the subject and syncs all of its lectures. Returns how many lectures changed.
async function updateSubjectAndLectures(subjectDoc, subjectUpdate, teacherName) {
  const merged = { ...subjectDoc.data(), ...subjectUpdate };
  const lecSnap = await workingDb.collection("lectures").where("subject_id", "==", subjectDoc.id).get();

  const ops = [(b) => b.update(subjectDoc.ref, subjectUpdate)];
  let changed = 0;
  lecSnap.docs.forEach((d) => {
    const patch = lecturePatch(d.data(), merged, teacherName);
    if (Object.keys(patch).length) { changed++; ops.push((b) => b.update(d.ref, patch)); }
  });

  for (let i = 0; i < ops.length; i += BATCH_SAFE) {
    const batch = workingDb.batch();
    ops.slice(i, i + BATCH_SAFE).forEach((op) => op(batch));
    await batch.commit();
  }
  return changed;
}

// ══════════════════════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════════════════════
router.get("/stats", wrap("STATS", async (req, res) => {
  const { aishe_code } = req.institute;
  const col = (name) => workingDb.collection(name).where("aishe_code", "==", aishe_code);
  const status = (name, s) => col(name).where("approval_status", "==", s);

  const [approved_students, pending_students, approved_teachers, pending_teachers, total_courses, total_subjects] =
    await Promise.all([
      countOf(status("students", "approved")), countOf(status("students", "pending")),
      countOf(status("teachers", "approved")), countOf(status("teachers", "pending")),
      countOf(col("courses")), countOf(col("subjects")),
    ]);

  return res.status(200).json({
    success: true,
    stats: { approved_students, pending_students, approved_teachers, pending_teachers, total_courses, total_subjects },
  });
}));

// ══════════════════════════════════════════════════════════════════════
// COURSES
// ══════════════════════════════════════════════════════════════════════
router.get("/courses", wrap("COURSES", async (req, res) => {
  const { aishe_code } = req.institute;
  const pg = pager(req.query, { def: 6, cap: 50 });

  const snap = await workingDb.collection("courses").where("aishe_code", "==", aishe_code).get();
  const all = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.course_name || "").localeCompare(String(b.course_name || "")));

  // student / subject counts only for the courses on this page
  const rows = await Promise.all(slicePage(all, pg).map(async (c) => {
    const abbr = c.abbr || "";
    const degrees = [...new Set([abbr, abbr.toUpperCase()])].filter(Boolean);
    const [students, subjects] = await Promise.all([
      Promise.all(degrees.map((dg) => countOf(
        workingDb.collection("students").where("aishe_code", "==", aishe_code)
          .where("approval_status", "==", "approved").where("degree", "==", dg)))),
      countOf(workingDb.collection("subjects").where("aishe_code", "==", aishe_code).where("course_id", "==", c.id)),
    ]);
    return {
      course_id: c.id,
      course_name: c.course_name,
      abbr: c.abbr,
      duration: c.duration,
      duration_years: c.duration_years || null,
      total_semesters: c.total_semesters || null,
      qualification: c.qualification,
      student_count: students.reduce((a, b) => a + b, 0),
      subject_count: subjects,
    };
  }));

  return res.status(200).json({ success: true, courses: rows, total: all.length });
}));

const posInt = (v, max) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= max ? n : null; };

router.post("/courses", wrap("ADD COURSE", async (req, res) => {
  const { aishe_code } = req.institute;
  const course_name = str(req.body.course_name), abbr = str(req.body.abbr, 20).toUpperCase();
  const duration = str(req.body.duration, 40), qualification = str(req.body.qualification, 100);

  if (!course_name || !abbr || !duration || !qualification) {
    return res.status(400).json({ error: "course_name, abbr, duration and qualification are required." });
  }
  const duration_years = req.body.duration_years ? posInt(req.body.duration_years, 10) : null;
  const total_semesters = req.body.total_semesters ? posInt(req.body.total_semesters, 20) : null;
  if (req.body.duration_years && !duration_years) return res.status(400).json({ error: "duration_years must be 1-10." });
  if (req.body.total_semesters && !total_semesters) return res.status(400).json({ error: "total_semesters must be 1-20." });

  const dup = await workingDb.collection("courses")
    .where("aishe_code", "==", aishe_code).where("abbr", "==", abbr).limit(1).get();
  if (!dup.empty) return res.status(409).json({ error: `A course with abbreviation "${abbr}" already exists.` });

  const ref = workingDb.collection("courses").doc();
  await ref.set({
    course_id: ref.id, aishe_code, course_name, abbr, duration,
    duration_years, total_semesters, qualification,
    created_at: FieldValue.serverTimestamp(),
  });
  return res.status(201).json({ success: true, message: "Course added successfully.", course_id: ref.id });
}));

router.put("/courses/:id", wrap("UPDATE COURSE", async (req, res) => {
  const { aishe_code } = req.institute;
  const doc = await owned(res, "courses", req.params.id, aishe_code, "Course");
  if (!doc) return;

  const patch = {};
  if (req.body.course_name !== undefined) { patch.course_name = str(req.body.course_name); if (!patch.course_name) return res.status(400).json({ error: "course_name cannot be empty." }); }
  if (req.body.duration !== undefined) { patch.duration = str(req.body.duration, 40); if (!patch.duration) return res.status(400).json({ error: "duration cannot be empty." }); }
  if (req.body.qualification !== undefined) { patch.qualification = str(req.body.qualification, 100); if (!patch.qualification) return res.status(400).json({ error: "qualification cannot be empty." }); }
  if (req.body.duration_years) { patch.duration_years = posInt(req.body.duration_years, 10); if (!patch.duration_years) return res.status(400).json({ error: "duration_years must be 1-10." }); }
  if (req.body.total_semesters) { patch.total_semesters = posInt(req.body.total_semesters, 20); if (!patch.total_semesters) return res.status(400).json({ error: "total_semesters must be 1-20." }); }

  if (req.body.abbr !== undefined) {
    const abbr = str(req.body.abbr, 20).toUpperCase();
    if (!abbr) return res.status(400).json({ error: "abbr cannot be empty." });
    const old = doc.data().abbr;
    if (abbr !== old) {
      // students (degree) and teachers (departments) point at the abbreviation
      const [students, teachers, clash] = await Promise.all([
        countOf(workingDb.collection("students").where("aishe_code", "==", aishe_code).where("degree", "==", old)),
        countOf(workingDb.collection("teachers").where("aishe_code", "==", aishe_code).where("departments", "array-contains", old)),
        workingDb.collection("courses").where("aishe_code", "==", aishe_code).where("abbr", "==", abbr).limit(1).get(),
      ]);
      if (!clash.empty) return res.status(409).json({ error: `A course with abbreviation "${abbr}" already exists.` });
      if (students || teachers) {
        return res.status(409).json({ error: "The abbreviation cannot be changed while students or teachers are linked to this course." });
      }
      patch.abbr = abbr;
    }
  }

  if (Object.keys(patch).length) {
    patch.updated_at = FieldValue.serverTimestamp();
    await doc.ref.update(patch);
  }
  return res.status(200).json({ success: true, message: "Course updated successfully." });
}));

router.delete("/courses/:id", wrap("DELETE COURSE", async (req, res) => {
  const { aishe_code } = req.institute;
  const doc = await owned(res, "courses", req.params.id, aishe_code, "Course");
  if (!doc) return;

  const abbr = doc.data().abbr;
  const live = (s) => countOf(workingDb.collection("students").where("aishe_code", "==", aishe_code)
    .where("degree", "==", abbr).where("approval_status", "==", s));
  const [approved, pendingN, subjects] = await Promise.all([
    abbr ? live("approved") : 0,
    abbr ? live("pending") : 0,
    countOf(workingDb.collection("subjects").where("aishe_code", "==", aishe_code).where("course_id", "==", doc.id)),
  ]);
  const students = approved + pendingN;
  if (students > 0) return res.status(409).json({ error: `${students} student(s) are enrolled in this course. Remove them first.` });
  if (subjects > 0) return res.status(409).json({ error: `This course still has ${subjects} subject(s). Delete them first.` });

  await doc.ref.delete();
  return res.status(200).json({ success: true, message: "Course deleted." });
}));

// ══════════════════════════════════════════════════════════════════════
// TEACHERS
// ══════════════════════════════════════════════════════════════════════
const TEACHER_STATUS = ["pending", "approved", "rejected"];

// Filters: status, department, head_only, q (name) · Pagination: page, limit (default 10)
router.get("/teachers", wrap("TEACHERS", async (req, res) => {
  const { aishe_code } = req.institute;
  const { status, department, head_only } = req.query;
  const q = str(req.query.q, 80).toLowerCase();
  const pg = pager(req.query, { def: 10, cap: 50 });

  let query = workingDb.collection("teachers").where("aishe_code", "==", aishe_code);
  if (TEACHER_STATUS.includes(status)) query = query.where("approval_status", "==", status);
  const snap = await query.get();

  let teachers = snap.docs.map((d) => ({ teacher_id: d.id, ...d.data() }));
  if (head_only === "true") teachers = teachers.filter((t) => t.designation === "head");
  if (typeof department === "string" && department) {
    teachers = teachers.filter((t) => Array.isArray(t.departments) && t.departments.includes(department));
  }
  if (q) teachers = teachers.filter((t) => personName(t).toLowerCase().includes(q));
  teachers.sort((a, b) => personName(a).localeCompare(personName(b)));

  const total = teachers.length;
  let rows = slicePage(teachers, pg);
  if (pg.explicit) {
    const emails = await emailsFor(rows.map((t) => t.user_id));
    rows = rows.map((t) => ({ ...t, email: emails[t.user_id] || t.email || null }));
  }

  return res.status(200).json({
    success: true,
    teachers: rows.map(publicDoc),
    pagination: pageInfo(total, pg),
  });
}));

router.get("/teachers/:id", wrap("TEACHER DETAIL", async (req, res) => {
  const { aishe_code } = req.institute;
  const doc = await owned(res, "teachers", req.params.id, aishe_code, "Teacher");
  if (!doc) return;
  const data = doc.data();

  const [emails, subjectsSnap] = await Promise.all([
    data.user_id ? emailsFor([data.user_id]) : {},
    workingDb.collection("subjects").where("aishe_code", "==", aishe_code)
      .where("teacher_assigned", "==", doc.id).get(),
  ]);

  return res.status(200).json({
    success: true,
    teacher: publicDoc({ teacher_id: doc.id, ...data, email: emails[data.user_id] || data.email || null }),
    subjects: subjectsSnap.docs.map((s) => ({ subject_id: s.id, ...s.data() })),
  });
}));

async function setTeacherStatus(req, res, status, message) {
  const doc = await owned(res, "teachers", req.params.id, req.institute.aishe_code, "Teacher");
  if (!doc) return;
  if (doc.data().approval_status === "removed") return res.status(409).json({ error: "This teacher was removed." });
  await doc.ref.update({ approval_status: status, updated_at: FieldValue.serverTimestamp() });
  return res.status(200).json({ success: true, message });
}
router.put("/teachers/:id/approve", wrap("TEACHER APPROVE", (req, res) => setTeacherStatus(req, res, "approved", "Teacher approved.")));
router.put("/teachers/:id/reject",  wrap("TEACHER REJECT",  (req, res) => setTeacherStatus(req, res, "rejected", "Teacher rejected.")));

// Body: { designation: "Associate Professor" } - "head" goes through make-head
const DESIGNATIONS = ["Assistant Professor", "Associate Professor", "Professor", "Senior Professor"];
router.put("/teachers/:id/promote", wrap("TEACHER PROMOTE", async (req, res) => {
  const designation = str(req.body.designation, 60);
  if (!DESIGNATIONS.includes(designation)) {
    return res.status(400).json({ error: `Invalid designation. Valid: ${DESIGNATIONS.join(", ")}. Use "Make Head" for head.` });
  }
  const doc = await owned(res, "teachers", req.params.id, req.institute.aishe_code, "Teacher");
  if (!doc) return;
  if (doc.data().designation === "head") {
    return res.status(409).json({ error: "Remove the Head status first, then change the designation." });
  }
  await doc.ref.update({ designation, updated_at: FieldValue.serverTimestamp() });
  return res.status(200).json({ success: true, message: `Teacher promoted to ${designation}.` });
}));

// Makes a teacher the Head of a department (one Head per department; the old one is demoted).
router.put("/teachers/:id/make-head", wrap("MAKE HEAD", async (req, res) => {
  const department = str(req.body.department, 60);
  if (!department) return res.status(400).json({ error: "department is required." });

  const { aishe_code } = req.institute;
  const teacherDoc = await owned(res, "teachers", req.params.id, aishe_code, "Teacher");
  if (!teacherDoc) return;
  const teacher = teacherDoc.data();

  if (teacher.approval_status !== "approved" || teacher.is_active === false) {
    return res.status(400).json({ error: "Teacher must be approved and active before becoming Head." });
  }
  if (!Array.isArray(teacher.departments) || !teacher.departments.includes(department)) {
    return res.status(400).json({ error: `Teacher is not in the ${department} department.` });
  }
  if (teacher.designation === "head") {
    return res.status(409).json({ error: "This teacher is already a Head. Remove the Head status first." });
  }

  const heads = await workingDb.collection("teachers")
    .where("aishe_code", "==", aishe_code).where("designation", "==", "head").get();

  const batch = workingDb.batch();
  heads.docs.forEach((h) => {
    const hd = h.data();
    if (h.id !== teacherDoc.id && Array.isArray(hd.departments) && hd.departments.includes(department)) {
      batch.update(h.ref, {
        designation: hd.previous_designation || "Professor",
        previous_designation: null,
        head_of: null,
        updated_at: FieldValue.serverTimestamp(),
      });
    }
  });
  batch.update(teacherDoc.ref, {
    previous_designation: teacher.designation || null,
    designation: "head",
    head_of: department,
    updated_at: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return res.status(200).json({ success: true, message: `${personName(teacher)} is now Head of ${department}.` });
}));

router.put("/teachers/:id/remove-head", wrap("REMOVE HEAD", async (req, res) => {
  const doc = await owned(res, "teachers", req.params.id, req.institute.aishe_code, "Teacher");
  if (!doc) return;
  const data = doc.data();
  if (data.designation !== "head") return res.status(400).json({ error: "Teacher is not a Head." });

  await doc.ref.update({
    designation: data.previous_designation || "Professor",
    previous_designation: null,
    head_of: null,
    updated_at: FieldValue.serverTimestamp(),
  });
  return res.status(200).json({ success: true, message: "Head status removed." });
}));

async function setTeacherActive(req, res, active, message) {
  const doc = await owned(res, "teachers", req.params.id, req.institute.aishe_code, "Teacher");
  if (!doc) return;
  if (doc.data().approval_status === "removed") return res.status(409).json({ error: "This teacher was removed." });
  await doc.ref.update({ is_active: active, updated_at: FieldValue.serverTimestamp() });
  return res.status(200).json({ success: true, message });
}
router.put("/teachers/:id/deactivate", wrap("TEACHER DEACTIVATE", (req, res) => setTeacherActive(req, res, false, "Teacher deactivated.")));
router.put("/teachers/:id/activate",   wrap("TEACHER ACTIVATE",   (req, res) => setTeacherActive(req, res, true, "Teacher activated.")));

// Soft delete - kept so subject assignment history is preserved
router.delete("/teachers/:id", wrap("TEACHER REMOVE", async (req, res) => {
  const doc = await owned(res, "teachers", req.params.id, req.institute.aishe_code, "Teacher");
  if (!doc) return;
  await doc.ref.update({ approval_status: "removed", is_active: false, updated_at: FieldValue.serverTimestamp() });
  return res.status(200).json({ success: true, message: "Teacher removed." });
}));

// ══════════════════════════════════════════════════════════════════════
// STUDENTS
// ══════════════════════════════════════════════════════════════════════

// ── POST /institute/students/auto-approve-run ─────────────────────────
// Approves every PENDING student of this institute whose verified e-mail is on a
// trusted domain. Uses the same settings as registration (auto_approve_enabled +
// auto_approve_domains). Declared before /students/:id so the path is not read as an id.
router.post("/students/auto-approve-run", bulkLimiter, wrap("AUTO-APPROVE", async (req, res) => {
  const { aishe_code, institute_id } = req.institute;

  const instDoc = await instituteDb.collection(COLLECTIONS.INSTITUTES).doc(institute_id).get();
  if (!instDoc.exists) return res.status(404).json({ error: "Institute not found." });
  const inst = instDoc.data();
  const domains = Array.isArray(inst.auto_approve_domains) ? inst.auto_approve_domains : [];

  if (inst.auto_approve_enabled !== true) {
    return res.status(400).json({ error: "Auto-approve is turned off. Turn it on in Settings first." });
  }
  if (domains.length === 0) {
    return res.status(400).json({ error: "No trusted domains configured. Add one in Settings." });
  }

  const pending = await workingDb.collection("students")
    .where("aishe_code", "==", aishe_code).where("approval_status", "==", "pending").get();
  if (pending.empty) return res.status(200).json({ success: true, approved: 0, message: "No pending students." });

  // users/{uid}.email is the source of truth; the copy on the student doc is the fallback
  const emails = await emailsFor(pending.docs.map((d) => d.data().uid || d.id));
  const match = pending.docs.filter((d) => emailMatches(emails[d.data().uid || d.id] || d.data().email, domains));

  if (match.length === 0) {
    return res.status(200).json({
      success: true, approved: 0,
      message: "No pending students matched the trusted domains.",
    });
  }

  const now = FieldValue.serverTimestamp();
  await commitInChunks(match.map((d) => d.ref), {
    approval_status: "approved", auto_approved: true, auto_approved_at: now, updated_at: now,
  });

  return res.status(200).json({
    success: true,
    approved: match.length,
    message: `${match.length} student(s) approved automatically.`,
  });
}));

// Filters: status, course (degree/abbr), semester, q (name / roll no / e-mail) · Pagination: page, limit
router.get("/students", wrap("STUDENTS", async (req, res) => {
  const { aishe_code } = req.institute;
  const { status, course, semester } = req.query;
  const q = str(req.query.q, 80).toLowerCase();
  const pg = pager(req.query, { def: 10, cap: 50 });

  let query = workingDb.collection("students").where("aishe_code", "==", aishe_code);
  if (TEACHER_STATUS.includes(status)) query = query.where("approval_status", "==", status);
  const snap = await query.get();

  let students = snap.docs.map((d) => ({ student_id: d.id, ...d.data() }));
  if (typeof course === "string" && course) {
    const c = course.toUpperCase();
    students = students.filter((s) => String(s.degree || "").toUpperCase() === c);
  }
  if (semester !== undefined && semester !== "") {
    const n = Number(semester);
    students = students.filter((s) => Number(s.semester) === n);
  }
  if (q) {
    students = students.filter((s) =>
      `${personName(s)} ${s.name || ""} ${s.roll_no || ""} ${s.email || ""}`.toLowerCase().includes(q));
  }
  students.sort((a, b) => (personName(a) || String(a.name || "")).localeCompare(personName(b) || String(b.name || "")));

  const total = students.length;
  let rows = slicePage(students, pg);
  if (pg.explicit) {
    const emails = await emailsFor(rows.map((s) => s.uid || s.student_id));
    rows = rows.map((s) => ({ ...s, email: emails[s.uid || s.student_id] || s.email || null }));
  }

  return res.status(200).json({
    success: true,
    students: rows.map(publicDoc),
    pagination: pageInfo(total, pg),
  });
}));

router.get("/students/:id", wrap("STUDENT DETAIL", async (req, res) => {
  const { aishe_code } = req.institute;
  const doc = await owned(res, "students", req.params.id, aishe_code, "Student");
  if (!doc) return;
  const data = doc.data();

  const emails = await emailsFor([doc.id]);

  const ids = (Array.isArray(data.enrolled_subjects) ? data.enrolled_subjects : [])
    .filter((x) => typeof x === "string" && x).slice(0, 100);
  let subjects = [];
  if (ids.length) {
    const docs = await workingDb.getAll(...ids.map((id) => workingDb.collection("subjects").doc(id)));
    subjects = docs.filter((d) => d.exists && d.data().aishe_code === aishe_code).map((d) => ({ subject_id: d.id, ...d.data() }));
  }

  return res.status(200).json({
    success: true,
    student: publicDoc({ student_id: doc.id, ...data, email: emails[doc.id] || data.email || null }),
    subjects,
  });
}));

async function setStudentStatus(req, res, status, message) {
  const doc = await owned(res, "students", req.params.id, req.institute.aishe_code, "Student");
  if (!doc) return;
  if (doc.data().approval_status === "removed") return res.status(409).json({ error: "This student was removed." });
  await doc.ref.update({ approval_status: status, updated_at: FieldValue.serverTimestamp() });
  return res.status(200).json({ success: true, message });
}
router.put("/students/:id/approve", wrap("STUDENT APPROVE", (req, res) => setStudentStatus(req, res, "approved", "Student approved.")));
router.put("/students/:id/reject",  wrap("STUDENT REJECT",  (req, res) => setStudentStatus(req, res, "rejected", "Student rejected.")));

router.delete("/students/:id", wrap("STUDENT REMOVE", async (req, res) => {
  const doc = await owned(res, "students", req.params.id, req.institute.aishe_code, "Student");
  if (!doc) return;
  await doc.ref.update({ approval_status: "removed", is_active: false, updated_at: FieldValue.serverTimestamp() });
  return res.status(200).json({ success: true, message: "Student removed." });
}));

// ══════════════════════════════════════════════════════════════════════
// SUBJECTS
// ══════════════════════════════════════════════════════════════════════
router.get("/subjects", wrap("SUBJECTS", async (req, res) => {
  const { aishe_code } = req.institute;
  const { course_id, semester, compulsory } = req.query;
  const pg = pager(req.query, { def: 200, cap: 500 });

  let query = workingDb.collection("subjects").where("aishe_code", "==", aishe_code);
  if (typeof course_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(course_id)) query = query.where("course_id", "==", course_id);
  if (typeof semester === "string" && SEM_RE.test(semester)) query = query.where("semester", "==", semester);
  if (compulsory === "true" || compulsory === "false") query = query.where("compulsary", "==", compulsory === "true");

  const snap = await query.get();
  const subjects = snap.docs.map((d) => ({ subject_id: d.id, ...d.data() }))
    .sort((a, b) => String(a.subject_code || "").localeCompare(String(b.subject_code || "")));

  return res.status(200).json({
    success: true,
    subjects: slicePage(subjects, pg),
    pagination: pageInfo(subjects.length, pg),
  });
}));

router.post("/subjects", wrap("ADD SUBJECT", async (req, res) => {
  const { aishe_code } = req.institute;
  const course_id = str(req.body.course_id, 128);
  const subject_name = str(req.body.subject_name), subject_code = str(req.body.subject_code, 30).toUpperCase();
  const semester = str(req.body.semester, 10);

  if (!course_id || !subject_name || !subject_code || !semester) {
    return res.status(400).json({ error: "course_id, subject_name, subject_code and semester are required." });
  }
  if (!SEM_RE.test(semester)) return res.status(400).json({ error: 'semester must look like "Sem 3".' });
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(course_id)) return res.status(400).json({ error: "Invalid course_id." });

  const course = await owned(res, "courses", course_id, aishe_code, "Course");
  if (!course) return;

  let teacher_assigned = null;
  if (req.body.teacher_assigned) {
    const t = await checkTeacher(aishe_code, req.body.teacher_assigned);
    if (!t.ok) return res.status(t.status).json({ error: t.error });
    teacher_assigned = String(req.body.teacher_assigned);
  }

  const dup = await workingDb.collection("subjects").where("aishe_code", "==", aishe_code)
    .where("course_id", "==", course_id).where("semester", "==", semester)
    .where("subject_code", "==", subject_code).limit(1).get();
  if (!dup.empty) return res.status(409).json({ error: `Subject code ${subject_code} already exists in ${semester} of this course.` });

  const ref = workingDb.collection("subjects").doc();
  await ref.set({
    subject_id: ref.id, aishe_code, course_id, subject_name, subject_code, semester,
    compulsary: req.body.compulsary !== false,
    teacher_assigned,
    created_at: FieldValue.serverTimestamp(),
  });
  return res.status(201).json({ success: true, message: "Subject added.", subject_id: ref.id });
}));

router.put("/subjects/:id", wrap("UPDATE SUBJECT", async (req, res) => {
  const { aishe_code } = req.institute;
  const doc = await owned(res, "subjects", req.params.id, aishe_code, "Subject");
  if (!doc) return;
  const b = req.body;

  const update = {};
  if (b.subject_name !== undefined) { update.subject_name = str(b.subject_name); if (!update.subject_name) return res.status(400).json({ error: "subject_name cannot be empty." }); }
  if (b.subject_code !== undefined) { update.subject_code = str(b.subject_code, 30).toUpperCase(); if (!update.subject_code) return res.status(400).json({ error: "subject_code cannot be empty." }); }
  if (b.semester !== undefined) { update.semester = str(b.semester, 10); if (!SEM_RE.test(update.semester)) return res.status(400).json({ error: 'semester must look like "Sem 3".' }); }
  if (b.compulsary !== undefined) update.compulsary = b.compulsary === true;

  // A teacher can only be set if they are a real, active teacher of this institute
  let teacherName;
  if (b.teacher_assigned !== undefined) {
    if (b.teacher_assigned) {
      const t = await checkTeacher(aishe_code, b.teacher_assigned);
      if (!t.ok) return res.status(t.status).json({ error: t.error });
      teacherName = t.name;
      update.teacher_assigned = String(b.teacher_assigned);
    } else {
      update.teacher_assigned = null;
    }
  }
  update.updated_at = FieldValue.serverTimestamp();

  // subject + its lectures are written together
  await updateSubjectAndLectures(doc, update, teacherName);
  return res.status(200).json({ success: true, message: "Subject updated." });
}));

router.put("/subjects/:id/assign", wrap("ASSIGN TEACHER", async (req, res) => {
  const { aishe_code } = req.institute;
  const doc = await owned(res, "subjects", req.params.id, aishe_code, "Subject");
  if (!doc) return;
  const teacher_id = req.body.teacher_id || null;

  let teacherName;
  if (teacher_id) {
    const t = await checkTeacher(aishe_code, teacher_id);
    if (!t.ok) return res.status(t.status).json({ error: t.error });
    teacherName = t.name;
  }

  // subject + all of its lectures (timetable) change teacher together
  const moved = await updateSubjectAndLectures(
    doc,
    { teacher_assigned: teacher_id ? String(teacher_id) : null, updated_at: FieldValue.serverTimestamp() },
    teacherName,
  );
  return res.status(200).json({
    success: true,
    message: teacher_id ? "Teacher assigned." : "Teacher unassigned.",
    lectures_updated: moved,
  });
}));

router.delete("/subjects/:id", wrap("DELETE SUBJECT", async (req, res) => {
  const { aishe_code } = req.institute;
  const doc = await owned(res, "subjects", req.params.id, aishe_code, "Subject");
  if (!doc) return;

  const lectures = await countOf(workingDb.collection("lectures").where("subject_id", "==", doc.id));
  if (lectures > 0) {
    return res.status(409).json({ error: `This subject is in the timetable (${lectures} lecture${lectures > 1 ? "s" : ""}). Ask the head to remove those first.` });
  }
  await doc.ref.delete();
  return res.status(200).json({ success: true, message: "Subject deleted." });
}));

module.exports = { router, prefix: "/institute" };