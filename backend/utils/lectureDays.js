/**
 * utils/lectureDays.js
 *
 * One definition of "a day on which this subject had a lecture", shared by the reports routes
 * and the OD routes.  Attendance (manual, OD, or counted in a report) is only valid on those days,
 * so  present <= lectures  and  absent = lectures - present  can never go out of range.
 */

const { db } = require("../config/firebase");
const { TTLCache } = require("./cache");
const { chunk } = require("./firestore");

const IST_OFFSET_MS = 330 * 60 * 1000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const toISO = (val) => {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  return String(val);
};

/** date a lecture session belongs to, in IST ("YYYY-MM-DD") */
function sessionDate(data) {
  if (typeof data.date === "string" && YMD.test(data.date)) return data.date;
  const ms = typeof data.started_at?.toMillis === "function" ? data.started_at.toMillis() : NaN;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** today in IST as YYYY-MM-DD */
const todayIST = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

const dowUTC = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const nextDay = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** every YYYY-MM-DD from start to end inclusive, Sundays skipped */
function datesInRange(start, end) {
  const out = [];
  for (let cur = start; cur <= end; cur = nextDay(cur)) if (dowUTC(cur) !== 0) out.push(cur);
  return out;
}

// ─── completed lecture sessions of a subject: [{ sessionId, date, data }] ────────────────────────
const sessionsCache = new TTLCache({ max: 500, ttlMs: 3_000 });

async function inChunks(values, build) {
  const out = await Promise.all(chunk(values, 30).map((c) => build(c).get()));
  return out.flatMap((s) => s.docs);
}

function getLectureSessionsForSubject(subject_id) {
  return sessionsCache.memo(subject_id, 3_000, async () => {
    const lecturesSnap = await db.collection("lectures").where("subject_id", "==", subject_id).select().get();
    const lectureIds = lecturesSnap.docs.map((d) => d.id);
    if (!lectureIds.length) return [];

    const docs = await inChunks(lectureIds, (c) =>
      db.collection("lecture_sessions").where("lecture_id", "in", c).where("status", "==", "completed").select("date", "started_at", "attendance_session_id")
    );
    return docs.map((doc) => {
      const data = doc.data();
      return { sessionId: doc.id, date: sessionDate(data) || toISO(data.started_at)?.split("T")[0] || null, data };
    });
  });
}

const lectureDateSet = (sessions) => new Set(sessions.map((s) => s.date).filter(Boolean));

/**
 * Drop records whose date has no completed lecture.  Safety net for rows that were saved before the
 * validation existed (and for OD approved ahead of time: it starts counting the day a lecture is held).
 */
function keepLectureDays(records, sessions) {
  const days = lectureDateSet(sessions);
  return records.filter((r) => r.date && days.has(r.date));
}

/**
 * Single source of truth for the numbers on every report.
 *   present  = records that count as attended (present / late / od), never more than the lectures held
 *   absent   = lectures held - present   (never negative)
 */
function attendanceCounts(records, totalLectures) {
  const isPresentish = (r) => r.status === "present" || r.status === "late" || r.status === "od";
  const present = Math.min(records.filter(isPresentish).length, totalLectures);
  return {
    total_lectures: totalLectures,
    present,
    absent: Math.max(0, totalLectures - present),
    late: records.filter((r) => r.status === "late").length,
    od: records.filter((r) => r.status === "od").length,
    percentage: totalLectures > 0 ? Math.min(100, parseFloat(((present / totalLectures) * 100).toFixed(2))) : null,
  };
}

module.exports = { YMD, todayIST, datesInRange, getLectureSessionsForSubject, lectureDateSet, keepLectureDays, attendanceCounts };