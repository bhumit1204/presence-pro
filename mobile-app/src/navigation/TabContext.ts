// src/navigation/TabContext.ts
// Shared state for the custom tab shell (GlassBottomBar + dashboards).
// Backward compatible: the student dashboard keeps passing { currentTab, setCurrentTab } only.
import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { useFocusEffect } from "@react-navigation/native";

export type TabBadges = Record<string, number>;

export interface TabContextValue {
  currentTab: string;
  setCurrentTab: (key: string) => void;
  badges?: TabBadges;
  setBadge?: (key: string, count: number) => void;
}

export const TabContext = createContext<any>(null);

export const useTab = (): TabContextValue => useContext(TabContext);

/**
 * Runs `cb` every time `key` becomes the visible tab AND every time the user comes back to the
 * dashboard from a pushed screen while `key` is visible. Use it to refresh data without polling.
 */
export function useOnTabActive(key: string, cb: () => void) {
  const ctx = useTab();
  const current = ctx?.currentTab;
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    if (current === key) cbRef.current();
  }, [current, key]);

  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      if (currentRef.current === key) cbRef.current();
    }, [key])
  );
}