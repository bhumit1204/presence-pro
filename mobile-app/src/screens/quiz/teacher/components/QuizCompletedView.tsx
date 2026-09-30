import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { PRIMARY, PRIMARY_LIGHT, GREEN, GREEN_LIGHT, GREY, BG, Quiz, Submission, fmtDate } from "./quizViewConstants";
import QuizHeaderCard from "./QuizHeaderCard";

// ─── Stats Card ────────────────────────────────────────────────────────────
function StatsCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <View style={[S.statCard, { borderLeftColor: color }]}>
      <Text style={S.statLabel}>{label}</Text>
      <Text style={[S.statValue, { color }]}>{value}</Text>
    </View>
  );
}

// ─── Leaderboard Row ───────────────────────────────────────────────────────
function LeaderboardRow({
  rank, sub, totalMarks,
}: {
  rank: number;
  sub: Submission;
  totalMarks: number;
}) {
  const pct = totalMarks > 0 ? Math.round((sub.marks_obtained / totalMarks) * 100) : 0;
  const MEDAL: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

  // Resolve the best display name available
  // Backend sends student_name if it successfully fetched from students collection
  // Falls back to student_roll then student_uid
  const displayName =
    sub.student_name && sub.student_name.trim()
      ? sub.student_name
      : sub.student_roll
      ? `Roll: ${sub.student_roll}`
      : sub.student_uid
      ? `UID: ${sub.student_uid.slice(0, 8)}…`
      : "Student";

  const initials = displayName.replace(/^(UID:|Roll:)\s*/i, "").charAt(0).toUpperCase();

  return (
    <View style={S.row}>
      {/* Rank / medal */}
      <View style={S.rankBadge}>
        {rank <= 3 ? (
          <Text style={S.rankEmoji}>{MEDAL[rank]}</Text>
        ) : (
          <Text style={S.rankNum}>{rank}</Text>
        )}
      </View>

      {/* Avatar */}
      <View style={[S.avatar, { backgroundColor: rank === 1 ? "#FEF3C7" : PRIMARY_LIGHT }]}>
        <Text style={[S.avatarText, { color: rank === 1 ? "#92400E" : PRIMARY }]}>{initials}</Text>
      </View>

      {/* Name + roll */}
      <View style={{ flex: 1 }}>
        <Text style={S.studentName} numberOfLines={1}>{displayName}</Text>
        {sub.student_roll && sub.student_name && (
          <Text style={S.studentRoll}>Roll: {sub.student_roll}</Text>
        )}
      </View>

      {/* Score */}
      <View style={{ alignItems: "flex-end" }}>
        <Text style={S.marks}>{sub.marks_obtained}/{totalMarks}</Text>
        <Text style={[S.percentage, { color: pct >= 50 ? GREEN : "#DC2626" }]}>
          {pct}%
        </Text>
      </View>
    </View>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────
interface Props {
  quiz: Quiz;
  submissions: Submission[];
  onBack: () => void;
}

export default function QuizCompletedView({ quiz, submissions, onBack }: Props) {
  const marks = submissions.map((s) => s.marks_obtained ?? 0);
  const highest = marks.length ? Math.max(...marks) : 0;
  const lowest  = marks.length ? Math.min(...marks) : 0;
  const avg     = marks.length
    ? (marks.reduce((a, b) => a + b, 0) / marks.length).toFixed(1)
    : 0;
  const passRate =
    quiz.total_marks > 0 && marks.length
      ? Math.round(
          (marks.filter((m) => m / quiz.total_marks >= 0.5).length / marks.length) * 100
        )
      : 0;

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={S.content} showsVerticalScrollIndicator={false}>
        <TouchableOpacity style={S.backBtn} onPress={onBack}>
          <Ionicons name="chevron-back" size={22} color={PRIMARY} />
        </TouchableOpacity>

        <Text style={S.title}>Test Report</Text>
        <Text style={S.subtitle}>
          {quiz.subject_name} · {fmtDate(quiz.scheduled_start)}
        </Text>

        <QuizHeaderCard quiz={quiz} status="completed" submissionCount={submissions.length} />

        {submissions.length === 0 ? (
          <View style={S.empty}>
            <Ionicons name="mail-open-outline" size={44} color={GREY} style={{ marginBottom: 12 }} />
            <Text style={S.emptyTitle}>No submissions</Text>
            <Text style={S.emptyText}>No students submitted this quiz.</Text>
          </View>
        ) : (
          <>
            {/* Performance stats */}
            <Text style={S.sectionTitle}>Performance</Text>
            <View style={S.statsGrid}>
              <StatsCard label="Highest" value={highest} color={GREEN} />
              <StatsCard label="Average" value={avg}     color={PRIMARY} />
              <StatsCard label="Lowest"  value={lowest}  color="#DC2626" />
              <StatsCard label="Pass Rate" value={`${passRate}%`} color="#F59E0B" />
            </View>

            {/* Leaderboard */}
            <Text style={S.sectionTitle}>Results</Text>
            <View style={S.card}>
              {submissions.map((sub, i) => (
                <LeaderboardRow
                  key={sub.submission_id ?? i}
                  rank={i + 1}
                  sub={sub}
                  totalMarks={quiz.total_marks}
                />
              ))}
            </View>
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 },

  backBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "#FFF", alignItems: "center", justifyContent: "center",
    marginBottom: 12, elevation: 2,
    shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6,
  },

  title:    { fontSize: 28, fontWeight: "800", color: "#111827", marginBottom: 4 },
  subtitle: { fontSize: 14, color: GREY, marginBottom: 16 },

  sectionTitle: { fontSize: 16, fontWeight: "700", color: "#111827", marginBottom: 12, marginTop: 8 },

  statsGrid: {
    flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 20,
  },
  statCard: {
    flex: 1, minWidth: "47%",
    backgroundColor: "#FFF", borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: "#E5E7EB", borderLeftWidth: 4,
  },
  statLabel: { fontSize: 11, fontWeight: "600", color: GREY, marginBottom: 6 },
  statValue: { fontSize: 20, fontWeight: "800" },

  card: {
    backgroundColor: "#FFF", borderRadius: 16, padding: 16,
    marginBottom: 16, borderWidth: 1, borderColor: "#E5E7EB",
  },

  row: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  rankBadge: {
    width: 28, alignItems: "center",
  },
  rankEmoji: { fontSize: 20 },
  rankNum:   { fontSize: 14, fontWeight: "700", color: GREY },

  avatar: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { fontSize: 14, fontWeight: "800" },

  studentName: { fontSize: 14, fontWeight: "700", color: "#111827" },
  studentRoll: { fontSize: 11, color: GREY, marginTop: 2 },

  marks:      { fontSize: 15, fontWeight: "700", color: PRIMARY },
  percentage: { fontSize: 11, fontWeight: "700", marginTop: 2 },

  empty:      { alignItems: "center", paddingVertical: 50 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: "#111827", marginBottom: 6 },
  emptyText:  { fontSize: 13, color: GREY },
});