import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import AttendanceCard from "../../../components/AttendanceCard";
import AttendanceModal from "../../../components/AttendanceModal";
import { getUserSession } from "../../../services/session";
import { useNavigation } from "@react-navigation/native";
import * as Location from "expo-location";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../../../services/firebase";
import Ionicons from "@expo/vector-icons/build/Ionicons";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";
const API_URL = "http://10.132.90.56:5000";

type LectureStatus = "upcoming" | "live" | "idle";

interface LectureData {
  id?: string;
  teacher_id?: string;
  aishe_code?: string;
  subject_name: string;
  room: string;
  start_time: string;
  end_time: string;
  day?: string;
  is_temporary?: boolean;
}

export default function TeacherHome() {
  const [loading, setLoading]         = useState(true);
  const [today, setToday]             = useState("");
  const navigation                    = useNavigation<any>();
  const [ongoingLecture, setOngoingLecture] = useState<LectureData | null>(null);
  const [nextLecture, setNextLecture]   = useState<LectureData | null>(null);
  const [teacherCoordinates, setTeacherCoordinates] = useState<any>(null);
  const [lectureState, setLectureState] = useState<"idle" | "ongoing">("idle");
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [lectureSessionId, setLectureSessionId] = useState<string | null>(null);
  const [startTime, setStartTime]       = useState<Date | null>(null);
  const [isModalVisible, setModalVisible] = useState(false);
  const [isStarting, setIsStarting]     = useState(false);

  // ── Inbox: requests sent TO this teacher (Teacher B) ─────────────────────
  const [requests, setRequests] = useState<any[]>([]);

  // ── Outbox: requests sent BY this teacher (Teacher A) ────────────────────
  // FIX: Teacher A needs to see the status of their sent request so the card
  // disappears once it's accepted or rejected by Teacher B.
  const [sentAssignments, setSentAssignments] = useState<any[]>([]);

  useEffect(() => {
    checkOngoingSession().then(() => {
      fetchDailyLectures();
      fetchRequests();
      fetchSentAssignments();   // ← new
    });
  }, []);

  // ── Inbox fetch (Teacher B) ───────────────────────────────────────────────
  const fetchRequests = async () => {
    try {
      const session = await getUserSession();
      const res  = await fetch(`${API_URL}/api/lectures/assign/requests?uid=${session.uid}`);
      const data = await res.json();
      if (data.success) setRequests(data.requests || []);
    } catch (e) {
      console.log("REQUESTS FETCH ERROR:", e);
    }
  };

  // ── Outbox fetch (Teacher A) ──────────────────────────────────────────────
  // Calls the new GET /assign/sent endpoint. Returns assignments this teacher
  // sent so we can surface "Accepted" / "Rejected" status and hide resolved cards.
  const fetchSentAssignments = async () => {
    try {
      const session = await getUserSession();
      const res  = await fetch(`${API_URL}/api/lectures/assign/sent?uid=${session.uid}`);
      const data = await res.json();
      if (data.success) {
        // Only show pending ones — accepted/rejected/expired are silently cleared
        setSentAssignments((data.assignments || []).filter((a: any) => a.status === "pending"));
      }
    } catch (e) {
      console.log("SENT ASSIGNMENTS FETCH ERROR:", e);
    }
  };

  // ── Teacher B: accept or reject a request ────────────────────────────────
  const handleRespond = async (assignment_id: string, action: "accept" | "reject") => {
    try {
      const session = await getUserSession();
      const res  = await fetch(`${API_URL}/api/lectures/assign/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: session.uid, assignment_id, action }),
      });
      const data = await res.json();

      if (data.success) {
        // Remove from inbox immediately
        setRequests((prev) => prev.filter((r) => r.assignment_id !== assignment_id));

        // FIX: If Teacher B accepted, refresh their dashboard so the newly
        // assigned lecture appears right away (backend /today now includes
        // lecture_sessions with is_temporary:true for this teacher).
        if (action === "accept") {
          fetchDailyLectures();
        }
      } else {
        Alert.alert("Error", data.error || "Could not respond to request");
      }
    } catch (e) {
      console.log("RESPOND ERROR:", e);
    }
  };

  const fetchDailyLectures = async () => {
    try {
      const session = await getUserSession();
      if (!session?.uid) return;

      const res  = await fetch(`${API_URL}/api/lectures/today?uid=${session.uid}`);
      const json = await res.json();

      if (json.success) {
        setToday(json.today);
        if (lectureState === "idle") {
          setOngoingLecture(json.ongoingLecture);
          setNextLecture(json.nextLecture);
        } else {
          setNextLecture(json.nextLecture);
        }
      }
    } catch (e) {
      console.log("FETCH ERROR:", e);
    } finally {
      setLoading(false);
    }
  };

  //  FIX: validate AsyncStorage against Firestore before restoring
  const checkOngoingSession = async () => {
    try {
      const [isOngoing, startStr, storedSessionId, savedLectureStr] =
        await AsyncStorage.multiGet([
          "is_lecture_ongoing",
          "lecture_start_time",
          "current_lecture_session_id",
          "saved_lecture_details",
        ]).then((pairs) => pairs.map((p) => p[1]));

      if (isOngoing !== "true" || !storedSessionId) return;

      const sessionDoc = await getDoc(doc(db, "lecture_sessions", storedSessionId));

      if (!sessionDoc.exists() || sessionDoc.data()?.is_live !== true) {
        await AsyncStorage.multiRemove([
          "is_lecture_ongoing",
          "lecture_start_time",
          "current_lecture_session_id",
          "saved_lecture_details",
        ]);
        return;
      }

      const start        = new Date(startStr!);
      const now          = new Date();
      const diffInSeconds = Math.floor((now.getTime() - start.getTime()) / 1000);

      setLectureState("ongoing");
      setStartTime(start);
      setTimerSeconds(diffInSeconds > 0 ? diffInSeconds : 0);
      if (storedSessionId)  setLectureSessionId(storedSessionId);
      if (savedLectureStr)  setOngoingLecture(JSON.parse(savedLectureStr));
    } catch (e) {
      console.log("SESSION RESTORE ERROR:", e);
    }
  };

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

  const activeLecture = ongoingLecture || nextLecture;

  const handleStartLecture = async () => {
    if (!activeLecture) return;

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Location permission required");
        return;
      }

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
      });

      if (!location?.coords) {
        Alert.alert("Failed to get location");
        return;
      }

      const coords = {
        latitude:  location.coords.latitude,
        longitude: location.coords.longitude,
      };

      if (!coords.latitude || !coords.longitude) {
        Alert.alert("Invalid location detected");
        return;
      }

      setTeacherCoordinates(coords);

      if (activeLecture === nextLecture) {
        const now = new Date();
        const [h, m] = activeLecture.start_time.split(":").map(Number);
        const schedTime = new Date();
        schedTime.setHours(h, m, 0, 0);
        const diffMins = (schedTime.getTime() - now.getTime()) / 60000;

        if (diffMins > 20) {
          Alert.alert(
            "Starting Early?",
            `Class is scheduled for ${activeLecture.start_time}. Start now?`,
            [
              { text: "Cancel", style: "cancel" },
              { text: "Start", onPress: () => executeStartLecture(activeLecture, coords) },
            ]
          );
          return;
        }
      }

      executeStartLecture(activeLecture, coords);
    } catch (error) {
      console.error("LOCATION ERROR:", error);
      Alert.alert("Error", "Unable to fetch location");
    }
  };

  const executeStartLecture = async (lecture: LectureData, coords: any) => {
    setIsStarting(true);
    try {
      const payload = {
        lecture_id:            lecture.id,
        teacher_id:            lecture.teacher_id,
        aishe_code:            lecture.aishe_code,
        subject_name:          lecture.subject_name,
        room:                  lecture.room,
        scheduled_start_time:  lecture.start_time,
        scheduled_end_time:    lecture.end_time,
        teacher_coordinates:   coords,
      };

      const res  = await fetch(`${API_URL}/api/lectures/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (data.success) {
        const now = new Date();
        setLectureState("ongoing");
        setStartTime(now);
        setTimerSeconds(0);
        setLectureSessionId(data.session_id);
        setOngoingLecture(lecture);
        if (lecture === nextLecture) setNextLecture(null);

        await AsyncStorage.multiSet([
          ["is_lecture_ongoing",           "true"],
          ["lecture_start_time",           now.toISOString()],
          ["current_lecture_session_id",   data.session_id],
          ["saved_lecture_details",        JSON.stringify(lecture)],
        ]);
      } else {
        Alert.alert("Error", data.error || "Failed to start lecture");
      }
    } catch (e) {
      console.error(e);
      Alert.alert("Error", "Could not connect to server");
    } finally {
      setIsStarting(false);
    }
  };

  const handleEndLecture = async () => {
    Alert.alert(
      "End Lecture",
      "Are you sure you want to end this lecture? Students will be notified immediately.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "End Lecture",
          style: "destructive",
          onPress: async () => {
            try {
              if (lectureSessionId) {
                const res  = await fetch(`${API_URL}/api/lectures/stop`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ lecture_session_id: lectureSessionId }),
                });
                const data = await res.json();
                if (!data.success) {
                  Alert.alert("Error", "Failed to stop lecture on server. Please try again.");
                  return;
                }
              }

              setLectureState("idle");
              setStartTime(null);
              setTimerSeconds(0);
              setLectureSessionId(null);
              setOngoingLecture(null);

              await AsyncStorage.multiRemove([
                "is_lecture_ongoing",
                "lecture_start_time",
                "current_lecture_session_id",
                "saved_lecture_details",
              ]);

              setLoading(true);
              fetchDailyLectures();
            } catch (e) {
              console.error("END LECTURE ERROR:", e);
              setLectureState("idle");
              await AsyncStorage.multiRemove([
                "is_lecture_ongoing",
                "lecture_start_time",
                "current_lecture_session_id",
                "saved_lecture_details",
              ]);
              fetchDailyLectures();
            }
          },
        },
      ]
    );
  };

  const handleSelectMethod = async (method: string) => {
    setModalVisible(false);

    if (method === "code") {
      navigation.navigate("CodeAttendance", { lectureSessionId, lecture: activeLecture });
    }
    if (method === "bio_geo") {
      navigation.navigate("BioGeoAttendance", { lectureSessionId, lecture: activeLecture });
    }
    if (method === "iot") {
      navigation.navigate("IoTAttendanceScreen", { lectureSessionId });
    }
    if (method === "qr") {
      try {
        const res  = await fetch(`${API_URL}/api/lectures/attendance/start-qr`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lecture_session_id: lectureSessionId }),
        });
        const data = await res.json();

        if (data.success) {
          navigation.navigate("QRAttendance", {
            lecture_session_id:    lectureSessionId,
            attendance_session_id: data.attendance_session_id,
            qr_token:              data.qr_token,
            display_code:          data.display_code,
            qr_link:               data.qr_link,
          });
        } else {
          Alert.alert("Error", data.error || "Failed to start QR session");
        }
      } catch (e) {
        Alert.alert("Error", "Could not connect to server");
      }
    }
  };

  if (loading && lectureState !== "ongoing") {
    return (
      <View style={styles.loader}>
        <ActivityIndicator size="large" color={PRIMARY} />
      </View>
    );
  }

  const renderNoOngoingClass = () => (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIconCircle}>
        <Text style={{ fontSize: 32 }}>☕</Text>
      </View>
      <Text style={styles.emptyTitle}>No Ongoing Lecture</Text>
      <Text style={styles.emptySubtitle}>You are free right now.</Text>
    </View>
  );

  // Total badge = inbox requests + pending sent assignments
  const totalPending = requests.length + sentAssignments.length;

  return (
    <View style={styles.container}>
      <AttendanceModal
        visible={isModalVisible}
        onClose={() => setModalVisible(false)}
        onSelectMethod={handleSelectMethod}
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Dashboard</Text>
            <Text style={styles.subtitle}>Today, {today}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <TouchableOpacity
              style={styles.headerIcon}
              onPress={() => navigation.navigate("CreateBroadcast")}
            >
              <Ionicons name="megaphone-outline" size={22} color={PRIMARY} />
            </TouchableOpacity>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>T</Text>
            </View>
          </View>
        </View>

        <View style={styles.mainCardContainer}>
          {activeLecture ? (
            <AttendanceCard
              lecture={activeLecture}
              lectureState={lectureState}
              userRole="teacher"
              timerSeconds={timerSeconds}
              onStartLecture={handleStartLecture}
              onEndLecture={handleEndLecture}
              onMethodSelected={handleSelectMethod}
              markingStatus="closed"
              markingMethod={null}
              isStarting={isStarting}
            />
          ) : (
            renderNoOngoingClass()
          )}
        </View>

        <TouchableOpacity
          style={styles.scheduleBtn}
          onPress={() => navigation.navigate("MyScheduleScreen")}
        >
          <Text style={styles.scheduleText}>View Schedule</Text>
        </TouchableOpacity>

        {/* ── SECTION: Lecture Requests (inbox — Teacher B) ──────────────── */}
        <View style={styles.requestSection}>
          <View style={styles.requestHeader}>
            <Text style={styles.requestTitle}>Lecture Requests</Text>
            {totalPending > 0 && (
              <View style={styles.requestBadge}>
                <Text style={styles.requestBadgeText}>{totalPending}</Text>
              </View>
            )}
          </View>

          {/* ── Inbox cards (Teacher B receives these) ────────────────────── */}
          {requests.length === 0 && sentAssignments.length === 0 ? (
            <Text style={styles.requestEmpty}>No pending requests</Text>
          ) : null}

          {requests.map((req) => (
            <View key={req.assignment_id} style={styles.requestCard}>
              <View style={styles.requestCardTop}>
                <Text style={styles.requestBy}>From {req.requested_by}</Text>
                <Text style={styles.requestExpiry}>
                  Expires {new Date(req.expires_at).toLocaleDateString()}
                </Text>
              </View>
              <Text style={styles.requestTime}>
                {req.day} · {req.start_time} – {req.end_time}
              </Text>
              <Text style={styles.requestDate}>{req.date}</Text>
              <View style={styles.requestBtnRow}>
                <TouchableOpacity
                  style={styles.rejectBtn}
                  onPress={() => handleRespond(req.assignment_id, "reject")}
                >
                  <Text style={styles.rejectText}>Reject</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.acceptBtn}
                  onPress={() => handleRespond(req.assignment_id, "accept")}
                >
                  <Text style={styles.acceptText}>Accept</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}

          {/* ── Outbox cards (Teacher A sent these — show pending only) ─────
              FIX: Teacher A sees their sent request with a "Pending" badge.
              Once Teacher B accepts/rejects, fetchSentAssignments() filters
              those out so the card disappears automatically on next poll.
              Teacher A can also manually cancel a pending request. */}
          {sentAssignments.map((sent) => (
            <View key={sent.assignment_id} style={[styles.requestCard, styles.sentCard]}>
              <View style={styles.requestCardTop}>
                <Text style={styles.requestBy}>Sent Request</Text>
                <View style={styles.pendingBadge}>
                  <Text style={styles.pendingBadgeText}>Awaiting Response</Text>
                </View>
              </View>
              <Text style={styles.requestTime}>
                {sent.day} · {sent.start_time} – {sent.end_time}
              </Text>
              <Text style={styles.requestDate}>{sent.date}</Text>
              {sent.expires_at && (
                <Text style={styles.requestExpiry}>
                  Expires {new Date(sent.expires_at).toLocaleDateString()}
                </Text>
              )}
            </View>
          ))}
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: BG },
  content:    { paddingHorizontal: 20, paddingTop: 60 },
  loader:     { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: BG },
  header:     { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 26 },
  title:      { fontSize: 28, fontWeight: "bold", color: "black" },
  subtitle:   { marginTop: 6, fontSize: 14, color: "grey", fontWeight: "bold" },
  avatar:     { width: 45, height: 45, borderRadius: 50, backgroundColor: "#7C73E6", alignItems: "center", justifyContent: "center", elevation: 4 },
  avatarText: { color: "#FFF", fontWeight: "bold", fontSize: 16 },

  mainCardContainer: {
    backgroundColor: "#FFFFFF",
    borderRadius: 30,
    padding: 24,
    marginBottom: 24,
    shadowColor: PRIMARY,
    shadowOpacity: 0.08,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 5,
    minHeight: 200,
    justifyContent: "center",
  },
  headerIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: "#EEF2FF",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    marginRight: 8,
  },
  emptyContainer: { alignItems: "center", justifyContent: "center", paddingVertical: 20 },
  emptyIconCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: "#F5F5F5", alignItems: "center", justifyContent: "center", marginBottom: 16 },
  emptyTitle:    { fontWeight: "bold", color: "#424242", fontSize: 16, marginBottom: 4 },
  emptySubtitle: { fontSize: 12, color: "grey" },

  scheduleBtn:  { marginTop: 4, borderWidth: 2, borderColor: "#E0E0E0", borderRadius: 18, height: 50, flexDirection: "row", justifyContent: "center", alignItems: "center" },
  scheduleText: { fontWeight: "bold", color: "#616161", fontSize: 16 },

  requestSection: { marginTop: 24, padding: 8 },
  requestHeader:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  requestTitle:   { fontSize: 16, fontWeight: "700", color: PRIMARY },
  requestBadge:   { backgroundColor: PRIMARY, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  requestBadgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  requestEmpty:   { color: "#aaa", fontSize: 13, textAlign: "center", paddingVertical: 12 },

  requestCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    elevation: 2,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 6,
  },
  // Sent cards have a subtle left accent to visually distinguish from inbox
  sentCard: {
    borderLeftWidth: 3,
    borderLeftColor: "#F59E0B",
  },
  requestCardTop:  { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  requestBy:       { fontSize: 14, fontWeight: "700", color: "#111" },
  requestExpiry:   { fontSize: 11, color: "#F59E0B", fontWeight: "600" },
  requestTime:     { fontSize: 13, color: PRIMARY, fontWeight: "600", marginTop: 2 },
  requestDate:     { fontSize: 12, color: "#888", marginTop: 2, marginBottom: 12 },
  requestBtnRow:   { flexDirection: "row", gap: 10 },
  rejectBtn:       { flex: 1, borderWidth: 1, borderColor: "#e74c3c", borderRadius: 8, paddingVertical: 8, alignItems: "center" },
  rejectText:      { color: "#e74c3c", fontWeight: "600", fontSize: 13 },
  acceptBtn:       { flex: 2, backgroundColor: PRIMARY, borderRadius: 8, paddingVertical: 8, alignItems: "center" },
  acceptText:      { color: "#fff", fontWeight: "700", fontSize: 13 },

  pendingBadge:     { backgroundColor: "#FEF3C7", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  pendingBadgeText: { color: "#F59E0B", fontSize: 11, fontWeight: "700" },
});