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
import {
  isLoggedIn,
  getSessionUser,
  getUserSession,
  dashboardPathForRole,
} from "../../services/session";
import { useSessionRefresh } from "../../services/refreshSession";

// A head is a teacher with extra powers, so teacher routes accept them too.
// Head = is_head flag, hod/head_teacher role, or a teacher whose profile has
// head_of set (that's what the institute app writes, e.g. head_of: "MCA").
function isHeadUser(user) {
  const profile = getUserSession()?.profile;
  return (
    !!user?.is_head ||
    user?.role === "hod" ||
    user?.role === "head_teacher" ||
    (user?.role === "teacher" && !!String(profile?.head_of || "").trim())
  );
}

function roleMatches(user, r) {
  if (r === "head")    return isHeadUser(user);
  if (r === "teacher") return user?.role === "teacher" || isHeadUser(user);
  return user?.role === r;
}

// Heads land on the normal teacher pages; Manage is just extra sidebar items.
function homePath(user) {
  return isHeadUser(user) && user?.role !== "student"
    ? "/dashboard/teacher"
    : dashboardPathForRole(user);
}

export default function ProtectedRoute({ children, role = null }) {
  const navigate = useNavigate();
  const location = useLocation();

  // Re-syncs role / head status from the server (mount, every minute, tab
  // focus). The version changes when the session does, re-running the guard
  // below — so a head removed by the institute is moved off Manage pages.
  const sessionVersion = useSessionRefresh();

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

      const isAllowed = allowedRoles.some((r) => roleMatches(user, r));

      if (!isAllowed) {
        // Redirect to their correct dashboard rather than login
        navigate(homePath(user), { replace: true });
      }
    }
  }, [location.pathname, sessionVersion]);

  // If not logged in, render nothing while redirect fires
  if (!isLoggedIn()) return null;

  // Role mismatch — render nothing while redirect fires
  if (role) {
    const user         = getSessionUser();
    const allowedRoles = Array.isArray(role) ? role : [role];
    const isAllowed    = allowedRoles.some((r) => roleMatches(user, r));
    if (!isAllowed) return null;
  }

  return children;
}