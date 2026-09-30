/**
 * SemesterDatesManager.tsx
 * HOD-only. Receives { course_id, course_name, semester } from HODManage.
 * Sets/updates the start_date and end_date for the given semester.
 *
 * API: /api/manage/semester-dates (GET) and /api/manage/semester-dates/save (POST)
 */

import React, { useState, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";

const PRIMARY = "#4834D4";
const AMBER = "#F59E0B";
const GREY = "#6B7280";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

export default function SemesterDatesManager() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { course_id, course_name, semester } = route.params || {};

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const fetchDates = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/manage/semester-dates?course_id=${course_id}`
        );
        const data = await res.json();
        if (data.success) {
          const entry = data.dates.find((d: any) => d.semester === Number(semester));
          if (entry) {
            setStartDate(entry.start_date || "");
            setEndDate(entry.end_date || "");
          }
        }
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    };
    fetchDates();
  }, []);

  const handleSave = async () => {
    if (!startDate || !endDate) {
      Alert.alert("Error", "Both start and end dates are required.");
      return;
    }
    try {
      setSaving(true);
      const session = await getUserSession();
      const res = await fetch(`${API_URL}/api/manage/semester-dates/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          course_id,
          semester: Number(semester),
          start_date: startDate.trim(),
          end_date: endDate.trim(),
          teacher_id: session.teacher_id,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSaved(true);
        Alert.alert("Saved ✓", `Semester ${semester} dates updated.`);
      } else {
        Alert.alert("Error", data.error || "Failed to save.");
      }
    } catch {
      Alert.alert("Error", "Network error.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#111" />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Semester Dates</Text>
          <Text style={styles.subtitle}>{course_name} · Sem {semester}</Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={AMBER} style={{ marginTop: 60 }} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.iconWrap}>
                <Ionicons name="time" size={24} color={AMBER} />
              </View>
              <Text style={styles.cardTitle}>Semester {semester} Duration</Text>
            </View>

            <Text style={styles.label}>Start Date</Text>
            <TextInput
              style={styles.input}
              value={startDate}
              onChangeText={(v) => { setStartDate(v); setSaved(false); }}
              placeholder="YYYY-MM-DD  e.g. 2025-07-15"
              placeholderTextColor="#B0B0B0"
              keyboardType="numbers-and-punctuation"
            />

            <Text style={styles.label}>End Date</Text>
            <TextInput
              style={styles.input}
              value={endDate}
              onChangeText={(v) => { setEndDate(v); setSaved(false); }}
              placeholder="YYYY-MM-DD  e.g. 2025-11-30"
              placeholderTextColor="#B0B0B0"
              keyboardType="numbers-and-punctuation"
            />

            {startDate && endDate && (
              <View style={styles.durationBox}>
                <Ionicons name="calendar-outline" size={14} color={AMBER} />
                <Text style={styles.durationText}>
                  {startDate}  →  {endDate}
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.saveBtn, saving && { opacity: 0.7 }]}
              onPress={handleSave}
              disabled={saving}
            >
              {saving
                ? <ActivityIndicator color="#FFF" />
                : <Text style={styles.saveBtnText}>
                    {saved ? "✓ Saved" : "Save Dates"}
                  </Text>
              }
            </TouchableOpacity>
          </View>

          <View style={styles.hintBox}>
            <Ionicons name="information-circle-outline" size={16} color={GREY} />
            <Text style={styles.hintText}>
              These dates are used to determine the active semester for students and to calculate attendance periods.
            </Text>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F3F4F6" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
    justifyContent: "space-between", backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#E5E7EB",
  },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: "800", color: "#111" },
  subtitle: { fontSize: 12, color: GREY, marginTop: 2 },
  content: { padding: 20 },
  card: {
    backgroundColor: "#FFF",
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    elevation: 2,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 20 },
  iconWrap: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: "#FEF3C7",
    alignItems: "center", justifyContent: "center",
  },
  cardTitle: { fontSize: 16, fontWeight: "700", color: "#111" },
  label: { fontSize: 13, fontWeight: "600", color: GREY, marginBottom: 6, marginTop: 14 },
  input: {
    borderWidth: 1, borderColor: "#E5E7EB",
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, color: "#111", backgroundColor: "#FAFAFA",
  },
  durationBox: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#FEF9C3", borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 8, marginTop: 14,
  },
  durationText: { fontSize: 13, color: "#92400E", fontWeight: "600" },
  saveBtn: {
    backgroundColor: AMBER, borderRadius: 12,
    paddingVertical: 14, alignItems: "center", marginTop: 20,
  },
  saveBtnText: { color: "#FFF", fontWeight: "700", fontSize: 15 },
  hintBox: {
    flexDirection: "row", gap: 8, marginTop: 16,
    padding: 14, backgroundColor: "#F9FAFB",
    borderRadius: 12, borderWidth: 1, borderColor: "#E5E7EB",
  },
  hintText: { fontSize: 13, color: GREY, flex: 1, lineHeight: 18 },
});