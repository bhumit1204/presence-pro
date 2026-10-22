import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import * as DocumentPicker from "expo-document-picker";
import { auth } from "../../../services/firebase";
import { Banner, Button, Card, Chip, EmptyState, Header, R, SP, Screen, SectionLabel, T, Tone, font } from "../../../components/ui";
import {
  Attachment, AttachmentEditor, KIND_ICON, KIND_LABEL, KIND_SHORT, KIND_TONE, LinkItem, ResourceList, api, kindOf, fmtDateTime, isPastDue, jsonInit, uploadFiles,
} from "../WorkShared";

type Asset = DocumentPicker.DocumentPickerAsset;
const sameFile = (a: Attachment, b: Attachment) => (a.key && b.key ? a.key === b.key : a.url === b.url);

export default function StudentAssignmentDetail() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const assignment = route.params?.assignment;
  const uid: string | undefined = route.params?.student_uid || auth.currentUser?.uid;

  if (!assignment?.assignment_id || !uid) {
    return (
      <Screen>
        <Header title="Assignment" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Assignment not available" text="Go back and open it again from the list." />
      </Screen>
    );
  }
  return <Detail assignment={assignment} uid={uid} />;
}

function Detail({ assignment, uid }: { assignment: any; uid: string }) {
  const navigation = useNavigation<any>();

  const [submission, setSubmission] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [existing, setExisting] = useState<Attachment[]>([]);
  const [newFiles, setNewFiles] = useState<Asset[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [busy, setBusy] = useState<null | "submit" | "unsubmit">(null);

  const loadedOnce = useRef(false);
  const dirtyRef = useRef(false);

  /* ── derived state ── */
  const overdue = isPastDue(assignment.due_date);
  const isSubmitted = !!submission;
  const isGraded = submission?.status === "graded";
  const gradeHidden = isGraded && submission?.grade_hidden === true;
  const showGrade = isGraded && !gradeHidden && submission?.marks_obtained != null;
  const deadlineLocked = overdue && !assignment.allow_late; // nothing can be sent or changed any more
  const locked = isGraded || (isSubmitted && deadlineLocked);
  const cannotSubmit = !isSubmitted && deadlineLocked;

  const savedFiles: Attachment[] = submission?.attachments ?? [];
  const savedLinks: LinkItem[] = submission?.links ?? [];
  const dirty =
    newFiles.length > 0 ||
    existing.length !== savedFiles.length ||
    links.length !== savedLinks.length ||
    links.some((l, i) => l.url !== savedLinks[i]?.url);
  const hasContent = existing.length + newFiles.length + links.length > 0;
  dirtyRef.current = dirty && !locked;

  /* ── load ── */
  const load = useCallback(
    async (force = false) => {
      try {
        if (!loadedOnce.current) setLoading(true);
        const d = await api<{ submission: any }>(`/api/assignments/${assignment.assignment_id}/my-submission?student_uid=${encodeURIComponent(uid)}`);
        const sub = d.submission ?? null;
        setSubmission(sub);
        if (force || !dirtyRef.current) {
          setExisting(sub?.attachments ?? []);
          setLinks(sub?.links ?? []);
          setNewFiles([]);
        }
        setLoadError(null);
        loadedOnce.current = true;
      } catch (e: any) {
        setLoadError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [assignment.assignment_id, uid]
  );
  useFocusEffect(useCallback(() => { load(); }, [load]));

  /* ── leave guard ── */
  useEffect(() => {
    const unsub = navigation.addListener("beforeRemove", (e: any) => {
      if (!dirtyRef.current || busy) return;
      e.preventDefault();
      Alert.alert("Discard your work?", "What you added has not been turned in yet.", [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
      ]);
    });
    return unsub;
  }, [navigation, busy]);

  /* ── actions ── */
  const submit = async () => {
    if (isPastDue(assignment.due_date) && !assignment.allow_late) {
      Alert.alert("Deadline passed", "Late submissions are not accepted for this assignment.");
      return;
    }
    if (!hasContent) {
      Alert.alert("Nothing to turn in", "Add a file or a link first.");
      return;
    }
    setBusy("submit");
    try {
      const uploaded = await uploadFiles(newFiles, "submissions");
      if (isSubmitted) {
        const deleted = savedFiles.filter((a) => !existing.some((e) => sameFile(a, e))).map((a) => a.key).filter(Boolean);
        await api(`/api/assignments/${assignment.assignment_id}/resubmit`, jsonInit("PUT", { student_uid: uid, attachments: uploaded, links, deleted_keys: deleted }));
      } else {
        await api(`/api/assignments/${assignment.assignment_id}/submit`, jsonInit("POST", { student_uid: uid, attachments: uploaded, links }));
      }
      await load(true);
      Alert.alert(isSubmitted ? "Updated" : "Turned in", isSubmitted ? "Your submission has been updated." : "Your assignment was turned in.");
    } catch (e: any) {
      Alert.alert("Could not turn in", e.message);
    } finally {
      setBusy(null);
    }
  };

  const unsubmit = () => {
    Alert.alert("Unsubmit?", "Your submission will be removed. You can turn in again until the deadline.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unsubmit",
        style: "destructive",
        onPress: async () => {
          setBusy("unsubmit");
          try {
            await api(`/api/assignments/${assignment.assignment_id}/unsubmit`, jsonInit("POST", { student_uid: uid }));
            await load(true);
          } catch (e: any) {
            Alert.alert("Could not unsubmit", e.message);
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  };

  /* ── status chip ── */
  const status: { label: string; tone: Tone } | null = !isSubmitted
    ? null
    : showGrade
    ? { label: "Graded", tone: "success" }
    : gradeHidden
    ? { label: "Under review", tone: "info" }
    : submission.status === "late"
    ? { label: "Turned in late", tone: "warning" }
    : { label: "Turned in", tone: "success" };

  /* ── render ── */
  if (loading) {
    return (
      <Screen>
        <Header title="Assignment" onBack={() => navigation.goBack()} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={T.primary} />
        </View>
      </Screen>
    );
  }
  if (loadError && !loadedOnce.current) {
    return (
      <Screen>
        <Header title="Assignment" onBack={() => navigation.goBack()} />
        <EmptyState icon="cloud-offline-outline" title="Could not load" text={loadError} />
        <View style={{ paddingHorizontal: SP.xl }}>
          <Button label="Try again" icon="refresh" variant="secondary" onPress={() => load()} />
        </View>
      </Screen>
    );
  }

  const pct = showGrade && assignment.marks > 0 ? Math.round((submission.marks_obtained / assignment.marks) * 100) : null;
  const actionable = !locked && !cannotSubmit;

  return (
    <Screen>
      <Header title={kindOf(assignment) === "assignment" ? "Assignment" : KIND_LABEL[kindOf(assignment)]} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {/* title + chips */}
        <Card style={{ marginBottom: SP.md }}>
          <Text style={font.h1}>{assignment.title}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SP.sm, marginTop: SP.md }}>
            {!!assignment.tag_name && <Chip label={assignment.tag_name} icon="pricetag-outline" tone="neutral" />}
            <Chip label={KIND_SHORT[kindOf(assignment)]} icon={KIND_ICON[kindOf(assignment)] as any} tone={KIND_TONE[kindOf(assignment)]} />
            <Chip label={`Due ${fmtDateTime(assignment.due_date)}`} icon="time-outline" tone={overdue && !isSubmitted ? "danger" : "neutral"} />
            <Chip label={`${assignment.marks} marks`} tone="primary" />
            {!!assignment.allow_late && <Chip label="Late allowed" tone="warning" />}
            {status && <Chip label={status.label} tone={status.tone} icon="checkmark-circle" />}
          </View>
        </Card>

        {/* banners */}
        {cannotSubmit && (
          <Banner tone="danger" title="Deadline passed" style={{ marginBottom: SP.md }}>
            Late submissions are not accepted for this assignment.
          </Banner>
        )}
        {!isSubmitted && overdue && !!assignment.allow_late && (
          <Banner tone="warning" title="Past the deadline" style={{ marginBottom: SP.md }}>
            You can still turn this in. It will be marked as late.
          </Banner>
        )}
        {isSubmitted && !isGraded && deadlineLocked && (
          <Banner tone="info" title="Submission locked" style={{ marginBottom: SP.md }}>
            The deadline has passed, so your submission can no longer be changed.
          </Banner>
        )}
        {gradeHidden && (
          <Banner tone="info" title="Graded, marks not released" style={{ marginBottom: SP.md }}>
            Your teacher has graded this. You will see the marks once they are released.
          </Banner>
        )}

        {/* grade */}
        {showGrade && (
          <Card tone="success" style={{ marginBottom: SP.md }}>
            <Text style={font.label}>Your grade</Text>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: SP.sm, marginTop: SP.xs }}>
              <Text style={{ fontSize: 34, fontWeight: "800", color: T.success }}>{submission.marks_obtained}</Text>
              <Text style={{ fontSize: 18, fontWeight: "700", color: T.success }}>/ {assignment.marks}</Text>
              {pct != null && <Chip label={`${pct}%`} tone="success" style={{ marginLeft: "auto" }} />}
            </View>
            {!!submission.feedback && (
              <View style={{ backgroundColor: T.surface, borderRadius: R.sm, padding: SP.md, marginTop: SP.md }}>
                <Text style={font.label}>Feedback</Text>
                <Text style={[font.body, { marginTop: SP.xs, color: T.ink }]}>{submission.feedback}</Text>
              </View>
            )}
          </Card>
        )}

        {/* teacher content */}
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
            <SectionLabel>Resources</SectionLabel>
            <ResourceList attachments={assignment.attachments} links={assignment.links} />
          </Card>
        )}

        {/* your work */}
        <Card style={{ marginBottom: SP.md }}>
          <SectionLabel>Your work</SectionLabel>
          {locked ? (
            existing.length + links.length > 0 ? (
              <ResourceList attachments={existing} links={links} />
            ) : (
              <Text style={font.body}>Nothing was attached.</Text>
            )
          ) : cannotSubmit ? (
            <Text style={font.body}>Submissions are closed.</Text>
          ) : (
            <AttachmentEditor
              existing={existing}
              onRemoveExisting={(a) => setExisting((p) => p.filter((x) => !sameFile(x, a)))}
              files={newFiles}
              onFiles={setNewFiles}
              links={links}
              onLinks={setLinks}
              disabled={!!busy}
            />
          )}
        </Card>

        {actionable && (
          <View style={{ flexDirection: "row", gap: SP.md }}>
            {isSubmitted && <Button label="Unsubmit" variant="secondary" onPress={unsubmit} loading={busy === "unsubmit"} disabled={busy === "submit"} style={{ flex: 1 }} />}
            <Button
              label={isSubmitted ? "Resubmit" : "Turn in"}
              icon={isSubmitted ? "refresh" : "paper-plane-outline"}
              onPress={submit}
              loading={busy === "submit"}
              disabled={busy === "unsubmit" || !hasContent || (isSubmitted && !dirty)}
              style={{ flex: 2 }}
            />
          </View>
        )}
        {actionable && !hasContent && !isSubmitted && <Text style={[font.small, { textAlign: "center", marginTop: SP.md }]}>Add a file or link to turn in.</Text>}
      </ScrollView>
    </Screen>
  );
}