// @ts-nocheck
/**
 * SubjectsPage.jsx — Manage → Subjects & Faculty (head only)
 *
 * One place to create subjects and to assign / change / remove the teacher of
 * each subject (fully manual). Backend: /api/web/head
 *   GET  /context
 *   GET  /subjects?course_id=
 *   GET  /teachers
 *   POST /subjects                 PUT /subjects/:id          DELETE /subjects/:id
 *   PUT  /subjects/:id/assign      { teacher_id | null, force? }
 *   POST /subjects/elective-group  { course_id, semester, group, group_code?, subjects: [{ subject_name, subject_code? }] }
 *   POST /elective-groups/rename   { course_id, semester, from, to }
 *   GET  /subjects/:id/students    POST /subjects/:id/unenroll   POST /subjects/:id/move
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ManageShell from "../../../components/ManageShell";
import { headApi } from "../../../services/headApi";
import "./SubjectsPage.css";

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const semName = (n) => `Semester ${n}`;

// ── Assign / change teacher ──────────────────────────────────────────────────
function AssignModal({ subject, teachers, department, onClose, onDone }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(subject.teacher_assigned || null);
  const [conflicts, setConflicts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const searchRef = useRef(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return teachers
      .filter((t) => !q || t.name.toLowerCase().includes(q) || (t.designation || "").toLowerCase().includes(q))
      .sort((a, b) => Number(b.in_department) - Number(a.in_department) || a.name.localeCompare(b.name));
  }, [teachers, query]);

  const unchanged = picked === subject.teacher_assigned;

  const submit = async (force = false) => {
    if (!picked || saving || unchanged) return;
    setSaving(true);
    setError("");
    try {
      const res = await headApi.put(`/subjects/${subject.subject_id}/assign`, { teacher_id: picked, force: force || undefined });
      onDone(res);
    } catch (err) {
      if (err.status === 409 && err.data?.conflicts?.length) {
        setConflicts(err.data.conflicts);
        setError(err.message);
      } else {
        setConflicts([]);
        setError(err.message);
      }
      setSaving(false);
    }
  };

  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="mg-modal" role="dialog" aria-modal="true" aria-labelledby="sf-assign-title">
        <div className="mg-modal-header">
          <div>
            <h3 className="mg-modal-title" id="sf-assign-title">
              {subject.teacher_assigned ? "Change teacher" : "Assign teacher"}
            </h3>
            <p className="mg-modal-sub">{subject.subject_code} · {subject.subject_name}</p>
          </div>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={saving} aria-label="Close">✕</button>
        </div>

        <div className="mg-modal-body">
          <input
            ref={searchRef}
            className="mg-input"
            placeholder="Search teachers…"
            aria-label="Search teachers"
            value={query}
            disabled={saving}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="sf-teachers" role="listbox" aria-label="Teachers">
            {list.length === 0 && <div className="sf-teachers-empty">No teachers match.</div>}
            {list.map((t) => {
              const on = picked === t.teacher_id;
              return (
                <button
                  type="button"
                  key={t.teacher_id}
                  role="option"
                  aria-selected={on}
                  className={`sf-teacher${on ? " sf-teacher--on" : ""}`}
                  disabled={saving}
                  onClick={() => { setPicked(t.teacher_id); setConflicts([]); setError(""); }}
                >
                  <span className="sf-teacher-avatar">{(t.name[0] || "T").toUpperCase()}</span>
                  <span className="sf-teacher-main">
                    <span className="sf-teacher-name">
                      {t.name}
                      {t.teacher_id === subject.teacher_assigned && <span className="sf-tag sf-tag--cur">Current</span>}
                      {!t.in_department && <span className="sf-tag">Other dept</span>}
                    </span>
                    <span className="sf-teacher-meta">
                      {t.designation ? `${t.designation} · ` : ""}
                      {plural(t.subject_count, "subject")} · {t.weekly_hours} hrs/week
                    </span>
                  </span>
                  <span className="sf-radio" aria-hidden="true" />
                </button>
              );
            })}
          </div>
          {department && <span className="mg-help">Teachers from {department} are listed first. Any approved teacher of the institute can be assigned.</span>}

          {conflicts.length > 0 && (
            <div className="mg-banner mg-banner--warn" role="alert">
              <div className="sf-conflicts">
                <strong>Clashing lectures</strong>
                <ul>
                  {conflicts.map((c, i) => <li key={i}>{c.message}</li>)}
                </ul>
                <span>You can still assign this teacher, but they'll be double-booked.</span>
              </div>
            </div>
          )}
          {error && conflicts.length === 0 && (
            <div className="mg-banner mg-banner--error" role="alert">
              <span className="mg-banner-text">⚠ {error}</span>
            </div>
          )}
        </div>

        <div className="mg-modal-footer">
          <button type="button" className="mg-btn" onClick={onClose} disabled={saving}>Cancel</button>
          {conflicts.length > 0 ? (
            <button type="button" className="mg-btn mg-btn--danger" onClick={() => submit(true)} disabled={saving}>
              {saving ? "Assigning…" : "Assign anyway"}
            </button>
          ) : (
            <button type="button" className="mg-btn mg-btn--primary" onClick={() => submit(false)} disabled={!picked || unchanged || saving}>
              {saving ? "Saving…" : subject.teacher_assigned ? "Change teacher" : "Assign teacher"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Add / edit subject ───────────────────────────────────────────────────────
function SubjectModal({ course, subject, defaultSemester, groups = [], onClose, onSaved }) {
  const editing = !!subject;
  const total = course.total_semesters || 1;
  const [name, setName] = useState(subject?.subject_name || "");
  const [code, setCode] = useState(subject?.subject_code || "");
  const [sem, setSem] = useState(subject?.semester_number || defaultSemester || 1);
  const [compulsory, setCompulsory] = useState(subject ? subject.compulsary : true);
  const [group, setGroup] = useState(subject?.elective_group || "");
  const [enroll, setEnroll] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const firstRef = useRef(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  const valid = name.trim() && code.trim();
  const dirty =
    !editing ||
    name.trim() !== subject.subject_name ||
    code.trim().toUpperCase() !== String(subject.subject_code).toUpperCase() ||
    Number(sem) !== subject.semester_number ||
    compulsory !== subject.compulsary ||
    (!compulsory && group.trim() !== (subject.elective_group || ""));
  const groupNames = [...new Set(groups.filter((g) => g.semester_number === Number(sem)).map((g) => g.group))];

  const submit = async (assignNext) => {
    if (!valid || saving) return;
    if (!dirty) return onClose();
    setSaving(true);
    setError("");
    try {
      let res;
      if (editing) {
        const body = {};
        if (name.trim() !== subject.subject_name) body.subject_name = name.trim();
        if (code.trim().toUpperCase() !== String(subject.subject_code).toUpperCase()) body.subject_code = code.trim();
        if (Number(sem) !== subject.semester_number) body.semester = Number(sem);
        if (compulsory !== subject.compulsary) body.compulsary = compulsory;
        if (!compulsory && group.trim() !== (subject.elective_group || "")) body.elective_group = group.trim();
        res = await headApi.put(`/subjects/${subject.subject_id}`, body);
      } else {
        res = await headApi.post("/subjects", {
          course_id: course.course_id,
          subject_name: name.trim(),
          subject_code: code.trim(),
          semester: Number(sem),
          compulsary: compulsory,
          elective_group: compulsory ? undefined : group.trim(),
          enroll_students: compulsory ? enroll : false,
        });
      }
      onSaved(res, { created: !editing, assignNext, name: name.trim(), semester: Number(sem) });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <form className="mg-modal" role="dialog" aria-modal="true" aria-labelledby="sf-subject-title"
            onSubmit={(e) => { e.preventDefault(); submit(false); }}>
        <div className="mg-modal-header">
          <div>
            <h3 className="mg-modal-title" id="sf-subject-title">{editing ? "Edit subject" : "Add subject"}</h3>
            <p className="mg-modal-sub">{course.course_name || course.abbr}</p>
          </div>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={saving} aria-label="Close">✕</button>
        </div>

        <div className="mg-modal-body">
          <div className="mg-field">
            <label className="mg-label" htmlFor="sf-name">Subject name</label>
            <input id="sf-name" ref={firstRef} className="mg-input" value={name} maxLength={120} disabled={saving}
                   placeholder="e.g. Data Structures" onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="sf-two">
            <div className="mg-field">
              <label className="mg-label" htmlFor="sf-code">Subject code</label>
              <input id="sf-code" className="mg-input" value={code} maxLength={20} disabled={saving}
                     style={{ textTransform: "uppercase" }} placeholder="e.g. MCA101"
                     onChange={(e) => setCode(e.target.value)} />
            </div>
            <div className="mg-field">
              <label className="mg-label" htmlFor="sf-sem">Semester</label>
              <select id="sf-sem" className="mg-input" value={sem} disabled={saving} onChange={(e) => setSem(Number(e.target.value))}>
                {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{semName(n)}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mg-field">
            <span className="mg-label" id="sf-type-label">Type</span>
            <div className="sf-seg" role="radiogroup" aria-labelledby="sf-type-label">
              <button type="button" role="radio" aria-checked={compulsory} disabled={saving}
                      className={`sf-seg-btn${compulsory ? " sf-seg-btn--on" : ""}`} onClick={() => setCompulsory(true)}>
                Compulsory
              </button>
              <button type="button" role="radio" aria-checked={!compulsory} disabled={saving}
                      className={`sf-seg-btn${!compulsory ? " sf-seg-btn--on" : ""}`} onClick={() => setCompulsory(false)}>
                Elective
              </button>
            </div>
            <span className="mg-help">
              {compulsory
                ? "Every student of the semester takes this subject."
                : "Students choose one subject from each elective group themselves."}
            </span>
          </div>

          {!compulsory && (
            <div className="mg-field">
              <label className="mg-label" htmlFor="sf-group">Elective group</label>
              <input id="sf-group" className="mg-input" list="sf-group-list" value={group} maxLength={40} disabled={saving}
                     placeholder="e.g. Elective 1" onChange={(e) => setGroup(e.target.value)} />
              <datalist id="sf-group-list">{groupNames.map((g) => <option key={g} value={g} />)}</datalist>
              <span className="mg-help">
                Subjects with the same group name are the choices of one elective; every student picks exactly one of them.
                To create a whole group at once use “Add elective group”.
              </span>
            </div>
          )}

          {!editing && compulsory && (
            <label className="sf-check">
              <input type="checkbox" checked={enroll} disabled={saving} onChange={(e) => setEnroll(e.target.checked)} />
              <span>Enrol the current students of {semName(sem)} now</span>
            </label>
          )}
          {editing && (Number(sem) !== subject.semester_number || compulsory !== subject.compulsary) && (
            <span className="mg-help">Student enrolment is updated to match this change.</span>
          )}

          {error && (
            <div className="mg-banner mg-banner--error" role="alert">
              <span className="mg-banner-text">⚠ {error}</span>
            </div>
          )}
        </div>

        <div className="mg-modal-footer">
          <button type="button" className="mg-btn" onClick={onClose} disabled={saving}>Cancel</button>
          {!editing && (
            <button type="button" className="mg-btn" onClick={() => submit(true)} disabled={!valid || saving}>
              Save &amp; assign teacher
            </button>
          )}
          <button type="submit" className="mg-btn mg-btn--primary" disabled={!valid || saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add subject"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Add an elective group: n subjects, the student picks one ─────────────────
function ElectiveGroupModal({ course, defaultSemester, groups, onClose, onSaved }) {
  const total = course.total_semesters || 1;
  const [sem, setSem] = useState(defaultSemester || 1);
  const taken = groups.filter((g) => g.semester_number === Number(sem)).map((g) => g.group.toLowerCase());
  const suggest = () => { let i = 1; while (taken.includes(`elective ${i}`)) i++; return `Elective ${i}`; };
  const [group, setGroup] = useState("");
  const [groupCode, setGroupCode] = useState("");
  const [rows, setRows] = useState([{ name: "", code: "" }, { name: "", code: "" }, { name: "", code: "" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const firstRef = useRef(null);
  const groupName = group.trim() || suggest();

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  const setRow = (i, patch) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const filled = rows.filter((r) => r.name.trim());
  const codeFor = (r, i) => r.code.trim() || (groupCode.trim() ? `${groupCode.trim().toUpperCase()}-${i + 1}` : "");
  const missingCode = filled.some((r) => !codeFor(r, rows.indexOf(r)));
  const valid = filled.length >= 2 && !missingCode;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true); setError("");
    try {
      const res = await headApi.post("/subjects/elective-group", {
        course_id: course.course_id, semester: Number(sem), group: groupName, group_code: groupCode.trim() || undefined,
        subjects: filled.map((r) => ({ subject_name: r.name.trim(), subject_code: r.code.trim() || undefined })),
      });
      onSaved({ created: res.subjects.length, group: groupName, semester: Number(sem), notified: res.notified });
    } catch (err) { setError(err.message); setSaving(false); }
  };

  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <form className="mg-modal mg-modal--wide" role="dialog" aria-modal="true" aria-labelledby="sf-eg-title"
            onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="mg-modal-header">
          <div>
            <h3 className="mg-modal-title" id="sf-eg-title">Add elective group</h3>
            <p className="mg-modal-sub">{course.course_name || course.abbr} · students pick ONE of the subjects below</p>
          </div>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={saving} aria-label="Close">✕</button>
        </div>
        <div className="mg-modal-body">
          <div className="sf-two">
            <div className="mg-field">
              <label className="mg-label" htmlFor="sf-eg-sem">Semester</label>
              <select id="sf-eg-sem" className="mg-input" value={sem} disabled={saving} onChange={(e) => setSem(Number(e.target.value))}>
                {Array.from({ length: total }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{semName(n)}</option>)}
              </select>
            </div>
            <div className="mg-field">
              <label className="mg-label" htmlFor="sf-eg-name">Group name</label>
              <input id="sf-eg-name" ref={firstRef} className="mg-input" value={group} maxLength={40} disabled={saving}
                     placeholder={suggest()} onChange={(e) => setGroup(e.target.value)} />
            </div>
          </div>
          <div className="mg-field">
            <label className="mg-label" htmlFor="sf-eg-code">Group code <span className="mg-help">(optional)</span></label>
            <input id="sf-eg-code" className="mg-input" value={groupCode} maxLength={20} disabled={saving}
                   style={{ textTransform: "uppercase" }} placeholder="e.g. PE1 — subjects without their own code become PE1-1, PE1-2 …"
                   onChange={(e) => setGroupCode(e.target.value)} />
          </div>

          <div className="mg-field">
            <span className="mg-label">Subjects to choose from ({filled.length})</span>
            <div className="sf-eg-rows">
              {rows.map((r, i) => (
                <div className="sf-eg-row" key={i}>
                  <span className="sf-eg-n">{i + 1}</span>
                  <input className="mg-input" aria-label={`Subject ${i + 1} name`} value={r.name} maxLength={120} disabled={saving}
                         placeholder="Subject name" onChange={(e) => setRow(i, { name: e.target.value })} />
                  <input className="mg-input sf-eg-code" aria-label={`Subject ${i + 1} code`} value={r.code} maxLength={30} disabled={saving}
                         style={{ textTransform: "uppercase" }} placeholder={groupCode.trim() ? `${groupCode.trim().toUpperCase()}-${i + 1}` : "Code"}
                         onChange={(e) => setRow(i, { code: e.target.value })} />
                  <button type="button" className="sf-link sf-link--danger" disabled={saving || rows.length <= 2}
                          onClick={() => setRows((x) => x.filter((_, k) => k !== i))} aria-label={`Remove subject ${i + 1}`}>Remove</button>
                </div>
              ))}
            </div>
            <div>
              <button type="button" className="mg-btn mg-btn--sm" disabled={saving || rows.length >= 20}
                      onClick={() => setRows((x) => [...x, { name: "", code: "" }])}>+ Add another subject</button>
            </div>
            {missingCode && <span className="sf-stale">Every subject needs a code, or give the group a code above.</span>}
            {!missingCode && filled.length < 2 && <span className="mg-help">Add at least two subjects — otherwise there is nothing to choose.</span>}
          </div>
          <span className="mg-help">
            All subjects share the “{groupName}” group. Each student of {semName(sem)} will be asked in the app to pick exactly one.
          </span>
          {error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {error}</span></div>}
        </div>
        <div className="mg-modal-footer">
          <button type="button" className="mg-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="mg-btn mg-btn--primary" disabled={!valid || saving}>
            {saving ? "Saving…" : `Create ${filled.length || ""} subjects`.replace("  ", " ")}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Rename an elective group ─────────────────────────────────────────────────
function RenameGroupModal({ course, group, onClose, onSaved }) {
  const [name, setName] = useState(group.group);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true); setError("");
    try {
      await headApi.post("/elective-groups/rename", { course_id: course.course_id, semester: group.semester_number, from: group.group, to: name.trim() });
      onSaved(name.trim());
    } catch (err) { setError(err.message); setSaving(false); }
  };
  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <form className="mg-modal" role="dialog" aria-modal="true" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="mg-modal-header">
          <div>
            <h3 className="mg-modal-title">Rename elective group</h3>
            <p className="mg-modal-sub">{semName(group.semester_number)} · {group.group}</p>
          </div>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={saving} aria-label="Close">✕</button>
        </div>
        <div className="mg-modal-body">
          <div className="mg-field">
            <label className="mg-label" htmlFor="sf-rn">New name</label>
            <input id="sf-rn" className="mg-input" autoFocus value={name} maxLength={40} disabled={saving} onChange={(e) => setName(e.target.value)} />
            <span className="mg-help">Students keep the subject they already chose.</span>
          </div>
          {error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {error}</span></div>}
        </div>
        <div className="mg-modal-footer">
          <button type="button" className="mg-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="mg-btn mg-btn--primary" disabled={!name.trim() || name.trim() === group.group || saving}>{saving ? "Saving…" : "Rename"}</button>
        </div>
      </form>
    </div>
  );
}

// ── Students of a subject: move to another option / unenroll so they choose again ──
function StudentsModal({ subject, onClose, onChanged }) {
  const elective = !subject.compulsary;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [tab, setTab] = useState("enrolled");
  const [picked, setPicked] = useState(() => new Set());
  const [q, setQ] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await headApi.get(`/subjects/${subject.subject_id}/students`);
      setData(d); setError("");
      setPicked(new Set());
    } catch (err) { setError(err.message); }
  }, [subject.subject_id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const list = useMemo(() => {
    const src = !data ? [] : tab === "enrolled" ? data.students : data.pending_students || [];
    const needle = q.trim().toLowerCase();
    return needle ? src.filter((s) => [s.name, s.roll_no, s.division].some((x) => String(x || "").toLowerCase().includes(needle))) : src;
  }, [data, tab, q]);

  const options = (data?.siblings || []).filter((x) => x.subject_id !== subject.subject_id);
  const allOn = list.length > 0 && list.every((s) => picked.has(s.student_id));
  const toggle = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const act = async (kind) => {
    if (!picked.size || busy) return;
    setBusy(true); setError(""); setMsg("");
    try {
      const ids = [...picked];
      if (kind === "move") {
        const r = await headApi.post(`/subjects/${subject.subject_id}/move`, { student_ids: ids, to_subject_id: target });
        const to = options.find((o) => o.subject_id === target);
        setMsg(`${plural(r.moved, "student")} moved to ${to ? to.subject_code : "the new subject"}.`);
      } else {
        const r = await headApi.post(`/subjects/${subject.subject_id}/unenroll`, { student_ids: ids });
        setMsg(`${plural(r.unenrolled, "student")} unenrolled. They will be asked to choose again in the app.`);
      }
      setConfirm(false); setTarget("");
      await load();
      onChanged();
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  const count = data ? data.students.length : subject.student_count;
  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mg-modal mg-modal--wide" role="dialog" aria-modal="true" aria-label="Students of subject">
        <div className="mg-modal-header">
          <div>
            <h3 className="mg-modal-title">Students · {subject.subject_code}</h3>
            <p className="mg-modal-sub">{subject.subject_name}{elective && subject.elective_group ? ` · ${subject.elective_group}` : ""} · {plural(count || 0, "student")}</p>
          </div>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>

        <div className="mg-modal-body">
          {elective && data && (
            <div className="sf-opts" aria-label="Students per option of this group">
              {data.siblings.map((o) => (
                <span key={o.subject_id} className={`sf-opt${o.subject_id === subject.subject_id ? " sf-opt--me" : ""}`}>
                  <b>{o.subject_code}</b> {o.subject_name} <em>{o.student_count}</em>
                </span>
              ))}
            </div>
          )}

          {elective && data && (
            <div className="sf-seg" role="tablist" aria-label="Students list">
              <button type="button" role="tab" aria-selected={tab === "enrolled"} className={`sf-seg-btn${tab === "enrolled" ? " sf-seg-btn--on" : ""}`}
                      onClick={() => { setTab("enrolled"); setPicked(new Set()); }}>In this subject ({data.students.length})</button>
              <button type="button" role="tab" aria-selected={tab === "pending"} className={`sf-seg-btn${tab === "pending" ? " sf-seg-btn--on" : ""}`}
                      onClick={() => { setTab("pending"); setPicked(new Set()); }}>Not chosen yet ({(data.pending_students || []).length})</button>
            </div>
          )}

          <input className="mg-input" placeholder="Search name, roll number or division…" aria-label="Search students" value={q} onChange={(e) => setQ(e.target.value)} />

          {!data && !error && <div className="mg-loading">Loading students…</div>}
          {data && (
            <div className="sf-st-wrap">
              <table className="sf-st">
                <thead>
                  <tr>
                    {elective && tab === "enrolled" && (
                      <th className="sf-st-chk"><input type="checkbox" aria-label="Select all" checked={allOn}
                        onChange={() => setPicked(allOn ? new Set() : new Set(list.map((s) => s.student_id)))} /></th>
                    )}
                    <th>Roll</th><th>Name</th><th>Division</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.student_id} className={picked.has(s.student_id) ? "sf-st-on" : ""}>
                      {elective && tab === "enrolled" && (
                        <td className="sf-st-chk"><input type="checkbox" aria-label={`Select ${s.name}`} checked={picked.has(s.student_id)} onChange={() => toggle(s.student_id)} /></td>
                      )}
                      <td>{s.roll_no || "—"}</td><td>{s.name}</td><td>{s.division || "—"}</td>
                    </tr>
                  ))}
                  {!list.length && <tr><td colSpan={4} className="sf-st-empty">{tab === "pending" ? "Everybody has chosen." : "No students."}</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {elective && tab === "enrolled" && picked.size > 0 && (
            <div className="sf-bulk">
              <strong>{plural(picked.size, "student")} selected</strong>
              <div className="sf-bulk-row">
                <select className="mg-input" aria-label="Move to" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Move to another option…</option>
                  {options.map((o) => <option key={o.subject_id} value={o.subject_id}>{o.subject_code} · {o.subject_name} ({o.student_count})</option>)}
                </select>
                <button type="button" className="mg-btn mg-btn--primary" disabled={!target || busy} onClick={() => act("move")}>{busy ? "Working…" : "Move"}</button>
              </div>
              <div className="sf-bulk-row">
                {confirm ? (
                  <>
                    <span className="sf-stale">They leave {subject.subject_code} and must choose their {subject.elective_group || "elective"} again in the app.</span>
                    <button type="button" className="mg-btn" disabled={busy} onClick={() => setConfirm(false)}>Keep</button>
                    <button type="button" className="mg-btn mg-btn--danger" disabled={busy} onClick={() => act("unenroll")}>{busy ? "Working…" : "Yes, unenroll"}</button>
                  </>
                ) : (
                  <button type="button" className="mg-btn mg-btn--danger" disabled={busy} onClick={() => setConfirm(true)}>Unenroll — let them choose again</button>
                )}
              </div>
            </div>
          )}

          {msg && <div className="mg-banner mg-banner--success" role="status"><span className="mg-banner-text">✓ {msg}</span></div>}
          {error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {error}</span></div>}
          {!elective && <span className="mg-help">This is a compulsory subject, so every student of the semester is in it automatically.</span>}
        </div>
        <div className="mg-modal-footer"><button type="button" className="mg-btn" onClick={onClose} disabled={busy}>Close</button></div>
      </div>
    </div>
  );
}

// ── Confirm (remove teacher / delete subject) ────────────────────────────────
function ConfirmModal({ title, body, confirmLabel, busyLabel, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mg-modal" role="alertdialog" aria-modal="true" aria-labelledby="sf-confirm-title">
        <div className="mg-modal-header">
          <h3 className="mg-modal-title" id="sf-confirm-title">{title}</h3>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>
        <div className="mg-modal-body">
          <p className="sf-confirm-text">{body}</p>
          {error && (
            <div className="mg-banner mg-banner--error" role="alert">
              <span className="mg-banner-text">⚠ {error}</span>
            </div>
          )}
        </div>
        <div className="mg-modal-footer">
          <button type="button" className="mg-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="mg-btn mg-btn--danger" onClick={go} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Subject row ──────────────────────────────────────────────────────────────
function SubjectRow({ s, onAssign, onRemove, onEdit, onDelete, onStudents }) {
  return (
    <div className="sf-row" role="listitem">
      <div className="sf-row-main">
        <div className="sf-row-title">
          <span className="sf-code">{s.subject_code}</span>
          <span className="sf-name">{s.subject_name}</span>
        </div>
        <div className="sf-row-tags">
          <span className={`mg-badge ${s.compulsary ? "mg-badge--gray" : "mg-badge--amber"}`}>
            {s.compulsary ? "Compulsory" : `Elective${s.elective_group ? ` · ${s.elective_group}` : ""}`}
          </span>
          <button type="button" className="sf-link" onClick={() => onStudents(s)} aria-label={`Students of ${s.subject_code}`}>
            {plural(s.student_count || 0, "student")}
          </button>
          {s.lecture_count > 0 && <span className="sf-by">{plural(s.lecture_count, "timetable slot")}</span>}
          {s.created_by_role === "head" && <span className="sf-by">Added by you</span>}
        </div>
      </div>

      <div className="sf-row-teacher">
        <div className="sf-row-tline">
          {s.teacher_assigned ? (
            <>
              <span className="sf-teacher-avatar sf-teacher-avatar--sm">{(s.teacher_name[0] || "T").toUpperCase()}</span>
              <span className="sf-row-tname">{s.teacher_name}</span>
            </>
          ) : (
            <span className="mg-badge mg-badge--amber">No teacher</span>
          )}
        </div>
        {!s.teacher_assigned && s.timetable_teacher_name && (
          <span className="sf-stale">Timetable still lists {s.timetable_teacher_name} — assign a teacher to fix it.</span>
        )}
        <div className="sf-row-tactions">
          {s.teacher_assigned ? (
            <>
              <button type="button" className="sf-link" onClick={() => onAssign(s)} aria-label={`Change teacher of ${s.subject_code}`}>Change teacher</button>
              <button type="button" className="sf-link sf-link--danger" onClick={() => onRemove(s)} aria-label={`Remove teacher from ${s.subject_code}`}>Remove</button>
            </>
          ) : (
            <button type="button" className="mg-btn mg-btn--sm mg-btn--primary" onClick={() => onAssign(s)} aria-label={`Assign teacher to ${s.subject_code}`}>Assign teacher</button>
          )}
        </div>
      </div>

      <div className="sf-row-actions">
        {!s.compulsary && (
          <button type="button" className="mg-btn mg-btn--sm" onClick={() => onStudents(s)} aria-label={`Manage students of ${s.subject_code}`}>Students</button>
        )}
        <button type="button" className="mg-btn mg-btn--sm" onClick={() => onEdit(s)} aria-label={`Edit subject ${s.subject_code}`}>Edit subject</button>
        <button type="button" className="mg-btn mg-btn--sm mg-btn--danger" onClick={() => onDelete(s)} aria-label={`Delete subject ${s.subject_code}`}>Delete subject</button>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function SubjectsPage() {
  const [ctx, setCtx] = useState(null);
  const [ctxError, setCtxError] = useState("");
  const [courseId, setCourseId] = useState(null);
  const [subjects, setSubjects] = useState([]);
  const [egroups, setEgroups] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [semFilter, setSemFilter] = useState(0); // 0 = all
  const [query, setQuery] = useState("");
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [modal, setModal] = useState(null); // {type, subject?}
  const seq = useRef(0);

  const loadTeachers = useCallback(async () => {
    try {
      const d = await headApi.get("/teachers");
      setTeachers(d.teachers || []);
    } catch (err) {
      // non-fatal: the assign dialog just shows an empty list with the error banner on the page
      setNotice({ type: "warn", text: `Couldn't load teachers: ${err.message}` });
    }
  }, []);

  const loadContext = useCallback(async () => {
    setLoading(true);
    setCtxError("");
    try {
      const data = await headApi.get("/context");
      setCtx(data);
      setCourseId((cur) => cur || data.courses[0]?.course_id || null);
      if (!data.courses.length) setLoading(false);
    } catch (err) {
      setCtxError(err.message);
      setLoading(false);
    }
  }, []);

  const loadSubjects = useCallback(async (id) => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const d = await headApi.get(`/subjects?course_id=${encodeURIComponent(id)}`);
      if (mine !== seq.current) return null;
      setSubjects(d.subjects || []);
      setEgroups(d.elective_groups || []);
      return d.subjects || [];
    } catch (err) {
      if (mine === seq.current) setError(err.message);
      return null;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { loadContext(); loadTeachers(); }, [loadContext, loadTeachers]);
  useEffect(() => {
    if (!courseId) return;
    setSubjects([]);
    setEgroups([]);
    setSemFilter(0);
    setQuery("");
    setOnlyUnassigned(false);
    loadSubjects(courseId);
  }, [courseId, loadSubjects]);

  useEffect(() => {
    if (!notice || notice.type === "warn") return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const course = ctx?.courses.find((c) => c.course_id === courseId) || null;
  const dept = ctx?.head?.department || "";
  const closeModal = useCallback(() => setModal(null), []);

  // ── actions ──
  const patchSubject = (id, patch) =>
    setSubjects((list) => list.map((s) => (s.subject_id === id ? { ...s, ...patch } : s)));

  const onAssigned = (subject, res) => {
    patchSubject(subject.subject_id, { teacher_assigned: res.teacher_assigned, teacher_name: res.teacher_name || null });
    setModal(null);
    loadTeachers(); // refresh workload numbers
    if (res.unchanged) return setNotice({ type: "success", text: "That teacher is already assigned." });
    const moved = res.moved_lectures ? ` ${plural(res.moved_lectures, "timetable slot")} moved to them.` : "";
    const forced = res.conflicts?.length ? " Note: they have clashing lectures." : "";
    setNotice({
      type: forced ? "warn" : "success",
      text: `${subject.subject_code} is now taught by ${res.teacher_name}.${moved}${forced}`,
    });
  };

  const removeTeacher = (s) =>
    setModal({
      type: "confirm",
      title: "Remove teacher",
      body: `Remove ${s.teacher_name} from ${s.subject_code} · ${s.subject_name}? The subject will show as having no teacher.` +
        (s.lecture_count > 0
          ? ` Its ${plural(s.lecture_count, "timetable slot")} will stay in the timetable but ${s.teacher_name} will no longer see ${s.lecture_count === 1 ? "it" : "them"}. Assign another teacher to give ${s.lecture_count === 1 ? "it" : "them"} an owner again.`
          : ""),
      confirmLabel: "Remove teacher",
      busyLabel: "Removing…",
      run: async () => {
        await headApi.put(`/subjects/${s.subject_id}/assign`, { teacher_id: null });
        patchSubject(s.subject_id, { teacher_assigned: null, teacher_name: null, timetable_teacher_name: null });
        setModal(null);
        loadTeachers();
        setNotice({ type: "success", text: `${s.teacher_name} removed from ${s.subject_code}.` });
      },
    });

  const deleteSubject = (s) =>
    setModal({
      type: "confirm",
      title: "Delete subject",
      body: `Delete ${s.subject_code} · ${s.subject_name}? Students will be un-enrolled from it. This can't be undone.`,
      confirmLabel: "Delete subject",
      busyLabel: "Deleting…",
      run: async () => {
        await headApi.del(`/subjects/${s.subject_id}`);
        setSubjects((list) => list.filter((x) => x.subject_id !== s.subject_id));
        setModal(null);
        loadTeachers();
        setNotice({ type: "success", text: `${s.subject_code} deleted.` });
      },
    });

  const onGroupSaved = async (info) => {
    setModal(null);
    await loadSubjects(courseId);
    setSemFilter((f) => (f && f !== info.semester ? 0 : f));
    setNotice({ type: "success", text: `${info.group} created in ${semName(info.semester)} with ${plural(info.created, "subject")}.${info.notified ? ` ${plural(info.notified, "student")} told to choose.` : ""} Assign a teacher to each one next.` });
  };

  const onSubjectSaved = async (res, info) => {
    setModal(null);
    const list = await loadSubjects(courseId);
    const enr = res.enrolled_students ? ` ${plural(res.enrolled_students, "student")} enrolled.` : "";
    setNotice({ type: "success", text: info.created ? `${info.name} added to ${semName(info.semester)}.${enr}` : `Subject updated.${enr}` });
    if (info.created) setSemFilter((f) => (f && f !== info.semester ? 0 : f));
    if (info.created && info.assignNext && list) {
      const created = list.find((x) => x.subject_id === res.subject_id);
      if (created) setModal({ type: "assign", subject: created });
    }
  };

  // ── derived ──
  const total = course?.total_semesters || 0;
  const unassigned = subjects.filter((s) => !s.teacher_assigned).length;
  const assignedTeachers = new Set(subjects.map((s) => s.teacher_assigned).filter(Boolean)).size;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return subjects.filter((s) =>
      (!semFilter || s.semester_number === semFilter) &&
      (!onlyUnassigned || !s.teacher_assigned) &&
      (!q || s.subject_name.toLowerCase().includes(q) || s.subject_code.toLowerCase().includes(q) ||
        (s.teacher_name || "").toLowerCase().includes(q)));
  }, [subjects, semFilter, query, onlyUnassigned]);

  const groups = useMemo(() => {
    const m = new Map();
    visible.forEach((s) => {
      const k = s.semester_number || 0;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    });
    // compulsory subjects first, then each elective group together
    const order = (s) => (s.compulsary ? "0" : `1|${s.elective_group || ""}`);
    m.forEach((list) => list.sort((a, b) => order(a).localeCompare(order(b), undefined, { numeric: true }) || a.subject_code.localeCompare(b.subject_code)));
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [visible]);

  return (
    <ManageShell
      title="Subjects & Faculty"
      subtitle={`Create subjects for ${dept || "your department"} and choose who teaches each one.`}
      actions={
        course && (
          <>
            <button className="mg-btn" onClick={() => setModal({ type: "egroup" })}>+ Add elective group</button>
            <button className="mg-btn mg-btn--primary" onClick={() => setModal({ type: "subject" })}>+ Add subject</button>
          </>
        )
      }
    >
      {ctxError && (
        <div className="mg-banner mg-banner--error" role="alert">
          <span className="mg-banner-text">⚠ {ctxError}</span>
          <button className="mg-banner-action" onClick={loadContext}>Retry</button>
        </div>
      )}

      {notice && (
        <div className={`mg-banner mg-banner--${notice.type}`} role="status">
          <span className="mg-banner-text">{notice.type === "success" ? "✓ " : ""}{notice.text}</span>
          <button className="mg-banner-action" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {ctx && ctx.courses.length === 0 && (
        <div className="mg-empty">
          <div className="mg-empty-title">No courses found for your department</div>
          No course in this institute is linked to {dept || "your department"}. Ask your institute admin to add one,
          then reload this page.
        </div>
      )}

      {ctx && ctx.courses.length > 1 && (
        <div className="mg-pills" role="tablist" aria-label="Course">
          {ctx.courses.map((c) => (
            <button key={c.course_id} role="tab" aria-selected={c.course_id === courseId}
                    className={`mg-pill${c.course_id === courseId ? " mg-pill--active" : ""}`}
                    onClick={() => setCourseId(c.course_id)}>
              {c.course_name || c.abbr} <span className="mg-pill-code">{c.abbr}</span>
            </button>
          ))}
        </div>
      )}

      {course && (
        <>
          <div className="sf-stats">
            <div className="sf-stat">
              <span className="sf-stat-val">{subjects.length}</span>
              <span className="sf-stat-label">Subjects in {course.abbr}</span>
            </div>
            <div className="sf-stat">
              <span className={`sf-stat-val${unassigned ? " sf-stat-val--warn" : ""}`}>{unassigned}</span>
              <span className="sf-stat-label">Without a teacher</span>
            </div>
            <div className="sf-stat">
              <span className="sf-stat-val">{assignedTeachers}</span>
              <span className="sf-stat-label">Teachers allocated</span>
            </div>
          </div>

          <div className="sf-toolbar">
            <div className="sf-sems" role="tablist" aria-label="Semester">
              {[0, ...Array.from({ length: total }, (_, i) => i + 1)].map((n) => (
                <button key={n} role="tab" aria-selected={semFilter === n}
                        className={`sf-sem${semFilter === n ? " sf-sem--on" : ""}`} onClick={() => setSemFilter(n)}>
                  {n === 0 ? "All" : `Sem ${n}`}
                </button>
              ))}
            </div>
            <input className="mg-input sf-search" placeholder="Search subject, code or teacher…" aria-label="Search subjects"
                   value={query} onChange={(e) => setQuery(e.target.value)} />
            <label className="sf-check sf-check--inline">
              <input type="checkbox" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} />
              <span>Unassigned only</span>
            </label>
          </div>

          {error && (
            <div className="mg-banner mg-banner--error" role="alert">
              <span className="mg-banner-text">⚠ {error}</span>
              <button className="mg-banner-action" onClick={() => loadSubjects(courseId)}>Retry</button>
            </div>
          )}

          {loading && !subjects.length && !error && <div className="mg-loading">Loading subjects…</div>}

          {!loading && !error && subjects.length === 0 && (
            <div className="mg-empty">
              <div className="mg-empty-title">No subjects yet</div>
              Add the first subject of {course.abbr}, then assign a teacher to it.
              <div style={{ marginTop: 14 }}>
                <button className="mg-btn mg-btn--primary" onClick={() => setModal({ type: "subject" })}>+ Add subject</button>
              </div>
            </div>
          )}

          {subjects.length > 0 && visible.length === 0 && (
            <div className="mg-empty">
              <div className="mg-empty-title">Nothing matches</div>
              Try a different search or clear the filters.
            </div>
          )}

          {groups.map(([n, list]) => {
            const un = list.filter((s) => !s.teacher_assigned).length;
            return (
              <section className="sf-group" key={n} aria-label={semName(n)}>
                <div className="sf-group-head">
                  <h3 className="sf-group-title">{semName(n)}</h3>
                  <span className="sf-group-meta">
                    {plural(list.length, "subject")}{un > 0 && <> · <span className="sf-warn">{un} unassigned</span></>}
                  </span>
                </div>
                {egroups.filter((g) => g.semester_number === n).map((g) => {
                  const opts = list.filter((x) => !x.compulsary && (x.elective_group || "Elective") === g.group);
                  const top = Math.max(0, ...opts.map((x) => x.student_count));
                  return (
                    <div className="sf-egroup" key={g.group}>
                      <div className="sf-egroup-head">
                        <strong>{g.group}{g.code ? ` (${g.code})` : ""}</strong>
                        <span className="sf-group-meta">
                          choose 1 of {opts.length || g.subject_ids.length} · {g.chosen} of {g.eligible} students chosen
                          {g.pending > 0 && <> · <span className="sf-warn">{g.pending} yet to choose</span></>}
                        </span>
                        <button type="button" className="sf-link" onClick={() => setModal({ type: "rename", group: g })}>Rename</button>
                      </div>
                      <div className="sf-opts">
                        {opts.map((x) => (
                          <button type="button" key={x.subject_id}
                                  className={`sf-opt sf-opt--btn${opts.length > 1 && top > 0 && x.student_count * 2 < top ? " sf-opt--low" : ""}`}
                                  onClick={() => setModal({ type: "students", subject: x })} title="Open the student list">
                            <b>{x.subject_code}</b> {x.subject_name} <em>{x.student_count}</em>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                <div className="sf-list" role="list">
                  <div className="sf-cols" aria-hidden="true">
                    <span>Subject</span><span>Teacher</span><span>Subject actions</span>
                  </div>
                  {list.map((s) => (
                    <SubjectRow key={s.subject_id} s={s}
                                onAssign={(x) => setModal({ type: "assign", subject: x })}
                                onRemove={removeTeacher}
                                onEdit={(x) => setModal({ type: "subject", subject: x })}
                                onStudents={(x) => setModal({ type: "students", subject: x })}
                                onDelete={deleteSubject} />
                  ))}
                </div>
              </section>
            );
          })}

          {subjects.length > 0 && (
            <p className="sf-footnote">
              Electives: students choose one subject per group in the app. If an option has too few students, open it and move them to another option,
              or unenroll them so they choose again. Changing a subject's teacher also moves its timetable slots to the new teacher; removing the teacher leaves the slots without
              one. A subject can't be deleted or moved to another semester while it still has timetable slots — clear those on the Timetable page first.
            </p>
          )}
        </>
      )}

      {!ctx && loading && !ctxError && <div className="mg-loading">Loading…</div>}

      {modal?.type === "assign" && (
        <AssignModal subject={modal.subject} teachers={teachers} department={dept}
                     onClose={closeModal} onDone={(res) => onAssigned(modal.subject, res)} />
      )}
      {modal?.type === "subject" && course && (
        <SubjectModal course={course} subject={modal.subject} defaultSemester={semFilter || 1} groups={egroups}
                      onClose={closeModal} onSaved={onSubjectSaved} />
      )}
      {modal?.type === "egroup" && course && (
        <ElectiveGroupModal course={course} defaultSemester={semFilter || 1} groups={egroups} onClose={closeModal} onSaved={onGroupSaved} />
      )}
      {modal?.type === "rename" && course && (
        <RenameGroupModal course={course} group={modal.group} onClose={closeModal}
                          onSaved={async (name) => { setModal(null); await loadSubjects(courseId); setNotice({ type: "success", text: `Group renamed to ${name}.` }); }} />
      )}
      {modal?.type === "students" && (
        <StudentsModal subject={modal.subject} onClose={closeModal} onChanged={() => loadSubjects(courseId)} />
      )}
      {modal?.type === "confirm" && (
        <ConfirmModal title={modal.title} body={modal.body} confirmLabel={modal.confirmLabel}
                      busyLabel={modal.busyLabel} onConfirm={modal.run} onClose={closeModal} />
      )}
    </ManageShell>
  );
}