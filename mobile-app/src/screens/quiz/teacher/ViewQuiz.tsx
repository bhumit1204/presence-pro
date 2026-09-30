import React, { useState, useEffect, useCallback } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation, useFocusEffect } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";

import {
  PRIMARY, BG, RED, GREY,
  Quiz, QuizQuestion, Submission, QuizStatus,
  API_URL, getStatus, msToCountdown,
} from "./components/quizViewConstants";

import QuizLiveView      from "./components/QuizLiveView";
import QuizCompletedView from "./components/QuizCompletedView";
import QuizScheduledView from "./components/QuizScheduledView";

export default function ViewQuiz() {
  const navigation        = useNavigation<any>();
  const route             = useRoute<any>();
  const { quiz_id }       = route.params;

  const [quiz,        setQuiz]        = useState<Quiz | null>(null);
  const [questions,   setQuestions]   = useState<QuizQuestion[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [countdown,   setCountdown]   = useState("");

  // ── Fetch everything ───────────────────────────────────────────────
  const loadData = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);

      const session = await getUserSession();
      const teacher_id = session?.teacher_id;

      // 1. Fetch quiz + questions
      const quizRes  = await fetch(`${API_URL}/api/quizzes/${quiz_id}?teacher_id=${teacher_id}`);
      const quizData = await quizRes.json();
      if (!quizData.success) { Alert.alert("Error", quizData.error ?? "Could not load quiz"); return; }

      const fetchedQuiz: Quiz = quizData.quiz;
      setQuiz(fetchedQuiz);
      setQuestions(quizData.questions ?? []);

      // 2. Fetch submissions (for live + completed)
      const status: QuizStatus = getStatus(fetchedQuiz);
      if (status === "live" || status === "completed") {
        const subRes  = await fetch(`${API_URL}/api/quizzes/${quiz_id}/results?teacher_id=${teacher_id}`);
        const subData = await subRes.json();
        if (subData.success) {
          const sorted = [...(subData.submissions ?? [])].sort(
            (a, b) => (b.marks_obtained ?? 0) - (a.marks_obtained ?? 0)
          );
          setSubmissions(sorted);
        }
      }
    } catch (e) {
      Alert.alert("Error", "Failed to load quiz. Check your connection.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [quiz_id]);

  // Load on mount + every time screen is focused
  useEffect(() => { loadData(); }, []);
  useFocusEffect(useCallback(() => { loadData(true); }, [loadData]));

  // Auto-refresh every 15s when live
  useEffect(() => {
    if (!quiz || getStatus(quiz) !== "live") return;
    const interval = setInterval(() => loadData(true), 15000);
    return () => clearInterval(interval);
  }, [quiz, loadData]);

  // Countdown ticker for scheduled
  useEffect(() => {
    if (!quiz || getStatus(quiz) !== "scheduled") return;
    const tick = () => {
      const ms = new Date(quiz.scheduled_start).getTime() - Date.now();
      setCountdown(msToCountdown(ms));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [quiz]);

  // ── Loading ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
          <Text style={S.loadingTxt}>Loading quiz...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!quiz) {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}>
          <Text style={S.errorTxt}>Quiz not found.</Text>
          <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginTop: 16 }}>
            <Text style={S.backLink}>← Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const status = getStatus(quiz);

  // ── Route to the correct view ──────────────────────────────────────
  if (status === "live") {
    return (
      <QuizLiveView
        quiz={quiz}
        submissions={submissions}
        refreshing={refreshing}
        onRefresh={() => { setRefreshing(true); loadData(true); }}
        onBack={() => navigation.goBack()}
      />
    );
  }

  if (status === "completed") {
    return (
      <QuizCompletedView
        quiz={quiz}
        submissions={submissions}
        onBack={() => navigation.goBack()}
      />
    );
  }

  // status === "scheduled"
  return (
    <QuizScheduledView
      quiz={quiz}
      questions={questions}
      countdown={countdown}
      onBack={() => navigation.goBack()}
      onRefresh={() => loadData(true)}
    />
  );
}

const S = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: BG },
  center:     { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingTxt: { fontSize: 14, color: GREY, fontWeight: "600" },
  errorTxt:   { fontSize: 15, color: RED, fontWeight: "700" },
  backLink:   { fontSize: 15, color: PRIMARY, fontWeight: "700" },
});