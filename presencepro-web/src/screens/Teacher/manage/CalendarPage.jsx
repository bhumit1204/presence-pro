// @ts-nocheck
/**
 * CalendarPage.jsx — Manage → Academic Calendar (head only)
 *
 * Holidays, exams, events — and two automated kinds:
 *   • Holiday          → students get a notice 2 days before it starts
 *   • Defaulter list   → on its date the system builds, per subject, the roll
 *                        numbers at 50% or less and 51–75% and announces it
 *                        to the class
 *
 * API: GET/POST/PUT/DELETE /calendar, POST /calendar/:id/run,
 *      GET /calendar/:id/defaulters
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import ManageShell from "../../../components/ManageShell";
import { headApi } from "../../../services/headApi";
import "./CalendarPage.css";

const TYPES = [
  { value: "holiday", label: "Holiday", plural: "Holidays" },
  { value: "exam", label: "Exam", plural: "Exams" },
  { value: "defaulter", label: "Defaulter list", plural: "Defaulter lists" },
  { value: "event", label: "Event", plural: "Events" },
  { value: "working_day_swap", label: "Working-day swap", plural: "Swaps" },
  { value: "general", label: "Other", plural: "Other" },
];
const typeLabel = (t) => (TYPES.find((x) => x.value === t) || TYPES[5]).label;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayIso = () => { const d = new Date(); return isoOf(d.getFullYear(), d.getMonth(), d.getDate()); };
const fmt = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const fmtShort = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "");
const range = (e) => (e.end_date && e.end_date !== e.start_date ? `${fmt(e.start_date)} – ${fmt(e.end_date)}` : fmt(e.start_date));
const academicYear = (iso) => {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const s = m >= 6 ? y : y - 1;
  return `${s}-${String(s + 1).slice(2)}`;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

const LEADS = [
  { value: 0, label: "On the same day (morning of the holiday)" },
  { value: 1, label: "1 day before" },
  { value: 2, label: "2 days before" },
  { value: 3, label: "3 days before" },
  { value: 7, label: "1 week before" },
];
const leadText = (n) => (n === 0 ? "on the day" : n === 1 ? "1 day before" : `${n} days before`);

// ── what the automation says about an event ──────────────────────────────────
function autoLine(e) {
  const a = e.automation;
  if (!a) return null;
  if (a.kind === "holiday_notice") {
    if (a.status === "off") return { tone: "off", text: "Automatic notice is off" };
    if (a.status === "sent") return { tone: "ok", text: `Notice sent${a.sent_at ? ` on ${fmtShort(a.sent_at.slice(0, 10))}` : ""}${a.recipients != null ? ` · ${plural(a.recipients, "student")}` : ""}` };
    if (a.status === "skipped") return { tone: "off", text: "No notice — the holiday had already started" };
    return { tone: "wait", text: `Notice goes out on ${fmt(a.send_on)} (${leadText(a.days_before)})` };
  }
  if (a.kind === "defaulter_list") {
    if (a.status === "sent") {
      const runs = a.runs || [];
      const d = runs.reduce((n, r) => n + r.defaulters, 0);
      return { tone: "ok", text: `Announced${a.sent_at ? ` on ${fmtShort(a.sent_at.slice(0, 10))}` : ""} · ${runs.length ? `${plural(runs.length, "class")}, ${plural(d, "defaulter")}` : "no class had students"}` };
    }
    if (a.status === "missed") return { tone: "bad", text: "Missed — the date passed. Generate it now." };
    return { tone: "wait", text: `Generated and announced on ${fmt(a.send_on)} at 8:00 AM` };
  }
  return null;
}

// ── dialogs ──────────────────────────────────────────────────────────────────
function useEscape(onClose, busy) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
}

function Modal({ title, sub, onClose, busy, children, footer, wide }) {
  useEscape(onClose, busy);
  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`mg-modal${wide ? " mg-modal--wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mg-modal-header">
          <div>
            <h3 className="mg-modal-title">{title}</h3>
            {sub && <p className="mg-modal-sub">{sub}</p>}
          </div>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>
        <div className="mg-modal-body">{children}</div>
        {footer && <div className="mg-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn) => {
    setBusy(true); setError("");
    try { await fn(); return true; }
    catch (err) { setError(err.message); setBusy(false); return false; }
  };
  return { busy, error, run, setError };
}

function EventDialog({ event, defaults, courses, onClose, onSaved }) {
  const editing = !!event;
  const [type, setType] = useState(event?.event_type || defaults?.type || "holiday");
  const [title, setTitle] = useState(event?.title || "");
  const [start, setStart] = useState(event?.start_date || defaults?.date || todayIso());
  const [end, setEnd] = useState(event?.end_date || event?.start_date || defaults?.date || todayIso());
  const [desc, setDesc] = useState(event?.description || "");
  const [notify, setNotify] = useState(event?.automation?.kind === "holiday_notice" ? event.automation.enabled : true);
  const [lead, setLead] = useState(event?.automation?.days_before ?? 2);
  const [courseId, setCourseId] = useState(event?.automation?.course_id || "");
  const [sem, setSem] = useState(event?.automation?.semester ?? "");
  const [from, setFrom] = useState(event?.automation?.from_date || "");
  const [fromTouched, setFromTouched] = useState(!!event?.automation?.from_date);
  const sub = useSubmit();

  const isDefaulter = type === "defaulter";
  const isHoliday = type === "holiday";
  const semCount = useMemo(() => {
    const pool = courseId ? courses.filter((c) => c.course_id === courseId) : courses;
    return Math.max(1, ...pool.map((c) => Number(c.total_semesters) || 0));
  }, [courseId, courses]);
  // default: the start of the academic year the list falls in (June 1st) — the head can change it
  const yearStart = (() => { const y = +start.slice(0, 4), m = +start.slice(5, 7); return `${m >= 6 ? y : y - 1}-06-01`; })();
  const fromDate = fromTouched ? from : yearStart;
  const effEnd = isDefaulter || end < start ? start : end;
  const finalTitle = title.trim() || (isDefaulter ? "Attendance defaulter list" : "");
  const valid = !!finalTitle && !!start && (!isDefaulter || (!!fromDate && fromDate <= start));
  const sendOn = (() => { const d = new Date(start + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - lead); return d.toISOString().slice(0, 10); })();

  const save = () => sub.run(async () => {
    const body = {
      title: finalTitle, event_type: type, start_date: start, end_date: effEnd, description: desc.trim(),
      ...(isHoliday ? { notify, notice_days: lead } : {}),
      ...(isDefaulter ? { course_id: courseId || null, semester: sem === "" ? null : Number(sem), from_date: fromDate } : {}),
    };
    if (editing) await headApi.put(`/calendar/${event.event_id}`, body);
    else await headApi.post("/calendar", body);
    onSaved(editing ? "Event updated." : isDefaulter ? "Defaulter list scheduled." : isHoliday && notify ? `Holiday added — the notice goes out ${leadText(lead)}.` : "Event added.");
  });

  return (
    <Modal
      title={editing ? "Edit event" : "Add to calendar"}
      sub="Holidays and defaulter lists run on their own — no further steps needed."
      onClose={onClose} busy={sub.busy} wide
      footer={
        <>
          <button type="button" className="mg-btn" onClick={onClose} disabled={sub.busy}>Cancel</button>
          <button type="button" className="mg-btn mg-btn--primary" onClick={save} disabled={!valid || sub.busy}>
            {sub.busy ? "Saving…" : editing ? "Save changes" : "Add"}
          </button>
        </>
      }
    >
      {sub.error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {sub.error}</span></div>}

      <div className="mg-field">
        <label className="mg-label" htmlFor="ac-type">Type</label>
        <select id="ac-type" className="mg-input" value={type} disabled={sub.busy} onChange={(e) => setType(e.target.value)}>
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      <div className="mg-field">
        <label className="mg-label" htmlFor="ac-title">Title</label>
        <input id="ac-title" className="mg-input" value={title} maxLength={120} disabled={sub.busy}
               placeholder={isDefaulter ? "Attendance defaulter list" : isHoliday ? "e.g. Diwali break" : type === "exam" ? "e.g. Mid-term exams" : "Title"}
               onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div className="ac-two">
        <div className="mg-field">
          <label className="mg-label" htmlFor="ac-start">{isDefaulter ? "Date" : "From"}</label>
          <input id="ac-start" type="date" className="mg-input" value={start} disabled={sub.busy}
                 onChange={(e) => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value); }} />
        </div>
        {!isDefaulter && (
          <div className="mg-field">
            <label className="mg-label" htmlFor="ac-end">Till <span className="mg-help">(same day if blank)</span></label>
            <input id="ac-end" type="date" className="mg-input" min={start} value={end} disabled={sub.busy} onChange={(e) => setEnd(e.target.value || start)} />
          </div>
        )}
      </div>

      {isHoliday && (
        <>
          <label className="ac-check">
            <input type="checkbox" checked={notify} disabled={sub.busy} onChange={(e) => setNotify(e.target.checked)} />
            <span>
              <strong>Notify students automatically</strong>
              <em>{notify ? "Your department's students get a notice about this holiday." : "No notice will be sent."}</em>
            </span>
          </label>
          {notify && (
            <div className="mg-field">
              <label className="mg-label" htmlFor="ac-lead">When should the notice go out?</label>
              <select id="ac-lead" className="mg-input" value={lead} disabled={sub.busy} onChange={(e) => setLead(Number(e.target.value))}>
                {(LEADS.some((l) => l.value === lead) ? LEADS : [...LEADS, { value: lead, label: leadText(lead) }]).map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
              <span className="mg-help">
                {sendOn <= todayIso() && start >= todayIso()
                  ? "That date is today or already passed, so the notice goes out right away."
                  : `Goes out on ${fmt(sendOn)} at 8:00 AM.`}
              </span>
            </div>
          )}
        </>
      )}

      {isDefaulter && (
        <>
          <div className="ac-two">
            <div className="mg-field">
              <label className="mg-label" htmlFor="ac-course">Course</label>
              <select id="ac-course" className="mg-input" value={courseId} disabled={sub.busy} onChange={(e) => { setCourseId(e.target.value); setSem(""); }}>
                <option value="">All courses of my department</option>
                {courses.map((c) => <option key={c.course_id} value={c.course_id}>{c.abbr}{c.course_name ? ` · ${c.course_name}` : ""}</option>)}
              </select>
            </div>
            <div className="mg-field">
              <label className="mg-label" htmlFor="ac-sem">Semester</label>
              <select id="ac-sem" className="mg-input" value={sem} disabled={sub.busy} onChange={(e) => setSem(e.target.value)}>
                <option value="">All semesters</option>
                {Array.from({ length: semCount }, (_, i) => <option key={i + 1} value={i + 1}>Semester {i + 1}</option>)}
              </select>
            </div>
          </div>
          <div className="mg-field">
            <label className="mg-label" htmlFor="ac-from">Count attendance from</label>
            <input id="ac-from" type="date" className="mg-input" max={start} value={fromDate} disabled={sub.busy}
                   onChange={(e) => { setFrom(e.target.value); setFromTouched(true); }} />
            <span className="mg-help">Every lecture from this date up to the day the list is generated is counted (not just one day).</span>
          </div>
          <div className="ac-info">
            On {fmt(start)} at 8:00 AM the system builds the list for every class, and announces it to the whole class.
            For each subject it shows the roll numbers with <strong>50% or less</strong> and with <strong>51% – 75%</strong> attendance.
            Classes with no defaulters get no notice.
          </div>
        </>
      )}

      <div className="mg-field">
        <label className="mg-label" htmlFor="ac-desc">{isHoliday ? "Note for students" : "Description"} <span className="mg-help">(optional)</span></label>
        <input id="ac-desc" className="mg-input" value={desc} maxLength={300} disabled={sub.busy} onChange={(e) => setDesc(e.target.value)} />
      </div>
    </Modal>
  );
}

function ConfirmDialog({ title, body, confirm, danger, onClose, onConfirm }) {
  const sub = useSubmit();
  return (
    <Modal title={title} onClose={onClose} busy={sub.busy}
      footer={
        <>
          <button type="button" className="mg-btn" onClick={onClose} disabled={sub.busy}>Cancel</button>
          <button type="button" className={`mg-btn ${danger ? "mg-btn--danger" : "mg-btn--primary"}`} disabled={sub.busy} onClick={() => sub.run(onConfirm)}>
            {sub.busy ? "Please wait…" : confirm}
          </button>
        </>
      }>
      {sub.error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {sub.error}</span></div>}
      <p className="ac-confirm">{body}</p>
    </Modal>
  );
}

// why a subject has nothing to count
function noLectureNote(r) {
  if (!r.lecture_slots) return "no timetable slot for this subject";
  if (!r.sessions_any) return "no lecture has been taken yet";
  if (!r.sessions_completed) return `${plural(r.sessions_any, "session")} started, none ended (completed) yet`;
  return `${plural(r.sessions_completed, "completed session")}, none inside this period`;
}

function ListDialog({ event, onClose }) {
  const [state, setState] = useState({ loading: true, error: "", lists: [], preview: false });
  const [idx, setIdx] = useState(0);
  useEscape(onClose, false);
  useEffect(() => {
    let live = true;
    headApi.get(`/calendar/${event.event_id}/defaulters`)
      .then((d) => live && setState({ loading: false, error: "", lists: d.lists || [], preview: !!d.preview }))
      .catch((err) => live && setState({ loading: false, error: err.message, lists: [], preview: false }));
    return () => { live = false; };
  }, [event.event_id]);

  const list = state.lists[idx];
  const roll = (arr) => (arr.length ? arr.map((i) => i.roll_no || i.name).join(", ") : "—");
  return (
    <Modal title={event.title} sub={state.preview ? "Preview — nothing has been announced yet" : "As announced to the class"} onClose={onClose} wide
      footer={<button type="button" className="mg-btn" onClick={onClose}>Close</button>}>
      {state.loading && <div className="mg-loading">Working out attendance…</div>}
      {state.error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {state.error}</span></div>}
      {!state.loading && !state.error && !state.lists.length && <div className="ac-info">No class with approved students was found for this event.</div>}
      {state.lists.length > 1 && (
        <div className="mg-pills" role="tablist">
          {state.lists.map((l, i) => (
            <button key={`${l.course_id}-${l.semester}`} type="button" role="tab" aria-selected={i === idx} className={`mg-pill${i === idx ? " mg-pill--active" : ""}`} onClick={() => setIdx(i)}>
              {l.course_abbr} · Sem {l.semester}
            </button>
          ))}
        </div>
      )}
      {list && (
        <div className="ac-list">
          <div className="ac-list-head">
            <strong>{list.course_abbr || list.course_name} · Semester {list.semester}</strong>
            <span>{plural(list.class_size, "student")} · {plural(list.total_defaulters, "defaulter")}</span>
          </div>
          <div className="ac-period">
            Attendance counted {list.since ? `from ${fmt(list.since)}` : "from the beginning"} to {fmt(list.until || list.as_on)}
          </div>
          <table className="ac-table">
            <thead><tr><th>Subject</th><th>50% or less</th><th>51% – 75%</th></tr></thead>
            <tbody>
              {list.subjects.map((r) => (
                <tr key={r.subject_id}>
                  <td><strong>{r.subject_code}</strong> {r.subject_name}<small>{r.total_lectures ? plural(r.total_lectures, "lecture") + " counted" : noLectureNote(r)}</small></td>
                  <td className="ac-roll">{r.total_lectures ? roll(r.below_50) : "—"}</td>
                  <td className="ac-roll">{r.total_lectures ? roll(r.from_51_to_75) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ── month grid ───────────────────────────────────────────────────────────────
function MonthGrid({ month, events, today, onPrev, onNext, onToday, onDay, onEvent }) {
  const { y, m } = month;
  const first = new Date(Date.UTC(y, m, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);

  return (
    <section className="ac-month" aria-label="Month view">
      <div className="ac-month-head">
        <button type="button" className="mg-btn" onClick={onPrev} aria-label="Previous month">‹</button>
        <h3 className="ac-month-title">{MONTHS[m]} {y}</h3>
        <button type="button" className="mg-btn" onClick={onNext} aria-label="Next month">›</button>
        <button type="button" className="mg-btn ac-today" onClick={onToday}>Today</button>
      </div>
      <div className="ac-grid" role="grid">
        {WEEK.map((w) => <div key={w} className="ac-dow" role="columnheader">{w}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={i} className="ac-cell ac-cell--blank" />;
          const iso = isoOf(y, m, d);
          const here = events.filter((e) => e.start_date <= iso && iso <= (e.end_date || e.start_date));
          return (
            <div key={i} className={`ac-cell${iso === today ? " ac-cell--today" : ""}${(i % 7) === 6 ? " ac-cell--sun" : ""}`} role="gridcell"
                 onClick={(ev) => ev.target === ev.currentTarget && onDay(iso)}>
              <span className="ac-day" onClick={() => onDay(iso)}>{d}</span>
              {here.slice(0, 3).map((e) => (
                <button key={e.event_id} type="button" className={`ac-chip ac-chip--${e.event_type}`} title={`${typeLabel(e.event_type)} · ${e.title}`} onClick={() => onEvent(e)}>
                  {e.title}
                </button>
              ))}
              {here.length > 3 && <span className="ac-more">+{here.length - 3} more</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function CalendarPage() {
  const today = todayIso();
  const [ctx, setCtx] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [modal, setModal] = useState(null);
  const [year, setYear] = useState(academicYear(today));
  const [filter, setFilter] = useState("all");
  const [month, setMonth] = useState({ y: +today.slice(0, 4), m: +today.slice(5, 7) - 1 });

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [c, cal] = await Promise.all([headApi.get("/context"), headApi.get("/calendar")]);
      setCtx(c); setEvents(cal.events || []);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!notice || notice.type === "warn") return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // a notice may go out a moment after the page loads — look again shortly
  const reloadQuiet = useCallback(() => headApi.get("/calendar").then((d) => setEvents(d.events || [])).catch(() => {}), []);
  const closeModal = useCallback(() => setModal(null), []);
  const saved = (text) => { setModal(null); setNotice({ type: "success", text }); setTimeout(reloadQuiet, 1500); load(); };

  const years = useMemo(() => {
    const s = new Set([academicYear(today), year]);
    events.forEach((e) => e.academic_year && s.add(e.academic_year));
    return [...s].sort().reverse();
  }, [events, year, today]);

  const inYear = useMemo(() => events.filter((e) => (e.academic_year || academicYear(e.start_date)) === year), [events, year]);
  const shown = useMemo(() => inYear.filter((e) => filter === "all" || e.event_type === filter), [inYear, filter]);
  const courses = ctx?.courses || [];

  const gotoMonth = (d) => setMonth(({ y, m }) => { const t = m + d; return { y: y + Math.floor(t / 12), m: ((t % 12) + 12) % 12 }; });

  const run = (e, force) => headApi.post(`/calendar/${e.event_id}/run`, force ? { force: true } : {}).then((r) => {
    setModal(null);
    setNotice({ type: "success", text: e.event_type === "holiday" ? `Notice sent to ${plural(r.recipients ?? 0, "student")}.` : `Defaulter list announced for ${plural(r.runs?.length || 0, "class")}.` });
    load();
  });
  const remove = (e) => headApi.del(`/calendar/${e.event_id}`).then(() => { setModal(null); setNotice({ type: "success", text: "Event deleted." }); load(); });

  const counts = useMemo(() => {
    const c = {}; inYear.forEach((e) => { c[e.event_type] = (c[e.event_type] || 0) + 1; }); return c;
  }, [inYear]);

  return (
    <ManageShell
      title="Academic Calendar"
      subtitle="Holidays, exams and events. Holiday notices and defaulter lists go out automatically."
      actions={<button className="mg-btn mg-btn--primary" onClick={() => setModal({ type: "event" })}>+ Add event</button>}
    >
      {error && (
        <div className="mg-banner mg-banner--error" role="alert">
          <span className="mg-banner-text">⚠ {error}</span>
          <button className="mg-banner-action" onClick={load}>Retry</button>
        </div>
      )}
      {notice && (
        <div className={`mg-banner mg-banner--${notice.type}`} role="status">
          <span className="mg-banner-text">{notice.type === "success" ? "✓ " : ""}{notice.text}</span>
          <button className="mg-banner-action" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="ac-toolbar">
        <div className="mg-field ac-year">
          <label className="mg-label" htmlFor="ac-year">Academic year</label>
          <select id="ac-year" className="mg-input" value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="mg-pills" role="tablist" aria-label="Filter by type">
          <button type="button" role="tab" aria-selected={filter === "all"} className={`mg-pill${filter === "all" ? " mg-pill--active" : ""}`} onClick={() => setFilter("all")}>All ({inYear.length})</button>
          {TYPES.filter((t) => counts[t.value]).map((t) => (
            <button key={t.value} type="button" role="tab" aria-selected={filter === t.value} className={`mg-pill${filter === t.value ? " mg-pill--active" : ""}`} onClick={() => setFilter(t.value)}>
              {t.plural} ({counts[t.value]})
            </button>
          ))}
        </div>
      </div>

      {loading && !ctx && <div className="mg-loading">Loading calendar…</div>}

      {ctx && (
        <>
          <MonthGrid month={month} events={shown} today={today}
                     onPrev={() => gotoMonth(-1)} onNext={() => gotoMonth(1)} onToday={() => setMonth({ y: +today.slice(0, 4), m: +today.slice(5, 7) - 1 })}
                     onDay={(date) => setModal({ type: "event", defaults: { date } })}
                     onEvent={(e) => document.getElementById(`ev-${e.event_id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })} />

          <section className="ac-events" aria-label="Events">
            <h3 className="ac-events-title">{filter === "all" ? "All events" : typeLabel(filter) + "s"} · {year}</h3>
            {shown.length === 0 && (
              <div className="mg-empty">
                <div className="mg-empty-title">Nothing here yet</div>
                Add a holiday, an exam date, or a defaulter list — click “+ Add event”, or any day in the calendar.
              </div>
            )}
            {shown.map((e) => {
              const line = autoLine(e);
              const past = (e.end_date || e.start_date) < today;
              return (
                <article key={e.event_id} id={`ev-${e.event_id}`} className={`ac-event${past ? " ac-event--past" : ""}`}>
                  <div className={`ac-badge ac-chip--${e.event_type}`}>{typeLabel(e.event_type)}</div>
                  <div className="ac-event-main">
                    <div className="ac-event-title">
                      {e.title}
                      {e.scope === "institute" && <span className="ac-scope">Institute</span>}
                    </div>
                    <div className="ac-event-date">{range(e)}</div>
                    {e.description && <div className="ac-event-desc">{e.description}</div>}
                    {e.event_type === "defaulter" && e.automation && (
                      <div className="ac-event-desc">
                        {e.automation.course_id ? courses.find((c) => c.course_id === e.automation.course_id)?.abbr || "One course" : "All courses"}
                        {" · "}{e.automation.semester ? `Semester ${e.automation.semester}` : "all semesters"}
                        {e.automation.from_date ? ` · counting from ${fmt(e.automation.from_date)}` : ""}
                      </div>
                    )}
                    {line && <div className={`ac-auto ac-auto--${line.tone}`}>{line.text}</div>}
                  </div>
                  {e.editable && (
                    <div className="ac-actions">
                      {e.event_type === "holiday" && e.automation?.enabled && e.automation.status !== "sent" && (
                        <button type="button" className="mg-btn" onClick={() => setModal({ type: "run", event: e })}>Send notice now</button>
                      )}
                      {e.event_type === "defaulter" && (
                        <>
                          <button type="button" className="mg-btn" onClick={() => setModal({ type: "list", event: e })}>{e.automation?.status === "sent" ? "View lists" : "Preview"}</button>
                          <button type="button" className="mg-btn" onClick={() => setModal({ type: "run", event: e })}>{e.automation?.status === "sent" ? "Run again" : "Generate now"}</button>
                        </>
                      )}
                      <button type="button" className="mg-btn" onClick={() => setModal({ type: "event", event: e })}>Edit</button>
                      <button type="button" className="mg-btn mg-btn--danger" onClick={() => setModal({ type: "delete", event: e })}>Delete</button>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        </>
      )}

      {modal?.type === "event" && (
        <EventDialog event={modal.event} defaults={modal.defaults} courses={courses} onClose={closeModal} onSaved={saved} />
      )}
      {modal?.type === "list" && <ListDialog event={modal.event} onClose={closeModal} />}
      {modal?.type === "run" && (() => {
        const e = modal.event, again = e.automation?.status === "sent";
        return (
          <ConfirmDialog
            title={e.event_type === "holiday" ? "Send notice now?" : again ? "Run the defaulter list again?" : "Generate the defaulter list now?"}
            body={e.event_type === "holiday"
              ? `Your department's students will get the notice for “${e.title}” right away instead of on ${fmt(e.automation.send_on)}.`
              : again
                ? "The list is rebuilt from today's attendance and announced to each class again as a new notice."
                : "The list is built from today's attendance and announced to each class right away, instead of on the scheduled date."}
            confirm={e.event_type === "holiday" ? "Send notice" : again ? "Run again" : "Generate & announce"}
            onClose={closeModal} onConfirm={() => run(e, again)} />
        );
      })()}
      {modal?.type === "delete" && (
        <ConfirmDialog danger title="Delete this event?"
          body={`“${modal.event.title}” will be removed from the calendar.${modal.event.automation?.status === "sent" ? " The notice that was already sent stays in the students' inbox." : modal.event.automation?.status === "pending" ? " Its automatic notice will not be sent." : ""}`}
          confirm="Delete" onClose={closeModal} onConfirm={() => remove(modal.event)} />
      )}
    </ManageShell>
  );
}