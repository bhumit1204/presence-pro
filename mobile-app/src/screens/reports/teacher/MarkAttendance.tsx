// screens/reports/teacher/MarkAttendance.tsx — weekly attendance register (Monday to Saturday) for one subject.
// Fixes: changing week used to wipe unsaved edits; a date that failed to load looked "unrecorded" and could be
// overwritten; one request per student was fired all at once; the table needed horizontal scrolling and a fixed height;
// the next-week arrow let you open weeks that are entirely in the future.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { apiFetch } from "../../../services/api";
import { Banner, Button, EmptyState, Header, Screen, SP, T, font } from "../../../components/ui";
import { API_URL, enc, toYMD } from "./ReportShared";

type Status = "present" | "absent" | "no_class" | "od" | null;
interface StudentRow {
  uid: string;
  name: string;
  roll_no: string | null;
}
interface Cell {
  status: Status;
  dirty: boolean;
}
type Register = Record<string, Record<string, Cell>>; // uid -> date -> cell

const NAME_W = 108;
const ROW_H = 52;
const STUDENT_LIMIT = 200;
const SAVE_BATCH = 5;

function weekDatesOf(anchor: Date): string[] {
  const day = anchor.getDay(); // 0 = Sunday
  const monday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - ((day === 0 ? 7 : day) - 1));
  return Array.from({ length: 6 }, (_, i) => toYMD(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)));
}
const ymdToDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const dayName = (ymd: string) => ymdToDate(ymd).toLocaleDateString("en-IN", { weekday: "short" });
const dayMonth = (ymd: string) => {
  const [, m, d] = ymd.split("-");
  return `${d}/${m}`;
};

export default function MarkAttendance() {
  const navigation = useNavigation<any>();
  const params = useRoute<any>().params ?? {};
  const { subject, teacher_id } = params;
  const subjectId: string = subject?.subject_id || "";
  const { width } = useWindowDimensions();
  const cellW = Math.max(38, Math.floor((width - NAME_W) / 6));

  const todayStr = toYMD(new Date());
  const [anchor, setAnchor] = useState(() => new Date());
  const weekDates = useMemo(() => weekDatesOf(anchor), [anchor]);
  const weekKey = weekDates[0];
  const nextWeekStart = toYMD(new Date(ymdToDate(weekKey).getTime() + 7 * 86400000));
  const canGoNext = nextWeekStart <= todayStr;

  const [students, setStudents] = useState<StudentRow[]>([]);
  const [studentsError, setStudentsError] = useState<string | null>(null);
  const [loadingStudents, setLoadingStudents] = useState(true);
  const [register, setRegister] = useState<Register>({});
  const [loadingDates, setLoadingDates] = useState<Record<string, boolean>>({});
  const [failedDates, setFailedDates] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  /* ───────────── load students ───────────── */
  const loadStudents = useCallback(async () => {
    if (!teacher_id || !subjectId) {
      setLoadingStudents(false);
      return;
    }
    setLoadingStudents(true);
    setStudentsError(null);
    try {
      const res = await apiFetch(`${API_URL}/api/reports/students/search?teacher_id=${enc(teacher_id)}&subject_id=${enc(subjectId)}&query=&limit=${STUDENT_LIMIT}`);
      let json: any = null;
      try {
        json = JSON.parse(await res.text());
      } catch {}
      if (!res.ok || !json?.success) throw new Error(json?.error || `status ${res.status}`);
      const sorted = [...(json.students as StudentRow[])].sort((a, b) => (a.roll_no || "zzz").localeCompare(b.roll_no || "zzz", undefined, { numeric: true }));
      setStudents(sorted);
    } catch {
      setStudentsError("Could not load the class list. Check your connection.");
    } finally {
      setLoadingStudents(false);
    }
  }, [teacher_id, subjectId]);

  useEffect(() => {
    loadStudents();
  }, [loadStudents]);

  /* ───────────── load the visible week ───────────── */
  const loadWeek = useCallback(async () => {
    const dates = weekDates.filter((d) => d <= todayStr);
    if (!students.length || !dates.length) return;
    setLoadingDates((p) => ({ ...p, ...Object.fromEntries(dates.map((d) => [d, true])) }));

    const results = await Promise.all(
      dates.map(async (date) => {
        try {
          const res = await apiFetch(`${API_URL}/api/reports/attendance/by-date?teacher_id=${enc(teacher_id)}&subject_id=${enc(subjectId)}&date=${date}`);
          let json: any = null;
          try {
            json = JSON.parse(await res.text());
          } catch {}
          if (!res.ok || !json?.success) throw new Error("bad");
          return { date, rows: json.students as { uid: string; status: Status }[], ok: true };
        } catch {
          return { date, rows: [] as { uid: string; status: Status }[], ok: false };
        }
      })
    );

    // Merge, never replace: cells the teacher changed but has not saved yet survive a reload or a week change.
    setRegister((prev) => {
      const next: Register = {};
      students.forEach((s) => (next[s.uid] = { ...(prev[s.uid] || {}) }));
      results.forEach(({ date, rows, ok }) => {
        if (!ok) return;
        rows.forEach((row) => {
          const mine = next[row.uid];
          if (!mine || mine[date]?.dirty) return;
          mine[date] = { status: row.status, dirty: false };
        });
      });
      return next;
    });
    setFailedDates((prev) => [...prev.filter((d) => !dates.includes(d)), ...results.filter((r) => !r.ok).map((r) => r.date)]);
    setLoadingDates((p) => ({ ...p, ...Object.fromEntries(dates.map((d) => [d, false])) }));
  }, [weekDates, students, teacher_id, subjectId, todayStr]);

  useEffect(() => {
    loadWeek();
  }, [loadWeek]);

  /* ───────────── editing ───────────── */
  // A day without a lecture cannot be marked (the server refuses it, and it would push attendance past 100%).
  const noLecture = (date: string) => students.length > 0 && students.every((s) => register[s.uid]?.[date]?.status === "no_class");
  const locked = (date: string) => date > todayStr || failedDates.includes(date) || !!loadingDates[date] || noLecture(date);

  const toggleCell = (uid: string, date: string) => {
    if (locked(date) || saving) return;
    const cur = register[uid]?.[date]?.status;
    if (cur === "od" || cur === "no_class") return; // OD is never overwritten here; no lecture that day means nothing to mark
    const next: Status = cur === "present" ? "absent" : "present";
    setRegister((p) => ({ ...p, [uid]: { ...(p[uid] || {}), [date]: { status: next, dirty: true } } }));
  };

  const allPresent = (date: string) =>
    students.length > 0 &&
    register[students[0].uid]?.[date]?.status !== "no_class" &&
    students.every((s) => {
      const st = register[s.uid]?.[date]?.status;
      return st === "present" || st === "od";
    });

  const setColumn = (date: string, present: boolean) => {
    if (locked(date) || saving) return;
    const target: Status = present ? "present" : "absent";
    setRegister((p) => {
      const next: Register = { ...p };
      students.forEach((s) => {
        const existing = next[s.uid]?.[date];
        if (existing?.status === "od") return;
        next[s.uid] = { ...(next[s.uid] || {}), [date]: { status: target, dirty: existing?.status !== target || !!existing?.dirty } };
      });
      return next;
    });
  };

  const dirtyList = useMemo(() => {
    const out: { uid: string; date: string; status: "present" | "absent" }[] = [];
    Object.entries(register).forEach(([uid, dates]) =>
      Object.entries(dates).forEach(([date, c]) => {
        if (c.dirty && (c.status === "present" || c.status === "absent")) out.push({ uid, date, status: c.status });
      })
    );
    return out;
  }, [register]);
  const dirtyCount = dirtyList.length;

  const save = async () => {
    if (saving || dirtyCount === 0) return;
    setSaving(true);
    const saved: { uid: string; date: string; status: "present" | "absent" }[] = [];
    let failed = 0;
    // A few requests at a time, so a full class does not fire 60 calls at once.
    for (let i = 0; i < dirtyList.length; i += SAVE_BATCH) {
      await Promise.all(
        dirtyList.slice(i, i + SAVE_BATCH).map(async (item) => {
          try {
            const res = await apiFetch(`${API_URL}/api/reports/attendance/manual`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ teacher_id, subject_id: subjectId, student_uid: item.uid, date: item.date, status: item.status }),
            });
            let json: any = null;
            try {
              json = JSON.parse(await res.text());
            } catch {}
            if (res.ok && json?.success) saved.push(item);
            else failed++;
          } catch {
            failed++;
          }
        })
      );
    }
    setRegister((p) => {
      const next: Register = { ...p };
      saved.forEach(({ uid, date, status }) => {
        next[uid] = { ...(next[uid] || {}), [date]: { status, dirty: false } };
      });
      return next;
    });
    setSaving(false);
    if (failed === 0) Alert.alert("Saved", `${saved.length} record${saved.length === 1 ? "" : "s"} saved.`);
    else Alert.alert("Some changes were not saved", `${saved.length} saved, ${failed} failed. The failed ones are still marked, so you can tap Save again.`);
  };

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const unsub = navigation.addListener("beforeRemove", (e: any) => {
      if (dirtyCount === 0) return;
      e.preventDefault();
      Alert.alert("Discard unsaved changes?", `${dirtyCount} change${dirtyCount === 1 ? "" : "s"} have not been saved.`, [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
      ]);
    });
    return unsub;
  }, [navigation, dirtyCount]);

  /* ───────────── render ───────────── */
  if (!teacher_id || !subjectId) {
    return (
      <Screen>
        <Header title="Attendance register" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Subject not selected" text="Go back and choose a subject again." />
      </Screen>
    );
  }

  if (loadingStudents) {
    return (
      <Screen>
        <Header title={subject?.subject_name || "Attendance register"} onBack={() => navigation.goBack()} />
        <View style={st.center}>
          <ActivityIndicator size="large" color={T.primary} />
          <Text style={font.small}>Loading class list...</Text>
        </View>
      </Screen>
    );
  }

  if (studentsError) {
    return (
      <Screen>
        <Header title={subject?.subject_name || "Attendance register"} onBack={() => navigation.goBack()} />
        <EmptyState icon="cloud-offline-outline" title="Could not load" text={studentsError} />
        <View style={{ paddingHorizontal: SP.xl }}>
          <Button label="Try again" icon="refresh" variant="secondary" onPress={loadStudents} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={subject?.subject_name || "Attendance register"} subtitle={`${students.length} students`} onBack={() => navigation.goBack()} />

      {/* week navigator */}
      <View style={st.weekNav}>
        <Pressable style={st.arrow} onPress={() => setAnchor((a) => new Date(a.getFullYear(), a.getMonth(), a.getDate() - 7))} accessibilityLabel="Previous week">
          <Ionicons name="chevron-back" size={20} color={T.primary} />
        </Pressable>
        <Pressable onPress={() => setAnchor(new Date())} accessibilityLabel="Go to this week">
          <Text style={font.h3}>
            {dayMonth(weekDates[0])} to {dayMonth(weekDates[5])}
          </Text>
        </Pressable>
        <Pressable style={[st.arrow, !canGoNext && { backgroundColor: T.lineSoft }]} disabled={!canGoNext} onPress={() => setAnchor((a) => new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7))} accessibilityLabel="Next week">
          <Ionicons name="chevron-forward" size={20} color={canGoNext ? T.primary : T.line} />
        </Pressable>
      </View>

      {/* legend */}
      <View style={st.legend}>
        {[
          { bg: T.successSoft, icon: "checkmark" as const, color: T.success, label: "Present" },
          { bg: T.dangerSoft, icon: "close" as const, color: T.danger, label: "Absent" },
          { bg: T.primarySoft, icon: "shield-checkmark" as const, color: T.primary, label: "OD" },
          { bg: T.lineSoft, icon: "ellipse" as const, color: T.line, label: "Not marked" },
          { bg: "#FAFBFD", icon: "remove" as const, color: T.line, label: "No lecture" },
        ].map((l) => (
          <View key={l.label} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={[st.legendBox, { backgroundColor: l.bg }]}>
              <Ionicons name={l.icon} size={10} color={l.color} />
            </View>
            <Text style={font.small}>{l.label}</Text>
          </View>
        ))}
      </View>

      {failedDates.length > 0 && (
        <Banner tone="warning" style={{ marginHorizontal: SP.lg, marginTop: SP.sm }}>
          Could not load {failedDates.map(dayMonth).join(", ")}. Those columns are locked so nothing gets overwritten.
          <Text onPress={loadWeek} style={{ fontWeight: "800", color: T.warning }}>
            {"  "}Retry
          </Text>
        </Banner>
      )}
      {students.length >= STUDENT_LIMIT && (
        <Banner tone="info" style={{ marginHorizontal: SP.lg, marginTop: SP.sm }}>
          Showing the first {STUDENT_LIMIT} students.
        </Banner>
      )}

      {students.length === 0 ? (
        <EmptyState icon="people-outline" title="No students" text="Nobody is enrolled in this subject yet." />
      ) : (
        <View style={{ flex: 1, marginTop: SP.sm }}>
          {/* column headers */}
          <View style={st.headRow}>
            <View style={[st.nameCol, { width: NAME_W }]}>
              <Text style={font.label}>Student</Text>
            </View>
            {weekDates.map((d) => {
              const future = d > todayStr;
              const today = d === todayStr;
              const all = allPresent(d);
              return (
                <View key={d} style={[st.dateCol, { width: cellW }, today && { backgroundColor: T.primarySoft }]}>
                  <Text style={[st.dayTxt, today && { color: T.primary }]}>{dayName(d)}</Text>
                  <Text style={[st.dateTxt, today && { color: T.primary }]}>{dayMonth(d)}</Text>
                  {loadingDates[d] ? (
                    <ActivityIndicator size="small" color={T.primary} style={{ marginTop: 4 }} />
                  ) : future ? (
                    <View style={{ height: 22, marginTop: 4 }} />
                  ) : (
                    <Pressable
                      onPress={() => setColumn(d, !all)}
                      disabled={locked(d)}
                      hitSlop={6}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: all, disabled: locked(d) }}
                      accessibilityLabel={`Mark everyone ${all ? "absent" : "present"} on ${dayName(d)} ${dayMonth(d)}`}
                      style={[st.colCheck, all && { backgroundColor: T.success, borderColor: T.success }, locked(d) && { opacity: 0.35 }]}
                    >
                      {all && <Ionicons name="checkmark" size={12} color="#fff" />}
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>

          {/* rows */}
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: dirtyCount > 0 ? 100 : 30 }}>
            {students.map((s, idx) => (
              <View key={s.uid} style={[st.row, idx % 2 === 1 && { backgroundColor: "#FAFBFD" }]}>
                <View style={[st.nameCol, { width: NAME_W }]}>
                  <Text style={st.roll} numberOfLines={1}>
                    {s.roll_no || `#${idx + 1}`}
                  </Text>
                  <Text style={st.name} numberOfLines={1}>
                    {s.name}
                  </Text>
                </View>
                {weekDates.map((d) => (
                  <AttCell key={d} width={cellW} date={d} future={d > todayStr} blocked={failedDates.includes(d)} cell={register[s.uid]?.[d]} label={`${s.name}, ${dayName(d)} ${dayMonth(d)}`} onPress={() => toggleCell(s.uid, d)} />
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {dirtyCount > 0 && (
        <View style={st.saveBar}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: "800", color: T.ink }}>
              {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"}
            </Text>
            <Text style={font.small}>Tap Save to confirm</Text>
          </View>
          <Button label="Save" icon="save-outline" size="md" onPress={save} loading={saving} />
        </View>
      )}
    </Screen>
  );
}

function AttCell({ width, future, blocked, cell, label, onPress }: { width: number; date: string; future: boolean; blocked: boolean; cell?: Cell; label: string; onPress: () => void }) {
  if (future) {
    return (
      <View style={[st.cell, { width, backgroundColor: "#FAFBFD" }]}>
        <Text style={{ color: T.line, fontSize: 16 }}>-</Text>
      </View>
    );
  }
  if (blocked) {
    return (
      <View style={[st.cell, { width, backgroundColor: T.warningSoft }]}>
        <Ionicons name="alert-circle-outline" size={16} color={T.warning} />
      </View>
    );
  }
  const status = cell?.status ?? null;
  if (status === "no_class") {
    return (
      <View style={[st.cell, { width, backgroundColor: "#FAFBFD" }]} accessibilityLabel={`${label}: no lecture`}>
        <Text style={{ color: T.line, fontSize: 16 }}>-</Text>
      </View>
    );
  }
  const od = status === "od";
  const bg = status === "present" ? T.successSoft : status === "absent" ? T.dangerSoft : od ? T.primarySoft : T.lineSoft;
  const text = status === "present" ? "present" : status === "absent" ? "absent" : od ? "on duty" : "not marked";
  return (
    <Pressable onPress={onPress} disabled={od} accessibilityRole="button" accessibilityLabel={`${label}: ${text}`} style={[st.cell, { width, backgroundColor: bg }, cell?.dirty && st.cellDirty]}>
      {status === "present" ? (
        <Ionicons name="checkmark" size={18} color={T.success} />
      ) : status === "absent" ? (
        <Ionicons name="close" size={18} color={T.danger} />
      ) : od ? (
        <>
          <Ionicons name="shield-checkmark" size={14} color={T.primary} />
          <Text style={st.odTxt}>OD</Text>
        </>
      ) : (
        <View style={st.dot} />
      )}
      {cell?.dirty && <View style={st.dirtyDot} />}
    </Pressable>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: SP.md },
  weekNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: SP.xl, paddingVertical: SP.sm, backgroundColor: T.surface, borderBottomWidth: 1, borderBottomColor: T.line },
  arrow: { width: 38, height: 38, borderRadius: 12, backgroundColor: T.primarySoft, alignItems: "center", justifyContent: "center" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: SP.md, paddingHorizontal: SP.lg, paddingVertical: SP.sm, backgroundColor: T.surface, borderBottomWidth: 1, borderBottomColor: T.line },
  legendBox: { width: 18, height: 18, borderRadius: 5, alignItems: "center", justifyContent: "center" },

  headRow: { flexDirection: "row", backgroundColor: T.surface, borderBottomWidth: 2, borderBottomColor: T.line },
  nameCol: { paddingHorizontal: SP.md, paddingVertical: SP.sm, justifyContent: "center", borderRightWidth: 1, borderRightColor: T.line },
  dateCol: { alignItems: "center", paddingVertical: SP.sm, borderRightWidth: 1, borderRightColor: T.line },
  dayTxt: { fontSize: 10, fontWeight: "700", color: T.muted, textTransform: "uppercase" },
  dateTxt: { fontSize: 12.5, fontWeight: "800", color: T.ink, marginTop: 1 },
  colCheck: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: T.success, marginTop: 4, alignItems: "center", justifyContent: "center" },

  row: { flexDirection: "row", height: ROW_H, borderBottomWidth: 1, borderBottomColor: T.lineSoft, backgroundColor: T.surface },
  roll: { fontSize: 10, fontWeight: "700", color: T.primary },
  name: { fontSize: 12.5, fontWeight: "600", color: T.ink, marginTop: 1 },

  cell: { height: ROW_H, alignItems: "center", justifyContent: "center", borderRightWidth: 1, borderRightColor: T.lineSoft },
  cellDirty: { borderWidth: 1.5, borderColor: T.warning },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.line },
  dirtyDot: { position: "absolute", top: 5, right: 5, width: 6, height: 6, borderRadius: 3, backgroundColor: T.warning },
  odTxt: { fontSize: 8, fontWeight: "800", color: T.primary, marginTop: 1 },

  saveBar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: SP.md, backgroundColor: T.surface, borderTopWidth: 1, borderTopColor: T.line, paddingHorizontal: SP.lg, paddingVertical: SP.md },
});