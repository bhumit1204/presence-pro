import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import AttendanceCalendar from "../../../components/AttendanceCalendar";
import { getUserSession } from "../../../services/session";
import CancelLectureModal from "../../../components/CancelLectureModal";
import AssignLectureModal from "../../../components/AssignLectureModal";
import { useNavigation } from "@react-navigation/native";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";

// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

// ── helper: build today's date object in the same shape the calendar uses ──
function getTodayObj() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, date: now.getDate() };
}

function formatDateObj(dateObj: { year: number; month: number; date: number }) {
  return `${dateObj.year}-${String(dateObj.month).padStart(2, "0")}-${String(dateObj.date).padStart(2, "0")}`;
}

export default function LectureSchedule() {
  // ── FIX BUG 2: initialise to today instead of null ──────────────────────
  // When selectedDate is null, the AssignLectureModal receives an empty string
  // as its `selectedDate` prop. The backend then calls getDayNameFromDate("")
  // which silently computes the wrong day (often tomorrow), so the free-teacher
  // list shows tomorrow's availability instead of today's.
  const [selectedDate, setSelectedDate] = useState<any>(getTodayObj());
  const [lectures, setLectures]         = useState<any[]>([]);
  const [loading, setLoading]           = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedLecture, setSelectedLecture] = useState<any>(null);
  const [assignModalVisible, setAssignModalVisible] = useState(false);
  const [assignLecture, setAssignLecture] = useState<any>(null);
  const navigation = useNavigation();

  /* ----------------------------- */
  /* FETCH LECTURES BY DATE        */
  /* ----------------------------- */

  const fetchLectures = async (dateObj: any) => {
    try {
      setLoading(true);
      const session = await getUserSession();
      const formattedDate = formatDateObj(dateObj);
      const res  = await fetch(`${API_URL}/api/lectures/today?uid=${session.uid}&date=${formattedDate}`);
      const data = await res.json();
      if (data.success) setLectures(data.lectures || []);
    } catch (e) {
      console.log("FETCH ERROR:", e);
    } finally {
      setLoading(false);
    }
  };

  // Fetch today's lectures on mount using the already-initialised selectedDate
  useEffect(() => {
    fetchLectures(getTodayObj());
  }, []);

  /* ----------------------------- */
  /* DATE SELECT                   */
  /* ----------------------------- */

  const handleDateSelect = (date: any) => {
    setSelectedDate(date);
    fetchLectures(date);
  };

  const handleCancel = async (lecture: any) => {
    try {
      const session = await getUserSession();
      const formattedDate = formatDateObj(selectedDate);

      await fetch(`${API_URL}/api/lectures/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lecture_id:  lecture.id,
          teacher_uid: session.uid,
          date:        formattedDate,
        }),
      });

      setLectures((prev) => prev.filter((l) => l.id !== lecture.id));
    } catch (e) {
      console.log("CANCEL ERROR:", e);
    }
  };

  /* ----------------------------- */
  /* UI                            */
  /* ----------------------------- */

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>

      {/* HEADER */}
      <Text style={styles.title}>My Schedule</Text>

      {/* CALENDAR */}
      <AttendanceCalendar onDateSelect={handleDateSelect} mode="future" />

      {/* LOADING */}
      {loading && (
        <ActivityIndicator size="large" color={PRIMARY} style={{ marginTop: 20 }} />
      )}

      {/* LECTURES LIST */}
      {!loading && lectures.length === 0 && (
        <Text style={styles.emptyText}>No lectures for selected day</Text>
      )}

      {lectures.map((lecture, index) => (
        <View key={index} style={styles.card}>

          {/* SUBJECT */}
          <Text style={styles.subject}>{lecture.subject_name}</Text>

          {/* TIME */}
          <Text style={styles.time}>{lecture.start_time} - {lecture.end_time}</Text>

          {/* SUB DETAILS */}
          <View style={styles.row}>
            <Text style={styles.subText}>{lecture.course_abbr || "Course"}</Text>
          </View>

          {/* BUTTONS */}
          <View style={styles.btnRow}>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => {
                setSelectedLecture(lecture);
                setModalVisible(true);
              }}
            >
              <Text style={styles.cancelText}>Cancel Lecture</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.assignBtn}
              onPress={() => {
                setAssignLecture(lecture);
                setAssignModalVisible(true);
              }}
            >
              <Text style={styles.assignText}>Assign Lecture</Text>
            </TouchableOpacity>
          </View>

        </View>
      ))}

      {/* ── FIX BUG 2: selectedDate is always a valid date object now, ──────
          so formatDateObj() always produces a real YYYY-MM-DD string and
          the backend's /teachers/available returns the correct day's list. */}
      <AssignLectureModal
        visible={assignModalVisible}
        onClose={() => setAssignModalVisible(false)}
        lecture={assignLecture}
        selectedDate={formatDateObj(selectedDate)}
        onSuccess={() => {
          setLectures((prev) =>
            prev.map((l) => l.id === assignLecture?.id ? { ...l, is_assigned: true } : l)
          );
        }}
      />

      <CancelLectureModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onCancelLecture={() => {
          handleCancel(selectedLecture);
          setModalVisible(false);
        }}
        onAssign={() => {
          setModalVisible(false);
        }}
      />

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    padding: 20,
    paddingTop: 60,
    paddingBottom: 40,
  },
  title: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#111",
    marginBottom: 12,
  },
  takeBtn: {
    backgroundColor: "#2ECC71",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 100,
  },
  takeText: {
    color: "#fff",
    fontWeight: "600",
  },
  card: {
    backgroundColor: "#fff",
    padding: 16,
    borderRadius: 16,
    marginTop: 16,
    elevation: 3,
    position: "relative",
  },
  subject: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#111",
  },
  time: {
    marginTop: 4,
    color: PRIMARY,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },
  subText: {
    color: "#666",
    fontSize: 13,
  },
  btnRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 16,
  },
  cancelBtn: {
    borderWidth: 1,
    borderColor: PRIMARY,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 100,
  },
  cancelText: {
    color: PRIMARY,
    fontWeight: "600",
  },
  assignBtn: {
    backgroundColor: PRIMARY,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 100,
  },
  assignText: {
    color: "#fff",
    fontWeight: "600",
  },
  emptyText: {
    marginTop: 20,
    textAlign: "center",
    color: "#888",
  },
});