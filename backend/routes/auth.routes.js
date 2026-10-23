const express = require("express");
const router = express.Router();
const { admin, db } = require("../config/firebase");
const { verifyToken } = require("../middleware/auth");
const { TTLCache } = require("../utils/cache");
const { rateLimit } = require("../utils/limiter");
const { checkOtpToken, consumeOtpToken } = require("./otp.routes");
const { shouldAutoApprove } = require("../utils/autoApprove");
const { normalizePhone, PHONE_ERROR } = require("../utils/phone");

// Registration needs an e-mail OTP token (see otp.routes.js). Set REQUIRE_REGISTER_OTP=false only for local testing.
const REQUIRE_REGISTER_OTP = process.env.REQUIRE_REGISTER_OTP !== "false";

// ─── caches (reference data used by registration / login) ────────────────────
const refCache = new TTLCache({ max: 2000, ttlMs: 300_000 });
// "teachers whose user_id has stray whitespace" lookup table for the legacy login fallback
const teacherScanCache = new TTLCache({ max: 4, ttlMs: 60_000 });

// A whole campus can sit behind one IP, so keep this generous; it only stops scripted floods.
const registerLimiter = rateLimit({ windowMs: 60_000, max: 120, name: "register" });

const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

const isStr = (v) => typeof v === "string" && v.trim().length > 0;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────────────────
router.post("/register", registerLimiter, async (req, res) => {
  let uid = null;

  try {
    const { password, role, teacher, student } = req.body;
    let { email } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({
        error: "email, password and role are required",
      });
    }
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "email, password and role are required" });
    }
    email = email.trim().toLowerCase();

    if (REQUIRE_REGISTER_OTP && !(await checkOtpToken(email, "register", req.body.otp_token))) {
      return res.status(403).json({ error: "Email verification expired. Please verify your email again." });
    }

    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        error:
          "Password must be at least 8 characters long and include uppercase, lowercase, number, and special character",
      });
    }

    if (!["teacher", "student"].includes(role)) {
      return res.status(400).json({
        error: "Invalid role",
      });
    }

    if (role === "teacher") {
      if (
        !teacher ||
        !teacher.first_name ||
        !teacher.last_name ||
        !teacher.contact_phone ||
        !teacher.gender ||
        !teacher.aishe_code ||
        !Array.isArray(teacher.departments) ||
        teacher.departments.length === 0 ||
        !teacher.designation
      ) {
        return res.status(400).json({
          error: "Incomplete teacher data",
        });
      }
      // the phone must be a real Indian mobile number; it is stored as +91XXXXXXXXXX
      teacher.contact_phone = normalizePhone(teacher.contact_phone);
      if (!teacher.contact_phone) return res.status(400).json({ error: PHONE_ERROR });
    }

    if (role === "student") {
      if (
        !student ||
        !student.first_name ||
        !student.last_name ||
        !student.roll_no ||
        !student.course_name ||
        !student.semester ||
        !student.aishe_code
      ) {
        return res.status(400).json({
          error: "Incomplete student data",
        });
      }
      if (!isStr(student.degree)) {
        return res.status(400).json({ error: "Incomplete student data" });
      }
      // the phone is optional for students, but when given it must be a real Indian mobile number
      if (student.phone !== undefined && student.phone !== null && String(student.phone).trim() !== "") {
        student.phone = normalizePhone(student.phone);
        if (!student.phone) return res.status(400).json({ error: PHONE_ERROR });
      } else {
        student.phone = null;
      }
    }

    // ── Student: validate college / course / subjects BEFORE creating the
    //    Firebase user, so a bad request never creates (and then has to delete)
    //    an auth account. Lookups are cached and run in parallel.
    let studentPlan = null;
    if (role === "student") {
      let normalizedSemester = student.semester;
      if (typeof normalizedSemester === "string") {
        normalizedSemester = normalizedSemester.replace(/[^0-9]/g, "");
      }
      normalizedSemester = Number(normalizedSemester);
      if (!Number.isInteger(normalizedSemester) || normalizedSemester < 1 || normalizedSemester > 12) {
        return res.status(400).json({ error: "Invalid semester" });
      }
      const semesterString = `Sem ${normalizedSemester}`;
      const aishe = String(student.aishe_code);

      const [collegeData, courseInfo] = await Promise.all([
        refCache.memo(`college:${aishe}`, 300_000, async () => {
          const snap = await db.collection("colleges").where("aishe_code", "==", aishe).limit(1).get();
          return snap.empty ? null : snap.docs[0].data();
        }),
        refCache.memo(`course:${aishe}:${student.degree}`, 300_000, async () => {
          const snap = await db
            .collection("courses")
            .where("abbr", "==", student.degree)
            .where("aishe_code", "==", aishe)
            .limit(1)
            .get();
          return snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() };
        }),
      ]);

      if (!collegeData) throw new Error("College not found while registering student");
      if (!courseInfo) throw new Error("Course not found for this college");

      // compulsory subjects change when a head edits the curriculum -> cache only briefly
      const enrolledSubjects = await refCache.memo(`subjects:${courseInfo.id}:${semesterString}`, 60_000, async () => {
        const subjectsSnap = await db
          .collection("subjects")
          .where("course_id", "==", courseInfo.id)
          .where("semester", "==", semesterString)
          .where("compulsary", "==", true)
          .select()
          .get();
        return subjectsSnap.docs.map((d) => d.id);
      }, { cacheNull: true });

      // optional division (section) picked at sign-up: must be one the head created for this course + semester
      let division = null;
      if (student.division_id !== undefined && student.division_id !== null && student.division_id !== "") {
        const divId = String(student.division_id);
        const dv = divId.includes("/") || divId.length > 200 ? null : await db.collection("divisions").doc(divId).get();
        const dd = dv && dv.exists ? dv.data() : null;
        if (!dd || dd.course_id !== courseInfo.id || dd.aishe_code !== aishe || Number(dd.semester) !== normalizedSemester) {
          return res.status(400).json({ error: "That division is not available for your course and semester" });
        }
        division = { id: dv.id, name: dd.name };
      }

      // institute trusts this e-mail domain -> approved right away (only when the e-mail was OTP-verified)
      const autoApproved = await shouldAutoApprove(aishe, email, REQUIRE_REGISTER_OTP);

      studentPlan = { collegeData, courseInfo, normalizedSemester, enrolledSubjects: [...enrolledSubjects], autoApproved, division };
    }

    const userRecord = await admin.auth().createUser({
      email,
      password,
      emailVerified: REQUIRE_REGISTER_OTP, // the OTP proved they own the address
    });

    uid = userRecord.uid;

    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();

    batch.set(db.collection("users").doc(uid), {
      email,
      role,
      is_active: true,
      created_at: now,
    });

    if (role === "teacher") {
      const teacherRef = db.collection("teachers").doc();

      batch.set(teacherRef, {
        teacher_id: teacherRef.id,
        user_id: uid,
        first_name: teacher.first_name,
        last_name: teacher.last_name,
        gender: teacher.gender,
        contact_phone: teacher.contact_phone,
        aishe_code: teacher.aishe_code,
        departments: teacher.departments,
        designation: teacher.designation,
        approval_status: "pending",
        created_at: now,
      });

      await batch.commit();
      await consumeOtpToken(email, "register");

      return res.status(201).json({
        success: true,
        message: "Teacher registered successfully. Await admin approval.",
        uid,
        teacher_id: teacherRef.id,
      });
    }

    // role === "student"
    const { collegeData, courseInfo, normalizedSemester, enrolledSubjects, autoApproved, division } = studentPlan;
    const courseData = courseInfo.data;

    batch.set(db.collection("students").doc(uid), {
      uid,
      email,
      role: "student",

      first_name: student.first_name,
      last_name: student.last_name,
      name: `${student.first_name} ${student.last_name}`,

      phone: student.phone || null,
      roll_no: student.roll_no,

      aishe_code: student.aishe_code,
      college_name: collegeData.college_name || null,

      district: collegeData.district || null,
      state: collegeData.state || null,
      university_name: collegeData.university_name || null,

      //  AUTO FROM COURSES
      course_id: courseInfo.id,
      course_name: courseData.course_name,
      degree: courseData.abbr,

      semester: normalizedSemester,
      year: student.year || null,

      enrolled_subjects: enrolledSubjects,
      ...(division ? { division_id: division.id, division: division.name } : {}),

      approval_status: autoApproved ? "approved" : "pending",
      ...(autoApproved ? { auto_approved: true, auto_approved_at: now } : {}),
      created_at: now,
    });

    await batch.commit();
    await consumeOtpToken(email, "register");

    // NOTE: the original handler never sent a response for students (the request
    // just hung until the client timed out). It now answers like the teacher branch.
    return res.status(201).json({
      success: true,
      message: autoApproved
        ? "Student registered successfully. Your account is approved - you can log in now."
        : "Student registered successfully. Await admin approval.",
      auto_approved: !!autoApproved,
      uid,
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error.message);

    // 🔥 ROLLBACK AUTH USER
    if (uid) {
      try {
        await admin.auth().deleteUser(uid);
      } catch (e) {
        console.error("Rollback failed:", e.message);
      }
    }

    return res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy fallback for teachers whose user_id has stray whitespace.
// The original scanned the whole `teachers` collection on EVERY such login;
// the scan result is now kept as a trimmed-user_id -> doc id map for 60 s.
// ─────────────────────────────────────────────────────────────────────────────
async function findTeacherByTrimmedUid(uid) {
  const index = await teacherScanCache.memo("scan", 60_000, async () => {
    const allTeachersSnap = await db.collection("teachers").where("aishe_code", "!=", "").get();
    const map = new Map();
    allTeachersSnap.docs.forEach((d) => {
      const key = (d.data().user_id || "").trim();
      if (key && !map.has(key)) map.set(key, d);
    });
    return map;
  });
  return index.get(uid.trim()) || null;
}

router.post("/login", async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: "idToken is required" });
    }

    let decodedToken;
    try {
      decodedToken = await verifyToken(idToken);
    } catch (e) {
      decodedToken = null;
    }
    if (!decodedToken) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    const uid = decodedToken.uid;

    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User record not found" });
    }

    const userData = userDoc.data();

    if (!userData.is_active) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    let profileData = null;
    let teacher_id = null;
    let student_id = null;

    if (userData.role === "teacher") {
      // Try 1: query by user_id field (standard)
      let teacherDoc = null;
      const snap1 = await db.collection("teachers").where("user_id", "==", uid).limit(1).get();
      if (!snap1.empty) {
        teacherDoc = snap1.docs[0];
      } else {
        // Try 2: docs with whitespace/encoding issues (cached lookup table, see above)
        teacherDoc = await findTeacherByTrimmedUid(uid);
      }

      if (!teacherDoc) {
        console.error(`LOGIN: teacher not found for uid=${uid}`);
        return res.status(404).json({ error: "Teacher profile not found" });
      }

      profileData = teacherDoc.data();

      // Always use doc.id as the authoritative teacher_id
      teacher_id = teacherDoc.id;

      // Resolve role: explicit role field first, then fall back to designation
      const resolvedRole = profileData.role ||
        (profileData.designation?.toLowerCase() === "hod" ? "hod" :
         profileData.designation?.toLowerCase() === "head teacher" ? "head_teacher" : null);

      // Heal: write teacher_id / user_id (and role) back if missing/wrong.
      // One combined update instead of up to two sequential ones.
      const heal = {};
      if (!profileData.teacher_id || profileData.teacher_id !== teacherDoc.id
          || !profileData.user_id || profileData.user_id.trim() !== uid) {
        heal.teacher_id = teacherDoc.id;
        heal.user_id = uid;
      }
      if ((resolvedRole === "hod" || resolvedRole === "head_teacher") && !profileData.role) {
        heal.role = resolvedRole;
      }
      if (Object.keys(heal).length) {
        await teacherDoc.ref.update(heal);
      }

      if (resolvedRole === "hod" || resolvedRole === "head_teacher") {
        userData.role = resolvedRole;
      }
    }

    if (userData.role === "student") {
      // students/{uid} is the normal layout -> one direct read; fall back to the uid-field query
      let studentDocSnap = await db.collection("students").doc(uid).get();
      if (!studentDocSnap.exists || (studentDocSnap.data().uid && studentDocSnap.data().uid !== uid)) {
        const studentSnapshot = await db
          .collection("students")
          .where("uid", "==", uid)
          .limit(1)
          .get();
        studentDocSnap = studentSnapshot.empty ? null : studentSnapshot.docs[0];
      }

      if (!studentDocSnap) {
        return res.status(404).json({ error: "Student profile not found" });
      }

      const studentData = studentDocSnap.data();

      if (studentData.approval_status !== "approved") {
        return res.status(403).json({ error: "Student profile not approved" });
      }

      profileData = studentData;
      student_id = uid; //  just the uid string, not a Firestore reference
    }

    return res.json({
      success: true,
      message: "Login successful",
      user: {
        uid,
        email: userData.email,
        role: userData.role,
        is_active: userData.is_active,
        teacher_id,  //  null for students
        student_id,  //  null for teachers
      },
      profile: profileData,
    });

  } catch (error) {
    console.error("Login Error:", error.message);
    // Only a bad token is a 401. A database hiccup must not look like "invalid token",
    // otherwise the app logs everybody out whenever Firestore is slow.
    if (typeof error.code === "string" && error.code.startsWith("auth/")) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    return res.status(503).json({ error: "Service temporarily unavailable, please try again" });
  }
});

/**
 * Is this teacher doc currently a head?
 *
 * head_of is what the institute app writes/clears, so when the field exists
 * it is the single source of truth: non-empty → head, empty → not head
 * (even if a stale role: "hod" was written back by an old login).
 * Docs that never had head_of fall back to the legacy role/designation.
 */
function isHeadProfile(p = {}) {
  if (p.head_of !== undefined) return !!String(p.head_of || "").trim();
  const designation = String(p.designation || "").trim().toLowerCase();
  return (
    p.role === "hod" ||
    p.role === "head_teacher" ||
    designation === "hod" ||
    designation === "head teacher"
  );
}

/**
 * GET /auth/me   (Authorization: Bearer <Firebase ID token>)
 *
 * Returns the CURRENT user + profile straight from the database so the web
 * app can pick up changes made while someone is logged in (head assigned or
 * removed, account deactivated) without them logging out and in again.
 */
router.get("/me", async (req, res) => {
  try {
    const idToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!idToken) {
      return res.status(401).json({ error: "Authorization token required" });
    }

    let uid;
    try {
      const decoded = await verifyToken(idToken);
      if (!decoded) throw new Error("bad token");
      uid = decoded.uid;
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User record not found" });
    }

    const userData = userDoc.data();
    if (!userData.is_active) {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    const user = {
      uid,
      email: userData.email,
      role: userData.role,
      is_active: userData.is_active,
      is_head: false,
    };
    let profile = null;

    if (userData.role === "teacher") {
      const snap = await db
        .collection("teachers")
        .where("user_id", "==", uid)
        .limit(1)
        .get();
      if (snap.empty) {
        return res.status(404).json({ error: "Teacher profile not found" });
      }
      profile = { ...snap.docs[0].data(), teacher_id: snap.docs[0].id };
      user.teacher_id = snap.docs[0].id;
      user.is_head = isHeadProfile(profile);

      // Manage areas a head delegated to this teacher (web sidebar + route guards read this)
      user.delegations = [];
      try {
        const dSnap = await db.collection("delegations").where("teacher_id", "==", snap.docs[0].id).get();
        user.delegations = dSnap.docs
          .map((d) => d.data())
          .filter((r) => r.aishe_code === profile.aishe_code)
          .map((r) => ({ course_id: r.course_id, area: r.area }));
      } catch (e) {
        console.error("ME delegations:", e.message); // never fail the session refresh over this
      }
    }

    return res.json({ success: true, user, profile });
  } catch (error) {
    console.error("ME ERROR:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;