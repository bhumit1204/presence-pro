// @ts-nocheck
import { Routes, Route, Navigate } from "react-router-dom";
import LoginScreen          from "./screens/Auth/LoginScreen";
import QRDisplay            from "./screens/Teacher/QRDisplay";
import RoleRouter           from "./screens/Auth/RoleRouter";
import ProtectedRoute       from "./screens/Auth/ProtectedRoute";
import TeacherDashboardPage from "./screens/Teacher/Dashboard";
import SchedulePage         from "./screens/Teacher/SchedulePage";
import AssignmentsPage      from "./screens/Teacher/AssignmentsPage";
import TestsPage from "./screens/Teacher/TestsPage";
import ODPage from "./screens/Teacher/ODPage";
import AnnouncementsPage from "./screens/Teacher/AnnouncementsPage";
import ReportsPage from "./screens/Teacher/ReportsPage";
import SemestersPage from "./screens/Teacher/manage/SemestersPage";
import SubjectsPage from "./screens/Teacher/manage/SubjectsPage";
import DivisionsPage from "./screens/Teacher/manage/DivisionsPage";
import TimetablePage from "./screens/Teacher/manage/TimetablePage";
import CalendarPage from "./screens/Teacher/manage/CalendarPage";
import StudentReportsPage from "./screens/Teacher/manage/StudentReportsPage";
import StudentHome from "./screens/Student/StudentHome";
import ClassesPage from "./screens/Student/ClassesPage";
import ClassroomPage from "./screens/Student/ClassroomPage";
import StudentAssignmentsPage from "./screens/Student/AssignmentsPage";
import AssignmentDetail from "./screens/Student/AssignmentDetail";
import StudentTestsPage from "./screens/Student/TestsPage";
import TakeTest from "./screens/Student/TakeTest";
import TestResult from "./screens/Student/TestResult";
import StudentAnnouncementsPage from "./screens/Student/AnnouncementsPage";
import StudentProfilePage from "./screens/Student/ProfilePage";

export default function App() {
  return (
    <Routes>

      {/* ── Public ──────────────────────────────────────────────── */}
      <Route path="/"   element={<LoginScreen />} />
      <Route path="/qr" element={<QRDisplay />} />

      {/* ── Role entry-point / catch-all ────────────────────────── */}
      <Route path="/dashboard" element={<RoleRouter />} />

      {/* ── Teacher (heads use these pages too) ─────────────────── */}
      <Route path="/dashboard/teacher"
        element={<ProtectedRoute role="teacher"><TeacherDashboardPage /></ProtectedRoute>} />

      <Route path="/dashboard/teacher/schedule"
        element={<ProtectedRoute role="teacher"><SchedulePage /></ProtectedRoute>} />

      <Route path="/dashboard/teacher/assignments"
        element={<ProtectedRoute role="teacher"><AssignmentsPage /></ProtectedRoute>} />

      <Route path="/dashboard/teacher/tests"
        element={<ProtectedRoute role="teacher"><TestsPage /></ProtectedRoute>} />

      <Route path="/dashboard/teacher/od"
        element={<ProtectedRoute role="teacher"><ODPage /></ProtectedRoute>} />

      <Route path="/dashboard/teacher/announcements"
        element={<ProtectedRoute role="teacher"><AnnouncementsPage /></ProtectedRoute>} />
      <Route path="/dashboard/teacher/reports"
        element={<ProtectedRoute role="teacher"><ReportsPage /></ProtectedRoute>} />

      {/* ── Head ▸ Manage (heads only; the sidebar shows these under "Manage") ── */}
      <Route path="/dashboard/teacher/manage/semesters"
        element={<ProtectedRoute role="head"><SemestersPage /></ProtectedRoute>} />

      <Route path="/dashboard/teacher/manage/subjects"
        element={<ProtectedRoute role="head"><SubjectsPage /></ProtectedRoute>} />

      <Route path="/dashboard/teacher/manage/divisions"
        element={<ProtectedRoute role="head"><DivisionsPage /></ProtectedRoute>} />

      <Route path="/dashboard/teacher/manage/timetable"
        element={<ProtectedRoute role="head"><TimetablePage /></ProtectedRoute>} />

      <Route path="/dashboard/teacher/manage/calendar"
        element={<ProtectedRoute role="head"><CalendarPage /></ProtectedRoute>} />

      <Route path="/dashboard/teacher/manage/reports"
        element={<ProtectedRoute role="head"><StudentReportsPage /></ProtectedRoute>} />

      {/* ── Old head URLs → the teacher pages ───────────────────── */}
      <Route path="/dashboard/head/*" element={<Navigate to="/dashboard/teacher" replace />} />

      {/* ── Student portal ──────────────────────────────────────── */}
      <Route path="/dashboard/student"
        element={<ProtectedRoute role="student"><StudentHome /></ProtectedRoute>} />

      <Route path="/dashboard/student/classes"
        element={<ProtectedRoute role="student"><ClassesPage /></ProtectedRoute>} />
      <Route path="/dashboard/student/classes/:subjectId"
        element={<ProtectedRoute role="student"><ClassroomPage /></ProtectedRoute>} />

      <Route path="/dashboard/student/assignments"
        element={<ProtectedRoute role="student"><StudentAssignmentsPage /></ProtectedRoute>} />
      <Route path="/dashboard/student/assignments/:assignmentId"
        element={<ProtectedRoute role="student"><AssignmentDetail /></ProtectedRoute>} />

      <Route path="/dashboard/student/tests"
        element={<ProtectedRoute role="student"><StudentTestsPage /></ProtectedRoute>} />
      <Route path="/dashboard/student/tests/take"
        element={<ProtectedRoute role="student"><TakeTest /></ProtectedRoute>} />
      <Route path="/dashboard/student/tests/result/:quizId"
        element={<ProtectedRoute role="student"><TestResult /></ProtectedRoute>} />

      <Route path="/dashboard/student/announcements"
        element={<ProtectedRoute role="student"><StudentAnnouncementsPage /></ProtectedRoute>} />
      <Route path="/dashboard/student/profile"
        element={<ProtectedRoute role="student"><StudentProfilePage /></ProtectedRoute>} />

      {/* unknown /dashboard/student/... → student home */}
      <Route path="/dashboard/student/*" element={<Navigate to="/dashboard/student" replace />} />

      <Route path="*" element={<RoleRouter />} />

    </Routes>
  );
}