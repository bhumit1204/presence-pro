import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator
} from "react-native";
import SubjectDropdown from "../../../components/SubjectDropdown";
import { getUserSession } from "../../../services/session";
import { useNavigation } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";
const API_URL = "http://10.132.90.56:5000";

interface Subject {
  subject_name: string;
  subject_code: string;
  subject_id?: string;
}

export default function TeacherQuizzes() {
  const navigation = useNavigation<any>();

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<Subject | null>(null);
  const [quizzes, setQuizzes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 📌 Fetch Subjects (same as attendance)
  const fetchSubjects = async () => {
    try {
      const session = await getUserSession();

      const res = await fetch(
        `${API_URL}/api/lectures/teachers/subjects?teacher_id=${session.teacher_id}`
      );

      const data = await res.json();
      if (data.success) setSubjects(data.subjects);

    } catch (err) {
      console.log("SUBJECT ERROR:", err);
    }
  };

  // 📌 Fetch quizzes
  const fetchQuizzes = async () => {
    try {
      const session = await getUserSession();

      const res = await fetch(
        `${API_URL}/api/quizzes/teacher/${session.teacher_id}`
      );

      const data = await res.json();

      if (data.success) {
        setQuizzes(data.quizzes);
      }

    } catch (err) {
      console.log("QUIZ FETCH ERROR:", err);
    } finally {
      setLoading(false);
    }
  };

  const formatDateTime = (dateStr: string) => {
    const d = new Date(dateStr);

    return (
      d.toLocaleDateString() +
      " • " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
  };

  const getQuizStatus = (quiz: any) => {
    const now = new Date();
    const start = new Date(quiz.scheduled_start);
    const end = new Date(quiz.scheduled_end);

    if (now < start) return "scheduled";
    if (now >= start && now <= end) return "live";
    return "completed";
  };

  useEffect(() => {
    fetchSubjects();
    fetchQuizzes();
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      fetchQuizzes();
    }, [])
  );

  // 📌 Filter quizzes by selected subject
  const filteredQuizzes = quizzes.filter(
    (q) =>
      !selectedSubject ||
      q.subject_name === selectedSubject.subject_name
  );

  const isDisabled = !selectedSubject;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* HEADER */}
        <View style={styles.header}>
          <Text style={styles.title}>Quizzes</Text>
          <Text style={styles.subtitle}>
            Create and manage tests
          </Text>
        </View>

        {/* SUBJECT DROPDOWN */}
        <View style={styles.section}>
          <SubjectDropdown
            subjects={subjects}
            selectedSubject={selectedSubject}
            onSelect={setSelectedSubject}
          />
        </View>

        {/* CREATE TEST CARD */}
        <View style={[styles.createCard, isDisabled && styles.disabledCard]}>
          <Text style={styles.createTitle}>Create Test</Text>

          <View style={styles.btnRow}>
            {/* MANUAL */}
            <TouchableOpacity
              style={[
                styles.outlineBtn,
                isDisabled && styles.disabledBtn
              ]}
              disabled={isDisabled}
              onPress={() => navigation.navigate("CreateQuizManual", {subject: selectedSubject,})}
            >
              <Text
                style={[
                  styles.outlineText,
                  isDisabled && styles.disabledText
                ]}
              >
                Create Manually
              </Text>
            </TouchableOpacity>

            {/* AI */}
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                isDisabled && styles.disabledBtn
              ]}
              disabled={isDisabled}
              onPress={() =>
                navigation.navigate("CreateQuizAI", {
                  subject: selectedSubject,
                })
              }
            >
              <Text
                style={[
                  styles.primaryText,
                  isDisabled && styles.disabledText
                ]}
              >
                Create with AI
              </Text>
            </TouchableOpacity>
          </View>

          {/* Helper */}
          {isDisabled && (
            <Text style={styles.helperText}>
              Select a subject to create a test
            </Text>
          )}
        </View>

        {/* QUIZ LIST */}
        <View style={styles.listSection}>
          <Text style={styles.listTitle}>Your Tests</Text>

          {loading ? (
            <ActivityIndicator size="large" color={PRIMARY} />
          ) : filteredQuizzes.length === 0 ? (
            <Text style={styles.emptyText}>
              {selectedSubject
                ? "No tests found for this subject"
                : "Select a subject to view tests"}
            </Text>
          ) : (
            filteredQuizzes.map((quiz) => (
              <TouchableOpacity
                key={quiz.quiz_id}
                style={styles.quizCard}
                onPress={() =>
                  navigation.navigate("ViewQuizScreen", {
                    quiz_id: quiz.quiz_id,
                  })
                }
              >
                {/* TOP ROW */}
                <View style={styles.rowBetween}>
                  <Text style={styles.quizTitle}>{quiz.title}</Text>

                  <View style={styles.codeBox}>
                    <Text style={styles.codeText}>{quiz.join_code}</Text>
                  </View>
                </View>

                {/* SUBJECT */}
                <Text style={styles.quizMeta}>{quiz.subject_name}</Text>

                {/* DATE + STATUS */}
                <View style={styles.rowBetween}>
                  <Text style={styles.dateText}>
                    {formatDateTime(quiz.scheduled_start)}
                  </Text>

                  <View
                    style={[
                      styles.statusBadge,
                      getQuizStatus(quiz) === "live" && styles.live,
                      getQuizStatus(quiz) === "scheduled" && styles.scheduled,
                      getQuizStatus(quiz) === "completed" && styles.completed,
                    ]}
                  >
                    <Text style={styles.statusText}>
                      {getQuizStatus(quiz).toUpperCase()}
                    </Text>
                  </View>
                </View>

                {/* BOTTOM */}
                <View style={styles.quizBottom}>
                  <Text style={styles.quizInfo}>
                    {quiz.question_count} Questions
                  </Text>

                  <Text style={styles.quizInfo}>
                    {quiz.total_marks} Marks
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({

  container: {
    flex: 1,
    backgroundColor: BG,
    paddingHorizontal: 20,
    paddingTop: 10,
  },

  content: {
    paddingBottom: 40,
  },

  header: {
    marginBottom: 24,
  },

  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#111827",
  },

  subtitle: {
    fontSize: 14,
    color: "#6B7280",
    marginTop: 4,
  },

  section: {
    marginBottom: 16,
  },

  createCard: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    padding: 20,
    marginBottom: 20,
    elevation: 3,
  },

  createTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 14,
  },

  btnRow: {
    flexDirection: "column",
    justifyContent: "space-between",
    gap: 12,
  },

  outlineBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: PRIMARY,
    paddingVertical: 14,
    borderRadius: 50,
    alignItems: "center",
    backgroundColor: "#F8F7FF",
    marginBottom: 10,
  },

  outlineText: {
    color: PRIMARY,
    fontWeight: "700",
    fontSize: 14,
  },

  primaryBtn: {
    flex: 1,
    backgroundColor: PRIMARY,
    paddingVertical: 18,
    borderRadius: 50,
    alignItems: "center",
  },

  primaryText: {
    color: "#FFF",
    fontWeight: "700",
    fontSize: 14,
  },

  listSection: {
    marginTop: 10,
    marginBottom: 50,
  },

  listTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
  },

  emptyText: {
    textAlign: "center",
    color: "#9CA3AF",
    marginTop: 20,
  },

  quizCard: {
    backgroundColor: "#FFF",
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    elevation: 2,
  },

  quizTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111",
  },

  quizMeta: {
    fontSize: 13,
    color: "#6B7280",
    marginTop: 4,
  },

  quizBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },

  quizInfo: {
    fontSize: 13,
    fontWeight: "600",
    color: PRIMARY,
  },

  disabledCard: {
    opacity: 0.6,
  },

  disabledBtn: {
    backgroundColor: "#E5E7EB",
    borderColor: "#D1D5DB",
  },

  disabledText: {
    color: "#9CA3AF",
  },

  helperText: {
    marginTop: 10,
    fontSize: 12,
    color: "#9CA3AF",
    textAlign: "center",
  },

  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },

  codeBox: {
    backgroundColor: "#EEF2FF",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },

  codeText: {
    color: PRIMARY,
    fontWeight: "700",
    fontSize: 12,
  },

  dateText: {
    fontSize: 12,
    color: "#6B7280",
    marginTop: 6,
  },

  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },

  statusText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#FFF",
  },

  live: {
    backgroundColor: "#10B981",
  },

  scheduled: {
    backgroundColor: "#F59E0B",
  },

  completed: {
    backgroundColor: "#6B7280",
  },
});