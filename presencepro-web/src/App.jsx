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

export default function App() {
  return (
    <Routes>

      {/* ── Public ──────────────────────────────────────────────── */}
      <Route path="/"   element={<LoginScreen />} />
      <Route path="/qr" element={<QRDisplay />} />

      {/* ── Role entry-point / catch-all ────────────────────────── */}
      <Route path="/dashboard" element={<RoleRouter />} />

      {/* ── Teacher ─────────────────────────────────────────────── */}
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

      {/* ── Head Teacher ────────────────────────────────────────── */}
      <Route path="/dashboard/head"
        element={<ProtectedRoute role="head"><ComingSoon label="Head Teacher Dashboard" /></ProtectedRoute>} />

      {/* ── Student ─────────────────────────────────────────────── */}
      <Route path="/dashboard/student"
        element={<ProtectedRoute role="student"><ComingSoon label="Student Dashboard" /></ProtectedRoute>} />

      <Route path="*" element={<RoleRouter />} />

    </Routes>
  );
}

function ComingSoon({ label }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: "100vh", background: "#F3F4F6",
      fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
    }}>
      <div style={{
        background: "#fff", border: "1px solid #E5E7EB",
        borderRadius: 16, padding: "40px 48px", textAlign: "center",
      }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🚧</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>{label}</div>
        <div style={{ fontSize: 14, color: "#9CA3AF", marginTop: 6 }}>Coming soon</div>
      </div>
    </div>
  );
}