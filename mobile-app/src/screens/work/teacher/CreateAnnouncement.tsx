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
const PRIMARY_LIGHT = "#EEF2FF";
const BG = "#F3F4F6";
const GREY = "#6B7280";
const GREEN = "#10B981";
const RED = "#EF4444";
const API_URL = "http://10.132.90.56:5000";

export default function CreateAnnouncement() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, course, teacher_id, onRefresh } = route.params;

  const [title, setTitle]           = useState("");
  const [text, setText]             = useState("");
  const [isPinned, setIsPinned]     = useState(false);
  const [pinExpiry, setPinExpiry]   = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [loading, setLoading]       = useState(false);

  // File attachments
  const [pickedFiles, setPickedFiles] = useState<any[]>([]);
  const [links, setLinks]             = useState<{ url: string; label: string }[]>([]);
  const [linkInput, setLinkInput]     = useState("");
  const [uploading, setUploading]     = useState(false);

  const handleCreate = async () => {
    if (!title.trim()) { Alert.alert("Required", "Please enter a title."); return; }
    if (!text.trim())  { Alert.alert("Required", "Please enter announcement text."); return; }
    if (isPinned && !pinExpiry) { Alert.alert("Required", "Please set a pin expiry date."); return; }

    setLoading(true);
    try {
      // 1. Create the announcement doc first to get its ID
      const createBody: any = {
        teacher_id,
        course_id:  course.course_id,
        subject_id: subject.subject_id,
        title:      title.trim(),
        text:       text.trim(),
        is_pinned:  isPinned,
        links:      JSON.stringify(links),
        attachments: "[]", // placeholder — updated after file upload
      };
      if (isPinned && pinExpiry) createBody.pin_expires_at = pinExpiry.toISOString();

      const createRes  = await fetch(`${API_URL}/api/assignments/announcements`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(createBody),
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error);

      const announcementId = createData.announcement_id;

      // 2. Upload files into announcements/{announcement_id}/ subfolder
      let uploadedFiles: any[] = [];
      if (pickedFiles.length > 0) {
        setUploading(true);
        const formData = new FormData();
        formData.append("folder",    "announcements");
        formData.append("entity_id", announcementId);
        pickedFiles.forEach((f) =>
          formData.append("files", { uri: f.uri, name: f.name, type: f.mimeType || "application/octet-stream" } as any)
        );
        const upRes  = await fetch(`${API_URL}/api/assignments/upload`, { method: "POST", body: formData });
        const upData = await upRes.json();
        setUploading(false);
        if (!upData.success) throw new Error(upData.error || "File upload failed");
        uploadedFiles = upData.files || [];
      }

      // 3. If we uploaded files, patch the announcement with the attachment list
      if (uploadedFiles.length > 0) {
        await fetch(`${API_URL}/api/assignments/announcements/${announcementId}`, {
          method:  "PUT",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ teacher_id, attachments: uploadedFiles }),
        });
      }

      Alert.alert("Posted!", "Announcement created successfully.", [
        { text: "OK", onPress: () => { onRefresh?.(); navigation.goBack(); } },
      ]);
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setLoading(false);
      setUploading(false);
    }
  };

  const pickFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (!result.canceled && result.assets) setPickedFiles((prev) => [...prev, ...result.assets]);
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

  const onDateChange = (_: any, date?: Date) => {
    if (Platform.OS === "android") setShowDatePicker(false);
    if (date) setPinExpiry(date);
  };

  const onTimeChange = (_: any, date?: Date) => {
    if (Platform.OS === "android") setShowTimePicker(false);
    if (date) {
      const merged = new Date(pinExpiry || new Date());
      merged.setHours(date.getHours(), date.getMinutes());
      setPinExpiry(merged);
    }
  };

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={S.content} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={22} color={PRIMARY} />
        </TouchableOpacity>
        <Text style={S.title}>New Announcement</Text>
        <Text style={S.subtitle}>{subject.subject_name}</Text>

        {/* Main form */}
        <View style={S.card}>
          <Text style={S.label}>Title *</Text>
          <TextInput style={S.input} placeholder="e.g. Mid-term Syllabus Update" value={title} onChangeText={setTitle} />

          <Text style={S.label}>Message *</Text>
          <TextInput style={[S.input, S.textarea]} placeholder="Write your announcement here..." value={text} onChangeText={setText} multiline textAlignVertical="top" />

          {/* Pin toggle */}
          <View style={S.toggleRow}>
            <View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ionicons name="pin" size={16} color={PRIMARY} />
                <Text style={S.label}>Pin to top</Text>
              </View>
              <Text style={S.toggleSub}>Pinned posts always appear first</Text>
            </View>
            <TouchableOpacity
              style={[S.toggle, isPinned && S.toggleActive]}
              onPress={() => { setIsPinned(!isPinned); if (isPinned) setPinExpiry(null); }}
            >
              <View style={[S.knob, isPinned && S.knobActive]} />
            </TouchableOpacity>
          </View>

          {/* Pin expiry */}
          {isPinned && (
            <>
              <Text style={S.label}>Pin expires on *</Text>
              <Text style={S.pinHint}>After this date, the post will unpin automatically.</Text>
              <View style={S.dateRow}>
                <TouchableOpacity style={S.dateBtn} onPress={() => setShowDatePicker(true)}>
                  <Text style={S.dateBtnText}>{pinExpiry ? pinExpiry.toDateString() : "Pick date"}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={S.dateBtn} onPress={() => setShowTimePicker(true)}>
                  <Text style={S.dateBtnText}>
                    {pinExpiry ? pinExpiry.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Pick time"}
                  </Text>
                </TouchableOpacity>
              </View>
              {showDatePicker && (
                <DateTimePicker value={pinExpiry || new Date()} mode="date" minimumDate={new Date()}
                  display={Platform.OS === "ios" ? "spinner" : "default"} onChange={onDateChange} />
              )}
              {showTimePicker && (
                <DateTimePicker value={pinExpiry || new Date()} mode="time"
                  display={Platform.OS === "ios" ? "spinner" : "default"} onChange={onTimeChange} />
              )}
            </>
          )}
        </View>

        {/* Attachments card */}
        <View style={S.card}>
          <Text style={S.sectionTitle}>Attachments</Text>

          {pickedFiles.map((f, i) => (
            <View key={i} style={S.fileRow}>
              <Ionicons name="document-outline" size={15} color={PRIMARY} />
              <Text style={S.fileName} numberOfLines={1}>{f.name}</Text>
              <TouchableOpacity onPress={() => setPickedFiles((p) => p.filter((_, j) => j !== i))}>
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
              <TouchableOpacity onPress={() => setLinks((p) => p.filter((_, j) => j !== i))}>
                <Ionicons name="close-circle" size={18} color={RED} />
              </TouchableOpacity>
            </View>
          ))}
        </View>

        {/* Submit */}
        <TouchableOpacity
          style={[S.submitBtn, (loading || uploading) && { opacity: 0.7 }]}
          onPress={handleCreate}
          disabled={loading || uploading}
        >
          {loading || uploading
            ? <ActivityIndicator color="#FFF" />
            : <Text style={S.submitText}>Post Announcement</Text>
          }
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20 },

  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", marginTop: 4, marginBottom: 14, elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  title:    { fontSize: 26, fontWeight: "800", color: "#111827", marginBottom: 4 },
  subtitle: { fontSize: 14, color: GREY, marginBottom: 20 },

  card: { backgroundColor: "#FFF", borderRadius: 20, padding: 18, borderWidth: 1, borderColor: "#E5E7EB", marginBottom: 16 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: "#111827", marginBottom: 10 },

  label: { fontSize: 14, fontWeight: "700", color: "#111827", marginTop: 12, marginBottom: 6 },
  input: { borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: "#111827", backgroundColor: "#F9FAFB" },
  textarea: { minHeight: 120, textAlignVertical: "top" },

  toggleRow:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16 },
  toggleSub:   { fontSize: 12, color: GREY, marginTop: 2 },
  toggle:      { width: 50, height: 28, borderRadius: 20, backgroundColor: "#D1D5DB", justifyContent: "center" },
  toggleActive:{ backgroundColor: PRIMARY },
  knob:        { width: 22, height: 22, borderRadius: 11, backgroundColor: "#FFF", marginLeft: 3 },
  knobActive:  { marginLeft: 25 },

  pinHint: { fontSize: 12, color: GREY, marginBottom: 8 },
  dateRow: { gap: 8 },
  dateBtn: { backgroundColor: "#F3F4F6", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: "#E5E7EB", marginBottom: 4 },
  dateBtnText: { fontSize: 14, fontWeight: "600", color: "#111827" },

  fileRow:     { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#F9FAFB", borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: "#E5E7EB" },
  fileName:    { flex: 1, fontSize: 13, color: "#374151" },
  attachBtn:   { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1.5, borderColor: PRIMARY, borderRadius: 12, paddingVertical: 12, marginTop: 4, borderStyle: "dashed" },
  attachBtnText: { color: PRIMARY, fontWeight: "700", fontSize: 14 },
  linkRow:     { flexDirection: "row", gap: 8, alignItems: "center" },
  linkAddBtn:  { backgroundColor: PRIMARY, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 13 },
  linkAddText: { color: "#FFF", fontWeight: "700", fontSize: 14 },

  submitBtn:  { backgroundColor: PRIMARY, borderRadius: 16, height: 54, alignItems: "center", justifyContent: "center", shadowColor: PRIMARY, shadowOpacity: 0.3, shadowRadius: 10, elevation: 4 },
  submitText: { color: "#FFF", fontWeight: "800", fontSize: 16 },
});