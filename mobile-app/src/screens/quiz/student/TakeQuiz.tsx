// screens/quiz/student/TakeQuiz.tsx — the quiz itself
// Fixes over the old version:
//   - the timer-expiry auto-submit used the answers from the FIRST render (an empty quiz); everything now reads refs
//   - the clock runs from a fixed deadline, so it stays right when the app is backgrounded or the phone is busy
//   - one submit at a time (ref lock); a failed submit can be retried, including after time is up
//   - hardware / gesture back is blocked until the quiz is submitted
//   - empty quiz, missing params and option objects without text no longer crash

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, AppStateStatus, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as ScreenCapture from "expo-screen-capture";
import { apiFetch } from "../../../services/api";
import { Banner, Button, EmptyState, ProgressBar, Screen, SP, T, TONE, font } from "../../../components/ui";
import { API_URL, QuizQuestion, msToCountdown, optionImage, optionText, readJson } from "./components/studentQuizConstants";

const LABELS = ["A", "B", "C", "D", "E", "F"];

export default function TakeQuiz() {
  const navigation = useNavigation<any>();
  const params = (useRoute<any>().params || {}) as {
    quiz?: { quiz_id: string; title: string; time_limit_minutes: number; total_marks: number };
    questions?: QuizQuestion[];
    student_uid?: string;
  };
  const quiz = params.quiz;
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const student_uid = params.student_uid;

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [timeLeft, setTimeLeft] = useState((quiz?.time_limit_minutes ?? 0) * 60_000);
  const [timeUp, setTimeUp] = useState(false);

  // Everything async code needs lives in refs so no callback ever sees stale state.
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const submittingRef = useRef(false);
  const finishedRef = useRef(false);
  const deadline = useRef(Date.now() + (quiz?.time_limit_minutes ?? 0) * 60_000);
  const warned = useRef(false);
  const appState = useRef(AppState.currentState);

  const total = questions.length;
  const q = questions[Math.min(index, Math.max(0, total - 1))];

  /* ── submit ─────────────────────────────────────────────────────────────── */
  const doSubmit = useCallback(async () => {
    if (submittingRef.current || finishedRef.current || !quiz) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const payload = questions.map((qq) => ({ question_id: qq.question_id, answer: answersRef.current[qq.question_id] || "" }));
      const res = await apiFetch(`${API_URL}/api/quizzes/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quiz_id: quiz.quiz_id, student_uid, answers: payload }),
      });
      const data = await readJson(res);

      if (!data || (!data.success && data.error !== "Already submitted")) {
        throw new Error(data?.error || "Submission failed.");
      }

      finishedRef.current = true; // lets the back guard step aside
      navigation.replace("QuizResultScreen", {
        result: {
          total_marks: data.total_marks,
          marks_obtained: data.marks_obtained,
          percentage: data.percentage,
          graded_answers: data.graded_answers,
        },
        quiz_title: quiz.title,
      });
    } catch (e: any) {
      submittingRef.current = false;
      setSubmitting(false);
      Alert.alert(
        "Could not submit",
        `${e?.message || "Check your connection."} Your answers are still here, so you can try again.`,
        [{ text: "Try again", onPress: () => doSubmit() }, { text: "Not now", style: "cancel" }]
      );
    }
  }, [quiz, questions, student_uid, navigation]);

  const submitRef = useRef(doSubmit);
  submitRef.current = doSubmit;

  const askSubmit = () => {
    const unanswered = questions.filter((qq) => !answersRef.current[qq.question_id]?.trim()).length;
    Alert.alert(
      "Submit quiz",
      unanswered > 0 ? `You have ${unanswered} unanswered question${unanswered > 1 ? "s" : ""}. Submit anyway?` : "Are you sure you want to submit?",
      [{ text: "Cancel", style: "cancel" }, { text: "Submit", style: "destructive", onPress: () => submitRef.current() }]
    );
  };

  /* ── screenshots off ────────────────────────────────────────────────────── */
  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    return () => {
      ScreenCapture.allowScreenCaptureAsync().catch(() => {});
    };
  }, []);

  /* ── leaving the app: warn once, then submit ────────────────────────────── */
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (appState.current === "active" && next !== "active" && !finishedRef.current) {
        if (!warned.current) {
          warned.current = true;
          Alert.alert("Stay in the quiz", "Leaving the app again will submit your answers automatically.", [{ text: "Stay in quiz" }]);
        } else {
          submitRef.current();
        }
      }
      appState.current = next;
    });
    return () => sub.remove();
  }, []);

  /* ── clock: fixed deadline, not a decrementing counter ──────────────────── */
  useEffect(() => {
    if (!quiz) return;
    const id = setInterval(() => {
      const left = Math.max(0, deadline.current - Date.now());
      setTimeLeft(left);
      if (left <= 0) {
        clearInterval(id);
        setTimeUp(true);
        submitRef.current(); // reads answersRef, so it sends what the student typed
      }
    }, 500);
    return () => clearInterval(id);
  }, [quiz]);

  /* ── back is not an exit: it would orphan an unsubmitted attempt ────────── */
  useEffect(() => {
    const unsub = navigation.addListener("beforeRemove", (e: any) => {
      if (finishedRef.current) return;
      e.preventDefault();
      Alert.alert("Leave the quiz?", "The quiz is still running. Submit it to finish.", [
        { text: "Keep going", style: "cancel" },
        { text: "Submit and leave", style: "destructive", onPress: () => submitRef.current() },
      ]);
    });
    return unsub;
  }, [navigation]);

  /* ── guards ─────────────────────────────────────────────────────────────── */
  if (!quiz || total === 0 || !q) {
    return (
      <Screen>
        <EmptyState icon="alert-circle-outline" title="Quiz unavailable" text="This quiz has no questions or could not be loaded." />
        <View style={{ paddingHorizontal: SP.xl }}>
          <Button
            label="Go back"
            onPress={() => {
              finishedRef.current = true;
              navigation.goBack();
            }}
          />
        </View>
      </Screen>
    );
  }

  const setAnswer = (qid: string, val: string) => setAnswers((p) => ({ ...p, [qid]: val }));
  const answeredCount = questions.filter((qq) => !!answers[qq.question_id]?.trim()).length;
  const low = timeLeft < 60_000;
  const mid = timeLeft < 180_000;
  const timerTone = low ? TONE.danger : mid ? TONE.warning : TONE.primary;
  const isLast = index === total - 1;

  return (
    <Screen edges={["top", "bottom"]}>
      {/* top bar */}
      <View style={st.top}>
        <View>
          <Text style={st.qCounter}>
            Question {index + 1} of {total}
          </Text>
          <Text style={st.answered}>{answeredCount} answered</Text>
        </View>
        <View style={[st.timer, { backgroundColor: timerTone.bg }]}>
          <Ionicons name="timer-outline" size={17} color={timerTone.fg} />
          <Text style={[st.timerTxt, { color: timerTone.fg }]}>{msToCountdown(timeLeft)}</Text>
        </View>
      </View>
      <View style={{ paddingHorizontal: SP.xl, marginBottom: SP.md }}>
        <ProgressBar value={(index + 1) / total} />
      </View>

      <ScrollView contentContainerStyle={st.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {low && !timeUp && (
          <Banner tone="danger" icon="time">
            Less than a minute left. Your answers are submitted automatically when time ends.
          </Banner>
        )}
        {timeUp && (
          <Banner tone="danger" icon="time" title="Time is up">
            {submitting ? "Submitting your answers..." : "Submitting did not finish. Tap Submit to try again."}
          </Banner>
        )}

        <View style={st.qCard}>
          <View style={st.qMeta}>
            <View style={[st.typeBadge, q.type === "open_ended" && { backgroundColor: T.warningSoft }]}>
              <Text style={[st.typeTxt, q.type === "open_ended" && { color: T.warning }]}>{q.type === "mcq" ? "Multiple choice" : "Written answer"}</Text>
            </View>
            <Text style={st.marks}>
              {q.marks} mark{q.marks === 1 ? "" : "s"}
            </Text>
          </View>

          <Text style={st.qText}>{q.question}</Text>
          {!!q.image_url && <Image source={{ uri: q.image_url }} style={st.qImage} resizeMode="contain" />}

          {q.type === "mcq" && Array.isArray(q.options) && (
            <View style={{ gap: 10 }}>
              {(q.options as any[]).map((opt, i) => {
                const text = optionText(opt);
                const img = optionImage(opt);
                const selected = !!text && answers[q.question_id] === text;
                return (
                  <Pressable
                    key={i}
                    onPress={() => !timeUp && setAnswer(q.question_id, text)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    style={({ pressed }) => [st.opt, selected && st.optOn, pressed && { opacity: 0.85 }]}
                  >
                    <View style={[st.optLabel, selected && { backgroundColor: T.primary }]}>
                      <Text style={[st.optLabelTxt, selected && { color: "#fff" }]}>{LABELS[i] ?? i + 1}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      {!!text && <Text style={[st.optText, selected && { color: T.primary, fontWeight: "700" }]}>{text}</Text>}
                      {!!img && <Image source={{ uri: img }} style={st.optImage} resizeMode="contain" />}
                    </View>
                    {selected && <Ionicons name="checkmark-circle" size={20} color={T.primary} />}
                  </Pressable>
                );
              })}
            </View>
          )}

          {q.type === "open_ended" && (
            <TextInput
              style={st.open}
              multiline
              placeholder="Type your answer here"
              placeholderTextColor={T.muted}
              value={answers[q.question_id] || ""}
              onChangeText={(t) => setAnswer(q.question_id, t)}
              textAlignVertical="top"
              editable={!timeUp}
            />
          )}
        </View>

        {/* question picker */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={st.dots}>
            {questions.map((qq, i) => {
              const done = !!answers[qq.question_id]?.trim();
              const cur = i === index;
              return (
                <Pressable
                  key={qq.question_id ?? i}
                  onPress={() => setIndex(i)}
                  accessibilityLabel={`Go to question ${i + 1}${done ? ", answered" : ""}`}
                  style={[st.dot, done && st.dotDone, cur && st.dotCur]}
                >
                  <Text style={[st.dotTxt, cur && { color: "#fff" }, done && !cur && { color: T.success }]}>{i + 1}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </ScrollView>

      {/* footer */}
      <View style={st.nav}>
        <Button label="Previous" icon="chevron-back" variant="secondary" disabled={index === 0} onPress={() => setIndex((p) => Math.max(0, p - 1))} style={{ flex: 1 }} />
        {!isLast ? (
          <Button label="Next" icon="chevron-forward" onPress={() => setIndex((p) => Math.min(total - 1, p + 1))} style={{ flex: 1.4 }} />
        ) : (
          <Button label="Submit quiz" icon="checkmark-circle-outline" variant="success" loading={submitting} onPress={timeUp ? () => submitRef.current() : askSubmit} style={{ flex: 1.4 }} />
        )}
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: SP.xl, paddingVertical: SP.md },
  qCounter: { fontSize: 17, fontWeight: "800", color: T.ink },
  answered: { fontSize: 12, color: T.sub, fontWeight: "600", marginTop: 1 },
  timer: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 },
  timerTxt: { fontSize: 16, fontWeight: "800", fontVariant: ["tabular-nums"] },

  scroll: { paddingHorizontal: SP.xl, paddingBottom: SP.lg, gap: SP.lg },
  qCard: { backgroundColor: T.surface, borderRadius: 22, padding: SP.xl, borderWidth: 1, borderColor: T.line },
  qMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: SP.md },
  typeBadge: { backgroundColor: T.primarySoft, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4 },
  typeTxt: { color: T.primary, fontWeight: "700", fontSize: 12 },
  marks: { fontSize: 13, fontWeight: "700", color: T.sub },
  qText: { fontSize: 16.5, fontWeight: "600", color: T.ink, lineHeight: 25, marginBottom: SP.lg },
  qImage: { width: "100%", height: 200, borderRadius: 12, marginBottom: SP.lg, backgroundColor: T.bg },

  opt: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: T.bg, borderRadius: 14, padding: 14, borderWidth: 1.5, borderColor: T.line },
  optOn: { backgroundColor: T.primarySoft, borderColor: T.primary },
  optLabel: { width: 28, height: 28, borderRadius: 8, backgroundColor: T.line, alignItems: "center", justifyContent: "center" },
  optLabelTxt: { fontSize: 13, fontWeight: "700", color: T.sub },
  optText: { fontSize: 15, color: T.ink, lineHeight: 21 },
  optImage: { width: "100%", height: 120, borderRadius: 10, marginTop: 8, backgroundColor: T.bg },

  open: { backgroundColor: T.bg, borderWidth: 1.5, borderColor: T.line, borderRadius: 14, padding: 14, minHeight: 150, fontSize: 15, color: T.ink },

  dots: { flexDirection: "row", gap: 8, paddingVertical: 4 },
  dot: { width: 36, height: 36, borderRadius: 10, backgroundColor: T.line, alignItems: "center", justifyContent: "center" },
  dotDone: { backgroundColor: T.successSoft, borderWidth: 1.5, borderColor: T.success },
  dotCur: { backgroundColor: T.primary, borderWidth: 0 },
  dotTxt: { fontSize: 13, fontWeight: "700", color: T.sub },

  nav: { flexDirection: "row", gap: SP.md, paddingHorizontal: SP.xl, paddingVertical: SP.md, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.surface },
});