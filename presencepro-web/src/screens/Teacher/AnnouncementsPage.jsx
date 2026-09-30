// @ts-nocheck
import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getUserSession } from "../../services/session";
import AppSidebar from "../../components/AppSidebar";
import "./AnnouncementsPage.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

async function apiFetch(path, opts = {}) {
  const res  = await fetch(`${API}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
const get  = (p)    => apiFetch(p);
const post = (p, b) => apiFetch(p, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(b) });
const del  = (p)    => apiFetch(p, { method:"DELETE" });

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
}

function targetLabel(b) {
  if (b.target_type === "class")      return `${b.subject_name || "Class"}`;
  if (b.target_type === "group")      return "Group";
  if (b.target_type === "individual") return "Individual";
  return b.target_type || "—";
}

function Toggle({ on, onChange, label, sub }) {
  return (
    <div className="an-toggle-row">
      <div className="an-toggle-info">
        <span className="an-toggle-label">{label}</span>
        {sub && <span className="an-toggle-sub">{sub}</span>}
      </div>
      <button
        type="button"
        className={`an-toggle${on ? " an-toggle--on" : ""}`}
        onClick={() => onChange(!on)}>
        <span className={`an-toggle-knob${on ? " an-toggle-knob--on" : ""}`} />
      </button>
    </div>
  );
}

export default function AnnouncementsPage() {
  const navigate = useNavigate();
  const session  = getUserSession();
  useEffect(() => { if (!session) navigate("/", { replace: true }); }, []);
  if (!session) return null;

  const uid    = session.user?.uid;
  const isHead = session.user?.is_head;
  const role   = isHead ? "head" : "teacher";

  // resolved teacher_id (Firestore doc ID) from timetable endpoint
  const [teacherId,  setTeacherId]  = useState(null);
  const [subjects,   setSubjects]   = useState([]);
  const [broadcasts, setBroadcasts] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState("");
  const [view,       setView]       = useState("list"); // list | create

  // Create form
  const [title,      setTitle]      = useState("");
  const [text,       setText]       = useState("");
  const [targetType, setTargetType] = useState("class");
  const [subjectId,  setSubjectId]  = useState("");
  const [isUrgent,   setIsUrgent]   = useState(false);
  const [attFilter,  setAttFilter]  = useState("none");
  const [saving,     setSaving]     = useState(false);
  const [createErr,  setCreateErr]  = useState("");

  // Load teacher_id and subjects via the web timetable route
  // This returns teacher_id (Firestore doc ID) correctly
  useEffect(() => {
    (async () => {
      try {
        const data = await get(`/api/web/teacher/timetable?uid=${encodeURIComponent(uid)}`);
        if (!data.success) return;
        setTeacherId(data.teacher_id);
        // Build unique subjects map from lectures
        const map = {};
        (data.lectures || []).forEach((l) => {
          if (l.subject_id && !map[l.subject_id]) {
            map[l.subject_id] = {
              subject_id:   l.subject_id,
              subject_name: l.subject_name || l.subject_id,
              subject_code: l.subject_code || null,
              course_id:    l.course_id    || null,
            };
          }
        });
        const subjs = Object.values(map);
        setSubjects(subjs);
        // Default to first subject
        if (subjs.length > 0) setSubjectId(subjs[0].subject_id);
      } catch (e) {
        console.error("Failed to load teacher info:", e);
      }
    })();
  }, [uid]);

  // Load broadcasts once teacher_id is known
  const loadBroadcasts = useCallback(async (tid) => {
    if (!tid) return;
    setLoading(true); setError("");
    try {
      const data = await get(`/api/broadcasts?teacher_id=${encodeURIComponent(tid)}`);
      setBroadcasts(data.broadcasts || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (teacherId) loadBroadcasts(teacherId); }, [teacherId]);

  const resetForm = () => {
    setTitle(""); setText(""); setIsUrgent(false); setAttFilter("none");
    setTargetType("class");
    if (subjects.length > 0) setSubjectId(subjects[0].subject_id);
    setCreateErr("");
  };

  const handleCreate = async () => {
    if (!title.trim())  { setCreateErr("Title is required"); return; }
    if (!text.trim())   { setCreateErr("Message is required"); return; }
    if (targetType === "class" && !subjectId) { setCreateErr("Select a subject"); return; }
    setSaving(true); setCreateErr("");
    try {
      const body = {
        teacher_id:        teacherId,
        title:             title.trim(),
        text:              text.trim(),
        target_type:       targetType,
        is_urgent:         isUrgent,
      };
      if (targetType === "class") {
        body.subject_id        = subjectId;
        body.attendance_filter = attFilter;
      }
      const data = await post("/api/broadcasts", body);
      if (!data.success && data.message !== undefined && data.recipient_count === 0) {
        setCreateErr("No students matched this filter.");
        return;
      }
      resetForm();
      setView("list");
      loadBroadcasts(teacherId);
    } catch (e) { setCreateErr(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (b) => {
    if (!window.confirm(`Delete "${b.title}"?`)) return;
    try {
      await del(`/api/broadcasts/${b.broadcast_id}?teacher_id=${encodeURIComponent(teacherId)}`);
      setBroadcasts((prev) => prev.filter((x) => x.broadcast_id !== b.broadcast_id));
    } catch (e) { alert(e.message); }
  };

  // ── Create form ─────────────────────────────────────────────────────────────
  const renderCreate = () => (
    <div className="an-form-wrap">
      <div className="an-form-header">
        <button className="an-back-btn" onClick={() => { resetForm(); setView("list"); }}>← Back</button>
        <h2 className="an-form-title">New Announcement</h2>
      </div>

      {createErr && <div className="an-error">{createErr}</div>}

      {/* Content */}
      <div className="an-card">
        <label className="an-label">Title *</label>
        <input
          className="an-input"
          placeholder="e.g. Assignment submission reminder"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <label className="an-label">Message *</label>
        <textarea
          className="an-textarea"
          rows={5}
          placeholder="Write your announcement here…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <Toggle
          on={isUrgent}
          onChange={setIsUrgent}
          label="Mark as urgent"
          sub="Urgent announcements appear at the top of student inboxes"
        />
      </div>

      {/* Audience */}
      <div className="an-card">
        <label className="an-label">Send to</label>
        <div className="an-type-row">
          <button
            type="button"
            className={`an-type-btn${targetType === "class" ? " an-type-btn--active" : ""}`}
            onClick={() => setTargetType("class")}>
            Entire Class
          </button>
          <button
            type="button"
            className={`an-type-btn${targetType === "individual" ? " an-type-btn--active" : ""}`}
            onClick={() => setTargetType("individual")}>
            Specific Students
          </button>
        </div>

        {targetType === "class" && (
          <>
            {/* Subject selector — always shown so teacher knows who gets notified */}
            <label className="an-label">Subject / Class</label>
            {subjects.length === 0 ? (
              <div className="an-info-note">No subjects loaded — try refreshing the page.</div>
            ) : (
              <select
                className="an-select"
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
              >
                {subjects.map((s) => (
                  <option key={s.subject_id} value={s.subject_id}>
                    {s.subject_name}{s.subject_code ? ` (${s.subject_code})` : ""}
                  </option>
                ))}
              </select>
            )}

            <label className="an-label">Filter recipients by attendance</label>
            <div className="an-type-row">
              {[
                ["none",      "All students"],
                ["below_75",  "Below 75%"],
                ["below_50",  "Below 50%"],
              ].map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  className={`an-type-btn${attFilter === val ? " an-type-btn--active" : ""}`}
                  onClick={() => setAttFilter(val)}>
                  {lbl}
                </button>
              ))}
            </div>
          </>
        )}

        {targetType === "individual" && (
          <div className="an-info-note">
            Individual student messaging is available on the mobile app. On web, please use "Entire Class" with an attendance filter to target specific groups.
          </div>
        )}
      </div>

      <button
        className="an-submit-btn"
        disabled={saving || targetType === "individual" || !teacherId}
        onClick={handleCreate}
      >
        {saving ? "Sending…" : "Send Announcement"}
      </button>
    </div>
  );

  // ── List view ───────────────────────────────────────────────────────────────
  return (
    <div className="an-page">
      <AppSidebar role={role} pendingOD={0} />
      <div className="an-main-wrap">
        <header className="an-topbar">
          <h1 className="an-topbar-title">Announcements</h1>
          {view === "list" && (
            <button className="an-new-btn" onClick={() => setView("create")}>
              + New Announcement
            </button>
          )}
        </header>

        <main className="an-main">
          {view === "create" && renderCreate()}

          {view === "list" && (
            <>
              {error   && <div className="an-error">{error}</div>}
              {loading && <div className="an-loading">Loading announcements…</div>}

              {!loading && !error && broadcasts.length === 0 && (
                <div className="an-empty">
                  No announcements yet.
                  <br />
                  <span style={{ fontSize:13, color:"#9CA3AF" }}>Click "New Announcement" to notify your students.</span>
                </div>
              )}

              {!loading && !error && broadcasts.length > 0 && (
                <div className="an-list">
                  {broadcasts.map((b) => (
                    <div
                      key={b.broadcast_id}
                      className={`an-item${b.is_urgent ? " an-item--urgent" : ""}`}>
                      <div className="an-item-top">
                        <div className="an-item-title-row">
                          {b.is_urgent && <span className="an-urgent-tag">Urgent</span>}
                          <span className="an-item-title">{b.title}</span>
                        </div>
                        <button
                          className="an-delete-btn"
                          onClick={() => handleDelete(b)}>
                          Delete
                        </button>
                      </div>
                      <div className="an-item-text">{b.text}</div>
                      <div className="an-item-meta">
                        <span>{targetLabel(b)}</span>
                        <span>{b.recipient_count || 0} student{(b.recipient_count || 0) !== 1 ? "s" : ""}</span>
                        <span>{fmtDate(b.created_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}