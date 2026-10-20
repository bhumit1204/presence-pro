// @ts-nocheck
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { studentApi } from "../../services/studentApi";
import { StudentShell, Skeleton, ErrorBox, Pill, Empty, fmtDateTime } from "./ui";

export default function TestResult() {
  const { quizId } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let dead = false;
    setData(null); setError(null);
    studentApi.quizResult(quizId)
      .then((r) => !dead && setData(r))
      .catch((e) => !dead && setError(e));
    return () => { dead = true; };
  }, [quizId]);

  const sub = data?.submission;
  const pct = sub ? Math.round(sub.percentage ?? 0) : 0;
  const verdict = pct >= 85 ? "Outstanding! 🏆" : pct >= 60 ? "Well done! 👏" : pct >= 40 ? "Good effort 💪" : "Keep practising 📚";

  return (
    <StudentShell title="Test result">
      <button className="st-link" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => nav("/dashboard/student/tests")}>← All tests</button>
      <ErrorBox error={error} onRetry={() => nav(0)} />
      {!sub && !error && <Skeleton rows={3} height={110} />}
      {error?.status === 404 && <Empty icon="📭" title="No result yet" text="You haven't submitted this test." />}

      {sub && (
        <>
          <div className="st-result-hero">
            <div style={{ opacity: 0.9, fontSize: 14, fontWeight: 700 }}>{data.quiz.subject_name}</div>
            <div style={{ fontSize: 20, fontWeight: 800, margin: "2px 0 14px" }}>{data.quiz.title}</div>
            <div className="st-result-pct">{pct}%</div>
            <div style={{ fontSize: 17, fontWeight: 700, marginTop: 8 }}>{sub.marks_obtained} / {sub.total_marks} marks</div>
            <div style={{ opacity: 0.9, marginTop: 6 }}>{verdict} · Submitted {fmtDateTime(sub.submitted_at)}</div>
          </div>

          <div className="st-h2">Your answers</div>
          <div className="st-stack">
            {sub.answers.map((a, i) => {
              const full = a.marks_obtained >= a.marks_possible && a.marks_possible > 0;
              const none = !a.marks_obtained;
              const cls = a.type === "mcq" ? (a.is_correct ? "ok" : "bad") : full ? "ok" : none ? "bad" : "part";
              return (
                <div key={a.question_id || i} className={`st-ans st-ans--${cls}`}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ fontWeight: 700, fontSize: 14.5 }}>{i + 1}. {a.question_text}</div>
                    <Pill tone={cls === "ok" ? "green" : cls === "part" ? "amber" : "red"}>{a.marks_obtained ?? 0}/{a.marks_possible ?? 0}</Pill>
                  </div>
                  <div className="st-ans-line"><b>Your answer:</b> {a.student_answer ? a.student_answer : <i style={{ color: "#9CA3AF" }}>Not answered</i>}</div>
                  {a.type === "mcq" && !a.is_correct && a.correct_answer && <div className="st-ans-line"><b>Correct answer:</b> {a.correct_answer}</div>}
                  {a.type !== "mcq" && a.feedback && <div className="st-ans-line"><b>Feedback:</b> {a.feedback}</div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </StudentShell>
  );
}
