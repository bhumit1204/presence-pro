// @ts-nocheck
import { useNavigate } from "react-router-dom";
import {
  StudentShell, useFeed, useQuizzes, useBroadcasts, useStudentInfo,
  Skeleton, Empty, ErrorBox, Pill, StatePill, SubjectDot, subjectColor,
  assignmentState, isOpenWork, dueLabel, fmtDateTime, fmtDate, greeting, useNow,
} from "./ui";

const BASE = "/dashboard/student";

function Stat({ icon, tone, value, label, onClick }) {
  return (
    <button className="st-stat" onClick={onClick}>
      <span className="st-stat-icon" style={{ background: tone + "1A", color: tone }}>{icon}</span>
      <span>
        <div className="st-stat-value" style={{ color: tone }}>{value}</div>
        <div className="st-stat-label">{label}</div>
      </span>
    </button>
  );
}

export default function StudentHome() {
  const nav = useNavigate();
  const { firstName, profile } = useStudentInfo();
  const now = useNow(30000);

  const feed = useFeed();
  const quizzes = useQuizzes();
  const inbox = useBroadcasts();

  const assignments = feed.data?.assignments || [];
  const open = assignments
    .filter((a) => isOpenWork(assignmentState(a, now)))
    .sort((a, b) => new Date(a.due_date || 8e15) - new Date(b.due_date || 8e15));
  const live = quizzes.data?.live || [];
  const upcoming = (quizzes.data?.scheduled || []).slice().reverse(); // soonest first
  const unread = (inbox.data?.broadcasts || []).filter((b) => !b.is_read).length;

  // latest announcements: class posts + teacher broadcasts, newest first
  const posts = [
    ...(feed.data?.announcements || []).map((a) => ({ id: "c" + a.announcement_id, title: a.title, text: a.text, at: a.created_at, who: a.subject_name, kind: "class", subject_id: a.subject_id })),
    ...(inbox.data?.broadcasts || []).map((b) => ({ id: "b" + b.broadcast_id, title: b.title || "Announcement", text: b.text, at: b.created_at, who: "Message from your teacher", kind: "broadcast", urgent: b.is_urgent, unread: !b.is_read })),
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 5);

  const loading = feed.loading && quizzes.loading;

  return (
    <StudentShell title="Home">
      <div className="st-hero">
        <div>
          <h1>{greeting()}, {firstName} 👋</h1>
          <p>{open.length > 0 ? `You have ${open.length} pending ${open.length === 1 ? "assignment" : "assignments"}${live.length ? ` and ${live.length} live ${live.length === 1 ? "test" : "tests"}` : ""}.` : live.length ? `You have ${live.length} live ${live.length === 1 ? "test" : "tests"} waiting.` : "You're all caught up. Nice work!"}</p>
          <div className="st-hero-chips">
            {profile.course_name && <span className="st-hero-chip">{profile.course_name}</span>}
            {profile.semester && <span className="st-hero-chip">Semester {profile.semester}</span>}
            {(profile.roll_no || profile.roll_number) && <span className="st-hero-chip">Roll {profile.roll_no || profile.roll_number}</span>}
          </div>
        </div>
        {live.length > 0 && (
          <button className="st-btn" style={{ background: "#fff", color: "#4834D4", position: "relative", zIndex: 1 }} onClick={() => nav(`${BASE}/tests`)}>
            Go to live test →
          </button>
        )}
      </div>

      <div className="st-grid st-grid--4">
        <Stat icon="📚" tone="#10B981" value={(feed.data?.subjects || []).length} label="My classes" onClick={() => nav(`${BASE}/classes`)} />
        <Stat icon="📝" tone="#4834D4" value={open.length} label="Assignments to do" onClick={() => nav(`${BASE}/assignments`)} />
        <Stat icon="🧠" tone="#E0752D" value={live.length || upcoming.length} label={live.length ? "Live tests" : "Upcoming tests"} onClick={() => nav(`${BASE}/tests`)} />
        <Stat icon="📢" tone="#0891B2" value={unread} label="Unread announcements" onClick={() => nav(`${BASE}/announcements`)} />
      </div>

      <ErrorBox error={feed.error && !feed.data ? feed.error : null} onRetry={feed.reload} />

      <div className="st-split">
        <div className="st-stack" style={{ gap: 18 }}>
          {/* Due soon */}
          <section>
            <div className="st-section-head">
              <h2 className="st-h2">Due soon</h2>
              <button className="st-link" onClick={() => nav(`${BASE}/assignments`)}>View all</button>
            </div>
            {feed.loading ? <Skeleton rows={3} /> : open.length === 0 ? (
              <Empty icon="🎉" title="Nothing due" text="No pending assignments right now." />
            ) : (
              <div className="st-card st-card--flat">
                {open.slice(0, 5).map((a) => {
                  const st = assignmentState(a, now);
                  return (
                    <button key={a.assignment_id} className="st-row" onClick={() => nav(`${BASE}/assignments/${a.assignment_id}`)}>
                      <span className="st-row-icon" style={{ background: subjectColor(a.subject_id) }}>📝</span>
                      <span className="st-row-body">
                        <div className="st-row-title">{a.title}</div>
                        <div className="st-row-meta"><span>{a.subject_name}</span>{a.marks != null && <span>· {a.marks} marks</span>}</div>
                      </span>
                      <span className="st-row-end">
                        <span style={{ color: st === "overdue" ? "#DC2626" : undefined, fontWeight: 700 }}>{dueLabel(a.due_date, now)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Tests */}
          <section>
            <div className="st-section-head">
              <h2 className="st-h2">Tests</h2>
              <button className="st-link" onClick={() => nav(`${BASE}/tests`)}>View all</button>
            </div>
            {quizzes.loading ? <Skeleton rows={2} /> : live.length + upcoming.length === 0 ? (
              <Empty icon="🧠" title="No tests scheduled" text="When a teacher schedules a test, it will show up here." />
            ) : (
              <div className="st-card st-card--flat">
                {[...live.map((q) => ({ q, live: true })), ...upcoming.slice(0, 3).map((q) => ({ q, live: false }))].slice(0, 5).map(({ q, live: isLive }) => (
                  <button key={q.quiz_id} className="st-row" onClick={() => nav(`${BASE}/tests`)}>
                    <span className="st-row-icon" style={{ background: isLive ? "#10B981" : "#E0752D" }}>🧠</span>
                    <span className="st-row-body">
                      <div className="st-row-title">{q.title}</div>
                      <div className="st-row-meta"><span>{q.subject_name}</span><span>· {q.time_limit_minutes} min</span><span>· {q.total_marks} marks</span></div>
                    </span>
                    <span className="st-row-end">
                      {isLive ? <Pill tone="green">Live now</Pill> : <span>{fmtDateTime(q.scheduled_start)}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="st-stack" style={{ gap: 18 }}>
          {/* announcements */}
          <section>
            <div className="st-section-head">
              <h2 className="st-h2">Latest announcements</h2>
              <button className="st-link" onClick={() => nav(`${BASE}/announcements`)}>View all</button>
            </div>
            {feed.loading && inbox.loading ? <Skeleton rows={3} height={64} /> : posts.length === 0 ? (
              <Empty icon="📢" title="No announcements" />
            ) : (
              <div className="st-card st-card--flat">
                {posts.map((p) => (
                  <button key={p.id} className="st-row" onClick={() => nav(`${BASE}/announcements`)}>
                    <span className="st-row-body">
                      <div className="st-row-title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {p.unread && <span className="st-dot" style={{ background: "#4834D4", width: 8, height: 8 }} />}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.title}</span>
                        {p.urgent && <Pill tone="red">Urgent</Pill>}
                      </div>
                      <div className="st-row-meta"><span>{p.who}</span><span>· {fmtDate(p.at, { day: "numeric", month: "short" })}</span></div>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* classes */}
          {(feed.data?.subjects || []).length > 0 && (
            <section>
              <div className="st-section-head">
                <h2 className="st-h2">Your classes</h2>
                <button className="st-link" onClick={() => nav(`${BASE}/classes`)}>Open</button>
              </div>
              <div className="st-chips">
                {feed.data.subjects.map((s) => (
                  <button key={s.subject_id} className="st-chip" onClick={() => nav(`${BASE}/classes/${s.subject_id}`)}>
                    <SubjectDot id={s.subject_id} /> {s.subject_name}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </StudentShell>
  );
}
