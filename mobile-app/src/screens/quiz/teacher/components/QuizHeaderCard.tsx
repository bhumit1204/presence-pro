import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { PRIMARY, PRIMARY_LIGHT, GREEN, GREY, Quiz, QuizStatus, fmtDate } from "./quizViewConstants";

// ─── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: QuizStatus }) {
  const MAP = {
    live:      { bg: "#10B981", text: "● LIVE" },
    scheduled: { bg: "#F59E0B", text: "⏳ SCHEDULED" },
    completed: { bg: GREY,      text: "✓ COMPLETED" },
  };
  const { bg, text } = MAP[status];
  return (
    <View style={[S.badge, { backgroundColor: bg }]}>
      <Text style={S.badgeTxt}>{text}</Text>
    </View>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────
interface Props {
  quiz: Quiz;
  status: QuizStatus;
  submissionCount: number;
}

export default function QuizHeaderCard({ quiz, status, submissionCount }: Props) {
  const stats = [
    { val: quiz.question_count ?? "—", lbl: "Questions"  },
    { val: quiz.total_marks,           lbl: "Marks"      },
    { val: `${quiz.time_limit_minutes}m`, lbl: "Duration" },
    { val: submissionCount,            lbl: "Submitted", color: status === "live" ? GREEN : PRIMARY },
  ];

  return (
    <View style={S.card}>

      {/* Title row */}
      <View style={S.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={S.title} numberOfLines={2}>{quiz.title}</Text>
          <Text style={S.subject}>{quiz.subject_name}</Text>
        </View>
        <StatusBadge status={status} />
      </View>

      {/* Join code */}
      <View style={S.codeRow}>
        <Text style={S.codeLbl}>JOIN CODE</Text>
        <View style={S.codeBox}>
          <Text style={S.codeTxt}>{quiz.join_code}</Text>
        </View>
      </View>

      {/* 4 stat tiles */}
      <View style={S.statsRow}>
        {stats.map((s, i) => (
          <React.Fragment key={s.lbl}>
            <View style={S.statItem}>
              <Text style={[S.statVal, { color: s.color ?? PRIMARY }]}>{s.val}</Text>
              <Text style={S.statLbl}>{s.lbl}</Text>
            </View>
            {i < stats.length - 1 && <View style={S.divider} />}
          </React.Fragment>
        ))}
      </View>

      {/* Schedule strip */}
      <View style={S.scheduleRow}>
        <View style={S.scheduleItem}>
          <Text style={S.schedLbl}>START</Text>
          <Text style={S.schedTxt}>{fmtDate(quiz.scheduled_start)}</Text>
        </View>
        <Text style={S.arrow}>→</Text>
        <View style={[S.scheduleItem, { alignItems: "flex-end" }]}>
          <Text style={S.schedLbl}>END</Text>
          <Text style={S.schedTxt}>{fmtDate(quiz.scheduled_end)}</Text>
        </View>
      </View>

    </View>
  );
}

const S = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius: 24,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    shadowColor: PRIMARY,
    shadowOpacity: 0.07,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },

  // Title
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 16 },
  title:    { fontSize: 18, fontWeight: "800", color: "#111827", lineHeight: 24 },
  subject:  { fontSize: 13, color: GREY, fontWeight: "600", marginTop: 3 },

  // Badge
  badge:    { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20 },
  badgeTxt: { color: "#FFF", fontWeight: "800", fontSize: 11, letterSpacing: 0.3 },

  // Join code
  codeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: "#F3F4F6", marginBottom: 12 },
  codeLbl: { fontSize: 11, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.6 },
  codeBox: { backgroundColor: PRIMARY_LIGHT, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 6 },
  codeTxt: { fontSize: 16, fontWeight: "900", color: PRIMARY, letterSpacing: 4 },

  // Stats
  statsRow: { flexDirection: "row", marginBottom: 12 },
  statItem: { flex: 1, alignItems: "center", paddingVertical: 8 },
  statVal:  { fontSize: 18, fontWeight: "800" },
  statLbl:  { fontSize: 10, color: GREY, fontWeight: "600", marginTop: 2 },
  divider:  { width: 1, backgroundColor: "#E5E7EB", marginVertical: 4 },

  // Schedule
  scheduleRow:  { flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderTopColor: "#F3F4F6", paddingTop: 12 },
  scheduleItem: { flex: 1 },
  schedLbl:     { fontSize: 10, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 },
  schedTxt:     { fontSize: 12, fontWeight: "600", color: "#111827" },
  arrow:        { fontSize: 14, color: GREY, paddingHorizontal: 8 },
});