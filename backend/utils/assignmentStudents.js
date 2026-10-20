/**
 * utils/assignmentStudents.js
 *
 * GET /:id/students?teacher_id=   -> every approved student enrolled in the subject of an assignment.
 *
 * In the original code this handler was pasted into web/teacher.routes.js (so it was reachable only as
 * /api/web/teacher/:id/students) although its own comment says it belongs to assignment_routes.js.
 * It is now registered in BOTH routers with this single implementation, so both URLs work.
 */
const { db } = require("../config/firebase");
const { TTLCache } = require("./cache");

const listCache = new TTLCache({ max: 500, ttlMs: 10_000 }); // subject_id -> students

function enrolledList(subject_id) {
  return listCache.memo(subject_id, 10_000, async () => {
    const snap = await db.collection("students")
      .where("enrolled_subjects", "array-contains", subject_id)
      .where("approval_status", "==", "approved")
      .select("uid", "name", "first_name", "last_name", "roll_no", "roll_number")
      .get();

    return snap.docs.map((d) => {
      const s = d.data();
      return {
        uid:  s.uid  || d.id,
        name: s.name || `${s.first_name || ""} ${s.last_name || ""}`.trim() || "Unknown",
        roll: s.roll_no || s.roll_number || null,
      };
    }).sort((a, b) =>
      (a.roll || a.name).localeCompare(b.roll || b.name, undefined, { numeric: true })
    );
  });
}

async function assignmentStudentsHandler(req, res) {
  try {
    const { id }          = req.params;
    const { teacher_id }  = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id required" });
    }
    if (typeof id !== "string" || !id || id.includes("/")) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }

    // Ownership check
    const assignSnap = await db.collection("assignments").doc(id).get();
    if (!assignSnap.exists) {
      return res.status(404).json({ success: false, error: "Assignment not found" });
    }
    if (assignSnap.data().teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const students = await enrolledList(assignSnap.data().subject_id);
    return res.json({ success: true, count: students.length, students });

  } catch (err) {
    console.error("ASSIGNMENT STUDENTS ERROR:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch students" });
  }
}

module.exports = { assignmentStudentsHandler };
