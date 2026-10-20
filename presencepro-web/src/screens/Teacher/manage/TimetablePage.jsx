// @ts-nocheck
/**
 * TimetablePage.jsx — Manage → Timetable (head only)
 *
 * A real weekly timetable (days × time) for one semester, printable with the
 * college / course / semester / duration on top.
 *
 *  Permanent changes   add / edit / delete the weekly slot (any length, own teacher for a slot)
 *  Temporary changes   one date only: another teacher / time / room, cancel, or a special
 *                      session. Applied on that day, then the timetable returns to normal by itself.
 *
 * Backend: /api/web/head   GET /context  GET /teachers  GET /timetable
 *   POST /timetable  PUT|DELETE /timetable/:id  POST /timetable/overrides  DELETE /timetable/overrides/:id
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ManageShell from "../../../components/ManageShell";
import { headApi } from "../../../services/headApi";
import "./TimetablePage.css";

// ── helpers ──────────────────────────────────────────────────────────────────
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PALETTE = [
  ["#EEEBFB", "#4834D4"], ["#DBEAFE", "#1D4ED8"], ["#D1FAE5", "#047857"], ["#FEF3C7", "#B45309"],
  ["#FCE7F3", "#BE185D"], ["#E0F2FE", "#0369A1"], ["#FEE2E2", "#B91C1C"], ["#ECFCCB", "#4D7C0F"],
];
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const pad = (n) => String(n).padStart(2, "0");
const toMin = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;
const fmtDate = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const fmtShort = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  return `${DAYS[(d.getUTCDay() + 6) % 7].slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const dur = (s, e) => { const m = toMin(e) - toMin(s); return m > 0 ? `${m >= 60 ? `${Math.floor(m / 60)}h` : ""}${m % 60 ? ` ${m % 60}m` : ""}`.trim() : ""; };
const weekdayOf = (iso) => DAYS[(new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7];
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// next `count` dates (from today) that fall on `day`
function upcomingDates(today, day, count = 10) {
  const out = [];
  for (let i = 0; i < 120 && out.length < count; i++) {
    const d = addDays(today, i);
    if (weekdayOf(d) === day) out.push(d);
  }
  return out;
}

// ── shared bits ──────────────────────────────────────────────────────────────
function TeacherSelect({ id, teachers, value, onChange, disabled, defaultLabel }) {
  const sorted = useMemo(
    () => [...teachers].sort((a, b) => Number(b.in_department) - Number(a.in_department) || a.name.localeCompare(b.name)),
    [teachers],
  );
  return (
    <select id={id} className="mg-input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{defaultLabel}</option>
      {sorted.map((t) => (
        <option key={t.teacher_id} value={t.teacher_id}>
          {t.name}{t.in_department ? "" : " (other dept)"}
        </option>
      ))}
    </select>
  );
}

function ConflictBox({ conflicts }) {
  if (!conflicts.length) return null;
  return (
    <div className="mg-banner mg-banner--warn" role="alert">
      <div className="tt-conflicts">
        <strong>This clashes with another session</strong>
        <ul>{conflicts.map((c, i) => <li key={i}>{c.message}</li>)}</ul>
        <span>You can still save it — for example when you are sure the clash is intended.</span>
      </div>
    </div>
  );
}

// Two lectures compete for the same students unless they belong to two different divisions.
const sharesStudents = (a, b) => !a || !b || a === b;

function ApplyTo({ id, divisions, value, onChange, disabled, locked }) {
  if (!divisions.length) return null;
  return (
    <div className="mg-field">
      <label className="mg-label" htmlFor={id}>Applies to</label>
      <select id={id} className="mg-input" value={value} disabled={disabled || locked} onChange={(e) => onChange(e.target.value)}>
        <option value="">All students (every division)</option>
        {divisions.map((d) => <option key={d.division_id} value={d.division_id}>Division {d.name} only</option>)}
      </select>
      <span className="mg-help">
        {value
          ? "Only this division sees the lecture and its attendance. Give it its own teacher below if a different teacher takes this division."
          : "A common lecture: students of all divisions attend it together."}
      </span>
    </div>
  );
}

function OverlapPicker({ items, picked, onToggle, disabled, title }) {
  if (!items.length) return null;
  return (
    <fieldset className="tt-replace">
      <legend>{title}</legend>
      {items.map((l) => (
        <label key={l.lecture_id} className="tt-check">
          <input type="checkbox" checked={picked.includes(l.lecture_id)} disabled={disabled} onChange={() => onToggle(l.lecture_id)} />
          <span>
            <strong>{l.subject_code || l.subject_name}</strong>{l.division_name ? ` (${l.division_name})` : ""} {l.start_time}–{l.end_time}
            {l.teacher_name ? ` · ${l.teacher_name}` : ""}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

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
        <div className="mg-modal-footer">{footer}</div>
      </div>
    </div>
  );
}

// Runs a request; a 409 that carries `conflicts` turns into a "Save anyway" state.
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflicts, setConflicts] = useState([]);
  const run = async (fn) => {
    setBusy(true); setError("");
    try { await fn(); return true; }
    catch (err) {
      if (err.status === 409 && err.data?.conflicts?.length) setConflicts(err.data.conflicts);
      else { setConflicts([]); setError(err.message); }
      setBusy(false);
      return false;
    }
  };
  return { busy, error, conflicts, run, setConflicts, setError, setBusy };
}

// ── Add / edit a weekly slot (permanent) ─────────────────────────────────────
function LectureDialog({ mode, lecture, defaults, data, teachers, course, semester, onClose, onSaved, onChangeDay }) {
  const editing = mode === "edit";
  const [subjectId, setSubjectId] = useState(lecture?.subject_id || (editing ? "" : data.subjects[0]?.subject_id || ""));
  const [day, setDay] = useState(lecture?.day || defaults?.day || "Monday");
  const [start, setStart] = useState(lecture?.start_time || defaults?.start || "09:00");
  const [end, setEnd] = useState(lecture?.end_time || defaults?.end || "10:00");
  const [room, setRoom] = useState(lecture?.room || "");
  const initialTeacher = editing && lecture.teacher_pinned ? lecture.teacher_id : "";
  const [teacher, setTeacher] = useState(initialTeacher || "");
  const initialDivision = editing ? lecture.division_id || "" : defaults?.division || "";
  const [division, setDivision] = useState(initialDivision);
  const [replace, setReplace] = useState([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sub = useSubmit();

  const subject = data.subjects.find((s) => s.subject_id === subjectId);
  const custom = editing && !lecture.subject_id;
  const valid = (subjectId || custom) && toMin(end) > toMin(start);
  const clashing = !editing && valid
    ? data.lectures.filter((l) => l.day === day && sharesStudents(l.division_id || "", division) && overlaps(toMin(start), toMin(end), toMin(l.start_time), toMin(l.end_time)))
    : [];
  useEffect(() => { setReplace((r) => r.filter((id) => clashing.some((l) => l.lecture_id === id))); }, [day, start, end, division]); // eslint-disable-line

  const save = (force) => sub.run(async () => {
    if (editing) {
      const body = { day, start_time: start, end_time: end, room, force: force || undefined };
      if (teacher !== initialTeacher) body.teacher_id = teacher || subject?.teacher_assigned || lecture.teacher_id;
      if (division !== initialDivision) body.division_id = division || null;
      await headApi.put(`/timetable/${lecture.lecture_id}`, body);
      onSaved("Lecture updated for every week.");
    } else {
      const res = await headApi.post("/timetable", {
        course_id: course.course_id, subject_id: subjectId, day, start_time: start, end_time: end, room,
        teacher_id: teacher || undefined, division_id: division || undefined, replaces: replace.length ? replace : undefined, force: force || undefined,
      });
      onSaved(`Lecture added to ${day}${res.replaced ? ` (replaced ${plural(res.replaced, "lecture")})` : ""}.`);
    }
  });

  const remove = () => sub.run(async () => {
    await headApi.del(`/timetable/${lecture.lecture_id}`);
    onSaved("Lecture removed from the timetable.");
  });

  return (
    <Modal
      title={editing ? "Edit lecture" : "Add lecture"}
      sub={`${course.abbr} · Semester ${semester} · every week`}
      onClose={onClose} busy={sub.busy} wide
      footer={
        <>
          {editing && (
            confirmDelete ? (
              <button type="button" className="mg-btn mg-btn--danger" onClick={remove} disabled={sub.busy}>Yes, delete this lecture</button>
            ) : (
              <button type="button" className="mg-btn mg-btn--danger" onClick={() => setConfirmDelete(true)} disabled={sub.busy}>Delete</button>
            )
          )}
          <button type="button" className="mg-btn" onClick={onClose} disabled={sub.busy}>Cancel</button>
          {sub.conflicts.length > 0 ? (
            <button type="button" className="mg-btn mg-btn--danger" onClick={() => save(true)} disabled={sub.busy}>Save anyway</button>
          ) : (
            <button type="button" className="mg-btn mg-btn--primary" onClick={() => save(false)} disabled={!valid || sub.busy}>
              {sub.busy ? "Saving…" : editing ? "Save changes" : "Add lecture"}
            </button>
          )}
        </>
      }
    >
      <div className="mg-field">
        <label className="mg-label" htmlFor="tt-subject">Subject</label>
        <select id="tt-subject" className="mg-input" value={subjectId} disabled={sub.busy || editing} onChange={(e) => setSubjectId(e.target.value)}>
          {custom && <option value="">{lecture.subject_name} (special session)</option>}
          {data.subjects.map((s) => <option key={s.subject_id} value={s.subject_id}>{s.subject_code} · {s.subject_name}</option>)}
        </select>
      </div>
      <ApplyTo id="tt-div" divisions={data.divisions || []} value={division} disabled={sub.busy}
               onChange={(v) => { setDivision(v); sub.setConflicts([]); }} />
      <div className="tt-two">
        <div className="mg-field">
          <label className="mg-label" htmlFor="tt-day">Day</label>
          <select id="tt-day" className="mg-input" value={day} disabled={sub.busy} onChange={(e) => { setDay(e.target.value); sub.setConflicts([]); }}>
            {DAYS.map((d) => <option key={d}>{d}</option>)}
          </select>
        </div>
        <div className="mg-field">
          <label className="mg-label" htmlFor="tt-room">Room</label>
          <input id="tt-room" className="mg-input" value={room} maxLength={30} disabled={sub.busy} placeholder="e.g. Lab-1" onChange={(e) => setRoom(e.target.value)} />
        </div>
      </div>
      <div className="tt-two">
        <div className="mg-field">
          <label className="mg-label" htmlFor="tt-start">Starts</label>
          <input id="tt-start" type="time" className="mg-input" value={start} disabled={sub.busy} onChange={(e) => { setStart(e.target.value); sub.setConflicts([]); }} />
        </div>
        <div className="mg-field">
          <label className="mg-label" htmlFor="tt-end">Ends</label>
          <input id="tt-end" type="time" className="mg-input" value={end} disabled={sub.busy} onChange={(e) => { setEnd(e.target.value); sub.setConflicts([]); }} />
        </div>
      </div>
      {valid
        ? <span className="mg-help">Length: {dur(start, end)} — any length works, for example 2 hours for a double lecture.</span>
        : <span className="tt-invalid">End time must be after the start time.</span>}

      <div className="mg-field">
        <label className="mg-label" htmlFor="tt-teacher">Teacher</label>
        <TeacherSelect id="tt-teacher" teachers={teachers} value={teacher} disabled={sub.busy} onChange={(v) => { setTeacher(v); sub.setConflicts([]); }}
                       defaultLabel={subject?.teacher_name ? `Subject's teacher — ${subject.teacher_name}` : "Subject's teacher (none assigned yet)"} />
        <span className="mg-help">Pick someone else to give this slot its own teacher, without changing the subject's teacher.</span>
      </div>

      <OverlapPicker items={clashing} picked={replace} disabled={sub.busy}
                     onToggle={(id) => { setReplace((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id])); sub.setConflicts([]); }}
                     title="These lectures overlap the new time — tick the ones it replaces" />

      {editing && (
        <button type="button" className="tt-linkrow" onClick={() => onChangeDay(lecture)} disabled={sub.busy}>
          Need a change for one day only? <span>Change for one day →</span>
        </button>
      )}
      <ConflictBox conflicts={sub.conflicts} />
      {sub.error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {sub.error}</span></div>}
    </Modal>
  );
}

// ── Change one lecture for ONE date (temporary) ──────────────────────────────
function OneDayDialog({ lecture, data, teachers, course, semester, onClose, onSaved }) {
  const dates = useMemo(() => upcomingDates(data.today, lecture.day, 10), [data.today, lecture.day]);
  const [date, setDate] = useState(dates[0]);
  const [what, setWhat] = useState("modify"); // modify | cancel
  const [teacher, setTeacher] = useState("");
  const [start, setStart] = useState(lecture.start_time);
  const [end, setEnd] = useState(lecture.end_time);
  const [room, setRoom] = useState(lecture.room || "");
  const [note, setNote] = useState("");
  const sub = useSubmit();

  const changed = teacher || start !== lecture.start_time || end !== lecture.end_time || room !== (lecture.room || "");
  const valid = date && (what === "cancel" || (changed && toMin(end) > toMin(start)));

  const save = (force) => sub.run(async () => {
    const body = { course_id: course.course_id, date, kind: what, lecture_id: lecture.lecture_id, note: note || undefined, force: force || undefined };
    if (what === "modify") {
      body.changes = {
        teacher_id: teacher || undefined,
        start_time: start !== lecture.start_time ? start : undefined,
        end_time: end !== lecture.end_time ? end : undefined,
        room: room !== (lecture.room || "") ? room : undefined,
      };
    }
    const res = await headApi.post("/timetable/overrides", body);
    onSaved(`${what === "cancel" ? "Lecture cancelled" : "Change saved"} for ${fmtShort(date)}.${res.status === "applied" ? " It is live now." : " The timetable returns to normal afterwards."}`);
  });

  return (
    <Modal
      title="Change for one day"
      sub={`${[lecture.subject_code, lecture.subject_name].filter(Boolean).join(" · ")} — ${lecture.day} ${lecture.start_time}–${lecture.end_time}`}
      onClose={onClose} busy={sub.busy} wide
      footer={
        <>
          <button type="button" className="mg-btn" onClick={onClose} disabled={sub.busy}>Cancel</button>
          {sub.conflicts.length > 0 ? (
            <button type="button" className="mg-btn mg-btn--danger" onClick={() => save(true)} disabled={sub.busy}>Save anyway</button>
          ) : (
            <button type="button" className="mg-btn mg-btn--primary" onClick={() => save(false)} disabled={!valid || sub.busy}>
              {sub.busy ? "Saving…" : what === "cancel" ? "Cancel this lecture" : "Save one-day change"}
            </button>
          )}
        </>
      }
    >
      <div className="tt-callout">
        Only on the date you pick. The weekly timetable is untouched and goes back to normal on its own once the day has passed.
      </div>

      <div className="mg-field">
        <label className="mg-label" htmlFor="od-date">Date ({lecture.day})</label>
        <select id="od-date" className="mg-input" value={date} disabled={sub.busy} onChange={(e) => { setDate(e.target.value); sub.setConflicts([]); }}>
          {dates.map((d) => <option key={d} value={d}>{fmtShort(d)} {d.slice(0, 4)}{d === data.today ? " (today)" : ""}</option>)}
        </select>
      </div>

      <div className="tt-seg" role="radiogroup" aria-label="What changes">
        <button type="button" role="radio" aria-checked={what === "modify"} className={`tt-seg-btn${what === "modify" ? " tt-seg-btn--on" : ""}`} onClick={() => setWhat("modify")}>Different teacher / time / room</button>
        <button type="button" role="radio" aria-checked={what === "cancel"} className={`tt-seg-btn${what === "cancel" ? " tt-seg-btn--on" : ""}`} onClick={() => setWhat("cancel")}>Cancel this lecture</button>
      </div>

      {what === "modify" && (
        <>
          <div className="mg-field">
            <label className="mg-label" htmlFor="od-teacher">Teacher that day</label>
            <TeacherSelect id="od-teacher" teachers={teachers.filter((t) => t.teacher_id !== lecture.teacher_id)} value={teacher} disabled={sub.busy}
                           onChange={(v) => { setTeacher(v); sub.setConflicts([]); }}
                           defaultLabel={`Same teacher${lecture.teacher_name ? ` — ${lecture.teacher_name}` : ""}`} />
            <span className="mg-help">If the teacher is busy in another session you'll be told, and can still go ahead.</span>
          </div>
          <div className="tt-two">
            <div className="mg-field">
              <label className="mg-label" htmlFor="od-start">Starts</label>
              <input id="od-start" type="time" className="mg-input" value={start} disabled={sub.busy} onChange={(e) => { setStart(e.target.value); sub.setConflicts([]); }} />
            </div>
            <div className="mg-field">
              <label className="mg-label" htmlFor="od-end">Ends</label>
              <input id="od-end" type="time" className="mg-input" value={end} disabled={sub.busy} onChange={(e) => { setEnd(e.target.value); sub.setConflicts([]); }} />
            </div>
          </div>
          <div className="mg-field">
            <label className="mg-label" htmlFor="od-room">Room</label>
            <input id="od-room" className="mg-input" value={room} maxLength={30} disabled={sub.busy} onChange={(e) => { setRoom(e.target.value); sub.setConflicts([]); }} />
          </div>
          {!changed && <span className="mg-help">Change at least one of teacher, time or room.</span>}
        </>
      )}

      <div className="mg-field">
        <label className="mg-label" htmlFor="od-note">Reason (optional)</label>
        <input id="od-note" className="mg-input" value={note} maxLength={120} disabled={sub.busy} placeholder="e.g. Teacher on leave" onChange={(e) => setNote(e.target.value)} />
      </div>

      <ConflictBox conflicts={sub.conflicts} />
      {sub.error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {sub.error}</span></div>}
    </Modal>
  );
}

// ── Special session (one date or every week) ─────────────────────────────────
function SpecialDialog({ data, teachers, course, semester, defaultDivision, onClose, onSaved }) {
  const [scope, setScope] = useState("date"); // date | weekly
  const [date, setDate] = useState(data.today);
  const [dayName, setDayName] = useState("Monday");
  const [subjectId, setSubjectId] = useState("");        // blank = free-standing session (guest lecture, seminar, ...)
  const [title, setTitle] = useState("");
  const [guest, setGuest] = useState("");
  const [teacher, setTeacher] = useState("");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("11:00");
  const [room, setRoom] = useState("");
  const [division, setDivision] = useState(defaultDivision || "");
  const [replace, setReplace] = useState(null); // null = default (all overlapping)
  const [note, setNote] = useState("");
  const sub = useSubmit();

  const subject = data.subjects.find((s) => s.subject_id === subjectId);
  const day = scope === "date" ? weekdayOf(date) : dayName;
  const valid = (subjectId || title.trim()) && toMin(end) > toMin(start) && (scope === "weekly" || date >= data.today);
  const clashing = valid ? data.lectures.filter((l) => l.day === day && sharesStudents(l.division_id || "", division) && overlaps(toMin(start), toMin(end), toMin(l.start_time), toMin(l.end_time))) : [];
  const picked = replace === null ? clashing.map((l) => l.lecture_id) : replace.filter((id) => clashing.some((l) => l.lecture_id === id));

  const save = (force) => sub.run(async () => {
    if (scope === "date") {
      const res = await headApi.post("/timetable/overrides", {
        course_id: course.course_id, kind: "special", date, note: note || undefined,
        semester,
        special: { subject_id: subjectId || undefined, title: subjectId ? undefined : title.trim(), guest: subjectId ? undefined : guest.trim() || undefined,
                   teacher_id: teacher || undefined, start_time: start, end_time: end, room },
        division_id: division || undefined,
        replaces: picked, force: force || undefined,
      });
      onSaved(`Special session added on ${fmtShort(date)}.${res.status === "applied" ? " It is live now." : " The timetable returns to normal afterwards."}`);
    } else {
      const res = await headApi.post("/timetable", {
        course_id: course.course_id, subject_id: subjectId || undefined, day, start_time: start, end_time: end, room,
        semester, title: subjectId ? undefined : title.trim(), guest: subjectId ? undefined : guest.trim() || undefined,
        teacher_id: teacher || undefined, division_id: division || undefined, replaces: picked, force: force || undefined,
      });
      onSaved(`Special slot added every ${day}${res.replaced ? ` (replaced ${plural(res.replaced, "lecture")})` : ""}.`);
    }
  });

  return (
    <Modal
      title="Special session"
      sub={`${course.abbr} · Semester ${semester} — e.g. one 2-hour lecture instead of two`}
      onClose={onClose} busy={sub.busy} wide
      footer={
        <>
          <button type="button" className="mg-btn" onClick={onClose} disabled={sub.busy}>Cancel</button>
          {sub.conflicts.length > 0 ? (
            <button type="button" className="mg-btn mg-btn--danger" onClick={() => save(true)} disabled={sub.busy}>Save anyway</button>
          ) : (
            <button type="button" className="mg-btn mg-btn--primary" onClick={() => save(false)} disabled={!valid || sub.busy}>
              {sub.busy ? "Saving…" : "Add special session"}
            </button>
          )}
        </>
      }
    >
      <div className="tt-seg" role="radiogroup" aria-label="How long does it last">
        <button type="button" role="radio" aria-checked={scope === "date"} className={`tt-seg-btn${scope === "date" ? " tt-seg-btn--on" : ""}`} onClick={() => { setScope("date"); sub.setConflicts([]); }}>One day only</button>
        <button type="button" role="radio" aria-checked={scope === "weekly"} className={`tt-seg-btn${scope === "weekly" ? " tt-seg-btn--on" : ""}`} onClick={() => { setScope("weekly"); sub.setConflicts([]); }}>Every week</button>
      </div>
      <span className="mg-help">
        {scope === "date"
          ? "Temporary: it appears on that date only, then the timetable returns to normal automatically."
          : "Permanent: becomes part of the weekly timetable."}
      </span>

      <div className="tt-two">
        {scope === "date" ? (
          <div className="mg-field">
            <label className="mg-label" htmlFor="sp-date">Date</label>
            <input id="sp-date" type="date" className="mg-input" min={data.today} value={date} disabled={sub.busy} onChange={(e) => { setDate(e.target.value || data.today); sub.setConflicts([]); }} />
          </div>
        ) : (
          <div className="mg-field">
            <label className="mg-label" htmlFor="sp-day">Day</label>
            <select id="sp-day" className="mg-input" value={dayName} disabled={sub.busy} onChange={(e) => { setDayName(e.target.value); sub.setConflicts([]); }}>
              {DAYS.map((d) => <option key={d}>{d}</option>)}
            </select>
          </div>
        )}
        <div className="mg-field">
          <label className="mg-label" htmlFor="sp-room">Room</label>
          <input id="sp-room" className="mg-input" value={room} maxLength={30} disabled={sub.busy} onChange={(e) => setRoom(e.target.value)} />
        </div>
      </div>
      {scope === "date" && <span className="mg-help">{weekdayOf(date)}</span>}

      <div className="mg-field">
        <label className="mg-label" htmlFor="sp-subject">Subject <span className="mg-help">(optional)</span></label>
        <select id="sp-subject" className="mg-input" value={subjectId} disabled={sub.busy} onChange={(e) => { setSubjectId(e.target.value); sub.setConflicts([]); }}>
          <option value="">— No subject (guest lecture, seminar, other) —</option>
          {data.subjects.map((s) => <option key={s.subject_id} value={s.subject_id}>{s.subject_code} · {s.subject_name}</option>)}
        </select>
      </div>
      {!subjectId && (
        <div className="tt-two">
          <div className="mg-field">
            <label className="mg-label" htmlFor="sp-title">Session title</label>
            <input id="sp-title" className="mg-input" value={title} maxLength={80} placeholder="e.g. Guest lecture on Cloud Security" disabled={sub.busy} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="mg-field">
            <label className="mg-label" htmlFor="sp-guest">Speaker <span className="mg-help">(optional)</span></label>
            <input id="sp-guest" className="mg-input" value={guest} maxLength={80} placeholder="Guest name" disabled={sub.busy || !!teacher} onChange={(e) => setGuest(e.target.value)} />
          </div>
        </div>
      )}
      <div className="tt-two">
        <div className="mg-field">
          <label className="mg-label" htmlFor="sp-start">Starts</label>
          <input id="sp-start" type="time" className="mg-input" value={start} disabled={sub.busy} onChange={(e) => { setStart(e.target.value); sub.setConflicts([]); }} />
        </div>
        <div className="mg-field">
          <label className="mg-label" htmlFor="sp-end">Ends</label>
          <input id="sp-end" type="time" className="mg-input" value={end} disabled={sub.busy} onChange={(e) => { setEnd(e.target.value); sub.setConflicts([]); }} />
        </div>
      </div>
      {valid ? <span className="mg-help">Length: {dur(start, end)}</span> : <span className="tt-invalid">End time must be after the start time.</span>}

      <div className="mg-field">
        <label className="mg-label" htmlFor="sp-teacher">Teacher</label>
        <TeacherSelect id="sp-teacher" teachers={teachers} value={teacher} disabled={sub.busy} onChange={(v) => { setTeacher(v); sub.setConflicts([]); }}
                       defaultLabel={!subjectId ? "No teacher (guest / not in the system)" : subject?.teacher_name ? `Subject's teacher — ${subject.teacher_name}` : "Subject's teacher (none assigned yet)"} />
      </div>

      <OverlapPicker items={clashing} picked={picked} disabled={sub.busy}
                     onToggle={(id) => { setReplace(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]); sub.setConflicts([]); }}
                     title={scope === "date" ? "Regular lectures at this time — ticked ones are replaced that day" : "Regular lectures at this time — ticked ones are replaced for good"} />
      {scope === "date" && (
        <div className="mg-field">
          <label className="mg-label" htmlFor="sp-note">Reason (optional)</label>
          <input id="sp-note" className="mg-input" value={note} maxLength={120} disabled={sub.busy} placeholder="e.g. Guest lecture" onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      <ConflictBox conflicts={sub.conflicts} />
      {sub.error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {sub.error}</span></div>}
    </Modal>
  );
}

// ── Weekly grid ──────────────────────────────────────────────────────────────
function lanesOf(list) {
  const sorted = [...list].sort((a, b) => toMin(a.start_time) - toMin(b.start_time) || toMin(a.end_time) - toMin(b.end_time));
  const ends = [];
  const placed = sorted.map((l) => {
    let lane = ends.findIndex((e) => e <= toMin(l.start_time));
    if (lane === -1) { lane = ends.length; ends.push(0); }
    ends[lane] = toMin(l.end_time);
    return { l, lane };
  });
  return { placed, count: Math.max(1, ends.length) };
}

function Grid({ lectures, colorOf, onSlot, onEmpty }) {
  const days = useMemo(() => DAYS.filter((d, i) => i < 6 || lectures.some((l) => l.day === d)), [lectures]);
  const { from, to } = useMemo(() => {
    if (!lectures.length) return { from: 9 * 60, to: 16 * 60 };
    const lo = Math.floor(Math.min(...lectures.map((l) => toMin(l.start_time))) / 60) * 60;
    let hi = Math.ceil(Math.max(...lectures.map((l) => toMin(l.end_time))) / 60) * 60;
    if (hi - lo < 6 * 60) hi = lo + 6 * 60;
    return { from: lo, to: Math.min(hi, 24 * 60) };
  }, [lectures]);
  const total = to - from;
  const hours = total / 60;
  const pct = (m) => `${((m - from) / total) * 100}%`;

  return (
    <div className="tt-scroll">
      <div className="tt-inner" style={{ "--hours": hours }}>
        <div className="tt-head">
          <div className="tt-daycell tt-daycell--corner">Day / Time</div>
          <div className="tt-hours">
            {Array.from({ length: hours }, (_, i) => (
              <div key={i} className="tt-hour">{fromMin(from + i * 60)}</div>
            ))}
          </div>
        </div>

        {days.map((day) => {
          const list = lectures.filter((l) => l.day === day);
          const { placed, count } = lanesOf(list);
          return (
            <div className={`tt-row${list.length ? "" : " tt-row--empty"}`} key={day}>
              <div className="tt-daycell"><span>{day}</span></div>
              <div
                className="tt-track"
                style={{ height: `calc(${count} * var(--lane-h) + 8px)` }}
                data-day={day}
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const raw = from + ((e.clientX - rect.left) / rect.width) * total;
                  const s = Math.max(from, Math.min(to - 60, Math.round(raw / 30) * 30));
                  onEmpty(day, fromMin(s), fromMin(Math.min(s + 60, 24 * 60 - 1)));
                }}
              >
                {placed.map(({ l, lane }) => {
                  const [bg, fg] = colorOf(l.subject_id);
                  return (
                    <button
                      type="button"
                      key={l.lecture_id}
                      className="tt-slot"
                      style={{
                        left: pct(toMin(l.start_time)), width: `calc(${((toMin(l.end_time) - toMin(l.start_time)) / total) * 100}% - 4px)`,
                        top: `calc(${lane} * var(--lane-h) + 4px)`, height: "calc(var(--lane-h) - 4px)", background: bg, color: fg, borderColor: fg,
                      }}
                      onClick={() => onSlot(l)}
                      title={`${l.subject_name} · ${l.start_time}–${l.end_time}${l.teacher_name ? ` · ${l.teacher_name}` : ""}${l.room ? ` · ${l.room}` : ""}`}
                      aria-label={`${l.subject_code || l.subject_name} ${day} ${l.start_time} to ${l.end_time}`}
                    >
                      <span className="tt-slot-code">{l.subject_code || l.subject_name}{l.division_name ? ` · ${l.division_name}` : ""}</span>
                      <span className="tt-slot-name">{l.subject_name}</span>
                      <span className="tt-slot-meta">
                        {l.teacher_name || "No teacher"}{l.teacher_pinned ? " *" : ""}{l.room ? ` · ${l.room}` : ""}
                      </span>
                      <span className="tt-slot-time">{l.start_time}–{l.end_time}</span>
                      {l.pending_changes > 0 && <span className="tt-slot-flag tt-noprint" title="A one-day change is scheduled">{l.pending_changes}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Plain print table (only visible when printing) ──────────────────────────
function PrintTable({ lectures }) {
  const slots = useMemo(() => {
    const seen = new Map();
    lectures.forEach((l) => seen.set(`${l.start_time}-${l.end_time}`, { s: l.start_time, e: l.end_time }));
    return [...seen.values()].sort((a, b) => toMin(a.s) - toMin(b.s) || toMin(a.e) - toMin(b.e));
  }, [lectures]);
  const days = DAYS.filter((d) => lectures.some((l) => l.day === d));
  if (!lectures.length) return null;
  return (
    <table className="tt-plain">
      <thead>
        <tr>
          <th>Day</th>
          {slots.map((t) => <th key={t.s + t.e}>{t.s} – {t.e}</th>)}
        </tr>
      </thead>
      <tbody>
        {days.map((day) => (
          <tr key={day}>
            <th scope="row">{day}</th>
            {slots.map((t) => {
              const here = lectures.filter((l) => l.day === day && l.start_time === t.s && l.end_time === t.e);
              return (
                <td key={t.s + t.e}>
                  {here.map((l) => (
                    <div key={l.lecture_id}>
                      <b>{l.subject_code || l.subject_name}{l.division_name ? ` (${l.division_name})` : ""}</b>
                      <div>{l.teacher_name || "—"}{l.teacher_pinned ? " *" : ""}</div>
                      {l.room && <div>{l.room}</div>}
                    </div>
                  ))}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Temporary changes list ───────────────────────────────────────────────────
function describe(o) {
  if (o.kind === "cancel") return { tag: "Cancelled", text: `${o.lecture?.subject_code || ""} ${o.lecture?.subject_name || ""} ${o.lecture?.start_time}–${o.lecture?.end_time} will not run` };
  if (o.kind === "modify") {
    const bits = [];
    if (o.changes?.teacher_name) bits.push(`taught by ${o.changes.teacher_name}`);
    if (o.changes?.start_time || o.changes?.end_time) bits.push(`${o.changes.start_time || o.lecture?.start_time}–${o.changes.end_time || o.lecture?.end_time}`);
    if (o.changes?.room !== undefined) bits.push(`room ${o.changes.room || "—"}`);
    return { tag: o.changes?.teacher_name && Object.keys(o.changes).length <= 2 ? "Substitute" : "Changed", text: `${o.lecture?.subject_code || ""} ${o.lecture?.subject_name || ""}: ${bits.join(", ")}` };
  }
  const sp = o.special || {};
  const rep = o.replaces?.length ? ` · replaces ${o.replaces.map((r) => `${r.subject_name} ${r.start_time}–${r.end_time}`).join(", ")}` : "";
  return { tag: "Special", text: `${sp.subject_code || ""} ${sp.subject_name || ""} ${sp.start_time}–${sp.end_time}${sp.teacher_name ? ` · ${sp.teacher_name}` : ""}${rep}` };
}

function Changes({ overrides, today, onUndo }) {
  return (
    <section className="tt-changes tt-noprint" aria-label="Temporary changes">
      <div className="tt-changes-head">
        <h3>Temporary changes</h3>
        <span>Each one applies on its date only; the timetable then returns to normal automatically.</span>
      </div>
      {overrides.length === 0 ? (
        <div className="tt-changes-empty">No one-day changes coming up.</div>
      ) : (
        <div className="tt-changes-list" role="list">
          {overrides.map((o) => {
            const d = describe(o);
            return (
              <div className="tt-change" role="listitem" key={o.override_id}>
                <div className="tt-change-date">
                  <strong>{fmtShort(o.date)}</strong>
                  {o.status === "applied" || o.date === today
                    ? <span className="mg-badge mg-badge--green">Live today</span>
                    : <span className="mg-badge mg-badge--amber">Scheduled</span>}
                </div>
                <div className="tt-change-body">
                  <span className={`tt-tag tt-tag--${o.kind}`}>{d.tag}</span> {d.text}
                  {o.note && <span className="tt-change-note"> — {o.note}</span>}
                </div>
                <button type="button" className="mg-btn mg-btn--sm" onClick={() => onUndo(o)} aria-label={`Undo change on ${fmtShort(o.date)}`}>Undo</button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function TimetablePage() {
  const [ctx, setCtx] = useState(null);
  const [ctxError, setCtxError] = useState("");
  const [courseId, setCourseId] = useState(null);
  const [semester, setSemester] = useState(1);
  const [data, setData] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [modal, setModal] = useState(null);
  const [view, setView] = useState("all"); // all | common | <division_id>
  const seq = useRef(0);

  const loadContext = useCallback(async () => {
    setLoading(true); setCtxError("");
    try {
      const d = await headApi.get("/context");
      setCtx(d);
      setCourseId((cur) => cur || d.courses[0]?.course_id || null);
      if (!d.courses.length) setLoading(false);
    } catch (err) { setCtxError(err.message); setLoading(false); }
  }, []);

  const loadTeachers = useCallback(async () => {
    try { setTeachers((await headApi.get("/teachers")).teachers || []); }
    catch (err) { setNotice({ type: "warn", text: `Couldn't load teachers: ${err.message}` }); }
  }, []);

  const load = useCallback(async (cid, sem) => {
    const mine = ++seq.current;
    setLoading(true); setError("");
    try {
      const d = await headApi.get(`/timetable?course_id=${encodeURIComponent(cid)}&semester=${sem}`);
      if (mine !== seq.current) return;
      setData(d);
    } catch (err) {
      if (mine === seq.current) setError(err.message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { loadContext(); loadTeachers(); }, [loadContext, loadTeachers]);
  useEffect(() => { if (courseId) { setData(null); load(courseId, semester); } }, [courseId, semester, load]);
  useEffect(() => {
    if (!notice || notice.type === "warn") return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const course = ctx?.courses.find((c) => c.course_id === courseId) || null;
  const closeModal = useCallback(() => setModal(null), []);
  const saved = (text) => { setModal(null); setNotice({ type: "success", text }); load(courseId, semester); loadTeachers(); };

  const colorOf = useMemo(() => {
    const ids = (data?.subjects || []).map((s) => s.subject_id);
    return (id) => (id ? PALETTE[Math.max(0, ids.indexOf(id)) % PALETTE.length] : ["#F3F4F6", "#374151"]);
  }, [data]);

  const divisions = data?.divisions || [];
  const viewDivision = divisions.find((d) => d.division_id === view) || null;
  const shown = useMemo(() => {
    const all = data?.lectures || [];
    if (view === "all") return all;
    if (view === "common") return all.filter((l) => !l.division_id);
    return all.filter((l) => !l.division_id || l.division_id === view);
  }, [data, view]);
  useEffect(() => { if (view !== "all" && view !== "common" && data && !divisions.some((d) => d.division_id === view)) setView("all"); }, [data]); // eslint-disable-line

  const undo = (o) =>
    setModal({ type: "undo", override: o });

  const run = data?.semester_run;
  const duration = run
    ? `${fmtDate(run.start_date)} – ${fmtDate(run.end_date)}`
    : "Semester dates not set";
  const printedOn = fmtDate(data?.today || "");

  return (
    <ManageShell
      title="Timetable"
      subtitle="Weekly timetable for each semester — print it, or make one-day changes that undo themselves."
      actions={course && data && (
        <>
          <button className="mg-btn" onClick={() => window.print()}>Print</button>
          <button className="mg-btn" onClick={() => setModal({ type: "special" })} disabled={!data.subjects.length}>Special session</button>
          <button className="mg-btn mg-btn--primary" onClick={() => setModal({ type: "add" })} disabled={!data.subjects.length}>+ Add lecture</button>
        </>
      )}
    >
      {ctxError && (
        <div className="mg-banner mg-banner--error tt-noprint" role="alert">
          <span className="mg-banner-text">⚠ {ctxError}</span>
          <button className="mg-banner-action" onClick={loadContext}>Retry</button>
        </div>
      )}
      {notice && (
        <div className={`mg-banner mg-banner--${notice.type} tt-noprint`} role="status">
          <span className="mg-banner-text">{notice.type === "success" ? "✓ " : ""}{notice.text}</span>
          <button className="mg-banner-action" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {ctx && ctx.courses.length === 0 && (
        <div className="mg-empty">
          <div className="mg-empty-title">No courses found for your department</div>
          Ask your institute admin to add one, then reload this page.
        </div>
      )}

      {ctx && ctx.courses.length > 1 && (
        <div className="mg-pills tt-noprint" role="tablist" aria-label="Course">
          {ctx.courses.map((c) => (
            <button key={c.course_id} role="tab" aria-selected={c.course_id === courseId}
                    className={`mg-pill${c.course_id === courseId ? " mg-pill--active" : ""}`}
                    onClick={() => { setCourseId(c.course_id); setSemester(1); setView("all"); }}>
              {c.course_name || c.abbr} <span className="mg-pill-code">{c.abbr}</span>
            </button>
          ))}
        </div>
      )}

      {course && (
        <div className="tt-sems tt-noprint" role="tablist" aria-label="Semester">
          {Array.from({ length: course.total_semesters || 1 }, (_, i) => i + 1).map((n) => (
            <button key={n} role="tab" aria-selected={semester === n}
                    className={`tt-sem${semester === n ? " tt-sem--on" : ""}`} onClick={() => { setSemester(n); setView("all"); }}>
              Semester {n}
            </button>
          ))}
        </div>
      )}

      {course && data && divisions.length > 0 && (
        <div className="tt-sems tt-noprint" role="tablist" aria-label="Division">
          <button role="tab" aria-selected={view === "all"} className={`tt-sem${view === "all" ? " tt-sem--on" : ""}`} onClick={() => setView("all")}>All divisions</button>
          {divisions.map((d) => (
            <button key={d.division_id} role="tab" aria-selected={view === d.division_id}
                    className={`tt-sem${view === d.division_id ? " tt-sem--on" : ""}`} onClick={() => setView(d.division_id)}>Division {d.name}</button>
          ))}
          <button role="tab" aria-selected={view === "common"} className={`tt-sem${view === "common" ? " tt-sem--on" : ""}`} onClick={() => setView("common")}>Common only</button>
        </div>
      )}

      {error && (
        <div className="mg-banner mg-banner--error tt-noprint" role="alert">
          <span className="mg-banner-text">⚠ {error}</span>
          <button className="mg-banner-action" onClick={() => load(courseId, semester)}>Retry</button>
        </div>
      )}
      {loading && !data && !error && course && <div className="mg-loading">Loading timetable…</div>}

      {course && data && (
        <>
          <section className="tt-paper" aria-label="Timetable">
            <header className="tt-paper-head">
              <div className="tt-college">
                {data.college_name && <h2 className="tt-college-name">{data.college_name}</h2>}
                <div className="tt-doc-title">Class Timetable</div>
              </div>
              <dl className="tt-facts">
                <div><dt>Course</dt><dd>{data.course.course_name || data.course.abbr}{data.course.course_name && data.course.abbr ? ` (${data.course.abbr})` : ""}</dd></div>
                <div><dt>Semester</dt><dd>{data.semester}</dd></div>
                {viewDivision && <div><dt>Division</dt><dd>{viewDivision.name}</dd></div>}
                <div><dt>Duration</dt><dd>{duration}</dd></div>
                <div className="tt-print-only"><dt>Printed on</dt><dd>{printedOn}</dd></div>
              </dl>
            </header>

            {data.lectures.length === 0 && (
              <div className="tt-empty tt-noprint">
                No lectures scheduled for Semester {semester} yet. Click “+ Add lecture”, or click any empty space in a day's row.
              </div>
            )}
            <Grid
              lectures={shown}
              colorOf={colorOf}
              onSlot={(l) => setModal({ type: "edit", lecture: l })}
              onEmpty={(day, start, end) => data.subjects.length && setModal({ type: "add", defaults: { day, start, end, division: viewDivision ? viewDivision.division_id : "" } })}
            />

            <PrintTable lectures={shown} />

            {data.subjects.length > 0 && (
              <div className="tt-legend-wrap"><table className="tt-legend">
                <caption>Subjects</caption>
                <thead><tr><th>Code</th><th>Subject</th><th>Type</th><th>Teacher</th></tr></thead>
                <tbody>
                  {data.subjects.map((s) => {
                    const [bg, fg] = colorOf(s.subject_id);
                    return (
                      <tr key={s.subject_id}>
                        <td><span className="tt-swatch" style={{ background: bg, borderColor: fg, color: fg }}>{s.subject_code}</span></td>
                        <td>{s.subject_name}</td>
                        <td>{s.compulsary ? "Compulsory" : "Elective"}</td>
                        <td>{s.teacher_name || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            )}
            <p className="tt-note tt-print-only">* teacher set for that slot only</p>
          </section>

          <p className="tt-hint tt-noprint">
            Click a lecture to edit it, change it for one day, or delete it. Click an empty space in a row to add a lecture there. “*” marks a slot with its own teacher.
            {divisions.length > 0 && " Lectures without a division are common to everyone; pick a division above to see exactly what its students get, and add a lecture “for Division X only” to give a division its own teacher or time."}
          </p>

          <Changes overrides={data.overrides} today={data.today} onUndo={undo} />
        </>
      )}

      {data && course && modal?.type === "add" && (
        <LectureDialog mode="add" defaults={modal.defaults} data={data} teachers={teachers} course={course} semester={semester}
                       onClose={closeModal} onSaved={saved} />
      )}
      {data && course && modal?.type === "edit" && (
        <LectureDialog mode="edit" lecture={modal.lecture} data={data} teachers={teachers} course={course} semester={semester}
                       onClose={closeModal} onSaved={saved} onChangeDay={(l) => setModal({ type: "oneday", lecture: l })} />
      )}
      {data && course && modal?.type === "oneday" && (
        <OneDayDialog lecture={modal.lecture} data={data} teachers={teachers} course={course} semester={semester}
                      onClose={closeModal} onSaved={saved} />
      )}
      {data && course && modal?.type === "special" && (
        <SpecialDialog data={data} teachers={teachers} course={course} semester={semester} defaultDivision={viewDivision ? viewDivision.division_id : ""} onClose={closeModal} onSaved={saved} />
      )}
      {modal?.type === "undo" && (
        <UndoDialog override={modal.override} onClose={closeModal}
                    onDone={() => saved("Change undone — the timetable is back to normal for that day.")} />
      )}
    </ManageShell>
  );
}

function UndoDialog({ override: o, onClose, onDone }) {
  const sub = useSubmit();
  const d = describe(o);
  return (
    <Modal
      title="Undo this change?" sub={`${fmtShort(o.date)} · ${d.tag}`} onClose={onClose} busy={sub.busy}
      footer={
        <>
          <button type="button" className="mg-btn" onClick={onClose} disabled={sub.busy}>Keep it</button>
          <button type="button" className="mg-btn mg-btn--danger" disabled={sub.busy}
                  onClick={async () => { if (await sub.run(() => headApi.del(`/timetable/overrides/${o.override_id}`))) onDone(); }}>
            {sub.busy ? "Undoing…" : "Undo change"}
          </button>
        </>
      }
    >
      <p className="tt-undo-text">{d.text}</p>
      <span className="mg-help">The regular timetable is restored for {fmtShort(o.date)}{o.status === "applied" ? " right away" : ""}.</span>
      {sub.error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {sub.error}</span></div>}
    </Modal>
  );
}