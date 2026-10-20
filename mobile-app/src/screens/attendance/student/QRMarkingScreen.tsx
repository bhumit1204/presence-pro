// Student side of QR attendance: scan the rotating QR shown by the teacher.

import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Linking, StyleSheet, Text, Vibration, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE } from "../../../services/api";
import { getUserSession } from "../../../services/session";
import { Button, Chip, Header, ResultView, Screen, SP, T, font } from "../../../components/ui";

const API_URL = API_BASE;

// QR value format: "PRESENCEPRO:{attendance_session_id}:{otp}"
const parseQRValue = (raw: string): { attendance_session_id: string; otp: string } | null => {
  const parts = raw?.split(":");
  if (parts?.length === 3 && parts[0] === "PRESENCEPRO") {
    return { attendance_session_id: parts[1], otp: parts[2] };
  }
  return null;
};

type Phase = "request_perm" | "scanning" | "loading" | "success" | "already_marked" | "error";

const FRAME = 250;
const CORNER = 28;
const CORNER_W = 4;

export default function QRMarkingScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  // kept for callers that pass it; the QR itself carries the attendance session id
  const { lectureSessionId } = (route.params || {}) as { lectureSessionId?: string };
  void lectureSessionId;

  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>("request_perm");
  const [errorMessage, setErrorMessage] = useState("");
  const [scanned, setScanned] = useState(false);

  const lock = useRef(false); // camera can fire several times before state updates: block double submits
  const alive = useRef(true);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scanLineY = useRef(new Animated.Value(0)).current;
  const cornerAnim = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    };
  }, []);

  // Scan line + corner pulse (stopped when the scanner is not shown)
  useEffect(() => {
    if (phase !== "scanning") return;
    const line = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLineY, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(scanLineY, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    const corners = Animated.loop(
      Animated.sequence([
        Animated.timing(cornerAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(cornerAnim, { toValue: 0.6, duration: 900, useNativeDriver: true }),
      ])
    );
    line.start();
    corners.start();
    return () => {
      line.stop();
      corners.stop();
    };
  }, [phase]);

  // Open the scanner as soon as camera permission is granted
  useEffect(() => {
    if (permission?.granted && phase === "request_perm") setPhase("scanning");
  }, [permission, phase]);

  const handleRequestPermission = async () => {
    const result = await requestPermission();
    if (result.granted) setPhase("scanning");
  };

  const leaveSoon = () => {
    leaveTimer.current = setTimeout(() => alive.current && navigation.goBack(), 2200);
  };

  // ── QR scanned ───────────────────────────────────────────────────────────
  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    if (lock.current) return;
    lock.current = true;
    setScanned(true);
    Vibration.vibrate(40); // short buzz on scan (not success yet)

    const fail = (msg: string) => {
      setErrorMessage(msg);
      setPhase("error");
    };

    const parsed = parseQRValue(data);
    if (!parsed) return fail("That is not an attendance QR code. Scan the one shown by your teacher.");

    setPhase("loading");

    try {
      const session = await getUserSession();
      const uid = session?.uid;
      if (!uid) return fail("Your session expired. Please log in again.");

      const res = await apiFetch(`${API_URL}/api/lectures/attendance/mark-qr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attendance_session_id: parsed.attendance_session_id, otp: parsed.otp, uid }),
      });
      const json = await res.json();
      if (!alive.current) return;

      if (json.success) {
        if (json.already_marked) {
          Vibration.vibrate(60);
          setPhase("already_marked");
        } else {
          Vibration.vibrate([0, 100, 60, 100]); // fresh success: strong double buzz
          setPhase("success");
        }
        leaveSoon();
      } else if (res.status === 400 && json.error?.includes("closed")) {
        fail("The attendance session has been closed by the teacher.");
      } else {
        fail(json.error || "The QR code has expired. The teacher's screen changes every 5 seconds, so scan the latest code.");
      }
    } catch (e) {
      console.log("QR MARK ERROR:", e);
      if (alive.current) fail("Could not reach the server. Check your connection and try again.");
    }
  };

  const handleRetry = () => {
    lock.current = false;
    setScanned(false);
    setErrorMessage("");
    setPhase("scanning");
  };

  const back = () => navigation.goBack();

  /* ───────── states ───────── */

  if (!permission) {
    return (
      <Screen>
        <View style={st.center}>
          <ActivityIndicator size="large" color={T.primary} />
        </View>
      </Screen>
    );
  }

  if (!permission.granted && phase === "request_perm") {
    const blocked = permission.canAskAgain === false;
    return (
      <Screen>
        <Header title="Scan QR code" onBack={back} />
        <ResultView
          icon="camera"
          tone="primary"
          title="Camera access needed"
          message="To scan the attendance QR code shown by your teacher, please allow camera access."
          actions={
            <>
              {blocked ? (
                <Button label="Open settings" icon="settings" onPress={() => Linking.openSettings()} />
              ) : (
                <Button label="Allow camera" icon="camera" onPress={handleRequestPermission} />
              )}
              <Button label="Go back" variant="secondary" onPress={back} />
            </>
          }
        />
      </Screen>
    );
  }

  if (phase === "loading") {
    return (
      <Screen>
        <ResultView icon="qr-code" tone="primary" loading title="Marking attendance" message="Please wait while we record your attendance." />
      </Screen>
    );
  }

  if (phase === "success") {
    return (
      <Screen>
        <ResultView icon="checkmark-circle" tone="success" title="Attendance marked" message="Your attendance has been recorded successfully.">
          <Chip label="Verified via QR" tone="success" icon="shield-checkmark" style={{ alignSelf: "center", marginTop: SP.lg }} />
        </ResultView>
      </Screen>
    );
  }

  if (phase === "already_marked") {
    return (
      <Screen>
        <ResultView
          icon="checkmark-done-circle"
          tone="info"
          title="Already recorded"
          message="Your attendance is already marked for this session. No action needed."
        >
          <Chip label="Previously marked" tone="info" icon="information-circle" style={{ alignSelf: "center", marginTop: SP.lg }} />
        </ResultView>
      </Screen>
    );
  }

  if (phase === "error") {
    return (
      <Screen>
        <ResultView
          icon="close-circle"
          tone="danger"
          title="Scan failed"
          message={errorMessage}
          actions={
            <>
              <Button label="Scan again" icon="refresh" onPress={handleRetry} />
              <Button label="Go back" variant="secondary" onPress={back} />
            </>
          }
        />
      </Screen>
    );
  }

  /* ───────── scanner ───────── */

  const lineTravel = scanLineY.interpolate({ inputRange: [0, 1], outputRange: [8, FRAME - 10] });

  return (
    <Screen dark edges={["top"]}>
      <Header title="Scan QR code" subtitle="Point the camera at your teacher's screen" onBack={back} dark />

      <View style={st.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
        />

        {/* dim everything except the frame */}
        <View style={st.dim} />
        <View style={{ flexDirection: "row", height: FRAME }}>
          <View style={st.dim} />
          <View style={{ width: FRAME, height: FRAME }}>
            <Animated.View style={[st.corner, st.tl, { opacity: cornerAnim }]} />
            <Animated.View style={[st.corner, st.tr, { opacity: cornerAnim }]} />
            <Animated.View style={[st.corner, st.bl, { opacity: cornerAnim }]} />
            <Animated.View style={[st.corner, st.br, { opacity: cornerAnim }]} />
            <Animated.View style={[st.scanLine, { transform: [{ translateY: lineTravel }] }]} />
          </View>
          <View style={st.dim} />
        </View>
        <View style={st.dim} />
      </View>

      <View style={st.sheet}>
        <View style={st.live}>
          <View style={st.liveDot} />
          <Text style={st.liveText}>SCANNER ACTIVE</Text>
        </View>
        <Text style={font.h2}>Hold your phone steady</Text>
        <Text style={[font.body, { textAlign: "center" }]}>Fit the QR code inside the frame. It changes every 5 seconds.</Text>
        <View style={st.tips}>
          {[
            { icon: "sunny-outline" as const, label: "Good light" },
            { icon: "resize-outline" as const, label: "Fill the frame" },
            { icon: "hand-left-outline" as const, label: "Stay still" },
          ].map((tip, i) => (
            <View key={tip.label} style={[st.tip, i > 0 && st.tipBorder]}>
              <Ionicons name={tip.icon} size={16} color={T.primary} />
              <Text style={st.tipText}>{tip.label}</Text>
            </View>
          ))}
        </View>
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  cameraWrap: { flex: 1 },
  dim: { flex: 1, backgroundColor: "rgba(0,0,0,0.62)" },
  corner: { position: "absolute", width: CORNER, height: CORNER, borderColor: "#fff" },
  tl: { top: 0, left: 0, borderTopWidth: CORNER_W, borderLeftWidth: CORNER_W, borderTopLeftRadius: 8 },
  tr: { top: 0, right: 0, borderTopWidth: CORNER_W, borderRightWidth: CORNER_W, borderTopRightRadius: 8 },
  bl: { bottom: 0, left: 0, borderBottomWidth: CORNER_W, borderLeftWidth: CORNER_W, borderBottomLeftRadius: 8 },
  br: { bottom: 0, right: 0, borderBottomWidth: CORNER_W, borderRightWidth: CORNER_W, borderBottomRightRadius: 8 },
  scanLine: {
    position: "absolute",
    left: 12,
    right: 12,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: T.primary,
    shadowColor: T.primary,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  sheet: {
    backgroundColor: T.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: SP.xl,
    paddingTop: SP.xl,
    paddingBottom: SP.xxl,
    alignItems: "center",
    gap: SP.sm + 2,
  },
  live: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: T.successSoft, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.success },
  liveText: { color: T.success, fontWeight: "800", fontSize: 11, letterSpacing: 1 },
  tips: { flexDirection: "row", backgroundColor: T.primarySoft, borderRadius: 14, paddingVertical: SP.md, alignSelf: "stretch", marginTop: SP.sm },
  tip: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  tipBorder: { borderLeftWidth: 1, borderLeftColor: "rgba(72,52,212,0.18)" },
  tipText: { fontSize: 12, color: T.primary, fontWeight: "700" },
});