import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation } from "@react-navigation/native";
import {
  PRIMARY, PRIMARY_LIGHT, BG, AMBER, AMBER_LIGHT, GREY,
  StudentQuiz, fmtDate, msToCountdown,
} from "./components/studentQuizConstants";

export default function StudentScheduledQuiz() {
  const navigation = useNavigation<any>();
  const route      = useRoute<any>();
  const { quiz }   = route.params as { quiz: StudentQuiz };

  const [countdown, setCountdown] = useState("");

  useEffect(() => {
    const tick = () => {
      const ms = new Date(quiz.scheduled_start).getTime() - Date.now();
      if (ms <= 0) { setCountdown("Starting soon..."); return; }
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setCountdown(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [quiz.scheduled_start]);

  const infoRows = [
    { label: "Subject",    value: quiz.subject_name },
    { label: "Questions",  value: `${quiz.question_count} questions` },
    { label: "Total Marks",value: `${quiz.total_marks} marks` },
    { label: "Duration",   value: `${quiz.time_limit_minutes} minutes` },
    { label: "Type",       value: quiz.question_type.replace("_", " ").toUpperCase() },
    { label: "Starts",     value: fmtDate(quiz.scheduled_start) },
    { label: "Ends",       value: fmtDate(quiz.scheduled_end) },
  ];

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={S.content} showsVerticalScrollIndicator={false}>

        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Text style={S.backIcon}>‹</Text>
        </TouchableOpacity>

        <Text style={S.title}>{quiz.title}</Text>
        {quiz.description ? <Text style={S.desc}>{quiz.description}</Text> : null}

        {/* Countdown */}
        <View style={S.countdownCard}>
          <Text style={S.countdownLabel}>Starts in</Text>
          <Text style={S.countdownTime}>{countdown}</Text>
          <Text style={S.countdownSub}>You'll be able to join when the quiz goes live</Text>
        </View>

        {/* Info card */}
        <View style={S.infoCard}>
          {infoRows.map((row) => (
            <View key={row.label} style={S.infoRow}>
              <Text style={S.infoLabel}>{row.label}</Text>
              <Text style={S.infoValue}>{row.value}</Text>
            </View>
          ))}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },

  backBtn:  { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", marginBottom: 16, elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  backIcon: { fontSize: 22, fontWeight: "700", color: PRIMARY },

  title: { fontSize: 24, fontWeight: "800", color: "#111827", marginBottom: 4 },
  desc:  { fontSize: 14, color: GREY, marginBottom: 20, lineHeight: 20 },

  countdownCard: {
    backgroundColor: AMBER_LIGHT,
    borderRadius: 20,
    padding: 20,
    alignItems: "center",
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#FDE68A",
  },
  countdownLabel: { fontSize: 13, fontWeight: "700", color: "#92400E", marginBottom: 6 },
  countdownTime:  { fontSize: 36, fontWeight: "900", color: "#78350F", fontVariant: ["tabular-nums"], marginBottom: 8 },
  countdownSub:   { fontSize: 12, color: "#92400E", textAlign: "center" },

  infoCard: { backgroundColor: "#FFF", borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: "#E5E7EB" },
  infoRow:  { flexDirection: "row", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  infoLabel:{ fontSize: 13, color: GREY, fontWeight: "600" },
  infoValue:{ fontSize: 13, color: "#111827", fontWeight: "700", maxWidth: "55%", textAlign: "right" },
});