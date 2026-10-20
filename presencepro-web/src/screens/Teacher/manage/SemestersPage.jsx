// @ts-nocheck
/**
 * SemestersPage.jsx — Head ▸ Manage ▸ Semesters
 *
 * Semester dates RECUR every year, so the head enters only a day and a month
 * (e.g. "1 Jul" → "15 Dec"). The server works out the real dates of this
 * year's run (or the next one) from that, and any later feature that needs
 * them (reports, promotion at semester end…) does the same.
 *
 * API (via headApi, Bearer ID token):
 *   GET /api/web/head/context                         → { courses[], today, head }
 *   GET /api/web/head/semesters?course_id=            → { semesters[] }
 *   PUT /api/web/head/semesters/:course_id/:semester  → { start:"MM-DD", end:"MM-DD", also_semesters?:[3] }
 *                                                       ← { semester, updated[], warnings[] }
 *
 * Route: /dashboard/teacher/manage/semesters  (wrap in <ProtectedRoute role="head">)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ManageShell from "../../../components/ManageShell";
import { headApi } from "../../../services/headApi";
import "./SemestersPage.css";

// ── date helpers (calendar-day maths in UTC so time zones can't shift a day) ──
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb 29 allowed
const pad = (n) => String(n).padStart(2, "0");

const ymdToUtc = (s) => {
  const [y, m, d] = String(s).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const diffDays = (a, b) => Math.round((ymdToUtc(b) - ymdToUtc(a)) / 86400000);
const addDays = (s, n) => new Date(ymdToUtc(s) + n * 86400000).toISOString().slice(0, 10);
const fmtDate = (s) =>
  s
    ? new Date(s + "T12:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "—";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// "MM-DD" helpers
const fmtMD = (md) => (md ? `${parseInt(md.slice(3), 10)} ${MONTHS[parseInt(md.slice(0, 2), 10) - 1]}` : "—");
const toMD = (m, d) => `${pad(m)}-${pad(d)}`;
const nextDayMD = (md) => addDays(`2024-${md}`, 1).slice(5);
const wrapsYear = (s, e) => e < s;
const spanDays = (s, e) => {
  const start = `2025-${s}`;
  const end = `${wrapsYear(s, e) ? 2026 : 2025}-${e}`;
  return diffDays(start, end) + 1;
};
const doy = (md) => diffDays("2025-01-01", `2025-${md === "02-29" ? "02-28" : md}`) + 1;
const intervals = (s, e) => (wrapsYear(s, e) ? [[doy(s), 365], [1, doy(e)]] : [[doy(s), doy(e)]]);
const windowsOverlap = (aS, aE, bS, bE) =>
  intervals(aS, aE).some(([a1, a2]) => intervals(bS, bE).some(([b1, b2]) => a1 <= b2 && b1 <= a2));

const semName = (s) => `Semester ${s.semester}`;

const STATUS = {
  active:   { label: "In progress",   cls: "mg-badge--green" },
  upcoming: { label: "Upcoming",      cls: "mg-badge--amber" },
  not_set:  { label: "Dates not set", cls: "mg-badge--muted" },
};

// ── Semester card ────────────────────────────────────────────────────────────
function SemesterCard({ sem, today, onEdit }) {
  const meta = STATUS[sem.status] || STATUS.not_set;
  const hasDates = !!(sem.start_md && sem.end_md);
  const run = sem.run;
  const runLen = run ? diffDays(run.start_date, run.end_date) + 1 : 0;

  let line = null;
  let pct = 0;
  if (run && today) {
    if (sem.status === "active") {
      const done = diffDays(run.start_date, today) + 1;
      pct = Math.min(100, Math.max(0, Math.round((done / runLen) * 100)));
      line = `Day ${done} of ${runLen} · ${plural(Math.max(0, runLen - done), "day")} left`;
    } else {
      line = `Starts in ${plural(diffDays(today, run.start_date), "day")}`;
    }
  }

  return (
    <div className={`sm-card sm-card--${sem.status}`}>
      <div className="sm-card-top">
        <h3 className="sm-card-title">{semName(sem)}</h3>
        <span className={`mg-badge ${meta.cls}`}>{meta.label}</span>
      </div>

      {hasDates ? (
        <>
          <div className="sm-term">Repeats every year</div>
          <div className="sm-dates">
            <div className="sm-date">
              <span className="sm-date-label">Starts</span>
              <span className="sm-date-val">{fmtMD(sem.start_md)}</span>
            </div>
            <span className="sm-date-arrow" aria-hidden="true">→</span>
            <div className="sm-date">
              <span className="sm-date-label">Ends</span>
              <span className="sm-date-val">{fmtMD(sem.end_md)}</span>
            </div>
          </div>
          <div className="sm-meta">
            {plural(Math.round(sem.length_days / 7), "week")} · {plural(sem.length_days, "day")}
            {sem.wraps && <span className="sm-chip">Crosses New Year</span>}
          </div>

          {run && (
            <div className="sm-run">
              <span className="sm-run-label">{sem.status === "active" ? "This run" : "Next run"}</span>
              <span className="sm-run-val">{fmtDate(run.start_date)} – {fmtDate(run.end_date)}</span>
            </div>
          )}
          {sem.status === "active" && (
            <div className="sm-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="sm-progress-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
          {line && <div className="sm-line">{line}</div>}
          {sem.status === "upcoming" && sem.previous_run && today && (
            <div className="sm-meta">Last run ended {plural(diffDays(sem.previous_run.end_date, today), "day")} ago</div>
          )}
        </>
      ) : (
        <div className="sm-unset">No start or end has been set for this semester yet.</div>
      )}

      <button className={`mg-btn mg-btn--sm ${hasDates ? "" : "mg-btn--primary"}`} onClick={() => onEdit(sem)}>
        {hasDates ? "Edit dates" : "Set dates"}
      </button>
    </div>
  );
}

// ── Day + month picker ───────────────────────────────────────────────────────
function MDPicker({ idPrefix, label, month, day, onChange, disabled, autoFocusRef }) {
  const maxDay = month ? DAYS_IN[month - 1] : 31;
  return (
    <div className="mg-field">
      <span className="mg-label" id={`${idPrefix}-label`}>{label}</span>
      <div className="sm-md-row" role="group" aria-labelledby={`${idPrefix}-label`}>
        <select
          id={`${idPrefix}-month`}
          ref={autoFocusRef}
          className="mg-input"
          aria-label={`${label} month`}
          value={month}
          disabled={disabled}
          onChange={(e) => {
            const m = e.target.value ? Number(e.target.value) : "";
            onChange(m, m && day && day > DAYS_IN[m - 1] ? DAYS_IN[m - 1] : day);
          }}
        >
          <option value="">Month</option>
          {MONTHS_FULL.map((name, i) => (
            <option key={name} value={i + 1}>{name}</option>
          ))}
        </select>
        <select
          id={`${idPrefix}-day`}
          className="mg-input"
          aria-label={`${label} day`}
          value={day}
          disabled={disabled}
          onChange={(e) => onChange(month, e.target.value ? Number(e.target.value) : "")}
        >
          <option value="">Day</option>
          {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ── Edit modal ───────────────────────────────────────────────────────────────
function SemesterModal({ course, sem, all, onClose, onSaved }) {
  // Semesters of the same term (1 & 3, 2 & 4…) are different cohorts running together
  const peers = all.filter((s) => s.semester !== sem.semester && s.semester % 2 === sem.semester % 2);

  // Starting values: this semester's own → a peer's → day after the previous semester ends
  const seed = (() => {
    if (sem.start_md && sem.end_md) return { s: sem.start_md, e: sem.end_md };
    const peer = peers.find((p) => p.start_md && p.end_md);
    if (peer) return { s: peer.start_md, e: peer.end_md };
    const prev = all.find((p) => p.semester === sem.semester - 1 && p.end_md);
    return { s: prev ? nextDayMD(prev.end_md) : "", e: "" };
  })();
  const split = (md) => (md ? { m: parseInt(md.slice(0, 2), 10), d: parseInt(md.slice(3), 10) } : { m: "", d: "" });

  const [sm, setSm] = useState(split(seed.s).m);
  const [sd, setSd] = useState(split(seed.s).d);
  const [em, setEm] = useState(split(seed.e).m);
  const [ed, setEd] = useState(split(seed.e).d);
  const [applyPeers, setApplyPeers] = useState(
    peers.length > 0 && peers.every((p) => !p.start_md || (p.start_md === seed.s && p.end_md === seed.e)),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const firstRef = useRef(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  const start = sm && sd ? toMD(sm, sd) : "";
  const end = em && ed ? toMD(em, ed) : "";
  const valid = !!start && !!end && start !== end;
  const same = !!start && start === end;
  const length = valid ? spanDays(start, end) : 0;

  const covered = [sem.semester, ...(applyPeers ? peers.map((p) => p.semester) : [])];
  const replaced = applyPeers && valid ? peers.filter((p) => p.start_md && (p.start_md !== start || p.end_md !== end)) : [];
  const overlaps = valid
    ? all
        .filter((s) => !covered.includes(s.semester) && s.semester % 2 !== sem.semester % 2 && s.start_md && s.end_md)
        .filter((s) => windowsOverlap(start, end, s.start_md, s.end_md))
        .map((s) => `${semName(s)} (${fmtMD(s.start_md)} – ${fmtMD(s.end_md)})`)
    : [];

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await headApi.put(`/semesters/${course.course_id}/${sem.semester}`, {
        start,
        end,
        also_semesters: applyPeers ? peers.map((p) => p.semester) : undefined,
      });
      onSaved(res);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <form className="mg-modal" role="dialog" aria-modal="true" aria-labelledby="sm-modal-title" onSubmit={submit}>
        <div className="mg-modal-header">
          <div>
            <h3 className="mg-modal-title" id="sm-modal-title">
              {sem.start_md ? "Edit" : "Set"} dates · {semName(sem)}
            </h3>
            <p className="mg-modal-sub">{course.course_name || course.abbr}</p>
          </div>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={saving} aria-label="Close">✕</button>
        </div>

        <div className="mg-modal-body">
          <p className="sm-modal-note">
            Enter the usual day and month — no year. These dates repeat automatically every year.
          </p>

          <MDPicker idPrefix="sm-start" label="Starts" month={sm} day={sd} disabled={saving} autoFocusRef={firstRef}
                    onChange={(m, d) => { setSm(m); setSd(d); }} />
          <MDPicker idPrefix="sm-end" label="Ends" month={em} day={ed} disabled={saving}
                    onChange={(m, d) => { setEm(m); setEd(d); }} />

          {same && <span className="sm-invalid">Start and end can't be the same day.</span>}
          {valid && (
            <div className="sm-preview">
              <strong>{fmtMD(start)} → {fmtMD(end)}</strong> every year · {plural(Math.round(length / 7), "week")} ({plural(length, "day")})
              {wrapsYear(start, end) && <span className="sm-chip">Crosses New Year</span>}
            </div>
          )}

          {peers.length > 0 && (
            <label className="sm-check">
              <input type="checkbox" checked={applyPeers} disabled={saving} onChange={(e) => setApplyPeers(e.target.checked)} />
              <span>
                Also use these dates for {peers.map(semName).join(", ")}
                <span className="mg-help"> — these usually run at the same time as {semName(sem)}.</span>
              </span>
            </label>
          )}
          {replaced.length > 0 && (
            <span className="mg-help">This replaces the current dates of {replaced.map(semName).join(", ")}.</span>
          )}

          {overlaps.length > 0 && (
            <div className="mg-banner mg-banner--warn">
              <span className="mg-banner-text">Overlaps with {overlaps.join(", ")}. You can still save.</span>
            </div>
          )}
          {error && (
            <div className="mg-banner mg-banner--error" role="alert">
              <span className="mg-banner-text">⚠ {error}</span>
            </div>
          )}
        </div>

        <div className="mg-modal-footer">
          <button type="button" className="mg-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="mg-btn mg-btn--primary" disabled={!valid || saving}>
            {saving ? "Saving…" : "Save dates"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function SemestersPage() {
  const [ctx, setCtx] = useState(null);            // { courses, today, head }
  const [ctxError, setCtxError] = useState("");
  const [courseId, setCourseId] = useState(null);
  const [semesters, setSemesters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);       // { type, text }
  const [editing, setEditing] = useState(null);
  const seq = useRef(0);                            // ignores stale responses when switching course

  const loadContext = useCallback(async () => {
    setLoading(true);
    setCtxError("");
    try {
      const data = await headApi.get("/context");
      setCtx(data);
      setCourseId((cur) => cur || data.courses[0]?.course_id || null);
      if (!data.courses.length) setLoading(false);
    } catch (e) {
      setCtxError(e.message);
      setLoading(false);
    }
  }, []);

  const loadSemesters = useCallback(async (id) => {
    if (!id) return;
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const data = await headApi.get(`/semesters?course_id=${encodeURIComponent(id)}`);
      if (mine === seq.current) setSemesters(data.semesters || []);
    } catch (e) {
      if (mine === seq.current) { setError(e.message); setSemesters([]); }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { loadContext(); }, [loadContext]);
  useEffect(() => { if (courseId) loadSemesters(courseId); }, [courseId, loadSemesters]);

  useEffect(() => {
    if (!notice || notice.type === "warn") return;
    const t = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  const course = ctx?.courses.find((c) => c.course_id === courseId) || null;
  const today = ctx?.today || null;
  const dept = ctx?.head?.department || "";

  const handleSaved = (res) => {
    const changed = [res.semester, ...(res.updated || [])];
    setSemesters((list) => list.map((s) => changed.find((c) => c.semester === s.semester) || s));
    setEditing(null);
    const names = changed.map((c) => c.label.replace("Sem", "Semester"));
    const text = `${names.join(" and ")} dates saved.`;
    setNotice(
      res.warnings?.length
        ? { type: "warn", text: `${text} Note: ${res.warnings.join("; ")}.` }
        : { type: "success", text },
    );
  };

  const setCount = semesters.filter((s) => s.start_md && s.end_md).length;
  const activeNums = semesters.filter((s) => s.status === "active").map((s) => s.semester);
  const activeText = !activeNums.length
    ? "—"
    : `${activeNums.length === 1 ? "Semester" : "Semesters"} ${activeNums.join(" & ")}`;

  return (
    <ManageShell
      title="Semesters"
      subtitle={`Set the usual start and end of each semester${dept ? ` for ${dept}` : ""} — day and month only, repeated every year.`}
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
            <button
              key={c.course_id}
              role="tab"
              aria-selected={c.course_id === courseId}
              className={`mg-pill${c.course_id === courseId ? " mg-pill--active" : ""}`}
              onClick={() => setCourseId(c.course_id)}
            >
              {c.course_name || c.abbr} <span className="mg-pill-code">{c.abbr}</span>
            </button>
          ))}
        </div>
      )}

      {course && (
        <>
          <div className="sm-stats">
            <div className="sm-stat">
              <span className="sm-stat-val">{course.total_semesters}</span>
              <span className="sm-stat-label">Semesters in {course.abbr}</span>
            </div>
            <div className="sm-stat">
              <span className="sm-stat-val">{setCount}<span className="sm-stat-of"> / {semesters.length || course.total_semesters}</span></span>
              <span className="sm-stat-label">With dates set</span>
            </div>
            <div className="sm-stat">
              <span className="sm-stat-val sm-stat-val--sm">{activeText}</span>
              <span className="sm-stat-label">In progress today</span>
            </div>
          </div>

          {error && (
            <div className="mg-banner mg-banner--error" role="alert">
              <span className="mg-banner-text">⚠ {error}</span>
              <button className="mg-banner-action" onClick={() => loadSemesters(courseId)}>Retry</button>
            </div>
          )}

          {loading && !semesters.length && !error && <div className="mg-loading">Loading semesters…</div>}

          {semesters.length > 0 && (
            <div className="sm-grid" aria-busy={loading}>
              {semesters.map((s) => (
                <SemesterCard key={s.semester} sem={s} today={today} onEdit={setEditing} />
              ))}
            </div>
          )}

          <p className="sm-footnote">
            Dates repeat every year, so there's nothing to update each year. Odd semesters (1, 3…) usually run together,
            as do even ones (2, 4…). Moving students up at the end of a semester will use these dates once that feature
            is enabled.
          </p>
        </>
      )}

      {!ctx && loading && !ctxError && <div className="mg-loading">Loading…</div>}

      {editing && course && (
        <SemesterModal
          course={course}
          sem={editing}
          all={semesters}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </ManageShell>
  );
}