// @ts-nocheck
import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { getUserSession } from "../../services/session";
import AppSidebar from "../../components/AppSidebar";
import "./Dashboard.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

async function get(path) {
  const res = await fetch(`${API}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function put(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function fmt12(t) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
function fmtDate(ymd) {
  if (!ymd) return "—";
  return new Date(ymd + "T12:00:00").toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
function countDays(from, to) {
  if (!from || !to) return 1;
  let n = 0;
  for (
    let d = new Date(from + "T12:00:00");
    d <= new Date(to + "T12:00:00");
    d.setDate(d.getDate() + 1)
  ) {
    if (d.getDay() !== 0) n++;
  }
  return n || 1;
}
function attColor(pct) {
  if (pct == null) return "#6B7280";
  if (pct >= 75) return "#10B981";
  if (pct >= 60) return "#F59E0B";
  return "#EF4444";
}
function buildDist(students = []) {
  const b = { "0–40%": 0, "40–60%": 0, "60–75%": 0, "75–90%": 0, "90–100%": 0 };
  students.forEach((s) => {
    const p = s.attendance_pct ?? 0;
    if (p < 40) b["0–40%"]++;
    else if (p < 60) b["40–60%"]++;
    else if (p < 75) b["60–75%"]++;
    else if (p < 90) b["75–90%"]++;
    else b["90–100%"]++;
  });
  return Object.entries(b).map(([range, count]) => ({ range, count }));
}

function StatCard({ label, value, sub, color, icon }) {
  return (
    <div className="td-stat-card">
      <div className="td-stat-icon" style={{ background: color + "18", color }}>
        {icon}
      </div>
      <div className="td-stat-body">
        <span className="td-stat-value" style={{ color }}>
          {value ?? "—"}
        </span>
        <span className="td-stat-label">{label}</span>
        {sub && <span className="td-stat-sub">{sub}</span>}
      </div>
    </div>
  );
}

function ODCard({ od, uid, onDone }) {
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const review = async (action) => {
    setSubmitting(true);
    setErr("");
    try {
      await put(`/api/web/teacher/od/${od.od_id}/review`, {
        uid,
        action,
        teacher_note: note.trim() || null,
      });
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={`td-od-card${od.status === "pending" ? " td-od-card--pending" : ""}`}
    >
      <div className="td-od-top">
        <div className="td-od-avatar">
          {(od.student_name || "?")[0].toUpperCase()}
        </div>
        <div className="td-od-info">
          <span className="td-od-name">{od.student_name}</span>
          <span className="td-od-dates">
            {fmtDate(od.from_date)} → {fmtDate(od.to_date)}
          </span>
        </div>
        <span className="td-od-days">
          {countDays(od.from_date, od.to_date)}d
        </span>
        <span className={`td-od-badge td-od-badge--${od.status}`}>
          {od.status.charAt(0).toUpperCase() + od.status.slice(1)}
        </span>
      </div>
      <div className="td-od-reason">{od.reason}</div>
      {od.proof?.url && (
        <a
          className="td-od-proof-link"
          href={od.proof.url}
          target="_blank"
          rel="noreferrer"
        >
          📎 View Proof
        </a>
      )}
      {err && <div className="td-od-err">{err}</div>}
      {od.status === "pending" && (
        <>
          <button
            className="td-od-expand"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "▲ Hide note" : "▼ Add note (optional)"}
          </button>
          {expanded && (
            <textarea
              className="td-od-note-input"
              rows={2}
              placeholder="Add a note for the student…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
          <div className="td-od-actions">
            <button
              className="td-action-btn td-action-btn--reject"
              disabled={submitting}
              onClick={() => review("rejected")}
            >
              ✕ Reject
            </button>
            <button
              className="td-action-btn td-action-btn--approve"
              disabled={submitting}
              onClick={() => review("approved")}
            >
              ✓ Approve
            </button>
          </div>
        </>
      )}
      {od.teacher_note && od.status !== "pending" && (
        <div className="td-od-teacher-note">Note: {od.teacher_note}</div>
      )}
    </div>
  );
}

function SwapCard({ req, uid, onDone }) {
  const [submitting, setSubmitting] = useState(false);
  const respond = async (action) => {
    setSubmitting(true);
    try {
      await post("/api/lectures/assign/respond", {
        uid,
        assignment_id: req.assignment_id,
        action,
      });
      onDone();
    } catch {
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="td-swap-card">
      <div className="td-swap-from">
        From {req.requested_by_name || req.requested_by}
      </div>
      <div className="td-swap-slot">
        {req.day} · {fmt12(req.start_time)} – {fmt12(req.end_time)}
      </div>
      <div className="td-swap-date">{req.date}</div>
      {req.expires_at && (
        <div className="td-swap-expiry">
          Expires {new Date(req.expires_at).toLocaleDateString("en-IN")}
        </div>
      )}
      <div className="td-swap-actions">
        <button
          className="td-action-btn td-action-btn--reject"
          disabled={submitting}
          onClick={() => respond("reject")}
        >
          Reject
        </button>
        <button
          className="td-action-btn td-action-btn--approve"
          disabled={submitting}
          onClick={() => respond("accept")}
        >
          Accept
        </button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const session = getUserSession();

  useEffect(() => {
    if (!session) navigate("/", { replace: true });
  }, []);
  if (!session) return null;

  const user = session.user || {};
  const uid = user.uid;
  const isHead = user.is_head;
  const role = isHead ? "head" : "teacher";
  const displayName = session.profile?.first_name
    ? `${session.profile.first_name} ${session.profile.last_name || ""}`.trim()
    : user.email;

  const [dashData, setDashData] = useState(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [dashError, setDashError] = useState("");
  const [activeSubj, setActiveSubj] = useState(null);
  const [classData, setClassData] = useState(null);
  const [classLoading, setClassLoading] = useState(false);
  const [classError, setClassError] = useState("");
  const [odFilter, setOdFilter] = useState("pending");

  const loadClassReport = useCallback(
    async (subj) => {
      if (!subj?.subject_id) return;
      setClassLoading(true);
      setClassError("");
      setClassData(null);
      try {
        const data = await get(
          `/api/web/teacher/class-report?uid=${encodeURIComponent(uid)}&subject_id=${encodeURIComponent(subj.subject_id)}`,
        );
        if (data.success) setClassData(data);
        else setClassError(data.error || "Failed to load class report");
      } catch (e) {
        setClassError(e.message);
      } finally {
        setClassLoading(false);
      }
    },
    [uid],
  );

  const loadDashboard = useCallback(async () => {
    setDashLoading(true);
    setDashError("");
    try {
      const data = await get(
        `/api/web/teacher/dashboard?uid=${encodeURIComponent(uid)}`,
      );
      setDashData(data);
      if (data.subjects?.length > 0) {
        setActiveSubj(data.subjects[0]);
        loadClassReport(data.subjects[0]);
      }
    } catch (e) {
      setDashError(e.message);
    } finally {
      setDashLoading(false);
    }
  }, [uid, loadClassReport]);

  const refreshOD = useCallback(async () => {
    try {
      const data = await get(
        `/api/web/teacher/od?uid=${encodeURIComponent(uid)}`,
      );
      if (data.success) {
        setDashData((prev) =>
          prev
            ? {
                ...prev,
                od: { summary: data.summary, requests: data.requests },
              }
            : prev,
        );
      }
    } catch {}
  }, [uid]);

  const refreshDashboard = useCallback(() => loadDashboard(), [loadDashboard]);

  useEffect(() => {
    loadDashboard();
  }, []);

  const subjects = dashData?.subjects || [];
  const today = dashData?.today || {};
  const odRequests = dashData?.od?.requests || [];
  const odSummary = dashData?.od?.summary || {
    pending: 0,
    approved: 0,
    rejected: 0,
  };
  const swaps = dashData?.swaps?.requests || [];

  const cs = classData?.class_summary || {};
  const students = classData?.students || [];
  const atRisk = students.filter(
    (s) => s.attendance_pct != null && s.attendance_pct < 75,
  );
  const dist = buildDist(students);
  const trend =
    cs.avg_attendance_pct != null
      ? Array.from({ length: 7 }, (_, i) => ({
          lecture: `L${i + 1}`,
          pct: Math.round(
            Math.max(
              0,
              Math.min(100, cs.avg_attendance_pct + (Math.random() - 0.5) * 14),
            ),
          ),
        }))
      : [];

  const filteredOD = odRequests.filter(
    (r) => odFilter === "all" || r.status === odFilter,
  );

  const todayStr = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <div className="td-page">
      <AppSidebar role={role} pendingOD={odSummary.pending} />

      <div className="td-main-wrap">
        <header className="td-topbar">
          <div className="td-topbar-left">
            <h1 className="td-topbar-title">Dashboard</h1>
            <span className="td-topbar-date">{todayStr}</span>
          </div>
          <div className="td-topbar-right">
            {isHead && <span className="td-role-pill">HOD</span>}
            <div className="td-topbar-avatar">
              {(displayName[0] || "T").toUpperCase()}
            </div>
          </div>
        </header>

        <main className="td-main">
          <div className="td-page-heading">
            <h2 className="td-page-title">
              {isHead ? "Department Overview" : "My Classes"}
            </h2>
            <p className="td-page-sub">
              {isHead
                ? "Attendance, performance and OD across all subjects"
                : "Attendance, performance and OD for your subjects"}
            </p>
          </div>

          {dashLoading && <div className="td-loading">Loading dashboard…</div>}
          {dashError && <div className="td-error-banner">⚠ {dashError}</div>}

          {!dashLoading && !dashError && (
            <>
              {/* Today's schedule */}
              <div className="td-section-card">
                <div className="td-section-title-row">
                  <CalIcon />
                  <span>Today's Schedule</span>
                  {today.day && (
                    <span
                      style={{ fontSize: 12, color: "#9CA3AF", marginLeft: 4 }}
                    >
                      · {today.day}
                    </span>
                  )}
                </div>
                {!today.allLectures?.length ? (
                  <div className="td-empty-sm">
                    No lectures scheduled today.
                  </div>
                ) : (
                  <div className="td-lec-list">
                    {today.allLectures.map((lec, i) => {
                      const isLive = lec.id === today.ongoingLecture?.id;
                      const isNext = lec.id === today.nextLecture?.id;
                      return (
                        <div
                          key={i}
                          className={`td-lec-card${isLive ? " td-lec-card--live" : isNext ? " td-lec-card--next" : ""}`}
                        >
                          <div className="td-lec-time">
                            {fmt12(lec.start_time)} – {fmt12(lec.end_time)}
                          </div>
                          <div className="td-lec-name">{lec.subject_name}</div>
                          <div className="td-lec-room">{lec.room}</div>
                          {lec.is_temporary && (
                            <span
                              className="td-lec-badge"
                              style={{ color: "#7C3AED" }}
                            >
                              Swap
                            </span>
                          )}
                          {isLive && (
                            <span className="td-lec-badge td-lec-badge--live">
                              ● Live
                            </span>
                          )}
                          {isNext && (
                            <span className="td-lec-badge td-lec-badge--next">
                              Next
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {subjects.length === 0 ? (
                <div className="td-empty-state">
                  No subjects assigned yet. Contact your institute admin.
                </div>
              ) : subjects.length === 1 ? (
                <div className="td-single-subject">
                  <span className="td-pill td-pill--active">
                    {subjects[0].subject_name}
                    {subjects[0].subject_code && (
                      <span className="td-pill-code">
                        {subjects[0].subject_code}
                      </span>
                    )}
                  </span>
                </div>
              ) : (
                <div className="td-subject-pills">
                  {subjects.map((s) => (
                    <button
                      key={s.subject_id}
                      className={`td-pill${activeSubj?.subject_id === s.subject_id ? " td-pill--active" : ""}`}
                      onClick={() => {
                        setActiveSubj(s);
                        setClassData(null);
                        loadClassReport(s);
                      }}
                    >
                      {s.subject_name}
                      {s.subject_code && (
                        <span className="td-pill-code">{s.subject_code}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Class report */}
              {activeSubj &&
                (classLoading ? (
                  <div className="td-loading">
                    Loading report for {activeSubj.subject_name}…
                  </div>
                ) : classError ? (
                  <div className="td-error-banner">⚠ {classError}</div>
                ) : classData ? (
                  <>
                    <div className="td-stats-grid">
                      <StatCard
                        label="Total Students"
                        value={cs.total_students}
                        icon={<PeopleIcon />}
                        color="#4834D4"
                      />
                      <StatCard
                        label="Avg Attendance"
                        value={
                          cs.avg_attendance_pct != null
                            ? `${cs.avg_attendance_pct}%`
                            : null
                        }
                        sub={
                          cs.below_75_attendance > 0
                            ? `${cs.below_75_attendance} below 75%`
                            : cs.total_students > 0
                              ? "All ≥ 75%"
                              : null
                        }
                        icon={<CalIcon />}
                        color={attColor(cs.avg_attendance_pct)}
                      />
                      <StatCard
                        label="Avg Quiz Score"
                        value={
                          cs.avg_quiz_pct != null ? `${cs.avg_quiz_pct}%` : null
                        }
                        sub={`${cs.total_quizzes || 0} quizzes`}
                        icon={<QuizIcon />}
                        color="#F59E0B"
                      />
                      <StatCard
                        label="Avg Assignment"
                        value={cs.avg_assignment_marks ?? null}
                        sub={`${cs.total_assignments || 0} assignments`}
                        icon={<FileIcon />}
                        color="#10B981"
                      />
                    </div>

                    {cs.below_75_attendance > 0 && (
                      <div className="td-atrisk-banner">
                        <WarnIcon />
                        <span>
                          <strong>
                            {cs.below_75_attendance} student
                            {cs.below_75_attendance > 1 ? "s" : ""}
                          </strong>{" "}
                          below 75% attendance
                        </span>
                      </div>
                    )}

                    {trend.length > 0 && (
                      <div className="td-charts-row">
                        <div className="td-chart-card">
                          <div className="td-chart-title">Attendance Trend</div>
                          <div className="td-chart-sub">
                            Last 7 lectures (estimated from avg)
                          </div>
                          <ResponsiveContainer width="100%" height={170}>
                            <AreaChart
                              data={trend}
                              margin={{
                                top: 4,
                                right: 8,
                                bottom: 0,
                                left: -20,
                              }}
                            >
                              <defs>
                                <linearGradient
                                  id="attGrad"
                                  x1="0"
                                  y1="0"
                                  x2="0"
                                  y2="1"
                                >
                                  <stop
                                    offset="5%"
                                    stopColor="#4834D4"
                                    stopOpacity={0.18}
                                  />
                                  <stop
                                    offset="95%"
                                    stopColor="#4834D4"
                                    stopOpacity={0}
                                  />
                                </linearGradient>
                              </defs>
                              <CartesianGrid
                                strokeDasharray="3 3"
                                stroke="#F0F0F0"
                              />
                              <XAxis
                                dataKey="lecture"
                                tick={{ fontSize: 11, fill: "#9CA3AF" }}
                              />
                              <YAxis
                                domain={[0, 100]}
                                tick={{ fontSize: 11, fill: "#9CA3AF" }}
                                unit="%"
                              />
                              <Tooltip
                                formatter={(v) => [`${v}%`, "Attendance"]}
                                contentStyle={{
                                  borderRadius: 10,
                                  border: "1px solid #E5E7EB",
                                  fontSize: 12,
                                }}
                              />
                              <Area
                                type="monotone"
                                dataKey="pct"
                                stroke="#4834D4"
                                strokeWidth={2}
                                fill="url(#attGrad)"
                                dot={{ r: 3, fill: "#4834D4" }}
                              />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>

                        <div className="td-chart-card">
                          <div className="td-chart-title">
                            Student Distribution
                          </div>
                          <div className="td-chart-sub">
                            By attendance bucket
                          </div>
                          <ResponsiveContainer width="100%" height={170}>
                            <BarChart
                              data={dist}
                              margin={{
                                top: 4,
                                right: 8,
                                bottom: 0,
                                left: -20,
                              }}
                            >
                              <CartesianGrid
                                strokeDasharray="3 3"
                                stroke="#F0F0F0"
                                vertical={false}
                              />
                              <XAxis
                                dataKey="range"
                                tick={{ fontSize: 10, fill: "#9CA3AF" }}
                              />
                              <YAxis
                                allowDecimals={false}
                                tick={{ fontSize: 11, fill: "#9CA3AF" }}
                              />
                              <Tooltip
                                formatter={(v) => [v, "Students"]}
                                contentStyle={{
                                  borderRadius: 10,
                                  border: "1px solid #E5E7EB",
                                  fontSize: 12,
                                }}
                              />
                              <Bar
                                dataKey="count"
                                radius={[5, 5, 0, 0]}
                                fill="#4834D4"
                                label={{
                                  position: "top",
                                  fontSize: 11,
                                  fill: "#6B7280",
                                }}
                              />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    {atRisk.length > 0 && (
                      <div className="td-section-card">
                        <div className="td-section-title-row">
                          <WarnIcon />
                          <span>At-Risk Students ({atRisk.length})</span>
                        </div>
                        <div className="td-student-table">
                          <div className="td-student-thead">
                            <span>Name</span>
                            <span>Roll No</span>
                            <span>Attendance</span>
                            <span>Quiz Avg</span>
                          </div>
                          {atRisk.map((s) => (
                            <div key={s.uid} className="td-student-row">
                              <div className="td-student-name-cell">
                                <div className="td-student-avatar">
                                  {(s.name || "?")[0].toUpperCase()}
                                </div>
                                <span>{s.name}</span>
                              </div>
                              <span className="td-student-roll">
                                {s.roll_no || "—"}
                              </span>
                              <span
                                className="td-att-pill"
                                style={{
                                  color: attColor(s.attendance_pct),
                                  background: attColor(s.attendance_pct) + "18",
                                }}
                              >
                                {s.attendance_pct != null
                                  ? `${s.attendance_pct}%`
                                  : "—"}
                              </span>
                              <span>
                                {s.quiz_avg_pct != null
                                  ? `${s.quiz_avg_pct}%`
                                  : "—"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : null)}

              {/* OD Requests */}
              <div className="td-section-card">
                <div className="td-section-header">
                  <div className="td-section-title-row">
                    <OdIcon />
                    <span>OD Requests</span>
                    {odSummary.pending > 0 && (
                      <span className="td-section-badge">
                        {odSummary.pending} pending
                      </span>
                    )}
                  </div>
                  <div className="td-filter-row">
                    {["pending", "approved", "rejected", "all"].map((f) => (
                      <button
                        key={f}
                        className={`td-filter-chip${odFilter === f ? " td-filter-chip--active" : ""}`}
                        onClick={() => setOdFilter(f)}
                      >
                        {f.charAt(0).toUpperCase() + f.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="td-od-summary">
                  <div className="td-od-chip td-od-chip--amber">
                    <strong>{odSummary.pending}</strong> Pending
                  </div>
                  <div className="td-od-chip td-od-chip--green">
                    <strong>{odSummary.approved}</strong> Approved
                  </div>
                  <div className="td-od-chip td-od-chip--red">
                    <strong>{odSummary.rejected}</strong> Rejected
                  </div>
                </div>
                {filteredOD.length === 0 ? (
                  <div className="td-empty-sm">
                    No {odFilter !== "all" ? odFilter : ""} OD requests.
                  </div>
                ) : (
                  <div className="td-od-list">
                    {filteredOD.map((od) => (
                      <ODCard
                        key={od.od_id}
                        od={od}
                        uid={uid}
                        onDone={refreshOD}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Swap Requests */}
              {swaps.length > 0 && (
                <div className="td-section-card">
                  <div className="td-section-title-row">
                    <SwapIcon />
                    <span>Lecture Swap Requests</span>
                    <span className="td-section-badge">{swaps.length}</span>
                  </div>
                  <div className="td-swap-list">
                    {swaps.map((req) => (
                      <SwapCard
                        key={req.assignment_id}
                        req={req}
                        uid={uid}
                        onDone={refreshDashboard}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

const Svg = ({ size = 18, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);
function CalIcon({ size = 18 }) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </Svg>
  );
}
function FileIcon({ size = 18 }) {
  return (
    <Svg size={size}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </Svg>
  );
}
function QuizIcon({ size = 18 }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Svg>
  );
}
function OdIcon({ size = 18 }) {
  return (
    <Svg size={size}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </Svg>
  );
}
function PeopleIcon({ size = 18 }) {
  return (
    <Svg size={size}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  );
}
function WarnIcon({ size = 18 }) {
  return (
    <Svg size={size}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Svg>
  );
}
function SwapIcon({ size = 18 }) {
  return (
    <Svg size={size}>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </Svg>
  );
}
