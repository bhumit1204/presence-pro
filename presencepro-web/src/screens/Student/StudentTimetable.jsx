// @ts-nocheck
// Student web: "My timetable" — the weekly timetable of MY semester, division and lab batch (+ my electives),
// today's classes, and the one-day changes (changed room/time/teacher, cancelled, special sessions) of the next two weeks.
// Route: /dashboard/student/timetable
import { useCallback, useEffect, useMemo, useState } from "react";
import { getUserSession, getSessionToken } from "../../services/session";
import { auth } from "../../services/firebase";
import { StudentShell, PageHeader, Tabs, Skeleton, Empty, ErrorBox, Pill, subjectColor } from "./ui";
import "./StudentTimetable.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function authHeaders() {
  let token = getSessionToken();
  try { if (auth.currentUser) token = await auth.currentUser.getIdToken(); } catch { /* use the stored token */ }
  return token ? { Authorization: `Bearer ${token}` } : {};
}
export async function studentGet(path) {
  const res = await fetch(`${API}${path}`, { headers: await authHeaders() });
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(data.error || (res.status === 401 ? "Please log in again" : `Request failed (${res.status})`));
  return data;
}

const fmt12 = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};
const toMin = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const fmtDay = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

function Chips({ l }) {
  return (
    <>
      {l.kind_label && <Pill tone={l.kind === "lab" ? "purple" : "blue"}>{l.kind_label}</Pill>}
      {l.batch && <Pill tone="amber">Batch {l.batch}</Pill>}
      {l.elective && <Pill tone="gray">Elective</Pill>}
    </>
  );
}

function LectureCard({ l, live, next }) {
  const color = subjectColor(l.subject_id);
  return (
    <div className={`stt-card${live ? " stt-card--live" : ""}`} style={{ borderLeftColor: color }}>
      <div className="stt-time">{fmt12(l.start_time)} – {fmt12(l.end_time)}{live && <span className="stt-live">Now</span>}{!live && next && <span className="stt-next">Next</span>}</div>
      <div className="stt-name">{l.subject_name}</div>
      <div className="stt-chips"><Chips l={l} /></div>
      <div className="stt-meta">
        {l.room && <span>📍 {l.room}</span>}
        {l.teacher_name && <span>👤 {l.teacher_name}</span>}
      </div>
    </div>
  );
}

function ChangeRow({ c }) {
  const label = c.kind === "cancel" ? "Cancelled" : c.kind === "special" ? "Special session" : "Changed";
  const tone = c.kind === "cancel" ? "red" : c.kind === "special" ? "green" : "amber";
  const was = c.was;
  const bits = [];
  if (was) {
    if (c.start_time !== was.start_time || c.end_time !== was.end_time) bits.push(`time ${fmt12(was.start_time)}–${fmt12(was.end_time)} → ${fmt12(c.start_time)}–${fmt12(c.end_time)}`);
    if ((c.room || "") !== (was.room || "")) bits.push(`room ${was.room || "—"} → ${c.room || "—"}`);
    if (c.teacher_name !== was.teacher_name) bits.push(`teacher ${was.teacher_name || "—"} → ${c.teacher_name || "—"}`);
  }
  return (
    <div className="stt-change">
      <div className="stt-change-date">{fmtDay(c.date)}</div>
      <div className="stt-change-body">
        <div className="stt-name">{c.subject_name || "Class"} <Pill tone={tone}>{label}</Pill>{c.kind_label && <Pill tone="purple">{c.kind_label}</Pill>}{c.batch && <Pill tone="amber">Batch {c.batch}</Pill>}</div>
        <div className="stt-meta">
          {c.kind !== "cancel" && <span>🕐 {fmt12(c.start_time)} – {fmt12(c.end_time)}</span>}
          {c.kind !== "cancel" && c.room && <span>📍 {c.room}</span>}
          {c.kind !== "cancel" && c.teacher_name && <span>👤 {c.teacher_name}</span>}
          {c.kind === "cancel" && <span>{fmt12(c.start_time)} – {fmt12(c.end_time)}</span>}
        </div>
        {bits.length > 0 && <div className="stt-diff">{bits.join(" · ")}</div>}
        {c.kind === "special" && c.replaces?.length > 0 && <div className="stt-diff">Replaces {c.replaces.join(", ")}</div>}
        {c.note && <div className="stt-note">{c.note}</div>}
      </div>
    </div>
  );
}

export default function StudentTimetable() {
  const uid = getUserSession()?.user?.uid;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("today");
  const [day, setDay] = useState(WEEKDAYS[new Date().getDay()]);
  const [nowMin, setNowMin] = useState(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });

  const load = useCallback(async () => {
    if (!uid) return;
    setLoading(true); setError("");
    try { setData(await studentGet(`/api/web/student/timetable?uid=${encodeURIComponent(uid)}`)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => { const d = new Date(); setNowMin(d.getHours() * 60 + d.getMinutes()); }, 60000); return () => clearInterval(t); }, []);

  const todayName = WEEKDAYS[new Date().getDay()];
  const days = data?.days || {};
  const activeDays = DAYS.filter((d) => (days[d] || []).length > 0 || d === todayName || d !== "Sunday");
  const total = (data?.lectures || []).length;
  const changes = data?.changes || [];
  const soon = changes.slice(0, 3);
  const s = data?.student;

  const todays = days[todayName] || [];
  const nextIdx = useMemo(() => todays.findIndex((l) => toMin(l.start_time) > nowMin), [todays, nowMin]);
  const sub = s ? [s.course_abbr || s.course_name, s.semester != null ? `Semester ${String(s.semester).replace(/\D/g, "") || s.semester}` : null, s.division_name ? `Division ${s.division_name}` : null, s.roll_no ? `Roll ${s.roll_no}` : null].filter(Boolean).join(" · ") : "Your classes for the week.";

  return (
    <StudentShell title="My timetable">
      <PageHeader title="My timetable" sub={sub} />
      <ErrorBox error={error} onRetry={load} />

      {!loading && !error && s && !s.division_id && total > 0 && (
        <div className="stt-hint">You are not in a division yet, so only classes common to everyone are shown. Your head of department assigns divisions.</div>
      )}

      <div className="st-card" style={{ padding: "0 8px" }}>
        <Tabs value={tab} onChange={setTab} tabs={[
          { key: "today", label: "Today" },
          { key: "week", label: "Week" },
          { key: "changes", label: "Changes", count: changes.length },
        ]} />
      </div>

      {loading ? <Skeleton rows={4} height={90} /> : error ? null : total === 0 && changes.length === 0 ? (
        <Empty icon="🗓️" title="No timetable yet" text="Your department hasn't published a timetable for your semester yet." />
      ) : tab === "today" ? (
        <>
          <div className="stt-dayhead"><strong>{todayName}</strong><span>{new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long" })}</span></div>
          {todays.length === 0 ? <Empty icon="🎉" title="No classes today" text="Enjoy the free day." /> : (
            <div className="stt-list">
              {todays.map((l, i) => <LectureCard key={l.lecture_id} l={l} live={toMin(l.start_time) <= nowMin && nowMin < toMin(l.end_time)} next={i === nextIdx} />)}
            </div>
          )}
          {soon.length > 0 && (
            <>
              <div className="stt-dayhead"><strong>Coming up</strong><span>changes to your classes</span></div>
              <div className="st-card st-card--flat">{soon.map((c, i) => <ChangeRow key={i} c={c} />)}</div>
            </>
          )}
        </>
      ) : tab === "week" ? (
        <>
          <div className="stt-daytabs">
            {activeDays.map((d) => (
              <button key={d} className={`stt-daytab${d === day ? " stt-daytab--on" : ""}${d === todayName ? " stt-daytab--today" : ""}`} onClick={() => setDay(d)}>
                {d.slice(0, 3)}<span>{(days[d] || []).length || ""}</span>
              </button>
            ))}
          </div>
          <div className="stt-week">
            {activeDays.map((d) => (
              <section key={d} className={`stt-col${d === day ? " stt-col--sel" : ""}${d === todayName ? " stt-col--today" : ""}`}>
                <h3>{d}</h3>
                {(days[d] || []).length === 0 ? <div className="stt-empty">No classes</div> : days[d].map((l) => <LectureCard key={l.lecture_id} l={l} />)}
              </section>
            ))}
          </div>
        </>
      ) : (
        changes.length === 0 ? <Empty icon="✅" title="No changes coming up" text="Cancelled, moved and special classes of the next two weeks appear here." /> : (
          <div className="st-card st-card--flat">{changes.map((c, i) => <ChangeRow key={i} c={c} />)}</div>
        )
      )}
    </StudentShell>
  );
}