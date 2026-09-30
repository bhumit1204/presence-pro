/*
  IoTAttendanceScreen.tsx — Teacher Side
  Flow:
    1. Setup Device  → connect phone to ESP32 AP → WebView portal → ESP32 joins WiFi
    2. Start Marking → POST backend → get attendance_session_id
                     → BLE scan for "PresenceMarker"
                     → connect GATT → write SESSION payload to SESSION_CHAR
                     → wait notify "SESSION_OK" → disconnect
                     → poll backend every 5s for live count
    3. Stop Marking  → POST backend close
                     → BLE scan → connect → write "STOP" → wait "STOPPED" → disconnect
*/

import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, Switch, TextInput, Platform,
  PermissionsAndroid, Modal, KeyboardAvoidingView, Linking,
} from "react-native";
import { WebView } from "react-native-webview";
import AsyncStorage from "@react-native-async-storage/async-storage";
import WifiManager from "react-native-wifi-reborn";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as Location from "expo-location";
import { BleManager, Device } from "react-native-ble-plx";
import { Buffer } from "buffer";

// ── Theme
const PRIMARY       = "#4834D4";
const PRIMARY_LIGHT = "#EEF2FF";
const BG            = "#F3F4F6";
const CARD          = "#FFFFFF";
const MUTED         = "#6B7280";
const SUCCESS       = "#10B981";
const SUCCESS_LT    = "#D1FAE5";
const ERROR         = "#EF4444";
const INK           = "#111827";
const BORDER        = "#E5E7EB";

// ── Constants
const ESP_AP_SSID       = "PresenceMarker_Setup";
const ESP_AP_IP         = "http://192.168.4.1";
const AP_PW_KEY         = "esp32_ap_password";
const API_URL           = "http://10.132.90.56:5000";
const BLE_DEVICE_NAME   = "PresenceMarker";
const SERVICE_UUID      = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const SESSION_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

type Phase = "idle" | "ap_password" | "provisioning" | "ready" | "marking" | "done";
interface RouteParams { lectureSessionId: string }

const bleManager = new BleManager();

// ── BLE helper: scan → connect → subscribe notify → write → resolve on notify
async function bleWriteAndNotify(
  payload: string,
  expectedNotify: string,
  onStatus: (msg: string) => void,
  charUuid: string = SESSION_CHAR_UUID
): Promise<boolean> {
  return new Promise((resolve) => {
    let connectedDevice: Device | null = null;
    let settled = false;
    let notifySubscription: any = null;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      bleManager.stopDeviceScan();
      try { notifySubscription?.remove(); } catch {}
      // Delay must exceed ESP32's notifySession delay (600ms) + BLE stack settle time
      setTimeout(() => {
        connectedDevice?.cancelConnection().catch(() => {});
      }, 1500);
      resolve(ok);
    };

    const timeout = setTimeout(() => {
      onStatus("Device not found or timed out. Make sure it is powered on and nearby.");
      finish(false);
    }, 25000);

    onStatus("Scanning for PresenceMarker…");

    // Scan without service UUID filter — Android often misses filtered ads
    bleManager.startDeviceScan(
      null,
      { allowDuplicates: false },
      async (err, scanned) => {
        if (settled) return;
        if (err) {
          const msg = (err as any)?.message || "";
          if (msg.includes("powered off") || msg.includes("PoweredOff")) {
            clearTimeout(timeout);
            onStatus("Bluetooth is off. Please enable it and try again.");
            finish(false);
          }
          // Other transient scan errors — log only
          console.warn("[BLE] Scan error:", err);
          return;
        }
        if (!scanned) return;
        // Match by name OR by local name
        const name = scanned.name || scanned.localName || "";
        if (name !== BLE_DEVICE_NAME) return;

        bleManager.stopDeviceScan();
        onStatus("Device found, connecting…");

        try {
          connectedDevice = await scanned.connect({ timeout: 12000 });
          onStatus("Connected. Discovering services…");

          // Request larger MTU to avoid payload truncation
          try {
            await (connectedDevice as any).requestMTU(512);
          } catch {}

          await connectedDevice.discoverAllServicesAndCharacteristics();
          onStatus("Subscribing to notifications…");

          // ── STEP 1: Subscribe BEFORE writing to avoid missing the notify response
          await new Promise<void>((subResolve, subReject) => {
            let subReady = false;
            notifySubscription = connectedDevice!.monitorCharacteristicForService(
              SERVICE_UUID,
              charUuid,
              (notifyErr, char) => {
                if (notifyErr) {
                  if (!subReady) subReject(notifyErr);
                  return;
                }
                if (!char?.value) return;
                const val = Buffer.from(char.value, "base64").toString("utf-8").trim();
                console.log("[BLE] Notify received:", val, "expected:", expectedNotify);
                clearTimeout(timeout);
                finish(val === expectedNotify);
              }
            );
            // Give subscription a moment to register, then proceed
            setTimeout(() => { subReady = true; subResolve(); }, 600);
          });

          onStatus("Sending data to device…");

          // ── STEP 2: Write payload — split into chunks if needed (MTU safe)
          const MAX_CHUNK = 180; // safe BLE payload size
          const bytes = Buffer.from(payload, "utf-8");

          if (bytes.length <= MAX_CHUNK) {
            const encoded = bytes.toString("base64");
            await connectedDevice.writeCharacteristicWithResponseForService(
              SERVICE_UUID, charUuid, encoded
            );
          } else {
            // Chunked write for long payloads
            for (let i = 0; i < bytes.length; i += MAX_CHUNK) {
              const chunk = bytes.slice(i, i + MAX_CHUNK);
              await connectedDevice.writeCharacteristicWithResponseForService(
                SERVICE_UUID, charUuid, chunk.toString("base64")
              );
              await new Promise(r => setTimeout(r, 50));
            }
          }

          console.log("[BLE] Write complete, waiting for notify…");

        } catch (e) {
          console.error("[BLE] Connection/write error:", e);
          clearTimeout(timeout);
          onStatus("BLE connection failed. Ensure Bluetooth is enabled and device is nearby.");
          finish(false);
        }
      }
    );
  });
}

export default function IoTAttendanceScreen() {
  const navigation = useNavigation<any>();
  const route      = useRoute<any>();
  const { lectureSessionId } = (route.params || {}) as RouteParams;

  const [phase, setPhase]                           = useState<Phase>("idle");
  const [apPassword, setApPassword]                 = useState("");
  const [saveApPw, setSaveApPw]                     = useState(false);
  const [apPwVisible, setApPwVisible]               = useState(false);
  const [connecting, setConnecting]                 = useState(false);
  const [scanLoading, setScanLoading]               = useState(false);
  const [espSsid, setEspSsid]                      = useState("");
  const [attendanceSessionId, setAttendanceSessionId] = useState("");
  const [scannedCount, setScannedCount]             = useState(0);
  const [statusMsg, setStatusMsg]                   = useState("");
  const [portalUrl, setPortalUrl]                   = useState("");
  const [showPortal, setShowPortal]                 = useState(false);
  const [bleWorking, setBleWorking]                 = useState(false);

  const pollRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const attIdRef    = useRef("");

  useEffect(() => {
    AsyncStorage.getItem(AP_PW_KEY).then(v => {
      if (v) { setApPassword(v); setSaveApPw(true); }
    });
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      bleManager.stopDeviceScan();
    };
  }, []);

  const requestWifiPerms = async (): Promise<boolean> => {
    if (Platform.OS !== "android") return true;
    const perms = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES,
    ]);
    if (!Object.values(perms).every(v => v === PermissionsAndroid.RESULTS.GRANTED)) return false;
    const locOn = await Location.hasServicesEnabledAsync();
    if (!locOn) {
      Alert.alert("Location Required", "Enable GPS for WiFi scanning.", [
        { text: "Cancel", style: "cancel" },
        { text: "Settings", onPress: () => Linking.openSettings() },
      ]);
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
    return Object.values(perms).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
  };

  const handleSetupDevice = async () => {
    await new Promise(r => setTimeout(r, 1500));
    const ok = await requestWifiPerms();
    if (!ok) return;
    setScanLoading(true);
    try { await WifiManager.loadWifiList(); } catch {}
    setScanLoading(false);
    setPhase("ap_password");
  };

  const handleConnectToAP = async () => {
    const pw = apPassword.trim();
    if (!pw) { Alert.alert("Password required"); return; }
    if (saveApPw) await AsyncStorage.setItem(AP_PW_KEY, pw);
    else await AsyncStorage.removeItem(AP_PW_KEY);
    setConnecting(true);
    setStatusMsg("Connecting to PresenceMarker device…");
    try {
      await WifiManager.connectToProtectedSSID(ESP_AP_SSID, pw, false, false);
      await new Promise(r => setTimeout(r, 2000));
      const savedSSID = await AsyncStorage.getItem("last_esp_ssid") || "";
      setPortalUrl(`${ESP_AP_IP}/?saved=${encodeURIComponent(savedSSID)}`);
      setPhase("provisioning");
      setShowPortal(true);
    } catch {
      setStatusMsg("");
      Alert.alert("Connection Failed", "• Device powered on?\n• Password correct?\n• Within range?");
    } finally {
      setConnecting(false);
    }
  };

  const handleWebViewMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "WIFI_SUCCESS") {
        setShowPortal(false);
        setEspSsid(data.ssid || "");
        AsyncStorage.setItem("last_esp_ssid", data.ssid || "");
        setPhase("ready");
        setStatusMsg("Device connected to WiFi. Ready to start.");
        Alert.alert("Setup Complete!", "Reconnect your phone to your normal network, then tap Start.", [{ text: "OK" }]);
      }
    } catch {}
  };

  const INJECTED_JS = `(function(){
    var _o=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u){this._u=u;return _o.apply(this,arguments);};
    var _s=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send=function(b){
      var self=this,orig=this.onload;
      this.onload=function(){
        if(self._u&&self._u.includes('/connect')){
          try{var r=JSON.parse(self.responseText);
            if(r.success){var s='';try{s=new URLSearchParams(b).get('ssid')||'';}catch(e){}
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'WIFI_SUCCESS',ssid:s}));}}catch(e){}
        }
        if(orig)orig.apply(this,arguments);
      };
      return _s.apply(this,arguments);
    };true;
  })();`;

  // Returns current BLE state without side effects
  const getBleState = (): Promise<string> =>
    new Promise((resolve) => {
      const sub = bleManager.onStateChange((state) => {
        sub.remove();
        resolve(state);
      }, true);
      setTimeout(() => { sub.remove(); resolve("Unknown"); }, 3000);
    });

  // Waits until BLE is PoweredOn (up to timeoutMs)
  const waitForBleOn = (timeoutMs = 15000): Promise<boolean> =>
    new Promise((resolve) => {
      const sub = bleManager.onStateChange((state) => {
        if (state === "PoweredOn") { sub.remove(); resolve(true); }
      }, true);
      setTimeout(() => { sub.remove(); resolve(false); }, timeoutMs);
    });

  const ensureBleOn = async (): Promise<boolean> => {
    const state = await getBleState();
    if (state === "PoweredOn") return true;

    // On Android — try the system enable dialog first
    if (Platform.OS === "android") {
      try {
        await bleManager.enable(); // triggers "Turn on Bluetooth?" system dialog
        // Wait up to 10s for it to actually power on
        return await waitForBleOn(10000);
      } catch {
        // User denied or dialog not available — fall through to Settings prompt
      }
    }

    // iOS or Android fallback — send to Settings
    return new Promise((resolve) => {
      Alert.alert(
        "Bluetooth is Off",
        "Please enable Bluetooth, then tap Start again.",
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          { text: "Open Settings", onPress: () => { Linking.openSettings(); resolve(false); } },
        ]
      );
    });
  };

  const handleStartAttendance = async () => {
    if (!lectureSessionId) { Alert.alert("Error", "No lecture session."); return; }
    const bleOk = await requestBlePerms();
    if (!bleOk) { Alert.alert("Bluetooth Permission Required", "Grant Bluetooth permissions in Settings to use IoT attendance."); return; }

    setStatusMsg("Checking Bluetooth…");
    const bleOn = await ensureBleOn();
    if (!bleOn) {
      setStatusMsg("");
      return;
    }

    setStatusMsg("Creating attendance session…");
    try {
      const res  = await fetch(`${API_URL}/api/lectures/attendance/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lecture_session_id: lectureSessionId, marking_method: "iot" }),
      });
      const data = await res.json();
      if (!data.success) {
        Alert.alert("Error", data.error || "Failed to create attendance session.");
        setStatusMsg(""); return;
      }
      const attId = data.attendance_session_id;
      setAttendanceSessionId(attId);
      attIdRef.current = attId;

      setBleWorking(true);
      const payload = `SESSION:${lectureSessionId}|${attId}|${API_URL}`;
      setStatusMsg("Connecting to PresenceMarker via BLE…");
      const ok = await bleWriteAndNotify(payload, "SESSION_OK", setStatusMsg, SESSION_CHAR_UUID);
      setBleWorking(false);

      if (!ok) {
        Alert.alert(
          "BLE Failed",
          "Could not send session to device.\n\n• Is the device powered on?\n• Is Bluetooth enabled?\n• Is the device within 5 metres?\n• Has the device joined WiFi?",
          [{ text: "OK" }]
        );
        setStatusMsg(""); return;
      }

      setPhase("marking");
      setScannedCount(0);
      setStatusMsg("Session active. Students can now mark attendance.");

      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(
            `${API_URL}/api/lectures/attendance/verify-students?attendance_session_id=${attId}&lecture_session_id=${lectureSessionId}`
          );
          const j = await r.json();
          if (j.success) {
            setScannedCount(j.students?.filter((st: any) => st.is_present).length || 0);
          }
        } catch {}
      }, 5000);

    } catch {
      Alert.alert("Error", "Could not reach server.");
      setStatusMsg(""); setBleWorking(false);
    }
  };

  const handleStopAttendance = () => {
    Alert.alert("Stop Attendance?", "This will close the session.", [
      { text: "Cancel", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: async () => {
        if (pollRef.current) clearInterval(pollRef.current);
        try {
          await fetch(`${API_URL}/api/lectures/attendance/close`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              lecture_session_id: lectureSessionId,
              attendance_session_id: attIdRef.current,
            }),
          });
        } catch {}
        setBleWorking(true);
        setStatusMsg("Notifying device to stop…");
        try { await bleWriteAndNotify("STOP", "STOPPED", setStatusMsg, SESSION_CHAR_UUID); } catch {}
        setBleWorking(false);
        setStatusMsg("");
        setPhase("done");
      }},
    ]);
  };

  const STEPS = ["Setup", "Connect", "Portal", "Ready", "Live"] as const;
  const phaseIndex = ["idle","ap_password","provisioning","ready","marking"].indexOf(phase);

  const renderIdle = () => (
    <View style={s.section}>
      <View style={s.heroCard}>
        <View style={s.iconRing}>
          <Ionicons name="hardware-chip" size={40} color={PRIMARY} />
        </View>
        <Text style={s.heroTitle}>IoT Attendance</Text>
        <Text style={s.heroSub}>Connect a PresenceMarker device. Students mark automatically via BLE proximity.</Text>
      </View>
      <View style={s.chipRow}>
        {[{ icon: "wifi", label: "WiFi Setup" }, { icon: "bluetooth", label: "BLE GATT" }, { icon: "radio-outline", label: "Auto Mark" }].map(f => (
          <View key={f.label} style={s.chip}>
            <Ionicons name={f.icon as any} size={14} color={PRIMARY} />
            <Text style={s.chipText}>{f.label}</Text>
          </View>
        ))}
      </View>
      <TouchableOpacity style={s.btnPrimary} onPress={handleSetupDevice}>
        {scanLoading ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="settings-outline" size={20} color="#fff" />}
        <Text style={s.btnPrimaryText}>Setup Device</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.btnOutline} onPress={() => setPhase("ready")}>
        <Ionicons name="checkmark-done-outline" size={18} color={MUTED} />
        <Text style={s.btnOutlineText}>Device Already Setup</Text>
      </TouchableOpacity>
    </View>
  );

  const renderApPassword = () => (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={s.section}>
        <View style={s.stepHeader}>
          <View style={s.badge}><Text style={s.badgeText}>1</Text></View>
          <Text style={s.stepTitle}>Connect to Device</Text>
        </View>
        <View style={s.infoBox}>
          <Ionicons name="wifi" size={18} color={PRIMARY} />
          <Text style={s.infoText}>Your phone will join <Text style={{ fontWeight: "700" }}>PresenceMarker_Setup</Text>. Enter the device hotspot password.</Text>
        </View>
        <Text style={s.fieldLabel}>Hotspot Password</Text>
        <View style={s.pwWrap}>
          <TextInput style={s.input} value={apPassword} onChangeText={setApPassword}
            placeholder="Enter password" secureTextEntry={!apPwVisible}
            autoCapitalize="none" placeholderTextColor={MUTED} />
          <TouchableOpacity style={s.pwToggle} onPress={() => setApPwVisible(v => !v)}>
            <Ionicons name={apPwVisible ? "eye-off-outline" : "eye-outline"} size={20} color={MUTED} />
          </TouchableOpacity>
        </View>
        <View style={s.saveRow}>
          <Switch value={saveApPw} onValueChange={setSaveApPw} trackColor={{ false: BORDER, true: PRIMARY }} thumbColor="#fff" />
          <Text style={s.saveLabel}>Remember password</Text>
        </View>
        <TouchableOpacity style={[s.btnPrimary, connecting && s.btnDisabled]} onPress={handleConnectToAP} disabled={connecting}>
          {connecting ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="wifi" size={20} color="#fff" />}
          <Text style={s.btnPrimaryText}>{connecting ? "Connecting…" : "Connect to Device"}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );

  const renderProvisioning = () => (
    <View style={s.section}>
      <View style={s.stepHeader}>
        <View style={s.badge}><Text style={s.badgeText}>2</Text></View>
        <Text style={s.stepTitle}>Configure WiFi</Text>
      </View>
      <View style={s.infoBox}>
        <Ionicons name="globe-outline" size={18} color={PRIMARY} />
        <Text style={s.infoText}>Select the WiFi network for the device to use for internet.</Text>
      </View>
      <TouchableOpacity style={s.btnPrimary} onPress={() => setShowPortal(true)}>
        <Ionicons name="open-outline" size={20} color="#fff" />
        <Text style={s.btnPrimaryText}>Open Setup Portal</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.btnOutline} onPress={() => { setPhase("ready"); setStatusMsg("Assuming device already configured."); }}>
        <Ionicons name="checkmark-done-outline" size={18} color={MUTED} />
        <Text style={s.btnOutlineText}>Already Configured</Text>
      </TouchableOpacity>
    </View>
  );

  const renderReady = () => (
    <View style={s.section}>
      <View style={s.heroCard}>
        <View style={[s.iconRing, { backgroundColor: SUCCESS_LT }]}>
          <Ionicons name="checkmark-circle" size={40} color={SUCCESS} />
        </View>
        <Text style={s.heroTitle}>Device Ready</Text>
        <Text style={s.heroSub}>{espSsid ? `Device is on "${espSsid}". ` : ""}Tap Start — the app will connect via BLE and push the session.</Text>
      </View>
      <View style={s.infoBox}>
        <Ionicons name="bluetooth" size={18} color={PRIMARY} />
        <Text style={s.infoText}>Keep Bluetooth on. The app will scan for PresenceMarker and send session details directly over BLE.</Text>
      </View>
      <TouchableOpacity style={[s.btnPrimary, bleWorking && s.btnDisabled]} onPress={handleStartAttendance} disabled={bleWorking}>
        {bleWorking ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="play-circle-outline" size={20} color="#fff" />}
        <Text style={s.btnPrimaryText}>{bleWorking ? "Connecting…" : "Start Attendance Marking"}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.btnOutline} onPress={() => setPhase("ap_password")}>
        <Ionicons name="refresh-outline" size={18} color={MUTED} />
        <Text style={s.btnOutlineText}>Reconfigure Device WiFi</Text>
      </TouchableOpacity>
    </View>
  );

  const renderMarking = () => (
    <View style={s.section}>
      <View style={s.liveRow}>
        <View style={s.liveDot} />
        <Text style={s.liveText}>LIVE</Text>
        <View style={[s.liveDot, { backgroundColor: PRIMARY, marginLeft: 12 }]} />
        <Text style={[s.liveText, { color: PRIMARY }]}>DEVICE ACTIVE</Text>
      </View>
      <View style={s.countCard}>
        <Text style={s.countNum}>{scannedCount}</Text>
        <Text style={s.countLabel}>Students Marked Present</Text>
      </View>
      <View style={s.infoBox}>
        <Ionicons name="person-outline" size={18} color={PRIMARY} />
        <Text style={s.infoText}>Students open the app and walk near the device. Attendance marks automatically when close enough.</Text>
      </View>
      <TouchableOpacity style={[s.btnPrimary, { backgroundColor: ERROR }, bleWorking && s.btnDisabled]} onPress={handleStopAttendance} disabled={bleWorking}>
        {bleWorking ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="stop-circle-outline" size={20} color="#fff" />}
        <Text style={s.btnPrimaryText}>{bleWorking ? "Stopping…" : "Stop Attendance"}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderDone = () => (
    <View style={s.section}>
      <View style={s.heroCard}>
        <View style={[s.iconRing, { backgroundColor: SUCCESS_LT }]}>
          <Ionicons name="trophy" size={40} color={SUCCESS} />
        </View>
        <Text style={s.heroTitle}>Session Complete</Text>
        <Text style={s.heroSub}>{scannedCount} students marked present</Text>
      </View>
      <TouchableOpacity style={s.btnPrimary} onPress={() => navigation.goBack()}>
        <Ionicons name="arrow-back-outline" size={20} color="#fff" />
        <Text style={s.btnPrimaryText}>Back to Dashboard</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.iconBtn}>
          <Ionicons name="arrow-back" size={22} color={PRIMARY} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>IoT Attendance</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.progressRow}>
        {STEPS.map((label, i) => {
          const done = i < phaseIndex, active = i === phaseIndex;
          return (
            <React.Fragment key={label}>
              {i > 0 && <View style={[s.progressLine, done && s.progressLineDone]} />}
              <View style={[s.dot, active && s.dotActive, done && s.dotDone]}>
                {done ? <Ionicons name="checkmark" size={10} color="#fff" /> : <Text style={[s.dotText, active && { color: "#fff" }]}>{i + 1}</Text>}
              </View>
            </React.Fragment>
          );
        })}
      </View>

      {!!statusMsg && (
        <View style={s.statusBar}>
          {bleWorking ? <ActivityIndicator size="small" color={PRIMARY} /> : <Ionicons name="information-circle-outline" size={16} color={PRIMARY} />}
          <Text style={s.statusText}>{statusMsg}</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {phase === "idle"         && renderIdle()}
        {phase === "ap_password"  && renderApPassword()}
        {phase === "provisioning" && renderProvisioning()}
        {phase === "ready"        && renderReady()}
        {phase === "marking"      && renderMarking()}
        {phase === "done"         && renderDone()}
      </ScrollView>

      <Modal visible={showPortal} animationType="slide" onRequestClose={() => setShowPortal(false)}>
        <View style={{ flex: 1, backgroundColor: BG }}>
          <View style={s.modalHeader}>
            <TouchableOpacity onPress={() => setShowPortal(false)} style={s.iconBtn}>
              <Ionicons name="close" size={22} color={PRIMARY} />
            </TouchableOpacity>
            <Text style={s.headerTitle}>Device Setup Portal</Text>
            <View style={{ width: 40 }} />
          </View>
          <WebView source={{ uri: portalUrl }} injectedJavaScript={INJECTED_JS}
            onMessage={handleWebViewMessage} javaScriptEnabled domStorageEnabled style={{ flex: 1 }}
            onError={() => Alert.alert("Portal Unavailable", "Make sure your phone is connected to PresenceMarker_Setup.")} />
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:  { flex: 1, backgroundColor: BG },
  content:    { paddingHorizontal: 20, paddingBottom: 40 },
  header:     { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 56, paddingBottom: 16, paddingHorizontal: 20, backgroundColor: BG },
  modalHeader:{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 56, paddingBottom: 12, paddingHorizontal: 20, backgroundColor: BG, borderBottomWidth: 1, borderBottomColor: BORDER },
  headerTitle:{ fontSize: 18, fontWeight: "700", color: INK },
  iconBtn:    { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  progressRow:      { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 24, paddingBottom: 20 },
  progressLine:     { flex: 1, height: 2, backgroundColor: BORDER, marginHorizontal: 2 },
  progressLineDone: { backgroundColor: SUCCESS },
  dot:      { width: 24, height: 24, borderRadius: 12, backgroundColor: BORDER, alignItems: "center", justifyContent: "center" },
  dotActive: { backgroundColor: PRIMARY },
  dotDone:   { backgroundColor: SUCCESS },
  dotText:   { fontSize: 10, fontWeight: "700", color: MUTED },
  statusBar:  { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: PRIMARY_LIGHT, marginHorizontal: 20, marginBottom: 16, borderRadius: 12, padding: 12 },
  statusText: { flex: 1, fontSize: 13, color: PRIMARY, fontWeight: "500" },
  section:    { gap: 16, paddingTop: 8 },
  heroCard:   { backgroundColor: CARD, borderRadius: 20, padding: 28, alignItems: "center", gap: 8, shadowColor: PRIMARY, shadowOpacity: 0.06, shadowRadius: 16, elevation: 3 },
  iconRing:   { width: 72, height: 72, borderRadius: 36, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center" },
  heroTitle:  { fontSize: 20, fontWeight: "700", color: INK, marginTop: 4 },
  heroSub:    { fontSize: 14, color: MUTED, textAlign: "center", lineHeight: 20 },
  chipRow:    { flexDirection: "row", justifyContent: "center", gap: 8, flexWrap: "wrap" },
  chip:       { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: PRIMARY_LIGHT, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  chipText:   { fontSize: 12, color: PRIMARY, fontWeight: "600" },
  stepHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
  badge:      { width: 32, height: 32, borderRadius: 10, backgroundColor: PRIMARY_LIGHT, alignItems: "center", justifyContent: "center" },
  badgeText:  { fontSize: 15, fontWeight: "700", color: PRIMARY },
  stepTitle:  { fontSize: 18, fontWeight: "700", color: INK },
  infoBox:    { flexDirection: "row", gap: 10, alignItems: "flex-start", backgroundColor: PRIMARY_LIGHT, borderRadius: 12, padding: 14 },
  infoText:   { flex: 1, fontSize: 13, color: "#374151", lineHeight: 19 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: MUTED, textTransform: "uppercase", letterSpacing: 0.4 },
  pwWrap:     { position: "relative" },
  input:      { backgroundColor: CARD, borderRadius: 12, borderWidth: 1.5, borderColor: BORDER, paddingHorizontal: 14, paddingVertical: 13, paddingRight: 48, fontSize: 15, color: INK },
  pwToggle:   { position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center" },
  saveRow:    { flexDirection: "row", alignItems: "center", gap: 10 },
  saveLabel:  { fontSize: 14, color: "#374151", fontWeight: "500" },
  liveRow:    { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "center" },
  liveDot:    { width: 8, height: 8, borderRadius: 4, backgroundColor: ERROR },
  liveText:   { fontSize: 12, fontWeight: "800", color: ERROR, letterSpacing: 1.2 },
  countCard:  { backgroundColor: CARD, borderRadius: 20, padding: 32, alignItems: "center", gap: 4, elevation: 3 },
  countNum:   { fontSize: 56, fontWeight: "800", color: PRIMARY },
  countLabel: { fontSize: 14, color: MUTED, fontWeight: "500" },
  btnPrimary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: PRIMARY, borderRadius: 14, height: 52, shadowColor: PRIMARY, shadowOpacity: 0.2, shadowRadius: 12, elevation: 4 },
  btnPrimaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  btnDisabled:{ backgroundColor: "#9CA3AF", shadowOpacity: 0 },
  btnOutline: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1.5, borderColor: BORDER, borderRadius: 14, height: 50 },
  btnOutlineText: { fontSize: 15, fontWeight: "600", color: MUTED },
});