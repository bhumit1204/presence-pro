// @ts-nocheck
/**
 * ReportsPage.jsx
 *
 * Report types:
 *  attendance_class  → /api/reports/class                         — all students, totals
 *  attendance_student→ /api/reports/student/:uid/full + /attendance — one student
 *  attendance_date   → /api/reports/attendance/by-date             — one date
 *  attendance_range  → /api/reports/student/:uid/attendance + dates— one student, range
 *  quiz              → /api/quizzes/teacher/:tid → /api/quizzes/:id/results — who scored what
 *  assignment        → /api/assignments?subject_id=  → submissions — who submitted/graded
 *
 * Print/PDF: window.print() with @media print CSS — no extra dependency
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { getUserSession } from "../../services/session";
import AppSidebar from "../../components/AppSidebar";
import "./ReportsPage.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

async function get(path) {
  const res  = await fetch(`${API}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtFull(ymd) {
  if (!ymd) return "—";
  return new Date(ymd + "T12:00:00").toLocaleDateString("en-IN", { day:"numeric", month:"long", year:"numeric" });
}
function fmtDatetime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
}
function attColor(pct) {
  if (pct == null) return "#6B7280";
  if (pct >= 75)   return "#059669";
  if (pct >= 60)   return "#D97706";
  return "#DC2626";
}
function statusCls(s) {
  return { present:"rp-s-p", absent:"rp-s-a", late:"rp-s-l", od:"rp-s-od", no_class:"rp-s-nc" }[s] || "rp-s-nc";
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—"; }

// ── Report types ───────────────────────────────────────────────────────────────
const REPORT_TYPES = [
  { key:"att_class",   label:"Class Attendance",  desc:"All students — totals",     needs:[] },
  { key:"att_student", label:"Student Attendance", desc:"One student — full history", needs:["student"] },
  { key:"att_date",    label:"Attendance by Date", desc:"Who was present on a date", needs:["date"] },
  { key:"att_range",   label:"Date Range",         desc:"One student between dates", needs:["student","range"] },
  { key:"quiz",        label:"Quiz Report",        desc:"Who scored what on each quiz", needs:[] },
  { key:"assignment",  label:"Assignment Report",  desc:"Submissions and grades",    needs:[] },
];

// ── Small shared components ────────────────────────────────────────────────────
function SumCard({ label, value, color }) {
  return (
    <div className="rp-sum-card">
      <span className="rp-sum-val" style={color ? { color } : {}}>{value ?? "—"}</span>
      <span className="rp-sum-label">{label}</span>
    </div>
  );
}

// ── REPORT VIEWS (pure display — used both on-page and in print) ───────────────

function AttClassView({ data }) {
  const cs = data.class_summary;
  const students = [...(data.students || [])].sort((a, b) =>
    (a.roll_no || a.name || "").localeCompare(b.roll_no || b.name || "", undefined, { numeric:true })
  );
  if (!students.length) return <p className="rp-empty">No students enrolled.</p>;
  return (
    <>
      <div className="rp-summary-grid">
        <SumCard label="Students"      value={cs.total_students} />
        <SumCard label="Lectures held" value={cs.total_lectures} />
        <SumCard label="Class avg"     value={cs.avg_attendance_pct != null ? `${cs.avg_attendance_pct}%` : "—"} color={attColor(cs.avg_attendance_pct)} />
        <SumCard label="Below 75%"     value={cs.below_75_attendance} color={cs.below_75_attendance > 0 ? "#DC2626" : "#059669"} />
      </div>
      <div className="rp-table-wrap">
        <table className="rp-table">
          <thead><tr><th>Roll</th><th>Student</th><th>Present</th><th>Absent</th><th>%</th><th>Quiz avg</th><th>Assign avg</th></tr></thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.uid} className="rp-tr">
                <td className="rp-td-dim">{s.roll_no || "—"}</td>
                <td className="rp-td-name">{s.name}</td>
                <td>{s.present}</td>
                <td>{s.absent}</td>
                <td><span style={{ fontWeight:700, color:attColor(s.attendance_pct) }}>{s.attendance_pct != null ? `${s.attendance_pct}%` : "—"}</span></td>
                <td>{s.quiz_avg_pct != null ? `${s.quiz_avg_pct}%` : "—"}</td>
                <td>{s.assignment_avg_marks != null ? s.assignment_avg_marks : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rp-legend">
        <span className="rp-leg rp-leg-green">75%+ Safe</span>
        <span className="rp-leg rp-leg-amber">60–75% Warning</span>
        <span className="rp-leg rp-leg-red">Below 60% At risk</span>
      </div>
    </>
  );
}

function AttStudentView({ fullData, attData }) {
  const p   = fullData.profile;
  const qs  = fullData.quiz_summary;
  const as  = fullData.assignment_summary;
  const att = fullData.attendance_summary;
  const records = [...(attData?.records || [])].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <>
      <div className="rp-profile-card">
        <div className="rp-profile-avatar">{(p.name || "?")[0].toUpperCase()}</div>
        <div className="rp-profile-info">
          <div className="rp-profile-name">{p.name}</div>
          <div className="rp-profile-meta">
            {p.roll_no && <span>Roll {p.roll_no}</span>}
            {p.course_name && <span>{p.course_name}</span>}
            {p.semester && <span>{p.semester}</span>}
          </div>
        </div>
      </div>
      <div className="rp-summary-grid">
        <SumCard label="Attendance"     value={att.percentage != null ? `${att.percentage}%` : "—"} color={attColor(att.percentage)} />
        <SumCard label="Classes"        value={`${att.present} / ${att.total_lectures}`} />
        <SumCard label="Quiz avg"       value={qs.avg_percentage != null ? `${qs.avg_percentage}%` : "—"} color="#4834D4" />
        <SumCard label="Quizzes"        value={`${qs.attempted} / ${qs.total}`} />
        <SumCard label="Assign avg"     value={as.avg_marks != null ? as.avg_marks : "—"} color="#059669" />
        <SumCard label="Submitted"      value={`${as.submitted} / ${as.total}`} />
      </div>
      <div className="rp-section-sub">Attendance Record</div>
      {records.length === 0 ? <p className="rp-empty">No records found.</p> : (
        <div className="rp-table-wrap">
          <table className="rp-table">
            <thead><tr><th>Date</th><th>Status</th><th>Marked by</th><th>Note</th></tr></thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={i} className="rp-tr">
                  <td className="rp-td-date">{fmtFull(r.date)}</td>
                  <td><span className={`rp-status-badge ${statusCls(r.status)}`}>{cap(r.status)}</span></td>
                  <td className="rp-td-dim">{r.marked_by || "auto"}</td>
                  <td className="rp-td-dim">{r.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function AttDateView({ data }) {
  const students = [...(data.students || [])].sort((a, b) =>
    (a.roll_no || a.name || "").localeCompare(b.roll_no || b.name || "", undefined, { numeric:true })
  );
  const noClass = students.every((s) => s.status === "no_class");
  const present = students.filter((s) => ["present","late","od"].includes(s.status)).length;
  const absent  = students.filter((s) => s.status === "absent").length;
  return (
    <>
      <div className="rp-date-heading">{fmtFull(data.date)}</div>
      {noClass ? <p className="rp-empty">No lecture on this date.</p> : (
        <>
          <div className="rp-summary-grid">
            <SumCard label="Present"   value={present}          color="#059669" />
            <SumCard label="Absent"    value={absent}           color="#DC2626" />
            <SumCard label="Total"     value={students.length} />
            <SumCard label="Attendance" value={students.length ? `${Math.round(present/students.length*100)}%` : "—"} color={attColor(students.length ? present/students.length*100 : null)} />
          </div>
          <div className="rp-table-wrap">
            <table className="rp-table">
              <thead><tr><th>Roll</th><th>Student</th><th>Status</th><th>Marked by</th></tr></thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.uid} className="rp-tr">
                    <td className="rp-td-dim">{s.roll_no || "—"}</td>
                    <td className="rp-td-name">{s.name}</td>
                    <td><span className={`rp-status-badge ${statusCls(s.status)}`}>{cap(s.status)}</span></td>
                    <td className="rp-td-dim">{s.marked_by || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function AttRangeView({ data, studentName }) {
  const { summary, records } = data;
  const sorted = [...(records || [])].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <>
      {studentName && <div className="rp-date-heading">{studentName}</div>}
      <div className="rp-summary-grid">
        <SumCard label="Classes"    value={summary.total_lectures} />
        <SumCard label="Present"    value={summary.present}  color="#059669" />
        <SumCard label="Absent"     value={summary.absent}   color="#DC2626" />
        <SumCard label="OD / Leave" value={summary.od}       color="#4834D4" />
        <SumCard label="Attendance" value={summary.percentage != null ? `${summary.percentage}%` : "—"} color={attColor(summary.percentage)} />
      </div>
      {sorted.length === 0 ? <p className="rp-empty">No records in this range.</p> : (
        <div className="rp-table-wrap">
          <table className="rp-table">
            <thead><tr><th>Date</th><th>Status</th><th>Marked by</th><th>Note</th></tr></thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={i} className="rp-tr">
                  <td className="rp-td-date">{fmtFull(r.date)}</td>
                  <td><span className={`rp-status-badge ${statusCls(r.status)}`}>{cap(r.status)}</span></td>
                  <td className="rp-td-dim">{r.marked_by || "auto"}</td>
                  <td className="rp-td-dim">{r.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function QuizView({ quizzes }) {
  if (!quizzes.length) return <p className="rp-empty">No quizzes found for this subject.</p>;
  return (
    <>
      {quizzes.map((q) => (
        <div key={q.quiz_id} className="rp-quiz-section">
          <div className="rp-quiz-header">
            <span className="rp-quiz-title">{q.title}</span>
            <span className="rp-quiz-meta">{fmtDatetime(q.scheduled_start)} · {q.total_marks} marks · {q.submissions.length} submitted</span>
          </div>
          {q.submissions.length === 0 ? (
            <p className="rp-empty" style={{ padding:"12px 0" }}>No submissions yet.</p>
          ) : (
            <div className="rp-table-wrap">
              <table className="rp-table">
                <thead>
                  <tr><th>#</th><th>Student</th><th>Score</th><th>Percentage</th><th>Submitted</th></tr>
                </thead>
                <tbody>
                  {[...q.submissions]
                    .sort((a, b) => (b.marks_obtained || 0) - (a.marks_obtained || 0))
                    .map((s, i) => {
                      const pct = s.percentage ?? (q.total_marks > 0 ? Math.round((s.marks_obtained || 0)/q.total_marks*100) : 0);
                      return (
                        <tr key={s.submission_id || i} className="rp-tr">
                          <td className="rp-td-dim">{i + 1}</td>
                          <td className="rp-td-name">{s.student_name || s.student_uid || "—"}</td>
                          <td><strong>{s.marks_obtained}</strong> / {q.total_marks}</td>
                          <td><span style={{ fontWeight:700, color:attColor(pct) }}>{pct}%</span></td>
                          <td className="rp-td-dim">{fmtDatetime(s.submitted_at)}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function AssignmentView({ assignments }) {
  if (!assignments.length) return <p className="rp-empty">No assignments found for this subject.</p>;
  return (
    <>
      {assignments.map((a) => (
        <div key={a.assignment_id} className="rp-quiz-section">
          <div className="rp-quiz-header">
            <span className="rp-quiz-title">{a.title}</span>
            <span className="rp-quiz-meta">Due {fmtFull(a.due_date?.split("T")[0])} · {a.marks} marks · {a.submissions.length} submitted</span>
          </div>
          {a.submissions.length === 0 ? (
            <p className="rp-empty" style={{ padding:"12px 0" }}>No submissions yet.</p>
          ) : (
            <div className="rp-table-wrap">
              <table className="rp-table">
                <thead>
                  <tr><th>Student</th><th>Status</th><th>Score</th><th>Submitted</th></tr>
                </thead>
                <tbody>
                  {a.submissions.map((s, i) => (
                    <tr key={s.submission_id || i} className="rp-tr">
                      <td className="rp-td-name">{s.student_name || s.student_uid || "—"}</td>
                      <td><span className={`rp-status-badge ${s.status === "graded" ? "rp-s-p" : "rp-s-od"}`}>{cap(s.status)}</span></td>
                      <td>{s.marks_obtained != null ? `${s.marks_obtained} / ${a.marks}` : "—"}</td>
                      <td className="rp-td-dim">{fmtDatetime(s.submitted_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// ── Student Search ─────────────────────────────────────────────────────────────
function StudentSearch({ teacherId, subjectId, value, onSelect, onClear }) {
  const [query,    setQuery]    = useState(value?.name || "");
  const [results,  setResults]  = useState([]);
  const [searching,setSearching]= useState(false);
  const timer = useRef(null);

  useEffect(() => { if (!value) setQuery(""); }, [value]);

  const search = (q) => {
    setQuery(q);
    if (value) onClear();
    clearTimeout(timer.current);
    if (!q.trim()) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await get(`/api/reports/students/search?teacher_id=${encodeURIComponent(teacherId)}&subject_id=${encodeURIComponent(subjectId)}&query=${encodeURIComponent(q)}`);
        setResults(data.students || []);
      } catch {}
      finally { setSearching(false); }
    }, 350);
  };

  const pick = (s) => { setQuery(s.name); setResults([]); onSelect(s); };

  return (
    <div className="rp-student-search">
      <input className="rp-param-input" placeholder="Name or roll number…" value={query} onChange={(e) => search(e.target.value)} />
      {searching && <div className="rp-searching">Searching…</div>}
      {results.length > 0 && !value && (
        <div className="rp-student-results">
          {results.map((s) => (
            <button key={s.uid} className="rp-student-result" onClick={() => pick(s)}>
              <span className="rp-sr-name">{s.name}</span>
              {s.roll_no && <span className="rp-sr-roll">Roll {s.roll_no}</span>}
            </button>
          ))}
        </div>
      )}
      {value && (
        <div className="rp-selected-student">
          <span className="rp-sel-name">{value.name}{value.roll_no ? ` (Roll ${value.roll_no})` : ""}</span>
          <button className="rp-clear-student" onClick={() => { onClear(); setQuery(""); }}>Change</button>
        </div>
      )}
    </div>
  );
}

// ── Print modal ────────────────────────────────────────────────────────────────
function PrintModal({ title, subject, onClose, children }) {
  const printRef = useRef();

  const doPrint = () => {
    const content = printRef.current?.innerHTML;
    if (!content) return;
    const win = window.open("", "_blank");
    win.document.write(`<!DOCTYPE html>
<html><head>
<title>${title}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; color: #111; margin: 20px; }
  h1   { font-size: 16px; margin-bottom: 2px; }
  h2   { font-size: 13px; color: #555; margin-bottom: 12px; font-weight: normal; }
  .rp-summary-grid { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:14px; }
  .rp-sum-card  { border:1px solid #ddd; border-radius:6px; padding:10px 14px; min-width:100px; }
  .rp-sum-val   { font-size:18px; font-weight:700; display:block; }
  .rp-sum-label { font-size:11px; color:#555; }
  .rp-table-wrap { overflow:auto; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th    { background:#f5f5f5; border:1px solid #ddd; padding:7px 10px; text-align:left; font-size:11px; text-transform:uppercase; }
  td    { border:1px solid #ddd; padding:7px 10px; }
  tr:nth-child(even) td { background:#fafafa; }
  .rp-status-badge { font-size:11px; font-weight:700; padding:2px 7px; border-radius:4px; }
  .rp-s-p  { background:#d1fae5; color:#065f46; }
  .rp-s-a  { background:#fee2e2; color:#991b1b; }
  .rp-s-l  { background:#fef3c7; color:#92400e; }
  .rp-s-od { background:#eef2ff; color:#4834d4; }
  .rp-s-nc { background:#f3f4f6; color:#9ca3af; }
  .rp-profile-card { display:flex; align-items:center; gap:12px; border:1px solid #eee; border-radius:8px; padding:12px; margin-bottom:14px; }
  .rp-profile-avatar { width:40px; height:40px; border-radius:50%; background:#eef2ff; color:#4834d4; font-size:16px; font-weight:700; display:flex; align-items:center; justify-content:center; }
  .rp-profile-name { font-size:15px; font-weight:700; }
  .rp-profile-meta { font-size:12px; color:#555; display:flex; gap:12px; margin-top:4px; }
  .rp-quiz-section { border:1px solid #eee; border-radius:8px; padding:12px; margin-bottom:14px; }
  .rp-quiz-header { margin-bottom:8px; }
  .rp-quiz-title  { font-size:14px; font-weight:700; display:block; }
  .rp-quiz-meta   { font-size:11px; color:#777; }
  .rp-section-sub { font-size:13px; font-weight:700; margin:12px 0 8px; }
  .rp-date-heading{ font-size:14px; font-weight:700; margin-bottom:12px; }
  .rp-legend { display:flex; gap:16px; font-size:11px; color:#555; margin-top:8px; }
  .rp-leg::before { content:"■ "; }
  .rp-leg-green { color:#059669; }
  .rp-leg-amber { color:#D97706; }
  .rp-leg-red   { color:#DC2626; }
  .rp-empty { color:#9ca3af; font-size:12px; padding:8px 0; }
  @media print {
    body { margin: 0; }
    button { display:none; }
    .no-print { display:none; }
  }
</style>
</head><body>
<h1>${title}</h1>
<h2>${subject}</h2>
${content}
<div style="margin-top:20px;font-size:10px;color:#aaa">Generated on ${new Date().toLocaleString("en-IN")} — PresencePro</div>
</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
  };

  return (
    <div className="rp-print-overlay">
      <div className="rp-print-modal">
        {/* Toolbar */}
        <div className="rp-print-toolbar">
          <div className="rp-print-toolbar-title">{title}</div>
          <div className="rp-print-toolbar-actions">
            <button className="rp-print-btn" onClick={doPrint}>Print / Save as PDF</button>
            <button className="rp-print-close" onClick={onClose}>Close</button>
          </div>
        </div>
        {/* Preview */}
        <div className="rp-print-preview">
          <div className="rp-print-paper" ref={printRef}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const navigate = useNavigate();
  const session  = getUserSession();
  useEffect(() => { if (!session) navigate("/", { replace: true }); }, []);
  if (!session) return null;

  const uid    = session.user?.uid;
  const isHead = session.user?.is_head;
  const role   = isHead ? "head" : "teacher";

  const [teacherId,       setTeacherId]       = useState(null);
  const [subjects,        setSubjects]        = useState([]);
  const [activeSubj,      setActiveSubj]      = useState(null);
  const [reportType,      setReportType]      = useState("att_class");
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState("");
  const [result,          setResult]          = useState(null);
  const [printOpen,       setPrintOpen]       = useState(false);

  const [selectedStudent,    setSelectedStudent]    = useState(null);
  const [singleDate,         setSingleDate]         = useState("");
  const [fromDate,           setFromDate]           = useState("");
  const [toDate,             setToDate]             = useState("");

  // Quiz / assignment pickers
  const [quizList,           setQuizList]           = useState([]);   // [{ quiz_id, title, scheduled_start, total_marks }]
  const [assignmentList,     setAssignmentList]     = useState([]);   // [{ assignment_id, title, due_date, marks }]
  const [selectedQuizId,     setSelectedQuizId]     = useState("all");
  const [selectedAssignmentId, setSelectedAssignmentId] = useState("all");
  const [listLoading,        setListLoading]        = useState(false);

  // Load teacher + subjects from timetable
  useEffect(() => {
    (async () => {
      try {
        const data = await get(`/api/web/teacher/timetable?uid=${encodeURIComponent(uid)}`);
        if (!data.success) return;
        setTeacherId(data.teacher_id);
        const map = {};
        (data.lectures || []).forEach((l) => {
          if (l.subject_id && !map[l.subject_id])
            map[l.subject_id] = { subject_id:l.subject_id, subject_name:l.subject_name, subject_code:l.subject_code, course_id:l.course_id };
        });
        const subjs = Object.values(map);
        setSubjects(subjs);
        if (subjs.length) setActiveSubj(subjs[0]);
      } catch (e) { console.error(e); }
    })();
  }, [uid]);

  const switchType = (t) => {
    setReportType(t); setResult(null); setError("");
    setSelectedStudent(null); setSingleDate(""); setFromDate(""); setToDate("");
    setSelectedQuizId("all"); setSelectedAssignmentId("all");
  };
  const switchSubject = (s) => {
    setActiveSubj(s); setResult(null); setSelectedStudent(null); setError("");
    setSelectedQuizId("all"); setSelectedAssignmentId("all");
    setQuizList([]); setAssignmentList([]);
  };

  // Auto-load quiz or assignment list when type or subject changes
  useEffect(() => {
    if (!teacherId || !activeSubj) return;
    const tid = teacherId;
    const sid = activeSubj.subject_id;
    const cid = activeSubj.course_id || "";

    if (reportType === "quiz") {
      setListLoading(true);
      get(`/api/quizzes/teacher/${encodeURIComponent(tid)}`)
        .then((d) => {
          const filtered = (d.quizzes || [])
            .filter((q) => q.subject_id === sid)
            .sort((a, b) => new Date(b.scheduled_start) - new Date(a.scheduled_start));
          setQuizList(filtered);
        })
        .catch(() => setQuizList([]))
        .finally(() => setListLoading(false));
    }

    if (reportType === "assignment") {
      setListLoading(true);
      get(`/api/assignments?subject_id=${encodeURIComponent(sid)}&course_id=${encodeURIComponent(cid)}`)
        .then((d) => {
          const sorted = (d.assignments || [])
            .sort((a, b) => new Date(b.due_date) - new Date(a.due_date));
          setAssignmentList(sorted);
        })
        .catch(() => setAssignmentList([]))
        .finally(() => setListLoading(false));
    }
  }, [reportType, activeSubj, teacherId]);

  // ── Generate ──────────────────────────────────────────────────────────────
  const generate = async () => {
    if (!teacherId || !activeSubj) { setError("Still loading — please wait."); return; }
    const tid = teacherId;
    const sid = activeSubj.subject_id;
    const cid = activeSubj.course_id || "";

    if (reportType === "att_student" && !selectedStudent) { setError("Select a student."); return; }
    if (reportType === "att_date"    && !singleDate)       { setError("Select a date."); return; }
    if (reportType === "att_range") {
      if (!selectedStudent) { setError("Select a student."); return; }
      if (!fromDate || !toDate) { setError("Select both dates."); return; }
      if (fromDate > toDate)    { setError("From date must be before to date."); return; }
    }

    setLoading(true); setError(""); setResult(null);
    try {
      switch (reportType) {

        case "att_class": {
          const data = await get(`/api/reports/class?teacher_id=${encodeURIComponent(tid)}&subject_id=${encodeURIComponent(sid)}`);
          setResult({ type:"att_class", data });
          break;
        }

        case "att_student": {
          const suid = selectedStudent.uid;
          const [fullData, attData] = await Promise.all([
            get(`/api/reports/student/${suid}/full?teacher_id=${encodeURIComponent(tid)}&subject_id=${encodeURIComponent(sid)}`),
            get(`/api/reports/student/${suid}/attendance?teacher_id=${encodeURIComponent(tid)}&subject_id=${encodeURIComponent(sid)}`),
          ]);
          setResult({ type:"att_student", fullData, attData, studentName: selectedStudent.name });
          break;
        }

        case "att_date": {
          const data = await get(`/api/reports/attendance/by-date?teacher_id=${encodeURIComponent(tid)}&subject_id=${encodeURIComponent(sid)}&date=${singleDate}`);
          setResult({ type:"att_date", data });
          break;
        }

        case "att_range": {
          const suid = selectedStudent.uid;
          const data = await get(`/api/reports/student/${suid}/attendance?teacher_id=${encodeURIComponent(tid)}&subject_id=${encodeURIComponent(sid)}&from_date=${fromDate}&to_date=${toDate}`);
          setResult({ type:"att_range", data, studentName: selectedStudent.name });
          break;
        }

        case "quiz": {
          const listData = await get(`/api/quizzes/teacher/${encodeURIComponent(tid)}`);
          const allQuizzes = (listData.quizzes || []).filter((q) => q.subject_id === sid);
          // Either fetch one quiz or all quizzes for this subject
          const toFetch = selectedQuizId === "all"
            ? allQuizzes.slice(0, 10)
            : allQuizzes.filter((q) => q.quiz_id === selectedQuizId);
          if (!toFetch.length) { setError("No quiz found. Try selecting a different quiz."); setLoading(false); return; }
          const withResults = await Promise.all(
            toFetch.map(async (q) => {
              try {
                const res = await get(`/api/quizzes/${q.quiz_id}/results?teacher_id=${encodeURIComponent(tid)}`);
                return { ...q, submissions: res.submissions || [] };
              } catch { return { ...q, submissions: [] }; }
            })
          );
          const selectedTitle = selectedQuizId !== "all"
            ? withResults[0]?.title
            : null;
          setResult({ type:"quiz", quizzes: withResults, selectedTitle });
          break;
        }

        case "assignment": {
          const listData = await get(`/api/assignments?subject_id=${encodeURIComponent(sid)}&course_id=${encodeURIComponent(cid)}`);
          const allAssignments = listData.assignments || [];
          const toFetch = selectedAssignmentId === "all"
            ? allAssignments.slice(0, 10)
            : allAssignments.filter((a) => a.assignment_id === selectedAssignmentId);
          if (!toFetch.length) { setError("No assignment found."); setLoading(false); return; }
          const withSubs = await Promise.all(
            toFetch.map(async (a) => {
              try {
                const res = await get(`/api/assignments/${a.assignment_id}/submissions?teacher_id=${encodeURIComponent(tid)}`);
                return { ...a, submissions: res.submissions || [] };
              } catch { return { ...a, submissions: [] }; }
            })
          );
          const selectedTitle = selectedAssignmentId !== "all"
            ? withSubs[0]?.title
            : null;
          setResult({ type:"assignment", assignments: withSubs, selectedTitle });
          break;
        }
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  // ── Derive print title ───────────────────────────────────────────────────
  const printTitle = () => {
    const t = REPORT_TYPES.find((t) => t.key === reportType);
    const extra = result?.studentName   ? ` — ${result.studentName}`
                : result?.selectedTitle ? ` — ${result.selectedTitle}`
                : result?.data?.date    ? ` — ${fmtFull(result.data.date)}`
                : "";
    return `${t?.label || "Report"}${extra}`;
  };

  const needs = REPORT_TYPES.find((t) => t.key === reportType)?.needs || [];

  // ── Report content (shared between page and print modal) ─────────────────
  const ReportContent = () => {
    if (!result) return null;
    if (result.type === "att_class")   return <AttClassView data={result.data} />;
    if (result.type === "att_student") return <AttStudentView fullData={result.fullData} attData={result.attData} />;
    if (result.type === "att_date")    return <AttDateView data={result.data} />;
    if (result.type === "att_range")   return <AttRangeView data={result.data} studentName={result.studentName} />;
    if (result.type === "quiz")        return <QuizView quizzes={result.quizzes} />;
    if (result.type === "assignment")  return <AssignmentView assignments={result.assignments} />;
    return null;
  };

  return (
    <div className="rp-page">
      <AppSidebar role={role} pendingOD={0} />
      <div className="rp-main-wrap">
        <header className="rp-topbar">
          <h1 className="rp-topbar-title">Reports</h1>
        </header>

        <main className="rp-main">

          {/* Subject pills */}
          {subjects.length > 0 && (
            <div className="rp-subject-row">
              <span className="rp-subject-label">Subject</span>
              <div className="rp-subject-pills">
                {subjects.map((s) => (
                  <button key={s.subject_id}
                    className={`rp-subj-pill${activeSubj?.subject_id === s.subject_id ? " rp-subj-pill--active" : ""}`}
                    onClick={() => switchSubject(s)}>
                    {s.subject_name}
                    {s.subject_code && <span className="rp-subj-code">{s.subject_code}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Report type grid — 2 groups: Attendance & Performance */}
          <div className="rp-type-group-label">Attendance</div>
          <div className="rp-type-grid">
            {REPORT_TYPES.filter((t) => t.key.startsWith("att")).map((t) => (
              <button key={t.key}
                className={`rp-type-card${reportType === t.key ? " rp-type-card--active" : ""}`}
                onClick={() => switchType(t.key)}>
                <span className="rp-type-label">{t.label}</span>
                <span className="rp-type-desc">{t.desc}</span>
              </button>
            ))}
          </div>

          <div className="rp-type-group-label">Performance</div>
          <div className="rp-type-grid rp-type-grid--2">
            {REPORT_TYPES.filter((t) => !t.key.startsWith("att")).map((t) => (
              <button key={t.key}
                className={`rp-type-card${reportType === t.key ? " rp-type-card--active" : ""}`}
                onClick={() => switchType(t.key)}>
                <span className="rp-type-label">{t.label}</span>
                <span className="rp-type-desc">{t.desc}</span>
              </button>
            ))}
          </div>

          {/* Params */}
          <div className="rp-params-card">

            {needs.includes("student") && teacherId && activeSubj && (
              <div className="rp-param-group">
                <label className="rp-param-label">Student *</label>
                <StudentSearch
                  teacherId={teacherId}
                  subjectId={activeSubj.subject_id}
                  value={selectedStudent}
                  onSelect={setSelectedStudent}
                  onClear={() => setSelectedStudent(null)}
                />
              </div>
            )}

            {needs.includes("date") && (
              <div className="rp-param-group">
                <label className="rp-param-label">Date *</label>
                <input type="date" className="rp-param-input rp-param-input--date"
                  value={singleDate} onChange={(e) => setSingleDate(e.target.value)} />
              </div>
            )}

            {needs.includes("range") && (
              <div className="rp-param-group">
                <label className="rp-param-label">Date Range *</label>
                <div className="rp-date-range-row">
                  <div className="rp-date-field">
                    <label className="rp-param-sublabel">From</label>
                    <input type="date" className="rp-param-input rp-param-input--date"
                      value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
                  </div>
                  <div className="rp-date-field">
                    <label className="rp-param-sublabel">To</label>
                    <input type="date" className="rp-param-input rp-param-input--date"
                      value={toDate} onChange={(e) => setToDate(e.target.value)} />
                  </div>
                </div>
              </div>
            )}

            {!needs.length && !["quiz","assignment"].includes(reportType) && (
              <div className="rp-param-note">
                No filters needed — click Generate to load the full class report.
              </div>
            )}

            {/* Quiz picker */}
            {reportType === "quiz" && (
              <div className="rp-param-group">
                <label className="rp-param-label">Quiz</label>
                {listLoading ? (
                  <div className="rp-param-note">Loading quizzes…</div>
                ) : quizList.length === 0 ? (
                  <div className="rp-param-note">No quizzes found for this subject.</div>
                ) : (
                  <select
                    className="rp-param-select"
                    value={selectedQuizId}
                    onChange={(e) => { setSelectedQuizId(e.target.value); setResult(null); }}>
                    <option value="all">All quizzes ({quizList.length})</option>
                    {quizList.map((q) => (
                      <option key={q.quiz_id} value={q.quiz_id}>
                        {q.title}
                        {q.scheduled_start ? ` — ${fmtFull(q.scheduled_start.slice(0,10))}` : ""}
                        {` (${q.total_marks} marks)`}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* Assignment picker */}
            {reportType === "assignment" && (
              <div className="rp-param-group">
                <label className="rp-param-label">Assignment</label>
                {listLoading ? (
                  <div className="rp-param-note">Loading assignments…</div>
                ) : assignmentList.length === 0 ? (
                  <div className="rp-param-note">No assignments found for this subject.</div>
                ) : (
                  <select
                    className="rp-param-select"
                    value={selectedAssignmentId}
                    onChange={(e) => { setSelectedAssignmentId(e.target.value); setResult(null); }}>
                    <option value="all">All assignments ({assignmentList.length})</option>
                    {assignmentList.map((a) => (
                      <option key={a.assignment_id} value={a.assignment_id}>
                        {a.title}
                        {a.due_date ? ` — Due ${fmtFull(a.due_date.slice(0,10))}` : ""}
                        {` (${a.marks} marks)`}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {error && <div className="rp-error">{error}</div>}

            <button className="rp-generate-btn"
              disabled={loading || !teacherId || !activeSubj}
              onClick={generate}>
              {loading ? "Loading…" : "Generate Report"}
            </button>
          </div>

          {/* Result on-page */}
          {result && (
            <div className="rp-result-section">
              <div className="rp-result-topbar">
                <div className="rp-result-heading">
                  {activeSubj?.subject_name}
                  {result.studentName    && ` — ${result.studentName}`}
                  {result.selectedTitle  && ` — ${result.selectedTitle}`}
                  {result.data?.date     && ` — ${fmtFull(result.data.date)}`}
                </div>
                <button className="rp-print-trigger" onClick={() => setPrintOpen(true)}>
                  Print / Download PDF
                </button>
              </div>
              <ReportContent />
            </div>
          )}

        </main>
      </div>

      {/* Print modal */}
      {printOpen && result && (
        <PrintModal
          title={printTitle()}
          subject={activeSubj?.subject_name || ""}
          onClose={() => setPrintOpen(false)}>
          <ReportContent />
        </PrintModal>
      )}
    </div>
  );
}