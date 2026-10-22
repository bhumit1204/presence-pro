// @ts-nocheck
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  StudentShell, useFeed, useQuizzes, Tabs, Skeleton, Empty, ErrorBox, Pill, StatePill,
  Attachments, subjectColor, assignmentState, isOpenWork, dueLabel, fmtDate, fmtDateTime, useNow,
} from "./ui";
import { KindFilter, KindPill, TagFilter, TagPill, groupByTag, applyTag, kindOf } from "./workKind";

const BASE = "/dashboard/student";

function AnnouncementPost({ a, color, tags }) {
  const [open, setOpen] = useState(false);
  const long = (a.text || "").length > 280 || (a.text || "").split("\n").length > 4;
  return (
    <article className={`st-post${a.is_pinned ? " st-post--pinned" : ""}`}>
      <div className="st-post-head">
        <span className="st-row-icon" style={{ background: color }}>📢</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="st-post-title">{a.title}</div>
          <div className="st-post-meta">{fmtDateTime(a.created_at)}{a.is_pinned ? " · 📌 Pinned" : ""}{a.tag_id ? <> · <TagPill tags={tags} id={a.tag_id} /></> : null}</div>
        </div>
      </div>
      <div className={`st-post-text${!open && long ? " st-post-text--clamp" : ""}`}>{a.text}</div>
      {long && <button className="st-link" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => setOpen((v) => !v)}>{open ? "Show less" : "Show more"}</button>}
      <Attachments files={a.attachments} links={a.links} />
    </article>
  );
}

function AssignmentRow({ a, now, onOpen, tags }) {
  const st = assignmentState(a, now);
  return (
    <button className="st-row" onClick={onOpen}>
      <span className="st-row-icon" style={{ background: "#6B7280" }}>{kindOf(a).icon}</span>
      <span className="st-row-body">
        <div className="st-row-title">{a.title}</div>
        <div className="st-row-meta"><span>{isOpenWork(st) || st === "missed" ? dueLabel(a.due_date, now) : `Due ${fmtDate(a.due_date)}`}</span>{a.marks != null && <span>· {a.marks} marks</span>}<KindPill a={a} /><TagPill tags={tags} id={a.tag_id} /></div>
      </span>
      <span className="st-row-end">
        <StatePill state={st} />
        {st === "graded" && <span className="st-row-score">{a.my_submission.marks_obtained}/{a.marks}</span>}
      </span>
    </button>
  );
}

export default function ClassroomPage() {
  const { subjectId } = useParams();
  const nav = useNavigate();
  const now = useNow(60000);
  const feed = useFeed();
  const quizzes = useQuizzes();
  const [tab, setTab] = useState("stream");
  const [kindSel, setKindSel] = useState("all");
  const [tagSel, setTagSel] = useState("all");

  const subject = (feed.data?.subjects || []).find((s) => s.subject_id === subjectId);
  const color = subjectColor(subjectId);
  const subjectWork = (feed.data?.assignments || []).filter((a) => a.subject_id === subjectId);
  const tags = (feed.data?.tags || []).filter((t) => t.subject_id === subjectId);
  const assignments = applyTag(subjectWork, tagSel).filter((a) => kindSel === "all" || kindOf(a).key === kindSel);
  const allAnnouncements = (feed.data?.announcements || []).filter((a) => a.subject_id === subjectId);
  const announcements = applyTag(allAnnouncements, tagSel);
  const allQuizzes = [
    ...(quizzes.data?.live || []).map((q) => ({ ...q, _s: "live" })),
    ...(quizzes.data?.scheduled || []).map((q) => ({ ...q, _s: "scheduled" })),
    ...(quizzes.data?.completed || []).map((q) => ({ ...q, _s: q.submission ? "done" : "missed" })),
  ].filter((q) => q.subject_id === subjectId);

  const open = assignments.filter((a) => isOpenWork(assignmentState(a, now))).sort((a, b) => new Date(a.due_date || 8e15) - new Date(b.due_date || 8e15));

  // stream = announcements + assignments, pinned announcements first, then newest
  const stream = [
    ...announcements.map((a) => ({ type: "ann", at: a.created_at, pinned: a.is_pinned, a })),
    ...assignments.map((a) => ({ type: "work", at: a.created_at, pinned: false, a })),
  ].sort((x, y) => (x.pinned !== y.pinned ? (x.pinned ? -1 : 1) : new Date(y.at || 0) - new Date(x.at || 0)));

  // once the teacher uses tags, classwork is grouped by tag; otherwise by state
  const tagGroups = groupByTag(assignments, tags);
  const byTag = tagGroups.length > 1 || !!tagGroups[0]?.label;
  const stateGroups = [
    ["Assigned", assignments.filter((a) => isOpenWork(assignmentState(a, now)))],
    ["Missed", assignments.filter((a) => assignmentState(a, now) === "missed")],
    ["Turned in", assignments.filter((a) => ["submitted", "late"].includes(assignmentState(a, now)))],
    ["Graded", assignments.filter((a) => assignmentState(a, now) === "graded")],
  ].filter(([, list]) => list.length);
  const groups = byTag ? tagGroups.map((g) => [`🏷 ${g.label}`, g.items]) : stateGroups;

  return (
    <StudentShell title={subject?.subject_name || "Class"} flush>
      <div className="st-classroom-banner" style={{ background: `linear-gradient(135deg, ${color}, ${color}D9)` }}>
        <button className="st-back" onClick={() => nav(`${BASE}/classes`)}>← All classes</button>
        <h1>{subject?.subject_name || (feed.loading ? "Loading…" : "Class not found")}</h1>
        <p>{[subject?.subject_code, subject?.course_name, subject?.teacher_name && `Teacher: ${subject.teacher_name}`].filter(Boolean).join("  ·  ")}</p>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "stream", label: "Stream" },
            { key: "work", label: "Classwork", count: open.length },
            { key: "tests", label: "Tests", count: allQuizzes.filter((q) => q._s === "live").length },
          ]}
        />
      </div>

      <div className="st-classroom-body">
        <ErrorBox error={feed.error && !feed.data ? feed.error : null} onRetry={feed.reload} />
        {feed.loading ? <Skeleton rows={4} height={90} /> : !subject ? (
          <Empty icon="🔍" title="We couldn't find this class" text="It may not be one of your enrolled subjects." action={<button className="st-btn st-btn--primary" onClick={() => nav(`${BASE}/classes`)}>Back to my classes</button>} />
        ) : tab === "stream" ? (<>
          <TagFilter tags={tags} items={[...subjectWork, ...allAnnouncements]} value={tagSel} onChange={setTagSel} />
          <div className="st-split">
            <div className="st-stack">
              {stream.length === 0 ? <Empty icon="🪴" title="Nothing posted yet" text="Announcements and assignments from your teacher will appear here." /> : stream.map((item) =>
                item.type === "ann" ? (
                  <AnnouncementPost key={"a" + item.a.announcement_id} a={item.a} color={color} tags={tags} />
                ) : (
                  <article key={"w" + item.a.assignment_id} className="st-post" style={{ cursor: "pointer" }} onClick={() => nav(`${BASE}/assignments/${item.a.assignment_id}`)}>
                    <div className="st-post-head">
                      <span className="st-row-icon" style={{ background: color }}>{kindOf(item.a).icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="st-post-title">{kindOf(item.a).stream}: {item.a.title}</div>
                        <div className="st-post-meta">Posted {fmtDateTime(item.a.created_at)} · {dueLabel(item.a.due_date, now)}{item.a.tag_id ? <> · <TagPill tags={tags} id={item.a.tag_id} /></> : null}</div>
                      </div>
                      <StatePill state={assignmentState(item.a, now)} />
                    </div>
                  </article>
                )
              )}
            </div>
            <aside className="st-card">
              <div className="st-h2" style={{ marginBottom: 10 }}>Upcoming</div>
              {open.length === 0 ? <div className="st-sub">Woohoo, no work due soon!</div> : (
                <div className="st-stack" style={{ gap: 8 }}>
                  {open.slice(0, 5).map((a) => (
                    <button key={a.assignment_id} className="st-link" style={{ textAlign: "left", padding: 0, color: "#111827", fontWeight: 600 }} onClick={() => nav(`${BASE}/assignments/${a.assignment_id}`)}>
                      {a.title}
                      <div className="st-sub" style={{ margin: 0, fontWeight: 500 }}>{dueLabel(a.due_date, now)}</div>
                    </button>
                  ))}
                </div>
              )}
            </aside>
          </div></>
        ) : tab === "work" ? (<>
          <TagFilter tags={tags} items={subjectWork} value={tagSel} onChange={setTagSel} />
          <KindFilter items={subjectWork} value={kindSel} onChange={setKindSel} />
          {groups.length === 0 ? <Empty icon="📭" title="No classwork yet" text="Assignments will show up here as soon as your teacher posts them." /> : groups.map(([label, list]) => (
            <section key={label}>
              <div className="st-section-head"><h2 className="st-h2">{label} · {list.length}</h2></div>
              <div className="st-card st-card--flat">
                {list.map((a) => <AssignmentRow key={a.assignment_id} a={a} now={now} tags={tags} onOpen={() => nav(`${BASE}/assignments/${a.assignment_id}`)} />)}
              </div>
            </section>
          ))}</>
        ) : (
          allQuizzes.length === 0 ? <Empty icon="🧠" title="No tests for this class" /> : (
            <div className="st-card st-card--flat">
              {allQuizzes.map((q) => (
                <button key={q.quiz_id} className="st-row" onClick={() => nav(`${BASE}/tests`)}>
                  <span className="st-row-icon" style={{ background: q._s === "live" ? "#10B981" : "#E0752D" }}>🧠</span>
                  <span className="st-row-body">
                    <div className="st-row-title">{q.title}</div>
                    <div className="st-row-meta"><span>{fmtDateTime(q.scheduled_start)}</span><span>· {q.time_limit_minutes} min</span><span>· {q.total_marks} marks</span></div>
                  </span>
                  <span className="st-row-end">
                    {q._s === "live" && <Pill tone="green">Live now</Pill>}
                    {q._s === "scheduled" && <Pill tone="blue">Upcoming</Pill>}
                    {q._s === "done" && <><Pill tone="purple">Submitted</Pill><span className="st-row-score">{q.submission.marks_obtained}/{q.total_marks}</span></>}
                    {q._s === "missed" && <Pill tone="red">Missed</Pill>}
                  </span>
                </button>
              ))}
            </div>
          )
        )}
      </div>
    </StudentShell>
  );
}