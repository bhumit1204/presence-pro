// @ts-nocheck
/**
 * SuggestionsProvider.jsx — one shared copy of the head/delegate notes for the
 * current Manage area, used by the topbar drawer (SuggestionsPanel) and by the
 * hover comment pins on the pages (CommentPin). Mounted by ManageShell.
 * Refreshes every few seconds while the tab is visible, and right after any action.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { headApi } from "../services/headApi";
import "./SuggestionsPanel.css";

const POLL_MS = 4000;
const Ctx = createContext(null);
export const useSuggestions = () => useContext(Ctx);

export const errMsg = (e) => e?.response?.data?.error || e?.data?.error || e?.message || "Something went wrong";
export const fmtWhen = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + ", " +
    d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
};

export function SuggestionsProvider({ area, children }) {
  const [courses, setCourses] = useState([]);
  const [courseId, setCourseId] = useState("");
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const alive = useRef(true);
  const last = useRef("");

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // which courses this person can reach for this area
  useEffect(() => {
    if (!area) return;
    let off = false;
    (async () => {
      try {
        const r = await headApi.get("/context");
        if (off) return;
        const list = (r.courses || []).filter((c) => (r.areas?.[c.course_id] || []).includes(area));
        setCourses(list);
        setCourseId((cur) => (cur && list.some((c) => c.course_id === cur) ? cur : list[0]?.course_id || ""));
      } catch { /* the page itself reports connection problems */ }
    })();
    return () => { off = true; };
  }, [area]);

  const load = useCallback(async () => {
    if (!area || !courseId) return;
    try {
      const r = await headApi.get(`/notes?course_id=${encodeURIComponent(courseId)}&area=${encodeURIComponent(area)}`);
      const sig = JSON.stringify(r);
      if (alive.current && sig !== last.current) { last.current = sig; setData(r); }
    } catch { /* keep what we have */ }
  }, [area, courseId]);

  useEffect(() => {
    last.current = ""; setData(null);
    if (!area || !courseId) return undefined;
    load();
    const tick = () => { if (document.visibilityState === "visible") load(); };
    const id = setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load, area, courseId]);

  const act = useCallback(async (fn) => {
    setBusy(true); setErr("");
    try { await fn(); await load(); return true; }
    catch (e) { setErr(errMsg(e)); return false; }
    finally { if (alive.current) setBusy(false); }
  }, [load]);

  const value = useMemo(() => {
    const notes = data?.notes || [];
    const delegates = data?.delegates || [];
    return {
      area, courses, courseId, setCourseId,
      ready: !!(area && courseId && data && delegates.length),
      isHead: !!data?.is_head, areaLabel: data?.area_label || "", delegates, notes, open: data?.open || 0,
      busy, err, clearErr: () => setErr(""),
      post: (text, about) => act(() => headApi.post("/notes", { course_id: courseId, area, text, about: about || "" })),
      reply: (id, text) => act(() => headApi.post(`/notes/${id}/reply`, { text })),
      setStatus: (id, status) => act(() => headApi.post(`/notes/${id}/status`, { status })),
      remove: (id) => (window.confirm("Delete this suggestion and its replies?") ? act(() => headApi.del(`/notes/${id}`)) : null),
    };
  }, [area, courses, courseId, data, busy, err, act]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── One suggestion with its replies and actions ─────────────────────────────
export function NoteCard({ n, ctx, showAbout = true }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const send = async () => { if (await ctx.reply(n.id, text)) { setText(""); setReplying(false); } };
  return (
    <div className={`sp-note${n.status === "done" ? " sp-note--done" : ""}`}>
      <div className="sp-meta">
        <b>{n.author_name || (n.author_role === "head" ? "Head" : "Delegate")}</b>
        <span className={`sp-tag sp-tag--${n.author_role}`}>{n.author_role === "head" ? "Head" : "Delegate"}</span>
        <span className="sp-time">{fmtWhen(n.created_at)}</span>
      </div>
      {showAbout && n.about && <div className="sp-about">{n.about}</div>}
      <p className="sp-text">{n.text}</p>
      {(n.replies || []).map((r, i) => (
        <div key={i} className="sp-reply">
          <div className="sp-meta"><b>{r.author_name}</b><span className="sp-time">{fmtWhen(r.at)}</span></div>
          <p className="sp-text">{r.text}</p>
        </div>
      ))}
      {n.status === "done" && <div className="sp-resolved">Done{n.resolved_by ? ` by ${n.resolved_by}` : ""}{n.resolved_at ? `, ${fmtWhen(n.resolved_at)}` : ""}</div>}
      {replying ? (
        <div className="sp-replybox">
          <textarea className="sp-input sp-ta" rows={2} maxLength={1000} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply" />
          <div className="sp-actions">
            <button type="button" className="sp-link" onClick={() => { setReplying(false); setText(""); }}>Cancel</button>
            <button type="button" className="sp-send" disabled={ctx.busy || !text.trim()} onClick={send}>Reply</button>
          </div>
        </div>
      ) : (
        <div className="sp-actions">
          <button type="button" className="sp-link" onClick={() => setReplying(true)}>Reply</button>
          <button type="button" className="sp-link" disabled={ctx.busy} onClick={() => ctx.setStatus(n.id, n.status === "open" ? "done" : "open")}>
            {n.status === "open" ? "Mark done" : "Reopen"}
          </button>
          {(ctx.isHead || n.mine) && <button type="button" className="sp-link sp-link--danger" disabled={ctx.busy} onClick={() => ctx.remove(n.id)}>Delete</button>}
        </div>
      )}
    </div>
  );
}

// ── Hover comment pin (Canva-style) ─────────────────────────────────────────
// Put it inside an element that has the "cm-hover" class (and position: relative);
// the pin appears when that element is hovered, and stays visible while it has open notes.
export function CommentPin({ about, courseId, inline = false }) {
  const ctx = useSuggestions();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const pop = useRef(null);
  const setCourse = ctx?.setCourseId;

  useEffect(() => { if (courseId && setCourse) setCourse(courseId); }, [courseId, setCourse]);

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const W = 340, H = Math.min(window.innerHeight * 0.7, 460);
    const left = Math.max(8, Math.min(r.right + 8 > window.innerWidth - W - 8 ? r.left - W - 8 : r.right + 8, window.innerWidth - W - 8));
    const top = Math.max(8, Math.min(r.top - 8, window.innerHeight - H - 8));
    setPos({ left, top, maxHeight: H });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    place();
    const onDown = (e) => { if (!pop.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  if (!ctx || !ctx.ready || (courseId && ctx.courseId !== courseId)) return null;

  const mine = ctx.notes.filter((n) => n.about === about);
  const openCount = mine.filter((n) => n.status === "open").length;
  const send = async () => { if (await ctx.post(text, about)) setText(""); };

  return (
    <>
      <button
        ref={btn} type="button"
        className={`cm-pin${inline ? " cm-pin--inline" : ""}${openCount ? " cm-pin--has" : ""}`}
        title={ctx.isHead ? "Suggest a change" : "Note for the head"}
        aria-label={`Comments on ${about}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {openCount > 0 && <span className="cm-pin-n">{openCount}</span>}
      </button>

      {open && pos && createPortal(
        <div ref={pop} className="cm-pop" style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }} role="dialog" aria-label="Comments">
          <div className="cm-pop-head">
            <div className="cm-pop-about">{about}</div>
            <button type="button" className="sp-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          <div className="cm-pop-list">
            {mine.length === 0 && <p className="sp-empty">No comments here yet.</p>}
            {mine.map((n) => <NoteCard key={n.id} n={n} ctx={ctx} showAbout={false} />)}
          </div>
          {ctx.err && <div className="sp-err">{ctx.err}</div>}
          <div className="cm-pop-compose">
            <textarea
              className="sp-input sp-ta" rows={2} maxLength={1000} value={text} autoFocus
              placeholder={ctx.isHead ? "Suggest a change" : "Leave a note for the head"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim() && !ctx.busy) send(); }}
            />
            <button type="button" className="sp-send" disabled={ctx.busy || !text.trim()} onClick={send}>Send</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}