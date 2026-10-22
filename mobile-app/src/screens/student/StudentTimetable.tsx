import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE } from "../../services/api";
import { getUserSession } from "../../services/session";
import { Banner, Card, Chip, Screen, SP, T, font } from "../../components/ui";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type Lec = {
  lecture_id: string; subject_name: string; subject_code?: string; kind?: string; kind_label?: string;
  batch?: string; teacher_name?: string; division_name?: string; elective?: boolean; elective_group?: string;
  day: string; start_time: string; end_time: string; room?: string;
};
type Change = {
  date: string; weekday?: string; kind: "modify" | "cancel" | "special";
  subject_name: string; kind_label?: string; batch?: string; start_time?: string; end_time?: string;
  room?: string; teacher_name?: string; note?: string;
  was?: { start_time?: string; end_time?: string; room?: string; teacher_name?: string };
};

const pretty = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
};
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const toMin = (t?: string) => { const [h, m] = (t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };

export default function StudentTimetable() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [day, setDay] = useState(DAYS[(new Date().getDay() + 6) % 7]);
  const todayName = DAYS[(new Date().getDay() + 6) % 7];

  const load = useCallback(async () => {
    try {
      const s = await getUserSession();
      if (!s?.uid) return;
      const res = await apiFetch(`${API_BASE}/api/web/student/timetable?uid=${s.uid}`);
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || "Could not load timetable");
      setData(j); setError("");
    } catch (e: any) {
      setError(e?.message || "Could not load timetable");
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) return <Screen edges={["top"]}><View style={styles.center}><ActivityIndicator size="large" color={T.primary} /></View></Screen>;

  const st = data?.student;
  const list: Lec[] = (data?.days?.[day] || []) as Lec[];
  const changes: Change[] = data?.changes || [];

  return (
    <Screen edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        <Text style={font.display}>Timetable</Text>
        {st && (
          <Text style={[font.body, { marginTop: 2 }]}>
            {st.course_abbr || st.course_name} · Sem {st.semester}{st.division_name ? ` · Div ${st.division_name}` : ""}
          </Text>
        )}

        {!!error && <View style={{ marginTop: SP.md }}><Banner tone="danger" icon="alert-circle-outline" title={error} /></View>}
        {st && !st.division_id && (
          <View style={{ marginTop: SP.md }}>
            <Banner tone="warning" icon="information-circle-outline" title="No division set">
              <Text style={font.small}>Only lectures common to all divisions are shown.</Text>
            </Banner>
          </View>
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: SP.md }} contentContainerStyle={{ gap: 8 }}>
          {DAYS.map((d) => {
            const on = d === day;
            const n = (data?.days?.[d] || []).length;
            return (
              <TouchableOpacity key={d} onPress={() => setDay(d)} activeOpacity={0.8}
                style={[styles.dayChip, on && { backgroundColor: T.primarySoft, borderColor: T.primary }]}>
                <Text style={[styles.dayText, on && { color: T.primary }]}>{d.slice(0, 3)}</Text>
                <Text style={[font.small, on && { color: T.primary }]}>{n}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={{ marginTop: SP.md, gap: SP.sm }}>
          {list.length === 0 ? (
            <Card>
              <View style={{ alignItems: "center", paddingVertical: SP.md }}>
                <Ionicons name="cafe-outline" size={30} color={T.muted} />
                <Text style={[font.body, { marginTop: SP.sm }]}>No lectures on {day}</Text>
              </View>
            </Card>
          ) : list.map((l) => {
            const live = day === todayName && nowMin() >= toMin(l.start_time) && nowMin() < toMin(l.end_time);
            return (
              <Card key={l.lecture_id} style={live ? { borderColor: T.primary, borderWidth: 1.5 } : undefined}>
                <View style={styles.row}>
                  <Text style={[font.h3, { flex: 1 }]} numberOfLines={2}>{l.subject_name}</Text>
                  {live && <Chip label="Now" tone="success" />}
                </View>
                <View style={[styles.row, { marginTop: 4 }]}>
                  <Ionicons name="time-outline" size={14} color={T.primary} />
                  <Text style={font.small}>{l.start_time} – {l.end_time}</Text>
                  {!!l.room && (<><Text style={font.small}>·</Text><Ionicons name="location-outline" size={14} color={T.muted} /><Text style={font.small}>{l.room}</Text></>)}
                </View>
                {!!l.teacher_name && <Text style={[font.small, { marginTop: 2 }]}>{l.teacher_name}</Text>}
                {(!!l.kind_label || !!l.batch || l.elective) && (
                  <View style={[styles.row, { marginTop: SP.sm, flexWrap: "wrap" }]}>
                    {!!l.kind_label && <Chip label={l.kind_label} tone="info" />}
                    {!!l.batch && <Chip label={`Batch ${l.batch}`} tone="primary" />}
                    {l.elective && <Chip label={l.elective_group ? `Elective: ${l.elective_group}` : "Elective"} tone="warning" />}
                  </View>
                )}
              </Card>
            );
          })}
        </View>

        <Text style={[font.h1, { marginTop: SP.xl }]}>Upcoming changes</Text>
        <Text style={[font.small, { marginTop: 2 }]}>One-day changes in the next two weeks</Text>
        <View style={{ marginTop: SP.md, gap: SP.sm }}>
          {changes.length === 0 ? (
            <Card><Text style={font.body}>No changes planned.</Text></Card>
          ) : changes.map((c, i) => (
            <Card key={i}>
              <View style={styles.row}>
                <Text style={[font.h3, { flex: 1 }]} numberOfLines={2}>{c.subject_name}</Text>
                <Chip label={c.kind === "cancel" ? "Cancelled" : c.kind === "special" ? "Extra" : "Changed"}
                  tone={c.kind === "cancel" ? "danger" : c.kind === "special" ? "info" : "warning"} />
              </View>
              <Text style={[font.small, { marginTop: 2 }]}>
                {pretty(c.date)}{c.start_time ? ` · ${c.start_time} – ${c.end_time}` : ""}{c.room ? ` · ${c.room}` : ""}
              </Text>
              {c.kind === "modify" && c.was && c.was.room && c.room && c.was.room !== c.room && (
                <Text style={[font.small, { marginTop: 2 }]}>Room {c.was.room} → {c.room}</Text>
              )}
              {c.kind === "modify" && c.was && c.was.start_time && c.start_time && c.was.start_time !== c.start_time && (
                <Text style={[font.small, { marginTop: 2 }]}>Was {c.was.start_time} – {c.was.end_time}</Text>
              )}
              {!!c.note && <Text style={[font.small, { marginTop: 2 }]}>{c.note}</Text>}
            </Card>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  content: { padding: SP.lg, paddingBottom: SP.xl * 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  dayChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12, backgroundColor: T.surface, borderWidth: 1, borderColor: "transparent", alignItems: "center" },
  dayText: { fontWeight: "700", color: T.muted },
});