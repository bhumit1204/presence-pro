import React, { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PRIMARY, PRIMARY_LIGHT, GREEN, GREY, BG, Quiz, Submission, msToCountdown } from "./quizViewConstants";
import QuizHeaderCard from "./QuizHeaderCard";

function SubmissionRow({ rank, sub, totalMarks }: { rank: number; sub: Submission; totalMarks: number }) {
  const pct = totalMarks > 0 ? Math.round((sub.marks_obtained / totalMarks) * 100) : 0;
  const MEDAL = { 1: "🥇", 2: "🥈", 3: "🥉" };

  return (
    <View style={S.row}>
      <View style={S.rankBadge}>
        <Text style={S.rankText}>{MEDAL[rank as keyof typeof MEDAL] ?? rank}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={S.studentName} numberOfLines={1}>
          {sub.student_name ?? sub.student_uid ?? "Student"}
        </Text>
        {sub.student_roll && <Text style={S.studentRoll}>Roll: {sub.student_roll}</Text>}
        {sub.submitted_at && (
          <Text style={S.submitTime}>
            {new Date(sub.submitted_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        )}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={S.marks}>{sub.marks_obtained}/{totalMarks}</Text>
        <Text style={[S.percentage, { color: pct >= 50 ? GREEN : "#DC2626" }]}>
          {pct}%
        </Text>
      </View>
    </View>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────
interface Props {
  quiz: Quiz;
  submissions: Submission[];
  refreshing: boolean;
  onRefresh: () => void;
  onBack: () => void;
}

export default function QuizLiveView({ quiz, submissions, refreshing, onRefresh, onBack }: Props) {
  const [remaining, setRemaining] = useState(() => new Date(quiz.scheduled_end).getTime() - Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(new Date(quiz.scheduled_end).getTime() - Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [quiz.scheduled_end]);

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={S.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[PRIMARY]} />}
      >
        <TouchableOpacity style={S.backBtn} onPress={onBack}>
          <Text style={S.backIcon}>‹</Text>
        </TouchableOpacity>

        {/* LIVE Banner */}
        <View style={S.liveBanner}>
          <View style={S.liveDot} />
          <Text style={S.liveText}>Quiz is LIVE</Text>
          <View style={{ flex: 1 }} />
          <Text style={S.timer}>{msToCountdown(remaining)}</Text>
        </View>

        <QuizHeaderCard quiz={quiz} status="live" submissionCount={submissions.length} />

        {/* Submissions */}
        <View style={S.card}>
          <View style={S.header}>
            <Text style={S.sectionTitle}>Live Submissions</Text>
            <View style={S.badge}>
              <Text style={S.badgeText}>{submissions.length}</Text>
            </View>
          </View>

          {submissions.length === 0 ? (
            <View style={S.empty}>
              <Text style={S.emptyEmoji}>⏳</Text>
              <Text style={S.emptyText}>Waiting for submissions...</Text>
              <Text style={S.emptyHint}>Pull down to refresh</Text>
            </View>
          ) : (
            submissions.map((sub, i) => (
              <SubmissionRow key={sub.submission_id ?? i} rank={i + 1} sub={sub} totalMarks={quiz.total_marks} />
            ))
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 },

  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", marginBottom: 12, elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  backIcon: { fontSize: 22, fontWeight: "700", color: PRIMARY },

  liveBanner: { flexDirection: "row", alignItems: "center", backgroundColor: GREEN, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 16, gap: 8 },
  liveDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#FFF" },
  liveText: { color: "#FFF", fontWeight: "800", fontSize: 14 },
  timer: { color: "#FFF", fontWeight: "800", fontSize: 16, fontVariant: ["tabular-nums"] },

  card: { backgroundColor: "#FFF", borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: "#E5E7EB" },
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: "#111827", flex: 1 },
  badge: { backgroundColor: PRIMARY_LIGHT, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontWeight: "700", color: PRIMARY },

  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  rankBadge: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#F3F4F6" },
  rankText: { fontSize: 16, fontWeight: "700" },
  studentName: { fontSize: 14, fontWeight: "700", color: "#111827" },
  studentRoll: { fontSize: 11, color: GREY, marginTop: 2 },
  submitTime: { fontSize: 11, color: GREEN, marginTop: 2, fontWeight: "600" },
  marks: { fontSize: 15, fontWeight: "700", color: PRIMARY },
  percentage: { fontSize: 11, fontWeight: "700", marginTop: 2 },

  empty: { alignItems: "center", paddingVertical: 30 },
  emptyEmoji: { fontSize: 36, marginBottom: 10 },
  emptyText: { fontSize: 14, fontWeight: "700", color: "#111827" },
  emptyHint: { fontSize: 12, color: GREY, marginTop: 4 },
});