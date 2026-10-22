import React, { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as DocumentPicker from "expo-document-picker";
import { Banner, Button, Card, EmptyState, Header, SP, Screen, SectionLabel, TextField, ToggleRow, font } from "../../../components/ui";
import {
  Attachment, AttachmentEditor, DateTimeField, KIND_LABEL, KindPicker, LinkItem, TagPicker, WorkKind, api, defaultDueDate, defaultPublishAt,
  fmtDateTime, jsonInit, kindOf, kindOptions, startOfToday, uploadFiles,
} from "../WorkShared";

type Errors = { title?: string; marks?: string; due?: string; body?: string; kind?: string; publish?: string };

/**
 * New assignment. Everything typed here is saved as a draft on its own a moment after you stop typing,
 * so closing the screen by accident (or the app being killed) loses nothing. Open the draft again from
 * the subject's classwork. Posting turns the draft into the real assignment; "Schedule" posts it later by itself.
 */
export default function CreateAssignment() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, course, teacher_id, draft } = route.params ?? {};

  const [kind, setKind] = useState<WorkKind>(() => (draft ? kindOf(draft) : subject?.kind === "lab" ? "lab_work" : "assignment"));
  const [tagId, setTagId] = useState<string | null>(draft?.tag_id ?? null);
  const [title, setTitle] = useState<string>(draft?.title || "");
  const [marks, setMarks] = useState<string>(draft?.marks != null ? String(draft.marks) : "");
  const [dueDate, setDueDate] = useState<Date>(() => (draft?.due_date ? new Date(draft.due_date) : defaultDueDate()));
  const [dueTouched, setDueTouched] = useState<boolean>(!!draft?.due_date);
  const [instructions, setInstructions] = useState<string>(draft?.instructions || "");
  const [questions, setQuestions] = useState<string>(draft?.questions || "");
  const [allowLate, setAllowLate] = useState<boolean>(!!draft?.allow_late);
  const [scheduleOn, setScheduleOn] = useState<boolean>(() => !!draft?.publish_at && new Date(draft.publish_at).getTime() > Date.now());
  const [publishAt, setPublishAt] = useState<Date>(() => (draft?.publish_at && new Date(draft.publish_at).getTime() > Date.now() ? new Date(draft.publish_at) : defaultPublishAt()));
  const [existing, setExisting] = useState<Attachment[]>(draft?.attachments || []);
  const [files, setFiles] = useState<DocumentPicker.DocumentPickerAsset[]>([]);
  const [links, setLinks] = useState<LinkItem[]>(draft?.links || []);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">(draft ? "saved" : "idle");
  const [savedAt, setSavedAt] = useState<Date | null>(draft?.updated_at ? new Date(draft.updated_at) : null);

  const draftId = useRef<string | null>(draft?.assignment_id ?? null);
  const savedSig = useRef<string>("");
  const uploadedMap = useRef(new Map<string, Attachment>());   // picked file uri -> where it was stored
  const removedKeys = useRef<string[]>([]);                    // stored files the teacher took out again
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const leaving = useRef(false);

  const ok = kindOptions(subject);
  const marksNum = Number(marks);
  const marksValid = !!marks.trim() && isFinite(marksNum) && marksNum >= 1 && marksNum <= 1000;
  const hasContent = !!(title.trim() || marks.trim() || instructions.trim() || questions.trim() || files.length || existing.length || links.length);

  /** What a save would store. When it equals what was last stored there is nothing to do. */
  const sig = JSON.stringify([
    kind, tagId, title.trim(), marksValid ? marksNum : null, dueTouched ? dueDate.getTime() : null, instructions.trim(), questions.trim(), allowLate,
    scheduleOn ? publishAt.getTime() : null, existing.map((a) => a.key || a.url), files.map((f) => f.uri), links.map((l) => l.url),
  ]);
  const sigRef = useRef(sig);
  sigRef.current = sig;
  const hasContentRef = useRef(hasContent);
  hasContentRef.current = hasContent;

  if (savedSig.current === "" && draft) savedSig.current = sig;   // an opened draft starts out saved

  /** Upload picked files that are not stored yet and return every attachment of the form. */
  const collectAttachments = async (): Promise<Attachment[]> => {
    // a picked file that was stored earlier and has been removed since: delete it from storage with the next save
    for (const [uri, att] of [...uploadedMap.current.entries()]) {
      if (!files.some((f) => f.uri === uri)) {
        if (att?.key) removedKeys.current.push(att.key);
        uploadedMap.current.delete(uri);
      }
    }
    const fresh = files.filter((f) => !uploadedMap.current.has(f.uri));
    if (fresh.length) {
      const up = await uploadFiles(fresh, "assignments", draftId.current || undefined);
      fresh.forEach((f, i) => { if (up[i]) uploadedMap.current.set(f.uri, up[i]); });
    }
    return [...existing, ...files.map((f) => uploadedMap.current.get(f.uri)).filter(Boolean) as Attachment[]];
  };

  /** Save (or create) the draft. Saves run one after another, never two at once. */
  const saveDraft = (): Promise<void> => {
    const run = async () => {
      if (sig === savedSig.current && draftId.current) return;
      if (!hasContent) return;
      setSaveState("saving");
      try {
        const attachments = await collectAttachments();
        const body: any = {
          teacher_id,
          status: "draft",
          kind,
          tag_id: tagId,
          title: title.trim(),
          instructions: instructions.trim() || null,
          questions: questions.trim() || null,
          marks: marksValid ? marksNum : null,
          due_date: dueTouched ? dueDate.toISOString() : null,
          publish_at: scheduleOn ? publishAt.toISOString() : null,
          allow_late: allowLate,
          attachments,
          links,
        };
        if (!draftId.current) {
          const created = await api<{ assignment_id: string }>(
            "/api/assignments",
            jsonInit("POST", { ...body, course_id: course.course_id, subject_id: subject.subject_id })
          );
          draftId.current = created.assignment_id;
        } else {
          await api(`/api/assignments/${draftId.current}`, jsonInit("PUT", { ...body, deleted_keys: removedKeys.current }));
        }
        removedKeys.current = [];
        savedSig.current = sig;
        setSavedAt(new Date());
        setSaveState("saved");
      } catch (e) {
        setSaveState("failed");
        throw e;
      }
    };
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => undefined);
    return next as Promise<void>;
  };
  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;

  /* ── autosave a moment after the last change ── */
  useEffect(() => {
    if (!hasContent || leaving.current || busy) return;
    if (sig === savedSig.current && draftId.current) return;
    const t = setTimeout(() => { saveRef.current().catch(() => undefined); }, 1500);
    return () => clearTimeout(t);
  }, [sig, busy]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* ── leaving the screen: save first, then let the teacher choose ── */
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (e: any) => {
        if (leaving.current || !hasContentRef.current) return;
        if (sigRef.current === savedSig.current && draftId.current && draftExists()) return;   // nothing new since the last save
        e.preventDefault();
        const leave = () => { leaving.current = true; navigation.dispatch(e.data.action); };
        saveRef.current().then(
          () => {
            Alert.alert("Saved as a draft", "You can finish it later from this subject's classwork.", [
              { text: "Keep editing", style: "cancel" },
              { text: "Delete draft", style: "destructive", onPress: () => discardDraft().finally(leave) },
              { text: "Close", onPress: leave },
            ]);
          },
          () => {
            Alert.alert("Could not save the draft", "Check your connection. If you leave now, what you typed is lost.", [
              { text: "Keep editing", style: "cancel" },
              { text: "Leave anyway", style: "destructive", onPress: leave },
            ]);
          }
        );
      }),
    [navigation]   // eslint-disable-line react-hooks/exhaustive-deps
  );
  const draftExists = () => !!draftId.current;

  /** Delete the stored draft (and its uploaded files). */
  const discardDraft = async () => {
    if (!draftId.current) return;
    try {
      await queue.current;
      await api(`/api/assignments/${draftId.current}?teacher_id=${encodeURIComponent(teacher_id)}`, { method: "DELETE" });
      draftId.current = null;
    } catch { /* it stays as a draft; the teacher can delete it from the list */ }
  };

  if (!subject || !course || !teacher_id) {
    return (
      <Screen>
        <Header title="New assignment" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Subject not available" text="Go back and choose the subject again." />
      </Screen>
    );
  }

  const clear = (k: keyof Errors) => errors[k] && setErrors((p) => ({ ...p, [k]: undefined }));

  const validate = () => {
    const e: Errors = {};
    if (!title.trim()) e.title = "Enter a title.";
    if (!marks.trim() || !isFinite(marksNum) || marksNum < 1) e.marks = "Enter total marks of 1 or more.";
    else if (marksNum > 1000) e.marks = "Total marks cannot be more than 1000.";
    if (dueDate.getTime() <= Date.now()) e.due = "The due date must be in the future.";
    if (!instructions.trim() && !questions.trim()) e.body = "Fill in the instructions, the questions, or both.";
    if (!ok[kind]) e.kind = kind === "lab_work" ? "This subject has no lab." : "This subject has no tutorial.";
    if (scheduleOn) {
      if (publishAt.getTime() <= Date.now()) e.publish = "Choose a posting time in the future.";
      else if (dueDate.getTime() <= publishAt.getTime()) e.due = "The due date must be after the posting time.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const post = async () => {
    if (!validate()) return;
    setBusy(true);
    try {
      await queue.current;                          // let a running autosave finish first
      const attachments = await collectAttachments();
      const body: any = {
        teacher_id,
        kind,
        tag_id: tagId,
        title: title.trim(),
        instructions: instructions.trim() || null,
        questions: questions.trim() || null,
        marks: marksNum,
        due_date: dueDate.toISOString(),
        allow_late: allowLate,
        attachments,
        links,
        status: scheduleOn ? "scheduled" : "published",
        publish_at: scheduleOn ? publishAt.toISOString() : null,
      };
      if (draftId.current) {
        await api(`/api/assignments/${draftId.current}`, jsonInit("PUT", { ...body, deleted_keys: removedKeys.current }));
      } else {
        const created = await api<{ assignment_id: string }>(
          "/api/assignments",
          jsonInit("POST", { ...body, course_id: course.course_id, subject_id: subject.subject_id })
        );
        draftId.current = created.assignment_id;
      }
      leaving.current = true;
      if (scheduleOn) Alert.alert("Scheduled", `It will be posted on ${fmtDateTime(publishAt.toISOString())}. Students are notified then.`);
      navigation.goBack();
    } catch (e: any) {
      Alert.alert(scheduleOn ? "Could not schedule" : "Could not create the assignment", e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveAndClose = async () => {
    setBusy(true);
    try {
      await saveRef.current();
      leaving.current = true;
      navigation.goBack();
    } catch (e: any) {
      Alert.alert("Could not save the draft", e?.message || "Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const heading = draft ? "Edit draft" : kind === "lab_work" ? "New lab work" : kind === "tutorial_work" ? "New tutorial work" : "New assignment";
  const status =
    saveState === "saving" ? "Saving draft..."
    : saveState === "failed" ? "Could not save the draft. It will try again when you change something."
    : saveState === "saved" && savedAt ? `Draft saved ${savedAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`
    : hasContent ? "Saves as a draft while you type" : "";

  return (
    <Screen>
      <Header title={heading} subtitle={subject.subject_name} onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {!!status && <Text style={[font.small, { marginBottom: SP.sm, textAlign: "right" }]}>{status}</Text>}

          <Card style={{ marginBottom: SP.md, gap: SP.lg }}>
            <KindPicker value={kind} onChange={(k) => { setKind(k); clear("kind"); }} subject={subject} disabled={busy} />
            {!!errors.kind && <Banner tone="danger">{errors.kind}</Banner>}
            <TagPicker subject_id={subject.subject_id} course_id={course.course_id} teacher_id={teacher_id} value={tagId} onChange={setTagId} disabled={busy} />
            <TextField
              label="Title"
              value={title}
              onChangeText={(t) => { setTitle(t); clear("title"); }}
              placeholder={kind === "lab_work" ? "e.g. Experiment 3: Linked lists" : kind === "tutorial_work" ? "e.g. Tutorial sheet 2" : "Assignment title"}
              autoCapitalize="sentences"
              autoCorrect
              maxLength={300}
              error={errors.title}
              editable={!busy}
            />
            <TextField
              label="Total marks"
              value={marks}
              onChangeText={(t) => { setMarks(t.replace(/[^0-9.]/g, "")); clear("marks"); }}
              placeholder="e.g. 20"
              keyboardType="decimal-pad"
              maxLength={6}
              error={errors.marks}
              editable={!busy}
            />
            <DateTimeField label="Due" value={dueDate} onChange={(d) => { setDueDate(d); setDueTouched(true); clear("due"); }} minimumDate={startOfToday()} error={errors.due} />
            <ToggleRow title="Allow late submissions" sub="Students can turn in after the due date. Late work is marked as late." value={allowLate} onChange={setAllowLate} disabled={busy} />
          </Card>

          <Card style={{ marginBottom: SP.md, gap: SP.lg }}>
            <SectionLabel style={{ marginBottom: 0 }}>Content</SectionLabel>
            {!!errors.body && <Banner tone="danger">{errors.body}</Banner>}
            <TextField
              label="Instructions (optional)"
              value={instructions}
              onChangeText={(t) => { setInstructions(t); clear("body"); }}
              placeholder="e.g. Write a 500-word essay on..."
              multiline
              minHeight={110}
              autoCapitalize="sentences"
              autoCorrect
              maxLength={20000}
              editable={!busy}
            />
            <TextField
              label="Questions (optional)"
              value={questions}
              onChangeText={(t) => { setQuestions(t); clear("body"); }}
              placeholder={"1. Explain the concept of...\n2. Describe the differences..."}
              multiline
              minHeight={110}
              autoCapitalize="sentences"
              autoCorrect
              maxLength={50000}
              editable={!busy}
            />
          </Card>

          <Card style={{ marginBottom: SP.md }}>
            <SectionLabel>Attachments</SectionLabel>
            <AttachmentEditor
              existing={existing}
              onRemoveExisting={(a) => {
                setExisting((p) => p.filter((x) => (x.key || x.url) !== (a.key || a.url)));
                if (a.key) removedKeys.current.push(a.key);
              }}
              files={files}
              onFiles={setFiles}
              links={links}
              onLinks={setLinks}
              disabled={busy}
            />
          </Card>

          <Card style={{ marginBottom: SP.lg, gap: SP.lg }}>
            <ToggleRow
              title="Schedule for later"
              sub="It is posted by itself at the time you choose, and students are told then. Until then they cannot see it."
              value={scheduleOn}
              onChange={(v) => { setScheduleOn(v); clear("publish"); }}
              disabled={busy}
            />
            {scheduleOn && (
              <DateTimeField label="Post at" value={publishAt} onChange={(d) => { setPublishAt(d); clear("publish"); clear("due"); }} minimumDate={startOfToday()} error={errors.publish} />
            )}
          </Card>

          <Button
            label={scheduleOn ? "Schedule" : kind === "lab_work" ? "Post lab work" : kind === "tutorial_work" ? "Post tutorial work" : "Post assignment"}
            icon={scheduleOn ? "time-outline" : "checkmark"}
            onPress={post}
            loading={busy}
          />
          <Button label="Save draft and close" icon="save-outline" variant="secondary" onPress={saveAndClose} disabled={busy || !hasContent} style={{ marginTop: SP.md }} />
          <Text style={[font.small, { textAlign: "center", marginTop: SP.md }]}>
            {KIND_LABEL[kind]} {kind === "assignment" ? "goes to everyone who takes this subject." : kind === "lab_work" ? "goes to the whole division." : "goes to everyone who takes this subject."}
          </Text>
          <View style={{ height: SP.lg }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
