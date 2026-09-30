import React, { useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { getUserSession } from "../services/session";

const PRIMARY = "#4834D4";
const DANGER = "#e74c3c";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

interface Teacher {
  id: string;
  name: string;
  department: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  lecture: {
    id: string;
    start_time: string;
    end_time: string;
    day: string;
  } | null;
  selectedDate: string;
  onSuccess?: () => void;
}

export default function AssignLectureModal({
  visible,
  onClose,
  lecture,
  selectedDate,
  onSuccess,
}: Props) {

  const [teachers, setTeachers]               = useState<Teacher[]>([]);
  const [selectedTeacher, setSelectedTeacher] = useState<Teacher | null>(null);
  const [dropdownOpen, setDropdownOpen]       = useState(false);
  const [reason, setReason]                   = useState("");
  const [loading, setLoading]                 = useState(false);
  const [sending, setSending]                 = useState(false);
  const [error, setError]                     = useState("");

  useEffect(() => {
    if (visible && lecture && selectedDate) fetchAvailableTeachers();
  }, [visible]);

  const fetchAvailableTeachers = async () => {
    try {
      setLoading(true);
      setError("");
      setSelectedTeacher(null);
      setDropdownOpen(false);
      setReason("");
      const session = await getUserSession();
      const res = await fetch(
        `${API_URL}/api/lectures/teachers/available?uid=${session.uid}&date=${selectedDate}&start_time=${lecture!.start_time}&end_time=${lecture!.end_time}`
      );
      const data = await res.json();
      if (data.success) setTeachers(data.available || []);
      else setError("Failed to load teachers.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    if (!selectedTeacher) { setError("Please select a teacher."); return; }
    try {
      setSending(true);
      setError("");
      const session = await getUserSession();
      const res = await fetch(`${API_URL}/api/lectures/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uid: session.uid,
          lecture_id: lecture!.id,
          assigned_teacher_id: selectedTeacher.id,
          date: selectedDate,
          start_time: lecture!.start_time,
          end_time: lecture!.end_time,
          reason: reason.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) { onSuccess?.(); handleClose(); }
      else setError(data.error || "Failed to send request.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    setSelectedTeacher(null);
    setDropdownOpen(false);
    setReason("");
    setError("");
    setTeachers([]);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      {/* Backdrop fills entire screen including status bar + nav bar */}
      <Pressable style={styles.backdrop} onPress={handleClose}>

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.centeredWrapper}
        >
          {/* Levitating card — tap doesn't close */}
          <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>

            <Text style={styles.title}>Assign Lecture</Text>
            {lecture && (
              <Text style={styles.subtitle}>
                {lecture.start_time} – {lecture.end_time} · {lecture.day}
              </Text>
            )}

            {loading && (
              <View style={styles.centerBox}>
                <ActivityIndicator size="large" color={PRIMARY} />
                <Text style={styles.loadingText}>Finding available teachers…</Text>
              </View>
            )}

            {!loading && (
              <>
                <Text style={styles.label}>Select Teacher</Text>

                {teachers.length === 0 ? (
                  <View style={styles.emptyBox}>
                    <Text style={styles.emptyText}>No teachers available for this slot</Text>
                  </View>
                ) : (
                  <View style={styles.dropdownWrapper}>
                    <TouchableOpacity
                      style={[styles.dropdownTrigger, dropdownOpen && styles.dropdownTriggerOpen]}
                      onPress={() => setDropdownOpen((p) => !p)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.dropdownTriggerText, !selectedTeacher && styles.placeholderText]}>
                        {selectedTeacher ? selectedTeacher.name : "Choose a teacher"}
                      </Text>
                      <Text style={styles.chevron}>{dropdownOpen ? "▲" : "▼"}</Text>
                    </TouchableOpacity>

                    {dropdownOpen && (
                      <View style={styles.dropdownList}>
                        <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{ maxHeight: 180 }}>
                          {teachers.map((teacher) => (
                            <TouchableOpacity
                              key={teacher.id}
                              style={[styles.dropdownItem, selectedTeacher?.id === teacher.id && styles.dropdownItemSelected]}
                              onPress={() => { setSelectedTeacher(teacher); setDropdownOpen(false); setError(""); }}
                              activeOpacity={0.7}
                            >
                              <View>
                                <Text style={[styles.teacherName, selectedTeacher?.id === teacher.id && styles.teacherNameSelected]}>
                                  {teacher.name}
                                </Text>
                                {teacher.department ? <Text style={styles.teacherDept}>{teacher.department}</Text> : null}
                              </View>
                              {selectedTeacher?.id === teacher.id && <Text style={styles.checkmark}>✓</Text>}
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                      </View>
                    )}
                  </View>
                )}

                <Text style={[styles.label, { marginTop: 20 }]}>Reason (optional)</Text>
                <TextInput
                  style={styles.reasonInput}
                  placeholder="e.g. Medical appointment, emergency leave…"
                  placeholderTextColor="#aaa"
                  value={reason}
                  onChangeText={setReason}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  maxLength={200}
                />
                <Text style={styles.charCount}>{reason.length}/200</Text>

                {error ? <Text style={styles.errorText}>{error}</Text> : null}

                <View style={styles.btnRow}>
                  <TouchableOpacity style={styles.cancelBtn} onPress={handleClose} activeOpacity={0.8}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.sendBtn, (!selectedTeacher || sending) && styles.sendBtnDisabled]}
                    onPress={handleSend}
                    disabled={!selectedTeacher || sending}
                    activeOpacity={0.8}
                  >
                    {sending
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Text style={styles.sendBtnText}>Send Request</Text>
                    }
                  </TouchableOpacity>
                </View>
              </>
            )}

          </Pressable>
        </KeyboardAvoidingView>

      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({

  /* Fills entire screen including behind status bar + nav bar */
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
  },

  centeredWrapper: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: 24,
  },

  /* Levitating card */
  card: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 24,
    elevation: 16,
  },

  title: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 4,
  },

  subtitle: {
    fontSize: 13,
    color: "#6B7280",
    marginBottom: 24,
  },

  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 8,
  },

  centerBox: {
    alignItems: "center",
    paddingVertical: 40,
    gap: 12,
  },

  loadingText: {
    fontSize: 14,
    color: "#6B7280",
    marginTop: 8,
  },

  emptyBox: {
    backgroundColor: "#FEF3F2",
    borderRadius: 10,
    padding: 16,
    alignItems: "center",
  },

  emptyText: {
    color: "#B91C1C",
    fontSize: 13,
    fontWeight: "500",
  },

  dropdownWrapper: {
    position: "relative",
    zIndex: 10,
  },

  dropdownTrigger: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#E5E7EB",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: "#FAFAFA",
  },

  dropdownTriggerOpen: {
    borderColor: PRIMARY,
    backgroundColor: "#fff",
  },

  dropdownTriggerText: {
    fontSize: 15,
    color: "#111827",
    fontWeight: "500",
    flex: 1,
  },

  placeholderText: {
    color: "#9CA3AF",
    fontWeight: "400",
  },

  chevron: {
    fontSize: 11,
    color: "#6B7280",
    marginLeft: 8,
  },

  dropdownList: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    backgroundColor: "#fff",
    borderWidth: 1.5,
    borderColor: PRIMARY,
    borderTopWidth: 0,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 6,
    zIndex: 20,
    overflow: "hidden",
  },

  dropdownItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },

  dropdownItemSelected: { backgroundColor: "#EEF2FF" },

  teacherName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#111827",
  },

  teacherNameSelected: { color: PRIMARY },

  teacherDept: {
    fontSize: 12,
    color: "#9CA3AF",
    marginTop: 2,
  },

  checkmark: {
    fontSize: 16,
    color: PRIMARY,
    fontWeight: "700",
  },

  reasonInput: {
    borderWidth: 1.5,
    borderColor: "#E5E7EB",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: "#111827",
    backgroundColor: "#FAFAFA",
    minHeight: 80,
  },

  charCount: {
    fontSize: 11,
    color: "#9CA3AF",
    textAlign: "right",
    marginTop: 4,
  },

  errorText: {
    color: DANGER,
    fontSize: 13,
    marginTop: 10,
    fontWeight: "500",
  },

  btnRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 24,
  },

  cancelBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: "#E5E7EB",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },

  cancelBtnText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#374151",
  },

  sendBtn: {
    flex: 2,
    backgroundColor: PRIMARY,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },

  sendBtnDisabled: { backgroundColor: "#A5B4FC" },

  sendBtnText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },

});