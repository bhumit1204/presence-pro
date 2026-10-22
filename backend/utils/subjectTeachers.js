// A subject has one default teacher (teacher_assigned) and may have a different
// teacher for each division (division_teachers: { [division_id]: teacher_id }).
// teacher_ids is the denormalised list of everyone who teaches it, so that
// "does this teacher teach this subject?" stays a single array lookup.

const divMap = (s) => (s && s.division_teachers && typeof s.division_teachers === "object" ? s.division_teachers : {});

// who teaches this subject to this division
function effectiveTeacher(subject, divisionId) {
  if (!subject) return null;
  const m = divMap(subject);
  if (divisionId && m[divisionId]) return m[divisionId];
  return subject.teacher_assigned || null;
}

// every teacher on the subject (default + each division)
function allTeacherIds(subject) {
  const set = new Set();
  if (subject && subject.teacher_assigned) set.add(subject.teacher_assigned);
  Object.values(divMap(subject)).forEach((t) => t && set.add(t));
  return [...set];
}

// does this uid teach the subject (any division)?
function teachesSubject(subject, uid) {
  if (!subject || !uid) return false;
  return subject.teacher_assigned === uid || divMap(subject)[uid] === uid ||
    Object.values(divMap(subject)).includes(uid) ||
    (Array.isArray(subject.teacher_ids) && subject.teacher_ids.includes(uid));
}

// the teacher_ids / division_teachers to store for a change
function withDivisionTeacher(subject, divisionId, teacherId) {
  const m = { ...divMap(subject) };
  if (teacherId) m[divisionId] = teacherId; else delete m[divisionId];
  return m;
}
const idsFor = (defaultTeacher, map) => {
  const set = new Set();
  if (defaultTeacher) set.add(defaultTeacher);
  Object.values(map || {}).forEach((t) => t && set.add(t));
  return [...set];
};

module.exports = { effectiveTeacher, allTeacherIds, teachesSubject, withDivisionTeacher, idsFor };
