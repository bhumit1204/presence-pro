import { Navigate } from "react-router-dom";

const INSTITUTE_API = import.meta.env.VITE_INSTITUTE_API_URL || "http://localhost:5001";

export function getInstituteToken() {
  return localStorage.getItem("institute_token");
}

export function getInstituteProfile() {
  try {
    return JSON.parse(localStorage.getItem("institute_profile"));
  } catch {
    return null;
  }
}

export function clearInstituteSession() {
  localStorage.removeItem("institute_token");
  localStorage.removeItem("institute_profile");
}

// ── Protected Route wrapper ───────────────────────────────────────────
// Usage in your router:
//   <Route path="/dashboard/institute" element={
//     <InstituteProtectedRoute>
//       <InstituteDashboard />
//     </InstituteProtectedRoute>
//   } />

export default function InstituteProtectedRoute({ children }) {
  const token = getInstituteToken();

  if (!token) {
    // No token at all — send to login
    return <Navigate to="/institute-login" replace />;
  }

  return children;
}