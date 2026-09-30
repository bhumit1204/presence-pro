import React, { useEffect, useState, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation } from "@react-navigation/native";
import { auth } from "../../../services/firebase";
import {
  PRIMARY, PRIMARY_LIGHT, BG, GREEN, GREEN_LIGHT,
  RED, RED_LIGHT, AMBER, AMBER_LIGHT, GREY,
  API_URL, GradedAnswer,
} from "./components/studentQuizConstants";
import { QuizPageSkeleton } from "./components/QuizSkeleton";

interface FullResult {
  submission: {
    total_marks:    number;
    marks_obtained: number;
    percentage:     number;
    submitted_at:   string;
    answers:        GradedAnswer[];
  };
  quiz: { title: string; subject_name: string };
}

// ─── Answer review card (same visual as QuizResultScreen) ─────────────────────
function AnswerCard({ ga, index }: { ga: GradedAnswer; index: number }) {
  const correct = ga.is_correct;
  return (
    <View style={[A.card, correct ? A.cardCorrect : A.cardWrong]}>
      <View style={A.header}>
        <View style={[A.badge, correct ? A.badgeOk : A.badgeNo]}>
          <Text style={[A.badgeTxt, { color: correct ? GREEN : RED }]}>Q{index + 1}</Text>
        </View>
        <Text style={[A.score, { color: correct ? GREEN : RED }]}>
          {ga.marks_obtained.toFixed(1)}/{ga.marks_possible}
        </Text>
      </View>
      <Text style={A.qText}>{ga.question_text}</Text>

      <View style={[A.box, !ga.student_answer && A.emptyBox]}>
        <Text style={A.boxLabel}>Your answer</Text>
        <Text style={[A.boxText, !ga.student_answer && { color: GREY, fontStyle: "italic" }]}>
          {ga.student_answer || "No answer provided"}
        </Text>
      </View>

      {!correct && ga.correct_answer && (
        <View style={[A.box, A.correctBox]}>
          <Text style={A.boxLabel}>Correct answer</Text>
          <Text style={[A.boxText, { color: "#065F46" }]}>{ga.correct_answer}</Text>
        </View>
      )}

      {ga.feedback && <Text style={A.feedback}>💬 {ga.feedback}</Text>}
    </View>
  );
}
const A = StyleSheet.create({
  card:        { backgroundColor: "#FFF", borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1.5, borderColor: "#E5E7EB" },
  cardCorrect: { borderColor: GREEN },
  cardWrong:   { borderColor: RED },
  header:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  badge:       { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1.5 },
  badgeOk:     { backgroundColor: GREEN_LIGHT, borderColor: GREEN },
  badgeNo:     { backgroundColor: RED_LIGHT, borderColor: RED },
  badgeTxt:    { fontSize: 12, fontWeight: "800" },
  score:       { fontSize: 14, fontWeight: "800" },
  qText:       { fontSize: 15, fontWeight: "600", color: "#111827", lineHeight: 22, marginBottom: 10 },
  box:         { backgroundColor: "#F9FAFB", borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: "#E5E7EB" },
  emptyBox:    { opacity: 0.6 },
  correctBox:  { backgroundColor: GREEN_LIGHT, borderColor: GREEN },
  boxLabel:    { fontSize: 10, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 },
  boxText:     { fontSize: 14, color: "#111827", lineHeight: 20 },
  feedback:    { fontSize: 12, color: GREY, fontStyle: "italic", marginTop: 4 },
});

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function StudentQuizResult() {
  const navigation = useNavigation<any>();
  const route      = useRoute<any>();
  const { quiz_id, quiz_title } = route.params as { quiz_id: string; quiz_title: string };

  const [data,    setData]    = useState<FullResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound,setNotFound]= useState(false);

  const fetchResult = useCallback(async () => {
    try {
      setLoading(true);
      const uid = auth.currentUser?.uid;
      if (!uid) return;

      const res  = await fetch(`${API_URL}/api/quizzes/${quiz_id}/result?student_uid=${uid}`);
      const json = await res.json();

      if (!json.success) { setNotFound(true); return; }
      setData(json);
    } catch (e) {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [quiz_id]);

  useEffect(() => { fetchResult(); }, [fetchResult]);

  if (loading) return (
    <SafeAreaView style={S.safe}><QuizPageSkeleton /></SafeAreaView>
  );

  if (notFound || !data) return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={S.content}>
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Text style={S.backIcon}>‹</Text>
        </TouchableOpacity>
        <View style={S.notFound}>
          <Text style={S.notFoundEmoji}>📭</Text>
          <Text style={S.notFoundTitle}>No submission found</Text>
          <Text style={S.notFoundSub}>You haven't attended this quiz.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );

  const { submission, quiz } = data;
  const correct   = submission.answers.filter((a) => a.is_correct).length;
  const incorrect = submission.answers.length - correct;
  const color     = submission.percentage >= 75 ? GREEN : submission.percentage >= 50 ? AMBER : RED;

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={S.content} showsVerticalScrollIndicator={false}>

        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Text style={S.backIcon}>‹</Text>
        </TouchableOpacity>

        <Text style={S.title}>{quiz_title || quiz.title}</Text>
        <Text style={S.sub}>{quiz.subject_name}</Text>

        {/* Score card */}
        <View style={[S.scoreCard, { borderLeftColor: color }]}>
          <Text style={[S.pct, { color }]}>{submission.percentage.toFixed(1)}%</Text>
          <Text style={S.scoreDetails}>
            {submission.marks_obtained.toFixed(1)} / {submission.total_marks} marks
          </Text>
          <View style={S.scoreRow}>
            <Text style={[S.scoreTag, { color: GREEN, backgroundColor: GREEN_LIGHT }]}>✓ {correct} correct</Text>
            <Text style={[S.scoreTag, { color: RED, backgroundColor: RED_LIGHT }]}>✕ {incorrect} wrong</Text>
          </View>
        </View>

        {/* Answer review */}
        <Text style={S.reviewTitle}>Answer Review</Text>
        {submission.answers.map((ga, i) => (
          <AnswerCard key={ga.question_id ?? i} ga={ga} index={i} />
        ))}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 },

  backBtn:  { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", marginBottom: 16, elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  backIcon: { fontSize: 22, fontWeight: "700", color: PRIMARY },

  title: { fontSize: 24, fontWeight: "800", color: "#111827", marginBottom: 4 },
  sub:   { fontSize: 14, color: GREY, marginBottom: 20 },

  scoreCard: { backgroundColor: "#FFF", borderRadius: 16, padding: 20, marginBottom: 20, borderLeftWidth: 4, borderWidth: 1, borderColor: "#E5E7EB", alignItems: "center" },
  pct:       { fontSize: 44, fontWeight: "900", marginBottom: 4 },
  scoreDetails: { fontSize: 16, fontWeight: "600", color: GREY, marginBottom: 12 },
  scoreRow:  { flexDirection: "row", gap: 10 },
  scoreTag:  { fontSize: 13, fontWeight: "700", paddingHorizontal: 12, paddingVertical: 5, borderRadius: 10 },

  reviewTitle: { fontSize: 18, fontWeight: "800", color: "#111827", marginBottom: 14 },

  notFound:      { alignItems: "center", paddingTop: 60 },
  notFoundEmoji: { fontSize: 48, marginBottom: 14 },
  notFoundTitle: { fontSize: 18, fontWeight: "700", color: "#111827", marginBottom: 6 },
  notFoundSub:   { fontSize: 14, color: GREY },
});