// Teacher side of QR attendance: shows the session code / link and (optionally) the rotating QR itself.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Animated, Easing, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import QRCode from "react-native-qrcode-svg";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE } from "../../../services/api";
import { useLiveLock } from "../../../hooks/useLiveLock";
import {
  Banner,
  Button,
  Card,
  Header,
  IconBadge,
  LiveBadge,
  ProgressBar,
  R,
  ResultView,
  Screen,
  SectionLabel,
  SP,
  T,
  copyText,
  font,
} from "../../../components/ui";

const API_URL = API_BASE;
const POLL_MS = 5000; // poll every 5 seconds for QR refresh

type Status = "loading" | "open" | "closed" | "error";

export default function QRAttendanceScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();

  // These params come from TeacherHome after calling /attendance/start-qr
  const { lecture_session_id, attendance_session_id, qr_token, qr_link, display_code } = route.params as {
    lecture_session_id: string;
    attendance_session_id: string;
    qr_token: string;
    qr_link: string;
    display_code: string; // 8-digit code
  };

  const [qrValue, setQrValue] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState(5);
  const [countdown, setCountdown] = useState(5);
  const [status, setStatus] = useState<Status>("loading");
  const [offline, setOffline] = useState(false); // a poll failed after the first success
  const [showQR, setShowQR] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [closing, setClosing] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasLoaded = useRef(false);
  const leaving = useRef(false);
  const alive = useRef(true);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const prevQrRef = useRef<string | null>(null);

  const triggerPulse = () => {
    Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 0.95, duration: 100, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
      Animated.timing(pulseAnim, { toValue: 1, duration: 200, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
    ]).start();
  };

  const stopTimers = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  };

  // ── Fetch live QR from backend ────────────────────────────────────────────
  const fetchQR = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/lectures/attendance/qr-live?token=${qr_token}`);
      const data = await res.json();
      if (!alive.current) return;

      if (!data.success) throw new Error("not ok");

      if (data.status === "closed") {
        stopTimers();
        setStatus("closed");
        return;
      }

      // Pulse only when the QR value actually changes
      if (prevQrRef.current && data.qr_value !== prevQrRef.current) triggerPulse();
      prevQrRef.current = data.qr_value;

      hasLoaded.current = true;
      setOffline(false);
      setQrValue(data.qr_value);
      setExpiresIn(data.expires_in);
      setCountdown(data.expires_in);
      setStatus("open");

      // Reset countdown timer
      if (countdownRef.current) clearInterval(countdownRef.current);
      let c = data.expires_in;
      countdownRef.current = setInterval(() => {
        c -= 1;
        setCountdown(c > 0 ? c : 0);
        if (c <= 0 && countdownRef.current) clearInterval(countdownRef.current);
      }, 1000);
    } catch (err) {
      console.log("QR POLL ERROR:", err);
      if (!alive.current) return;
      // Before the first success show the full error screen; afterwards just a banner (a blip must not hide the code).
      if (hasLoaded.current) setOffline(true);
      else setStatus("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr_token]);

  useEffect(() => {
    alive.current = true;
    fetchQR();
    pollRef.current = setInterval(fetchQR, POLL_MS);
    return () => {
      alive.current = false;
      stopTimers();
    };
  }, [fetchQR]);

  // ── Copy helpers ─────────────────────────────────────────────────────────
  const copyCode = async () => {
    if (await copyText(display_code)) {
      setCodeCopied(true);
      setTimeout(() => alive.current && setCodeCopied(false), 2000);
    }
  };
  const copyLink = async () => {
    if (await copyText(qr_link)) {
      setLinkCopied(true);
      setTimeout(() => alive.current && setLinkCopied(false), 2000);
    }
  };

  // ── Close session → review ────────────────────────────────────────────────
  const goReview = () => {
    leaving.current = true;
    navigation.replace("ManualMarkingScreen", { attendance_session_id, lecture_session_id });
  };

  const closeSession = async () => {
    setClosing(true);
    try {
      const res = await apiFetch(`${API_URL}/api/lectures/attendance/close-qr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attendance_session_id, lecture_session_id }),
      });
      const data = await res.json();
      if (!data.success && !data.already_closed) {
        Alert.alert("Could not stop", data.error || "Failed to close the session.");
        return;
      }
      stopTimers();
      goReview();
    } catch {
      Alert.alert("Could not stop", "Could not close the session. Check your connection and try again.");
    } finally {
      if (alive.current) setClosing(false);
    }
  };

  const handleClose = () => {
    Alert.alert("Stop QR marking?", "This closes the QR session and takes you to the review screen.", [
      { text: "Cancel", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: closeSession },
    ]);
  };

  // While the session is live, back (button, gesture, header) is blocked. It unlocks once closed.
  const live = status === "loading" || status === "open";
  useLiveLock(live, leaving, "QR marking is running. Tap Stop marking first.", fetchQR);

  const back = () => navigation.goBack();

  /* ───────── states ───────── */

  if (status === "loading") {
    return (
      <Screen>
        <Header title="QR attendance" />
        <ResultView icon="qr-code" tone="primary" loading title="Connecting" message="Opening the QR session..." />
      </Screen>
    );
  }

  if (status === "error") {
    return (
      <Screen>
        <Header title="QR attendance" onBack={back} />
        <ResultView
          icon="cloud-offline"
          tone="danger"
          title="Connection error"
          message="Could not load the QR session. Check your network."
          actions={
            <Button
              label="Retry"
              icon="refresh"
              onPress={() => {
                setStatus("loading");
                fetchQR();
              }}
            />
          }
        />
      </Screen>
    );
  }

  if (status === "closed") {
    return (
      <Screen>
        <ResultView
          icon="lock-closed"
          tone="neutral"
          title="Session closed"
          message="QR marking has ended."
          actions={<Button label="Review attendance" icon="checkmark-done" onPress={goReview} />}
        />
      </Screen>
    );
  }

  const progress = expiresIn > 0 ? countdown / expiresIn : 0;
  const urgent = countdown <= 2;
  const spaced = display_code.length === 8 ? `${display_code.slice(0, 4)} ${display_code.slice(4)}` : display_code;

  return (
    <Screen>
      <Header title="QR attendance" subtitle="Share the code or link below" right={<LiveBadge />} />

      <ScrollView contentContainerStyle={st.scroll} showsVerticalScrollIndicator={false}>
        {offline && <Banner tone="warning">Connection lost. Retrying automatically. The code below is still valid.</Banner>}

        <Card style={st.codeCard}>
          <Text style={font.label}>Session code</Text>
          <Text style={st.code} accessibilityLabel={`Session code ${display_code}`}>
            {spaced}
          </Text>
          <Text style={[font.small, { textAlign: "center" }]}>Students enter this on the web app to open the QR screen</Text>
          <Button
            label={codeCopied ? "Copied" : "Copy code"}
            icon={codeCopied ? "checkmark" : "copy-outline"}
            variant="secondary"
            size="md"
            onPress={copyCode}
            style={{ marginTop: SP.md, alignSelf: "center" }}
          />
        </Card>

        <View>
          <SectionLabel>How students join</SectionLabel>
          <Card padded={false}>
            {[
              <>
                Open the web app at <Text style={st.strong}>{qr_link.split("/?")[0]}</Text>
              </>,
              <>
                Enter the 8-digit code <Text style={st.strong}>{display_code}</Text> to start the QR display
              </>,
              <>Or copy the direct link below and paste it in any browser</>,
            ].map((node, i) => (
              <View key={i} style={[st.stepRow, i > 0 && st.rowBorder]}>
                <View style={st.stepNum}>
                  <Text style={st.stepNumText}>{i + 1}</Text>
                </View>
                <Text style={[font.body, { flex: 1 }]}>{node}</Text>
              </View>
            ))}
          </Card>
        </View>

        <View>
          <SectionLabel>Direct link</SectionLabel>
          <Card style={st.linkRow}>
            <Ionicons name="link" size={18} color={T.primary} />
            <Text style={st.linkText} numberOfLines={1} ellipsizeMode="middle">
              {qr_link}
            </Text>
            <Button
              label={linkCopied ? "Copied" : "Copy"}
              size="md"
              variant={linkCopied ? "success" : "primary"}
              onPress={copyLink}
              style={{ minHeight: 40, height: 40, paddingHorizontal: SP.lg }}
            />
          </Card>
        </View>

        <Button
          label={showQR ? "Hide QR on this phone" : "Show QR on this phone"}
          icon={showQR ? "eye-off-outline" : "qr-code-outline"}
          variant="secondary"
          onPress={() => setShowQR((v) => !v)}
        />

        {showQR && (
          <Card style={{ alignItems: "center", gap: SP.lg }}>
            <Animated.View style={[st.qrBox, { transform: [{ scale: pulseAnim }] }]}>
              {qrValue ? (
                <QRCode value={qrValue} size={220} color="#0F172A" backgroundColor="#ffffff" quietZone={12} />
              ) : (
                <View style={st.qrPlaceholder} />
              )}
            </Animated.View>
            <View style={{ width: "100%", gap: 6 }}>
              <View style={st.countRow}>
                <Text style={font.small}>Next code in</Text>
                <Text style={[font.h3, { color: urgent ? T.danger : T.primary }]}>{countdown}s</Text>
              </View>
              <ProgressBar value={progress} tone={urgent ? "danger" : "primary"} />
            </View>
            <Text style={font.small}>The QR rotates every 5 seconds</Text>
          </Card>
        )}

        <Button label="Stop marking" icon="stop-circle" variant="dangerSoft" onPress={handleClose} loading={closing} />
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.lg, gap: SP.lg, paddingBottom: SP.xxl * 1.5 },
  codeCard: { alignItems: "center", gap: 8, paddingVertical: SP.xl },
  code: { fontSize: 44, fontWeight: "900", color: T.ink, letterSpacing: 4, marginVertical: 4, fontVariant: ["tabular-nums"] },
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: SP.md, padding: SP.lg },
  rowBorder: { borderTopWidth: 1, borderTopColor: T.lineSoft },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: T.primarySoft, alignItems: "center", justifyContent: "center", marginTop: 1 },
  stepNumText: { fontSize: 12, fontWeight: "800", color: T.primary },
  strong: { color: T.ink, fontWeight: "800" },
  linkRow: { flexDirection: "row", alignItems: "center", gap: SP.sm + 2, paddingVertical: SP.md },
  linkText: { flex: 1, fontSize: 12.5, color: T.sub },
  qrBox: { backgroundColor: "#fff", borderRadius: R.lg, padding: SP.md, borderWidth: 1, borderColor: T.line },
  qrPlaceholder: { width: 220, height: 220, borderRadius: R.sm, backgroundColor: T.bg },
  countRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
});