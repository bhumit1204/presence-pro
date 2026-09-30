/**
 * SemesterSubjectsManager.tsx
 *
 * HOD-only screen. Receives { course_id, course_name, semester } from HODManage
 * so no course/semester picker is shown — jumps straight to the subjects list.
 *
 * Also contains "Assign Teacher" per subject inline (replaces separate TeacherAssignment screen).
 * Routes: /api/manage/subjects/* and /api/manage/teacher-assignments/*
 */

import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  TextInput,
  Alert,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";
const GREY = "#6B7280";
const GREEN = "#10B981";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

interface SubjectOption { option_name: string; student_ids: string[] }
interface Subject {
  subject_id: string;
  subject_name: string;
  subject_code: string;
  credits: number;
  is_compulsory: boolean;
  compulsary?: boolean;
  elective_slot?: string;
  options?: SubjectOption[];
  assigned_teacher?: string;
}
interface Teacher {
  teacher_id: string;
  name: string;
  designation: string;
  role: string;
}

export default function SemesterSubjectsManager() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { course_id, course_name, semester, role: userRole } = route.params || {};

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);
  const [assignModalVisible, setAssignModalVisible] = useState(false);
  const [availableTeachers, setAvailableTeachers] = useState<Teacher[]>([]);
  const [assigningSubject, setAssigningSubject] = useState<Subject | null>(null);
  const [assignments, setAssignments] = useState<Record<string, string>>({}); // subject_id -> teacher name

  // Form state
  const [isCompulsory, setIsCompulsory] = useState(true);
  const [subjectName, setSubjectName] = useState("");
  const [subjectCode, setSubjectCode] = useState("");
  const [credits, setCredits] = useState("4");
  const [electiveSlot, setElectiveSlot] = useState("Elective 1");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [editSubject, setEditSubject] = useState<Subject | null>(null);

  const fetchSubjects = async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `${API_URL}/api/manage/subjects?course_id=${course_id}&semester=${semester}`
      );
      const data = await res.json();
      if (data.success) setSubjects(data.subjects || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const fetchAssignments = async () => {
    try {
      const res = await fetch(
        `${API_URL}/api/manage/teacher-assignments?course_id=${course_id}&semester=${semester}`
      );
      const data = await res.json();
      if (data.success) {
        const map: Record<string, string> = {};
        for (const a of data.assignments) {
          map[a.subject_id] = a.teacher_id;
        }
        setAssignments(map);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchTeachers = async () => {
    try {
      const session = await getUserSession();
      const res = await fetch(
        `${API_URL}/api/manage/available-teachers?teacher_id=${session.teacher_id}`
      );
      const data = await res.json();
      if (data.success) setAvailableTeachers(data.teachers || []);
    } catch {}
  };

  useEffect(() => {
    fetchSubjects();
    fetchAssignments();
  }, []);

  const handleSave = async () => {
    if (!subjectName.trim()) {
      Alert.alert("Error", "Subject name is required."); return;
    }
    try {
      const session = await getUserSession();
      const body: any = {
        course_id,
        semester,
        subject_name: subjectName.trim(),
        subject_code: subjectCode.trim(),
        credits: parseInt(credits) || 4,
        is_compulsory: isCompulsory,
        teacher_id: session.teacher_id,
      };
      if (editSubject) body.subject_id = editSubject.subject_id;
      if (!isCompulsory) {
        body.elective_slot = electiveSlot;
        body.options = options
          .filter((o) => o.trim())
          .map((o) => ({ option_name: o.trim(), student_ids: [] }));
      }
      const url = editSubject
        ? `${API_URL}/api/manage/subjects/update`
        : `${API_URL}/api/manage/subjects/add`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setModalVisible(false);
        fetchSubjects();
      } else {
        Alert.alert("Error", data.error || "Failed to save.");
      }
    } catch {
      Alert.alert("Error", "Network error.");
    }
  };

  const handleDelete = async (subject_id: string) => {
    Alert.alert("Delete Subject?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive", onPress: async () => {
          await fetch(`${API_URL}/api/manage/subjects/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subject_id }),
          });
          fetchSubjects();
        },
      },
    ]);
  };

  const openAssign = (subject: Subject) => {
    setAssigningSubject(subject);
    fetchTeachers();
    setAssignModalVisible(true);
  };

  const handleAssign = async (targetTeacherId: string) => {
    if (!assigningSubject) return;
    try {
      const session = await getUserSession();
      const res = await fetch(`${API_URL}/api/manage/teacher-assignments/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject_id: assigningSubject.subject_id,
          teacher_id: targetTeacherId,
          course_id,
          semester,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setAssignments((prev) => ({ ...prev, [assigningSubject.subject_id]: targetTeacherId }));
        setAssignModalVisible(false);
      } else {
        Alert.alert("Error", data.error);
      }
    } catch {
      Alert.alert("Error", "Network error.");
    }
  };

  const openAdd = () => {
    setEditSubject(null);
    setIsCompulsory(true);
    setSubjectName(""); setSubjectCode(""); setCredits("4");
    setElectiveSlot("Elective 1"); setOptions(["", ""]);
    setModalVisible(true);
  };

  const openEdit = (s: Subject) => {
    setEditSubject(s);
    setIsCompulsory(s.is_compulsory ?? s.compulsary ?? true);
    setSubjectName(s.subject_name);
    setSubjectCode(s.subject_code || "");
    setCredits(String(s.credits || 4));
    if (!s.is_compulsory) {
      setElectiveSlot(s.elective_slot || "Elective 1");
      setOptions((s.options || []).map((o) => o.option_name));
    }
    setModalVisible(true);
  };

  const compulsory = subjects.filter((s) => s.is_compulsory || s.compulsary);
  const electives = subjects.filter((s) => !(s.is_compulsory || s.compulsary));

  const assignedTeacherName = (subject_id: string) => {
    const tid = assignments[subject_id];
    if (!tid) return null;
    const t = availableTeachers.find((t) => t.teacher_id === tid);
    return t?.name || tid;
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#111" />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Subjects</Text>
          <Text style={styles.subtitle}>{course_name} · Sem {semester}</Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={openAdd}>
          <Ionicons name="add" size={22} color="#FFF" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={PRIMARY} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {/* Compulsory */}
          <Text style={styles.sectionLabel}>Compulsory</Text>
          {compulsory.length === 0 && (
            <Text style={styles.emptyText}>No compulsory subjects yet. Add one!</Text>
          )}
          {compulsory.map((s) => (
            <SubjectCard
              key={s.subject_id}
              subject={s}
              color={PRIMARY}
              assignedName={assignments[s.subject_id] ? (availableTeachers.find(t => t.teacher_id === assignments[s.subject_id])?.name || assignments[s.subject_id]) : null}
              onEdit={() => openEdit(s)}
              onDelete={() => handleDelete(s.subject_id)}
              onAssign={() => openAssign(s)}
              userRole={userRole}
            />
          ))}

          {/* Elective */}
          {electives.length > 0 && (
            <>
              <Text style={[styles.sectionLabel, { marginTop: 16 }]}>Electives</Text>
              {electives.map((s) => (
                <SubjectCard
                  key={s.subject_id}
                  subject={s}
                  color={GREEN}
                  assignedName={assignments[s.subject_id] ? (availableTeachers.find(t => t.teacher_id === assignments[s.subject_id])?.name || assignments[s.subject_id]) : null}
                  onEdit={() => openEdit(s)}
                  onDelete={() => handleDelete(s.subject_id)}
                  onAssign={() => openAssign(s)}
                  userRole={userRole}
                />
              ))}
            </>
          )}
          <View style={{ height: 80 }} />
        </ScrollView>
      )}

      {/* ── Add/Edit Subject Modal ────────────────────────────────────────── */}
      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <ScrollView style={{ width: "100%" }}>
            <View style={styles.modalSheet}>
              <Text style={styles.modalTitle}>{editSubject ? "Edit Subject" : "Add Subject"}</Text>

              <View style={styles.typeRow}>
                {[true, false].map((comp) => (
                  <TouchableOpacity
                    key={String(comp)}
                    style={[styles.typeBtn, isCompulsory === comp && styles.typeBtnActive]}
                    onPress={() => setIsCompulsory(comp)}
                  >
                    <Text style={[styles.typeBtnText, isCompulsory === comp && styles.typeBtnTextActive]}>
                      {comp ? "Compulsory" : "Elective"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {!isCompulsory && (
                <>
                  <Text style={styles.fieldLabel}>Elective Slot</Text>
                  <TextInput style={styles.input} value={electiveSlot} onChangeText={setElectiveSlot} placeholder="e.g. Elective 1" />
                </>
              )}

              <Text style={styles.fieldLabel}>Subject Name *</Text>
              <TextInput style={styles.input} value={subjectName} onChangeText={setSubjectName} placeholder="e.g. Data Structures" />

              <Text style={styles.fieldLabel}>Subject Code</Text>
              <TextInput style={styles.input} value={subjectCode} onChangeText={setSubjectCode} placeholder="e.g. CS301" />

              <Text style={styles.fieldLabel}>Credits</Text>
              <TextInput style={styles.input} value={credits} onChangeText={setCredits} keyboardType="numeric" placeholder="4" />

              {!isCompulsory && (
                <>
                  <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Options (students choose one)</Text>
                  {options.map((opt, i) => (
                    <View key={i} style={{ flexDirection: "row", gap: 8, marginBottom: 8, alignItems: "center" }}>
                      <TextInput
                        style={[styles.input, { flex: 1 }]}
                        value={opt}
                        onChangeText={(v) => { const u = [...options]; u[i] = v; setOptions(u); }}
                        placeholder={`Option ${i + 1}`}
                      />
                      {options.length > 2 && (
                        <TouchableOpacity onPress={() => setOptions(options.filter((_, j) => j !== i))}>
                          <Ionicons name="remove-circle" size={22} color="#EF4444" />
                        </TouchableOpacity>
                      )}
                    </View>
                  ))}
                  <TouchableOpacity style={styles.addOptBtn} onPress={() => setOptions([...options, ""])}>
                    <Ionicons name="add" size={16} color={GREEN} />
                    <Text style={{ color: GREEN, fontWeight: "600", fontSize: 13 }}>Add option</Text>
                  </TouchableOpacity>
                </>
              )}

              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setModalVisible(false)}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
                  <Text style={styles.saveBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* ── Assign Teacher Modal ──────────────────────────────────────────── */}
      <Modal visible={assignModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { maxHeight: "60%" }]}>
            <Text style={styles.modalTitle}>Assign Teacher</Text>
            <Text style={{ color: GREY, fontSize: 13, marginBottom: 12 }}>
              {assigningSubject?.subject_name}
            </Text>
            <ScrollView>
              {availableTeachers.length === 0 ? (
                <ActivityIndicator color={PRIMARY} />
              ) : (
                availableTeachers.map((t) => (
                  <TouchableOpacity
                    key={t.teacher_id}
                    style={styles.teacherRow}
                    onPress={() => handleAssign(t.teacher_id)}
                  >
                    <View style={styles.teacherAvatar}>
                      <Text style={styles.teacherAvatarText}>{t.name.charAt(0)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.teacherName}>{t.name}</Text>
                      <Text style={styles.teacherDesig}>{t.designation}</Text>
                    </View>
                    {assigningSubject && assignments[assigningSubject.subject_id] === t.teacher_id && (
                      <Ionicons name="checkmark-circle" size={20} color={GREEN} />
                    )}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <TouchableOpacity style={[styles.cancelBtn, { marginTop: 12 }]} onPress={() => setAssignModalVisible(false)}>
              <Text style={styles.cancelBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── SubjectCard component ────────────────────────────────────────────────────
function SubjectCard({
  subject, color, assignedName, onEdit, onDelete, onAssign, userRole,
}: {
  subject: Subject;
  color: string;
  assignedName: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onAssign: () => void;
  userRole: string;
}) {
  const isCompulsory = subject.is_compulsory || subject.compulsary;
  return (
    <View style={styles.subjectCard}>
      <View style={[styles.subjectStrip, { backgroundColor: color }]} />
      <View style={styles.subjectBody}>
        <View style={styles.rowBetween}>
          <Text style={styles.subjectName} numberOfLines={2}>{subject.subject_name}</Text>
          <View style={[styles.creditsBadge, { backgroundColor: color + "18" }]}>
            <Text style={[styles.creditsText, { color }]}>{subject.credits} cr</Text>
          </View>
        </View>
        {subject.subject_code ? (
          <Text style={styles.subjectCode}>{subject.subject_code}</Text>
        ) : null}
        {!isCompulsory && subject.elective_slot && (
          <Text style={[styles.subjectCode, { color: "#8B5CF6" }]}>{subject.elective_slot}</Text>
        )}
        {/* Assigned teacher */}
        <View style={styles.assignRow}>
          <Ionicons name="person-outline" size={12} color={assignedName ? color : "#D1D5DB"} />
          <Text style={[styles.assignText, { color: assignedName ? "#374151" : "#D1D5DB" }]}>
            {assignedName || "No teacher assigned"}
          </Text>
          {userRole === "hod" && (
            <TouchableOpacity style={styles.assignBtn} onPress={onAssign}>
              <Text style={[styles.assignBtnText, { color }]}>Assign</Text>
            </TouchableOpacity>
          )}
        </View>
        {userRole === "hod" && (
          <View style={styles.subjectActions}>
            <TouchableOpacity style={styles.iconAction} onPress={onEdit}>
              <Ionicons name="create-outline" size={16} color={PRIMARY} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconAction} onPress={onDelete}>
              <Ionicons name="trash-outline" size={16} color="#EF4444" />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F3F4F6" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
    justifyContent: "space-between", backgroundColor: "#FFF",
    borderBottomWidth: 1, borderBottomColor: "#E5E7EB",
  },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: "800", color: "#111" },
  subtitle: { fontSize: 12, color: GREY, marginTop: 2 },
  addBtn: { backgroundColor: "#4834D4", width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  sectionLabel: { fontSize: 12, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 },
  emptyText: { color: "#aaa", fontSize: 13, marginBottom: 12 },
  subjectCard: { backgroundColor: "#FFF", borderRadius: 14, marginBottom: 10, flexDirection: "row", overflow: "hidden", elevation: 2, borderWidth: 1, borderColor: "#E5E7EB" },
  subjectStrip: { width: 4 },
  subjectBody: { flex: 1, padding: 12 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  subjectName: { fontSize: 15, fontWeight: "700", color: "#111", flex: 1, marginRight: 8 },
  creditsBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  creditsText: { fontSize: 11, fontWeight: "700" },
  subjectCode: { fontSize: 12, color: GREY, marginTop: 3 },
  assignRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8 },
  assignText: { fontSize: 12, flex: 1 },
  assignBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: "#F3F4F6" },
  assignBtnText: { fontSize: 11, fontWeight: "700" },
  subjectActions: { flexDirection: "row", gap: 8, marginTop: 8 },
  iconAction: { width: 32, height: 32, borderRadius: 8, backgroundColor: "#F3F4F6", alignItems: "center", justifyContent: "center" },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: "#FFF", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: Platform.OS === "ios" ? 40 : 24 },
  modalTitle: { fontSize: 18, fontWeight: "800", color: "#111", marginBottom: 14 },
  typeRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
  typeBtn: { flex: 1, paddingVertical: 10, borderRadius: 12, borderWidth: 1.5, borderColor: "#E5E7EB", alignItems: "center" },
  typeBtnActive: { backgroundColor: "#4834D4", borderColor: "#4834D4" },
  typeBtnText: { fontWeight: "700", color: GREY },
  typeBtnTextActive: { color: "#FFF" },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: GREY, marginBottom: 6, marginTop: 10 },
  input: { borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: "#111", backgroundColor: "#FAFAFA" },
  addOptBtn: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4, marginBottom: 8 },
  modalActions: { flexDirection: "row", gap: 12, marginTop: 20 },
  cancelBtn: { flex: 1, borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  cancelBtnText: { fontWeight: "600", color: GREY },
  saveBtn: { flex: 2, backgroundColor: "#4834D4", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  saveBtnText: { fontWeight: "700", color: "#FFF" },
  teacherRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  teacherAvatar: { width: 36, height: 36, borderRadius: 10, backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center" },
  teacherAvatarText: { fontSize: 16, fontWeight: "800", color: "#4834D4" },
  teacherName: { fontSize: 14, fontWeight: "700", color: "#111" },
  teacherDesig: { fontSize: 12, color: GREY },
});