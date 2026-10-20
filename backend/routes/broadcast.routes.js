const express = require("express");
const router  = express.Router();
const { admin, db } = require("../config/firebase");
const { notify } = require("../services/notify");
const { guard, allow, fromQuery, fromBody, fromParams } = require("../middleware/auth");
const { TTLCache } = require("../utils/cache");
const { createCoalescer } = require("../utils/coalesce");
const { getDocsByIds, queryInChunks, countQuery, isIndexMissing } = require("../utils/firestore");

// ═══════════════════════════════════════════════════════════════════
// /api/broadcasts
// ═══════════════════════════════════════════════════════════════════

// ─── caches (all short-lived; invalidated on writes made through this process) ──
const subjectsCache  = new TTLCache({ max: 2000,  ttlMs: 30_000 }); // teacher_id -> subjects[]
const studentsCache  = new TTLCache({ max: 2000,  ttlMs: 30_000 }); // teacher_id -> students[]
const classUidsCache = new TTLCache({ max: 2000,  ttlMs: 30_000 }); // subject_id -> uids[]
const subjectDocCache = new TTLCache({ max: 5000, ttlMs: 30_000 }); // subject_id -> subject data
const inboxCache     = new TTLCache({ max: 20000, ttlMs: 10_000 }); // student uid -> broadcasts[]
const sentCache      = new TTLCache({ max: 2000,  ttlMs: 10_000 }); // teacher_id -> broadcasts[]
const readSeen       = new TTLCache({ max: 100_000, ttlMs: 60_000 }); // "bid:uid" already written

const MAX_RECIPIENTS = 5000; // keeps a broadcast document far below Firestore's 1 MiB limit

// ─── Mark-read: ONE write per broadcast per ~250 ms instead of one per student ──
// (hundreds of students opening the same broadcast used to hammer one document)
const readCoalescer = createCoalescer(
  async (broadcastId, uids) => {
    await db.collection("broadcasts").doc(broadcastId).update({
      read_by: admin.firestore.FieldValue.arrayUnion(...uids),
    });
    uids.forEach((u) => inboxCache.del(u));
  },
  { windowMs: 250, maxItems: 200 }
);

// ─── index availability for the "fast" ordered queries ─────────────────────────
// The original sorts in JavaScript so that no composite index is required. The
// fast paths below need the indexes listed in the integration notes; if an index
// is missing Firestore answers FAILED_PRECONDITION and we transparently fall
// back to the original (unordered read + JS sort) behaviour.
const fast = { inbox: process.env.BROADCAST_FAST !== "off", sent: process.env.BROADCAST_FAST !== "off" };
function noteIndexMissing(which, e) {
  if (isIndexMissing(e) && fast[which]) {
    fast[which] = false;
    console.warn(`[broadcasts] composite index missing for "${which}" list - using the slower fallback. ${String(e.message).split("\n")[0]}`);
  }
}

// ─── helpers ──────────────────────────────────────────────────────

async function getSubjectDoc(subject_id) {
  return subjectDocCache.memo(subject_id, 30_000, async () => {
    const d = await db.collection("subjects").doc(subject_id).get();
    return d.exists ? d.data() : null;
  });
}

async function getStudentsForSubject(subject_id) {
  return classUidsCache.memo(subject_id, 30_000, async () => {
    const snap = await db
      .collection("students")
      .where("enrolled_subjects", "array-contains", subject_id)
      .where("approval_status", "==", "approved")
      .select("uid")
      .get();
    return snap.docs.map((d) => d.data().uid || d.id);
  });
}

/**
 * Attendance % per student for one subject, computed from TWO queries total
 * (the original ran two queries per student: a class-wide session query repeated
 * for every student plus a per-student records query).
 *
 *   total   = completed (is_live == false) lecture sessions of the subject
 *   present = attendance_records with status "present" (late / od are NOT counted,
 *             exactly like the original)
 */
async function attendancePctMap(uids, subject_id) {
  const [total, presentSnap] = await Promise.all([
    countQuery(
      db.collection("lecture_sessions")
        .where("subject_id", "==", subject_id)
        .where("is_live", "==", false)
    ),
    db.collection("attendance_records")
      .where("subject_id", "==", subject_id)
      .where("status", "==", "present")
      .select("student_uid")
      .get(),
  ]);

  const presentCount = new Map();
  presentSnap.docs.forEach((d) => {
    const u = d.data().student_uid;
    presentCount.set(u, (presentCount.get(u) || 0) + 1);
  });

  const pct = new Map();
  for (const uid of uids) {
    pct.set(uid, total === 0 ? 100 : parseFloat((((presentCount.get(uid) || 0) / total) * 100).toFixed(1)));
  }
  return pct;
}

async function filterByAttendance(uids, subject_id, filter) {
  if (!filter || filter === "none" || !subject_id) return uids;
  const threshold = filter === "below_50" ? 50 : 75;
  try {
    const pct = await attendancePctMap(uids, subject_id);
    return uids.filter((uid) => pct.get(uid) < threshold);
  } catch {
    // original: any error => 100% => nobody matches
    return [];
  }
}

const toIso = (ts) => ts?.toDate?.()?.toISOString() || null;

// ═══════════════════════════════════════════════════════════════════
// IMPORTANT: ALL static named routes MUST come before /:broadcast_id
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/broadcasts/subjects?teacher_id= ────────────────────
router.get("/subjects", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });

    const subjects = await subjectsCache.memo(teacher_id, 30_000, async () => {
      const seen = new Set();
      const out  = [];

      // ── Primary: subjects collection has a teacher_id field ──────
      const subjectSnap = await db
        .collection("subjects")
        .where("teacher_id", "==", teacher_id)
        .get();

      subjectSnap.docs.forEach((d) => {
        const data = d.data();
        if (!seen.has(d.id)) {
          seen.add(d.id);
          out.push({
            subject_id:   d.id,
            subject_name: data.subject_name || data.name || d.id,
            course_id:    data.course_id    || "",
            course_name:  data.course_name  || "",
          });
        }
      });

      // ── Fallback: derive from lectures collection ─────────────────
      if (out.length === 0) {
        const lectureSnap = await db
          .collection("lectures")
          .where("teacher_id", "==", teacher_id)
          .get();

        const subjectIds = [
          ...new Set(lectureSnap.docs.map((d) => d.data().subject_id).filter(Boolean)),
        ];

        // ONE batched read instead of one GET per subject
        const subDocs = await getDocsByIds("subjects", subjectIds);

        for (const sid of subjectIds) {
          if (seen.has(sid)) continue;
          seen.add(sid);
          const subDoc = subDocs.get(sid);
          if (subDoc) {
            const s = subDoc.data();
            out.push({
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
              out.push({
                subject_id:   sid,
                subject_name: ld.subject_name || ld.subject || sid,
                course_id:    ld.course_id    || "",
                course_name:  ld.course_name  || "",
              });
            }
          }
        }
      }
      return out;
    });

    return res.json({ success: true, subjects });
  } catch (e) {
    console.error("SUBJECTS ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to fetch subjects" });
  }
});

// ─── GET /api/broadcasts/students?teacher_id= ───────────────────
router.get("/students", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });

    const students = await studentsCache.memo(teacher_id, 30_000, async () => {
      // ── Collect subject IDs via subjects collection ───────────────
      const subjectSnap = await db
        .collection("subjects")
        .where("teacher_id", "==", teacher_id)
        .select()
        .get();

      let subjectIds = subjectSnap.docs.map((d) => d.id).filter(Boolean);

      // ── Fallback: derive from lectures ───────────────────────────
      if (subjectIds.length === 0) {
        const lectureSnap = await db
          .collection("lectures")
          .where("teacher_id", "==", teacher_id)
          .select("subject_id")
          .get();
        subjectIds = [
          ...new Set(lectureSnap.docs.map((d) => d.data().subject_id).filter(Boolean)),
        ];
      }

      if (subjectIds.length === 0) return [];

      const seenUids = new Set();
      const list = [];

      // Firestore "array-contains-any" supports up to 30 items per query.
      // Chunks run in parallel; results are consumed in chunk order (same as before).
      const docs = await queryInChunks(subjectIds, (chunk) =>
        db.collection("students")
          .where("enrolled_subjects", "array-contains-any", chunk)
          .select("uid", "name", "first_name", "last_name", "roll_no", "course_name", "approval_status")
      );

      docs.forEach((d) => {
        const data = d.data();
        // Skip unapproved students
        if (data.approval_status && data.approval_status !== "approved") return;
        const uid = data.uid || d.id;
        if (!seenUids.has(uid)) {
          seenUids.add(uid);
          list.push({
            uid,
            name:        data.name || `${data.first_name || ""} ${data.last_name || ""}`.trim(),
            roll_no:     data.roll_no     || "",
            course_name: data.course_name || "",
          });
        }
      });

      list.sort((a, b) => a.name.localeCompare(b.name));
      return list;
    });

    return res.json({ success: true, students });
  } catch (e) {
    console.error("STUDENTS ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to fetch students" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GROUPS CRUD — all /groups/* before /:broadcast_id
// ═══════════════════════════════════════════════════════════════════

router.get("/groups", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
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

router.post("/groups", guard.teacher(fromBody("teacher_id")), async (req, res) => {
  try {
    const { teacher_id, name, member_uids = [] } = req.body;
    if (!teacher_id || !name)
      return res.status(400).json({ success: false, error: "teacher_id and name required" });
    if (typeof name !== "string")
      return res.status(400).json({ success: false, error: "name must be text" });
    if (Array.isArray(member_uids) && member_uids.length > MAX_RECIPIENTS)
      return res.status(400).json({ success: false, error: `A group can have at most ${MAX_RECIPIENTS} members` });

    const ref = db.collection("broadcast_groups").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();
    await ref.set({
      group_id:    ref.id,
      teacher_id,
      name:        name.trim().slice(0, 200),
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

router.put("/groups/:group_id", guard.teacher(fromBody("teacher_id")), async (req, res) => {
  try {
    const { group_id }                      = req.params;
    const { teacher_id, name, member_uids } = req.body;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });
    if (name !== undefined && typeof name !== "string")
      return res.status(400).json({ success: false, error: "name must be text" });
    if (member_uids !== undefined && (!Array.isArray(member_uids) || member_uids.length > MAX_RECIPIENTS))
      return res.status(400).json({ success: false, error: `member_uids must be a list of at most ${MAX_RECIPIENTS}` });

    const ref = db.collection("broadcast_groups").doc(group_id);
    const doc = await ref.get();
    if (!doc.exists)
      return res.status(404).json({ success: false, error: "Group not found" });
    if (doc.data().teacher_id !== teacher_id)
      return res.status(403).json({ success: false, error: "Access denied" });

    const updates = { updated_at: admin.firestore.FieldValue.serverTimestamp() };
    if (name        !== undefined) updates.name        = name.trim().slice(0, 200);
    if (member_uids !== undefined) updates.member_uids = member_uids;

    await ref.update(updates);
    return res.json({ success: true });
  } catch (e) {
    console.error("UPDATE GROUP ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to update group" });
  }
});

router.delete("/groups/:group_id", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
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
//
// Result: urgent first, then newest first, max 50  (unchanged).
//
// FAST PATH (needs 2 composite indexes, see notes): two small ordered queries
//   (urgent top 50  +  newest 50) that provably contain the same top 50 as
//   "read everything, sort in JS". The big `recipient_uids` array is never
//   transferred. FALLBACK = original algorithm (still without recipient_uids).
// ═══════════════════════════════════════════════════════════════════
const INBOX_FIELDS = ["title", "text", "target_type", "is_urgent", "read_by", "created_at"];

function toInboxItem(d, uid) {
  const data = d.data();
  return {
    broadcast_id: d.id,
    title:        data.title,
    text:         data.text,
    target_type:  data.target_type,
    is_urgent:    Boolean(data.is_urgent),
    is_read:      (data.read_by || []).includes(uid),
    created_at:   toIso(data.created_at),
  };
}

const inboxCompare = (a, b) => {
  if (a.is_urgent && !b.is_urgent) return -1;
  if (!a.is_urgent && b.is_urgent) return 1;
  const at = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
  return bt - at;
};

async function loadInbox(uid) {
  const base = db.collection("broadcasts").where("recipient_uids", "array-contains", uid);

  if (fast.inbox) {
    try {
      const [urgentSnap, recentSnap] = await Promise.all([
        base.where("is_urgent", "==", true).orderBy("created_at", "desc").limit(50).select(...INBOX_FIELDS).get(),
        base.orderBy("created_at", "desc").limit(50).select(...INBOX_FIELDS).get(),
      ]);
      const items = [
        ...urgentSnap.docs.map((d) => toInboxItem(d, uid)),
        ...recentSnap.docs.map((d) => toInboxItem(d, uid)).filter((i) => !i.is_urgent),
      ];
      return items.sort(inboxCompare).slice(0, 50);
    } catch (e) {
      noteIndexMissing("inbox", e);
      if (!isIndexMissing(e)) throw e;
    }
  }

  const snap = await base.select(...INBOX_FIELDS).get();
  return snap.docs.map((d) => toInboxItem(d, uid)).sort(inboxCompare).slice(0, 50);
}

router.get("/student/:uid", guard.student(fromParams("uid")), async (req, res) => {
  try {
    const { uid } = req.params;
    const broadcasts = await inboxCache.memo(uid, 10_000, () => loadInbox(uid));
    return res.json({ success: true, broadcasts });
  } catch (e) {
    console.error("STUDENT INBOX ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to fetch broadcasts" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// TEACHER list  GET /api/broadcasts?teacher_id=   (newest 50)
// ═══════════════════════════════════════════════════════════════════
function toSentItem(d) {
  const data = d.data();
  return {
    ...data,
    broadcast_id: d.id,
    created_at:   toIso(data.created_at),
    updated_at:   toIso(data.updated_at),
  };
}

async function loadSent(teacher_id) {
  const base = db.collection("broadcasts").where("teacher_id", "==", teacher_id);

  if (fast.sent) {
    try {
      const snap = await base.orderBy("created_at", "desc").limit(50).get();
      return snap.docs.map(toSentItem);
    } catch (e) {
      noteIndexMissing("sent", e);
      if (!isIndexMissing(e)) throw e;
    }
  }

  const snap = await base.get();
  return snap.docs
    .map(toSentItem)
    .sort((a, b) => {
      const at = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bt - at;
    })
    .slice(0, 50);
}

router.get("/", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
  try {
    const { teacher_id } = req.query;
    if (!teacher_id)
      return res.status(400).json({ success: false, error: "teacher_id required" });

    const broadcasts = await sentCache.memo(teacher_id, 10_000, () => loadSent(teacher_id));
    return res.json({ success: true, broadcasts });
  } catch (e) {
    console.error("LIST BROADCASTS ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to fetch broadcasts" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CREATE BROADCAST  POST /api/broadcasts
// course_id is auto-fetched from the subject doc so the frontend
// doesn't need to supply a non-empty value.
// ═══════════════════════════════════════════════════════════════════
router.post("/", guard.teacher(fromBody("teacher_id")), async (req, res) => {
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
    if (typeof title !== "string" || typeof text !== "string")
      return res.status(400).json({ success: false, error: "title and text must be text" });
    if (!["individual", "group", "class"].includes(target_type))
      return res.status(400).json({ success: false, error: "Invalid target_type" });
    if (target_type === "class" && !subject_id)
      return res.status(400).json({ success: false, error: "subject_id required for class broadcast" });
    if (target_type === "group" && !group_id)
      return res.status(400).json({ success: false, error: "group_id required for group broadcast" });
    if (target_type === "individual" && (!Array.isArray(recipient_uids) || !recipient_uids.length))
      return res.status(400).json({ success: false, error: "recipient_uids required for individual broadcast" });
    if (target_type === "individual" && recipient_uids.length > MAX_RECIPIENTS)
      return res.status(400).json({ success: false, error: `At most ${MAX_RECIPIENTS} recipients per broadcast` });

    // ── resolve course_id from subject doc if not supplied ──
    let course_id = rawCourseId || null;
    let subjectData = null;
    if (target_type === "class") {
      try {
        subjectData = await getSubjectDoc(subject_id);
        if (!course_id && subjectData) course_id = subjectData.course_id || null;
      } catch (_) {}

      // A teacher may only broadcast to a class they teach (assigned, or has a lecture in).
      // Only enforced when AUTH_MODE=enforce; logged otherwise.
      let owns = !!subjectData && (subjectData.teacher_assigned === teacher_id || subjectData.teacher_id === teacher_id);
      if (!owns && req.auth) {
        const l = await db.collection("lectures")
          .where("teacher_id", "==", teacher_id).where("subject_id", "==", subject_id).limit(1).select().get();
        owns = !l.empty;
      }
      if (req.auth && !allow(req, res, owns, "broadcast-subject")) return;
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
      if (req.auth && !allow(req, res, groupDoc.data().teacher_id === teacher_id, "broadcast-group")) return;
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

    sentCache.del(teacher_id);
    finalUids.forEach((u) => inboxCache.del(u));

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
router.post("/:broadcast_id/read", guard.self(fromBody("uid")), async (req, res) => {
  try {
    const { broadcast_id } = req.params;
    const { uid }          = req.body;
    if (!uid)
      return res.status(400).json({ success: false, error: "uid required" });
    if (typeof uid !== "string" || uid.length > 128)
      return res.status(400).json({ success: false, error: "uid required" });

    const key = `${broadcast_id}:${uid}`;
    if (!readSeen.has(key)) {
      await readCoalescer.add(broadcast_id, uid); // resolves once the batched write has landed
      readSeen.set(key, true);
    }
    inboxCache.del(uid);
    return res.json({ success: true });
  } catch (e) {
    console.error("MARK READ ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to mark as read" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Delete  DELETE /api/broadcasts/:broadcast_id?teacher_id=
// ═══════════════════════════════════════════════════════════════════
router.delete("/:broadcast_id", guard.teacher(fromQuery("teacher_id")), async (req, res) => {
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
    sentCache.del(teacher_id);
    (doc.data().recipient_uids || []).forEach((u) => inboxCache.del(u));
    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE BROADCAST ERROR:", e.message);
    return res.status(500).json({ success: false, error: e.message || "Failed to delete broadcast" });
  }
});

/** write pending coalesced read receipts (call on graceful shutdown) */
router.flushPending = () => readCoalescer.flushAll();

module.exports = router;
