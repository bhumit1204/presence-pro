import React, { useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, ActivityIndicator, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute } from "@react-navigation/native";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as DocumentPicker from "expo-document-picker";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";
const GREY = "#6B7280";
const RED = "#EF4444";
const GREEN = "#10B981";
const API_URL = "http://10.132.90.56:5000";

function defaultDueDate() {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return d;
}

export default function CreateAssignment() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, course, teacher_id, onRefresh } = route.params;

  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [questions, setQuestions] = useState("");
  const [marks, setMarks] = useState("");
  const [dueDate, setDueDate] = useState<Date>(defaultDueDate());
  const [allowLate, setAllowLate] = useState(false);
  const [loading, setLoading] = useState(false);

  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  // Attachments
  const [pickedFiles, setPickedFiles] = useState<any[]>([]);
  const [links, setLinks] = useState<{ url: string; label: string }[]>([]);
  const [linkInput, setLinkInput] = useState("");
  const [uploading, setUploading] = useState(false);

  const onDateChange = (_: any, date?: Date) => {
    if (Platform.OS === "android") setShowDatePicker(false);
    if (date) {
      const merged = new Date(date);
      merged.setHours(dueDate.getHours(), dueDate.getMinutes());
      setDueDate(merged);
    }
  };

  const onTimeChange = (_: any, date?: Date) => {
    if (Platform.OS === "android") setShowTimePicker(false);
    if (date) {
      const merged = new Date(dueDate);
      merged.setHours(date.getHours(), date.getMinutes());
      setDueDate(merged);
    }
  };

  const pickFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (!result.canceled && result.assets) {
      setPickedFiles((prev) => [...prev, ...result.assets]);
    }
  };

  const addLink = () => {
    const trimmed = linkInput.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      Alert.alert("Invalid URL", "Please enter a valid URL starting with http:// or https://");
      return;
    }
    setLinks((prev) => [...prev, { url: trimmed, label: trimmed }]);
    setLinkInput("");
  };

  const uploadFiles = async (): Promise<any[]> => {
    if (pickedFiles.length === 0) return [];
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("folder", "assignments");
      pickedFiles.forEach((f) =>
        formData.append("files", { uri: f.uri, name: f.name, type: f.mimeType || "application/octet-stream" } as any)
      );
      const res = await fetch(`${API_URL}/api/assignments/upload`, { method: "POST", body: formData });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data.files || [];
    } finally {
      setUploading(false);
    }
  };

  const validate = () => {
    if (!title.trim()) { Alert.alert("Required", "Title is required."); return false; }
    if (!marks || isNaN(Number(marks)) || Number(marks) < 1) {
      Alert.alert("Invalid", "Marks must be a positive number."); return false;
    }
    if (!instructions.trim() && !questions.trim()) {
      Alert.alert("Required", "At least one of Instructions or Questions must be filled."); return false;
    }
    return true;
  };

  const handleCreate = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const uploadedFiles = await uploadFiles();
      const res = await fetch(`${API_URL}/api/assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teacher_id,
          course_id: course.course_id,
          subject_id: subject.subject_id,
          title: title.trim(),
          instructions: instructions.trim() || undefined,
          questions: questions.trim() || undefined,
          marks: Number(marks),
          due_date: dueDate.toISOString(),
          allow_late: allowLate,
          attachments: uploadedFiles,
          links,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      Alert.alert("Created!", "Assignment posted successfully.", [
        { text: "OK", onPress: () => { onRefresh?.(); navigation.goBack(); } },
      ]);
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={S.content} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={22} color={PRIMARY} />
        </TouchableOpacity>
        <Text style={S.title}>New Assignment</Text>
        <Text style={S.subtitle}>{subject.subject_name}</Text>

        <View style={S.card}>
          <Text style={S.label}>Title *</Text>
          <TextInput style={S.input} placeholder="Assignment title" value={title} onChangeText={setTitle} />

          <Text style={S.label}>Total Marks *</Text>
          <TextInput style={S.input} placeholder="e.g. 20" value={marks} onChangeText={setMarks} keyboardType="numeric" />

          <Text style={S.label}>Due Date</Text>
          <View style={S.dateRow}>
            <TouchableOpacity style={S.dateBtn} onPress={() => setShowDatePicker(true)}>
              <Ionicons name="calendar-outline" size={15} color={PRIMARY} />
              <Text style={S.dateBtnText}>{dueDate.toDateString()}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={S.dateBtn} onPress={() => setShowTimePicker(true)}>
              <Ionicons name="time-outline" size={15} color={PRIMARY} />
              <Text style={S.dateBtnText}>
                {dueDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </Text>
            </TouchableOpacity>
          </View>
          {showDatePicker && (
            <DateTimePicker value={dueDate} mode="date" minimumDate={new Date()}
              display={Platform.OS === "ios" ? "spinner" : "default"} onChange={onDateChange} />
          )}
          {showTimePicker && (
            <DateTimePicker value={dueDate} mode="time"
              display={Platform.OS === "ios" ? "spinner" : "default"} onChange={onTimeChange} />
          )}

          <Text style={S.label}>Instructions <Text style={S.optional}>(optional)</Text></Text>
          <Text style={S.hint}>At least one of Instructions or Questions required.</Text>
          <TextInput style={[S.input, S.textarea]} placeholder="e.g. Write a 500-word essay on..."
            value={instructions} onChangeText={setInstructions} multiline textAlignVertical="top" />

          <Text style={S.label}>Questions <Text style={S.optional}>(optional)</Text></Text>
          <TextInput style={[S.input, S.textarea]}
            placeholder={"e.g. 1. Explain the concept of...\n2. Describe the differences..."}
            value={questions} onChangeText={setQuestions} multiline textAlignVertical="top" />

          {/* Late toggle */}
          <View style={S.toggleRow}>
            <View>
              <Text style={S.label}>Allow late submissions</Text>
              <Text style={S.toggleSub}>Students can submit after the due date</Text>
            </View>
            <TouchableOpacity style={[S.toggle, allowLate && S.toggleActive]} onPress={() => setAllowLate(!allowLate)}>
              <View style={[S.knob, allowLate && S.knobActive]} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Attachments card */}
        <View style={S.card}>
          <Text style={S.sectionTitle}>Attachments</Text>

          {pickedFiles.length > 0 && pickedFiles.map((f, i) => (
            <View key={i} style={S.fileRow}>
              <Ionicons name="document-outline" size={15} color={PRIMARY} />
              <Text style={S.fileName} numberOfLines={1}>{f.name}</Text>
              <TouchableOpacity onPress={() => setPickedFiles((prev) => prev.filter((_, j) => j !== i))}>
                <Ionicons name="close-circle" size={18} color={RED} />
              </TouchableOpacity>
            </View>
          ))}

          <TouchableOpacity style={S.attachBtn} onPress={pickFiles}>
            <Ionicons name="attach" size={16} color={PRIMARY} />
            <Text style={S.attachBtnText}>Add Files</Text>
          </TouchableOpacity>

          <Text style={[S.label, { marginTop: 14 }]}>Add Link</Text>
          <View style={S.linkRow}>
            <TextInput
              style={[S.input, { flex: 1, marginBottom: 0 }]}
              placeholder="https://..."
              value={linkInput}
              onChangeText={setLinkInput}
              autoCapitalize="none"
              keyboardType="url"
            />
            <TouchableOpacity style={S.linkAddBtn} onPress={addLink}>
              <Text style={S.linkAddText}>Add</Text>
            </TouchableOpacity>
          </View>

          {links.map((l, i) => (
            <View key={i} style={S.fileRow}>
              <Ionicons name="link-outline" size={15} color={GREEN} />
              <Text style={S.fileName} numberOfLines={1}>{l.url}</Text>
              <TouchableOpacity onPress={() => setLinks((prev) => prev.filter((_, j) => j !== i))}>
                <Ionicons name="close-circle" size={18} color={RED} />
              </TouchableOpacity>
            </View>
          ))}
        </View>

        <TouchableOpacity
          style={[S.submitBtn, (loading || uploading) && { opacity: 0.7 }]}
          onPress={handleCreate}
          disabled={loading || uploading}
        >
          {loading || uploading
            ? <ActivityIndicator color="#FFF" />
            : <Text style={S.submitText}>Create Assignment</Text>
          }
        </TouchableOpacity>
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20 },
  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", marginTop: 4, marginBottom: 14, elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  title: { fontSize: 26, fontWeight: "800", color: "#111827", marginBottom: 4 },
  subtitle: { fontSize: 14, color: GREY, marginBottom: 20 },
  card: { backgroundColor: "#FFF", borderRadius: 20, padding: 18, borderWidth: 1, borderColor: "#E5E7EB", marginBottom: 16 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: "#111827", marginBottom: 10 },
  label: { fontSize: 14, fontWeight: "700", color: "#111827", marginTop: 12, marginBottom: 6 },
  optional: { fontWeight: "400", color: GREY },
  hint: { fontSize: 12, color: GREY, marginBottom: 6 },
  input: { borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: "#111827", backgroundColor: "#F9FAFB" },
  textarea: { minHeight: 100, textAlignVertical: "top" },
  dateRow: { gap: 8 },
  dateBtn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#EEF2FF", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 4 },
  dateBtnText: { fontSize: 14, fontWeight: "600", color: PRIMARY },
  toggleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16 },
  toggleSub: { fontSize: 12, color: GREY, marginTop: 2 },
  toggle: { width: 50, height: 28, borderRadius: 20, backgroundColor: "#D1D5DB", justifyContent: "center" },
  toggleActive: { backgroundColor: PRIMARY },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#FFF", marginLeft: 3 },
  knobActive: { marginLeft: 25 },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#F9FAFB", borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: "#E5E7EB" },
  fileName: { flex: 1, fontSize: 13, color: "#374151" },
  attachBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1.5, borderColor: PRIMARY, borderRadius: 12, paddingVertical: 12, marginTop: 4, borderStyle: "dashed" },
  attachBtnText: { color: PRIMARY, fontWeight: "700", fontSize: 14 },
  linkRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  linkAddBtn: { backgroundColor: PRIMARY, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 13 },
  linkAddText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
  submitBtn: { backgroundColor: PRIMARY, borderRadius: 16, height: 54, alignItems: "center", justifyContent: "center", shadowColor: PRIMARY, shadowOpacity: 0.3, shadowRadius: 10, elevation: 4 },
  submitText: { color: "#FFF", fontWeight: "800", fontSize: 16 },
});