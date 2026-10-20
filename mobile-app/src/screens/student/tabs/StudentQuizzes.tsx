import { apiFetch } from "../../../services/api";
import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, RefreshControl, Alert, AppState, AppStateStatus,
} from "react-native";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import { auth } from "../../../services/firebase";
import { StudentQuiz, fmtDate, isJoinCodeExpired, API_URL } from "../../quiz/student/components/studentQuizConstants";
import { QuizCardSkeleton } from "../../quiz/student/components/QuizSkeleton";
import { Ionicons } from "@expo/vector-icons";
import { Card, Chip, EmptyState, ProgressBar, Screen, SP, T, Tone, font } from "../../../components/ui";

// ─── Constants ────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 8_000; // 8 seconds

// ─── Tab config ───────────────────────────────────────────────────────────────
const TABS: { key: "live" | "scheduled" | "completed"; label: string; tone: Tone }[] = [
  { key: "live",      label: "Live",      tone: "success" },
  { key: "scheduled", label: "Scheduled", tone: "warning" },
  { key: "completed", label: "Completed", tone: "neutral" },
];

type TabKey = "live" | "scheduled" | "completed";

function Meta({ icon, text, color = T.sub }: { icon: any; text: string; color?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Ionicons name={icon} size={13} color={color} />
      <Text style={{ fontSize: 12.5, fontWeight: "600", color }}>{text}</Text>
    </View>
  );
}

// ─── Quiz card ────────────────────────────────────────────────────────────────
function QuizCard({
  quiz, tab, onPress,
}: {
  quiz: StudentQuiz; tab: TabKey; onPress: () => void;
}) {
  const isOpen      = !quiz.join_code;
  const codeExpired = tab === "live" && isJoinCodeExpired(quiz);
  const accent      = tab === "live" ? T.success : tab === "scheduled" ? T.warning : T.line;

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.82}>
      <Card padded={false} style={S.card}>
        <View style={[S.accent, { backgroundColor: accent }]} />
        <View style={S.cardBody}>
          {/* Title + status */}
          <View style={S.cardTop}>
            <View style={{ flex: 1 }}>
              <Text style={font.h3} numberOfLines={1}>{quiz.title}</Text>
              <Text style={[font.small, { marginTop: 1 }]} numberOfLines={1}>{quiz.subject_name}</Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 4 }}>
              <Chip
                label={tab === "live" ? "Live" : tab === "scheduled" ? "Scheduled" : "Done"}
                tone={tab === "live" ? "success" : tab === "scheduled" ? "warning" : "neutral"}
              />
              {isOpen && tab === "live" && <Chip label="Open" icon="lock-open-outline" tone="info" />}
              {codeExpired && <Chip label="Code expired" tone="danger" />}
            </View>
          </View>

          {/* Info */}
          <View style={S.info}>
            <Meta icon="list-outline" text={`${quiz.question_count} questions`} />
            <Meta icon="ribbon-outline" text={`${quiz.total_marks} marks`} />
            <Meta icon="time-outline" text={`${quiz.time_limit_minutes} min`} />
            {tab === "live" && !isOpen && quiz.join_code_expiry_at && !codeExpired && (
              <Meta
                icon="key-outline"
                color={T.warning}
                text={`expires ${new Date(quiz.join_code_expiry_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
              />
            )}
          </View>

          {/* Dates */}
          <View style={S.dates}>
            {tab === "live" ? (
              <>
                <Text style={font.small}>Started {fmtDate(quiz.scheduled_start)}</Text>
                <Text style={font.small}>Ends {fmtDate(quiz.scheduled_end)}</Text>
              </>
            ) : tab === "scheduled" ? (
              <>
                <Text style={font.small}>Starts {fmtDate(quiz.scheduled_start)}</Text>
                <Text style={font.small}>Ends {fmtDate(quiz.scheduled_end)}</Text>
              </>
            ) : (
              <Text style={font.small}>
                {fmtDate(quiz.scheduled_start)} - {fmtDate(quiz.scheduled_end)}
              </Text>
            )}
          </View>

          {/* Result */}
          {tab === "completed" && quiz.submission ? (
            <View style={S.result}>
              <View style={S.scoreRow}>
                <Text style={font.h3}>
                  {quiz.submission.marks_obtained}/{quiz.total_marks}
                </Text>
                <Chip
                  label={`${quiz.submission.percentage.toFixed(1)}%`}
                  tone={quiz.submission.percentage >= 50 ? "success" : "danger"}
                />
              </View>
              <ProgressBar
                value={quiz.submission.percentage / 100}
                tone={quiz.submission.percentage >= 50 ? "success" : "danger"}
              />
              {quiz.submission.submitted_at && (
                <Text style={font.small}>Submitted {fmtDate(quiz.submission.submitted_at)}</Text>
              )}
            </View>
          ) : tab === "completed" && !quiz.submission ? (
            <View style={{ marginTop: SP.sm, alignSelf: "flex-start" }}>
              <Chip label="Missed" icon="close-circle-outline" tone="danger" />
            </View>
          ) : null}
        </View>
      </Card>
    </TouchableOpacity>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function Empty({ tab }: { tab: TabKey }) {
  const MAP = {
    live:      { icon: "radio-outline" as const,    msg: "No live quizzes right now" },
    scheduled: { icon: "calendar-outline" as const, msg: "No upcoming quizzes"       },
    completed: { icon: "checkbox-outline" as const, msg: "No completed quizzes yet"  },
  };
  const { icon, msg } = MAP[tab];
  return <EmptyState icon={icon} title={msg} />;
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

      const res = await apiFetch(`${API_URL}/api/quizzes/student-quizzes/${uid}`);
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
    <Screen edges={["top"]}>
      {/* Header */}
      <View style={S.header}>
        <Text style={font.display}>Quizzes</Text>
        <Text style={[font.body, { marginTop: 2 }]}>Your tests and assessments</Text>
      </View>

      {/* Tab bar */}
      <View style={S.tabBar}>
        {TABS.map((tab) => {
          const count  = quizzes[tab.key].length;
          const active = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[S.tab, active && S.tabOn]}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.8}
            >
              <Text style={[S.tabText, active && { color: T.primary }]}>{tab.label}</Text>
              {count > 0 && (
                <View style={[S.tabBadge, { backgroundColor: active ? T.primary : T.line }]}>
                  <Text style={[S.tabBadgeText, { color: active ? "#FFF" : T.sub }]}>{count}</Text>
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
            colors={[T.primary]}
          />
        }
      >
        {loading ? (
          [1, 2, 3].map((i) => <QuizCardSkeleton key={i} />)
        ) : error && currentList.length === 0 ? (
          <EmptyState icon="cloud-offline-outline" title="Couldn't load quizzes" text={error} />
        ) : currentList.length === 0 ? (
          <Empty tab={activeTab} />
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
        <View style={{ height: 120 }} />
      </ScrollView>
    </Screen>
  );
}

const S = StyleSheet.create({
  header: { paddingHorizontal: SP.xl, paddingTop: SP.lg, marginBottom: SP.md },

  tabBar: {
    flexDirection: "row", marginHorizontal: SP.xl, marginBottom: SP.lg, padding: 4,
    backgroundColor: T.lineSoft, borderRadius: 14, gap: 4,
  },
  tab: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, paddingVertical: 10, borderRadius: 11,
  },
  tabOn:        { backgroundColor: T.surface, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  tabText:      { fontSize: 13.5, fontWeight: "700", color: T.sub },
  tabBadge:     { borderRadius: 10, minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, alignItems: "center" },
  tabBadgeText: { fontSize: 11, fontWeight: "800" },

  list: { paddingHorizontal: SP.xl },

  card:     { flexDirection: "row", overflow: "hidden", marginBottom: SP.md },
  accent:   { width: 4 },
  cardBody: { flex: 1, padding: SP.lg, gap: SP.sm },
  cardTop:  { flexDirection: "row", alignItems: "flex-start", gap: SP.sm },
  info:     { flexDirection: "row", flexWrap: "wrap", gap: SP.md },
  dates:    { gap: 1 },
  result:   { gap: 6, marginTop: 2, paddingTop: SP.sm, borderTopWidth: 1, borderTopColor: T.lineSoft },
  scoreRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});