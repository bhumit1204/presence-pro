// src/screens/auth/ForgotPasswordScreen.tsx
// Email -> 6-digit code -> new password. Route: "ForgotPassword"  params { email? }
// The server answers the same whether or not the address has an account.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { OtpError, resetPassword, sendOtp, verifyOtp } from "../../services/otp";
import { isValidEmail, normaliseEmail, passwordChecks, validatePassword } from "../../utils/validation";
import OtpInput from "../../components/OtpInput";
import { Banner, Button, Header, IconBadge, PasswordMeter, ResultView, Screen, SP, Steps, TextField, font } from "../../components/ui";

const STEPS = [
  { label: "Email", icon: "mail" as const },
  { label: "Code", icon: "keypad" as const },
  { label: "Password", icon: "lock-closed" as const },
];

export default function ForgotPasswordScreen({ route }: any) {
  const navigation = useNavigation<any>();

  const [step, setStep] = useState(0);
  const [email, setEmail] = useState(route?.params?.email || "");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ email?: string; pw?: string; pw2?: string }>({});
  const [wait, setWait] = useState(0);
  const [done, setDone] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  const pw2Ref = useRef<any>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const toLogin = () => navigation.reset({ index: 0, routes: [{ name: "Auth" }] });

  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      if (!alive.current) return;
      if (e instanceof OtpError && e.resendIn) setWait(e.resendIn);
      setError(e.message || "Something went wrong");
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const sendCode = () =>
    run(async () => {
      const mail = normaliseEmail(email);
      if (!isValidEmail(mail)) {
        setFieldErr({ email: "Enter a valid email address" });
        return;
      }
      setFieldErr({});
      const secs = await sendOtp(mail, "reset");
      setWait(secs);
      setCode("");
      setStep(1);
    });

  const verify = useCallback(
    (value: string) =>
      run(async () => {
        try {
          setToken(await verifyOtp(normaliseEmail(email), "reset", value));
          setStep(2);
        } catch (e) {
          setCode("");
          throw e;
        }
      }),
    [email]
  );

  const submit = () =>
    run(async () => {
      const next: typeof fieldErr = {};
      const pwErr = validatePassword(pw);
      if (pwErr) next.pw = pwErr;
      if (pw2 !== pw) next.pw2 = "Passwords do not match";
      setFieldErr(next);
      if (Object.keys(next).length) return;
      try {
        await resetPassword(normaliseEmail(email), token, pw);
      } catch (e: any) {
        if (e instanceof OtpError && e.status === 403) {
          // verification window ran out: start over from the code step
          setToken("");
          setStep(0);
        }
        throw e;
      }
      setPw("");
      setPw2("");
      setDone(true);
    });

  if (done) {
    return (
      <Screen>
        <ResultView
          icon="checkmark-circle"
          tone="success"
          title="Password updated"
          message="Your password was changed and other devices were signed out. Log in with your new password."
          actions={<Button label="Back to login" icon="log-in-outline" onPress={toLogin} />}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Forgot password" onBack={() => (step > 0 && step < 2 ? setStep(step - 1) : navigation.goBack())} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled">
          <Steps steps={STEPS} current={step} />

          <View style={{ gap: SP.lg, marginTop: SP.xl }}>
            {!!error && <Banner tone="danger">{error}</Banner>}

            {step === 0 && (
              <>
                <View style={{ alignItems: "center", gap: SP.sm }}>
                  <IconBadge icon="key" tone="primary" size={64} />
                  <Text style={[font.h2, { marginTop: SP.sm }]}>Reset your password</Text>
                  <Text style={[font.body, { textAlign: "center" }]}>Enter your account email and we will send you a 6-digit code.</Text>
                </View>
                <TextField
                  label="Email"
                  icon="mail-outline"
                  value={email}
                  onChangeText={(t) => {
                    setEmail(t);
                    if (fieldErr.email) setFieldErr({});
                  }}
                  placeholder="you@college.edu"
                  keyboardType="email-address"
                  autoComplete="email"
                  textContentType="username"
                  returnKeyType="send"
                  onSubmitEditing={sendCode}
                  error={fieldErr.email}
                  maxLength={254}
                />
                <Button label="Send code" icon="paper-plane-outline" onPress={sendCode} loading={busy} />
              </>
            )}

            {step === 1 && (
              <>
                <View style={{ alignItems: "center", gap: SP.sm }}>
                  <IconBadge icon="mail-open" tone="primary" size={64} />
                  <Text style={[font.h2, { marginTop: SP.sm }]}>Enter the code</Text>
                  <Text style={[font.body, { textAlign: "center" }]}>
                    If an account exists for{"\n"}
                    <Text style={{ fontWeight: "700", color: "#0F172A" }}>{normaliseEmail(email)}</Text>
                    {"\n"}a code is on its way.
                  </Text>
                </View>
                <OtpInput
                  value={code}
                  onChange={(v) => {
                    setCode(v);
                    if (error) setError(null);
                    if (v.length === 6) verify(v);
                  }}
                  error={!!error}
                  editable={!busy}
                />
                <Button label="Verify code" icon="checkmark-circle-outline" onPress={() => verify(code)} loading={busy} disabled={code.length !== 6} />
                <Button
                  label={wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
                  variant="ghost"
                  size="md"
                  disabled={wait > 0 || busy}
                  onPress={sendCode}
                />
              </>
            )}

            {step === 2 && (
              <>
                <View style={{ alignItems: "center", gap: SP.sm }}>
                  <IconBadge icon="lock-closed" tone="success" size={64} />
                  <Text style={[font.h2, { marginTop: SP.sm }]}>Choose a new password</Text>
                </View>
                <View>
                  <TextField
                    label="New password"
                    icon="lock-closed-outline"
                    value={pw}
                    onChangeText={(t) => {
                      setPw(t);
                      if (fieldErr.pw) setFieldErr((f) => ({ ...f, pw: undefined }));
                    }}
                    placeholder="New password"
                    secure
                    autoComplete="new-password"
                    textContentType="newPassword"
                    returnKeyType="next"
                    onSubmitEditing={() => pw2Ref.current?.focus()}
                    error={fieldErr.pw}
                    maxLength={64}
                  />
                  {pw.length > 0 && <PasswordMeter checks={passwordChecks(pw)} />}
                </View>
                <TextField
                  label="Confirm password"
                  icon="shield-checkmark-outline"
                  value={pw2}
                  onChangeText={(t) => {
                    setPw2(t);
                    if (fieldErr.pw2) setFieldErr((f) => ({ ...f, pw2: undefined }));
                  }}
                  placeholder="Re-enter password"
                  secure
                  autoComplete="new-password"
                  textContentType="newPassword"
                  returnKeyType="done"
                  onSubmitEditing={submit}
                  inputRef={pw2Ref}
                  error={fieldErr.pw2}
                  maxLength={64}
                />
                <Button label="Update password" icon="checkmark-circle-outline" onPress={submit} loading={busy} />
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl },
});