import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG = "#F3F4F6";
const GREEN = "#10B981";
const GREEN_LIGHT = "#D1FAE5";
const AMBER = "#F59E0B";
const AMBER_LIGHT = "#FEF3C7";
const GREY = "#6B7280";
const RED = "#EF4444";
const API_URL = "http://10.132.90.56:5000";

function fmtDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function isPastDue(iso: string | null) {
  if (!iso) return false;
  return new Date(iso) < new Date();
}

function isPinExpired(expiry: string | null) {
  if (!expiry) return false;
  return new Date(expiry) < new Date();
}

export default function TeacherSubjectFeed() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, course, teacher_id } = route.params;

  const [feed, setFeed] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadFeed = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const [assignRes, announceRes] = await Promise.all([
        fetch(`${API_URL}/api/assignments?subject_id=${subject.subject_id}&course_id=${course.course_id}`),
        fetch(`${API_URL}/api/assignments/announcements?subject_id=${subject.subject_id}&course_id=${course.course_id}`),
      ]);
      const assignData = await assignRes.json();
      const announceData = await announceRes.json();

      const assignments = (assignData.assignments || []).map((a: any) => ({ ...a, _type: "assignment" }));
      const announcements = (announceData.announcements || []).map((a: any) => ({ ...a, _type: "announcement" }));

      const all = [...assignments, ...announcements];
      all.sort((a, b) => {
        const aPin = a._type === "announcement" && a.is_pinned && !isPinExpired(a.pin_expires_at || null);
        const bPin = b._type === "announcement" && b.is_pinned && !isPinExpired(b.pin_expires_at || null);
        if (aPin && !bPin) return -1;
        if (!aPin && bPin) return 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
      setFeed(all);
    } catch (e) {
      console.error("Feed load error:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [subject.subject_id, course.course_id]);

  useFocusEffect(useCallback(() => { loadFeed(); }, [loadFeed]));

  const renderAnnouncement = (item: any) => {
    const isPinActive = item.is_pinned && !isPinExpired(item.pin_expires_at || null);
    return (
      <TouchableOpacity
        key={item.announcement_id}
        style={[S.card, isPinActive && S.pinnedCard]}
        activeOpacity={0.85}
        onPress={() => navigation.navigate("AnnouncementDetail", {
          announcement: item, teacher_id, onRefresh: () => loadFeed(true),
        })}
      >
        <View style={[S.iconWrap, { backgroundColor: PRIMARY_LIGHT }]}>
          <Ionicons name={isPinActive ? "pin" : "megaphone-outline"} size={16} color={PRIMARY} />
        </View>
        <View style={S.cardBody}>
          <View style={S.titleRow}>
            <Text style={S.cardTitle} numberOfLines={1}>{item.title}</Text>
            {isPinActive && <View style={S.pinBadge}><Text style={S.pinBadgeText}>Pinned</Text></View>}
          </View>
          <Text style={S.cardSub} numberOfLines={1}>{item.text}</Text>
          <Text style={S.metaText}>{fmtDate(item.created_at)}</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={GREY} />
      </TouchableOpacity>
    );
  };

  const renderAssignment = (item: any) => {
    const overdue = isPastDue(item.due_date);
    return (
      <TouchableOpacity
        key={item.assignment_id}
        style={S.card}
        activeOpacity={0.85}
        onPress={() => navigation.navigate("TeacherAssignmentDetail", {
          assignment: item, teacher_id, subject, course,
        })}
      >
        <View style={[S.iconWrap, { backgroundColor: overdue ? "#FEF2F2" : GREEN_LIGHT }]}>
          <Ionicons name="document-text-outline" size={16} color={overdue ? RED : GREEN} />
        </View>
        <View style={S.cardBody}>
          <Text style={S.cardTitle} numberOfLines={1}>{item.title}</Text>
          <View style={S.metaRow}>
            <Text style={[S.dueDateText, { color: overdue ? RED : GREY }]}>Due {fmtDate(item.due_date)}</Text>
            <View style={[S.chip, { backgroundColor: PRIMARY_LIGHT }]}>
              <Text style={[S.chipText, { color: PRIMARY }]}>{item.marks} pts</Text>
            </View>
            {item.submissions_count > 0 && (
              <View style={[S.chip, { backgroundColor: GREEN_LIGHT }]}>
                <Text style={[S.chipText, { color: GREEN }]}>{item.submissions_count} in</Text>
              </View>
            )}
            {item.allow_late && (
              <View style={[S.chip, { backgroundColor: AMBER_LIGHT }]}>
                <Text style={[S.chipText, { color: AMBER }]}>Late OK</Text>
              </View>
            )}
          </View>
        </View>
        <Ionicons name="chevron-forward" size={16} color={GREY} />
      </TouchableOpacity>
    );
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
        <View style={S.headerActions}>
          <TouchableOpacity
            style={S.headerBtn}
            onPress={() => navigation.navigate("CreateAnnouncement", {
              subject, course, teacher_id, onRefresh: () => loadFeed(true),
            })}
          >
            <Ionicons name="megaphone-outline" size={18} color={PRIMARY} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[S.headerBtn, { backgroundColor: PRIMARY }]}
            onPress={() => navigation.navigate("CreateAssignment", {
              subject, course, teacher_id, onRefresh: () => loadFeed(true),
            })}
          >
            <Ionicons name="add" size={20} color="#FFF" />
          </TouchableOpacity>
        </View>
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
        {loading ? (
          <View style={S.center}><ActivityIndicator size="large" color={PRIMARY} /></View>
        ) : feed.length === 0 ? (
          <View style={S.empty}>
            <Ionicons name="folder-open-outline" size={40} color={GREY} style={{ marginBottom: 10 }} />
            <Text style={S.emptyTitle}>Nothing posted yet</Text>
            <Text style={S.emptyText}>Use the buttons above to post an assignment or announcement.</Text>
          </View>
        ) : (
          feed.map((item) =>
            item._type === "announcement" ? renderAnnouncement(item) : renderAssignment(item)
          )
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },

  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 10 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  headerText: { flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: "800", color: "#111827" },
  headerSub: { fontSize: 12, color: GREY, marginTop: 1 },
  headerActions: { flexDirection: "row", gap: 8 },
  headerBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center" },

  list: { paddingHorizontal: 16 },

  card: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "#FFF", borderRadius: 13, marginBottom: 7,
    padding: 12, borderWidth: 1, borderColor: "#E5E7EB",
    shadowColor: "#000", shadowOpacity: 0.03, shadowRadius: 4, elevation: 1,
  },
  pinnedCard: { borderColor: PRIMARY, borderWidth: 1.5 },

  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  cardBody: { flex: 1 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 3 },
  cardTitle: { fontSize: 14, fontWeight: "700", color: "#111827", flex: 1 },
  cardSub: { fontSize: 12, color: GREY, marginBottom: 3 },
  metaText: { fontSize: 11, color: GREY, fontWeight: "500" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" },
  dueDateText: { fontSize: 11, fontWeight: "600" },
  pinBadge: { backgroundColor: PRIMARY_LIGHT, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 },
  pinBadgeText: { fontSize: 10, fontWeight: "700", color: PRIMARY },
  chip: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  chipText: { fontSize: 10, fontWeight: "700" },

  center: { paddingTop: 80, alignItems: "center" },
  empty: { alignItems: "center", paddingTop: 60 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: "#111827", marginBottom: 6 },
  emptyText: { fontSize: 13, color: GREY, textAlign: "center" },
});