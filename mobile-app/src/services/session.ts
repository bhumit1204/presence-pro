// src/services/session.ts
// Local cache of who is logged in (role, ids, profile). It is only a UI cache: the real authority is
// the Firebase login + the Bearer token apiFetch() attaches to every request, and the server re-checks it.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { signOut } from "firebase/auth";
import { auth } from "./firebase";
import { apiFetch, API_BASE } from "./api";

const KEY = "SESSION";
// Firebase keeps the user signed in by itself; this cache only needs to outlive a normal term.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** hod / head_teacher are plain "teachers" in the mobile app; the original value is kept in raw_role */
export const normaliseRole = (role: any): string => {
  const r = String(role || "").toLowerCase();
  return r === "hod" || r === "head_teacher" || r === "head teacher" ? "teacher" : r;
};

/**
 * The `_idToken` argument is kept so existing callers do not change, but the token is deliberately NOT
 * stored: ID tokens expire after an hour, apiFetch() always asks Firebase for a fresh one, and a copy
 * sitting in plain storage for weeks is only a liability.
 */
export const saveUserSession = async (user: any, _idToken?: string, profile?: any) => {
  const session = {
    uid: user.uid,
    role: normaliseRole(user.role),
    raw_role: user.role || null,
    is_active: user.is_active,
    approval_status: user.approval_status || null,
    teacher_id: user.teacher_id || null,
    student_id: user.student_id || null,
    profile: profile || null,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  await AsyncStorage.setItem(KEY, JSON.stringify(session));
};

export const getUserSession = async () => {
  try {
    const data = await AsyncStorage.getItem(KEY);
    if (!data) return null;
    const session = JSON.parse(data);
    if (!session?.uid || Date.now() > session.expiresAt) {
      await AsyncStorage.removeItem(KEY);
      return null;
    }
    // the cache must belong to whoever Firebase says is signed in
    const current = auth.currentUser;
    if (current && current.uid !== session.uid) {
      await AsyncStorage.removeItem(KEY);
      return null;
    }
    return session;
  } catch {
    await AsyncStorage.removeItem(KEY).catch(() => {});
    return null;
  }
};

/** Call this after a profile API refresh to keep session in sync */
export const updateSessionProfile = async (profile: any) => {
  try {
    const data = await AsyncStorage.getItem(KEY);
    if (!data) return;
    const session = JSON.parse(data);
    session.profile = profile;
    await AsyncStorage.setItem(KEY, JSON.stringify(session));
  } catch {}
};

export const clearSession = async () => {
  await AsyncStorage.removeItem(KEY);
};

/** Full logout: Firebase sign-out + wipe the local cache (use this instead of clearSession alone). */
export const signOutAndClear = async () => {
  try {
    await signOut(auth);
  } catch {}
  await clearSession().catch(() => {});
};

/**
 * Save the Expo push token so the server can notify this device.
 * Goes through apiFetch so the request carries the user's Firebase token; the server must take the
 * user id from that token (the `uid` in the body is only a hint and must not be trusted).
 */
export const savePushToken = async (uid: string, role: string, pushToken: string): Promise<void> => {
  try {
    await apiFetch(`${API_BASE}/api/profile/push-token`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, role, pushToken }),
    });
  } catch (err) {
    // Best-effort - never block login
    console.warn("Failed to save push token");
  }
};