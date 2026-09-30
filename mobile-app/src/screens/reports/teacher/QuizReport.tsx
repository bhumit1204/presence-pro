import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#4834D4";
const PRIMARY_SOFT = "#EEF2FF";
const BG = "#F3F4F6";
const WHITE = "#FFFFFF";
const GREY = "#6B7280";
const DARK = "#111827";
const GREEN = "#10B981";
const AMBER = "#F59E0B";
const RED = "#EF4444";
const BORDER = "#E5E7EB";

const API_URL = "http://10.132.90.56:5000";

interface Props {
  studentUid: string;
  subjectId: string;
  teacherId: string;
}

export default function QuizReport({ studentUid, subjectId, teacherId }: Props) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `${API_URL}/api/reports/student/${studentUid}/quiz?teacher_id=${teacherId}&subject_id=${subjectId}`
      );
      const json = await res.json();
      if (json.success) setData(json);
    } catch (e) {
      console.log("QUIZ REPORT FETCH:", e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return (
    <View style={S.center}>
      <ActivityIndicator size="large" color={PRIMARY} />
    </View>
  );

  if (!data || data.quizzes?.length === 0) return (
    <View style={S.empty}>
      <Ionicons name="help-circle-outline" size={48} color={BORDER} />
      <Text style={S.emptyText}>No quizzes for this subject yet</Text>
    </View>
  );

  const { summary, quizzes } = data;

  const getStatusColor = (status: string) => {
    if (status === "attempted") return GREEN;
    if (status === "missed") return RED;
    return AMBER;
  };

  const getStatusLabel = (status: string) => {
    if (status === "attempted") return "Attempted";
    if (status === "missed") return "Missed";
    return "Upcoming";
  };

  return (
    <View style={S.container}>
      {/* Summary Row */}
      <View style={S.summaryRow}>
        <View style={[S.summaryChip, { backgroundColor: PRIMARY_SOFT }]}>
          <Text style={[S.summaryNum, { color: PRIMARY }]}>{summary.attempted}</Text>
          <Text style={[S.summaryLabel, { color: PRIMARY }]}>Attempted</Text>
        </View>
        <View style={[S.summaryChip, { backgroundColor: "#FEF3C7" }]}>
          <Text style={[S.summaryNum, { color: AMBER }]}>{summary.skipped}</Text>
          <Text style={[S.summaryLabel, { color: AMBER }]}>Missed</Text>
        </View>
        <View style={[S.summaryChip, { backgroundColor: "#F0FDF4" }]}>
          <Text style={[S.summaryNum, { color: GREEN }]}>
            {summary.avg_percentage != null ? `${summary.avg_percentage}%` : "—"}
          </Text>
          <Text style={[S.summaryLabel, { color: GREEN }]}>Avg Score</Text>
        </View>
      </View>

      {/* Quiz List */}
      <Text style={S.sectionTitle}>All Quizzes</Text>
      {quizzes.map((quiz: any) => (
        <View key={quiz.quiz_id} style={S.card}>
          <View style={S.cardTop}>
            <View style={S.cardTitle}>
              <Text style={S.quizName} numberOfLines={2}>{quiz.title}</Text>
              <Text style={S.quizDate}>
                {quiz.scheduled_start
                  ? new Date(quiz.scheduled_start).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })
                  : "—"}
              </Text>
            </View>
            <View style={[S.statusBadge, { backgroundColor: getStatusColor(quiz.status) + "18" }]}>
              <Text style={[S.statusText, { color: getStatusColor(quiz.status) }]}>
                {getStatusLabel(quiz.status)}
              </Text>
            </View>
          </View>

          {quiz.submission ? (
            <View style={S.resultRow}>
              {/* Marks */}
              <View style={S.resultItem}>
                <Text style={S.resultLabel}>Marks</Text>
                <Text style={S.resultValue}>
                  {quiz.submission.marks_obtained}/{quiz.total_marks}
                </Text>
              </View>
              {/* Percentage */}
              <View style={S.resultItem}>
                <Text style={S.resultLabel}>Percentage</Text>
                <Text style={[S.resultValue, {
                  color: (quiz.submission.percentage || 0) >= 60 ? GREEN : RED
                }]}>
                  {quiz.submission.percentage}%
                </Text>
              </View>
              {/* Questions */}
              <View style={S.resultItem}>
                <Text style={S.resultLabel}>Questions</Text>
                <Text style={S.resultValue}>{quiz.question_count}</Text>
              </View>
            </View>
          ) : quiz.status === "missed" ? (
            <View style={S.missedBanner}>
              <Ionicons name="close-circle-outline" size={14} color={RED} />
              <Text style={S.missedText}>Student did not attempt this quiz</Text>
            </View>
          ) : (
            <View style={S.pendingBanner}>
              <Ionicons name="time-outline" size={14} color={AMBER} />
              <Text style={S.pendingText}>Quiz scheduled for {new Date(quiz.scheduled_start).toLocaleDateString()}</Text>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

const S = StyleSheet.create({
  container: { gap: 12 },
  center: { paddingVertical: 60, alignItems: "center" },
  empty: { paddingVertical: 60, alignItems: "center", gap: 12 },
  emptyText: { fontSize: 14, color: GREY },

  summaryRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 4,
  },
  summaryChip: {
    flex: 1,
    borderRadius: 16,
    padding: 14,
    alignItems: "center",
  },
  summaryNum: { fontSize: 22, fontWeight: "800" },
  summaryLabel: { fontSize: 11, fontWeight: "600", marginTop: 2 },

  sectionTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: GREY,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 4,
    marginBottom: 4,
  },

  card: {
    backgroundColor: WHITE,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: BORDER,
    gap: 12,
    elevation: 1,
  },
  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },
  cardTitle: { flex: 1 },
  quizName: { fontSize: 15, fontWeight: "700", color: DARK },
  quizDate: { fontSize: 12, color: GREY, marginTop: 4 },

  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  statusText: { fontSize: 11, fontWeight: "700" },

  resultRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: BG,
    borderRadius: 12,
    padding: 12,
  },
  resultItem: { alignItems: "center" },
  resultLabel: { fontSize: 11, color: GREY, fontWeight: "600" },
  resultValue: { fontSize: 16, fontWeight: "800", color: DARK, marginTop: 4 },

  missedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FEF2F2",
    borderRadius: 10,
    padding: 10,
  },
  missedText: { fontSize: 12, color: RED, fontWeight: "600" },

  pendingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FFFBEB",
    borderRadius: 10,
    padding: 10,
  },
  pendingText: { fontSize: 12, color: AMBER, fontWeight: "600" },
});