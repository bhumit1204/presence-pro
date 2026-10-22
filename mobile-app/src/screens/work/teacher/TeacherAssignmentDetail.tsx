import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import * as DocumentPicker from "expo-document-picker";
import {
  Avatar, Banner, Button, Card, Chip, EmptyState, Header, R, SP, Screen, SectionLabel, Segmented, T, TextField, Tone, ToggleRow, font,
} from "../../../components/ui";
import { HeaderIconButton, StatRow } from "../../reports/teacher/ReportShared";
import {
  Attachment, AttachmentEditor, DateTimeField, KIND_ICON, KIND_SHORT, KIND_TONE, KindPicker, LinkItem, ResourceList, TagPicker, WorkKind, tagNameOf, useTags, api, fmtDateTime, fmtShort, isPastDue, jsonInit,
  kindOf, startOfToday, stateOf, uploadFiles,
} from "../WorkShared";

/* ───────────── types and helpers ───────────── */
interface Submission {
  submission_id: string;
  student_uid: string;
  student_name: string | null;
  student_roll: string | null;
  text_answer: string | null;
  attachments: Attachment[];
  links: LinkItem[];
  status: "submitted" | "graded" | "late";
  marks_obtained: number | null;
  feedback: string | null;
  submitted_at: string | null;
  returned?: boolean;
}
interface Row {
  uid: string;
  name: string;
  roll: string | null;
  submission: Submission | null;
}

const enc = encodeURIComponent;
const isReturned = (s: Submission) => s.returned === true;

function statusOf(sub: Submission | null): { label: string; tone: Tone } {
  if (!sub) return { label: "Not submitted", tone: "neutral" };
  if (sub.status === "graded") return isReturned(sub) ? { label: "Graded", tone: "success" } : { label: "Graded, hidden", tone: "warning" };
  if (sub.status === "late") return { label: "Late", tone: "warning" };
  return { label: "Submitted", tone: "primary" };
}

/** Returns an error text, or null when the marks are valid. */
function marksError(input: string, total: number): string | null {
  const t = input.trim();
  if (!t) return "Enter the marks.";
  const n = Number(t);
  if (!isFinite(n) || n < 0) return "Enter a valid number.";
  if (n > total) return `The maximum is ${total}.`;
  return null;
}

/** Run `fn` over `items` a few at a time. Returns how many succeeded and the items that failed. */
async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<{ ok: number; failed: T[] }> {
  let ok = 0;
  const failed: T[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const res = await Promise.allSettled(chunk.map(fn));
    res.forEach((r, j) => (r.status === "fulfilled" ? ok++ : failed.push(chunk[j])));
  }
  return { ok, failed };
}

function SheetFrame({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen>
        <Header
          title={title}
          right={
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={{ padding: SP.xs }}>
              <Ionicons name="close" size={24} color={T.sub} />
            </Pressable>
          }
        />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          {children}
        </KeyboardAvoidingView>
      </Screen>
    </Modal>
  );
}

/* ───────────── edit assignment ───────────── */
function EditSheet({ assignment, subject, teacher_id, onClose, onSaved }: { assignment: any; subject?: any; teacher_id: string; onClose: () => void; onSaved: () => void }) {
  const scheduled = stateOf(assignment) === "scheduled";
  const [kind, setKind] = useState<WorkKind>(kindOf(assignment));
  const [tagId, setTagId] = useState<string | null>(assignment.tag_id ?? null);
  const [publishAt, setPublishAt] = useState(new Date(assignment.publish_at || Date.now()));
  const [title, setTitle] = useState<string>(assignment.title || "");
  const [marks, setMarks] = useState(String(assignment.marks ?? ""));
  const [dueDate, setDueDate] = useState(new Date(assignment.due_date));
  const [instructions, setInstructions] = useState<string>(assignment.instructions || "");
  const [questions, setQuestions] = useState<string>(assignment.questions || "");
  const [allowLate, setAllowLate] = useState(!!assignment.allow_late);
  const [existing, setExisting] = useState<Attachment[]>(assignment.attachments || []);
  const [files, setFiles] = useState<DocumentPicker.DocumentPickerAsset[]>([]);
  const [links, setLinks] = useState<LinkItem[]>(assignment.links || []);
  const [errors, setErrors] = useState<{ title?: string; marks?: string; body?: string }>({});
  const [saving, setSaving] = useState(false);
  const [errPublish, setErrPublish] = useState<string | undefined>();

  const dirty =
    kind !== kindOf(assignment) || tagId !== (assignment.tag_id ?? null) || title !== (assignment.title || "") || marks !== String(assignment.marks ?? "") ||
    dueDate.getTime() !== new Date(assignment.due_date).getTime() || instructions !== (assignment.instructions || "") ||
    questions !== (assignment.questions || "") || allowLate !== !!assignment.allow_late || files.length > 0 ||
    existing.length !== (assignment.attachments || []).length || links.length !== (assignment.links || []).length ||
    (scheduled && publishAt.getTime() !== new Date(assignment.publish_at).getTime());
  const close = () => {
    if (!dirty || saving) return onClose();
    Alert.alert("Discard your changes?", "They have not been saved.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: onClose },
    ]);
  };

  const save = async () => {
    const e: typeof errors = {};
    const m = Number(marks);
    if (!title.trim()) e.title = "Enter a title.";
    if (!marks.trim() || !isFinite(m) || m < 1) e.marks = "Enter total marks of 1 or more.";
    else if (m > 1000) e.marks = "Total marks cannot be more than 1000.";
    if (!instructions.trim() && !questions.trim()) e.body = "Fill in the instructions, the questions, or both.";
    setErrors(e);
    let pe: string | undefined;
    if (scheduled) {
      if (publishAt.getTime() <= Date.now()) pe = "Choose a posting time in the future.";
    }
    setErrPublish(pe);
    if (Object.keys(e).length || pe) return;
    if (scheduled && dueDate.getTime() <= publishAt.getTime()) { Alert.alert("Check the dates", "The due date must be after the posting time."); return; }

    setSaving(true);
    try {
      const uploaded = await uploadFiles(files, "assignments", assignment.assignment_id);
      const originals: Attachment[] = assignment.attachments || [];
      const deleted = originals.filter((o) => !existing.some((x) => x.key === o.key)).map((o) => o.key).filter(Boolean);
      await api(
        `/api/assignments/${assignment.assignment_id}`,
        jsonInit("PUT", {
          teacher_id,
          kind,
          tag_id: tagId,
          ...(scheduled ? { publish_at: publishAt.toISOString() } : {}),
          title: title.trim(),
          instructions: instructions.trim() || null,
          questions: questions.trim() || null,
          marks: m,
          due_date: dueDate.toISOString(),
          allow_late: allowLate,
          attachments: [...existing, ...uploaded],
          links,
          deleted_keys: deleted,
        })
      );
      onSaved();
      onClose();
    } catch (err: any) {
      Alert.alert("Could not save", err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SheetFrame title="Edit assignment" onClose={close}>
      <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Card style={{ marginBottom: SP.md, gap: SP.lg }}>
          <KindPicker value={kind} onChange={setKind} subject={subject} disabled={saving} />
          <TagPicker subject_id={assignment.subject_id} course_id={assignment.course_id} teacher_id={teacher_id} value={tagId} onChange={setTagId} disabled={saving} />
          <TextField label="Title" value={title} onChangeText={setTitle} autoCapitalize="sentences" autoCorrect maxLength={300} error={errors.title} editable={!saving} />
          <TextField label="Total marks" value={marks} onChangeText={(t) => setMarks(t.replace(/[^0-9.]/g, ""))} keyboardType="decimal-pad" maxLength={6} error={errors.marks} editable={!saving} />
          {scheduled && <DateTimeField label="Posts at" value={publishAt} onChange={(d) => { setPublishAt(d); setErrPublish(undefined); }} minimumDate={startOfToday()} error={errPublish} />}
          <DateTimeField label="Due" value={dueDate} onChange={setDueDate} />
          <ToggleRow title="Allow late submissions" sub="Students can turn in after the due date" value={allowLate} onChange={setAllowLate} disabled={saving} />
        </Card>
        <Card style={{ marginBottom: SP.md, gap: SP.lg }}>
          <SectionLabel style={{ marginBottom: 0 }}>Content</SectionLabel>
          {!!errors.body && <Banner tone="danger">{errors.body}</Banner>}
          <TextField label="Instructions (optional)" value={instructions} onChangeText={setInstructions} multiline minHeight={100} autoCapitalize="sentences" autoCorrect maxLength={20000} editable={!saving} />
          <TextField label="Questions (optional)" value={questions} onChangeText={setQuestions} multiline minHeight={100} autoCapitalize="sentences" autoCorrect maxLength={50000} editable={!saving} />
        </Card>
        <Card style={{ marginBottom: SP.lg }}>
          <SectionLabel>Attachments</SectionLabel>
          <AttachmentEditor
            existing={existing}
            onRemoveExisting={(a) => setExisting((p) => p.filter((x) => x.key !== a.key))}
            files={files}
            onFiles={setFiles}
            links={links}
            onLinks={setLinks}
            disabled={saving}
          />
        </Card>
        <Button label="Save changes" icon="checkmark" onPress={save} loading={saving} />
      </ScrollView>
    </SheetFrame>
  );
}

/* ───────────── grade one submission ───────────── */
function GradeSheet({ row, totalMarks, teacher_id, onClose, onSaved }: { row: Row; totalMarks: number; teacher_id: string; onClose: () => void; onSaved: () => void }) {
  const sub = row.submission!;
  const [marks, setMarks] = useState(sub.marks_obtained != null ? String(sub.marks_obtained) : "");
  const [feedback, setFeedback] = useState(sub.feedback || "");
  const [returned, setReturned] = useState(isReturned(sub));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const err = touched ? marksError(marks, totalMarks) : null;
  const n = Number(marks);
  const pct = !marksError(marks, totalMarks) && totalMarks > 0 ? Math.round((n / totalMarks) * 100) : null;
  const pctTone: Tone = pct == null ? "neutral" : pct >= 75 ? "success" : pct >= 50 ? "warning" : "danger";

  const save = async () => {
    setTouched(true);
    if (marksError(marks, totalMarks)) return;
    setSaving(true);
    try {
      await api(
        `/api/assignments/grade/${sub.submission_id}`,
        jsonInit(sub.status === "graded" ? "PUT" : "POST", { teacher_id, marks_obtained: n, feedback: feedback.trim() || undefined, returned })
      );
      onSaved();
      onClose();
    } catch (e: any) {
      Alert.alert("Could not save the grade", e.message);
    } finally {
      setSaving(false);
    }
  };

  const st = statusOf(sub);
  return (
    <SheetFrame title={sub.status === "graded" ? "Edit grade" : "Grade submission"} onClose={onClose}>
      <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Card style={{ marginBottom: SP.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md }}>
            <Avatar name={row.name} tone="primary" size={46} />
            <View style={{ flex: 1 }}>
              <Text style={font.h2} numberOfLines={1}>{row.name}</Text>
              {!!row.roll && <Text style={font.small}>Roll {row.roll}</Text>}
              <Text style={[font.small, { marginTop: 1 }]}>Submitted {fmtDateTime(sub.submitted_at)}</Text>
            </View>
            <Chip label={st.label} tone={st.tone} />
          </View>
        </Card>

        {!!sub.text_answer && (
          <Card style={{ marginBottom: SP.md }}>
            <SectionLabel>Written answer</SectionLabel>
            <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled>
              <Text style={[font.body, { color: T.ink }]}>{sub.text_answer}</Text>
            </ScrollView>
          </Card>
        )}

        {(sub.attachments?.length > 0 || sub.links?.length > 0) ? (
          <Card style={{ marginBottom: SP.md }}>
            <SectionLabel>Student's work</SectionLabel>
            <ResourceList attachments={sub.attachments} links={sub.links} />
          </Card>
        ) : !sub.text_answer ? (
          <Banner tone="warning" style={{ marginBottom: SP.md }}>This submission has no files or links.</Banner>
        ) : null}

        <Card style={{ marginBottom: SP.md, gap: SP.lg }}>
          <View>
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: SP.sm }}>
              <Text style={[font.label, { flex: 1 }]}>Marks out of {totalMarks}</Text>
              {pct != null && <Chip label={`${pct}%`} tone={pctTone} />}
            </View>
            <TextInput
              value={marks}
              onChangeText={(t) => setMarks(t.replace(/[^0-9.]/g, ""))}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={T.muted}
              maxLength={7}
              editable={!saving}
              accessibilityLabel="Marks"
              style={{
                height: 60,
                borderRadius: R.md,
                borderWidth: 2,
                borderColor: err ? T.danger : T.primary,
                backgroundColor: T.primarySoft,
                textAlign: "center",
                fontSize: 28,
                fontWeight: "800",
                color: T.primary,
              }}
            />
            {!!err && <Text style={{ color: T.danger, fontSize: 12.5, marginTop: SP.xs }}>{err}</Text>}
          </View>
          <TextField label="Feedback (optional)" value={feedback} onChangeText={setFeedback} placeholder="Write feedback for the student" multiline minHeight={100} autoCapitalize="sentences" autoCorrect maxLength={5000} editable={!saving} />
          <ToggleRow
            title="Return to student"
            sub={returned ? "The student can see the marks and feedback" : "Hidden: the student cannot see the grade yet"}
            value={returned}
            onChange={setReturned}
            disabled={saving}
          />
        </Card>

        <Button label={returned ? "Save and return" : "Save, keep hidden"} icon="checkmark" variant={returned ? "success" : "primary"} onPress={save} loading={saving} />
      </ScrollView>
    </SheetFrame>
  );
}

/* ───────────── grade everyone ───────────── */
function GradeAllSheet({ rows, totalMarks, teacher_id, onClose, onSaved }: { rows: Row[]; totalMarks: number; teacher_id: string; onClose: () => void; onSaved: () => void }) {
  const list = useMemo(() => rows.filter((r) => r.submission), [rows]);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    list.forEach((r) => { d[r.uid] = r.submission!.marks_obtained != null ? String(r.submission!.marks_obtained) : ""; });
    return d;
  });
  const [returnAll, setReturnAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checked, setChecked] = useState(false);

  const saveAll = async () => {
    setChecked(true);
    const filled = list.filter((r) => (drafts[r.uid] ?? "").trim() !== "");
    const bad = filled.filter((r) => marksError(drafts[r.uid], totalMarks));
    if (bad.length) {
      Alert.alert("Check the marks", `Fix the marks for ${bad.slice(0, 3).map((r) => r.name).join(", ")}${bad.length > 3 ? ` and ${bad.length - 3} more` : ""}.`);
      return;
    }
    const changed = filled.filter((r) => {
      const s = r.submission!;
      return s.status !== "graded" || Number(drafts[r.uid]) !== s.marks_obtained || (returnAll && !isReturned(s));
    });
    if (!changed.length) {
      Alert.alert("Nothing to save", filled.length ? "No marks were changed." : "Enter marks for at least one student.");
      return;
    }
    setSaving(true);
    const { ok, failed } = await inBatches(changed, 5, async (r) => {
      const s = r.submission!;
      await api(
        `/api/assignments/grade/${s.submission_id}`,
        jsonInit(s.status === "graded" ? "PUT" : "POST", {
          teacher_id,
          marks_obtained: Number(drafts[r.uid]),
          feedback: s.feedback || undefined, // keep the feedback already written
          returned: returnAll || isReturned(s), // never hide a grade that was already returned
        })
      );
    });
    setSaving(false);
    onSaved();
    if (!failed.length) {
      Alert.alert("Saved", `${ok} grade${ok === 1 ? "" : "s"} saved${returnAll ? " and returned" : ""}.`, [{ text: "OK", onPress: onClose }]);
    } else {
      Alert.alert("Some grades were not saved", `${ok} saved. Failed: ${failed.map((r) => r.name).join(", ")}. Try those again.`);
    }
  };

  return (
    <SheetFrame title="Grade all" onClose={onClose}>
      <View style={{ padding: SP.lg, paddingBottom: SP.sm, gap: SP.md }}>
        <Card>
          <ToggleRow title="Return all to students" sub="Students see these grades as soon as you save" value={returnAll} onChange={setReturnAll} disabled={saving} />
        </Card>
        <View style={{ flexDirection: "row", paddingHorizontal: SP.xs }}>
          <Text style={[font.label, { flex: 1 }]}>Student</Text>
          <Text style={[font.label, { width: 96, textAlign: "center" }]}>Marks / {totalMarks}</Text>
        </View>
      </View>
      {list.length === 0 ? (
        <EmptyState icon="document-outline" title="No submissions yet" text="There is nothing to grade." />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(r) => r.uid}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: SP.lg, paddingBottom: SP.xl }}
          renderItem={({ item: r }) => {
            const st = statusOf(r.submission);
            const d = drafts[r.uid] ?? "";
            const e = checked && d.trim() !== "" ? marksError(d, totalMarks) : null;
            return (
              <View style={{ flexDirection: "row", alignItems: "center", gap: SP.sm, backgroundColor: T.surface, borderRadius: R.md, borderWidth: 1, borderColor: T.line, padding: SP.md, marginBottom: SP.sm }}>
                <View style={{ flex: 1 }}>
                  <Text style={font.h3} numberOfLines={1}>{r.name}</Text>
                  <Text style={font.small} numberOfLines={1}>{[r.roll, st.label].filter(Boolean).join("  -  ")}</Text>
                </View>
                <TextInput
                  value={d}
                  onChangeText={(v) => setDrafts((p) => ({ ...p, [r.uid]: v.replace(/[^0-9.]/g, "") }))}
                  keyboardType="decimal-pad"
                  placeholder="-"
                  placeholderTextColor={T.muted}
                  maxLength={7}
                  editable={!saving}
                  accessibilityLabel={`Marks for ${r.name}`}
                  style={{
                    width: 84,
                    height: 42,
                    borderRadius: R.sm,
                    borderWidth: 1.5,
                    borderColor: e ? T.danger : d ? T.primary : T.line,
                    backgroundColor: d ? T.primarySoft : T.lineSoft,
                    textAlign: "center",
                    fontSize: 16,
                    fontWeight: "800",
                    color: e ? T.danger : T.primary,
                  }}
                />
              </View>
            );
          }}
        />
      )}
      <View style={{ padding: SP.md, backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.line }}>
        <Button label="Save all" icon="checkmark" onPress={saveAll} loading={saving} disabled={list.length === 0} />
      </View>
    </SheetFrame>
  );
}

/* ───────────── screen ───────────── */
export default function TeacherAssignmentDetail() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { assignment: initial, teacher_id, subject } = route.params ?? {};

  if (!initial?.assignment_id || !teacher_id) {
    return (
      <Screen>
        <Header title="Assignment" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Assignment not available" text="Go back and open it again from the list." />
      </Screen>
    );
  }
  return <Detail initial={initial} teacher_id={teacher_id} subject={subject} subjectName={subject?.subject_name} />;
}

type Filter = "all" | "submitted" | "missing";

function Detail({ initial, teacher_id, subject, subjectName }: { initial: any; teacher_id: string; subject?: any; subjectName?: string }) {
  const navigation = useNavigation<any>();
  const [assignment, setAssignment] = useState<any>(initial);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [sheet, setSheet] = useState<null | "edit" | "all">(null);
  const [grading, setGrading] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const loadedOnce = useRef(false);
  const id: string = initial.assignment_id;

  const load = useCallback(
    async (silent = false) => {
      try {
        if (!silent && !loadedOnce.current) setLoading(true);
        const assign = await api<{ assignment: any }>(`/api/assignments/${id}?teacher_id=${enc(teacher_id)}`);
        setAssignment(assign.assignment);
        if (stateOf(assign.assignment) !== "published") {
          // a scheduled post has no submissions yet
          setRows([]);
          setError(null);
          loadedOnce.current = true;
          return;
        }
        const subs = await api<{ submissions: Submission[] }>(`/api/assignments/${id}/submissions?teacher_id=${enc(teacher_id)}`);

        const submissions = subs.submissions || [];
        const byUid = new Map(submissions.map((s) => [s.student_uid, s]));

        // Everyone enrolled, so students who have not submitted show up as missing.
        let students: { uid: string; name: string; roll: string | null }[] = [];
        try {
          const st = await api<{ students: typeof students }>(`/api/assignments/${id}/students?teacher_id=${enc(teacher_id)}`);
          students = st.students || [];
        } catch {
          /* fall back to the people who submitted */
        }
        if (!students.length) {
          students = submissions.map((s) => ({ uid: s.student_uid, name: s.student_name || s.student_uid, roll: s.student_roll }));
        }

        const order: Record<string, number> = { graded: 0, late: 1, submitted: 2, none: 3 };
        const next: Row[] = students
          .map((s) => ({ uid: s.uid, name: s.name || s.uid, roll: s.roll, submission: byUid.get(s.uid) || null }))
          .sort((a, b) => {
            const d = order[a.submission?.status ?? "none"] - order[b.submission?.status ?? "none"];
            return d || (a.roll || a.name).localeCompare(b.roll || b.name, undefined, { numeric: true });
          });
        setRows(next);
        setError(null);
        loadedOnce.current = true;
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [id, teacher_id]
  );
  useFocusEffect(useCallback(() => { load(); }, [load]));

  /* ── counts ── */
  const total = rows.length;
  const submitted = rows.filter((r) => r.submission).length;
  const graded = rows.filter((r) => r.submission?.status === "graded").length;
  const hidden = rows.filter((r) => r.submission?.status === "graded" && !isReturned(r.submission)).length;
  const missing = total - submitted;
  const { tags } = useTags(assignment.subject_id, assignment.course_id);
  const tagName = tagNameOf(tags, assignment.tag_id);
  const state = stateOf(assignment);
  const kind = kindOf(assignment);
  const overdue = state === "published" && isPastDue(assignment.due_date);
  const visible = filter === "submitted" ? rows.filter((r) => r.submission) : filter === "missing" ? rows.filter((r) => !r.submission) : rows;

  /* ── actions ── */
  const remove = () => {
    Alert.alert("Delete assignment?", "All submissions for it are deleted too. This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await api(`/api/assignments/${id}?teacher_id=${enc(teacher_id)}`, { method: "DELETE" });
            navigation.goBack();
          } catch (e: any) {
            setBusy(false);
            Alert.alert("Could not delete", e.message);
          }
        },
      },
    ]);
  };

  const setStatus = async (status: "published" | "draft") => {
    setBusy(true);
    try {
      await api(`/api/assignments/${id}`, jsonInit("PUT", { teacher_id, status }));
      await load(true);
    } catch (e: any) {
      Alert.alert(status === "published" ? "Could not post it" : "Could not move it to drafts", e.message);
    } finally {
      setBusy(false);
    }
  };
  const postNow = () =>
    Alert.alert("Post now?", "Students are notified straight away instead of at the scheduled time.", [
      { text: "Cancel", style: "cancel" },
      { text: "Post now", onPress: () => setStatus("published") },
    ]);

  const returnHidden = () => {
    const targets = rows.filter((r) => r.submission?.status === "graded" && !isReturned(r.submission!));
    if (!targets.length) return;
    Alert.alert("Return grades?", `${targets.length} graded submission${targets.length === 1 ? " is" : "s are"} hidden. Students will see their marks and feedback.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Return",
        onPress: async () => {
          setBusy(true);
          const { ok, failed } = await inBatches(targets, 5, async (r) => {
            const s = r.submission!;
            await api(`/api/assignments/grade/${s.submission_id}`, jsonInit("PUT", { teacher_id, marks_obtained: s.marks_obtained, feedback: s.feedback || undefined, returned: true }));
          });
          setBusy(false);
          await load(true);
          if (failed.length) Alert.alert("Some were not returned", `${ok} returned. Failed: ${failed.map((r) => r.name).join(", ")}.`);
        },
      },
    ]);
  };

  /* ── render ── */
  return (
    <Screen>
      <Header
        title={assignment.title}
        subtitle={subjectName}
        onBack={() => navigation.goBack()}
        right={
          <View style={{ flexDirection: "row", gap: SP.sm }}>
            <HeaderIconButton icon="create-outline" label="Edit assignment" onPress={() => setSheet("edit")} />
            <HeaderIconButton icon="trash-outline" label="Delete assignment" onPress={remove} />
          </View>
        }
      />

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={T.primary} />
        </View>
      ) : !loadedOnce.current && error ? (
        <View>
          <EmptyState icon="cloud-offline-outline" title="Could not load" text={error} />
          <View style={{ paddingHorizontal: SP.xl }}>
            <Button label="Try again" icon="refresh" variant="secondary" onPress={() => load()} />
          </View>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} colors={[T.primary]} tintColor={T.primary} />}
        >
          {!!error && (
            <Banner tone="warning" title="Showing the last loaded data" style={{ marginBottom: SP.md }}>
              {error}
            </Banner>
          )}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SP.sm, marginBottom: SP.md }}>
            <Chip label={KIND_SHORT[kind]} icon={KIND_ICON[kind] as any} tone={KIND_TONE[kind]} />
            {!!tagName && <Chip label={tagName} icon="pricetag-outline" tone="neutral" />}
            <Chip label={`Due ${fmtDateTime(assignment.due_date)}`} icon="time-outline" tone={overdue ? "danger" : "neutral"} />
            <Chip label={`${assignment.marks} marks`} tone="primary" />
            <Chip label={assignment.allow_late ? "Late allowed" : "No late work"} tone={assignment.allow_late ? "success" : "neutral"} />
          </View>

          {state === "scheduled" && (
            <Banner tone="info" title={`Posts ${fmtDateTime(assignment.publish_at)}`} style={{ marginBottom: SP.md }}>
              <Text style={font.body}>Students cannot see this yet. They are notified when it posts.</Text>
              <View style={{ flexDirection: "row", gap: SP.lg, marginTop: SP.xs }}>
                <Pressable onPress={postNow} disabled={busy} accessibilityRole="button">
                  <Text style={{ color: T.primary, fontWeight: "800", fontSize: 13.5 }}>Post now</Text>
                </Pressable>
                <Pressable onPress={() => setStatus("draft")} disabled={busy} accessibilityRole="button">
                  <Text style={{ color: T.primary, fontWeight: "800", fontSize: 13.5 }}>Move to drafts</Text>
                </Pressable>
              </View>
            </Banner>
          )}

          {!!assignment.instructions && (
            <Card style={{ marginBottom: SP.md }}>
              <SectionLabel>Instructions</SectionLabel>
              <Text style={[font.body, { color: T.ink }]}>{assignment.instructions}</Text>
            </Card>
          )}
          {!!assignment.questions && (
            <Card style={{ marginBottom: SP.md }}>
              <SectionLabel>Questions</SectionLabel>
              <Text style={[font.body, { color: T.ink }]}>{assignment.questions}</Text>
            </Card>
          )}
          {(assignment.attachments?.length > 0 || assignment.links?.length > 0) && (
            <Card style={{ marginBottom: SP.md }}>
              <SectionLabel>Attachments</SectionLabel>
              <ResourceList attachments={assignment.attachments} links={assignment.links} />
            </Card>
          )}

          {state === "published" && <>
          <StatRow
            items={[
              { value: submitted, label: "Submitted", tone: "primary" },
              { value: graded, label: "Graded", tone: "success" },
              { value: missing, label: "Missing", tone: missing > 0 ? "danger" : "neutral" },
              { value: total, label: "Total" },
            ]}
          />

          {hidden > 0 && (
            <Banner tone="warning" title={`${hidden} grade${hidden === 1 ? " is" : "s are"} hidden from students`} style={{ marginTop: SP.md }}>
              <Text style={font.body}>Students cannot see these marks yet.</Text>
              <Pressable onPress={returnHidden} disabled={busy} accessibilityRole="button" style={{ marginTop: SP.xs }}>
                <Text style={{ color: T.primary, fontWeight: "800", fontSize: 13.5 }}>Return to students</Text>
              </Pressable>
            </Banner>
          )}

          <Button label="Grade all" icon="list-outline" onPress={() => setSheet("all")} disabled={submitted === 0 || busy} style={{ marginTop: SP.md, marginBottom: SP.md }} />

          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: `All ${total}` },
              { value: "submitted", label: `In ${submitted}` },
              { value: "missing", label: `Missing ${missing}` },
            ]}
          />

          <Card padded={false} style={{ marginTop: SP.md, overflow: "hidden" }}>
            {visible.length === 0 ? (
              <EmptyState icon="document-outline" title={filter === "missing" ? "Nobody is missing" : "No students found"} />
            ) : (
              visible.map((r, i) => {
                const st = statusOf(r.submission);
                const s = r.submission;
                const open = !!s;
                return (
                  <Pressable
                    key={r.uid}
                    onPress={open ? () => setGrading(r) : undefined}
                    disabled={!open}
                    accessibilityRole={open ? "button" : undefined}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: SP.md,
                      padding: SP.md,
                      borderTopWidth: i === 0 ? 0 : 1,
                      borderTopColor: T.lineSoft,
                      backgroundColor: pressed ? T.lineSoft : T.surface,
                    })}
                  >
                    <Avatar name={r.name} tone={s ? "primary" : "neutral"} size={38} />
                    <View style={{ flex: 1 }}>
                      <Text style={font.h3} numberOfLines={1}>{r.name}</Text>
                      <Text style={font.small} numberOfLines={1}>
                        {[r.roll, s?.submitted_at ? fmtShort(s.submitted_at) : null].filter(Boolean).join("  -  ") || " "}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      <Chip label={st.label} tone={st.tone} />
                      {s?.marks_obtained != null && (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                          <Ionicons name={isReturned(s) ? "eye-outline" : "eye-off-outline"} size={13} color={isReturned(s) ? T.success : T.warning} />
                          <Text style={{ fontSize: 13, fontWeight: "800", color: T.ink }}>{s.marks_obtained}/{assignment.marks}</Text>
                        </View>
                      )}
                    </View>
                    {open && <Ionicons name="chevron-forward" size={16} color={T.muted} />}
                  </Pressable>
                );
              })
            )}
          </Card>
          </>}
        </ScrollView>
      )}

      {sheet === "edit" && <EditSheet assignment={assignment} subject={subject} teacher_id={teacher_id} onClose={() => setSheet(null)} onSaved={() => load(true)} />}
      {sheet === "all" && <GradeAllSheet rows={rows} totalMarks={assignment.marks} teacher_id={teacher_id} onClose={() => setSheet(null)} onSaved={() => load(true)} />}
      {grading && <GradeSheet key={grading.uid} row={grading} totalMarks={assignment.marks} teacher_id={teacher_id} onClose={() => setGrading(null)} onSaved={() => load(true)} />}
    </Screen>
  );
}