import React, { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as DocumentPicker from "expo-document-picker";
import { Button, Card, EmptyState, Header, SP, Screen, SectionLabel, TextField, ToggleRow } from "../../../components/ui";
import { AttachmentEditor, DateTimeField, LinkItem, TagPicker, api, jsonInit, startOfToday, uploadFiles } from "../WorkShared";

const WEEK = 7 * 24 * 60 * 60 * 1000;

export default function CreateAnnouncement() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, course, teacher_id } = route.params ?? {};

  const [tagId, setTagId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [pinned, setPinned] = useState(false);
  const [pinUntil, setPinUntil] = useState<Date>(() => new Date(Date.now() + WEEK));
  const [files, setFiles] = useState<DocumentPicker.DocumentPickerAsset[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [errors, setErrors] = useState<{ title?: string; text?: string; pin?: string }>({});
  const [busy, setBusy] = useState(false);

  /** Set once the announcement exists, so a retry after a failed file upload never posts it twice. */
  const createdId = useRef<string | null>(null);
  const leaving = useRef(false);

  const dirty = !!title.trim() || !!text.trim() || files.length > 0 || links.length > 0;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(
    () =>
      navigation.addListener("beforeRemove", (e: any) => {
        if (leaving.current || !dirtyRef.current || createdId.current) return;
        e.preventDefault();
        Alert.alert("Discard this announcement?", "What you wrote has not been posted.", [
          { text: "Keep editing", style: "cancel" },
          { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation]
  );

  if (!subject || !course || !teacher_id) {
    return (
      <Screen>
        <Header title="New announcement" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Subject not available" text="Go back and choose the subject again." />
      </Screen>
    );
  }

  const validate = () => {
    const e: typeof errors = {};
    if (!title.trim()) e.title = "Enter a title.";
    if (!text.trim()) e.text = "Write the announcement.";
    if (pinned && pinUntil.getTime() <= Date.now()) e.pin = "Choose a time in the future.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const post = async () => {
    if (!validate()) return;
    setBusy(true);
    try {
      if (!createdId.current) {
        const body: any = {
          teacher_id,
          course_id: course.course_id,
          subject_id: subject.subject_id,
          title: title.trim(),
          text: text.trim(),
          is_pinned: pinned,
          tag_id: tagId,
          links: JSON.stringify(links),
          attachments: "[]",
        };
        if (pinned) body.pin_expires_at = pinUntil.toISOString();
        const created = await api<{ announcement_id: string }>("/api/assignments/announcements", jsonInit("POST", body));
        createdId.current = created.announcement_id;
      }

      if (files.length > 0) {
        try {
          const uploaded = await uploadFiles(files, "announcements", createdId.current);
          await api(`/api/assignments/announcements/${createdId.current}`, jsonInit("PUT", { teacher_id, attachments: uploaded }));
        } catch (e: any) {
          Alert.alert("Posted, but the files did not upload", `${e.message}\n\nThe announcement is already posted. Tap Post again to retry the files.`);
          return;
        }
      }

      leaving.current = true;
      navigation.goBack();
    } catch (e: any) {
      Alert.alert("Could not post", e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Header title="New announcement" subtitle={subject.subject_name} onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Card style={{ marginBottom: SP.md, gap: SP.lg }}>
            <TagPicker subject_id={subject.subject_id} course_id={course.course_id} teacher_id={teacher_id} value={tagId} onChange={setTagId} disabled={busy || !!createdId.current} />
            <TextField
              label="Title"
              value={title}
              onChangeText={(t) => { setTitle(t); if (errors.title) setErrors((p) => ({ ...p, title: undefined })); }}
              placeholder="e.g. Mid-term syllabus update"
              autoCapitalize="sentences"
              autoCorrect
              maxLength={300}
              error={errors.title}
              editable={!busy && !createdId.current}
            />
            <TextField
              label="Message"
              value={text}
              onChangeText={(t) => { setText(t); if (errors.text) setErrors((p) => ({ ...p, text: undefined })); }}
              placeholder="Write your announcement here"
              multiline
              minHeight={140}
              autoCapitalize="sentences"
              autoCorrect
              maxLength={20000}
              error={errors.text}
              editable={!busy && !createdId.current}
            />
            <ToggleRow title="Pin to top" sub="Pinned posts stay first until the time you choose" value={pinned} onChange={setPinned} disabled={busy || !!createdId.current} />
            {pinned && <DateTimeField label="Pin until" value={pinUntil} onChange={setPinUntil} minimumDate={startOfToday()} error={errors.pin} />}
          </Card>

          <Card style={{ marginBottom: SP.lg }}>
            <SectionLabel>Attachments</SectionLabel>
            <AttachmentEditor files={files} onFiles={setFiles} links={links} onLinks={setLinks} disabled={busy || !!createdId.current} />
          </Card>

          <Button label={createdId.current ? "Retry file upload" : "Post announcement"} icon="paper-plane-outline" onPress={post} loading={busy} />
          <View style={{ height: SP.lg }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}