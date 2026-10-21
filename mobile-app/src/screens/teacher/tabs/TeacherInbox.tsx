// src/screens/teacher/tabs/TeacherInbox.tsx
// Two clearly separate things:
//   Requests   - waiting for you (lecture swap requests, OD requests)
//   Broadcasts - quick messages YOU sent to students' phones
import React, { useCallback, useRef, useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useOnTabActive } from "../../../navigation/TabContext";
import { Banner, Button, Card, Chip, EmptyState, T, SP, font } from "../../../components/ui";
import SessionRequests from "./SessionRequests";
import { ExpandText, ListCard, ListRow, RequestCard, SwapRequestCard, enc, getJson, useInbox, useTeacher } from "../teacherShared";

export default function TeacherInbox() {
  const navigation = useNavigation<any>();
  const teacher = useTeacher();
  const inbox = useInbox();
  const [broadcasts, setBroadcasts] = useState<any[]>([]);
  const [bError, setBError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const sessions = useRef<{ refresh: () => Promise<void> }>(null);
  const [sessionCount, setSessionCount] = useState(0);

  const loadBroadcasts = useCallback(async () => {
    try {
      const j = await getJson(`/api/broadcasts?teacher_id=${enc(teacher.teacherId)}`);
      setBroadcasts(j.broadcasts || []);
      setBError(null);
    } catch (e: any) {
      setBError(e?.message || "Could not load broadcasts.");
    }
  }, [teacher.teacherId]);

  useOnTabActive("inbox", () => {
    inbox.refresh();
    loadBroadcasts();
    sessions.current?.refresh();
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([inbox.refresh(), loadBroadcasts(), sessions.current?.refresh()]);
    setRefreshing(false);
  };

  const target = (b: any) => (b.target_type === "class" ? "Whole class" : b.target_type === "group" ? "A group" : "Chosen students");
  const sentSwaps = inbox.swaps.sent.filter((x) => x.status === "pending");
  const waiting = inbox.requests.length + inbox.sent.length + inbox.swaps.incoming.length + sentSwaps.length + sessionCount;
  const cancelSwap = (id: string) =>
    Alert.alert("Cancel this exchange request?", undefined, [
      { text: "No", style: "cancel" },
      {
        text: "Cancel request",
        style: "destructive",
        onPress: async () => {
          const err = await inbox.respondSwap(id, "cancel");
          if (err) Alert.alert("Could not cancel", err);
        },
      },
    ]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: T.bg }}
      contentContainerStyle={{ paddingHorizontal: SP.xl, paddingTop: SP.xxl + 24, paddingBottom: 140 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.primary} />}
    >
      <Text style={font.h1}>Inbox</Text>
      <View style={{ height: SP.xl }} />

      {!!inbox.error && <Banner tone="warning" style={{ marginBottom: SP.lg }}>{inbox.error}</Banner>}

      {/* requests */}
      <Text style={[font.h3, { marginBottom: SP.md }]}>Requests</Text>
      <View style={{ gap: SP.md, marginBottom: SP.xxl }}>
        {inbox.requests.map((r) => (
          <RequestCard key={r.assignment_id} req={r} onRespond={inbox.respond} />
        ))}
        {inbox.swaps.incoming.map((x) => (
          <SwapRequestCard key={x.swap_id} swap={x} onRespond={inbox.respondSwap} />
        ))}
        <SessionRequests ref={sessions} onCount={setSessionCount} />
        <ListCard>
          <ListRow
            icon="document-text-outline"
            tone="warning"
            title="OD requests"
            sub={inbox.odPending > 0 ? `${inbox.odPending} pending` : "None pending"}
            onPress={() => navigation.navigate("ODRequestsTeacher", { teacherId: teacher.teacherId })}
            right={inbox.odPending > 0 ? <Chip label={`${inbox.odPending}`} tone="warning" /> : undefined}
          />
          {sentSwaps.map((x) => (
            <ListRow
              key={x.swap_id}
              icon="swap-horizontal"
              tone="info"
              title={`Exchange awaiting ${x.partner_name}`}
              sub={`${x.date}  |  your ${x.give.start_time} for their ${x.take.start_time}`}
              onPress={() => cancelSwap(x.swap_id)}
            />
          ))}
          {inbox.sent.map((s) => (
            <ListRow
              key={s.assignment_id}
              icon="paper-plane-outline"
              tone="info"
              title="Awaiting reply"
              sub={`${s.day}, ${s.date}  |  ${s.start_time} - ${s.end_time}`}
            />
          ))}
        </ListCard>
        {waiting === 0 && <Text style={font.small}>No lecture requests</Text>}
      </View>

      {/* broadcasts */}
      <Text style={[font.h3, { marginBottom: SP.md }]}>Broadcasts</Text>
      <Button label="New broadcast" icon="megaphone-outline" variant="secondary" onPress={() => navigation.navigate("CreateBroadcast")} style={{ marginBottom: SP.lg }} />
      {bError ? (
        <Banner tone="danger">{bError}</Banner>
      ) : broadcasts.length === 0 ? (
        <EmptyState icon="megaphone-outline" title="No broadcasts yet" />
      ) : (
        <View style={{ gap: SP.md }}>
          {broadcasts.map((b) => (
            <Card flat key={b.broadcast_id}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SP.sm }}>
                <Text style={[font.h3, { flex: 1 }]}>{b.title}</Text>
                {b.is_urgent && <Chip label="Urgent" tone="danger" />}
              </View>
              <Text style={[font.small, { marginTop: 2, marginBottom: SP.sm }]}>
                {target(b)}
                {typeof b.recipient_count === "number" ? `  |  ${b.recipient_count}` : ""}
                {b.created_at ? `  |  ${new Date(b.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}
              </Text>
              <ExpandText text={b.text || ""} />
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}