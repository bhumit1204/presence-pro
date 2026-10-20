/**
 * routes/otp.routes.js — e-mail OTP for registration and forgot-password.   (mounted at /auth)
 *
 *   POST /auth/otp/send       { email, purpose: "register" | "reset" }
 *   POST /auth/otp/verify     { email, purpose, otp }            -> { otp_token }
 *   POST /auth/password/reset { email, otp_token, new_password }
 *
 * Design
 *   - 6-digit code from crypto.randomInt, valid 10 min, stored only as an HMAC (never plain).
 *   - 5 wrong guesses burn the code. 60 s between sends, 5 sends per hour per address.
 *   - A correct code is swapped for a single-use `otp_token` (valid 15 min) that register / reset require.
 *   - "reset" never reveals whether an account exists (same answer either way).
 *   - After a reset all refresh tokens are revoked, so every other device is signed out.
 *
 * Firestore collection `otp_codes` is written only by this server (Admin SDK); keep it closed in the rules.
 */
const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const { admin, db } = require("../config/firebase");
const { rateLimit } = require("../utils/limiter");
const { sendOtpMail, sendPasswordChangedMail } = require("../services/mailer");

const OTP_TTL_MS = 10 * 60_000;
const TOKEN_TTL_MS = 15 * 60_000;
const RESEND_MS = 60_000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const PURPOSES = ["register", "reset"];

const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// HMAC key: set OTP_SECRET in .env (any long random string). The fallback is only for local development.
const SECRET = process.env.OTP_SECRET || "dev-only-change-me";
if (!process.env.OTP_SECRET && process.env.NODE_ENV === "production") {
  console.error("OTP_SECRET is not set - OTP hashes are weak. Set it in .env");
}

const sendLimiter = rateLimit({ windowMs: 3_600_000, max: 30, name: "otp-send", message: "Too many requests. Try again later." });
const verifyLimiter = rateLimit({ windowMs: 600_000, max: 60, name: "otp-verify", message: "Too many attempts. Try again later." });
const resetLimiter = rateLimit({ windowMs: 600_000, max: 30, name: "pw-reset", message: "Too many attempts. Try again later." });

const normEmail = (e) => String(e || "").trim().toLowerCase();
const docId = (purpose, email) => crypto.createHash("sha256").update(`${purpose}|${email}`).digest("hex");
const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("hex");
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const ref = (purpose, email) => db.collection("otp_codes").doc(docId(purpose, email));

async function userExists(email) {
  try {
    await admin.auth().getUserByEmail(email);
    return true;
  } catch (e) {
    if (e.code === "auth/user-not-found") return false;
    throw e;
  }
}

/**
 * Used by register / reset. Returns true when `token` is a valid, unexpired, verified token for this
 * e-mail + purpose. Does NOT delete it: call consumeOtpToken after the action succeeded.
 */
async function checkOtpToken(email, purpose, token) {
  if (typeof token !== "string" || token.length < 32) return false;
  const snap = await ref(purpose, normEmail(email)).get();
  if (!snap.exists) return false;
  const d = snap.data();
  if (!d.verified || !d.token_hash || Date.now() > d.token_expires) return false;
  return safeEq(d.token_hash, hmac(token));
}
const consumeOtpToken = (email, purpose) => ref(purpose, normEmail(email)).delete().catch(() => {});

// ─── send ────────────────────────────────────────────────────────────────────
router.post("/otp/send", sendLimiter, async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const purpose = req.body?.purpose;
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address" });
    if (!PURPOSES.includes(purpose)) return res.status(400).json({ error: "Invalid purpose" });

    const exists = await userExists(email);
    if (purpose === "register" && exists) {
      return res.status(409).json({ error: "An account with this email already exists. Please log in." });
    }

    const okBody = { success: true, resend_in: RESEND_MS / 1000, expires_in: OTP_TTL_MS / 1000 };
    // reset for an unknown address: answer exactly like success, send nothing
    if (purpose === "reset" && !exists) return res.json(okBody);

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const r = ref(purpose, email);
    const now = Date.now();

    const verdict = await db.runTransaction(async (t) => {
      const s = await t.get(r);
      const old = s.exists ? s.data() : {};
      if (old.sent_at && now - old.sent_at < RESEND_MS) {
        return { wait: Math.ceil((RESEND_MS - (now - old.sent_at)) / 1000) };
      }
      let windowStart = old.window_start || now;
      let count = old.sent_count || 0;
      if (now - windowStart > 3_600_000) {
        windowStart = now;
        count = 0;
      }
      if (count >= MAX_SENDS_PER_HOUR) return { blocked: true };
      t.set(r, {
        email,
        purpose,
        hash: hmac(`${purpose}|${email}|${code}`),
        expires_at: now + OTP_TTL_MS,
        attempts: 0,
        verified: false,
        sent_at: now,
        window_start: windowStart,
        sent_count: count + 1,
      });
      return { ok: true };
    });

    if (verdict.wait) {
      res.set("Retry-After", String(verdict.wait));
      return res.status(429).json({ error: `Please wait ${verdict.wait}s before requesting another code.`, resend_in: verdict.wait });
    }
    if (verdict.blocked) return res.status(429).json({ error: "Too many codes requested. Try again in an hour." });

    try {
      await sendOtpMail(email, code, purpose, OTP_TTL_MS / 60_000);
    } catch (e) {
      console.error("OTP mail failed:", e.message);
      await r.delete().catch(() => {}); // let the user retry immediately
      return res.status(503).json({ error: "Could not send the email right now. Please try again shortly." });
    }
    return res.json(okBody);
  } catch (e) {
    console.error("OTP SEND ERROR:", e.message);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── verify ──────────────────────────────────────────────────────────────────
router.post("/otp/verify", verifyLimiter, async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const purpose = req.body?.purpose;
    const otp = String(req.body?.otp || "").trim();
    if (!EMAIL_RE.test(email) || !PURPOSES.includes(purpose) || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: "Enter the 6-digit code" });
    }

    const r = ref(purpose, email);
    const token = crypto.randomBytes(32).toString("hex");

    const result = await db.runTransaction(async (t) => {
      const s = await t.get(r);
      if (!s.exists || !s.data().hash) return { code: 400, error: "Code expired or not requested. Request a new one." };
      const d = s.data();
      if (Date.now() > d.expires_at) {
        t.delete(r);
        return { code: 400, error: "Code expired. Request a new one." };
      }
      if (d.attempts >= MAX_ATTEMPTS) {
        t.delete(r);
        return { code: 429, error: "Too many wrong attempts. Request a new code." };
      }
      if (!safeEq(d.hash, hmac(`${purpose}|${email}|${otp}`))) {
        t.update(r, { attempts: d.attempts + 1 });
        const left = MAX_ATTEMPTS - d.attempts - 1;
        return { code: 400, error: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Incorrect code. Request a new one." };
      }
      t.update(r, {
        hash: null,
        verified: true,
        token_hash: hmac(token),
        token_expires: Date.now() + TOKEN_TTL_MS,
      });
      return { ok: true };
    });

    if (!result.ok) return res.status(result.code).json({ error: result.error });
    return res.json({ success: true, otp_token: token, expires_in: TOKEN_TTL_MS / 1000 });
  } catch (e) {
    console.error("OTP VERIFY ERROR:", e.message);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── reset password ──────────────────────────────────────────────────────────
router.post("/password/reset", resetLimiter, async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const { otp_token, new_password } = req.body || {};
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
    if (typeof new_password !== "string" || !PASSWORD_RE.test(new_password)) {
      return res.status(400).json({
        error: "Password must be 8 to 64 characters with uppercase, lowercase, number and one of @$!%*?&",
      });
    }
    if (!(await checkOtpToken(email, "reset", otp_token))) {
      return res.status(403).json({ error: "Verification expired. Please request a new code." });
    }

    let user;
    try {
      user = await admin.auth().getUserByEmail(email);
    } catch {
      return res.status(403).json({ error: "Verification expired. Please request a new code." });
    }
    await admin.auth().updateUser(user.uid, { password: new_password });
    await admin.auth().revokeRefreshTokens(user.uid); // signs every other device out
    await consumeOtpToken(email, "reset");
    sendPasswordChangedMail(email).catch((e) => console.error("Notice mail failed:", e.message));

    return res.json({ success: true, message: "Password updated. You can log in now." });
  } catch (e) {
    console.error("PASSWORD RESET ERROR:", e.message);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

module.exports = router;
module.exports.checkOtpToken = checkOtpToken;
module.exports.consumeOtpToken = consumeOtpToken;