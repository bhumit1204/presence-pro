// @ts-nocheck
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  StudentShell, PageHeader, useFeed, Tabs, Skeleton, Empty, ErrorBox, StatePill, SubjectDot,
  assignmentState, isOpenWork, dueLabel, fmtDate, useNow,
} from "./ui";

export default function AssignmentsPage() {
  const nav = useNavigate();
  const now = useNow(60000);
  const feed = useFeed();
  const [tab, setTab] = useState("all");
  const [subject, setSubject] = useState("all");
  const [q, setQ] = useState("");

  const subjects = feed.data?.subjects || [];
  const all = feed.data?.assignments || [];

  const decorated = useMemo(() => all.map((a) => ({ a, st: assignmentState(a, now) })), [all, now]);
  const inSubject = decorated.filter(({ a }) => (subject === "all" || a.subject_id === subject) && (!q || a.title.toLowerCase().includes(q.toLowerCase())));

  const buckets = {
    todo: inSubject.filter(({ st }) => isOpenWork(st)).sort((x, y) => new Date(x.a.due_date || 8e15) - new Date(y.a.due_date || 8e15)),
    done: inSubject.filter(({ st }) => st === "submitted" || st === "late" || st === "graded"),
    missed: inSubject.filter(({ st }) => st === "missed"),
    all: inSubject,
  };
  const list = buckets[tab];

  return (
    <StudentShell title="Assignments">
      <PageHeader title="Assignments" sub="Everything your teachers have assigned — turn in work right from here." />
      <ErrorBox error={feed.error && !feed.data ? feed.error : null} onRetry={feed.reload} />

      <div className="st-card" style={{ padding: "0 8px" }}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "all", label: "All" },
            { key: "todo", label: "To do", count: buckets.todo.length },
            { key: "done", label: "Turned in" },
            { key: "missed", label: "Missed", count: buckets.missed.length },
          ]}
        />
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div className="st-chips" style={{ flex: 1 }}>
          <button className={`st-chip${subject === "all" ? " st-chip--active" : ""}`} onClick={() => setSubject("all")}>All subjects</button>
          {subjects.map((s) => (
            <button key={s.subject_id} className={`st-chip${subject === s.subject_id ? " st-chip--active" : ""}`} onClick={() => setSubject(s.subject_id)}>
              <SubjectDot id={s.subject_id} /> {s.subject_name}
            </button>
          ))}
        </div>
        <input className="st-input" style={{ maxWidth: 240 }} placeholder="Search assignments" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {feed.loading ? <Skeleton rows={5} /> : list.length === 0 ? (
        <Empty
          icon={tab === "todo" ? "🎉" : "📭"}
          title={tab === "todo" ? "You're all caught up" : "Nothing here"}
          text={tab === "todo" ? "No pending assignments in this view." : "Assignments in this state will appear here."}
        />
      ) : (
        <div className="st-card st-card--flat">
          {list.map(({ a, st }) => (
            <button key={a.assignment_id} className="st-row" onClick={() => nav(`/dashboard/student/assignments/${a.assignment_id}`)}>
              <span className="st-row-icon" style={{ background: "#6B7280" }}>📝</span>
              <span className="st-row-body">
                <div className="st-row-title">{a.title}</div>
                <div className="st-row-meta">
                  <SubjectDot id={a.subject_id} size={8} /> <span>{a.subject_name}</span>
                  {a.marks != null && <span>· {a.marks} marks</span>}
                </div>
              </span>
              <span className="st-row-end">
                <StatePill state={st} />
                {st === "graded" ? (
                  <span className="st-row-score">{a.my_submission.marks_obtained ?? "—"}/{a.marks}</span>
                ) : (
                  <span style={{ color: st === "overdue" || st === "missed" ? "#DC2626" : undefined, fontWeight: 600 }}>
                    {isOpenWork(st) || st === "missed" ? dueLabel(a.due_date, now) : `Due ${fmtDate(a.due_date)}`}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </StudentShell>
  );
}