// @ts-nocheck
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../../services/firebase";
import {
  saveUserSession,
  saveUserProfile,
  isLoggedIn,
  getSessionUser,
  getUserSession,
  dashboardPathForRole,
} from "../../services/session";
import "./LoginScreen.css";
import coverImage from "../../assets/login_page_cover_image.webp";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function LoginScreen() {
  const navigate = useNavigate();

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [showPw,   setShowPw]   = useState(false);

  // If already logged in, skip straight to the right dashboard.
  // Never redirect back to "/" (this page) - that was an endless loop for
  // roles like head_teacher that dashboardPathForRole() doesn't know.
  const sessionUser = isLoggedIn() ? getSessionUser() : null;
  const sessionProfile = isLoggedIn() ? getUserSession()?.profile : null;
  const sessionIsHead =
    !!sessionUser?.is_head ||
    sessionUser?.role === "hod" ||
    sessionUser?.role === "head_teacher" ||
    (sessionUser?.role === "teacher" && !!String(sessionProfile?.head_of || "").trim());
  const homeTarget = !sessionUser
    ? null
    : sessionIsHead
      ? "/dashboard/teacher"
      : dashboardPathForRole(sessionUser);

  useEffect(() => {
    if (homeTarget && homeTarget !== "/") {
      navigate(homeTarget, { replace: true });
    }
  }, [homeTarget]);

  if (homeTarget && homeTarget !== "/") return null;

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");

    if (!email.trim() || !password.trim()) {
      setError("Please enter both email and password.");
      return;
    }

    setLoading(true);
    try {
      // 1. Firebase Auth
      const cred    = await signInWithEmailAndPassword(auth, email.trim(), password.trim());
      const idToken = await cred.user.getIdToken(true);

      // 2. Backend login — returns { user, profile }
      const res  = await fetch(`${API_URL}/auth/login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ idToken }),
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Login failed.");
      if (!data.user.is_active) {
        throw new Error("Account disabled. Contact your institute administrator.");
      }

      // 3. Determine is_head before saving session.
      //    ONLY use role field from the backend — designation values like
      //    "head" belong to the institute dashboard and must not bleed in here.
      //    Backend sets userData.role to "hod" or "head_teacher" for heads.
      //    A teacher whose profile has head_of set (e.g. "MCA") is also a head —
      //    that field is what the institute app writes when assigning a head.
      const userWithHead = {
        ...data.user,
        is_head:
          !!data.user.is_head ||
          data.user.role === "hod" ||
          data.user.role === "head_teacher" ||
          (data.user.role === "teacher" &&
            !!String(data.profile?.head_of || "").trim()),
      };

      // 4. Persist session — user + token + profile
      saveUserSession(userWithHead, idToken, data.profile || null);

      // 5. If profile came separately or needs re-evaluation with designation
      if (data.profile) saveUserProfile(data.profile);

      // 6. Navigate to role-appropriate page
      //    Heads use the teacher pages (Manage shows up in the sidebar).
      navigate(
        userWithHead.is_head && userWithHead.role !== "student"
          ? "/dashboard/teacher"
          : dashboardPathForRole(userWithHead),
        { replace: true },
      );

    } catch (err) {
      console.error("WEB LOGIN ERROR:", err);
      setError(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* ── Left: cover panel ─────────────────────────────────────── */}
      <div className="login-cover">
        <img src={coverImage} alt="PresencePro" className="login-cover-image" />
      </div>

      {/* ── Right: login form ─────────────────────────────────────── */}
      <div className="login-form-side">
        <form className="login-card" onSubmit={handleLogin}>
          <div className="login-card-brand-mobile">
            <div className="login-cover-dot" />
            <span>PresencePro</span>
          </div>

          <h2 className="login-title">Welcome back</h2>
          <p className="login-subtitle">Log in with your registered account</p>

          {error    && <div className="login-alert login-alert--error">{error}</div>}

          <label className="login-label" htmlFor="email">Email</label>
          <input
            id="email"
            className="login-input"
            type="email"
            placeholder="Enter registered email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />

          <label className="login-label" htmlFor="password">Password</label>
          <div style={{ position: "relative" }}>
            <input
              id="password"
              className="login-input"
              type={showPw ? "text" : "password"}
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              style={{ paddingRight: 44 }}
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? "Hide password" : "Show password"}
              aria-pressed={showPw}
              title={showPw ? "Hide password" : "Show password"}
              style={{
                position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                background: "none", border: 0, padding: 4, cursor: "pointer", color: "#6B7280",
                display: "flex", alignItems: "center",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {showPw ? (
                  <>
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </>
                ) : (
                  <>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </>
                )}
              </svg>
            </button>
          </div>

          <button
            type="submit"
            className="login-submit"
            disabled={loading}
            style={{ opacity: loading ? 0.7 : 1, cursor: loading ? "not-allowed" : "pointer" }}
          >
            {loading ? "Logging in…" : "Login"}
          </button>

          <div className="login-divider"><span>or</span></div>

          <button type="button" className="login-nav-btn" onClick={() => navigate("/qr")}>
            <span className="login-nav-icon">📷</span>
            <span>
              <strong>Take QR Attendance</strong>
              <small>Display a live QR code for students to scan</small>
            </span>
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Auth error mapper ────────────────────────────────────────────────
function mapAuthError(err) {
  const code = err?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Incorrect email or password.";
  }
  if (code.includes("too-many-requests")) {
    return "Too many attempts. Please try again later.";
  }
  if (code.includes("network-request-failed")) {
    return "Network error. Check your connection and try again.";
  }
  return err?.message || "Something went wrong. Please try again.";
}