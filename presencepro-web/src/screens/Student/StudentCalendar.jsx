// @ts-nocheck
// Student web: academic calendar of my department (holidays, exams, events). Route: /dashboard/student/calendar
import { useCallback, useEffect, useMemo, useState } from "react";
import { getUserSession } from "../../services/session";
import { StudentShell, PageHeader, Skeleton, Empty, ErrorBox } from "./ui";
import { studentGet } from "./StudentTimetable";
import "./StudentCalendar.css";

const TYPES = {
  holiday: { label: "Holiday", color: "#DC2626", bg: "#FEE2E2" },
  exam: { label: "Exam", color: "#B45309", bg: "#FEF3C7" },
  event: { label: "Event", color: "#2563EB", bg: "#DBEAFE" },
  working_day_swap: { label: "Working-day swap", color: "#7C3AED", bg: "#EDE9FE" },
  general: { label: "Notice", color: "#4B5563", bg: "#F3F4F6" },
};
const typeOf = (e) => TYPES[e.event_type] || TYPES.general;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const fmtLong = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtShort = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const range = (e) => (e.end_date && e.end_date !== e.start_date ? `${fmtShort(e.start_date)} – ${fmtShort(e.end_date)}` : fmtShort(e.start_date));
const covers = (e, d) => e.start_date <= d && d <= (e.end_date || e.start_date);

export default function StudentCalendar() {
  const uid = getUserSession()?.user?.uid;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const now = new Date();
  const todayStr = ymd(now.getFullYear(), now.getMonth(), now.getDate());
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [selected, setSelected] = useState(todayStr);

  const load = useCallback(async () => {
    if (!uid) return;
    setLoading(true); setError("");
    try { setData(await studentGet(`/api/web/student/calendar?uid=${encodeURIComponent(uid)}`)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  const events = data?.events || [];
  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const lead = (first.getDay() + 6) % 7;                       // week starts on Monday
    const days = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const out = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= days; d++) out.push(ymd(cursor.y, cursor.m, d));
    while (out.length % 7) out.push(null);
    return out;
  }, [cursor]);

  const move = (n) => setCursor(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const goToday = () => { setCursor({ y: now.getFullYear(), m: now.getMonth() }); setSelected(todayStr); };
  const onDay = (events_, d) => events_.filter((e) => covers(e, d));
  const picked = selected ? onDay(events, selected) : [];
  const upcoming = events.filter((e) => (e.end_date || e.start_date) >= todayStr).slice(0, 8);

  return (
    <StudentShell title="Academic calendar">
      <PageHeader title="Academic calendar" sub="Holidays, exams and events of your department." />
      <ErrorBox error={error} onRetry={load} />
      {loading ? <Skeleton rows={4} height={110} /> : error ? null : (
        <div className="stc-layout">
          <div className="st-card stc-month">
            <div className="stc-head">
              <button className="st-btn st-btn--ghost" onClick={() => move(-1)} aria-label="Previous month">‹</button>
              <h2>{MONTHS[cursor.m]} {cursor.y}</h2>
              <button className="st-btn st-btn--ghost" onClick={() => move(1)} aria-label="Next month">›</button>
              <button className="st-btn st-btn--ghost stc-today" onClick={goToday}>Today</button>
            </div>
            <div className="stc-grid stc-dow">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d}>{d}</div>)}</div>
            <div className="stc-grid">
              {cells.map((d, i) => {
                if (!d) return <div key={i} className="stc-cell stc-cell--blank" />;
                const list = onDay(events, d);
                const isToday = d === todayStr, on = d === selected;
                return (
                  <button key={d} className={`stc-cell${isToday ? " stc-cell--today" : ""}${on ? " stc-cell--on" : ""}`} onClick={() => setSelected(d)} aria-label={`${fmtLong(d)}${list.length ? `, ${list.length} event${list.length > 1 ? "s" : ""}` : ""}`}>
                    <span className="stc-num">{+d.slice(8)}</span>
                    {list.slice(0, 2).map((e) => <span key={e.event_id} className="stc-tag" style={{ background: typeOf(e).bg, color: typeOf(e).color }}>{e.title}</span>)}
                    {list.length > 2 && <span className="stc-more">+{list.length - 2} more</span>}
                  </button>
                );
              })}
            </div>
            <div className="stc-legend">{Object.values(TYPES).map((t) => <span key={t.label}><i style={{ background: t.color }} />{t.label}</span>)}</div>
          </div>

          <aside className="stc-side">
            <div className="st-card">
              <div className="st-h2" style={{ marginBottom: 8 }}>{selected ? fmtLong(selected) : "Pick a day"}</div>
              {picked.length === 0 ? <div className="st-sub">Nothing on this day.</div> : picked.map((e) => (
                <div key={e.event_id} className="stc-ev" style={{ borderLeftColor: typeOf(e).color }}>
                  <div className="stc-ev-title">{e.title}</div>
                  <div className="stc-ev-meta"><span style={{ color: typeOf(e).color }}>{typeOf(e).label}</span> · {range(e)}</div>
                  {e.description && <div className="stc-ev-desc">{e.description}</div>}
                </div>
              ))}
            </div>
            <div className="st-card">
              <div className="st-h2" style={{ marginBottom: 8 }}>Coming up</div>
              {upcoming.length === 0 ? <div className="st-sub">No upcoming events.</div> : upcoming.map((e) => (
                <button key={e.event_id} className="stc-up" onClick={() => { setSelected(e.start_date > todayStr ? e.start_date : todayStr); const d = new Date(`${(e.start_date > todayStr ? e.start_date : todayStr)}T12:00:00`); setCursor({ y: d.getFullYear(), m: d.getMonth() }); }}>
                  <i style={{ background: typeOf(e).color }} />
                  <span><b>{e.title}</b><small>{range(e)} · {typeOf(e).label}</small></span>
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}
      {!loading && !error && events.length === 0 && <Empty icon="📅" title="Nothing on the calendar yet" text="Your department hasn't added holidays or events yet." />}
    </StudentShell>
  );
}