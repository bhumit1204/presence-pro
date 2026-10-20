// screens/reports/teacher/ODRequestTeacher.tsx — review, approve or reject student OD (on duty) requests.
// Fixes: the old screen called fetch() without the auth token and with a stale server address.

import React, { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { apiFetch } from "../../../services/api";
import { Avatar, Banner, Button, Card, Chip, EmptyState, Header, Screen, Segmented, SP, T, TextField, Tone, font } from "../../../components/ui";
import { API_URL, IconName, LoadBoundary, StatRow, enc, fmtDate, parseDate, useReport } from "./ReportShared";

interface ODRequest {
  od_id: string;
  student_uid: string;
  student_name: string;
  from_date: string;
  to_date: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  teacher_note: string | null;
  created_at: string | null;
  proof?: { url: string; name: string; type: string } | null;
}

type Filter = "all" | "pending" | "approved" | "rejected";

const STATUS: Record<ODRequest["status"], { tone: Tone; icon: IconName; label: string }> = {
  pending: { tone: "warning", icon: "time-outline", label: "Pending" },
  approved: { tone: "success", icon: "checkmark-circle", label: "Approved" },
  rejected: { tone: "danger", icon: "close-circle-outline", label: "Rejected" },
};

/** Weekdays (Mon to Sat) in the range, matching how the server marks OD. */
function countDays(from: string, to: string): number {
  const f = parseDate(from);
  const t = parseDate(to);
  if (!f || !t || t < f) return 0;
  let n = 0;
  for (const d = new Date(f); d <= t; d.setDate(d.getDate() + 1)) if (d.getDay() !== 0) n++;
  return n;
}

export default function ODRequestsTeacher() {
  const navigation = useNavigation<any>();
  const params = useRoute<any>().params ?? {};
  const { teacherId, subjectId, subjectName } = params as { teacherId?: string; subjectId?: string; subjectName?: string };

  const report = useReport(teacherId ? `${API_URL}/api/od/teacher/${enc(teacherId)}${subjectId ? `?subject_id=${enc(subjectId)}` : ""}` : null);

  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);

  const [active, setActive] = useState<ODRequest | null>(null);
  const [action, setAction] = useState<"approved" | "rejected" | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [proofOD, setProofOD] = useState<ODRequest | null>(null);

  // Refresh when coming back to this screen, but not twice on first open.
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      report.reload(true);
    }, [report.reload])
  );

  const requests: ODRequest[] = report.data?.requests ?? [];
  const summary = report.data?.summary ?? { pending: 0, approved: 0, rejected: 0 };

  // Pending first, then newest first.
  const list = useMemo(() => {
    const rank = { pending: 0, approved: 1, rejected: 1 } as const;
    return requests
      .filter((r) => filter === "all" || r.status === filter)
      .sort((a, b) => rank[a.status] - rank[b.status] || String(b.created_at || "").localeCompare(String(a.created_at || "")));
  }, [requests, filter]);

  const openReview = (od: ODRequest, a: "approved" | "rejected") => {
    setActive(od);
    setAction(a);
    setNote("");
    setNoteError(null);
  };
  const closeReview = () => {
    if (!submitting) setActive(null);
  };

  const submit = async () => {
    if (!active || !action || submitting) return;
    if (action === "rejected" && note.trim().length < 3) return setNoteError("Tell the student why the request was rejected.");
    setSubmitting(true);
    try {
      const res = await apiFetch(`${API_URL}/api/od/${enc(active.od_id)}/review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacher_id: teacherId, action, teacher_note: note.trim() || null }),
      });
      let json: any = null;
      try {
        json = JSON.parse(await res.text());
      } catch {}
      if (!res.ok || !json?.success) return setNoteError(json?.error || "Could not update this request. Try again.");
      setActive(null);
      report.reload(true);
      Alert.alert(action === "approved" ? "Approved" : "Rejected", json.message || "The student has been notified.");
    } catch {
      setNoteError("Could not reach the server. Check your connection.");
    } finally {
      setSubmitting(false);
    }
  };

  const openProof = (od: ODRequest) => {
    if (!od.proof?.url) return Alert.alert("No proof", "The student did not attach a document.");
    if (od.proof.type?.startsWith("image")) setProofOD(od);
    else openUrl(od.proof.url);
  };

  if (!teacherId) {
    return (
      <Screen>
        <Header title="OD requests" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Teacher not found" text="Go back and try again." />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="OD requests"
        subtitle={subjectName}
        onBack={() => navigation.goBack()}
        right={summary.pending > 0 ? <Chip label={`${summary.pending} new`} tone="warning" /> : undefined}
      />

      <ScrollView
        contentContainerStyle={{ padding: SP.lg, paddingBottom: 60, gap: SP.md }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            colors={[T.primary]}
            tintColor={T.primary}
            onRefresh={async () => {
              setRefreshing(true);
              await report.reload(true);
              setRefreshing(false);
            }}
          />
        }
      >
        <LoadBoundary report={report} label="Loading requests">
          <StatRow
            items={[
              { value: summary.pending ?? 0, label: "Pending", tone: "warning" },
              { value: summary.approved ?? 0, label: "Approved", tone: "success" },
              { value: summary.rejected ?? 0, label: "Rejected", tone: "danger" },
            ]}
          />
          <Segmented<Filter> options={[{ value: "all", label: "All" }, { value: "pending", label: "Pending" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }]} value={filter} onChange={setFilter} />

          {list.length === 0 ? (
            <EmptyState icon="document-text-outline" title={filter === "pending" ? "Nothing waiting" : "No OD requests"} text={filter === "pending" ? "All requests have been reviewed." : undefined} />
          ) : (
            list.map((od) => {
              const cfg = STATUS[od.status] ?? STATUS.pending;
              const days = countDays(od.from_date, od.to_date);
              const isImage = od.proof?.type?.startsWith("image");
              return (
                <Card key={od.od_id} style={od.status === "pending" ? { borderWidth: 1.5, borderColor: T.warning } : undefined}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md }}>
                    <Avatar name={od.student_name} tone="primary" />
                    <View style={{ flex: 1 }}>
                      <Text style={font.h3} numberOfLines={1}>
                        {od.student_name}
                      </Text>
                      {!!od.created_at && <Text style={[font.small, { marginTop: 1 }]}>Requested {fmtDate(od.created_at)}</Text>}
                    </View>
                    <Chip label={cfg.label} tone={cfg.tone} icon={cfg.icon} />
                  </View>

                  <View style={{ flexDirection: "row", alignItems: "center", gap: SP.sm, marginTop: SP.md }}>
                    <Ionicons name="calendar-outline" size={15} color={T.primary} />
                    <Text style={{ flex: 1, fontSize: 13.5, fontWeight: "700", color: T.ink }}>
                      {fmtDate(od.from_date)}
                      {od.to_date !== od.from_date ? ` to ${fmtDate(od.to_date)}` : ""}
                    </Text>
                    <Chip label={`${days} day${days === 1 ? "" : "s"}`} tone="primary" />
                  </View>

                  <View style={{ backgroundColor: T.bg, borderRadius: 12, padding: SP.md, marginTop: SP.md, gap: 4 }}>
                    <Text style={font.label}>Reason</Text>
                    <Text style={[font.body, { color: T.ink }]}>{od.reason}</Text>
                  </View>

                  <Pressable
                    onPress={() => openProof(od)}
                    accessibilityRole="button"
                    style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: SP.sm, backgroundColor: T.primarySoft, borderRadius: 12, padding: SP.md, marginTop: SP.md }, pressed && { opacity: 0.7 }]}
                  >
                    <Ionicons name={isImage ? "image-outline" : "document-outline"} size={16} color={T.primary} />
                    <Text style={{ flex: 1, fontSize: 13, fontWeight: "700", color: T.primary }} numberOfLines={1}>
                      {od.proof?.name || (od.proof?.url ? "View proof" : "No proof attached")}
                    </Text>
                    {!!od.proof?.url && <Ionicons name="open-outline" size={14} color={T.primary} />}
                  </Pressable>

                  {!!od.teacher_note && (
                    <Banner tone={cfg.tone} icon="chatbubble-ellipses-outline" style={{ marginTop: SP.md }}>
                      {od.teacher_note}
                    </Banner>
                  )}
                  {od.status === "approved" && (
                    <Banner tone="success" icon="checkmark-done-circle" style={{ marginTop: SP.md }}>
                      Attendance marked as OD for {days} day{days === 1 ? "" : "s"}
                    </Banner>
                  )}

                  {od.status === "pending" && (
                    <View style={{ flexDirection: "row", gap: SP.sm, marginTop: SP.md }}>
                      <Button label="Reject" icon="close" variant="dangerSoft" size="md" onPress={() => openReview(od, "rejected")} style={{ flex: 1 }} />
                      <Button label="Approve and mark OD" icon="checkmark" variant="success" size="md" onPress={() => openReview(od, "approved")} style={{ flex: 2 }} />
                    </View>
                  )}
                </Card>
              );
            })
          )}
        </LoadBoundary>
      </ScrollView>

      {/* Review sheet */}
      <Modal visible={!!active} transparent animationType="slide" onRequestClose={closeReview}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.5)", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: T.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, maxHeight: "92%" }}>
            <ScrollView contentContainerStyle={{ padding: SP.xl, gap: SP.lg, paddingBottom: 36 }} keyboardShouldPersistTaps="handled">
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text style={[font.h2, { flex: 1 }]}>{action === "approved" ? "Approve OD" : "Reject OD"}</Text>
                <Pressable onPress={closeReview} hitSlop={10} accessibilityLabel="Close">
                  <Ionicons name="close" size={24} color={T.ink} />
                </Pressable>
              </View>

              {!!active && (
                <View style={{ backgroundColor: T.bg, borderRadius: 14, padding: SP.md, gap: 4 }}>
                  <Text style={font.h3}>{active.student_name}</Text>
                  <Text style={{ fontSize: 13, fontWeight: "700", color: T.primary }}>
                    {fmtDate(active.from_date)}
                    {active.to_date !== active.from_date ? ` to ${fmtDate(active.to_date)}` : ""}
                  </Text>
                  <Text style={font.body}>{active.reason}</Text>
                </View>
              )}

              {action === "approved" && (
                <Banner tone="primary" icon="information-circle-outline">
                  Approving marks attendance as OD for every weekday in this range. You cannot undo this from here.
                </Banner>
              )}

              <TextField
                label={action === "rejected" ? "Reason for rejection" : "Note for the student (optional)"}
                value={note}
                onChangeText={(t) => {
                  setNote(t);
                  setNoteError(null);
                }}
                placeholder={action === "rejected" ? "Explain why this was rejected" : "Add a note"}
                multiline
                minHeight={90}
                autoCapitalize="sentences"
                autoCorrect
                maxLength={300}
              />
              {!!noteError && <Banner tone="danger">{noteError}</Banner>}

              <Button label={action === "approved" ? "Confirm approval" : "Confirm rejection"} icon={action === "approved" ? "checkmark" : "close"} variant={action === "approved" ? "success" : "danger"} loading={submitting} onPress={submit} />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Image proof */}
      <Modal visible={!!proofOD} transparent animationType="fade" onRequestClose={() => setProofOD(null)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center", padding: SP.xl }}>
          <Pressable onPress={() => setProofOD(null)} hitSlop={12} style={{ position: "absolute", top: 48, right: 20 }} accessibilityLabel="Close proof">
            <Ionicons name="close-circle" size={34} color="#fff" />
          </Pressable>
          {!!proofOD && (
            <>
              <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600", marginBottom: SP.lg, textAlign: "center" }}>{proofOD.student_name} - proof</Text>
              <Image source={{ uri: proofOD.proof?.url }} style={{ width: "100%", height: 420, borderRadius: 12 }} resizeMode="contain" />
              <View style={{ width: "100%", marginTop: SP.lg }}>
                <Button label="Open in browser" icon="open-outline" variant="secondary" onPress={() => openUrl(proofOD.proof?.url)} />
              </View>
            </>
          )}
        </View>
      </Modal>
    </Screen>
  );
}

async function openUrl(url?: string) {
  if (!url) return;
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert("Could not open", "No app on this phone can open that file.");
  }
}