import React, { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, View } from "react-native";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { Banner, Button, EmptyState, Header, SP, Screen, T, Tone } from "../../../components/ui";
import { ItemCard, api, fmtDateTime, fmtDay, isPastDue, isPinActive, ts } from "../WorkShared";

export default function TeacherSubjectFeed() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, course, teacher_id } = route.params ?? {};

  const [assignments, setAssignments] = useState<any[]>([]);
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedOnce = useRef(false);

  const load = useCallback(
    async (silent = false) => {
      if (!subject?.subject_id || !course?.course_id) return;
      try {
        if (!silent && !loadedOnce.current) setLoading(true);
        const q = `subject_id=${encodeURIComponent(subject.subject_id)}&course_id=${encodeURIComponent(course.course_id)}`;
        const [a, n] = await Promise.all([
          api<{ assignments: any[] }>(`/api/assignments?${q}`),
          api<{ announcements: any[] }>(`/api/assignments/announcements?${q}`),
        ]);
        setAssignments(a.assignments || []);
        setAnnouncements(n.announcements || []);
        setError(null);
        loadedOnce.current = true;
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [subject?.subject_id, course?.course_id]
  );
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const feed = useMemo(() => {
    const all = [
      ...assignments.map((x) => ({ ...x, _t: "a" as const })),
      ...announcements.map((x) => ({ ...x, _t: "n" as const })),
    ];
    return all.sort((x, y) => {
      const xp = x._t === "n" && isPinActive(x);
      const yp = y._t === "n" && isPinActive(y);
      if (xp !== yp) return xp ? -1 : 1;
      return ts(y.created_at) - ts(x.created_at);
    });
  }, [assignments, announcements]);

  if (!subject || !course) {
    return (
      <Screen>
        <Header title="Classwork" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Subject not available" text="Go back and choose the subject again." />
      </Screen>
    );
  }

  const go = (screen: string) => navigation.navigate(screen, { subject, course, teacher_id });

  return (
    <Screen>
      <Header title={subject.subject_name} subtitle={course.course_name} onBack={() => navigation.goBack()} />

      <ScrollView
        contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xl }}
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
            {feed.length === 0 ? (
              <EmptyState icon="folder-open-outline" title="Nothing posted yet" text="Post an assignment or an announcement with the buttons below." />
            ) : (
              feed.map((item) => {
                if (item._t === "n") {
                  const pinned = isPinActive(item);
                  const files = item.attachments?.length ?? 0;
                  return (
                    <ItemCard
                      key={`n-${item.announcement_id}`}
                      icon={pinned ? "pin" : "megaphone-outline"}
                      title={item.title}
                      line={item.text}
                      meta={fmtDay(item.created_at)}
                      pinned={pinned}
                      chips={[
                        ...(pinned ? [{ label: "Pinned", tone: "primary" as Tone }] : []),
                        ...(files > 0 ? [{ label: `${files} file${files > 1 ? "s" : ""}` }] : []),
                      ]}
                      onPress={() => navigation.navigate("AnnouncementDetail", { announcement: item, teacher_id })}
                    />
                  );
                }
                const overdue = isPastDue(item.due_date);
                const chips: { label: string; tone?: Tone }[] = [{ label: `${item.marks} marks`, tone: "primary" }];
                if (item.submissions_count > 0) chips.push({ label: `${item.submissions_count} turned in`, tone: "success" });
                if (item.allow_late) chips.push({ label: "Late allowed", tone: "warning" });
                return (
                  <ItemCard
                    key={`a-${item.assignment_id}`}
                    icon="document-text-outline"
                    tone={overdue ? "danger" : "success"}
                    title={item.title}
                    meta={`${overdue ? "Was due" : "Due"} ${fmtDateTime(item.due_date)}`}
                    chips={chips}
                    onPress={() => navigation.navigate("TeacherAssignmentDetail", { assignment: item, teacher_id, subject, course })}
                  />
                );
              })
            )}
          </>
        )}
      </ScrollView>

      <View style={{ flexDirection: "row", gap: SP.md, padding: SP.md, backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.line }}>
        <Button label="Announcement" icon="megaphone-outline" variant="secondary" size="md" onPress={() => go("CreateAnnouncement")} style={{ flex: 1 }} />
        <Button label="Assignment" icon="add" size="md" onPress={() => go("CreateAssignment")} style={{ flex: 1 }} />
      </View>
    </Screen>
  );
}