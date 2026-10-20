/**
 * services/semesterWindow.js
 *
 * Semester dates are RECURRING: a head enters only a day and month ("07-01" to
 * "12-15"), never a year, and every year's real dates are derived from them.
 * Anything that needs "when does semester N run" (reports, the future
 * semester-end promotion job, attendance rules…) should use these helpers so
 * the whole system agrees.
 *
 *   resolveRun("07-01", "12-15", "2026-10-13")
 *     → { status: "active",   run: { start_date: "2026-07-01", end_date: "2026-12-15" }, previous: {…2025} }
 *   resolveRun("07-01", "12-15", "2026-12-20")
 *     → { status: "upcoming", run: { start_date: "2027-07-01", … },                      previous: {…2026} }
 *
 * A window whose end is earlier in the calendar than its start (e.g. "11-15" →
 * "03-31") runs across New Year; its end falls in the following year.
 * "02-29" is clamped to 28 Feb in non-leap years.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MD_RE = /^(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, "0");
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** "MM-DD" → { month, day } or null if it isn't a real calendar day (02-29 allowed). */
function parseMD(s) {
  const m = MD_RE.exec(String(s || ""));
  if (!m) return null;
  const month = parseInt(m[1], 10), day = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(2024, month)) return null; // 2024 is a leap year
  return { month, day };
}

/** Accepts "MM-DD" or a full "YYYY-MM-DD" (year dropped). Returns "MM-DD" or null. */
function normalizeMD(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  const md = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : s;
  return parseMD(md) ? md : null;
}

/** "07-01" → "1 Jul" */
function formatMD(md) {
  const p = parseMD(md);
  return p ? `${p.day} ${MONTHS[p.month - 1]}` : "";
}

/** The real date (YYYY-MM-DD) of an "MM-DD" in a given year. */
function dateIn(year, md) {
  const { month, day } = parseMD(md);
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

const wraps = (startMd, endMd) => endMd < startMd;

/** The run that STARTS in `startYear`. */
function occurrence(startMd, endMd, startYear) {
  return {
    start_date: dateIn(startYear, startMd),
    end_date: dateIn(wraps(startMd, endMd) ? startYear + 1 : startYear, endMd),
  };
}

/**
 * Which run matters right now?
 *  - today inside a run  → { status: "active", run }
 *  - otherwise           → { status: "upcoming", run: next one }
 * `previous` is the latest run that has already ended (or null).
 */
function resolveRun(startMd, endMd, today) {
  const y = parseInt(String(today).slice(0, 4), 10);
  const runs = [y - 1, y, y + 1].map((yr) => occurrence(startMd, endMd, yr));

  const active = runs.find((r) => r.start_date <= today && today <= r.end_date);
  if (active) {
    const previous = runs.filter((r) => r.end_date < active.start_date).pop() || null;
    return { status: "active", run: active, previous };
  }
  const next = runs.find((r) => r.start_date > today) || null;
  const previous = [...runs].reverse().find((r) => r.end_date < today) || null;
  return { status: "upcoming", run: next, previous };
}

/** Length in days of one run (reference year, so leap days don't matter). */
function spanDays(startMd, endMd) {
  const r = occurrence(startMd, endMd, 2025);
  return Math.round((Date.parse(r.end_date) - Date.parse(r.start_date)) / 86400000) + 1;
}

// day-of-year in a non-leap reference year
function doy(md) {
  const { month, day } = parseMD(md);
  const d = Math.min(day, daysInMonth(2025, month));
  return Math.round((Date.UTC(2025, month - 1, d) - Date.UTC(2025, 0, 1)) / 86400000) + 1;
}
function intervals(startMd, endMd) {
  const a = doy(startMd), b = doy(endMd);
  return wraps(startMd, endMd) ? [[a, 365], [1, b]] : [[a, b]];
}

/** Do two recurring windows share any day of the year? */
function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  const A = intervals(aStart, aEnd), B = intervals(bStart, bEnd);
  return A.some(([a1, a2]) => B.some(([b1, b2]) => a1 <= b2 && b1 <= a2));
}

module.exports = {
  MONTHS, parseMD, normalizeMD, formatMD, dateIn, wraps,
  occurrence, resolveRun, spanDays, windowsOverlap,
};