// screens/quiz/teacher/CreateQuizManual.tsx — build a quiz question by question (text and pictures)
// Fixes: "Edit" now loads the question into the builder (it used to open an EMPTY form),
// option removal no longer mutates state, duplicate options are rejected, uploads cannot be double-tapped.

import React, { useRef, useState } from "react";
import { Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import { apiFetch } from "../../../services/api";
import { getUserSession } from "../../../services/session";
import { API_URL, readJson } from "./components/quizViewConstants";
import { Banner, Button, Card, Chip, EmptyState, Header, Screen, Segmented, SP, Steps, T, TextField, font } from "../../../components/ui";

const LABELS = ["A", "B", "C", "D", "E", "F"];

interface MCQOption {
  text: string;
  isCorrect: boolean;
  image_url: string | null;
}
interface Question {
  type: "mcq" | "open_ended";
  question: string;
  image_url: string | null;
  options: MCQOption[];
  correct_answer: string;
  marks: number;
}

const blankOptions = (): MCQOption[] => [
  { text: "", isCorrect: true, image_url: null },
  { text: "", isCorrect: false, image_url: null },
  { text: "", isCorrect: false, image_url: null },
  { text: "", isCorrect: false, image_url: null },
];

/** Upload through the existing endpoint; returns the file URL or null. */
async function uploadImage(uri: string): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("folder", "assignments");
    form.append("files", { uri, name: `question_img_${Date.now()}.jpg`, type: "image/jpeg" } as any);
    const res = await apiFetch(`${API_URL}/api/assignments/upload`, { method: "POST", body: form });
    const data = await readJson(res);
    return data?.success && data.files?.[0] ? (data.files[0].url as string) : null;
  } catch {
    return null;
  }
}

async function pickAndUpload(quality: number): Promise<string | null | undefined> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    Alert.alert("Permission needed", "Allow photo access to add pictures.");
    return undefined;
  }
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality });
  if (r.canceled || !r.assets?.[0]) return undefined;
  const url = await uploadImage(r.assets[0].uri);
  if (!url) Alert.alert("Upload failed", "Could not upload the picture. Try again.");
  return url;
}

// ─── picture button ───────────────────────────────────────────────────────────
function PictureButton({ url, onPick, onRemove, busy, label, small }: { url: string | null; onPick: () => void; onRemove: () => void; busy: boolean; label: string; small?: boolean }) {
  if (url) {
    return (
      <View style={{ gap: 6, marginTop: 6 }}>
        <Image source={{ uri: url }} style={{ width: "100%", height: small ? 90 : 160, borderRadius: 12, backgroundColor: T.bg }} resizeMode="cover" />
        <Pressable onPress={onRemove} style={st.removePic}>
          <Ionicons name="trash-outline" size={14} color={T.danger} />
          <Text style={st.removePicTxt}>Remove picture</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <Pressable onPress={busy ? undefined : onPick} style={[st.addPic, small && { paddingVertical: 7 }]} accessibilityRole="button">
      {busy ? <Ionicons name="cloud-upload-outline" size={16} color={T.primary} /> : <Ionicons name="image-outline" size={16} color={T.primary} />}
      <Text style={st.addPicTxt}>{busy ? "Uploading..." : label}</Text>
    </Pressable>
  );
}

// ─── MCQ options ──────────────────────────────────────────────────────────────
function OptionEditor({ options, onChange }: { options: MCQOption[]; onChange: (o: MCQOption[]) => void }) {
  const [busyIdx, setBusyIdx] = useState<number | null>(null);

  const setText = (i: number, text: string) => onChange(options.map((o, idx) => (idx === i ? { ...o, text } : o)));
  const markCorrect = (i: number) => onChange(options.map((o, idx) => ({ ...o, isCorrect: idx === i })));
  const add = () => options.length < 6 && onChange([...options, { text: "", isCorrect: false, image_url: null }]);
  const remove = (i: number) => {
    if (options.length <= 2) return Alert.alert("Minimum", "A multiple choice question needs at least two options.");
    const next = options.filter((_, idx) => idx !== i);
    if (options[i].isCorrect) next[0] = { ...next[0], isCorrect: true }; // a new object, never mutate state
    onChange(next);
  };
  const pick = async (i: number) => {
    setBusyIdx(i);
    const url = await pickAndUpload(0.7);
    setBusyIdx(null);
    if (url) onChange(options.map((o, idx) => (idx === i ? { ...o, image_url: url } : o)));
  };

  return (
    <View style={{ gap: SP.md }}>
      <Text style={st.fieldLabel}>Options - tap the circle to mark the correct one</Text>
      {options.map((opt, i) => (
        <View key={i} style={{ gap: 4 }}>
          <View style={st.optRow}>
            <Pressable
              onPress={() => markCorrect(i)}
              style={[st.radio, opt.isCorrect && st.radioOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: opt.isCorrect }}
              accessibilityLabel={`Mark option ${LABELS[i]} correct`}
            >
              {opt.isCorrect && <View style={st.radioDot} />}
            </Pressable>
            <View style={[st.badge, opt.isCorrect && { backgroundColor: T.successSoft }]}>
              <Text style={[st.badgeTxt, opt.isCorrect && { color: "#065F46" }]}>{LABELS[i]}</Text>
            </View>
            <TextField_ value={opt.text} onChangeText={(t) => setText(i, t)} placeholder={`Option ${LABELS[i]}`} on={opt.isCorrect} />
            <Pressable onPress={() => remove(i)} hitSlop={8} style={st.removeBtn} accessibilityLabel={`Remove option ${LABELS[i]}`}>
              <Ionicons name="close" size={14} color={T.danger} />
            </Pressable>
          </View>
          <View style={{ paddingLeft: 56 }}>
            <PictureButton
              url={opt.image_url}
              onPick={() => pick(i)}
              onRemove={() => onChange(options.map((o, idx) => (idx === i ? { ...o, image_url: null } : o)))}
              busy={busyIdx === i}
              label="Add picture to this option"
              small
            />
          </View>
        </View>
      ))}
      {options.length < 6 && (
        <Pressable onPress={add} style={st.addOpt}>
          <Ionicons name="add" size={16} color={T.primary} />
          <Text style={st.addOptTxt}>Add option</Text>
        </Pressable>
      )}
    </View>
  );
}

// small bare text box used inside option rows (TextField's label/helper layout is too heavy here)
function TextField_({ value, onChangeText, placeholder, on }: { value: string; onChangeText: (t: string) => void; placeholder: string; on?: boolean }) {
  return (
    <TextInput
      style={[st.input, { flex: 1, minHeight: 42 }, on && st.inputOn]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={T.muted}
      multiline
    />
  );
}

// ─── Question builder (also used to edit) ─────────────────────────────────────
function QuestionBuilder({
  number,
  total,
  initial,
  editing,
  onSave,
  onPreview,
  onCancelEdit,
}: {
  number: number;
  total: number;
  initial: Question | null;
  editing: boolean;
  onSave: (q: Question) => void;
  onPreview: () => void;
  onCancelEdit: () => void;
}) {
  const [type, setType] = useState<"mcq" | "open_ended">(initial?.type ?? "mcq");
  const [text, setText] = useState(initial?.question ?? "");
  const [image, setImage] = useState<string | null>(initial?.image_url ?? null);
  const [marks, setMarks] = useState(String(initial?.marks ?? 1));
  const [openAnswer, setOpenAnswer] = useState(initial && initial.type === "open_ended" ? initial.correct_answer : "");
  const [options, setOptions] = useState<MCQOption[]>(() => {
    if (!initial || initial.type !== "mcq") return blankOptions();
    const o = initial.options.map((x) => ({ ...x, isCorrect: x.text === initial.correct_answer }));
    return o.length >= 4 ? o : [...o, ...blankOptions().slice(o.length)].map((x, i) => ({ ...x, isCorrect: i < o.length ? x.isCorrect : false }));
  });
  const [imgBusy, setImgBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickQuestionImage = async () => {
    setImgBusy(true);
    const url = await pickAndUpload(0.8);
    setImgBusy(false);
    if (url) setImage(url);
  };

  const save = () => {
    setError(null);
    const marksNum = Number(marks);
    if (!text.trim()) return setError("Enter the question text.");
    if (!Number.isInteger(marksNum) || marksNum < 1 || marksNum > 100) return setError("Marks must be a whole number from 1 to 100.");

    if (type === "mcq") {
      const filled = options.filter((o) => o.text.trim() || o.image_url);
      if (filled.length < 2) return setError("Fill in at least two options (text or picture).");
      const correct = options.find((o) => o.isCorrect);
      if (!correct || (!correct.text.trim() && !correct.image_url)) return setError("Mark a correct option and give it text or a picture.");

      // picture-only options get a label so the answer can be matched by text
      const finalOptions: MCQOption[] = filled.map((o) => ({ ...o, text: o.text.trim() || `Option ${LABELS[options.indexOf(o)]}` }));
      const names = finalOptions.map((o) => o.text.toLowerCase());
      if (new Set(names).size !== names.length) return setError("Two options have the same text. Make each one different.");

      onSave({ type: "mcq", question: text.trim(), image_url: image, options: finalOptions, correct_answer: finalOptions.find((o) => o.isCorrect)!.text, marks: marksNum });
    } else {
      if (!openAnswer.trim()) return setError("Enter the model answer.");
      onSave({ type: "open_ended", question: text.trim(), image_url: image, options: [], correct_answer: openAnswer.trim(), marks: marksNum });
    }
  };

  return (
    <Card>
      <View style={st.builderHead}>
        <View style={st.qNum}>
          <Text style={st.qNumTxt}>Q{number}</Text>
        </View>
        <Text style={[font.h2, { flex: 1 }]}>{editing ? `Editing question ${number}` : "New question"}</Text>
        {total > 0 && <Chip label={`${total} added`} tone="success" />}
      </View>

      {editing && (
        <Banner tone="warning" icon="create-outline" style={{ marginBottom: SP.md }}>
          <Pressable onPress={onCancelEdit}>
            <Text style={[font.body, { fontSize: 13 }]}>
              Change the details and tap Update. <Text style={{ color: T.danger, fontWeight: "800" }}>Cancel editing</Text>
            </Text>
          </Pressable>
        </Banner>
      )}

      <View style={{ gap: SP.lg }}>
        <View>
          <Text style={st.fieldLabel}>Question type</Text>
          <Segmented options={[{ value: "mcq" as const, label: "Multiple choice" }, { value: "open_ended" as const, label: "Written" }]} value={type} onChange={setType} />
        </View>

        <TextField label="Question" value={text} onChangeText={setText} placeholder="Type your question here" multiline minHeight={96} autoCapitalize="sentences" />

        <View>
          <Text style={st.fieldLabel}>Question picture (optional)</Text>
          <PictureButton url={image} onPick={pickQuestionImage} onRemove={() => setImage(null)} busy={imgBusy} label="Add a picture to the question" />
        </View>

        {type === "mcq" ? (
          <OptionEditor options={options} onChange={setOptions} />
        ) : (
          <TextField label="Model answer" value={openAnswer} onChangeText={setOpenAnswer} placeholder="Write the ideal answer" multiline minHeight={96} autoCapitalize="sentences" />
        )}

        <TextField style={{ width: 130 }} label="Marks" value={marks} onChangeText={(t) => setMarks(t.replace(/\D/g, "").slice(0, 3))} keyboardType="number-pad" maxLength={3} />

        {!!error && <Banner tone="danger">{error}</Banner>}

        <View style={{ flexDirection: "row", gap: SP.md }}>
          <Button label={editing ? "Update question" : "Add question"} icon={editing ? "checkmark" : "add"} onPress={save} disabled={imgBusy} style={{ flex: 1.5 }} />
          <Button label="Preview" icon="eye-outline" variant="secondary" onPress={onPreview} style={{ flex: 1 }} />
        </View>
      </View>
    </Card>
  );
}

// ─── Preview sheet ────────────────────────────────────────────────────────────
function PreviewModal({ visible, questions, onClose, onEdit, onDelete }: { visible: boolean; questions: Question[]; onClose: () => void; onEdit: (i: number) => void; onDelete: (i: number) => void }) {
  const totalMarks = questions.reduce((s, q) => s + q.marks, 0);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen edges={["top", "bottom"]}>
        <Header title="Preview" subtitle={`${questions.length} questions - ${totalMarks} marks`} right={<Button label="Close" size="md" variant="secondary" onPress={onClose} />} />
        <ScrollView contentContainerStyle={{ padding: SP.xl, gap: SP.md, paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
          {questions.length === 0 && <EmptyState icon="document-text-outline" title="No questions yet" text="Add a question to see it here." />}
          {questions.map((q, i) => (
            <View key={i} style={st.pCard}>
              <View style={st.pHead}>
                <View style={st.qNum}>
                  <Text style={st.qNumTxt}>Q{i + 1}</Text>
                </View>
                <Chip label={q.type === "mcq" ? "MCQ" : "Written"} tone={q.type === "mcq" ? "primary" : "warning"} />
                <Chip label={`${q.marks} mark${q.marks > 1 ? "s" : ""}`} tone="success" />
                <View style={{ flex: 1 }} />
                <Pressable
                  onPress={() => {
                    onClose();
                    onEdit(i);
                  }}
                  style={st.editBtn}
                >
                  <Text style={st.editBtnTxt}>Edit</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    Alert.alert("Delete question", `Remove Q${i + 1}?`, [
                      { text: "Cancel", style: "cancel" },
                      { text: "Delete", style: "destructive", onPress: () => onDelete(i) },
                    ])
                  }
                  style={st.delBtn}
                  accessibilityLabel={`Delete question ${i + 1}`}
                >
                  <Ionicons name="trash-outline" size={15} color={T.danger} />
                </Pressable>
              </View>

              <Text style={st.pText}>{q.question}</Text>
              {!!q.image_url && <Image source={{ uri: q.image_url }} style={st.pImg} resizeMode="contain" />}

              {q.type === "mcq" ? (
                <View style={{ gap: 8, marginTop: SP.md }}>
                  {q.options.map((o, oi) => {
                    const ok = o.text === q.correct_answer;
                    return (
                      <View key={oi} style={[st.pOpt, ok && st.pOptOn]}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <View style={[st.badge, { width: 22, height: 22 }, ok && { backgroundColor: T.successSoft }]}>
                            <Text style={[st.badgeTxt, { fontSize: 11 }, ok && { color: "#065F46" }]}>{LABELS[oi]}</Text>
                          </View>
                          <Text style={[st.pOptTxt, ok && { color: "#065F46", fontWeight: "700" }]}>{o.text}</Text>
                          {ok && <Ionicons name="checkmark-circle" size={16} color={T.success} />}
                        </View>
                        {!!o.image_url && <Image source={{ uri: o.image_url }} style={{ width: "100%", height: 80, borderRadius: 8, marginTop: 6 }} resizeMode="cover" />}
                      </View>
                    );
                  })}
                </View>
              ) : (
                <View style={st.model}>
                  <Text style={st.modelLbl}>Model answer</Text>
                  <Text style={st.modelTxt}>{q.correct_answer}</Text>
                </View>
              )}
            </View>
          ))}
        </ScrollView>
      </Screen>
    </Modal>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────────
export default function CreateQuizManual() {
  const navigation = useNavigation<any>();
  const subject = useRoute<any>().params?.subject ?? null;

  const [stage, setStage] = useState<1 | 2>(1);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [titleErr, setTitleErr] = useState<string | undefined>();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const totalMarks = questions.reduce((s, q) => s + q.marks, 0);

  const save = (q: Question) => {
    if (editing !== null) {
      setQuestions((prev) => prev.map((x, i) => (i === editing ? q : x)));
      setEditing(null);
    } else {
      setQuestions((prev) => [...prev, q]);
    }
    setTimeout(() => scrollRef.current?.scrollTo({ y: 0, animated: true }), 80);
  };

  const remove = (i: number) => {
    setQuestions((prev) => prev.filter((_, idx) => idx !== i));
    setEditing((e) => (e === null ? null : e === i ? null : e > i ? e - 1 : e));
  };

  const goBack = () => {
    if (stage === 2) return setStage(1);
    if (questions.length === 0) return navigation.goBack();
    Alert.alert("Discard this quiz?", `${questions.length} question${questions.length > 1 ? "s" : ""} will be lost.`, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => navigation.goBack() },
    ]);
  };

  const finalize = async () => {
    if (busy) return;
    if (questions.length === 0) return Alert.alert("No questions", "Add at least one question.");
    if (!title.trim()) return Alert.alert("Title needed", "Quiz title is required.");
    if (!subject?.subject_id) return Alert.alert("Subject missing", "Go back and select the subject again.");
    setBusy(true);
    try {
      const session = await getUserSession();
      if (!session?.teacher_id) {
        Alert.alert("Session expired", "Please log in again.");
        return;
      }
      const hasM = questions.some((q) => q.type === "mcq");
      const hasO = questions.some((q) => q.type === "open_ended");
      navigation.navigate("FinalizeQuizScreen", {
        quizData: {
          teacher_id: session.teacher_id,
          subject_id: subject.subject_id,
          title: title.trim(),
          description: description.trim() || null,
          syllabus: null,
          question_type: hasM && hasO ? "mixed" : hasM ? "mcq" : "open_ended",
          notify_students: true,
          questions: questions.map((q) => ({
            type: q.type,
            question: q.question,
            image_url: q.image_url || null,
            options: q.type === "mcq" ? q.options.map((o) => ({ text: o.text, image_url: o.image_url || null })) : null,
            correct_answer: q.correct_answer,
            marks: Number(q.marks),
          })),
        },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Header title="Create quiz" subtitle={`${subject?.subject_name ?? "Manual"} - build questions yourself`} onBack={goBack} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView ref={scrollRef} contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Steps steps={[{ label: "Quiz info", icon: "document-text" }, { label: "Questions", icon: "help-circle" }]} current={stage - 1} />

          {stage === 1 && (
            <Card>
              <Text style={[font.h2, { marginBottom: SP.lg }]}>Quiz info</Text>
              <View style={{ gap: SP.lg }}>
                <TextField
                  label="Quiz title"
                  value={title}
                  onChangeText={(t) => {
                    setTitle(t);
                    setTitleErr(undefined);
                  }}
                  placeholder="e.g. Python mid-sem test"
                  autoCapitalize="sentences"
                  autoCorrect
                  error={titleErr}
                  maxLength={120}
                />
                <TextField label="Description (optional)" value={description} onChangeText={setDescription} placeholder="A short note for students" multiline minHeight={80} autoCapitalize="sentences" maxLength={300} />
                <Button
                  label="Continue to questions"
                  icon="arrow-forward"
                  onPress={() => (title.trim() ? setStage(2) : setTitleErr("Enter a quiz title"))}
                />
              </View>
            </Card>
          )}

          {stage === 2 && (
            <>
              {questions.length > 0 && (
                <View style={st.stats}>
                  {[
                    { v: questions.length, l: "Questions" },
                    { v: totalMarks, l: "Total marks" },
                    { v: questions.filter((q) => q.type === "mcq").length, l: "MCQ" },
                    { v: questions.filter((q) => q.type === "open_ended").length, l: "Written" },
                  ].map((s, i, arr) => (
                    <React.Fragment key={s.l}>
                      <View style={st.stat}>
                        <Text style={st.statVal}>{s.v}</Text>
                        <Text style={st.statLbl}>{s.l}</Text>
                      </View>
                      {i < arr.length - 1 && <View style={st.statDiv} />}
                    </React.Fragment>
                  ))}
                </View>
              )}

              <QuestionBuilder
                key={editing !== null ? `edit-${editing}` : `new-${questions.length}`}
                number={editing !== null ? editing + 1 : questions.length + 1}
                total={questions.length}
                initial={editing !== null ? questions[editing] : null}
                editing={editing !== null}
                onSave={save}
                onPreview={() => setPreviewOpen(true)}
                onCancelEdit={() => setEditing(null)}
              />

              {questions.length > 0 && (
                <Button label={`Finalize quiz (${questions.length} questions, ${totalMarks} marks)`} icon="checkmark-circle-outline" variant="success" onPress={finalize} loading={busy} />
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <PreviewModal
        visible={previewOpen}
        questions={questions}
        onClose={() => setPreviewOpen(false)}
        onEdit={(i) => {
          setEditing(i);
          setPreviewOpen(false);
        }}
        onDelete={remove}
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, gap: SP.lg, paddingBottom: 50 },
  fieldLabel: { fontSize: 12.5, fontWeight: "700", color: T.sub, marginBottom: 7, letterSpacing: 0.2 },

  builderHead: { flexDirection: "row", alignItems: "center", gap: SP.md, marginBottom: SP.lg },
  qNum: { backgroundColor: T.primary, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 4 },
  qNumTxt: { color: "#fff", fontWeight: "800", fontSize: 12.5 },

  input: { backgroundColor: T.bg, borderWidth: 1.5, borderColor: T.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14.5, color: T.ink },
  inputOn: { borderColor: T.success, backgroundColor: T.successSoft },

  optRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: T.line, alignItems: "center", justifyContent: "center", marginTop: 10 },
  radioOn: { borderColor: T.success },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: T.success },
  badge: { width: 26, height: 26, borderRadius: 8, backgroundColor: T.primarySoft, alignItems: "center", justifyContent: "center", marginTop: 8 },
  badgeTxt: { fontSize: 12, fontWeight: "800", color: T.primary },
  removeBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: T.dangerSoft, alignItems: "center", justifyContent: "center", marginTop: 7 },
  addOpt: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderWidth: 1.5, borderColor: T.primary, borderStyle: "dashed", borderRadius: 12, paddingVertical: 10, backgroundColor: T.primarySoft },
  addOptTxt: { color: T.primary, fontWeight: "700", fontSize: 13 },

  addPic: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", borderWidth: 1.5, borderStyle: "dashed", borderColor: T.primary, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14, backgroundColor: T.primarySoft, marginTop: 6 },
  addPicTxt: { color: T.primary, fontWeight: "700", fontSize: 13 },
  removePic: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 5, backgroundColor: T.dangerSoft, borderRadius: 8 },
  removePicTxt: { color: T.danger, fontSize: 12, fontWeight: "700" },

  stats: { backgroundColor: T.surface, borderRadius: 18, padding: SP.md, flexDirection: "row", borderWidth: 1, borderColor: T.line },
  stat: { flex: 1, alignItems: "center" },
  statVal: { fontSize: 18, fontWeight: "800", color: T.primary },
  statLbl: { fontSize: 11, color: T.sub, fontWeight: "600", marginTop: 2 },
  statDiv: { width: 1, backgroundColor: T.line },

  pCard: { backgroundColor: T.surface, borderRadius: 20, padding: SP.lg, borderWidth: 1, borderColor: T.line },
  pHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: SP.md, flexWrap: "wrap" },
  editBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 12, borderWidth: 1.5, borderColor: T.primary },
  editBtnTxt: { color: T.primary, fontWeight: "700", fontSize: 12 },
  delBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: T.dangerSoft, alignItems: "center", justifyContent: "center" },
  pText: { fontSize: 15, color: T.ink, fontWeight: "600", lineHeight: 22 },
  pImg: { width: "100%", height: 170, borderRadius: 12, marginTop: SP.md, backgroundColor: T.bg },
  pOpt: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: T.bg, borderWidth: 1, borderColor: T.line },
  pOptOn: { backgroundColor: T.successSoft, borderColor: T.success },
  pOptTxt: { fontSize: 14, color: T.ink, flex: 1 },
  model: { marginTop: SP.md, backgroundColor: T.warningSoft, borderRadius: 10, padding: SP.md },
  modelLbl: { fontSize: 11, fontWeight: "700", color: T.warning, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  modelTxt: { fontSize: 14, color: "#7A4A00", lineHeight: 20 },
});