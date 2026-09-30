import React, { useState, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, TextInput, Alert,
  Modal, Linking, Platform, FlatList,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, useFocusEffect } from "@react-navigation/native";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as DocumentPicker from "expo-document-picker";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY       = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG            = "#F3F4F6";
const GREEN         = "#10B981";
const GREEN_LIGHT   = "#D1FAE5";
const AMBER         = "#F59E0B";
const AMBER_LIGHT   = "#FEF3C7";
const GREY          = "#6B7280";
const RED           = "#EF4444";
const RED_LIGHT     = "#FEF2F2";
const DARK          = "#111827";
const WHITE         = "#FFFFFF";
const BORDER        = "#E5E7EB";
const API_URL       = "http://10.132.90.56:5000";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtShortDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function fileIcon(type: string) {
  if (!type) return "document-outline";
  if (type.includes("pdf"))          return "document-text-outline";
  if (type.includes("image"))        return "image-outline";
  if (type.includes("word") || type.includes("document")) return "document-outline";
  if (type.includes("sheet") || type.includes("excel"))   return "grid-outline";
  if (type.includes("presentation") || type.includes("powerpoint")) return "easel-outline";
  return "attach-outline";
}

async function openFile(url: string) {
  try { await WebBrowser.openBrowserAsync(url); }
  catch { Linking.openURL(url); }
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface Submission {
  submission_id:  string;
  student_uid:    string;
  student_name:   string | null;
  student_roll:   string | null;
  text_answer:    string | null;
  attachments:    any[];
  links:          any[];
  status:         "submitted" | "graded" | "late";
  marks_obtained: number | null;
  feedback:       string | null;
  submitted_at:   string | null;
  graded_at:      string | null;
  returned:       boolean; // whether marks are visible to student
}

interface RegisterRow {
  uid:        string;
  name:       string;
  roll:       string | null;
  submission: Submission | null;
  // inline grading state (register mode)
  draftMarks: string;
  draftFeedback: string;
}

// ─── Status badge config ──────────────────────────────────────────────────────
function statusStyle(sub: Submission | null) {
  if (!sub)                    return { bg: BG,           text: GREY,    label: "Not submitted" };
  if (sub.status === "graded") return { bg: GREEN_LIGHT,  text: GREEN,   label: "Graded" };
  if (sub.status === "late")   return { bg: AMBER_LIGHT,  text: AMBER,   label: "Late" };
  return                              { bg: PRIMARY_LIGHT, text: PRIMARY, label: "Submitted" };
}

// ════════════════════════════════════════════════════════════════════════════
// EDIT ASSIGNMENT MODAL
// ════════════════════════════════════════════════════════════════════════════
function EditModal({ visible, assignment, teacher_id, onClose, onSaved }: {
  visible: boolean; assignment: any; teacher_id: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [title,        setTitle]        = useState(assignment.title);
  const [instructions, setInstructions] = useState(assignment.instructions || "");
  const [questions,    setQuestions]    = useState(assignment.questions || "");
  const [marks,        setMarks]        = useState(String(assignment.marks));
  const [allowLate,    setAllowLate]    = useState(assignment.allow_late);
  const [dueDate,      setDueDate]      = useState(new Date(assignment.due_date));
  const [showDate,     setShowDate]     = useState(false);
  const [showTime,     setShowTime]     = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [existingFiles, setExistingFiles] = useState<any[]>(assignment.attachments || []);
  const [newFiles,     setNewFiles]     = useState<any[]>([]);
  const [uploading,    setUploading]    = useState(false);

  const pickFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true });
    if (!result.canceled && result.assets) setNewFiles((p) => [...p, ...result.assets]);
  };

  const uploadNewFiles = async (): Promise<any[]> => {
    if (newFiles.length === 0) return [];
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("folder",    "assignments");
      fd.append("entity_id", assignment.assignment_id);
      newFiles.forEach((f) =>
        fd.append("files", { uri: f.uri, name: f.name, type: f.mimeType || "application/octet-stream" } as any)
      );
      const res  = await fetch(`${API_URL}/api/assignments/upload`, { method: "POST", body: fd });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data.files || [];
    } finally { setUploading(false); }
  };

  const handleSave = async () => {
    if (!title.trim())                                  { Alert.alert("Required", "Title is required."); return; }
    if (!marks || isNaN(Number(marks)) || Number(marks) < 1) { Alert.alert("Invalid",   "Marks must be positive."); return; }

    setSaving(true);
    try {
      const uploaded   = await uploadNewFiles();
      const allFiles   = [...existingFiles, ...uploaded];
      const deletedKeys = (assignment.attachments || [])
        .filter((f: any) => !existingFiles.find((e: any) => e.key === f.key))
        .map((f: any) => f.key);

      const res  = await fetch(`${API_URL}/api/assignments/${assignment.assignment_id}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          teacher_id, title: title.trim(),
          instructions: instructions.trim() || undefined,
          questions:    questions.trim()    || undefined,
          marks: Number(marks), due_date: dueDate.toISOString(),
          allow_late: allowLate, attachments: allFiles, deleted_keys: deletedKeys,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      Alert.alert("Saved!", "Assignment updated.", [{ text: "OK", onPress: () => { onClose(); onSaved(); } }]);
    } catch (e: any) { Alert.alert("Error", e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={{ flex: 1, backgroundColor: WHITE }}>
        <ScrollView contentContainerStyle={E.content} keyboardShouldPersistTaps="handled">
          <View style={E.header}>
            <Text style={E.title}>Edit Assignment</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={24} color={GREY} /></TouchableOpacity>
          </View>

          <Text style={E.label}>Title *</Text>
          <TextInput style={E.input} value={title} onChangeText={setTitle} placeholder="Title" />

          <Text style={E.label}>Total Marks *</Text>
          <TextInput style={E.input} value={marks} onChangeText={setMarks} keyboardType="numeric" />

          <Text style={E.label}>Due Date</Text>
          <View style={E.dateRow}>
            <TouchableOpacity style={E.dateBtn} onPress={() => setShowDate(true)}>
              <Ionicons name="calendar-outline" size={15} color={PRIMARY} />
              <Text style={E.dateBtnText}>{dueDate.toDateString()}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={E.dateBtn} onPress={() => setShowTime(true)}>
              <Ionicons name="time-outline" size={15} color={PRIMARY} />
              <Text style={E.dateBtnText}>{dueDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
            </TouchableOpacity>
          </View>
          {showDate && (
            <DateTimePicker value={dueDate} mode="date" minimumDate={new Date()}
              display={Platform.OS === "ios" ? "spinner" : "default"}
              onChange={(_, d) => { if (Platform.OS === "android") setShowDate(false); if (d) setDueDate(d); }} />
          )}
          {showTime && (
            <DateTimePicker value={dueDate} mode="time"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              onChange={(_, d) => {
                if (Platform.OS === "android") setShowTime(false);
                if (d) { const m = new Date(dueDate); m.setHours(d.getHours(), d.getMinutes()); setDueDate(m); }
              }} />
          )}

          <Text style={E.label}>Instructions <Text style={E.optional}>(optional)</Text></Text>
          <TextInput style={[E.input, E.textarea]} value={instructions} onChangeText={setInstructions} multiline placeholder="General guidance…" textAlignVertical="top" />

          <Text style={E.label}>Questions <Text style={E.optional}>(optional)</Text></Text>
          <TextInput style={[E.input, E.textarea]} value={questions} onChangeText={setQuestions} multiline placeholder="1. …" textAlignVertical="top" />

          <View style={E.toggleRow}>
            <View>
              <Text style={E.label}>Allow late submissions</Text>
              <Text style={E.toggleSub}>Students can submit after due date</Text>
            </View>
            <TouchableOpacity style={[E.toggle, allowLate && E.toggleOn]} onPress={() => setAllowLate(!allowLate)}>
              <View style={[E.knob, allowLate && E.knobOn]} />
            </TouchableOpacity>
          </View>

          {existingFiles.length > 0 && (
            <>
              <Text style={E.label}>Current Attachments</Text>
              {existingFiles.map((f: any) => (
                <View key={f.key} style={E.fileRow}>
                  <Ionicons name={fileIcon(f.type)} size={15} color={PRIMARY} />
                  <Text style={E.fileName} numberOfLines={1}>{f.name}</Text>
                  <TouchableOpacity onPress={() => setExistingFiles((p) => p.filter((e: any) => e.key !== f.key))}>
                    <Ionicons name="close-circle" size={18} color={RED} />
                  </TouchableOpacity>
                </View>
              ))}
            </>
          )}
          {newFiles.length > 0 && (
            <>
              <Text style={E.label}>New Files</Text>
              {newFiles.map((f: any, i: number) => (
                <View key={i} style={E.fileRow}>
                  <Ionicons name="document-outline" size={15} color={GREEN} />
                  <Text style={E.fileName} numberOfLines={1}>{f.name}</Text>
                  <TouchableOpacity onPress={() => setNewFiles((p) => p.filter((_, j) => j !== i))}>
                    <Ionicons name="close-circle" size={18} color={RED} />
                  </TouchableOpacity>
                </View>
              ))}
            </>
          )}
          <TouchableOpacity style={E.attachBtn} onPress={pickFiles}>
            <Ionicons name="attach" size={16} color={PRIMARY} />
            <Text style={E.attachText}>Attach Files</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[E.saveBtn, (saving || uploading) && { opacity: 0.7 }]}
            onPress={handleSave}
            disabled={saving || uploading}
          >
            {saving || uploading ? <ActivityIndicator color={WHITE} /> : <Text style={E.saveBtnText}>Save Changes</Text>}
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const E = StyleSheet.create({
  content: { padding: 20 },
  header:  { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  title:   { fontSize: 22, fontWeight: "800", color: DARK },
  label:   { fontSize: 14, fontWeight: "700", color: DARK, marginTop: 14, marginBottom: 6 },
  optional:{ fontWeight: "400", color: GREY },
  input:   { borderWidth: 1.5, borderColor: BORDER, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: DARK, backgroundColor: "#F9FAFB" },
  textarea:{ minHeight: 90, textAlignVertical: "top" },
  dateRow: { gap: 8 },
  dateBtn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: PRIMARY_LIGHT, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 4 },
  dateBtnText: { fontSize: 14, fontWeight: "600", color: PRIMARY },
  toggleRow:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16 },
  toggleSub:   { fontSize: 12, color: GREY, marginTop: 2 },
  toggle:      { width: 50, height: 28, borderRadius: 20, backgroundColor: "#D1D5DB", justifyContent: "center" },
  toggleOn:    { backgroundColor: PRIMARY },
  knob:        { width: 22, height: 22, borderRadius: 11, backgroundColor: WHITE, marginLeft: 3 },
  knobOn:      { marginLeft: 25 },
  fileRow:     { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#F9FAFB", borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: BORDER },
  fileName:    { flex: 1, fontSize: 13, color: "#374151" },
  attachBtn:   { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1.5, borderColor: PRIMARY, borderRadius: 12, paddingVertical: 12, marginTop: 12, borderStyle: "dashed" },
  attachText:  { color: PRIMARY, fontWeight: "700", fontSize: 14 },
  saveBtn:     { backgroundColor: PRIMARY, borderRadius: 14, height: 52, alignItems: "center", justifyContent: "center", marginTop: 20, shadowColor: PRIMARY, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  saveBtnText: { color: WHITE, fontWeight: "800", fontSize: 16 },
});

// ════════════════════════════════════════════════════════════════════════════
// INDIVIDUAL GRADE MODAL — full submission view + marks + return toggle
// ════════════════════════════════════════════════════════════════════════════
function GradeModal({ visible, row, totalMarks, teacher_id, onClose, onSaved }: {
  visible:     boolean;
  row:         RegisterRow | null;
  totalMarks:  number;
  teacher_id:  string;
  onClose:     () => void;
  onSaved:     () => void;
}) {
  const sub = row?.submission ?? null;
  const [marksInput, setMarksInput] = useState(sub?.marks_obtained != null ? String(sub.marks_obtained) : "");
  const [feedback,   setFeedback]   = useState(sub?.feedback || "");
  const [returned,   setReturned]   = useState(sub?.returned ?? false);
  const [saving,     setSaving]     = useState(false);

  React.useEffect(() => {
    if (sub) {
      setMarksInput(sub.marks_obtained != null ? String(sub.marks_obtained) : "");
      setFeedback(sub.feedback || "");
      setReturned(sub.returned ?? false);
    } else {
      setMarksInput(""); setFeedback(""); setReturned(false);
    }
  }, [sub, visible]);

  const handleSave = async () => {
    if (!sub && !row) return;
    const m = Number(marksInput);
    if (isNaN(m) || m < 0)  { Alert.alert("Invalid", "Enter valid marks."); return; }
    if (m > totalMarks)      { Alert.alert("Invalid", `Max marks is ${totalMarks}.`); return; }

    setSaving(true);
    try {
      const isEdit = sub?.status === "graded";
      const url    = sub
        ? `${API_URL}/api/assignments/grade/${sub.submission_id}`
        : `${API_URL}/api/assignments/grade/manual`;

      const res  = await fetch(url, {
        method:  isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          teacher_id,
          student_uid:    row!.uid,
          assignment_id:  undefined, // server resolves from submission_id
          marks_obtained: m,
          feedback:       feedback.trim() || undefined,
          returned,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      Alert.alert("Saved!", "Grade saved.", [{ text: "OK", onPress: () => { onClose(); onSaved(); } }]);
    } catch (e: any) { Alert.alert("Error", e.message); }
    finally { setSaving(false); }
  };

  if (!row) return null;

  const displayName = row.name || row.uid;
  const pct = marksInput && !isNaN(Number(marksInput)) ? Math.round((Number(marksInput) / totalMarks) * 100) : null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={{ flex: 1, backgroundColor: WHITE }}>
        <ScrollView contentContainerStyle={G.content} keyboardShouldPersistTaps="handled">

          {/* Header */}
          <View style={G.header}>
            <Text style={G.title}>{sub ? "Grade Submission" : "Add Grade"}</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={24} color={GREY} /></TouchableOpacity>
          </View>

          {/* Student card */}
          <View style={G.studentCard}>
            <View style={G.avatar}>
              <Text style={G.avatarTxt}>{displayName.charAt(0).toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={G.studentName}>{displayName}</Text>
              {row.roll && <Text style={G.studentRoll}>Roll: {row.roll}</Text>}
              {sub && <Text style={G.submittedAt}>Submitted {fmtDate(sub.submitted_at)}</Text>}
              {!sub && <Text style={[G.submittedAt, { color: GREY }]}>No submission</Text>}
            </View>
          </View>

          {/* Submission content */}
          {sub?.text_answer && (
            <View style={G.answerBox}>
              <Text style={G.answerLabel}>Student's Answer</Text>
              <ScrollView style={{ maxHeight: 160 }} nestedScrollEnabled>
                <Text style={G.answerText}>{sub.text_answer}</Text>
              </ScrollView>
            </View>
          )}

          {sub?.attachments?.map((att: any, i: number) => (
            <View style={G.section}>
              <Text style={G.sectionLabel}>Attachments</Text>
              {sub?.attachments.map((att: any, i: number) => (
                <TouchableOpacity key={i} style={G.attachChip} onPress={() => openFile(att.url)}>
                  <Ionicons name={fileIcon(att.type)} size={14} color={PRIMARY} />
                  <Text style={G.attachChipText} numberOfLines={1}>{att.name}</Text>
                  <Ionicons name="open-outline" size={12} color={PRIMARY} />
                </TouchableOpacity>
              ))}
            </View>
          ))}

          {sub?.links?.map((l: any, i: number) => (
            <View style={G.section}>
              <Text style={G.sectionLabel}>Links</Text>
              {sub?.links.map((l: any, i: number) => (
                <TouchableOpacity key={i} style={G.attachChip} onPress={() => openFile(l.url)}>
                  <Ionicons name="link-outline" size={14} color={GREEN} />
                  <Text style={[G.attachChipText, { color: GREEN }]} numberOfLines={1}>{l.label || l.url}</Text>
                  <Ionicons name="open-outline" size={12} color={GREEN} />
                </TouchableOpacity>
              ))}
            </View>
          ))}

          {/* Marks input */}
          <View style={G.marksSection}>
            <View style={G.marksTopRow}>
              <Text style={G.marksLabel}>Marks</Text>
              <Text style={G.marksMax}>/ {totalMarks}</Text>
              {pct != null && (
                <View style={[G.pctBadge, { backgroundColor: pct >= 75 ? GREEN_LIGHT : pct >= 50 ? AMBER_LIGHT : RED_LIGHT }]}>
                  <Text style={[G.pctText, { color: pct >= 75 ? GREEN : pct >= 50 ? AMBER : RED }]}>{pct}%</Text>
                </View>
              )}
            </View>
            <TextInput
              style={G.marksInput}
              keyboardType="numeric"
              placeholder="0"
              value={marksInput}
              onChangeText={setMarksInput}
            />
          </View>

          <Text style={G.feedbackLabel}>Feedback <Text style={{ fontWeight: "400", color: GREY }}>(optional)</Text></Text>
          <TextInput
            style={[G.input, G.textarea]}
            placeholder="Write feedback for the student…"
            value={feedback}
            onChangeText={setFeedback}
            multiline
            textAlignVertical="top"
          />

          {/* Return toggle — like Google Classroom */}
          <View style={G.returnRow}>
            <View style={{ flex: 1 }}>
              <Text style={G.returnLabel}>Return to student</Text>
              <Text style={G.returnSub}>
                {returned ? "Student can see their grade and feedback" : "Grade is hidden — student cannot see it yet"}
              </Text>
            </View>
            <TouchableOpacity
              style={[G.toggle, returned && G.toggleOn]}
              onPress={() => setReturned(!returned)}
            >
              <View style={[G.knob, returned && G.knobOn]} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[G.saveBtn, saving && { opacity: 0.7 }]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator color={WHITE} />
              : <Text style={G.saveBtnText}>{returned ? "Save & Return" : "Save Grade (Hidden)"}</Text>
            }
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const G = StyleSheet.create({
  content:      { padding: 20 },
  header:       { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  title:        { fontSize: 22, fontWeight: "800", color: DARK },

  studentCard:  { flexDirection: "row", alignItems: "flex-start", gap: 14, backgroundColor: PRIMARY_LIGHT, borderRadius: 14, padding: 14, marginBottom: 16 },
  avatar:       { width: 44, height: 44, borderRadius: 12, backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center" },
  avatarTxt:    { color: WHITE, fontSize: 18, fontWeight: "800" },
  studentName:  { fontSize: 16, fontWeight: "700", color: DARK },
  studentRoll:  { fontSize: 12, color: GREY, marginTop: 2 },
  submittedAt:  { fontSize: 11, color: GREY, marginTop: 3 },

  answerBox:    { backgroundColor: "#F9FAFB", borderRadius: 12, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: BORDER },
  answerLabel:  { fontSize: 11, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 },
  answerText:   { fontSize: 14, color: "#374151", lineHeight: 22 },

  section:      { marginBottom: 14 },
  sectionLabel: { fontSize: 12, fontWeight: "700", color: GREY, marginBottom: 8 },
  attachChip:   { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: PRIMARY_LIGHT, borderRadius: 10, padding: 10, marginBottom: 6 },
  attachChipText:{ flex: 1, fontSize: 13, fontWeight: "600", color: PRIMARY },

  marksSection: { marginBottom: 14 },
  marksTopRow:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  marksLabel:   { fontSize: 14, fontWeight: "700", color: DARK },
  marksMax:     { fontSize: 14, color: GREY },
  pctBadge:     { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, marginLeft: "auto" as any },
  pctText:      { fontSize: 13, fontWeight: "800" },
  marksInput:   { height: 56, borderWidth: 2, borderColor: PRIMARY, borderRadius: 14, textAlign: "center", fontSize: 26, fontWeight: "800", color: PRIMARY, backgroundColor: PRIMARY_LIGHT },

  feedbackLabel:{ fontSize: 14, fontWeight: "700", color: DARK, marginBottom: 6 },
  input:        { borderWidth: 1.5, borderColor: BORDER, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: DARK, backgroundColor: "#F9FAFB" },
  textarea:     { minHeight: 100, textAlignVertical: "top" },

  returnRow:    { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#F9FAFB", borderRadius: 12, padding: 14, marginTop: 16, marginBottom: 8, borderWidth: 1, borderColor: BORDER },
  returnLabel:  { fontSize: 14, fontWeight: "700", color: DARK },
  returnSub:    { fontSize: 12, color: GREY, marginTop: 2 },
  toggle:       { width: 50, height: 28, borderRadius: 20, backgroundColor: "#D1D5DB", justifyContent: "center" },
  toggleOn:     { backgroundColor: GREEN },
  knob:         { width: 22, height: 22, borderRadius: 11, backgroundColor: WHITE, marginLeft: 3 },
  knobOn:       { marginLeft: 25 },

  saveBtn:      { backgroundColor: GREEN, borderRadius: 14, height: 52, alignItems: "center", justifyContent: "center", marginTop: 8 },
  saveBtnText:  { color: WHITE, fontWeight: "800", fontSize: 16 },
});

// ════════════════════════════════════════════════════════════════════════════
// GRADE-ALL MODAL — register-style inline marks entry for all students
// ════════════════════════════════════════════════════════════════════════════
function GradeAllModal({ visible, rows, totalMarks, teacher_id, onClose, onSaved }: {
  visible:    boolean;
  rows:       RegisterRow[];
  totalMarks: number;
  teacher_id: string;
  onClose:    () => void;
  onSaved:    () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [returnAll, setReturnAll] = useState(false);
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    if (visible) {
      const init: Record<string, string> = {};
      rows.forEach((r) => {
        init[r.uid] = r.submission?.marks_obtained != null ? String(r.submission.marks_obtained) : "";
      });
      setDrafts(init);
    }
  }, [visible, rows]);

  const submitted = rows.filter((r) => r.submission);

  const handleSaveAll = async () => {
    const toGrade = submitted.filter((r) => drafts[r.uid]?.trim() !== "");
    if (!toGrade.length) { Alert.alert("Nothing to save", "Enter marks for at least one student."); return; }

    const invalid = toGrade.find((r) => isNaN(Number(drafts[r.uid])) || Number(drafts[r.uid]) < 0 || Number(drafts[r.uid]) > totalMarks);
    if (invalid) { Alert.alert("Invalid marks", `Check marks for ${invalid.name}`); return; }

    setSaving(true);
    let ok = 0; let fail = 0;
    await Promise.all(
      toGrade.map(async (r) => {
        try {
          const sub    = r.submission!;
          const isEdit = sub.status === "graded";
          const res    = await fetch(`${API_URL}/api/assignments/grade/${sub.submission_id}`, {
            method:  isEdit ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              teacher_id,
              marks_obtained: Number(drafts[r.uid]),
              returned: returnAll,
            }),
          });
          const data = await res.json();
          if (data.success) ok++; else fail++;
        } catch { fail++; }
      })
    );
    setSaving(false);

    if (fail === 0) {
      Alert.alert(" Done", `${ok} student${ok !== 1 ? "s" : ""} graded${returnAll ? " and marks returned" : ""}.`,
        [{ text: "OK", onPress: () => { onClose(); onSaved(); } }]
      );
    } else {
      Alert.alert("Partial", `${ok} saved, ${fail} failed.`, [{ text: "OK", onPress: () => { onClose(); onSaved(); } }]);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
        <View style={GA.header}>
          <TouchableOpacity onPress={onClose}><Ionicons name="close" size={24} color={GREY} /></TouchableOpacity>
          <Text style={GA.headerTitle}>Grade All</Text>
          <TouchableOpacity
            style={[GA.saveAllBtn, saving && { opacity: 0.7 }]}
            onPress={handleSaveAll}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator size="small" color={WHITE} />
              : <Text style={GA.saveAllText}>Save All</Text>
            }
          </TouchableOpacity>
        </View>

        {/* Return all toggle */}
        <View style={GA.returnAllRow}>
          <View style={{ flex: 1 }}>
            <Text style={GA.returnAllLabel}>Return all to students</Text>
            <Text style={GA.returnAllSub}>Students will see their grades immediately</Text>
          </View>
          <TouchableOpacity
            style={[GA.toggle, returnAll && GA.toggleOn]}
            onPress={() => setReturnAll(!returnAll)}
          >
            <View style={[GA.knob, returnAll && GA.knobOn]} />
          </TouchableOpacity>
        </View>

        {/* Register table */}
        <View style={GA.tableHeader}>
          <Text style={[GA.col, GA.colStudent]}>Student</Text>
          <Text style={[GA.col, GA.colStatus]}>Status</Text>
          <Text style={[GA.col, GA.colMarks]}>Marks / {totalMarks}</Text>
        </View>

        <FlatList
          data={rows}
          keyExtractor={(r) => r.uid}
          contentContainerStyle={{ paddingBottom: 40 }}
          renderItem={({ item: r, index }) => {
            const ss = statusStyle(r.submission);
            const sub = r.submission;
            return (
              <View style={[GA.tableRow, index % 2 === 0 && GA.tableRowAlt]}>
                {/* Student */}
                <View style={GA.colStudentView}>
                  <Text style={GA.studentName} numberOfLines={1}>{r.name}</Text>
                  {r.roll && <Text style={GA.studentRoll}>{r.roll}</Text>}
                </View>
                {/* Status */}
                <View style={GA.colStatusView}>
                  <View style={[GA.statusBadge, { backgroundColor: ss.bg }]}>
                    <Text style={[GA.statusText, { color: ss.text }]}>{ss.label}</Text>
                  </View>
                  {sub?.submitted_at && (
                    <Text style={GA.submittedAt}>{fmtShortDate(sub.submitted_at)}</Text>
                  )}
                </View>
                {/* Marks input */}
                <View style={GA.colMarksView}>
                  {sub ? (
                    <TextInput
                      style={[GA.marksInput, !drafts[r.uid] && GA.marksInputEmpty]}
                      keyboardType="numeric"
                      placeholder="—"
                      placeholderTextColor="#9CA3AF"
                      value={drafts[r.uid] || ""}
                      onChangeText={(v) => setDrafts((d) => ({ ...d, [r.uid]: v }))}
                      maxLength={4}
                    />
                  ) : (
                    <Text style={GA.noSubText}>—</Text>
                  )}
                </View>
              </View>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const GA = StyleSheet.create({
  header:       { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, backgroundColor: WHITE, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTitle:  { fontSize: 18, fontWeight: "800", color: DARK },
  saveAllBtn:   { backgroundColor: PRIMARY, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  saveAllText:  { color: WHITE, fontWeight: "700", fontSize: 14 },

  returnAllRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, backgroundColor: WHITE, borderBottomWidth: 1, borderBottomColor: BORDER },
  returnAllLabel: { fontSize: 14, fontWeight: "700", color: DARK },
  returnAllSub:   { fontSize: 12, color: GREY, marginTop: 2 },
  toggle:       { width: 50, height: 28, borderRadius: 20, backgroundColor: "#D1D5DB", justifyContent: "center" },
  toggleOn:     { backgroundColor: GREEN },
  knob:         { width: 22, height: 22, borderRadius: 11, backgroundColor: WHITE, marginLeft: 3 },
  knobOn:       { marginLeft: 25 },

  tableHeader:  { flexDirection: "row", paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#F8FAFC", borderBottomWidth: 2, borderBottomColor: BORDER },
  col:          { fontSize: 11, fontWeight: "800", color: GREY, textTransform: "uppercase", letterSpacing: 0.5 },
  colStudent:   { flex: 2 },
  colStatus:    { flex: 1.4, textAlign: "center" },
  colMarks:     { flex: 1.2, textAlign: "center" },

  tableRow:     { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: BORDER, backgroundColor: WHITE },
  tableRowAlt:  { backgroundColor: "#FAFAFA" },
  colStudentView:{ flex: 2 },
  colStatusView: { flex: 1.4, alignItems: "center" },
  colMarksView:  { flex: 1.2, alignItems: "center" },

  studentName:  { fontSize: 13, fontWeight: "700", color: DARK },
  studentRoll:  { fontSize: 11, color: GREY, marginTop: 1 },
  statusBadge:  { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  statusText:   { fontSize: 11, fontWeight: "700" },
  submittedAt:  { fontSize: 10, color: GREY, marginTop: 2 },

  marksInput:      { width: 56, height: 36, borderWidth: 2, borderColor: PRIMARY, borderRadius: 10, textAlign: "center", fontSize: 16, fontWeight: "800", color: PRIMARY, backgroundColor: PRIMARY_LIGHT },
  marksInputEmpty: { borderColor: BORDER, backgroundColor: "#F9FAFB", color: GREY },
  noSubText:       { fontSize: 16, color: BORDER, fontWeight: "600" },
});

// ════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ════════════════════════════════════════════════════════════════════════════
export default function TeacherAssignmentDetail() {
  const navigation = useNavigation<any>();
  const route      = useRoute<any>();
  const { assignment: initialAssignment, teacher_id } = route.params;

  const [assignment,   setAssignment]   = useState(initialAssignment);
  const [rows,         setRows]         = useState<RegisterRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [editVisible,  setEditVisible]  = useState(false);
  const [gradeModal,   setGradeModal]   = useState(false);
  const [gradeAllModal,setGradeAllModal]= useState(false);
  const [selectedRow,  setSelectedRow]  = useState<RegisterRow | null>(null);
  const [viewMode,     setViewMode]     = useState<"all" | "submitted" | "missing">("all");

  const reload = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const [subRes, assignRes] = await Promise.all([
        fetch(`${API_URL}/api/assignments/${assignment.assignment_id}/submissions?teacher_id=${teacher_id}`),
        fetch(`${API_URL}/api/assignments/${assignment.assignment_id}`),
      ]);
      const subData    = await subRes.json();
      const assignData = await assignRes.json();

      if (assignData.success) setAssignment(assignData.assignment);

      const submissions: Submission[] = subData.submissions || [];
      const subMap = new Map(submissions.map((s) => [s.student_uid, s]));

      // Merge enrolled students (if API provides them) with submissions
      // Fall back to submissions-only list if no enrolled list is available
      let allStudents: { uid: string; name: string; roll: string | null }[] = [];
      try {
        const stdRes  = await fetch(`${API_URL}/api/assignments/${assignment.assignment_id}/students?teacher_id=${teacher_id}`);
        const stdData = await stdRes.json();
        if (stdData.success && stdData.students?.length) {
          allStudents = stdData.students;
        }
      } catch { /* no enrolled student list — fall back to submissions only */ }

      if (!allStudents.length) {
        allStudents = submissions.map((s) => ({
          uid:  s.student_uid,
          name: s.student_name || s.student_uid,
          roll: s.student_roll,
        }));
      }

      const newRows: RegisterRow[] = allStudents.map((st) => {
        const sub = subMap.get(st.uid) || null;
        return {
          uid:           st.uid,
          name:          st.name,
          roll:          st.roll,
          submission:    sub,
          draftMarks:    sub?.marks_obtained != null ? String(sub.marks_obtained) : "",
          draftFeedback: sub?.feedback || "",
        };
      });

      // Sort: submitted first (graded → submitted → late), then not submitted
      newRows.sort((a, b) => {
        const order:any = { graded: 0, late: 1, submitted: 2, null: 3 };
        const as_ = (a.submission?.status as any) || "null";
        const bs_ = (b.submission?.status as any) || "null";
        if (order[as_] !== order[bs_]) return order[as_] - order[bs_];
        return (a.roll || a.name).localeCompare(b.roll || b.name, undefined, { numeric: true });
      });

      setRows(newRows);
    } catch (e) { console.error(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, [assignment.assignment_id, teacher_id]);

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const handleDelete = () => {
    Alert.alert("Delete Assignment", "This will delete all submissions too. Continue?", [
      { text: "Cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          await fetch(`${API_URL}/api/assignments/${assignment.assignment_id}?teacher_id=${teacher_id}`, { method: "DELETE" });
          navigation.goBack();
        },
      },
    ]);
  };

  // ── Derived counts ─────────────────────────────────────────────────────────
  const totalStudents = rows.length;
  const submitted     = rows.filter((r) => r.submission).length;
  const graded        = rows.filter((r) => r.submission?.status === "graded").length;
  const missing       = totalStudents - submitted;
  const overdue       = new Date(assignment.due_date) < new Date();

  const visibleRows = viewMode === "submitted"
    ? rows.filter((r) => r.submission)
    : viewMode === "missing"
    ? rows.filter((r) => !r.submission)
    : rows;

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={S.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); reload(true); }} colors={[PRIMARY]} />}
      >
        {/* ── Top bar ── */}
        <View style={S.topBar}>
          <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
            <Ionicons name="chevron-back" size={22} color={PRIMARY} />
          </TouchableOpacity>
          <Text style={S.topTitle} numberOfLines={1}>{assignment.title}</Text>
          <View style={S.topActions}>
            <TouchableOpacity style={S.iconBtn} onPress={() => setEditVisible(true)}>
              <Ionicons name="create-outline" size={18} color={PRIMARY} />
            </TouchableOpacity>
            <TouchableOpacity style={[S.iconBtn, { backgroundColor: RED_LIGHT }]} onPress={handleDelete}>
              <Ionicons name="trash-outline" size={18} color={RED} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Info strip ── */}
        <View style={S.infoStrip}>
          <View style={S.infoChip}>
            <Ionicons name="time-outline" size={12} color={overdue ? RED : GREY} />
            <Text style={[S.infoChipText, { color: overdue ? RED : GREY }]}>
              {new Date(assignment.due_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
            </Text>
          </View>
          <View style={[S.infoChip, { backgroundColor: PRIMARY_LIGHT }]}>
            <Text style={[S.infoChipText, { color: PRIMARY }]}>{assignment.marks} pts</Text>
          </View>
          <View style={[S.infoChip, { backgroundColor: assignment.allow_late ? GREEN_LIGHT : RED_LIGHT }]}>
            <Text style={[S.infoChipText, { color: assignment.allow_late ? GREEN : RED }]}>
              {assignment.allow_late ? "Late OK" : "No late"}
            </Text>
          </View>
        </View>

        {/* ── Content sections ── */}
        {assignment.instructions && (
          <View style={S.section}>
            <Text style={S.sectionTitle}>Instructions</Text>
            <Text style={S.sectionText}>{assignment.instructions}</Text>
          </View>
        )}
        {assignment.questions && (
          <View style={S.section}>
            <Text style={S.sectionTitle}>Questions</Text>
            <Text style={S.sectionText}>{assignment.questions}</Text>
          </View>
        )}
        {assignment.attachments?.length > 0 && (
          <View style={S.section}>
            <Text style={S.sectionTitle}>Attachments</Text>
            {assignment.attachments.map((att: any, i: number) => (
              <TouchableOpacity key={i} style={S.fileChip} onPress={() => openFile(att.url)}>
                <Ionicons name={fileIcon(att.type)} size={14} color={PRIMARY} />
                <Text style={S.fileChipText} numberOfLines={1}>{att.name}</Text>
                <Ionicons name="open-outline" size={13} color={PRIMARY} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* ── Stats dashboard — like Classroom ── */}
        <View style={S.statsCard}>
          <View style={S.statItem}>
            <Text style={[S.statVal, { color: PRIMARY }]}>{submitted}</Text>
            <Text style={S.statLabel}>Submitted</Text>
          </View>
          <View style={S.statDivider} />
          <View style={S.statItem}>
            <Text style={[S.statVal, { color: GREEN }]}>{graded}</Text>
            <Text style={S.statLabel}>Graded</Text>
          </View>
          <View style={S.statDivider} />
          <View style={S.statItem}>
            <Text style={[S.statVal, { color: RED }]}>{missing}</Text>
            <Text style={S.statLabel}>Missing</Text>
          </View>
          <View style={S.statDivider} />
          <View style={S.statItem}>
            <Text style={[S.statVal, { color: GREY }]}>{totalStudents}</Text>
            <Text style={S.statLabel}>Total</Text>
          </View>
        </View>

        {/* ── Action buttons ── */}
        <View style={S.actionRow}>
          <TouchableOpacity style={S.gradeAllBtn} onPress={() => setGradeAllModal(true)}>
            <Ionicons name="list-outline" size={16} color={WHITE} />
            <Text style={S.gradeAllText}>Grade All</Text>
          </TouchableOpacity>
        </View>

        {/* ── Filter tabs ── */}
        <View style={S.filterRow}>
          {(["all", "submitted", "missing"] as const).map((mode) => {
            const labels = { all: `All (${totalStudents})`, submitted: `Submitted (${submitted})`, missing: `Missing (${missing})` };
            return (
              <TouchableOpacity
                key={mode}
                style={[S.filterTab, viewMode === mode && S.filterTabActive]}
                onPress={() => setViewMode(mode)}
              >
                <Text style={[S.filterTabText, viewMode === mode && S.filterTabTextActive]}>
                  {labels[mode]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Register table ── */}
        <View style={S.registerCard}>
          {/* Table header */}
          <View style={S.registerHeader}>
            <Text style={[S.regCol, S.regColStudent]}>Student</Text>
            <Text style={[S.regCol, S.regColStatus]}>Status</Text>
            <Text style={[S.regCol, S.regColMarks]}>Grade</Text>
            <View style={{ width: 32 }} />
          </View>

          {loading ? (
            <ActivityIndicator size="large" color={PRIMARY} style={{ marginVertical: 24 }} />
          ) : visibleRows.length === 0 ? (
            <View style={S.empty}>
              <Ionicons name="document-outline" size={36} color={GREY} />
              <Text style={S.emptyTitle}>
                {viewMode === "missing" ? "No missing submissions" : "No students found"}
              </Text>
            </View>
          ) : (
            visibleRows.map((r, idx) => {
              const ss  = statusStyle(r.submission);
              const sub = r.submission;
              return (
                <TouchableOpacity
                  key={r.uid}
                  style={[S.registerRow, idx % 2 === 0 && S.registerRowAlt]}
                  onPress={() => { setSelectedRow(r); setGradeModal(true); }}
                  activeOpacity={0.7}
                >
                  {/* Student */}
                  <View style={S.regColStudentView}>
                    <View style={S.studentAvatar}>
                      <Text style={S.avatarTxt}>{(r.name || "?").charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={S.studentName} numberOfLines={1}>{r.name}</Text>
                      {r.roll && <Text style={S.studentRoll}>{r.roll}</Text>}
                    </View>
                  </View>

                  {/* Status */}
                  <View style={S.regColStatusView}>
                    <View style={[S.statusBadge, { backgroundColor: ss.bg }]}>
                      <Text style={[S.statusText, { color: ss.text }]}>{ss.label}</Text>
                    </View>
                    {sub?.submitted_at && (
                      <Text style={S.subDate}>{fmtShortDate(sub.submitted_at)}</Text>
                    )}
                  </View>

                  {/* Grade */}
                  <View style={S.regColMarksView}>
                    {sub?.marks_obtained != null ? (
                      <>
                        <Text style={[S.gradeScore, { color: GREEN }]}>
                          {sub.marks_obtained}/{assignment.marks}
                        </Text>
                        {/* Return status indicator */}
                        <View style={[S.returnDot, { backgroundColor: sub.returned ? GREEN : AMBER }]}>
                          <Ionicons name={sub.returned ? "eye-outline" : "eye-off-outline"} size={9} color={WHITE} />
                        </View>
                      </>
                    ) : (
                      <Text style={S.noGrade}>—</Text>
                    )}
                  </View>

                  {/* Chevron */}
                  <Ionicons name="chevron-forward" size={16} color={GREY} />
                </TouchableOpacity>
              );
            })
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      <EditModal
        visible={editVisible}
        assignment={assignment}
        teacher_id={teacher_id}
        onClose={() => setEditVisible(false)}
        onSaved={() => reload(true)}
      />

      <GradeModal
        visible={gradeModal}
        row={selectedRow}
        totalMarks={assignment.marks}
        teacher_id={teacher_id}
        onClose={() => setGradeModal(false)}
        onSaved={() => reload(true)}
      />

      <GradeAllModal
        visible={gradeAllModal}
        rows={rows}
        totalMarks={assignment.marks}
        teacher_id={teacher_id}
        onClose={() => setGradeAllModal(false)}
        onSaved={() => reload(true)}
      />
    </SafeAreaView>
  );
}

// ─── Main styles ─────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 },

  topBar:    { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  backBtn:   { width: 36, height: 36, borderRadius: 18, backgroundColor: WHITE, alignItems: "center", justifyContent: "center", elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  topTitle:  { flex: 1, fontSize: 16, fontWeight: "800", color: DARK },
  topActions:{ flexDirection: "row", gap: 7 },
  iconBtn:   { width: 34, height: 34, borderRadius: 10, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center" },

  infoStrip: { flexDirection: "row", gap: 6, marginBottom: 12, flexWrap: "wrap" },
  infoChip:  { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: "#F3F4F6" },
  infoChipText: { fontSize: 12, fontWeight: "600" },

  section:      { backgroundColor: WHITE, borderRadius: 13, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: BORDER },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 },
  sectionText:  { fontSize: 14, color: "#374151", lineHeight: 21 },

  fileChip:     { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: PRIMARY_LIGHT, borderRadius: 9, padding: 9, marginBottom: 5 },
  fileChipText: { flex: 1, fontSize: 13, fontWeight: "600", color: PRIMARY },

  // ── Stats card ──
  statsCard:  { flexDirection: "row", backgroundColor: WHITE, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: BORDER },
  statItem:   { flex: 1, alignItems: "center" },
  statVal:    { fontSize: 22, fontWeight: "800" },
  statLabel:  { fontSize: 10, color: GREY, fontWeight: "600", marginTop: 2 },
  statDivider:{ width: 1, backgroundColor: BORDER },

  // ── Actions ──
  actionRow:    { flexDirection: "row", marginBottom: 12, gap: 8 },
  gradeAllBtn:  { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: PRIMARY, borderRadius: 12, paddingVertical: 13, shadowColor: PRIMARY, shadowOpacity: 0.25, shadowRadius: 8, elevation: 4 },
  gradeAllText: { color: WHITE, fontWeight: "800", fontSize: 15 },

  // ── Filter tabs ──
  filterRow:     { flexDirection: "row", backgroundColor: WHITE, borderRadius: 12, padding: 4, marginBottom: 10, borderWidth: 1, borderColor: BORDER },
  filterTab:     { flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 9 },
  filterTabActive:{ backgroundColor: PRIMARY },
  filterTabText: { fontSize: 12, fontWeight: "600", color: GREY },
  filterTabTextActive: { color: WHITE, fontWeight: "700" },

  // ── Register card ──
  registerCard: { backgroundColor: WHITE, borderRadius: 14, borderWidth: 1, borderColor: BORDER, overflow: "hidden" },

  registerHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#F8FAFC", borderBottomWidth: 2, borderBottomColor: BORDER },
  regCol:          { fontSize: 11, fontWeight: "800", color: GREY, textTransform: "uppercase", letterSpacing: 0.4 },
  regColStudent:   { flex: 2.5 },
  regColStatus:    { flex: 1.4, textAlign: "center" },
  regColMarks:     { flex: 1, textAlign: "center" },

  registerRow:    { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: BORDER, backgroundColor: WHITE },
  registerRowAlt: { backgroundColor: "#FAFAFA" },

  regColStudentView:{ flex: 2.5, flexDirection: "row", alignItems: "center", gap: 8 },
  regColStatusView: { flex: 1.4, alignItems: "center" },
  regColMarksView:  { flex: 1, alignItems: "center" },

  studentAvatar: { width: 32, height: 32, borderRadius: 8, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center" },
  avatarTxt:     { color: PRIMARY, fontWeight: "800", fontSize: 13 },
  studentName:   { fontSize: 13, fontWeight: "700", color: DARK },
  studentRoll:   { fontSize: 11, color: GREY },

  statusBadge:   { borderRadius: 7, paddingHorizontal: 6, paddingVertical: 3 },
  statusText:    { fontSize: 10, fontWeight: "700" },
  subDate:       { fontSize: 10, color: GREY, marginTop: 2 },

  gradeScore:    { fontSize: 13, fontWeight: "800" },
  returnDot:     { marginTop: 3, width: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  noGrade:       { fontSize: 16, color: BORDER, fontWeight: "600" },

  empty:      { alignItems: "center", paddingVertical: 30, gap: 8 },
  emptyTitle: { fontSize: 14, fontWeight: "700", color: DARK },
});