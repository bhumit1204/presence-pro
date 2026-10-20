// Student picks ONE elective subject from EACH elective group of the current semester.
// The choice is final for the semester; it opens again when the semester changes, or when the head teacher
// unenrolls the student from a subject (that group then shows up here as open again).

import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE } from "../../../services/api";
import { getUserSession } from "../../../services/session";
import { Banner, Button, Card, Chip, EmptyState, Header, R, ResultView, Screen, SectionLabel, SP, T, font } from "../../../components/ui";

const API_URL = API_BASE;

interface Option {
  subject_id: string;
  subject_name: string;
  subject_code: string;
  teacher_name: string;
}
interface Group {
  group: string;
  chosen: string | null;
  options: Option[];
}

export default function ElectiveSelection() {
  const navigation = useNavigation<any>();
  const [uid, setUid] = useState("");
  const [semester, setSemester] = useState<number | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({}); // group -> subject_id (not saved yet)
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (!isRefresh) setLoading(true);
      setError(null);
      const session = await getUserSession();
      if (!session?.uid) {
        setError("Please log in again.");
        return;
      }
      setUid(session.uid);
      const res = await apiFetch(`${API_URL}/api/profile/student/${session.uid}/electives`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setSemester(json.semester ?? null);
      setGroups(json.groups || []);
      setPicks({});
    } catch (e: any) {
      setError(e?.message === "Please log in again." ? e.message : "Could not load your electives. Check your connection and try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const open = useMemo(() => groups.filter((g) => !g.chosen), [groups]);
  const allPicked = open.length > 0 && open.every((g) => !!picks[g.group]);
  const locked = groups.length > 0 && open.length === 0;

  const nameOf = (g: Group, id: string) => g.options.find((o) => o.subject_id === id)?.subject_name || "";

  const save = () => {
    const summary = open.map((g) => `${g.group}: ${nameOf(g, picks[g.group])}`).join("\n");
    Alert.alert(
      "Save your electives?",
      `${summary}\n\nYou cannot change this yourself later. Only your head teacher can move you to another option.`,
      [
        { text: "Review", style: "cancel" },
        { text: "Save", onPress: submit },
      ]
    );
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await apiFetch(`${API_URL}/api/profile/student/${uid}/electives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections: picks }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        Alert.alert("Could not save", json.error || "Something went wrong. Please try again.");
        // someone else (another device) may have saved already: reload the real state
        if (res.status === 409) load();
        return;
      }
      Alert.alert("Electives saved", "Your subjects are now in your timetable and attendance.", [
        { text: "Done", onPress: () => navigation.goBack() },
      ]);
      load();
    } catch {
      Alert.alert("Could not save", "Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  /* ───────── states ───────── */

  if (loading) {
    return (
      <Screen>
        <Header title="Electives" onBack={() => navigation.goBack()} />
        <View style={S.center}>
          <ActivityIndicator color={T.primary} size="large" />
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <Header title="Electives" onBack={() => navigation.goBack()} />
        <ResultView
          icon="cloud-offline"
          tone="danger"
          title="Could not load"
          message={error}
          actions={<Button label="Try again" icon="refresh" onPress={() => load()} />}
        />
      </Screen>
    );
  }

  if (groups.length === 0) {
    return (
      <Screen>
        <Header title="Electives" onBack={() => navigation.goBack()} />
        <EmptyState
          icon="library-outline"
          title="No electives this semester"
          text="Your semester has no optional subjects right now. If your department adds some, they will appear here."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Electives" subtitle={semester ? `Semester ${semester}` : undefined} onBack={() => navigation.goBack()} />

      <ScrollView
        contentContainerStyle={S.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} colors={[T.primary]} />}
      >
        {locked ? (
          <Banner tone="success" icon="lock-closed" title="Your electives are final">
            To change one, ask your head teacher. You will also choose again when your next semester starts.
          </Banner>
        ) : (
          <Banner tone="warning" title="Choose one subject from each group">
            Pick exactly one in each group. After you save, only your head teacher can change it.
          </Banner>
        )}

        {groups.map((g) => {
          const done = !!g.chosen;
          return (
            <View key={g.group}>
              <SectionLabel>{g.group}</SectionLabel>
              <View style={{ gap: SP.sm }}>
                {g.options.map((o) => {
                  const selected = done ? g.chosen === o.subject_id : picks[g.group] === o.subject_id;
                  const dimmed = done && !selected;
                  return (
                    <Pressable
                      key={o.subject_id}
                      disabled={done}
                      onPress={() => setPicks((p) => ({ ...p, [g.group]: o.subject_id }))}
                      accessibilityRole="radio"
                      accessibilityState={{ selected, disabled: done }}
                      style={({ pressed }) => [S.option, selected && S.optionOn, dimmed && { opacity: 0.45 }, pressed && !done && { opacity: 0.85 }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={font.h3} numberOfLines={2}>
                          {o.subject_name}
                        </Text>
                        <Text style={[font.small, { marginTop: 2 }]} numberOfLines={1}>
                          {o.subject_code}
                          {o.teacher_name ? `  ·  ${o.teacher_name}` : ""}
                        </Text>
                      </View>
                      {done && selected ? (
                        <Chip label="Chosen" tone="success" icon="lock-closed" />
                      ) : (
                        <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={22} color={selected ? T.primary : T.muted} />
                      )}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}
      </ScrollView>

      {!locked && (
        <View style={S.footer}>
          <Button
            label={allPicked ? "Save electives" : `Choose ${open.filter((g) => !picks[g.group]).length} more`}
            icon="checkmark-done"
            onPress={save}
            disabled={!allPicked}
            loading={saving}
          />
        </View>
      )}
    </Screen>
  );
}

const S = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  scroll: { padding: SP.lg, gap: SP.lg, paddingBottom: SP.xxl },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: SP.md,
    backgroundColor: T.surface,
    borderRadius: R.lg,
    borderWidth: 1.5,
    borderColor: T.line,
    padding: SP.md + 2,
  },
  optionOn: { borderColor: T.primary, backgroundColor: T.primarySoft },
  footer: { padding: SP.lg, paddingTop: SP.md, backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.line },
});