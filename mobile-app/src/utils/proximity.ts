// src/utils/proximity.ts
// Everything the mobile app needs for the "is the student really in the room?" checks:
//   • permissions, Wi-Fi scans, BLE scan (with rotating-token support)
//   • teacher side: room fingerprint capture + rotating BLE token beacon hook + live roster hook
// The decision itself is made by the server (utils/proximity.js) - the app only collects honest signals.

import { useEffect, useRef, useState } from "react";
import { Alert, Linking, NativeModules, PermissionsAndroid, Platform } from "react-native";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import WifiManager from "react-native-wifi-reborn";
import BleManager from "react-native-ble-manager";
import { apiFetch, API_BASE } from "../services/api";
import { db } from "../services/firebase";

export const API_URL = API_BASE;
export const BLE_SERVICE_UUID = "12345678-1234-1234-1234-123456789abc";

/* ───────────────────────── native modules ───────────────────────── */

const { BleAdvertiser, BleScanner } = NativeModules as {
  BleAdvertiser:
    | {
        startAdvertising(serviceUUID: string): Promise<string>;
        advertiseWithToken?(serviceUUID: string, tokenHex: string): Promise<string>;
        stopAdvertising(): Promise<string>;
        isAdvertising(): Promise<boolean>;
      }
    | undefined;
  BleScanner:
    | {
        scanForTeacher(durationMs: number): Promise<number | null>;
        scanForTeacherDetailed?(
          durationMs: number
        ): Promise<{ best: number; median: number; count: number; tokens: string[] } | null>;
      }
    | undefined;
};

/* ───────────────────────── permissions ───────────────────────── */

export async function requestBlePermissions(opts: { advertise?: boolean } = {}): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  if (Platform.Version >= 31) {
    const wanted = [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ];
    if (opts.advertise) wanted.unshift(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE);
    const grants = await PermissionsAndroid.requestMultiple(wanted);
    const ok = Object.values(grants).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
    if (!ok) {
      const never = Object.values(grants).some((r) => r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
      if (never) {
        Alert.alert(
          "Bluetooth permission required",
          "Please enable Nearby devices and Location for PresencePro in Settings → Apps → PresencePro → Permissions.",
          [{ text: "Cancel", style: "cancel" }, { text: "Open Settings", onPress: () => Linking.openSettings() }]
        );
      }
    }
    return ok;
  }
  const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
    title: "Location Permission",
    message: "Bluetooth and Wi-Fi scanning need location access.",
    buttonPositive: "Allow",
  });
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

let bleStarted = false;
export async function ensureBleManager(): Promise<void> {
  if (bleStarted) return;
  try {
    await BleManager.start({ showAlert: false });
    bleStarted = true;
  } catch (e) {
    console.log("[BLE] manager start (non-fatal):", e);
  }
}

/* ───────────────────────── wifi ───────────────────────── */

type Net = { ssid: string; bssid: string; rssi: number };

const mapNets = (nets: any[] | null | undefined): Net[] =>
  (nets || [])
    .map((n: any) => ({ ssid: n.SSID || "", bssid: n.BSSID || "", rssi: Number(n.level ?? n.RSSI ?? -100) }))
    .filter((n) => !!n.bssid);

const maxTs = (nets: any[] | null | undefined): number | null => {
  let m: number | null = null;
  for (const n of nets || []) {
    const t = Number(n?.timestamp);
    if (Number.isFinite(t) && (m === null || t > m)) m = t;
  }
  return m;
};

async function loadCached(): Promise<any[]> {
  try {
    return (await WifiManager.loadWifiList()) || [];
  } catch {
    return [];
  }
}
async function rescan(): Promise<any[] | null> {
  try {
    return (await WifiManager.reScanAndLoadWifiList()) || [];
  } catch {
    return null; // throttled / wifi off
  }
}

/**
 * Teacher: 3 scans a couple of seconds apart -> the server keeps only the access points that show up
 * in at least 2 of them and averages their signal (a single scan is noisy and may be minutes old).
 */
export async function captureTeacherFingerprint(count = 3, gapMs = 2500): Promise<Net[][]> {
  const out: Net[][] = [];
  for (let i = 0; i < count; i++) {
    const raw = i === 0 ? (await rescan()) ?? (await loadCached()) : (await rescan()) ?? [];
    const nets = mapNets(raw);
    if (nets.length) out.push(nets);
    if (i < count - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return out;
}

/* ───────────────────────── student signals ───────────────────────── */

export interface StudentSignals {
  student_wifi_scan: Net[];
  wifi_fresh: boolean | null;
  ble_rssi: number | null; // median
  ble_rssi_max: number | null;
  ble_samples: number;
  ble_tokens: string[];
}

export async function collectStudentSignals(bleMs = 5000): Promise<StudentSignals> {
  // scan A = whatever the OS has cached; scan B = a real new scan while BLE listens
  const cached = await loadCached();
  const tsA = maxTs(cached);

  const bleP = (async () => {
    try {
      if (!BleScanner) return null;
      if (!(await requestBlePermissions())) return null;
      await ensureBleManager();
      if (BleScanner.scanForTeacherDetailed) return await BleScanner.scanForTeacherDetailed(bleMs);
      const best = await BleScanner.scanForTeacher(bleMs); // old native build
      return best == null ? null : { best, median: best, count: 1, tokens: [] as string[] };
    } catch (e: any) {
      console.log("[BLE] scan error:", e?.message ?? e);
      return null;
    }
  })();

  const [fresh, ble] = await Promise.all([rescan(), bleP]);

  const chosen = fresh && fresh.length ? fresh : cached;
  let wifi_fresh: boolean | null = null;
  const tsB = maxTs(fresh);
  if (tsA !== null && tsB !== null) wifi_fresh = tsB > tsA;
  else if (fresh === null && cached.length) wifi_fresh = false;

  return {
    student_wifi_scan: mapNets(chosen),
    wifi_fresh,
    ble_rssi: ble ? ble.median : null,
    ble_rssi_max: ble ? ble.best : null,
    ble_samples: ble ? ble.count : 0,
    ble_tokens: ble ? ble.tokens || [] : [],
  };
}

/* ───────────────────────── server response ───────────────────────── */

export type MarkOutcome =
  | { kind: "verified"; message: string; already?: boolean }
  | { kind: "pending"; message: string; reasons: string[] }
  | { kind: "error"; message: string; errorType: string; reasons: string[] };

export async function postMark(path: "mark-code" | "mark-bio", body: Record<string, any>): Promise<MarkOutcome> {
  const res = await apiFetch(`${API_URL}/api/lectures/attendance/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({} as any));
  if (data?.success && data.pending) {
    return { kind: "pending", message: data.message || "Sent to your teacher for confirmation.", reasons: data.reasons || [] };
  }
  if (data?.success) {
    return { kind: "verified", message: data.message || "Attendance marked", already: !!data.already_marked };
  }
  return {
    kind: "error",
    message: data?.message || data?.error || "Could not mark attendance.",
    errorType: data?.error_type || "generic",
    reasons: data?.reasons || [],
  };
}

export const REASON_LABEL: Record<string, string> = {
  ble_weak: "Bluetooth signal weak",
  ble_missing: "Teacher beacon not heard",
  ble_token_invalid: "Beacon code mismatch",
  wifi_weak: "Wi-Fi differs from room",
  wifi_unavailable: "No Wi-Fi scan",
  wifi_stale: "Old Wi-Fi scan",
  signals_disagree: "Wi-Fi and Bluetooth disagree",
};

/* ───────────────────────── teacher: rotating BLE token beacon ───────────────────────── */

export type BeaconStatus = "starting" | "on" | "error";

/**
 * Keeps the teacher phone advertising the CURRENT token.  The token changes every ~10 s on the server;
 * this polls every 3 s, re-advertises on change, and restarts the beacon if Android dropped it.
 * Falls back to the old token-less beacon when the server has no token for this session.
 */
export function useTeacherBeacon(lectureSessionId: string, attendanceSessionId: string | null): BeaconStatus {
  const [status, setStatus] = useState<BeaconStatus>("starting");
  const lastToken = useRef<string | null>(null);
  const plainOn = useRef(false);

  useEffect(() => {
    if (!attendanceSessionId) return;
    let stopped = false;
    let busy = false;
    let timer: any = null;

    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        if (!BleAdvertiser) {
          setStatus("error");
          return;
        }
        if (!(await requestBlePermissions({ advertise: true }))) {
          setStatus("error");
          return;
        }
        await ensureBleManager();

        const res = await apiFetch(
          `${API_URL}/api/lectures/attendance/ble-token?lecture_session_id=${encodeURIComponent(lectureSessionId)}`
        );
        const data = await res.json().catch(() => ({} as any));

        let onAir = false;
        try {
          onAir = await BleAdvertiser.isAdvertising();
        } catch {}

        if (data?.success && data.enabled && BleAdvertiser.advertiseWithToken) {
          if (data.token !== lastToken.current || !onAir) {
            await BleAdvertiser.advertiseWithToken(data.ble_service_uuid || BLE_SERVICE_UUID, data.token);
            lastToken.current = data.token;
          }
          if (!stopped) setStatus("on");
        } else {
          // no token for this session (or old native build) -> plain beacon
          if (!plainOn.current || !onAir) {
            await BleAdvertiser.startAdvertising(BLE_SERVICE_UUID).catch(() => {});
            plainOn.current = true;
          }
          if (!stopped) setStatus("on");
        }
      } catch (e) {
        console.log("[BLE] beacon tick failed:", e);
        if (!stopped) setStatus("error");
      } finally {
        busy = false;
        if (!stopped) timer = setTimeout(tick, 3000);
      }
    };
    tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      BleAdvertiser?.stopAdvertising().catch(() => {});
    };
  }, [attendanceSessionId, lectureSessionId]);

  return status;
}

/* ───────────────────────── teacher: live roster ───────────────────────── */

export interface RosterRow {
  uid: string;
  name: string;
  roll: string;
  status: "present" | "pending";
  ble_rssi: number | null;
  reasons: string[];
  method: string | null;
}

export function useLiveRoster(attendanceSessionId: string | null): { present: RosterRow[]; pending: RosterRow[] } {
  const [rows, setRows] = useState<RosterRow[]>([]);
  useEffect(() => {
    if (!attendanceSessionId) return;
    const q = query(collection(db, "attendance_records"), where("attendance_session_id", "==", attendanceSessionId));
    return onSnapshot(q, (snap) => {
      const list: RosterRow[] = [];
      snap.forEach((d) => {
        const x: any = d.data();
        if (x.status !== "present" && x.status !== "pending") return;
        list.push({
          uid: x.student_uid,
          name: x.student_name || "Student",
          roll: x.student_roll || "-",
          status: x.status,
          ble_rssi: x.ble_rssi ?? null,
          reasons: Array.isArray(x.reasons) ? x.reasons : [],
          method: x.method || null,
        });
      });
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      setRows(list);
    });
  }, [attendanceSessionId]);
  return { present: rows.filter((r) => r.status === "present"), pending: rows.filter((r) => r.status === "pending") };
}
