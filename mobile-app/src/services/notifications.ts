// src/services/notifications.ts
// Handles push token registration and foreground notification behaviour.
// Call registerForPushNotifications() once after login (from RoleGate).

import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";

// Controls how notifications appear when the app is OPEN (foreground)
Notifications.setNotificationHandler({
  handleNotification: async (): Promise<Notifications.NotificationBehavior> => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,

    //  NEW REQUIRED FIELDS
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Requests permission and returns the Expo push token string.
 * Returns null if permission denied or not a physical device.
 *
 * FIX: Constants.easConfig does not exist in Expo SDK — the correct path
 * is Constants.expoConfig?.extra?.eas?.projectId.  If that is also absent
 * (app.json has no extra.eas.projectId), we log a clear warning so the
 * developer knows exactly what to add to app.json / app.config.js.
 *
 * Required in app.json:
 *   {
 *     "expo": {
 *       "extra": {
 *         "eas": { "projectId": "YOUR_EAS_PROJECT_ID" }
 *       }
 *     }
 *   }
 * Find your projectId on https://expo.dev under your project settings.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  // Push notifications don't work on simulators / emulators
  if (!Device.isDevice) {
    console.warn("[push] Push notifications require a physical device.");
    return null;
  }

  // ── Permission ───────────────────────────────────────────────────
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    console.warn("[push] Push notification permission denied.");
    return null;
  }

  // ── Android notification channel ─────────────────────────────────
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name:             "Default",
      importance:       Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor:       "#4834D4",
    });
  }

  // ── Resolve EAS projectId ────────────────────────────────────────
  // FIX: Constants.easConfig is not a real Expo SDK property.
  // The correct location is Constants.expoConfig.extra.eas.projectId.
  const projectId: string | undefined =
    Constants.expoConfig?.extra?.eas?.projectId;

  if (!projectId) {
    console.warn(
      "[push] No EAS projectId found.\n" +
      "Add this to app.json under expo.extra.eas.projectId:\n" +
      '  "extra": { "eas": { "projectId": "YOUR_PROJECT_ID" } }\n' +
      "Find your projectId at https://expo.dev → your project → Project ID."
    );
    return null;
  }

  // ── Get Expo push token ──────────────────────────────────────────
  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    console.log("[push] Token registered:", tokenData.data);
    return tokenData.data;
  } catch (err) {
    console.error("[push] Failed to get push token:", err);
    return null;
  }
}