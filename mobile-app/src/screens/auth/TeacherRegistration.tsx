import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
} from "react-native";
import { useNavigation } from "@react-navigation/native";

const PRIMARY = "#4834D4";
// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

const TeacherRegistration = ({ route }: any) => {
  const navigation = useNavigation<any>();
  const { email, password } = route.params;

  const [selectedDepts, setSelectedDepts] = useState<string[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [aisheCode, setAisheCode] = useState("");
  const [verifiedCollege, setVerifiedCollege] = useState<any>(null);
  const [courses, setCourses] = useState<any[]>([]);

  const toggleDept = (abbr: string) => {
    setSelectedDepts((prev) =>
      prev.includes(abbr) ? prev.filter((d) => d !== abbr) : [...prev, abbr]
    );
  };

  const handleVerifyCollege = async () => {
    const code = aisheCode.trim().toUpperCase();
    if (!code) { Alert.alert("Error", "Please enter AISHE code"); return; }
    if (verifying) return;

    try {
      setVerifying(true);
      setVerifiedCollege(null);
      setCourses([]);
      setSelectedDepts([]);

      const verifyRes = await fetch(`${API_URL}/api/colleges/verify/${code}`);
      const verifyData = await verifyRes.json();

      if (!verifyRes.ok) throw new Error(verifyData.error || "College not found");
      setVerifiedCollege(verifyData.college);

      const courseRes = await fetch(`${API_URL}/api/colleges/${code}/courses`);
      const courseData = await courseRes.json();

      if (!courseRes.ok) throw new Error(courseData.error || "No courses found");
      if (!Array.isArray(courseData.courses) || courseData.courses.length === 0)
        throw new Error("No courses mapped to this college");

      setCourses(courseData.courses);
      Alert.alert("College Verified ✓", verifyData.college.college_name);
    } catch (error: any) {
      setVerifiedCollege(null);
      setCourses([]);
      setSelectedDepts([]);
      Alert.alert("Verification Failed", error.message);
    } finally {
      setVerifying(false);
    }
  };

  const handleSubmit = async () => {
    if (!firstName.trim() || !lastName.trim()) {
      Alert.alert("Error", "First and last name are required");
      return;
    }
    if (!contactPhone.trim()) {
      Alert.alert("Error", "Contact number is required");
      return;
    }
    if (!verifiedCollege) {
      Alert.alert("Error", "Please verify your institute first");
      return;
    }
    if (selectedDepts.length === 0) {
      Alert.alert("Error", "Select at least one department");
      return;
    }

    try {
      setSubmitting(true);

      // departments = array of course abbreviations e.g. ["BCA", "MCA"]
      // This is what the backend stores in teachers.departments
      const payload = {
        email,
        password,
        role: "teacher",
        teacher: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          contact_phone: contactPhone.trim(),
          gender,
          aishe_code: verifiedCollege.aishe_code,
          departments: selectedDepts,
          designation: "Assistant Professor",
        },
      };

      //  Correct endpoint: /api/auth/register
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        console.error("NON-JSON:", text);
        throw new Error("Server error. Please try again.");
      }

      if (!res.ok) throw new Error(data.error || "Registration failed");

      Alert.alert(
        "Registration Submitted ✓",
        "Your account is pending admin approval. You will be notified once approved.",
        [{ text: "OK", onPress: () => navigation.navigate("Auth") }]
      );
    } catch (err: any) {
      Alert.alert("Error", err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = verifiedCollege && selectedDepts.length > 0 && !submitting;

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      <Text style={styles.header}>Teacher Registration</Text>

      <View style={styles.infoBox}>
        <Text style={styles.infoText}>
          📌 You register as a Teacher. If you are an HOD, an admin will upgrade
          your role after approval.
        </Text>
      </View>

      <Text style={styles.label}>First Name</Text>
      <TextInput
        style={styles.input}
        placeholder="Enter your first name"
        placeholderTextColor="#B0B0B0"
        value={firstName}
        onChangeText={setFirstName}
      />

      <Text style={styles.label}>Last Name</Text>
      <TextInput
        style={styles.input}
        placeholder="Enter your last name"
        placeholderTextColor="#B0B0B0"
        value={lastName}
        onChangeText={setLastName}
      />

      <Text style={styles.label}>Contact Number</Text>
      <TextInput
        style={styles.input}
        placeholder="Enter your mobile number"
        keyboardType="phone-pad"
        placeholderTextColor="#B0B0B0"
        value={contactPhone}
        onChangeText={setContactPhone}
      />

      <Text style={styles.label}>Gender</Text>
      <View style={styles.genderRow}>
        {(["male", "female"] as const).map((g) => (
          <TouchableOpacity key={g} style={styles.genderOption} onPress={() => setGender(g)}>
            <View style={[styles.radioOuter, gender === g && styles.radioOuterActive]}>
              {gender === g && <View style={styles.radioInner} />}
            </View>
            <Text style={styles.genderText}>
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Institute Verification</Text>
      <View style={styles.aisheRow}>
        <TextInput
          style={styles.aisheInput}
          placeholder="Enter AISHE Code (e.g. C-12345)"
          placeholderTextColor="#B0B0B0"
          value={aisheCode}
          onChangeText={setAisheCode}
          autoCapitalize="characters"
        />
        <TouchableOpacity
          style={[styles.verifyBtn, verifying && { opacity: 0.7 }]}
          onPress={handleVerifyCollege}
          disabled={verifying}
        >
          <Text style={styles.verifyText}>{verifying ? "..." : "Verify"}</Text>
        </TouchableOpacity>
      </View>

      {verifiedCollege && (
        <View style={styles.verifiedBadge}>
          <Text style={styles.verifiedBadgeText}>✓ {verifiedCollege.college_name}</Text>
        </View>
      )}

      <Text style={styles.label}>Departments</Text>
      <Text style={styles.subLabel}>
        {verifiedCollege
          ? "Select all departments you teach in"
          : "Verify your institute first to see departments"}
      </Text>

      {verifiedCollege && courses.length > 0 && (
        <View style={styles.deptWrap}>
          {courses.map((course) => {
            const isSelected = selectedDepts.includes(course.abbr);
            return (
              <TouchableOpacity
                key={course.id}
                style={[styles.deptPill, isSelected && styles.deptPillActive]}
                onPress={() => toggleDept(course.abbr)}
              >
                <Text style={[styles.deptAbbr, isSelected && styles.deptTextActive]}>
                  {course.abbr}
                </Text>
                <Text style={[styles.deptName, isSelected && styles.deptTextActiveLight]}>
                  {course.course_name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <TouchableOpacity
        style={[styles.submitBtn, !canSubmit && styles.submitDisabled]}
        disabled={!canSubmit}
        onPress={handleSubmit}
      >
        <Text style={styles.submitText}>
          {submitting ? "Submitting..." : "Complete Registration"}
        </Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFF", paddingHorizontal: 24 },
  header: { fontSize: 22, fontWeight: "700", marginTop: 20, marginBottom: 16 },
  infoBox: {
    backgroundColor: "#EEF2FF",
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  infoText: { fontSize: 13, color: "#4834D4", lineHeight: 20 },
  label: { fontSize: 15, fontWeight: "700", marginBottom: 8, marginTop: 18 },
  subLabel: { fontSize: 13, color: "#777", marginBottom: 10 },
  input: {
    height: 56,
    borderWidth: 1,
    borderColor: "#D0D0D0",
    borderRadius: 30,
    paddingHorizontal: 20,
    fontSize: 15,
    color: "#111",
  },
  genderRow: { flexDirection: "row", marginTop: 8 },
  genderOption: { flexDirection: "row", alignItems: "center", marginRight: 24 },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#C0C0C0",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  radioOuterActive: { borderColor: PRIMARY },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: PRIMARY },
  genderText: { fontSize: 15 },
  aisheRow: { flexDirection: "row", alignItems: "center" },
  aisheInput: {
    flex: 1,
    height: 56,
    borderWidth: 1,
    borderColor: "#D0D0D0",
    borderRadius: 30,
    paddingHorizontal: 20,
    marginRight: 10,
    fontSize: 14,
  },
  verifyBtn: {
    backgroundColor: PRIMARY,
    paddingHorizontal: 20,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
  },
  verifyText: { color: "#FFF", fontWeight: "600" },
  verifiedBadge: {
    marginTop: 8,
    backgroundColor: "#D1FAE5",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignSelf: "flex-start",
  },
  verifiedBadgeText: { color: "#065F46", fontWeight: "700", fontSize: 13 },
  deptWrap: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  deptPill: {
    borderWidth: 1,
    borderColor: "#CFCFCF",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    minWidth: 80,
  },
  deptPillActive: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  deptAbbr: { fontSize: 14, color: "#333", fontWeight: "700" },
  deptName: { fontSize: 11, color: "#666", marginTop: 2 },
  deptTextActive: { color: "#FFF" },
  deptTextActiveLight: { color: "rgba(255,255,255,0.8)" },
  submitBtn: {
    marginTop: 40,
    backgroundColor: PRIMARY,
    height: 58,
    borderRadius: 30,
    justifyContent: "center",
    alignItems: "center",
  },
  submitDisabled: { backgroundColor: "#D0D0D0" },
  submitText: { color: "#FFF", fontSize: 17, fontWeight: "700" },
});

export default TeacherRegistration;