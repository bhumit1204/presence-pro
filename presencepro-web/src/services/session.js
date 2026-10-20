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
 *   - role === "hod" or "head_teacher"
 *   - role === "teacher" AND profile.head_of is set (e.g. "MCA")
 *   - backend explicitly returns is_head: true on the user object
 * (designation is never used — it's free text from the institute app)
 */

/** True when a teacher profile carries a head_of department. */
function hasHeadOf(profile) {
  return !!String(profile?.head_of || "").trim();
}

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

  // Determine is_head: role set by the backend login ("hod" / "head_teacher"),
  // or a teacher whose profile has head_of set. Never infer from designation.
  const isHead =
    !!user.is_head ||
    user.role === "hod" ||
    user.role === "head_teacher" ||
    (user.role === "teacher" && hasHeadOf(profile));

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

  // Re-evaluate is_head — role field or head_of, never designation
  const user = getSessionUser();
  if (user) {
    const isHead =
      !!user.is_head ||
      user.role === "hod" ||
      user.role === "head_teacher" ||
      (user.role === "teacher" && hasHeadOf(profile));

    if (isHead !== user.is_head) {
      localStorage.setItem(USER_KEY, JSON.stringify({ ...user, is_head: isHead }));
    }
  }
}

/** Fired on window whenever the stored session actually changes. */
export const SESSION_EVENT = "pp:session";

/**
 * Applies fresh data from GET /auth/me to the stored session (role, is_head,
 * is_active, profile, token). The server's answer wins — e.g. a head who was
 * removed in the institute app becomes a plain teacher here without logging
 * out. Notifies listeners only if something really changed.
 */
export function updateSession({ user, profile, token } = {}) {
  const current = getSessionUser();
  if (!current) return;

  const before = localStorage.getItem(USER_KEY) + localStorage.getItem(PROFILE_KEY);

  const next = { ...current };
  if (user) {
    if (user.role !== undefined)      next.role      = user.role;
    if (user.is_active !== undefined) next.is_active = user.is_active !== false;
    if (user.is_head !== undefined)   next.is_head   = !!user.is_head;
  }
  localStorage.setItem(USER_KEY, JSON.stringify(next));
  if (profile) localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  if (token)   localStorage.setItem(TOKEN_KEY, token);

  const after = localStorage.getItem(USER_KEY) + localStorage.getItem(PROFILE_KEY);
  if (before !== after) window.dispatchEvent(new Event(SESSION_EVENT));
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
  const role = user?.role || getSessionUser()?.role;

  // Heads (hod / head_teacher / teacher with is_head) use the teacher pages;
  // the sidebar adds a "Manage" section for them.
  if (role === "hod" || role === "head_teacher" || role === "teacher") {
    return "/dashboard/teacher";
  }
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