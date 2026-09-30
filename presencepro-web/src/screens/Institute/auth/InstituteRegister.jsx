import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./InstituteRegister.css";
import webLogo from "../../../assets/web_logo.png";

const INDIAN_STATES = [
  "Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh",
  "Goa","Gujarat","Haryana","Himachal Pradesh","Jharkhand","Karnataka",
  "Kerala","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram",
  "Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu",
  "Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal",
  "Andaman and Nicobar Islands","Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi","Jammu and Kashmir","Ladakh","Lakshadweep","Puducherry",
];

const INSTITUTE_TYPES = [
  "Affiliated College","Autonomous College","Constituent College",
  "Deemed University","Central University","State University",
  "Private University","Institution of National Importance","Other",
];

const PWD_RULES = [
  { key:"len",     label:"At least 8 characters",         test:(p) => p.length >= 8 },
  { key:"upper",   label:"One uppercase letter (A–Z)",     test:(p) => /[A-Z]/.test(p) },
  { key:"lower",   label:"One lowercase letter (a–z)",     test:(p) => /[a-z]/.test(p) },
  { key:"digit",   label:"One number (0–9)",               test:(p) => /[0-9]/.test(p) },
  { key:"special", label:"One special character (!@#$…)",  test:(p) => /[^A-Za-z0-9]/.test(p) },
];

// ── Institute backend runs on port 5001 — separate from main API ──────
const INSTITUTE_API = import.meta.env.VITE_INSTITUTE_API_URL || "http://localhost:5001";

function mapAisheToForm(data) {
  return {
    aisheCode:      data.aishe_code      || "",
    collegeName:    data.college_name    || "",
    district:       data.district        || "",
    state:          data.state           || "",
    instituteType:  data.type            || "",
    universityId:   data.university_id   || "",
    universityName: data.university_name || "",
    fullAddress:    "",
    city:           "",
  };
}

export default function InstituteRegister() {
  const navigate = useNavigate();

  // Step 1
  const [aisheCode,    setAisheCode]    = useState("");
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError,   setFetchError]   = useState("");
  const [aisheFound,   setAisheFound]   = useState(false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);

  // Create new toggle
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Institute details
  const [collegeName,    setCollegeName]    = useState("");
  const [district,       setDistrict]       = useState("");
  const [fullAddress,    setFullAddress]    = useState("");
  const [city,           setCity]           = useState("");
  const [state,          setState]          = useState("");
  const [instituteType,  setInstituteType]  = useState("");
  const [universityId,   setUniversityId]   = useState("");
  const [universityName, setUniversityName] = useState("");
  const [dteCode,        setDteCode]        = useState("");
  const [udiseCode,      setUdiseCode]      = useState("");

  // Account
  const [email,           setEmail]           = useState("");
  const [password,        setPassword]        = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword,    setShowPassword]    = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);

  // Shared
  const [agreed,        setAgreed]        = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitError,   setSubmitError]   = useState("");
  const [submitSuccess, setSubmitSuccess] = useState("");

  // Password derived state
  const pwdTouched      = password.length > 0;
  const allRulesPassed  = PWD_RULES.every((r) => r.test(password));
  const confirmMatch    = confirmPassword.length > 0 && password === confirmPassword;
  const confirmMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  const resetDetails = () => {
    setCollegeName(""); setDistrict(""); setFullAddress("");
    setCity(""); setState(""); setInstituteType("");
    setUniversityId(""); setUniversityName("");
    setDteCode(""); setUdiseCode("");
    setAlreadyRegistered(false);
  };

  // ── AISHE Fetch ───────────────────────────────────────────────────
  const handleFetch = async () => {
    setFetchError("");
    setAisheFound(false);
    setShowCreateForm(false);
    resetDetails();

    if (!aisheCode.trim()) {
      setFetchError("Please enter an AISHE code or registration number.");
      return;
    }
    setFetchLoading(true);
    try {
      const res  = await fetch(
        `${INSTITUTE_API}/auth/find-with-aishe?code=${encodeURIComponent(aisheCode.trim())}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Institute not found.");

      // Warn if already registered but still allow form fill
      if (data.already_registered) {
        setAlreadyRegistered(true);
      }

      const mapped = mapAisheToForm(data);
      setCollegeName(mapped.collegeName);
      setDistrict(mapped.district);
      setFullAddress(mapped.fullAddress);
      setCity(mapped.city);
      setState(mapped.state);
      setInstituteType(mapped.instituteType);
      setUniversityId(mapped.universityId);
      setUniversityName(mapped.universityName);
      setAisheFound(true);
    } catch (err) {
      setFetchError(err.message || "Could not fetch institute details.");
    } finally {
      setFetchLoading(false);
    }
  };

  const handleCreateNew = () => {
    if (showCreateForm) {
      setShowCreateForm(false);
    } else {
      resetDetails();
      setAisheCode("");
      setAisheFound(false);
      setFetchError("");
      setShowCreateForm(true);
    }
  };

  // ── Register ──────────────────────────────────────────────────────
  const handleRegister = async () => {
    setSubmitError("");
    setSubmitSuccess("");

    if (!collegeName.trim())    { setSubmitError("College name is required."); return; }
    if (!district.trim())       { setSubmitError("District is required."); return; }
    if (!fullAddress.trim())    { setSubmitError("Full address is required."); return; }
    if (!city.trim())           { setSubmitError("City is required."); return; }
    if (!state)                 { setSubmitError("Please select a state."); return; }
    if (!instituteType)         { setSubmitError("Please select an institute type."); return; }
    if (!universityName.trim()) { setSubmitError("University name is required."); return; }
    if (showCreateForm && !dteCode.trim() && !udiseCode.trim()) {
      setSubmitError("Please enter either a DTE Code or UDISE Code."); return;
    }
    if (!email.trim())          { setSubmitError("Please enter an institute email address."); return; }
    if (!allRulesPassed)        { setSubmitError("Password does not meet all requirements."); return; }
    if (password !== confirmPassword) { setSubmitError("Passwords do not match."); return; }
    if (!agreed)                { setSubmitError("Please agree to the Terms of Service and Privacy Policy."); return; }

    setSubmitLoading(true);
    try {
      const res = await fetch(`${INSTITUTE_API}/auth/institute-register`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aishe_code:      aisheCode.trim()     || null,
          dte_code:        dteCode.trim()        || null,
          udise_code:      udiseCode.trim()      || null,
          college_name:    collegeName.trim(),
          district:        district.trim(),
          full_address:    fullAddress.trim(),
          city:            city.trim(),
          state,
          type:            instituteType,
          university_id:   universityId.trim()  || null,
          university_name: universityName.trim(),
          email:           email.trim(),
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed.");

      setSubmitSuccess("Institute registered successfully! Redirecting to login…");
      setTimeout(() => navigate("/institute-login"), 2000);
    } catch (err) {
      setSubmitError(err.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitLoading(false);
    }
  };

  return (
    <div className="ir-page">

      {/* ── Navbar ──────────────────────────────────────────────── */}
      <nav className="ir-navbar">
        <a className="ir-navbar-brand" href="/">
          <img src={webLogo} alt="PresencePro" className="ir-navbar-logo" />
        </a>
        <span className="ir-navbar-right">
          Already have an account?&nbsp;
          <a href="/institute-login" onClick={(e) => { e.preventDefault(); navigate("/institute-login"); }}>
            Login Here
          </a>
        </span>
      </nav>

      <div className="ir-body">

        {/* Heading */}
        <div className="ir-heading">
          <h1>Register Your Institute</h1>
          <p>Create an account to manage your institute with <span>PresencePro.</span></p>
        </div>

        {submitError   && <div className="ir-alert ir-alert--error">{submitError}</div>}
        {submitSuccess && <div className="ir-alert ir-alert--ok">{submitSuccess}</div>}

        {/* ── Section 1: Find Your Institute ──────────────────── */}
        <div className="ir-section">
          <div className="ir-step-header">
            <div className="ir-step-badge">1</div>
            <span className="ir-step-title">Find Your Institute</span>
          </div>
          <p className="ir-step-subtitle">Search your institute using AISHE code/Registration number.</p>

          <label className="ir-field-label" htmlFor="aisheCode">AISHE Code / Registration Number</label>
          <div className="ir-search-row">
            <input
              id="aisheCode"
              type="text"
              placeholder="Enter AISHE code or registration number"
              value={aisheCode}
              onChange={(e) => setAisheCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleFetch()}
            />
            <button className="ir-fetch-btn" onClick={handleFetch} disabled={fetchLoading}>
              <SearchIcon size={16} />
              {fetchLoading ? "Fetching…" : "Fetch Institute"}
            </button>
          </div>

          {fetchError && <p className="ir-inline-error">{fetchError}</p>}

          {aisheFound && alreadyRegistered && (
            <div className="ir-alert ir-alert--error" style={{ marginTop: "12px" }}>
              ⚠️ This institute is already registered. Please login instead.{" "}
              <a href="/institute-login" onClick={(e) => { e.preventDefault(); navigate("/institute-login"); }}
                style={{ color: "#4F46E5", fontWeight: 700 }}>Go to Login</a>
            </div>
          )}

          {aisheFound ? (
            <div className="ir-aishe-success">
              <CheckIcon size={15} />
              Institute found! Details have been auto-filled below.
            </div>
          ) : (
            <div className="ir-aishe-note">
              <span className="ir-aishe-note-icon"><BuildingIcon size={18} /></span>
              We will fetch your <span className="ir-aishe-highlight">institute details</span> using AISHE code.
            </div>
          )}
        </div>

        {/* ── "Institute not found?" banner ───────────────────── */}
        {!aisheFound && (
          <div className={`ir-notfound-banner${showCreateForm ? " ir-notfound-banner--open" : ""}`}>
            <div className="ir-notfound-top">
              <div className="ir-notfound-left">
                <div className="ir-notfound-icon-wrap"><BuildingIcon size={22} /></div>
                <div className="ir-notfound-text">
                  <h3>Institute not found?</h3>
                  <p>If we can't find your institute using the AISHE code, you can create a new institute.</p>
                </div>
              </div>
              <button className="ir-create-btn" onClick={handleCreateNew}>
                {showCreateForm ? <ChevronUpIcon size={15} /> : <PlusIcon size={15} />}
                {showCreateForm ? "Cancel" : "Create New Institute"}
              </button>
            </div>

            {showCreateForm && (
              <div className="ir-create-form">
                <div className="ir-create-form-divider" />

                <div className="ir-two-col">
                  <div className="ir-field-group">
                    <label className="ir-field-label" htmlFor="dteCode">
                      DTE Code <span className="ir-optional">(if available)</span>
                    </label>
                    <input id="dteCode" type="text" placeholder="Enter DTE code"
                      value={dteCode} onChange={(e) => setDteCode(e.target.value)} />
                  </div>
                  <div className="ir-field-group">
                    <label className="ir-field-label" htmlFor="udiseCode">
                      UDISE Code <span className="ir-required">*</span>
                      <span className="ir-optional"> (mandatory if no DTE code)</span>
                    </label>
                    <input id="udiseCode" type="text" placeholder="Enter UDISE code"
                      value={udiseCode} onChange={(e) => setUdiseCode(e.target.value)} />
                  </div>
                </div>

                <div className="ir-field-group">
                  <label className="ir-field-label" htmlFor="cn-collegeName">
                    College Name <span className="ir-required">*</span>
                  </label>
                  <input id="cn-collegeName" type="text" placeholder="Enter full college name"
                    value={collegeName} onChange={(e) => setCollegeName(e.target.value)} />
                </div>

                <div className="ir-field-group">
                  <label className="ir-field-label" htmlFor="cn-type">
                    Institute Type <span className="ir-required">*</span>
                  </label>
                  <select id="cn-type" value={instituteType} onChange={(e) => setInstituteType(e.target.value)}>
                    <option value="">Select institute type</option>
                    {INSTITUTE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>

                <div className="ir-two-col">
                  <div className="ir-field-group">
                    <label className="ir-field-label" htmlFor="cn-universityId">
                      University ID <span className="ir-optional">(if available)</span>
                    </label>
                    <input id="cn-universityId" type="text" placeholder="e.g. U-0602"
                      value={universityId} onChange={(e) => setUniversityId(e.target.value)} />
                  </div>
                  <div className="ir-field-group">
                    <label className="ir-field-label" htmlFor="cn-universityName">
                      University Name <span className="ir-required">*</span>
                    </label>
                    <input id="cn-universityName" type="text" placeholder="Enter affiliated university name"
                      value={universityName} onChange={(e) => setUniversityName(e.target.value)} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Section 2: Institute Details (AISHE auto-fill only) ─ */}
        {aisheFound && (
          <div className="ir-section">
            <div className="ir-step-header">
              <div className="ir-step-badge ir-step-badge--green">✓</div>
              <span className="ir-step-title">Institute Details</span>
              <span className="ir-autofill-tag">Auto-filled</span>
            </div>
            <p className="ir-step-subtitle">Auto-filled from AISHE database. You may correct any details if needed.</p>

            <div className="ir-field-group">
              <label className="ir-field-label" htmlFor="collegeName">
                College Name <span className="ir-required">*</span>
              </label>
              <input id="collegeName" type="text" placeholder="Enter full college name"
                value={collegeName} onChange={(e) => setCollegeName(e.target.value)} />
            </div>

            <div className="ir-field-group">
              <label className="ir-field-label" htmlFor="instituteType">
                Institute Type <span className="ir-required">*</span>
              </label>
              <select id="instituteType" value={instituteType} onChange={(e) => setInstituteType(e.target.value)}>
                <option value="">Select institute type</option>
                {INSTITUTE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div className="ir-two-col">
              <div className="ir-field-group">
                <label className="ir-field-label" htmlFor="universityId">
                  University ID <span className="ir-optional">(if available)</span>
                </label>
                <input id="universityId" type="text" placeholder="e.g. U-0602"
                  value={universityId} onChange={(e) => setUniversityId(e.target.value)} />
              </div>
              <div className="ir-field-group">
                <label className="ir-field-label" htmlFor="universityName">
                  University Name <span className="ir-required">*</span>
                </label>
                <input id="universityName" type="text" placeholder="Enter affiliated university name"
                  value={universityName} onChange={(e) => setUniversityName(e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {/* ── Section 2 / 3: Address Details — always visible ──── */}
        <div className="ir-section">
          <div className="ir-step-header">
            <div className="ir-step-badge">2</div>
            <span className="ir-step-title">Address Details</span>
          </div>
          <p className="ir-step-subtitle">Enter the physical address of your institute.</p>

          <div className="ir-field-group">
            <label className="ir-field-label" htmlFor="fullAddress">
              Full Address <span className="ir-required">*</span>
            </label>
            <input id="fullAddress" type="text" placeholder="Enter full address"
              value={fullAddress} onChange={(e) => setFullAddress(e.target.value)} />
          </div>

          <div className="ir-two-col">
            <div className="ir-field-group">
              <label className="ir-field-label" htmlFor="city">
                City <span className="ir-required">*</span>
              </label>
              <input id="city" type="text" placeholder="Enter city"
                value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="ir-field-group">
              <label className="ir-field-label" htmlFor="addr-district">
                District <span className="ir-required">*</span>
              </label>
              <input id="addr-district" type="text" placeholder="Enter district"
                value={district} onChange={(e) => setDistrict(e.target.value)} />
            </div>
          </div>

          <div className="ir-field-group" style={{ marginTop: "18px" }}>
            <label className="ir-field-label" htmlFor="addr-state">
              State <span className="ir-required">*</span>
            </label>
            <select id="addr-state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Select state</option>
              {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* ── Section 3: Institute Account — always visible ────── */}
        <div className="ir-section">
          <div className="ir-step-header">
            <div className="ir-step-badge">3</div>
            <span className="ir-step-title">Institute Account</span>
          </div>
          <p className="ir-step-subtitle">This will be your institute's login account.</p>

          <div className="ir-three-col">
            {/* Email */}
            <div className="ir-field-group">
              <label className="ir-field-label" htmlFor="email">
                Institute Email <span className="ir-required">*</span>
              </label>
              <input id="email" type="email" placeholder="Enter institute email address"
                value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </div>

            {/* Password */}
            <div className="ir-field-group">
              <label className="ir-field-label" htmlFor="password">
                Create Password <span className="ir-required">*</span>
              </label>
              <div className="ir-password-wrap">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className={pwdTouched ? (allRulesPassed ? "ir-input--valid" : "ir-input--invalid") : ""}
                />
                <button type="button" className="ir-eye-btn"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}>
                  {showPassword ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
                </button>
              </div>
              {pwdTouched && (
                <ul className="ir-pwd-rules">
                  {PWD_RULES.map((rule) => (
                    <li key={rule.key} className={rule.test(password) ? "ir-pwd-rule--pass" : "ir-pwd-rule--fail"}>
                      {rule.test(password) ? <CheckIcon size={12} /> : <XIcon size={12} />}
                      {rule.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Confirm Password */}
            <div className="ir-field-group">
              <label className="ir-field-label" htmlFor="confirmPassword">
                Confirm Password <span className="ir-required">*</span>
              </label>
              <div className="ir-password-wrap">
                <input
                  id="confirmPassword"
                  type={showConfirm ? "text" : "password"}
                  placeholder="Confirm password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  className={confirmMatch ? "ir-input--valid" : confirmMismatch ? "ir-input--invalid" : ""}
                />
                <button type="button" className="ir-eye-btn"
                  onClick={() => setShowConfirm((v) => !v)}
                  aria-label={showConfirm ? "Hide password" : "Show password"}>
                  {showConfirm ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
                </button>
              </div>
              {confirmMatch    && <p className="ir-confirm-ok">✓ Passwords match</p>}
              {confirmMismatch && <p className="ir-confirm-err">✗ Passwords do not match</p>}
            </div>
          </div>

          <div className="ir-email-note">
            <ShieldIcon size={15} />
            Use an official institute email address. All important communications will be sent to this email.
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────── */}
        <div className="ir-footer-row">
          <label className="ir-tos-check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            I agree to the{" "}
            <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a>
            {" "}and{" "}
            <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
          </label>
          <button className="ir-register-btn" onClick={handleRegister} disabled={submitLoading}>
            {submitLoading ? "Registering…" : "Register Institute"}
          </button>
        </div>

      </div>
    </div>
  );
}

/* ── Icons ──────────────────────────────────────────────────────────── */
function SearchIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>);
}
function BuildingIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18" /><path d="M5 21V8l7-4 7 4v13" /><path d="M9 21v-6h6v6" /><path d="M9 11h.01" /><path d="M15 11h.01" /><path d="M12 11h.01" /><path d="M9 8h.01" /><path d="M15 8h.01" /><path d="M12 8h.01" /></svg>);
}
function PlusIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>);
}
function ChevronUpIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>);
}
function CheckIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>);
}
function XIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>);
}
function EyeIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" /><circle cx="12" cy="12" r="3" /></svg>);
}
function EyeOffIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="M6.61 6.61A18.5 18.5 0 0 0 1 12s4 8 11 8a9.26 9.26 0 0 0 5.39-1.61" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><path d="M1 1l22 22" /></svg>);
}
function ShieldIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>);
}