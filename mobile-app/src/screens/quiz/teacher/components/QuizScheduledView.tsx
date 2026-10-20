// screens/quiz/teacher/components/QuizScheduledView.tsx — a quiz that has not started: edit questions or cancel
import React, { useEffect, useState } from "react";
import { Alert, Image, ScrollView, StyleSheet, Text, TextInput, View, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "../../../../services/api";
import { Banner, Button, Chip, EmptyState, Header, Screen, SP, T, font } from "../../../../components/ui";
import { API_URL, Quiz, QuizOptionValue, QuizQuestion, msToCountdown, optImage, optText, readJson } from "./quizViewConstants";
import QuizHeaderCard from "./QuizHeaderCard";

// ─── One editable question ────────────────────────────────────────────────────
function QuestionCard({ question, index, onChange }: { question: QuizQuestion; index: number; onChange: (q: QuizQuestion) => void }) {
  const isMCQ = question.type === "mcq";
  const options = question.options ?? [];

  const setOptionText = (i: number, text: string) => {
    const next = [...options];
    const old = next[i];
    const wasCorrect = optText(old) === question.correct_answer;
    // keep the picture when the option is an object, stay a plain string when it was one
    next[i] = typeof old === "string" || old == null ? text : { ...old, text };
    onChange({ ...question, options: next as QuizOptionValue[], correct_answer: wasCorrect ? text : question.correct_answer });
  };

  return (
    <View style={st.qCard}>
      <View style={st.qHeader}>
        <View style={st.qNum}>
          <Text style={st.qNumTxt}>Q{index + 1}</Text>
        </View>
        <Chip label={isMCQ ? "MCQ" : "Written"} tone={isMCQ ? "primary" : "warning"} />
        <View style={{ flex: 1 }} />
        <View style={st.marksWrap}>
          <TextInput
            style={st.marksInput}
            keyboardType="numeric"
            value={String(question.marks ?? "")}
            onChangeText={(v) => onChange({ ...question, marks: v.replace(/[^0-9]/g, "") === "" ? ("" as any) : Number(v.replace(/[^0-9]/g, "")) })}
            maxLength={3}
            accessibilityLabel={`Marks for question ${index + 1}`}
          />
          <Text style={st.marksPt}>marks</Text>
        </View>
      </View>

      <TextInput
        style={[st.input, st.textarea]}
        value={question.question}
        onChangeText={(v) => onChange({ ...question, question: v })}
        multiline
        placeholder="Question text"
        placeholderTextColor={T.muted}
      />
      {!!question.image_url && <Image source={{ uri: question.image_url }} style={st.qImage} resizeMode="contain" />}

      {isMCQ &&
        options.map((opt, i) => {
          const text = optText(opt);
          const correct = !!text && text === question.correct_answer;
          const img = optImage(opt);
          return (
            <View key={i} style={st.optRow}>
              <Pressable
                onPress={() => onChange({ ...question, correct_answer: optText(options[i]) })}
                style={[st.tick, correct && st.tickOn]}
                accessibilityRole="radio"
                accessibilityState={{ selected: correct }}
                accessibilityLabel={`Mark option ${String.fromCharCode(65 + i)} correct`}
              >
                {correct && <Ionicons name="checkmark" size={15} color="#fff" />}
              </Pressable>
              <View style={{ flex: 1 }}>
                <TextInput
                  style={[st.input, { marginBottom: 0 }, correct && st.optOn]}
                  value={text}
                  onChangeText={(v) => setOptionText(i, v)}
                  placeholder={`Option ${String.fromCharCode(65 + i)}`}
                  placeholderTextColor={T.muted}
                  multiline
                />
                {!!img && <Image source={{ uri: img }} style={st.optImg} resizeMode="cover" />}
              </View>
            </View>
          );
        })}

      {!isMCQ && (
        <>
          <Text style={st.sub}>Model answer</Text>
          <TextInput
            style={[st.input, st.textarea]}
            value={question.correct_answer}
            onChangeText={(v) => onChange({ ...question, correct_answer: v })}
            multiline
            placeholder="Model answer"
            placeholderTextColor={T.muted}
          />
        </>
      )}
    </View>
  );
}

// The ticking clock lives in its own component so the rest of the screen
// is NOT re-rendered every second.
function Countdown({ startIso }: { startIso: string }) {
  const [text, setText] = useState(() => msToCountdown(new Date(startIso).getTime() - Date.now()));
  useEffect(() => {
    const tick = () => setText(msToCountdown(new Date(startIso).getTime() - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startIso]);
  return <Text style={st.cdTime}>{text}</Text>;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
interface Props {
  quiz: Quiz;
  questions: QuizQuestion[];
  onBack: () => void;
  onRefresh: () => void;
}

export default function QuizScheduledView({ quiz, questions, onBack, onRefresh }: Props) {
  const [local, setLocal] = useState<QuizQuestion[]>(questions);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // A background refresh must not wipe what the teacher is typing.
  useEffect(() => {
    if (!dirty) setLocal(questions);
  }, [questions]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (i: number, q: QuizQuestion) => {
    setDirty(true);
    setLocal((prev) => prev.map((x, idx) => (idx === i ? q : x)));
  };

  const validate = (): string | null => {
    for (let i = 0; i < local.length; i++) {
      const q = local[i];
      if (!q.question?.trim()) return `Q${i + 1}: the question text is empty.`;
      if (!Number(q.marks) || Number(q.marks) < 1) return `Q${i + 1}: marks must be at least 1.`;
      if (q.type === "mcq") {
        const texts = (q.options ?? []).map(optText).filter((t) => t.trim());
        if (texts.length < 2) return `Q${i + 1}: add at least two options.`;
        if (!texts.includes(q.correct_answer)) return `Q${i + 1}: choose a correct option.`;
      } else if (!q.correct_answer?.trim()) {
        return `Q${i + 1}: add a model answer.`;
      }
    }
    return null;
  };

  const save = async () => {
    if (saving || local.length === 0) return;
    const problem = validate();
    if (problem) {
      Alert.alert("Check your changes", problem);
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(`${API_URL}/api/quizzes/${encodeURIComponent(quiz.quiz_id)}/update-questions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teacher_id: quiz.teacher_id,
          questions: local.map((q) => ({
            question_id: q.question_id,
            type: q.type,
            question: q.question,
            image_url: q.image_url ?? null,
            options: q.type === "mcq" ? q.options : null,
            correct_answer: q.correct_answer,
            marks: Number(q.marks),
          })),
        }),
      });
      const data = await readJson(res);
      if (!data?.success) throw new Error(data?.error ?? "Failed to save");
      setDirty(false);
      Alert.alert("Saved", "Questions updated.");
      onRefresh();
    } catch (e: any) {
      Alert.alert("Could not save", e?.message || "Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const cancelQuiz = () =>
    Alert.alert("Cancel this quiz?", "Students will no longer see it. This cannot be undone.", [
      { text: "Keep quiz", style: "cancel" },
      {
        text: "Cancel quiz",
        style: "destructive",
        onPress: async () => {
          setCancelling(true);
          try {
            const res = await apiFetch(`${API_URL}/api/quizzes/${encodeURIComponent(quiz.quiz_id)}`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ teacher_id: quiz.teacher_id }),
            });
            const data = await readJson(res);
            if (!data?.success) throw new Error(data?.error ?? "Failed");
            Alert.alert("Quiz cancelled", "The quiz has been cancelled.", [{ text: "OK", onPress: onBack }]);
          } catch (e: any) {
            Alert.alert("Could not cancel", e?.message || "Check your connection and try again.");
          } finally {
            setCancelling(false);
          }
        },
      },
    ]);

  const back = () => {
    if (!dirty) return onBack();
    Alert.alert("Discard changes?", "You have unsaved question edits.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: onBack },
    ]);
  };

  return (
    <Screen>
      <Header title="Scheduled test" subtitle={quiz.subject_name} onBack={back} />
      <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={st.countdown}>
          <Text style={st.cdLabel}>Starts in</Text>
          <Countdown startIso={quiz.scheduled_start} />
        </View>

        <QuizHeaderCard quiz={quiz} status="scheduled" submissionCount={0} />

        <Button label="Cancel quiz" icon="close-circle-outline" variant="dangerSoft" size="md" onPress={cancelQuiz} loading={cancelling} />

        {local.length > 0 ? (
          <>
            <Text style={font.h2}>Edit questions</Text>
            {dirty && <Banner tone="warning" icon="create-outline">You have unsaved changes.</Banner>}
            {local.map((q, i) => (
              <QuestionCard key={q.question_id ?? i} question={q} index={i} onChange={(u) => edit(i, u)} />
            ))}
            <Button label="Save changes" icon="save-outline" variant="success" onPress={save} loading={saving} disabled={!dirty} />
          </>
        ) : (
          <EmptyState icon="help-circle-outline" title="No questions loaded" text="Pull back and open the quiz again." />
        )}
      </ScrollView>

    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, gap: SP.lg, paddingBottom: 40 },
  countdown: { backgroundColor: T.surface, borderRadius: 18, padding: SP.lg, borderWidth: 1, borderColor: T.line, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cdLabel: { fontSize: 13, color: T.sub, fontWeight: "600" },
  cdTime: { fontSize: 22, fontWeight: "800", color: T.primary, fontVariant: ["tabular-nums"] },

  qCard: { backgroundColor: T.surface, borderRadius: 20, padding: SP.lg, borderWidth: 1, borderColor: T.line, gap: SP.sm },
  qHeader: { flexDirection: "row", alignItems: "center", gap: SP.sm, marginBottom: 2 },
  qNum: { backgroundColor: T.primary, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 3 },
  qNumTxt: { color: "#fff", fontWeight: "800", fontSize: 12.5 },
  marksWrap: { flexDirection: "row", alignItems: "center", gap: 5 },
  marksInput: { fontSize: 14, fontWeight: "800", color: T.primary, textAlign: "center", minWidth: 38, backgroundColor: T.primarySoft, borderRadius: 8, paddingVertical: 5 },
  marksPt: { fontSize: 11.5, color: T.sub, fontWeight: "600" },

  input: { backgroundColor: T.bg, borderWidth: 1.5, borderColor: T.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5, color: T.ink },
  textarea: { minHeight: 76, textAlignVertical: "top" },
  qImage: { width: "100%", height: 150, borderRadius: 10, backgroundColor: T.bg },
  sub: { fontSize: 11.5, fontWeight: "700", color: T.sub, textTransform: "uppercase", letterSpacing: 0.6, marginTop: 4 },

  optRow: { flexDirection: "row", alignItems: "flex-start", gap: SP.md },
  tick: { width: 26, height: 26, borderRadius: 8, borderWidth: 2, borderColor: T.line, alignItems: "center", justifyContent: "center", marginTop: 9, backgroundColor: T.surface },
  tickOn: { borderColor: T.success, backgroundColor: T.success },
  optOn: { borderColor: T.success, backgroundColor: T.successSoft },
  optImg: { width: "100%", height: 90, borderRadius: 8, marginTop: 6, backgroundColor: T.bg },
});