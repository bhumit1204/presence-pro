import React, { useEffect, useState, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";

const API_URL = import.meta.env.VITE_API_URL || "";
const POLL_INTERVAL = 5000;

export default function QRDisplay() {
  const urlToken = new URLSearchParams(window.location.search).get("token");

  const [screen,      setScreen]      = useState(urlToken ? "qr" : "enter_code");
  const [activeToken, setActiveToken] = useState(urlToken || "");

  const handleCodeConfirmed = (token) => {
    setActiveToken(token);
    setScreen("qr");
  };

  if (screen === "enter_code") {
    return <CodeEntryScreen onConfirm={handleCodeConfirmed} />;
  }

  return <LiveQRScreen token={activeToken} />;
}

// ─── Code Entry Screen ────────────────────────────────────────────────────────
function CodeEntryScreen({ onConfirm }) {
  const [code,    setCode]    = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const inputRef = useRef(null);

  const handleSubmit = async () => {
    const trimmed = code.trim();
    if (trimmed.length !== 8 || isNaN(Number(trimmed))) {
      setError("Please enter the 8-digit code from the teacher's phone.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res  = await fetch(`${API_URL}/api/lectures/attendance/qr-live?code=${trimmed}`);
      const data = await res.json();

      if (!data.success) {
        setError("Code not found or session has ended. Try again.");
        return;
      }

      if (data.status === "closed") {
        setError("This session is already closed.");
        return;
      }

      onConfirm(`__code__${trimmed}`);

    } catch (e) {
      console.error("CODE LOOKUP ERROR:", e);
      setError("Could not connect to server. Check your connection.");
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter") handleSubmit();
  };

  return (
    <Screen bg="#F0F2FA">
      <div style={styles.codeEntryCard}>
        <div style={styles.brand}>
          <div style={styles.brandDot} />
          <span style={styles.brandText}>PresencePro</span>
        </div>

        <h1 style={styles.codeTitle}>Enter Session Code</h1>
        <p style={styles.codeSub}>
          Ask your teacher for the 8-digit code shown on their phone,
          or open the direct link they shared.
        </p>

        {/* Digit boxes + hidden real input */}
        <div
          style={styles.digitRowWrap}
          onClick={() => inputRef.current?.focus()}
        >
          <div style={styles.digitRow}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                style={{
                  ...styles.digitBox,
                  borderColor: error
                    ? "#F05454"
                    : code[i]
                    ? "#6C5CE7"
                    : "#E8EBF2",
                  background: code[i] ? "#EEF2FF" : "#F7F8FC",
                }}
              >
                <span style={styles.digitChar}>{code[i] || ""}</span>
              </div>
            ))}
          </div>
          <input
            ref={inputRef}
            style={styles.hiddenInput}
            type="text"
            inputMode="numeric"
            maxLength={8}
            value={code}
            onChange={(e) => {
              setError("");
              setCode(e.target.value.replace(/\D/g, "").slice(0, 8));
            }}
            onKeyDown={handleKey}
            autoFocus
          />
        </div>

        {error
          ? <p style={styles.errorMsg}>{error}</p>
          : <p style={styles.hintMsg}>Tap above and type the 8-digit code</p>
        }

        <button
          style={{
            ...styles.submitBtn,
            opacity: loading || code.length < 8 ? 0.5 : 1,
            cursor:  loading || code.length < 8 ? "not-allowed" : "pointer",
          }}
          onClick={handleSubmit}
          disabled={loading || code.length < 8}
        >
          {loading ? "Checking…" : "Start QR Display →"}
        </button>
      </div>
    </Screen>
  );
}

// ─── Live QR Screen ───────────────────────────────────────────────────────────
function LiveQRScreen({ token }) {
  const isCodeMode = token.startsWith("__code__");
  const codeValue  = isCodeMode ? token.replace("__code__", "") : null;
  const tokenValue = isCodeMode ? null : token;

  const [qrValue,             setQrValue]             = useState(null);
  const [expiresIn,           setExpiresIn]           = useState(5);
  const [countdown,           setCountdown]           = useState(5);
  const [status,              setStatus]              = useState("loading");
  const [stopping,            setStopping]            = useState(false);
  const [attendanceSessionId, setAttendanceSessionId] = useState(null);
  const [lectureSessionId,    setLectureSessionId]    = useState(null);

  const pollRef      = useRef(null);
  const countdownRef = useRef(null);

  const fetchQR = useCallback(async () => {
    try {
      const url = tokenValue
        ? `${API_URL}/api/lectures/attendance/qr-live?token=${tokenValue}`
        : `${API_URL}/api/lectures/attendance/qr-live?code=${codeValue}`;

      const res  = await fetch(url);
      const data = await res.json();

      if (!data.success) { setStatus("error"); return; }

      if (data.status === "closed") {
        setStatus("closed");
        clearInterval(pollRef.current);
        clearInterval(countdownRef.current);
        return;
      }

      if (data.attendance_session_id) {
        setAttendanceSessionId((prev) => prev || data.attendance_session_id);
      }
      // Use lecture_session_id from API response (returned by fixed backend)
      if (data.lecture_session_id) {
        setLectureSessionId((prev) => prev || data.lecture_session_id);
      }

      setQrValue(data.qr_value);
      setExpiresIn(5);                      // always 5s window
      setCountdown(data.expires_in ?? 5);   // remaining seconds in this window
      setStatus("open");

      clearInterval(countdownRef.current);
      let c = data.expires_in ?? 5;
      countdownRef.current = setInterval(() => {
        c -= 1;
        setCountdown(c > 0 ? c : 0);
        if (c <= 0) clearInterval(countdownRef.current);
      }, 1000);

    } catch (err) {
      console.error("QR POLL ERROR:", err);
      setStatus("error");
    }
  }, [tokenValue, codeValue]);

  useEffect(() => {
    fetchQR();
    pollRef.current = setInterval(fetchQR, POLL_INTERVAL);
    return () => {
      clearInterval(pollRef.current);
      clearInterval(countdownRef.current);
    };
  }, [fetchQR]);

  const handleStop = async () => {
    if (!window.confirm("Stop QR marking? Students will no longer be able to scan.")) return;
    if (!attendanceSessionId) {
      alert("Session ID not available. Use the Stop button on the teacher's phone.");
      return;
    }
    setStopping(true);
    try {
      const res  = await fetch(`${API_URL}/api/lectures/attendance/close-qr`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          attendance_session_id: attendanceSessionId,
          lecture_session_id:    lectureSessionId || attendanceSessionId,
        }),
      });
      const data = await res.json();
      if (data.success || data.already_closed) {
        clearInterval(pollRef.current);
        clearInterval(countdownRef.current);
        setStatus("closed");
      }
    } catch (e) {
      alert("Could not stop session. Please use the Stop button on the teacher's phone.");
    } finally {
      setStopping(false);
    }
  };

  // Ring — 5s step
  const progress      = expiresIn > 0 ? countdown / expiresIn : 0;
  const circumference = 2 * Math.PI * 44;
  const dashOffset    = circumference * (1 - progress);
  const ringColor     = countdown <= 2 ? "#F05454" : "#6C5CE7";

  if (status === "loading") {
    return (
      <Screen bg="#F7F8FC">
        <div style={styles.center}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>Connecting to session…</p>
        </div>
      </Screen>
    );
  }

  if (status === "closed") {
    return (
      <Screen bg="#F7F8FC">
        <div style={styles.closedCard}>
          <div style={{ fontSize: 56 }}>🔒</div>
          <p style={styles.closedTitle}>Session Closed</p>
          <p style={styles.closedSub}>The teacher has ended attendance marking.</p>
        </div>
      </Screen>
    );
  }

  if (status === "error") {
    return (
      <Screen bg="#F7F8FC">
        <div style={styles.center}>
          <div style={{ fontSize: 48 }}>❌</div>
          <p style={{ color: "#F05454", fontWeight: 700, fontSize: 18 }}>Session Not Found</p>
          <p style={{ color: "#8A94A6", fontSize: 14 }}>This code may be invalid or expired.</p>
          <button style={styles.retryBtn} onClick={fetchQR}>Retry</button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen bg="#1C2333">
      <div style={styles.liveBadge}>
        <div style={styles.liveDot} />
        <span style={styles.liveLabel}>LIVE SESSION</span>
      </div>

      <p style={styles.bigTitle}>Scan to Mark Attendance</p>
      <p style={styles.bigSub}>Open PresencePro app → Scan QR</p>

      <div style={styles.bigQRCard}>
        {qrValue ? (
          <QRCodeSVG value={qrValue} size={300} bgColor="#ffffff" fgColor="#1a1a2e" level="M" />
        ) : (
          <div style={{ width: 300, height: 300, background: "#F3F4F6", borderRadius: 12 }} />
        )}
      </div>

      <div style={styles.ringWrap}>
        <svg width={100} height={100} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={50} cy={50} r={44} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={6} />
          <circle
            cx={50} cy={50} r={44}
            fill="none"
            stroke={ringColor}
            strokeWidth={6}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s" }}
          />
        </svg>
        <div style={{ ...styles.ringNumber, color: ringColor }}>{countdown}</div>
      </div>
      <p style={styles.ringNote}>QR rotates every 5 seconds</p>

      <button
        style={{ ...styles.stopBtn, opacity: stopping ? 0.6 : 1, cursor: stopping ? "not-allowed" : "pointer" }}
        onClick={handleStop}
        disabled={stopping}
      >
        {stopping ? "Stopping…" : "🔒  Stop Marking"}
      </button>
    </Screen>
  );
}

function Screen({ children, bg = "#F7F8FC" }) {
  return <div style={{ ...styles.screen, background: bg }}>{children}</div>;
}

const styles = {
  screen: {
    minHeight: "100vh", width: "100%",
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
    padding: "40px 20px", boxSizing: "border-box",
  },

  // Code entry
  codeEntryCard: {
    background: "#FFFFFF", borderRadius: 24,
    padding: "40px 36px", maxWidth: 460, width: "100%",
    boxShadow: "0 8px 32px rgba(108,92,231,0.08)",
    border: "1px solid #E8EBF2",
    display: "flex", flexDirection: "column", alignItems: "center",
  },
  brand: {
    display: "flex", alignItems: "center", gap: 8,
    marginBottom: 28, backgroundColor: "#EEF2FF",
    padding: "6px 16px", borderRadius: 100,
  },
  brandDot:  { width: 8, height: 8, borderRadius: "50%", background: "#6C5CE7" },
  brandText: { color: "#6C5CE7", fontWeight: 700, fontSize: 13, letterSpacing: 0.5 },
  codeTitle: { fontSize: 26, fontWeight: 800, color: "#1C2333", margin: "0 0 10px", textAlign: "center" },
  codeSub:   { fontSize: 14, color: "#8A94A6", textAlign: "center", margin: "0 0 28px", lineHeight: 1.6 },

  // Digit boxes
  digitRowWrap: {
    position: "relative",
    width: "100%",
    display: "flex",
    justifyContent: "center",
    cursor: "text",
  },
  digitRow: { display: "flex", gap: 8 },
  digitBox: {
    width: 44, height: 56, borderRadius: 12,
    border: "2px solid #E8EBF2",
    display: "flex", alignItems: "center", justifyContent: "center",
    transition: "border-color 0.2s, background 0.2s",
  },
  digitChar: { fontSize: 24, fontWeight: 800, color: "#1C2333", fontFamily: "monospace" },

  // Hidden input covers the digit row to capture keypresses
  hiddenInput: {
    position: "absolute", top: 0, left: 0,
    width: "100%", height: "100%",
    opacity: 0, cursor: "text",
    fontSize: 1, border: "none", outline: "none",
    background: "transparent",
  },

  errorMsg: { color: "#F05454", fontSize: 13, fontWeight: 600, margin: "10px 0 4px", textAlign: "center" },
  hintMsg:  { color: "#C2C9D6", fontSize: 12, fontWeight: 500, margin: "10px 0 4px", textAlign: "center" },
  submitBtn: {
    width: "100%", background: "linear-gradient(135deg, #6C5CE7, #8B7CF8)",
    color: "#FFF", border: "none", borderRadius: 50,
    padding: "16px 24px", fontSize: 16, fontWeight: 800, marginTop: 16,
  },

  // Live QR
  liveBadge: {
    display: "flex", alignItems: "center", gap: 8,
    backgroundColor: "rgba(0,179,126,0.15)",
    padding: "8px 18px", borderRadius: 100, marginBottom: 24,
  },
  liveDot:  { width: 10, height: 10, borderRadius: "50%", background: "#00B37E", boxShadow: "0 0 8px rgba(0,179,126,0.6)" },
  liveLabel: { color: "#00B37E", fontWeight: 800, fontSize: 12, letterSpacing: 2 },
  bigTitle: { color: "#FFFFFF", fontSize: 32, fontWeight: 900, margin: "0 0 8px", textAlign: "center", letterSpacing: -0.5 },
  bigSub:   { color: "rgba(255,255,255,0.5)", fontSize: 15, margin: "0 0 32px", textAlign: "center" },
  bigQRCard: {
    background: "#FFFFFF", borderRadius: 28, padding: 28,
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
    marginBottom: 32, border: "1px solid rgba(255,255,255,0.1)",
  },
  ringWrap:   { position: "relative", width: 100, height: 100, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 10 },
  ringNumber: { position: "absolute", fontSize: 28, fontWeight: 900 },
  ringNote:   { color: "rgba(255,255,255,0.4)", fontSize: 13, marginBottom: 28 },
  stopBtn: {
    background: "rgba(240,84,84,0.15)", color: "#F05454",
    border: "1.5px solid rgba(240,84,84,0.3)", borderRadius: 50,
    padding: "14px 32px", fontSize: 15, fontWeight: 800,
  },

  // States
  center:      { display: "flex", flexDirection: "column", alignItems: "center", gap: 16 },
  spinner:     { width: 48, height: 48, border: "4px solid #E8EBF2", borderTop: "4px solid #6C5CE7", borderRadius: "50%", animation: "spin 0.9s linear infinite" },
  loadingText: { color: "#8A94A6", fontSize: 14 },
  closedCard:  { background: "#FFFFFF", padding: 40, borderRadius: 24, textAlign: "center", boxShadow: "0 8px 32px rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
  closedTitle: { color: "#1C2333", fontSize: 24, fontWeight: 800, margin: 0 },
  closedSub:   { color: "#8A94A6", fontSize: 14, margin: 0 },
  retryBtn:    { background: "#6C5CE7", color: "#FFF", border: "none", borderRadius: 14, padding: "12px 24px", fontSize: 14, fontWeight: 700, cursor: "pointer", marginTop: 8 },
};