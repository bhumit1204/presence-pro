// screens/quiz/teacher/components/QuizLiveView.tsx — quiz in progress: countdown + submissions as they arrive
import React, { useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Card, EmptyState, Header, LiveBadge, Screen, SP, T, font } from "../../../../components/ui";
import { Quiz, Submission, msToCountdown } from "./quizViewConstants";
import QuizHeaderCard from "./QuizHeaderCard";
import { RankBadge, SubmissionAvatar, displayName } from "./QuizCompletedView";

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
    const id = setInterval(() => setRemaining(new Date(quiz.scheduled_end).getTime() - Date.now()), 1000);
    return () => clearInterval(id);
  }, [quiz.scheduled_end]);

  return (
    <Screen>
      <Header title="Quiz live" subtitle={quiz.subject_name} onBack={onBack} right={<LiveBadge />} />
      <ScrollView
        contentContainerStyle={st.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[T.primary]} tintColor={T.primary} />}
      >
        <View style={st.timerBanner}>
          <Text style={st.timerLbl}>Time remaining</Text>
          <Text style={st.timer}>{msToCountdown(remaining)}</Text>
        </View>

        <QuizHeaderCard quiz={quiz} status="live" submissionCount={submissions.length} />

        <Card>
          <View style={st.head}>
            <Text style={[font.h2, { flex: 1 }]}>Live submissions</Text>
            <View style={st.count}>
              <Text style={st.countTxt}>{submissions.length}</Text>
            </View>
          </View>

          {submissions.length === 0 ? (
            <EmptyState icon="hourglass-outline" title="Waiting for submissions" text="This list refreshes every 15 seconds. Pull down to refresh now." />
          ) : (
            submissions.map((sub, i) => {
              const pct = quiz.total_marks > 0 ? Math.round((sub.marks_obtained / quiz.total_marks) * 100) : 0;
              return (
                <View key={sub.submission_id ?? i} style={[st.row, i < submissions.length - 1 && st.rowBorder]}>
                  <RankBadge rank={i + 1} />
                  <SubmissionAvatar sub={sub} first={i === 0} />
                  <View style={{ flex: 1 }}>
                    <Text style={st.name} numberOfLines={1}>
                      {displayName(sub)}
                    </Text>
                    {!!sub.student_roll && !!sub.student_name && <Text style={st.sub}>Roll {sub.student_roll}</Text>}
                    {!!sub.submitted_at && (
                      <Text style={[st.sub, { color: T.success, fontWeight: "600" }]}>
                        Submitted {new Date(sub.submitted_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </Text>
                    )}
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={st.marks}>
                      {sub.marks_obtained}/{quiz.total_marks}
                    </Text>
                    <Text style={[st.pct, { color: pct >= 50 ? T.success : T.danger }]}>{pct}%</Text>
                  </View>
                </View>
              );
            })
          )}
        </Card>

      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, gap: SP.lg, paddingBottom: 40 },
  timerBanner: { backgroundColor: T.success, borderRadius: 18, paddingHorizontal: SP.xl, paddingVertical: SP.lg, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  timerLbl: { color: "#fff", fontWeight: "700", fontSize: 14 },
  timer: { color: "#fff", fontWeight: "800", fontSize: 22, fontVariant: ["tabular-nums"] },
  head: { flexDirection: "row", alignItems: "center", gap: SP.sm, marginBottom: SP.sm },
  count: { backgroundColor: T.primarySoft, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 3 },
  countTxt: { fontSize: 12.5, fontWeight: "800", color: T.primary },
  row: { flexDirection: "row", alignItems: "center", gap: SP.md, paddingVertical: SP.md },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  name: { fontSize: 14, fontWeight: "700", color: T.ink },
  sub: { fontSize: 11.5, color: T.sub, marginTop: 2 },
  marks: { fontSize: 15, fontWeight: "800", color: T.primary },
  pct: { fontSize: 11.5, fontWeight: "700", marginTop: 2 },
});