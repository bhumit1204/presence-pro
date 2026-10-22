// Run from your backend folder:  node patch_division_teachers.js
// Makes the "does this teacher teach this subject" checks understand a teacher per division.
// Safe to run twice. Keeps your line endings.
const fs = require("fs");
const OWN = (x) => `(${x}.teacher_assigned === teacher_id || (Array.isArray(${x}.teacher_ids) && ${x}.teacher_ids.includes(teacher_id)))`;
const TWO_QUERIES = (v) => `const ${v}s = await Promise.all([db.collection("subjects").where("teacher_assigned", "==", teacher_id).get(), db.collection("subjects").where("teacher_ids", "array-contains", teacher_id).get()]); const ${v} = { empty: ${v}s.every((x) => x.empty), docs: [...new Map(${v}s.flatMap((x) => x.docs).map((d) => [d.id, d])).values()] };`;
const edits = {
  "utils/ownership.js": [[`(subj.teacher_assigned === teacher_id || subj.teacher_id === teacher_id)`, `(subj.teacher_assigned === teacher_id || subj.teacher_id === teacher_id || (Array.isArray(subj.teacher_ids) && subj.teacher_ids.includes(teacher_id)))`]],
  "routes/broadcast.routes.js": [[`(subjectData.teacher_assigned === teacher_id || subjectData.teacher_id === teacher_id)`, `(subjectData.teacher_assigned === teacher_id || subjectData.teacher_id === teacher_id || (Array.isArray(subjectData.teacher_ids) && subjectData.teacher_ids.includes(teacher_id)))`]],
  "routes/web/student.routes.js": [
    [`subjects.map((s) => s.teacher_assigned || s.teacher_id || s.created_by).filter(isId)`, `subjects.map((s) => (s.division_teachers && student.division_id && s.division_teachers[student.division_id]) || s.teacher_assigned || s.teacher_id || s.created_by).filter(isId)`],
    [`const teacher_id = s.teacher_assigned || s.teacher_id || s.created_by || null;`, `const teacher_id = (s.division_teachers && student.division_id && s.division_teachers[student.division_id]) || s.teacher_assigned || s.teacher_id || s.created_by || null;`],
  ],
  "routes/web/teacher.routes.js": [
    [`const snap = await db.collection("subjects").where("teacher_assigned", "==", teacher_id).get();`, TWO_QUERIES("snap")],
    [`if (subjData.teacher_assigned !== teacher_id)`, `if (!${OWN("subjData")})`],
  ],
  "routes/od.routes.js": [[`!!subj && subj.teacher_assigned === teacher_id`, `!!subj && ${OWN("subj")}`]],
  "routes/reports.routes.js": [[`return !!s && s.teacher_assigned === teacher_id;`, `return !!s && ${OWN("s")};`]],
  "routes/lecture.routes.js": [[`const snap = await db.collection("subjects").where("teacher_assigned", "==", teacher_id).get();`, TWO_QUERIES("snap")]],
  "routes/quiz.routes.js": [[`if (subjectData.teacher_assigned !== teacher_id) {`, `if (!${OWN("subjectData")}) {`, 2]],
};
let bad = 0;
for (const [file, list] of Object.entries(edits)) {
  if (!fs.existsSync(file)) { console.log("MISSING", file); bad++; continue; }
  let s = fs.readFileSync(file, "utf8");
  let changed = false;
  for (const [a, b, times = 1] of list) {
    const n = s.split(a).length - 1;
    if (n === times) { s = s.split(a).join(b); changed = true; }
    else if (s.includes(b)) { /* already patched */ }
    else { console.log("NOT FOUND", file, "->", a.slice(0, 60), `(found ${n}, expected ${times})`); bad++; }
  }
  if (changed) { fs.writeFileSync(file, s); console.log("patched", file); }
}
console.log(bad ? `${bad} problem(s) - send me the lines above` : "done");
