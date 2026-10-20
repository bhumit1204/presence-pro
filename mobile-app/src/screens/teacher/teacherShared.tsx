// src/screens/teacher/teacherShared.tsx
// Helpers shared by the teacher tabs and the screens they open: API wrappers, subject grouping,
// the teacher / inbox contexts, the day-by-day lecture list and the lecture request card.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE } from "../../services/api";
import { getUserSession } from "../../services/session";
import AssignLectureModal from "../../components/AssignLectureModal";
import CancelLectureModal from "../../components/CancelLectureModal";
import ExchangeLectureModal from "../../components/ExchangeLectureModal";
import { Banner, Button, Card, Chip, EmptyState, T, SP, font } from "../../components/ui";

/* ───────────────────────── api ───────────────────────── */

export async function getJson(path: string, init?: RequestInit): Promise<any> {
  const res = await apiFetch(`${API_BASE}${path}`, init);
  let json: any = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok || json?.success === false) throw new Error(json?.error || `Request failed (${res.status})`);
  return json ?? {};
}

export const postJson = (path: string, body: any) =>
  getJson(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const enc = encodeURIComponent;

/* ───────────────────────── dates ───────────────────────── */

export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const parseYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

export const hhmmToMin = (t?: string) => {
  const [h, m] = String(t || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

export const nowMin = () => {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
};

export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export const longDay = (d: Date) => d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

/* ───────────────────────── subjects ───────────────────────── */

export interface Subject {
  subject_id: string;
  subject_name: string;
  subject_code: string;
  course_id: string | null;
  course_name: string;
}

export interface Course {
  course_id: string;
  course_name: string;
  subjects: Subject[];
}

export function groupCourses(subjects: Subject[]): Course[] {
  const map: Record<string, Course> = {};
  subjects.forEach((s) => {
    const id = s.course_id || "none";
    if (!map[id]) map[id] = { course_id: s.course_id || "", course_name: s.course_name || "Unknown course", subjects: [] };
    map[id].subjects.push(s);
  });
  return Object.values(map);
}

/* ───────────────────────── contexts ───────────────────────── */

export interface TeacherInfo {
  uid: string;
  teacherId: string;
  name: string;
  firstName: string;
  profile: any;
}

export const TeacherCtx = createContext<TeacherInfo | null>(null);
export const useTeacher = () => useContext(TeacherCtx) as TeacherInfo;

export interface LectureRequest {
  assignment_id: string;
  requested_by: string;
  day: string;
  date: string;
  start_time: string;
  end_time: string;
  expires_at?: string;
  reason?: string;
}

export interface SwapItem {
  swap_id: string;
  date: string;
  day: string;
  status: string;
  reason: string;
  requester_name: string;
  partner_name: string;
  give: { subject: string; start_time: string; end_time: string };
  take: { subject: string; start_time: string; end_time: string };
  expires_at: string | null;
}
export interface SwapState {
  incoming: SwapItem[];
  sent: SwapItem[];
}

export interface InboxState {
  requests: LectureRequest[];
  sent: any[];
  swaps: SwapState;
  respondSwap: (id: string, action: "accept" | "reject" | "cancel") => Promise<string | null>;
  odPending: number;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  respond: (id: string, action: "accept" | "reject") => Promise<string | null>;
}

export const InboxCtx = createContext<InboxState | null>(null);
export const useInbox = () => useContext(InboxCtx) as InboxState;

/* ───────────────────────── lecture request card ───────────────────────── */

export function RequestCard({
  req,
  onRespond,
}: {
  req: LectureRequest;
  onRespond: (id: string, action: "accept" | "reject") => Promise<string | null>;
}) {
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const go = async (a: "accept" | "reject") => {
    setBusy(a);
    const err = await onRespond(req.assignment_id, a);
    setBusy(null);
    if (err) Alert.alert("Could not respond", err);
  };
  return (
    <Card flat>
      <Text style={font.h3}>{req.requested_by} asks you to cover</Text>
      <Text style={[font.body, { marginTop: 2 }]}>
        {req.day}, {req.date}  |  {req.start_time} - {req.end_time}
      </Text>
      {!!req.reason && (
        <View style={{ marginTop: SP.sm }}>
          <ExpandText text={`Reason: ${req.reason}`} />
        </View>
      )}
      <View style={{ flexDirection: "row", gap: SP.sm, marginTop: SP.lg }}>
        <Button label="Decline" variant="secondary" size="md" style={{ flex: 1 }} onPress={() => go("reject")} loading={busy === "reject"} disabled={!!busy} />
        <Button label="Accept" size="md" style={{ flex: 1 }} onPress={() => go("accept")} loading={busy === "accept"} disabled={!!busy} />
      </View>
    </Card>
  );
}

/* ───────────────────────── lecture exchange request card ───────────────────────── */

export function SwapRequestCard({ swap, onRespond }: { swap: SwapItem; onRespond: (id: string, action: "accept" | "reject") => Promise<string | null> }) {
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const go = async (a: "accept" | "reject") => {
    setBusy(a);
    const err = await onRespond(swap.swap_id, a);
    setBusy(null);
    if (err) Alert.alert("Could not respond", err);
  };
  const line = (label: string, x: { subject: string; start_time: string; end_time: string }) => (
    <View style={{ flexDirection: "row", gap: SP.sm, marginTop: 4 }}>
      <Text style={[font.small, { width: 62 }]}>{label}</Text>
      <Text style={[font.body, { flex: 1 }]}>
        {x.subject}  |  {x.start_time} - {x.end_time}
      </Text>
    </View>
  );
  return (
    <Card flat>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Ionicons name="swap-horizontal" size={18} color={T.primary} />
        <Text style={[font.h3, { flex: 1 }]}>{swap.requester_name} asks to exchange</Text>
      </View>
      <Text style={[font.small, { marginTop: 2 }]}>
        {swap.day}, {swap.date}
      </Text>
      {line("You take", swap.give)}
      {line("You give", swap.take)}
      {!!swap.reason && (
        <View style={{ marginTop: SP.sm }}>
          <ExpandText text={`Reason: ${swap.reason}`} />
        </View>
      )}
      <View style={{ flexDirection: "row", gap: SP.sm, marginTop: SP.lg }}>
        <Button label="Decline" variant="secondary" size="md" style={{ flex: 1 }} onPress={() => go("reject")} loading={busy === "reject"} disabled={!!busy} />
        <Button label="Accept" size="md" style={{ flex: 1 }} onPress={() => go("accept")} loading={busy === "accept"} disabled={!!busy} />
      </View>
    </Card>
  );
}

/* ───────────────────────── one day of lectures ───────────────────────── */

export function DayLectures({ date, refreshKey = 0, onChanged }: { date: string; refreshKey?: number; onChanged?: () => void }) {
  const [lectures, setLectures] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<any>(null);
  const [cancelling, setCancelling] = useState(false);
  const [assignFor, setAssignFor] = useState<any>(null);
  const [swapFor, setSwapFor] = useState<any>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const my = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const session = await getUserSession();
      if (!session?.uid) throw new Error("You are signed out. Please log in again.");
      const j = await getJson(`/api/lectures/today?uid=${enc(session.uid)}&date=${enc(date)}`);
      if (my === reqId.current) setLectures([...(j.lectures || [])].sort((a: any, b: any) => hhmmToMin(a.start_time) - hhmmToMin(b.start_time) || hhmmToMin(a.end_time) - hhmmToMin(b.end_time)));
    } catch (e: any) {
      if (my === reqId.current) setError(e?.message || "Could not load lectures.");
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const doCancel = async () => {
    if (!cancelFor) return;
    setCancelling(true);
    try {
      const session = await getUserSession();
      await postJson("/api/lectures/cancel", { lecture_id: cancelFor.id, teacher_uid: session.uid, date });
      setLectures((p) => p.filter((l) => l.id !== cancelFor.id));
      setCancelFor(null);
      onChanged?.();
    } catch (e: any) {
      Alert.alert("Could not cancel", e?.message || "Please try again.");
    } finally {
      setCancelling(false);
    }
  };

  const isToday = date === ymd(new Date());
  const clock = nowMin();

  return (
    <View>
      {loading && lectures.length === 0 ? (
        <ActivityIndicator color={T.primary} style={{ marginVertical: SP.xxl }} />
      ) : error ? (
        <View style={{ gap: SP.sm }}>
          <Banner tone="danger">{error}</Banner>
          <Button label="Try again" variant="secondary" size="md" icon="refresh" onPress={load} />
        </View>
      ) : lectures.length === 0 ? (
        <EmptyState icon="cafe-outline" title="No lectures" />
      ) : (
        <View style={{ gap: SP.md }}>
          {lectures.map((l, i) => {
            const done = isToday && hhmmToMin(l.end_time) <= clock;
            const running = isToday && hhmmToMin(l.start_time) <= clock && clock < hhmmToMin(l.end_time);
            return (
              <View key={l.id ?? i} style={{ flexDirection: "row", gap: SP.md }}>
                <View style={{ width: 48, alignItems: "flex-end", paddingTop: 14 }}>
                  <Text style={{ fontSize: 13, fontWeight: "800", color: done ? T.muted : T.ink }}>{l.start_time}</Text>
                  <Text style={font.small}>{l.end_time}</Text>
                </View>
                <View style={{ flex: 1, opacity: done ? 0.55 : 1, backgroundColor: T.surface, borderRadius: 16, borderWidth: 1, borderColor: T.line, padding: SP.md + 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {running && <Chip label="In progress" tone="success" />}
                    {l.is_assigned && <Chip label="Request sent" tone="info" icon="swap-horizontal" />}
                    {l.swap_pending && <Chip label="Exchange requested" tone="info" icon="swap-horizontal" />}
                    {l.swapped_out && <Chip label={`Exchanged with ${l.swap_with || "teacher"}`} tone="neutral" icon="swap-horizontal" />}
                    {l.swap_covering && <Chip label={`Exchange with ${l.swap_with || "teacher"}`} tone="info" icon="swap-horizontal" />}
                    {l.is_temporary && !l.swap_covering && <Chip label="Covering" tone="info" />}
                  </View>
                  <Text style={[font.h3, { marginTop: 2 }]} numberOfLines={2}>
                    {l.subject_name}
                  </Text>
                  <Text style={font.small}>
                    {[l.course_abbr, l.division_name ? `Div ${l.division_name}` : null, l.room ? `Room ${l.room}` : null].filter(Boolean).join("  |  ") || "Course"}
                  </Text>
                  {!done && !l.is_assigned && !l.is_temporary && !l.swap_pending && !l.swapped_out && (
                    <View style={{ flexDirection: "row", gap: SP.lg, marginTop: SP.sm }}>
                      <Pressable onPress={() => setCancelFor(l)} hitSlop={8} accessibilityRole="button">
                        <Text style={{ color: T.primary, fontWeight: "700", fontSize: 13 }}>Can't take it?</Text>
                      </Pressable>
                      <Pressable onPress={() => setSwapFor(l)} hitSlop={8} accessibilityRole="button">
                        <Text style={{ color: T.primary, fontWeight: "700", fontSize: 13 }}>Exchange</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      <CancelLectureModal
        visible={!!cancelFor}
        lecture={cancelFor}
        busy={cancelling}
        onClose={() => setCancelFor(null)}
        onCancelLecture={() =>
          Alert.alert("Cancel this lecture?", cancelFor ? `${cancelFor.subject_name}, ${cancelFor.start_time} - ${cancelFor.end_time}` : undefined, [
            { text: "No", style: "cancel" },
            { text: "Yes, cancel", style: "destructive", onPress: doCancel },
          ])
        }
        onAssign={() => {
          setAssignFor(cancelFor);
          setCancelFor(null);
        }}
      />
      <ExchangeLectureModal
        visible={!!swapFor}
        lecture={swapFor}
        selectedDate={date}
        onClose={() => setSwapFor(null)}
        onSuccess={() => {
          setLectures((p) => p.map((l) => (l.id === swapFor?.id ? { ...l, swap_pending: true } : l)));
          onChanged?.();
        }}
      />
      <AssignLectureModal
        visible={!!assignFor}
        lecture={assignFor}
        selectedDate={date}
        onClose={() => setAssignFor(null)}
        onSuccess={() => {
          setLectures((p) => p.map((l) => (l.id === assignFor?.id ? { ...l, is_assigned: true } : l)));
          onChanged?.();
        }}
      />
    </View>
  );
}

/* ───────────────────────── small bits ───────────────────────── */

export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useMemoSubjects(subjects: Subject[]) {
  return useMemo(() => groupCourses(subjects), [subjects]);
}

/* ───────────────────────── calm building blocks ───────────────────────── */

/** One bordered card whose rows are separated by hairlines. Keeps long lists quiet. */
export function ListCard({ children }: { children: React.ReactNode }) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <Card flat padded={false}>
      {rows.map((r, i) => (
        <View key={i} style={i > 0 ? { borderTopWidth: 1, borderTopColor: T.lineSoft } : undefined}>
          {r}
        </View>
      ))}
    </Card>
  );
}

type IconName = React.ComponentProps<typeof Ionicons>["name"];

export function ListRow({
  icon,
  tone = "primary",
  title,
  sub,
  right,
  onPress,
}: {
  icon?: IconName;
  tone?: "primary" | "success" | "warning" | "danger" | "info" | "neutral";
  title: string;
  sub?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  const colors = {
    primary: [T.primarySoft, T.primary],
    success: [T.successSoft, T.success],
    warning: [T.warningSoft, T.warning],
    danger: [T.dangerSoft, T.danger],
    info: [T.infoSoft, T.info],
    neutral: [T.lineSoft, T.sub],
  }[tone];
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={sub ? `${title}. ${sub}` : title}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: SP.md, paddingHorizontal: SP.lg, paddingVertical: 14 }, pressed && { backgroundColor: T.lineSoft }]}
    >
      {!!icon && (
        <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: colors[0], alignItems: "center", justifyContent: "center" }}>
          <Ionicons name={icon} size={19} color={colors[1]} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={font.h3} numberOfLines={2}>{title}</Text>
        {!!sub && <Text style={[font.small, { marginTop: 1 }]} numberOfLines={2}>{sub}</Text>}
      </View>
      {right}
      {!!onPress && <Ionicons name="chevron-forward" size={17} color={T.muted} />}
    </Pressable>
  );
}

/** Long text that folds to a few lines. Tap "Show more" to read all of it, "Show less" to fold it again. */
export function ExpandText({ text, lines = 3, threshold = 120 }: { text: string; lines?: number; threshold?: number }) {
  const [open, setOpen] = useState(false);
  const long = (text || "").length > threshold || (text || "").split("\n").length > lines;
  return (
    <View>
      <Text style={font.body} numberOfLines={open || !long ? undefined : lines} selectable={open}>
        {text}
      </Text>
      {long && (
        <Pressable onPress={() => setOpen((o) => !o)} hitSlop={8} accessibilityRole="button" accessibilityLabel={open ? "Show less" : "Show more"} style={{ flexDirection: "row", alignItems: "center", gap: 3, marginTop: 4, alignSelf: "flex-start" }}>
          <Text style={{ color: T.primary, fontWeight: "700", fontSize: 13 }}>{open ? "Show less" : "Show more"}</Text>
          <Ionicons name={open ? "chevron-up" : "chevron-down"} size={14} color={T.primary} />
        </Pressable>
      )}
    </View>
  );
}