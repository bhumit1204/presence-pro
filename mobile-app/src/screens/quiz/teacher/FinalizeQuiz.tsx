import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation } from "@react-navigation/native";
import DateTimePicker from "@react-native-community/datetimepicker";

const PRIMARY       = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const GREEN         = "#10B981";
const AMBER         = "#F59E0B";
const GREY          = "#6B7280";
const BG            = "#F3F4F6";
const API_URL       = "http://10.132.90.56:5000";

const durations = [10, 20, 30, 45, 60];

const CODE_EXPIRY_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Never",  value: null },
  { label: "15 min", value: 15   },
  { label: "30 min", value: 30   },
  { label: "1 hr",   value: 60   },
  { label: "2 hr",   value: 120  },
];

// ─── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  return (
    <TouchableOpacity
      style={[T.track, value && T.trackOn]}
      onPress={onToggle}
      activeOpacity={0.85}
    >
      <View style={[T.knob, value && T.knobOn]} />
    </TouchableOpacity>
  );
}
const T = StyleSheet.create({
  track:   { width: 50, height: 28, borderRadius: 14, backgroundColor: "#D1D5DB", justifyContent: "center", paddingHorizontal: 3 },
  trackOn: { backgroundColor: PRIMARY },
  knob:    { width: 22, height: 22, borderRadius: 11, backgroundColor: "#FFF", shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 3, elevation: 2 },
  knobOn:  { alignSelf: "flex-end" },
});

// ─── Section header ────────────────────────────────────────────────────────────
function SectionLabel({ text }: { text: string }) {
  return <Text style={styles.label}>{text}</Text>;
}

export default function FinalizeQuiz() {
  const route      = useRoute<any>();
  const navigation = useNavigation<any>();
  const { quizData } = route.params;

  const [loading, setLoading] = useState(false);

  // ── Timing ──────────────────────────────────────────────────────────────────
  const [mode, setMode]                     = useState<"immediate" | "scheduled">("immediate");
  const [selectedDuration, setSelectedDuration] = useState(30);
  const [scheduledDate, setScheduledDate]   = useState(new Date());
  const [showPicker, setShowPicker]         = useState(false);
  const [pickerMode, setPickerMode]         = useState<"date" | "time">("date");

  // ── Join code ───────────────────────────────────────────────────────────────
  const [joinCodeEnabled, setJoinCodeEnabled]     = useState(true);
  const [codeExpiryEnabled, setCodeExpiryEnabled] = useState(false);
  const [codeExpiryMinutes, setCodeExpiryMinutes] = useState<number | null>(null);

  /* ── Date/time picker helpers ─────────────────────────────────────────────── */
  const openDatePicker = () => { setPickerMode("date"); setShowPicker(true); };
  const openTimePicker = () => { setPickerMode("time"); setShowPicker(true); };
  const onChangeDateTime = (event: any, selected?: Date) => {
    if (Platform.OS === "android") setShowPicker(false);
    if (selected) setScheduledDate(selected);
  };

  /* ── Create quiz ──────────────────────────────────────────────────────────── */
  const handleCreateQuiz = async () => {
    try {
      setLoading(true);
      const now = new Date();

      let startTime: Date;
      if (mode === "immediate") {
        startTime = now;
      } else {
        if (scheduledDate < now) {
          Alert.alert("Error", "Scheduled time cannot be in the past");
          setLoading(false);
          return;
        }
        startTime = scheduledDate;
      }

      const endTime = new Date(startTime.getTime() + selectedDuration * 60000);

      // ── FIX: Destructure quizData to strip out any stale join-code fields
      // that may have been carried over from a previous screen. We then set
      // these fields explicitly from local state so they are never overwritten.
      const {
        use_join_code: _stripUseJoinCode,
        join_code_duration_minutes: _stripExpiry,
        join_code: _stripJoinCode,
        ...cleanQuizData
      } = quizData;

      // Determine expiry: only send when join code is on AND expiry is enabled
      const expiryMinutes =
        joinCodeEnabled && codeExpiryEnabled && codeExpiryMinutes !== null
          ? codeExpiryMinutes
          : undefined;

      const finalPayload = {
        ...cleanQuizData,                            // safe — no stale join-code fields
        time_limit_minutes:         selectedDuration,
        scheduled_start:            startTime.toISOString(),
        scheduled_end:              endTime.toISOString(),
        use_join_code:              joinCodeEnabled,  // always a clean boolean from state
        join_code_duration_minutes: expiryMinutes,
      };

      const res  = await fetch(`${API_URL}/api/quizzes/create`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(finalPayload),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to create quiz");

      Alert.alert("Success", "Quiz created successfully!", [
        { text: "OK", onPress: () => navigation.navigate("TeacherDashboard") },
      ]);
    } catch (err: any) {
      Alert.alert("Error", err.message);
    } finally {
      setLoading(false);
    }
  };

  /* ── Derived ──────────────────────────────────────────────────────────────── */
  const totalMarks = quizData.questions.reduce(
    (sum: number, q: any) => sum + q.marks, 0
  );

  /* ── UI ───────────────────────────────────────────────────────────────────── */
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* HEADER */}
        <Text style={styles.title}>Finalize Quiz</Text>
        <Text style={styles.subtitle}>Configure quiz timing and launch</Text>

        {/* ── START MODE ────────────────────────────────────────────────────── */}
        <SectionLabel text="Start Mode" />
        <View style={styles.row}>
          {(["immediate", "scheduled"] as const).map((m) => (
            <TouchableOpacity
              key={m}
              style={[styles.optionBtn, mode === m && styles.activeBtn]}
              onPress={() => setMode(m)}
            >
              <Text style={[styles.optionText, mode === m && styles.activeText]}>
                {m === "immediate" ? "Start Now" : "Schedule"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* DATE + TIME (scheduled only) */}
        {mode === "scheduled" && (
          <>
            <SectionLabel text="Select Date & Time" />
            <TouchableOpacity style={styles.dateBtn} onPress={openDatePicker}>
              <Text style={styles.dateText}>📅  {scheduledDate.toDateString()}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.dateBtn} onPress={openTimePicker}>
              <Text style={styles.dateText}>⏰  {scheduledDate.toLocaleTimeString()}</Text>
            </TouchableOpacity>
          </>
        )}

        {/* ── DURATION ──────────────────────────────────────────────────────── */}
        <SectionLabel text="Quiz Duration (minutes)" />
        <View style={styles.rowWrap}>
          {durations.map((d) => (
            <TouchableOpacity
              key={d}
              style={[styles.durationBtn, selectedDuration === d && styles.activeBtn]}
              onPress={() => setSelectedDuration(d)}
            >
              <Text style={[styles.optionText, selectedDuration === d && styles.activeText]}>{d}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── JOIN CODE SECTION ──────────────────────────────────────────────── */}
        <View style={styles.sectionCard}>

          {/* Main toggle row */}
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleTitle}>Require Join Code</Text>
              <Text style={styles.toggleSub}>
                {joinCodeEnabled
                  ? "Students must enter a code to join"
                  : "Anyone in the class can join directly"}
              </Text>
            </View>
            <Toggle value={joinCodeEnabled} onToggle={() => {
              setJoinCodeEnabled((v) => {
                // when disabling join code, also reset expiry
                if (v) { setCodeExpiryEnabled(false); setCodeExpiryMinutes(null); }
                return !v;
              });
            }} />
          </View>

          {/* Open quiz info banner */}
          {!joinCodeEnabled && (
            <View style={styles.infoBanner}>
              <Text style={styles.infoBannerIcon}>🔓</Text>
              <Text style={styles.infoBannerText}>
                This quiz will be <Text style={{ fontWeight: "800" }}>open</Text> — students
                can join without a code, regardless of location.
              </Text>
            </View>
          )}

          {/* Code expiry sub-section (only when join code is on) */}
          {joinCodeEnabled && (
            <>
              <View style={[styles.toggleRow, styles.toggleRowInner]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleTitle}>Set Code Expiry</Text>
                  <Text style={styles.toggleSub}>
                    {codeExpiryEnabled
                      ? "Code will stop working after the selected time"
                      : "Code stays valid for the entire quiz duration"}
                  </Text>
                </View>
                <Toggle value={codeExpiryEnabled} onToggle={() => {
                  setCodeExpiryEnabled((v) => {
                    if (!v) setCodeExpiryMinutes(30); // sensible default
                    else    setCodeExpiryMinutes(null);
                    return !v;
                  });
                }} />
              </View>

              {/* Expiry pill picker */}
              {codeExpiryEnabled && (
                <>
                  <Text style={styles.expiryLabel}>Expires after quiz starts</Text>
                  <View style={styles.expiryRow}>
                    {CODE_EXPIRY_OPTIONS.filter((o) => o.value !== null).map((opt) => (
                      <TouchableOpacity
                        key={String(opt.value)}
                        style={[
                          styles.expiryPill,
                          codeExpiryMinutes === opt.value && styles.expiryPillActive,
                        ]}
                        onPress={() => setCodeExpiryMinutes(opt.value)}
                      >
                        <Text style={[
                          styles.expiryPillText,
                          codeExpiryMinutes === opt.value && styles.expiryPillTextActive,
                        ]}>
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {/* Contextual hint */}
                  {codeExpiryMinutes !== null && (
                    <View style={styles.expiryHint}>
                      <Text style={styles.expiryHintText}>
                        ⏱  Join code will expire{" "}
                        <Text style={{ fontWeight: "800", color: AMBER }}>
                          {codeExpiryMinutes < 60
                            ? `${codeExpiryMinutes} min`
                            : `${codeExpiryMinutes / 60} hr`}
                        </Text>
                        {" "}after the quiz starts. Late students won't be able to join.
                      </Text>
                    </View>
                  )}
                </>
              )}
            </>
          )}
        </View>

        {/* ── SUMMARY ───────────────────────────────────────────────────────── */}
        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>Summary</Text>
          <SummaryRow label="Questions"   value={String(quizData.questions.length)} />
          <SummaryRow label="Total Marks" value={String(totalMarks)} />
          <SummaryRow label="Duration"    value={`${selectedDuration} mins`} />
          <SummaryRow
            label="Join Code"
            value={joinCodeEnabled ? (codeExpiryEnabled ? `Yes · expires in ${codeExpiryMinutes} min` : "Yes · no expiry") : "Disabled (open)"}
            valueColor={joinCodeEnabled ? PRIMARY : GREEN}
          />
        </View>

        {/* ── CREATE BUTTON ─────────────────────────────────────────────────── */}
        <TouchableOpacity
          style={[styles.submitBtn, loading && { opacity: 0.7 }]}
          onPress={handleCreateQuiz}
          disabled={loading}
        >
          <Text style={styles.submitText}>
            {loading ? "Creating..." : "Create Quiz"}
          </Text>
        </TouchableOpacity>

        {/* DATE/TIME PICKER */}
        {showPicker && (
          <DateTimePicker
            value={scheduledDate}
            mode={pickerMode}
            is24Hour={true}
            display={Platform.OS === "ios" ? "spinner" : "default"}
            onChange={onChangeDateTime}
          />
        )}

      </ScrollView>
    </SafeAreaView>
  );
}

/* ── Small helper ─────────────────────────────────────────────────────────────*/
function SummaryRow({
  label, value, valueColor,
}: {
  label: string; value: string; valueColor?: string;
}) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={[styles.summaryValue, valueColor ? { color: valueColor } : {}]}>{value}</Text>
    </View>
  );
}

/* ── Styles ───────────────────────────────────────────────────────────────────*/
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, paddingHorizontal: 20 },
  content:   { paddingTop: 16, paddingBottom: 48 },

  title:    { fontSize: 26, fontWeight: "800", marginBottom: 4, color: "#111827" },
  subtitle: { color: GREY, marginBottom: 20, fontSize: 14 },

  label: {
    fontWeight: "700",
    marginBottom: 10,
    marginTop: 10,
    color: "#111827",
    fontSize: 14,
  },

  row:     { flexDirection: "row", gap: 10, marginBottom: 16 },
  rowWrap: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 20 },

  optionBtn: {
    flex: 1, height: 50, borderRadius: 30, borderWidth: 1,
    borderColor: "#D1D5DB", justifyContent: "center",
    alignItems: "center", backgroundColor: "#FFF",
  },
  durationBtn: {
    width: "22%", height: 50, borderRadius: 30, borderWidth: 1,
    borderColor: "#D1D5DB", justifyContent: "center",
    alignItems: "center", backgroundColor: "#FFF",
  },
  activeBtn:   { backgroundColor: PRIMARY, borderColor: PRIMARY },
  optionText:  { color: "#444", fontWeight: "600" },
  activeText:  { color: "#FFF" },

  dateBtn:  { height: 50, borderRadius: 14, borderWidth: 1, borderColor: "#E5E7EB", justifyContent: "center", paddingHorizontal: 14, marginBottom: 10, backgroundColor: "#FFF" },
  dateText: { fontSize: 14, fontWeight: "600", color: "#111827" },

  /* Join code card */
  sectionCard: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    gap: 0,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
  },
  toggleRowInner: {
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
    marginTop: 14,
    paddingTop: 14,
  },
  toggleTitle: { fontSize: 14, fontWeight: "700", color: "#111827", marginBottom: 2 },
  toggleSub:   { fontSize: 12, color: GREY, lineHeight: 16 },

  infoBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#F0FDF4",
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: "#BBF7D0",
  },
  infoBannerIcon: { fontSize: 16 },
  infoBannerText: { flex: 1, fontSize: 13, color: "#065F46", lineHeight: 18 },

  expiryLabel: { fontSize: 12, fontWeight: "700", color: GREY, marginTop: 14, marginBottom: 8 },
  expiryRow:   { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  expiryPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "#E5E7EB",
    backgroundColor: "#F9FAFB",
  },
  expiryPillActive:     { backgroundColor: AMBER + "22", borderColor: AMBER },
  expiryPillText:       { fontSize: 13, fontWeight: "600", color: "#374151" },
  expiryPillTextActive: { color: "#92400E", fontWeight: "700" },

  expiryHint: {
    backgroundColor: "#FFFBEB",
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#FDE68A",
  },
  expiryHintText: { fontSize: 12, color: "#78350F", lineHeight: 18 },

  /* Summary */
  summaryCard:  { backgroundColor: "#FFF", borderRadius: 20, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: "#E5E7EB" },
  summaryTitle: { fontWeight: "700", marginBottom: 10, fontSize: 15, color: "#111827" },
  summaryRow:   { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  summaryLabel: { fontSize: 13, color: GREY, fontWeight: "600" },
  summaryValue: { fontSize: 13, fontWeight: "700", color: "#111827", maxWidth: "60%", textAlign: "right" },

  /* Submit */
  submitBtn:  { height: 55, backgroundColor: PRIMARY, borderRadius: 30, justifyContent: "center", alignItems: "center" },
  submitText: { color: "#FFF", fontWeight: "700", fontSize: 16 },
});