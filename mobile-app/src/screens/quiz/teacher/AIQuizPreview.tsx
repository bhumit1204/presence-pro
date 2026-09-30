import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Animated,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation } from "@react-navigation/native";
import { LinearGradient } from "expo-linear-gradient";

const PRIMARY       = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG            = "#F3F4F6";
const GREEN         = "#10B981";
const GREEN_LIGHT   = "#D1FAE5";
const RED           = "#EF4444";
const RED_LIGHT     = "#FEF2F2";
const AMBER_LIGHT   = "#FEF3C7";
const API_URL       = "http://10.132.90.56:5000";

const OPTION_LABELS = ["A", "B", "C", "D", "E", "F"];

// ─── Shimmer skeleton ─────────────────────────────────────────────────────────
function Shimmer() {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.timing(anim, { toValue: 1, duration: 1200, useNativeDriver: true })
    ).start();
  }, []);

  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [-200, 200] });

  return (
    <View style={styles.skeleton}>
      <Animated.View style={[StyleSheet.absoluteFillObject, { transform: [{ translateX }] }]}>
        <LinearGradient
          colors={["transparent", "rgba(255,255,255,0.5)", "transparent"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ flex: 1 }}
        />
      </Animated.View>
    </View>
  );
}

// ─── MCQ Option row with radio ────────────────────────────────────────────────
// options: string[]  correct_answer: string (exact text of the correct option)
function MCQOptions({
  options,
  correctAnswer,
  onChangeOption,
  onMarkCorrect,
  onDeleteOption,
  onAddOption,
}: {
  options: string[];
  correctAnswer: string;
  onChangeOption: (i: number, val: string) => void;
  onMarkCorrect: (i: number) => void;
  onDeleteOption: (i: number) => void;
  onAddOption: () => void;
}) {
  return (
    <View>
      <Text style={styles.sectionLabel}>Options  •  tap ○ to mark correct</Text>

      {options.map((opt, i) => {
        const isCorrect = opt.trim() !== "" && opt.trim() === correctAnswer.trim();

        return (
          <View key={i} style={opt_s.row}>
            {/* Radio button */}
            <TouchableOpacity
              style={[opt_s.radio, isCorrect && opt_s.radioOn]}
              onPress={() => onMarkCorrect(i)}
            >
              {isCorrect && <View style={opt_s.radioDot} />}
            </TouchableOpacity>

            {/* Letter badge */}
            <View style={[opt_s.badge, isCorrect && opt_s.badgeOn]}>
              <Text style={[opt_s.badgeTxt, isCorrect && opt_s.badgeTxtOn]}>
                {OPTION_LABELS[i] ?? i + 1}
              </Text>
            </View>

            {/* Option text input */}
            <TextInput
              style={[opt_s.input, isCorrect && opt_s.inputOn]}
              multiline
              value={opt}
              placeholder={`Option ${OPTION_LABELS[i] ?? i + 1}`}
              placeholderTextColor="#9CA3AF"
              onChangeText={(val) => onChangeOption(i, val)}
            />

            {/* Delete option */}
            <TouchableOpacity style={opt_s.removeBtn} onPress={() => onDeleteOption(i)}>
              <Text style={opt_s.removeTxt}>✕</Text>
            </TouchableOpacity>
          </View>
        );
      })}

      {/* Add option */}
      {options.length < 6 && (
        <TouchableOpacity style={opt_s.addBtn} onPress={onAddOption}>
          <Text style={opt_s.addTxt}>+ Add Option</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const opt_s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginBottom: 8 },
  radio: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: "#D1D5DB",
    alignItems: "center", justifyContent: "center", marginTop: 11,
  },
  radioOn: { borderColor: GREEN },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: GREEN },
  badge: {
    width: 26, height: 26, borderRadius: 8,
    backgroundColor: PRIMARY_LIGHT,
    alignItems: "center", justifyContent: "center", marginTop: 8,
  },
  badgeOn: { backgroundColor: GREEN_LIGHT },
  badgeTxt: { fontSize: 12, fontWeight: "700", color: PRIMARY },
  badgeTxtOn: { color: "#065F46" },
  input: {
    flex: 1,
    backgroundColor: "#F9FAFB",
    borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 9,
    fontSize: 14, color: "#111827", minHeight: 42,
  },
  inputOn: { borderColor: GREEN, backgroundColor: "#F0FDF4" },
  removeBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: RED_LIGHT,
    alignItems: "center", justifyContent: "center", marginTop: 7,
  },
  removeTxt: { color: RED, fontSize: 12, fontWeight: "700" },
  addBtn: {
    borderWidth: 1.5, borderColor: PRIMARY, borderStyle: "dashed",
    borderRadius: 12, paddingVertical: 10,
    alignItems: "center", marginTop: 4, backgroundColor: PRIMARY_LIGHT,
  },
  addTxt: { color: PRIMARY, fontWeight: "700", fontSize: 13 },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function AIQuizPreview() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const { formData, meta } = route.params;

  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState<any[]>([]);
  const [error, setError] = useState("");

  /* FETCH */
  useEffect(() => { generatePreview(); }, []);

  const generatePreview = async () => {
    try {
      setLoading(true);
      setError("");

      const res = await fetch(`${API_URL}/api/quizzes/generate-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const data = await res.json();

      if (!data.success) { setError(data.error); return; }

      setQuestions(data.questions || []);
    } catch (e) {
      setError("Something went wrong. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  /* ── Question-level helpers ── */
  const updateQuestion = (index: number, field: string, value: any) => {
    const copy = [...questions];
    copy[index] = { ...copy[index], [field]: value };
    setQuestions(copy);
  };

  const deleteQuestion = (index: number) =>
    setQuestions(questions.filter((_, i) => i !== index));

  /* ── Option-level helpers ── */
  const updateOption = (qIndex: number, optIndex: number, value: string) => {
    const copy = [...questions];
    const oldText = copy[qIndex].options[optIndex];
    copy[qIndex] = { ...copy[qIndex], options: [...copy[qIndex].options] };
    copy[qIndex].options[optIndex] = value;

    // If this was the correct answer, keep correct_answer in sync
    if (copy[qIndex].correct_answer === oldText) {
      copy[qIndex].correct_answer = value;
    }

    setQuestions(copy);
  };

  //  Mark correct by index — sets correct_answer to the option's text
  const markCorrectOption = (qIndex: number, optIndex: number) => {
    const copy = [...questions];
    copy[qIndex] = {
      ...copy[qIndex],
      correct_answer: copy[qIndex].options[optIndex],
    };
    setQuestions(copy);
  };

  const deleteOption = (qIndex: number, optIndex: number) => {
    const copy = [...questions];
    const opts = [...copy[qIndex].options];
    const wasCorrect = opts[optIndex] === copy[qIndex].correct_answer;
    opts.splice(optIndex, 1);
    copy[qIndex] = {
      ...copy[qIndex],
      options: opts,
      // If deleted option was correct, reset to first option
      correct_answer: wasCorrect ? (opts[0] ?? "") : copy[qIndex].correct_answer,
    };
    setQuestions(copy);
  };

  const addOption = (qIndex: number) => {
    const copy = [...questions];
    copy[qIndex] = {
      ...copy[qIndex],
      options: [...copy[qIndex].options, ""],
    };
    setQuestions(copy);
  };

  /* ── Validate + finalize ── */
  const handleFinalize = () => {
    try {
      // Validate all MCQ questions have a valid correct_answer
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (q.type === "mcq") {
          const filledOptions = q.options.filter((o: string) => o.trim());
          if (filledOptions.length < 2) {
            throw new Error(`Q${i + 1}: Please fill at least 2 options.`);
          }
          if (!q.correct_answer || !q.options.includes(q.correct_answer)) {
            throw new Error(`Q${i + 1}: Please select a correct answer by tapping ○ next to an option.`);
          }
        }
        if (!q.question?.trim()) {
          throw new Error(`Q${i + 1}: Question text cannot be empty.`);
        }
        if (!q.marks || Number(q.marks) < 1) {
          throw new Error(`Q${i + 1}: Marks must be at least 1.`);
        }
      }

      const payload = {
        teacher_id: formData.teacher_id,
        subject_id: formData.subject_id,
        title: meta?.title || "Untitled Quiz",
        description: meta?.description || "",
        syllabus: formData.syllabus || "",
        question_type: formData.question_type,
        notify_students: true,
        questions: questions.map((q) => ({
          type: q.type,
          question: q.question,
          //  options is string[] for MCQ, null for open_ended
          options: q.type === "mcq" ? q.options.filter((o: string) => o.trim()) : null,
          correct_answer: q.correct_answer,
          marks: Number(q.marks),
        })),
      };

      navigation.navigate("FinalizeQuizScreen", { quizData: payload });

    } catch (e: any) {
      Alert.alert("Validation Error", e.message);
    }
  };

  /* ── UI ── */
  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Back */}
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>

        <Text style={styles.title}>{meta?.title || "Quiz Preview"}</Text>
        <Text style={styles.subtitle}>{meta?.description || "Edit before finalizing"}</Text>

        {/* Loading skeletons */}
        {loading && [1, 2, 3].map((i) => <Shimmer key={i} />)}

        {/* Error state */}
        {!loading && error !== "" && (
          <View style={styles.center}>
            <Text style={styles.error}>{error}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={generatePreview}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Questions */}
        {!loading && error === "" && questions.map((q, index) => (
          <View key={index} style={styles.card}>

            {/* Card header */}
            <View style={styles.rowBetween}>
              <View style={styles.qBadge}>
                <Text style={styles.qBadgeTxt}>Q{index + 1}</Text>
              </View>
              <View style={[styles.typeBadge, q.type === "open_ended" && styles.typeBadgeOpen]}>
                <Text style={[styles.typeTxt, q.type === "open_ended" && styles.typeTxtOpen]}>
                  {q.type === "mcq" ? "MCQ" : "Open Ended"}
                </Text>
              </View>
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() =>
                  Alert.alert("Delete", "Remove this question?", [
                    { text: "Cancel" },
                    { text: "Delete", style: "destructive", onPress: () => deleteQuestion(index) },
                  ])
                }
              >
                <Text style={styles.deleteText}>Delete</Text>
              </TouchableOpacity>
            </View>

            {/* Question text */}
            <Text style={styles.sectionLabel}>Question</Text>
            <TextInput
              style={[styles.input, styles.textarea]}
              multiline
              value={q.question}
              onChangeText={(val) => updateQuestion(index, "question", val)}
            />

            {/* MCQ options with radio buttons */}
            {q.type === "mcq" && (
              <MCQOptions
                options={q.options}
                correctAnswer={q.correct_answer}
                onChangeOption={(i, val) => updateOption(index, i, val)}
                onMarkCorrect={(i) => markCorrectOption(index, i)}
                onDeleteOption={(i) => deleteOption(index, i)}
                onAddOption={() => addOption(index)}
              />
            )}

            {/* Open ended answer */}
            {q.type === "open_ended" && (
              <>
                <Text style={styles.sectionLabel}>Expected Answer</Text>
                <TextInput
                  style={[styles.input, styles.textarea]}
                  multiline
                  value={q.correct_answer}
                  onChangeText={(val) => updateQuestion(index, "correct_answer", val)}
                />
              </>
            )}

            {/* Marks */}
            <Text style={styles.sectionLabel}>Marks</Text>
            <TextInput
              style={[styles.input, styles.marksInput, !q.editable_marks && styles.disabled]}
              editable={q.editable_marks !== false}
              keyboardType="numeric"
              value={String(q.marks)}
              onChangeText={(val) => updateQuestion(index, "marks", Number(val) || 1)}
            />

          </View>
        ))}

        {/* Finalize */}
        {!loading && error === "" && questions.length > 0 && (
          <TouchableOpacity style={styles.submitBtn} onPress={handleFinalize}>
            <Text style={styles.submitText}>Finalize Quiz →</Text>
          </TouchableOpacity>
        )}

        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, paddingHorizontal: 20 },
  content: { paddingBottom: 60, paddingTop: 4 },

  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: "#FFF",
    justifyContent: "center", alignItems: "center",
    marginBottom: 14,
    elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6,
  },
  backIcon: { fontSize: 22, fontWeight: "800", color: PRIMARY },

  title: { fontSize: 28, fontWeight: "800", color: "#111827", letterSpacing: 0.2 },
  subtitle: { color: "#6B7280", marginBottom: 16, fontSize: 14, lineHeight: 20 },

  skeleton: { height: 150, borderRadius: 22, backgroundColor: "#E5E7EB", marginBottom: 14, overflow: "hidden" },

  card: {
    backgroundColor: "#FFF",
    borderRadius: 26,
    paddingVertical: 18, paddingHorizontal: 16,
    marginBottom: 14,
    borderWidth: 1, borderColor: "#E5E7EB",
    shadowColor: PRIMARY, shadowOpacity: 0.05, shadowRadius: 12, elevation: 2,
  },

  rowBetween: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },

  qBadge: { backgroundColor: PRIMARY, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 },
  qBadgeTxt: { color: "#FFF", fontWeight: "800", fontSize: 13 },

  typeBadge: { backgroundColor: PRIMARY_LIGHT, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  typeBadgeOpen: { backgroundColor: AMBER_LIGHT },
  typeTxt: { color: PRIMARY, fontWeight: "700", fontSize: 11 },
  typeTxtOpen: { color: "#92400E" },

  deleteBtn: { backgroundColor: RED_LIGHT, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  deleteText: { color: RED, fontWeight: "700", fontSize: 12 },

  sectionLabel: {
    fontSize: 12, fontWeight: "700",
    marginTop: 12, marginBottom: 8,
    color: "#6B7280",
    textTransform: "uppercase", letterSpacing: 0.5,
  },

  input: {
    borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 11,
    marginBottom: 4,
    backgroundColor: "#F9FAFB",
    fontSize: 14, color: "#111827",
  },
  textarea: { minHeight: 80, textAlignVertical: "top" },
  marksInput: { width: 90 },
  disabled: { backgroundColor: "#F3F4F6", color: "#9CA3AF" },

  center: { alignItems: "center", marginTop: 50 },
  error: { color: RED, marginBottom: 12, fontSize: 14, fontWeight: "500" },
  retryBtn: { backgroundColor: PRIMARY, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 24 },
  retryText: { color: "#FFF", fontWeight: "600", fontSize: 14 },

  submitBtn: {
    height: 58, backgroundColor: PRIMARY,
    borderRadius: 18,
    justifyContent: "center", alignItems: "center",
    marginTop: 8,
    shadowColor: PRIMARY, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6,
  },
  submitText: { color: "#FFF", fontWeight: "800", fontSize: 16, letterSpacing: 0.3 },
});