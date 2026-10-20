// screens/quiz/student/StudentScheduledQuiz.tsx — countdown for a quiz that has not started yet
import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Banner, Card, EmptyState, Header, Screen, SP, T, font } from "../../../components/ui";
import { StudentQuiz, fmtDate } from "./components/studentQuizConstants";

const pad = (n: number) => String(n).padStart(2, "0");

export default function StudentScheduledQuiz() {
  const navigation = useNavigation<any>();
  const quiz = (useRoute<any>().params?.quiz || null) as StudentQuiz | null;

  const [left, setLeft] = useState<number>(() => (quiz ? new Date(quiz.scheduled_start).getTime() - Date.now() : 0));

  useEffect(() => {
    if (!quiz) return;
    const tick = () => setLeft(new Date(quiz.scheduled_start).getTime() - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [quiz?.scheduled_start]);

  if (!quiz) {
    return (
      <Screen>
        <Header title="Scheduled quiz" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Quiz not found" text="Go back and open the quiz again." />
      </Screen>
    );
  }

  const started = left <= 0;
  const h = Math.max(0, Math.floor(left / 3600000));
  const m = Math.max(0, Math.floor((left % 3600000) / 60000));
  const s = Math.max(0, Math.floor((left % 60000) / 1000));

  const rows = [
    { label: "Subject", value: quiz.subject_name },
    { label: "Questions", value: `${quiz.question_count} questions` },
    { label: "Total marks", value: `${quiz.total_marks} marks` },
    { label: "Duration", value: `${quiz.time_limit_minutes} minutes` },
    { label: "Type", value: String(quiz.question_type || "").replace(/_/g, " ").toUpperCase() },
    { label: "Starts", value: fmtDate(quiz.scheduled_start) },
    { label: "Ends", value: fmtDate(quiz.scheduled_end) },
  ];

  return (
    <Screen>
      <Header title={quiz.title} subtitle={quiz.subject_name} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={st.scroll} showsVerticalScrollIndicator={false}>
        {!!quiz.description && <Text style={font.body}>{quiz.description}</Text>}

        <View style={st.countdown}>
          <Text style={st.cdLabel}>{started ? "Starting now" : "Starts in"}</Text>
          {!started && (
            <Text style={st.cdTime}>
              {pad(h)}:{pad(m)}:{pad(s)}
            </Text>
          )}
          <Text style={st.cdSub}>
            {started ? "Go back to your quiz list and tap the quiz to join." : "You can join as soon as the quiz goes live."}
          </Text>
        </View>

        {started && (
          <Banner tone="success" icon="play-circle">
            The quiz should be live. Pull down to refresh your quiz list if it still shows as scheduled.
          </Banner>
        )}

        <Card padded={false}>
          {rows.map((r, i) => (
            <View key={r.label} style={[st.row, i < rows.length - 1 && st.rowBorder]}>
              <Text style={st.label}>{r.label}</Text>
              <Text style={st.value}>{r.value}</Text>
            </View>
          ))}
        </Card>
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, gap: SP.lg, paddingBottom: 40 },
  countdown: { backgroundColor: T.warningSoft, borderRadius: 24, padding: SP.xl, alignItems: "center", borderWidth: 1, borderColor: "#F3DDA0" },
  cdLabel: { fontSize: 13, fontWeight: "700", color: T.warning, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.8 },
  cdTime: { fontSize: 40, fontWeight: "900", color: "#7A4A00", fontVariant: ["tabular-nums"], marginBottom: 6 },
  cdSub: { fontSize: 12.5, color: "#8A5A00", textAlign: "center" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 13, paddingHorizontal: SP.lg, gap: SP.md },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  label: { fontSize: 13, color: T.sub, fontWeight: "600" },
  value: { fontSize: 13, color: T.ink, fontWeight: "700", flex: 1, textAlign: "right" },
});