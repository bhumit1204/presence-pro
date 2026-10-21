import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { onAuthStateChanged } from "firebase/auth";
import { useEffect, useRef, useState } from "react";
import { auth } from "../services/firebase";
import { getUserSession } from "../services/session";
import { registerAndSavePushToken } from "../services/notifications";
import AuthScreen from "../screens/auth/AuthScreen";
import RoleGate from "../screens/auth/RoleGate";
import TeacherDashboard from "../screens/teacher/TeacherDashboard";
import SubjectHub from "../screens/teacher/SubjectHub";
import StudentDashboard from "../screens/student/StudentDashboard";
import StudentRegistration from "../screens/auth/StudentRegistration";
import TeacherRegistration from "../screens/auth/TeacherRegistration";
import VerifyEmailScreen from "../screens/auth/VerifyEmailScreen";
import ForgotPasswordScreen from "../screens/auth/ForgotPasswordScreen";
import CodeAttendanceScreen from "../screens/attendance/teacher/CodeAttendanceScreen";
import BioGeoAttendanceScreen from "../screens/attendance/teacher/BioGeoAttendanceScreen";
import MultiAttendanceScreen from "../screens/attendance/teacher/MultiAttendanceScreen";
import IoTAttendanceScreen from "../screens/attendance/teacher/IoTAttendanceScreen";
import CodeMarkingScreen from "../screens/attendance/student/CodeMarkingScreen";
import BioGeoMarkingScreen from "../screens/attendance/student/BioGeoMarkingScreen";
import MultiMarkingScreen from "../screens/attendance/student/MultiMarkingScreen";
import IoTMarkingScreen from "../screens/attendance/student/IoTMarkingScreen";
import LectureSchedule from "../screens/teacher/tabs/LectureSchedule";
import ManualMarkingScreen from "../screens/attendance/teacher/ManualMarking";
import CreateQuizManual from "../screens/quiz/teacher/CreateQuizManual";
import CreateQuizAI from "../screens/quiz/teacher/CreateQuizAI";
import AIQuizPreview from "../screens/quiz/teacher/AIQuizPreview";
import FinalizeQuiz from "../screens/quiz/teacher/FinalizeQuiz";
import ViewQuiz from "../screens/quiz/teacher/ViewQuiz";
import QRAttendanceScreen from "../screens/attendance/teacher/QRAttendanceScreen";
import StudentJoinQuiz from "../screens/quiz/student/StudentJoinQuiz";
import TakeQuiz from "../screens/quiz/student/TakeQuiz";
import QuizResultScreen from "../screens/quiz/student/QuizResultScreen";
import StudentScheduledQuiz from "../screens/quiz/student/StudentScheduledQuiz";
import StudentQuizResult from "../screens/quiz/student/StudentQuizResult";
import StudentAssignmentDetail from "../screens/work/student/StudentAssignmentDetail";
import TeacherAssignmentDetail from "../screens/work/teacher/TeacherAssignmentDetail";
import CreateAssignment from "../screens/work/teacher/CreateAssignment";
import CreateAnnouncement from "../screens/work/teacher/CreateAnnouncement";
import TeacherSubjectFeed from "../screens/work/teacher/TeacherSubjectFeed";
import TeacherSubjectPicker from "../screens/work/teacher/TeacherSubjectPicker";
import StudentSubjectFeed from "../screens/work/student/StudentSubjectFeed";
import AnnouncementDetail from "../screens/work/teacher/AnnouncementDetail";
import StudentProfile from "../screens/student/tabs/StudentProfile";
import StudentReportDetail from "../screens/reports/teacher/StudentReportDetail";
import ExportReport from "../screens/reports/teacher/ExportReport";
import QRMarkingScreen from "../screens/attendance/student/QRMarkingScreen";
import CreateBroadcast from "../screens/teacher/tabs/CreateBroadcast";
import BroadcastInbox from "../screens/student/tabs/BroadcastInbox";
import ClassReport from "../screens/reports/teacher/ClassReport";
import MarkAttendance from "../screens/reports/teacher/MarkAttendance";
import ODLeaveRequest from "../screens/student/tabs/ODLeaveRequest";
import ElectiveSelection from "../screens/student/tabs/ElectiveSelection";
import StudentTimetable from "../screens/student/StudentTimetable";
import StudentCalendar from "../screens/student/StudentCalendar";
import ODRequestTeacher from "../screens/reports/teacher/ODRequestTeacher";


const Stack = createNativeStackNavigator();
const navRef = createNavigationContainerRef<any>();

// Screens where it is safe to jump to a notification target (user is logged in and past RoleGate)
const READY_ROUTES = new Set(["TeacherDashboard", "StudentDashboard"]);

/** Maps the `data.screen` value sent by the backend to a real route in this navigator. */
async function resolveTarget(data: any): Promise<{ name: string; params?: any } | null> {
  const screen = data?.screen;
  if (!screen) return null;
  if (screen === "BroadcastInbox") return { name: "BroadcastInbox" };
  if (screen === "ElectiveSelection") return { name: "ElectiveSelection" };
  if (screen === "StudentProfile") return { name: "StudentProfile" };

  const session: any = await getUserSession().catch(() => null);
  const role = session?.role;
  const isStudent = role === "student";
  const teacherHome = "TeacherDashboard"; // every teacher-type account uses the same app

  // Tabs inside the dashboards are internal state, so land on the user's own dashboard.
  switch (screen) {
    case "TeacherHome":
      return { name: isStudent ? "StudentDashboard" : teacherHome };
    case "ODRequestsTeacher":
      // teachers land straight on the request list; the Today / Inbox tabs also show the pending count
      return isStudent
        ? { name: "StudentDashboard" }
        : session?.teacher_id
          ? { name: "ODRequestsTeacher", params: { teacherId: session.teacher_id } }
          : { name: teacherHome };
    case "StudentWork":
    case "StudentQuizzes":
    case "StudentAttendance":
      return { name: isStudent || !role ? "StudentDashboard" : teacherHome };
    default:
      return null;
  }
}

export default function AppNavigator() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

  const pending = useRef<{ name: string; params?: any } | null>(null);

  const goTo = (t: { name: string; params?: any }) => {
    if (!navRef.isReady()) { pending.current = t; return; }
    const cur = navRef.getCurrentRoute()?.name;
    if (!cur || !READY_ROUTES.has(cur)) { pending.current = t; return; } // still on RoleGate/Auth
    pending.current = null;
    navRef.navigate(t.name, t.params);
  };

  // Notification taps (app in background or foreground) + cold start from a notification
  useEffect(() => {
    const handle = async (resp: Notifications.NotificationResponse | null) => {
      try {
        const t = await resolveTarget(resp?.notification?.request?.content?.data);
        if (t) goTo(t);
      } catch {}
    };
    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    Notifications.getLastNotificationResponseAsync().then(handle).catch(() => {});
    return () => sub.remove();
  }, []);

  // Expo can rotate the push token — keep the backend in sync
  useEffect(() => {
    const sub = Notifications.addPushTokenListener(() => {
      const u = auth.currentUser;
      if (!u) return;
      getUserSession().then((s: any) => {
        if (s?.role) registerAndSavePushToken(u.uid, s.role);
      }).catch(() => {});
    });
    return () => sub.remove();
  }, []);

  if (loading) return null; // splash later

  return (
    <NavigationContainer
      ref={navRef}
      onStateChange={() => {
        const t = pending.current;
        const cur = navRef.getCurrentRoute()?.name;
        if (t && cur && READY_ROUTES.has(cur)) {
          pending.current = null;
          navRef.navigate(t.name, t.params);
        }
      }}
    >
      <Stack.Navigator
        initialRouteName="RoleGate"
        screenOptions={{ headerShown: false }}
      >
        {/* ── Auth ─────────────────────────────────────────────────────── */}
        <Stack.Screen name="Auth" component={AuthScreen} />
        <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
        <Stack.Screen name="VerifyEmail" component={VerifyEmailScreen} />
        <Stack.Screen name="StudentRegistration" component={StudentRegistration} />
        <Stack.Screen name="TeacherRegistration" component={TeacherRegistration} />
        <Stack.Screen name="RoleGate" component={RoleGate} />

        {/* ── Dashboards ───────────────────────────────────────────────── */}
        <Stack.Screen name="TeacherDashboard" component={TeacherDashboard} />
        <Stack.Screen name="SubjectHub" component={SubjectHub} />
        <Stack.Screen name="StudentDashboard" component={StudentDashboard} />

        {/* ── Shared / Teacher ─────────────────────────────────────────── */}
        <Stack.Screen name="StudentProfile" component={StudentProfile} />
        <Stack.Screen name="CreateBroadcast" component={CreateBroadcast} />
        <Stack.Screen name="BroadcastInbox" component={BroadcastInbox} />
        <Stack.Screen name="MyScheduleScreen" component={LectureSchedule} />

        {/* ── Attendance (teacher) ─────────────────────────────────────── */}
        <Stack.Screen name="CodeAttendance" component={CodeAttendanceScreen} />
        <Stack.Screen name="BioGeoAttendance" component={BioGeoAttendanceScreen} />
        <Stack.Screen name="MultiAttendance" component={MultiAttendanceScreen} />
        <Stack.Screen name="IoTAttendanceScreen" component={IoTAttendanceScreen} />
        <Stack.Screen name="ManualMarkingScreen" component={ManualMarkingScreen} />
        <Stack.Screen name="QRAttendance" component={QRAttendanceScreen} />

        {/* ── Attendance (student) ─────────────────────────────────────── */}
        <Stack.Screen name="CodeMarkingScreen" component={CodeMarkingScreen} />
        <Stack.Screen name="BioGeoMarkingScreen" component={BioGeoMarkingScreen} />
        <Stack.Screen name="MultiMarkingScreen" component={MultiMarkingScreen} />
        <Stack.Screen name="IoTMarkingScreen" component={IoTMarkingScreen} />
        <Stack.Screen name="QRMarkingScreen" component={QRMarkingScreen} />

        {/* ── Quizzes ──────────────────────────────────────────────────── */}
        <Stack.Screen name="CreateQuizManual" component={CreateQuizManual} />
        <Stack.Screen name="CreateQuizAI" component={CreateQuizAI} />
        <Stack.Screen name="QuizPreviewScreen" component={AIQuizPreview} />
        <Stack.Screen name="FinalizeQuizScreen" component={FinalizeQuiz} />
        <Stack.Screen name="ViewQuizScreen" component={ViewQuiz} />
        <Stack.Screen name="StudentJoinQuiz" component={StudentJoinQuiz} />
        <Stack.Screen name="TakeQuiz" component={TakeQuiz} />
        <Stack.Screen name="QuizResultScreen" component={QuizResultScreen} />
        <Stack.Screen name="StudentScheduledQuiz" component={StudentScheduledQuiz} />
        <Stack.Screen name="StudentQuizResult" component={StudentQuizResult} />

        {/* ── Work / Assignments ───────────────────────────────────────── */}
        <Stack.Screen name="TeacherSubjectPicker" component={TeacherSubjectPicker} />
        <Stack.Screen name="TeacherSubjectFeed" component={TeacherSubjectFeed} />
        <Stack.Screen name="CreateAnnouncement" component={CreateAnnouncement} />
        <Stack.Screen name="CreateAssignment" component={CreateAssignment} />
        <Stack.Screen name="TeacherAssignmentDetail" component={TeacherAssignmentDetail} />
        <Stack.Screen name="StudentSubjectFeed" component={StudentSubjectFeed} />
        <Stack.Screen name="StudentAssignmentDetail" component={StudentAssignmentDetail} />
        <Stack.Screen name="AnnouncementDetail" component={AnnouncementDetail} />

        {/* ── Reports ──────────────────────────────────────────────────── */}
        <Stack.Screen name="StudentReportDetail" component={StudentReportDetail} />
        <Stack.Screen name="ExportReport" component={ExportReport} />
        <Stack.Screen name="ClassReport" component={ClassReport} />
        <Stack.Screen name="MarkAttendance" component={MarkAttendance} />
        <Stack.Screen name="ODLeaveRequest"     component={ODLeaveRequest}     />
        <Stack.Screen name="ElectiveSelection" component={ElectiveSelection} />
        <Stack.Screen name="ODRequestsTeacher" component={ODRequestTeacher}  />

        <Stack.Screen name="StudentTimetable" component={StudentTimetable} />
        <Stack.Screen name="StudentCalendar" component={StudentCalendar} />

      </Stack.Navigator>
    </NavigationContainer>
  );
}