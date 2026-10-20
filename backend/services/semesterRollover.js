/**
 * services/semesterRollover.js
 *
 * Automatic semester change.
 *
 * When a semester's end date (set by the head in `semester_dates`, recurring every year) has passed,
 * every student of that course who is still in that semester moves to the next one:
 *
 *   students.semester          N  ->  N + 1
 *   students.enrolled_subjects replaced by the compulsory subjects of semester N + 1
 *                              (electives are chosen again by the student, see profile.routes.js)
 *   students.semester_history  gets { semester, subjects, electives, ended_on, moved_at } appended
 *   students.semester_run_end  the end date of the run that was just closed (this is what makes it idempotent)
 *
 * Students of the LAST semester are marked `semester_status: "completed"` and leave all classes.
 *
 * Safety rails
 *   - SEM_ROLLOVER=off | dry | on   (default "dry": it only LOGS what it would do; set "on" to apply)
 *   - only semesters that ended within the last GRACE_DAYS are processed, so an old or wrong date can
 *     never mass-promote anybody
 *   - a student is never moved twice for the same run (semester_run_end marker, checked in a transaction)
 *   - one run per day across all server processes (system_jobs lock document)
 *   - the history entry keeps the old semester and subjects, so a wrong move can be undone by hand
 */

const { admin, db } = require("../config/firebase");
const { isAlreadyExists } = require("../utils/firestore");
const win = require("./semesterWindow");
const info = require("./semesterInfo");

let notifyFn = null;
function notify(payload) {
  try {
    if (!notifyFn) notifyFn = require("./notify").notify;
    return notifyFn(payload);
  } catch (e) {
    console.error("[rollover] notify failed:", e.message);
  }
}

const GRACE_DAYS = Number(process.env.SEM_ROLLOVER_GRACE_DAYS) || 30;
const RUN_AFTER_HOUR_IST = 1; // do not run before 01:00 IST
const CONCURRENCY = 15;

const mode = () => {
  const m = String(process.env.SEM_ROLLOVER || "dry").toLowerCase();
  return m === "on" || m === "off" ? m : "dry";
};

const semLabel = (n) => `Sem ${n}`;

/** The run of semester `n` that ended in the last GRACE_DAYS (not before today), or null. */
function justEnded(windows, n, today) {
  const w = windows[n];
  if (!w) return null;
  const r = win.resolveRun(w.start, w.end, today);
  if (r.status !== "upcoming" || !r.previous) return null; // still running (or about to start with nothing finished)
  const ago = info.daysBetween(r.previous.end_date, today);
  return ago >= 1 && ago <= GRACE_DAYS ? r.previous : null;
}

async function studentsOfCourse(course) {
  const out = new Map();
  const add = (d) => out.set(d.id, { ref: d.ref, id: d.id, ...d.data() });
  const snap = await db.collection("students").where("course_id", "==", course.course_id).get();
  snap.docs.forEach(add);
  // older student documents have no course_id: match them by college + degree like the head screens do
  if (course.aishe_code && course.abbr) {
    const old = await db
      .collection("students")
      .where("aishe_code", "==", course.aishe_code)
      .where("degree", "==", course.abbr)
      .get();
    old.docs.forEach((d) => { if (!d.data().course_id) add(d); });
  }
  return [...out.values()];
}

/** Run `fn` over `items` with a small concurrency limit. */
async function pool(items, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Process every course (or only the courses of one college).
 *   apply     false = look only, write nothing
 *   aisheCode limit to one college (used by the head's preview)
 * Returns a summary; never throws for a single student's failure.
 */
async function process_({ apply, aisheCode, today = info.istToday() }) {
  const csnap = aisheCode
    ? await db.collection("courses").where("aishe_code", "==", aisheCode).get()
    : await db.collection("courses").get();

  const summary = { today, apply, courses: [], promoted: 0, completed: 0, failed: 0 };
  const notifications = []; // { uid, semester, hasElectives }

  for (const cdoc of csnap.docs) {
    const course = { course_id: cdoc.id, ...cdoc.data() };
    const windows = await info.getWindows(course.course_id);
    const total = info.totalSemestersOf(course);

    const todo = []; // [{ n, run }]
    for (let n = 1; n <= total; n++) {
      const run = justEnded(windows, n, today);
      if (run) todo.push({ n, run });
    }
    if (!todo.length) continue;

    const [students, subjSnap] = await Promise.all([
      studentsOfCourse(course),
      db.collection("subjects").where("course_id", "==", course.course_id).get(),
    ]);
    const subjects = subjSnap.docs.map((d) => ({ subject_id: d.id, ...d.data() }));

    const row = { course_id: course.course_id, abbr: course.abbr || "", moves: [] };
    // divisions of this course by semester + name, so a student keeps "Division A" in the next semester when it exists
    const divSnap = await db.collection("divisions").where("course_id", "==", course.course_id).get();
    const divByKey = new Map();
    divSnap.docs.forEach((d) => divByKey.set(`${info.parseSem(d.data().semester)}|${d.data().name}`, { id: d.id, name: d.data().name }));

    for (const { n, run } of todo) {
      const cohort = students.filter(
        (s) =>
          info.parseSem(s.semester) === n &&
          s.semester_status !== "completed" &&
          s.approval_status !== "rejected" &&
          s.semester_run_end !== run.end_date
      );
      if (!cohort.length) continue;

      const last = n >= total;
      const next = n + 1;
      const nextCompulsory = last
        ? []
        : subjects.filter((x) => x.semester === semLabel(next) && x.compulsary !== false).map((x) => x.subject_id);
      const nextHasElectives = !last && subjects.some((x) => x.semester === semLabel(next) && x.compulsary === false);

      row.moves.push({
        from: n,
        to: last ? "completed" : next,
        ended_on: run.end_date,
        students: cohort.length,
        sample: cohort.slice(0, 5).map((s) => s.name || s.uid),
        new_subjects: nextCompulsory.length,
      });

      if (!apply) continue;

      await pool(cohort, async (s) => {
        try {
          const moved = await db.runTransaction(async (tx) => {
            const snap = await tx.get(s.ref);
            const cur = snap.data() || {};
            // re-check inside the transaction: another process or a head may have changed the student meanwhile
            if (info.parseSem(cur.semester) !== n || cur.semester_run_end === run.end_date || cur.semester_status === "completed") return false;

            const history = {
              semester: n,
              subjects: Array.isArray(cur.enrolled_subjects) ? cur.enrolled_subjects : [],
              electives: (cur.elective_choices && cur.elective_choices[String(n)]) || {},
              ended_on: run.end_date,
              moved_at: new Date().toISOString(),
            };
            const update = {
              semester_run_end: run.end_date,
              semester_changed_at: admin.firestore.FieldValue.serverTimestamp(),
              semester_history: admin.firestore.FieldValue.arrayUnion(history),
              enrolled_subjects: nextCompulsory,
            };
            if (last) update.semester_status = "completed";
            else update.semester = next;
            // division carries over by name; a student whose division does not exist next semester becomes "no division"
            if (cur.division_id) {
              const same = last ? null : divByKey.get(`${next}|${cur.division}`);
              if (same) { update.division_id = same.id; update.division = same.name; }
              else { update.division_id = admin.firestore.FieldValue.delete(); update.division = admin.firestore.FieldValue.delete(); }
            }
            tx.update(s.ref, update);
            return true;
          });
          if (!moved) return;
          if (last) summary.completed++;
          else summary.promoted++;
          notifications.push({ uid: s.uid || s.id, semester: last ? null : next, hasElectives: nextHasElectives });
        } catch (e) {
          summary.failed++;
          console.error(`[rollover] could not move student ${s.uid || s.id}:`, e.message);
        }
      });
    }

    if (row.moves.length) summary.courses.push(row);
  }

  if (apply && notifications.length) {
    // grouped, so each kind of message is one push batch
    const groups = new Map();
    notifications.forEach((x) => {
      const key = `${x.semester}|${x.hasElectives}`;
      if (!groups.has(key)) groups.set(key, { ...x, uids: [] });
      groups.get(key).uids.push(x.uid);
    });
    groups.forEach((g) => {
      notify(
        g.semester
          ? {
              userIds: g.uids,
              title: `You are now in Semester ${g.semester}`,
              body: g.hasElectives ? "Your subjects are updated. Open the app to choose your electives." : "Your subjects have been updated.",
              data: { screen: g.hasElectives ? "ElectiveSelection" : "StudentWork" },
            }
          : {
              userIds: g.uids,
              title: "Course completed",
              body: "You have finished your final semester. Congratulations.",
              data: { screen: "StudentProfile" },
            }
      );
    });
  }

  return summary;
}

/** Look only: what would move today. */
const preview = (opts = {}) => process_({ ...opts, apply: false });

let lastDryDate = null;
let running = false;

/** One scheduled check: runs at most once per day (lock document), only after 01:00 IST. */
async function tick() {
  if (running) return;
  const m = mode();
  if (m === "off") return;

  const nowIst = new Date(Date.now() + 330 * 60 * 1000);
  if (nowIst.getUTCHours() < RUN_AFTER_HOUR_IST) return;
  const today = nowIst.toISOString().slice(0, 10);

  running = true;
  try {
    if (m === "dry") {
      if (lastDryDate === today) return;
      lastDryDate = today;
      const s = await preview({ today });
      console.log(`[rollover] DRY RUN ${today}: would move ${s.courses.reduce((a, c) => a + c.moves.reduce((x, y) => x + y.students, 0), 0)} student(s)`, JSON.stringify(s.courses));
      return;
    }

    const lock = db.collection("system_jobs").doc(`semester_rollover_${today}`);
    try {
      await lock.create({ started_at: admin.firestore.FieldValue.serverTimestamp(), status: "running" });
    } catch (e) {
      if (isAlreadyExists(e)) return; // another process (or an earlier tick) already did today's run
      throw e;
    }
    try {
      const s = await process_({ apply: true, today });
      await lock.update({ status: "done", finished_at: admin.firestore.FieldValue.serverTimestamp(), summary: JSON.stringify(s).slice(0, 8000) });
      if (s.promoted || s.completed || s.failed) console.log(`[rollover] ${today}: promoted ${s.promoted}, completed ${s.completed}, failed ${s.failed}`);
    } catch (e) {
      await lock.delete().catch(() => {}); // let the next tick retry
      throw e;
    }
  } catch (e) {
    console.error("[rollover] run failed:", e);
  } finally {
    running = false;
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  setTimeout(() => tick(), 60 * 1000).unref();
  setInterval(() => tick(), 30 * 60 * 1000).unref();
}

module.exports = { start, tick, preview, run: process_, mode, justEnded };