// screens/quiz/teacher/FinalizeQuiz.tsx — timing, join code and launch
// Fixes: choosing a time after a date used to put the date back to today (the picker returned today's date),
// the iOS picker could not be closed, create could be tapped twice, and only five fixed durations were possible.

import React, { useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useNavigation, useRoute } from "@react-navigation/native";
import { apiFetch } from "../../../services/api";
import { API_URL, readJson } from "./components/quizViewConstants";
import { Banner, Button, Card, EmptyState, Header, Screen, Segmented, SP, T, TextField, ToggleRow, font } from "../../../components/ui";

const DURATIONS = [10, 20, 30, 45, 60];
const EXPIRY_OPTIONS = [
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
  { label: "1 hr", value: 60 },
  { label: "2 hr", value: 120 },
];

const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fmtClock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Pill({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} style={[st.pill, on && st.pillOn]}>
      <Text style={[st.pillTxt, on && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function SummaryRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[st.sumRow, !last && st.sumBorder]}>
      <Text style={st.sumLabel}>{label}</Text>
      <Text style={st.sumValue}>{value}</Text>
    </View>
  );
}

export default function FinalizeQuiz() {
  const navigation = useNavigation<any>();
  const quizData = useRoute<any>().params?.quizData;

  const [loading, setLoading] = useState(false);
  const lock = useRef(false);

  const [mode, setMode] = useState<"immediate" | "scheduled">("immediate");
  const [duration, setDuration] = useState(30);
  const [custom, setCustom] = useState("");
  const [when, setWhen] = useState(() => new Date(Date.now() + 15 * 60_000));
  const [picker, setPicker] = useState<null | "date" | "time">(null);

  const [useCode, setUseCode] = useState(true);
  const [expiryOn, setExpiryOn] = useState(false);
  const [expiryMin, setExpiryMin] = useState<number>(30);

  if (!quizData || !Array.isArray(quizData.questions) || quizData.questions.length === 0) {
    return (
      <Screen>
        <Header title="Finalize quiz" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Nothing to finalize" text="Go back and add at least one question." />
      </Screen>
    );
  }

  const customNum = custom.trim() === "" ? null : Number(custom);
  const effectiveDuration = customNum ?? duration;
  const durationOk = Number.isInteger(effectiveDuration) && effectiveDuration >= 5 && effectiveDuration <= 240;
  const totalMarks = quizData.questions.reduce((sum: number, q: any) => sum + (Number(q.marks) || 0), 0);

  const onPick = (kind: "date" | "time") => (_: any, picked?: Date) => {
    if (Platform.OS === "android") setPicker(null);
    if (!picked) return;
    const merged = new Date(when); // keep the other half (day or time) that was already chosen
    if (kind === "date") merged.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
    else merged.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
    setWhen(merged);
  };

  const create = async () => {
    if (lock.current) return;
    if (!durationOk) {
      Alert.alert("Check the duration", "Enter a whole number of minutes between 5 and 240.");
      return;
    }
    const now = new Date();
    if (mode === "scheduled" && when.getTime() <= now.getTime()) {
      Alert.alert("Check the time", "The scheduled time must be in the future.");
      return;
    }

    lock.current = true;
    setLoading(true);
    try {
      const start = mode === "immediate" ? now : when;
      const end = new Date(start.getTime() + effectiveDuration * 60_000);

      // drop any stale join-code fields from earlier screens, then set them from this screen's state only
      const { use_join_code: _a, join_code_duration_minutes: _b, join_code: _c, ...clean } = quizData;

      const res = await apiFetch(`${API_URL}/api/quizzes/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...clean,
          time_limit_minutes: effectiveDuration,
          scheduled_start: start.toISOString(),
          scheduled_end: end.toISOString(),
          use_join_code: useCode,
          join_code_duration_minutes: useCode && expiryOn ? expiryMin : undefined,
        }),
      });
      const data = await readJson(res);
      if (!data?.success) throw new Error(data?.error || "Failed to create quiz");

      Alert.alert("Quiz created", mode === "immediate" ? "Your quiz is live now." : "Your quiz is scheduled.", [
        { text: "OK", onPress: () => navigation.navigate("TeacherDashboard") },
      ]);
    } catch (e: any) {
      Alert.alert("Could not create quiz", e?.message || "Check your connection and try again.");
    } finally {
      lock.current = false;
      setLoading(false);
    }
  };

  return (
    <Screen>
      <Header title="Finalize quiz" subtitle="Set the timing and launch" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Card>
          <Text style={st.label}>Start</Text>
          <Segmented
            options={[
              { value: "immediate" as const, label: "Start now", icon: "flash-outline" },
              { value: "scheduled" as const, label: "Schedule", icon: "calendar-outline" },
            ]}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setPicker(null);
            }}
          />

          {mode === "scheduled" && (
            <View style={{ gap: SP.sm, marginTop: SP.lg }}>
              <Pressable onPress={() => setPicker((p) => (p === "date" ? null : "date"))} style={st.field}>
                <Ionicons name="calendar-outline" size={18} color={T.primary} />
                <Text style={st.fieldTxt}>{fmtDay(when)}</Text>
                <Ionicons name={picker === "date" ? "chevron-up" : "chevron-down"} size={16} color={T.muted} />
              </Pressable>
              <Pressable onPress={() => setPicker((p) => (p === "time" ? null : "time"))} style={st.field}>
                <Ionicons name="time-outline" size={18} color={T.primary} />
                <Text style={st.fieldTxt}>{fmtClock(when)}</Text>
                <Ionicons name={picker === "time" ? "chevron-up" : "chevron-down"} size={16} color={T.muted} />
              </Pressable>
              {picker && (
                <View style={st.inline}>
                  <DateTimePicker
                    value={when}
                    mode={picker}
                    is24Hour
                    minimumDate={picker === "date" ? new Date() : undefined}
                    display={Platform.OS === "ios" ? (picker === "date" ? "inline" : "spinner") : "default"}
                    onChange={onPick(picker)}
                    style={{ width: "100%" }}
                  />
                </View>
              )}
            </View>
          )}
        </Card>

        <Card>
          <Text style={st.label}>Duration (minutes)</Text>
          <View style={st.pills}>
            {DURATIONS.map((d) => (
              <Pill
                key={d}
                label={String(d)}
                on={customNum === null && duration === d}
                onPress={() => {
                  setDuration(d);
                  setCustom("");
                }}
              />
            ))}
          </View>
          <TextField
            style={{ marginTop: SP.md }}
            label="Or enter your own"
            value={custom}
            onChangeText={(t) => setCustom(t.replace(/\D/g, "").slice(0, 3))}
            placeholder="e.g. 90"
            keyboardType="number-pad"
            icon="timer-outline"
            error={custom !== "" && !durationOk ? "Enter 5 to 240 minutes" : undefined}
            maxLength={3}
          />
        </Card>

        <Card>
          <ToggleRow
            title="Require join code"
            sub={useCode ? "Students must enter a code to join." : "Anyone in the class can join directly."}
            value={useCode}
            onChange={(v) => {
              setUseCode(v);
              if (!v) setExpiryOn(false);
            }}
          />

          {!useCode && (
            <Banner tone="success" icon="lock-open-outline" style={{ marginTop: SP.md }}>
              This quiz will be open. Students can join without a code, wherever they are.
            </Banner>
          )}

          {useCode && (
            <>
              <View style={st.divider} />
              <ToggleRow
                title="Set code expiry"
                sub={expiryOn ? "The code stops working after the time below." : "The code stays valid for the whole quiz."}
                value={expiryOn}
                onChange={setExpiryOn}
              />
              {expiryOn && (
                <>
                  <Text style={[st.label, { marginTop: SP.lg }]}>Expires after the quiz starts</Text>
                  <View style={st.pills}>
                    {EXPIRY_OPTIONS.map((o) => (
                      <Pill key={o.value} label={o.label} on={expiryMin === o.value} onPress={() => setExpiryMin(o.value)} />
                    ))}
                  </View>
                  <Banner tone="warning" icon="time-outline" style={{ marginTop: SP.md }}>
                    {`Late students will not be able to join ${expiryMin < 60 ? `${expiryMin} minutes` : `${expiryMin / 60} hour${expiryMin > 60 ? "s" : ""}`} after the quiz starts.`}
                  </Banner>
                </>
              )}
            </>
          )}
        </Card>

        <Card padded={false}>
          <Text style={[font.h3, { padding: SP.lg, paddingBottom: SP.sm }]}>Summary</Text>
          <SummaryRow label="Questions" value={String(quizData.questions.length)} />
          <SummaryRow label="Total marks" value={String(totalMarks)} />
          <SummaryRow label="Starts" value={mode === "immediate" ? "Now" : `${fmtDay(when)}, ${fmtClock(when)}`} />
          <SummaryRow label="Duration" value={durationOk ? `${effectiveDuration} min` : "-"} />
          <SummaryRow label="Join code" value={useCode ? (expiryOn ? `Yes, expires after ${expiryMin} min` : "Yes, no expiry") : "Off (open quiz)"} last />
        </Card>

        <Button label={mode === "immediate" ? "Create and start" : "Create quiz"} icon="rocket-outline" onPress={create} loading={loading} disabled={!durationOk} />
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, gap: SP.lg, paddingBottom: 40 },
  label: { ...font.label, marginBottom: SP.sm },
  field: { flexDirection: "row", alignItems: "center", gap: SP.md, backgroundColor: T.surface, borderRadius: 14, borderWidth: 1, borderColor: T.line, paddingVertical: 14, paddingHorizontal: SP.lg },
  fieldTxt: { flex: 1, fontSize: 15, fontWeight: "600", color: T.ink },
  inline: { backgroundColor: T.surface, borderRadius: 14, borderWidth: 1, borderColor: T.line, overflow: "hidden", alignItems: "center" },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: SP.sm },
  pill: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999, borderWidth: 1.5, borderColor: T.line, backgroundColor: T.surface },
  pillOn: { backgroundColor: T.primary, borderColor: T.primary },
  pillTxt: { fontSize: 14, fontWeight: "700", color: T.sub },
  divider: { height: 1, backgroundColor: T.lineSoft, marginVertical: SP.lg },
  sumRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 11, paddingHorizontal: SP.lg, gap: SP.md },
  sumBorder: { borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  sumLabel: { fontSize: 13, color: T.sub, fontWeight: "600" },
  sumValue: { fontSize: 13, fontWeight: "700", color: T.ink, flex: 1, textAlign: "right" },
});