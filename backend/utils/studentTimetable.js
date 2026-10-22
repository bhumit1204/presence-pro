/**
 * utils/studentTimetable.js
 *
 * What a STUDENT sees as "my timetable": the weekly timetable of their course and semester, narrowed to
 *   - their division (a lecture without a division is common to all),
 *   - their lab batch (decided by roll number, see utils/batches.js),
 *   - the electives they chose (compulsory subjects are always shown),
 * plus the one-day changes (changed room / time / teacher, cancelled, special sessions) of the next days
 * that concern them.
 *
 * Pure functions: the route loads the documents, these decide.
 */
const { inBatch, rollOf } = require("./batches");

const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const KIND_LABEL = { lab: "Lab", tutorial: "Tutorial" };
const ACTIVE = ["scheduled", "applied"];

function parseSem(v) {
  if (v === null || v === undefined || v === "") return null;
  const m = String(v).match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 20 ? n : null;
}

const toMin = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };

function weekdayOf(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** does a lecture of this semester belong to a student of `student.semester`? (unknown on either side = yes) */
function semesterMatches(lecture, student) {
  const a = parseSem(lecture && lecture.semester), b = parseSem(student && student.semester);
  return a === null || b === null || a === b;
}

/** the weekly timetable without today's temporary changes (overrides that were already applied to the lectures are undone) */
function undoApplied(lectures, overrides) {
  let out = lectures.map((l) => ({ ...l }));
  overrides.filter((o) => o.status === "applied").forEach((o) => {
    if (o.kind === "modify") {
      const l = out.find((x) => x.lecture_id === o.lecture_id);
      if (l) Object.keys(o.original || {}).forEach((k) => { if (o.original[k] === null) delete l[k]; else l[k] = o.original[k]; });
    } else {
      out = out.filter((x) => x.lecture_id !== `sp_${o.override_id}`);
      Object.keys(o.snapshots || {}).forEach((id) => {
        if (!out.some((x) => x.lecture_id === id)) out.push({ ...o.snapshots[id], lecture_id: id });
      });
    }
  });
  return out;
}

function view(l, subj, teacherNames) {
  const s = subj || {};
  return {
    lecture_id: l.lecture_id,
    subject_id: l.subject_id || null,
    subject_name: l.subject_name || s.subject_name || "",
    subject_code: l.subject_code || s.subject_code || "",
    kind: l.kind || (s.kind === "lab" ? "lab" : ""),
    kind_label: KIND_LABEL[l.kind || (s.kind === "lab" ? "lab" : "")] || "",
    batch: l.batch_no ? (l.batch || `B${l.batch_no}`) : "",
    teacher_name: l.teacher_name || teacherNames[l.teacher_id] || "",
    division_name: l.division_name || "",
    elective: s.compulsary === false,
    elective_group: s.compulsary === false ? (l.elective_group || s.elective_group || "") : "",
    day: l.day,
    start_time: l.start_time,
    end_time: l.end_time,
    room: l.room || "",
  };
}

/**
 * @param student     the student document (semester, division_id, enrolled_subjects, roll_no ...)
 * @param lectures    every lecture document of the student's course ({lecture_id, ...})
 * @param subjects    every subject of the course ({subject_id, semester, compulsary, kind, ...})
 * @param overrides   timetable_overrides of the course ({override_id, status, kind, date, ...})
 * @param teacherNames  { teacher_id: name }
 * @param today       "YYYY-MM-DD"
 */
function buildStudentTimetable({ student, lectures, subjects, overrides, teacherNames = {}, today, changeDays = 14 }) {
  const sem = parseSem(student.semester);
  const roll = rollOf(student);
  const division = student.division_id || null;
  const enrolled = new Set(Array.isArray(student.enrolled_subjects) ? student.enrolled_subjects : []);
  const subjectsById = Object.fromEntries(subjects.map((s) => [s.subject_id, s]));
  const semSubjects = new Set(subjects.filter((s) => parseSem(s.semester) === sem).map((s) => s.subject_id));

  const ovs = overrides.filter((o) => ACTIVE.includes(o.status));
  const inMySemester = (l) => (parseSem(l.semester) !== null && sem !== null ? parseSem(l.semester) === sem : sem === null || semSubjects.has(l.subject_id));
  const takes = (l) => {
    const s = subjectsById[l.subject_id];
    return !s || s.compulsary !== false || enrolled.has(l.subject_id);        // an elective only if the student chose it
  };
  const mine = (l) => inMySemester(l) && (!l.division_id || l.division_id === division) && inBatch(l, roll) && takes(l);

  const base = undoApplied(lectures, ovs).filter(mine)
    .sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || toMin(a.start_time) - toMin(b.start_time));
  const byId = Object.fromEntries(base.map((l) => [l.lecture_id, l]));

  const days = {};
  DAY_ORDER.forEach((d) => { days[d] = []; });
  const list = base.map((l) => view(l, subjectsById[l.subject_id], teacherNames));
  list.forEach((l) => { if (days[l.day]) days[l.day].push(l); });

  // one-day changes of the next days that concern this student
  const until = addDays(today, changeDays);
  const changes = [];
  ovs.filter((o) => o.date >= today && o.date <= until).forEach((o) => {
    const out = { date: o.date, weekday: weekdayOf(o.date), kind: o.kind, note: o.note || "" };
    if (o.kind === "special") {
      const sp = o.special || {};
      if (o.semester != null && sem !== null && o.semester !== sem) return;
      if (sp.division_id && sp.division_id !== division) return;
      const s = subjectsById[sp.subject_id];
      if (s && s.compulsary === false && !enrolled.has(sp.subject_id)) return;
      changes.push({ ...out, subject_name: sp.subject_name || "", subject_code: sp.subject_code || "", start_time: sp.start_time, end_time: sp.end_time, room: sp.room || "", teacher_name: sp.teacher_name || teacherNames[sp.teacher_id] || "",
        replaces: (o.replaces || []).map((id) => byId[id]).filter(Boolean).map((l) => l.subject_name) });
      return;
    }
    const l = byId[o.lecture_id];
    if (!l) return;                                                          // not this student's lecture
    const c = o.changes || {};
    changes.push({ ...out, subject_name: l.subject_name || "", subject_code: l.subject_code || "",
      kind_label: KIND_LABEL[l.kind] || "", batch: l.batch_no ? (l.batch || `B${l.batch_no}`) : "",
      start_time: c.start_time || l.start_time, end_time: c.end_time || l.end_time,
      room: c.room !== undefined ? c.room : (l.room || ""),
      teacher_name: c.teacher_name || l.teacher_name || teacherNames[l.teacher_id] || "",
      was: o.kind === "modify" ? { start_time: l.start_time, end_time: l.end_time, room: l.room || "", teacher_name: l.teacher_name || teacherNames[l.teacher_id] || "" } : undefined });
  });
  changes.sort((a, b) => a.date.localeCompare(b.date) || toMin(a.start_time) - toMin(b.start_time));

  return { days, lectures: list, changes };
}

module.exports = { buildStudentTimetable, semesterMatches, parseSem, weekdayOf, addDays, DAY_ORDER };
