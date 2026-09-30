import React, { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import GlassBottomBar from "../../components/GlassBottomBar";
import { getUserSession } from "../../services/session";
import { TabContext } from "../../navigation/TabContext";
import TeacherHome from "./tabs/TeacherHome";
import TeacherReports from "./tabs/TeacherReports";
import TeacherWork from "./tabs/TeacherWork";
import TeacherQuizzes from "./tabs/TeacherQuizzes";

type UserRole = "teacher" | "student";

export default function TeacherDashboard() {
  const [role, setRole] = useState<UserRole | null>(null);
  const [currentTab, setCurrentTab] = useState("home");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadRole = async () => {
      const session = await getUserSession();
      if (session?.user?.role) {
        setRole(session.user.role);
      }
      setLoading(false);
    };
    loadRole();
  }, []);

  if (loading) {
    return <View style={{ flex: 1, backgroundColor: "#F3F4F6" }} />;
  }

  const renderContent = () => {
    switch (currentTab) {
      case "home":
        return <TeacherHome />;
      case "reports":
        return <TeacherReports />;
      case "work":
        return <TeacherWork />;
      case "quizzes":
        return <TeacherQuizzes />;
      default:
        return <TeacherHome />;
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
  container: {
    flex: 1,
    backgroundColor: "#F3F4F6",
  },
});