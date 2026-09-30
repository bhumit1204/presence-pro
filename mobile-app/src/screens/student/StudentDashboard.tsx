import React, { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import GlassBottomBar from "../../components/GlassBottomBar";
import { TabKey } from "../../components/GlassBottomBar";
import { getUserSession } from "../../services/session";
import { TabContext } from "../../navigation/TabContext";
import StudentHome from "./tabs/StudentHome";
import StudentAttendance from "./tabs/StudentAttendance";
import StudentWork from "./tabs/StudentWork";
import StudentQuizzes from "./tabs/StudentQuizzes";  

type UserRole = "teacher" | "student";

export default function StudentDashboard() {
  const [role, setRole] = useState<UserRole | null>(null);
  const [currentTab, setCurrentTab] = useState<TabKey>("home");
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

  //  FIX: renderContent() is now actually used
  const renderContent = () => {
    switch (currentTab) {
      case "home":
        return <StudentHome />;
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
  container: {
    flex: 1,
    backgroundColor: "#F3F4F6",
  },
});