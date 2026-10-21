// src/screens/teacher/tabs/TeacherToday.tsx
// The teacher's home: the class happening now (start / attendance / end), things that need a reply,
// and a 7-day schedule. Everything a teacher does every day starts here.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { doc, getDoc } from "firebase/firestore";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { db } from "../../../services/firebase";
import { useOnTabActive, useTab } from "../../../navigation/TabContext";
import AttendanceCard from "../../../components/AttendanceCard";
import { Avatar, Banner, Button, Card, Sheet, T, SP, font } from "../../../components/ui";
import { DayLectures, ListCard, ListRow, enc, getJson, greeting, longDay, postJson, useInbox, useTeacher, ymd } from "../teacherShared";
import { lectureTag, withTag } from "../../../utils/batches";

const SESSION_KEYS = ["is_lecture_ongoing", "lecture_start_time", "current_lecture_session_id", "saved_lecture_details"];
const GUIDE_KEY = "tp_guide_seen_v1";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Lecture = {
  id?: string;
  teacher_id?: string;
  aishe_code?: string;
  subject_name: string;
  room: string;
  start_time: string;
  end_time: string;
  day?: string;
  is_temporary?: boolean;
  kind?: string | null;          // "lab" | "tutorial" | null (plain lecture)
  batch?: string | null;         // lab batch, e.g. "B1"
  batch_no?: number | null;
  division_name?: string | null;
};

export default function TeacherToday() {
  const navigation = useNavigation<any>();
  const { setCurrentTab } = useTab();
  const teacher = useTeacher();
  const inbox = useInbox();

  const [sessionReq, setSessionReq] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ongoing, setOngoing] = useState<Lecture | null>(null);
  const [next, setNext] = useState<Lecture | null>(null);
  const [state, setState] = useState<"idle" | "ongoing">("idle");
  const stateRef = useRef<"idle" | "ongoing">("idle");
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [liveQuizzes, setLiveQuizzes] = useState<any[]>([]);
  const [showGuide, setShowGuide] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [dayIdx, setDayIdx] = useState(0);
  const [dayKey, setDayKey] = useState(0);

  const setLectureState = (s: "idle" | "ongoing") => {
    stateRef.current = s;
    setState(s);
  };

  /* ── restore a running lecture (validated against Firestore so a stale flag never traps the user) ── */
  const restoreSession = useCallback(async () => {
    try {
      const pairs = await AsyncStorage.multiGet(SESSION_KEYS);
      const [isOn, startStr, sid, saved] = pairs.map((p) => p[1]);
      if (isOn !== "true" || !sid) return;
      const snap = await getDoc(doc(db, "lecture_sessions", sid));
      if (!snap.exists() || snap.data()?.is_live !== true) {
        await AsyncStorage.multiRemove(SESSION_KEYS);
        return;
      }
      const start = new Date(startStr!);
      setLectureState("ongoing");
      setStartedAt(start);
      setSeconds(Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000)));
      setSessionId(sid);
      if (saved) setOngoing(JSON.parse(saved));
    } catch (e) {
      console.log("SESSION RESTORE ERROR:", e);
    }
  }, []);

  const loadHome = useCallback(async () => {
    try {
      const j = await getJson(`/api/lectures/today?uid=${enc(teacher.uid)}`);
      if (stateRef.current === "idle") setOngoing(j.ongoingLecture || null);
      setNext(j.nextLecture || null);
      setLoadError(null);
      try {
        const sr = await getJson(`/api/web/teacher/session-requests?uid=${enc(teacher.uid)}`);
        setSessionReq((sr.pending || 0) + (sr.notices || []).length);
      } catch { /* the rest of the day still works */ }
    } catch (e: any) {
      setLoadError(e?.message || "Could not load your day.");
    }
  }, [teacher.uid]);

  const loadQuizzes = useCallback(async () => {
    if (!teacher.teacherId) return;
    try {
      const j = await getJson(`/api/quizzes/teacher/${enc(teacher.teacherId)}`);
      const now = Date.now();
      setLiveQuizzes((j.quizzes || []).filter((q: any) => new Date(q.scheduled_start).getTime() <= now && now <= new Date(q.scheduled_end).getTime()));
    } catch {}
  }, [teacher.teacherId]);

  const loadAll = useCallback(async () => {
    await restoreSession();
    await Promise.all([loadHome(), loadQuizzes(), inbox.refresh()]);
    try {
      setShowGuide((await AsyncStorage.getItem(GUIDE_KEY)) !== "1");
    } catch {}
    setLoading(false);
    setRefreshing(false);
    setDayKey((k) => k + 1);
  }, [restoreSession, loadHome, loadQuizzes, inbox.refresh]);

  useOnTabActive("today", () => {
    loadAll();
  });

  /* ── timer ── */
  useEffect(() => {
    if (state !== "ongoing" || !startedAt) return;
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state, startedAt]);

  const todayName = WEEKDAYS[new Date().getDay()];
  const active: Lecture | null = ongoing || next;
  const activeIsLater = !!active && !ongoing && !!active.day && !active.is_temporary && active.day !== todayName;

  /* ── start / end ── */
  const run = async (lecture: Lecture, coords: { latitude: number; longitude: number }) => {
    setStarting(true);
    try {
      const j = await postJson("/api/lectures/start", {
        lecture_id: lecture.id,
        teacher_id: lecture.teacher_id,
        aishe_code: lecture.aishe_code,
        subject_name: lecture.subject_name,
        room: lecture.room,
        scheduled_start_time: lecture.start_time,
        scheduled_end_time: lecture.end_time,
        teacher_coordinates: coords,
      });
      const now = new Date();
      setLectureState("ongoing");
      setStartedAt(now);
      setSeconds(0);
      setSessionId(j.session_id);
      setOngoing(lecture);
      if (lecture === next) setNext(null);
      await AsyncStorage.multiSet([
        ["is_lecture_ongoing", "true"],
        ["lecture_start_time", now.toISOString()],
        ["current_lecture_session_id", j.session_id],
        ["saved_lecture_details", JSON.stringify(lecture)],
      ]);
    } catch (e: any) {
      Alert.alert("Could not start", e?.message || "Could not connect to the server.");
    } finally {
      setStarting(false);
    }
  };

  const onStart = async () => {
    if (!active || starting) return;
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert("Location needed", "Allow location so students can be checked against your room. You can enable it in Settings.");
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
      const coords = { latitude: loc?.coords?.latitude, longitude: loc?.coords?.longitude };
      if (!coords.latitude || !coords.longitude) {
        Alert.alert("Location unavailable", "Could not read your location. Move near a window and try again.");
        return;
      }
      if (active === next) {
        const [h, m] = active.start_time.split(":").map(Number);
        const sched = new Date();
        sched.setHours(h, m, 0, 0);
        if ((sched.getTime() - Date.now()) / 60000 > 20) {
          Alert.alert("Start early?", `This class is scheduled for ${active.start_time}. Start now?`, [
            { text: "Not yet", style: "cancel" },
            { text: "Start now", onPress: () => run(active, coords as any) },
          ]);
          return;
        }
      }
      run(active, coords as any);
    } catch {
      Alert.alert("Location error", "Unable to read your location. Check that location services are on.");
    }
  };

  const onEnd = () => {
    Alert.alert("End this class?", "Students are told the class has ended.", [
      { text: "Keep going", style: "cancel" },
      {
        text: "End class",
        style: "destructive",
        onPress: async () => {
          try {
            if (sessionId) await postJson("/api/lectures/stop", { lecture_session_id: sessionId });
          } catch (e: any) {
            Alert.alert("Could not end the class", e?.message || "Please try again.");
            return;
          }
          setLectureState("idle");
          setStartedAt(null);
          setSeconds(0);
          setSessionId(null);
          setOngoing(null);
          await AsyncStorage.multiRemove(SESSION_KEYS);
          loadHome();
        },
      },
    ]);
  };

  const onMethod = async (method: string) => {
    const lecture = withTag(active, true);   // the screens print subject_name: it carries "(Lab · B1 · Div A)"
    if (method === "code") return navigation.navigate("CodeAttendance", { lectureSessionId: sessionId, lecture });
    if (method === "bio_geo") return navigation.navigate("BioGeoAttendance", { lectureSessionId: sessionId, lecture });
    if (method === "multi") return navigation.navigate("MultiAttendance", { lectureSessionId: sessionId, lecture });
    if (method === "iot") return navigation.navigate("IoTAttendanceScreen", { lectureSessionId: sessionId });
    if (method === "qr") {
      try {
        const j = await postJson("/api/lectures/attendance/start-qr", { lecture_session_id: sessionId });
        navigation.navigate("QRAttendance", {
          lecture_session_id: sessionId,
          attendance_session_id: j.attendance_session_id,
          qr_token: j.qr_token,
          display_code: j.display_code,
          qr_link: j.qr_link,
        });
      } catch (e: any) {
        Alert.alert("Could not start QR", e?.message || "Could not connect to the server.");
      }
    }
  };

  const dismissGuide = async () => {
    setShowGuide(false);
    try {
      await AsyncStorage.setItem(GUIDE_KEY, "1");
    } catch {}
  };

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    return d;
  });
  const dayLabel = (d: Date, i: number) => (i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" }));

  const attention = inbox.requests.length + inbox.odPending + liveQuizzes.length + sessionReq;

  if (loading && state !== "ongoing") {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={T.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: T.bg }}
      contentContainerStyle={{ paddingHorizontal: SP.xl, paddingTop: SP.xxl + 24, paddingBottom: 140 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadAll(); }} tintColor={T.primary} />}
    >
      {/* header */}
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: SP.xxl }}>
        <View style={{ flex: 1 }}>
          <Text style={font.small}>{longDay(new Date())}</Text>
          <Text style={[font.h1, { marginTop: 2 }]} numberOfLines={1}>
            {greeting()}{teacher.firstName ? `, ${teacher.firstName}` : ""}
          </Text>
        </View>
        <Pressable onPress={() => setCurrentTab("profile")} accessibilityRole="button" accessibilityLabel="Open your profile">
          <Avatar name={teacher.name} tone="primary" size={44} initials />
        </Pressable>
      </View>

      {showGuide && (
        <Pressable onPress={() => setTourOpen(true)} accessibilityRole="button" style={{ marginBottom: SP.xl }}>
          <Card tone="primary" padded={false}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md, padding: SP.md + 2 }}>
              <Ionicons name="sparkles" size={18} color={T.primary} />
              <Text style={[font.h3, { flex: 1, color: T.primary }]}>Quick tour</Text>
              <Pressable onPress={dismissGuide} hitSlop={10} accessibilityLabel="Dismiss tour">
                <Ionicons name="close" size={18} color={T.primary} />
              </Pressable>
            </View>
          </Card>
        </Pressable>
      )}

      {!!loadError && <Banner tone="danger" style={{ marginBottom: SP.lg }}>{loadError}</Banner>}

      {/* now / next */}
      {active && !activeIsLater ? (
        <Card style={{ marginBottom: SP.xxl, padding: SP.xl }}>
          <AttendanceCard
            lecture={withTag(active, true) as any}
            lectureState={state}
            userRole="teacher"
            timerSeconds={seconds}
            onStartLecture={onStart}
            onEndLecture={onEnd}
            onMethodSelected={onMethod}
            markingStatus="closed"
            markingMethod={null}
            isStarting={starting}
          />
        </Card>
      ) : (
        <Card flat style={{ marginBottom: SP.xxl }}>
          <Text style={font.h3}>{active ? "No more classes today" : "You are free"}</Text>
          <Text style={[font.body, { marginTop: 2 }]}>
            {active ? `Next: ${active.day}, ${active.start_time}${lectureTag(active, true) ? ` · ${active.subject_name} (${lectureTag(active, true)})` : ""}` : "Nothing scheduled"}
          </Text>
        </Card>
      )}

      {/* needs attention: one quiet list, details live in the Inbox */}
      {attention > 0 && (
        <View style={{ marginBottom: SP.xxl }}>
          <Text style={[font.h3, { marginBottom: SP.md }]}>To do</Text>
          <ListCard>
            {inbox.requests.length > 0 && (
              <ListRow
                icon="swap-horizontal"
                tone="info"
                title={`${inbox.requests.length} lecture request${inbox.requests.length === 1 ? "" : "s"}`}
                onPress={() => setCurrentTab("inbox")}
              />
            )}
            {sessionReq > 0 && (
              <ListRow
                icon="calendar-outline"
                tone="info"
                title={`${sessionReq} special session update${sessionReq === 1 ? "" : "s"}`}
                onPress={() => setCurrentTab("inbox")}
              />
            )}
            {inbox.odPending > 0 && (
              <ListRow
                icon="document-text-outline"
                tone="warning"
                title={`${inbox.odPending} OD request${inbox.odPending === 1 ? "" : "s"}`}
                onPress={() => navigation.navigate("ODRequestsTeacher", { teacherId: teacher.teacherId })}
              />
            )}
            {liveQuizzes.map((q) => (
              <ListRow
                key={q.quiz_id}
                icon="flash"
                tone="success"
                title={q.title}
                sub={`Live. Code ${q.join_code}`}
                onPress={() => navigation.navigate("ViewQuizScreen", { quiz_id: q.quiz_id })}
              />
            ))}
          </ListCard>
        </View>
      )}

      {/* schedule */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: SP.md }}>
        <Text style={font.h3}>Schedule</Text>
        <Pressable onPress={() => navigation.navigate("MyScheduleScreen")} hitSlop={8} accessibilityRole="link">
          <Text style={{ color: T.primary, fontWeight: "700", fontSize: 13 }}>Full calendar</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: SP.sm, paddingBottom: SP.lg }}>
        {days.map((d, i) => {
          const on = i === dayIdx;
          return (
            <Pressable
              key={i}
              onPress={() => setDayIdx(i)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={{ paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999, backgroundColor: on ? T.primary : "transparent", borderWidth: 1, borderColor: on ? T.primary : T.line }}
            >
              <Text style={{ fontSize: 13, fontWeight: "700", color: on ? "#fff" : T.sub }}>{dayLabel(d, i)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <DayLectures date={ymd(days[dayIdx])} refreshKey={dayKey} onChanged={loadHome} />

      <Sheet
        visible={tourOpen}
        onClose={() => setTourOpen(false)}
        title="Quick tour"
        footer={<Button label="Got it" onPress={() => { setTourOpen(false); dismissGuide(); }} style={{ marginTop: SP.md }} />}
      >
        <View style={{ gap: SP.lg, paddingVertical: SP.sm }}>
          {[
            ["today", "Today", "Your day and live class"],
            ["school", "Classes", "attendance, classwork, quizzes, reports"],
            ["notifications", "Inbox", "Requests and broadcasts"],
            ["person", "Profile", "Your details and log out"],
          ].map(([icon, title, text]) => (
            <View key={title} style={{ flexDirection: "row", gap: SP.md }}>
              <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: T.primarySoft, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name={icon as any} size={19} color={T.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={font.h3}>{title}</Text>
                <Text style={font.body}>{text}</Text>
              </View>
            </View>
          ))}
        </View>
      </Sheet>
    </ScrollView>
  );
}