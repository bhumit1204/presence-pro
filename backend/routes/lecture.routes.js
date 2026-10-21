/**
 * routes/lecture.routes.js   (mounted at /api/lectures)
 *
 * Optimised + hardened version. API paths, request fields and response bodies are the
 * same as the original; what changed is HOW the work is done.
 *
 * ── Why this file matters for load ───────────────────────────────────────────
 *   When a teacher opens attendance, every student in the room (300+) hits
 *   /student/today, /attendance/code-options and /attendance/mark-* within a few
 *   seconds. The original did, per student: 2-4 Firestore queries AND an
 *   `arrayUnion` on the SAME attendance_sessions document (Firestore allows ~1 write/s
 *   to one document -> contention errors for most of the class).
 *
 *   Now:
 *   - student / session / lecture / course lookups are cached and single-flight
 *     (300 identical requests -> 1 Firestore read), student lookups are batched
 *   - `present_students` (legacy array, used by the teacher's live counter) is
 *     written through a write-coalescer: one arrayUnion per ~600 ms for the whole class
 *   - each student's own attendance_records/{session}_{uid} document is still written
 *     immediately and is the source of truth (that is what reports read)
 *   - the cached "attendance session" no longer gets thrown away after every single mark
 *     (the original invalidated it on every request, so the cache never helped)
 *   - check-then-write races are closed with transactions (assign / respond / start /
 *     start-qr / cancel) and `create()` (QR marking)
 *   - teacher-only endpoints verify the caller (guards) and the session owner (allow())
 *   - BLE median tracker is bounded and expires, wifi/BLE inputs are sanitised
 */

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const speakeasy = require("speakeasy");
const { v4: uuidv4 } = require("uuid");

const { admin, db } = require("../config/firebase");
const { notify } = require("../services/notify");
const { guard, allow, teacherIdForUid, fromBody, fromQuery } = require("../middleware/auth");
const { TTLCache } = require("../utils/cache");
const { rateLimit, byIp } = require("../utils/limiter");
const { createCoalescer } = require("../utils/coalesce");
const { chunk, getDocsByIds, commitInBatches, isAlreadyExists } = require("../utils/firestore");
const { getStudentByUid, getStudentByRoll } = require("../utils/students");
const prox = require("../utils/proximity");

/* ═══════════════════════════════════════════════════════════════════════════
   small helpers
   ═══════════════════════════════════════════════════════════════════════════ */

const FV = admin.firestore.FieldValue;
const PRESENT_FLUSH_MS = Number(process.env.PRESENT_FLUSH_MS) || 600;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const toMin = (t) => {
  if (typeof t !== "string" || !t.includes(":")) return NaN;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

const hasOverlap = (newStart, newEnd, exStart, exEnd) =>
  toMin(newStart) < toMin(exEnd) && toMin(newEnd) > toMin(exStart);

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Timezone-safe day name from "YYYY-MM-DD" (parsed as 06:30Z so no flip on any server timezone)
const getDayNameFromDate = (dateStr) => DAY_NAMES[new Date(dateStr + "T06:30:00Z").getDay()];

const IST_OFFSET = 330 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, "0");
const istDateString = (istDate) =>
  `${istDate.getUTCFullYear()}-${pad2(istDate.getUTCMonth() + 1)}-${pad2(istDate.getUTCDate())}`;

const tsMs = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : ts && ts.toDate ? ts.toDate().getTime() : NaN);

const generate8DigitCode = () => String(crypto.randomInt(10000000, 100000000));
const generate3DigitCode = () => String(crypto.randomInt(100, 1000));

/** usable as a Firestore document id (never lets user input build a path) */
const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 200 && !v.includes("/");

const safeNotify = (payload) => {
  try {
    Promise.resolve(notify(payload)).catch((e) => console.error("notify failed:", e.message));
  } catch (e) {
    console.error("notify failed:", e.message);
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
   caches (all per process; every TTL is short enough to be harmless when stale)
   ═══════════════════════════════════════════════════════════════════════════ */

const teacherByUidCache = new TTLCache({ max: 5000, ttlMs: 60_000 });
const teacherByIdCache = new TTLCache({ max: 5000, ttlMs: 60_000 });
const courseCache = new TTLCache({ max: 2000, ttlMs: 120_000 });
const courseIdByNameCache = new TTLCache({ max: 2000, ttlMs: 120_000 });
const lectureCache = new TTLCache({ max: 5000, ttlMs: 15_000 });
const lectureSessionCache = new TTLCache({ max: 5000, ttlMs: 3_000 });
const attendanceCache = new TTLCache({ max: 5000, ttlMs: 30_000 });
const liveSessionsCache = new TTLCache({ max: 500, ttlMs: 2_000 });
const timetableCache = new TTLCache({ max: 2000, ttlMs: 30_000 });
const rosterCache = new TTLCache({ max: 500, ttlMs: 30_000 });
const recordsCache = new TTLCache({ max: 1000, ttlMs: 2_000 });
const todayCache = new TTLCache({ max: 5000, ttlMs: 3_000 });
const listCache = new TTLCache({ max: 5000, ttlMs: 3_000 });
const subjectsCache = new TTLCache({ max: 5000, ttlMs: 10_000 });
const teacherListCache = new TTLCache({ max: 500, ttlMs: 30_000 });
const qrIndex = new TTLCache({ max: 5000, ttlMs: 60_000 });
const markedCache = new TTLCache({ max: 50_000, ttlMs: 10 * 60_000 }); // "<session>_<uid>" -> true
const lastSig = new TTLCache({ max: 5000, ttlMs: 6 * 3600_000 });
// server-only BLE token secret per attendance session (kept OUT of attendance_sessions: students can read that document)
const bleStateCache = new TTLCache({ max: 5000, ttlMs: 60_000 });

/** teacher doc for an auth uid -> { id, data } | null */
async function getTeacherByUid(uid) {
  if (typeof uid !== "string" || !uid) return null;
  const t = await teacherByUidCache.memo(`u:${uid}`, 60_000, async () => {
    const snap = await db.collection("teachers").where("user_id", "==", uid).limit(1).get();
    return snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() };
  });
  if (!t) teacherByUidCache.set(`u:${uid}`, "", 5_000);
  return t || null;
}

/** teacher doc by doc id -> data | null */
async function getTeacherById(id) {
  if (!isId(id)) return null;
  const t = await teacherByIdCache.memo(`i:${id}`, 60_000, async () => {
    const d = await db.collection("teachers").doc(id).get();
    return d.exists ? d.data() : null;
  });
  return t || null;
}

async function getCourse(id) {
  if (!isId(id)) return null;
  const c = await courseCache.memo(`c:${id}`, 120_000, async () => {
    const d = await db.collection("courses").doc(id).get();
    return d.exists ? d.data() : null;
  });
  return c || null;
}

async function getLecture(id) {
  if (!isId(id)) return null;
  const l = await lectureCache.memo(`l:${id}`, 15_000, async () => {
    const d = await db.collection("lectures").doc(id).get();
    return d.exists ? d.data() : null;
  });
  return l || null;
}

/** lecture_sessions/{id} -> data | null (3 s cache; dropped by every write in this file) */
async function getLectureSession(id) {
  if (!isId(id)) return null;
  const s = await lectureSessionCache.memo(`s:${id}`, 3_000, async () => {
    const d = await db.collection("lecture_sessions").doc(id).get();
    return d.exists ? d.data() : null;
  });
  return s || null;
}

/** attendance_sessions/{id} -> { id, ...data } | null.  Dropped on close/start in this process. */
async function getAttendanceSession(id) {
  if (!isId(id)) return null;
  const s = await attendanceCache.memo(`a:${id}`, 30_000, async () => {
    const d = await db.collection("attendance_sessions").doc(id).get();
    return d.exists ? { id: d.id, ...d.data() } : null;
  });
  return s || null;
}

const dropLectureSession = (id) => {
  if (id) lectureSessionCache.del(`s:${id}`);
  liveSessionsCache.clear();
};
const dropAttendanceSession = (id) => {
  if (id) {
    attendanceCache.del(`a:${id}`);
    bleReadings.delete(id);
    bleStateCache.del(`b:${id}`);
    classRef.drop(id);
    lastSig.del(id);
    sigDirty.delete(id);
    recordsCache.del(`r:${id}`);
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
   rate limits / device key
   ═══════════════════════════════════════════════════════════════════════════ */

// A whole classroom shares one campus IP, so student limits are per USER (uid), never per IP alone.
const byStudent = (req) => req.auth?.uid || (typeof req.body?.uid === "string" ? req.body.uid : null) || byIp(req);
const markLimit = rateLimit({ windowMs: 60_000, max: 40, key: byStudent, name: "lec-mark" });
const readLimit = rateLimit({ windowMs: 60_000, max: 240, key: byStudent, name: "lec-read" });
const qrLiveLimit = rateLimit({ windowMs: 60_000, max: 1500, key: byIp, name: "lec-qrlive" });
const iotLimit = rateLimit({ windowMs: 60_000, max: 1200, key: byIp, name: "lec-iot" });

/**
 * ESP32 endpoints are public (no Firebase login). If IOT_DEVICE_KEY is set in the environment
 * the device must send it as header `x-device-key` (or body/query `device_key`).
 * When the variable is not set nothing changes.
 */
function iotKey(req, res, next) {
  const want = process.env.IOT_DEVICE_KEY;
  if (!want) return next();
  const got = String(req.get("x-device-key") || req.body?.device_key || req.query?.device_key || "");
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ success: false, error: "Invalid device key" });
}

/* ═══════════════════════════════════════════════════════════════════════════
   ownership helpers (soft-rollout friendly: use with allow())
   ═══════════════════════════════════════════════════════════════════════════ */

/** does the logged-in user own this lecture_session? (true when not logged in / session missing) */
async function callerOwnsLectureSession(req, ls) {
  if (!req.auth || !ls) return true;
  if (ls.teacher_id === req.auth.uid) return true;
  const tid = await teacherIdForUid(req.auth.uid);
  return !!tid && ls.teacher_id === tid;
}

/** teacher teaches this lecture himself, or accepted it as a temporary session on `date` */
async function teacherCoversLecture(teacher_id, lecture_id, lecture, date) {
  if (lecture && lecture.teacher_id === teacher_id) return true;
  if (!lecture) return true; // unknown lecture: the original never checked, don't invent failures
  const snap = await db
    .collection("lecture_sessions")
    .where("teacher_id", "==", teacher_id)
    .where("is_temporary", "==", true)
    .where("date", "==", date)
    .select("lecture_id")
    .get();
  return snap.docs.some((d) => d.data().lecture_id === lecture_id);
}

/* ═══════════════════════════════════════════════════════════════════════════
   busy-teacher computation (scheduling conflicts)
   ═══════════════════════════════════════════════════════════════════════════ */

const getBusyTeacherIds = async ({ aishe_code, date, start_time, end_time, day, exclude_lecture_id }) => {
  if (!aishe_code || !date || !start_time || !end_time || !day) {
    console.error("getBusyTeacherIds: Missing required parameters", { aishe_code, date, start_time, end_time, day });
    return new Set();
  }

  const [lectureSnap, sessionSnap, assignmentSnap] = await Promise.all([
    db.collection("lectures")
      .where("aishe_code", "==", aishe_code)
      .where("day", "==", day)
      .select("teacher_id", "start_time", "end_time")
      .get(),
    db.collection("lecture_sessions")
      .where("aishe_code", "==", aishe_code)
      .where("date", "==", date)
      .where("is_temporary", "==", true)
      .select("teacher_id", "lecture_id", "start_time", "end_time")
      .get(),
    db.collection("lecture_assignments")
      .where("aishe_code", "==", aishe_code)
      .where("date", "==", date)
      .where("status", "==", "pending")
      .select("assigned_teacher_id", "lecture_id", "start_time", "end_time", "expires_at")
      .get(),
  ]);

  const busyIds = new Set();

  lectureSnap.docs.forEach((doc) => {
    if (exclude_lecture_id && doc.id === exclude_lecture_id) return; // skip the lecture being assigned/accepted
    const l = doc.data();
    if (hasOverlap(start_time, end_time, l.start_time, l.end_time)) busyIds.add(l.teacher_id);
  });

  sessionSnap.docs.forEach((doc) => {
    const s = doc.data();
    if (exclude_lecture_id && s.lecture_id === exclude_lecture_id) return;
    if (hasOverlap(start_time, end_time, s.start_time, s.end_time)) busyIds.add(s.teacher_id);
  });

  const now = Date.now();
  assignmentSnap.docs.forEach((doc) => {
    const a = doc.data();
    if (a.expires_at && tsMs(a.expires_at) < now) return;
    if (exclude_lecture_id && a.lecture_id === exclude_lecture_id) return;
    if (hasOverlap(start_time, end_time, a.start_time, a.end_time)) busyIds.add(a.assigned_teacher_id);
  });

  const swapSnap = await db.collection("lecture_swaps").where("aishe_code", "==", aishe_code).where("date", "==", date).where("status", "==", "pending").get();
  swapSnap.docs.forEach((doc) => {
    const s = doc.data();
    if (s.expires_at && tsMs(s.expires_at) < now) return;
    if (!(exclude_lecture_id && s.requester_lecture_id === exclude_lecture_id) && hasOverlap(start_time, end_time, s.requester_start, s.requester_end)) busyIds.add(s.partner_teacher_id);
    if (!(exclude_lecture_id && s.partner_lecture_id === exclude_lecture_id) && hasOverlap(start_time, end_time, s.partner_start, s.partner_end)) busyIds.add(s.requester_teacher_id);
  });

  return busyIds;
};

/* ═══════════════════════════════════════════════════════════════════════════
   GET /today   (teacher schedule)
   ═══════════════════════════════════════════════════════════════════════════ */

const toMinutes = (time) => {
  if (!time || !time.includes(":")) return 0;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/** lecture_sessions temp docs -> lecture-shaped objects (one batched read for all parents) */
async function enrichTempSessions(sessionDocs) {
  const parents = await getDocsByIds("lectures", sessionDocs.map((d) => d.data().lecture_id));
  const out = [];
  for (const sd of sessionDocs) {
    const s = sd.data();
    if (!s.lecture_id) continue;
    const ld = parents.get(s.lecture_id);
    if (!ld) continue;
    const l = ld.data();
    out.push({
      id: ld.id,
      ...l,
      teacher_id: s.teacher_id,
      start_time: s.start_time || l.start_time,
      end_time: s.end_time || l.end_time,
      day: s.day || l.day,
      is_temporary: true,
      temp_session_id: sd.id,
    });
  }
  return out;
}

const tempSessionsQuery = (teacher_id, date) =>
  db.collection("lecture_sessions")
    .where("teacher_id", "==", teacher_id)
    .where("is_temporary", "==", true)
    .where("date", "==", date)
    .get();

async function buildTodayResponse(uid, requestedDate) {
  const teacher = await getTeacherByUid(uid);
  if (!teacher) return { code: 404, body: { error: "Teacher profile not found" } };

  const teacher_id = teacher.id;
  const aishe_code = teacher.data.aishe_code;
  if (!aishe_code) return { code: 400, body: { error: "Teacher profile missing aishe_code" } };

  // ── BRANCH A — a specific date (LectureSchedule screen) ──
  if (requestedDate) {
    const selectedDay = getDayNameFromDate(requestedDate);

    const [lectureSnap, tempSessionsSnap, cancelledSnap] = await Promise.all([
      db.collection("lectures")
        .where("teacher_id", "==", teacher_id)
        .where("aishe_code", "==", aishe_code)
        .where("day", "==", selectedDay)
        .get(),
      tempSessionsQuery(teacher_id, requestedDate),
      db.collection("cancelled_lectures")
        .where("teacher_id", "==", teacher_id)
        .where("date", "==", requestedDate)
        .select("lecture_id")
        .get(),
    ]);

    const lecturesRaw = lectureSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const tempLectures = await enrichTempSessions(tempSessionsSnap.docs);

    const regularIds = new Set(lecturesRaw.map((l) => l.id));
    const mergedRaw = [...lecturesRaw, ...tempLectures.filter((t) => !regularIds.has(t.id))];

    const courseIds = [...new Set(mergedRaw.map((l) => l.course_id).filter(Boolean))];
    const courseMap = {};
    await Promise.all(
      courseIds.map(async (cid) => {
        const c = await getCourse(cid);
        if (c) courseMap[cid] = c.abbr || "";
      })
    );

    const lectures = mergedRaw.map((l) => ({ ...l, course_abbr: courseMap[l.course_id] || "" }));

    const cancelledIds = new Set(cancelledSnap.docs.map((d) => d.data().lecture_id));
    const marks = await swapMarksFor(teacher_id, requestedDate);
    return {
      code: 200,
      body: {
        success: true,
        lectures: lectures.filter((l) => !cancelledIds.has(l.id)).map((l) => (marks.has(l.id) ? { ...l, ...marks.get(l.id) } : l)),
        day: selectedDay,
        date: requestedDate,
      },
    };
  }

  // ── BRANCH B — today / tomorrow dashboard (TeacherHome) ──
  const istNow = new Date(Date.now() + IST_OFFSET);
  const istTomorrow = new Date(istNow.getTime() + 24 * 60 * 60 * 1000);

  const today = DAY_NAMES[istNow.getUTCDay()];
  const tomorrow = DAY_NAMES[istTomorrow.getUTCDay()];
  const todayDateStr = istDateString(istNow);
  const tomorrowStr = istDateString(istTomorrow);
  const currentMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();

  const [lectureSnap, tempTodaySnap, tempTomorrowSnap, cancelledSnap] = await Promise.all([
    db.collection("lectures")
      .where("teacher_id", "==", teacher_id)
      .where("aishe_code", "==", aishe_code)
      .where("day", "in", [today, tomorrow])
      .get(),
    tempSessionsQuery(teacher_id, todayDateStr),
    tempSessionsQuery(teacher_id, tomorrowStr),
    db.collection("cancelled_lectures")
      .where("teacher_id", "==", teacher_id)
      .where("date", "in", [todayDateStr, tomorrowStr])
      .select("lecture_id")
      .get(),
  ]);

  const regularLectures = lectureSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const [tempTodayLectures, tempTomorrowLectures] = await Promise.all([
    enrichTempSessions(tempTodaySnap.docs),
    enrichTempSessions(tempTomorrowSnap.docs),
  ]);

  const cancelledIds = cancelledSnap.docs.map((d) => d.data().lecture_id);
  const [mToday, mTomorrow] = await Promise.all([swapMarksFor(teacher_id, todayDateStr), swapMarksFor(teacher_id, tomorrowStr)]);
  mToday.forEach((m, id) => { if (m.swapped_out) cancelledIds.push(id); });
  mTomorrow.forEach((m, id) => { if (m.swapped_out) cancelledIds.push(id); });
  const regularIds = new Set(regularLectures.map((l) => l.id));

  const todayLectures = [
    ...regularLectures.filter((l) => l.day === today && !cancelledIds.includes(l.id)),
    ...tempTodayLectures.filter((t) => !cancelledIds.includes(t.id) && !regularIds.has(t.id)),
  ].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));

  const tomorrowLectures = [
    ...regularLectures.filter((l) => l.day === tomorrow && !cancelledIds.includes(l.id)),
    ...tempTomorrowLectures.filter((t) => !cancelledIds.includes(t.id) && !regularIds.has(t.id)),
  ].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));

  let ongoingLecture = null;
  let nextLecture = null;
  for (const lecture of todayLectures) {
    const start = toMinutes(lecture.start_time);
    const end = toMinutes(lecture.end_time);
    if (currentMinutes >= start && currentMinutes < end) ongoingLecture = lecture;
    if (!nextLecture && start > currentMinutes) nextLecture = lecture;
  }
  if (!nextLecture && tomorrowLectures.length > 0) nextLecture = tomorrowLectures[0];

  return { code: 200, body: { success: true, ongoingLecture, nextLecture, today: todayDateStr } };
}

router.get("/today", readLimit, guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const uid = req.query.uid || req.auth?.uid;
    const requestedDate = req.query.date;
    if (typeof uid !== "string" || !uid) return res.status(400).json({ error: "Teacher uid required" });
    if (requestedDate !== undefined && (typeof requestedDate !== "string" || !YMD.test(requestedDate))) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }

    const r = await todayCache.memo(`${uid}|${requestedDate || ""}`, 3_000, () => buildTodayResponse(uid, requestedDate));
    return res.status(r.code).json(r.body);
  } catch (error) {
    console.error("LECTURE FETCH ERROR:", error);
    return res.status(500).json({ error: "Failed to fetch lectures" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /cancel
   ═══════════════════════════════════════════════════════════════════════════ */

router.post("/cancel", guard.self(fromBody("teacher_uid")), async (req, res) => {
  try {
    const { lecture_id, teacher_uid, date } = req.body;

    if (!lecture_id || !teacher_uid || !date || typeof lecture_id !== "string" || typeof teacher_uid !== "string" || typeof date !== "string") {
      return res.status(400).json({ success: false, error: "lecture_id, teacher_uid, date required" });
    }

    const teacher = await getTeacherByUid(teacher_uid);
    if (!teacher) return res.status(404).json({ success: false, error: "Teacher profile not found" });
    const teacher_id = teacher.id;

    if (req.auth) {
      const lecture = await getLecture(lecture_id);
      if (!allow(req, res, await teacherCoversLecture(teacher_id, lecture_id, lecture, date), "cancel-own-lecture")) return;
    }

    // check + insert in ONE transaction -> a double tap can no longer create two cancellations
    const created = await db.runTransaction(async (tx) => {
      const existing = await tx.get(
        db.collection("cancelled_lectures").where("lecture_id", "==", lecture_id).where("date", "==", date).limit(1)
      );
      if (!existing.empty) return false;
      tx.create(db.collection("cancelled_lectures").doc(), {
        lecture_id,
        teacher_id,
        date,
        created_at: FV.serverTimestamp(),
      });
      return true;
    });

    todayCache.delPrefix(`${teacher_uid}|`);

    if (!created) return res.json({ success: false, message: "Lecture already cancelled" });
    return res.json({ success: true, message: "Lecture cancelled successfully" });
  } catch (error) {
    console.error("CANCEL ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to cancel lecture" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /teachers/available
   ═══════════════════════════════════════════════════════════════════════════ */

async function teachersOfCollege(aishe_code) {
  return teacherListCache.memo(`t:${aishe_code}`, 30_000, async () => {
    const snap = await db
      .collection("teachers")
      .where("aishe_code", "==", aishe_code)
      .select("name", "full_name", "first_name", "last_name", "designation", "department", "departments")
      .get();
    return snap.docs.map((d) => ({ id: d.id, d: d.data() }));
  });
}

router.get("/teachers/available", readLimit, guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const { uid, date, start_time, end_time, lecture_id } = req.query;

    if (!uid || !date || !start_time || !end_time) {
      return res.status(400).json({ success: false, error: "uid, date, start_time, end_time required" });
    }
    if (typeof uid !== "string" || typeof date !== "string" || !date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return res.status(400).json({ success: false, error: "date must be YYYY-MM-DD" });
    }
    if (typeof start_time !== "string" || typeof end_time !== "string") {
      return res.status(400).json({ success: false, error: "uid, date, start_time, end_time required" });
    }

    const requester = await getTeacherByUid(uid);
    if (!requester) return res.status(404).json({ success: false, error: "Teacher not found" });

    const { aishe_code } = requester.data;
    const requester_id = requester.id;
    const day = getDayNameFromDate(date);

    const [allTeachers, busyIds] = await Promise.all([
      teachersOfCollege(aishe_code),
      getBusyTeacherIds({ aishe_code, date, start_time, end_time, day, exclude_lecture_id: typeof lecture_id === "string" ? lecture_id : null }),
    ]);

    const available = [];
    for (const { id, d } of allTeachers) {
      if (id === requester_id) continue;
      if (busyIds.has(id)) continue;
      const name =
        d.name ||
        d.full_name ||
        (d.first_name ? `${d.first_name} ${d.last_name || ""}`.trim() : null) ||
        "Unknown";
      available.push({
        id,
        name,
        designation: d.designation || "",
        department: d.department || (Array.isArray(d.departments) ? d.departments[0] : "") || "",
      });
    }

    return res.json({ success: true, available });
  } catch (error) {
    console.error("AVAILABLE TEACHERS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch available teachers" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /assign
   ═══════════════════════════════════════════════════════════════════════════ */

const assigning = new Set(); // "<lecture_id>|<date>" currently being assigned by this process

router.post("/assign", guard.self(fromBody("uid")), async (req, res) => {
  try {
    const { uid, lecture_id, assigned_teacher_id, date, start_time, end_time } = req.body;

    if (!uid || !lecture_id || !assigned_teacher_id || !date || !start_time || !end_time) {
      return res.status(400).json({
        success: false,
        error: "uid, lecture_id, assigned_teacher_id, date, start_time, end_time required",
      });
    }
    if (![uid, lecture_id, assigned_teacher_id, date, start_time, end_time].every((v) => typeof v === "string") || !YMD.test(date) || !isId(assigned_teacher_id)) {
      return res.status(400).json({
        success: false,
        error: "uid, lecture_id, assigned_teacher_id, date, start_time, end_time required",
      });
    }

    const original = await getTeacherByUid(uid);
    if (!original) return res.status(404).json({ success: false, error: "Requesting teacher not found" });

    const original_teacher_id = original.id;
    const { aishe_code } = original.data;
    if (!aishe_code) {
      return res.status(400).json({ success: false, error: "Teacher profile incomplete: missing aishe_code" });
    }

    const day = getDayNameFromDate(date);

    if (await lectureInActiveSwap(lecture_id, date)) {
      return res.status(409).json({ success: false, error: "This lecture is part of a lecture exchange" });
    }

    // ownership: the lecture must be the requester's own (or one he accepted for that date),
    // and the target teacher must work at the same college
    const [lecture, assignedTeacher] = await Promise.all([getLecture(lecture_id), getTeacherById(assigned_teacher_id)]);
    if (req.auth) {
      if (!allow(req, res, await teacherCoversLecture(original_teacher_id, lecture_id, lecture, date), "assign-own-lecture")) return;
      if (!allow(req, res, !assignedTeacher || assignedTeacher.aishe_code === aishe_code, "assign-same-college")) return;
    }

    // Server-side re-validation — never trust the frontend
    const busyIds = await getBusyTeacherIds({ aishe_code, date, start_time, end_time, day });
    if (busyIds.has(assigned_teacher_id)) {
      return res.status(409).json({ success: false, error: "Teacher is no longer available for this slot" });
    }

    const expires_at = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const assignmentRef = db.collection("lecture_assignments").doc();

    // same lecture+date being assigned right now by another request of this process -> it would be a duplicate
    const lockKey = `${lecture_id}|${date}`;
    if (assigning.has(lockKey)) throw new Error("ALREADY_ASSIGNED");
    assigning.add(lockKey);

    // duplicate guard + write in ONE transaction (the original ran the query outside the transaction)
    try {
    await db.runTransaction(async (tx) => {
      const dupSnap = await tx.get(
        db.collection("lecture_assignments")
          .where("lecture_id", "==", lecture_id)
          .where("date", "==", date)
          .where("status", "in", ["pending", "accepted"])
          .limit(1)
      );
      if (!dupSnap.empty) throw new Error("ALREADY_ASSIGNED");

      tx.set(assignmentRef, {
        lecture_id,
        original_teacher_id,
        assigned_teacher_id,
        aishe_code,
        date,
        day,
        start_time,
        end_time,
        status: "pending",
        expires_at,
        created_at: FV.serverTimestamp(),
      });
    });
    } finally {
      assigning.delete(lockKey);
    }

    listCache.clear();

    res.json({ success: true, assignment_id: assignmentRef.id, message: "Assignment request sent" });

    if (assignedTeacher) {
      safeNotify({
        userIds: [assignedTeacher.user_id],
        title: "📋 Lecture Assignment Request",
        body: `You have a new lecture request for ${date} at ${start_time}`,
        data: { screen: "TeacherHome" },
      });
    }
  } catch (error) {
    if (error.message === "ALREADY_ASSIGNED") {
      return res.status(409).json({ success: false, error: "An active request for this lecture already exists" });
    }
    console.error("ASSIGN ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to create assignment" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /assign/respond
   ═══════════════════════════════════════════════════════════════════════════ */

const notActiveMessage = (status) => (status === "accepted" ? "Already accepted" : "Assignment no longer active");

router.post("/assign/respond", guard.self(fromBody("uid")), async (req, res) => {
  try {
    const { uid, assignment_id, action } = req.body;

    if (!uid || !assignment_id || !["accept", "reject"].includes(action) || typeof uid !== "string" || !isId(assignment_id)) {
      return res.status(400).json({
        success: false,
        error: "uid, assignment_id, and action (accept|reject) required",
      });
    }

    const responder = await getTeacherByUid(uid);
    if (!responder) return res.status(404).json({ success: false, error: "Teacher not found" });

    const respondingTeacherId = responder.id;
    const assignmentRef = db.collection("lecture_assignments").doc(assignment_id);

    /* ---- REJECT ---- */
    if (action === "reject") {
      const pre = await assignmentRef.get();
      if (!pre.exists) return res.status(404).json({ success: false, error: "Assignment not found" });
      if (!allow(req, res, pre.data().assigned_teacher_id === respondingTeacherId, "assign-respond-owner")) return;

      // only a PENDING request can be rejected (the original could flip an accepted one to "rejected")
      const outcome = await db.runTransaction(async (tx) => {
        const cur = await tx.get(assignmentRef);
        if (!cur.exists) return { code: 404, error: "Assignment not found" };
        if (cur.data().status !== "pending") return { code: 409, error: notActiveMessage(cur.data().status) };
        tx.update(assignmentRef, { status: "rejected", responded_at: FV.serverTimestamp() });
        return null;
      });
      if (outcome) return res.status(outcome.code).json({ success: false, error: outcome.error });

      listCache.clear();
      return res.json({ success: true, message: "Assignment rejected" });
    }

    /* ---- ACCEPT ---- */
    const assignmentDoc = await assignmentRef.get();
    if (!assignmentDoc.exists) return res.status(404).json({ success: false, error: "Assignment not found" });

    const assignment = assignmentDoc.data();

    if (assignment.assigned_teacher_id !== respondingTeacherId) {
      return res.status(403).json({ success: false, error: "Not your assignment" });
    }
    if (assignment.status !== "pending") {
      return res.status(409).json({ success: false, error: notActiveMessage(assignment.status) });
    }
    if (tsMs(assignment.expires_at) < Date.now()) {
      return res.status(410).json({ success: false, error: "Assignment request has expired" });
    }

    // Re-validate — exclude the lecture being accepted so the teacher's own coverage of that slot isn't a conflict
    const busyIds = await getBusyTeacherIds({
      aishe_code: assignment.aishe_code,
      date: assignment.date,
      start_time: assignment.start_time,
      end_time: assignment.end_time,
      day: assignment.day,
      exclude_lecture_id: assignment.lecture_id,
    });
    if (busyIds.has(respondingTeacherId)) {
      return res.status(409).json({ success: false, error: "You have a conflicting lecture at this time" });
    }

    // accept + temp session + expire the other pending requests - atomically, re-checking status
    const sessionRef = db.collection("lecture_sessions").doc();
    const outcome = await db.runTransaction(async (tx) => {
      const cur = await tx.get(assignmentRef);
      if (!cur.exists || cur.data().status !== "pending") {
        return { code: 409, error: notActiveMessage(cur.exists ? cur.data().status : null) };
      }
      const others = await tx.get(
        db.collection("lecture_assignments")
          .where("lecture_id", "==", assignment.lecture_id)
          .where("date", "==", assignment.date)
          .where("status", "==", "pending")
      );

      tx.update(assignmentRef, {
        status: "accepted",
        session_id: sessionRef.id,
        responded_at: FV.serverTimestamp(),
      });
      tx.set(sessionRef, {
        lecture_id: assignment.lecture_id,
        teacher_id: respondingTeacherId,
        original_teacher_id: assignment.original_teacher_id,
        assignment_id,
        aishe_code: assignment.aishe_code,
        date: assignment.date,
        day: assignment.day,
        start_time: assignment.start_time,
        end_time: assignment.end_time,
        is_temporary: true,
        is_live: false,
        status: "scheduled",
        created_at: FV.serverTimestamp(),
      });
      others.docs.forEach((doc) => {
        if (doc.id !== assignment_id) tx.update(doc.ref, { status: "expired" });
      });
      return null;
    });
    if (outcome) return res.status(outcome.code).json({ success: false, error: outcome.error });

    listCache.clear();
    todayCache.delPrefix(`${uid}|`);

    res.json({
      success: true,
      session_id: sessionRef.id,
      message: "Assignment accepted. Lecture added to your schedule.",
    });

    const orig = await getTeacherById(assignment.original_teacher_id);
    if (orig) {
      safeNotify({
        userIds: [orig.user_id],
        title: " Lecture Accepted",
        body: `Your lecture for ${assignment.date} has been accepted`,
        data: { screen: "TeacherHome" },
      });
    }
  } catch (error) {
    console.error("RESPOND ASSIGNMENT ERROR:", error);
    if (!res.headersSent) return res.status(500).json({ success: false, error: "Failed to respond to assignment" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /assign/requests , GET /assign/sent
   ═══════════════════════════════════════════════════════════════════════════ */

router.get("/assign/requests", readLimit, guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid || typeof uid !== "string") return res.status(400).json({ success: false, error: "uid required" });

    const teacher = await getTeacherByUid(uid);
    if (!teacher) return res.status(404).json({ success: false, error: "Teacher not found" });
    const teacher_id = teacher.id;

    const requests = await listCache.memo(`req:${teacher_id}`, 3_000, async () => {
      // equality-only query (no composite index); expiry filter + sort in memory
      const snap = await db
        .collection("lecture_assignments")
        .where("assigned_teacher_id", "==", teacher_id)
        .where("status", "==", "pending")
        .select("lecture_id", "date", "day", "start_time", "end_time", "original_teacher_id", "expires_at")
        .get();

      const nowMs = Date.now();
      const docs = snap.docs
        .filter((doc) => doc.data().expires_at && tsMs(doc.data().expires_at) > nowMs)
        .sort((a, b) => tsMs(a.data().expires_at) - tsMs(b.data().expires_at));

      if (docs.length === 0) return [];

      const names = await getDocsByIds("teachers", docs.map((d) => d.data().original_teacher_id), ["name", "full_name"]);
      const nameMap = {};
      names.forEach((doc, id) => {
        const d = doc.data();
        nameMap[id] = d.name || d.full_name || "Unknown";
      });

      return docs.map((doc) => {
        const d = doc.data();
        return {
          assignment_id: doc.id,
          lecture_id: d.lecture_id,
          date: d.date,
          day: d.day,
          start_time: d.start_time,
          end_time: d.end_time,
          requested_by: nameMap[d.original_teacher_id] || "Unknown",
          expires_at: d.expires_at.toDate().toISOString(),
        };
      });
    });

    return res.json({ success: true, requests });
  } catch (error) {
    console.error("FETCH REQUESTS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch requests" });
  }
});

router.get("/assign/sent", readLimit, guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid || typeof uid !== "string") return res.status(400).json({ success: false, error: "uid required" });

    const teacher = await getTeacherByUid(uid);
    if (!teacher) return res.status(404).json({ success: false, error: "Teacher not found" });
    const teacher_id = teacher.id;

    const assignments = await listCache.memo(`sent:${teacher_id}`, 3_000, async () => {
      const sentSnap = await db
        .collection("lecture_assignments")
        .where("original_teacher_id", "==", teacher_id)
        .where("status", "in", ["pending", "accepted", "rejected", "expired"])
        .select("lecture_id", "date", "day", "start_time", "end_time", "status", "expires_at", "created_at")
        .get();

      // only the last 48 hours, to keep the list small
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;

      return sentSnap.docs
        .filter((doc) => (doc.data().created_at?.toDate?.()?.getTime?.() || 0) >= cutoff)
        .map((doc) => {
          const d = doc.data();
          return {
            assignment_id: doc.id,
            lecture_id: d.lecture_id,
            date: d.date,
            day: d.day,
            start_time: d.start_time,
            end_time: d.end_time,
            status: d.status,
            expires_at: d.expires_at?.toDate?.()?.toISOString?.() || null,
            created_at: d.created_at?.toDate?.()?.toISOString?.() || null,
          };
        });
    });

    return res.json({ success: true, assignments });
  } catch (error) {
    console.error("FETCH SENT ASSIGNMENTS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch sent assignments" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   LECTURE EXCHANGE (same date)
   Teacher A gives lecture L to teacher B and takes B's lecture P on the same date.
   One `lecture_swaps` document; on acceptance two temporary sessions are created
   (B covers L, A covers P), exactly like an accepted /assign.
   POST /swap/candidates-free  GET /swap/candidates   POST /swap   POST /swap/respond   GET /swap/mine
   ═══════════════════════════════════════════════════════════════════════════ */

const SWAP_ACTIVE = ["pending", "accepted"];
const swapping = new Set(); // lecture ids being swapped right now by this process

/** start of a lecture on `date` as an epoch (IST) */
const istEpoch = (date, hhmm) => Date.parse(`${date}T${String(hhmm).padStart(5, "0")}:00+05:30`);
const swapNotPast = (date, start) => istEpoch(date, start) > Date.now();
const swapLive = (s) => s.status === "accepted" || (s.status === "pending" && (!s.expires_at || tsMs(s.expires_at) > Date.now()));

const teacherName = (d) => (d && (d.name || d.full_name || (d.first_name ? `${d.first_name} ${d.last_name || ""}`.trim() : ""))) || "Teacher";

/** everything that decides who is busy / which lectures can still be exchanged on one date */
async function loadSwapDay(aishe_code, date) {
  const day = getDayNameFromDate(date);
  const [lecSnap, sessSnap, cancSnap, asgSnap, swapSnap] = await Promise.all([
    db.collection("lectures").where("aishe_code", "==", aishe_code).where("day", "==", day).get(),
    db.collection("lecture_sessions").where("aishe_code", "==", aishe_code).where("date", "==", date).where("is_temporary", "==", true).get(),
    db.collection("cancelled_lectures").where("date", "==", date).select("lecture_id").get(),
    db.collection("lecture_assignments").where("aishe_code", "==", aishe_code).where("date", "==", date).get(),
    db.collection("lecture_swaps").where("aishe_code", "==", aishe_code).where("date", "==", date).get(),
  ]);

  const lectures = lecSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const cancelled = new Set(cancSnap.docs.map((d) => d.data().lecture_id));
  const handed = new Set(cancelled); // lectures their owner no longer teaches on this date
  const locked = new Set(cancelled); // lectures that must not enter a new request

  const intervals = [];
  asgSnap.docs.forEach((d) => {
    const a = d.data();
    if (a.status === "accepted") { handed.add(a.lecture_id); locked.add(a.lecture_id); }
    else if (a.status === "pending" && (!a.expires_at || tsMs(a.expires_at) > Date.now())) {
      locked.add(a.lecture_id);
      intervals.push({ teacher: a.assigned_teacher_id, lid: a.lecture_id, s: a.start_time, e: a.end_time });
    }
  });
  swapSnap.docs.forEach((d) => {
    const s = d.data();
    if (!swapLive(s)) return;
    locked.add(s.requester_lecture_id);
    locked.add(s.partner_lecture_id);
    if (s.status === "accepted") { handed.add(s.requester_lecture_id); handed.add(s.partner_lecture_id); }
    else {
      intervals.push({ teacher: s.partner_teacher_id, lid: s.requester_lecture_id, s: s.requester_start, e: s.requester_end });
      intervals.push({ teacher: s.requester_teacher_id, lid: s.partner_lecture_id, s: s.partner_start, e: s.partner_end });
    }
  });
  lectures.forEach((l) => {
    if (!handed.has(l.id)) intervals.push({ teacher: l.teacher_id, lid: l.id, s: l.start_time, e: l.end_time });
  });
  sessSnap.docs.forEach((d) => {
    const s = d.data();
    intervals.push({ teacher: s.teacher_id, lid: s.lecture_id, s: s.start_time, e: s.end_time });
  });

  const free = (teacher, start, end, ignore = []) =>
    !intervals.some((x) => x.teacher === teacher && !ignore.includes(x.lid) && hasOverlap(start, end, x.s, x.e));

  return { day, lectures, handed, locked, free };
}

/** can lecture `a` (owned by A) and `b` (owned by B) be exchanged? returns an error string or null */
function swapProblem(dayData, date, a, b) {
  if (!a || !b) return "Lecture not found";
  if (a.teacher_id === b.teacher_id) return "Pick a lecture of another teacher";
  if (a.aishe_code !== b.aishe_code) return "Both lectures must be in the same college";
  if (a.day !== dayData.day || b.day !== dayData.day) return "Both lectures must be on the selected day";
  if (dayData.locked.has(a.id)) return "Your lecture already has a request, cover or cancellation for this date";
  if (dayData.locked.has(b.id)) return "That lecture already has a request or a cover for this date";
  if (!swapNotPast(date, a.start_time) || !swapNotPast(date, b.start_time)) return "A lecture that has already started cannot be exchanged";
  if (!dayData.free(a.teacher_id, b.start_time, b.end_time, [a.id, b.id])) return "You are busy at the time of that lecture";
  if (!dayData.free(b.teacher_id, a.start_time, a.end_time, [a.id, b.id])) return "That teacher is busy at the time of your lecture";
  return null;
}

/** a lecture has an active request/cover of any kind on `date`? (used by /assign) */
async function lectureInActiveSwap(lecture_id, date) {
  const snap = await db.collection("lecture_swaps").where("lecture_ids", "array-contains", lecture_id).get();
  return snap.docs.some((d) => d.data().date === date && swapLive(d.data()));
}

router.get("/swap/candidates", readLimit, guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const { uid, date, lecture_id } = req.query;
    if (typeof uid !== "string" || typeof date !== "string" || !YMD.test(date) || !isId(lecture_id)) {
      return res.status(400).json({ success: false, error: "uid, date, lecture_id required" });
    }
    const me = await getTeacherByUid(uid);
    if (!me) return res.status(404).json({ success: false, error: "Teacher not found" });
    const { aishe_code } = me.data;
    if (!aishe_code) return res.status(400).json({ success: false, error: "Teacher profile incomplete" });

    const dayData = await loadSwapDay(aishe_code, date);
    const mine = dayData.lectures.find((l) => l.id === lecture_id);
    if (!mine || mine.teacher_id !== me.id) return res.status(404).json({ success: false, error: "That is not your lecture on this day" });
    if (dayData.locked.has(mine.id)) return res.json({ success: true, teachers: [], reason: "This lecture already has a request, cover or cancellation." });
    if (!swapNotPast(date, mine.start_time)) return res.json({ success: true, teachers: [], reason: "This lecture has already started." });

    const byTeacher = new Map();
    for (const l of dayData.lectures) {
      if (swapProblem(dayData, date, mine, l)) continue;
      if (!byTeacher.has(l.teacher_id)) byTeacher.set(l.teacher_id, []);
      byTeacher.get(l.teacher_id).push(l);
    }
    if (!byTeacher.size) return res.json({ success: true, teachers: [] });

    const tdocs = await getDocsByIds("teachers", [...byTeacher.keys()]);
    const courseIds = [...new Set([...byTeacher.values()].flat().map((l) => l.course_id).filter(Boolean))];
    const abbr = {};
    await Promise.all(courseIds.map(async (c) => { const x = await getCourse(c); if (x) abbr[c] = x.abbr || ""; }));

    const teachers = [...byTeacher.entries()].map(([tid, ls]) => {
      const td = tdocs.get(tid) ? tdocs.get(tid).data() : {};
      return {
        id: tid,
        name: teacherName(td),
        department: td.department || (Array.isArray(td.departments) ? td.departments[0] : "") || "",
        lectures: ls
          .sort((a, b) => toMin(a.start_time) - toMin(b.start_time))
          .map((l) => ({ id: l.id, subject_name: l.subject_name || "Lecture", course_abbr: abbr[l.course_id] || "", room: l.room || "", start_time: l.start_time, end_time: l.end_time })),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ success: true, teachers });
  } catch (error) {
    console.error("SWAP CANDIDATES ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to find teachers to exchange with" });
  }
});

router.post("/swap", guard.self(fromBody("uid")), async (req, res) => {
  const locks = [];
  try {
    const { uid, lecture_id, partner_lecture_id, date } = req.body || {};
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 200) : "";
    if (typeof uid !== "string" || typeof date !== "string" || !YMD.test(date) || !isId(lecture_id) || !isId(partner_lecture_id)) {
      return res.status(400).json({ success: false, error: "uid, lecture_id, partner_lecture_id, date required" });
    }
    const me = await getTeacherByUid(uid);
    if (!me) return res.status(404).json({ success: false, error: "Teacher not found" });
    const { aishe_code } = me.data;
    if (!aishe_code) return res.status(400).json({ success: false, error: "Teacher profile incomplete" });

    const dayData = await loadSwapDay(aishe_code, date);
    const a = dayData.lectures.find((l) => l.id === lecture_id);
    const b = dayData.lectures.find((l) => l.id === partner_lecture_id);
    if (!a || a.teacher_id !== me.id) return res.status(403).json({ success: false, error: "That is not your lecture on this day" });
    const problem = swapProblem(dayData, date, a, b);
    if (problem) return res.status(409).json({ success: false, error: problem });

    for (const id of [a.id, b.id]) {
      if (swapping.has(id)) return res.status(409).json({ success: false, error: "An exchange for this lecture is being created. Try again." });
    }
    [a.id, b.id].forEach((id) => { swapping.add(id); locks.push(id); });

    const partnerData = await getTeacherById(b.teacher_id);
    const earliest = Math.min(istEpoch(date, a.start_time), istEpoch(date, b.start_time));
    const expiresMs = Math.min(Date.now() + 24 * 60 * 60 * 1000, earliest);
    const ref = db.collection("lecture_swaps").doc();

    const outcome = await db.runTransaction(async (tx) => {
      // nobody else may have a live request on either lecture meanwhile
      for (const id of [a.id, b.id]) {
        const s1 = await tx.get(db.collection("lecture_swaps").where("lecture_ids", "array-contains", id));
        if (s1.docs.some((d) => d.data().date === date && swapLive(d.data()))) return "That lecture just got another exchange request";
        const s2 = await tx.get(db.collection("lecture_assignments").where("lecture_id", "==", id));
        if (s2.docs.some((d) => d.data().date === date && (d.data().status === "accepted" || (d.data().status === "pending" && tsMs(d.data().expires_at) > Date.now())))) {
          return "That lecture just got a cover request";
        }
      }
      tx.set(ref, {
        aishe_code, date, day: dayData.day, status: "pending",
        lecture_ids: [a.id, b.id],
        requester_teacher_id: me.id, requester_user_id: me.data.user_id || uid, requester_name: teacherName(me.data),
        requester_lecture_id: a.id, requester_subject: a.subject_name || "Lecture", requester_start: a.start_time, requester_end: a.end_time,
        partner_teacher_id: b.teacher_id, partner_user_id: partnerData?.user_id || null, partner_name: teacherName(partnerData),
        partner_lecture_id: b.id, partner_subject: b.subject_name || "Lecture", partner_start: b.start_time, partner_end: b.end_time,
        reason,
        expires_at: admin.firestore.Timestamp.fromDate(new Date(expiresMs)),
        created_at: FV.serverTimestamp(),
      });
      return null;
    });
    if (outcome) return res.status(409).json({ success: false, error: outcome });

    listCache.clear();
    todayCache.delPrefix(`${uid}|`);
    res.json({ success: true, swap_id: ref.id, message: "Exchange request sent" });

    if (partnerData?.user_id) {
      safeNotify({
        userIds: [partnerData.user_id],
        title: "Lecture exchange request",
        body: `${teacherName(me.data)} wants to exchange lectures on ${date}: your ${b.start_time} for their ${a.start_time}`,
        data: { screen: "TeacherHome" },
      });
    }
  } catch (error) {
    console.error("SWAP CREATE ERROR:", error);
    if (!res.headersSent) res.status(500).json({ success: false, error: "Failed to send the exchange request" });
  } finally {
    locks.forEach((id) => swapping.delete(id));
  }
});

router.post("/swap/respond", guard.self(fromBody("uid")), async (req, res) => {
  try {
    const { uid, swap_id, action } = req.body || {};
    if (typeof uid !== "string" || !isId(swap_id) || !["accept", "reject", "cancel"].includes(action)) {
      return res.status(400).json({ success: false, error: "uid, swap_id and action (accept|reject|cancel) required" });
    }
    const me = await getTeacherByUid(uid);
    if (!me) return res.status(404).json({ success: false, error: "Teacher not found" });

    const ref = db.collection("lecture_swaps").doc(swap_id);
    const pre = await ref.get();
    if (!pre.exists) return res.status(404).json({ success: false, error: "Exchange request not found" });
    const sw = pre.data();

    const isPartner = sw.partner_teacher_id === me.id;
    const isRequester = sw.requester_teacher_id === me.id;
    if (action === "cancel" ? !isRequester : !isPartner) {
      return res.status(403).json({ success: false, error: "Not your exchange request" });
    }

    const notify_ = (user_id, title, body) => user_id && safeNotify({ userIds: [user_id], title, body, data: { screen: "TeacherHome" } });
    const bust = () => {
      listCache.clear();
      todayCache.delPrefix(`${sw.requester_user_id}|`);
      todayCache.delPrefix(`${sw.partner_user_id}|`);
      todayCache.delPrefix(`${uid}|`);
    };

    if (action === "reject" || action === "cancel") {
      const to = action === "reject" ? "rejected" : "cancelled";
      const bad = await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        if (!cur.exists || cur.data().status !== "pending") return cur.exists ? (cur.data().status === "accepted" ? "Already accepted" : "Request no longer active") : "Not found";
        tx.update(ref, { status: to, responded_at: FV.serverTimestamp() });
        return null;
      });
      if (bad) return res.status(409).json({ success: false, error: bad });
      bust();
      res.json({ success: true, message: action === "reject" ? "Exchange declined" : "Exchange request cancelled" });
      if (action === "reject") notify_(sw.requester_user_id, "Exchange declined", `${teacherName(me.data)} declined the exchange on ${sw.date}`);
      else notify_(sw.partner_user_id, "Exchange cancelled", `${sw.requester_name} cancelled the exchange request for ${sw.date}`);
      return;
    }

    /* accept */
    if (sw.status !== "pending") return res.status(409).json({ success: false, error: sw.status === "accepted" ? "Already accepted" : "Request no longer active" });
    if (tsMs(sw.expires_at) <= Date.now()) return res.status(410).json({ success: false, error: "This request has expired" });

    // re-check the world: both lectures must still exchange cleanly (this request's own hold is ignored)
    const dayData = await loadSwapDay(sw.aishe_code, sw.date);
    dayData.locked.delete(sw.requester_lecture_id);
    dayData.locked.delete(sw.partner_lecture_id);
    const a = dayData.lectures.find((l) => l.id === sw.requester_lecture_id);
    const b = dayData.lectures.find((l) => l.id === sw.partner_lecture_id);
    const problem = swapProblem(dayData, sw.date, a, b);
    if (problem) return res.status(409).json({ success: false, error: problem });

    const sRef1 = db.collection("lecture_sessions").doc(); // partner covers requester's lecture
    const sRef2 = db.collection("lecture_sessions").doc(); // requester covers partner's lecture
    const bad = await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists || cur.data().status !== "pending") return "Request no longer active";
      const others = [];
      for (const id of [sw.requester_lecture_id, sw.partner_lecture_id]) {
        const s2 = await tx.get(db.collection("lecture_assignments").where("lecture_id", "==", id));
        if (s2.docs.some((d) => d.data().date === sw.date && (d.data().status === "accepted" || (d.data().status === "pending" && tsMs(d.data().expires_at) > Date.now())))) {
          return "One of the lectures just got a cover request";
        }
        const s1 = await tx.get(db.collection("lecture_swaps").where("lecture_ids", "array-contains", id));
        s1.docs.forEach((d) => { if (d.id !== swap_id && d.data().date === sw.date && d.data().status === "pending") others.push(d.ref); });
      }
      const base = { aishe_code: sw.aishe_code, date: sw.date, day: sw.day, is_temporary: true, is_live: false, status: "scheduled", swap_id, created_at: FV.serverTimestamp() };
      tx.update(ref, { status: "accepted", session_ids: [sRef1.id, sRef2.id], responded_at: FV.serverTimestamp() });
      tx.set(sRef1, { ...base, lecture_id: sw.requester_lecture_id, teacher_id: sw.partner_teacher_id, original_teacher_id: sw.requester_teacher_id, start_time: sw.requester_start, end_time: sw.requester_end });
      tx.set(sRef2, { ...base, lecture_id: sw.partner_lecture_id, teacher_id: sw.requester_teacher_id, original_teacher_id: sw.partner_teacher_id, start_time: sw.partner_start, end_time: sw.partner_end });
      others.forEach((r) => tx.update(r, { status: "expired" }));
      return null;
    });
    if (bad) return res.status(409).json({ success: false, error: bad });

    bust();
    res.json({ success: true, message: "Exchange accepted. Both lectures are updated." });
    notify_(sw.requester_user_id, "Exchange accepted", `${teacherName(me.data)} accepted. On ${sw.date} you take ${sw.partner_subject} at ${sw.partner_start}; they take your ${sw.requester_start} lecture.`);
  } catch (error) {
    console.error("SWAP RESPOND ERROR:", error);
    if (!res.headersSent) res.status(500).json({ success: false, error: "Failed to respond to the exchange request" });
  }
});

/** incoming (waiting for me) and sent (last 48 h) exchange requests */
router.get("/swap/mine", readLimit, guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const { uid } = req.query;
    if (typeof uid !== "string" || !uid) return res.status(400).json({ success: false, error: "uid required" });
    const me = await getTeacherByUid(uid);
    if (!me) return res.status(404).json({ success: false, error: "Teacher not found" });

    const data = await listCache.memo(`swap:${me.id}`, 3_000, async () => {
      const [inSnap, outSnap] = await Promise.all([
        db.collection("lecture_swaps").where("partner_teacher_id", "==", me.id).where("status", "==", "pending").get(),
        db.collection("lecture_swaps").where("requester_teacher_id", "==", me.id).get(),
      ]);
      const iso = (t) => (t && t.toDate ? t.toDate().toISOString() : null);
      const shape = (d) => {
        const s = d.data();
        return {
          swap_id: d.id, date: s.date, day: s.day, status: s.status, reason: s.reason || "",
          requester_name: s.requester_name, partner_name: s.partner_name,
          give: { subject: s.requester_subject, start_time: s.requester_start, end_time: s.requester_end },
          take: { subject: s.partner_subject, start_time: s.partner_start, end_time: s.partner_end },
          expires_at: iso(s.expires_at), created_at: iso(s.created_at),
        };
      };
      const incoming = inSnap.docs.filter((d) => tsMs(d.data().expires_at) > Date.now())
        .sort((x, y) => tsMs(x.data().expires_at) - tsMs(y.data().expires_at)).map(shape);
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      const sent = outSnap.docs.filter((d) => (tsMs(d.data().created_at) || 0) >= cutoff)
        .map((d) => {
          const o = shape(d);
          if (o.status === "pending" && tsMs(d.data().expires_at) <= Date.now()) o.status = "expired";
          return o;
        })
        .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
      return { incoming, sent };
    });
    return res.json({ success: true, ...data });
  } catch (error) {
    console.error("SWAP MINE ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch exchange requests" });
  }
});

/** badges for /today: which of this teacher's lectures are given away / taken by an exchange on `date` */
async function swapMarksFor(teacher_id, date) {
  const [a, b] = await Promise.all([
    db.collection("lecture_swaps").where("requester_teacher_id", "==", teacher_id).where("date", "==", date).get(),
    db.collection("lecture_swaps").where("partner_teacher_id", "==", teacher_id).where("date", "==", date).get(),
  ]);
  const marks = new Map(); // lecture_id -> { out, pending, covering, with }
  const put = (id, v) => marks.set(id, { ...(marks.get(id) || {}), ...v });
  const add = (d, mineIsRequester) => {
    const s = d.data();
    if (!swapLive(s)) return;
    const give = mineIsRequester ? s.requester_lecture_id : s.partner_lecture_id;
    const take = mineIsRequester ? s.partner_lecture_id : s.requester_lecture_id;
    const other = mineIsRequester ? s.partner_name : s.requester_name;
    if (s.status === "accepted") {
      put(give, { swapped_out: true, swap_with: other });
      put(take, { swap_covering: true, swap_with: other });
    } else {
      put(give, { swap_pending: true, swap_with: other });
    }
  };
  a.docs.forEach((d) => add(d, true));
  b.docs.forEach((d) => add(d, false));
  return marks;
}

/* ═══════════════════════════════════════════════════════════════════════════
   GET /student/subjects , GET /teachers/subjects
   ═══════════════════════════════════════════════════════════════════════════ */

router.get("/student/subjects", readLimit, guard.selfOrTeacher(fromQuery("uid")), async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid || typeof uid !== "string") return res.status(400).json({ success: false, error: "uid required" });

    const student = await getStudentByUid(uid);
    if (!student) return res.status(404).json({ success: false, error: "Student not found" });

    const enrolledSubjects = Array.isArray(student.enrolled_subjects) ? student.enrolled_subjects.filter(isId) : [];
    if (enrolledSubjects.length === 0) return res.json({ success: true, subjects: [] });

    const subjects = await subjectsCache.memo(`stu:${uid}`, 10_000, async () => {
      // one batched read instead of sequential `in` queries.
      // (The original's `documentId() in [...]` returned docs ordered by id inside each chunk of 30 - kept.)
      const found = await getDocsByIds("subjects", enrolledSubjects);
      const subjectDocs = [];
      for (const part of chunk(enrolledSubjects, 30)) {
        for (const id of [...new Set(part)].sort()) {
          const snap = found.get(id);
          if (snap) subjectDocs.push({ id: snap.id, ...snap.data() });
        }
      }

      const uniqueCourseIds = [...new Set(subjectDocs.map((s) => s.course_id).filter(Boolean))];
      const courseMap = {};
      await Promise.all(
        uniqueCourseIds.map(async (cid) => {
          const c = await getCourse(cid);
          if (c) courseMap[cid] = c.course_name || "Unknown Course";
        })
      );

      return subjectDocs.map((s) => ({
        subject_id: s.id,
        subject_name: s.subject_name,
        subject_code: s.subject_code || null,
        course_id: s.course_id || null,
        course_name: s.course_id ? courseMap[s.course_id] || "Unknown Course" : "Unknown Course",
      }));
    });

    return res.json({ success: true, subjects });
  } catch (error) {
    console.error("STUDENT SUBJECTS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch subjects" });
  }
});

router.get("/teachers/subjects", readLimit, guard.teacherOnly, async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id || typeof teacher_id !== "string") return res.status(400).json({ error: "teacher_id required" });

    const subjects = await subjectsCache.memo(`tch:${teacher_id}`, 10_000, async () => {
      const snap = await db.collection("subjects").where("teacher_assigned", "==", teacher_id).get();
      if (snap.empty) return [];

      const uniqueCourseIds = [...new Set(snap.docs.map((d) => d.data().course_id).filter(Boolean))];
      const courseMap = {};
      await Promise.all(
        uniqueCourseIds.map(async (cid) => {
          const c = await getCourse(cid);
          if (c) courseMap[cid] = c.course_name || "Unknown Course";
        })
      );

      return snap.docs.map((doc) => {
        const data = doc.data();
        const cid = data.course_id || null;
        return {
          subject_id: doc.id,
          subject_name: data.subject_name,
          subject_code: data.subject_code,
          course_id: cid,
          course_name: cid ? courseMap[cid] || "Unknown Course" : "Unknown Course",
        };
      });
    });

    return res.json({ success: true, subjects });
  } catch (error) {
    console.error("FETCH TEACHER SUBJECTS ERROR:", error);
    res.status(500).json({ error: "Failed to fetch subjects" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /start , POST /stop
   ═══════════════════════════════════════════════════════════════════════════ */

router.post("/start", guard.teacher(fromBody("teacher_id")), async (req, res) => {
  try {
    const { lecture_id, teacher_id, subject_name, room, aishe_code, scheduled_start_time, scheduled_end_time } = req.body;

    if (!teacher_id || !subject_name || !aishe_code) {
      return res.status(400).json({ error: "Missing required lecture details" });
    }
    if (![teacher_id, subject_name, aishe_code].every((v) => typeof v === "string")) {
      return res.status(400).json({ error: "Missing required lecture details" });
    }

    // Resolve course_id from the lecture document for per-course filtering
    let course_id = null, division_id = null, division_name = null, subject_id = null, kind = null;
    if (lecture_id) {
      const lectureData = await getLecture(lecture_id);
      if (lectureData) {
        course_id = lectureData.course_id || null;
        division_id = lectureData.division_id || null;
        division_name = lectureData.division_name || null;
        subject_id = lectureData.subject_id || null;
        kind = lectureData.kind || null;           // "tutorial" | "lab" | null (plain lecture)
        if (req.auth) {
          const istDate = istDateString(new Date(Date.now() + IST_OFFSET));
          if (!allow(req, res, await teacherCoversLecture(teacher_id, lecture_id, lectureData, istDate), "start-own-lecture")) return;
        }
      }
    }

    const sessionData = {
      lecture_id: lecture_id || null,
      teacher_id,
      aishe_code,
      course_id,
      division_id,
      division_name,
      subject_id,
      kind,
      subject_name: String(subject_name).slice(0, 200),
      room: room ? String(room).slice(0, 100) : null,
      is_live: true,
      started_at: FV.serverTimestamp(),
      scheduled_start_time: scheduled_start_time || null,
      scheduled_end_time: scheduled_end_time || null,
      status: "ongoing",
      marking_status: "closed",
      marking_method: null,
      attendance_session_id: null,
    };

    const docRef = await db.collection("lecture_sessions").add(sessionData);
    dropLectureSession(docRef.id);

    res.status(201).json({ success: true, message: "Lecture started successfully", session_id: docRef.id });
  } catch (error) {
    console.error("START LECTURE ERROR:", error);
    res.status(500).json({ error: "Failed to start lecture session" });
  }
});

router.post("/stop", async (req, res) => {
  try {
    const { lecture_session_id } = req.body;
    if (!lecture_session_id) return res.status(400).json({ error: "Missing lecture_session_id" });
    if (!isId(lecture_session_id)) return res.status(404).json({ error: "Lecture session not found" });

    const sessionRef = db.collection("lecture_sessions").doc(lecture_session_id);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) return res.status(404).json({ error: "Lecture session not found" });

    const sessionData = sessionDoc.data();
    if (!allow(req, res, await callerOwnsLectureSession(req, sessionData), "stop-own-session")) return;

    // make sure the coalesced present_students writes are in before the session closes
    await Promise.all([presentWriter.flushAll(), pendingWriter.flushAll(), unpendWriter.flushAll()]).catch(() => {});

    const batch = db.batch();
    batch.update(sessionRef, {
      is_live: false,
      ended_at: FV.serverTimestamp(),
      status: "completed",
      marking_status: "closed",
    });

    if (sessionData.attendance_session_id) {
      const attRef = db.collection("attendance_sessions").doc(sessionData.attendance_session_id);
      const attDoc = await attRef.get();
      if (attDoc.exists && attDoc.data().marking_status === "open") {
        batch.update(attRef, { marking_status: "closed", ended_at: FV.serverTimestamp() });
      }
    }

    await batch.commit();

    // students must see "closed" immediately (the original left the 5-minute cache saying "open")
    dropAttendanceSession(sessionData.attendance_session_id);
    dropLectureSession(lecture_session_id);

    res.json({ success: true, message: "Lecture stopped successfully" });
  } catch (error) {
    console.error("STOP LECTURE ERROR:", error);
    res.status(500).json({ error: "Failed to stop lecture session" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /student/today   (polled by every student's home screen)
   ═══════════════════════════════════════════════════════════════════════════ */

async function liveSessionsFor(aishe_code) {
  return liveSessionsCache.memo(`live:${aishe_code}`, 2_000, async () => {
    const snap = await db
      .collection("lecture_sessions")
      .where("aishe_code", "==", aishe_code)
      .where("is_live", "==", true)
      .get();
    return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  });
}

/* ── elective subjects: a student only sees / marks / is counted for the option they chose ── */
async function electiveSubjectIds(course_id) {
  if (!course_id) return new Set();
  const ids = await timetableCache.memo(`elec:${course_id}`, 60_000, async () => {
    const snap = await db.collection("subjects").where("course_id", "==", course_id).where("compulsary", "==", false).select().get();
    return snap.docs.map((d) => d.id);
  });
  return new Set(ids);
}

/** compulsory subject, or an elective this student chose */
const takesSubject = (student, elective, subject_id) =>
  !subject_id || !elective.has(subject_id) || (Array.isArray(student?.enrolled_subjects) && student.enrolled_subjects.includes(subject_id));

/** subject of a lecture session (new sessions store it; older ones are read from the lecture) */
async function sessionSubjectId(ls) {
  if (!ls) return null;
  if (ls.subject_id !== undefined) return ls.subject_id || null;
  if (!ls.lecture_id) return null;
  return (await getLecture(ls.lecture_id))?.subject_id || null;
}

/** is this student part of the class the session is for? (division + elective choice) */
function inSessionClass(ls, elective, subject_id, student) {
  if (ls?.division_id && student?.division_id !== ls.division_id) return false;
  return takesSubject(student, elective, subject_id);
}

router.get("/student/today", readLimit, guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const uid = req.query.uid || req.auth?.uid;
    if (!uid || typeof uid !== "string") return res.status(400).json({ error: "Student uid required" });

    const student = await getStudentByUid(uid);
    if (!student) return res.status(404).json({ error: "Student profile not found" });

    const aishe_code = student.aishe_code;
    const course_name = student.course_name;

    // Always IST for time comparisons (server is usually UTC)
    const nowIST = new Date(Date.now() + IST_OFFSET);
    const today = DAY_NAMES[nowIST.getUTCDay()];
    const currentMinutes = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();

    const [course_id, liveSessions] = await Promise.all([
      courseIdByNameCache.memo(
        `${course_name}|${aishe_code}`,
        120_000,
        async () => {
          const snap = await db
            .collection("courses")
            .where("course_name", "==", course_name)
            .where("aishe_code", "==", aishe_code)
            .limit(1)
            .get();
          return snap.empty ? null : snap.docs[0].id;
        },
        { cacheNull: true }
      ),
      liveSessionsFor(aishe_code),
    ]);

    const myDivision = student.division_id || null;
    const elective = await electiveSubjectIds(course_id || student.course_id);
    const sameClass = liveSessions.filter(({ data }) => {
      if (data.division_id && data.division_id !== myDivision) return false;   // another division's class
      if (!data.course_id || !course_id) return true;
      return data.course_id === course_id;
    });
    // an elective running for other students is not this student's class
    const matching = elective.size
      ? (await Promise.all(sameClass.map(async (x) => (takesSubject(student, elective, await sessionSubjectId(x.data)) ? x : null)))).filter(Boolean)
      : sameClass;

    if (matching.length > 0) {
      const { id: sessionId, data: session } = matching[0];

      if (!session.lecture_id) {
        return res.json({
          success: true,
          ongoingLecture: {
            subject_name: session.subject_name,
            room: session.room,
            start_time: session.scheduled_start_time,
            end_time: session.scheduled_end_time,
          },
          nextLecture: null,
          lecture_session_id: sessionId,
          lecture_is_live: true,
          marking_method: session.marking_method || null,
          marking_status: session.marking_status || "closed",
          attendance_session_id: session.attendance_session_id || null,
          today,
        });
      }

      const lectureData = await getLecture(session.lecture_id);
      return res.json({
        success: true,
        ongoingLecture: lectureData ? { id: session.lecture_id, ...lectureData } : null,
        nextLecture: null,
        lecture_session_id: sessionId,
        lecture_is_live: true,
        marking_method: session.marking_method || null,
        marking_status: session.marking_status || "closed",
        attendance_session_id: session.attendance_session_id || null,
        today,
      });
    }

    // No live session: the timetable only tells us the NEXT lecture
    if (!course_id) {
      return res.json({ success: true, ongoingLecture: null, nextLecture: null, lecture_session_id: null, lecture_is_live: false, today });
    }

    const lectures = await timetableCache.memo(`tt:${aishe_code}|${course_id}|${today}`, 30_000, async () => {
      const snap = await db
        .collection("lectures")
        .where("aishe_code", "==", aishe_code)
        .where("course_id", "==", course_id)
        .where("day", "==", today)
        .get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    });

    let nextLecture = null;
    const sorted = lectures.filter((l) => (!l.division_id || l.division_id === myDivision) && takesSubject(student, elective, l.subject_id)).sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
    for (const lecture of sorted) {
      if (!nextLecture && toMinutes(lecture.start_time) > currentMinutes) nextLecture = lecture;
    }

    res.json({ success: true, ongoingLecture: null, nextLecture, lecture_session_id: null, lecture_is_live: false, today });
  } catch (error) {
    console.error("STUDENT LECTURE ERROR:", error);
    res.status(500).json({ error: "Failed to fetch student lectures" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   attendance: open / close / method / code options
   ═══════════════════════════════════════════════════════════════════════════ */

const cleanWifiScan = (scan) => {
  if (!Array.isArray(scan)) return null;
  return scan
    .filter((n) => n && typeof n === "object")
    .slice(0, 100)
    .map((n) => ({
      ssid: typeof n.ssid === "string" ? n.ssid.slice(0, 64) : n.ssid === undefined ? null : String(n.ssid).slice(0, 64),
      bssid: typeof n.bssid === "string" ? n.bssid.slice(0, 40) : null,
      rssi: Number.isFinite(Number(n.rssi)) && n.rssi !== null && n.rssi !== "" ? Number(n.rssi) : null,
    }));
};

// iot_multi = the ESP32 device marks as before, AND students whose device path fails can use the code / biometric
// (those two go through the same room check as every other in-room method)
const PROXIMITY_METHODS = new Set(["code", "bio_wifi_ble", "multi", "iot_multi"]);
const CODE_METHODS = new Set(["code", "multi", "iot_multi"]);
const BIO_METHODS = new Set(["bio_wifi_ble", "multi", "iot_multi"]);
const IOT_METHODS = new Set(["iot", "iot_multi"]);
const markLabel = (method, kind) => (method === "multi" ? `multi_${kind}` : method === "iot_multi" ? `iot_${kind}` : kind === "code" ? "code" : "bio_wifi_ble");

/** teacher_wifi_scan may be one scan or several (3 scans -> stable fingerprint) */
function teacherFingerprintFrom(input) {
  if (!Array.isArray(input) || input.length === 0) return [];
  const scans = Array.isArray(input[0]) ? input.slice(0, 5).map(cleanWifiScan).filter(Boolean) : [cleanWifiScan(input)].filter(Boolean);
  return prox.buildFingerprint(scans.map((sc) => sc.filter((n) => n.bssid && n.rssi !== null)));
}

router.post("/attendance/start", async (req, res) => {
  try {
    const { lecture_session_id, marking_method, teacher_wifi_scan, ble_service_uuid } = req.body;

    if (!lecture_session_id || !marking_method) {
      return res.status(400).json({ success: false, error: "lecture_session_id and marking_method required" });
    }
    if (!isId(lecture_session_id) || typeof marking_method !== "string" || marking_method.length > 40) {
      return res.status(404).json({ success: false, error: "Lecture session not found" });
    }

    const sessionRef = db.collection("lecture_sessions").doc(lecture_session_id);

    // ownership first (teacher_id of a session never changes, so the short-lived cache is fine)
    if (req.auth) {
      const pre = await getLectureSession(lecture_session_id);
      if (!allow(req, res, await callerOwnsLectureSession(req, pre), "attendance-start-own-session")) return;
    }

    const wantsProximity = PROXIMITY_METHODS.has(marking_method);
    const fingerprint = wantsProximity ? teacherFingerprintFrom(teacher_wifi_scan) : [];

    // read + decide + write in one transaction -> two quick taps can not create two attendance sessions
    const out = await db.runTransaction(async (tx) => {
      const sessionDoc = await tx.get(sessionRef);
      if (!sessionDoc.exists) return { notFound: true };
      const sessionData = sessionDoc.data();

      if (sessionData.attendance_session_id) {
        const exRef = db.collection("attendance_sessions").doc(sessionData.attendance_session_id);
        const ex = await tx.get(exRef);
        if (ex.exists && ex.data().marking_status === "open") {
          const existing = ex.data();
          let code = existing.attendance_code || null;
          // the code was deleted by an earlier close -> regenerate it
          if (!code && CODE_METHODS.has(existing.marking_method || marking_method)) {
            code = generate3DigitCode();
            tx.update(exRef, { attendance_code: code });
          }
          return { sessionData, existing: true, id: ex.id, code, method: existing.marking_method || marking_method };
        }
      }

      const attendance_code = CODE_METHODS.has(marking_method) ? generate3DigitCode() : null;
      const attRef = db.collection("attendance_sessions").doc();
      tx.set(attRef, {
        lecture_session_id,
        lecture_id: sessionData.lecture_id || null,
        teacher_id: sessionData.teacher_id,
        marking_method,
        marking_status: "open",
        attendance_code,
        started_at: FV.serverTimestamp(),
        teacher_wifi_scan: wantsProximity && fingerprint.length ? fingerprint : null,
        ble_service_uuid: wantsProximity && ble_service_uuid ? String(ble_service_uuid).slice(0, 80) : null,
        ble_token_enabled: !!(wantsProximity && ble_service_uuid),
        pending_students: [],
      });
      if (wantsProximity && ble_service_uuid) {
        tx.set(db.collection("attendance_secrets").doc(attRef.id), { ble_secret: prox.newSecret(), ble_last_poll: 0, created_at: FV.serverTimestamp() });
      }
      tx.update(sessionRef, { attendance_session_id: attRef.id, marking_status: "open", marking_method });
      return { sessionData, existing: false, id: attRef.id, code: attendance_code, method: marking_method };
    });

    if (out.notFound) return res.status(404).json({ success: false, error: "Lecture session not found" });

    dropAttendanceSession(out.id);
    dropLectureSession(lecture_session_id);

    const extra = { marking_method: out.method, fingerprint_aps: fingerprint.length };
    if (out.existing) {
      return res.json({ success: true, attendance_session_id: out.id, attendance_code: out.code, already_exists: true, ...extra });
    }
    return res.json({ success: true, attendance_session_id: out.id, attendance_code: out.code, ...extra });
  } catch (error) {
    console.error("START ATTENDANCE ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to start attendance" });
  }
});

router.post("/attendance/close", async (req, res) => {
  try {
    const { lecture_session_id } = req.body;
    if (!lecture_session_id || !isId(lecture_session_id)) {
      return res.status(404).json({ error: "Session not found" });
    }

    const sessionRef = db.collection("lecture_sessions").doc(lecture_session_id);
    const doc = await sessionRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Session not found" });

    const sessionData = doc.data();
    const { attendance_session_id } = sessionData;
    if (!attendance_session_id) return res.status(400).json({ error: "Attendance session not found" });

    if (!allow(req, res, await callerOwnsLectureSession(req, sessionData), "attendance-close-own-session")) return;

    // every student who marked is written before the window closes
    await Promise.all([presentWriter.flushAll(), pendingWriter.flushAll(), unpendWriter.flushAll()]).catch(() => {});

    const batch = db.batch();
    batch.delete(db.collection("attendance_secrets").doc(attendance_session_id));
    batch.update(db.collection("attendance_sessions").doc(attendance_session_id), {
      marking_status: "closed",
      attendance_code: FV.delete(),
      ended_at: FV.serverTimestamp(),
    });
    batch.update(sessionRef, { marking_status: "closed" });
    await batch.commit();

    // purge caches so no stale "open" data lingers after close
    dropAttendanceSession(attendance_session_id);
    dropLectureSession(lecture_session_id);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to close attendance" });
  }
});

router.get("/attendance/method", readLimit, guard.authed, async (req, res) => {
  try {
    const { lecture_session_id } = req.query;
    const data = typeof lecture_session_id === "string" ? await getLectureSession(lecture_session_id) : null;
    if (!data) return res.json({ success: false });

    res.json({
      success: true,
      marking_method: data.marking_method,
      attendance_session_id: data.attendance_session_id,
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch method" });
  }
});

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

router.get("/attendance/code-options", readLimit, guard.authed, async (req, res) => {
  try {
    const { lecture_session_id } = req.query;

    if (!lecture_session_id || typeof lecture_session_id !== "string") {
      return res.status(400).json({ error: "lecture_session_id required" });
    }

    const sessionData = await getLectureSession(lecture_session_id);
    if (!sessionData) return res.status(404).json({ error: "Lecture session not found" });

    const attendanceSessionId = sessionData.attendance_session_id;
    if (!attendanceSessionId) return res.status(404).json({ error: "Attendance session not started" });

    const attendanceData = await getAttendanceSession(attendanceSessionId);
    if (!attendanceData) return res.status(404).json({ error: "Attendance session missing" });

    const correctCode = attendanceData.attendance_code;

    // two decoy codes, then shuffle (each student gets a different order)
    let fake1 = generate3DigitCode();
    let fake2 = generate3DigitCode();
    while (fake1 === correctCode) fake1 = generate3DigitCode();
    while (fake2 === correctCode || fake2 === fake1) fake2 = generate3DigitCode();

    res.json({
      success: true,
      options: shuffle([correctCode, fake1, fake2]),
      attendance_session_id: attendanceSessionId,
    });
  } catch (error) {
    console.error("CODE OPTIONS ERROR:", error);
    res.status(500).json({ error: "Failed to fetch code options" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   PROXIMITY  ("is the student really in the classroom?")

   Engine: utils/proximity.js  (Wi-Fi fingerprint + BLE + rotating BLE token).
   3 outcomes:  verified -> present   |   unverified -> `pending` (teacher decides)   |   rejected -> nothing stored
   ═══════════════════════════════════════════════════════════════════════════ */

const TOKEN_ACTIVE_MS = prox.CONFIG.TOKEN_ACTIVE_MS;

// sessionId -> { n, touched }  (only used to learn "does anybody hear the teacher's beacon?")
const bleReadings = new Map();
const classRef = new prox.ClassReference();
const pollWrite = new Map(); // sessionId -> last time ble_last_poll was persisted

function recordBleReading(sessionId, rssi) {
  if (rssi === null || rssi === undefined) return;
  const e = bleReadings.get(sessionId) || { n: 0, touched: 0 };
  e.n += 1;
  e.touched = Date.now();
  bleReadings.set(sessionId, e);
}

// forget sessions that were never closed properly
const bleSweeper = setInterval(() => {
  const cutoff = Date.now() - 6 * 3600_000;
  for (const [k, v] of bleReadings) if (v.touched < cutoff) bleReadings.delete(k);
  for (const [k, t] of pollWrite) if (t < cutoff) pollWrite.delete(k);
  classRef.sweep();
  if (bleReadings.size > 5000) {
    for (const k of bleReadings.keys()) {
      bleReadings.delete(k);
      if (bleReadings.size <= 4000) break;
    }
  }
}, 10 * 60_000);
if (bleSweeper.unref) bleSweeper.unref();

/** student-supplied scans are untrusted: keep only well-formed, bounded entries */
const cleanStudentScan = (scan) =>
  Array.isArray(scan)
    ? scan
        .filter((n) => n && typeof n === "object" && typeof n.bssid === "string")
        .slice(0, 100)
        .map((n) => ({ bssid: n.bssid.slice(0, 40), rssi: Number.isFinite(Number(n.rssi)) && n.rssi !== null && n.rssi !== "" ? Number(n.rssi) : -100 }))
    : [];

const cleanRssi = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

const cleanTokens = (t) => (Array.isArray(t) ? t.filter((x) => typeof x === "string" && x.length === prox.CONFIG.TOKEN_HEX).slice(0, 40) : []);

/** { ble_secret, ble_last_poll } | null  (server-only document, cached; the object is updated in place by ble-token polls) */
async function getBleState(sid) {
  if (!isId(sid)) return null;
  const s = await bleStateCache.memo(`b:${sid}`, 60_000, async () => {
    const d = await db.collection("attendance_secrets").doc(sid).get();
    return d.exists ? d.data() : null;
  });
  return s || null;
}

const isTokenActive = (st) => !!(st?.ble_secret && Date.now() - (Number(st.ble_last_poll) || 0) < TOKEN_ACTIVE_MS);

/** run the engine for one student request */
async function judgeProximity(att, sid, body) {
  const hasFp = (att.teacher_wifi_scan?.length || 0) > 0;
  // session was opened by an old app without any proximity data -> nothing to verify against
  if (!hasFp && !att.ble_service_uuid) {
    return { verdict: "verified", reasons: [], signals: { legacy: true }, error_type: "none", message: "Proximity not required for this session." };
  }
  const ble = cleanRssi(body.ble_rssi);
  if (ble !== null) recordBleReading(sid, ble);
  const st = att.ble_token_enabled ? await getBleState(sid) : null;
  const tokenActive = isTokenActive(st);
  const bleOff = !att.ble_service_uuid || (!tokenActive && !(bleReadings.get(sid)?.n > 0));

  const r = prox.evaluate({
    teacherWifi: att.teacher_wifi_scan || [],
    classWifi: classRef.get(sid),
    studentWifi: cleanStudentScan(body.student_wifi_scan),
    wifiFresh: typeof body.wifi_fresh === "boolean" ? body.wifi_fresh : null,
    bleRssi: ble,
    bleTokens: cleanTokens(body.ble_tokens),
    secret: st?.ble_secret || null,
    tokenActive,
    bleOff,
  });
  return r;
}

router.get("/attendance/ble-token", readLimit, guard.teacherOnly, async (req, res) => {
  try {
    const { lecture_session_id } = req.query;
    if (typeof lecture_session_id !== "string" || !isId(lecture_session_id)) {
      return res.status(400).json({ success: false, error: "lecture_session_id required" });
    }
    const ls = await getLectureSession(lecture_session_id);
    if (!ls) return res.status(404).json({ success: false, error: "Lecture session not found" });
    if (!allow(req, res, await callerOwnsLectureSession(req, ls), "ble-token-own-session")) return;
    if (!ls.attendance_session_id) return res.json({ success: true, enabled: false });

    const att = await getAttendanceSession(ls.attendance_session_id);
    const st = att && att.marking_status === "open" && att.ble_token_enabled && att.ble_service_uuid ? await getBleState(att.id) : null;
    if (!st?.ble_secret) {
      return res.json({ success: true, enabled: false });
    }

    const now = Date.now();
    const slot = prox.CONFIG.TOKEN_SLOT_MS;
    st.ble_last_poll = now; // current process sees it immediately
    if (now - (pollWrite.get(att.id) || 0) > 20_000) {
      pollWrite.set(att.id, now);
      db.collection("attendance_secrets").doc(att.id).update({ ble_last_poll: now }).catch(() => {});
    }

    return res.json({
      success: true,
      enabled: true,
      token: prox.currentToken(st.ble_secret, now),
      ble_service_uuid: att.ble_service_uuid,
      slot_ms: slot,
      expires_in_ms: slot - (now % slot),
    });
  } catch (error) {
    console.error("BLE TOKEN ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to get BLE token" });
  }
});

router.post("/attendance/validate-wifi-ble", readLimit, guard.authed, async (req, res) => {
  try {
    const { attendance_session_id } = req.body;

    if (!attendance_session_id) {
      return res.status(400).json({ success: false, error: "attendance_session_id required" });
    }

    const session = await getAttendanceSession(attendance_session_id);
    if (!session) return res.status(404).json({ success: false, error: "Attendance session not found" });

    if (session.marking_status !== "open") {
      return res.json({ success: false, in_room: false, message: "Attendance is closed", error_type: "closed" });
    }

    const r = await judgeProximity(session, attendance_session_id, req.body);
    return res.json({
      success: true,
      in_room: r.verdict === "verified",
      verdict: r.verdict,
      soft_warning: r.verdict === "unverified",
      reasons: r.reasons,
      message: r.message,
      error_type: r.error_type,
    });
  } catch (error) {
    console.error("VALIDATE WIFI BLE ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to validate proximity" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   MARKING (hot path)
   ═══════════════════════════════════════════════════════════════════════════ */

// signatures that still have to be written together with the next present_students flush
const sigDirty = new Set();

/**
 * present_students (legacy array on the attendance session) - one arrayUnion per window for the
 * whole class instead of one write per student on the same document.
 */
const presentWriter = createCoalescer(
  async (sessionId, uids) => {
    const upd = { present_students: FV.arrayUnion(...uids) };
    if (sigDirty.has(sessionId)) {
      upd.last_device_signature = lastSig.get(sessionId) ?? null;
      sigDirty.delete(sessionId);
    }
    await db.collection("attendance_sessions").doc(sessionId).update(upd);
  },
  { windowMs: PRESENT_FLUSH_MS, maxItems: 200, retries: 2 }
);

/** pending_students: students waiting for the teacher's decision (never counted as present) */
const pendingWriter = createCoalescer(
  async (sessionId, uids) => {
    await db.collection("attendance_sessions").doc(sessionId).update({ pending_students: FV.arrayUnion(...uids) });
  },
  { windowMs: PRESENT_FLUSH_MS, maxItems: 200, retries: 2 }
);
const unpendWriter = createCoalescer(
  async (sessionId, uids) => {
    await db.collection("attendance_sessions").doc(sessionId).update({ pending_students: FV.arrayRemove(...uids) });
  },
  { windowMs: PRESENT_FLUSH_MS, maxItems: 200, retries: 2 }
);

const queuePresent = (sessionId, uid) =>
  presentWriter.add(sessionId, uid).catch((e) => console.error("present_students update failed:", sessionId, e.message));
const queuePending = (sessionId, uid) =>
  pendingWriter.add(sessionId, uid).catch((e) => console.error("pending_students update failed:", sessionId, e.message));
const queueUnpend = (sessionId, uid) =>
  unpendWriter.add(sessionId, uid).catch((e) => console.error("pending_students remove failed:", sessionId, e.message));

/** student belongs to the same college as the lecture (cheap cached check, used with allow()) */
async function studentBelongsToSession(student, att) {
  const ls = await getLectureSession(att.lecture_session_id);
  const aishe = ls?.aishe_code;
  if (aishe && student.aishe_code && aishe !== student.aishe_code) return false;
  // a class held for one division is for that division's students only
  if (ls?.division_id && student.division_id !== ls.division_id) return false;
  // an elective is for the students who chose it
  if (ls?.course_id) {
    const elective = await electiveSubjectIds(ls.course_id);
    if (elective.size && !takesSubject(student, elective, await sessionSubjectId(ls))) return false;
  }
  return true;
}

const markedKey = (sid, uid) => `${sid}_${uid}`;

/** the student's existing record for the session ({status,...}) or null; "present" is cached */
async function existingRecord(sid, uid) {
  const key = markedKey(sid, uid);
  if (markedCache.get(key)) return { status: "present" };
  const snap = await db.collection("attendance_records").doc(key).get();
  if (!snap.exists) return null;
  const d = snap.data();
  if (d.status === "present") markedCache.set(key, true);
  return d;
}

/** true when this student already has a "present" record for the session */
const alreadyPresent = async (sid, uid) => (await existingRecord(sid, uid))?.status === "present";

/**
 * shared tail of mark-code / mark-bio:
 *   - not already decided, proximity verdict, write record, update the live arrays
 * returns true when the response was sent
 */
async function recordMark({ req, res, att, sid, uid, label, extraOk }) {
  const existing = await existingRecord(sid, uid);
  if (existing?.status === "present") {
    queuePresent(sid, uid); // self-heal the legacy array if an earlier flush failed
    res.json({ success: true, already_marked: true, verification: "verified", message: "Attendance already marked" });
    return true;
  }
  if (existing && existing.verified_by_teacher) {
    res.json({ success: false, message: "Your teacher has already reviewed your attendance.", error_type: "reviewed" });
    return true;
  }

  const r = await judgeProximity(att, sid, req.body);
  if (r.verdict === "rejected") {
    res.json({ success: false, soft_warning: false, verification: "rejected", reasons: r.reasons, message: r.message, error_type: r.error_type });
    return true;
  }

  const student = await getStudentByUid(uid);
  if (!student) {
    res.status(404).json({ success: false, error: "Student not found" });
    return true;
  }
  if (!allow(req, res, await studentBelongsToSession(student, att), `${label}-same-college`)) return true;

  const verified = r.verdict === "verified";
  await db.collection("attendance_records").doc(markedKey(sid, uid)).set({
    attendance_session_id: sid,
    lecture_session_id: att.lecture_session_id,
    student_uid: uid,
    student_name: student.name || "Unknown",
    student_roll: student.roll_number || null,
    status: verified ? "present" : "pending",
    verification: r.verdict,
    reasons: r.reasons,
    signals: r.signals,
    ble_rssi: r.signals.ble_rssi ?? null,
    method: label,
    marked_at: FV.serverTimestamp(),
  });

  if (verified) {
    markedCache.set(markedKey(sid, uid), true);
    queuePresent(sid, uid);
    if (existing) queueUnpend(sid, uid); // was pending, now upgraded
    classRef.add(sid, cleanStudentScan(req.body.student_wifi_scan));
    res.json({ success: true, verification: "verified", message: "Attendance marked successfully" });
  } else {
    queuePending(sid, uid);
    res.json({
      success: true,
      pending: true,
      verification: "unverified",
      reasons: r.reasons,
      message: "Sent to your teacher for confirmation. You are not counted present until they confirm.",
    });
  }
  if (extraOk) extraOk();
  return true;
}

router.post("/attendance/mark-code", markLimit, guard.student(fromBody("uid")), async (req, res) => {
  try {
    const { attendance_session_id, selected_code, uid } = req.body;

    if (!attendance_session_id || !selected_code || !uid || typeof uid !== "string" || !isId(uid)) {
      return res.status(400).json({ success: false, error: "attendance_session_id, selected_code, uid required" });
    }

    const attendanceData = await getAttendanceSession(attendance_session_id);
    if (!attendanceData) return res.status(404).json({ success: false, error: "Attendance session not found" });

    if (attendanceData.marking_status !== "open") {
      return res.json({ success: false, message: "Attendance is closed", error_type: "closed" });
    }
    if (!CODE_METHODS.has(attendanceData.marking_method)) {
      return res.json({ success: false, message: "Code marking is not enabled for this session.", error_type: "method_disabled" });
    }

    if (typeof selected_code !== "string" || selected_code !== attendanceData.attendance_code) {
      return res.json({ success: false, message: "Incorrect code. Choose the code shown by your teacher.", error_type: "wrong_code" });
    }

    await recordMark({
      req, res, att: attendanceData, sid: attendance_session_id, uid,
      label: markLabel(attendanceData.marking_method, "code"),
    });
  } catch (error) {
    console.error("MARK CODE ERROR:", error);
    if (!res.headersSent) res.status(500).json({ success: false, error: "Failed to mark attendance" });
  }
});

router.post("/attendance/mark-bio", markLimit, guard.student(fromBody("uid")), async (req, res) => {
  try {
    const { attendance_session_id, uid, device_signature } = req.body;

    if (!attendance_session_id || !uid || typeof uid !== "string" || !isId(uid)) {
      return res.status(400).json({ success: false, error: "attendance_session_id and uid required" });
    }

    const attendanceData = await getAttendanceSession(attendance_session_id);
    if (!attendanceData) return res.status(404).json({ success: false, error: "Attendance session not found" });

    const sig = typeof device_signature === "string" ? device_signature.slice(0, 300) : device_signature ? String(device_signature).slice(0, 300) : null;

    // duplicate device signature (same as the previous request's) - tracked in memory so it is current
    // even though the cached session document is not refreshed after every mark
    const lastSignature = lastSig.has(attendance_session_id) ? lastSig.get(attendance_session_id) : attendanceData.last_device_signature;
    if (sig && lastSignature === sig) {
      return res.json({ success: false, message: "Duplicate request detected" });
    }

    if (attendanceData.marking_status !== "open") {
      return res.json({ success: false, message: "Attendance is closed" });
    }
    if (!BIO_METHODS.has(attendanceData.marking_method)) {
      return res.json({ success: false, message: "Biometric marking is not enabled for this session.", error_type: "method_disabled" });
    }

    await recordMark({
      req, res, att: attendanceData, sid: attendance_session_id, uid,
      label: markLabel(attendanceData.marking_method, "bio"),
      extraOk: () => {
        lastSig.set(attendance_session_id, sig || null);
        sigDirty.add(attendance_session_id);
      },
    });
  } catch (error) {
    console.error("MARK BIO ERROR:", error);
    if (!res.headersSent) res.status(500).json({ success: false, error: "Failed to mark attendance" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   teacher verification screens
   ═══════════════════════════════════════════════════════════════════════════ */

// resolves course_id + aishe_code from a lecture session (falls back to its lecture / subject)
async function resolveCourseFromSession(data) {
  let { course_id, aishe_code } = data;
  if (course_id && aishe_code) return { course_id, aishe_code };

  if (!course_id && data.lecture_id) {
    const l = await getLecture(data.lecture_id);
    if (l) {
      course_id = course_id || l.course_id;
      aishe_code = aishe_code || l.aishe_code;
    }
  }
  if (!course_id && data.subject_id && isId(data.subject_id)) {
    const d = await db.collection("subjects").doc(data.subject_id).get();
    if (d.exists) {
      course_id = course_id || d.data().course_id;
      aishe_code = aishe_code || d.data().aishe_code;
    }
  }
  return { course_id, aishe_code };
}

const rosterQuery = (course_name, aishe_code) =>
  db.collection("students").where("course_name", "==", course_name).where("aishe_code", "==", aishe_code);

/** students of the class: [{uid,name,roll_number}] (30 s cache; the doc order of the query is kept) */
const getRoster = (course_name, aishe_code) =>
  rosterCache.memo(`r:${aishe_code}|${course_name}`, 30_000, async () => {
    const snap = await rosterQuery(course_name, aishe_code).select("uid", "name", "roll_number", "division_id", "enrolled_subjects").get();
    return snap.docs.map((d) => d.data());
  });

/** attendance_records of one session: [{student_uid,status}] (2 s cache) */
const getSessionRecords = (sid) =>
  recordsCache.memo(`r:${sid}`, 2_000, async () => {
    const snap = await db.collection("attendance_records").where("attendance_session_id", "==", sid).select("student_uid", "status", "verification", "reasons", "signals", "ble_rssi", "method").get();
    return snap.docs.map((d) => d.data());
  });

async function classOfLectureSession(lecture_session_id) {
  const ls = await getLectureSession(lecture_session_id);
  if (!ls) return { error: { code: 404, body: { success: false, error: "Lecture session not found" } } };

  const { course_id, aishe_code } = await resolveCourseFromSession(ls);
  if (!course_id || !aishe_code) {
    return { error: { code: 400, body: { success: false, error: "Could not resolve course_id or aishe_code for this lecture session" } } };
  }
  const course = await getCourse(course_id);
  if (!course) return { error: { code: 404, body: { success: false, error: "Course not found" } } };
  return { ls, aishe_code, course_id, course_name: course.course_name };
}

router.get("/attendance/verify-students", readLimit, guard.teacherOnly, async (req, res) => {
  try {
    const { attendance_session_id, lecture_session_id } = req.query;

    if (!attendance_session_id || !lecture_session_id || typeof attendance_session_id !== "string" || typeof lecture_session_id !== "string") {
      return res.status(400).json({ success: false, error: "attendance_session_id and lecture_session_id are required" });
    }

    const c = await classOfLectureSession(lecture_session_id);
    if (c.error) return res.status(c.error.code).json(c.error.body);
    if (!allow(req, res, await callerOwnsLectureSession(req, c.ls), "verify-students-own-session")) return;

    const fullRoster = await getRoster(c.course_name, c.aishe_code);
    const elective = await electiveSubjectIds(c.course_id);
    const subjectId = elective.size ? await sessionSubjectId(c.ls) : null;
    const roster = fullRoster.filter((x) => inSessionClass(c.ls, elective, subjectId, x));
    if (roster.length === 0) return res.json({ success: true, students: [] });

    const records = await getSessionRecords(attendance_session_id);
    const byUid = new Map(records.map((r) => [r.student_uid, r]));

    const students = roster.map((data) => {
      const rec = byUid.get(data.uid);
      const status = rec?.status === "present" ? "present" : rec?.status === "pending" ? "pending" : "none";
      return {
        uid: data.uid,
        name: data.name || "Unknown",
        roll_no: data.roll_number || "-",
        is_present: status === "present",
        status, // present | pending | none
        verification: rec?.verification || null,
        reasons: status === "pending" ? rec.reasons || [] : [],
        signals: status === "pending" ? rec.signals || null : null,
        ble_rssi: rec?.ble_rssi ?? null,
        method: rec?.method || null,
      };
    });

    const rank = { pending: 0, present: 1, none: 2 };
    students.sort((a, b) => {
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      return String(a.name).localeCompare(String(b.name));
    });

    return res.json({ success: true, students });
  } catch (error) {
    console.error("VERIFY STUDENTS ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to fetch students" });
  }
});

router.post("/attendance/verify-attendance", guard.teacherOnly, async (req, res) => {
  try {
    const { attendance_session_id, lecture_session_id, verified_students } = req.body;

    if (!attendance_session_id || !lecture_session_id || !Array.isArray(verified_students) ||
        typeof attendance_session_id !== "string" || typeof lecture_session_id !== "string") {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const c = await classOfLectureSession(lecture_session_id);
    if (c.error) return res.status(c.error.code).json(c.error.body);
    if (!allow(req, res, await callerOwnsLectureSession(req, c.ls), "verify-attendance-own-session")) return;

    // fresh reads here (this is a write decision)
    const [studentsSnap, existingRecordsSnap] = await Promise.all([
      rosterQuery(c.course_name, c.aishe_code).select("uid", "name", "roll_number", "division_id", "enrolled_subjects").get(),
      db.collection("attendance_records").where("attendance_session_id", "==", attendance_session_id).select("student_uid", "status", "verification").get(),
    ]);

    const existingByUid = {};
    existingRecordsSnap.docs.forEach((doc) => {
      const d = doc.data();
      existingByUid[d.student_uid] = d;
    });

    const verifiedSet = new Set(verified_students);
    const ops = [];
    let marked_count = 0;
    let unmarked_count = 0;
    let skipped_count = 0;
    const pendingResolved = [];

    // only the students this class is for (its division, and for an elective the students who chose it)
    const elective = await electiveSubjectIds(c.course_id);
    const subjectId = elective.size ? await sessionSubjectId(c.ls) : null;

    for (const doc of studentsSnap.docs) {
      const data = doc.data();
      const uid = data.uid;
      if (!isId(uid)) continue;
      if (!inSessionClass(c.ls, elective, subjectId, data)) continue;
      const recordRef = db.collection("attendance_records").doc(markedKey(attendance_session_id, uid));
      const existing = existingByUid[uid];
      const teacherSaysPresent = verifiedSet.has(uid);

      if (existing) {
        const alreadyPresentRec = existing.status === "present";
        const wasPending = existing.status === "pending";
        if (wasPending) pendingResolved.push({ uid, present: teacherSaysPresent });
        if (!wasPending && teacherSaysPresent === alreadyPresentRec) {
          skipped_count++;
          continue;
        }
        ops.push((b) =>
          b.update(recordRef, {
            status: teacherSaysPresent ? "present" : "absent",
            verified_by_teacher: true,
            verification: existing.status === "pending" ? (teacherSaysPresent ? "teacher_confirmed" : "teacher_rejected") : existing.verification || null,
            updated_at: FV.serverTimestamp(),
          })
        );
        teacherSaysPresent ? marked_count++ : unmarked_count++;
      } else {
        ops.push((b) =>
          b.set(recordRef, {
            attendance_session_id,
            lecture_session_id,
            student_uid: uid,
            student_name: data.name || "Unknown",
            student_roll: data.roll_number || null,
            status: teacherSaysPresent ? "present" : "absent",
            verified_by_teacher: true,
            method: "manual_verify",
            marked_at: FV.serverTimestamp(),
          })
        );
        teacherSaysPresent ? marked_count++ : unmarked_count++;
      }
    }

    await commitInBatches(ops); // > 500 students no longer fails

    // pending students are now decided: out of the waiting list, confirmed ones into the live counter
    if (pendingResolved.length) {
      const confirmed = pendingResolved.filter((x) => x.present).map((x) => x.uid);
      const upd = { pending_students: FV.arrayRemove(...pendingResolved.map((x) => x.uid)) };
      if (confirmed.length) upd.present_students = FV.arrayUnion(...confirmed);
      await db.collection("attendance_sessions").doc(attendance_session_id).update(upd).catch((e) => console.error("pending resolve failed:", e.message));
    }

    recordsCache.del(`r:${attendance_session_id}`);
    markedCache.delPrefix(`${attendance_session_id}_`);

    return res.json({ success: true, marked_count, unmarked_count, skipped_count });
  } catch (error) {
    console.error("VERIFY ATTENDANCE ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to verify attendance" });
  }
});

router.post("/attendance/mark-manual", guard.teacherOnly, async (req, res) => {
  try {
    const { attendance_session_id, lecture_session_id, student_uids } = req.body;
    if (!attendance_session_id || !lecture_session_id || !Array.isArray(student_uids) || student_uids.length === 0 ||
        typeof attendance_session_id !== "string" || !isId(attendance_session_id)) {
      return res.status(400).json({ success: false, error: "Missing or invalid params" });
    }

    const ls = await getLectureSession(lecture_session_id);
    if (!ls) return res.status(404).json({ success: false, error: "Session not found" });
    if (!allow(req, res, await callerOwnsLectureSession(req, ls), "mark-manual-own-session")) return;

    // (the original used `uid in [...]`, which Firestore rejects for more than 30 ids)
    const uids = [...new Set(student_uids.filter(isId))].slice(0, 2000);
    const found = (await Promise.all(uids.map((u) => getStudentByUid(u).then((s) => (s ? { uid: u, s } : null))))).filter(Boolean);
    if (found.length === 0) return res.status(404).json({ success: false, error: "No students found" });
    found.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));

    const existing = await getDocsByIds("attendance_records", found.map((f) => markedKey(attendance_session_id, f.uid)), ["status"]);

    const now = FV.serverTimestamp();
    const marked = [];
    const skipped = [];
    const ops = [];

    for (const { uid, s } of found) {
      const id = markedKey(attendance_session_id, uid);
      if (existing.has(id)) {
        skipped.push(uid);
        continue;
      }
      const ref = db.collection("attendance_records").doc(id);
      ops.push((b) =>
        b.set(ref, {
          attendance_session_id,
          lecture_session_id,
          student_uid: uid,
          student_name: s.name || "Unknown",
          student_roll: s.roll_no ?? s.roll_number ?? null,
          status: "present",
          method: "manual",
          marked_at: now,
        })
      );
      marked.push(uid);
    }

    await commitInBatches(ops);
    recordsCache.del(`r:${attendance_session_id}`);

    return res.json({ success: true, marked_count: marked.length, skipped_count: skipped.length, marked_uids: marked });
  } catch (e) {
    console.error("MANUAL MARK ERROR:", e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   QR (rotating TOTP) attendance
   ═══════════════════════════════════════════════════════════════════════════ */

router.post("/attendance/start-qr", async (req, res) => {
  try {
    const { lecture_session_id } = req.body;
    if (!lecture_session_id) return res.status(400).json({ success: false, error: "lecture_session_id required" });
    if (!isId(lecture_session_id)) return res.status(404).json({ success: false, error: "Lecture session not found" });

    const sessionRef = db.collection("lecture_sessions").doc(lecture_session_id);

    if (req.auth) {
      const pre = await getLectureSession(lecture_session_id);
      if (!allow(req, res, await callerOwnsLectureSession(req, pre), "start-qr-own-session")) return;
    }

    const out = await db.runTransaction(async (tx) => {
      const sessionDoc = await tx.get(sessionRef);
      if (!sessionDoc.exists) return { code: 404, body: { success: false, error: "Lecture session not found" } };
      const sessionData = sessionDoc.data();

      if (!sessionData.is_live) {
        return { code: 400, body: { success: false, error: "Lecture session is not active" } };
      }

      if (sessionData.attendance_session_id) {
        const existingDoc = await tx.get(db.collection("attendance_sessions").doc(sessionData.attendance_session_id));
        if (existingDoc.exists) {
          const existing = existingDoc.data();
          if (existing.marking_status === "open") {
            return {
              sessionData,
              code: 200,
              body: {
                success: true,
                attendance_session_id: sessionData.attendance_session_id,
                qr_token: existing.qr_token,
                display_code: existing.display_code,
                qr_link: `${process.env.WEB_APP_URL}/?token=${existing.qr_token}`,
                resumed: true,
              },
            };
          }
          if (existing.marking_status === "closed") {
            return { sessionData, code: 409, body: { success: false, error: "Attendance already completed for this lecture" } };
          }
        }
      }

      const totp_secret = speakeasy.generateSecret({ length: 20 }).base32;
      const qr_token = uuidv4();
      const display_code = generate8DigitCode();
      const attRef = db.collection("attendance_sessions").doc();

      tx.set(attRef, {
        lecture_session_id,
        lecture_id: sessionData.lecture_id || null,
        teacher_id: sessionData.teacher_id,
        marking_method: "qr_totp",
        marking_status: "open",
        attendance_code: null,
        totp_secret,
        qr_token,
        display_code,
        started_at: FV.serverTimestamp(),
        ended_at: null,
        teacher_coordinates: sessionData.teacher_coordinates || null,
      });
      tx.update(sessionRef, { attendance_session_id: attRef.id, marking_status: "open", marking_method: "qr_totp" });

      return {
        sessionData,
        code: 200,
        body: {
          success: true,
          attendance_session_id: attRef.id,
          qr_token,
          display_code,
          qr_link: `${process.env.WEB_APP_URL}/?token=${qr_token}`,
        },
      };
    });

    dropLectureSession(lecture_session_id);
    if (out.body.attendance_session_id) dropAttendanceSession(out.body.attendance_session_id);

    return res.status(out.code).json(out.body);
  } catch (error) {
    console.error("START QR ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to start QR attendance session" });
  }
});

/** attendance session id for a QR token / 8-digit display code (the codes never change) */
const findQrSessionId = (token, code) =>
  qrIndex.memo(token ? `t:${token}` : `c:${code}`, 60_000, async () => {
    const snap = token
      ? await db.collection("attendance_sessions").where("qr_token", "==", token).limit(1).get()
      : await db.collection("attendance_sessions").where("display_code", "==", code).where("marking_status", "==", "open").limit(1).get();
    return snap.empty ? null : snap.docs[0].id;
  });

router.get("/attendance/qr-live", qrLiveLimit, async (req, res) => {
  try {
    const token = typeof req.query.token === "string" && req.query.token ? req.query.token : null;
    const code = typeof req.query.code === "string" && req.query.code ? req.query.code : null;

    if (!token && !code) return res.status(400).json({ success: false, error: "token or code required" });

    const sessionId = await findQrSessionId(token, token ? null : code);
    const attendanceData = sessionId ? await getAttendanceSession(sessionId) : null;

    // by display code only OPEN sessions are visible (as before)
    if (!attendanceData || (!token && attendanceData.marking_status !== "open")) {
      if (sessionId && !token) qrIndex.del(`c:${code}`);
      return res.status(404).json({ success: false, error: "Session not found" });
    }

    if (attendanceData.marking_status !== "open") {
      return res.json({ success: true, status: "closed", qr_value: null, expires_in: null });
    }

    // 5 s TOTP step (matches mark-qr verification)
    const otp = speakeasy.totp({ secret: attendanceData.totp_secret, encoding: "base32", step: 5 });
    const nowSec = Math.floor(Date.now() / 1000);
    const expires_in = 5 - (nowSec % 5);

    return res.json({
      success: true,
      status: "open",
      qr_value: `PRESENCEPRO:${attendanceData.id}:${otp}`,
      expires_in,
      attendance_session_id: attendanceData.id,
      lecture_session_id: attendanceData.lecture_session_id || null,
    });
  } catch (error) {
    console.error("QR LIVE ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch live QR" });
  }
});

router.post("/attendance/close-qr", async (req, res) => {
  try {
    const { attendance_session_id, lecture_session_id } = req.body;

    if (!attendance_session_id || !lecture_session_id) {
      return res.status(400).json({ success: false, error: "attendance_session_id and lecture_session_id required" });
    }
    if (!isId(attendance_session_id) || !isId(lecture_session_id)) {
      return res.status(404).json({ success: false, error: "Attendance session not found" });
    }

    const attRef = db.collection("attendance_sessions").doc(attendance_session_id);
    const attDoc = await attRef.get();
    if (!attDoc.exists) return res.status(404).json({ success: false, error: "Attendance session not found" });

    if (!allow(req, res, await callerOwnsLectureSession(req, attDoc.data().teacher_id ? { teacher_id: attDoc.data().teacher_id } : null), "close-qr-own-session")) return;

    if (attDoc.data().marking_status === "closed") {
      return res.json({ success: true, already_closed: true });
    }

    const batch = db.batch();
    batch.update(attRef, { marking_status: "closed", ended_at: FV.serverTimestamp() });
    batch.update(db.collection("lecture_sessions").doc(lecture_session_id), { marking_status: "closed" });
    await batch.commit();

    dropAttendanceSession(attendance_session_id);
    dropLectureSession(lecture_session_id);

    return res.json({ success: true });
  } catch (error) {
    console.error("CLOSE QR ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to close QR session" });
  }
});

router.post("/attendance/mark-qr", markLimit, guard.student(fromBody("uid")), async (req, res) => {
  try {
    const { attendance_session_id, otp, uid } = req.body;

    if (!attendance_session_id || !otp || !uid || typeof uid !== "string" || !isId(uid)) {
      return res.status(400).json({ success: false, error: "attendance_session_id, otp, uid required" });
    }

    const attendanceData = await getAttendanceSession(attendance_session_id);
    if (!attendanceData) return res.status(404).json({ success: false, error: "Attendance session not found" });

    if (attendanceData.marking_status !== "open") {
      return res.status(400).json({ success: false, error: "Attendance session is closed" });
    }

    // ±1 window of 5 s covers the scan delay
    const isValid = speakeasy.totp.verify({
      secret: attendanceData.totp_secret,
      encoding: "base32",
      token: String(otp),
      step: 5,
      window: 1,
    });
    if (!isValid) {
      return res.json({ success: false, error: "Invalid or expired QR code. Please scan the latest QR." });
    }

    const student = await getStudentByUid(uid);
    if (!student) return res.status(404).json({ success: false, error: "Student not found" });
    if (!allow(req, res, await studentBelongsToSession(student, attendanceData), "mark-qr-same-college")) return;

    if (markedCache.get(markedKey(attendance_session_id, uid))) {
      return res.json({ success: true, already_marked: true, message: "Attendance already marked" });
    }

    // create() fails when the record exists -> a double scan can not overwrite anything
    try {
      await db.collection("attendance_records").doc(markedKey(attendance_session_id, uid)).create({
        attendance_session_id,
        lecture_session_id: attendanceData.lecture_session_id,
        student_uid: uid,
        student_name: student.name || "Unknown",
        student_roll: student.roll_number || null,
        status: "present",
        method: "qr_totp",
        marked_at: FV.serverTimestamp(),
      });
    } catch (e) {
      if (isAlreadyExists(e)) {
        markedCache.set(markedKey(attendance_session_id, uid), true);
        return res.json({ success: true, already_marked: true, message: "Attendance already marked" });
      }
      throw e;
    }

    markedCache.set(markedKey(attendance_session_id, uid), true);
    return res.json({ success: true, message: "Attendance marked successfully" });
  } catch (error) {
    console.error("MARK QR ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to mark attendance" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   IoT (ESP32) - public paths, optionally protected by IOT_DEVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

router.post("/attendance/iot/mark", iotLimit, iotKey, async (req, res) => {
  try {
    const { attendance_session_id, lecture_session_id, student_uid, student_roll, device_id } = req.body;

    if (!attendance_session_id || !lecture_session_id) {
      return res.status(400).json({ success: false, error: "attendance_session_id and lecture_session_id required" });
    }

    const wantUid = typeof student_uid === "string" && student_uid ? student_uid : null;
    const wantRoll = typeof student_roll === "string" && student_roll ? student_roll : typeof student_roll === "number" ? String(student_roll) : null;
    if (!wantUid && !wantRoll) {
      return res.status(400).json({ success: false, error: "Either student_uid or student_roll required" });
    }

    const attData = await getAttendanceSession(attendance_session_id);
    if (!attData) return res.status(404).json({ success: false, error: "Attendance session not found" });

    if (attData.marking_status !== "open") {
      return res.status(400).json({ success: false, error: "Attendance session is closed" });
    }
    if (!IOT_METHODS.has(attData.marking_method)) {
      return res.status(400).json({ success: false, error: "Session is not an IoT session" });
    }

    // resolve the student - prefer UID, fall back to roll number (inside the session's college first)
    let uid = wantUid;
    let studentDoc = null;

    if (!uid && wantRoll) {
      const ls = await getLectureSession(attData.lecture_session_id);
      studentDoc = (ls?.aishe_code ? await getStudentByRoll(wantRoll, ls.aishe_code) : null) || (await getStudentByRoll(wantRoll));
      if (!studentDoc) return res.status(404).json({ success: false, error: "Student not found" });
      uid = studentDoc.uid;
    }
    if (!isId(uid)) return res.status(404).json({ success: false, error: "Student not found" });

    if (!studentDoc) studentDoc = await getStudentByUid(uid);

    const prev = await existingRecord(attendance_session_id, uid);
    if (prev?.status === "present") {
      queuePresent(attendance_session_id, uid);
      return res.json({ success: true, already_marked: true, message: "Already marked" });
    }
    if (prev?.verified_by_teacher) {
      return res.status(409).json({ success: false, error: "Teacher already reviewed this student" });
    }

    await db.collection("attendance_records").doc(markedKey(attendance_session_id, uid)).set(
      {
        attendance_session_id,
        lecture_session_id: String(lecture_session_id).slice(0, 200),
        student_uid: uid,
        student_name: studentDoc?.name || "Unknown",
        student_roll: studentDoc?.roll_number || wantRoll || null,
        status: "present",
        method: "iot",
        verification: "verified",
        device_id: device_id ? String(device_id).slice(0, 100) : null,
        marked_at: FV.serverTimestamp(),
      },
      { merge: true }
    );

    markedCache.set(markedKey(attendance_session_id, uid), true);
    queuePresent(attendance_session_id, uid);
    if (prev) queueUnpend(attendance_session_id, uid); // was waiting for the teacher; the device confirms it

    return res.json({ success: true, message: `${studentDoc?.name || uid} marked present` });
  } catch (error) {
    console.error("IOT MARK ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to mark attendance" });
  }
});

router.get("/attendance/iot/session", iotLimit, iotKey, async (req, res) => {
  try {
    const { attendance_session_id } = req.query;
    if (!attendance_session_id || typeof attendance_session_id !== "string") {
      return res.status(400).json({ success: false, error: "attendance_session_id required" });
    }

    const data = await getAttendanceSession(attendance_session_id);
    if (!data) return res.status(404).json({ success: false, error: "Session not found" });

    return res.json({
      success: true,
      status: data.marking_status,
      attendance_session_id: data.id,
      marking_method: data.marking_method,
    });
  } catch (error) {
    console.error("IOT SESSION CHECK ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to check session" });
  }
});

/** write pending coalesced updates (call on graceful shutdown) */
router.flushPending = () => Promise.all([presentWriter.flushAll(), pendingWriter.flushAll(), unpendWriter.flushAll()]);

module.exports = router;