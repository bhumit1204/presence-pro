import React, { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { auth } from "../../../services/firebase";
import { Banner, Button, Card, Chip, EmptyState, Header, IconBadge, R, SP, Screen, SectionLabel, T, Tone, font } from "../../../components/ui";
import { ItemCard, KIND_ICON, KIND_SHORT, KIND_TONE, KindFilter, ResourceList, TagFilter, TagSel, WorkKind, api, applyTagFilter, groupByTag, tagNameOf, useTags, fmtDateTime, fmtDay, isPastDue, isPinActive, kindOf, openUrl, ts } from "../WorkShared";

type Tab = "stream" | "assigned" | "submitted" | "missing";

const isImage = (t?: string | null) => (t || "").toLowerCase().includes("image");

/* ───────────── announcement sheet ───────────── */
function AnnouncementSheet({ item, tagName, onClose }: { item: any | null; tagName?: string | null; onClose: () => void }) {
  if (!item) return null;
  const pinned = isPinActive(item);
  const images = (item.attachments || []).filter((a: any) => isImage(a.type) && a.url);
  const others = (item.attachments || []).filter((a: any) => !(isImage(a.type) && a.url));
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen>
        <Header
          title="Announcement"
          right={
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={{ padding: SP.xs }}>
              <Ionicons name="close" size={24} color={T.sub} />
            </Pressable>
          }
        />
        <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }} showsVerticalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: SP.md, alignItems: "flex-start" }}>
            <IconBadge icon={pinned ? "pin" : "megaphone-outline"} size={46} />
            <View style={{ flex: 1 }}>
              <Text style={font.h1}>{item.title}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: SP.sm, marginTop: SP.xs }}>
                <Text style={font.small}>{fmtDateTime(item.created_at)}</Text>
                {pinned && <Chip label="Pinned" tone="primary" />}
                {!!tagName && <Chip label={tagName} icon="pricetag-outline" tone="neutral" />}
              </View>
            </View>
          </View>

          {!!item.text && (
            <Card style={{ marginTop: SP.lg }}>
              <Text style={[font.body, { color: T.ink, fontSize: 15, lineHeight: 23 }]}>{item.text}</Text>
            </Card>
          )}

          {images.length > 0 && (
            <View style={{ marginTop: SP.lg }}>
              <SectionLabel>Images</SectionLabel>
              {images.map((a: any, i: number) => (
                <Pressable key={a.key || i} onPress={() => openUrl(a.url)} style={{ marginBottom: SP.md }} accessibilityRole="button" accessibilityLabel={`Open ${a.name}`}>
                  <Image source={{ uri: a.url }} style={{ width: "100%", height: 210, borderRadius: R.md, backgroundColor: T.lineSoft }} resizeMode="cover" />
                  <Text style={[font.small, { marginTop: SP.xs }]} numberOfLines={1}>
                    {a.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}

          {(others.length > 0 || (item.links || []).length > 0) && (
            <View style={{ marginTop: SP.lg }}>
              <SectionLabel>Attachments and links</SectionLabel>
              <ResourceList attachments={others} links={item.links} />
            </View>
          )}
        </ScrollView>
      </Screen>
    </Modal>
  );
}

/* ───────────── screen ───────────── */
export default function StudentSubjectFeed() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, course, student_uid } = route.params ?? {};
  const uid: string | undefined = student_uid || auth.currentUser?.uid;

  const [tab, setTab] = useState<Tab>("stream");
  const [allAnnouncements, setAnnouncements] = useState<any[]>([]);
  const [allAssignments, setAssignments] = useState<any[]>([]);
  const [subs, setSubs] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<any | null>(null);
  const [kindFilter, setKindFilter] = useState<WorkKind | "all">("all");
  const [tagSel, setTagSel] = useState<TagSel>("all");
  const { tags, reload: reloadTags } = useTags(subject?.subject_id, course?.course_id);
  const loadedOnce = useRef(false);

  const load = useCallback(
    async (silent = false) => {
      if (!subject?.subject_id || !course?.course_id || !uid) return;
      try {
        if (!silent && !loadedOnce.current) setLoading(true);
        const sid = encodeURIComponent(subject.subject_id);
        const cid = encodeURIComponent(course.course_id);
        const [a, n, s] = await Promise.all([
          api<{ assignments: any[] }>(`/api/assignments?subject_id=${sid}&course_id=${cid}`),
          api<{ announcements: any[] }>(`/api/assignments/announcements?subject_id=${sid}&course_id=${cid}`),
          api<{ submissions: any[] }>(`/api/assignments/my-submissions?student_uid=${encodeURIComponent(uid)}&subject_id=${sid}`),
        ]);
        const map: Record<string, any> = {};
        (s.submissions || []).forEach((x) => { map[x.assignment_id] = x; });
        setAssignments(a.assignments || []);
        setAnnouncements(n.announcements || []);
        setSubs(map);
        setError(null);
        loadedOnce.current = true;
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [subject?.subject_id, course?.course_id, uid]
  );
  useFocusEffect(useCallback(() => { load(); reloadTags(); }, [load, reloadTags]));

  const lists = useMemo(() => {
    const assignments = applyTagFilter(allAssignments, tagSel).filter((a) => kindFilter === "all" || kindOf(a) === kindFilter);
    const announcements = kindFilter === "all" ? applyTagFilter(allAnnouncements, tagSel) : [];
    const byCreated = (x: any, y: any) => ts(y.created_at) - ts(x.created_at);
    const pinned = announcements.filter(isPinActive).sort(byCreated);
    const rest = [
      ...announcements.filter((x) => !isPinActive(x)).map((x) => ({ ...x, _t: "n" })),
      ...assignments.map((x) => ({ ...x, _t: "a" })),
    ].sort(byCreated);
    const stream = [...pinned.map((x) => ({ ...x, _t: "n", _pin: true })), ...rest];
    const assigned = assignments.filter((a) => !subs[a.assignment_id] && !isPastDue(a.due_date)).sort((x, y) => ts(x.due_date) - ts(y.due_date));
    const submitted = assignments.filter((a) => !!subs[a.assignment_id]).sort((x, y) => ts(subs[y.assignment_id]?.submitted_at) - ts(subs[x.assignment_id]?.submitted_at));
    const missing = assignments.filter((a) => !subs[a.assignment_id] && isPastDue(a.due_date)).sort((x, y) => ts(y.due_date) - ts(x.due_date));
    return { stream, assigned, submitted, missing };
  }, [allAnnouncements, allAssignments, subs, kindFilter, tagSel]);

  if (!subject || !course || !uid) {
    return (
      <Screen>
        <Header title="Classwork" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Subject not available" text="Go back and choose the subject again." />
      </Screen>
    );
  }

  const openAssignment = (a: any) => navigation.navigate("StudentAssignmentDetail", { assignment: a, student_uid: uid });

  const announcementCard = (n: any) => (
    <ItemCard
      key={`n-${n.announcement_id}`}
      icon={n._pin ? "pin" : "megaphone-outline"}
      title={n.title}
      line={n.text}
      meta={fmtDay(n.created_at)}
      chips={[
        ...(n._pin ? [{ label: "Pinned", tone: "primary" as Tone }] : []),
        ...(tagNameOf(tags, n.tag_id) ? [{ label: tagNameOf(tags, n.tag_id) as string }] : []),
        ...((n.attachments?.length ?? 0) > 0 ? [{ label: `${n.attachments.length} file${n.attachments.length > 1 ? "s" : ""}` }] : []),
      ]}
      pinned={!!n._pin}
      onPress={() => setOpen(n)}
    />
  );

  const assignmentCard = (a: any, missing = false) => {
    const sub = subs[a.assignment_id];
    const overdue = isPastDue(a.due_date);
    const kind = kindOf(a);
    const hidden = sub?.grade_hidden === true;
    const chips: { label: string; tone?: Tone }[] = [{ label: KIND_SHORT[kind], tone: KIND_TONE[kind] }, { label: `${a.marks} marks`, tone: "primary" }];
    if (tagNameOf(tags, a.tag_id)) chips.push({ label: tagNameOf(tags, a.tag_id) as string });
    if (sub) {
      if (sub.status === "graded" && !hidden) chips.push({ label: `${sub.marks_obtained}/${a.marks}`, tone: "success" });
      else if (sub.status === "graded") chips.push({ label: "Under review", tone: "info" });
      else chips.push({ label: sub.status === "late" ? "Turned in late" : "Turned in", tone: sub.status === "late" ? "warning" : "success" });
    } else if (a.allow_late) chips.push({ label: "Late allowed", tone: "warning" });
    return (
      <ItemCard
        key={`a-${a.assignment_id}`}
        icon={missing ? "alert-circle-outline" : (KIND_ICON[kind] as any)}
        tone={sub ? "success" : overdue ? "danger" : "primary"}
        title={a.title}
        meta={`${overdue && !sub ? "Was due" : "Due"} ${fmtDateTime(a.due_date)}`}
        chips={chips}
        onPress={() => openAssignment({ ...a, tag_name: tagNameOf(tags, a.tag_id) })}
      />
    );
  };

  // sections per tag (in the teacher's order) once anything is tagged
  const grouped = (list: any[], missing = false) =>
    groupByTag(list, tags).map((g) => (
      <View key={g.key}>
        {!!g.label && <SectionLabel>{g.label}</SectionLabel>}
        {g.items.map((a) => assignmentCard(a, missing))}
      </View>
    ));

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: "stream", label: "Stream" },
    { key: "assigned", label: "Assigned", count: lists.assigned.length },
    { key: "submitted", label: "Submitted", count: lists.submitted.length },
    { key: "missing", label: "Missing", count: lists.missing.length },
  ];

  const body = () => {
    if (tab === "stream") {
      if (!lists.stream.length) return <EmptyState icon="folder-open-outline" title="Nothing here yet" text="Your teacher has not posted anything." />;
      return lists.stream.map((x: any) => (x._t === "n" ? announcementCard(x) : assignmentCard(x)));
    }
    if (tab === "assigned") {
      if (!lists.assigned.length) return <EmptyState icon="checkmark-circle-outline" title="All caught up" text="No pending assignments." />;
      return grouped(lists.assigned);
    }
    if (tab === "submitted") {
      if (!lists.submitted.length) return <EmptyState icon="cloud-upload-outline" title="No submissions yet" text="Work you turn in appears here." />;
      return grouped(lists.submitted);
    }
    if (!lists.missing.length) return <EmptyState icon="ribbon-outline" title="Nothing missing" text="You have not missed any assignment." />;
    return grouped(lists.missing, true);
  };

  return (
    <Screen>
      <Header title={subject.subject_name} subtitle={course.course_name} onBack={() => navigation.goBack()} />

      <View style={{ flexDirection: "row", gap: SP.xs, padding: SP.md, backgroundColor: T.surface, borderBottomWidth: 1, borderBottomColor: T.line }}>
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                paddingVertical: 9,
                borderRadius: R.pill,
                backgroundColor: on ? T.primary : T.lineSoft,
              }}
            >
              <Text style={{ fontSize: 12.5, fontWeight: "700", color: on ? "#fff" : T.sub }}>{t.label}</Text>
              {!!t.count && (
                <View style={{ minWidth: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: on ? "rgba(255,255,255,0.25)" : T.line, alignItems: "center" }}>
                  <Text style={{ fontSize: 10.5, fontWeight: "800", color: on ? "#fff" : T.sub }}>{t.count}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} colors={[T.primary]} tintColor={T.primary} />}
      >
        {loading ? (
          <View style={{ paddingTop: 80, alignItems: "center" }}>
            <ActivityIndicator size="large" color={T.primary} />
          </View>
        ) : !loadedOnce.current && error ? (
          <View>
            <EmptyState icon="cloud-offline-outline" title="Could not load" text={error} />
            <Button label="Try again" icon="refresh" variant="secondary" onPress={() => load()} />
          </View>
        ) : (
          <>
            {!!error && (
              <Banner tone="warning" title="Showing the last loaded data" style={{ marginBottom: SP.md }}>
                {error}
              </Banner>
            )}
            <TagFilter tags={tags} items={[...allAssignments, ...allAnnouncements]} value={tagSel} onChange={setTagSel} />
            <KindFilter value={kindFilter} onChange={setKindFilter} items={allAssignments} />
            {body()}
          </>
        )}
      </ScrollView>

      <AnnouncementSheet item={open} tagName={tagNameOf(tags, open?.tag_id)} onClose={() => setOpen(null)} />
    </Screen>
  );
}