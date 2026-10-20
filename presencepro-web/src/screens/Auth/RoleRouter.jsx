// @ts-nocheck
/**
 * RoleRouter.jsx
 *
 * Drop this on any route where you need to redirect based on role.
 * Reads the session, determines the correct dashboard, and redirects.
 *
 * Use cases:
 *   1. After login (LoginScreen calls navigate(dashboardPathForRole())
 *      directly — this component is a fallback/entry-point approach)
 *   2. As the default "/" catch-all when already logged in
 *   3. As a "/dashboard" catch-all that fans out to role pages
 *
 * Decision table:
 *   Not logged in          → /              (login)
 *   role: student          → /dashboard/student   (student portal)
 *   role: teacher, is_head → /dashboard/teacher   (heads also get the Manage menu)
 *   role: teacher          → /dashboard/teacher
 *   role: hod              → /dashboard/teacher
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { isLoggedIn, getSessionUser, getUserSession, dashboardPathForRole } from "../../services/session";

export default function RoleRouter() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoggedIn()) {
      navigate("/", { replace: true });
      return;
    }
    const user = getSessionUser();
    const profile = getUserSession()?.profile;

    // Students always land in the student portal.
    if (user?.role === "student") {
      navigate("/dashboard/student", { replace: true });
      return;
    }

    // Heads (is_head, hod/head_teacher, or profile.head_of set) use the
    // teacher pages — the Manage section appears in the sidebar.
    const isHead =
      !!user?.is_head ||
      user?.role === "hod" ||
      user?.role === "head_teacher" ||
      (user?.role === "teacher" && !!String(profile?.head_of || "").trim());

    navigate(isHead ? "/dashboard/teacher" : dashboardPathForRole(user), {
      replace: true,
    });
  }, []);

  return null; // renders nothing — pure redirect
}