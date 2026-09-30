/**
 * ODLeaveRequest.tsx
 * Student screen — submit OD leave request with proof upload.
 * Shows existing OD requests for the subject and lets student
 * cancel pending ones.
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
// ─── AttendanceCalendar REMOVED ──────────────────────────────────────────────
// It was receiving no attendanceData prop, causing every date to render as
// "unavailable". We now use a self-contained mini date-picker instead.

// ─── Palette (matches rest of app) ───────────────────────────────────────────
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

// ─── Safe JSON parser ─────────────────────────────────────────────────────────
// Guards against the server returning an HTML error page instead of JSON,
// which causes "SyntaxError: JSON Parse error: Unexpected character: <".
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.warn("OD: non-JSON response", res.status, text.slice(0, 200));
    return { success: false, error: `Server error (${res.status})` };
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────
type PickerTarget = "from" | "to" | null;

interface ODRequest {
  od_id:        string;
  from_date:    string;
  to_date:      string;
  reason:       string;
  status:       "pending" | "approved" | "rejected";
  teacher_note: string | null;
  created_at:   string | null;
  proof:        { url: string; name: string };
}

interface RouteParams {
  studentUid:   string;
  studentName:  string;
  subjectId:    string;
  subjectName:  string;
  teacherId:    string;
  courseId:     string;
}

// ─── Status config ────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  pending:  { color: AMBER, bg: "#FEF3C7", icon: "time-outline",         label: "Pending"  },
  approved: { color: GREEN, bg: "#F0FDF4", icon: "checkmark-circle",     label: "Approved" },
  rejected: { color: RED,   bg: "#FEF2F2", icon: "close-circle-outline", label: "Rejected" },
};

function fmtDate(ymd: string) {
  return new Date(ymd + "T12:00:00").toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const DAY_LABELS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

// ─── Mini Date Picker ─────────────────────────────────────────────────────────
// A plain calendar with no attendance data — every date is selectable.
function MiniDatePicker({
  minDate,
  onSelect,
}: {
  minDate?: string;   // "YYYY-MM-DD" — dates before this are disabled
  onSelect: (ymd: string) => void;
}) {
  const today = new Date();
  const [viewYear,  setViewYear]  = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth()); // 0-based

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow    = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun

  const pad = (n: number) => String(n).padStart(2, "0");
  const toYmd = (y: number, m: number, d: number) =>
    `${y}-${pad(m + 1)}-${pad(d)}`;

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  // Pad to full rows
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <View>
      {/* Month navigation */}
      <View style={dp.nav}>
        <TouchableOpacity onPress={prevMonth} style={dp.navBtn}>
          <Ionicons name="chevron-back" size={20} color={DARK} />
        </TouchableOpacity>
        <Text style={dp.monthLabel}>
          {MONTH_NAMES[viewMonth]} {viewYear}
        </Text>
        <TouchableOpacity onPress={nextMonth} style={dp.navBtn}>
          <Ionicons name="chevron-forward" size={20} color={DARK} />
        </TouchableOpacity>
      </View>

      {/* Day-of-week headers */}
      <View style={dp.row}>
        {DAY_LABELS.map((d) => (
          <Text key={d} style={dp.dayLabel}>{d}</Text>
        ))}
      </View>

      {/* Date grid */}
      {Array.from({ length: cells.length / 7 }, (_, row) => (
        <View key={row} style={dp.row}>
          {cells.slice(row * 7, row * 7 + 7).map((day, col) => {
            if (!day) return <View key={col} style={dp.cell} />;
            const ymd      = toYmd(viewYear, viewMonth, day);
            const isSunday = (firstDow + cells.indexOf(day)) % 7 === 0;
            const disabled = isSunday || (!!minDate && ymd < minDate);
            return (
              <TouchableOpacity
                key={col}
                style={[dp.cell, disabled && dp.cellDisabled]}
                onPress={() => !disabled && onSelect(ymd)}
                disabled={disabled}
              >
                <Text style={[dp.cellText, disabled && dp.cellTextDisabled, isSunday && dp.sunday]}>
                  {day}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}

      <Text style={dp.hint}>Sundays are excluded from OD requests</Text>
    </View>
  );
}

const dp = StyleSheet.create({
  nav:     { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  navBtn:  { padding: 6 },
  monthLabel: { fontSize: 15, fontWeight: "700", color: DARK },
  row:     { flexDirection: "row" },
  dayLabel:{ flex: 1, textAlign: "center", fontSize: 11, fontWeight: "700", color: GREY, paddingVertical: 4 },
  cell:    { flex: 1, aspectRatio: 1, alignItems: "center", justifyContent: "center" },
  cellDisabled: { opacity: 0.3 },
  cellText:     { fontSize: 13, color: DARK },
  cellTextDisabled: { color: GREY },
  sunday:  { color: RED },
  hint:    { textAlign: "center", fontSize: 11, color: GREY, marginTop: 10 },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function ODLeaveRequest() {
  const navigation = useNavigation<any>();
  const route      = useRoute<any>();
  const {
    studentUid, studentName, subjectId, subjectName, teacherId, courseId,
  }: RouteParams = route.params;

  // ─── Existing requests ──────────────────────────────────────────────────────
  const [requests, setRequests] = useState<ODRequest[]>([]);
  const [loading,  setLoading]  = useState(true);

  // ─── Form state ─────────────────────────────────────────────────────────────
  const [fromDate,   setFromDate]   = useState("");
  const [toDate,     setToDate]     = useState("");
  const [reason,     setReason]     = useState("");
  const [proofFile,  setProofFile]  = useState<{
    uri: string; name: string; type: string; size?: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ─── Calendar picker ─────────────────────────────────────────────────────────
  const [activePicker, setActivePicker] = useState<PickerTarget>(null);

  // ─── Load existing OD requests ──────────────────────────────────────────────
  const fetchRequests = useCallback(async () => {
    try {
      setLoading(true);
      const res  = await fetch(
        `${API_URL}/api/od/student/${studentUid}?subject_id=${subjectId}`
      );
      const json = await safeJson(res);
      if (json.success) setRequests(json.requests);
    } catch (e) {
      console.log("OD FETCH:", e);
    } finally {
      setLoading(false);
    }
  }, [studentUid, subjectId]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // ─── Date picker handler ─────────────────────────────────────────────────────
  const handleDateSelect = (ymd: string) => {
    if (activePicker === "from") {
      setFromDate(ymd);
      if (toDate && toDate < ymd) setToDate("");
    } else {
      setToDate(ymd);
    }
    setActivePicker(null);
  };

  // ─── Proof file picker ───────────────────────────────────────────────────────
  const handlePickDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "application/pdf", "image/*",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      setProofFile({ uri: asset.uri, name: asset.name, type: asset.mimeType || "application/octet-stream", size: asset.size });
    } catch {
      Alert.alert("Error", "Could not pick document.");
    }
  };

  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission required", "Please allow photo library access.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const ext   = asset.uri.split(".").pop()?.toLowerCase() || "jpg";
    const type  = ext === "png" ? "image/png" : "image/jpeg";
    setProofFile({ uri: asset.uri, name: `proof_${Date.now()}.${ext}`, type });
  };

  const handlePickCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission required", "Please allow camera access.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (result.canceled) return;
    const asset = result.assets[0];
    const ext   = asset.uri.split(".").pop()?.toLowerCase() || "jpg";
    setProofFile({ uri: asset.uri, name: `proof_${Date.now()}.${ext}`, type: "image/jpeg" });
  };

  const showProofOptions = () => {
    Alert.alert("Attach Proof", "Choose source", [
      { text: "Camera",        onPress: handlePickCamera   },
      { text: "Photo Library", onPress: handlePickImage    },
      { text: "Document",      onPress: handlePickDocument },
      { text: "Cancel",        style: "cancel"             },
    ]);
  };

  // ─── Submit ──────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!fromDate)        return Alert.alert("Missing field", "Please select a start date.");
    if (!reason.trim())   return Alert.alert("Missing field", "Please enter a reason.");
    if (!proofFile)       return Alert.alert("Missing proof", "Please attach a proof document.");

    try {
      setSubmitting(true);

      const form = new FormData();
      form.append("student_uid",  studentUid);
      form.append("subject_id",   subjectId);
      form.append("teacher_id",   teacherId);
      form.append("course_id",    courseId);
      form.append("student_name", studentName);
      form.append("reason",       reason.trim());
      form.append("from_date",    fromDate);
      if (toDate) form.append("to_date", toDate);
      form.append("proof", {
        uri:  proofFile.uri,
        name: proofFile.name,
        type: proofFile.type,
      } as any);

      const res  = await fetch(`${API_URL}/api/od/request`, {
        method:  "POST",
        body:    form,
        headers: { Accept: "application/json" },
      });
      const json = await safeJson(res);

      if (json.success) {
        Alert.alert(
          "Request Submitted ",
          "Your OD leave request has been sent to the teacher. You'll be notified once it's reviewed.",
          [{ text: "OK" }]
        );
        setFromDate("");
        setToDate("");
        setReason("");
        setProofFile(null);
        fetchRequests();
      } else {
        Alert.alert("Failed", json.error || "Could not submit request.");
      }
    } catch {
      Alert.alert("Error", "Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Cancel a pending request ────────────────────────────────────────────────
  const handleCancel = (od: ODRequest) => {
    Alert.alert(
      "Cancel Request",
      `Cancel your OD request for ${fmtDate(od.from_date)}${od.to_date !== od.from_date ? " – " + fmtDate(od.to_date) : ""}?`,
      [
        { text: "No", style: "cancel" },
        {
          text: "Yes, Cancel", style: "destructive",
          onPress: async () => {
            try {
              const res  = await fetch(`${API_URL}/api/od/${od.od_id}`, {
                method:  "DELETE",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ student_uid: studentUid }),
              });
              const json = await safeJson(res);
              if (json.success) {
                fetchRequests();
              } else {
                Alert.alert("Error", json.error || "Could not cancel request.");
              }
            } catch {
              Alert.alert("Error", "Network error.");
            }
          },
        },
      ]
    );
  };

  const fmtSize = (bytes?: number) => {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const pendingCount = requests.filter((r) => r.status === "pending").length;

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View style={S.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={S.backBtn}>
          <Ionicons name="arrow-back" size={22} color={DARK} />
        </TouchableOpacity>
        <View style={S.headerCenter}>
          <Text style={S.headerTitle}>OD Leave Request</Text>
          <Text style={S.headerSub} numberOfLines={1}>{subjectName}</Text>
        </View>
        {pendingCount > 0 && (
          <View style={S.pendingBadge}>
            <Text style={S.pendingBadgeText}>{pendingCount} pending</Text>
          </View>
        )}
      </View>

      <ScrollView
        style={S.scroll}
        contentContainerStyle={S.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* ── Info Banner ──────────────────────────────────────────────────── */}
        <View style={S.infoBanner}>
          <Ionicons name="information-circle" size={18} color={OD_COLOR} />
          <Text style={S.infoText}>
            Submit an OD request with a valid proof document (medical certificate, event letter, etc.).
            Teacher will review and mark your attendance as{" "}
            <Text style={{ fontWeight: "800" }}>OD</Text> upon approval.
          </Text>
        </View>

        {/* ══════════════════════════════════════════════════════════════════
            NEW REQUEST FORM
        ══════════════════════════════════════════════════════════════════ */}
        <View style={S.card}>
          <Text style={S.cardTitle}>New Request</Text>

          {/* From Date */}
          <Text style={S.label}>From Date <Text style={S.required}>*</Text></Text>
          <TouchableOpacity style={S.dateInput} onPress={() => setActivePicker("from")}>
            <Ionicons name="calendar-outline" size={16} color={GREY} />
            <Text style={[S.dateInputText, !fromDate && S.placeholder]}>
              {fromDate ? fmtDate(fromDate) : "Select start date"}
            </Text>
          </TouchableOpacity>

          {/* To Date */}
          <Text style={S.label}>
            To Date{" "}
            <Text style={S.labelNote}>(optional — leave blank for single day)</Text>
          </Text>
          <TouchableOpacity style={S.dateInput} onPress={() => setActivePicker("to")}>
            <Ionicons name="calendar-outline" size={16} color={GREY} />
            <Text style={[S.dateInputText, !toDate && S.placeholder]}>
              {toDate ? fmtDate(toDate) : "Select end date (optional)"}
            </Text>
            {toDate ? (
              <TouchableOpacity onPress={() => setToDate("")} style={S.clearIcon}>
                <Ionicons name="close-circle" size={16} color={GREY} />
              </TouchableOpacity>
            ) : null}
          </TouchableOpacity>

          {fromDate ? (
            <View style={S.datePreview}>
              <Ionicons name="checkmark-circle" size={13} color={OD_COLOR} />
              <Text style={S.datePreviewText}>
                {toDate && toDate >= fromDate
                  ? `${fmtDate(fromDate)} → ${fmtDate(toDate)} (Sundays excluded)`
                  : `Single day: ${fmtDate(fromDate)}`}
              </Text>
            </View>
          ) : null}

          {/* Reason */}
          <Text style={S.label}>Reason <Text style={S.required}>*</Text></Text>
          <TextInput
            style={S.textarea}
            value={reason}
            onChangeText={setReason}
            placeholder="Describe the reason (e.g. Medical appointment, Inter-college event...)"
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />

          {/* Proof Upload */}
          <Text style={S.label}>Proof Document <Text style={S.required}>*</Text></Text>
          <Text style={S.labelNote2}>
            Upload a photo or PDF (medical certificate, event letter, ID card, etc.)
          </Text>

          {proofFile ? (
            <View style={S.filePreview}>
              <View style={S.fileIcon}>
                <Ionicons
                  name={proofFile.type.startsWith("image") ? "image-outline" : "document-outline"}
                  size={22}
                  color={OD_COLOR}
                />
              </View>
              <View style={S.fileInfo}>
                <Text style={S.fileName} numberOfLines={1}>{proofFile.name}</Text>
                {proofFile.size ? <Text style={S.fileSize}>{fmtSize(proofFile.size)}</Text> : null}
              </View>
              <TouchableOpacity onPress={() => setProofFile(null)} style={S.removeFile}>
                <Ionicons name="close-circle" size={20} color={RED} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={S.uploadBtn} onPress={showProofOptions}>
              <Ionicons name="cloud-upload-outline" size={22} color={OD_COLOR} />
              <Text style={S.uploadBtnText}>Attach Proof</Text>
              <Text style={S.uploadBtnSub}>PDF, Image, or Word doc · Max 10 MB</Text>
            </TouchableOpacity>
          )}

          {/* Submit */}
          <TouchableOpacity
            style={[S.submitBtn, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting
              ? <ActivityIndicator size="small" color={WHITE} />
              : <>
                  <Ionicons name="send-outline" size={16} color={WHITE} />
                  <Text style={S.submitBtnText}>Submit OD Request</Text>
                </>
            }
          </TouchableOpacity>
        </View>

        {/* ══════════════════════════════════════════════════════════════════
            EXISTING REQUESTS
        ══════════════════════════════════════════════════════════════════ */}
        <Text style={S.sectionTitle}>Your OD Requests ({requests.length})</Text>

        {loading ? (
          <ActivityIndicator size="large" color={PRIMARY} style={{ marginTop: 24 }} />
        ) : requests.length === 0 ? (
          <View style={S.empty}>
            <Ionicons name="document-text-outline" size={48} color={BORDER} />
            <Text style={S.emptyText}>No OD requests for this subject yet</Text>
          </View>
        ) : (
          requests.map((od) => {
            const cfg = STATUS_CONFIG[od.status];
            return (
              <View
                key={od.od_id}
                style={[S.requestCard, { borderLeftColor: cfg.color, borderLeftWidth: 4 }]}
              >
                <View style={S.requestTop}>
                  <View style={S.requestDates}>
                    <Text style={S.requestDateMain}>{fmtDate(od.from_date)}</Text>
                    {od.to_date !== od.from_date && (
                      <Text style={S.requestDateTo}>→ {fmtDate(od.to_date)}</Text>
                    )}
                  </View>
                  <View style={[S.statusBadge, { backgroundColor: cfg.bg }]}>
                    <Ionicons name={cfg.icon as any} size={12} color={cfg.color} />
                    <Text style={[S.statusText, { color: cfg.color }]}>{cfg.label}</Text>
                  </View>
                </View>

                <Text style={S.requestReason}>{od.reason}</Text>

                <View style={S.proofRow}>
                  <Ionicons name="attach-outline" size={13} color={GREY} />
                  <Text style={S.proofName} numberOfLines={1}>
                    {od.proof?.name || "Proof attached"}
                  </Text>
                </View>

                {od.teacher_note && (
                  <View style={S.teacherNote}>
                    <Ionicons
                      name="chatbubble-outline"
                      size={12}
                      color={od.status === "rejected" ? RED : GREEN}
                    />
                    <Text style={[S.teacherNoteText, { color: od.status === "rejected" ? RED : DARK }]}>
                      {od.teacher_note}
                    </Text>
                  </View>
                )}

                {od.status === "approved" && (
                  <View style={S.approvedBanner}>
                    <Ionicons name="checkmark-circle" size={13} color={GREEN} />
                    <Text style={S.approvedBannerText}>
                      Attendance marked as OD for these dates
                    </Text>
                  </View>
                )}

                {od.status === "pending" && (
                  <TouchableOpacity style={S.cancelBtn} onPress={() => handleCancel(od)}>
                    <Ionicons name="close-outline" size={14} color={RED} />
                    <Text style={S.cancelBtnText}>Cancel Request</Text>
                  </TouchableOpacity>
                )}

                {od.created_at && (
                  <Text style={S.requestDate}>
                    Submitted:{" "}
                    {new Date(od.created_at).toLocaleDateString("en-IN", {
                      day: "numeric", month: "short", year: "numeric",
                    })}
                  </Text>
                )}
              </View>
            );
          })
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Date Picker Modal ───────────────────────────────────────────────── */}
      <Modal
        visible={activePicker !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setActivePicker(null)}
      >
        <View style={S.calendarOverlay}>
          <View style={S.calendarSheet}>
            <View style={S.calendarHeader}>
              <Text style={S.calendarTitle}>
                {activePicker === "from" ? "Select Start Date" : "Select End Date"}
              </Text>
              <TouchableOpacity onPress={() => setActivePicker(null)}>
                <Ionicons name="close" size={22} color={DARK} />
              </TouchableOpacity>
            </View>

            {/* ── Self-contained date picker — no attendance data needed ── */}
            <MiniDatePicker
              minDate={activePicker === "to" ? fromDate || undefined : undefined}
              onSelect={handleDateSelect}
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: WHITE,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    gap: 10,
  },
  backBtn:      { padding: 4 },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 17, fontWeight: "800", color: DARK },
  headerSub:    { fontSize: 12, color: GREY, marginTop: 1 },
  pendingBadge: {
    backgroundColor: AMBER + "22",
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pendingBadgeText: { fontSize: 11, fontWeight: "700", color: AMBER },

  scroll:        { flex: 1 },
  scrollContent: { padding: 16, gap: 16 },

  infoBanner: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: OD_SOFT,
    borderRadius: 14,
    padding: 14,
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: OD_COLOR + "33",
  },
  infoText: { flex: 1, fontSize: 13, color: "#4C1D95", lineHeight: 18 },

  card: {
    backgroundColor: WHITE,
    borderRadius: 20,
    padding: 20,
    gap: 12,
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 1,
  },
  cardTitle: { fontSize: 16, fontWeight: "800", color: DARK },

  label: {
    fontSize: 12, fontWeight: "700", color: GREY,
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  labelNote:  { fontSize: 11, fontWeight: "400", color: GREY, textTransform: "none" },
  labelNote2: { fontSize: 11, color: GREY, marginTop: -8 },
  required:   { color: RED },

  dateInput: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: BG,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: BORDER,
  },
  dateInputText: { flex: 1, fontSize: 14, color: DARK },
  placeholder:   { color: "#9CA3AF" },
  clearIcon:     { marginLeft: "auto" as any },

  datePreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: OD_SOFT,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: -4,
  },
  datePreviewText: { fontSize: 12, color: OD_COLOR, fontWeight: "600" },

  textarea: {
    backgroundColor: BG,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    color: DARK,
    borderWidth: 1,
    borderColor: BORDER,
    minHeight: 90,
  },

  uploadBtn: {
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: OD_COLOR + "66",
    borderRadius: 14,
    padding: 20,
    alignItems: "center",
    gap: 6,
    backgroundColor: OD_SOFT + "66",
  },
  uploadBtnText: { fontSize: 15, fontWeight: "700", color: OD_COLOR },
  uploadBtnSub:  { fontSize: 11, color: GREY },

  filePreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: OD_SOFT,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: OD_COLOR + "33",
  },
  fileIcon: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: WHITE,
    alignItems: "center", justifyContent: "center",
  },
  fileInfo:   { flex: 1 },
  fileName:   { fontSize: 13, fontWeight: "700", color: DARK },
  fileSize:   { fontSize: 11, color: GREY, marginTop: 2 },
  removeFile: { padding: 4 },

  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: OD_COLOR,
    borderRadius: 50,
    paddingVertical: 16,
    marginTop: 4,
  },
  submitBtnText: { color: WHITE, fontWeight: "700", fontSize: 15 },

  sectionTitle: {
    fontSize: 13, fontWeight: "800", color: GREY,
    textTransform: "uppercase", letterSpacing: 1,
  },

  empty:     { paddingVertical: 48, alignItems: "center", gap: 10 },
  emptyText: { fontSize: 14, color: GREY },

  requestCard: {
    backgroundColor: WHITE,
    borderRadius: 16,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 1,
  },
  requestTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  requestDates:    { gap: 2 },
  requestDateMain: { fontSize: 15, fontWeight: "700", color: DARK },
  requestDateTo:   { fontSize: 13, color: GREY },
  statusBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10,
  },
  statusText: { fontSize: 11, fontWeight: "700" },

  requestReason: { fontSize: 13, color: DARK, lineHeight: 18 },

  proofRow:  { flexDirection: "row", alignItems: "center", gap: 6 },
  proofName: { fontSize: 12, color: GREY, flex: 1 },

  teacherNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    backgroundColor: "#FEF2F2",
    borderRadius: 8,
    padding: 10,
  },
  teacherNoteText: { fontSize: 12, flex: 1, lineHeight: 16 },

  approvedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F0FDF4",
    borderRadius: 8,
    padding: 10,
  },
  approvedBannerText: { fontSize: 12, color: GREEN, fontWeight: "600" },

  cancelBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start" as any,
    borderWidth: 1,
    borderColor: RED + "44",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  cancelBtnText: { fontSize: 12, color: RED, fontWeight: "600" },

  requestDate: { fontSize: 11, color: GREY },

  calendarOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 20,
  },
  calendarSheet: {
    backgroundColor: WHITE,
    borderRadius: 20,
    padding: 16,
    gap: 12,
  },
  calendarHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  calendarTitle: { fontSize: 16, fontWeight: "700", color: DARK },
});