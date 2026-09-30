/**
 * ODRequestsTeacher.tsx
 * Teacher screen — review, approve or reject student OD requests.
 * Shows pending requests first, then history.
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  Linking,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute, useFocusEffect } from "@react-navigation/native";

// ─── Palette ──────────────────────────────────────────────────────────────────
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

// ─── Types ────────────────────────────────────────────────────────────────────
interface ODRequest {
  od_id:        string;
  student_uid:  string;
  student_name: string;
  from_date:    string;
  to_date:      string;
  reason:       string;
  status:       "pending" | "approved" | "rejected";
  teacher_note: string | null;
  created_at:   string | null;
  proof:        { url: string; name: string; type: string };
}

interface RouteParams {
  teacherId:   string;
  subjectId?:  string;
  subjectName?: string;
  courseId?:   string;
}

const STATUS_CONFIG = {
  pending:  { color: AMBER,  bg: "#FEF3C7", icon: "time-outline",         label: "Pending"  },
  approved: { color: GREEN,  bg: "#F0FDF4", icon: "checkmark-circle",     label: "Approved" },
  rejected: { color: RED,    bg: "#FEF2F2", icon: "close-circle-outline", label: "Rejected" },
};

type FilterStatus = "all" | "pending" | "approved" | "rejected";

function fmtDate(ymd: string) {
  return new Date(ymd + "T12:00:00").toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

export default function ODRequestsTeacher() {
  const navigation = useNavigation<any>();
  const route      = useRoute<any>();
  const { teacherId, subjectId, subjectName, courseId }: RouteParams = route.params;

  const [requests,   setRequests]   = useState<ODRequest[]>([]);
  const [summary,    setSummary]    = useState({ pending: 0, approved: 0, rejected: 0 });
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter,     setFilter]     = useState<FilterStatus>("all");

  // ── Review modal state ───────────────────────────────────────────────────────
  const [reviewModal,  setReviewModal]  = useState(false);
  const [activeOD,     setActiveOD]     = useState<ODRequest | null>(null);
  const [reviewAction, setReviewAction] = useState<"approved" | "rejected" | null>(null);
  const [teacherNote,  setTeacherNote]  = useState("");
  const [submitting,   setSubmitting]   = useState(false);

  // ── Proof viewer ─────────────────────────────────────────────────────────────
  const [proofModal, setProofModal]   = useState(false);
  const [proofOD,    setProofOD]      = useState<ODRequest | null>(null);

  // ─── Fetch ───────────────────────────────────────────────────────────────────
  const fetchRequests = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      let url = `${API_URL}/api/od/teacher/${teacherId}`;
      if (subjectId) url += `?subject_id=${subjectId}`;

      const res  = await fetch(url);
      const json = await res.json();

      if (json.success) {
        setRequests(json.requests);
        setSummary(json.summary);
      }
    } catch (e) {
      console.log("OD TEACHER FETCH:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [teacherId, subjectId]);

  useFocusEffect(useCallback(() => { fetchRequests(); }, [fetchRequests]));

  // ─── Open review modal ───────────────────────────────────────────────────────
  const openReview = (od: ODRequest, action: "approved" | "rejected") => {
    setActiveOD(od);
    setReviewAction(action);
    setTeacherNote("");
    setReviewModal(true);
  };

  // ─── Submit review ───────────────────────────────────────────────────────────
  const handleReview = async () => {
    if (!activeOD || !reviewAction) return;
    try {
      setSubmitting(true);
      const res  = await fetch(`${API_URL}/api/od/${activeOD.od_id}/review`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          teacher_id:  teacherId,
          action:      reviewAction,
          teacher_note: teacherNote.trim() || null,
        }),
      });
      const json = await res.json();

      if (json.success) {
        setReviewModal(false);
        fetchRequests();
        Alert.alert(
          reviewAction === "approved" ? "Approved " : "Rejected ❌",
          json.message
        );
      } else {
        Alert.alert("Error", json.error || "Failed to update OD.");
      }
    } catch {
      Alert.alert("Error", "Network error.");
    } finally {
      setSubmitting(false);
    }
  };

  // ─── View proof ───────────────────────────────────────────────────────────────
  const viewProof = async (od: ODRequest) => {
    if (!od.proof?.url) {
      Alert.alert("No proof", "No proof document found for this request.");
      return;
    }
    // For images open inline, for PDFs open in browser
    const isImage = od.proof.type?.startsWith("image");
    if (isImage) {
      setProofOD(od);
      setProofModal(true);
    } else {
      Linking.openURL(od.proof.url);
    }
  };

  // ─── Filtered list ────────────────────────────────────────────────────────────
  const filtered = filter === "all" ? requests : requests.filter((r) => r.status === filter);

  // ─── Day count helper ─────────────────────────────────────────────────────────
  const countDays = (from: string, to: string) => {
    const f = new Date(from + "T12:00:00");
    const t = new Date(to   + "T12:00:00");
    let count = 0;
    for (let d = new Date(f); d <= t; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0) count++;
    }
    return count;
  };

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View style={S.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={S.backBtn}>
          <Ionicons name="arrow-back" size={22} color={DARK} />
        </TouchableOpacity>
        <View style={S.headerCenter}>
          <Text style={S.headerTitle}>OD Requests</Text>
          {subjectName && (
            <Text style={S.headerSub} numberOfLines={1}>{subjectName}</Text>
          )}
        </View>
        {summary.pending > 0 && (
          <View style={S.pendingPill}>
            <Text style={S.pendingPillText}>{summary.pending} new</Text>
          </View>
        )}
      </View>

      <ScrollView
        style={S.scroll}
        contentContainerStyle={S.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => fetchRequests(true)}
            tintColor={PRIMARY}
          />
        }
      >
        {/* ── Summary chips ─────────────────────────────────────────────────── */}
        <View style={S.summaryRow}>
          <View style={[S.summaryChip, { backgroundColor: "#FEF3C7" }]}>
            <Text style={[S.chipNum, { color: AMBER }]}>{summary.pending}</Text>
            <Text style={[S.chipLabel, { color: AMBER }]}>Pending</Text>
          </View>
          <View style={[S.summaryChip, { backgroundColor: "#F0FDF4" }]}>
            <Text style={[S.chipNum, { color: GREEN }]}>{summary.approved}</Text>
            <Text style={[S.chipLabel, { color: GREEN }]}>Approved</Text>
          </View>
          <View style={[S.summaryChip, { backgroundColor: "#FEF2F2" }]}>
            <Text style={[S.chipNum, { color: RED }]}>{summary.rejected}</Text>
            <Text style={[S.chipLabel, { color: RED }]}>Rejected</Text>
          </View>
        </View>

        {/* ── Filter bar ───────────────────────────────────────────────────── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.filterScroll}>
          {(["all", "pending", "approved", "rejected"] as FilterStatus[]).map((f) => (
            <TouchableOpacity
              key={f}
              style={[S.filterChip, filter === f && S.filterChipActive]}
              onPress={() => setFilter(f)}
            >
              <Text style={[S.filterText, filter === f && S.filterTextActive]}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
                {f === "pending" && summary.pending > 0
                  ? ` (${summary.pending})` : ""}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* ── Request list ─────────────────────────────────────────────────── */}
        {loading ? (
          <ActivityIndicator size="large" color={PRIMARY} style={{ marginTop: 40 }} />
        ) : filtered.length === 0 ? (
          <View style={S.empty}>
            <Ionicons name="document-text-outline" size={48} color={BORDER} />
            <Text style={S.emptyText}>
              {filter === "pending" ? "No pending OD requests" : "No OD requests found"}
            </Text>
          </View>
        ) : (
          filtered.map((od) => {
            const cfg  = STATUS_CONFIG[od.status];
            const days = countDays(od.from_date, od.to_date);

            return (
              <View
                key={od.od_id}
                style={[
                  S.card,
                  od.status === "pending" && S.cardPending,
                ]}
              >
                {/* Top row */}
                <View style={S.cardTop}>
                  <View style={S.studentInfo}>
                    <View style={S.avatar}>
                      <Text style={S.avatarText}>
                        {od.student_name.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View>
                      <Text style={S.studentName}>{od.student_name}</Text>
                      {od.created_at && (
                        <Text style={S.submittedAt}>
                          {new Date(od.created_at).toLocaleDateString("en-IN", {
                            day: "numeric", month: "short",
                          })}
                        </Text>
                      )}
                    </View>
                  </View>
                  <View style={[S.statusBadge, { backgroundColor: cfg.bg }]}>
                    <Ionicons name={cfg.icon as any} size={12} color={cfg.color} />
                    <Text style={[S.statusText, { color: cfg.color }]}>{cfg.label}</Text>
                  </View>
                </View>

                {/* Date range */}
                <View style={S.dateRow}>
                  <Ionicons name="calendar-outline" size={14} color={OD_COLOR} />
                  <Text style={S.dateRange}>
                    {fmtDate(od.from_date)}
                    {od.to_date !== od.from_date ? ` → ${fmtDate(od.to_date)}` : ""}
                  </Text>
                  <View style={S.daysBadge}>
                    <Text style={S.daysText}>{days} day{days !== 1 ? "s" : ""}</Text>
                  </View>
                </View>

                {/* Reason */}
                <View style={S.reasonBox}>
                  <Text style={S.reasonLabel}>REASON</Text>
                  <Text style={S.reasonText}>{od.reason}</Text>
                </View>

                {/* Proof */}
                <TouchableOpacity style={S.proofBtn} onPress={() => viewProof(od)}>
                  <Ionicons
                    name={od.proof?.type?.startsWith("image") ? "image-outline" : "document-outline"}
                    size={14}
                    color={OD_COLOR}
                  />
                  <Text style={S.proofBtnText} numberOfLines={1}>
                    {od.proof?.name || "View Proof"}
                  </Text>
                  <Ionicons name="open-outline" size={12} color={OD_COLOR} />
                </TouchableOpacity>

                {/* Teacher note (already reviewed) */}
                {od.teacher_note && (
                  <View style={[S.noteBox, { borderColor: cfg.color + "44", backgroundColor: cfg.bg }]}>
                    <Ionicons name="chatbubble-ellipses-outline" size={12} color={cfg.color} />
                    <Text style={[S.noteText, { color: DARK }]}>{od.teacher_note}</Text>
                  </View>
                )}

                {/* OD marked banner */}
                {od.status === "approved" && (
                  <View style={S.odMarkedBanner}>
                    <Ionicons name="checkmark-done-circle" size={13} color={GREEN} />
                    <Text style={S.odMarkedText}>Attendance marked as OD for {days} day{days !== 1 ? "s" : ""}</Text>
                  </View>
                )}

                {/* Action buttons — pending only */}
                {od.status === "pending" && (
                  <View style={S.actionRow}>
                    <TouchableOpacity
                      style={S.rejectBtn}
                      onPress={() => openReview(od, "rejected")}
                    >
                      <Ionicons name="close-outline" size={16} color={RED} />
                      <Text style={S.rejectBtnText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={S.approveBtn}
                      onPress={() => openReview(od, "approved")}
                    >
                      <Ionicons name="checkmark-outline" size={16} color={WHITE} />
                      <Text style={S.approveBtnText}>Approve & Mark OD</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ══════════════════════════════════════════════════════════════════════
          Review Confirmation Modal
      ══════════════════════════════════════════════════════════════════════ */}
      <Modal
        visible={reviewModal}
        transparent
        animationType="slide"
        onRequestClose={() => setReviewModal(false)}
      >
        <View style={S.modalOverlay}>
          <View style={S.modalSheet}>
            {/* Header */}
            <View style={S.modalHeader}>
              <Text style={S.modalTitle}>
                {reviewAction === "approved" ? " Approve OD" : "❌ Reject OD"}
              </Text>
              <TouchableOpacity onPress={() => setReviewModal(false)}>
                <Ionicons name="close" size={22} color={DARK} />
              </TouchableOpacity>
            </View>

            {activeOD && (
              <>
                {/* Summary */}
                <View style={S.modalSummary}>
                  <Text style={S.modalStudentName}>{activeOD.student_name}</Text>
                  <Text style={S.modalDates}>
                    {fmtDate(activeOD.from_date)}
                    {activeOD.to_date !== activeOD.from_date
                      ? ` → ${fmtDate(activeOD.to_date)}` : ""}
                  </Text>
                  <Text style={S.modalReason}>{activeOD.reason}</Text>
                </View>

                {reviewAction === "approved" && (
                  <View style={S.modalWarning}>
                    <Ionicons name="information-circle-outline" size={16} color={OD_COLOR} />
                    <Text style={S.modalWarningText}>
                      Approving will mark attendance as <Text style={{ fontWeight: "800" }}>OD</Text> for all
                      weekdays in this range. This cannot be undone from here.
                    </Text>
                  </View>
                )}

                {/* Note */}
                <Text style={S.modalLabel}>
                  {reviewAction === "rejected" ? "Rejection Reason" : "Note (optional)"}
                </Text>
                <TextInput
                  style={S.modalInput}
                  value={teacherNote}
                  onChangeText={setTeacherNote}
                  placeholder={
                    reviewAction === "rejected"
                      ? "Explain why the request was rejected..."
                      : "Add a note for the student (optional)..."
                  }
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                />

                {/* Confirm button */}
                <TouchableOpacity
                  style={[
                    S.confirmBtn,
                    { backgroundColor: reviewAction === "approved" ? GREEN : RED },
                    submitting && { opacity: 0.6 },
                  ]}
                  onPress={handleReview}
                  disabled={submitting}
                >
                  {submitting
                    ? <ActivityIndicator size="small" color={WHITE} />
                    : <Text style={S.confirmBtnText}>
                        {reviewAction === "approved" ? "Confirm Approval" : "Confirm Rejection"}
                      </Text>
                  }
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* ══════════════════════════════════════════════════════════════════════
          Proof Image Modal (for image proofs)
      ══════════════════════════════════════════════════════════════════════ */}
      <Modal
        visible={proofModal}
        transparent
        animationType="fade"
        onRequestClose={() => setProofModal(false)}
      >
        <View style={S.proofOverlay}>
          <TouchableOpacity style={S.proofClose} onPress={() => setProofModal(false)}>
            <Ionicons name="close-circle" size={32} color={WHITE} />
          </TouchableOpacity>
          {proofOD && (
            <>
              <Text style={S.proofTitle}>{proofOD.student_name} — Proof</Text>
              {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
              {React.createElement(require("react-native").Image, {
                source: { uri: proofOD.proof?.url },
                style:  S.proofImage,
                resizeMode: "contain",
              })}
              <TouchableOpacity
                style={S.openBrowserBtn}
                onPress={() => Linking.openURL(proofOD.proof?.url)}
              >
                <Text style={S.openBrowserText}>Open in Browser</Text>
              </TouchableOpacity>
            </>
          )}
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
  backBtn:     { padding: 4 },
  headerCenter: { flex: 1 },
  headerTitle: { fontSize: 17, fontWeight: "800", color: DARK },
  headerSub:   { fontSize: 12, color: GREY, marginTop: 1 },
  pendingPill: {
    backgroundColor: AMBER + "22",
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pendingPillText: { fontSize: 11, fontWeight: "700", color: AMBER },

  scroll:        { flex: 1 },
  scrollContent: { padding: 16, gap: 14 },

  summaryRow: { flexDirection: "row", gap: 10 },
  summaryChip: { flex: 1, borderRadius: 16, padding: 14, alignItems: "center" },
  chipNum:   { fontSize: 22, fontWeight: "800" },
  chipLabel: { fontSize: 11, fontWeight: "600", marginTop: 2 },

  filterScroll: { flexGrow: 0, marginBottom: 2 },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: WHITE,
    borderWidth: 1,
    borderColor: BORDER,
    marginRight: 8,
  },
  filterChipActive: { backgroundColor: PRIMARY_SOFT, borderColor: PRIMARY },
  filterText:       { fontSize: 13, fontWeight: "600", color: GREY },
  filterTextActive: { color: PRIMARY },

  empty:     { paddingVertical: 60, alignItems: "center", gap: 12 },
  emptyText: { fontSize: 14, color: GREY },

  card: {
    backgroundColor: WHITE,
    borderRadius: 18,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 1,
  },
  cardPending: {
    borderColor: AMBER + "66",
    borderWidth: 1.5,
  },

  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  studentInfo: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: OD_SOFT,
    alignItems: "center", justifyContent: "center",
  },
  avatarText:   { fontSize: 16, fontWeight: "800", color: OD_COLOR },
  studentName:  { fontSize: 14, fontWeight: "700", color: DARK },
  submittedAt:  { fontSize: 11, color: GREY, marginTop: 1 },

  statusBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10,
  },
  statusText: { fontSize: 11, fontWeight: "700" },

  dateRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dateRange: { fontSize: 13, fontWeight: "700", color: DARK, flex: 1 },
  daysBadge: {
    backgroundColor: OD_SOFT,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  daysText: { fontSize: 11, fontWeight: "700", color: OD_COLOR },

  reasonBox: {
    backgroundColor: BG, borderRadius: 10, padding: 12, gap: 4,
  },
  reasonLabel: {
    fontSize: 10, fontWeight: "700", color: GREY,
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  reasonText: { fontSize: 13, color: DARK, lineHeight: 18 },

  proofBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: OD_SOFT,
    borderRadius: 10,
    padding: 10,
  },
  proofBtnText: { flex: 1, fontSize: 12, color: OD_COLOR, fontWeight: "600" },

  noteBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  noteText: { flex: 1, fontSize: 12, lineHeight: 16 },

  odMarkedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F0FDF4",
    borderRadius: 8,
    padding: 10,
  },
  odMarkedText: { fontSize: 12, color: GREEN, fontWeight: "600" },

  actionRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  rejectBtn: {
    flex: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: RED + "55",
    backgroundColor: "#FEF2F2",
  },
  rejectBtnText:  { fontSize: 13, fontWeight: "700", color: RED },
  approveBtn: {
    flex: 2,
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: GREEN,
  },
  approveBtnText: { fontSize: 13, fontWeight: "700", color: WHITE },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: WHITE,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    gap: 16,
    paddingBottom: 44,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalTitle:       { fontSize: 18, fontWeight: "800", color: DARK },
  modalSummary:     { backgroundColor: BG, borderRadius: 14, padding: 14, gap: 4 },
  modalStudentName: { fontSize: 15, fontWeight: "700", color: DARK },
  modalDates:       { fontSize: 13, color: OD_COLOR, fontWeight: "600" },
  modalReason:      { fontSize: 12, color: GREY, marginTop: 4, lineHeight: 18 },
  modalWarning: {
    flexDirection: "row", gap: 8, alignItems: "flex-start",
    backgroundColor: OD_SOFT, borderRadius: 10, padding: 12,
  },
  modalWarningText: { flex: 1, fontSize: 12, color: "#4C1D95", lineHeight: 17 },
  modalLabel: {
    fontSize: 12, fontWeight: "700", color: GREY,
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  modalInput: {
    backgroundColor: BG,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    color: DARK,
    borderWidth: 1,
    borderColor: BORDER,
    minHeight: 90,
  },
  confirmBtn: {
    borderRadius: 50,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 4,
  },
  confirmBtnText: { color: WHITE, fontWeight: "700", fontSize: 15 },

  // Proof image modal
  proofOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  proofClose: { position: "absolute", top: 48, right: 20 },
  proofTitle: {
    color: WHITE,
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 16,
    marginTop: 72,
    textAlign: "center",
  },
  proofImage: {
    width: "100%",
    height: 420,
    borderRadius: 12,
  },
  openBrowserBtn: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: WHITE + "22",
    borderWidth: 1,
    borderColor: WHITE + "44",
  },
  openBrowserText: { color: WHITE, fontSize: 13, fontWeight: "600" },
});