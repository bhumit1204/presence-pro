// @ts-nocheck
/**
 * ODPage.jsx — Teacher OD Requests management
 *
 * API:
 *  GET /api/web/teacher/od?uid=&status=   → all OD requests for teacher
 *  PUT /api/web/teacher/od/:od_id/review  → { uid, action, teacher_note }
 */
import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getUserSession } from "../../services/session";
import AppSidebar from "../../components/AppSidebar";
import "./ODPage.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

async function get(path) {
  const res = await fetch(`${API}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function put(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function fmtDate(ymd) {
  if (!ymd) return "—";
  return new Date(ymd + "T12:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
function countDays(from, to) {
  if (!from || !to) return 1;
  let n = 0;
  for (let d = new Date(from + "T12:00:00"); d <= new Date(to + "T12:00:00"); d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0) n++;
  }
  return n || 1;
}

function StatusPill({ status }) {
  const MAP = {
    pending:  { label: "Pending",  cls: "od-pill--amber" },
    approved: { label: "Approved", cls: "od-pill--green" },
    rejected: { label: "Rejected", cls: "od-pill--red"   },
  };
  const { label, cls } = MAP[status] || MAP.pending;
  return <span className={`od-pill ${cls}`}>{label}</span>;
}

function ODCard({ od, uid, onDone }) {
  const [note,       setNote]       = useState(od.teacher_note || "");
  const [expanded,   setExpanded]   = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err,        setErr]        = useState("");

  const review = async (action) => {
    setSubmitting(true); setErr("");
    try {
      await put(`/api/web/teacher/od/${od.od_id}/review`, {
        uid, action, teacher_note: note.trim() || null,
      });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setSubmitting(false); }
  };

  const days = countDays(od.from_date, od.to_date);

  return (
    <div className={`od-card${od.status === "pending" ? " od-card--pending" : ""}`}>
      <div className="od-card-header">
        <div className="od-avatar">{(od.student_name || "?")[0].toUpperCase()}</div>
        <div className="od-card-info">
          <span className="od-student-name">{od.student_name}</span>
          <span className="od-date-range">
            {fmtDate(od.from_date)}
            {od.to_date !== od.from_date && ` — ${fmtDate(od.to_date)}`}
            <span className="od-days">{days} day{days > 1 ? "s" : ""}</span>
          </span>
        </div>
        <StatusPill status={od.status} />
      </div>

      <div className="od-reason">{od.reason}</div>

      {od.proof?.url && (
        <a className="od-proof-link" href={od.proof.url} target="_blank" rel="noreferrer">
          View proof document
        </a>
      )}

      {od.status === "pending" && (
        <>
          <button className="od-note-toggle" onClick={() => setExpanded(v => !v)}>
            {expanded ? "Hide note" : "Add a note for student (optional)"}
          </button>
          {expanded && (
            <textarea className="od-note-input" rows={2}
              placeholder="Write a note…"
              value={note} onChange={(e) => setNote(e.target.value)} />
          )}
          {err && <div className="od-err">{err}</div>}
          <div className="od-actions">
            <button className="od-btn od-btn--reject"
              disabled={submitting} onClick={() => review("rejected")}>
              Reject
            </button>
            <button className="od-btn od-btn--approve"
              disabled={submitting} onClick={() => review("approved")}>
              Approve
            </button>
          </div>
        </>
      )}

      {od.status !== "pending" && od.teacher_note && (
        <div className="od-teacher-note">Note: {od.teacher_note}</div>
      )}
    </div>
  );
}

export default function ODPage() {
  const navigate = useNavigate();
  const session  = getUserSession();

  useEffect(() => { if (!session) navigate("/", { replace: true }); }, []);
  if (!session) return null;

  const uid    = session.user?.uid;
  const isHead = session.user?.is_head;
  const role   = isHead ? "head" : "teacher";

  const [requests, setRequests] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState("");
  const [filter,   setFilter]   = useState("pending");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const data = await get(`/api/web/teacher/od?uid=${encodeURIComponent(uid)}`);
      if (data.success) setRequests(data.requests || []);
      else setError(data.error || "Failed");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [uid]);

  useEffect(() => { load(); }, []);

  const summary = {
    pending:  requests.filter((r) => r.status === "pending").length,
    approved: requests.filter((r) => r.status === "approved").length,
    rejected: requests.filter((r) => r.status === "rejected").length,
  };

  const visible = filter === "all" ? requests : requests.filter((r) => r.status === filter);

  return (
    <div className="od-page">
      <AppSidebar role={role} pendingOD={summary.pending} />
      <div className="od-main-wrap">
        <header className="od-topbar">
          <h1 className="od-topbar-title">OD Requests</h1>
        </header>
        <main className="od-main">

          {/* Summary strip */}
          <div className="od-summary-strip">
            <div className="od-sum-item od-sum-item--amber">
              <span className="od-sum-val">{summary.pending}</span>
              <span className="od-sum-label">Pending</span>
            </div>
            <div className="od-sum-item od-sum-item--green">
              <span className="od-sum-val">{summary.approved}</span>
              <span className="od-sum-label">Approved</span>
            </div>
            <div className="od-sum-item od-sum-item--red">
              <span className="od-sum-val">{summary.rejected}</span>
              <span className="od-sum-label">Rejected</span>
            </div>
          </div>

          {/* Filter tabs */}
          <div className="od-filter-tabs">
            {["pending","approved","rejected","all"].map((f) => (
              <button key={f}
                className={`od-filter-tab${filter === f ? " od-filter-tab--active" : ""}`}
                onClick={() => setFilter(f)}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
                {f !== "all" && <span className="od-filter-count">{summary[f] || 0}</span>}
              </button>
            ))}
          </div>

          {error   && <div className="od-error">{error}</div>}
          {loading && <div className="od-loading">Loading…</div>}

          {!loading && !error && (
            visible.length === 0 ? (
              <div className="od-empty">
                No {filter !== "all" ? filter : ""} OD requests.
              </div>
            ) : (
              <div className="od-list">
                {visible.map((od) => (
                  <ODCard key={od.od_id} od={od} uid={uid} onDone={load} />
                ))}
              </div>
            )
          )}
        </main>
      </div>
    </div>
  );
}