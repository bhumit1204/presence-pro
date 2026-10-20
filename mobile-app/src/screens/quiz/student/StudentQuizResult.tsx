// screens/quiz/student/StudentQuizResult.tsx — full review of a past submission
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { apiFetch } from "../../../services/api";
import { auth } from "../../../services/firebase";
import { Button, Card, Chip, EmptyState, Header, Screen, SP, T, TONE, Tone, font } from "../../../components/ui";
import { API_URL, GradedAnswer, readJson } from "./components/studentQuizConstants";
import { QuizPageSkeleton } from "./components/QuizSkeleton";

interface FullResult {
  submission: { total_marks: number; marks_obtained: number; percentage: number; submitted_at: string; answers: GradedAnswer[] };
  quiz: { title: string; subject_name: string };
}

function AnswerCard({ ga, index }: { ga: GradedAnswer; index: number }) {
  const ok = ga.is_correct;
  const c = TONE[ok ? "success" : "danger"];
  return (
    <View style={[st.ans, { borderColor: c.fg }]}>
      <View style={st.ansHead}>
        <View style={[st.badge, { backgroundColor: c.bg }]}>
          <Ionicons name={ok ? "checkmark" : "close"} size={13} color={c.fg} />
          <Text style={[st.badgeTxt, { color: c.fg }]}>Q{index + 1}</Text>
        </View>
        <Text style={[st.score, { color: c.fg }]}>
          {Number(ga.marks_obtained ?? 0).toFixed(1)}/{ga.marks_possible}
        </Text>
      </View>
      <Text style={st.qText}>{ga.question_text}</Text>

      <View style={st.box}>
        <Text style={st.boxLabel}>Your answer</Text>
        <Text style={[st.boxText, !ga.student_answer && { color: T.muted, fontStyle: "italic" }]}>{ga.student_answer || "No answer provided"}</Text>
      </View>

      {!ok && !!ga.correct_answer && (
        <View style={[st.box, { backgroundColor: T.successSoft, borderColor: T.success }]}>
          <Text style={st.boxLabel}>Correct answer</Text>
          <Text style={[st.boxText, { color: "#065F46" }]}>{ga.correct_answer}</Text>
        </View>
      )}

      {!!ga.feedback && (
        <View style={st.feedback}>
          <Ionicons name="chatbubble-ellipses-outline" size={14} color={T.sub} />
          <Text style={st.feedbackTxt}>{ga.feedback}</Text>
        </View>
      )}
    </View>
  );
}

export default function StudentQuizResult() {
  const navigation = useNavigation<any>();
  const { quiz_id, quiz_title } = (useRoute<any>().params || {}) as { quiz_id: string; quiz_title?: string };

  const [data, setData] = useState<FullResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<"ok" | "none" | "error">("ok");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const uid = auth.currentUser?.uid;
      if (!uid || !quiz_id) {
        setState("none");
        return;
      }
      const res = await apiFetch(`${API_URL}/api/quizzes/${encodeURIComponent(quiz_id)}/result?student_uid=${encodeURIComponent(uid)}`);
      const json = await readJson(res);
      if (!json) {
        setState("error");
        return;
      }
      if (!json.success) {
        // a missing submission is a normal answer; anything else is a failure worth retrying
        setState(res.status === 404 || /submission|not found|attended/i.test(String(json.error)) ? "none" : "error");
        return;
      }
      setData(json);
      setState("ok");
    } catch {
      setState("error");
    } finally {
      setLoading(false);
    }
  }, [quiz_id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <Screen>
        <Header title="Result" onBack={() => navigation.goBack()} />
        <QuizPageSkeleton />
      </Screen>
    );
  }

  if (state !== "ok" || !data) {
    return (
      <Screen>
        <Header title={quiz_title || "Result"} onBack={() => navigation.goBack()} />
        {state === "error" ? (
          <>
            <EmptyState icon="cloud-offline-outline" title="Could not load result" text="Check your connection and try again." />
            <View style={{ paddingHorizontal: SP.xl }}>
              <Button label="Try again" icon="refresh" onPress={load} />
            </View>
          </>
        ) : (
          <EmptyState icon="file-tray-outline" title="No submission found" text="You have not attempted this quiz." />
        )}
      </Screen>
    );
  }

  const { submission, quiz } = data;
  const answers = submission.answers || [];
  const correct = answers.filter((a) => a.is_correct).length;
  const incorrect = answers.length - correct;
  const pct = Number(submission.percentage) || 0;
  const tone: Tone = pct >= 75 ? "success" : pct >= 50 ? "warning" : "danger";
  const c = TONE[tone];

  return (
    <Screen>
      <Header title={quiz_title || quiz.title} subtitle={quiz.subject_name} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={st.scroll} showsVerticalScrollIndicator={false}>
        <Card style={{ alignItems: "center", gap: 4, borderLeftWidth: 4, borderLeftColor: c.fg }}>
          <Text style={[st.pct, { color: c.fg }]}>{pct.toFixed(1)}%</Text>
          <Text style={st.marks}>
            {Number(submission.marks_obtained).toFixed(1)} / {submission.total_marks} marks
          </Text>
          <View style={st.chips}>
            <Chip icon="checkmark" tone="success" label={`${correct} correct`} />
            <Chip icon="close" tone="danger" label={`${incorrect} wrong`} />
          </View>
        </Card>

        <Text style={font.h2}>Answer review</Text>
        {answers.map((ga, i) => (
          <AnswerCard key={ga.question_id ?? i} ga={ga} index={i} />
        ))}
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, gap: SP.md, paddingBottom: 40 },
  pct: { fontSize: 46, fontWeight: "900" },
  marks: { fontSize: 16, fontWeight: "600", color: T.sub },
  chips: { flexDirection: "row", gap: SP.sm, marginTop: SP.md },
  ans: { backgroundColor: T.surface, borderRadius: 18, padding: SP.lg, borderWidth: 1.5, gap: SP.sm },
  ansHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  badge: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  badgeTxt: { fontSize: 12, fontWeight: "800" },
  score: { fontSize: 14, fontWeight: "800" },
  qText: { fontSize: 15, fontWeight: "600", color: T.ink, lineHeight: 22 },
  box: { backgroundColor: T.bg, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: T.line },
  boxLabel: { fontSize: 10, fontWeight: "700", color: T.sub, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
  boxText: { fontSize: 14, color: T.ink, lineHeight: 20 },
  feedback: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
  feedbackTxt: { flex: 1, fontSize: 12.5, color: T.sub, fontStyle: "italic", lineHeight: 18 },
});