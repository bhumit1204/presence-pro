import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  FlatList,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";

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

type SortKey = "roll_no" | "name" | "attendance" | "quiz" | "assignment";
type TabKey = "overview" | "attendance" | "quiz" | "assignment";

export default function ClassReport() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, teacher_id } = route.params;
  const subjectId = subject?.subject_id || "";

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [sortKey, setSortKey] = useState<SortKey>("roll_no");
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `${API_URL}/api/reports/class?teacher_id=${teacher_id}&subject_id=${subjectId}`
      );
      const json = await res.json();
      if (json.success) setData(json);
    } catch (e) {
      console.log("CLASS REPORT ERROR:", e);
    } finally {
      setLoading(false);
    }
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  };

  const sortedStudents = () => {
    if (!data?.students) return [];
    return [...data.students].sort((a, b) => {
      let va: any, vb: any;
      if (sortKey === "roll_no") { va = a.roll_no || ""; vb = b.roll_no || ""; }
      else if (sortKey === "name") { va = a.name || ""; vb = b.name || ""; }
      else if (sortKey === "attendance") { va = a.attendance_pct ?? -1; vb = b.attendance_pct ?? -1; }
      else if (sortKey === "quiz") { va = a.quiz_avg_pct ?? -1; vb = b.quiz_avg_pct ?? -1; }
      else { va = a.assignment_avg_marks ?? -1; vb = b.assignment_avg_marks ?? -1; }

      if (typeof va === "string") return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? va - vb : vb - va;
    });
  };

  const getAttColor = (pct: number | null) => {
    if (pct === null) return GREY;
    if (pct >= 75) return GREEN;
    if (pct >= 60) return AMBER;
    return RED;
  };

  const tabs: { key: TabKey; label: string; icon: string }[] = [
    { key: "overview",    label: "Overview",    icon: "grid-outline" },
    { key: "attendance",  label: "Attendance",  icon: "calendar-outline" },
    { key: "quiz",        label: "Quizzes",     icon: "help-circle-outline" },
    { key: "assignment",  label: "Assignments", icon: "document-text-outline" },
  ];

  if (loading) {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
          <Text style={S.loadingText}>Loading class report…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!data) {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}>
          <Ionicons name="warning-outline" size={48} color={GREY} />
          <Text style={S.loadingText}>Could not load report</Text>
          <TouchableOpacity style={S.retryBtn} onPress={fetchData}>
            <Text style={S.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const { class_summary, students } = data;

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) return <Ionicons name="swap-vertical-outline" size={12} color={GREY} />;
    return <Ionicons name={sortAsc ? "arrow-up" : "arrow-down"} size={12} color={PRIMARY} />;
  };

  return (
    <SafeAreaView style={S.safe}>
      {/* HEADER */}
      <View style={S.header}>
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={DARK} />
        </TouchableOpacity>
        <View style={S.headerText}>
          <Text style={S.title} numberOfLines={1}>{subject?.subject_name}</Text>
          <Text style={S.subtitle}>{subject?.subject_code} · {class_summary.total_students} Students</Text>
        </View>
      </View>

      {/* TAB BAR */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={S.tabScroll}
        contentContainerStyle={S.tabBar}
      >
        {tabs.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[S.tab, activeTab === t.key && S.tabActive]}
            onPress={() => setActiveTab(t.key)}
          >
            <Ionicons name={t.icon as any} size={14} color={activeTab === t.key ? PRIMARY : GREY} />
            <Text style={[S.tabText, activeTab === t.key && S.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={S.scroll}>

        {/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}
        {activeTab === "overview" && (
          <View style={S.section}>
            {/* Summary cards */}
            <View style={S.statsGrid}>
              <View style={[S.statCard, { backgroundColor: PRIMARY_SOFT }]}>
                <Ionicons name="people" size={20} color={PRIMARY} />
                <Text style={[S.statNum, { color: PRIMARY }]}>{class_summary.total_students}</Text>
                <Text style={[S.statLabel, { color: PRIMARY }]}>Students</Text>
              </View>
              <View style={[S.statCard, { backgroundColor: "#F0FDF4" }]}>
                <Ionicons name="calendar-outline" size={20} color={GREEN} />
                <Text style={[S.statNum, { color: GREEN }]}>
                  {class_summary.avg_attendance_pct != null ? `${class_summary.avg_attendance_pct}%` : "—"}
                </Text>
                <Text style={[S.statLabel, { color: GREEN }]}>Avg Attendance</Text>
              </View>
              <View style={[S.statCard, { backgroundColor: "#FEF3C7" }]}>
                <Ionicons name="help-circle-outline" size={20} color={AMBER} />
                <Text style={[S.statNum, { color: AMBER }]}>
                  {class_summary.avg_quiz_pct != null ? `${class_summary.avg_quiz_pct}%` : "—"}
                </Text>
                <Text style={[S.statLabel, { color: AMBER }]}>Avg Quiz Score</Text>
              </View>
              <View style={[S.statCard, { backgroundColor: "#FEF2F2" }]}>
                <Ionicons name="document-text-outline" size={20} color={RED} />
                <Text style={[S.statNum, { color: RED }]}>
                  {class_summary.avg_assignment_marks != null ? class_summary.avg_assignment_marks : "—"}
                </Text>
                <Text style={[S.statLabel, { color: RED }]}>Avg Assignment</Text>
              </View>
            </View>

            {/* At-risk students */}
            {class_summary.below_75_attendance > 0 && (
              <View style={S.alertBox}>
                <Ionicons name="alert-circle" size={18} color={RED} />
                <Text style={S.alertText}>
                  {class_summary.below_75_attendance} student{class_summary.below_75_attendance > 1 ? "s" : ""} below 75% attendance
                </Text>
              </View>
            )}

            {/* Student list overview */}
            <Text style={S.sectionTitle}>All Students</Text>
            <View style={S.sortRow}>
              {(["roll_no", "name", "attendance"] as SortKey[]).map((k) => (
                <TouchableOpacity key={k} style={S.sortChip} onPress={() => toggleSort(k)}>
                  <Text style={[S.sortChipText, sortKey === k && { color: PRIMARY }]}>
                    {k === "roll_no" ? "Roll" : k === "name" ? "Name" : "Att%"}
                  </Text>
                  {renderSortIcon(k)}
                </TouchableOpacity>
              ))}
            </View>

            {sortedStudents().map((s: any) => (
              <TouchableOpacity
                key={s.uid}
                style={S.studentRow}
                onPress={() =>
                  navigation.navigate("StudentReportDetail", {
                    student: s,
                    subject,
                    teacher_id,
                  })
                }
                activeOpacity={0.8}
              >
                <View style={S.studentLeft}>
                  <View style={S.avatar}>
                    <Text style={S.avatarText}>{(s.name || "?")[0].toUpperCase()}</Text>
                  </View>
                  <View>
                    <Text style={S.studentName}>{s.name}</Text>
                    <Text style={S.studentMeta}>Roll: {s.roll_no || "—"}</Text>
                  </View>
                </View>
                <View style={S.studentRight}>
                  <View style={[S.attPill, { backgroundColor: getAttColor(s.attendance_pct) + "18" }]}>
                    <Text style={[S.attPillText, { color: getAttColor(s.attendance_pct) }]}>
                      {s.attendance_pct != null ? `${s.attendance_pct}%` : "—"}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={GREY} />
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* ── ATTENDANCE TAB ───────────────────────────────────────────── */}
        {activeTab === "attendance" && (
          <View style={S.section}>
            <View style={S.statsRow}>
              <View style={[S.miniStat, { backgroundColor: "#F0FDF4" }]}>
                <Text style={[S.miniNum, { color: GREEN }]}>
                  {class_summary.avg_attendance_pct != null ? `${class_summary.avg_attendance_pct}%` : "—"}
                </Text>
                <Text style={[S.miniLabel, { color: GREEN }]}>Class Average</Text>
              </View>
              <View style={[S.miniStat, { backgroundColor: "#FEF2F2" }]}>
                <Text style={[S.miniNum, { color: RED }]}>{class_summary.below_75_attendance}</Text>
                <Text style={[S.miniLabel, { color: RED }]}>Below 75%</Text>
              </View>
              <View style={[S.miniStat, { backgroundColor: PRIMARY_SOFT }]}>
                <Text style={[S.miniNum, { color: PRIMARY }]}>{class_summary.total_lectures}</Text>
                <Text style={[S.miniLabel, { color: PRIMARY }]}>Total Classes</Text>
              </View>
            </View>

            <Text style={S.sectionTitle}>Attendance by Student</Text>
            <View style={S.sortRow}>
              {(["roll_no", "name", "attendance"] as SortKey[]).map((k) => (
                <TouchableOpacity key={k} style={S.sortChip} onPress={() => toggleSort(k)}>
                  <Text style={[S.sortChipText, sortKey === k && { color: PRIMARY }]}>
                    {k === "roll_no" ? "Roll" : k === "name" ? "Name" : "Att%"}
                  </Text>
                  {renderSortIcon(k)}
                </TouchableOpacity>
              ))}
            </View>

            {sortedStudents().map((s: any) => {
              const color = getAttColor(s.attendance_pct);
              const pct = s.attendance_pct ?? 0;
              return (
                <View key={s.uid} style={S.attCard}>
                  <View style={S.attCardTop}>
                    <View style={S.studentLeft}>
                      <View style={S.avatar}>
                        <Text style={S.avatarText}>{(s.name || "?")[0].toUpperCase()}</Text>
                      </View>
                      <View>
                        <Text style={S.studentName}>{s.name}</Text>
                        <Text style={S.studentMeta}>Roll: {s.roll_no || "—"}</Text>
                      </View>
                    </View>
                    <Text style={[S.bigPct, { color }]}>
                      {s.attendance_pct != null ? `${s.attendance_pct}%` : "—"}
                    </Text>
                  </View>
                  <View style={S.progressTrack}>
                    <View style={[S.progressFill, { width: `${Math.min(pct, 100)}%`, backgroundColor: color }]} />
                  </View>
                  <View style={S.attStatsRow}>
                    <Text style={S.attStat}><Text style={{ color: GREEN, fontWeight: "700" }}>{s.present}</Text> Present</Text>
                    <Text style={S.attStat}><Text style={{ color: RED, fontWeight: "700" }}>{s.absent}</Text> Absent</Text>
                    <Text style={S.attStat}><Text style={{ color: AMBER, fontWeight: "700" }}>{s.late ?? 0}</Text> Late</Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* ── QUIZ TAB ─────────────────────────────────────────────────── */}
        {activeTab === "quiz" && (
          <View style={S.section}>
            <View style={S.statsRow}>
              <View style={[S.miniStat, { backgroundColor: "#FEF3C7" }]}>
                <Text style={[S.miniNum, { color: AMBER }]}>
                  {class_summary.avg_quiz_pct != null ? `${class_summary.avg_quiz_pct}%` : "—"}
                </Text>
                <Text style={[S.miniLabel, { color: AMBER }]}>Class Average</Text>
              </View>
              <View style={[S.miniStat, { backgroundColor: PRIMARY_SOFT }]}>
                <Text style={[S.miniNum, { color: PRIMARY }]}>{class_summary.total_quizzes}</Text>
                <Text style={[S.miniLabel, { color: PRIMARY }]}>Total Quizzes</Text>
              </View>
            </View>

            <Text style={S.sectionTitle}>Quiz Performance</Text>
            <View style={S.sortRow}>
              {(["roll_no", "name", "quiz"] as SortKey[]).map((k) => (
                <TouchableOpacity key={k} style={S.sortChip} onPress={() => toggleSort(k)}>
                  <Text style={[S.sortChipText, sortKey === k && { color: PRIMARY }]}>
                    {k === "roll_no" ? "Roll" : k === "name" ? "Name" : "Score%"}
                  </Text>
                  {renderSortIcon(k)}
                </TouchableOpacity>
              ))}
            </View>

            {sortedStudents().map((s: any) => (
              <View key={s.uid} style={S.attCard}>
                <View style={S.attCardTop}>
                  <View style={S.studentLeft}>
                    <View style={S.avatar}>
                      <Text style={S.avatarText}>{(s.name || "?")[0].toUpperCase()}</Text>
                    </View>
                    <View>
                      <Text style={S.studentName}>{s.name}</Text>
                      <Text style={S.studentMeta}>
                        {s.quiz_attempted}/{class_summary.total_quizzes} attempted
                      </Text>
                    </View>
                  </View>
                  <Text style={[S.bigPct, { color: s.quiz_avg_pct != null && s.quiz_avg_pct >= 60 ? GREEN : RED }]}>
                    {s.quiz_avg_pct != null ? `${s.quiz_avg_pct}%` : "—"}
                  </Text>
                </View>
                {s.quiz_avg_pct != null && (
                  <View style={S.progressTrack}>
                    <View
                      style={[
                        S.progressFill,
                        { width: `${Math.min(s.quiz_avg_pct, 100)}%`, backgroundColor: s.quiz_avg_pct >= 60 ? GREEN : RED },
                      ]}
                    />
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {/* ── ASSIGNMENT TAB ───────────────────────────────────────────── */}
        {activeTab === "assignment" && (
          <View style={S.section}>
            <View style={S.statsRow}>
              <View style={[S.miniStat, { backgroundColor: "#FEF2F2" }]}>
                <Text style={[S.miniNum, { color: RED }]}>
                  {class_summary.avg_assignment_marks != null ? class_summary.avg_assignment_marks : "—"}
                </Text>
                <Text style={[S.miniLabel, { color: RED }]}>Avg Marks</Text>
              </View>
              <View style={[S.miniStat, { backgroundColor: PRIMARY_SOFT }]}>
                <Text style={[S.miniNum, { color: PRIMARY }]}>{class_summary.total_assignments}</Text>
                <Text style={[S.miniLabel, { color: PRIMARY }]}>Total Assignments</Text>
              </View>
            </View>

            <Text style={S.sectionTitle}>Assignment Performance</Text>
            <View style={S.sortRow}>
              {(["roll_no", "name", "assignment"] as SortKey[]).map((k) => (
                <TouchableOpacity key={k} style={S.sortChip} onPress={() => toggleSort(k)}>
                  <Text style={[S.sortChipText, sortKey === k && { color: PRIMARY }]}>
                    {k === "roll_no" ? "Roll" : k === "name" ? "Name" : "Avg Marks"}
                  </Text>
                  {renderSortIcon(k)}
                </TouchableOpacity>
              ))}
            </View>

            {sortedStudents().map((s: any) => (
              <View key={s.uid} style={S.attCard}>
                <View style={S.attCardTop}>
                  <View style={S.studentLeft}>
                    <View style={S.avatar}>
                      <Text style={S.avatarText}>{(s.name || "?")[0].toUpperCase()}</Text>
                    </View>
                    <View>
                      <Text style={S.studentName}>{s.name}</Text>
                      <Text style={S.studentMeta}>
                        {s.assignment_submitted}/{class_summary.total_assignments} submitted
                      </Text>
                    </View>
                  </View>
                  <Text style={[S.bigPct, { color: DARK }]}>
                    {s.assignment_avg_marks != null ? s.assignment_avg_marks : "—"}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  loadingText: { fontSize: 14, color: GREY },
  retryBtn: { backgroundColor: PRIMARY, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20 },
  retryText: { color: WHITE, fontWeight: "700" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: WHITE,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    gap: 12,
  },
  backBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: BG, justifyContent: "center", alignItems: "center" },
  headerText: { flex: 1 },
  title: { fontSize: 18, fontWeight: "800", color: DARK },
  subtitle: { fontSize: 12, color: GREY, marginTop: 2 },

  tabScroll: { backgroundColor: WHITE, borderBottomWidth: 1, borderBottomColor: BORDER },
  tabBar: { flexDirection: "row", paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  tab: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: BG },
  tabActive: { backgroundColor: PRIMARY_SOFT },
  tabText: { fontSize: 13, fontWeight: "600", color: GREY },
  tabTextActive: { color: PRIMARY },

  scroll: { paddingHorizontal: 16, paddingTop: 16 },
  section: { gap: 12 },

  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statCard: {
    width: "47.5%",
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    gap: 6,
  },
  statNum: { fontSize: 22, fontWeight: "800" },
  statLabel: { fontSize: 11, fontWeight: "600" },

  statsRow: { flexDirection: "row", gap: 10 },
  miniStat: { flex: 1, borderRadius: 14, padding: 14, alignItems: "center" },
  miniNum: { fontSize: 20, fontWeight: "800" },
  miniLabel: { fontSize: 10, fontWeight: "600", marginTop: 2 },

  alertBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FEF2F2",
    borderRadius: 12,
    padding: 12,
  },
  alertText: { fontSize: 13, color: RED, fontWeight: "600", flex: 1 },

  sectionTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: GREY,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 4,
  },

  sortRow: { flexDirection: "row", gap: 8, marginBottom: 4 },
  sortChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: WHITE,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: BORDER,
  },
  sortChipText: { fontSize: 12, fontWeight: "600", color: GREY },

  studentRow: {
    backgroundColor: WHITE,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: BORDER,
  },
  studentLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  studentRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: PRIMARY_SOFT,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: { fontSize: 16, fontWeight: "800", color: PRIMARY },
  studentName: { fontSize: 14, fontWeight: "700", color: DARK },
  studentMeta: { fontSize: 12, color: GREY, marginTop: 2 },
  attPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  attPillText: { fontSize: 12, fontWeight: "700" },

  attCard: {
    backgroundColor: WHITE,
    borderRadius: 16,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: BORDER,
  },
  attCardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  bigPct: { fontSize: 20, fontWeight: "800" },
  progressTrack: { height: 6, backgroundColor: "#E5E7EB", borderRadius: 3, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 3 },
  attStatsRow: { flexDirection: "row", gap: 16 },
  attStat: { fontSize: 12, color: GREY },
});