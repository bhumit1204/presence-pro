const express   = require("express");
const router    = express.Router();
const bcrypt    = require("bcryptjs");
const jwt       = require("jsonwebtoken");
const { FieldValue } = require("firebase-admin/firestore");

const { workingDb, instituteDb, COLLECTIONS } = require("../config/firebase");

// ── POST /auth/institute-register ─────────────────────────────────────
router.post("/institute-register", async (req, res) => {
  try {
    const {
      aishe_code,
      dte_code,
      udise_code,
      college_name,
      district,
      full_address,
      city,
      state,
      type,
      university_id,
      university_name,
      email,
      password,
    } = req.body;

    // ── 1. Validate required fields ─────────────────────────────────
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

    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(", ")}`,
      });
    }

    // ── 2. Validate identifier — need at least one of aishe/dte/udise ─
    if (!aishe_code && !dte_code && !udise_code) {
      return res.status(400).json({
        error: "At least one of aishe_code, dte_code, or udise_code is required.",
      });
    }

    // ── 3. Validate password strength ───────────────────────────────
    const pwdRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
    if (!pwdRegex.test(password)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters and include uppercase, lowercase, number, and special character.",
      });
    }

    // ── 4. Check email not already registered ───────────────────────
    const emailCheck = await instituteDb
      .collection(COLLECTIONS.INSTITUTES)
      .where("email", "==", email.trim().toLowerCase())
      .limit(1)
      .get();

    if (!emailCheck.empty) {
      return res.status(409).json({ error: "An institute with this email already exists." });
    }

    // ── 5. Check AISHE code not already registered (if provided) ────
    if (aishe_code) {
      const aisheCheck = await instituteDb
        .collection(COLLECTIONS.INSTITUTES)
        .where("aishe_code", "==", aishe_code.trim())
        .limit(1)
        .get();

      if (!aisheCheck.empty) {
        return res.status(409).json({ error: "An institute with this AISHE code already exists." });
      }
    }

    // ── 6. Hash password ────────────────────────────────────────────
    const password_hash = await bcrypt.hash(password, 12);

    // ── 7. Build college data for workingDb (colleges/) ─────────────
    //    Only store the fields that belong in the colleges collection.
    //    If AISHE code provided, check if college already exists first.
    let collegeDocId = null;

    if (aishe_code) {
      const existingCollege = await workingDb
        .collection(COLLECTIONS.COLLEGES)
        .where("aishe_code", "==", aishe_code.trim())
        .limit(1)
        .get();

      if (!existingCollege.empty) {
        // College already in working DB — just grab its ID
        collegeDocId = existingCollege.docs[0].id;
      }
    }

    if (!collegeDocId) {
      // College not in working DB yet — create it
      const collegeRef = workingDb.collection(COLLECTIONS.COLLEGES).doc();
      const collegePayload = {
        college_name:    college_name.trim(),
        search_name:     college_name.trim().toLowerCase(),
        district:        district.trim(),
        state:           state.trim(),
        type:            type.trim(),
        university_name: university_name.trim(),
        aishe_code:      aishe_code     ? aishe_code.trim()     : null,
        university_id:   university_id  ? university_id.trim()  : null,
        created_at:      FieldValue.serverTimestamp(),
      };
      await collegeRef.set(collegePayload);
      collegeDocId = collegeRef.id;
    }

    // ── 8. Save institute account to instituteDb (institutes/) ───────
    const instituteRef  = instituteDb.collection(COLLECTIONS.INSTITUTES).doc();
    const institute_id  = instituteRef.id;
    const now           = FieldValue.serverTimestamp();

    await instituteRef.set({
      institute_id,
      college_doc_id:  collegeDocId,
      aishe_code:      aishe_code   ? aishe_code.trim()   : null,
      dte_code:        dte_code     ? dte_code.trim()      : null,
      udise_code:      udise_code   ? udise_code.trim()    : null,
      college_name:    college_name.trim(),
      district:        district.trim(),
      state:           state.trim(),
      type:            type.trim(),
      university_id:   university_id   ? university_id.trim()   : null,
      university_name: university_name.trim(),
      full_address:    full_address.trim(),
      city:            city.trim(),
      email:           email.trim().toLowerCase(),
      password_hash,
      is_active:       true,
      created_at:      now,
      updated_at:      now,
    });

    // ── 9. Respond ──────────────────────────────────────────────────
    return res.status(201).json({
      success: true,
      message: "Institute registered successfully. Awaiting admin approval.",
      institute_id,
      college_doc_id: collegeDocId,
    });

  } catch (error) {
    console.error("INSTITUTE REGISTER ERROR:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// ── POST /auth/institute-login ────────────────────────────────────────
router.post("/institute-login", async (req, res) => {
  try {
    const { instituteCode, password } = req.body;

    if (!instituteCode || !password) {
      return res.status(400).json({ error: "instituteCode and password are required." });
    }

    // ── 1. Find institute by email OR aishe_code ─────────────────────
    //    InstituteLogin.jsx sends "instituteCode" which can be either
    const isEmail = instituteCode.includes("@");

    let snap;
    if (isEmail) {
      snap = await instituteDb
        .collection(COLLECTIONS.INSTITUTES)
        .where("email", "==", instituteCode.trim().toLowerCase())
        .limit(1)
        .get();
    } else {
      snap = await instituteDb
        .collection(COLLECTIONS.INSTITUTES)
        .where("aishe_code", "==", instituteCode.trim())
        .limit(1)
        .get();
    }

    if (snap.empty) {
      return res.status(404).json({ error: "Institute not found." });
    }

    const instituteDoc  = snap.docs[0];
    const institute     = instituteDoc.data();

    // ── 2. Check active status ───────────────────────────────────────
    if (!institute.is_active) {
      return res.status(403).json({ error: "This institute account has been deactivated." });
    }

    // ── 3. Verify password ───────────────────────────────────────────
    const passwordMatch = await bcrypt.compare(password, institute.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    // ── 4. Issue JWT ─────────────────────────────────────────────────
    const token = jwt.sign(
      {
        institute_id:  institute.institute_id,
        email:         institute.email,
        college_name:  institute.college_name,
        aishe_code:    institute.aishe_code,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    // ── 5. Save session to instituteDb ───────────────────────────────
    const sessionRef = instituteDb.collection(COLLECTIONS.INSTITUTE_SESSIONS).doc();
    await sessionRef.set({
      session_id:    sessionRef.id,
      institute_id:  institute.institute_id,
      token,
      created_at:    FieldValue.serverTimestamp(),
      expires_at:    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      is_valid:      true,
    });

    // ── 6. Respond (never send password_hash) ────────────────────────
    const { password_hash: _, ...safeInstitute } = institute;

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      token,
      institute: safeInstitute,
    });

  } catch (error) {
    console.error("INSTITUTE LOGIN ERROR:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// ── GET /auth/institute-me ────────────────────────────────────────────
router.get("/institute-me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided." });
    }

    const token = authHeader.split(" ")[1];

    // ── 1. Verify JWT ────────────────────────────────────────────────
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: "Invalid or expired token." });
    }

    // ── 2. Check session is still valid ─────────────────────────────
    const sessionSnap = await instituteDb
      .collection(COLLECTIONS.INSTITUTE_SESSIONS)
      .where("token", "==", token)
      .where("is_valid", "==", true)
      .limit(1)
      .get();

    if (sessionSnap.empty) {
      return res.status(401).json({ error: "Session expired or logged out." });
    }

    // ── 3. Fetch fresh institute data ────────────────────────────────
    const instituteSnap = await instituteDb
      .collection(COLLECTIONS.INSTITUTES)
      .where("institute_id", "==", decoded.institute_id)
      .limit(1)
      .get();

    if (instituteSnap.empty) {
      return res.status(404).json({ error: "Institute not found." });
    }

    const institute = instituteSnap.docs[0].data();
    const { password_hash: _, ...safeInstitute } = institute;

    return res.status(200).json({
      success: true,
      institute: safeInstitute,
    });

  } catch (error) {
    console.error("INSTITUTE ME ERROR:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// ── POST /auth/institute-logout ───────────────────────────────────────
router.post("/institute-logout", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided." });
    }

    const token = authHeader.split(" ")[1];

    // Invalidate session in DB
    const sessionSnap = await instituteDb
      .collection(COLLECTIONS.INSTITUTE_SESSIONS)
      .where("token", "==", token)
      .where("is_valid", "==", true)
      .limit(1)
      .get();

    if (!sessionSnap.empty) {
      await sessionSnap.docs[0].ref.update({ is_valid: false });
    }

    return res.status(200).json({ success: true, message: "Logged out successfully." });

  } catch (error) {
    console.error("INSTITUTE LOGOUT ERROR:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// ── GET /auth/find-with-aishe?code=C-10007 ───────────────────────────
router.get("/find-with-aishe", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code || !code.trim()) {
      return res.status(400).json({ error: "AISHE code is required. Use ?code=C-10007" });
    }

    // ── 1. Search in workingDb → colleges/ ──────────────────────────
    const snap = await workingDb
      .collection(COLLECTIONS.COLLEGES)
      .where("aishe_code", "==", code.trim())
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: "Institute not found in AISHE database." });
    }

    const data = snap.docs[0].data();

    // ── 2. Check if already registered in instituteDb ────────────────
    const alreadyRegistered = await instituteDb
      .collection(COLLECTIONS.INSTITUTES)
      .where("aishe_code", "==", code.trim())
      .limit(1)
      .get();

    // ── 3. Return college data in exact shape frontend expects ────────
    return res.status(200).json({
      success:            true,
      already_registered: !alreadyRegistered.empty,
      aishe_code:         data.aishe_code         || null,
      college_name:       data.college_name        || null,
      district:           data.district            || null,
      search_name:        data.search_name         || null,
      state:              data.state               || null,
      type:               data.type                || null,
      university_id:      data.university_id       || null,
      university_name:    data.university_name     || null,
    });

  } catch (error) {
    console.error("FIND WITH AISHE ERROR:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

module.exports = router;