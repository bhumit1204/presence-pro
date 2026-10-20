import React, { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as DocumentPicker from "expo-document-picker";
import { Banner, Button, Card, EmptyState, Header, SP, Screen, SectionLabel, TextField, ToggleRow } from "../../../components/ui";
import { Attachment, AttachmentEditor, DateTimeField, LinkItem, api, defaultDueDate, jsonInit, startOfToday, uploadFiles } from "../WorkShared";

type Errors = { title?: string; marks?: string; due?: string; body?: string };

export default function CreateAssignment() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, course, teacher_id } = route.params ?? {};

  const [title, setTitle] = useState("");
  const [marks, setMarks] = useState("");
  const [dueDate, setDueDate] = useState<Date>(defaultDueDate);
  const [instructions, setInstructions] = useState("");
  const [questions, setQuestions] = useState("");
  const [allowLate, setAllowLate] = useState(false);
  const [files, setFiles] = useState<DocumentPicker.DocumentPickerAsset[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  /** Files already uploaded for the current file selection, so a retry after a failed create does not upload them again. */
  const uploaded = useRef<{ key: string; files: Attachment[] } | null>(null);
  const leaving = useRef(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = !!(title.trim() || marks.trim() || instructions.trim() || questions.trim() || files.length || links.length);

  useEffect(
    () =>
      navigation.addListener("beforeRemove", (e: any) => {
        if (leaving.current || !dirtyRef.current) return;
        e.preventDefault();
        Alert.alert("Discard this assignment?", "What you entered has not been posted.", [
          { text: "Keep editing", style: "cancel" },
          { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation]
  );

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
    const m = Number(marks);
    if (!title.trim()) e.title = "Enter a title.";
    if (!marks.trim() || !isFinite(m) || m < 1) e.marks = "Enter total marks of 1 or more.";
    else if (m > 1000) e.marks = "Total marks cannot be more than 1000.";
    if (dueDate.getTime() <= Date.now()) e.due = "The due date must be in the future.";
    if (!instructions.trim() && !questions.trim()) e.body = "Fill in the instructions, the questions, or both.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const create = async () => {
    if (!validate()) return;
    setBusy(true);
    try {
      const key = files.map((f) => f.uri).join("|");
      if (files.length > 0 && uploaded.current?.key !== key) {
        uploaded.current = { key, files: await uploadFiles(files, "assignments") };
      }
      await api(
        "/api/assignments",
        jsonInit("POST", {
          teacher_id,
          course_id: course.course_id,
          subject_id: subject.subject_id,
          title: title.trim(),
          instructions: instructions.trim() || undefined,
          questions: questions.trim() || undefined,
          marks: Number(marks),
          due_date: dueDate.toISOString(),
          allow_late: allowLate,
          attachments: files.length > 0 ? uploaded.current?.files ?? [] : [],
          links,
        })
      );
      leaving.current = true;
      navigation.goBack();
    } catch (e: any) {
      Alert.alert("Could not create the assignment", e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Header title="New assignment" subtitle={subject.subject_name} onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Card style={{ marginBottom: SP.md, gap: SP.lg }}>
            <TextField
              label="Title"
              value={title}
              onChangeText={(t) => { setTitle(t); clear("title"); }}
              placeholder="Assignment title"
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
            <DateTimeField label="Due" value={dueDate} onChange={(d) => { setDueDate(d); clear("due"); }} minimumDate={startOfToday()} error={errors.due} />
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

          <Card style={{ marginBottom: SP.lg }}>
            <SectionLabel>Attachments</SectionLabel>
            <AttachmentEditor files={files} onFiles={setFiles} links={links} onLinks={setLinks} disabled={busy} />
          </Card>

          <Button label="Create assignment" icon="checkmark" onPress={create} loading={busy} />
          <View style={{ height: SP.lg }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}