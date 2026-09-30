import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Alert,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getUserSession } from "../../../services/session";
import { Ionicons } from "@expo/vector-icons";
import SubjectDropdown from "../../../components/SubjectDropdown";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import { CameraView, useCameraPermissions } from "expo-camera";

const PRIMARY      = "#4834D4";
const PRIMARY_SOFT = "#EEF2FF";
const BG           = "#F3F4F6";
const WHITE        = "#FFFFFF";
const GREY         = "#6B7280";
const DARK         = "#111827";
const GREEN        = "#10B981";
const AMBER        = "#F59E0B";
const RED          = "#EF4444";
const BORDER       = "#E5E7EB";
const OD_COLOR     = "#7C3AED";
const OD_SOFT      = "#EDE9FE";

const API_URL = "http://10.132.90.56:5000";

interface Subject {
  subject_id?: string;
  subject_name: string;
  subject_code: string;
  course_id?: string;
  course_name?: string;
}

interface Student {
  uid: string;
  name: string;
  email: string | null;
  roll_no: string | null;
  course_name: string | null;
  semester: string | null;
}

// ── Badge for pending OD count ────────────────────────────────────────────────
function ODPendingBadge({ teacherId, subjectId }: { teacherId: string; subjectId: string }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!teacherId || !subjectId) return;
    let cancelled = false;
    (async () => {
      try {
        const res  = await fetch(`${API_URL}/api/od/teacher/${teacherId}?subject_id=${subjectId}`);
        const json = await res.json();
        if (!cancelled && json.success) setCount(json.summary?.pending ?? 0);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [teacherId, subjectId]);

  if (!count) return null;
  return (
    <View style={badge.pill}>
      <Text style={badge.text}>{count}</Text>
    </View>
  );
}

const badge = StyleSheet.create({
  pill: {
    backgroundColor: AMBER + "22",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 6,
  },
  text: { fontSize: 11, fontWeight: "700", color: AMBER },
});

export default function TeacherReports() {
  const navigation = useNavigation<any>();
  const [subjects,       setSubjects]       = useState<Subject[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<Subject | null>(null);
  const [searchQuery,    setSearchQuery]    = useState("");
  const [searchResults,  setSearchResults]  = useState<Student[]>([]);
  const [searching,      setSearching]      = useState(false);
  const [teacherId,      setTeacherId]      = useState<string>("");
  const [activeTab,      setActiveTab]      = useState<"search" | "scan">("search");
  const [scannerVisible, setScannerVisible] = useState(false);
  const [permission,     requestPermission] = useCameraPermissions();
  const [scanned,        setScanned]        = useState(false);
  const searchTimeout = useRef<any>(null);

  // ── Fetch teacher info + subjects ────────────────────────────────────────────
  const fetchSubjects = useCallback(async () => {
    try {
      const session = await getUserSession();
      if (!session?.teacher_id) return;
      setTeacherId(session.teacher_id);

      const res  = await fetch(
        `${API_URL}/api/lectures/teachers/subjects?teacher_id=${session.teacher_id}`
      );
      const data = await res.json();
      if (data.success) setSubjects(data.subjects || []);
    } catch (e) {
      console.log("SUBJECT FETCH ERROR:", e);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchSubjects(); }, [fetchSubjects]));

  // ── Debounced search ─────────────────────────────────────────────────────────
  const handleSearch = (text: string) => {
    setSearchQuery(text);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);

    if (!selectedSubject || !text.trim()) {
      setSearchResults([]);
      return;
    }

    searchTimeout.current = setTimeout(async () => {
      try {
        setSearching(true);
        const subjectId = (selectedSubject as any).subject_id || "";
        const res = await fetch(
          `${API_URL}/api/reports/students/search?teacher_id=${teacherId}&subject_id=${subjectId}&query=${encodeURIComponent(text)}`
        );
        const data = await res.json();
        if (data.success) setSearchResults(data.students || []);
      } catch (e) {
        console.log("SEARCH ERROR:", e);
      } finally {
        setSearching(false);
      }
    }, 400);
  };

  // ── QR scan handler ──────────────────────────────────────────────────────────
  const handleQRScan = async ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    setScannerVisible(false);

    try {
      const payload = JSON.parse(data);
      if (payload.type !== "student_id" || !payload.uid) {
        Alert.alert("Invalid QR", "This QR code is not a valid student ID.");
        setScanned(false);
        return;
      }

      const subjectId = (selectedSubject as any)?.subject_id || "";
      const res = await fetch(
        `${API_URL}/api/reports/students/by-qr?uid=${payload.uid}&teacher_id=${teacherId}&subject_id=${subjectId}`
      );
      const result = await res.json();

      if (result.success) {
        navigation.navigate("StudentReportDetail", {
          student: result.student,
          subject: selectedSubject,
          teacher_id: teacherId,
        });
      } else {
        Alert.alert("Not Found", result.error || "Student not found in this subject.");
      }
    } catch (e) {
      Alert.alert("Error", "Could not read QR code. Please try again.");
    } finally {
      setTimeout(() => setScanned(false), 2000);
    }
  };

  const openScanner = async () => {
    if (!selectedSubject) {
      Alert.alert("Select Subject", "Please select a subject before scanning.");
      return;
    }
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert("Camera Permission", "Camera access is required to scan QR codes.");
        return;
      }
    }
    setScanned(false);
    setScannerVisible(true);
  };

  const handleStudentPress = (student: Student) => {
    navigation.navigate("StudentReportDetail", {
      student,
      subject: selectedSubject,
      teacher_id: teacherId,
    });
  };

  const isSubjectSelected = !!selectedSubject;

  return (
    <SafeAreaView style={S.safe}>
      <ScrollView
        contentContainerStyle={S.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* HEADER */}
        <View style={S.header}>
          <Text style={S.title}>Reports</Text>
          <Text style={S.subtitle}>View detailed student reports</Text>
        </View>

        {/* SUBJECT DROPDOWN */}
        <View style={S.section}>
          <SubjectDropdown
            subjects={subjects}
            selectedSubject={selectedSubject}
            onSelect={(s) => {
              setSelectedSubject(s);
              setSearchQuery("");
              setSearchResults([]);
            }}
          />
        </View>

        {/* ── CLASS-LEVEL QUICK ACTIONS ──────────────────────────────────────── */}
        {isSubjectSelected && (
          <View style={S.quickActions}>

            {/* Class Report Card */}
            <TouchableOpacity
              style={[S.actionCard, { borderColor: PRIMARY + "30" }]}
              activeOpacity={0.85}
              onPress={() =>
                navigation.navigate("ClassReport", {
                  subject: selectedSubject,
                  teacher_id: teacherId,
                })
              }
            >
              <View style={[S.actionIconWrap, { backgroundColor: PRIMARY_SOFT }]}>
                <Ionicons name="stats-chart" size={24} color={PRIMARY} />
              </View>
              <View style={S.actionBody}>
                <Text style={S.actionTitle}>Class Report</Text>
                <Text style={S.actionDesc}>
                  Attendance, quizzes & assignment stats for all enrolled students
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={GREY} />
            </TouchableOpacity>

            {/* Mark Attendance Card */}
            <TouchableOpacity
              style={[S.actionCard, { borderColor: GREEN + "40" }]}
              activeOpacity={0.85}
              onPress={() =>
                navigation.navigate("MarkAttendance", {
                  subject: selectedSubject,
                  teacher_id: teacherId,
                })
              }
            >
              <View style={[S.actionIconWrap, { backgroundColor: "#F0FDF4" }]}>
                <Ionicons name="calendar-outline" size={24} color={GREEN} />
              </View>
              <View style={S.actionBody}>
                <Text style={S.actionTitle}>Mark Attendance</Text>
                <Text style={S.actionDesc}>
                  Attendance register — week-by-week view with per-student checkboxes
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={GREY} />
            </TouchableOpacity>

            {/* ── OD Requests Card ─────────────────────────────────────────── */}
            <TouchableOpacity
              style={[S.actionCard, { borderColor: OD_COLOR + "40" }]}
              activeOpacity={0.85}
              onPress={() =>
                navigation.navigate("ODRequestsTeacher", {
                  teacherId:   teacherId,
                  subjectId:   (selectedSubject as any).subject_id || "",
                  subjectName: selectedSubject?.subject_name,
                  courseId:    (selectedSubject as any).course_id  || "",
                })
              }
            >
              <View style={[S.actionIconWrap, { backgroundColor: OD_SOFT }]}>
                <Ionicons name="document-text-outline" size={24} color={OD_COLOR} />
              </View>
              <View style={S.actionBody}>
                <View style={S.actionTitleRow}>
                  <Text style={S.actionTitle}>OD Requests</Text>
                  {/* Live pending-count badge */}
                  <ODPendingBadge
                    teacherId={teacherId}
                    subjectId={(selectedSubject as any)?.subject_id || ""}
                  />
                </View>
                <Text style={S.actionDesc}>
                  Review, approve or reject student on-duty leave requests
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={GREY} />
            </TouchableOpacity>

          </View>
        )}

        {/* DIVIDER with label */}
        {isSubjectSelected && (
          <View style={S.dividerRow}>
            <View style={S.dividerLine} />
            <Text style={S.dividerText}>Individual Student</Text>
            <View style={S.dividerLine} />
          </View>
        )}

        {/* TAB BAR */}
        {isSubjectSelected && (
          <View style={S.tabBar}>
            <TouchableOpacity
              style={[S.tab, activeTab === "search" && S.tabActive]}
              onPress={() => setActiveTab("search")}
            >
              <Ionicons
                name="search-outline"
                size={16}
                color={activeTab === "search" ? PRIMARY : GREY}
              />
              <Text style={[S.tabText, activeTab === "search" && S.tabTextActive]}>
                Search Student
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[S.tab, activeTab === "scan" && S.tabActive]}
              onPress={() => setActiveTab("scan")}
            >
              <Ionicons
                name="qr-code-outline"
                size={16}
                color={activeTab === "scan" ? PRIMARY : GREY}
              />
              <Text style={[S.tabText, activeTab === "scan" && S.tabTextActive]}>
                Scan QR Code
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* SEARCH PANEL */}
        {isSubjectSelected && activeTab === "search" && (
          <View style={S.panel}>
            <View style={S.searchBox}>
              <Ionicons name="search-outline" size={18} color={GREY} />
              <TextInput
                style={S.searchInput}
                placeholder="Search by name, email or roll no..."
                placeholderTextColor="#9CA3AF"
                value={searchQuery}
                onChangeText={handleSearch}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {searching && (
                <ActivityIndicator size="small" color={PRIMARY} />
              )}
            </View>

            {searchQuery.trim() === "" && searchResults.length === 0 && (
              <View style={S.emptySearch}>
                <Ionicons name="people-outline" size={40} color={BORDER} />
                <Text style={S.emptyText}>Start typing to search students</Text>
              </View>
            )}

            {searchResults.map((student) => (
              <TouchableOpacity
                key={student.uid}
                style={S.studentCard}
                onPress={() => handleStudentPress(student)}
                activeOpacity={0.8}
              >
                <View style={S.studentAvatar}>
                  <Text style={S.studentAvatarText}>
                    {(student.name || "?")[0].toUpperCase()}
                  </Text>
                </View>
                <View style={S.studentInfo}>
                  <Text style={S.studentName}>{student.name}</Text>
                  <Text style={S.studentMeta}>
                    {[student.roll_no, student.course_name, student.semester ? `Sem ${student.semester}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                  {student.email && (
                    <Text style={S.studentEmail}>{student.email}</Text>
                  )}
                </View>
                <Ionicons name="chevron-forward" size={18} color={GREY} />
              </TouchableOpacity>
            ))}

            {searchQuery.trim() !== "" && !searching && searchResults.length === 0 && (
              <View style={S.emptySearch}>
                <Ionicons name="search-outline" size={40} color={BORDER} />
                <Text style={S.emptyText}>No students found</Text>
              </View>
            )}
          </View>
        )}

        {/* SCAN PANEL */}
        {isSubjectSelected && activeTab === "scan" && (
          <View style={S.panel}>
            <View style={S.qrCard}>
              <View style={S.qrIcon}>
                <Ionicons name="qr-code" size={48} color={PRIMARY} />
              </View>
              <Text style={S.qrTitle}>Scan Student QR Code</Text>
              <Text style={S.qrDesc}>
                Ask the student to open their profile and show their QR code.
                Tap the button below to open the scanner.
              </Text>
              <TouchableOpacity style={S.scanBtn} onPress={openScanner}>
                <Ionicons name="scan-outline" size={20} color={WHITE} />
                <Text style={S.scanBtnText}>Open Scanner</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* PLACEHOLDER when no subject */}
        {!isSubjectSelected && (
          <View style={S.placeholderCard}>
            <Ionicons name="bar-chart-outline" size={52} color={BORDER} />
            <Text style={S.placeholderTitle}>Select a Subject</Text>
            <Text style={S.placeholderText}>
              Choose a subject above to view class reports, mark attendance, manage OD requests, or look up individual students.
            </Text>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* QR SCANNER MODAL */}
      <Modal visible={scannerVisible} animationType="slide" onRequestClose={() => setScannerVisible(false)}>
        <View style={S.scannerContainer}>
          <View style={S.scannerHeader}>
            <TouchableOpacity onPress={() => setScannerVisible(false)} style={S.closeBtn}>
              <Ionicons name="close" size={24} color={DARK} />
            </TouchableOpacity>
            <Text style={S.scannerTitle}>Scan Student QR</Text>
            <View style={{ width: 40 }} />
          </View>

          <CameraView
            style={S.camera}
            facing="back"
            onBarcodeScanned={scanned ? undefined : handleQRScan}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          />

          <View style={S.scannerOverlay}>
            <View style={S.scanFrame} />
            <Text style={S.scanHint}>Align the student's QR code within the frame</Text>
          </View>

          <View style={S.scannerFooter}>
            <Text style={S.scannerSubject}>
              Subject: {selectedSubject?.subject_name}
            </Text>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: BG },
  scroll: { paddingHorizontal: 20, paddingBottom: 40 },

  header:   { paddingTop: 16, marginBottom: 20 },
  title:    { fontSize: 28, fontWeight: "800", color: DARK },
  subtitle: { fontSize: 14, color: GREY, marginTop: 4 },

  section: { marginBottom: 16 },

  // ── Quick Actions ────────────────────────────────────────────────────────────
  quickActions: { gap: 10, marginBottom: 20 },
  actionCard: {
    backgroundColor: WHITE,
    borderRadius: 18,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderWidth: 1.5,
    elevation: 2,
  },
  actionIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  actionBody:     { flex: 1 },
  actionTitleRow: { flexDirection: "row", alignItems: "center" },
  actionTitle:    { fontSize: 16, fontWeight: "800", color: DARK },
  actionDesc:     { fontSize: 12, color: GREY, marginTop: 3, lineHeight: 17 },

  // ── Divider ──────────────────────────────────────────────────────────────────
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: BORDER },
  dividerText: {
    fontSize: 11, fontWeight: "700", color: GREY,
    textTransform: "uppercase", letterSpacing: 1,
  },

  tabBar: {
    flexDirection: "row",
    backgroundColor: WHITE,
    borderRadius: 16,
    padding: 4,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: BORDER,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 12,
  },
  tabActive:     { backgroundColor: PRIMARY_SOFT },
  tabText:       { fontSize: 13, fontWeight: "600", color: GREY },
  tabTextActive: { color: PRIMARY },

  panel: { gap: 12 },

  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: WHITE,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: DARK,
    padding: 0,
  },

  emptySearch: {
    alignItems: "center",
    paddingVertical: 40,
    gap: 8,
  },
  emptyText: { fontSize: 14, color: GREY },

  studentCard: {
    backgroundColor: WHITE,
    borderRadius: 16,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 1,
  },
  studentAvatar: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: PRIMARY_SOFT,
    justifyContent: "center",
    alignItems: "center",
  },
  studentAvatarText: { fontSize: 18, fontWeight: "800", color: PRIMARY },
  studentInfo:       { flex: 1 },
  studentName:       { fontSize: 15, fontWeight: "700", color: DARK },
  studentMeta:       { fontSize: 12, color: GREY, marginTop: 2 },
  studentEmail:      { fontSize: 12, color: PRIMARY, marginTop: 2 },

  qrCard: {
    backgroundColor: WHITE,
    borderRadius: 20,
    padding: 28,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 2,
  },
  qrIcon: {
    width: 80,
    height: 80,
    borderRadius: 24,
    backgroundColor: PRIMARY_SOFT,
    justifyContent: "center",
    alignItems: "center",
  },
  qrTitle: { fontSize: 18, fontWeight: "800", color: DARK },
  qrDesc: {
    fontSize: 13,
    color: GREY,
    textAlign: "center",
    lineHeight: 20,
  },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: PRIMARY,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 50,
    marginTop: 8,
  },
  scanBtnText: { color: WHITE, fontWeight: "700", fontSize: 15 },

  placeholderCard: {
    backgroundColor: WHITE,
    borderRadius: 24,
    padding: 40,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: BORDER,
    marginTop: 8,
  },
  placeholderTitle: { fontSize: 18, fontWeight: "800", color: DARK },
  placeholderText: {
    fontSize: 14,
    color: GREY,
    textAlign: "center",
    lineHeight: 22,
  },

  // Scanner Modal
  scannerContainer: { flex: 1, backgroundColor: "#000" },
  scannerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    paddingTop: 56,
    backgroundColor: WHITE,
  },
  closeBtn:      { width: 40, height: 40, justifyContent: "center", alignItems: "center" },
  scannerTitle:  { fontSize: 17, fontWeight: "700", color: DARK },
  camera:        { flex: 1 },
  scannerOverlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    pointerEvents: "none",
  },
  scanFrame: {
    width: 240, height: 240,
    borderWidth: 3,
    borderColor: PRIMARY,
    borderRadius: 20,
    backgroundColor: "transparent",
  },
  scanHint: {
    marginTop: 20,
    color: WHITE,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 40,
  },
  scannerFooter: {
    backgroundColor: WHITE,
    padding: 20,
    alignItems: "center",
  },
  scannerSubject: {
    fontSize: 14,
    fontWeight: "600",
    color: PRIMARY,
  },
});