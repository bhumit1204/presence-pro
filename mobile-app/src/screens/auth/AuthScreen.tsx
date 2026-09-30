import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import {
  collection,
  query,
  where,
  getDocs,
  limit,
} from "firebase/firestore";
import { signInWithEmailAndPassword } from "firebase/auth";
import { sendPasswordResetEmail } from "firebase/auth";
import { auth } from "../../services/firebase";
import { db } from "../../services/firebase";
import { useNavigation } from "@react-navigation/native";
import { saveUserSession } from "../../services/session";


// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";
// const API_URL = "http://192.168.137.1:5000";


export default function AuthScreen() {
  const navigation = useNavigation<any>();

  const [activeTab, setActiveTab] = useState<"login" | "register">("login");
  const [selectedRole, setSelectedRole] = useState<"Student" | "Teacher">("Student");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [loading, setLoading] = useState(false);

  const handleAuthAction = async () => {
    setLoading(true);

    try {
      if (activeTab === "login") {
        const userCredential = await signInWithEmailAndPassword(
          auth,
          email.trim(),
          password.trim()
        );

        const idToken = await userCredential.user.getIdToken(true);

        const res = await fetch(`${API_URL}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Login failed");
        }

        // 🔥 BLOCK LOGIN IF NOT APPROVED OR ACTIVE
        if (!data.user.is_active) {
          throw new Error("Account disabled");
        }

        await saveUserSession(data.user, idToken);

        const role = data.user.role;
        if (role === "hod" || role === "head_teacher") {
          navigation.replace("HODDashboard");
        } else if (role === "teacher") {
          navigation.replace("TeacherDashboard");
        } else {
          navigation.replace("StudentDashboard");
        }
        return;
      }


      if (!email || !password || !confirmPassword) {
        Alert.alert("Error", "All fields are required");
        return;
      }

      if (password !== confirmPassword) {
        Alert.alert("Error", "Passwords do not match");
        return;
      }

      if (!selectedRole) {
        Alert.alert("Error", "Please select a role");
        return;
      }

      // 🔍 Check if email already exists (ONE query)
      const usersRef = collection(db, "users");
      const q = query(
        usersRef,
        where("email", "==", email.trim()),
        limit(1)
      );

      const snapshot = await getDocs(q);

      if (!snapshot.empty) {
        Alert.alert(
          "Email Already Registered",
          "An account with this email already exists."
        );
        return;
      }
      if (selectedRole === "Teacher") {
        navigation.navigate("TeacherRegistration", {
          email: email.trim(),
          password,
          role: "teacher",
        });
      }

      else {
        navigation.navigate("StudentRegistration", {
          email: email.trim(),
          password,
          role: "student",
        });
      }
    } catch (error: any) {
      Alert.alert(
        "Authentication Error",
        error?.message || "Something went wrong"
      );
    } finally {
      setLoading(false);
    }
  };


  const handleForgotPassword = async () => {
    if (!email) {
      Alert.alert("Error", "Please enter your email first");
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email.trim());
      Alert.alert(
        "Reset Email Sent",
        "Check your email to reset your password"
      );
    } catch (error: any) {
      Alert.alert(
        "Reset Failed",
        error?.message || "Unable to send reset email"
      );
    }
  };

  // --- UI BELOW IS 100% UNCHANGED ---
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        {/* TAB SWITCHER */}
        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[
              styles.tabButton,
              activeTab === "login" && styles.activeTab,
            ]}
            onPress={() => setActiveTab("login")}
          >
            <Text
              style={[
                styles.tabText,
                activeTab === "login" && styles.activeTabText,
              ]}
            >
              Login
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.tabButton,
              activeTab === "register" && styles.activeTab,
            ]}
            onPress={() => setActiveTab("register")}
          >
            <Text
              style={[
                styles.tabText,
                activeTab === "register" && styles.activeTabText,
              ]}
            >
              Register
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          placeholder="Enter registered email id"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          placeholder="Enter your password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        {activeTab === "register" && (
          <>
            <Text style={styles.label}>Confirm Password</Text>
            <TextInput
              style={styles.input}
              placeholder="Re-enter password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
            />

            <Text style={styles.label}>I am a</Text>
            <View style={styles.roleRow}>
              {["Student", "Teacher"].map((role) => (
                <TouchableOpacity
                  key={role}
                  style={[
                    styles.roleButton,
                    selectedRole === role && styles.roleActive,
                  ]}
                  onPress={() => setSelectedRole(role as any)}
                >
                  <Text
                    style={[
                      styles.roleText,
                      selectedRole === role && styles.roleTextActive,
                    ]}
                  >
                    {role}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={handleAuthAction}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>
              {activeTab === "login" ? "Login" : "Continue"}
            </Text>
          )}
        </TouchableOpacity>
        {activeTab === "login" && (
          <TouchableOpacity onPress={handleForgotPassword} style={styles.forgotBtn}>
            <Text style={styles.forgotText}>Forgot Password?</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// --- STYLES (Flutter‑like) ---
const PRIMARY = "#4834D4";

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F3F3F3",
    justifyContent: "center",
    paddingHorizontal: 24,
  },

  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 32,
    paddingVertical: 36,
    paddingHorizontal: 28,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.12,
    shadowRadius: 30,
    elevation: 12,
  },

  /* ---------- Tabs ---------- */
  tabContainer: {
    flexDirection: "row",
    backgroundColor: "#FFFFFF",
    borderRadius: 32,
    borderWidth: 1,
    borderColor: "#E6E6E6",
    marginBottom: 28,
    overflow: "hidden",
  },

  tabButton: {
    flex: 1,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },

  activeTab: {
    backgroundColor: PRIMARY,
  },

  tabText: {
    fontSize: 16,
    color: "#666",
    fontWeight: "500",
  },

  activeTabText: {
    color: "#FFFFFF",
    fontWeight: "700",
  },

  /* ---------- Form ---------- */
  label: {
    fontSize: 15,
    fontWeight: "700",
    color: "#000",
    marginBottom: 8,
    marginTop: 14,
  },

  input: {
    height: 56,
    borderWidth: 1,
    borderColor: "#D0D0D0",
    borderRadius: 30,
    paddingHorizontal: 20,
    fontSize: 15,
    color: "#000",
    backgroundColor: "#FFF",
  },

  /* ---------- Role buttons (register) ---------- */
  roleRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 12,
  },

  roleButton: {
    flex: 1,
    height: 52,
    borderWidth: 1,
    borderColor: "#D0D0D0",
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFF",
  },

  roleActive: {
    backgroundColor: PRIMARY,
    borderColor: PRIMARY,
  },

  roleText: {
    color: "#444",
    fontSize: 15,
    fontWeight: "500",
  },

  roleTextActive: {
    color: "#FFFFFF",
    fontWeight: "700",
  },

  /* ---------- Primary Button ---------- */
  primaryButton: {
    backgroundColor: PRIMARY,
    height: 60,
    borderRadius: 32,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 28,
    shadowColor: PRIMARY,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 10,
  },

  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.4,
  },

  /* ---------- Forgot Password ---------- */
  forgotBtn: {
    marginTop: 22,
    alignItems: "center",
  },

  forgotText: {
    color: PRIMARY,
    fontSize: 16,
    fontWeight: "600",
  },
});