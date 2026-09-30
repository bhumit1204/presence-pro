import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from "react-native";
import { useRoute, useNavigation } from "@react-navigation/native";
import { getUserSession } from "../../../services/session";
import { Ionicons } from "@expo/vector-icons";
import BleManager from "react-native-ble-manager";
import WifiManager from "react-native-wifi-reborn";

// ─── Native BLE Scanner (BleScannerModule.java) ───────────────────────────────
// Uses Android's BluetoothLeScanner API directly — bypasses the JS bridge
// type issues that cause "expected Map, got array" in New Architecture.
// scanForTeacher(durationMs) → Promise<number | null>  (RSSI or null)
const { BleScanner } = NativeModules as {
  BleScanner: {
    scanForTeacher(durationMs: number): Promise<number | null>;
  } | undefined;
};

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
    if (!allGranted) console.log("BLE SCAN PERMISSIONS: some denied →", grants);
    return allGranted;
  } else {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title:   "Location Permission",
        message: "Bluetooth scanning requires location access.",
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

// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

const BLE_SERVICE_UUID = "12345678-1234-1234-1234-123456789abc";

// Module-level flag — BleManager.start() only needs to run once per app session
let bleStarted = false;

type Phase     = "loading" | "select" | "scanning" | "error" | "success";
type ErrorType = "wrong_code" | "too_far" | "weak_ble" | "weak_wifi" | "no_signal" | "marginal" | "closed" | "generic";

interface ErrorInfo {
  type:    ErrorType | string;
  message: string;
  score?:  number;
  soft:    boolean;
}

const ERROR_CONFIG: Record<string, { icon: string; color: string; action: string }> = {
  wrong_code: { icon: "close-circle-outline",   color: DANGER,  action: "Select the code shown by your teacher" },
  no_signal:  { icon: "wifi-off-outline",        color: DANGER,  action: "Turn on WiFi & Bluetooth, then retry"  },
  too_far:    { icon: "walk-outline",            color: DANGER,  action: "Move closer to the teacher"            },
  weak_ble:   { icon: "bluetooth-outline",       color: WARNING, action: "Move closer and retry"                 },
  weak_wifi:  { icon: "wifi-outline",            color: WARNING, action: "Move closer and retry"                 },
  marginal:   { icon: "radio-outline",           color: WARNING, action: "Move closer to the teacher"            },
  closed:     { icon: "lock-closed-outline",     color: DANGER,  action: "Contact your teacher"                  },
  generic:    { icon: "alert-circle-outline",    color: DANGER,  action: "Try again"                             },
};

const SCAN_STEPS = [
  { key: "wifi", icon: "wifi-outline",         label: "WiFi scan"  },
  { key: "ble",  icon: "bluetooth-outline",    label: "BLE scan"   },
  { key: "sub",  icon: "cloud-upload-outline", label: "Submitting" },
];

export default function CodeMarkingScreen() {
  const route      = useRoute<any>();
  const navigation = useNavigation<any>();
  const { lectureSessionId } = route.params;

  const [phase, setPhase]                             = useState<Phase>("loading");
  const [options, setOptions]                         = useState<string[]>([]);
  const [selectedCode, setSelectedCode]               = useState<string | null>(null);
  const [attendanceSessionId, setAttendanceSessionId] = useState<string | null>(null);
  const [errorInfo, setErrorInfo]                     = useState<ErrorInfo | null>(null);
  const [scanStep, setScanStep]                       = useState<string | null>(null);

  const progressAnim = useRef(new Animated.Value(0)).current;

  const animateTo = (v: number) =>
    Animated.timing(progressAnim, {
      toValue:         v,
      duration:        400,
      useNativeDriver: false,
    }).start();

  useEffect(() => {
    fetchCodeOptions();

    // Pre-initialise BleManager (used for checkState etc elsewhere in the app)
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

  const fetchCodeOptions = async () => {
    try {
      const res  = await fetch(
        `${API_URL}/api/lectures/attendance/code-options?lecture_session_id=${lectureSessionId}`
      );
      const data = await res.json();

      if (!data.success) {
        setErrorInfo({ type: "closed", message: "Attendance is not open right now.", soft: false });
        setPhase("error");
        return;
      }

      setOptions(data.options);
      setAttendanceSessionId(data.attendance_session_id);
      setPhase("select");
    } catch {
      setErrorInfo({ type: "generic", message: "Could not load attendance options. Check your connection.", soft: false });
      setPhase("error");
    }
  };

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
  // BleScannerModule.java calls Android's BluetoothLeScanner directly.
  // No JS bridge type issues — resolves with best RSSI number or null.
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

  const handleSubmit = async () => {
    if (!selectedCode) return;
    setPhase("scanning");
    setErrorInfo(null);
    animateTo(0);

    try {
      setScanStep("wifi");
      animateTo(0.2);

      // Run WiFi and BLE in parallel — saves ~5s vs sequential
      const [studentWifi, bleRssi] = await Promise.all([
        scanStudentWifi(),
        scanForTeacherBle(),
      ]);

      setScanStep("sub");
      animateTo(0.75);

      const session = await getUserSession();
      const uid     = session?.uid;

      const res = await fetch(`${API_URL}/api/lectures/attendance/mark-code`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendance_session_id: attendanceSessionId,
          selected_code:         selectedCode,
          uid,
          student_wifi_scan:     studentWifi,
          ble_rssi:              bleRssi,
        }),
      });

      const data = await res.json();
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

    } catch {
      setPhase("error");
      setErrorInfo({ type: "generic", message: "Something went wrong. Please try again.", soft: false });
    }
  };

  const errCfg = errorInfo ? (ERROR_CONFIG[errorInfo.type] || ERROR_CONFIG.generic) : null;

  if (phase === "loading") {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={PRIMARY} />
      </View>
    );
  }

  return (
    <View style={styles.container}>

      {/* Code selection */}
      {phase === "select" && (
        <>
          <Text style={styles.title}>Select the Correct Code</Text>
          <Text style={styles.subtitle}>Choose the code shown by your teacher</Text>

          <View style={styles.hintBox}>
            <Ionicons name="shield-checkmark-outline" size={16} color="#4338CA" style={{ marginRight: 6 }} />
            <Text style={styles.hintText}>WiFi + BLE will confirm you're in the room</Text>
          </View>

          <View style={styles.optionsContainer}>
            {options.map((code) => {
              const sel = selectedCode === code;
              return (
                <TouchableOpacity
                  key={code}
                  style={[styles.codeOption, sel && styles.codeOptionSelected]}
                  onPress={() => setSelectedCode(code)}
                >
                  <Text style={[styles.codeText, sel && { color: "#fff" }]}>{code}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            style={[styles.submitBtn, !selectedCode && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={!selectedCode}
          >
            <Text style={styles.submitText}>Submit Attendance</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Scanning */}
      {phase === "scanning" && (
        <View style={styles.card}>
          <ActivityIndicator size="large" color={PRIMARY} style={{ marginBottom: 20 }} />

          <View style={styles.progressTrack}>
            <Animated.View
              style={[styles.progressFill, {
                width: progressAnim.interpolate({
                  inputRange:  [0, 1],
                  outputRange: ["0%", "100%"],
                }),
              }]}
            />
          </View>

          <View style={styles.stepIndicatorRow}>
            {SCAN_STEPS.map((s) => {
              const activeIdx = SCAN_STEPS.findIndex((x) => x.key === scanStep);
              const thisIdx   = SCAN_STEPS.findIndex((x) => x.key === s.key);
              const isActive  = s.key === scanStep;
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

          <Text style={styles.scanHint}>Keep WiFi & Bluetooth on · stay in the classroom</Text>
        </View>
      )}

      {/* Error */}
      {phase === "error" && errorInfo && errCfg && (
        <View style={styles.card}>
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

          {errorInfo.type === "wrong_code" ? (
            <TouchableOpacity
              style={[styles.submitBtn, { backgroundColor: PRIMARY, marginTop: 20 }]}
              onPress={() => { setPhase("select"); setErrorInfo(null); animateTo(0); setSelectedCode(null); }}
            >
              <Text style={styles.submitText}>Choose Again</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.submitBtn, { backgroundColor: errCfg.color, marginTop: 20 }]}
              onPress={() => { setPhase("select"); setErrorInfo(null); animateTo(0); }}
            >
              <Text style={styles.submitText}>{errorInfo.soft ? "Try Again" : "Go Back"}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Success */}
      {phase === "success" && (
        <View style={styles.card}>
          <Ionicons name="checkmark-circle-outline" size={64} color={SUCCESS} />
          <Text style={styles.successTitle}>Attendance Marked</Text>
          <Text style={styles.successSubtitle}>You're all set for today's class.</Text>
        </View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  center:    { flex: 1, justifyContent: "center", alignItems: "center" },
  container: { flex: 1, padding: 24, backgroundColor: "#F3F4F6", justifyContent: "center" },

  title:    { fontSize: 26, fontWeight: "bold", textAlign: "center", marginBottom: 10, color: "#111827" },
  subtitle: { textAlign: "center", color: "#6B7280", marginBottom: 16 },

  hintBox:  { flexDirection: "row", alignItems: "center", backgroundColor: "#EEF2FF", borderRadius: 12, padding: 12, marginBottom: 24 },
  hintText: { fontSize: 13, color: "#4338CA", flex: 1, lineHeight: 18 },

  optionsContainer:   { gap: 14, marginBottom: 8 },
  codeOption:         { backgroundColor: "#fff", padding: 22, borderRadius: 16, alignItems: "center", borderWidth: 2, borderColor: "#E5E7EB" },
  codeOptionSelected: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  codeText:           { fontSize: 28, fontWeight: "bold", color: "#111827" },

  submitBtn:         { marginTop: 28, backgroundColor: SUCCESS, padding: 18, borderRadius: 16, alignItems: "center" },
  submitBtnDisabled: { backgroundColor: "#9CA3AF" },
  submitText:        { color: "#fff", fontSize: 16, fontWeight: "bold" },

  card: { backgroundColor: "#fff", borderRadius: 24, padding: 28, alignItems: "center", shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 12, elevation: 5 },

  progressTrack: { width: "100%", height: 6, backgroundColor: "#E5E7EB", borderRadius: 3, marginBottom: 24, overflow: "hidden" },
  progressFill:  { height: "100%", backgroundColor: PRIMARY, borderRadius: 3 },

  stepIndicatorRow: { flexDirection: "row", justifyContent: "space-between", width: "100%", marginBottom: 20 },
  stepIndicator:    { alignItems: "center", flex: 1 },
  stepDot:          { width: 28, height: 28, borderRadius: 14, backgroundColor: "#E5E7EB", justifyContent: "center", alignItems: "center", marginBottom: 6 },
  stepDotActive:    { backgroundColor: PRIMARY },
  stepDotDone:      { backgroundColor: SUCCESS },
  stepDotLabel:     { fontSize: 10, color: "#9CA3AF", textAlign: "center" },
  scanHint:         { fontSize: 12, color: "#9CA3AF", textAlign: "center" },

  errorTitle:   { fontSize: 20, fontWeight: "bold", marginTop: 14, marginBottom: 10, textAlign: "center" },
  errorMessage: { fontSize: 14, color: "#374151", textAlign: "center", lineHeight: 20, marginBottom: 16 },
  actionHint:   { fontSize: 13, color: "#6B7280", textAlign: "center", fontStyle: "italic" },

  scoreContainer: { width: "100%", marginBottom: 14 },
  scoreLabel:     { fontSize: 12, color: "#9CA3AF", marginBottom: 6, textAlign: "center" },
  scoreTrack:     { width: "100%", height: 8, backgroundColor: "#E5E7EB", borderRadius: 4, overflow: "hidden" },
  scoreFill:      { height: "100%", borderRadius: 4 },
  scoreValue:     { fontSize: 12, color: "#6B7280", textAlign: "center", marginTop: 4 },

  successTitle:    { fontSize: 22, fontWeight: "bold", color: SUCCESS, marginTop: 16, marginBottom: 6 },
  successSubtitle: { fontSize: 14, color: "#6B7280", textAlign: "center" },
});