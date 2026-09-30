// src/App.tsx
import React, { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import AppNavigator from "./navigation/AppNavigator";

export default function App() {
  const notificationListener = useRef<Notifications.EventSubscription | null>(null);
  const responseListener = useRef<Notifications.EventSubscription | null>(null);

  useEffect(() => {
    // 1. Foreground: notification arrives while app is open
    notificationListener.current =
      Notifications.addNotificationReceivedListener((notification) => {
        console.log("Notification received (foreground):", notification);
      });

    // 2. Tap: user taps a notification (background or killed state)
    responseListener.current =
      Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data as any;
        handleNotificationTap(data);
      });

    // 3. Killed state: app was opened by tapping a notification
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data = response.notification.request.content.data as any;
      handleNotificationTap(data);
    });

    return () => {
      notificationListener.current?.remove();
      responseListener.current?.remove();
    };
  }, []);

  return <AppNavigator />;
}

/**
 * Navigate to the correct screen based on notification data.
 * Backend sends { screen: "ScreenName", params: {} } in the data payload.
 */
function handleNotificationTap(data: any) {
  if (!data?.screen) return;
  console.log("Notification tapped, navigate to:", data.screen, data.params);
}