// @ts-nocheck
/**
 * ProtectedRoute.jsx
 *
 * Wraps any route that requires authentication.
 * If no valid session exists → redirects to "/" (login page).
 * If a role is specified → also checks the user's role matches.
 *
 * Usage:
 *   <ProtectedRoute>
 *     <TeacherDashboardPage />
 *   </ProtectedRoute>
 *
 *   <ProtectedRoute role="teacher">
 *     <TeacherDashboardPage />
 *   </ProtectedRoute>
 *
 *   // Multiple allowed roles:
 *   <ProtectedRoute role={["teacher", "hod"]}>
 *     <TeacherDashboardPage />
 *   </ProtectedRoute>
 */

import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { isLoggedIn, getSessionUser, dashboardPathForRole } from "../../services/session";

export default function ProtectedRoute({ children, role = null }) {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Not logged in → back to login
    if (!isLoggedIn()) {
      navigate("/", { replace: true, state: { from: location.pathname } });
      return;
    }

    // Role guard — if specific role(s) required, enforce it
    if (role) {
      const user         = getSessionUser();
      const allowedRoles = Array.isArray(role) ? role : [role];

      // HOD/head pages: allow both "hod" role AND teacher with is_head
      const isAllowed =
        allowedRoles.some((r) => {
          if (r === "head") return user.role === "hod" || (user.role === "teacher" && user.is_head);
          return user.role === r;
        });

      if (!isAllowed) {
        // Redirect to their correct dashboard rather than login
        navigate(dashboardPathForRole(user), { replace: true });
      }
    }
  }, [location.pathname]);

  // If not logged in, render nothing while redirect fires
  if (!isLoggedIn()) return null;

  // Role mismatch — render nothing while redirect fires
  if (role) {
    const user         = getSessionUser();
    const allowedRoles = Array.isArray(role) ? role : [role];
    const isAllowed    = allowedRoles.some((r) => {
      if (r === "head") return user.role === "hod" || (user.role === "teacher" && user.is_head);
      return user.role === r;
    });
    if (!isAllowed) return null;
  }

  return children;
}