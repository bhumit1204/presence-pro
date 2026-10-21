// Inbox section: special sessions that want one of my lecture slots (approve / reject with an optional reason),
// plus the outcomes for people who can edit the timetable (rejections with the reason, approvals).
import React, { useCallback, useEffect, useImperativeHandle, forwardRef, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { Button, Card, Chip, SP, T, font } from "../../../components/ui";
import { enc, getJson, postJson, useTeacher } from "../teacherShared";

type Req = {
  override_id: string; date: string; day: string; note: string; requested_by: string; status: string;
  my_status: "pending" | "approved" | "rejected";
  session: { title: string; teacher_name: string; start_time: string; end_time: string; room: string; division_name: string };
  replaces: { subject_name: string; start_time: string; end_time: string; batch?: string }[];
};
type Notice = { override_id: string; outcome: "rejected" | "approved"; date: string; title: string; start_time?: string; end_time?: string; by: string; reason: string };

const pretty = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

const SessionRequests = forwardRef<{ refresh: () => Promise<void> }, { onCount?: (n: number) => void }>(function SessionRequests({ onCount }, ref) {
  const teacher = useTeacher();
  const [reqs, setReqs] = useState<Req[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [busy, setBusy] = useState("");
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    if (!teacher.uid) return;
    try {
      const j = await getJson(`/api/web/teacher/session-requests?uid=${enc(teacher.uid)}`);
      const pending = (j.requests || []).filter((r: Req) => r.my_status === "pending" && r.status === "awaiting_approval");
      setReqs(pending); setNotices(j.notices || []);
      onCount?.(pending.length + (j.notices || []).length);
    } catch { /* the rest of the inbox still works */ }
  }, [teacher.uid, onCount]);
  useEffect(() => { load(); }, [load]);
  useImperativeHandle(ref, () => ({ refresh: load }), [load]);

  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      await postJson(`/api/web/teacher/session-requests/${id}/decide`, { uid: teacher.uid, approve, reason: approve ? undefined : reason.trim() || undefined });
      setRejecting(null); setReason(""); await load();
    } catch (e: any) { Alert.alert("Could not save", e?.message || "Try again"); await load(); }
    finally { setBusy(""); }
  };
  const dismiss = async (id: string) => {
    setNotices((n) => n.filter((x) => x.override_id !== id));
    try { await postJson(`/api/web/teacher/session-requests/${id}/ack`, { uid: teacher.uid }); } catch { /* reappears on refresh */ }
    load();
  };

  if (!reqs.length && !notices.length) return null;

  return (
    <>
      {notices.map((n) => (
        <Card key={n.override_id} flat>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={[font.h3, { flex: 1 }]} numberOfLines={2}>{n.title}</Text>
            <Chip label={n.outcome === "rejected" ? "Rejected" : "Approved"} tone={n.outcome === "rejected" ? "danger" : "success"} />
          </View>
          <Text style={[font.small, { marginTop: 2 }]}>
            {pretty(n.date)}{n.start_time ? ` · ${n.start_time} – ${n.end_time}` : ""}
          </Text>
          <Text style={[font.body, { marginTop: SP.xs }]}>
            {n.outcome === "rejected"
              ? `${n.by || "The teacher"} rejected this special session.${n.reason ? ` Reason: ${n.reason}` : " No reason given."}`
              : "Approved and now in the timetable."}
          </Text>
          <Pressable onPress={() => dismiss(n.override_id)} style={{ alignSelf: "flex-start", marginTop: SP.sm }} hitSlop={8}>
            <Text style={[font.h3, { color: T.primary }]}>Dismiss</Text>
          </Pressable>
        </Card>
      ))}

      {reqs.map((r) => (
        <Card key={r.override_id}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={[font.h3, { flex: 1 }]} numberOfLines={2}>{r.session.title}</Text>
            <Chip label="Special session" tone="info" />
          </View>
          <Text style={[font.small, { marginTop: 2 }]}>
            {pretty(r.date)} · {r.session.start_time} – {r.session.end_time}{r.session.room ? ` · ${r.session.room}` : ""}
          </Text>
          {!!r.session.teacher_name && <Text style={font.small}>With {r.session.teacher_name}{r.session.division_name ? ` · Div ${r.session.division_name}` : ""}</Text>}
          <View style={{ marginTop: SP.sm, padding: SP.sm, borderRadius: 10, backgroundColor: T.surface }}>
            <Text style={font.label}>Takes over your lecture</Text>
            {r.replaces.map((l, i) => (
              <Text key={i} style={font.body}>{l.subject_name}{l.batch ? ` (${l.batch})` : ""} · {l.start_time} – {l.end_time}</Text>
            ))}
          </View>
          {!!r.requested_by && <Text style={[font.small, { marginTop: SP.sm }]}>Requested by {r.requested_by}. Only this date changes.</Text>}
          {!!r.note && <Text style={[font.small, { marginTop: 2 }]}>{r.note}</Text>}

          {rejecting !== r.override_id ? (
            <View style={{ flexDirection: "row", gap: 10, marginTop: SP.md }}>
              <View style={{ flex: 1 }}>
                <Pressable onPress={() => { setRejecting(r.override_id); setReason(""); }} disabled={!!busy}
                  style={{ paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: T.line, alignItems: "center" }}>
                  <Text style={font.h3}>Reject</Text>
                </Pressable>
              </View>
              <View style={{ flex: 1 }}>
                <Button size="md" label={busy === r.override_id ? "Saving…" : "Approve"} onPress={() => decide(r.override_id, true)} disabled={!!busy} />
              </View>
            </View>
          ) : (
            <View style={{ marginTop: SP.md }}>
              <TextInput
                value={reason} onChangeText={setReason} placeholder="Reason (optional)" placeholderTextColor={T.muted}
                maxLength={300} multiline
                style={{ borderWidth: 1, borderColor: T.line, borderRadius: 10, padding: SP.sm, minHeight: 60, color: T.ink, textAlignVertical: "top" }}
              />
              <View style={{ flexDirection: "row", gap: 10, marginTop: SP.sm }}>
                <View style={{ flex: 1 }}>
                  <Pressable onPress={() => setRejecting(null)} disabled={!!busy}
                    style={{ paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: T.line, alignItems: "center" }}>
                    <Text style={font.h3}>Back</Text>
                  </Pressable>
                </View>
                <View style={{ flex: 1 }}>
                  <Button size="md" label={busy === r.override_id ? "Saving…" : "Confirm reject"} onPress={() => decide(r.override_id, false)} disabled={!!busy} />
                </View>
              </View>
            </View>
          )}
        </Card>
      ))}
    </>
  );
});

export default SessionRequests;