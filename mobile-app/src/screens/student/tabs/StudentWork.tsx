import { apiFetch, API_BASE } from "../../../services/api";
import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from "react-native";
import { useNavigation, useFocusEffect } from "@react-navigation/native";
import { auth } from "../../../services/firebase";
import { Ionicons } from "@expo/vector-icons";
import { Button, Card, Chip, EmptyState, Screen, SP, T, Tone, font } from "../../../components/ui";

const API_URL = API_BASE;
const COLORS: { fg: string; bg: string }[] = [
  { fg: T.primary, bg: T.primarySoft },
  { fg: T.success, bg: T.successSoft },
  { fg: T.warning, bg: T.warningSoft },
  { fg: T.danger,  bg: T.dangerSoft  },
  { fg: "#7C3AED",  bg: "#EDE9FE"    },
  { fg: "#DB2777",  bg: "#FCE7F3"    },
  { fg: "#0891B2",  bg: "#CFFAFE"    },
  { fg: "#65A30D",  bg: "#ECFCCB"    },
];

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
    apiFetch(`${API_URL}/api/assignments?subject_id=${subject_id}&course_id=${course_id}`),
    apiFetch(`${API_URL}/api/assignments/announcements?subject_id=${subject_id}&course_id=${course_id}`),
    apiFetch(`${API_URL}/api/assignments/my-submissions?student_uid=${uid}&subject_id=${subject_id}`),
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

      const subjectsRes = await apiFetch(`${API_URL}/api/lectures/student/subjects?uid=${uid}`);
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
    <Screen edges={["top"]}>
      <View style={S.header}>
        <Text style={font.display}>Classwork</Text>
        <Text style={[font.body, { marginTop: 2 }]}>Your assignments and announcements</Text>
      </View>

      <ScrollView
        contentContainerStyle={S.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchSubjects(true); }}
            colors={[T.primary]}
          />
        }
      >
        {loading ? (
          <View style={S.center}>
            <ActivityIndicator size="large" color={T.primary} />
            <Text style={font.small}>Loading subjects</Text>
          </View>
        ) : error ? (
          <View style={S.errorBox}>
            <EmptyState icon="alert-circle-outline" title="Couldn't load subjects" text={error} />
            <Button label="Try again" icon="refresh" size="md" onPress={() => fetchSubjects()} style={{ alignSelf: "center", paddingHorizontal: 28 }} />
          </View>
        ) : courseGroups.length === 0 ? (
          <EmptyState icon="library-outline" title="No subjects enrolled" text="You haven't been enrolled in any subjects yet." />
        ) : (
          courseGroups.map((course, ci) => {
            const expanded    = expandedCourses.has(course.course_id);
            const courseColor = COLORS[ci % COLORS.length];

            // Aggregate badges across all subjects in this course
            const coursePending  = course.subjects.reduce((n, s) => n + (badges[s.subject_id]?.pendingCount  || 0), 0);
            const courseMissing  = course.subjects.reduce((n, s) => n + (badges[s.subject_id]?.missingCount  || 0), 0);
            const courseHasNew   = course.subjects.some((s) => badges[s.subject_id]?.hasNewAnnouncement);

            return (
              <View key={course.course_id} style={S.courseSection}>

                {/* Course header */}
                <TouchableOpacity onPress={() => toggleCourse(course.course_id)} activeOpacity={0.82}>
                  <Card style={S.courseHeader}>
                    <View style={[S.courseAvatar, { backgroundColor: courseColor.bg }]}>
                      <Text style={[S.courseAvatarText, { color: courseColor.fg }]}>
                        {course.course_name.charAt(0)}
                      </Text>
                    </View>

                    <View style={{ flex: 1 }}>
                      <Text style={font.h3} numberOfLines={1}>{course.course_name}</Text>
                      <Text style={font.small}>
                        {course.subjects.length} subject{course.subjects.length !== 1 ? "s" : ""}
                      </Text>
                    </View>

                    {!expanded && !badgesLoading && (
                      <View style={S.courseBadgeRow}>
                        {courseMissing > 0 && <Chip label={`${courseMissing} missing`} tone="danger" />}
                        {coursePending > 0 && <Chip label={`${coursePending} due`} tone="warning" />}
                        {courseHasNew && coursePending === 0 && courseMissing === 0 && <Chip label="new" tone="primary" />}
                      </View>
                    )}

                    <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={T.muted} />
                  </Card>
                </TouchableOpacity>

                {/* Subject rows */}
                {expanded && (
                  <View style={S.subjectList}>
                    {course.subjects.map((sub) => {
                      const subColor = COLORS[globalIdx++ % COLORS.length];
                      const badge    = badges[sub.subject_id];

                      const hasMissing  = (badge?.missingCount  || 0) > 0;
                      const hasPending  = (badge?.pendingCount   || 0) > 0;
                      const hasNew      = badge?.hasNewAnnouncement ?? false;
                      const showBadge   = !badgesLoading && (hasMissing || hasPending || hasNew);

                      return (
                        <TouchableOpacity
                          key={sub.subject_id}
                          onPress={() => navigation.navigate("StudentSubjectFeed", {
                            subject: sub, course, student_uid: studentUid,
                          })}
                          activeOpacity={0.82}
                        >
                          <Card flat padded={false} style={S.subjectRow}>
                            <View style={[S.subDot, { backgroundColor: subColor.bg }]}>
                              <Text style={[S.subDotText, { color: subColor.fg }]}>
                                {sub.subject_name.charAt(0)}
                              </Text>
                            </View>

                            <View style={{ flex: 1 }}>
                              <Text style={font.h3} numberOfLines={2}>{sub.subject_name}</Text>

                              {showBadge && (
                                <View style={S.pillRow}>
                                  {hasMissing && <Chip label={`${badge!.missingCount} missing`} tone="danger" />}
                                  {hasPending && <Chip label={`${badge!.pendingCount} pending`} tone="warning" />}
                                  {hasNew && !hasMissing && !hasPending && <Chip label="new post" tone="primary" />}
                                </View>
                              )}

                              {badgesLoading && (
                                <ActivityIndicator size="small" color={T.muted} style={{ marginTop: 4, alignSelf: "flex-start" }} />
                              )}
                            </View>

                            <Ionicons name="chevron-forward" size={16} color={T.muted} />
                          </Card>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })
        )}
        <View style={{ height: 120 }} />
      </ScrollView>
    </Screen>
  );
}

const S = StyleSheet.create({
  header: { paddingHorizontal: SP.xl, paddingTop: SP.lg, marginBottom: SP.md },
  list:   { paddingHorizontal: SP.xl, paddingTop: SP.xs },

  center:   { paddingTop: 80, alignItems: "center", gap: SP.md },
  errorBox: { paddingTop: 30, gap: SP.sm },

  courseSection: { marginBottom: SP.md },
  courseHeader:  { flexDirection: "row", alignItems: "center", gap: SP.md, padding: SP.md },
  courseAvatar:  { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  courseAvatarText: { fontSize: 18, fontWeight: "800" },
  courseBadgeRow: { flexDirection: "row", gap: 5, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 120 },

  subjectList: { marginTop: SP.sm, marginLeft: SP.lg, gap: SP.sm },
  subjectRow:  { flexDirection: "row", alignItems: "center", gap: SP.md, paddingVertical: SP.md, paddingHorizontal: SP.md },
  subDot:      { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  subDotText:  { fontSize: 15, fontWeight: "800" },
  pillRow:     { flexDirection: "row", gap: 5, marginTop: 5, flexWrap: "wrap" },
});