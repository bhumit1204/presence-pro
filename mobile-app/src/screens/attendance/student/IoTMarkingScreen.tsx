import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, Platform, PermissionsAndroid, Animated, Vibration,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getUserSession } from "../../../services/session";
import { BleManager, Device } from "react-native-ble-plx";
import { Buffer } from "buffer";

// ── Theme ────────────────────────────────────────────────────────────────────
const PRIMARY    = "#4834D4";
const PRIMARY_LT = "#EEF0FF";
const SUCCESS    = "#10B981";
const SUCCESS_LT = "#D1FAE5";
const WARNING    = "#F59E0B";
const WARNING_LT = "#FEF3C7";
const ERROR      = "#EF4444";
const ERROR_LT   = "#FEE2E2";
const BG         = "#F3F4F6";
const CARD       = "#FFFFFF";
const INK        = "#111827";
const MUTED      = "#6B7280";
const BORDER     = "#E5E7EB";

// ── BLE Constants ────────────────────────────────────────────────────────────
const BLE_DEVICE_NAME   = "PresenceMarker";
const SERVICE_UUID      = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const STUDENT_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

// RSSI gate — device must be closer than this to trigger marking
const RSSI_THRESHOLD = -40;

// Rolling local buffer — prevents re-marking same session without a server call
const BUFFER_KEY  = "iot_marked_buffer_v2";
const BUFFER_SIZE = 50;

const RETRY_SCAN_DELAY  = 4000;
const MAX_ERROR_RETRIES = 3;

type ScanPhase =
  | "init"
  | "perm_required"
  | "scanning"
  | "too_far"
  | "connecting"
  | "success"
  | "already"
  | "error"
  | "no_session";

// Single shared BleManager instance
const bleManager = new BleManager();

export default function IoTMarkingScreen() {
  const navigation = useNavigation<any>();

  const [phase, setPhase]         = useState<ScanPhase>("init");
  const [uid, setUid]             = useState<string>("");
  const [statusMsg, setStatusMsg] = useState("");
  const [rssi, setRssi]           = useState<number | null>(null);

  const connectedDevice = useRef<Device | null>(null);
  const scanning        = useRef(false);
  const markingLock     = useRef(false);
  const errorRetryCount = useRef(0);
  const mounted         = useRef(true);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim  = useRef(new Animated.Value(0)).current;

  // ── Pulse animation while scanning / connecting ──────────────────────────
  useEffect(() => {
    if (phase !== "scanning" && phase !== "too_far" && phase !== "connecting") return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,    duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [phase]);

  // ── Fade in on every phase change ────────────────────────────────────────
  useEffect(() => {
    fadeAnim.setValue(0);
    Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
  }, [phase]);

  // ── Mount / unmount ──────────────────────────────────────────────────────
  useEffect(() => {
    mounted.current = true;
    loadUidAndStart();
    return () => {
      mounted.current = false;
      stopScan();
    };
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const safe = (fn: () => void) => { if (mounted.current) fn(); };

  const loadUidAndStart = async () => {
    try {
      const session   = await getUserSession();
      const storedUid = session?.uid ?? null;
      if (!storedUid) {
        safe(() => { setPhase("error"); setStatusMsg("User session not found. Please log in again."); });
        return;
      }
      safe(() => setUid(storedUid));
      await startScanning(storedUid);
    } catch {
      safe(() => { setPhase("error"); setStatusMsg("Could not load user session."); });
    }
  };

  const requestBlePerms = async (): Promise<boolean> => {
    if (Platform.OS !== "android") return true;
    const perms = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(perms).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
  };

  // ── Local buffer helpers ──────────────────────────────────────────────────
  const isInBuffer = async (checkUid: string, sessionId: string): Promise<boolean> => {
    try {
      const raw = await AsyncStorage.getItem(BUFFER_KEY);
      const buf: string[] = raw ? JSON.parse(raw) : [];
      return buf.includes(`${checkUid}::${sessionId}`);
    } catch { return false; }
  };

  const addToBuffer = async (checkUid: string, sessionId: string) => {
    try {
      const raw = await AsyncStorage.getItem(BUFFER_KEY);
      let buf: string[] = raw ? JSON.parse(raw) : [];
      const key = `${checkUid}::${sessionId}`;
      if (!buf.includes(key)) {
        buf.push(key);
        // Rolling window — drop oldest half when full
        if (buf.length > BUFFER_SIZE) buf = buf.slice(Math.floor(BUFFER_SIZE / 2));
        await AsyncStorage.setItem(BUFFER_KEY, JSON.stringify(buf));
      }
    } catch {}
  };

  // ── BLE helpers ───────────────────────────────────────────────────────────
  const stopScan = () => {
    if (scanning.current) {
      bleManager.stopDeviceScan();
      scanning.current = false;
    }
    connectedDevice.current?.cancelConnection().catch(() => {});
    connectedDevice.current = null;
  };

  const resumeScanAfterDelay = (currentUid: string, reason: "no_session" | "error") => {
    if (!mounted.current) return;

    if (reason === "error") {
      errorRetryCount.current += 1;
      if (errorRetryCount.current >= MAX_ERROR_RETRIES) {
        safe(() => {
          setPhase("error");
          setStatusMsg("Device couldn't reach the server after several attempts. Check the device's WiFi.");
        });
        return;
      }
    } else {
      // no_session is not a hard error — reset error counter
      errorRetryCount.current = 0;
    }

    setTimeout(async () => {
      if (!mounted.current) return;
      stopScan();
      markingLock.current = false;
      safe(() => {
        setPhase("scanning");
        setStatusMsg(
          reason === "no_session"
            ? "Waiting for session to start… retrying."
            : `Retrying after error… (${errorRetryCount.current}/${MAX_ERROR_RETRIES})`
        );
      });
      await startScanning(currentUid);
    }, RETRY_SCAN_DELAY);
  };

  // ── Main scan loop ────────────────────────────────────────────────────────
  const startScanning = async (scanUid: string) => {
    const ok = await requestBlePerms();
    if (!ok) { safe(() => setPhase("perm_required")); return; }

    // Guard against duplicate scan calls
    if (scanning.current) return;

    safe(() => { setPhase("scanning"); setStatusMsg("Looking for PresenceMarker device…"); });
    scanning.current = true;

    bleManager.startDeviceScan(
      null,
      { allowDuplicates: true },
      async (err, device) => {
        if (!mounted.current) return;
        if (err) {
          console.warn("[BLE] Scan error:", err.message);
          safe(() => { setPhase("error"); setStatusMsg("Bluetooth scan failed. Make sure Bluetooth is on."); });
          scanning.current = false;
          return;
        }
        if (!device) return;

        const name = device.name || device.localName || "";
        if (name !== BLE_DEVICE_NAME) return;

        const currentRssi = device.rssi ?? -100;
        safe(() => setRssi(currentRssi));

        // Too far — show signal feedback but keep scanning
        if (currentRssi < RSSI_THRESHOLD) {
          safe(() => setPhase("too_far"));
          return;
        }

        // Already locked — another mark attempt in progress
        if (markingLock.current) return;
        markingLock.current = true;

        bleManager.stopDeviceScan();
        scanning.current = false;

        safe(() => { setPhase("connecting"); setStatusMsg("In range — marking attendance…"); });

        // ── FIX: directly call markAttendance here, no premature buffer check ──
        await markAttendance(device, scanUid);
      }
    );
  };

  // ── BLE connect → write UID → wait for notify ────────────────────────────
  const markAttendance = async (device: Device, markUid: string) => {
    try {
      connectedDevice.current = await device.connect({ timeout: 10000 });
      await connectedDevice.current.discoverAllServicesAndCharacteristics();

      let resolved = false;

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          if (!resolved) reject(new Error("notify_timeout"));
        }, 12000);

        // Subscribe FIRST, then write after a short settle delay
        const sub = connectedDevice.current!.monitorCharacteristicForService(
          SERVICE_UUID,
          STUDENT_CHAR_UUID,
          async (notifyErr, char) => {
            if (notifyErr) {
              console.warn("[BLE] Notify error:", notifyErr?.message);
              if (resolved) return; // already done — ignore disconnect noise
              clearTimeout(t);
              reject(new Error("notify_cancelled"));
              return;
            }

            if (!char?.value || resolved) return;
            resolved = true;
            clearTimeout(t);

            try { sub?.remove(); } catch {}

            // Decode base64 → UTF-8
            const val = Buffer.from(char.value, "base64").toString("utf-8").trim();

            connectedDevice.current?.cancelConnection().catch(() => {});
            connectedDevice.current = null;

            // ── FIX: ESP32 sends "OK:<attendanceSessionId>" ──────────────────
            if (val.startsWith("OK")) {
              // Extract the session ID from "OK:abc123" or fall back to today's date
              const sessionKey = val.includes(":") ? val.split(":")[1] : new Date().toISOString().slice(0, 10);

              // Write to local buffer so we don't re-mark without a session change
              await addToBuffer(markUid, sessionKey);

              Vibration.vibrate([0, 100, 60, 100]);
              safe(() => { setPhase("success"); setStatusMsg("Attendance marked successfully!"); });
              markingLock.current = false;

            } else if (val === "ALREADY") {
              // Server already has this student marked — use today's date as key
              // (we don't get the session ID back in ALREADY response)
              const sessionKey = new Date().toISOString().slice(0, 10);
              await addToBuffer(markUid, sessionKey);

              Vibration.vibrate(60);
              safe(() => { setPhase("already"); setStatusMsg("Your attendance was already marked for this session."); });
              markingLock.current = false;

            } else if (val === "NO_SESSION") {
              safe(() => {
                setPhase("no_session");
                setStatusMsg("No active session — teacher hasn't started yet. Retrying in 4s…");
              });
              resumeScanAfterDelay(markUid, "no_session");

            } else if (val === "ERR") {
              safe(() => {
                setPhase("error");
                setStatusMsg("Device couldn't reach the server. Check the device's WiFi. Retrying in 4s…");
              });
              resumeScanAfterDelay(markUid, "error");

            } else {
              // Unexpected response
              safe(() => { setPhase("error"); setStatusMsg(`Unexpected response from device: "${val}"`); });
              markingLock.current = false;
            }

            resolve();
          }
        );

        // 400ms settle — ensures subscription is registered before write goes out
        setTimeout(() => {
          if (resolved) return;
          const encoded = Buffer.from(markUid, "utf-8").toString("base64");
          connectedDevice.current!
            .writeCharacteristicWithResponseForService(SERVICE_UUID, STUDENT_CHAR_UUID, encoded)
            .catch((e) => { clearTimeout(t); reject(e); });
        }, 400);
      });

    } catch (e: any) {
      connectedDevice.current?.cancelConnection().catch(() => {});
      connectedDevice.current = null;
      markingLock.current = false;

      const msg =
        e?.message === "notify_timeout"   ? "Device did not respond in time. Try again." :
        e?.message === "notify_cancelled" ? "Connection dropped before response. Move closer and try again." :
        "Could not connect to device. Make sure you are close enough.";

      safe(() => { setPhase("error"); setStatusMsg(msg); });
    }
  };

  // ── Retry handler ─────────────────────────────────────────────────────────
  const handleRetry = async () => {
    markingLock.current   = false;
    errorRetryCount.current = 0;
    stopScan();
    if (uid) await startScanning(uid);
    else await loadUidAndStart();
  };

  // ── Render helpers ────────────────────────────────────────────────────────
  const renderIcon = () => {
    switch (phase) {
      case "scanning":      return { name: "bluetooth",             bg: PRIMARY_LT, color: PRIMARY };
      case "too_far":       return { name: "wifi-outline",          bg: WARNING_LT, color: WARNING };
      case "connecting":    return { name: "link-outline",          bg: PRIMARY_LT, color: PRIMARY };
      case "success":       return { name: "checkmark-circle",      bg: SUCCESS_LT, color: SUCCESS };
      case "already":       return { name: "checkmark-done-circle", bg: WARNING_LT, color: WARNING };
      case "error":         return { name: "close-circle",          bg: ERROR_LT,   color: ERROR   };
      case "no_session":    return { name: "time-outline",          bg: WARNING_LT, color: WARNING };
      case "perm_required": return { name: "lock-closed-outline",   bg: ERROR_LT,   color: ERROR   };
      default:              return { name: "hourglass-outline",     bg: PRIMARY_LT, color: PRIMARY };
    }
  };

  const renderTitle = () => {
    switch (phase) {
      case "init":          return "Loading…";
      case "perm_required": return "Permission Required";
      case "scanning":      return "Scanning for Device";
      case "too_far":       return "Move Closer";
      case "connecting":    return "Marking Attendance…";
      case "success":       return "Attendance Marked!";
      case "already":       return "Already Marked";
      case "no_session":    return "No Active Session";
      case "error":         return "Something Went Wrong";
    }
  };

  const renderSub = () => {
    switch (phase) {
      case "perm_required": return "Bluetooth permission is required to detect the attendance device.";
      case "scanning":      return statusMsg || "Walk close to the PresenceMarker device to mark your attendance.";
      case "too_far":       return rssi ? `Signal: ${rssi} dBm — move closer to the device.` : "Move closer to the device.";
      case "connecting":    return "You're in range. Sending your attendance to the device…";
      case "success":       return "Your attendance has been recorded for this session.";
      case "already":       return "Your attendance was already marked for this session.";
      case "no_session":    return statusMsg || "The teacher has not started an attendance session yet.";
      case "error":         return statusMsg || "An error occurred. Please try again.";
      default:              return statusMsg;
    }
  };

  const icon      = renderIcon();
  const showPulse = phase === "scanning" || phase === "connecting" || phase === "too_far";
  const showRetry = phase === "error" || phase === "perm_required";
  const showDone  = phase === "success" || phase === "already";

  const rssiPercent = rssi !== null ? Math.min(100, Math.max(0, ((rssi + 100) / 60) * 100)) : 0;
  const rssiColor   = rssi !== null && rssi >= RSSI_THRESHOLD ? SUCCESS : ERROR;

  // ── UI ────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={st.safe}>
      <View style={st.header}>
        <TouchableOpacity style={st.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={22} color={INK} />
        </TouchableOpacity>
        <Text style={st.headerTitle}>IoT Attendance</Text>
        <View style={{ width: 40 }} />
      </View>

      <Animated.View style={[st.body, { opacity: fadeAnim }]}>
        {/* Icon / spinner */}
        <View style={st.iconWrap}>
          {showPulse && (
            <Animated.View
              style={[st.pulsRing, { borderColor: icon.color, transform: [{ scale: pulseAnim }] }]}
            />
          )}
          <View style={[st.iconCircle, { backgroundColor: icon.bg }]}>
            {phase === "init" || phase === "connecting"
              ? <ActivityIndicator size="large" color={icon.color} />
              : <Ionicons name={icon.name as any} size={48} color={icon.color} />
            }
          </View>
        </View>

        <Text style={st.title}>{renderTitle()}</Text>
        <Text style={st.sub}>{renderSub()}</Text>

        {/* RSSI signal bar — visible while scanning or too far */}
        {(phase === "scanning" || phase === "too_far") && rssi !== null && (
          <View style={st.rssiCard}>
            <View style={st.rssiRow}>
              <Ionicons name="radio-outline" size={16} color={MUTED} />
              <Text style={st.rssiLabel}>Signal Strength</Text>
              <Text style={[st.rssiValue, { color: rssiColor }]}>{rssi} dBm</Text>
            </View>
            <View style={st.rssiTrack}>
              <View style={[st.rssiBar, { width: `${rssiPercent}%` as any, backgroundColor: rssiColor }]} />
            </View>
            <Text style={st.rssiHint}>
              {rssi >= RSSI_THRESHOLD ? "✓ Close enough — marking…" : "Move closer to the device"}
            </Text>
          </View>
        )}

        {/* Status pills */}
        {phase === "scanning" && (
          <View style={st.pill}>
            <View style={[st.pillDot, { backgroundColor: PRIMARY }]} />
            <Text style={[st.pillText, { color: PRIMARY }]}>SCANNING</Text>
          </View>
        )}
        {phase === "no_session" && (
          <View style={[st.pill, { backgroundColor: WARNING_LT }]}>
            <View style={[st.pillDot, { backgroundColor: WARNING }]} />
            <Text style={[st.pillText, { color: WARNING }]}>WAITING FOR TEACHER</Text>
          </View>
        )}
        {phase === "success" && (
          <View style={[st.pill, { backgroundColor: SUCCESS_LT }]}>
            <View style={[st.pillDot, { backgroundColor: SUCCESS }]} />
            <Text style={[st.pillText, { color: SUCCESS }]}>MARKED PRESENT</Text>
          </View>
        )}
        {phase === "already" && (
          <View style={[st.pill, { backgroundColor: WARNING_LT }]}>
            <Ionicons name="checkmark-done" size={14} color={WARNING} />
            <Text style={[st.pillText, { color: WARNING }]}>ALREADY RECORDED</Text>
          </View>
        )}

        {/* Action buttons */}
        {showRetry && (
          <TouchableOpacity style={st.btnPrimary} onPress={handleRetry}>
            <Ionicons name="refresh-outline" size={20} color="#fff" />
            <Text style={st.btnPrimaryText}>
              {phase === "perm_required" ? "Grant Permission" : "Try Again"}
            </Text>
          </TouchableOpacity>
        )}
        {showDone && (
          <TouchableOpacity style={st.btnOutline} onPress={() => navigation.goBack()}>
            <Text style={st.btnOutlineText}>Go Back</Text>
          </TouchableOpacity>
        )}
      </Animated.View>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const st = StyleSheet.create({
  safe:           { flex: 1, backgroundColor: BG },
  header:         { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 14, backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: BORDER },
  backBtn:        { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle:    { fontSize: 17, fontWeight: "700", color: INK },
  body:           { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 16 },
  iconWrap:       { position: "relative", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  pulsRing:       { position: "absolute", width: 120, height: 120, borderRadius: 60, borderWidth: 2, opacity: 0.4 },
  iconCircle:     { width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center" },
  title:          { fontSize: 24, fontWeight: "800", color: INK, textAlign: "center" },
  sub:            { fontSize: 15, color: MUTED, textAlign: "center", lineHeight: 22, marginBottom: 4 },
  rssiCard:       { width: "100%", backgroundColor: CARD, borderRadius: 16, padding: 16, gap: 8, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, elevation: 2 },
  rssiRow:        { flexDirection: "row", alignItems: "center", gap: 6 },
  rssiLabel:      { flex: 1, fontSize: 13, color: MUTED, fontWeight: "500" },
  rssiValue:      { fontSize: 13, fontWeight: "700" },
  rssiTrack:      { height: 6, backgroundColor: BORDER, borderRadius: 3, overflow: "hidden" },
  rssiBar:        { height: 6, borderRadius: 3 },
  rssiHint:       { fontSize: 12, color: MUTED, textAlign: "center" },
  pill:           { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: PRIMARY_LT, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  pillDot:        { width: 7, height: 7, borderRadius: 4 },
  pillText:       { fontSize: 12, fontWeight: "800", letterSpacing: 1.2 },
  btnPrimary:     { width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: PRIMARY, borderRadius: 14, height: 52, shadowColor: PRIMARY, shadowOpacity: 0.2, shadowRadius: 12, elevation: 4 },
  btnPrimaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  btnOutline:     { width: "100%", alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: BORDER, borderRadius: 14, height: 50 },
  btnOutlineText: { fontSize: 15, fontWeight: "600", color: MUTED },
});