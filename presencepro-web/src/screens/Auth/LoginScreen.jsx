// @ts-nocheck
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
import { auth } from "../../services/firebase";
import {
  saveUserSession,
  saveUserProfile,
  isLoggedIn,
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
  const [resetMsg, setResetMsg] = useState("");

  // If already logged in, skip straight to the right dashboard
  if (isLoggedIn()) {
    // Deferred navigate — let the component mount first
    setTimeout(() => navigate(dashboardPathForRole(), { replace: true }), 0);
    return null;
  }

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setResetMsg("");

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
      const userWithHead = {
        ...data.user,
        is_head:
          !!data.user.is_head ||
          data.user.role === "hod" ||
          data.user.role === "head_teacher",
      };

      // 4. Persist session — user + token + profile
      saveUserSession(userWithHead, idToken, data.profile || null);

      // 5. If profile came separately or needs re-evaluation with designation
      if (data.profile) saveUserProfile(data.profile);

      // 6. Navigate to role-appropriate page
      navigate(dashboardPathForRole(userWithHead), { replace: true });

    } catch (err) {
      console.error("WEB LOGIN ERROR:", err);
      setError(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setError("");
    setResetMsg("");
    if (!email.trim()) {
      setError("Enter your email above first, then tap Forgot Password.");
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setResetMsg("Reset email sent — check your inbox.");
    } catch (err) {
      setError(err?.message || "Unable to send reset email.");
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
          {resetMsg && <div className="login-alert login-alert--ok">{resetMsg}</div>}

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
          <input
            id="password"
            className="login-input"
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />

          <button
            type="submit"
            className="login-submit"
            disabled={loading}
            style={{ opacity: loading ? 0.7 : 1, cursor: loading ? "not-allowed" : "pointer" }}
          >
            {loading ? "Logging in…" : "Login"}
          </button>

          <button type="button" className="login-forgot" onClick={handleForgotPassword}>
            Forgot Password?
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