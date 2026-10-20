// Student marking screen for the three "in-room" methods:
//   mode="code"          → pick the right code
//   mode="bio_wifi_ble"  → biometric
//   mode="multi"         → pick the right code  OR  use biometric
// The room check (Wi-Fi fingerprint + BLE + rotating token) runs for all of them; the server answers
// verified (counted), unverified (teacher must confirm - not counted yet) or rejected.

import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "../../../services/api";
import { getUserSession } from "../../../services/session";
import { API_URL, REASON_LABEL, MarkOutcome, collectStudentSignals, postMark } from "../../../utils/proximity";
import {
  Banner,
  Button,
  Card,
  Chip,
  Divider,
  Header,
  IconBadge,
  ProgressBar,
  R,
  ResultView,
  Screen,
  SectionLabel,
  SP,
  Steps,
  T,
  Tone,
  font,
} from "../../../components/ui";

export type MarkMode = "code" | "bio_wifi_ble" | "multi";

type Phase = "loading" | "select" | "running" | "pending" | "error" | "success";
type Step = "bio" | "scan" | "submit";
type IconName = React.ComponentProps<typeof Ionicons>["name"];

const ERROR_CONFIG: Record<string, { icon: IconName; tone: Tone; title: string; action: string; button?: string }> = {
  wrong_code: { icon: "close-circle", tone: "danger", title: "Wrong code", action: "Check the code your teacher is showing.", button: "Choose again" },
  no_signal: { icon: "wifi", tone: "danger", title: "No signal", action: "Turn on Wi-Fi, Bluetooth and Location, then retry." },
  too_far: { icon: "walk", tone: "danger", title: "Too far from the teacher", action: "Move closer to the teacher and retry." },
  closed: { icon: "lock-closed", tone: "danger", title: "Attendance is closed", action: "Contact your teacher.", button: "Go back" },
  reviewed: { icon: "person-circle", tone: "warning", title: "Already reviewed", action: "Your teacher has already decided.", button: "Go back" },
  method_disabled: { icon: "ban", tone: "danger", title: "Method not available", action: "Go back and open attendance again.", button: "Go back" },
  generic: { icon: "alert-circle", tone: "danger", title: "Could not verify", action: "Please try again." },
};

const TITLES: Record<MarkMode, { title: string; sub: string }> = {
  code: { title: "Mark attendance", sub: "Select the code" },
  bio_wifi_ble: { title: "Mark attendance", sub: "Biometric check" },
  multi: { title: "Mark attendance", sub: "Code or biometric" },
};

export default function ProximityMarkingScreen({ mode }: { mode: MarkMode }) {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const { lectureSessionId, attendanceSessionId: attFromRoute } = route.params || {};

  const needsCode = mode !== "bio_wifi_ble";
  const allowsBio = mode !== "code";

  const [phase, setPhase] = useState<Phase>(needsCode ? "loading" : "select");
  const [options, setOptions] = useState<string[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [attendanceSessionId, setAttendanceSessionId] = useState<string | null>(attFromRoute || null);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<{ type: string; message: string } | null>(null);
  const [pending, setPending] = useState<{ message: string; reasons: string[] } | null>(null);
  const [okMessage, setOkMessage] = useState("");
  const [viaBio, setViaBio] = useState(false);
  const [progress, setProgress] = useState(0);
  const alive = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadOptions = async () => {
    setPhase("loading");
    try {
      const res = await apiFetch(`${API_URL}/api/lectures/attendance/code-options?lecture_session_id=${lectureSessionId}`);
      const data = await res.json();
      if (!alive.current) return;
      if (!data.success) {
        setError({ type: "closed", message: "Attendance is not open right now." });
        setPhase("error");
        return;
      }
      setOptions(data.options || []);
      setAttendanceSessionId(data.attendance_session_id);
      setPhase("select");
    } catch {
      if (!alive.current) return;
      setError({ type: "generic", message: "Could not load attendance options. Check your connection." });
      setPhase("error");
    }
  };

  useEffect(() => {
    if (needsCode) loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (o: MarkOutcome) => {
    setProgress(1);
    if (o.kind === "verified") {
      setOkMessage(o.already ? "Your attendance was already recorded." : "You are all set for today's class.");
      setPhase("success");
    } else if (o.kind === "pending") {
      setPending({ message: o.message, reasons: o.reasons });
      setPhase("pending");
    } else {
      setError({ type: o.errorType, message: o.message });
      setPhase("error");
    }
  };

  /** kind: which button the student pressed */
  const run = async (kind: "code" | "bio") => {
    if (busy.current) return;
    if (kind === "code" && !selectedCode) return;
    busy.current = true;
    setPhase("running");
    setError(null);
    setViaBio(kind === "bio");
    setProgress(0.05);

    try {
      if (kind === "bio") {
        setStep("bio");
        const hasHw = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        if (!alive.current) return;
        if (!hasHw || !enrolled) {
          setError({ type: "generic", message: "Biometric authentication is not set up on this device." });
          setPhase("error");
          return;
        }
        const auth = await LocalAuthentication.authenticateAsync({
          promptMessage: "Authenticate to mark attendance",
          fallbackLabel: "Use passcode",
        });
        if (!alive.current) return;
        if (!auth.success) {
          setError({ type: "generic", message: "Identity verification failed. Please try again." });
          setPhase("error");
          return;
        }
      }
      setProgress(0.25);

      setStep("scan");
      const sig = await collectStudentSignals(5000);
      if (!alive.current) return;
      setProgress(0.75);

      setStep("submit");
      const session = await getUserSession();
      const uid = session?.uid;
      if (!uid) {
        setError({ type: "generic", message: "Session expired. Please log in again." });
        setPhase("error");
        return;
      }

      const common = {
        attendance_session_id: attendanceSessionId,
        uid,
        student_wifi_scan: sig.student_wifi_scan,
        wifi_fresh: sig.wifi_fresh,
        ble_rssi: sig.ble_rssi,
        ble_rssi_max: sig.ble_rssi_max,
        ble_samples: sig.ble_samples,
        ble_tokens: sig.ble_tokens,
      };

      const outcome =
        kind === "code"
          ? await postMark("mark-code", { ...common, selected_code: selectedCode })
          : await postMark("mark-bio", { ...common, device_signature: `${uid}_${attendanceSessionId}_${Date.now()}` });
      if (!alive.current) return;

      if (outcome.kind === "error" && outcome.errorType === "wrong_code") setSelectedCode(null);
      finish(outcome);
    } catch (e) {
      console.log("[Marking] error:", e);
      if (alive.current) {
        setError({ type: "generic", message: "Something went wrong. Please try again." });
        setPhase("error");
      }
    } finally {
      busy.current = false;
    }
  };

  const backToStart = () => {
    setError(null);
    setPending(null);
    setProgress(0);
    setPhase("select");
  };

  const stepList = [
    ...(viaBio ? [{ key: "bio" as Step, label: "Identity", icon: "finger-print" as IconName }] : []),
    { key: "scan" as Step, label: "Room check", icon: "wifi" as IconName },
    { key: "submit" as Step, label: "Submit", icon: "cloud-upload" as IconName },
  ];
  const stepIdx = Math.max(0, stepList.findIndex((x) => x.key === step));
  const head = TITLES[mode];

  const goBack = () => navigation.goBack();

  /* ───────── states ───────── */

  if (phase === "loading") {
    return (
      <Screen>
        <Header title={head.title} subtitle={head.sub} onBack={goBack} />
        <ResultView icon="time" tone="primary" loading title="Loading" message="Getting this session's details..." />
      </Screen>
    );
  }

  if (phase === "running") {
    return (
      <Screen>
        <Header title={head.title} subtitle="Checking you are in the room" />
        <View style={st.center}>
          <Card style={{ width: "100%", gap: SP.xl }}>
            <View style={{ alignItems: "center", gap: SP.md }}>
              <IconBadge icon="shield-checkmark" tone="primary" size={72} loading />
              <Text style={font.h2}>Verifying</Text>
            </View>
            <ProgressBar value={progress} />
            <Steps steps={stepList.map((x) => ({ label: x.label, icon: x.icon }))} current={stepIdx} />
            <Banner tone="info" icon="hand-left">
              Stay still and keep Wi-Fi and Bluetooth on.
            </Banner>
          </Card>
        </View>
      </Screen>
    );
  }

  if (phase === "success") {
    return (
      <Screen>
        <ResultView
          icon="checkmark-circle"
          tone="success"
          title="Attendance marked"
          message={okMessage}
          actions={<Button label="Done" onPress={goBack} />}
        />
      </Screen>
    );
  }

  if (phase === "pending" && pending) {
    return (
      <Screen>
        <ResultView
          icon="time"
          tone="warning"
          title="Sent to your teacher"
          message={pending.message}
          actions={
            <>
              <Button label="Try again from closer" icon="refresh" variant="primary" onPress={backToStart} />
              <Button label="Done" variant="secondary" onPress={goBack} />
            </>
          }
        >
          {pending.reasons.length > 0 && (
            <View style={st.chips}>
              {pending.reasons.slice(0, 3).map((r) => (
                <Chip key={r} label={REASON_LABEL[r] || r} tone="warning" />
              ))}
            </View>
          )}
          <Text style={[font.small, { textAlign: "center", marginTop: SP.lg }]}>
            You are not counted yet. Move closer to the teacher and mark again to be counted automatically.
          </Text>
        </ResultView>
      </Screen>
    );
  }

  if (phase === "error" && error) {
    const cfg = ERROR_CONFIG[error.type] || ERROR_CONFIG.generic;
    const leave = error.type === "closed" || error.type === "reviewed" || error.type === "method_disabled";
    return (
      <Screen>
        <ResultView
          icon={cfg.icon}
          tone={cfg.tone}
          title={cfg.title}
          message={error.message}
          actions={
            <>
              <Button
                label={cfg.button || "Try again"}
                icon={leave ? undefined : "refresh"}
                variant={cfg.tone === "danger" ? "danger" : "primary"}
                onPress={leave ? goBack : backToStart}
              />
              {!leave && <Button label="Cancel" variant="secondary" onPress={goBack} />}
            </>
          }
        >
          <Text style={[font.small, { textAlign: "center", marginTop: SP.md }]}>{cfg.action}</Text>
        </ResultView>
      </Screen>
    );
  }

  /* ───────── select ───────── */

  return (
    <Screen>
      <Header title={head.title} subtitle={head.sub} onBack={goBack} />
      <ScrollView contentContainerStyle={st.scroll} showsVerticalScrollIndicator={false}>
        <Banner tone="primary" icon="shield-checkmark" title="Room check is on">
          Wi-Fi and Bluetooth confirm you are in the room. Keep both on and stay still for about 5 seconds.
        </Banner>

        {needsCode && (
          <View style={{ marginTop: SP.xl }}>
            <SectionLabel>{mode === "multi" ? "Option 1: select the code" : "Select the code your teacher is showing"}</SectionLabel>
            {options.length === 0 ? (
              <Banner tone="warning">No codes loaded. Pull back and open attendance again.</Banner>
            ) : (
              <View style={st.codes}>
                {options.map((code) => {
                  const sel = selectedCode === code;
                  return (
                    <Pressable
                      key={code}
                      onPress={() => setSelectedCode(code)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: sel }}
                      style={({ pressed }) => [st.code, sel && st.codeSel, pressed && { opacity: 0.85 }]}
                    >
                      <Text style={[st.codeText, sel && { color: "#fff" }]}>{code}</Text>
                      {sel && <Ionicons name="checkmark-circle" size={18} color="#fff" style={st.codeTick} />}
                    </Pressable>
                  );
                })}
              </View>
            )}
            <Button label="Submit code" icon="send" onPress={() => run("code")} disabled={!selectedCode} style={{ marginTop: SP.lg }} />
          </View>
        )}

        {mode === "multi" && <Divider label="OR" />}

        {allowsBio && (
          <View style={{ marginTop: mode === "multi" ? 0 : SP.xl }}>
            {mode === "multi" && <SectionLabel>Option 2: biometric</SectionLabel>}
            <Card style={st.bioCard}>
              <IconBadge icon="finger-print" tone="success" size={64} />
              <Text style={font.h2}>Use fingerprint or face</Text>
              <Text style={[font.body, { textAlign: "center" }]}>Verify it is you, then we check you are in the room.</Text>
              <Button label="Use biometric" icon="finger-print" variant="success" onPress={() => run("bio")} style={{ alignSelf: "stretch" }} />
            </Card>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  scroll: { padding: SP.lg, paddingBottom: SP.xxl * 1.5 },
  center: { flex: 1, justifyContent: "center", padding: SP.lg },
  chips: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, marginTop: SP.lg },
  codes: { flexDirection: "row", gap: SP.md },
  code: {
    flex: 1,
    height: 84,
    borderRadius: R.lg,
    backgroundColor: T.surface,
    borderWidth: 2,
    borderColor: T.line,
    alignItems: "center",
    justifyContent: "center",
  },
  codeSel: { backgroundColor: T.primary, borderColor: T.primary },
  codeText: { fontSize: 30, fontWeight: "900", color: T.ink, letterSpacing: 4, paddingLeft: 4 },
  codeTick: { position: "absolute", top: 6, right: 6 },
  bioCard: { alignItems: "center", gap: SP.md, paddingVertical: SP.xl },
});