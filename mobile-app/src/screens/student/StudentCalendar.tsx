import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { apiFetch, API_BASE } from "../../services/api";
import { getUserSession } from "../../services/session";
import { Banner, Card, Screen, SP, T, font } from "../../components/ui";
import AttendanceCalendar, { PickedDate, eventType } from "../../components/AttendanceCalendar";

type Ev = { event_id: string; title: string; event_type: string; start_date: string; end_date?: string; description?: string; scope?: string };

const iso = (p: PickedDate) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.date).padStart(2, "0")}`;

export default function StudentCalendar() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [today, setToday] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<string>(today);

  const load = useCallback(async () => {
    try {
      const s = await getUserSession();
      if (!s?.uid) return;
      const res = await apiFetch(`${API_BASE}/api/web/student/calendar?uid=${s.uid}`);
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || "Could not load calendar");
      setEvents(j.events || []); if (j.today) setToday(j.today); setError("");
    } catch (e: any) { setError(e?.message || "Could not load calendar"); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const on = (d: string) => events.filter((e) => e.start_date <= d && d <= (e.end_date || e.start_date));

  const upcoming = events.filter((e) => (e.end_date || e.start_date) >= today).sort((a, b) => a.start_date.localeCompare(b.start_date)).slice(0, 6);
  const picked = on(sel);

  if (loading) return <Screen edges={["top"]}><View style={styles.center}><ActivityIndicator size="large" color={T.primary} /></View></Screen>;

  return (
    <Screen edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
        <Text style={font.display}>Academic calendar</Text>
        {!!error && <View style={{ marginTop: SP.md }}><Banner tone="danger" icon="alert-circle-outline" title={error} /></View>}

        <View style={{ marginTop: SP.md }}>
          <AttendanceCalendar academic events={events} initialDate={new Date(today + "T00:00:00")} onDateSelect={(p) => setSel(iso(p))} />
        </View>

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
  const t = eventType(e.event_type);
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
});