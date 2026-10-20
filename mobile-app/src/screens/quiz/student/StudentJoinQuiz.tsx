// screens/quiz/student/StudentJoinQuiz.tsx — enter the join code (or start an open quiz)
import React, { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { apiFetch } from "../../../services/api";
import { auth } from "../../../services/firebase";
import { Banner, Button, Card, Chip, EmptyState, Header, LiveBadge, Screen, SP, T, font } from "../../../components/ui";
import { API_URL, StudentQuiz, isJoinCodeExpired, readJson } from "./components/studentQuizConstants";

const RULES = [
  "Do not switch apps. A second time out of the quiz submits it automatically.",
  "Screenshots are disabled while the quiz is open.",
  "You cannot retake the quiz once it is submitted.",
];

export default function StudentJoinQuiz() {
  const navigation = useNavigation<any>();
  const quiz = (useRoute<any>().params?.quiz || null) as StudentQuiz | null;

  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  if (!quiz) {
    return (
      <Screen>
        <Header title="Join quiz" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Quiz not found" text="Go back and open the quiz again." />
      </Screen>
    );
  }

  const isOpenQuiz = !quiz.join_code;
  const expired = isJoinCodeExpired(quiz);

  const proceed = async (resolvedCode?: string) => {
    if (lock.current) return;
    lock.current = true;
    setLoading(true);
    setError(null);
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) {
        setError("You are not logged in. Please log in again.");
        return;
      }

      const url = isOpenQuiz
        ? `${API_URL}/api/quizzes/join-open/${encodeURIComponent(quiz.quiz_id)}`
        : `${API_URL}/api/quizzes/join/${encodeURIComponent(resolvedCode || "")}`;
      const res = await apiFetch(url);
      const data = await readJson(res);

      if (!data?.success) {
        setError(
          data?.error === "join_code_expired"
            ? "The join code has expired. Ask your teacher for a new one."
            : data?.error || "Invalid or expired join code."
        );
        return;
      }

      navigation.replace("TakeQuiz", { quiz: data.quiz, questions: data.questions, student_uid: uid });
    } catch {
      setError("Could not connect to the server. Check your connection and try again.");
    } finally {
      lock.current = false;
      setLoading(false);
    }
  };

  const joinWithCode = () => {
    if (code.length !== 6) {
      setError("Enter the 6-character join code.");
      return;
    }
    proceed(code);
  };

  return (
    <Screen>
      <Header title="Join quiz" subtitle={quiz.subject_name} onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={{ alignSelf: "flex-start" }}>
            <LiveBadge label="LIVE NOW" />
          </View>
          <Text style={[font.h1, { marginTop: SP.sm }]}>{quiz.title}</Text>

          <View style={st.chips}>
            <Chip icon="help-circle-outline" label={`${quiz.question_count} questions`} tone="primary" />
            <Chip icon="trophy-outline" label={`${quiz.total_marks} marks`} tone="primary" />
            <Chip icon="timer-outline" label={`${quiz.time_limit_minutes} min`} tone="primary" />
          </View>

          {!!error && <Banner tone="danger">{error}</Banner>}

          {isOpenQuiz ? (
            <Card>
              <View style={st.openRow}>
                <Ionicons name="lock-open-outline" size={26} color={T.success} />
                <View style={{ flex: 1 }}>
                  <Text style={font.h3}>Open quiz</Text>
                  <Text style={[font.body, { marginTop: 2 }]}>No join code needed. Tap below to start straight away.</Text>
                </View>
              </View>
              <Button label="Start quiz" icon="play" variant="success" onPress={() => proceed()} loading={loading} style={{ marginTop: SP.lg }} />
            </Card>
          ) : (
            <Card>
              <Text style={font.h2}>Enter join code</Text>
              <Text style={[font.body, { marginTop: 4, marginBottom: SP.lg }]}>Type the 6-character code your teacher is showing.</Text>

              <TextInput
                style={[st.codeInput, !!error && { borderColor: T.danger }]}
                value={code}
                onChangeText={(t) => {
                  setCode(t.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6));
                  if (error) setError(null);
                }}
                placeholder="ABC123"
                placeholderTextColor={T.muted}
                maxLength={6}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                autoFocus
                textAlign="center"
                returnKeyType="go"
                onSubmitEditing={joinWithCode}
                editable={!expired}
                accessibilityLabel="Join code"
              />

              {expired ? (
                <Banner tone="danger" icon="time" style={{ marginTop: SP.md }}>
                  This join code has expired. Ask your teacher for a new one.
                </Banner>
              ) : (
                !!quiz.join_code_expiry_at && (
                  <Banner tone="warning" icon="time-outline" style={{ marginTop: SP.md }}>
                    {`Code expires at ${new Date(quiz.join_code_expiry_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                  </Banner>
                )
              )}

              <Button
                label="Join and start"
                icon="arrow-forward"
                onPress={joinWithCode}
                loading={loading}
                disabled={code.length !== 6 || expired}
                style={{ marginTop: SP.lg }}
              />
            </Card>
          )}

          <Banner tone="warning" icon="warning" title="Before you start">
            <View style={{ gap: 4, marginTop: 4 }}>
              {RULES.map((r) => (
                <View key={r} style={{ flexDirection: "row", gap: 8 }}>
                  <Text style={{ color: T.warning, fontWeight: "800" }}>-</Text>
                  <Text style={[font.body, { flex: 1, fontSize: 13, lineHeight: 19 }]}>{r}</Text>
                </View>
              ))}
            </View>
          </Banner>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, gap: SP.lg, paddingBottom: 40 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SP.sm },
  openRow: { flexDirection: "row", alignItems: "flex-start", gap: SP.md },
  codeInput: {
    height: 64,
    borderWidth: 2,
    borderColor: T.primary,
    borderRadius: 16,
    fontSize: 26,
    fontWeight: "800",
    color: T.primary,
    letterSpacing: 8,
    backgroundColor: T.primarySoft,
  },
});