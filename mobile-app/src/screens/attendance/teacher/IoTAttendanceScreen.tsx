/*
  IoTAttendanceScreen.tsx — Teacher Side  (v2: BLE-provisioned device, hand-held / wall-mounted)

  Flow
    1. Setup Device → phone scans nearby Wi-Fi (2.4 GHz only)
                    → teacher taps a network
                         · open network ................. sent straight away
                         · saved on this phone .......... password taken from memory, sent straight away
                         · new secured network .......... asks for the password once (remembered after success)
                    → BLE: scan "PresenceMarker" → connect GATT → write {"c":"wifi",…} on CONTROL
                    → device joins Wi-Fi, answers WIFI_OK / WIFI_FAIL:<why>, saves it and drops the phone
    2. Start Marking → teacher picks placement mode
                         · Hand-held : students must be right next to the device (low power, RSSI gate)
                         · Mounted   : full power, students can mark from their seats
                    → POST backend → attendance_session_id
                    → BLE: write {"c":"session",…,"mode":…} → SESSION_OK → disconnect
                    → poll backend every 5 s for the live count
    3. Stop Marking  → POST backend close → BLE {"c":"stop"} → STOPPED
*/

import { apiFetch, API_BASE } from "../../../services/api";
import { useLiveLock } from "../../../hooks/useLiveLock";
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
  Switch,
  TextInput,
  Platform,
  PermissionsAndroid,
  KeyboardAvoidingView,
  Linking,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import WifiManager from "react-native-wifi-reborn";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as Location from "expo-location";
import { BleManager, Device } from "react-native-ble-plx";
import { Buffer } from "buffer";
import {
  BLE_SERVICE_UUID as FALLBACK_BLE_UUID,
  REASON_LABEL,
  captureTeacherFingerprint,
  useLiveRoster,
  useTeacherBeacon,
} from "../../../utils/proximity";
import {
  Banner,
  Button,
  Card,
  Chip,
  Header,
  IconBadge,
  LiveBadge,
  R,
  Screen,
  SP,
  SectionLabel,
  StatusPill,
  Steps,
  T,
  font,
} from "../../../components/ui";

// ── Constants
const API_URL = API_BASE; // the app's own calls (https)
// Sent to the ESP32: it talks plain http to the raw server IP (Caddy forwards only the /iot/ paths).
const DEVICE_API_URL = "http://13.206.50.57";
const BLE_DEVICE_NAME = "PresenceMarker";
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CONTROL_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const SETUP_KEY = "pm-setup-2026"; // must equal SETUP_KEY in PresenceMarker.ino

const WIFI_CREDS_KEY = "iot_wifi_creds_v1"; // { [ssid]: password }
const LAST_DEVICE_KEY = "iot_last_device_id";
const MODE_KEY = "iot_device_mode";

type Phase =
  | "idle"
  | "wifi_list"
  | "wifi_password"
  | "sending"
  | "ready"
  | "marking"
  | "done";
type Mode = "handheld" | "mounted";
interface RouteParams {
  lectureSessionId: string;
}
interface Net {
  ssid: string;
  level: number;
  secure: boolean;
  saved: boolean;
}
interface CtrlResult {
  status: "ok" | "fail" | "timeout" | "notfound" | "error";
  reply: string;
}

const bleManager = new BleManager();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── saved Wi-Fi passwords (kept on this phone only)
async function loadSavedCreds(): Promise<Record<string, string>> {
  try {
    return JSON.parse((await AsyncStorage.getItem(WIFI_CREDS_KEY)) || "{}");
  } catch {
    return {};
  }
}
async function saveCred(ssid: string, pass: string) {
  const all = await loadSavedCreds();
  all[ssid] = pass;
  await AsyncStorage.setItem(WIFI_CREDS_KEY, JSON.stringify(all));
}
async function forgetCred(ssid: string) {
  const all = await loadSavedCreds();
  delete all[ssid];
  await AsyncStorage.setItem(WIFI_CREDS_KEY, JSON.stringify(all));
}

// ── BLE: find the nearest PresenceMarker (strongest signal, or the one used last time)
async function findDevice(
  onStatus: (m: string) => void,
): Promise<Device | null> {
  const lastId = await AsyncStorage.getItem(LAST_DEVICE_KEY).catch(() => null);
  onStatus("Looking for the PresenceMarker device…");

  return new Promise((resolve) => {
    const found = new Map<string, Device>();
    let done = false;
    let pickTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (d: Device | null) => {
      if (done) return;
      done = true;
      if (pickTimer) clearTimeout(pickTimer);
      clearTimeout(hard);
      bleManager.stopDeviceScan();
      resolve(d);
    };
    const pickBest = () => {
      let best: Device | null = null;
      found.forEach((d) => {
        if (!best || (d.rssi ?? -127) > (best.rssi ?? -127)) best = d;
      });
      finish(best);
    };
    const hard = setTimeout(() => finish(null), 20000);

    bleManager.startDeviceScan(null, { allowDuplicates: false }, (err, d) => {
      if (done) return;
      if (err) {
        console.warn("[BLE] scan error", err.message);
        if (/off/i.test(err.message || "")) finish(null);
        return;
      }
      if (!d) return;
      const name = d.name || d.localName || "";
      const hasSvc = (d.serviceUUIDs || []).some(
        (u) => u.toLowerCase() === SERVICE_UUID,
      );
      if (name !== BLE_DEVICE_NAME && !hasSvc) return;

      if (lastId && d.id === lastId) {
        finish(d);
        return;
      }
      found.set(d.id, d);
      if (!pickTimer) pickTimer = setTimeout(pickBest, 2500); // wait a moment: several devices may be around
    });
  });
}

// ── BLE: connect → send one command on CONTROL → wait for the device's answer
async function bleControl(
  cmd: Record<string, any>,
  classify: (msg: string) => "ok" | "fail" | "wait",
  onStatus: (m: string) => void,
  timeoutMs = 30000,
): Promise<CtrlResult> {
  const found = await findDevice(onStatus);
  if (!found) return { status: "notfound", reply: "" };

  let device: Device | null = null;
  let sub: any = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    onStatus("Device found, connecting…");
    device = await found.connect({ timeout: 12000, requestMTU: 185 });
    await device.discoverAllServicesAndCharacteristics();
    AsyncStorage.setItem(LAST_DEVICE_KEY, found.id).catch(() => {});

    let resolveFn!: (r: CtrlResult) => void;
    const waiter = new Promise<CtrlResult>((res) => {
      resolveFn = res;
    });
    timer = setTimeout(
      () => resolveFn({ status: "timeout", reply: "" }),
      timeoutMs,
    );

    // subscribe BEFORE writing so the answer can't be missed
    sub = device.monitorCharacteristicForService(
      SERVICE_UUID,
      CONTROL_CHAR_UUID,
      (err, ch) => {
        if (err) {
          resolveFn({ status: "error", reply: err.message || "" });
          return;
        }
        if (!ch?.value) return;
        const msg = Buffer.from(ch.value, "base64").toString("utf-8").trim();
        const k = classify(msg);
        if (k === "wait") {
          onStatus(msg === "RX" ? "Device received the details…" : msg);
          return;
        }
        resolveFn({ status: k, reply: msg });
      },
    );
    await sleep(500);

    onStatus("Sending to device…");
    const bytes = Buffer.from(JSON.stringify(cmd) + "\n", "utf-8");
    const CHUNK = 150; // the device re-assembles until '\n'
    for (let i = 0; i < bytes.length; i += CHUNK) {
      await device.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CONTROL_CHAR_UUID,
        bytes.slice(i, i + CHUNK).toString("base64"),
      );
      if (i + CHUNK < bytes.length) await sleep(40);
    }

    return await waiter;
  } catch (e: any) {
    console.warn("[BLE] control error", e?.message);
    return { status: "error", reply: e?.message || "" };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      sub?.remove();
    } catch {}
    const d = device;
    setTimeout(() => {
      d?.cancelConnection().catch(() => {});
    }, 800); // device also drops us after its acknowledgement
  }
}

const classifyWifi = (m: string) =>
  m === "RX" ? "wait" : m === "WIFI_OK" ? "ok" : "fail";
const classifyOne = (okMsg: string) => (m: string) =>
  (m === okMsg ? "ok" : "fail") as "ok" | "fail";

const bars = (level: number) => (level >= -55 ? 3 : level >= -70 ? 2 : 1);

export default function IoTAttendanceScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { lectureSessionId } = (route.params || {}) as RouteParams;

  const [phase, setPhase] = useState<Phase>("idle");
  const [networks, setNetworks] = useState<Net[]>([]);
  const [currentSsid, setCurrentSsid] = useState("");
  const [scanLoading, setScanLoading] = useState(false);
  const [wifiNote, setWifiNote] = useState("");
  const [selSsid, setSelSsid] = useState("");
  const [manual, setManual] = useState(false);
  const [password, setPassword] = useState("");
  const [pwVisible, setPwVisible] = useState(false);
  const [remember, setRemember] = useState(true);
  const [pwError, setPwError] = useState("");
  const [espSsid, setEspSsid] = useState("");
  const [mode, setMode] = useState<Mode>("handheld");
  // fallback: students whose device path fails can use the code / biometric instead (room check applies)
  const [fallback, setFallback] = useState(false);
  const [fallbackCode, setFallbackCode] = useState<string | null>(null);
  const [attendanceSessionId, setAttendanceSessionId] = useState("");
  const [scannedCount, setScannedCount] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [bleWorking, setBleWorking] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attIdRef = useRef("");
  const backPhase = useRef<Phase>("wifi_list");
  const leaving = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY)
      .then((v) => {
        if (v === "mounted" || v === "handheld") setMode(v);
      })
      .catch(() => {});
    AsyncStorage.getItem("last_esp_ssid")
      .then((v) => {
        if (v) setEspSsid(v);
      })
      .catch(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      bleManager.stopDeviceScan();
    };
  }, []);

  // ── permissions / radios ────────────────────────────────────────────────────
  const requestWifiPerms = async (): Promise<boolean> => {
    if (Platform.OS !== "android") {
      Alert.alert(
        "Android only",
        "Listing nearby Wi-Fi networks is only possible on Android phones.",
      );
      return false;
    }
    const perms = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES,
    ]);
    const fine =
      perms[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] ===
      PermissionsAndroid.RESULTS.GRANTED;
    if (!fine) return false; // NEARBY_WIFI_DEVICES only exists on Android 13+
    const locOn = await Location.hasServicesEnabledAsync();
    if (!locOn) {
      Alert.alert(
        "Location Required",
        "Turn on location (GPS) so the phone can list nearby Wi-Fi networks.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Settings", onPress: () => Linking.openSettings() },
        ],
      );
      return false;
    }
    return true;
  };

  const requestBlePerms = async (): Promise<boolean> => {
    if (Platform.OS !== "android") return true;
    const perms = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(perms).every(
      (v) => v === PermissionsAndroid.RESULTS.GRANTED,
    );
  };

  const getBleState = (): Promise<string> =>
    new Promise((resolve) => {
      const sub = bleManager.onStateChange((state) => {
        sub.remove();
        resolve(state);
      }, true);
      setTimeout(() => {
        sub.remove();
        resolve("Unknown");
      }, 3000);
    });

  const waitForBleOn = (timeoutMs = 15000): Promise<boolean> =>
    new Promise((resolve) => {
      const sub = bleManager.onStateChange((state) => {
        if (state === "PoweredOn") {
          sub.remove();
          resolve(true);
        }
      }, true);
      setTimeout(() => {
        sub.remove();
        resolve(false);
      }, timeoutMs);
    });

  const ensureBleOn = async (): Promise<boolean> => {
    if ((await getBleState()) === "PoweredOn") return true;
    if (Platform.OS === "android") {
      try {
        await bleManager.enable();
        return await waitForBleOn(10000);
      } catch {}
    }
    return new Promise((resolve) => {
      Alert.alert(
        "Bluetooth is Off",
        "Please enable Bluetooth, then try again.",
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          {
            text: "Open Settings",
            onPress: () => {
              Linking.openSettings();
              resolve(false);
            },
          },
        ],
      );
    });
  };

  const prepareBle = async (): Promise<boolean> => {
    if (!(await requestBlePerms())) {
      Alert.alert(
        "Bluetooth Permission Required",
        "Grant Bluetooth permissions in Settings to use IoT attendance.",
      );
      return false;
    }
    setStatusMsg("Checking Bluetooth…");
    const on = await ensureBleOn();
    setStatusMsg("");
    return on;
  };

  // ── Step 1: Wi-Fi list (from the PHONE's Wi-Fi radio) ───────────────────────
  const loadNetworks = async () => {
    setScanLoading(true);
    setWifiNote("");
    try {
      let list: any[] = [];
      try {
        list = await (WifiManager as any).reScanAndLoadWifiList();
      } catch {
        list = await WifiManager.loadWifiList();
      }

      let cur = "";
      try {
        cur = (await WifiManager.getCurrentWifiSSID()) || "";
      } catch {}
      setCurrentSsid(cur);

      const saved = await loadSavedCreds();
      const best = new Map<string, Net>();
      let only5g = 0;
      for (const n of list || []) {
        const ssid = String(n.SSID || "").trim();
        if (!ssid) continue;
        const caps = String(n.capabilities || "");
        if (/EAP/i.test(caps)) continue; // enterprise logins are not supported
        if (n.frequency && n.frequency > 3000) {
          only5g++;
          continue;
        } // the ESP32 only speaks 2.4 GHz
        const level = n.level ?? n.RSSI ?? -100;
        const prev = best.get(ssid);
        if (!prev || level > prev.level) {
          best.set(ssid, {
            ssid,
            level,
            secure: /WPA|WEP|PSK|SAE/i.test(caps),
            saved: ssid in saved,
          });
        }
      }
      const arr = [...best.values()].sort(
        (a, b) => Number(b.saved) - Number(a.saved) || b.level - a.level,
      );
      setNetworks(arr);
      if (arr.length === 0) {
        setWifiNote(
          only5g > 0
            ? 'Only 5 GHz networks were found. The device needs a 2.4 GHz network (or use "Other network").'
            : "No networks found. Pull to rescan, or enter the network name manually.",
        );
      }
    } catch (e: any) {
      setNetworks([]);
      setWifiNote(
        "Could not scan Wi-Fi. Check that Wi-Fi and location are on, then rescan.",
      );
    } finally {
      setScanLoading(false);
    }
  };

  const handleSetupDevice = async () => {
    if (!(await requestWifiPerms())) return;
    if (!(await prepareBle())) return;
    setPhase("wifi_list");
    loadNetworks();
  };

  const pickNetwork = async (n: Net) => {
    setSelSsid(n.ssid);
    setManual(false);
    setPwError("");
    if (!n.secure) {
      sendWifi(n.ssid, "", false);
      return;
    }
    const saved = (await loadSavedCreds())[n.ssid];
    if (saved) {
      sendWifi(n.ssid, saved, true);
      return;
    } // "otherwise take from memory"
    setPassword("");
    setPhase("wifi_password");
  };

  const openManual = () => {
    setManual(true);
    setSelSsid("");
    setPassword("");
    setPwError("");
    setPhase("wifi_password");
  };

  const submitPassword = () => {
    const ssid = selSsid.trim();
    if (!ssid) {
      Alert.alert("Network name required");
      return;
    }
    if (!password && !manual) {
      Alert.alert("Password required", "Enter the Wi-Fi password.");
      return;
    }
    sendWifi(ssid, password, false);
  };

  // ── Step 2: send credentials over GATT ──────────────────────────────────────
  const sendWifi = async (ssid: string, pass: string, fromSaved: boolean) => {
    backPhase.current =
      phase === "wifi_password" ? "wifi_password" : "wifi_list";
    setSelSsid(ssid);
    setPhase("sending");
    setBleWorking(true);
    setStatusMsg("Connecting to the device…");

    const r = await bleControl(
      { c: "wifi", k: SETUP_KEY, ssid, pass },
      classifyWifi,
      setStatusMsg,
      35000,
    );

    setBleWorking(false);
    setStatusMsg("");

    if (r.status === "ok") {
      if (pass && (remember || fromSaved)) await saveCred(ssid, pass);
      await AsyncStorage.setItem("last_esp_ssid", ssid).catch(() => {});
      setEspSsid(ssid);
      setPassword("");
      setPhase("ready");
      setStatusMsg(`Device is online on "${ssid}".`);
      return;
    }

    const reason = r.reply.replace("WIFI_FAIL:", "");
    if (r.status === "notfound") {
      Alert.alert(
        "Device not found",
        "• Is the PresenceMarker powered on?\n• Is Bluetooth on?\n• Stand within a few metres of it.",
      );
      setPhase(
        backPhase.current === "wifi_password" ? "wifi_password" : "wifi_list",
      );
    } else if (r.reply === "AUTH_ERR") {
      Alert.alert(
        "Device rejected the request",
        "The setup key in the app does not match the device firmware.",
      );
      setPhase("wifi_list");
    } else if (reason === "nossid") {
      Alert.alert(
        "Network not visible to the device",
        "The device can't see this network. It only supports 2.4 GHz Wi-Fi, and it must be in range of the router.",
      );
      setPhase("wifi_list");
    } else if (r.reply.startsWith("WIFI_FAIL")) {
      if (fromSaved) await forgetCred(ssid);
      setPwError(
        fromSaved
          ? "The saved password no longer works. Enter it again."
          : "Could not join. Wrong password, or the signal is too weak at the device.",
      );
      setPassword("");
      setPhase("wifi_password");
    } else {
      Alert.alert(
        "Could not reach the device",
        "Bluetooth connection failed or timed out. Move closer and try again.",
      );
      setPhase(
        backPhase.current === "wifi_password" ? "wifi_password" : "wifi_list",
      );
    }
  };

  // ── Step 3: start / stop a session ──────────────────────────────────────────
  const chooseMode = (m: Mode) => {
    setMode(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
  };

  // fallback only: rotating BLE token beacon + live "needs your check" list
  useTeacherBeacon(lectureSessionId, fallback && phase === "marking" ? attendanceSessionId || null : null);
  const roster = useLiveRoster(fallback && phase === "marking" ? attendanceSessionId || null : null);

  const handleStartAttendance = async () => {
    if (!lectureSessionId) {
      Alert.alert("Error", "No lecture session.");
      return;
    }
    if (!(await prepareBle())) return;

    setBleWorking(true);
    let roomScans: any[][] = [];
    if (fallback) {
      setStatusMsg("Scanning room Wi-Fi for the fallback check…");
      try {
        roomScans = await captureTeacherFingerprint(3, 2500);
      } catch {}
    }
    setStatusMsg("Creating attendance session…");
    try {
      const res = await apiFetch(`${API_URL}/api/lectures/attendance/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          fallback
            ? {
                lecture_session_id: lectureSessionId,
                marking_method: "iot_multi",
                teacher_wifi_scan: roomScans,
                ble_service_uuid: FALLBACK_BLE_UUID,
              }
            : { lecture_session_id: lectureSessionId, marking_method: "iot" },
        ),
      });
      const data = await res.json();
      if (!data.success) {
        Alert.alert(
          "Error",
          data.error || "Failed to create attendance session.",
        );
        setStatusMsg("");
        setBleWorking(false);
        return;
      }
      const attId = data.attendance_session_id;
      setFallbackCode(fallback ? data.attendance_code || null : null);
      setAttendanceSessionId(attId);
      attIdRef.current = attId;

      const r = await bleControl(
        {
          c: "session",
          k: SETUP_KEY,
          lec: lectureSessionId,
          att: attId,
          api: DEVICE_API_URL,
          mode,
        },
        classifyOne("SESSION_OK"),
        setStatusMsg,
        25000,
      );
      setBleWorking(false);

      if (r.status !== "ok") {
        setStatusMsg("");
        // the device never got the session: do not leave it open on the server
        apiFetch(`${API_URL}/api/lectures/attendance/close`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lecture_session_id: lectureSessionId, attendance_session_id: attId }),
        }).catch(() => {});
        setAttendanceSessionId("");
        attIdRef.current = "";
        if (r.reply === "NO_WIFI") {
          Alert.alert(
            "Device is offline",
            "The device is not connected to Wi-Fi. Set up its Wi-Fi first.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Set up Wi-Fi", onPress: handleSetupDevice },
            ],
          );
        } else if (r.reply === "AUTH_ERR") {
          Alert.alert(
            "Device rejected the request",
            "The setup key in the app does not match the device firmware.",
          );
        } else {
          Alert.alert(
            "Could not start",
            "Could not send the session to the device.\n\n• Is it powered on?\n• Is Bluetooth enabled?\n• Are you within a few metres of it?",
          );
        }
        return;
      }

      setPhase("marking");
      setScannedCount(0);
      setStatusMsg(
        mode === "mounted"
          ? "Session active. Students can mark from their seats."
          : "Session active. Students must walk up to the device.",
      );

      pollRef.current = setInterval(async () => {
        try {
          const rr = await apiFetch(
            `${API_URL}/api/lectures/attendance/verify-students?attendance_session_id=${attId}&lecture_session_id=${lectureSessionId}`,
          );
          const j = await rr.json();
          if (j.success)
            setScannedCount(
              j.students?.filter((st: any) => st.is_present).length || 0,
            );
        } catch {}
      }, 5000);
    } catch {
      Alert.alert("Error", "Could not reach server.");
      setStatusMsg("");
      setBleWorking(false);
    }
  };

  const stopNow = async (thenLeave = false) => {
    if (pollRef.current) clearInterval(pollRef.current);
    try {
      await apiFetch(`${API_URL}/api/lectures/attendance/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lecture_session_id: lectureSessionId,
          attendance_session_id: attIdRef.current,
        }),
      });
    } catch {}
    setBleWorking(true);
    setStatusMsg("Telling the device to stop…");
    try {
      await bleControl({ c: "stop", k: SETUP_KEY }, classifyOne("STOPPED"), setStatusMsg, 20000);
    } catch {}
    setBleWorking(false);
    setStatusMsg("");
    setPhase("done");
    leaving.current = true;
    if (fallback) {
      // students the room check was unsure about are waiting for the teacher
      navigation.replace("ManualMarkingScreen", {
        attendance_session_id: attIdRef.current,
        lecture_session_id: lectureSessionId,
      });
    } else if (thenLeave) {
      navigation.goBack();
    }
  };

  const handleStopAttendance = () => {
    Alert.alert("Stop attendance?", "This closes the session for every student.", [
      { text: "Cancel", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: () => stopNow(false) },
    ]);
  };

  // While the session is recording, back (button, gesture, header) is blocked. It unlocks once stopped.
  useLiveLock(phase === "marking", leaving, "Attendance is running. Tap Stop attendance first.");

  const onBack = () => {
    if (phase === "sending") return; // a Bluetooth hand-off is in progress
    if (phase === "wifi_password") return setPhase("wifi_list");
    if (phase === "wifi_list") return setPhase("idle");
    navigation.goBack();
  };

  // ── UI ──────────────────────────────────────────────────────────────────────
  const STEPS = [
    { label: "Setup" },
    { label: "Network" },
    { label: "Send" },
    { label: "Ready" },
    { label: "Live" },
  ];
  const phaseIndex = ["idle", "wifi_list", "sending", "ready", "marking"].indexOf(phase === "wifi_password" ? "wifi_list" : phase);
  const subtitle: Record<Phase, string> = {
    idle: "Connect the PresenceMarker device",
    wifi_list: "Choose the device's Wi-Fi",
    wifi_password: "Wi-Fi password",
    sending: "Configuring the device",
    ready: "Device is ready",
    marking: "Session in progress",
    done: "Session finished",
  };

  const renderIdle = () => (
    <View style={s.section}>
      <Card style={s.hero}>
        <IconBadge icon="hardware-chip" tone="primary" size={76} />
        <Text style={font.h1}>IoT attendance</Text>
        <Text style={[font.body, s.center]}>
          Connect a PresenceMarker device over Bluetooth. Pick a Wi-Fi network once, then students mark automatically.
        </Text>
      </Card>

      <Card padded={false}>
        {[
          { icon: "bluetooth" as const, title: "Bluetooth setup", text: "Your phone configures the device directly." },
          { icon: "wifi" as const, title: "Wi-Fi from your phone", text: "Pick a network once; it is remembered." },
          { icon: "locate" as const, title: "Hand-held or mounted", text: "Choose how close students must be." },
        ].map((f, i) => (
          <View key={f.title} style={[s.featureRow, i > 0 && s.rowBorder]}>
            <IconBadge icon={f.icon} tone="primary" size={38} />
            <View style={{ flex: 1 }}>
              <Text style={font.h3}>{f.title}</Text>
              <Text style={font.small}>{f.text}</Text>
            </View>
          </View>
        ))}
      </Card>

      <Button label="Set up device" icon="settings" onPress={handleSetupDevice} />
      <Button label="Device is already set up" icon="checkmark-done" variant="secondary" onPress={() => setPhase("ready")} />
    </View>
  );

  const renderWifiList = () => (
    <View style={s.section}>
      <View style={s.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={font.h1}>Choose Wi-Fi</Text>
          <Text style={font.small}>The device needs a 2.4 GHz network</Text>
        </View>
        <Pressable onPress={loadNetworks} disabled={scanLoading} style={s.roundBtn} accessibilityLabel="Rescan networks">
          {scanLoading ? <ActivityIndicator size="small" color={T.primary} /> : <Ionicons name="refresh" size={20} color={T.primary} />}
        </Pressable>
      </View>

      <Banner tone="info">These are the networks your phone can see. Tap one to send it to the device.</Banner>
      {!!wifiNote && <Banner tone="warning">{wifiNote}</Banner>}

      <Card padded={false}>
        {networks.map((n, i) => {
          const b = bars(n.level);
          const tone = b === 3 ? T.success : b === 2 ? T.primary : T.warning;
          return (
            <Pressable key={n.ssid} onPress={() => pickNetwork(n)} style={({ pressed }) => [s.netRow, i > 0 && s.rowBorder, pressed && { backgroundColor: T.bg }]}>
              <View style={[s.signal, { backgroundColor: T.bg }]}>
                <Ionicons name="wifi" size={20} color={tone} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={font.h3} numberOfLines={1}>
                  {n.ssid}
                </Text>
                <Text style={font.small} numberOfLines={1}>
                  {n.secure ? "Secured" : "Open"}
                  {n.ssid === currentSsid ? "  ·  your phone is on this network" : ""}
                </Text>
              </View>
              {n.saved && <Chip label="Saved" tone="success" icon="key" />}
              {n.secure && <Ionicons name="lock-closed" size={15} color={T.muted} />}
              <Ionicons name="chevron-forward" size={18} color={T.muted} />
            </Pressable>
          );
        })}
        {networks.length === 0 && !scanLoading && !wifiNote && <Text style={[font.body, { padding: SP.lg }]}>Scanning...</Text>}
        <Pressable onPress={openManual} style={({ pressed }) => [s.netRow, networks.length > 0 && s.rowBorder, pressed && { backgroundColor: T.bg }]}>
          <View style={s.signal}>
            <Ionicons name="add" size={22} color={T.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={font.h3}>Other network</Text>
            <Text style={font.small}>Hidden network or phone hotspot</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={T.muted} />
        </Pressable>
      </Card>

      <Button label="Back" variant="secondary" onPress={() => setPhase("idle")} />
    </View>
  );

  const renderWifiPassword = () => (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={s.section}>
        <View>
          <Text style={font.h1}>{manual ? "Other network" : "Wi-Fi password"}</Text>
          <Text style={font.small}>{manual ? "Enter the network details" : "You only need to enter this once on this phone"}</Text>
        </View>

        {!!pwError && <Banner tone="danger">{pwError}</Banner>}

        <Card style={{ gap: SP.md }}>
          {manual ? (
            <View style={{ gap: 6 }}>
              <Text style={font.label}>Network name (SSID)</Text>
              <TextInput
                style={s.input}
                value={selSsid}
                onChangeText={setSelSsid}
                placeholder="e.g. College-WiFi"
                autoCapitalize="none"
                autoCorrect={false}
                placeholderTextColor={T.muted}
              />
            </View>
          ) : (
            <View style={s.ssidRow}>
              <Ionicons name="wifi" size={18} color={T.primary} />
              <Text style={[font.h3, { flex: 1 }]} numberOfLines={1}>
                {selSsid}
              </Text>
            </View>
          )}

          <View style={{ gap: 6 }}>
            <Text style={font.label}>{manual ? "Password (leave empty if open)" : "Password"}</Text>
            <View>
              <TextInput
                style={[s.input, { paddingRight: 48 }]}
                value={password}
                onChangeText={setPassword}
                placeholder="Wi-Fi password"
                secureTextEntry={!pwVisible}
                autoCapitalize="none"
                autoCorrect={false}
                placeholderTextColor={T.muted}
              />
              <Pressable style={s.pwToggle} onPress={() => setPwVisible((v) => !v)} hitSlop={8} accessibilityLabel="Show or hide password">
                <Ionicons name={pwVisible ? "eye-off-outline" : "eye-outline"} size={20} color={T.sub} />
              </Pressable>
            </View>
          </View>

          <View style={s.switchRow}>
            <Text style={[font.h3, { flex: 1, fontWeight: "600" }]}>Remember on this phone</Text>
            <Switch value={remember} onValueChange={setRemember} trackColor={{ false: T.line, true: T.primary }} thumbColor="#fff" />
          </View>
        </Card>

        <Button label="Send to device" icon="paper-plane" onPress={submitPassword} />
        <Button label="Back" variant="secondary" onPress={() => setPhase("wifi_list")} />
      </View>
    </KeyboardAvoidingView>
  );

  const renderSending = () => (
    <View style={s.section}>
      <Card style={s.hero}>
        <IconBadge icon="bluetooth" tone="primary" size={76} loading />
        <Text style={font.h1}>Setting up the device</Text>
        <Text style={[font.body, s.center]}>
          Sending <Text style={{ fontWeight: "800", color: T.ink }}>{selSsid}</Text> over Bluetooth. The device will join the network and confirm.
          Keep your phone close to it.
        </Text>
      </Card>
    </View>
  );

  const renderReady = () => (
    <View style={s.section}>
      <Card style={s.hero}>
        <IconBadge icon="checkmark-circle" tone="success" size={76} />
        <Text style={font.h1}>Device ready</Text>
        <Text style={[font.body, s.center]}>
          {espSsid ? `Online on "${espSsid}". ` : ""}Choose how the device is placed, then start.
        </Text>
      </Card>

      <View>
        <SectionLabel>Placement</SectionLabel>
        <View style={{ gap: SP.sm }}>
          <ModeCard
            on={mode === "handheld"}
            onPress={() => chooseMode("handheld")}
            icon="hand-left"
            title="Hand-held"
            text="You hold it. Students walk right up to it (about 1 m). Most accurate and hardest to cheat."
          />
          <ModeCard
            on={mode === "mounted"}
            onPress={() => chooseMode("mounted")}
            icon="business"
            title="Mounted"
            text="Fixed on a wall or ceiling at full power. Students can mark from their seats (roughly 10 to 15 m, depends on the room)."
          />
        </View>
      </View>

      <Card style={s.fbRow}>
        <View style={{ flex: 1 }}>
          <Text style={font.h3}>Fallback: code or biometric</Text>
          <Text style={[font.small, { marginTop: 3, lineHeight: 17 }]}>
            If a student's phone cannot reach the device, they can use the code or their fingerprint. Both still check they are in the room. Keep this
            screen open while marking.
          </Text>
        </View>
        <Switch value={fallback} onValueChange={setFallback} trackColor={{ false: T.line, true: T.primary }} thumbColor="#fff" />
      </Card>

      <Button
        label={bleWorking ? "Connecting..." : "Start attendance"}
        icon="play"
        onPress={handleStartAttendance}
        loading={bleWorking}
      />
      <Button label="Change device Wi-Fi" icon="wifi" variant="secondary" onPress={handleSetupDevice} disabled={bleWorking} />
    </View>
  );

  const liveCount = fallback ? Math.max(scannedCount, roster.present.length) : scannedCount;

  const renderMarking = () => (
    <View style={s.section}>
      <View style={{ flexDirection: "row", gap: SP.sm, alignSelf: "center" }}>
        <LiveBadge />
        <Chip label={mode === "mounted" ? "Mounted" : "Hand-held"} tone="primary" icon={mode === "mounted" ? "business" : "hand-left"} style={{ paddingVertical: 6 }} />
      </View>

      <Card style={s.countCard}>
        <Text style={s.countNum}>{liveCount}</Text>
        <Text style={font.body}>students marked present</Text>
      </Card>

      {fallback && (
        <Card style={{ alignItems: "center", gap: 4 }}>
          <Text style={font.label}>Fallback code</Text>
          <Text style={s.fbCode}>{fallbackCode || "-"}</Text>
          <Text style={[font.small, { textAlign: "center" }]}>Only for students whose phone cannot reach the device.</Text>
        </Card>
      )}

      {fallback && roster.pending.length > 0 && (
        <Banner tone="warning" title={`${roster.pending.length} need your check (not counted yet)`}>
          <View style={{ marginTop: 4, gap: 2 }}>
            {roster.pending.slice(0, 5).map((p) => (
              <Text key={p.uid} style={{ fontSize: 12.5, color: T.sub }}>
                {p.name}
                {p.reasons.length ? "  ·  " + (REASON_LABEL[p.reasons[0]] || p.reasons[0]) : ""}
              </Text>
            ))}
            <Text style={[font.small, { marginTop: 4 }]}>You confirm them on the next screen after you stop.</Text>
          </View>
        </Banner>
      )}

      <Banner tone="info" icon={mode === "mounted" ? "business" : "hand-left"}>
        {mode === "mounted"
          ? "Students open the app in the classroom. Attendance is marked automatically as soon as their phone reaches the device."
          : "Students open the app and walk up to the device. Attendance is marked when they are close enough."}
      </Banner>

      <Button label={bleWorking ? "Stopping..." : "Stop attendance"} icon="stop-circle" variant="danger" onPress={handleStopAttendance} loading={bleWorking} />
    </View>
  );

  const renderDone = () => (
    <View style={s.section}>
      <Card style={s.hero}>
        <IconBadge icon="checkmark-done-circle" tone="success" size={76} />
        <Text style={font.h1}>Session complete</Text>
        <Text style={[font.body, s.center]}>
          {scannedCount} student{scannedCount === 1 ? "" : "s"} marked present by the device.
        </Text>
      </Card>
      <Button label="Back to dashboard" icon="arrow-back" onPress={() => navigation.goBack()} />
    </View>
  );

  return (
    <Screen>
      <Header title="IoT attendance" subtitle={subtitle[phase]} onBack={phase === "marking" ? undefined : onBack} />

      <View style={s.stepsWrap}>
        <Steps steps={STEPS} current={phaseIndex < 0 ? 4 : phaseIndex} />
      </View>

      {!!statusMsg && (
        <View style={{ paddingHorizontal: SP.lg, paddingBottom: SP.md }}>
          <StatusPill
            icon="information-circle"
            tone="primary"
            busy={bleWorking}
            label={statusMsg}
            style={{ flex: 0, alignSelf: "stretch" }}
          />
        </View>
      )}

      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {phase === "idle" && renderIdle()}
        {phase === "wifi_list" && renderWifiList()}
        {phase === "wifi_password" && renderWifiPassword()}
        {phase === "sending" && renderSending()}
        {phase === "ready" && renderReady()}
        {phase === "marking" && renderMarking()}
        {phase === "done" && renderDone()}
      </ScrollView>
    </Screen>
  );
}

function ModeCard({
  on,
  onPress,
  icon,
  title,
  text,
}: {
  on: boolean;
  onPress: () => void;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  text: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [s.modeCard, on && s.modeCardOn, pressed && { opacity: 0.9 }]}
    >
      <IconBadge icon={icon} tone={on ? "primary" : "neutral"} size={44} />
      <View style={{ flex: 1 }}>
        <Text style={font.h3}>{title}</Text>
        <Text style={[font.small, { marginTop: 2, lineHeight: 17 }]}>{text}</Text>
      </View>
      <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={22} color={on ? T.primary : T.muted} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  content: { paddingHorizontal: SP.lg, paddingBottom: SP.xxl * 1.5 },
  stepsWrap: { paddingHorizontal: SP.lg, paddingVertical: SP.lg },
  section: { gap: SP.lg },
  center: { textAlign: "center" },
  hero: { alignItems: "center", gap: SP.sm + 2, paddingVertical: SP.xxl },
  titleRow: { flexDirection: "row", alignItems: "center", gap: SP.md },
  roundBtn: { width: 42, height: 42, borderRadius: R.md, backgroundColor: T.primarySoft, alignItems: "center", justifyContent: "center" },
  featureRow: { flexDirection: "row", alignItems: "center", gap: SP.md, padding: SP.lg },
  rowBorder: { borderTopWidth: 1, borderTopColor: T.lineSoft },
  netRow: { flexDirection: "row", alignItems: "center", gap: SP.md, paddingHorizontal: SP.lg, paddingVertical: SP.md + 2 },
  signal: { width: 38, height: 38, borderRadius: R.sm + 2, backgroundColor: T.bg, alignItems: "center", justifyContent: "center" },
  input: {
    backgroundColor: T.bg,
    borderRadius: R.md,
    borderWidth: 1.5,
    borderColor: T.line,
    paddingHorizontal: SP.lg,
    paddingVertical: 13,
    fontSize: 15,
    color: T.ink,
  },
  ssidRow: { flexDirection: "row", alignItems: "center", gap: SP.sm, backgroundColor: T.primarySoft, padding: SP.md, borderRadius: R.md },
  pwToggle: { position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: SP.md },
  modeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: SP.md,
    backgroundColor: T.surface,
    borderRadius: R.lg,
    padding: SP.md + 2,
    borderWidth: 1.5,
    borderColor: T.line,
  },
  modeCardOn: { borderColor: T.primary, backgroundColor: T.primarySoft },
  fbRow: { flexDirection: "row", alignItems: "center", gap: SP.md },
  countCard: { alignItems: "center", paddingVertical: SP.xxl },
  countNum: { fontSize: 64, fontWeight: "900", color: T.primary, lineHeight: 72 },
  fbCode: { fontSize: 44, fontWeight: "900", color: T.primary, letterSpacing: 8, paddingLeft: 8, lineHeight: 54 },
});