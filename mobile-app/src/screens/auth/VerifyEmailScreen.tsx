// src/screens/auth/VerifyEmailScreen.tsx
// Registration step 1.5: prove the e-mail address belongs to the user, then continue to the profile form.
// Route: "VerifyEmail"  params { email, password, role: "student" | "teacher" }

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { OtpError, sendOtp, verifyOtp } from "../../services/otp";
import OtpInput from "../../components/OtpInput";
import { Banner, Button, Header, IconBadge, ResultView, Screen, SP, font } from "../../components/ui";

export default function VerifyEmailScreen({ route }: any) {
  const navigation = useNavigation<any>();
  const { email, password, role } = route?.params || {};

  const [code, setCode] = useState("");
  const [sending, setSending] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const started = useRef(false);
  const busy = useRef(false);
  const alive = useRef(true);

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

  const send = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const secs = await sendOtp(email, "register");
      if (alive.current) setWait(secs);
    } catch (e: any) {
      if (!alive.current) return;
      if (e instanceof OtpError && e.status === 409) {
        Alert.alert("Already registered", e.message, [{ text: "Go to login", onPress: toLogin }]);
      } else {
        if (e instanceof OtpError && e.resendIn) setWait(e.resendIn);
        setError(e.message);
      }
    } finally {
      if (alive.current) setSending(false);
    }
  }, [email]);

  useEffect(() => {
    if (!email || started.current) return;
    started.current = true;
    send();
  }, [email, send]);

  const verify = useCallback(
    async (value: string) => {
      if (busy.current || value.length !== 6) return;
      busy.current = true;
      setVerifying(true);
      setError(null);
      try {
        const token = await verifyOtp(email, "register", value);
        navigation.replace(role === "teacher" ? "TeacherRegistration" : "StudentRegistration", {
          email,
          password,
          role,
          otp_token: token,
        });
      } catch (e: any) {
        if (!alive.current) return;
        setError(e.message || "Verification failed");
        setCode("");
      } finally {
        busy.current = false;
        if (alive.current) setVerifying(false);
      }
    },
    [email, password, role, navigation]
  );

  if (!email || !password || !role) {
    return (
      <Screen>
        <ResultView
          icon="alert-circle"
          tone="warning"
          title="Start again"
          message="Your registration session expired. Please begin from the sign-up screen."
          actions={<Button label="Back to login" onPress={toLogin} />}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Verify your email" onBack={() => navigation.goBack()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: "center", gap: SP.sm }}>
            <IconBadge icon="mail" tone="primary" size={72} />
            <Text style={[font.h1, { marginTop: SP.md }]}>Check your inbox</Text>
            <Text style={[font.body, { textAlign: "center" }]}>
              We sent a 6-digit code to{"\n"}
              <Text style={{ fontWeight: "700", color: "#0F172A" }}>{email}</Text>
            </Text>
          </View>

          <View style={{ gap: SP.lg, marginTop: SP.xxl }}>
            {!!error && <Banner tone="danger">{error}</Banner>}
            <OtpInput
              value={code}
              onChange={(v) => {
                setCode(v);
                if (error) setError(null);
                if (v.length === 6) verify(v);
              }}
              error={!!error}
              editable={!verifying}
            />
            <Button label="Verify and continue" icon="checkmark-circle-outline" onPress={() => verify(code)} loading={verifying} disabled={code.length !== 6} />
            <Button
              label={sending ? "Sending..." : wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
              variant="ghost"
              size="md"
              onPress={send}
              disabled={sending || wait > 0 || verifying}
            />
            <Text style={[font.small, { textAlign: "center" }]}>
              Can't find it? Check your spam folder. The code expires in 10 minutes.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.xl, paddingTop: SP.xxl },
});