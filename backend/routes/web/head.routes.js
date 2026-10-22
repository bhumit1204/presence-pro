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
 *   POST   /subjects                                { course_id, subject_name, subject_code, semester, compulsary?, elective_group?, with_tutorial?, with_lab? }
 *                                                   with_tutorial / with_lab tick the Tutorial and Lab boxes: the subject is created with them in one call.
 *                                                   { type:"attach", parent_subject_id, with_tutorial?, with_lab? } adds a tutorial and/or lab to an existing subject in one call.
 *   PUT    /subjects/:id                            { subject_name?, subject_code?, semester?, compulsary?, elective_group? }
 *   DELETE /subjects/:id
 *   POST   /subjects/elective-group                 { course_id, semester, group, group_code?, with_tutorial?, with_lab?, subjects: [{ subject_name, subject_code?, with_tutorial?, with_lab? }, ...] }   one choice of n subjects
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
 *   DELETE /timetable/:id                           (a lab split into batches is deleted as a whole)
 *   POST   /timetable/generate/preview|apply, GET /timetable/generations, DELETE /timetable/generations/:id   (auto-generate a semester)
 *   GET    /timetable/batch-plan?course_id=&semester=&division_id=&count=2|3&cuts=   how the roll numbers split into lab batches
 *   POST   /timetable/batches                       { course_id, semester, division_id?, day, start_time, end_time, cuts?, batches: [{ subject_id, room?, teacher_id? }] }  one lab slot, 2 or 3 batches
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
 *
 * DELEGATION  The head can hand a Manage area (semesters, subjects, divisions, timetable, calendar, reports) of a course
 *        to other teachers. A delegate calls the SAME routes above, limited to the courses + areas delegated to them;
 *        the head keeps full access. Only the head can delegate, read the audit log or run the rollover preview.
 *   GET    /delegations                              (head) every delegation of the department + open suggestion counts
 *   POST   /delegations                              (head) { course_id, area, teacher_id }
 *   DELETE /delegations/:id                          (head) take an area back
 *   GET    /notes?course_id=&area=                   suggestion notes of one delegated area (head + its delegates)
 *   POST   /notes                                    { course_id, area, text, about? }
 *   POST   /notes/:id/reply                          { text }
 *   POST   /notes/:id/status                         { status: "open" | "done" }
 *   DELETE /notes/:id                                its author, or the head
 */

const express = require("express");
const router  = express.Router();
const { admin, db } = require("../../config/firebase");
const win = require("../../services/semesterWindow");
const { TTLCache } = require("../../utils/cache");
const { queueConcurrent, rateLimit } = require("../../utils/limiter");
const { isAlreadyExists } = require("../../utils/firestore");
const labBatches = require("../../utils/batches");
const subjT = require("../../utils/subjectTeachers");
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
  const aishe_code = teacher.aishe_code;
  if (!aishe_code) deny(403, "No institute linked to your account");

  if (department) {
    const courses = (await collegeCoursesOf(aishe_code)).filter((c) => courseInDepartment(c, department));
    return {
      uid,
      teacher_id: teacherDoc.id,
      teacher,
      aishe_code,
      department,
      is_head: true,
      courses,
      allCourses: courses,
      courseMap: Object.fromEntries(courses.map((c) => [c.course_id, c])),
    };
  }

  // not a head: allowed only through areas a head delegated to this teacher
  const dSnap = await db.collection("delegations").where("teacher_id", "==", teacherDoc.id).get();
  const rows = dSnap.docs.map((d) => d.data()).filter((r) => r.aishe_code === aishe_code);
  if (!rows.length) deny(403, "You are not the head of any department");
  const delegated = {};   // course_id -> Set(area)
  rows.forEach((r) => { (delegated[r.course_id] = delegated[r.course_id] || new Set()).add(r.area); });
  const courses = (await collegeCoursesOf(aishe_code)).filter((c) => delegated[c.course_id]);
  if (!courses.length) deny(403, "The courses delegated to you no longer exist");
  return {
    uid,
    teacher_id: teacherDoc.id,
    teacher,
    aishe_code,
    department: String(courses[0].department || courses[0].abbr || "").trim(),
    is_head: false,
    delegated,
    courses,
    allCourses: courses,
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

// ─── Delegation: which Manage areas a delegate may use ───────────────────────
const AREAS = [
  { key: "semesters", label: "Semesters" },
  { key: "subjects",  label: "Subjects & Faculty" },
  { key: "divisions", label: "Divisions" },
  { key: "timetable", label: "Timetable" },
  { key: "calendar",  label: "Academic Calendar" },
  { key: "reports",   label: "Student Reports" },
];
const SUBJECT_TYPES = ["compulsory", "elective", "lab", "tutorial", "attach"];
const AREA_KEYS = new Set(AREAS.map((a) => a.key));
const areaLabel = (k) => (AREAS.find((a) => a.key === k) || {}).label || k;
const MAX_DELEGATES = 5;   // per course + area

const AREA_ROUTES = [
  [/^\/semesters(\/|$)/, "semesters"],
  [/^\/(subjects|elective-groups)(\/|$)/, "subjects"],
  [/^\/divisions(\/|$)/, "divisions"],
  [/^\/(timetable|rooms|room-requests)(\/|$)/, "timetable"],
  [/^\/calendar(\/|$)/, "calendar"],
  [/^\/(students|reports)(\/|$)/, "reports"],
];
const SHARED_ROUTES = [/^\/context$/, /^\/teachers$/, /^\/notes(\/|$)/];   // checked inside, per course + area

// A head passes untouched. A delegate gets a copy of the context limited to the courses delegated for THIS area,
// so every existing course check (courseOrFail, courseMap, courses) enforces the delegation without further changes.
function areaGate(req, res, next) {
  const ctx = req.head;
  if (ctx.is_head) return next();
  if (SHARED_ROUTES.some((re) => re.test(req.path))) return next();
  const hit = AREA_ROUTES.find(([re]) => re.test(req.path));
  if (!hit) return res.status(403).json({ success: false, error: "Only the head can do this" });
  // the division list is a filter on the timetable and report pages too: reading it is allowed for those areas
  const allowed = req.method === "GET" && req.path === "/divisions" ? ["divisions", "timetable", "reports"] : [hit[1]];
  const courses = ctx.allCourses.filter((c) => ctx.delegated[c.course_id] && allowed.some((a) => ctx.delegated[c.course_id].has(a)));
  if (!courses.length) return res.status(403).json({ success: false, error: `${areaLabel(hit[1])} has not been delegated to you` });
  req.head = { ...ctx, courses, courseMap: Object.fromEntries(courses.map((c) => [c.course_id, c])) };
  return next();
}
router.use(areaGate);
const headOnly = (req) => { if (!req.head.is_head) fail(403, "Only the head can do this"); };

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
  } else if (subjT.effectiveTeacher(subject, l.division_id)) {
    const eff = subjT.effectiveTeacher(subject, l.division_id);
    // teacherName is one name (the default teacher) or a { teacher_id: name } map
    const nm = teacherName && typeof teacherName === "object" ? teacherName[eff] : (eff === subject.teacher_assigned ? teacherName : undefined);
    if (l.teacher_id !== eff) p.teacher_id = eff;
    if (nm && "teacher_name" in l && l.teacher_name !== nm) p.teacher_name = nm;
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
  // the batches of one lab slot run side by side: they may share the time (but never a teacher or a room)
  list.forEach((l) => { if (l.batch_no && l.slot_id) l.egroup = `batch|${l.slot_id}`; });
  if (!list.some((l) => l.course_id === course_id && l.subject_id)) return;
  const subs = await subjectsOfCourse(course_id);
  const byId = Object.fromEntries(subs.filter((x) => x.compulsary === false).map((x) => [x.subject_id, `${parseSem(x.semester)}|${groupKey(x)}`]));
  list.forEach((l) => { if (!l.egroup && l.course_id === course_id && byId[l.subject_id]) l.egroup = byId[l.subject_id]; });
}
const egroupOfSubject = (subject) => (subject && subject.compulsary === false ? `${parseSem(subject.semester)}|${groupKey(subject)}` : undefined);

async function egroupOfSubjectId(id) {
  const d = await db.collection("subjects").doc(String(id)).get();
  return d.exists ? egroupOfSubject(d.data()) : undefined;
}
// the group a lecture shares its time with: the other batches of its lab slot, or the other options of its elective group
async function egroupOfLecture(lec) {
  if (lec.batch_no && lec.slot_id) return `batch|${lec.slot_id}`;
  return lec.subject_id ? egroupOfSubjectId(lec.subject_id) : undefined;
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
  const { teacher, teacher_id, department, aishe_code, courses, is_head, delegated } = req.head;
  const areas = {};
  courses.forEach((c) => { areas[c.course_id] = is_head ? AREAS.map((a) => a.key) : [...(delegated[c.course_id] || [])]; });
  return res.json({
    success: true,
    is_head: !!is_head,
    areas,
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
    db.collection("subjects").where("aishe_code", "==", aishe_code).select("teacher_assigned", "division_teachers").get(),
  ]);

  const lectureCount = {}, minutes = {}, subjectCount = {};
  lectureSnap.docs.forEach((d) => {
    const l = d.data();
    if (!l.teacher_id) return;
    lectureCount[l.teacher_id] = (lectureCount[l.teacher_id] || 0) + 1;
    minutes[l.teacher_id] = (minutes[l.teacher_id] || 0) + Math.max(0, toMin(l.end_time) - toMin(l.start_time));
  });
  subjectSnap.docs.forEach((d) => {
    subjT.allTeacherIds(d.data()).forEach((t) => { subjectCount[t] = (subjectCount[t] || 0) + 1; });
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

  const teacherIds = new Set(subjects.flatMap((s) => subjT.allTeacherIds(s)));
  subjects.forEach((s) => (bySubject[s.subject_id] || []).forEach((l) => l.teacher_id && teacherIds.add(l.teacher_id)));
  const teacherDocs = await getAllDocs([...teacherIds].map((id) => db.collection("teachers").doc(id)));
  const names = {};
  teacherDocs.forEach((d) => { if (d.exists) names[d.id] = personName(d.data()); });

  // heal lectures that drifted from their subject (never blocks the response)
  try {
    const ops = [];
    subjects.forEach((s) => {
      ops.push(...lectureSyncOps(bySubject[s.subject_id] || [], s, names));
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
        division_teachers: Object.fromEntries(Object.entries(s.division_teachers || {}).filter(([, t]) => t).map(([d, t]) => [d, { teacher_id: t, teacher_name: names[t] || "Unknown" }])),
        created_by_role: s.created_by_role || "institute",
        kind: s.kind || null,
        has_tutorial: s.has_tutorial === true,
        has_lab: s.has_lab === true,
        tutorial_slots: lecs.filter((l) => l.kind === "tutorial").length,
        lab_slots: lecs.filter((l) => l.kind === "lab").length,
        lecture_count: lecs.length,
        timetable_teacher_name: stale ? (names[stale.teacher_id] || "Unknown") : null,
      };
    }),
  });
}));

router.post("/subjects", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);

  // Subject types: compulsory | elective | lab | tutorial.
  //   tutorial                 always belongs to an existing subject (same classroom, same teacher, same attendance)
  //   lab + parent_subject_id  a lab of an existing subject (uses its classroom)
  //   lab without a parent     a new lab subject with its own classroom
  const type = String(body.type || (body.compulsary === false ? "elective" : "compulsory"));
  if (!SUBJECT_TYPES.includes(type)) fail(400, `type must be one of ${SUBJECT_TYPES.join(", ")}`);
  if (type === "attach") {
    // Tutorial and/or Lab ticked for a subject that already exists: both are added in one call.
    const wantT = body.with_tutorial === true, wantL = body.with_lab === true;
    if (!wantT && !wantL) fail(400, "Tick Tutorial, Lab or both");
    if (!body.parent_subject_id) fail(400, "Pick the subject to add them to");
    const { ref: pref, subject: parent } = await loadHeadSubject(req, body.parent_subject_id);
    if (parent.course_id !== course.course_id) fail(400, "That subject belongs to another course");
    if (parent.kind === "lab") fail(400, "A lab subject can't have its own tutorial or lab. Pick the theory subject.");
    const add = {};
    if (wantT && parent.has_tutorial !== true) add.has_tutorial = true;
    if (wantL && parent.has_lab !== true) add.has_lab = true;
    if (!Object.keys(add).length) fail(409, `${parent.subject_name} already has ${wantT && wantL ? "a tutorial and a lab" : wantT ? "a tutorial" : "a lab"}`);
    await pref.update({ ...add, updated_at: ts() });
    dropProfileCaches();
    await audit(req, "subject.add_extras", "subjects", parent.subject_id, { subject_code: parent.subject_code, ...add });
    return res.status(201).json({ success: true, subject_id: parent.subject_id, linked: true, added: Object.keys(add) });
  }
  if (type === "tutorial" || (type === "lab" && body.parent_subject_id)) {
    if (!body.parent_subject_id) fail(400, "Pick the subject this tutorial belongs to");
    const { ref: pref, subject: parent } = await loadHeadSubject(req, body.parent_subject_id);
    if (parent.course_id !== course.course_id) fail(400, "That subject belongs to another course");
    if (parent.kind === "lab") fail(400, "A lab subject can't have its own tutorial or lab. Pick the theory subject.");
    const field = type === "tutorial" ? "has_tutorial" : "has_lab";
    if (parent[field] === true) fail(409, `${parent.subject_name} already has a ${type}`);
    await pref.update({ [field]: true, updated_at: ts() });
    dropProfileCaches();
    await audit(req, "subject.add_" + type, "subjects", parent.subject_id, { subject_code: parent.subject_code });
    return res.status(201).json({ success: true, subject_id: parent.subject_id, linked: true });
  }

  const subject_name = String(body.subject_name || "").trim();
  const subject_code = String(body.subject_code || "").trim().toUpperCase();
  const n = parseSem(body.semester);
  if (!subject_name || !subject_code) fail(400, "subject_name and subject_code are required");
  if (n === null || n > totalSemesters(course)) fail(400, `semester must be between 1 and ${totalSemesters(course)}`);

  const existing = await subjectsOfCourse(course.course_id);
  if (existing.some((s) => up(s.subject_code) === subject_code)) {
    fail(409, `A subject with code ${subject_code} already exists in ${course.abbr}`);
  }

  const compulsary = type === "elective" ? false : true;
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
    kind: type === "lab" ? "lab" : undefined,
    // Tutorial / Lab boxes ticked together with Lecture: the theory subject is created with them (a lab-only subject has neither)
    has_tutorial: type !== "lab" && body.with_tutorial === true ? true : undefined,
    has_lab: type !== "lab" && body.with_lab === true ? true : undefined,
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

  // tutorial / lab attached to this subject: switch on or off (off only when no slot uses it)
  for (const [field, kindName] of [["has_tutorial", "tutorial"], ["has_lab", "lab"]]) {
    if (body[field] === undefined) continue;
    const want = body[field] === true;
    if (want === (subject[field] === true)) continue;
    if (subject.kind === "lab") fail(400, "A lab subject can't have its own tutorial or lab");
    if (!want) {
      const used = (await db.collection("lectures").where("subject_id", "==", subject.subject_id).get()).docs.filter((d) => d.data().kind === kindName).length;
      if (used) fail(409, `${used} timetable slot${used === 1 ? " is" : "s are"} using this ${kindName}. Remove ${used === 1 ? "it" : "them"} from the timetable first.`);
    }
    update[field] = want;
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
    const wantT = it && it.with_tutorial !== undefined ? it.with_tutorial === true : body.with_tutorial === true;
    const wantL = it && it.with_lab !== undefined ? it.with_lab === true : body.with_lab === true;
    return { subject_name, subject_code, has_tutorial: wantT || undefined, has_lab: wantL || undefined };
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
      has_tutorial: r.has_tutorial, has_lab: r.has_lab,
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
  // with division_id the change is for that division only; without it, for the whole subject
  let division = null;
  if (body.division_id) {
    const dd = await db.collection("divisions").doc(String(body.division_id)).get();
    if (!dd.exists || dd.data().course_id !== subject.course_id) fail(400, "That division is not in this subject's course");
    if (parseSem(dd.data().semester) !== parseSem(subject.semester)) fail(400, "That division is not in this subject's semester");
    division = { id: dd.id, name: dd.data().name };
  }
  const oldId = division ? (subject.division_teachers || {})[division.id] || null : (subject.teacher_assigned || null);

  const lecSnap = await db.collection("lectures").where("subject_id", "==", subject.subject_id).get();
  const allLectures = lecSnap.docs.map((d) => ({ ...d.data(), lecture_id: d.id }));
  // only the slots this change can reach: one division's, or all of them
  const lectures = division ? allLectures.filter((l) => l.division_id === division.id) : allLectures;
  // slots with their own teacher (pinned) or a change running today keep their teacher
  const movable = lectures.filter((l) => l.teacher_pinned !== true && !l.override_id);

  // the subject as it will look after this change
  const after = (teacherId) => {
    if (division) {
      const map = subjT.withDivisionTeacher(subject, division.id, teacherId);
      return { ...subject, division_teachers: map, teacher_ids: subjT.idsFor(subject.teacher_assigned, map) };
    }
    return { ...subject, teacher_assigned: teacherId, teacher_ids: subjT.idsFor(teacherId, subject.division_teachers) };
  };
  const storeFields = (sub) => ({ teacher_assigned: sub.teacher_assigned || null, division_teachers: sub.division_teachers || {}, teacher_ids: sub.teacher_ids, updated_at: ts() });

  // ── Unassign ──
  if (!newId) {
    const sub = after(null);
    // a division with no teacher of its own falls back to the subject's default teacher
    const fallback = division ? subjT.effectiveTeacher(sub, division.id) : null;
    const fbName = fallback ? (await activeTeacherOrFail(req, fallback).catch(() => null)) : null;
    const released = fallback ? 0 : movable.filter((l) => l.teacher_id).length;
    await commitInBatches([
      (b) => b.update(ref, storeFields(sub)),
      ...lectureSyncOps(lectures, fallback ? sub : { ...sub, __unassigning: true }, fbName ? fbName.name : undefined),
    ]);
    await db.collection("allocation_history").add(clean({
      aishe_code: req.head.aishe_code, subject_id: subject.subject_id, division_id: division ? division.id : undefined,
      from_teacher_id: oldId, to_teacher_id: null, changed_by: req.head.teacher_id, created_at: ts(),
    }));
    await audit(req, "allocation.unassign", "subjects", subject.subject_id, { from_teacher_id: oldId, division: division ? division.name : undefined, released_lectures: released });
    return res.json({ success: true, teacher_assigned: sub.teacher_assigned || null, division_teachers: sub.division_teachers || {}, released_lectures: released });
  }

  // ── Assign / change ──
  const teacher = await activeTeacherOrFail(req, newId);
  if (newId === oldId) {
    // same teacher: still make sure the timetable slots agree with the subject
    await commitInBatches(lectureSyncOps(lectures, subject, { [newId]: teacher.name }));
    return res.json({ success: true, teacher_assigned: subject.teacher_assigned || null, division_teachers: subject.division_teachers || {}, teacher_name: teacher.name, unchanged: true });
  }

  // Would the new teacher be double-booked by these slots?
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

  const sub = after(newId);
  const ops = [];
  ops.push((b) => b.update(ref, storeFields(sub)));
  ops.push(...lectureSyncOps(lectures, sub, { [newId]: teacher.name }));
  await commitInBatches(ops);

  await db.collection("allocation_history").add(clean({
    aishe_code: req.head.aishe_code, subject_id: subject.subject_id, division_id: division ? division.id : undefined,
    from_teacher_id: oldId, to_teacher_id: newId, changed_by: req.head.teacher_id, created_at: ts(),
  }));
  await audit(req, "allocation.assign", "subjects", subject.subject_id, {
    from_teacher_id: oldId, to_teacher_id: newId, division: division ? division.name : undefined, moved_lectures: movable.length, forced: conflicts.length > 0,
  });

  return res.json({
    success: true,
    teacher_assigned: sub.teacher_assigned || null,
    division_teachers: sub.division_teachers || {},
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
    kind: l.kind || (subj.kind === "lab" ? "lab" : ""),
    batch: l.batch_no ? (l.batch || `B${l.batch_no}`) : "",
    batch_no: l.batch_no || null,
    batch_of: l.batch_of || null,
    batch_after: l.batch_no && l.batch_after != null ? l.batch_after : null,
    batch_upto: l.batch_no && l.batch_upto != null ? l.batch_upto : null,
    day: l.day,
    start_time: l.start_time,
    end_time: l.end_time,
    room: l.room || "",
    room_pending: l.room_pending ? l.room_pending.name || "" : "",
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
    try {
      const waiting = await db.collection("timetable_overrides").where("status", "==", "awaiting_approval").get();
      for (const d of waiting.docs) {
        if (d.data().date < today) { await d.ref.update({ status: "expired", note_system: "Nobody answered before the date", updated_at: ts() }); done++; }
      }
    } catch (err) { console.error("HEAD: expiring requests failed", err); }
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

// teacher doc ids -> the auth uids push messages go to
async function teacherUids(ids) {
  const docs = await getAllDocs([...new Set((ids || []).filter(Boolean))].map((id) => db.collection("teachers").doc(id)));
  return docs.filter((d) => d.exists).map((d) => d.data().user_id || d.id);
}

// Special sessions waiting for (or turned down by) the teachers whose lectures they take over.
async function sessionRequestsOf(course_id, sem) {
  const today = todayIST();
  const snap = await db.collection("timetable_overrides").where("course_id", "==", course_id).get();
  return snap.docs.map((d) => ({ ...d.data(), override_id: d.id }))
    .filter((o) => (o.status === "awaiting_approval" || o.status === "rejected") && o.semester === sem && o.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((o) => ({
      override_id: o.override_id, date: o.date, weekday: weekdayOf(o.date), status: o.status,
      title: (o.special && o.special.subject_name) || "Special session",
      start_time: o.special && o.special.start_time, end_time: o.special && o.special.end_time, room: o.special && o.special.room,
      approvals: Object.values(o.approvals || {}).map((a) => ({ name: a.name, status: a.status, reason: a.reason || "" })),
      reject_reason: o.reject_reason || "", rejected_by: o.rejected_by || "",
    }));
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
  subjects.forEach((s) => subjT.allTeacherIds(s).forEach((t) => tIds.add(t)));
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
        kind: s.kind || null,
        has_tutorial: s.has_tutorial === true,
        has_lab: s.has_lab === true,
        teacher_assigned: s.teacher_assigned || null,
        teacher_name: s.teacher_assigned ? (names[s.teacher_assigned] || "") : "",
        division_teachers: Object.fromEntries(Object.entries(s.division_teachers || {}).filter(([, t]) => t).map(([d, t]) => [d, { teacher_id: t, teacher_name: names[t] || "" }])),
      })),
    lectures: lectures.map((l) => ({ ...lectureView(l, names, subjectsById), pending_changes: changesFor[l.lecture_id] || 0 })),
    overrides: upcoming.map((o) => overrideView(o, lectureById, names)),
    session_requests: await sessionRequestsOf(course.course_id, n),
    divisions: (await divisionsOfCourse(course.course_id)).filter((d) => parseSem(d.semester) === n)
      .map((d) => ({ division_id: d.division_id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  });
}));

// "lecture" (default) | "tutorial" | "lab" for a slot of this subject. A lab subject's slots are always labs.
function slotKind(subject, raw) {
  const want = String(raw || "").trim();
  if (want && !["lecture", "tutorial", "lab"].includes(want)) fail(400, "kind must be lecture, tutorial or lab");
  if (subject.kind === "lab") {
    if (want === "tutorial") fail(400, "A lab subject has no tutorial");
    return "lab";
  }
  if (want === "tutorial" && subject.has_tutorial !== true) fail(400, `${subject.subject_name} has no tutorial yet. Add one from Subjects & Faculty first.`);
  if (want === "lab" && subject.has_lab !== true) fail(400, `${subject.subject_name} has no lab yet. Add one from Subjects & Faculty first.`);
  return want === "tutorial" || want === "lab" ? want : "";
}

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
  let subject = null, teacher = null, sem, title = "", kind = "";
  const guest = String(body.guest || "").trim();
  if (body.subject_id) {
    subject = (await loadHeadSubject(req, body.subject_id)).subject;
    if (subject.course_id !== course.course_id) fail(400, "Subject does not belong to this course");
    kind = slotKind(subject, body.kind);
    const ownTeacher = subjT.effectiveTeacher(subject, body.division_id);
    if (kind === "tutorial" && body.teacher_id && !subjT.teachesSubject(subject, body.teacher_id)) fail(400, "A tutorial is taught by the subject's own teacher");
    const teacherId = body.teacher_id || ownTeacher;
    if (!teacherId) fail(400, "Allocate a teacher to this subject before scheduling it");
    teacher = await activeTeacherOrFail(req, teacherId);
    sem = parseSem(subject.semester);
    if (sem === null) fail(400, "This subject has no valid semester — edit the subject first");
  } else {
    if (body.kind && body.kind !== "lecture") fail(400, "Only a subject's own slots can be a tutorial or a lab");
    title = String(body.title || "").trim();
    if (!title) fail(400, "Pick a subject or give the session a title");
    if (title.length > 80 || guest.length > 80) fail(400, "Title and guest name can be at most 80 characters");
    sem = parseSem(body.semester);
    if (sem === null) fail(400, "semester is required for a session without a subject");
    if (body.teacher_id) teacher = await activeTeacherOrFail(req, body.teacher_id);
  }

  const slot = readSlotFields(body);
  const rr = await resolveRoom(req, slot.room, roomTypeFor(kind));
  slot.room = rr.name;
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
  blockOnRoomClash(rr, conflicts);
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
    kind: kind || undefined,
    teacher_id: teacher ? teacher.id : undefined,
    teacher_name: teacher ? teacher.name : guest,
    teacher_pinned: subject && teacher.id !== subjT.effectiveTeacher(subject, body.division_id) ? true : undefined,
    division_id: division ? division.division_id : undefined,
    division_name: division ? division.name : undefined,
    day: slot.day,
    start_time: slot.start_time,
    end_time: slot.end_time,
    room: rr.foreign ? "" : slot.room,
    department: req.head.department,
    created_by: req.head.teacher_id,
    created_at: ts(),
  }))];
  replaced.forEach((l) => ops.push((b) => b.delete(db.collection("lectures").doc(l.lecture_id))));
  await commitInBatches(ops);
  for (const l of replaced) await cancelRoomRequests(l.lecture_id, "The timetable slot was replaced");
  // a room of another course is requested from its owner; the slot is saved without a room until they answer
  if (rr.foreign) await createRoomRequest(req, rr, course, { lecture_id: ref.id, subject_name: subject ? subject.subject_name : title }, slot);

  await audit(req, "timetable.create", "lectures", ref.id, { subject: subject ? subject.subject_code : title, replaced: replaced.length, ...slot });
  return res.status(201).json({ success: true, lecture_id: ref.id, replaced: replaced.length, room_requested: rr.foreign ? rr.name : undefined });
}));

// One slot for a whole elective group: every subject of the group gets its own lecture at the same time,
// each with its own room (and, optionally, its own teacher). Students only ever see the one they chose.
//   { course_id, semester, group, day, start_time, end_time, division_id?, kind?, options: [{ subject_id, room?, teacher_id?, kind? }], force? }
// kind: "" / "lecture" (default), "tutorial" or "lab" for the whole slot; an option may carry its own kind. A tutorial or lab of an elective
// is its own slot (shown separately in the timetable); attendance in it is still marked as lecture attendance.
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
  // "" (lecture) | "tutorial" | "lab" per option; the slot-wide kind is the default
  const kindOfOption = (o) => slotKind(byId[o.subject_id], o.kind !== undefined && o.kind !== null && o.kind !== "" ? o.kind : body.kind);
  const kinds = options.map(kindOfOption);

  const slot = readSlotFields(body);
  const division = await divisionOrFail(req, course, sem, body.division_id);

  // resolve each option's teacher + room
  const rows = [];
  for (const [oi, o] of options.entries()) {
    const subject = byId[o.subject_id];
    const kind = kinds[oi];
    if (kind === "tutorial" && o.teacher_id && !subjT.teachesSubject(subject, o.teacher_id)) fail(400, `${subject.subject_name}: a tutorial is taught by the subject's own teacher`);
    const teacherId = o.teacher_id || subjT.effectiveTeacher(subject, division && division.division_id);
    if (!teacherId) fail(400, `${subject.subject_name}: allocate a teacher to this subject before scheduling it`);
    const teacher = await activeTeacherOrFail(req, teacherId);
    const rr = await resolveRoom(req, o.room, roomTypeFor(kind));
    if (rr.foreign) fail(400, `${rr.name} belongs to ${rr.owner.course_abbr || "another course"}. Pick one of your own rooms for an elective slot, or set that subject's room later.`);
    rows.push({ subject, teacher, room: rr.name, rr, kind });
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
    blockOnRoomClash(r.rr, found.map((c) => ({ ...c, message: `${r.subject.subject_name}: ${c.message}` })));
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
      kind: r.kind || undefined,
      teacher_id: r.teacher.id,
      teacher_name: r.teacher.name,
      teacher_pinned: r.teacher.id !== subjT.effectiveTeacher(r.subject, division && division.division_id) ? true : undefined,
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

  await audit(req, "timetable.create_group", "lectures", slot_id, { group, kind: rows.some((r) => r.kind) ? [...new Set(rows.map((r) => r.kind || "lecture"))].join("+") : "lecture", subjects: rows.map((r) => r.subject.subject_code), ...slot });
  return res.status(201).json({ success: true, slot_id, lecture_ids: ids, created: ids.length });
}));

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-GENERATE A SEMESTER'S TIMETABLE (one semester at a time, once per semester)
//   POST   /timetable/generate/preview   { course_id, semester, grid, subjects:[{subject_id, lecture, tutorial, lab_sessions, lab_periods, teacher_id?}],
//                                          groups:[{group, periods}], seed?, replace_existing? }   -> a proposal, nothing is saved yet
//   POST   /timetable/generate/apply     { proposal_id }                                           -> writes the lectures
//   GET    /timetable/generations?course_id=&semester=                                             -> runs that can still be undone
//   DELETE /timetable/generations/:id                                                              -> removes that run (and restores what it replaced)
// Uses only the course's own saved rooms; teachers and rooms already used by other semesters or courses are respected.
// ─────────────────────────────────────────────────────────────────────────────
const gen = require("../../utils/timetableGen");
// the semester of a lecture: its own field, or its subject's (older documents have no semester)
async function semesterLectures(course_id, sem) {
  const subs = Object.fromEntries((await subjectsOfCourse(course_id)).map((x) => [x.subject_id, x]));
  const snap = await db.collection("lectures").where("course_id", "==", course_id).get();
  return snap.docs.map((d) => ({ ...d.data(), lecture_id: d.id })).filter((l) => {
    const n = parseSem(l.semester);
    return (n !== null ? n : parseSem((subs[l.subject_id] || {}).semester)) === sem;
  });
}
const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;

function readGrid(raw) {
  const g = raw || {};
  const days = (Array.isArray(g.days) ? g.days : []).filter((d) => DAY_ORDER.includes(d));
  if (!days.length) fail(400, "Pick at least one working day");
  const start = normTime(g.start), end = normTime(g.end);
  if (!start || !end || toMin(start) >= toMin(end)) fail(400, "The day must start before it ends (HH:MM)");
  const slot = Number(g.slot_minutes);
  if (!Number.isInteger(slot) || slot < 30 || slot > 180) fail(400, "A period is between 30 and 180 minutes");
  const breaks = (Array.isArray(g.breaks) ? g.breaks : []).map((b) => ({ start: normTime(b && b.start), end: normTime(b && b.end) }));
  breaks.forEach((b) => { if (!b.start || !b.end || toMin(b.start) >= toMin(b.end)) fail(400, "Each break needs a start and a later end"); });
  const maxPer = g.max_per_day === undefined || g.max_per_day === "" ? null : Number(g.max_per_day);
  if (maxPer !== null && (!Number.isInteger(maxPer) || maxPer < 1 || maxPer > 12)) fail(400, "Maximum periods a day must be between 1 and 12");
  return { days: DAY_ORDER.filter((d) => days.includes(d)), start, end, slot_minutes: slot, breaks, max_per_day: maxPer };
}
const nInt = (v, lo, hi, label) => {
  const n = v === undefined || v === null || v === "" ? 0 : Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) fail(400, `${label} must be a whole number from ${lo} to ${hi}`);
  return n;
};

// lectures of the whole college except `skipIds`, as busy intervals per teacher / room
async function externalBusy(req, skipIds) {
  const snap = await db.collection("lectures").where("aishe_code", "==", req.head.aishe_code).get();
  const out = { teacher: {}, room: {} };
  snap.docs.forEach((d) => {
    if (skipIds.has(d.id)) return;
    const l = d.data();
    if (!DAY_ORDER.includes(l.day) || !l.start_time || !l.end_time) return;
    const iv = { day: l.day, s: toMin(l.start_time), e: toMin(l.end_time) };
    if (l.teacher_id) (out.teacher[l.teacher_id] = out.teacher[l.teacher_id] || []).push(iv);
    if (l.room) (out.room[up(l.room)] = out.room[up(l.room)] || []).push(iv);
  });
  return out;
}

async function lecturesWithHistory(ids) {
  const used = new Set();
  for (const part of chunks(ids, CHUNK)) {
    const snap = await db.collection("lecture_sessions").where("lecture_id", "in", part).get();
    snap.docs.forEach((d) => used.add(d.data().lecture_id));
  }
  return used;
}

router.post("/timetable/generate/preview", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);
  const sem = parseSem(body.semester);
  if (sem === null) fail(400, "semester is required");
  const grid = readGrid(body.grid);

  // the semester's current timetable
  const existing = await semesterLectures(course.course_id, sem);
  if (existing.length) {
    const hist = await lecturesWithHistory(existing.map((l) => l.lecture_id));
    if (hist.size) fail(409, `Semester ${sem} already has attendance recorded, so its timetable can't be regenerated. Edit it by hand instead.`);
    if (body.replace_existing !== true) fail(409, `Semester ${sem} already has ${existing.length} timetable slot${existing.length === 1 ? "" : "s"}. Confirm to replace them.`, { existing: existing.length });
  }

  const allSubjects = (await subjectsOfCourse(course.course_id)).filter((s) => parseSem(s.semester) === sem);
  const byId = Object.fromEntries(allSubjects.map((s) => [s.subject_id, s]));
  const rows = Array.isArray(body.subjects) ? body.subjects : [];
  const seenSub = new Set();
  const teacherIds = new Set();
  const compulsory = [];
  const warnings = [];

  // students and divisions of this semester
  const students = (await studentsOfCourse(req.head.aishe_code, course)).filter((st) => isActiveStudent(st) && parseSem(st.semester) === sem);
  const divs = (await divisionsOfCourse(course.course_id)).filter((d) => parseSem(d.semester) === sem)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  const divisions = divs.length
    ? divs.map((d) => ({ id: d.division_id, name: d.name, size: students.filter((st) => st.division_id === d.division_id).length }))
    : [{ id: null, name: "", size: students.length }];
  const divRooms = body.division_rooms && typeof body.division_rooms === "object" ? body.division_rooms : {};
  const WHEN = ["any", "morning", "afternoon"];
  const whenOf = (v, label) => { const w = v === undefined || v === null || v === "" ? "any" : String(v); if (!WHEN.includes(w)) fail(400, `${label}: pick any time, morning or afternoon`); return w === "any" ? undefined : w; };
  for (const r of rows) {
    const s = r && byId[r.subject_id];
    if (!s) fail(400, "A subject in the list is not in this semester");
    if (s.compulsary === false) fail(400, `${s.subject_name} is an elective: set its hours under the elective group`);
    if (seenSub.has(s.subject_id)) fail(400, "A subject is listed twice");
    seenSub.add(s.subject_id);
    const isLabOnly = s.kind === "lab";
    const lecture = nInt(r.lecture, 0, 12, `${s.subject_name}: lectures a week`);
    const lecturePeriods = lecture ? nInt(r.lecture_periods || 1, 1, 4, `${s.subject_name}: periods in one lecture`) : 1;
    const when = whenOf(r.when, s.subject_name);
    const tutorial = nInt(r.tutorial, 0, 6, `${s.subject_name}: tutorial periods a week`);
    const labSessions = nInt(r.lab_sessions, 0, 4, `${s.subject_name}: lab sessions a week`);
    const labPeriods = labSessions ? nInt(r.lab_periods || 1, 1, 3, `${s.subject_name}: lab length`) : 0;
    if (isLabOnly && (lecture || tutorial)) fail(400, `${s.subject_name} is a lab subject: it has lab sessions only`);
    if (tutorial && s.has_tutorial !== true) fail(400, `${s.subject_name} has no tutorial yet. Add one from Subjects & Faculty first.`);
    if (labSessions && !(isLabOnly || s.has_lab === true)) fail(400, `${s.subject_name} has no lab yet. Add one from Subjects & Faculty first.`);
    if (!lecture && !tutorial && !labSessions) continue;
    // a teacher for every division: the subject's own for that division, or its default
    const teachers = {};
    const noTeacher = [];
    divisions.forEach((dv) => {
      const t = r.teacher_id || subjT.effectiveTeacher(s, dv.id);
      if (t) { teachers[String(dv.id)] = t; teacherIds.add(t); } else noTeacher.push(dv.name || "this semester");
    });
    if (noTeacher.length) { warnings.push(`${s.subject_name} has no teacher for ${noTeacher.length === divisions.length ? "any division" : "division " + noTeacher.join(", ")}, so it was left out. Pick teachers in Subjects & Faculty and create the preview again.`); continue; }
    const teacher_id = r.teacher_id || s.teacher_assigned || teachers[String(divisions[0].id)];
    compulsory.push({ s, lecture, lecturePeriods, tutorial, labSessions, labPeriods, when, teacher_id, teachers, pinned: !!r.teacher_id && r.teacher_id !== s.teacher_assigned });
  }
  if (!compulsory.length && !(Array.isArray(body.groups) && body.groups.length) && !(Array.isArray(body.common) && body.common.length)) fail(400, "Give at least one subject some hours");

  // elective groups
  const groups = [];
  for (const g of (Array.isArray(body.groups) ? body.groups : [])) {
    const name = cleanGroup(g && g.group);
    const periods = nInt(g && g.periods, 0, 12, `Elective group ${name}: periods a week`);
    const tutorial = nInt(g && g.tutorial, 0, 6, `Elective group ${name}: tutorial periods a week`);
    const labSessions = nInt(g && g.lab_sessions, 0, 4, `Elective group ${name}: lab sessions a week`);
    const labPeriods = labSessions ? nInt((g && g.lab_periods) || 1, 1, 4, `Elective group ${name}: lab length`) : 0;
    const lecturePeriods = periods ? nInt((g && g.lecture_periods) || 1, 1, 4, `Elective group ${name}: periods in one lecture`) : 1;
    const gwhen = whenOf(g && g.when, `Elective group ${name}`);
    if (!periods && !tutorial && !labSessions) continue;
    const opts = allSubjects.filter((x) => x.compulsary === false && groupKey(x) === name);
    if (!opts.length) fail(400, `Elective group ${name} has no subjects in this semester`);
    const options = [];
    for (const o of opts) {
      if (!o.teacher_assigned) { warnings.push(`${o.subject_name} (elective ${name}) has no teacher yet, so it was left out of the group.`); continue; }
      teacherIds.add(o.teacher_assigned);
      options.push({ id: o.subject_id, name: o.subject_name, code: o.subject_code || "", teacher_id: o.teacher_assigned, has_tutorial: o.has_tutorial === true, has_lab: o.has_lab === true,
        students: students.filter((st) => (st.enrolled_subjects || []).includes(o.subject_id)).length });
    }
    if (tutorial && !options.some((o) => o.has_tutorial)) fail(400, `None of the subjects in elective group ${name} has a tutorial. Add one from Subjects & Faculty, or set its tutorial periods to 0.`);
    if (labSessions && !options.some((o) => o.has_lab)) fail(400, `None of the subjects in elective group ${name} has a lab. Add one from Subjects & Faculty, or set its lab sessions to 0.`);
    if (options.length) groups.push({ group: name, periods, lecture_periods: lecturePeriods, tutorial, lab: labSessions ? { sessions: labSessions, periods: labPeriods } : undefined, when: gwhen, options });
  }

  // teachers
  const tDocs = await getAllDocs([...teacherIds].map((id) => db.collection("teachers").doc(id)));
  const tName = {};
  tDocs.forEach((d) => { if (d.exists && d.data().is_active !== false) tName[d.id] = personName(d.data()); });
  const missingTeacher = [...teacherIds].filter((id) => !tName[id]);
  if (missingTeacher.length) fail(400, "A chosen teacher was not found or is inactive");

  // sessions every division attends together with no teacher or room (a research project, a seminar hour...)
  const common = [];
  (Array.isArray(body.common) ? body.common : []).forEach((c, ci) => {
    const title = String((c && c.title) || "").trim();
    if (!title) return;
    if (title.length > 80) fail(400, "A common session title can be at most 80 characters");
    const sessions = nInt(c.sessions, 0, 7, `${title}: sessions a week`);
    if (!sessions) return;
    const periods = nInt(c.periods || 1, 1, 6, `${title}: periods in one session`);
    const cdays = Array.isArray(c.days) ? c.days.filter((d) => grid.days.includes(d)) : [];
    if (sessions > (cdays.length || grid.days.length)) fail(400, `${title}: ${sessions} sessions need ${sessions} different days, but only ${cdays.length || grid.days.length} are open to it`);
    common.push({ id: "c" + ci, title, sessions, periods, days: cdays.length ? cdays : undefined, when: whenOf(c.when, title), teacher_name: String(c.teacher_name || "").trim().slice(0, 60) });
  });

  // rooms: this course's own saved rooms only
  const allRooms = await loadRooms(req);
  const own = allRooms.filter((r) => r.course_id === course.course_id);
  const rooms = {
    saved: allRooms.length > 0,
    classrooms: own.filter((r) => r.type !== "lab").map((r) => ({ name: r.name, capacity: Number(r.capacity) || 0 })),
    labs: own.filter((r) => r.type === "lab").map((r) => ({ name: r.name, capacity: Number(r.capacity) || 0 })),
  };
  if (rooms.saved && !rooms.classrooms.length) warnings.push("This course has no classrooms saved. Add them with the Rooms button, or lectures can't get a room.");
  if (rooms.saved && compulsory.some((c) => c.labSessions) && !rooms.labs.length) warnings.push("This course has no lab rooms saved, so labs can't be placed.");

  // each division's own classroom
  if (rooms.saved) {
    divisions.forEach((dv) => {
      const want = String(divRooms[String(dv.id)] || "").trim();
      if (!want) return;
      const hit = rooms.classrooms.find((r) => up(r.name) === up(want));
      if (!hit) fail(400, `${dv.name ? "Division " + dv.name : "The class"}: "${want}" is not one of this course's saved classrooms`);
      dv.room = hit.name;
    });
  }

  const external = await externalBusy(req, new Set(existing.map((l) => l.lecture_id)));
  const seed = Number.isInteger(Number(body.seed)) ? Number(body.seed) : Math.floor(Math.random() * 1e6);
  const out = gen.solve({
    grid: { ...grid, max_per_day: grid.max_per_day || undefined },
    divisions,
    subjects: compulsory.map((c) => ({
      id: c.s.subject_id, name: c.s.subject_name, code: c.s.subject_code || "", teacher_id: c.teacher_id, teacher_name: tName[c.teacher_id] || "",
      teachers: Object.fromEntries(Object.entries(c.teachers).map(([d, t]) => [d, { id: t, name: tName[t] || "" }])),
      lecture: c.lecture, lecture_periods: c.lecturePeriods, tutorial: c.tutorial, when: c.when,
      lab: c.labSessions ? { sessions: c.labSessions, periods: c.labPeriods } : undefined,
    })),
    common,
    groups: groups.map((g) => ({ ...g, options: g.options.map((o) => ({ ...o, teacher_name: tName[o.teacher_id] || "" })) })),
    rooms, external, seed,
  });

  const proposalRef = db.collection("timetable_proposals").doc();
  await proposalRef.set(clean({
    proposal_id: proposalRef.id, aishe_code: req.head.aishe_code, course_id: course.course_id, semester: sem, created_by: req.head.teacher_id,
    created_at: ts(), expires_ms: Date.now() + PROPOSAL_TTL_MS, applied: false, seed,
    items: JSON.parse(JSON.stringify(out.items)), replace_ids: existing.map((l) => l.lecture_id), pinned: compulsory.filter((c) => c.pinned).map((c) => c.s.subject_id),
    divisions: divisions.map((d) => ({ id: d.id, name: d.name })), stats: JSON.parse(JSON.stringify(out.stats)),
  }));

  const subName = Object.fromEntries(allSubjects.map((s) => [s.subject_id, { name: s.subject_name, code: s.subject_code || "" }]));
  const divName = Object.fromEntries(divisions.map((d) => [String(d.id), d.name]));
  return res.json({
    success: true, proposal_id: proposalRef.id, seed, complete: out.stats.complete, stats: out.stats,
    warnings: [...warnings, ...out.warnings], unplaced: out.unplaced, replaces: existing.length,
    divisions: divisions.map((d) => ({ division_id: d.id, name: d.name, size: d.size, room: d.room || "" })),
    items: out.items.map((it) => ({
      ...it, subject_name: it.type === "common" ? it.title : (subName[it.subject_id] || {}).name || "", subject_code: (subName[it.subject_id] || {}).code || "",
      teacher_name: tName[it.teacher_id] || "", division_name: it.division_id ? divName[String(it.division_id)] || "" : "",
      batch: it.batch_no ? `B${it.batch_no}` : "",
    })),
  });
}));

router.post("/timetable/generate/apply", wrap(async (req, res) => {
  const snap = await db.collection("timetable_proposals").doc(String((req.body || {}).proposal_id || "_")).get();
  if (!snap.exists) fail(404, "This preview was not found. Generate again.");
  const p = snap.data();
  const course = courseOrFail(req, p.course_id);
  if (p.aishe_code !== req.head.aishe_code) fail(403, "Not your preview");
  if (p.applied) fail(409, "This preview was already saved");
  if (Date.now() > p.expires_ms) fail(409, "This preview has expired. Generate again.");
  const sem = parseSem(p.semester);

  // is the world still the one the preview was made in?
  const existing = await semesterLectures(course.course_id, sem);
  const sameSet = existing.length === p.replace_ids.length && existing.every((l) => p.replace_ids.includes(l.lecture_id));
  if (!sameSet) fail(409, "The semester's timetable changed since the preview. Generate again.");
  if (existing.length && (await lecturesWithHistory(existing.map((l) => l.lecture_id))).size) fail(409, "Attendance has been recorded for this semester, so the timetable can't be replaced.");
  const external = await externalBusy(req, new Set(p.replace_ids));
  const hit = (list, it) => (list || []).some((b) => b.day === it.day && overlaps(toMin(it.start_time), toMin(it.end_time), b.s, b.e));
  const stale = p.items.find((it) => (it.teacher_id && hit(external.teacher[it.teacher_id], it)) || (it.room && hit(external.room[up(it.room)], it)));
  if (stale) fail(409, "A teacher or room was booked elsewhere since the preview. Generate again.");

  const subs = await subjectsOfCourse(course.course_id);
  const subById = Object.fromEntries(subs.map((s) => [s.subject_id, s]));
  const tIds = [...new Set(p.items.map((i) => i.teacher_id).filter(Boolean))];
  const tName = {};
  (await getAllDocs(tIds.map((id) => db.collection("teachers").doc(id)))).forEach((d) => { if (d.exists) tName[d.id] = personName(d.data()); });
  const divName = Object.fromEntries(p.divisions.map((d) => [String(d.id), d.name]));

  // roll-number ranges for the lab batches of each division
  const plans = {};
  const students = (await studentsOfCourse(req.head.aishe_code, course)).filter((st) => isActiveStudent(st) && parseSem(st.semester) === sem);
  for (const dv of p.divisions) {
    const n = Math.max(0, ...p.items.filter((i) => i.type === "lab" && String(i.division_id) === String(dv.id)).map((i) => i.batch_of || 1));
    if (n > 1) {
      const pool = students.filter((st) => !dv.id || st.division_id === dv.id);
      const plan = labBatches.planBatches(pool.map(labBatches.rollOf), n, null);
      if (!plan.ok) fail(400, `${dv.name ? "Division " + dv.name : "This semester"}: ${plan.error}`);
      plans[String(dv.id)] = plan.batches;
    }
  }

  const gen_id = db.collection("timetable_generations").doc().id;
  const slotIds = {};
  const slotOf = (k) => (slotIds[k] = slotIds[k] || db.collection("lectures").doc().id);
  const ids = [];
  const ops = [];
  existing.forEach((l) => ops.push((b) => b.delete(db.collection("lectures").doc(l.lecture_id))));
  p.items.forEach((it) => {
    if (it.type === "common") {
      // a session for everyone with no subject, teacher or room
      const cref = db.collection("lectures").doc();
      ids.push(cref.id);
      ops.push((b) => b.set(cref, clean({
        lecture_id: cref.id, aishe_code: req.head.aishe_code, course_id: course.course_id, semester: semLabel(sem),
        subject_name: it.title, subject_code: "", custom: true, teacher_name: it.teacher_name || "",
        division_id: it.division_id || undefined, division_name: it.division_id ? divName[String(it.division_id)] || undefined : undefined,
        day: it.day, start_time: it.start_time, end_time: it.end_time, room: "",
        department: req.head.department, created_by: req.head.teacher_id, created_at: ts(), generated: true, gen_id,
      })));
      return;
    }
    const s = subById[it.subject_id];
    if (!s) return;
    const ref = db.collection("lectures").doc();
    ids.push(ref.id);
    const dvKey = String(it.division_id);
    const pb = it.batch_no && plans[dvKey] ? plans[dvKey][it.batch_no - 1] : null;
    ops.push((b) => b.set(ref, clean({
      lecture_id: ref.id, aishe_code: req.head.aishe_code, course_id: course.course_id,
      semester: s.semester || semLabel(sem), subject_id: s.subject_id, subject_name: s.subject_name || "", subject_code: s.subject_code || "",
      kind: it.type === "lab" || it.kind === "lab" ? "lab" : it.type === "tutorial" || it.kind === "tutorial" ? "tutorial" : undefined,
      teacher_id: it.teacher_id, teacher_name: tName[it.teacher_id] || "",
      teacher_pinned: it.teacher_id && it.teacher_id !== subjT.effectiveTeacher(s, it.division_id) ? true : undefined,
      division_id: it.division_id || undefined, division_name: it.division_id ? divName[dvKey] || undefined : undefined,
      elective_group: it.type === "elective" ? it.group : undefined,
      slot_id: it.type === "elective" || pb ? slotOf(it.slot_key) : undefined,
      batch: pb ? pb.name : undefined, batch_no: pb ? pb.batch_no : undefined, batch_of: pb ? it.batch_of : undefined,
      batch_after: pb ? pb.after : undefined, batch_upto: pb ? pb.upto : undefined,
      day: it.day, start_time: it.start_time, end_time: it.end_time, room: it.room || "",
      department: req.head.department, created_by: req.head.teacher_id, created_at: ts(),
      generated: true, gen_id,
    })));
  });
  ops.push((b) => b.set(db.collection("timetable_generations").doc(gen_id), clean({
    gen_id, aishe_code: req.head.aishe_code, course_id: course.course_id, semester: sem, created_by: req.head.teacher_id,
    created_by_name: personName(req.head.teacher), created_at: ts(), lecture_ids: ids, replaced: existing,
    replaced_count: existing.length, undone: false,
  })));
  ops.push((b) => b.update(snap.ref, { applied: true, gen_id }));
  await commitInBatches(ops);
  for (const l of existing) await cancelRoomRequests(l.lecture_id, "The timetable was regenerated");
  await audit(req, "timetable.generate", "timetable_generations", gen_id, { semester: sem, lectures: ids.length, replaced: existing.length });
  return res.status(201).json({ success: true, gen_id, created: ids.length, replaced: existing.length });
}));

router.get("/timetable/generations", wrap(async (req, res) => {
  const course = courseOrFail(req, req.query.course_id);
  const sem = parseSem(req.query.semester);
  const snap = await db.collection("timetable_generations").where("course_id", "==", course.course_id).get();
  const rows = snap.docs.map((d) => d.data()).filter((g) => !g.undone && (sem === null || g.semester === sem))
    .sort((a, b) => String(toISO(b.created_at) || "").localeCompare(String(toISO(a.created_at) || ""))).slice(0, 5);
  return res.json({ success: true, generations: rows.map((g) => ({ gen_id: g.gen_id, semester: g.semester, created_by: g.created_by_name || "", created_at: toISO(g.created_at), lectures: (g.lecture_ids || []).length, replaced: g.replaced_count || 0 })) });
}));

router.delete("/timetable/generations/:id", wrap(async (req, res) => {
  const ref = db.collection("timetable_generations").doc(String(req.params.id));
  const snap = await ref.get();
  if (!snap.exists) fail(404, "That run was not found");
  const g = snap.data();
  courseOrFail(req, g.course_id);
  if (g.undone) fail(409, "That run was already undone");
  const alive = [];
  for (const part of chunks(g.lecture_ids || [], CHUNK)) (await getAllDocs(part.map((id) => db.collection("lectures").doc(id)))).forEach((d) => { if (d.exists) alive.push(d.id); });
  if (alive.length && (await lecturesWithHistory(alive)).size) fail(409, "Attendance has already been recorded on this timetable, so it can't be undone.");
  const ops = alive.map((id) => (b) => b.delete(db.collection("lectures").doc(id)));
  (g.replaced || []).forEach((l) => ops.push((b) => b.set(db.collection("lectures").doc(l.lecture_id), l)));
  ops.push((b) => b.update(ref, { undone: true, undone_at: ts() }));
  await commitInBatches(ops);
  await audit(req, "timetable.generate.undo", "timetable_generations", g.gen_id, { removed: alive.length, restored: (g.replaced || []).length });
  return res.json({ success: true, removed: alive.length, restored: (g.replaced || []).length });
}));

// ── Lab batches ──────────────────────────────────────────────────────────────
// One lab slot of a division, split into 2 or 3 batches by roll number. Every batch is a normal lecture
// (own subject / lab, room and teacher) carrying its roll range; they share a slot_id and run at the same time.

// the other batches of the same lab slot (with their document refs)
async function batchSiblings(lecture) {
  if (!lecture.slot_id) return [];
  const snap = await db.collection("lectures").where("slot_id", "==", lecture.slot_id).get();
  return snap.docs.filter((d) => d.id !== lecture.lecture_id && d.data().batch_no)
    .map((d) => ({ ...d.data(), lecture_id: d.id, ref: d.ref }))
    .sort((a, b) => a.batch_no - b.batch_no);
}

// the students a batch split is made from: active students of this semester (and division)
async function batchPool(req, course, sem, division) {
  return (await studentsOfCourse(req.head.aishe_code, course))
    .filter((st) => isActiveStudent(st) && parseSem(st.semester) === sem && (!division || st.division_id === division.division_id));
}

// GET /timetable/batch-plan?course_id=&semester=&division_id=&count=2|3&cuts=2310,2330
//   preview of how the roll numbers split, and the list of roll numbers to pick split points from
router.get("/timetable/batch-plan", wrap(async (req, res) => {
  const course = courseOrFail(req, req.query.course_id);
  const sem = parseSem(req.query.semester);
  if (sem === null) fail(400, "semester is required");
  const division = await divisionOrFail(req, course, sem, req.query.division_id || null);
  const pool = await batchPool(req, course, sem, division);
  const count = Number(req.query.count) || 2;
  const cuts = String(req.query.cuts || "").split(",").map((x) => x.trim()).filter(Boolean);
  const plan = labBatches.planBatches(pool.map(labBatches.rollOf), count, cuts.length ? cuts : null);
  const rolls = pool.map((st) => ({ roll_no: labBatches.rollOf(st), name: st.name || [st.first_name, st.last_name].filter(Boolean).join(" ") }))
    .filter((r) => r.roll_no).sort((a, b) => labBatches.naturalCompare(a.roll_no, b.roll_no));
  // first / last roll number of every batch, for the preview ("101 - 130")
  const batches = plan.ok ? plan.batches.map((b) => {
    const members = rolls.filter((r) => labBatches.inBatch({ batch_no: b.batch_no, batch_after: b.after, batch_upto: b.upto }, r.roll_no));
    return { ...b, first: members.length ? members[0].roll_no : null, last: members.length ? members[members.length - 1].roll_no : null };
  }) : [];
  return res.json({
    success: true, students: pool.length, without_roll: pool.length - rolls.length,
    batches, problem: plan.ok ? null : plan.error, rolls,
  });
}));

// POST /timetable/batches
//   { course_id, semester, division_id?, day, start_time, end_time, cuts?: [roll, ...],
//     batches: [{ subject_id, room?, teacher_id? }, ...]  (2 or 3: B1, B2, B3), force? }
router.post("/timetable/batches", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);
  const sem = parseSem(body.semester);
  if (sem === null) fail(400, "semester is required");
  const options = Array.isArray(body.batches) ? body.batches : [];
  if (options.length < 2 || options.length > 3) fail(400, "A lab can be split into 2 or 3 batches");

  const slot = readSlotFields({ day: body.day, start_time: body.start_time, end_time: body.end_time });
  const division = await divisionOrFail(req, course, sem, body.division_id);

  const rows = [];
  for (let i = 0; i < options.length; i++) {
    const o = options[i] || {};
    const label = `B${i + 1}`;
    if (!o.subject_id) fail(400, `${label}: pick the lab this batch does`);
    const subject = (await loadHeadSubject(req, o.subject_id)).subject;
    if (subject.course_id !== course.course_id) fail(400, `${label}: that subject does not belong to this course`);
    if (parseSem(subject.semester) !== sem) fail(400, `${label}: ${subject.subject_name} is not in semester ${sem}`);
    if (subject.compulsary === false) fail(400, `${label}: batches are not available for elective subjects`);
    slotKind(subject, "lab");                                   // a lab subject, or a subject that has a lab
    const teacherId = o.teacher_id || subjT.effectiveTeacher(subject, division && division.division_id);
    if (!teacherId) fail(400, `${label}: allocate a teacher to ${subject.subject_name} before scheduling it`);
    const teacher = await activeTeacherOrFail(req, teacherId);
    const rr = await resolveRoom(req, o.room, "lab");
    rows.push({ label, no: i + 1, subject, teacher, rr });
  }

  // the batches run at the same time: no shared teacher, no shared room
  const tSeen = new Map(), rSeen = new Map();
  rows.forEach((r) => {
    if (tSeen.has(r.teacher.id)) fail(400, `${r.teacher.name} can't take ${tSeen.get(r.teacher.id)} and ${r.label} at the same time`);
    tSeen.set(r.teacher.id, r.label);
    if (r.rr.name) {
      const k = up(r.rr.name);
      if (rSeen.has(k)) fail(400, `Room ${r.rr.name} is given to both ${rSeen.get(k)} and ${r.label}. Each batch needs its own room.`);
      rSeen.set(k, r.label);
    }
  });

  // who is in which batch
  const pool = await batchPool(req, course, sem, division);
  const cuts = Array.isArray(body.cuts) ? body.cuts : null;
  const plan = labBatches.planBatches(pool.map(labBatches.rollOf), rows.length, cuts && cuts.length ? cuts : null);
  if (!plan.ok) fail(400, plan.error);
  // batches exist only because the division does not fit in one lab: if a chosen lab holds everybody, no split is needed
  const caps = rows.map((r) => (r.rr.owner && r.rr.owner.capacity) || 0).filter(Boolean);
  if (caps.length && pool.length <= Math.max(...caps)) {
    fail(400, `All ${pool.length} students fit in one lab (capacity ${Math.max(...caps)}), so batches are not needed. Add a normal lab session instead.`);
  }

  // clashes with what is already in the timetable (the new batches never clash with each other)
  const conflicts = [];
  for (const r of rows) {
    const found = await findConflicts(req, {
      ...slot, room: r.rr.name, course_id: course.course_id, semester: sem, teacher_id: r.teacher.id,
      division_id: division ? division.division_id : undefined,
    });
    const tagged = found.map((c) => ({ ...c, message: `${r.label}: ${c.message}` }));
    blockOnRoomClash(r.rr, tagged);
    conflicts.push(...tagged);
  }
  if (conflicts.length && body.force !== true) fail(409, "This slot clashes with an existing lecture", { conflicts });

  const slot_id = db.collection("lectures").doc().id;
  const ids = [];
  const ops = rows.map((r, i) => {
    const ref = db.collection("lectures").doc();
    ids.push(ref.id);
    r.lecture_id = ref.id;
    const pb = plan.batches[i];
    return (b) => b.set(ref, clean({
      lecture_id: ref.id,
      aishe_code: req.head.aishe_code,
      course_id: course.course_id,
      semester: r.subject.semester || semLabel(sem),
      subject_id: r.subject.subject_id,
      subject_name: r.subject.subject_name || "",
      subject_code: r.subject.subject_code || "",
      kind: "lab",
      teacher_id: r.teacher.id,
      teacher_name: r.teacher.name,
      teacher_pinned: r.teacher.id !== subjT.effectiveTeacher(r.subject, division && division.division_id) ? true : undefined,
      division_id: division ? division.division_id : undefined,
      division_name: division ? division.name : undefined,
      slot_id,
      batch: pb.name, batch_no: pb.batch_no, batch_of: rows.length, batch_after: pb.after, batch_upto: pb.upto,
      day: slot.day,
      start_time: slot.start_time,
      end_time: slot.end_time,
      room: r.rr.foreign ? "" : r.rr.name,
      department: req.head.department,
      created_by: req.head.teacher_id,
      created_at: ts(),
    }));
  });
  await commitInBatches(ops);

  // a lab of another course is requested from its owner; that batch has no room until they answer
  const requested = [];
  for (const r of rows) {
    if (r.rr.foreign) { await createRoomRequest(req, r.rr, course, { lecture_id: r.lecture_id, subject_name: r.subject.subject_name }, { ...slot, room: r.rr.name }); requested.push(r.rr.name); }
  }

  await audit(req, "timetable.create_batches", "lectures", slot_id, { batches: rows.map((r) => `${r.label}:${r.subject.subject_code}`), ...slot });
  return res.status(201).json({ success: true, slot_id, lecture_ids: ids, created: ids.length, batches: plan.batches, rooms_requested: requested });
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
      subjectTeacher = subjT.effectiveTeacher(sd.data(), lecture.division_id);
    }
  }
  if (body.teacher_id !== undefined) {
    // permanent teacher for this slot (may differ from the subject's teacher)
    if (lecture.kind === "tutorial" && body.teacher_id && body.teacher_id !== subjectTeacher) fail(400, "A tutorial is taught by the subject's own teacher");
    const t = await activeTeacherOrFail(req, body.teacher_id);
    teacher_id = t.id; teacher_name = t.name;
    pinned = !!subjectTeacher && t.id !== subjectTeacher;
  } else if (!pinned && subjectTeacher && subjectTeacher !== teacher_id) {
    // not pinned: follow the subject's current teacher (heals slots after reassignment)
    const t = await activeTeacherOrFail(req, subjectTeacher);
    teacher_id = t.id; teacher_name = t.name;
  }

  const roomChanged = body.room !== undefined && roomName(body.room) !== roomName(lecture.room);
  const rr = roomChanged ? await resolveRoom(req, body.room, roomTypeFor(lecture.kind)) : await lookupSavedRoom(req, lecture.room);
  const slot = readSlotFields(roomChanged ? { ...body, room: rr.name } : body, lecture);
  let division_id = lecture.division_id || null, division_name = lecture.division_name || "";
  if (body.division_id !== undefined) {
    const dv = await divisionOrFail(req, req.head.courseMap[lecture.course_id], sem, body.division_id || null);
    division_id = dv ? dv.division_id : null; division_name = dv ? dv.name : "";
  }
  const conflicts = await findConflicts(req, {
    ...slot, course_id: lecture.course_id, semester: sem, teacher_id, exclude_id: lecture.lecture_id,
    division_id: division_id || undefined, egroup: await egroupOfLecture(lecture),
  });
  blockOnRoomClash(rr, conflicts);

  // a lab slot split into batches moves as one: the other batches follow a new day / time
  let siblings = [];
  const timeChanged = slot.day !== lecture.day || slot.start_time !== lecture.start_time || slot.end_time !== lecture.end_time;
  if (lecture.batch_no && lecture.slot_id) {
    if (division_id !== (lecture.division_id || null)) fail(400, "The batches of a lab belong to their division. Delete the lab slot and add it again to change the division.");
    siblings = await batchSiblings(lecture);
    if (timeChanged) {
      const ids = [lecture.lecture_id, ...siblings.map((x) => x.lecture_id)];
      for (const sb of siblings) {
        if (sb.override_id) fail(409, `${sb.batch || "Another batch"} has a temporary change running today. Undo that change first, or wait until tomorrow.`);
        const found = await findConflicts(req, {
          ...slot, room: sb.room || "", course_id: sb.course_id, semester: sem, teacher_id: sb.teacher_id, exclude_ids: ids,
          division_id: sb.division_id || undefined, egroup: `batch|${lecture.slot_id}`,
        });
        const tagged = found.map((c) => ({ ...c, message: `${sb.batch || "Batch"}: ${c.message}` }));
        blockOnRoomClash(await lookupSavedRoom(req, sb.room), tagged);
        conflicts.push(...tagged);
      }
    }
  }
  if (conflicts.length && body.force !== true) fail(409, "This slot clashes with an existing lecture", { conflicts });

  // a room of another course is requested from its owner; until they answer the slot keeps its current room
  const keepRoom = roomChanged && rr.foreign;
  await ref.update(clean({
    ...slot, ...(keepRoom ? { room: lecture.room || "" } : {}),
    ...(roomChanged ? { room_pending: FieldDelete() } : {}),
    teacher_id, teacher_name,
    teacher_pinned: pinned ? true : admin.firestore.FieldValue.delete(),
    division_id: division_id || admin.firestore.FieldValue.delete(),
    division_name: division_id ? division_name : admin.firestore.FieldValue.delete(),
    updated_by: req.head.teacher_id, updated_at: ts(),
  }));
  if (timeChanged && siblings.length) {
    await commitInBatches(siblings.map((sb) => (b) => b.update(sb.ref, {
      day: slot.day, start_time: slot.start_time, end_time: slot.end_time, updated_by: req.head.teacher_id, updated_at: ts(),
    })));
  }
  if (roomChanged) {
    await cancelRoomRequests(lecture.lecture_id, "The room was changed");
    if (keepRoom) await createRoomRequest(req, rr, req.head.courseMap[lecture.course_id], lecture, slot);
  }
  await audit(req, "timetable.update", "lectures", lecture.lecture_id, { ...slot, teacher_id });
  return res.json({ success: true, room_requested: keepRoom ? rr.name : undefined, batches_moved: timeChanged ? siblings.length : 0 });
}));

router.delete("/timetable/:id", wrap(async (req, res) => {
  const { ref, lecture } = await loadHeadLecture(req, req.params.id);
  if (lecture.override_id) fail(409, "This lecture has a temporary change running today. Undo that change first, or wait until tomorrow.");

  // the batches of a lab slot are one unit: deleting one removes them all
  if (lecture.batch_no && lecture.slot_id) {
    const all = [lecture, ...(await batchSiblings(lecture))];
    for (const l of all) {
      if (l.override_id) fail(409, `${l.batch || "A batch"} has a temporary change running today. Undo that change first, or wait until tomorrow.`);
      const used = await db.collection("lecture_sessions").where("lecture_id", "==", l.lecture_id).limit(1).get();
      if (!used.empty) fail(409, `${l.batch || "A batch"} of this lab already has attendance history, so the lab can't be deleted. Edit its day, time or room instead.`);
    }
    const pendingAll = [];
    for (const l of all) {
      (await db.collection("timetable_overrides").where("lecture_id", "==", l.lecture_id).get()).docs
        .filter((d) => d.data().status === "scheduled").forEach((d) => pendingAll.push(d));
    }
    await commitInBatches([...all.map((l) => (b) => b.delete(db.collection("lectures").doc(l.lecture_id))), ...pendingAll.map((d) => (b) => b.delete(d.ref))]);
    for (const l of all) await cancelRoomRequests(l.lecture_id, "The timetable slot was deleted");
    await audit(req, "timetable.delete_batches", "lectures", lecture.slot_id, { subject: lecture.subject_code || lecture.subject_name, day: lecture.day, start_time: lecture.start_time, batches: all.length });
    return res.json({ success: true, deleted: all.length });
  }

  const sessions = await db.collection("lecture_sessions").where("lecture_id", "==", lecture.lecture_id).limit(1).get();
  if (!sessions.empty) {
    fail(409, "This slot already has attendance history, so it can't be deleted. Edit its day, time or room instead.");
  }

  // pending one-day changes of this lecture go with it
  const pending = (await db.collection("timetable_overrides").where("lecture_id", "==", lecture.lecture_id).get())
    .docs.filter((d) => d.data().status === "scheduled");
  await commitInBatches([(b) => b.delete(ref), ...pending.map((d) => (b) => b.delete(d.ref))]);
  await cancelRoomRequests(lecture.lecture_id, "The timetable slot was deleted");

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
  let sem, lecture = null, cand, only = null, exclude = [], ovRoom = null;

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
    if (c.room !== undefined && roomName(c.room) !== roomName(lecture.room)) {
      ovRoom = await resolveRoom(req, c.room);
      if (ovRoom.foreign) fail(400, `${ovRoom.name} belongs to ${ovRoom.owner.course_abbr || "another course"}. Request it with a permanent timetable change instead.`);
      changes.room = ovRoom.name;
    }
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
      egroup: await egroupOfLecture(lecture),
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
      const tId = sp.teacher_id || subjT.effectiveTeacher(subject, sp.division_id || body.division_id);
      if (!tId) fail(400, "Pick a teacher for the special session");
      teacher = await activeTeacherOrFail(req, tId);
    } else {
      if (!title) fail(400, "Give the special session a title (or pick a subject)");
      sem = parseSem(body.semester);
      if (sem === null) fail(400, "semester is required for a session without a subject");
      if (sp.teacher_id) teacher = await activeTeacherOrFail(req, sp.teacher_id);
    }
    const slot = readSlotFields({ day, start_time: sp.start_time, end_time: sp.end_time, room: sp.room });
    ovRoom = await resolveRoom(req, slot.room);
    if (ovRoom.foreign) fail(400, `${ovRoom.name} belongs to ${ovRoom.owner.course_abbr || "another course"}. Pick one of your own rooms for a special session.`);
    slot.room = ovRoom.name;
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
    // The teachers whose lectures this session takes over must agree first.
    // Until every one of them approves, nothing changes in the timetable.
    const approvals = {};
    replaced.forEach((l) => {
      if (l.teacher_id && l.teacher_id !== req.head.teacher_id) approvals[l.teacher_id] = { name: l.teacher_name || "", status: "pending" };
    });
    if (Object.keys(approvals).length) {
      doc.status = "awaiting_approval";
      doc.approvals = approvals;
      doc.approver_ids = Object.keys(approvals);
      doc.requested_by_name = personName(req.head.teacher);
      doc.replaced_info = replaced.map((l) => clean({
        lecture_id: l.lecture_id, teacher_id: l.teacher_id || undefined, subject_name: l.subject_name || "",
        start_time: l.start_time, end_time: l.end_time, room: l.room || undefined, batch: l.batch || undefined,
      }));
    }
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
    blockOnRoomClash(ovRoom, conflicts);
    if (conflicts.length && !force) fail(409, "This clashes with another session on that day", { conflicts });
  }

  const ref = db.collection("timetable_overrides").doc();
  await ref.set(clean({ ...doc, override_id: ref.id }));
  await audit(req, "timetable.override.create", "timetable_overrides", ref.id, clean({ kind, date, lecture_id: doc.lecture_id, semester: sem }));

  let status = doc.status || "scheduled";
  if (status === "awaiting_approval") {
    const what = (doc.special && doc.special.subject_name) || "A special session";
    const uids = await teacherUids(doc.approver_ids);
    pushTo(uids, "Special session needs your approval", `${what} on ${date} would take over your lecture. Open the app to approve or reject.`, "TeacherSessionRequests");
    return res.status(201).json({ success: true, override_id: ref.id, status });
  }
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
  const lecSnap = await db.collection("lectures").where("subject_id", "==", subject_id).select("division_id", "batch", "batch_no", "batch_of", "batch_after", "batch_upto").get();
  const lectureIds = lecSnap.docs.map((d) => d.id);
  const lectureDiv = Object.fromEntries(lecSnap.docs.map((d) => [d.id, d.data().division_id || null]));
  const lectureBatch = Object.fromEntries(lecSnap.docs.map((d) => [d.id, d.data().batch_no ? labBatches.batchFields(d.data()) : null]));
  const sessions = [];
  const diag = { lectures: lectureIds.length, sessions_any: 0, sessions_completed: 0, in_range: 0 };
  const sessionSnaps = await Promise.all(chunks(lectureIds, CHUNK).map((ch) =>
    db.collection("lecture_sessions").where("lecture_id", "in", ch).select("status", "date", "started_at", "lecture_id", "division_id", "batch", "batch_no", "batch_of", "batch_after", "batch_upto").get()));
  for (const snap of sessionSnaps) {
    snap.docs.forEach((d) => {
      const x = d.data();
      diag.sessions_any++;
      if (x.status !== "completed") return;
      diag.sessions_completed++;
      const date = x.date || (toISO(x.started_at) || "").slice(0, 10) || "";
      if (date && sinceDate && date < sinceDate) return;
      if (date && untilDate && date > untilDate) return;
      sessions.push({ id: d.id, date, div: x.division_id || lectureDiv[x.lecture_id] || null, batch: x.batch_no ? labBatches.batchFields(x) : lectureBatch[x.lecture_id] || null });
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
  // lectures held for ONE division = the common ones + that division's own (no division = common ones only).
  // A lab batch counts only for the students of its roll range, so pass the student when there is one.
  const totalFor = (divisionId, student) => sessions.filter((x) => (!x.div || x.div === (divisionId || null)) && (!x.batch || (!!student && labBatches.inBatch(x.batch, labBatches.rollOf(student))))).length;
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
        const held = att.totalFor(s.division_id, s);
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

  const teacherIds = [...new Set(subjects.map((x) => subjT.effectiveTeacher(x, s.division_id)).filter(Boolean))];
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
      teacher_name: subjT.effectiveTeacher(subj, s.division_id) ? (tNames[subjT.effectiveTeacher(subj, s.division_id)] || "Unknown") : null,
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
    .filter((a) => require("../../utils/assignmentState").isLive(a))
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
    const held = act.att.totalFor(s.division_id, s);
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

// ─────────────────────────────────────────────────────────────────────────────
// DELEGATION — the head hands a Manage area of a course to other teachers
// ─────────────────────────────────────────────────────────────────────────────
const delegationView = (d) => ({
  id: d.id, course_id: d.course_id, area: d.area, teacher_id: d.teacher_id, teacher_name: d.teacher_name || "",
  delegated_at: toISO(d.created_at),
});

router.get("/delegations", wrap(async (req, res) => {
  headOnly(req);
  const ids = new Set(req.head.courses.map((c) => c.course_id));
  const [dSnap, nSnap] = await Promise.all([
    db.collection("delegations").where("aishe_code", "==", req.head.aishe_code).get(),
    db.collection("delegation_notes").where("aishe_code", "==", req.head.aishe_code).where("status", "==", "open").get(),
  ]);
  const open = {};
  nSnap.docs.forEach((d) => { const n = d.data(); if (ids.has(n.course_id)) open[`${n.course_id}|${n.area}`] = (open[`${n.course_id}|${n.area}`] || 0) + 1; });
  return res.json({
    success: true,
    areas: AREAS,
    max_delegates: MAX_DELEGATES,
    courses: req.head.courses.map((c) => ({ course_id: c.course_id, abbr: c.abbr || "", course_name: c.course_name || "" })),
    delegations: dSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => ids.has(d.course_id)).map(delegationView),
    open_notes: open,
  });
}));

router.post("/delegations", wrap(async (req, res) => {
  headOnly(req);
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);
  const area = String(body.area || "");
  if (!AREA_KEYS.has(area)) fail(400, "Pick what to delegate");
  const teacher = await activeTeacherOrFail(req, body.teacher_id);
  if (teacher.id === req.head.teacher_id) fail(400, "You already have access to everything. Pick another teacher.");

  const id = `${course.course_id}__${area}__${teacher.id}`;
  const ref = db.collection("delegations").doc(id);
  const [existing, same] = await Promise.all([
    ref.get(),
    db.collection("delegations").where("course_id", "==", course.course_id).where("area", "==", area).get(),
  ]);
  if (existing.exists) return res.json({ success: true, id, already: true });
  if (same.size >= MAX_DELEGATES) fail(409, `At most ${MAX_DELEGATES} teachers can share one area`);

  await ref.set({
    aishe_code: req.head.aishe_code,
    course_id: course.course_id,
    area,
    teacher_id: teacher.id,
    teacher_uid: teacher.data.user_id || null,
    teacher_name: teacher.name,
    delegated_by: req.head.teacher_id,
    created_at: ts(),
  });
  if (teacher.data.user_id) headCtxCache.del(teacher.data.user_id);
  await audit(req, "delegation.add", "delegations", id, { course: course.abbr, area, teacher: teacher.name });
  if (teacher.data.user_id) {
    try {
      notifyFn({
        userIds: [teacher.data.user_id],
        title: `${areaLabel(area)} is now yours to manage`,
        body: `${personName(req.head.teacher)} delegated ${areaLabel(area)} for ${course.abbr || course.course_name} to you. Open Manage on the web dashboard.`,
        data: { screen: "TeacherHome" },
      });
    } catch (e) { console.error("HEAD: push failed", e.message); }
  }
  return res.status(201).json({ success: true, id });
}));

router.delete("/delegations/:id", wrap(async (req, res) => {
  headOnly(req);
  const ref = db.collection("delegations").doc(String(req.params.id));
  const doc = await ref.get();
  if (!doc.exists) fail(404, "Delegation not found");
  const d = doc.data();
  if (d.aishe_code !== req.head.aishe_code || !req.head.courseMap[d.course_id]) fail(403, "This delegation is not in your department");
  await ref.delete();
  if (d.teacher_uid) headCtxCache.del(d.teacher_uid);
  await audit(req, "delegation.remove", "delegations", doc.id, { area: d.area, teacher: d.teacher_name });
  return res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// SUGGESTION NOTES — the head suggests changes on a delegated area, the delegate answers and marks them done
// ─────────────────────────────────────────────────────────────────────────────
function notesAccess(req, course_id, area) {
  if (!AREA_KEYS.has(String(area))) fail(400, "Unknown area");
  if (!course_id || typeof course_id !== "string") fail(400, "course_id is required");
  if (req.head.is_head) {
    if (!req.head.courseMap[course_id]) fail(403, "This course is not in your department");
  } else if (!(req.head.delegated[course_id] && req.head.delegated[course_id].has(area))) {
    fail(403, `${areaLabel(area)} has not been delegated to you`);
  }
}

const NOTE_MAX = 1000;
const noteText = (v) => {
  const t = String(v == null ? "" : v).trim().replace(/\r\n/g, "\n");
  if (!t) fail(400, "Write something first");
  if (t.length > NOTE_MAX) fail(400, `Keep it under ${NOTE_MAX} characters`);
  return t;
};
const roleOf = (req) => (req.head.is_head ? "head" : "delegate");
const noteView = (req, d) => ({
  id: d.id, course_id: d.course_id, area: d.area, text: d.text, about: d.about || "",
  author_name: d.author_name || "", author_role: d.author_role, mine: d.author_uid === req.head.uid,
  status: d.status, created_at: toISO(d.created_at), resolved_at: toISO(d.resolved_at), resolved_by: d.resolved_by || "",
  replies: (d.replies || []).map((r) => ({ author_name: r.author_name, author_role: r.author_role, text: r.text, at: r.at, mine: r.author_uid === req.head.uid })),
});

async function loadNote(req, id) {
  const ref = db.collection("delegation_notes").doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) fail(404, "Suggestion not found");
  const d = { id: doc.id, ...doc.data() };
  if (d.aishe_code !== req.head.aishe_code) fail(403, "Not allowed");
  notesAccess(req, d.course_id, d.area);
  return { ref, note: d };
}

async function delegatesOf(course_id, area) {
  const snap = await db.collection("delegations").where("course_id", "==", course_id).where("area", "==", area).get();
  return snap.docs.map((d) => d.data());
}

router.get("/notes", wrap(async (req, res) => {
  const course_id = String(req.query.course_id || ""), area = String(req.query.area || "");
  notesAccess(req, course_id, area);
  const [nSnap, dels] = await Promise.all([
    db.collection("delegation_notes").where("aishe_code", "==", req.head.aishe_code).where("course_id", "==", course_id).where("area", "==", area).get(),
    delegatesOf(course_id, area),
  ]);
  const notes = nSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(toISO(b.created_at) || "").localeCompare(String(toISO(a.created_at) || "")))
    .slice(0, 200).map((d) => noteView(req, d));
  return res.json({
    success: true,
    is_head: !!req.head.is_head,
    area, area_label: areaLabel(area),
    delegates: dels.map((d) => ({ teacher_id: d.teacher_id, name: d.teacher_name || "" })),
    open: notes.filter((n) => n.status === "open").length,
    notes,
  });
}));

router.post("/notes", wrap(async (req, res) => {
  const body = req.body || {};
  const course_id = String(body.course_id || ""), area = String(body.area || "");
  notesAccess(req, course_id, area);
  const text = noteText(body.text);
  const about = String(body.about || "").trim().slice(0, 120);
  const dels = await delegatesOf(course_id, area);
  if (!dels.length) fail(400, `Delegate ${areaLabel(area)} to a teacher first, then you can leave suggestions here`);

  const ref = db.collection("delegation_notes").doc();
  await ref.set(clean({
    aishe_code: req.head.aishe_code, course_id, area, text, about: about || undefined,
    author_uid: req.head.uid, author_id: req.head.teacher_id, author_name: personName(req.head.teacher), author_role: roleOf(req),
    status: "open", replies: [], created_at: ts(),
  }));
  if (req.head.is_head) {
    const uids = dels.map((d) => d.teacher_uid).filter(Boolean);
    if (uids.length) {
      try {
        notifyFn({ userIds: uids, title: `Suggestion for ${areaLabel(area)}`, body: text.slice(0, 120), data: { screen: "TeacherHome" } });
      } catch (e) { console.error("HEAD: push failed", e.message); }
    }
  }
  return res.status(201).json({ success: true, id: ref.id });
}));

router.post("/notes/:id/reply", wrap(async (req, res) => {
  const { ref, note } = await loadNote(req, req.params.id);
  const text = noteText((req.body || {}).text);
  if ((note.replies || []).length >= 50) fail(409, "This thread is full. Start a new suggestion.");
  const reply = { author_uid: req.head.uid, author_name: personName(req.head.teacher), author_role: roleOf(req), text, at: new Date().toISOString() };
  await ref.update({ replies: admin.firestore.FieldValue.arrayUnion(reply) });
  if (note.author_uid && note.author_uid !== req.head.uid) {
    try { notifyFn({ userIds: [note.author_uid], title: `Reply on ${areaLabel(note.area)}`, body: text.slice(0, 120), data: { screen: "TeacherHome" } }); }
    catch (e) { console.error("HEAD: push failed", e.message); }
  }
  return res.json({ success: true });
}));

router.post("/notes/:id/status", wrap(async (req, res) => {
  const { ref, note } = await loadNote(req, req.params.id);
  const status = (req.body || {}).status;
  if (status !== "open" && status !== "done") fail(400, "status must be open or done");
  if (status === note.status) return res.json({ success: true, unchanged: true });
  await ref.update(status === "done"
    ? { status, resolved_at: ts(), resolved_by: personName(req.head.teacher) }
    : { status, resolved_at: FieldDelete(), resolved_by: FieldDelete() });
  if (status === "done" && note.author_uid && note.author_uid !== req.head.uid) {
    try { notifyFn({ userIds: [note.author_uid], title: `Suggestion done: ${areaLabel(note.area)}`, body: String(note.text).slice(0, 120), data: { screen: "TeacherHome" } }); }
    catch (e) { console.error("HEAD: push failed", e.message); }
  }
  return res.json({ success: true });
}));

router.delete("/notes/:id", wrap(async (req, res) => {
  const { ref, note } = await loadNote(req, req.params.id);
  if (!req.head.is_head && note.author_uid !== req.head.uid) fail(403, "You can only delete your own suggestions");
  await ref.delete();
  return res.json({ success: true });
}));


// ─────────────────────────────────────────────────────────────────────────────
// Rooms
//   rooms/{id}          { aishe_code, course_id (owner), course_abbr, course_name, name, name_key, type, capacity?, created_by, created_at }
//   room_requests/{id}  { aishe_code, room_id, room_name, owner_course_id, course_id, course_abbr, lecture_id, day, start_time, end_time,
//                         subject_name, requested_by, requested_by_uid, status: pending|approved|declined|cancelled, note?, decided_by?, decided_at?, created_at }
// A lecture keeps the room NAME in `room` (so every reader keeps working). Rooms are shared across the college: one room can
// hold one lecture at a time. A room of another course is requested from its owner; the lecture carries `room_pending` until they answer.
//   GET    /rooms?course_id&day&start_time&end_time&exclude_id   all college rooms (+ who is using each at that slot)
//   POST   /rooms { course_id, name, type, capacity? }           PUT /rooms/:id     DELETE /rooms/:id
//   POST   /rooms/import { course_id }                           save the rooms already typed into this course's timetable
//   GET    /room-requests                                        { incoming, outgoing }
//   POST   /room-requests/:id/decide { approve, note? }
// ─────────────────────────────────────────────────────────────────────────────
const ROOM_TYPES = ["classroom", "lab"];
const roomKey = (n) => String(n || "").trim().toUpperCase();
const roomName = (v) => String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, 30);

async function loadRooms(req) {
  const snap = await db.collection("rooms").where("aishe_code", "==", req.head.aishe_code).get();
  return snap.docs.map((d) => ({ room_id: d.id, ...d.data() }));
}

// Turns what the head typed/picked into a saved room. Returns { name, saved, room_id?, type?, owner?, foreign }.
//   - a saved room (any course): canonical name; foreign when its owner course isn't one the caller manages
//   - not a saved room: allowed only while the college has no saved rooms yet (old free-text behaviour)
async function resolveRoom(req, raw, wantType) {
  const name = roomName(raw);
  if (!name) return { name: "", saved: false, foreign: false };
  const rooms = await loadRooms(req);
  const hit = rooms.find((r) => r.name_key === roomKey(name));
  if (!hit) {
    if (rooms.length) fail(400, `"${name}" is not a saved room. Pick one from the list, or add it with the Rooms button.`);
    return { name, saved: false, foreign: false };
  }
  if (wantType && hit.type !== wantType) {
    fail(400, wantType === "lab" ? `${hit.name} is a classroom. Lab sessions need a lab room.` : `${hit.name} is a lab. Lectures and tutorials need a classroom.`);
  }
  return { name: hit.name, saved: true, room_id: hit.room_id, type: hit.type, owner: hit, foreign: !req.head.courseMap[hit.course_id] };
}
const roomTypeFor = (kind) => (kind === "lab" ? "lab" : "classroom");

async function lookupSavedRoom(req, raw) {
  const name = roomName(raw);
  if (!name) return null;
  const hit = (await loadRooms(req)).find((r) => r.name_key === roomKey(name));
  return hit ? { name: hit.name, saved: true, room_id: hit.room_id, foreign: !req.head.courseMap[hit.course_id], owner: hit } : null;
}

// A saved room can never hold two lectures at once (this is not overridable with "save anyway").
function blockOnRoomClash(rr, conflicts) {
  if (rr && rr.saved && conflicts.some((c) => c.type === "room")) {
    fail(409, "That room is already in use at this time", { conflicts, blocked: true });
  }
}

async function cancelRoomRequests(lectureId, note) {
  const snap = await db.collection("room_requests").where("lecture_id", "==", lectureId).get();
  const open = snap.docs.filter((d) => d.data().status === "pending");
  if (open.length) await commitInBatches(open.map((d) => (b) => b.update(d.ref, { status: "cancelled", note: note || "Withdrawn", decided_at: ts() })));
}

// Asks the room's owner for a slot. The lecture must already exist.
async function createRoomRequest(req, rr, course, lecture, slot) {
  const ref = db.collection("room_requests").doc();
  await ref.set(clean({
    aishe_code: req.head.aishe_code, room_id: rr.room_id, room_name: rr.name, owner_course_id: rr.owner.course_id,
    owner_course_abbr: rr.owner.course_abbr || "", course_id: course.course_id, course_abbr: course.abbr || course.course_name || "",
    lecture_id: lecture.lecture_id, day: slot.day, start_time: slot.start_time, end_time: slot.end_time,
    subject_name: lecture.subject_name || "", requested_by: personName(req.head.teacher), requested_by_uid: req.head.uid,
    status: "pending", created_at: ts(),
  }));
  await db.collection("lectures").doc(lecture.lecture_id).update({ room_pending: { room_id: rr.room_id, name: rr.name, request_id: ref.id } });
  try {
    const dels = await delegatesOf(rr.owner.course_id, "timetable");
    const uids = dels.map((d) => d.teacher_uid).filter(Boolean);
    if (uids.length) {
      notifyFn({
        userIds: uids, title: `Room request: ${rr.name}`,
        body: `${course.abbr || course.course_name} wants ${rr.name} on ${slot.day} ${slot.start_time}-${slot.end_time}. Open Timetable to answer.`,
        data: { screen: "TeacherHome" },
      });
    }
  } catch (e) { console.error("HEAD: push failed", e.message); }
  return ref.id;
}

const roomRequestView = (r) => ({
  id: r.id, room_id: r.room_id, room_name: r.room_name, owner_course_id: r.owner_course_id, owner_course_abbr: r.owner_course_abbr || "",
  course_id: r.course_id, course_abbr: r.course_abbr || "", lecture_id: r.lecture_id, subject_name: r.subject_name || "",
  day: r.day, start_time: r.start_time, end_time: r.end_time, requested_by: r.requested_by || "", status: r.status,
  note: r.note || "", decided_by: r.decided_by || "", created_at: toISO(r.created_at), decided_at: toISO(r.decided_at),
});

router.get("/rooms", wrap(async (req, res) => {
  const q = req.query || {};
  const rooms = await loadRooms(req);
  const day = DAY_ORDER.includes(q.day) ? q.day : null;
  const s = q.start_time ? toMin(normTime(q.start_time) || "") : null, e = q.end_time ? toMin(normTime(q.end_time) || "") : null;
  const lecSnap = await db.collection("lectures").where("aishe_code", "==", req.head.aishe_code).get();
  const lectures = lecSnap.docs.map((d) => ({ ...d.data(), lecture_id: d.id }));
  const used = {};
  lectures.forEach((l) => { if (l.room) used[roomKey(l.room)] = (used[roomKey(l.room)] || 0) + 1; });
  const exclude = new Set(String(q.exclude_id || "").split(",").filter(Boolean));
  const withSlot = day && s !== null && e !== null && s < e;
  const out = rooms.map((r) => {
    let busy = null;
    if (withSlot) {
      const l = lectures.find((x) => x.day === day && x.room && roomKey(x.room) === r.name_key && !exclude.has(x.lecture_id) && overlaps(s, e, toMin(x.start_time), toMin(x.end_time)));
      if (l) busy = { subject_name: l.subject_name || "another class", start_time: l.start_time, end_time: l.end_time, course_abbr: (req.head.courseMap[l.course_id] || {}).abbr || "" };
    }
    return {
      room_id: r.room_id, name: r.name, type: r.type, capacity: r.capacity || null, course_id: r.course_id, course_abbr: r.course_abbr || "",
      own: !!req.head.courseMap[r.course_id], lectures: used[r.name_key] || 0, busy,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return res.json({ success: true, rooms: out, types: ROOM_TYPES });
}));

function readRoomFields(body, current = {}) {
  const name = body.name !== undefined ? roomName(body.name) : current.name;
  if (!name) fail(400, "Give the room a name, e.g. 112 or Lab B14");
  const type = body.type !== undefined ? String(body.type) : current.type || "classroom";
  if (!ROOM_TYPES.includes(type)) fail(400, "type must be classroom or lab");
  let capacity = body.capacity !== undefined ? body.capacity : current.capacity;
  if (capacity === "" || capacity === null || capacity === undefined) capacity = null;
  else {
    capacity = Number(capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2000) fail(400, "Capacity must be a whole number between 1 and 2000");
  }
  return { name, type, capacity };
}

router.post("/rooms", wrap(async (req, res) => {
  const body = req.body || {};
  const course = courseOrFail(req, body.course_id);
  const f = readRoomFields(body);
  const key = roomKey(f.name);
  const same = await db.collection("rooms").where("aishe_code", "==", req.head.aishe_code).where("name_key", "==", key).limit(1).get();
  if (!same.empty) {
    const o = same.docs[0].data();
    fail(409, `${o.name} already exists${o.course_abbr ? ` (${o.course_abbr})` : ""}. Room names are shared across the college.`);
  }
  const ref = db.collection("rooms").doc();
  await ref.set(clean({
    aishe_code: req.head.aishe_code, course_id: course.course_id, course_abbr: course.abbr || "", course_name: course.course_name || "",
    name: f.name, name_key: key, type: f.type, capacity: f.capacity || undefined, created_by: req.head.teacher_id, created_at: ts(),
  }));
  await audit(req, "room.create", "rooms", ref.id, { name: f.name, type: f.type, course: course.abbr });
  return res.status(201).json({ success: true, room_id: ref.id });
}));

async function loadOwnRoom(req, id) {
  const ref = db.collection("rooms").doc(String(id));
  const doc = await ref.get();
  if (!doc.exists || doc.data().aishe_code !== req.head.aishe_code) fail(404, "Room not found");
  const room = { room_id: doc.id, ...doc.data() };
  if (!req.head.courseMap[room.course_id]) fail(403, `${room.name} belongs to ${room.course_abbr || "another course"}. Only its owners can change it.`);
  return { ref, room };
}

router.put("/rooms/:id", wrap(async (req, res) => {
  const { ref, room } = await loadOwnRoom(req, req.params.id);
  const body = req.body || {};
  const f = readRoomFields(body, room);
  const key = roomKey(f.name);
  if (key !== room.name_key) {
    const same = await db.collection("rooms").where("aishe_code", "==", req.head.aishe_code).where("name_key", "==", key).limit(1).get();
    if (!same.empty) fail(409, `${f.name} already exists. Room names are shared across the college.`);
  }
  const ops = [(b) => b.update(ref, clean({ name: f.name, name_key: key, type: f.type, capacity: f.capacity === null ? FieldDelete() : f.capacity }))];
  let moved = 0;
  if (key !== room.name_key || f.name !== room.name) {
    // lectures hold the room by name: carry them over to the new name
    const snap = await db.collection("lectures").where("aishe_code", "==", req.head.aishe_code).get();
    snap.docs.forEach((d) => {
      const l = d.data();
      if (l.room && roomKey(l.room) === room.name_key) { moved++; ops.push((b) => b.update(d.ref, { room: f.name })); }
      else if (l.room_pending && l.room_pending.room_id === room.room_id) ops.push((b) => b.update(d.ref, { "room_pending.name": f.name }));
    });
  }
  await commitInBatches(ops);
  await audit(req, "room.update", "rooms", room.room_id, { from: room.name, to: f.name, type: f.type });
  return res.json({ success: true, lectures_updated: moved });
}));

router.delete("/rooms/:id", wrap(async (req, res) => {
  const { ref, room } = await loadOwnRoom(req, req.params.id);
  const snap = await db.collection("lectures").where("aishe_code", "==", req.head.aishe_code).get();
  const using = snap.docs.filter((d) => d.data().room && roomKey(d.data().room) === room.name_key).length;
  if (using) fail(409, `${room.name} is used by ${using} timetable slot${using === 1 ? "" : "s"}. Move them to another room first.`);
  const pend = snap.docs.filter((d) => d.data().room_pending && d.data().room_pending.room_id === room.room_id);
  await commitInBatches([(b) => b.delete(ref), ...pend.map((d) => (b) => b.update(d.ref, { room_pending: FieldDelete() }))]);
  const reqs = await db.collection("room_requests").where("room_id", "==", room.room_id).get();
  const open = reqs.docs.filter((d) => d.data().status === "pending");
  if (open.length) await commitInBatches(open.map((d) => (b) => b.update(d.ref, { status: "cancelled", note: "Room was removed", decided_at: ts() })));
  await audit(req, "room.delete", "rooms", room.room_id, { name: room.name });
  return res.json({ success: true });
}));

// Saves the room names already typed into this course's timetable, so they can be picked from now on.
router.post("/rooms/import", wrap(async (req, res) => {
  const course = courseOrFail(req, (req.body || {}).course_id);
  const [rooms, snap] = await Promise.all([
    loadRooms(req),
    db.collection("lectures").where("aishe_code", "==", req.head.aishe_code).where("course_id", "==", course.course_id).get(),
  ]);
  const have = new Set(rooms.map((r) => r.name_key));
  const found = new Map();
  snap.docs.forEach((d) => {
    const l = d.data();
    const n = roomName(l.room);
    if (!n || have.has(roomKey(n))) return;
    const cur = found.get(roomKey(n)) || { name: n, lab: false };
    if (/\blab\b|\bpractical\b/i.test(`${l.subject_name || ""} ${n}`) || /L$/i.test(String(l.subject_code || ""))) cur.lab = true;
    found.set(roomKey(n), cur);
  });
  const ops = [...found.entries()].map(([key, v]) => (b) => b.set(db.collection("rooms").doc(), clean({
    aishe_code: req.head.aishe_code, course_id: course.course_id, course_abbr: course.abbr || "", course_name: course.course_name || "",
    name: v.name, name_key: key, type: v.lab ? "lab" : "classroom", created_by: req.head.teacher_id, created_at: ts(),
  })));
  if (ops.length) await commitInBatches(ops);
  return res.json({ success: true, imported: ops.length });
}));

router.get("/room-requests", wrap(async (req, res) => {
  const snap = await db.collection("room_requests").where("aishe_code", "==", req.head.aishe_code).get();
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const mine = (id) => !!req.head.courseMap[id];
  const byNew = (a, b) => String(toISO(b.created_at) || "").localeCompare(String(toISO(a.created_at) || ""));
  const incoming = all.filter((r) => mine(r.owner_course_id) && r.status === "pending").sort(byNew).map(roomRequestView);
  const outgoing = all.filter((r) => mine(r.course_id) && r.status !== "cancelled").sort(byNew).slice(0, 30).map(roomRequestView);
  return res.json({ success: true, incoming, outgoing });
}));

router.post("/room-requests/:id/decide", wrap(async (req, res) => {
  const ref = db.collection("room_requests").doc(String(req.params.id));
  const doc = await ref.get();
  if (!doc.exists || doc.data().aishe_code !== req.head.aishe_code) fail(404, "Request not found");
  const rq = { id: doc.id, ...doc.data() };
  if (!req.head.courseMap[rq.owner_course_id]) fail(403, "Only the owner of this room can answer");
  if (rq.status !== "pending") fail(409, `This request was already ${rq.status}`);
  const approve = (req.body || {}).approve === true;
  const note = String((req.body || {}).note || "").trim().slice(0, 200);
  const lecRef = db.collection("lectures").doc(rq.lecture_id);
  const lecDoc = await lecRef.get();
  const by = personName(req.head.teacher);
  const tell = (title, body) => {
    if (!rq.requested_by_uid) return;
    try { notifyFn({ userIds: [rq.requested_by_uid], title, body, data: { screen: "TeacherHome" } }); }
    catch (e) { console.error("HEAD: push failed", e.message); }
  };
  const close = async (status, why) => {
    await ref.update(clean({ status, note: why || undefined, decided_by: by, decided_at: ts() }));
    if (lecDoc.exists && lecDoc.data().room_pending && lecDoc.data().room_pending.request_id === rq.id) await lecRef.update({ room_pending: FieldDelete() });
  };

  if (!lecDoc.exists) { await close("cancelled", "The timetable slot no longer exists"); fail(409, "That timetable slot no longer exists"); }
  if (!approve) {
    await close("declined", note);
    tell(`${rq.room_name} was declined`, `${rq.owner_course_abbr || "The owner"} declined ${rq.room_name} for ${rq.subject_name} (${rq.day} ${rq.start_time}).${note ? " " + note : ""}`);
    await audit(req, "room.decline", "room_requests", rq.id, { room: rq.room_name, course: rq.course_abbr });
    return res.json({ success: true, status: "declined" });
  }
  // the slot may have moved or the room been taken since the request was made: check again
  const lec = { ...lecDoc.data(), lecture_id: lecDoc.id };
  const list = (await loadDayLectures(req, lec.day, lec.course_id)).filter((l) => l.lecture_id !== lec.lecture_id);
  const clash = conflictsAgainst(list, { day: lec.day, start_time: lec.start_time, end_time: lec.end_time, room: rq.room_name, course_id: "-", semester: null })
    .find((c) => c.type === "room");
  if (clash) {
    await close("declined", "The room was taken in the meantime");
    tell(`${rq.room_name} is no longer free`, `${rq.room_name} was booked for another class before the request was answered.`);
    fail(409, `${rq.room_name} was booked for ${clash.subject_name} at ${clash.start_time}-${clash.end_time} in the meantime. The request was closed.`);
  }
  await lecRef.update({ room: rq.room_name, room_pending: FieldDelete() });
  await ref.update(clean({ status: "approved", note: note || undefined, decided_by: by, decided_at: ts() }));
  tell(`${rq.room_name} approved`, `${rq.subject_name} (${rq.day} ${rq.start_time}-${rq.end_time}) now has ${rq.room_name}.`);
  await audit(req, "room.approve", "room_requests", rq.id, { room: rq.room_name, course: rq.course_abbr });
  return res.json({ success: true, status: "approved" });
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