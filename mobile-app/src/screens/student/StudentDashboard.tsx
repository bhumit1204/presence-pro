import React, { useState } from "react";
import { View, StyleSheet } from "react-native";
import GlassBottomBar, { TabKey } from "../../components/GlassBottomBar";
import { TabContext } from "../../navigation/TabContext";
import { T } from "../../components/ui";
import StudentHome from "./tabs/StudentHome";
import StudentAttendance from "./tabs/StudentAttendance";
import StudentWork from "./tabs/StudentWork";
import StudentQuizzes from "./tabs/StudentQuizzes";

export default function StudentDashboard() {
  const [currentTab, setCurrentTab] = useState<TabKey>("home");

  const renderContent = () => {
    switch (currentTab) {
      case "reports":
        return <StudentAttendance />;
      case "work":
        return <StudentWork />;
      case "quizzes":
        return <StudentQuizzes />;
      default:
        return <StudentHome />;
    }
  };

  return (
    <TabContext.Provider value={{ currentTab, setCurrentTab }}>
      <View style={styles.container}>
        {renderContent()}
        <GlassBottomBar />
      </View>
    </TabContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: T.bg },
});