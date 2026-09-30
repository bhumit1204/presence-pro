import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getUserSession } from "../../../services/session";
import { useNavigation, useRoute } from "@react-navigation/native";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

export default function CreateQuizAI() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();

  const { subject } = route.params;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [syllabus, setSyllabus] = useState("");

  const [questionCount, setQuestionCount] = useState("10");
  const [marksPerQuestion, setMarksPerQuestion] = useState("2");

  const [sameMarks, setSameMarks] = useState(true);
  const [questionType, setQuestionType] = useState("mixed");
  const [difficulty, setDifficulty] = useState("Medium");
  const [showDropdown, setShowDropdown] = useState(false);

  const [loading, setLoading] = useState(false);

  const handleGenerate = async () => {
    if (!title || !syllabus.trim()) {
        alert("Please fill all required fields");
        return;
    }

    const session = await getUserSession();

    const payload = {
        teacher_id: session.teacher_id,
        subject_id: subject.subject_id,
        syllabus: syllabus.trim(),
        question_count: Number(questionCount),
        question_type: questionType.toLowerCase(),
        difficulty: difficulty.toLowerCase(),
        custom_marks_enabled: !sameMarks,
        marks_per_question: sameMarks ? Number(marksPerQuestion) : undefined,
    };

    //  Navigate immediately
    navigation.navigate("QuizPreviewScreen", {
        formData: payload,
        meta: { title, description },
    });
    };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* BACK BUTTON */}
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>

        {/* HEADER */}
        <Text style={styles.title}>Create Quiz (AI)</Text>
        <Text style={styles.subtitle}>Generate questions using AI</Text>

        {/* FORM CARD */}
        <View style={styles.card}>

          {/* TITLE */}
          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter quiz title"
            value={title}
            onChangeText={setTitle}
          />

          {/* DESCRIPTION */}
          <Text style={styles.label}>Description</Text>
          <TextInput
            style={styles.input}
            placeholder="Short description (optional)"
            value={description}
            onChangeText={setDescription}
          />

          {/* SYLLABUS */}
          <Text style={styles.label}>Syllabus</Text>
          <TextInput
            style={[styles.input, styles.textarea]}
            placeholder="e.g. Python basics, loops, OOP..."
            multiline
            value={syllabus}
            onChangeText={setSyllabus}
          />

          {/* TOGGLE */}
          <View style={styles.row}>
            <Text style={styles.label}>Same Marks</Text>
            <TouchableOpacity
              style={[styles.toggle, sameMarks && styles.toggleActive]}
              onPress={() => setSameMarks(!sameMarks)}
            >
              <View style={[styles.knob, sameMarks && styles.knobActive]} />
            </TouchableOpacity>
          </View>

          {/* INLINE INPUTS */}
          <View style={styles.inlineRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Marks</Text>
              <TextInput
                style={[styles.input, !sameMarks && styles.disabled]}
                placeholder="Marks"
                editable={sameMarks}
                value={marksPerQuestion}
                onChangeText={setMarksPerQuestion}
                keyboardType="numeric"
              />
            </View>

            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Questions</Text>
              <TextInput
                style={styles.input}
                placeholder="No. of questions"
                value={questionCount}
                onChangeText={setQuestionCount}
                keyboardType="numeric"
              />
            </View>
          </View>

          {/* DROPDOWN */}
          <Text style={styles.label}>Question Type</Text>
          <TouchableOpacity
            style={styles.dropdown}
            onPress={() => setShowDropdown(!showDropdown)}
          >
            <Text style={styles.dropdownText}>
              {questionType.charAt(0).toUpperCase() + questionType.slice(1)}
            </Text>
            <Text style={styles.arrow}>⌄</Text>
          </TouchableOpacity>

          {showDropdown && (
            <View style={styles.dropdownList}>
              {["mcq", "open_ended", "mixed"].map((type) => (
                <TouchableOpacity
                  key={type}
                  style={styles.dropdownItem}
                  onPress={() => {
                    setQuestionType(type);
                    setShowDropdown(false);
                  }}
                >
                  <Text style={styles.dropdownItemText}>
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* DIFFICULTY */}
          <Text style={styles.label}>Difficulty</Text>
          <View style={styles.optionRow}>
            {["Easy", "Medium", "Hard"].map((lvl) => (
              <TouchableOpacity
                key={lvl}
                style={[
                  styles.option,
                  difficulty === lvl && styles.optionActive
                ]}
                onPress={() => setDifficulty(lvl)}
              >
                <Text
                  style={[
                    styles.optionText,
                    difficulty === lvl && styles.optionTextActive
                  ]}
                >
                  {lvl}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

        </View>

        {/* GENERATE BUTTON */}
        <TouchableOpacity style={styles.btn} onPress={handleGenerate}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnText}>Generate Quiz</Text>
          )}
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({

  container: {
    flex: 1,
    backgroundColor: BG,
    paddingHorizontal: 20,
  },

  content: {
    paddingBottom: 40,
  },

  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#EEE",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 10
  },

  backIcon: {
    fontSize: 20,
    fontWeight: "700",
  },

  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#111827",
  },

  subtitle: {
    fontSize: 14,
    color: "#6B7280",
    marginBottom: 14,
  },

  card: {
    backgroundColor: "#FFF",
    borderRadius: 30,
    padding: 20,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },

  label: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: "700",
    color: "#111",
  },

  input: {
    height: 52,
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 30,
    paddingHorizontal: 18,
    marginTop: 6,
    fontSize: 15,
    backgroundColor: "#FFF",
  },

  textarea: {
    height: 90,
    textAlignVertical: "top",
    paddingTop: 12,
  },

  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 12,
    marginBottom: 6,
  },

  toggle: {
    width: 50,
    height: 28,
    borderRadius: 20,
    backgroundColor: "#D1D5DB",
    justifyContent: "center",
  },

  toggleActive: {
    backgroundColor: PRIMARY,
  },

  knob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#FFF",
    marginLeft: 3,
  },

  knobActive: {
    marginLeft: 25,
  },

  inlineRow: {
    flexDirection: "row",
    gap: 12,
  },

  disabled: {
    backgroundColor: "#F3F4F6",
  },

  dropdown: {
    height: 52,
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 30,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 18,
    marginTop: 6,
  },

  dropdownText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111",
  },

  arrow: {
    fontSize: 18,
    color: "#6B7280",
  },

  dropdownList: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 16,
    marginTop: 8,
    backgroundColor: "#FFF",
  },

  dropdownItem: {
    paddingVertical: 14,
    paddingHorizontal: 16,
  },

  dropdownItemText: {
    fontSize: 15,
    fontWeight: "600",
  },

  optionRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 10,
  },

  option: {
    flex: 1,
    height: 45,
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },

  optionActive: {
    backgroundColor: PRIMARY,
    borderColor: PRIMARY,
  },

  optionText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#444",
  },

  optionTextActive: {
    color: "#FFF",
    fontWeight: "700",
  },

  btn: {
    marginTop: 20,
    height: 55,
    backgroundColor: PRIMARY,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },

  btnText: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "700",
  },
});