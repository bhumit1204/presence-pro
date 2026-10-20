// @ts-nocheck
import { useNavigate } from "react-router-dom";
import {
  StudentShell, PageHeader, useFeed, useQuizzes, Skeleton, Empty, ErrorBox, Pill,
  subjectColor, assignmentState, isOpenWork, useNow,
} from "./ui";

export default function ClassesPage() {
  const nav = useNavigate();
  const now = useNow(60000);
  const feed = useFeed();
  const quizzes = useQuizzes();

  const subjects = feed.data?.subjects || [];
  const assignments = feed.data?.assignments || [];
  const announcements = feed.data?.announcements || [];
  const live = quizzes.data?.live || [];
  const weekAgo = now - 7 * 86400000;

  return (
    <StudentShell title="My Classes">
      <PageHeader title="My classes" sub="Everything from your teachers, organised by subject." />
      <ErrorBox error={feed.error && !feed.data ? feed.error : null} onRetry={feed.reload} />

      {feed.loading ? (
        <div className="st-grid st-grid--classes">
          {[0, 1, 2].map((i) => <div key={i} className="st-skeleton" style={{ height: 220 }} />)}
        </div>
      ) : subjects.length === 0 && !feed.error ? (
        <Empty icon="📚" title="No classes yet" text="You aren't enrolled in any subject yet. Contact your department if this looks wrong." />
      ) : (
        <div className="st-grid st-grid--classes">
          {subjects.map((s) => {
            const color = subjectColor(s.subject_id);
            const todo = assignments.filter((a) => a.subject_id === s.subject_id && isOpenWork(assignmentState(a, now))).length;
            const fresh = announcements.filter((a) => a.subject_id === s.subject_id && new Date(a.created_at || 0).getTime() > weekAgo).length;
            const liveN = live.filter((q) => q.subject_id === s.subject_id).length;
            return (
              <button key={s.subject_id} className="st-class-card" onClick={() => nav(`/dashboard/student/classes/${s.subject_id}`)}>
                <div className="st-class-top" style={{ background: `linear-gradient(135deg, ${color}, ${color}CC)` }}>
                  <div className="st-class-name">{s.subject_name}</div>
                  <div className="st-class-code">{[s.subject_code, s.course_name].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="st-class-body">
                  <div className="st-class-teacher">👤 {s.teacher_name || "Teacher not assigned"}</div>
                  <div className="st-class-stats">
                    {todo > 0 ? <Pill tone="blue">{todo} to do</Pill> : <Pill tone="gray">No pending work</Pill>}
                    {fresh > 0 && <Pill tone="amber">{fresh} new post{fresh > 1 ? "s" : ""}</Pill>}
                    {liveN > 0 && <Pill tone="green">Live test</Pill>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </StudentShell>
  );
}
