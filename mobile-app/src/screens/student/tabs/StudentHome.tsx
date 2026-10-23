import { apiFetch } from "../../../services/api";
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
import { getUserSession, updateSessionProfile } from "../../../services/session";
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
import { Ionicons } from "@expo/vector-icons";
import { API_BASE } from "../../../services/api";
import * as Notifications from "expo-notifications";
import { Avatar, Banner, Card, Chip, ProgressBar, Screen, SP, T, Tone, font, shadow } from "../../../components/ui";
import { lectureTag, meantForStudent, rollOf, withTag } from "../../../utils/batches";

const API_URL = API_BASE;

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
  division_id?: string | null;
  kind?: string | null;          // "lab" | "tutorial" | null (plain lecture)
  batch?: string | null;         // lab batch, e.g. "B1"
  batch_no?: number | null;
  batch_of?: number | null;
  batch_after?: string | null;
  batch_upto?: string | null;
  teacher_name?: string;         // current-lecture card
  elective?: boolean;
  elective_group?: string;
  state?: "scheduled" | "live";
}

/** "HH:MM" -> minutes since midnight */
const toMin = (t?: string) => {
  const [h, m] = String(t || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

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

// ─── The lecture that is on now, before the teacher taps Start ───────────────
function ScheduledLectureCard({ lecture, nowMin }: { lecture: LectureData; nowMin: number }) {
  const start = toMin(lecture.start_time);
  const end   = toMin(lecture.end_time);
  const total = Math.max(1, end - start);
  const done  = Math.min(total, Math.max(0, nowMin - start));
  const left  = Math.max(0, end - nowMin);
  const tag   = lectureTag(lecture);
  return (
    <View>
      <Chip label="Scheduled · waiting for your teacher" tone="warning" icon="hourglass-outline" />
      <Text style={[font.h1, { marginTop: SP.md }]}>{lecture.subject_name}</Text>
      {!!tag && <Text style={[font.small, { marginTop: 2 }]}>{tag}</Text>}

      <View style={styles.curRows}>
        {!!lecture.teacher_name && (
          <View style={styles.curRow}>
            <Ionicons name="person-outline" size={15} color={T.primary} />
            <Text style={font.body}>{lecture.teacher_name}</Text>
          </View>
        )}
        <View style={styles.curRow}>
          <Ionicons name="time-outline" size={15} color={T.primary} />
          <Text style={font.body}>{lecture.start_time} – {lecture.end_time} · {left} min left</Text>
        </View>
        {!!lecture.room && (
          <View style={styles.curRow}>
            <Ionicons name="location-outline" size={15} color={T.primary} />
            <Text style={font.body}>Room {lecture.room}</Text>
          </View>
        )}
      </View>

      {(lecture.elective || lecture.kind) && (
        <View style={styles.curChips}>
          {lecture.elective && <Chip label={lecture.elective_group ? `Elective · ${lecture.elective_group}` : "Elective"} tone="info" />}
        </View>
      )}

      <View style={{ marginTop: SP.md }}>
        <ProgressBar value={done / total} tone="warning" height={8} />
      </View>
      <Text style={[font.small, { marginTop: SP.sm }]}>
        Attendance opens when your teacher starts the lecture. This card turns live by itself and you will get a notification.
      </Text>
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
const StudentHome = () => {
  const navigation = useNavigation<any>();

  // ── Lecture / attendance state ────────────────────────────────────────────
  const [loading, setLoading]               = useState(true);
  const [today, setToday]                   = useState("");
  const [ongoingLecture, setOngoingLecture] = useState<LectureData | null>(null);
  const [nextLecture, setNextLecture]       = useState<LectureData | null>(null);
  const [currentLecture, setCurrentLecture] = useState<LectureData | null>(null);   // on now, the teacher has not started it yet
  const [clock, setClock]                   = useState(Date.now());                   // re-renders the card every 30 s
  const [alreadyMarked, setAlreadyMarked]   = useState(false);
  const [markPending, setMarkPending]       = useState(false);   // unverified: waiting for the teacher
  const [attendanceSessionId, setAttendanceSessionId] = useState<string | null>(null);
  const [lectureState, setLectureState]     = useState<"idle" | "ongoing">("idle");
  const [timerSeconds, setTimerSeconds]     = useState(0);
  const [lectureSessionId, setLectureSessionId] = useState<string | null>(null);
  const [startTime, setStartTime]           = useState<Date | null>(null);
  const [markingStatus, setMarkingStatus]   = useState<"open" | "closed">("closed");
  const [markingMethod, setMarkingMethod]   = useState<string | null>(null);
  const [unreadCount, setUnreadCount]       = useState(0);
  const [studentName, setStudentName]     = useState("");
  const [electivesPending, setElectivesPending] = useState(0); // elective groups the student still has to choose

  const appState      = useRef(AppState.currentState);
  const uidRef        = useRef("");
  const stateRef      = useRef({ lectureSessionId: null as string | null, ongoing: false, hasCurrent: false, soon: false });
  const fetchRef      = useRef<((uid: string) => Promise<void>) | null>(null);
  const recheckRef     = useRef<(() => Promise<void>) | null>(null);
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
    division_id: string | null;   // which division the student is in
    roll: string;                 // roll number: decides the lab batch
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
    setMarkPending(false);
    setAttendanceSessionId(null);
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

  // ─── Electives still to choose? (shows a banner; silent when anything fails) ──
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        try {
          const session = await getUserSession();
          if (!session?.uid) return;
          // 1) did the semester change since this phone last looked? (automatic semester change on the server)
          try {
            const pr = await apiFetch(`${API_BASE}/api/profile/student/${session.uid}`);
            if (pr.ok) {
              const pj = await pr.json();
              const fresh = pj.success ? pj.profile : null;
              const before = session.profile;
              if (fresh && before && alive) {
                const wasDone = before.semester_status === "completed";
                const nowDone = fresh.semester_status === "completed";
                if (!wasDone && nowDone) {
                  Alert.alert("Course completed", "You have finished your final semester. Congratulations.");
                } else if (before.semester != null && Number(before.semester) !== Number(fresh.semester)) {
                  Alert.alert("Semester updated", `You are now in Semester ${fresh.semester}. Your subjects have been updated.`);
                }
              }
              if (fresh) await updateSessionProfile(fresh);
            }
          } catch {}

          // 2) electives still to choose?
          const res = await apiFetch(`${API_BASE}/api/profile/student/${session.uid}/electives`);
          if (!res.ok) return;
          const json = await res.json();
          if (alive && json.success) setElectivesPending(json.pending || 0);
        } catch {}
      })();
      return () => { alive = false; };
    }, [])
  );

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
        setAttendanceSessionId(data.attendance_session_id || null);

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
              setMarkPending(
                currentUid ? (attData.pending_students?.includes(currentUid) ?? false) : false
              );
            }
          } catch {}
        }
      }
    );
    return () => unsubscribe();
  }, [lectureSessionId]);

  // ─── Live "my status" for the open attendance session ─────────────────────
  // Updates the button when the student is counted (pending -> present after the teacher confirms).
  useEffect(() => {
    if (!attendanceSessionId) return;
    const unsub = onSnapshot(doc(db, "attendance_sessions", attendanceSessionId), (snap) => {
      if (!snap.exists()) return;
      const d: any = snap.data();
      const me = auth.currentUser?.uid;
      if (!me) return;
      setAlreadyMarked(d.present_students?.includes(me) ?? false);
      setMarkPending(d.pending_students?.includes(me) ?? false);
    }, () => {});
    return () => unsub();
  }, [attendanceSessionId]);

  // ─── Boot ─────────────────────────────────────────────────────────────────
  const fetchUnreadCount = useCallback(async () => {
    try {
      const session = await getUserSession();
      if (!session?.uid) return;
      const res  = await apiFetch(`${API_URL}/api/broadcasts/student/${session.uid}`);
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

      uidRef.current = session.uid;
      const studentSnap = await getDoc(doc(db, "students", session.uid));
      if (!studentSnap.exists()) { setLoading(false); return; }

      const studentData      = studentSnap.data();
      setStudentName(studentData.name || studentData.first_name || "");
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
        division_id: studentData.division_id || null,
        roll: rollOf(studentData),
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
        const subRes = await apiFetch(
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
                const res  = await apiFetch(
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
        const qRes  = await apiFetch(`${API_URL}/api/quizzes/student-quizzes/${profile.uid}`);
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
      limit(10)   // several classes can be live at once (other divisions, lab batches): pick the one that is mine
    );

    const unsubscribe = onSnapshot(liveQ, async (snapshot) => {
      // ── The live session meant for THIS student: their division and their lab batch ─
      const me = studentProfile.current;
      const mine = snapshot.docs.filter((d) => {
        const x: any = d.data();
        if (x.is_live !== true) return false;
        if (course_id && x.course_id && x.course_id !== course_id) return false;
        return meantForStudent(x, me?.division_id, me?.roll);
      });

      // ── Nothing live for me → clear everything ────────────────────────────
      if (mine.length === 0) {
        await clearLectureState();
        return;
      }

      const sessionDoc = mine[0];
      const sessionId  = sessionDoc.id;
      const data       = sessionDoc.data();

      // FIX: Explicitly guard is_live. Firestore can return a cached document
      // where is_live is still true for a brief moment after the teacher ends
      // the lecture. Without this guard the card re-appears on stale cache hits.
      if (data.is_live !== true) {
        await clearLectureState();
        return;
      }

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
            setOngoingLecture(withTag({ id: lectureDoc.id, ...lectureDoc.data() } as LectureData));
          }
        } catch {}
      } else {
        setOngoingLecture(withTag({
          subject_name: data.subject_name,
          room:         data.room || "",
          start_time:   data.scheduled_start_time || "",
          end_time:     data.scheduled_end_time   || "",
          aishe_code,
          kind:         data.kind || null,
          batch:        data.batch || null,
          batch_no:     data.batch_no || null,
        } as LectureData));
      }

      setMarkingStatus(data.marking_status || "closed");
      setMarkingMethod(data.marking_method || null);
      setAttendanceSessionId(data.attendance_session_id || null);

      if (data.attendance_session_id) {
        try {
          const attSnap = await getDoc(
            doc(db, "attendance_sessions", data.attendance_session_id)
          );
          if (attSnap.exists()) {
            const attData    = attSnap.data();
            const currentUid = auth.currentUser?.uid || uid;
            setAlreadyMarked(attData.present_students?.includes(currentUid) ?? false);
            setMarkPending(attData.pending_students?.includes(currentUid) ?? false);
          }
        } catch {}
      }
    }, (err) => {
      // a dropped connection must not leave the card stuck: the periodic refresh below keeps it current
      console.log("LIVE SESSION LISTENER ERROR:", err?.message);
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
      const res  = await apiFetch(`${API_URL}/api/lectures/student/today?uid=${uid}`);
      const json = await res.json();
      if (!json.success) return;
      setToday(json.today);
      setNextLecture(withTag(json.nextLecture) ?? null);
      const cur = json.currentLecture ? withTag<LectureData>(json.currentLecture) : null;
      setCurrentLecture(cur && cur.state === "scheduled" ? cur : null);

      // The teacher started the lecture. Normally the Firestore listener shows the card within a second;
      // if it is late (a stalled connection) the server's answer is used, so nobody has to reload the page.
      if (json.lecture_is_live && json.lecture_session_id && !stateRef.current.lectureSessionId) {
        setLectureSessionId(json.lecture_session_id);
        setLectureState("ongoing");
        setStartTime(json.started_at_ms ? new Date(json.started_at_ms) : new Date());
        setOngoingLecture(withTag<LectureData>(json.ongoingLecture) ?? withTag<LectureData>(json.currentLecture) ?? null);
        setMarkingStatus(json.marking_status || "closed");
        setMarkingMethod(json.marking_method || null);
        setAttendanceSessionId(json.attendance_session_id || null);
      }
    } catch (e) {
      console.log("FETCH DAILY LECTURES ERROR:", e);
    }
  };
  fetchRef.current = fetchDailyLectures;

  // is the lecture we think is live still live? (the listener may have missed the end)
  recheckRef.current = async () => {
    const id = stateRef.current.lectureSessionId;
    if (!id) return;
    try {
      const sessionDoc = await getDoc(doc(db, "lecture_sessions", id));
      if (!sessionDoc.exists() || sessionDoc.data()?.is_live !== true) await clearLectureState();
    } catch {}
  };

  // ─── Keep the card current without a reload ───────────────────────────────
  // refresh when: the app comes back, a "lecture started / starting" push arrives, the screen is focused, and
  // every 30 s while a lecture is on or about to start (otherwise only every 5 minutes: it is a cheap, cached call).
  useEffect(() => {
    const refresh = () => {
      const uid = uidRef.current;
      if (!uid) return;
      fetchRef.current?.(uid);
      recheckRef.current?.();
    };
    const appSub = AppState.addEventListener("change", (s) => { if (s === "active") refresh(); });
    const pushSub = Notifications.addNotificationReceivedListener((n) => {
      const t = (n.request.content.data as any)?.type;
      if (t === "lecture_live" || t === "lecture_time") refresh();
    });
    let ticks = 0;
    const iv = setInterval(() => {
      setClock(Date.now());
      if (AppState.currentState !== "active") return;
      ticks += 1;
      const s = stateRef.current;
      if (s.hasCurrent || s.ongoing || s.soon || ticks % 10 === 0) refresh();
    }, 30_000);
    return () => { appSub.remove(); pushSub.remove(); clearInterval(iv); };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const uid = uidRef.current;
      if (uid) { fetchRef.current?.(uid); recheckRef.current?.(); }
    }, [])
  );

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
      const methodRes = await apiFetch(
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
      } else if (method === "multi") {
        navigation.navigate("MultiMarkingScreen", { attendanceSessionId, lectureSessionId });
      } else if (method === "bio_wifi_ble") {
        navigation.navigate("BioGeoMarkingScreen", { attendanceSessionId });
      } else if (method === "iot") {
        navigation.navigate("IoTMarkingScreen", { attendanceSessionId });
      } else if (method === "iot_multi") {
        // device first; the screen offers code / biometric if the device path fails
        navigation.navigate("IoTMarkingScreen", { attendanceSessionId, lectureSessionId, fallback: true });
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

  // the lecture that is on right now but not started by its teacher (hidden once its time is over)
  const nowDate = new Date(clock);
  const nowMin  = nowDate.getHours() * 60 + nowDate.getMinutes();
  const scheduledNow =
    !activeLecture && currentLecture && nowMin < toMin(currentLecture.end_time) + 1
      ? currentLecture
      : null;
  const nextSoon = !!nextLecture && toMin(nextLecture.start_time) - nowMin <= 10 && toMin(nextLecture.start_time) - nowMin >= -1;
  stateRef.current = { lectureSessionId, ongoing: lectureState === "ongoing", hasCurrent: !!currentLecture, soon: nextSoon };

  function fmtShortDate(d: Date) {
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  }
  function fmtTime(d: Date) {
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  }

  const statusConfig: Record<
    TodoItem["status"],
    { label: string; tone: Tone; icon: any }
  > = {
    pending:   { label: "Pending",   tone: "warning", icon: "time-outline"             },
    live:      { label: "Live",      tone: "success", icon: "radio-outline"            },
    scheduled: { label: "Upcoming",  tone: "primary", icon: "calendar-outline"         },
    submitted: { label: "Submitted", tone: "success", icon: "checkmark-circle-outline" },
    missed:    { label: "Missed",    tone: "danger",  icon: "close-circle-outline"     },
  };

  const FILTER_LABELS: { key: TodoFilter; label: string }[] = [
    { key: "thisWeek",  label: "This week"  },
    { key: "nextWeek",  label: "Next week"  },
    { key: "thisMonth", label: "This month" },
  ];

  // ─── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator size="large" color={T.primary} />
      </View>
    );
  }

  return (
    <Screen edges={["top"]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={font.display}>Dashboard</Text>
            <Text style={[font.body, { marginTop: 2 }]}>Today, {today}</Text>
          </View>
          <TouchableOpacity
            style={styles.bell}
            onPress={() => navigation.navigate("BroadcastInbox")}
            activeOpacity={0.8}
            accessibilityLabel="Announcements"
          >
            <Ionicons name="notifications-outline" size={22} color={T.primary} />
            {unreadCount > 0 && (
              <View style={styles.bellBadge}>
                <Text style={styles.bellBadgeText}>{unreadCount > 9 ? "9+" : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.navigate("StudentProfile")} activeOpacity={0.8} accessibilityLabel="Profile">
            <Avatar name={studentName || "Student"} initials tone="primary" size={44} />
          </TouchableOpacity>
        </View>

        <View style={{ flexDirection: "row", gap: 10, marginBottom: SP.md }}>
          {([["Timetable", "StudentTimetable", "calendar-outline"], ["Calendar", "StudentCalendar", "calendar-number-outline"]] as const).map(([label, route, icon]) => (
            <TouchableOpacity key={route} activeOpacity={0.85} onPress={() => navigation.navigate(route)} style={{ flex: 1 }}>
              <Card>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Ionicons name={icon as any} size={20} color={T.primary} />
                  <Text style={font.h3}>{label}</Text>
                </View>
              </Card>
            </TouchableOpacity>
          ))}
        </View>

        {electivesPending > 0 && (
          <TouchableOpacity activeOpacity={0.85} onPress={() => navigation.navigate("ElectiveSelection")} style={{ marginBottom: SP.md }}>
            <Banner tone="warning" icon="library-outline" title="Choose your electives">
              {`${electivesPending} elective group${electivesPending === 1 ? "" : "s"} waiting. Tap to choose your subjects for this semester.`}
            </Banner>
          </TouchableOpacity>
        )}

        {/* ── Attendance Card ── */}
        <Card style={styles.mainCard}>
          {activeLecture ? (
            <AttendanceCard
              lecture={activeLecture}
              lectureState={lectureState}
              timerSeconds={timerSeconds}
              markingStatus={markingStatus}
              userRole="student"
              markingMethod={markingMethod}
              alreadyMarked={alreadyMarked}
              markPending={markPending}
              onStartLecture={() => {}}
              onEndLecture={() => {}}
              onMarkAttendance={handleMarkAttendance}
              onMethodSelected={() => {}}
            />
          ) : scheduledNow ? (
            <ScheduledLectureCard lecture={scheduledNow} nowMin={nowMin} />
          ) : (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="cafe-outline" size={30} color={T.primary} />
              </View>
              <Text style={font.h3}>No ongoing lecture</Text>
              <Text style={[font.small, { marginTop: 2 }]}>You are free right now.</Text>
            </View>
          )}
        </Card>

        {/* ── Next Lecture ── */}
        {nextLecture && !activeLecture && (
          <Card style={{ marginTop: SP.md }}>
            <View style={styles.nextTop}>
              <Text style={font.label}>Next up</Text>
              <Chip
                label={nextLecture.day === today ? "Today" : nextLecture.day || ""}
                tone={nextLecture.day === today ? "info" : "warning"}
              />
            </View>
            <Text style={[font.h2, { marginTop: SP.sm }]}>{nextLecture.subject_name}</Text>
            <View style={styles.nextTime}>
              <Ionicons name="time-outline" size={15} color={T.primary} />
              <Text style={styles.nextTimeText}>{nextLecture.start_time}</Text>
              {!!nextLecture.room && (
                <>
                  <Text style={font.small}>·</Text>
                  <Ionicons name="location-outline" size={14} color={T.muted} />
                  <Text style={font.small}>{nextLecture.room}</Text>
                </>
              )}
            </View>
          </Card>
        )}

        {/* ── ToDo Section ── */}
        <View style={styles.todoHeader}>
          <Text style={font.h1}>To-do</Text>
          <Text style={[font.small, { marginTop: 2 }]}>Assignments and quizzes</Text>
        </View>

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
                <Text style={[styles.filterText, active && { color: T.primary }]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {todoLoading ? (
          <View style={styles.todoLoading}>
            <ActivityIndicator size="small" color={T.primary} />
            <Text style={font.small}>Loading</Text>
          </View>
        ) : todoItems.length === 0 ? (
          <Card flat style={styles.todoEmpty}>
            <Ionicons name="checkmark-done-circle-outline" size={36} color={T.muted} />
            <Text style={[font.body, { marginTop: SP.sm }]}>Nothing due in this period</Text>
          </Card>
        ) : (
          todoItems.map((item) => {
            const cfg       = statusConfig[item.status];
            const isAssign  = item.type === "assignment";
            const typeTone: Tone = isAssign ? "primary" : "info";
            return (
              <TouchableOpacity
                key={item.id}
                onPress={() => handleTodoPress(item)}
                activeOpacity={0.8}
              >
                <Card flat padded={false} style={styles.todoCard}>
                  <View style={[styles.todoIcon, { backgroundColor: isAssign ? T.primarySoft : T.infoSoft }]}>
                    <Ionicons
                      name={isAssign ? "document-text-outline" : "help-circle-outline"}
                      size={19}
                      color={isAssign ? T.primary : T.info}
                    />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={font.h3} numberOfLines={1}>{item.title}</Text>
                    <Text style={font.small} numberOfLines={1}>
                      {item.subject_name}{item.rawAssignment?.kind === "lab_work" ? " · Lab work" : ""}
                    </Text>
                    <View style={styles.metaRow}>
                      <Ionicons name="time-outline" size={11} color={T.muted} />
                      <Text style={font.small} numberOfLines={1}>
                        {item.type === "quiz" && item.startDate
                          ? `${fmtShortDate(item.startDate)} ${fmtTime(item.startDate)} - ${fmtShortDate(item.dueDate)} ${fmtTime(item.dueDate)}`
                          : `Due ${fmtShortDate(item.dueDate)} ${fmtTime(item.dueDate)}`}
                      </Text>
                    </View>
                  </View>
                  <Chip label={cfg.label} tone={cfg.tone} icon={cfg.icon} />
                </Card>
              </TouchableOpacity>
            );
          })
        )}

        <View style={{ height: 120 }} />
      </ScrollView>
    </Screen>
  );
};

export default StudentHome;

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  loader:  { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: T.bg },
  content: { paddingHorizontal: SP.xl, paddingTop: SP.lg },

  header: { flexDirection: "row", alignItems: "center", gap: SP.md, marginBottom: SP.xl },
  bell: {
    width: 44, height: 44, borderRadius: 15,
    backgroundColor: T.primarySoft, alignItems: "center", justifyContent: "center",
  },
  bellBadge: {
    position: "absolute", top: -4, right: -4,
    backgroundColor: T.danger, borderRadius: 10, minWidth: 18, height: 18,
    alignItems: "center", justifyContent: "center", paddingHorizontal: 3,
    borderWidth: 2, borderColor: T.bg,
  },
  bellBadgeText: { color: "#FFF", fontSize: 9, fontWeight: "800" },

  mainCard: { padding: SP.xl, minHeight: 190, justifyContent: "center", borderRadius: 26 },
  empty:    { alignItems: "center", justifyContent: "center", paddingVertical: SP.lg },
  emptyIcon: {
    width: 68, height: 68, borderRadius: 24, backgroundColor: T.primarySoft,
    alignItems: "center", justifyContent: "center", marginBottom: SP.md,
  },

  curRows:      { marginTop: SP.md, gap: 6 },
  curRow:       { flexDirection: "row", alignItems: "center", gap: 8 },
  curChips:     { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: SP.md },

  nextTop:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  nextTime:     { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  nextTimeText: { color: T.primary, fontWeight: "700", fontSize: 14 },

  todoHeader: { marginTop: SP.xxl, marginBottom: SP.md },
  filterRow:  { flexDirection: "row", gap: SP.sm, marginBottom: SP.lg },
  filterChip: {
    flex: 1, paddingVertical: 9, borderRadius: 12, backgroundColor: T.surface,
    alignItems: "center", borderWidth: 1.5, borderColor: T.line,
  },
  filterChipActive: { backgroundColor: T.primarySoft, borderColor: T.primary },
  filterText:       { fontSize: 12.5, fontWeight: "700", color: T.sub },

  todoLoading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 28 },
  todoEmpty:   { alignItems: "center", paddingVertical: 28 },

  todoCard: { flexDirection: "row", alignItems: "center", gap: SP.md, padding: SP.md, marginBottom: SP.sm },
  todoIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  metaRow:  { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 1 },
});