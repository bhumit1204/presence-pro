import React from "react";
import {
  View,
  TouchableOpacity,
  Text,
  StyleSheet,
  Platform,
} from "react-native";
import { BlurView } from "expo-blur";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTab } from "../navigation/TabContext";

const PRIMARY = "#4834D4";

export type TabKey = string;

export interface BarTab {
  key: TabKey;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Letters shown instead of the icon (teacher Profile tab). */
  initials?: string;
}

// Original tabs: used as-is by the student dashboard.
const DEFAULT_TABS: BarTab[] = [
  { key: "home", label: "Home", icon: "home" },
  { key: "reports", label: "Reports", icon: "bar-chart" },
  { key: "work", label: "Work", icon: "briefcase" },
  { key: "quizzes", label: "Quizzes", icon: "document-text" },
];

export default function GlassBottomBar({
  tabs = DEFAULT_TABS,
  badges,
}: {
  tabs?: BarTab[];
  badges?: Record<string, number>;
}) {
  const { currentTab, setCurrentTab } = useTab(); //  context

  return (
    <View style={styles.wrapper}>
      <BlurView intensity={70} tint="light" style={styles.container}>
        {tabs.map((tab) => {
          const isActive = currentTab === tab.key;
          const count = badges?.[tab.key] || 0;

          return (
            <TouchableOpacity
              key={tab.key}
              style={styles.item}
              onPress={() => setCurrentTab(tab.key)} //  updated
              activeOpacity={0.8}
            >
              <View style={[styles.pill, isActive && styles.activePill]}>
                {tab.initials ? (
                  <Text style={[styles.initials, isActive && { color: "#FFF" }]}>{tab.initials}</Text>
                ) : (
                  <Ionicons
                    name={tab.icon}
                    size={22}
                    color={isActive ? "#FFF" : "#111"}
                  />
                )}
                {count > 0 && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{count > 9 ? "9+" : count}</Text>
                  </View>
                )}
              </View>

              <Text style={[styles.label, isActive && styles.activeLabel]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </BlurView>
    </View>
  );
}


const styles = StyleSheet.create({
  wrapper: {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0, // Extra padding for iOS
},
  container: {
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-around",

  paddingVertical: 10,
  paddingHorizontal: 6,
  paddingBottom: Platform.OS === "android" ? 28 : 20,
  borderTopLeftRadius: 0,
  borderTopRightRadius: 0,
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,

  overflow: "hidden",

  backgroundColor:
    Platform.OS === "android"
      ? "rgba(255,255,255,0.95)"
      : "transparent",

  borderTopWidth: 1,
  borderColor: "rgba(0,0,0,0.05)",
},

  item: {
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
  },

  pill: {
  paddingVertical: 8,
  paddingHorizontal: 20,
  borderRadius: 999, // true pill shape
  alignItems: "center",
  justifyContent: "center",
},


  activePill: {
    backgroundColor: PRIMARY,
    borderRadius: 999,
  },

  label: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: "600",
    color: "#000",
  },

  activeLabel: {
    color: PRIMARY,
  },

  initials: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "800",
    color: "#111",
  },

  badge: {
    position: "absolute",
    top: 2,
    right: 10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: "#EF4444",
    alignItems: "center",
    justifyContent: "center",
  },

  badgeText: {
    color: "#FFF",
    fontSize: 10,
    fontWeight: "800",
  },
});