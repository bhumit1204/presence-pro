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

export type HODTabKey = "home" | "reports" | "work" | "quizzes" | "manage";

interface Props {
  role: "teacher" | "student" | "hod" | "head_teacher" | null;
}

export default function HODBottomBar({ role }: Props) {
  const { currentTab, setCurrentTab } = useTab();

  const baseTabs: {
    key: HODTabKey;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
  }[] = [
    { key: "home", label: "Home", icon: "home" },
    { key: "reports", label: "Reports", icon: "bar-chart" },
    { key: "work", label: "Work", icon: "briefcase" },
    { key: "quizzes", label: "Quizzes", icon: "document-text" },
  ];

  // Both HOD and head_teacher get the Manage tab
  const isManager = role === "hod" || role === "head_teacher";

  const tabs = isManager
    ? [
        ...baseTabs,
        { key: "manage" as HODTabKey, label: "Manage", icon: "settings" as keyof typeof Ionicons.glyphMap },
      ]
    : baseTabs;

  return (
    <View style={styles.wrapper}>
      <BlurView intensity={70} tint="light" style={styles.container}>
        {tabs.map((tab) => {
          const isActive = currentTab === tab.key;

          return (
            <TouchableOpacity
              key={tab.key}
              style={styles.item}
              onPress={() => setCurrentTab(tab.key)}
              activeOpacity={0.8}
            >
              <View style={[styles.pill, isActive && styles.activePill]}>
                <Ionicons
                  name={tab.icon}
                  size={22}
                  color={isActive ? "#FFF" : "#111"}
                />
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
    right: 0,
  },
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingVertical: 10,
    paddingHorizontal: 6,
    paddingBottom: Platform.OS === "android" ? 28 : 20,
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
    paddingHorizontal: 16,
    borderRadius: 999,
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
});