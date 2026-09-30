import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Animated,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import QuizReport from "./QuizReport";
import AssignmentReport from "./AssignmentReport";
import AttendanceReport from "./AttendanceReport";

// ─── Palette ─────────────────────────────────────────────────────────────────
const C = {
  navy:       "#FFFFFF",
  navyMid:    "#F0F2F8",
  navyLight:  "#E8EBF4",
  ink:        "#1C2333",
  inkSoft:    "#2E3A52",
  canvas:     "#F7F8FC",
  canvasCard: "#FFFFFF",
  muted:      "#8A94A6",
  mutedLight: "#6B7694",
  border:     "#E8EBF2",

  violet:     "#6C5CE7",
  violetSoft: "#EEF2FF",
  violetDim:  "rgba(108,92,231,0.15)",

  teal:       "#0DB4B9",
  tealSoft:   "#E6F9FA",

  amber:      "#F0A500",
  amberSoft:  "#FFF8E7",

  coral:      "#F05454",
  coralSoft:  "#FEECEC",

  jade:       "#00B37E",
  jadeSoft:   "#E6F9F4",
};

const { width: SCREEN_W } = Dimensions.get("window");

const API_URL = "http://10.132.90.56:5000";

type ReportTab = "overview" | "quiz" | "assignments" | "attendance";

// ─── Animated Number ─────────────────────────────────────────────────────────
function AnimatedNumber({ value, suffix = "" }: { value: number | null; suffix?: string }) {
  const anim = useRef(new Animated.Value(0)).current;
  const [display, setDisplay] = useState("—");

  useEffect(() => {
    if (value == null) return;
    anim.setValue(0);
    Animated.timing(anim, { toValue: value, duration: 900, useNativeDriver: false }).start();
    const id = anim.addListener(({ value: v }) => {
      setDisplay(Math.round(v) + suffix);
    });
    return () => anim.removeListener(id);
  }, [value]);

  return <Text style={{ fontVariant: ["tabular-nums"] }}>{display}</Text>;
}

// ─── Arc Progress Ring ────────────────────────────────────────────────────────
function RingGauge({
  pct,
  size = 80,
  stroke = 7,
  color,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  color: string;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: pct, duration: 900, useNativeDriver: false }).start();
  }, [pct]);

  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const center = size / 2;

  return (
    <View style={{ width: size, height: size }}>
      {/* track */}
      <View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: stroke,
          borderColor: color + "22",
        }}
      />
      {/* fill — approximated with a bordered view rotate trick */}
      {/* Using a simple progress arc via border trick */}
      <View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: stroke,
          borderColor: "transparent",
          borderTopColor: pct > 0 ? color : "transparent",
          borderRightColor: pct > 25 ? color : "transparent",
          borderBottomColor: pct > 50 ? color : "transparent",
          borderLeftColor: pct > 75 ? color : "transparent",
          transform: [{ rotate: "-90deg" }],
        }}
      />
    </View>
  );
}

// ─── Stat Pill ────────────────────────────────────────────────────────────────
function Pill({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <View style={[S.pill, { backgroundColor: bg }]}>
      <Text style={[S.pillText, { color }]}>{label}</Text>
    </View>
  );
}

// ─── Section Header ───────────────────────────────────────────────────────────
function SectionLabel({ children }: { children: string }) {
  return (
    <View style={S.sectionLabelRow}>
      <View style={S.sectionDot} />
      <Text style={S.sectionLabelText}>{children}</Text>
    </View>
  );
}

// ─── Overview Card ────────────────────────────────────────────────────────────
function OverviewCard({
  icon,
  label,
  accent,
  accentSoft,
  children,
  onPress,
}: {
  icon: string;
  label: string;
  accent: string;
  accentSoft: string;
  children: React.ReactNode;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const press = () => {
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.97, duration: 80, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 150, useNativeDriver: true }),
    ]).start(onPress);
  };

  return (
    <Animated.View style={[{ transform: [{ scale }] }]}>
      <TouchableOpacity activeOpacity={1} onPress={press} style={S.overviewCard}>
        {/* Left accent strip */}
        <View style={[S.cardStrip, { backgroundColor: accent }]} />

        <View style={S.cardBody}>
          {/* Label row */}
          <View style={S.cardLabelRow}>
            <View style={[S.cardIconWrap, { backgroundColor: accentSoft }]}>
              <Ionicons name={icon as any} size={15} color={accent} />
            </View>
            <Text style={S.cardLabel}>{label}</Text>
            <Ionicons name="chevron-forward" size={14} color={C.mutedLight} style={{ marginLeft: "auto" }} />
          </View>

          {children}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Inline mini bar ──────────────────────────────────────────────────────────
function MiniBar({ pct, color }: { pct: number; color: string }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: pct, duration: 800, useNativeDriver: false }).start();
  }, [pct]);
  const width = anim.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"] });
  return (
    <View style={S.miniBarTrack}>
      <Animated.View style={[S.miniBarFill, { width, backgroundColor: color }]} />
    </View>
  );
}

// ─── Main Screen ─────────────────────────────────────────────────────────────
export default function StudentReportDetail() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { student, subject, teacher_id } = route.params;

  const [activeTab, setActiveTab] = useState<ReportTab>("overview");
  const [fullReport, setFullReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const subjectId = (subject as any)?.subject_id || "";

  // Fade-in for content area
  const contentOpacity = useRef(new Animated.Value(0)).current;

  const fetchFullReport = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const res = await fetch(
        `${API_URL}/api/reports/student/${student.uid}/full?teacher_id=${teacher_id}&subject_id=${subjectId}`
      );
      const data = await res.json();
      if (data.success) {
        setFullReport(data);
        Animated.timing(contentOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
      }
    } catch (e) {
      console.log("FULL REPORT ERROR:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [student.uid, teacher_id, subjectId]);

  useEffect(() => { fetchFullReport(); }, [fetchFullReport]);

  // Tab switch fade
  const tabFade = useRef(new Animated.Value(1)).current;
  const switchTab = (tab: ReportTab) => {
    Animated.sequence([
      Animated.timing(tabFade, { toValue: 0, duration: 80, useNativeDriver: true }),
      Animated.timing(tabFade, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();
    setActiveTab(tab);
  };

  const TABS: { key: ReportTab; label: string; icon: string }[] = [
    { key: "overview",    label: "Overview",    icon: "grid-outline"          },
    { key: "quiz",        label: "Quizzes",     icon: "help-circle-outline"   },
    { key: "assignments", label: "Work",         icon: "document-text-outline" },
    { key: "attendance",  label: "Attendance",  icon: "calendar-outline"      },
  ];

  // ── Overview ────────────────────────────────────────────────────────────
  const renderOverview = () => {
    if (!fullReport) return null;
    const { quiz_summary: Q, assignment_summary: A, attendance_summary: AT } = fullReport;

    const attPct   = AT?.percentage ?? 0;
    const attColor = attPct >= 75 ? C.jade : attPct >= 50 ? C.amber : C.coral;

    const quizPct  = Q?.avg_percentage ?? 0;
    const quizAttemptedPct = Q?.total > 0 ? Math.round((Q.attempted / Q.total) * 100) : 0;

    const assSubmitPct = A?.total > 0 ? Math.round((A.submitted / A.total) * 100) : 0;

    return (
      <Animated.View style={{ opacity: contentOpacity, gap: 14 }}>

        {/* ── Top hero strip — attendance ─────────────────────────────── */}
        <View style={S.heroCard}>
          {/* Background mesh */}
          <View style={S.heroMesh} />
          <View style={S.heroMesh2} />

          <View style={S.heroContent}>
            <View style={{ flex: 1 }}>
              <Text style={S.heroEyebrow}>Overall Attendance</Text>
              <Text style={[S.heroNumber, { color: attColor }]}>
                {AT?.percentage != null ? `${AT.percentage}%` : "—"}
              </Text>
              <Text style={S.heroSub}>
                {AT?.present ?? 0} present · {AT?.absent ?? 0} absent · {AT?.total_lectures ?? 0} total
              </Text>
              <View style={{ marginTop: 12 }}>
                <MiniBar pct={attPct} color={attColor} />
              </View>
              <Text style={[S.heroStatus, { color: attColor }]}>
                {attPct >= 75 ? "✦ On Track" : attPct >= 50 ? "⚠ Needs Attention" : "✕ Critical"}
              </Text>
            </View>

            {/* Big donut */}
            <View style={S.heroRing}>
              <View style={[S.ringOuter, { borderColor: attColor + "30" }]}>
                <View style={[S.ringInner, { borderColor: attColor }]}>
                  <Text style={[S.ringText, { color: attColor }]}>
                    {AT?.percentage != null ? `${Math.round(AT.percentage)}` : "—"}
                  </Text>
                  <Text style={S.ringUnit}>%</Text>
                </View>
              </View>
            </View>
          </View>
        </View>

        <SectionLabel>Academic Performance</SectionLabel>

        {/* ── Quiz card ────────────────────────────────────────────────── */}
        <OverviewCard
          icon="help-circle-outline"
          label="Quizzes"
          accent={C.violet}
          accentSoft={C.violetSoft}
          onPress={() => switchTab("quiz")}
        >
          <View style={S.cardDataRow}>
            <View style={S.cardStat}>
              <Text style={[S.cardBigNum, { color: C.ink }]}>
                {Q?.attempted ?? 0}
                <Text style={S.cardBigDenom}>/{Q?.total ?? 0}</Text>
              </Text>
              <Text style={S.cardStatLabel}>Attempted</Text>
            </View>
            <View style={S.cardDivider} />
            <View style={S.cardStat}>
              <Text style={[S.cardBigNum, { color: quizPct >= 60 ? C.jade : C.coral }]}>
                {Q?.avg_percentage != null ? `${Q.avg_percentage}%` : "—"}
              </Text>
              <Text style={S.cardStatLabel}>Avg Score</Text>
            </View>
            <View style={S.cardDivider} />
            <View style={S.cardStat}>
              <Text style={[S.cardBigNum, { color: C.amber }]}>
                {Q?.skipped ?? 0}
              </Text>
              <Text style={S.cardStatLabel}>Missed</Text>
            </View>
          </View>

          <View style={{ marginTop: 10, gap: 4 }}>
            <View style={S.barLabelRow}>
              <Text style={S.barCaption}>Completion rate</Text>
              <Text style={[S.barCaption, { color: C.violet }]}>{quizAttemptedPct}%</Text>
            </View>
            <MiniBar pct={quizAttemptedPct} color={C.violet} />
          </View>
        </OverviewCard>

        {/* ── Assignment card ───────────────────────────────────────────── */}
        <OverviewCard
          icon="document-text-outline"
          label="Assignments"
          accent={C.teal}
          accentSoft={C.tealSoft}
          onPress={() => switchTab("assignments")}
        >
          <View style={S.cardDataRow}>
            <View style={S.cardStat}>
              <Text style={[S.cardBigNum, { color: C.ink }]}>
                {A?.submitted ?? 0}
                <Text style={S.cardBigDenom}>/{A?.total ?? 0}</Text>
              </Text>
              <Text style={S.cardStatLabel}>Submitted</Text>
            </View>
            <View style={S.cardDivider} />
            <View style={S.cardStat}>
              <Text style={[S.cardBigNum, { color: A?.avg_marks != null ? C.jade : C.muted }]}>
                {A?.avg_marks != null ? A.avg_marks : "—"}
              </Text>
              <Text style={S.cardStatLabel}>Avg Marks</Text>
            </View>
            <View style={S.cardDivider} />
            <View style={S.cardStat}>
              <Text style={[S.cardBigNum, { color: C.amber }]}>
                {A?.skipped ?? 0}
              </Text>
              <Text style={S.cardStatLabel}>Skipped</Text>
            </View>
          </View>

          <View style={{ marginTop: 10, gap: 4 }}>
            <View style={S.barLabelRow}>
              <Text style={S.barCaption}>Submission rate</Text>
              <Text style={[S.barCaption, { color: C.teal }]}>{assSubmitPct}%</Text>
            </View>
            <MiniBar pct={assSubmitPct} color={C.teal} />
          </View>
        </OverviewCard>

        {/* ── Quick pills row ───────────────────────────────────────────── */}
        <View style={S.pillsRow}>
          <Pill
            label={attPct >= 75 ? "Attendance ✓" : attPct >= 50 ? "Attendance ⚠" : "Attendance ✕"}
            color={attColor}
            bg={attColor + "15"}
          />
          <Pill
            label={quizPct >= 60 ? `Quiz avg ${quizPct}%` : "Quiz needs work"}
            color={quizPct >= 60 ? C.jade : C.coral}
            bg={(quizPct >= 60 ? C.jade : C.coral) + "15"}
          />
        </View>

      </Animated.View>
    );
  };

  // ────────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={S.safe} edges={["top"]}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={S.header}>
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={18} color={C.mutedLight} />
        </TouchableOpacity>

        <View style={S.headerCenter}>
          {/* Avatar initials */}
          <View style={S.avatarCircle}>
            <Text style={S.avatarText}>
              {(student.name || "?").split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase()}
            </Text>
          </View>
          <View>
            <Text style={S.headerName} numberOfLines={1}>{student.name}</Text>
            <Text style={S.headerMeta}>
              {subject?.subject_name}
              {student.roll_no ? ` · #${student.roll_no}` : ""}
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={S.exportBtn}
          onPress={() => navigation.navigate("ExportReport", { student, subject, teacher_id })}
        >
          <Ionicons name="share-outline" size={17} color={C.mutedLight} />
        </TouchableOpacity>
      </View>

      {/* ── Tab bar ────────────────────────────────────────────────────── */}
      <View style={S.tabBar}>
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[S.tabItem, active && S.tabItemActive]}
              onPress={() => switchTab(tab.key)}
            >
              <Ionicons
                name={tab.icon as any}
                size={15}
                color={active ? C.violet : C.muted}
              />
              <Text style={[S.tabLabel, active && S.tabLabelActive]}>
                {tab.label}
              </Text>
              {active && <View style={S.tabUnderline} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Content ────────────────────────────────────────────────────── */}
      {loading ? (
        <View style={S.center}>
          <ActivityIndicator size="large" color={C.violet} />
          <Text style={S.loadingText}>Loading report…</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={S.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); fetchFullReport(true); }}
              tintColor={C.violet}
            />
          }
        >
          <Animated.View style={{ opacity: tabFade }}>
            {activeTab === "overview"    && renderOverview()}
            {activeTab === "quiz"        && (
              <QuizReport studentUid={student.uid} subjectId={subjectId} teacherId={teacher_id} />
            )}
            {activeTab === "assignments" && (
              <AssignmentReport studentUid={student.uid} subjectId={subjectId} teacherId={teacher_id} />
            )}
            {activeTab === "attendance"  && (
              <AttendanceReport
                studentUid={student.uid}
                studentName={student.name}
                subjectId={subjectId}
                teacherId={teacher_id}
                isTeacher={true}
              />
            )}
          </Animated.View>
          <View style={{ height: 48 }} />
        </ScrollView>
      )}

    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: C.canvas },
  scroll:  { padding: 16, paddingTop: 20 },
  center:  { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  loadingText: { fontSize: 13, color: C.muted, fontWeight: "500" },

  // ── Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.navy,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: C.navyLight,
    justifyContent: "center",
    alignItems: "center",
  },
  headerCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  avatarCircle: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: C.violet,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: 0.5,
  },
  headerName: {
    fontSize: 15,
    fontWeight: "700",
    color: "#000",
    letterSpacing: 0.1,
  },
  headerMeta: {
    fontSize: 11,
    color: C.muted,
    marginTop: 1,
    fontWeight: "500",
  },
  exportBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: C.navyLight,
    justifyContent: "center",
    alignItems: "center",
  },

  // ── Tab bar
  tabBar: {
    flexDirection: "row",
    backgroundColor: C.navy,
    borderBottomWidth: 1,
    borderBottomColor: C.navyLight,
    paddingHorizontal: 4,
  },
  tabItem: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    paddingVertical: 10,
    gap: 3,
    position: "relative",
  },
  tabItemActive: {},
  tabLabel: {
    fontSize: 10,
    fontWeight: "600",
    color: C.muted,
    letterSpacing: 0.3,
  },
  tabLabelActive: { color: C.violet },
  tabUnderline: {
    position: "absolute",
    bottom: 0,
    left: 10,
    right: 10,
    height: 2,
    backgroundColor: C.violet,
    borderRadius: 2,
  },

  // ── Section label
  sectionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: -2,
  },
  sectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.violet,
  },
  sectionLabelText: {
    fontSize: 10,
    fontWeight: "800",
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },

  // ── Hero card (attendance)
  heroCard: {
    backgroundColor: C.ink,
    borderRadius: 24,
    padding: 22,
    overflow: "hidden",
    position: "relative",
  },
  heroMesh: {
    position: "absolute",
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: C.violet,
    opacity: 0.07,
    top: -60,
    right: -40,
  },
  heroMesh2: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: C.teal,
    opacity: 0.06,
    bottom: -30,
    left: -20,
  },
  heroContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  heroEyebrow: {
    fontSize: 10,
    fontWeight: "700",
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  heroNumber: {
    fontSize: 44,
    fontWeight: "800",
    letterSpacing: -1,
    lineHeight: 48,
  },
  heroSub: {
    fontSize: 12,
    color: C.muted,
    fontWeight: "500",
    marginTop: 4,
  },
  heroStatus: {
    fontSize: 12,
    fontWeight: "700",
    marginTop: 8,
    letterSpacing: 0.3,
  },
  heroRing: {
    alignItems: "center",
    justifyContent: "center",
  },
  ringOuter: {
    width: 82,
    height: 82,
    borderRadius: 41,
    borderWidth: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  ringInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 2,
    justifyContent: "center",
    alignItems: "center",
    flexDirection: "row",
    gap: 0,
  },
  ringText: {
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  ringUnit: {
    fontSize: 10,
    fontWeight: "700",
    color: C.muted,
    alignSelf: "flex-start",
    marginTop: 6,
  },

  // ── Overview card
  overviewCard: {
    backgroundColor: C.canvasCard,
    borderRadius: 18,
    flexDirection: "row",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: C.border,
    elevation: 1,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  cardStrip: {
    width: 4,
    alignSelf: "stretch",
  },
  cardBody: {
    flex: 1,
    padding: 16,
    gap: 2,
  },
  cardLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 14,
  },
  cardIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  cardLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: C.ink,
    letterSpacing: 0.1,
  },

  cardDataRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
  },
  cardStat: {
    flex: 1,
    alignItems: "center",
    gap: 3,
  },
  cardBigNum: {
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  cardBigDenom: {
    fontSize: 14,
    fontWeight: "600",
    color: C.muted,
  },
  cardStatLabel: {
    fontSize: 10,
    fontWeight: "600",
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cardDivider: {
    width: 1,
    height: 36,
    backgroundColor: C.border,
    marginHorizontal: 4,
  },

  // ── Mini bar
  miniBarTrack: {
    height: 5,
    backgroundColor: C.border,
    borderRadius: 3,
    overflow: "hidden",
  },
  miniBarFill: {
    height: "100%",
    borderRadius: 3,
  },
  barLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  barCaption: {
    fontSize: 11,
    color: C.muted,
    fontWeight: "600",
  },

  // ── Pills
  pillsRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  pillText: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
});