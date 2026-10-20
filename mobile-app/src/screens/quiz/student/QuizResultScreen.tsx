// screens/quiz/student/QuizResultScreen.tsx — shown right after a quiz is submitted
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Button, Chip, IconBadge, Screen, SP, T, TONE, Tone, font } from "../../../components/ui";
import type { GradedAnswer } from "./components/studentQuizConstants";

export default function QuizResultScreen() {
  const navigation = useNavigation<any>();
  const params = (useRoute<any>().params || {}) as {
    result?: { total_marks?: number; marks_obtained?: number; percentage?: number; graded_answers?: GradedAnswer[] };
    quiz_title?: string;
  };
  const result = params.result || {};

  const pct = Math.max(0, Math.min(100, Number(result.percentage) || 0));
  const obtained = Number(result.marks_obtained) || 0;
  const total = Number(result.total_marks) || 0;
  const tone: Tone = pct >= 75 ? "success" : pct >= 50 ? "warning" : "danger";
  const message = pct >= 75 ? "Great work" : pct >= 50 ? "Good effort" : "Keep practising";
  const c = TONE[tone];

  const graded = Array.isArray(result.graded_answers) ? result.graded_answers : [];
  const correct = graded.filter((a) => a.is_correct).length;
  const wrong = graded.length - correct;

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={st.wrap}>
        <IconBadge icon="checkmark-circle" tone="success" size={92} />
        <Text style={[font.h1, { marginTop: SP.xl }]}>Quiz submitted</Text>
        {!!params.quiz_title && (
          <Text style={[font.body, { textAlign: "center", marginTop: 4 }]} numberOfLines={2}>
            {params.quiz_title}
          </Text>
        )}

        <View style={[st.card, { borderColor: c.fg }]}>
          <Text style={[st.pct, { color: c.fg }]}>{pct.toFixed(1)}%</Text>
          <Text style={st.marks}>
            {obtained.toFixed(1)} / {total} marks
          </Text>
          <View style={[st.msg, { backgroundColor: c.bg }]}>
            <Ionicons name={pct >= 50 ? "trophy" : "fitness"} size={15} color={c.fg} />
            <Text style={[st.msgText, { color: c.fg }]}>{message}</Text>
          </View>
          {graded.length > 0 && (
            <View style={st.chips}>
              <Chip label={`${correct} correct`} tone="success" icon="checkmark" />
              <Chip label={`${wrong} incorrect`} tone="danger" icon="close" />
            </View>
          )}
        </View>

        <Button
          label="Back to dashboard"
          icon="home-outline"
          onPress={() => navigation.navigate("StudentDashboard")}
          style={{ alignSelf: "stretch", marginTop: SP.xl }}
        />
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: SP.xl },
  card: {
    alignSelf: "stretch",
    backgroundColor: T.surface,
    borderRadius: 24,
    borderWidth: 2,
    padding: SP.xl,
    alignItems: "center",
    gap: 6,
    marginTop: SP.xl,
  },
  pct: { fontSize: 52, fontWeight: "900", lineHeight: 60 },
  marks: { fontSize: 17, fontWeight: "700", color: T.sub },
  msg: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, marginTop: 6 },
  msgText: { fontSize: 13.5, fontWeight: "700" },
  chips: { flexDirection: "row", gap: SP.sm, marginTop: SP.md },
});