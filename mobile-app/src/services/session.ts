// src/services/session.ts
import AsyncStorage from "@react-native-async-storage/async-storage";


const API_BASE = process.env.EXPO_PUBLIC_API_URL || "https://your-backend.vercel.app";

export const saveUserSession = async (user: any, idToken: string, profile?: any) => {
  const session = {
    uid: user.uid,
    role: user.role,
    is_active: user.is_active,
    approval_status: user.approval_status || null,
    teacher_id: user.teacher_id || null,
    student_id: user.student_id || null,

    profile: profile || null,

    token: idToken,
    expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
  };

  await AsyncStorage.setItem("SESSION", JSON.stringify(session));
};

export const getUserSession = async () => {
  const data = await AsyncStorage.getItem("SESSION");
  if (!data) return null;

  const session = JSON.parse(data);

  if (Date.now() > session.expiresAt) {
    await AsyncStorage.removeItem("SESSION");
    return null;
  }

  return session;
};

/** Call this after a profile API refresh to keep session in sync */
export const updateSessionProfile = async (profile: any) => {
  const data = await AsyncStorage.getItem("SESSION");
  if (!data) return;
  const session = JSON.parse(data);
  session.profile = profile;
  await AsyncStorage.setItem("SESSION", JSON.stringify(session));
};

export const clearSession = async () => {
  await AsyncStorage.removeItem("SESSION");
};

/**
 * Save the Expo push token to backend so the server can send notifications.
 * Call this once after login, passing uid, role, and the token from
 * registerForPushNotifications().
 */
export const savePushToken = async (
  uid: string,
  role: string,
  pushToken: string
): Promise<void> => {
  try {
    await fetch(`${API_BASE}/api/profile/push-token`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, role, pushToken }),
    });
  } catch (err) {
    // Best-effort — never block login
    console.warn("Failed to save push token:", err);
  }
};