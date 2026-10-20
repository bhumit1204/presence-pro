// screens/quiz/teacher/ViewQuiz.tsx — picks the right view (scheduled / live / completed) for a quiz
// Fixes: the first load ran twice (mount + focus), a live quiz that ended stayed on the live view until you left,
// and a failed 15-second background refresh popped an error alert every time.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { apiFetch } from "../../../services/api";
import { getUserSession } from "../../../services/session";
import { Button, EmptyState, Header, ResultView, Screen, SP } from "../../../components/ui";
import { API_URL, Quiz, QuizQuestion, QuizStatus, Submission, getStatus, readJson } from "./components/quizViewConstants";
import QuizLiveView from "./components/QuizLiveView";
import QuizCompletedView from "./components/QuizCompletedView";
import QuizScheduledView from "./components/QuizScheduledView";

export default function ViewQuiz() {
  const navigation = useNavigation<any>();
  const { quiz_id } = (useRoute<any>().params || {}) as { quiz_id: string };

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [, setTick] = useState(0); // bumps once when the quiz starts / ends so the view flips on time
  const loadedOnce = useRef(false);
  const lastStatus = useRef<QuizStatus | null>(null);

  const loadData = useCallback(
    async (silent = false) => {
      try {
        if (!silent) setLoading(true);
        const session = await getUserSession();
        const teacher_id = session?.teacher_id;

        const quizRes = await apiFetch(`${API_URL}/api/quizzes/${encodeURIComponent(quiz_id)}?teacher_id=${encodeURIComponent(teacher_id ?? "")}`);
        const quizData = await readJson(quizRes);
        if (!quizData?.success) {
          if (!silent) {
            setFailed(true);
            Alert.alert("Error", quizData?.error ?? "Could not load quiz");
          }
          return;
        }

        const fetched: Quiz = quizData.quiz;
        setQuiz(fetched);
        setQuestions(quizData.questions ?? []);
        setFailed(false);

        const status = getStatus(fetched);
        if (status === "live" || status === "completed") {
          const subRes = await apiFetch(`${API_URL}/api/quizzes/${encodeURIComponent(quiz_id)}/results?teacher_id=${encodeURIComponent(teacher_id ?? "")}`);
          const subData = await readJson(subRes);
          if (subData?.success) {
            setSubmissions([...(subData.submissions ?? [])].sort((a: Submission, b: Submission) => (b.marks_obtained ?? 0) - (a.marks_obtained ?? 0)));
          }
        }
      } catch {
        if (!silent) setFailed(true); // background refreshes fail quietly
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [quiz_id]
  );

  // once on mount, again (quietly) every time the screen regains focus
  useFocusEffect(
    useCallback(() => {
      loadData(loadedOnce.current);
      loadedOnce.current = true;
    }, [loadData])
  );

  const status = quiz ? getStatus(quiz) : null;

  // One timer set for the next moment the state changes (start or end), instead of re-rendering every
  // second: a per-second re-render wasted work.
  useEffect(() => {
    if (!quiz) return;
    const now = Date.now();
    const s = new Date(quiz.scheduled_start).getTime();
    const e = new Date(quiz.scheduled_end).getTime();
    const next = now < s ? s : now <= e ? e : null;
    if (next === null || Number.isNaN(next)) return;
    const id = setTimeout(() => setTick((t) => t + 1), Math.min(Math.max(next - now + 300, 300), 2_000_000_000));
    return () => clearTimeout(id);
  }, [quiz, status]);

  // scheduled -> live -> completed: reload so the new view has its data
  useEffect(() => {
    if (!status) return;
    if (lastStatus.current && lastStatus.current !== status) loadData(true);
    lastStatus.current = status;
  }, [status, loadData]);

  // auto-refresh submissions while live
  useEffect(() => {
    if (status !== "live") return;
    const id = setInterval(() => loadData(true), 15000);
    return () => clearInterval(id);
  }, [status, loadData]);

  if (loading) {
    return (
      <Screen>
        <Header title="Quiz" onBack={() => navigation.goBack()} />
        <ResultView icon="document-text-outline" tone="primary" title="Loading quiz" loading />
      </Screen>
    );
  }

  if (!quiz) {
    return (
      <Screen>
        <Header title="Quiz" onBack={() => navigation.goBack()} />
        <EmptyState
          icon={failed ? "cloud-offline-outline" : "alert-circle-outline"}
          title={failed ? "Could not load the quiz" : "Quiz not found"}
          text={failed ? "Check your connection and try again." : "It may have been cancelled."}
        />
        <View style={{ paddingHorizontal: SP.xl, gap: SP.sm }}>
          {failed && <Button label="Try again" icon="refresh" onPress={() => loadData()} />}
          <Button label="Go back" variant="secondary" onPress={() => navigation.goBack()} />
        </View>
      </Screen>
    );
  }

  if (status === "live") {
    return (
      <QuizLiveView
        quiz={quiz}
        submissions={submissions}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          loadData(true);
        }}
        onBack={() => navigation.goBack()}
      />
    );
  }

  if (status === "completed") {
    return <QuizCompletedView quiz={quiz} submissions={submissions} onBack={() => navigation.goBack()} />;
  }

  return (
    <QuizScheduledView
      quiz={quiz}
      questions={questions}
      onBack={() => navigation.goBack()}
      onRefresh={() => loadData(true)}
    />
  );
}