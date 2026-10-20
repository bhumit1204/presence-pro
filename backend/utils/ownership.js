/**
 * utils/ownership.js
 *
 * "Does this teacher teach this subject?" - used by routes that previously
 * trusted the teacher_id/subject_id pair sent by the client.
 *
 * A teacher counts as owning a subject when either
 *   - subjects/{id}.teacher_assigned (or .teacher_id) is the teacher, or
 *   - the teacher has at least one lecture for that subject (covers substitute /
 *     swapped lectures, which is how the broadcast screen already finds subjects).
 */

const { db } = require("../config/firebase");
const { TTLCache } = require("./cache");

const subjectCache = new TTLCache({ max: 10_000, ttlMs: 30_000 });
const lectureCache = new TTLCache({ max: 20_000, ttlMs: 30_000 });

function getSubject(subject_id) {
  return subjectCache.memo(subject_id, 30_000, async () => {
    const d = await db.collection("subjects").doc(subject_id).get();
    return d.exists ? d.data() : null;
  });
}

async function teacherOwnsSubject(teacher_id, subject_id) {
  if (!teacher_id || !subject_id) return false;
  const subj = await getSubject(String(subject_id));
  if (subj && (subj.teacher_assigned === teacher_id || subj.teacher_id === teacher_id)) return true;
  return lectureCache.memo(
    `${teacher_id}|${subject_id}`,
    30_000,
    async () => {
      const l = await db
        .collection("lectures")
        .where("teacher_id", "==", teacher_id)
        .where("subject_id", "==", subject_id)
        .limit(1)
        .select()
        .get();
      return !l.empty;
    },
    { cacheNull: true }
  );
}

const enrolledCache = new TTLCache({ max: 20_000, ttlMs: 30_000 });

/** Is this student enrolled in the subject? (students/{uid} or students where uid==) */
async function studentEnrolled(uid, subject_id) {
  if (!uid || !subject_id) return false;
  const list = await enrolledCache.memo(String(uid), 30_000, async () => {
    let d = await db.collection("students").doc(String(uid)).get();
    if (!d.exists) {
      const q = await db.collection("students").where("uid", "==", String(uid)).limit(1).get();
      if (q.empty) return null;
      d = q.docs[0];
    }
    return d.data().enrolled_subjects || [];
  });
  return !!list && list.includes(subject_id);
}

module.exports = { teacherOwnsSubject, getSubject, studentEnrolled };
