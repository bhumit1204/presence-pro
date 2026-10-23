/**
 * services/lectureAlerts.js
 *
 * Push notifications around a lecture:
 *
 *   "go"   everybody in the class, when the lecture is scheduled to begin (skipped if the teacher already started it)
 *   r60 / r30 / r15 / r10   low-attendance reminders, 60 / 30 / 15 / 10 minutes before the lecture:
 *            attendance in the subject >= 75 %          nothing
 *            50 % .. 75 %                               one reminder (15 min before)
 *            below 50 %                                 three reminders (60, 30, 10 min before)
 *            below 50 % but attended the last class     two (30, 10)        ...the last two classes: one (15)
 *          nobody gets a reminder for a lecture they already marked attendance in.
 *   onLectureStarted()  "the teacher started the lecture", sent from POST /api/lectures/start
 *
 * Quiet window: nothing about a lecture is sent earlier than `window_before_min` before it (default 60)
 * or later than `window_after_min` after it ended (default 120); each student can change both.
 *
 * Load: ONE tick a minute. A tick does nothing unless a step is due. Today's lectures are read once per
 * 30 minutes, the attendance figures once per subject (then kept up to date from the finished sessions, see
 * reports.routes attendanceStats / bumpStats), and each step is claimed with a single small write
 * (lecture_alerts/{date}_{lecture}_{step}), so a restart or a second server never sends a step twice.
 *
 * Switch off with LECTURE_ALERTS=off. Limits: ATTENDANCE_MIN (75), ATTENDANCE_VERY_LOW (50), ATTENDANCE_MIN_HELD (3).
 */
const { admin, db } = require("../config/firebase");
const { notify } = require("./notify");
const { TTLCache } = require("../utils/cache");
const { isAlreadyExists } = require("../utils/firestore");
const { studentsOfSubject, audienceOf } = require("../utils/lectureAudience");
const { prefsOf } = require("../utils/notifyPrefs");

const IST = 330 * 60 * 1000;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MIN_PCT = Number(process.env.ATTENDANCE_MIN || 75);
const VERY_LOW = Number(process.env.ATTENDANCE_VERY_LOW || 50);
const MIN_HELD = Number(process.env.ATTENDANCE_MIN_HELD || 3);
const GRACE_MIN = 4;                                             // a step more than 4 minutes late is dropped (server was down)
const DAY_REFRESH_MS = Number(process.env.ALERTS_DAY_REFRESH_MIN || 30) * 60_000;
const STEPS = [
  { key: "r60", at: -60 },
  { key: "r30", at: -30 },
  { key: "r15", at: -15 },
  { key: "r10", at: -10 },
  { key: "go", at: 0 },
];
const LECTURE_FIELDS = [
  "aishe_code", "course_id", "subject_id", "subject_name", "division_id", "division_name", "semester",
  "start_time", "end_time", "room", "teacher_id", "teacher_name", "kind", "date", "is_temporary",
  "batch", "batch_no", "batch_of", "batch_after", "batch_upto", "elective_group",
];

const toMin = (t) => {
  const [h, m] = String(t || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return `${pad2(h || 0)}:${pad2(m || 0)}`; };

/** the moment in India: weekday name, YYYY-MM-DD, minutes since midnight (fractional) */
function istClock(now = Date.now()) {
  const d = new Date(now + IST);
  return {
    day: DAYS[d.getUTCDay()],
    date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    min: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60,
  };
}

/** which reminders (minutes before the lecture) a student with these attendance figures gets */
function offsetsFor(stat) {
  if (!stat || stat.pct == null || !(stat.held >= MIN_HELD)) return [];
  if (stat.pct >= MIN_PCT) return [];
  if (stat.pct >= VERY_LOW) return [15];
  const streak = stat.streak || 0;
  return streak >= 2 ? [15] : streak === 1 ? [30, 10] : [60, 30, 10];
}

const lazy = {
  reports: () => require("../routes/reports.routes"),
};

// ─── today's lectures, cancellations, live sessions ───────────────────────────
let dayCache = { date: "", at: 0, list: [] };
const fired = new Set();                                          // steps already handled by this process
let firedDate = "";

async function todaysLectures(clock, now) {
  if (dayCache.date === clock.date && now - dayCache.at < DAY_REFRESH_MS) return dayCache.list;
  const snap = await db.collection("lectures").where("day", "==", clock.day).select(...LECTURE_FIELDS).get();
  const list = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((l) => l.start_time && l.end_time && l.subject_id && !(l.is_temporary && l.date && l.date !== clock.date));
  dayCache = { date: clock.date, at: now, list };
  return list;
}

async function isCancelled(lecture_id, date) {
  const s = await db.collection("cancelled_lectures").where("lecture_id", "==", lecture_id).where("date", "==", date).limit(1).get();
  return !s.empty;
}

const liveCache = new TTLCache({ max: 4, ttlMs: 15_000 });
/** Map(lecture_id -> { id, attendance_session_id, ...}) of every live session */
function liveSessions() {
  return liveCache.memo("live", 15_000, async () => {
    const snap = await db.collection("lecture_sessions").where("is_live", "==", true).get();
    const m = new Map();
    snap.docs.forEach((d) => { const x = d.data(); if (x.lecture_id) m.set(x.lecture_id, { id: d.id, attendance_session_id: x.attendance_session_id || null }); });
    return m;
  });
}

async function markedIn(attendance_session_id) {
  const set = new Set();
  if (!attendance_session_id) return set;
  try {
    const d = await db.collection("attendance_sessions").doc(attendance_session_id).get();
    if (d.exists) { (d.data().present_students || []).forEach((u) => set.add(u)); (d.data().pending_students || []).forEach((u) => set.add(u)); }
  } catch (_) { /* best effort */ }
  return set;
}

/** claim a step: true for exactly one caller, ever (a create() on a fixed id) */
async function claim(date, lecture_id, step) {
  try {
    await db.collection("lecture_alerts").doc(`${date}_${lecture_id}_${step}`).create({
      date, lecture_id, step, created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    if (isAlreadyExists(e)) return false;
    throw e;
  }
}

const where = (l) => (l.room ? ` · Room ${l.room}` : "");

// ─── one due step of one lecture ──────────────────────────────────────────────
async function runStep(l, step, clock) {
  const audience = audienceOf(l, await studentsOfSubject(l.subject_id));
  if (!audience.length) return 0;
  const live = (await liveSessions()).get(l.id) || null;

  if (step.key === "go") {
    if (live) return 0;                                           // the teacher already started: the students were told
    const to = audience.filter((s) => prefsOf(s).lecture_start).map((s) => s.uid);
    if (!to.length || (await isCancelled(l.id, clock.date)) || !(await claim(clock.date, l.id, step.key))) return 0;
    await notify({
      userIds: to,
      title: `${l.subject_name || "Lecture"} starts now`,
      body: `${hhmm(l.start_time)}–${hhmm(l.end_time)}${where(l)}${l.teacher_name ? ` · ${l.teacher_name}` : ""}`,
      data: { screen: "StudentHome", type: "lecture_time", lecture_id: l.id },
      category: "lecture_start",
    });
    return to.length;
  }

  const offset = -step.at;
  const stats = await lazy.reports().attendanceStats(l.subject_id);
  const marked = live ? await markedIn(live.attendance_session_id) : new Set();
  const veryLow = [], low = [];
  for (const s of audience) {
    const p = prefsOf(s);
    if (!p.low_attendance || p.window_before_min < offset || marked.has(s.uid)) continue;
    const stat = stats.get(s.uid);
    if (!offsetsFor(stat).includes(offset)) continue;
    (stat.pct < VERY_LOW ? veryLow : low).push(s.uid);
  }
  if (!veryLow.length && !low.length) return 0;
  if ((await isCancelled(l.id, clock.date)) || !(await claim(clock.date, l.id, step.key))) return 0;

  const base = { screen: "StudentHome", type: "low_attendance", lecture_id: l.id };
  const when = live ? "is on now" : `at ${hhmm(l.start_time)}${where(l)}`;
  if (veryLow.length) {
    await notify({
      userIds: veryLow,
      title: `Don't miss ${l.subject_name || "this lecture"}`,
      body: `Your attendance in this subject is very low. The lecture ${when}. Please attend.`,
      data: base, category: "low_attendance",
    });
  }
  if (low.length) {
    await notify({
      userIds: low,
      title: `${l.subject_name || "Lecture"} ${live ? "is on now" : `at ${hhmm(l.start_time)}`}`,
      body: `Your attendance is below ${MIN_PCT}%. Attend this lecture to catch up.`,
      data: base, category: "low_attendance",
    });
  }
  return veryLow.length + low.length;
}

// ─── the minute tick ──────────────────────────────────────────────────────────
let running = false;

async function tick(now = Date.now()) {
  if (running) return { skipped: true };
  running = true;
  const sent = [];
  try {
    const clock = istClock(now);
    if (firedDate !== clock.date) { fired.clear(); firedDate = clock.date; }
    if (clock.min < 4 * 60 || clock.min > 23 * 60 + 30) return { sent };          // nothing happens at night
    const lectures = await todaysLectures(clock, now);
    for (const l of lectures) {
      const start = toMin(l.start_time);
      if (clock.min < start - 61 || clock.min > start + GRACE_MIN + 1) continue; // only lectures that can have a step due
      for (const step of STEPS) {
        const at = start + step.at;
        if (clock.min < at || clock.min >= at + GRACE_MIN) continue;
        const key = `${clock.date}|${l.id}|${step.key}`;
        if (fired.has(key)) continue;
        try {
          const n = await runStep(l, step, clock);
          fired.add(key);
          if (n) sent.push({ lecture_id: l.id, step: step.key, to: n });
        } catch (e) {
          console.error("lecture alert failed:", l.id, step.key, e && e.message);
        }
      }
    }
    return { sent };
  } finally {
    running = false;
  }
}

/** old lecture_alerts documents are only bookkeeping: delete the ones older than 3 days, once a day */
let cleanedOn = "";
async function cleanup(now = Date.now()) {
  const clock = istClock(now);
  if (cleanedOn === clock.date) return;
  cleanedOn = clock.date;
  const cut = istClock(now - 3 * 86400000).date;
  const snap = await db.collection("lecture_alerts").where("date", "<", cut).limit(400).get();
  if (snap.empty) return;
  const b = db.batch();
  snap.docs.forEach((d) => b.delete(d.ref));
  await b.commit();
}

// ─── "the teacher started the lecture" ────────────────────────────────────────
/** called by POST /api/lectures/start; `session` is the lecture_sessions document that was just created */
async function onLectureStarted(session) {
  if (!session || !session.subject_id) return 0;
  const clock = istClock();
  const audience = audienceOf(session, await studentsOfSubject(session.subject_id), { checkSemester: false });
  const sStart = session.scheduled_start_time ? toMin(session.scheduled_start_time) : null;
  const sEnd = session.scheduled_end_time ? toMin(session.scheduled_end_time) : null;
  const to = audience
    .filter((s) => {
      const p = prefsOf(s);
      if (!p.lecture_live) return false;
      if (sStart !== null && clock.min < sStart - p.window_before_min) return false;
      if (sEnd !== null && clock.min > sEnd + p.window_after_min) return false;
      return true;
    })
    .map((s) => s.uid);
  if (!to.length) return 0;
  await notify({
    userIds: to,
    title: `${session.subject_name || "Your lecture"} has started`,
    body: `Your teacher started the lecture${session.room ? ` · Room ${session.room}` : ""}. Mark your attendance when it opens.`,
    data: { screen: "StudentHome", type: "lecture_live", lecture_session_id: session.session_id || null, lecture_id: session.lecture_id || null },
    category: "lecture_live",
  });
  liveCache.clear();
  return to.length;
}

/** called by POST /api/lectures/stop: keep the cached attendance figures current without re-reading everything */
async function onLectureEnded(session) {
  try {
    if (!session || !session.subject_id) return;
    liveCache.clear();
    let present = new Set();
    if (session.attendance_session_id) {
      const d = await db.collection("attendance_sessions").doc(session.attendance_session_id).get();
      if (d.exists) present = new Set(d.data().present_students || []);
    }
    lazy.reports().bumpStats(session.subject_id, session, present);
  } catch (e) {
    console.error("lecture end bookkeeping failed:", e && e.message);
  }
}

let timer = null;
function start() {
  if (timer || String(process.env.LECTURE_ALERTS || "").toLowerCase() === "off") return;
  const run = () => { tick().catch((e) => console.error("lecture alerts tick:", e && e.message)); cleanup().catch(() => {}); };
  setTimeout(run, 15_000).unref();
  timer = setInterval(run, 60_000);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, tick, cleanup, onLectureStarted, onLectureEnded, offsetsFor, istClock, _reset: () => { fired.clear(); firedDate = ""; dayCache = { date: "", at: 0, list: [] }; cleanedOn = ""; liveCache.clear(); } };
