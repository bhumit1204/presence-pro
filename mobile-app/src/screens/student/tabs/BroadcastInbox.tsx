// ══════════════════════════════════════════════════════════════════
// BroadcastInbox.tsx  — Student's announcement inbox
// ══════════════════════════════════════════════════════════════════

import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { getUserSession } from "../../../services/session";

const PRIMARY      = "#4834D4";
const PRIMARY_SOFT = "#EEF2FF";
const BG           = "#F3F4F6";
const GREY         = "#6B7280";
const DARK         = "#111827";
const WHITE        = "#FFFFFF";
const RED          = "#EF4444";
const API_URL      = "http://10.132.90.56:5000";

interface Broadcast {
  broadcast_id: string;
  title:        string;
  text:         string;
  target_type:  "individual" | "group" | "class";
  is_urgent:    boolean;
  is_read:      boolean;
  created_at:   string | null;
}

const TYPE_ICON: Record<string, any> = {
  individual: "person-outline",
  group:      "people-outline",
  class:      "school-outline",
};
const TYPE_LABEL: Record<string, string> = {
  individual: "Personal",
  group:      "Group",
  class:      "Class",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)    return "Just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function BroadcastInbox() {
  const navigation = useNavigation<any>();

  const [uid,        setUid]        = useState("");
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded,   setExpanded]   = useState<string | null>(null);

  // ── fetch ─────────────────────────────────────────────────────
  const fetchBroadcasts = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const session = await getUserSession();
      if (!session?.uid) return;
      setUid(session.uid);

      const res  = await fetch(`${API_URL}/api/broadcasts/student/${session.uid}`);
      const data = await res.json();

      if (data.success) {
        // FIX: backend already sorts (urgent-first, then newest-first).
        // Keep that order — do NOT re-sort on the client, which would
        // discard the chronological secondary sort from the server.
        setBroadcasts(data.broadcasts || []);
      }
    } catch (e) {
      console.log("INBOX FETCH:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchBroadcasts(); }, [fetchBroadcasts]));

  // ── mark read ─────────────────────────────────────────────────
  const markRead = async (broadcast_id: string) => {
    if (!uid) return;
    try {
      await fetch(`${API_URL}/api/broadcasts/${broadcast_id}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid }),
      });
      setBroadcasts((prev) =>
        prev.map((b) =>
          b.broadcast_id === broadcast_id ? { ...b, is_read: true } : b
        )
      );
    } catch { /* silent */ }
  };

  const handleExpand = (item: Broadcast) => {
    const next = expanded === item.broadcast_id ? null : item.broadcast_id;
    setExpanded(next);
    if (next && !item.is_read) markRead(item.broadcast_id);
  };

  const unreadCount = broadcasts.filter((b) => !b.is_read).length;

  // ── render card ───────────────────────────────────────────────
  const renderItem = ({ item }: { item: Broadcast }) => {
    const isOpen = expanded === item.broadcast_id;

    return (
      <TouchableOpacity
        style={[
          S.card,
          !item.is_read  && S.cardUnread,
          item.is_urgent && S.cardUrgent,
        ]}
        onPress={() => handleExpand(item)}
        activeOpacity={0.82}
      >
        {/* Urgent badge */}
        {item.is_urgent && (
          <View style={S.urgentBadge}>
            <Ionicons name="alert-circle" size={10} color={WHITE} />
            <Text style={S.urgentBadgeText}>Urgent</Text>
          </View>
        )}

        {/* Top row */}
        <View style={S.cardTop}>
          <View style={S.typeTag}>
            <Ionicons name={TYPE_ICON[item.target_type] ?? "notifications-outline"} size={11} color={PRIMARY} />
            <Text style={S.typeText}>{TYPE_LABEL[item.target_type] ?? item.target_type}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={S.timeText}>{timeAgo(item.created_at)}</Text>
            {!item.is_read && <View style={S.unreadDot} />}
          </View>
        </View>

        {/* Title */}
        <Text style={[S.cardTitle, !item.is_read && { color: DARK, fontWeight: "800" }]}>
          {item.title}
        </Text>

        {/* Body */}
        {!isOpen
          ? <Text style={S.cardPreview} numberOfLines={2}>{item.text}</Text>
          : (
            <View style={S.expandBody}>
              <Text style={S.cardFull}>{item.text}</Text>
            </View>
          )
        }

        {/* Read more */}
        <View style={S.expandRow}>
          <Text style={S.expandText}>{isOpen ? "Show less" : "Read more"}</Text>
          <Ionicons
            name={isOpen ? "chevron-up-outline" : "chevron-down-outline"}
            size={13}
            color={PRIMARY}
          />
        </View>
      </TouchableOpacity>
    );
  };

  // ═══════════════════════════════════════════════════════════════
  return (
    <SafeAreaView style={S.safe} edges={["top"]}>

      <View style={S.header}>
        <Text style={S.title}>Announcements</Text>
        <Text style={S.subtitle}>
          {unreadCount > 0 ? `${unreadCount} unread` : "All caught up ✓"}
        </Text>
      </View>

      {loading ? (
        <View style={S.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
          <Text style={S.loadingText}>Loading announcements…</Text>
        </View>
      ) : (
        <FlatList
          data={broadcasts}
          keyExtractor={(item) => item.broadcast_id}
          contentContainerStyle={S.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); fetchBroadcasts(true); }}
              colors={[PRIMARY]}
            />
          }
          renderItem={renderItem}
          ListEmptyComponent={
            <View style={S.empty}>
              <Ionicons name="notifications-outline" size={52} color={GREY} />
              <Text style={S.emptyTitle}>No announcements yet</Text>
              <Text style={S.emptyText}>Your teacher's broadcasts will appear here.</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: BG },
  header:      { paddingHorizontal: 20, paddingTop: 16, marginBottom: 10 },
  title:       { fontSize: 28, fontWeight: "800", color: DARK },
  subtitle:    { fontSize: 14, color: GREY, marginTop: 4 },
  center:      { paddingTop: 80, alignItems: "center", gap: 10 },
  loadingText: { fontSize: 14, color: GREY },
  list:        { paddingHorizontal: 20, paddingBottom: 40, paddingTop: 4 },

  card: {
    backgroundColor: WHITE,
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  cardUnread: {
    borderLeftWidth: 3,
    borderLeftColor: PRIMARY,
    borderColor: "#E0E7FF",
    backgroundColor: "#FAFBFF",
  },
  cardUrgent: {
    borderLeftWidth: 3,
    borderLeftColor: RED,
    borderColor: "#FEE2E2",
    backgroundColor: "#FFF9F9",
  },

  urgentBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: RED, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3,
    alignSelf: "flex-start", marginBottom: 8,
  },
  urgentBadgeText: { color: WHITE, fontSize: 10, fontWeight: "800" },

  cardTop: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 8,
  },
  typeTag: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: PRIMARY_SOFT, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  typeText:  { fontSize: 11, fontWeight: "700", color: PRIMARY },
  timeText:  { fontSize: 11, color: GREY, fontWeight: "600" },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: PRIMARY },

  cardTitle:   { fontSize: 15, fontWeight: "700", color: "#1F2937", marginBottom: 6 },
  cardPreview: { fontSize: 13, color: GREY, lineHeight: 19 },

  expandBody: {
    backgroundColor: "#F9FAFB", borderRadius: 10,
    padding: 12, marginTop: 4,
  },
  cardFull: { fontSize: 14, color: DARK, lineHeight: 21 },

  expandRow: {
    flexDirection: "row", alignItems: "center", gap: 4, marginTop: 10,
  },
  expandText: { fontSize: 12, fontWeight: "700", color: PRIMARY },

  empty:      { alignItems: "center", paddingTop: 80, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: "800", color: DARK },
  emptyText:  { fontSize: 14, color: GREY, textAlign: "center" },
});