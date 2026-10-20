const express  = require("express");
const router   = express.Router();
const bcrypt   = require("bcryptjs");
const { FieldValue } = require("firebase-admin/firestore");
const { workingDb, instituteDb, COLLECTIONS } = require("../config/firebase");
const { requireAuth, rateLimit, wrap, revokeAllSessions } = require("../middleware/security");
const { cleanDomains, mirrorSettings } = require("../utils/autoApprove");

router.use(requireAuth);

const PWD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,72}$/;
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const passwordLimiter = rateLimit({
  windowMs: 15 * 60_000, max: 8, name: "pwd", key: (req) => req.institute.institute_id,
});

const instituteRef = (req) => instituteDb.collection(COLLECTIONS.INSTITUTES).doc(req.institute.institute_id);

async function loadInstitute(req, res) {
  const doc = await instituteRef(req).get();
  if (!doc.exists) { res.status(404).json({ error: "Institute not found." }); return null; }
  return doc.data();
}

// ── GET /settings/profile ─────────────────────────────────────────────
router.get("/profile", wrap("GET PROFILE", async (req, res) => {
  const data = await loadInstitute(req, res);
  if (!data) return;
  const { password_hash: _drop, ...safe } = data;
  return res.status(200).json({ success: true, institute: safe });
}));

// ── PUT /settings/profile ─────────────────────────────────────────────
router.put("/profile", wrap("UPDATE PROFILE", async (req, res) => {
  const college_name    = str(req.body.college_name);
  const type            = str(req.body.type, 60);
  const university_name = str(req.body.university_name);
  const university_id   = str(req.body.university_id, 80);

  if (!college_name)    return res.status(400).json({ error: "College name is required." });
  if (!type)            return res.status(400).json({ error: "Institute type is required." });
  if (!university_name) return res.status(400).json({ error: "University name is required." });

  await instituteRef(req).update({
    college_name, type, university_name,
    university_id: university_id || null,
    updated_at: FieldValue.serverTimestamp(),
  });
  return res.status(200).json({ success: true, message: "Profile updated successfully." });
}));

// ── PUT /settings/address ─────────────────────────────────────────────
router.put("/address", wrap("UPDATE ADDRESS", async (req, res) => {
  const full_address = str(req.body.full_address, 500);
  const city = str(req.body.city), district = str(req.body.district), state = str(req.body.state);

  if (!full_address) return res.status(400).json({ error: "Full address is required." });
  if (!city)         return res.status(400).json({ error: "City is required." });
  if (!district)     return res.status(400).json({ error: "District is required." });
  if (!state)        return res.status(400).json({ error: "State is required." });

  await instituteRef(req).update({ full_address, city, district, state, updated_at: FieldValue.serverTimestamp() });
  return res.status(200).json({ success: true, message: "Address updated successfully." });
}));

// ── PUT /settings/password ────────────────────────────────────────────
router.put("/password", passwordLimiter, wrap("CHANGE PASSWORD", async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (typeof current_password !== "string" || typeof new_password !== "string" || !current_password || !new_password) {
    return res.status(400).json({ error: "current_password and new_password are required." });
  }
  if (!PWD_RE.test(new_password)) {
    return res.status(400).json({
      error: "New password must be 8-72 characters with uppercase, lowercase, number and special character.",
    });
  }

  const data = await loadInstitute(req, res);
  if (!data) return;

  if (!(await bcrypt.compare(current_password, data.password_hash))) {
    return res.status(400).json({ error: "Current password is incorrect." });
  }
  if (await bcrypt.compare(new_password, data.password_hash)) {
    return res.status(400).json({ error: "New password must be different from current password." });
  }

  await instituteRef(req).update({
    password_hash: await bcrypt.hash(new_password, 12),
    updated_at: FieldValue.serverTimestamp(),
  });
  await revokeAllSessions(req.institute.institute_id); // every device, including this one

  return res.status(200).json({ success: true, message: "Password changed successfully. Please log in again." });
}));

// ── GET /settings/auto-approve ────────────────────────────────────────
router.get("/auto-approve", wrap("GET AUTO APPROVE", async (req, res) => {
  const data = await loadInstitute(req, res);
  if (!data) return;
  return res.status(200).json({
    success: true,
    auto_approve_enabled: data.auto_approve_enabled === true,
    auto_approve_domains: Array.isArray(data.auto_approve_domains) ? data.auto_approve_domains : [],
  });
}));

// ── PUT /settings/auto-approve ────────────────────────────────────────
// Saves the toggle + domain list on the institute AND copies it to the working
// DB (college_settings/{aishe}) where the student registration reads it.
router.put("/auto-approve", wrap("AUTO APPROVE", async (req, res) => {
  const enabled = req.body.auto_approve_enabled === true;
  const c = cleanDomains(req.body.auto_approve_domains);
  if (c.error) return res.status(400).json({ error: c.error });
  if (enabled && c.domains.length === 0) {
    return res.status(400).json({ error: "Add at least one domain before turning auto-approve on." });
  }

  const { aishe_code } = req.institute;
  if (!aishe_code) {
    return res.status(400).json({ error: "Auto-approve needs an AISHE code on this account." });
  }

  // the copy that registration reads goes first: if it fails nothing looks saved
  await mirrorSettings(workingDb, aishe_code, enabled, c.domains);
  await instituteRef(req).update({
    auto_approve_enabled: enabled,
    auto_approve_domains: c.domains,
    updated_at: FieldValue.serverTimestamp(),
  });

  return res.status(200).json({
    success: true,
    message: "Auto-approve settings saved.",
    auto_approve_enabled: enabled,
    auto_approve_domains: c.domains,
  });
}));

// ── GET /settings/identifiers ─────────────────────────────────────────
router.get("/identifiers", wrap("GET IDENTIFIERS", async (req, res) => {
  const data = await loadInstitute(req, res);
  if (!data) return;
  return res.status(200).json({
    success: true,
    aishe_code: data.aishe_code || null,
    dte_code:   data.dte_code   || null,
    udise_code: data.udise_code || null,
  });
}));

module.exports = { router, prefix: "/settings" };