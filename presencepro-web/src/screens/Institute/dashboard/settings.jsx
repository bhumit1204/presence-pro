// @ts-nocheck
import { useEffect, useState } from "react";
import { useNavigate }         from "react-router-dom";
import { getInstituteToken, getInstituteProfile, clearInstituteSession } from "./protected_route";
import Sidebar from "../../../components/Inst_SideBar";
import "./settings.css";

const INSTITUTE_API = import.meta.env.VITE_INSTITUTE_API_URL || "http://localhost:5001";

const INSTITUTE_TYPES = [
  "Affiliated College","Autonomous College","Constituent College",
  "Deemed University","Central University","State University",
  "Private University","Institution of National Importance","Other",
];

const INDIAN_STATES = [
  "Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh",
  "Goa","Gujarat","Haryana","Himachal Pradesh","Jharkhand","Karnataka",
  "Kerala","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram",
  "Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu",
  "Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal",
  "Andaman and Nicobar Islands","Chandigarh","Dadra and Nagar Haveli and Daman and Diu",
  "Delhi","Jammu and Kashmir","Ladakh","Lakshadweep","Puducherry",
];

const PWD_RULES = [
  { key:"len",     label:"At least 8 characters",        test:(p) => p.length >= 8 },
  { key:"upper",   label:"One uppercase letter (A–Z)",    test:(p) => /[A-Z]/.test(p) },
  { key:"lower",   label:"One lowercase letter (a–z)",    test:(p) => /[a-z]/.test(p) },
  { key:"digit",   label:"One number (0–9)",              test:(p) => /[0-9]/.test(p) },
  { key:"special", label:"One special character (!@#$…)", test:(p) => /[^A-Za-z0-9]/.test(p) },
];

const TABS = [
  { id: "profile",      label: "Institute Profile", icon: <BuildingIcon /> },
  { id: "address",      label: "Address",           icon: <MapPinIcon />   },
  { id: "account",      label: "Account",           icon: <UserIcon />     },
  { id: "auto_approve", label: "Auto-Approve",      icon: <ShieldIcon />   },
  { id: "identifiers",  label: "Identifiers",       icon: <IdIcon />       },
];

async function apiFetch(path, options = {}) {
  const token = getInstituteToken();
  const res   = await fetch(`${INSTITUTE_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ── Read-only display row ─────────────────────────────────────────────
function DisplayRow({ label, value }) {
  return (
    <div className="st-display-row">
      <span className="st-display-label">{label}</span>
      <span className="st-display-value">{value || <span className="st-display-empty">Not set</span>}</span>
    </div>
  );
}

// ── Shared field wrapper ──────────────────────────────────────────────
function Field({ label, required, children }) {
  return (
    <div className="st-field">
      <label className="st-label">{label}{required && <span className="st-req">*</span>}</label>
      {children}
    </div>
  );
}

// ── Tab: Institute Profile ────────────────────────────────────────────
function ProfileTab() {
  const [data,    setData]    = useState(null);
  const [draft,   setDraft]   = useState(null); // editable copy
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    apiFetch("/settings/profile")
      .then((d) => { setData(d.institute); setDraft(d.institute); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleEdit   = () => { setDraft({ ...data }); setEditing(true); setError(""); setSuccess(""); };
  const handleCancel = () => { setDraft({ ...data }); setEditing(false); setError(""); };

  const handleSave = async () => {
    setError(""); setSuccess("");
    if (!draft.college_name?.trim())    { setError("College name is required."); return; }
    if (!draft.type?.trim())            { setError("Institute type is required."); return; }
    if (!draft.university_name?.trim()) { setError("University name is required."); return; }
    setSaving(true);
    try {
      await apiFetch("/settings/profile", {
        method: "PUT",
        body: JSON.stringify({
          college_name:    draft.college_name,
          type:            draft.type,
          university_name: draft.university_name,
          university_id:   draft.university_id || null,
        }),
      });
      setData({ ...draft });
      const p = JSON.parse(localStorage.getItem("institute_profile") || "{}");
      localStorage.setItem("institute_profile", JSON.stringify({ ...p, ...draft }));
      setSuccess("Profile updated successfully.");
      setEditing(false);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="st-loading">Loading…</div>;

  return (
    <div className="st-tab-content">
      <div className="st-tab-header">
        <div>
          <h3 className="st-tab-title">Institute Profile</h3>
          <p className="st-tab-sub">Your institute's public information.</p>
        </div>
        {!editing
          ? <button className="st-edit-btn" onClick={handleEdit}><EditIcon size={14}/> Edit</button>
          : <div className="st-edit-actions">
              <button className="st-cancel-btn" onClick={handleCancel}>Cancel</button>
              <button className="st-save-btn" disabled={saving} onClick={handleSave}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
        }
      </div>

      {error   && <div className="st-banner st-banner--err">{error}</div>}
      {success && <div className="st-banner st-banner--ok">{success}</div>}

      {!editing ? (
        <div className="st-display-list">
          <DisplayRow label="College Name"    value={data.college_name} />
          <DisplayRow label="Institute Type"  value={data.type} />
          <DisplayRow label="University Name" value={data.university_name} />
          <DisplayRow label="University ID"   value={data.university_id} />
        </div>
      ) : (
        <div className="st-fields">
          <Field label="College Name" required>
            <input className="st-input" value={draft.college_name || ""}
              onChange={(e) => setDraft({ ...draft, college_name: e.target.value })} />
          </Field>
          <Field label="Institute Type" required>
            <select className="st-input st-select" value={draft.type || ""}
              onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
              <option value="">Select type</option>
              {INSTITUTE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="University Name" required>
            <input className="st-input" value={draft.university_name || ""}
              onChange={(e) => setDraft({ ...draft, university_name: e.target.value })} />
          </Field>
          <Field label="University ID">
            <input className="st-input" value={draft.university_id || ""} placeholder="e.g. U-0602"
              onChange={(e) => setDraft({ ...draft, university_id: e.target.value })} />
          </Field>
        </div>
      )}
    </div>
  );
}

// ── Tab: Address ──────────────────────────────────────────────────────
function AddressTab() {
  const [data,    setData]    = useState(null);
  const [draft,   setDraft]   = useState(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    apiFetch("/settings/profile")
      .then((d) => { setData(d.institute); setDraft(d.institute); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleEdit   = () => { setDraft({ ...data }); setEditing(true); setError(""); setSuccess(""); };
  const handleCancel = () => { setDraft({ ...data }); setEditing(false); setError(""); };

  const handleSave = async () => {
    setError(""); setSuccess("");
    if (!draft.full_address?.trim()) { setError("Full address is required."); return; }
    if (!draft.city?.trim())         { setError("City is required."); return; }
    if (!draft.district?.trim())     { setError("District is required."); return; }
    if (!draft.state?.trim())        { setError("State is required."); return; }
    setSaving(true);
    try {
      await apiFetch("/settings/address", {
        method: "PUT",
        body: JSON.stringify({
          full_address: draft.full_address,
          city:         draft.city,
          district:     draft.district,
          state:        draft.state,
        }),
      });
      setData({ ...draft });
      const p = JSON.parse(localStorage.getItem("institute_profile") || "{}");
      localStorage.setItem("institute_profile", JSON.stringify({ ...p, ...draft }));
      setSuccess("Address updated successfully.");
      setEditing(false);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="st-loading">Loading…</div>;

  return (
    <div className="st-tab-content">
      <div className="st-tab-header">
        <div>
          <h3 className="st-tab-title">Address Details</h3>
          <p className="st-tab-sub">The physical address of your institute.</p>
        </div>
        {!editing
          ? <button className="st-edit-btn" onClick={handleEdit}><EditIcon size={14}/> Edit</button>
          : <div className="st-edit-actions">
              <button className="st-cancel-btn" onClick={handleCancel}>Cancel</button>
              <button className="st-save-btn" disabled={saving} onClick={handleSave}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
        }
      </div>

      {error   && <div className="st-banner st-banner--err">{error}</div>}
      {success && <div className="st-banner st-banner--ok">{success}</div>}

      {!editing ? (
        <div className="st-display-list">
          <DisplayRow label="Full Address" value={data.full_address} />
          <DisplayRow label="City"         value={data.city} />
          <DisplayRow label="District"     value={data.district} />
          <DisplayRow label="State"        value={data.state} />
        </div>
      ) : (
        <div className="st-fields">
          <Field label="Full Address" required>
            <textarea className="st-input st-textarea" rows={3}
              value={draft.full_address || ""}
              onChange={(e) => setDraft({ ...draft, full_address: e.target.value })} />
          </Field>
          <div className="st-two-col">
            <Field label="City" required>
              <input className="st-input" value={draft.city || ""}
                onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
            </Field>
            <Field label="District" required>
              <input className="st-input" value={draft.district || ""}
                onChange={(e) => setDraft({ ...draft, district: e.target.value })} />
            </Field>
          </div>
          <Field label="State" required>
            <select className="st-input st-select" value={draft.state || ""}
              onChange={(e) => setDraft({ ...draft, state: e.target.value })}>
              <option value="">Select state</option>
              {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
      )}
    </div>
  );
}

// ── Tab: Account ──────────────────────────────────────────────────────
function AccountTab() {
  const navigate  = useNavigate();
  const institute = getInstituteProfile();
  const [editing,  setEditing]  = useState(false);
  const [curPwd,   setCurPwd]   = useState("");
  const [newPwd,   setNewPwd]   = useState("");
  const [confPwd,  setConfPwd]  = useState("");
  const [showCur,  setShowCur]  = useState(false);
  const [showNew,  setShowNew]  = useState(false);
  const [showConf, setShowConf] = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState("");
  const [success,  setSuccess]  = useState("");

  const pwdTouched     = newPwd.length > 0;
  const allRulesPassed = PWD_RULES.every((r) => r.test(newPwd));
  const confirmMatch   = confPwd.length > 0 && newPwd === confPwd;
  const confirmBad     = confPwd.length > 0 && newPwd !== confPwd;

  const handleCancel = () => {
    setEditing(false); setCurPwd(""); setNewPwd(""); setConfPwd("");
    setError(""); setSuccess("");
  };

  const handleSave = async () => {
    setError(""); setSuccess("");
    if (!curPwd)         { setError("Current password is required."); return; }
    if (!allRulesPassed) { setError("New password does not meet all requirements."); return; }
    if (!confirmMatch)   { setError("Passwords do not match."); return; }
    setSaving(true);
    try {
      await apiFetch("/settings/password", {
        method: "PUT",
        body: JSON.stringify({ current_password: curPwd, new_password: newPwd }),
      });
      setSuccess("Password changed. Redirecting to login…");
      setTimeout(() => { clearInstituteSession(); navigate("/institute-login", { replace: true }); }, 2000);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="st-tab-content">
      <div className="st-tab-header">
        <div>
          <h3 className="st-tab-title">Account</h3>
          <p className="st-tab-sub">Manage your login credentials.</p>
        </div>
        {!editing
          ? <button className="st-edit-btn" onClick={() => { setEditing(true); setError(""); setSuccess(""); }}>
              <EditIcon size={14}/> Change Password
            </button>
          : <div className="st-edit-actions">
              <button className="st-cancel-btn" onClick={handleCancel}>Cancel</button>
              <button className="st-save-btn" disabled={saving} onClick={handleSave}>
                {saving ? "Saving…" : "Save Password"}
              </button>
            </div>
        }
      </div>

      {error   && <div className="st-banner st-banner--err">{error}</div>}
      {success && <div className="st-banner st-banner--ok">{success}</div>}

      {/* Email — always read only */}
      <div className="st-email-card">
        <MailIcon size={16} />
        <div>
          <span className="st-email-label">Login Email</span>
          <span className="st-email-value">{institute?.email || "—"}</span>
        </div>
        <span className="st-email-readonly">Read only</span>
      </div>

      {!editing ? (
        <div className="st-display-list">
          <DisplayRow label="Password" value="••••••••••••" />
        </div>
      ) : (
        <>
          <div className="st-divider" />
          <div className="st-fields">
            <Field label="Current Password" required>
              <div className="st-pwd-wrap">
                <input className="st-input" type={showCur ? "text" : "password"}
                  placeholder="Enter current password" value={curPwd}
                  onChange={(e) => setCurPwd(e.target.value)} />
                <button type="button" className="st-eye" onClick={() => setShowCur(v=>!v)}>
                  {showCur ? <EyeOffIcon size={16}/> : <EyeIcon size={16}/>}
                </button>
              </div>
            </Field>

            <Field label="New Password" required>
              <div className="st-pwd-wrap">
                <input
                  className={`st-input${pwdTouched ? (allRulesPassed ? " st-input--valid" : " st-input--invalid") : ""}`}
                  type={showNew ? "text" : "password"}
                  placeholder="Enter new password" value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)} />
                <button type="button" className="st-eye" onClick={() => setShowNew(v=>!v)}>
                  {showNew ? <EyeOffIcon size={16}/> : <EyeIcon size={16}/>}
                </button>
              </div>
              {pwdTouched && (
                <ul className="st-pwd-rules">
                  {PWD_RULES.map((rule) => (
                    <li key={rule.key} className={rule.test(newPwd) ? "st-rule--pass" : "st-rule--fail"}>
                      {rule.test(newPwd) ? <CheckIcon size={12}/> : <XIcon size={12}/>}
                      {rule.label}
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            <Field label="Confirm New Password" required>
              <div className="st-pwd-wrap">
                <input
                  className={`st-input${confirmMatch ? " st-input--valid" : confirmBad ? " st-input--invalid" : ""}`}
                  type={showConf ? "text" : "password"}
                  placeholder="Confirm new password" value={confPwd}
                  onChange={(e) => setConfPwd(e.target.value)} />
                <button type="button" className="st-eye" onClick={() => setShowConf(v=>!v)}>
                  {showConf ? <EyeOffIcon size={16}/> : <EyeIcon size={16}/>}
                </button>
              </div>
              {confirmMatch && <p className="st-match-ok">✓ Passwords match</p>}
              {confirmBad   && <p className="st-match-err">✗ Passwords do not match</p>}
            </Field>
          </div>
        </>
      )}
    </div>
  );
}

// ── Tab: Auto-Approve ─────────────────────────────────────────────────
function AutoApproveTab() {
  const [enabled,   setEnabled]   = useState(false);
  const [domains,   setDomains]   = useState([]);
  const [draft,     setDraft]     = useState({ enabled: false, domains: [] });
  const [editing,   setEditing]   = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState("");
  const [success,   setSuccess]   = useState("");
  const [domainErr, setDomainErr] = useState("");

  useEffect(() => {
    apiFetch("/settings/auto-approve")
      .then((d) => {
        setEnabled(d.auto_approve_enabled);
        setDomains(d.auto_approve_domains || []);
        setDraft({ enabled: d.auto_approve_enabled, domains: d.auto_approve_domains || [] });
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleEdit   = () => { setDraft({ enabled, domains: [...domains] }); setEditing(true); setError(""); setSuccess(""); };
  const handleCancel = () => { setDraft({ enabled, domains: [...domains] }); setEditing(false); setNewDomain(""); setDomainErr(""); setError(""); };

  const addDomain = () => {
    setDomainErr("");
    const d = newDomain.trim().toLowerCase();
    if (!d) { setDomainErr("Enter a domain name."); return; }
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z]{2,})+$/;
    if (!domainRegex.test(d)) { setDomainErr("Invalid format. e.g. ves.ac.in"); return; }
    if (draft.domains.includes(d)) { setDomainErr("Domain already added."); return; }
    setDraft((p) => ({ ...p, domains: [...p.domains, d] }));
    setNewDomain("");
  };

  const removeDomain = (d) => setDraft((p) => ({ ...p, domains: p.domains.filter((x) => x !== d) }));

  const handleSave = async () => {
    setError(""); setSuccess("");
    setSaving(true);
    try {
      await apiFetch("/settings/auto-approve", {
        method: "PUT",
        body: JSON.stringify({ auto_approve_enabled: draft.enabled, auto_approve_domains: draft.domains }),
      });
      setEnabled(draft.enabled);
      setDomains([...draft.domains]);
      setSuccess("Auto-approve settings saved.");
      setEditing(false);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="st-loading">Loading…</div>;

  return (
    <div className="st-tab-content">
      <div className="st-tab-header">
        <div>
          <h3 className="st-tab-title">Auto-Approve</h3>
          <p className="st-tab-sub">Automatically approve students with trusted email domains.</p>
        </div>
        {!editing
          ? <button className="st-edit-btn" onClick={handleEdit}><EditIcon size={14}/> Edit</button>
          : <div className="st-edit-actions">
              <button className="st-cancel-btn" onClick={handleCancel}>Cancel</button>
              <button className="st-save-btn" disabled={saving} onClick={handleSave}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
        }
      </div>

      {error   && <div className="st-banner st-banner--err">{error}</div>}
      {success && <div className="st-banner st-banner--ok">{success}</div>}

      {/* Read-only view */}
      {!editing ? (
        <>
          <div className="st-display-list">
            <div className="st-display-row">
              <span className="st-display-label">Status</span>
              <span className={`st-auto-badge ${enabled ? "st-auto-badge--on" : "st-auto-badge--off"}`}>
                <span className="st-auto-dot" />
                {enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <div className="st-display-row st-display-row--col">
              <span className="st-display-label">Trusted Domains</span>
              {domains.length === 0
                ? <span className="st-display-empty">No domains configured</span>
                : <div className="st-domain-chips">
                    {domains.map((d) => (
                      <div key={d} className="st-domain-chip">
                        <GlobeIcon size={12}/> {d}
                      </div>
                    ))}
                  </div>
              }
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Toggle */}
          <div className="st-toggle-card">
            <div>
              <p className="st-toggle-label">Enable Auto-Approve</p>
              <p className="st-toggle-sub">{draft.enabled ? "Auto-approve is active." : "Auto-approve is disabled."}</p>
            </div>
            <button className={`st-toggle-btn${draft.enabled ? " st-toggle-btn--on" : ""}`}
              onClick={() => setDraft((p) => ({ ...p, enabled: !p.enabled }))}>
              <span className="st-toggle-knob" />
            </button>
          </div>

          {/* Domain management */}
          <div className={`st-domain-section${!draft.enabled ? " st-domain-section--disabled" : ""}`}>
            <h4 className="st-section-title">Trusted Domains</h4>
            <div className="st-domain-add-row">
              <input className="st-input st-domain-input"
                placeholder="e.g. ves.ac.in" value={newDomain}
                onChange={(e) => { setNewDomain(e.target.value); setDomainErr(""); }}
                onKeyDown={(e) => e.key === "Enter" && addDomain()}
                disabled={!draft.enabled} />
              <button className="st-domain-add-btn" onClick={addDomain} disabled={!draft.enabled}>
                <PlusIcon size={14}/> Add
              </button>
            </div>
            {domainErr && <p className="st-domain-err">{domainErr}</p>}
            {draft.domains.length === 0
              ? <p className="st-domain-empty">No trusted domains added yet.</p>
              : <div className="st-domain-chips">
                  {draft.domains.map((d) => (
                    <div key={d} className="st-domain-chip">
                      <GlobeIcon size={12}/> {d}
                      <button className="st-domain-remove" onClick={() => removeDomain(d)}
                        disabled={!draft.enabled}>✕</button>
                    </div>
                  ))}
                </div>
            }
            <div className="st-domain-note">
              <InfoIcon size={14}/>
              Students registering with a listed domain will be approved instantly.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Tab: Identifiers ──────────────────────────────────────────────────
function IdentifiersTab() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");

  useEffect(() => {
    apiFetch("/settings/identifiers")
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="st-loading">Loading…</div>;

  return (
    <div className="st-tab-content">
      <div className="st-tab-header">
        <div>
          <h3 className="st-tab-title">Identifiers</h3>
          <p className="st-tab-sub">Read-only. Contact support to update.</p>
        </div>
      </div>

      {error && <div className="st-banner st-banner--err">{error}</div>}

      <div className="st-display-list">
        <DisplayRow label="AISHE Code" value={data?.aishe_code} />
        <DisplayRow label="DTE Code"   value={data?.dte_code}   />
        <DisplayRow label="UDISE Code" value={data?.udise_code} />
      </div>

      <div className="st-identifier-note">
        <InfoIcon size={14}/>
        To update any identifier, email{" "}
        <a href="mailto:support@presencepro.app">support@presencepro.app</a>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────
export default function SettingsPage() {
  const navigate  = useNavigate();
  const institute = getInstituteProfile();
  const [activeTab, setActiveTab] = useState("profile");

  useEffect(() => {
    if (!getInstituteToken()) navigate("/institute-login", { replace: true });
  }, []);

  const renderTab = () => {
    switch (activeTab) {
      case "profile":      return <ProfileTab />;
      case "address":      return <AddressTab />;
      case "account":      return <AccountTab />;
      case "auto_approve": return <AutoApproveTab />;
      case "identifiers":  return <IdentifiersTab />;
      default:             return null;
    }
  };

  return (
    <div className="db-shell">
      <Sidebar />
      <div className="db-main">
        <header className="db-topbar">
          <div className="db-topbar-left">
            <h1 className="db-topbar-title">Settings</h1>
          </div>
          <div className="db-topbar-right">
            <BuildingIcon size={18}/>
            <span className="db-topbar-college">{institute?.college_name}</span>
            <span className="db-topbar-aishe-badge">AISHE: {institute?.aishe_code}</span>
          </div>
        </header>

        <main className="db-content">
          <div className="st-shell">
            <div className="st-tabs">
              {TABS.map((tab) => (
                <button key={tab.id}
                  className={`st-tab-btn${activeTab === tab.id ? " st-tab-btn--active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}>
                  <span className="st-tab-icon">{tab.icon}</span>
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="st-content">{renderTab()}</div>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ── Icons ───────────────────────────────────────────────────────────── */
const Svg = ({ size=20, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
function BuildingIcon({ size=20 }) { return <Svg size={size}><path d="M3 21h18"/><path d="M5 21V8l7-4 7 4v13"/><path d="M9 21v-6h6v6"/></Svg>; }
function MapPinIcon({ size=20 })   { return <Svg size={size}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></Svg>; }
function UserIcon({ size=20 })     { return <Svg size={size}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></Svg>; }
function ShieldIcon({ size=20 })   { return <Svg size={size}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></Svg>; }
function IdIcon({ size=20 })       { return <Svg size={size}><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></Svg>; }
function MailIcon({ size=20 })     { return <Svg size={size}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></Svg>; }
function PlusIcon({ size=20 })     { return <Svg size={size}><path d="M12 5v14M5 12h14"/></Svg>; }
function GlobeIcon({ size=20 })    { return <Svg size={size}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></Svg>; }
function InfoIcon({ size=20 })     { return <Svg size={size}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></Svg>; }
function EditIcon({ size=20 })     { return <Svg size={size}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></Svg>; }
function EyeIcon({ size=20 })      { return <Svg size={size}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></Svg>; }
function EyeOffIcon({ size=20 })   { return <Svg size={size}><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M6.61 6.61A18.5 18.5 0 0 0 1 12s4 8 11 8a9.26 9.26 0 0 0 5.39-1.61"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></Svg>; }
function CheckIcon({ size=20 })    { return <Svg size={size}><path d="M20 6L9 17l-5-5"/></Svg>; }
function XIcon({ size=20 })        { return <Svg size={size}><path d="M18 6L6 18M6 6l12 12"/></Svg>; }