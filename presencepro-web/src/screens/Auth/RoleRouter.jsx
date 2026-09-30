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
 *   role: student          → /dashboard/student
 *   role: teacher, is_head → /dashboard/head
 *   role: teacher          → /dashboard/teacher
 *   role: hod              → /dashboard/head
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { isLoggedIn, getSessionUser, dashboardPathForRole } from "../../services/session";

export default function RoleRouter() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoggedIn()) {
      navigate("/", { replace: true });
      return;
    }
    const user = getSessionUser();
    navigate(dashboardPathForRole(user), { replace: true });
  }, []);

  return null; // renders nothing — pure redirect
}