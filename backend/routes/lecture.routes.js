const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const db = admin.firestore();
const speakeasy = require("speakeasy");
const { v4: uuidv4 } = require("uuid");
const { notify, getStudentUidsForSubject } = require("../services/notify");

const toMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

function generate8DigitCode() {
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

const hasOverlap = (newStart, newEnd, exStart, exEnd) =>
  toMin(newStart) < toMin(exEnd) && toMin(newEnd) > toMin(exStart);

// Timezone-safe day name from "YYYY-MM-DD" string.
// Parses as noon UTC so no date flip on any server timezone.
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const getDayNameFromDate = (dateStr) =>
  DAY_NAMES[new Date(dateStr + "T06:30:00Z").getDay()];

const getBusyTeacherIds = async ({ aishe_code, date, start_time, end_time, day, exclude_lecture_id }) => {
  if (!aishe_code || !date || !start_time || !end_time || !day) {
    console.error("getBusyTeacherIds: Missing required parameters", { aishe_code, date, start_time, end_time, day });
    return new Set();
  }
 
  const [lectureSnap, sessionSnap, assignmentSnap] = await Promise.all([
    db.collection("lectures")
      .where("aishe_code", "==", aishe_code)
      .where("day", "==", day)
      .get(),
    db.collection("lecture_sessions")
      .where("aishe_code", "==", aishe_code)
      .where("date", "==", date)
      .where("is_temporary", "==", true)
      .get(),
    db.collection("lecture_assignments")
      .where("aishe_code", "==", aishe_code)
      .where("date", "==", date)
      .where("status", "==", "pending")
      .get(),
  ]);
 
  const busyIds = new Set();
 
  lectureSnap.docs.forEach((doc) => {
    // ── FIX BUG 1: skip the lecture being assigned/accepted ──────────────
    if (exclude_lecture_id && doc.id === exclude_lecture_id) return;
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
    if (a.expires_at && a.expires_at.toDate().getTime() < now) return;
    if (exclude_lecture_id && a.lecture_id === exclude_lecture_id) return;
    if (hasOverlap(start_time, end_time, a.start_time, a.end_time)) busyIds.add(a.assigned_teacher_id);
  });
 
  return busyIds;
};

router.get("/today", async (req, res) => {
  try {
    const uid           = req.user?.uid || req.query.uid;
    const requestedDate = req.query.date;
 
    const teacherSnap = await db
      .collection("teachers")
      .where("user_id", "==", uid)
      .limit(1)
      .get();
 
    if (teacherSnap.empty) {
      return res.status(404).json({ error: "Teacher profile not found" });
    }
 
    const teacherDoc  = teacherSnap.docs[0];
    const teacherData = teacherDoc.data();
    const teacher_id  = teacherDoc.id;
    const aishe_code  = teacherData.aishe_code;
 
    if (!aishe_code) {
      return res.status(400).json({ error: "Teacher profile missing aishe_code" });
    }
 
    // ── IST helpers ──────────────────────────────────────────────────────
    const IST_OFFSET = 330 * 60 * 1000;
    const DAY_NAMES  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const pad        = (n) => String(n).padStart(2, "0");
    const toIST      = (date) => new Date(date.getTime() + IST_OFFSET);
    const istDateString = (istDate) =>
      `${istDate.getUTCFullYear()}-${pad(istDate.getUTCMonth() + 1)}-${pad(istDate.getUTCDate())}`;
    const getDayFromDate = (dateStr) =>
      DAY_NAMES[new Date(dateStr + "T06:30:00Z").getDay()];
    const toMinutes = (time) => {
      if (!time || !time.includes(":")) return 0;
      const [h, m] = time.split(":").map(Number);
      return h * 60 + m;
    };
 
    // ── Helper: enrich a lecture_sessions temp doc into a lecture-shaped obj ─
    // Reads the parent `lectures` doc to get subject_name, room, course_id etc.
    const enrichTempSession = async (sessionDoc) => {
      const s = sessionDoc.data();
      if (!s.lecture_id) return null;
      const lectureDoc = await db.collection("lectures").doc(s.lecture_id).get();
      if (!lectureDoc.exists) return null;
      const l = lectureDoc.data();
      return {
        id:           lectureDoc.id,
        // carry all original lecture fields so AttendanceCard works unchanged
        ...l,
        // override teacher_id with the assigned teacher (Teacher B)
        teacher_id:   s.teacher_id,
        // use the session's date/time (may differ from recurring schedule)
        start_time:   s.start_time  || l.start_time,
        end_time:     s.end_time    || l.end_time,
        day:          s.day         || l.day,
        // flag so UI can optionally show "Assigned lecture" badge
        is_temporary: true,
        temp_session_id: sessionDoc.id,
      };
    };
 
    // ════════════════════════════════════════════════════════════════════
    // BRANCH A — specific date requested (LectureSchedule screen)
    // ════════════════════════════════════════════════════════════════════
    if (requestedDate) {
      const selectedDay = getDayFromDate(requestedDate);
 
      // Regular lectures for this teacher on this day
      const lectureSnap = await db
        .collection("lectures")
        .where("teacher_id", "==", teacher_id)
        .where("aishe_code", "==", aishe_code)
        .where("day", "==", selectedDay)
        .get();
 
      const lecturesRaw = lectureSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
 
      // ── FIX 1: also fetch temp sessions for Teacher B on this date ──────
      const tempSessionsSnap = await db
        .collection("lecture_sessions")
        .where("teacher_id",   "==", teacher_id)
        .where("is_temporary", "==", true)
        .where("date",         "==", requestedDate)
        .get();
 
      const tempLectures = (
        await Promise.all(tempSessionsSnap.docs.map(enrichTempSession))
      ).filter(Boolean);
 
      // Merge — avoid duplicates if the same lecture_id appears in both
      const regularIds  = new Set(lecturesRaw.map((l) => l.id));
      const mergedRaw   = [
        ...lecturesRaw,
        ...tempLectures.filter((t) => !regularIds.has(t.id)),
      ];
 
      // Resolve course abbr
      const courseIds  = [...new Set(mergedRaw.map((l) => l.course_id).filter(Boolean))];
      const courseMap  = {};
      await Promise.all(
        courseIds.map(async (cid) => {
          const snap = await db.collection("courses").doc(cid).get();
          if (snap.exists) courseMap[cid] = snap.data().abbr || "";
        })
      );
 
      const lectures = mergedRaw.map((l) => ({
        ...l,
        course_abbr: courseMap[l.course_id] || "",
      }));
 
      // Remove cancelled
      const cancelledSnap = await db
        .collection("cancelled_lectures")
        .where("teacher_id", "==", teacher_id)
        .where("date",       "==", requestedDate)
        .get();
 
      const cancelledIds      = cancelledSnap.docs.map((d) => d.data().lecture_id);
      const filteredLectures  = lectures.filter((l) => !cancelledIds.includes(l.id));
 
      return res.json({
        success:  true,
        lectures: filteredLectures,
        day:      selectedDay,
        date:     requestedDate,
      });
    }
 
    // ════════════════════════════════════════════════════════════════════
    // BRANCH B — today/tomorrow dashboard (TeacherHome)
    // ════════════════════════════════════════════════════════════════════
    const istNow       = toIST(new Date());
    const istTomorrow  = new Date(istNow.getTime() + 24 * 60 * 60 * 1000);
 
    const today          = DAY_NAMES[istNow.getUTCDay()];
    const tomorrow       = DAY_NAMES[istTomorrow.getUTCDay()];
    const todayDateStr   = istDateString(istNow);
    const tomorrowStr    = istDateString(istTomorrow);
    const currentMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
 
    // Regular lectures
    const lectureSnap = await db
      .collection("lectures")
      .where("teacher_id", "==", teacher_id)
      .where("aishe_code", "==", aishe_code)
      .where("day", "in", [today, tomorrow])
      .get();
 
    const regularLectures = lectureSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
 
    // ── FIX 1: fetch temp sessions for Teacher B for today AND tomorrow ──
    const [tempTodaySnap, tempTomorrowSnap] = await Promise.all([
      db.collection("lecture_sessions")
        .where("teacher_id",   "==", teacher_id)
        .where("is_temporary", "==", true)
        .where("date",         "==", todayDateStr)
        .get(),
      db.collection("lecture_sessions")
        .where("teacher_id",   "==", teacher_id)
        .where("is_temporary", "==", true)
        .where("date",         "==", tomorrowStr)
        .get(),
    ]);
 
    const tempTodayLectures    = (await Promise.all(tempTodaySnap.docs.map(enrichTempSession))).filter(Boolean);
    const tempTomorrowLectures = (await Promise.all(tempTomorrowSnap.docs.map(enrichTempSession))).filter(Boolean);
 
    // Cancelled IDs
    const cancelledSnap = await db
      .collection("cancelled_lectures")
      .where("teacher_id", "==", teacher_id)
      .where("date", "in", [todayDateStr, tomorrowStr])
      .get();
 
    const cancelledIds = cancelledSnap.docs.map((d) => d.data().lecture_id);
 
    const regularIds = new Set(regularLectures.map((l) => l.id));
 
    // Today: regular + temp, deduplicated, not cancelled
    const todayLectures = [
      ...regularLectures.filter((l) => l.day === today && !cancelledIds.includes(l.id)),
      ...tempTodayLectures.filter((t) => !cancelledIds.includes(t.id) && !regularIds.has(t.id)),
    ].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
 
    // Tomorrow: regular + temp, deduplicated, not cancelled
    const tomorrowLectures = [
      ...regularLectures.filter((l) => l.day === tomorrow && !cancelledIds.includes(l.id)),
      ...tempTomorrowLectures.filter((t) => !cancelledIds.includes(t.id) && !regularIds.has(t.id)),
    ].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
 
    let ongoingLecture = null;
    let nextLecture    = null;
 
    for (const lecture of todayLectures) {
      const start = toMinutes(lecture.start_time);
      const end   = toMinutes(lecture.end_time);
      if (currentMinutes >= start && currentMinutes < end) ongoingLecture = lecture;
      if (!nextLecture && start > currentMinutes)          nextLecture    = lecture;
    }
 
    if (!nextLecture && tomorrowLectures.length > 0) {
      nextLecture = tomorrowLectures[0];
    }
 
    return res.json({
      success:        true,
      ongoingLecture,
      nextLecture,
      today:          todayDateStr,
    });
 
  } catch (error) {
    console.error("LECTURE FETCH ERROR:", error);
    return res.status(500).json({ error: "Failed to fetch lectures" });
  }
});

router.post("/cancel", async (req, res) => {
  try {
    const { lecture_id, teacher_uid, date } = req.body;  //  renamed: teacher_uid from frontend
 
    if (!lecture_id || !teacher_uid || !date) {
      return res.status(400).json({
        success: false,
        error: "lecture_id, teacher_uid, date required",
      });
    }
 
    //  Resolve the Firestore teacher doc ID from the auth UID
    const teacherSnap = await db
      .collection("teachers")
      .where("user_id", "==", teacher_uid)
      .limit(1)
      .get();
 
    if (teacherSnap.empty) {
      return res.status(404).json({
        success: false,
        error: "Teacher profile not found",
      });
    }
 
    const teacher_id = teacherSnap.docs[0].id; // ← Firestore doc ID, matches GET query
 
    const existing = await db
      .collection("cancelled_lectures")
      .where("lecture_id", "==", lecture_id)
      .where("date", "==", date)
      .get();
 
    if (!existing.empty) {
      return res.json({
        success: false,
        message: "Lecture already cancelled",
      });
    }
 
    await db.collection("cancelled_lectures").add({
      lecture_id,
      teacher_id,   //  now saves Firestore doc ID, not auth UID
      date,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
 
    res.json({
      success: true,
      message: "Lecture cancelled successfully",
    });
 
  } catch (error) {
    console.error("CANCEL ERROR:", error);
    res.status(500).json({
      success: false,
      error: "Failed to cancel lecture",
    });
  }
});


router.get("/teachers/available", async (req, res) => {
  try {
    const { uid, date, start_time, end_time, lecture_id } = req.query;
 
    if (!uid || !date || !start_time || !end_time) {
      return res.status(400).json({
        success: false,
        error: "uid, date, start_time, end_time required",
      });
    }
 
    // ── FIX BUG 2 (backend guard): reject an empty/invalid date early ──────
    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return res.status(400).json({
        success: false,
        error: "date must be YYYY-MM-DD",
      });
    }
 
    const teacherSnap = await db
      .collection("teachers")
      .where("user_id", "==", uid)
      .limit(1)
      .get();
 
    if (teacherSnap.empty) {
      return res.status(404).json({ success: false, error: "Teacher not found" });
    }
 
    const requesterDoc = teacherSnap.docs[0];
    const { aishe_code } = requesterDoc.data();
    const requester_id = requesterDoc.id;
 
    const day = getDayNameFromDate(date);
 
    const [allTeachersSnap, busyIds] = await Promise.all([
      db.collection("teachers").where("aishe_code", "==", aishe_code).get(),
      // ── FIX BUG 1: exclude the lecture being assigned so its teacher ──────
      // ── is not marked busy (prevents self-block on same-day lectures) ──────
      getBusyTeacherIds({ aishe_code, date, start_time, end_time, day, exclude_lecture_id: lecture_id || null }),
    ]);
 
    const available = [];
 
    allTeachersSnap.docs.forEach((doc) => {
      if (doc.id === requester_id) return;
      if (busyIds.has(doc.id)) return;
      const d = doc.data();
      const name =
        d.name ||
        d.full_name ||
        (d.first_name ? `${d.first_name} ${d.last_name || ""}`.trim() : null) ||
        "Unknown";
      available.push({
        id: doc.id,
        name,
        designation: d.designation || "",
        department: d.department || (Array.isArray(d.departments) ? d.departments[0] : "") || "",
      });
    });
 
    return res.json({ success: true, available });
 
  } catch (error) {
    console.error("AVAILABLE TEACHERS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch available teachers" });
  }
});
 
/* ---------------------------------------------------------------
   POST /assign
   Body: { uid, lecture_id, assigned_teacher_id, date, start_time, end_time }
   Server re-validates before writing. Atomic transaction blocks duplicates.
--------------------------------------------------------------- */
router.post("/assign", async (req, res) => {
  try {
    const { uid, lecture_id, assigned_teacher_id, date, start_time, end_time } = req.body;
 
    if (!uid || !lecture_id || !assigned_teacher_id || !date || !start_time || !end_time) {
      return res.status(400).json({
        success: false,
        error: "uid, lecture_id, assigned_teacher_id, date, start_time, end_time required",
      });
    }
 
    // Resolve original teacher
    const teacherSnap = await db
      .collection("teachers")
      .where("user_id", "==", uid)
      .limit(1)
      .get();
 
    if (teacherSnap.empty) {
      return res.status(404).json({ success: false, error: "Requesting teacher not found" });
    }
 
    const originalDoc = teacherSnap.docs[0];
    const original_teacher_id = originalDoc.id;
    const { aishe_code } = originalDoc.data();

    // Validate aishe_code was found
    if (!aishe_code) {
      return res.status(400).json({ success: false, error: "Teacher profile incomplete: missing aishe_code" });
    }

    // FIX: timezone-safe day computation
    const day = getDayNameFromDate(date);
 
    // Server-side re-validation — never trust frontend
    const busyIds = await getBusyTeacherIds({ aishe_code, date, start_time, end_time, day });
 
    if (busyIds.has(assigned_teacher_id)) {
      return res.status(409).json({
        success: false,
        error: "Teacher is no longer available for this slot",
      });
    }
 
    // 24hr expiry
    const expires_at = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 24 * 60 * 60 * 1000)
    );
 
    // Atomic transaction: guard duplicate + write
    const assignmentRef = db.collection("lecture_assignments").doc();
 
    await db.runTransaction(async (tx) => {
      const dupSnap = await db.collection("lecture_assignments")
        .where("lecture_id", "==", lecture_id)
        .where("date", "==", date)
        .where("status", "in", ["pending", "accepted"])
        .get();
 
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
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // FIX: resolve the user_id (auth UID) for the assigned teacher to send notification
    const assignedTeacherDoc = await db.collection("teachers").doc(assigned_teacher_id).get();
    if (assignedTeacherDoc.exists) {
      const assignedTeacherUserId = assignedTeacherDoc.data().user_id;
      notify({
        userIds: [assignedTeacherUserId],
        title: "📋 Lecture Assignment Request",
        body: `You have a new lecture request for ${date} at ${start_time}`,
        data: { screen: "TeacherHome" },
      });
    }
 
    return res.json({
      success: true,
      assignment_id: assignmentRef.id,
      message: "Assignment request sent",
    });
 
  } catch (error) {
    if (error.message === "ALREADY_ASSIGNED") {
      return res.status(409).json({
        success: false,
        error: "An active request for this lecture already exists",
      });
    }
    console.error("ASSIGN ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to create assignment" });
  }
});
 
/* ---------------------------------------------------------------
   POST /assign/respond
   Body: { uid, assignment_id, action: "accept" | "reject" }
   Re-validates on accept. Batch write: accept + temp session + expire others.
--------------------------------------------------------------- */
router.post("/assign/respond", async (req, res) => {
  try {
    const { uid, assignment_id, action } = req.body;
 
    if (!uid || !assignment_id || !["accept", "reject"].includes(action)) {
      return res.status(400).json({
        success: false,
        error: "uid, assignment_id, and action (accept|reject) required",
      });
    }
 
    // Resolve responding teacher
    const teacherSnap = await db
      .collection("teachers")
      .where("user_id", "==", uid)
      .limit(1)
      .get();
 
    if (teacherSnap.empty) {
      return res.status(404).json({ success: false, error: "Teacher not found" });
    }
 
    const respondingTeacherId = teacherSnap.docs[0].id;
    const assignmentRef = db.collection("lecture_assignments").doc(assignment_id);
 
    /* ---- REJECT ---- */
    if (action === "reject") {
      await assignmentRef.update({
        status: "rejected",
        responded_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ success: true, message: "Assignment rejected" });
    }
 
    /* ---- ACCEPT ---- */
    const assignmentDoc = await assignmentRef.get();
 
    if (!assignmentDoc.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }
 
    const assignment = assignmentDoc.data();
 
    if (assignment.assigned_teacher_id !== respondingTeacherId) {
      return res.status(403).json({ success: false, error: "Not your assignment" });
    }
 
    if (assignment.status !== "pending") {
      return res.status(409).json({
        success: false,
        error: assignment.status === "accepted" ? "Already accepted" : "Assignment no longer active",
      });
    }
 
    if (assignment.expires_at.toDate() < new Date()) {
      return res.status(410).json({ success: false, error: "Assignment request has expired" });
    }
 
    // Re-validate — exclude the lecture being accepted so the teacher's own
    // coverage of that slot isn't incorrectly flagged as a conflict.
    const [busyIds, otherPendingSnap] = await Promise.all([
      getBusyTeacherIds({
        aishe_code:          assignment.aishe_code,
        date:                assignment.date,
        start_time:          assignment.start_time,
        end_time:            assignment.end_time,
        day:                 assignment.day,
        exclude_lecture_id:  assignment.lecture_id,   // ← FIX BUG 1
      }),
      db.collection("lecture_assignments")
        .where("lecture_id", "==", assignment.lecture_id)
        .where("date",       "==", assignment.date)
        .where("status",     "==", "pending")
        .get(),
    ]);
 
    if (busyIds.has(respondingTeacherId)) {
      return res.status(409).json({
        success: false,
        error: "You have a conflicting lecture at this time",
      });
    }
 
    // Batch: accept + create temp session + expire all other pending for same lecture
    const sessionRef = db.collection("lecture_sessions").doc();
    const batch      = db.batch();
 
    // 1. Accept this assignment
    batch.update(assignmentRef, {
      status:        "accepted",
      session_id:    sessionRef.id,
      responded_at:  admin.firestore.FieldValue.serverTimestamp(),
    });
 
    // 2. Temp session for Teacher B
    batch.set(sessionRef, {
      lecture_id:           assignment.lecture_id,
      teacher_id:           respondingTeacherId,
      original_teacher_id:  assignment.original_teacher_id,
      assignment_id,
      aishe_code:           assignment.aishe_code,
      date:                 assignment.date,
      day:                  assignment.day,
      start_time:           assignment.start_time,
      end_time:             assignment.end_time,
      is_temporary:         true,
      is_live:              false,
      status:               "scheduled",
      created_at:           admin.firestore.FieldValue.serverTimestamp(),
    });
 
    // 3. Expire all other pending requests for same lecture+date
    otherPendingSnap.docs.forEach((doc) => {
      if (doc.id !== assignment_id) {
        batch.update(doc.ref, { status: "expired" });
      }
    });
 
    await batch.commit();
 
    const origTeacherDoc = await db.collection("teachers").doc(assignment.original_teacher_id).get();
    if (origTeacherDoc.exists) {
      notify({
        userIds: [origTeacherDoc.data().user_id],
        title:   " Lecture Accepted",
        body:    `Your lecture for ${assignment.date} has been accepted`,
        data:    { screen: "TeacherHome" },
      });
    }
 
    return res.json({
      success:    true,
      session_id: sessionRef.id,
      message:    "Assignment accepted. Lecture added to your schedule.",
    });
 
  } catch (error) {
    console.error("RESPOND ASSIGNMENT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to respond to assignment" });
  }
});
 
/* ---------------------------------------------------------------
   GET /assign/requests
   ?uid=
   Returns non-expired pending requests for Teacher B.
   Resolves original teacher names in one parallel batch.
--------------------------------------------------------------- */
router.get("/assign/requests", async (req, res) => {
  try {
    const { uid } = req.query;
 
    if (!uid) {
      return res.status(400).json({ success: false, error: "uid required" });
    }
 
    const teacherSnap = await db
      .collection("teachers")
      .where("user_id", "==", uid)
      .limit(1)
      .get();
 
    if (teacherSnap.empty) {
      return res.status(404).json({ success: false, error: "Teacher not found" });
    }
 
    const teacher_id = teacherSnap.docs[0].id;
 
    // Fetch pending assignments without composite index requirement
    // Query only needs: assigned_teacher_id (eq) + status (eq)
    const allAssignmentsSnap = await db.collection("lecture_assignments")
      .where("assigned_teacher_id", "==", teacher_id)
      .where("status", "==", "pending")
      .get();
    
    // Filter by expiration time and sort in memory to avoid composite index
    const now = admin.firestore.Timestamp.now();
    const snap = {
      docs: allAssignmentsSnap.docs
        .filter(doc => doc.data().expires_at && doc.data().expires_at > now)
        .sort((a, b) => {
          const aTime = a.data().expires_at.toDate();
          const bTime = b.data().expires_at.toDate();
          return aTime - bTime;
        })
    };
 
    if (snap.docs.length === 0) return res.json({ success: true, requests: [] });
 
    // Resolve requester names — one doc read per unique original teacher, in parallel
    const uniqueOriginalIds = [...new Set(snap.docs.map((d) => d.data().original_teacher_id))];
 
    const originalDocs = await Promise.all(
      uniqueOriginalIds.map((id) => db.collection("teachers").doc(id).get())
    );
 
    const nameMap = {};
    originalDocs.forEach((doc) => {
      if (doc.exists) {
        const d = doc.data();
        nameMap[doc.id] = d.name || d.full_name || "Unknown";
      }
    });
 
    const requests = snap.docs.map((doc) => {
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
 
    return res.json({ success: true, requests });
 
  } catch (error) {
    console.error("FETCH REQUESTS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch requests" });
  }
});

router.get("/assign/sent", async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ success: false, error: "uid required" });
 
    const teacherSnap = await db
      .collection("teachers")
      .where("user_id", "==", uid)
      .limit(1)
      .get();
 
    if (teacherSnap.empty) {
      return res.status(404).json({ success: false, error: "Teacher not found" });
    }
 
    const teacher_id = teacherSnap.docs[0].id;
 
    // Fetch all assignments this teacher sent that are still pending or accepted
    const sentSnap = await db
      .collection("lecture_assignments")
      .where("original_teacher_id", "==", teacher_id)
      .where("status", "in", ["pending", "accepted", "rejected", "expired"])
      .get();
 
    // Only return ones created within last 48 hours to keep the list small
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
 
    const assignments = sentSnap.docs
      .filter((doc) => {
        const d = doc.data();
        // created_at is a server timestamp — guard if not yet populated
        const createdMs = d.created_at?.toDate?.()?.getTime?.() || 0;
        return createdMs >= cutoff;
      })
      .map((doc) => {
        const d = doc.data();
        return {
          assignment_id: doc.id,
          lecture_id:    d.lecture_id,
          date:          d.date,
          day:           d.day,
          start_time:    d.start_time,
          end_time:      d.end_time,
          status:        d.status,                                    // pending|accepted|rejected|expired
          expires_at:    d.expires_at?.toDate?.()?.toISOString?.() || null,
          created_at:    d.created_at?.toDate?.()?.toISOString?.() || null,
        };
      });
 
    return res.json({ success: true, assignments });
 
  } catch (error) {
    console.error("FETCH SENT ASSIGNMENTS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch sent assignments" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 📌 ADD THIS ROUTE TO lecture_routes.js
//
// GET /api/lectures/student/subjects
// Returns all subjects a student is enrolled in, with course names.
//
// Query: uid  (Firebase Auth UID of the student)
// ═══════════════════════════════════════════════════════════════════

router.get("/student/subjects", async (req, res) => {
  try {
    const { uid } = req.query;

    if (!uid) {
      return res.status(400).json({ success: false, error: "uid required" });
    }

    // 1. Get student profile to find enrolled_subjects
    const studentSnap = await db
      .collection("students")
      .where("uid", "==", uid)
      .limit(1)
      .get();

    if (studentSnap.empty) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }

    const student = studentSnap.docs[0].data();
    const enrolledSubjects = student.enrolled_subjects || [];

    if (enrolledSubjects.length === 0) {
      return res.json({ success: true, subjects: [] });
    }

    // 2. Fetch subjects in chunks (Firestore 'in' limit = 30)
    const CHUNK = 30;
    const subjectDocs= [];

    for (let i = 0; i < enrolledSubjects.length; i += CHUNK) {
      const chunk = enrolledSubjects.slice(i, i + CHUNK);
      const snap = await db
        .collection("subjects")
        .where(admin.firestore.FieldPath.documentId(), "in", chunk)
        .get();
      snap.docs.forEach((doc) => subjectDocs.push({ id: doc.id, ...doc.data() }));
    }

    // 3. Fetch course names for all unique course_ids
    const uniqueCourseIds = [...new Set(subjectDocs.map((s) => s.course_id).filter(Boolean))];
    const courseMap = {};

    await Promise.all(
      uniqueCourseIds.map(async (cid) => {
        const courseDoc = await db.collection("courses").doc(cid).get();
        if (courseDoc.exists) {
          courseMap[cid] = courseDoc.data()?.course_name || "Unknown Course";
        }
      })
    );

    // 4. Build response
    const subjects = subjectDocs.map((s) => ({
      subject_id:   s.id,
      subject_name: s.subject_name,
      subject_code: s.subject_code || null,
      course_id:    s.course_id || null,
      course_name:  s.course_id ? (courseMap[s.course_id] || "Unknown Course") : "Unknown Course",
    }));

    return res.json({ success: true, subjects });
  } catch (error) {
    console.error("STUDENT SUBJECTS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch subjects" });
  }
});

router.get("/teachers/subjects", async (req, res) => {
  try {

    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({
        error: "teacher_id required"
      });
    }

    const subjectSnap = await db
      .collection("subjects")
      .where("teacher_assigned", "==", teacher_id)
      .get();

    if (subjectSnap.empty) {
      return res.json({
        success: true,
        subjects: []
      });
    }

    /* ------------------------------------------------- */
    /* Fetch course names for all unique course_ids      */
    /* ------------------------------------------------- */

    const uniqueCourseIds = [
      ...new Set(
        subjectSnap.docs
          .map(doc => doc.data().course_id)
          .filter(Boolean)
      ),
    ];

    const courseMap = {};
    await Promise.all(
      uniqueCourseIds.map(async (cid) => {
        const courseSnap = await db.collection("courses").doc(cid).get();
        if (courseSnap.exists) {
          const d = courseSnap.data();
          courseMap[cid] = {
            course_name: d.course_name || "Unknown Course",
          };
        }
      })
    );

    const subjects = subjectSnap.docs.map(doc => {
      const data = doc.data();
      const cid = data.course_id || null;
      return {
        subject_id:   doc.id,
        subject_name: data.subject_name,
        subject_code: data.subject_code,
        course_id:    cid,
        course_name:  cid ? (courseMap[cid]?.course_name || "Unknown Course") : "Unknown Course",
      };
    });

    return res.json({
      success: true,
      subjects
    });

  } catch (error) {

    console.error("FETCH TEACHER SUBJECTS ERROR:", error);

    res.status(500).json({
      error: "Failed to fetch subjects"
    });

  }
});

router.post("/start", async (req, res) => {
  try {
    const {
      lecture_id,
      teacher_id,
      subject_name,
      room,
      aishe_code,
      scheduled_start_time,
      scheduled_end_time,
      // teacher_coordinates intentionally removed — GPS no longer used
    } = req.body;
 
    if (!teacher_id || !subject_name || !aishe_code) {
      return res.status(400).json({ error: "Missing required lecture details" });
    }
 
    // Resolve course_id from the lecture document for per-course filtering
    let course_id = null;
    if (lecture_id) {
      const lectureDoc = await db.collection("lectures").doc(lecture_id).get();
      if (lectureDoc.exists) {
        course_id = lectureDoc.data().course_id || null;
      }
    }
 
    const sessionData = {
      lecture_id:           lecture_id || null,
      teacher_id,
      aishe_code,
      course_id,
      subject_name,
      room:                 room || null,
      is_live:              true,
      // No GPS coordinates stored — proximity handled via WiFi + BLE at attendance time
      started_at:           admin.firestore.FieldValue.serverTimestamp(),
      scheduled_start_time: scheduled_start_time || null,
      scheduled_end_time:   scheduled_end_time   || null,
      status:               "ongoing",
      marking_status:       "closed",
      marking_method:       null,
      attendance_session_id: null,
    };
 
    const docRef = await db.collection("lecture_sessions").add(sessionData);
 
    res.status(201).json({
      success: true,
      message: "Lecture started successfully",
      session_id: docRef.id,
    });
 
  } catch (error) {
    console.error("START LECTURE ERROR:", error);
    res.status(500).json({ error: "Failed to start lecture session" });
  }
});

router.post("/stop", async (req, res) => {
  try {
    const { lecture_session_id } = req.body;
 
    if (!lecture_session_id) {
      return res.status(400).json({ error: "Missing lecture_session_id" });
    }
 
    const sessionRef = db.collection("lecture_sessions").doc(lecture_session_id);
    const sessionDoc = await sessionRef.get();
 
    if (!sessionDoc.exists) {
      return res.status(404).json({ error: "Lecture session not found" });
    }
 
    const sessionData = sessionDoc.data();
 
    //  FIX: use a batch so is_live=false AND attendance_session close
    // happen atomically — student Firestore listener sees both together
    const batch = db.batch();
 
    batch.update(sessionRef, {
      is_live: false,
      ended_at: admin.firestore.FieldValue.serverTimestamp(),
      status: "completed",
      marking_status: "closed",   //  close attendance window if open
    });
 
    // If an attendance session was open, close it too
    if (sessionData.attendance_session_id) {
      const attRef = db
        .collection("attendance_sessions")
        .doc(sessionData.attendance_session_id);
      const attDoc = await attRef.get();
      if (attDoc.exists && attDoc.data().marking_status === "open") {
        batch.update(attRef, {
          marking_status: "closed",
          ended_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
 
    await batch.commit();
 
    res.json({ success: true, message: "Lecture stopped successfully" });
 
  } catch (error) {
    console.error("STOP LECTURE ERROR:", error);
    res.status(500).json({ error: "Failed to stop lecture session" });
  }
});

router.get("/student/today", async (req, res) => {
  try {
    const uid = req.user?.uid || req.query.uid;
    if (!uid) return res.status(400).json({ error: "Student uid required" });

    const studentSnap = await db.collection("students").where("uid", "==", uid).limit(1).get();
    if (studentSnap.empty) return res.status(404).json({ error: "Student profile not found" });

    const student     = studentSnap.docs[0].data();
    const aishe_code  = student.aishe_code;
    const course_name = student.course_name;

    const courseSnap = await db.collection("courses")
      .where("course_name", "==", course_name)
      .where("aishe_code", "==", aishe_code)
      .limit(1)
      .get();
    const course_id = courseSnap.empty ? null : courseSnap.docs[0].id;

    // FIX: Always use IST (+5:30) for time comparisons so "ongoing" detection
    // matches the same timezone used everywhere else in the teacher routes.
    // Using raw server local time (UTC on most servers) was 5.5 hours behind IST,
    // causing lectures to show as "ongoing" long after they had ended.
    const IST_OFFSET     = 330 * 60 * 1000; // +5:30 in ms
    const nowIST         = new Date(new Date().getTime() + IST_OFFSET);
    const DAY_NAMES_IST  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const today          = DAY_NAMES_IST[nowIST.getUTCDay()];
    const currentMinutes = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();

    // ── Check for a live session ──────────────────────────────────────────
    const liveSessions = await db.collection("lecture_sessions")
      .where("aishe_code", "==", aishe_code)
      .where("is_live", "==", true)
      .get();

    const matchingSessions = liveSessions.docs.filter((d) => {
      const data = d.data();
      if (!data.course_id || !course_id) return true;
      return data.course_id === course_id;
    });

    if (matchingSessions.length > 0) {
      const sessionDoc = matchingSessions[0];
      const session    = sessionDoc.data();

      if (!session.lecture_id) {
        return res.json({
          success:               true,
          ongoingLecture:        { subject_name: session.subject_name, room: session.room, start_time: session.scheduled_start_time, end_time: session.scheduled_end_time },
          nextLecture:           null,
          lecture_session_id:    sessionDoc.id,
          lecture_is_live:       true,
          marking_method:        session.marking_method        || null,
          marking_status:        session.marking_status        || "closed",
          attendance_session_id: session.attendance_session_id || null,
          today,
        });
      }

      const lectureDoc = await db.collection("lectures").doc(session.lecture_id).get();
      return res.json({
        success:               true,
        ongoingLecture:        lectureDoc.exists ? { id: lectureDoc.id, ...lectureDoc.data() } : null,
        nextLecture:           null,
        lecture_session_id:    sessionDoc.id,
        lecture_is_live:       true,
        marking_method:        session.marking_method        || null,
        marking_status:        session.marking_status        || "closed",
        attendance_session_id: session.attendance_session_id || null,
        today,
      });
    }

    // ── No live session — fall back to timetable for "next lecture" only ──
    // FIX: We no longer return an ongoingLecture from the timetable.
    // The timetable only knows scheduled times — it cannot know if the teacher
    // actually started the session. Only is_live=true in Firestore is authoritative.
    // Previously this path would show a lecture as "ongoing" based purely on
    // clock time even if no session was ever started (or had already been ended).
    if (!course_id) {
      return res.json({
        success: true, ongoingLecture: null, nextLecture: null,
        lecture_session_id: null, lecture_is_live: false, today,
      });
    }

    const lectureSnap = await db.collection("lectures")
      .where("aishe_code", "==", aishe_code)
      .where("course_id", "==", course_id)
      .where("day", "==", today)
      .get();

    const lectures = lectureSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const toMinutes = (time) => {
      if (!time || !time.includes(":")) return 0;
      const [h, m] = time.split(":").map(Number);
      return h * 60 + m;
    };

    // FIX: Only compute nextLecture from timetable — never ongoingLecture.
    // ongoingLecture is only set by a real live Firestore session above.
    let nextLecture = null;
    const sorted = lectures.sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
    for (const lecture of sorted) {
      const start = toMinutes(lecture.start_time);
      if (!nextLecture && start > currentMinutes) nextLecture = lecture;
    }

    res.json({
      success: true, ongoingLecture: null, nextLecture,
      lecture_session_id: null, lecture_is_live: false, today,
    });
  } catch (error) {
    console.error("STUDENT LECTURE ERROR:", error);
    res.status(500).json({ error: "Failed to fetch student lectures" });
  }
});

router.post("/attendance/start", async (req, res) => {
  try {
    const {
      lecture_session_id,
      marking_method,
      // WiFi + BLE fields sent by teacher when using bio_wifi_ble method
      teacher_wifi_scan,  // array of { ssid, bssid, rssi }
      ble_service_uuid,   // string UUID broadcast by teacher's BLE beacon
    } = req.body;

    if (!lecture_session_id || !marking_method) {
      return res.status(400).json({
        success: false,
        error: "lecture_session_id and marking_method required",
      });
    }

    const sessionRef = db.collection("lecture_sessions").doc(lecture_session_id);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
      return res.status(404).json({ success: false, error: "Lecture session not found" });
    }

    const sessionData = sessionDoc.data();

    /* ── IDEMPOTENCY: return existing open session if present ── */
    if (sessionData.attendance_session_id) {
      const existingSnap = await db
        .collection("attendance_sessions")
        .doc(sessionData.attendance_session_id)
        .get();

      if (existingSnap.exists && existingSnap.data().marking_status === "open") {
        const existing = existingSnap.data();
        let code = existing.attendance_code || null;

        // FIX: if code was deleted (e.g. from a previous close) regenerate it
        if (!code && (existing.marking_method || marking_method) === "code") {
          code = Math.floor(100 + Math.random() * 900).toString();
          await db.collection("attendance_sessions").doc(existingSnap.id).update({
            attendance_code: code,
          });
        }

        return res.json({
          success: true,
          attendance_session_id: existingSnap.id,
          attendance_code: code,
          already_exists: true,
        });
      }
    }

    /* ── Generate attendance code for "code" method ── */
    const attendance_code =
      marking_method === "code"
        ? Math.floor(100 + Math.random() * 900).toString()
        : null;

    /* ── Build attendance session document ──
       For bio_wifi_ble: store WiFi fingerprint + BLE UUID instead of GPS coords.
       For code / iot: no location data of any kind needed.
       teacher_coordinates is intentionally omitted — GPS is fully removed.
    ── */
    const attendanceData = {
      lecture_session_id,
      lecture_id:      sessionData.lecture_id || null,
      teacher_id:      sessionData.teacher_id,
      marking_method,
      marking_status:  "open",
      attendance_code,
      started_at:      admin.firestore.FieldValue.serverTimestamp(),
      // WiFi + BLE fields (null when not bio_wifi_ble)
      teacher_wifi_scan:  (marking_method === "bio_wifi_ble" && Array.isArray(teacher_wifi_scan))
                            ? teacher_wifi_scan
                            : null,
      ble_service_uuid:   (marking_method === "bio_wifi_ble" && ble_service_uuid)
                            ? ble_service_uuid
                            : null,
    };

    const attendanceRef = await db.collection("attendance_sessions").add(attendanceData);

    /* ── Link back to lecture session ── */
    await sessionRef.update({
      attendance_session_id: attendanceRef.id,
      marking_status: "open",
      marking_method,
    });

    res.json({
      success: true,
      attendance_session_id: attendanceRef.id,
      attendance_code,
    });

  } catch (error) {
    console.error("START ATTENDANCE ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to start attendance" });
  }
});

router.post("/attendance/close", async (req, res) => {
  try {
    const { lecture_session_id } = req.body;

    const sessionRef = db
      .collection("lecture_sessions")
      .doc(lecture_session_id);

    const doc = await sessionRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const { attendance_session_id } = doc.data();

    if (!attendance_session_id) {
      return res.status(400).json({
        error: "Attendance session not found",
      });
    }

    await db
      .collection("attendance_sessions")
      .doc(attendance_session_id)
      .update({
        marking_status: "closed",
        attendance_code: admin.firestore.FieldValue.delete(),
        ended_at: admin.firestore.FieldValue.serverTimestamp(),
      });

    await sessionRef.update({
      marking_status: "closed",
    });

    // Purge cache so no stale "open" data lingers after close
    cacheInvalidate(`att:${attendance_session_id}`);
    // Also clean up BLE readings for this session
    _bleReadings.delete(attendance_session_id);

    res.json({ success: true });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to close attendance" });
  }
});

router.get("/attendance/method", async (req, res) => {
  try {

    const { lecture_session_id } = req.query;

    const session = await db
      .collection("lecture_sessions")
      .doc(lecture_session_id)
      .get();

    if (!session.exists) {
      return res.json({ success: false });
    }

    const data = session.data();

    res.json({
      success: true,
      marking_method: data.marking_method,
      attendance_session_id: data.attendance_session_id
    });

  } catch (e) {
    res.status(500).json({ error: "Failed to fetch method" });
  }
});

router.get("/attendance/code-options", async (req, res) => {
  try {
    const { lecture_session_id } = req.query;

    if (!lecture_session_id) {
      return res.status(400).json({
        error: "lecture_session_id required",
      });
    }

    const sessionSnap = await db
      .collection("lecture_sessions")
      .doc(lecture_session_id)
      .get();

    if (!sessionSnap.exists) {
      return res.status(404).json({
        error: "Lecture session not found",
      });
    }

    const sessionData = sessionSnap.data();

    const attendanceSessionId = sessionData.attendance_session_id;

    if (!attendanceSessionId) {
      return res.status(404).json({
        error: "Attendance session not started",
      });
    }

    const attendanceSnap = await db
      .collection("attendance_sessions")
      .doc(attendanceSessionId)
      .get();

    if (!attendanceSnap.exists) {
      return res.status(404).json({
        error: "Attendance session missing",
      });
    }

    const attendanceData = attendanceSnap.data();

    const correctCode = attendanceData.attendance_code;

    /* ----------------------------- */
    /* Generate two fake codes */
    /* ----------------------------- */

    const generateFakeCode = () =>
      Math.floor(100 + Math.random() * 900).toString();

    let fake1 = generateFakeCode();
    let fake2 = generateFakeCode();

    while (fake1 === correctCode) {
      fake1 = generateFakeCode();
    }

    while (fake2 === correctCode || fake2 === fake1) {
      fake2 = generateFakeCode();
    }

    /* ----------------------------- */
    /* Shuffle options */
    /* ----------------------------- */

    const options = [correctCode, fake1, fake2];

    const shuffled = options.sort(() => Math.random() - 0.5);

    res.json({
      success: true,
      options: shuffled,
      attendance_session_id: attendanceSessionId,
    });

  } catch (error) {
    console.error("CODE OPTIONS ERROR:", error);
    res.status(500).json({
      error: "Failed to fetch code options",
    });
  }
});

// ─── REMOVED: /attendance/validate-location (GPS-based) ───────────────────────
// GPS is fully replaced by WiFi fingerprint + BLE RSSI.
// Proximity is now validated server-side inside /attendance/mark-bio.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /attendance/validate-wifi-ble
 *
 * Standalone check (optional — mark-bio also does this internally).
 * Lets the client verify proximity before triggering biometric auth,
 * so the student gets fast feedback if they are clearly out of the room.
 *
 * Body:
 *   attendance_session_id  string
 *   student_wifi_scan      [{ ssid, bssid, rssi }]
 *   ble_rssi               number | null   (best RSSI from teacher beacon scan)
 */
router.post("/attendance/validate-wifi-ble", async (req, res) => {
  try {
    const { attendance_session_id, student_wifi_scan, ble_rssi } = req.body;

    if (!attendance_session_id) {
      return res.status(400).json({ success: false, error: "attendance_session_id required" });
    }

    const session = await getAttendanceSession(attendance_session_id);
    if (!session) {
      return res.status(404).json({ success: false, error: "Attendance session not found" });
    }

    if (session.marking_status !== "open") {
      return res.json({ success: false, in_room: false, message: "Attendance is closed", error_type: "closed" });
    }

    const { verdict, soft_warning, score, breakdown, reason, error_type } = checkProximity({
      sessionId:        attendance_session_id,
      teacherWifi:      session.teacher_wifi_scan || [],
      studentWifi:      student_wifi_scan         || [],
      bleRssi:          ble_rssi ?? null,
      sessionStartedAt: session.started_at,
    });

    return res.json({ success: true, in_room: verdict, soft_warning, score, breakdown, message: reason, error_type });

  } catch (error) {
    console.error("VALIDATE WIFI BLE ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to validate proximity" });
  }
});

/**
 * POST /attendance/mark-code
 *
 * Marks attendance via:
 *   1. Correct code selection
 *   2. Weighted proximity score: WiFi 50% + BLE 40% + Time 10%
 *
 * Reads cached to minimise Firestore costs.
 */
router.post("/attendance/mark-code", async (req, res) => {
  try {
    const {
      attendance_session_id,
      selected_code,
      uid,
      student_wifi_scan,
      ble_rssi,
    } = req.body;

    if (!attendance_session_id || !selected_code || !uid) {
      return res.status(400).json({
        success: false,
        error: "attendance_session_id, selected_code, uid required",
      });
    }

    // ── Parallel fetch: session + duplicate record check ────────────────
    const [attendanceData, recordSnap] = await Promise.all([
      getAttendanceSession(attendance_session_id),
      db.collection("attendance_records").doc(`${attendance_session_id}_${uid}`).get(),
    ]);

    if (!attendanceData) {
      return res.status(404).json({ success: false, error: "Attendance session not found" });
    }

    // ── Session must be open ────────────────────────────────────────────
    if (attendanceData.marking_status !== "open") {
      return res.json({ success: false, message: "Attendance is closed", error_type: "closed" });
    }

    // ── Code check — fast fail before proximity ─────────────────────────
    if (selected_code !== attendanceData.attendance_code) {
      return res.json({ success: false, message: "Incorrect code. Choose the code shown by your teacher.", error_type: "wrong_code" });
    }

    // ── Already marked? ─────────────────────────────────────────────────
    if (recordSnap.exists && recordSnap.data().status === "present") {
      return res.json({ success: true, already_marked: true, message: "Attendance already marked" });
    }

    // ── Proximity check (only if teacher sent a WiFi fingerprint) ────────
    if (attendanceData.teacher_wifi_scan?.length > 0) {
      const { verdict, soft_warning, score, breakdown, reason, error_type } = checkProximity({
        sessionId:        attendance_session_id,
        teacherWifi:      attendanceData.teacher_wifi_scan || [],
        studentWifi:      student_wifi_scan               || [],
        bleRssi:          ble_rssi ?? null,
        sessionStartedAt: attendanceData.started_at,
      });

      if (!verdict) {
        return res.json({ success: false, soft_warning, score, breakdown, message: reason, error_type });
      }
    }

    // ── Fetch student (cached) ───────────────────────────────────────────
    const student = await getStudentByUid(uid);
    if (!student) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }

    const recordId = `${attendance_session_id}_${uid}`;

    // ── Batch write ──────────────────────────────────────────────────────
    const batch = db.batch();

    batch.set(db.collection("attendance_records").doc(recordId), {
      attendance_session_id,
      lecture_session_id: attendanceData.lecture_session_id,
      student_uid:   uid,
      student_name:  student.name        || "Unknown",
      student_roll:  student.roll_number || null,
      status:        "present",
      method:        "code",
      marked_at:     admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.update(db.collection("attendance_sessions").doc(attendance_session_id), {
      present_students: admin.firestore.FieldValue.arrayUnion(uid),
    });

    await batch.commit();
    cacheInvalidate(`att:${attendance_session_id}`);

    return res.json({ success: true, message: "Attendance marked successfully" });

  } catch (error) {
    console.error("MARK CODE ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to mark attendance" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   IN-MEMORY CACHE
   ═══════════════════════════════════════════════════════════════════════════
   Caches attendance session data and student profiles to avoid repeated
   Firestore reads within the same mark request burst (30-40 students hitting
   the endpoint simultaneously at the start of a class).

   TTL: 5 minutes — short enough that stale data never persists between sessions.
   ─────────────────────────────────────────────────────────────────────────── */
const _cache = new Map(); // key → { value, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) {
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}
function cacheInvalidate(key) {
  _cache.delete(key);
}

/**
 * Fetches an attendance session, using cache when possible.
 * Invalidated on close so stale "open" data never lingers.
 */
async function getAttendanceSession(attendance_session_id) {
  const cacheKey = `att:${attendance_session_id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const snap = await db.collection("attendance_sessions").doc(attendance_session_id).get();
  if (!snap.exists) return null;

  const result = { id: snap.id, ...snap.data() };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Fetches a student profile, using cache when possible.
 * Student data rarely changes during a session.
 */
async function getStudentByUid(uid) {
  const cacheKey = `student:${uid}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const snap = await db.collection("students").where("uid", "==", uid).limit(1).get();
  if (snap.empty) return null;

  const result = snap.docs[0].data();
  cacheSet(cacheKey, result);
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PROXIMITY SCORING ENGINE
   ═══════════════════════════════════════════════════════════════════════════

   Weighted score replaces the old binary pass/fail decision tree.

   ┌─────────────────────────┬────────┬─────────────────────────────────────┐
   │ Signal                  │ Weight │ How scored                          │
   ├─────────────────────────┼────────┼─────────────────────────────────────┤
   │ WiFi fingerprint match  │  50 %  │ (matched BSSIDs / teacher total)    │
   │                         │        │ × weighted by signal strength ratio │
   │ BLE RSSI                │  40 %  │ normalised -40 (best) → -100 (none) │
   │ Time consistency        │  10 %  │ request within session window?      │
   └─────────────────────────┴────────┴─────────────────────────────────────┘

   Total score 0–100.
     ≥ 65  → PASS
     50–64 → SOFT WARNING  (student asked to move closer, can retry)
     < 50  → FAIL

   Outlier guard: if a student's BLE RSSI is more than OUTLIER_DELTA below
   the session's running class median, their BLE score is capped at the
   median-adjusted value rather than hard-failed — protects students at
   the back of a large room.
   ─────────────────────────────────────────────────────────────────────────── */

const SCORE_PASS       = 65;   // ≥ this → mark present
const SCORE_SOFT_WARN  = 50;   // ≥ this → soft warning / retry
const BLE_BEST_RSSI    = -40;  // dBm reference for 100% BLE score
const BLE_WORST_RSSI   = -100; // dBm reference for 0% BLE score
const OUTLIER_DELTA    = 15;   // dBm below class median → outlier guard activates

// Per-session running median of BLE readings — kept in memory during a session.
// Shape: sessionId → number[]
const _bleReadings = new Map();

function recordBleReading(sessionId, rssi) {
  if (rssi === null || rssi === undefined) return;
  if (!_bleReadings.has(sessionId)) _bleReadings.set(sessionId, []);
  _bleReadings.get(sessionId).push(rssi);
}

function getClassBleMedian(sessionId) {
  const readings = _bleReadings.get(sessionId);
  if (!readings || readings.length === 0) return null;
  const sorted = [...readings].sort((a, b) => b - a); // descending
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Normalises a BLE RSSI value to [0, 1].
 * -40 dBm → 1.0  (right next to teacher)
 * -100 dBm → 0.0 (out of range)
 */
function normaliseBle(rssi) {
  if (rssi === null || rssi === undefined) return 0;
  const clamped = Math.max(BLE_WORST_RSSI, Math.min(BLE_BEST_RSSI, rssi));
  return (clamped - BLE_WORST_RSSI) / (BLE_BEST_RSSI - BLE_WORST_RSSI);
}

/**
 * Computes a WiFi match score [0, 1].
 *
 * Each matched BSSID is weighted by how strong the signal is relative
 * to the teacher's scan — a matching AP at -60 dBm on both sides
 * contributes more than one at -90 dBm. This prevents a false-positive
 * from a single distant AP that happens to be visible campus-wide.
 */
function computeWifiScore(teacherWifi, studentWifi) {
  if (!teacherWifi?.length || !studentWifi?.length) return 0;

  // Build teacher BSSID → rssi lookup
  const teacherMap = new Map(
    teacherWifi.map((n) => [n.bssid?.toLowerCase(), n.rssi ?? -100])
  );
  const studentMap = new Map(
    studentWifi.map((n) => [n.bssid?.toLowerCase(), n.rssi ?? -100])
  );

  let weightedMatchSum = 0;
  let totalTeacherWeight = 0;

  for (const [bssid, tRssi] of teacherMap) {
    if (!bssid) continue;
    // Signal strength as a weight: stronger AP → higher weight
    const tNorm = normaliseBle(tRssi); // reuse same normaliser; -40→1, -100→0
    totalTeacherWeight += tNorm;

    if (studentMap.has(bssid)) {
      const sRssi = studentMap.get(bssid);
      // Both sides see this AP — weight by the weaker of the two readings
      const contributionWeight = Math.min(tNorm, normaliseBle(sRssi));
      weightedMatchSum += contributionWeight;
    }
  }

  if (totalTeacherWeight === 0) return 0;
  return weightedMatchSum / totalTeacherWeight;
}

/**
 * Time consistency score [0, 1].
 *
 * A request made within the first CONSISTENT_WINDOW_MS of the session
 * opening scores 1.0. After that it linearly decays to 0.5 at 60 min,
 * reflecting that late requests are more suspicious but not disqualifying.
 * If we can't determine session age, return 0.5 (neutral).
 */
const CONSISTENT_WINDOW_MS = 5 * 60 * 1000; // first 5 min → full score

function computeTimeScore(sessionStartedAt) {
  if (!sessionStartedAt) return 0.5;
  const startMs = typeof sessionStartedAt.toDate === "function"
    ? sessionStartedAt.toDate().getTime()
    : new Date(sessionStartedAt).getTime();
  const ageMs = Date.now() - startMs;

  if (ageMs <= CONSISTENT_WINDOW_MS) return 1.0;

  // Decay from 1.0 at 5 min to 0.5 at 60 min, then floor at 0.5
  const decay = (ageMs - CONSISTENT_WINDOW_MS) / (55 * 60 * 1000);
  return Math.max(0.5, 1.0 - decay * 0.5);
}

/**
 * Main proximity scorer.
 *
 * @param {object} opts
 * @param {string}      opts.sessionId       — used for class BLE median tracking
 * @param {Array}       opts.teacherWifi     — teacher scan [{ bssid, rssi }]
 * @param {Array}       opts.studentWifi     — student scan [{ bssid, rssi }]
 * @param {number|null} opts.bleRssi         — student's best beacon RSSI
 * @param {any}         opts.sessionStartedAt — Firestore Timestamp or ISO string
 *
 * @returns {{
 *   verdict:      boolean,
 *   soft_warning: boolean,
 *   score:        number,        // 0–100, returned to client for transparency
 *   breakdown:    object,        // per-component scores for debugging
 *   reason:       string,        // human-readable message for UX
 *   error_type:   string,        // machine-readable tag for frontend branching
 * }}
 */
function checkProximity({ sessionId, teacherWifi, studentWifi, bleRssi, sessionStartedAt }) {

  // ── Record this reading into running class median ──────────────────────
  if (sessionId) recordBleReading(sessionId, bleRssi);

  // ── Outlier guard: adjust BLE score if student is far below class median ─
  let effectiveBleRssi = bleRssi;
  const classMedian = sessionId ? getClassBleMedian(sessionId) : null;

  if (
    classMedian !== null &&
    bleRssi !== null &&
    bleRssi !== undefined &&
    (classMedian - bleRssi) > OUTLIER_DELTA
  ) {
    // Student is significantly weaker than the class median — could be back
    // of room, could be outside. Cap their BLE score at median - OUTLIER_DELTA
    // rather than full penalty, giving benefit of the doubt.
    effectiveBleRssi = classMedian - OUTLIER_DELTA;
  }

  // ── Component scores (all 0–1) ─────────────────────────────────────────
  const wifiScore = computeWifiScore(teacherWifi, studentWifi);
  const bleScore  = normaliseBle(effectiveBleRssi);
  const timeScore = computeTimeScore(sessionStartedAt);

  // ── Weighted total (0–100) ─────────────────────────────────────────────
  const score = Math.round(
    (wifiScore * 50) +
    (bleScore  * 40) +
    (timeScore * 10)
  );

  const breakdown = {
    wifi: Math.round(wifiScore * 50),  // contribution out of 50
    ble:  Math.round(bleScore  * 40),  // contribution out of 40
    time: Math.round(timeScore * 10),  // contribution out of 10
    total: score,
  };

  // ── Human-readable diagnostic for UX ──────────────────────────────────
  const bleFound = bleRssi !== null && bleRssi !== undefined;

  // ── Verdict ────────────────────────────────────────────────────────────
  if (score >= SCORE_PASS) {
    return {
      verdict: true, soft_warning: false, score, breakdown,
      reason:     "Proximity confirmed.",
      error_type: "none",
    };
  }

  if (score >= SCORE_SOFT_WARN) {
    // Score is borderline — give specific actionable reason
    let reason = "You seem to be at the edge of the classroom.";
    let error_type = "marginal";

    if (bleScore < 0.3 && wifiScore > 0.3) {
      reason     = "WiFi looks good but your Bluetooth signal is weak. Move closer to the teacher.";
      error_type = "weak_ble";
    } else if (wifiScore < 0.3 && bleScore > 0.3) {
      reason     = "BLE signal detected but few WiFi networks matched. Are you near the classroom door?";
      error_type = "weak_wifi";
    }

    return { verdict: false, soft_warning: true, score, breakdown, reason, error_type };
  }

  // Hard fail — give the most specific reason possible
  if (!bleFound && wifiScore === 0) {
    return {
      verdict: false, soft_warning: false, score, breakdown,
      reason:     "No signal detected. Make sure WiFi and Bluetooth are turned ON and try again.",
      error_type: "no_signal",
    };
  }
  if (!bleFound) {
    return {
      verdict: false, soft_warning: false, score, breakdown,
      reason:     `WiFi match is too weak (${Math.round(wifiScore * 100)}%) and no Bluetooth beacon found. You appear to be outside the classroom.`,
      error_type: "too_far",
    };
  }
  return {
    verdict: false, soft_warning: false, score, breakdown,
    reason:     `Signal too weak to confirm you're in the room (score: ${score}/100). Move closer to the teacher and ensure Bluetooth is on.`,
    error_type: "too_far",
  };
}

/**
 * POST /attendance/mark-bio
 *
 * Marks a student present using:
 *   1. Biometric auth (done client-side; device_signature proves it ran)
 *   2. WiFi fingerprint match (server-side)
 *   3. BLE RSSI threshold check (server-side)
 *
 * GPS / coordinates are NOT used anywhere in this flow.
 */
/**
 * POST /attendance/mark-bio
 *
 * Marks a student present using:
 *   1. Biometric auth  (client-side; device_signature proves it ran)
 *   2. Weighted proximity score: WiFi 50% + BLE 40% + Time 10%
 *
 * Reads are batched/cached to minimise Firestore costs when 30-40
 * students hit this endpoint simultaneously.
 */
router.post("/attendance/mark-bio", async (req, res) => {
  try {
    const {
      attendance_session_id,
      uid,
      device_signature,
      student_wifi_scan,   // [{ ssid, bssid, rssi }]
      ble_rssi,            // number | null
    } = req.body;

    if (!attendance_session_id || !uid) {
      return res.status(400).json({ success: false, error: "attendance_session_id and uid required" });
    }

    // ── Parallel fetch: session + duplicate record check ────────────────
    const [attendanceData, recordSnap] = await Promise.all([
      getAttendanceSession(attendance_session_id),
      db.collection("attendance_records").doc(`${attendance_session_id}_${uid}`).get(),
    ]);

    if (!attendanceData) {
      return res.status(404).json({ success: false, error: "Attendance session not found" });
    }

    // ── Duplicate device signature ──────────────────────────────────────
    if (device_signature && attendanceData.last_device_signature === device_signature) {
      return res.json({ success: false, message: "Duplicate request detected" });
    }

    // ── Session must be open ────────────────────────────────────────────
    if (attendanceData.marking_status !== "open") {
      return res.json({ success: false, message: "Attendance is closed" });
    }

    // ── Already marked? ─────────────────────────────────────────────────
    if (recordSnap.exists && recordSnap.data().status === "present") {
      return res.json({ success: true, already_marked: true, message: "Attendance already marked" });
    }

    // ── Proximity check (bio_wifi_ble sessions only) ─────────────────────
    if (attendanceData.marking_method === "bio_wifi_ble") {
      const { verdict, soft_warning, score, breakdown, reason, error_type } = checkProximity({
        sessionId:        attendance_session_id,
        teacherWifi:      attendanceData.teacher_wifi_scan || [],
        studentWifi:      student_wifi_scan               || [],
        bleRssi:          ble_rssi ?? null,
        sessionStartedAt: attendanceData.started_at,
      });

      if (!verdict) {
        return res.json({ success: false, soft_warning, score, breakdown, message: reason, error_type });
      }
    }

    // ── Fetch student (cached) ───────────────────────────────────────────
    const student = await getStudentByUid(uid);
    if (!student) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }

    const recordId = `${attendance_session_id}_${uid}`;

    // ── Batch write: record + session update (2 writes, 1 round-trip) ───
    const batch = db.batch();

    batch.set(db.collection("attendance_records").doc(recordId), {
      attendance_session_id,
      lecture_session_id: attendanceData.lecture_session_id,
      student_uid:   uid,
      student_name:  student.name        || "Unknown",
      student_roll:  student.roll_number || null,
      status:        "present",
      method:        "bio_wifi_ble",
      marked_at:     admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.update(db.collection("attendance_sessions").doc(attendance_session_id), {
      present_students:      admin.firestore.FieldValue.arrayUnion(uid),
      last_device_signature: device_signature || null,
    });

    await batch.commit();

    // Invalidate cached session so next read sees updated present_students
    cacheInvalidate(`att:${attendance_session_id}`);

    return res.json({ success: true, message: "Attendance marked successfully" });

  } catch (error) {
    console.error("MARK BIO ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to mark attendance" });
  }
});

// Shared helper — resolves course_id and aishe_code from a lecture session
async function resolveCourseFromSession(sessionDoc) {
  const data = sessionDoc.data();

  let { course_id, aishe_code } = data;

  // Already have both — nothing to do
  if (course_id && aishe_code) return { course_id, aishe_code };

  // Fallback 1: try lecture_id → lectures collection
  if (!course_id && data.lecture_id) {
    const lectureDoc = await db.collection("lectures").doc(data.lecture_id).get();
    if (lectureDoc.exists) {
      course_id = course_id || lectureDoc.data().course_id;
      aishe_code = aishe_code || lectureDoc.data().aishe_code;
    }
  }

  // Fallback 2: try subject_id → subjects collection
  if (!course_id && data.subject_id) {
    const subjectDoc = await db.collection("subjects").doc(data.subject_id).get();
    if (subjectDoc.exists) {
      course_id = course_id || subjectDoc.data().course_id;
      aishe_code = aishe_code || subjectDoc.data().aishe_code;
    }
  }

  return { course_id, aishe_code };
}

router.get("/attendance/verify-students", async (req, res) => {
  try {
    const { attendance_session_id, lecture_session_id } = req.query;

    if (!attendance_session_id || !lecture_session_id) {
      return res.status(400).json({
        success: false,
        error: "attendance_session_id and lecture_session_id are required",
      });
    }

    const sessionDoc = await db
      .collection("lecture_sessions")
      .doc(lecture_session_id)
      .get();

    if (!sessionDoc.exists) {
      return res.status(404).json({ success: false, error: "Lecture session not found" });
    }

    const { course_id, aishe_code } = await resolveCourseFromSession(sessionDoc);

    if (!course_id || !aishe_code) {
      return res.status(400).json({
        success: false,
        error: `Could not resolve course_id or aishe_code. Session data: ${JSON.stringify(sessionDoc.data())}`,
      });
    }

    const courseDoc = await db.collection("courses").doc(course_id).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ success: false, error: "Course not found" });
    }
    const { course_name } = courseDoc.data();

    const studentsSnap = await db
      .collection("students")
      .where("course_name", "==", course_name)
      .where("aishe_code", "==", aishe_code)
      .get();

    if (studentsSnap.empty) {
      return res.json({ success: true, students: [] });
    }

    const recordsSnap = await db
      .collection("attendance_records")
      .where("attendance_session_id", "==", attendance_session_id)
      .get();

    const presentUids = new Set(
      recordsSnap.docs
        .filter((d) => d.data().status === "present")
        .map((d) => d.data().student_uid)
    );

    const students = studentsSnap.docs.map((doc) => {
      const data = doc.data();
      return {
        uid: data.uid,
        name: data.name || "Unknown",
        roll_no: data.roll_number || "-",
        is_present: presentUids.has(data.uid),
      };
    });

    students.sort((a, b) => {
      if (b.is_present !== a.is_present) return b.is_present ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    return res.json({ success: true, students });

  } catch (error) {
    console.error("VERIFY STUDENTS ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to fetch students" });
  }
});

router.post("/attendance/verify-attendance", async (req, res) => {
  try {
    const { attendance_session_id, lecture_session_id, verified_students } = req.body;

    if (!attendance_session_id || !lecture_session_id || !Array.isArray(verified_students)) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const sessionDoc = await db
      .collection("lecture_sessions")
      .doc(lecture_session_id)
      .get();

    if (!sessionDoc.exists) {
      return res.status(404).json({ success: false, error: "Lecture session not found" });
    }

    const { course_id, aishe_code } = await resolveCourseFromSession(sessionDoc);

    if (!course_id || !aishe_code) {
      return res.status(400).json({
        success: false,
        error: `Could not resolve course_id or aishe_code. Session data: ${JSON.stringify(sessionDoc.data())}`,
      });
    }

    const courseDoc = await db.collection("courses").doc(course_id).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ success: false, error: "Course not found" });
    }
    const { course_name } = courseDoc.data();

    const studentsSnap = await db
      .collection("students")
      .where("course_name", "==", course_name)
      .where("aishe_code", "==", aishe_code)
      .get();

    // Fetch all existing attendance records for this session upfront
    const existingRecordsSnap = await db
      .collection("attendance_records")
      .where("attendance_session_id", "==", attendance_session_id)
      .get();

    const existingByUid = {};
    existingRecordsSnap.docs.forEach((doc) => {
      const d = doc.data();
      existingByUid[d.student_uid] = d;
    });

    const verifiedSet = new Set(verified_students);
    const batch = db.batch();
    let marked_count   = 0;
    let unmarked_count = 0;
    let skipped_count  = 0;

    for (const doc of studentsSnap.docs) {
      const data      = doc.data();
      const uid       = data.uid;
      const recordId  = `${attendance_session_id}_${uid}`;
      const recordRef = db.collection("attendance_records").doc(recordId);
      const existing  = existingByUid[uid];

      const teacherSaysPresent = verifiedSet.has(uid);

      if (existing) {
        // Record already exists (written by QR scan or prior manual mark).
        // Only update if the teacher's decision differs from what's recorded.
        const alreadyPresent = existing.status === "present";

        if (teacherSaysPresent === alreadyPresent) {
          // No change needed — skip to avoid unnecessary writes
          skipped_count++;
          continue;
        }

        // Teacher is explicitly overriding — update status and flag it
        batch.update(recordRef, {
          status:              teacherSaysPresent ? "present" : "absent",
          verified_by_teacher: true,
          updated_at:          admin.firestore.FieldValue.serverTimestamp(),
        });

        teacherSaysPresent ? marked_count++ : unmarked_count++;

      } else {
        // No existing record — create one.
        // Teacher verified = present; not in list = absent.
        batch.set(recordRef, {
          attendance_session_id,
          lecture_session_id,
          student_uid:         uid,
          student_name:        data.name || "Unknown",
          student_roll:        data.roll_number || null,
          status:              teacherSaysPresent ? "present" : "absent",
          verified_by_teacher: true,
          method:              "manual_verify",
          marked_at:           admin.firestore.FieldValue.serverTimestamp(),
        });

        teacherSaysPresent ? marked_count++ : unmarked_count++;
      }
    }

    await batch.commit();

    return res.json({ success: true, marked_count, unmarked_count, skipped_count });

  } catch (error) {
    console.error("VERIFY ATTENDANCE ERROR:", error);
    res.status(500).json({ success: false, error: "Failed to verify attendance" });
  }
});

router.post("/attendance/mark-manual", async (req, res) => {
  try {
    const { attendance_session_id, lecture_session_id, student_uids } = req.body;
    if (!attendance_session_id || !lecture_session_id || !Array.isArray(student_uids) || student_uids.length === 0) {
      return res.status(400).json({ success: false, error: "Missing or invalid params" });
    }
 
    const sessionDoc = await db.collection("lecture_sessions").doc(lecture_session_id).get();
    if (!sessionDoc.exists) return res.status(404).json({ success: false, error: "Session not found" });
 
    const studentsSnap = await db.collection("students").where("uid", "in", student_uids).get();
    if (studentsSnap.empty) return res.status(404).json({ success: false, error: "No students found" });
 
    const existingSnap = await db.collection("attendance_records")
      .where("attendance_session_id", "==", attendance_session_id)
      .where("student_uid", "in", student_uids)
      .get();
 
    const alreadyMarked   = new Set();
    const teacherVerified = new Set();
    existingSnap.docs.forEach((doc) => {
      const d = doc.data();
      alreadyMarked.add(d.student_uid);
      if (d.verified_by_teacher) teacherVerified.add(d.student_uid);
    });
 
    const batch  = db.batch();
    const now    = admin.firestore.FieldValue.serverTimestamp();
    const marked  = [];
    const skipped = [];
 
    studentsSnap.docs.forEach((doc) => {
      const s = doc.data();
      if (alreadyMarked.has(s.uid) || teacherVerified.has(s.uid)) { skipped.push(s.uid); return; }
      const recordId = `${attendance_session_id}_${s.uid}`;
      const ref      = db.collection("attendance_records").doc(recordId);
      batch.set(ref, {
        attendance_session_id, lecture_session_id,
        student_uid:  s.uid, student_name: s.name, student_roll: s.roll_no,
        status: "present", method: "manual", marked_at: now,
      });
      marked.push(s.uid);
    });
 
    await batch.commit();
    return res.json({ success: true, marked_count: marked.length, skipped_count: skipped.length, marked_uids: marked });
  } catch (e) {
    console.error("MANUAL MARK ERROR:", e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});


router.post("/attendance/start-qr", async (req, res) => {
  try {
    const { lecture_session_id } = req.body;
 
    if (!lecture_session_id) {
      return res.status(400).json({
        success: false,
        error: "lecture_session_id required",
      });
    }
 
    // 1. Fetch lecture session
    const sessionRef = db.collection("lecture_sessions").doc(lecture_session_id);
    const sessionDoc = await sessionRef.get();
 
    if (!sessionDoc.exists) {
      return res.status(404).json({ success: false, error: "Lecture session not found" });
    }
 
    const sessionData = sessionDoc.data();
 
    if (!sessionData.is_live) {
      return res.status(400).json({ success: false, error: "Lecture session is not active" });
    }
 
    // 2. Prevent duplicate open attendance session
    if (sessionData.attendance_session_id) {
      const existingDoc = await db
        .collection("attendance_sessions")
        .doc(sessionData.attendance_session_id)
        .get();
 
      if (existingDoc.exists) {
        const existing = existingDoc.data();
        if (existing.marking_status === "open") {
          // Session already open — return existing tokens so teacher can resume
          const qr_link = `${process.env.WEB_APP_URL}/?token=${existing.qr_token}`;
          return res.json({
            success: true,
            attendance_session_id: sessionData.attendance_session_id,
            qr_token: existing.qr_token,
            display_code: existing.display_code,
            qr_link,
            resumed: true,
          });
        }
        if (existing.marking_status === "closed") {
          return res.status(409).json({
            success: false,
            error: "Attendance already completed for this lecture",
          });
        }
      }
    }
 
    // 3. Generate TOTP secret + QR token + 8-digit display code
    const totp_secret = speakeasy.generateSecret({ length: 20 }).base32;
    const qr_token    = uuidv4();
    const display_code = generate8DigitCode();
 
    // 4. Create attendance session
    const attendanceRef = await db.collection("attendance_sessions").add({
      lecture_session_id,
      lecture_id:    sessionData.lecture_id || null,
      teacher_id:    sessionData.teacher_id,
      marking_method: "qr_totp",
      marking_status: "open",
      attendance_code: null,
      totp_secret,
      qr_token,
      display_code,          // ← 8-digit code web app uses to find session
      started_at: admin.firestore.FieldValue.serverTimestamp(),
      ended_at: null,
      teacher_coordinates: sessionData.teacher_coordinates || null,
    });
 
    // 5. Link to lecture session
    await sessionRef.update({
      attendance_session_id: attendanceRef.id,
      marking_status: "open",
      marking_method: "qr_totp",
    });
 
    // 6. Respond
    const qr_link = `${process.env.WEB_APP_URL}/?token=${qr_token}`;
 
    return res.json({
      success: true,
      attendance_session_id: attendanceRef.id,
      qr_token,
      display_code,
      qr_link,
    });
 
  } catch (error) {
    console.error("START QR ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to start QR attendance session" });
  }
});

router.get("/attendance/qr-live", async (req, res) => {
  try {
    const { token, code } = req.query;
 
    if (!token && !code) {
      return res.status(400).json({ success: false, error: "token or code required" });
    }
 
    // Find attendance session
    let attendanceSnap;
    if (token) {
      attendanceSnap = await db
        .collection("attendance_sessions")
        .where("qr_token", "==", token)
        .limit(1)
        .get();
    } else {
      attendanceSnap = await db
        .collection("attendance_sessions")
        .where("display_code", "==", code)
        .where("marking_status", "==", "open")
        .limit(1)
        .get();
    }
 
    if (attendanceSnap.empty) {
      return res.status(404).json({ success: false, error: "Session not found" });
    }
 
    const attendanceDoc  = attendanceSnap.docs[0];
    const attendanceData = attendanceDoc.data();
 
    // Session closed?
    if (attendanceData.marking_status !== "open") {
      return res.json({
        success: true,
        status: "closed",
        qr_value: null,
        expires_in: null,
      });
    }
 
    // Generate TOTP — 5s step (matches mark-qr verification)
    const otp = speakeasy.totp({
      secret:   attendanceData.totp_secret,
      encoding: "base32",
      step:     5,
    });
 
    const nowSec     = Math.floor(Date.now() / 1000);
    const expires_in = 5 - (nowSec % 5);   // countdown within the current 5-second window
 
    // QR value: attendance_session_id + otp so student app can parse
    const qr_value = `PRESENCEPRO:${attendanceDoc.id}:${otp}`;
 
    return res.json({
      success:               true,
      status:                "open",
      qr_value,
      expires_in,
      attendance_session_id: attendanceDoc.id,
      lecture_session_id:    attendanceData.lecture_session_id || null,
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
      return res.status(400).json({
        success: false,
        error: "attendance_session_id and lecture_session_id required",
      });
    }
 
    const attRef = db.collection("attendance_sessions").doc(attendance_session_id);
    const attDoc = await attRef.get();
 
    if (!attDoc.exists) {
      return res.status(404).json({ success: false, error: "Attendance session not found" });
    }
 
    if (attDoc.data().marking_status === "closed") {
      // Idempotent — already closed, return success so client can continue
      return res.json({ success: true, already_closed: true });
    }
 
    // Close the attendance session
    await attRef.update({
      marking_status: "closed",
      ended_at: admin.firestore.FieldValue.serverTimestamp(),
    });
 
    // Update lecture session marking status
    await db.collection("lecture_sessions").doc(lecture_session_id).update({
      marking_status: "closed",
    });
 
    return res.json({ success: true });
 
  } catch (error) {
    console.error("CLOSE QR ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to close QR session" });
  }
});
 
router.post("/attendance/mark-qr", async (req, res) => {
  try {
    const { attendance_session_id, otp, uid } = req.body;
 
    if (!attendance_session_id || !otp || !uid) {
      return res.status(400).json({
        success: false,
        error: "attendance_session_id, otp, uid required",
      });
    }
 
    // 1. Fetch attendance session
    const attendanceRef  = db.collection("attendance_sessions").doc(attendance_session_id);
    const attendanceSnap = await attendanceRef.get();
 
    if (!attendanceSnap.exists) {
      return res.status(404).json({ success: false, error: "Attendance session not found" });
    }
 
    const attendanceData = attendanceSnap.data();
 
    // 2. Session must be open
    if (attendanceData.marking_status !== "open") {
      return res.status(400).json({ success: false, error: "Attendance session is closed" });
    }
 
    // 3. Verify TOTP
    // window: 1 on a 15-second step means we accept current ± 1 window = ±15 sec.
    // This comfortably covers the requested 3-second slack at window boundaries.
    const isValid = speakeasy.totp.verify({
      secret:   attendanceData.totp_secret,
      encoding: "base32",
      token:    otp,
      step:     5,
      window:   1,   // ← ±15 sec tolerance; covers 3-second scan delay easily
    });
 
    if (!isValid) {
      return res.json({
        success: false,
        error: "Invalid or expired QR code. Please scan the latest QR.",
      });
    }
 
    // 4. Idempotent — already marked?
    const recordId  = `${attendance_session_id}_${uid}`;
    const recordRef = db.collection("attendance_records").doc(recordId);
    const recordSnap = await recordRef.get();
 
    if (recordSnap.exists) {
      return res.json({ success: true, already_marked: true, message: "Attendance already marked" });
    }
 
    // 5. Fetch student details
    const studentSnap = await db
      .collection("students")
      .where("uid", "==", uid)
      .limit(1)
      .get();
 
    if (studentSnap.empty) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }
 
    const student = studentSnap.docs[0].data();
 
    // 6. Write attendance record
    await recordRef.set({
      attendance_session_id,
      lecture_session_id: attendanceData.lecture_session_id,
      student_uid:   uid,
      student_name:  student.name || "Unknown",
      student_roll:  student.roll_number || null,
      status:        "present",
      method:        "qr_totp",
      marked_at:     admin.firestore.FieldValue.serverTimestamp(),
    });
 
    return res.json({ success: true, message: "Attendance marked successfully" });
 
  } catch (error) {
    console.error("MARK QR ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to mark attendance" });
  }
});

// NOTE: verify-attendance is defined earlier in this file (single authoritative route)

router.post("/attendance/iot/mark", async (req, res) => {
  try {
    const {
      attendance_session_id,
      lecture_session_id,
      student_uid,
      student_roll,
      device_id,
    } = req.body;
 
    if (!attendance_session_id || !lecture_session_id) {
      return res.status(400).json({
        success: false,
        error: "attendance_session_id and lecture_session_id required",
      });
    }
 
    if (!student_uid && !student_roll) {
      return res.status(400).json({
        success: false,
        error: "Either student_uid or student_roll required",
      });
    }
 
    // 1. Verify attendance session is open
    const attRef  = db.collection("attendance_sessions").doc(attendance_session_id);
    const attSnap = await attRef.get();
 
    if (!attSnap.exists) {
      return res.status(404).json({ success: false, error: "Attendance session not found" });
    }
 
    const attData = attSnap.data();
 
    if (attData.marking_status !== "open") {
      return res.status(400).json({ success: false, error: "Attendance session is closed" });
    }
 
    if (attData.marking_method !== "iot") {
      return res.status(400).json({ success: false, error: "Session is not an IoT session" });
    }
 
    // 2. Resolve student — prefer UID, fallback to roll number
    let uid        = student_uid;
    let studentDoc = null;
 
    if (!uid && student_roll) {
      const snap = await db
        .collection("students")
        .where("roll_number", "==", student_roll)
        .limit(1)
        .get();
 
      if (snap.empty) {
        return res.status(404).json({ success: false, error: "Student not found" });
      }
 
      studentDoc = snap.docs[0].data();
      uid        = studentDoc.uid;
    }
 
    if (!studentDoc) {
      const snap = await db
        .collection("students")
        .where("uid", "==", uid)
        .limit(1)
        .get();
 
      if (!snap.empty) {
        studentDoc = snap.docs[0].data();
      }
    }
 
    // 3. Idempotent check — already marked?
    const recordId  = `${attendance_session_id}_${uid}`;
    const recordRef = db.collection("attendance_records").doc(recordId);
    const recordSnap = await recordRef.get();
 
    if (recordSnap.exists && recordSnap.data().status === "present") {
      return res.json({ success: true, already_marked: true, message: "Already marked" });
    }
 
    // 4. Write attendance record
    await recordRef.set(
      {
        attendance_session_id,
        lecture_session_id,
        student_uid:  uid,
        student_name: studentDoc?.name        || "Unknown",
        student_roll: studentDoc?.roll_number || student_roll || null,
        status:       "present",
        method:       "iot",
        device_id:    device_id || null,
        marked_at:    admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
 
    // 5. Also add to present_students array on the session (legacy support)
    await attRef.update({
      present_students: admin.firestore.FieldValue.arrayUnion(uid),
    });
 
    return res.json({
      success: true,
      message: `${studentDoc?.name || uid} marked present`,
    });
 
  } catch (error) {
    console.error("IOT MARK ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to mark attendance" });
  }
});
 
 
/**
 * GET /api/lectures/attendance/iot/session
 *
 * Called by the ESP32 to check if the session is still open (polling, e.g. every 30s).
 *
 * Query params:
 *   attendance_session_id=abc123
 *
 * Response:
 *   { success: true,  status: "open"   | "closed", attendance_session_id: "..." }
 *   { success: false, error: "..." }
 */
router.get("/attendance/iot/session", async (req, res) => {
  try {
    const { attendance_session_id } = req.query;
 
    if (!attendance_session_id) {
      return res.status(400).json({
        success: false,
        error: "attendance_session_id required",
      });
    }
 
    const attSnap = await db
      .collection("attendance_sessions")
      .doc(attendance_session_id)
      .get();
 
    if (!attSnap.exists) {
      return res.status(404).json({ success: false, error: "Session not found" });
    }
 
    const data = attSnap.data();
 
    return res.json({
      success:               true,
      status:                data.marking_status, // "open" or "closed"
      attendance_session_id: attSnap.id,
      marking_method:        data.marking_method,
    });
 
  } catch (error) {
    console.error("IOT SESSION CHECK ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to check session" });
  }
});

module.exports = router;