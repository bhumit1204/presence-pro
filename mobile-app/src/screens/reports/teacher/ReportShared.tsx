// screens/reports/teacher/reportShared.tsx
// Small helpers shared by the report screens: data hook, load/error boundary, date helpers, tabs, stat row.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE } from "../../../services/api";
import { Banner, Button, EmptyState, R, SP, T, TONE, Tone, font } from "../../../components/ui";

export const API_URL = API_BASE;
export type IconName = React.ComponentProps<typeof Ionicons>["name"];

/* ───────────── thresholds (one place, so every screen agrees) ───────────── */
export const ATT_OK = 75;
export const ATT_WARN = 60;
export const PASS_PCT = 60;

export const attTone = (pct: number | null | undefined): Tone =>
  pct == null ? "neutral" : pct >= ATT_OK ? "success" : pct >= ATT_WARN ? "warning" : "danger";
export const scoreTone = (pct: number | null | undefined): Tone => (pct == null ? "neutral" : pct >= PASS_PCT ? "success" : "danger");

export const num = (v: any, fallback = 0): number => (typeof v === "number" && isFinite(v) ? v : fallback);
/** n / d clamped to 0..1, and 0 when d is 0 or missing (no NaN widths). */
export const ratio = (n: any, d: any): number => (num(d) > 0 ? Math.max(0, Math.min(1, num(n) / num(d))) : 0);
export const enc = encodeURIComponent;

/* ───────────── dates ───────────── */
/** "YYYY-MM-DD" is read as a LOCAL date (new Date("2026-10-19") is UTC and shows the wrong day west of UTC). */
export function parseDate(v?: string | null): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
export function fmtDate(v?: string | null, withWeekday = false): string {
  const d = parseDate(v);
  if (!d) return "-";
  return d.toLocaleDateString("en-IN", { ...(withWeekday ? { weekday: "short" as const } : {}), day: "numeric", month: "short", year: "numeric" });
}
export function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ───────────── data hook ───────────── */
function friendly(e: any): string {
  const m = String(e?.message || "");
  if (/network|failed to fetch|timeout|abort/i.test(m)) return "Could not reach the server. Check your connection.";
  return m || "Something went wrong.";
}

export interface Report<T = any> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: (silent?: boolean) => Promise<void>;
}

/**
 * GET a report endpoint. Keeps the previous data while a new request is running (no flash of an empty screen),
 * ignores answers that arrive after a newer request, and always surfaces failures instead of swallowing them.
 */
export function useReport<T = any>(url: string | null): Report<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(!!url);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(
    async (silent = false) => {
      if (!url) {
        setLoading(false);
        return;
      }
      const id = ++seq.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(url);
        const text = await res.text();
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        if (id !== seq.current) return;
        if (!res.ok || !json?.success) throw new Error(json?.error || `The server answered with an error (${res.status}).`);
        setData(json as T);
      } catch (e: any) {
        if (id === seq.current) setError(friendly(e));
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    [url]
  );

  useEffect(() => {
    reload();
    return () => {
      seq.current++; // drop any answer still in flight
    };
  }, [reload]);

  return { data, loading, error, reload };
}

/* ───────────── UI helpers ───────────── */
export function LoadBoundary({ report, label = "Loading", children }: { report: Report; label?: string; children: React.ReactNode }) {
  const { data, loading, error, reload } = report;
  if (data == null && loading) {
    return (
      <View style={{ paddingVertical: 60, alignItems: "center", gap: SP.md }}>
        <ActivityIndicator size="large" color={T.primary} />
        <Text style={font.small}>{label}...</Text>
      </View>
    );
  }
  if (data == null) {
    return (
      <View>
        <EmptyState icon="cloud-offline-outline" title="Could not load" text={error ?? "Please try again."} />
        <View style={{ paddingHorizontal: SP.xl }}>
          <Button label="Try again" icon="refresh" variant="secondary" onPress={() => reload()} />
        </View>
      </View>
    );
  }
  return (
    <>
      {!!error && (
        <Banner tone="warning" title="Showing the last loaded data" style={{ marginBottom: SP.md }}>
          {error}
        </Banner>
      )}
      {children}
    </>
  );
}

export function StatRow({ items }: { items: { value: string | number; label: string; tone?: Tone }[] }) {
  return (
    <View style={{ flexDirection: "row", gap: SP.sm }}>
      {items.map((i) => {
        const c = TONE[i.tone ?? "neutral"];
        return (
          <View key={i.label} style={{ flex: 1, backgroundColor: c.bg, borderRadius: R.md, paddingVertical: SP.md, paddingHorizontal: 4, alignItems: "center" }}>
            <Text style={{ fontSize: 20, fontWeight: "800", color: c.fg }} numberOfLines={1} adjustsFontSizeToFit>
              {i.value}
            </Text>
            <Text style={{ fontSize: 11, fontWeight: "600", color: c.fg, marginTop: 2 }} numberOfLines={1}>
              {i.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function TabBar<K extends string>({ tabs, active, onChange }: { tabs: { key: K; label: string; icon: IconName }[]; active: K; onChange: (k: K) => void }) {
  return (
    <View style={{ backgroundColor: T.surface, borderBottomWidth: 1, borderBottomColor: T.line }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: SP.lg, paddingVertical: SP.sm, gap: SP.sm }}>
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <Pressable
              key={t.key}
              onPress={() => onChange(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 14,
                paddingVertical: 9,
                borderRadius: R.pill,
                backgroundColor: on ? T.primarySoft : T.lineSoft,
              }}
            >
              <Ionicons name={t.icon} size={15} color={on ? T.primary : T.sub} />
              <Text style={{ fontSize: 13, fontWeight: "700", color: on ? T.primary : T.sub }}>{t.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Round icon button for Header's `right` slot. */
export function HeaderIconButton({ icon, onPress, label }: { icon: IconName; onPress: () => void; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 14,
        backgroundColor: T.surface,
        borderWidth: 1,
        borderColor: T.line,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={18} color={T.ink} />
    </Pressable>
  );
}