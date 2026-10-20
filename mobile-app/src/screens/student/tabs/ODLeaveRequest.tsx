/**
 * ODLeaveRequest.tsx
 * Student screen: submit an OD leave request with proof upload.
 * Shows existing OD requests for the subject and lets the student cancel pending ones.
 */
import { apiFetch, API_BASE } from "../../../services/api";
import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Banner, Button, Card, Chip, EmptyState, Header, Screen, SectionLabel, Sheet, SP, T, TextField, Tone, font } from "../../../components/ui";

const OD_COLOR = "#7C3AED";
const OD_SOFT  = "#EDE9FE";

const API_URL = API_BASE;

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

const STATUS_CONFIG: Record<ODRequest["status"], { tone: Tone; color: string; icon: any; label: string }> = {
  pending:  { tone: "warning", color: T.warning, icon: "time-outline",         label: "Pending"  },
  approved: { tone: "success", color: T.success, icon: "checkmark-circle",     label: "Approved" },
  rejected: { tone: "danger",  color: T.danger,  icon: "close-circle-outline", label: "Rejected" },
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
// A plain calendar with no attendance data: every non-Sunday date is selectable.
function MiniDatePicker({
  minDate,
  selected,
  onSelect,
}: {
  minDate?: string;   // "YYYY-MM-DD": dates before this are disabled
  selected?: string;
  onSelect: (ymd: string) => void;
}) {
  const today = new Date();
  const [viewYear,  setViewYear]  = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth()); // 0-based

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow    = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun

  const pad = (n: number) => String(n).padStart(2, "0");
  const toYmd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

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
  while (cells.length % 7 !== 0) cells.push(null);

  const todayYmd = toYmd(today.getFullYear(), today.getMonth(), today.getDate());

  return (
    <View style={{ paddingBottom: SP.lg }}>
      <View style={dp.nav}>
        <TouchableOpacity onPress={prevMonth} style={dp.navBtn} accessibilityLabel="Previous month">
          <Ionicons name="chevron-back" size={20} color={T.ink} />
        </TouchableOpacity>
        <Text style={font.h3}>{MONTH_NAMES[viewMonth]} {viewYear}</Text>
        <TouchableOpacity onPress={nextMonth} style={dp.navBtn} accessibilityLabel="Next month">
          <Ionicons name="chevron-forward" size={20} color={T.ink} />
        </TouchableOpacity>
      </View>

      <View style={dp.row}>
        {DAY_LABELS.map((d) => (
          <Text key={d} style={[dp.dayLabel, d === "Su" && { color: T.danger }]}>{d}</Text>
        ))}
      </View>

      {Array.from({ length: cells.length / 7 }, (_, row) => (
        <View key={row} style={dp.row}>
          {cells.slice(row * 7, row * 7 + 7).map((day, col) => {
            if (!day) return <View key={col} style={dp.cell} />;
            const ymd      = toYmd(viewYear, viewMonth, day);
            const isSunday = col === 0;
            const disabled = isSunday || (!!minDate && ymd < minDate);
            const isSel    = ymd === selected;
            const isToday  = ymd === todayYmd;
            return (
              <TouchableOpacity
                key={col}
                style={dp.cell}
                onPress={() => !disabled && onSelect(ymd)}
                disabled={disabled}
                activeOpacity={0.7}
              >
                <View style={[dp.dayPill, isSel && { backgroundColor: OD_COLOR }, !isSel && isToday && { borderWidth: 1.5, borderColor: OD_COLOR }]}>
                  <Text style={[dp.cellText, disabled && { color: T.muted, opacity: 0.5 }, isSunday && { color: T.danger }, isSel && { color: "#FFF", fontWeight: "800" }]}>
                    {day}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}

      <Text style={dp.hint}>Sundays are excluded</Text>
    </View>
  );
}

const dp = StyleSheet.create({
  nav:      { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: SP.md },
  navBtn:   { padding: 8 },
  row:      { flexDirection: "row" },
  dayLabel: { flex: 1, textAlign: "center", fontSize: 11, fontWeight: "700", color: T.muted, paddingVertical: 6 },
  cell:     { flex: 1, aspectRatio: 1, alignItems: "center", justifyContent: "center" },
  dayPill:  { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  cellText: { fontSize: 14, color: T.ink, fontWeight: "600" },
  hint:     { textAlign: "center", fontSize: 11.5, color: T.muted, marginTop: SP.md },
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
      const res  = await apiFetch(
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

      const res  = await apiFetch(`${API_URL}/api/od/request`, {
        method:  "POST",
        body:    form,
        headers: { Accept: "application/json" },
      });
      const json = await safeJson(res);

      if (json.success) {
        Alert.alert(
          "Request submitted",
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
              const res  = await apiFetch(`${API_URL}/api/od/${od.od_id}`, {
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
    <Screen edges={["top"]}>
      <Header
        title="OD leave request"
        subtitle={subjectName}
        onBack={() => navigation.goBack()}
        right={pendingCount > 0 ? <Chip label={`${pendingCount} pending`} tone="warning" /> : undefined}
      />

      <ScrollView
        contentContainerStyle={S.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Banner tone="info" icon="information-circle" style={{ backgroundColor: OD_SOFT }}>
          Attach a valid proof (medical certificate, event letter). Approved days are marked OD in your attendance.
        </Banner>

        {/* New request form */}
        <Card style={{ gap: SP.lg }}>
          <Text style={font.h2}>New request</Text>

          <View>
            <Text style={S.label}>From date <Text style={{ color: T.danger }}>*</Text></Text>
            <TouchableOpacity style={S.dateInput} onPress={() => setActivePicker("from")} activeOpacity={0.8}>
              <Ionicons name="calendar-outline" size={18} color={fromDate ? OD_COLOR : T.muted} />
              <Text style={[S.dateText, !fromDate && { color: T.muted }]}>
                {fromDate ? fmtDate(fromDate) : "Select start date"}
              </Text>
            </TouchableOpacity>
          </View>

          <View>
            <Text style={S.label}>To date <Text style={S.optional}>(optional, blank for one day)</Text></Text>
            <TouchableOpacity style={S.dateInput} onPress={() => setActivePicker("to")} activeOpacity={0.8}>
              <Ionicons name="calendar-outline" size={18} color={toDate ? OD_COLOR : T.muted} />
              <Text style={[S.dateText, !toDate && { color: T.muted }]}>
                {toDate ? fmtDate(toDate) : "Select end date"}
              </Text>
              {toDate ? (
                <TouchableOpacity onPress={() => setToDate("")} hitSlop={10} accessibilityLabel="Clear end date">
                  <Ionicons name="close-circle" size={18} color={T.muted} />
                </TouchableOpacity>
              ) : null}
            </TouchableOpacity>
          </View>

          {fromDate ? (
            <View style={S.datePreview}>
              <Ionicons name="checkmark-circle" size={14} color={OD_COLOR} />
              <Text style={S.datePreviewText}>
                {toDate && toDate >= fromDate
                  ? `${fmtDate(fromDate)} to ${fmtDate(toDate)} (Sundays excluded)`
                  : `Single day: ${fmtDate(fromDate)}`}
              </Text>
            </View>
          ) : null}

          <TextField
            label="Reason *"
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. Medical appointment, inter-college event"
            multiline
            minHeight={96}
            autoCapitalize="sentences"
          />

          <View>
            <Text style={S.label}>Proof document <Text style={{ color: T.danger }}>*</Text></Text>
            {proofFile ? (
              <View style={S.filePreview}>
                <View style={S.fileIcon}>
                  <Ionicons
                    name={proofFile.type.startsWith("image") ? "image-outline" : "document-outline"}
                    size={22}
                    color={OD_COLOR}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={font.h3} numberOfLines={1}>{proofFile.name}</Text>
                  {proofFile.size ? <Text style={font.small}>{fmtSize(proofFile.size)}</Text> : null}
                </View>
                <TouchableOpacity onPress={() => setProofFile(null)} hitSlop={10} accessibilityLabel="Remove file">
                  <Ionicons name="close-circle" size={22} color={T.danger} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={S.uploadBtn} onPress={showProofOptions} activeOpacity={0.8}>
                <Ionicons name="cloud-upload-outline" size={24} color={OD_COLOR} />
                <Text style={S.uploadText}>Attach proof</Text>
                <Text style={font.small}>PDF, image or Word doc, max 10 MB</Text>
              </TouchableOpacity>
            )}
          </View>

          <Button
            label="Submit OD request"
            icon="send-outline"
            loading={submitting}
            onPress={handleSubmit}
            style={{ backgroundColor: OD_COLOR }}
          />
        </Card>

        {/* Existing requests */}
        <SectionLabel style={{ marginTop: SP.sm, marginBottom: 0 }}>Your requests ({requests.length})</SectionLabel>

        {loading ? (
          <ActivityIndicator size="large" color={T.primary} style={{ marginTop: SP.xl }} />
        ) : requests.length === 0 ? (
          <EmptyState icon="document-text-outline" title="No OD requests yet" text="Requests for this subject will show here." />
        ) : (
          requests.map((od) => {
            const cfg = STATUS_CONFIG[od.status];
            return (
              <Card key={od.od_id} flat padded={false} style={S.reqCard}>
                <View style={[S.reqAccent, { backgroundColor: cfg.color }]} />
                <View style={S.reqBody}>
                  <View style={S.reqTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={font.h3}>{fmtDate(od.from_date)}</Text>
                      {od.to_date !== od.from_date && (
                        <Text style={font.small}>to {fmtDate(od.to_date)}</Text>
                      )}
                    </View>
                    <Chip label={cfg.label} icon={cfg.icon} tone={cfg.tone} />
                  </View>

                  <Text style={font.body}>{od.reason}</Text>

                  <View style={S.proofRow}>
                    <Ionicons name="attach-outline" size={14} color={T.muted} />
                    <Text style={[font.small, { flex: 1 }]} numberOfLines={1}>
                      {od.proof?.name || "Proof attached"}
                    </Text>
                  </View>

                  {od.teacher_note && (
                    <Banner tone={od.status === "rejected" ? "danger" : "success"} icon="chatbubble-outline">
                      {od.teacher_note}
                    </Banner>
                  )}

                  {od.status === "approved" && (
                    <Banner tone="success">Attendance marked as OD for these dates</Banner>
                  )}

                  {od.status === "pending" && (
                    <Button label="Cancel request" icon="close-outline" variant="dangerSoft" size="md" onPress={() => handleCancel(od)} />
                  )}

                  {od.created_at && (
                    <Text style={font.small}>
                      Submitted{" "}
                      {new Date(od.created_at).toLocaleDateString("en-IN", {
                        day: "numeric", month: "short", year: "numeric",
                      })}
                    </Text>
                  )}
                </View>
              </Card>
            );
          })
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Date picker */}
      <Sheet
        visible={activePicker !== null}
        onClose={() => setActivePicker(null)}
        title={activePicker === "from" ? "Select start date" : "Select end date"}
      >
        <MiniDatePicker
          minDate={activePicker === "to" ? fromDate || undefined : undefined}
          selected={activePicker === "from" ? fromDate : toDate}
          onSelect={handleDateSelect}
        />
      </Sheet>
    </Screen>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  scroll: { padding: SP.lg, gap: SP.lg },

  label:    { fontSize: 12.5, fontWeight: "700", color: T.sub, marginBottom: 6 },
  optional: { fontSize: 11.5, fontWeight: "500", color: T.muted },

  dateInput: {
    flexDirection: "row", alignItems: "center", gap: SP.sm,
    backgroundColor: T.surface, borderRadius: 14, paddingHorizontal: SP.lg, height: 52,
    borderWidth: 1.5, borderColor: T.line,
  },
  dateText: { flex: 1, fontSize: 15, color: T.ink },

  datePreview: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: OD_SOFT, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, marginTop: -SP.xs },
  datePreviewText: { fontSize: 12.5, color: OD_COLOR, fontWeight: "700", flex: 1 },

  uploadBtn: {
    borderWidth: 1.5, borderStyle: "dashed", borderColor: OD_COLOR + "77", borderRadius: 16,
    paddingVertical: SP.xl, alignItems: "center", gap: 4, backgroundColor: OD_SOFT + "88",
  },
  uploadText: { fontSize: 15, fontWeight: "700", color: OD_COLOR },

  filePreview: { flexDirection: "row", alignItems: "center", gap: SP.md, backgroundColor: OD_SOFT, borderRadius: 14, padding: SP.md },
  fileIcon:    { width: 42, height: 42, borderRadius: 12, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center" },

  reqCard:   { flexDirection: "row", overflow: "hidden" },
  reqAccent: { width: 4 },
  reqBody:   { flex: 1, padding: SP.lg, gap: SP.md },
  reqTop:    { flexDirection: "row", alignItems: "flex-start", gap: SP.sm },
  proofRow:  { flexDirection: "row", alignItems: "center", gap: 6 },
});