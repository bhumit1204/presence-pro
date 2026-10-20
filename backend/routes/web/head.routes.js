/**
 * routes/web/head.routes.js
 * Mount: app.use("/api/web/head", require("./routes/web/head.routes"));
 *
 * Management API for a Head of Department (web app "Manage" section).
 *
 * AUTH   Every route needs   Authorization: Bearer <Firebase ID token>.
 *        The token is verified here and the head's status is re-read from the
 *        database on EVERY request (teachers.head_of must be non-empty), so
 *        removing a head in the institute app takes effect immediately.
 *        Nothing is trusted from the client (no ?uid=, no department id).
 *
 * SCOPE  A head only touches courses of their own department:
 *        course.department (if the field exists) otherwise course.abbr must
 *        equal teachers.head_of (e.g. head_of "MCA" -> course abbr "MCA").
 *
 * DATA   Writes to the collections the rest of the app already reads:
 *          subjects            (teacher_assigned = the single allocated teacher)
 *          lectures            (the recurring timetable teachers/students see)
 *          timetable_overrides (one-date changes; applied to `lectures` on the day, restored after it)
 *          semester_dates      (course_id + semester + start_md/end_md, recurring every year)
 *          academic_calendar   (events)
 *          students.enrolled_subjects (kept in sync when subjects are created)
 *        plus two new log collections: head_audit_log, allocation_history.
 *
 * Routes
 *   GET    /context
 *   GET    /teachers
 *   GET    /semesters?course_id=
 *   PUT    /semesters/:course_id/:semester          { start: "MM-DD", end: "MM-DD", also_semesters?: [3] }   (no year — repeats every year)
 *   GET    /subjects?course_id=&semester=
 *   POST   /subjects                                { course_id, subject_name, subject_code, semester, compulsary?, elective_group? }
 *   PUT    /subjects/:id                            { subject_name?, subject_code?, semester?, compulsary?, elective_group? }
 *   DELETE /subjects/:id
 *   POST   /subjects/elective-group                 { course_id, semester, group, group_code?, subjects: [{ subject_name, subject_code? }, ...] }   one choice of n subjects
 *   POST   /elective-groups/rename                  { course_id, semester, from, to }
 *   GET    /subjects/:id/students                   enrolled students (+ for an elective: sibling options and students who have not chosen yet)
 *   POST   /subjects/:id/unenroll                   { student_ids }  elective only: the student chooses again
 *   POST   /subjects/:id/move                       { student_ids, to_subject_id }  elective only: same group
 *   GET    /divisions?course_id=&semester=          divisions with student counts
 *   POST   /divisions                               { course_id, semester, name | names: [] }
 *   PUT    /divisions/:id                           { name }
 *   DELETE /divisions/:id
 *   GET    /divisions/:id/students
 *   POST   /divisions/assign                        { division_id | null, student_ids }
 *   PUT    /subjects/:id/assign                     { teacher_id | null, force? }
 *   GET    /timetable?course_id=&semester=
 *   POST   /timetable                               { course_id, subject_id, day, start_time, end_time, room?, teacher_id?, replaces?: [lectureId], force? }
 *   PUT    /timetable/:id                           { day?, start_time?, end_time?, room?, teacher_id?, force? }
 *   DELETE /timetable/:id
 *   POST   /timetable/overrides                     one-date change: { course_id, kind: "modify"|"cancel"|"special", date, lecture_id?, changes?, special?, replaces?, note?, force? }
 *   DELETE /timetable/overrides/:id                 undo a one-date change
 *   GET    /calendar?academic_year=
 *   POST   /calendar                                { title, start_date, end_date?, event_type?, description?, academic_year? }
 *   PUT    /calendar/:id
 *   DELETE /calendar/:id
 *   POST   /calendar/:id/run                        send the holiday notice / generate the defaulter list now { force? }
 *   GET    /calendar/:id/defaulters                 stored defaulter lists of that event (or a live preview before it runs)
 *   (automation) holiday notices {notice_days} days before (0 = the same day, default 2); defaulter lists on their date → `broadcasts` (automated:true) + `defaulter_lists`
 *   GET    /students?course_id=&semester=&q=&page=&limit=
 *   GET    /students/:id/report?threshold=75
 *   GET    /reports?scope=student|class|department&student_id=&course_id=&semester=&from=&to=&threshold=75   full report: attendance per subject, quizzes, assignments, OD
 *   GET    /audit?limit=
 */

const express = require("express");
const router  = express.Router();
const { admin, db } = require("../../config/firebase");
const win = require("../../services/semesterWindow");
const { TTLCache } = require("../../utils/cache");
const { queueConcurrent, rateLimit } = require("../../utils/limiter");
const { isAlreadyExists } = require("../../utils/firestore");
let sharedVerify = null;
try { sharedVerify = require("../../middleware/auth").verifyToken; } catch { /* optional: falls back to admin.auth() */ }

// ─── Load / speed helpers ────────────────────────────────────────────────────
// This console is used by few people, but each call reads a lot (whole-college student list,
// attendance history). The caches below are short, single-flight and per process.
const headCtxCache       = new TTLCache({ max: 500,  ttlMs: 10_000 });   // who is this head (status re-checked every 10 s)
const collegeCourses     = new TTLCache({ max: 200,  ttlMs: 60_000 });
const collegeStudents    = new TTLCache({ max: 20,   ttlMs: 10_000 });
const attendanceCache    = new TTLCache({ max: 400,  ttlMs: 30_000 });
const reportGate         = queueConcurrent(3, { maxWaitMs: 60_000, maxQueue: 30, message: "Reports are busy, please retry in a few seconds." });
const headLimit          = rateLimit({ windowMs: 60_000, max: 300, key: (req) => (req.head && req.head.uid) || req.ip, name: "head" });
const reportLimit        = rateLimit({ windowMs: 60_000, max: 20,  key: (req) => (req.head && req.head.uid) || req.ip, name: "head-report" });

// run fn over items with at most `n` in flight; results keep the input order
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_ORDER     = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const EVENT_TYPES   = ["holiday", "exam", "defaulter", "event", "working_day_swap", "general"];
const NOTICE_LEAD_DAYS = 2;   // default: holiday notices go out this many days before (the head can choose 0–14 per holiday)
const AUTO_HOUR_IST    = 8;   // automatic notices are sent from 08:00 IST on the due day
const LATE_GRACE_DAYS  = 3;   // a defaulter run missed by the server is still done up to this many days late
const CHUNK         = 30;   // Firestore "in" limit used across the app
const BATCH_LIMIT   = 400;  // stay under Firestore's 500 writes per batch

const ts       = () => admin.firestore.FieldValue.serverTimestamp();
const FieldDelete = () => admin.firestore.FieldValue.delete();
const todayIST = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const up       = (s) => String(s == null ? "" : s).trim().toUpperCase();

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra  = extra;
  }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

// Firestore rejects `undefined` values — strip them from every payload.
/** Elective group name: trimmed, max 40 chars, null when empty (ungrouped optionals form one default group). */
function cleanGroup(v) {
  const g = String(v === undefined || v === null ? "" : v).trim().replace(/\s+/g, " ").slice(0, 40);
  return g || null;
}

function clean(obj) {
  const out = {};
  Object.keys(obj).forEach((k) => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, error: err.message, ...err.extra });
    }
    console.error(`HEAD ROUTE ERROR [${req.method} ${req.originalUrl || req.url}]:`, err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function toISO(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function isDateStr(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function normTime(t) {
  if (typeof t !== "string") return null;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

function parseSem(v) {
  if (v === null || v === undefined || v === "") return null;
  const m = String(v).match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 20 ? n : null;
}
const semLabel = (n) => `Sem ${n}`;

function personName(d = {}) {
  return (`${d.first_name || ""} ${d.last_name || ""}`).trim() || d.name || "Unknown";
}

function totalSemesters(course) {
  const n = Number(course.total_semesters);
  if (n > 0) return n;
  const years = Number(course.duration_years) || parseInt(course.duration, 10);
  if (years > 0) return years * 2;
  return 8;
}

function academicYearOf(dateStr) {
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(5, 7), 10);
  const start = m >= 6 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

async function getAllDocs(refs) {
  if (!refs.length) return [];
  const parts = await Promise.all(chunks(refs, 100).map((c) => db.getAll(...c)));
  return parts.flat();
}

async function commitInBatches(ops) {
  // ops: [(batch) => void]
  for (const part of chunks(ops, BATCH_LIMIT)) {
    const batch = db.batch();
    part.forEach((op) => op(batch));
    await batch.commit();
  }
}

// ─── Auth: verify token, re-read head status from the database ───────────────

async function findTeacherDoc(uid) {
  const snap = await db.collection("teachers").where("user_id", "==", uid).limit(1).get();
  if (!snap.empty) return snap.docs[0];
  // Same fallback the login route uses (whitespace in user_id)
  const all = await db.collection("teachers").where("aishe_code", "!=", "").get();
  return all.docs.find((d) => String(d.data().user_id || "").trim() === uid.trim()) || null;
}

const courseInDepartment = (c, dept) =>
  c.department ? up(c.department) === up(dept) : up(c.abbr) === up(dept);

const collegeCoursesOf = (aishe_code) =>
  collegeCourses.memo(aishe_code, 60_000, async () => {
    const courseSnap = await db.collection("courses").where("aishe_code", "==", aishe_code).get();
    return courseSnap.docs.map((d) => ({ ...d.data(), course_id: d.id }));
  });

// Resolves who is calling. The result is remembered for 10 s per user (the original re-read four
// collections on every single request); a removed head loses access within that time. Refusals are never cached.
async function loadHeadContext(uid) {
  const [userDoc, found] = await Promise.all([db.collection("users").doc(uid).get(), findTeacherDoc(uid)]);
  const deny = (status, error) => { throw { __deny: { status, error } }; };

  if (!userDoc.exists || !userDoc.data().is_active || userDoc.data().role !== "teacher") deny(403, "Access denied");
  const teacherDoc = found;
  if (!teacherDoc) deny(403, "Teacher profile not found");

  const teacher = teacherDoc.data();
  if (teacher.approval_status !== "approved" || teacher.is_active === false) deny(403, "Your account is not active");

  const department = String(teacher.head_of || "").trim();
  if (!department) deny(403, "You are not the head of any department");

  const aishe_code = teacher.aishe_code;
  if (!aishe_code) deny(403, "No institute linked to your account");

  const courses = (await collegeCoursesOf(aishe_code)).filter((c) => courseInDepartment(c, department));
  return {
    uid,
    teacher_id: teacherDoc.id,
    teacher,
    aishe_code,
    department,
    courses,
    courseMap: Object.fromEntries(courses.map((c) => [c.course_id, c])),
  };
}

async function requireHead(req, res, next) {
  try {
    const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ success: false, error: "Authorization token required" });

    let uid = req.auth && req.auth.uid;      // already verified by the app-wide auth middleware
    if (!uid) {
      try {
        uid = sharedVerify ? (await sharedVerify(m[1]) || {}).uid : (await admin.auth().verifyIdToken(m[1])).uid;
      } catch {
        uid = null;
      }
      if (!uid) return res.status(401).json({ success: false, error: "Invalid or expired token" });
    }

    try {
      req.head = await headCtxCache.memo(uid, 10_000, () => loadHeadContext(uid));
    } catch (e) {
      if (e && e.__deny) return res.status(e.__deny.status).json({ success: false, error: e.__deny.error });
      throw e;
    }
    return next();
  } catch (err) {
    console.error("REQUIRE HEAD ERROR:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}

router.use(requireHead);
router.use(headLimit);

function courseOrFail(req, course_id) {
  if (!course_id || typeof course_id !== "string") fail(400, "course_id is required");
  const c = req.head.courseMap[course_id];
  if (!c) fail(403, "This course is not in your department");
  return c;
}

async function audit(req, action, entity, entity_id, details = {}) {
  try {
    await db.collection("head_audit_log").add(clean({
      aishe_code:       req.head.aishe_code,
      department:       req.head.department,
      actor_teacher_id: req.head.teacher_id,
      actor_name:       personName(req.head.teacher),
      action,
      entity,
      entity_id,
      details: clean(details),
      created_at: ts(),
    }));
  } catch (e) {
    console.error("HEAD AUDIT ERROR:", e.message); // never fail the request over a log line
  }
}

// ─── Shared data helpers ─────────────────────────────────────────────────────

async function subjectsOfCourse(course_id) {
  const snap = await db.collection("subjects").where("course_id", "==", course_id).get();
  return snap.docs.map((d) => ({ ...d.data(), subject_id: d.id }));
}

async function loadHeadSubject(req, id) {
  const doc = await db.collection("subjects").doc(String(id)).get();
  if (!doc.exists) fail(404, "Subject not found");
  const subject = { ...doc.data(), subject_id: doc.id };
  if (!req.head.courseMap[subject.course_id]) fail(403, "This subject is not in your department");
  return { ref: doc.ref, subject, course: req.head.courseMap[subject.course_id] };
}

// ─── Subject ⇄ lectures consistency ──────────────────────────────────────────
// `lectures` repeat a few fields of their subject (teacher_id, subject_name…).
// The subject is the source of truth: every place that changes a subject must
// push those fields into its lectures, and GET /subjects heals any drift left
// by other apps (e.g. the institute app only updating `subjects`).
// Only fields a lecture already has are rewritten, except teacher_id /
// subject_name / course_id which every lecture carries.
function lecturePatch(l, subject, teacherName) {
  const p = {};
  // a slot with its own teacher (pinned) or a temporary change running today keeps its teacher
  const ownTeacher = l.teacher_pinned === true || !!l.override_id;
  if (ownTeacher) {
    // teacher untouched
  } else if (subject.teacher_assigned) {
    if (l.teacher_id !== subject.teacher_assigned) p.teacher_id = subject.teacher_assigned;
    if (teacherName && "teacher_name" in l && l.teacher_name !== teacherName) p.teacher_name = teacherName;
  } else if (subject.__unassigning) {
    // teacher removed on purpose: the slots stay in the timetable but belong to nobody
    if (l.teacher_id) p.teacher_id = null;
    if ("teacher_name" in l && l.teacher_name) p.teacher_name = admin.firestore.FieldValue.delete();
  }
  const name = subject.subject_name || "";
  if ((l.subject_name || "") !== name) p.subject_name = name;
  if ("subject_code" in l && subject.subject_code && l.subject_code !== subject.subject_code) p.subject_code = subject.subject_code;
  if ("semester" in l && subject.semester && l.semester !== subject.semester) p.semester = subject.semester;
  if (subject.course_id && l.course_id !== subject.course_id) p.course_id = subject.course_id;
  return p;
}

// ops that bring `lectures` (array of {lecture_id,...}) in line with `subject`
function lectureSyncOps(lectures, subject, teacherName) {
  const ops = [];
  lectures.forEach((l) => {
    const patch = lecturePatch(l, subject, teacherName);
    if (Object.keys(patch).length) {
      ops.push((b) => b.update(db.collection("lectures").doc(l.lecture_id), patch));
    }
  });
  return ops;
}

async function loadHeadLecture(req, id) {
  const doc = await db.collection("lectures").doc(String(id)).get();
  if (!doc.exists) fail(404, "Timetable slot not found");
  const lecture = { ...doc.data(), lecture_id: doc.id };
  if (!req.head.courseMap[lecture.course_id]) fail(403, "This slot is not in your department");
  return { ref: doc.ref, lecture };
}

async function activeTeacherOrFail(req, teacher_id) {
  if (!teacher_id || typeof teacher_id !== "string") fail(400, "teacher_id is required");
  const doc = await db.collection("teachers").doc(teacher_id).get();
  if (!doc.exists) fail(404, "Teacher not found");
  const t = doc.data();
  if (t.aishe_code !== req.head.aishe_code) fail(403, "Teacher belongs to another institute");
  if (t.approval_status !== "approved" || t.is_active === false) fail(400, "Teacher is not active");
  return { id: doc.id, data: t, name: personName(t) };
}

const studentsOfCollege = (aishe_code) =>
  collegeStudents.memo(aishe_code, 10_000, async () => {
    const snap = await db.collection("students").where("aishe_code", "==", aishe_code)
      .select("uid", "name", "first_name", "last_name", "roll_no", "email", "degree", "semester", "approval_status", "course_id", "enrolled_subjects", "aishe_code", "division_id", "division", "semester_status")
      .get();
    return snap.docs.map((d) => ({ ...d.data(), student_id: d.id }));
  });

async function studentsOfCourse(aishe_code, course) {
  return (await studentsOfCollege(aishe_code))
    .filter((s) => (s.course_id && s.course_id === course.course_id) || (s.degree && up(s.degree) === up(course.abbr)));
}

// ─── Elective groups & divisions: shared helpers ─────────────────────────────
const DEFAULT_GROUP = "Elective";
const groupKey = (s) => String(s.elective_group || "").trim() || DEFAULT_GROUP;

function validDivName(v) {
  const n = String(v === undefined || v === null ? "" : v).trim().replace(/\s+/g, " ").toUpperCase();
  if (!n || n.length > 10 || !/^[A-Z0-9][A-Z0-9 -]*$/.test(n)) fail(400, "A division name is 1 to 10 letters or digits, for example A, B or C");
  return n;
}

async function divisionsOfCourse(course_id) {
  const snap = await db.collection("divisions").where("course_id", "==", course_id).get();
  return snap.docs.map((d) => ({ ...d.data(), division_id: d.id }));
}

async function loadHeadDivision(req, id) {
  const doc = await db.collection("divisions").doc(String(id)).get();
  if (!doc.exists) fail(404, "Division not found");
  const division = { ...doc.data(), division_id: doc.id };
  if (!req.head.courseMap[division.course_id]) fail(403, "This division is not in your department");
  return { ref: doc.ref, division, course: req.head.courseMap[division.course_id] };
}

const isActiveStudent = (s) => s.approval_status === "approved" && s.semester_status !== "completed";

// the app's own profile caches (student/lecture endpoints) must not keep serving the old subjects / division
let forgetStudent = () => {};
try { forgetStudent = require("../../utils/students").forgetStudent || forgetStudent; } catch { /* optional */ }
const forgetAll = (list) => {
  (list || []).forEach((st) => { forgetStudent(st.uid || st.student_id); if (st.student_id) forgetStudent(st.student_id); });
  dropProfileCaches((list || []).map((st) => st.uid || st.student_id));
};
function dropProfileCaches(uids = []) {
  try { require("../profile.routes").dropCaches(uids); } catch { /* the profile router is optional here */ }
}

// push to a few students without ever failing the request
function pushTo(uids, title, body, screen) {
  const list = [...new Set((uids || []).filter(Boolean))];
  if (!list.length) return;
  try { notifyFn({ userIds: list, title, body, data: { screen } }); } catch (e) { console.error("HEAD: push failed", e.message); }
}

// Keep students.enrolled_subjects in step with a (compulsory) subject.
async function enrollStudents(req, subject, course, { removeFromSem = null } = {}) {
  const students = (await studentsOfCourse(req.head.aishe_code, course))
    .filter((s) => s.approval_status === "approved");
  const subjectSem = parseSem(subject.semester);
  const ops = [];
  let added = 0;

  students.forEach((s) => {
    const has = Array.isArray(s.enrolled_subjects) && s.enrolled_subjects.includes(subject.subject_id);
    const ref = db.collection("students").doc(s.student_id);

    if (removeFromSem !== null && has && Number(s.semester) === removeFromSem) {
      ops.push((b) => b.update(ref, { enrolled_subjects: admin.firestore.FieldValue.arrayRemove(subject.subject_id) }));
      return;
    }
    const wanted = subject.compulsary !== false && Number(s.semester) === subjectSem;
    if (wanted && !has) {
      ops.push((b) => b.update(ref, { enrolled_subjects: admin.firestore.FieldValue.arrayUnion(subject.subject_id) }));
      added++;
    }
  });

  await commitInBatches(ops);
  collegeStudents.del(req.head.aishe_code);
  return added;
}

// ─── Timetable conflict checks ───────────────────────────────────────────────
const weekdayOf = (date) => DAY_ORDER[(new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7];
const addDays   = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Every lecture of the institute on one weekday, with `sem` (number) and
// `teacher_name` resolved in memory (older docs lack both).
async function loadDayLectures(req, day, course_id) {
  const snap = await db.collection("lectures")
    .where("aishe_code", "==", req.head.aishe_code)
    .where("day", "==", day)
    .get();
  const list = snap.docs.map((d) => ({ ...d.data(), lecture_id: d.id }));

  const needSem = list.filter((l) => l.course_id === course_id && parseSem(l.semester) === null && l.subject_id);
  const subjSem = {};
  if (needSem.length) {
    const ids = [...new Set(needSem.map((l) => l.subject_id))];
    (await getAllDocs(ids.map((id) => db.collection("subjects").doc(id))))
      .forEach((d) => { if (d.exists) subjSem[d.id] = parseSem(d.data().semester); });
  }
  const tIds = [...new Set(list.filter((l) => l.teacher_id && !l.teacher_name).map((l) => l.teacher_id))];
  const names = {};
  if (tIds.length) {
    (await getAllDocs(tIds.map((id) => db.collection("teachers").doc(id))))
      .forEach((d) => { if (d.exists) names[d.id] = personName(d.data()); });
  }
  list.forEach((l) => {
    l.sem = parseSem(l.semester) !== null ? parseSem(l.semester) : (subjSem[l.subject_id] ?? null);
    if (!l.teacher_name && l.teacher_id) l.teacher_name = names[l.teacher_id] || "";
  });
  return list;
}

// marks lectures of elective subjects with `egroup` (course|semester|group) so the options of one group may share a time slot
async function annotateElectiveGroups(list, course_id) {
  if (!list.some((l) => l.course_id === course_id && l.subject_id)) return;
  const subs = await subjectsOfCourse(course_id);
  const byId = Object.fromEntries(subs.filter((x) => x.compulsary === false).map((x) => [x.subject_id, `${parseSem(x.semester)}|${groupKey(x)}`]));
  list.forEach((l) => { if (l.course_id === course_id && byId[l.subject_id]) l.egroup = byId[l.subject_id]; });
}
const egroupOfSubject = (subject) => (subject && subject.compulsary === false ? `${parseSem(subject.semester)}|${groupKey(subject)}` : undefined);

async function egroupOfSubjectId(id) {
  const d = await db.collection("subjects").doc(String(id)).get();
  return d.exists ? egroupOfSubject(d.data()) : undefined;
}

async function divisionOrFail(req, course, sem, id) {
  if (!id) return null;
  const { division } = await loadHeadDivision(req, id);
  if (division.course_id !== course.course_id || parseSem(division.semester) !== sem) fail(400, "That division belongs to another course or semester");
  return division;
}

// cand: { day, start_time, end_time, room, course_id, semester, teacher_id, division_id?, egroup? }
// list: lectures of that day (already filtered / with overrides applied)
function conflictsAgainst(list, cand) {
  const s = toMin(cand.start_time), e = toMin(cand.end_time);
  const conflicts = [];
  list.forEach((l) => {
    if (!overlaps(s, e, toMin(l.start_time), toMin(l.end_time))) return;
    const base = {
      lecture_id: l.lecture_id, subject_name: l.subject_name || "",
      day: l.day, start_time: l.start_time, end_time: l.end_time,
    };
    if (cand.teacher_id && l.teacher_id === cand.teacher_id) {
      conflicts.push({ type: "teacher", message: `${l.teacher_name || "This teacher"} already teaches ${l.subject_name || "another class"} at ${l.start_time}-${l.end_time}`, ...base });
    }
    if (cand.room && l.room && up(l.room) === up(cand.room)) {
      conflicts.push({ type: "room", message: `Room ${l.room} is already used by ${l.subject_name || "another class"} at ${l.start_time}-${l.end_time}`, ...base });
    }
    // two lectures share students unless they are for different divisions, or are two options of one elective group
    const sharesStudents = (!cand.division_id || !l.division_id || cand.division_id === l.division_id) &&
      !(cand.egroup && l.egroup && cand.egroup === l.egroup);
    if (sharesStudents && l.course_id === cand.course_id && cand.semester !== null && cand.semester !== undefined && l.sem === cand.semester) {
      conflicts.push({ type: "class", message: `This semester already has ${l.subject_name || "a class"} at ${l.start_time}-${l.end_time}`, ...base });
    }
  });
  return conflicts;
}

// Conflict check for one candidate timetable slot (permanent changes).
async function findConflicts(req, cand) {
  const list = (await loadDayLectures(req, cand.day, cand.course_id))
    .filter((l) => l.lecture_id !== cand.exclude_id && !(cand.exclude_ids || []).includes(l.lecture_id));
  await annotateElectiveGroups(list, cand.course_id);
  return conflictsAgainst(list, cand);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /context
// ─────────────────────────────────────────────────────────────────────────────
router.get("/context", wrap(async (req, res) => {
  const { teacher, teacher_id, department, aishe_code, courses } = req.head;
  return res.json({
    success: true,
    head: {
      teacher_id,
      name: personName(teacher),
      designation: teacher.designation || null,
      department,
      aishe_code,
    },
    courses: courses.map((c) => ({
      course_id: c.course_id,
      course_name: c.course_name || "",
      abbr: c.abbr || "",
      total_semesters: totalSemesters(c),
    })),
    today: todayIST(),
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /teachers   — approved teachers of the institute (+ current workload)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/teachers", wrap(async (req, res) => {
  const { aishe_code, department } = req.head;

  const [teacherSnap, lectureSnap, subjectSnap] = await Promise.all([
    db.collection("teachers").where("aishe_code", "==", aishe_code).get(),
    db.collection("lectures").where("aishe_code", "==", aishe_code).select("teacher_id", "start_time", "end_time").get(),
    db.collection("subjects").where("aishe_code", "==", aishe_code).select("teacher_assigned").get(),
  ]);

  const lectureCount = {}, minutes = {}, subjectCount = {};
  lectureSnap.docs.forEach((d) => {
    const l = d.data();
    if (!l.teacher_id) return;
    lectureCount[l.teacher_id] = (lectureCount[l.teacher_id] || 0) + 1;
    minutes[l.teacher_id] = (minutes[l.teacher_id] || 0) + Math.max(0, toMin(l.end_time) - toMin(l.start_time));
  });
  subjectSnap.docs.forEach((d) => {
    const t = d.data().teacher_assigned;
    if (t) subjectCount[t] = (subjectCount[t] || 0) + 1;
  });

  const teachers = teacherSnap.docs
    .filter((d) => d.data().approval_status === "approved" && d.data().is_active !== false)
    .map((d) => {
      const t = d.data();
      const depts = Array.isArray(t.departments) ? t.departments : [];
      return {
        teacher_id: d.id,
        name: personName(t),
        designation: t.designation || null,
        departments: depts,
        in_department: depts.some((x) => up(x) === up(department)),
        subject_count: subjectCount[d.id] || 0,
        lecture_count: lectureCount[d.id] || 0,
        weekly_hours: Math.round(((minutes[d.id] || 0) / 60) * 10) / 10,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return res.json({ success: true, teachers });
}));

// ─────────────────────────────────────────────────────────────────────────────
// SEMESTERS — recurring windows: the head enters only day + month, and every
// year's real dates are derived from them (services/semesterWindow.js).
// ─────────────────────────────────────────────────────────────────────────────

// start/end "MM-DD" of a semester_dates doc (older docs stored full dates)
function readWindow(row) {
  if (!row) return null;
  const start = win.normalizeMD(row.start_md || row.start_date || "");
  const end   = win.normalizeMD(row.end_md || row.end_date || "");
  return start && end && start !== end ? { start, end } : null;
}

function semesterRow(n, w) {
  const base = { semester: n, label: semLabel(n) };
  if (!w) return { ...base, start_md: null, end_md: null, wraps: false, length_days: null, status: "not_set", run: null, previous_run: null };
  const r = win.resolveRun(w.start, w.end, todayIST());
  return {
    ...base,
    start_md: w.start,
    end_md: w.end,
    wraps: win.wraps(w.start, w.end),
    length_days: win.spanDays(w.start, w.end),
    status: r.status,          // "active" | "upcoming" (next run)
    run: r.run,                // the run in progress, or the next one
    previous_run: r.previous,  // latest run that already ended
  };
}

router.get("/semesters", wrap(async (req, res) => {
  const course = courseOrFail(req, req.query.course_id);
  const snap = await db.collection("semester_dates").where("course_id", "==", course.course_id).get();

  const byNum = {};
  snap.docs.forEach((d) => {
    const n = parseSem(d.data().semester);
    if (n !== null) byNum[n] = d.data();
  });

  const total = totalSemesters(course);
  const semesters = [];
  for (let n = 1; n <= total; n++) semesters.push(semesterRow(n, readWindow(byNum[n])));
  return res.json({ success: true, course_id: course.course_id, abbr: course.abbr, semesters });
}));

router.put("/semesters/:course_id/:semester", wrap(async (req, res) => {
  const course = courseOrFail(req, req.params.course_id);
  const total = totalSemesters(course);
  const n = parseSem(req.params.semester);
  if (n === null || n > total) fail(400, `semester must be between 1 and ${total}`);

  const body = req.body || {};
  const start = win.normalizeMD(body.start !== undefined ? body.start : body.start_date);
  const end   = win.normalizeMD(body.end   !== undefined ? body.end   : body.end_date);
  if (!start || !end) fail(400, "start and end must be a valid day and month (MM-DD)");
  if (start === end) fail(400, "start and end can't be the same day");

  // optional: apply the same window to other semesters (e.g. 1 & 3 run together)
  let targets = [n];
  if (body.also_semesters !== undefined) {
    if (!Array.isArray(body.also_semesters)) fail(400, "also_semesters must be a list of semester numbers");
    body.also_semesters.forEach((v) => {
      const m = parseSem(v);
      if (m === null || m > total) fail(400, `also_semesters must be between 1 and ${total}`);
      if (!targets.includes(m)) targets.push(m);
    });
  }

  const snap = await db.collection("semester_dates").where("course_id", "==", course.course_id).get();
  const docByNum = {}, winByNum = {};
  snap.docs.forEach((d) => {
    const num = parseSem(d.data().semester);
    if (num === null) return;
    docByNum[num] = d;
    const w = readWindow(d.data());
    if (w) winByNum[num] = w;
  });

  const ops = targets.map((num) => (b) => {
    const payload = clean({
      course_id: course.course_id,
      aishe_code: req.head.aishe_code,
      department: req.head.department,
      semester: num,
      start_md: start,
      end_md: end,
      recurring: true,
      updated_by: req.head.teacher_id,
      updated_at: ts(),
    });
    if (docByNum[num]) {
      // drop old full-date fields so nothing stale is left behind
      b.update(docByNum[num].ref, {
        ...payload,
        start_date: admin.firestore.FieldValue.delete(),
        end_date: admin.firestore.FieldValue.delete(),
      });
    } else {
      b.set(db.collection("semester_dates").doc(`${course.course_id}_sem${num}`), { ...payload, created_at: ts() });
    }
  });
  await commitInBatches(ops);

  // Warn (don't block) when a semester of the OTHER term overlaps. Same-parity
  // semesters (1 & 3, 2 & 4) are different cohorts running together — expected.
  const warnings = [];
  targets.forEach((num) => {
    Object.keys(winByNum).map(Number)
      .filter((o) => !targets.includes(o) && o % 2 !== num % 2)
      .forEach((o) => {
        const w = winByNum[o];
        if (win.windowsOverlap(start, end, w.start, w.end)) {
          const msg = `${semLabel(num)} overlaps with ${semLabel(o)} (${win.formatMD(w.start)} – ${win.formatMD(w.end)})`;
          if (!warnings.includes(msg)) warnings.push(msg);
        }
      });
  });

  const w = { start, end };
  await audit(req, "semester.set_dates", "semester_dates", `${course.course_id}:${targets.join(",")}`, {
    course: course.abbr, semesters: targets.join(","), start, end,
  });

  return res.json({
    success: true,
    semester: semesterRow(n, w),
    updated: targets.filter((x) => x !== n).map((x) => semesterRow(x, w)),
    warnings,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// SUBJECTS
// ─────────────────────────────────────────────────────────────────────────────
router.get("/subjects", wrap(async (req, res) => {
  const { course_id, semester } = req.query;
  const courses = course_id ? [courseOrFail(req, course_id)] : req.head.courses;
  const wantSem = semester ? parseSem(semester) : null;
  if (semester && wantSem === null) fail(400, "Invalid semester");

  let subjects = [];
  for (const parts of await Promise.all(courses.map((c) => subjectsOfCourse(c.course_id)))) subjects.push(...parts);
  if (wantSem !== null) subjects = subjects.filter((s) => parseSem(s.semester) === wantSem);

  // lectures of THESE subjects, grouped by subject (the original read every lecture of the college)
  const lecDocs = [];
  for (const part of await Promise.all(chunks(subjects.map((s) => s.subject_id), CHUNK).map((c) => db.collection("lectures").where("subject_id", "in", c).get()))) {
    lecDocs.push(...part.docs);
  }
  const bySubject = {};
  lecDocs.forEach((d) => {
    const l = { ...d.data(), lecture_id: d.id };
    if (l.subject_id) (bySubject[l.subject_id] = bySubject[l.subject_id] || []).push(l);
  });

  const teacherIds = new Set(subjects.map((s) => s.teacher_assigned).filter(Boolean));
  subjects.forEach((s) => (bySubject[s.subject_id] || []).forEach((l) => l.teacher_id && teacherIds.add(l.teacher_id)));
  const teacherDocs = await getAllDocs([...teacherIds].map((id) => db.collection("teachers").doc(id)));
  const names = {};
  teacherDocs.forEach((d) => { if (d.exists) names[d.id] = personName(d.data()); });

  // heal lectures that drifted from their subject (never blocks the response)
  try {
    const ops = [];
    subjects.forEach((s) => {
      ops.push(...lectureSyncOps(bySubject[s.subject_id] || [], s, names[s.teacher_assigned]));
    });
    if (ops.length) await commitInBatches(ops);
  } catch (err) {
    console.error("HEAD: lecture sync failed", err);
  }

  subjects.sort((a, b) =>
    (parseSem(a.semester) || 0) - (parseSem(b.semester) || 0) ||
    String(a.subject_code || "").localeCompare(String(b.subject_code || "")));

  // how many students sit in each subject, and who has not chosen in each elective group yet
  const enrolledCount = {};
  const groupStats = new Map();
  {
    const seen = new Set();
    const pool = [];
    for (const part of await Promise.all(courses.map((c) => studentsOfCourse(req.head.aishe_code, c)))) {
      part.forEach((st) => { if (!seen.has(st.student_id) && isActiveStudent(st)) { seen.add(st.student_id); pool.push(st); } });
    }
    pool.forEach((st) => (Array.isArray(st.enrolled_subjects) ? st.enrolled_subjects : []).forEach((id) => { enrolledCount[id] = (enrolledCount[id] || 0) + 1; }));
    subjects.filter((x) => x.compulsary === false).forEach((x) => {
      const sem = parseSem(x.semester);
      const key = `${x.course_id}|${sem}|${groupKey(x)}`;
      if (!groupStats.has(key)) groupStats.set(key, { course_id: x.course_id, semester_number: sem, group: groupKey(x), code: x.elective_code || null, subject_ids: [], eligible: 0, chosen: 0 });
      const g = groupStats.get(key);
      g.subject_ids.push(x.subject_id);
      if (x.elective_code && !g.code) g.code = x.elective_code;
    });
    groupStats.forEach((g) => {
      pool.forEach((st) => {
        if (st.course_id !== g.course_id && !(st.degree && up(st.degree) === up((req.head.courseMap[g.course_id] || {}).abbr))) return;
        if (parseSem(st.semester) !== g.semester_number) return;
        g.eligible++;
        if ((st.enrolled_subjects || []).some((id) => g.subject_ids.includes(id))) g.chosen++;
      });
    });
  }

  return res.json({
    success: true,
    elective_groups: [...groupStats.values()].map((g) => ({ ...g, pending: g.eligible - g.chosen })),
    subjects: subjects.map((s) => {
      const lecs = bySubject[s.subject_id] || [];
      // an unassigned subject whose timetable slots still name a teacher
      const stale = !s.teacher_assigned ? lecs.find((l) => l.teacher_id) : null;
      return {
        subject_id: s.subject_id,
        course_id: s.course_id,
        course_abbr: (req.head.courseMap[s.course_id] || {}).abbr || "",
        subject_name: s.subject_name || "",
        subject_code: s.subject_code || "",
        semester: s.semester || null,
        semester_number: parseSem(s.semester),
        compulsary: s.compulsary !== false,
        elective_group: s.compulsary !== false ? null : (s.elective_group || null),
        elective_code: s.compulsary !== false ? null : (s.elective_code || null),
        student_count: enrolledCount[s.subject_id] || 0,
        teacher_assigned: s.teacher_assigned || null,
        teacher_name: s.teacher_assigned ? (names[s.teacher_assigned] || "Unknown") : null,
        created_by_role: s.created_by_role || "institute",
        lecture_count: lecs.length,
        timetable_teacher_name: stale ? (names[stale.teacher_id] || "Unknown") : null,
      };
    }),
  });
}));

router.post("/subjects", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);

  const subject_name = String(body.subject_name || "").trim();
  const subject_code = String(body.subject_code || "").trim().toUpperCase();
  const n = parseSem(body.semester);
  if (!subject_name || !subject_code) fail(400, "subject_name and subject_code are required");
  if (n === null || n > totalSemesters(course)) fail(400, `semester must be between 1 and ${totalSemesters(course)}`);

  const existing = await subjectsOfCourse(course.course_id);
  if (existing.some((s) => up(s.subject_code) === subject_code)) {
    fail(409, `A subject with code ${subject_code} already exists in ${course.abbr}`);
  }

  const compulsary = body.compulsary !== false;
  const elective_group = compulsary ? null : cleanGroup(body.elective_group);
  const elective_code = compulsary ? null : (String(body.elective_code || "").trim().toUpperCase().slice(0, 20) || null);
  const ref = db.collection("subjects").doc();
  const doc = clean({
    subject_id: ref.id,
    aishe_code: req.head.aishe_code,
    course_id: course.course_id,
    subject_name,
    subject_code,
    semester: semLabel(n),
    compulsary,
    elective_group,
    elective_code,
    teacher_assigned: null,
    department: req.head.department,
    created_by: req.head.teacher_id,
    created_by_role: "head",
    created_at: ts(),
  });
  await ref.set(doc);

  let enrolled = 0;
  if (compulsary && body.enroll_students !== false) {
    enrolled = await enrollStudents(req, { ...doc, subject_id: ref.id }, course);
  }

  dropProfileCaches();
  await audit(req, "subject.create", "subjects", ref.id, { subject_code, semester: n, course: course.abbr });
  return res.status(201).json({ success: true, subject_id: ref.id, enrolled_students: enrolled });
}));

router.put("/subjects/:id", wrap(async (req, res) => {
  const { ref, subject, course } = await loadHeadSubject(req, req.params.id);
  const body = req.body || {};
  const update = {};

  if (body.subject_name !== undefined) {
    const v = String(body.subject_name).trim();
    if (!v) fail(400, "subject_name cannot be empty");
    update.subject_name = v;
  }
  if (body.subject_code !== undefined) {
    const v = String(body.subject_code).trim().toUpperCase();
    if (!v) fail(400, "subject_code cannot be empty");
    if (v !== up(subject.subject_code)) {
      const others = await subjectsOfCourse(course.course_id);
      if (others.some((s) => s.subject_id !== subject.subject_id && up(s.subject_code) === v)) {
        fail(409, `A subject with code ${v} already exists in ${course.abbr}`);
      }
    }
    update.subject_code = v;
  }

  const oldSem = parseSem(subject.semester);
  let newSem = oldSem;
  if (body.semester !== undefined) {
    newSem = parseSem(body.semester);
    if (newSem === null || newSem > totalSemesters(course)) fail(400, `semester must be between 1 and ${totalSemesters(course)}`);
    if (newSem !== oldSem) {
      const lec = await db.collection("lectures").where("subject_id", "==", subject.subject_id).limit(1).get();
      if (!lec.empty) fail(409, "Remove this subject's timetable slots before moving it to another semester");
      update.semester = semLabel(newSem);
    }
  }
  if (body.compulsary !== undefined) update.compulsary = body.compulsary !== false;
  // elective group: "Elective 1", "Elective 2" ... (students pick ONE subject from each group)
  if (body.elective_group !== undefined || update.compulsary === true) {
    const willBeCompulsory = update.compulsary !== undefined ? update.compulsary : subject.compulsary !== false;
    update.elective_group = willBeCompulsory ? null : cleanGroup(body.elective_group !== undefined ? body.elective_group : subject.elective_group);
  }

  if (body.elective_code !== undefined) {
    const willBeCompulsory = update.compulsary !== undefined ? update.compulsary : subject.compulsary !== false;
    update.elective_code = willBeCompulsory ? FieldDelete() : (String(body.elective_code || "").trim().toUpperCase().slice(0, 20) || FieldDelete());
  }

  if (!Object.keys(update).length) fail(400, "Nothing to update");

  // An elective that students have already chosen cannot leave its group, become compulsory or change semester
  if (subject.compulsary === false) {
    const leaving = (update.compulsary === true) ||
      (update.elective_group !== undefined && groupKey({ elective_group: update.elective_group }) !== groupKey(subject)) ||
      (update.semester !== undefined);
    if (leaving) {
      const n = (await studentsOfCourse(req.head.aishe_code, course)).filter((st) => (st.enrolled_subjects || []).includes(subject.subject_id)).length;
      if (n) fail(409, `${n} student${n === 1 ? " has" : "s have"} chosen this elective. Move or unenroll them first.`, { enrolled: n });
    }
  }
  update.updated_at = ts();
  await ref.update(clean(update));

  // Keep this subject's timetable slots in step (name / code changes)
  if (update.subject_name !== undefined || update.subject_code !== undefined) {
    const lecs = (await db.collection("lectures").where("subject_id", "==", subject.subject_id).get())
      .docs.map((d) => ({ ...d.data(), lecture_id: d.id }));
    await commitInBatches(lectureSyncOps(lecs, { ...subject, ...update }));
  }

  // Keep enrolment consistent when the semester or compulsory flag changed
  const merged = { ...subject, ...update, semester: update.semester || subject.semester };
  let enrolled = 0;
  if (update.semester || update.compulsary !== undefined) {
    enrolled = await enrollStudents(req, merged, course, { removeFromSem: update.semester ? oldSem : null });
  }

  dropProfileCaches();
  await audit(req, "subject.update", "subjects", subject.subject_id, clean({ ...update, updated_at: undefined, elective_code: undefined }));
  return res.json({ success: true, enrolled_students: enrolled });
}));

router.delete("/subjects/:id", wrap(async (req, res) => {
  const { ref, subject, course } = await loadHeadSubject(req, req.params.id);
  const id = subject.subject_id;

  const [lec, att, quiz, asg] = await Promise.all([
    db.collection("lectures").where("subject_id", "==", id).limit(1).get(),
    db.collection("attendance_records").where("subject_id", "==", id).limit(1).get(),
    db.collection("quizzes").where("subject_id", "==", id).limit(1).get(),
    db.collection("assignments").where("subject_id", "==", id).limit(1).get(),
  ]);
  const used = [];
  if (!lec.empty)  used.push("timetable slots");
  if (!att.empty)  used.push("attendance records");
  if (!quiz.empty) used.push("quizzes");
  if (!asg.empty)  used.push("assignments");
  if (used.length) {
    fail(409, `This subject can't be deleted because it has ${used.join(", ")}. Remove the timetable slots, or unassign its teacher instead.`, { in_use: used });
  }

  // clean enrolment references, then delete
  const students = (await studentsOfCourse(req.head.aishe_code, course))
    .filter((s) => Array.isArray(s.enrolled_subjects) && s.enrolled_subjects.includes(id));
  const delSem = parseSem(subject.semester);
  await commitInBatches(students.map((s) => (b) => {
    const sref = db.collection("students").doc(s.student_id);
    b.update(sref, { enrolled_subjects: admin.firestore.FieldValue.arrayRemove(id) });
    if (subject.compulsary === false && delSem !== null) {
      b.set(sref, { elective_choices: { [String(delSem)]: { [groupKey(subject)]: FieldDelete() } } }, { merge: true });
    }
  }));
  collegeStudents.del(req.head.aishe_code);
  await ref.delete();

  dropProfileCaches();
  await audit(req, "subject.delete", "subjects", id, { subject_code: subject.subject_code });
  return res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// ELECTIVE GROUPS  (one choice out of n subjects)
// A group ("Elective 1") holds n subjects; every student of that semester picks exactly one.
// students.elective_choices[semester][group] = subject_id, and the subject is added to enrolled_subjects.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/subjects/elective-group", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);
  const n = parseSem(body.semester);
  if (n === null || n > totalSemesters(course)) fail(400, `semester must be between 1 and ${totalSemesters(course)}`);
  const group = cleanGroup(body.group !== undefined ? body.group : body.elective_group);
  if (!group) fail(400, "Give the elective group a name, for example Elective 1");
  const groupCode = String(body.group_code || "").trim().toUpperCase().slice(0, 20) || null;

  const list = Array.isArray(body.subjects) ? body.subjects : [];
  if (list.length < 2) fail(400, "An elective needs at least two subjects to choose from");
  if (list.length > 20) fail(400, "At most 20 subjects in one elective group");

  const existing = await subjectsOfCourse(course.course_id);
  if (existing.some((x) => parseSem(x.semester) === n && x.compulsary === false && up(groupKey(x)) === up(group))) {
    fail(409, `${group} already exists in ${semLabel(n)}. Pick another name, or add subjects to it one at a time.`);
  }
  const taken = new Set(existing.map((x) => up(x.subject_code)));
  const rows = list.map((it, i) => {
    const subject_name = String((it && it.subject_name) || "").trim().slice(0, 120);
    let subject_code = String((it && it.subject_code) || "").trim().toUpperCase().slice(0, 30);
    if (!subject_code && groupCode) subject_code = `${groupCode}-${i + 1}`;
    if (!subject_name) fail(400, `Subject ${i + 1}: enter a name`);
    if (!subject_code) fail(400, `Subject ${i + 1}: enter a subject code`);
    return { subject_name, subject_code };
  });
  const inBatch = new Set();
  rows.forEach((r) => {
    if (inBatch.has(r.subject_code)) fail(400, `The code ${r.subject_code} is used twice in this group`);
    inBatch.add(r.subject_code);
    if (taken.has(r.subject_code)) fail(409, `A subject with code ${r.subject_code} already exists in ${course.abbr}`);
  });

  const ops = [];
  const created = rows.map((r) => {
    const ref = db.collection("subjects").doc();
    ops.push((b) => b.set(ref, clean({
      subject_id: ref.id, aishe_code: req.head.aishe_code, course_id: course.course_id,
      subject_name: r.subject_name, subject_code: r.subject_code, semester: semLabel(n),
      compulsary: false, elective_group: group, elective_code: groupCode || undefined,
      teacher_assigned: null, department: req.head.department,
      created_by: req.head.teacher_id, created_by_role: "head", created_at: ts(),
    })));
    return { subject_id: ref.id, ...r };
  });
  await commitInBatches(ops);
  collegeStudents.del(req.head.aishe_code);

  const students = (await studentsOfCourse(req.head.aishe_code, course)).filter((st) => isActiveStudent(st) && parseSem(st.semester) === n);
  pushTo(students.map((st) => st.uid || st.student_id), "Choose your elective", `${group} is open for ${semLabel(n)}. Pick one subject.`, "ElectiveSelection");

  dropProfileCaches();
  await audit(req, "elective.group.create", "subjects", created[0].subject_id, { group, semester: n, course: course.abbr, subjects: created.length });
  return res.status(201).json({ success: true, group, subjects: created, notified: students.length });
}));

router.post("/elective-groups/rename", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);
  const n = parseSem(body.semester);
  if (n === null) fail(400, "semester is required");
  const from = cleanGroup(body.from) || DEFAULT_GROUP;
  const to = cleanGroup(body.to);
  if (!to) fail(400, "Enter the new group name");

  const subs = (await subjectsOfCourse(course.course_id)).filter((x) => parseSem(x.semester) === n && x.compulsary === false);
  const mine = subs.filter((x) => groupKey(x) === from);
  if (!mine.length) fail(404, "That elective group was not found");
  if (up(from) !== up(to) && subs.some((x) => up(groupKey(x)) === up(to))) fail(409, `${to} already exists in ${semLabel(n)}`);

  const students = (await studentsOfCourse(req.head.aishe_code, course)).filter((st) => (st.enrolled_subjects || []).some((id) => mine.some((m) => m.subject_id === id)));
  await commitInBatches([
    ...mine.map((m) => (b) => b.update(db.collection("subjects").doc(m.subject_id), { elective_group: to, updated_at: ts() })),
    ...students.map((st) => (b) => {
      const chosen = mine.find((m) => (st.enrolled_subjects || []).includes(m.subject_id));
      if (!chosen) return;
      b.set(db.collection("students").doc(st.student_id), { elective_choices: { [String(n)]: { [to]: chosen.subject_id, ...(to !== from ? { [from]: FieldDelete() } : {}) } } }, { merge: true });
    }),
  ]);
  collegeStudents.del(req.head.aishe_code);
  dropProfileCaches();
  await audit(req, "elective.group.rename", "subjects", mine[0].subject_id, { from, to, semester: n });
  return res.json({ success: true, group: to });
}));

async function loadElectiveSubject(req, id) {
  const found = await loadHeadSubject(req, id);
  if (found.subject.compulsary !== false) fail(400, "Only elective subjects can be changed here. Compulsory subjects follow the student's semester.");
  const sem = parseSem(found.subject.semester);
  if (sem === null) fail(400, "This subject has no valid semester");
  return { ...found, sem, group: groupKey(found.subject) };
}

router.get("/subjects/:id/students", wrap(async (req, res) => {
  const { subject, course } = await loadHeadSubject(req, req.params.id);
  const all = (await studentsOfCourse(req.head.aishe_code, course)).filter(isActiveStudent);
  const view = (st) => ({ ...studentView(st), division_id: st.division_id || null, division: st.division || null });
  const byRoll = (a, b) => String(a.roll_no || "").localeCompare(String(b.roll_no || ""), undefined, { numeric: true }) || a.name.localeCompare(b.name);
  const out = {
    success: true,
    subject: { subject_id: subject.subject_id, subject_name: subject.subject_name || "", subject_code: subject.subject_code || "", compulsary: subject.compulsary !== false, elective_group: subject.compulsary === false ? groupKey(subject) : null, semester_number: parseSem(subject.semester) },
    students: all.filter((st) => (st.enrolled_subjects || []).includes(subject.subject_id)).map(view).sort(byRoll),
  };
  if (subject.compulsary === false) {
    const sem = parseSem(subject.semester);
    const sibs = (await subjectsOfCourse(course.course_id)).filter((x) => x.compulsary === false && parseSem(x.semester) === sem && groupKey(x) === groupKey(subject));
    const ids = sibs.map((x) => x.subject_id);
    out.siblings = sibs.map((x) => ({
      subject_id: x.subject_id, subject_name: x.subject_name || "", subject_code: x.subject_code || "",
      student_count: all.filter((st) => (st.enrolled_subjects || []).includes(x.subject_id)).length,
    })).sort((a, b) => a.subject_code.localeCompare(b.subject_code));
    out.pending_students = all.filter((st) => parseSem(st.semester) === sem && !(st.enrolled_subjects || []).some((id) => ids.includes(id))).map(view).sort(byRoll);
  }
  return res.json(out);
}));

function pickStudentIds(body) {
  const ids = Array.isArray(body.student_ids) ? [...new Set(body.student_ids.filter((x) => typeof x === "string" && x && !x.includes("/")))] : [];
  if (!ids.length) fail(400, "Pick at least one student");
  if (ids.length > 500) fail(400, "At most 500 students at a time");
  return ids;
}

// The student is taken out of the subject and the group is opened again, so the app asks them to choose.
router.post("/subjects/:id/unenroll", wrap(async (req, res) => {
  const { subject, course, sem, group } = await loadElectiveSubject(req, req.params.id);
  const ids = pickStudentIds(req.body || {});
  const roster = new Map((await studentsOfCourse(req.head.aishe_code, course)).map((st) => [st.student_id, st]));
  const targets = ids.map((id) => roster.get(id)).filter((st) => st && (st.enrolled_subjects || []).includes(subject.subject_id));
  if (!targets.length) fail(404, "None of those students is enrolled in this subject");

  await commitInBatches(targets.flatMap((st) => {
    const sref = db.collection("students").doc(st.student_id);
    return [
      (b) => b.update(sref, { enrolled_subjects: admin.firestore.FieldValue.arrayRemove(subject.subject_id) }),
      (b) => b.set(sref, { elective_choices: { [String(sem)]: { [group]: FieldDelete() } } }, { merge: true }),
    ];
  }));
  collegeStudents.del(req.head.aishe_code);
  forgetAll(targets);
  pushTo(targets.map((st) => st.uid || st.student_id), "Choose your elective again", `You were removed from ${subject.subject_name || subject.subject_code}. Open the app and pick another ${group} subject.`, "ElectiveSelection");
  await audit(req, "elective.unenroll", "subjects", subject.subject_id, { students: targets.length, group, semester: sem });
  return res.json({ success: true, unenrolled: targets.length, skipped: ids.length - targets.length });
}));

router.post("/subjects/:id/move", wrap(async (req, res) => {
  const { subject, course, sem, group } = await loadElectiveSubject(req, req.params.id);
  const body = req.body || {};
  const ids = pickStudentIds(body);
  const target = await loadElectiveSubject(req, String(body.to_subject_id || "_"));
  if (target.subject.subject_id === subject.subject_id) fail(400, "Pick a different subject to move them to");
  if (target.subject.course_id !== subject.course_id || target.sem !== sem || target.group !== group) fail(400, "Students can only move to another subject of the same elective group");

  const roster = new Map((await studentsOfCourse(req.head.aishe_code, course)).map((st) => [st.student_id, st]));
  const targets = ids.map((id) => roster.get(id)).filter((st) => st && (st.enrolled_subjects || []).includes(subject.subject_id));
  if (!targets.length) fail(404, "None of those students is enrolled in this subject");

  await commitInBatches(targets.flatMap((st) => {
    const sref = db.collection("students").doc(st.student_id);
    return [
      (b) => b.update(sref, { enrolled_subjects: admin.firestore.FieldValue.arrayRemove(subject.subject_id) }),
      (b) => b.update(sref, { enrolled_subjects: admin.firestore.FieldValue.arrayUnion(target.subject.subject_id) }),
      (b) => b.set(sref, { elective_choices: { [String(sem)]: { [group]: target.subject.subject_id } } }, { merge: true }),
    ];
  }));
  collegeStudents.del(req.head.aishe_code);
  forgetAll(targets);
  pushTo(targets.map((st) => st.uid || st.student_id), "Your elective changed", `You are now in ${target.subject.subject_name || target.subject.subject_code} for ${group}.`, "StudentWork");
  await audit(req, "elective.move", "subjects", subject.subject_id, { to: target.subject.subject_id, students: targets.length, group, semester: sem });
  return res.json({ success: true, moved: targets.length, skipped: ids.length - targets.length });
}));

// ─────────────────────────────────────────────────────────────────────────────
// FACULTY ALLOCATION (manual)
// ─────────────────────────────────────────────────────────────────────────────
router.put("/subjects/:id/assign", wrap(async (req, res) => {
  const { ref, subject } = await loadHeadSubject(req, req.params.id);
  const body = req.body || {};
  const newId = body.teacher_id || null;
  const oldId = subject.teacher_assigned || null;

  const lecSnap = await db.collection("lectures").where("subject_id", "==", subject.subject_id).get();
  const lectures = lecSnap.docs.map((d) => ({ ...d.data(), lecture_id: d.id }));
  // slots with their own teacher (pinned) or a change running today keep their teacher
  const movable = lectures.filter((l) => l.teacher_pinned !== true && !l.override_id);

  // ── Unassign ──
  if (!newId) {
    // Timetable slots stay, but lose their teacher (so the old teacher no longer sees them)
    const released = movable.filter((l) => l.teacher_id).length;
    await commitInBatches([
      (b) => b.update(ref, { teacher_assigned: null, updated_at: ts() }),
      ...lectureSyncOps(lectures, { ...subject, teacher_assigned: null, __unassigning: true }),
    ]);
    await db.collection("allocation_history").add(clean({
      aishe_code: req.head.aishe_code, subject_id: subject.subject_id,
      from_teacher_id: oldId, to_teacher_id: null, changed_by: req.head.teacher_id, created_at: ts(),
    }));
    await audit(req, "allocation.unassign", "subjects", subject.subject_id, { from_teacher_id: oldId, released_lectures: released });
    return res.json({ success: true, teacher_assigned: null, released_lectures: released });
  }

  // ── Assign / change ──
  const teacher = await activeTeacherOrFail(req, newId);
  if (newId === oldId) {
    // same teacher: still make sure the timetable slots agree with the subject
    await commitInBatches(lectureSyncOps(lectures, subject, teacher.name));
    return res.json({ success: true, teacher_assigned: newId, teacher_name: teacher.name, unchanged: true });
  }

  // Would the new teacher be double-booked by this subject's slots?
  const conflicts = [];
  if (movable.length) {
    const theirs = await db.collection("lectures")
      .where("aishe_code", "==", req.head.aishe_code)
      .where("teacher_id", "==", newId)
      .get();
    const busy = theirs.docs.map((d) => ({ ...d.data(), lecture_id: d.id }));
    movable.forEach((l) => {
      busy.forEach((o) => {
        if (o.lecture_id !== l.lecture_id && o.day === l.day && overlaps(toMin(l.start_time), toMin(l.end_time), toMin(o.start_time), toMin(o.end_time))) {
          conflicts.push({
            type: "teacher",
            message: `${teacher.name} already teaches ${o.subject_name || "another class"} on ${o.day} ${o.start_time}-${o.end_time}`,
            lecture_id: l.lecture_id, day: l.day, start_time: l.start_time, end_time: l.end_time,
          });
        }
      });
    });
  }
  if (conflicts.length && body.force !== true) {
    fail(409, "This teacher has clashing lectures. Resolve them or confirm to assign anyway.", { conflicts });
  }

  const ops = [];
  ops.push((b) => b.update(ref, { teacher_assigned: newId, updated_at: ts() }));
  ops.push(...lectureSyncOps(lectures, { ...subject, teacher_assigned: newId }, teacher.name));
  await commitInBatches(ops);

  await db.collection("allocation_history").add(clean({
    aishe_code: req.head.aishe_code, subject_id: subject.subject_id,
    from_teacher_id: oldId, to_teacher_id: newId, changed_by: req.head.teacher_id, created_at: ts(),
  }));
  await audit(req, "allocation.assign", "subjects", subject.subject_id, {
    from_teacher_id: oldId, to_teacher_id: newId, moved_lectures: movable.length, forced: conflicts.length > 0,
  });

  return res.json({
    success: true,
    teacher_assigned: newId,
    teacher_name: teacher.name,
    moved_lectures: movable.length,
    conflicts,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// DIVISIONS  (sections A, B, C of one semester)
// divisions/{id} = { aishe_code, course_id, semester (number), name }.  Students carry division_id + division.
// A timetable slot without a division is common to everyone; a slot with one is for that division only.
// Subjects and elective groups are shared by all divisions of a semester.
// ─────────────────────────────────────────────────────────────────────────────
function studentsOfDivision(all, d) {
  return all.filter((st) => st.division_id === d.division_id && isActiveStudent(st));
}

router.get("/divisions", wrap(async (req, res) => {
  const courses = req.query.course_id ? [courseOrFail(req, req.query.course_id)] : req.head.courses;
  const wantSem = req.query.semester ? parseSem(req.query.semester) : null;
  if (req.query.semester && wantSem === null) fail(400, "Invalid semester");

  const out = [];
  const unassigned = {};
  for (const course of courses) {
    let list = await divisionsOfCourse(course.course_id);
    if (wantSem !== null) list = list.filter((d) => parseSem(d.semester) === wantSem);
    const all = (await studentsOfCourse(req.head.aishe_code, course)).filter(isActiveStudent);
    const lecs = list.length ? (await db.collection("lectures").where("course_id", "==", course.course_id).get()).docs.map((d) => d.data()) : [];
    list.forEach((d) => out.push({
      division_id: d.division_id, course_id: d.course_id, course_abbr: course.abbr || "",
      semester: parseSem(d.semester), name: d.name,
      student_count: studentsOfDivision(all, d).length,
      lecture_count: lecs.filter((l) => l.division_id === d.division_id).length,
    }));
    all.forEach((st) => {
      const sem = parseSem(st.semester);
      if (sem === null || (wantSem !== null && sem !== wantSem) || st.division_id) return;
      const k = `${course.course_id}|${sem}`;
      unassigned[k] = (unassigned[k] || 0) + 1;
    });
  }
  out.sort((a, b) => a.course_abbr.localeCompare(b.course_abbr) || a.semester - b.semester || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return res.json({
    success: true, divisions: out,
    unassigned: Object.entries(unassigned).map(([k, count]) => { const [course_id, sem] = k.split("|"); return { course_id, semester: Number(sem), count }; }),
  });
}));

router.post("/divisions", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);
  const n = parseSem(body.semester);
  if (n === null || n > totalSemesters(course)) fail(400, `semester must be between 1 and ${totalSemesters(course)}`);
  const names = [...new Set((Array.isArray(body.names) ? body.names : [body.name]).map(validDivName))];
  if (!names.length) fail(400, "Enter a division name");
  if (names.length > 12) fail(400, "At most 12 divisions at a time");

  const existing = (await divisionsOfCourse(course.course_id)).filter((d) => parseSem(d.semester) === n);
  const dup = names.find((nm) => existing.some((d) => d.name === nm));
  if (dup) fail(409, `Division ${dup} already exists in ${semLabel(n)}`);
  if (existing.length + names.length > 26) fail(400, "A semester can have at most 26 divisions");

  const ops = [];
  const created = names.map((name) => {
    const ref = db.collection("divisions").doc();
    ops.push((b) => b.set(ref, { division_id: ref.id, aishe_code: req.head.aishe_code, course_id: course.course_id, semester: n, name, created_by: req.head.teacher_id, created_at: ts() }));
    return { division_id: ref.id, name, semester: n, course_id: course.course_id };
  });
  await commitInBatches(ops);
  await audit(req, "division.create", "divisions", created[0].division_id, { names, semester: n, course: course.abbr });
  return res.status(201).json({ success: true, divisions: created });
}));

router.put("/divisions/:id", wrap(async (req, res) => {
  const { ref, division, course } = await loadHeadDivision(req, req.params.id);
  const name = validDivName((req.body || {}).name);
  if (name === division.name) return res.json({ success: true, unchanged: true });
  const sibs = (await divisionsOfCourse(division.course_id)).filter((d) => parseSem(d.semester) === parseSem(division.semester) && d.division_id !== division.division_id);
  if (sibs.some((d) => d.name === name)) fail(409, `Division ${name} already exists in ${semLabel(parseSem(division.semester))}`);

  const all = await studentsOfCourse(req.head.aishe_code, course);
  const lecs = (await db.collection("lectures").where("division_id", "==", division.division_id).get()).docs;
  await commitInBatches([
    (b) => b.update(ref, { name, updated_at: ts() }),
    ...all.filter((st) => st.division_id === division.division_id).map((st) => (b) => b.update(db.collection("students").doc(st.student_id), { division: name })),
    ...lecs.map((d) => (b) => b.update(d.ref, { division_name: name })),
  ]);
  collegeStudents.del(req.head.aishe_code);
  forgetAll(all.filter((st) => st.division_id === division.division_id));
  await audit(req, "division.rename", "divisions", division.division_id, { from: division.name, to: name });
  return res.json({ success: true });
}));

router.delete("/divisions/:id", wrap(async (req, res) => {
  const { ref, division, course } = await loadHeadDivision(req, req.params.id);
  const lec = await db.collection("lectures").where("division_id", "==", division.division_id).limit(1).get();
  if (!lec.empty) fail(409, "This division still has timetable slots. Delete them (or make them common to all) first.");
  const all = (await studentsOfCourse(req.head.aishe_code, course)).filter((st) => st.division_id === division.division_id);
  await commitInBatches([
    ...all.map((st) => (b) => b.update(db.collection("students").doc(st.student_id), { division_id: FieldDelete(), division: FieldDelete() })),
    (b) => b.delete(ref),
  ]);
  collegeStudents.del(req.head.aishe_code);
  forgetAll(all);
  await audit(req, "division.delete", "divisions", division.division_id, { name: division.name, students_released: all.length });
  return res.json({ success: true, released_students: all.length });
}));

router.get("/divisions/:id/students", wrap(async (req, res) => {
  const { division, course } = await loadHeadDivision(req, req.params.id);
  const all = (await studentsOfCourse(req.head.aishe_code, course)).filter(isActiveStudent);
  const sem = parseSem(division.semester);
  const view = (st) => ({ ...studentView(st), division_id: st.division_id || null, division: st.division || null });
  const byRoll = (a, b) => String(a.roll_no || "").localeCompare(String(b.roll_no || ""), undefined, { numeric: true }) || a.name.localeCompare(b.name);
  return res.json({
    success: true,
    division: { division_id: division.division_id, name: division.name, semester: sem },
    students: studentsOfDivision(all, division).map(view).sort(byRoll),
    // everybody of that semester who could be put here (no division yet, or in another one)
    candidates: all.filter((st) => parseSem(st.semester) === sem && st.division_id !== division.division_id).map(view).sort(byRoll),
  });
}));

// Put students into a division, move them, or take them out (division_id: null)
router.post("/divisions/assign", wrap(async (req, res) => {
  const body = req.body || {};
  const ids = pickStudentIds(body);
  let division = null, course = null;
  if (body.division_id) ({ division, course } = await loadHeadDivision(req, body.division_id));

  const pool = new Map();
  for (const c of req.head.courses) (await studentsOfCourse(req.head.aishe_code, c)).forEach((st) => pool.set(st.student_id, st));
  const targets = ids.map((id) => pool.get(id)).filter(Boolean);
  if (!targets.length) fail(404, "Students not found");
  if (division) {
    const bad = targets.filter((st) => !((st.course_id && st.course_id === division.course_id) || (st.degree && up(st.degree) === up(course.abbr))) || parseSem(st.semester) !== parseSem(division.semester));
    if (bad.length) fail(400, `${bad.length} of them ${bad.length === 1 ? "is" : "are"} not in ${course.abbr} ${semLabel(parseSem(division.semester))}`);
  }
  await commitInBatches(targets.map((st) => (b) => b.update(db.collection("students").doc(st.student_id),
    division ? { division_id: division.division_id, division: division.name } : { division_id: FieldDelete(), division: FieldDelete() })));
  collegeStudents.del(req.head.aishe_code);
  forgetAll(targets);
  pushTo(targets.map((st) => st.uid || st.student_id), division ? "Your division" : "Division removed", division ? `You are in division ${division.name}.` : "You are no longer in a division. Ask your head to assign one.", "StudentProfile");
  await audit(req, division ? "division.assign" : "division.unassign", "divisions", division ? division.division_id : "-", { students: targets.length, name: division ? division.name : null });
  return res.json({ success: true, updated: targets.length });
}));

// ─────────────────────────────────────────────────────────────────────────────
// TIMETABLE  (writes `lectures`, which teachers/students/mobile already read)
//
// Two kinds of change:
//   PERMANENT   edits the weekly slot itself (POST/PUT/DELETE /timetable).
//   TEMPORARY   a one-date override in `timetable_overrides`:
//                 modify   another teacher / another time / another room, that day only
//                 cancel   the lecture doesn't run that day
//                 special  a one-off session (e.g. one 2-hour lecture) that can replace
//                          the regular lectures of that day
//               On the day itself an override is applied to `lectures` (so teacher /
//               student apps see it) and, once the date has passed, put back exactly as
//               it was. Dates that never became "today" simply expire. See syncOverrides().
// ─────────────────────────────────────────────────────────────────────────────
const OVERRIDE_KINDS = ["modify", "cancel", "special"];
const ACTIVE_STATUS  = ["scheduled", "applied"];
const specialLectureId = (overrideId) => `sp_${overrideId}`;

function lectureView(l, names = {}, subjectsById = {}) {
  const subj = subjectsById[l.subject_id] || {};
  return {
    lecture_id: l.lecture_id,
    subject_id: l.subject_id || null,
    subject_name: l.subject_name || subj.subject_name || "",
    subject_code: l.subject_code || subj.subject_code || "",
    teacher_id: l.teacher_id || null,
    teacher_name: l.teacher_name || names[l.teacher_id] || "",
    teacher_pinned: l.teacher_pinned === true,
    division_id: l.division_id || null,
    division_name: l.division_name || "",
    elective_group: l.elective_group || (subj.compulsary === false ? subj.elective_group || null : null),
    slot_id: l.slot_id || null,
    day: l.day,
    start_time: l.start_time,
    end_time: l.end_time,
    room: l.room || "",
  };
}

// ── override helpers (pure) ──────────────────────────────────────────────────

// Lectures as they are in the weekly timetable: undo overrides already applied to the DB.
function baseOf(lectures, overrides) {
  let out = lectures.map((l) => ({ ...l }));
  overrides.filter((o) => o.status === "applied").forEach((o) => {
    if (o.kind === "modify") {
      const l = out.find((x) => x.lecture_id === o.lecture_id);
      if (l) Object.keys(o.original || {}).forEach((k) => { if (o.original[k] === null) delete l[k]; else l[k] = o.original[k]; });
    } else {
      out = out.filter((x) => x.lecture_id !== specialLectureId(o.override_id));
      Object.keys(o.snapshots || {}).forEach((id) => {
        if (!out.some((x) => x.lecture_id === id)) out.push({ ...o.snapshots[id], lecture_id: id });
      });
    }
  });
  return out;
}

// Lectures of one date: base timetable + that date's overrides.
function effectiveOf(base, overrides) {
  let out = base.map((l) => ({ ...l }));
  overrides.filter((o) => ACTIVE_STATUS.includes(o.status)).forEach((o) => {
    if (o.kind === "modify") {
      const l = out.find((x) => x.lecture_id === o.lecture_id);
      if (l) Object.assign(l, o.changes || {});
    } else if (o.kind === "cancel") {
      out = out.filter((x) => x.lecture_id !== o.lecture_id);
    } else if (o.kind === "special") {
      const rep = new Set(o.replaces || []);
      out = out.filter((x) => !rep.has(x.lecture_id));
      out.push({ ...o.special, lecture_id: specialLectureId(o.override_id), day: weekdayOf(o.date), course_id: o.course_id, sem: o.semester, semester: semLabel(o.semester), override_id: o.override_id });
    }
  });
  return out;
}

async function overridesOfDate(req, date) {
  const snap = await db.collection("timetable_overrides")
    .where("aishe_code", "==", req.head.aishe_code)
    .where("date", "==", date)
    .get();
  return snap.docs.map((d) => ({ ...d.data(), override_id: d.id })).filter((o) => ACTIVE_STATUS.includes(o.status));
}

async function overridesOfCourse(course_id) {
  const snap = await db.collection("timetable_overrides").where("course_id", "==", course_id).get();
  return snap.docs.map((d) => ({ ...d.data(), override_id: d.id })).filter((o) => ACTIVE_STATUS.includes(o.status));
}

// ── apply / revert engine ────────────────────────────────────────────────────
// Runs every few minutes (see bottom of file) and whenever the timetable is opened.
//   scheduled & date == today  → apply to `lectures`
//   scheduled & date  < today  → expired (never applied)
//   applied   & date  < today  → put `lectures` back as they were
async function applyOverride(o) {
  const ref = db.collection("timetable_overrides").doc(o.override_id);
  const fresh = await ref.get();
  if (!fresh.exists || fresh.data().status !== "scheduled") return;       // someone else got there first
  const FV = admin.firestore.FieldValue;
  const batch = db.batch();

  if (o.kind === "modify" || o.kind === "cancel") {
    const lref = db.collection("lectures").doc(o.lecture_id);
    const ls = await lref.get();
    if (!ls.exists) { await ref.update({ status: "failed", note_system: "Lecture no longer exists", updated_at: ts() }); return; }
    const lec = ls.data();
    if (o.kind === "cancel") {
      batch.update(ref, { status: "applied", snapshots: { [o.lecture_id]: lec }, applied_at: ts() });
      batch.delete(lref);
    } else {
      const changes = { ...o.changes };
      if (!("teacher_name" in lec)) delete changes.teacher_name;           // only touch fields the lecture has
      const original = {};
      Object.keys(changes).forEach((k) => { original[k] = k in lec ? lec[k] : null; });
      batch.update(lref, { ...changes, override_id: o.override_id });
      batch.update(ref, { status: "applied", original, applied_at: ts() });
    }
  } else if (o.kind === "special") {
    const snapshots = {};
    for (const id of o.replaces || []) {
      const rs = await db.collection("lectures").doc(id).get();
      if (rs.exists) { snapshots[id] = rs.data(); batch.delete(rs.ref); }
    }
    batch.set(db.collection("lectures").doc(specialLectureId(o.override_id)), clean({
      lecture_id: specialLectureId(o.override_id),
      aishe_code: o.aishe_code,
      course_id: o.course_id,
      semester: semLabel(o.semester),
      ...o.special,
      day: weekdayOf(o.date),
      department: o.department,
      override_id: o.override_id,
      temporary: true,
      special_date: o.date,
      created_at: ts(),
    }));
    batch.update(ref, { status: "applied", snapshots, applied_at: ts() });
  }
  await batch.commit();
}

async function revertOverride(o) {
  const ref = db.collection("timetable_overrides").doc(o.override_id);
  const FV = admin.firestore.FieldValue;
  const batch = db.batch();

  if (o.kind === "modify") {
    const lref = db.collection("lectures").doc(o.lecture_id);
    const ls = await lref.get();
    if (ls.exists && ls.data().override_id === o.override_id) {
      const back = { override_id: FV.delete() };
      Object.keys(o.original || {}).forEach((k) => { back[k] = o.original[k] === null ? FV.delete() : o.original[k]; });
      batch.update(lref, back);
    }
  } else {
    // restore every lecture this override removed
    for (const id of Object.keys(o.snapshots || {})) {
      const lref = db.collection("lectures").doc(id);
      if (!(await lref.get()).exists) batch.set(lref, o.snapshots[id]);
    }
    if (o.kind === "special") {
      const sref = db.collection("lectures").doc(specialLectureId(o.override_id));
      const ss = await sref.get();
      if (ss.exists) {
        // keep the lecture if a class was actually taken (attendance history points at it)
        const used = await db.collection("lecture_sessions").where("lecture_id", "==", sref.id).limit(1).get();
        if (used.empty) batch.delete(sref);
        else batch.update(sref, { day: "Archived", temporary_ended: true });
      }
    }
  }
  batch.update(ref, { status: "reverted", reverted_at: ts() });
  await batch.commit();
}

let syncing = null;
let lastSyncAt = 0;
// timetable page loads: do the full scan at most once a minute (the 5-minute timer and every
// "change for today" call still run it right away)
function syncOverridesSoon(maxAgeMs = 60_000) {
  return Date.now() - lastSyncAt < maxAgeMs ? Promise.resolve(0) : syncOverrides();
}
function syncOverrides() {
  if (syncing) return syncing;
  syncing = (async () => {
    const today = todayIST();
    const [sched, applied] = await Promise.all([
      db.collection("timetable_overrides").where("status", "==", "scheduled").get(),
      db.collection("timetable_overrides").where("status", "==", "applied").get(),
    ]);
    let done = 0;
    for (const d of sched.docs) {
      const o = { ...d.data(), override_id: d.id };
      try {
        if (o.date === today) { await applyOverride(o); done++; }
        else if (o.date < today) { await d.ref.update({ status: "expired", updated_at: ts() }); done++; }
      } catch (err) { console.error("HEAD: applying override failed", d.id, err); }
    }
    for (const d of applied.docs) {
      const o = { ...d.data(), override_id: d.id };
      if (o.date < today) {
        try { await revertOverride(o); done++; } catch (err) { console.error("HEAD: reverting override failed", d.id, err); }
      }
    }
    lastSyncAt = Date.now();
    return done;
  })().finally(() => { syncing = null; });
  return syncing;
}
router.syncOverrides = syncOverrides;
// (tests) forget the short-lived caches
router.clearCaches = () => { collegeStudents.clear && collegeStudents.clear(); attendanceCache.clear && attendanceCache.clear(); headCtxCache.clear && headCtxCache.clear(); collegeCourses.clear && collegeCourses.clear(); };

// ── college name for the printed header (best effort) ────────────────────────
const collegeCache = new Map();
async function collegeNameOf(req) {
  const code = req.head.aishe_code;
  const hit = collegeCache.get(code);
  if (hit && hit.name && Date.now() - hit.at < 10 * 60 * 1000) return hit.name;
  const t = req.head.teacher || {};
  let name = t.college_name || t.institute_name || null;
  if (!name && code) {
    // same source the student registration uses: colleges/{aishe_code}.college_name
    try {
      const s = await db.collection("colleges").where("aishe_code", "==", code).limit(1).get();
      if (!s.empty) name = s.docs[0].data().college_name || null;
    } catch { /* ignore */ }
  }
  if (name) collegeCache.set(code, { name, at: Date.now() });
  return name;
}

// ── views ────────────────────────────────────────────────────────────────────
function overrideView(o, lectureById, names) {
  const lec = lectureById[o.lecture_id] || (o.snapshots && o.snapshots[o.lecture_id] ? { ...o.snapshots[o.lecture_id], lecture_id: o.lecture_id } : null);
  const view = {
    override_id: o.override_id,
    kind: o.kind,
    date: o.date,
    weekday: weekdayOf(o.date),
    status: o.status,
    note: o.note || "",
    lecture_id: o.lecture_id || null,
    lecture: lec ? {
      subject_name: lec.subject_name || "", subject_code: lec.subject_code || "",
      start_time: lec.start_time, end_time: lec.end_time, room: lec.room || "",
      teacher_id: lec.teacher_id || null, teacher_name: lec.teacher_name || names[lec.teacher_id] || "",
    } : null,
    changes: null,
    special: null,
    replaces: [],
  };
  if (o.kind === "modify") {
    view.changes = {
      ...(o.changes.teacher_id ? { teacher_id: o.changes.teacher_id, teacher_name: o.changes.teacher_name || names[o.changes.teacher_id] || "" } : {}),
      ...(o.changes.start_time ? { start_time: o.changes.start_time } : {}),
      ...(o.changes.end_time ? { end_time: o.changes.end_time } : {}),
      ...(o.changes.room !== undefined ? { room: o.changes.room } : {}),
    };
  }
  if (o.kind === "special") {
    view.special = { ...o.special, teacher_name: o.special.teacher_name || names[o.special.teacher_id] || "" };
    view.replaces = (o.replaces || []).map((id) => {
      const l = lectureById[id] || (o.snapshots && o.snapshots[id]) || {};
      return { lecture_id: id, subject_name: l.subject_name || "", start_time: l.start_time || "", end_time: l.end_time || "" };
    });
  }
  return view;
}

router.get("/timetable", wrap(async (req, res) => {
  const course = courseOrFail(req, req.query.course_id);
  const n = parseSem(req.query.semester);
  if (n === null) fail(400, "semester is required");

  try { await syncOverridesSoon(); } catch (err) { console.error("HEAD: override sync failed", err); }

  const subjects = (await subjectsOfCourse(course.course_id)).filter((s) => parseSem(s.semester) === n);
  const subjectIds = new Set(subjects.map((s) => s.subject_id));
  const subjectsById = Object.fromEntries(subjects.map((s) => [s.subject_id, s]));

  const lecSnap = await db.collection("lectures").where("course_id", "==", course.course_id).get();
  const allOverrides = (await overridesOfCourse(course.course_id)).filter((o) => o.semester === n);
  const dbLectures = lecSnap.docs
    .map((d) => ({ ...d.data(), lecture_id: d.id }))
    .filter((l) => (parseSem(l.semester) !== null ? parseSem(l.semester) === n : subjectIds.has(l.subject_id)));
  // the weekly timetable, without today's temporary changes
  const lectures = baseOf(dbLectures, allOverrides)
    .sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || toMin(a.start_time) - toMin(b.start_time));

  // teacher names (lectures of real data only carry teacher_id)
  const tIds = new Set();
  subjects.forEach((s) => s.teacher_assigned && tIds.add(s.teacher_assigned));
  lectures.forEach((l) => l.teacher_id && tIds.add(l.teacher_id));
  allOverrides.forEach((o) => {
    if (o.changes && o.changes.teacher_id) tIds.add(o.changes.teacher_id);
    if (o.special && o.special.teacher_id) tIds.add(o.special.teacher_id);
  });
  const names = {};
  (await getAllDocs([...tIds].map((id) => db.collection("teachers").doc(id))))
    .forEach((d) => { if (d.exists) names[d.id] = personName(d.data()); });

  // this semester's recurring window → the run the printed timetable covers
  let semester_run = null;
  const semSnap = await db.collection("semester_dates").where("course_id", "==", course.course_id).get();
  const semDoc = semSnap.docs.map((d) => d.data()).find((r) => parseSem(r.semester) === n);
  const w = readWindow(semDoc);
  if (w) {
    const r = win.resolveRun(w.start, w.end, todayIST());
    semester_run = { status: r.status, start_date: r.run.start_date, end_date: r.run.end_date, start_md: w.start, end_md: w.end };
  }

  const lectureById = Object.fromEntries(lectures.map((l) => [l.lecture_id, l]));
  const upcoming = allOverrides
    .filter((o) => o.date >= todayIST())
    .sort((a, b) => a.date.localeCompare(b.date));
  const changesFor = {};
  upcoming.forEach((o) => {
    [o.lecture_id, ...(o.replaces || [])].filter(Boolean).forEach((id) => { changesFor[id] = (changesFor[id] || 0) + 1; });
  });

  return res.json({
    success: true,
    today: todayIST(),
    course: { course_id: course.course_id, course_name: course.course_name || "", abbr: course.abbr || "" },
    college_name: await collegeNameOf(req),
    aishe_code: req.head.aishe_code,
    department: req.head.department,
    semester: n,
    semester_run,
    subjects: subjects
      .sort((a, b) => String(a.subject_code || "").localeCompare(String(b.subject_code || "")))
      .map((s) => ({
        subject_id: s.subject_id, subject_name: s.subject_name, subject_code: s.subject_code,
        compulsary: s.compulsary !== false,
        elective_group: s.compulsary !== false ? null : (s.elective_group || null),
        teacher_assigned: s.teacher_assigned || null,
        teacher_name: s.teacher_assigned ? (names[s.teacher_assigned] || "") : "",
      })),
    lectures: lectures.map((l) => ({ ...lectureView(l, names, subjectsById), pending_changes: changesFor[l.lecture_id] || 0 })),
    overrides: upcoming.map((o) => overrideView(o, lectureById, names)),
    divisions: (await divisionsOfCourse(course.course_id)).filter((d) => parseSem(d.semester) === n)
      .map((d) => ({ division_id: d.division_id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  });
}));

function readSlotFields(body, current = {}) {
  const day = body.day !== undefined ? body.day : current.day;
  if (!DAY_ORDER.includes(day)) fail(400, `day must be one of ${DAY_ORDER.join(", ")}`);
  const start_time = normTime(body.start_time !== undefined ? body.start_time : current.start_time);
  const end_time   = normTime(body.end_time   !== undefined ? body.end_time   : current.end_time);
  if (!start_time || !end_time) fail(400, "start_time and end_time must be HH:MM (24h)");
  if (toMin(start_time) >= toMin(end_time)) fail(400, "end_time must be after start_time");
  const room = body.room !== undefined ? String(body.room || "").trim() : String(current.room || "").trim();
  return { day, start_time, end_time, room };
}

// Slots of the same semester on that weekday that a new/special slot would replace.
async function loadReplaceable(req, ids, course, sem, day) {
  const out = [];
  for (const id of ids) {
    const { lecture } = await loadHeadLecture(req, id);
    const lsem = parseSem(lecture.semester);
    if (lecture.course_id !== course.course_id || (lsem !== null && lsem !== sem) || lecture.day !== day) {
      fail(400, "A lecture to replace is not in this semester or not on this day");
    }
    out.push(lecture);
  }
  return out;
}

router.post("/timetable", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);
  // subject-less (custom) slot: guest lecture, seminar, ... identified by a title
  let subject = null, teacher = null, sem, title = "";
  const guest = String(body.guest || "").trim();
  if (body.subject_id) {
    subject = (await loadHeadSubject(req, body.subject_id)).subject;
    if (subject.course_id !== course.course_id) fail(400, "Subject does not belong to this course");
    const teacherId = body.teacher_id || subject.teacher_assigned;
    if (!teacherId) fail(400, "Allocate a teacher to this subject before scheduling it");
    teacher = await activeTeacherOrFail(req, teacherId);
    sem = parseSem(subject.semester);
    if (sem === null) fail(400, "This subject has no valid semester — edit the subject first");
  } else {
    title = String(body.title || "").trim();
    if (!title) fail(400, "Pick a subject or give the session a title");
    if (title.length > 80 || guest.length > 80) fail(400, "Title and guest name can be at most 80 characters");
    sem = parseSem(body.semester);
    if (sem === null) fail(400, "semester is required for a session without a subject");
    if (body.teacher_id) teacher = await activeTeacherOrFail(req, body.teacher_id);
  }

  const slot = readSlotFields(body);
  const division = await divisionOrFail(req, course, sem, body.division_id);

  // lectures this slot replaces (e.g. one 2-hour lecture instead of two 1-hour ones)
  const replaced = Array.isArray(body.replaces) && body.replaces.length
    ? await loadReplaceable(req, body.replaces, course, sem, slot.day) : [];
  for (const l of replaced) {
    const used = await db.collection("lecture_sessions").where("lecture_id", "==", l.lecture_id).limit(1).get();
    if (!used.empty) fail(409, `${l.subject_name || "A lecture"} (${l.start_time}-${l.end_time}) already has attendance history, so it can't be replaced. Edit its time instead.`);
  }

  const conflicts = await findConflicts(req, {
    ...slot, course_id: course.course_id, semester: sem, teacher_id: teacher ? teacher.id : undefined, exclude_ids: replaced.map((l) => l.lecture_id),
    division_id: division ? division.division_id : undefined, egroup: egroupOfSubject(subject),
  });
  if (conflicts.length && body.force !== true) fail(409, "This slot clashes with an existing lecture", { conflicts });

  const ref = db.collection("lectures").doc();
  const ops = [(b) => b.set(ref, clean({
    lecture_id: ref.id,
    aishe_code: req.head.aishe_code,
    course_id: course.course_id,
    semester: (subject && subject.semester) || semLabel(sem),
    subject_id: subject ? subject.subject_id : undefined,
    subject_name: subject ? (subject.subject_name || "") : title,
    subject_code: subject ? (subject.subject_code || "") : "",
    custom: subject ? undefined : true,
    teacher_id: teacher ? teacher.id : undefined,
    teacher_name: teacher ? teacher.name : guest,
    teacher_pinned: subject && teacher.id !== subject.teacher_assigned ? true : undefined,
    division_id: division ? division.division_id : undefined,
    division_name: division ? division.name : undefined,
    day: slot.day,
    start_time: slot.start_time,
    end_time: slot.end_time,
    room: slot.room,
    department: req.head.department,
    created_by: req.head.teacher_id,
    created_at: ts(),
  }))];
  replaced.forEach((l) => ops.push((b) => b.delete(db.collection("lectures").doc(l.lecture_id))));
  await commitInBatches(ops);

  await audit(req, "timetable.create", "lectures", ref.id, { subject: subject ? subject.subject_code : title, replaced: replaced.length, ...slot });
  return res.status(201).json({ success: true, lecture_id: ref.id, replaced: replaced.length });
}));

// One slot for a whole elective group: every subject of the group gets its own lecture at the same time,
// each with its own room (and, optionally, its own teacher). Students only ever see the one they chose.
//   { course_id, semester, group, day, start_time, end_time, division_id?, options: [{ subject_id, room?, teacher_id? }], force? }
router.post("/timetable/group", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);
  const sem = parseSem(body.semester);
  if (sem === null) fail(400, "semester is required");
  const group = cleanGroup(body.group);
  if (!group) fail(400, "Pick an elective group");

  const subs = (await subjectsOfCourse(course.course_id))
    .filter((x) => x.compulsary === false && parseSem(x.semester) === sem && groupKey(x) === group);
  if (!subs.length) fail(404, "That elective group has no subjects in this semester");
  const byId = Object.fromEntries(subs.map((x) => [x.subject_id, x]));

  const options = Array.isArray(body.options) ? body.options : [];
  if (!options.length) fail(400, "Add at least one subject of the group");
  if (options.length > 20) fail(400, "At most 20 subjects in one slot");
  const seen = new Set();
  options.forEach((o) => {
    if (!o || !byId[o.subject_id]) fail(400, "A subject in the list does not belong to this elective group");
    if (seen.has(o.subject_id)) fail(400, "A subject is listed twice");
    seen.add(o.subject_id);
  });

  const slot = readSlotFields(body);
  const division = await divisionOrFail(req, course, sem, body.division_id);

  // resolve each option's teacher + room
  const rows = [];
  for (const o of options) {
    const subject = byId[o.subject_id];
    const teacherId = o.teacher_id || subject.teacher_assigned;
    if (!teacherId) fail(400, `${subject.subject_name}: allocate a teacher to this subject before scheduling it`);
    const teacher = await activeTeacherOrFail(req, teacherId);
    const room = String(o.room || "").trim().slice(0, 30);
    rows.push({ subject, teacher, room });
  }

  // the options run at the same time, so they can't share a teacher or a room
  const tSeen = new Map(), rSeen = new Map();
  rows.forEach((r) => {
    if (tSeen.has(r.teacher.id)) fail(400, `${r.teacher.name} can't take both ${tSeen.get(r.teacher.id)} and ${r.subject.subject_name} at the same time`);
    tSeen.set(r.teacher.id, r.subject.subject_name);
    if (r.room) {
      const k = up(r.room);
      if (rSeen.has(k)) fail(400, `Room ${r.room} is given to both ${rSeen.get(k)} and ${r.subject.subject_name}. Each subject needs its own room.`);
      rSeen.set(k, r.subject.subject_name);
    }
  });

  // clashes with what is already in the timetable
  const conflicts = [];
  for (const r of rows) {
    const found = await findConflicts(req, {
      ...slot, room: r.room, course_id: course.course_id, semester: sem, teacher_id: r.teacher.id,
      division_id: division ? division.division_id : undefined, egroup: egroupOfSubject(r.subject),
    });
    found.forEach((c) => conflicts.push({ ...c, message: `${r.subject.subject_name}: ${c.message}` }));
  }
  if (conflicts.length && body.force !== true) fail(409, "This slot clashes with an existing lecture", { conflicts });

  const slot_id = db.collection("lectures").doc().id;
  const ids = [];
  const ops = rows.map((r) => {
    const ref = db.collection("lectures").doc();
    ids.push(ref.id);
    return (b) => b.set(ref, clean({
      lecture_id: ref.id,
      aishe_code: req.head.aishe_code,
      course_id: course.course_id,
      semester: r.subject.semester || semLabel(sem),
      subject_id: r.subject.subject_id,
      subject_name: r.subject.subject_name || "",
      subject_code: r.subject.subject_code || "",
      teacher_id: r.teacher.id,
      teacher_name: r.teacher.name,
      teacher_pinned: r.teacher.id !== r.subject.teacher_assigned ? true : undefined,
      division_id: division ? division.division_id : undefined,
      division_name: division ? division.name : undefined,
      elective_group: group,
      slot_id,
      day: slot.day,
      start_time: slot.start_time,
      end_time: slot.end_time,
      room: r.room,
      department: req.head.department,
      created_by: req.head.teacher_id,
      created_at: ts(),
    }));
  });
  await commitInBatches(ops);

  await audit(req, "timetable.create_group", "lectures", slot_id, { group, subjects: rows.map((r) => r.subject.subject_code), ...slot });
  return res.status(201).json({ success: true, slot_id, lecture_ids: ids, created: ids.length });
}));

router.put("/timetable/:id", wrap(async (req, res) => {
  const { ref, lecture } = await loadHeadLecture(req, req.params.id);
  const body = req.body || {};
  if (lecture.override_id) fail(409, "This lecture has a temporary change running today. Undo that change first, or wait until tomorrow.");

  let teacher_id = lecture.teacher_id, teacher_name = lecture.teacher_name || "";
  let pinned = lecture.teacher_pinned === true;
  let sem = parseSem(lecture.semester);
  let subjectTeacher = null;
  if (lecture.subject_id) {
    const sd = await db.collection("subjects").doc(lecture.subject_id).get();
    if (sd.exists) {
      if (sem === null) sem = parseSem(sd.data().semester);
      subjectTeacher = sd.data().teacher_assigned || null;
    }
  }
  if (body.teacher_id !== undefined) {
    // permanent teacher for this slot (may differ from the subject's teacher)
    const t = await activeTeacherOrFail(req, body.teacher_id);
    teacher_id = t.id; teacher_name = t.name;
    pinned = !!subjectTeacher && t.id !== subjectTeacher;
  } else if (!pinned && subjectTeacher && subjectTeacher !== teacher_id) {
    // not pinned: follow the subject's current teacher (heals slots after reassignment)
    const t = await activeTeacherOrFail(req, subjectTeacher);
    teacher_id = t.id; teacher_name = t.name;
  }

  const slot = readSlotFields(body, lecture);
  let division_id = lecture.division_id || null, division_name = lecture.division_name || "";
  if (body.division_id !== undefined) {
    const dv = await divisionOrFail(req, req.head.courseMap[lecture.course_id], sem, body.division_id || null);
    division_id = dv ? dv.division_id : null; division_name = dv ? dv.name : "";
  }
  const conflicts = await findConflicts(req, {
    ...slot, course_id: lecture.course_id, semester: sem, teacher_id, exclude_id: lecture.lecture_id,
    division_id: division_id || undefined, egroup: lecture.subject_id ? await egroupOfSubjectId(lecture.subject_id) : undefined,
  });
  if (conflicts.length && body.force !== true) fail(409, "This slot clashes with an existing lecture", { conflicts });

  await ref.update(clean({
    ...slot, teacher_id, teacher_name,
    teacher_pinned: pinned ? true : admin.firestore.FieldValue.delete(),
    division_id: division_id || admin.firestore.FieldValue.delete(),
    division_name: division_id ? division_name : admin.firestore.FieldValue.delete(),
    updated_by: req.head.teacher_id, updated_at: ts(),
  }));
  await audit(req, "timetable.update", "lectures", lecture.lecture_id, { ...slot, teacher_id });
  return res.json({ success: true });
}));

router.delete("/timetable/:id", wrap(async (req, res) => {
  const { ref, lecture } = await loadHeadLecture(req, req.params.id);
  if (lecture.override_id) fail(409, "This lecture has a temporary change running today. Undo that change first, or wait until tomorrow.");

  const sessions = await db.collection("lecture_sessions").where("lecture_id", "==", lecture.lecture_id).limit(1).get();
  if (!sessions.empty) {
    fail(409, "This slot already has attendance history, so it can't be deleted. Edit its day, time or room instead.");
  }

  // pending one-day changes of this lecture go with it
  const pending = (await db.collection("timetable_overrides").where("lecture_id", "==", lecture.lecture_id).get())
    .docs.filter((d) => d.data().status === "scheduled");
  await commitInBatches([(b) => b.delete(ref), ...pending.map((d) => (b) => b.delete(d.ref))]);

  await audit(req, "timetable.delete", "lectures", lecture.lecture_id, {
    subject: lecture.subject_code || lecture.subject_name, day: lecture.day, start_time: lecture.start_time,
  });
  return res.json({ success: true });
}));

// ── Temporary (one-date) changes ─────────────────────────────────────────────
router.post("/timetable/overrides", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);
  const kind = body.kind;
  if (!OVERRIDE_KINDS.includes(kind)) fail(400, `kind must be one of ${OVERRIDE_KINDS.join(", ")}`);

  const date = body.date;
  if (!isDateStr(date)) fail(400, "date must be YYYY-MM-DD");
  const today = todayIST();
  if (date < today) fail(400, "That date has already passed");
  if (date > addDays(today, 366)) fail(400, "Pick a date within the next year");
  const day = weekdayOf(date);
  const force = body.force === true;

  const doc = {
    aishe_code: req.head.aishe_code,
    department: req.head.department,
    course_id: course.course_id,
    kind, date,
    status: "scheduled",
    note: String(body.note || "").trim().slice(0, 300),
    created_by: req.head.teacher_id,
    created_at: ts(),
  };
  const sameDay = await overridesOfDate(req, date);
  let sem, lecture = null, cand, only = null, exclude = [];

  if (kind === "modify" || kind === "cancel") {
    if (!body.lecture_id) fail(400, "lecture_id is required");
    ({ lecture } = await loadHeadLecture(req, body.lecture_id));
    if (lecture.course_id !== course.course_id) fail(400, "Lecture does not belong to this course");
    if (lecture.day !== day) fail(400, `${date} is a ${day}, but this lecture is held on ${lecture.day}`);
    if (lecture.override_id || sameDay.some((o) => o.lecture_id === lecture.lecture_id || (o.replaces || []).includes(lecture.lecture_id))) {
      fail(409, "This lecture already has a temporary change on that date. Undo it first.");
    }
    sem = parseSem(lecture.semester);
    if (sem === null && lecture.subject_id) {
      const sd = await db.collection("subjects").doc(lecture.subject_id).get();
      if (sd.exists) sem = parseSem(sd.data().semester);
    }
    doc.lecture_id = lecture.lecture_id;
    doc.semester = sem;
  }

  if (kind === "modify") {
    const c = body.changes || {};
    const changes = {};
    let teacher = null;
    if (c.teacher_id) {
      teacher = await activeTeacherOrFail(req, c.teacher_id);
      if (teacher.id !== lecture.teacher_id) { changes.teacher_id = teacher.id; changes.teacher_name = teacher.name; }
    }
    const st = c.start_time !== undefined && c.start_time !== "" ? normTime(c.start_time) : null;
    const en = c.end_time   !== undefined && c.end_time   !== "" ? normTime(c.end_time)   : null;
    if ((c.start_time && !st) || (c.end_time && !en)) fail(400, "start_time and end_time must be HH:MM (24h)");
    if (st && st !== lecture.start_time) changes.start_time = st;
    if (en && en !== lecture.end_time)   changes.end_time = en;
    if (c.room !== undefined && String(c.room).trim() !== String(lecture.room || "")) changes.room = String(c.room).trim();
    if (!Object.keys(changes).length) fail(400, "Nothing changes — pick another teacher, time or room");
    const newStart = changes.start_time || lecture.start_time, newEnd = changes.end_time || lecture.end_time;
    if (toMin(newStart) >= toMin(newEnd)) fail(400, "end_time must be after start_time");
    doc.changes = changes;
    const timeChanged = !!(changes.start_time || changes.end_time);
    only = timeChanged ? null : new Set([changes.teacher_id ? "teacher" : null, changes.room !== undefined ? "room" : null].filter(Boolean));
    cand = {
      day, start_time: newStart, end_time: newEnd,
      room: changes.room !== undefined ? changes.room : lecture.room,
      course_id: course.course_id, semester: sem,
      teacher_id: changes.teacher_id || lecture.teacher_id,
      division_id: lecture.division_id || undefined,
      egroup: lecture.subject_id ? (await egroupOfSubjectId(lecture.subject_id)) : undefined,
    };
    exclude = [lecture.lecture_id];
  }

  if (kind === "cancel") {
    // nothing to conflict with
  }

  if (kind === "special") {
    const sp = body.special || {};
    // A special session may be tied to a subject, or be a free-standing one
    // (guest lecture, seminar, ...) that only has a title.
    let subject = null, teacher = null;
    const title = String(sp.title || "").trim();
    const guest = String(sp.guest || "").trim();
    if (title.length > 80 || guest.length > 80) fail(400, "Title and guest name can be at most 80 characters");
    if (sp.subject_id) {
      subject = (await loadHeadSubject(req, sp.subject_id)).subject;
      if (subject.course_id !== course.course_id) fail(400, "Subject does not belong to this course");
      sem = parseSem(subject.semester);
      if (sem === null) fail(400, "This subject has no valid semester");
      const tId = sp.teacher_id || subject.teacher_assigned;
      if (!tId) fail(400, "Pick a teacher for the special session");
      teacher = await activeTeacherOrFail(req, tId);
    } else {
      if (!title) fail(400, "Give the special session a title (or pick a subject)");
      sem = parseSem(body.semester);
      if (sem === null) fail(400, "semester is required for a session without a subject");
      if (sp.teacher_id) teacher = await activeTeacherOrFail(req, sp.teacher_id);
    }
    const slot = readSlotFields({ day, start_time: sp.start_time, end_time: sp.end_time, room: sp.room });
    const replaced = Array.isArray(body.replaces) && body.replaces.length
      ? await loadReplaceable(req, body.replaces, course, sem, day) : [];
    if (replaced.some((l) => l.override_id || sameDay.some((o) => o.lecture_id === l.lecture_id || (o.replaces || []).includes(l.lecture_id)))) {
      fail(409, "One of those lectures already has a temporary change on that date. Undo it first.");
    }
    doc.semester = sem;
    const spDivision = await divisionOrFail(req, course, sem, body.division_id || sp.division_id);
    if (spDivision) doc.division_id = spDivision.division_id;
    doc.special = clean({
      division_id: spDivision ? spDivision.division_id : undefined,
      division_name: spDivision ? spDivision.name : undefined,
      subject_id: subject ? subject.subject_id : undefined,
      subject_name: subject ? (subject.subject_name || "") : title,
      subject_code: subject ? (subject.subject_code || "") : "",
      custom: subject ? undefined : true,
      teacher_id: teacher ? teacher.id : undefined,
      teacher_name: teacher ? teacher.name : guest,
      start_time: slot.start_time, end_time: slot.end_time, room: slot.room,
    });
    doc.replaces = replaced.map((l) => l.lecture_id);
    cand = { day, start_time: slot.start_time, end_time: slot.end_time, room: slot.room, course_id: course.course_id, semester: sem, teacher_id: teacher ? teacher.id : undefined, division_id: doc.division_id, egroup: egroupOfSubject(subject) };
    exclude = doc.replaces;
  }

  if (cand) {
    // clashes are judged against what that date will actually look like
    const base = baseOf(await loadDayLectures(req, day, course.course_id), sameDay);
    const list = effectiveOf(base, sameDay).filter((l) => !exclude.includes(l.lecture_id));
    await annotateElectiveGroups(list, course.course_id);
    let conflicts = conflictsAgainst(list, cand);
    if (only) conflicts = conflicts.filter((c) => only.has(c.type));
    if (conflicts.length && !force) fail(409, "This clashes with another session on that day", { conflicts });
  }

  const ref = db.collection("timetable_overrides").doc();
  await ref.set(clean({ ...doc, override_id: ref.id }));
  await audit(req, "timetable.override.create", "timetable_overrides", ref.id, clean({ kind, date, lecture_id: doc.lecture_id, semester: sem }));

  let status = "scheduled";
  if (date === today) {                       // takes effect immediately
    try { await syncOverrides(); status = (await ref.get()).data().status; } catch (err) { console.error("HEAD: override sync failed", err); }
  }
  return res.status(201).json({ success: true, override_id: ref.id, status });
}));

router.delete("/timetable/overrides/:id", wrap(async (req, res) => {
  const snap = await db.collection("timetable_overrides").doc(String(req.params.id)).get();
  if (!snap.exists) fail(404, "Change not found");
  const o = { ...snap.data(), override_id: snap.id };
  if (!req.head.courseMap[o.course_id]) fail(403, "This change is not in your department");
  if (o.status === "applied") await revertOverride(o);          // put today's lectures back first
  await snap.ref.delete();
  await audit(req, "timetable.override.delete", "timetable_overrides", snap.id, { kind: o.kind, date: o.date });
  return res.json({ success: true });
}));

// keep overrides moving even when nobody opens the timetable
setTimeout(() => syncOverrides().catch((e) => console.error("HEAD: override sync failed", e)), 20 * 1000).unref();
setInterval(() => syncOverrides().catch((e) => console.error("HEAD: override sync failed", e)), 5 * 60 * 1000).unref();

// ─────────────────────────────────────────────────────────────────────────────
// ACADEMIC CALENDAR
// ─────────────────────────────────────────────────────────────────────────────
function eventView(id, e, department) {
  const start = e.start_date || e.date || null;
  const type = e.event_type || "general";
  return {
    event_id: id,
    title: e.title || "",
    event_type: type,
    start_date: start,
    end_date: e.end_date || start,
    description: e.description || "",
    academic_year: e.academic_year || (start ? academicYearOf(start) : null),
    scope: e.department ? "department" : "institute",
    department: e.department || null,
    editable: !!e.department && up(e.department) === up(department),
    automation: autoView(type, e, start),
  };
}

const leadDays = (e) => (Number.isInteger(e.notice_days) && e.notice_days >= 0 && e.notice_days <= 14 ? e.notice_days : NOTICE_LEAD_DAYS);

// What the automation will do / has done for this event (shown on the page).
function autoView(type, e, start) {
  if (!e.department) return null;
  if (type === "holiday") {
    const on = e.notify !== false;
    return {
      kind: "holiday_notice", enabled: on,
      status: !on ? "off" : (e.notice_status || "pending"),
      days_before: leadDays(e),
      send_on: on && start ? addDays(start, -leadDays(e)) : null,
      sent_at: toISO(e.notice_sent_at), recipients: e.notice_recipients ?? null,
    };
  }
  if (type === "defaulter") {
    return {
      kind: "defaulter_list", enabled: true,
      status: e.defaulter_status || "pending",
      send_on: start || null,
      course_id: e.course_id || null, semester: e.semester ?? null, from_date: e.from_date || null,
      sent_at: toISO(e.defaulter_sent_at), runs: e.defaulter_runs || [],
    };
  }
  return null;
}

const autoThrottle = new Map();   // "<aishe>|<dept>" -> last time a page load started the automation
router.get("/calendar", wrap(async (req, res) => {
  const { aishe_code, department } = req.head;
  const autoKey = `${aishe_code}|${department}`;
  if (Date.now() - (autoThrottle.get(autoKey) || 0) > 60_000) {
    autoThrottle.set(autoKey, Date.now());
    runCalendarAutomation({ aishe_code, department }).catch((e) => console.error("HEAD: calendar automation failed", e));
  }
  const snap = await db.collection("academic_calendar").where("aishe_code", "==", aishe_code).get();

  let events = snap.docs
    .filter((d) => !d.data().department || up(d.data().department) === up(department))
    .map((d) => eventView(d.id, d.data(), department));
  if (req.query.academic_year) events = events.filter((e) => e.academic_year === req.query.academic_year);
  events.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

  return res.json({ success: true, events });
}));

function readEventFields(req, body, current = {}) {
  const title = String(body.title !== undefined ? body.title : current.title || "").trim();
  if (!title) fail(400, "title is required");
  const event_type = body.event_type !== undefined ? body.event_type : (current.event_type || "general");
  if (!EVENT_TYPES.includes(event_type)) fail(400, `event_type must be one of ${EVENT_TYPES.join(", ")}`);
  const start_date = body.start_date !== undefined ? body.start_date : (current.start_date || current.date);
  if (!isDateStr(start_date)) fail(400, "start_date must be a valid YYYY-MM-DD date");
  let end_date = body.end_date ? body.end_date : (body.start_date === undefined && current.end_date ? current.end_date : start_date);
  if (event_type === "defaulter") end_date = start_date;          // a defaulter run happens on one day
  if (!isDateStr(end_date)) fail(400, "end_date must be a valid YYYY-MM-DD date");
  if (end_date < start_date) fail(400, "end_date cannot be before start_date");
  const description = String(body.description !== undefined ? body.description : current.description || "").trim();
  const academic_year = body.academic_year ? String(body.academic_year).trim() : academicYearOf(start_date);
  const f = { title, start_date, end_date, event_type, description, academic_year };

  if (event_type === "holiday") {
    f.notify = body.notify !== undefined ? body.notify !== false : current.notify !== false;
    const nd = body.notice_days !== undefined ? body.notice_days : (current.notice_days !== undefined ? current.notice_days : NOTICE_LEAD_DAYS);
    if (!Number.isInteger(nd) || nd < 0 || nd > 14) fail(400, "notice_days must be a whole number from 0 (same day) to 14");
    f.notice_days = nd;
  }
  if (event_type === "defaulter") {
    const cid = body.course_id !== undefined ? (body.course_id || null) : (current.course_id || null);
    if (cid && !(req.head.courseMap || {})[cid]) fail(400, "That course is not in your department");
    let sem = body.semester !== undefined ? body.semester : current.semester;
    sem = sem === null || sem === undefined || sem === "" ? null : parseSem(sem);
    if (sem === null && body.semester !== undefined && body.semester !== null && body.semester !== "") fail(400, "semester must be a number");
    f.course_id = cid;
    f.semester = sem;
    const from = body.from_date !== undefined ? (body.from_date || null) : (current.from_date || null);
    if (from !== null && !isDateStr(from)) fail(400, "from_date must be a valid YYYY-MM-DD date");
    if (from !== null && from > start_date) fail(400, "Attendance must be counted from a date on or before the list date");
    f.from_date = from;
  }
  return f;
}

router.post("/calendar", wrap(async (req, res) => {
  const f = readEventFields(req, req.body || {});
  const ref = db.collection("academic_calendar").doc();
  await ref.set(clean({
    event_id: ref.id,
    aishe_code: req.head.aishe_code,
    department: req.head.department,
    ...f,
    date: f.start_date, // kept for older readers that expect a single date
    notice_status: f.event_type === "holiday" && f.notify ? "pending" : undefined,
    defaulter_status: f.event_type === "defaulter" ? "pending" : undefined,
    created_by: req.head.teacher_id,
    created_at: ts(),
  }));
  await audit(req, "calendar.create", "academic_calendar", ref.id, f);
  // a holiday added inside its 2-day window is announced right away
  if (f.event_type === "holiday" || f.event_type === "defaulter") {
    runCalendarAutomation({ aishe_code: req.head.aishe_code, department: req.head.department, ignoreHour: true })
      .catch((e) => console.error("HEAD: calendar automation failed", e));
  }
  return res.status(201).json({ success: true, event_id: ref.id });
}));

async function loadOwnEvent(req, id) {
  const doc = await db.collection("academic_calendar").doc(String(id)).get();
  if (!doc.exists) fail(404, "Event not found");
  const e = doc.data();
  if (e.aishe_code !== req.head.aishe_code) fail(403, "Access denied");
  if (!e.department || up(e.department) !== up(req.head.department)) {
    fail(403, "Only events created for your department can be changed");
  }
  return { ref: doc.ref, event: e };
}

router.put("/calendar/:id", wrap(async (req, res) => {
  const { ref, event } = await loadOwnEvent(req, req.params.id);
  const f = readEventFields(req, req.body || {}, event);
  const patch = { ...f, date: f.start_date, updated_by: req.head.teacher_id, updated_at: ts() };

  // changing what was already announced re-arms the automation (a new, "Updated:" notice goes out)
  const typeChanged = f.event_type !== (event.event_type || "general");
  const moved = f.start_date !== (event.start_date || event.date) || f.end_date !== (event.end_date || event.start_date) || f.title !== event.title;
  if (f.event_type === "holiday") {
    if (typeChanged || (moved && event.notice_status === "sent") || (event.notice_status === "skipped" && moved)) {
      patch.notice_status = f.notify ? "pending" : FieldDelete();
      if (event.notice_status === "sent") patch.notice_version = (event.notice_version || 0) + 1;
    } else if (!f.notify) patch.notice_status = FieldDelete();
    else if (!event.notice_status) patch.notice_status = "pending";
  }
  if (f.event_type === "defaulter" && (typeChanged || (moved && event.defaulter_status !== "sent"))) {
    patch.defaulter_status = "pending";
  }
  await ref.update(clean(patch));
  await audit(req, "calendar.update", "academic_calendar", req.params.id, f);
  if (f.event_type === "holiday" || f.event_type === "defaulter") {
    runCalendarAutomation({ aishe_code: req.head.aishe_code, department: req.head.department, ignoreHour: true })
      .catch((e) => console.error("HEAD: calendar automation failed", e));
  }
  return res.json({ success: true });
}));

router.delete("/calendar/:id", wrap(async (req, res) => {
  const { ref, event } = await loadOwnEvent(req, req.params.id);
  await ref.delete();
  await audit(req, "calendar.delete", "academic_calendar", req.params.id, { title: event.title });
  return res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR AUTOMATION
//   holiday   → a notice to the department's students NOTICE_LEAD_DAYS before it starts
//   defaulter → on its date: per course + semester, per subject, roll numbers at
//               50% or less and above 50% up to 75%, announced to the whole class
// Notices are written to `broadcasts` (what the student inbox already reads)
// with automated:true. Every notice has a deterministic doc id, so a repeated
// run can never announce the same thing twice.
// ─────────────────────────────────────────────────────────────────────────────
let notifyFn = () => {};
try { notifyFn = require("../../services/notify").notify || notifyFn; } catch { /* push notifications are optional */ }

const istHour = () => new Date(Date.now() + IST_OFFSET_MS).getUTCHours();
const longDate = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const rollSort = (a, b) => String(a.roll_no || "").localeCompare(String(b.roll_no || ""), undefined, { numeric: true });
const courseIdOfStudent = (s, courses) => {
  const c = courses.find((x) => (s.course_id && s.course_id === x.course_id) || (s.degree && up(s.degree) === up(x.abbr)));
  return c ? c.course_id : null;
};

async function departmentCourses(aishe_code, department) {
  const snap = await db.collection("courses").where("aishe_code", "==", aishe_code).get();
  return snap.docs.map((d) => ({ ...d.data(), course_id: d.id })).filter((c) => courseInDepartment(c, department));
}

async function approvedStudents(aishe_code, courses) {
  return (await studentsOfCollege(aishe_code))
    .filter((s) => s.approval_status === "approved" && courseIdOfStudent(s, courses));
}

async function writeNotice(id, n) {
  const ref = db.collection("broadcasts").doc(id);
  if ((await ref.get()).exists) return { id, created: false };
  // create() (not set()) -> if two server processes run the automation at the same moment only one wins
  try { await ref.create(clean({
    broadcast_id: id,
    teacher_id: n.teacher_id,
    title: n.title,
    text: n.text,
    target_type: "class",
    subject_id: null,
    course_id: n.course_id || null,
    group_id: null,
    attendance_filter: "none",
    recipient_uids: n.uids,
    recipient_count: n.uids.length,
    is_urgent: false,
    read_by: [],
    automated: true,
    source: "academic_calendar",
    event_id: n.event_id,
    notice_kind: n.kind,
    semester: n.semester,
    created_at: ts(),
    updated_at: ts(),
  })); } catch (e) { if (isAlreadyExists(e)) return { id, created: false }; throw e; }
  try { notifyFn({ userIds: n.uids, title: n.title, body: n.text.slice(0, 120), data: { screen: "BroadcastInbox" } }); } catch (e) { console.error("HEAD: push failed", e.message); }
  return { id, created: true };
}

// ── holiday notice ──
async function sendHolidayNotice(id, e) {
  const courses = await departmentCourses(e.aishe_code, e.department);
  const students = await approvedStudents(e.aishe_code, courses);
  const uids = [...new Set(students.map((s) => s.uid || s.student_id))];
  const start = e.start_date || e.date, end = e.end_date || start;
  const when = end > start ? `from ${longDate(start)} to ${longDate(end)}` : `on ${longDate(start)}`;
  const version = e.notice_version || 0;
  const title = `${version ? "Updated: " : ""}Holiday — ${e.title}`;
  const text = `${e.title}: the college will remain closed ${when}.${e.description ? ` ${e.description}` : ""} Regular classes resume after the holiday.`;
  if (uids.length) {
    await writeNotice(`cal_${id}_notice${version ? `_v${version}` : ""}`, { teacher_id: e.created_by, title, text, uids, event_id: id, kind: "holiday" });
  }
  await db.collection("academic_calendar").doc(id).update({
    notice_status: "sent", notice_sent_at: ts(), notice_recipients: uids.length,
  });
  return { recipients: uids.length };
}

// ── attendance, many students of one subject at once ──
// Counts per lecture session (two lectures on one day count twice), for the
// completed sessions dated sinceDate … untilDate (inclusive, either may be null).
const attendanceOfSubject = (subject_id, sinceDate, untilDate) =>
  attendanceCache.memo(`${subject_id}|${sinceDate || ""}|${untilDate || ""}`, 30_000, () => attendanceOfSubjectUncached(subject_id, sinceDate, untilDate));

async function attendanceOfSubjectUncached(subject_id, sinceDate, untilDate) {
  const lecSnap = await db.collection("lectures").where("subject_id", "==", subject_id).select("division_id").get();
  const lectureIds = lecSnap.docs.map((d) => d.id);
  const lectureDiv = Object.fromEntries(lecSnap.docs.map((d) => [d.id, d.data().division_id || null]));
  const sessions = [];
  const diag = { lectures: lectureIds.length, sessions_any: 0, sessions_completed: 0, in_range: 0 };
  const sessionSnaps = await Promise.all(chunks(lectureIds, CHUNK).map((ch) =>
    db.collection("lecture_sessions").where("lecture_id", "in", ch).select("status", "date", "started_at", "lecture_id", "division_id").get()));
  for (const snap of sessionSnaps) {
    snap.docs.forEach((d) => {
      const x = d.data();
      diag.sessions_any++;
      if (x.status !== "completed") return;
      diag.sessions_completed++;
      const date = x.date || (toISO(x.started_at) || "").slice(0, 10) || "";
      if (date && sinceDate && date < sinceDate) return;
      if (date && untilDate && date > untilDate) return;
      sessions.push({ id: d.id, date, div: x.division_id || lectureDiv[x.lecture_id] || null });
    });
  }
  diag.in_range = sessions.length;
  const dateOf = Object.fromEntries(sessions.map((s) => [s.id, s.date]));
  const sessionsOnDate = {};
  sessions.forEach((s) => { (sessionsOnDate[s.date] = sessionsOnDate[s.date] || []).push(s.id); });
  const presentOf = {}; // uid → Set(session id)
  const mark = (uid, sid) => { if (uid && sid) (presentOf[uid] = presentOf[uid] || new Set()).add(sid); };
  const unmark = (uid, sid) => { if (presentOf[uid]) presentOf[uid].delete(sid); };

  const [attSnaps, recSnap] = await Promise.all([
    Promise.all(chunks(sessions.map((s) => s.id), CHUNK).map((ch) =>
      db.collection("attendance_sessions").where("lecture_session_id", "in", ch).select("lecture_session_id", "present_students").get())),
    db.collection("attendance_records").where("subject_id", "==", subject_id)
      .select("lecture_session_id", "status", "student_uid", "source", "date", "created_at", "marked_at").get(),
  ]);
  attSnaps.forEach((snap) => snap.docs.forEach((d) => {
    const x = d.data();
    (x.present_students || []).forEach((uid) => mark(uid, x.lecture_session_id));
  }));
  const counts = (st) => st === "present" || st === "late" || st === "od";
  const recs = recSnap.docs.map((d) => d.data());
  recs.forEach((r) => { if (r.lecture_session_id && dateOf[r.lecture_session_id] !== undefined && counts(r.status)) mark(r.student_uid, r.lecture_session_id); });
  recs.forEach((r) => {            // OD / manual entries are per date
    if (r.source !== "od" && r.source !== "manual") return;
    const date = r.date || (toISO(r.created_at) || "").slice(0, 10) || (toISO(r.marked_at) || "").slice(0, 10);
    const ids = sessionsOnDate[date] || [];
    if (r.source === "od" ? counts(r.status || "od") : counts(r.status)) ids.forEach((sid) => mark(r.student_uid, sid));
    else if (r.source === "manual" && r.status === "absent") ids.forEach((sid) => unmark(r.student_uid, sid));
  });
  // lectures held for ONE division = the common ones + that division's own (no division = common ones only)
  const totalFor = (divisionId) => sessions.filter((x) => !x.div || x.div === (divisionId || null)).length;
  return { total: sessions.length, totalFor, presentOf, diag };
}

// the attendance period of a semester: since the start of its current (or last) run
async function semesterSince(course_id, sem) {
  const snap = await db.collection("semester_dates").where("course_id", "==", course_id).get();
  const row = snap.docs.map((d) => d.data()).find((r) => parseSem(r.semester) === sem);
  const w = readWindow(row);
  if (!w) return null;
  const r = win.resolveRun(w.start, w.end, todayIST());
  return r.status === "active" ? r.run.start_date : (r.previous ? r.previous.start_date : null);
}

// Defaulters of one course + semester. Pure read — nothing is written.
async function defaultersOf(course, sem, students, fromDate = null, untilDate = null) {
  const classStudents = students.filter((s) => courseIdOfStudent(s, [course]) && parseSem(s.semester) === sem);
  const subjects = (await subjectsOfCourse(course.course_id))
    .filter((x) => parseSem(x.semester) === sem)
    .sort((a, b) => String(a.subject_code || "").localeCompare(String(b.subject_code || "")));
  const since = fromDate || await semesterSince(course.course_id, sem);
  const until = untilDate || todayIST();

  const atts = await mapLimit(subjects, 4, (subj) => attendanceOfSubject(subj.subject_id, since, until));
  const rows = [];
  for (const [si, subj] of subjects.entries()) {
    const enrolled = classStudents.filter((s) => !Array.isArray(s.enrolled_subjects) || s.enrolled_subjects.includes(subj.subject_id));
    const att = atts[si];
    const row = { subject_id: subj.subject_id, subject_code: subj.subject_code || "", subject_name: subj.subject_name || "", total_lectures: att.total, lecture_slots: att.diag.lectures, sessions_completed: att.diag.sessions_completed, sessions_any: att.diag.sessions_any, below_50: [], from_51_to_75: [] };
    if (att.total > 0) {
      enrolled.forEach((s) => {
        const uid = s.uid || s.student_id;
        const held = att.totalFor(s.division_id);
        if (!held) return;
        const attended = Math.min((att.presentOf[uid] || new Set()).size, held);
        const pct = Math.round((attended / held) * 1000) / 10;
        const item = { uid, roll_no: s.roll_no || "", name: s.name || `${s.first_name || ""} ${s.last_name || ""}`.trim(), attendance_pct: pct };
        if (pct <= 50) row.below_50.push(item);
        else if (pct <= 75) row.from_51_to_75.push(item);
      });
      row.below_50.sort(rollSort);
      row.from_51_to_75.sort(rollSort);
    }
    rows.push(row);
  }
  return {
    course_id: course.course_id, course_abbr: course.abbr || "", course_name: course.course_name || "",
    semester: sem, since, until, class_size: classStudents.length, subjects: rows,
    total_defaulters: new Set(rows.flatMap((r) => [...r.below_50, ...r.from_51_to_75].map((i) => i.uid))).size,
  };
}

function defaulterText(list, asOn) {
  const roll = (arr) => (arr.length ? arr.map((i) => i.roll_no || i.name).join(", ") : "none");
  const withAny = list.subjects.filter((r) => r.below_50.length || r.from_51_to_75.length);
  const period = list.since ? `from ${longDate(list.since)} to ${longDate(asOn)}` : `up to ${longDate(asOn)}`;
  const lines = [`Attendance defaulter list — ${list.course_abbr || list.course_name} · ${semLabel(list.semester)} (attendance ${period}).`,
    "Roll numbers with 50% or less, and above 50% up to 75%, attendance. Please attend your lectures regularly."];
  withAny.forEach((r) => {
    lines.push("", `${[r.subject_code, r.subject_name].filter(Boolean).join(" ")}`,
      `• 50% or less: ${roll(r.below_50)}`, `• 51% – 75%: ${roll(r.from_51_to_75)}`);
  });
  const clear = list.subjects.filter((r) => r.total_lectures > 0 && !r.below_50.length && !r.from_51_to_75.length);
  if (clear.length) lines.push("", `No defaulters in: ${clear.map((r) => r.subject_code || r.subject_name).join(", ")}.`);
  return lines.join("\n");
}

async function runDefaulterEvent(id, e, { rerun = false } = {}) {
  const asOn = todayIST();
  const courses = (await departmentCourses(e.aishe_code, e.department)).filter((c) => !e.course_id || c.course_id === e.course_id);
  const students = await approvedStudents(e.aishe_code, courses);
  const runs = [];
  const gen = (e.defaulter_generation || 0) + (rerun ? 1 : 0);

  for (const course of courses) {
    const sems = e.semester ? [e.semester] : [...new Set(students.filter((s) => courseIdOfStudent(s, [course]) && parseSem(s.semester) !== null).map((s) => parseSem(s.semester)))].sort((a, b) => a - b);
    for (const sem of sems) {
      const list = await defaultersOf(course, sem, students, e.from_date || null, asOn);
      if (!list.class_size) continue;
      const classUids = students.filter((s) => courseIdOfStudent(s, [course]) && parseSem(s.semester) === sem).map((s) => s.uid || s.student_id);
      const text = defaulterText(list, asOn);
      let broadcast_id = null, announced = false;
      if (list.total_defaulters > 0) {
        const w = await writeNotice(`cal_${id}_${course.course_id}_${sem}${gen ? `_r${gen}` : ""}`, {
          teacher_id: e.created_by, title: `Attendance defaulter list — ${course.abbr || course.course_name} ${semLabel(sem)}`,
          text, uids: classUids, course_id: course.course_id, semester: sem, event_id: id, kind: "defaulter",
        });
        broadcast_id = w.id; announced = true;
      }
      await db.collection("defaulter_lists").doc(`${id}_${course.course_id}_${sem}`).set(clean({
        event_id: id, aishe_code: e.aishe_code, department: e.department, as_on: asOn,
        ...list, text, broadcast_id: broadcast_id || null, announced, recipients: announced ? classUids.length : 0,
        generated_at: ts(),
      }));
      runs.push({ course_id: course.course_id, course_abbr: course.abbr || "", semester: sem, class_size: list.class_size,
        below_50: new Set(list.subjects.flatMap((r) => r.below_50.map((i) => i.uid))).size,
        from_51_to_75: new Set(list.subjects.flatMap((r) => r.from_51_to_75.map((i) => i.uid))).size,
        defaulters: list.total_defaulters, announced, recipients: announced ? classUids.length : 0 });
    }
  }
  await db.collection("academic_calendar").doc(id).update({
    defaulter_status: "sent", defaulter_sent_at: ts(), defaulter_runs: runs, defaulter_generation: gen,
  });
  return { runs };
}

// One pass over the calendar. `only` limits it to one department (page loads / edits).
let calendarRunning = null;
function runCalendarAutomation({ aishe_code = null, department = null, ignoreHour = false } = {}) {
  if (calendarRunning) return calendarRunning;
  calendarRunning = (async () => {
    const today = todayIST();
    const hourOk = ignoreHour || istHour() >= AUTO_HOUR_IST;
    let q = db.collection("academic_calendar");
    // the 15-minute timer only needs recent / upcoming events (all events of all colleges were read before)
    if (aishe_code) q = q.where("aishe_code", "==", aishe_code);
    else q = q.where("date", ">=", addDays(today, -60));
    const snap = await q.get();
    for (const d of snap.docs) {
      const e = d.data();
      if (!e.department || !e.created_by) continue;
      if (department && up(e.department) !== up(department)) continue;
      const start = e.start_date || e.date;
      const type = e.event_type;
      try {
        if (type === "holiday" && e.notify !== false && (!e.notice_status || e.notice_status === "pending")) {
          if (today > start) await d.ref.update({ notice_status: "skipped" });          // already started: nothing to announce
          else if (today >= addDays(start, -leadDays(e)) && hourOk) await sendHolidayNotice(d.id, { ...e, aishe_code: e.aishe_code });
        } else if (type === "defaulter" && (!e.defaulter_status || e.defaulter_status === "pending")) {
          if (today > addDays(start, LATE_GRACE_DAYS)) await d.ref.update({ defaulter_status: "missed" });
          else if (today >= start && hourOk) await runDefaulterEvent(d.id, e);
        }
      } catch (err) { console.error(`HEAD: calendar automation failed for ${d.id}`, err); }
    }
  })().finally(() => { calendarRunning = null; });
  return calendarRunning;
}
router.runCalendarAutomation = runCalendarAutomation;

setTimeout(() => runCalendarAutomation().catch((e) => console.error("HEAD: calendar automation failed", e)), 30 * 1000).unref();
setInterval(() => runCalendarAutomation().catch((e) => console.error("HEAD: calendar automation failed", e)), 15 * 60 * 1000).unref();

// Automatic semester change for students (services/semesterRollover.js).
// SEM_ROLLOVER=off | dry | on  (default "dry": it only logs what it would do until you set it to "on").
const rollover = require("../../services/semesterRollover");
rollover.start();

// manual: send the notice / generate the list now
router.post("/calendar/:id/run", wrap(async (req, res) => {
  const { event } = await loadOwnEvent(req, req.params.id);
  const e = { ...event, aishe_code: req.head.aishe_code };
  const force = req.body && req.body.force === true;
  if (calendarRunning) await calendarRunning.catch(() => {});
  const fresh = { ...e, ...(await db.collection("academic_calendar").doc(req.params.id).get()).data() };
  if (fresh.event_type === "holiday") {
    if (fresh.notice_status === "sent" && !force) fail(409, "The notice for this holiday was already sent.", { already: true });
    const r = await sendHolidayNotice(req.params.id, fresh.notice_status === "sent" ? { ...fresh, notice_version: (fresh.notice_version || 0) + 1 } : fresh);
    await audit(req, "calendar.notice.send", "academic_calendar", req.params.id, r);
    return res.json({ success: true, ...r });
  }
  if (fresh.event_type === "defaulter") {
    if (fresh.defaulter_status === "sent" && !force) fail(409, "The defaulter list for this event was already announced.", { already: true });
    const r = await runDefaulterEvent(req.params.id, fresh, { rerun: fresh.defaulter_status === "sent" });
    await audit(req, "calendar.defaulters.run", "academic_calendar", req.params.id, { runs: r.runs.length });
    return res.json({ success: true, ...r });
  }
  fail(400, "Only holiday and defaulter-list events are automated");
}));

// the lists of a defaulter event: the stored ones once it ran, otherwise a live preview
router.get("/calendar/:id/defaulters", reportLimit, reportGate, wrap(async (req, res) => {
  const { event } = await loadOwnEvent(req, req.params.id);
  if (event.event_type !== "defaulter") fail(400, "Not a defaulter-list event");
  const stored = await db.collection("defaulter_lists").where("event_id", "==", req.params.id).get();
  if (!stored.empty && req.query.preview !== "1") {
    const lists = stored.docs.map((d) => d.data()).sort((a, b) => String(a.course_abbr).localeCompare(String(b.course_abbr)) || a.semester - b.semester)
      .map((l) => ({ ...l, generated_at: toISO(l.generated_at) }));
    return res.json({ success: true, preview: false, lists });
  }
  const courses = req.head.courses.filter((c) => !event.course_id || c.course_id === event.course_id);
  const students = await approvedStudents(req.head.aishe_code, courses);
  const lists = [];
  for (const course of courses) {
    const sems = event.semester ? [event.semester] : [...new Set(students.filter((s) => courseIdOfStudent(s, [course]) && parseSem(s.semester) !== null).map((s) => parseSem(s.semester)))].sort((a, b) => a - b);
    for (const sem of sems) {
      const l = await defaultersOf(course, sem, students, event.from_date || null, todayIST());
      if (l.class_size) lists.push({ ...l, as_on: todayIST() });
    }
  }
  return res.json({ success: true, preview: true, lists });
}));

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT REPORTS
// ─────────────────────────────────────────────────────────────────────────────
function studentView(s) {
  return {
    student_id: s.student_id,
    uid: s.uid || s.student_id,
    name: s.name || `${s.first_name || ""} ${s.last_name || ""}`.trim() || "Unknown",
    roll_no: s.roll_no || null,
    email: s.email || null,
    degree: s.degree || null,
    semester: s.semester !== undefined ? s.semester : null,
    approval_status: s.approval_status || null,
    division_id: s.division_id || null,
    division: s.division || null,
  };
}

// ?division_id=<id> keeps one division, ?division_id=none the students without one
const byDivision = (list, want) => {
  if (!want) return list;
  if (want === "none") return list.filter((s) => !s.division_id);
  return list.filter((s) => s.division_id === want);
};

const inDepartment = (req, s) =>
  req.head.courses.some((c) =>
    (s.course_id && s.course_id === c.course_id) || (s.degree && up(s.degree) === up(c.abbr)));

router.get("/students", wrap(async (req, res) => {
  const { course_id, semester, q, status } = req.query;
  const courses = course_id ? [courseOrFail(req, course_id)] : req.head.courses;
  const wantSem = semester ? parseSem(semester) : null;

  let students = [];
  for (const c of courses) students.push(...(await studentsOfCourse(req.head.aishe_code, c)));
  const seen = new Set();
  students = students.filter((s) => (seen.has(s.student_id) ? false : seen.add(s.student_id)));

  if (status !== "all") students = students.filter((s) => s.approval_status === "approved");
  if (wantSem !== null) students = students.filter((s) => Number(s.semester) === wantSem);
  students = byDivision(students, req.query.division_id ? String(req.query.division_id) : "");
  if (q) {
    const needle = String(q).trim().toLowerCase();
    students = students.filter((s) => {
      const v = studentView(s);
      return [v.name, v.roll_no, v.email].some((x) => String(x || "").toLowerCase().includes(needle));
    });
  }
  students.sort((a, b) => String(a.roll_no || "").localeCompare(String(b.roll_no || ""), undefined, { numeric: true }) ||
    studentView(a).name.localeCompare(studentView(b).name));

  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const total = students.length;

  return res.json({
    success: true,
    students: students.slice((page - 1) * limit, page * limit).map(studentView),
    pagination: { total, page, limit, total_pages: Math.ceil(total / limit) },
  });
}));

// Attendance for ONE student in ONE subject — same sources/de-dup rules as
// the teacher class-report (sessions, present_students, records, OD, manual).
async function subjectAttendance(subject_id, uid, records, divisionId = null) {
  const lecSnap = await db.collection("lectures").where("subject_id", "==", subject_id).get();
  // only the lectures this student was meant to attend: common ones + their own division's
  const lectureIds = lecSnap.docs.filter((d) => !d.data().division_id || d.data().division_id === (divisionId || null)).map((d) => d.id);

  const sessions = []; // { id, date }
  const sessSnaps = await Promise.all(chunks(lectureIds, CHUNK).map((ch) =>
    db.collection("lecture_sessions")
      .where("lecture_id", "in", ch)
      .where("status", "==", "completed")
      .select("date", "started_at")
      .get()));
  for (const snap of sessSnaps) {
    snap.docs.forEach((d) => {
      const x = d.data();
      sessions.push({ id: d.id, date: x.date || (toISO(x.started_at) || "").slice(0, 10) || d.id });
    });
  }
  const dateOf = Object.fromEntries(sessions.map((s) => [s.id, s.date]));
  const present = new Set();

  // A: attendance_sessions.present_students
  const attSnaps = await Promise.all(chunks(sessions.map((s) => s.id), CHUNK).map((ch) =>
    db.collection("attendance_sessions").where("lecture_session_id", "in", ch).select("lecture_session_id", "present_students").get()));
  attSnaps.forEach((snap) => snap.docs.forEach((d) => {
    const x = d.data();
    if ((x.present_students || []).includes(uid)) present.add(dateOf[x.lecture_session_id] || d.id);
  }));

  // B: records tied to a session; C: OD; D: manual (manual absent overrides)
  const counts = (st) => st === "present" || st === "late" || st === "od";
  records.forEach((r) => {
    if (r.lecture_session_id && dateOf[r.lecture_session_id] && counts(r.status)) {
      present.add(dateOf[r.lecture_session_id]);
    }
  });
  records.forEach((r) => {
    if (r.subject_id !== subject_id) return;
    const date = r.date || (toISO(r.created_at) || "").slice(0, 10) || (toISO(r.marked_at) || "").slice(0, 10);
    if (!date) return;
    if (r.source === "od" && counts(r.status || "od")) present.add(date);
    if (r.source === "manual") {
      if (counts(r.status)) present.add(date);
      else if (r.status === "absent") present.delete(date);
    }
  });

  return { total: sessions.length, sessions, present };
}

router.get("/students/:id/report", reportLimit, reportGate, wrap(async (req, res) => {
  const threshold = Math.min(100, Math.max(0, Number(req.query.threshold) || 75));

  const doc = await db.collection("students").doc(String(req.params.id)).get();
  if (!doc.exists) fail(404, "Student not found");
  const s = { ...doc.data(), student_id: doc.id };
  if (s.aishe_code !== req.head.aishe_code || !inDepartment(req, s)) {
    fail(403, "This student is not in your department");
  }
  const uid = s.uid || doc.id;

  const subjectIds = Array.isArray(s.enrolled_subjects) ? s.enrolled_subjects : [];
  const subjectDocs = await getAllDocs(subjectIds.map((id) => db.collection("subjects").doc(id)));
  const subjects = subjectDocs.filter((d) => d.exists).map((d) => ({ ...d.data(), subject_id: d.id }));

  const teacherIds = [...new Set(subjects.map((x) => x.teacher_assigned).filter(Boolean))];
  const teacherDocs = await getAllDocs(teacherIds.map((id) => db.collection("teachers").doc(id)));
  const tNames = {};
  teacherDocs.forEach((d) => { if (d.exists) tNames[d.id] = personName(d.data()); });

  const recSnap = await db.collection("attendance_records").where("student_uid", "==", uid).get();
  const records = recSnap.docs.map((d) => d.data());

  const monthTotal = {}, monthPresent = {};
  let sumTotal = 0, sumPresent = 0;
  const rows = [];

  const attList = await mapLimit(subjects, 4, (subj) => subjectAttendance(subj.subject_id, uid, records, s.division_id || null));
  for (const [si, subj] of subjects.entries()) {
    const a = attList[si];
    const attended = a.present.size;
    const pct = a.total > 0 ? Math.min(100, Math.round((attended / a.total) * 1000) / 10) : null;
    sumTotal += a.total;
    sumPresent += Math.min(attended, a.total);

    a.sessions.forEach((x) => { const k = String(x.date).slice(0, 7); monthTotal[k] = (monthTotal[k] || 0) + 1; });
    a.present.forEach((dte) => { const k = String(dte).slice(0, 7); monthPresent[k] = (monthPresent[k] || 0) + 1; });

    rows.push({
      subject_id: subj.subject_id,
      subject_name: subj.subject_name || "",
      subject_code: subj.subject_code || "",
      teacher_name: subj.teacher_assigned ? (tNames[subj.teacher_assigned] || "Unknown") : null,
      total_lectures: a.total,
      attended: Math.min(attended, a.total),
      attendance_pct: pct,
      below_threshold: pct !== null && pct < threshold,
    });
  }
  rows.sort((x, y) => String(x.subject_code).localeCompare(String(y.subject_code)));

  const trend = Object.keys(monthTotal).sort().map((k) => ({
    month: k,
    total: monthTotal[k],
    attended: Math.min(monthPresent[k] || 0, monthTotal[k]),
    pct: Math.round((Math.min(monthPresent[k] || 0, monthTotal[k]) / monthTotal[k]) * 1000) / 10,
  }));

  return res.json({
    success: true,
    student: studentView(s),
    summary: {
      threshold,
      total_lectures: sumTotal,
      attended: sumPresent,
      overall_pct: sumTotal > 0 ? Math.round((sumPresent / sumTotal) * 1000) / 10 : null,
      subjects_below_threshold: rows.filter((r) => r.below_threshold).length,
    },
    subjects: rows,
    trend,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// FULL STUDENT REPORT — one student, a class (course + semester) or the whole
// department: attendance (per subject), quizzes, assignments and OD requests.
//   GET /reports?scope=student|class|department&student_id=&course_id=&semester=&from=&to=&threshold=75
// ─────────────────────────────────────────────────────────────────────────────
const r1 = (n) => Math.round(n * 10) / 10;
const dateOfIso = (v) => { const i = toISO(v); return i ? i.slice(0, 10) : null; };
const inRange = (d, from, to) => !d || ((!from || d >= from) && (!to || d <= to));

async function subjectActivity(subject_id, from, to) {
  const now = Date.now();
  const att = await attendanceOfSubject(subject_id, from, to);

  const qSnap = await db.collection("quizzes").where("subject_id", "==", subject_id).get();
  const quizzes = qSnap.docs.map((d) => ({ ...d.data(), quiz_id: d.data().quiz_id || d.id }))
    .filter((q) => inRange(dateOfIso(q.scheduled_end) || dateOfIso(q.scheduled_start), from, to));
  const quizSubs = {};   // quiz_id → uid → submission
  for (const ch of chunks(quizzes.map((q) => q.quiz_id), CHUNK)) {
    const snap = await db.collection("quiz_submissions").where("quiz_id", "in", ch).get();
    snap.docs.forEach((d) => { const x = d.data(); (quizSubs[x.quiz_id] = quizSubs[x.quiz_id] || {})[x.student_uid] = x; });
  }

  const aSnap = await db.collection("assignments").where("subject_id", "==", subject_id).get();
  const assignments = aSnap.docs.map((d) => ({ ...d.data(), assignment_id: d.data().assignment_id || d.id }))
    .filter((a) => inRange(dateOfIso(a.due_date), from, to));
  const asgSubs = {};    // assignment_id → uid → submission
  for (const ch of chunks(assignments.map((a) => a.assignment_id), CHUNK)) {
    const snap = await db.collection("submissions").where("assignment_id", "in", ch).get();
    snap.docs.forEach((d) => { const x = d.data(); (asgSubs[x.assignment_id] = asgSubs[x.assignment_id] || {})[x.student_uid] = x; });
  }

  const oSnap = await db.collection("od_requests").where("subject_id", "==", subject_id).get();
  const ods = oSnap.docs.map((d) => ({ ...d.data(), od_id: d.data().od_id || d.id })).filter((o) => inRange(o.from_date, from, to));
  const odsBy = {};
  ods.forEach((o) => { (odsBy[o.student_uid] = odsBy[o.student_uid] || []).push(o); });

  return { att, quizzes, quizSubs, assignments, asgSubs, odsBy, now };
}

function studentRow(s, course, subjects, acts, withDetail) {
  const uid = s.uid || s.student_id;
  const mine = subjects.filter((x) => !Array.isArray(s.enrolled_subjects) || s.enrolled_subjects.includes(x.subject_id));
  let attended = 0, total = 0;
  const q = { total: 0, attempted: 0, missed: 0, upcoming: 0, pctSum: 0, got: 0, out: 0 };
  const a = { total: 0, submitted: 0, late: 0, graded: 0, missed: 0, pending: 0, pctSum: 0, gradedN: 0 };
  const od = { total: 0, approved: 0, pending: 0, rejected: 0 };
  const per = {}, detail = [];

  mine.forEach((subj) => {
    const act = acts[subj.subject_id];
    if (!act) return;
    const held = act.att.totalFor(s.division_id);
    const got = Math.min((act.att.presentOf[uid] || new Set()).size, held);
    if (held > 0) { attended += got; total += held; }
    per[subj.subject_id] = { attended: got, total: held, pct: held ? r1((got / held) * 100) : null };

    const qList = act.quizzes.map((qz) => {
      const sub = (act.quizSubs[qz.quiz_id] || {})[uid];
      const end = qz.scheduled_end ? new Date(toISO(qz.scheduled_end)).getTime() : null;
      const status = sub ? "attempted" : end && end < act.now ? "missed" : "upcoming";
      const tm = Number(qz.total_marks) || 0;
      const pct = sub ? (typeof sub.percentage === "number" ? sub.percentage : tm ? r1((Number(sub.marks_obtained) / tm) * 100) : null) : null;
      q.total++; q[status === "attempted" ? "attempted" : status]++;
      if (sub) { if (pct !== null) q.pctSum += pct; q.got += Number(sub.marks_obtained) || 0; q.out += tm; }
      return { quiz_id: qz.quiz_id, title: qz.title || "Quiz", date: dateOfIso(qz.scheduled_end), total_marks: tm, marks_obtained: sub ? Number(sub.marks_obtained) || 0 : null, percentage: pct, status };
    });

    const aList = act.assignments.map((as) => {
      const sub = (act.asgSubs[as.assignment_id] || {})[uid];
      const due = as.due_date ? new Date(toISO(as.due_date)).getTime() : null;
      const status = sub ? (sub.status === "graded" ? "graded" : sub.status === "late" ? "late" : "submitted") : due && due < act.now ? "missed" : "pending";
      const max = Number(as.marks) || 0;
      const pct = sub && sub.status === "graded" && max ? r1((Number(sub.marks_obtained) / max) * 100) : null;
      a.total++;
      if (sub) { a.submitted++; if (status === "late") a.late++; if (status === "graded") { a.graded++; if (pct !== null) { a.pctSum += pct; a.gradedN++; } } }
      else if (status === "missed") a.missed++; else a.pending++;
      return { assignment_id: as.assignment_id, title: as.title || "Assignment", due_date: dateOfIso(as.due_date), max_marks: max, marks_obtained: sub && sub.status === "graded" ? Number(sub.marks_obtained) || 0 : null, percentage: pct, status, feedback: sub ? sub.feedback || null : null };
    });

    const oList = (act.odsBy[uid] || []).map((o) => {
      od.total++; if (od[o.status] !== undefined) od[o.status]++;
      return { od_id: o.od_id, from_date: o.from_date, to_date: o.to_date, status: o.status, reason: o.reason || "" };
    });

    if (withDetail) {
      detail.push({
        subject_id: subj.subject_id, subject_code: subj.subject_code || "", subject_name: subj.subject_name || "",
        attendance: per[subj.subject_id], quizzes: qList, assignments: aList, od: oList,
      });
    }
  });

  const row = {
    student_id: s.student_id, uid,
    name: s.name || `${s.first_name || ""} ${s.last_name || ""}`.trim() || "Unknown",
    roll_no: s.roll_no || "", email: s.email || null,
    course_id: course.course_id, course_abbr: course.abbr || "", semester: parseSem(s.semester),
    division_id: s.division_id || null, division: s.division || "",
    attendance: { attended, total, pct: total ? r1((attended / total) * 100) : null },
    quizzes: { total: q.total, attempted: q.attempted, missed: q.missed, upcoming: q.upcoming, avg_pct: q.attempted ? r1(q.pctSum / q.attempted) : null, marks_obtained: q.got, marks_total: q.out },
    assignments: { total: a.total, submitted: a.submitted, late: a.late, graded: a.graded, missed: a.missed, pending: a.pending, avg_pct: a.gradedN ? r1(a.pctSum / a.gradedN) : null },
    od,
    per_subject: per,
  };
  if (withDetail) row.detail = detail;
  return row;
}

router.get("/reports", reportLimit, reportGate, wrap(async (req, res) => {
  const scope = String(req.query.scope || "");
  if (!["student", "class", "department"].includes(scope)) fail(400, "scope must be student, class or department");
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;
  if ((from && !isDateStr(from)) || (to && !isDateStr(to))) fail(400, "from and to must be valid YYYY-MM-DD dates");
  if (from && to && from > to) fail(400, "The start date is after the end date");
  const threshold = Math.min(100, Math.max(1, Number(req.query.threshold) || 75));

  // ── who is in the report ──
  let students = [], label = "", courseList = req.head.courses;
  if (scope === "student") {
    const doc = await db.collection("students").doc(String(req.query.student_id || "_")).get();
    if (!doc.exists) fail(404, "Student not found");
    const s = { ...doc.data(), student_id: doc.id };
    if (s.aishe_code !== req.head.aishe_code || !inDepartment(req, s)) fail(403, "This student is not in your department");
    students = [s];
    label = `${s.name || personName(s)}${s.roll_no ? ` (Roll ${s.roll_no})` : ""}`;
  } else if (scope === "class") {
    const course = courseOrFail(req, req.query.course_id);
    const sem = parseSem(req.query.semester);
    if (sem === null) fail(400, "semester is required for a class report");
    courseList = [course];
    students = (await studentsOfCourse(req.head.aishe_code, course)).filter((s) => s.approval_status === "approved" && parseSem(s.semester) === sem);
    const divWant = req.query.division_id ? String(req.query.division_id) : "";
    students = byDivision(students, divWant);
    label = `${course.abbr || course.course_name} · ${semLabel(sem)}`;
    if (divWant === "none") label += " · No division";
    else if (divWant && students[0]) label += ` · Division ${students[0].division}`;
    else if (divWant) { const dv = (await divisionsOfCourse(course.course_id)).find((d) => d.division_id === divWant); if (dv) label += ` · Division ${dv.name}`; }
  } else {
    const sem = req.query.semester ? parseSem(req.query.semester) : null;
    const seen = new Set();
    for (const c of req.head.courses) students.push(...(await studentsOfCourse(req.head.aishe_code, c)));
    students = students.filter((s) => s.approval_status === "approved" && (sem === null || parseSem(s.semester) === sem) && (seen.has(s.student_id) ? false : seen.add(s.student_id)));
    label = `${req.head.department} department${sem !== null ? ` · ${semLabel(sem)}` : ""}`;
  }

  const courseOf = (s) => req.head.courses.find((c) => (s.course_id && s.course_id === c.course_id) || (s.degree && up(s.degree) === up(c.abbr))) || courseList[0] || {};

  // ── subjects in play ──
  const ids = [...new Set(students.flatMap((s) => (Array.isArray(s.enrolled_subjects) ? s.enrolled_subjects : [])))];
  const subjects = (await getAllDocs(ids.map((id) => db.collection("subjects").doc(id))))
    .filter((d) => d.exists && req.head.courseMap[d.data().course_id])
    .map((d) => ({ ...d.data(), subject_id: d.id }))
    .sort((a, b) => String(a.subject_code || "").localeCompare(String(b.subject_code || "")));

  const acts = {};
  for (const grp of chunks(subjects, 5)) {
    await Promise.all(grp.map(async (sj) => { acts[sj.subject_id] = await subjectActivity(sj.subject_id, from, to); }));
  }

  const rows = students.map((s) => studentRow(s, courseOf(s), subjects, acts, scope === "student"))
    .sort((a, b) => a.course_abbr.localeCompare(b.course_abbr) || (a.semester || 0) - (b.semester || 0) ||
      rollSort(a, b) || a.name.localeCompare(b.name));

  // ── summary ──
  const mean = (arr) => (arr.length ? r1(arr.reduce((x, y) => x + y, 0) / arr.length) : null);
  const withAtt = rows.filter((x) => x.attendance.pct !== null);
  const sumOf = (f) => rows.reduce((n, x) => n + f(x), 0);
  const dueAsg = sumOf((x) => x.assignments.submitted + x.assignments.missed);
  const summary = {
    students: rows.length,
    avg_attendance: mean(withAtt.map((x) => x.attendance.pct)),
    below_threshold: withAtt.filter((x) => x.attendance.pct < threshold).length,
    avg_quiz_pct: mean(rows.filter((x) => x.quizzes.avg_pct !== null).map((x) => x.quizzes.avg_pct)),
    quiz_attempt_rate: sumOf((x) => x.quizzes.attempted + x.quizzes.missed) ? r1((sumOf((x) => x.quizzes.attempted) / sumOf((x) => x.quizzes.attempted + x.quizzes.missed)) * 100) : null,
    assignment_submit_rate: dueAsg ? r1((sumOf((x) => x.assignments.submitted) / dueAsg) * 100) : null,
    avg_assignment_pct: mean(rows.filter((x) => x.assignments.avg_pct !== null).map((x) => x.assignments.avg_pct)),
    od_requests: sumOf((x) => x.od.total),
  };

  return res.json({
    success: true,
    scope, label, threshold, from, to, as_on: todayIST(),
    college_name: await collegeNameOf(req),
    department: req.head.department,
    subjects: scope === "class" || scope === "student" ? subjects.map((x) => ({ subject_id: x.subject_id, subject_code: x.subject_code || "", subject_name: x.subject_name || "" })) : [],
    summary, students: rows,
  });
}));

router.get("/audit", wrap(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const snap = await db.collection("head_audit_log")
    .where("aishe_code", "==", req.head.aishe_code)
    .where("department", "==", req.head.department)
    .get();

  const entries = snap.docs
    .map((d) => ({ id: d.id, ...d.data(), created_at: toISO(d.data().created_at) }))
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, limit);

  return res.json({ success: true, entries });
}));

// What the automatic semester change would do for this college today (changes nothing).
router.get("/rollover/preview", wrap(async (req, res) => {
  const preview = await rollover.preview({ aisheCode: req.head.aishe_code });
  return res.json({ success: true, mode: rollover.mode(), preview });
}));

module.exports = router;