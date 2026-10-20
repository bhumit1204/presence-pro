// screens/quiz/teacher/CreateQuizAI.tsx — describe the syllabus, the AI drafts the questions on the next screen
import React, { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";
import { Banner, Button, Card, EmptyState, Header, Screen, Segmented, SP, T, TextField, ToggleRow } from "../../../components/ui";

type QType = "mcq" | "open_ended" | "mixed";
type Level = "Easy" | "Medium" | "Hard";

const MAX_QUESTIONS = 50;

export default function CreateQuizAI() {
  const navigation = useNavigation<any>();
  const subject = useRoute<any>().params?.subject;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [syllabus, setSyllabus] = useState("");
  const [questionCount, setQuestionCount] = useState("10");
  const [marks, setMarks] = useState("2");
  const [sameMarks, setSameMarks] = useState(true);
  const [questionType, setQuestionType] = useState<QType>("mixed");
  const [difficulty, setDifficulty] = useState<Level>("Medium");
  const [errs, setErrs] = useState<Partial<Record<"title" | "syllabus" | "count" | "marks", string>>>({});
  const [busy, setBusy] = useState(false);

  if (!subject?.subject_id) {
    return (
      <Screen>
        <Header title="Create quiz (AI)" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="No subject selected" text="Go back and choose a subject first." />
      </Screen>
    );
  }

  const clear = (k: keyof typeof errs) => errs[k] && setErrs((e) => ({ ...e, [k]: undefined }));

  const generate = async () => {
    if (busy) return;
    const count = Number(questionCount);
    const perQ = Number(marks);
    const next: typeof errs = {};
    if (!title.trim()) next.title = "Give the quiz a title";
    if (syllabus.trim().length < 10) next.syllabus = "Describe the topics in a few words (at least 10 characters)";
    if (!Number.isInteger(count) || count < 1 || count > MAX_QUESTIONS) next.count = `Enter 1 to ${MAX_QUESTIONS}`;
    if (sameMarks && (!Number.isInteger(perQ) || perQ < 1 || perQ > 100)) next.marks = "Enter 1 to 100";
    setErrs(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      const session = await getUserSession();
      if (!session?.teacher_id) {
        Alert.alert("Session expired", "Please log in again.");
        return;
      }
      navigation.navigate("QuizPreviewScreen", {
        formData: {
          teacher_id: session.teacher_id,
          subject_id: subject.subject_id,
          syllabus: syllabus.trim(),
          question_count: count,
          question_type: questionType,
          difficulty: difficulty.toLowerCase(),
          custom_marks_enabled: !sameMarks,
          marks_per_question: sameMarks ? perQ : undefined,
        },
        meta: { title: title.trim(), description: description.trim() },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Header title="Create quiz (AI)" subtitle={subject.subject_name} onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Banner tone="info" icon="sparkles">
            The AI drafts the questions, and you can edit or delete any of them before the quiz is created.
          </Banner>

          <Card>
            <View style={{ gap: SP.lg }}>
              <TextField
                label="Title"
                value={title}
                onChangeText={(t) => {
                  setTitle(t);
                  clear("title");
                }}
                placeholder="e.g. Python mid-sem test"
                autoCapitalize="sentences"
                autoCorrect
                error={errs.title}
                maxLength={120}
              />
              <TextField label="Description (optional)" value={description} onChangeText={setDescription} placeholder="A short note for students" multiline minHeight={72} autoCapitalize="sentences" maxLength={300} />
              <TextField
                label="Syllabus / topics"
                value={syllabus}
                onChangeText={(t) => {
                  setSyllabus(t);
                  clear("syllabus");
                }}
                placeholder="e.g. Python basics, loops, functions, OOP"
                multiline
                minHeight={104}
                autoCapitalize="sentences"
                error={errs.syllabus}
                helper="The more specific the topics, the better the questions."
                maxLength={2000}
              />
            </View>
          </Card>

          <Card>
            <View style={{ gap: SP.lg }}>
              <View>
                <Text style={st.label}>Question type</Text>
                <Segmented
                  options={[
                    { value: "mcq" as QType, label: "MCQ" },
                    { value: "open_ended" as QType, label: "Written" },
                    { value: "mixed" as QType, label: "Mixed" },
                  ]}
                  value={questionType}
                  onChange={setQuestionType}
                />
              </View>
              <View>
                <Text style={st.label}>Difficulty</Text>
                <Segmented
                  options={(["Easy", "Medium", "Hard"] as Level[]).map((l) => ({ value: l, label: l }))}
                  value={difficulty}
                  onChange={setDifficulty}
                />
              </View>
              <View style={st.two}>
                <TextField
                  style={{ flex: 1 }}
                  label="Questions"
                  value={questionCount}
                  onChangeText={(t) => {
                    setQuestionCount(t.replace(/\D/g, ""));
                    clear("count");
                  }}
                  keyboardType="number-pad"
                  error={errs.count}
                  maxLength={2}
                />
                <TextField
                  style={{ flex: 1 }}
                  label="Marks each"
                  value={marks}
                  onChangeText={(t) => {
                    setMarks(t.replace(/\D/g, ""));
                    clear("marks");
                  }}
                  keyboardType="number-pad"
                  editable={sameMarks}
                  error={errs.marks}
                  maxLength={3}
                />
              </View>
              <ToggleRow
                title="Same marks for every question"
                sub={sameMarks ? "Every question carries the marks above." : "The AI decides marks per question. You can edit them next."}
                value={sameMarks}
                onChange={setSameMarks}
              />
            </View>
          </Card>

          <Button label="Generate questions" icon="sparkles" onPress={generate} loading={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, gap: SP.lg, paddingBottom: 40 },
  label: { fontSize: 12.5, fontWeight: "700", color: T.sub, marginBottom: 7, letterSpacing: 0.2 },
  two: { flexDirection: "row", gap: SP.md },
});