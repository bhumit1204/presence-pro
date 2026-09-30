import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, RefreshControl, Alert, AppState, AppStateStatus,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import { auth } from "../../../services/firebase";
import {
  PRIMARY, PRIMARY_LIGHT, BG, GREEN, GREEN_LIGHT,
  AMBER, AMBER_LIGHT, GREY, RED, RED_LIGHT,
  API_URL, StudentQuiz, fmtDate, isJoinCodeExpired,
} from "../../quiz/student/components/studentQuizConstants";
import { QuizCardSkeleton } from "../../quiz/student/components/QuizSkeleton";
import { Ionicons } from "@expo/vector-icons";

// ─── Constants ────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 8_000; // 8 seconds

// ─── Tab config ───────────────────────────────────────────────────────────────
const TABS = [
  { key: "live",      label: "Live",      color: GREEN, bg: GREEN_LIGHT },
  { key: "scheduled", label: "Scheduled", color: AMBER, bg: AMBER_LIGHT },
  { key: "completed", label: "Completed", color: GREY,  bg: "#F3F4F6"  },
] as const;

type TabKey = "live" | "scheduled" | "completed";

// ─── Quiz card ────────────────────────────────────────────────────────────────
function QuizCard({
  quiz, tab, onPress,
}: {
  quiz: StudentQuiz; tab: TabKey; onPress: () => void;
}) {
  const tabInfo   = TABS.find((t) => t.key === tab)!;
  const isOpen    = !quiz.join_code;
  const codeExpired = tab === "live" && isJoinCodeExpired(quiz);

  return (
    <TouchableOpacity style={S.card} onPress={onPress} activeOpacity={0.82}>

      {/* Top row */}
      <View style={S.cardTop}>
        <Text style={S.cardTitle} numberOfLines={1}>{quiz.title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {isOpen && tab === "live" && (
            <View style={S.openBadge}>
              <Text style={S.openBadgeText}>🔓 Open</Text>
            </View>
          )}
          {codeExpired && (
            <View style={S.expiredBadge}>
              <Text style={S.expiredBadgeText}>Code expired</Text>
            </View>
          )}
          <View style={[S.statusBadge, { backgroundColor: tabInfo.bg }]}>
            <Text style={[S.statusText, { color: tabInfo.color }]}>
              {tab === "live" ? "LIVE" : tab === "scheduled" ? "Scheduled" : "Done"}
            </Text>
          </View>
        </View>
      </View>

      {/* Subject */}
      <Text style={S.cardSubject}>{quiz.subject_name}</Text>

      {/* Info row */}
      <View style={S.cardInfo}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Ionicons name="list-outline" size={12} color="#374151" />
          <Text style={S.cardInfoItem}>{quiz.question_count}Q</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Ionicons name="ribbon-outline" size={12} color="#374151" />
          <Text style={S.cardInfoItem}>{quiz.total_marks} marks</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Ionicons name="time-outline" size={12} color="#374151" />
          <Text style={S.cardInfoItem}>{quiz.time_limit_minutes}m</Text>
        </View>
        {tab === "live" && !isOpen && quiz.join_code_expiry_at && !codeExpired && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            <Ionicons name="key-outline" size={12} color="#92400E" />
            <Text style={[S.cardInfoItem, { color: "#92400E" }]}>
              expires {new Date(quiz.join_code_expiry_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </Text>
          </View>
        )}
      </View>

      {/* Date row */}
      <View style={S.cardDateRow}>
        {tab === "live" ? (
          <>
            <Text style={S.cardDateItem}>Started: {fmtDate(quiz.scheduled_start)}</Text>
            <Text style={S.cardDateItem}>Ends: {fmtDate(quiz.scheduled_end)}</Text>
          </>
        ) : tab === "scheduled" ? (
          <>
            <Text style={S.cardDateItem}>Starts: {fmtDate(quiz.scheduled_start)}</Text>
            <Text style={S.cardDateItem}>Ends: {fmtDate(quiz.scheduled_end)}</Text>
          </>
        ) : (
          <Text style={S.cardDateItem}>
            {fmtDate(quiz.scheduled_start)} – {fmtDate(quiz.scheduled_end)}
          </Text>
        )}
      </View>

      {/* Bottom row */}
      <View style={S.cardBottom}>
        {tab === "completed" && quiz.submission ? (
          <View style={S.completedBottom}>
            <View style={S.scoreRow}>
              <Text style={S.scoreText}>
                Score: {quiz.submission.marks_obtained}/{quiz.total_marks}
              </Text>
              <View style={[S.pctBadge, { backgroundColor: quiz.submission.percentage >= 50 ? GREEN_LIGHT : RED_LIGHT }]}>
                <Text style={[S.pctText, { color: quiz.submission.percentage >= 50 ? GREEN : RED }]}>
                  {quiz.submission.percentage.toFixed(1)}%
                </Text>
              </View>
            </View>
            {quiz.submission.submitted_at && (
              <Text style={S.submittedAtText}>Submitted: {fmtDate(quiz.submission.submitted_at)}</Text>
            )}
          </View>
        ) : tab === "completed" && !quiz.submission ? (
          <View style={[S.pctBadge, { backgroundColor: "#FEF2F2", borderWidth: 1, borderColor: "#FECACA" }]}>
            <Text style={[S.pctText, { color: RED }]}>Missed</Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ tab }: { tab: TabKey }) {
  const MAP = {
    live:      { icon: "radio-outline" as const,    msg: "No live quizzes right now" },
    scheduled: { icon: "calendar-outline" as const, msg: "No upcoming quizzes"       },
    completed: { icon: "checkbox-outline" as const, msg: "No completed quizzes yet"  },
  };
  const { icon, msg } = MAP[tab];
  return (
    <View style={S.empty}>
      <Ionicons name={icon} size={44} color={GREY} style={{ marginBottom: 12 }} />
      <Text style={S.emptyText}>{msg}</Text>
    </View>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function StudentQuizzes() {
  const navigation = useNavigation<any>();
  const [activeTab, setActiveTab] = useState<TabKey>("live");
  const [quizzes, setQuizzes] = useState<{
    live: StudentQuiz[]; scheduled: StudentQuiz[]; completed: StudentQuiz[];
  }>({ live: [], scheduled: [], completed: [] });
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  // Track previous live count so we can auto-switch tabs when a quiz goes live
  const prevLiveCountRef = useRef(0);
  // Track whether the screen is currently focused
  const isFocusedRef = useRef(false);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchQuizzes = useCallback(async (silent = false) => {
    try {
      if (!silent) { setLoading(true); setError(null); }

      const uid = auth.currentUser?.uid;
      if (!uid) { setError("User not authenticated"); setLoading(false); setRefreshing(false); return; }

      const res = await fetch(`${API_URL}/api/quizzes/student-quizzes/${uid}`);
      if (!res.ok) { setError(`API returned status ${res.status}`); setLoading(false); setRefreshing(false); return; }

      const data = await res.json();
      if (!data.success) { setError(data.error || "API returned success: false"); setLoading(false); setRefreshing(false); return; }

      const validateQuiz = (q: any): q is StudentQuiz =>
        !!(q.quiz_id && q.title && q.subject_name && q.scheduled_start && q.scheduled_end);

      const newLive      = (Array.isArray(data.live)      ? data.live      : []).filter(validateQuiz) as StudentQuiz[];
      const newScheduled = (Array.isArray(data.scheduled) ? data.scheduled : []).filter(validateQuiz) as StudentQuiz[];
      const newCompleted = (Array.isArray(data.completed) ? data.completed : []).filter(validateQuiz) as StudentQuiz[];

      setQuizzes({ live: newLive, scheduled: newScheduled, completed: newCompleted });
      setError(null);

      // Auto-switch to Live tab if a quiz just went live (only when screen is focused)
      if (silent && isFocusedRef.current && newLive.length > prevLiveCountRef.current) {
        setActiveTab("live");
      }
      prevLiveCountRef.current = newLive.length;

    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // ── Focus: initial load + mark screen focused ──────────────────────────────
  useFocusEffect(useCallback(() => {
    isFocusedRef.current = true;
    fetchQuizzes();
    return () => { isFocusedRef.current = false; };
  }, [fetchQuizzes]));

  // ── Poll every 30s while screen is focused ─────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      if (isFocusedRef.current) fetchQuizzes(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchQuizzes]);

  // ── Re-fetch when app comes back from background ───────────────────────────
  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === "active" && isFocusedRef.current) {
        fetchQuizzes(true);
      }
    };
    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, [fetchQuizzes]);

  // ── Card press ─────────────────────────────────────────────────────────────
  const handleCardPress = (quiz: StudentQuiz, tab: TabKey) => {
    if (tab === "live") {
      if (quiz.join_code && isJoinCodeExpired(quiz)) {
        Alert.alert(
          "Code Expired",
          "The join code for this quiz has expired. Please ask your teacher to share the updated code.",
          [{ text: "OK" }]
        );
        return;
      }
      navigation.navigate("StudentJoinQuiz", { quiz });
    } else if (tab === "scheduled") {
      navigation.navigate("StudentScheduledQuiz", { quiz });
    } else {
      navigation.navigate("StudentQuizResult", {
        quiz_id:    quiz.quiz_id,
        quiz_title: quiz.title,
      });
    }
  };

  const currentList = quizzes[activeTab];

  return (
    <SafeAreaView style={S.safe}>
      {/* Header */}
      <View style={S.header}>
        <Text style={S.title}>Quizzes</Text>
        <Text style={S.subtitle}>Your tests & assessments</Text>
      </View>

      {/* Tab bar */}
      <View style={S.tabBar}>
        {TABS.map((tab) => {
          const count  = quizzes[tab.key].length;
          const active = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[S.tab, active && { borderBottomColor: tab.color, borderBottomWidth: 2.5 }]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Text style={[S.tabText, active && { color: tab.color, fontWeight: "800" }]}>
                {tab.label}
              </Text>
              {count > 0 && (
                <View style={[S.tabBadge, { backgroundColor: tab.bg }]}>
                  <Text style={[S.tabBadgeText, { color: tab.color }]}>{count}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* List */}
      <ScrollView
        contentContainerStyle={S.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchQuizzes(true); }}
            colors={[PRIMARY]}
          />
        }
      >
        {loading ? (
          [1, 2, 3].map((i) => <QuizCardSkeleton key={i} />)
        ) : currentList.length === 0 ? (
          <EmptyState tab={activeTab} />
        ) : (
          currentList.map((q) => (
            <QuizCard
              key={q.quiz_id}
              quiz={q}
              tab={activeTab}
              onPress={() => handleCardPress(q, activeTab)}
            />
          ))
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: BG },
  header:   { paddingHorizontal: 20, paddingTop: 16, marginBottom: 4 },
  title:    { fontSize: 28, fontWeight: "800", color: "#111827" },
  subtitle: { fontSize: 14, color: GREY, marginTop: 4 },

  tabBar:      { flexDirection: "row", paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: "#E5E7EB", marginBottom: 16 },
  tab:         { flex: 1, alignItems: "center", paddingVertical: 12, flexDirection: "row", justifyContent: "center", gap: 6 },
  tabText:     { fontSize: 14, fontWeight: "600", color: GREY },
  tabBadge:    { borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  tabBadgeText:{ fontSize: 11, fontWeight: "700" },

  list: { paddingHorizontal: 20 },

  card: {
    backgroundColor: "#FFF",
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  cardTop:     { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  cardTitle:   { fontSize: 16, fontWeight: "700", color: "#111827", flex: 1, marginRight: 8 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  statusText:  { fontSize: 11, fontWeight: "700" },

  openBadge:     { backgroundColor: "#D1FAE5", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  openBadgeText: { fontSize: 11, fontWeight: "700", color: "#065F46" },

  expiredBadge:     { backgroundColor: "#FEF2F2", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: "#FECACA" },
  expiredBadgeText: { fontSize: 11, fontWeight: "700", color: RED },

  cardSubject:  { fontSize: 13, color: GREY, marginBottom: 10 },
  cardInfo:     { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 10 },
  cardInfoItem: { fontSize: 12, color: "#374151", fontWeight: "600" },
  cardDateRow:  { gap: 2, marginBottom: 10 },
  cardDateItem: { fontSize: 12, color: GREY, fontWeight: "500" },

  cardBottom:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  completedBottom: { flex: 1, gap: 6 },
  scoreRow:        { flexDirection: "row", alignItems: "center", gap: 8 },
  scoreText:       { fontSize: 13, fontWeight: "700", color: "#111827" },
  submittedAtText: { fontSize: 11, color: GREY, fontStyle: "italic" },
  pctBadge:        { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  pctText:         { fontSize: 12, fontWeight: "700" },

  empty:     { alignItems: "center", paddingTop: 60 },
  emptyText: { fontSize: 15, color: GREY, fontWeight: "600" },
});