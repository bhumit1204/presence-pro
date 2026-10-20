const express = require("express");
const router  = express.Router();
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const { FieldValue } = require("firebase-admin/firestore");

const { workingDb, instituteDb, COLLECTIONS } = require("../config/firebase");
const {
  rateLimit, wrap, createSession, revokeSession, requireAuth, bearer,
} = require("../middleware/security");

// New institute accounts are active straight away (as before). Set
// INSTITUTE_REQUIRE_APPROVAL=true to create them inactive until you switch
// is_active to true on the institutes/{id} document yourself.
const REQUIRE_APPROVAL = process.env.INSTITUTE_REQUIRE_APPROVAL === "true";

const PWD_RE   = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,72}$/; // bcrypt ignores bytes past 72
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_RE  = /^[A-Za-z0-9._\- ]{1,40}$/;

const str  = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const code = (v) => { const s = str(v, 40); return s && CODE_RE.test(s) ? s : ""; };

// A real hash to compare against when the account does not exist, so a miss
// costs the same time as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

const loginLimiter    = rateLimit({ windowMs: 15 * 60_000, max: 10, name: "login",
  key: (req) => `${req.ip}|${str(req.body && req.body.instituteCode, 80).toLowerCase()}` });
const loginIpLimiter  = rateLimit({ windowMs: 15 * 60_000, max: 40, name: "login-ip" });
const registerLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10, name: "register" });
const lookupLimiter   = rateLimit({ windowMs: 60_000, max: 30, name: "lookup" });

// ── POST /auth/institute-register ─────────────────────────────────────
router.post("/institute-register", registerLimiter, wrap("INSTITUTE REGISTER", async (req, res) => {
  const b = req.body || {};

  const aishe_code = code(b.aishe_code);
  const dte_code   = code(b.dte_code);
  const udise_code = code(b.udise_code);
  const college_name    = str(b.college_name);
  const district        = str(b.district);
  const full_address    = str(b.full_address, 500);
  const city            = str(b.city);
  const state           = str(b.state);
  const type            = str(b.type, 60);
  const university_id   = str(b.university_id, 80);
  const university_name = str(b.university_name);
  const email           = str(b.email, 254).toLowerCase();
  const password        = typeof b.password === "string" ? b.password : "";

  // 1. required fields
  const missing = [];
  if (!college_name)    missing.push("college_name");
  if (!district)        missing.push("district");
  if (!full_address)    missing.push("full_address");
  if (!city)            missing.push("city");
  if (!state)           missing.push("state");
  if (!type)            missing.push("type");
  if (!university_name) missing.push("university_name");
  if (!email)           missing.push("email");
  if (!password)        missing.push("password");
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });

  // 2. at least one identifier (and a malformed one is an error, not "absent")
  for (const [k, raw] of [["aishe_code", b.aishe_code], ["dte_code", b.dte_code], ["udise_code", b.udise_code]]) {
    if (raw && !code(raw)) return res.status(400).json({ error: `${k} is not valid.` });
  }
  if (!aishe_code && !dte_code && !udise_code) {
    return res.status(400).json({ error: "At least one of aishe_code, dte_code, or udise_code is required." });
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid e-mail address." });

  // 3. password strength
  if (!PWD_RE.test(password)) {
    return res.status(400).json({
      error: "Password must be 8-72 characters and include uppercase, lowercase, number, and special character.",
    });
  }

  // 4/5. uniqueness
  const inst = instituteDb.collection(COLLECTIONS.INSTITUTES);
  const [emailCheck, aisheCheck] = await Promise.all([
    inst.where("email", "==", email).limit(1).get(),
    aishe_code ? inst.where("aishe_code", "==", aishe_code).limit(1).get() : Promise.resolve(null),
  ]);
  if (!emailCheck.empty) return res.status(409).json({ error: "An institute with this email already exists." });
  if (aisheCheck && !aisheCheck.empty) return res.status(409).json({ error: "An institute with this AISHE code already exists." });

  // 6. hash
  const password_hash = await bcrypt.hash(password, 12);

  // 7. college record in the working DB (re-use if the AISHE code is already there)
  let collegeDocId = null;
  if (aishe_code) {
    const existing = await workingDb.collection(COLLECTIONS.COLLEGES)
      .where("aishe_code", "==", aishe_code).limit(1).get();
    if (!existing.empty) collegeDocId = existing.docs[0].id;
  }
  if (!collegeDocId) {
    const collegeRef = workingDb.collection(COLLECTIONS.COLLEGES).doc();
    await collegeRef.set({
      college_name,
      search_name: college_name.toLowerCase(),
      district, state, type, university_name,
      aishe_code: aishe_code || null,
      university_id: university_id || null,
      created_at: FieldValue.serverTimestamp(),
    });
    collegeDocId = collegeRef.id;
  }

  // 8. institute account
  const instituteRef = inst.doc();
  const institute_id = instituteRef.id;
  const now = FieldValue.serverTimestamp();
  await instituteRef.set({
    institute_id,
    college_doc_id: collegeDocId,
    aishe_code: aishe_code || null,
    dte_code: dte_code || null,
    udise_code: udise_code || null,
    college_name, district, state, type,
    university_id: university_id || null,
    university_name, full_address, city,
    email,
    password_hash,
    is_active: !REQUIRE_APPROVAL,
    auto_approve_enabled: false,
    auto_approve_domains: [],
    created_at: now,
    updated_at: now,
  });

  return res.status(201).json({
    success: true,
    message: REQUIRE_APPROVAL
      ? "Institute registered successfully. Awaiting admin approval."
      : "Institute registered successfully.",
    institute_id,
    college_doc_id: collegeDocId,
  });
}));

// ── POST /auth/institute-login ────────────────────────────────────────
router.post("/institute-login", loginIpLimiter, loginLimiter, wrap("INSTITUTE LOGIN", async (req, res) => {
  const instituteCode = str(req.body && req.body.instituteCode, 254);
  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
  if (!instituteCode || !password) {
    return res.status(400).json({ error: "instituteCode and password are required." });
  }
  if (password.length > 200) return res.status(401).json({ error: "Invalid credentials." });

  // the field takes either the e-mail or the AISHE code
  const byEmail = instituteCode.includes("@");
  const snap = await instituteDb.collection(COLLECTIONS.INSTITUTES)
    .where(byEmail ? "email" : "aishe_code", "==", byEmail ? instituteCode.toLowerCase() : instituteCode)
    .limit(1).get();

  const institute = snap.empty ? null : snap.docs[0].data();
  const ok = await bcrypt.compare(password, institute ? institute.password_hash || DUMMY_HASH : DUMMY_HASH);

  // one message for "no such institute" and "wrong password"
  if (!institute || !ok) return res.status(401).json({ error: "Invalid credentials." });
  if (institute.is_active === false) {
    return res.status(403).json({ error: "This institute account is not active." });
  }

  const token = await createSession(institute, req);
  const { password_hash: _drop, ...safeInstitute } = institute;
  return res.status(200).json({ success: true, message: "Login successful.", token, institute: safeInstitute });
}));

// ── GET /auth/institute-me ────────────────────────────────────────────
router.get("/institute-me", requireAuth, wrap("INSTITUTE ME", async (req, res) => {
  const doc = await instituteDb.collection(COLLECTIONS.INSTITUTES).doc(req.institute.institute_id).get();
  if (!doc.exists) return res.status(404).json({ error: "Institute not found." });
  const { password_hash: _drop, ...safeInstitute } = doc.data();
  return res.status(200).json({ success: true, institute: safeInstitute });
}));

// ── POST /auth/institute-logout ───────────────────────────────────────
router.post("/institute-logout", wrap("INSTITUTE LOGOUT", async (req, res) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "No token provided." });
  // an expired token should still be able to log out
  let claims = null;
  try { claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"], ignoreExpiration: true }); } catch { /* ignore */ }
  if (claims && claims.sid) await revokeSession(claims.sid);
  return res.status(200).json({ success: true, message: "Logged out successfully." });
}));

// ── GET /auth/find-with-aishe?code=C-10007 ────────────────────────────
router.get("/find-with-aishe", lookupLimiter, wrap("FIND WITH AISHE", async (req, res) => {
  const c = code(req.query.code);
  if (!c) return res.status(400).json({ error: "AISHE code is required. Use ?code=C-10007" });

  const [snap, already] = await Promise.all([
    workingDb.collection(COLLECTIONS.COLLEGES).where("aishe_code", "==", c).limit(1).get(),
    instituteDb.collection(COLLECTIONS.INSTITUTES).where("aishe_code", "==", c).limit(1).get(),
  ]);
  if (snap.empty) return res.status(404).json({ error: "Institute not found in AISHE database." });

  const data = snap.docs[0].data();
  return res.status(200).json({
    success: true,
    already_registered: !already.empty,
    aishe_code:      data.aishe_code      || null,
    college_name:    data.college_name    || null,
    district:        data.district        || null,
    search_name:     data.search_name     || null,
    state:           data.state           || null,
    type:            data.type            || null,
    university_id:   data.university_id   || null,
    university_name: data.university_name || null,
  });
}));

module.exports = router;