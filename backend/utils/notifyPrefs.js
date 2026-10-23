/**
 * utils/notifyPrefs.js
 *
 * A student's notification settings, stored on the student document as `notify_prefs`.
 * Everything is ON by default, so students who never open the settings screen notice no change.
 *
 *   lecture_start     "your lecture is starting now" (at the scheduled start time)
 *   lecture_live      "the teacher started the lecture"
 *   low_attendance    reminders before a lecture when attendance in that subject is low
 *   assignments / quizzes / announcements   the other activities
 *   window_before_min lecture notifications are never sent earlier than this long before a lecture (default 60)
 *   window_after_min  ... nor later than this long after it ended (default 120)
 */
const DEFAULTS = {
  lecture_start: true,
  lecture_live: true,
  low_attendance: true,
  assignments: true,
  quizzes: true,
  announcements: true,
  window_before_min: 60,
  window_after_min: 120,
};
const TOGGLES = ["lecture_start", "lecture_live", "low_attendance", "assignments", "quizzes", "announcements"];
const LIMITS = { window_before_min: [10, 180], window_after_min: [0, 360] };

/** category sent by a caller of notify() -> the toggle that controls it */
const CATEGORY = {
  lecture_start: "lecture_start",
  lecture_live: "lecture_live",
  low_attendance: "low_attendance",
  assignment: "assignments",
  assignments: "assignments",
  quiz: "quizzes",
  quizzes: "quizzes",
  announcement: "announcements",
  announcements: "announcements",
};

const clampInt = (v, [lo, hi], dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** the stored settings of a student document (or null) merged over the defaults */
function prefsOf(student) {
  const p = (student && student.notify_prefs) || {};
  const out = { ...DEFAULTS };
  for (const k of TOGGLES) if (typeof p[k] === "boolean") out[k] = p[k];
  for (const k of Object.keys(LIMITS)) out[k] = clampInt(p[k], LIMITS[k], DEFAULTS[k]);
  return out;
}

/** validate a PUT body: only known keys, right types; returns { ok, value, error } */
function sanitize(body) {
  const b = body && typeof body === "object" ? body : {};
  const value = {};
  for (const k of TOGGLES) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") return { ok: false, error: `${k} must be true or false` };
    value[k] = b[k];
  }
  for (const k of Object.keys(LIMITS)) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]);
    if (!Number.isFinite(n)) return { ok: false, error: `${k} must be a number` };
    value[k] = clampInt(n, LIMITS[k], DEFAULTS[k]);
  }
  return { ok: true, value };
}

/** may a notification of this category be sent to a user with these stored settings? (unknown category = yes) */
function allows(storedPrefs, category) {
  const key = CATEGORY[category];
  if (!key) return true;
  return !storedPrefs || storedPrefs[key] !== false;
}

module.exports = { DEFAULTS, TOGGLES, LIMITS, CATEGORY, prefsOf, sanitize, allows };
