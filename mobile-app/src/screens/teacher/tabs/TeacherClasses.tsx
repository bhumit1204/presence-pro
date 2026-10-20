// src/screens/teacher/tabs/TeacherClasses.tsx
// Every subject the teacher teaches, grouped by course. Tapping one opens SubjectHub, the single place for
// attendance, classwork, quizzes, students, reports and OD of that subject.
import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useOnTabActive } from "../../../navigation/TabContext";
import { Banner, Button, EmptyState, TextField, T, SP, font } from "../../../components/ui";
import { ListCard, ListRow, Subject, enc, getJson, groupCourses, useTeacher } from "../teacherShared";

export default function TeacherClasses() {
  const navigation = useNavigation<any>();
  const teacher = useTeacher();
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      const j = await getJson(`/api/lectures/teachers/subjects?teacher_id=${enc(teacher.teacherId)}`);
      setSubjects(j.subjects || []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Could not load your subjects.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [teacher.teacherId]);

  useOnTabActive("classes", () => {
    load();
  });

  const courses = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = query ? subjects.filter((s) => `${s.subject_name} ${s.subject_code} ${s.course_name}`.toLowerCase().includes(query)) : subjects;
    return groupCourses(list);
  }, [subjects, q]);

  const open = (subject: Subject, courseId: string, courseName: string) =>
    navigation.navigate("SubjectHub", {
      subject,
      course: { course_id: courseId, course_name: courseName },
      teacher_id: teacher.teacherId,
    });

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: T.bg }}
      contentContainerStyle={{ paddingHorizontal: SP.xl, paddingTop: SP.xxl + 24, paddingBottom: 140 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={T.primary} />}
    >
      <Text style={font.h1}>Classes</Text>
      <View style={{ height: SP.xl }} />

      {loading ? (
        <ActivityIndicator color={T.primary} style={{ marginTop: SP.xxl }} />
      ) : error && subjects.length === 0 ? (
        <View style={{ gap: SP.sm }}>
          <Banner tone="danger">{error}</Banner>
          <Button label="Try again" icon="refresh" variant="secondary" size="md" onPress={() => { setLoading(true); load(); }} />
        </View>
      ) : subjects.length === 0 ? (
        <EmptyState icon="book-outline" title="No subjects yet" />
      ) : (
        <>
          {subjects.length > 5 && <TextField value={q} onChangeText={setQ} placeholder="Search subject or code" icon="search" style={{ marginBottom: SP.xl }} />}
          {courses.length === 0 && <EmptyState icon="search" title="No match" />}
          {courses.map((c) => (
            <View key={c.course_id || c.course_name} style={{ marginBottom: SP.xxl }}>
              <Text style={[font.label, { marginBottom: SP.md }]}>{c.course_name}</Text>
              <ListCard>
                {c.subjects.map((s) => (
                  <ListRow key={s.subject_id} title={s.subject_name} sub={s.subject_code} onPress={() => open(s, c.course_id, c.course_name)} />
                ))}
              </ListCard>
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}