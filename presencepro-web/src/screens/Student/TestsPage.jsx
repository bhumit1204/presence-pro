// @ts-nocheck
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  StudentShell, PageHeader, useQuizzes, Tabs, Skeleton, Empty, ErrorBox, Pill,
  fmtDateTime, fmtDate, useNow, subjectColor, toast,
} from "./ui";

const BASE = "/dashboard/student";

function untilLabel(iso, now) {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h} h ${m % 60} min`;
  return `in ${Math.round(h / 24)} days`;
}

function TestCard({ q, kind, now, onStart }) {
  const [code, setCode] = useState("");
  const gated = !!q.join_code;
  const needsCode = kind === "live" && gated;
  const color = subjectColor(q.subject_id);
  const endsIn = kind === "live" ? untilLabel(q.scheduled_end, now) : null;

  return (
    <div className={`st-test-card${kind === "live" ? " st-test-card--live" : ""}`}>
      <span className="st-test-icon" style={{ background: color + "1A", color }}>🧠</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="st-test-title">{q.title}</div>
        <div className="st-test-meta">
          <span>{q.subject_name}</span>
          <span>⏱ {q.time_limit_minutes} min</span>
          <span>🎯 {q.total_marks} marks</span>
          {q.question_count != null && <span>❓ {q.question_count} questions</span>}
          {kind === "scheduled" && <span>🗓 {fmtDateTime(q.scheduled_start)} ({untilLabel(q.scheduled_start, now)})</span>}
          {kind === "live" && <span>Closes {fmtDateTime(q.scheduled_end)} ({endsIn})</span>}
          {kind === "done" && <span>Submitted {fmtDate(q.submission.submitted_at)}</span>}
        </div>
        {q.description && kind !== "done" && <div className="st-sub" style={{ marginTop: 6 }}>{q.description}</div>}
      </div>

      {kind === "live" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {needsCode && (
            <input className="st-input" style={{ width: 130, textAlign: "center", letterSpacing: 4, fontWeight: 800, textTransform: "uppercase" }} maxLength={6} placeholder="CODE" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          )}
          <button
            className="st-btn st-btn--green"
            onClick={() => {
              if (needsCode && code.trim().length !== 6) { toast("Enter the 6-character join code from your teacher", "err"); return; }
              onStart(q, needsCode ? code.trim() : "");
            }}
          >
            Start test →
          </button>
        </div>
      )}
      {kind === "scheduled" && <Pill tone="blue">Upcoming</Pill>}
      {kind === "done" && (
        <div style={{ textAlign: "right" }}>
          <div className="st-row-score" style={{ fontSize: 18 }}>{q.submission.marks_obtained}/{q.total_marks}</div>
          <button className="st-link" onClick={() => onStart(q, "", true)}>View result →</button>
        </div>
      )}
      {kind === "missed" && <Pill tone="red">Missed</Pill>}
    </div>
  );
}

export default function TestsPage() {
  const nav = useNavigate();
  const now = useNow(15000);
  const quizzes = useQuizzes();
  const [tab, setTab] = useState("live");
  const [joinCode, setJoinCode] = useState("");

  const live = quizzes.data?.live || [];
  const scheduled = (quizzes.data?.scheduled || []).slice().sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start));
  const completed = quizzes.data?.completed || [];
  const done = completed.filter((q) => q.submission);
  const missed = completed.filter((q) => !q.submission);

  const start = (q, code, result) => {
    if (result) return nav(`${BASE}/tests/result/${q.quiz_id}`);
    nav(`${BASE}/tests/take?quiz=${q.quiz_id}${code ? `&code=${encodeURIComponent(code)}` : ""}`);
  };

  const joinWithCode = () => {
    const c = joinCode.trim().toUpperCase();
    if (c.length !== 6) { toast("A join code has 6 characters", "err"); return; }
    nav(`${BASE}/tests/take?code=${encodeURIComponent(c)}`);
  };

  const list = tab === "live" ? live : tab === "scheduled" ? scheduled : [...done, ...missed];

  return (
    <StudentShell title="Tests">
      <PageHeader title="Tests" sub="Take live tests, see what's coming up and review your results." actions={
        <div style={{ display: "flex", gap: 8 }}>
          <input className="st-input" style={{ width: 150, textAlign: "center", letterSpacing: 4, fontWeight: 800, textTransform: "uppercase" }} maxLength={6} placeholder="JOIN CODE" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && joinWithCode()} />
          <button className="st-btn st-btn--primary" onClick={joinWithCode}>Join</button>
        </div>
      } />
      <ErrorBox error={quizzes.error && !quizzes.data ? quizzes.error : null} onRetry={quizzes.reload} />

      <div className="st-card" style={{ padding: "0 8px" }}>
        <Tabs value={tab} onChange={setTab} tabs={[
          { key: "live", label: "Live now", count: live.length },
          { key: "scheduled", label: "Upcoming", count: scheduled.length },
          { key: "completed", label: "Completed" },
        ]} />
      </div>

      {tab === "live" && live.length > 0 && (
        <div className="st-note">Once you start a test the timer keeps running — even if you close the tab. Stay on this page, don't switch tabs, and submit before the time is up.</div>
      )}

      {quizzes.loading ? <Skeleton rows={3} height={92} /> : list.length === 0 ? (
        <Empty
          icon={tab === "live" ? "😌" : tab === "scheduled" ? "🗓" : "📋"}
          title={tab === "live" ? "No live tests right now" : tab === "scheduled" ? "No upcoming tests" : "No completed tests yet"}
          text={tab === "live" ? "When a teacher opens a test for your class it appears here. You can also join with a code using the box above." : undefined}
        />
      ) : (
        <div className="st-stack">
          {list.map((q) => (
            <TestCard key={q.quiz_id} q={q} now={now} onStart={start}
              kind={tab === "live" ? "live" : tab === "scheduled" ? "scheduled" : q.submission ? "done" : "missed"} />
          ))}
        </div>
      )}
    </StudentShell>
  );
}