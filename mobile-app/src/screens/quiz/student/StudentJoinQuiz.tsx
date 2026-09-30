import React, { useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  Alert, ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation } from "@react-navigation/native";
import { auth } from "../../../services/firebase";
import {
  PRIMARY, PRIMARY_LIGHT, BG, GREY, RED, GREEN, API_URL, StudentQuiz,
} from "./components/studentQuizConstants";

export default function StudentJoinQuiz() {
  const navigation = useNavigation<any>();
  const route      = useRoute<any>();
  const { quiz }   = route.params as { quiz: StudentQuiz };

  // If quiz has no join_code (open quiz), we skip the code-entry step
  const isOpenQuiz = !quiz.join_code;

  const [code,    setCode]    = useState("");
  const [loading, setLoading] = useState(false);

  /* ── Shared join logic ─────────────────────────────────────────────────────*/
  const proceedToQuiz = async (resolvedCode?: string) => {
    setLoading(true);
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) { Alert.alert("Error", "Not logged in"); return; }

      // For open quizzes we hit a dedicated endpoint that doesn't require a code.
      // For code-gated quizzes we use the existing /join/:code endpoint.
      let res: Response;
      if (isOpenQuiz) {
        res = await fetch(`${API_URL}/api/quizzes/join-open/${quiz.quiz_id}`);
      } else {
        res = await fetch(`${API_URL}/api/quizzes/join/${resolvedCode}`);
      }

      const data = await res.json();

      if (!data.success) {
        // Surface expiry errors clearly
        const msg =
          data.error === "join_code_expired"
            ? "The join code has expired. Please ask your teacher for a new one."
            : data.error || "Invalid or expired join code.";
        Alert.alert("Cannot Join", msg);
        return;
      }

      navigation.replace("TakeQuiz", {
        quiz:        data.quiz,
        questions:   data.questions,
        student_uid: uid,
      });
    } catch (e) {
      Alert.alert("Error", "Could not connect to server.");
    } finally {
      setLoading(false);
    }
  };

  /* ── Code-entry join ───────────────────────────────────────────────────────*/
  const handleJoinWithCode = () => {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length !== 6) {
      Alert.alert("Invalid Code", "Please enter a 6-character join code.");
      return;
    }
    proceedToQuiz(trimmed);
  };

  /* ── Auto-join for open quizzes ────────────────────────────────────────────*/
  const handleJoinOpen = () => proceedToQuiz();

  /* ── UI ───────────────────────────────────────────────────────────────────*/
  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
        <Text style={S.backIcon}>‹</Text>
      </TouchableOpacity>

      <View style={S.body}>
        {/* Live pill */}
        <View style={S.livePill}>
          <View style={S.liveDot} />
          <Text style={S.liveTxt}>LIVE NOW</Text>
        </View>

        {quiz && (
          <>
            <Text style={S.quizTitle}>{quiz.title}</Text>
            <Text style={S.quizSub}>{quiz.subject_name}</Text>
          </>
        )}

        {/* ── OPEN QUIZ ──────────────────────────────────────────────────────*/}
        {isOpenQuiz ? (
          <>
            <View style={S.openCard}>
              <View style={S.openIconRow}>
                <Text style={S.openIcon}>🔓</Text>
                <View style={{ flex: 1 }}>
                  <Text style={S.openTitle}>Open Quiz</Text>
                  <Text style={S.openSub}>
                    No join code required — tap below to start immediately.
                  </Text>
                </View>
              </View>

              <View style={S.openMeta}>
                <MetaPill icon="❓" text={`${quiz.question_count} questions`} />
                <MetaPill icon="🏆" text={`${quiz.total_marks} marks`} />
                <MetaPill icon="⏱" text={`${quiz.time_limit_minutes} min`} />
              </View>

              <TouchableOpacity
                style={[S.joinBtn, loading && { opacity: 0.7 }]}
                onPress={handleJoinOpen}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading
                  ? <ActivityIndicator color="#FFF" />
                  : <Text style={S.joinBtnTxt}>Start Quiz →</Text>
                }
              </TouchableOpacity>
            </View>
          </>
        ) : (
          /* ── CODE-GATED QUIZ ──────────────────────────────────────────────*/
          <View style={S.card}>
            <Text style={S.cardTitle}>Enter Join Code</Text>
            <Text style={S.cardSub}>
              Enter the 6-character code provided by your teacher
            </Text>

            <TextInput
              style={S.input}
              value={code}
              onChangeText={(t) => setCode(t.toUpperCase())}
              placeholder="e.g. ABC123"
              placeholderTextColor="#9CA3AF"
              maxLength={6}
              autoCapitalize="characters"
              autoFocus
              textAlign="center"
            />

            {/* Expiry notice (if quiz carries expiry info) */}
            {quiz.join_code_expiry_at && (
              <View style={S.expiryNotice}>
                <Text style={S.expiryNoticeText}>
                  ⏳ Code expires at{" "}
                  {new Date(quiz.join_code_expiry_at).toLocaleTimeString([], {
                    hour: "2-digit", minute: "2-digit",
                  })}
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={[S.joinBtn, loading && { opacity: 0.7 }]}
              onPress={handleJoinWithCode}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading
                ? <ActivityIndicator color="#FFF" />
                : <Text style={S.joinBtnTxt}>Join & Start Quiz →</Text>
              }
            </TouchableOpacity>
          </View>
        )}

        {/* Warning box — shown for both */}
        <View style={S.warningBox}>
          <Text style={S.warningTitle}>⚠️ Before you start</Text>
          <Text style={S.warningText}>
            • Do not switch apps — quiz will auto-submit{"\n"}
            • Screenshots are disabled during the quiz{"\n"}
            • You cannot re-take once submitted
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

/* ── Small helper ─────────────────────────────────────────────────────────────*/
function MetaPill({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={S.metaPill}>
      <Text style={S.metaIcon}>{icon}</Text>
      <Text style={S.metaText}>{text}</Text>
    </View>
  );
}

const S = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: BG, paddingHorizontal: 20 },
  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", marginTop: 16, marginBottom: 24, elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
  backIcon:{ fontSize: 22, fontWeight: "700", color: PRIMARY },

  body: { flex: 1 },

  livePill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#F0FDF4", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, alignSelf: "flex-start", marginBottom: 16 },
  liveDot:  { width: 8, height: 8, borderRadius: 4, backgroundColor: GREEN },
  liveTxt:  { color: GREEN, fontWeight: "800", fontSize: 12, letterSpacing: 0.5 },

  quizTitle: { fontSize: 24, fontWeight: "800", color: "#111827", marginBottom: 4 },
  quizSub:   { fontSize: 14, color: GREY, marginBottom: 24 },

  /* Open quiz card */
  openCard: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: "#BBF7D0",
    marginBottom: 16,
    shadowColor: GREEN,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
    gap: 16,
  },
  openIconRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  openIcon:    { fontSize: 28 },
  openTitle:   { fontSize: 17, fontWeight: "800", color: "#111827", marginBottom: 3 },
  openSub:     { fontSize: 13, color: GREY, lineHeight: 18 },

  openMeta: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  metaPill: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#F0FDF4", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  metaIcon: { fontSize: 13 },
  metaText: { fontSize: 12, fontWeight: "700", color: "#065F46" },

  /* Code-gated card */
  card: {
    backgroundColor: "#FFF",
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    marginBottom: 16,
    shadowColor: PRIMARY,
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  cardTitle: { fontSize: 18, fontWeight: "800", color: "#111827", marginBottom: 6 },
  cardSub:   { fontSize: 13, color: GREY, marginBottom: 16, lineHeight: 18 },

  input: {
    height: 60,
    borderWidth: 2,
    borderColor: PRIMARY,
    borderRadius: 16,
    fontSize: 24,
    fontWeight: "800",
    color: PRIMARY,
    letterSpacing: 6,
    paddingHorizontal: 20,
    backgroundColor: PRIMARY_LIGHT,
    marginBottom: 12,
  },

  expiryNotice: {
    backgroundColor: "#FFFBEB",
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#FDE68A",
  },
  expiryNoticeText: { fontSize: 12, color: "#92400E", fontWeight: "600" },

  joinBtn:    { backgroundColor: PRIMARY, borderRadius: 16, height: 54, alignItems: "center", justifyContent: "center", shadowColor: PRIMARY, shadowOpacity: 0.3, shadowRadius: 10, elevation: 4 },
  joinBtnTxt: { color: "#FFF", fontWeight: "800", fontSize: 16 },

  warningBox: { backgroundColor: "#FFFBEB", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#FDE68A" },
  warningTitle:{ fontSize: 14, fontWeight: "700", color: "#92400E", marginBottom: 8 },
  warningText: { fontSize: 13, color: "#78350F", lineHeight: 20 },
});