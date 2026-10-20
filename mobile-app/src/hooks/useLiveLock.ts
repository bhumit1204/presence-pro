// Keeps a teacher on the live-attendance screen while a session is recording.
//   - blocks the header back button, the Android back button and the swipe-back gesture
//   - lets go the moment `active` turns false or `leaving.current` is set (session closed)
//   - runs `onResume` when the app comes back from the background, so the screen catches up
// The screen itself stays mounted while the app is in the background, so nothing is lost.

import { useEffect, useRef } from "react";
import { Alert, AppState, Platform, ToastAndroid } from "react-native";
import { useNavigation } from "@react-navigation/native";

export function useLiveLock(
  active: boolean,
  leaving: { current: boolean },
  message = "Attendance is running. Stop it first.",
  onResume?: () => void
) {
  const navigation = useNavigation<any>();
  const resumeRef = useRef(onResume);
  resumeRef.current = onResume;

  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !active });
  }, [navigation, active]);

  useEffect(() => {
    const unsub = navigation.addListener("beforeRemove", (e: any) => {
      if (!active || leaving.current) return;
      e.preventDefault();
      if (Platform.OS === "android") ToastAndroid.show(message, ToastAndroid.SHORT);
      else Alert.alert("Attendance is running", message);
    });
    return unsub;
  }, [navigation, active, leaving, message]);

  useEffect(() => {
    if (!active) return;
    let prev = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      if (prev.match(/inactive|background/) && next === "active") resumeRef.current?.();
      prev = next;
    });
    return () => sub.remove();
  }, [active]);
}