// @ts-nocheck
import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getUserSession } from "../../services/session";
import AppSidebar from "../../components/AppSidebar";
import "./SchedulePage.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

async function get(path) {
  const res = await fetch(`${API}${path}`);
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

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const DAY_SHORT = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
};

function fmt12(t) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function toMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// Next occurrence of a day name as YYYY-MM-DD
function nextDateForDay(dayName) {
  const idx = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ].indexOf(dayName);
  const today = new Date();
  let diff = idx - today.getDay();
  if (diff <= 0) diff += 7;
  const d = new Date(today);
  d.setDate(today.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Deterministic colour per subject
const PALETTE = [
  { bg: "#EEF2FF", text: "#4834D4", border: "#C7D2FE" },
  { bg: "#FEF3C7", text: "#B45309", border: "#FDE68A" },
  { bg: "#D1FAE5", text: "#065F46", border: "#6EE7B7" },
  { bg: "#FEE2E2", text: "#991B1B", border: "#FCA5A5" },
  { bg: "#EDE9FE", text: "#6D28D9", border: "#DDD6FE" },
  { bg: "#ECFDF5", text: "#047857", border: "#A7F3D0" },
  { bg: "#FFF7ED", text: "#9A3412", border: "#FED7AA" },
];
function subjectColor(subject_id) {
  if (!subject_id) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < subject_id.length; i++)
    h = (h * 31 + subject_id.charCodeAt(i)) & 0xffffffff;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// ── Assign Modal ──────────────────────────────────────────────────────
function AssignModal({ lecture, uid, onClose, onDone }) {
  const [selectedDay, setSelectedDay] = useState(lecture.day || DAYS[0]);
  const [teachers, setTeachers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const targetDate = nextDateForDay(selectedDay);

  const loadAvailable = useCallback(async () => {
    setLoading(true);
    setError("");
    setTeachers([]);
    setSelected(null);
    try {
      const data = await get(
        `/api/lectures/teachers/available?uid=${encodeURIComponent(uid)}&date=${targetDate}&start_time=${encodeURIComponent(lecture.start_time)}&end_time=${encodeURIComponent(lecture.end_time)}&lecture_id=${lecture.lecture_id || lecture.id}`,
      );
      if (data.success) setTeachers(data.available || []);
      else setError(data.error || "Failed to load available teachers");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [uid, targetDate, lecture]);

  useEffect(() => {
    loadAvailable();
  }, [selectedDay]);

  const handleAssign = async () => {
    if (!selected) return;
    setAssigning(true);
    setError("");
    setSuccess("");
    try {
      const data = await post("/api/lectures/assign", {
        uid,
        lecture_id: lecture.lecture_id || lecture.id,
        assigned_teacher_id: selected.id,
        date: targetDate,
        start_time: lecture.start_time,
        end_time: lecture.end_time,
      });
      if (data.success) {
        setSuccess(`Assigned to ${selected.name}. They'll get a notification.`);
        setTimeout(() => {
          onDone();
          onClose();
        }, 1800);
      } else {
        setError(data.error || "Assignment failed");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setAssigning(false);
    }
  };

  return (
    <div
      className="sc-modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sc-modal">
        {/* Header */}
        <div className="sc-modal-header">
          <div>
            <h3 className="sc-modal-title">Assign Lecture</h3>
            <p className="sc-modal-sub">
              {lecture.subject_name}
              {lecture.course_name && (
                <span className="sc-modal-course">
                  {" "}
                  · {lecture.course_name}
                </span>
              )}
            </p>
            <p className="sc-modal-sub">
              {fmt12(lecture.start_time)} – {fmt12(lecture.end_time)} ·{" "}
              {lecture.room || "No room"}
            </p>
          </div>
          <button className="sc-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Day selector — which occurrence to assign */}
        <div className="sc-modal-section">
          <label className="sc-modal-label">Assign for which occurrence</label>
          <div className="sc-day-chips">
            {DAYS.map((d) => (
              <button
                key={d}
                className={`sc-day-chip${selectedDay === d ? " sc-day-chip--active" : ""}${d !== lecture.day ? " sc-day-chip--other" : ""}`}
                onClick={() => setSelectedDay(d)}
              >
                {DAY_SHORT[d]}
                {d === lecture.day && (
                  <span className="sc-day-chip-regular">regular</span>
                )}
              </button>
            ))}
          </div>
          <p className="sc-modal-date-note">
            Next occurrence: <strong>{targetDate}</strong>
          </p>
        </div>

        {/* Available teachers — backend already checked for conflicts */}
        <div className="sc-modal-section">
          <div className="sc-modal-label-row">
            <label className="sc-modal-label">Available Teachers</label>
            {!loading && teachers.length > 0 && (
              <span className="sc-avail-count">
                {teachers.length} free at this time
              </span>
            )}
          </div>
          {loading ? (
            <div className="sc-modal-loading">
              <span className="sc-spinner" /> Checking who's free on{" "}
              {targetDate}…
            </div>
          ) : teachers.length === 0 ? (
            <div className="sc-modal-empty">
              No teachers free for this slot on {targetDate}.
            </div>
          ) : (
            <div className="sc-teacher-list">
              {teachers.map((t) => (
                <button
                  key={t.id}
                  className={`sc-teacher-row${selected?.id === t.id ? " sc-teacher-row--selected" : ""}`}
                  onClick={() => setSelected(t)}
                >
                  <div className="sc-teacher-avatar">
                    {(t.name || "?")[0].toUpperCase()}
                  </div>
                  <div className="sc-teacher-info">
                    <span className="sc-teacher-name">{t.name}</span>
                    <span className="sc-teacher-desig">
                      {t.designation}
                      {t.department ? ` · ${t.department}` : ""}
                    </span>
                  </div>
                  <div
                    className={`sc-teacher-status${selected?.id === t.id ? " sc-teacher-status--selected" : ""}`}
                  >
                    {selected?.id === t.id ? "✓ Selected" : "Free"}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {error && <div className="sc-modal-error">⚠ {error}</div>}
        {success && <div className="sc-modal-success">✓ {success}</div>}

        <div className="sc-modal-footer">
          <button className="sc-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="sc-btn-assign"
            disabled={!selected || assigning || !!success}
            onClick={handleAssign}
          >
            {assigning
              ? "Sending request…"
              : selected
                ? `Assign to ${selected.name}`
                : "Select a teacher"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────
export default function SchedulePage() {
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

  const [timetable, setTimetable] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeDay, setActiveDay] = useState("Monday");
  const [filterSubj, setFilterSubj] = useState("all");
  const [assignLec, setAssignLec] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await get(
        `/api/web/teacher/timetable?uid=${encodeURIComponent(uid)}`,
      );
      if (data.success) {
        setTimetable(data);
        // Jump to first day with lectures
        const first = DAYS.find((d) => (data.by_day?.[d] || []).length > 0);
        if (first) setActiveDay(first);
      } else {
        setError(data.error || "Failed to load timetable");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [uid]);

  useEffect(() => {
    load();
  }, []);

  const allLectures = timetable?.lectures || [];
  const byDay = timetable?.by_day || {};

  // Build subjects list from lectures
  const subjectMap = {};
  allLectures.forEach((l) => {
    if (l.subject_id)
      subjectMap[l.subject_id] = {
        subject_id: l.subject_id,
        subject_name: l.subject_name,
        subject_code: l.subject_code,
      };
  });
  const subjects = Object.values(subjectMap);

  // Only show Saturday tab if it actually has lectures
  const visibleDays = DAYS.filter(
    (d) => d !== "Saturday" || (byDay["Saturday"] || []).length > 0,
  );

  const normalise = (l) => ({ ...l, lecture_id: l.lecture_id || l.id });

  const dayLectures = (byDay[activeDay] || [])
    .map(normalise)
    .filter((l) => filterSubj === "all" || l.subject_id === filterSubj);

  const hasAny = DAYS.some((d) => (byDay[d] || []).length > 0);
  const dayCount = (d) => (byDay[d] || []).length;

  return (
    <div className="sc-page">
      <AppSidebar role={role} pendingOD={0} />

      <div className="sc-main-wrap">
        <header className="sc-topbar">
          <div className="sc-topbar-left">
            <h1 className="sc-topbar-title">Schedule</h1>
            <span className="sc-topbar-sub">Weekly timetable</span>
          </div>
        </header>

        <main className="sc-main">
          {loading && <div className="sc-loading">Loading timetable…</div>}
          {error && <div className="sc-error">⚠ {error}</div>}

          {!loading && !error && (
            <>
              {/* Subject filter */}
              {subjects.length > 1 && (
                <div className="sc-filter-row">
                  <button
                    className={`sc-filter-chip${filterSubj === "all" ? " sc-filter-chip--active" : ""}`}
                    onClick={() => setFilterSubj("all")}
                  >
                    All subjects
                  </button>
                  {subjects.map((s) => (
                    <button
                      key={s.subject_id}
                      className={`sc-filter-chip${filterSubj === s.subject_id ? " sc-filter-chip--active" : ""}`}
                      onClick={() => setFilterSubj(s.subject_id)}
                    >
                      {s.subject_name}
                      {s.subject_code && (
                        <span className="sc-filter-code">{s.subject_code}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Day tabs — Saturday only shown if it has lectures */}
              <div className="sc-day-tabs">
                {visibleDays.map((d) => {
                  const n = dayCount(d);
                  const isActive = activeDay === d;
                  return (
                    <button
                      key={d}
                      className={`sc-day-tab${isActive ? " sc-day-tab--active" : ""}${n === 0 ? " sc-day-tab--empty" : ""}`}
                      onClick={() => setActiveDay(d)}
                    >
                      <span className="sc-day-tab-full">{d}</span>
                      <span className="sc-day-tab-short">{DAY_SHORT[d]}</span>
                      {n > 0 && (
                        <span
                          className={`sc-day-tab-badge${isActive ? " sc-day-tab-badge--active" : ""}`}
                        >
                          {n}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Content */}
              {!hasAny ? (
                <div className="sc-empty-state">
                  No lectures assigned yet. Contact your institute admin.
                </div>
              ) : dayLectures.length === 0 ? (
                <div className="sc-day-empty">
                  No lectures on {activeDay}
                  {filterSubj !== "all" ? " for this subject" : ""}.
                </div>
              ) : (
                <>
                  <div className="sc-day-summary">
                    <span className="sc-day-title">{activeDay}</span>
                    <span className="sc-day-count">
                      {dayLectures.length} lecture
                      {dayLectures.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {/* Desktop table */}
                  <div className="sc-table-wrap">
                    <table className="sc-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Subject / Class</th>
                          <th>Code</th>
                          <th>Room</th>
                          <th>Duration</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {dayLectures.map((lec) => {
                          const c = subjectColor(lec.subject_id);
                          const dur =
                            lec.start_time && lec.end_time
                              ? toMin(lec.end_time) - toMin(lec.start_time)
                              : null;
                          return (
                            <tr key={lec.lecture_id} className="sc-table-row">
                              <td>
                                <div className="sc-time-cell">
                                  <span className="sc-time-start">
                                    {fmt12(lec.start_time)}
                                  </span>
                                  <span className="sc-time-sep">–</span>
                                  <span className="sc-time-end">
                                    {fmt12(lec.end_time)}
                                  </span>
                                </div>
                              </td>
                              <td>
                                <div className="sc-subj-cell">
                                  <span
                                    className="sc-subj-dot"
                                    style={{ background: c.text }}
                                  />
                                  <div className="sc-subj-info">
                                    <span className="sc-subj-name">
                                      {lec.subject_name}
                                    </span>
                                    {lec.course_name && (
                                      <span className="sc-course-name">
                                        {lec.course_name}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td>
                                {lec.subject_code ? (
                                  <span
                                    className="sc-code-badge"
                                    style={{
                                      background: c.bg,
                                      color: c.text,
                                      borderColor: c.border,
                                    }}
                                  >
                                    {lec.subject_code}
                                  </span>
                                ) : (
                                  <span className="sc-na">—</span>
                                )}
                              </td>
                              <td>
                                <span className="sc-room">
                                  {lec.room || "—"}
                                </span>
                              </td>
                              <td>
                                <span className="sc-dur">
                                  {dur ? `${dur} min` : "—"}
                                </span>
                              </td>
                              <td>
                                <button
                                  className="sc-assign-table-btn"
                                  onClick={() => setAssignLec(lec)}
                                >
                                  <SwapIcon /> Assign
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile cards */}
                  <div className="sc-card-grid">
                    {dayLectures.map((lec) => {
                      const c = subjectColor(lec.subject_id);
                      return (
                        <div
                          key={lec.lecture_id}
                          className="sc-lec-card"
                          style={{ background: c.bg, borderColor: c.border }}
                        >
                          <div
                            className="sc-lec-time"
                            style={{ color: c.text }}
                          >
                            {fmt12(lec.start_time)} – {fmt12(lec.end_time)}
                          </div>
                          <div
                            className="sc-lec-name"
                            style={{ color: c.text }}
                          >
                            {lec.subject_name}
                          </div>
                          {lec.course_name && (
                            <div className="sc-lec-course">
                              {lec.course_name}
                            </div>
                          )}
                          {lec.subject_code && (
                            <div
                              className="sc-lec-code"
                              style={{ color: c.text }}
                            >
                              {lec.subject_code}
                            </div>
                          )}
                          {lec.room && (
                            <div className="sc-lec-room">{lec.room}</div>
                          )}
                          <button
                            className="sc-assign-btn"
                            style={{ color: c.text, borderColor: c.border }}
                            onClick={() => setAssignLec(lec)}
                          >
                            <SwapIcon /> Assign to another teacher
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>

      {assignLec && (
        <AssignModal
          lecture={assignLec}
          uid={uid}
          onClose={() => setAssignLec(null)}
          onDone={load}
        />
      )}
    </div>
  );
}

function SwapIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}
