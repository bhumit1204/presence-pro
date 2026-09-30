import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG = "#F3F4F6";
const GREY = "#6B7280";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

const COURSE_COLORS = ["#4834D4", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899"];

interface Subject {
  subject_id: string;
  subject_name: string;
  course_id: string;
  course_name: string;
}

interface Course {
  course_id: string;
  course_name: string;
  subjects: Subject[];
}

export default function TeacherWork() {
  const navigation = useNavigation<any>();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [teacherId, setTeacherId] = useState<string | null>(null);

  const fetchCourses = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const session = await getUserSession();
      const tid = session?.teacher_id;
      setTeacherId(tid);

      const res = await fetch(`${API_URL}/api/lectures/teachers/subjects?teacher_id=${tid}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      const subjects: Subject[] = data.subjects || [];
      const courseMap: Record<string, Course> = {};

      subjects.forEach((s) => {
        if (!courseMap[s.course_id]) {
          courseMap[s.course_id] = {
            course_id: s.course_id,
            course_name: s.course_name || "Unknown Course",
            subjects: [],
          };
        }
        courseMap[s.course_id].subjects.push(s);
      });

      setCourses(Object.values(courseMap));
    } catch (e) {
      console.error("Fetch courses error:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchCourses(); }, [fetchCourses]));

  return (
    <SafeAreaView style={S.safe}>
      <View style={S.header}>
        <Text style={S.title}>Classwork</Text>
        <Text style={S.subtitle}>Manage assignments & announcements</Text>
      </View>

      <ScrollView
        contentContainerStyle={S.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchCourses(true); }}
            colors={[PRIMARY]} />
        }
      >
        {loading ? (
          <View style={S.center}>
            <ActivityIndicator size="large" color={PRIMARY} />
            <Text style={S.loadingText}>Loading courses…</Text>
          </View>
        ) : courses.length === 0 ? (
          <View style={S.empty}>
            <Ionicons name="library-outline" size={52} color={GREY} />
            <Text style={S.emptyTitle}>No courses assigned</Text>
            <Text style={S.emptyText}>You haven't been assigned to any subjects yet.</Text>
          </View>
        ) : (
          courses.map((course, idx) => {
            const color = COURSE_COLORS[idx % COURSE_COLORS.length];
            return (
              <TouchableOpacity
                key={course.course_id}
                style={S.courseCard}
                onPress={() => navigation.navigate("TeacherSubjectPicker", { course, teacher_id: teacherId })}
                activeOpacity={0.82}
              >
                {/* Color strip */}
                <View style={[S.colorStrip, { backgroundColor: color }]} />

                <View style={S.cardContent}>
                  <View style={[S.courseAvatar, { backgroundColor: color + "18" }]}>
                    <Text style={[S.courseAvatarText, { color }]}>
                      {course.course_name.charAt(0)}
                    </Text>
                  </View>

                  <View style={S.courseInfo}>
                    <Text style={S.courseName} numberOfLines={2}>{course.course_name}</Text>
                    <View style={S.subjectPills}>
                      {course.subjects.slice(0, 2).map((s) => (
                        <View key={s.subject_id} style={[S.pill, { backgroundColor: color + "14" }]}>
                          <Text style={[S.pillText, { color }]} numberOfLines={1}>{s.subject_name}</Text>
                        </View>
                      ))}
                      {course.subjects.length > 2 && (
                        <View style={[S.pill, { backgroundColor: "#F3F4F6" }]}>
                          <Text style={[S.pillText, { color: GREY }]}>+{course.subjects.length - 2}</Text>
                        </View>
                      )}
                    </View>
                  </View>

                  <View style={[S.chevronWrap, { backgroundColor: color + "12" }]}>
                    <Ionicons name="chevron-forward" size={18} color={color} />
                  </View>
                </View>
              </TouchableOpacity>
            );
          })
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  header: { paddingHorizontal: 20, paddingTop: 16, marginBottom: 12 },
  title: { fontSize: 28, fontWeight: "800", color: "#111827" },
  subtitle: { fontSize: 14, color: GREY, marginTop: 4 },
  list: { paddingHorizontal: 20, paddingTop: 4 },

  courseCard: {
    backgroundColor: "#FFF",
    borderRadius: 18,
    marginBottom: 12,
    flexDirection: "row",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    overflow: "hidden",
  },
  colorStrip: { width: 4 },
  cardContent: { flex: 1, flexDirection: "row", alignItems: "center", padding: 16, gap: 14 },
  courseAvatar: { width: 52, height: 52, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  courseAvatarText: { fontSize: 22, fontWeight: "800" },
  courseInfo: { flex: 1 },
  courseName: { fontSize: 16, fontWeight: "700", color: "#111827", marginBottom: 8 },
  subjectPills: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
  pill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 140 },
  pillText: { fontSize: 11, fontWeight: "600" },
  chevronWrap: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },

  center: { paddingTop: 80, alignItems: "center", gap: 10 },
  loadingText: { fontSize: 14, color: GREY },
  empty: { alignItems: "center", paddingTop: 80, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: "#111827", marginTop: 4 },
  emptyText: { fontSize: 14, color: GREY, textAlign: "center" },
});