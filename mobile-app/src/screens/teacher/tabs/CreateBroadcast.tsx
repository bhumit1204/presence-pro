// src/screens/teacher/CreateBroadcast.tsx
// Send an broadcast to a class, a saved group, or hand-picked students.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";
import {
  Avatar, Banner, Button, Card, Checkbox, Chip, EmptyState, Header, Screen, SectionLabel, Segmented, SelectField, Sheet, TextField, ToggleRow, T, R, SP, font,
} from "../../../components/ui";
import { enc, getJson, postJson } from "../teacherShared";

type Target = "class" | "group" | "individual";
type AttFilter = "none" | "below_75" | "below_50";

interface Subject { subject_id: string; subject_name: string; course_id: string; course_name: string }
interface Group { id: string; group_id: string; name: string; member_uids: string[] }
interface Student { uid: string; name: string; roll_no: string; course_name: string }

const ATT: { value: AttFilter; label: string }[] = [
  { value: "none", label: "Everyone" },
  { value: "below_75", label: "Below 75%" },
  { value: "below_50", label: "Below 50%" },
];

const putJson = (path: string, body: any) => getJson(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export default function CreateBroadcast() {
  const navigation = useNavigation<any>();
  const [teacherId, setTeacherId] = useState("");
  const [boot, setBoot] = useState<"loading" | "ready" | "error">("loading");
  const [bootError, setBootError] = useState("");

  const [target, setTarget] = useState<Target>("class");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [att, setAtt] = useState<AttFilter>("none");
  const [sending, setSending] = useState(false);
  const [tried, setTried] = useState(false);

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subjectId, setSubjectId] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState("");
  const [students, setStudents] = useState<Student[]>([]);
  const [picked, setPicked] = useState<string[]>([]);

  const [studentSheet, setStudentSheet] = useState(false);
  const [groupSheet, setGroupSheet] = useState(false);
  const [membersFor, setMembersFor] = useState<Group | null>(null);
  const [search, setSearch] = useState("");
  const [groupName, setGroupName] = useState("");
  const [renaming, setRenaming] = useState<Group | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);

  const load = useCallback(async () => {
    setBoot("loading");
    try {
      const s = await getUserSession();
      if (!s?.teacher_id) throw new Error("Your teacher profile was not found. Log in again.");
      setTeacherId(s.teacher_id);
      const q = `teacher_id=${enc(s.teacher_id)}`;
      const [sub, grp, stu] = await Promise.all([
        getJson(`/api/broadcasts/subjects?${q}`),
        getJson(`/api/broadcasts/groups?${q}`),
        getJson(`/api/broadcasts/students?${q}`),
      ]);
      setSubjects(sub.subjects || []);
      setGroups(grp.groups || []);
      setStudents(stu.students || []);
      setBoot("ready");
    } catch (e: any) {
      setBootError(e?.message || "Could not load.");
      setBoot("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const subject = subjects.find((s) => s.subject_id === subjectId);
  const group = groups.find((g) => g.id === groupId);
  const dirty = !!(title.trim() || text.trim());

  /* leave guard: only when something is typed and nothing was just sent */
  const [sent, setSent] = useState(false);
  useEffect(() => {
    return navigation.addListener("beforeRemove", (e: any) => {
      if (!dirty || sent || sending) return;
      e.preventDefault();
      Alert.alert("Discard this broadcast?", undefined, [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
      ]);
    });
  }, [navigation, dirty, sent, sending]);

  const errs = {
    title: !title.trim() ? "Add a title" : null,
    text: !text.trim() ? "Write your message" : null,
    target:
      target === "class" && !subject ? "Choose a subject"
      : target === "group" && !group ? "Choose a group"
      : target === "individual" && picked.length === 0 ? "Pick at least one student"
      : null,
  };
  const valid = !errs.title && !errs.text && !errs.target;

  const doSend = async () => {
    setSending(true);
    try {
      const body: any = { teacher_id: teacherId, title: title.trim(), text: text.trim(), target_type: target, is_urgent: urgent };
      if (target === "class") {
        body.subject_id = subject!.subject_id;
        if (subject!.course_id) body.course_id = subject!.course_id;
        body.attendance_filter = att;
      }
      if (target === "group") body.group_id = group!.id;
      if (target === "individual") body.recipient_uids = picked;
      const j = await postJson("/api/broadcasts", body);
      setSent(true);
      Alert.alert("Sent", `Delivered to ${j.recipient_count ?? 0} student${j.recipient_count === 1 ? "" : "s"}.`, [{ text: "Done", onPress: () => navigation.goBack() }]);
    } catch (e: any) {
      Alert.alert("Could not send", e?.message || "Please try again.");
    } finally {
      setSending(false);
    }
  };

  const send = () => {
    setTried(true);
    if (!valid) return;
    if (urgent) {
      Alert.alert("Send as urgent?", undefined, [
        { text: "Cancel", style: "cancel" },
        { text: "Send", onPress: doSend },
      ]);
    } else doSend();
  };

  /* groups */
  const saveGroup = async () => {
    const name = groupName.trim();
    if (!name) return Alert.alert("Name needed");
    setGroupBusy(true);
    try {
      if (renaming) {
        await putJson(`/api/broadcasts/groups/${enc(renaming.id)}`, { teacher_id: teacherId, name });
        setGroups((p) => p.map((g) => (g.id === renaming.id ? { ...g, name } : g)));
      } else {
        const j = await postJson("/api/broadcasts/groups", { teacher_id: teacherId, name, member_uids: [] });
        const g: Group = { id: j.group_id, group_id: j.group_id, name, member_uids: [] };
        setGroups((p) => [g, ...p]);
        setMembersFor(g);
      }
      setGroupName("");
      setRenaming(null);
    } catch (e: any) {
      Alert.alert("Could not save", e?.message || "Please try again.");
    } finally {
      setGroupBusy(false);
    }
  };

  const removeGroup = (g: Group) =>
    Alert.alert("Delete group?", `"${g.name}"`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await getJson(`/api/broadcasts/groups/${enc(g.id)}?teacher_id=${enc(teacherId)}`, { method: "DELETE" });
            setGroups((p) => p.filter((x) => x.id !== g.id));
            if (groupId === g.id) setGroupId("");
          } catch (e: any) {
            Alert.alert("Could not delete", e?.message || "Please try again.");
          }
        },
      },
    ]);

  const toggleMember = async (g: Group, uid: string) => {
    const has = g.member_uids.includes(uid);
    const next = has ? g.member_uids.filter((u) => u !== uid) : [...g.member_uids, uid];
    const apply = (list: string[]) => {
      setGroups((p) => p.map((x) => (x.id === g.id ? { ...x, member_uids: list } : x)));
      setMembersFor((m) => (m && m.id === g.id ? { ...m, member_uids: list } : m));
    };
    apply(next); // optimistic
    try {
      await putJson(`/api/broadcasts/groups/${enc(g.id)}`, { teacher_id: teacherId, member_uids: next });
    } catch (e: any) {
      apply(g.member_uids);
      Alert.alert("Could not update", e?.message || "Please try again.");
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? students.filter((s) => s.name.toLowerCase().includes(q) || (s.roll_no || "").toLowerCase().includes(q)) : students;
  }, [students, search]);

  const StudentRow = ({ s, on, onPress }: { s: Student; on: boolean; onPress: () => void }) => (
    <Pressable onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={{ flexDirection: "row", alignItems: "center", gap: SP.md, paddingVertical: 10 }}>
      <Avatar name={s.name} size={36} tone={on ? "primary" : "neutral"} />
      <View style={{ flex: 1 }}>
        <Text style={font.h3} numberOfLines={1}>{s.name}</Text>
        <Text style={font.small} numberOfLines={1}>{[s.roll_no, s.course_name].filter(Boolean).join("  |  ")}</Text>
      </View>
      <Checkbox checked={on} onPress={onPress} />
    </Pressable>
  );

  if (boot !== "ready") {
    return (
      <Screen>
        <Header title="New broadcast" onBack={() => navigation.goBack()} />
        {boot === "loading" ? (
          <ActivityIndicator color={T.primary} style={{ marginTop: 60 }} />
        ) : (
          <View style={{ padding: SP.lg, gap: SP.md }}>
            <Banner tone="danger">{bootError}</Banner>
            <Button label="Try again" icon="refresh" variant="secondary" onPress={load} />
          </View>
        )}
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="New broadcast" onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: 30, gap: SP.lg }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View>
            <SectionLabel>Send to</SectionLabel>
            <Segmented<Target>
              value={target}
              onChange={setTarget}
              options={[
                { value: "class", label: "Class", icon: "school-outline" },
                { value: "group", label: "Group", icon: "people-outline" },
                { value: "individual", label: "Students", icon: "person-outline" },
              ]}
            />
          </View>

          {target === "class" && (
            <View style={{ gap: SP.md }}>
              <SelectField
                label="Subject"
                icon="book-outline"
                value={subjectId}
                onChange={setSubjectId}
                placeholder="Choose a subject"
                title="Choose a subject"
                options={subjects.map((s) => ({ value: s.subject_id, label: s.subject_name, sub: s.course_name }))}
                error={tried ? errs.target : null}
              />
              <View>
                <SectionLabel>Attendance</SectionLabel>
                <Segmented<AttFilter> value={att} onChange={setAtt} options={ATT} />
              </View>
            </View>
          )}

          {target === "group" && (
            <View style={{ gap: SP.sm }}>
              <SelectField
                label="Group"
                icon="people-outline"
                value={groupId}
                onChange={setGroupId}
                placeholder={groups.length ? "Choose a group" : "No groups yet"}
                title="Choose a group"
                options={groups.map((g) => ({ value: g.id, label: g.name, sub: `${g.member_uids.length} students` }))}
                error={tried ? errs.target : null}
              />
              <Button label="Manage groups" icon="settings-outline" variant="ghost" size="md" onPress={() => setGroupSheet(true)} style={{ alignSelf: "flex-start" }} />
            </View>
          )}

          {target === "individual" && (
            <View style={{ gap: SP.sm }}>
              {picked.length > 0 && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {picked.map((uid) => {
                    const s = students.find((x) => x.uid === uid);
                    return (
                      <Pressable key={uid} onPress={() => setPicked((p) => p.filter((x) => x !== uid))} accessibilityLabel={`Remove ${s?.name}`}>
                        <Chip label={`${s?.name || "Student"}  x`} tone="primary" />
                      </Pressable>
                    );
                  })}
                </View>
              )}
              <Button label={picked.length ? "Change students" : "Choose students"} icon="person-add-outline" variant="secondary" onPress={() => setStudentSheet(true)} />
              {tried && !!errs.target && <Text style={{ color: T.danger, fontSize: 12.5 }}>{errs.target}</Text>}
            </View>
          )}

          <TextField label="Title" value={title} onChangeText={setTitle} placeholder="Title" maxLength={80} autoCapitalize="sentences" error={tried ? errs.title : null} />
          <TextField label="Message" value={text} onChangeText={setText} placeholder="Write your message" multiline minHeight={120} autoCapitalize="sentences" error={tried ? errs.text : null} />
          <Card>
            <ToggleRow title="Urgent" value={urgent} onChange={setUrgent} />
          </Card>
        </ScrollView>

        <View style={{ padding: SP.lg, borderTopWidth: 1, borderTopColor: T.line, backgroundColor: T.surface }}>
          <Button label="Send broadcast" icon="paper-plane" onPress={send} loading={sending} />
        </View>
      </KeyboardAvoidingView>

      {/* pick students */}
      <Sheet
        visible={studentSheet}
        onClose={() => { setStudentSheet(false); setSearch(""); }}
        title="Choose students"
        subtitle={`${picked.length} selected`}
        footer={<Button label="Done" onPress={() => { setStudentSheet(false); setSearch(""); }} style={{ marginTop: SP.md }} />}
      >
        <TextField value={search} onChangeText={setSearch} placeholder="Search name or roll number" icon="search" />
        {filtered.length === 0 && <EmptyState icon="people-outline" title="No students" />}
        {filtered.map((s) => (
          <StudentRow key={s.uid} s={s} on={picked.includes(s.uid)} onPress={() => setPicked((p) => (p.includes(s.uid) ? p.filter((x) => x !== s.uid) : [...p, s.uid]))} />
        ))}
      </Sheet>

      {/* manage groups */}
      <Sheet visible={groupSheet && !membersFor} onClose={() => { setGroupSheet(false); setRenaming(null); setGroupName(""); }} title="Groups">
        <View style={{ flexDirection: "row", gap: SP.sm, alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            <TextField value={groupName} onChangeText={setGroupName} placeholder={renaming ? "New name" : "Group name"} autoCapitalize="words" maxLength={40} />
          </View>
          <Button label={renaming ? "Save" : "Add"} size="md" onPress={saveGroup} loading={groupBusy} style={{ marginTop: 2 }} />
        </View>
        {groups.length === 0 ? (
          <EmptyState icon="people-outline" title="No groups yet" />
        ) : (
          <View style={{ marginTop: SP.md, paddingBottom: SP.md }}>
            {groups.map((g) => (
              <View key={g.id} style={{ flexDirection: "row", alignItems: "center", gap: SP.sm, paddingVertical: 8 }}>
                <Pressable style={{ flex: 1 }} onPress={() => setMembersFor(g)} accessibilityRole="button">
                  <Text style={font.h3}>{g.name}</Text>
                  <Text style={font.small}>{g.member_uids.length} students</Text>
                </Pressable>
                <Pressable onPress={() => { setRenaming(g); setGroupName(g.name); }} hitSlop={8} accessibilityLabel={`Rename ${g.name}`}>
                  <Ionicons name="pencil" size={18} color={T.sub} />
                </Pressable>
                <Pressable onPress={() => removeGroup(g)} hitSlop={8} accessibilityLabel={`Delete ${g.name}`}>
                  <Ionicons name="trash-outline" size={18} color={T.danger} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </Sheet>

      {/* group members */}
      <Sheet
        visible={!!membersFor}
        onClose={() => { setMembersFor(null); setSearch(""); }}
        title={membersFor ? `Members of ${membersFor.name}` : ""}
        subtitle={membersFor ? `${membersFor.member_uids.length} selected` : undefined}
        footer={<Button label="Done" onPress={() => { setMembersFor(null); setSearch(""); }} style={{ marginTop: SP.md }} />}
      >
        <TextField value={search} onChangeText={setSearch} placeholder="Search name or roll number" icon="search" />
        {membersFor &&
          filtered.map((s) => <StudentRow key={s.uid} s={s} on={membersFor.member_uids.includes(s.uid)} onPress={() => toggleMember(membersFor, s.uid)} />)}
      </Sheet>
    </Screen>
  );
}