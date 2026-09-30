import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App'
import InstituteLogin from './screens/Institute/auth/InstituteLogin'
import InstituteRegister from './screens/Institute/auth/InstituteRegister'
import Dashboard from './screens/Institute/dashboard/page'
import InstituteProtectedRoute from "./screens/Institute/dashboard/protected_route"
import Teachers from './screens/Institute/dashboard/teachers'
import Students from './screens/Institute/dashboard/students'
import Courses from './screens/Institute/dashboard/courses'
import Subjects from './screens/Institute/dashboard/subjects'
import Settings from './screens/Institute/dashboard/settings'
import './index.css'

// ── Institute admin app — only on institute.localhost ─────────────────
function InstituteApp() {
  return (
    <Routes>
      <Route path="/institute-login"    element={<InstituteLogin />} />
      <Route path="/institute-register" element={<InstituteRegister />} />

      <Route path="/" element={
        <InstituteProtectedRoute><Dashboard /></InstituteProtectedRoute>
      } />
      <Route path="/dashboard/teachers" element={
        <InstituteProtectedRoute><Teachers /></InstituteProtectedRoute>
      } />
      <Route path="/dashboard/students" element={
        <InstituteProtectedRoute><Students /></InstituteProtectedRoute>
      } />
      <Route path="/dashboard/courses" element={
        <InstituteProtectedRoute><Courses /></InstituteProtectedRoute>
      } />
      <Route path="/dashboard/subjects" element={
        <InstituteProtectedRoute><Subjects /></InstituteProtectedRoute>
      } />
      <Route path="/dashboard/settings" element={
        <InstituteProtectedRoute><Settings /></InstituteProtectedRoute>
      } />
    </Routes>
  )
}

// ── Root — pick app based on hostname ────────────────────────────────
const RootApp = window.location.hostname === 'institute.localhost'
  ? InstituteApp
  : App

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <RootApp />
    </BrowserRouter>
  </React.StrictMode>
)