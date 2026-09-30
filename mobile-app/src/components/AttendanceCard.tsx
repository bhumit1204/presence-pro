import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import AttendanceModal from "./AttendanceModal";

const PRIMARY = "#4834D4";
const DANGER = "#FF4757";
const SUCCESS = "#2ECC71";

interface AttendanceCardProps {
  lecture: any;
  lectureState: "idle" | "ongoing";
  userRole: "teacher" | "student";
  timerSeconds: number;
  onStartLecture: () => void;
  onEndLecture: () => void;
  onMethodSelected: (method: string) => void;
  markingStatus?: "open" | "closed";
  markingMethod?: string | null;
  alreadyMarked?: boolean;
  onMarkAttendance?: () => void;
  isStarting?: boolean;
}

export default function AttendanceCard({
  lecture,
  lectureState,
  userRole,
  timerSeconds,
  onStartLecture,
  onEndLecture,
  onMethodSelected,
  markingStatus,
  markingMethod,
  alreadyMarked,
  onMarkAttendance,
  isStarting = false,
}: AttendanceCardProps) {

  const [isModalVisible, setIsModalVisible] = useState(false);

  const formatTimer = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  if (!lecture) return null;

  return (
    <View style={styles.innerContainer}>
      <AttendanceModal
        visible={isModalVisible}
        onClose={() => setIsModalVisible(false)}
        onSelectMethod={(method) => {
          setIsModalVisible(false);
          onMethodSelected(method);
        }}
      />

      {/* STATUS */}
      <View style={styles.topRow}>
        <View style={styles.statusBadge}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: lectureState === "idle" ? "orange" : DANGER },
            ]}
          />
          <Text style={styles.statusText}>
            {lectureState === "idle" ? "Up Next" : "Live Now"}
          </Text>
        </View>
        <Text style={styles.timeRangeText}>
          {lecture.start_time} - {lecture.end_time}
        </Text>
      </View>

      <View style={{ height: 16 }} />

      <Text style={styles.subjectName}>{lecture.subject_name}</Text>
      <Text style={styles.roomText}>Room {lecture.room}</Text>

      <View style={{ height: 24 }} />

      {/* ========================= */}
      {/* 🔥 TEACHER UI */}
      {/* ========================= */}

      {userRole === "teacher" && lectureState === "idle" && (
        <TouchableOpacity
          style={[styles.startBtn, isStarting && { opacity: 0.75 }]}
          onPress={onStartLecture}
          disabled={isStarting}
        >
          {isStarting ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Text style={styles.startBtnText}>Start Lecture</Text>
          )}
        </TouchableOpacity>
      )}

      {userRole === "teacher" && lectureState === "ongoing" && (
        <>
          <Text style={styles.timerLabel}>Session Duration</Text>
          <Text style={styles.timerValue}>{formatTimer(timerSeconds)}</Text>

          <View style={{ height: 20 }} />

          <TouchableOpacity
            style={styles.attendanceBtn}
            onPress={() => setIsModalVisible(true)}
          >
            <Text style={styles.btnText}>Start Attendance</Text>
          </TouchableOpacity>

          <View style={{ height: 12 }} />

          <TouchableOpacity
            style={styles.endBtn}
            onPress={onEndLecture}
          >
            <Text style={styles.endBtnText}>End Class</Text>
          </TouchableOpacity>
        </>
      )}

      {/* ========================= */}
      {/* 🔥 STUDENT UI */}
      {/* ========================= */}

      {userRole === "student" && (
        <>
          {lectureState === "ongoing" && (
            <>
              <Text style={styles.timerLabel}>Session Duration</Text>
              <Text style={styles.timerValue}>
                {formatTimer(timerSeconds)}
              </Text>

              <View style={{ height: 20 }} />

              {alreadyMarked ? (
                <TouchableOpacity
                  style={[styles.attendanceBtn, { backgroundColor: SUCCESS }]}
                  disabled
                >
                  <Text style={styles.btnText}>Attendance Marked ✓</Text>
                </TouchableOpacity>

              ) : markingStatus === "open" ? (
                <TouchableOpacity
                  style={styles.attendanceBtn}
                  activeOpacity={0.85}
                  onPress={() => {
                    if (onMarkAttendance) {
                      onMarkAttendance();
                    }
                  }}
                >
                  <Text style={styles.btnText}>
                    Mark Attendance
                  </Text>
                </TouchableOpacity>

              ) : (
                <TouchableOpacity
                  style={[styles.attendanceBtn, { opacity: 0.4 }]}
                  disabled
                >
                  <Text style={styles.btnText}>Attendance Locked</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  innerContainer: {
    width: '100%',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontWeight: 'bold',
    fontSize: 12,
    color: '#616161',
  },
  timeRangeText: {
    fontWeight: 'bold',
    fontSize: 12,
    color: '#BDBDBD',
  },
  subjectName: {
    fontSize: 22,
    fontWeight: '900', // Extra bold
    color: '#2D3436',
    lineHeight: 26,
  },
  lockedText: {
  marginTop: 10,
  fontSize: 13,
  color: "#9CA3AF",
  fontWeight: "600",
  textAlign: "center",
},
  roomRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  roomText: {
    fontSize: 14,
    color: '#757575',
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: '#F5F5F5',
    width: '100%',
  },
  
  /* BUTTONS */
  startBtn: {
    width: '100%',
    height: 55,
    backgroundColor: PRIMARY,
    borderRadius: 18,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 10,
    shadowColor: PRIMARY,
    shadowOpacity: 0.4,
    shadowOffset: {width: 0, height: 4},
  },
  startBtnText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFF',
  },

  /* ONGOING STATE STYLES */
  timerLabel: {
    fontSize: 12,
    color: '#BDBDBD',
    fontWeight: 'bold',
    textAlign: 'center',
  },
  timerValue: {
    fontSize: 48,
    fontWeight: '900',
    color: PRIMARY,
    textAlign: 'center',
    letterSpacing: -2,
    fontFamily: 'monospace', // Closest to Flutter monospace
  },
  attendanceBtn: {
    width: '100%',
    height: 55,
    backgroundColor: SUCCESS,
    borderRadius: 18,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 10,
    shadowColor: SUCCESS,
    shadowOpacity: 0.4,
    shadowOffset: {width: 0, height: 4},
  },
  btnText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFF',
  },
  endBtn: {
    width: '100%',
    height: 50,
    borderWidth: 2,
    borderColor: DANGER,
    borderRadius: 18,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  endBtnText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: DANGER,
  },
});