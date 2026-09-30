import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  Clipboard,
  Animated,
  Easing,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, useNavigation } from "@react-navigation/native";
import QRCode from "react-native-qrcode-svg";
import Ionicons from "@expo/vector-icons/Ionicons";

// ─── Palette (light theme, consistent with app) ─────────────────────────────
const C = {
  bg:         "#F7F8FC",
  card:       "#FFFFFF",
  navy:       "#1C2333",
  ink:        "#1C2333",
  muted:      "#8A94A6",
  border:     "#E8EBF2",
  violet:     "#6C5CE7",
  violetSoft: "#EEF2FF",
  jade:       "#00B37E",
  jadeSoft:   "#E6F9F4",
  coral:      "#F05454",
  coralSoft:  "#FEECEC",
  amber:      "#F0A500",
};

const API_URL  = "http://10.132.90.56:5000";
const POLL_MS  = 5000; // poll every 5 seconds for QR refresh

export default function QRAttendanceScreen() {
  const route      = useRoute<any>();
  const navigation = useNavigation<any>();

  // These params come from TeacherHome after calling /attendance/start-qr
  const {
    lecture_session_id,
    attendance_session_id,
    qr_token,
    qr_link,
    display_code,
  } = route.params as {
    lecture_session_id:    string;
    attendance_session_id: string;
    qr_token:              string;
    qr_link:               string;
    display_code:          string;  // 8-digit code
  };

  const [qrValue,    setQrValue]    = useState<string | null>(null);
  const [expiresIn,  setExpiresIn]  = useState(5);
  const [countdown,  setCountdown]  = useState(5);
  const [status,     setStatus]     = useState<"loading" | "open" | "closed" | "error">("loading");
  const [showQR,     setShowQR]     = useState(false);   // toggle QR on phone
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [closing,    setClosing]    = useState(false);

  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pulse on QR refresh
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const prevQrRef = useRef<string | null>(null);

  const triggerPulse = () => {
    Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 0.94, duration: 100, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
      Animated.timing(pulseAnim, { toValue: 1,    duration: 200, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
    ]).start();
  };

  // ── Fetch live QR from backend ────────────────────────────────────────────
  const fetchQR = useCallback(async () => {
    try {
      const res  = await fetch(`${API_URL}/api/lectures/attendance/qr-live?token=${qr_token}`);
      const data = await res.json();

      if (!data.success) {
        setStatus("error");
        return;
      }

      if (data.status === "closed") {
        setStatus("closed");
        clearInterval(pollRef.current!);
        clearInterval(countdownRef.current!);
        return;
      }

      // Pulse only when QR value actually changes
      if (prevQrRef.current && data.qr_value !== prevQrRef.current) {
        triggerPulse();
      }
      prevQrRef.current = data.qr_value;

      setQrValue(data.qr_value);
      setExpiresIn(data.expires_in);
      setCountdown(data.expires_in);
      setStatus("open");

      // Reset countdown timer
      clearInterval(countdownRef.current!);
      let c = data.expires_in;
      countdownRef.current = setInterval(() => {
        c -= 1;
        setCountdown(c > 0 ? c : 0);
        if (c <= 0) clearInterval(countdownRef.current!);
      }, 1000);

    } catch (err) {
      console.error("QR POLL ERROR:", err);
      setStatus("error");
    }
  }, [qr_token]);

  useEffect(() => {
    fetchQR();
    pollRef.current = setInterval(fetchQR, POLL_MS);
    return () => {
      clearInterval(pollRef.current!);
      clearInterval(countdownRef.current!);
    };
  }, [fetchQR]);

  // ── Copy helpers ─────────────────────────────────────────────────────────
  const copyCode = () => {
    Clipboard.setString(display_code);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  const copyLink = () => {
    Clipboard.setString(qr_link);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  // ── Close session → ManualMarking ─────────────────────────────────────────
  const handleClose = () => {
    Alert.alert(
      "Stop QR Marking?",
      "This will close the QR session..",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Stop",
          style: "destructive",
          onPress: async () => {
            setClosing(true);
            try {
              const res  = await fetch(`${API_URL}/api/lectures/attendance/close-qr`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ attendance_session_id, lecture_session_id }),
              });
              const data = await res.json();

              if (!data.success && !data.already_closed) {
                Alert.alert("Error", data.error || "Failed to close session");
                return;
              }

              clearInterval(pollRef.current!);
              clearInterval(countdownRef.current!);
              setStatus("closed");

              navigation.navigate("ManualMarkingScreen", {
                attendance_session_id: attendance_session_id,
                lecture_session_id: lecture_session_id,
              });

            } catch (e) {
              Alert.alert("Error", "Could not close session. Check connection.");
            } finally {
              setClosing(false);
            }
          },
        },
      ]
    );
  };

  // ── Countdown ring progress ───────────────────────────────────────────────
  const progress = expiresIn > 0 ? countdown / expiresIn : 0;
  const ringColor = countdown <= 3 ? C.coral : C.violet;

  // ── Loading / Error / Closed states ──────────────────────────────────────
  if (status === "loading") {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}>
          <ActivityIndicator size="large" color={C.violet} />
          <Text style={S.mutedText}>Connecting to QR session…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (status === "error") {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}>
          <Text style={S.stateEmoji}>⚠️</Text>
          <Text style={[S.stateTitle, { color: C.coral }]}>Connection Error</Text>
          <Text style={S.mutedText}>Could not load QR. Check your network.</Text>
          <TouchableOpacity style={S.retryBtn} onPress={fetchQR}>
            <Text style={S.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (status === "closed") {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.center}>
          <Text style={S.stateEmoji}>🔒</Text>
          <Text style={S.stateTitle}>Session Closed</Text>
          <Text style={S.mutedText}>QR marking has ended.</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={S.scroll}
        showsVerticalScrollIndicator={false}
      >

        {/* ── Header ─────────────────────────────────────────────────── */}
        <View style={S.header}>
          <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
            <Ionicons name="arrow-back" size={18} color={C.muted} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={S.headerTitle}>QR Attendance</Text>
            <Text style={S.headerSub}>Share the code or link below</Text>
          </View>
          {/* Live pill */}
          <View style={S.livePill}>
            <View style={S.liveDot} />
            <Text style={S.liveText}>LIVE</Text>
          </View>
        </View>

        {/* ── 8-Digit Code card ───────────────────────────────────────── */}
        <View style={S.codeCard}>
          <Text style={S.codeEyebrow}>Session Code</Text>
          <Text style={S.codeDigits}>{display_code}</Text>
          <Text style={S.codeInstruction}>
            Students enter this on the web app to see the QR screen
          </Text>
          <TouchableOpacity style={S.copyCodeBtn} onPress={copyCode}>
            <Ionicons
              name={codeCopied ? "checkmark" : "copy-outline"}
              size={15}
              color={C.violet}
            />
            <Text style={S.copyCodeText}>
              {codeCopied ? "Copied!" : "Copy Code"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── Instructions card ───────────────────────────────────────── */}
        <View style={S.instructCard}>
          <View style={S.instructRow}>
            <View style={S.instructNum}><Text style={S.instructNumText}>1</Text></View>
            <Text style={S.instructText}>
              Open the web app at{" "}
              <Text style={{ color: C.violet, fontWeight: "700" }}>
                {qr_link.split("/?")[0]}
              </Text>
            </Text>
          </View>
          <View style={S.instructRow}>
            <View style={S.instructNum}><Text style={S.instructNumText}>2</Text></View>
            <Text style={S.instructText}>
              Enter the 8-digit code{" "}
              <Text style={{ color: C.ink, fontWeight: "800" }}>{display_code}</Text>{" "}
              to start the QR display
            </Text>
          </View>
          <View style={S.instructRow}>
            <View style={S.instructNum}><Text style={S.instructNumText}>3</Text></View>
            <Text style={S.instructText}>
              Or copy the direct link below and paste it in any browser
            </Text>
          </View>
        </View>

        {/* ── Direct link ─────────────────────────────────────────────── */}
        <View style={S.linkCard}>
          <Text style={S.linkLabel}>Direct Link</Text>
          <View style={S.linkRow}>
            <Text style={S.linkText} numberOfLines={1} ellipsizeMode="middle">
              {qr_link}
            </Text>
            <TouchableOpacity style={S.copyLinkBtn} onPress={copyLink}>
              <Text style={S.copyLinkText}>
                {linkCopied ? "✓" : "Copy"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Show QR on phone toggle ──────────────────────────────────── */}
        <TouchableOpacity
          style={S.toggleQRBtn}
          onPress={() => setShowQR((v) => !v)}
          activeOpacity={0.8}
        >
          <Ionicons
            name={showQR ? "eye-off-outline" : "qr-code-outline"}
            size={18}
            color={C.violet}
          />
          <Text style={S.toggleQRText}>
            {showQR ? "Hide QR on Phone" : "Show QR on Phone"}
          </Text>
          <Ionicons
            name={showQR ? "chevron-up" : "chevron-down"}
            size={16}
            color={C.muted}
            style={{ marginLeft: "auto" }}
          />
        </TouchableOpacity>

        {/* ── QR on phone (collapsible) ────────────────────────────────── */}
        {showQR && (
          <View style={S.qrSection}>
            <Animated.View style={[S.qrCard, { transform: [{ scale: pulseAnim }] }]}>
              {qrValue ? (
                <QRCode
                  value={qrValue}
                  size={220}
                  color="#1a1a2e"
                  backgroundColor="#ffffff"
                  quietZone={14}
                />
              ) : (
                <View style={S.qrPlaceholder} />
              )}
            </Animated.View>

            {/* Countdown ring */}
            <View style={S.ringWrap}>
              <View style={[S.ringTrack]} />
              <View style={[S.ringFill, { borderTopColor: ringColor, transform: [{ rotate: `${(1 - progress) * 360}deg` }] }]} />
              <Text style={[S.ringNumber, { color: ringColor }]}>{countdown}</Text>
            </View>
            <Text style={S.ringNote}>QR rotates every 5 seconds</Text>
          </View>
        )}

        {/* ── Stop marking button ──────────────────────────────────────── */}
        <TouchableOpacity
          style={[S.stopBtn, closing && { opacity: 0.6 }]}
          onPress={handleClose}
          disabled={closing}
          activeOpacity={0.85}
        >
          {closing ? (
            <ActivityIndicator color={C.coral} size="small" />
          ) : (
            <>
              <Ionicons name="stop-circle-outline" size={20} color={C.coral} />
              <Text style={S.stopBtnText}>Stop Marking</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 16, paddingTop: 20 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 20,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: C.card,
    borderWidth: 1, borderColor: C.border,
    justifyContent: "center", alignItems: "center",
  },
  headerTitle: { fontSize: 18, fontWeight: "800", color: C.ink },
  headerSub:   { fontSize: 12, color: C.muted, marginTop: 1 },

  // Live pill
  livePill: {
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: C.jadeSoft,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.jade },
  liveText: { color: C.jade, fontWeight: "800", fontSize: 11, letterSpacing: 0.5 },

  // 8-digit code card
  codeCard: {
    backgroundColor: C.card,
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    borderWidth: 1, borderColor: C.border,
    marginBottom: 12,
    shadowColor: C.violet,
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  codeEyebrow: {
    fontSize: 11, fontWeight: "700", color: C.muted,
    textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 12,
  },
  codeDigits: {
    fontSize: 48,
    fontWeight: "900",
    color: C.ink,
    letterSpacing: 8,
    fontVariant: ["tabular-nums"] as any,
  },
  codeInstruction: {
    fontSize: 13, color: C.muted, textAlign: "center",
    marginTop: 10, lineHeight: 18, fontWeight: "500",
  },
  copyCodeBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    marginTop: 16,
    backgroundColor: C.violetSoft,
    paddingHorizontal: 18, paddingVertical: 10,
    borderRadius: 20,
  },
  copyCodeText: { fontSize: 13, fontWeight: "700", color: C.violet },

  // Instructions
  instructCard: {
    backgroundColor: C.card,
    borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: C.border,
    marginBottom: 12, gap: 14,
  },
  instructRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  instructNum: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: C.violetSoft,
    justifyContent: "center", alignItems: "center",
    marginTop: 1,
  },
  instructNumText: { fontSize: 12, fontWeight: "800", color: C.violet },
  instructText: { flex: 1, fontSize: 13, color: C.muted, fontWeight: "500", lineHeight: 19 },

  // Direct link
  linkCard: {
    backgroundColor: C.card,
    borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: C.border,
    marginBottom: 12,
  },
  linkLabel: { fontSize: 11, fontWeight: "700", color: C.muted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.8 },
  linkRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: C.bg, borderRadius: 10,
    padding: 10, borderWidth: 1, borderColor: C.border,
  },
  linkText: { flex: 1, fontSize: 12, color: C.muted, fontFamily: "monospace" },
  copyLinkBtn: {
    backgroundColor: C.violet, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  copyLinkText: { color: "#FFF", fontWeight: "700", fontSize: 12 },

  // Show QR toggle
  toggleQRBtn: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: C.card,
    borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: C.border,
    marginBottom: 12,
  },
  toggleQRText: { fontSize: 14, fontWeight: "700", color: C.violet, flex: 1 },

  // QR section
  qrSection: { alignItems: "center", marginBottom: 12 },
  qrCard: {
    backgroundColor: C.card,
    borderRadius: 24, padding: 24,
    alignItems: "center", justifyContent: "center",
    shadowColor: C.violet, shadowOpacity: 0.08,
    shadowRadius: 20, shadowOffset: { width: 0, height: 8 },
    elevation: 4,
    borderWidth: 1, borderColor: C.border,
    marginBottom: 16,
  },
  qrPlaceholder: { width: 220, height: 220, backgroundColor: C.bg, borderRadius: 12 },

  // Countdown ring
  ringWrap:   { width: 64, height: 64, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  ringTrack:  { position: "absolute", width: 54, height: 54, borderRadius: 27, borderWidth: 5, borderColor: C.border },
  ringFill:   {
    position: "absolute", width: 54, height: 54, borderRadius: 27,
    borderWidth: 5,
    borderTopColor: C.violet,
    borderRightColor: "transparent",
    borderBottomColor: "transparent",
    borderLeftColor: "transparent",
  },
  ringNumber: { fontSize: 18, fontWeight: "800" },
  ringNote:   { fontSize: 12, color: C.muted, marginBottom: 8 },

  // Stop button
  stopBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    backgroundColor: C.coralSoft,
    borderRadius: 18, paddingVertical: 18,
    borderWidth: 1.5, borderColor: "#FECACA",
    marginTop: 4,
  },
  stopBtnText: { color: C.coral, fontWeight: "800", fontSize: 15 },

  // State screens
  stateEmoji: { fontSize: 48, marginBottom: 8 },
  stateTitle: { fontSize: 20, fontWeight: "800", color: C.ink },
  mutedText:  { fontSize: 14, color: C.muted, textAlign: "center" },
  retryBtn: {
    backgroundColor: C.violet, borderRadius: 14,
    paddingHorizontal: 24, paddingVertical: 12, marginTop: 8,
  },
  retryText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
});