import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";

const PRIMARY = "#4834D4";
const PRIMARY_SOFT = "#EEF2FF";
const BG = "#F3F4F6";
const WHITE = "#FFFFFF";
const GREY = "#6B7280";
const DARK = "#111827";
const GREEN = "#10B981";
const AMBER = "#F59E0B";
const RED = "#EF4444";
const BORDER = "#E5E7EB";
const CELL_W = 52;
const ROW_H = 52;

const API_URL = "http://10.132.90.56:5000";

// ── Date helpers ────────────────────────────────────────────────────────────
function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function getWeekDates(anchor: Date): string[] {
  // Monday-Saturday of the week containing anchor
  const day = anchor.getDay(); // 0=Sun
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - ((day === 0 ? 7 : day) - 1));
  const dates: string[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(toYMD(d));
  }
  return dates;
}

function addWeeks(anchor: Date, n: number): Date {
  const d = new Date(anchor);
  d.setDate(d.getDate() + n * 7);
  return d;
}

function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short" });
}

function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

type Status = "present" | "absent" | "no_class" | "od" | null;

interface StudentRow {
  uid: string;
  name: string;
  roll_no: string | null;
}

interface AttCell {
  status: Status;
  dirty: boolean; // locally changed, not yet saved
}

type RegisterData = Record<string, Record<string, AttCell>>; // uid → date → cell

export default function MarkAttendance() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { subject, teacher_id } = route.params;
  const subjectId = subject?.subject_id || "";

  const today = new Date();
  const [weekAnchor, setWeekAnchor] = useState(today);
  const weekDates = getWeekDates(weekAnchor);
  const isFutureWeek = weekDates[0] > toYMD(today);

  const [students, setStudents] = useState<StudentRow[]>([]);
  const [register, setRegister] = useState<RegisterData>({});
  const [loadingStudents, setLoadingStudents] = useState(true);
  const [loadingDates, setLoadingDates] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  // ── Load students once ───────────────────────────────────────────────────
  useEffect(() => {
    loadStudents();
  }, []);

  // ── Load attendance whenever week changes ────────────────────────────────
  useEffect(() => {
    if (students.length) loadWeekAttendance();
  }, [weekAnchor, students]);

  const loadStudents = async () => {
    try {
      setLoadingStudents(true);
      const res = await fetch(
        `${API_URL}/api/reports/students/search?teacher_id=${teacher_id}&subject_id=${subjectId}&query=&limit=200`
      );
      const json = await res.json();
      if (json.success) {
        const sorted = (json.students as StudentRow[]).sort((a, b) => {
          const ra = a.roll_no || "zzz";
          const rb = b.roll_no || "zzz";
          return ra.localeCompare(rb, undefined, { numeric: true });
        });
        setStudents(sorted);
      }
    } catch (e) {
      console.log("LOAD STUDENTS ERROR:", e);
    } finally {
      setLoadingStudents(false);
    }
  };

  const loadWeekAttendance = async () => {
    const todayStr = toYMD(today);
    const datesToFetch = weekDates.filter((d) => d <= todayStr);
    if (!datesToFetch.length) return;

    setLoadingDates(Object.fromEntries(datesToFetch.map((d) => [d, true])));

    const newRegister: RegisterData = {};
    students.forEach((s) => { newRegister[s.uid] = {}; });

    await Promise.all(
      datesToFetch.map(async (date) => {
        try {
          const res = await fetch(
            `${API_URL}/api/reports/attendance/by-date?teacher_id=${teacher_id}&subject_id=${subjectId}&date=${date}`
          );
          const json = await res.json();
          if (json.success) {
            (json.students as any[]).forEach((row) => {
              if (newRegister[row.uid]) {
                newRegister[row.uid][date] = { status: row.status as Status, dirty: false };
              }
            });
          }
        } catch (e) {
          console.log(`DATE LOAD ERROR ${date}:`, e);
        } finally {
          setLoadingDates((prev) => ({ ...prev, [date]: false }));
        }
      })
    );

    setRegister(newRegister);
  };

  // ── Toggle cell ──────────────────────────────────────────────────────────
  const cycleStatus = (uid: string, date: string) => {
    if (date > toYMD(today)) return; // can't mark future
    const current = register[uid]?.[date]?.status;
    if (current === "od") return; // OD cells are locked — approved by teacher
    // Only 2 states: present ↔ absent. null/no_class → present on first tap.
    const next: Status = (current === "present") ? "absent" : "present";

    setRegister((prev) => ({
      ...prev,
      [uid]: {
        ...(prev[uid] || {}),
        [date]: { status: next, dirty: true },
      },
    }));
  };

  // ── Mark entire column (date) ────────────────────────────────────────────
  const markAllPresent = (date: string, checked: boolean) => {
    setRegister((prev) => {
      const next = { ...prev };
      students.forEach((s) => {
        const existing = next[s.uid]?.[date];
        if (existing?.status === "od") return; // never overwrite approved OD
        next[s.uid] = {
          ...(next[s.uid] || {}),
          [date]: {
            status: checked ? "present" : "absent",
            dirty: existing?.status !== (checked ? "present" : "absent"),
          },
        };
      });
      return next;
    });
  };

  const isAllPresent = (date: string) =>
    students.length > 0 &&
    students.every((s) => {
      const st = register[s.uid]?.[date]?.status;
      return st === "present" || st === "od";
    });

  // ── Save dirty cells ─────────────────────────────────────────────────────
  const saveChanges = async () => {
    const dirty: { uid: string; date: string; status: string }[] = [];
    Object.entries(register).forEach(([uid, dates]) => {
      Object.entries(dates).forEach(([date, cell]) => {
        if (cell.dirty && cell.status && cell.status !== "no_class") {
          dirty.push({ uid, date, status: cell.status });
        }
      });
    });

    if (!dirty.length) {
      Alert.alert("Nothing to save", "No attendance changes to save.");
      return;
    }

    setSaving(true);
    let successCount = 0;
    let failCount = 0;

    await Promise.all(
      dirty.map(async ({ uid, date, status }) => {
        try {
          const res = await fetch(`${API_URL}/api/reports/attendance/manual`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teacher_id,
              subject_id: subjectId,
              student_uid: uid,
              date,
              status,
            }),
          });
          const json = await res.json();
          if (json.success) {
            successCount++;
            // clear dirty flag
            setRegister((prev) => ({
              ...prev,
              [uid]: {
                ...(prev[uid] || {}),
                [date]: { status: status as Status, dirty: false },
              },
            }));
          } else {
            failCount++;
          }
        } catch {
          failCount++;
        }
      })
    );

    setSaving(false);
    if (failCount === 0) {
      Alert.alert(" Saved", `${successCount} record(s) saved successfully.`);
    } else {
      Alert.alert(
        "Partial Save",
        `${successCount} saved, ${failCount} failed. Please retry.`
      );
    }
  };

  const dirtyCount = Object.values(register)
    .flatMap((dates) => Object.values(dates))
    .filter((c) => c.dirty).length;

  // ── Cell render ──────────────────────────────────────────────────────────
  const renderCell = (uid: string, date: string) => {
    const todayStr = toYMD(today);
    const isFuture = date > todayStr;
    const cell = register[uid]?.[date];
    const status = cell?.status ?? null;
    const isDirty = cell?.dirty ?? false;

    if (isFuture) {
      return (
        <View key={date} style={[S.cell, S.cellFuture]}>
          <Text style={S.cellFutureText}>—</Text>
        </View>
      );
    }

    let bg = "#F3F4F6";
    let icon: string | null = null;
    let iconColor = GREY;
    const isOD = status === "od";

    if (status === "present") { bg = "#DCFCE7"; icon = "checkmark"; iconColor = GREEN; }
    else if (status === "absent") { bg = "#FEE2E2"; icon = "close"; iconColor = RED; }
    else if (isOD) { bg = "#EDE9FE"; icon = "shield-checkmark"; iconColor = "#7C3AED"; }
    // null and no_class both show as empty dot

    return (
      <TouchableOpacity
        key={date}
        style={[S.cell, { backgroundColor: bg }, isDirty && S.cellDirty, isOD && S.cellOD]}
        onPress={() => cycleStatus(uid, date)}
        activeOpacity={isOD ? 1 : 0.7}
      >
        {icon ? (
          <Ionicons name={icon as any} size={isOD ? 14 : 18} color={iconColor} />
        ) : (
          <View style={S.emptyDot} />
        )}
        {isOD && <Text style={S.cellODLabel}>OD</Text>}
        {isDirty && <View style={S.dirtyDot} />}
      </TouchableOpacity>
    );
  };

  if (loadingStudents) {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
          <Text style={S.loadingText}>Loading class list…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={S.safe}>
      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <View style={S.header}>
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={DARK} />
        </TouchableOpacity>
        <View style={S.headerText}>
          <Text style={S.headerTitle} numberOfLines={1}>{subject?.subject_name}</Text>
          <Text style={S.headerSub}>Attendance Register · {students.length} Students</Text>
        </View>
        {dirtyCount > 0 && (
          <TouchableOpacity
            style={[S.saveBtn, saving && S.saveBtnDisabled]}
            onPress={saveChanges}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color={WHITE} />
            ) : (
              <>
                <Ionicons name="save-outline" size={16} color={WHITE} />
                <Text style={S.saveBtnText}>Save ({dirtyCount})</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* ── WEEK NAVIGATOR ──────────────────────────────────────────────── */}
      <View style={S.weekNav}>
        <TouchableOpacity style={S.weekArrow} onPress={() => setWeekAnchor((a) => addWeeks(a, -1))}>
          <Ionicons name="chevron-back" size={20} color={PRIMARY} />
        </TouchableOpacity>
        <Text style={S.weekLabel}>
          {fmtDate(weekDates[0])} – {fmtDate(weekDates[5])}
        </Text>
        <TouchableOpacity
          style={[S.weekArrow, isFutureWeek && S.weekArrowDisabled]}
          onPress={() => !isFutureWeek && setWeekAnchor((a) => addWeeks(a, 1))}
          disabled={isFutureWeek}
        >
          <Ionicons name="chevron-forward" size={20} color={isFutureWeek ? BORDER : PRIMARY} />
        </TouchableOpacity>
      </View>

      {/* ── LEGEND ──────────────────────────────────────────────────────── */}
      <View style={S.legend}>
        {[
          { color: "#DCFCE7", icon: "checkmark",       iconColor: GREEN,     label: "Present"     },
          { color: "#FEE2E2", icon: "close",            iconColor: RED,       label: "Absent"      },
          { color: "#EDE9FE", icon: "shield-checkmark", iconColor: "#7C3AED", label: "OD"          },
          { color: "#F3F4F6", icon: "ellipse",          iconColor: BORDER,    label: "Unrecorded"  },
        ].map((l) => (
          <View key={l.label} style={S.legendItem}>
            <View style={[S.legendDot, { backgroundColor: l.color }]}>
              <Ionicons name={l.icon as any} size={10} color={l.iconColor} />
            </View>
            <Text style={S.legendText}>{l.label}</Text>
          </View>
        ))}
        <Text style={S.legendHint}>Tap cell to cycle</Text>
      </View>

      {/* ── REGISTER TABLE ──────────────────────────────────────────────── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.tableScroll}>
        <View>
          {/* ── Column headers ── */}
          <View style={S.headerRow}>
            <View style={S.nameCol}>
              <Text style={S.colHeaderText}>Student</Text>
            </View>
            {weekDates.map((date) => {
              const todayStr = toYMD(today);
              const isFuture = date > todayStr;
              const isToday = date === todayStr;
              const allPresent = isAllPresent(date);
              const isLoading = loadingDates[date];

              return (
                <View key={date} style={[S.dateCol, isToday && S.dateTodayCol]}>
                  <Text style={[S.dayText, isToday && { color: PRIMARY }]}>{fmtDay(date)}</Text>
                  <Text style={[S.dateText, isToday && { color: PRIMARY, fontWeight: "800" }]}>
                    {fmtDate(date)}
                  </Text>
                  {isLoading ? (
                    <ActivityIndicator size="small" color={PRIMARY} style={{ marginTop: 4 }} />
                  ) : !isFuture ? (
                    <TouchableOpacity
                      style={[S.checkAllBtn, allPresent && S.checkAllBtnActive]}
                      onPress={() => markAllPresent(date, !allPresent)}
                    >
                      {allPresent ? (
                        <Ionicons name="checkmark" size={12} color={WHITE} />
                      ) : (
                        <View style={S.checkAllEmpty} />
                      )}
                    </TouchableOpacity>
                  ) : (
                    <View style={{ height: 22, marginTop: 4 }} />
                  )}
                </View>
              );
            })}
          </View>

          {/* ── Student rows ── */}
          <ScrollView showsVerticalScrollIndicator={false} style={S.bodyScroll}>
            {students.map((student, idx) => (
              <View
                key={student.uid}
                style={[S.studentRowR, idx % 2 === 0 && S.studentRowAlt]}
              >
                {/* Name column */}
                <View style={S.nameCol}>
                  <Text style={S.rollText}>{student.roll_no || `#${idx + 1}`}</Text>
                  <Text style={S.nameText} numberOfLines={1}>{student.name}</Text>
                </View>

                {/* Date cells */}
                {weekDates.map((date) => renderCell(student.uid, date))}
              </View>
            ))}
          </ScrollView>
        </View>
      </ScrollView>

      {/* ── FLOATING SAVE HINT ──────────────────────────────────────────── */}
      {dirtyCount > 0 && (
        <View style={S.saveBanner}>
          <Ionicons name="ellipse" size={10} color={AMBER} />
          <Text style={S.saveBannerText}>
            {dirtyCount} unsaved change{dirtyCount > 1 ? "s" : ""} · Tap Save to confirm
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  loadingText: { fontSize: 14, color: GREY },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: WHITE,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    gap: 10,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 12, backgroundColor: BG,
    justifyContent: "center", alignItems: "center",
  },
  headerText: { flex: 1 },
  headerTitle: { fontSize: 16, fontWeight: "800", color: DARK },
  headerSub: { fontSize: 11, color: GREY, marginTop: 2 },

  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: PRIMARY,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: WHITE, fontWeight: "700", fontSize: 13 },

  weekNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: WHITE,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  weekArrow: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: PRIMARY_SOFT,
    justifyContent: "center", alignItems: "center",
  },
  weekArrowDisabled: { backgroundColor: BG },
  weekLabel: { fontSize: 15, fontWeight: "700", color: DARK },

  legend: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: WHITE,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendDot: { width: 18, height: 18, borderRadius: 5, justifyContent: "center", alignItems: "center" },
  legendText: { fontSize: 11, color: GREY },
  legendHint: { marginLeft: "auto", fontSize: 10, color: BORDER, fontStyle: "italic" },

  tableScroll: { flex: 1 },

  headerRow: {
    flexDirection: "row",
    backgroundColor: "#F8FAFC",
    borderBottomWidth: 2,
    borderBottomColor: BORDER,
  },
  nameCol: {
    width: 130,
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: "center",
    borderRightWidth: 1,
    borderRightColor: BORDER,
  },
  colHeaderText: { fontSize: 12, fontWeight: "800", color: GREY, textTransform: "uppercase", letterSpacing: 0.5 },
  dateCol: {
    width: CELL_W,
    alignItems: "center",
    paddingVertical: 8,
    borderRightWidth: 1,
    borderRightColor: BORDER,
  },
  dateTodayCol: { backgroundColor: PRIMARY_SOFT },
  dayText: { fontSize: 10, fontWeight: "700", color: GREY, textTransform: "uppercase" },
  dateText: { fontSize: 13, fontWeight: "700", color: DARK, marginTop: 2 },
  checkAllBtn: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 2,
    borderColor: GREEN, marginTop: 4, justifyContent: "center", alignItems: "center",
  },
  checkAllBtnActive: { backgroundColor: GREEN, borderColor: GREEN },
  checkAllEmpty: { width: 10, height: 10 },

  bodyScroll: { maxHeight: 560 },
  studentRowR: {
    flexDirection: "row",
    height: ROW_H,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    backgroundColor: WHITE,
  },
  studentRowAlt: { backgroundColor: "#FAFAFA" },
  rollText: { fontSize: 10, fontWeight: "700", color: PRIMARY },
  nameText: { fontSize: 13, fontWeight: "600", color: DARK, marginTop: 1 },

  cell: {
    width: CELL_W,
    height: ROW_H,
    justifyContent: "center",
    alignItems: "center",
    borderRightWidth: 1,
    borderRightColor: BORDER,
    position: "relative",
  },
  cellFuture: { backgroundColor: "#FAFAFA" },
  cellFutureText: { fontSize: 16, color: BORDER },
  cellDirty: { borderWidth: 1.5, borderColor: AMBER },
  emptyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: BORDER },
  dirtyDot: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: AMBER,
  },

  saveBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FFFBEB",
    borderTopWidth: 1,
    borderTopColor: "#FEF3C7",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  saveBannerText: { fontSize: 13, color: AMBER, fontWeight: "600" },

  // OD cell — locked, purple tint
  cellOD: {
    borderWidth: 1,
    borderColor: "#7C3AED" + "44",
  },
  cellODLabel: {
    fontSize: 8,
    fontWeight: "800",
    color: "#7C3AED",
    letterSpacing: 0.5,
    marginTop: 1,
  },
});