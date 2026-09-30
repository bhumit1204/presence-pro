import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity,
  Modal, ScrollView, Alert, ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import DateTimePicker from "@react-native-community/datetimepicker";
import { PRIMARY, BG, GREY, API_URL, Quiz, fmtTime } from "./quizViewConstants";

interface Props {
  visible: boolean;
  quiz: Quiz;
  onClose: () => void;
  onSuccess: () => void;
}

// ─── Inline Date+Time Row ────────────────────────────────────────────────────
// Shows a single DateTimePicker inline (no nested modal).
// On Android the picker is a native dialog; on iOS it's an inline spinner.
function DateTimeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Date;
  onChange: (d: Date) => void;
}) {
  const [showDate, setShowDate] = useState(false);
  const [showTime, setShowTime] = useState(false);

  const handleDateChange = (_: any, picked?: Date) => {
    if (Platform.OS === "android") setShowDate(false);
    if (!picked) return;
    const merged = new Date(value);
    merged.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
    onChange(merged);
  };

  const handleTimeChange = (_: any, picked?: Date) => {
    if (Platform.OS === "android") setShowTime(false);
    if (!picked) return;
    const merged = new Date(value);
    merged.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
    onChange(merged);
  };

  const dateStr = value.toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
  const timeStr = fmtTime(value.toISOString());

  return (
    <View style={R.fieldGroup}>
      <Text style={R.fieldLabel}>{label}</Text>

      {/* Date button */}
      <TouchableOpacity
        style={R.fieldBtn}
        onPress={() => { setShowTime(false); setShowDate(v => !v); }}
        activeOpacity={0.75}
      >
        <Text style={R.fieldIcon}>📅</Text>
        <Text style={R.fieldValue}>{dateStr}</Text>
        <Text style={R.fieldChevron}>{showDate ? "▲" : "▼"}</Text>
      </TouchableOpacity>

      {showDate && (
        <View style={R.pickerInline}>
          <DateTimePicker
            value={value}
            mode="date"
            display={Platform.OS === "ios" ? "inline" : "default"}
            onChange={handleDateChange}
            minimumDate={new Date()}
            style={R.iosPicker}
          />
        </View>
      )}

      {/* Time button */}
      <TouchableOpacity
        style={[R.fieldBtn, { marginTop: 8 }]}
        onPress={() => { setShowDate(false); setShowTime(v => !v); }}
        activeOpacity={0.75}
      >
        <Text style={R.fieldIcon}>⏰</Text>
        <Text style={R.fieldValue}>{timeStr}</Text>
        <Text style={R.fieldChevron}>{showTime ? "▲" : "▼"}</Text>
      </TouchableOpacity>

      {showTime && (
        <View style={R.pickerInline}>
          <DateTimePicker
            value={value}
            mode="time"
            is24Hour={true}
            display={Platform.OS === "ios" ? "spinner" : "default"}
            onChange={handleTimeChange}
            style={R.iosPicker}
          />
        </View>
      )}
    </View>
  );
}

// ─── Main Modal ──────────────────────────────────────────────────────────────
export default function RescheduleModal({ visible, quiz, onClose, onSuccess }: Props) {
  const [startDate, setStartDate] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date());
  const [saving, setSaving] = useState(false);

  // FIX: Track which quiz_id we've already initialized for, so re-opening
  // the same modal doesn't re-init and wipe user edits, but a *different*
  // quiz (shouldn't happen, but safe) correctly re-seeds the values.
  const [initializedFor, setInitializedFor] = useState<string | null>(null);

  useEffect(() => {
    if (visible && quiz && quiz.quiz_id !== initializedFor) {
      setStartDate(new Date(quiz.scheduled_start));
      setEndDate(new Date(quiz.scheduled_end));
      setInitializedFor(quiz.quiz_id);
    }
    // Intentionally NOT resetting when visible flips false→true for the same quiz.
    // The user's edited values should survive a close/reopen if the quiz hasn't changed.
  }, [visible, quiz?.quiz_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // FIX: Reset initializedFor when the modal is definitively closed by the
  // parent (e.g. after a successful save and refresh produces a new quiz object).
  // We detect "new quiz" via quiz_id changing, handled above.

  const handleSave = useCallback(async () => {
    if (endDate <= startDate) {
      Alert.alert("Invalid Window", "End time must be after the start time.");
      return;
    }

    try {
      setSaving(true);
      const response = await fetch(`${API_URL}/api/quizzes/${quiz.quiz_id}/reschedule`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teacher_id: quiz.teacher_id,
          scheduled_start: startDate.toISOString(),
          scheduled_end: endDate.toISOString(),
        }),
      });

      const result = await response.json();
      if (!result.success) throw new Error(result.error || "Update failed");

      Alert.alert("Success", "Schedule updated successfully!", [
        {
          text: "OK",
          onPress: () => {
            // FIX: Reset initializedFor so the next open re-seeds from the
            // freshly refreshed quiz data that the parent will fetch.
            setInitializedFor(null);
            // FIX: Call onSuccess ONLY — let the parent handle closing.
            // Previously both onSuccess() and onClose() were called here and
            // in handleRescheduleSuccess, causing a double-close race.
            onSuccess();
          },
        },
      ]);
    } catch (err: any) {
      Alert.alert("Server Error", err.message);
    } finally {
      setSaving(false);
    }
  }, [startDate, endDate, quiz, onSuccess]);

  const handleClose = useCallback(() => {
    // Don't wipe the user's edits — they survive for the same quiz_id.
    onClose();
  }, [onClose]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <SafeAreaView style={S.container}>
        <ScrollView
          contentContainerStyle={S.scrollBody}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View style={S.header}>
            <View>
              <Text style={S.title}>Reschedule Quiz</Text>
              <Text style={S.subtitle}>{quiz?.title || "Assessment"}</Text>
            </View>
            <TouchableOpacity style={S.closeBtn} onPress={handleClose}>
              <Text style={S.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Duration hint */}
          {endDate > startDate && (
            <View style={S.durationBadge}>
              <Text style={S.durationText}>
                ⏱ Duration:{" "}
                {Math.round((endDate.getTime() - startDate.getTime()) / 60000)} min
              </Text>
            </View>
          )}

          {/* Start */}
          <DateTimeRow
            label="Start Window"
            value={startDate}
            onChange={setStartDate}
          />

          {/* End */}
          <DateTimeRow
            label="End Window"
            value={endDate}
            onChange={setEndDate}
          />

          {/* Actions */}
          <View style={S.footer}>
            <TouchableOpacity style={S.secondaryBtn} onPress={handleClose}>
              <Text style={S.secondaryBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.primaryBtn, saving && { opacity: 0.6 }]}
              onPress={handleSave}
              disabled={saving}
            >
              {saving
                ? <ActivityIndicator color="#FFF" />
                : <Text style={S.primaryBtnText}>Save Schedule</Text>}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const R = StyleSheet.create({
  fieldGroup: {
    marginBottom: 20,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: GREY,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  fieldBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFF",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 10,
  },
  fieldIcon: { fontSize: 16 },
  fieldValue: { flex: 1, fontSize: 15, fontWeight: "600", color: "#1F2937" },
  fieldChevron: { fontSize: 10, color: GREY },
  pickerInline: {
    backgroundColor: "#F8F9FA",
    borderRadius: 12,
    marginTop: 6,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    overflow: "hidden",
    alignItems: "center",
  },
  iosPicker: { width: "100%" },
});

const S = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  scrollBody: { padding: 24, paddingBottom: 40 },

  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  title: { fontSize: 24, fontWeight: "800", color: "#1F2937" },
  subtitle: { fontSize: 14, color: GREY, marginTop: 2 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
  },
  closeBtnText: { fontSize: 14, color: GREY, fontWeight: "700" },

  durationBadge: {
    backgroundColor: "#EFF6FF",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginBottom: 20,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#BFDBFE",
  },
  durationText: { fontSize: 13, fontWeight: "600", color: PRIMARY },

  footer: { flexDirection: "row", gap: 14, marginTop: 32 },
  primaryBtn: {
    flex: 2,
    height: 54,
    backgroundColor: PRIMARY,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  primaryBtnText: { color: "#FFF", fontWeight: "800", fontSize: 15 },
  secondaryBtn: {
    flex: 1,
    height: 54,
    borderWidth: 1.5,
    borderColor: "#D1D5DB",
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  secondaryBtnText: { color: GREY, fontWeight: "600" },
});