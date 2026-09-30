import React, { useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";

const PRIMARY = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG = "#F3F4F6";
const GREY = "#6B7280";
const RED = "#EF4444";
const RED_LIGHT = "#FEF2F2";
const AMBER = "#F59E0B";
const AMBER_LIGHT = "#FEF3C7";
const API_URL = "http://10.132.90.56:5000";

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
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

function formatBytes(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AnnouncementDetail() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { announcement: initial, teacher_id, onRefresh } = route.params;

  const [announcement] = useState(initial);
  const [deleting, setDeleting] = useState(false);
  const pinned = isPinActive(announcement);

  const handleDelete = () => {
    Alert.alert("Delete Announcement", "This cannot be undone. Continue?", [
      { text: "Cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          setDeleting(true);
          try {
            await fetch(
              `${API_URL}/api/assignments/announcements/${announcement.announcement_id}?teacher_id=${teacher_id}`,
              { method: "DELETE" }
            );
            onRefresh?.();
            navigation.goBack();
          } catch (e: any) {
            Alert.alert("Error", e.message);
          } finally {
            setDeleting(false);
          }
        },
      },
    ]);
  };

  const openFile = async (url: string) => {
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch {
      Linking.openURL(url);
    }
  };

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={S.content} showsVerticalScrollIndicator={false}>
        {/* Top bar */}
        <View style={S.topBar}>
          <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
            <Ionicons name="chevron-back" size={22} color={PRIMARY} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[S.iconBtn, { backgroundColor: RED_LIGHT }]}
            onPress={handleDelete}
            disabled={deleting}
          >
            {deleting
              ? <ActivityIndicator size="small" color={RED} />
              : <Ionicons name="trash-outline" size={18} color={RED} />
            }
          </TouchableOpacity>
        </View>

        {/* Pinned badge */}
        {pinned && (
          <View style={S.pinnedBanner}>
            <Ionicons name="pin" size={13} color={PRIMARY} />
            <Text style={S.pinnedText}>Pinned Announcement</Text>
            {announcement.pin_expires_at && (
              <Text style={S.pinnedExpiry}>· Expires {fmtDate(announcement.pin_expires_at)}</Text>
            )}
          </View>
        )}

        <Text style={S.title}>{announcement.title}</Text>
        <Text style={S.date}>{fmtDate(announcement.created_at)}</Text>

        {/* Body */}
        <View style={S.bodyCard}>
          <Text style={S.bodyText}>{announcement.text}</Text>
        </View>

        {/* Attachments */}
        {announcement.attachments?.length > 0 && (
          <View style={S.section}>
            <View style={S.sectionHeader}>
              <Ionicons name="attach" size={16} color="#111827" />
              <Text style={S.sectionTitle}>Attachments</Text>
            </View>
            {announcement.attachments.map((att: any, i: number) => (
              <TouchableOpacity key={i} style={S.fileCard} onPress={() => openFile(att.url)}>
                <View style={S.fileIcon}>
                  <Ionicons name={fileIcon(att.type)} size={20} color={PRIMARY} />
                </View>
                <View style={S.fileInfo}>
                  <Text style={S.fileName} numberOfLines={1}>{att.name}</Text>
                  {att.size > 0 && <Text style={S.fileSize}>{formatBytes(att.size)}</Text>}
                </View>
                <Ionicons name="open-outline" size={18} color={GREY} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Links */}
        {announcement.links?.length > 0 && (
          <View style={S.section}>
            <View style={S.sectionHeader}>
              <Ionicons name="link-outline" size={16} color="#111827" />
              <Text style={S.sectionTitle}>Links</Text>
            </View>
            {announcement.links.map((l: any, i: number) => (
              <TouchableOpacity key={i} style={S.linkCard} onPress={() => openFile(l.url)}>
                <Ionicons name="globe-outline" size={16} color={PRIMARY} />
                <Text style={S.linkText} numberOfLines={1}>{l.label || l.url}</Text>
                <Ionicons name="arrow-forward-outline" size={16} color={GREY} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20, paddingTop: 8 },

  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  iconBtn: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" },

  pinnedBanner: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: PRIMARY_LIGHT, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 12, flexWrap: "wrap" },
  pinnedText: { fontSize: 12, fontWeight: "700", color: PRIMARY },
  pinnedExpiry: { fontSize: 11, color: GREY },

  title: { fontSize: 24, fontWeight: "800", color: "#111827", lineHeight: 32, marginBottom: 6 },
  date: { fontSize: 13, color: GREY, marginBottom: 16 },

  bodyCard: { backgroundColor: "#FFF", borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: "#E5E7EB" },
  bodyText: { fontSize: 15, color: "#374151", lineHeight: 24 },

  section: { backgroundColor: "#FFF", borderRadius: 16, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB" },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: "#111827" },

  fileCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#F9FAFB", borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: "#E5E7EB" },
  fileIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center" },
  fileInfo: { flex: 1 },
  fileName: { fontSize: 13, fontWeight: "600", color: "#111827" },
  fileSize: { fontSize: 11, color: GREY, marginTop: 2 },

  linkCard: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#F9FAFB", borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: "#E5E7EB" },
  linkText: { flex: 1, fontSize: 13, fontWeight: "600", color: PRIMARY },
});