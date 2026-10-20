// Final review screen: the teacher confirms who was present.
//   • students verified by the app are pre-ticked
//   • students the room check could not verify ("Needs check") start UNticked - not counted until the teacher decides

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { apiFetch, API_BASE } from "../../../services/api";
import { REASON_LABEL } from "../../../utils/proximity";
import {
  Avatar,
  Banner,
  Button,
  Card,
  Checkbox,
  Chip,
  EmptyState,
  Header,
  R,
  ResultView,
  Screen,
  SP,
  Stat,
  T,
  font,
} from "../../../components/ui";

const API_URL = API_BASE;

interface Student {
  uid: string;
  name: string;
  roll_no: string;
  is_present: boolean; // verified by the app (counted)
  status?: "present" | "pending" | "none";
  reasons?: string[]; // why the room check could not verify this student
  ble_rssi?: number | null;
}

type Filter = "all" | "check" | "present" | "absent";

export default function ManualMarkingScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();

  const { attendance_session_id, lecture_session_id } = route.params as {
    attendance_session_id: string;
    lecture_session_id: string;
  };

  const [students, setStudents] = useState<Student[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  // ── Load roster with each student's status ────────────────────────────────
  const fetchStudents = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const url =
        `${API_URL}/api/lectures/attendance/verify-students` +
        `?attendance_session_id=${attendance_session_id}` +
        `&lecture_session_id=${lecture_session_id}`;
      const res = await apiFetch(url, { method: "GET", headers: { "Content-Type": "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.success) {
        setLoadError(data.error || "Failed to load students.");
        return;
      }
      setStudents(data.students || []);
      // Pre-tick everyone the app already verified (pending students stay unticked)
      setSelected(new Set<string>((data.students || []).filter((x: Student) => x.is_present).map((x: Student) => x.uid)));
    } catch (e) {
      console.log("FETCH STUDENTS ERROR:", e);
      setLoadError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [attendance_session_id, lecture_session_id]);

  useEffect(() => {
    fetchStudents();
  }, [fetchStudents]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const pendingList = useMemo(() => students.filter((x) => x.status === "pending"), [students]);
  const presentCount = selected.size;
  const absentCount = students.length - presentCount;

  const visible = useMemo(() => {
    switch (filter) {
      case "check":
        return students.filter((x) => x.status === "pending");
      case "present":
        return students.filter((x) => selected.has(x.uid));
      case "absent":
        return students.filter((x) => !selected.has(x.uid));
      default:
        return students;
    }
  }, [students, selected, filter]);

  const allVisibleSelected = visible.length > 0 && visible.every((x) => selected.has(x.uid));

  const toggle = (uid: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(uid) ? n.delete(uid) : n.add(uid);
      return n;
    });

  const setPendingTo = (present: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      pendingList.forEach((x) => (present ? n.add(x.uid) : n.delete(x.uid)));
      return n;
    });

  const toggleVisible = () =>
    setSelected((prev) => {
      const n = new Set(prev);
      visible.forEach((x) => (allVisibleSelected ? n.delete(x.uid) : n.add(x.uid)));
      return n;
    });

  // ── Submit ────────────────────────────────────────────────────────────────
  const submitAttendance = async () => {
    setSubmitting(true);
    try {
      const res = await apiFetch(`${API_URL}/api/lectures/attendance/verify-attendance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendance_session_id,
          lecture_session_id,
          verified_students: Array.from(selected),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        Alert.alert(
          "Attendance saved",
          `${data.marked_count} present, ${data.unmarked_count} absent` +
            (data.skipped_count > 0 ? `, ${data.skipped_count} unchanged` : ""),
          [{ text: "Done", onPress: () => navigation.replace("TeacherDashboard") }],
          { cancelable: false }
        );
      } else {
        Alert.alert("Could not save", data.error || "Failed to save attendance.");
      }
    } catch (e) {
      console.log("SUBMIT ERROR:", e);
      Alert.alert("Could not save", "Could not connect to the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmSave = () => {
    const unresolved = pendingList.filter((x) => !selected.has(x.uid)).length;
    Alert.alert(
      "Save attendance?",
      `${presentCount} present, ${absentCount} absent.` +
        (unresolved > 0 ? `\n\n${unresolved} student${unresolved === 1 ? "" : "s"} marked "Needs check" will be saved as absent.` : ""),
      [
        { text: "Cancel", style: "cancel" },
        { text: "Save", onPress: submitAttendance },
      ]
    );
  };

  /* ───────── states ───────── */

  if (loading) {
    return (
      <Screen>
        <Header title="Review attendance" onBack={() => navigation.goBack()} />
        <ResultView icon="people" tone="primary" loading title="Loading students" message="Fetching the class roster..." />
      </Screen>
    );
  }

  if (loadError) {
    return (
      <Screen>
        <Header title="Review attendance" onBack={() => navigation.goBack()} />
        <ResultView
          icon="cloud-offline"
          tone="danger"
          title="Could not load"
          message={loadError}
          actions={<Button label="Try again" icon="refresh" onPress={fetchStudents} />}
        />
      </Screen>
    );
  }

  if (students.length === 0) {
    return (
      <Screen>
        <Header title="Review attendance" onBack={() => navigation.goBack()} />
        <EmptyState icon="people-outline" title="No students found" text="No students are enrolled in this class." />
      </Screen>
    );
  }

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: students.length },
    ...(pendingList.length > 0 ? [{ key: "check" as Filter, label: "Needs check", count: pendingList.length }] : []),
    { key: "present", label: "Present", count: presentCount },
    { key: "absent", label: "Absent", count: absentCount },
  ];

  const header = (
    <View style={{ gap: SP.md, paddingBottom: SP.sm }}>
      <Card padded={false} style={st.stats}>
        <Stat value={presentCount} label="Present" tone="success" />
        <View style={st.statLine} />
        <Stat value={absentCount} label="Absent" tone="danger" />
        <View style={st.statLine} />
        <Stat value={students.length} label="Total" />
      </Card>

      {pendingList.length > 0 && (
        <Banner tone="warning" title={`${pendingList.length} student${pendingList.length === 1 ? "" : "s"} need your check`}>
          Their Wi-Fi and Bluetooth signals did not agree, so they are not counted. Tick the ones you can see in class.
        </Banner>
      )}
      {pendingList.length > 0 && (
        <View style={{ flexDirection: "row", gap: SP.sm }}>
          <Button label="All present" size="md" variant="success" icon="checkmark" onPress={() => setPendingTo(true)} style={{ flex: 1 }} />
          <Button label="All absent" size="md" variant="dangerSoft" icon="close" onPress={() => setPendingTo(false)} style={{ flex: 1 }} />
        </View>
      )}

      <View style={st.tabs}>
        {tabs.map((t) => {
          const on = filter === t.key;
          return (
            <Pressable key={t.key} onPress={() => setFilter(t.key)} style={[st.tab, on && st.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
              <Text style={[st.tabText, on && { color: T.primary }]} numberOfLines={1}>
                {t.label} {t.count}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable style={st.selectAll} onPress={toggleVisible}>
        <Checkbox checked={allVisibleSelected} onPress={toggleVisible} />
        <Text style={[font.h3, { flex: 1 }]}>{allVisibleSelected ? "Deselect all" : "Select all"}{filter === "all" ? "" : " shown"}</Text>
        <Text style={font.small}>{visible.length} shown</Text>
      </Pressable>
    </View>
  );

  return (
    <Screen>
      <Header title="Review attendance" subtitle="Confirm who was in class" onBack={() => navigation.goBack()} />

      <FlatList
        data={visible}
        keyExtractor={(i) => i.uid}
        ListHeaderComponent={header}
        contentContainerStyle={st.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={<EmptyState icon="funnel-outline" title="Nothing here" text="No students match this filter." />}
        renderItem={({ item }) => {
          const isSel = selected.has(item.uid);
          const isPending = item.status === "pending";
          return (
            <Pressable onPress={() => toggle(item.uid)} style={({ pressed }) => [st.card, isPending && st.cardPending, pressed && { opacity: 0.85 }]}>
              <Checkbox checked={isSel} onPress={() => toggle(item.uid)} />
              <Avatar name={item.name} tone={isSel ? "primary" : "neutral"} />
              <View style={{ flex: 1 }}>
                <Text style={font.h3} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={font.small}>
                  Roll {item.roll_no}
                  {isPending && item.ble_rssi != null ? `  ·  ${item.ble_rssi} dBm` : ""}
                </Text>
                {isPending && (item.reasons?.length ?? 0) > 0 && (
                  <View style={st.reasons}>
                    {item.reasons!.slice(0, 3).map((r) => (
                      <Chip key={r} label={REASON_LABEL[r] || r} tone="warning" />
                    ))}
                  </View>
                )}
              </View>
              <Chip label={isSel ? "Present" : "Absent"} tone={isSel ? "success" : "danger"} />
            </Pressable>
          );
        }}
      />

      <View style={st.footer}>
        <Button label={`Save attendance (${presentCount} present)`} icon="checkmark-done" onPress={confirmSave} loading={submitting} />
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  list: { padding: SP.lg, paddingBottom: SP.md },
  stats: { flexDirection: "row", alignItems: "center" },
  statLine: { width: 1, height: 30, backgroundColor: T.line },
  tabs: { flexDirection: "row", backgroundColor: T.lineSoft, borderRadius: R.md, padding: 3 },
  tab: { flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: R.sm + 1 },
  tabOn: { backgroundColor: T.surface },
  tabText: { fontSize: 12, fontWeight: "700", color: T.sub },
  selectAll: {
    flexDirection: "row",
    alignItems: "center",
    gap: SP.md,
    backgroundColor: T.surface,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: T.line,
    padding: SP.md + 2,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: SP.md,
    backgroundColor: T.surface,
    borderRadius: R.lg,
    borderWidth: 1,
    borderColor: T.line,
    padding: SP.md + 2,
    marginBottom: SP.sm,
  },
  cardPending: { borderLeftWidth: 4, borderLeftColor: T.warning },
  reasons: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 },
  footer: { padding: SP.lg, paddingTop: SP.md, backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.line },
});