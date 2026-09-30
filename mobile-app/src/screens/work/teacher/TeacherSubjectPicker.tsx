import React, { useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG = "#F3F4F6";
const GREY = "#6B7280";

const SUBJECT_COLORS = ["#4834D4", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#06B6D4", "#84CC16"];

export default function TeacherSubjectPicker() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { course, teacher_id } = route.params;
  const subjects = course.subjects || [];

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={S.content} showsVerticalScrollIndicator={false}>
        {/* Back */}
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={22} color={PRIMARY} />
        </TouchableOpacity>

        <Text style={S.title}>{course.course_name}</Text>
        <Text style={S.subtitle}>Select a subject to view classwork</Text>

        <View style={S.grid}>
          {subjects.map((sub: any, idx: number) => {
            const color = SUBJECT_COLORS[idx % SUBJECT_COLORS.length];
            return (
              <TouchableOpacity
                key={sub.subject_id}
                style={S.subjectCard}
                onPress={() =>
                  navigation.navigate("TeacherSubjectFeed", {
                    subject: sub,
                    course,
                    teacher_id,
                  })
                }
                activeOpacity={0.82}
              >
                <View style={[S.subjectIcon, { backgroundColor: color + "18" }]}>
                  <Text style={[S.subjectIconText, { color }]}>
                    {sub.subject_name.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <Text style={S.subjectName} numberOfLines={3}>
                  {sub.subject_name}
                </Text>
                <View style={[S.arrow, { backgroundColor: color + "12" }]}>
                  <Ionicons name="arrow-forward" size={16} color={color} />
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {subjects.length === 0 && (
          <View style={S.empty}>
            <Ionicons name="folder-outline" size={44} color={GREY} style={{marginBottom:12}} />
            <Text style={S.emptyTitle}>No subjects found</Text>
            <Text style={S.emptyText}>This course has no subjects assigned to you.</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20, paddingBottom: 40 },

  backBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "#FFF", alignItems: "center", justifyContent: "center",
    marginTop: 4, marginBottom: 16,
    elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6,
  },
  backIcon: { fontSize: 22, fontWeight: "700", color: PRIMARY },

  title: { fontSize: 26, fontWeight: "800", color: "#111827", marginBottom: 4 },
  subtitle: { fontSize: 14, color: GREY, marginBottom: 24 },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },

  subjectCard: {
    width: "47.5%",
    backgroundColor: "#FFF",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  subjectIcon: {
    width: 48, height: 48, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
    marginBottom: 12,
  },
  subjectIconText: { fontSize: 20, fontWeight: "800" },
  subjectName: { fontSize: 14, fontWeight: "700", color: "#111827", marginBottom: 12, lineHeight: 20 },
  arrow: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", alignSelf: "flex-end" },
  arrowText: { fontSize: 16, fontWeight: "700" },

  empty: { alignItems: "center", paddingTop: 60 },
  emptyEmoji: { fontSize: 44, marginBottom: 12 },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: "#111827", marginBottom: 6 },
  emptyText: { fontSize: 14, color: GREY, textAlign: "center" },
});