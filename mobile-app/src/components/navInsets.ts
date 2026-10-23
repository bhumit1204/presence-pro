// src/components/navInsets.ts
// Android has two navigation styles. With gesture navigation the bottom system area is a thin bar (24 dp or less);
// with the 3-button bar it is about 48 dp and the app is drawn underneath it. useNavBarGap() returns the height
// of the 3-button bar when it is there and 0 for gesture navigation (and iOS), so screens add space only when
// they need it and look exactly as before with gestures.
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** bottom inset from which we treat the navigation bar as "3 buttons" */
export const THREE_BUTTON_MIN_INSET = 36;

export function useNavBarGap(): number {
  const { bottom } = useSafeAreaInsets();
  return Platform.OS === "android" && bottom >= THREE_BUTTON_MIN_INSET ? bottom : 0;
}