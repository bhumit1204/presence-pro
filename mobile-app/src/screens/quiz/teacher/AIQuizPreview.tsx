// screens/quiz/teacher/AIQuizPreview.tsx — review and edit the AI-drafted questions
// Fixes: no gradient package needed any more, a draft without options no longer crashes,
// marks can be cleared while typing, and duplicate / empty options are caught before finalizing.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Animated, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { apiFetch } from "../../../services/api";
import { API_URL, readJson } from "./components/quizViewConstants";
import { Banner, Button, Chip, EmptyState, Header, Screen, SP, T, font } from "../../../components/ui";

const LABELS = ["A", "B", "C", "D", "E", "F"];

function Pulse() {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(a, { toValue: 0, duration: 800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  return <Animated.View style={[st.skeleton, { opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }]} />;
}

function Options({
  options,
  correct,
  onChange,
  onMark,
  onDelete,
  onAdd,
}: {
  options: string[];
  correct: string;
  onChange: (i: number, v: string) => void;
  onMark: (i: number) => void;
  onDelete: (i: number) => void;
  onAdd: () => void;
}) {
  return (
    <View style={{ gap: SP.sm }}>
      <Text style={st.sectionLabel}>Options - tap the circle to mark the correct one</Text>
      {options.map((opt, i) => {
        const isCorrect = opt.trim() !== "" && opt.trim() === (correct || "").trim();
        return (
          <View key={i} style={st.optRow}>
            <Pressable
              onPress={() => onMark(i)}
              style={[st.radio, isCorrect && st.radioOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: isCorrect }}
              accessibilityLabel={`Mark option ${LABELS[i] ?? i + 1} correct`}
            >
              {isCorrect && <View style={st.radioDot} />}
            </Pressable>
            <View style={[st.badge, isCorrect && { backgroundColor: T.successSoft }]}>
              <Text style={[st.badgeTxt, isCorrect && { color: "#065F46" }]}>{LABELS[i] ?? i + 1}</Text>
            </View>
            <TextInput
              style={[st.input, { flex: 1, minHeight: 42 }, isCorrect && st.inputOn]}
              multiline
              value={opt}
              placeholder={`Option ${LABELS[i] ?? i + 1}`}
              placeholderTextColor={T.muted}
              onChangeText={(v) => onChange(i, v)}
            />
            <Pressable onPress={() => onDelete(i)} hitSlop={8} style={st.remove} accessibilityLabel={`Remove option ${LABELS[i] ?? i + 1}`}>
              <Ionicons name="close" size={14} color={T.danger} />
            </Pressable>
          </View>
        );
      })}
      {options.length < 6 && (
        <Pressable onPress={onAdd} style={st.addOpt}>
          <Ionicons name="add" size={16} color={T.primary} />
          <Text style={st.addOptTxt}>Add option</Text>
        </Pressable>
      )}
    </View>
  );
}

export default function AIQuizPreview() {
  const navigation = useNavigation<any>();
  const { formData, meta } = (useRoute<any>().params || {}) as { formData: any; meta?: { title?: string; description?: string } };

  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState<any[]>([]);
  const [error, setError] = useState("");
  const alive = useRef(true);

  const generate = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const res = await apiFetch(`${API_URL}/api/quizzes/generate-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await readJson(res);
      if (!alive.current) return;
      if (!data?.success) {
        setError(data?.error || "The AI could not generate questions. Try again.");
        return;
      }
      setQuestions(
        (data.questions || []).map((q: any) => ({
          ...q,
          options: q.type === "mcq" ? (Array.isArray(q.options) ? q.options.map((o: any) => (typeof o === "string" ? o : o?.text ?? "")) : []) : null,
        }))
      );
    } catch {
      if (alive.current) setError("Something went wrong. Check your connection and try again.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [formData]);

  useEffect(() => {
    alive.current = true;
    generate();
    return () => {
      alive.current = false;
    };
  }, [generate]);

  /* ── edits (functional updates so fast typing never loses a change) ── */
  const patch = (i: number, fn: (q: any) => any) => setQuestions((prev) => prev.map((q, idx) => (idx === i ? fn(q) : q)));
  const setField = (i: number, field: string, value: any) => patch(i, (q) => ({ ...q, [field]: value }));
  const removeQuestion = (i: number) => setQuestions((prev) => prev.filter((_, idx) => idx !== i));

  const setOption = (qi: number, oi: number, value: string) =>
    patch(qi, (q) => {
      const old = q.options[oi];
      const options = q.options.map((o: string, idx: number) => (idx === oi ? value : o));
      return { ...q, options, correct_answer: q.correct_answer === old ? value : q.correct_answer };
    });
  const markCorrect = (qi: number, oi: number) => patch(qi, (q) => ({ ...q, correct_answer: q.options[oi] }));
  const removeOption = (qi: number, oi: number) =>
    patch(qi, (q) => {
      const wasCorrect = q.options[oi] === q.correct_answer;
      const options = q.options.filter((_: string, idx: number) => idx !== oi);
      return { ...q, options, correct_answer: wasCorrect ? options[0] ?? "" : q.correct_answer };
    });
  const addOption = (qi: number) => patch(qi, (q) => ({ ...q, options: [...q.options, ""] }));

  /* ── validate + continue ── */
  const finalize = () => {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const n = `Q${i + 1}`;
      if (!q.question?.trim()) return Alert.alert("Check your quiz", `${n}: the question text is empty.`);
      if (!Number(q.marks) || Number(q.marks) < 1) return Alert.alert("Check your quiz", `${n}: marks must be at least 1.`);
      if (q.type === "mcq") {
        const filled = q.options.map((o: string) => o.trim()).filter(Boolean);
        if (filled.length < 2) return Alert.alert("Check your quiz", `${n}: fill in at least two options.`);
        if (new Set(filled.map((o: string) => o.toLowerCase())).size !== filled.length) return Alert.alert("Check your quiz", `${n}: two options have the same text.`);
        if (!q.correct_answer || !q.options.includes(q.correct_answer) || !q.correct_answer.trim()) return Alert.alert("Check your quiz", `${n}: mark the correct option.`);
      } else if (!q.correct_answer?.trim()) {
        return Alert.alert("Check your quiz", `${n}: add the expected answer.`);
      }
    }

    navigation.navigate("FinalizeQuizScreen", {
      quizData: {
        teacher_id: formData.teacher_id,
        subject_id: formData.subject_id,
        title: meta?.title || "Untitled quiz",
        description: meta?.description || "",
        syllabus: formData.syllabus || "",
        question_type: formData.question_type,
        notify_students: true,
        questions: questions.map((q) => ({
          type: q.type,
          question: q.question.trim(),
          options: q.type === "mcq" ? q.options.filter((o: string) => o.trim()) : null,
          correct_answer: q.correct_answer,
          marks: Number(q.marks),
        })),
      },
    });
  };

  const totalMarks = questions.reduce((s, q) => s + (Number(q.marks) || 0), 0);

  return (
    <Screen>
      <Header title={meta?.title || "Quiz preview"} subtitle={meta?.description || "Edit before finalizing"} onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {loading && (
            <>
              <Banner tone="info" icon="sparkles">
                Writing your questions. This usually takes a few seconds.
              </Banner>
              {[1, 2, 3].map((i) => (
                <Pulse key={i} />
              ))}
            </>
          )}

          {!loading && !!error && (
            <View style={{ gap: SP.md }}>
              <EmptyState icon="alert-circle-outline" title="Could not generate questions" text={error} />
              <Button label="Try again" icon="refresh" onPress={generate} />
            </View>
          )}

          {!loading && !error && questions.length === 0 && (
            <View style={{ gap: SP.md }}>
              <EmptyState icon="trash-outline" title="No questions left" text="You deleted every question. Generate a new set to continue." />
              <Button label="Generate again" icon="refresh" onPress={generate} />
            </View>
          )}

          {!loading && !error && questions.length > 0 && (
            <View style={st.summary}>
              <Chip icon="help-circle-outline" tone="primary" label={`${questions.length} questions`} />
              <Chip icon="trophy-outline" tone="primary" label={`${totalMarks} marks`} />
            </View>
          )}

          {!loading &&
            !error &&
            questions.map((q, index) => (
              <View key={index} style={st.card}>
                <View style={st.cardHead}>
                  <View style={st.qBadge}>
                    <Text style={st.qBadgeTxt}>Q{index + 1}</Text>
                  </View>
                  <Chip label={q.type === "mcq" ? "MCQ" : "Written"} tone={q.type === "mcq" ? "primary" : "warning"} />
                  <View style={{ flex: 1 }} />
                  <Pressable
                    onPress={() =>
                      Alert.alert("Delete question", `Remove Q${index + 1}?`, [
                        { text: "Cancel", style: "cancel" },
                        { text: "Delete", style: "destructive", onPress: () => removeQuestion(index) },
                      ])
                    }
                    style={st.del}
                    accessibilityLabel={`Delete question ${index + 1}`}
                  >
                    <Ionicons name="trash-outline" size={16} color={T.danger} />
                    <Text style={st.delTxt}>Delete</Text>
                  </Pressable>
                </View>

                <Text style={st.sectionLabel}>Question</Text>
                <TextInput style={[st.input, st.textarea]} multiline value={q.question} onChangeText={(v) => setField(index, "question", v)} placeholderTextColor={T.muted} />

                {q.type === "mcq" ? (
                  <Options
                    options={q.options || []}
                    correct={q.correct_answer || ""}
                    onChange={(oi, v) => setOption(index, oi, v)}
                    onMark={(oi) => markCorrect(index, oi)}
                    onDelete={(oi) => removeOption(index, oi)}
                    onAdd={() => addOption(index)}
                  />
                ) : (
                  <>
                    <Text style={st.sectionLabel}>Expected answer</Text>
                    <TextInput style={[st.input, st.textarea]} multiline value={q.correct_answer || ""} onChangeText={(v) => setField(index, "correct_answer", v)} placeholderTextColor={T.muted} />
                  </>
                )}

                <Text style={st.sectionLabel}>Marks</Text>
                <TextInput
                  style={[st.input, { width: 90 }, q.editable_marks === false && { backgroundColor: T.lineSoft, color: T.muted }]}
                  editable={q.editable_marks !== false}
                  keyboardType="number-pad"
                  value={String(q.marks ?? "")}
                  onChangeText={(v) => setField(index, "marks", v.replace(/\D/g, "").slice(0, 3))}
                  maxLength={3}
                />
              </View>
            ))}
        </ScrollView>
      </KeyboardAvoidingView>

      {!loading && !error && questions.length > 0 && (
        <View style={st.footer}>
          <Button label="Finalize quiz" icon="arrow-forward" onPress={finalize} />
        </View>
      )}
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, gap: SP.lg, paddingBottom: 30 },
  skeleton: { height: 150, borderRadius: 22, backgroundColor: T.line },
  summary: { flexDirection: "row", gap: SP.sm },
  card: { backgroundColor: T.surface, borderRadius: 22, padding: SP.lg, borderWidth: 1, borderColor: T.line },
  cardHead: { flexDirection: "row", alignItems: "center", gap: SP.sm, marginBottom: SP.sm },
  qBadge: { backgroundColor: T.primary, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 },
  qBadgeTxt: { color: "#fff", fontWeight: "800", fontSize: 13 },
  del: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: T.dangerSoft, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  delTxt: { color: T.danger, fontWeight: "700", fontSize: 12 },
  sectionLabel: { ...font.label, marginTop: SP.md, marginBottom: SP.sm },
  input: { borderWidth: 1.5, borderColor: T.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: T.bg, fontSize: 14.5, color: T.ink },
  textarea: { minHeight: 80, textAlignVertical: "top" },
  inputOn: { borderColor: T.success, backgroundColor: T.successSoft },
  optRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: T.line, alignItems: "center", justifyContent: "center", marginTop: 10 },
  radioOn: { borderColor: T.success },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: T.success },
  badge: { width: 26, height: 26, borderRadius: 8, backgroundColor: T.primarySoft, alignItems: "center", justifyContent: "center", marginTop: 8 },
  badgeTxt: { fontSize: 12, fontWeight: "800", color: T.primary },
  remove: { width: 28, height: 28, borderRadius: 14, backgroundColor: T.dangerSoft, alignItems: "center", justifyContent: "center", marginTop: 7 },
  addOpt: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderWidth: 1.5, borderColor: T.primary, borderStyle: "dashed", borderRadius: 12, paddingVertical: 10, backgroundColor: T.primarySoft },
  addOptTxt: { color: T.primary, fontWeight: "700", fontSize: 13 },
  footer: { padding: SP.lg, paddingHorizontal: SP.xl, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.surface },
});