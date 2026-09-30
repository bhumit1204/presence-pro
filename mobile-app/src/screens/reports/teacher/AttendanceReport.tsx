import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Modal,
  TextInput,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import AttendanceCalendar from "../../../components/AttendanceCalendar";
import { useNavigation } from "@react-navigation/native";

const PRIMARY = "#4834D4";
const PRIMARY_SOFT = "#EEF2FF";
const BG = "#F3F4F6";
const WHITE = "#FFFFFF";
const GREY = "#6B7280";
const DARK = "#111827";
const GREEN = "#10B981";
const AMBER = "#F59E0B";
const RED = "#EF4444";
const BORDER   = "#E5E7EB";
const OD_COLOR = "#7C3AED";
const OD_SOFT  = "#EDE9FE";

const API_URL = "http://10.132.90.56:5000";

interface Props {
  studentUid:  string;
  studentName: string;
  subjectId:   string;
  subjectName?: string;
  teacherId:   string;
  courseId?:   string;
  isTeacher?:  boolean;   // true when rendered inside teacher's StudentReportDetail
}

// "date" mode = single date filter (from_date only, no to_date).
// Summary card never changes — it always reflects the full picture.
type FilterMode = "all" | "date" | "range";
type AttendanceStatus = "present" | "absent";

// Which calendar picker is currently open
type PickerTarget = "from" | "to" | "manualStart" | "manualEnd" | null;

export default function AttendanceReport({ studentUid, studentName, subjectId, subjectName, teacherId, courseId, isTeacher }: Props) {
  const navigation = useNavigation<any>();
  // ── Data ──────────────────────────────────────────────────────────────────
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // ── Filter state ──────────────────────────────────────────────────────────
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  // from/to are passed to the API to filter the records list only.
  // The summary card always reflects the full picture.
  const [fromDate, setFromDate] = useState<string | null>(null);
  const [toDate, setToDate] = useState<string | null>(null);

  // ── Manual attendance modal ───────────────────────────────────────────────
  const [manualModalVisible, setManualModalVisible] = useState(false);
  const [manualStartDate, setManualStartDate] = useState("");   // required
  const [manualEndDate, setManualEndDate] = useState("");       // optional
  const [manualStatus, setManualStatus] = useState<AttendanceStatus>("present");
  const [manualNote, setManualNote] = useState("");
  const [savingManual, setSavingManual] = useState(false);

  // ── Calendar picker state ─────────────────────────────────────────────────
  const [activePicker, setActivePicker] = useState<PickerTarget>(null);

  // ─────────────────────────────────────────────────────────────────────────
  // Fetch attendance data.
  // The API always returns the full summary regardless of date params.
  // Date params only affect the records[] list.
  // ─────────────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      let url =
        `${API_URL}/api/reports/student/${studentUid}/attendance` +
        `?teacher_id=${teacherId}&subject_id=${subjectId}`;
      if (fromDate) url += `&from_date=${fromDate}`;
      if (toDate)   url += `&to_date=${toDate}`;

      const res = await fetch(url);
      const json = await res.json();
      if (json.success) setData(json);
    } catch (e) {
      console.log("ATTENDANCE FETCH:", e);
    } finally {
      setLoading(false);
    }
  }, [studentUid, teacherId, subjectId, fromDate, toDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ─────────────────────────────────────────────────────────────────────────
  // Filter mode helpers
  // ─────────────────────────────────────────────────────────────────────────
  const applyFilter = (mode: FilterMode) => {
    setFilterMode(mode);
    if (mode === "all") {
      setFromDate(null);
      setToDate(null);
    } else if (mode === "date") {
      // Reset to_date — only a single date is used
      setToDate(null);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Calendar picker handler
  // ─────────────────────────────────────────────────────────────────────────
  const handleDateSelect = (selected: { year: number; month: number; date: number }) => {
    const formatted = `${selected.year}-${String(selected.month).padStart(2, "0")}-${String(selected.date).padStart(2, "0")}`;

    switch (activePicker) {
      case "from":
        setFromDate(formatted);
        break;
      case "to":
        setToDate(formatted);
        break;
      case "manualStart":
        setManualStartDate(formatted);
        break;
      case "manualEnd":
        setManualEndDate(formatted);
        break;
    }
    setActivePicker(null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Save manual attendance
  // Sends start date (required) + optional end date.
  // Backend iterates the range, skips Sundays, upserts one record per date
  // into attendance_records.
  // ─────────────────────────────────────────────────────────────────────────
  const handleManualSave = async () => {
    if (!manualStartDate) {
      Alert.alert("Error", "Please select a start date.");
      return;
    }
    if (manualEndDate && manualEndDate < manualStartDate) {
      Alert.alert("Error", "End date cannot be before start date.");
      return;
    }
    try {
      setSavingManual(true);
      const body: any = {
        teacher_id: teacherId,
        subject_id: subjectId,
        student_uid: studentUid,
        date: manualStartDate,
        status: manualStatus,
        note: manualNote || null,
      };
      if (manualEndDate) body.end_date = manualEndDate;

      const res = await fetch(`${API_URL}/api/reports/attendance/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        Alert.alert("Success", json.message);
        setManualModalVisible(false);
        setManualStartDate("");
        setManualEndDate("");
        setManualNote("");
        setManualStatus("present");
        fetchData();
      } else {
        Alert.alert("Error", json.error || "Failed to save attendance.");
      }
    } catch {
      Alert.alert("Error", "Could not save attendance.");
    } finally {
      setSavingManual(false);
    }
  };

  const resetManualModal = () => {
    setManualModalVisible(false);
    setManualStartDate("");
    setManualEndDate("");
    setManualNote("");
    setManualStatus("present");
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Misc helpers
  // ─────────────────────────────────────────────────────────────────────────
  const getStatusColor = (status: string) => {
    if (status === "present") return GREEN;
    if (status === "od")      return OD_COLOR;
    return RED;
  };
  const getStatusIcon  = (status: string) => {
    if (status === "present") return "checkmark-circle";
    if (status === "od")      return "shield-checkmark";
    return "close-circle";
  };
  const getStatusLabel = (status: string) => {
    if (status === "present") return "Present";
    if (status === "od")      return "OD";
    return "Absent";
  };

  if (loading) {
    return (
      <View style={S.center}>
        <ActivityIndicator size="large" color={PRIMARY} />
      </View>
    );
  }

  const allRecords = data?.records || [];
  const summary    = data?.summary || {};

  // Split OD records out so they render separately
  const odRecords      = allRecords.filter((r: any) => r.status === "od");
  const regularRecords = allRecords.filter((r: any) => r.status !== "od");
  const records = regularRecords; // used by existing filter-aware display

  // Summary always shows the full-picture percentage (unaffected by filter)
  const pct = summary.percentage ?? 0;
  const pctColor = pct >= 75 ? GREEN : pct >= 50 ? AMBER : RED;
  const summaryOdCount = summary.od ?? odRecords.length; // prefer backend summary, fall back to list

  return (
    <View style={S.container}>

      {/* ── Summary Card ─────────────────────────────────────────────────── */}
      <View style={S.summaryCard}>
        <View style={S.summaryLeft}>
          <Text style={[S.summaryPct, { color: pctColor }]}>{pct}%</Text>
          <Text style={S.summaryLabel}>Attendance</Text>
          <Text style={S.summaryDetail}>
            {summary.present ?? 0} present of {summary.total_lectures ?? 0} lectures
          </Text>
        </View>
        <View style={S.summaryRight}>
          {[
            { label: "Present", value: summary.present ?? 0, color: GREEN },
            { label: "Absent",  value: summary.absent  ?? 0, color: RED   },
            ...(summaryOdCount > 0
              ? [{ label: "OD", value: summaryOdCount, color: OD_COLOR }]
              : []),
          ].map((item) => (
            <View key={item.label} style={S.summaryItem}>
              <Text style={[S.summaryItemVal, { color: item.color }]}>{item.value}</Text>
              <Text style={S.summaryItemLabel}>{item.label}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* ── Progress Bar ─────────────────────────────────────────────────── */}
      <View style={S.progressBar}>
        <View style={[S.progressFill, { width: `${Math.min(pct, 100)}%`, backgroundColor: pctColor }]} />
      </View>
      <Text style={[S.pctWarning, { color: pctColor }]}>
        {pct >= 75
          ? "✓ Attendance is satisfactory"
          : pct >= 50
          ? "⚠ Attendance is below 75%"
          : "✗ Critical — attendance very low"}
      </Text>

      {/* ── Filter Bar ───────────────────────────────────────────────────── */}
      <View style={S.filterBar}>
        {(["all", "date", "range"] as FilterMode[]).map((mode) => (
          <TouchableOpacity
            key={mode}
            style={[S.filterChip, filterMode === mode && S.filterChipActive]}
            onPress={() => applyFilter(mode)}
          >
            <Text style={[S.filterChipText, filterMode === mode && S.filterChipTextActive]}>
              {mode === "all" ? "All" : mode === "date" ? "By Date" : "Date Range"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── By Date: single date picker ──────────────────────────────────── */}
      {filterMode === "date" && (
        <View style={S.rangeRow}>
          <TouchableOpacity
            style={[S.dateInput, { flex: 1 }]}
            onPress={() => setActivePicker("from")}
          >
            <Ionicons name="calendar-outline" size={14} color={GREY} />
            <Text style={[S.dateInputText, !fromDate && { color: "#9CA3AF" }]}>
              {fromDate || "Select date"}
            </Text>
          </TouchableOpacity>
          {fromDate && (
            <TouchableOpacity
              style={S.clearBtn}
              onPress={() => { setFromDate(null); setToDate(null); }}
            >
              <Ionicons name="close-circle" size={18} color={GREY} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── Date Range: from + to pickers ────────────────────────────────── */}
      {filterMode === "range" && (
        <View style={S.rangeRow}>
          <TouchableOpacity
            style={S.dateInput}
            onPress={() => setActivePicker("from")}
          >
            <Ionicons name="calendar-outline" size={14} color={GREY} />
            <Text style={[S.dateInputText, !fromDate && { color: "#9CA3AF" }]}>
              {fromDate || "From date"}
            </Text>
          </TouchableOpacity>
          <Text style={{ color: GREY, fontWeight: "700" }}>→</Text>
          <TouchableOpacity
            style={S.dateInput}
            onPress={() => setActivePicker("to")}
          >
            <Ionicons name="calendar-outline" size={14} color={GREY} />
            <Text style={[S.dateInputText, !toDate && { color: "#9CA3AF" }]}>
              {toDate || "To date"}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── OD Request Button ────────────────────────────────────────────── */}
      {!isTeacher ? (
        <TouchableOpacity
          style={S.odBtn}
          onPress={() => navigation.navigate("ODLeaveRequest", {
            studentUid,
            studentName,
            subjectId,
            subjectName: subjectName || subjectId,
            teacherId,
            courseId: courseId || "",
          })}
        >
          <Ionicons name="shield-checkmark-outline" size={16} color={OD_COLOR} />
          <Text style={S.odBtnText}>Request OD Leave</Text>
          {summaryOdCount > 0 && (
            <View style={S.odCountBadge}>
              <Text style={S.odCountText}>{summaryOdCount} approved</Text>
            </View>
          )}
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={S.odBtn}
          onPress={() => navigation.navigate("ODRequestsTeacher", {
            teacherId,
            subjectId,
            subjectName: subjectName || subjectId,
            courseId: courseId || "",
          })}
        >
          <Ionicons name="shield-checkmark-outline" size={16} color={OD_COLOR} />
          <Text style={S.odBtnText}>View OD Requests</Text>
          {summaryOdCount > 0 && (
            <View style={S.odCountBadge}>
              <Text style={S.odCountText}>{summaryOdCount} approved</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* ── Manual Attendance Button ──────────────────────────────────────── */}
      <TouchableOpacity style={S.manualBtn} onPress={() => setManualModalVisible(true)}>
        <Ionicons name="create-outline" size={16} color={PRIMARY} />
        <Text style={S.manualBtnText}>Add / Edit Attendance Manually</Text>
      </TouchableOpacity>

      {/* ── Records List ─────────────────────────────────────────────────── */}
      <Text style={S.sectionTitle}>
        Attendance Records ({records.length}
        {filterMode !== "all" ? " — filtered" : ""})</Text>

      {records.length === 0 ? (
        <View style={S.empty}>
          <Ionicons name="calendar-outline" size={40} color={BORDER} />
          <Text style={S.emptyText}>No attendance records found</Text>
        </View>
      ) : (
        records.map((record: any, idx: number) => (
          <View key={record.attendance_id || idx} style={S.recordCard}>
            <View style={[S.recordDot, { backgroundColor: getStatusColor(record.status) }]} />
            <View style={S.recordInfo}>
              <Text style={S.recordDate}>
                {new Date(record.date).toLocaleDateString("en-IN", {
                  weekday: "short", day: "numeric", month: "short", year: "numeric",
                })}
              </Text>
              {record.marked_by === "manual" && (
                <Text style={S.manualTag}>Manual Entry</Text>
              )}
            </View>
            <View style={[S.statusBadge, { backgroundColor: getStatusColor(record.status) + "18" }]}>
              <Ionicons
                name={getStatusIcon(record.status) as any}
                size={13}
                color={getStatusColor(record.status)}
              />
              <Text style={[S.statusText, { color: getStatusColor(record.status) }]}>
                {getStatusLabel(record.status)}
              </Text>
            </View>
          </View>
        ))
      )}

      {/* ── OD Records Section ───────────────────────────────────────────── */}
      {odRecords.length > 0 && (
        <>
          <View style={S.odSectionHeader}>
            <Ionicons name="shield-checkmark" size={15} color={OD_COLOR} />
            <Text style={S.odSectionTitle}>OD Records ({odRecords.length})</Text>
          </View>
          <View style={S.odInfoBanner}>
            <Text style={S.odInfoText}>
              These dates are marked as On Duty (OD) and count towards your attendance.
            </Text>
          </View>
          {odRecords.map((record: any, idx: number) => (
            <View key={record.attendance_id || `od-${idx}`} style={S.odCard}>
              <View style={S.odDot} />
              <View style={S.recordInfo}>
                <Text style={S.recordDate}>
                  {new Date(record.date).toLocaleDateString("en-IN", {
                    weekday: "short", day: "numeric", month: "short", year: "numeric",
                  })}
                </Text>
                {record.note && (
                  <Text style={S.odNote} numberOfLines={1}>{record.note}</Text>
                )}
              </View>
              <View style={S.odBadge}>
                <Ionicons name="shield-checkmark" size={13} color={OD_COLOR} />
                <Text style={S.odBadgeText}>OD</Text>
              </View>
            </View>
          ))}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          Manual Attendance Modal
          - manualStartDate: required (single date or range start)
          - manualEndDate:   optional (range end — backend skips Sundays)
      ══════════════════════════════════════════════════════════════════════ */}
      <Modal
        visible={manualModalVisible}
        animationType="slide"
        transparent
        onRequestClose={resetManualModal}
      >
        <View style={S.modalOverlay}>
          <View style={S.modalContent}>
            {/* Header */}
            <View style={S.modalHeader}>
              <Text style={S.modalTitle}>Add Manual Attendance</Text>
              <TouchableOpacity onPress={resetManualModal}>
                <Ionicons name="close" size={22} color={DARK} />
              </TouchableOpacity>
            </View>

            <Text style={S.modalStudent}>{studentName}</Text>

            {/* Start Date (required) */}
            <Text style={S.inputLabel}>Start Date <Text style={{ color: RED }}>*</Text></Text>
            <TouchableOpacity
              style={S.textInput}
              onPress={() => setActivePicker("manualStart")}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="calendar-outline" size={16} color={GREY} />
                <Text style={{ color: manualStartDate ? DARK : "#9CA3AF", fontSize: 14 }}>
                  {manualStartDate || "Select start date"}
                </Text>
              </View>
            </TouchableOpacity>

            {/* End Date (optional) */}
            <Text style={S.inputLabel}>
              End Date{" "}
              <Text style={{ color: GREY, fontWeight: "400", textTransform: "none" }}>
                (optional — marks entire range, skips Sundays)
              </Text>
            </Text>
            <TouchableOpacity
              style={S.textInput}
              onPress={() => setActivePicker("manualEnd")}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="calendar-outline" size={16} color={GREY} />
                <Text style={{ color: manualEndDate ? DARK : "#9CA3AF", fontSize: 14 }}>
                  {manualEndDate || "Select end date (optional)"}
                </Text>
                {manualEndDate ? (
                  <TouchableOpacity
                    style={{ marginLeft: "auto" }}
                    onPress={() => setManualEndDate("")}
                  >
                    <Ionicons name="close-circle" size={16} color={GREY} />
                  </TouchableOpacity>
                ) : null}
              </View>
            </TouchableOpacity>

            {/* Date range preview */}
            {manualStartDate && (
              <Text style={S.rangePreview}>
                {manualEndDate && manualEndDate >= manualStartDate
                  ? `Marking from ${manualStartDate} to ${manualEndDate} (Sundays skipped)`
                  : `Marking single date: ${manualStartDate}`}
              </Text>
            )}

            {/* Status */}
            <Text style={S.inputLabel}>Status</Text>
            <View style={S.statusRow}>
              {(["present", "absent"] as AttendanceStatus[]).map((s) => (
                <TouchableOpacity
                  key={s}
                  style={[
                    S.statusChip,
                    manualStatus === s && {
                      backgroundColor: getStatusColor(s),
                      borderColor: getStatusColor(s),
                    },
                  ]}
                  onPress={() => setManualStatus(s)}
                >
                  <Text style={[S.statusChipText, manualStatus === s && { color: WHITE }]}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Note */}
            <Text style={S.inputLabel}>Note (optional)</Text>
            <TextInput
              style={[S.textInput, { height: 70 }]}
              value={manualNote}
              onChangeText={setManualNote}
              placeholder="Reason or note..."
              placeholderTextColor="#9CA3AF"
              multiline
              textAlignVertical="top"
            />

            <TouchableOpacity
              style={[S.saveBtn, savingManual && { opacity: 0.6 }]}
              onPress={handleManualSave}
              disabled={savingManual}
            >
              {savingManual
                ? <ActivityIndicator size="small" color={WHITE} />
                : <Text style={S.saveBtnText}>Save Attendance</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ══════════════════════════════════════════════════════════════════════
          Shared Calendar Modal
          Used by: filter from/to AND manual start/end date pickers.
          activePicker determines what gets updated.
      ══════════════════════════════════════════════════════════════════════ */}
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
                {activePicker === "from"        ? "Select From Date"
                 : activePicker === "to"        ? "Select To Date"
                 : activePicker === "manualStart" ? "Select Start Date"
                 : "Select End Date"}
              </Text>
              <TouchableOpacity onPress={() => setActivePicker(null)}>
                <Ionicons name="close" size={22} color={DARK} />
              </TouchableOpacity>
            </View>
            <AttendanceCalendar onDateSelect={handleDateSelect} />
          </View>
        </View>
      </Modal>

    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  container: { gap: 12 },
  center: { paddingVertical: 60, alignItems: "center" },
  empty: { paddingVertical: 40, alignItems: "center", gap: 10 },
  emptyText: { fontSize: 14, color: GREY },

  summaryCard: {
    backgroundColor: WHITE,
    borderRadius: 20,
    padding: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 1,
  },
  summaryLeft: { gap: 4 },
  summaryPct: { fontSize: 36, fontWeight: "800" },
  summaryLabel: { fontSize: 12, fontWeight: "700", color: GREY, textTransform: "uppercase" },
  summaryDetail: { fontSize: 12, color: GREY },
  summaryRight: { flexDirection: "row", gap: 16 },
  summaryItem: { alignItems: "center" },
  summaryItemVal: { fontSize: 20, fontWeight: "800" },
  summaryItemLabel: { fontSize: 11, color: GREY, fontWeight: "600" },

  progressBar: { height: 8, backgroundColor: "#E5E7EB", borderRadius: 4, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 4 },
  pctWarning: { fontSize: 12, fontWeight: "700", marginTop: -4 },

  filterBar: { flexDirection: "row", gap: 8 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: WHITE,
    borderWidth: 1,
    borderColor: BORDER,
  },
  filterChipActive: { backgroundColor: PRIMARY_SOFT, borderColor: PRIMARY },
  filterChipText: { fontSize: 12, fontWeight: "600", color: GREY },
  filterChipTextActive: { color: PRIMARY },

  rangeRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  dateInput: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: WHITE,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: BORDER,
  },
  dateInputText: { fontSize: 13, color: DARK },
  clearBtn: { padding: 4 },

  manualBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: PRIMARY_SOFT,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#C7D2FE",
  },
  manualBtnText: { fontSize: 14, fontWeight: "700", color: PRIMARY },

  sectionTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: GREY,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 4,
  },

  recordCard: {
    backgroundColor: WHITE,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 1,
  },
  recordDot: { width: 10, height: 10, borderRadius: 5 },
  recordInfo: { flex: 1 },
  recordDate: { fontSize: 14, fontWeight: "600", color: DARK },
  manualTag: {
    fontSize: 10,
    fontWeight: "700",
    color: PRIMARY,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 2,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  statusText: { fontSize: 11, fontWeight: "700" },

  // Manual modal
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalContent: {
    backgroundColor: WHITE,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    gap: 14,
    paddingBottom: 40,
  },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 18, fontWeight: "800", color: DARK },
  modalStudent: { fontSize: 14, color: PRIMARY, fontWeight: "700" },
  inputLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: GREY,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  textInput: {
    backgroundColor: BG,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    color: DARK,
    borderWidth: 1,
    borderColor: BORDER,
  },
  rangePreview: {
    fontSize: 12,
    color: PRIMARY,
    fontWeight: "600",
    backgroundColor: PRIMARY_SOFT,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusRow: { flexDirection: "row", gap: 10 },
  statusChip: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: BORDER,
    alignItems: "center",
    backgroundColor: WHITE,
  },
  statusChipText: { fontSize: 13, fontWeight: "700", color: GREY },
  saveBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 50,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 4,
  },
  saveBtnText: { color: WHITE, fontWeight: "700", fontSize: 15 },

  // Calendar picker modal
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

  // OD button
  odBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: OD_SOFT,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: OD_COLOR + "44",
  },
  odBtnText:     { fontSize: 14, fontWeight: "700", color: OD_COLOR, flex: 1 },
  odCountBadge:  { backgroundColor: OD_COLOR, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  odCountText:   { fontSize: 10, fontWeight: "700", color: WHITE },

  // OD section
  odSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  odSectionTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: OD_COLOR,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  odInfoBanner: {
    backgroundColor: OD_SOFT,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: OD_COLOR + "33",
  },
  odInfoText:  { fontSize: 12, color: "#4C1D95", lineHeight: 16 },
  odCard: {
    backgroundColor: OD_SOFT + "88",
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: OD_COLOR + "33",
    elevation: 0,
  },
  odDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: OD_COLOR },
  odNote: { fontSize: 11, color: OD_COLOR, marginTop: 2, fontStyle: "italic" },
  odBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: OD_COLOR + "18",
  },
  odBadgeText: { fontSize: 11, fontWeight: "700", color: OD_COLOR },
});