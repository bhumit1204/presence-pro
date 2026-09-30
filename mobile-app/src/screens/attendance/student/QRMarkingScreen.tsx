import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Vibration,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRoute, useNavigation } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";
import { Ionicons } from "@expo/vector-icons";

// ─── Theme ───────────────────────────────────────────────────────────────────
const PRIMARY    = "#4834D4";
const PRIMARY_LT = "#EEF0FF";
const SUCCESS    = "#2ECC71";
const SUCCESS_LT = "#E9FBF0";
const DANGER     = "#FF4757";
const DANGER_LT  = "#FFF0F0";
const BG         = "#F3F4F6";
const CARD       = "#FFFFFF";
const INK        = "#111827";
const MUTED      = "#6B7280";
const BORDER     = "#E5E7EB";

// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

// QR value format: "PRESENCEPRO:{attendance_session_id}:{otp}"
const parseQRValue = (raw: string): { attendance_session_id: string; otp: string } | null => {
  const parts = raw?.split(":");
  if (parts?.length === 3 && parts[0] === "PRESENCEPRO") {
    return { attendance_session_id: parts[1], otp: parts[2] };
  }
  return null;
};

export default function QRMarkingScreen() {
  const route      = useRoute<any>();
  const navigation = useNavigation<any>();

  const { lectureSessionId } = route.params as { lectureSessionId: string };

  const [permission, requestPermission] = useCameraPermissions();

  type Phase = "request_perm" | "scanning" | "loading" | "success" | "already_marked" | "error";
  const [phase,        setPhase]        = useState<Phase>("request_perm");
  const [errorMessage, setErrorMessage] = useState("");
  const [scanned,      setScanned]      = useState(false);

  // ── Animations ───────────────────────────────────────────────────────────
  const scanLineY      = useRef(new Animated.Value(0)).current;
  const cornerAnim     = useRef(new Animated.Value(0)).current;
  const fadeAnim       = useRef(new Animated.Value(0)).current;
  const successScale   = useRef(new Animated.Value(0.6)).current;
  const successOpacity = useRef(new Animated.Value(0)).current;

  // Scan line loop
  useEffect(() => {
    if (phase !== "scanning") return;
    Animated.loop(
      Animated.sequence([
        Animated.timing(scanLineY, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(scanLineY, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(cornerAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(cornerAnim, { toValue: 0.5, duration: 900, useNativeDriver: true }),
      ])
    ).start();
  }, [phase]);

  // Fade in on phase change
  useEffect(() => {
    fadeAnim.setValue(0);
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }).start();
  }, [phase]);

  // Success bounce
  const playSuccessAnimation = () => {
    Animated.parallel([
      Animated.spring(successScale, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }),
      Animated.timing(successOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start();
  };

  // Auto-open scanner if permission already granted
  useEffect(() => {
    if (permission?.granted) setPhase("scanning");
  }, [permission]);

  const handleRequestPermission = async () => {
    const result = await requestPermission();
    if (result.granted) setPhase("scanning");
  };

  // ── QR scanned ───────────────────────────────────────────────────────────
  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);

    // Short buzz on scan (not success yet)
    Vibration.vibrate(40);

    const parsed = parseQRValue(data);
    if (!parsed) {
      setErrorMessage("Invalid QR code. Please scan the one shown by your teacher.");
      setPhase("error");
      return;
    }

    setPhase("loading");

    try {
      const session = await getUserSession();
      const uid = session?.uid;

      if (!uid) {
        setErrorMessage("Session expired. Please log in again.");
        setPhase("error");
        return;
      }

      const res = await fetch(`${API_URL}/api/lectures/attendance/mark-qr`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendance_session_id: parsed.attendance_session_id,
          otp: parsed.otp,
          uid,
        }),
      });

      const json = await res.json();

      if (json.success) {
        if (json.already_marked) {
          // Already marked — show the "already marked" phase (not an error)
          Vibration.vibrate(60);
          setPhase("already_marked");
          setTimeout(() => navigation.goBack(), 2200);
        } else {
          // Fresh success — strong double buzz
          Vibration.vibrate([0, 100, 60, 100]);
          setPhase("success");
          playSuccessAnimation();
          setTimeout(() => navigation.goBack(), 2200);
        }
      } else {
        if (res.status === 400 && json.error?.includes("closed")) {
          setErrorMessage("The attendance session has been closed by the teacher.");
        } else {
          setErrorMessage(
            json.error || "QR code has expired. The teacher's screen rotates every 5 seconds — try scanning the latest code."
          );
        }
        setPhase("error");
      }

    } catch (e) {
      console.log("QR MARK ERROR:", e);
      setErrorMessage("Could not reach the server. Check your connection and try again.");
      setPhase("error");
    }
  };

  const handleRetry = () => {
    setScanned(false);
    setErrorMessage("");
    setPhase("scanning");
  };

  const scanLineTranslate = scanLineY.interpolate({ inputRange: [0, 1], outputRange: [-100, 100] });
  const cornerOpacity     = cornerAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });

  // ── Permission loading ────────────────────────────────────────────────────
  if (!permission) {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}><ActivityIndicator size="large" color={PRIMARY} /></View>
      </SafeAreaView>
    );
  }

  // ── Permission request ────────────────────────────────────────────────────
  if (!permission.granted && phase === "request_perm") {
    return (
      <SafeAreaView style={S.safe}>
        <Animated.View style={[S.stateCard, { opacity: fadeAnim }]}>
          <View style={[S.iconCircle, { backgroundColor: PRIMARY_LT }]}>
            <Ionicons name="camera-outline" size={32} color={PRIMARY} />
          </View>
          <Text style={S.stateTitle}>Camera Access Needed</Text>
          <Text style={S.stateSub}>
            To scan the attendance QR code shown by your teacher, please allow camera access.
          </Text>
          <TouchableOpacity style={S.primaryBtn} onPress={handleRequestPermission}>
            <Text style={S.primaryBtnText}>Allow Camera</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.ghostBtn} onPress={() => navigation.goBack()}>
            <Text style={S.ghostBtnText}>Go Back</Text>
          </TouchableOpacity>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (phase === "loading") {
    return (
      <SafeAreaView style={S.safe}>
        <Animated.View style={[S.stateCard, { opacity: fadeAnim }]}>
          <View style={[S.iconCircle, { backgroundColor: PRIMARY_LT }]}>
            <ActivityIndicator size="large" color={PRIMARY} />
          </View>
          <Text style={S.stateTitle}>Marking Attendance…</Text>
          <Text style={S.stateSub}>Please wait while we record your attendance.</Text>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ── Success ───────────────────────────────────────────────────────────────
  if (phase === "success") {
    return (
      <SafeAreaView style={S.safe}>
        <Animated.View style={[S.stateCard, { opacity: fadeAnim }]}>
          <Animated.View
            style={[S.iconCircle, { backgroundColor: SUCCESS_LT, transform: [{ scale: successScale }], opacity: successOpacity }]}
          >
            <Ionicons name="checkmark-circle" size={36} color={SUCCESS} />
          </Animated.View>
          <Animated.Text style={[S.stateTitle, { color: SUCCESS, opacity: successOpacity }]}>
            Attendance Marked!
          </Animated.Text>
          <Animated.Text style={[S.stateSub, { opacity: successOpacity }]}>
            Your attendance has been recorded successfully.
          </Animated.Text>
          <Animated.View style={{ opacity: successOpacity, width: "100%" }}>
            <View style={S.successPill}>
              <Ionicons name="shield-checkmark-outline" size={14} color={SUCCESS} />
              <Text style={S.successPillText}>Verified via QR</Text>
            </View>
          </Animated.View>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ── Already Marked ────────────────────────────────────────────────────────
  if (phase === "already_marked") {
    return (
      <SafeAreaView style={S.safe}>
        <Animated.View style={[S.stateCard, { opacity: fadeAnim }]}>
          <View style={[S.iconCircle, { backgroundColor: PRIMARY_LT }]}>
            <Ionicons name="checkmark-done-circle-outline" size={36} color={PRIMARY} />
          </View>
          <Text style={[S.stateTitle, { color: PRIMARY }]}>Already Recorded</Text>
          <Text style={S.stateSub}>
            Your attendance is already marked for this session. No action needed.
          </Text>
          <View style={[S.successPill, { borderColor: PRIMARY_LT }]}>
            <Ionicons name="information-circle-outline" size={14} color={PRIMARY} />
            <Text style={[S.successPillText, { color: PRIMARY }]}>Previously marked</Text>
          </View>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <SafeAreaView style={S.safe}>
        <Animated.View style={[S.stateCard, { opacity: fadeAnim }]}>
          <View style={[S.iconCircle, { backgroundColor: DANGER_LT }]}>
            <Ionicons name="close-circle-outline" size={32} color={DANGER} />
          </View>
          <Text style={[S.stateTitle, { color: DANGER }]}>Scan Failed</Text>
          <Text style={S.stateSub}>{errorMessage}</Text>
          <TouchableOpacity style={[S.primaryBtn, { marginTop: 12 }]} onPress={handleRetry}>
            <Ionicons name="refresh-outline" size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={S.primaryBtnText}>Scan Again</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.ghostBtn} onPress={() => navigation.goBack()}>
            <Text style={S.ghostBtnText}>Go Back</Text>
          </TouchableOpacity>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ── Active scanner ────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={S.safe} edges={["top", "bottom"]}>

      {/* Header */}
      <View style={S.header}>
        <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={S.headerCenter}>
          <Text style={S.headerTitle}>Scan QR Code</Text>
          <Text style={S.headerSub}>Point camera at teacher's screen</Text>
        </View>
        <View style={{ width: 38 }} />
      </View>

      {/* Camera + viewfinder */}
      <View style={S.cameraWrap}>
        <CameraView
          style={S.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
        />

        {/* Dark overlay */}
        <View style={S.overlayTop} />
        <View style={S.overlayRow}>
          <View style={S.overlaySide} />
          <View style={S.viewfinder}>
            <Animated.View style={[S.corner, S.cornerTL, { opacity: cornerOpacity }]} />
            <Animated.View style={[S.corner, S.cornerTR, { opacity: cornerOpacity }]} />
            <Animated.View style={[S.corner, S.cornerBL, { opacity: cornerOpacity }]} />
            <Animated.View style={[S.corner, S.cornerBR, { opacity: cornerOpacity }]} />
            <Animated.View style={[S.scanLine, { transform: [{ translateY: scanLineTranslate }] }]} />
          </View>
          <View style={S.overlaySide} />
        </View>
        <View style={S.overlayBottom} />
      </View>

      {/* Bottom card */}
      <View style={S.bottomCard}>
        <View style={S.livePill}>
          <View style={S.liveDot} />
          <Text style={S.livePillText}>SCANNER ACTIVE</Text>
        </View>
        <Text style={S.instructTitle}>Hold your phone steady</Text>
        <Text style={S.instructSub}>
          Align the QR code within the frame. The code rotates every 5 seconds.
        </Text>
        <View style={S.tipRow}>
          <View style={S.tipItem}>
            <Ionicons name="sunny-outline" size={16} color={PRIMARY} />
            <Text style={S.tipText}>Good lighting</Text>
          </View>
          <View style={S.tipDivider} />
          <View style={S.tipItem}>
            <Ionicons name="resize-outline" size={16} color={PRIMARY} />
            <Text style={S.tipText}>Fill the frame</Text>
          </View>
          <View style={S.tipDivider} />
          <View style={S.tipItem}>
            <Ionicons name="hand-left-outline" size={16} color={PRIMARY} />
            <Text style={S.tipText}>Stay still</Text>
          </View>
        </View>
      </View>

    </SafeAreaView>
  );
}

// ─── Dimensions ──────────────────────────────────────────────────────────────
const VIEWFINDER_SIZE = 240;
const CORNER_SIZE     = 26;
const CORNER_WIDTH    = 4;

const S = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: "#0D0D0D" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: BG },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#0D0D0D",
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.1)",
    justifyContent: "center", alignItems: "center",
  },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle:  { fontSize: 17, fontWeight: "800", color: "#FFFFFF", letterSpacing: 0.2 },
  headerSub:    { fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 2 },

  // Camera
  cameraWrap: { flex: 1, position: "relative" },
  camera:     { ...StyleSheet.absoluteFillObject },

  overlayTop: {
    position: "absolute", top: 0, left: 0, right: 0,
    height: "25%", backgroundColor: "rgba(0,0,0,0.62)",
  },
  overlayRow: {
    position: "absolute", top: "25%", left: 0, right: 0,
    flexDirection: "row", height: VIEWFINDER_SIZE,
  },
  overlaySide:   { flex: 1, backgroundColor: "rgba(0,0,0,0.62)" },
  overlayBottom: {
    position: "absolute", top: "25%", marginTop: VIEWFINDER_SIZE,
    left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.62)",
  },

  // Viewfinder
  viewfinder: {
    width: VIEWFINDER_SIZE, height: VIEWFINDER_SIZE,
    overflow: "hidden", justifyContent: "center", alignItems: "center",
  },
  corner: { position: "absolute", width: CORNER_SIZE, height: CORNER_SIZE, borderColor: PRIMARY },
  cornerTL: { top: 0, left: 0, borderTopWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH, borderTopLeftRadius: 6 },
  cornerTR: { top: 0, right: 0, borderTopWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH, borderTopRightRadius: 6 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH, borderBottomLeftRadius: 6 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH, borderBottomRightRadius: 6 },
  scanLine: {
    position: "absolute", left: 10, right: 10, height: 2.5, borderRadius: 2,
    backgroundColor: PRIMARY,
    shadowColor: PRIMARY, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },

  // Bottom card
  bottomCard: {
    backgroundColor: CARD,
    paddingHorizontal: 24, paddingVertical: 22, paddingBottom: 28,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 20,
    shadowOffset: { width: 0, height: -4 }, elevation: 10,
  },
  livePill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    alignSelf: "center", backgroundColor: SUCCESS_LT,
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 20, marginBottom: 16,
  },
  liveDot:     { width: 7, height: 7, borderRadius: 4, backgroundColor: SUCCESS },
  livePillText: { color: SUCCESS, fontWeight: "800", fontSize: 11, letterSpacing: 1.2 },
  instructTitle: { fontSize: 18, fontWeight: "800", color: INK, textAlign: "center", marginBottom: 8 },
  instructSub:   { fontSize: 13, color: MUTED, textAlign: "center", lineHeight: 20, marginBottom: 20 },
  tipRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: PRIMARY_LT, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 8,
  },
  tipItem:   { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, justifyContent: "center" },
  tipText:   { fontSize: 12, color: PRIMARY, fontWeight: "600" },
  tipDivider: { width: 1, height: 18, backgroundColor: "rgba(72,52,212,0.2)" },

  // State screens
  stateCard: {
    flex: 1, backgroundColor: BG,
    justifyContent: "center", alignItems: "center",
    paddingHorizontal: 32, gap: 10,
  },
  iconCircle: {
    width: 80, height: 80, borderRadius: 40,
    justifyContent: "center", alignItems: "center", marginBottom: 4,
  },
  stateTitle: { fontSize: 22, fontWeight: "800", color: INK, textAlign: "center" },
  stateSub:   { fontSize: 14, color: MUTED, textAlign: "center", lineHeight: 21, marginBottom: 8 },

  primaryBtn: {
    width: "100%", flexDirection: "row",
    backgroundColor: PRIMARY, paddingVertical: 16, borderRadius: 16,
    alignItems: "center", justifyContent: "center", marginTop: 4,
  },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  ghostBtn: {
    width: "100%", paddingVertical: 14, borderRadius: 16,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: BORDER, marginTop: 4,
  },
  ghostBtnText: { color: MUTED, fontSize: 15, fontWeight: "600" },

  successPill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    alignSelf: "center", backgroundColor: SUCCESS_LT,
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginTop: 6,
  },
  successPillText: { color: SUCCESS, fontWeight: "700", fontSize: 13 },
});