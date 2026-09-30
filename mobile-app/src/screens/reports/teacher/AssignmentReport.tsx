import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
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

export default function AssignmentReport({ studentUid, subjectId, teacherId }: Props) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `${API_URL}/api/reports/student/${studentUid}/assignments?teacher_id=${teacherId}&subject_id=${subjectId}`
      );
      const json = await res.json();
      if (json.success) setData(json);
    } catch (e) {
      console.log("ASSIGNMENT REPORT FETCH:", e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return (
    <View style={S.center}><ActivityIndicator size="large" color={PRIMARY} /></View>
  );

  if (!data || data.assignments?.length === 0) return (
    <View style={S.empty}>
      <Ionicons name="document-text-outline" size={48} color={BORDER} />
      <Text style={S.emptyText}>No assignments for this subject yet</Text>
    </View>
  );

  const { summary, assignments } = data;

  const getStatusConfig = (status: string) => {
    const configs: Record<string, { color: string; bg: string; icon: string; label: string }> = {
      graded:    { color: GREEN,   bg: "#F0FDF4", icon: "checkmark-circle",  label: "Graded"    },
      submitted: { color: PRIMARY, bg: PRIMARY_SOFT, icon: "cloud-upload",    label: "Submitted" },
      late:      { color: AMBER,   bg: "#FEF3C7", icon: "time",               label: "Late"      },
      missed:    { color: RED,     bg: "#FEF2F2", icon: "close-circle",       label: "Missed"    },
      pending:   { color: GREY,    bg: BG,        icon: "ellipse-outline",    label: "Pending"   },
    };
    return configs[status] || configs.pending;
  };

  return (
    <View style={S.container}>
      {/* Summary */}
      <View style={S.summaryRow}>
        <View style={[S.chip, { backgroundColor: PRIMARY_SOFT }]}>
          <Text style={[S.chipNum, { color: PRIMARY }]}>{summary.submitted}</Text>
          <Text style={[S.chipLabel, { color: PRIMARY }]}>Submitted</Text>
        </View>
        <View style={[S.chip, { backgroundColor: "#FEF3C7" }]}>
          <Text style={[S.chipNum, { color: AMBER }]}>{summary.skipped}</Text>
          <Text style={[S.chipLabel, { color: AMBER }]}>Skipped</Text>
        </View>
        <View style={[S.chip, { backgroundColor: "#F0FDF4" }]}>
          <Text style={[S.chipNum, { color: GREEN }]}>
            {summary.avg_marks != null ? summary.avg_marks : "—"}
          </Text>
          <Text style={[S.chipLabel, { color: GREEN }]}>Avg Marks</Text>
        </View>
        <View style={[S.chip, { backgroundColor: "#FEF3C7" }]}>
          <Text style={[S.chipNum, { color: AMBER }]}>{summary.late}</Text>
          <Text style={[S.chipLabel, { color: AMBER }]}>Late</Text>
        </View>
      </View>

      {/* Assignment List */}
      <Text style={S.sectionTitle}>All Assignments</Text>

      {assignments.map((a: any) => {
        const cfg = getStatusConfig(a.display_status);
        const isGraded = a.display_status === "graded";
        const isPastDue = new Date(a.due_date) < new Date();

        return (
          <View key={a.assignment_id} style={S.card}>
            {/* Top row */}
            <View style={S.cardTop}>
              <View style={S.cardLeft}>
                <Text style={S.assignName} numberOfLines={2}>{a.title}</Text>
                <Text style={S.assignMeta}>
                  Due: {new Date(a.due_date).toLocaleDateString("en-IN", {
                    day: "numeric", month: "short", year: "numeric"
                  })}
                  {isPastDue && a.allow_late && (
                    <Text style={{ color: AMBER }}> · Late OK</Text>
                  )}
                </Text>
              </View>
              <View style={[S.badge, { backgroundColor: cfg.bg }]}>
                <Ionicons name={cfg.icon as any} size={12} color={cfg.color} />
                <Text style={[S.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
              </View>
            </View>

            {/* Submission details */}
            {a.submission ? (
              <View style={S.subDetails}>
                {/* Submitted at */}
                <View style={S.subRow}>
                  <Ionicons name="time-outline" size={13} color={GREY} />
                  <Text style={S.subMeta}>
                    Submitted: {new Date(a.submission.submitted_at).toLocaleDateString("en-IN", {
                      day: "numeric", month: "short", year: "numeric",
                    })}
                    {a.submission.status === "late" && (
                      <Text style={{ color: AMBER }}> (Late)</Text>
                    )}
                  </Text>
                </View>

                {/* Marks / Grade */}
                {isGraded ? (
                  <View style={S.gradeBox}>
                    <View style={S.gradeLeft}>
                      <Text style={S.gradeLabel}>Marks Obtained</Text>
                      <Text style={S.gradeMarks}>
                        {a.submission.marks_obtained}/{a.marks}
                      </Text>
                      <View style={S.marksBar}>
                        <View
                          style={[
                            S.marksBarFill,
                            {
                              width: `${Math.min((a.submission.marks_obtained / a.marks) * 100, 100)}%`,
                              backgroundColor:
                                (a.submission.marks_obtained / a.marks) >= 0.6 ? GREEN : RED,
                            },
                          ]}
                        />
                      </View>
                    </View>
                    {a.submission.feedback && (
                      <View style={S.feedbackBox}>
                        <Text style={S.feedbackLabel}>Feedback</Text>
                        <Text style={S.feedbackText}>{a.submission.feedback}</Text>
                      </View>
                    )}
                  </View>
                ) : (
                  <View style={S.pendingGrade}>
                    <Ionicons name="hourglass-outline" size={13} color={AMBER} />
                    <Text style={S.pendingText}>Grading pending</Text>
                  </View>
                )}
              </View>
            ) : a.display_status === "missed" ? (
              <View style={S.missedBanner}>
                <Ionicons name="close-circle-outline" size={13} color={RED} />
                <Text style={S.missedText}>Assignment not submitted</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const S = StyleSheet.create({
  container: { gap: 12 },
  center: { paddingVertical: 60, alignItems: "center" },
  empty: { paddingVertical: 60, alignItems: "center", gap: 12 },
  emptyText: { fontSize: 14, color: GREY },

  summaryRow: { flexDirection: "row", gap: 8 },
  chip: { flex: 1, borderRadius: 14, padding: 12, alignItems: "center" },
  chipNum: { fontSize: 18, fontWeight: "800" },
  chipLabel: { fontSize: 10, fontWeight: "700", marginTop: 2 },

  sectionTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: GREY,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 4,
  },

  card: {
    backgroundColor: "#FFF",
    borderRadius: 16,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    elevation: 1,
  },
  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },
  cardLeft: { flex: 1 },
  assignName: { fontSize: 15, fontWeight: "700", color: DARK },
  assignMeta: { fontSize: 12, color: GREY, marginTop: 4 },

  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  badgeText: { fontSize: 11, fontWeight: "700" },

  subDetails: { gap: 8 },
  subRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  subMeta: { fontSize: 12, color: GREY },

  gradeBox: { backgroundColor: "#F8FAFC", borderRadius: 12, padding: 12, gap: 8 },
  gradeLeft: { gap: 4 },
  gradeLabel: { fontSize: 11, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.5 },
  gradeMarks: { fontSize: 20, fontWeight: "800", color: DARK },
  marksBar: {
    height: 6,
    backgroundColor: "#E5E7EB",
    borderRadius: 3,
    overflow: "hidden",
    width: "100%",
  },
  marksBarFill: { height: "100%", borderRadius: 3 },
  feedbackBox: { borderTopWidth: 1, borderTopColor: "#E5E7EB", paddingTop: 8, gap: 4 },
  feedbackLabel: { fontSize: 11, fontWeight: "700", color: GREY },
  feedbackText: { fontSize: 13, color: DARK, lineHeight: 18 },

  pendingGrade: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FFFBEB",
    borderRadius: 10,
    padding: 10,
  },
  pendingText: { fontSize: 12, color: AMBER, fontWeight: "600" },

  missedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FEF2F2",
    borderRadius: 10,
    padding: 10,
  },
  missedText: { fontSize: 12, color: RED, fontWeight: "600" },
});