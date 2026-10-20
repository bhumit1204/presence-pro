// screens/reports/teacher/AssignmentReport.tsx — one student's assignments in one subject (embedded in StudentReportDetail)

import React from "react";
import { Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Banner, Card, Chip, EmptyState, ProgressBar, SectionLabel, SP, T, Tone, font } from "../../../components/ui";
import { API_URL, IconName, LoadBoundary, StatRow, enc, fmtDate, num, ratio, useReport } from "./ReportShared";

interface Props {
  studentUid: string;
  subjectId: string;
  teacherId: string;
}

const STATUS: Record<string, { tone: Tone; icon: IconName; label: string }> = {
  graded: { tone: "success", icon: "checkmark-circle", label: "Graded" },
  submitted: { tone: "primary", icon: "cloud-upload-outline", label: "Submitted" },
  late: { tone: "warning", icon: "time-outline", label: "Late" },
  missed: { tone: "danger", icon: "close-circle", label: "Missed" },
  pending: { tone: "neutral", icon: "ellipse-outline", label: "Pending" },
};

export default function AssignmentReport({ studentUid, subjectId, teacherId }: Props) {
  const report = useReport(
    studentUid && subjectId && teacherId
      ? `${API_URL}/api/reports/student/${enc(studentUid)}/assignments?teacher_id=${enc(teacherId)}&subject_id=${enc(subjectId)}`
      : null
  );
  const { data } = report;
  const assignments: any[] = data?.assignments ?? [];
  const summary = data?.summary ?? {};

  return (
    <LoadBoundary report={report} label="Loading assignments">
      {assignments.length === 0 ? (
        <EmptyState icon="document-text-outline" title="No assignments yet" text="Nothing has been assigned in this subject." />
      ) : (
        <View style={{ gap: SP.md }}>
          <StatRow
            items={[
              { value: num(summary.submitted), label: "Submitted", tone: "primary" },
              { value: num(summary.skipped), label: "Skipped", tone: "danger" },
              { value: num(summary.late), label: "Late", tone: "warning" },
              { value: summary.avg_marks != null ? summary.avg_marks : "-", label: "Avg marks", tone: "success" },
            ]}
          />

          <SectionLabel style={{ marginTop: SP.sm, marginBottom: 0 }}>All assignments</SectionLabel>

          {assignments.map((a) => {
            const cfg = STATUS[a.display_status] ?? STATUS.pending;
            const graded = a.display_status === "graded";
            const sub = a.submission;
            const due = a.due_date ? new Date(a.due_date) : null;
            const pastDue = !!due && !isNaN(due.getTime()) && due < new Date();
            const scored = ratio(sub?.marks_obtained, a.marks);

            return (
              <Card key={a.assignment_id}>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SP.md }}>
                  <View style={{ flex: 1 }}>
                    <Text style={font.h3} numberOfLines={2}>
                      {a.title}
                    </Text>
                    <Text style={[font.small, { marginTop: 3 }]}>
                      Due {fmtDate(a.due_date)}
                      {pastDue && a.allow_late ? " - late submissions allowed" : ""}
                    </Text>
                  </View>
                  <Chip label={cfg.label} tone={cfg.tone} icon={cfg.icon} />
                </View>

                {sub ? (
                  <View style={{ marginTop: SP.md, gap: SP.sm }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Ionicons name="time-outline" size={14} color={T.muted} />
                      <Text style={font.small}>
                        Submitted {fmtDate(sub.submitted_at)}
                        {sub.status === "late" ? " (late)" : ""}
                      </Text>
                    </View>

                    {graded ? (
                      <View style={{ backgroundColor: T.bg, borderRadius: 12, padding: SP.md, gap: SP.sm }}>
                        <Text style={font.label}>Marks obtained</Text>
                        <Text style={{ fontSize: 22, fontWeight: "800", color: T.ink }}>
                          {num(sub.marks_obtained)}
                          <Text style={{ fontSize: 14, color: T.muted }}> / {num(a.marks)}</Text>
                        </Text>
                        <ProgressBar value={scored} tone={scored >= 0.6 ? "success" : "danger"} />
                        {!!sub.feedback && (
                          <View style={{ borderTopWidth: 1, borderTopColor: T.line, paddingTop: SP.sm, gap: 3 }}>
                            <Text style={font.label}>Feedback</Text>
                            <Text style={[font.body, { color: T.ink }]}>{sub.feedback}</Text>
                          </View>
                        )}
                      </View>
                    ) : (
                      <Banner tone="warning" icon="hourglass-outline">
                        Waiting to be graded
                      </Banner>
                    )}
                  </View>
                ) : a.display_status === "missed" ? (
                  <Banner tone="danger" icon="close-circle-outline" style={{ marginTop: SP.md }}>
                    Not submitted
                  </Banner>
                ) : null}
              </Card>
            );
          })}
        </View>
      )}
    </LoadBoundary>
  );
}