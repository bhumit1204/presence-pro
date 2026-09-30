import React, { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from "react-native";
import { useRoute, useNavigation } from "@react-navigation/native";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { db } from "../../../services/firebase";
import BleManager from "react-native-ble-manager";
import WifiManager from "react-native-wifi-reborn";

const { BleAdvertiser } = NativeModules as {
  BleAdvertiser: {
    startAdvertising(serviceUUID: string): Promise<string>;
    stopAdvertising(): Promise<string>;
    isAdvertising(): Promise<boolean>;
  } | undefined;
};

// ─── BLE Service UUID broadcast by teacher ───────────────────────────────────
export const BLE_SERVICE_UUID = "12345678-1234-1234-1234-123456789abc";

// ─── RSSI threshold — students above this value (weaker signal) are blocked ──
const RSSI_THRESHOLD = -90;

const PRIMARY = "#4834D4";
const BG      = "#F3F4F6";
const SUCCESS = "#2ECC71";
const WARNING = "#F59E0B";
const DANGER  = "#EF4444";

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
    if (!allGranted) console.log("[BLE] Permissions denied →", grants);
    return allGranted;
  } else {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title:          "Location Permission",
        message:        "Bluetooth Low Energy requires location access.",
        buttonPositive: "Allow",
      }
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  }
}

// ─── Certainty tier based on RSSI ────────────────────────────────────────────
// GREEN  : RSSI ≥ -60        → very close, auto-approve
// AMBER  : -60 > RSSI ≥ -75  → moderate, likely present
// RED    : -75 > RSSI ≥ -90  → borderline, teacher should verify
// (anything above -90 i.e. weaker is rejected on the student side)
type Certainty = "high" | "medium" | "low";

function getRssiCertainty(rssi: number | null | undefined): Certainty {
  if (rssi == null) return "low";
  if (rssi >= -60)  return "high";
  if (rssi >= -75)  return "medium";
  return "low";
}

const CERTAINTY_CONFIG: Record<Certainty, { label: string; color: string; bg: string; needsVerify: boolean }> = {
  high:   { label: "Confirmed",   color: SUCCESS, bg: "#D1FAE5", needsVerify: false },
  medium: { label: "Likely",      color: WARNING, bg: "#FEF3C7", needsVerify: false },
  low:    { label: "Verify",      color: DANGER,  bg: "#FEE2E2", needsVerify: true  },
};

interface StudentRecord {
  uid:      string;
  name:     string;
  roll:     string;
  ble_rssi: number | null;
}

export default function BioGeoAttendanceScreen() {
  const route      = useRoute<any>();
  const navigation = useNavigation<any>();
  const { lectureSessionId } = route.params;

  const [attendanceSessionId, setAttendanceSessionId] = useState<string | null>(null);
  const [presentStudents, setPresentStudents]         = useState<StudentRecord[]>([]);
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

  // ── Boot ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    scanTeacherWifi();
    startBleAdvertising();
    return () => {
      stopBleAdvertising();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Start attendance once WiFi resolves (either way) ─────────────────────────
  useEffect(() => {
    if (wifiStatus === "done" || wifiStatus === "error") {
      startAttendance(teacherNetworksRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wifiStatus]);

  // ── Live roster via Firestore ─────────────────────────────────────────────────
  // Reads ble_rssi from each record so teacher can see certainty tiers.
  useEffect(() => {
    if (!attendanceSessionId) return;
    const q = query(
      collection(db, "attendance_records"),
      where("attendance_session_id", "==", attendanceSessionId),
      where("status", "==", "present")
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const list: StudentRecord[] = snapshot.docs.map((doc) => {
        const d = doc.data();
        return {
          uid:      d.student_uid,
          name:     d.student_name || "Student",
          roll:     d.student_roll || "-",
          ble_rssi: d.ble_rssi ?? null,
        };
      });
      // Sort: students needing verification first, then by RSSI descending
      list.sort((a, b) => {
        const ca = getRssiCertainty(a.ble_rssi);
        const cb = getRssiCertainty(b.ble_rssi);
        const order: Record<Certainty, number> = { low: 0, medium: 1, high: 2 };
        if (order[ca] !== order[cb]) return order[ca] - order[cb];
        return (b.ble_rssi ?? -100) - (a.ble_rssi ?? -100);
      });
      setPresentStudents(list);
    });
    return () => unsub();
  }, [attendanceSessionId]);

  // ── WiFi scan ─────────────────────────────────────────────────────────────────
  const scanTeacherWifi = async () => {
    try {
      const nets: any[] = await WifiManager.loadWifiList();
      const parsed = (nets || []).map((n) => ({
        ssid:  n.SSID  || "",
        bssid: n.BSSID || "",
        rssi:  n.level ?? n.RSSI ?? -100,
      }));
      const top10 = parsed.sort((a, b) => b.rssi - a.rssi).slice(0, 10);
      teacherNetworksRef.current = top10;
      setTeacherNetworks(top10);
      setWifiStatus("done");
    } catch (e) {
      teacherNetworksRef.current = [];
      setTeacherNetworks([]);
      setWifiStatus("error");
    }
  };

  // ── BLE advertising via NativeModules.BleAdvertiser ──────────────────────────
  // FIXED: switched from react-native-ble-advertiser (unreliable, stuck on
  // "starting") to NativeModules.BleAdvertiser — the same Java native module
  // used by CodeAttendanceScreen, which works reliably on New Architecture.
  const startBleAdvertising = async () => {
    try {
      if (!BleAdvertiser) {
        updateBleStatus("error");
        return;
      }

      const granted = await requestBlePermissions();
      if (!granted) {
        updateBleStatus("error");
        return;
      }

      // Keep BleManager initialised for any scan calls elsewhere in the app
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

  // ── POST /attendance/start ────────────────────────────────────────────────────
  const startAttendance = async (networks: any[]) => {
    try {
      const res = await fetch(`${API_URL}/api/lectures/attendance/start`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lecture_session_id: lectureSessionId,
          marking_method:     "bio_wifi_ble",
          teacher_wifi_scan:  networks,
          ble_service_uuid:   BLE_SERVICE_UUID,
          rssi_threshold:     RSSI_THRESHOLD,   // inform backend of client-side threshold
        }),
      });
      const data = await res.json();
      if (data.success) {
        setAttendanceSessionId(data.attendance_session_id);
      } else {
        console.log("[Attendance] start failed:", data);
      }
    } catch (e) {
      console.log("[Attendance] start error:", e);
    } finally {
      setLoading(false);
    }
  };

  // ── Close attendance + navigate ───────────────────────────────────────────────
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
      if (!data.success) {
        setClosing(false);
        return;
      }

      navigation.navigate("ManualMarkingScreen", {
        attendance_session_id: attendanceSessionId,
        lecture_session_id:    lectureSessionId,
      });
    } catch (e) {
      console.log("[Close] error:", e);
      setClosing(false);
    }
  };

  // ── Derived counts ────────────────────────────────────────────────────────────
  const needsVerifyCount = presentStudents.filter(
    (s) => getRssiCertainty(s.ble_rssi) === "low"
  ).length;

  // ── Loading state ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator size="large" color={PRIMARY} />
        <Text style={styles.loadingText}>
          {wifiStatus === "scanning" ? "Scanning room WiFi…" : "Starting attendance…"}
        </Text>
      </View>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>

      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Biometric Attendance</Text>
          <Text style={styles.subtitle}>BLE · WiFi · Fingerprint</Text>
        </View>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>T</Text>
        </View>
      </View>

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

      {/* Roster card */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View>
            <Text style={styles.cardTitle}>Attendance Roster</Text>
            <Text style={styles.cardSub}>
              Students verify with biometric + BLE + WiFi
            </Text>
          </View>
          <View style={styles.countBubble}>
            <Text style={styles.countNumber}>{presentStudents.length}</Text>
            <Text style={styles.countLabel}>present</Text>
          </View>
        </View>

        {/* Certainty legend */}
        <View style={styles.legendRow}>
          {(["high", "medium", "low"] as Certainty[]).map((tier) => {
            const cfg = CERTAINTY_CONFIG[tier];
            const count = presentStudents.filter(
              (s) => getRssiCertainty(s.ble_rssi) === tier
            ).length;
            return (
              <View key={tier} style={[styles.legendPill, { backgroundColor: cfg.bg }]}>
                <Text style={[styles.legendText, { color: cfg.color }]}>
                  {cfg.label} · {count}
                </Text>
              </View>
            );
          })}
        </View>

        {/* Verify reminder */}
        {needsVerifyCount > 0 && (
          <View style={styles.verifyBanner}>
            <Text style={styles.verifyBannerText}>
              ⚠️  {needsVerifyCount} student{needsVerifyCount > 1 ? "s" : ""} need manual verification
            </Text>
          </View>
        )}

        <FlatList
          data={presentStudents}
          keyExtractor={(item) => item.uid}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 12 }}
          renderItem={({ item }) => {
            const certainty = getRssiCertainty(item.ble_rssi);
            const cfg       = CERTAINTY_CONFIG[certainty];
            return (
              <View style={styles.studentRow}>
                <View style={styles.studentInfo}>
                  <Text style={styles.studentName}>{item.name}</Text>
                  <Text style={styles.studentRoll}>{item.roll}</Text>
                </View>
                <View style={styles.studentRight}>
                  {/* RSSI value (small, grey) */}
                  {item.ble_rssi != null && (
                    <Text style={styles.rssiValue}>{item.ble_rssi} dBm</Text>
                  )}
                  {/* Certainty badge */}
                  <View style={[styles.certaintyBadge, { backgroundColor: cfg.bg }]}>
                    <Text style={[styles.certaintyText, { color: cfg.color }]}>
                      {cfg.label}
                    </Text>
                  </View>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No students marked yet</Text>
          }
        />
      </View>

      <TouchableOpacity
        style={styles.continueButton}
        onPress={handleContinue}
        disabled={closing}
      >
        <Text style={styles.continueText}>
          {closing ? "Closing…" : "Continue"}
        </Text>
      </TouchableOpacity>

    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: BG, padding: 16 },
  loader:      { flex: 1, justifyContent: "center", alignItems: "center" },
  loadingText: { marginTop: 12, color: "#666", fontSize: 14 },

  header: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 12, marginTop: 40,
  },
  title:    { fontSize: 22, fontWeight: "bold", color: "#111" },
  subtitle: { color: "#666", marginTop: 2 },

  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: PRIMARY, justifyContent: "center", alignItems: "center",
  },
  avatarText: { color: "#fff", fontWeight: "bold" },

  pillRow:   { flexDirection: "row", gap: 8, marginBottom: 12 },
  pill:      { flex: 1, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 20, alignItems: "center" },
  pillGreen: { backgroundColor: "#D1FAE5" },
  pillAmber: { backgroundColor: "#FEF3C7" },
  pillRed:   { backgroundColor: "#FEE2E2" },
  pillText:  { fontSize: 11, fontWeight: "600", color: "#111" },

  card: {
    flex: 1, backgroundColor: "#fff", borderRadius: 16, padding: 16,
    shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 8, elevation: 3,
  },

  cardHeader: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "flex-start", marginBottom: 12,
  },
  cardTitle: { fontSize: 18, fontWeight: "700", color: "#111827" },
  cardSub:   { fontSize: 12, color: "#777", marginTop: 3 },

  countBubble: { alignItems: "center" },
  countNumber: { fontSize: 28, fontWeight: "bold", color: PRIMARY },
  countLabel:  { fontSize: 10, color: "#999" },

  legendRow: { flexDirection: "row", gap: 6, marginBottom: 10 },
  legendPill: {
    flex: 1, paddingVertical: 5, borderRadius: 10, alignItems: "center",
  },
  legendText: { fontSize: 11, fontWeight: "600" },

  verifyBanner: {
    backgroundColor: "#FEF3C7", borderRadius: 10, padding: 10,
    marginBottom: 10, borderLeftWidth: 3, borderLeftColor: WARNING,
  },
  verifyBannerText: { fontSize: 12, color: "#92400E", fontWeight: "600" },

  studentRow: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", paddingVertical: 12,
    borderBottomWidth: 1, borderColor: "#F1F5F9",
  },
  studentInfo: { flex: 1 },
  studentName: { fontSize: 15, fontWeight: "600", color: "#1F2937" },
  studentRoll: { fontSize: 12, color: "#888", marginTop: 2 },

  studentRight:  { alignItems: "flex-end", gap: 4 },
  rssiValue:     { fontSize: 10, color: "#9CA3AF" },
  certaintyBadge: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
  },
  certaintyText: { fontSize: 12, fontWeight: "700" },

  emptyText: { textAlign: "center", marginTop: 30, color: "#999" },

  continueButton: {
    marginTop: 16, backgroundColor: PRIMARY, padding: 16,
    borderRadius: 14, alignItems: "center", marginBottom: 12,
  },
  continueText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
});