// @ts-nocheck
// Shared building blocks for the student portal: data hooks (cached, stale-while-revalidate),
// formatting helpers, small UI components and the page shell (sidebar + top bar).

import { useEffect, useReducer, useRef, useState, useCallback } from "react";
import { useLocation } from "react-router-dom";
import AppSidebar from "../../components/AppSidebar";
import { studentApi, myUid } from "../../services/studentApi";
import { getUserSession } from "../../services/session";
import "./Student.css";

/* ═══════════════════════════════════════════════════════════════════════
   Data layer — tiny cache so moving between pages is instant and the
   sidebar badges share the same requests as the pages.
   ═══════════════════════════════════════════════════════════════════════ */
const store = new Map(); // key -> { data, error, ts, ttl, promise, subs }

function entry(key) {
  if (!store.has(key)) store.set(key, { data: undefined, error: null, ts: 0, ttl: 20000, promise: null, subs: new Set() });
  return store.get(key);
}
function emit(e) {
  e.subs.forEach((f) => f());
}
function run(key, fetcher, force) {
  const e = entry(key);
  if (e.promise) return e.promise;
  if (!force && e.data !== undefined && Date.now() - e.ts < e.ttl) return Promise.resolve();
  e.promise = fetcher()
    .then((d) => {
      e.data = d;
      e.error = null;
      e.ts = Date.now();
    })
    .catch((err) => {
      e.error = err;
    })
    .finally(() => {
      e.promise = null;
      emit(e);
    });
  emit(e);
  return e.promise;
}

/** Forget cached data whose key starts with `prefix` (call after a write). */
export function invalidate(prefix) {
  for (const [k, e] of store) {
    if (k.startsWith(prefix)) {
      e.ts = 0;
      emit(e);
    }
  }
}

export function useQuery(key, fetcher, { ttl = 20000, enabled = true } = {}) {
  const [, rerender] = useReducer((x) => x + 1, 0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const e = entry(key);
  e.ttl = ttl;

  useEffect(() => {
    if (!enabled) return undefined;
    const en = entry(key);
    en.subs.add(rerender);
    run(key, () => fetchRef.current(), false);
    return () => en.subs.delete(rerender);
  }, [key, enabled]);

  const reload = useCallback(() => run(key, () => fetchRef.current(), true), [key]);
  return {
    data: e.data,
    error: e.error,
    loading: enabled && e.data === undefined && !e.error,
    refreshing: !!e.promise,
    reload,
  };
}

const K = (name) => `${name}:${myUid() || "anon"}`;
export const useFeed = () => useQuery(K("feed"), () => studentApi.feed(), { ttl: 30000 });
export const useQuizzes = () => useQuery(K("quizzes"), () => studentApi.quizzes(), { ttl: 15000 });
export const useBroadcasts = () => useQuery(K("broadcasts"), () => studentApi.broadcasts(), { ttl: 30000 });
export const useProfile = () => useQuery(K("profile"), () => studentApi.profile(), { ttl: 120000 });
export const refreshFeed = () => invalidate("feed:");
export const refreshQuizzes = () => invalidate("quizzes:");

/* ═══════════════════════════════════════════════════════════════════════
   Formatting / derived state
   ═══════════════════════════════════════════════════════════════════════ */
const PALETTE = ["#4834D4", "#0E9F6E", "#E0752D", "#D63384", "#0891B2", "#7C3AED", "#B45309", "#2563EB", "#BE123C", "#4D7C0F"];
export function subjectColor(id = "") {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function fmtDate(iso, opts) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-IN", opts || { day: "numeric", month: "short", year: "numeric" });
}
export function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}
export function fmtDateTime(iso) {
  if (!iso) return "—";
  return `${fmtDate(iso, { day: "numeric", month: "short" })}, ${fmtTime(iso)}`;
}
export function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** "Due in 2 days" / "Due today, 5:00 PM" / "Overdue by 3 days" */
export function dueLabel(iso, now = Date.now()) {
  if (!iso) return "No due date";
  const due = new Date(iso).getTime();
  const diff = due - now;
  const day = 86400000;
  if (diff < 0) {
    const d = Math.floor(-diff / day);
    if (d === 0) return "Overdue today";
    return `Overdue by ${d} day${d > 1 ? "s" : ""}`;
  }
  const sameDay = new Date(due).toDateString() === new Date(now).toDateString();
  if (sameDay) return `Due today, ${fmtTime(iso)}`;
  const tomorrow = new Date(now + day).toDateString() === new Date(due).toDateString();
  if (tomorrow) return `Due tomorrow, ${fmtTime(iso)}`;
  return `Due ${fmtDate(iso, { day: "numeric", month: "short" })}, ${fmtTime(iso)}`;
}

/** todo | overdue | submitted | late | graded | missed */
export function assignmentState(a, now = Date.now()) {
  const sub = a.my_submission;
  if (sub) {
    if (sub.status === "graded") return "graded";
    return sub.status === "late" ? "late" : "submitted";
  }
  const due = a.due_date ? new Date(a.due_date).getTime() : null;
  if (due && due < now) return a.allow_late ? "overdue" : "missed";
  return "todo";
}
export const isOpenWork = (s) => s === "todo" || s === "overdue";

export const STATE_META = {
  todo: { label: "Assigned", tone: "blue" },
  overdue: { label: "Overdue", tone: "red" },
  submitted: { label: "Turned in", tone: "green" },
  late: { label: "Turned in late", tone: "amber" },
  graded: { label: "Graded", tone: "purple" },
  missed: { label: "Missed", tone: "red" },
};

export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useStudentInfo() {
  const session = getUserSession();
  const profile = session?.profile || {};
  const name = profile.name || [profile.first_name, profile.last_name].filter(Boolean).join(" ") || session?.user?.email || "Student";
  return { uid: session?.uid, name, firstName: String(name).split(" ")[0], profile, email: session?.user?.email };
}

/* ═══════════════════════════════════════════════════════════════════════
   Toasts
   ═══════════════════════════════════════════════════════════════════════ */
const toastBus = new Set();
export function toast(message, tone = "ok") {
  toastBus.forEach((f) => f({ id: Math.random(), message, tone }));
}
function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const on = (t) => {
      setItems((a) => [...a, t]);
      setTimeout(() => setItems((a) => a.filter((x) => x.id !== t.id)), 4200);
    };
    toastBus.add(on);
    return () => toastBus.delete(on);
  }, []);
  return (
    <div className="st-toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`st-toast st-toast--${t.tone}`}>{t.message}</div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Small components
   ═══════════════════════════════════════════════════════════════════════ */
export function Spinner({ label }) {
  return (
    <div className="st-spinner-wrap">
      <div className="st-spinner" />
      {label && <span>{label}</span>}
    </div>
  );
}
export function Skeleton({ rows = 3, height = 74 }) {
  return (
    <div className="st-skeletons">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="st-skeleton" style={{ height }} />
      ))}
    </div>
  );
}
export function Empty({ icon = "✨", title, text, action }) {
  return (
    <div className="st-empty">
      <div className="st-empty-icon">{icon}</div>
      <div className="st-empty-title">{title}</div>
      {text && <div className="st-empty-text">{text}</div>}
      {action}
    </div>
  );
}
export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="st-error">
      <span>{error.message || String(error)}</span>
      {onRetry && <button className="st-btn st-btn--ghost st-btn--sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}
export function Pill({ tone = "gray", children, title }) {
  return <span className={`st-pill st-pill--${tone}`} title={title}>{children}</span>;
}
export function StatePill({ state }) {
  const m = STATE_META[state] || STATE_META.todo;
  return <Pill tone={m.tone}>{m.label}</Pill>;
}
export function SubjectDot({ id, size = 10 }) {
  return <span className="st-dot" style={{ background: subjectColor(id), width: size, height: size }} />;
}
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="stp-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          className={`stp-tab${value === t.key ? " stp-tab--active" : ""}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count != null && t.count > 0 && <span className="stp-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function Ring({ pct, size = 64, stroke = 7, color }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const col = color || (pct == null ? "#D1D5DB" : pct >= 75 ? "#10B981" : pct >= 60 ? "#F59E0B" : "#EF4444");
  return (
    <svg width={size} height={size} className="st-ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EEF0F4" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c - (c * v) / 100}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="st-ring-text" fill={col}>
        {pct == null ? "—" : `${Math.round(pct)}%`}
      </text>
    </svg>
  );
}

export function FileIcon({ name = "", type = "" }) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const label = type.startsWith("image/") ? "IMG" : ext === "pdf" ? "PDF" : ["doc", "docx"].includes(ext) ? "DOC" : ["ppt", "pptx"].includes(ext) ? "PPT" : ["xls", "xlsx"].includes(ext) ? "XLS" : (ext || "FILE").slice(0, 4).toUpperCase();
  const tone = label === "PDF" ? "#EF4444" : label === "DOC" ? "#2563EB" : label === "PPT" ? "#E0752D" : label === "XLS" ? "#0E9F6E" : label === "IMG" ? "#7C3AED" : "#6B7280";
  return <span className="st-fileicon" style={{ background: tone + "1A", color: tone }}>{label}</span>;
}
export function Attachments({ files = [], links = [] }) {
  if (!files.length && !links.length) return null;
  return (
    <div className="st-attachments">
      {files.map((f, i) => (
        <a key={f.key || f.url || i} className="st-attach" href={f.url} target="_blank" rel="noopener noreferrer">
          <FileIcon name={f.name} type={f.type} />
          <span className="st-attach-body">
            <span className="st-attach-name">{f.name || "Attachment"}</span>
            {f.size ? <span className="st-attach-meta">{fmtSize(f.size)}</span> : null}
          </span>
        </a>
      ))}
      {links.map((l, i) => (
        <a key={l.url + i} className="st-attach" href={l.url} target="_blank" rel="noopener noreferrer">
          <span className="st-fileicon" style={{ background: "#E0F2FE", color: "#0369A1" }}>URL</span>
          <span className="st-attach-body">
            <span className="st-attach-name">{l.label || l.url}</span>
            <span className="st-attach-meta">{l.url.replace(/^https?:\/\//, "").slice(0, 48)}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

export function Modal({ title, children, onClose, footer, width = 460 }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="st-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="st-modal" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        {title && <div className="st-modal-title">{title}</div>}
        <div className="st-modal-body">{children}</div>
        {footer && <div className="st-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, sub, actions }) {
  return (
    <div className="st-pagehead">
      <div>
        <h1 className="st-h1">{title}</h1>
        {sub && <p className="st-sub">{sub}</p>}
      </div>
      {actions && <div className="st-pagehead-actions">{actions}</div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Page shell: sidebar + top bar (+ off-canvas menu on phones)
   ═══════════════════════════════════════════════════════════════════════ */
export function StudentShell({ title, children, flush = false }) {
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const { name } = useStudentInfo();

  // badges for the sidebar (share the cached requests with the pages)
  const feed = useFeed();
  const quizzes = useQuizzes();
  const inbox = useBroadcasts();
  const now = Date.now();
  const todo = (feed.data?.assignments || []).filter((a) => isOpenWork(assignmentState(a, now))).length;
  const liveTests = (quizzes.data?.live || []).length;
  const unread = (inbox.data?.broadcasts || []).filter((b) => !b.is_read).length;

  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className={`st-page${navOpen ? " st-page--nav" : ""}`}>
      <AppSidebar role="student" badges={{ todo, liveTests, unread }} />
      {navOpen && <div className="st-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="st-main-wrap">
        <header className="st-topbar">
          <div className="st-topbar-left">
            <button className="st-menu" onClick={() => setNavOpen((v) => !v)} aria-label="Menu">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
            </button>
            <span className="st-topbar-title">{title}</span>
          </div>
          <div className="st-topbar-right">
            <span className="st-topbar-date">{new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</span>
            <span className="st-role-pill">Student</span>
            <span className="st-topbar-avatar" title={name}>{(name[0] || "S").toUpperCase()}</span>
          </div>
        </header>
        <main className={flush ? "st-main st-main--flush" : "st-main"}>{children}</main>
      </div>
      <ToastHost />
    </div>
  );
}