// screens/reports/teacher/ClassReport.tsx — whole-class report for one subject: overview, attendance, quizzes, assignments

import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Avatar, Banner, Button, Card, Chip, EmptyState, Header, ProgressBar, Screen, SectionLabel, SP, T, TextField, font, Tone } from "../../../components/ui";
import { API_URL, LoadBoundary, StatRow, TabBar, attTone, enc, num, scoreTone, useReport } from "./ReportShared";

type SortKey = "roll_no" | "name" | "attendance" | "quiz" | "assignment";
type TabKey = "overview" | "attendance" | "quiz" | "assignment";

const TABS: { key: TabKey; label: string; icon: React.ComponentProps<typeof Ionicons>["name"] }[] = [
  { key: "overview", label: "Overview", icon: "grid-outline" },
  { key: "attendance", label: "Attendance", icon: "calendar-outline" },
  { key: "quiz", label: "Quizzes", icon: "help-circle-outline" },
  { key: "assignment", label: "Assignments", icon: "document-text-outline" },
];

const SORTS: Record<TabKey, { key: SortKey; label: string }[]> = {
  overview: [{ key: "roll_no", label: "Roll" }, { key: "name", label: "Name" }, { key: "attendance", label: "Attendance" }],
  attendance: [{ key: "roll_no", label: "Roll" }, { key: "name", label: "Name" }, { key: "attendance", label: "Attendance" }],
  quiz: [{ key: "roll_no", label: "Roll" }, { key: "name", label: "Name" }, { key: "quiz", label: "Score" }],
  assignment: [{ key: "roll_no", label: "Roll" }, { key: "name", label: "Name" }, { key: "assignment", label: "Marks" }],
};

const sortValue = (s: any, k: SortKey): string | number | null => {
  switch (k) {
    case "roll_no": return s.roll_no ? String(s.roll_no) : null;
    case "name": return s.name ? String(s.name) : null;
    case "attendance": return s.attendance_pct ?? null;
    case "quiz": return s.quiz_avg_pct ?? null;
    default: return s.assignment_avg_marks ?? null;
  }
};

export default function ClassReport() {
  const navigation = useNavigation<any>();
  const params = useRoute<any>().params ?? {};
  const { subject, teacher_id } = params;
  const subjectId: string = subject?.subject_id || "";

  const report = useReport(teacher_id && subjectId ? `${API_URL}/api/reports/class?teacher_id=${enc(teacher_id)}&subject_id=${enc(subjectId)}` : null);

  const [tab, setTab] = useState<TabKey>("overview");
  const [sortKey, setSortKey] = useState<SortKey>("roll_no");
  const [asc, setAsc] = useState(true);
  const [query, setQuery] = useState("");
  const [riskOnly, setRiskOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const summary = report.data?.class_summary ?? {};
  const all: any[] = report.data?.students ?? [];

  const students = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = all.filter((s) => !q || String(s.name || "").toLowerCase().includes(q) || String(s.roll_no || "").toLowerCase().includes(q));
    if (riskOnly && tab === "attendance") list = list.filter((s) => s.attendance_pct != null && s.attendance_pct < 75);
    // Missing values always sink to the bottom, whichever direction is chosen.
    return [...list].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = typeof va === "string" ? va.localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) : (va as number) - (vb as number);
      return asc ? c : -c;
    });
  }, [all, query, riskOnly, tab, sortKey, asc]);

  const changeTab = (t: TabKey) => {
    setTab(t);
    setRiskOnly(false);
    if (!SORTS[t].some((s) => s.key === sortKey)) {
      setSortKey("roll_no");
      setAsc(true);
    }
  };
  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === "roll_no" || k === "name");
    }
  };
  const open = (s: any) => navigation.navigate("StudentReportDetail", { student: s, subject, teacher_id });

  if (!teacher_id || !subjectId) {
    return (
      <Screen>
        <Header title="Class report" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Subject not selected" text="Go back and choose a subject again." />
      </Screen>
    );
  }

  const below75 = num(summary.below_75_attendance);

  return (
    <Screen>
      <Header
        title={subject?.subject_name || "Class report"}
        subtitle={report.data ? `${subject?.subject_code ? subject.subject_code + " - " : ""}${num(summary.total_students)} students` : subject?.subject_code}
        onBack={() => navigation.goBack()}
      />
      <TabBar tabs={TABS} active={tab} onChange={changeTab} />

      <ScrollView
        contentContainerStyle={{ padding: SP.lg, paddingBottom: 60, gap: SP.md }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            colors={[T.primary]}
            tintColor={T.primary}
            onRefresh={async () => {
              setRefreshing(true);
              await report.reload(true);
              setRefreshing(false);
            }}
          />
        }
      >
        <LoadBoundary report={report} label="Loading class report">
          {tab === "overview" && (
            <>
              <StatRow
                items={[
                  { value: num(summary.total_students), label: "Students", tone: "primary" },
                  { value: summary.avg_attendance_pct != null ? `${summary.avg_attendance_pct}%` : "-", label: "Attendance", tone: attTone(summary.avg_attendance_pct) },
                ]}
              />
              <StatRow
                items={[
                  { value: summary.avg_quiz_pct != null ? `${summary.avg_quiz_pct}%` : "-", label: "Avg quiz", tone: scoreTone(summary.avg_quiz_pct) },
                  { value: summary.avg_assignment_marks != null ? summary.avg_assignment_marks : "-", label: "Avg assignment", tone: "info" },
                ]}
              />
              {below75 > 0 && (
                <Banner tone="danger" icon="alert-circle">
                  {below75} student{below75 > 1 ? "s are" : " is"} below 75% attendance
                </Banner>
              )}
            </>
          )}

          {tab === "attendance" && (
            <StatRow
              items={[
                { value: summary.avg_attendance_pct != null ? `${summary.avg_attendance_pct}%` : "-", label: "Class average", tone: attTone(summary.avg_attendance_pct) },
                { value: below75, label: "Below 75%", tone: below75 > 0 ? "danger" : "success" },
                { value: num(summary.total_lectures), label: "Classes held", tone: "primary" },
              ]}
            />
          )}
          {tab === "quiz" && (
            <StatRow
              items={[
                { value: summary.avg_quiz_pct != null ? `${summary.avg_quiz_pct}%` : "-", label: "Class average", tone: scoreTone(summary.avg_quiz_pct) },
                { value: num(summary.total_quizzes), label: "Quizzes held", tone: "primary" },
              ]}
            />
          )}
          {tab === "assignment" && (
            <StatRow
              items={[
                { value: summary.avg_assignment_marks != null ? summary.avg_assignment_marks : "-", label: "Average marks", tone: "info" },
                { value: num(summary.total_assignments), label: "Assignments", tone: "primary" },
              ]}
            />
          )}

          <TextField value={query} onChangeText={setQuery} placeholder="Search by name or roll number" icon="search-outline" autoCapitalize="none" />

          <View style={st.sortRow}>
            {SORTS[tab].map((o) => {
              const on = sortKey === o.key;
              return (
                <Pressable key={o.key} onPress={() => toggleSort(o.key)} style={[st.sortChip, on && st.sortChipOn]} accessibilityRole="button" accessibilityLabel={`Sort by ${o.label}`}>
                  <Text style={[st.sortTxt, on && { color: T.primary }]}>{o.label}</Text>
                  <Ionicons name={on ? (asc ? "arrow-up" : "arrow-down") : "swap-vertical-outline"} size={12} color={on ? T.primary : T.muted} />
                </Pressable>
              );
            })}
            {tab === "attendance" && (
              <Pressable onPress={() => setRiskOnly((v) => !v)} style={[st.sortChip, riskOnly && { backgroundColor: T.dangerSoft, borderColor: T.danger }]}>
                <Ionicons name="warning-outline" size={12} color={riskOnly ? T.danger : T.muted} />
                <Text style={[st.sortTxt, riskOnly && { color: T.danger }]}>Below 75%</Text>
              </Pressable>
            )}
          </View>

          <SectionLabel style={{ marginBottom: 0 }}>
            {students.length} student{students.length === 1 ? "" : "s"}
          </SectionLabel>

          {students.length === 0 ? (
            <EmptyState icon="people-outline" title={all.length === 0 ? "No students yet" : "No match"} text={all.length === 0 ? "Nobody is enrolled in this subject." : "Try a different search."} />
          ) : (
            students.map((s) => <StudentRow key={s.uid} s={s} tab={tab} total={summary} onPress={() => open(s)} />)
          )}
        </LoadBoundary>
      </ScrollView>
    </Screen>
  );
}

function StudentRow({ s, tab, total, onPress }: { s: any; tab: TabKey; total: any; onPress: () => void }) {
  let meta = `Roll ${s.roll_no || "-"}`;
  let big: string = "-";
  let tone: Tone = "neutral";
  let bar: number | null = null;
  let extra: React.ReactNode = null;

  if (tab === "overview" || tab === "attendance") {
    big = s.attendance_pct != null ? `${s.attendance_pct}%` : "-";
    tone = attTone(s.attendance_pct);
    bar = s.attendance_pct != null ? s.attendance_pct / 100 : null;
    if (tab === "attendance") {
      extra = (
        <View style={{ flexDirection: "row", gap: SP.lg }}>
          <Text style={font.small}>
            <Text style={{ color: T.success, fontWeight: "800" }}>{num(s.present)}</Text> present
          </Text>
          <Text style={font.small}>
            <Text style={{ color: T.danger, fontWeight: "800" }}>{num(s.absent)}</Text> absent
          </Text>
          {num(s.late) > 0 && (
            <Text style={font.small}>
              <Text style={{ color: T.warning, fontWeight: "800" }}>{num(s.late)}</Text> late
            </Text>
          )}
        </View>
      );
    }
  } else if (tab === "quiz") {
    meta = `${num(s.quiz_attempted)}/${num(total.total_quizzes)} attempted`;
    big = s.quiz_avg_pct != null ? `${s.quiz_avg_pct}%` : "-";
    tone = scoreTone(s.quiz_avg_pct);
    bar = s.quiz_avg_pct != null ? s.quiz_avg_pct / 100 : null;
  } else {
    meta = `${num(s.assignment_submitted)}/${num(total.total_assignments)} submitted`;
    big = s.assignment_avg_marks != null ? String(s.assignment_avg_marks) : "-";
    tone = "info";
  }

  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Open report for ${s.name}`} style={({ pressed }) => pressed && { opacity: 0.75 }}>
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md }}>
          <Avatar name={s.name} tone="primary" />
          <View style={{ flex: 1 }}>
            <Text style={font.h3} numberOfLines={1}>
              {s.name || "Student"}
            </Text>
            <Text style={[font.small, { marginTop: 2 }]}>{meta}</Text>
          </View>
          <Chip label={big} tone={tone} />
          <Ionicons name="chevron-forward" size={16} color={T.muted} />
        </View>
        {(bar != null || extra) && (
          <View style={{ marginTop: SP.md, gap: SP.sm }}>
            {bar != null && <ProgressBar value={bar} tone={tone === "neutral" ? "primary" : tone} />}
            {extra}
          </View>
        )}
      </Card>
    </Pressable>
  );
}

const st = StyleSheet.create({
  sortRow: { flexDirection: "row", flexWrap: "wrap", gap: SP.sm },
  sortChip: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: T.surface, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 7, borderWidth: 1, borderColor: T.line },
  sortChipOn: { backgroundColor: T.primarySoft, borderColor: T.primary },
  sortTxt: { fontSize: 12, fontWeight: "700", color: T.sub },
});