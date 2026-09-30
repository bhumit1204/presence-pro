// @ts-nocheck
/**
 * TestsPage.jsx — Teacher quiz/test management
 *
 * Views:
 *  list      — all quizzes (live/scheduled/completed tabs)
 *  detail    — one quiz: header, questions, submissions leaderboard
 *  create    — manual question builder + finalize (schedule/timing/join code)
 *  ai        — AI generate from syllabus → preview → finalize
 *  preview   — review/edit AI questions before finalizing
 *  finalize  — set timing, duration, join code, create
 *
 * API (existing quiz_routes.js — no new backend needed):
 *  GET    /api/quizzes/teacher/:teacher_id
 *  GET    /api/quizzes/:id?teacher_id=
 *  GET    /api/quizzes/:id/results?teacher_id=
 *  POST   /api/quizzes/generate-preview
 *  POST   /api/quizzes/create
 *  PATCH  /api/quizzes/:id/reschedule
 *  PATCH  /api/quizzes/:id/update-questions
 *  DELETE /api/quizzes/:id  body:{teacher_id}
 *  POST   /api/assignments/upload  (image upload to R2)
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { getUserSession } from "../../services/session";
import AppSidebar from "../../components/AppSidebar";
import "./TestsPage.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

// ── fetch helpers ─────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res  = await fetch(`${API}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
const get  = (p)      => apiFetch(p);
const post = (p, b)   => apiFetch(p, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(b) });
const put  = (p, b)   => apiFetch(p, { method:"PUT",  headers:{"Content-Type":"application/json"}, body:JSON.stringify(b) });
const patch= (p, b)   => apiFetch(p, { method:"PATCH",headers:{"Content-Type":"application/json"}, body:JSON.stringify(b) });
const del  = (p, b)   => apiFetch(p, { method:"DELETE",headers:{"Content-Type":"application/json"}, body:JSON.stringify(b) });

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
}
function fmtShort(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day:"2-digit", month:"short" });
}
function msToCountdown(ms) {
  if (ms <= 0) return "00:00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function getStatus(quiz) {
  const now   = Date.now();
  const start = new Date(quiz.scheduled_start).getTime();
  const end   = new Date(quiz.scheduled_end).getTime();
  if (now >= start && now <= end) return "live";
  if (now < start) return "scheduled";
  return "completed";
}
function StatusBadge({ status }) {
  const MAP = {
    live:      { cls:"tp-badge--live",      label:"● Live" },
    scheduled: { cls:"tp-badge--scheduled", label:"⏳ Scheduled" },
    completed: { cls:"tp-badge--completed", label:"✓ Completed" },
  };
  const { cls, label } = MAP[status] || MAP.completed;
  return <span className={`tp-badge ${cls}`}>{label}</span>;
}
function Toggle({ on, onChange, label, sub }) {
  return (
    <div className="tp-toggle-row">
      <div className="tp-toggle-info">
        <span className="tp-toggle-label">{label}</span>
        {sub && <span className="tp-toggle-sub">{sub}</span>}
      </div>
      <button className={`tp-toggle${on ? " tp-toggle--on" : ""}`} onClick={() => onChange(!on)}>
        <span className={`tp-toggle-knob${on ? " tp-toggle-knob--on" : ""}`} />
      </button>
    </div>
  );
}

// ── image upload to R2 via /api/assignments/upload ────────────────────────────
async function uploadImage(file) {
  const fd = new FormData();
  fd.append("folder", "assignments"); // same bucket, assignments folder
  fd.append("files", file, `question_img_${Date.now()}.${file.name.split(".").pop()}`);
  const res  = await fetch(`${API}/api/assignments/upload`, { method:"POST", body:fd });
  const data = await res.json();
  if (!data.success || !data.files?.[0]) throw new Error("Image upload failed");
  return data.files[0].url;
}

// ════════════════════════════════════════════════════════════════════════════
// QUESTION BUILDER — used in both manual create and AI preview
// ════════════════════════════════════════════════════════════════════════════
function QuestionCard({ q, index, onChange, onDelete, showDelete = true, readOnly = false }) {
  const isMCQ = q.type === "mcq";
  const imgRef = useRef();

  const updateOption = (i, val) => {
    const opts = [...(q.options || [])];
    const wasCorrect = opts[i] === q.correct_answer;
    opts[i] = val;
    onChange({ ...q, options: opts, correct_answer: wasCorrect ? val : q.correct_answer });
  };
  const markCorrect = (i) => onChange({ ...q, correct_answer: (q.options || [])[i] });
  const deleteOption = (i) => {
    const opts = (q.options || []).filter((_, j) => j !== i);
    onChange({ ...q, options: opts, correct_answer: q.options?.[i] === q.correct_answer ? "" : q.correct_answer });
  };
  const addOption = () => onChange({ ...q, options: [...(q.options || []), ""] });

  const pickImage = () => imgRef.current?.click();
  const onImgPick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await uploadImage(file);
      onChange({ ...q, image_url: url });
    } catch {}
    e.target.value = "";
  };

  return (
    <div className={`tp-qcard${readOnly ? " tp-qcard--readonly" : ""}`}>
      <div className="tp-qcard-header">
        <span className="tp-q-num">Q{index + 1}</span>
        <span className={`tp-q-type${isMCQ ? "" : " tp-q-type--open"}`}>{isMCQ ? "MCQ" : "Open"}</span>
        <div className="tp-q-marks-wrap">
          <input className="tp-q-marks-input" type="number" min="1"
            value={q.marks}
            readOnly={readOnly}
            onChange={readOnly ? undefined : (e) => onChange({ ...q, marks: Number(e.target.value) || 1 })} />
          <span className="tp-q-marks-label">pts</span>
        </div>
        {showDelete && !readOnly && (
          <button className="tp-q-delete" onClick={onDelete}>Delete</button>
        )}
      </div>

      {/* Question text */}
      <label className="tp-q-label">Question</label>
      <textarea className="tp-q-textarea" rows={3} placeholder="Enter question text…"
        value={q.question}
        readOnly={readOnly}
        onChange={readOnly ? undefined : (e) => onChange({ ...q, question: e.target.value })} />

      {/* Question image */}
      <input ref={imgRef} type="file" accept="image/*" style={{ display:"none" }} onChange={readOnly ? undefined : onImgPick} />
      {q.image_url ? (
        <div className="tp-q-img-wrap">
          <img src={q.image_url} alt="Question" className="tp-q-img" />
          {!readOnly && <button className="tp-q-img-remove" onClick={() => onChange({ ...q, image_url: null })}>✕ Remove image</button>}
        </div>
      ) : (
        !readOnly && <button className="tp-q-img-btn" onClick={pickImage}>🖼 Add image</button>
      )}

      {/* MCQ options */}
      {isMCQ && (
        <div className="tp-q-options">
          <label className="tp-q-label">{readOnly ? "Options" : "Options — click ◯ to mark correct"}</label>
          {(q.options || []).map((opt, i) => {
            const isCorrect = opt.trim() !== "" && opt.trim() === (q.correct_answer || "").trim();
            return (
              <div key={i} className={`tp-opt-row${isCorrect ? " tp-opt-row--correct" : ""}`}>
                <button className={`tp-opt-radio${isCorrect ? " tp-opt-radio--on" : ""}`}
                  onClick={readOnly ? undefined : () => markCorrect(i)}
                  style={readOnly ? { cursor: "default" } : {}}
                  title={isCorrect ? "Correct answer" : (readOnly ? "" : "Mark as correct")} />
                <span className={`tp-opt-badge${isCorrect ? " tp-opt-badge--on" : ""}`}>
                  {String.fromCharCode(65 + i)}
                </span>
                <input className={`tp-opt-input${isCorrect ? " tp-opt-input--on" : ""}`}
                  value={opt} placeholder={`Option ${String.fromCharCode(65 + i)}`}
                  readOnly={readOnly}
                  onChange={readOnly ? undefined : (e) => updateOption(i, e.target.value)} />
                {!readOnly && (
                  <button className="tp-opt-remove" onClick={() => deleteOption(i)}>✕</button>
                )}
              </div>
            );
          })}
          {!readOnly && (q.options || []).length < 6 && (
            <button className="tp-opt-add" onClick={addOption}>+ Add option</button>
          )}
        </div>
      )}

      {/* Open-ended model answer */}
      {!isMCQ && (
        <>
          <label className="tp-q-label">{readOnly ? "Model Answer" : "Model Answer"}</label>
          <textarea className="tp-q-textarea" rows={3} placeholder="Expected answer…"
            value={q.correct_answer}
            readOnly={readOnly}
            onChange={readOnly ? undefined : (e) => onChange({ ...q, correct_answer: e.target.value })} />
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// FINALIZE PANEL — timing, duration, join code → POST /api/quizzes/create
// ════════════════════════════════════════════════════════════════════════════
const DURATIONS = [10, 20, 30, 45, 60, 90];

function FinalizePanel({ quizData, onDone, onBack }) {
  const [mode,         setMode]         = useState("immediate"); // immediate | scheduled
  const [duration,     setDuration]     = useState(30);
  const [schedDate,    setSchedDate]    = useState("");
  const [schedTime,    setSchedTime]    = useState("");
  const [joinCode,     setJoinCode]     = useState(true);
  const [codeExpiry,   setCodeExpiry]   = useState(false);
  const [expiryMins,   setExpiryMins]   = useState(30);
  const [notifyStud,   setNotifyStud]   = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState("");

  const totalMarks = (quizData.questions || []).reduce((s, q) => s + (Number(q.marks) || 0), 0);

  const handleCreate = async () => {
    const now = new Date();
    let start;
    if (mode === "immediate") {
      start = now;
    } else {
      if (!schedDate || !schedTime) { setError("Please set date and time"); return; }
      start = new Date(`${schedDate}T${schedTime}`);
      if (start < now) { setError("Scheduled time cannot be in the past"); return; }
    }
    const end = new Date(start.getTime() + duration * 60000);
    setSaving(true); setError("");
    try {
      const payload = {
        ...quizData,
        time_limit_minutes: duration,
        scheduled_start:    start.toISOString(),
        scheduled_end:      end.toISOString(),
        notify_students:    notifyStud,
        use_join_code:      joinCode,
        join_code_duration_minutes: joinCode && codeExpiry ? expiryMins : undefined,
      };
      const data = await post("/api/quizzes/create", payload);
      if (data.success) onDone(data);
      else setError(data.error || "Failed to create");
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="tp-finalize">
      <div className="tp-form-header">
        <button className="tp-back-btn" onClick={onBack}>← Back</button>
        <h2 className="tp-form-title">Finalize Quiz</h2>
      </div>

      {error && <div className="tp-error">{error}</div>}

      {/* Summary */}
      <div className="tp-card">
        <div className="tp-section-title">Summary</div>
        <div className="tp-summary-row"><span>Title</span><strong>{quizData.title}</strong></div>
        <div className="tp-summary-row"><span>Questions</span><strong>{quizData.questions?.length}</strong></div>
        <div className="tp-summary-row"><span>Total Marks</span><strong>{totalMarks}</strong></div>
        <div className="tp-summary-row"><span>Type</span><strong>{quizData.question_type}</strong></div>
      </div>

      {/* Start mode */}
      <div className="tp-card">
        <label className="tp-label">Start Mode</label>
        <div className="tp-mode-row">
          {["immediate","scheduled"].map((m) => (
            <button key={m}
              className={`tp-mode-btn${mode === m ? " tp-mode-btn--active" : ""}`}
              onClick={() => setMode(m)}>
              {m === "immediate" ? "Start Now" : "Schedule"}
            </button>
          ))}
        </div>
        {mode === "scheduled" && (
          <div className="tp-date-row">
            <input className="tp-input" type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} />
            <input className="tp-input" type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} />
          </div>
        )}

        <label className="tp-label" style={{ marginTop: 16 }}>Duration</label>
        <div className="tp-duration-row">
          {DURATIONS.map((d) => (
            <button key={d}
              className={`tp-dur-btn${duration === d ? " tp-dur-btn--active" : ""}`}
              onClick={() => setDuration(d)}>
              {d}m
            </button>
          ))}
        </div>
      </div>

      {/* Join code */}
      <div className="tp-card">
        <Toggle on={joinCode} onChange={setJoinCode}
          label="Generate Join Code"
          sub={joinCode ? "Students enter code to join" : "Open quiz — anyone enrolled can join"} />
        {joinCode && (
          <>
            <Toggle on={codeExpiry} onChange={setCodeExpiry}
              label="Code Expiry" sub="Limit how long after start the code works" />
            {codeExpiry && (
              <div className="tp-expiry-row">
                {[15,30,60,120].map((m) => (
                  <button key={m}
                    className={`tp-expiry-btn${expiryMins === m ? " tp-expiry-btn--active" : ""}`}
                    onClick={() => setExpiryMins(m)}>
                    {m < 60 ? `${m}m` : `${m/60}h`}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <Toggle on={notifyStud} onChange={setNotifyStud}
          label="Notify Students" sub="Send push notification when quiz is created" />
      </div>

      <button className="tp-submit-btn" disabled={saving} onClick={handleCreate}>
        {saving ? "Creating…" : "Create Quiz"}
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MANUAL CREATE — build questions from scratch
// ════════════════════════════════════════════════════════════════════════════
function ManualCreate({ subjects, teacherId, onCancel, onFinalize }) {
  const [activeSubj, setActiveSubj] = useState(subjects[0] || null);
  const [title,      setTitle]      = useState("");
  const [desc,       setDesc]       = useState("");
  const [questions,  setQuestions]  = useState([
    { type:"mcq", question:"", options:["","","",""], correct_answer:"", marks:2, image_url:null }
  ]);
  const [error, setError] = useState("");

  const addQ = (type) => setQuestions((prev) => [
    ...prev,
    type === "mcq"
      ? { type:"mcq",      question:"", options:["","","",""], correct_answer:"", marks:2, image_url:null }
      : { type:"open_ended", question:"", correct_answer:"", marks:2, image_url:null }
  ]);

  const validate = () => {
    if (!activeSubj)   { setError("Select a subject"); return false; }
    if (!title.trim()) { setError("Title is required"); return false; }
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.question.trim()) { setError(`Q${i+1}: Question text required`); return false; }
      if (!q.correct_answer.trim()) { setError(`Q${i+1}: Select or enter correct answer`); return false; }
      if (q.type === "mcq") {
        const valid = (q.options || []).filter((o) => o.trim());
        if (valid.length < 2) { setError(`Q${i+1}: Need at least 2 options`); return false; }
        if (!valid.includes(q.correct_answer.trim())) { setError(`Q${i+1}: Correct answer must match an option`); return false; }
      }
      if (!q.marks || q.marks < 1) { setError(`Q${i+1}: Marks must be ≥ 1`); return false; }
    }
    return true;
  };

  const handleFinalize = () => {
    if (!validate()) return;
    const questionType = questions.every((q) => q.type === "mcq") ? "mcq"
      : questions.every((q) => q.type === "open_ended") ? "open_ended" : "mixed";
    onFinalize({
      teacher_id:    teacherId,
      subject_id:    activeSubj.subject_id,
      title:         title.trim(),
      description:   desc.trim() || undefined,
      question_type: questionType,
      questions:     questions.map((q) => ({
        type:           q.type,
        question:       q.question.trim(),
        options:        q.type === "mcq" ? (q.options || []).filter((o) => o.trim()) : null,
        correct_answer: q.correct_answer.trim(),
        marks:          Number(q.marks),
        image_url:      q.image_url || null,
      })),
    });
  };

  return (
    <div className="tp-form-wrap">
      <div className="tp-form-header">
        <button className="tp-back-btn" onClick={onCancel}>← Back</button>
        <h2 className="tp-form-title">Manual Quiz</h2>
      </div>
      {error && <div className="tp-error">{error}</div>}

      {/* Subject */}
      {subjects.length > 1 && (
        <div className="tp-card">
          <label className="tp-label">Subject *</label>
          <div className="tp-subject-pills">
            {subjects.map((s) => (
              <button key={s.subject_id}
                className={`tp-pill${activeSubj?.subject_id === s.subject_id ? " tp-pill--active" : ""}`}
                onClick={() => setActiveSubj(s)}>
                {s.subject_name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="tp-card">
        <label className="tp-label">Title *</label>
        <input className="tp-input" placeholder="Quiz title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="tp-label">Description</label>
        <input className="tp-input" placeholder="Short description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>

      {/* Questions */}
      {questions.map((q, i) => (
        <QuestionCard key={i} q={q} index={i}
          onChange={(updated) => { const c = [...questions]; c[i] = updated; setQuestions(c); }}
          onDelete={() => setQuestions(questions.filter((_, j) => j !== i))}
          showDelete={questions.length > 1} />
      ))}

      {/* Add question buttons */}
      <div className="tp-add-q-row">
        <button className="tp-add-q-btn" onClick={() => addQ("mcq")}>+ MCQ</button>
        <button className="tp-add-q-btn tp-add-q-btn--open" onClick={() => addQ("open_ended")}>+ Open Ended</button>
      </div>

      <button className="tp-submit-btn" onClick={handleFinalize}>
        Continue to Finalize →
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// AI CREATE — form → generate preview → edit → finalize
// ════════════════════════════════════════════════════════════════════════════
function AICreate({ subjects, teacherId, onCancel, onFinalize }) {
  const [step, setStep]   = useState("form"); // form | preview
  const [activeSubj, setActiveSubj] = useState(subjects[0] || null);
  const [title,     setTitle]    = useState("");
  const [desc,      setDesc]     = useState("");
  const [syllabus,  setSyllabus] = useState("");
  const [qCount,    setQCount]   = useState("10");
  const [marks,     setMarks]    = useState("2");
  const [sameMarks, setSameMarks] = useState(true);
  const [qType,     setQType]    = useState("mcq");
  const [difficulty,setDiff]     = useState("medium");
  const [loading,   setLoading]  = useState(false);
  const [error,     setError]    = useState("");
  const [questions, setQuestions] = useState([]);

  const generate = async () => {
    if (!activeSubj) { setError("Select a subject"); return; }
    if (!title.trim()) { setError("Title is required"); return; }
    if (!syllabus.trim()) { setError("Syllabus is required"); return; }
    setLoading(true); setError("");
    try {
      const data = await post("/api/quizzes/generate-preview", {
        teacher_id:           teacherId,
        subject_id:           activeSubj.subject_id,
        syllabus:             syllabus.trim(),
        question_count:       Number(qCount),
        question_type:        qType,
        difficulty,
        custom_marks_enabled: !sameMarks,
        marks_per_question:   sameMarks ? Number(marks) : undefined,
      });
      if (!data.success) throw new Error(data.error);
      setQuestions(data.questions || []);
      setStep("preview");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handleFinalize = () => {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.question?.trim()) { setError(`Q${i+1}: Question text required`); return; }
      if (!q.correct_answer?.trim()) { setError(`Q${i+1}: Correct answer required`); return; }
      if (q.type === "mcq") {
        const valid = (q.options || []).filter((o) => o.trim());
        if (valid.length < 2) { setError(`Q${i+1}: Need at least 2 options`); return; }
      }
    }
    const questionType = questions.every((q) => q.type === "mcq") ? "mcq"
      : questions.every((q) => q.type === "open_ended") ? "open_ended" : "mixed";
    onFinalize({
      teacher_id:    teacherId,
      subject_id:    activeSubj.subject_id,
      title:         title.trim(),
      description:   desc.trim() || undefined,
      syllabus:      syllabus.trim(),
      question_type: questionType,
      questions:     questions.map((q) => ({
        type:           q.type,
        question:       q.question.trim(),
        options:        q.type === "mcq" ? (q.options || []).filter((o) => o.trim()) : null,
        correct_answer: q.correct_answer.trim(),
        marks:          Number(q.marks),
      })),
    });
  };

  if (step === "preview") return (
    <div className="tp-form-wrap">
      <div className="tp-form-header">
        <button className="tp-back-btn" onClick={() => setStep("form")}>← Edit Settings</button>
        <h2 className="tp-form-title">Preview & Edit</h2>
      </div>
      {error && <div className="tp-error">{error}</div>}
      <div className="tp-preview-meta">
        <span>{questions.length} questions</span>
        <span>{questions.reduce((s,q) => s+Number(q.marks),0)} total marks</span>
      </div>
      {questions.map((q, i) => (
        <QuestionCard key={i} q={q} index={i}
          onChange={(updated) => { const c = [...questions]; c[i] = updated; setQuestions(c); }}
          onDelete={() => setQuestions(questions.filter((_, j) => j !== i))} />
      ))}
      <button className="tp-submit-btn" onClick={handleFinalize}>Continue to Finalize →</button>
    </div>
  );

  return (
    <div className="tp-form-wrap">
      <div className="tp-form-header">
        <button className="tp-back-btn" onClick={onCancel}>← Back</button>
        <h2 className="tp-form-title">AI Quiz Generator</h2>
      </div>
      {error && <div className="tp-error">{error}</div>}

      {subjects.length > 1 && (
        <div className="tp-card">
          <label className="tp-label">Subject *</label>
          <div className="tp-subject-pills">
            {subjects.map((s) => (
              <button key={s.subject_id}
                className={`tp-pill${activeSubj?.subject_id === s.subject_id ? " tp-pill--active" : ""}`}
                onClick={() => setActiveSubj(s)}>
                {s.subject_name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="tp-card">
        <label className="tp-label">Title *</label>
        <input className="tp-input" placeholder="Quiz title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="tp-label">Description</label>
        <input className="tp-input" placeholder="Short description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <label className="tp-label">Syllabus / Topics *</label>
        <textarea className="tp-textarea" rows={4} placeholder="e.g. Python basics, loops, OOP, file handling…"
          value={syllabus} onChange={(e) => setSyllabus(e.target.value)} />

        <div className="tp-row-2">
          <div>
            <label className="tp-label">No. of Questions</label>
            <input className="tp-input" type="number" min="1" max="50" value={qCount} onChange={(e) => setQCount(e.target.value)} />
          </div>
          <div>
            <label className="tp-label">Marks per Q</label>
            <input className="tp-input" type="number" min="1" value={marks}
              disabled={!sameMarks} onChange={(e) => setMarks(e.target.value)} />
          </div>
        </div>

        <Toggle on={sameMarks} onChange={setSameMarks}
          label="Same marks for all" sub="Toggle off to set marks per question in preview" />

        <label className="tp-label">Question Type</label>
        <div className="tp-mode-row">
          {["mcq","open_ended","mixed"].map((t) => (
            <button key={t}
              className={`tp-mode-btn${qType === t ? " tp-mode-btn--active" : ""}`}
              onClick={() => setQType(t)}>
              {t === "mcq" ? "MCQ" : t === "open_ended" ? "Open Ended" : "Mixed"}
            </button>
          ))}
        </div>

        <label className="tp-label">Difficulty</label>
        <div className="tp-mode-row">
          {["easy","medium","hard"].map((d) => (
            <button key={d}
              className={`tp-mode-btn${difficulty === d ? " tp-mode-btn--active" : ""}`}
              onClick={() => setDiff(d)}>
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <button className="tp-submit-btn" disabled={loading} onClick={generate}>
        {loading ? (
          <span>🤖 Generating<span className="tp-dots" /></span>
        ) : "Generate Questions →"}
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// QUIZ DETAIL — view quiz, questions, submissions, reschedule
// ════════════════════════════════════════════════════════════════════════════
function QuizDetail({ quizId, teacherId, onBack }) {
  const [quiz,        setQuiz]        = useState(null);
  const [questions,   setQuestions]   = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState("");
  const [tab,         setTab]         = useState("overview"); // overview | questions | results
  const [deleting,    setDeleting]    = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [localQs,     setLocalQs]     = useState([]);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [newStart,    setNewStart]    = useState("");
  const [newEnd,      setNewEnd]      = useState("");
  const [rescError,   setRescError]   = useState("");
  const [countdown,   setCountdown]   = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const quizData = await get(`/api/quizzes/${quizId}?teacher_id=${encodeURIComponent(teacherId)}`);
      if (!quizData.success) throw new Error(quizData.error);
      setQuiz(quizData.quiz);
      setQuestions(quizData.questions || []);
      setLocalQs(quizData.questions || []);

      const status = getStatus(quizData.quiz);
      if (status === "live" || status === "completed") {
        const subData = await get(`/api/quizzes/${quizId}/results?teacher_id=${encodeURIComponent(teacherId)}`);
        if (subData.success) {
          setSubmissions([...(subData.submissions || [])].sort((a,b) => (b.marks_obtained||0) - (a.marks_obtained||0)));
        }
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [quizId, teacherId]);

  useEffect(() => { load(); }, [load]);

  // Countdown for scheduled
  useEffect(() => {
    if (!quiz || getStatus(quiz) !== "scheduled") return;
    const tick = () => setCountdown(msToCountdown(new Date(quiz.scheduled_start).getTime() - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [quiz]);

  // Auto-refresh when live
  useEffect(() => {
    if (!quiz || getStatus(quiz) !== "live") return;
    const id = setInterval(() => load(), 15000);
    return () => clearInterval(id);
  }, [quiz, load]);

  const handleDelete = async () => {
    if (!window.confirm("Delete this quiz? This cannot be undone.")) return;
    setDeleting(true);
    try { await del(`/api/quizzes/${quizId}`, { teacher_id: teacherId }); onBack(true); }
    catch (e) { alert(e.message); }
    finally { setDeleting(false); }
  };

  const handleSaveQuestions = async () => {
    setSaving(true);
    try {
      await patch(`/api/quizzes/${quizId}/update-questions`, {
        teacher_id: teacherId,
        questions: localQs.map((q) => ({
          question_id:    q.question_id,
          type:           q.type,
          question:       q.question,
          options:        q.type === "mcq" ? (q.options || []).map((o) => typeof o === "string" ? o : o.text) : null,
          correct_answer: q.correct_answer,
          marks:          Number(q.marks),
        })),
      });
      setQuestions(localQs);
      alert("Questions saved!");
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };

  const handleReschedule = async () => {
    if (!newStart || !newEnd) { setRescError("Both start and end required"); return; }
    if (new Date(newEnd) <= new Date(newStart)) { setRescError("End must be after start"); return; }
    setRescError("");
    try {
      await patch(`/api/quizzes/${quizId}/reschedule`, {
        teacher_id: teacherId, scheduled_start: new Date(newStart).toISOString(), scheduled_end: new Date(newEnd).toISOString(),
      });
      setRescheduleOpen(false);
      load();
    } catch (e) { setRescError(e.message); }
  };

  if (loading) return <div className="tp-loading">Loading quiz…</div>;
  if (error)   return <div className="tp-error">⚠ {error}</div>;
  if (!quiz)   return null;

  const status = getStatus(quiz);
  const highest = submissions.length ? Math.max(...submissions.map((s) => s.marks_obtained||0)) : 0;
  const lowest  = submissions.length ? Math.min(...submissions.map((s) => s.marks_obtained||0)) : 0;
  const avg     = submissions.length ? (submissions.reduce((a,s) => a+(s.marks_obtained||0),0)/submissions.length).toFixed(1) : 0;

  return (
    <div className="tp-detail-wrap">
      {/* Topbar */}
      <div className="tp-detail-topbar">
        <button className="tp-back-btn" onClick={() => onBack(false)}>← Back</button>
        <h2 className="tp-detail-title">{quiz.title}</h2>
        <div className="tp-detail-actions">
          {status === "scheduled" && (
            <button className="tp-icon-btn" onClick={() => {
              setNewStart(quiz.scheduled_start?.slice(0,16) || "");
              setNewEnd(quiz.scheduled_end?.slice(0,16) || "");
              setRescheduleOpen(true);
            }}>📅</button>
          )}
          <button className="tp-icon-btn tp-icon-btn--danger"
            disabled={deleting} onClick={handleDelete}>🗑</button>
        </div>
      </div>

      {/* Header card */}
      <div className={`tp-quiz-header-card tp-quiz-header-card--${status}`}>
        <div className="tp-quiz-header-top">
          <div>
            <div className="tp-quiz-subject">{quiz.subject_name}</div>
            <StatusBadge status={status} />
          </div>
          {quiz.join_code && (
            <div className="tp-join-code-box">
              <span className="tp-join-code-label">JOIN CODE</span>
              <span className="tp-join-code">{quiz.join_code}</span>
            </div>
          )}
        </div>
        <div className="tp-quiz-stats">
          <div className="tp-qs-item"><span className="tp-qs-val">{quiz.question_count}</span><span className="tp-qs-label">Questions</span></div>
          <div className="tp-qs-div" />
          <div className="tp-qs-item"><span className="tp-qs-val">{quiz.total_marks}</span><span className="tp-qs-label">Marks</span></div>
          <div className="tp-qs-div" />
          <div className="tp-qs-item"><span className="tp-qs-val">{quiz.time_limit_minutes}m</span><span className="tp-qs-label">Duration</span></div>
          <div className="tp-qs-div" />
          <div className="tp-qs-item"><span className="tp-qs-val tp-qs-val--green">{submissions.length}</span><span className="tp-qs-label">Submitted</span></div>
        </div>
        <div className="tp-quiz-schedule">
          <span>Start: {fmtDate(quiz.scheduled_start)}</span>
          <span>→</span>
          <span>End: {fmtDate(quiz.scheduled_end)}</span>
        </div>
        {status === "scheduled" && countdown && (
          <div className="tp-countdown">
            <span style={{ color:"#9CA3AF", fontWeight:500 }}>Starts in</span> {countdown}
          </div>
        )}
        {status === "live" && (
          <div className="tp-live-banner">
            <span className="tp-live-dot" />
            Quiz is live — ends in <strong style={{ marginLeft:4 }}>{msToCountdown(new Date(quiz.scheduled_end).getTime() - Date.now())}</strong>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="tp-tabs">
        {["overview","questions","results"].map((t) => (
          <button key={t}
            className={`tp-tab${tab === t ? " tp-tab--active" : ""}`}
            onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {tab === "overview" && (
        <>
          {quiz.description && <div className="tp-content-card"><div className="tp-content-label">Description</div><div className="tp-content-text">{quiz.description}</div></div>}
          {quiz.syllabus    && <div className="tp-content-card"><div className="tp-content-label">Syllabus</div><div className="tp-content-text">{quiz.syllabus}</div></div>}
          {submissions.length > 0 && (
            <div className="tp-stats-grid">
              <div className="tp-stat-card tp-stat-card--green"><span className="tp-stat-val">{highest}</span><span className="tp-stat-label">Highest</span></div>
              <div className="tp-stat-card tp-stat-card--purple"><span className="tp-stat-val">{avg}</span><span className="tp-stat-label">Average</span></div>
              <div className="tp-stat-card tp-stat-card--red"><span className="tp-stat-val">{lowest}</span><span className="tp-stat-label">Lowest</span></div>
              <div className="tp-stat-card tp-stat-card--amber">
                <span className="tp-stat-val">
                  {submissions.length > 0 ? Math.round(submissions.filter((s) => (s.marks_obtained||0)/quiz.total_marks >= 0.5).length/submissions.length*100) : 0}%
                </span>
                <span className="tp-stat-label">Pass Rate</span>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "questions" && (
        <>
          {status === "scheduled" && (
            <div className="tp-edit-hint">You can edit questions before the quiz starts.</div>
          )}
          {(status === "live" || status === "completed") && (
            <div className="tp-edit-hint" style={{ background: "#F3F4F6", color: "#6B7280" }}>
              {status === "live" ? "Quiz is live — questions cannot be edited." : "Quiz is completed — questions are read-only."}
            </div>
          )}
          {localQs.map((q, i) => {
            const normQ = {
              ...q,
              options: q.type === "mcq"
                ? (q.options || []).map((o) => typeof o === "string" ? o : o.text || "")
                : null,
            };
            return (
              <QuestionCard key={q.question_id || i} q={normQ} index={i}
                readOnly={status !== "scheduled"}
                onChange={(updated) => { const c = [...localQs]; c[i] = { ...updated, question_id: q.question_id }; setLocalQs(c); }}
                onDelete={() => setLocalQs(localQs.filter((_,j) => j !== i))}
                showDelete={status === "scheduled" && localQs.length > 1} />
            );
          })}
          {status === "scheduled" && (
            <button className="tp-submit-btn tp-submit-btn--green"
              disabled={saving} onClick={handleSaveQuestions}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          )}
        </>
      )}

      {/* Results tab */}
      {tab === "results" && (
        submissions.length === 0 ? (
          <div className="tp-empty-state">No submissions yet.</div>
        ) : (
          <div className="tp-leaderboard">
            <div className="tp-lb-header">
              <span>#</span>
              <span>Student</span>
              <span style={{ textAlign: "right" }}>Score</span>
            </div>
            {submissions.map((sub, i) => {
              const MEDAL = { 0:"🥇", 1:"🥈", 2:"🥉" };
              const pct = quiz.total_marks > 0 ? Math.round((sub.marks_obtained||0)/quiz.total_marks*100) : 0;
              const name = sub.student_name || (sub.student_roll ? `Roll ${sub.student_roll}` : sub.student_uid?.slice(0,8));
              return (
                <div key={sub.submission_id || i} className="tp-lb-row">
                  <span className="tp-lb-rank">{MEDAL[i] !== undefined ? MEDAL[i] : i+1}</span>
                  <div className="tp-lb-info">
                    <div className="tp-lb-avatar">{(name||"?")[0].toUpperCase()}</div>
                    <div>
                      <div className="tp-lb-name">{name}</div>
                      {sub.student_roll && sub.student_name && <div className="tp-lb-roll">Roll {sub.student_roll}</div>}
                    </div>
                  </div>
                  <div className="tp-lb-score">
                    <span className="tp-lb-marks">{sub.marks_obtained}/{quiz.total_marks}</span>
                    <span className={`tp-lb-pct${pct >= 50 ? " tp-lb-pct--pass" : " tp-lb-pct--fail"}`}>{pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Reschedule modal */}
      {rescheduleOpen && (
        <div className="tp-modal-overlay" onClick={(e) => e.target === e.currentTarget && setRescheduleOpen(false)}>
          <div className="tp-modal">
            <div className="tp-modal-header">
              <h3 className="tp-modal-title">Reschedule Quiz</h3>
              <button className="tp-modal-close" onClick={() => setRescheduleOpen(false)}>✕</button>
            </div>
            <div className="tp-modal-body">
              <label className="tp-label">New Start</label>
              <input className="tp-input" type="datetime-local" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
              <label className="tp-label">New End</label>
              <input className="tp-input" type="datetime-local" value={newEnd}   onChange={(e) => setNewEnd(e.target.value)} />
              {rescError && <div className="tp-error">{rescError}</div>}
            </div>
            <div className="tp-modal-footer">
              <button className="tp-btn-cancel" onClick={() => setRescheduleOpen(false)}>Cancel</button>
              <button className="tp-btn-save" onClick={handleReschedule}>Save Schedule</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ════════════════════════════════════════════════════════════════════════════
export default function TestsPage() {
  const navigate = useNavigate();
  const session  = getUserSession();

  useEffect(() => { if (!session) navigate("/", { replace: true }); }, []);
  if (!session) return null;

  const user    = session.user || {};
  const uid     = user.uid;
  const isHead  = user.is_head;
  const role    = isHead ? "head" : "teacher";

  const [teacherId,  setTeacherId]  = useState(user.teacher_id || null);
  const [subjects,   setSubjects]   = useState([]);
  const [quizzes,    setQuizzes]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState("");
  const [tabFilter,     setTabFilter]     = useState("all");
  const [subjectFilter, setSubjectFilter] = useState("all"); // subject_id or "all"
  const [courseFilter,  setCourseFilter]  = useState("all"); // course_id or "all"

  // view: list | detail | manual | ai | finalize
  const [view,       setView]       = useState("list");
  const [selectedId, setSelectedId] = useState(null);
  const [finalizeData, setFinalizeData] = useState(null);

  const loadSubjects = useCallback(async () => {
    try {
      const data = await get(`/api/web/teacher/timetable?uid=${encodeURIComponent(uid)}`);
      if (data.success) {
        const map = {};
        (data.lectures || []).forEach((l) => {
          if (l.subject_id) map[l.subject_id] = { subject_id:l.subject_id, subject_name:l.subject_name, subject_code:l.subject_code, course_id:l.course_id };
        });
        setSubjects(Object.values(map));
        if (data.teacher_id) setTeacherId(data.teacher_id);
      }
    } catch {}
  }, [uid]);

  const loadQuizzes = useCallback(async () => {
    if (!teacherId) return;
    setLoading(true); setError("");
    try {
      const data = await get(`/api/quizzes/teacher/${encodeURIComponent(teacherId)}`);
      setQuizzes(data.quizzes || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [teacherId]);

  useEffect(() => { loadSubjects(); }, []);
  useEffect(() => { if (teacherId) loadQuizzes(); }, [teacherId]);

  const handleBack = (refresh) => {
    setView("list"); setSelectedId(null); setFinalizeData(null);
    if (refresh) loadQuizzes();
  };

  // Derive unique courses from subjects
  const courses = Object.values(
    subjects.reduce((acc, s) => {
      if (s.course_id && !acc[s.course_id]) acc[s.course_id] = { course_id: s.course_id, course_name: s.course_name || s.course_id };
      return acc;
    }, {})
  );

  const filteredQuizzes = quizzes.filter((q) => {
    if (tabFilter !== "all" && getStatus(q) !== tabFilter) return false;
    if (subjectFilter !== "all" && q.subject_id !== subjectFilter) return false;
    if (courseFilter  !== "all" && q.course_id  !== courseFilter)  return false;
    return true;
  });

  const counts = {
    all:       quizzes.filter((q) => {
                 if (subjectFilter !== "all" && q.subject_id !== subjectFilter) return false;
                 if (courseFilter  !== "all" && q.course_id  !== courseFilter)  return false;
                 return true;
               }).length,
    live:      quizzes.filter((q) => getStatus(q) === "live"      && (subjectFilter === "all" || q.subject_id === subjectFilter) && (courseFilter === "all" || q.course_id === courseFilter)).length,
    scheduled: quizzes.filter((q) => getStatus(q) === "scheduled" && (subjectFilter === "all" || q.subject_id === subjectFilter) && (courseFilter === "all" || q.course_id === courseFilter)).length,
    completed: quizzes.filter((q) => getStatus(q) === "completed" && (subjectFilter === "all" || q.subject_id === subjectFilter) && (courseFilter === "all" || q.course_id === courseFilter)).length,
  };

  const renderList = () => (
    <>
      {/* Create buttons */}
      <div className="tp-create-row">
        <button className="tp-new-btn" onClick={() => setView("manual")}>✏️ Manual</button>
        <button className="tp-new-btn tp-new-btn--ai" onClick={() => setView("ai")}>🤖 AI Generate</button>
      </div>

      {/* Subject + Course filter dropdowns */}
      {(subjects.length > 1 || courses.length > 1) && (
        <div className="tp-filter-bar">
          {courses.length > 1 && (
            <select className="tp-filter-select"
              value={courseFilter}
              onChange={(e) => { setCourseFilter(e.target.value); setSubjectFilter("all"); }}>
              <option value="all">All Classes</option>
              {courses.map((c) => (
                <option key={c.course_id} value={c.course_id}>{c.course_name}</option>
              ))}
            </select>
          )}
          {subjects.length > 1 && (
            <select className="tp-filter-select"
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}>
              <option value="all">All Subjects</option>
              {subjects
                .filter((s) => courseFilter === "all" || s.course_id === courseFilter)
                .map((s) => (
                  <option key={s.subject_id} value={s.subject_id}>{s.subject_name}</option>
                ))}
            </select>
          )}
          {(subjectFilter !== "all" || courseFilter !== "all") && (
            <button className="tp-filter-clear"
              onClick={() => { setSubjectFilter("all"); setCourseFilter("all"); }}>
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Status tab filter */}
      <div className="tp-tab-filter">
        {["all","live","scheduled","completed"].map((t) => (
          <button key={t}
            className={`tp-tab-filter-btn${tabFilter === t ? " tp-tab-filter-btn--active" : ""}`}
            onClick={() => setTabFilter(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)} ({counts[t]})
          </button>
        ))}
      </div>

      {error && <div className="tp-error">{error}</div>}

      {loading ? <div className="tp-loading">Loading quizzes…</div>
      : filteredQuizzes.length === 0 ? (
        <div className="tp-empty-state">
          <div style={{fontSize:40,marginBottom:12}}>📊</div>
          <div style={{fontWeight:700,fontSize:16}}>No quizzes yet</div>
          <div style={{color:"#6B7280",marginTop:4}}>Create your first quiz using the buttons above.</div>
        </div>
      ) : (
        <div className="tp-quiz-list">
          {filteredQuizzes.map((q) => {
            const status = getStatus(q);
            return (
              <div key={q.quiz_id} className={`tp-quiz-card tp-quiz-card--${status}`}
                onClick={() => { setSelectedId(q.quiz_id); setView("detail"); }}>
                <div className="tp-quiz-card-top">
                  <span className="tp-quiz-card-title">{q.title}</span>
                  <StatusBadge status={status} />
                </div>
                <div className="tp-quiz-card-sub">{q.subject_name}</div>
                <div className="tp-quiz-card-meta">
                  <span>{fmtShort(q.scheduled_start)}</span>
                  <span>{q.question_count} questions</span>
                  <span>{q.total_marks} marks</span>
                  <span>{q.time_limit_minutes} min</span>
                </div>
                {q.join_code && <span className="tp-quiz-card-code">{q.join_code}</span>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  return (
    <div className="tp-page">
      <AppSidebar role={role} pendingOD={0} />
      <div className="tp-main-wrap">
        <header className="tp-topbar">
          <h1 className="tp-topbar-title">Tests & Quizzes</h1>
        </header>
        <main className="tp-main">
          {view === "list"     && renderList()}
          {view === "detail"   && selectedId && (
            <QuizDetail quizId={selectedId} teacherId={teacherId} onBack={handleBack} />
          )}
          {view === "manual"   && (
            <ManualCreate subjects={subjects} teacherId={teacherId}
              onCancel={() => setView("list")}
              onFinalize={(data) => { setFinalizeData(data); setView("finalize"); }} />
          )}
          {view === "ai"       && (
            <AICreate subjects={subjects} teacherId={teacherId}
              onCancel={() => setView("list")}
              onFinalize={(data) => { setFinalizeData(data); setView("finalize"); }} />
          )}
          {view === "finalize" && finalizeData && (
            <FinalizePanel quizData={finalizeData}
              onBack={() => setView(finalizeData.syllabus ? "ai" : "manual")}
              onDone={() => { setView("list"); loadQuizzes(); }} />
          )}
        </main>
      </div>
    </div>
  );
}