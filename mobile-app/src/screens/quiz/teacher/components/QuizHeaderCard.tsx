// screens/quiz/teacher/components/QuizHeaderCard.tsx — summary card at the top of every quiz state
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Chip, SP, T } from "../../../../components/ui";
import { Quiz, QuizStatus, fmtDate } from "./quizViewConstants";

export function StatusChip({ status }: { status: QuizStatus }) {
  if (status === "live") return <Chip label="Live" tone="success" icon="radio-button-on" />;
  if (status === "scheduled") return <Chip label="Scheduled" tone="warning" icon="time-outline" />;
  return <Chip label="Completed" tone="neutral" icon="checkmark-done" />;
}

interface Props {
  quiz: Quiz;
  status: QuizStatus;
  submissionCount: number;
}

export default function QuizHeaderCard({ quiz, status, submissionCount }: Props) {
  const stats = [
    { val: quiz.question_count ?? "-", lbl: "Questions", color: T.primary },
    { val: quiz.total_marks, lbl: "Marks", color: T.primary },
    { val: `${quiz.time_limit_minutes}m`, lbl: "Duration", color: T.primary },
    { val: submissionCount, lbl: "Submitted", color: status === "live" ? T.success : T.primary },
  ];

  return (
    <View style={st.card}>
      <View style={st.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={st.title} numberOfLines={2}>
            {quiz.title}
          </Text>
          <Text style={st.subject}>{quiz.subject_name}</Text>
        </View>
        <StatusChip status={status} />
      </View>

      <View style={st.codeRow}>
        <Text style={st.codeLbl}>Join code</Text>
        {quiz.join_code ? (
          <View style={st.codeBox}>
            <Text style={st.codeTxt} selectable>
              {quiz.join_code}
            </Text>
          </View>
        ) : (
          <Chip label="Open quiz, no code" tone="success" icon="lock-open-outline" />
        )}
      </View>

      <View style={st.statsRow}>
        {stats.map((s, i) => (
          <React.Fragment key={s.lbl}>
            <View style={st.statItem}>
              <Text style={[st.statVal, { color: s.color }]}>{s.val}</Text>
              <Text style={st.statLbl}>{s.lbl}</Text>
            </View>
            {i < stats.length - 1 && <View style={st.divider} />}
          </React.Fragment>
        ))}
      </View>

      <View style={st.schedule}>
        <View style={{ flex: 1 }}>
          <Text style={st.schedLbl}>Start</Text>
          <Text style={st.schedTxt}>{fmtDate(quiz.scheduled_start)}</Text>
        </View>
        <Ionicons name="arrow-forward" size={15} color={T.muted} style={{ marginHorizontal: SP.sm }} />
        <View style={{ flex: 1, alignItems: "flex-end" }}>
          <Text style={st.schedLbl}>End</Text>
          <Text style={st.schedTxt}>{fmtDate(quiz.scheduled_end)}</Text>
        </View>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 24, padding: SP.xl, borderWidth: 1, borderColor: T.line },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: SP.md, marginBottom: SP.lg },
  title: { fontSize: 18, fontWeight: "800", color: T.ink, lineHeight: 24 },
  subject: { fontSize: 13, color: T.sub, fontWeight: "600", marginTop: 3 },

  codeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: SP.md, borderTopWidth: 1, borderBottomWidth: 1, borderColor: T.lineSoft, marginBottom: SP.md },
  codeLbl: { fontSize: 11, fontWeight: "700", color: T.sub, textTransform: "uppercase", letterSpacing: 0.7 },
  codeBox: { backgroundColor: T.primarySoft, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 6 },
  codeTxt: { fontSize: 17, fontWeight: "900", color: T.primary, letterSpacing: 4 },

  statsRow: { flexDirection: "row", marginBottom: SP.md },
  statItem: { flex: 1, alignItems: "center", paddingVertical: 6 },
  statVal: { fontSize: 18, fontWeight: "800" },
  statLbl: { fontSize: 10.5, color: T.sub, fontWeight: "600", marginTop: 2 },
  divider: { width: 1, backgroundColor: T.line, marginVertical: 4 },

  schedule: { flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderTopColor: T.lineSoft, paddingTop: SP.md },
  schedLbl: { fontSize: 10, fontWeight: "700", color: T.sub, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 },
  schedTxt: { fontSize: 12, fontWeight: "600", color: T.ink },
});