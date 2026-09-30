import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Modal, Image, Linking,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, useFocusEffect } from "@react-navigation/native";
import { auth } from "../../../services/firebase";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";

const PRIMARY = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG = "#F3F4F6";
const GREEN = "#10B981";
const GREEN_LIGHT = "#D1FAE5";
const AMBER = "#F59E0B";
const AMBER_LIGHT = "#FEF3C7";
const GREY = "#6B7280";
const RED = "#EF4444";
const RED_LIGHT = "#FEF2F2";
const WHITE = "#FFFFFF";
const DARK = "#111827";
const BORDER = "#E5E7EB";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

function fmtDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function isPastDue(iso: string | null) {
  if (!iso) return false;
  return new Date(iso) < new Date();
}

function isPinActive(item: any) {
  if (!item.is_pinned) return false;
  if (!item.pin_expires_at) return true;
  return new Date(item.pin_expires_at) > new Date();
}

function fileIcon(type: string) {
  if (type?.includes("pdf")) return "document-text-outline";
  if (type?.includes("image")) return "image-outline";
  if (type?.includes("word") || type?.includes("document")) return "document-outline";
  if (type?.includes("sheet") || type?.includes("excel")) return "grid-outline";
  if (type?.includes("presentation") || type?.includes("powerpoint")) return "easel-outline";
  return "attach-outline";
}

function isImageType(type: string) {
  return type?.includes("image");
}

async function openFile(url: string) {
  try { await WebBrowser.openBrowserAsync(url); }
  catch { Linking.openURL(url); }
}

type Tab = "stream" | "assigned" | "submitted" | "missing";

// ─── Announcement Detail Modal ────────────────────────────────────────────────
function AnnouncementModal({ item, visible, onClose }: {
  item: any; visible: boolean; onClose: () => void;
}) {
  if (!item) return null;
  const pinned = isPinActive(item);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={M.safe} edges={["top"]}>
        {/* Header */}
        <View style={M.header}>
          <Pressable style={M.closeBtn} onPress={onClose}>
            <Ionicons name="close" size={20} color={GREY} />
          </Pressable>
          {pinned && (
            <View style={M.pinnedBadge}>
              <Ionicons name="pin" size={11} color={PRIMARY} />
              <Text style={M.pinnedBadgeText}>Pinned</Text>
            </View>
          )}
        </View>

        <ScrollView
          contentContainerStyle={M.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Icon + Title */}
          <View style={M.titleSection}>
            <View style={M.bigIcon}>
              <Ionicons name={pinned ? "pin" : "megaphone-outline"} size={22} color={PRIMARY} />
            </View>
            <Text style={M.title}>{item.title}</Text>
          </View>

          {/* Date */}
          <View style={M.metaRow}>
            <Ionicons name="time-outline" size={13} color={GREY} />
            <Text style={M.metaText}>{fmtDateTime(item.created_at)}</Text>
          </View>

          {/* Content */}
          {item.text ? (
            <View style={M.bodyCard}>
              <Text style={M.bodyText}>{item.text}</Text>
            </View>
          ) : null}

          {/* Attachments */}
          {(item.attachments?.length ?? 0) > 0 && (
            <View style={M.section}>
              <Text style={M.sectionLabel}>Attachments</Text>
              {item.attachments.map((att: any, i: number) => (
                <View key={i} style={M.attBlock}>
                  {/* Image preview */}
                  {isImageType(att.type) && att.url ? (
                    <TouchableOpacity onPress={() => openFile(att.url)} activeOpacity={0.9}>
                      <Image
                        source={{ uri: att.url }}
                        style={M.imagePreview}
                        resizeMode="cover"
                      />
                      <View style={M.imageOverlay}>
                        <Ionicons name="open-outline" size={16} color={WHITE} />
                        <Text style={M.imageOverlayText}>Tap to open</Text>
                      </View>
                    </TouchableOpacity>
                  ) : (
                    /* Non-image: file card */
                    <TouchableOpacity
                      style={M.fileCard}
                      onPress={() => openFile(att.url)}
                      activeOpacity={0.8}
                    >
                      <View style={M.fileIconWrap}>
                        <Ionicons name={fileIcon(att.type)} size={22} color={PRIMARY} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={M.fileName} numberOfLines={2}>{att.name}</Text>
                        <Text style={M.fileType}>{att.type?.split("/")[1]?.toUpperCase() || "FILE"}</Text>
                      </View>
                      <View style={M.openChip}>
                        <Ionicons name="open-outline" size={13} color={PRIMARY} />
                        <Text style={M.openChipText}>Open</Text>
                      </View>
                    </TouchableOpacity>
                  )}
                  {/* File name below image */}
                  {isImageType(att.type) && (
                    <Text style={M.imageCaption} numberOfLines={1}>{att.name}</Text>
                  )}
                </View>
              ))}
            </View>
          )}

          {/* Links */}
          {(item.links?.length ?? 0) > 0 && (
            <View style={M.section}>
              <Text style={M.sectionLabel}>Links</Text>
              {item.links.map((l: any, i: number) => (
                <TouchableOpacity key={i} style={M.linkCard} onPress={() => openFile(l.url)}>
                  <Ionicons name="globe-outline" size={15} color={PRIMARY} />
                  <Text style={M.linkText} numberOfLines={1}>{l.label || l.url}</Text>
                  <Ionicons name="arrow-forward-outline" size={14} color={GREY} />
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const M = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: WHITE },
  header:  { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: BORDER },
  closeBtn:{ width: 36, height: 36, borderRadius: 18, backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center" },

  pinnedBadge:     { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: PRIMARY_LIGHT, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  pinnedBadgeText: { fontSize: 12, fontWeight: "700", color: PRIMARY },

  content:     { paddingHorizontal: 20, paddingTop: 20 },

  titleSection:{ flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 10 },
  bigIcon:     { width: 44, height: 44, borderRadius: 13, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 },
  title:       { flex: 1, fontSize: 20, fontWeight: "800", color: DARK, lineHeight: 28 },

  metaRow:     { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 16 },
  metaText:    { fontSize: 12, color: GREY, fontWeight: "500" },

  bodyCard:    { backgroundColor: "#F9FAFB", borderRadius: 14, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: BORDER },
  bodyText:    { fontSize: 14, color: "#374151", lineHeight: 22 },

  section:     { marginBottom: 16 },
  sectionLabel:{ fontSize: 12, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 },

  attBlock:    { marginBottom: 10 },

  imagePreview:{ width: "100%", height: 200, borderRadius: 14, backgroundColor: "#F3F4F6" },
  imageOverlay:{ position: "absolute", bottom: 10, right: 10, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5 },
  imageOverlayText: { color: WHITE, fontSize: 11, fontWeight: "700" },
  imageCaption:{ fontSize: 11, color: GREY, marginTop: 5, paddingHorizontal: 2 },

  fileCard:    { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#F9FAFB", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: BORDER },
  fileIconWrap:{ width: 44, height: 44, borderRadius: 12, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center" },
  fileName:    { fontSize: 13, fontWeight: "600", color: DARK, marginBottom: 3 },
  fileType:    { fontSize: 11, color: GREY },
  openChip:    { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: PRIMARY_LIGHT, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6 },
  openChipText:{ fontSize: 12, fontWeight: "700", color: PRIMARY },

  linkCard:    { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#F9FAFB", borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: BORDER },
  linkText:    { flex: 1, fontSize: 13, fontWeight: "600", color: PRIMARY },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function StudentSubjectFeed() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, course, student_uid } = route.params;
  const uid = student_uid || auth.currentUser?.uid;

  const [tab, setTab] = useState<Tab>("stream");
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [submissions, setSubmissions] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Modal state
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<any>(null);
  const [modalVisible, setModalVisible] = useState(false);

  const openAnnouncement = (item: any) => {
    setSelectedAnnouncement(item);
    setModalVisible(true);
  };

  const loadFeed = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const [assignRes, announceRes, subRes] = await Promise.all([
        fetch(`${API_URL}/api/assignments?subject_id=${subject.subject_id}&course_id=${course.course_id}`),
        fetch(`${API_URL}/api/assignments/announcements?subject_id=${subject.subject_id}&course_id=${course.course_id}`),
        fetch(`${API_URL}/api/assignments/my-submissions?student_uid=${uid}&subject_id=${subject.subject_id}`),
      ]);
      const assignData = await assignRes.json();
      const announceData = await announceRes.json();
      const subData = await subRes.json();

      setAssignments(assignData.assignments || []);
      setAnnouncements(announceData.announcements || []);

      const subMap: Record<string, any> = {};
      (subData.submissions || []).forEach((s: any) => {
        subMap[s.assignment_id] = s;
      });
      setSubmissions(subMap);
    } catch (e) {
      console.error("Student feed error:", e);
    } finally {
      if (!silent) setLoading(false);
      setRefreshing(false);
    }
  }, [subject.subject_id, course.course_id, uid]);

  useFocusEffect(useCallback(() => { loadFeed(); }, [loadFeed]));

  // ── Tab data ─────────────────────────────────────────────────────
  const streamItems = (() => {
    const pinned = announcements
      .filter((a) => isPinActive(a))
      .map((a) => ({ ...a, _type: "announcement", _isPinned: true }));
    const rest = [
      ...announcements.filter((a) => !isPinActive(a)).map((a) => ({ ...a, _type: "announcement", _isPinned: false })),
      ...assignments.map((a) => ({ ...a, _type: "assignment" })),
    ].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
    return [...pinned, ...rest];
  })();

  const assignedItems = assignments.filter((a) => {
    const sub = submissions[a.assignment_id];
    return !sub && !isPastDue(a.due_date);
  });
  const submittedItems = assignments.filter((a) => !!submissions[a.assignment_id]);
  const missingItems = assignments.filter((a) => {
    const sub = submissions[a.assignment_id];
    return !sub && isPastDue(a.due_date);
  });

  // ── Renderers ────────────────────────────────────────────────────
  const renderAnnouncement = (item: any) => (
    <TouchableOpacity
      key={item.announcement_id}
      style={[S.card, item._isPinned && S.pinnedCard]}
      activeOpacity={0.82}
      onPress={() => openAnnouncement(item)}
    >
      <View style={S.cardRow}>
        <View style={[S.iconWrap, { backgroundColor: PRIMARY_LIGHT }]}>
          <Ionicons name={item._isPinned ? "pin" : "megaphone-outline"} size={17} color={PRIMARY} />
        </View>
        <View style={S.cardBody}>
          <View style={S.titleRow}>
            <Text style={S.cardTitle} numberOfLines={2}>{item.title}</Text>
            {item._isPinned && <View style={S.pinBadge}><Text style={S.pinBadgeText}>Pinned</Text></View>}
          </View>
          <Text style={S.cardText} numberOfLines={2}>{item.text}</Text>
          <Text style={S.metaDate}>{fmtDate(item.created_at)}</Text>
          {(item.attachments?.length ?? 0) > 0 && (
            <View style={S.chipRow}>
              <View style={S.chip}>
                <Ionicons name="attach" size={11} color={GREY} />
                <Text style={S.chipText}>{item.attachments.length} file{item.attachments.length > 1 ? "s" : ""}</Text>
              </View>
            </View>
          )}
        </View>
        <Ionicons name="chevron-forward" size={16} color={GREY} style={{ marginTop: 2 }} />
      </View>
    </TouchableOpacity>
  );

  const renderAssignment = (item: any, showStatus = false) => {
    const overdue = isPastDue(item.due_date);
    const sub = submissions[item.assignment_id];
    return (
      <TouchableOpacity
        key={item.assignment_id}
        style={S.card}
        activeOpacity={0.85}
        onPress={() => navigation.navigate("StudentAssignmentDetail", { assignment: item, student_uid: uid })}
      >
        <View style={S.cardRow}>
          <View style={[S.iconWrap, { backgroundColor: overdue && !sub ? RED_LIGHT : GREEN_LIGHT }]}>
            <Ionicons name="document-text-outline" size={17} color={overdue && !sub ? RED : GREEN} />
          </View>
          <View style={S.cardBody}>
            <Text style={S.cardTitle} numberOfLines={2}>{item.title}</Text>
            <View style={S.metaRow}>
              <Text style={[S.dueDateText, { color: overdue && !sub ? RED : GREY }]}>
                Due {fmtDate(item.due_date)}
              </Text>
              <View style={[S.chip, { backgroundColor: PRIMARY_LIGHT }]}>
                <Text style={[S.chipText, { color: PRIMARY }]}>{item.marks} marks</Text>
              </View>
              {showStatus && sub && (
                <View style={[S.chip, {
                  backgroundColor: sub.status === "graded" ? GREEN_LIGHT : AMBER_LIGHT
                }]}>
                  <Text style={[S.chipText, {
                    color: sub.status === "graded" ? GREEN : AMBER
                  }]}>
                    {sub.status === "graded" ? `${sub.marks_obtained}/${item.marks}` : "Turned in"}
                  </Text>
                </View>
              )}
              {item.allow_late && !sub && (
                <View style={[S.chip, { backgroundColor: AMBER_LIGHT }]}>
                  <Text style={[S.chipText, { color: AMBER }]}>Late OK</Text>
                </View>
              )}
            </View>
          </View>
          <Ionicons name="chevron-forward" size={18} color={GREY} />
        </View>
      </TouchableOpacity>
    );
  };

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: "stream", label: "Stream" },
    { key: "assigned", label: "Assigned", count: assignedItems.length },
    { key: "submitted", label: "Submitted", count: submittedItems.length },
    { key: "missing", label: "Missing", count: missingItems.length },
  ];

  const renderContent = () => {
    if (loading) return <View style={S.center}><ActivityIndicator size="large" color={PRIMARY} /></View>;

    if (tab === "stream") {
      if (streamItems.length === 0) return <Empty icon="folder-open-outline" title="Nothing here yet" sub="Your teacher hasn't posted anything." />;
      return streamItems.map((item: any) =>
        item._type === "announcement" ? renderAnnouncement(item) : renderAssignment(item)
      );
    }
    if (tab === "assigned") {
      if (assignedItems.length === 0) return <Empty icon="checkmark-circle-outline" title="All caught up!" sub="No pending assignments." />;
      return assignedItems.map((item) => renderAssignment(item));
    }
    if (tab === "submitted") {
      if (submittedItems.length === 0) return <Empty icon="cloud-upload-outline" title="No submissions yet" sub="Submitted assignments appear here." />;
      return submittedItems.map((item) => renderAssignment(item, true));
    }
    if (tab === "missing") {
      if (missingItems.length === 0) return <Empty icon="ribbon-outline" title="Nothing missing!" sub="You haven't missed any assignments." />;
      return missingItems.map((item) => (
        <TouchableOpacity
          key={item.assignment_id}
          style={[S.card, { borderLeftWidth: 3, borderLeftColor: RED }]}
          activeOpacity={0.85}
          onPress={() => navigation.navigate("StudentAssignmentDetail", { assignment: item, student_uid: uid })}
        >
          <View style={S.cardRow}>
            <View style={[S.iconWrap, { backgroundColor: RED_LIGHT }]}>
              <Ionicons name="alert-circle-outline" size={17} color={RED} />
            </View>
            <View style={S.cardBody}>
              <Text style={S.cardTitle} numberOfLines={2}>{item.title}</Text>
              <View style={S.metaRow}>
                <Text style={[S.dueDateText, { color: RED }]}>Was due {fmtDate(item.due_date)}</Text>
                <View style={[S.chip, { backgroundColor: PRIMARY_LIGHT }]}>
                  <Text style={[S.chipText, { color: PRIMARY }]}>{item.marks} marks</Text>
                </View>
                {item.allow_late && (
                  <View style={[S.chip, { backgroundColor: AMBER_LIGHT }]}>
                    <Text style={[S.chipText, { color: AMBER }]}>Late OK</Text>
                  </View>
                )}
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={GREY} />
          </View>
        </TouchableOpacity>
      ));
    }
  };

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      {/* Header */}
      <View style={S.header}>
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={22} color={PRIMARY} />
        </TouchableOpacity>
        <View style={S.headerText}>
          <Text style={S.headerTitle} numberOfLines={1}>{subject.subject_name}</Text>
          <Text style={S.headerSub}>{course.course_name}</Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={S.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[S.tab, tab === t.key && S.tabActive]}
            onPress={() => setTab(t.key)}
          >
            <Text style={[S.tabText, tab === t.key && S.tabTextActive]}>{t.label}</Text>
            {t.count !== undefined && t.count > 0 && (
              <View style={[S.tabBadge, tab === t.key && S.tabBadgeActive]}>
                <Text style={[S.tabBadgeText, tab === t.key && S.tabBadgeTextActive]}>{t.count}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={S.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadFeed(true); }}
            colors={[PRIMARY]}
          />
        }
      >
        {renderContent()}
        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Announcement Detail Modal */}
      <AnnouncementModal
        item={selectedAnnouncement}
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
      />
    </SafeAreaView>
  );
}

function Empty({ icon, title, sub }: { icon: any; title: string; sub: string }) {
  return (
    <View style={{ alignItems: "center", paddingTop: 60 }}>
      <Ionicons name={icon} size={44} color={GREY} style={{ marginBottom: 12 }} />
      <Text style={{ fontSize: 17, fontWeight: "700", color: "#111827", marginBottom: 6 }}>{title}</Text>
      <Text style={{ fontSize: 14, color: GREY, textAlign: "center" }}>{sub}</Text>
    </View>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },

  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10, gap: 12 },
  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  headerText: { flex: 1 },
  headerTitle: { fontSize: 20, fontWeight: "800", color: "#111827" },
  headerSub: { fontSize: 13, color: GREY, marginTop: 2 },

  tabBar: { flexDirection: "row", paddingHorizontal: 16, marginBottom: 10, gap: 4 },
  tab: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 9, borderRadius: 12, backgroundColor: "#FFF", borderWidth: 1, borderColor: "#E5E7EB" },
  tabActive: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  tabText: { fontSize: 12, fontWeight: "700", color: GREY },
  tabTextActive: { color: "#FFF" },
  tabBadge: { backgroundColor: "#E5E7EB", borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1 },
  tabBadgeActive: { backgroundColor: "rgba(255,255,255,0.25)" },
  tabBadgeText: { fontSize: 10, fontWeight: "800", color: GREY },
  tabBadgeTextActive: { color: "#FFF" },

  list: { paddingHorizontal: 16 },

  card: {
    backgroundColor: "#FFF", borderRadius: 14, marginBottom: 8,
    borderWidth: 1, borderColor: "#E5E7EB",
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 4, elevation: 1,
  },
  pinnedCard: { borderColor: PRIMARY, borderWidth: 1.5 },

  cardRow: { flexDirection: "row", padding: 12, gap: 10, alignItems: "flex-start" },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 },
  cardBody: { flex: 1 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginBottom: 3 },
  cardTitle: { fontSize: 14, fontWeight: "700", color: "#111827", flex: 1 },
  cardText: { fontSize: 12, color: GREY, lineHeight: 17, marginBottom: 5 },
  metaDate: { fontSize: 11, color: GREY, marginBottom: 4 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap", marginTop: 4 },
  dueDateText: { fontSize: 11, fontWeight: "600" },
  pinBadge: { backgroundColor: "#EEF2FF", borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 },
  pinBadgeText: { fontSize: 10, fontWeight: "700", color: PRIMARY },
  chipRow: { flexDirection: "row", gap: 5 },
  chip: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: "#F3F4F6", flexDirection: "row", alignItems: "center", gap: 3 },
  chipText: { fontSize: 10, fontWeight: "700", color: GREY },

  center: { paddingTop: 80, alignItems: "center" },
});