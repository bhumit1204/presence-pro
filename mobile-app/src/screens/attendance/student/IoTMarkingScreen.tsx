import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Platform,
  PermissionsAndroid,
  Animated,
  Vibration,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getUserSession } from "../../../services/session";
import { Button, Card, Chip, Header, IconBadge, ProgressBar, Screen, SP, T, TONE, Tone, font } from "../../../components/ui";
import { BleManager, Device } from "react-native-ble-plx";
import { Buffer } from "buffer";

// ── BLE Constants ────────────────────────────────────────────────────────────
const BLE_DEVICE_NAME = "PresenceMarker";
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const STUDENT_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

// RSSI gate — depends on how the teacher placed the device (advertised by the device itself)
//   hand-held : student has to walk right up to it
//   mounted   : device runs at full power on a wall/ceiling, so a much weaker signal is fine
const RSSI_HANDHELD = -40;
const RSSI_MOUNTED = -85;
type DeviceMode = "handheld" | "mounted";
type IconName = React.ComponentProps<typeof Ionicons>["name"];

// Rolling local buffer — prevents re-marking same session without a server call
const BUFFER_KEY = "iot_marked_buffer_v2";
const BUFFER_SIZE = 50;

const RETRY_SCAN_DELAY = 4000;
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

// 4-hex-char tag of a uid (FNV-1a folded to 16 bits). The device puts it in front of every answer so
// several students can be connected at once without picking up each other's reply.
function uidTag(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ((h ^ (h >>> 16)) & 0xffff)
    .toString(16)
    .toUpperCase()
    .padStart(4, "0");
}

// The device advertises  FF FF 'P' 'M' <'H'|'M'> <'0'|'1'>  (placement mode, session running)
function parseAdv(d: Device): {
  mode: DeviceMode | null;
  active: boolean | null;
} {
  try {
    if (!d.manufacturerData) return { mode: null, active: null };
    const b = Buffer.from(d.manufacturerData, "base64");
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] === 0x50 && b[i + 1] === 0x4d) {
        return {
          mode: b[i + 2] === 0x4d ? "mounted" : "handheld",
          active: b[i + 3] === 0x31,
        };
      }
    }
  } catch {}
  return { mode: null, active: null };
}

export default function IoTMarkingScreen() {
  const navigation = useNavigation<any>();
  // set when the teacher enabled the "code / biometric fallback" for this session (marking_method = iot_multi)
  const routeParams = (useRoute<any>().params || {}) as {
    fallback?: boolean;
    attendanceSessionId?: string;
    lectureSessionId?: string;
  };

  const [phase, setPhase] = useState<ScanPhase>("init");
  const [uid, setUid] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState("");
  const [rssi, setRssi] = useState<number | null>(null);
  const [devMode, setDevMode] = useState<DeviceMode>("handheld");

  const connectedDevice = useRef<Device | null>(null);
  const scanning = useRef(false);
  const markingLock = useRef(false);
  const errorRetryCount = useRef(0);
  const mounted = useRef(true);
  const rssiWindow = useRef<number[]>([]);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // ── Pulse animation while scanning / connecting ──────────────────────────
  useEffect(() => {
    if (phase !== "scanning" && phase !== "too_far" && phase !== "connecting")
      return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [phase]);

  // ── Fade in on every phase change ────────────────────────────────────────
  useEffect(() => {
    fadeAnim.setValue(0);
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
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
  const safe = (fn: () => void) => {
    if (mounted.current) fn();
  };

  const loadUidAndStart = async () => {
    try {
      const session = await getUserSession();
      const storedUid = session?.uid ?? null;
      if (!storedUid) {
        safe(() => {
          setPhase("error");
          setStatusMsg("User session not found. Please log in again.");
        });
        return;
      }
      safe(() => setUid(storedUid));
      await startScanning(storedUid);
    } catch {
      safe(() => {
        setPhase("error");
        setStatusMsg("Could not load user session.");
      });
    }
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

  // ── Local buffer helpers ──────────────────────────────────────────────────
  const isInBuffer = async (
    checkUid: string,
    sessionId: string,
  ): Promise<boolean> => {
    try {
      const raw = await AsyncStorage.getItem(BUFFER_KEY);
      const buf: string[] = raw ? JSON.parse(raw) : [];
      return buf.includes(`${checkUid}::${sessionId}`);
    } catch {
      return false;
    }
  };

  const addToBuffer = async (checkUid: string, sessionId: string) => {
    try {
      const raw = await AsyncStorage.getItem(BUFFER_KEY);
      let buf: string[] = raw ? JSON.parse(raw) : [];
      const key = `${checkUid}::${sessionId}`;
      if (!buf.includes(key)) {
        buf.push(key);
        // Rolling window — drop oldest half when full
        if (buf.length > BUFFER_SIZE)
          buf = buf.slice(Math.floor(BUFFER_SIZE / 2));
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

  const resumeScanAfterDelay = (
    currentUid: string,
    reason: "no_session" | "error",
  ) => {
    if (!mounted.current) return;

    if (reason === "error") {
      errorRetryCount.current += 1;
      if (errorRetryCount.current >= MAX_ERROR_RETRIES) {
        safe(() => {
          setPhase("error");
          setStatusMsg(
            "The device could not reach the server after several attempts. Check the device's Wi-Fi.",
          );
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
            ? "Waiting for the session to start. Retrying..."
            : `Retrying after an error (${errorRetryCount.current}/${MAX_ERROR_RETRIES})`,
        );
      });
      await startScanning(currentUid);
    }, RETRY_SCAN_DELAY);
  };

  // ── Main scan loop ────────────────────────────────────────────────────────
  const startScanning = async (scanUid: string) => {
    const ok = await requestBlePerms();
    if (!ok) {
      safe(() => setPhase("perm_required"));
      return;
    }

    // Guard against duplicate scan calls
    if (scanning.current) return;

    safe(() => {
      setPhase("scanning");
      setStatusMsg("Looking for the PresenceMarker device...");
    });
    scanning.current = true;
    rssiWindow.current = [];

    bleManager.startDeviceScan(
      null,
      { allowDuplicates: true },
      async (err, device) => {
        if (!mounted.current) return;
        if (err) {
          console.warn("[BLE] Scan error:", err.message);
          safe(() => {
            setPhase("error");
            setStatusMsg("Bluetooth scan failed. Make sure Bluetooth is on.");
          });
          scanning.current = false;
          return;
        }
        if (!device) return;

        const name = device.name || device.localName || "";
        const hasSvc = (device.serviceUUIDs || []).some(
          (u) => u.toLowerCase() === SERVICE_UUID,
        );
        if (name !== BLE_DEVICE_NAME && !hasSvc) return;

        // What the device tells us about itself (older firmware: nothing → hand-held rules)
        const adv = parseAdv(device);
        const mode: DeviceMode = adv.mode ?? "handheld";
        safe(() => setDevMode(mode));

        // Smooth the RSSI: best of the last 3 readings (single readings jump around a lot)
        const w = rssiWindow.current;
        w.push(device.rssi ?? -100);
        if (w.length > 3) w.shift();
        const currentRssi = Math.max(...w);
        safe(() => setRssi(currentRssi));

        // Teacher has not started a session → don't connect, just keep listening
        if (adv.active === false) {
          safe(() => {
            setPhase("no_session");
            setStatusMsg("Waiting for your teacher to start attendance...");
          });
          return;
        }

        const threshold = mode === "mounted" ? RSSI_MOUNTED : RSSI_HANDHELD;

        // Too far — show signal feedback but keep scanning
        if (currentRssi < threshold) {
          safe(() => setPhase("too_far"));
          return;
        }

        // Already locked — another mark attempt in progress
        if (markingLock.current) return;
        markingLock.current = true;

        bleManager.stopDeviceScan();
        scanning.current = false;

        safe(() => {
          setPhase("connecting");
          setStatusMsg("In range. Marking attendance...");
        });
        await markAttendance(device, scanUid);
      },
    );
  };

  // ── BLE connect → write UID → wait for the reply addressed to this student ─
  const markAttendance = async (device: Device, markUid: string) => {
    const myTag = uidTag(markUid);
    try {
      // MTU 185: the reply and the uid fit in one packet
      connectedDevice.current = await device.connect({
        timeout: 10000,
        requestMTU: 185,
      });
      await connectedDevice.current.discoverAllServicesAndCharacteristics();

      let resolved = false;

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          if (!resolved) reject(new Error("notify_timeout"));
        }, 20000); // mounted mode: the device may be serving other students first

        // Subscribe FIRST, then write after a short settle delay
        const sub = connectedDevice.current!.monitorCharacteristicForService(
          SERVICE_UUID,
          STUDENT_CHAR_UUID,
          async (notifyErr, char) => {
            if (notifyErr) {
              console.warn("[BLE] Notify error:", notifyErr?.message);
              if (resolved) return;
              clearTimeout(t);
              reject(new Error("notify_cancelled"));
              return;
            }

            if (!char?.value || resolved) return;

            // Reply format:  <4-char uid tag>|<CODE>[|<session tag>]
            const val = Buffer.from(char.value, "base64")
              .toString("utf-8")
              .trim();
            const parts = val.split("|");
            if (parts[0] !== myTag) return; // answer for another student — keep waiting
            const code = parts[1] || "";
            const sessionTag = parts[2] || "";

            resolved = true;
            clearTimeout(t);
            try {
              sub?.remove();
            } catch {}

            connectedDevice.current?.cancelConnection().catch(() => {});
            connectedDevice.current = null;

            if (code === "OK") {
              await addToBuffer(
                markUid,
                sessionTag || new Date().toISOString().slice(0, 10),
              );
              Vibration.vibrate([0, 100, 60, 100]);
              safe(() => {
                setPhase("success");
                setStatusMsg("Attendance marked successfully!");
              });
              markingLock.current = false;
            } else if (code === "ALREADY") {
              await addToBuffer(
                markUid,
                sessionTag || new Date().toISOString().slice(0, 10),
              );
              Vibration.vibrate(60);
              safe(() => {
                setPhase("already");
                setStatusMsg(
                  "Your attendance was already marked for this session.",
                );
              });
              markingLock.current = false;
            } else if (code === "NO_SESSION") {
              safe(() => {
                setPhase("no_session");
                setStatusMsg(
                  "No active session yet. Retrying in 4 s...",
                );
              });
              resumeScanAfterDelay(markUid, "no_session");
            } else if (code === "BUSY") {
              // device is serving many students at once — just try again shortly
              safe(() => {
                setPhase("scanning");
                setStatusMsg("Device is busy. Trying again...");
              });
              setTimeout(() => {
                if (!mounted.current) return;
                stopScan();
                markingLock.current = false;
                startScanning(markUid);
              }, 2000);
            } else if (code === "ERR") {
              safe(() => {
                setPhase("error");
                setStatusMsg(
                  "The device could not reach the server. Check its Wi-Fi. Retrying in 4 s...",
                );
              });
              resumeScanAfterDelay(markUid, "error");
            } else {
              safe(() => {
                setPhase("error");
                setStatusMsg(`Unexpected response from device: "${val}"`);
              });
              markingLock.current = false;
            }

            resolve();
          },
        );

        // 400ms settle — ensures subscription is registered before write goes out
        setTimeout(() => {
          if (resolved) return;
          const encoded = Buffer.from(markUid, "utf-8").toString("base64");
          connectedDevice
            .current!.writeCharacteristicWithResponseForService(
              SERVICE_UUID,
              STUDENT_CHAR_UUID,
              encoded,
            )
            .catch((e) => {
              clearTimeout(t);
              reject(e);
            });
        }, 400);
      });
    } catch (e: any) {
      connectedDevice.current?.cancelConnection().catch(() => {});
      connectedDevice.current = null;
      markingLock.current = false;

      const msg =
        e?.message === "notify_timeout"
          ? "Device did not respond in time. Try again."
          : e?.message === "notify_cancelled"
            ? "Connection dropped before response. Move closer and try again."
            : "Could not connect to device. Make sure you are close enough.";

      safe(() => {
        setPhase("error");
        setStatusMsg(msg);
      });
    }
  };

  // ── Retry handler ─────────────────────────────────────────────────────────
  const handleRetry = async () => {
    markingLock.current = false;
    errorRetryCount.current = 0;
    stopScan();
    if (uid) await startScanning(uid);
    else await loadUidAndStart();
  };

  // ── Render helpers ────────────────────────────────────────────────────────
  const view: Record<ScanPhase, { icon: IconName; tone: Tone; title: string }> = {
    init: { icon: "hourglass", tone: "primary", title: "Loading" },
    perm_required: { icon: "lock-closed", tone: "danger", title: "Permission required" },
    scanning: { icon: "bluetooth", tone: "primary", title: "Looking for the device" },
    too_far: { icon: "walk", tone: "warning", title: "Move closer" },
    connecting: { icon: "link", tone: "primary", title: "Marking attendance" },
    success: { icon: "checkmark-circle", tone: "success", title: "Attendance marked" },
    already: { icon: "checkmark-done-circle", tone: "info", title: "Already marked" },
    no_session: { icon: "time", tone: "warning", title: "Waiting for your teacher" },
    error: { icon: "alert-circle", tone: "danger", title: "Something went wrong" },
  };

  const renderSub = () => {
    switch (phase) {
      case "perm_required":
        return "Bluetooth and Location permission are required to detect the attendance device.";
      case "scanning":
        return (
          statusMsg ||
          (devMode === "mounted"
            ? "Stay in the classroom. Your attendance is marked automatically when your phone reaches the device."
            : "Walk close to the PresenceMarker device to mark your attendance.")
        );
      case "too_far":
        return rssi
          ? devMode === "mounted"
            ? "Signal is too weak here. Move closer to the device or into the classroom."
            : "Move closer to the device."
          : "Move closer to the device.";
      case "connecting":
        return "You are in range. Sending your attendance to the device...";
      case "success":
        return "Your attendance has been recorded for this session.";
      case "already":
        return "Your attendance was already recorded for this session.";
      case "no_session":
        return statusMsg || "The teacher has not started an attendance session yet.";
      case "error":
        return statusMsg || "An error occurred. Please try again.";
      default:
        return statusMsg;
    }
  };

  const v = view[phase];
  const showPulse = phase === "scanning" || phase === "connecting" || phase === "too_far";
  const showRetry = phase === "error" || phase === "perm_required";
  const showDone = phase === "success" || phase === "already";
  const showMeter = (phase === "scanning" || phase === "too_far") && rssi !== null;

  const threshold = devMode === "mounted" ? RSSI_MOUNTED : RSSI_HANDHELD;
  const rssiValue = rssi !== null ? Math.min(1, Math.max(0, (rssi + 100) / 60)) : 0;
  const inRange = rssi !== null && rssi >= threshold;

  // ── UI ────────────────────────────────────────────────────────────────────
  return (
    <Screen>
      <Header title="IoT attendance" subtitle="Mark with the classroom device" onBack={() => navigation.goBack()} />

      <Animated.View style={[st.body, { opacity: fadeAnim }]}>
        <View style={st.iconWrap}>
          {showPulse && (
            <Animated.View style={[st.ring, { borderColor: TONE[v.tone].fg, transform: [{ scale: pulseAnim }] }]} />
          )}
          <IconBadge icon={v.icon} tone={v.tone} size={96} loading={phase === "init" || phase === "connecting"} />
        </View>

        <Text style={[font.h1, st.center]}>{v.title}</Text>
        <Text style={[font.body, st.center, st.sub]}>{renderSub()}</Text>

        {phase === "scanning" && rssi !== null && (
          <Chip
            label={devMode === "mounted" ? "Mounted device found" : "Hand-held device found"}
            tone="primary"
            icon="radio"
            style={{ alignSelf: "center" }}
          />
        )}

        {showMeter && (
          <Card style={st.meter}>
            <View style={st.meterRow}>
              <Ionicons name="cellular" size={16} color={T.sub} />
              <Text style={[font.h3, { flex: 1, fontWeight: "600" }]}>Signal strength</Text>
              <Text style={[font.h3, { color: inRange ? T.success : T.danger }]}>{rssi} dBm</Text>
            </View>
            <ProgressBar value={rssiValue} tone={inRange ? "success" : "danger"} />
            <Text style={font.small}>{inRange ? "Close enough. Marking..." : "Move closer to the device"}</Text>
          </Card>
        )}

        <View style={st.actions}>
          {showRetry && (
            <Button label={phase === "perm_required" ? "Grant permission" : "Try again"} icon="refresh" onPress={handleRetry} />
          )}
          {showDone && <Button label="Done" onPress={() => navigation.goBack()} />}

          {/* Fallback: device unreachable -> code or biometric (room check still applies) */}
          {routeParams.fallback && !showDone && (
            <Button
              label="Device not working? Use code or biometric"
              icon="finger-print"
              variant="secondary"
              onPress={() =>
                navigation.replace("MultiMarkingScreen", {
                  attendanceSessionId: routeParams.attendanceSessionId,
                  lectureSessionId: routeParams.lectureSessionId,
                })
              }
            />
          )}
        </View>
      </Animated.View>
    </Screen>
  );
}

const st = StyleSheet.create({
  body: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: SP.xxl, gap: SP.md },
  iconWrap: { alignItems: "center", justifyContent: "center", width: 140, height: 140, marginBottom: SP.sm },
  ring: { position: "absolute", width: 128, height: 128, borderRadius: 40, borderWidth: 2, opacity: 0.35 },
  center: { textAlign: "center" },
  sub: { fontSize: 15, lineHeight: 22 },
  meter: { width: "100%", gap: SP.sm + 2, marginTop: SP.sm },
  meterRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  actions: { width: "100%", gap: SP.sm + 2, marginTop: SP.lg },
});