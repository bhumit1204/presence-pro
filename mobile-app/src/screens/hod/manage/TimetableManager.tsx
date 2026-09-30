/**
 * TimetableManager.tsx
 *
 * Visual timetable grid — days as columns, time slots as rows.
 * Route params: { teacher_id, role, course_id, course_name, semester }
 * (passed directly from HODManage so no course/semester picker needed here)
 *
 * API: /api/manage/timetable  (GET, add, update, delete, make-permanent)
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  TextInput,
  Alert,
  Platform,
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

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAYS: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
};

// Common lecture periods — each cell is 1 hour
const DEFAULT_PERIODS = [
  "08:00", "09:00", "10:00", "11:00", "12:00",
  "13:00", "14:00", "15:00", "16:00", "17:00",
];

const SUBJECT_COLORS = [
  "#4834D4", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6",
  "#EC4899", "#0EA5E9", "#14B8A6", "#F97316", "#6366F1",
];

interface TimetableSlot {
  slot_id: string;
  day: string;
  start_time: string;
  end_time: string;
  subject_name: string;
  teacher_name: string;
  room: string;
  is_temporary?: boolean;
  temp_date?: string;
}

export default function TimetableManager() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { teacher_id: routeTeacherId, role, course_id, course_name, semester } = route.params || {};

  const [slots, setSlots] = useState<TimetableSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [myName, setMyName] = useState("");
  const [modalVisible, setModalVisible] = useState(false);
  const [editSlot, setEditSlot] = useState<TimetableSlot | null>(null);
  const [prefillDay, setPrefillDay] = useState("Monday");
  const [prefillTime, setPrefillTime] = useState("");

  const [form, setForm] = useState({
    day: "Monday",
    start_time: "",
    end_time: "",
    subject_name: "",
    teacher_name: "",
    room: "",
    is_temporary: false,
    temp_date: "",
  });

  // Map subject_name → color for consistent coloring
  const colorMap = useRef<Record<string, string>>({});
  const getColor = (name: string) => {
    if (!name) return "#9CA3AF";
    if (!colorMap.current[name]) {
      const idx = Object.keys(colorMap.current).length % SUBJECT_COLORS.length;
      colorMap.current[name] = SUBJECT_COLORS[idx];
    }
    return colorMap.current[name];
  };

  const fetchSlots = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `${API_URL}/api/manage/timetable?course_id=${course_id}&semester=${semester}`
      );
      const data = await res.json();
      if (data.success) setSlots(data.slots || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [course_id, semester]);

  useEffect(() => {
    fetchSlots();
    const loadProfile = async () => {
      try {
        const session = await getUserSession();
        const res = await fetch(`${API_URL}/api/profile/teacher/${session.teacher_id}`);
        const data = await res.json();
        if (data.success && data.profile) {
          setMyName(`${data.profile.first_name} ${data.profile.last_name}`.trim());
        }
      } catch {}
    };
    loadProfile();
  }, [fetchSlots]);

  // Find slot for a given day + start_time
  const slotAt = (day: string, time: string): TimetableSlot | undefined =>
    slots.find((s) => s.day === FULL_DAYS[day] && s.start_time === time);

  const openAdd = (day: string, time: string) => {
    setEditSlot(null);
    setForm({
      day: FULL_DAYS[day],
      start_time: time,
      end_time: addHour(time),
      subject_name: "",
      teacher_name: "",
      room: "",
      is_temporary: false,
      temp_date: "",
    });
    setModalVisible(true);
  };

  const openEdit = (slot: TimetableSlot) => {
    setEditSlot(slot);
    setForm({
      day: slot.day,
      start_time: slot.start_time,
      end_time: slot.end_time,
      subject_name: slot.subject_name,
      teacher_name: slot.teacher_name || "",
      room: slot.room || "",
      is_temporary: slot.is_temporary || false,
      temp_date: slot.temp_date || "",
    });
    setModalVisible(true);
  };

  const addHour = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };

  const handleSave = async () => {
    if (!form.subject_name.trim()) {
      Alert.alert("Error", "Subject name is required."); return;
    }
    try {
      const session = await getUserSession();
      const body = {
        ...form,
        course_id,
        semester,
        teacher_id: session.teacher_id,
        slot_id: editSlot?.slot_id,
      };
      const url = editSlot
        ? `${API_URL}/api/manage/timetable/update`
        : `${API_URL}/api/manage/timetable/add`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setModalVisible(false);
        fetchSlots();
      } else {
        Alert.alert("Error", data.error || "Failed to save.");
      }
    } catch {
      Alert.alert("Error", "Network error.");
    }
  };

  const handleDelete = async (slot_id: string) => {
    Alert.alert("Remove slot?", "This will remove the lecture from the timetable.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          await fetch(`${API_URL}/api/manage/timetable/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slot_id }),
          });
          setModalVisible(false);
          fetchSlots();
        },
      },
    ]);
  };

  const handleMakePermanent = async (slot_id: string) => {
    await fetch(`${API_URL}/api/manage/timetable/make-permanent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot_id }),
    });
    fetchSlots();
  };

  const CELL_W = 110;
  const CELL_H = 72;
  const TIME_COL_W = 52;

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#111" />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Timetable</Text>
          <Text style={styles.subtitle}>
            {course_name} · Sem {semester}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => openAdd("Mon", "09:00")}
        >
          <Ionicons name="add" size={22} color="#FFF" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <ScrollView showsVerticalScrollIndicator={false}>
            {/* ── Day header row ────────────────────────────────────────── */}
            <View style={styles.gridRow}>
              {/* Empty corner */}
              <View style={[styles.cornerCell, { width: TIME_COL_W }]} />
              {DAYS.map((d) => (
                <View key={d} style={[styles.dayHeaderCell, { width: CELL_W }]}>
                  <Text style={styles.dayHeaderText}>{d}</Text>
                </View>
              ))}
            </View>

            {/* ── Time rows ─────────────────────────────────────────────── */}
            {DEFAULT_PERIODS.map((time) => (
              <View key={time} style={styles.gridRow}>
                {/* Time label */}
                <View style={[styles.timeCell, { width: TIME_COL_W, height: CELL_H }]}>
                  <Text style={styles.timeText}>{time}</Text>
                </View>

                {/* Day cells */}
                {DAYS.map((day) => {
                  const slot = slotAt(day, time);
                  return (
                    <TouchableOpacity
                      key={day}
                      style={[
                        styles.cell,
                        { width: CELL_W, height: CELL_H },
                        slot && { backgroundColor: getColor(slot.subject_name) + "22" },
                      ]}
                      onPress={() => slot ? openEdit(slot) : openAdd(day, time)}
                      activeOpacity={0.75}
                    >
                      {slot ? (
                        <>
                          {/* Colored left border */}
                          <View
                            style={[
                              styles.cellStrip,
                              { backgroundColor: getColor(slot.subject_name) },
                            ]}
                          />
                          <View style={styles.cellContent}>
                            <Text style={styles.cellSubject} numberOfLines={2}>
                              {slot.subject_name}
                            </Text>
                            {slot.teacher_name ? (
                              <Text style={styles.cellTeacher} numberOfLines={1}>
                                {slot.teacher_name}
                              </Text>
                            ) : null}
                            {slot.room ? (
                              <Text style={styles.cellRoom}>{slot.room}</Text>
                            ) : null}
                            {slot.is_temporary && (
                              <View style={styles.tempTag}>
                                <Text style={styles.tempTagText}>TEMP</Text>
                              </View>
                            )}
                          </View>
                        </>
                      ) : (
                        <View style={styles.emptyCell}>
                          <Ionicons name="add" size={16} color="#D1D5DB" />
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
            <View style={{ height: 40 }} />
          </ScrollView>
        </ScrollView>
      )}

      {/* ── Add / Edit Modal ─────────────────────────────────────────────── */}
      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <ScrollView style={{ width: "100%" }}>
            <View style={styles.modalSheet}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {editSlot ? "Edit Slot" : "Add Slot"}
                </Text>
                {editSlot && (
                  <TouchableOpacity
                    onPress={() => handleDelete(editSlot.slot_id)}
                    style={styles.deleteBtn}
                  >
                    <Ionicons name="trash-outline" size={20} color="#EF4444" />
                  </TouchableOpacity>
                )}
              </View>

              {/* Day selector */}
              <Text style={styles.fieldLabel}>Day</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
                {Object.values(FULL_DAYS).map((d) => (
                  <TouchableOpacity
                    key={d}
                    style={[styles.dayChip, form.day === d && styles.dayChipActive]}
                    onPress={() => setForm((f) => ({ ...f, day: d }))}
                  >
                    <Text style={[styles.dayChipText, form.day === d && styles.dayChipTextActive]}>
                      {d.slice(0, 3)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {/* Time */}
              <Text style={styles.fieldLabel}>Time</Text>
              <View style={styles.row2}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.timeSubLabel}>Start</Text>
                  <TextInput
                    style={styles.input}
                    value={form.start_time}
                    onChangeText={(v) => setForm((f) => ({ ...f, start_time: v }))}
                    placeholder="09:00"
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.timeSubLabel}>End</Text>
                  <TextInput
                    style={styles.input}
                    value={form.end_time}
                    onChangeText={(v) => setForm((f) => ({ ...f, end_time: v }))}
                    placeholder="10:00"
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
              </View>

              <Text style={styles.fieldLabel}>Subject *</Text>
              <TextInput
                style={styles.input}
                value={form.subject_name}
                onChangeText={(v) => setForm((f) => ({ ...f, subject_name: v }))}
                placeholder="e.g. Data Structures"
              />

              <Text style={styles.fieldLabel}>Teacher Name</Text>
              <View style={styles.teacherRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={form.teacher_name}
                  onChangeText={(v) => setForm((f) => ({ ...f, teacher_name: v }))}
                  placeholder="Assigned teacher"
                />
                {myName ? (
                  <TouchableOpacity
                    style={styles.meBtn}
                    onPress={() => setForm((f) => ({ ...f, teacher_name: myName }))}
                  >
                    <Text style={styles.meBtnText}>Me</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

              <Text style={styles.fieldLabel}>Room</Text>
              <TextInput
                style={styles.input}
                value={form.room}
                onChangeText={(v) => setForm((f) => ({ ...f, room: v }))}
                placeholder="e.g. A201"
              />

              {/* Temporary toggle */}
              <TouchableOpacity
                style={styles.toggleRow}
                onPress={() => setForm((f) => ({ ...f, is_temporary: !f.is_temporary }))}
              >
                <View style={[styles.toggleBox, form.is_temporary && styles.toggleBoxOn]}>
                  {form.is_temporary && <Ionicons name="checkmark" size={13} color="#FFF" />}
                </View>
                <Text style={styles.toggleLabel}>Temporary (one-time change)</Text>
              </TouchableOpacity>

              {form.is_temporary && (
                <>
                  <Text style={styles.fieldLabel}>Date (YYYY-MM-DD)</Text>
                  <TextInput
                    style={styles.input}
                    value={form.temp_date}
                    onChangeText={(v) => setForm((f) => ({ ...f, temp_date: v }))}
                    placeholder="2025-09-12"
                  />
                </>
              )}

              {editSlot?.is_temporary && (
                <TouchableOpacity
                  style={styles.promoteBtn}
                  onPress={() => {
                    handleMakePermanent(editSlot.slot_id);
                    setModalVisible(false);
                  }}
                >
                  <Ionicons name="checkmark-circle" size={16} color="#065F46" />
                  <Text style={styles.promoteBtnText}>Make Permanent</Text>
                </TouchableOpacity>
              )}

              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setModalVisible(false)}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
                  <Text style={styles.saveBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
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
    backgroundColor: "#FFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: "800", color: "#111" },
  subtitle: { fontSize: 12, color: GREY, marginTop: 2 },
  addBtn: {
    backgroundColor: PRIMARY,
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  // ── Grid ─────────────────────────────────────────────────────────────────
  gridRow: { flexDirection: "row" },
  cornerCell: {
    backgroundColor: "#FFF",
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#E5E7EB",
  },
  dayHeaderCell: {
    backgroundColor: PRIMARY,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: PRIMARY + "88",
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  dayHeaderText: { color: "#FFF", fontWeight: "700", fontSize: 12 },
  timeCell: {
    backgroundColor: "#F9FAFB",
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#E5E7EB",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  timeText: { fontSize: 10, color: GREY, fontWeight: "600" },
  cell: {
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#FFF",
    flexDirection: "row",
    overflow: "hidden",
  },
  cellStrip: { width: 3 },
  cellContent: { flex: 1, padding: 5, justifyContent: "center" },
  cellSubject: { fontSize: 10, fontWeight: "700", color: "#111827", lineHeight: 13 },
  cellTeacher: { fontSize: 9, color: GREY, marginTop: 2 },
  cellRoom: { fontSize: 9, color: "#9CA3AF", marginTop: 1 },
  tempTag: {
    backgroundColor: "#FEF3C7",
    borderRadius: 3,
    paddingHorizontal: 3,
    paddingVertical: 1,
    marginTop: 3,
    alignSelf: "flex-start",
  },
  tempTagText: { fontSize: 8, fontWeight: "800", color: "#B45309" },
  emptyCell: { flex: 1, alignItems: "center", justifyContent: "center" },

  // ── Modal ─────────────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#FFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: Platform.OS === "ios" ? 40 : 24,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: "#111" },
  deleteBtn: {
    padding: 6,
    backgroundColor: "#FEE2E2",
    borderRadius: 8,
  },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: GREY, marginBottom: 6, marginTop: 12 },
  timeSubLabel: { fontSize: 11, color: GREY, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: "#111",
    backgroundColor: "#FAFAFA",
  },
  row2: { flexDirection: "row", gap: 10 },
  teacherRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  meBtn: {
    backgroundColor: PRIMARY,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  meBtnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14 },
  toggleBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#D1D5DB",
    alignItems: "center",
    justifyContent: "center",
  },
  toggleBoxOn: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  toggleLabel: { fontSize: 14, color: "#374151" },
  promoteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#D1FAE5",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 12,
    alignSelf: "flex-start",
  },
  promoteBtnText: { fontSize: 13, color: "#065F46", fontWeight: "700" },
  modalActions: { flexDirection: "row", gap: 12, marginTop: 20 },
  cancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  cancelBtnText: { fontWeight: "600", color: GREY },
  saveBtn: {
    flex: 2,
    backgroundColor: PRIMARY,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveBtnText: { fontWeight: "700", color: "#FFF" },
  dayChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
    backgroundColor: "#F3F4F6",
    marginRight: 6,
  },
  dayChipActive: { backgroundColor: PRIMARY },
  dayChipText: { fontSize: 12, fontWeight: "600", color: GREY },
  dayChipTextActive: { color: "#FFF" },
});