import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./InstituteLogin.css";
import instituteCoverImage from "../../../assets/institute_cover_page.webp";

const INSTITUTE_API = import.meta.env.VITE_INSTITUTE_API_URL || "http://localhost:5001";

function saveInstituteSession(institute, token) {
  localStorage.setItem("institute_token",   token);
  localStorage.setItem("institute_profile", JSON.stringify(institute));
}

export default function InstituteLogin() {
  const navigate = useNavigate();

  const [instituteCode, setInstituteCode] = useState("");
  const [password,      setPassword]      = useState("");
  const [showPassword,  setShowPassword]  = useState(false);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState("");

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");

    if (!instituteCode.trim() || !password.trim()) {
      setError("Please enter both institute code and password.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${INSTITUTE_API}/auth/institute-login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instituteCode: instituteCode.trim(),
          password:      password.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Login failed.");
      }

      // ── Guard: account inactive ─────────────────────────────────
      if (data.institute && data.institute.is_active === false) {
        throw new Error("This institute account has been deactivated. Contact support.");
      }

      // ── Save session ────────────────────────────────────────────
      saveInstituteSession(data.institute, data.token);

      navigate("/", { replace: true });

    } catch (err) {
      console.error("INSTITUTE LOGIN ERROR:", err);
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="inst-login-page">

      {/* ── Left: cover panel ─────────────────────────────────────── */}
      <div className="inst-login-cover">
        <img
          src={instituteCoverImage}
          alt="PresencePro — One Platform. Every Institute."
          className="inst-login-cover-image"
        />
      </div>

      {/* ── Right: login form ─────────────────────────────────────── */}
      <div className="inst-login-form-side">
        <form className="inst-login-card" onSubmit={handleLogin}>

          <div className="inst-login-card-brand-mobile">
            <div className="inst-login-cover-dot" />
            <span>PresencePro</span>
          </div>

          <h2 className="inst-login-title inst-login-title--center">Institute Login</h2>
          <p className="inst-login-subtitle inst-login-subtitle--center">
            Access your institute dashboard
          </p>

          {error && <div className="inst-login-alert inst-login-alert--error">{error}</div>}

          {/* Institute Code */}
          <label className="inst-login-label" htmlFor="instituteCode">
            Institute Code / Email
          </label>
          <div className="inst-login-input-wrap">
            <span className="inst-login-input-icon"><BuildingIcon size={18} /></span>
            <input
              id="instituteCode"
              className="inst-login-input inst-login-input--icon"
              type="text"
              placeholder="Enter AISHE code or email"
              value={instituteCode}
              onChange={(e) => setInstituteCode(e.target.value)}
              autoComplete="username"
            />
          </div>

          {/* Password */}
          <label className="inst-login-label" htmlFor="password">
            Password
          </label>
          <div className="inst-login-input-wrap">
            <span className="inst-login-input-icon"><LockIcon size={18} /></span>
            <input
              id="password"
              className="inst-login-input inst-login-input--icon inst-login-input--icon-right"
              type={showPassword ? "text" : "password"}
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <button
              type="button"
              className="inst-login-input-toggle"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
            </button>
          </div>

          <button
            type="button"
            className="inst-login-forgot inst-login-forgot--right"
            onClick={() => navigate("/institute-forgot-password")}
          >
            Forgot Password?
          </button>

          <button
            type="submit"
            className="inst-login-submit"
            disabled={loading}
            style={{ opacity: loading ? 0.7 : 1, cursor: loading ? "not-allowed" : "pointer" }}
          >
            {loading ? "Logging in…" : "Login to Institute"}
          </button>

          <div className="inst-login-divider"><span>or</span></div>

          <button
            type="button"
            className="inst-login-nav-btn"
            onClick={() => navigate("/institute-register")}
          >
            <span className="inst-login-nav-avatar"><BuildingIcon size={18} /></span>
            <span className="inst-login-nav-text">
              <strong>New Institute?</strong>
              <small>Register your institute</small>
            </span>
            <span className="inst-login-nav-chevron"><ChevronRightIcon size={18} /></span>
          </button>

          <p className="inst-login-support">
            Need help? <a href="mailto:support@presencepro.app">Contact Support</a>
          </p>

        </form>
      </div>
    </div>
  );
}

/* ── Icons ──────────────────────────────────────────────────────────── */
function BuildingIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18" /><path d="M5 21V8l7-4 7 4v13" /><path d="M9 21v-6h6v6" /><path d="M9 11h.01" /><path d="M15 11h.01" /><path d="M12 11h.01" /><path d="M9 8h.01" /><path d="M15 8h.01" /><path d="M12 8h.01" /></svg>);
}
function LockIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>);
}
function EyeIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" /><circle cx="12" cy="12" r="3" /></svg>);
}
function EyeOffIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="M6.61 6.61A18.5 18.5 0 0 0 1 12s4 8 11 8a9.26 9.26 0 0 0 5.39-1.61" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><path d="M1 1l22 22" /></svg>);
}
function ChevronRightIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>);
}