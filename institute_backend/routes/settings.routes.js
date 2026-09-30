const express  = require("express");
const router   = express.Router();
const jwt      = require("jsonwebtoken");
const bcrypt   = require("bcryptjs");
const { FieldValue } = require("firebase-admin/firestore");
const { instituteDb, COLLECTIONS } = require("../config/firebase");

// ── Auth middleware ───────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided." });
  }
  try {
    req.institute = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

// ── Helper: get institute doc ─────────────────────────────────────────
async function getInstituteDoc(institute_id) {
  const doc = await instituteDb.collection(COLLECTIONS.INSTITUTES).doc(institute_id).get();
  if (!doc.exists) throw new Error("Institute not found.");
  return doc;
}

// ── GET /settings/profile ─────────────────────────────────────────────
// Returns full institute profile (minus password_hash)
router.get("/profile", verifyToken, async (req, res) => {
  try {
    const doc  = await getInstituteDoc(req.institute.institute_id);
    const data = doc.data();
    const { password_hash: _, ...safe } = data;
    return res.status(200).json({ success: true, institute: safe });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /settings/profile ─────────────────────────────────────────────
// Updates: college_name, type, university_name, university_id
router.put("/profile", verifyToken, async (req, res) => {
  try {
    const { college_name, type, university_name, university_id } = req.body;

    if (!college_name?.trim()) return res.status(400).json({ error: "College name is required." });
    if (!type?.trim())         return res.status(400).json({ error: "Institute type is required." });
    if (!university_name?.trim()) return res.status(400).json({ error: "University name is required." });

    await instituteDb.collection(COLLECTIONS.INSTITUTES)
      .doc(req.institute.institute_id).update({
        college_name:    college_name.trim(),
        type:            type.trim(),
        university_name: university_name.trim(),
        university_id:   university_id?.trim() || null,
        updated_at:      FieldValue.serverTimestamp(),
      });

    return res.status(200).json({ success: true, message: "Profile updated successfully." });
  } catch (error) {
    console.error("UPDATE PROFILE ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /settings/address ─────────────────────────────────────────────
// Updates: full_address, city, district, state
router.put("/address", verifyToken, async (req, res) => {
  try {
    const { full_address, city, district, state } = req.body;

    if (!full_address?.trim()) return res.status(400).json({ error: "Full address is required." });
    if (!city?.trim())         return res.status(400).json({ error: "City is required." });
    if (!district?.trim())     return res.status(400).json({ error: "District is required." });
    if (!state?.trim())        return res.status(400).json({ error: "State is required." });

    await instituteDb.collection(COLLECTIONS.INSTITUTES)
      .doc(req.institute.institute_id).update({
        full_address: full_address.trim(),
        city:         city.trim(),
        district:     district.trim(),
        state:        state.trim(),
        updated_at:   FieldValue.serverTimestamp(),
      });

    return res.status(200).json({ success: true, message: "Address updated successfully." });
  } catch (error) {
    console.error("UPDATE ADDRESS ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /settings/password ────────────────────────────────────────────
// Changes password — requires current password verification
router.put("/password", verifyToken, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: "current_password and new_password are required." });
    }

    // Validate new password strength
    const pwdRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
    if (!pwdRegex.test(new_password)) {
      return res.status(400).json({
        error: "New password must be at least 8 characters with uppercase, lowercase, number and special character.",
      });
    }

    const doc  = await getInstituteDoc(req.institute.institute_id);
    const data = doc.data();

    // Verify current password
    const match = await bcrypt.compare(current_password, data.password_hash);
    if (!match) return res.status(401).json({ error: "Current password is incorrect." });

    // Ensure new password is different
    const same = await bcrypt.compare(new_password, data.password_hash);
    if (same) return res.status(400).json({ error: "New password must be different from current password." });

    const new_hash = await bcrypt.hash(new_password, 12);

    await instituteDb.collection(COLLECTIONS.INSTITUTES)
      .doc(req.institute.institute_id).update({
        password_hash: new_hash,
        updated_at:    FieldValue.serverTimestamp(),
      });

    // Invalidate all existing sessions
    const sessionSnap = await instituteDb
      .collection(COLLECTIONS.INSTITUTE_SESSIONS)
      .where("institute_id", "==", req.institute.institute_id)
      .where("is_valid", "==", true)
      .get();

    const batch = instituteDb.batch();
    sessionSnap.docs.forEach((d) => batch.update(d.ref, { is_valid: false }));
    if (sessionSnap.docs.length > 0) await batch.commit();

    return res.status(200).json({
      success: true,
      message: "Password changed successfully. Please log in again.",
    });
  } catch (error) {
    console.error("CHANGE PASSWORD ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── GET /settings/auto-approve ────────────────────────────────────────
// Returns auto-approve config
router.get("/auto-approve", verifyToken, async (req, res) => {
  try {
    const doc  = await getInstituteDoc(req.institute.institute_id);
    const data = doc.data();
    return res.status(200).json({
      success:         true,
      auto_approve_enabled: data.auto_approve_enabled || false,
      auto_approve_domains: data.auto_approve_domains || [],
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── PUT /settings/auto-approve ────────────────────────────────────────
// Updates auto-approve toggle + domains list
router.put("/auto-approve", verifyToken, async (req, res) => {
  try {
    const { auto_approve_enabled, auto_approve_domains } = req.body;

    if (!Array.isArray(auto_approve_domains)) {
      return res.status(400).json({ error: "auto_approve_domains must be an array." });
    }

    // Validate domain format
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z]{2,})+$/;
    const invalid = auto_approve_domains.filter((d) => !domainRegex.test(d));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid domain(s): ${invalid.join(", ")}` });
    }

    await instituteDb.collection(COLLECTIONS.INSTITUTES)
      .doc(req.institute.institute_id).update({
        auto_approve_enabled: !!auto_approve_enabled,
        auto_approve_domains: auto_approve_domains.map((d) => d.toLowerCase().trim()),
        updated_at: FieldValue.serverTimestamp(),
      });

    return res.status(200).json({ success: true, message: "Auto-approve settings saved." });
  } catch (error) {
    console.error("AUTO APPROVE ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── GET /settings/identifiers ─────────────────────────────────────────
// Returns read-only identifiers
router.get("/identifiers", verifyToken, async (req, res) => {
  try {
    const doc  = await getInstituteDoc(req.institute.institute_id);
    const data = doc.data();
    return res.status(200).json({
      success:    true,
      aishe_code: data.aishe_code  || null,
      dte_code:   data.dte_code    || null,
      udise_code: data.udise_code  || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = { router, prefix: "/settings" };