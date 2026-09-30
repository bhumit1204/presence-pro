import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Alert, ActivityIndicator, TextInput, AppState, AppStateStatus, Image
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation } from "@react-navigation/native";
import * as ScreenCapture from "expo-screen-capture";
import {
  PRIMARY, PRIMARY_LIGHT, BG, GREEN, GREEN_LIGHT, GREY, RED, RED_LIGHT, AMBER,
  API_URL, QuizQuestion, msToCountdown,
} from "./components/studentQuizConstants";

export default function TakeQuiz() {
  const navigation = useNavigation<any>();
  const route      = useRoute<any>();
  const { quiz, questions, student_uid } = route.params as {
    quiz:        { quiz_id: string; title: string; time_limit_minutes: number; total_marks: number };
    questions:   QuizQuestion[];
    student_uid: string;
  };

  const [currentIndex, setCurrentIndex]   = useState(0);
  const [answers,      setAnswers]         = useState<Record<string, string>>({});
  const [submitting,   setSubmitting]      = useState(false);
  const [timeLeft,     setTimeLeft]        = useState(quiz.time_limit_minutes * 60 * 1000);

  // App-state warning state
  const appStateRef      = useRef(AppState.currentState);
  const switchWarningRef = useRef(false);
  const timerRef         = useRef<ReturnType<typeof setInterval> | null>(null);

  const totalQ = questions.length;
  const q      = questions[currentIndex];

  // ── Security: disable screenshots ──────────────────────────────────
  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync();
    return () => { ScreenCapture.allowScreenCaptureAsync(); };
  }, []);

  // ── Security: detect app background / switch ────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (appStateRef.current === "active" && nextState !== "active") {
        if (!switchWarningRef.current) {
          // First offence — warn
          switchWarningRef.current = true;
          Alert.alert(
            "⚠️ Warning",
            "Do not leave the quiz! Switching apps again will auto-submit your answers.",
            [{ text: "Stay in Quiz" }]
          );
        } else {
          // Second offence — auto-submit
          handleSubmit(true);
        }
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, [answers]);

  // ── Timer ────────────────────────────────────────────────────────────
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1000) {
          clearInterval(timerRef.current!);
          handleSubmit(true);
          return 0;
        }
        return prev - 1000;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // ── Answer ────────────────────────────────────────────────────────────
  const setAnswer = (qid: string, val: string) => {
    setAnswers((prev) => ({ ...prev, [qid]: val }));
  };

  // ── Submit ────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (auto = false) => {
    if (submitting) return;

    const proceed = async () => {
      if (timerRef.current) clearInterval(timerRef.current);
      setSubmitting(true);

      try {
        const answersPayload = questions.map((q) => ({
          question_id: q.question_id,
          answer:      answers[q.question_id] || "",
        }));

        const res  = await fetch(`${API_URL}/api/quizzes/submit`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            quiz_id:     quiz.quiz_id,
            student_uid,
            answers:     answersPayload,
          }),
        });

        const data = await res.json();

        if (!data.success && data.error !== "Already submitted") {
          Alert.alert("Error", data.error || "Submission failed.");
          setSubmitting(false);
          return;
        }

        // Navigate to result
        navigation.replace("QuizResultScreen", {
          result: {
            total_marks:    data.total_marks,
            marks_obtained: data.marks_obtained,
            percentage:     data.percentage,
            graded_answers: data.graded_answers,
          },
          quiz_title: quiz.title,
        });

      } catch (e) {
        Alert.alert("Error", "Could not submit. Check your connection.");
        setSubmitting(false);
      }
    };

    if (auto) {
      proceed();
    } else {
      const answered = Object.keys(answers).length;
      const unanswered = totalQ - answered;
      Alert.alert(
        "Submit Quiz",
        unanswered > 0
          ? `You have ${unanswered} unanswered question(s). Submit anyway?`
          : "Are you sure you want to submit?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Submit", style: "destructive", onPress: proceed },
        ]
      );
    }
  }, [submitting, answers, questions, quiz, student_uid]);

  // ── Progress ──────────────────────────────────────────────────────────
  const answered   = Object.keys(answers).filter((k) => answers[k] !== "").length;
  const progress   = ((currentIndex + 1) / totalQ) * 100;
  const timerColor = timeLeft < 60000 ? RED : timeLeft < 180000 ? AMBER : PRIMARY;

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>

      {/* Top bar */}
      <View style={S.topBar}>
        <View style={S.progressInfo}>
          <Text style={S.qCounter}>Q{currentIndex + 1} / {totalQ}</Text>
          <Text style={S.answeredCount}>{answered} answered</Text>
        </View>
        <View style={[S.timerBox, { backgroundColor: timeLeft < 60000 ? RED_LIGHT : PRIMARY_LIGHT }]}>
          <Text style={[S.timerText, { color: timerColor }]}>
            ⏱ {msToCountdown(timeLeft)}
          </Text>
        </View>
      </View>

      {/* Progress bar */}
      <View style={S.progressTrack}>
        <View style={[S.progressFill, { width: `${progress}%` }]} />
      </View>

      {/* Question card */}
      <ScrollView
        contentContainerStyle={S.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={S.qCard}>
          {/* Type + marks */}
          <View style={S.qMeta}>
            <View style={[S.typeBadge, q.type === "open_ended" && S.typeBadgeOpen]}>
              <Text style={[S.typeTxt, q.type === "open_ended" && S.typeTxtOpen]}>
                {q.type === "mcq" ? "MCQ" : "Open Ended"}
              </Text>
            </View>
            <Text style={S.marksTxt}>{q.marks} mark{q.marks > 1 ? "s" : ""}</Text>
          </View>

          <Text style={S.qText}>{q.question}</Text>
          {q.image_url ? (
            <Image
              source={{ uri: q.image_url }}
              style={S.qImage}
              resizeMode="contain"
            />
          ) : null}

          {/* MCQ options */}
          {q.type === "mcq" && q.options && (
            <View style={S.optionsWrap}>
              {q.options.map((opt, i) => {
                // Support both plain string options and { text, image_url } objects
                const optText  = typeof opt === "string" ? opt : opt.text;
                const optImage = typeof opt === "string" ? null : opt.image_url;
                const selected = answers[q.question_id] === optText;
                const LABELS   = ["A", "B", "C", "D", "E", "F"];
                return (
                  <TouchableOpacity
                    key={i}
                    style={[S.optBtn, selected && S.optBtnSelected]}
                    onPress={() => setAnswer(q.question_id, optText)}
                    activeOpacity={0.8}
                  >
                    <View style={[S.optLabel, selected && S.optLabelSelected]}>
                      <Text style={[S.optLabelTxt, selected && S.optLabelTxtSelected]}>
                        {LABELS[i]}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      {optText ? (
                        <Text style={[S.optText, selected && S.optTextSelected]}>{optText}</Text>
                      ) : null}
                      {optImage ? (
                        <Image
                          source={{ uri: optImage }}
                          style={S.optImage}
                          resizeMode="contain"
                        />
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Open-ended text area */}
          {q.type === "open_ended" && (
            <TextInput
              style={S.openInput}
              multiline
              placeholder="Type your answer here..."
              placeholderTextColor="#9CA3AF"
              value={answers[q.question_id] || ""}
              onChangeText={(t) => setAnswer(q.question_id, t)}
              textAlignVertical="top"
            />
          )}
        </View>

        {/* Question dots */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.dotsScroll}>
          <View style={S.dotsRow}>
            {questions.map((qq, i) => {
              const isAnswered = !!answers[qq.question_id];
              const isCurrent  = i === currentIndex;
              return (
                <TouchableOpacity
                  key={i}
                  style={[S.dot, isCurrent && S.dotCurrent, isAnswered && !isCurrent && S.dotAnswered]}
                  onPress={() => setCurrentIndex(i)}
                >
                  <Text style={[S.dotTxt, (isCurrent || isAnswered) && S.dotTxtActive]}>
                    {i + 1}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>

      </ScrollView>

      {/* Navigation buttons */}
      <View style={S.navRow}>
        <TouchableOpacity
          style={[S.navBtn, currentIndex === 0 && S.navBtnDisabled]}
          onPress={() => setCurrentIndex((p) => Math.max(0, p - 1))}
          disabled={currentIndex === 0}
        >
          <Text style={[S.navBtnTxt, currentIndex === 0 && { color: GREY }]}>← Prev</Text>
        </TouchableOpacity>

        {currentIndex < totalQ - 1 ? (
          <TouchableOpacity
            style={S.nextBtn}
            onPress={() => setCurrentIndex((p) => Math.min(totalQ - 1, p + 1))}
          >
            <Text style={S.nextBtnTxt}>Next →</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[S.submitBtn, submitting && { opacity: 0.7 }]}
            onPress={() => handleSubmit(false)}
            disabled={submitting}
          >
            {submitting
              ? <ActivityIndicator color="#FFF" />
              : <Text style={S.submitBtnTxt}>Submit Quiz ✓</Text>
            }
          </TouchableOpacity>
        )}
      </View>

    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20, paddingBottom: 16 },

  // Top bar
  topBar:        { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 },
  progressInfo:  { gap: 2 },
  qCounter:      { fontSize: 18, fontWeight: "800", color: "#111827" },
  answeredCount: { fontSize: 12, color: GREY, fontWeight: "600" },
  timerBox:      { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  timerText:     { fontSize: 16, fontWeight: "800", fontVariant: ["tabular-nums"] },

  // Progress bar
  progressTrack: { height: 4, backgroundColor: "#E5E7EB", marginHorizontal: 20, marginBottom: 16, borderRadius: 2, overflow: "hidden" },
  progressFill:  { height: 4, backgroundColor: PRIMARY, borderRadius: 2 },

  // Question card
  qCard: { backgroundColor: "#FFF", borderRadius: 20, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: "#E5E7EB", shadowColor: PRIMARY, shadowOpacity: 0.06, shadowRadius: 12, elevation: 3 },
  qMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  typeBadge:     { backgroundColor: PRIMARY_LIGHT, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  typeBadgeOpen: { backgroundColor: "#FEF3C7" },
  typeTxt:       { color: PRIMARY, fontWeight: "700", fontSize: 12 },
  typeTxtOpen:   { color: "#92400E" },
  marksTxt:      { fontSize: 13, fontWeight: "700", color: GREY },
  qText: { fontSize: 16, fontWeight: "600", color: "#111827", lineHeight: 24, marginBottom: 20 },

  // MCQ
  optionsWrap: { gap: 10 },
  optBtn: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#F9FAFB", borderRadius: 14, padding: 14, borderWidth: 1.5, borderColor: "#E5E7EB" },
  optBtnSelected: { backgroundColor: PRIMARY_LIGHT, borderColor: PRIMARY },
  optLabel: { width: 28, height: 28, borderRadius: 8, backgroundColor: "#E5E7EB", alignItems: "center", justifyContent: "center" },
  optLabelSelected: { backgroundColor: PRIMARY },
  optLabelTxt: { fontSize: 13, fontWeight: "700", color: GREY },
  optLabelTxtSelected: { color: "#FFF" },
  optText: { fontSize: 15, color: "#374151", flex: 1 },
  optTextSelected: { color: PRIMARY, fontWeight: "700" },

  // Open ended
  openInput: { backgroundColor: "#F9FAFB", borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 14, padding: 14, minHeight: 140, fontSize: 15, color: "#111827" },

  // Question dots
  dotsScroll: { marginBottom: 8 },
  dotsRow:    { flexDirection: "row", gap: 6, paddingHorizontal: 4, paddingVertical: 8 },
  dot:        { width: 32, height: 32, borderRadius: 8, backgroundColor: "#E5E7EB", alignItems: "center", justifyContent: "center" },
  dotCurrent: { backgroundColor: PRIMARY },
  dotAnswered:{ backgroundColor: GREEN_LIGHT, borderWidth: 1.5, borderColor: GREEN },
  dotTxt:     { fontSize: 12, fontWeight: "600", color: GREY },
  dotTxtActive:{ color: "#ffffff" },
  qImage:  { width: "100%", height: 200, borderRadius: 12, marginBottom: 16, backgroundColor: "#F9FAFB" },
optImage:{ width: "100%", height: 120, borderRadius: 10, marginTop: 8, backgroundColor: "#F9FAFB" },

  // Nav buttons
  navRow:    { flexDirection: "row", paddingHorizontal: 20, paddingVertical: 12, gap: 10, borderTopWidth: 1, borderTopColor: "#E5E7EB", backgroundColor: "#FFF", marginBottom: 12 },
  navBtn:    { flex: 1, height: 50, borderRadius: 14, backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center" },
  navBtnDisabled: { opacity: 0.4 },
  navBtnTxt: { fontSize: 15, fontWeight: "700", color: PRIMARY },
  nextBtn:   { flex: 2, height: 50, borderRadius: 14, backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center" },
  nextBtnTxt:{ color: "#FFF", fontWeight: "800", fontSize: 15 },
  submitBtn: { flex: 2, height: 50, borderRadius: 14, backgroundColor: GREEN, alignItems: "center", justifyContent: "center", shadowColor: GREEN, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  submitBtnTxt: { color: "#FFF", fontWeight: "800", fontSize: 15 },
});