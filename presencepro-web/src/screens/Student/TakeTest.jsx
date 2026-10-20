// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { studentApi, serverNow, myUid } from "../../services/studentApi";
import { Modal, Spinner, Pill, fmtClock, fmtDateTime, refreshQuizzes } from "./ui";
import "./Student.css";

const BASE = "/dashboard/student";
const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const optText = (o) => (typeof o === "string" ? o : o?.text || "");
const optImg = (o) => (typeof o === "string" ? null : o?.image_url || null);

const storeKey = (quizId) => `pp_exam:${myUid()}:${quizId}`;
const loadState = (quizId) => { try { return JSON.parse(localStorage.getItem(storeKey(quizId)) || "null"); } catch { return null; } };
const saveState = (quizId, s) => { try { localStorage.setItem(storeKey(quizId), JSON.stringify(s)); } catch { /* storage full / blocked */ } };
const clearState = (quizId) => { try { localStorage.removeItem(storeKey(quizId)); } catch { /* ignore */ } };

export default function TakeTest() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const quizParam = params.get("quiz");
  const codeParam = params.get("code");

  const [phase, setPhase] = useState("loading"); // loading | error | intro | running | done
  const [error, setError] = useState("");
  const [quiz, setQuiz] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [flags, setFlags] = useState({});
  const [idx, setIdx] = useState(0);
  const [deadline, setDeadline] = useState(0);
  const [left, setLeft] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [leaves, setLeaves] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [warn, setWarn] = useState(false);
  const [notFs, setNotFs] = useState(false);

  const live = useRef({});
  live.current = { answers, flags, leaves, startedAt, quiz, questions, submitting, phase };
  const lastLeave = useRef(0);
  const retryTimer = useRef(null);

  /* ── 1. join (fetch the questions) ───────────────────────────────── */
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        if (!quizParam && !codeParam) throw new Error("No test selected.");
        const j = await studentApi.joinQuiz({ quiz_id: quizParam, code: codeParam });
        if (dead) return;
        const q = j.quiz;
        const qs = (j.questions || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        if (!qs.length) throw new Error("This test has no questions yet.");

        // already submitted? -> straight to the result
        try {
          const list = await studentApi.quizzes();
          const done = (list.completed || []).find((x) => x.quiz_id === q.quiz_id && x.submission);
          if (done) { nav(`${BASE}/tests/result/${q.quiz_id}`, { replace: true }); return; }
        } catch { /* not fatal */ }

        setQuiz(q);
        setQuestions(qs);

        const saved = loadState(q.quiz_id);
        if (saved && saved.startedAt) {
          // resume an attempt that was already started (refresh / closed tab)
          setAnswers(saved.answers || {});
          setFlags(saved.flags || {});
          setLeaves(saved.leaves || 0);
          setStartedAt(saved.startedAt);
          setDeadline(computeDeadline(q, saved.startedAt));
          setPhase("running");
        } else {
          setPhase("intro");
        }
      } catch (e) {
        if (dead) return;
        setError(e.message || "Could not open this test.");
        setPhase("error");
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line
  }, [quizParam, codeParam]);

  const computeDeadline = (q, started) => {
    const byLimit = started + (q.time_limit_minutes || 0) * 60000;
    const end = q.scheduled_end ? new Date(q.scheduled_end).getTime() - 1500 : Infinity; // server rejects after scheduled_end
    return Math.min(byLimit, end);
  };

  /* ── 2. submit ───────────────────────────────────────────────────── */
  const submit = useCallback(async (auto = false, attempt = 0) => {
    const { quiz: q, questions: qs, answers: ans, submitting: busy } = live.current;
    if (!q || busy) return;
    setSubmitting(true);
    setSubmitError("");
    setConfirm(false); setWarn(false);
    try {
      const payload = qs.map((x) => ({ question_id: x.question_id, answer: ans[x.question_id] || "" }));
      await studentApi.submitQuiz(q.quiz_id, payload);
      finish(q);
    } catch (e) {
      if (e.status === 409) { finish(q); return; }               // already submitted
      if (e.status === 403) {                                     // window closed / not enrolled
        clearState(q.quiz_id);
        setSubmitting(false);
        setSubmitError(e.message);
        setPhase("error"); setError(e.message);
        return;
      }
      setSubmitting(false);
      setSubmitError(e.message || "Could not submit. Check your connection.");
      if (auto && attempt < 8) {                                   // keep trying while time-out / tab-switch submit
        retryTimer.current = setTimeout(() => submit(true, attempt + 1), 4000);
      }
    }
    // eslint-disable-next-line
  }, []);

  function finish(q) {
    clearState(q.quiz_id);
    refreshQuizzes();
    exitFs();
    setPhase("done");
    nav(`${BASE}/tests/result/${q.quiz_id}`, { replace: true });
  }

  /* ── 3. timer ────────────────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== "running") return undefined;
    const tick = () => {
      const l = deadline - serverNow();
      setLeft(l);
      if (l <= 0 && !live.current.submitting) submit(true);
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [phase, deadline, submit]);

  /* ── 4. persist progress ─────────────────────────────────────────── */
  useEffect(() => {
    if (phase === "running" && quiz) saveState(quiz.quiz_id, { startedAt, answers, flags, leaves });
  }, [phase, quiz, startedAt, answers, flags, leaves]);

  /* ── 5. integrity guards while running ───────────────────────────── */
  useEffect(() => {
    if (phase !== "running") return undefined;

    const onLeave = () => {
      const now = Date.now();
      if (now - lastLeave.current < 1200 || live.current.submitting) return;
      lastLeave.current = now;
      const n = live.current.leaves + 1;
      setLeaves(n);
      if (n >= 2) submit(true);          // second time: auto-submit (same rule as the mobile app)
      else setWarn(true);
    };
    const onVis = () => document.visibilityState === "hidden" && onLeave();
    const onBlur = () => onLeave();
    const onBefore = (e) => { e.preventDefault(); e.returnValue = ""; };
    const onFs = () => setNotFs(!document.fullscreenElement && !!document.documentElement.requestFullscreen);

    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    window.addEventListener("beforeunload", onBefore);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("beforeunload", onBefore);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, [phase, submit]);

  useEffect(() => () => { clearTimeout(retryTimer.current); }, []);

  const enterFs = () => { try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* ignore */ } };
  function exitFs() { try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch { /* ignore */ } }

  const begin = () => {
    const started = serverNow();
    setStartedAt(started);
    setDeadline(computeDeadline(quiz, started));
    setIdx(0);
    saveState(quiz.quiz_id, { startedAt: started, answers: {}, flags: {}, leaves: 0 });
    enterFs();
    setPhase("running");
  };

  const q = questions[idx];
  const answered = useMemo(() => questions.filter((x) => (answers[x.question_id] || "").trim()).length, [questions, answers]);
  const setAns = (id, v) => setAnswers((a) => ({ ...a, [id]: v }));

  /* ── render ──────────────────────────────────────────────────────── */
  if (phase === "loading") return <div className="st-exam"><Spinner label="Opening your test…" /></div>;

  if (phase === "error") {
    return (
      <div className="st-exam">
        <div className="st-intro" style={{ textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>🚫</div>
          <h2 style={{ margin: "8px 0" }}>Can't open this test</h2>
          <p style={{ color: "#6B7280" }}>{error}</p>
          <button className="st-btn st-btn--primary" onClick={() => nav(`${BASE}/tests`, { replace: true })}>Back to tests</button>
        </div>
      </div>
    );
  }

  if (phase === "intro") {
    return (
      <div className="st-exam">
        <div className="st-intro">
          <Pill tone="purple">{quiz.subject_name}</Pill>
          <h1 style={{ margin: "12px 0 4px", fontSize: 26 }}>{quiz.title}</h1>
          {quiz.description && <p style={{ color: "#6B7280", marginTop: 0 }}>{quiz.description}</p>}
          <div className="st-grid st-grid--3" style={{ margin: "18px 0" }}>
            <div className="st-card" style={{ textAlign: "center" }}><div className="st-stat-value">{questions.length}</div><div className="st-stat-label">Questions</div></div>
            <div className="st-card" style={{ textAlign: "center" }}><div className="st-stat-value">{quiz.time_limit_minutes}<span style={{ fontSize: 14 }}> min</span></div><div className="st-stat-label">Time limit</div></div>
            <div className="st-card" style={{ textAlign: "center" }}><div className="st-stat-value">{quiz.total_marks}</div><div className="st-stat-label">Total marks</div></div>
          </div>
          <div className="st-h2">Before you begin</div>
          <ul className="st-rules">
            <li>The timer starts the moment you press <b>Start test</b> and does not pause — even if you close this tab.</li>
            <li>The test opens in full screen. <b>Don't switch tabs or windows</b>: the first time you get a warning, the second time your answers are submitted automatically.</li>
            <li>Copying and pasting are disabled. Your answers are saved on this device as you go.</li>
            <li>You can only submit once. The test closes for everyone at {fmtDateTime(quiz.scheduled_end)}.</li>
          </ul>
          <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
            <button className="st-btn st-btn--ghost" onClick={() => nav(`${BASE}/tests`)}>Cancel</button>
            <button className="st-btn st-btn--primary" style={{ flex: 1 }} onClick={begin}>Start test →</button>
          </div>
        </div>
      </div>
    );
  }

  const lowTime = left < 60000;
  const isMcq = q.type === "mcq";

  return (
    <div
      className="st-exam"
      onCopy={(e) => e.target.tagName !== "TEXTAREA" && e.preventDefault()}
      onCut={(e) => e.target.tagName !== "TEXTAREA" && e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="st-exam-bar">
        <div style={{ minWidth: 0 }}>
          <div className="st-exam-title">{quiz.title}</div>
          <div style={{ fontSize: 12, color: "#6B7280" }}>{answered}/{questions.length} answered</div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span className={`st-timer${lowTime ? " st-timer--low" : ""}`} title="Time left">⏱ {fmtClock(left)}</span>
          <button className="st-btn st-btn--primary" disabled={submitting} onClick={() => setConfirm(true)}>{submitting ? "Submitting…" : "Submit"}</button>
        </div>
      </div>

      {notFs && (
        <div className="st-note st-note--warn" style={{ margin: "12px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span>You left full screen. Please return to full screen to continue.</span>
          <button className="st-btn st-btn--sm st-btn--ghost" onClick={enterFs}>Go full screen</button>
        </div>
      )}
      {submitError && (
        <div className="st-error" style={{ margin: "12px 24px 0" }}>
          <span>{submitError}</span>
          <button className="st-btn st-btn--sm st-btn--ghost" onClick={() => submit(false)}>Retry</button>
        </div>
      )}

      <div className="st-exam-main">
        <div>
          <div className="st-q-card">
            <div className="st-q-top">
              <Pill tone="blue">Question {idx + 1} of {questions.length}</Pill>
              <Pill tone={isMcq ? "gray" : "amber"}>{isMcq ? "Multiple choice" : "Written answer"}</Pill>
              <Pill tone="green">{q.marks} mark{q.marks > 1 ? "s" : ""}</Pill>
            </div>
            <div className="st-q-text">{q.question}</div>
            {q.image_url && <img className="st-q-img" src={q.image_url} alt="" draggable={false} />}

            {isMcq ? (
              <div className="st-opts">
                {(q.options || []).map((o, i) => {
                  const t = optText(o);
                  const on = answers[q.question_id] === t;
                  return (
                    <button key={i} className={`st-opt${on ? " st-opt--on" : ""}`} onClick={() => setAns(q.question_id, on ? "" : t)}>
                      <span className="st-opt-letter">{LETTERS[i] || i + 1}</span>
                      <span style={{ flex: 1 }}>
                        {t}
                        {optImg(o) && <img src={optImg(o)} alt="" draggable={false} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <textarea
                className="st-open-input"
                placeholder="Type your answer here…"
                value={answers[q.question_id] || ""}
                onChange={(e) => setAns(q.question_id, e.target.value)}
                onPaste={(e) => e.preventDefault()}
                onDrop={(e) => e.preventDefault()}
                spellCheck
              />
            )}
          </div>

          <div className="st-exam-nav">
            <button className="st-btn st-btn--ghost" disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}>← Previous</button>
            <button className={`st-btn st-btn--ghost`} onClick={() => setFlags((f) => ({ ...f, [q.question_id]: !f[q.question_id] }))}>
              {flags[q.question_id] ? "🚩 Marked for review" : "⚑ Mark for review"}
            </button>
            {idx < questions.length - 1
              ? <button className="st-btn st-btn--primary" onClick={() => setIdx((i) => i + 1)}>Next →</button>
              : <button className="st-btn st-btn--green" onClick={() => setConfirm(true)}>Finish &amp; submit</button>}
          </div>
        </div>

        <aside className="st-palette">
          <div className="st-h2">Questions</div>
          <div className="st-palette-grid">
            {questions.map((x, i) => {
              const done = (answers[x.question_id] || "").trim();
              return (
                <button key={x.question_id} className={`st-pal${flags[x.question_id] ? " st-pal--flag" : done ? " st-pal--done" : ""}${i === idx ? " st-pal--cur" : ""}`} onClick={() => setIdx(i)}>
                  {i + 1}
                </button>
              );
            })}
          </div>
          <div className="st-legend">
            <span style={{ "--c": "#D1FAE5" }}>Answered</span>
            <span style={{ "--c": "#FEF3C7" }}>Review</span>
            <span style={{ "--c": "#fff" }}>Not answered</span>
          </div>
          <button className="st-btn st-btn--primary st-btn--block" disabled={submitting} onClick={() => setConfirm(true)}>Submit test</button>
        </aside>
      </div>

      {confirm && (
        <Modal
          title="Submit your test?"
          onClose={() => setConfirm(false)}
          footer={<>
            <button className="st-btn st-btn--ghost" onClick={() => setConfirm(false)}>Keep working</button>
            <button className="st-btn st-btn--primary" disabled={submitting} onClick={() => submit(false)}>{submitting ? "Submitting…" : "Yes, submit"}</button>
          </>}
        >
          You've answered <b>{answered}</b> of <b>{questions.length}</b> questions.
          {answered < questions.length && <> <b style={{ color: "#B91C1C" }}>{questions.length - answered} unanswered</b> will score zero.</>}
          {" "}You can't change your answers after submitting.
        </Modal>
      )}

      {warn && !submitting && (
        <Modal
          title="⚠️ Don't leave the test"
          onClose={() => setWarn(false)}
          footer={<button className="st-btn st-btn--primary" onClick={() => { setWarn(false); enterFs(); }}>Back to the test</button>}
        >
          You switched away from the test window. If you do it again, your answers will be <b>submitted automatically</b>.
        </Modal>
      )}
    </div>
  );
}
