// screens/reports/teacher/AttendanceReport.tsx — one student's attendance in one subject.
// Used by the teacher (StudentReportDetail, isTeacher) and by the student app (isTeacher false).

import React, { useMemo, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { apiFetch } from "../../../services/api";
import AttendanceCalendar from "../../../components/AttendanceCalendar";
import { Banner, Button, Card, Chip, EmptyState, ProgressBar, SectionLabel, Segmented, SP, T, TextField, Tone, font } from "../../../components/ui";
import { API_URL, IconName, LoadBoundary, StatRow, attTone, enc, fmtDate, num, toYMD, useReport } from "./ReportShared";

interface Props {
  studentUid: string;
  studentName: string;
  subjectId: string;
  subjectName?: string;
  teacherId: string;
  courseId?: string;
  isTeacher?: boolean;
}

type FilterMode = "all" | "date" | "range";
type Picker = "from" | "to" | "manualStart" | "manualEnd" | null;

const STATUS: Record<string, { tone: Tone; icon: IconName; label: string }> = {
  present: { tone: "success", icon: "checkmark-circle", label: "Present" },
  absent: { tone: "danger", icon: "close-circle", label: "Absent" },
  late: { tone: "warning", icon: "time", label: "Late" },
  od: { tone: "primary", icon: "shield-checkmark", label: "On duty" },
};
const MSG: Record<string, string> = {
  success: "Attendance is satisfactory.",
  warning: "Attendance is below 75%.",
  danger: "Critical: attendance is very low.",
  neutral: "No attendance recorded yet.",
};

export default function AttendanceReport({ studentUid, studentName, subjectId, subjectName, teacherId, courseId, isTeacher }: Props) {
  const navigation = useNavigation<any>();
  const today = toYMD(new Date());

  const [mode, setMode] = useState<FilterMode>("all");
  const [fromDate, setFromDate] = useState<string | null>(null);
  const [toDate, setToDate] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker>(null);

  const [manualOpen, setManualOpen] = useState(false);
  const [mStart, setMStart] = useState("");
  const [mEnd, setMEnd] = useState("");
  const [mStatus, setMStatus] = useState<"present" | "absent">("present");
  const [mNote, setMNote] = useState("");
  const [mError, setMError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The summary always covers everything; the date filter only narrows the record list.
  const rangeInvalid = mode === "range" && !!fromDate && !!toDate && toDate < fromDate;
  const url = useMemo(() => {
    if (!studentUid || !subjectId || !teacherId || rangeInvalid) return null;
    let u = `${API_URL}/api/reports/student/${enc(studentUid)}/attendance?teacher_id=${enc(teacherId)}&subject_id=${enc(subjectId)}`;
    if (mode === "date" && fromDate) u += `&from_date=${fromDate}&to_date=${fromDate}`;
    if (mode === "range") {
      if (fromDate) u += `&from_date=${fromDate}`;
      if (toDate) u += `&to_date=${toDate}`;
    }
    return u;
  }, [studentUid, subjectId, teacherId, mode, fromDate, toDate, rangeInvalid]);
  const report = useReport(url);

  const records: any[] = report.data?.records ?? [];
  const summary = report.data?.summary ?? {};
  const pct: number | null = summary.percentage ?? null;
  const tone = attTone(pct);
  const odCount = num(summary.od, records.filter((r) => r.status === "od").length);

  const changeMode = (m: FilterMode) => {
    setMode(m);
    if (m === "all") {
      setFromDate(null);
      setToDate(null);
    } else if (m === "date") setToDate(null);
  };

  const onPick = (sel: { year: number; month: number; date: number }) => {
    const ymd = `${sel.year}-${String(sel.month).padStart(2, "0")}-${String(sel.date).padStart(2, "0")}`;
    if (picker === "from") setFromDate(ymd);
    else if (picker === "to") setToDate(ymd);
    else if (picker === "manualStart") {
      setMStart(ymd);
      if (mEnd && mEnd < ymd) setMEnd("");
    } else if (picker === "manualEnd") setMEnd(ymd);
    setPicker(null);
  };

  const closeManual = () => {
    setManualOpen(false);
    setPicker(null);
    setMError(null);
  };

  const saveManual = async () => {
    setMError(null);
    if (!mStart) return setMError("Choose a start date.");
    if (mStart > today || (mEnd && mEnd > today)) return setMError("You cannot mark attendance for a future date.");
    if (mEnd && mEnd < mStart) return setMError("The end date cannot be before the start date.");
    setSaving(true);
    try {
      const body: any = { teacher_id: teacherId, subject_id: subjectId, student_uid: studentUid, date: mStart, status: mStatus, note: mNote.trim() || null };
      if (mEnd) body.end_date = mEnd;
      const res = await apiFetch(`${API_URL}/api/reports/attendance/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let json: any = null;
      try {
        json = JSON.parse(await res.text());
      } catch {}
      if (!res.ok || !json?.success) return setMError(json?.error || "Could not save attendance.");
      closeManual();
      setMStart("");
      setMEnd("");
      setMNote("");
      setMStatus("present");
      Alert.alert("Saved", json.message || "Attendance updated.");
      report.reload(true);
    } catch {
      setMError("Could not reach the server. Check your connection.");
    } finally {
      setSaving(false);
    }
  };

  const manualPreview = !mStart ? null : mEnd && mEnd >= mStart ? `Marking ${fmtDate(mStart)} to ${fmtDate(mEnd)} (Sundays skipped)` : `Marking ${fmtDate(mStart)}`;

  return (
    <View style={{ gap: SP.md }}>
      <LoadBoundary report={report} label="Loading attendance">
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View>
              <Text style={{ fontSize: 38, fontWeight: "800", letterSpacing: -1, color: tone === "neutral" ? T.ink : T[tone] }}>{pct != null ? `${pct}%` : "-"}</Text>
              <Text style={font.small}>
                {num(summary.present)} present of {num(summary.total_lectures)} classes
              </Text>
            </View>
            {report.loading && <ActivityIndicator color={T.primary} />}
          </View>
          <View style={{ marginTop: SP.md, gap: 6 }}>
            <ProgressBar value={pct != null ? pct / 100 : 0} tone={tone === "neutral" ? "primary" : tone} height={8} />
            <Text style={[font.small, { color: tone === "neutral" ? T.muted : T[tone], fontWeight: "700" }]}>{MSG[tone]}</Text>
          </View>
        </Card>

        <StatRow
          items={[
            { value: num(summary.present), label: "Present", tone: "success" },
            { value: num(summary.absent), label: "Absent", tone: "danger" },
            ...(num(summary.late) > 0 ? [{ value: num(summary.late), label: "Late", tone: "warning" as Tone }] : []),
            ...(odCount > 0 ? [{ value: odCount, label: "On duty", tone: "primary" as Tone }] : []),
          ]}
        />

        {isTeacher ? (
          <>
            <ActionRow
              icon="shield-checkmark-outline"
              label="View OD requests"
              badge={odCount > 0 ? `${odCount} approved` : undefined}
              onPress={() => navigation.navigate("ODRequestsTeacher", { teacherId, subjectId, subjectName: subjectName || subjectId, courseId: courseId || "" })}
            />
            <Button label="Add or edit attendance manually" icon="create-outline" variant="secondary" onPress={() => setManualOpen(true)} />
          </>
        ) : (
          <ActionRow
            icon="shield-checkmark-outline"
            label="Request OD leave"
            badge={odCount > 0 ? `${odCount} approved` : undefined}
            onPress={() => navigation.navigate("ODLeaveRequest", { studentUid, studentName, subjectId, subjectName: subjectName || subjectId, teacherId, courseId: courseId || "" })}
          />
        )}

        <SectionLabel style={{ marginTop: SP.sm, marginBottom: 0 }}>Records</SectionLabel>
        <Segmented<FilterMode>
          options={[{ value: "all", label: "All" }, { value: "date", label: "By date" }, { value: "range", label: "Range" }]}
          value={mode}
          onChange={changeMode}
        />

        {mode === "date" && (
          <DateButton value={fromDate} placeholder="Choose a date" onPress={() => setPicker("from")} onClear={fromDate ? () => setFromDate(null) : undefined} />
        )}
        {mode === "range" && (
          <View style={{ flexDirection: "row", gap: SP.sm }}>
            <View style={{ flex: 1 }}>
              <DateButton value={fromDate} placeholder="From" onPress={() => setPicker("from")} onClear={fromDate ? () => setFromDate(null) : undefined} />
            </View>
            <View style={{ flex: 1 }}>
              <DateButton value={toDate} placeholder="To" onPress={() => setPicker("to")} onClear={toDate ? () => setToDate(null) : undefined} />
            </View>
          </View>
        )}
        {rangeInvalid && <Banner tone="danger">The end date is before the start date.</Banner>}

        {records.length === 0 ? (
          <EmptyState icon="calendar-outline" title="No records" text={mode === "all" ? "Nothing has been recorded yet." : "No records in this period."} />
        ) : (
          <View style={{ gap: SP.sm }}>
            <Text style={font.small}>
              {records.length} record{records.length === 1 ? "" : "s"}
              {mode !== "all" ? " in this period" : ""}
            </Text>
            {records.map((r, i) => {
              const cfg = STATUS[r.status] ?? STATUS.absent;
              return (
                <Card key={r.attendance_id || `${r.date}-${i}`} style={{ paddingVertical: SP.md }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md }}>
                    <View style={{ flex: 1 }}>
                      <Text style={font.h3}>{fmtDate(r.date, true)}</Text>
                      {r.marked_by === "manual" && <Text style={[font.small, { color: T.primary, marginTop: 2 }]}>Entered manually</Text>}
                      {!!r.note && (
                        <Text style={[font.small, { marginTop: 2 }]} numberOfLines={2}>
                          {r.note}
                        </Text>
                      )}
                    </View>
                    <Chip label={cfg.label} tone={cfg.tone} icon={cfg.icon} />
                  </View>
                </Card>
              );
            })}
            {odCount > 0 && <Text style={font.small}>On duty days count towards {isTeacher ? "the student's" : "your"} attendance.</Text>}
          </View>
        )}
      </LoadBoundary>

      {/* Date filter picker */}
      <Modal visible={picker === "from" || picker === "to"} transparent animationType="fade" onRequestClose={() => setPicker(null)}>
        <CalendarSheet title={picker === "to" ? "Choose end date" : mode === "date" ? "Choose date" : "Choose start date"} onClose={() => setPicker(null)} onSelect={onPick} />
      </Modal>

      {/* Manual attendance (teacher only). The calendar swaps in inside this same modal, so modals are never nested. */}
      <Modal visible={manualOpen} transparent animationType="slide" onRequestClose={closeManual}>
        {picker === "manualStart" || picker === "manualEnd" ? (
          <CalendarSheet title={picker === "manualStart" ? "Choose start date" : "Choose end date"} onClose={() => setPicker(null)} onSelect={onPick} />
        ) : (
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.5)", justifyContent: "flex-end" }}>
            <View style={{ backgroundColor: T.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, maxHeight: "90%" }}>
              <ScrollView contentContainerStyle={{ padding: SP.xl, gap: SP.lg, paddingBottom: 36 }} keyboardShouldPersistTaps="handled">
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={font.h2}>Manual attendance</Text>
                    <Text style={[font.small, { marginTop: 2 }]}>{studentName}</Text>
                  </View>
                  <Pressable onPress={closeManual} hitSlop={10} accessibilityLabel="Close">
                    <Ionicons name="close" size={24} color={T.ink} />
                  </Pressable>
                </View>

                <Banner tone="info" icon="information-circle-outline">
                  Only days on which a lecture was held can be marked. Other days in a range are skipped.
                </Banner>

                <View>
                  <Text style={fieldLabel}>Start date</Text>
                  <DateButton value={mStart || null} placeholder="Choose start date" onPress={() => setPicker("manualStart")} />
                </View>
                <View>
                  <Text style={fieldLabel}>End date (optional)</Text>
                  <DateButton value={mEnd || null} placeholder="Single day only" onPress={() => setPicker("manualEnd")} onClear={mEnd ? () => setMEnd("") : undefined} />
                </View>
                {!!manualPreview && <Banner tone="primary" icon="information-circle-outline">{manualPreview}</Banner>}

                <View>
                  <Text style={fieldLabel}>Status</Text>
                  <Segmented<"present" | "absent"> options={[{ value: "present", label: "Present", icon: "checkmark" }, { value: "absent", label: "Absent", icon: "close" }]} value={mStatus} onChange={setMStatus} />
                </View>

                <TextField label="Note (optional)" value={mNote} onChangeText={setMNote} placeholder="Reason or remark" multiline minHeight={72} autoCapitalize="sentences" autoCorrect maxLength={200} />

                {!!mError && <Banner tone="danger">{mError}</Banner>}
                <Button label="Save attendance" icon="checkmark" onPress={saveManual} loading={saving} />
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        )}
      </Modal>
    </View>
  );
}

const fieldLabel = { fontSize: 12.5, fontWeight: "700" as const, color: T.sub, marginBottom: 7 };

function DateButton({ value, placeholder, onPress, onClear }: { value: string | null; placeholder: string; onPress: () => void; onClear?: () => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: T.surface, borderWidth: 1.5, borderColor: T.line, borderRadius: 14, minHeight: 50 }}>
      <Pressable onPress={onPress} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 12 }} accessibilityRole="button">
        <Ionicons name="calendar-outline" size={17} color={T.muted} />
        <Text style={{ fontSize: 14, color: value ? T.ink : T.muted }} numberOfLines={1}>
          {value ? fmtDate(value) : placeholder}
        </Text>
      </Pressable>
      {onClear && (
        <Pressable onPress={onClear} hitSlop={8} style={{ paddingHorizontal: 12 }} accessibilityLabel="Clear date">
          <Ionicons name="close-circle" size={18} color={T.muted} />
        </Pressable>
      )}
    </View>
  );
}

function ActionRow({ icon, label, badge, onPress }: { icon: IconName; label: string; badge?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: SP.md, backgroundColor: T.primarySoft, borderRadius: 14, padding: SP.lg }, pressed && { opacity: 0.7 }]}>
      <Ionicons name={icon} size={18} color={T.primary} />
      <Text style={{ flex: 1, fontSize: 14, fontWeight: "700", color: T.primary }}>{label}</Text>
      {!!badge && <Chip label={badge} tone="primary" />}
      <Ionicons name="chevron-forward" size={16} color={T.primary} />
    </Pressable>
  );
}

function CalendarSheet({ title, onClose, onSelect }: { title: string; onClose: () => void; onSelect: (s: { year: number; month: number; date: number }) => void }) {
  return (
    <View style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.5)", justifyContent: "center", padding: SP.xl }}>
      <View style={{ backgroundColor: T.surface, borderRadius: 22, padding: SP.lg, gap: SP.md }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={[font.h3, { flex: 1 }]}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close calendar">
            <Ionicons name="close" size={22} color={T.ink} />
          </Pressable>
        </View>
        <AttendanceCalendar onDateSelect={onSelect} />
      </View>
    </View>
  );
}