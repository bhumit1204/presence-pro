import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { useRoute, useNavigation } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";
import { Ionicons } from "@expo/vector-icons";
import BleManager from "react-native-ble-manager";
import WifiManager from "react-native-wifi-reborn";

// ─── Native BLE Scanner (BleScannerModule.java) ───────────────────────────────
// FIXED: switched from BleManager NativeEventEmitter scan (unreliable UUID
// matching, race conditions) to NativeModules.BleScanner — the same Java
// native module used by CodeMarkingScreen.
// scanForTeacher(durationMs) → Promise<number | null>  (best RSSI or null)
const { BleScanner } = NativeModules as {
  BleScanner: {
    scanForTeacher(durationMs: number): Promise<number | null>;
  } | undefined;
};

// ─── RSSI threshold ───────────────────────────────────────────────────────────
// Students with BLE RSSI weaker than -90 are rejected on-device before the
// request even reaches the server. This prevents proxy/relay attendance fraud.
const RSSI_THRESHOLD = -90;

async function requestBleScanPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  if (Platform.Version >= 31) {
    const grants = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    const allGranted = Object.values(grants).every(
      (r) => r === PermissionsAndroid.RESULTS.GRANTED
    );
    if (!allGranted) console.log("[BLE] Scan permissions denied →", grants);
    return allGranted;
  } else {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title:          "Location Permission",
        message:        "Bluetooth scanning requires location access.",
        buttonPositive: "Allow",
      }
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  }
}

const PRIMARY = "#4834D4";
const SUCCESS = "#2ECC71";
const WARNING = "#F59E0B";
const DANGER  = "#EF4444";
const BG      = "#F3F4F6";

// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

const BLE_SERVICE_UUID = "12345678-1234-1234-1234-123456789abc";

// Track whether BleManager.start() has already been called this session
let bleStarted = false;

const STEPS = [
  { key: "bio",    icon: "finger-print-outline", label: "Verifying identity" },
  { key: "scan",   icon: "wifi-outline",          label: "Scanning signals"   },
  { key: "submit", icon: "cloud-upload-outline",  label: "Submitting"         },
] as const;

type StepKey   = typeof STEPS[number]["key"];
type ErrorType = "too_far" | "weak_ble" | "weak_wifi" | "no_signal" | "marginal" | "closed" | "generic";

interface ProximityResult {
  verdict:      boolean;
  soft_warning: boolean;
  score:        number;
  message:      string;
  error_type:   ErrorType | string;
}

const ERROR_CONFIG: Record<string, { icon: string; color: string; action: string }> = {
  no_signal: { icon: "wifi-off-outline",     color: DANGER,  action: "Check WiFi & Bluetooth, then retry" },
  too_far:   { icon: "walk-outline",         color: DANGER,  action: "Move closer to the teacher"         },
  weak_ble:  { icon: "bluetooth-outline",    color: WARNING, action: "Move closer and retry"              },
  weak_wifi: { icon: "wifi-outline",         color: WARNING, action: "Move closer and retry"              },
  marginal:  { icon: "radio-outline",        color: WARNING, action: "Move closer to the teacher"         },
  closed:    { icon: "lock-closed-outline",  color: DANGER,  action: "Contact your teacher"               },
  generic:   { icon: "alert-circle-outline", color: DANGER,  action: "Try again"                          },
};

export default function BioGeoMarkingScreen() {
  const route      = useRoute<any>();
  const navigation = useNavigation<any>();
  const { attendanceSessionId } = route.params;

  const [phase, setPhase]           = useState<"idle" | "running" | "error" | "success">("idle");
  const [activeStep, setActiveStep] = useState<StepKey | null>(null);
  const [errorInfo, setErrorInfo]   = useState<{
    type: string; message: string; score?: number; soft: boolean;
  } | null>(null);

  const progressAnim = useRef(new Animated.Value(0)).current;

  const animateTo = (fraction: number) => {
    Animated.timing(progressAnim, {
      toValue:         fraction,
      duration:        400,
      useNativeDriver: false,
    }).start();
  };

  // Pre-initialise BleManager on mount so it's ready when student taps.
  // Eliminates the startup delay on first scan.
  useEffect(() => {
    (async () => {
      if (bleStarted) return;
      try {
        const hasPerms = await requestBleScanPermissions();
        if (!hasPerms) return;
        await BleManager.start({ showAlert: false });
        bleStarted = true;
        console.log("[BLE] Manager pre-initialised");
      } catch (e) {
        console.log("[BLE] Pre-init error (non-fatal):", e);
      }
    })();
  }, []);

  const handleMarkAttendance = async () => {
    setPhase("running");
    setErrorInfo(null);
    animateTo(0);

    try {
      // ── STEP 1: Biometric ──────────────────────────────────────────────────
      setActiveStep("bio");
      animateTo(0.15);

      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled  = await LocalAuthentication.isEnrolledAsync();

      if (!hasHardware || !isEnrolled) {
        setPhase("error");
        setErrorInfo({
          type: "generic",
          message: "Biometric authentication is not set up on this device.",
          soft: false,
        });
        return;
      }

      const authResult = await LocalAuthentication.authenticateAsync({
        promptMessage: "Authenticate to mark attendance",
        fallbackLabel: "Use Passcode",
      });

      if (!authResult.success) {
        setPhase("error");
        setErrorInfo({
          type: "generic",
          message: "Identity verification failed. Please try again.",
          soft: false,
        });
        return;
      }

      animateTo(0.35);

      // ── STEP 2: WiFi + BLE in parallel ────────────────────────────────────
      setActiveStep("scan");
      animateTo(0.40);

      const [studentWifi, bleRssi] = await Promise.all([
        scanStudentWifi(),
        scanForTeacherBle(),
      ]);

      animateTo(0.70);

      // ── CLIENT-SIDE RSSI THRESHOLD CHECK ─────────────────────────────────
      // Hard-block: if BLE RSSI is weaker than -90 (or no signal found at all),
      // reject immediately on-device. No server round-trip needed.
      if (bleRssi === null || bleRssi < RSSI_THRESHOLD) {
        setPhase("error");
        setErrorInfo({
          type: "too_far",
          message:
            bleRssi === null
              ? "Teacher's Bluetooth beacon not found. Make sure Bluetooth is on and you're in the classroom."
              : `You are too far from the classroom (signal: ${bleRssi} dBm). Move closer and try again.`,
          soft: false,
        });
        return;
      }

      // ── STEP 3: Submit ────────────────────────────────────────────────────
      setActiveStep("submit");
      animateTo(0.80);

      const session         = await getUserSession();
      const uid             = session?.uid;
      const deviceSignature = `${uid}_${attendanceSessionId}_${Date.now()}`;

      const res = await fetch(`${API_URL}/api/lectures/attendance/mark-bio`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendance_session_id: attendanceSessionId,
          uid,
          device_signature:  deviceSignature,
          student_wifi_scan: studentWifi,
          ble_rssi:          bleRssi,         // stored in Firestore → drives teacher certainty view
        }),
      });

      const data: ProximityResult & { success: boolean; already_marked?: boolean } =
        await res.json();

      animateTo(1.0);

      if (data.success) {
        setPhase("success");
        return;
      }

      setPhase("error");
      setErrorInfo({
        type:    data.error_type || "generic",
        message: data.message   || "Could not mark attendance.",
        score:   data.score,
        soft:    data.soft_warning || false,
      });

    } catch (e) {
      console.log("[BioMarking] Error:", e);
      setPhase("error");
      setErrorInfo({
        type: "generic",
        message: "Something went wrong. Please try again.",
        soft: false,
      });
    }
  };

  // ── WiFi scan ──────────────────────────────────────────────────────────────
  const scanStudentWifi = async (): Promise<any[]> => {
    try {
      const nets: any[] = await WifiManager.loadWifiList();
      return (nets || []).map((n: any) => ({
        ssid:  n.SSID  || "",
        bssid: n.BSSID || "",
        rssi:  n.level ?? n.RSSI ?? -100,
      }));
    } catch {
      return [];
    }
  };

  // ── BLE scan via NativeModules.BleScanner ─────────────────────────────────
  // FIXED: uses the same native Java module as CodeMarkingScreen.
  // BleScannerModule.java calls Android's BluetoothLeScanner directly —
  // no JS bridge type issues, no UUID case-sensitivity bugs.
  // Resolves with best RSSI found during the scan window, or null.
  const scanForTeacherBle = async (): Promise<number | null> => {
    try {
      if (!BleScanner) {
        console.log("[BLE] BleScanner native module not found — rebuild app");
        return null;
      }

      const hasPerms = await requestBleScanPermissions();
      if (!hasPerms) {
        console.log("[BLE] Scan permissions not granted");
        return null;
      }

      console.log("[BLE] Starting native scan (5s)…");
      const rssi = await BleScanner.scanForTeacher(5000);
      console.log("[BLE] Scan done, bestRssi:", rssi);
      return rssi;

    } catch (e: any) {
      console.log("[BLE] Scan error:", e?.message ?? e);
      return null;
    }
  };

  const errCfg = errorInfo ? (ERROR_CONFIG[errorInfo.type] || ERROR_CONFIG.generic) : null;

  return (
    <View style={styles.container}>
      <View style={styles.card}>

        {/* ── Idle ── */}
        {phase === "idle" && (
          <>
            <View style={styles.iconContainer}>
              <Ionicons name="finger-print-outline" size={28} color="#fff" />
            </View>
            <Text style={styles.title}>Mark Attendance</Text>
            <Text style={styles.subtitle}>
              Make sure WiFi and Bluetooth are on before tapping.
            </Text>

            <View style={styles.stepsBox}>
              {STEPS.map((s) => (
                <View key={s.key} style={styles.stepRow}>
                  <Ionicons name={s.icon as any} size={18} color={PRIMARY} />
                  <Text style={styles.stepLabel}>{s.label}</Text>
                </View>
              ))}
            </View>

            <View style={styles.thresholdNote}>
              <Ionicons name="bluetooth-outline" size={14} color="#6366F1" />
              <Text style={styles.thresholdText}>
                BLE signal must be stronger than {RSSI_THRESHOLD} dBm (you must be in the room)
              </Text>
            </View>

            <TouchableOpacity style={styles.primaryBtn} onPress={handleMarkAttendance}>
              <Text style={styles.primaryBtnText}>Mark Attendance</Text>
            </TouchableOpacity>
          </>
        )}

        {/* ── Running ── */}
        {phase === "running" && (
          <View style={styles.runningContainer}>
            <ActivityIndicator size="large" color={PRIMARY} style={{ marginBottom: 20 }} />

            <View style={styles.progressTrack}>
              <Animated.View
                style={[
                  styles.progressFill,
                  {
                    width: progressAnim.interpolate({
                      inputRange:  [0, 1],
                      outputRange: ["0%", "100%"],
                    }),
                  },
                ]}
              />
            </View>

            <View style={styles.stepIndicatorRow}>
              {STEPS.map((s) => {
                const activeIdx = STEPS.findIndex((x) => x.key === activeStep);
                const thisIdx   = STEPS.findIndex((x) => x.key === s.key);
                const isActive  = s.key === activeStep;
                const isDone    = activeIdx > thisIdx;
                return (
                  <View key={s.key} style={styles.stepIndicator}>
                    <View style={[
                      styles.stepDot,
                      isActive && styles.stepDotActive,
                      isDone   && styles.stepDotDone,
                    ]}>
                      {isDone
                        ? <Ionicons name="checkmark" size={10} color="#fff" />
                        : <Ionicons name={s.icon as any} size={12} color={isActive ? "#fff" : "#9CA3AF"} />
                      }
                    </View>
                    <Text style={[
                      styles.stepDotLabel,
                      isActive && { color: PRIMARY, fontWeight: "700" as const },
                    ]}>
                      {s.label}
                    </Text>
                  </View>
                );
              })}
            </View>

            <Text style={styles.runningHint}>Stay still · keep WiFi & Bluetooth on</Text>
          </View>
        )}

        {/* ── Error ── */}
        {phase === "error" && errorInfo && errCfg && (
          <View style={styles.errorContainer}>
            <Ionicons name={errCfg.icon as any} size={52} color={errCfg.color} />

            <Text style={[styles.errorTitle, { color: errCfg.color }]}>
              {errorInfo.soft ? "Almost There" : "Could Not Verify"}
            </Text>

            <Text style={styles.errorMessage}>{errorInfo.message}</Text>

            {errorInfo.score !== undefined && (
              <View style={styles.scoreContainer}>
                <Text style={styles.scoreLabel}>Proximity Score</Text>
                <View style={styles.scoreTrack}>
                  <View style={[styles.scoreFill, {
                    width: `${errorInfo.score}%` as any,
                    backgroundColor:
                      errorInfo.score >= 65 ? SUCCESS :
                      errorInfo.score >= 50 ? WARNING : DANGER,
                  }]} />
                </View>
                <Text style={styles.scoreValue}>{errorInfo.score} / 100</Text>
              </View>
            )}

            <Text style={styles.actionHint}>{errCfg.action}</Text>

            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: errCfg.color, marginTop: 20 }]}
              onPress={() => { setPhase("idle"); setErrorInfo(null); animateTo(0); }}
            >
              <Text style={styles.primaryBtnText}>
                {errorInfo.soft ? "Try Again" : "Go Back"}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Success ── */}
        {phase === "success" && (
          <View style={styles.successContainer}>
            <Ionicons name="checkmark-circle-outline" size={64} color={SUCCESS} />
            <Text style={styles.successTitle}>Attendance Marked</Text>
            <Text style={styles.successSubtitle}>You're all set for today's class.</Text>
          </View>
        )}

      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: BG,
    justifyContent: "center", alignItems: "center", padding: 20,
  },
  card: {
    width: "100%", backgroundColor: "#fff", borderRadius: 24,
    padding: 28, alignItems: "center",
    shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 12, elevation: 5,
  },

  iconContainer: {
    backgroundColor: PRIMARY, width: 64, height: 64, borderRadius: 32,
    justifyContent: "center", alignItems: "center", marginBottom: 18,
  },
  title:    { fontSize: 22, fontWeight: "bold", color: "#111827", marginBottom: 8, textAlign: "center" },
  subtitle: { fontSize: 14, color: "#6B7280", textAlign: "center", marginBottom: 20, lineHeight: 20 },

  stepsBox: {
    width: "100%", backgroundColor: "#F9FAFB",
    borderRadius: 14, padding: 16, marginBottom: 14,
  },
  stepRow:   { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  stepLabel: { marginLeft: 10, fontSize: 14, color: "#374151" },

  thresholdNote: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#EEF2FF", borderRadius: 10,
    padding: 10, marginBottom: 20, gap: 6,
  },
  thresholdText: { fontSize: 12, color: "#4338CA", flex: 1, lineHeight: 17 },

  primaryBtn:     { backgroundColor: PRIMARY, paddingVertical: 16, borderRadius: 14, width: "100%", alignItems: "center" },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "bold" },

  runningContainer:  { width: "100%", alignItems: "center", paddingVertical: 10 },
  progressTrack:     { width: "100%", height: 6, backgroundColor: "#E5E7EB", borderRadius: 3, marginBottom: 24, overflow: "hidden" },
  progressFill:      { height: "100%", backgroundColor: PRIMARY, borderRadius: 3 },
  stepIndicatorRow:  { flexDirection: "row", justifyContent: "space-between", width: "100%", marginBottom: 20 },
  stepIndicator:     { alignItems: "center", flex: 1 },
  stepDot:           { width: 28, height: 28, borderRadius: 14, backgroundColor: "#E5E7EB", justifyContent: "center", alignItems: "center", marginBottom: 6 },
  stepDotActive:     { backgroundColor: PRIMARY },
  stepDotDone:       { backgroundColor: SUCCESS },
  stepDotLabel:      { fontSize: 10, color: "#9CA3AF", textAlign: "center" },
  runningHint:       { fontSize: 12, color: "#9CA3AF", textAlign: "center" },

  errorContainer: { alignItems: "center", paddingVertical: 10, width: "100%" },
  errorTitle:     { fontSize: 20, fontWeight: "bold", marginTop: 14, marginBottom: 10, textAlign: "center" },
  errorMessage:   { fontSize: 14, color: "#374151", textAlign: "center", lineHeight: 20, marginBottom: 16 },
  actionHint:     { fontSize: 13, color: "#6B7280", textAlign: "center", fontStyle: "italic" },

  scoreContainer: { width: "100%", marginBottom: 14 },
  scoreLabel:     { fontSize: 12, color: "#9CA3AF", marginBottom: 6, textAlign: "center" },
  scoreTrack:     { width: "100%", height: 8, backgroundColor: "#E5E7EB", borderRadius: 4, overflow: "hidden" },
  scoreFill:      { height: "100%", borderRadius: 4 },
  scoreValue:     { fontSize: 12, color: "#6B7280", textAlign: "center", marginTop: 4 },

  successContainer: { alignItems: "center", paddingVertical: 16 },
  successTitle:     { fontSize: 22, fontWeight: "bold", color: SUCCESS, marginTop: 16, marginBottom: 6 },
  successSubtitle:  { fontSize: 14, color: "#6B7280", textAlign: "center" },
});