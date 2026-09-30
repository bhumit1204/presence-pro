/**
 * manage_routes.js
 *
 * Mount as: app.use("/api/manage", require("./routes/manage_routes"));
 *
 * Covers:
 *  - Courses listing
 *  - Timetable CRUD
 *  - Semester Subjects CRUD
 *  - Semester Dates
 *  - Academic Calendar
 *  - Defaulter List
 *  - Teacher Assignment
 *  - Delegate Rights
 */

const express = require("express");
const router = express.Router();
const { admin, db } = require("../config/firebase");

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: verify HOD or head_teacher role
// ─────────────────────────────────────────────────────────────────────────────
async function getTeacherRole(teacher_id) {
  const snap = await db.collection("teachers").doc(teacher_id).get();
  if (!snap.exists) return null;
  return snap.data().role || "teacher"; // "hod" | "head_teacher" | "teacher"
}

async function requireHODOrDelegate(req, res, featureKey) {
  const teacher_id = req.body?.teacher_id || req.query?.teacher_id;
  if (!teacher_id) {
    res.status(400).json({ success: false, error: "teacher_id required" });
    return null;
  }
  const snap = await db.collection("teachers").doc(teacher_id).get();
  if (!snap.exists) {
    res.status(404).json({ success: false, error: "Teacher not found" });
    return null;
  }
  const teacherData = snap.data();
  if (teacherData.role === "hod") return teacherData;
  if (teacherData.role === "head_teacher") {
    const delegated = teacherData.delegated_keys || [];
    if (featureKey && !delegated.includes(featureKey)) {
      res.status(403).json({ success: false, error: "Not authorised for this feature" });
      return null;
    }
    return teacherData;
  }
  res.status(403).json({ success: false, error: "Insufficient role" });
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// COURSES  (used by multiple manage screens for course picker)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/courses", async (req, res) => {
  try {
    const { teacher_id, role } = req.query;
    if (!teacher_id) return res.status(400).json({ success: false, error: "teacher_id required" });

    // Step 1: Try direct doc ID lookup
    let teacherData = null;
    let resolvedBy = null;
    const directSnap = await db.collection("teachers").doc(teacher_id).get();
    if (directSnap.exists) {
      teacherData = directSnap.data();
      resolvedBy = "doc_id";
    } else {
      // Step 2: Fall back to querying teacher_id field
      const fieldSnap = await db.collection("teachers").where("teacher_id", "==", teacher_id).limit(1).get();
      if (!fieldSnap.empty) {
        teacherData = fieldSnap.docs[0].data();
        resolvedBy = "teacher_id_field";
      } else {
        // Step 3: Fall back to querying user_id (in case teacher_id is actually the uid)
        const userSnap = await db.collection("teachers").where("user_id", "==", teacher_id).limit(1).get();
        if (!userSnap.empty) {
          teacherData = userSnap.docs[0].data();
          resolvedBy = "user_id_field";
        }
      }
    }

    if (!teacherData) {
      console.error(`[GET /courses] Teacher not found for teacher_id="${teacher_id}"`);
      return res.status(404).json({ success: false, error: "Teacher not found", debug_teacher_id: teacher_id });
    }

    const { aishe_code } = teacherData;

    console.log(`[GET /courses] teacher_id="${teacher_id}" resolved_by="${resolvedBy}" aishe_code="${aishe_code}" role="${teacherData.role}"`);

    if (!aishe_code) {
      console.error(`[GET /courses] Teacher doc has no aishe_code! teacher_id="${teacher_id}"`);
      return res.status(400).json({ success: false, error: "Teacher has no aishe_code set", debug_teacher_id: teacher_id, debug_teacher_role: teacherData.role });
    }

    const coursesSnap = await db
      .collection("courses")
      .where("aishe_code", "==", aishe_code)
      .get();

    console.log(`[GET /courses] aishe_code="${aishe_code}" => ${coursesSnap.size} course(s) found`);

    if (coursesSnap.empty) {
      // Extra debug: fetch a sample course to see what aishe_codes exist
      const sampleSnap = await db.collection("courses").limit(3).get();
      const sampleCodes = sampleSnap.docs.map(d => d.data().aishe_code);
      console.error(`[GET /courses] No courses for aishe_code="${aishe_code}". Sample aishe_codes in DB: ${JSON.stringify(sampleCodes)}`);
    }

    const courses = coursesSnap.docs.map((d) => {
      const data = d.data();
      const totalSems = data.total_semesters || 8;
      return {
        course_id: d.id,
        course_name: data.course_name,
        abbr: data.abbr,
        total_semesters: totalSems,
        semesters: Array.from({ length: totalSems }, (_, i) => i + 1),
      };
    });

    return res.json({ success: true, courses });
  } catch (e) {
    console.error("[GET /courses] Error:", e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TIMETABLE
// ─────────────────────────────────────────────────────────────────────────────

// GET slots
router.get("/timetable", async (req, res) => {
  try {
    const { course_id, semester } = req.query;
    if (!course_id || !semester) {
      return res.status(400).json({ success: false, error: "course_id and semester are required" });
    }
    const snap = await db
      .collection("timetable_slots")
      .where("course_id", "==", course_id)
      .where("semester", "==", Number(semester))
      .orderBy("day")
      .orderBy("start_time")
      .get();

    const slots = snap.docs.map((d) => ({ slot_id: d.id, ...d.data() }));
    return res.json({ success: true, slots });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ADD slot
router.post("/timetable/add", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, "timetable");
    if (!teacher) return;

    const {
      course_id, semester, day, start_time, end_time,
      subject_name, teacher_name, room, is_temporary, temp_date,
    } = req.body;

    if (!course_id || !semester) {
      return res.status(400).json({ success: false, error: "course_id and semester are required" });
    }

    const ref = db.collection("timetable_slots").doc();
    await ref.set({
      slot_id: ref.id,
      course_id, semester: Number(semester),
      day, start_time, end_time,
      subject_name, teacher_name: teacher_name || "",
      room: room || "",
      is_temporary: !!is_temporary,
      temp_date: is_temporary ? temp_date : null,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ success: true, slot_id: ref.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// UPDATE slot
router.post("/timetable/update", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, "timetable");
    if (!teacher) return;

    const {
      slot_id, day, start_time, end_time,
      subject_name, teacher_name, room, is_temporary, temp_date,
    } = req.body;

    if (!slot_id) {
      return res.status(400).json({ success: false, error: "slot_id is required" });
    }

    await db.collection("timetable_slots").doc(slot_id).update({
      day, start_time, end_time, subject_name,
      teacher_name: teacher_name || "",
      room: room || "",
      is_temporary: !!is_temporary,
      temp_date: is_temporary ? temp_date : null,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// DELETE slot
router.post("/timetable/delete", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, "timetable");
    if (!teacher) return;

    const { slot_id } = req.body;
    if (!slot_id) {
      return res.status(400).json({ success: false, error: "slot_id is required" });
    }

    await db.collection("timetable_slots").doc(slot_id).delete();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// Make temporary → permanent
router.post("/timetable/make-permanent", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, "timetable");
    if (!teacher) return;

    const { slot_id } = req.body;
    if (!slot_id) {
      return res.status(400).json({ success: false, error: "slot_id is required" });
    }

    await db.collection("timetable_slots").doc(slot_id).update({
      is_temporary: false,
      temp_date: null,
    });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEMESTER SUBJECTS  (HOD only)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/subjects", async (req, res) => {
  try {
    const { course_id, semester } = req.query;
    if (!course_id || !semester) {
      return res.status(400).json({ success: false, error: "course_id and semester are required" });
    }
    const snap = await db
      .collection("subjects")
      .where("course_id", "==", course_id)
      .where("semester", "==", `Sem ${semester}`)
      .get();

    const subjects = snap.docs.map((d) => ({ subject_id: d.id, ...d.data() }));
    return res.json({ success: true, subjects });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/subjects/add", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, null); // HOD only
    if (!teacher || teacher.role !== "hod") {
      return res.status(403).json({ success: false, error: "HOD only" });
    }

    const {
      course_id, semester, subject_name, subject_code,
      credits, is_compulsory, elective_slot, options,
    } = req.body;

    if (!course_id || !semester) {
      return res.status(400).json({ success: false, error: "course_id and semester are required" });
    }

    const ref = db.collection("subjects").doc();
    await ref.set({
      subject_id: ref.id,
      course_id,
      semester: `Sem ${semester}`,
      subject_name,
      subject_code: subject_code || "",
      credits: credits || 4,
      compulsary: !!is_compulsory,
      is_compulsory: !!is_compulsory,
      elective_slot: is_compulsory ? null : (elective_slot || "Elective 1"),
      options: is_compulsory ? [] : (options || []),
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ success: true, subject_id: ref.id });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/subjects/update", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, null);
    if (!teacher || teacher.role !== "hod") {
      return res.status(403).json({ success: false, error: "HOD only" });
    }

    const { subject_id, subject_name, subject_code, credits, is_compulsory, elective_slot, options } = req.body;
    if (!subject_id) {
      return res.status(400).json({ success: false, error: "subject_id is required" });
    }

    await db.collection("subjects").doc(subject_id).update({
      subject_name, subject_code: subject_code || "",
      credits: credits || 4,
      is_compulsory: !!is_compulsory,
      compulsary: !!is_compulsory,
      elective_slot: is_compulsory ? null : (elective_slot || "Elective 1"),
      options: is_compulsory ? [] : (options || []),
    });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/subjects/delete", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, null);
    if (!teacher || teacher.role !== "hod") {
      return res.status(403).json({ success: false, error: "HOD only" });
    }

    const { subject_id } = req.body;
    if (!subject_id) {
      return res.status(400).json({ success: false, error: "subject_id is required" });
    }

    await db.collection("subjects").doc(subject_id).delete();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEMESTER DATES  (HOD only)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/semester-dates", async (req, res) => {
  try {
    const { course_id } = req.query;
    if (!course_id) {
      return res.status(400).json({ success: false, error: "course_id is required" });
    }
    const snap = await db
      .collection("semester_dates")
      .where("course_id", "==", course_id)
      .orderBy("semester")
      .get();
    const dates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, dates });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/semester-dates/save", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, null);
    if (!teacher || teacher.role !== "hod") {
      return res.status(403).json({ success: false, error: "HOD only" });
    }

    const { course_id, semester, start_date, end_date } = req.body;
    if (!course_id || !semester) {
      return res.status(400).json({ success: false, error: "course_id and semester are required" });
    }
    // Upsert: find existing or create new
    const snap = await db
      .collection("semester_dates")
      .where("course_id", "==", course_id)
      .where("semester", "==", Number(semester))
      .limit(1)
      .get();

    if (!snap.empty) {
      await snap.docs[0].ref.update({ start_date, end_date });
    } else {
      await db.collection("semester_dates").add({
        course_id, semester: Number(semester), start_date, end_date,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACADEMIC CALENDAR
// ─────────────────────────────────────────────────────────────────────────────

router.get("/calendar", async (req, res) => {
  try {
    const { aishe_code, year } = req.query;
    if (!aishe_code || !year) {
      return res.status(400).json({ success: false, error: "aishe_code and year are required" });
    }
    const snap = await db
      .collection("academic_calendar")
      .where("aishe_code", "==", aishe_code)
      .where("academic_year", "==", year)
      .orderBy("date")
      .get();
    const events = snap.docs.map((d) => ({ event_id: d.id, ...d.data() }));
    return res.json({ success: true, events });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/calendar/add", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, "academic_calendar");
    if (!teacher) return;

    const { aishe_code, academic_year, date, title, event_type, description } = req.body;
    if (!aishe_code || !academic_year || !date || !title) {
      return res.status(400).json({ success: false, error: "aishe_code, academic_year, date and title are required" });
    }

    const ref = db.collection("academic_calendar").doc();
    await ref.set({
      event_id: ref.id, aishe_code, academic_year, date, title,
      event_type: event_type || "general",
      description: description || "",
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ success: true, event_id: ref.id });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/calendar/delete", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, "academic_calendar");
    if (!teacher) return;

    const { event_id } = req.body;
    if (!event_id) {
      return res.status(400).json({ success: false, error: "event_id is required" });
    }

    await db.collection("academic_calendar").doc(event_id).delete();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULTER LIST
// Returns students below the given attendance threshold (default 75%)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/defaulters", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, "defaulter_list");
    if (!teacher) return;

    const { course_id, semester, threshold = 75 } = req.query;
    if (!course_id || !semester) {
      return res.status(400).json({ success: false, error: "course_id and semester are required" });
    }
    const thresholdNum = parseFloat(threshold);

    // Pull attendance summaries for students in this course + semester
    const studentsSnap = await db
      .collection("students")
      .where("course_id", "==", course_id)
      .where("semester", "==", Number(semester))
      .where("approval_status", "==", "approved")
      .get();

    const defaulters = [];

    for (const doc of studentsSnap.docs) {
      const student = doc.data();
      const uid = doc.id;

      // Pull attendance record
      const attSnap = await db
        .collection("attendance_summary")
        .where("student_id", "==", uid)
        .get();

      if (attSnap.empty) {
        defaulters.push({
          student_id: uid,
          name: student.name,
          roll_no: student.roll_no,
          overall_percentage: 0,
        });
        continue;
      }

      const summary = attSnap.docs[0].data();
      const overall = summary.overall_percentage || 0;

      if (overall < thresholdNum) {
        defaulters.push({
          student_id: uid,
          name: student.name,
          roll_no: student.roll_no,
          overall_percentage: Math.round(overall),
          subject_breakdown: summary.subject_breakdown || [],
        });
      }
    }

    defaulters.sort((a, b) => a.overall_percentage - b.overall_percentage);

    return res.json({ success: true, defaulters, total: defaulters.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER ASSIGNMENT  (HOD only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/manage/available-teachers
 * Returns all staff in the same college (by aishe_code) who can be assigned
 * to a subject: role "teacher", "head_teacher", AND "hod".
 * The HOD intentionally appears here so they can assign lectures to themselves.
 */
router.get("/available-teachers", async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id) return res.status(400).json({ success: false, error: "teacher_id required" });

    // Look up the caller's aishe_code
    const callerSnap = await db.collection("teachers").doc(teacher_id).get();
    if (!callerSnap.exists) return res.status(404).json({ success: false, error: "Teacher not found" });
    const { aishe_code, role: callerRole } = callerSnap.data();

    if (callerRole !== "hod") {
      return res.status(403).json({ success: false, error: "HOD only" });
    }

    // Fetch ALL approved staff in this college across all teaching roles
    const snap = await db
      .collection("teachers")
      .where("aishe_code", "==", aishe_code)
      .where("approval_status", "==", "approved")
      .get();

    const teachers = snap.docs
      .filter((d) => ["teacher", "head_teacher", "hod"].includes(d.data().role))
      .map((d) => {
        const data = d.data();
        const isHOD = d.id === teacher_id;
        return {
          teacher_id: d.id,
          name: `${data.first_name} ${data.last_name}${isHOD ? " (You)" : ""}`,
          designation: data.designation || data.role,
          role: data.role,
        };
      })
      // Sort: HOD first, then head_teachers, then teachers — alphabetically within each
      .sort((a, b) => {
        const order = { hod: 0, head_teacher: 1, teacher: 2 };
        const byRole = (order[a.role] ?? 3) - (order[b.role] ?? 3);
        if (byRole !== 0) return byRole;
        return a.name.localeCompare(b.name);
      });

    return res.json({ success: true, teachers });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.get("/teacher-assignments", async (req, res) => {
  try {
    const { course_id, semester } = req.query;
    if (!course_id || !semester) {
      return res.status(400).json({ success: false, error: "course_id and semester are required" });
    }
    const snap = await db
      .collection("teacher_subject_assignments")
      .where("course_id", "==", course_id)
      .where("semester", "==", Number(semester))
      .get();
    const assignments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, assignments });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

router.post("/teacher-assignments/assign", async (req, res) => {
  try {
    const teacher = await requireHODOrDelegate(req, res, null);
    if (!teacher || teacher.role !== "hod") {
      return res.status(403).json({ success: false, error: "HOD only" });
    }

    const { subject_id, teacher_id: targetTeacherId, course_id, semester } = req.body;

    if (!subject_id || !targetTeacherId || !course_id || !semester) {
      return res.status(400).json({ success: false, error: "subject_id, teacher_id, course_id, and semester are required" });
    }

    // Upsert assignment
    const existing = await db
      .collection("teacher_subject_assignments")
      .where("subject_id", "==", subject_id)
      .limit(1)
      .get();

    if (!existing.empty) {
      await existing.docs[0].ref.update({ teacher_id: targetTeacherId });
    } else {
      await db.collection("teacher_subject_assignments").add({
        subject_id, teacher_id: targetTeacherId,
        course_id, semester: Number(semester),
        assigned_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELEGATE RIGHTS
// ─────────────────────────────────────────────────────────────────────────────

// List all head_teachers under the HOD's aishe_code
router.get("/delegate/list", async (req, res) => {
  try {
    const { hod_teacher_id } = req.query;
    if (!hod_teacher_id) {
      return res.status(400).json({ success: false, error: "hod_teacher_id is required" });
    }

    const hodSnap = await db.collection("teachers").doc(hod_teacher_id).get();
    if (!hodSnap.exists) return res.status(404).json({ success: false, error: "HOD not found" });

    const { aishe_code } = hodSnap.data();

    const snap = await db
      .collection("teachers")
      .where("aishe_code", "==", aishe_code)
      .where("role", "==", "head_teacher")
      .where("approval_status", "==", "approved")
      .get();

    const head_teachers = snap.docs.map((d) => {
      const data = d.data();
      return {
        teacher_id: d.id,
        name: `${data.first_name} ${data.last_name}`,
        designation: data.designation || "Head Teacher",
        delegated_keys: data.delegated_keys || [],
      };
    });

    return res.json({ success: true, head_teachers });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// Toggle a single right
router.post("/delegate/toggle", async (req, res) => {
  try {
    const { hod_teacher_id, target_teacher_id, key, grant } = req.body;

    if (!hod_teacher_id || !target_teacher_id || !key || grant === undefined) {
      return res.status(400).json({ success: false, error: "hod_teacher_id, target_teacher_id, key and grant are required" });
    }

    // Verify caller is HOD
    const hodSnap = await db.collection("teachers").doc(hod_teacher_id).get();
    if (!hodSnap.exists || hodSnap.data().role !== "hod") {
      return res.status(403).json({ success: false, error: "HOD only" });
    }

    const targetRef = db.collection("teachers").doc(target_teacher_id);
    if (grant) {
      await targetRef.update({
        delegated_keys: admin.firestore.FieldValue.arrayUnion(key),
      });
    } else {
      await targetRef.update({
        delegated_keys: admin.firestore.FieldValue.arrayRemove(key),
      });
    }
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});



// Grant all delegatable rights at once
router.post("/delegate/grant-all", async (req, res) => {
  try {
    const { hod_teacher_id, target_teacher_id } = req.body;

    if (!hod_teacher_id || !target_teacher_id) {
      return res.status(400).json({ success: false, error: "hod_teacher_id and target_teacher_id are required" });
    }

    const hodSnap = await db.collection("teachers").doc(hod_teacher_id).get();
    if (!hodSnap.exists || hodSnap.data().role !== "hod") {
      return res.status(403).json({ success: false, error: "HOD only" });
    }
    const delegatableKeys = ["timetable", "academic_calendar", "defaulter_list"];
    await db.collection("teachers").doc(target_teacher_id).update({
      delegated_keys: delegatableKeys,
    });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// Revoke all rights
router.post("/delegate/revoke-all", async (req, res) => {
  try {
    const { hod_teacher_id, target_teacher_id } = req.body;

    if (!hod_teacher_id || !target_teacher_id) {
      return res.status(400).json({ success: false, error: "hod_teacher_id and target_teacher_id are required" });
    }

    const hodSnap = await db.collection("teachers").doc(hod_teacher_id).get();
    if (!hodSnap.exists || hodSnap.data().role !== "hod") {
      return res.status(403).json({ success: false, error: "HOD only" });
    }
    await db.collection("teachers").doc(target_teacher_id).update({
      delegated_keys: [],
    });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELEGATED KEYS — fetched on login for head_teacher
// ─────────────────────────────────────────────────────────────────────────────
router.get("/delegated", async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id is required" });
    }
    const snap = await db.collection("teachers").doc(teacher_id).get();
    if (!snap.exists) return res.status(404).json({ success: false, error: "Not found" });
    const data = snap.data();
    return res.json({ success: true, delegated_keys: data.delegated_keys || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Server error" });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// DEBUG ENDPOINT — REMOVE AFTER FIXING
// GET /api/manage/debug-hod?teacher_id=xxx
// Returns everything about the teacher doc + what courses exist for their aishe_code
// ─────────────────────────────────────────────────────────────────────────────
router.get("/debug-hod", async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id) return res.status(400).json({ error: "teacher_id required" });

    const result = {
      input_teacher_id: teacher_id,
      lookup_by_doc_id: null,
      lookup_by_teacher_id_field: null,
      lookup_by_user_id_field: null,
      resolved_teacher: null,
      aishe_code: null,
      courses_found: [],
      sample_courses_in_db: [],
    };

    // Try 1: by doc ID
    const d1 = await db.collection("teachers").doc(teacher_id).get();
    result.lookup_by_doc_id = d1.exists ? { found: true, data: d1.data() } : { found: false };

    // Try 2: by teacher_id field
    const d2 = await db.collection("teachers").where("teacher_id", "==", teacher_id).limit(1).get();
    result.lookup_by_teacher_id_field = !d2.empty ? { found: true, data: d2.docs[0].data() } : { found: false };

    // Try 3: by user_id field
    const d3 = await db.collection("teachers").where("user_id", "==", teacher_id).limit(1).get();
    result.lookup_by_user_id_field = !d3.empty ? { found: true, data: d3.docs[0].data() } : { found: false };

    // Use whichever found the teacher
    const resolved = d1.exists ? d1.data() : (!d2.empty ? d2.docs[0].data() : (!d3.empty ? d3.docs[0].data() : null));
    result.resolved_teacher = resolved;

    if (resolved) {
      result.aishe_code = resolved.aishe_code || "MISSING";

      if (resolved.aishe_code) {
        const coursesSnap = await db.collection("courses").where("aishe_code", "==", resolved.aishe_code).get();
        result.courses_found = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      }
    }

    // Sample 5 courses from DB to check aishe_code format
    const sampleSnap = await db.collection("courses").limit(5).get();
    result.sample_courses_in_db = sampleSnap.docs.map(d => ({
      id: d.id,
      aishe_code: d.data().aishe_code,
      course_name: d.data().course_name,
    }));

    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;