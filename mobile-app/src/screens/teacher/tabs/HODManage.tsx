/**
 * HODManage.tsx
 *
 * Redesigned: shows courses from the college, and for each course a collapsible
 * list of semesters. Each semester block has ALL management actions inline:
 *   - Subjects & Teacher Assignment (HOD only)
 *   - Timetable
 *   - Semester Dates (HOD only)
 *   - Defaulter List
 *
 * Non-semester screens (Academic Calendar, Delegate Rights) appear as
 * separate cards below the course list.
 */

import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  LayoutAnimation,
  Platform,
  UIManager,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";

if (Platform.OS === "android") {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";
const GREY = "#6B7280";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

type Role = "teacher" | "student" | "hod" | "head_teacher" | null;

interface Course {
  course_id: string;
  course_name: string;
  abbr: string;
  total_semesters: number;
  semesters: number[];
}

// Actions available inside each semester block
interface SemAction {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  hodOnly: boolean;
  screen: string;
}

const SEM_ACTIONS: SemAction[] = [
  {
    key: "subjects",
    label: "Subjects",
    icon: "book-outline",
    color: "#10B981",
    hodOnly: true,
    screen: "SemesterSubjectsManager",
  },
  {
    key: "teacher_assignment",
    label: "Teacher Assignment",
    icon: "people-outline",
    color: "#EC4899",
    hodOnly: true,
    screen: "TeacherAssignmentManager",
  },
  {
    key: "timetable",
    label: "Timetable",
    icon: "calendar-outline",
    color: "#4834D4",
    hodOnly: false,
    screen: "TimetableManager",
  },
  {
    key: "semester_dates",
    label: "Sem Dates",
    icon: "time-outline",
    color: "#F59E0B",
    hodOnly: true,
    screen: "SemesterDatesManager",
  },
  {
    key: "defaulter_list",
    label: "Defaulters",
    icon: "warning-outline",
    color: "#EF4444",
    hodOnly: false,
    screen: "DefaulterList",
  },
];

export default function HODManage({ role }: { role: Role }) {
  const navigation = useNavigation<any>();
  const isHOD = role === "hod";

  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // uid is the Firebase Auth UID — used as teacher_id for all API calls
  // (the backend resolves it via the user_id field on the teacher doc)
  const [uid, setUid] = useState<string | null>(null);
  const [delegatedKeys, setDelegatedKeys] = useState<string[]>([]);
  // which course is expanded
  const [expandedCourse, setExpandedCourse] = useState<string | null>(null);

  const fetchData = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const session = await getUserSession();
      const currentUid = session?.uid || null;
      setUid(currentUid);

      if (!currentUid) return;

      // fetch delegated keys for head_teacher
      if (role === "head_teacher") {
        const res = await fetch(
          `${API_URL}/api/manage/delegated?teacher_id=${currentUid}`
        );
        const data = await res.json();
        if (data.success) setDelegatedKeys(data.delegated_keys || []);
      }

      // fetch courses for this college — backend resolves uid → aishe_code
      const res = await fetch(
        `${API_URL}/api/manage/courses?teacher_id=${currentUid}&role=${role}`
      );
      const data = await res.json();
      if (data.success) {
        setCourses(data.courses || []);
        // auto-expand the first course
        if (data.courses?.length > 0 && !expandedCourse) {
          setExpandedCourse(data.courses[0].course_id);
        }
      }
    } catch (e) {
      console.error("HODManage fetch error:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [role]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const canAccess = (action: SemAction): boolean => {
    if (isHOD) return true;
    if (action.hodOnly) return false;
    return delegatedKeys.includes(action.key);
  };

  const toggleCourse = (courseId: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedCourse(expandedCourse === courseId ? null : courseId);
  };

  const navigateSemAction = (action: SemAction, course: Course, semester: number) => {
    navigation.navigate(action.screen, {
      teacher_id: uid,   // uid is resolved server-side via user_id field
      role,
      course_id: course.course_id,
      course_name: course.course_name,
      semester,
    });
  };

  const renderRoleBadge = () => (
    <View style={[styles.roleBadge, isHOD ? styles.hodBadge : styles.htBadge]}>
      <Text style={[styles.roleBadgeText, isHOD ? styles.hodBadgeText : styles.htBadgeText]}>
        {isHOD ? "HOD" : "Head Teacher"}
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Manage</Text>
          {renderRoleBadge()}
        </View>
        <Text style={styles.subtitle}>
          {isHOD ? "Full administrative control" : "Actions delegated to you by HOD"}
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); fetchData(true); }}
              colors={[PRIMARY]}
            />
          }
        >
          {/* ── Course blocks ─────────────────────────────────────────────── */}
          {courses.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="school-outline" size={48} color={GREY} />
              <Text style={styles.emptyTitle}>No courses found</Text>
              <Text style={styles.emptyText}>
                No courses are linked to your college yet.
              </Text>
            </View>
          ) : (
            courses.map((course) => {
              const expanded = expandedCourse === course.course_id;
              return (
                <View key={course.course_id} style={styles.courseBlock}>
                  {/* Course header — tap to expand */}
                  <TouchableOpacity
                    style={styles.courseHeader}
                    onPress={() => toggleCourse(course.course_id)}
                    activeOpacity={0.8}
                  >
                    <View style={styles.courseHeaderLeft}>
                      <View style={styles.courseAbbrBadge}>
                        <Text style={styles.courseAbbrText}>{course.abbr}</Text>
                      </View>
                      <View>
                        <Text style={styles.courseName}>{course.course_name}</Text>
                        <Text style={styles.courseMeta}>
                          {course.total_semesters} semesters
                        </Text>
                      </View>
                    </View>
                    <Ionicons
                      name={expanded ? "chevron-up" : "chevron-down"}
                      size={20}
                      color={GREY}
                    />
                  </TouchableOpacity>

                  {/* Semester blocks — shown when expanded */}
                  {expanded && (
                    <View style={styles.semestersContainer}>
                      {course.semesters.map((sem) => (
                        <View key={sem} style={styles.semBlock}>
                          <View style={styles.semHeader}>
                            <View style={styles.semNumBadge}>
                              <Text style={styles.semNumText}>{sem}</Text>
                            </View>
                            <Text style={styles.semLabel}>Semester {sem}</Text>
                          </View>

                          {/* Action grid */}
                          <View style={styles.actionGrid}>
                            {SEM_ACTIONS.filter(canAccess).map((action) => (
                              <TouchableOpacity
                                key={action.key}
                                style={styles.actionBtn}
                                onPress={() => navigateSemAction(action, course, sem)}
                                activeOpacity={0.75}
                              >
                                <View
                                  style={[
                                    styles.actionIcon,
                                    { backgroundColor: action.color + "1A" },
                                  ]}
                                >
                                  <Ionicons
                                    name={action.icon}
                                    size={20}
                                    color={action.color}
                                  />
                                </View>
                                <Text style={styles.actionLabel}>{action.label}</Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              );
            })
          )}

          {/* ── College-level actions (not semester-specific) ─────────────── */}
          <Text style={styles.sectionLabel}>College-Wide</Text>

          {/* Academic Calendar */}
          {(isHOD || delegatedKeys.includes("academic_calendar")) && (
            <TouchableOpacity
              style={styles.wideCard}
              onPress={() =>
                navigation.navigate("AcademicCalendarManager", {
                  teacher_id: uid,
                  role,
                })
              }
              activeOpacity={0.82}
            >
              <View style={[styles.wideIcon, { backgroundColor: "#8B5CF618" }]}>
                <Ionicons name="calendar-number" size={22} color="#8B5CF6" />
              </View>
              <View style={styles.wideText}>
                <Text style={styles.wideTitle}>Academic Calendar</Text>
                <Text style={styles.wideSub}>Tests, holidays & important events</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={GREY} />
            </TouchableOpacity>
          )}

          {/* Delegate Rights — HOD only */}
          {isHOD && (
            <TouchableOpacity
              style={styles.wideCard}
              onPress={() =>
                navigation.navigate("DelegateRightsScreen", {
                  teacher_id: uid,
                  role,
                })
              }
              activeOpacity={0.82}
            >
              <View style={[styles.wideIcon, { backgroundColor: "#0EA5E918" }]}>
                <Ionicons name="shield-checkmark" size={22} color="#0EA5E9" />
              </View>
              <View style={styles.wideText}>
                <Text style={styles.wideTitle}>Delegate Rights</Text>
                <Text style={styles.wideSub}>Grant access to Head Teachers</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={GREY} />
            </TouchableOpacity>
          )}

          <View style={{ height: 100 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },

  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  title: { fontSize: 28, fontWeight: "800", color: "#111827" },
  subtitle: { fontSize: 14, color: GREY, marginTop: 4 },

  roleBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  hodBadge: { backgroundColor: PRIMARY + "18" },
  htBadge: { backgroundColor: "#10B98118" },
  roleBadgeText: { fontWeight: "700", fontSize: 12 },
  hodBadgeText: { color: PRIMARY },
  htBadgeText: { color: "#10B981" },

  scroll: { paddingHorizontal: 16, paddingTop: 4 },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  // ── Course blocks ──────────────────────────────────────────────────────
  courseBlock: {
    backgroundColor: "#FFF",
    borderRadius: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    overflow: "hidden",
    elevation: 2,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 6,
  },
  courseHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
  },
  courseHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  courseAbbrBadge: {
    backgroundColor: PRIMARY + "18",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 48,
    alignItems: "center",
  },
  courseAbbrText: { fontSize: 13, fontWeight: "800", color: PRIMARY },
  courseName: { fontSize: 15, fontWeight: "700", color: "#111827" },
  courseMeta: { fontSize: 12, color: GREY, marginTop: 2 },

  // ── Semester blocks ────────────────────────────────────────────────────
  semestersContainer: {
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
  },
  semBlock: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  semHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  semNumBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
  },
  semNumText: { fontSize: 13, fontWeight: "800", color: "#374151" },
  semLabel: { fontSize: 14, fontWeight: "700", color: "#374151" },

  // ── Action grid ────────────────────────────────────────────────────────
  actionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  actionBtn: {
    alignItems: "center",
    width: "18%",
    minWidth: 56,
  },
  actionIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  actionLabel: {
    fontSize: 10,
    fontWeight: "600",
    color: "#374151",
    textAlign: "center",
  },

  // ── College-wide cards ─────────────────────────────────────────────────
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: GREY,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 10,
  },
  wideCard: {
    backgroundColor: "#FFF",
    borderRadius: 16,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 14,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    elevation: 2,
  },
  wideIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  wideText: { flex: 1 },
  wideTitle: { fontSize: 15, fontWeight: "700", color: "#111827" },
  wideSub: { fontSize: 12, color: GREY, marginTop: 2 },

  // ── Empty ──────────────────────────────────────────────────────────────
  empty: { alignItems: "center", paddingTop: 80, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: "#111827", marginTop: 4 },
  emptyText: { fontSize: 14, color: GREY, textAlign: "center", paddingHorizontal: 20 },
});