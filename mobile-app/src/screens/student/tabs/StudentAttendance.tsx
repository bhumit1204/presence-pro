import { apiFetch, API_BASE } from "../../../services/api";
import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { auth, db } from "../../../services/firebase";
import { getDoc, doc, collection, query, where, getDocs } from "firebase/firestore";
import { Banner, Button, Card, Chip, EmptyState, ProgressBar, Screen, SP, T, TONE, Tone, font } from "../../../components/ui";
import { meantForStudent, rollOf } from "../../../utils/batches";

const API_URL = API_BASE;
const OD_COLOR = "#7C3AED";
const OD_SOFT  = "#EDE9FE";

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
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function pctTone(pct: number | null | undefined): Tone {
  if (pct == null) return "neutral";
  if (pct >= 75)   return "success";
  if (pct >= 50)   return "warning";
  return "danger";
}
const pctColor = (pct: number | null | undefined) => (pct == null ? T.muted : TONE[pctTone(pct)].fg);

// ─── Chunk helper ─────────────────────────────────────────────────────────────
function chunkArray<X>(arr: X[], size: number): X[][] {
  const chunks: X[][] = [];
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
      const myDivision: string | null = studentData.division_id || null;   // a lecture of another division is not mine
      const myRoll = rollOf(studentData);                                  // and a lab batch is decided by the roll number
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
            // only the lectures meant for me: my division, and (for a lab split into batches) my batch
            const lectureIds = lecturesSnap.docs
              .filter((d) => meantForStudent(d.data(), myDivision, myRoll))
              .map((d) => d.id);

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
        const qRes  = await apiFetch(`${API_URL}/api/quizzes/student-quizzes/${uid}`);
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
        const subRes  = await apiFetch(`${API_URL}/api/assignments/my-submissions?student_uid=${uid}`);
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
                const res   = await apiFetch(`${API_URL}/api/assignments?subject_id=${sid}&course_id=${courseId}&limit=50`);
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
                    subject_name:   `${a.subject_name || subjectNameMap[sid] || "—"}${a.kind === "lab_work" ? " · Lab work" : ""}`,
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
  const TABS: { key: TabKey; label: string; icon: any }[] = [
    { key: "overview",    label: "Overview",    icon: "grid-outline"          },
    { key: "attendance",  label: "Attendance",  icon: "calendar-outline"      },
    { key: "quizzes",     label: "Quizzes",     icon: "help-circle-outline"   },
    { key: "assignments", label: "Assignments", icon: "document-text-outline" },
    { key: "od",          label: "OD leave",    icon: "briefcase-outline"     },
  ];

  const MiniStat = ({ value, label, tone }: { value: string | number; label: string; tone: Tone }) => (
    <View style={[S.miniStat, { backgroundColor: TONE[tone].bg }]}>
      <Text style={[S.miniVal, { color: TONE[tone].fg }]}>{value}</Text>
      <Text style={[S.miniLabel, { color: TONE[tone].fg }]}>{label}</Text>
    </View>
  );

  const OverviewCard = ({
    tab, icon, title, tone, children, progress,
  }: { tab: TabKey; icon: any; title: string; tone: Tone; children?: React.ReactNode; progress?: number | null }) => (
    <TouchableOpacity onPress={() => setActiveTab(tab)} activeOpacity={0.8}>
      <Card>
        <View style={S.ovTop}>
          <View style={[S.ovIcon, { backgroundColor: TONE[tone].bg }]}>
            <Ionicons name={icon} size={18} color={TONE[tone].fg} />
          </View>
          <Text style={[font.h3, { flex: 1 }]}>{title}</Text>
          <Ionicons name="chevron-forward" size={16} color={T.muted} />
        </View>
        {children}
        {progress != null && (
          <View style={{ marginTop: SP.md }}>
            <ProgressBar value={progress} tone={tone} />
          </View>
        )}
      </Card>
    </TouchableOpacity>
  );

  // ─── Render tabs ─────────────────────────────────────────────────────────
  const renderOverview = () => (
    <View style={S.section}>
      <View style={S.hero}>
        <Text style={S.heroEyebrow}>My academic report</Text>
        <Text style={S.heroName} numberOfLines={1}>{studentName}</Text>
        <View style={S.heroRow}>
          <View style={S.heroStat}>
            <Text style={[S.heroNum, { color: overallAttPct == null ? "#94A3B8" : overallAttPct >= 75 ? "#34D399" : overallAttPct >= 50 ? "#FBBF24" : "#F87171" }]}>
              {overallAttPct != null ? `${overallAttPct}%` : "-"}
            </Text>
            <Text style={S.heroLabel}>Attendance</Text>
          </View>
          <View style={S.heroDivider} />
          <View style={S.heroStat}>
            <Text style={[S.heroNum, { color: quizAvgPct == null ? "#94A3B8" : quizAvgPct >= 75 ? "#34D399" : quizAvgPct >= 50 ? "#FBBF24" : "#F87171" }]}>
              {quizAvgPct != null ? `${quizAvgPct}%` : "-"}
            </Text>
            <Text style={S.heroLabel}>Quiz avg</Text>
          </View>
          <View style={S.heroDivider} />
          <View style={S.heroStat}>
            <Text style={[S.heroNum, { color: assAvgMarks != null ? "#34D399" : "#94A3B8" }]}>
              {assAvgMarks != null ? assAvgMarks : "-"}
            </Text>
            <Text style={S.heroLabel}>Avg marks</Text>
          </View>
        </View>
      </View>

      <OverviewCard
        tab="attendance" icon="calendar-outline" title="Attendance" tone={pctTone(overallAttPct)}
        progress={overallAttPct != null ? overallAttPct / 100 : null}
      >
        <View style={S.statsRow}>
          <MiniStat value={overallAttPct != null ? `${overallAttPct}%` : "-"} label="Overall" tone={pctTone(overallAttPct)} />
          <MiniStat value={data?.attendance.reduce((s, a) => s + a.present, 0) ?? 0} label="Present" tone="success" />
          <MiniStat value={data?.attendance.reduce((s, a) => s + a.absent, 0) ?? 0} label="Absent" tone="danger" />
        </View>
      </OverviewCard>

      <OverviewCard
        tab="quizzes" icon="help-circle-outline" title="Quizzes" tone="primary"
        progress={quizTotal > 0 ? quizAttempted / quizTotal : null}
      >
        <View style={S.statsRow}>
          <MiniStat value={`${quizAttempted}/${quizTotal}`} label="Attempted" tone="primary" />
          <MiniStat value={quizAvgPct != null ? `${quizAvgPct}%` : "-"} label="Avg score" tone={pctTone(quizAvgPct)} />
          <MiniStat value={data?.quizzes.filter((q) => q.status === "missed").length ?? 0} label="Missed" tone="danger" />
        </View>
      </OverviewCard>

      <OverviewCard
        tab="assignments" icon="document-text-outline" title="Assignments" tone="warning"
        progress={assTotal > 0 ? assSubmitted / assTotal : null}
      >
        <View style={S.statsRow}>
          <MiniStat value={`${assSubmitted}/${assTotal}`} label="Submitted" tone="warning" />
          <MiniStat value={assAvgMarks ?? "-"} label="Avg marks" tone={assAvgMarks != null ? "success" : "neutral"} />
          <MiniStat value={data?.assignments.filter((a) => a.status === "missed").length ?? 0} label="Missed" tone="danger" />
        </View>
      </OverviewCard>

      <TouchableOpacity onPress={() => setActiveTab("od")} activeOpacity={0.8}>
        <Card>
          <View style={S.ovTop}>
            <View style={[S.ovIcon, { backgroundColor: OD_SOFT }]}>
              <Ionicons name="briefcase-outline" size={18} color={OD_COLOR} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={font.h3}>OD leave</Text>
              <Text style={font.small}>Apply for on-duty leave per subject</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={T.muted} />
          </View>
        </Card>
      </TouchableOpacity>
    </View>
  );

  const renderAttendance = () => {
    const subjects = data?.attendance ?? [];
    if (!subjects.length) return <EmptyState icon="calendar-outline" title="No attendance data yet" />;

    const withData     = subjects.filter((s) => s.total > 0);
    const totalPresent = withData.reduce((sum, s) => sum + s.present, 0);
    const totalClasses = withData.reduce((sum, s) => sum + s.total,   0);
    const overallPct   = totalClasses > 0 ? Math.round((totalPresent / totalClasses) * 100) : null;
    const oTone        = pctTone(overallPct);

    return (
      <View style={S.section}>
        <Card tone={oTone}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Text style={font.label}>Overall attendance</Text>
              <Text style={[S.bigPct, { color: TONE[oTone].fg }]}>
                {overallPct != null ? `${overallPct}%` : "-"}
              </Text>
              <Text style={[S.status, { color: TONE[oTone].fg }]}>
                {overallPct == null  ? "No data"
                 : overallPct >= 75  ? "On track"
                 : overallPct >= 50  ? "Needs attention"
                 :                    "Critical: attend more classes"}
              </Text>
            </View>
            <View style={{ alignItems: "center" }}>
              <Text style={[S.sumNum, { color: TONE[oTone].fg }]}>{totalPresent}</Text>
              <Text style={font.small}>of {totalClasses} classes</Text>
            </View>
          </View>
        </Card>

        {subjects.map((s) => {
          const pct    = s.percentage;
          const tone   = pctTone(pct);
          const needed = pct != null && pct < 75 && s.total > 0
            ? Math.max(0, Math.ceil((0.75 * (s.total + 1) - s.present) / 0.25))
            : 0;

          return (
            <Card key={s.subject_id} flat style={{ gap: SP.md }}>
              <View style={S.subTop}>
                <Text style={[font.h3, { flex: 1 }]} numberOfLines={2}>{s.subject_name}</Text>
                <Chip label={pct != null ? `${pct}%` : "-"} tone={tone} />
              </View>

              <View>
                <View style={S.track}>
                  <View style={[S.fill, { width: `${Math.min(pct ?? 0, 100)}%`, backgroundColor: pctColor(pct) }]} />
                  <View style={S.marker} />
                </View>
                <Text style={S.hint}>75% required</Text>
              </View>

              <View style={S.attStatRow}>
                <View style={S.attStat}>
                  <Text style={[S.attNum, { color: T.success }]}>{s.present}</Text>
                  <Text style={font.small}>Present</Text>
                </View>
                <View style={S.vDiv} />
                <View style={S.attStat}>
                  <Text style={[S.attNum, { color: T.danger }]}>{s.absent}</Text>
                  <Text style={font.small}>Absent</Text>
                </View>
                {s.late > 0 && (
                  <>
                    <View style={S.vDiv} />
                    <View style={S.attStat}>
                      <Text style={[S.attNum, { color: T.warning }]}>{s.late}</Text>
                      <Text style={font.small}>Late</Text>
                    </View>
                  </>
                )}
                <View style={S.vDiv} />
                <View style={S.attStat}>
                  <Text style={[S.attNum, { color: T.sub }]}>{s.total}</Text>
                  <Text style={font.small}>Total</Text>
                </View>
              </View>

              {pct != null && pct < 75 && (
                <Banner tone="danger" icon="warning-outline">
                  Attend {needed} more class{needed !== 1 ? "es" : ""} to reach 75%
                </Banner>
              )}
            </Card>
          );
        })}
      </View>
    );
  };

  const renderQuizzes = () => {
    const quizzes = data?.quizzes ?? [];
    if (!quizzes.length) return <EmptyState icon="help-circle-outline" title="No quizzes yet" />;

    const attempted = quizzes.filter((q) => q.status === "submitted").length;
    const missed    = quizzes.filter((q) => q.status === "missed").length;

    return (
      <View style={S.section}>
        <View style={S.statsRow}>
          <MiniStat value={attempted} label="Attempted" tone="success" />
          <MiniStat value={missed} label="Missed" tone="danger" />
          <MiniStat value={quizAvgPct != null ? `${quizAvgPct}%` : "-"} label="Avg score" tone={pctTone(quizAvgPct)} />
        </View>

        {quizzes.map((q) => {
          const statusCfg: Record<QuizItem["status"], { tone: Tone; label: string }> = {
            submitted: { tone: "success", label: "Attempted" },
            missed:    { tone: "danger",  label: "Missed"    },
            live:      { tone: "success", label: "Live"      },
            scheduled: { tone: "primary", label: "Upcoming"  },
          };
          const cfg = statusCfg[q.status];

          return (
            <Card key={q.quiz_id} flat style={{ gap: SP.md }}>
              <View style={S.subTop}>
                <View style={{ flex: 1 }}>
                  <Text style={font.h3} numberOfLines={1}>{q.title}</Text>
                  <Text style={font.small}>{q.subject_name}</Text>
                </View>
                <Chip label={cfg.label} tone={cfg.tone} />
              </View>

              {q.status === "submitted" && q.marks_obtained != null && (
                <View style={S.resultRow}>
                  <View style={S.resultItem}>
                    <Text style={font.small}>Marks</Text>
                    <Text style={S.resultVal}>{q.marks_obtained}/{q.total_marks}</Text>
                  </View>
                  <View style={S.resultItem}>
                    <Text style={font.small}>Score</Text>
                    <Text style={[S.resultVal, { color: pctColor(q.percentage) }]}>
                      {q.percentage != null ? `${q.percentage}%` : "-"}
                    </Text>
                  </View>
                  {q.submitted_at && (
                    <View style={S.resultItem}>
                      <Text style={font.small}>Submitted</Text>
                      <Text style={S.resultVal}>{fmtDate(q.submitted_at)}</Text>
                    </View>
                  )}
                </View>
              )}

              {q.status === "missed" && (
                <Banner tone="danger" icon="close-circle-outline">Not attempted, 0/{q.total_marks}</Banner>
              )}

              {(q.status === "live" || q.status === "scheduled") && (
                <Banner tone="primary" icon="time-outline">
                  {q.status === "live" ? "Live now" : `Until ${fmtDate(q.scheduled_end)}`}
                </Banner>
              )}
            </Card>
          );
        })}
      </View>
    );
  };

  const renderAssignments = () => {
    const assignments = data?.assignments ?? [];
    if (!assignments.length) return <EmptyState icon="document-text-outline" title="No assignments yet" />;

    return (
      <View style={S.section}>
        <View style={S.statsRow}>
          <MiniStat value={`${assSubmitted}/${assTotal}`} label="Submitted" tone="warning" />
          <MiniStat value={assAvgMarks ?? "-"} label="Avg marks" tone={assAvgMarks != null ? "success" : "neutral"} />
          <MiniStat value={assignments.filter((a) => a.status === "missed").length} label="Missed" tone="danger" />
        </View>

        {assignments.map((a) => {
          const statusCfg: Record<AssignmentItem["status"], { tone: Tone; label: string }> = {
            graded:    { tone: "success", label: "Graded"    },
            submitted: { tone: "primary", label: "Submitted" },
            late:      { tone: "warning", label: "Late"      },
            pending:   { tone: "neutral", label: "Pending"   },
            missed:    { tone: "danger",  label: "Missed"    },
          };
          const cfg = statusCfg[a.status];

          return (
            <Card key={a.assignment_id} flat style={{ gap: SP.md }}>
              <View style={S.subTop}>
                <View style={{ flex: 1 }}>
                  <Text style={font.h3} numberOfLines={1}>{a.title}</Text>
                  <Text style={font.small}>{a.subject_name}</Text>
                </View>
                <Chip label={cfg.label} tone={cfg.tone} />
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ionicons name="calendar-outline" size={13} color={T.muted} />
                <Text style={font.small}>Due {fmtDate(a.due_date)}</Text>
                <Text style={font.small}>·</Text>
                <Text style={font.small}>{a.marks} marks</Text>
              </View>

              {a.status === "graded" && a.marks_obtained != null && (
                <View style={S.gradeBox}>
                  <Text style={font.label}>Score</Text>
                  <Text style={[S.gradeMarks, { color: pctColor((a.marks_obtained / a.marks) * 100) }]}>
                    {a.marks_obtained}/{a.marks}
                  </Text>
                  {a.feedback && (
                    <View style={S.feedbackBox}>
                      <Text style={font.label}>Feedback</Text>
                      <Text style={font.body}>{a.feedback}</Text>
                    </View>
                  )}
                </View>
              )}

              {a.status === "missed" && (
                <Banner tone="danger" icon="close-circle-outline">Not submitted, deadline passed</Banner>
              )}

              {(a.status === "submitted" || a.status === "late") && (
                <Banner tone="primary" icon="checkmark-circle-outline">Submitted, grading pending</Banner>
              )}
            </Card>
          );
        })}
      </View>
    );
  };

  // ── OD Leave tab ──────────────────────────────────────────────────────────
  const renderOD = () => {
    if (!subjectMetas.length) {
      return <EmptyState icon="briefcase-outline" title="No subjects enrolled yet" />;
    }

    return (
      <View style={S.section}>
        <Banner tone="info" icon="information-circle-outline">
          Submit an on-duty leave request per subject. Approved ODs show in your attendance.
        </Banner>

        {subjectMetas.map((meta) => {
          const canApply = !!meta.teacher_id; // guard: subject must have a teacher assigned
          return (
            <Card key={meta.subject_id} flat style={{ gap: SP.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md }}>
                <View style={S.odIcon}>
                  <Ionicons name="book-outline" size={20} color={OD_COLOR} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={font.h3} numberOfLines={2}>{meta.subject_name}</Text>
                  {!canApply && <Text style={font.small}>No teacher assigned</Text>}
                </View>
              </View>

              <Button
                label={canApply ? "Apply or view requests" : "Unavailable"}
                icon={canApply ? "add-circle-outline" : undefined}
                size="md"
                disabled={!canApply}
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
              />
            </Card>
          );
        })}
      </View>
    );
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Main render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <Screen edges={["top"]}>
      <View style={S.header}>
        <Text style={font.display}>My reports</Text>
        <Text style={[font.body, { marginTop: 2 }]}>Academic performance</Text>
      </View>

      <View style={{ height: 52 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={S.tabRow}>
          {TABS.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                style={[S.tabItem, active && S.tabItemOn]}
                onPress={() => setActiveTab(tab.key)}
                activeOpacity={0.8}
              >
                <Ionicons name={tab.icon} size={15} color={active ? "#FFF" : T.sub} />
                <Text style={[S.tabLabel, active && { color: "#FFF" }]}>{tab.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {loading ? (
        <View style={S.center}>
          <ActivityIndicator size="large" color={T.primary} />
          <Text style={font.small}>Loading your report</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={S.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); fetchAll(true); }}
              colors={[T.primary]}
            />
          }
        >
          {activeTab === "overview"    && renderOverview()}
          {activeTab === "attendance"  && renderAttendance()}
          {activeTab === "quizzes"     && renderQuizzes()}
          {activeTab === "assignments" && renderAssignments()}
          {activeTab === "od"          && renderOD()}
          <View style={{ height: 120 }} />
        </ScrollView>
      )}
    </Screen>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  header: { paddingHorizontal: SP.xl, paddingTop: SP.lg, paddingBottom: SP.md },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: SP.md },
  scroll: { paddingHorizontal: SP.xl, paddingTop: SP.xs },
  section: { gap: SP.md },

  tabRow:    { paddingHorizontal: SP.xl, gap: SP.sm, alignItems: "center" },
  tabItem:   { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, height: 38, borderRadius: 19, backgroundColor: T.surface, borderWidth: 1, borderColor: T.line },
  tabItemOn: { backgroundColor: T.primary, borderColor: T.primary },
  tabLabel:  { fontSize: 13, fontWeight: "700", color: T.sub },

  hero:        { backgroundColor: T.dark, borderRadius: 22, padding: SP.xl, gap: SP.lg },
  heroEyebrow: { fontSize: 11, fontWeight: "700", color: "#94A3B8", textTransform: "uppercase", letterSpacing: 1 },
  heroName:    { fontSize: 22, fontWeight: "800", color: "#FFF", marginTop: -10 },
  heroRow:     { flexDirection: "row", alignItems: "center" },
  heroStat:    { flex: 1, alignItems: "center", gap: 4 },
  heroNum:     { fontSize: 24, fontWeight: "800" },
  heroLabel:   { fontSize: 11, color: "#94A3B8", fontWeight: "600" },
  heroDivider: { width: 1, height: 36, backgroundColor: "#2A2A3A" },

  ovTop:   { flexDirection: "row", alignItems: "center", gap: SP.md, marginBottom: SP.xs },
  ovIcon:  { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  statsRow:{ flexDirection: "row", gap: SP.sm, marginTop: SP.sm },
  miniStat:{ flex: 1, borderRadius: 14, paddingVertical: 10, alignItems: "center", gap: 2 },
  miniVal: { fontSize: 18, fontWeight: "800" },
  miniLabel:{ fontSize: 10.5, fontWeight: "700" },

  bigPct: { fontSize: 42, fontWeight: "800", lineHeight: 48, marginTop: 2 },
  status: { fontSize: 13, fontWeight: "700" },
  sumNum: { fontSize: 28, fontWeight: "800" },

  subTop: { flexDirection: "row", alignItems: "flex-start", gap: SP.sm },
  track:  { height: 8, backgroundColor: T.line, borderRadius: 4, position: "relative" },
  fill:   { height: "100%", borderRadius: 4 },
  marker: { position: "absolute", left: "75%", top: -3, width: 2, height: 14, backgroundColor: T.sub, borderRadius: 1 },
  hint:   { fontSize: 10.5, color: T.muted, textAlign: "right", marginTop: 4 },

  attStatRow: { flexDirection: "row", alignItems: "center" },
  attStat:    { flex: 1, alignItems: "center", gap: 1 },
  attNum:     { fontSize: 19, fontWeight: "800" },
  vDiv:       { width: 1, height: 28, backgroundColor: T.line },

  resultRow:  { flexDirection: "row", justifyContent: "space-between", backgroundColor: T.bg, borderRadius: 12, padding: SP.md },
  resultItem: { alignItems: "center", gap: 3 },
  resultVal:  { fontSize: 14, fontWeight: "800", color: T.ink },

  gradeBox:    { backgroundColor: T.bg, borderRadius: 12, padding: SP.md, gap: 4 },
  gradeMarks:  { fontSize: 22, fontWeight: "800" },
  feedbackBox: { borderTopWidth: 1, borderTopColor: T.line, paddingTop: SP.sm, marginTop: SP.sm, gap: 3 },

  odIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: OD_SOFT, alignItems: "center", justifyContent: "center" },
});