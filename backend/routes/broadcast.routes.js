const express = require("express");
const router  = express.Router();
const { admin, db } = require("../config/firebase");
const { notify } = require("../services/notify");

// ═══════════════════════════════════════════════════════════════════
// /api/broadcasts
// ═══════════════════════════════════════════════════════════════════

// ─── helpers ──────────────────────────────────────────────────────

async function getStudentsForSubject(subject_id) {
  const snap = await db
    .collection("students")
    .where("enrolled_subjects", "array-contains", subject_id)
    .where("approval_status", "==", "approved")
    .get();
  return snap.docs.map((d) => d.data().uid || d.id);
}

async function attendancePct(student_uid, subject_id) {
  try {
    const [sessSnap, presentSnap] = await Promise.all([
      db.collection("lecture_sessions")
        .where("subject_id", "==", subject_id)
        .where("is_live", "==", false)
        .get(),
      db.collection("attendance_records")
        .where("student_uid", "==", student_uid)
        .where("subject_id", "==", subject_id)
        .where("status", "==", "present")
        .get(),
    ]);
    const total = sessSnap.size;
    if (total === 0) return 100;
    return parseFloat(((presentSnap.size / total) * 100).toFixed(1));
  } catch { return 100; }
}

async function filterByAttendance(uids, subject_id, filter) {
  if (!filter || filter === "none" || !subject_id) return uids;
  const threshold = filter === "below_50" ? 50 : 75;
  const results = await Promise.all(
    uids.map(async (uid) => {
      const pct = await attendancePct(uid, subject_id);
      return pct < threshold ? uid : null;
    })
  );
  return results.filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════
// IMPORTANT: ALL static named routes MUST come before /:broadcast_id
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/broadcasts/subjects?teacher_id= ────────────────────
// FIX: Query subjects collection directly by teacher_id.
//      Fall back to scanning lectures collection if subjects query is empty.
router.get("/subjects", async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });

    const seen     = new Set();
    const subjects = [];

    // ── Primary: subjects collection has a teacher_id field ──────
    const subjectSnap = await db
      .collection("subjects")
      .where("teacher_id", "==", teacher_id)
      .get();

    subjectSnap.docs.forEach((d) => {
      const data = d.data();
      if (!seen.has(d.id)) {
        seen.add(d.id);
        subjects.push({
          subject_id:   d.id,
          subject_name: data.subject_name || data.name || d.id,
          course_id:    data.course_id    || "",
          course_name:  data.course_name  || "",
        });
      }
    });

    // ── Fallback: derive from lectures collection ─────────────────
    if (subjects.length === 0) {
      const lectureSnap = await db
        .collection("lectures")
        .where("teacher_id", "==", teacher_id)
        .get();

      const subjectIds = [
        ...new Set(lectureSnap.docs.map((d) => d.data().subject_id).filter(Boolean)),
      ];

      // Fetch each subject doc individually (avoids composite index)
      for (const sid of subjectIds) {
        if (seen.has(sid)) continue;
        seen.add(sid);
        try {
          const subDoc = await db.collection("subjects").doc(sid).get();
          if (subDoc.exists) {
            const s = subDoc.data();
            subjects.push({
              subject_id:   sid,
              subject_name: s.subject_name || s.name || sid,
              course_id:    s.course_id    || "",
              course_name:  s.course_name  || "",
            });
          } else {
            // Subject doc missing — use lecture metadata if available
            const lec = lectureSnap.docs.find((d) => d.data().subject_id === sid);
            if (lec) {
              const ld = lec.data();
              subjects.push({
                subject_id:   sid,
                subject_name: ld.subject_name || ld.subject || sid,
                course_id:    ld.course_id    || "",
                course_name:  ld.course_name  || "",
              });
            }
          }
        } catch (_) {}
      }
    }

    return res.json({ success: true, subjects });
  } catch (e) {
    console.error("SUBJECTS ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to fetch subjects" });
  }
});

// ─── GET /api/broadcasts/students?teacher_id= ───────────────────
// FIX: Derive the teacher's subject IDs from the subjects collection
//      first, then fall back to lectures, so we always get students.
router.get("/students", async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });

    // ── Collect subject IDs via subjects collection ───────────────
    const subjectSnap = await db
      .collection("subjects")
      .where("teacher_id", "==", teacher_id)
      .get();

    let subjectIds = subjectSnap.docs.map((d) => d.id).filter(Boolean);

    // ── Fallback: derive from lectures ───────────────────────────
    if (subjectIds.length === 0) {
      const lectureSnap = await db
        .collection("lectures")
        .where("teacher_id", "==", teacher_id)
        .get();
      subjectIds = [
        ...new Set(lectureSnap.docs.map((d) => d.data().subject_id).filter(Boolean)),
      ];
    }

    if (subjectIds.length === 0)
      return res.json({ success: true, students: [] });

    const seenUids = new Set();
    const students = [];

    // Firestore "array-contains-any" supports up to 30 items per query
    const chunks = [];
    for (let i = 0; i < subjectIds.length; i += 30)
      chunks.push(subjectIds.slice(i, i + 30));

    for (const chunk of chunks) {
      const snap = await db
        .collection("students")
        .where("enrolled_subjects", "array-contains-any", chunk)
        .get();

      snap.docs.forEach((d) => {
        const data = d.data();
        // Skip unapproved students
        if (data.approval_status && data.approval_status !== "approved") return;
        const uid = data.uid || d.id;
        if (!seenUids.has(uid)) {
          seenUids.add(uid);
          students.push({
            uid,
            name:        data.name || `${data.first_name || ""} ${data.last_name || ""}`.trim(),
            roll_no:     data.roll_no     || "",
            course_name: data.course_name || "",
          });
        }
      });
    }

    students.sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ success: true, students });
  } catch (e) {
    console.error("STUDENTS ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to fetch students" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GROUPS CRUD — all /groups/* before /:broadcast_id
// No orderBy with .where() → no composite index needed
// Sort newest-first in JavaScript instead
// ═══════════════════════════════════════════════════════════════════

router.get("/groups", async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });

    const snap = await db
      .collection("broadcast_groups")
      .where("teacher_id", "==", teacher_id)
      .get();

    const groups = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const aTime = a.created_at?.toMillis?.() ?? (a.created_at?._seconds ?? 0) * 1000;
        const bTime = b.created_at?.toMillis?.() ?? (b.created_at?._seconds ?? 0) * 1000;
        return bTime - aTime;
      });

    return res.json({ success: true, groups });
  } catch (e) {
    console.error("LIST GROUPS ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to fetch groups" });
  }
});

router.post("/groups", async (req, res) => {
  try {
    const { teacher_id, name, member_uids = [] } = req.body;
    if (!teacher_id || !name)
      return res.status(400).json({ success: false, error: "teacher_id and name required" });

    const ref = db.collection("broadcast_groups").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();
    await ref.set({
      group_id:    ref.id,
      teacher_id,
      name:        name.trim(),
      member_uids: Array.isArray(member_uids) ? member_uids : [],
      created_at:  now,
      updated_at:  now,
    });
    return res.status(201).json({ success: true, group_id: ref.id });
  } catch (e) {
    console.error("CREATE GROUP ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to create group" });
  }
});

router.put("/groups/:group_id", async (req, res) => {
  try {
    const { group_id }                      = req.params;
    const { teacher_id, name, member_uids } = req.body;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });

    const ref = db.collection("broadcast_groups").doc(group_id);
    const doc = await ref.get();
    if (!doc.exists)
      return res.status(404).json({ success: false, error: "Group not found" });
    if (doc.data().teacher_id !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    const updates = { updated_at: admin.firestore.FieldValue.serverTimestamp() };
    if (name        !== undefined) updates.name        = name.trim();
    if (member_uids !== undefined) updates.member_uids = member_uids;

    await ref.update(updates);
    return res.json({ success: true });
  } catch (e) {
    console.error("UPDATE GROUP ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to update group" });
  }
});

router.delete("/groups/:group_id", async (req, res) => {
  try {
    const { group_id }   = req.params;
    const { teacher_id } = req.query;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });

    const ref = db.collection("broadcast_groups").doc(group_id);
    const doc = await ref.get();
    if (!doc.exists)
      return res.status(404).json({ success: false, error: "Group not found" });
    if (doc.data().teacher_id !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    await ref.delete();
    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE GROUP ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to delete group" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// STUDENT inbox  GET /api/broadcasts/student/:uid
// Single .where() — sort in JS
// ═══════════════════════════════════════════════════════════════════
router.get("/student/:uid", async (req, res) => {
  try {
    const { uid } = req.params;

    const snap = await db
      .collection("broadcasts")
      .where("recipient_uids", "array-contains", uid)
      .get();

    const broadcasts = snap.docs
      .map((d) => {
        const data = d.data();
        return {
          broadcast_id: d.id,
          title:        data.title,
          text:         data.text,
          target_type:  data.target_type,
          is_urgent:    Boolean(data.is_urgent),
          is_read:      (data.read_by || []).includes(uid),
          created_at:   data.created_at?.toDate?.()?.toISOString() || null,
        };
      })
      .sort((a, b) => {
        if (a.is_urgent && !b.is_urgent) return -1;
        if (!a.is_urgent && b.is_urgent) return 1;
        const at = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bt - at;
      })
      .slice(0, 50);

    return res.json({ success: true, broadcasts });
  } catch (e) {
    console.error("STUDENT INBOX ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to fetch broadcasts" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// TEACHER list  GET /api/broadcasts?teacher_id=
// Single .where() — sort in JS
// ═══════════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });

    const snap = await db
      .collection("broadcasts")
      .where("teacher_id", "==", teacher_id)
      .get();

    const broadcasts = snap.docs
      .map((d) => {
        const data = d.data();
        return {
          ...data,
          broadcast_id: d.id,
          created_at:   data.created_at?.toDate?.()?.toISOString() || null,
          updated_at:   data.updated_at?.toDate?.()?.toISOString() || null,
        };
      })
      .sort((a, b) => {
        const at = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bt - at;
      })
      .slice(0, 50);

    return res.json({ success: true, broadcasts });
  } catch (e) {
    console.error("LIST BROADCASTS ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to fetch broadcasts" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CREATE BROADCAST  POST /api/broadcasts
// FIX: course_id is now auto-fetched from the subject doc so the
//      frontend doesn't need to supply a non-empty value.
// ═══════════════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  try {
    const {
      teacher_id, title, text, target_type,
      subject_id, course_id: rawCourseId, group_id,
      recipient_uids,
      is_urgent         = false,
      attendance_filter = "none",
    } = req.body;

    if (!teacher_id || !title || !text || !target_type)
      return res.status(400).json({ success: false, error: "teacher_id, title, text, target_type required" });
    if (!["individual", "group", "class"].includes(target_type))
      return res.status(400).json({ success: false, error: "Invalid target_type" });
    if (target_type === "class" && !subject_id)
      return res.status(400).json({ success: false, error: "subject_id required for class broadcast" });
    if (target_type === "group" && !group_id)
      return res.status(400).json({ success: false, error: "group_id required for group broadcast" });
    if (target_type === "individual" && (!Array.isArray(recipient_uids) || !recipient_uids.length))
      return res.status(400).json({ success: false, error: "recipient_uids required for individual broadcast" });

    // ── FIX: resolve course_id from subject doc if not supplied ──
    let course_id = rawCourseId || null;
    if (target_type === "class" && !course_id) {
      try {
        const subDoc = await db.collection("subjects").doc(subject_id).get();
        if (subDoc.exists) course_id = subDoc.data().course_id || null;
      } catch (_) {}
    }

    let finalUids = [];

    if (target_type === "individual") {
      finalUids = recipient_uids;
    } else if (target_type === "class") {
      const allUids = await getStudentsForSubject(subject_id);
      finalUids     = await filterByAttendance(allUids, subject_id, attendance_filter);
    } else {
      // group — ALL members, no attendance filter
      const groupDoc = await db.collection("broadcast_groups").doc(group_id).get();
      if (!groupDoc.exists)
        return res.status(404).json({ success: false, error: "Group not found" });
      finalUids = groupDoc.data().member_uids || [];
    }

    if (!finalUids.length)
      return res.json({ success: true, message: "No recipients matched.", recipient_count: 0 });

    const ref = db.collection("broadcasts").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();

    await ref.set({
      broadcast_id:      ref.id,
      teacher_id,
      title:             title.trim(),
      text:              text.trim(),
      target_type,
      subject_id:        subject_id || null,
      course_id:         course_id  || null,
      group_id:          group_id   || null,
      attendance_filter: target_type === "class" ? (attendance_filter || "none") : "none",
      recipient_uids:    finalUids,
      recipient_count:   finalUids.length,
      is_urgent:         Boolean(is_urgent),
      read_by:           [],
      created_at:        now,
      updated_at:        now,
    });

    notify({
      userIds: finalUids,
      title: is_urgent ? `🚨 ${title.trim()}` : title.trim(),
      body: text.trim().slice(0, 120),
      data: { screen: "BroadcastInbox" },
    });

    return res.status(201).json({
      success:         true,
      broadcast_id:    ref.id,
      recipient_count: finalUids.length,
      message:         `Broadcast sent to ${finalUids.length} student(s)`,
    });
  } catch (e) {
    console.error("CREATE BROADCAST ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to create broadcast" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Mark read  POST /api/broadcasts/:broadcast_id/read
// ═══════════════════════════════════════════════════════════════════
router.post("/:broadcast_id/read", async (req, res) => {
  try {
    const { broadcast_id } = req.params;
    const { uid }          = req.body;
    if (!uid)
      return res.status(400).json({ success: false, error: "uid required" });

    await db.collection("broadcasts").doc(broadcast_id).update({
      read_by: admin.firestore.FieldValue.arrayUnion(uid),
    });
    return res.json({ success: true });
  } catch (e) {
    console.error("MARK READ ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to mark as read" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Delete  DELETE /api/broadcasts/:broadcast_id?teacher_id=
// ═══════════════════════════════════════════════════════════════════
router.delete("/:broadcast_id", async (req, res) => {
  try {
    const { broadcast_id } = req.params;
    const { teacher_id }   = req.query;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });

    const ref = db.collection("broadcasts").doc(broadcast_id);
    const doc = await ref.get();
    if (!doc.exists)
      return res.status(404).json({ success: false, error: "Not found" });
    if (doc.data().teacher_id !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    await ref.delete();
    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE BROADCAST ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to delete broadcast" });
  }
});

module.exports = router;