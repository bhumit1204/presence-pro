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
const BG = "#F5F6FA";
const CARD = "#FFFFFF";
const TEXT = "#111827";
const SUBTEXT = "#6B7280";
const BORDER = "#E5E7EB";

// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";


const YEARS = ["1st Year", "2nd Year", "3rd Year", "4th Year"];
const SEM_MAP: any = {
  "1st Year": ["Sem 1", "Sem 2"],
  "2nd Year": ["Sem 3", "Sem 4"],
  "3rd Year": ["Sem 5", "Sem 6"],
  "4th Year": ["Sem 7", "Sem 8"],
};

export default function StudentRegistration({ route }: any) {
  const navigation = useNavigation<any>();
  const { email, password, role } = route.params;

  const [step, setStep] = useState(1);
  const [verifying, setVerifying] = useState(false);
  const [searchCourse, setSearchCourse] = useState("");
  const [showCourseList, setShowCourseList] = useState(false);
  const [availableSemesters, setAvailableSemesters] = useState<string[]>([]);
  const [aisheCode, setAisheCode] = useState("");
  const [verifiedCollege, setVerifiedCollege] = useState<any>(null);
  const [courses, setCourses] = useState<any[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [rollNo, setRollNo] = useState("");
  const [phone, setPhone] = useState("");
  const [selectedCourse, setSelectedCourse] = useState("");
  const [semester, setSemester] = useState("");
  const [year, setYear] = useState("");
  const [showYear, setShowYear] = useState(false);
  const [showSem, setShowSem] = useState(false);

  // ====================================================
  // 🔎 VERIFY COLLEGE (STEP 1)
  // ====================================================

    const validatePassword = (password: string) => {
    const regex =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

    if (!regex.test(password)) {
      return "Password must be 8+ chars with uppercase, lowercase, number & special character";
    }

    return null;
  };

  const handleVerifyCollege = async () => {
    const code = aisheCode.trim().toUpperCase();

    if (!code) {
      Alert.alert("Error", "Enter AISHE code");
      return;
    }

    if (verifying) return;

    try {
      setVerifying(true);
      setVerifiedCollege(null);
      setCourses([]);

      const verifyRes = await fetch(
        `${API_URL}/api/colleges/verify/${code}`
      );

      const verifyData = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verifyData.error);

      setVerifiedCollege(verifyData.college);

      const courseRes = await fetch(
        `${API_URL}/api/colleges/${code}/courses`
      );

      const courseData = await courseRes.json();
      setCourses(courseData.courses || []);
    } catch (err: any) {
      setVerifiedCollege(null);
      Alert.alert("Error", err.message);
    } finally {
      setVerifying(false);
    }
  };

  // ====================================================
  // 🚀 FINAL SUBMIT (STEP 3)
  // ====================================================
  const handleFinish = async () => {
    try {
      const passwordError = validatePassword(password);
      if (passwordError) {
        Alert.alert("Weak Password", passwordError);
        return;
      }

      if (!verifiedCollege) {
        Alert.alert("Error", "Please verify college first");
        return;
      }

      if (!selectedCourse || !semester || !year) {
        Alert.alert("Error", "Please complete academic details");
        return;
      }

      const payload = {
        email,
        password,
        role: "student",
        student: {
          first_name: firstName,
          last_name: lastName,
          roll_no: rollNo,
          phone,
          aishe_code: verifiedCollege.aishe_code,
          college_name: verifiedCollege.college_name,
          course_name: selectedCourse,
          semester,
          year,
        },
      };

      const res = await fetch(`${API_URL}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      //  SAFE PARSE
      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        console.log("NON JSON RESPONSE:", text);
        throw new Error("Server returned invalid response");
      }

      if (!res.ok) {
        throw new Error(data?.error || "Registration failed");
      }

      console.log("REGISTER SUCCESS:", data);

      Alert.alert("Success", "Registration completed", [
        {
          text: "OK",
          onPress: () =>
            navigation.reset({
              index: 0,
              routes: [{ name: "Auth" }],
            }),
        },
      ]);
    } catch (err: any) {
      console.log("REGISTER ERROR:", err);
      Alert.alert("Error", err.message || "Something went wrong");
    }
  };

  // ====================================================
  // 🧩 STEP UI RENDER
  // ====================================================

  const renderStep = () => {
    if (step === 1) {
      return (
        <>
          <Text style={styles.title}>Find your College</Text>

          <View style={styles.aisheRow}>
            <TextInput
              style={styles.aisheInput}
              placeholder="Enter AISHE Code"
              value={aisheCode}
              onChangeText={setAisheCode}
            />

            <TouchableOpacity
              style={styles.verifyBtn}
              onPress={handleVerifyCollege}
              disabled={verifying}
            >
              <Text style={{ color: "#fff" }}>
                {verifying ? "Verifying..." : "Verify"}
              </Text>
            </TouchableOpacity>
          </View>

          {verifiedCollege && (
            <View style={styles.collegeCard}>
              <Text style={styles.collegeTitle}>Verified College</Text>
              <Text style={styles.collegeName}>
                {verifiedCollege.college_name}
              </Text>
            </View>
          )}
        </>
      );
    }

    if (step === 2) {
      return (
        <>
          <Text style={styles.title}>Personal Details</Text>

          <TextInput style={styles.input} placeholder="First Name" value={firstName} onChangeText={setFirstName} />
          <TextInput style={styles.input} placeholder="Last Name" value={lastName} onChangeText={setLastName} />
          <TextInput style={styles.input} placeholder="Roll Number / PRN" value={rollNo} onChangeText={setRollNo} />
          <TextInput style={styles.input} placeholder="Phone Number" value={phone} onChangeText={setPhone} />
        </>
      );
    }

    return (
      <>
        <Text style={styles.title}>Academic Info</Text>

        {/* ================= COURSE DROPDOWN ================= */}
        <TouchableOpacity
          style={styles.input}
          activeOpacity={0.8}
          onPress={() => {
            setShowCourseList((v) => !v);
            setShowYear(false);
            setShowSem(false);
          }}
        >
          <Text style={{ color: selectedCourse ? "#111" : "#9CA3AF" }}>
            {selectedCourse || "Select Course"}
          </Text>
        </TouchableOpacity>

        {showCourseList && (
          <View style={styles.dropdownBox}>
            <ScrollView nestedScrollEnabled>
              {courses.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  style={styles.dropdownItem}
                  onPress={() => {
                    setSelectedCourse(c.course_name);
                    setShowCourseList(false);
                  }}
                >
                  <Text>{c.course_name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* ================= YEAR DROPDOWN ================= */}
        <TouchableOpacity
          style={styles.input}
          onPress={() => {
            setShowYear((v) => !v);
            setShowCourseList(false);
            setShowSem(false);
          }}
        >
          <Text>{year}</Text>
        </TouchableOpacity>

        {showYear && (
          <View style={styles.dropdownBox}>
            {YEARS.map((y) => (
              <TouchableOpacity
                key={y}
                style={styles.dropdownItem}
                onPress={() => {
                  setYear(y);
                  setSemester(SEM_MAP[y][0]); // auto reset semester
                  setShowYear(false);
                }}
              >
                <Text>{y}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* ================= SEMESTER DROPDOWN ================= */}
        <TouchableOpacity
          style={styles.input}
          onPress={() => {
            setShowSem((v) => !v);
            setShowYear(false);
            setShowCourseList(false);
          }}
        >
          <Text>{semester}</Text>
        </TouchableOpacity>

        {showSem && (
          <View style={styles.dropdownBox}>
            {SEM_MAP[year]?.map((s: string) => (
              <TouchableOpacity
                key={s}
                style={styles.dropdownItem}
                onPress={() => {
                  setSemester(s);
                  setShowSem(false);
                }}
              >
                <Text>{s}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </>
    );
  };

  // ====================================================
  // 🔥 MAIN RENDER
  // ====================================================
  return (
    <ScrollView style={styles.container} contentContainerStyle={{ flexGrow: 1 }}>
      <Text style={styles.header}>Student Profile</Text>

      {/* STEP INDICATOR */}
      <View style={styles.stepRow}>
        {[1, 2, 3].map((n) => (
          <View key={n} style={[styles.stepCircle, step >= n && styles.activeStep]}>
            <Text style={{ color: "#fff" }}>{n}</Text>
          </View>
        ))}
      </View>

      {renderStep()}

      <View style={styles.bottomRow}>
        {step > 1 && (
          <TouchableOpacity onPress={() => setStep(step - 1)}>
            <Text style={styles.backBtnText}>Back</Text>
          </TouchableOpacity>
        )}

        {step < 3 && (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => {

              // 🔥 STEP 1 VALIDATION
              if (step === 1 && !verifiedCollege) {
                Alert.alert("Error", "Please verify your college first");
                return;
              }

              // 🔥 STEP 2 VALIDATION
              if (step === 2 && (!firstName || !lastName || !rollNo || !phone)) {
                Alert.alert("Error", "Please fill all personal details");
                return;
              }

              setStep(step + 1);
            }}
          >
            <Text style={{ color: "#fff" }}>Next Step</Text>
          </TouchableOpacity>
        )}

        {step === 3 && (
          <TouchableOpacity style={styles.primaryBtn} onPress={handleFinish}>
            <Text style={{ color: "#fff" }}>Finish Registration</Text>
          </TouchableOpacity>
        )}

      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BG,
    paddingHorizontal: 24,
    paddingTop: 50,
  },

  header: {
    fontSize: 24,
    fontWeight: "700",
    color: TEXT,
    marginTop: 12,
    marginBottom: 24,
  },

  title: {
    fontSize: 20,
    fontWeight: "700",
    color: PRIMARY,
    marginBottom: 18,
  },

  /* STEP INDICATOR */
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 30,
  },

  stepCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#E5E7EB",
    justifyContent: "center",
    alignItems: "center",
  },

  activeStep: {
    backgroundColor: PRIMARY,
    shadowColor: PRIMARY,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },

  /* INPUTS */
  input: {
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: 20,
    fontSize: 15,
    backgroundColor: CARD,
    color: TEXT,
    marginBottom: 14,
    shadowColor: "#000",
    shadowOpacity: 0.03,
    shadowRadius: 6,
    justifyContent: "center",
  },

  aisheRow: {
    flexDirection: "row",
    alignItems: "center",
  },

  aisheInput: {
    flex: 1,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    paddingHorizontal: 18,
    backgroundColor: "#FFF",
  },

  verifyBtn: {
    height: 56,
    paddingHorizontal: 22,
    borderRadius: 28,
    marginLeft: 12,          // spacing from input
    backgroundColor: PRIMARY,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: PRIMARY,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },

  collegeCard: {
    marginTop: 16,
    backgroundColor: "#FFF",
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },

  collegeTitle: {
    fontSize: 13,
    color: "#6B7280",
  },

  collegeName: {
    fontSize: 15,
    fontWeight: "600",
    marginTop: 4,
  },

  collegeText: {
    fontSize: 15,
    color: TEXT,
    fontWeight: "600",
  },

  /* COURSE DROPDOWN ITEM */
  courseItem: {
    backgroundColor: CARD,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: BORDER,
  },

  courseText: {
    fontSize: 15,
    color: TEXT,
  },

  courseSelected: {
    backgroundColor: PRIMARY,
  },

  courseTextActive: {
    color: "#FFF",
    fontWeight: "600",
  },

  /* BOTTOM NAV */
  bottomRow: {
    marginTop: "auto",
    marginBottom: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },

  primaryBtn: {
    flex: 1,
    backgroundColor: PRIMARY,
    height: 56,
    paddingHorizontal: 34,
    borderRadius: 28,
    justifyContent: "center",
    alignItems: "center",

    shadowColor: PRIMARY,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },

  primaryBtnText: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "700",
  },

  backText: {
    fontSize: 16,
    color: SUBTEXT,
    fontWeight: "600",
  },
  dropdownBox: {
    backgroundColor: "#FFF",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    overflow: "hidden",
    zIndex: 999,
    elevation: 1,
    marginBottom: 14,
  },

  dropdownItem: {
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  backBtnText: {
    fontSize: 16,
    color: SUBTEXT,
    fontWeight: "600",
    marginHorizontal: 10,
    marginRight: 30,
  },
});