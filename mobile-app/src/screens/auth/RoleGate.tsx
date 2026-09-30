// src/screens/auth/RoleGate.tsx
import { useEffect, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { auth, db } from "../../services/firebase";
import { doc, getDoc, collection, query, where, getDocs, limit } from "firebase/firestore";
import { saveUserSession, savePushToken } from "../../services/session";
import { registerForPushNotifications } from "../../services/notifications";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";
const CARD = "#FFFFFF";

export default function RoleGate() {
  const navigation = useNavigation<any>();

  const [loading, setLoading] = useState(true);
  const [inactive, setInactive] = useState(false);

  useEffect(() => {
    const init = async () => {
      try {
        const user = auth.currentUser;

        if (!user) {
          navigation.replace("Auth");
          return;
        }

        const snap = await getDoc(doc(db, "users", user.uid));

        if (!snap.exists()) {
          navigation.replace("Auth");
          return;
        }

        const data = snap.data();

        if (data?.is_active === false) {
          setInactive(true);
          setLoading(false);
          return;
        }

        const baseRole = (data?.role || "student").toLowerCase();

        let finalRole = baseRole;
        let teacher_id: string | null = null;
        let student_id: string | null = null;

        if (baseRole === "teacher") {
          // Primary lookup: by user_id field
          let teacherDoc = null;
          const snap1 = await getDocs(
            query(collection(db, "teachers"), where("user_id", "==", user.uid), limit(1))
          );
          if (!snap1.empty) {
            teacherDoc = snap1.docs[0];
          } else {
            // Fallback: some HOD docs may have been created by admin without user_id set,
            // or with whitespace. Scan all teacher docs and match trimmed uid.
            const allSnap = await getDocs(collection(db, "teachers"));
            const matched = allSnap.docs.find(
              (d) => (d.data().user_id || "").trim() === user.uid.trim()
            );
            if (matched) teacherDoc = matched;
          }

          if (teacherDoc) {
            const teacherData = teacherDoc.data();
            // Use doc.id as the authoritative teacher_id
            teacher_id = teacherDoc.id;

            // Resolve role: explicit field first, then designation fallback for legacy docs
            const resolvedRole: string | null = teacherData.role ||
              (teacherData.designation?.toLowerCase() === "hod" ? "hod" :
               teacherData.designation?.toLowerCase() === "head teacher" ? "head_teacher" : null);

            if (resolvedRole === "hod" || resolvedRole === "head_teacher") {
              finalRole = resolvedRole;
            }
          }
        }

        if (baseRole === "student") {
          student_id = user.uid;
        }

        const idToken = await user.getIdToken();
        await saveUserSession(
          {
            uid: user.uid,
            role: finalRole,
            is_active: data?.is_active ?? true,
            approval_status: data?.approval_status ?? null,
            teacher_id,
            student_id,
          },
          idToken
        );

        // ── Register push token after session is saved ──
        // Best-effort: never block navigation on failure
        registerForPushNotifications()
          .then((token) => {
            if (token) {
              // Use "teacher" for all teacher roles for the backend lookup
              const roleForToken =
                finalRole === "student" ? "student" : "teacher";
              savePushToken(user.uid, roleForToken, token);
            }
          })
          .catch(() => {});

        if (finalRole === "hod" || finalRole === "head_teacher") {
          navigation.replace("HODDashboard");
        } else if (finalRole === "teacher") {
          navigation.replace("TeacherDashboard");
        } else {
          navigation.replace("StudentDashboard");
        }
      } catch (e) {
        console.log("RoleGate error:", e);
        navigation.replace("Auth");
      } finally {
        setLoading(false);
      }
    };

    init();
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={PRIMARY} />
        <Text style={styles.msg}>Loading your workspace...</Text>
      </View>
    );
  }

  if (inactive) {
    return (
      <View style={styles.center}>
        <View style={styles.card}>
          <Text style={styles.title}>Account Disabled</Text>
          <Text style={styles.text}>
            Your account is currently inactive. Please contact your institute
            administrator.
          </Text>
        </View>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: BG,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  card: {
    width: "100%",
    backgroundColor: CARD,
    borderRadius: 24,
    padding: 28,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: PRIMARY,
    marginBottom: 12,
    textAlign: "center",
  },
  text: {
    fontSize: 15,
    color: "#374151",
    textAlign: "center",
    lineHeight: 22,
  },
  msg: {
    marginTop: 12,
    color: "#6B7280",
  },
});