import React, { useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Modal,
  ActivityIndicator,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";
import * as ImagePicker from "expo-image-picker";

const API_URL_BASE = "http://10.132.90.56:5000";

// ─── Upload image to R2 via the existing /upload endpoint ──────────────────────
async function uploadImageToR2(uri: string, folder: string): Promise<string | null> {
  try {
    const fileName = `question_img_${Date.now()}.jpg`;
    const formData = new FormData();
    formData.append("folder", folder);
    formData.append("files", { uri, name: fileName, type: "image/jpeg" } as any);
    const res  = await fetch(`${API_URL_BASE}/api/assignments/upload`, { method: "POST", body: formData });
    const data = await res.json();
    if (data.success && data.files?.[0]) return data.files[0].url as string;
    return null;
  } catch {
    return null;
  }
}

// ─── Small reusable image picker button ────────────────────────────────────────
function ImagePickerBtn({
  imageUri,
  onPick,
  onRemove,
  uploading,
  label = "Add Image",
  size = "normal",
}: {
  imageUri: string | null;
  onPick: () => void;
  onRemove: () => void;
  uploading?: boolean;
  label?: string;
  size?: "normal" | "small";
}) {
  if (imageUri) {
    return (
      <View style={imgBtn.wrap}>
        <Image source={{ uri: imageUri }} style={size === "small" ? imgBtn.thumbSmall : imgBtn.thumb} resizeMode="cover" />
        <TouchableOpacity style={imgBtn.removeBtn} onPress={onRemove}>
          <Text style={imgBtn.removeTxt}>✕ Remove</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <TouchableOpacity style={[imgBtn.btn, size === "small" && imgBtn.btnSmall]} onPress={onPick} disabled={uploading}>
      {uploading
        ? <ActivityIndicator size="small" color={PRIMARY} />
        : <>
            <Text style={imgBtn.icon}>🖼</Text>
            <Text style={[imgBtn.txt, size === "small" && { fontSize: 11 }]}>{label}</Text>
          </>
      }
    </TouchableOpacity>
  );
}

const PRIMARY   = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG        = "#F3F4F6";
const GREEN     = "#10B981";
const GREEN_LIGHT = "#D1FAE5";
const AMBER     = "#F59E0B";
const AMBER_LIGHT = "#FEF3C7";
const RED       = "#EF4444";
const RED_LIGHT = "#FEF2F2";

const imgBtn = StyleSheet.create({
  wrap:        { marginTop: 6, marginBottom: 4 },
  thumb:       { width: "100%", height: 160, borderRadius: 12, marginBottom: 6 },
  thumbSmall:  { width: "100%", height: 100, borderRadius: 10, marginBottom: 4 },
  btn:         { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1.5, borderStyle: "dashed", borderColor: PRIMARY, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14, backgroundColor: PRIMARY_LIGHT, marginTop: 6 },
  btnSmall:    { paddingVertical: 6, paddingHorizontal: 10 },
  icon:        { fontSize: 14 },
  txt:         { color: PRIMARY, fontWeight: "700", fontSize: 13 },
  removeBtn:   { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, backgroundColor: RED_LIGHT, borderRadius: 8 },
  removeTxt:   { color: RED, fontSize: 12, fontWeight: "700" },
});

// ─── Types ─────────────────────────────────────────────────────────────────────
interface MCQOption {
  text: string;
  isCorrect: boolean;
  image_url: string | null; // image attached to this option
}

interface Question {
  type: "mcq" | "open_ended";
  question: string;
  image_url: string | null;  // image attached to the question itself
  options: MCQOption[];
  correct_answer: string;
  marks: number;
}

// ─── Field label ────────────────────────────────────────────────────────────────
const FieldLabel = ({ text }: { text: string }) => (
  <Text style={S.fieldLabel}>{text}</Text>
);

// ─── Step bar ──────────────────────────────────────────────────────────────────
function StepBar({ current }: { current: number }) {
  return (
    <View style={step.wrap}>
      <View style={step.track} />
      <View style={step.dotsRow}>
        {[1, 2].map((s) => (
          <View key={s} style={[step.dot, current >= s && step.dotOn]}>
            <Text style={[step.dotTxt, current >= s && step.dotTxtOn]}>{s}</Text>
          </View>
        ))}
      </View>
      <View style={step.labelsRow}>
        <Text style={[step.lbl, current === 1 && step.lblOn]}>Quiz Info</Text>
        <Text style={[step.lbl, current === 2 && step.lblOn]}>Questions</Text>
      </View>
      <View style={step.bar}>
        <View style={[step.fill, { width: `${(current / 2) * 100}%` }]} />
      </View>
    </View>
  );
}
const step = StyleSheet.create({
  wrap: { marginBottom: 24 },
  track: { position: "absolute", top: 16, left: "25%", right: "25%", height: 2, backgroundColor: "#E5E7EB", zIndex: 0 },
  dotsRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6, zIndex: 1 },
  dot: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#E5E7EB", alignItems: "center", justifyContent: "center" },
  dotOn: { backgroundColor: PRIMARY },
  dotTxt: { fontSize: 13, fontWeight: "700", color: "#9CA3AF" },
  dotTxtOn: { color: "#FFF" },
  labelsRow: { flexDirection: "row", justifyContent: "space-between" },
  lbl: { fontSize: 12, color: "#9CA3AF", fontWeight: "600" },
  lblOn: { color: PRIMARY },
  bar: { height: 4, backgroundColor: "#E5E7EB", borderRadius: 2, marginTop: 10, overflow: "hidden" },
  fill: { height: 4, backgroundColor: PRIMARY, borderRadius: 2 },
});

// ─── MCQ Option Editor ──────────────────────────────────────────────────────────
function MCQOptionEditor({ options, onChange }: { options: MCQOption[]; onChange: (o: MCQOption[]) => void }) {
  const LABELS = ["A", "B", "C", "D", "E", "F"];
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);

  const updateText = (i: number, text: string) => {
    const copy = [...options]; copy[i] = { ...copy[i], text }; onChange(copy);
  };

  const markCorrect = (i: number) =>
    onChange(options.map((o, idx) => ({ ...o, isCorrect: idx === i })));

  const addOption = () => {
    if (options.length >= 6) return;
    onChange([...options, { text: "", isCorrect: false, image_url: null }]);
  };

  const removeOption = (i: number) => {
    if (options.length <= 2) { Alert.alert("Minimum", "At least 2 options required."); return; }
    const copy = options.filter((_, idx) => idx !== i);
    if (options[i].isCorrect && copy.length > 0) copy[0].isCorrect = true;
    onChange(copy);
  };

  const pickOptionImage = async (i: number) => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert("Permission required", "Allow photo access to add images."); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    if (result.canceled || !result.assets?.[0]) return;

    setUploadingIdx(i);
    const url = await uploadImageToR2(result.assets[0].uri, "assignments");
    setUploadingIdx(null);
    if (!url) { Alert.alert("Upload failed", "Could not upload image. Try again."); return; }
    const copy = [...options]; copy[i] = { ...copy[i], image_url: url }; onChange(copy);
  };

  const removeOptionImage = (i: number) => {
    const copy = [...options]; copy[i] = { ...copy[i], image_url: null }; onChange(copy);
  };

  return (
    <View>
      <FieldLabel text="Options  •  tap ○ to mark correct" />
      {options.map((opt, i) => (
        <View key={i} style={opt_s.wrapper}>
          <View style={opt_s.row}>
            <TouchableOpacity style={[opt_s.radio, opt.isCorrect && opt_s.radioOn]} onPress={() => markCorrect(i)}>
              {opt.isCorrect && <View style={opt_s.dot} />}
            </TouchableOpacity>
            <View style={[opt_s.badge, opt.isCorrect && opt_s.badgeOn]}>
              <Text style={[opt_s.badgeTxt, opt.isCorrect && opt_s.badgeTxtOn]}>{LABELS[i]}</Text>
            </View>
            <TextInput
              style={[opt_s.input, opt.isCorrect && opt_s.inputOn]}
              placeholder={`Option ${LABELS[i]}`}
              placeholderTextColor="#9CA3AF"
              value={opt.text}
              onChangeText={(t) => updateText(i, t)}
              multiline
            />
            <TouchableOpacity style={opt_s.removeBtn} onPress={() => removeOption(i)}>
              <Text style={opt_s.removeTxt}>✕</Text>
            </TouchableOpacity>
          </View>
          {/* Per-option image */}
          <View style={{ paddingLeft: 56 }}>
            <ImagePickerBtn
              imageUri={opt.image_url ?? null}
              onPick={() => pickOptionImage(i)}
              onRemove={() => removeOptionImage(i)}
              uploading={uploadingIdx === i}
              label="Add image to this option"
              size="small"
            />
          </View>
        </View>
      ))}
      {options.length < 6 && (
        <TouchableOpacity style={opt_s.addBtn} onPress={addOption}>
          <Text style={opt_s.addTxt}>+ Add Option</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
const opt_s = StyleSheet.create({
  wrapper: { marginBottom: 10 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: "#D1D5DB", alignItems: "center", justifyContent: "center", marginTop: 11 },
  radioOn: { borderColor: GREEN },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: GREEN },
  badge: { width: 26, height: 26, borderRadius: 8, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center", marginTop: 8 },
  badgeOn: { backgroundColor: GREEN_LIGHT },
  badgeTxt: { fontSize: 12, fontWeight: "700", color: PRIMARY },
  badgeTxtOn: { color: "#065F46" },
  input: { flex: 1, backgroundColor: "#F9FAFB", borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, color: "#111827", minHeight: 42 },
  inputOn: { borderColor: GREEN, backgroundColor: "#F0FDF4" },
  removeBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: RED_LIGHT, alignItems: "center", justifyContent: "center", marginTop: 7 },
  removeTxt: { color: RED, fontSize: 12, fontWeight: "700" },
  addBtn: { borderWidth: 1.5, borderColor: PRIMARY, borderStyle: "dashed", borderRadius: 12, paddingVertical: 10, alignItems: "center", marginTop: 4, backgroundColor: PRIMARY_LIGHT },
  addTxt: { color: PRIMARY, fontWeight: "700", fontSize: 13 },
});

// ─── Question Builder ───────────────────────────────────────────────────────────
function QuestionBuilder({
  questionNumber, totalQuestions, editingIndex, onAdd, onPreview, onCancelEdit,
}: {
  questionNumber: number; totalQuestions: number; editingIndex: number | null;
  onAdd: (q: Question) => void; onPreview: () => void; onCancelEdit: () => void;
}) {
  const [type, setType] = useState<"mcq" | "open_ended">("mcq");
  const [questionText, setQuestionText] = useState("");
  const [questionImageUri, setQuestionImageUri] = useState<string | null>(null);
  const [uploadingQImg, setUploadingQImg] = useState(false);
  const [marks, setMarks] = useState("1");
  const [openAnswer, setOpenAnswer] = useState("");
  const [options, setOptions] = useState<MCQOption[]>([
    { text: "", isCorrect: true,  image_url: null },
    { text: "", isCorrect: false, image_url: null },
    { text: "", isCorrect: false, image_url: null },
    { text: "", isCorrect: false, image_url: null },
  ]);

  const reset = () => {
    setQuestionText(""); setMarks("1"); setOpenAnswer(""); setQuestionImageUri(null);
    setOptions([
      { text: "", isCorrect: true,  image_url: null },
      { text: "", isCorrect: false, image_url: null },
      { text: "", isCorrect: false, image_url: null },
      { text: "", isCorrect: false, image_url: null },
    ]);
    setType("mcq");
  };

  const pickQuestionImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert("Permission required", "Allow photo access to add images."); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
    if (result.canceled || !result.assets?.[0]) return;

    setUploadingQImg(true);
    const url = await uploadImageToR2(result.assets[0].uri, "assignments");
    setUploadingQImg(false);
    if (!url) { Alert.alert("Upload failed", "Could not upload image. Try again."); return; }
    setQuestionImageUri(url);
  };

  const handleAdd = () => {
    if (!questionText.trim()) { Alert.alert("Required", "Please enter the question text."); return; }
    const marksNum = Number(marks);
    if (!marks || isNaN(marksNum) || marksNum < 1) { Alert.alert("Required", "Marks must be at least 1."); return; }

    if (type === "mcq") {
      const filled = options.filter((o) => o.text.trim() || o.image_url);
      if (filled.length < 2) { Alert.alert("Required", "Please fill at least 2 options (text or image)."); return; }
      const correct = options.find((o) => o.isCorrect);
      if (!correct || (!correct.text.trim() && !correct.image_url)) {
        Alert.alert("Required", "Mark a correct option and give it text or an image.");
        return;
      }
      const LABELS = ["A", "B", "C", "D", "E", "F"];
      const correctIndex = options.findIndex((o) => o.isCorrect);
      const correctAnswerText = correct.text.trim() || `Option ${LABELS[correctIndex]}`;
      
      const finalOptions = filled.map((o, i) => ({
        ...o,
        text: o.text.trim() || `Option ${LABELS[options.indexOf(o)]}`,
      }));

      onAdd({
        type: "mcq",
        question: questionText.trim(),
        image_url: questionImageUri,
        options: finalOptions,
        correct_answer: finalOptions.find((o) => o.isCorrect)?.text || correctAnswerText,
        marks: marksNum,
      });
    } else {
      if (!openAnswer.trim()) { Alert.alert("Required", "Please enter the expected answer."); return; }
      onAdd({
        type: "open_ended",
        question: questionText.trim(),
        image_url: questionImageUri,
        options: [],
        correct_answer: openAnswer.trim(),
        marks: marksNum,
      });
    }
    reset();
  };

  return (
    <View style={S.card}>
      {/* Header */}
      <View style={S.cardTitleRow}>
        <View style={S.cardBadge}>
          <Text style={S.cardBadgeTxt}>Q{questionNumber}</Text>
        </View>
        <Text style={S.cardTitle}>
          {editingIndex !== null ? `Editing Q${editingIndex + 1}` : "New Question"}
        </Text>
        {totalQuestions > 0 && (
          <View style={S.countPill}>
            <Text style={S.countPillTxt}>{totalQuestions} added</Text>
          </View>
        )}
      </View>

      {/* Edit notice */}
      {editingIndex !== null && (
        <View style={S.editNotice}>
          <Text style={S.editNoticeTxt}>✏️  Fill updated details and tap "Update"</Text>
          <TouchableOpacity onPress={onCancelEdit}>
            <Text style={S.editCancelTxt}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Type */}
      <FieldLabel text="Question Type" />
      <View style={S.typeRow}>
        <TouchableOpacity style={[S.typeBtn, type === "mcq" && S.typeBtnOn]} onPress={() => setType("mcq")} activeOpacity={0.8}>
          <Text style={[S.typeTxt, type === "mcq" && S.typeTxtOn]}>MCQ</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[S.typeBtn, type === "open_ended" && S.typeBtnOpenOn]} onPress={() => setType("open_ended")} activeOpacity={0.8}>
          <Text style={[S.typeTxt, type === "open_ended" && S.typeTxtOn]}>Open Ended</Text>
        </TouchableOpacity>
      </View>

      {/* Question text */}
      <FieldLabel text="Question *" />
      <TextInput
        style={[S.input, S.textarea]}
        placeholder="Type your question here..."
        placeholderTextColor="#9CA3AF"
        value={questionText}
        onChangeText={setQuestionText}
        multiline
      />

      {/* Question image (like Google Forms) */}
      <FieldLabel text="Question Image (optional)" />
      <ImagePickerBtn
        imageUri={questionImageUri}
        onPick={pickQuestionImage}
        onRemove={() => setQuestionImageUri(null)}
        uploading={uploadingQImg}
        label="Add image to question"
      />

      {type === "mcq" && <MCQOptionEditor options={options} onChange={setOptions} />}

      {type === "open_ended" && (
        <>
          <FieldLabel text="Expected / Model Answer *" />
          <TextInput
            style={[S.input, { minHeight: 90 }]}
            placeholder="Write the ideal answer here..."
            placeholderTextColor="#9CA3AF"
            value={openAnswer}
            onChangeText={setOpenAnswer}
            multiline
          />
        </>
      )}

      {/* Marks */}
      <FieldLabel text="Marks *" />
      <TextInput
        style={[S.input, { width: 90 }]}
        placeholder="e.g. 2"
        placeholderTextColor="#9CA3AF"
        keyboardType="numeric"
        value={marks}
        onChangeText={setMarks}
      />

      {/* Buttons */}
      <View style={S.actionRow}>
        <TouchableOpacity style={S.addBtn} onPress={handleAdd} activeOpacity={0.85}>
          <Text style={S.addBtnTxt}>{editingIndex !== null ? "✓ Update Question" : "+ Add Question"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={S.previewBtn} onPress={onPreview} activeOpacity={0.85}>
          <Text style={S.previewBtnTxt}>👁 Preview</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Preview Modal ──────────────────────────────────────────────────────────────
function PreviewModal({ visible, questions, onClose, onEdit, onDelete }: {
  visible: boolean; questions: Question[];
  onClose: () => void; onEdit: (i: number) => void; onDelete: (i: number) => void;
}) {
  const LABELS = ["A", "B", "C", "D", "E", "F"];
  const totalMarks = questions.reduce((s, q) => s + q.marks, 0);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }} showsVerticalScrollIndicator={false}>

          {/* Header */}
          <View style={pm.header}>
            <Text style={pm.title}>Preview</Text>
            <TouchableOpacity style={pm.closeBtn} onPress={onClose}>
              <Text style={pm.closeTxt}>✕ Close</Text>
            </TouchableOpacity>
          </View>

          {/* Banner */}
          <View style={pm.banner}>
            {[
              { val: questions.length, lbl: "Questions" },
              { val: totalMarks, lbl: "Total Marks" },
              { val: questions.filter((q) => q.type === "mcq").length, lbl: "MCQ" },
              { val: questions.filter((q) => q.type === "open_ended").length, lbl: "Open" },
            ].map((item, i, arr) => (
              <React.Fragment key={i}>
                <View style={pm.bannerItem}>
                  <Text style={pm.bannerVal}>{item.val}</Text>
                  <Text style={pm.bannerLbl}>{item.lbl}</Text>
                </View>
                {i < arr.length - 1 && <View style={pm.divider} />}
              </React.Fragment>
            ))}
          </View>

          {questions.length === 0 && (
            <View style={pm.empty}><Text style={pm.emptyTxt}>No questions added yet.</Text></View>
          )}

          {questions.map((q, i) => (
            <View key={i} style={pm.card}>
              <View style={pm.qHeader}>
                <View style={pm.qBadge}><Text style={pm.qBadgeTxt}>Q{i + 1}</Text></View>
                <View style={[pm.typeBadge, q.type === "open_ended" && pm.typeBadgeOpen]}>
                  <Text style={[pm.typeText, q.type === "open_ended" && pm.typeTextOpen]}>
                    {q.type === "mcq" ? "MCQ" : "Open Ended"}
                  </Text>
                </View>
                <View style={pm.marksBadge}>
                  <Text style={pm.marksTxt}>{q.marks} mark{q.marks > 1 ? "s" : ""}</Text>
                </View>
                <View style={{ flex: 1 }} />
                <TouchableOpacity style={pm.editBtn} onPress={() => { onClose(); onEdit(i); }}>
                  <Text style={pm.editBtnTxt}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity style={pm.deleteBtn} onPress={() =>
                  Alert.alert("Delete", "Remove this question?", [
                    { text: "Cancel" },
                    { text: "Delete", style: "destructive", onPress: () => onDelete(i) },
                  ])}>
                  <Text style={pm.deleteBtnTxt}>✕</Text>
                </TouchableOpacity>
              </View>

              <Text style={pm.qTxt}>{q.question}</Text>

              {/* Question image */}
              {q.image_url && (
                <Image source={{ uri: q.image_url }} style={pm.qImage} resizeMode="contain" />
              )}

              {q.type === "mcq" && (
                <View style={{ marginTop: 10, gap: 8 }}>
                  {q.options.map((opt, oi) => {
                    const correct = opt.text === q.correct_answer;
                    return (
                      <View key={oi} style={[pm.optRow, correct && pm.optRowOn]}>
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <View style={[pm.optLbl, correct && pm.optLblOn]}>
                              <Text style={[pm.optLblTxt, correct && pm.optLblTxtOn]}>{LABELS[oi]}</Text>
                            </View>
                            <Text style={[pm.optTxt, correct && pm.optTxtOn]}>{opt.text}{correct ? "  ✓" : ""}</Text>
                          </View>
                          {opt.image_url && (
                            <Image source={{ uri: opt.image_url }} style={pm.optImage} resizeMode="cover" />
                          )}
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}

              {q.type === "open_ended" && (
                <View style={pm.modelBox}>
                  <Text style={pm.modelLbl}>Model Answer</Text>
                  <Text style={pm.modelTxt}>{q.correct_answer}</Text>
                </View>
              )}
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
const pm = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  title: { fontSize: 26, fontWeight: "800", color: "#111827" },
  closeBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: "#F3F4F6" },
  closeTxt: { fontSize: 13, fontWeight: "700", color: "#374151" },
  banner: { backgroundColor: PRIMARY, borderRadius: 18, padding: 16, flexDirection: "row", justifyContent: "space-between", marginBottom: 16, shadowColor: PRIMARY, shadowOpacity: 0.3, shadowRadius: 12, elevation: 5 },
  bannerItem: { alignItems: "center", flex: 1 },
  bannerVal: { fontSize: 20, fontWeight: "800", color: "#FFF" },
  bannerLbl: { fontSize: 11, color: "rgba(255,255,255,0.7)", fontWeight: "600", marginTop: 2 },
  divider: { width: 1, backgroundColor: "rgba(255,255,255,0.2)" },
  empty: { alignItems: "center", marginTop: 60 },
  emptyTxt: { fontSize: 15, color: "#9CA3AF", fontWeight: "600" },
  card: { backgroundColor: "#FFF", borderRadius: 20, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB" },
  qHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 },
  qBadge: { backgroundColor: PRIMARY, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  qBadgeTxt: { color: "#FFF", fontWeight: "800", fontSize: 12 },
  typeBadge: { backgroundColor: PRIMARY_LIGHT, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  typeBadgeOpen: { backgroundColor: AMBER_LIGHT },
  typeText: { color: PRIMARY, fontWeight: "700", fontSize: 11 },
  typeTextOpen: { color: "#92400E" },
  marksBadge: { backgroundColor: GREEN_LIGHT, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  marksTxt: { color: "#065F46", fontWeight: "700", fontSize: 11 },
  editBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1.5, borderColor: PRIMARY },
  editBtnTxt: { color: PRIMARY, fontWeight: "700", fontSize: 11 },
  deleteBtn: { width: 26, height: 26, borderRadius: 13, backgroundColor: RED_LIGHT, alignItems: "center", justifyContent: "center" },
  deleteBtnTxt: { color: RED, fontSize: 12, fontWeight: "700" },
  qTxt: { fontSize: 15, color: "#111827", fontWeight: "600", lineHeight: 22 },
  qImage: { width: "100%", height: 180, borderRadius: 12, marginTop: 10, marginBottom: 4 },
  optImage: { width: "100%", height: 80, borderRadius: 8, marginTop: 6 },
  optRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#F9FAFB", borderWidth: 1, borderColor: "#E5E7EB" },
  optRowOn: { backgroundColor: "#F0FDF4", borderColor: GREEN },
  optLbl: { width: 22, height: 22, borderRadius: 6, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center" },
  optLblOn: { backgroundColor: GREEN_LIGHT },
  optLblTxt: { fontSize: 11, fontWeight: "700", color: PRIMARY },
  optLblTxtOn: { color: "#065F46" },
  optTxt: { fontSize: 14, color: "#374151", flex: 1 },
  optTxtOn: { color: "#065F46", fontWeight: "700" },
  modelBox: { marginTop: 10, backgroundColor: AMBER_LIGHT, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#FDE68A" },
  modelLbl: { fontSize: 11, fontWeight: "700", color: "#92400E", marginBottom: 4 },
  modelTxt: { fontSize: 14, color: "#78350F", lineHeight: 20 },
});

// ─── Main Screen ────────────────────────────────────────────────────────────────
export default function CreateQuizManual() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const subject = route.params?.subject ?? null;

  const [stage, setStage] = useState<1 | 2>(1);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  const scrollRef = useRef<ScrollView>(null);

  const handleAddQuestion = (q: Question) => {
    if (editingIndex !== null) {
      const copy = [...questions];
      copy[editingIndex] = q;
      setQuestions(copy);
      setEditingIndex(null);
      Alert.alert("Updated", `Q${editingIndex + 1} updated.`);
    } else {
      setQuestions((prev) => [...prev, q]);
    }
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  };

  const handleDeleteQuestion = (i: number) =>
    setQuestions((prev) => prev.filter((_, idx) => idx !== i));

  const handleEditFromPreview = (i: number) => {
    setEditingIndex(i);
    setPreviewVisible(false);
  };

  //  FIXED: teacher_id fetched from session here — never null
  const handleFinalize = async () => {
    if (questions.length === 0) { Alert.alert("No Questions", "Add at least one question."); return; }
    if (!title.trim()) { Alert.alert("Required", "Quiz title is required."); return; }
    if (!subject?.subject_id) { Alert.alert("Error", "Subject not found. Go back and reselect."); return; }

    try {
      setFinalizing(true);

      //  Fetch session right before navigating so teacher_id is always fresh
      const session = await getUserSession();

      if (!session?.teacher_id) {
        Alert.alert("Session Error", "Could not retrieve teacher session. Please log in again.");
        return;
      }

      const hasM = questions.some((q) => q.type === "mcq");
      const hasO = questions.some((q) => q.type === "open_ended");
      const question_type = hasM && hasO ? "mixed" : hasM ? "mcq" : "open_ended";

      //  All required fields the backend /api/quizzes/create expects are present.
      // FinalizeQuiz will ADD: time_limit_minutes, scheduled_start, scheduled_end
      const payload = {
        teacher_id: session.teacher_id,       //  from session
        subject_id: subject.subject_id,        //  from route params
        title: title.trim(),                   //  from stage 1
        description: description.trim() || null,
        syllabus: null,
        question_type,                         //  derived from questions
        notify_students: true,
        questions: questions.map((q) => ({
          type: q.type,
          question: q.question,
          image_url: q.image_url || null,
          // MCQ → array of { text, image_url }; open_ended → null
          options: q.type === "mcq"
            ? q.options.map((o) => ({ text: o.text, image_url: o.image_url || null }))
            : null,
          correct_answer: q.correct_answer,
          marks: Number(q.marks),
        })),
      };

      navigation.navigate("FinalizeQuizScreen", { quizData: payload });

    } catch (e) {
      Alert.alert("Error", "Something went wrong. Please try again.");
    } finally {
      setFinalizing(false);
    }
  };

  const totalMarks = questions.reduce((s, q) => s + q.marks, 0);

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={S.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Back */}
          <TouchableOpacity style={S.backBtn} onPress={() => stage === 2 ? setStage(1) : navigation.goBack()}>
            <Text style={S.backIcon}>‹</Text>
          </TouchableOpacity>

          <Text style={S.screenTitle}>Create Quiz</Text>
          <Text style={S.screenSubtitle}>{subject?.subject_name ?? "Manual"} · Build questions manually</Text>

          <StepBar current={stage} />

          {/* ── Stage 1: Quiz Info ── */}
          {stage === 1 && (
            <View style={S.card}>
              <View style={S.cardTitleRow}>
                <View style={S.cardBadge}><Text style={S.cardBadgeTxt}>📋</Text></View>
                <Text style={S.cardTitle}>Quiz Info</Text>
              </View>

              <FieldLabel text="Quiz Title *" />
              <TextInput style={S.input} placeholder="e.g. Python Mid-Sem Test" placeholderTextColor="#9CA3AF" value={title} onChangeText={setTitle} />

              <FieldLabel text="Description (optional)" />
              <TextInput style={[S.input, S.textarea]} placeholder="Brief description for students..." placeholderTextColor="#9CA3AF" value={description} onChangeText={setDescription} multiline />

              <TouchableOpacity
                style={S.primaryBtn}
                onPress={() => { if (!title.trim()) { Alert.alert("Required", "Please enter a quiz title."); return; } setStage(2); }}
                activeOpacity={0.85}
              >
                <Text style={S.primaryBtnTxt}>Continue → Add Questions</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Stage 2: Questions ── */}
          {stage === 2 && (
            <>
              {/* Stats bar */}
              {questions.length > 0 && (
                <View style={S.statsBar}>
                  {[
                    { val: questions.length, lbl: "Questions" },
                    { val: totalMarks, lbl: "Total Marks" },
                    { val: questions.filter((q) => q.type === "mcq").length, lbl: "MCQ" },
                    { val: questions.filter((q) => q.type === "open_ended").length, lbl: "Open" },
                  ].map((item, i, arr) => (
                    <React.Fragment key={i}>
                      <View style={S.statItem}>
                        <Text style={S.statVal}>{item.val}</Text>
                        <Text style={S.statLbl}>{item.lbl}</Text>
                      </View>
                      {i < arr.length - 1 && <View style={S.statDivider} />}
                    </React.Fragment>
                  ))}
                </View>
              )}

              {/* Question builder */}
              <QuestionBuilder
                questionNumber={editingIndex !== null ? editingIndex + 1 : questions.length + 1}
                totalQuestions={questions.length}
                editingIndex={editingIndex}
                onAdd={handleAddQuestion}
                onPreview={() => setPreviewVisible(true)}
                onCancelEdit={() => setEditingIndex(null)}
              />

              {/* Finalize */}
              {questions.length > 0 && (
                <TouchableOpacity
                  style={[S.finalizeBtn, finalizing && { opacity: 0.7 }]}
                  onPress={handleFinalize}
                  disabled={finalizing}
                  activeOpacity={0.85}
                >
                  {finalizing
                    ? <ActivityIndicator color="#FFF" />
                    : <Text style={S.finalizeBtnTxt}>✓ Finalize Quiz ({questions.length} Q · {totalMarks} marks)</Text>
                  }
                </TouchableOpacity>
              )}
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      <PreviewModal
        visible={previewVisible}
        questions={questions}
        onClose={() => setPreviewVisible(false)}
        onEdit={handleEditFromPreview}
        onDelete={handleDeleteQuestion}
      />
    </SafeAreaView>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 },

  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", marginBottom: 12, elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  backIcon: { fontSize: 22, fontWeight: "700", color: PRIMARY },

  screenTitle: { fontSize: 28, fontWeight: "800", color: "#111827" },
  screenSubtitle: { fontSize: 14, color: "#6B7280", marginBottom: 20, marginTop: 4 },

  // Card
  card: { backgroundColor: "#FFF", borderRadius: 26, padding: 20, marginBottom: 16, shadowColor: PRIMARY, shadowOpacity: 0.06, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 3, borderWidth: 1, borderColor: "#E5E7EB" },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 18 },
  cardBadge: { backgroundColor: PRIMARY, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4, minWidth: 34, alignItems: "center" },
  cardBadgeTxt: { color: "#FFF", fontWeight: "800", fontSize: 13 },
  cardTitle: { fontSize: 17, fontWeight: "700", color: "#111827", flex: 1 },
  countPill: { backgroundColor: GREEN_LIGHT, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  countPillTxt: { color: "#065F46", fontWeight: "700", fontSize: 12 },

  // Field label
  fieldLabel: { fontSize: 12, fontWeight: "700", color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, marginTop: 14 },

  // Input
  input: { backgroundColor: "#F9FAFB", borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, color: "#111827", fontWeight: "500" },
  textarea: { minHeight: 72, textAlignVertical: "top" },

  // Type selector
  typeRow: { flexDirection: "row", gap: 10 },
  typeBtn: { flex: 1, paddingVertical: 11, borderRadius: 14, backgroundColor: PRIMARY_LIGHT, alignItems: "center", borderWidth: 1.5, borderColor: "transparent" },
  typeBtnOn: { backgroundColor: PRIMARY },
  typeBtnOpenOn: { backgroundColor: AMBER, borderColor: AMBER },
  typeTxt: { fontSize: 14, fontWeight: "700", color: PRIMARY },
  typeTxtOn: { color: "#FFF" },

  // Action row
  actionRow: { flexDirection: "row", gap: 10, marginTop: 20 },
  addBtn: { flex: 1, height: 52, backgroundColor: PRIMARY, borderRadius: 16, alignItems: "center", justifyContent: "center", shadowColor: PRIMARY, shadowOpacity: 0.3, shadowRadius: 10, elevation: 4 },
  addBtnTxt: { color: "#FFF", fontWeight: "800", fontSize: 15 },
  previewBtn: { height: 52, paddingHorizontal: 20, backgroundColor: "#FFF", borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: PRIMARY },
  previewBtnTxt: { color: PRIMARY, fontWeight: "700", fontSize: 14 },

  // Stats bar
  statsBar: { backgroundColor: "#FFF", borderRadius: 18, padding: 14, flexDirection: "row", justifyContent: "space-around", marginBottom: 14, borderWidth: 1, borderColor: "#E5E7EB", shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, elevation: 2 },
  statItem: { alignItems: "center", flex: 1 },
  statVal: { fontSize: 18, fontWeight: "800", color: PRIMARY },
  statLbl: { fontSize: 11, color: "#9CA3AF", fontWeight: "600", marginTop: 2 },
  statDivider: { width: 1, backgroundColor: "#E5E7EB" },

  // Edit notice
  editNotice: { backgroundColor: AMBER_LIGHT, borderRadius: 14, padding: 12, marginBottom: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderWidth: 1, borderColor: "#FDE68A" },
  editNoticeTxt: { fontSize: 13, color: "#92400E", fontWeight: "600", flex: 1 },
  editCancelTxt: { color: RED, fontWeight: "700", fontSize: 13 },

  // Finalize
  finalizeBtn: { backgroundColor: GREEN, borderRadius: 18, height: 56, alignItems: "center", justifyContent: "center", shadowColor: GREEN, shadowOpacity: 0.3, shadowRadius: 12, elevation: 5, marginTop: 4 },
  finalizeBtnTxt: { color: "#FFF", fontWeight: "800", fontSize: 16 },

  // Primary (stage 1 continue)
  primaryBtn: { marginTop: 20, backgroundColor: PRIMARY, borderRadius: 16, height: 54, alignItems: "center", justifyContent: "center", shadowColor: PRIMARY, shadowOpacity: 0.3, shadowRadius: 12, elevation: 4 },
  primaryBtnTxt: { color: "#FFF", fontWeight: "800", fontSize: 16 },
});