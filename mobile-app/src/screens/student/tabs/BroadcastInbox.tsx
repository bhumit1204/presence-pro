// BroadcastInbox.tsx: student's announcement inbox
import { apiFetch, API_BASE } from "../../../services/api";
import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl,
} from "react-native";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { getUserSession } from "../../../services/session";
import { Card, Chip, EmptyState, Header, Screen, SP, T, font } from "../../../components/ui";

const API_URL = API_BASE;

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

  const fetchBroadcasts = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const session = await getUserSession();
      if (!session?.uid) return;
      setUid(session.uid);

      const res  = await apiFetch(`${API_URL}/api/broadcasts/student/${session.uid}`);
      const data = await res.json();

      if (data.success) {
        // Backend already sorts (urgent first, then newest). Keep that order.
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

  const markRead = async (broadcast_id: string) => {
    if (!uid) return;
    try {
      await apiFetch(`${API_URL}/api/broadcasts/${broadcast_id}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid }),
      });
      setBroadcasts((prev) =>
        prev.map((b) => (b.broadcast_id === broadcast_id ? { ...b, is_read: true } : b))
      );
    } catch { /* silent */ }
  };

  const handleExpand = (item: Broadcast) => {
    const next = expanded === item.broadcast_id ? null : item.broadcast_id;
    setExpanded(next);
    if (next && !item.is_read) markRead(item.broadcast_id);
  };

  const unreadCount = broadcasts.filter((b) => !b.is_read).length;

  const renderItem = ({ item }: { item: Broadcast }) => {
    const isOpen = expanded === item.broadcast_id;
    const accent = item.is_urgent ? T.danger : !item.is_read ? T.primary : "transparent";

    return (
      <TouchableOpacity onPress={() => handleExpand(item)} activeOpacity={0.82}>
        <Card padded={false} flat={item.is_read} style={S.card}>
          <View style={[S.accent, { backgroundColor: accent }]} />
          <View style={S.body}>
            <View style={S.top}>
              <View style={S.tags}>
                {item.is_urgent && <Chip label="Urgent" icon="alert-circle" tone="danger" />}
                <Chip label={TYPE_LABEL[item.target_type] ?? item.target_type} icon={TYPE_ICON[item.target_type] ?? "notifications-outline"} tone="primary" />
              </View>
              <View style={S.timeRow}>
                <Text style={font.small}>{timeAgo(item.created_at)}</Text>
                {!item.is_read && <View style={S.unreadDot} />}
              </View>
            </View>

            <Text style={[S.title, !item.is_read && { fontWeight: "800" }]}>{item.title}</Text>

            {isOpen ? (
              <View style={S.full}>
                <Text style={S.fullText}>{item.text}</Text>
              </View>
            ) : (
              <Text style={font.body} numberOfLines={2}>{item.text}</Text>
            )}

            <View style={S.more}>
              <Text style={S.moreText}>{isOpen ? "Show less" : "Read more"}</Text>
              <Ionicons name={isOpen ? "chevron-up" : "chevron-down"} size={13} color={T.primary} />
            </View>
          </View>
        </Card>
      </TouchableOpacity>
    );
  };

  return (
    <Screen edges={["top"]}>
      <Header
        title="Announcements"
        subtitle={unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
        onBack={() => navigation.goBack()}
      />

      {loading ? (
        <View style={S.center}>
          <ActivityIndicator size="large" color={T.primary} />
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
              colors={[T.primary]}
            />
          }
          renderItem={renderItem}
          ListEmptyComponent={
            <EmptyState icon="notifications-outline" title="No announcements yet" text="Your teacher's broadcasts will appear here." />
          }
        />
      )}
    </Screen>
  );
}

const S = StyleSheet.create({
  center: { paddingTop: 80, alignItems: "center" },
  list:   { padding: SP.xl, paddingBottom: 40 },

  card:   { flexDirection: "row", overflow: "hidden", marginBottom: SP.md },
  accent: { width: 4 },
  body:   { flex: 1, padding: SP.lg, gap: SP.sm },
  top:    { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: SP.sm },
  tags:   { flexDirection: "row", gap: 6, flexShrink: 1, flexWrap: "wrap" },
  timeRow:{ flexDirection: "row", alignItems: "center", gap: 8 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: T.primary },

  title:    { fontSize: 15.5, fontWeight: "700", color: T.ink },
  full:     { backgroundColor: T.bg, borderRadius: 12, padding: SP.md },
  fullText: { fontSize: 14, color: T.ink, lineHeight: 21 },
  more:     { flexDirection: "row", alignItems: "center", gap: 4 },
  moreText: { fontSize: 12.5, fontWeight: "700", color: T.primary },
});