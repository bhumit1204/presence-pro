// @ts-nocheck
/**
 * AssignmentsPage.jsx — Teacher assignments management
 *
 * Three views:
 *  1. List  — all assignments per subject, stats per assignment
 *  2. Detail — one assignment: submissions register, grade single/bulk, return toggle
 *  3. Create — new assignment with file upload to R2 via /api/assignments/upload
 *
 * API used (existing backend):
 *  GET    /api/assignments?subject_id=&course_id=&teacher_id=   (teacher also gets drafts + scheduled)
 *  POST   /api/assignments                         { status: published|draft|scheduled, kind, publish_at, teacher_id, course_id, subject_id, title, instructions, questions, marks, due_date, allow_late, attachments, links }
 *  PUT    /api/assignments/:id                     { teacher_id, ...fields, deleted_keys }
 *  DELETE /api/assignments/:id?teacher_id=
 *  GET    /api/assignments/:id/submissions?teacher_id=
 *  GET    /api/assignments/:id/students?teacher_id=   (added to web route)
 *  POST   /api/assignments/grade/:submission_id    { teacher_id, marks_obtained, feedback, returned }
 *  PUT    /api/assignments/grade/:submission_id    { teacher_id, marks_obtained, feedback, returned }
 *  POST   /api/assignments/upload                  multipart: files[], folder="assignments"
 *  POST   /api/web/teacher/assignments/return-all  { teacher_id, assignment_id, returned }
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { getUserSession } from "../../services/session";
import AppSidebar from "../../components/AppSidebar";
import "./AssignmentsPage.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// ── API helpers ───────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res  = await fetch(`${API}${path}`, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
const get  = (path) => apiFetch(path);
const del  = (path) => apiFetch(path, { method: "DELETE" });
const post = (path, body) => apiFetch(path, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const put  = (path, body) => apiFetch(path, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ── Helpers ───────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
function fmtShort(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}
function isOverdue(iso) { return iso && new Date(iso) < new Date(); }

function Toggle({ on, onChange, label, sub, color = "#10B981" }) {
  return (
    <div className="ap-toggle-row">
      <div className="ap-toggle-info">
        <span className="ap-toggle-label">{label}</span>
        {sub && <span className="ap-toggle-sub">{sub}</span>}
      </div>
      <button
        className={`ap-toggle-btn${on ? " ap-toggle-btn--on" : ""}`}
        style={on ? { background: color } : {}}
        onClick={() => onChange(!on)}
      >
        <span className={`ap-toggle-knob${on ? " ap-toggle-knob--on" : ""}`} />
      </button>
    </div>
  );
}

function FileIcon({ type }) {
  if (!type) return "📄";
  if (type.includes("pdf"))   return "📕";
  if (type.includes("image")) return "🖼️";
  if (type.includes("sheet") || type.includes("excel")) return "📊";
  if (type.includes("word") || type.includes("document")) return "📝";
  if (type.includes("presentation") || type.includes("powerpoint")) return "📑";
  return "📎";
}

const KINDS = [
  { key: "assignment",    label: "Lecture work",  short: "Lecture",  noun: "Assignment" },
  { key: "lab_work",      label: "Lab work",      short: "Lab",      noun: "Lab Work" },
  { key: "tutorial_work", label: "Tutorial work", short: "Tutorial", noun: "Tutorial Work" },
];
const kindOf = (a) => (KINDS.some((k) => k.key === a?.kind) ? a.kind : "assignment");
const kindMeta = (a) => KINDS.find((k) => k.key === kindOf(a));
const KIND_CHIP = { assignment: "", lab_work: " ap-info-chip--green", tutorial_work: " ap-info-chip--purple" };
// a teacher's list includes drafts and scheduled posts; `state` comes from the server
const stateOf = (a) => a?.state || a?.status || "published";
const isLabWork = (a) => kindOf(a) === "lab_work";

// which kinds a subject can have (a lab subject is lab-only work; others need the flag)
function kindAllowed(subject) {
  if (!subject) return { assignment: true, lab_work: true, tutorial_work: true };
  const slim = subject.has_lab === undefined && subject.has_tutorial === undefined && subject.kind === undefined;
  if (slim) return { assignment: true, lab_work: true, tutorial_work: true };
  return {
    assignment: true,
    lab_work: !!subject.has_lab || subject.kind === "lab",
    tutorial_work: !!subject.has_tutorial,
  };
}

// <input type="datetime-local"> works in local time without a zone
const pad2 = (n) => String(n).padStart(2, "0");
function toLocalInput(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}T${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
}
function nextFullHour() {
  const d = new Date(Date.now() + 3600e3);
  d.setMinutes(0, 0, 0);
  return toLocalInput(d);
}

function StatusBadge({ sub }) {
  if (!sub)                    return <span className="ap-badge ap-badge--missing">Not submitted</span>;
  if (sub.status === "graded") return <span className="ap-badge ap-badge--graded">Graded</span>;
  if (sub.status === "late")   return <span className="ap-badge ap-badge--late">Late</span>;
  return                              <span className="ap-badge ap-badge--submitted">Submitted</span>;
}


// ── Tags (topics) of a subject: "CA Assignment", "Syllabus", ... ─────────────
function useTags(subject) {
  const [tags, setTags] = useState([]);
  const sid = subject?.subject_id, cid = subject?.course_id;
  const reload = useCallback(async () => {
    if (!sid || !cid) { setTags([]); return []; }
    try {
      const r = await get(`/api/assignments/tags?subject_id=${encodeURIComponent(sid)}&course_id=${encodeURIComponent(cid)}`);
      setTags(r.tags || []);
      return r.tags || [];
    } catch { return []; }
  }, [sid, cid]);
  useEffect(() => { reload(); }, [reload]);
  return { tags, reload };
}
const tagNameOf = (tags, id) => (id ? tags.find((t) => t.tag_id === id)?.name || null : null);

function TagPicker({ subject, teacherId, value, onChange, disabled }) {
  const { tags, reload } = useTags(subject);
  const [adding, setAdding] = useState(false);
  const [name, setName]     = useState("");
  const [busy, setBusy]     = useState(false);
  const [manage, setManage] = useState(false);
  const [err, setErr]       = useState("");

  const add = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await post("/api/assignments/tags", { teacher_id: teacherId, subject_id: subject.subject_id, course_id: subject.course_id, name: n });
      await reload(); onChange(r.tag.tag_id); setName(""); setAdding(false);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const rename = async (t) => {
    const n = window.prompt("Rename tag", t.name);
    if (n == null || !n.trim() || n.trim() === t.name) return;
    try { await put(`/api/assignments/tags/${t.tag_id}`, { teacher_id: teacherId, name: n.trim() }); await reload(); } catch (e) { setErr(e.message); }
  };
  const remove = async (t) => {
    if (!window.confirm(`Delete the tag "${t.name}"? Work with this tag stays, it just loses the tag.`)) return;
    try {
      await del(`/api/assignments/tags/${t.tag_id}?teacher_id=${encodeURIComponent(teacherId)}`);
      const fresh = await reload();
      if (value && !fresh.some((x) => x.tag_id === value)) onChange(null);
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="ap-card">
      <label className="ap-label">
        Tag <span className="ap-optional">(optional)</span>
        {tags.length > 0 && <button type="button" className="ap-back-btn" style={{ float: "right" }} onClick={() => setManage((v) => !v)}>{manage ? "Done" : "Manage"}</button>}
      </label>
      <div className="ap-subject-pills">
        <button type="button" disabled={disabled} className={`ap-pill${value == null ? " ap-pill--active" : ""}`} onClick={() => onChange(null)}>No tag</button>
        {tags.map((t) => (
          <span key={t.tag_id} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <button type="button" disabled={disabled} className={`ap-pill${value === t.tag_id ? " ap-pill--active" : ""}`} onClick={() => onChange(t.tag_id)}>🏷 {t.name}</button>
            {manage && <>
              <button type="button" onClick={() => rename(t)} title={`Rename ${t.name}`} aria-label={`Rename ${t.name}`}
                style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid #E5E7EB", background: "#fff", color: "#4834D4", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>✎</button>
              <button type="button" onClick={() => remove(t)} title={`Delete ${t.name}`} aria-label={`Delete ${t.name}`}
                style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
            </>}
          </span>
        ))}
        <button type="button" disabled={disabled} className={`ap-pill${adding ? " ap-pill--active" : ""}`} onClick={() => setAdding((v) => !v)}>+ New tag</button>
      </div>
      {adding && (
        <div className="ap-link-row" style={{ marginTop: 10 }}>
          <input className="ap-input ap-link-input" placeholder="e.g. CA Assignment, Syllabus" maxLength={40}
            value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <button type="button" className="ap-link-add" disabled={busy || !name.trim()} onClick={add}>Add</button>
        </div>
      )}
      {err && <div className="ap-error" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// CREATE / EDIT PANEL
// ════════════════════════════════════════════════════════════════════
function AssignmentForm({ subjects, teacherId, editAssignment, onDone, onCancel }) {
  const isEdit = !!editAssignment;
  const editState = editAssignment ? stateOf(editAssignment) : "new";
  const isDraft = editState === "draft";
  const isScheduledEdit = editState === "scheduled";
  const isPostedEdit = isEdit && !isDraft && !isScheduledEdit;

  const [activeSubj,    setActiveSubj]    = useState(editAssignment ? null : (subjects[0] || null));
  const [title,         setTitle]         = useState(editAssignment?.title         || "");
  const [instructions,  setInstructions]  = useState(editAssignment?.instructions  || "");
  const [questions,     setQuestions]     = useState(editAssignment?.questions     || "");
  const [marks,         setMarks]         = useState(editAssignment ? String(editAssignment.marks) : "");
  const [dueDate,       setDueDate]       = useState(
    editAssignment?.due_date ? editAssignment.due_date.slice(0, 16) : ""
  );
  const [allowLate,     setAllowLate]     = useState(editAssignment?.allow_late ?? false);
  const [tagId,         setTagId]         = useState(editAssignment?.tag_id ?? null);
  const [kind,          setKind]          = useState(kindOf(editAssignment));   // assignment | lab_work | tutorial_work
  const [scheduleOn,    setScheduleOn]    = useState(isScheduledEdit || (isDraft && !!editAssignment?.publish_at && new Date(editAssignment.publish_at) > new Date()));
  const [publishAt,     setPublishAt]     = useState(
    editAssignment?.publish_at && new Date(editAssignment.publish_at) > new Date() ? toLocalInput(editAssignment.publish_at) : nextFullHour()
  );
  const [saveState,     setSaveState]     = useState(isDraft ? "saved" : "idle");   // idle | saving | saved | failed
  const [savedAt,       setSavedAt]       = useState(isDraft && editAssignment?.updated_at ? new Date(editAssignment.updated_at) : null);

  // Files: existing (already uploaded) + new (picked by user)
  const [existingFiles, setExistingFiles] = useState(editAssignment?.attachments || []);
  const [newFiles,      setNewFiles]      = useState([]); // { file: File, name, size, type }
  const [links,         setLinks]         = useState(editAssignment?.links || []);
  const [linkInput,     setLinkInput]     = useState("");

  const [saving,     setSaving]     = useState(false);
  const [uploading,  setUploading]  = useState(false);
  const [error,      setError]      = useState("");
  const fileRef = useRef();
  const draftId   = useRef(isDraft ? editAssignment.assignment_id : null);
  const savedSig  = useRef("");
  const uploaded  = useRef(new Map());     // File -> stored attachment
  const removed   = useRef([]);            // stored files taken out again
  const queue     = useRef(Promise.resolve());
  const closing   = useRef(false);
  const autosave  = !isEdit || isDraft;    // posted and scheduled items are edited with an explicit Save

  // For edit, resolve the subject from the assignment
  useEffect(() => {
    if (isEdit && editAssignment && subjects.length) {
      const s = subjects.find((s) => s.subject_id === editAssignment.subject_id);
      if (s) setActiveSubj(s);
    }
  }, []);

  const pickFiles = () => fileRef.current?.click();

  const onFilePick = (e) => {
    const picked = Array.from(e.target.files || []);
    setNewFiles((prev) => [...prev, ...picked.map((f) => ({ file: f, name: f.name, size: f.size, type: f.type }))]);
    e.target.value = "";
  };

  const addLink = () => {
    const trimmed = linkInput.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      setError("Link must start with http:// or https://"); return;
    }
    setLinks((prev) => [...prev, { url: trimmed, label: trimmed }]);
    setLinkInput("");
    setError("");
  };

  const allowed = kindAllowed(activeSubj);
  // a kind the subject cannot have falls back to lecture work (an existing item keeps its own kind)
  const effectiveKind = allowed[kind] || kind === kindOf(editAssignment) ? kind : "assignment";
  const kindMetaNow = KINDS.find((k) => k.key === effectiveKind);

  const marksOk = !!marks && !isNaN(Number(marks)) && Number(marks) >= 1 && Number(marks) <= 1000;
  const hasContent = !!(title.trim() || marks || instructions.trim() || questions.trim() || newFiles.length || existingFiles.length || links.length);
  const sig = JSON.stringify([
    activeSubj?.subject_id || editAssignment?.subject_id, effectiveKind, tagId, title.trim(), marksOk ? Number(marks) : null, dueDate, instructions.trim(), questions.trim(), allowLate,
    scheduleOn ? publishAt : null, existingFiles.map((f) => f.key || f.url), newFiles.map((f) => f.name + f.size), links.map((l) => l.url),
  ]);
  const sigRef = useRef(sig); sigRef.current = sig;
  if (isDraft && savedSig.current === "") savedSig.current = sig;   // an opened draft starts out saved

  const validate = () => {
    if (!activeSubj)            { setError("Select a subject"); return false; }
    if (!title.trim())          { setError("Title is required"); return false; }
    if (!marks || isNaN(Number(marks)) || Number(marks) < 1) { setError("Marks must be a positive number"); return false; }
    if (!dueDate)               { setError("Due date is required"); return false; }
    if (!instructions.trim() && !questions.trim()) { setError("At least instructions or questions required"); return false; }
    if (!allowed[effectiveKind] && !(isEdit && effectiveKind === kindOf(editAssignment))) {
      setError(effectiveKind === "lab_work" ? "This subject has no lab" : "This subject has no tutorial"); return false;
    }
    if (scheduleOn && !isPostedEdit) {
      if (!publishAt || new Date(publishAt) <= new Date()) { setError("Choose a posting time in the future"); return false; }
      if (new Date(dueDate) <= new Date(publishAt)) { setError("The due date must be after the posting time"); return false; }
    }
    if (!scheduleOn && new Date(dueDate) <= new Date() && !isPostedEdit) { setError("The due date must be in the future"); return false; }
    return true;
  };

  // Upload picked files that are not stored yet; returns every attachment of the form.
  const collectAttachments = async () => {
    for (const [f, att] of [...uploaded.current.entries()]) {
      if (!newFiles.some((n) => n.file === f)) {            // picked, uploaded, then removed again
        if (att?.key) removed.current.push(att.key);
        uploaded.current.delete(f);
      }
    }
    const fresh = newFiles.filter((n) => !uploaded.current.has(n.file));
    if (fresh.length) {
      setUploading(true);
      try {
        const fd = new FormData();
        fd.append("folder", "assignments");
        if (draftId.current || isEdit) fd.append("entity_id", draftId.current || editAssignment.assignment_id);
        fresh.forEach((f) => fd.append("files", f.file, f.name));
        const data = await apiFetch("/api/assignments/upload", { method: "POST", body: fd });
        if (!data.success) throw new Error(data.error);
        fresh.forEach((f, i) => { if (data.files?.[i]) uploaded.current.set(f.file, data.files[i]); });
      } finally { setUploading(false); }
    }
    return [...existingFiles, ...newFiles.map((n) => uploaded.current.get(n.file)).filter(Boolean)];
  };

  const baseBody = (attachments) => ({
    teacher_id: teacherId,
    kind:       effectiveKind,
    tag_id:     tagId,
    title:      title.trim(),
    instructions: instructions.trim() || null,
    questions:    questions.trim()    || null,
    allow_late: allowLate,
    attachments,
    links,
  });

  // Save the work in progress as a draft (runs one after another, never two at once).
  const saveDraft = () => {
    const run = async () => {
      if (!autosave || !activeSubj) return;
      if (draftId.current && sigRef.current === savedSig.current) return;
      if (!hasContent) return;
      setSaveState("saving");
      try {
        const attachments = await collectAttachments();
        const body = {
          ...baseBody(attachments),
          status: "draft",
          marks: marksOk ? Number(marks) : null,
          due_date: dueDate ? new Date(dueDate).toISOString() : null,
          publish_at: scheduleOn && publishAt ? new Date(publishAt).toISOString() : null,
        };
        if (!draftId.current) {
          const r = await post("/api/assignments", { ...body, course_id: activeSubj.course_id, subject_id: activeSubj.subject_id });
          draftId.current = r.assignment_id;
        } else {
          await put(`/api/assignments/${draftId.current}`, { ...body, deleted_keys: removed.current });
        }
        removed.current = [];
        savedSig.current = sigRef.current;
        setSavedAt(new Date());
        setSaveState("saved");
      } catch (e) { setSaveState("failed"); throw e; }
    };
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => {});
    return next;
  };
  const saveRef = useRef(saveDraft); saveRef.current = saveDraft;

  // autosave a moment after the last change
  useEffect(() => {
    if (!autosave || closing.current || saving || !hasContent) return;
    if (draftId.current && sig === savedSig.current) return;
    const t = setTimeout(() => { saveRef.current().catch(() => {}); }, 1500);
    return () => clearTimeout(t);
  }, [sig, saving]);

  // closing the tab with unsaved changes: warn (the save above normally has already happened)
  useEffect(() => {
    if (!autosave) return;
    const h = (e) => {
      if (closing.current || !hasContent) return;
      if (draftId.current && sigRef.current === savedSig.current) return;
      e.preventDefault(); e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [autosave, hasContent]);

  const goBack = async () => {
    if (autosave && hasContent && !(draftId.current && sig === savedSig.current)) {
      try { await saveRef.current(); }
      catch (e) { if (!window.confirm("The draft could not be saved. Leave anyway and lose what you typed?")) return; }
    }
    closing.current = true;
    onCancel();
  };

  const discardDraft = async () => {
    if (!window.confirm("Delete this draft?")) return;
    closing.current = true;
    try {
      await queue.current;
      if (draftId.current) await del(`/api/assignments/${draftId.current}?teacher_id=${encodeURIComponent(teacherId)}`);
    } catch (e) { setError(e.message); closing.current = false; return; }
    onDone();
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSaving(true); setError("");
    try {
      await queue.current;
      const attachments = await collectAttachments();
      const body = {
        ...baseBody(attachments),
        marks:    Number(marks),
        due_date: new Date(dueDate).toISOString(),
      };
      if (isPostedEdit) {
        await put(`/api/assignments/${editAssignment.assignment_id}`, { ...body, deleted_keys: removed.current });
      } else {
        const status = scheduleOn ? "scheduled" : "published";
        const full = { ...body, status, publish_at: scheduleOn ? new Date(publishAt).toISOString() : null };
        if (draftId.current || isScheduledEdit) {
          await put(`/api/assignments/${draftId.current || editAssignment.assignment_id}`, { ...full, deleted_keys: removed.current });
        } else {
          await post("/api/assignments", { ...full, course_id: activeSubj.course_id, subject_id: activeSubj.subject_id });
        }
      }
      closing.current = true;
      onDone();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="ap-form-wrap">
      <div className="ap-form-header">
        <button className="ap-back-btn" onClick={goBack}>← Back</button>
        <h2 className="ap-form-title">
          {isDraft ? "Edit Draft" : isEdit ? `Edit ${kindMetaNow.noun}` : `New ${kindMetaNow.noun}`}
        </h2>
        {autosave && (
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: saveState === "failed" ? "#B91C1C" : "#6B7280" }}>
            {saveState === "saving" ? "Saving draft…"
              : saveState === "failed" ? "Could not save the draft. It retries when you change something."
              : saveState === "saved" && savedAt ? `Draft saved ${savedAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`
              : hasContent ? "Saves as a draft while you type" : ""}
          </span>
        )}
      </div>

      {error && <div className="ap-error">{error}</div>}

      {/* Subject selector — hidden in edit mode */}
      {!isEdit && subjects.length > 1 && (
        <div className="ap-card">
          <label className="ap-label">Subject *</label>
          <div className="ap-subject-pills">
            {subjects.map((s) => (
              <button key={s.subject_id}
                className={`ap-pill${activeSubj?.subject_id === s.subject_id ? " ap-pill--active" : ""}`}
                onClick={() => setActiveSubj(s)}>
                {s.subject_name}
                {s.subject_code && <span className="ap-pill-code">{s.subject_code}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      {!isEdit && subjects.length === 1 && (
        <div className="ap-subj-display">Subject: <strong>{subjects[0].subject_name}</strong></div>
      )}

      <div className="ap-card">
        <label className="ap-label">Type</label>
        <div className="ap-subject-pills">
          {KINDS.map((k) => {
            const ok = allowed[k.key] || (isEdit && k.key === kindOf(editAssignment));
            return (
              <button key={k.key} type="button" disabled={!ok}
                title={ok ? "" : k.key === "lab_work" ? "This subject has no lab" : "This subject has no tutorial"}
                style={ok ? undefined : { opacity: 0.4, cursor: "not-allowed" }}
                className={`ap-pill${effectiveKind === k.key ? " ap-pill--active" : ""}`}
                onClick={() => ok && setKind(k.key)}>{k.label}</button>
            );
          })}
        </div>
        <div style={{ fontSize: 12, color: "#6B7280", marginTop: 6 }}>
          {effectiveKind === "lab_work" ? "Lab work goes to the whole division, not to one batch."
            : effectiveKind === "tutorial_work" ? "Tutorial work goes to everyone who takes this subject."
            : !allowed.lab_work && !allowed.tutorial_work ? "This subject has no lab or tutorial. Tick Lab or Tutorial on the subject (Manage > Subjects) to post that kind of work."
            : "Students see the type on every assignment."}
        </div>
      </div>

      {activeSubj && <TagPicker subject={activeSubj} teacherId={teacherId} value={tagId} onChange={setTagId} disabled={saving} />}

      <div className="ap-card">
        <label className="ap-label">Title *</label>
        <input className="ap-input" placeholder={effectiveKind === "lab_work" ? "e.g. Experiment 3: Linked lists" : effectiveKind === "tutorial_work" ? "e.g. Tutorial sheet 2" : "Assignment title"}
          value={title} onChange={(e) => setTitle(e.target.value)} />

        <div className="ap-row-2">
          <div>
            <label className="ap-label">Total Marks *</label>
            <input className="ap-input" type="number" min="1" placeholder="e.g. 20"
              value={marks} onChange={(e) => setMarks(e.target.value)} />
          </div>
          <div>
            <label className="ap-label">Due Date *</label>
            <input className="ap-input" type="datetime-local"
              value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        </div>

        <label className="ap-label">
          Instructions <span className="ap-optional">(optional)</span>
        </label>
        <textarea className="ap-textarea" rows={4}
          placeholder="e.g. Write a 500-word essay on…"
          value={instructions} onChange={(e) => setInstructions(e.target.value)} />

        <label className="ap-label">
          Questions <span className="ap-optional">(optional)</span>
        </label>
        <textarea className="ap-textarea" rows={5}
          placeholder={"1. Explain the concept of…\n2. Describe the differences…"}
          value={questions} onChange={(e) => setQuestions(e.target.value)} />

        <Toggle
          on={allowLate} onChange={setAllowLate}
          label="Allow late submissions"
          sub="Students can submit after the due date"
          color="#4834D4"
        />
      </div>

      {/* Attachments */}
      <div className="ap-card">
        <div className="ap-section-title">Attachments</div>

        {/* Existing files (edit mode) */}
        {existingFiles.map((f) => (
          <div key={f.key} className="ap-file-row">
            <span className="ap-file-icon"><FileIcon type={f.type} /></span>
            <span className="ap-file-name">{f.name}</span>
            <a href={f.url} target="_blank" rel="noreferrer" className="ap-file-view">Open</a>
            <button className="ap-file-remove"
              onClick={() => { setExistingFiles((prev) => prev.filter((e) => e.key !== f.key)); if (f.key) removed.current.push(f.key); }}>✕</button>
          </div>
        ))}

        {/* New files */}
        {newFiles.map((f, i) => (
          <div key={i} className="ap-file-row ap-file-row--new">
            <span className="ap-file-icon"><FileIcon type={f.type} /></span>
            <span className="ap-file-name">{f.name}</span>
            <span className="ap-file-size">{(f.size / 1024).toFixed(0)} KB</span>
            <button className="ap-file-remove"
              onClick={() => setNewFiles((prev) => prev.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}

        <input ref={fileRef} type="file" multiple style={{ display: "none" }}
          accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt"
          onChange={onFilePick} />
        <button className="ap-attach-btn" onClick={pickFiles}>
          📎 Add Files
        </button>

        {/* Links */}
        <label className="ap-label" style={{ marginTop: 14 }}>Add Link</label>
        <div className="ap-link-row">
          <input className="ap-input ap-link-input" placeholder="https://…"
            value={linkInput} onChange={(e) => setLinkInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addLink()} />
          <button className="ap-link-add" onClick={addLink}>Add</button>
        </div>
        {links.map((l, i) => (
          <div key={i} className="ap-file-row">
            <span>🔗</span>
            <span className="ap-file-name">{l.url}</span>
            <button className="ap-file-remove"
              onClick={() => setLinks((prev) => prev.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
      </div>

      {!isPostedEdit && (
        <div className="ap-card">
          <Toggle
            on={scheduleOn} onChange={setScheduleOn}
            label="Schedule for later"
            sub="It posts by itself at the time you choose and students are notified then. Until then they cannot see it."
            color="#4834D4"
          />
          {scheduleOn && (
            <>
              <label className="ap-label" style={{ marginTop: 12 }}>Post at *</label>
              <input className="ap-input" type="datetime-local" min={toLocalInput(new Date())}
                value={publishAt} onChange={(e) => setPublishAt(e.target.value)} />
            </>
          )}
        </div>
      )}

      <button
        className="ap-submit-btn"
        disabled={saving || uploading}
        onClick={handleSubmit}>
        {uploading ? "Uploading files…" : saving ? "Saving…"
          : isPostedEdit ? "Save Changes"
          : scheduleOn ? (isScheduledEdit ? "Save schedule" : "Schedule")
          : isDraft ? `Post ${kindMetaNow.noun}` : `Create ${kindMetaNow.noun}`}
      </button>
      {autosave && (
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <button className="ap-btn-cancel" style={{ flex: 1 }} disabled={saving || !hasContent} onClick={goBack}>Save draft and close</button>
          {draftId.current && <button className="ap-btn-cancel" style={{ flex: 1, color: "#B91C1C" }} disabled={saving} onClick={discardDraft}>Delete draft</button>}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// GRADE SINGLE MODAL
// ════════════════════════════════════════════════════════════════════
function GradeModal({ row, totalMarks, teacherId, onClose, onSaved }) {
  const sub = row?.submission;
  const [marks,    setMarks]    = useState(sub?.marks_obtained != null ? String(sub.marks_obtained) : "");
  const [feedback, setFeedback] = useState(sub?.feedback || "");
  const [returned, setReturned] = useState(sub?.returned ?? false);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState("");

  const marksNum = Number(marks);
  const pct      = marks && !isNaN(marksNum) ? Math.round((marksNum / totalMarks) * 100) : null;

  const handleSave = async () => {
    if (!sub) return;
    if (isNaN(marksNum) || marksNum < 0) { setError("Enter valid marks"); return; }
    if (marksNum > totalMarks)           { setError(`Max marks is ${totalMarks}`); return; }
    setSaving(true); setError("");
    try {
      const body = { teacher_id: teacherId, marks_obtained: marksNum, feedback: feedback.trim() || null, returned };
      const isGraded = sub.status === "graded";
      if (isGraded) await put(`/api/assignments/grade/${sub.submission_id}`, body);
      else          await post(`/api/assignments/grade/${sub.submission_id}`, body);
      onSaved();
      onClose();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="ap-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ap-modal">
        <div className="ap-modal-header">
          <h3 className="ap-modal-title">Grade Submission</h3>
          <button className="ap-modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Student card */}
        <div className="ap-student-card">
          <div className="ap-student-avatar">{(row?.name || "?")[0].toUpperCase()}</div>
          <div>
            <div className="ap-student-name">{row?.name}</div>
            {row?.roll && <div className="ap-student-roll">{row.roll}</div>}
            {sub?.submitted_at && <div className="ap-student-sub-date">Submitted {fmtDate(sub.submitted_at)}</div>}
          </div>
          <StatusBadge sub={sub} />
        </div>

        {/* Submission content */}
        {sub?.attachments?.length > 0 && (
          <div className="ap-modal-section">
            <div className="ap-modal-section-label">Submitted Files</div>
            {sub.attachments.map((f, i) => (
              <a key={i} href={f.url} target="_blank" rel="noreferrer" className="ap-sub-file">
                <FileIcon type={f.type} /> {f.name}
                <span className="ap-file-open">↗</span>
              </a>
            ))}
          </div>
        )}
        {sub?.links?.length > 0 && (
          <div className="ap-modal-section">
            <div className="ap-modal-section-label">Submitted Links</div>
            {sub.links.map((l, i) => (
              <a key={i} href={l.url} target="_blank" rel="noreferrer" className="ap-sub-file">🔗 {l.label || l.url}</a>
            ))}
          </div>
        )}

        {!sub ? (
          <div className="ap-modal-empty">Student has not submitted yet.</div>
        ) : (
          <>
            {/* Marks input */}
            <div className="ap-modal-section">
              <div className="ap-marks-row">
                <span className="ap-marks-label">Marks</span>
                <span className="ap-marks-max">/ {totalMarks}</span>
                {pct !== null && (
                  <span className="ap-marks-pct" style={{ color: pct >= 75 ? "#10B981" : pct >= 50 ? "#F59E0B" : "#EF4444" }}>
                    {pct}%
                  </span>
                )}
              </div>
              <input
                className="ap-marks-input"
                type="number" min="0" max={totalMarks}
                placeholder="—"
                value={marks}
                onChange={(e) => setMarks(e.target.value)}
              />
            </div>

            <div className="ap-modal-section">
              <div className="ap-modal-section-label">Feedback (optional)</div>
              <textarea className="ap-textarea ap-textarea--sm" rows={3}
                placeholder="Write feedback for the student…"
                value={feedback} onChange={(e) => setFeedback(e.target.value)} />
            </div>

            {/* Return toggle */}
            <div className="ap-modal-section">
              <Toggle
                on={returned} onChange={setReturned}
                label="Return to student"
                sub={returned ? "Student can see their grade and feedback" : "Grade is hidden — student cannot see it yet"}
                color="#10B981"
              />
            </div>

            {error && <div className="ap-error ap-error--modal">{error}</div>}

            <div className="ap-modal-footer">
              <button className="ap-btn-cancel" onClick={onClose}>Cancel</button>
              <button className="ap-btn-save"
                disabled={saving || !marks}
                onClick={handleSave}
                style={{ background: returned ? "#10B981" : "#4834D4" }}>
                {saving ? "Saving…" : returned ? "Save & Return" : "Save (Hidden)"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// GRADE ALL MODAL — bulk marks entry
// ════════════════════════════════════════════════════════════════════
function GradeAllModal({ rows, totalMarks, teacherId, onClose, onSaved }) {
  const [drafts,    setDrafts]    = useState({});
  const [returnAll, setReturnAll] = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState("");
  const [progress,  setProgress]  = useState(null); // "3 / 10"

  useEffect(() => {
    const init = {};
    rows.forEach((r) => {
      init[r.uid] = r.submission?.marks_obtained != null ? String(r.submission.marks_obtained) : "";
    });
    setDrafts(init);
  }, [rows]);

  const submitted = rows.filter((r) => r.submission);

  const handleSaveAll = async () => {
    const toGrade = submitted.filter((r) => (drafts[r.uid] || "").trim() !== "");
    if (!toGrade.length) { setError("Enter marks for at least one student"); return; }

    const invalid = toGrade.find((r) => {
      const n = Number(drafts[r.uid]);
      return isNaN(n) || n < 0 || n > totalMarks;
    });
    if (invalid) { setError(`Invalid marks for ${invalid.name}`); return; }

    setSaving(true); setError("");
    let ok = 0; let fail = 0;

    for (const r of toGrade) {
      setProgress(`${ok + fail + 1} / ${toGrade.length}`);
      try {
        const sub    = r.submission;
        const isEdit = sub.status === "graded";
        const body   = { teacher_id: teacherId, marks_obtained: Number(drafts[r.uid]), returned: returnAll };
        if (isEdit) await put(`/api/assignments/grade/${sub.submission_id}`, body);
        else        await post(`/api/assignments/grade/${sub.submission_id}`, body);
        ok++;
      } catch { fail++; }
    }

    setSaving(false); setProgress(null);

    if (fail === 0) {
      onSaved(); onClose();
    } else {
      setError(`${ok} saved, ${fail} failed.`);
    }
  };

  return (
    <div className="ap-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ap-modal ap-modal--wide">
        {/* Header */}
        <div className="ap-modal-header">
          <h3 className="ap-modal-title">Grade All</h3>
          <div className="ap-modal-header-actions">
            {progress && <span className="ap-grade-progress">{progress}</span>}
            <button className="ap-modal-close" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Return all toggle */}
        <div className="ap-grade-all-return">
          <Toggle
            on={returnAll} onChange={setReturnAll}
            label="Return all to students"
            sub="All students will see their grades immediately"
            color="#10B981"
          />
        </div>

        {/* Table */}
        <div className="ap-grade-all-table-wrap">
          <table className="ap-grade-all-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Status</th>
                <th>Marks / {totalMarks}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.uid} className={i % 2 === 0 ? "ap-grade-row-alt" : ""}>
                  <td>
                    <div className="ap-grade-student">
                      <div className="ap-grade-avatar">{(r.name || "?")[0].toUpperCase()}</div>
                      <div>
                        <div className="ap-grade-name">{r.name}</div>
                        {r.roll && <div className="ap-grade-roll">{r.roll}</div>}
                      </div>
                    </div>
                  </td>
                  <td><StatusBadge sub={r.submission} /></td>
                  <td>
                    {r.submission ? (
                      <input
                        className={`ap-grade-input${drafts[r.uid] ? " ap-grade-input--filled" : ""}`}
                        type="number" min="0" max={totalMarks}
                        placeholder="—"
                        value={drafts[r.uid] || ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.uid]: e.target.value }))}
                      />
                    ) : (
                      <span className="ap-grade-nosub">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && <div className="ap-error ap-error--modal">{error}</div>}

        <div className="ap-modal-footer">
          <button className="ap-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="ap-btn-save ap-btn-save--wide"
            disabled={saving} onClick={handleSaveAll}>
            {saving ? `Saving… ${progress || ""}` : returnAll ? "Save All & Return" : "Save All (Hidden)"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// ASSIGNMENT DETAIL — submission register
// ════════════════════════════════════════════════════════════════════
function AssignmentDetail({ assignment: initialAssignment, teacherId, subjects, onBack, onEdit }) {
  const [assignment,   setAssignment]    = useState(initialAssignment);
  const [rows,         setRows]          = useState([]);
  const [loading,      setLoading]       = useState(true);
  const [viewMode,     setViewMode]      = useState("all"); // all | submitted | missing
  const [gradeRow,     setGradeRow]      = useState(null);
  const [gradeAllOpen, setGradeAllOpen]  = useState(false);
  const [error,        setError]         = useState("");
  const [deleting,     setDeleting]      = useState(false);
  const { tags: detailTags } = useTags(subjects.find((x) => x.subject_id === initialAssignment.subject_id) || { subject_id: initialAssignment.subject_id, course_id: initialAssignment.course_id });

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const assignData = await get(`/api/assignments/${assignment.assignment_id}?teacher_id=${encodeURIComponent(teacherId)}`);
      if (assignData.success) setAssignment(assignData.assignment);
      if (stateOf(assignData.assignment) !== "published") { setRows([]); return; }   // nothing can be submitted yet

      const [subData, stdData] = await Promise.all([
        get(`/api/assignments/${assignment.assignment_id}/submissions?teacher_id=${encodeURIComponent(teacherId)}`),
        get(`/api/assignments/${assignment.assignment_id}/students?teacher_id=${encodeURIComponent(teacherId)}`).catch(() => ({ success: false, students: [] })),
      ]);

      const submissions = subData.submissions || [];
      const subMap      = new Map(submissions.map((s) => [s.student_uid, s]));

      let allStudents = stdData.success && stdData.students?.length
        ? stdData.students
        : submissions.map((s) => ({ uid: s.student_uid, name: s.student_name || s.student_uid, roll: s.student_roll }));

      const newRows = allStudents.map((st) => ({
        uid:        st.uid,
        name:       st.name,
        roll:       st.roll,
        submission: subMap.get(st.uid) || null,
      }));

      // Sort: graded → late → submitted → not submitted
      newRows.sort((a, b) => {
        const order = { graded: 0, late: 1, submitted: 2, null: 3 };
        const as = (a.submission?.status) || "null";
        const bs = (b.submission?.status) || "null";
        if (order[as] !== order[bs]) return order[as] - order[bs];
        return (a.roll || a.name).localeCompare(b.roll || b.name, undefined, { numeric: true });
      });

      setRows(newRows);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [assignment.assignment_id, teacherId]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async () => {
    if (!window.confirm("Delete this assignment and all submissions? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await del(`/api/assignments/${assignment.assignment_id}?teacher_id=${encodeURIComponent(teacherId)}`);
      onBack(true); // true = refresh list
    } catch (e) { alert(e.message); }
    finally { setDeleting(false); }
  };

  const totalStudents = rows.length;
  const submitted     = rows.filter((r) => r.submission).length;
  const graded        = rows.filter((r) => r.submission?.status === "graded").length;
  const missing       = totalStudents - submitted;
  const state         = stateOf(assignment);
  const overdue       = state === "published" && isOverdue(assignment.due_date);

  const setStatus = async (status) => {
    if (status === "published" && !window.confirm("Post now? Students are notified straight away instead of at the scheduled time.")) return;
    try {
      await put(`/api/assignments/${assignment.assignment_id}`, { teacher_id: teacherId, status });
      if (status === "draft") { onBack(true); return; }
      load();
    } catch (e) { alert(e.message); }
  };

  const visibleRows = viewMode === "submitted"
    ? rows.filter((r) => r.submission)
    : viewMode === "missing"
    ? rows.filter((r) => !r.submission)
    : rows;

  return (
    <div className="ap-detail-wrap">
      {/* Topbar */}
      <div className="ap-detail-topbar">
        <button className="ap-back-btn" onClick={() => onBack(false)}>← Back</button>
        <h2 className="ap-detail-title">{assignment.title}</h2>
        <span className={`ap-info-chip${KIND_CHIP[kindOf(assignment)]}`} style={{ marginLeft: 8 }}>{kindMeta(assignment).label}</span>
        {tagNameOf(detailTags, assignment.tag_id) && <span className="ap-info-chip" style={{ marginLeft: 6 }}>🏷 {tagNameOf(detailTags, assignment.tag_id)}</span>}
        {state === "draft" && <span className="ap-info-chip" style={{ marginLeft: 6, background: "#FEF3C7", color: "#92400E" }}>Draft</span>}
        {state === "scheduled" && <span className="ap-info-chip" style={{ marginLeft: 6, background: "#DBEAFE", color: "#1E40AF" }}>Scheduled</span>}
        <div className="ap-detail-actions">
          <button className="ap-icon-btn" onClick={() => onEdit(assignment)} title="Edit">✏️</button>
          <button className="ap-icon-btn ap-icon-btn--danger"
            onClick={handleDelete} disabled={deleting} title="Delete">🗑</button>
        </div>
      </div>

      {state === "scheduled" && (
        <div className="ap-content-card" style={{ borderLeft: "4px solid #3B82F6" }}>
          <div className="ap-content-label">Posts {fmtDate(assignment.publish_at)}</div>
          <div className="ap-content-text">Students cannot see this yet. They are notified when it posts.</div>
          <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
            <button className="ap-back-btn" onClick={() => setStatus("published")}>Post now</button>
            <button className="ap-back-btn" onClick={() => setStatus("draft")}>Move to drafts</button>
          </div>
        </div>
      )}

      {/* Info chips */}
      <div className="ap-info-strip">
        <span className={`ap-info-chip${overdue ? " ap-info-chip--red" : ""}`}>
          🕐 Due {fmtShort(assignment.due_date)}
        </span>
        <span className="ap-info-chip ap-info-chip--purple">{assignment.marks} pts</span>
        <span className={`ap-info-chip${assignment.allow_late ? " ap-info-chip--green" : " ap-info-chip--red"}`}>
          {assignment.allow_late ? "Late OK" : "No late"}
        </span>
      </div>

      {/* Assignment content */}
      {assignment.instructions && (
        <div className="ap-content-card">
          <div className="ap-content-label">Instructions</div>
          <div className="ap-content-text">{assignment.instructions}</div>
        </div>
      )}
      {assignment.questions && (
        <div className="ap-content-card">
          <div className="ap-content-label">Questions</div>
          <div className="ap-content-text ap-content-text--pre">{assignment.questions}</div>
        </div>
      )}
      {assignment.attachments?.length > 0 && (
        <div className="ap-content-card">
          <div className="ap-content-label">Attachments</div>
          {assignment.attachments.map((f, i) => (
            <a key={i} href={f.url} target="_blank" rel="noreferrer" className="ap-sub-file">
              <FileIcon type={f.type} /> {f.name} <span className="ap-file-open">↗</span>
            </a>
          ))}
        </div>
      )}

      {state === "published" && (<>
      {/* Stats */}
      <div className="ap-stats-row">
        <div className="ap-stat"><span className="ap-stat-val ap-stat-val--purple">{submitted}</span><span className="ap-stat-label">Submitted</span></div>
        <div className="ap-stat-div" />
        <div className="ap-stat"><span className="ap-stat-val ap-stat-val--green">{graded}</span><span className="ap-stat-label">Graded</span></div>
        <div className="ap-stat-div" />
        <div className="ap-stat"><span className="ap-stat-val ap-stat-val--red">{missing}</span><span className="ap-stat-label">Missing</span></div>
        <div className="ap-stat-div" />
        <div className="ap-stat"><span className="ap-stat-val ap-stat-val--grey">{totalStudents}</span><span className="ap-stat-label">Total</span></div>
      </div>

      {/* Grade all button */}
      <button className="ap-grade-all-btn" onClick={() => setGradeAllOpen(true)}>
        📋 Grade All
      </button>

      {/* Filter tabs */}
      <div className="ap-filter-tabs">
        {[
          { key: "all",       label: `All (${totalStudents})` },
          { key: "submitted", label: `Submitted (${submitted})` },
          { key: "missing",   label: `Missing (${missing})` },
        ].map((tab) => (
          <button key={tab.key}
            className={`ap-filter-tab${viewMode === tab.key ? " ap-filter-tab--active" : ""}`}
            onClick={() => setViewMode(tab.key)}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Register table */}
      {error && <div className="ap-error">{error}</div>}
      <div className="ap-register">
        <div className="ap-register-head">
          <span className="ap-reg-col ap-reg-col--student">Student</span>
          <span className="ap-reg-col ap-reg-col--status">Status</span>
          <span className="ap-reg-col ap-reg-col--grade">Grade</span>
          <span className="ap-reg-col ap-reg-col--action"></span>
        </div>

        {loading ? (
          <div className="ap-loading">Loading submissions…</div>
        ) : visibleRows.length === 0 ? (
          <div className="ap-empty">No students found</div>
        ) : (
          visibleRows.map((r, i) => {
            const sub = r.submission;
            return (
              <div key={r.uid}
                className={`ap-reg-row${i % 2 === 0 ? " ap-reg-row--alt" : ""}`}
                onClick={() => setGradeRow(r)}>
                {/* Student */}
                <div className="ap-reg-col ap-reg-col--student">
                  <div className="ap-reg-avatar">{(r.name || "?")[0].toUpperCase()}</div>
                  <div>
                    <div className="ap-reg-name">{r.name}</div>
                    {r.roll && <div className="ap-reg-roll">{r.roll}</div>}
                  </div>
                </div>
                {/* Status */}
                <div className="ap-reg-col ap-reg-col--status">
                  <StatusBadge sub={sub} />
                  {sub?.submitted_at && <div className="ap-reg-date">{fmtShort(sub.submitted_at)}</div>}
                </div>
                {/* Grade */}
                <div className="ap-reg-col ap-reg-col--grade">
                  {sub?.marks_obtained != null ? (
                    <div className="ap-reg-score">
                      <span className="ap-reg-marks">{sub.marks_obtained}/{assignment.marks}</span>
                      <span className={`ap-return-dot${sub.returned ? " ap-return-dot--on" : ""}`}
                        title={sub.returned ? "Returned to student" : "Hidden from student"}>
                        {sub.returned ? "👁" : "🚫"}
                      </span>
                    </div>
                  ) : (
                    <span className="ap-reg-nograde">—</span>
                  )}
                </div>
                {/* Arrow */}
                <div className="ap-reg-col ap-reg-col--action">›</div>
              </div>
            );
          })
        )}
      </div>

      </>)}

      {/* Modals */}
      {gradeRow && (
        <GradeModal
          row={gradeRow}
          totalMarks={assignment.marks}
          teacherId={teacherId}
          onClose={() => setGradeRow(null)}
          onSaved={load}
        />
      )}
      {gradeAllOpen && (
        <GradeAllModal
          rows={rows}
          totalMarks={assignment.marks}
          teacherId={teacherId}
          onClose={() => setGradeAllOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// MAIN PAGE — list view
// ════════════════════════════════════════════════════════════════════
export default function AssignmentsPage() {
  const navigate = useNavigate();
  const session  = getUserSession();

  useEffect(() => { if (!session) navigate("/", { replace: true }); }, []);
  if (!session) return null;

  const user      = session.user    || {};
  const profile   = session.profile || {};
  const uid       = user.uid;
  const isHead    = user.is_head;
  const role      = isHead ? "head" : "teacher";

  // teacherId comes from the dashboard response (we stored it in dashData)
  // For this page we resolve it via the timetable/dashboard endpoint
  const [teacherId,    setTeacherId]    = useState(user.teacher_id || null);
  const [subjects,     setSubjects]     = useState([]);
  const [activeSubj,   setActiveSubj]   = useState(null);
  const [assignments,  setAssignments]  = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState("");
  const [kindFilter,   setKindFilter]   = useState("all");
  const [tagFilter,    setTagFilter]    = useState("all");
  const { tags: listTags } = useTags(activeSubj);

  // view: "list" | "detail" | "create" | "edit"
  const [view,         setView]         = useState("list");
  const [selectedAss,  setSelectedAss]  = useState(null); // for detail/edit

  // Load subjects + teacher_id via timetable (reuses existing endpoint)
  const loadSubjects = useCallback(async () => {
    try {
      const data = await get(`/api/web/teacher/timetable?uid=${encodeURIComponent(uid)}`);
      if (data.success) {
        // Build unique subjects
        const map = {};
        (data.lectures || []).forEach((l) => {
          if (l.subject_id) map[l.subject_id] = {
            subject_id:   l.subject_id,
            subject_name: l.subject_name,
            subject_code: l.subject_code,
            course_id:    l.course_id,
            has_lab:      !!(map[l.subject_id]?.has_lab || l.kind === "lab"),   // a lab session is scheduled for it
            has_tutorial: !!(map[l.subject_id]?.has_tutorial || l.kind === "tutorial"),
          };
        });
        // the dashboard returns the full subject documents (has_tutorial / has_lab / kind); merge them in
        try {
          const dash = await get(`/api/web/teacher/dashboard?uid=${encodeURIComponent(uid)}`);
          (dash.subjects || []).forEach((sd) => {
            if (!sd.subject_id) return;
            const prev = map[sd.subject_id] || {};
            map[sd.subject_id] = {
              ...prev,
              subject_id: sd.subject_id,
              subject_name: sd.subject_name || prev.subject_name,
              subject_code: sd.subject_code || prev.subject_code,
              course_id: sd.course_id || prev.course_id,
              kind: sd.kind,
              has_lab: !!sd.has_lab || prev.has_lab,
              has_tutorial: !!sd.has_tutorial,
            };
          });
        } catch { /* the timetable-derived flags still apply */ }
        const subjs = Object.values(map).filter((x) => x.course_id);
        setSubjects(subjs);
        if (subjs.length) setActiveSubj(subjs[0]);
        else setLoading(false);          // nothing is scheduled for this teacher yet: don't spin forever
        if (data.teacher_id) setTeacherId(data.teacher_id);
      } else {
        setLoading(false);
      }
    } catch (e) { setError(e.message); setLoading(false); }
  }, [uid]);

  const loadAssignments = useCallback(async () => {
    if (!activeSubj) return;
    setLoading(true); setError("");
    try {
      const data = await get(
        `/api/assignments?subject_id=${encodeURIComponent(activeSubj.subject_id)}&course_id=${encodeURIComponent(activeSubj.course_id)}&teacher_id=${encodeURIComponent(teacherId || "")}`
      );
      setAssignments(data.assignments || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [activeSubj]);

  useEffect(() => { loadSubjects(); }, []);
  useEffect(() => { if (activeSubj && teacherId) loadAssignments(); }, [activeSubj, teacherId]);

  const handleBack = (refresh) => {
    setView("list");
    setSelectedAss(null);
    if (refresh) loadAssignments();
  };

  // List view
  const renderList = () => (
    <>
      {/* Subject tabs */}
      {subjects.length > 1 && (
        <div className="ap-subject-tabs">
          {subjects.map((s) => (
            <button key={s.subject_id}
              className={`ap-subject-tab${activeSubj?.subject_id === s.subject_id ? " ap-subject-tab--active" : ""}`}
              onClick={() => setActiveSubj(s)}>
              {s.subject_name}
              {s.subject_code && <span className="ap-subject-code">{s.subject_code}</span>}
            </button>
          ))}
        </div>
      )}

      {/* New assignment button */}
      <button className="ap-new-btn" onClick={() => setView("create")}>
        + New Assignment
      </button>

      {listTags.some((t) => assignments.some((a) => a.tag_id === t.tag_id)) && (
        <div className="ap-subject-pills" style={{ margin: "10px 0" }}>
          <button className={`ap-pill${tagFilter === "all" ? " ap-pill--active" : ""}`} onClick={() => setTagFilter("all")}>All topics</button>
          {listTags.filter((t) => assignments.some((a) => a.tag_id === t.tag_id)).map((t) => (
            <button key={t.tag_id} className={`ap-pill${tagFilter === t.tag_id ? " ap-pill--active" : ""}`} onClick={() => setTagFilter(t.tag_id)}>
              🏷 {t.name} ({assignments.filter((a) => a.tag_id === t.tag_id).length})
            </button>
          ))}
          <button className={`ap-pill${tagFilter === "none" ? " ap-pill--active" : ""}`} onClick={() => setTagFilter("none")}>Other ({assignments.filter((a) => !a.tag_id || !listTags.some((t) => t.tag_id === a.tag_id)).length})</button>
        </div>
      )}

      {KINDS.filter((k) => assignments.some((a) => kindOf(a) === k.key)).length > 1 && (
        <div className="ap-subject-pills" style={{ margin: "10px 0" }}>
          {[{ key: "all", label: "All" }, ...KINDS].map((k) => (
            <button key={k.key} className={`ap-pill${kindFilter === k.key ? " ap-pill--active" : ""}`} onClick={() => setKindFilter(k.key)}>
              {k.key === "all" ? "All" : k.short} ({k.key === "all" ? assignments.length : assignments.filter((a) => kindOf(a) === k.key).length})
            </button>
          ))}
        </div>
      )}

      {error && <div className="ap-error">{error}</div>}

      {loading ? (
        <div className="ap-loading">Loading assignments…</div>
      ) : subjects.length === 0 ? (
        <div className="ap-empty-state">
          <div style={{ fontSize: 40, marginBottom: 12 }}>📚</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: "#111827" }}>No subjects scheduled yet</div>
          <div style={{ color: "#6B7280", marginTop: 4 }}>Assignments are created per subject. Once a lecture of yours is on the timetable, its subject appears here.</div>
        </div>
      ) : assignments.length === 0 ? (
        <div className="ap-empty-state">
          <div style={{ fontSize: 40, marginBottom: 12 }}>📝</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: "#111827" }}>No assignments yet</div>
          <div style={{ color: "#6B7280", marginTop: 4 }}>Create your first assignment for this subject.</div>
        </div>
      ) : (
        <div className="ap-list">
          {[...assignments]
            .filter((a) => kindFilter === "all" || kindOf(a) === kindFilter)
            .filter((a) => tagFilter === "all" || (tagFilter === "none" ? !a.tag_id : a.tag_id === tagFilter))
            .sort((x, y) => (stateOf(x) === "published" ? 1 : 0) - (stateOf(y) === "published" ? 1 : 0))   // drafts and scheduled first
            .map((a) => {
            const st = stateOf(a);
            const overdue = st === "published" && isOverdue(a.due_date);
            return (
              <div key={a.assignment_id} className="ap-list-card"
                onClick={() => { setSelectedAss(a); setView(st === "draft" ? "edit" : "detail"); }}>
                <div className="ap-list-card-top">
                  <div className="ap-list-title">{a.title || "Untitled draft"}</div>
                  <div className="ap-list-meta">
                    {st === "draft" && <span className="ap-info-chip" style={{ background: "#FEF3C7", color: "#92400E" }}>Draft</span>}
                    {st === "scheduled" && <span className="ap-info-chip" style={{ background: "#DBEAFE", color: "#1E40AF" }}>Posts {fmtDate(a.publish_at)}</span>}
                    <span className={`ap-info-chip${KIND_CHIP[kindOf(a)]}`}>{kindMeta(a).short}</span>
                    {tagNameOf(listTags, a.tag_id) && <span className="ap-info-chip">🏷 {tagNameOf(listTags, a.tag_id)}</span>}
                    {a.marks != null && <span className="ap-info-chip ap-info-chip--purple">{a.marks} pts</span>}
                    {a.due_date && <span className={`ap-info-chip${overdue ? " ap-info-chip--red" : ""}`}>
                      {overdue ? "Overdue" : "Due"} {fmtShort(a.due_date)}
                    </span>}
                    {a.allow_late && <span className="ap-info-chip ap-info-chip--green">Late OK</span>}
                  </div>
                </div>
                {a.instructions && (
                  <div className="ap-list-preview">{a.instructions.slice(0, 120)}{a.instructions.length > 120 ? "…" : ""}</div>
                )}
                <div className="ap-list-footer">
                  <span className="ap-list-sub-count">
                    {st === "draft" ? "Not posted yet" : st === "scheduled" ? "Not visible to students yet" : `${a.submissions_count || 0} submission${a.submissions_count !== 1 ? "s" : ""}`}
                  </span>
                  <span className="ap-list-arrow">›</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  return (
    <div className="ap-page">
      <AppSidebar role={role} pendingOD={0} />

      <div className="ap-main-wrap">
        <header className="ap-topbar">
          <h1 className="ap-topbar-title">Assignments</h1>
        </header>

        <main className="ap-main">
          {view === "list"   && renderList()}
          {view === "create" && (
            <AssignmentForm
              subjects={subjects}
              teacherId={teacherId}
              editAssignment={null}
              onDone={() => { setView("list"); loadAssignments(); }}
              onCancel={() => { setView("list"); loadAssignments(); }}
            />
          )}
          {view === "edit" && selectedAss && (
            <AssignmentForm
              subjects={subjects}
              teacherId={teacherId}
              editAssignment={selectedAss}
              onDone={() => { if (stateOf(selectedAss) === "draft") { setView("list"); setSelectedAss(null); loadAssignments(); } else { setView("detail"); } }}
              onCancel={() => { if (stateOf(selectedAss) === "draft") { setView("list"); setSelectedAss(null); loadAssignments(); } else setView("detail"); }}
            />
          )}
          {view === "detail" && selectedAss && (
            <AssignmentDetail
              assignment={selectedAss}
              teacherId={teacherId}
              subjects={subjects}
              onBack={handleBack}
              onEdit={(a) => { setSelectedAss(a); setView("edit"); }}
            />
          )}
        </main>
      </div>
    </div>
  );
}