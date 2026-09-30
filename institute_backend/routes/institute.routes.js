const express    = require("express");
const router     = express.Router();
const jwt        = require("jsonwebtoken");
const { FieldValue } = require("firebase-admin/firestore");
const { workingDb, instituteDb, COLLECTIONS } = require("../config/firebase");

// ── Auth middleware ───────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided." });
  }
  try {
    req.institute = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

// ── GET /institute/stats ──────────────────────────────────────────────
router.get("/stats", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    if (!aishe_code) return res.status(400).json({ error: "No AISHE code on this account." });

    const col = (name) => workingDb.collection(name).where("aishe_code", "==", aishe_code);

    // courses and subjects use aishe_code directly (institute owns them)
    // students and teachers also use aishe_code — this is the authoritative link
    const [allStudents, allTeachers, courses, subjects] = await Promise.all([
      col("students").get(),
      col("teachers").get(),
      col("courses").get(),
      col("subjects").get(),
    ]);

    const countBy = (docs, field, value) =>
      docs.filter((d) => d.data()[field] === value).length;

    return res.status(200).json({
      success: true,
      stats: {
        approved_students: countBy(allStudents.docs, "approval_status", "approved"),
        pending_students:  countBy(allStudents.docs, "approval_status", "pending"),
        approved_teachers: countBy(allTeachers.docs, "approval_status", "approved"),
        pending_teachers:  countBy(allTeachers.docs, "approval_status", "pending"),
        total_courses:     courses.size,
        total_subjects:    subjects.size,
      },
    });
  } catch (error) {
    console.error("STATS ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── GET /institute/courses ────────────────────────────────────────────
router.get("/courses", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const { page = 1, limit = 6 } = req.query;

    const [courseSnap, studentSnap, subjectSnap] = await Promise.all([
      workingDb.collection("courses")
        .where("aishe_code", "==", aishe_code).get(),
      workingDb.collection("students")
        .where("aishe_code", "==", aishe_code).get(),
      workingDb.collection("subjects")
        .where("aishe_code", "==", aishe_code).get(),
    ]);

    // Count approved students by degree (abbr) — degree field is always populated
    // course_id may be missing on some student docs so we don't rely on it
    const studentsByDegree = {};
    studentSnap.docs.forEach((doc) => {
      const d = doc.data();
      if (d.approval_status === "approved" && d.degree) {
        const key = d.degree.toUpperCase();
        studentsByDegree[key] = (studentsByDegree[key] || 0) + 1;
      }
    });

    // Count subjects by course_id
    const subjectsByCourse = {};
    subjectSnap.docs.forEach((doc) => {
      const cid = doc.data().course_id;
      if (cid) subjectsByCourse[cid] = (subjectsByCourse[cid] || 0) + 1;
    });

    const allCourses = courseSnap.docs.map((doc) => {
      const data      = doc.data();
      const course_id = doc.id;
      const abbrKey   = (data.abbr || "").toUpperCase();
      return {
        course_id,
        course_name:     data.course_name,
        abbr:            data.abbr,
        duration:        data.duration,
        duration_years:  data.duration_years  || null,
        total_semesters: data.total_semesters || null,
        qualification:   data.qualification,
        student_count:   studentsByDegree[abbrKey] || 0,
        subject_count:   subjectsByCourse[course_id] || 0,
      };
    });

    const total      = allCourses.length;
    const pageNum    = Math.max(1, parseInt(page));
    const limitNum   = Math.min(50, Math.max(1, parseInt(limit)));
    const startIndex = (pageNum - 1) * limitNum;
    const paginated  = allCourses.slice(startIndex, startIndex + limitNum);

    return res.status(200).json({ success: true, courses: paginated, total });
  } catch (error) {
    console.error("COURSES ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── POST /institute/courses ───────────────────────────────────────────
router.post("/courses", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const { course_name, abbr, duration, duration_years, total_semesters, qualification } = req.body;

    if (!course_name || !abbr || !duration || !qualification) {
      return res.status(400).json({ error: "course_name, abbr, duration and qualification are required." });
    }

    // Duplicate abbr check
    const dupSnap = await workingDb.collection("courses")
      .where("aishe_code", "==", aishe_code)
      .where("abbr", "==", abbr.trim().toUpperCase())
      .limit(1).get();

    if (!dupSnap.empty) {
      return res.status(409).json({ error: `A course with abbreviation "${abbr}" already exists.` });
    }

    const courseRef = workingDb.collection("courses").doc();
    await courseRef.set({
      course_id:       courseRef.id,
      aishe_code,
      course_name:     course_name.trim(),
      abbr:            abbr.trim().toUpperCase(),
      duration:        duration.trim(),
      duration_years:  duration_years  || null,
      total_semesters: total_semesters || null,
      qualification:   qualification.trim(),
      created_at:      FieldValue.serverTimestamp(),
    });

    return res.status(201).json({ success: true, message: "Course added successfully.", course_id: courseRef.id });
  } catch (error) {
    console.error("ADD COURSE ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/courses/:id ────────────────────────────────────────
router.put("/courses/:id", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("courses").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Course not found." });
    if (doc.data().aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    const { course_name, abbr, duration, duration_years, total_semesters, qualification } = req.body;

    await workingDb.collection("courses").doc(req.params.id).update({
      ...(course_name     && { course_name:     course_name.trim() }),
      ...(abbr            && { abbr:            abbr.trim().toUpperCase() }),
      ...(duration        && { duration:        duration.trim() }),
      ...(duration_years  && { duration_years:  Number(duration_years) }),
      ...(total_semesters && { total_semesters: Number(total_semesters) }),
      ...(qualification   && { qualification:   qualification.trim() }),
      updated_at: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ success: true, message: "Course updated successfully." });
  } catch (error) {
    console.error("UPDATE COURSE ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── DELETE /institute/courses/:id ─────────────────────────────────────
// Soft delete — marks as removed. Does not delete subjects/students.
router.delete("/courses/:id", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("courses").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Course not found." });
    if (doc.data().aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    // Hard delete — course data is not critical to preserve unlike students/teachers
    await workingDb.collection("courses").doc(req.params.id).delete();

    return res.status(200).json({ success: true, message: "Course deleted." });
  } catch (error) {
    console.error("DELETE COURSE ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});


// Filters: status (pending|approved|rejected), department, head_only
// Pagination: page (1-based), limit (default 10)
router.get("/teachers", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const { status, department, head_only, page = 1, limit = 10 } = req.query;

    // Fetch ALL teachers for this institute — filter in memory
    // avoids composite Firestore index for aishe_code + approval_status + designation
    const snap   = await workingDb.collection("teachers")
      .where("aishe_code", "==", aishe_code).get();
    let teachers = snap.docs.map((doc) => ({ teacher_id: doc.id, ...doc.data() }));

    // In-memory filters
    if (status && ["pending", "approved", "rejected"].includes(status)) {
      teachers = teachers.filter((t) => t.approval_status === status);
    }
    if (head_only === "true") {
      teachers = teachers.filter((t) => t.designation === "head");
    }
    if (department) {
      teachers = teachers.filter((t) =>
        Array.isArray(t.departments) && t.departments.includes(department)
      );
    }

    // ── Fetch emails from users/ collection in batch ─────────────────
    // users/ doc ID = user_id field on teacher doc
    const userIds = teachers
      .map((t) => t.user_id)
      .filter(Boolean);

    const emailMap = {};
    if (userIds.length > 0) {
      // Firestore getAll supports up to 500 docs at once
      const userRefs = userIds.map((uid) => workingDb.collection("users").doc(uid));
      const userDocs = await workingDb.getAll(...userRefs);
      userDocs.forEach((doc) => {
        if (doc.exists) emailMap[doc.id] = doc.data().email || null;
      });
    }

    // Merge email into each teacher
    teachers = teachers.map((t) => ({
      ...t,
      email: emailMap[t.user_id] || t.email || null,
    }));

    const total      = teachers.length;
    const pageNum    = Math.max(1, parseInt(page));
    const limitNum   = Math.min(50, Math.max(1, parseInt(limit)));
    const startIndex = (pageNum - 1) * limitNum;
    const paginated  = teachers.slice(startIndex, startIndex + limitNum);

    return res.status(200).json({
      success: true,
      teachers: paginated,
      pagination: {
        total,
        page:        pageNum,
        limit:       limitNum,
        total_pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("TEACHERS ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── GET /institute/teachers/:id ───────────────────────────────────────
router.get("/teachers/:id", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("teachers").doc(req.params.id).get();

    if (!doc.exists) return res.status(404).json({ error: "Teacher not found." });
    const data = doc.data();
    if (data.aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    // Fetch email from users/ using user_id
    let email = data.email || null;
    if (data.user_id) {
      const userDoc = await workingDb.collection("users").doc(data.user_id).get();
      if (userDoc.exists) email = userDoc.data().email || email;
    }

    // Get subjects assigned to this teacher
    const subjectsSnap = await workingDb.collection("subjects")
      .where("aishe_code", "==", aishe_code)
      .where("teacher_assigned", "==", req.params.id)
      .get();

    const subjects = subjectsSnap.docs.map((s) => ({ subject_id: s.id, ...s.data() }));

    return res.status(200).json({
      success:  true,
      teacher:  { teacher_id: doc.id, ...data, email },
      subjects,
    });
  } catch (error) {
    console.error("TEACHER DETAIL ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/teachers/:id/approve ──────────────────────────────
router.put("/teachers/:id/approve", verifyToken, async (req, res) => {
  try {
    await workingDb.collection("teachers").doc(req.params.id).update({
      approval_status: "approved",
      updated_at: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, message: "Teacher approved." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/teachers/:id/reject ───────────────────────────────
router.put("/teachers/:id/reject", verifyToken, async (req, res) => {
  try {
    await workingDb.collection("teachers").doc(req.params.id).update({
      approval_status: "rejected",
      updated_at: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, message: "Teacher rejected." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/teachers/:id/promote ──────────────────────────────
// Promotes teacher to a new designation
// Body: { designation: "Associate Professor" }
router.put("/teachers/:id/promote", verifyToken, async (req, res) => {
  try {
    const { designation } = req.body;
    const validDesignations = [
      "Assistant Professor",
      "Associate Professor",
      "Professor",
      "Senior Professor",
      "head",
    ];
    if (!designation || !validDesignations.includes(designation)) {
      return res.status(400).json({ error: `Invalid designation. Valid: ${validDesignations.join(", ")}` });
    }

    const { aishe_code } = req.institute;
    const doc  = await workingDb.collection("teachers").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Teacher not found." });
    if (doc.data().aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    await workingDb.collection("teachers").doc(req.params.id).update({
      designation,
      updated_at: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, message: `Teacher promoted to ${designation}.` });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/teachers/:id/make-head ─────────────────────────────
// Makes a teacher the Head of a department.
// Rules:
//   1. Teacher must be approved.
//   2. Only one Head per department — if another Head exists, they are
//      demoted to their previous designation (or "Professor") first.
//   3. Body: { department: "MCA" }
router.put("/teachers/:id/make-head", verifyToken, async (req, res) => {
  try {
    const { department } = req.body;
    if (!department) return res.status(400).json({ error: "department is required." });

    const { aishe_code } = req.institute;
    const teacherRef = workingDb.collection("teachers").doc(req.params.id);
    const teacherDoc = await teacherRef.get();

    if (!teacherDoc.exists) return res.status(404).json({ error: "Teacher not found." });
    const teacher = teacherDoc.data();
    if (teacher.aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });
    if (teacher.approval_status !== "approved") {
      return res.status(400).json({ error: "Teacher must be approved before becoming Head." });
    }
    if (!Array.isArray(teacher.departments) || !teacher.departments.includes(department)) {
      return res.status(400).json({ error: `Teacher is not in the ${department} department.` });
    }

    // Find existing Head for this department
    const existingHodSnap = await workingDb.collection("teachers")
      .where("aishe_code", "==", aishe_code)
      .where("designation", "==", "head")
      .get();

    // Demote any existing Head of this specific department
    const batch = workingDb.batch();
    existingHodSnap.docs.forEach((headDoc) => {
      const headData = headDoc.data();
      // Only demote if they are Head of this department
      if (Array.isArray(headData.departments) && headData.departments.includes(department)) {
        batch.update(headDoc.ref, {
          designation:  headData.previous_designation || "Professor",
          previous_designation: null,
          head_of:       null,
          updated_at:   FieldValue.serverTimestamp(),
        });
      }
    });

    // Make this teacher Head
    batch.update(teacherRef, {
      previous_designation: teacher.designation,
      designation:          "head",
      head_of:               department,
      updated_at:           FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return res.status(200).json({
      success: true,
      message: `${teacher.first_name} ${teacher.last_name} is now Head of ${department}.`,
    });
  } catch (error) {
    console.error("MAKE Head ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/teachers/:id/remove-head ───────────────────────────
// Removes Head status, restores previous designation
router.put("/teachers/:id/remove-head", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("teachers").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Teacher not found." });
    const data = doc.data();
    if (data.aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });
    if (data.designation !== "head") return res.status(400).json({ error: "Teacher is not an Head." });

    await workingDb.collection("teachers").doc(req.params.id).update({
      designation:          data.previous_designation || "Professor",
      previous_designation: null,
      head_of:               null,
      updated_at:           FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, message: "Head status removed." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/teachers/:id/deactivate ────────────────────────────
router.put("/teachers/:id/deactivate", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("teachers").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Teacher not found." });
    if (doc.data().aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    await workingDb.collection("teachers").doc(req.params.id).update({
      is_active:  false,
      updated_at: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, message: "Teacher deactivated." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/teachers/:id/activate ─────────────────────────────
router.put("/teachers/:id/activate", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("teachers").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Teacher not found." });
    if (doc.data().aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    await workingDb.collection("teachers").doc(req.params.id).update({
      is_active:  true,
      updated_at: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, message: "Teacher activated." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── DELETE /institute/teachers/:id ────────────────────────────────────
// Soft delete — sets approval_status to "removed"
// Hard delete not done to preserve subject assignment history
router.delete("/teachers/:id", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("teachers").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Teacher not found." });
    if (doc.data().aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    await workingDb.collection("teachers").doc(req.params.id).update({
      approval_status: "removed",
      is_active:       false,
      updated_at:      FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, message: "Teacher removed." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── GET /institute/students ───────────────────────────────────────────
router.get("/students", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    // course = abbr/degree value (e.g. "MCA"), semester = int
    const { status, course, semester, page = 1, limit = 10 } = req.query;

    let query = workingDb.collection("students").where("aishe_code", "==", aishe_code);

    // Only add status filter via Firestore — avoid composite index issues
    // by doing course + semester filters in memory
    if (status && ["pending", "approved", "rejected"].includes(status)) {
      query = query.where("approval_status", "==", status);
    }

    const snap   = await query.get();
    let students = snap.docs.map((doc) => ({ student_id: doc.id, ...doc.data() }));

    // In-memory filters — avoids needing composite Firestore indexes
    if (course) {
      students = students.filter((s) =>
        (s.degree || "").toUpperCase() === course.toUpperCase()
      );
    }
    if (semester) {
      students = students.filter((s) => Number(s.semester) === Number(semester));
    }

    // Merge emails from users/ collection
    const uids     = students.map((s) => s.uid || s.student_id).filter(Boolean);
    const emailMap = {};
    if (uids.length > 0) {
      const userRefs = uids.map((uid) => workingDb.collection("users").doc(uid));
      const userDocs = await workingDb.getAll(...userRefs);
      userDocs.forEach((doc) => {
        if (doc.exists) emailMap[doc.id] = doc.data().email || null;
      });
    }
    students = students.map((s) => ({
      ...s,
      email: emailMap[s.uid || s.student_id] || s.email || null,
    }));

    const total      = students.length;
    const pageNum    = Math.max(1, parseInt(page));
    const limitNum   = Math.min(50, Math.max(1, parseInt(limit)));
    const startIndex = (pageNum - 1) * limitNum;
    const paginated  = students.slice(startIndex, startIndex + limitNum);

    return res.status(200).json({
      success: true,
      students: paginated,
      pagination: { total, page: pageNum, limit: limitNum, total_pages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error("STUDENTS ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── GET /institute/students/:id ───────────────────────────────────────
router.get("/students/:id", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("students").doc(req.params.id).get();

    if (!doc.exists) return res.status(404).json({ error: "Student not found." });
    const data = doc.data();
    if (data.aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    // Fetch email from users/ (student doc ID = uid)
    let email = data.email || null;
    const userDoc = await workingDb.collection("users").doc(req.params.id).get();
    if (userDoc.exists) email = userDoc.data().email || email;

    // Resolve enrolled subjects to full subject docs
    const enrolledSubjectIds = data.enrolled_subjects || [];
    let subjects = [];
    if (enrolledSubjectIds.length > 0) {
      const subjectRefs = enrolledSubjectIds.map((id) =>
        workingDb.collection("subjects").doc(id)
      );
      const subjectDocs = await workingDb.getAll(...subjectRefs);
      subjects = subjectDocs
        .filter((d) => d.exists)
        .map((d) => ({ subject_id: d.id, ...d.data() }));
    }

    return res.status(200).json({
      success: true,
      student: { student_id: doc.id, ...data, email },
      subjects,
    });
  } catch (error) {
    console.error("STUDENT DETAIL ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/students/:id/approve ──────────────────────────────
router.put("/students/:id/approve", verifyToken, async (req, res) => {
  try {
    await workingDb.collection("students").doc(req.params.id).update({
      approval_status: "approved",
      updated_at: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, message: "Student approved." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/students/:id/reject ───────────────────────────────
router.put("/students/:id/reject", verifyToken, async (req, res) => {
  try {
    await workingDb.collection("students").doc(req.params.id).update({
      approval_status: "rejected",
      updated_at: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, message: "Student rejected." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── DELETE /institute/students/:id ────────────────────────────────────
router.delete("/students/:id", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("students").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Student not found." });
    if (doc.data().aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    await workingDb.collection("students").doc(req.params.id).update({
      approval_status: "removed",
      is_active:       false,
      updated_at:      FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, message: "Student removed." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── GET /institute/students/auto-approve-domains ─────────────────────
// Returns saved trusted domains for this institute from instituteDb
router.get("/students/auto-approve-domains", verifyToken, async (req, res) => {
  try {
    const { institute_id } = req.institute;
    const { instituteDb, COLLECTIONS } = require("../config/firebase");
    const doc = await instituteDb
      .collection(COLLECTIONS.INSTITUTES)
      .doc(institute_id)
      .get();

    const domains = doc.exists ? (doc.data().trusted_domains || []) : [];
    return res.status(200).json({ success: true, domains });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/students/auto-approve-domains ──────────────────────
// Save trusted domains list. Body: { domains: ["vesit.ves.ac.in", ...] }
router.put("/students/auto-approve-domains", verifyToken, async (req, res) => {
  try {
    const { institute_id } = req.institute;
    const { domains } = req.body;
    if (!Array.isArray(domains)) {
      return res.status(400).json({ error: "domains must be an array of strings." });
    }
    // Sanitize — lowercase, strip spaces, remove empty
    const clean = domains
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0 && d.includes("."));

    const { instituteDb, COLLECTIONS } = require("../config/firebase");
    await instituteDb
      .collection(COLLECTIONS.INSTITUTES)
      .doc(institute_id)
      .update({ trusted_domains: clean, updated_at: FieldValue.serverTimestamp() });

    return res.status(200).json({ success: true, domains: clean });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── POST /institute/students/auto-approve-run ─────────────────────────
// Scans ALL pending students whose email domain matches trusted_domains
// and approves them in one batch. Returns count approved.
router.post("/students/auto-approve-run", verifyToken, async (req, res) => {
  try {
    const { aishe_code, institute_id } = req.institute;
    const { instituteDb, COLLECTIONS } = require("../config/firebase");

    // Get trusted domains
    const instDoc = await instituteDb
      .collection(COLLECTIONS.INSTITUTES)
      .doc(institute_id)
      .get();
    const domains = instDoc.exists ? (instDoc.data().trusted_domains || []) : [];

    if (domains.length === 0) {
      return res.status(400).json({ error: "No trusted domains configured." });
    }

    // Fetch all pending students for this institute
    const snap = await workingDb
      .collection("students")
      .where("aishe_code", "==", aishe_code)
      .where("approval_status", "==", "pending")
      .get();

    if (snap.empty) {
      return res.status(200).json({ success: true, approved: 0, message: "No pending students." });
    }

    // Get emails from users/ collection
    const uids     = snap.docs.map((d) => d.data().uid || d.id).filter(Boolean);
    const emailMap = {};
    if (uids.length > 0) {
      const refs     = uids.map((uid) => workingDb.collection("users").doc(uid));
      const userDocs = await workingDb.getAll(...refs);
      userDocs.forEach((d) => {
        if (d.exists) emailMap[d.id] = (d.data().email || "").toLowerCase();
      });
    }

    // Filter students whose email domain matches trusted_domains
    const toApprove = snap.docs.filter((doc) => {
      const uid   = doc.data().uid || doc.id;
      const email = emailMap[uid] || (doc.data().email || "").toLowerCase();
      if (!email) return false;
      const domain = email.split("@")[1] || "";
      return domains.includes(domain);
    });

    if (toApprove.length === 0) {
      return res.status(200).json({
        success: true, approved: 0,
        message: "No pending students matched the trusted domains.",
      });
    }

    // Batch approve
    const batches = [];
    let batch     = workingDb.batch();
    let opCount   = 0;

    toApprove.forEach((doc) => {
      batch.update(doc.ref, {
        approval_status: "approved",
        updated_at:      FieldValue.serverTimestamp(),
      });
      opCount++;
      // Firestore batch limit = 500
      if (opCount === 499) {
        batches.push(batch.commit());
        batch   = workingDb.batch();
        opCount = 0;
      }
    });
    if (opCount > 0) batches.push(batch.commit());
    await Promise.all(batches);

    return res.status(200).json({
      success:  true,
      approved: toApprove.length,
      message:  `${toApprove.length} student(s) approved automatically.`,
    });
  } catch (error) {
    console.error("AUTO-APPROVE ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── GET /institute/subjects ───────────────────────────────────────────
router.get("/subjects", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const { course_id, semester, compulsory, page = 1, limit = 200 } = req.query;

    let query = workingDb.collection("subjects").where("aishe_code", "==", aishe_code);
    if (course_id) query = query.where("course_id", "==", course_id);

    const snap = await query.get();
    let subjects = snap.docs.map((doc) => ({ subject_id: doc.id, ...doc.data() }));

    // In-memory filters
    if (semester)   subjects = subjects.filter((s) => s.semester === semester);
    if (compulsory !== undefined && compulsory !== "") {
      const val = compulsory === "true";
      subjects = subjects.filter((s) => s.compulsary === val);
    }

    const total      = subjects.length;
    const pageNum    = Math.max(1, parseInt(page));
    const limitNum   = Math.min(500, Math.max(1, parseInt(limit)));
    const paginated  = subjects.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    return res.status(200).json({
      success: true,
      subjects: paginated,
      pagination: { total, page: pageNum, limit: limitNum, total_pages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error("SUBJECTS ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── POST /institute/subjects ──────────────────────────────────────────
router.post("/subjects", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const { course_id, subject_name, subject_code, semester, compulsary, teacher_assigned } = req.body;

    if (!course_id || !subject_name || !subject_code || !semester) {
      return res.status(400).json({ error: "course_id, subject_name, subject_code and semester are required." });
    }

    // Verify course belongs to this institute
    const courseDoc = await workingDb.collection("courses").doc(course_id).get();
    if (!courseDoc.exists || courseDoc.data().aishe_code !== aishe_code) {
      return res.status(403).json({ error: "Course not found or access denied." });
    }

    const subjectRef = workingDb.collection("subjects").doc();
    await subjectRef.set({
      subject_id:       subjectRef.id,
      aishe_code,
      course_id,
      subject_name:     subject_name.trim(),
      subject_code:     subject_code.trim().toUpperCase(),
      semester,
      compulsary:       compulsary !== false,
      teacher_assigned: teacher_assigned || null,
      created_at:       FieldValue.serverTimestamp(),
    });

    return res.status(201).json({ success: true, message: "Subject added.", subject_id: subjectRef.id });
  } catch (error) {
    console.error("ADD SUBJECT ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/subjects/:id ───────────────────────────────────────
router.put("/subjects/:id", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("subjects").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Subject not found." });
    if (doc.data().aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    const { subject_name, subject_code, semester, compulsary, teacher_assigned } = req.body;

    await workingDb.collection("subjects").doc(req.params.id).update({
      ...(subject_name     !== undefined && { subject_name:     subject_name.trim() }),
      ...(subject_code     !== undefined && { subject_code:     subject_code.trim().toUpperCase() }),
      ...(semester         !== undefined && { semester }),
      ...(compulsary       !== undefined && { compulsary }),
      ...(teacher_assigned !== undefined && { teacher_assigned: teacher_assigned || null }),
      updated_at: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ success: true, message: "Subject updated." });
  } catch (error) {
    console.error("UPDATE SUBJECT ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /institute/subjects/:id/assign ───────────────────────────────
router.put("/subjects/:id/assign", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const { teacher_id } = req.body;

    const doc = await workingDb.collection("subjects").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Subject not found." });
    if (doc.data().aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    await workingDb.collection("subjects").doc(req.params.id).update({
      teacher_assigned: teacher_id || null,
      updated_at: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ success: true, message: teacher_id ? "Teacher assigned." : "Teacher unassigned." });
  } catch (error) {
    console.error("ASSIGN TEACHER ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── DELETE /institute/subjects/:id ────────────────────────────────────
router.delete("/subjects/:id", verifyToken, async (req, res) => {
  try {
    const { aishe_code } = req.institute;
    const doc = await workingDb.collection("subjects").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Subject not found." });
    if (doc.data().aishe_code !== aishe_code) return res.status(403).json({ error: "Access denied." });

    await workingDb.collection("subjects").doc(req.params.id).delete();
    return res.status(200).json({ success: true, message: "Subject deleted." });
  } catch (error) {
    console.error("DELETE SUBJECT ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── GET /institute/students/auto-approve-domains ──────────────────────
router.get("/students/auto-approve-domains", verifyToken, async (req, res) => {
  try {
    const { institute_id } = req.institute;
    const doc = await instituteDb.collection(COLLECTIONS.INSTITUTES).doc(institute_id).get();
    if (!doc.exists) return res.status(404).json({ error: "Institute not found." });
    return res.status(200).json({ success: true, domains: doc.data().auto_approve_domains || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── POST /institute/students/auto-approve-run ─────────────────────────
router.post("/students/auto-approve-run", verifyToken, async (req, res) => {
  try {
    const { aishe_code, institute_id } = req.institute;
    const instDoc = await instituteDb.collection(COLLECTIONS.INSTITUTES).doc(institute_id).get();
    if (!instDoc.exists) return res.status(404).json({ error: "Institute not found." });

    const domains = instDoc.data().auto_approve_domains || [];
    if (domains.length === 0) return res.status(400).json({ error: "No auto-approve domains configured." });

    const pendingSnap = await workingDb.collection("students")
      .where("aishe_code", "==", aishe_code)
      .where("approval_status", "==", "pending").get();

    const toApprove = pendingSnap.docs.filter((doc) => {
      const email = doc.data().email || "";
      return domains.some((d) => email.toLowerCase().endsWith(`@${d.toLowerCase()}`));
    });

    const batch = workingDb.batch();
    toApprove.forEach((doc) => {
      batch.update(doc.ref, { approval_status: "approved", updated_at: FieldValue.serverTimestamp() });
    });
    if (toApprove.length > 0) await batch.commit();

    return res.status(200).json({
      success: true,
      approved: toApprove.length,
      message: `${toApprove.length} student(s) auto-approved.`,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});


// Temporary — shows exactly what aishe_code the JWT carries and what
// courses/students/subjects exist for it. Remove after debugging.
router.get("/debug", verifyToken, async (req, res) => {
  try {
    const { aishe_code, institute_id } = req.institute;

    const [courseSnap, studentSnap, subjectSnap, teacherSnap] = await Promise.all([
      workingDb.collection("courses").where("aishe_code", "==", aishe_code).get(),
      workingDb.collection("students").where("aishe_code", "==", aishe_code).get(),
      workingDb.collection("subjects").where("aishe_code", "==", aishe_code).get(),
      workingDb.collection("teachers").where("aishe_code", "==", aishe_code).get(),
    ]);

    return res.status(200).json({
      jwt_aishe_code:  aishe_code,
      jwt_institute_id: institute_id,
      courses:   courseSnap.docs.map((d)  => ({ id: d.id, ...d.data() })),
      students:  studentSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      subjects:  subjectSnap.docs.map((d) => ({ id: d.id, course_id: d.data().course_id, subject_name: d.data().subject_name })),
      teachers:  teacherSnap.docs.map((d) => ({ id: d.id, name: `${d.data().first_name} ${d.data().last_name}`, approval_status: d.data().approval_status })),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = { router, prefix: "/institute" };