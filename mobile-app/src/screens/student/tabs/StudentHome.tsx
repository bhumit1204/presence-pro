import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  AppState,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import AttendanceCard from "../../../components/AttendanceCard";
import { getUserSession } from "../../../services/session";
import {
  collection,
  doc,
  onSnapshot,
  getDoc,
  query,
  where,
  limit,
} from "firebase/firestore";
import { db, auth } from "../../../services/firebase";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import Ionicons from "@expo/vector-icons/build/Ionicons";

// ─── Theme ────────────────────────────────────────────────────────────────────
const PRIMARY       = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG            = "#F3F4F6";
const GREEN         = "#10B981";
const GREEN_LIGHT   = "#D1FAE5";
const AMBER         = "#F59E0B";
const AMBER_LIGHT   = "#FEF3C7";
const RED           = "#EF4444";
const RED_LIGHT     = "#FEF2F2";
const GREY          = "#6B7280";
const API_URL       = "http://10.132.90.56:5000";

// ─── Types ────────────────────────────────────────────────────────────────────
interface LectureData {
  id?: string;
  student_id?: string;
  aishe_code?: string;
  course_id?: string;
  subject_name: string;
  room: string;
  start_time: string;
  end_time: string;
  day?: string;
}

type TodoFilter = "thisWeek" | "nextWeek" | "thisMonth";

interface TodoItem {
  id: string;
  type: "assignment" | "quiz";
  title: string;
  subject_name: string;
  dueDate: Date;
  startDate?: Date;
  status: "pending" | "live" | "scheduled" | "submitted" | "missed";
  rawAssignment?: any;
  rawQuiz?: any;
}

// ─── Date range helpers ───────────────────────────────────────────────────────
function getDateRange(filter: TodoFilter): { start: Date; end: Date } {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (filter === "thisWeek") {
    const day = todayStart.getDay();
    const mon = new Date(todayStart);
    mon.setDate(todayStart.getDate() - ((day + 6) % 7));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    sun.setHours(23, 59, 59, 999);
    return { start: mon, end: sun };
  }

  if (filter === "nextWeek") {
    const day = todayStart.getDay();
    const mon = new Date(todayStart);
    mon.setDate(todayStart.getDate() - ((day + 6) % 7) + 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    sun.setHours(23, 59, 59, 999);
    return { start: mon, end: sun };
  }

  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

// ─── AsyncStorage keys ───────────────────────────────────────────────────────
const STORAGE_KEYS = [
  "is_lecture_ongoing",
  "lecture_start_time",
  "current_lecture_session_id",
  "saved_lecture_details",
] as const;

// ─── Main component ───────────────────────────────────────────────────────────
const StudentHome = () => {
  const navigation = useNavigation<any>();

  // ── Lecture / attendance state ────────────────────────────────────────────
  const [loading, setLoading]               = useState(true);
  const [today, setToday]                   = useState("");
  const [ongoingLecture, setOngoingLecture] = useState<LectureData | null>(null);
  const [nextLecture, setNextLecture]       = useState<LectureData | null>(null);
  const [alreadyMarked, setAlreadyMarked]   = useState(false);
  const [lectureState, setLectureState]     = useState<"idle" | "ongoing">("idle");
  const [timerSeconds, setTimerSeconds]     = useState(0);
  const [lectureSessionId, setLectureSessionId] = useState<string | null>(null);
  const [startTime, setStartTime]           = useState<Date | null>(null);
  const [markingStatus, setMarkingStatus]   = useState<"open" | "closed">("closed");
  const [markingMethod, setMarkingMethod]   = useState<string | null>(null);
  const [unreadCount, setUnreadCount]       = useState(0);

  const appState      = useRef(AppState.currentState);
  const studentMeta   = useRef<{ aishe_code: string; course_id: string } | null>(null);

  // ── ToDo state ────────────────────────────────────────────────────────────
  const [todoFilter, setTodoFilter]   = useState<TodoFilter>("thisWeek");
  const [todoItems, setTodoItems]     = useState<TodoItem[]>([]);
  const [todoLoading, setTodoLoading] = useState(false);

  const studentProfile = useRef<{
    uid: string;
    course_id: string;
    enrolled_subjects: string[];
    subject_map: Record<string, string>;
  } | null>(null);

  // ─── Helper: clear ALL lecture state + storage ───────────────────────────
  const clearLectureState = useCallback(async () => {
    setLectureState("idle");
    setStartTime(null);
    setTimerSeconds(0);
    setLectureSessionId(null);
    setOngoingLecture(null);
    setMarkingStatus("closed");
    setMarkingMethod(null);
    setAlreadyMarked(false);
    await AsyncStorage.multiRemove([...STORAGE_KEYS]);
  }, []);

  // ─── AppState listener — recheck when app comes to foreground ────────────
  useEffect(() => {
    const subscription = AppState.addEventListener("change", async (nextState) => {
      if (
        appState.current.match(/inactive|background/) &&
        nextState === "active"
      ) {
        if (lectureSessionId) {
          try {
            const sessionDoc = await getDoc(doc(db, "lecture_sessions", lectureSessionId));
            if (!sessionDoc.exists() || sessionDoc.data()?.is_live !== true) {
              await clearLectureState();
            }
          } catch (e) {
            console.log("FOREGROUND RECHECK ERROR:", e);
          }
        }
      }
      appState.current = nextState;
    });
    return () => subscription.remove();
  }, [lectureSessionId, clearLectureState]);

  // ─── Focus effect — recheck session validity on every screen focus ────────
  useFocusEffect(
    useCallback(() => {
      const recheckSession = async () => {
        if (!lectureSessionId) return;
        try {
          const sessionDoc = await getDoc(doc(db, "lecture_sessions", lectureSessionId));
          if (!sessionDoc.exists() || sessionDoc.data()?.is_live !== true) {
            await clearLectureState();
          }
        } catch (e) {
          console.log("RECHECK SESSION ERROR:", e);
        }
      };
      recheckSession();
    }, [lectureSessionId, clearLectureState])
  );

  // ─── Per-session listener: ONLY for markingStatus + alreadyMarked updates ─
  // FIX: Does NOT handle is_live=false here — the live query listener owns that.
  // Having two listeners both react to is_live caused race conditions and
  // the card briefly re-appearing after the lecture ended.
  useEffect(() => {
    if (!lectureSessionId) return;

    const unsubscribe = onSnapshot(
      doc(db, "lecture_sessions", lectureSessionId),
      async (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data();

        // FIX: Skip everything if is_live is no longer true.
        // The live query listener (startLiveSessionListener) is the single
        // source of truth for the ongoing/idle transition.
        if (!data.is_live) return;

        setMarkingStatus(data.marking_status || "closed");
        setMarkingMethod(data.marking_method || null);

        if (data.attendance_session_id) {
          try {
            const attSnap = await getDoc(
              doc(db, "attendance_sessions", data.attendance_session_id)
            );
            if (attSnap.exists()) {
              const attData    = attSnap.data();
              const currentUid = auth.currentUser?.uid;
              setAlreadyMarked(
                currentUid ? (attData.present_students?.includes(currentUid) ?? false) : false
              );
            }
          } catch {}
        }
      }
    );
    return () => unsubscribe();
  }, [lectureSessionId]);

  // ─── Boot ─────────────────────────────────────────────────────────────────
  const fetchUnreadCount = useCallback(async () => {
    try {
      const session = await getUserSession();
      if (!session?.uid) return;
      const res  = await fetch(`${API_URL}/api/broadcasts/student/${session.uid}`);
      const data = await res.json();
      if (data.success) {
        const count = (data.broadcasts || []).filter((b: any) => !b.is_read).length;
        setUnreadCount(count);
      }
    } catch {}
  }, []);

  useEffect(() => {
    let unsubActiveSession: (() => void) | null = null;

    const boot = async () => {
      const session = await getUserSession();
      if (!session?.uid) { setLoading(false); return; }

      const studentSnap = await getDoc(doc(db, "students", session.uid));
      if (!studentSnap.exists()) { setLoading(false); return; }

      const studentData      = studentSnap.data();
      const aishe_code: string  = studentData.aishe_code;
      const course_name: string = studentData.course_name;
      const enrolledSubjects: string[] = studentData.enrolled_subjects || [];

      const courseQ = query(
        collection(db, "courses"),
        where("course_name", "==", course_name),
        where("aishe_code", "==", aishe_code),
        limit(1)
      );
      const courseSnap = await new Promise<any>((resolve) => {
        const unsub = onSnapshot(courseQ, (snap) => { unsub(); resolve(snap); });
      });

      const course_id = courseSnap.empty ? null : courseSnap.docs[0].id;
      studentMeta.current = { aishe_code, course_id };

      // Build subject_id → subject_name map
      const subjectMap: Record<string, string> = {};
      if (enrolledSubjects.length > 0) {
        const CHUNK = 10;
        for (let i = 0; i < enrolledSubjects.length; i += CHUNK) {
          const chunk  = enrolledSubjects.slice(i, i + CHUNK);
          const subQ   = query(collection(db, "subjects"), where("subject_id", "in", chunk));
          const subSnap = await new Promise<any>((resolve) => {
            const unsub = onSnapshot(subQ, (s) => { unsub(); resolve(s); });
          });
          subSnap.docs.forEach((d: any) => {
            const sd = d.data();
            subjectMap[sd.subject_id] = sd.subject_name;
          });
        }
      }

      studentProfile.current = {
        uid: session.uid,
        course_id: course_id || "",
        enrolled_subjects: enrolledSubjects,
        subject_map: subjectMap,
      };

      await validateAndRestoreSession(session.uid);
      await fetchDailyLectures(session.uid);
      await fetchUnreadCount();

      unsubActiveSession = startLiveSessionListener(aishe_code, course_id, session.uid);
      setLoading(false);
    };

    boot().catch((e) => { console.log("BOOT ERROR:", e); setLoading(false); });
    return () => { unsubActiveSession?.(); };
  }, []);

  // ─── Fetch todos on filter change ─────────────────────────────────────────
  useEffect(() => {
    if (!loading) fetchTodos();
  }, [todoFilter, loading]);

  // ─── Fetch ToDo items ─────────────────────────────────────────────────────
  const fetchTodos = useCallback(async () => {
    const profile = studentProfile.current;
    if (!profile?.uid) return;

    setTodoLoading(true);
    try {
      const { start, end } = getDateRange(todoFilter);
      const items: TodoItem[] = [];

      // Assignments
      if (profile.enrolled_subjects.length > 0 && profile.course_id) {
        const subRes = await fetch(
          `${API_URL}/api/assignments/my-submissions?student_uid=${profile.uid}`
        );
        const subData = await subRes.json();
        const submittedIds = new Set<string>(
          (subData.submissions || []).map((s: any) => s.assignment_id)
        );

        const CHUNK = 5;
        for (let i = 0; i < profile.enrolled_subjects.length; i += CHUNK) {
          const chunk = profile.enrolled_subjects.slice(i, i + CHUNK);
          await Promise.all(
            chunk.map(async (subject_id) => {
              try {
                const res  = await fetch(
                  `${API_URL}/api/assignments?subject_id=${subject_id}&course_id=${profile.course_id}&limit=50`
                );
                const data = await res.json();
                if (!data.success) return;

                for (const a of (data.assignments || [])) {
                  if (!a.due_date) continue;
                  const dueDate = new Date(a.due_date);
                  if (dueDate < start || dueDate > end) continue;

                  const isSubmitted = submittedIds.has(a.assignment_id);
                  const isPast      = dueDate < new Date();

                  items.push({
                    id:           `assignment-${a.assignment_id}`,
                    type:         "assignment",
                    title:        a.title,
                    subject_name: a.subject_name || profile.subject_map[subject_id] || "—",
                    dueDate,
                    status: isSubmitted
                      ? "submitted"
                      : isPast && !a.allow_late
                      ? "missed"
                      : "pending",
                    rawAssignment: { ...a, subject_name: a.subject_name || profile.subject_map[subject_id] || "—" },
                  });
                }
              } catch {}
            })
          );
        }
      }

      // Quizzes
      try {
        const qRes  = await fetch(`${API_URL}/api/quizzes/student-quizzes/${profile.uid}`);
        const qData = await qRes.json();
        if (qData.success) {
          const allQuizzes = [
            ...(qData.live      || []).map((q: any) => ({ ...q, _tab: "live"      })),
            ...(qData.scheduled || []).map((q: any) => ({ ...q, _tab: "scheduled" })),
            ...(qData.completed || []).map((q: any) => ({ ...q, _tab: "completed" })),
          ];

          for (const q of allQuizzes) {
            const endDate = q.scheduled_end ? new Date(q.scheduled_end) : null;
            if (!endDate) continue;
            if (endDate < start || endDate > end) continue;

            const startDate = q.scheduled_start ? new Date(q.scheduled_start) : undefined;
            let status: TodoItem["status"];

            if (q._tab === "completed") {
              status = q.submission ? "submitted" : "missed";
            } else if (q._tab === "live") {
              status = "live";
            } else {
              status = "scheduled";
            }

            items.push({
              id:           `quiz-${q.quiz_id}`,
              type:         "quiz",
              title:        q.title,
              subject_name: q.subject_name || "—",
              dueDate:      endDate,
              startDate,
              status,
              rawQuiz:      q,
            });
          }
        }
      } catch {}

      items.sort((a, b) => {
        const aTime = a.rawAssignment?.created_at || a.rawQuiz?.created_at || a.dueDate;
        const bTime = b.rawAssignment?.created_at || b.rawQuiz?.created_at || b.dueDate;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });
      setTodoItems(items);
    } catch (e) {
      console.log("FETCH TODOS ERROR:", e);
    } finally {
      setTodoLoading(false);
    }
  }, [todoFilter]);

  // ─── Navigate when a todo is tapped ──────────────────────────────────────
  const handleTodoPress = (item: TodoItem) => {
    if (item.type === "assignment") {
      navigation.navigate("StudentAssignmentDetail", {
        assignment:  item.rawAssignment,
        student_uid: studentProfile.current?.uid,
      });
      return;
    }

    const quiz = item.rawQuiz;
    const tab  = quiz._tab as "live" | "scheduled" | "completed";

    if (tab === "live") {
      if (quiz.join_code && quiz.join_code_expiry_at) {
        if (new Date() > new Date(quiz.join_code_expiry_at)) {
          Alert.alert("Code Expired", "The join code for this quiz has expired. Please ask your teacher for the updated code.", [{ text: "OK" }]);
          return;
        }
      }
      navigation.navigate("StudentJoinQuiz", { quiz });
    } else if (tab === "scheduled") {
      navigation.navigate("StudentScheduledQuiz", { quiz });
    } else {
      navigation.navigate("StudentQuizResult", { quiz_id: quiz.quiz_id, quiz_title: quiz.title });
    }
  };

  // ─── Validate / restore lecture session from AsyncStorage ─────────────────
  const validateAndRestoreSession = async (uid: string) => {
    try {
      const pairs = await AsyncStorage.multiGet([...STORAGE_KEYS]);
      const [isOngoing, startStr, storedSessionId, savedLectureStr] = pairs.map((p) => p[1]);

      if (isOngoing !== "true" || !storedSessionId) return;

      // Always validate against Firestore — never trust stale storage alone
      const sessionDoc = await getDoc(doc(db, "lecture_sessions", storedSessionId));
      if (!sessionDoc.exists() || sessionDoc.data()?.is_live !== true) {
        await clearLectureState();
        return;
      }

      const start        = new Date(startStr!);
      const diffInSeconds = Math.floor((Date.now() - start.getTime()) / 1000);

      setLectureState("ongoing");
      setStartTime(start);
      setTimerSeconds(diffInSeconds > 0 ? diffInSeconds : 0);
      setLectureSessionId(storedSessionId);
      if (savedLectureStr) setOngoingLecture(JSON.parse(savedLectureStr));
    } catch (e) {
      console.log("SESSION VALIDATE ERROR:", e);
    }
  };

  // ─── Live session Firestore listener ─────────────────────────────────────
  // FIX: This is the SINGLE source of truth for ongoing ↔ idle transitions.
  // The per-session listener above handles only marking_status updates.
  const startLiveSessionListener = (
    aishe_code: string,
    course_id: string | null,
    uid: string
  ) => {
    const liveQ = query(
      collection(db, "lecture_sessions"),
      where("aishe_code", "==", aishe_code),
      where("is_live", "==", true),
      limit(1)
    );

    const unsubscribe = onSnapshot(liveQ, async (snapshot) => {
      // ── No live session at all → clear everything ─────────────────────────
      if (snapshot.empty) {
        await clearLectureState();
        return;
      }

      const sessionDoc = snapshot.docs[0];
      const sessionId  = sessionDoc.id;
      const data       = sessionDoc.data();

      // FIX: Explicitly guard is_live. Firestore can return a cached document
      // where is_live is still true for a brief moment after the teacher ends
      // the lecture. Without this guard the card re-appears on stale cache hits.
      if (data.is_live !== true) {
        await clearLectureState();
        return;
      }

      // Course mismatch — session belongs to a different course, ignore
      if (course_id && data.course_id && data.course_id !== course_id) return;

      // ── Live session found → populate state ───────────────────────────────
      setLectureState("ongoing");
      setLectureSessionId(sessionId);

      if (data.started_at?.seconds) {
        setStartTime(new Date(data.started_at.seconds * 1000));
      }

      if (data.lecture_id) {
        try {
          const lectureDoc = await getDoc(doc(db, "lectures", data.lecture_id));
          if (lectureDoc.exists()) {
            setOngoingLecture({ id: lectureDoc.id, ...lectureDoc.data() } as LectureData);
          }
        } catch {}
      } else {
        setOngoingLecture({
          subject_name: data.subject_name,
          room:         data.room || "",
          start_time:   data.scheduled_start_time || "",
          end_time:     data.scheduled_end_time   || "",
          aishe_code,
        });
      }

      setMarkingStatus(data.marking_status || "closed");
      setMarkingMethod(data.marking_method || null);

      if (data.attendance_session_id) {
        try {
          const attSnap = await getDoc(
            doc(db, "attendance_sessions", data.attendance_session_id)
          );
          if (attSnap.exists()) {
            const attData    = attSnap.data();
            const currentUid = auth.currentUser?.uid || uid;
            setAlreadyMarked(attData.present_students?.includes(currentUid) ?? false);
          }
        } catch {}
      }
    });

    return unsubscribe;
  };

  // ─── Timer ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (lectureState !== "ongoing" || !startTime) return;
    const updateTimer = () => {
      const diff = Math.floor((Date.now() - startTime.getTime()) / 1000);
      setTimerSeconds(diff >= 0 ? diff : 0);
    };
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [lectureState, startTime]);

  // ─── Fetch daily timetable (next lecture) ─────────────────────────────────
  const fetchDailyLectures = async (uid: string) => {
    try {
      const res  = await fetch(`${API_URL}/api/lectures/student/today?uid=${uid}`);
      const json = await res.json();
      if (json.success) {
        setToday(json.today);
        setNextLecture(json.nextLecture ?? null);
        // Only set session from API response if we don't already have one from Firestore
        if (!lectureSessionId && json.lecture_is_live && json.lecture_session_id) {
          setLectureSessionId(json.lecture_session_id);
        }
      }
    } catch (e) {
      console.log("FETCH DAILY LECTURES ERROR:", e);
    }
  };

  // ─── Mark attendance ──────────────────────────────────────────────────────
  const handleMarkAttendance = async () => {
    if (alreadyMarked) {
      Alert.alert("Already Marked", "Your attendance is already recorded.");
      return;
    }
    if (!lectureSessionId) {
      Alert.alert("Attendance not available");
      return;
    }
    try {
      const methodRes = await fetch(
        `${API_URL}/api/lectures/attendance/method?lecture_session_id=${lectureSessionId}`
      );
      if (!methodRes.ok) {
        Alert.alert("Attendance unavailable", "Could not reach the server. Try again.");
        return;
      }
      const methodData = await methodRes.json();
      if (!methodData.success) {
        Alert.alert("Attendance unavailable", methodData.message || "Attendance is not open.");
        return;
      }
      const method              = methodData.marking_method;
      const attendanceSessionId = methodData.attendance_session_id;

      if (method === "qr_totp") {
        navigation.navigate("QRMarkingScreen", { lectureSessionId });
      } else if (method === "code") {
        navigation.navigate("CodeMarkingScreen", { attendanceSessionId, lectureSessionId });
      } else if (method === "bio_wifi_ble") {
        navigation.navigate("BioGeoMarkingScreen", { attendanceSessionId });
      } else if (method === "iot") {
        navigation.navigate("IoTMarkingScreen", { attendanceSessionId });
      } else {
        Alert.alert("Attendance method not available");
      }
    } catch (e) {
      console.log("MARK ATTENDANCE ERROR:", e);
      Alert.alert("Error", "Failed to start attendance. Try again.");
    }
  };

  // ─── Derived values ───────────────────────────────────────────────────────
  // Only show the card if BOTH lectureState is ongoing AND sessionId is set.
  // This prevents any brief flash of the card when state is partially cleared.
  const activeLecture =
    lectureState === "ongoing" && !!lectureSessionId ? ongoingLecture : null;

  function fmtShortDate(d: Date) {
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  }
  function fmtTime(d: Date) {
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  }

  const statusConfig: Record<
    TodoItem["status"],
    { label: string; color: string; bg: string; icon: string }
  > = {
    pending:   { label: "Pending",   color: AMBER,   bg: AMBER_LIGHT,  icon: "time-outline"             },
    live:      { label: "Live",      color: GREEN,   bg: GREEN_LIGHT,  icon: "radio-outline"            },
    scheduled: { label: "Upcoming",  color: PRIMARY, bg: PRIMARY_LIGHT,icon: "calendar-outline"         },
    submitted: { label: "Submitted", color: GREEN,   bg: GREEN_LIGHT,  icon: "checkmark-circle-outline" },
    missed:    { label: "Missed",    color: RED,     bg: RED_LIGHT,    icon: "close-circle-outline"     },
  };

  const FILTER_LABELS: { key: TodoFilter; label: string }[] = [
    { key: "thisWeek",  label: "This Week"  },
    { key: "nextWeek",  label: "Next Week"  },
    { key: "thisMonth", label: "This Month" },
  ];

  // ─── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator size="large" color={PRIMARY} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Dashboard</Text>
            <Text style={styles.subtitle}>Today, {today}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <TouchableOpacity
              style={styles.headerIcon}
              onPress={() => navigation.navigate("BroadcastInbox")}
            >
              <Ionicons name="notifications-outline" size={22} color={PRIMARY} />
              {unreadCount > 0 && (
                <View style={styles.bellBadge}>
                  <Text style={styles.bellBadgeText}>
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => navigation.navigate("StudentProfile")}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>S</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Attendance Card ── */}
        <View style={styles.mainCardContainer}>
          {activeLecture ? (
            <AttendanceCard
              lecture={activeLecture}
              lectureState={lectureState}
              timerSeconds={timerSeconds}
              markingStatus={markingStatus}
              userRole="student"
              markingMethod={markingMethod}
              alreadyMarked={alreadyMarked}
              onStartLecture={() => {}}
              onEndLecture={() => {}}
              onMarkAttendance={handleMarkAttendance}
              onMethodSelected={() => {}}
            />
          ) : (
            <View style={styles.emptyContainer}>
              <View style={styles.emptyIconCircle}>
                <Text style={{ fontSize: 32 }}>☕</Text>
              </View>
              <Text style={styles.emptyTitle}>No Ongoing Lecture</Text>
              <Text style={styles.emptySubtitle}>You are free right now.</Text>
            </View>
          )}
        </View>

        {/* ── Next Lecture ── */}
        {nextLecture && !activeLecture && (
          <View style={styles.nextCard}>
            <View style={styles.nextHeader}>
              <Text style={styles.nextLabel}>Next Up</Text>
              <View
                style={[
                  styles.dayBadge,
                  { backgroundColor: nextLecture.day === today ? "#E0F7FA" : "#FFF3E0" },
                ]}
              >
                <Text
                  style={[
                    styles.dayText,
                    { color: nextLecture.day === today ? "#00ACC1" : "#FF9800" },
                  ]}
                >
                  {nextLecture.day === today ? "Today" : nextLecture.day}
                </Text>
              </View>
            </View>
            <Text style={styles.nextSubject}>{nextLecture.subject_name}</Text>
            <View style={styles.nextTimeRow}>
              <Text style={{ color: PRIMARY, fontWeight: "bold", marginRight: 6 }}>🕒</Text>
              <Text style={styles.nextTimeText}>{nextLecture.start_time}</Text>
            </View>
          </View>
        )}

        {/* ── ToDo Section ── */}
        <View style={styles.todoSection}>
          <View style={styles.todoHeader}>
            <Text style={styles.todoTitle}>To‑Do</Text>
            <Text style={styles.todoSubtitle}>Assignments & Quizzes</Text>
          </View>

          {/* Filter chips */}
          <View style={styles.filterRow}>
            {FILTER_LABELS.map((f) => {
              const active = todoFilter === f.key;
              return (
                <TouchableOpacity
                  key={f.key}
                  style={[styles.filterChip, active && styles.filterChipActive]}
                  onPress={() => setTodoFilter(f.key)}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                    {f.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Items */}
          {todoLoading ? (
            <View style={styles.todoLoading}>
              <ActivityIndicator size="small" color={PRIMARY} />
              <Text style={styles.todoLoadingText}>Loading…</Text>
            </View>
          ) : todoItems.length === 0 ? (
            <View style={styles.todoEmpty}>
              <Ionicons name="checkmark-done-circle-outline" size={38} color={GREY} />
              <Text style={styles.todoEmptyText}>Nothing due in this period!</Text>
            </View>
          ) : (
            todoItems.map((item) => {
              const cfg       = statusConfig[item.status];
              const typeIcon  = item.type === "assignment" ? "document-text-outline" : "help-circle-outline";
              const typeColor = item.type === "assignment" ? PRIMARY : "#8B5CF6";
              const typeBg    = item.type === "assignment" ? PRIMARY_LIGHT : "#F5F3FF";

              return (
                <TouchableOpacity
                  key={item.id}
                  style={styles.todoCard}
                  onPress={() => handleTodoPress(item)}
                  activeOpacity={0.8}
                >
                  <View style={[styles.todoTypeIcon, { backgroundColor: typeBg }]}>
                    <Ionicons name={typeIcon as any} size={18} color={typeColor} />
                  </View>
                  <View style={styles.todoContent}>
                    <Text style={styles.todoItemTitle} numberOfLines={1}>{item.title}</Text>
                    <Text style={styles.todoItemSubject} numberOfLines={1}>{item.subject_name}</Text>
                    <View style={styles.todoMetaRow}>
                      <Ionicons name="time-outline" size={11} color={GREY} />
                      <Text style={styles.todoMetaText}>
                        {item.type === "quiz" && item.startDate
                          ? `${fmtShortDate(item.startDate)} ${fmtTime(item.startDate)} – ${fmtShortDate(item.dueDate)} ${fmtTime(item.dueDate)}`
                          : `Due: ${fmtShortDate(item.dueDate)} ${fmtTime(item.dueDate)}`}
                      </Text>
                    </View>
                  </View>
                  <View style={[styles.todoBadge, { backgroundColor: cfg.bg }]}>
                    <Ionicons name={cfg.icon as any} size={11} color={cfg.color} />
                    <Text style={[styles.todoBadgeText, { color: cfg.color }]}>{cfg.label}</Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>
    </View>
  );
};

export default StudentHome;

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: BG },
  content:     { paddingHorizontal: 20, paddingTop: 60 },
  loader:      { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: BG },

  header:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 26 },
  title:       { fontSize: 28, fontWeight: "bold", color: "black" },
  subtitle:    { marginTop: 6, fontSize: 14, color: "grey", fontWeight: "bold" },
  avatar:      { width: 45, height: 45, borderRadius: 50, backgroundColor: "#7C73E6", alignItems: "center", justifyContent: "center", elevation: 4 },
  avatarText:  { color: "#FFF", fontWeight: "bold", fontSize: 16 },

  headerIcon: {
    width: 42, height: 42, borderRadius: 14,
    backgroundColor: "#EEF2FF",
    alignItems: "center", justifyContent: "center",
    position: "relative", marginRight: 8,
  },
  bellBadge: {
    position: "absolute", top: -4, right: -4,
    backgroundColor: "#EF4444", borderRadius: 10,
    minWidth: 18, height: 18,
    alignItems: "center", justifyContent: "center",
    paddingHorizontal: 3, borderWidth: 2, borderColor: BG,
  },
  bellBadgeText: { color: "#FFF", fontSize: 9, fontWeight: "800" },

  mainCardContainer: {
    backgroundColor: "#FFFFFF", borderRadius: 30, padding: 24, marginBottom: 24,
    shadowColor: PRIMARY, shadowOpacity: 0.08, shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 }, elevation: 5,
    minHeight: 200, justifyContent: "center",
  },
  emptyContainer:  { alignItems: "center", justifyContent: "center", paddingVertical: 20 },
  emptyIconCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: "#F5F5F5", alignItems: "center", justifyContent: "center", marginBottom: 16 },
  emptyTitle:      { fontWeight: "bold", color: "#424242", fontSize: 16, marginBottom: 4 },
  emptySubtitle:   { fontSize: 12, color: "grey" },

  nextCard:    { backgroundColor: "#FFFFFF", borderRadius: 30, padding: 24, marginBottom: 18, shadowColor: "black", shadowOpacity: 0.05, shadowRadius: 10, elevation: 2 },
  nextHeader:  { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  nextLabel:   { fontSize: 16, fontWeight: "bold", color: "grey" },
  dayBadge:    { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  dayText:     { fontSize: 12, fontWeight: "bold" },
  nextSubject: { fontSize: 18, fontWeight: "bold", color: "#2D3436", marginTop: 12 },
  nextTimeRow: { flexDirection: "row", marginTop: 8, alignItems: "center" },
  nextTimeText:{ color: PRIMARY, fontWeight: "bold", fontSize: 14 },

  todoSection:  { padding: 8 },
  todoHeader:   { marginBottom: 14 },
  todoTitle:    { fontSize: 20, fontWeight: "800", color: "#111827" },
  todoSubtitle: { fontSize: 13, color: GREY, marginTop: 2 },

  filterRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  filterChip: {
    flex: 1, paddingVertical: 8, paddingHorizontal: 4,
    borderRadius: 12, backgroundColor: "#F3F4F6",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: "transparent",
  },
  filterChipActive:     { backgroundColor: PRIMARY_LIGHT, borderColor: PRIMARY },
  filterChipText:       { fontSize: 12, fontWeight: "700", color: GREY },
  filterChipTextActive: { color: PRIMARY },

  todoLoading:     { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 24 },
  todoLoadingText: { fontSize: 13, color: GREY },
  todoEmpty:       { alignItems: "center", paddingVertical: 30, gap: 10 },
  todoEmptyText:   { fontSize: 14, color: GREY, fontWeight: "600" },

  todoCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: "#F9FAFB", borderRadius: 14,
    padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  todoTypeIcon:    { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  todoContent:     { flex: 1, gap: 3 },
  todoItemTitle:   { fontSize: 14, fontWeight: "700", color: "#111827" },
  todoItemSubject: { fontSize: 12, color: GREY, fontWeight: "500" },
  todoMetaRow:     { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  todoMetaText:    { fontSize: 11, color: GREY, fontWeight: "500" },

  todoBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 5,
    borderRadius: 10, flexShrink: 0,
  },
  todoBadgeText: { fontSize: 10, fontWeight: "700" },
});