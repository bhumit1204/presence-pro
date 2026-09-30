import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation } from "@react-navigation/native";
import {
  PRIMARY, BG, GREEN, GREEN_LIGHT,
  AMBER, AMBER_LIGHT, RED, RED_LIGHT, GREY,
  GradedAnswer,
} from "./components/studentQuizConstants";

export default function QuizResultScreen() {
  const navigation = useNavigation<any>();
  const route      = useNavigation<any>();
  const { result, quiz_title } = (useRoute<any>()).params as {
    result: {
      total_marks:    number;
      marks_obtained: number;
      percentage:     number;
      graded_answers: GradedAnswer[];
    };
    quiz_title: string;
  };

  const pct      = result.percentage;
  const color    = pct >= 75 ? GREEN : pct >= 50 ? AMBER : RED;
  const bgColor  = pct >= 75 ? GREEN_LIGHT : pct >= 50 ? AMBER_LIGHT : RED_LIGHT;
  const message  = pct >= 75 ? "Great work!" : pct >= 50 ? "Good effort!" : "Keep practising";

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <View style={S.container}>

        {/* Big tick circle */}
        <View style={[S.tickCircle, { backgroundColor: bgColor, borderColor: color }]}>
          <Text style={[S.tickIcon, { color }]}>✓</Text>
        </View>

        <Text style={S.submittedLabel}>Submitted!</Text>
        <Text style={S.quizTitle}>{quiz_title}</Text>

        {/* Score card */}
        <View style={[S.scoreCard, { borderColor: color }]}>
          <Text style={[S.percentage, { color }]}>{pct.toFixed(1)}%</Text>
          <Text style={S.marks}>
            {result.marks_obtained.toFixed(1)} / {result.total_marks} marks
          </Text>
          <Text style={[S.message, { color }]}>{message}</Text>
        </View>

        <TouchableOpacity
          style={[S.doneBtn, { backgroundColor: color }]}
          onPress={() => navigation.navigate("StudentDashboard")}
          activeOpacity={0.85}
        >
          <Text style={S.doneBtnTxt}>Back to Dashboard</Text>
        </TouchableOpacity>

      </View>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: BG },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 16,
  },

  tickCircle: {
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  tickIcon: {
    fontSize: 56,
    fontWeight: "900",
    lineHeight: 68,
  },

  submittedLabel: {
    fontSize: 28,
    fontWeight: "900",
    color: "#111827",
  },
  quizTitle: {
    fontSize: 15,
    color: GREY,
    fontWeight: "600",
    textAlign: "center",
    marginTop: -8,
  },

  scoreCard: {
    width: "100%",
    backgroundColor: "#FFF",
    borderRadius: 20,
    borderWidth: 2,
    padding: 24,
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  percentage: {
    fontSize: 52,
    fontWeight: "900",
    lineHeight: 60,
  },
  marks: {
    fontSize: 18,
    fontWeight: "700",
    color: "#374151",
  },
  message: {
    fontSize: 14,
    fontWeight: "700",
    marginTop: 4,
  },

  doneBtn: {
    width: "100%",
    height: 54,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 4,
  },
  doneBtnTxt: {
    color: "#FFF",
    fontWeight: "800",
    fontSize: 16,
  },
});