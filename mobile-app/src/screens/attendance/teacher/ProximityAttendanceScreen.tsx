// Teacher live-attendance screen for the three "in-room" methods:
//   mode="code"          → 3-digit code, students must also pass the room check
//   mode="bio_wifi_ble"  → biometric + room check
//   mode="multi"         → students choose code OR biometric (both with the room check)
// CodeAttendanceScreen / BioGeoAttendanceScreen / MultiAttendanceScreen just render this with a mode.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, FlatList, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { apiFetch } from "../../../services/api";
import { useLiveLock } from "../../../hooks/useLiveLock";
import {
  API_URL,
  BLE_SERVICE_UUID,
  REASON_LABEL,
  RosterRow,
  captureTeacherFingerprint,
  useLiveRoster,
  useTeacherBeacon,
} from "../../../utils/proximity";
import {
  Avatar,
  Banner,
  Button,
  Card,
  Chip,
  Header,
  LiveBadge,
  ResultView,
  Screen,
  SP,
  StatusPill,
  T,
  font,
} from "../../../components/ui";

export type AttendanceMode = "code" | "bio_wifi_ble" | "multi";

const COPY: Record<AttendanceMode, { title: string; sub: string; hint: string }> = {
  code: {
    title: "Code Attendance",
    sub: "Code, Wi-Fi and Bluetooth check",
    hint: "Write this on the board. Students must pick it and be physically in the room.",
  },
  bio_wifi_ble: {
    title: "Biometric Attendance",
    sub: "Fingerprint, Wi-Fi and Bluetooth check",
    hint: "",
  },
  multi: {
    title: "Multi Method Attendance",
    sub: "Code or biometric, with room check",
    hint: "Students pick this code or use biometric. Both are checked against the room.",
  },
};

function methodLabel(m: string | null): string | null {
  if (!m) return null;
  if (m.includes("bio")) return "Biometric";
  if (m.includes("code")) return "Code";
  if (m.includes("iot")) return "Device";
  return null;
}

export default function ProximityAttendanceScreen({ mode }: { mode: AttendanceMode }) {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const { lectureSessionId } = route.params;
  const copy = COPY[mode];
  const showCode = mode !== "bio_wifi_ble";

  const [attendanceCode, setAttendanceCode] = useState<string | null>(null);
  const [attendanceSessionId, setAttendanceSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [wifiAps, setWifiAps] = useState<number | null>(null);
  const [phase, setPhase] = useState<"wifi" | "start">("wifi");
  const [startError, setStartError] = useState<string | null>(null);

  const started = useRef(false);
  const leaving = useRef(false);
  const alive = useRef(true);

  const beacon = useTeacherBeacon(lectureSessionId, attendanceSessionId);
  const { present, pending } = useLiveRoster(attendanceSessionId);

  // ── Boot: room fingerprint (3 scans) → start attendance ────────────────────
  const begin = useCallback(async () => {
    setLoading(true);
    setStartError(null);
    setPhase("wifi");
    let scans: any[][] = [];
    try {
      scans = await captureTeacherFingerprint(3, 2500);
    } catch (e) {
      console.log("[WiFi] fingerprint skipped:", e);
    }
    if (!alive.current) return;
    setWifiAps(scans.length ? Math.max(...scans.map((x) => x.length)) : 0);
    setPhase("start");

    try {
      const res = await apiFetch(`${API_URL}/api/lectures/attendance/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lecture_session_id: lectureSessionId,
          marking_method: mode,
          teacher_wifi_scan: scans,
          ble_service_uuid: BLE_SERVICE_UUID,
        }),
      });
      const data = await res.json();
      if (!alive.current) {
        // teacher left while the session was being created: do not leave it open on the server
        if (data.success) {
          apiFetch(`${API_URL}/api/lectures/attendance/close`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lecture_session_id: lectureSessionId }),
          }).catch(() => {});
        }
        return;
      }
      if (data.success && (!showCode || data.attendance_code)) {
        setAttendanceSessionId(data.attendance_session_id);
        if (showCode) setAttendanceCode(data.attendance_code);
      } else {
        setStartError(data.error || data.message || "The server could not start attendance.");
      }
    } catch (e) {
      console.log("[Attendance] start error:", e);
      if (alive.current) setStartError("Could not reach the server. Check your connection.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [lectureSessionId, mode, showCode]);

  useEffect(() => {
    alive.current = true;
    if (!started.current) {
      started.current = true;
      begin();
    }
    return () => {
      alive.current = false;
    };
  }, [begin]);

  // ── Close + go to the final check screen ───────────────────────────────────
  const closeAndReview = useCallback(async () => {
    if (closing || !attendanceSessionId) return;
    setClosing(true);
    try {
      const res = await apiFetch(`${API_URL}/api/lectures/attendance/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lecture_session_id: lectureSessionId }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "close failed");
      leaving.current = true;
      navigation.replace("ManualMarkingScreen", {
        attendance_session_id: attendanceSessionId,
        lecture_session_id: lectureSessionId,
      });
    } catch (e) {
      console.log("[Close] error:", e);
      setClosing(false);
      Alert.alert("Could not close attendance", "Check your connection and try again. Students can still mark until it closes.");
    }
  }, [closing, attendanceSessionId, lectureSessionId, navigation]);

  // While the session is recording, back (button, gesture, header) is blocked. It unlocks once closed.
  useLiveLock(!!attendanceSessionId, leaving, "Attendance is running. Tap Close and review first.");

  // ── States ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Screen>
        <Header title={copy.title} subtitle={copy.sub} onBack={() => navigation.goBack()} />
        <ResultView
          icon="wifi"
          tone="primary"
          loading
          title={phase === "wifi" ? "Mapping the room" : "Starting attendance"}
          message={
            phase === "wifi"
              ? "Scanning Wi-Fi 3 times from where you teach. Please stay in your usual spot."
              : "Creating the session..."
          }
        />
      </Screen>
    );
  }

  if (startError) {
    return (
      <Screen>
        <Header title={copy.title} subtitle={copy.sub} onBack={() => navigation.goBack()} />
        <ResultView
          icon="alert-circle"
          tone="danger"
          title="Could not start"
          message={startError}
          actions={
            <>
              <Button label="Try again" icon="refresh" onPress={begin} />
              <Button label="Go back" variant="secondary" onPress={() => navigation.goBack()} />
            </>
          }
        />
      </Screen>
    );
  }

  const wifiGood = (wifiAps ?? 0) >= 2;

  const renderRow = (item: RosterRow, isPending: boolean) => {
    const m = methodLabel(item.method);
    return (
      <View style={st.row}>
        <Avatar name={item.name} tone={isPending ? "warning" : "success"} size={38} />
        <View style={{ flex: 1 }}>
          <Text style={font.h3} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={font.small}>
            Roll {item.roll}
            {item.ble_rssi != null ? `  ·  ${item.ble_rssi} dBm` : ""}
          </Text>
          {isPending && item.reasons.length > 0 && (
            <View style={st.reasonWrap}>
              {item.reasons.slice(0, 3).map((r) => (
                <Chip key={r} label={REASON_LABEL[r] || r} tone="warning" />
              ))}
            </View>
          )}
        </View>
        {isPending ? <Chip label="Needs check" tone="warning" /> : m ? <Chip label={m} tone="neutral" /> : null}
      </View>
    );
  };

  const header = (
    <>
      {pending.length > 0 && (
        <View style={{ marginBottom: SP.md }}>
          <Banner tone="warning" title={`${pending.length} student${pending.length === 1 ? "" : "s"} need your check`}>
            They are not counted until you confirm them on the next screen.
          </Banner>
          {pending.map((p) => (
            <View key={p.uid}>{renderRow(p, true)}</View>
          ))}
          {present.length > 0 && <View style={st.sep} />}
        </View>
      )}
    </>
  );

  return (
    <Screen>
      <Header
        title={copy.title}
        subtitle={copy.sub}
        right={<LiveBadge label={closing ? "CLOSING" : "LIVE"} tone={closing ? "warning" : "success"} />}
      />

      <View style={st.body}>
        <View style={st.pills}>
          <StatusPill
            icon="wifi"
            tone={wifiGood ? "success" : "warning"}
            label={wifiGood ? `Room mapped (${wifiAps} Wi-Fi)` : "Wi-Fi weak or off"}
          />
          <StatusPill
            icon="bluetooth"
            tone={beacon === "on" ? "success" : beacon === "error" ? "danger" : "warning"}
            busy={beacon === "starting"}
            label={beacon === "on" ? "Beacon on" : beacon === "error" ? "Beacon unavailable" : "Starting beacon"}
          />
        </View>
        <Text style={st.keepOpen}>Keep this screen open and unlocked while students mark.</Text>

        {showCode && (
          <Card style={st.codeCard}>
            <Text style={font.label}>Attendance code</Text>
            <Text style={st.code} accessibilityLabel={`Attendance code ${attendanceCode}`}>
              {attendanceCode}
            </Text>
            <Text style={[font.small, { textAlign: "center", lineHeight: 18 }]}>{copy.hint}</Text>
          </Card>
        )}

        <Card padded={false} style={st.roster}>
          <View style={st.rosterHead}>
            <Text style={font.h2}>Roster</Text>
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Chip label={`${present.length} verified`} tone="success" icon="checkmark-circle" />
              {pending.length > 0 && <Chip label={`${pending.length} to check`} tone="warning" />}
            </View>
          </View>
          <FlatList
            data={present}
            keyExtractor={(i) => i.uid}
            ListHeaderComponent={header}
            renderItem={({ item }) => renderRow(item, false)}
            contentContainerStyle={{ paddingHorizontal: SP.lg, paddingBottom: SP.md, flexGrow: 1 }}
            ListEmptyComponent={
              pending.length === 0 ? (
                <View style={st.empty}>
                  <Text style={font.h3}>Waiting for students</Text>
                  <Text style={[font.small, { marginTop: 4 }]}>Verified students appear here instantly.</Text>
                </View>
              ) : null
            }
            showsVerticalScrollIndicator={false}
          />
        </Card>
      </View>

      <View style={st.footer}>
        <Button label="Close and review" icon="stop-circle-outline" onPress={closeAndReview} loading={closing} />
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: SP.lg, paddingTop: SP.lg },
  pills: { flexDirection: "row", gap: SP.sm },
  keepOpen: { ...font.small, textAlign: "center", marginTop: SP.sm, marginBottom: SP.md },
  codeCard: { alignItems: "center", paddingVertical: SP.xl, marginBottom: SP.md, gap: 6 },
  code: { fontSize: 60, fontWeight: "900", color: T.primary, letterSpacing: 10, paddingLeft: 10, lineHeight: 72 },
  roster: { flex: 1, overflow: "hidden" },
  rosterHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: SP.lg,
    borderBottomWidth: 1,
    borderBottomColor: T.lineSoft,
  },
  row: { flexDirection: "row", alignItems: "center", gap: SP.md, paddingVertical: SP.md, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  reasonWrap: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 },
  sep: { height: 8 },
  empty: { alignItems: "center", paddingTop: SP.xxl * 1.5 },
  footer: { padding: SP.lg, paddingTop: SP.md, backgroundColor: T.bg },
});