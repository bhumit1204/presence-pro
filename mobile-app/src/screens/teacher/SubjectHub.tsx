// src/screens/teacher/SubjectHub.tsx
// One place per subject. Replaces the old "pick a subject at the top of every tab" pattern:
// open a subject once, then everything (attendance, classwork, quizzes, students, reports, OD) is one tap away.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import {
  Avatar, Banner, Button, Card, Chip, EmptyState, Header, Screen, SectionLabel, Segmented, Stat, TextField, T, TONE, Tone, SP, font,
} from "../../components/ui";
import { enc, getJson, useDebounced } from "./teacherShared";

type Section = "overview" | "quizzes" | "students";
type IconName = React.ComponentProps<typeof Ionicons>["name"];

const quizState = (q: any): "scheduled" | "live" | "done" => {
  const now = Date.now();
  if (now < new Date(q.scheduled_start).getTime()) return "scheduled";
  if (now <= new Date(q.scheduled_end).getTime()) return "live";
  return "done";
};
const QUIZ_TONE: Record<string, Tone> = { scheduled: "info", live: "success", done: "neutral" };

function Tile({ icon, tone, title, text, onPress, badge }: { icon: IconName; tone: Tone; title: string; text: string; onPress: () => void; badge?: number }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}. ${text}`}>
      {({ pressed }) => (
        <Card style={pressed ? { opacity: 0.75 } : undefined}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md }}>
            <View style={{ width: 48, height: 48, borderRadius: 15, backgroundColor: TONE[tone].bg, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name={icon} size={24} color={TONE[tone].fg} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={font.h3}>{title}</Text>
                {!!badge && <Chip label={`${badge} new`} tone="warning" />}
              </View>
              <Text style={font.small}>{text}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={T.muted} />
          </View>
        </Card>
      )}
    </Pressable>
  );
}

export default function SubjectHub() {
  const navigation = useNavigation<any>();
  const { subject, course, teacher_id } = useRoute<any>().params ?? {};
  const subjectId: string = subject?.subject_id || "";

  const [section, setSection] = useState<Section>("overview");
  const [quizzes, setQuizzes] = useState<any[]>([]);
  const [quizLoading, setQuizLoading] = useState(true);
  const [quizError, setQuizError] = useState<string | null>(null);
  const [odPending, setOdPending] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  /* students */
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 400);
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchId = useRef(0);
  const [scanner, setScanner] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [perm, askPerm] = useCameraPermissions();

  const loadQuizzes = useCallback(async () => {
    try {
      const j = await getJson(`/api/quizzes/teacher/${enc(teacher_id)}`);
      setQuizzes((j.quizzes || []).filter((q: any) => (q.subject_id ? q.subject_id === subjectId : q.subject_name === subject?.subject_name)));
      setQuizError(null);
    } catch (e: any) {
      setQuizError(e?.message || "Could not load quizzes.");
    } finally {
      setQuizLoading(false);
    }
  }, [teacher_id, subjectId, subject?.subject_name]);

  const loadOd = useCallback(async () => {
    try {
      const j = await getJson(`/api/od/teacher/${enc(teacher_id)}?subject_id=${enc(subjectId)}&status=pending`);
      setOdPending(j.summary?.pending ?? 0);
    } catch {}
  }, [teacher_id, subjectId]);

  useFocusEffect(
    useCallback(() => {
      loadQuizzes();
      loadOd();
    }, [loadQuizzes, loadOd])
  );

  /* debounced student search */
  useEffect(() => {
    const text = debounced.trim();
    if (!text) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const my = ++searchId.current;
    setSearching(true);
    getJson(`/api/reports/students/search?teacher_id=${enc(teacher_id)}&subject_id=${enc(subjectId)}&query=${enc(text)}`)
      .then((j) => {
        if (my !== searchId.current) return;
        setResults(j.students || []);
        setSearchError(null);
      })
      .catch((e) => my === searchId.current && setSearchError(e?.message || "Search failed."))
      .finally(() => my === searchId.current && setSearching(false));
  }, [debounced, teacher_id, subjectId]);

  const openStudent = (student: any) => navigation.navigate("StudentReportDetail", { student, subject, teacher_id });

  const onScan = async ({ data }: { data: string }) => {
    if (scanBusy) return;
    setScanBusy(true);
    try {
      const payload = JSON.parse(data);
      if (payload.type !== "student_id" || !payload.uid) {
        Alert.alert("Not a student ID", "This QR code is not a student ID card.");
        return;
      }
      const j = await getJson(`/api/reports/students/by-qr?uid=${enc(payload.uid)}&teacher_id=${enc(teacher_id)}&subject_id=${enc(subjectId)}`);
      setScanner(false);
      openStudent(j.student);
    } catch (e: any) {
      setScanner(false);
      Alert.alert("Not found", e?.message?.includes("JSON") ? "Could not read that QR code." : e?.message || "Student not found in this subject.");
    } finally {
      setTimeout(() => setScanBusy(false), 1500);
    }
  };

  const openScanner = async () => {
    if (!perm?.granted) {
      const r = await askPerm();
      if (!r.granted) {
        Alert.alert("Camera needed", "Allow camera access in Settings to scan student QR codes.");
        return;
      }
    }
    setScanBusy(false);
    setScanner(true);
  };

  if (!subject) {
    return (
      <Screen>
        <Header title="Subject" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Subject missing" text="Go back and open a subject from the Classes tab." />
      </Screen>
    );
  }

  const go = (screen: string, extra: any = {}) => navigation.navigate(screen, { subject, course, teacher_id, ...extra });
  const live = quizzes.filter((q) => quizState(q) === "live").length;

  return (
    <Screen>
      <Header title={subject.subject_name} subtitle={[subject.subject_code, course?.course_name].filter(Boolean).join("  |  ")} onBack={() => navigation.goBack()} />
      <View style={{ paddingHorizontal: SP.lg, paddingTop: SP.md }}>
        <Segmented<Section>
          value={section}
          onChange={setSection}
          options={[
            { value: "overview", label: "Overview", icon: "grid-outline" },
            { value: "quizzes", label: `Quizzes${quizzes.length ? ` (${quizzes.length})` : ""}`, icon: "flash-outline" },
            { value: "students", label: "Students", icon: "people-outline" },
          ]}
        />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: SP.lg, paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await Promise.all([loadQuizzes(), loadOd()]); setRefreshing(false); }} tintColor={T.primary} />}
      >
        {section === "overview" && (
          <View style={{ gap: SP.sm }}>
            {live > 0 && (
              <Banner tone="success" icon="flash" title={`${live} quiz${live === 1 ? " is" : "zes are"} live`}>
                Open the Quizzes tab to see the join code.
              </Banner>
            )}
            <SectionLabel>Every day</SectionLabel>
            <Tile icon="checkbox-outline" tone="success" title="Attendance register" text="See and fix attendance, week by week" onPress={() => go("MarkAttendance")} />
            <Tile icon="newspaper-outline" tone="primary" title="Classwork" text="Announcements and assignments" onPress={() => go("TeacherSubjectFeed")} />
            <Tile
              icon="document-text-outline"
              tone="warning"
              title="OD requests"
              text="Approve or reject student on-duty leave"
              badge={odPending}
              onPress={() => navigation.navigate("ODRequestsTeacher", { teacherId: teacher_id, subjectId, subjectName: subject.subject_name, courseId: subject.course_id || "" })}
            />
            <SectionLabel style={{ marginTop: SP.md }}>Tests and insight</SectionLabel>
            <Tile icon="flash-outline" tone="info" title="Quizzes" text="Create a test or see results" onPress={() => setSection("quizzes")} />
            <Tile icon="stats-chart" tone="primary" title="Class report" text="Attendance, quiz and assignment stats for everyone" onPress={() => go("ClassReport")} />
            <Tile icon="search-outline" tone="neutral" title="Find a student" text="Search by name or scan their ID QR" onPress={() => setSection("students")} />
          </View>
        )}

        {section === "quizzes" && (
          <View style={{ gap: SP.sm }}>
            <View style={{ flexDirection: "row", gap: SP.sm }}>
              <Button label="With AI" icon="sparkles" size="md" style={{ flex: 1 }} onPress={() => navigation.navigate("CreateQuizAI", { subject })} />
              <Button label="Manually" icon="create-outline" variant="secondary" size="md" style={{ flex: 1 }} onPress={() => navigation.navigate("CreateQuizManual", { subject })} />
            </View>
            <SectionLabel style={{ marginTop: SP.md }}>Your tests for this subject</SectionLabel>
            {quizLoading ? (
              <ActivityIndicator color={T.primary} style={{ marginTop: SP.xl }} />
            ) : quizError ? (
              <>
                <Banner tone="danger">{quizError}</Banner>
                <Button label="Try again" variant="secondary" size="md" icon="refresh" onPress={() => { setQuizLoading(true); loadQuizzes(); }} />
              </>
            ) : quizzes.length === 0 ? (
              <EmptyState icon="flash-outline" title="No tests yet" text="Create one with AI in under a minute, or build it by hand." />
            ) : (
              quizzes.map((q) => {
                const st = quizState(q);
                return (
                  <Pressable key={q.quiz_id} onPress={() => navigation.navigate("ViewQuizScreen", { quiz_id: q.quiz_id })} accessibilityRole="button">
                    <Card>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: SP.sm }}>
                        <Text style={[font.h3, { flex: 1 }]} numberOfLines={2}>{q.title}</Text>
                        <Chip label={st === "done" ? "Completed" : st === "live" ? "Live" : "Scheduled"} tone={QUIZ_TONE[st]} />
                      </View>
                      <Text style={[font.small, { marginTop: 4 }]}>
                        {new Date(q.scheduled_start).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </Text>
                      <View style={{ flexDirection: "row", gap: SP.md, marginTop: SP.sm, alignItems: "center" }}>
                        <Text style={font.small}>{q.question_count} questions</Text>
                        <Text style={font.small}>{q.total_marks} marks</Text>
                        <View style={{ flex: 1 }} />
                        <Text style={{ fontSize: 12, fontWeight: "800", color: T.primary, letterSpacing: 1 }}>{q.join_code}</Text>
                      </View>
                    </Card>
                  </Pressable>
                );
              })
            )}
          </View>
        )}

        {section === "students" && (
          <View style={{ gap: SP.md }}>
            <TextField value={query} onChangeText={setQuery} placeholder="Name, roll number or email" icon="search" autoCorrect={false} />
            <Button label="Scan a student ID" icon="scan-outline" variant="secondary" size="md" onPress={openScanner} />
            {searching && <ActivityIndicator color={T.primary} />}
            {!!searchError && <Banner tone="danger">{searchError}</Banner>}
            {!query.trim() && !searching && <EmptyState icon="people-outline" title="Look up a student" text="See attendance, quiz and assignment history for anyone enrolled in this subject." />}
            {results.map((st) => (
              <Pressable key={st.uid} onPress={() => openStudent(st)} accessibilityRole="button">
                <Card>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md }}>
                    <Avatar name={st.name} tone="primary" size={42} />
                    <View style={{ flex: 1 }}>
                      <Text style={font.h3} numberOfLines={1}>{st.name}</Text>
                      <Text style={font.small} numberOfLines={1}>
                        {[st.roll_no, st.course_name, st.semester ? `Sem ${st.semester}` : null].filter(Boolean).join("  |  ")}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={T.muted} />
                  </View>
                </Card>
              </Pressable>
            ))}
            {!!query.trim() && !searching && !searchError && results.length === 0 && <EmptyState icon="search" title="No students found" text="Check the spelling, or try the roll number." />}
          </View>
        )}
      </ScrollView>

      <Modal visible={scanner} animationType="slide" onRequestClose={() => setScanner(false)}>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <CameraView style={{ flex: 1 }} facing="back" onBarcodeScanned={scanBusy ? undefined : onScan} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} />
          <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 240, height: 240, borderRadius: 24, borderWidth: 3, borderColor: "#fff" }} />
            <Text style={{ color: "#fff", marginTop: SP.lg, fontWeight: "600" }}>Point at the QR on the student's ID</Text>
          </View>
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: 48, paddingHorizontal: SP.lg }}>
            <Button label="Close" icon="close" variant="secondary" size="md" onPress={() => setScanner(false)} style={{ alignSelf: "flex-start" }} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}