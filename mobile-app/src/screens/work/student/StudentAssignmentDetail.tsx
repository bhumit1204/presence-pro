import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, useFocusEffect } from "@react-navigation/native";
import * as DocumentPicker from "expo-document-picker";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG = "#F3F4F6";
const GREEN = "#10B981";
const GREEN_LIGHT = "#D1FAE5";
const AMBER = "#F59E0B";
const AMBER_LIGHT = "#FEF3C7";
const GREY = "#6B7280";
const RED = "#EF4444";
const RED_LIGHT = "#FEF2F2";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isPastDue(iso: string) {
  return new Date(iso) < new Date();
}

function fileIcon(type: string) {
  if (!type) return "document-outline";
  if (type.includes("pdf")) return "document-text-outline";
  if (type.includes("image")) return "image-outline";
  if (type.includes("word") || type.includes("document")) return "document-outline";
  if (type.includes("sheet") || type.includes("excel")) return "grid-outline";
  if (type.includes("presentation") || type.includes("powerpoint")) return "easel-outline";
  return "attach-outline";
}

function formatBytes(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function StudentAssignmentDetail() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { assignment, student_uid } = route.params;

  const [submission, setSubmission] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [pickedFiles, setPickedFiles] = useState<any[]>([]);
  const [linkInput, setLinkInput] = useState("");
  const [links, setLinks] = useState<{ url: string; label: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [unsubmitting, setUnsubmitting] = useState(false);

  const overdue = isPastDue(assignment.due_date);
  const canLateSubmit = overdue && assignment.allow_late;
  const blocked = overdue && !assignment.allow_late;

  const loadSubmission = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `${API_URL}/api/assignments/${assignment.assignment_id}/my-submission?student_uid=${student_uid}`
      );
      const data = await res.json();
      if (data.success && data.submission) {
        setSubmission(data.submission);
      } else {
        setSubmission(null);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [assignment.assignment_id, student_uid]);

  useFocusEffect(useCallback(() => { loadSubmission(); }, [loadSubmission]));

  const openFile = async (url: string) => {
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch {
      Linking.openURL(url);
    }
  };

  const pickFiles = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (!result.canceled && result.assets) {
        setPickedFiles((prev) => [...prev, ...result.assets]);
      }
    } catch {
      Alert.alert("Error", "Could not pick files.");
    }
  };

  const uploadFiles = async (): Promise<any[]> => {
    if (pickedFiles.length === 0) return [];
    setUploadingFiles(true);
    try {
      const formData = new FormData();
      formData.append("folder", "submissions");
      pickedFiles.forEach((file) =>
        formData.append("files", { uri: file.uri, name: file.name, type: file.mimeType || "application/octet-stream" } as any)
      );
      const res = await fetch(`${API_URL}/api/assignments/upload`, { method: "POST", body: formData });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data.files || [];
    } finally {
      setUploadingFiles(false);
    }
  };

  const handleSubmit = async () => {
    const isResubmit = submission !== null;
    // For first submission: must have at least new files or links
    // For resubmit: can turn in with just existing submission files (no new additions required)
    if (!isResubmit && pickedFiles.length === 0 && links.length === 0) {
      Alert.alert("Nothing to submit", "Please attach a file or add a link.");
      return;
    }
    setSubmitting(true);
    try {
      const uploadedFiles = await uploadFiles();
      const endpoint = isResubmit
        ? `${API_URL}/api/assignments/${assignment.assignment_id}/resubmit`
        : `${API_URL}/api/assignments/${assignment.assignment_id}/submit`;

      const res = await fetch(endpoint, {
        method: isResubmit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          student_uid,
          attachments: uploadedFiles,
          links: links,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      setPickedFiles([]);
      setLinks([]);
      Alert.alert(
        isResubmit ? "Updated!" : "Turned in!",
        isResubmit ? "Your submission has been updated." : "Assignment turned in successfully.",
        [{ text: "OK", onPress: loadSubmission }]
      );
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnsubmit = () => {
    Alert.alert(
      "Unsubmit?",
      "Your submission will be marked as unsubmitted. You can submit again anytime.",
      [
        { text: "Cancel" },
        {
          text: "Unsubmit", style: "destructive",
          onPress: async () => {
            setUnsubmitting(true);
            try {
              const res = await fetch(
                `${API_URL}/api/assignments/${assignment.assignment_id}/unsubmit`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ student_uid }),
                }
              );
              const data = await res.json();
              if (!data.success) throw new Error(data.error);
              loadSubmission();
            } catch (e: any) {
              Alert.alert("Error", e.message);
            } finally {
              setUnsubmitting(false);
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={S.safe} edges={["top"]}>
        <View style={S.center}><ActivityIndicator size="large" color={PRIMARY} /></View>
      </SafeAreaView>
    );
  }

  const isSubmitted = !!submission;
  const isGraded = submission?.status === "graded";

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={S.content} showsVerticalScrollIndicator={false}>
        {/* Back */}
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={22} color={PRIMARY} />
        </TouchableOpacity>

        {/* Header info row */}
        <View style={S.headerCard}>
          <Text style={S.assignTitle} numberOfLines={3}>{assignment.title}</Text>
          <View style={S.headerMeta}>
            <View style={S.metaChip}>
              <Ionicons name="time-outline" size={12} color={overdue ? RED : GREY} />
              <Text style={[S.metaChipText, { color: overdue ? RED : GREY }]}>Due {fmtDate(assignment.due_date)}</Text>
            </View>
            <View style={[S.metaChip, { backgroundColor: PRIMARY_LIGHT }]}>
              <Text style={[S.metaChipText, { color: PRIMARY }]}>{assignment.marks} pts</Text>
            </View>
            {assignment.allow_late && (
              <View style={[S.metaChip, { backgroundColor: AMBER_LIGHT }]}>
                <Text style={[S.metaChipText, { color: AMBER }]}>Late OK</Text>
              </View>
            )}
          </View>
        </View>

        {/* Grade card */}
        {isGraded && (
          <View style={S.gradeCard}>
            <Text style={S.gradeLabel}>Your Grade</Text>
            <Text style={S.gradeScore}>{submission.marks_obtained}<Text style={S.gradeOf}>/{assignment.marks}</Text></Text>
            {submission.feedback && <Text style={S.gradeFeedback}>{submission.feedback}</Text>}
          </View>
        )}

        {/* Instructions */}
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

        {/* Teacher attachments */}
        {assignment.attachments?.length > 0 && (
          <View style={S.section}>
            <Text style={S.sectionTitle}>Resources</Text>
            {assignment.attachments.map((att: any, i: number) => (
              <TouchableOpacity key={i} style={S.fileCard} onPress={() => openFile(att.url)}>
                <View style={[S.fileIconWrap, { backgroundColor: PRIMARY_LIGHT }]}>
                  <Ionicons name={fileIcon(att.type)} size={18} color={PRIMARY} />
                </View>
                <View style={S.fileInfo}>
                  <Text style={S.fileName} numberOfLines={1}>{att.name}</Text>
                  {att.size > 0 && <Text style={S.fileSize}>{formatBytes(att.size)}</Text>}
                </View>
                <Ionicons name="open-outline" size={16} color={GREY} />
              </TouchableOpacity>
            ))}
            {assignment.links?.map((l: any, i: number) => (
              <TouchableOpacity key={`l${i}`} style={S.fileCard} onPress={() => openFile(l.url)}>
                <View style={[S.fileIconWrap, { backgroundColor: "#D1FAE5" }]}>
                  <Ionicons name="link-outline" size={18} color={GREEN} />
                </View>
                <Text style={[S.fileName, { flex: 1 }]} numberOfLines={1}>{l.label || l.url}</Text>
                <Ionicons name="open-outline" size={16} color={GREY} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* ── Your Work section ─────────────────────────────────── */}
        <View style={S.yourWorkCard}>
          <View style={S.yourWorkHeader}>
            <Text style={S.yourWorkTitle}>Your Work</Text>
            {isSubmitted && (
              <View style={[S.statusBadge, { backgroundColor: isGraded ? GREEN_LIGHT : AMBER_LIGHT }]}>
                <Ionicons name="checkmark" size={11} color={isGraded ? GREEN : AMBER} />
                <Text style={[S.statusBadgeText, { color: isGraded ? GREEN : AMBER }]}>
                  {isGraded ? "Graded" : "Turned in"}
                </Text>
              </View>
            )}
          </View>

          {/* Warn if graded and resubmitting */}
          {isGraded && pickedFiles.length + links.length > 0 && (
            <View style={S.warnBox}>
              <Text style={S.warnText}>Resubmitting will reset your grade.</Text>
            </View>
          )}

          {/* Previously submitted files */}
          {isSubmitted && submission.attachments?.length > 0 && (
            <>
              {submission.attachments.map((att: any, i: number) => (
                <TouchableOpacity key={i} style={S.fileCard} onPress={() => openFile(att.url)}>
                  <View style={[S.fileIconWrap, { backgroundColor: "#F9FAFB" }]}>
                    <Ionicons name={fileIcon(att.type)} size={18} color={GREY} />
                  </View>
                  <View style={S.fileInfo}>
                    <Text style={S.fileName} numberOfLines={1}>{att.name}</Text>
                    {att.size > 0 && <Text style={S.fileSize}>{formatBytes(att.size)}</Text>}
                  </View>
                  <Ionicons name="open-outline" size={16} color={GREY} />
                </TouchableOpacity>
              ))}
            </>
          )}

          {isSubmitted && submission.links?.length > 0 && submission.links.map((l: any, i: number) => (
            <TouchableOpacity key={`sl${i}`} style={S.fileCard} onPress={() => openFile(l.url)}>
              <View style={[S.fileIconWrap, { backgroundColor: "#F9FAFB" }]}>
                <Ionicons name="link-outline" size={18} color={GREY} />
              </View>
              <Text style={[S.fileName, { flex: 1 }]} numberOfLines={1}>{l.label || l.url}</Text>
              <Ionicons name="open-outline" size={16} color={GREY} />
            </TouchableOpacity>
          ))}

          {/* New files queued */}
          {pickedFiles.map((f, i) => (
            <View key={i} style={[S.fileCard, { borderStyle: "dashed" }]}>
              <View style={[S.fileIconWrap, { backgroundColor: PRIMARY_LIGHT }]}>
                <Ionicons name={fileIcon(f.mimeType)} size={18} color={PRIMARY} />
              </View>
              <View style={S.fileInfo}>
                <Text style={S.fileName} numberOfLines={1}>{f.name}</Text>
                {f.size > 0 && <Text style={S.fileSize}>{formatBytes(f.size)}</Text>}
              </View>
              <TouchableOpacity onPress={() => setPickedFiles((p) => p.filter((_, j) => j !== i))}>
                <Ionicons name="close-circle" size={20} color={RED} />
              </TouchableOpacity>
            </View>
          ))}

          {links.map((l, i) => (
            <View key={i} style={[S.fileCard, { borderStyle: "dashed" }]}>
              <View style={[S.fileIconWrap, { backgroundColor: "#D1FAE5" }]}>
                <Ionicons name="link-outline" size={18} color={GREEN} />
              </View>
              <Text style={[S.fileName, { flex: 1 }]} numberOfLines={1}>{l.url}</Text>
              <TouchableOpacity onPress={() => setLinks((p) => p.filter((_, j) => j !== i))}>
                <Ionicons name="close-circle" size={20} color={RED} />
              </TouchableOpacity>
            </View>
          ))}

          {/* Add attachment buttons — only show when not blocked */}
          {!blocked && (
            <View style={S.addRow}>
              <TouchableOpacity style={S.addBtn} onPress={pickFiles}>
                <Ionicons name="attach" size={16} color={PRIMARY} />
                <Text style={S.addBtnText}>Add file</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={S.addBtn}
                onPress={() => {
                  Alert.prompt(
                    "Add Link",
                    "Paste a URL",
                    (text) => {
                      if (!text) return;
                      const trimmed = text.trim();
                      if (!trimmed.startsWith("http")) {
                        Alert.alert("Invalid", "URL must start with http:// or https://");
                        return;
                      }
                      setLinks((p) => [...p, { url: trimmed, label: trimmed }]);
                    },
                    "plain-text",
                    "",
                    "url"
                  );
                }}
              >
                <Ionicons name="link-outline" size={16} color={PRIMARY} />
                <Text style={S.addBtnText}>Add link</Text>
              </TouchableOpacity>
            </View>
          )}

          {blocked && (
            <View style={S.blockedRow}>
              <Ionicons name="lock-closed-outline" size={14} color={GREY} />
              <Text style={S.blockedText}>Late submissions not allowed</Text>
            </View>
          )}
        </View>

        {/* Submit / Unsubmit buttons */}
        {!blocked && (
          <View style={S.actionRow}>
            {isSubmitted && (
              <TouchableOpacity
                style={[S.unsubmitBtn, unsubmitting && { opacity: 0.6 }]}
                onPress={handleUnsubmit}
                disabled={unsubmitting}
              >
                {unsubmitting
                  ? <ActivityIndicator size="small" color={GREY} />
                  : <Text style={S.unsubmitText}>Unsubmit</Text>
                }
              </TouchableOpacity>
            )}
            {(pickedFiles.length > 0 || links.length > 0 || isSubmitted) && (
              <TouchableOpacity
                style={[S.submitBtn, (submitting || uploadingFiles) && { opacity: 0.6 }]}
                onPress={handleSubmit}
                disabled={submitting || uploadingFiles}
              >
                {submitting || uploadingFiles
                  ? <ActivityIndicator color="#FFF" />
                  : <Text style={S.submitText}>
                      {isSubmitted ? "Resubmit" : "Turn In"}
                    </Text>
                }
              </TouchableOpacity>
            )}
            {!isSubmitted && pickedFiles.length === 0 && links.length === 0 && (
              <Text style={S.addHint}>Add a file or link to turn in</Text>
            )}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 16, paddingTop: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", marginBottom: 12, elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },

  headerCard: { backgroundColor: "#FFF", borderRadius: 16, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB" },
  assignTitle: { fontSize: 20, fontWeight: "800", color: "#111827", lineHeight: 28, marginBottom: 10 },
  headerMeta: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  metaChip: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: "#F3F4F6" },
  metaChipText: { fontSize: 12, fontWeight: "600", color: GREY },

  gradeCard: { backgroundColor: GREEN_LIGHT, borderRadius: 14, padding: 14, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: GREEN },
  gradeLabel: { fontSize: 11, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 },
  gradeScore: { fontSize: 32, fontWeight: "900", color: GREEN },
  gradeOf: { fontSize: 18, fontWeight: "600" },
  gradeFeedback: { fontSize: 13, color: "#065F46", marginTop: 6, lineHeight: 19 },

  section: { backgroundColor: "#FFF", borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "#E5E7EB" },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 },
  sectionText: { fontSize: 14, color: "#374151", lineHeight: 22 },

  fileCard: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#F9FAFB", borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: "#E5E7EB" },
  fileIconWrap: { width: 36, height: 36, borderRadius: 9, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  fileInfo: { flex: 1 },
  fileName: { fontSize: 13, fontWeight: "600", color: "#111827" },
  fileSize: { fontSize: 11, color: GREY, marginTop: 1 },

  yourWorkCard: { backgroundColor: "#FFF", borderRadius: 16, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB" },
  yourWorkHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  yourWorkTitle: { fontSize: 15, fontWeight: "700", color: "#111827" },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  statusBadgeText: { fontSize: 11, fontWeight: "700" },

  warnBox: { backgroundColor: AMBER_LIGHT, borderRadius: 8, padding: 10, marginBottom: 10 },
  warnText: { fontSize: 12, color: "#92400E", fontWeight: "600" },

  addRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  addBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderWidth: 1.5, borderColor: PRIMARY, borderRadius: 10, paddingVertical: 10, borderStyle: "dashed" },
  addBtnText: { color: PRIMARY, fontWeight: "700", fontSize: 13 },

  blockedRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 4 },
  blockedText: { fontSize: 13, color: GREY },

  actionRow: { flexDirection: "row", gap: 10, alignItems: "center", marginBottom: 8 },
  unsubmitBtn: { flex: 1, height: 48, borderRadius: 13, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: "#E5E7EB", backgroundColor: "#FFF" },
  unsubmitText: { fontSize: 14, fontWeight: "700", color: GREY },
  submitBtn: { flex: 2, height: 48, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: PRIMARY, shadowColor: PRIMARY, shadowOpacity: 0.25, shadowRadius: 8, elevation: 3 },
  submitText: { color: "#FFF", fontWeight: "800", fontSize: 15 },
  addHint: { flex: 1, fontSize: 13, color: GREY, textAlign: "center" },
});