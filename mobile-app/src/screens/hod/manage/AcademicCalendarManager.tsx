/**
 * AcademicCalendarManager.tsx
 * Accessible to: HOD (always), head_teacher (if delegated "academic_calendar")
 */

import React, { useState, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Modal, TextInput, Alert, Platform, ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";
const GREY = "#6B7280";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

const EVENT_TYPES = [
  { key: "test", label: "Test / Exam", color: "#EF4444" },
  { key: "holiday", label: "Holiday", color: "#10B981" },
  { key: "event", label: "College Event", color: "#8B5CF6" },
  { key: "general", label: "General", color: "#F59E0B" },
];

interface CalEvent {
  event_id: string;
  date: string;
  title: string;
  event_type: string;
  description: string;
}

export default function AcademicCalendarManager() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { teacher_id, role } = route.params || {};

  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);
  const [aisheCode, setAisheCode] = useState("");
  const [academicYear, setAcademicYear] = useState(
    `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`
  );

  const [form, setForm] = useState({
    date: "",
    title: "",
    event_type: "general",
    description: "",
  });

  const fetchEvents = async (code: string, year: string) => {
    try {
      setLoading(true);
      const res = await fetch(
        `${API_URL}/api/manage/calendar?aishe_code=${code}&year=${year}`
      );
      const data = await res.json();
      if (data.success) setEvents(data.events || []);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  useEffect(() => {
    const init = async () => {
      // teacher_id from route params is actually the Firebase Auth uid.
      // Use it to fetch the teacher profile via the uid-based endpoint.
      const uid = teacher_id;
      const res = await fetch(`${API_URL}/api/profile/teacher/${uid}`);
      const data = await res.json();
      if (data.success) {
        const code = data.profile.aishe_code;
        setAisheCode(code);
        fetchEvents(code, academicYear);
      }
    };
    init();
  }, []);

  const handleAdd = async () => {
    if (!form.date || !form.title) {
      Alert.alert("Error", "Date and title are required."); return;
    }
    try {
      // teacher_id from route params is the uid — backend resolves it
      const res = await fetch(`${API_URL}/api/manage/calendar/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          aishe_code: aisheCode,
          academic_year: academicYear,
          teacher_id,   // uid — backend resolves via user_id field
        }),
      });
      const data = await res.json();
      if (data.success) {
        setModalVisible(false);
        fetchEvents(aisheCode, academicYear);
      }
    } catch (e) { Alert.alert("Error", "Network error."); }
  };

  const handleDelete = async (event_id: string) => {
    Alert.alert("Delete?", "Remove this calendar event?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive", onPress: async () => {
          await fetch(`${API_URL}/api/manage/calendar/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event_id }),
          });
          fetchEvents(aisheCode, academicYear);
        },
      },
    ]);
  };

  const getTypeColor = (type: string) =>
    EVENT_TYPES.find((t) => t.key === type)?.color || GREY;
  const getTypeLabel = (type: string) =>
    EVENT_TYPES.find((t) => t.key === type)?.label || "General";

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#111" />
        </TouchableOpacity>
        <Text style={styles.title}>Academic Calendar</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => {
          setForm({ date: "", title: "", event_type: "general", description: "" });
          setModalVisible(true);
        }}>
          <Ionicons name="add" size={22} color="#FFF" />
        </TouchableOpacity>
      </View>

      {/* Year selector */}
      <View style={styles.yearRow}>
        {[
          `${new Date().getFullYear() - 1}-${new Date().getFullYear()}`,
          `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`,
        ].map((y) => (
          <TouchableOpacity
            key={y}
            style={[styles.yearChip, academicYear === y && styles.yearChipActive]}
            onPress={() => { setAcademicYear(y); fetchEvents(aisheCode, y); }}
          >
            <Text style={[styles.yearChipText, academicYear === y && styles.yearChipTextActive]}>{y}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={PRIMARY} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {events.length === 0 && (
            <Text style={styles.hint}>No events for {academicYear}. Add one!</Text>
          )}
          {events.map((ev) => (
            <View key={ev.event_id} style={styles.eventCard}>
              <View style={[styles.eventStrip, { backgroundColor: getTypeColor(ev.event_type) }]} />
              <View style={styles.eventBody}>
                <View style={styles.rowBetween}>
                  <Text style={styles.eventTitle}>{ev.title}</Text>
                  <View style={[styles.typeBadge, { backgroundColor: getTypeColor(ev.event_type) + "20" }]}>
                    <Text style={[styles.typeBadgeText, { color: getTypeColor(ev.event_type) }]}>
                      {getTypeLabel(ev.event_type)}
                    </Text>
                  </View>
                </View>
                <Text style={styles.eventDate}>{ev.date}</Text>
                {ev.description ? <Text style={styles.eventDesc}>{ev.description}</Text> : null}
              </View>
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() => handleDelete(ev.event_id)}
              >
                <Ionicons name="trash-outline" size={18} color="#EF4444" />
              </TouchableOpacity>
            </View>
          ))}
          <View style={{ height: 60 }} />
        </ScrollView>
      )}

      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Add Calendar Event</Text>

            <Text style={styles.fieldLabel}>Date (YYYY-MM-DD) *</Text>
            <TextInput style={styles.input} value={form.date} onChangeText={(v) => setForm((f) => ({ ...f, date: v }))} placeholder="2025-08-15" />

            <Text style={styles.fieldLabel}>Event Title *</Text>
            <TextInput style={styles.input} value={form.title} onChangeText={(v) => setForm((f) => ({ ...f, title: v }))} placeholder="e.g. Unit Test 1" />

            <Text style={styles.fieldLabel}>Type</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
              {EVENT_TYPES.map((t) => (
                <TouchableOpacity
                  key={t.key}
                  onPress={() => setForm((f) => ({ ...f, event_type: t.key }))}
                  style={[
                    styles.typeChip,
                    { borderColor: t.color },
                    form.event_type === t.key && { backgroundColor: t.color },
                  ]}
                >
                  <Text style={[styles.typeChipText, form.event_type === t.key && { color: "#FFF" }]}>
                    {t.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput
              style={[styles.input, { height: 80, textAlignVertical: "top" }]}
              value={form.description}
              onChangeText={(v) => setForm((f) => ({ ...f, description: v }))}
              multiline
              placeholder="Optional details..."
            />

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setModalVisible(false)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleAdd}>
                <Text style={styles.saveBtnText}>Add Event</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, justifyContent: "space-between" },
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: "800", color: "#111" },
  addBtn: { backgroundColor: "#8B5CF6", width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  yearRow: { flexDirection: "row", gap: 10, paddingHorizontal: 16, marginBottom: 12 },
  yearChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 100, backgroundColor: "#FFF", borderWidth: 1, borderColor: "#E5E7EB" },
  yearChipActive: { backgroundColor: "#8B5CF6", borderColor: "#8B5CF6" },
  yearChipText: { fontWeight: "600", color: GREY, fontSize: 13 },
  yearChipTextActive: { color: "#FFF" },
  content: { paddingHorizontal: 16 },
  hint: { textAlign: "center", color: GREY, marginTop: 40, fontSize: 14 },
  eventCard: { backgroundColor: "#FFF", borderRadius: 14, marginBottom: 10, flexDirection: "row", overflow: "hidden", elevation: 2, borderWidth: 1, borderColor: "#E5E7EB" },
  eventStrip: { width: 4 },
  eventBody: { flex: 1, padding: 12 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  eventTitle: { fontSize: 15, fontWeight: "700", color: "#111", flex: 1, marginRight: 8 },
  typeBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  typeBadgeText: { fontSize: 11, fontWeight: "700" },
  eventDate: { fontSize: 12, color: GREY, marginTop: 4 },
  eventDesc: { fontSize: 12, color: "#374151", marginTop: 4 },
  deleteBtn: { padding: 14, justifyContent: "center" },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: "#FFF", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: Platform.OS === "ios" ? 40 : 24 },
  modalTitle: { fontSize: 18, fontWeight: "800", color: "#111", marginBottom: 12 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: GREY, marginBottom: 6, marginTop: 10 },
  input: { borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: "#111", backgroundColor: "#FAFAFA" },
  typeChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 100, borderWidth: 1.5, marginRight: 8, backgroundColor: "#FFF" },
  typeChipText: { fontSize: 12, fontWeight: "600", color: "#374151" },
  modalActions: { flexDirection: "row", gap: 12, marginTop: 20 },
  cancelBtn: { flex: 1, borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  cancelBtnText: { fontWeight: "600", color: GREY },
  saveBtn: { flex: 2, backgroundColor: "#8B5CF6", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  saveBtnText: { fontWeight: "700", color: "#FFF" },
});