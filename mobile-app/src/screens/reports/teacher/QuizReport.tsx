// screens/reports/teacher/QuizReport.tsx — one student's quizzes in one subject (embedded in StudentReportDetail)

import React from "react";
import { Text, View } from "react-native";
import { Banner, Card, Chip, EmptyState, SectionLabel, SP, T, Tone, font } from "../../../components/ui";
import { API_URL, LoadBoundary, StatRow, enc, fmtDate, num, scoreTone, useReport } from "./ReportShared";

interface Props {
  studentUid: string;
  subjectId: string;
  teacherId: string;
}

const STATUS: Record<string, { tone: Tone; label: string }> = {
  attempted: { tone: "success", label: "Attempted" },
  missed: { tone: "danger", label: "Missed" },
};

export default function QuizReport({ studentUid, subjectId, teacherId }: Props) {
  const report = useReport(
    studentUid && subjectId && teacherId
      ? `${API_URL}/api/reports/student/${enc(studentUid)}/quiz?teacher_id=${enc(teacherId)}&subject_id=${enc(subjectId)}`
      : null
  );
  const { data } = report;
  const quizzes: any[] = data?.quizzes ?? [];
  const summary = data?.summary ?? {};

  return (
    <LoadBoundary report={report} label="Loading quizzes">
      {quizzes.length === 0 ? (
        <EmptyState icon="help-circle-outline" title="No quizzes yet" text="No quiz has been held in this subject." />
      ) : (
        <View style={{ gap: SP.md }}>
          <StatRow
            items={[
              { value: num(summary.attempted), label: "Attempted", tone: "primary" },
              { value: num(summary.skipped), label: "Missed", tone: "danger" },
              { value: summary.avg_percentage != null ? `${summary.avg_percentage}%` : "-", label: "Avg score", tone: scoreTone(summary.avg_percentage) },
            ]}
          />

          <SectionLabel style={{ marginTop: SP.sm, marginBottom: 0 }}>All quizzes</SectionLabel>

          {quizzes.map((q) => {
            const cfg = STATUS[q.status] ?? { tone: "warning" as Tone, label: "Upcoming" };
            const sub = q.submission;
            const pct = sub?.percentage;
            return (
              <Card key={q.quiz_id}>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SP.md }}>
                  <View style={{ flex: 1 }}>
                    <Text style={font.h3} numberOfLines={2}>
                      {q.title}
                    </Text>
                    <Text style={[font.small, { marginTop: 3 }]}>{fmtDate(q.scheduled_start)}</Text>
                  </View>
                  <Chip label={cfg.label} tone={cfg.tone} />
                </View>

                {sub ? (
                  <View style={{ flexDirection: "row", justifyContent: "space-between", backgroundColor: T.bg, borderRadius: 12, padding: SP.md, marginTop: SP.md }}>
                    <Cell label="Marks" value={`${num(sub.marks_obtained)}/${num(q.total_marks)}`} />
                    <Cell label="Score" value={pct != null ? `${pct}%` : "-"} color={scoreTone(pct) === "danger" ? T.danger : T.success} />
                    <Cell label="Questions" value={String(num(q.question_count))} />
                  </View>
                ) : q.status === "missed" ? (
                  <Banner tone="danger" icon="close-circle-outline" style={{ marginTop: SP.md }}>
                    The student did not attempt this quiz
                  </Banner>
                ) : (
                  <Banner tone="warning" icon="time-outline" style={{ marginTop: SP.md }}>
                    Scheduled for {fmtDate(q.scheduled_start)}
                  </Banner>
                )}
              </Card>
            );
          })}
        </View>
      )}
    </LoadBoundary>
  );
}

function Cell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ alignItems: "center", flex: 1 }}>
      <Text style={font.small}>{label}</Text>
      <Text style={{ fontSize: 17, fontWeight: "800", color: color ?? T.ink, marginTop: 3 }}>{value}</Text>
    </View>
  );
}