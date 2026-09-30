const express = require("express");
const router = express.Router();
const { admin, db } = require("../config/firebase");

router.post("/register", async (req, res) => {
  let uid = null;

  try {
    const {
      email,
      password,
      role,
      teacher,
      student,
    } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({
        error: "email, password and role are required",
      });
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

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
    }

    const userRecord = await admin.auth().createUser({
      email,
      password,
    });

    uid = userRecord.uid;

    await db.collection("users").doc(uid).set({
      email,
      role,
      is_active: true,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (role === "teacher") {
      const teacherRef = db.collection("teachers").doc();

      await teacherRef.set({
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
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(201).json({
        success: true,
        message: "Teacher registered successfully. Await admin approval.",
        uid,
        teacher_id: teacherRef.id,
      });
    }

    if (role === "student") {
      const collegeSnap = await db
        .collection("colleges")
        .where("aishe_code", "==", student.aishe_code)
        .limit(1)
        .get();

      if (collegeSnap.empty) {
        throw new Error("College not found while registering student");
      }

      const collegeData = collegeSnap.docs[0].data();

      let normalizedSemester = student.semester;
      if (typeof normalizedSemester === "string") {
        normalizedSemester = normalizedSemester.replace(/[^0-9]/g, "");
      }
      normalizedSemester = Number(normalizedSemester);

      const semesterString = `Sem ${normalizedSemester}`;

      const courseSnap = await db
        .collection("courses")
        .where("abbr", "==", student.degree)
        .where("aishe_code", "==", student.aishe_code)
        .limit(1)
        .get();

      if (courseSnap.empty) {
        throw new Error("Course not found for this college");
      }

      const courseDoc = courseSnap.docs[0];
      const courseData = courseDoc.data();
      const course_id = courseDoc.id;

      const subjectsSnap = await db
        .collection("subjects")
        .where("course_id", "==", course_id)
        .where("semester", "==", semesterString)
        .where("compulsary", "==", true)
        .get();

      let enrolledSubjects = [];

      subjectsSnap.forEach(doc => {
        const sub = doc.data();
          enrolledSubjects.push(doc.id);
      });

      await db.collection("students").doc(uid).set({
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
        course_id,
        course_name: courseData.course_name,
        degree: courseData.abbr,

        semester: normalizedSemester,
        year: student.year || null,

        enrolled_subjects: enrolledSubjects,

        approval_status: "pending",
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (error) {
    console.error("REGISTER ERROR:", error);

    // 🔥 ROLLBACK AUTH USER
    if (uid) {
      try {
        await admin.auth().deleteUser(uid);
      } catch (e) {
        console.error("Rollback failed:", e);
      }
    }

    return res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: "idToken is required" });
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);
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
        // Try 2: some docs may have whitespace or encoding issues — scan all and match trimmed
        // Also handles the case where user_id field was never set (admin-created HOD docs)
        const allTeachersSnap = await db.collection("teachers")
          .where("aishe_code", "!=", "")
          .get();
        const matched = allTeachersSnap.docs.find(d => {
          const uid_field = (d.data().user_id || "").trim();
          return uid_field === uid.trim();
        });
        if (matched) teacherDoc = matched;
      }

      if (!teacherDoc) {
        console.error(`LOGIN: teacher not found for uid=${uid}`);
        return res.status(404).json({ error: "Teacher profile not found" });
      }

      profileData = teacherDoc.data();

      // Always use doc.id as the authoritative teacher_id
      teacher_id = teacherDoc.id;

      // Heal: write teacher_id and user_id fields back if missing/wrong
      const needsHeal = !profileData.teacher_id || profileData.teacher_id !== teacherDoc.id
                        || !profileData.user_id || profileData.user_id.trim() !== uid;
      if (needsHeal) {
        await teacherDoc.ref.update({ teacher_id: teacherDoc.id, user_id: uid });
      }

      // Role: check explicit role field first, then fall back to designation
      const resolvedRole = profileData.role ||
        (profileData.designation?.toLowerCase() === "hod" ? "hod" :
         profileData.designation?.toLowerCase() === "head teacher" ? "head_teacher" : null);

      if (resolvedRole === "hod" || resolvedRole === "head_teacher") {
        userData.role = resolvedRole;
        if (!profileData.role) {
          await teacherDoc.ref.update({ role: resolvedRole });
        }
      }
    }

    if (userData.role === "student") {
      const studentSnapshot = await db
        .collection("students")
        .where("uid", "==", uid)
        .limit(1)
        .get();

      if (studentSnapshot.empty) {
        return res.status(404).json({ error: "Student profile not found" });
      }

      const studentData = studentSnapshot.docs[0].data();

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
    console.error("Login Error:", error);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
});

module.exports = router;