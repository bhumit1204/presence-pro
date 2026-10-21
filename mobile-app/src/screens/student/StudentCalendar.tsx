import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE } from "../../services/api";
import { getUserSession } from "../../services/session";
import { Banner, Card, Screen, SP, T, font } from "../../components/ui";

type Ev = { event_id: string; title: string; event_type: string; start_date: string; end_date?: string; description?: string; scope?: string };

const TYPE: Record<string, { label: string; color: string }> = {
  holiday: { label: "Holiday", color: "#EF4444" },
  exam: { label: "Exam", color: "#F59E0B" },
  event: { label: "Event", color: "#3B82F6" },
  working_day_swap: { label: "Working day swap", color: "#8B5CF6" },
  general: { label: "General", color: "#6B7280" },
};
const typeOf = (t: string) => TYPE[t] || TYPE.general;
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const WK = ["M", "T", "W", "T", "F", "S", "S"];

export default function StudentCalendar() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [today, setToday] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [sel, setSel] = useState<string>(today);

  const load = useCallback(async () => {
    try {
      const s = await getUserSession();
      if (!s?.uid) return;
      const res = await apiFetch(`${API_BASE}/api/web/student/calendar?uid=${s.uid}`);
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || "Could not load calendar");
      setEvents(j.events || []); if (j.today) { setToday(j.today); setSel(j.today); } setError("");
    } catch (e: any) { setError(e?.message || "Could not load calendar"); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const on = (d: string) => events.filter((e) => e.start_date <= d && d <= (e.end_date || e.start_date));

  const cells = useMemo(() => {
    const first = new Date(ym.y, ym.m, 1);
    const lead = (first.getDay() + 6) % 7;
    const dim = new Date(ym.y, ym.m + 1, 0).getDate();
    const out: (number | null)[] = Array(lead).fill(null);
    for (let d = 1; d <= dim; d++) out.push(d);
    while (out.length % 7) out.push(null);
    return out;
  }, [ym]);

  const shift = (n: number) => setYm(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const upcoming = events.filter((e) => (e.end_date || e.start_date) >= today).sort((a, b) => a.start_date.localeCompare(b.start_date)).slice(0, 6);
  const picked = on(sel);

  if (loading) return <Screen edges={["top"]}><View style={styles.center}><ActivityIndicator size="large" color={T.primary} /></View></Screen>;

  return (
    <Screen edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
        <Text style={font.display}>Academic calendar</Text>
        {!!error && <View style={{ marginTop: SP.md }}><Banner tone="danger" icon="alert-circle-outline" title={error} /></View>}

        <Card style={{ marginTop: SP.md }}>
          <View style={styles.nav}>
            <TouchableOpacity onPress={() => shift(-1)} hitSlop={10}><Ionicons name="chevron-back" size={22} color={T.primary} /></TouchableOpacity>
            <Text style={font.h3}>{new Date(ym.y, ym.m, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</Text>
            <TouchableOpacity onPress={() => shift(1)} hitSlop={10}><Ionicons name="chevron-forward" size={22} color={T.primary} /></TouchableOpacity>
          </View>
          <View style={styles.grid}>
            {WK.map((w, i) => <Text key={i} style={[styles.wk, font.small]}>{w}</Text>)}
            {cells.map((d, i) => {
              if (!d) return <View key={i} style={styles.cell} />;
              const key = iso(ym.y, ym.m, d);
              const evs = on(key);
              const isSel = key === sel, isToday = key === today;
              return (
                <TouchableOpacity key={i} style={styles.cell} onPress={() => setSel(key)} activeOpacity={0.7}>
                  <View style={[styles.num, isSel && { backgroundColor: T.primary }, !isSel && isToday && { borderWidth: 1.5, borderColor: T.primary }]}>
                    <Text style={[styles.numText, isSel && { color: "#fff" }]}>{d}</Text>
                  </View>
                  <View style={styles.dots}>
                    {evs.slice(0, 3).map((e, k) => <View key={k} style={[styles.dot, { backgroundColor: typeOf(e.event_type).color }]} />)}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={styles.legend}>
            {Object.entries(TYPE).map(([k, v]) => (
              <View key={k} style={styles.legItem}><View style={[styles.dot, { backgroundColor: v.color }]} /><Text style={font.small}>{v.label}</Text></View>
            ))}
          </View>
        </Card>

        <Text style={[font.h1, { marginTop: SP.xl }]}>{new Date(sel + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}</Text>
        <View style={{ marginTop: SP.sm, gap: SP.sm }}>
          {picked.length === 0 ? <Card><Text style={font.body}>Nothing scheduled.</Text></Card> : picked.map((e) => <EventCard key={e.event_id} e={e} />)}
        </View>

        <Text style={[font.h1, { marginTop: SP.xl }]}>Coming up</Text>
        <View style={{ marginTop: SP.sm, gap: SP.sm }}>
          {upcoming.length === 0 ? <Card><Text style={font.body}>No upcoming events.</Text></Card> : upcoming.map((e) => <EventCard key={e.event_id} e={e} showDate />)}
        </View>
      </ScrollView>
    </Screen>
  );
}

function EventCard({ e, showDate }: { e: Ev; showDate?: boolean }) {
  const t = typeOf(e.event_type);
  const range = e.end_date && e.end_date !== e.start_date ? `${e.start_date} → ${e.end_date}` : e.start_date;
  return (
    <Card>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ width: 4, borderRadius: 2, backgroundColor: t.color }} />
        <View style={{ flex: 1 }}>
          <Text style={font.h3}>{e.title}</Text>
          <Text style={[font.small, { marginTop: 2 }]}>{t.label}{showDate ? ` · ${range}` : ""}{e.scope === "college" ? " · College-wide" : ""}</Text>
          {!!e.description && <Text style={[font.small, { marginTop: 4 }]}>{e.description}</Text>}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  content: { padding: SP.lg, paddingBottom: SP.xl * 2 },
  nav: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: SP.sm },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  wk: { width: "14.285%", textAlign: "center", marginBottom: 4 },
  cell: { width: "14.285%", alignItems: "center", paddingVertical: 4, minHeight: 46 },
  num: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  numText: { fontWeight: "600", color: T.muted },
  dots: { flexDirection: "row", gap: 2, marginTop: 2, height: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: SP.md },
  legItem: { flexDirection: "row", alignItems: "center", gap: 4 },
});