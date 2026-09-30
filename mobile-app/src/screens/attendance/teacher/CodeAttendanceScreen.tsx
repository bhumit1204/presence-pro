import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  NativeModules,
  Alert,
  Linking,
} from "react-native";
import { useRoute, useNavigation } from "@react-navigation/native";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { db } from "../../../services/firebase";
import BleManager from "react-native-ble-manager";
import WifiManager from "react-native-wifi-reborn";

// ─── Native BLE Advertiser (BleAdvertiserModule.java) ────────────────────────
// NativeModules.BleAdvertiser is our own small Java module that calls
// Android's BluetoothLeAdvertiser directly.  No third-party library needed.
const { BleAdvertiser } = NativeModules as {
  BleAdvertiser: {
    startAdvertising(serviceUUID: string): Promise<string>;
    stopAdvertising(): Promise<string>;
    isAdvertising(): Promise<boolean>;
  } | undefined;
};

// ─── BLE Service UUID broadcast by teacher ────────────────────────────────────
export const BLE_SERVICE_UUID = "12345678-1234-1234-1234-123456789abc";

const PRIMARY = "#4834D4";
const SUCCESS = "#2ECC71";
const DANGER  = "#FF4757";

// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

// Module-level flag — BleManager.start() only needs to run once per app session
let bleStarted = false;

async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;

  if (Platform.Version >= 31) {
    const grants = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);

    const allGranted = Object.values(grants).every(
      (r) => r === PermissionsAndroid.RESULTS.GRANTED
    );

    if (!allGranted) {
      console.log("[BLE] Permissions denied →", grants);

      // Check if any permission is permanently denied (never_ask_again)
      const permanentlyDenied = Object.entries(grants).some(
        ([, result]) => result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
      );

      if (permanentlyDenied) {
        // Can't prompt anymore — send user to Settings
        Alert.alert(
          "Bluetooth Permission Required",
          "Nearby Devices (Bluetooth Advertise) permission was denied. Please enable it in Settings → Apps → PresencePro → Permissions.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => Linking.openSettings(),
            },
          ]
        );
      }
    }

    return allGranted;
  } else {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title: "Location Permission",
        message: "Bluetooth Low Energy requires location access.",
        buttonPositive: "Allow",
      }
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  }
}

export default function CodeAttendanceScreen() {
  const route      = useRoute<any>();
  const navigation = useNavigation<any>();
  const { lectureSessionId } = route.params;

  const [attendanceCode, setAttendanceCode]           = useState<string | null>(null);
  const [attendanceSessionId, setAttendanceSessionId] = useState<string | null>(null);
  const [presentStudents, setPresentStudents]         = useState<any[]>([]);
  const [loading, setLoading]                         = useState(true);
  const [closing, setClosing]                         = useState(false);
  const [wifiStatus, setWifiStatus]                   = useState<"scanning" | "done" | "error">("scanning");
  const [bleStatus, setBleStatus]                     = useState<"starting" | "on" | "error">("starting");
  const [teacherNetworks, setTeacherNetworks]         = useState<any[]>([]);

  const bleStatusRef       = useRef<"starting" | "on" | "error">("starting");
  const teacherNetworksRef = useRef<any[]>([]);
  const isAdvertisingRef   = useRef(false);

  const updateBleStatus = (s: "starting" | "on" | "error") => {
    bleStatusRef.current = s;
    setBleStatus(s);
  };

  // ── Boot ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    scanTeacherWifi();
    startBleAdvertising();
    return () => {
      stopBleAdvertising();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Start attendance after WiFi resolves ─────────────────────────────────────
  useEffect(() => {
    if (wifiStatus === "done" || wifiStatus === "error") {
      startAttendance(teacherNetworksRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wifiStatus]);

  // ── Live roster via Firestore ────────────────────────────────────────────────
  useEffect(() => {
    if (!attendanceSessionId) return;
    const q = query(
      collection(db, "attendance_records"),
      where("attendance_session_id", "==", attendanceSessionId)
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const list = snapshot.docs.map((doc) => {
        const d = doc.data();
        return { uid: d.student_uid, name: d.student_name, roll: d.student_roll };
      });
      setPresentStudents(list);
    });
    return () => unsub();
  }, [attendanceSessionId]);

  // ── WiFi scan ────────────────────────────────────────────────────────────────
  const scanTeacherWifi = async () => {
    try {
      const nets: any[] = await WifiManager.loadWifiList();
      const parsed = (nets || []).map((n) => ({
        ssid:  n.SSID  || "",
        bssid: n.BSSID || "",
        rssi:  n.level ?? n.RSSI ?? -100,
      }));
      const top10 = parsed.sort((a: any, b: any) => b.rssi - a.rssi).slice(0, 10);
      teacherNetworksRef.current = top10;
      setTeacherNetworks(top10);
      setWifiStatus("done");
    } catch (e) {
      console.log("[WiFi] Scan skipped:", e);
      teacherNetworksRef.current = [];
      setTeacherNetworks([]);
      setWifiStatus("error");
    }
  };

  // ── BLE advertising via NativeModules.BleAdvertiser ──────────────────────────
  // react-native-ble-manager is a SCANNING library only — it has no advertise API.
  // We use our own thin Java native module (BleAdvertiserModule.java) which calls
  // Android's BluetoothLeAdvertiser directly.
  const startBleAdvertising = async () => {
    try {
      if (!BleAdvertiser) {
        // Module not found — app hasn't been rebuilt after adding the Java files
        console.log("[BLE] BleAdvertiser native module not registered. Rebuild the app.");
        updateBleStatus("error");
        return;
      }

      const granted = await requestBlePermissions();
      if (!granted) {
        updateBleStatus("error");
        return;
      }

      // Keep BleManager initialised for scanning used elsewhere in the app
      if (!bleStarted) {
        await BleManager.start({ showAlert: false });
        bleStarted = true;
      }

      if (bleStatusRef.current === "on") return; // guard double-call

      const result = await BleAdvertiser.startAdvertising(BLE_SERVICE_UUID);

      isAdvertisingRef.current = true;
      updateBleStatus("on");

    } catch (e: any) {
      updateBleStatus("error");
    }
  };

  const stopBleAdvertising = () => {
    if (!isAdvertisingRef.current || !BleAdvertiser) return;
    BleAdvertiser.stopAdvertising()
      .then(() => {
        isAdvertisingRef.current = false;
      })
      .catch((e: any) => {
        console.log("[BLE] stopAdvertising error (non-fatal):", e);
      });
  };

  // ── POST /attendance/start ───────────────────────────────────────────────────
  const startAttendance = async (networks: any[]) => {
    try {
      const res = await fetch(`${API_URL}/api/lectures/attendance/start`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lecture_session_id: lectureSessionId,
          marking_method:     "code",
          teacher_wifi_scan:  networks,
          ble_service_uuid:   BLE_SERVICE_UUID,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setAttendanceSessionId(data.attendance_session_id);
        const code = data.attendance_code;
        if (code) {
          setAttendanceCode(code);
        } else {
          console.warn("[Attendance] success but no attendance_code in response");
          setAttendanceCode("ERR");
        }
      } else {
        setAttendanceCode("ERR");
      }
    } catch (e) {
      setAttendanceCode("ERR");
    } finally {
      setLoading(false);
    }
  };

  // ── Close attendance + navigate ──────────────────────────────────────────────
  const handleContinue = async () => {
    if (closing) return;
    try {
      setClosing(true);
      stopBleAdvertising();
      const res = await fetch(`${API_URL}/api/lectures/attendance/close`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lecture_session_id: lectureSessionId }),
      });
      const data = await res.json();
      if (!data.success) { setClosing(false); return; }
      navigation.navigate("ManualMarkingScreen", {
        attendance_session_id: attendanceSessionId,
        lecture_session_id:    lectureSessionId,
      });
    } catch (e) {
      console.log("[Close] error:", e);
      setClosing(false);
    }
  };

  // ── Loading state ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator size="large" color={PRIMARY} />
        <Text style={styles.loaderText}>
          {wifiStatus === "scanning" ? "Scanning room WiFi…" : "Starting attendance…"}
        </Text>
      </View>
    );
  }

  // ── Main UI ──────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>

      <Text style={styles.title}>Code Attendance</Text>

      {/* Signal status pills */}
      <View style={styles.pillRow}>
        <View style={[styles.pill, wifiStatus === "done" ? styles.pillGreen : styles.pillAmber]}>
          <Text style={styles.pillText}>
            {wifiStatus === "done"
              ? `📶 WiFi ✓ · ${teacherNetworks.length} nets`
              : wifiStatus === "error" ? "📶 WiFi off (optional)" : "📶 Scanning…"}
          </Text>
        </View>
        <View style={[
          styles.pill,
          bleStatus === "on"    ? styles.pillGreen :
          bleStatus === "error" ? styles.pillRed   : styles.pillAmber,
        ]}>
          <Text style={styles.pillText}>
            {bleStatus === "on"    ? "🔵 BLE broadcasting" :
             bleStatus === "error" ? "🔵 BLE unavailable ⚠️" :
                                     "🔵 BLE starting…"}
          </Text>
        </View>
      </View>

      {/* Attendance code card */}
      <View style={styles.codeContainer}>
        <Text style={styles.codeLabel}>Attendance Code</Text>
        {attendanceCode === null ? (
          <ActivityIndicator size="large" color={PRIMARY} style={{ marginVertical: 14 }} />
        ) : (
          <Text style={[
            styles.codeValue,
            attendanceCode === "ERR" && { color: DANGER, fontSize: 24 },
          ]}>
            {attendanceCode === "ERR" ? "Failed to load code" : attendanceCode}
          </Text>
        )}
        <Text style={styles.codeHint}>
          Students must select this code AND be physically present in the room
        </Text>
      </View>

      {/* Attendance roster */}
      <View style={styles.rosterContainer}>
        <View style={styles.rosterHeader}>
          <Text style={styles.rosterTitle}>Attendance Roster</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{presentStudents.length}</Text>
          </View>
        </View>
        <FlatList
          data={presentStudents}
          keyExtractor={(item) => item.uid}
          renderItem={({ item }) => (
            <View style={styles.studentRow}>
              <Text style={styles.studentName}>{item.name}</Text>
              <Text style={styles.studentRoll}>{item.roll}</Text>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No students marked attendance yet</Text>
          }
        />
      </View>

      <TouchableOpacity
        style={styles.continueButton}
        onPress={handleContinue}
        disabled={closing}
      >
        <Text style={styles.closeButtonText}>
          {closing ? "Please wait…" : "Continue"}
        </Text>
      </TouchableOpacity>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: "#F8FAFC",
    paddingHorizontal: 20, paddingTop: 50,
  },
  title: {
    fontSize: 28, fontWeight: "800", color: "#111827",
    marginBottom: 14, letterSpacing: 0.3,
  },
  loader:     { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#F8FAFC" },
  loaderText: { marginTop: 12, color: "#666", fontSize: 14 },

  pillRow:   { flexDirection: "row", gap: 8, marginBottom: 14 },
  pill:      { flex: 1, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 20, alignItems: "center" },
  pillGreen: { backgroundColor: "#D1FAE5" },
  pillAmber: { backgroundColor: "#FEF3C7" },
  pillRed:   { backgroundColor: "#FEE2E2" },
  pillText:  { fontSize: 11, fontWeight: "600", color: "#111" },

  codeContainer: {
    backgroundColor: "#FFFFFF", paddingVertical: 28,
    borderRadius: 22, alignItems: "center", marginBottom: 16,
    borderWidth: 1, borderColor: "#EEF2F7",
    shadowColor: "#6366F1", shadowOpacity: 0.12,
    shadowOffset: { width: 0, height: 10 }, shadowRadius: 20, elevation: 6,
  },
  codeLabel: {
    fontSize: 13, color: "#6B7280", fontWeight: "600",
    marginBottom: 10, textTransform: "uppercase", letterSpacing: 1,
  },
  codeValue: {
    fontSize: 64, fontWeight: "900", color: PRIMARY, letterSpacing: 10,
  },
  codeHint: {
    marginTop: 12, fontSize: 12, color: "#9CA3AF",
    textAlign: "center", paddingHorizontal: 30, lineHeight: 18,
  },

  rosterContainer: {
    flex: 1, backgroundColor: "#FFFFFF", borderRadius: 20,
    padding: 18, borderWidth: 1, borderColor: "#EEF2F7",
  },
  rosterHeader: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 14,
  },
  rosterTitle: { fontSize: 18, fontWeight: "800", color: "#111827" },
  countBadge:  { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 },
  countText:   { color: SUCCESS, fontWeight: "800", fontSize: 14 },

  studentRow: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: "#F1F5F9",
  },
  studentName: { fontSize: 16, fontWeight: "600", color: "#1F2937" },
  studentRoll: {
    fontSize: 13, fontWeight: "700", color: "#6B7280",
    backgroundColor: "#F3F4F6", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8,
  },
  emptyText: {
    textAlign: "center", marginTop: 40, color: "#9CA3AF",
    fontSize: 14, fontWeight: "500",
  },

  continueButton: {
    marginTop: 22, backgroundColor: PRIMARY,
    paddingVertical: 16, borderRadius: 16, marginBottom: 30,
    alignItems: "center",
    shadowColor: PRIMARY, shadowOpacity: 0.25,
    shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  closeButtonText: { color: "#FFF", fontWeight: "800", fontSize: 16, letterSpacing: 0.4 },
});