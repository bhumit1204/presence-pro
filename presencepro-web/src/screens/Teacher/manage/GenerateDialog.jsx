// @ts-nocheck
/**
 * GenerateDialog.jsx — "Auto-generate" for one semester of the Timetable page.
 *   1 Timings        working days, first / last period, period length, breaks
 *   2 Subjects       hours of every subject, elective group, common session (e.g. Research Project) and each division's classroom
 *   3 Check & save   the generated week per division, anything that could not be placed, Save
 * Teachers are not picked here: each subject's teacher for each division is set in Subjects & Faculty.
 * What was typed is remembered per course and semester (localStorage, best effort).
 * Backend (/api/web/head): POST /timetable/generate/preview, POST /timetable/generate/apply,
 *                          GET /timetable/generations, DELETE /timetable/generations/:id, GET /rooms
 */
import { useEffect, useMemo, useState } from "react";
import { headApi } from "../../../services/headApi";
import "./GenerateDialog.css";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n) => String(n).padStart(2, "0");
const toMin = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const num = (v) => (v === "" || v === null || v === undefined ? 0 : Number(v) || 0);

// the periods of one day, the same way the server cuts them
export function periodsOf(g) {
  const step = Math.max(15, Number(g.slot_minutes) || 60);
  const breaks = (g.breaks || []).map((b) => [toMin(b.start), toMin(b.end)]).filter(([a, b]) => b > a);
  const out = [];
  for (let s = toMin(g.start); s + step <= toMin(g.end); s += step) {
    const e = s + step;
    if (!breaks.some(([a, b]) => s < b && a < e)) out.push({ s, e });
  }
  return out;
}

function Modal({ title, sub, onClose, busy, children, footer }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [busy, onClose]);
  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mg-modal mg-modal--wide tg-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mg-modal-header">
          <div><h3 className="mg-modal-title">{title}</h3>{sub && <p className="mg-modal-sub">{sub}</p>}</div>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>
        <div className="mg-modal-body">{children}</div>
        <div className="mg-modal-footer">{footer}</div>
      </div>
    </div>
  );
}

function Stepper({ step }) {
  return (
    <ol className="tg-steps" aria-label="Steps">
      {["Timings", "Subjects", "Check & save"].map((t, i) => (
        <li key={t} className={step === i ? "tg-step tg-step--on" : step > i ? "tg-step tg-step--done" : "tg-step"}><span>{i + 1}</span>{t}</li>
      ))}
    </ol>
  );
}

function PreviewGrid({ items, grid, divisionId, colorOf, divisionless }) {
  const units = useMemo(() => periodsOf(grid), [grid]);
  const days = grid.days;
  const mine = items.filter((it) => it.type === "elective" || divisionless || String(it.division_id) === String(divisionId));
  // one block per (day, start, end, slot): electives and lab batches sit side by side
  const blocks = useMemo(() => {
    const m = new Map();
    mine.forEach((it, n) => {
      const k = `${it.day}|${it.start_time}|${it.end_time}|${it.type === "lecture" || it.type === "tutorial" ? `#${n}` : it.slot_key}`;
      if (!m.has(k)) m.set(k, { day: it.day, start: toMin(it.start_time), end: toMin(it.end_time), type: it.type, list: [] });
      m.get(k).list.push(it);
    });
    return [...m.values()];
  }, [items, divisionId]); // eslint-disable-line
  return (
    <div className="tg-grid-wrap">
      <table className="tg-grid">
        <thead>
          <tr><th>Day</th>{units.map((u, i) => <th key={i}>{fromMin(u.s)}<small>–{fromMin(u.e)}</small></th>)}</tr>
        </thead>
        <tbody>
          {days.map((d) => {
            const cells = [];
            for (let i = 0; i < units.length; i++) {
              const b = blocks.find((x) => x.day === d && x.start === units[i].s);
              if (!b) { cells.push(<td key={i} className="tg-empty" />); continue; }
              let span = 1;
              while (i + span < units.length && units[i + span].e <= b.end) span++;
              cells.push(
                <td key={i} colSpan={span} className={`tg-block tg-block--${b.type}`}>
                  {b.list.map((it, k) => {
                    const [bg, fg] = it.type === "common" ? ["#F1F5F9", "#334155"] : colorOf(it.subject_id);
                    const tag = it.type === "tutorial" || it.kind === "tutorial" ? " (T)" : it.kind === "lab" ? " (Lab)" : "";
                    return (
                      <div key={k} className="tg-chip" style={{ background: bg, color: fg }} title={`${it.subject_name} · ${it.teacher_name || "All faculty"}${it.room ? " · " + it.room : ""}`}>
                        <strong>{it.type === "common" ? it.subject_name : (it.subject_code || it.subject_name)}{tag}{it.batch ? ` · ${it.batch}` : ""}</strong>
                        <span>{it.teacher_name}{it.room ? `${it.teacher_name ? " · " : ""}${it.room}` : ""}</span>
                      </div>
                    );
                  })}
                </td>,
              );
              i += span - 1;
            }
            return <tr key={d}><th scope="row">{d.slice(0, 3)}</th>{cells}</tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

const DEFAULT_GRID = { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], start: "08:30", end: "15:30", slot_minutes: 60, breaks: [{ start: "12:30", end: "13:30" }] };
const WHEN = [["any", "Any time"], ["morning", "Morning"], ["afternoon", "Afternoon"]];
const storeKey = (course, sem) => `pp_tg_v2:${course.course_id}:${sem}`;
const loadSaved = (course, sem) => { try { return JSON.parse(localStorage.getItem(storeKey(course, sem)) || "null") || {}; } catch { return {}; } };
const saveSaved = (course, sem, v) => { try { localStorage.setItem(storeKey(course, sem), JSON.stringify(v)); } catch { /* storage is optional */ } };

export default function GenerateDialog({ data, course, semester, onClose, onSaved }) {
  const saved = useMemo(() => loadSaved(course, semester), [course.course_id, semester]); // eslint-disable-line
  const divisions = data.divisions || [];
  const [step, setStep] = useState(0);
  const [grid, setGrid] = useState(() => (saved.grid && Array.isArray(saved.grid.days) ? { ...DEFAULT_GRID, ...saved.grid } : DEFAULT_GRID));
  const compulsory = useMemo(() => data.subjects.filter((s) => s.compulsary !== false), [data.subjects]);
  const groups = useMemo(() => {
    const m = new Map();
    data.subjects.filter((s) => s.compulsary === false).forEach((s) => {
      const g = s.elective_group || "Elective";
      if (!m.has(g)) m.set(g, []);
      m.get(g).push(s);
    });
    return [...m.entries()].map(([name, subs]) => ({ name, subs, tut: subs.filter((s) => s.has_tutorial), lab: subs.filter((s) => s.has_lab) }));
  }, [data.subjects]);

  const [rows, setRows] = useState(() => Object.fromEntries(compulsory.map((s) => [s.subject_id, {
    lecture: s.kind === "lab" ? "" : "3", lecture_periods: "1", tutorial: s.has_tutorial ? "1" : "", lab_sessions: s.kind === "lab" ? "1" : s.has_lab ? "1" : "", lab_periods: "2", when: "any",
    ...((saved.rows || {})[s.subject_id] || {}),
  }])));
  const [gh, setGh] = useState(() => Object.fromEntries(groups.map((g) => [g.name, {
    periods: "3", tutorial: g.tut.length ? "1" : "", lab_sessions: g.lab.length ? "1" : "", lab_periods: "2", when: "any",
    ...((saved.gh || {})[g.name] || {}),
  }])));
  const [common, setCommon] = useState(() => (Array.isArray(saved.common) ? saved.common : []));
  const [divRooms, setDivRooms] = useState(() => saved.divRooms || {});
  const [more, setMore] = useState(false);
  const [classrooms, setClassrooms] = useState([]);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [view, setView] = useState(null);
  const [last, setLast] = useState([]);
  const hasExisting = (data.lectures || []).length > 0;

  useEffect(() => { saveSaved(course, semester, { grid, rows, gh, common, divRooms }); }, [grid, rows, gh, common, divRooms]); // eslint-disable-line
  useEffect(() => {
    headApi.get(`/timetable/generations?course_id=${encodeURIComponent(course.course_id)}&semester=${semester}`).then((d) => setLast(d.generations || [])).catch(() => {});
    headApi.get("/rooms").then((d) => setClassrooms((d.rooms || []).filter((r) => r.course_id === course.course_id && r.type !== "lab").map((r) => r.name))).catch(() => {});
  }, [course.course_id, semester]);

  const colorOf = useMemo(() => {
    const PAL = [["#EEEBFB", "#4834D4"], ["#DBEAFE", "#1D4ED8"], ["#D1FAE5", "#047857"], ["#FEF3C7", "#B45309"], ["#FCE7F3", "#BE185D"], ["#E0F2FE", "#0369A1"], ["#FEE2E2", "#B91C1C"], ["#ECFCCB", "#4D7C0F"]];
    const ids = data.subjects.map((s) => s.subject_id);
    return (id) => PAL[Math.max(0, ids.indexOf(id)) % PAL.length];
  }, [data.subjects]);

  const units = useMemo(() => periodsOf(grid), [grid]);
  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const setG = (name, patch) => setGh((r) => ({ ...r, [name]: { ...r[name], ...patch } }));
  const setCom = (i, patch) => setCommon((c) => c.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const setBreak = (i, patch) => setGrid((g) => ({ ...g, breaks: g.breaks.map((b, k) => (k === i ? { ...b, ...patch } : b)) }));
  const toggleDay = (d) => setGrid((g) => ({ ...g, days: g.days.includes(d) ? g.days.filter((x) => x !== d) : DAYS.filter((x) => g.days.includes(x) || x === d) }));

  const gridProblem = !grid.days.length ? "Pick at least one working day."
    : toMin(grid.end) <= toMin(grid.start) ? "The last period must end after the first one starts."
    : !units.length ? "No period fits between the start and end."
    : grid.breaks.some((b) => toMin(b.end) <= toMin(b.start)) ? "Each break must end after it starts." : "";

  // who teaches a subject to a division (set in Subjects & Faculty)
  const teacherFor = (s, dv) => (dv && s.division_teachers && s.division_teachers[dv.division_id]?.teacher_name) || s.teacher_name || "";
  const teacherLine = (s) => {
    if (divisions.length > 1) {
      const names = divisions.map((dv) => teacherFor(s, dv));
      if (names.every((n) => n === names[0])) return names[0] || "";
      return divisions.map((dv, i) => `${dv.name}: ${names[i] || "—"}`).join(" · ");
    }
    return teacherFor(s, divisions[0]);
  };
  const usesSubject = (r) => (num(r.lecture) + num(r.tutorial) + num(r.lab_sessions)) > 0;
  const noTeacher = compulsory.filter((s) => usesSubject(rows[s.subject_id] || {}) && (divisions.length ? divisions : [null]).some((dv) => !teacherFor(s, dv)));
  const groupBad = groups.filter((g) => num(gh[g.name]?.periods) + num(gh[g.name]?.tutorial) + num(gh[g.name]?.lab_sessions) > 0 && g.subs.some((s) => !s.teacher_assigned));
  const commonBad = common.some((c) => !c.title.trim() || !num(c.sessions));

  // periods a division spends each week (labs excluded: batches share their time)
  const perDivision = compulsory.reduce((a, s) => { const r = rows[s.subject_id] || {}; return a + num(r.lecture) * (num(r.lecture_periods) || 1) + num(r.tutorial); }, 0)
    + groups.reduce((a, g) => { const h = gh[g.name] || {}; return a + num(h.periods) + (g.tut.length ? num(h.tutorial) : 0) + (g.lab.length ? num(h.lab_sessions) * (num(h.lab_periods) || 1) : 0); }, 0)
    + common.reduce((a, c) => a + num(c.sessions) * (num(c.periods) || 1), 0);
  const weekCap = units.length * grid.days.length;
  const noHours = perDivision === 0 && !compulsory.some((s) => num((rows[s.subject_id] || {}).lab_sessions) > 0);

  const payload = (seed) => ({
    course_id: course.course_id, semester,
    grid: { ...grid, slot_minutes: Number(grid.slot_minutes) },
    subjects: compulsory.map((s) => {
      const r = rows[s.subject_id] || {};
      return { subject_id: s.subject_id, lecture: num(r.lecture), lecture_periods: num(r.lecture_periods) || 1, tutorial: num(r.tutorial), lab_sessions: num(r.lab_sessions), lab_periods: num(r.lab_periods) || 1, when: r.when || "any" };
    }).filter((x) => x.lecture || x.tutorial || x.lab_sessions),
    groups: groups.map((g) => {
      const h = gh[g.name] || {};
      return { group: g.name, periods: num(h.periods), tutorial: g.tut.length ? num(h.tutorial) : 0, lab_sessions: g.lab.length ? num(h.lab_sessions) : 0, lab_periods: num(h.lab_periods) || 1, when: h.when || "any" };
    }).filter((g) => g.periods || g.tutorial || g.lab_sessions),
    common: common.filter((c) => c.title.trim() && num(c.sessions)).map((c) => ({ title: c.title.trim(), sessions: num(c.sessions), periods: num(c.periods) || 1, days: c.days && c.days.length ? c.days : undefined, when: c.when || "any", teacher_name: (c.teacher_name || "").trim() })),
    division_rooms: Object.fromEntries(Object.entries(divRooms).filter(([, v]) => v)),
    seed, replace_existing: replace,
  });

  const generate = async (again) => {
    setBusy(true); setError("");
    try {
      const d = await headApi.post("/timetable/generate/preview", payload(again ? Math.floor(Math.random() * 1e6) : undefined));
      setResult(d);
      setView(d.divisions[0] ? d.divisions[0].division_id : null);
      setStep(2);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true); setError("");
    try {
      const d = await headApi.post("/timetable/generate/apply", { proposal_id: result.proposal_id });
      onSaved(`Timetable saved: ${d.created} slot${d.created === 1 ? "" : "s"} added${d.replaced ? `, ${d.replaced} old one${d.replaced === 1 ? "" : "s"} replaced` : ""}.`);
    } catch (err) { setError(err.message); setBusy(false); }
  };
  const undo = async (g) => {
    if (!window.confirm("Remove the timetable that run created? The slots it replaced come back.")) return;
    setBusy(true); setError("");
    try {
      const d = await headApi.del(`/timetable/generations/${g.gen_id}`);
      onSaved(`Undone: ${d.removed} slot${d.removed === 1 ? "" : "s"} removed${d.restored ? `, ${d.restored} restored` : ""}.`);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  const blockers = [
    noTeacher.length && `Pick teachers in Subjects & Faculty for: ${noTeacher.map((s) => s.subject_name).join(", ")}.`,
    groupBad.length && `Some options of ${groupBad.map((g) => g.name).join(", ")} have no teacher yet (Subjects & Faculty).`,
    commonBad && "Every common session needs a name and a number of sessions.",
    hasExisting && !replace && "Tick the box below to replace the timetable this semester already has.",
  ].filter(Boolean);

  const footer = (
    <>
      {step > 0 && <button type="button" className="mg-btn" onClick={() => setStep(step - 1)} disabled={busy}>Back</button>}
      <span className="tg-spacer" />
      <button type="button" className="mg-btn" onClick={onClose} disabled={busy}>Cancel</button>
      {step === 0 && <button type="button" className="mg-btn mg-btn--primary" disabled={!!gridProblem} onClick={() => setStep(1)}>Next</button>}
      {step === 1 && (
        <button type="button" className="mg-btn mg-btn--primary" disabled={busy || noHours || blockers.length > 0} onClick={() => generate(false)}>
          {busy ? "Working…" : "Create preview"}
        </button>
      )}
      {step === 2 && result && (
        <>
          <button type="button" className="mg-btn" disabled={busy} onClick={() => generate(true)} title="Same hours, different arrangement">Try another arrangement</button>
          <button type="button" className="mg-btn mg-btn--primary" disabled={busy || !result.items.length} onClick={apply}>
            {busy ? "Saving…" : result.complete ? "Save timetable" : "Save what fits"}
          </button>
        </>
      )}
    </>
  );

  const labCan = (s) => s.kind === "lab" || s.has_lab;
  return (
    <Modal title="Auto-generate timetable" sub={`${course.abbr || course.course_name} · Semester ${semester}`} onClose={onClose} busy={busy} footer={footer}>
      <Stepper step={step} />

      {step === 0 && (
        <>
          <p className="tg-lead">Tell us how your college day is laid out. Every working day uses the same periods.</p>
          {last.length > 0 && (
            <div className="mg-banner tg-last">
              <span className="mg-banner-text">
                A timetable was generated for this semester on {String(last[0].created_at || "").slice(0, 10)}{last[0].created_by ? ` by ${last[0].created_by}` : ""}.
              </span>
              <button type="button" className="mg-btn" onClick={() => undo(last[0])} disabled={busy}>Undo it</button>
            </div>
          )}
          <div className="mg-field">
            <span className="mg-label">Working days</span>
            <div className="tg-days">
              {DAYS.map((d) => (
                <label key={d} className={`tg-day${grid.days.includes(d) ? " tg-day--on" : ""}`}>
                  <input type="checkbox" checked={grid.days.includes(d)} onChange={() => toggleDay(d)} />{d.slice(0, 3)}
                </label>
              ))}
            </div>
          </div>
          <div className="tg-three">
            <div className="mg-field"><label className="mg-label" htmlFor="tg-start">First period starts</label>
              <input id="tg-start" type="time" className="mg-input" value={grid.start} onChange={(e) => setGrid({ ...grid, start: e.target.value })} /></div>
            <div className="mg-field"><label className="mg-label" htmlFor="tg-end">Last period ends</label>
              <input id="tg-end" type="time" className="mg-input" value={grid.end} onChange={(e) => setGrid({ ...grid, end: e.target.value })} /></div>
            <div className="mg-field"><label className="mg-label" htmlFor="tg-slot">One period is (minutes)</label>
              <input id="tg-slot" type="number" min="30" max="180" step="5" className="mg-input" value={grid.slot_minutes} onChange={(e) => setGrid({ ...grid, slot_minutes: e.target.value })} /></div>
          </div>
          <fieldset className="tt-group">
            <legend>Breaks (lunch, recess)</legend>
            {grid.breaks.map((b, i) => (
              <div className="tg-break" key={i}>
                <input type="time" className="mg-input" aria-label="Break starts" value={b.start} onChange={(e) => setBreak(i, { start: e.target.value })} />
                <span>to</span>
                <input type="time" className="mg-input" aria-label="Break ends" value={b.end} onChange={(e) => setBreak(i, { end: e.target.value })} />
                <button type="button" className="mg-btn" onClick={() => setGrid({ ...grid, breaks: grid.breaks.filter((_, k) => k !== i) })}>Remove</button>
              </div>
            ))}
            <div><button type="button" className="mg-btn" onClick={() => setGrid({ ...grid, breaks: [...grid.breaks, { start: "11:00", end: "11:15" }] })}>+ Add a break</button></div>
          </fieldset>
          {gridProblem ? <span className="tt-invalid">{gridProblem}</span>
            : <div className="tg-periods" aria-label="Periods of a day">
                {units.map((u, i) => <span key={i} className="tg-period"><b>{i + 1}</b>{fromMin(u.s)}–{fromMin(u.e)}</span>)}
                <span className="mg-help">{units.length} period{units.length === 1 ? "" : "s"} a day, {units.length * grid.days.length} a week.</span>
              </div>}
        </>
      )}

      {step === 1 && (
        <>
          <p className="tg-lead">How many times a week should each subject happen? Teachers come from Subjects &amp; Faculty{divisions.length > 1 ? ", set separately for each division" : ""}.</p>

          {divisions.length > 0 && classrooms.length > 0 && (
            <fieldset className="tt-group">
              <legend>Classroom of each division</legend>
              <div className="tg-divrooms">
                {divisions.map((dv) => (
                  <label key={dv.division_id} className="tg-inline">Division {dv.name}
                    <select className="mg-input" value={divRooms[dv.division_id] || ""} onChange={(e) => setDivRooms({ ...divRooms, [dv.division_id]: e.target.value })}>
                      <option value="">Any free classroom</option>
                      {classrooms.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <span className="mg-help">Lectures of a division go to its own classroom whenever it is free.</span>
            </fieldset>
          )}

          <h4 className="tg-h">Regular subjects</h4>
          <div className="tg-table-wrap">
            <table className="tg-table">
              <thead>
                <tr>
                  <th>Subject</th><th>Lectures a week</th>
                  {more && <th>Periods in one lecture</th>}
                  <th>Tutorial periods a week</th><th>Lab sessions a week</th><th>One lab session is</th>
                  {more && <th>Best time</th>}
                </tr>
              </thead>
              <tbody>
                {compulsory.map((s) => {
                  const r = rows[s.subject_id] || {};
                  const labOnly = s.kind === "lab";
                  const used = usesSubject(r);
                  const miss = used && (divisions.length ? divisions : [null]).some((dv) => !teacherFor(s, dv));
                  return (
                    <tr key={s.subject_id}>
                      <td>
                        <strong>{s.subject_code}</strong><span className="tg-sub">{s.subject_name}{labOnly ? " · lab" : ""}</span>
                        <span className={`tg-teach${miss ? " tg-teach--miss" : ""}`}>{teacherLine(s) || "No teacher yet"}</span>
                      </td>
                      <td><input type="number" min="0" max="12" className="mg-input tg-n" disabled={labOnly} aria-label={`Lectures a week for ${s.subject_name}`} value={labOnly ? "" : r.lecture} onChange={(e) => setRow(s.subject_id, { lecture: e.target.value })} /></td>
                      {more && <td><select className="mg-input tg-n" disabled={labOnly || !num(r.lecture)} aria-label={`Periods in one lecture of ${s.subject_name}`} value={r.lecture_periods} onChange={(e) => setRow(s.subject_id, { lecture_periods: e.target.value })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></td>}
                      <td><input type="number" min="0" max="6" className="mg-input tg-n" disabled={!s.has_tutorial} title={s.has_tutorial ? "" : "This subject has no tutorial"} aria-label={`Tutorial periods a week for ${s.subject_name}`} value={r.tutorial} onChange={(e) => setRow(s.subject_id, { tutorial: e.target.value })} /></td>
                      <td><input type="number" min="0" max="4" className="mg-input tg-n" disabled={!labCan(s)} title={labCan(s) ? "" : "This subject has no lab"} aria-label={`Lab sessions a week for ${s.subject_name}`} value={r.lab_sessions} onChange={(e) => setRow(s.subject_id, { lab_sessions: e.target.value })} /></td>
                      <td>
                        <select className="mg-input tg-w" disabled={!labCan(s) || !num(r.lab_sessions)} aria-label={`Lab session length for ${s.subject_name}`} value={r.lab_periods} onChange={(e) => setRow(s.subject_id, { lab_periods: e.target.value })}>
                          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} period{n === 1 ? "" : "s"}</option>)}
                        </select>
                      </td>
                      {more && <td><select className="mg-input tg-w" aria-label={`Best time for ${s.subject_name}`} value={r.when} onChange={(e) => setRow(s.subject_id, { when: e.target.value })}>{WHEN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>}
                    </tr>
                  );
                })}
                {compulsory.length === 0 && <tr><td colSpan={6} className="tg-sub">This semester has no regular subjects yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <label className="tg-more"><input type="checkbox" checked={more} onChange={(e) => setMore(e.target.checked)} /> Show more options (longer lectures, morning or afternoon)</label>

          {groups.length > 0 && (
            <>
              <h4 className="tg-h">Elective groups</h4>
              <p className="mg-help tg-note">Students pick one option of a group. All options of a group run at the same time for every division, each with its own teacher and room.</p>
              {groups.map((g) => {
                const h = gh[g.name] || {};
                return (
                  <div className="tg-card" key={g.name}>
                    <div className="tg-card-head">
                      <strong>{g.name}</strong>
                      <span className="tg-sub">{g.subs.map((s) => `${s.subject_name}${s.teacher_name ? ` (${s.teacher_name})` : " (no teacher)"}`).join(" · ")}</span>
                    </div>
                    <div className="tg-card-fields">
                      <label className="tg-inline">Lectures a week
                        <input type="number" min="0" max="12" className="mg-input tg-n" value={h.periods} onChange={(e) => setG(g.name, { periods: e.target.value })} />
                      </label>
                      <label className={`tg-inline${g.tut.length ? "" : " tg-off"}`}>Tutorial periods a week
                        <input type="number" min="0" max="6" className="mg-input tg-n" disabled={!g.tut.length} title={g.tut.length ? "" : "None of these subjects has a tutorial"} value={g.tut.length ? h.tutorial : ""} onChange={(e) => setG(g.name, { tutorial: e.target.value })} />
                      </label>
                      <label className={`tg-inline${g.lab.length ? "" : " tg-off"}`}>Lab sessions a week
                        <input type="number" min="0" max="4" className="mg-input tg-n" disabled={!g.lab.length} title={g.lab.length ? "" : "None of these subjects has a lab"} value={g.lab.length ? h.lab_sessions : ""} onChange={(e) => setG(g.name, { lab_sessions: e.target.value })} />
                      </label>
                      <label className={`tg-inline${g.lab.length ? "" : " tg-off"}`}>One lab session is
                        <select className="mg-input tg-w" disabled={!g.lab.length || !num(h.lab_sessions)} value={h.lab_periods} onChange={(e) => setG(g.name, { lab_periods: e.target.value })}>
                          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} period{n === 1 ? "" : "s"}</option>)}
                        </select>
                      </label>
                    </div>
                    {(g.tut.length > 0 && g.tut.length < g.subs.length) || (g.lab.length > 0 && g.lab.length < g.subs.length) ? (
                      <span className="mg-help">
                        {g.tut.length > 0 && g.tut.length < g.subs.length ? `Tutorial: only ${g.tut.map((s) => s.subject_name).join(", ")}. ` : ""}
                        {g.lab.length > 0 && g.lab.length < g.subs.length ? `Lab: only ${g.lab.map((s) => s.subject_name).join(", ")}. ` : ""}
                        The other options are free at those times.
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </>
          )}

          <h4 className="tg-h">Common sessions <span className="tg-opt">optional</span></h4>
          <p className="mg-help tg-note">For something every division attends together with no fixed teacher or room, like a Research Project.</p>
          {common.map((c, i) => (
            <div className="tg-card" key={i}>
              <div className="tg-card-fields">
                <label className="tg-inline tg-grow">Name
                  <input className="mg-input" maxLength={80} placeholder="e.g. Research Project" value={c.title} onChange={(e) => setCom(i, { title: e.target.value })} />
                </label>
                <label className="tg-inline">Sessions a week
                  <input type="number" min="1" max="7" className="mg-input tg-n" value={c.sessions} onChange={(e) => setCom(i, { sessions: e.target.value })} />
                </label>
                <label className="tg-inline">One session is
                  <select className="mg-input tg-w" value={c.periods} onChange={(e) => setCom(i, { periods: e.target.value })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} period{n === 1 ? "" : "s"}</option>)}</select>
                </label>
                <label className="tg-inline">Best time
                  <select className="mg-input tg-w" value={c.when} onChange={(e) => setCom(i, { when: e.target.value })}>{WHEN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
                <label className="tg-inline">Shown as teacher
                  <input className="mg-input" maxLength={60} value={c.teacher_name} onChange={(e) => setCom(i, { teacher_name: e.target.value })} />
                </label>
              </div>
              <div className="tg-days tg-days--sm" aria-label="Days it can be on">
                <span className="tg-sub">Only on</span>
                {grid.days.map((d) => (
                  <label key={d} className={`tg-day${!c.days || !c.days.length || c.days.includes(d) ? " tg-day--on" : ""}`}>
                    <input type="checkbox" checked={!c.days || !c.days.length || c.days.includes(d)}
                           onChange={() => { const cur = c.days && c.days.length ? c.days : grid.days; const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]; setCom(i, { days: next.length === grid.days.length ? [] : next }); }} />{d.slice(0, 3)}
                  </label>
                ))}
                <button type="button" className="mg-btn" onClick={() => setCommon(common.filter((_, k) => k !== i))}>Remove</button>
              </div>
            </div>
          ))}
          <div><button type="button" className="mg-btn" onClick={() => setCommon([...common, { title: "", sessions: "4", periods: "2", when: "afternoon", days: [], teacher_name: "All Faculty" }])}>+ Add a common session</button></div>

          <div className={`tg-load${perDivision > weekCap ? " tg-load--over" : ""}`}>
            Each division has {perDivision} period{perDivision === 1 ? "" : "s"} of lectures, tutorials, electives and common sessions out of {weekCap} in the week, before labs.
          </div>
          {blockers.map((b, i) => <span key={i} className="tt-invalid">{b}</span>)}
          {hasExisting && (
            <label className="tg-confirm">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              <span>This semester already has {data.lectures.length} timetable slot{data.lectures.length === 1 ? "" : "s"}. Replace them with the new timetable. (You can undo it afterwards.)</span>
            </label>
          )}
        </>
      )}

      {step === 2 && result && (
        <>
          <div className="tg-summary">
            <span className={`tg-pill ${result.complete ? "tg-pill--ok" : "tg-pill--warn"}`}>{result.complete ? "Everything fits" : "Some things don't fit"}</span>
            <span>{result.items.length} slots{result.replaces > 0 ? ` · replaces ${result.replaces} existing` : ""}</span>
          </div>
          {result.warnings.length > 0 && (
            <div className="mg-banner tg-warn" role="status"><ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
          )}
          {result.unplaced.length > 0 && (
            <div className="tg-unplaced">
              <strong>Could not place</strong>
              <ul>
                {result.unplaced.map((u, i) => (
                  <li key={i}>{u.subject}{u.division ? ` (division ${u.division})` : ""}: {u.missing} {u.kind === "lab" ? "lab session" : u.kind === "common" ? "session" : u.kind === "elective" ? "period" : u.kind}{u.missing === 1 ? "" : "s"} left out because {u.reason}.</li>
                ))}
              </ul>
              <span className="mg-help">You can save what fits and add the rest by hand, press “Try another arrangement”, or go back and change the hours.</span>
            </div>
          )}
          {result.divisions.length > 1 && (
            <div className="tg-tabs" role="tablist">
              {result.divisions.map((d) => (
                <button key={String(d.division_id)} role="tab" aria-selected={view === d.division_id} className={`tg-tab${view === d.division_id ? " tg-tab--on" : ""}`} onClick={() => setView(d.division_id)}>
                  Division {d.name}<small>{d.room ? `Room ${d.room} · ` : ""}{d.size} students</small>
                </button>
              ))}
            </div>
          )}
          <PreviewGrid items={result.items} grid={grid} divisionId={view} divisionless={!result.divisions[0] || result.divisions[0].division_id === null} colorOf={colorOf} />
          {result.stats.batches.some((b) => b.batches > 1) && (
            <span className="mg-help">A division bigger than a lab is split into {result.stats.batches.find((b) => b.batches > 1).batches} batches (B1, B2…) by roll number. Batches do different labs at the same time and take turns.</span>
          )}
        </>
      )}

      {error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {error}</span></div>}
    </Modal>
  );
}
