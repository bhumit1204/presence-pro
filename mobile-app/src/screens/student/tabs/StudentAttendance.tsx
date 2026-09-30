import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { auth, db } from "../../../services/firebase";
import {
  getDoc,
  doc,
  collection,
  query,
  where,
  getDocs,
} from "firebase/firestore";

// ─── Palette ──────────────────────────────────────────────────────────────────
const PRIMARY      = "#4834D4";
const PRIMARY_SOFT = "#EEF2FF";
const BG           = "#F3F4F6";
const GREEN        = "#10B981";
const GREEN_SOFT   = "#D1FAE5";
const AMBER        = "#F59E0B";
const AMBER_SOFT   = "#FEF3C7";
const RED          = "#EF4444";
const RED_SOFT     = "#FEF2F2";
const GREY         = "#6B7280";
const DARK         = "#111827";
const WHITE        = "#FFFFFF";
const BORDER       = "#E5E7EB";
const OD_COLOR     = "#7C3AED";
const OD_SOFT      = "#EDE9FE";

const API_URL = "http://10.132.90.56:5000";

type TabKey = "overview" | "attendance" | "quizzes" | "assignments" | "od";

interface SubjectAttendance {
  subject_id:   string;
  subject_name: string;
  present:      number;
  absent:       number;
  late:         number;
  total:        number;
  percentage:   number | null;
}

interface QuizItem {
  quiz_id:       string;
  title:         string;
  subject_name:  string;
  total_marks:   number;
  status:        "submitted" | "missed" | "live" | "scheduled";
  marks_obtained?: number;
  percentage?:   number;
  submitted_at?: string;
  scheduled_end: string;
}

interface AssignmentItem {
  assignment_id:   string;
  title:           string;
  subject_name:    string;
  marks:           number;
  due_date:        string;
  status:          "graded" | "submitted" | "late" | "pending" | "missed";
  marks_obtained?: number;
  feedback?:       string | null;
}

interface ReportData {
  attendance:  SubjectAttendance[];
  quizzes:     QuizItem[];
  assignments: AssignmentItem[];
}

// Extra per-subject metadata needed to navigate to ODLeaveRequest
interface SubjectMeta {
  subject_id:   string;
  subject_name: string;
  teacher_id:   string;
  course_id:    string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function pctColor(pct: number | null | undefined) {
  if (pct == null) return GREY;
  if (pct >= 75)   return GREEN;
  if (pct >= 50)   return AMBER;
  return RED;
}

function pctBg(pct: number | null | undefined) {
  if (pct == null) return BG;
  if (pct >= 75)   return GREEN_SOFT;
  if (pct >= 50)   return AMBER_SOFT;
  return RED_SOFT;
}

// ─── Mini progress bar ────────────────────────────────────────────────────────
function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <View style={S.barTrack}>
      <View style={[S.barFill, { width: `${Math.min(pct, 100)}%`, backgroundColor: color }]} />
    </View>
  );
}

// ─── Summary chip ─────────────────────────────────────────────────────────────
function Chip({
  value, label, color, bg,
}: { value: string | number; label: string; color: string; bg: string }) {
  return (
    <View style={[S.chip, { backgroundColor: bg }]}>
      <Text style={[S.chipVal, { color }]}>{value}</Text>
      <Text style={[S.chipLabel, { color }]}>{label}</Text>
    </View>
  );
}

// ─── Chunk helper ─────────────────────────────────────────────────────────────
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function StudentAttendance() {
  const navigation = useNavigation<any>();

  const [activeTab,    setActiveTab]    = useState<TabKey>("overview");
  const [data,         setData]         = useState<ReportData | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [studentName,  setStudentName]  = useState("");
  const [studentUid,   setStudentUid]   = useState("");

  // Per-subject metadata (teacher_id, course_id) for OD navigation
  const [subjectMetas, setSubjectMetas] = useState<SubjectMeta[]>([]);

  // ── Fetch all report data ──────────────────────────────────────────────────
  const fetchAll = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const uid = auth.currentUser?.uid;
      if (!uid) return;
      setStudentUid(uid);

      // ── 1. Student profile ─────────────────────────────────────────────────
      const studentSnap = await getDoc(doc(db, "students", uid));
      if (!studentSnap.exists()) return;
      const studentData    = studentSnap.data();
      const enrolledSubs: string[] = studentData.enrolled_subjects || [];
      const studentCourseId: string = studentData.course_id || "";
      setStudentName(studentData.name || studentData.first_name || "Student");


      // ── 2. Subject names + teacher_id + course_id ──────────────────────────
      const subjectNameMap: Record<string, string>    = {};
      const subjectTeacherMap: Record<string, string> = {};
      const subjectCourseMap: Record<string, string>  = {};

      if (enrolledSubs.length > 0) {
        await Promise.all(enrolledSubs.map(async (sid) => {
          try {
            const snap = await getDoc(doc(db, "subjects", sid));
            if (snap.exists()) {
              const sd = snap.data();
              subjectNameMap[sid]    = sd.subject_name || sd.name || sid;
              subjectTeacherMap[sid] = sd.teacher_assigned || sd.teacher_id || sd.created_by || "";
              subjectCourseMap[sid]  = sd.course_id    || studentCourseId;
            }
          } catch { /* silent */ }
        }));
      }

      // Build SubjectMeta array for OD tab
      const metas: SubjectMeta[] = enrolledSubs.map((sid) => ({
        subject_id:   sid,
        subject_name: subjectNameMap[sid]    || sid,
        teacher_id:   subjectTeacherMap[sid] || "",
        course_id:    subjectCourseMap[sid]  || studentCourseId,
      }));
      setSubjectMetas(metas);

      // ── 3. Attendance ──────────────────────────────────────────────────────
      const attMap: Record<string, { present: number; absent: number; late: number; total: number }> = {};
      enrolledSubs.forEach((sid) => {
        attMap[sid] = { present: 0, absent: 0, late: 0, total: 0 };
      });

      if (enrolledSubs.length > 0) {
        await Promise.all(enrolledSubs.map(async (sid) => {
          try {
            // 3a. Find lectures for this subject
            const lecturesSnap = await getDocs(
              query(collection(db, "lectures"), where("subject_id", "==", sid))
            );
            const lectureIds = lecturesSnap.docs.map((d) => d.id);

            // 3b. Find completed lecture_sessions
            const sessionIds: string[] = [];
            if (lectureIds.length > 0) {
              for (const chunk of chunkArray(lectureIds, 10)) {
                const sessSnap = await getDocs(
                  query(
                    collection(db, "lecture_sessions"),
                    where("lecture_id", "in", chunk),
                    where("status",     "==", "completed")
                  )
                );
                sessSnap.docs.forEach((d) => sessionIds.push(d.id));
              }
            }

            attMap[sid].total = sessionIds.length;

            // 3c. Fetch attendance_records by lecture_session_id
            const seenDocIds = new Set<string>();
            if (sessionIds.length > 0) {
              for (const chunk of chunkArray(sessionIds, 10)) {
                const recSnap = await getDocs(
                  query(
                    collection(db, "attendance_records"),
                    where("student_uid",        "==", uid),
                    where("lecture_session_id", "in", chunk)
                  )
                );
                recSnap.docs.forEach((d) => {
                  if (seenDocIds.has(d.id)) return;
                  seenDocIds.add(d.id);
                  const rd = d.data();
                  if      (rd.status === "present") attMap[sid].present += 1;
                  else if (rd.status === "late")    { attMap[sid].late += 1; attMap[sid].present += 1; }
                  else if (rd.status === "absent")  attMap[sid].absent  += 1;
                });
              }
            }

            // 3d. Manual records
            const manualSnap = await getDocs(
              query(
                collection(db, "attendance_records"),
                where("student_uid", "==", uid),
                where("subject_id",  "==", sid),
                where("source",      "==", "manual")
              )
            );
            manualSnap.docs.forEach((d) => {
              if (seenDocIds.has(d.id)) return;
              seenDocIds.add(d.id);
              const rd = d.data();
              if (!rd.lecture_session_id) attMap[sid].total += 1;
              if      (rd.status === "present") attMap[sid].present += 1;
              else if (rd.status === "late")    { attMap[sid].late += 1; attMap[sid].present += 1; }
              else if (rd.status === "absent")  attMap[sid].absent  += 1;
            });

            // 3e. OD records (approved OD leave — counts as present)
            const odSnap = await getDocs(
              query(
                collection(db, "attendance_records"),
                where("student_uid", "==", uid),
                where("subject_id",  "==", sid),
                where("source",      "==", "od")
              )
            );
            odSnap.docs.forEach((d) => {
              if (seenDocIds.has(d.id)) return;
              seenDocIds.add(d.id);
              // Each OD record = one excused day; add to total and count as present
              attMap[sid].total   += 1;
              attMap[sid].present += 1;
            });

          } catch (e) {
            console.log(`Attendance fetch error for subject ${sid}:`, e);
          }
        }));
      }

      const attendance: SubjectAttendance[] = enrolledSubs.map((sid) => {
        const a   = attMap[sid];
        const pct = a.total > 0
          ? parseFloat(((a.present / a.total) * 100).toFixed(1))
          : null;
        return {
          subject_id:   sid,
          subject_name: subjectNameMap[sid] || sid,
          present:      a.present,
          absent:       a.absent,
          late:         a.late,
          total:        a.total,
          percentage:   pct,
        };
      });

      // ── 4. Quizzes ─────────────────────────────────────────────────────────
      const quizzes: QuizItem[] = [];
      try {
        const qRes  = await fetch(`${API_URL}/api/quizzes/student-quizzes/${uid}`);
        const qData = await qRes.json();
        if (qData.success) {
          const allQ = [
            ...(qData.live      || []).map((q: any) => ({ ...q, _tab: "live"      })),
            ...(qData.scheduled || []).map((q: any) => ({ ...q, _tab: "scheduled" })),
            ...(qData.completed || []).map((q: any) => ({ ...q, _tab: "completed" })),
          ];
          for (const q of allQ) {
            let status: QuizItem["status"];
            if      (q._tab === "completed") status = q.submission ? "submitted" : "missed";
            else if (q._tab === "live")      status = "live";
            else                             status = "scheduled";

            quizzes.push({
              quiz_id:        q.quiz_id,
              title:          q.title,
              subject_name:   q.subject_name || "—",
              total_marks:    q.total_marks,
              status,
              marks_obtained: q.submission?.marks_obtained,
              percentage:     q.submission?.percentage,
              submitted_at:   q.submission?.submitted_at,
              scheduled_end:  q.scheduled_end,
            });
          }
          quizzes.sort((a, b) =>
            new Date(b.scheduled_end).getTime() - new Date(a.scheduled_end).getTime()
          );
        }
      } catch (e) { /* silent */ }

      // ── 5. Assignments ─────────────────────────────────────────────────────
      const assignments: AssignmentItem[] = [];
      try {
        const subRes  = await fetch(`${API_URL}/api/assignments/my-submissions?student_uid=${uid}`);
        const subData = await subRes.json();
        const submitted: any[] = subData.submissions || [];
        const submittedMap: Record<string, any> = {};
        submitted.forEach((s: any) => { submittedMap[s.assignment_id] = s; });

        if (enrolledSubs.length > 0) {
          const courseId = studentCourseId;
          const seen     = new Set<string>();

          for (const chunk of chunkArray(enrolledSubs, 5)) {
            await Promise.all(chunk.map(async (sid) => {
              try {
                const res   = await fetch(`${API_URL}/api/assignments?subject_id=${sid}&course_id=${courseId}&limit=50`);
                const aData = await res.json();
                for (const a of (aData.assignments || [])) {
                  if (seen.has(a.assignment_id)) continue;
                  seen.add(a.assignment_id);
                  const sub  = submittedMap[a.assignment_id];
                  const past = a.due_date && new Date(a.due_date) < new Date();
                  let status: AssignmentItem["status"];
                  if (sub) {
                    status = sub.status === "graded" ? "graded"
                           : sub.status === "late"   ? "late"
                           : "submitted";
                  } else {
                    status = past && !a.allow_late ? "missed" : "pending";
                  }
                  assignments.push({
                    assignment_id:  a.assignment_id,
                    title:          a.title,
                    subject_name:   a.subject_name || subjectNameMap[sid] || "—",
                    marks:          a.marks,
                    due_date:       a.due_date,
                    status,
                    marks_obtained: sub?.marks_obtained,
                    feedback:       sub?.feedback || null,
                  });
                }
              } catch (e) { /* silent per subject */ }
            }));
          }
          assignments.sort((a, b) =>
            new Date(b.due_date).getTime() - new Date(a.due_date).getTime()
          );
        }
      } catch (e) { /* silent */ }

      setData({ attendance, quizzes, assignments });
    } catch (e) {
      console.log("STUDENT REPORT FETCH ERROR:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchAll(); }, [fetchAll]));

  // ── Overview aggregates ───────────────────────────────────────────────────
  const overallAttPct = (() => {
    if (!data?.attendance.length) return null;
    const withData = data.attendance.filter((s) => s.total > 0);
    if (!withData.length) return null;
    const total   = withData.reduce((s, a) => s + a.total,   0);
    const present = withData.reduce((s, a) => s + a.present, 0);
    return total > 0 ? parseFloat(((present / total) * 100).toFixed(1)) : null;
  })();

  const quizAttempted = data?.quizzes.filter((q) => q.status === "submitted").length ?? 0;
  const quizTotal     = data?.quizzes.filter((q) => q.status !== "scheduled" && q.status !== "live").length ?? 0;
  const quizAvgPct    = (() => {
    const done = data?.quizzes.filter((q) => q.percentage != null) ?? [];
    if (!done.length) return null;
    return parseFloat((done.reduce((s, q) => s + (q.percentage ?? 0), 0) / done.length).toFixed(1));
  })();

  const assSubmitted = data?.assignments.filter((a) => a.status !== "pending" && a.status !== "missed").length ?? 0;
  const assTotal     = data?.assignments.length ?? 0;
  const assGraded    = data?.assignments.filter((a) => a.status === "graded") ?? [];
  const assAvgMarks  = assGraded.length
    ? parseFloat((assGraded.reduce((s, a) => s + (a.marks_obtained ?? 0), 0) / assGraded.length).toFixed(1))
    : null;

  // ── Tab config ────────────────────────────────────────────────────────────
  const TABS: { key: TabKey; label: string; icon: string }[] = [
    { key: "overview",    label: "Overview",    icon: "grid-outline"          },
    { key: "attendance",  label: "Attendance",  icon: "calendar-outline"      },
    { key: "quizzes",     label: "Quizzes",     icon: "help-circle-outline"   },
    { key: "assignments", label: "Assignments", icon: "document-text-outline" },
    { key: "od",          label: "OD Leave",    icon: "briefcase-outline"     },
  ];

  // ─── Render tabs ─────────────────────────────────────────────────────────

  const renderOverview = () => (
    <View style={S.section}>
      <View style={S.heroCard}>
        <Text style={S.heroEyebrow}>My Academic Report</Text>
        <Text style={S.heroName}>{studentName}</Text>
        <View style={S.heroRow}>
          <View style={S.heroStat}>
            <Text style={[S.heroStatNum, { color: pctColor(overallAttPct) }]}>
              {overallAttPct != null ? `${overallAttPct}%` : "—"}
            </Text>
            <Text style={S.heroStatLabel}>Attendance</Text>
          </View>
          <View style={S.heroDivider} />
          <View style={S.heroStat}>
            <Text style={[S.heroStatNum, { color: pctColor(quizAvgPct) }]}>
              {quizAvgPct != null ? `${quizAvgPct}%` : "—"}
            </Text>
            <Text style={S.heroStatLabel}>Quiz Avg</Text>
          </View>
          <View style={S.heroDivider} />
          <View style={S.heroStat}>
            <Text style={[S.heroStatNum, { color: assAvgMarks != null ? GREEN : GREY }]}>
              {assAvgMarks != null ? assAvgMarks : "—"}
            </Text>
            <Text style={S.heroStatLabel}>Avg Marks</Text>
          </View>
        </View>
      </View>

      {/* Attendance overview card */}
      <TouchableOpacity style={S.overviewCard} onPress={() => setActiveTab("attendance")} activeOpacity={0.8}>
        <View style={[S.cardAccent, { backgroundColor: pctColor(overallAttPct) }]} />
        <View style={S.cardInner}>
          <View style={S.cardTop}>
            <View style={[S.cardIconWrap, { backgroundColor: pctBg(overallAttPct) }]}>
              <Ionicons name="calendar-outline" size={16} color={pctColor(overallAttPct)} />
            </View>
            <Text style={S.cardTitle}>Attendance</Text>
            <Ionicons name="chevron-forward" size={14} color={GREY} style={{ marginLeft: "auto" }} />
          </View>
          <View style={S.cardStats}>
            <Chip value={overallAttPct != null ? `${overallAttPct}%` : "—"} label="Overall"  color={pctColor(overallAttPct)} bg={pctBg(overallAttPct)} />
            <Chip value={data?.attendance.reduce((s, a) => s + a.present, 0) ?? 0}           label="Present"  color={GREEN}                            bg={GREEN_SOFT}               />
            <Chip value={data?.attendance.reduce((s, a) => s + a.absent,  0) ?? 0}           label="Absent"   color={RED}                              bg={RED_SOFT}                 />
          </View>
          {overallAttPct != null && (
            <View style={{ marginTop: 10, gap: 4 }}>
              <Bar pct={overallAttPct} color={pctColor(overallAttPct)} />
            </View>
          )}
        </View>
      </TouchableOpacity>

      {/* Quiz overview card */}
      <TouchableOpacity style={S.overviewCard} onPress={() => setActiveTab("quizzes")} activeOpacity={0.8}>
        <View style={[S.cardAccent, { backgroundColor: PRIMARY }]} />
        <View style={S.cardInner}>
          <View style={S.cardTop}>
            <View style={[S.cardIconWrap, { backgroundColor: PRIMARY_SOFT }]}>
              <Ionicons name="help-circle-outline" size={16} color={PRIMARY} />
            </View>
            <Text style={S.cardTitle}>Quizzes</Text>
            <Ionicons name="chevron-forward" size={14} color={GREY} style={{ marginLeft: "auto" }} />
          </View>
          <View style={S.cardStats}>
            <Chip value={`${quizAttempted}/${quizTotal}`}                                       label="Attempted" color={PRIMARY}            bg={PRIMARY_SOFT}            />
            <Chip value={quizAvgPct != null ? `${quizAvgPct}%` : "—"}                          label="Avg Score" color={pctColor(quizAvgPct)} bg={pctBg(quizAvgPct)}  />
            <Chip value={data?.quizzes.filter((q) => q.status === "missed").length ?? 0}        label="Missed"    color={RED}                  bg={RED_SOFT}            />
          </View>
          {quizTotal > 0 && (
            <View style={{ marginTop: 10, gap: 4 }}>
              <Bar pct={(quizAttempted / quizTotal) * 100} color={PRIMARY} />
            </View>
          )}
        </View>
      </TouchableOpacity>

      {/* Assignment overview card */}
      <TouchableOpacity style={S.overviewCard} onPress={() => setActiveTab("assignments")} activeOpacity={0.8}>
        <View style={[S.cardAccent, { backgroundColor: AMBER }]} />
        <View style={S.cardInner}>
          <View style={S.cardTop}>
            <View style={[S.cardIconWrap, { backgroundColor: AMBER_SOFT }]}>
              <Ionicons name="document-text-outline" size={16} color={AMBER} />
            </View>
            <Text style={S.cardTitle}>Assignments</Text>
            <Ionicons name="chevron-forward" size={14} color={GREY} style={{ marginLeft: "auto" }} />
          </View>
          <View style={S.cardStats}>
            <Chip value={`${assSubmitted}/${assTotal}`}                                                    label="Submitted" color={AMBER}                            bg={AMBER_SOFT}                           />
            <Chip value={assAvgMarks ?? "—"}                                                               label="Avg Marks" color={assAvgMarks != null ? GREEN : GREY} bg={assAvgMarks != null ? GREEN_SOFT : BG} />
            <Chip value={data?.assignments.filter((a) => a.status === "missed").length ?? 0}               label="Missed"    color={RED}                                bg={RED_SOFT}                             />
          </View>
          {assTotal > 0 && (
            <View style={{ marginTop: 10, gap: 4 }}>
              <Bar pct={(assSubmitted / assTotal) * 100} color={AMBER} />
            </View>
          )}
        </View>
      </TouchableOpacity>

      {/* OD overview card */}
      <TouchableOpacity style={S.overviewCard} onPress={() => setActiveTab("od")} activeOpacity={0.8}>
        <View style={[S.cardAccent, { backgroundColor: OD_COLOR }]} />
        <View style={S.cardInner}>
          <View style={S.cardTop}>
            <View style={[S.cardIconWrap, { backgroundColor: OD_SOFT }]}>
              <Ionicons name="briefcase-outline" size={16} color={OD_COLOR} />
            </View>
            <Text style={S.cardTitle}>OD Leave</Text>
            <Ionicons name="chevron-forward" size={14} color={GREY} style={{ marginLeft: "auto" }} />
          </View>
          <Text style={S.odOverviewDesc}>
            Apply for on-duty leave per subject. Tap to manage your OD requests.
          </Text>
        </View>
      </TouchableOpacity>
    </View>
  );

  const renderAttendance = () => {
    const subjects = data?.attendance ?? [];
    if (!subjects.length) return <EmptyState icon="calendar-outline" text="No attendance data yet" />;

    const withData     = subjects.filter((s) => s.total > 0);
    const totalPresent = withData.reduce((sum, s) => sum + s.present, 0);
    const totalClasses = withData.reduce((sum, s) => sum + s.total,   0);
    const overallPct   = totalClasses > 0 ? Math.round((totalPresent / totalClasses) * 100) : null;

    return (
      <View style={S.section}>
        <View style={[S.attSummaryCard, { borderLeftColor: pctColor(overallPct) }]}>
          <View style={{ flex: 1 }}>
            <Text style={S.attSummaryLabel}>Overall Attendance</Text>
            <Text style={[S.attSummaryPct, { color: pctColor(overallPct) }]}>
              {overallPct != null ? `${overallPct}%` : "—"}
            </Text>
            <Text style={[S.attSummaryStatus, { color: pctColor(overallPct) }]}>
              {overallPct == null  ? "No data"
               : overallPct >= 75  ? "On Track ✓"
               : overallPct >= 50  ? "Needs Attention ⚠"
               :                    "Critical — attend more classes"}
            </Text>
          </View>
          <View style={S.attSummaryRight}>
            <Text style={[S.attSummaryBigNum, { color: pctColor(overallPct) }]}>{totalPresent}</Text>
            <Text style={S.attSummarySmall}>/ {totalClasses} classes</Text>
          </View>
        </View>

        {subjects.map((s) => {
          const color  = pctColor(s.percentage);
          const bg     = pctBg(s.percentage);
          const pct    = s.percentage;
          const needed = pct != null && pct < 75 && s.total > 0
            ? Math.max(0, Math.ceil((0.75 * (s.total + 1) - s.present) / 0.25))
            : 0;

          return (
            <View key={s.subject_id} style={S.attSubCard}>
              <View style={S.attSubTop}>
                <Text style={S.attSubName} numberOfLines={2}>{s.subject_name}</Text>
                <View style={[S.attPctBadge, { backgroundColor: bg }]}>
                  <Text style={[S.attPctText, { color }]}>
                    {pct != null ? `${pct}%` : "—"}
                  </Text>
                </View>
              </View>

              <View style={S.attBarTrack}>
                <View style={[S.attBarFill, { width: `${Math.min(pct ?? 0, 100)}%`, backgroundColor: color }]} />
                <View style={S.attBarMarker} />
              </View>
              <Text style={S.attBarHint}>75% required</Text>

              <View style={S.attStatRow}>
                <View style={S.attStatItem}>
                  <Text style={[S.attStatNum, { color: GREEN }]}>{s.present}</Text>
                  <Text style={S.attStatLabel}>Present</Text>
                </View>
                <View style={S.attStatDivider} />
                <View style={S.attStatItem}>
                  <Text style={[S.attStatNum, { color: RED }]}>{s.absent}</Text>
                  <Text style={S.attStatLabel}>Absent</Text>
                </View>
                {s.late > 0 && (
                  <>
                    <View style={S.attStatDivider} />
                    <View style={S.attStatItem}>
                      <Text style={[S.attStatNum, { color: AMBER }]}>{s.late}</Text>
                      <Text style={S.attStatLabel}>Late</Text>
                    </View>
                  </>
                )}
                <View style={S.attStatDivider} />
                <View style={S.attStatItem}>
                  <Text style={[S.attStatNum, { color: GREY }]}>{s.total}</Text>
                  <Text style={S.attStatLabel}>Total</Text>
                </View>
              </View>

              {pct != null && pct < 75 && (
                <View style={S.attWarnRow}>
                  <Ionicons name="warning-outline" size={13} color={RED} />
                  <Text style={S.attWarnText}>
                    Attend {needed} more class{needed !== 1 ? "es" : ""} to reach 75%
                  </Text>
                </View>
              )}
            </View>
          );
        })}
      </View>
    );
  };

  const renderQuizzes = () => {
    const quizzes = data?.quizzes ?? [];
    if (!quizzes.length) return <EmptyState icon="help-circle-outline" text="No quizzes yet" />;

    const attempted = quizzes.filter((q) => q.status === "submitted").length;
    const missed    = quizzes.filter((q) => q.status === "missed").length;

    return (
      <View style={S.section}>
        <View style={S.chipRow}>
          <Chip value={attempted}                                     label="Attempted" color={GREEN}               bg={GREEN_SOFT}            />
          <Chip value={missed}                                        label="Missed"    color={RED}                 bg={RED_SOFT}              />
          <Chip value={quizAvgPct != null ? `${quizAvgPct}%` : "—"} label="Avg Score" color={pctColor(quizAvgPct)} bg={pctBg(quizAvgPct)}   />
        </View>

        {quizzes.map((q) => {
          const statusCfg = {
            submitted: { color: GREEN,   bg: GREEN_SOFT,   label: "Attempted" },
            missed:    { color: RED,     bg: RED_SOFT,     label: "Missed"    },
            live:      { color: GREEN,   bg: GREEN_SOFT,   label: "Live"      },
            scheduled: { color: PRIMARY, bg: PRIMARY_SOFT, label: "Upcoming"  },
          }[q.status];

          return (
            <View key={q.quiz_id} style={S.listCard}>
              <View style={S.listCardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={S.listCardTitle} numberOfLines={1}>{q.title}</Text>
                  <Text style={S.listCardSub}>{q.subject_name}</Text>
                </View>
                <View style={[S.statusBadge, { backgroundColor: statusCfg.bg }]}>
                  <Text style={[S.statusBadgeText, { color: statusCfg.color }]}>{statusCfg.label}</Text>
                </View>
              </View>

              {q.status === "submitted" && q.marks_obtained != null && (
                <View style={S.resultRow}>
                  <View style={S.resultItem}>
                    <Text style={S.resultLabel}>Marks</Text>
                    <Text style={S.resultVal}>{q.marks_obtained}/{q.total_marks}</Text>
                  </View>
                  <View style={S.resultItem}>
                    <Text style={S.resultLabel}>Score</Text>
                    <Text style={[S.resultVal, { color: pctColor(q.percentage) }]}>
                      {q.percentage != null ? `${q.percentage}%` : "—"}
                    </Text>
                  </View>
                  {q.submitted_at && (
                    <View style={S.resultItem}>
                      <Text style={S.resultLabel}>Submitted</Text>
                      <Text style={S.resultVal}>{fmtDate(q.submitted_at)}</Text>
                    </View>
                  )}
                </View>
              )}

              {q.status === "missed" && (
                <View style={S.missedBanner}>
                  <Ionicons name="close-circle-outline" size={13} color={RED} />
                  <Text style={S.missedText}>Not attempted · 0/{q.total_marks}</Text>
                </View>
              )}

              {(q.status === "live" || q.status === "scheduled") && (
                <View style={S.upcomingBanner}>
                  <Ionicons name="time-outline" size={13} color={PRIMARY} />
                  <Text style={S.upcomingText}>
                    {q.status === "live" ? "Live now" : `Until ${fmtDate(q.scheduled_end)}`}
                  </Text>
                </View>
              )}
            </View>
          );
        })}
      </View>
    );
  };

  const renderAssignments = () => {
    const assignments = data?.assignments ?? [];
    if (!assignments.length) return <EmptyState icon="document-text-outline" text="No assignments yet" />;

    return (
      <View style={S.section}>
        <View style={S.chipRow}>
          <Chip value={`${assSubmitted}/${assTotal}`}                                            label="Submitted" color={AMBER}                            bg={AMBER_SOFT}                           />
          <Chip value={assAvgMarks ?? "—"}                                                       label="Avg Marks" color={assAvgMarks != null ? GREEN : GREY} bg={assAvgMarks != null ? GREEN_SOFT : BG} />
          <Chip value={assignments.filter((a) => a.status === "missed").length}                  label="Missed"    color={RED}                                bg={RED_SOFT}                             />
        </View>

        {assignments.map((a) => {
          const statusCfg = {
            graded:    { color: GREEN,   bg: GREEN_SOFT,   label: "Graded"    },
            submitted: { color: PRIMARY, bg: PRIMARY_SOFT, label: "Submitted" },
            late:      { color: AMBER,   bg: AMBER_SOFT,   label: "Late"      },
            pending:   { color: GREY,    bg: BG,           label: "Pending"   },
            missed:    { color: RED,     bg: RED_SOFT,     label: "Missed"    },
          }[a.status];

          return (
            <View key={a.assignment_id} style={S.listCard}>
              <View style={S.listCardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={S.listCardTitle} numberOfLines={1}>{a.title}</Text>
                  <Text style={S.listCardSub}>{a.subject_name}</Text>
                </View>
                <View style={[S.statusBadge, { backgroundColor: statusCfg.bg }]}>
                  <Text style={[S.statusBadgeText, { color: statusCfg.color }]}>{statusCfg.label}</Text>
                </View>
              </View>

              <View style={{ flexDirection: "row", gap: 8 }}>
                <Text style={S.listCardSub}>Due: {fmtDate(a.due_date)}</Text>
                <Text style={S.listCardSub}>·</Text>
                <Text style={S.listCardSub}>Marks: {a.marks}</Text>
              </View>

              {a.status === "graded" && a.marks_obtained != null && (
                <View style={S.gradeBox}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <View style={S.gradeLeft}>
                      <Text style={S.gradeLabel}>Score</Text>
                      <Text style={[S.gradeMarks, { color: pctColor((a.marks_obtained / a.marks) * 100) }]}>
                        {a.marks_obtained}/{a.marks}
                      </Text>
                    </View>
                  </View>
                  {a.feedback && (
                    <View style={S.feedbackBox}>
                      <Text style={S.feedbackLabel}>Feedback</Text>
                      <Text style={S.feedbackText}>{a.feedback}</Text>
                    </View>
                  )}
                </View>
              )}

              {a.status === "missed" && (
                <View style={S.missedBanner}>
                  <Ionicons name="close-circle-outline" size={13} color={RED} />
                  <Text style={S.missedText}>Not submitted · deadline passed</Text>
                </View>
              )}

              {(a.status === "submitted" || a.status === "late") && (
                <View style={S.upcomingBanner}>
                  <Ionicons name="checkmark-circle-outline" size={13} color={PRIMARY} />
                  <Text style={S.upcomingText}>Submitted · grading pending</Text>
                </View>
              )}
            </View>
          );
        })}
      </View>
    );
  };

  // ── OD Leave tab ──────────────────────────────────────────────────────────
  const renderOD = () => {
    if (!subjectMetas.length) {
      return <EmptyState icon="briefcase-outline" text="No subjects enrolled yet" />;
    }

    return (
      <View style={S.section}>
        {/* Info banner */}
        <View style={S.odInfoBanner}>
          <Ionicons name="information-circle-outline" size={20} color={OD_COLOR} />
          <Text style={S.odInfoText}>
            Submit an on-duty leave request per subject. Your teacher will review
            and approve or reject it. Approved ODs are automatically reflected in
            your attendance.
          </Text>
        </View>

        {subjectMetas.map((meta) => {
          const canApply = !!meta.teacher_id; // guard: subject must have a teacher assigned
          return (
            <View key={meta.subject_id} style={S.odSubjectCard}>
              {/* Subject info row */}
              <View style={S.odSubjectTop}>
                <View style={S.odSubjectIconWrap}>
                  <Ionicons name="book-outline" size={20} color={OD_COLOR} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={S.odSubjectName} numberOfLines={2}>
                    {meta.subject_name}
                  </Text>
                  {!canApply && (
                    <Text style={S.odNoTeacher}>No teacher assigned</Text>
                  )}
                </View>
              </View>

              {/* Apply button */}
              <TouchableOpacity
                style={[S.odApplyBtn, !canApply && S.odApplyBtnDisabled]}
                activeOpacity={canApply ? 0.8 : 1}
                onPress={() => {
                  if (!canApply) return;
                  navigation.navigate("ODLeaveRequest", {
                    studentUid:  studentUid,
                    studentName: studentName,
                    subjectId:   meta.subject_id,
                    subjectName: meta.subject_name,
                    teacherId:   meta.teacher_id,
                    courseId:    meta.course_id,
                  });
                }}
              >
                <Ionicons
                  name="add-circle-outline"
                  size={18}
                  color={canApply ? WHITE : GREY}
                />
                <Text style={[S.odApplyBtnText, !canApply && { color: GREY }]}>
                  {canApply ? "Apply / View OD Requests" : "Unavailable"}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
    );
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Main render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <View style={S.header}>
        <Text style={S.headerTitle}>My Reports</Text>
        <Text style={S.headerSub}>Academic performance overview</Text>
      </View>

      <View style={S.tabBar}>
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[S.tabItem, active && S.tabItemActive]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Ionicons name={tab.icon as any} size={15} color={active ? PRIMARY : GREY} />
              <Text style={[S.tabLabel, active && S.tabLabelActive]}>{tab.label}</Text>
              {active && <View style={S.tabUnderline} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={S.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
          <Text style={S.loadingText}>Loading your report…</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={S.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); fetchAll(true); }}
              colors={[PRIMARY]}
            />
          }
        >
          {activeTab === "overview"    && renderOverview()}
          {activeTab === "attendance"  && renderAttendance()}
          {activeTab === "quizzes"     && renderQuizzes()}
          {activeTab === "assignments" && renderAssignments()}
          {activeTab === "od"          && renderOD()}
          <View style={{ height: 100 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={S.empty}>
      <Ionicons name={icon} size={46} color={BORDER} />
      <Text style={S.emptyText}>{text}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: BG },
  scroll:      { padding: 16, paddingTop: 12, paddingBottom: 24 },
  center:      { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  loadingText: { fontSize: 13, color: GREY, fontWeight: "500" },

  header:      { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, backgroundColor: WHITE, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTitle: { fontSize: 24, fontWeight: "800", color: DARK },
  headerSub:   { fontSize: 13, color: GREY, marginTop: 2 },

  tabBar:         { flexDirection: "row", backgroundColor: WHITE, borderBottomWidth: 1, borderBottomColor: BORDER, paddingHorizontal: 4 },
  tabItem:        { flex: 1, flexDirection: "column", alignItems: "center", paddingVertical: 10, gap: 3, position: "relative" },
  tabItemActive:  {},
  tabLabel:       { fontSize: 10, fontWeight: "600", color: GREY },
  tabLabelActive: { color: PRIMARY, fontWeight: "700" },
  tabUnderline:   { position: "absolute", bottom: 0, left: 10, right: 10, height: 2, backgroundColor: PRIMARY, borderRadius: 2 },

  section: { gap: 12 },

  barTrack: { height: 5, backgroundColor: BORDER, borderRadius: 3, overflow: "hidden" },
  barFill:  { height: "100%", borderRadius: 3 },

  chip:      { flex: 1, borderRadius: 12, padding: 10, alignItems: "center", gap: 2 },
  chipVal:   { fontSize: 18, fontWeight: "800" },
  chipLabel: { fontSize: 10, fontWeight: "600" },
  chipRow:   { flexDirection: "row", gap: 8 },

  heroCard:       { backgroundColor: DARK, borderRadius: 20, padding: 20, gap: 16 },
  heroEyebrow:    { fontSize: 11, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 1 },
  heroName:       { fontSize: 22, fontWeight: "800", color: WHITE, marginTop: -8 },
  heroRow:        { flexDirection: "row", alignItems: "center" },
  heroStat:       { flex: 1, alignItems: "center", gap: 4 },
  heroStatNum:    { fontSize: 22, fontWeight: "800" },
  heroStatLabel:  { fontSize: 11, color: GREY, fontWeight: "600" },
  heroDivider:    { width: 1, height: 36, backgroundColor: "#2E3A52" },

  overviewCard: { backgroundColor: WHITE, borderRadius: 16, flexDirection: "row", overflow: "hidden", borderWidth: 1, borderColor: BORDER, elevation: 1, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 6 },
  cardAccent:   { width: 4, alignSelf: "stretch" },
  cardInner:    { flex: 1, padding: 16 },
  cardTop:      { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  cardIconWrap: { width: 28, height: 28, borderRadius: 8, justifyContent: "center", alignItems: "center" },
  cardTitle:    { fontSize: 14, fontWeight: "700", color: DARK },
  cardStats:    { flexDirection: "row", gap: 8 },
  odOverviewDesc: { fontSize: 12, color: GREY, lineHeight: 18, marginTop: -4 },

  attSummaryCard:   { backgroundColor: "#FFF", borderRadius: 16, padding: 18, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderLeftWidth: 5, borderWidth: 1, borderColor: "#E5E7EB", marginBottom: 4 },
  attSummaryLabel:  { fontSize: 12, color: "#6B7280", fontWeight: "600", marginBottom: 4 },
  attSummaryPct:    { fontSize: 38, fontWeight: "800", lineHeight: 42 },
  attSummaryStatus: { fontSize: 12, fontWeight: "700", marginTop: 4 },
  attSummaryRight:  { alignItems: "center" },
  attSummaryBigNum: { fontSize: 28, fontWeight: "800" },
  attSummarySmall:  { fontSize: 12, color: "#6B7280", marginTop: 2 },

  attSubCard:  { backgroundColor: "#FFF", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#E5E7EB", gap: 10 },
  attSubTop:   { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  attSubName:  { fontSize: 15, fontWeight: "700", color: "#111827", flex: 1, marginRight: 10 },
  attPctBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, minWidth: 54, alignItems: "center" },
  attPctText:  { fontSize: 14, fontWeight: "800" },

  attBarTrack:  { height: 8, backgroundColor: "#E5E7EB", borderRadius: 4, overflow: "visible", position: "relative" },
  attBarFill:   { height: "100%" as any, borderRadius: 4 },
  attBarMarker: { position: "absolute", left: "75%" as any, top: -3, width: 2, height: 14, backgroundColor: "#6B7280", borderRadius: 1 },
  attBarHint:   { fontSize: 10, color: "#6B7280", textAlign: "right" },

  attStatRow:     { flexDirection: "row", alignItems: "center" },
  attStatItem:    { flex: 1, alignItems: "center" },
  attStatDivider: { width: 1, height: 28, backgroundColor: "#E5E7EB" },
  attStatNum:     { fontSize: 18, fontWeight: "800" },
  attStatLabel:   { fontSize: 10, color: "#6B7280", fontWeight: "600", marginTop: 2 },

  attWarnRow:  { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FEF2F2", borderRadius: 8, padding: 8 },
  attWarnText: { fontSize: 12, color: "#EF4444", fontWeight: "600", flex: 1 },

  listCard:      { backgroundColor: WHITE, borderRadius: 14, padding: 14, gap: 10, borderWidth: 1, borderColor: BORDER, elevation: 1 },
  listCardTop:   { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  listCardTitle: { fontSize: 14, fontWeight: "700", color: DARK },
  listCardSub:   { fontSize: 12, color: GREY, marginTop: 2 },

  statusBadge:     { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
  statusBadgeText: { fontSize: 11, fontWeight: "700" },

  resultRow:   { flexDirection: "row", justifyContent: "space-between", backgroundColor: BG, borderRadius: 10, padding: 10 },
  resultItem:  { alignItems: "center" },
  resultLabel: { fontSize: 10, color: GREY, fontWeight: "600" },
  resultVal:   { fontSize: 14, fontWeight: "800", color: DARK, marginTop: 3 },

  missedBanner: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: RED_SOFT, borderRadius: 8, padding: 8 },
  missedText:   { fontSize: 12, color: RED, fontWeight: "600" },

  upcomingBanner: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: PRIMARY_SOFT, borderRadius: 8, padding: 8 },
  upcomingText:   { fontSize: 12, color: PRIMARY, fontWeight: "600" },

  gradeBox:      { backgroundColor: BG, borderRadius: 10, padding: 12, gap: 8 },
  gradeLeft:     { gap: 4 },
  gradeLabel:    { fontSize: 10, color: GREY, fontWeight: "700", textTransform: "uppercase" },
  gradeMarks:    { fontSize: 20, fontWeight: "800" },
  feedbackBox:   { borderTopWidth: 1, borderTopColor: BORDER, paddingTop: 8, gap: 3 },
  feedbackLabel: { fontSize: 10, color: GREY, fontWeight: "700", textTransform: "uppercase" },
  feedbackText:  { fontSize: 13, color: DARK, lineHeight: 18 },

  empty:     { paddingVertical: 60, alignItems: "center", gap: 12 },
  emptyText: { fontSize: 14, color: GREY, fontWeight: "600" },

  // ── OD Leave tab ──────────────────────────────────────────────────────────
  odInfoBanner: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: OD_SOFT,
    borderRadius: 14,
    padding: 14,
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: OD_COLOR + "33",
  },
  odInfoText: { flex: 1, fontSize: 13, color: "#4C1D95", lineHeight: 18 },

  odSubjectCard: {
    backgroundColor: WHITE,
    borderRadius: 16,
    padding: 16,
    gap: 14,
    borderWidth: 1,
    borderColor: BORDER,
    elevation: 1,
  },
  odSubjectTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  odSubjectIconWrap: {
    width: 42, height: 42, borderRadius: 13,
    backgroundColor: OD_SOFT,
    alignItems: "center", justifyContent: "center",
  },
  odSubjectName: { fontSize: 15, fontWeight: "700", color: DARK },
  odNoTeacher:   { fontSize: 11, color: GREY, marginTop: 2 },

  odApplyBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: OD_COLOR,
    borderRadius: 50,
    paddingVertical: 12,
  },
  odApplyBtnDisabled: {
    backgroundColor: BG,
    borderWidth: 1,
    borderColor: BORDER,
  },
  odApplyBtnText: { fontSize: 14, fontWeight: "700", color: WHITE },
});