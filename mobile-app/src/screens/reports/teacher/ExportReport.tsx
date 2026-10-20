// screens/reports/teacher/ExportReport.tsx — build a PDF of a student's report and share it.
// Fixes: names/titles were pasted into the HTML unescaped (broke the PDF and allowed markup injection),
// OD and late days were printed as "absent", failed sections were silently left out, emoji in the PDF.

import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { apiFetch } from "../../../services/api";
import { Avatar, Banner, Button, Card, Checkbox, EmptyState, Header, Screen, SectionLabel, SP, T, font } from "../../../components/ui";
import { API_URL, IconName, enc, fmtDate, num } from "./ReportShared";

type Section = "quiz" | "assignments" | "attendance";

const SECTIONS: { key: Section; label: string; desc: string; icon: IconName; path: string }[] = [
  { key: "quiz", label: "Quiz report", desc: "Scores, attempts and averages", icon: "help-circle-outline", path: "quiz" },
  { key: "assignments", label: "Assignment report", desc: "Submissions, grades and feedback", icon: "document-text-outline", path: "assignments" },
  { key: "attendance", label: "Attendance report", desc: "Full attendance history and totals", icon: "calendar-outline", path: "attendance" },
];

/** Escape anything that comes from the database before it goes into HTML. */
const esc = (v: any): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const pctColor = (p: number) => (p >= 75 ? "#0E9F6E" : p >= 60 ? "#C77700" : "#DC2626");

async function loadSection(uid: string, teacherId: string, subjectId: string, path: string): Promise<any> {
  const res = await apiFetch(`${API_URL}/api/reports/student/${enc(uid)}/${path}?teacher_id=${enc(teacherId)}&subject_id=${enc(subjectId)}`);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok || !json?.success) throw new Error(json?.error || `status ${res.status}`);
  return json;
}

export default function ExportReport() {
  const navigation = useNavigation<any>();
  const params = useRoute<any>().params ?? {};
  const { student, subject, teacher_id } = params;
  const subjectId: string = subject?.subject_id || "";

  const [selected, setSelected] = useState<Section[]>(["quiz", "assignments", "attendance"]);
  const [data, setData] = useState<Partial<Record<Section, any>>>({});
  const [failed, setFailed] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!student?.uid || !teacher_id || !subjectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const results = await Promise.allSettled(SECTIONS.map((s) => loadSection(student.uid, teacher_id, subjectId, s.path)));
    const next: Partial<Record<Section, any>> = {};
    const bad: Section[] = [];
    results.forEach((r, i) => (r.status === "fulfilled" ? (next[SECTIONS[i].key] = r.value) : bad.push(SECTIONS[i].key)));
    setData(next);
    setFailed(bad);
    setSelected((cur) => cur.filter((k) => !bad.includes(k)));
    setLoading(false);
  }, [student?.uid, teacher_id, subjectId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const toggle = (k: Section) => setSelected((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  const generate = async () => {
    if (generating) return;
    if (selected.length === 0) return Alert.alert("Choose a section", "Select at least one section to export.");
    setGenerating(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Sharing unavailable", "This device cannot share files.");
        return;
      }
      const { uri } = await Print.printToFileAsync({ html: buildHTML(), base64: false });
      await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `${student?.name ?? "Student"} - report`, UTI: "com.adobe.pdf" });
    } catch {
      Alert.alert("Could not create the PDF", "Please try again.");
    } finally {
      setGenerating(false);
    }
  };

  /* ───────────── PDF ───────────── */
  const buildQuiz = (): string => {
    const { summary = {}, quizzes = [] } = data.quiz ?? {};
    const rows = quizzes
      .map((q: any) => {
        const cls = q.status === "attempted" ? "green" : q.status === "missed" ? "red" : "amber";
        const lbl = q.status === "attempted" ? "Attempted" : q.status === "missed" ? "Missed" : "Upcoming";
        return `<tr><td>${esc(q.title)}</td><td>${esc(fmtDate(q.scheduled_start))}</td><td>${esc(q.question_count ?? "-")}</td><td>${esc(q.total_marks ?? "-")}</td><td>${q.submission ? esc(q.submission.marks_obtained) : "-"}</td><td>${q.submission && q.submission.percentage != null ? esc(q.submission.percentage) + "%" : "-"}</td><td><span class="badge ${cls}">${lbl}</span></td></tr>`;
      })
      .join("");
    return `<div class="section"><div class="stitle">Quiz performance</div>
      <div class="chips">${chip(`${num(summary.attempted)}/${num(summary.total_quizzes)}`, "Attempted", "primary")}${chip(num(summary.skipped), "Missed", "amber")}${chip(summary.avg_percentage != null ? summary.avg_percentage + "%" : "-", "Avg score", "green")}</div>
      <table><thead><tr><th>Quiz</th><th>Date</th><th>Questions</th><th>Total</th><th>Scored</th><th>Score</th><th>Status</th></tr></thead><tbody>${rows || `<tr><td colspan="7">No quizzes yet.</td></tr>`}</tbody></table></div>`;
  };

  const buildAssignments = (): string => {
    const { summary = {}, assignments = [] } = data.assignments ?? {};
    const rows = assignments
      .map((a: any) => {
        const st = a.display_status;
        const cls = st === "graded" ? "green" : st === "submitted" ? "blue" : st === "late" ? "amber" : st === "missed" ? "red" : "grey";
        return `<tr><td>${esc(a.title)}</td><td>${esc(fmtDate(a.due_date))}</td><td>${esc(a.marks ?? "-")}</td><td>${a.submission?.marks_obtained != null ? esc(a.submission.marks_obtained) : "-"}</td><td>${a.submission?.submitted_at ? esc(fmtDate(a.submission.submitted_at)) : "-"}</td><td><span class="badge ${cls}">${esc(st)}</span></td><td>${esc(a.submission?.feedback || "-")}</td></tr>`;
      })
      .join("");
    return `<div class="section"><div class="stitle">Assignments</div>
      <div class="chips">${chip(`${num(summary.submitted)}/${num(summary.total)}`, "Submitted", "primary")}${chip(num(summary.skipped), "Skipped", "red")}${chip(num(summary.late), "Late", "amber")}${chip(summary.avg_marks != null ? summary.avg_marks : "-", "Avg marks", "green")}</div>
      <table><thead><tr><th>Assignment</th><th>Due</th><th>Total</th><th>Scored</th><th>Submitted</th><th>Status</th><th>Feedback</th></tr></thead><tbody>${rows || `<tr><td colspan="7">No assignments yet.</td></tr>`}</tbody></table></div>`;
  };

  const buildAttendance = (): string => {
    const { summary = {}, records = [] } = data.attendance ?? {};
    const p = summary.percentage ?? 0;
    const note = summary.percentage == null ? "No attendance recorded yet." : p >= 75 ? "Attendance is satisfactory (75% or above)." : p >= 60 ? "Attendance is below 75%. Improvement needed." : "Critical attendance. Immediate action required.";
    const rows = records
      .map((r: any) => {
        const cls = r.status === "present" ? "green" : r.status === "od" ? "blue" : r.status === "late" ? "amber" : "red";
        const lbl = r.status === "od" ? "On duty" : r.status;
        return `<tr><td>${esc(fmtDate(r.date, true))}</td><td><span class="badge ${cls}">${esc(lbl)}</span></td><td>${r.marked_by === "manual" ? "Manual" : "Automatic"}</td><td>${esc(r.note || "")}</td></tr>`;
      })
      .join("");
    return `<div class="section"><div class="stitle">Attendance</div>
      <div class="chips"><div class="chip"><div class="num" style="color:${pctColor(p)}">${summary.percentage != null ? esc(p) + "%" : "-"}</div><div class="lbl">Attendance</div></div>${chip(num(summary.present), "Present", "green")}${chip(num(summary.absent), "Absent", "red")}${num(summary.late) > 0 ? chip(num(summary.late), "Late", "amber") : ""}${num(summary.od) > 0 ? chip(num(summary.od), "On duty", "blue") : ""}${chip(num(summary.total_lectures), "Classes", "primary")}</div>
      <div class="note" style="color:${pctColor(p)}">${note}</div>
      <table><thead><tr><th>Date</th><th>Status</th><th>Entered</th><th>Note</th></tr></thead><tbody>${rows || `<tr><td colspan="4">No records.</td></tr>`}</tbody></table></div>`;
  };

  const chip = (v: any, l: string, c: string) => `<div class="chip ${c}"><div class="num">${esc(v)}</div><div class="lbl">${esc(l)}</div></div>`;

  const buildHTML = (): string => {
    const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const meta = (l: string, v: any) => (v ? `<div class="meta"><div class="ml">${esc(l)}</div><div class="mv">${esc(v)}</div></div>` : "");
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Student report</title><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:Helvetica,Arial,sans-serif;color:#0F172A;font-size:13px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .head{background:#4834D4;color:#fff;padding:34px 40px}
      .title{font-size:26px;font-weight:800;margin-bottom:6px}
      .sub{font-size:13px;opacity:.85}
      .metas{margin-top:20px;display:flex;gap:28px;flex-wrap:wrap}
      .ml{font-size:10px;font-weight:700;opacity:.75;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px}
      .mv{font-size:14px;font-weight:700}
      .body{padding:30px 40px}
      .section{margin-bottom:34px}
      .stitle{font-size:16px;font-weight:800;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid #4834D4}
      .chips{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
      .chip{flex:1;min-width:80px;background:#F1F5F9;border-radius:12px;padding:12px 14px;text-align:center}
      .chip .num{font-size:21px;font-weight:800}.chip .lbl{font-size:10px;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
      .chip.primary{background:#EEF0FF;color:#4834D4}.chip.green{background:#DCF5EA;color:#0E9F6E}.chip.amber{background:#FFF3D6;color:#C77700}.chip.red{background:#FDE8E8;color:#DC2626}.chip.blue{background:#E3EDFF;color:#2563EB}
      .note{padding:12px 14px;background:#F8FAFC;border-radius:10px;font-weight:700;margin-bottom:14px}
      table{width:100%;border-collapse:collapse}
      th{padding:9px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #E5E8F0;background:#F8FAFC}
      td{padding:10px 12px;border-bottom:1px solid #F0F2F7;color:#334155}
      tr:nth-child(even) td{background:#FAFBFD}
      .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;text-transform:uppercase}
      .badge.green{background:#DCF5EA;color:#065F46}.badge.amber{background:#FFF3D6;color:#92400E}.badge.red{background:#FDE8E8;color:#991B1B}.badge.blue{background:#E3EDFF;color:#1E40AF}.badge.grey{background:#F0F2F7;color:#475569}
      .foot{margin-top:44px;padding-top:18px;border-top:1px solid #E5E8F0;display:flex;justify-content:space-between;color:#94A3B8;font-size:11px}
    </style></head><body>
      <div class="head"><div class="title">Student academic report</div><div class="sub">Generated on ${esc(today)}</div>
        <div class="metas">${meta("Student", student?.name)}${meta("Roll no", student?.roll_no)}${meta("Subject", subject?.subject_name)}${meta("Course", student?.course_name)}${meta("Semester", student?.semester)}</div></div>
      <div class="body">
        ${selected.includes("quiz") && data.quiz ? buildQuiz() : ""}
        ${selected.includes("assignments") && data.assignments ? buildAssignments() : ""}
        ${selected.includes("attendance") && data.attendance ? buildAttendance() : ""}
        <div class="foot"><span>PresencePro</span><span>Confidential. For institutional use only.</span></div>
      </div></body></html>`;
  };

  if (!student?.uid || !teacher_id || !subjectId) {
    return (
      <Screen>
        <Header title="Export report" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Student not selected" text="Go back and choose a student again." />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Export PDF report" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: 50, gap: SP.md }} showsVerticalScrollIndicator={false}>
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md }}>
            <Avatar name={student.name} tone="primary" size={48} />
            <View style={{ flex: 1 }}>
              <Text style={font.h2} numberOfLines={1}>
                {student.name}
              </Text>
              <Text style={[font.small, { marginTop: 2 }]} numberOfLines={1}>
                {subject?.subject_name}
                {student.roll_no ? ` - Roll ${student.roll_no}` : ""}
              </Text>
            </View>
          </View>
        </Card>

        {failed.length > 0 && (
          <Banner tone="warning" title="Some sections could not be loaded">
            {failed.map((k) => SECTIONS.find((s) => s.key === k)?.label).join(", ")}. Check your connection and retry.
            <Text onPress={fetchAll} style={{ fontWeight: "800", color: T.warning }}>
              {"  "}Retry
            </Text>
          </Banner>
        )}

        <SectionLabel style={{ marginTop: SP.sm, marginBottom: 0 }}>Sections to include</SectionLabel>

        {SECTIONS.map((s) => {
          const on = selected.includes(s.key);
          const bad = failed.includes(s.key);
          return (
            <Pressable key={s.key} disabled={bad || loading} onPress={() => toggle(s.key)} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: bad }} style={({ pressed }) => [pressed && { opacity: 0.8 }, bad && { opacity: 0.45 }]}>
              <Card style={on ? { borderWidth: 1.5, borderColor: T.primary } : undefined}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md }}>
                  <View style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: on ? T.primarySoft : T.lineSoft, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name={s.icon} size={22} color={on ? T.primary : T.sub} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[font.h3, on && { color: T.primary }]}>{s.label}</Text>
                    <Text style={[font.small, { marginTop: 2 }]}>{bad ? "Could not load" : s.desc}</Text>
                  </View>
                  <View pointerEvents="none">
                    <Checkbox checked={on} />
                  </View>
                </View>
              </Card>
            </Pressable>
          );
        })}

        <Button label={loading ? "Loading data" : "Create and share PDF"} icon="document-outline" onPress={generate} loading={generating || loading} disabled={selected.length === 0} style={{ marginTop: SP.sm }} />
      </ScrollView>
    </Screen>
  );
}