// src/components/AttendanceCalendar.tsx
// Month calendar. Props are backward compatible; `mode="any"` and `initialDate` are new.
//   mode "past"   -> future days disabled (attendance history)
//   mode "future" -> past days disabled   (planning)
//   mode "any"    -> nothing disabled
// Pass `academic` (with `events`) to turn it into the academic calendar: nothing is disabled, days carry
// coloured dots for their events and a legend is shown under the grid. Without `academic` nothing changes.
import React, { useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { T, R, SP, font, shadow } from "./ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CELL = `${100 / 7}%` as const;

export interface PickedDate {
  day: string;
  date: number;
  month: number; // 1-12
  year: number;
}

export interface AcademicEvent {
  event_id: string;
  title: string;
  event_type: string;
  start_date: string;       // YYYY-MM-DD
  end_date?: string;
}

export const EVENT_TYPES: Record<string, { label: string; color: string }> = {
  holiday: { label: "Holiday", color: "#EF4444" },
  exam: { label: "Exam", color: "#F59E0B" },
  event: { label: "Event", color: "#3B82F6" },
  working_day_swap: { label: "Working day swap", color: "#8B5CF6" },
  general: { label: "General", color: "#6B7280" },
};
export const eventType = (t: string) => EVENT_TYPES[t] || EVENT_TYPES.general;

interface Props {
  onDateSelect: (date: PickedDate) => void;
  mode?: "past" | "future" | "any";
  initialDate?: Date;
  academic?: boolean;
  events?: AcademicEvent[];
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const isoOf = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export default function AttendanceCalendar({ onDateSelect, mode: modeProp, initialDate, academic = false, events = [] }: Props) {
  const mode = modeProp || (academic ? "any" : "past");
  const today = useMemo(() => startOfDay(new Date()), []);
  const start = initialDate ? startOfDay(initialDate) : today;

  const [view, setView] = useState({ m: start.getMonth(), y: start.getFullYear() });
  // The whole selected date is tracked, so "the 15th" does not stay highlighted when the month changes.
  const [sel, setSel] = useState({ d: start.getDate(), m: start.getMonth(), y: start.getFullYear() });

  const monthIndex = (m: number, y: number) => y * 12 + m;
  const canGo = (dir: number) => {
    const next = monthIndex(view.m, view.y) + dir;
    const now = monthIndex(today.getMonth(), today.getFullYear());
    if (mode === "past" && next > now) return false;
    if (mode === "future" && next < now) return false;
    return true;
  };

  const go = (dir: number) => {
    if (!canGo(dir)) return;
    const idx = monthIndex(view.m, view.y) + dir;
    setView({ m: ((idx % 12) + 12) % 12, y: Math.floor(idx / 12) });
  };

  // Always call the newest `go` (the responder is created once).
  const goRef = useRef(go);
  goRef.current = go;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderRelease: (_, g) => {
        if (g.dx > 70) goRef.current(-1);
        else if (g.dx < -70) goRef.current(1);
      },
    })
  ).current;

  const isDisabled = (d: Date) => (mode === "past" ? d > today : mode === "future" ? d < today : false);

  const pick = (d: number) => {
    setSel({ d, m: view.m, y: view.y });
    const dt = new Date(view.y, view.m, d);
    onDateSelect({ day: DAYS[dt.getDay()], date: d, month: view.m + 1, year: view.y });
  };

  const jumpToday = () => {
    setView({ m: today.getMonth(), y: today.getFullYear() });
    if (!isDisabled(today)) {
      setSel({ d: today.getDate(), m: today.getMonth(), y: today.getFullYear() });
      onDateSelect({ day: DAYS[today.getDay()], date: today.getDate(), month: today.getMonth() + 1, year: today.getFullYear() });
    }
  };

  const total = new Date(view.y, view.m + 1, 0).getDate();
  const first = new Date(view.y, view.m, 1).getDay();
  const onTodayMonth = view.m === today.getMonth() && view.y === today.getFullYear();

  const navBtn = (dir: number, icon: "chevron-back" | "chevron-forward") => {
    const ok = canGo(dir);
    return (
      <Pressable
        onPress={() => go(dir)}
        disabled={!ok}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={dir < 0 ? "Previous month" : "Next month"}
        style={{ width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: T.primarySoft, opacity: ok ? 1 : 0.35 }}
      >
        <Ionicons name={icon} size={20} color={T.primary} />
      </Pressable>
    );
  };

  const rowH = academic ? 50 : 42;
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < first; i++) cells.push(<View key={"e" + i} style={{ width: CELL, height: rowH }} />);
  for (let d = 1; d <= total; d++) {
    const dt = new Date(view.y, view.m, d);
    const off = isDisabled(dt);
    const on = sel.d === d && sel.m === view.m && sel.y === view.y;
    const isToday = dt.getTime() === today.getTime();
    const key = isoOf(view.y, view.m, d);
    const dayEvents = academic ? events.filter((e) => e.start_date <= key && key <= (e.end_date || e.start_date)) : [];
    cells.push(
      <View key={d} style={{ width: CELL, height: rowH, alignItems: "center", justifyContent: "center" }}>
        <Pressable
          disabled={off}
          onPress={() => pick(d)}
          accessibilityRole="button"
          accessibilityState={{ selected: on, disabled: off }}
          accessibilityLabel={`${d} ${MONTHS[view.m]} ${view.y}`}
          style={{
            width: 36,
            height: 36,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: on ? T.primary : "transparent",
            borderWidth: isToday && !on ? 1.5 : 0,
            borderColor: T.primary,
            opacity: off ? 0.3 : 1,
          }}
        >
          <Text style={{ fontSize: 14, color: on ? "#fff" : T.ink, fontWeight: on || isToday ? "800" : "500" }}>{d}</Text>
        </Pressable>
        {academic && (
          <View style={{ flexDirection: "row", gap: 3, height: 6, marginTop: 2 }}>
            {dayEvents.slice(0, 3).map((e, k) => (
              <View key={k} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: eventType(e.event_type).color }} />
            ))}
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={[{ backgroundColor: T.surface, borderRadius: R.lg, padding: SP.lg }, shadow]} {...pan.panHandlers}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: SP.md }}>
        {navBtn(-1, "chevron-back")}
        <Pressable onPress={jumpToday} disabled={onTodayMonth} accessibilityLabel="Jump to today" style={{ alignItems: "center" }}>
          <Text style={font.h2}>
            {MONTHS[view.m]} {view.y}
          </Text>
          {!onTodayMonth && <Text style={{ fontSize: 11, fontWeight: "700", color: T.primary }}>Back to today</Text>}
        </Pressable>
        {navBtn(1, "chevron-forward")}
      </View>
      <View style={{ flexDirection: "row", marginBottom: 6 }}>
        {DAYS.map((d) => (
          <Text key={d} style={{ width: CELL, textAlign: "center", fontSize: 11, fontWeight: "700", color: T.muted }}>
            {d}
          </Text>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>{cells}</View>
      {academic && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: SP.md }}>
          {Object.entries(EVENT_TYPES).map(([k, v]) => (
            <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: v.color }} />
              <Text style={{ fontSize: 11, color: T.muted, fontWeight: "600" }}>{v.label}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}