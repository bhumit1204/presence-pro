/**
 * utils/lectureAudience.js
 *
 * Which students belong to a lecture: they are enrolled in its subject (an elective only counts for the
 * students who chose it), are in its division and, for a lab, in its roll-number batch.
 * One query per subject, remembered for a minute, shared by every alert about that subject.
 */
const { db } = require("../config/firebase");
const { TTLCache } = require("./cache");
const { inBatch, rollOf } = require("./batches");
const { semesterMatches } = require("./studentTimetable");

const subjectCache = new TTLCache({ max: 2000, ttlMs: 60_000 });

/** approved students enrolled in a subject: [{ uid, division_id, roll_no, semester, notify_prefs }] */
function studentsOfSubject(subject_id) {
  if (typeof subject_id !== "string" || !subject_id || subject_id.includes("/")) return Promise.resolve([]);
  return subjectCache.memo(subject_id, 60_000, async () => {
    const snap = await db
      .collection("students")
      .where("enrolled_subjects", "array-contains", subject_id)
      .where("approval_status", "==", "approved")
      .select("uid", "division_id", "roll_no", "roll_number", "semester", "notify_prefs")
      .get();
    return snap.docs.map((d) => {
      const x = d.data();
      return { ...x, uid: x.uid || d.id };
    });
  });
}

/** the students a lecture (or lecture session: same division / batch fields) is meant for */
function audienceOf(lecture, students, { checkSemester = true } = {}) {
  return students.filter(
    (s) =>
      (!lecture.division_id || lecture.division_id === (s.division_id || null)) &&
      inBatch(lecture, rollOf(s)) &&
      (!checkSemester || semesterMatches(lecture, s))
  );
}

module.exports = { studentsOfSubject, audienceOf };
