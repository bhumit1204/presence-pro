import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import { auth } from "../../../services/firebase";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY   = "#4834D4";
const BG        = "#F3F4F6";
const GREY      = "#6B7280";
const RED       = "#EF4444";
const AMBER     = "#F59E0B";
const API_URL   = "http://10.132.90.56:5000";
const COLORS    = ["#4834D4","#10B981","#F59E0B","#EF4444","#8B5CF6","#EC4899","#06B6D4","#84CC16"];

interface Subject {
  subject_id:   string;
  subject_name: string;
  course_id:    string;
  course_name:  string;
}

interface CourseGroup {
  course_id:   string;
  course_name: string;
  subjects:    Subject[];
}

// Per-subject badge info derived from assignments + announcements
interface SubjectBadge {
  pendingCount:      number;  // unsubmitted, not past due
  missingCount:      number;  // unsubmitted, past due
  hasNewAnnouncement: boolean;
}

// ─── Fetch badge data for a single subject ────────────────────────
async function fetchSubjectBadge(
  subject_id: string,
  course_id:  string,
  uid:        string
): Promise<SubjectBadge> {
  const [assignRes, announceRes, subRes] = await Promise.all([
    fetch(`${API_URL}/api/assignments?subject_id=${subject_id}&course_id=${course_id}`),
    fetch(`${API_URL}/api/assignments/announcements?subject_id=${subject_id}&course_id=${course_id}`),
    fetch(`${API_URL}/api/assignments/my-submissions?student_uid=${uid}&subject_id=${subject_id}`),
  ]);

  const [assignData, announceData, subData] = await Promise.all([
    assignRes.json(),
    announceRes.json(),
    subRes.json(),
  ]);

  const assignments:    any[] = assignData.assignments    || [];
  const announcements:  any[] = announceData.announcements || [];
  const submissions:    any[] = subData.submissions        || [];

  const submittedIds = new Set(submissions.map((s: any) => s.assignment_id));
  const now = new Date();

  let pendingCount = 0;
  let missingCount = 0;

  for (const a of assignments) {
    if (submittedIds.has(a.assignment_id)) continue;
    const past = a.due_date && new Date(a.due_date) < now;
    if (past) {
      // Only count as "missing" if late not allowed
      if (!a.allow_late) missingCount++;
      else pendingCount++;       // allow_late = still actionable
    } else {
      pendingCount++;
    }
  }

  // "New" announcement = posted in the last 3 days
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const hasNewAnnouncement = announcements.some(
    (a: any) => a.created_at && new Date(a.created_at) > threeDaysAgo
  );

  return { pendingCount, missingCount, hasNewAnnouncement };
}

export default function StudentWork() {
  const navigation = useNavigation<any>();

  const [courseGroups,    setCourseGroups]    = useState<CourseGroup[]>([]);
  const [badges,          setBadges]          = useState<Record<string, SubjectBadge>>({});
  const [loading,         setLoading]         = useState(true);
  const [badgesLoading,   setBadgesLoading]   = useState(false);
  const [refreshing,      setRefreshing]      = useState(false);
  const [expandedCourses, setExpandedCourses] = useState<Set<string>>(new Set());
  const [error,           setError]           = useState<string | null>(null);

  const fetchSubjects = useCallback(async (silent = false) => {
    try {
      if (!silent) { setLoading(true); setError(null); }
      const uid = auth.currentUser?.uid;
      if (!uid) { setError("Not logged in"); return; }

      const subjectsRes = await fetch(`${API_URL}/api/lectures/student/subjects?uid=${uid}`);
      let subjects: Subject[] = [];

      if (subjectsRes.ok) {
        const subjectsData = await subjectsRes.json();
        if (subjectsData.success) {
          subjects = subjectsData.subjects || [];
        } else {
          throw new Error(subjectsData.error || "Failed to load subjects");
        }
      } else {
        throw new Error("Could not reach subjects endpoint.");
      }

      // Group by course
      const map: Record<string, CourseGroup> = {};
      subjects.forEach((s) => {
        if (!map[s.course_id]) {
          map[s.course_id] = {
            course_id:   s.course_id,
            course_name: s.course_name || "Unknown Course",
            subjects:    [],
          };
        }
        map[s.course_id].subjects.push(s);
      });

      const groups = Object.values(map);
      setCourseGroups(groups);
      if (groups.length === 1) setExpandedCourses(new Set([groups[0].course_id]));

      // Fetch badge data for all subjects in parallel (non-blocking)
      if (subjects.length > 0) {
        setBadgesLoading(true);
        const badgeEntries = await Promise.allSettled(
          subjects.map((s) => fetchSubjectBadge(s.subject_id, s.course_id, uid))
        );
        const newBadges: Record<string, SubjectBadge> = {};
        subjects.forEach((s, i) => {
          const result = badgeEntries[i];
          if (result.status === "fulfilled") {
            newBadges[s.subject_id] = result.value;
          }
        });
        setBadges(newBadges);
        setBadgesLoading(false);
      }
    } catch (e: any) {
      setError(e.message || "Failed to load");
    } finally {
      if (!silent) setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchSubjects(); }, [fetchSubjects]));

  const toggleCourse = (id: string) =>
    setExpandedCourses((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  let globalIdx  = 0;
  const studentUid = auth.currentUser?.uid;

  return (
    <SafeAreaView style={S.safe}>
      <View style={S.header}>
        <Text style={S.title}>Classwork</Text>
        <Text style={S.subtitle}>Your assignments &amp; announcements</Text>
      </View>

      <ScrollView
        contentContainerStyle={S.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchSubjects(true); }}
            colors={[PRIMARY]}
          />
        }
      >
        {loading ? (
          <View style={S.center}>
            <ActivityIndicator size="large" color={PRIMARY} />
            <Text style={S.loadingText}>Loading subjects…</Text>
          </View>
        ) : error ? (
          <View style={S.errorBox}>
            <Ionicons name="alert-circle-outline" size={36} color="#DC2626" />
            <Text style={S.errorTitle}>Couldn't load subjects</Text>
            <Text style={S.errorMsg}>{error}</Text>
            <TouchableOpacity style={S.retryBtn} onPress={() => fetchSubjects()}>
              <Text style={S.retryText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        ) : courseGroups.length === 0 ? (
          <View style={S.empty}>
            <Ionicons name="library-outline" size={52} color={GREY} />
            <Text style={S.emptyTitle}>No subjects enrolled</Text>
            <Text style={S.emptyText}>You haven't been enrolled in any subjects yet.</Text>
          </View>
        ) : (
          courseGroups.map((course, ci) => {
            const expanded   = expandedCourses.has(course.course_id);
            const courseColor = COLORS[ci % COLORS.length];

            // Aggregate badges across all subjects in this course
            const coursePending  = course.subjects.reduce((n, s) => n + (badges[s.subject_id]?.pendingCount  || 0), 0);
            const courseMissing  = course.subjects.reduce((n, s) => n + (badges[s.subject_id]?.missingCount  || 0), 0);
            const courseHasNew   = course.subjects.some((s) => badges[s.subject_id]?.hasNewAnnouncement);

            return (
              <View key={course.course_id} style={S.courseSection}>

                {/* ── Course header ── */}
                <TouchableOpacity
                  style={[S.courseHeader, { borderLeftColor: courseColor }]}
                  onPress={() => toggleCourse(course.course_id)}
                  activeOpacity={0.82}
                >
                  <View style={[S.courseAvatar, { backgroundColor: courseColor + "1A" }]}>
                    <Text style={[S.courseAvatarText, { color: courseColor }]}>
                      {course.course_name.charAt(0)}
                    </Text>
                  </View>

                  <View style={S.courseInfo}>
                    <Text style={S.courseName} numberOfLines={1}>{course.course_name}</Text>
                    <Text style={S.courseSubCount}>
                      {course.subjects.length} subject{course.subjects.length !== 1 ? "s" : ""}
                    </Text>
                  </View>

                  {/* Course-level badge summary (shown when collapsed) */}
                  {!expanded && !badgesLoading && (
                    <View style={S.courseBadgeRow}>
                      {courseMissing > 0 && (
                        <View style={[S.courseBadge, { backgroundColor: "#FEF2F2" }]}>
                          <View style={[S.badgeDot, { backgroundColor: RED }]} />
                          <Text style={[S.courseBadgeText, { color: RED }]}>{courseMissing} missing</Text>
                        </View>
                      )}
                      {coursePending > 0 && (
                        <View style={[S.courseBadge, { backgroundColor: "#FFFBEB" }]}>
                          <View style={[S.badgeDot, { backgroundColor: AMBER }]} />
                          <Text style={[S.courseBadgeText, { color: AMBER }]}>{coursePending} due</Text>
                        </View>
                      )}
                      {courseHasNew && coursePending === 0 && courseMissing === 0 && (
                        <View style={[S.courseBadge, { backgroundColor: "#EEF2FF" }]}>
                          <View style={[S.badgeDot, { backgroundColor: PRIMARY }]} />
                          <Text style={[S.courseBadgeText, { color: PRIMARY }]}>new</Text>
                        </View>
                      )}
                    </View>
                  )}

                  <Ionicons
                    name={expanded ? "chevron-up" : "chevron-down"}
                    size={18}
                    color={courseColor}
                  />
                </TouchableOpacity>

                {/* ── Subject rows ── */}
                {expanded && course.subjects.map((sub) => {
                  const subColor = COLORS[globalIdx++ % COLORS.length];
                  const badge    = badges[sub.subject_id];

                  const hasMissing  = (badge?.missingCount  || 0) > 0;
                  const hasPending  = (badge?.pendingCount   || 0) > 0;
                  const hasNew      = badge?.hasNewAnnouncement ?? false;
                  const showBadge   = !badgesLoading && (hasMissing || hasPending || hasNew);

                  return (
                    <TouchableOpacity
                      key={sub.subject_id}
                      style={S.subjectRow}
                      onPress={() => navigation.navigate("StudentSubjectFeed", {
                        subject: sub, course, student_uid: studentUid,
                      })}
                      activeOpacity={0.82}
                    >
                      {/* Left avatar */}
                      <View style={[S.subDot, { backgroundColor: subColor + "20", borderColor: subColor }]}>
                        <Text style={[S.subDotText, { color: subColor }]}>
                          {sub.subject_name.charAt(0)}
                        </Text>
                      </View>

                      {/* Name + badge pills */}
                      <View style={S.subjectMeta}>
                        <Text style={S.subjectName} numberOfLines={2}>{sub.subject_name}</Text>

                        {showBadge && (
                          <View style={S.pillRow}>
                            {hasMissing && (
                              <View style={[S.pill, S.pillRed]}>
                                <Text style={[S.pillText, { color: RED }]}>
                                  {badge!.missingCount} missing
                                </Text>
                              </View>
                            )}
                            {hasPending && (
                              <View style={[S.pill, S.pillAmber]}>
                                <Text style={[S.pillText, { color: AMBER }]}>
                                  {badge!.pendingCount} pending
                                </Text>
                              </View>
                            )}
                            {hasNew && !hasMissing && !hasPending && (
                              <View style={[S.pill, S.pillPrimary]}>
                                <Text style={[S.pillText, { color: PRIMARY }]}>new post</Text>
                              </View>
                            )}
                          </View>
                        )}

                        {badgesLoading && (
                          <ActivityIndicator size="small" color={GREY} style={{ marginTop: 4 }} />
                        )}
                      </View>

                      {/* Indicator dot + chevron */}
                      <View style={S.subjectRight}>
                        {showBadge && (
                          <View style={[
                            S.indicatorDot,
                            { backgroundColor: hasMissing ? RED : hasPending ? AMBER : PRIMARY },
                          ]} />
                        )}
                        <Ionicons name="chevron-forward" size={15} color={GREY} />
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            );
          })
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: BG },
  header: { paddingHorizontal: 20, paddingTop: 16, marginBottom: 10 },
  title:  { fontSize: 28, fontWeight: "800", color: "#111827" },
  subtitle: { fontSize: 14, color: GREY, marginTop: 4 },
  list:   { paddingHorizontal: 20, paddingTop: 4 },

  // ── Course ─────────────────────────────────────────────────────
  courseSection: { marginBottom: 12 },
  courseHeader: {
    backgroundColor: "#FFF", borderRadius: 16, padding: 14,
    flexDirection: "row", alignItems: "center", gap: 12,
    borderWidth: 1, borderColor: "#E5E7EB", borderLeftWidth: 3,
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 6, elevation: 2,
  },
  courseAvatar: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  courseAvatarText: { fontSize: 18, fontWeight: "800" },
  courseInfo: { flex: 1 },
  courseName: { fontSize: 15, fontWeight: "700", color: "#111827" },
  courseSubCount: { fontSize: 12, color: GREY, marginTop: 2 },

  courseBadgeRow: { flexDirection: "row", gap: 5, flexWrap: "wrap", alignItems: "center", marginRight: 4 },
  courseBadge: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  courseBadgeText: { fontSize: 11, fontWeight: "700" },
  badgeDot: { width: 5, height: 5, borderRadius: 3 },

  // ── Subject row ────────────────────────────────────────────────
  subjectRow: {
    backgroundColor: "#FFF",
    marginTop: 3,
    marginLeft: 14,
    borderRadius: 13,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    shadowColor: "#000",
    shadowOpacity: 0.02,
    shadowRadius: 3,
    elevation: 1,
  },
  subDot: {
    width: 38, height: 38, borderRadius: 11,
    alignItems: "center", justifyContent: "center", borderWidth: 1.5,
    flexShrink: 0,
  },
  subDotText: { fontSize: 14, fontWeight: "800" },

  subjectMeta: { flex: 1 },
  subjectName: { fontSize: 14, fontWeight: "600", color: "#111827", lineHeight: 20 },

  // Pill badges inside subject row
  pillRow: { flexDirection: "row", gap: 5, marginTop: 5, flexWrap: "wrap" },
  pill: { borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 },
  pillRed:     { backgroundColor: "#FEF2F2" },
  pillAmber:   { backgroundColor: "#FFFBEB" },
  pillPrimary: { backgroundColor: "#EEF2FF" },
  pillText: { fontSize: 11, fontWeight: "700" },

  // Right side: dot + chevron
  subjectRight: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  indicatorDot: { width: 8, height: 8, borderRadius: 4 },

  // ── States ─────────────────────────────────────────────────────
  center: { paddingTop: 80, alignItems: "center", gap: 12 },
  loadingText: { fontSize: 14, color: GREY },

  errorBox: { alignItems: "center", paddingTop: 60, gap: 10 },
  errorTitle: { fontSize: 17, fontWeight: "700", color: "#111827" },
  errorMsg: { fontSize: 13, color: GREY, textAlign: "center", paddingHorizontal: 20 },
  retryBtn: { backgroundColor: PRIMARY, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 10, marginTop: 6 },
  retryText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  empty: { alignItems: "center", paddingTop: 80, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: "#111827", marginTop: 6 },
  emptyText: { fontSize: 14, color: GREY, textAlign: "center" },
});