// @ts-nocheck
import { useState } from "react";
import { studentApi } from "../../services/studentApi";
import {
  StudentShell, PageHeader, useFeed, useBroadcasts, invalidate, Tabs, Skeleton, Empty, ErrorBox, Pill,
  SubjectDot, Attachments, subjectColor, fmtDateTime,
} from "./ui";

function timeAgo(iso) {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 8 ? `${d}d ago` : fmtDateTime(iso);
}

const svg = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
const MegaphoneIcon = () => (<svg {...svg}><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 6a9 9 0 0 1 0 12" /></svg>);
const MailIcon = () => (<svg {...svg}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>);
const AlertIcon = () => (<svg {...svg}><path d="M12 3 2.5 20h19L12 3z" /><path d="M12 10v4" /><path d="M12 17.5v.01" /></svg>);
const PinIcon = () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 4, verticalAlign: "-1px" }}><path d="M16 3a1 1 0 0 1 .7 1.7L15.4 6l1.8 5.4c.1.3 0 .6-.2.8L15 14v1.5l-.5.5H13v5l-1 1-1-1v-5H9.5L9 15.5V14l-2-1.8a1 1 0 0 1-.2-.8L8.6 6 7.3 4.7A1 1 0 0 1 8 3h8z" /></svg>);

function ClassPost({ a }) {
  const [open, setOpen] = useState(false);
  const long = (a.text || "").length > 300 || (a.text || "").split("\n").length > 4;
  const color = subjectColor(a.subject_id);
  return (
    <article className={`st-post${a.is_pinned ? " st-post--pinned" : ""}`}>
      <div className="st-post-head">
        <span className="st-row-icon" style={{ background: color }}><MegaphoneIcon /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="st-post-title">{a.title}</div>
          <div className="st-post-meta" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <SubjectDot id={a.subject_id} size={8} /> {a.subject_name} · {timeAgo(a.created_at)}
            {a.is_pinned && <Pill tone="amber"><PinIcon />Pinned</Pill>}
          </div>
        </div>
      </div>
      <div className={`st-post-text${!open && long ? " st-post-text--clamp" : ""}`}>{a.text}</div>
      {long && <button className="st-link" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => setOpen((v) => !v)}>{open ? "Show less" : "Read more"}</button>}
      <Attachments files={a.attachments} links={a.links} />
    </article>
  );
}

function Message({ b, read, onOpen }) {
  const [open, setOpen] = useState(false);
  const unread = !read;
  return (
    <article className="st-post" style={{ borderColor: b.is_urgent ? "#FECACA" : unread ? "#C7D2FE" : undefined, background: b.is_urgent ? "#FFFAFA" : undefined, cursor: "pointer" }} onClick={() => { const next = !open; setOpen(next); if (next && unread) onOpen(b); }}>
      <div className="st-post-head">
        <span className="st-row-icon" style={{ background: b.is_urgent ? "#EF4444" : "#4834D4" }}>{b.is_urgent ? <AlertIcon /> : <MailIcon />}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="st-post-title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {unread && <span className="st-dot" style={{ background: "#4834D4", width: 9, height: 9 }} />}
            {b.title}
          </div>
          <div className="st-post-meta">Teacher message · {timeAgo(b.created_at)}</div>
        </div>
        {b.is_urgent && <Pill tone="red">Urgent</Pill>}
        {b.target_type && b.target_type !== "class" && <Pill tone="gray">{b.target_type === "group" ? "Group" : "Personal"}</Pill>}
      </div>
      <div className={`st-post-text${!open ? " st-post-text--clamp" : ""}`}>{b.text}</div>
    </article>
  );
}

export default function AnnouncementsPage() {
  const feed = useFeed();
  const inbox = useBroadcasts();
  const [tab, setTab] = useState("all");
  const [subject, setSubject] = useState("all");
  const [readNow, setReadNow] = useState({});

  const subjects = feed.data?.subjects || [];
  const posts = (feed.data?.announcements || []).filter((a) => subject === "all" || a.subject_id === subject);
  const msgs = inbox.data?.broadcasts || [];
  const unread = msgs.filter((b) => !b.is_read && !readNow[b.broadcast_id]).length;

  const markRead = async (b) => {
    setReadNow((r) => ({ ...r, [b.broadcast_id]: true }));
    try {
      await studentApi.markBroadcast(b.broadcast_id);
      invalidate("broadcasts:");
    } catch { /* will show unread again next time */ }
  };

  const merged = [
    ...(tab === "msgs" ? [] : posts.map((a) => ({ k: "p" + a.announcement_id, at: a.created_at, pinned: a.is_pinned, el: <ClassPost key={"p" + a.announcement_id} a={a} /> }))),
    ...(tab === "class" || subject !== "all" ? [] : msgs.map((b) => ({ k: "m" + b.broadcast_id, at: b.created_at, pinned: b.is_urgent && !b.is_read, el: <Message key={"m" + b.broadcast_id} b={b} read={b.is_read || readNow[b.broadcast_id]} onOpen={markRead} /> }))),
  ].sort((x, y) => (x.pinned !== y.pinned ? (x.pinned ? -1 : 1) : new Date(y.at || 0) - new Date(x.at || 0)));

  const loading = (tab !== "msgs" && feed.loading) || (tab !== "class" && inbox.loading);
  const err = (feed.error && !feed.data) || (inbox.error && !inbox.data) ? (feed.error || inbox.error) : null;

  return (
    <StudentShell title="Announcements">
      <PageHeader title="Announcements" sub="Class posts and messages from your teachers, all in one place." />
      <ErrorBox error={err} onRetry={() => { feed.reload(); inbox.reload(); }} />

      <div className="st-card" style={{ padding: "0 8px" }}>
        <Tabs value={tab} onChange={setTab} tabs={[
          { key: "all", label: "All" },
          { key: "class", label: "Class posts" },
          { key: "msgs", label: "Teacher messages", count: unread },
        ]} />
      </div>

      {tab !== "msgs" && subjects.length > 1 && (
        <div className="st-chips">
          <button className={`st-chip${subject === "all" ? " st-chip--active" : ""}`} onClick={() => setSubject("all")}>All subjects</button>
          {subjects.map((s) => (
            <button key={s.subject_id} className={`st-chip${subject === s.subject_id ? " st-chip--active" : ""}`} onClick={() => setSubject(s.subject_id)}>
              <SubjectDot id={s.subject_id} /> {s.subject_name}
            </button>
          ))}
        </div>
      )}

      {loading ? <Skeleton rows={4} height={110} /> : merged.length === 0 ? (
        <Empty icon="📭" title="No announcements" text="When a teacher posts to your class or sends you a message, you'll see it here." />
      ) : (
        <div className="st-stack">{merged.map((m) => m.el)}</div>
      )}
    </StudentShell>
  );
}