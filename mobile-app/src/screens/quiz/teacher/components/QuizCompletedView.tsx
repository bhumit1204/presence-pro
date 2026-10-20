// screens/quiz/teacher/components/QuizCompletedView.tsx — final report: stats + ranked results
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Card, EmptyState, Header, Screen, SP, T, TONE, Tone, font } from "../../../../components/ui";
import { Quiz, Submission, fmtDate } from "./quizViewConstants";
import QuizHeaderCard from "./QuizHeaderCard";

/** Best name we have: student_name, then roll number, then a short uid. */
export const displayName = (sub: Submission) =>
  sub.student_name?.trim() ? sub.student_name : sub.student_roll ? `Roll ${sub.student_roll}` : sub.student_uid ? `Student ${sub.student_uid.slice(0, 6)}` : "Student";

/** Gold / silver / bronze numbered badge (no emoji). */
export function RankBadge({ rank }: { rank: number }) {
  const medal = rank === 1 ? "#E0A800" : rank === 2 ? "#94A3B8" : rank === 3 ? "#B26A2B" : null;
  return (
    <View style={[st.rank, medal ? { backgroundColor: medal } : { backgroundColor: T.lineSoft }]}>
      <Text style={[st.rankTxt, { color: medal ? "#fff" : T.sub }]}>{rank}</Text>
    </View>
  );
}

export function SubmissionAvatar({ sub, first }: { sub: Submission; first?: boolean }) {
  const letter = displayName(sub).replace(/^(Roll|Student)\s*/i, "").charAt(0).toUpperCase() || "?";
  const c = TONE[first ? "warning" : "primary"];
  return (
    <View style={[st.avatar, { backgroundColor: c.bg }]}>
      <Text style={[st.avatarTxt, { color: c.fg }]}>{letter}</Text>
    </View>
  );
}

function StatBox({ label, value, tone }: { label: string; value: string | number; tone: Tone }) {
  const c = TONE[tone];
  return (
    <View style={[st.statCard, { borderLeftColor: c.fg }]}>
      <Text style={st.statLabel}>{label}</Text>
      <Text style={[st.statValue, { color: c.fg }]}>{value}</Text>
    </View>
  );
}

interface Props {
  quiz: Quiz;
  submissions: Submission[];
  onBack: () => void;
}

export default function QuizCompletedView({ quiz, submissions, onBack }: Props) {
  const marks = submissions.map((s) => s.marks_obtained ?? 0);
  const highest = marks.length ? Math.max(...marks) : 0;
  const lowest = marks.length ? Math.min(...marks) : 0;
  const avg = marks.length ? (marks.reduce((a, b) => a + b, 0) / marks.length).toFixed(1) : "0";
  const passRate = quiz.total_marks > 0 && marks.length ? Math.round((marks.filter((m) => m / quiz.total_marks >= 0.5).length / marks.length) * 100) : 0;

  return (
    <Screen>
      <Header title="Test report" subtitle={`${quiz.subject_name} - ${fmtDate(quiz.scheduled_start)}`} onBack={onBack} />
      <ScrollView contentContainerStyle={st.scroll} showsVerticalScrollIndicator={false}>
        <QuizHeaderCard quiz={quiz} status="completed" submissionCount={submissions.length} />

        {submissions.length === 0 ? (
          <EmptyState icon="file-tray-outline" title="No submissions" text="No students submitted this quiz." />
        ) : (
          <>
            <Text style={font.h2}>Performance</Text>
            <View style={st.grid}>
              <StatBox label="Highest" value={highest} tone="success" />
              <StatBox label="Average" value={avg} tone="primary" />
              <StatBox label="Lowest" value={lowest} tone="danger" />
              <StatBox label="Pass rate" value={`${passRate}%`} tone="warning" />
            </View>

            <Text style={font.h2}>Results</Text>
            <Card padded={false}>
              {submissions.map((sub, i) => {
                const pct = quiz.total_marks > 0 ? Math.round((sub.marks_obtained / quiz.total_marks) * 100) : 0;
                return (
                  <View key={sub.submission_id ?? i} style={[st.row, i < submissions.length - 1 && st.rowBorder]}>
                    <RankBadge rank={i + 1} />
                    <SubmissionAvatar sub={sub} first={i === 0} />
                    <View style={{ flex: 1 }}>
                      <Text style={st.name} numberOfLines={1}>
                        {displayName(sub)}
                      </Text>
                      {!!sub.student_roll && !!sub.student_name && <Text style={st.roll}>Roll {sub.student_roll}</Text>}
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={st.marks}>
                        {sub.marks_obtained}/{quiz.total_marks}
                      </Text>
                      <Text style={[st.pct, { color: pct >= 50 ? T.success : T.danger }]}>{pct}%</Text>
                    </View>
                  </View>
                );
              })}
            </Card>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, gap: SP.lg, paddingBottom: 40 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: SP.md },
  statCard: { flexBasis: "47%", flexGrow: 1, backgroundColor: T.surface, borderRadius: 16, padding: SP.lg, borderWidth: 1, borderColor: T.line, borderLeftWidth: 4 },
  statLabel: { fontSize: 11.5, fontWeight: "600", color: T.sub, marginBottom: 6 },
  statValue: { fontSize: 22, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", gap: SP.md, paddingVertical: SP.md, paddingHorizontal: SP.lg },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  rank: { width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  rankTxt: { fontSize: 13, fontWeight: "800" },
  avatar: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  avatarTxt: { fontSize: 14, fontWeight: "800" },
  name: { fontSize: 14, fontWeight: "700", color: T.ink },
  roll: { fontSize: 11.5, color: T.sub, marginTop: 2 },
  marks: { fontSize: 15, fontWeight: "800", color: T.primary },
  pct: { fontSize: 11.5, fontWeight: "700", marginTop: 2 },
});