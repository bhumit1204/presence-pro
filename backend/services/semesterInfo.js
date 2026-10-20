/**
 * services/semesterInfo.js
 *
 * Shared, read-only helpers about semesters, used by:
 *   - the student "semester progress" endpoint (routes/profile.routes.js)
 *   - the automatic semester rollover (services/semesterRollover.js)
 *
 * Semester windows are RECURRING "MM-DD" pairs stored in `semester_dates`
 * (one doc per course + semester, id `${course_id}_sem${n}`); services/semesterWindow.js
 * turns them into real dates for any year.
 */

const { db } = require("../config/firebase");
const { TTLCache } = require("../utils/cache");
const win = require("./semesterWindow");

const IST_OFFSET_MS = 330 * 60 * 1000;
const istToday = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

const DAY_MS = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS); // b - a

const windowsCache = new TTLCache({ max: 2_000, ttlMs: 60_000 });
const courseCache = new TTLCache({ max: 2_000, ttlMs: 300_000 });

function parseSem(v) {
  if (v === null || v === undefined || v === "") return null;
  const m = String(v).match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 20 ? n : null;
}

/** "MM-DD" pair of a semester_dates doc (older docs stored full dates), or null. */
function readWindow(row) {
  if (!row) return null;
  const start = win.normalizeMD(row.start_md || row.start_date || "");
  const end = win.normalizeMD(row.end_md || row.end_date || "");
  return start && end && start !== end ? { start, end } : null;
}

/** Same rule the head screens use for the number of semesters of a course. */
function totalSemestersOf(course) {
  const n = Number(course && course.total_semesters);
  if (n > 0) return n;
  const years = Number(course && course.duration_years) || parseInt(course && course.duration, 10);
  if (years > 0) return years * 2;
  return 8;
}

async function getCourse(course_id) {
  if (!course_id) return null;
  return courseCache.memo(`c:${course_id}`, 300_000, async () => {
    const d = await db.collection("courses").doc(course_id).get();
    return d.exists ? { course_id: d.id, ...d.data() } : null;
  });
}

/** A student's course id; older student documents have none, so fall back to college + degree. */
async function courseIdOf(student) {
  if (!student) return null;
  if (student.course_id) return student.course_id;
  if (!student.aishe_code || !student.degree) return null;
  return courseCache.memo(`cid:${student.aishe_code}|${student.degree}`, 300_000, async () => {
    const snap = await db.collection("courses").where("aishe_code", "==", student.aishe_code).where("abbr", "==", student.degree).limit(1).get();
    return snap.empty ? null : snap.docs[0].id;
  });
}

/** { [semesterNumber]: { start, end } } for one course (only semesters whose dates are set). */
async function getWindows(course_id) {
  return windowsCache.memo(`w:${course_id}`, 60_000, async () => {
    const snap = await db.collection("semester_dates").where("course_id", "==", course_id).get();
    const out = {};
    snap.docs.forEach((d) => {
      const n = parseSem(d.data().semester);
      const w = readWindow(d.data());
      if (n !== null && w) out[n] = w;
    });
    return out;
  });
}

/**
 * Where is `semester` of `course_id` today?
 *   status "active"      the semester is running
 *   status "ended"       it finished recently and the next one has not started (<= 60 days ago)
 *   status "not_started" its next run is still ahead
 *   status "not_set"     the head has not entered dates for it
 */
async function progressFor(course_id, semester, today = istToday()) {
  const [course, windows] = await Promise.all([getCourse(course_id), getWindows(course_id)]);
  const total_semesters = totalSemestersOf(course);
  const base = { semester, label: `Sem ${semester}`, total_semesters };

  const w = windows[semester];
  if (!w) return { ...base, status: "not_set" };

  const r = win.resolveRun(w.start, w.end, today);

  if (r.status === "active") {
    const total_days = daysBetween(r.run.start_date, r.run.end_date) + 1;
    const elapsed_days = Math.min(total_days, daysBetween(r.run.start_date, today) + 1);
    return {
      ...base,
      status: "active",
      start_date: r.run.start_date,
      end_date: r.run.end_date,
      total_days,
      elapsed_days,
      days_left: Math.max(0, daysBetween(today, r.run.end_date)),
      percent: Math.min(100, Math.round((elapsed_days / total_days) * 100)),
    };
  }

  if (r.previous && daysBetween(r.previous.end_date, today) <= 60) {
    const total_days = daysBetween(r.previous.start_date, r.previous.end_date) + 1;
    return {
      ...base,
      status: "ended",
      start_date: r.previous.start_date,
      end_date: r.previous.end_date,
      total_days,
      elapsed_days: total_days,
      days_left: 0,
      percent: 100,
    };
  }

  return {
    ...base,
    status: "not_started",
    start_date: r.run ? r.run.start_date : null,
    end_date: r.run ? r.run.end_date : null,
    days_until_start: r.run ? Math.max(0, daysBetween(today, r.run.start_date)) : null,
    percent: 0,
  };
}

module.exports = { istToday, daysBetween, parseSem, readWindow, totalSemestersOf, getCourse, courseIdOf, getWindows, progressFor };