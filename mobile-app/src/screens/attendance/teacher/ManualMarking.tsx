import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation } from "@react-navigation/native";
import Ionicons from "@expo/vector-icons/Ionicons";

// ─── Palette (light theme) ───────────────────────────────────────────────────
const C = {
  bg:         "#F7F8FC",
  card:       "#FFFFFF",
  ink:        "#1C2333",
  inkSoft:    "#2E3A52",
  muted:      "#8A94A6",
  mutedLight: "#C2C9D6",
  border:     "#E8EBF2",
  violet:     "#6C5CE7",
  violetSoft: "#EEF2FF",
  jade:       "#00B37E",
  jadeSoft:   "#E6F9F4",
  coral:      "#F05454",
  coralSoft:  "#FEECEC",
  amber:      "#F0A500",
  amberSoft:  "#FFF8E7",
};

const API_URL = "http://10.132.90.56:5000";

interface Student {
  uid:        string;
  name:       string;
  roll_no:    string;
  is_present: boolean;   // pre-marked by QR scan
}

export default function ManualMarkingScreen() {
  const route      = useRoute<any>();
  const navigation = useNavigation<any>();

  const { attendance_session_id, lecture_session_id } = route.params as {
    attendance_session_id: string;
    lecture_session_id:    string;
  };

  const [students,     setStudents]     = useState<Student[]>([]);
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [loading,      setLoading]      = useState(true);
  const [submitting,   setSubmitting]   = useState(false);

  // ── Fetch students with their QR-marked status ────────────────────────────
  const fetchStudents = useCallback(async () => {
    try {
      setLoading(true);
      const url = `${API_URL}/api/lectures/attendance/verify-students`
        + `?attendance_session_id=${attendance_session_id}`
        + `&lecture_session_id=${lecture_session_id}`;

      const res  = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();

      if (data.success) {
        setStudents(data.students);
        // Pre-select everyone already marked present (QR scan)
        const presentUids = new Set<string>(
          data.students
            .filter((s: Student) => s.is_present)
            .map((s: Student) => s.uid)
        );
        setSelectedUids(presentUids);
      } else {
        Alert.alert("Error", data.error || "Failed to load students");
      }
    } catch (e: any) {
      console.error("FETCH STUDENTS ERROR:", e);
      Alert.alert(
        "Connection Error",
        `Cannot reach server at ${API_URL}.\n\nMake sure the backend is running and reachable.`
      );
    } finally {
      setLoading(false);
    }
  }, [attendance_session_id, lecture_session_id]);

  useEffect(() => { fetchStudents(); }, [fetchStudents]);

  // ── Toggle individual student ─────────────────────────────────────────────
  const toggleStudent = (uid: string) => {
    setSelectedUids((prev) => {
      const updated = new Set(prev);
      if (updated.has(uid)) {
        updated.delete(uid);
      } else {
        updated.add(uid);
      }
      return updated;
    });
  };

  // ── Select all / Deselect all ─────────────────────────────────────────────
  const toggleSelectAll = () => {
    if (selectedUids.size === students.length) {
      setSelectedUids(new Set());
    } else {
      setSelectedUids(new Set(students.map((s) => s.uid)));
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = () => {
    const presentCount = selectedUids.size;
    const absentCount  = students.length - presentCount;

    Alert.alert(
      "Save Attendance?",
      `${presentCount} present · ${absentCount} absent\n\nAre you sure you want to save these changes?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Save", onPress: submitAttendance },
      ]
    );
  };

  const submitAttendance = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(
        `${API_URL}/api/lectures/attendance/verify-attendance`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attendance_session_id,
            lecture_session_id,
            verified_students: Array.from(selectedUids),
          }),
        }
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();

      if (data.success) {
        Alert.alert(
          "Attendance Saved",
          `${data.marked_count} present · ${data.unmarked_count} absent`
            + (data.skipped_count > 0 ? ` · ${data.skipped_count} unchanged` : ""),
          [{ text: "Done", onPress: () => navigation.replace("TeacherDashboard") }]
        );
      } else {
        Alert.alert("Error", data.error || "Failed to save attendance");
      }
    } catch (e) {
      console.error("SUBMIT ERROR:", e);
      Alert.alert("Error", "Could not connect to server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}>
          <ActivityIndicator size="large" color={C.violet} />
          <Text style={S.mutedText}>Loading students…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Empty ─────────────────────────────────────────────────────────────────
  if (students.length === 0) {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}>
          <View style={S.emptyIcon}>
            <Ionicons name="people-outline" size={32} color={C.violet} />
          </View>
          <Text style={S.emptyTitle}>No Students Found</Text>
          <Text style={S.mutedText}>No students are enrolled in this class.</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  const qrMarkedCount  = students.filter((s) => s.is_present).length;
  const presentCount   = selectedUids.size;
  const absentCount    = students.length - presentCount;

  // ── Main UI ───────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={S.safe} edges={["top"]}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={S.header}>
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={18} color={C.muted} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.headerTitle}>Verify Attendance</Text>
        </View>
      </View>

      {/* ── Stats strip ────────────────────────────────────────────────── */}
      <View style={S.statsStrip}>
        <View style={S.statItem}>
          <Text style={[S.statNum, { color: C.jade }]}>{presentCount}</Text>
          <Text style={S.statLabel}>Present</Text>
        </View>
        <View style={S.statDivider} />
        <View style={S.statItem}>
          <Text style={[S.statNum, { color: C.coral }]}>{absentCount}</Text>
          <Text style={S.statLabel}>Absent</Text>
        </View>
        <View style={S.statDivider} />
        <View style={S.statItem}>
          <Text style={[S.statNum, { color: C.ink }]}>{students.length}</Text>
          <Text style={S.statLabel}>Total</Text>
        </View>
      </View>

      {/* ── Select all row ─────────────────────────────────────────────── */}
      <TouchableOpacity style={S.selectAllRow} onPress={toggleSelectAll}>
        <View style={[S.checkbox, selectedUids.size === students.length && S.checkboxActive]}>
          {selectedUids.size === students.length && (
            <Ionicons name="checkmark" size={13} color="#FFF" />
          )}
        </View>
        <Text style={S.selectAllText}>
          {selectedUids.size === students.length ? "Deselect All" : "Select All"}
        </Text>
        {selectedUids.size > 0 && selectedUids.size < students.length && (
          <View style={S.countBadge}>
            <Text style={S.countText}>{selectedUids.size} selected</Text>
          </View>
        )}
      </TouchableOpacity>

      {/* ── Student list ───────────────────────────────────────────────── */}
      <FlatList
        data={students}
        keyExtractor={(item) => item.uid}
        contentContainerStyle={S.listContent}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => {
          const isSelected  = selectedUids.has(item.uid);
          const wasQRMarked = item.is_present;

          return (
            <TouchableOpacity
              style={[S.studentCard, isSelected && S.studentCardSelected]}
              onPress={() => toggleStudent(item.uid)}
              activeOpacity={0.75}
            >
              {/* Checkbox */}
              <View style={[S.checkbox, isSelected && S.checkboxActive]}>
                {isSelected && <Ionicons name="checkmark" size={13} color="#FFF" />}
              </View>

              {/* Avatar */}
              <View style={[S.avatar, isSelected && { backgroundColor: C.violetSoft }]}>
                <Text style={[S.avatarText, { color: isSelected ? C.violet : C.muted }]}>
                  {item.name.charAt(0).toUpperCase()}
                </Text>
              </View>

              {/* Info */}
              <View style={S.studentInfo}>
                <Text style={S.studentName}>{item.name}</Text>
                <View style={S.rollRow}>
                  <Ionicons name="card-outline" size={11} color={C.muted} />
                  <Text style={S.rollText}> {item.roll_no}</Text>
                </View>
              </View>

              {/* Status indicator */}
              {isSelected ? (
                <View style={S.presentBadge}>
                  <Text style={S.presentBadgeText}>Present</Text>
                </View>
              ) : (
                <View style={S.absentBadge}>
                  <Text style={S.absentBadgeText}>Absent</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        }}
      />

      {/* ── Submit button ───────────────────────────────────────────────── */}
      <View style={S.footer}>
        <TouchableOpacity
          style={[S.submitBtn, submitting && { opacity: 0.6 }]}
          onPress={handleSubmit}
          disabled={submitting}
          activeOpacity={0.85}
        >
          {submitting ? (
            <ActivityIndicator color="#FFF" size="small" />
          ) : (
            <>
              <Ionicons name="checkmark-done-outline" size={20} color="#FFF" />
              <Text style={S.submitText}>Save Attendance</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },

  mutedText: { fontSize: 14, color: C.muted, textAlign: "center" },

  emptyIcon: {
    width: 72, height: 72, borderRadius: 20,
    backgroundColor: C.violetSoft,
    justifyContent: "center", alignItems: "center", marginBottom: 4,
  },
  emptyTitle: { fontSize: 18, fontWeight: "800", color: C.ink },

  // Header
  header: {
    flexDirection: "row", alignItems: "center",
    gap: 12, paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: C.card,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: C.bg,
    borderWidth: 1, borderColor: C.border,
    justifyContent: "center", alignItems: "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "800", color: C.ink },
  headerSub:   { fontSize: 12, color: C.muted, marginTop: 2 },

  // Stats strip
  statsStrip: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.card,
    borderBottomWidth: 1, borderBottomColor: C.border,
    paddingVertical: 14,
  },
  statItem:   { flex: 1, alignItems: "center" },
  statNum:    { fontSize: 22, fontWeight: "900" },
  statLabel:  { fontSize: 10, fontWeight: "600", color: C.muted, marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 },
  statDivider: { width: 1, height: 30, backgroundColor: C.border },

  // Select all
  selectAllRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.card,
    marginHorizontal: 16, marginTop: 14, marginBottom: 8,
    padding: 14, borderRadius: 14,
    borderWidth: 1, borderColor: C.border,
    gap: 12,
  },
  selectAllText: { fontSize: 14, fontWeight: "700", color: C.ink, flex: 1 },
  countBadge: {
    backgroundColor: C.violetSoft,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 20,
  },
  countText: { fontSize: 12, fontWeight: "700", color: C.violet },

  // List
  listContent: { paddingHorizontal: 16, paddingBottom: 110 },

  studentCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.card,
    borderRadius: 16, padding: 14,
    marginBottom: 8,
    borderWidth: 1, borderColor: C.border,
    gap: 12,
  },
  studentCardSelected: {
    backgroundColor: "#FAFBFF",
    borderColor: C.border,    // subtle — checkbox is the indicator, not the card
  },

  // Avatar
  avatar: {
    width: 42, height: 42, borderRadius: 13,
    backgroundColor: C.bg,
    justifyContent: "center", alignItems: "center",
  },
  avatarText: { fontSize: 17, fontWeight: "800" },

  studentInfo: { flex: 1 },
  studentName: { fontSize: 15, fontWeight: "700", color: C.ink },
  rollRow:     { flexDirection: "row", alignItems: "center", marginTop: 3 },
  rollText:    { fontSize: 12, color: C.muted, fontWeight: "600" },

  qrBadge: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: C.jadeSoft,
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: 10, marginLeft: 8,
  },
  qrBadgeText: { fontSize: 10, fontWeight: "700", color: C.jade },

  // Status badges
  presentBadge: {
    backgroundColor: C.jadeSoft,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 10,
  },
  presentBadgeText: { fontSize: 11, fontWeight: "700", color: C.jade },
  absentBadge: {
    backgroundColor: C.coralSoft,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 10,
  },
  absentBadgeText: { fontSize: 11, fontWeight: "700", color: C.coral },

  // Checkbox
  checkbox: {
    width: 22, height: 22, borderRadius: 7,
    borderWidth: 2, borderColor: C.mutedLight,
    justifyContent: "center", alignItems: "center",
  },
  checkboxActive: {
    backgroundColor: C.violet, borderColor: C.violet,
  },

  // Footer + Submit
  footer: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    backgroundColor: C.card,
    borderTopWidth: 1, borderTopColor: C.border,
    paddingHorizontal: 16, paddingVertical: 12,
    paddingBottom: 24,
  },
  submitBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 10,
    backgroundColor: C.violet,
    borderRadius: 50, paddingVertical: 17,
    shadowColor: C.violet,
    shadowOpacity: 0.25, shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  submitText: { color: "#FFF", fontSize: 16, fontWeight: "800" },
});