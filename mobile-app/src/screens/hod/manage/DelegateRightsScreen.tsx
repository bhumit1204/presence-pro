/**
 * DelegateRightsScreen.tsx
 *
 * HOD-only screen.
 * Shows all head_teachers in the same department.
 * HOD can toggle which management features each head_teacher can access.
 *
 * The non-hodOnly items from HODManage are the ones that can be delegated:
 *   - timetable
 *   - academic_calendar
 *   - defaulter_list
 *
 * Routes: /api/manage/delegate/*
 */

import React, { useState, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";
const GREY = "#6B7280";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

/** These are the delegatable keys (matching HODManage ALL_ITEMS where hodOnly=false) */
const DELEGATABLE: { key: string; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "timetable", label: "Timetable", icon: "calendar" },
  { key: "academic_calendar", label: "Academic Calendar", icon: "calendar-number" },
  { key: "defaulter_list", label: "Defaulter List", icon: "warning" },
];

interface HeadTeacher {
  teacher_id: string;
  name: string;
  designation: string;
  delegated_keys: string[];
}

export default function DelegateRightsScreen() {
  const navigation = useNavigation<any>();
  const [headTeachers, setHeadTeachers] = useState<HeadTeacher[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  // uid = Firebase Auth UID, used as hod_teacher_id for all API calls
  const [uid, setUid] = useState<string | null>(null);

  const fetchHeadTeachers = async (currentUid: string) => {
    try {
      setLoading(true);
      const res = await fetch(
        `${API_URL}/api/manage/delegate/list?hod_teacher_id=${currentUid}`
      );
      const data = await res.json();
      if (data.success) setHeadTeachers(data.head_teachers || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      const session = await getUserSession();
      const currentUid = session?.uid || null;
      setUid(currentUid);
      if (currentUid) fetchHeadTeachers(currentUid);
    };
    init();
  }, []);

  const toggleRight = async (teacherId: string, key: string, currentlyOn: boolean) => {
    if (!uid) return;
    setSaving(teacherId);
    try {
      const res = await fetch(`${API_URL}/api/manage/delegate/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hod_teacher_id: uid,
          target_teacher_id: teacherId,
          key,
          grant: !currentlyOn,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setHeadTeachers((prev) =>
          prev.map((ht) => {
            if (ht.teacher_id !== teacherId) return ht;
            const keys = currentlyOn
              ? ht.delegated_keys.filter((k) => k !== key)
              : [...ht.delegated_keys, key];
            return { ...ht, delegated_keys: keys };
          })
        );
      }
    } catch (e) {
      Alert.alert("Error", "Failed to update rights.");
    } finally {
      setSaving(null);
    }
  };

  const grantAll = async (teacherId: string) => {
    if (!uid) return;
    setSaving(teacherId);
    try {
      await fetch(`${API_URL}/api/manage/delegate/grant-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hod_teacher_id: uid,
          target_teacher_id: teacherId,
        }),
      });
      setHeadTeachers((prev) =>
        prev.map((ht) =>
          ht.teacher_id === teacherId
            ? { ...ht, delegated_keys: DELEGATABLE.map((d) => d.key) }
            : ht
        )
      );
    } catch (e) {
      Alert.alert("Error", "Failed.");
    } finally {
      setSaving(null);
    }
  };

  const revokeAll = async (teacherId: string) => {
    if (!uid) return;
    Alert.alert("Revoke All?", "This removes all management rights from this head teacher.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke", style: "destructive", onPress: async () => {
          setSaving(teacherId);
          try {
            await fetch(`${API_URL}/api/manage/delegate/revoke-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                hod_teacher_id: uid,
                target_teacher_id: teacherId,
              }),
            });
            setHeadTeachers((prev) =>
              prev.map((ht) =>
                ht.teacher_id === teacherId ? { ...ht, delegated_keys: [] } : ht
              )
            );
          } catch (e) {
            Alert.alert("Error", "Failed.");
          } finally {
            setSaving(null);
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>Delegate Rights</Text>
        <View style={{ width: 36 }} />
      </View>

      <Text style={styles.infoText}>
        Grant head teachers access to specific management features. They can only act within
        the permissions you enable here.
      </Text>

      {loading ? (
        <ActivityIndicator size="large" color={PRIMARY} style={{ marginTop: 60 }} />
      ) : headTeachers.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="people-outline" size={48} color={GREY} />
          <Text style={styles.emptyTitle}>No Head Teachers</Text>
          <Text style={styles.emptyText}>
            No teachers with the "head_teacher" role found in your department.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {headTeachers.map((ht) => (
            <View key={ht.teacher_id} style={styles.card}>
              {/* Teacher info */}
              <View style={styles.cardHeader}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {ht.name.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.cardInfo}>
                  <Text style={styles.cardName}>{ht.name}</Text>
                  <Text style={styles.cardDesig}>{ht.designation}</Text>
                </View>
                {saving === ht.teacher_id && (
                  <ActivityIndicator size="small" color={PRIMARY} />
                )}
              </View>

              {/* Rights toggles */}
              {DELEGATABLE.map((d) => {
                const isOn = ht.delegated_keys.includes(d.key);
                return (
                  <TouchableOpacity
                    key={d.key}
                    style={styles.rightRow}
                    onPress={() => toggleRight(ht.teacher_id, d.key, isOn)}
                    disabled={saving === ht.teacher_id}
                  >
                    <View style={styles.rightLeft}>
                      <Ionicons name={d.icon} size={18} color={isOn ? PRIMARY : GREY} />
                      <Text style={[styles.rightLabel, isOn && styles.rightLabelOn]}>
                        {d.label}
                      </Text>
                    </View>
                    <View style={[styles.toggle, isOn && styles.toggleOn]}>
                      <View style={[styles.toggleThumb, isOn && styles.toggleThumbOn]} />
                    </View>
                  </TouchableOpacity>
                );
              })}

              {/* Quick actions */}
              <View style={styles.quickRow}>
                <TouchableOpacity
                  style={styles.quickGrant}
                  onPress={() => grantAll(ht.teacher_id)}
                  disabled={saving === ht.teacher_id}
                >
                  <Text style={styles.quickGrantText}>Grant All</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.quickRevoke}
                  onPress={() => revokeAll(ht.teacher_id)}
                  disabled={saving === ht.teacher_id}
                >
                  <Text style={styles.quickRevokeText}>Revoke All</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
          <View style={{ height: 60 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    justifyContent: "space-between",
  },
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: "800", color: "#111" },
  infoText: {
    marginHorizontal: 20,
    marginBottom: 16,
    fontSize: 13,
    color: GREY,
    lineHeight: 20,
  },
  content: { paddingHorizontal: 16 },
  card: {
    backgroundColor: "#FFF",
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    elevation: 2,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: PRIMARY + "18",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 18, fontWeight: "800", color: PRIMARY },
  cardInfo: { flex: 1 },
  cardName: { fontSize: 15, fontWeight: "700", color: "#111" },
  cardDesig: { fontSize: 12, color: GREY, marginTop: 2 },
  rightRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
  },
  rightLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  rightLabel: { fontSize: 14, color: GREY, fontWeight: "500" },
  rightLabelOn: { color: "#111", fontWeight: "700" },
  toggle: {
    width: 44,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#D1D5DB",
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  toggleOn: { backgroundColor: PRIMARY },
  toggleThumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#FFF",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  toggleThumbOn: { alignSelf: "flex-end" },
  quickRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  quickGrant: {
    flex: 1,
    backgroundColor: PRIMARY + "18",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  quickGrantText: { color: PRIMARY, fontWeight: "700", fontSize: 13 },
  quickRevoke: {
    flex: 1,
    backgroundColor: "#FEE2E2",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  quickRevokeText: { color: "#B91C1C", fontWeight: "700", fontSize: 13 },
  empty: { alignItems: "center", paddingTop: 80, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: "#111827", marginTop: 4 },
  emptyText: { fontSize: 14, color: GREY, textAlign: "center", paddingHorizontal: 30 },
});