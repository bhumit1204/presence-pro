import React, { useEffect, useState, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { getUserSession } from "../../services/session";
import webLogo from "../../assets/web_logo.png";

const API_URL = import.meta.env.VITE_API_URL || "";
const POLL_INTERVAL = 5000;

/* ───────────────────────── page ───────────────────────── */

export default function QRDisplay() {
  const urlToken = new URLSearchParams(window.location.search).get("token");

  const [screen, setScreen] = useState(urlToken ? "qr" : "enter_code");
  const [activeToken, setActiveToken] = useState(urlToken || "");

  const handleCodeConfirmed = (token) => {
    setActiveToken(token);
    setScreen("qr");
  };

  return (
    <>
      <style>{CSS}</style>
      {screen === "enter_code" ? <CodeEntryScreen onConfirm={handleCodeConfirmed} /> : <LiveQRScreen token={activeToken} />}
    </>
  );
}

/* A signed-in teacher gets a way back to the dashboard; a classroom PC that is not signed in does not. */
function useSignedIn() {
  try {
    return !!getUserSession();
  } catch {
    return false;
  }
}

/* ───────────────────────── code entry ───────────────────────── */

function CodeEntryScreen({ onConfirm }) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState(true);
  const inputRef = useRef(null);
  const signedIn = useSignedIn();

  const handleSubmit = async () => {
    const trimmed = code.trim();
    if (trimmed.length !== 8 || isNaN(Number(trimmed))) {
      setError("Enter the 8-digit code shown on the teacher's phone.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch(`${API_URL}/api/lectures/attendance/qr-live?code=${trimmed}`);
      const data = await res.json();

      if (!data.success) {
        setError("Code not found, or the session has ended. Check the code and try again.");
        return;
      }
      if (data.status === "closed") {
        setError("This session is already closed.");
        return;
      }
      onConfirm(`__code__${trimmed}`);
    } catch (e) {
      console.error("CODE LOOKUP ERROR:", e);
      setError("Could not reach the server. Check the internet connection.");
    } finally {
      setLoading(false);
    }
  };

  const active = focused ? Math.min(code.length, 7) : -1;
  const ready = code.length === 8 && !loading;

  return (
    <div className="qd-page qd-light">
      <header className="qd-top qd-top-light">
        <img src={webLogo} alt="PresencePro" className="qd-logo" />
        {signedIn && (
          <a className="qd-link" href="/dashboard/teacher">
            <IconBack /> Dashboard
          </a>
        )}
      </header>

      <main className="qd-center">
        <div className="qd-card">
          <div className="qd-icon-badge">
            <IconQr size={26} />
          </div>
          <h1 className="qd-h1">Start QR display</h1>
          <p className="qd-sub">
            Enter the 8-digit session code from the teacher's phone. This screen then shows a live QR code that students scan to mark attendance.
          </p>

          <div className="qd-digits-wrap" onClick={() => inputRef.current?.focus()}>
            <div className="qd-digits" aria-hidden="true">
              {Array.from({ length: 8 }).map((_, i) => (
                <React.Fragment key={i}>
                  {i === 4 && <span className="qd-dash" />}
                  <div className={`qd-digit${code[i] ? " qd-digit-filled" : ""}${active === i ? " qd-digit-active" : ""}${error ? " qd-digit-error" : ""}`}>
                    {code[i] || (active === i ? <span className="qd-caret" /> : "")}
                  </div>
                </React.Fragment>
              ))}
            </div>
            <input
              ref={inputRef}
              className="qd-hidden-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="8-digit session code"
              maxLength={8}
              value={code}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(e) => {
                setError("");
                setCode(e.target.value.replace(/\D/g, "").slice(0, 8));
              }}
              onKeyDown={(e) => e.key === "Enter" && ready && handleSubmit()}
              autoFocus
            />
          </div>

          <div className="qd-msg" role="status" aria-live="polite">
            {error ? <span className="qd-msg-error">{error}</span> : <span className="qd-msg-hint">Type or paste the code</span>}
          </div>

          <button className="qd-btn qd-btn-primary qd-btn-block" onClick={handleSubmit} disabled={!ready}>
            {loading ? (
              <>
                <span className="qd-spin-sm" /> Checking
              </>
            ) : (
              <>Show QR code</>
            )}
          </button>

          <p className="qd-foot">Opened a direct link from the teacher? It starts automatically, no code needed.</p>
        </div>
      </main>
    </div>
  );
}

/* ───────────────────────── live QR ───────────────────────── */

function useQrSize() {
  const calc = () => Math.max(200, Math.min(420, window.innerWidth - 96, window.innerHeight - 250));
  const [size, setSize] = useState(calc);
  useEffect(() => {
    const on = () => setSize(calc());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

function useFullscreen() {
  const [full, setFull] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  return [full, toggle];
}

function LiveQRScreen({ token }) {
  const isCodeMode = token.startsWith("__code__");
  const codeValue = isCodeMode ? token.replace("__code__", "") : null;
  const tokenValue = isCodeMode ? null : token;

  const [qrValue, setQrValue] = useState(null);
  const [expiresIn, setExpiresIn] = useState(5);
  const [countdown, setCountdown] = useState(5);
  const [status, setStatus] = useState("loading");
  const [offline, setOffline] = useState(false); // a poll failed while a QR is already showing
  const [stopping, setStopping] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stopError, setStopError] = useState("");
  const [attendanceSessionId, setAttendanceSessionId] = useState(null);
  const [lectureSessionId, setLectureSessionId] = useState(null);

  const pollRef = useRef(null);
  const countdownRef = useRef(null);
  const haveQr = useRef(false);

  const qrSize = useQrSize();
  const [full, toggleFull] = useFullscreen();
  const signedIn = useSignedIn();

  const fetchQR = useCallback(async () => {
    try {
      const url = tokenValue
        ? `${API_URL}/api/lectures/attendance/qr-live?token=${tokenValue}`
        : `${API_URL}/api/lectures/attendance/qr-live?code=${codeValue}`;

      const res = await fetch(url);
      const data = await res.json();

      if (!data.success) {
        if (!haveQr.current) setStatus("error");
        else setOffline(true);
        return;
      }

      if (data.status === "closed") {
        setStatus("closed");
        clearInterval(pollRef.current);
        clearInterval(countdownRef.current);
        return;
      }

      if (data.attendance_session_id) setAttendanceSessionId((prev) => prev || data.attendance_session_id);
      if (data.lecture_session_id) setLectureSessionId((prev) => prev || data.lecture_session_id);

      haveQr.current = true;
      setOffline(false);
      setQrValue(data.qr_value);
      setExpiresIn(5);
      setCountdown(data.expires_in ?? 5);
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
      // a short network blip must not blank a QR that is on the projector
      if (!haveQr.current) setStatus("error");
      else setOffline(true);
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
    if (!attendanceSessionId) {
      setStopError("Session id not available yet. Use the Stop button on the teacher's phone.");
      return;
    }
    setStopping(true);
    setStopError("");
    try {
      const res = await fetch(`${API_URL}/api/lectures/attendance/close-qr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendance_session_id: attendanceSessionId,
          lecture_session_id: lectureSessionId || attendanceSessionId,
        }),
      });
      const data = await res.json();
      if (data.success || data.already_closed) {
        clearInterval(pollRef.current);
        clearInterval(countdownRef.current);
        setConfirmOpen(false);
        setStatus("closed");
      } else {
        setStopError(data.error || "Could not stop the session. Use the Stop button on the teacher's phone.");
      }
    } catch {
      setStopError("Could not reach the server. Use the Stop button on the teacher's phone.");
    } finally {
      setStopping(false);
    }
  };

  const R = 44;
  const circumference = 2 * Math.PI * R;
  const progress = expiresIn > 0 ? countdown / expiresIn : 0;
  const dashOffset = circumference * (1 - progress);
  const urgent = countdown <= 2;

  /* ----- states ----- */

  if (status === "loading") {
    return (
      <div className="qd-page qd-light">
        <main className="qd-center">
          <div className="qd-state">
            <span className="qd-spin" />
            <p className="qd-state-title">Connecting to session</p>
            <p className="qd-state-sub">This takes a moment.</p>
          </div>
        </main>
      </div>
    );
  }

  if (status === "closed") {
    return (
      <div className="qd-page qd-light">
        <main className="qd-center">
          <div className="qd-card qd-state-card">
            <div className="qd-icon-badge qd-badge-ok">
              <IconCheck size={28} />
            </div>
            <h1 className="qd-h1">Attendance closed</h1>
            <p className="qd-sub">Marking has ended for this session. Students can no longer scan.</p>
            <div className="qd-actions">
              <a className="qd-btn qd-btn-primary" href="/qr">
                Start another session
              </a>
              {signedIn && (
                <a className="qd-btn qd-btn-ghost" href="/dashboard/teacher">
                  Back to dashboard
                </a>
              )}
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="qd-page qd-light">
        <main className="qd-center">
          <div className="qd-card qd-state-card">
            <div className="qd-icon-badge qd-badge-bad">
              <IconAlert size={28} />
            </div>
            <h1 className="qd-h1">Session not found</h1>
            <p className="qd-sub">The code may be wrong or the session may have expired. Check with the teacher and try again.</p>
            <div className="qd-actions">
              <button className="qd-btn qd-btn-primary" onClick={fetchQR}>
                Retry
              </button>
              <a className="qd-btn qd-btn-ghost" href="/qr">
                Enter a different code
              </a>
            </div>
          </div>
        </main>
      </div>
    );
  }

  /* ----- live ----- */

  const shownCode = codeValue ? `${codeValue.slice(0, 4)} ${codeValue.slice(4)}` : null;

  return (
    <div className="qd-page qd-dark">
      <header className="qd-top qd-top-dark">
        <div className="qd-logo-pill">
          <img src={webLogo} alt="PresencePro" className="qd-logo" />
        </div>
        <div className="qd-top-right">
          <span className="qd-live">
            <span className="qd-live-dot" /> Live
          </span>
          <button className="qd-icon-btn" onClick={toggleFull} aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen" : "Full screen"}>
            {full ? <IconShrink /> : <IconExpand />}
          </button>
          {signedIn && (
            <a className="qd-icon-btn" href="/dashboard/teacher" aria-label="Back to dashboard" title="Back to dashboard">
              <IconBack />
            </a>
          )}
        </div>
      </header>

      {offline && (
        <div className="qd-offline" role="alert">
          <span className="qd-spin-sm qd-spin-warn" /> Connection lost. Reconnecting, the QR may be out of date.
        </div>
      )}

      <main className="qd-live-grid">
        <section className="qd-qr-card" aria-label="Attendance QR code">
          {qrValue ? (
            <QRCodeSVG value={qrValue} size={qrSize} bgColor="#ffffff" fgColor="#0F1424" level="M" />
          ) : (
            <div className="qd-qr-ph" style={{ width: qrSize, height: qrSize }} />
          )}
        </section>

        <section className="qd-side">
          <p className="qd-eyebrow">Attendance</p>
          <h1 className="qd-live-title">Scan to mark your attendance</h1>

          <ol className="qd-steps">
            <li>
              <span className="qd-step-n">1</span>Open the PresencePro app
            </li>
            <li>
              <span className="qd-step-n">2</span>Choose QR attendance
            </li>
            <li>
              <span className="qd-step-n">3</span>Point your camera at this screen
            </li>
          </ol>

          <div className="qd-meta">
            <div className="qd-timer" aria-label={`QR changes in ${countdown} seconds`}>
              <svg width="76" height="76" viewBox="0 0 100 100" style={{ transform: "rotate(-90deg)" }}>
                <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="7" />
                <circle
                  cx="50"
                  cy="50"
                  r={R}
                  fill="none"
                  stroke={urgent ? "#FF7A7A" : "#8B7CF8"}
                  strokeWidth="7"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  strokeLinecap="round"
                  style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s" }}
                />
              </svg>
              <span className="qd-timer-n" style={{ color: urgent ? "#FF7A7A" : "#FFFFFF" }}>
                {countdown}
              </span>
            </div>
            <div>
              <p className="qd-meta-label">QR refreshes every 5 seconds</p>
              <p className="qd-meta-sub">A screenshot or photo of an old code will not work.</p>
            </div>
          </div>

          {shownCode && (
            <div className="qd-code-chip">
              <span className="qd-code-label">Session code</span>
              <span className="qd-code-val">{shownCode}</span>
            </div>
          )}

          <button className="qd-btn qd-btn-danger" onClick={() => { setStopError(""); setConfirmOpen(true); }}>
            <IconStop /> Stop marking
          </button>
        </section>
      </main>

      {confirmOpen && (
        <div className="qd-modal-back" onClick={() => !stopping && setConfirmOpen(false)} role="dialog" aria-modal="true" aria-labelledby="qd-stop-title">
          <div className="qd-modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="qd-stop-title" className="qd-modal-title">Stop QR marking?</h2>
            <p className="qd-modal-text">Students will no longer be able to scan. This closes attendance for this lecture.</p>
            {!!stopError && <p className="qd-modal-error">{stopError}</p>}
            <div className="qd-modal-actions">
              <button className="qd-btn qd-btn-ghost-dark" onClick={() => setConfirmOpen(false)} disabled={stopping}>
                Keep open
              </button>
              <button className="qd-btn qd-btn-danger-solid" onClick={handleStop} disabled={stopping}>
                {stopping ? (
                  <>
                    <span className="qd-spin-sm" /> Stopping
                  </>
                ) : (
                  "Stop marking"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── icons ───────────────────────── */

const Svg = ({ size = 18, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const IconQr = ({ size }) => (
  <Svg size={size}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" />
  </Svg>
);
const IconCheck = ({ size }) => (
  <Svg size={size}>
    <polyline points="20 6 9 17 4 12" />
  </Svg>
);
const IconAlert = ({ size }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </Svg>
);
const IconBack = () => (
  <Svg size={16}>
    <polyline points="15 18 9 12 15 6" />
  </Svg>
);
const IconExpand = () => (
  <Svg size={18}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
  </Svg>
);
const IconShrink = () => (
  <Svg size={18}>
    <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
  </Svg>
);
const IconStop = () => (
  <Svg size={16}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);

/* ───────────────────────── styles ───────────────────────── */

const CSS = `
.qd-page{position:fixed;inset:0;z-index:1000;overflow:auto;margin:0;border-radius:0;box-sizing:border-box;display:flex;flex-direction:column;font-family:'Inter','DM Sans','Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.qd-light{background:#F4F5FB;color:#111827}
.qd-dark{background:radial-gradient(1200px 700px at 20% -10%,#232B4A 0%,#12182B 55%,#0C1120 100%);color:#fff}
.qd-top{display:flex;align-items:center;justify-content:space-between;padding:14px 32px}
.qd-top-light{border-bottom:1px solid #E5E7F0;background:#fff}
.qd-logo{height:46px;width:auto;display:block}
.qd-logo-pill{background:#fff;border-radius:12px;padding:6px 14px;display:flex;align-items:center}
.qd-top-right{display:flex;align-items:center;gap:10px}
.qd-link{display:inline-flex;align-items:center;gap:4px;color:#4F46E5;font-size:14px;font-weight:600;text-decoration:none;padding:8px 12px;border-radius:8px}
.qd-link:hover{background:#EEF0FF}
.qd-center{flex:1;display:flex;align-items:center;justify-content:center;padding:32px 20px}

.qd-card{background:#fff;border:1px solid #E5E7F0;border-radius:20px;padding:40px 36px;width:100%;max-width:480px;box-shadow:0 1px 2px rgba(17,24,39,.04),0 12px 40px rgba(17,24,39,.06);display:flex;flex-direction:column;align-items:center;box-sizing:border-box}
.qd-icon-badge{width:56px;height:56px;border-radius:16px;background:#EEF0FF;color:#4F46E5;display:flex;align-items:center;justify-content:center;margin-bottom:20px}
.qd-badge-ok{background:#E7F7EF;color:#0E9F6E}
.qd-badge-bad{background:#FDECEC;color:#DC2626}
.qd-h1{font-size:24px;line-height:1.25;font-weight:700;color:#111827;margin:0 0 10px;text-align:center;letter-spacing:-.01em}
.qd-sub{font-size:14.5px;line-height:1.6;color:#6B7280;text-align:center;margin:0 0 28px;max-width:380px}

.qd-digits-wrap{position:relative;width:100%;display:flex;justify-content:center;cursor:text}
.qd-digits{display:flex;align-items:center;gap:8px}
.qd-dash{width:10px;height:2px;background:#D1D5DB;border-radius:2px;margin:0 2px}
.qd-digit{width:40px;height:54px;border-radius:10px;border:1.5px solid #D9DCE8;background:#FAFAFD;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#111827;font-variant-numeric:tabular-nums;transition:border-color .15s,box-shadow .15s,background .15s}
.qd-digit-filled{background:#fff;border-color:#A5A9F5}
.qd-digit-active{border-color:#4F46E5;box-shadow:0 0 0 4px rgba(79,70,229,.14);background:#fff}
.qd-digit-error{border-color:#F08A8A;background:#FFF8F8}
.qd-caret{width:2px;height:24px;background:#4F46E5;animation:qd-blink 1s steps(1) infinite}
.qd-hidden-input{position:absolute;inset:0;width:100%;height:100%;opacity:0;font-size:16px;border:none;outline:none;background:transparent;cursor:text}
.qd-msg{min-height:22px;margin:14px 0 18px;text-align:center;font-size:13.5px}
.qd-msg-error{color:#DC2626;font-weight:600}
.qd-msg-hint{color:#9CA3AF}
.qd-foot{margin:18px 0 0;font-size:12.5px;color:#9CA3AF;text-align:center;line-height:1.5}

.qd-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:none;border-radius:12px;padding:13px 22px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;text-decoration:none;transition:background .15s,opacity .15s,transform .05s}
.qd-btn:active:not(:disabled){transform:translateY(1px)}
.qd-btn:disabled{opacity:.5;cursor:not-allowed}
.qd-btn-block{width:100%}
.qd-btn-primary{background:#4F46E5;color:#fff}
.qd-btn-primary:hover:not(:disabled){background:#4338CA}
.qd-btn-ghost{background:#fff;color:#374151;border:1px solid #D9DCE8}
.qd-btn-ghost:hover{background:#F4F5FB}
.qd-btn-danger{background:rgba(248,113,113,.12);color:#FCA5A5;border:1px solid rgba(248,113,113,.35)}
.qd-btn-danger:hover{background:rgba(248,113,113,.2)}
.qd-btn-danger-solid{background:#DC2626;color:#fff}
.qd-btn-danger-solid:hover:not(:disabled){background:#B91C1C}
.qd-btn-ghost-dark{background:transparent;color:#D1D5DB;border:1px solid rgba(255,255,255,.2)}
.qd-btn-ghost-dark:hover:not(:disabled){background:rgba(255,255,255,.06)}
.qd-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:4px}

.qd-state{display:flex;flex-direction:column;align-items:center;gap:6px}
.qd-state-title{margin:12px 0 0;font-size:17px;font-weight:600;color:#111827}
.qd-state-sub{margin:0;font-size:14px;color:#6B7280}
.qd-state-card{padding:44px 36px}
.qd-spin{width:44px;height:44px;border-radius:50%;border:3px solid #E5E7F0;border-top-color:#4F46E5;animation:qd-spin .9s linear infinite}
.qd-spin-sm{width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;animation:qd-spin .8s linear infinite;display:inline-block}
.qd-spin-warn{border-color:rgba(146,64,14,.25);border-top-color:#92400E}

.qd-live{display:inline-flex;align-items:center;gap:8px;background:rgba(16,185,129,.14);color:#34D399;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;padding:7px 14px;border-radius:999px}
.qd-live-dot{width:8px;height:8px;border-radius:50%;background:#10B981;animation:qd-pulse 1.8s ease-in-out infinite}
.qd-icon-btn{width:38px;height:38px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:#E5E7EB;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;text-decoration:none;font-family:inherit}
.qd-icon-btn:hover{background:rgba(255,255,255,.12)}
.qd-top-dark{padding-bottom:6px}
.qd-offline{margin:8px 28px 0;display:flex;align-items:center;gap:10px;background:#FEF3C7;color:#92400E;border-radius:10px;padding:10px 14px;font-size:13.5px;font-weight:500}

.qd-live-grid{flex:1;display:grid;grid-template-columns:auto minmax(300px,440px);gap:64px;align-items:center;justify-content:center;padding:20px 40px 40px}
.qd-qr-card{background:#fff;border-radius:24px;padding:24px;box-shadow:0 30px 80px rgba(0,0,0,.4);line-height:0;justify-self:end}
.qd-qr-ph{background:#F3F4F6;border-radius:12px}
.qd-side{display:flex;flex-direction:column;align-items:flex-start}
.qd-eyebrow{margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#A5B4FC}
.qd-live-title{margin:0 0 26px;font-size:clamp(26px,3.2vw,38px);line-height:1.15;font-weight:700;letter-spacing:-.02em;color:#fff}
.qd-steps{list-style:none;margin:0 0 30px;padding:0;display:flex;flex-direction:column;gap:14px;font-size:16px;color:#D1D5DB}
.qd-steps li{display:flex;align-items:center;gap:14px}
.qd-step-n{width:28px;height:28px;border-radius:50%;background:rgba(139,124,248,.18);color:#C4B9FF;font-size:13px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:none}
.qd-meta{display:flex;align-items:center;gap:16px;margin-bottom:22px;padding:14px 18px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);border-radius:16px;width:100%;box-sizing:border-box}
.qd-timer{position:relative;width:76px;height:76px;flex:none}
.qd-timer-n{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.qd-meta-label{margin:0 0 4px;font-size:15px;font-weight:600;color:#F3F4F6}
.qd-meta-sub{margin:0;font-size:13px;color:#9CA3AF;line-height:1.45}
.qd-code-chip{display:flex;align-items:center;gap:12px;margin-bottom:22px;padding:10px 16px;border-radius:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)}
.qd-code-label{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#9CA3AF}
.qd-code-val{font-size:18px;font-weight:700;letter-spacing:.14em;color:#fff;font-variant-numeric:tabular-nums}

.qd-modal-back{position:fixed;inset:0;background:rgba(5,8,18,.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50}
.qd-modal{background:#fff;color:#111827;border-radius:18px;padding:28px;width:100%;max-width:420px;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.qd-modal-title{margin:0 0 8px;font-size:19px;font-weight:700}
.qd-modal-text{margin:0 0 18px;font-size:14.5px;line-height:1.55;color:#6B7280}
.qd-modal-error{margin:0 0 14px;font-size:13.5px;color:#DC2626;font-weight:600;line-height:1.45}
.qd-modal-actions{display:flex;gap:10px;justify-content:flex-end}
.qd-modal .qd-btn-ghost-dark{color:#374151;border-color:#D9DCE8}
.qd-modal .qd-btn-ghost-dark:hover:not(:disabled){background:#F4F5FB}

@keyframes qd-spin{to{transform:rotate(360deg)}}
@keyframes qd-blink{50%{opacity:0}}
@keyframes qd-pulse{0%,100%{box-shadow:0 0 0 0 rgba(16,185,129,.5)}50%{box-shadow:0 0 0 6px rgba(16,185,129,0)}}

@media (max-width:900px){
  .qd-live-grid{grid-template-columns:1fr;gap:28px;padding:16px 20px 32px;justify-items:center}
  .qd-qr-card{justify-self:center}
  .qd-side{align-items:center;text-align:center;width:100%;max-width:440px}
  .qd-steps{align-items:flex-start}
  .qd-top{padding:12px 18px}
  .qd-logo{height:38px}
}
@media (max-width:420px){
  .qd-card{padding:30px 20px}
  .qd-digit{width:32px;height:46px;font-size:19px}
  .qd-digits{gap:5px}
}
@media (prefers-reduced-motion:reduce){
  .qd-spin,.qd-spin-sm,.qd-live-dot,.qd-caret{animation:none}
}
`;