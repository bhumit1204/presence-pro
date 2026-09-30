import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

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

const API_URL = "http://10.132.90.56:5000";

type ReportSection = "quiz" | "assignments" | "attendance";

export default function ExportReport() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { student, subject, teacher_id } = route.params;
  const subjectId = (subject as any)?.subject_id || "";

  const [selectedSections, setSelectedSections] = useState<ReportSection[]>(["quiz", "assignments", "attendance"]);
  const [generating, setGenerating] = useState(false);
  const [quizData, setQuizData] = useState<any>(null);
  const [assignData, setAssignData] = useState<any>(null);
  const [attendanceData, setAttendanceData] = useState<any>(null);
  const [loadingData, setLoadingData] = useState(true);

  useEffect(() => { fetchAllData(); }, []);

  const fetchAllData = async () => {
    try {
      setLoadingData(true);
      const [qRes, aRes, atRes] = await Promise.all([
        fetch(`${API_URL}/api/reports/student/${student.uid}/quiz?teacher_id=${teacher_id}&subject_id=${subjectId}`),
        fetch(`${API_URL}/api/reports/student/${student.uid}/assignments?teacher_id=${teacher_id}&subject_id=${subjectId}`),
        fetch(`${API_URL}/api/reports/student/${student.uid}/attendance?teacher_id=${teacher_id}&subject_id=${subjectId}`),
      ]);
      const [q, a, at] = await Promise.all([qRes.json(), aRes.json(), atRes.json()]);
      if (q.success) setQuizData(q);
      if (a.success) setAssignData(a);
      if (at.success) setAttendanceData(at);
    } catch (e) {
      console.log("EXPORT FETCH:", e);
    } finally {
      setLoadingData(false);
    }
  };

  const toggleSection = (section: ReportSection) => {
    setSelectedSections((prev) =>
      prev.includes(section) ? prev.filter((s) => s !== section) : [...prev, section]
    );
  };

  const generatePDF = async () => {
    if (selectedSections.length === 0) {
      Alert.alert("Select Sections", "Please select at least one section to export.");
      return;
    }
    try {
      setGenerating(true);
      const html = buildHTML();
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      await Sharing.shareAsync(uri, {
        mimeType: "application/pdf",
        dialogTitle: `${student.name} - Report`,
        UTI: "com.adobe.pdf",
      });
    } catch (e) {
      Alert.alert("Error", "Failed to generate PDF. Please try again.");
      console.log("PDF ERROR:", e);
    } finally {
      setGenerating(false);
    }
  };

  const buildHTML = (): string => {
    const today = new Date().toLocaleDateString("en-IN", {
      day: "numeric", month: "long", year: "numeric",
    });

    const quizHTML = selectedSections.includes("quiz") && quizData ? buildQuizSection() : "";
    const assignHTML = selectedSections.includes("assignments") && assignData ? buildAssignSection() : "";
    const attHTML = selectedSections.includes("attendance") && attendanceData ? buildAttendanceSection() : "";

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Student Report — ${student.name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #111827; background: #fff; font-size: 13px; }
    
    /* Header */
    .report-header { background: linear-gradient(135deg, #4834D4 0%, #7C3AED 100%); color: white; padding: 36px 40px; }
    .report-title { font-size: 26px; font-weight: 800; margin-bottom: 6px; letter-spacing: -0.5px; }
    .report-subtitle { font-size: 13px; opacity: 0.85; }
    .report-meta { margin-top: 20px; display: flex; gap: 28px; }
    .meta-item { }
    .meta-label { font-size: 10px; font-weight: 700; opacity: 0.7; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px; }
    .meta-value { font-size: 14px; font-weight: 700; }
    
    /* Body */
    .body { padding: 32px 40px; }
    
    /* Section */
    .section { margin-bottom: 36px; }
    .section-title { font-size: 16px; font-weight: 800; color: #111827; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid #4834D4; display: flex; align-items: center; gap: 8px; }
    .section-title-dot { width: 8px; height: 8px; background: #4834D4; border-radius: 50%; display: inline-block; }
    
    /* Summary Chips */
    .summary-grid { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .summary-chip { flex: 1; min-width: 80px; background: #F3F4F6; border-radius: 12px; padding: 14px 16px; text-align: center; }
    .chip-num { font-size: 22px; font-weight: 800; }
    .chip-label { font-size: 10px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
    .chip-primary { background: #EEF2FF; color: #4834D4; }
    .chip-green { background: #F0FDF4; color: #10B981; }
    .chip-amber { background: #FEF3C7; color: #F59E0B; }
    .chip-red { background: #FEF2F2; color: #EF4444; }
    
    /* Table */
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    thead { background: #F9FAFB; }
    th { padding: 10px 14px; text-align: left; font-size: 11px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #E5E7EB; }
    td { padding: 11px 14px; font-size: 13px; color: #374151; border-bottom: 1px solid #F3F4F6; }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) { background: #FAFAFA; }
    
    /* Status Badges */
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-green { background: #D1FAE5; color: #065F46; }
    .badge-amber { background: #FEF3C7; color: #92400E; }
    .badge-red { background: #FEE2E2; color: #991B1B; }
    .badge-blue { background: #EEF2FF; color: #4834D4; }
    .badge-grey { background: #F3F4F6; color: #4B5563; }
    
    /* Attendance Bar */
    .att-bar-wrap { width: 200px; background: #E5E7EB; border-radius: 4px; height: 8px; overflow: hidden; display: inline-block; vertical-align: middle; margin-left: 10px; }
    .att-bar-fill { height: 100%; border-radius: 4px; }
    
    /* Footer */
    .footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #E5E7EB; display: flex; justify-content: space-between; color: #9CA3AF; font-size: 11px; }
    
    @media print {
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <!-- HEADER -->
  <div class="report-header">
    <div class="report-title">📋 Student Academic Report</div>
    <div class="report-subtitle">Generated on ${today}</div>
    <div class="report-meta">
      <div class="meta-item">
        <div class="meta-label">Student Name</div>
        <div class="meta-value">${student.name}</div>
      </div>
      ${student.roll_no ? `<div class="meta-item"><div class="meta-label">Roll No</div><div class="meta-value">${student.roll_no}</div></div>` : ""}
      <div class="meta-item">
        <div class="meta-label">Subject</div>
        <div class="meta-value">${subject?.subject_name || "—"}</div>
      </div>
      ${student.course_name ? `<div class="meta-item"><div class="meta-label">Course</div><div class="meta-value">${student.course_name}</div></div>` : ""}
      ${student.semester ? `<div class="meta-item"><div class="meta-label">Semester</div><div class="meta-value">${student.semester}</div></div>` : ""}
    </div>
  </div>

  <div class="body">
    ${quizHTML}
    ${assignHTML}
    ${attHTML}

    <!-- FOOTER -->
    <div class="footer">
      <span>PresencePro Academic Report System</span>
      <span>Confidential — For Institutional Use Only</span>
    </div>
  </div>
</body>
</html>`;
  };

  const buildQuizSection = (): string => {
    const { summary, quizzes } = quizData;
    const rows = quizzes.map((q: any) => `
      <tr>
        <td>${q.title}</td>
        <td>${new Date(q.scheduled_start).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td>
        <td>${q.question_count}</td>
        <td>${q.total_marks}</td>
        <td>${q.submission ? q.submission.marks_obtained : "—"}</td>
        <td>${q.submission ? `${q.submission.percentage}%` : "—"}</td>
        <td><span class="badge ${q.status === "attempted" ? "badge-green" : q.status === "missed" ? "badge-red" : "badge-amber"}">${q.status === "attempted" ? "Attempted" : q.status === "missed" ? "Missed" : "Upcoming"}</span></td>
      </tr>
    `).join("");

    return `
    <div class="section">
      <div class="section-title"><span class="section-title-dot"></span> Quiz Performance</div>
      <div class="summary-grid">
        <div class="summary-chip chip-primary"><div class="chip-num">${summary.attempted}/${summary.total_quizzes}</div><div class="chip-label">Attempted</div></div>
        <div class="summary-chip chip-amber"><div class="chip-num">${summary.skipped}</div><div class="chip-label">Missed</div></div>
        <div class="summary-chip chip-green"><div class="chip-num">${summary.avg_percentage != null ? summary.avg_percentage + "%" : "—"}</div><div class="chip-label">Avg Score</div></div>
      </div>
      <table>
        <thead>
          <tr><th>Quiz Title</th><th>Date</th><th>Questions</th><th>Total Marks</th><th>Scored</th><th>Percentage</th><th>Status</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  };

  const buildAssignSection = (): string => {
    const { summary, assignments } = assignData;
    const rows = assignments.map((a: any) => `
      <tr>
        <td>${a.title}</td>
        <td>${new Date(a.due_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td>
        <td>${a.marks}</td>
        <td>${a.submission?.marks_obtained != null ? a.submission.marks_obtained : "—"}</td>
        <td>${a.submission?.submitted_at ? new Date(a.submission.submitted_at).toLocaleDateString("en-IN") : "—"}</td>
        <td><span class="badge ${
          a.display_status === "graded" ? "badge-green" :
          a.display_status === "submitted" ? "badge-blue" :
          a.display_status === "late" ? "badge-amber" :
          a.display_status === "missed" ? "badge-red" : "badge-grey"
        }">${a.display_status}</span></td>
        <td>${a.submission?.feedback || "—"}</td>
      </tr>
    `).join("");

    return `
    <div class="section">
      <div class="section-title"><span class="section-title-dot"></span> Assignment Report</div>
      <div class="summary-grid">
        <div class="summary-chip chip-primary"><div class="chip-num">${summary.submitted}/${summary.total}</div><div class="chip-label">Submitted</div></div>
        <div class="summary-chip chip-amber"><div class="chip-num">${summary.skipped}</div><div class="chip-label">Skipped</div></div>
        <div class="summary-chip chip-amber"><div class="chip-num">${summary.late}</div><div class="chip-label">Late</div></div>
        <div class="summary-chip chip-green"><div class="chip-num">${summary.avg_marks != null ? summary.avg_marks : "—"}</div><div class="chip-label">Avg Marks</div></div>
      </div>
      <table>
        <thead>
          <tr><th>Assignment Title</th><th>Due Date</th><th>Total Marks</th><th>Scored</th><th>Submitted On</th><th>Status</th><th>Feedback</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  };

  const buildAttendanceSection = (): string => {
    const { summary, records } = attendanceData;
    const pct = summary.percentage ?? 0;
    const pctColor = pct >= 75 ? "#10B981" : pct >= 50 ? "#F59E0B" : "#EF4444";

    const rows = records.map((r: any) => `
      <tr>
        <td>${new Date(r.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</td>
        <td><span class="badge ${r.status === "present" ? "badge-green" : r.status === "late" ? "badge-amber" : "badge-red"}">${r.status}</span></td>
        <td>${r.marked_by === "manual" ? "✏️ Manual" : "Auto"}</td>
      </tr>
    `).join("");

    return `
    <div class="section">
      <div class="section-title"><span class="section-title-dot"></span> Attendance Report</div>
      <div class="summary-grid">
        <div class="summary-chip" style="background:#F3F4F6">
          <div class="chip-num" style="color:${pctColor}">${pct}%</div>
          <div class="chip-label">Attendance</div>
        </div>
        <div class="summary-chip chip-green"><div class="chip-num">${summary.present}</div><div class="chip-label">Present</div></div>
        <div class="summary-chip chip-red"><div class="chip-num">${summary.absent}</div><div class="chip-label">Absent</div></div>
        <div class="summary-chip chip-amber"><div class="chip-num">${summary.late ?? 0}</div><div class="chip-label">Late</div></div>
        <div class="summary-chip chip-primary"><div class="chip-num">${summary.total_lectures}</div><div class="chip-label">Total Lectures</div></div>
      </div>
      <div style="margin-bottom:16px; padding:14px; background:#F9FAFB; border-radius:10px; font-size:13px; color:${pctColor}; font-weight:700;">
        ${pct >= 75 ? "✓ Attendance is satisfactory (≥75%)" : pct >= 50 ? "⚠ Attendance is below 75% — improvement needed" : "✗ Critical attendance — immediate action required"}
      </div>
      <table>
        <thead>
          <tr><th>Date</th><th>Status</th><th>Marked By</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  };

  const SECTIONS = [
    { key: "quiz" as ReportSection, label: "Quiz Report", icon: "help-circle-outline", desc: "Quiz scores, attempts, averages" },
    { key: "assignments" as ReportSection, label: "Assignment Report", icon: "document-text-outline", desc: "Submissions, grades, feedback" },
    { key: "attendance" as ReportSection, label: "Attendance Report", icon: "calendar-outline", desc: "Full attendance history & stats" },
  ];

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <View style={S.header}>
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={20} color={DARK} />
        </TouchableOpacity>
        <Text style={S.headerTitle}>Export PDF Report</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={S.scroll} showsVerticalScrollIndicator={false}>
        {/* Student Info */}
        <View style={S.studentCard}>
          <View style={S.avatar}>
            <Text style={S.avatarText}>{student.name?.charAt(0)}</Text>
          </View>
          <View>
            <Text style={S.studentName}>{student.name}</Text>
            <Text style={S.studentMeta}>
              {subject?.subject_name}
              {student.roll_no ? ` · Roll: ${student.roll_no}` : ""}
            </Text>
          </View>
        </View>

        <Text style={S.sectionTitle}>Select Sections to Export</Text>

        {SECTIONS.map((sec) => (
          <TouchableOpacity
            key={sec.key}
            style={[S.sectionCard, selectedSections.includes(sec.key) && S.sectionCardActive]}
            onPress={() => toggleSection(sec.key)}
            activeOpacity={0.8}
          >
            <View style={[S.sectionIcon, selectedSections.includes(sec.key) && { backgroundColor: PRIMARY_SOFT }]}>
              <Ionicons name={sec.icon as any} size={22} color={selectedSections.includes(sec.key) ? PRIMARY : GREY} />
            </View>
            <View style={S.sectionInfo}>
              <Text style={[S.sectionLabel, selectedSections.includes(sec.key) && { color: PRIMARY }]}>
                {sec.label}
              </Text>
              <Text style={S.sectionDesc}>{sec.desc}</Text>
            </View>
            <View style={[S.checkbox, selectedSections.includes(sec.key) && S.checkboxActive]}>
              {selectedSections.includes(sec.key) && (
                <Ionicons name="checkmark" size={14} color={WHITE} />
              )}
            </View>
          </TouchableOpacity>
        ))}

        <TouchableOpacity
          style={[S.exportBtn, (generating || loadingData || selectedSections.length === 0) && { opacity: 0.6 }]}
          onPress={generatePDF}
          disabled={generating || loadingData || selectedSections.length === 0}
        >
          {generating || loadingData ? (
            <ActivityIndicator size="small" color={WHITE} />
          ) : (
            <>
              <Ionicons name="document-outline" size={20} color={WHITE} />
              <Text style={S.exportBtnText}>Generate & Share PDF</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  scroll: { padding: 20 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: WHITE,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: BG,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "800", color: DARK },

  studentCard: {
    backgroundColor: WHITE,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderWidth: 1,
    borderColor: BORDER,
    marginBottom: 24,
    elevation: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: PRIMARY_SOFT,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: { fontSize: 20, fontWeight: "800", color: PRIMARY },
  studentName: { fontSize: 16, fontWeight: "800", color: DARK },
  studentMeta: { fontSize: 12, color: GREY, marginTop: 2 },

  sectionTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: GREY,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 12,
  },

  sectionCard: {
    backgroundColor: WHITE,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderWidth: 1.5,
    borderColor: BORDER,
    marginBottom: 10,
    elevation: 1,
  },
  sectionCardActive: { borderColor: PRIMARY, backgroundColor: "#FAFBFF" },
  sectionIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: BG,
    justifyContent: "center",
    alignItems: "center",
  },
  sectionInfo: { flex: 1 },
  sectionLabel: { fontSize: 14, fontWeight: "700", color: DARK },
  sectionDesc: { fontSize: 12, color: GREY, marginTop: 2 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: BORDER,
    justifyContent: "center",
    alignItems: "center",
  },
  checkboxActive: { backgroundColor: PRIMARY, borderColor: PRIMARY },

  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: PRIMARY,
    borderRadius: 50,
    paddingVertical: 18,
    marginTop: 16,
    elevation: 3,
  },
  exportBtnText: { color: WHITE, fontWeight: "800", fontSize: 16 },
});