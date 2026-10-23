// Login + first step of registration (the e-mail is then verified by a code, see VerifyEmailScreen).
// Security notes:
//   - no e-mail lookup against Firestore from the app (it leaked which e-mails exist and needed open read rules);
//     the server rejects duplicate e-mails when the registration is submitted
//   - password is never trimmed or logged; weak passwords are stopped here, before the long forms
//   - failed sign-ins lock the form for a growing delay; error text never says whether the e-mail exists
//   - a login that the server refuses (disabled / pending / error) signs the Firebase user back out

import React, { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { useNavigation } from "@react-navigation/native";
import { auth } from "../../services/firebase";
import { API_BASE } from "../../services/api";
import { saveUserSession } from "../../services/session";
import { registerAndSavePushToken } from "../../services/notifications";
import {
  fetchJson,
  friendlyAuthError,
  isValidEmail,
  normaliseEmail,
  passwordChecks,
  validatePassword,
} from "../../utils/validation";
import Logo from "../../components/Logo";
import { Banner, Button, KeyboardView, PasswordMeter, Screen, Segmented, SP, T, TextField, font } from "../../components/ui";

const MAX_FREE_ATTEMPTS = 5;

type Tab = "login" | "register";
type Role = "Student" | "Teacher";

export default function AuthScreen() {
  const navigation = useNavigation<any>();

  const [tab, setTab] = useState<Tab>("login");
  const [role, setRole] = useState<Role>("Student");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);

  // brute-force slow-down (in memory: resets when the app restarts, the server/Firebase still rate-limit)
  const failures = useRef(0);
  const [lockLeft, setLockLeft] = useState(0);

  const passRef = useRef<any>(null);
  const confirmRef = useRef<any>(null);

  useEffect(() => {
    if (lockLeft <= 0) return;
    const t = setInterval(() => setLockLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [lockLeft > 0]);

  const switchTab = (t: Tab) => {
    setTab(t);
    setErrors({});
    setFormError(null);
    setConfirm("");
  };

  /* ───────────── login ───────────── */

  const handleLogin = async () => {
    if (loading || lockLeft > 0) return;
    const mail = normaliseEmail(email);
    const next: typeof errors = {};
    if (!isValidEmail(mail)) next.email = "Enter a valid email address";
    if (!password) next.password = "Enter your password";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;

    setLoading(true);
    let signedIn = false;
    try {
      const cred = await signInWithEmailAndPassword(auth, mail, password); // password is sent exactly as typed
      signedIn = true;
      const idToken = await cred.user.getIdToken(true);

      const res = await fetchJson(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });

      if (!res.ok || !res.data?.user) {
        throw new Error(res.data?.error || "Login failed. Please try again.");
      }
      const user = res.data.user;

      if (user.is_active === false) {
        throw new Error("This account is disabled. Contact your institute administrator.");
      }
      const approval = String(user.approval_status || "").toLowerCase();
      if (approval === "pending") throw new Error("Your account is waiting for admin approval.");
      if (approval === "rejected") throw new Error("Your registration was not approved. Contact your institute.");

      await saveUserSession(user, idToken);
      failures.current = 0;
      setPassword("");

      // Register this device for push right after login (RoleGate is skipped on a fresh login)
      registerAndSavePushToken(user.uid || cred.user.uid, user.role === "student" ? "student" : "teacher");

      // hod / head teacher use exactly the same teacher app (their designation is just a label)
      const r = user.role;
      navigation.replace(r === "teacher" || r === "hod" || r === "head_teacher" ? "TeacherDashboard" : "StudentDashboard");
    } catch (e: any) {
      // never stay half signed-in: Firebase said yes but the app/server said no
      if (signedIn) await signOut(auth).catch(() => {});
      const { message, credential } = friendlyAuthError(e);
      if (credential) {
        failures.current += 1;
        if (failures.current >= MAX_FREE_ATTEMPTS) {
          const wait = Math.min(300, 15 * 2 ** (failures.current - MAX_FREE_ATTEMPTS));
          setLockLeft(wait);
        }
      }
      setFormError(message);
    } finally {
      setLoading(false);
    }
  };

  /* ───────────── forgot password (e-mail OTP flow) ───────────── */

  const handleForgotPassword = () => navigation.navigate("ForgotPassword", { email: normaliseEmail(email) });

  /* ───────────── register (step 1) ───────────── */

  const handleContinue = () => {
    if (loading) return;
    const mail = normaliseEmail(email);
    const next: typeof errors = {};
    if (!isValidEmail(mail)) next.email = "Enter a valid email address";
    const pwErr = validatePassword(password);
    if (pwErr) next.password = pwErr;
    if (confirm !== password) next.confirm = "Passwords do not match";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;

    navigation.navigate("VerifyEmail", {
      email: mail,
      password,
      role: role === "Teacher" ? "teacher" : "student",
    });
  };

  const isLogin = tab === "login";
  const locked = lockLeft > 0;

  return (
    <Screen>
      <KeyboardView>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={st.brand}>
            <Logo width={250} />
            <Text style={[font.body, { textAlign: "center" }]}>Smart, verified attendance for your institute</Text>
          </View>

          <View style={st.card}>
            <Segmented
              options={[
                { value: "login" as Tab, label: "Login" },
                { value: "register" as Tab, label: "Register" },
              ]}
              value={tab}
              onChange={switchTab}
            />

            <View style={{ gap: SP.lg, marginTop: SP.xl }}>
              {!!formError && <Banner tone="danger">{formError}</Banner>}
              {locked && (
                <Banner tone="warning" icon="time" title="Too many failed attempts">
                  Try again in {lockLeft}s, or reset your password.
                </Banner>
              )}

              <TextField
                label="Email"
                icon="mail-outline"
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  if (errors.email) setErrors((e) => ({ ...e, email: undefined }));
                }}
                placeholder="you@college.edu"
                keyboardType="email-address"
                autoComplete="email"
                textContentType="username"
                returnKeyType="next"
                onSubmitEditing={() => passRef.current?.focus()}
                error={errors.email}
                maxLength={254}
              />

              <View>
                <TextField
                  label="Password"
                  icon="lock-closed-outline"
                  value={password}
                  onChangeText={(t) => {
                    setPassword(t);
                    if (errors.password) setErrors((e) => ({ ...e, password: undefined }));
                  }}
                  placeholder={isLogin ? "Your password" : "Create a strong password"}
                  secure
                  autoComplete={isLogin ? "current-password" : "new-password"}
                  textContentType={isLogin ? "password" : "newPassword"}
                  returnKeyType={isLogin ? "done" : "next"}
                  onSubmitEditing={() => (isLogin ? handleLogin() : confirmRef.current?.focus())}
                  inputRef={passRef}
                  error={errors.password}
                  maxLength={64}
                />
                {!isLogin && password.length > 0 && <PasswordMeter checks={passwordChecks(password)} />}
              </View>

              {!isLogin && (
                <>
                  <TextField
                    label="Confirm password"
                    icon="shield-checkmark-outline"
                    value={confirm}
                    onChangeText={(t) => {
                      setConfirm(t);
                      if (errors.confirm) setErrors((e) => ({ ...e, confirm: undefined }));
                    }}
                    placeholder="Re-enter password"
                    secure
                    autoComplete="new-password"
                    textContentType="newPassword"
                    returnKeyType="done"
                    onSubmitEditing={handleContinue}
                    inputRef={confirmRef}
                    error={errors.confirm}
                    maxLength={64}
                  />

                  <View>
                    <Text style={st.fieldLabel}>I am a</Text>
                    <Segmented
                      options={[
                        { value: "Student" as Role, label: "Student", icon: "school-outline" },
                        { value: "Teacher" as Role, label: "Teacher", icon: "person-outline" },
                      ]}
                      value={role}
                      onChange={setRole}
                    />
                  </View>
                </>
              )}

              <Button
                label={isLogin ? "Log in" : "Verify email"}
                icon={isLogin ? "log-in-outline" : "arrow-forward"}
                onPress={isLogin ? handleLogin : handleContinue}
                loading={loading}
                disabled={isLogin && locked}
              />

              {isLogin && (
                <Button
                  label="Forgot password?"
                  variant="ghost"
                  size="md"
                  onPress={handleForgotPassword}
                />
              )}
            </View>
          </View>

          <View style={st.trust}>
            <Ionicons name="shield-checkmark" size={15} color={T.success} />
            <Text style={font.small}>Your password is never stored on this device.</Text>
          </View>
        </ScrollView>
      </KeyboardView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: "center", padding: SP.xl, paddingVertical: SP.xxl },
  brand: { alignItems: "center", gap: SP.sm, marginBottom: SP.xxl },
  card: {
    backgroundColor: T.surface,
    borderRadius: 28,
    padding: SP.xl,
    borderWidth: 1,
    borderColor: T.line,
    ...Platform.select<any>({
      ios: { shadowColor: "#1E1B4B", shadowOpacity: 0.08, shadowRadius: 24, shadowOffset: { width: 0, height: 10 } },
      android: { elevation: 4 },
      default: {},
    }),
  },
  fieldLabel: { fontSize: 12.5, fontWeight: "700", color: T.sub, marginBottom: 7, letterSpacing: 0.2 },
  trust: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: SP.xl },
});