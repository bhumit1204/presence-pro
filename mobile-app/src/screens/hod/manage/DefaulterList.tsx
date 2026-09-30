/**
 * DefaulterList.tsx
 * Accessible to: HOD (always), head_teacher (if delegated "defaulter_list")
 *
 * Receives { course_id, course_name, semester, role, teacher_id } from HODManage.
 * teacher_id here is the Firebase Auth uid — backend resolves via user_id field.
 */

import React, { useState, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";
const GREY = "#6B7280";
const DANGER = "#EF4444";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

interface Defaulter {
  student_id: string;
  name: string;
  roll_no: string;
  overall_percentage: number;
  subject_breakdown?: { subject_name: string; percentage: number }[];
}

export default function DefaulterList() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  // teacher_id is the Firebase Auth uid passed from HODManage
  const { course_id, course_name, semester, role, teacher_id } = route.params || {};

  const [threshold, setThreshold] = useState("75");
  const [defaulters, setDefaulters] = useState<Defaulter[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchDefaulters = async (thresh?: string) => {
    const t = thresh ?? threshold;
    try {
      setLoading(true);
      const res = await fetch(
        `${API_URL}/api/manage/defaulters?course_id=${course_id}&semester=${semester}&threshold=${t}&teacher_id=${teacher_id}&role=${role}`
      );
      const data = await res.json();
      if (data.success) setDefaulters(data.defaulters || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchDefaulters(); }, []);

  const getColor = (pct: number) => {
    if (pct < 50) return "#EF4444";
    if (pct < 65) return "#F59E0B";
    return "#10B981";
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#111" />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Defaulter List</Text>
          <Text style={styles.subtitle}>{course_name} · Sem {semester}</Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      {/* Threshold row */}
      <View style={styles.thresholdRow}>
        <Text style={styles.threshLabel}>Below</Text>
        <TextInput
          style={styles.threshInput}
          value={threshold}
          onChangeText={setThreshold}
          keyboardType="numeric"
          onEndEditing={() => fetchDefaulters()}
        />
        <Text style={styles.threshLabel}>% attendance</Text>
        <TouchableOpacity style={styles.applyBtn} onPress={() => fetchDefaulters()}>
          <Text style={styles.applyBtnText}>Apply</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={DANGER} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {defaulters.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="checkmark-circle-outline" size={48} color="#10B981" />
              <Text style={styles.emptyTitle}>No Defaulters</Text>
              <Text style={styles.emptyText}>All students are above {threshold}% attendance.</Text>
            </View>
          ) : (
            <>
              <Text style={styles.countText}>{defaulters.length} student(s) below {threshold}%</Text>
              {defaulters.map((d) => (
                <TouchableOpacity
                  key={d.student_id}
                  style={styles.card}
                  onPress={() => setExpandedId(expandedId === d.student_id ? null : d.student_id)}
                  activeOpacity={0.85}
                >
                  <View style={[styles.strip, { backgroundColor: getColor(d.overall_percentage) }]} />
                  <View style={styles.body}>
                    <View style={styles.rowBetween}>
                      <View>
                        <Text style={styles.name}>{d.name}</Text>
                        <Text style={styles.roll}>Roll: {d.roll_no}</Text>
                      </View>
                      <View style={[styles.pctBadge, { backgroundColor: getColor(d.overall_percentage) + "20" }]}>
                        <Text style={[styles.pctText, { color: getColor(d.overall_percentage) }]}>
                          {d.overall_percentage}%
                        </Text>
                      </View>
                    </View>

                    {expandedId === d.student_id && d.subject_breakdown && (
                      <View style={styles.breakdown}>
                        {d.subject_breakdown.map((sub, i) => (
                          <View key={i} style={styles.subRow}>
                            <Text style={styles.subName} numberOfLines={1}>{sub.subject_name}</Text>
                            <Text style={[styles.subPct, { color: getColor(sub.percentage) }]}>
                              {sub.percentage}%
                            </Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                  <Ionicons
                    name={expandedId === d.student_id ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={GREY}
                    style={{ alignSelf: "center", marginRight: 12 }}
                  />
                </TouchableOpacity>
              ))}
            </>
          )}
          <View style={{ height: 60 }} />
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
  thresholdRow: { flexDirection: "row", alignItems: "center", padding: 16, gap: 8, backgroundColor: "#FFF", borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  threshLabel: { fontSize: 13, color: GREY, fontWeight: "600" },
  threshInput: { borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14, color: "#111", width: 50, textAlign: "center", backgroundColor: "#FFF" },
  applyBtn: { backgroundColor: DANGER, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  applyBtnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  countText: { fontSize: 13, fontWeight: "700", color: DANGER, marginBottom: 10 },
  empty: { alignItems: "center", paddingTop: 60, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: "#111827" },
  emptyText: { fontSize: 14, color: GREY, textAlign: "center" },
  card: { backgroundColor: "#FFF", borderRadius: 14, marginBottom: 8, flexDirection: "row", overflow: "hidden", elevation: 2, borderWidth: 1, borderColor: "#E5E7EB" },
  strip: { width: 4 },
  body: { flex: 1, padding: 12 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  name: { fontSize: 15, fontWeight: "700", color: "#111" },
  roll: { fontSize: 12, color: GREY, marginTop: 2 },
  pctBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10 },
  pctText: { fontWeight: "800", fontSize: 14 },
  breakdown: { marginTop: 10, borderTopWidth: 1, borderTopColor: "#F3F4F6", paddingTop: 8 },
  subRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  subName: { fontSize: 13, color: "#374151", flex: 1 },
  subPct: { fontSize: 13, fontWeight: "700" },
});