/**
 * session.js — Centralised session management for PresencePro web app.
 *
 * Storage keys:
 *   pp_user     — { uid, email, role, is_active, is_head }
 *   pp_token    — Firebase ID token string
 *   pp_profile  — teacher/student profile object from backend
 *
 * is_head is stored separately so any component can read it without
 * parsing the full profile. It is true when:
 *   - role === "hod"
 *   - role === "teacher" AND profile.designation === "head"
 *   - backend explicitly returns is_head: true on the user object
 */

const USER_KEY    = "pp_user";
const TOKEN_KEY   = "pp_token";
const PROFILE_KEY = "pp_profile";

// ── Save ──────────────────────────────────────────────────────────────
/**
 * Called immediately after successful /auth/login response.
 *
 * @param {Object} user    — user object from backend
 * @param {string} token   — Firebase ID token
 * @param {Object} profile — teacher/student profile (optional, can be
 *                           set separately via saveUserProfile)
 */
export function saveUserSession(user, token, profile = null) {
  if (!user || !token) {
    console.error("saveUserSession: user and token are required.");
    return;
  }

  // Determine is_head:
  // ONLY trust role field — "oHOD" / "head_teacher" set by the backend login.
  // Never infer from designation: institute dashboard uses designation="head"
  // for department heads which is a completely different concept.
  const isHead =
    !!user.is_head ||
    user.role === "hod" ||
    user.role === "head_teacher";

  const sessionUser = {
    uid:       user.uid       || user.user_id || null,
    email:     user.email     || null,
    role:      user.role      || "student",
    is_active: user.is_active !== false,   // default true
    is_head:   isHead,
  };

  localStorage.setItem(USER_KEY,   JSON.stringify(sessionUser));
  localStorage.setItem(TOKEN_KEY,  token);

  if (profile) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  }
}

/**
 * Saves or updates the profile separately — call this after fetching
 * the full teacher/student profile from the backend.
 * Re-evaluates is_head from role only — never from designation.
 */
export function saveUserProfile(profile) {
  if (!profile) return;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));

  // Re-evaluate is_head — role field only, never designation
  // (designation="head" is an institute-dashboard concept, not an app role)
  const user = getSessionUser();
  if (user) {
    const isHead =
      user.is_head ||
      user.role === "hod" ||
      user.role === "head_teacher";

    if (isHead !== user.is_head) {
      localStorage.setItem(USER_KEY, JSON.stringify({ ...user, is_head: isHead }));
    }
  }
}

// ── Read ──────────────────────────────────────────────────────────────

/** Returns the raw user object { uid, email, role, is_active, is_head } or null. */
export function getSessionUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Returns the stored Firebase ID token string or null. */
export function getSessionToken() {
  return localStorage.getItem(TOKEN_KEY) || null;
}

/** Returns the profile object or null. */
export function getSessionProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Returns the full session in one call — matches the shape the
 * mobile app uses so existing components that call getUserSession()
 * keep working unchanged.
 *
 * Shape: { uid, token, user: { uid, email, role, is_active, is_head }, profile }
 */
export function getUserSession() {
  const user    = getSessionUser();
  const token   = getSessionToken();
  const profile = getSessionProfile();

  if (!user || !token) return null;

  return {
    uid:     user.uid,
    token,
    user,
    profile,
    // Convenience shorthands
    role:    user.role,
    is_head: user.is_head,
  };
}

// ── Derived helpers ───────────────────────────────────────────────────

/** True if a valid session exists. */
export function isLoggedIn() {
  return !!getSessionUser() && !!getSessionToken();
}

/** True when the logged-in teacher is a department head. */
export function isHeadTeacher() {
  return !!getSessionUser()?.is_head;
}

/** Returns the role string or null. */
export function getRole() {
  return getSessionUser()?.role || null;
}

/**
 * Returns the correct dashboard path for the current session role.
 * Used by both LoginScreen and RoleRouter.
 */
export function dashboardPathForRole(user) {
  const role   = user?.role    || getSessionUser()?.role;
  const isHead = user?.is_head ?? getSessionUser()?.is_head;

  if (role === "hod" || (role === "teacher" && isHead)) return "/dashboard/head";
  if (role === "teacher")  return "/dashboard/teacher";
  if (role === "student")  return "/dashboard/student";
  return "/";   // fallback — will be caught by ProtectedRoute
}

// ── Clear ─────────────────────────────────────────────────────────────

/** Clears all session data. Call on logout. */
export function clearUserSession() {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PROFILE_KEY);
}