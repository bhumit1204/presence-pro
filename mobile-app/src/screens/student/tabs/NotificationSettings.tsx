import React, { useCallback, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Alert } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { apiFetch, API_BASE } from "../../../services/api";
import { getUserSession } from "../../../services/session";
import { Card, Header, Screen, SectionLabel, Segmented, SP, T, ToggleRow, font } from "../../../components/ui";

type Prefs = {
  lecture_start: boolean;
  lecture_live: boolean;
  low_attendance: boolean;
  assignments: boolean;
  quizzes: boolean;
  announcements: boolean;
  window_before_min: number;
  window_after_min: number;
};

const BEFORE = [
  { value: "30", label: "30 min" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "180", label: "3 hours" },
];
const AFTER = [
  { value: "0", label: "At end" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "240", label: "4 hours" },
];

const Divider = () => <View style={{ height: 1, backgroundColor: T.lineSoft, marginVertical: SP.md }} />;

export default function NotificationSettings() {
  const navigation = useNavigation<any>();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [loading, setLoading] = useState(true);
  const uid = useRef("");
  const seq = useRef(0);

  const load = useCallback(async () => {
    try {
      const session = await getUserSession();
      if (!session?.uid) return;
      uid.current = session.uid;
      const res = await apiFetch(`${API_BASE}/api/notify-prefs?uid=${session.uid}`);
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) setPrefs(json.prefs);
      else Alert.alert("Could not load", json.error || "Please try again.");
    } catch {
      Alert.alert("Could not load", "Could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // change one setting: shown at once, saved in the background, put back if the server says no
  const change = async (patch: Partial<Prefs>) => {
    if (!prefs) return;
    const before = prefs;
    const mine = ++seq.current;
    setPrefs({ ...prefs, ...patch });
    try {
      const res = await apiFetch(`${API_BASE}/api/notify-prefs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: uid.current, ...patch }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || "failed");
      if (mine === seq.current) setPrefs(json.prefs);
    } catch (e: any) {
      if (mine === seq.current) setPrefs(before);
      Alert.alert("Could not save", "Your change was not saved. Please try again.");
    }
  };

  if (loading || !prefs) {
    return (
      <Screen edges={["top"]}>
        <Header title="Notifications" onBack={() => navigation.goBack()} />
        <View style={styles.center}><ActivityIndicator color={T.primary} size="large" /></View>
      </Screen>
    );
  }

  const beforeText = prefs.window_before_min >= 60 ? `${prefs.window_before_min / 60} hour${prefs.window_before_min === 60 ? "" : "s"}` : `${prefs.window_before_min} minutes`;
  const afterText = prefs.window_after_min === 0 ? "when it ends" : prefs.window_after_min >= 60 ? `${prefs.window_after_min / 60} hour${prefs.window_after_min === 60 ? "" : "s"} after it ends` : `${prefs.window_after_min} minutes after it ends`;

  return (
    <Screen edges={["top"]}>
      <Header title="Notifications" subtitle="Choose what you hear about" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <SectionLabel>Lectures</SectionLabel>
        <Card>
          <ToggleRow title="Lecture is starting" sub="When a lecture of yours reaches its scheduled start time" value={prefs.lecture_start} onChange={(v) => change({ lecture_start: v })} />
          <Divider />
          <ToggleRow title="Teacher started the lecture" sub="As soon as your teacher taps Start Lecture" value={prefs.lecture_live} onChange={(v) => change({ lecture_live: v })} />
          <Divider />
          <ToggleRow title="Low attendance reminders" sub="Before a lecture of a subject where your attendance is low. The lower it is, the more reminders you get; they ease off as you start attending." value={prefs.low_attendance} onChange={(v) => change({ low_attendance: v })} />
        </Card>

        <SectionLabel style={styles.gap}>Lecture notification window</SectionLabel>
        <Card>
          <Text style={font.h3}>Earliest</Text>
          <Text style={[font.small, { marginTop: 2, marginBottom: SP.sm }]}>How long before a lecture you can be notified about it</Text>
          <Segmented options={BEFORE} value={String(prefs.window_before_min)} onChange={(v) => change({ window_before_min: Number(v) })} />
          <Divider />
          <Text style={font.h3}>Latest</Text>
          <Text style={[font.small, { marginTop: 2, marginBottom: SP.sm }]}>How long after a lecture ends it can still notify you</Text>
          <Segmented options={AFTER} value={String(prefs.window_after_min)} onChange={(v) => change({ window_after_min: Number(v) })} />
          <Text style={[font.small, { marginTop: SP.md }]}>
            You hear about a lecture from {beforeText} before it starts until {afterText}.
          </Text>
        </Card>

        <SectionLabel style={styles.gap}>Other activities</SectionLabel>
        <Card>
          <ToggleRow title="Assignments" sub="New assignments, deadlines and marks" value={prefs.assignments} onChange={(v) => change({ assignments: v })} />
          <Divider />
          <ToggleRow title="Quizzes" sub="New and live quizzes" value={prefs.quizzes} onChange={(v) => change({ quizzes: v })} />
          <Divider />
          <ToggleRow title="Announcements" sub="Messages from your teachers" value={prefs.announcements} onChange={(v) => change({ announcements: v })} />
        </Card>
        <View style={{ height: SP.xxl }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: SP.xl, paddingBottom: SP.xxl },
  gap: { marginTop: SP.xxl },
});
