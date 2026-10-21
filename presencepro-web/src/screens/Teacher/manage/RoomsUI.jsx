// @ts-nocheck
/**
 * RoomsUI.jsx — saved rooms for the Timetable page.
 *   useRooms(day, start, end, excludeId)  all college rooms + who uses each at that slot
 *   RoomSelect                             picker used wherever a room is chosen
 *   RoomsDialog                            "Rooms" button: add/edit rooms, answer and follow room requests
 *   useRoomRequests()                      polled list of incoming/outgoing requests
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { headApi } from "../../../services/headApi";

const TYPE_LABEL = { classroom: "Classrooms", lab: "Labs" };
const TYPE_ONE = { classroom: "Classroom", lab: "Lab" };
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const toMin = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : "";
};

// All college rooms; with a slot, each room says who is using it then.
export function useRooms(day, start, end, excludeId) {
  const [rooms, setRooms] = useState(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const ok = DAYS.includes(day) && start && end && toMin(end) > toMin(start);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const q = ok ? `?day=${encodeURIComponent(day)}&start_time=${start}&end_time=${end}${excludeId ? `&exclude_id=${encodeURIComponent(excludeId)}` : ""}` : "";
      const d = await headApi.get(`/rooms${q}`);
      if (mine === seq.current) { setRooms(d.rooms || []); setFailed(false); }
    } catch { if (mine === seq.current) setFailed(true); }
  }, [ok, day, start, end, excludeId]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  return { rooms, failed, reload: load };
}

export function RoomSelect({ id, rooms, value, onChange, ownOnly, onlyType, taken = [], disabled, ariaLabel }) {
  // nothing saved yet (or the list could not load): plain text, like before
  if (!rooms || rooms.length === 0) {
    return (
      <input id={id} className="mg-input" value={value} maxLength={30} disabled={disabled} placeholder={rooms ? "e.g. 112 (save rooms with the Rooms button)" : "Room"}
             aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)} />
    );
  }
  const list = rooms.filter((r) => (!ownOnly || r.own) && (!onlyType || r.type === onlyType));
  const known = list.some((r) => r.name === value);
  const groups = ["classroom", "lab"].map((t) => [t, list.filter((r) => r.type === t)]).filter(([, g]) => g.length);
  const label = (r) => {
    let s = r.name;
    if (r.capacity) s += ` · ${r.capacity} seats`;
    if (r.busy) s += ` · in use: ${r.busy.subject_name} ${r.busy.start_time}-${r.busy.end_time}${r.busy.course_abbr ? ` (${r.busy.course_abbr})` : ""}`;
    else if (!r.own) s += ` · ${r.course_abbr || "other course"} · needs approval`;
    return s;
  };
  const sel = list.find((r) => r.name === value) || rooms.find((r) => r.name === value);
  const none = list.length === 0;
  return (
    <>
      <select id={id} className="mg-input" value={value} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
        <option value="">No room</option>
        {value && !known && <option value={value}>{value}{sel ? "" : " (not a saved room)"}</option>}
        {groups.map(([t, g]) => (
          <optgroup key={t} label={TYPE_LABEL[t]}>
            {g.map((r) => (
              <option key={r.room_id} value={r.name} disabled={(!!r.busy && r.name !== value) || (taken.includes(r.name) && r.name !== value)}>{label(r)}</option>
            ))}
          </optgroup>
        ))}
      </select>
      {sel && !sel.own && (
        <span className="mg-help">{sel.name} belongs to {sel.course_abbr || "another course"}. They will be asked to approve; until they do, this slot has no room.</span>
      )}
      {none && onlyType && <span className="mg-help">No {onlyType === "lab" ? "lab rooms" : "classrooms"} saved{ownOnly ? " for your course" : ""} yet. Add one with the Rooms button.</span>}
    </>
  );
}

// Requests waiting for me (incoming) and the ones I made (outgoing); refreshed every few seconds.
export function useRoomRequests(onOutgoingChange) {
  const [data, setData] = useState({ incoming: [], outgoing: [] });
  const sig = useRef(null);
  const cb = useRef(onOutgoingChange);
  cb.current = onOutgoingChange;
  const load = useCallback(async () => {
    try {
      const d = await headApi.get("/room-requests");
      setData({ incoming: d.incoming || [], outgoing: d.outgoing || [] });
      const s = (d.outgoing || []).map((r) => `${r.id}:${r.status}`).join(",");
      if (sig.current !== null && sig.current !== s && cb.current) cb.current();
      sig.current = s;
    } catch { /* keep the last list */ }
  }, []);
  useEffect(() => {
    load();
    const tick = () => { if (document.visibilityState === "visible") load(); };
    const id = setInterval(tick, 8000);
    window.addEventListener("focus", tick);
    return () => { clearInterval(id); window.removeEventListener("focus", tick); };
  }, [load]);
  return { ...data, reload: load };
}

const errMsg = (e) => e?.response?.data?.error || e?.data?.error || e?.message || "Something went wrong";

export function RoomsDialog({ courses, courseId, requests, onClose, onChanged }) {
  const [rooms, setRooms] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState({ course_id: courseId || courses[0]?.course_id || "", name: "", type: "classroom", capacity: "" });
  const [edit, setEdit] = useState(null);       // room_id being edited
  const [draft, setDraft] = useState(null);
  const [confirm, setConfirm] = useState("");   // room_id awaiting delete confirmation
  const [note, setNote] = useState({});

  const load = useCallback(async () => {
    try { setRooms((await headApi.get("/rooms")).rooms || []); }
    catch (e) { setMsg({ kind: "error", text: errMsg(e) }); setRooms([]); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const run = async (fn, okText) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); await load(); await requests.reload(); onChanged && onChanged(); if (okText) setMsg({ kind: "success", text: typeof okText === "function" ? okText(r) : okText }); return true; }
    catch (e) { setMsg({ kind: "error", text: errMsg(e) }); return false; }
    finally { setBusy(false); }
  };

  const add = async () => {
    const ok = await run(() => headApi.post("/rooms", { course_id: form.course_id, name: form.name, type: form.type, capacity: form.capacity === "" ? undefined : Number(form.capacity) }), "Room saved.");
    if (ok) setForm((f) => ({ ...f, name: "", capacity: "" }));
  };
  const saveEdit = async () => {
    const ok = await run(() => headApi.put(`/rooms/${edit}`, { name: draft.name, type: draft.type, capacity: draft.capacity === "" ? "" : Number(draft.capacity) }),
      (r) => `Room updated${r?.lectures_updated ? `, ${r.lectures_updated} timetable slot${r.lectures_updated === 1 ? "" : "s"} follow the new name` : ""}.`);
    if (ok) { setEdit(null); setDraft(null); }
  };
  const importRooms = () => run(() => headApi.post("/rooms/import", { course_id: form.course_id }),
    (r) => (r.imported ? `${r.imported} room${r.imported === 1 ? "" : "s"} saved from the timetable.` : "Every room in this timetable is already saved."));
  const decide = (r, approve) => run(() => headApi.post(`/room-requests/${r.id}/decide`, { approve, note: note[r.id] || undefined }),
    approve ? `${r.room_name} approved for ${r.course_abbr}.` : "Request declined.");

  const mine = (rooms || []).filter((r) => r.own);
  const others = (rooms || []).filter((r) => !r.own);
  const incoming = requests.incoming || [];
  const outgoing = (requests.outgoing || []).slice(0, 8);

  const RoomRow = (r) => {
    if (edit === r.room_id) {
      return (
        <div className="rm-row rm-row--edit" key={r.room_id}>
          <input className="mg-input" value={draft.name} maxLength={30} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Room name" />
          <select className="mg-input" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} aria-label="Type">
            <option value="classroom">Classroom</option><option value="lab">Lab</option>
          </select>
          <input className="mg-input" type="number" min="1" value={draft.capacity} placeholder="Seats" onChange={(e) => setDraft({ ...draft, capacity: e.target.value })} aria-label="Seats" />
          <div className="rm-actions">
            <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => { setEdit(null); setDraft(null); }}>Cancel</button>
            <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" disabled={busy || !draft.name.trim()} onClick={saveEdit}>Save</button>
          </div>
        </div>
      );
    }
    return (
      <div className="rm-row" key={r.room_id}>
        <div className="rm-name"><strong>{r.name}</strong><span className={`rm-type rm-type--${r.type}`}>{TYPE_ONE[r.type]}</span></div>
        <div className="rm-meta">{r.capacity ? `${r.capacity} seats` : "—"} · {r.lectures ? `${r.lectures} slot${r.lectures === 1 ? "" : "s"}` : "not used yet"}{!r.own ? ` · ${r.course_abbr}` : ""}</div>
        {r.own && (
          <div className="rm-actions">
            {confirm === r.room_id ? (
              <>
                <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => setConfirm("")}>Keep</button>
                <button type="button" className="mg-btn mg-btn--danger mg-btn--sm" disabled={busy} onClick={async () => { await run(() => headApi.del(`/rooms/${r.room_id}`), "Room removed."); setConfirm(""); }}>Yes, remove</button>
              </>
            ) : (
              <>
                <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => { setEdit(r.room_id); setDraft({ name: r.name, type: r.type, capacity: r.capacity || "" }); }}>Edit</button>
                <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => setConfirm(r.room_id)}>Remove</button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mg-modal mg-modal--wide rm-modal" role="dialog" aria-modal="true" aria-label="Rooms">
        <div className="mg-modal-header">
          <div>
            <h3 className="mg-modal-title">Rooms</h3>
            <p className="mg-modal-sub">Save the rooms your course uses, then pick them when you schedule. A room holds one lecture at a time, across the whole college.</p>
          </div>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>
        <div className="mg-modal-body">
          {msg && <div className={`mg-banner mg-banner--${msg.kind}`} role="status"><span className="mg-banner-text">{msg.text}</span></div>}

          {incoming.length > 0 && (
            <section className="rm-sec">
              <h4 className="rm-h">Waiting for your answer</h4>
              {incoming.map((r) => (
                <div className="rm-req" key={r.id}>
                  <div className="rm-req-text">
                    <strong>{r.course_abbr}</strong> asks for <strong>{r.room_name}</strong> on {r.day} {r.start_time}-{r.end_time}
                    <span className="rm-meta"> for {r.subject_name || "a class"} · {r.requested_by}{r.created_at ? ` · ${when(r.created_at)}` : ""}</span>
                  </div>
                  <input className="mg-input rm-note" placeholder="Note (optional)" maxLength={200} value={note[r.id] || ""} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
                  <div className="rm-actions">
                    <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => decide(r, false)}>Decline</button>
                    <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" disabled={busy} onClick={() => decide(r, true)}>Approve</button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className="rm-sec">
            <h4 className="rm-h">Add a room</h4>
            <div className="rm-form">
              {courses.length > 1 && (
                <select className="mg-input" value={form.course_id} onChange={(e) => setForm({ ...form, course_id: e.target.value })} aria-label="Course">
                  {courses.map((c) => <option key={c.course_id} value={c.course_id}>{c.abbr || c.course_name}</option>)}
                </select>
              )}
              <input className="mg-input" placeholder="Name, e.g. 112 or Lab B14" maxLength={30} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                     onKeyDown={(e) => { if (e.key === "Enter" && form.name.trim() && !busy) add(); }} aria-label="Room name" />
              <select className="mg-input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} aria-label="Type">
                <option value="classroom">Classroom</option><option value="lab">Lab</option>
              </select>
              <input className="mg-input" type="number" min="1" placeholder="Seats" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} aria-label="Seats" />
              <button type="button" className="mg-btn mg-btn--primary" disabled={busy || !form.name.trim()} onClick={add}>Add</button>
            </div>
            <button type="button" className="rm-link" disabled={busy} onClick={importRooms}>Save the rooms already typed into this course's timetable</button>
          </section>

          <section className="rm-sec">
            <h4 className="rm-h">Your rooms{rooms ? ` (${mine.length})` : ""}</h4>
            {rooms === null && <div className="mg-loading">Loading…</div>}
            {rooms && mine.length === 0 && <p className="rm-empty">No rooms saved yet.</p>}
            {mine.map(RoomRow)}
          </section>

          {others.length > 0 && (
            <section className="rm-sec">
              <h4 className="rm-h">Rooms of other courses</h4>
              <p className="rm-empty">You can ask for these in the room picker when they are free; their course approves.</p>
              {others.map(RoomRow)}
            </section>
          )}

          {outgoing.length > 0 && (
            <section className="rm-sec">
              <h4 className="rm-h">Your requests</h4>
              {outgoing.map((r) => (
                <div className="rm-req rm-req--out" key={r.id}>
                  <div className="rm-req-text">
                    <strong>{r.room_name}</strong> ({r.owner_course_abbr}) · {r.subject_name || "class"} · {r.day} {r.start_time}-{r.end_time}
                    {r.note && <span className="rm-meta"> — {r.note}</span>}
                  </div>
                  <span className={`rm-status rm-status--${r.status}`}>{r.status === "pending" ? "Waiting" : r.status === "approved" ? "Approved" : "Declined"}</span>
                </div>
              ))}
            </section>
          )}
        </div>
        <div className="mg-modal-footer"><button type="button" className="mg-btn" onClick={onClose} disabled={busy}>Close</button></div>
      </div>
    </div>
  );
}