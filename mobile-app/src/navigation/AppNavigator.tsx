import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { onAuthStateChanged } from "firebase/auth";
import { useEffect, useState } from "react";
import { auth } from "../services/firebase";
import AuthScreen from "../screens/auth/AuthScreen";
import RoleGate from "../screens/auth/RoleGate";
import TeacherDashboard from "../screens/teacher/TeacherDashboard";
import StudentDashboard from "../screens/student/StudentDashboard";
import HODDashboard from "../screens/teacher/HODDashboard";
import StudentRegistration from "../screens/auth/StudentRegistration";
import TeacherRegistration from "../screens/auth/TeacherRegistration";
import CodeAttendanceScreen from "../screens/attendance/teacher/CodeAttendanceScreen";
import BioGeoAttendanceScreen from "../screens/attendance/teacher/BioGeoAttendanceScreen";
import IoTAttendanceScreen from "../screens/attendance/teacher/IoTAttendanceScreen";
import CodeMarkingScreen from "../screens/attendance/student/CodeMarkingScreen";
import BioGeoMarkingScreen from "../screens/attendance/student/BioGeoMarkingScreen";
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

// HOD Manage screens
import TimetableManager from "../screens/hod/manage/TimetableManager";
import SemesterSubjectsManager from "../screens/hod/manage/SemesterSubjectsManager";
import AcademicCalendarManager from "../screens/hod/manage/AcademicCalendarManager";
import DefaulterList from "../screens/hod/manage/DefaulterList";
import DelegateRightsScreen from "../screens/hod/manage/DelegateRightsScreen";
import SemesterDatesManager from "../screens/hod/manage/SemesterDatesManager";
import ODRequestsTeacher from "../screens/reports/teacher/ODRequestTeacher";
import ODLeaveRequest from "../screens/student/tabs/ODLeaveRequest";

const Stack = createNativeStackNavigator();

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

  if (loading) return null; // splash later

  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="RoleGate"
        screenOptions={{ headerShown: false }}
      >
        {/* ── Auth ─────────────────────────────────────────────────────── */}
        <Stack.Screen name="Auth" component={AuthScreen} />
        <Stack.Screen name="StudentRegistration" component={StudentRegistration} />
        <Stack.Screen name="TeacherRegistration" component={TeacherRegistration} />
        <Stack.Screen name="RoleGate" component={RoleGate} />

        {/* ── Dashboards ───────────────────────────────────────────────── */}
        <Stack.Screen name="TeacherDashboard" component={TeacherDashboard} />
        <Stack.Screen name="StudentDashboard" component={StudentDashboard} />
        <Stack.Screen name="HODDashboard" component={HODDashboard} />

        {/* ── Shared / Teacher ─────────────────────────────────────────── */}
        <Stack.Screen name="StudentProfile" component={StudentProfile} />
        <Stack.Screen name="CreateBroadcast" component={CreateBroadcast} />
        <Stack.Screen name="BroadcastInbox" component={BroadcastInbox} />
        <Stack.Screen name="MyScheduleScreen" component={LectureSchedule} />

        {/* ── Attendance (teacher) ─────────────────────────────────────── */}
        <Stack.Screen name="CodeAttendance" component={CodeAttendanceScreen} />
        <Stack.Screen name="BioGeoAttendance" component={BioGeoAttendanceScreen} />
        <Stack.Screen name="IoTAttendanceScreen" component={IoTAttendanceScreen} />
        <Stack.Screen name="ManualMarkingScreen" component={ManualMarkingScreen} />
        <Stack.Screen name="QRAttendance" component={QRAttendanceScreen} />

        {/* ── Attendance (student) ─────────────────────────────────────── */}
        <Stack.Screen name="CodeMarkingScreen" component={CodeMarkingScreen} />
        <Stack.Screen name="BioGeoMarkingScreen" component={BioGeoMarkingScreen} />
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
        <Stack.Screen name="ODRequestsTeacher" component={ODRequestsTeacher}  />

        {/* ── HOD Manage screens ───────────────────────────────────────── */}
        <Stack.Screen name="TimetableManager" component={TimetableManager} />
        <Stack.Screen name="SemesterSubjectsManager" component={SemesterSubjectsManager} />
        <Stack.Screen name="AcademicCalendarManager" component={AcademicCalendarManager} />
        <Stack.Screen name="DefaulterList" component={DefaulterList} />
        <Stack.Screen name="DelegateRightsScreen" component={DelegateRightsScreen} />
        <Stack.Screen name="SemesterDatesManager" component={SemesterDatesManager} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}