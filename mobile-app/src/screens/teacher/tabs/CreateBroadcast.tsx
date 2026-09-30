import React, { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, ActivityIndicator,
  FlatList, Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { getUserSession } from "../../../services/session";

// ─── Design tokens — matches TeacherProfile / TeacherWork ─────────
const PRIMARY      = "#4834D4";
const PRIMARY_SOFT = "#EEF2FF";
const BG           = "#F3F4F6";
const GREY         = "#6B7280";
const GREEN        = "#10B981";
const AMBER        = "#F59E0B";
const RED          = "#EF4444";
const WHITE        = "#FFFFFF";
const DARK         = "#111827";
const API_URL      = "http://10.132.90.56:5000";

type TargetType = "class" | "group" | "individual";
type AttFilter  = "none" | "below_75" | "below_50";

interface Subject { subject_id: string; subject_name: string; course_id: string; course_name: string; }
interface Group   { id: string; group_id: string; name: string; member_uids: string[]; }
interface Student { uid: string; name: string; roll_no: string; course_name: string; }

// Attendance filter only used for class broadcasts
const ATT_OPTIONS: { key: AttFilter; label: string; desc: string; color: string }[] = [
  { key: "none",     label: "All Students", desc: "Send to everyone enrolled in this subject", color: PRIMARY },
  { key: "below_75", label: "Below 75%",    desc: "Only students with attendance < 75%",        color: AMBER  },
  { key: "below_50", label: "Below 50%",    desc: "Only students with attendance < 50%",        color: RED    },
];

// ─────────────────────────────────────────────────────────────────
export default function CreateBroadcast() {
  const navigation = useNavigation<any>();

  const [teacherId, setTeacherId] = useState("");

  // form fields
  const [title,      setTitle]      = useState("");
  const [text,       setText]       = useState("");
  const [targetType, setTargetType] = useState<TargetType>("class");
  const [isUrgent,   setIsUrgent]   = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [attFilter,  setAttFilter]  = useState<AttFilter>("none");

  // class mode
  const [subjects,        setSubjects]        = useState<Subject[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<Subject | null>(null);
  const [subDropOpen,     setSubDropOpen]     = useState(false);
  const [subjectsLoading, setSubjectsLoading] = useState(false);

  // group mode
  const [groups,        setGroups]        = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [groupDropOpen, setGroupDropOpen] = useState(false);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupModal,    setGroupModal]    = useState(false);
  const [editingGroup,  setEditingGroup]  = useState<Group | null>(null);
  const [newGroupName,  setNewGroupName]  = useState("");

  // individual mode
  const [allStudents,      setAllStudents]      = useState<Student[]>([]);
  const [selectedStudents, setSelectedStudents] = useState<Student[]>([]);
  const [studentModal,     setStudentModal]     = useState(false);
  const [search,           setSearch]           = useState("");
  const [studentsLoading,  setStudentsLoading]  = useState(false);

  // ── init ──────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const session = await getUserSession();
      if (!session?.teacher_id) return;
      setTeacherId(session.teacher_id);
      fetchSubjects(session.teacher_id);
      fetchGroups(session.teacher_id);
      fetchStudents(session.teacher_id);
    })();
  }, []);

  // ── safe fetch helper — prevents "Unexpected character: <" crashes ──
  const fetchJSON = async (url: string): Promise<any> => {
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok || text.trim().startsWith("<")) {
      // Server returned HTML (404/500 page) instead of JSON
      console.error(`[fetchJSON] Non-JSON response from ${url} (status ${res.status}):\n${text.slice(0, 300)}`);
      throw new Error(`Server error ${res.status} — check API_URL and route mounting`);
    }
    return JSON.parse(text);
  };

  // ── fetchers ─────────────────────────────────────────────────
  const fetchSubjects = async (tid: string) => {
    setSubjectsLoading(true);
    try {
      const data = await fetchJSON(`${API_URL}/api/broadcasts/subjects?teacher_id=${tid}`);
      if (data.success) setSubjects(data.subjects || []);
      else console.log("SUBJECTS error:", data.error);
    } catch (e) { console.log("SUBJECTS:", e); }
    finally { setSubjectsLoading(false); }
  };

  const fetchGroups = async (tid: string) => {
    setGroupsLoading(true);
    try {
      const data = await fetchJSON(`${API_URL}/api/broadcasts/groups?teacher_id=${tid}`);
      if (data.success) setGroups(data.groups || []);
      else console.log("GROUPS error:", data.error);
    } catch (e) { console.log("GROUPS:", e); }
    finally { setGroupsLoading(false); }
  };

  const fetchStudents = async (tid: string) => {
    setStudentsLoading(true);
    try {
      const data = await fetchJSON(`${API_URL}/api/broadcasts/students?teacher_id=${tid}`);
      if (data.success) setAllStudents(data.students || []);
      else console.log("STUDENTS error:", data.error);
    } catch (e) { console.log("STUDENTS:", e); }
    finally { setStudentsLoading(false); }
  };

  // ── group CRUD ───────────────────────────────────────────────
  const saveGroup = async () => {
    if (!newGroupName.trim()) { Alert.alert("Enter a group name"); return; }
    try {
      if (editingGroup) {
        await fetch(`${API_URL}/api/broadcasts/groups/${editingGroup.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teacher_id: teacherId, name: newGroupName.trim() }),
        });
        setGroups((prev) =>
          prev.map((g) => g.id === editingGroup.id ? { ...g, name: newGroupName.trim() } : g)
        );
        if (selectedGroup?.id === editingGroup.id)
          setSelectedGroup((g) => g ? { ...g, name: newGroupName.trim() } : g);
      } else {
        const res  = await fetch(`${API_URL}/api/broadcasts/groups`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teacher_id: teacherId, name: newGroupName.trim(), member_uids: [] }),
        });
        const data = await res.json();
        if (data.success) {
          const ng: Group = {
            id: data.group_id, group_id: data.group_id,
            name: newGroupName.trim(), member_uids: [],
          };
          setGroups((prev) => [ng, ...prev]);
        }
      }
      setGroupModal(false);
      setNewGroupName("");
      setEditingGroup(null);
    } catch { Alert.alert("Error", "Could not save group"); }
  };

  const deleteGroup = (group: Group) => {
    Alert.alert("Delete Group", `Delete "${group.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          try {
            await fetch(
              `${API_URL}/api/broadcasts/groups/${group.id}?teacher_id=${teacherId}`,
              { method: "DELETE" }
            );
            setGroups((prev) => prev.filter((g) => g.id !== group.id));
            if (selectedGroup?.id === group.id) setSelectedGroup(null);
          } catch { Alert.alert("Error", "Could not delete group"); }
        },
      },
    ]);
  };

  const toggleGroupMember = async (student: Student, group: Group) => {
    const isMember = group.member_uids.includes(student.uid);
    const updated  = isMember
      ? group.member_uids.filter((u) => u !== student.uid)
      : [...group.member_uids, student.uid];
    try {
      await fetch(`${API_URL}/api/broadcasts/groups/${group.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacher_id: teacherId, member_uids: updated }),
      });
      setGroups((prev) =>
        prev.map((g) => g.id === group.id ? { ...g, member_uids: updated } : g)
      );
      if (selectedGroup?.id === group.id)
        setSelectedGroup((g) => g ? { ...g, member_uids: updated } : g);
      if (editingGroup?.id  === group.id)
        setEditingGroup  ((g) => g ? { ...g, member_uids: updated } : g);
    } catch { Alert.alert("Error", "Could not update members"); }
  };

  // ── individual ────────────────────────────────────────────────
  const toggleStudent = (s: Student) =>
    setSelectedStudents((prev) =>
      prev.find((x) => x.uid === s.uid)
        ? prev.filter((x) => x.uid !== s.uid)
        : [...prev, s]
    );

  // ── submit ────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!title.trim()) { Alert.alert("Required", "Please enter a title."); return; }
    if (!text.trim())  { Alert.alert("Required", "Please enter a message."); return; }
    if (targetType === "class"      && !selectedSubject)
      { Alert.alert("Required", "Select a subject."); return; }
    if (targetType === "group"      && !selectedGroup)
      { Alert.alert("Required", "Select a group."); return; }
    if (targetType === "individual" && selectedStudents.length === 0)
      { Alert.alert("Required", "Select at least one student."); return; }

    setLoading(true);
    try {
      const body: any = {
        teacher_id:  teacherId,
        title:       title.trim(),
        text:        text.trim(),
        target_type: targetType,
        is_urgent:   isUrgent,
      };

      if (targetType === "class") {
        body.subject_id        = selectedSubject!.subject_id;
        // course_id may be empty string if subjects collection doesn't carry it;
        // the backend resolves it from the subject doc automatically.
        if (selectedSubject!.course_id) body.course_id = selectedSubject!.course_id;
        body.attendance_filter = attFilter;          // only class uses att filter
      }
      if (targetType === "group") {
        body.group_id = selectedGroup!.id;
        // No attendance_filter for groups — all members receive it
      }
      if (targetType === "individual") {
        body.recipient_uids = selectedStudents.map((s) => s.uid);
      }

      const res  = await fetch(`${API_URL}/api/broadcasts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      Alert.alert(
        "Sent! 🎉",
        `Broadcast delivered to ${data.recipient_count} student(s).`,
        [{ text: "OK", onPress: () => navigation.goBack() }]
      );
    } catch (e: any) {
      Alert.alert("Error", e.message || "Failed to send broadcast");
    } finally {
      setLoading(false);
    }
  };

  const filteredStudents = allStudents.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    (s.roll_no || "").toLowerCase().includes(search.toLowerCase())
  );

  // ═══════════════════════════════════════════════════════════════
  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={S.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* ── HEADER ──────────────────────────────────────────── */}
        <View style={S.header}>
          <Text style={S.title}>New Broadcast</Text>
          <Text style={S.subtitle}>Send an announcement to your students</Text>
        </View>

        {/* ── TARGET TABS ─────────────────────────────────────── */}
        <View style={S.tabRow}>
          {(["class", "group", "individual"] as TargetType[]).map((t) => {
            const active = targetType === t;
            const icons:  Record<TargetType, any>    = { class: "school-outline", group: "people-outline", individual: "person-outline" };
            const labels: Record<TargetType, string> = { class: "Class", group: "Group", individual: "Individual" };
            return (
              <TouchableOpacity
                key={t}
                style={[S.tab, active && S.tabActive]}
                onPress={() => {
                  setTargetType(t);
                  setSelectedSubject(null);
                  setSelectedGroup(null);
                  setSelectedStudents([]);
                  setAttFilter("none");
                }}
              >
                <Ionicons name={icons[t]} size={15} color={active ? WHITE : GREY} />
                <Text style={[S.tabText, active && S.tabTextActive]}>{labels[t]}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── TITLE + MESSAGE ─────────────────────────────────── */}
        <View style={S.card}>
          <Text style={S.fieldLabel}>Title *</Text>
          <TextInput
            style={S.input}
            placeholder="e.g. Attendance Warning · Exam Notice"
            placeholderTextColor="#9CA3AF"
            value={title}
            onChangeText={setTitle}
          />

          <Text style={[S.fieldLabel, { marginTop: 14 }]}>Message *</Text>
          <TextInput
            style={[S.input, S.textarea]}
            placeholder="Write your announcement here…"
            placeholderTextColor="#9CA3AF"
            value={text}
            onChangeText={setText}
            multiline
            textAlignVertical="top"
          />
        </View>

        {/* ═══════════ CLASS ════════════════════════════════════ */}
        {targetType === "class" && (
          <View style={S.card}>
            <View style={S.sectionHead}>
              <View style={S.sectionDot} />
              <Text style={S.sectionTitle}>Class Targeting</Text>
            </View>

            <Text style={S.fieldLabel}>Subject *</Text>
            <TouchableOpacity style={S.dropdown} onPress={() => setSubDropOpen(!subDropOpen)}>
              <Text style={[S.dropdownVal, !selectedSubject && { color: "#9CA3AF" }]}>
                {selectedSubject ? selectedSubject.subject_name : "Select a subject…"}
              </Text>
              <Ionicons name={subDropOpen ? "chevron-up" : "chevron-down"} size={18} color={GREY} />
            </TouchableOpacity>

            {subDropOpen && (
              <View style={S.dropList}>
                {subjectsLoading
                  ? <ActivityIndicator color={PRIMARY} style={{ padding: 12 }} />
                  : subjects.length === 0
                  ? <Text style={S.emptyDrop}>No subjects found</Text>
                  : subjects.map((sub) => (
                    <TouchableOpacity
                      key={sub.subject_id}
                      style={[S.dropItem, selectedSubject?.subject_id === sub.subject_id && S.dropItemActive]}
                      onPress={() => { setSelectedSubject(sub); setSubDropOpen(false); }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[S.dropItemText, selectedSubject?.subject_id === sub.subject_id && { color: PRIMARY, fontWeight: "800" }]}>
                          {sub.subject_name}
                        </Text>
                        <Text style={S.dropItemSub}>{sub.course_name}</Text>
                      </View>
                      {selectedSubject?.subject_id === sub.subject_id && (
                        <Ionicons name="checkmark-circle" size={18} color={PRIMARY} />
                      )}
                    </TouchableOpacity>
                  ))
                }
              </View>
            )}

            {/* Attendance filter — CLASS only */}
            <AttFilterSection value={attFilter} onChange={setAttFilter} />
          </View>
        )}

        {/* ═══════════ GROUP ════════════════════════════════════ */}
        {targetType === "group" && (
          <View style={S.card}>
            <View style={S.rowBetween}>
              <View style={S.sectionHead}>
                <View style={S.sectionDot} />
                <Text style={S.sectionTitle}>Groups</Text>
              </View>
              <TouchableOpacity
                style={S.actionLink}
                onPress={() => { setEditingGroup(null); setNewGroupName(""); setGroupModal(true); }}
              >
                <Ionicons name="add-circle-outline" size={16} color={PRIMARY} />
                <Text style={S.actionLinkText}>New Group</Text>
              </TouchableOpacity>
            </View>

            <Text style={S.fieldLabel}>Select Group *</Text>
            <TouchableOpacity style={S.dropdown} onPress={() => setGroupDropOpen(!groupDropOpen)}>
              <Text style={[S.dropdownVal, !selectedGroup && { color: "#9CA3AF" }]}>
                {selectedGroup
                  ? `${selectedGroup.name}  (${selectedGroup.member_uids.length} members)`
                  : "Choose a group…"}
              </Text>
              <Ionicons name={groupDropOpen ? "chevron-up" : "chevron-down"} size={18} color={GREY} />
            </TouchableOpacity>

            {groupDropOpen && (
              <View style={S.dropList}>
                {groupsLoading
                  ? <ActivityIndicator color={PRIMARY} style={{ padding: 12 }} />
                  : groups.length === 0
                  ? <Text style={S.emptyDrop}>No groups yet. Create one above.</Text>
                  : groups.map((g) => (
                    <View key={g.id} style={S.groupRow}>
                      <TouchableOpacity
                        style={[S.groupRowMain, selectedGroup?.id === g.id && { backgroundColor: PRIMARY_SOFT }]}
                        onPress={() => { setSelectedGroup(g); setGroupDropOpen(false); }}
                      >
                        <View style={S.groupAvatar}>
                          <Text style={S.groupAvatarText}>{g.name.charAt(0).toUpperCase()}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={S.groupName}>{g.name}</Text>
                          <Text style={S.groupMeta}>{g.member_uids.length} members</Text>
                        </View>
                        {selectedGroup?.id === g.id && (
                          <Ionicons name="checkmark-circle" size={18} color={PRIMARY} />
                        )}
                      </TouchableOpacity>
                      <View style={S.groupActions}>
                        <TouchableOpacity
                          style={S.groupActionBtn}
                          onPress={() => { setEditingGroup(g); setNewGroupName(g.name); setGroupModal(true); }}
                        >
                          <Ionicons name="pencil-outline" size={15} color={GREY} />
                        </TouchableOpacity>
                        <TouchableOpacity style={S.groupActionBtn} onPress={() => deleteGroup(g)}>
                          <Ionicons name="trash-outline" size={15} color={RED} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))
                }
              </View>
            )}

            {/* Note: broadcasts reach ALL group members — no attendance filter */}
            {selectedGroup && (
              <View style={S.groupNote}>
                <Ionicons name="information-circle-outline" size={14} color={GREY} />
                <Text style={S.groupNoteText}>
                  All {selectedGroup.member_uids.length} group members will receive this broadcast.
                </Text>
              </View>
            )}
          </View>
        )}

        {/* ═══════════ INDIVIDUAL ═══════════════════════════════ */}
        {targetType === "individual" && (
          <View style={S.card}>
            <View style={S.rowBetween}>
              <View style={S.sectionHead}>
                <View style={S.sectionDot} />
                <Text style={S.sectionTitle}>Recipients</Text>
              </View>
              <TouchableOpacity style={S.actionLink} onPress={() => setStudentModal(true)}>
                <Ionicons name="person-add-outline" size={16} color={PRIMARY} />
                <Text style={S.actionLinkText}>Add Students</Text>
              </TouchableOpacity>
            </View>

            {selectedStudents.length === 0 ? (
              <TouchableOpacity style={S.emptyPicker} onPress={() => setStudentModal(true)}>
                <Ionicons name="people-outline" size={28} color={GREY} />
                <Text style={S.emptyPickerText}>Tap to select students</Text>
              </TouchableOpacity>
            ) : (
              <View style={S.chipRow}>
                {selectedStudents.map((s) => (
                  <TouchableOpacity key={s.uid} style={S.chip} onPress={() => toggleStudent(s)}>
                    <Text style={S.chipText}>{s.name}</Text>
                    <Ionicons name="close-circle" size={14} color={PRIMARY} />
                  </TouchableOpacity>
                ))}
                <TouchableOpacity style={S.chipAdd} onPress={() => setStudentModal(true)}>
                  <Ionicons name="add" size={14} color={GREY} />
                  <Text style={S.chipAddText}>Add more</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* ── URGENCY TOGGLE (replaces Pin) ───────────────────── */}
        <View style={S.card}>
          <View style={S.toggleRow}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ionicons name="alert-circle-outline" size={16} color={RED} />
                <Text style={S.fieldLabel}>Mark as Urgent</Text>
              </View>
              <Text style={S.toggleSub}>
                Urgent broadcasts appear highlighted in the student's inbox
              </Text>
            </View>
            <TouchableOpacity
              style={[S.toggle, isUrgent && S.toggleUrgent]}
              onPress={() => setIsUrgent(!isUrgent)}
            >
              <View style={[S.knob, isUrgent && S.knobOn]} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── SEND BUTTON ─────────────────────────────────────── */}
        <TouchableOpacity
          style={[S.sendBtn, loading && { opacity: 0.7 }]}
          onPress={handleSend}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color={WHITE} />
            : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="send" size={18} color={WHITE} />
                <Text style={S.sendText}>Send Broadcast</Text>
              </View>
            )
          }
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ═══════════ GROUP MODAL ════════════════════════════════ */}
      <Modal visible={groupModal} animationType="slide" transparent>
        <View style={S.overlay}>
          <View style={S.sheet}>
            <View style={S.sheetHandle} />
            <Text style={S.sheetTitle}>{editingGroup ? "Edit Group" : "New Group"}</Text>

            <Text style={S.fieldLabel}>Group Name *</Text>
            <TextInput
              style={S.input}
              placeholder="e.g. Weak Students · Section A"
              value={newGroupName}
              onChangeText={setNewGroupName}
            />

            {editingGroup && (
              <>
                <Text style={[S.fieldLabel, { marginTop: 14 }]}>
                  Members  ({editingGroup.member_uids.length} selected)
                </Text>
                <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator={false}>
                  {studentsLoading
                    ? <ActivityIndicator color={PRIMARY} style={{ padding: 16 }} />
                    : allStudents.length === 0
                    ? <Text style={S.emptyDrop}>No students found. Ensure you have lectures assigned.</Text>
                    : allStudents.map((s) => {
                      const isMember = editingGroup.member_uids.includes(s.uid);
                      return (
                        <TouchableOpacity
                          key={s.uid}
                          style={[S.studentRow, isMember && S.studentRowSelected]}
                          onPress={() => toggleGroupMember(s, editingGroup)}
                        >
                          <View style={[S.checkbox, isMember && S.checkboxSelected]}>
                            {isMember && <Ionicons name="checkmark" size={12} color={WHITE} />}
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={S.studentName}>{s.name}</Text>
                            <Text style={S.studentMeta}>{s.roll_no}  ·  {s.course_name}</Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })
                  }
                </ScrollView>
              </>
            )}

            <View style={S.modalBtns}>
              <TouchableOpacity
                style={S.modalCancel}
                onPress={() => { setGroupModal(false); setEditingGroup(null); setNewGroupName(""); }}
              >
                <Text style={S.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={S.modalSave} onPress={saveGroup}>
                <Text style={S.modalSaveText}>{editingGroup ? "Save" : "Create"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ═══════════ STUDENT PICKER MODAL ══════════════════════ */}
      <Modal visible={studentModal} animationType="slide" transparent>
        <View style={S.overlay}>
          <View style={[S.sheet, { maxHeight: "85%" }]}>
            <View style={S.sheetHandle} />
            <Text style={S.sheetTitle}>Select Students</Text>
            <Text style={S.sheetSub}>{selectedStudents.length} selected</Text>

            <View style={S.searchBar}>
              <Ionicons name="search-outline" size={16} color={GREY} />
              <TextInput
                style={S.searchInput}
                placeholder="Search by name or roll no…"
                value={search}
                onChangeText={setSearch}
              />
            </View>

            <FlatList
              data={filteredStudents}
              keyExtractor={(item) => item.uid}
              style={{ maxHeight: 360 }}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                studentsLoading
                  ? <ActivityIndicator color={PRIMARY} style={{ padding: 16 }} />
                  : <Text style={S.emptyDrop}>No students found</Text>
              }
              renderItem={({ item }) => {
                const sel = !!selectedStudents.find((s) => s.uid === item.uid);
                return (
                  <TouchableOpacity
                    style={[S.studentRow, sel && S.studentRowSelected]}
                    onPress={() => toggleStudent(item)}
                  >
                    <View style={[S.checkbox, sel && S.checkboxSelected]}>
                      {sel && <Ionicons name="checkmark" size={12} color={WHITE} />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={S.studentName}>{item.name}</Text>
                      <Text style={S.studentMeta}>{item.roll_no}  ·  {item.course_name}</Text>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />

            <TouchableOpacity style={S.modalSave} onPress={() => setStudentModal(false)}>
              <Text style={S.modalSaveText}>Done ({selectedStudents.length} selected)</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Attendance Filter — class broadcasts only ────────────────────
function AttFilterSection({ value, onChange }: { value: AttFilter; onChange: (v: AttFilter) => void }) {
  return (
    <>
      <Text style={[S.fieldLabel, { marginTop: 16 }]}>Attendance Filter</Text>
      <Text style={S.pinHint}>Optionally restrict to low-attendance students</Text>
      <View style={{ gap: 8, marginTop: 4 }}>
        {ATT_OPTIONS.map((opt) => {
          const active = value === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[S.attChip, active && { backgroundColor: opt.color, borderColor: opt.color }]}
              onPress={() => onChange(opt.key)}
            >
              <View style={{ flex: 1 }}>
                <Text style={[S.attChipLabel, active && { color: "#FFF" }]}>{opt.label}</Text>
                <Text style={[S.attChipDesc,  active && { color: "rgba(255,255,255,0.8)" }]}>{opt.desc}</Text>
              </View>
              {active && <Ionicons name="checkmark-circle" size={18} color="#FFF" />}
            </TouchableOpacity>
          );
        })}
      </View>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────
const S = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: BG },
  scroll: { paddingHorizontal: 20, paddingBottom: 20 },

  header:   { paddingTop: 16, marginBottom: 20 },
  title:    { fontSize: 28, fontWeight: "800", color: DARK },
  subtitle: { fontSize: 14, color: GREY, marginTop: 4 },

  tabRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  tab: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 5, paddingVertical: 10, borderRadius: 14,
    backgroundColor: WHITE, borderWidth: 1.5, borderColor: "#E5E7EB",
  },
  tabActive:     { backgroundColor: PRIMARY, borderColor: PRIMARY },
  tabText:       { fontSize: 12, fontWeight: "700", color: GREY },
  tabTextActive: { color: WHITE },

  card: {
    backgroundColor: WHITE, borderRadius: 20, padding: 18,
    marginBottom: 14, borderWidth: 1, borderColor: "#E5E7EB",
    shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, elevation: 2,
  },

  sectionHead:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 },
  sectionDot:   { width: 4, height: 18, borderRadius: 2, backgroundColor: PRIMARY },
  sectionTitle: { fontSize: 14, fontWeight: "800", color: DARK, letterSpacing: 0.2 },

  fieldLabel: { fontSize: 13, fontWeight: "700", color: DARK, marginBottom: 6 },

  input: {
    borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, color: DARK, backgroundColor: "#F9FAFB",
  },
  textarea: { minHeight: 110, textAlignVertical: "top" },

  dropdown: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 13, backgroundColor: "#F9FAFB",
  },
  dropdownVal: { fontSize: 14, fontWeight: "600", color: DARK, flex: 1 },

  dropList: {
    borderWidth: 1, borderColor: "#E5E7EB", borderRadius: 12,
    marginTop: 6, overflow: "hidden", backgroundColor: WHITE,
  },
  dropItem: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: "#F3F4F6",
  },
  dropItemActive:  { backgroundColor: PRIMARY_SOFT },
  dropItemText:    { fontSize: 14, fontWeight: "600", color: DARK },
  dropItemSub:     { fontSize: 12, color: GREY, marginTop: 2 },
  emptyDrop:       { textAlign: "center", color: GREY, padding: 16, fontSize: 13 },

  groupRow:        { borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  groupRowMain:    { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, flex: 1 },
  groupAvatar:     { width: 36, height: 36, borderRadius: 18, backgroundColor: PRIMARY_SOFT, alignItems: "center", justifyContent: "center" },
  groupAvatarText: { fontSize: 15, fontWeight: "800", color: PRIMARY },
  groupName:       { fontSize: 14, fontWeight: "700", color: DARK },
  groupMeta:       { fontSize: 12, color: GREY, marginTop: 1 },
  groupActions:    { flexDirection: "row", paddingRight: 12, gap: 4 },
  groupActionBtn:  { padding: 8 },

  groupNote: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#F9FAFB", borderRadius: 10, padding: 10, marginTop: 12,
  },
  groupNoteText: { fontSize: 12, color: GREY, flex: 1 },

  rowBetween:    { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  actionLink:    { flexDirection: "row", alignItems: "center", gap: 4 },
  actionLinkText:{ fontSize: 13, fontWeight: "700", color: PRIMARY },

  attChip: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  attChipLabel: { fontSize: 13, fontWeight: "700", color: DARK },
  attChipDesc:  { fontSize: 12, color: GREY, marginTop: 2 },

  // Urgency toggle (replaces pin)
  toggleRow:   { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
  toggleSub:   { fontSize: 12, color: GREY, marginTop: 4, lineHeight: 16 },
  toggle:      { width: 50, height: 28, borderRadius: 20, backgroundColor: "#D1D5DB", justifyContent: "center", marginTop: 4 },
  toggleUrgent:{ backgroundColor: RED },
  knob:        { width: 22, height: 22, borderRadius: 11, backgroundColor: WHITE, marginLeft: 3 },
  knobOn:      { marginLeft: 25 },

  pinHint: { fontSize: 12, color: GREY, marginBottom: 8 },

  emptyPicker: {
    height: 76, borderRadius: 12, borderWidth: 1.5, borderStyle: "dashed",
    borderColor: "#D1D5DB", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 6,
  },
  emptyPickerText: { fontSize: 13, color: GREY, fontWeight: "600" },
  chipRow:   { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip:      { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: PRIMARY_SOFT, borderRadius: 20, borderWidth: 1, borderColor: "#C7D2FE", paddingHorizontal: 10, paddingVertical: 6 },
  chipText:  { fontSize: 12, fontWeight: "700", color: PRIMARY },
  chipAdd:   { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#F3F4F6", borderRadius: 20, borderWidth: 1, borderColor: "#D1D5DB", paddingHorizontal: 10, paddingVertical: 6 },
  chipAddText: { fontSize: 12, fontWeight: "600", color: GREY },

  sendBtn: {
    backgroundColor: PRIMARY, borderRadius: 16, height: 54,
    alignItems: "center", justifyContent: "center",
    shadowColor: PRIMARY, shadowOpacity: 0.3, shadowRadius: 10, elevation: 4,
  },
  sendText: { color: WHITE, fontWeight: "800", fontSize: 16 },

  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: WHITE, borderTopLeftRadius: 28, borderTopRightRadius: 28,
    padding: 24, paddingBottom: 36,
  },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: "#D1D5DB", alignSelf: "center", marginBottom: 20 },
  sheetTitle:  { fontSize: 20, fontWeight: "800", color: DARK, marginBottom: 4 },
  sheetSub:    { fontSize: 13, color: GREY, marginBottom: 14 },

  searchBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#F3F4F6", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: "#E5E7EB", marginBottom: 12,
  },
  searchInput: { flex: 1, fontSize: 14, color: DARK },

  studentRow:         { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  studentRowSelected: { backgroundColor: PRIMARY_SOFT, borderRadius: 10, paddingHorizontal: 8 },
  studentName:        { fontSize: 14, fontWeight: "700", color: DARK },
  studentMeta:        { fontSize: 12, color: GREY, marginTop: 1 },

  checkbox:         { width: 22, height: 22, borderRadius: 7, borderWidth: 2, borderColor: "#D1D5DB", alignItems: "center", justifyContent: "center" },
  checkboxSelected: { backgroundColor: PRIMARY, borderColor: PRIMARY },

  modalBtns:       { flexDirection: "row", gap: 10, marginTop: 20 },
  modalCancel:     { flex: 1, borderWidth: 1.5, borderColor: "#E5E7EB", borderRadius: 14, height: 48, alignItems: "center", justifyContent: "center" },
  modalCancelText: { fontSize: 15, fontWeight: "700", color: GREY },
  modalSave:       { flex: 1, backgroundColor: PRIMARY, borderRadius: 14, height: 48, alignItems: "center", justifyContent: "center" },
  modalSaveText:   { fontSize: 15, fontWeight: "800", color: WHITE },
});