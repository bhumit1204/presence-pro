// @ts-nocheck
/**
 * StudentReportsPage.jsx — Manage → Student Reports (head only)
 *
 * One report for a single student, a class (course + semester) or the whole
 * department. It covers attendance (per subject), quizzes, assignments and OD
 * requests, can be limited to a period, printed, or downloaded as CSV.
 *
 * API: GET /reports?scope=&student_id=&course_id=&semester=&from=&to=&threshold=
 *      GET /students?course_id=&semester=&q=&limit=   (student picker)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ManageShell from "../../../components/ManageShell";
import { headApi } from "../../../services/headApi";
import "./StudentReportsPage.css";

const fmt = (iso) => (iso ? new Date(String(iso).slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const pctText = (n) => (n === null || n === undefined ? "—" : `${n}%`);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

const SCOPES = [
  { value: "department", label: "Whole department" },
  { value: "class", label: "A class" },
  { value: "student", label: "One student" },
];

const STATUS_TEXT = {
  attempted: "Attempted", missed: "Missed", upcoming: "Upcoming", pending: "Not due yet",
  submitted: "Submitted", late: "Submitted late", graded: "Graded",
  approved: "Approved", rejected: "Rejected",
};

// ── CSV ──────────────────────────────────────────────────────────────────────
const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (arr) => arr.map(csvCell).join(",");

function buildCsv(rep) {
  const lines = [];
  lines.push(csvLine([rep.college_name || "", "Student report"]));
  lines.push(csvLine(["Report for", rep.label]));
  lines.push(csvLine(["Period", rep.from || rep.to ? `${rep.from ? fmt(rep.from) : "start"} to ${rep.to ? fmt(rep.to) : fmt(rep.as_on)}` : `all time, as on ${fmt(rep.as_on)}`]));
  lines.push("");
  if (rep.scope === "student") {
    const s = rep.students[0];
    lines.push(csvLine(["Student", s.name, "Roll", s.roll_no, "Class", `${s.course_abbr} Sem ${s.semester}`]));
    lines.push(csvLine(["Overall attendance", pctText(s.attendance.pct), `${s.attendance.attended}/${s.attendance.total} lectures`]));
    lines.push("");
    lines.push("ATTENDANCE");
    lines.push(csvLine(["Code", "Subject", "Attended", "Total lectures", "Attendance %"]));
    s.detail.forEach((d) => lines.push(csvLine([d.subject_code, d.subject_name, d.attendance.attended, d.attendance.total, d.attendance.pct ?? ""])));
    lines.push("", "QUIZZES");
    lines.push(csvLine(["Subject", "Quiz", "Date", "Marks", "Out of", "%", "Status"]));
    s.detail.forEach((d) => d.quizzes.forEach((q) => lines.push(csvLine([d.subject_code, q.title, q.date || "", q.marks_obtained ?? "", q.total_marks, q.percentage ?? "", STATUS_TEXT[q.status] || q.status]))));
    lines.push("", "ASSIGNMENTS");
    lines.push(csvLine(["Subject", "Assignment", "Due", "Marks", "Out of", "%", "Status", "Feedback"]));
    s.detail.forEach((d) => d.assignments.forEach((a) => lines.push(csvLine([d.subject_code, a.title, a.due_date || "", a.marks_obtained ?? "", a.max_marks, a.percentage ?? "", STATUS_TEXT[a.status] || a.status, a.feedback || ""]))));
    lines.push("", "OD REQUESTS");
    lines.push(csvLine(["Subject", "From", "To", "Status", "Reason"]));
    s.detail.forEach((d) => d.od.forEach((o) => lines.push(csvLine([d.subject_code, o.from_date, o.to_date, STATUS_TEXT[o.status] || o.status, o.reason]))));
  } else {
    const subs = rep.subjects || [];
    lines.push(csvLine(["Roll no", "Name", "Class", "Attendance %", "Lectures attended", "Lectures held",
      ...subs.map((x) => `${x.subject_code} %`),
      "Quizzes attempted", "Quizzes missed", "Quiz avg %", "Assignments submitted", "Assignments late", "Assignments missed", "Assignment avg %", "OD requests", "OD approved"]));
    rep.students.forEach((s) => lines.push(csvLine([
      s.roll_no, s.name, `${s.course_abbr} Sem ${s.semester}${s.division ? ` ${s.division}` : ""}`, s.attendance.pct ?? "", s.attendance.attended, s.attendance.total,
      ...subs.map((x) => (s.per_subject[x.subject_id]?.pct ?? "")),
      s.quizzes.attempted, s.quizzes.missed, s.quizzes.avg_pct ?? "", s.assignments.submitted, s.assignments.late, s.assignments.missed, s.assignments.avg_pct ?? "", s.od.total, s.od.approved,
    ])));
  }
  return lines.join("\r\n");
}

function download(name, text) {
  const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── small views ──────────────────────────────────────────────────────────────
function Pct({ value, threshold }) {
  if (value === null || value === undefined) return <span className="rp-na">—</span>;
  return <span className={value < threshold ? "rp-low" : "rp-ok"}>{value}%</span>;
}

const BADGE = { attempted: "green", graded: "green", approved: "green", submitted: "blue", late: "amber", pending: "grey", upcoming: "amber", missed: "red", rejected: "red" };
function Status({ value }) {
  return <span className={`rp-badge rp-badge--${BADGE[value] || "grey"}`}>{STATUS_TEXT[value] || value}</span>;
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className={`rp-stat${tone ? ` rp-stat--${tone}` : ""}`}>
      <div className="rp-stat-value">{value}</div>
      <div className="rp-stat-label">{label}</div>
      {sub && <div className="rp-stat-sub">{sub}</div>}
    </div>
  );
}

function StudentDetail({ s, threshold }) {
  return (
    <div className="rp-detail">
      <div className="rp-who">
        <div>
          <div className="rp-who-name">{s.name}</div>
          <div className="rp-who-meta">Roll {s.roll_no || "—"} · {s.course_abbr} · Semester {s.semester ?? "—"}{s.email ? ` · ${s.email}` : ""}</div>
        </div>
      </div>

      <div className="rp-stats">
        <Stat label="Attendance" value={<Pct value={s.attendance.pct} threshold={threshold} />} sub={`${s.attendance.attended} of ${s.attendance.total} lectures`} tone={s.attendance.pct !== null && s.attendance.pct < threshold ? "bad" : "green"} />
        <Stat label="Quiz average" value={pctText(s.quizzes.avg_pct)} sub={`${s.quizzes.attempted} attempted · ${s.quizzes.missed} missed`} tone="primary" />
        <Stat label="Assignments" value={`${s.assignments.submitted}/${s.assignments.submitted + s.assignments.missed}`} sub={`${s.assignments.late} late · ${s.assignments.missed} missed${s.assignments.avg_pct !== null ? ` · avg ${s.assignments.avg_pct}%` : ""}`} tone="amber" />
        <Stat label="OD requests" value={s.od.total} sub={`${s.od.approved} approved · ${s.od.pending} pending`} tone="primary" />
      </div>
      {s.attendance.pct !== null && (
        <div className={`rp-verdict rp-verdict--${s.attendance.pct >= threshold ? "ok" : s.attendance.pct >= 50 ? "warn" : "bad"}`}>
          {s.attendance.pct >= threshold ? `✓ Attendance is satisfactory (${threshold}% or more)` : s.attendance.pct >= 50 ? `⚠ Attendance is below ${threshold}% — improvement needed` : "✗ Critical attendance — immediate action required"}
        </div>
      )}

      <h4 className="rp-h">Attendance Report</h4>
      <div className="rp-wrap">
        <table className="rp-table">
          <thead><tr><th>Subject</th><th className="rp-num">Attended</th><th className="rp-num">Lectures held</th><th className="rp-num">Attendance</th></tr></thead>
          <tbody>
            {s.detail.map((d) => (
              <tr key={d.subject_id}>
                <td><strong>{d.subject_code}</strong> {d.subject_name}</td>
                <td className="rp-num">{d.attendance.attended}</td>
                <td className="rp-num">{d.attendance.total}</td>
                <td className="rp-num"><Pct value={d.attendance.pct} threshold={threshold} /></td>
              </tr>
            ))}
            {!s.detail.length && <tr><td colSpan={4} className="rp-empty-row">No subjects found for this student.</td></tr>}
          </tbody>
        </table>
      </div>

      <h4 className="rp-h">Quiz Performance</h4>
      <Listing rows={s.detail.flatMap((d) => d.quizzes.map((q) => ({ ...q, subject: d.subject_code })))} empty="No quizzes in this period."
        cols={[["Subject", (r) => r.subject], ["Quiz", (r) => r.title], ["Date", (r) => fmt(r.date)], ["Marks", (r) => (r.marks_obtained === null ? "—" : `${r.marks_obtained} / ${r.total_marks}`), "num"], ["%", (r) => pctText(r.percentage), "num"], ["Status", (r) => <Status value={r.status} />]]} />

      <h4 className="rp-h">Assignment Report</h4>
      <Listing rows={s.detail.flatMap((d) => d.assignments.map((a) => ({ ...a, subject: d.subject_code })))} empty="No assignments in this period."
        cols={[["Subject", (r) => r.subject], ["Assignment", (r) => r.title], ["Due", (r) => fmt(r.due_date)], ["Marks", (r) => (r.marks_obtained === null ? "—" : `${r.marks_obtained} / ${r.max_marks}`), "num"], ["%", (r) => pctText(r.percentage), "num"], ["Status", (r) => <Status value={r.status} />], ["Feedback", (r) => r.feedback || ""]]} />

      <h4 className="rp-h">OD Requests</h4>
      <Listing rows={s.detail.flatMap((d) => d.od.map((o) => ({ ...o, subject: d.subject_code })))} empty="No OD requests in this period."
        cols={[["Subject", (r) => r.subject], ["From", (r) => fmt(r.from_date)], ["To", (r) => fmt(r.to_date)], ["Status", (r) => <Status value={r.status} />], ["Reason", (r) => r.reason]]} />
    </div>
  );
}

function Listing({ rows, cols, empty }) {
  return (
    <div className="rp-wrap">
      <table className="rp-table">
        <thead><tr>{cols.map(([h, , k]) => <th key={h} className={k === "num" ? "rp-num" : ""}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{cols.map(([h, f, k]) => <td key={h} className={k === "num" ? "rp-num" : ""}>{f(r)}</td>)}</tr>)}
          {!rows.length && <tr><td colSpan={cols.length} className="rp-empty-row">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function DetailDialog({ query, onClose }) {
  const [state, setState] = useState({ loading: true, error: "", rep: null });
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    let live = true;
    headApi.get(`/reports?${query}`)
      .then((rep) => live && setState({ loading: false, error: "", rep }))
      .catch((err) => live && setState({ loading: false, error: err.message, rep: null }));
    return () => { live = false; };
  }, [query]);
  const rep = state.rep;
  return (
    <div className="mg-modal-overlay rp-noprint" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mg-modal mg-modal--wide rp-dialog" role="dialog" aria-modal="true" aria-label="Student report">
        <div className="mg-modal-header">
          <div>
            <h3 className="mg-modal-title">Student report</h3>
            {rep && <p className="mg-modal-sub">{rep.from || rep.to ? `${rep.from ? fmt(rep.from) : "Start"} – ${fmt(rep.to || rep.as_on)}` : `All time, as on ${fmt(rep.as_on)}`}</p>}
          </div>
          <button type="button" className="mg-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="mg-modal-body">
          {state.loading && <div className="mg-loading">Loading report…</div>}
          {state.error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {state.error}</span></div>}
          {rep && <StudentDetail s={rep.students[0]} threshold={rep.threshold} />}
        </div>
        <div className="mg-modal-footer">
          {rep && <button type="button" className="mg-btn" onClick={() => download(`report-${(rep.students[0].roll_no || rep.students[0].name).toString().replace(/\W+/g, "_")}.csv`, buildCsv(rep))}>Download CSV</button>}
          <button type="button" className="mg-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function StudentReportsPage() {
  const [ctx, setCtx] = useState(null);
  const [ctxError, setCtxError] = useState("");
  const [scope, setScope] = useState("department");
  const [courseId, setCourseId] = useState("");
  const [semester, setSemester] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [threshold, setThreshold] = useState(75);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState([]);
  const [picked, setPicked] = useState(null);
  const [rep, setRep] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sort, setSort] = useState("roll");
  const [onlyLow, setOnlyLow] = useState(false);
  const [detail, setDetail] = useState(null);
  const [divisions, setDivisions] = useState([]);
  const [divisionId, setDivisionId] = useState(""); // "" = all, "none" = no division, else id
  const seq = useRef(0);

  useEffect(() => {
    headApi.get("/context").then((d) => { setCtx(d); setCourseId(d.courses[0]?.course_id || ""); }).catch((e) => setCtxError(e.message));
  }, []);

  const course = ctx?.courses.find((c) => c.course_id === courseId);
  const semCount = scope === "department"
    ? Math.max(1, ...(ctx?.courses || []).map((c) => Number(c.total_semesters) || 0))
    : Number(course?.total_semesters) || 1;

  // divisions of the chosen course (class scope only)
  useEffect(() => {
    setDivisionId("");
    if (scope !== "class" || !courseId) { setDivisions([]); return; }
    let live = true;
    headApi.get(`/divisions?course_id=${encodeURIComponent(courseId)}`)
      .then((d) => live && setDivisions(d.divisions || []))
      .catch(() => live && setDivisions([]));
    return () => { live = false; };
  }, [scope, courseId]);
  useEffect(() => { setDivisionId(""); }, [semester]);
  const semDivisions = divisions.filter((d) => String(d.semester) === String(semester));

  // student picker
  useEffect(() => {
    if (scope !== "student" || picked) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ limit: "8" });
        if (courseId) qs.set("course_id", courseId);
        if (semester) qs.set("semester", semester);
        if (q.trim()) qs.set("q", q.trim());
        const d = await headApi.get(`/students?${qs}`);
        if (mine === seq.current) setHits(d.students || []);
      } catch { if (mine === seq.current) setHits([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [scope, courseId, semester, q, picked]);

  const needsSemester = scope === "class";
  const canRun = scope === "department" || (scope === "class" && courseId && semester) || (scope === "student" && picked);

  const queryString = (extra = {}) => {
    const p = new URLSearchParams({ scope, threshold: String(threshold), ...extra });
    if (scope === "class") { p.set("course_id", courseId); p.set("semester", semester); if (divisionId) p.set("division_id", divisionId); }
    if (scope === "department" && semester) p.set("semester", semester);
    if (scope === "student") p.set("student_id", picked.student_id);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p.toString();
  };

  const generate = async () => {
    setLoading(true); setError(""); setRep(null);
    try { setRep(await headApi.get(`/reports?${queryString()}`)); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const rows = useMemo(() => {
    if (!rep || rep.scope === "student") return [];
    let list = [...rep.students];
    if (onlyLow) list = list.filter((s) => s.attendance.pct !== null && s.attendance.pct < rep.threshold);
    const by = {
      roll: null,
      name: (a, b) => a.name.localeCompare(b.name),
      att: (a, b) => (a.attendance.pct ?? 101) - (b.attendance.pct ?? 101),
      quiz: (a, b) => (a.quizzes.avg_pct ?? 101) - (b.quizzes.avg_pct ?? 101),
    }[sort];
    if (by) list.sort(by);
    return list;
  }, [rep, sort, onlyLow]);

  const sm = rep?.summary;
  const periodText = rep ? (rep.from || rep.to ? `${rep.from ? fmt(rep.from) : "Start of records"} to ${fmt(rep.to || rep.as_on)}` : `All records, up to ${fmt(rep.as_on)}`) : "";
  const showSubjects = rep?.scope === "class" && (rep.subjects || []).length > 0;

  const reset = (s) => { setScope(s); setRep(null); setError(""); setPicked(null); setQ(""); };

  return (
    <ManageShell
      title="Student Reports"
      subtitle="Attendance, quizzes, assignments and OD for a student, a class or the whole department."
      actions={rep && (
        <>
          <button className="mg-btn" onClick={() => window.print()}>Print</button>
          <button className="mg-btn" onClick={() => download(`student-report-${rep.scope}-${rep.as_on}.csv`, buildCsv(rep))}>Download CSV</button>
        </>
      )}
    >
      {ctxError && <div className="mg-banner mg-banner--error rp-noprint" role="alert"><span className="mg-banner-text">⚠ {ctxError}</span></div>}

      <section className="rp-form rp-noprint" aria-label="Report options">
        <div className="rp-seg" role="tablist" aria-label="Report for">
          {SCOPES.map((s) => (
            <button key={s.value} type="button" role="tab" aria-selected={scope === s.value} className={`rp-seg-btn${scope === s.value ? " rp-seg-btn--on" : ""}`} onClick={() => reset(s.value)}>{s.label}</button>
          ))}
        </div>

        <div className="rp-grid">
          {scope !== "department" && (
            <div className="mg-field">
              <label className="mg-label" htmlFor="rp-course">Course</label>
              <select id="rp-course" className="mg-input" value={courseId} onChange={(e) => { setCourseId(e.target.value); setPicked(null); setRep(null); }}>
                {scope === "student" && <option value="">All courses</option>}
                {(ctx?.courses || []).map((c) => <option key={c.course_id} value={c.course_id}>{c.abbr}{c.course_name ? ` · ${c.course_name}` : ""}</option>)}
              </select>
            </div>
          )}
          <div className="mg-field">
            <label className="mg-label" htmlFor="rp-sem">Semester{scope !== "class" && <span className="mg-help"> (optional)</span>}</label>
            <select id="rp-sem" className="mg-input" value={semester} onChange={(e) => { setSemester(e.target.value); setPicked(null); setRep(null); }}>
              <option value="">{needsSemester ? "Choose…" : "All semesters"}</option>
              {Array.from({ length: semCount }, (_, i) => <option key={i + 1} value={i + 1}>Semester {i + 1}</option>)}
            </select>
          </div>
          {scope === "class" && semDivisions.length > 0 && (
            <div className="mg-field">
              <label className="mg-label" htmlFor="rp-div">Division <span className="mg-help">(optional)</span></label>
              <select id="rp-div" className="mg-input" value={divisionId} onChange={(e) => { setDivisionId(e.target.value); setRep(null); }}>
                <option value="">All divisions</option>
                {semDivisions.map((d) => <option key={d.division_id} value={d.division_id}>Division {d.name}</option>)}
                <option value="none">No division yet</option>
              </select>
            </div>
          )}
          <div className="mg-field">
            <label className="mg-label" htmlFor="rp-from">From <span className="mg-help">(optional)</span></label>
            <input id="rp-from" type="date" className="mg-input" max={to || undefined} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="mg-field">
            <label className="mg-label" htmlFor="rp-to">Till <span className="mg-help">(optional)</span></label>
            <input id="rp-to" type="date" className="mg-input" min={from || undefined} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="mg-field">
            <label className="mg-label" htmlFor="rp-th">Flag attendance below (%)</label>
            <input id="rp-th" type="number" min={1} max={100} className="mg-input" value={threshold} onChange={(e) => setThreshold(Math.min(100, Math.max(1, Number(e.target.value) || 75)))} />
          </div>
        </div>

        {scope === "student" && (
          <div className="mg-field">
            <label className="mg-label" htmlFor="rp-q">Student</label>
            {picked ? (
              <div className="rp-picked">
                <span><strong>{picked.name}</strong> · Roll {picked.roll_no || "—"} · Sem {picked.semester ?? "—"}</span>
                <button type="button" className="mg-btn" onClick={() => { setPicked(null); setRep(null); }}>Change</button>
              </div>
            ) : (
              <>
                <input id="rp-q" className="mg-input" value={q} placeholder="Search by name, roll number or email" onChange={(e) => setQ(e.target.value)} autoComplete="off" />
                <ul className="rp-hits" aria-label="Matching students">
                  {hits.map((h) => (
                    <li key={h.student_id}>
                      <button type="button" onClick={() => setPicked(h)}>
                        <strong>{h.name}</strong><span>Roll {h.roll_no || "—"} · {h.degree || ""} Sem {h.semester ?? "—"}</span>
                      </button>
                    </li>
                  ))}
                  {!hits.length && <li className="rp-hits-empty">No students match.</li>}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="rp-run">
          <button type="button" className="mg-btn mg-btn--primary" disabled={!canRun || loading} onClick={generate}>{loading ? "Generating…" : "Generate report"}</button>
          {!canRun && <span className="mg-help">{scope === "class" ? "Choose a course and semester." : "Search and pick a student."}</span>}
        </div>
      </section>

      {error && <div className="mg-banner mg-banner--error rp-noprint" role="alert"><span className="mg-banner-text">⚠ {error}</span><button className="mg-banner-action" onClick={generate}>Retry</button></div>}
      {loading && <div className="mg-loading rp-noprint">Working out attendance, quizzes and assignments…</div>}

      {rep && (
        <section className="rp-paper" aria-label="Report">
          <style>{`@page { size: ${rep.scope === "student" ? "A4 portrait" : "A4 landscape"}; margin: 8mm; }`}</style>
          <header className="rp-banner" aria-hidden="true">
            {rep.college_name && <div className="rp-banner-college">{rep.college_name}</div>}
            <div className="rp-banner-title">Student Academic Report</div>
            <div className="rp-banner-sub">Generated on {fmt(rep.as_on)}</div>
            <div className="rp-banner-meta">
              <div><span>{rep.scope === "student" ? "Student" : rep.scope === "class" ? "Class" : "Department"}</span><strong>{rep.label}</strong></div>
              <div><span>Period</span><strong>{periodText}</strong></div>
              <div><span>Attendance flag</span><strong>below {rep.threshold}%</strong></div>
              {rep.scope !== "student" && <div><span>Students</span><strong>{rep.summary.students}</strong></div>}
            </div>
          </header>
          <header className="rp-paper-head">
            {rep.college_name && <h2 className="rp-college">{rep.college_name}</h2>}
            <div className="rp-doc">STUDENT REPORT</div>
            <dl className="rp-facts">
              <div><dt>Report for</dt><dd>{rep.label}</dd></div>
              <div><dt>Period</dt><dd>{periodText}</dd></div>
              <div><dt>Attendance flag</dt><dd>below {rep.threshold}%</dd></div>
              <div className="rp-print-only"><dt>Printed on</dt><dd>{fmt(rep.as_on)}</dd></div>
            </dl>
          </header>

          {rep.students.length === 0 && <div className="mg-empty"><div className="mg-empty-title">No students found</div>Nothing to report for this selection.</div>}

          {rep.scope === "student" && rep.students[0] && <StudentDetail s={rep.students[0]} threshold={rep.threshold} />}

          {rep.scope !== "student" && rep.students.length > 0 && (
            <>
              <div className="rp-stats">
                <Stat label="Students" value={sm.students} tone="primary" />
                <Stat label="Average attendance" value={pctText(sm.avg_attendance)} sub={`${sm.below_threshold} below ${rep.threshold}%`} tone={sm.below_threshold ? "bad" : "green"} />
                <Stat label="Quiz average" value={pctText(sm.avg_quiz_pct)} sub={sm.quiz_attempt_rate !== null ? `${sm.quiz_attempt_rate}% attempted` : "no quizzes"} tone="green" />
                <Stat label="Assignments submitted" value={pctText(sm.assignment_submit_rate)} sub={sm.avg_assignment_pct !== null ? `avg grade ${sm.avg_assignment_pct}%` : "none graded"} tone="amber" />
                <Stat label="OD requests" value={sm.od_requests} tone="primary" />
              </div>

              <div className="rp-tools rp-noprint">
                <label className="rp-tool">Sort by
                  <select className="mg-input" value={sort} onChange={(e) => setSort(e.target.value)}>
                    <option value="roll">Roll number</option><option value="name">Name</option>
                    <option value="att">Attendance (lowest first)</option><option value="quiz">Quiz average (lowest first)</option>
                  </select>
                </label>
                <label className="rp-check"><input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> Only below {rep.threshold}% attendance</label>
                <span className="mg-help">{plural(rows.length, "student")} shown · click a name for the full report</span>
              </div>

              <div className="rp-wrap">
                <table className="rp-table rp-main">
                  <thead>
                    <tr>
                      <th>Roll</th><th>Name</th>{rep.scope === "department" && <th>Class</th>}{rep.scope === "class" && rep.students.some((x) => x.division) && <th>Div</th>}
                      <th className="rp-num">Attendance</th>
                      {showSubjects && rep.subjects.map((x) => <th key={x.subject_id} className="rp-num rp-sub" title={x.subject_name}>{x.subject_code}</th>)}
                      <th className="rp-num">Quizzes</th><th className="rp-num">Assignments</th><th className="rp-num">OD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.student_id}>
                        <td>{s.roll_no || "—"}</td>
                        <td><button type="button" className="rp-link rp-noprint-link" onClick={() => setDetail(s)}>{s.name}</button><span className="rp-print-name">{s.name}</span></td>
                        {rep.scope === "department" && <td>{s.course_abbr} · S{s.semester ?? "?"}{s.division ? ` · ${s.division}` : ""}</td>}
                        {rep.scope === "class" && rep.students.some((x) => x.division) && <td>{s.division || "—"}</td>}
                        <td className="rp-num"><Pct value={s.attendance.pct} threshold={rep.threshold} /><small>{s.attendance.attended}/{s.attendance.total}</small></td>
                        {showSubjects && rep.subjects.map((x) => <td key={x.subject_id} className="rp-num rp-sub"><Pct value={s.per_subject[x.subject_id]?.pct ?? null} threshold={rep.threshold} /></td>)}
                        <td className="rp-num">{pctText(s.quizzes.avg_pct)}<small>{s.quizzes.attempted}/{s.quizzes.attempted + s.quizzes.missed} taken</small></td>
                        <td className="rp-num">{s.assignments.submitted}/{s.assignments.submitted + s.assignments.missed}<small>{s.assignments.avg_pct !== null ? `avg ${s.assignments.avg_pct}%` : s.assignments.late ? `${s.assignments.late} late` : ""}</small></td>
                        <td className="rp-num">{s.od.total || "—"}</td>
                      </tr>
                    ))}
                    {!rows.length && <tr><td colSpan={9} className="rp-empty-row">No student matches the filter.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <footer className="rp-footer" aria-hidden="true">
            <span>PresencePro Academic Report System</span>
            <span>Confidential — For Institutional Use Only</span>
          </footer>
        </section>
      )}

      {!rep && !loading && !error && (
        <div className="mg-empty rp-noprint">
          <div className="mg-empty-title">Choose what to report on</div>
          Pick the whole department, a class, or a single student — then “Generate report”.
        </div>
      )}

      {detail && <DetailDialog query={queryString({ scope: "student", student_id: detail.student_id })} onClose={() => setDetail(null)} />}
    </ManageShell>
  );
}