import React, { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import GlassBottomBar from "../../components/GlassBottomBar";
import { getUserSession } from "../../services/session";
import { TabContext } from "../../navigation/TabContext";
import TeacherHome from "./tabs/TeacherHome";
import TeacherReports from "./tabs/TeacherReports";
import TeacherWork from "./tabs/TeacherWork";
import TeacherQuizzes from "./tabs/TeacherQuizzes";
import HODManage from "./tabs/HODManage";
import HODBottomBar from "../../components/HODBottomBar";

type UserRole = "teacher" | "student" | "hod" | "head_teacher";

export default function HODDashboard() {
  const [role, setRole] = useState<UserRole | null>(null);
  const [currentTab, setCurrentTab] = useState("home");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadRole = async () => {
      const session = await getUserSession();
      if (session?.role) {
        setRole(session.role);
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
      case "manage":
        return <HODManage role={role} />;
      default:
        return <TeacherHome />;
    }
  };

  return (
    <TabContext.Provider value={{ currentTab, setCurrentTab }}>
      <View style={styles.container}>
        {renderContent()}
        {/* HODBottomBar shows the extra "Manage" tab for HOD/HeadTeacher */}
        <HODBottomBar role={role} />
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