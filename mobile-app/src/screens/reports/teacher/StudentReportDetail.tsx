// screens/reports/teacher/StudentReportDetail.tsx — one student's report: overview, quizzes, assignments, attendance

import React, { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Avatar, Card, Chip, EmptyState, Header, ProgressBar, Screen, SectionLabel, SP, T, Tone, font } from "../../../components/ui";
import { API_URL, HeaderIconButton, LoadBoundary, StatRow, TabBar, attTone, enc, num, ratio, scoreTone, useReport } from "./ReportShared";
import QuizReport from "./QuizReport";
import AssignmentReport from "./AssignmentReport";
import AttendanceReport from "./AttendanceReport";

type ReportTab = "overview" | "quiz" | "assignments" | "attendance";

const TABS: { key: ReportTab; label: string; icon: React.ComponentProps<typeof Ionicons>["name"] }[] = [
  { key: "overview", label: "Overview", icon: "grid-outline" },
  { key: "quiz", label: "Quizzes", icon: "help-circle-outline" },
  { key: "assignments", label: "Assignments", icon: "document-text-outline" },
  { key: "attendance", label: "Attendance", icon: "calendar-outline" },
];

const ATT_LABEL: Record<Tone, string> = { success: "On track", warning: "Needs attention", danger: "Critical", neutral: "No data", primary: "On track", info: "On track" };

export default function StudentReportDetail() {
  const navigation = useNavigation<any>();
  const params = useRoute<any>().params ?? {};
  const { student, subject, teacher_id } = params;
  const subjectId: string = subject?.subject_id || "";

  const [tab, setTab] = useState<ReportTab>("overview");
  const [refreshing, setRefreshing] = useState(false);
  // Bumping this remounts the embedded reports so pull-to-refresh reloads whichever tab is open.
  const [refreshKey, setRefreshKey] = useState(0);

  const report = useReport(
    student?.uid && teacher_id && subjectId ? `${API_URL}/api/reports/student/${enc(student.uid)}/full?teacher_id=${enc(teacher_id)}&subject_id=${enc(subjectId)}` : null
  );

  if (!student?.uid || !teacher_id || !subjectId) {
    return (
      <Screen>
        <Header title="Student report" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Student not selected" text="Go back and choose a student again." />
      </Screen>
    );
  }

  const onRefresh = async () => {
    setRefreshing(true);
    setRefreshKey((k) => k + 1);
    await report.reload(true);
    setRefreshing(false);
  };

  const Q = report.data?.quiz_summary ?? {};
  const A = report.data?.assignment_summary ?? {};
  const AT = report.data?.attendance_summary ?? {};
  const attPct: number | null = AT.percentage ?? null;
  const aTone = attTone(attPct);

  return (
    <Screen>
      <Header
        title={student.name || "Student"}
        subtitle={`${subject?.subject_name ?? ""}${student.roll_no ? ` - Roll ${student.roll_no}` : ""}`}
        onBack={() => navigation.goBack()}
        right={<HeaderIconButton icon="share-outline" label="Export report" onPress={() => navigation.navigate("ExportReport", { student, subject, teacher_id })} />}
      />
      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      <ScrollView
        contentContainerStyle={{ padding: SP.lg, paddingBottom: 60, gap: SP.md }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[T.primary]} tintColor={T.primary} />}
      >
        {tab === "overview" && (
          <LoadBoundary report={report} label="Loading report">
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md }}>
                <Avatar name={student.name} tone="primary" size={48} />
                <View style={{ flex: 1 }}>
                  <Text style={font.label}>Overall attendance</Text>
                  <Text style={{ fontSize: 38, fontWeight: "800", letterSpacing: -1, color: T[aTone === "neutral" ? "ink" : aTone] }}>{attPct != null ? `${attPct}%` : "-"}</Text>
                </View>
                <Chip label={ATT_LABEL[aTone]} tone={aTone} />
              </View>
              <View style={{ marginTop: SP.md, gap: SP.sm }}>
                <ProgressBar value={attPct != null ? attPct / 100 : 0} tone={aTone === "neutral" ? "primary" : aTone} height={8} />
                <Text style={font.small}>
                  {num(AT.present)} present - {num(AT.absent)} absent{num(AT.od) > 0 ? ` - ${num(AT.od)} on duty` : ""} - {num(AT.total_lectures)} classes
                </Text>
              </View>
            </Card>

            <SectionLabel style={{ marginTop: SP.sm, marginBottom: 0 }}>Academic performance</SectionLabel>

            <Pressable onPress={() => setTab("quiz")} accessibilityRole="button" accessibilityLabel="Open quizzes" style={({ pressed }) => pressed && { opacity: 0.75 }}>
              <Card>
                <CardTitle icon="help-circle-outline" label="Quizzes" />
                <StatRow
                  items={[
                    { value: `${num(Q.attempted)}/${num(Q.total)}`, label: "Attempted", tone: "primary" },
                    { value: Q.avg_percentage != null ? `${Q.avg_percentage}%` : "-", label: "Avg score", tone: scoreTone(Q.avg_percentage) },
                    { value: num(Q.skipped), label: "Missed", tone: num(Q.skipped) > 0 ? "warning" : "neutral" },
                  ]}
                />
                <Rate label="Completion" value={ratio(Q.attempted, Q.total)} />
              </Card>
            </Pressable>

            <Pressable onPress={() => setTab("assignments")} accessibilityRole="button" accessibilityLabel="Open assignments" style={({ pressed }) => pressed && { opacity: 0.75 }}>
              <Card>
                <CardTitle icon="document-text-outline" label="Assignments" />
                <StatRow
                  items={[
                    { value: `${num(A.submitted)}/${num(A.total)}`, label: "Submitted", tone: "primary" },
                    { value: A.avg_marks != null ? A.avg_marks : "-", label: "Avg marks", tone: "success" },
                    { value: num(A.skipped), label: "Skipped", tone: num(A.skipped) > 0 ? "warning" : "neutral" },
                  ]}
                />
                <Rate label="Submission" value={ratio(A.submitted, A.total)} />
              </Card>
            </Pressable>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SP.sm }}>
              <Chip label={attPct == null ? "No attendance yet" : attPct >= 75 ? "Attendance is fine" : "Attendance below 75%"} tone={aTone} icon={attPct != null && attPct >= 75 ? "checkmark-circle" : "alert-circle"} />
              {Q.avg_percentage != null && <Chip label={Q.avg_percentage >= 60 ? `Quiz average ${Q.avg_percentage}%` : "Quiz scores need work"} tone={scoreTone(Q.avg_percentage)} />}
            </View>
          </LoadBoundary>
        )}

        {tab === "quiz" && <QuizReport key={`q${refreshKey}`} studentUid={student.uid} subjectId={subjectId} teacherId={teacher_id} />}
        {tab === "assignments" && <AssignmentReport key={`a${refreshKey}`} studentUid={student.uid} subjectId={subjectId} teacherId={teacher_id} />}
        {tab === "attendance" && (
          <AttendanceReport key={`t${refreshKey}`} studentUid={student.uid} studentName={student.name} subjectId={subjectId} subjectName={subject?.subject_name} teacherId={teacher_id} isTeacher />
        )}
      </ScrollView>
    </Screen>
  );
}

function CardTitle({ icon, label }: { icon: React.ComponentProps<typeof Ionicons>["name"]; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SP.sm, marginBottom: SP.md }}>
      <View style={{ width: 28, height: 28, borderRadius: 9, backgroundColor: T.primarySoft, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={15} color={T.primary} />
      </View>
      <Text style={[font.h3, { flex: 1 }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={T.muted} />
    </View>
  );
}

function Rate({ label, value }: { label: string; value: number }) {
  return (
    <View style={{ marginTop: SP.md, gap: 5 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={font.small}>{label} rate</Text>
        <Text style={[font.small, { color: T.primary, fontWeight: "700" }]}>{Math.round(value * 100)}%</Text>
      </View>
      <ProgressBar value={value} />
    </View>
  );
}