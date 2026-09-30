import React, { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  PRIMARY, PRIMARY_LIGHT, BG, GREEN, GREY,
  Quiz, QuizQuestion, API_URL, msToCountdown,
} from "./quizViewConstants";
import QuizHeaderCard from "./QuizHeaderCard";
import RescheduleModal from "./RescheduleModal";

// ─── Simple Question Card ────────────────────────────────────────────────────
function QuestionCard({
  question, index, onChange,
}: {
  question: QuizQuestion; index: number; onChange: (q: QuizQuestion) => void;
}) {
  const isMCQ = question.type === "mcq";

  const updateOption = (i: number, text: string) => {
    const opts = [...(question.options ?? [])];
    const wasCorrect = opts[i] === question.correct_answer;
    opts[i] = text;
    onChange({ ...question, options: opts, correct_answer: wasCorrect ? text : question.correct_answer });
  };

  const markCorrect = (i: number) => {
    onChange({ ...question, correct_answer: (question.options ?? [])[i] });
  };

  return (
    <View style={S.qCard}>
      {/* Header */}
      <View style={S.qHeader}>
        <Text style={S.qNum}>Q{index + 1}</Text>
        <Text style={S.qType}>{isMCQ ? "MCQ" : "Open"}</Text>
        <View style={{ flex: 1 }} />
        <View style={S.marksBadge}>
          <TextInput
            style={S.marksInput}
            keyboardType="numeric"
            value={String(question.marks)}
            onChangeText={(v) => onChange({ ...question, marks: Number(v) || 1 })}
            maxLength={3}
          />
          <Text style={S.marksPt}>pts</Text>
        </View>
      </View>

      {/* Question text */}
      <TextInput
        style={[S.input, S.textarea]}
        value={question.question}
        onChangeText={(v) => onChange({ ...question, question: v })}
        multiline
        placeholder="Enter question..."
        placeholderTextColor="#9CA3AF"
      />

      {/* MCQ options */}
      {isMCQ && (question.options ?? []).map((opt, i) => {
        const isCorrect = opt === question.correct_answer;
        return (
          <View key={i} style={S.optRow}>
            <TouchableOpacity
              style={[S.radio, isCorrect && S.radioDone]}
              onPress={() => markCorrect(i)}
            >
              {isCorrect && <Text style={S.radioCheck}>✓</Text>}
            </TouchableOpacity>
            <TextInput
              style={[S.input, S.optInput, isCorrect && S.optInputDone]}
              value={opt}
              onChangeText={(v) => updateOption(i, v)}
              placeholder={`Option ${String.fromCharCode(65 + i)}`}
              placeholderTextColor="#9CA3AF"
              multiline
            />
          </View>
        );
      })}

      {/* Open-ended answer */}
      {!isMCQ && (
        <TextInput
          style={[S.input, S.textarea]}
          value={question.correct_answer}
          onChangeText={(v) => onChange({ ...question, correct_answer: v })}
          multiline
          placeholder="Model answer..."
          placeholderTextColor="#9CA3AF"
        />
      )}
    </View>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────
interface Props {
  quiz: Quiz;
  questions: QuizQuestion[];
  countdown: string;
  onBack: () => void;
  onRefresh: () => void;
}

export default function QuizScheduledView({ quiz, questions, countdown, onBack, onRefresh }: Props) {
  const [localQuestions, setLocalQuestions] = useState<QuizQuestion[]>(questions);
  const [savingEdit, setSavingEdit] = useState(false);
  const [rescheduleVisible, setRescheduleVisible] = useState(false);
  const [liveCountdown, setLiveCountdown] = useState(countdown);

  useEffect(() => {
    setLocalQuestions(questions);
  }, [questions]);

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = new Date(quiz.scheduled_start).getTime() - Date.now();
      setLiveCountdown(msToCountdown(remaining));
    }, 1000);
    return () => clearInterval(interval);
  }, [quiz.scheduled_start]);

  const handleSaveQuestions = async () => {
    if (localQuestions.length === 0) return;
    try {
      setSavingEdit(true);
      const res = await fetch(`${API_URL}/api/quizzes/${quiz.quiz_id}/update-questions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teacher_id: quiz.teacher_id,
          questions: localQuestions.map((q) => ({
            question_id: q.question_id,
            type: q.type,
            question: q.question,
            options: q.type === "mcq" ? q.options : null,
            correct_answer: q.correct_answer,
            marks: Number(q.marks),
          })),
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error ?? "Failed to save");
      Alert.alert("Saved ✓", "Questions updated successfully.");
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleCancel = () => {
    Alert.alert(
      "Cancel Quiz",
      "Are you sure? This cannot be undone.",
      [
        { text: "Keep Quiz" },
        {
          text: "Cancel",
          style: "destructive",
          onPress: async () => {
            try {
              const res = await fetch(`${API_URL}/api/quizzes/${quiz.quiz_id}`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ teacher_id: quiz.teacher_id }),
              });
              const data = await res.json();
              if (!data.success) throw new Error(data.error ?? "Failed");
              Alert.alert("Cancelled", "Quiz has been cancelled.", [
                { text: "OK", onPress: onBack },
              ]);
            } catch (e: any) {
              Alert.alert("Error", e.message);
            }
          },
        },
      ]
    );
  };

  // FIX: Previously this called setRescheduleVisible(false) AND onRefresh(),
  // but RescheduleModal's handleSave was also calling onClose() after onSuccess(),
  // causing a double-close race. Now the modal owns its own close-after-save
  // (via the Alert OK button), and onSuccess here just closes + refreshes.
  const handleRescheduleSuccess = () => {
    setRescheduleVisible(false);
    onRefresh();
  };

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={S.content} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={S.backBtn} onPress={onBack}>
          <Text style={S.backIcon}>‹</Text>
        </TouchableOpacity>

        <Text style={S.title}>Scheduled Test</Text>
        <Text style={S.subtitle}>{quiz.subject_name}</Text>

        {/* Countdown */}
        <View style={S.countdownBox}>
          <Text style={S.countdownLabel}>Starts in</Text>
          <Text style={S.countdownTime}>{liveCountdown}</Text>
        </View>

        <QuizHeaderCard quiz={quiz} status="scheduled" submissionCount={0} />

        {/* Action buttons */}
        <View style={S.buttonRow}>
          <TouchableOpacity style={S.btn} onPress={() => setRescheduleVisible(true)}>
            <Text style={S.btnText}>📅 Reschedule</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[S.btn, S.btnDanger]} onPress={handleCancel}>
            <Text style={[S.btnText, S.btnTextDanger]}>✕ Cancel</Text>
          </TouchableOpacity>
        </View>

        {/* Questions */}
        {localQuestions.length > 0 ? (
          <>
            <Text style={S.sectionTitle}>Edit Questions</Text>
            {localQuestions.map((q, i) => (
              <QuestionCard
                key={q.question_id ?? i}
                question={q}
                index={i}
                onChange={(updated) => {
                  const copy = [...localQuestions];
                  copy[i] = updated;
                  setLocalQuestions(copy);
                }}
              />
            ))}

            <TouchableOpacity
              style={[S.saveBtn, savingEdit && { opacity: 0.7 }]}
              onPress={handleSaveQuestions}
              disabled={savingEdit}
            >
              {savingEdit
                ? <ActivityIndicator color="#FFF" />
                : <Text style={S.saveBtnText}>Save Changes</Text>
              }
            </TouchableOpacity>
          </>
        ) : (
          <Text style={S.emptyText}>No questions loaded</Text>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      <RescheduleModal
        visible={rescheduleVisible}
        quiz={quiz}
        onClose={() => setRescheduleVisible(false)}
        onSuccess={handleRescheduleSuccess}
      />
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 },

  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", marginBottom: 12, elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  backIcon: { fontSize: 22, fontWeight: "700", color: PRIMARY },

  title: { fontSize: 28, fontWeight: "800", color: "#111827", marginBottom: 4 },
  subtitle: { fontSize: 14, color: GREY, marginBottom: 16 },

  countdownBox: { backgroundColor: "#FFF", borderRadius: 14, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: "#E5E7EB" },
  countdownLabel: { fontSize: 12, color: GREY, fontWeight: "600" },
  countdownTime: { fontSize: 20, fontWeight: "800", color: PRIMARY, marginTop: 4, fontVariant: ["tabular-nums"] },

  buttonRow: { flexDirection: "row", gap: 10, marginBottom: 20 },
  btn: { flex: 1, height: 48, borderRadius: 12, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: PRIMARY },
  btnText: { color: PRIMARY, fontWeight: "700", fontSize: 13 },
  btnDanger: { backgroundColor: "#FEE2E2", borderColor: "#FCA5A5" },
  btnTextDanger: { color: "#DC2626" },

  sectionTitle: { fontSize: 16, fontWeight: "700", color: "#111827", marginBottom: 12, marginTop: 8 },

  qCard: { backgroundColor: "#FFF", borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB" },
  qHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  qNum: { fontWeight: "800", fontSize: 14, color: PRIMARY, minWidth: 30 },
  qType: { fontSize: 11, fontWeight: "700", color: GREY, backgroundColor: "#F3F4F6", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  marksBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
  marksInput: { fontSize: 14, fontWeight: "700", color: PRIMARY, textAlign: "center", minWidth: 30, backgroundColor: "#F3F4F6", borderRadius: 6, paddingVertical: 4 },
  marksPt: { fontSize: 11, color: GREY, fontWeight: "600" },

  input: { backgroundColor: "#F9FAFB", borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: "#111827", marginBottom: 10 },
  textarea: { minHeight: 80, textAlignVertical: "top" },

  optRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 10 },
  radio: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: "#E5E7EB", alignItems: "center", justifyContent: "center", marginTop: 8 },
  radioDone: { borderColor: GREEN, backgroundColor: GREEN },
  radioCheck: { color: "#FFF", fontWeight: "800", fontSize: 14 },
  optInput: { flex: 1, minHeight: 40 },
  optInputDone: { borderColor: GREEN, backgroundColor: "#F0FDF4" },

  saveBtn: { backgroundColor: GREEN, borderRadius: 12, height: 50, alignItems: "center", justifyContent: "center", marginTop: 16 },
  saveBtnText: { color: "#FFF", fontWeight: "800", fontSize: 15 },

  emptyText: { color: GREY, textAlign: "center", marginTop: 20, fontSize: 14 },
});