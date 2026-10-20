"use strict";
/**
 * Security helpers for the institute backend (no extra npm packages needed).
 *
 *   securityHeaders      basic hardening headers on every response
 *   rateLimit(opts)      small in-memory limiter (per process)
 *   requireAuth          JWT + server-side session check (replaces verifyToken)
 *   createSession / revokeSession / revokeAllSessions
 *   fail(res, tag, err)  logs the real error, sends a generic 500
 *
 * A token is only good while its session document is valid, so logging out or
 * changing the password really signs the portal out. Sessions are cached for
 * 30 s, so a revoke/deactivate is felt within that time.
 */
const jwt = require("jsonwebtoken");
const { FieldValue } = require("firebase-admin/firestore");
const { instituteDb, COLLECTIONS } = require("../config/firebase");

const SESSION_CACHE_MS = 30_000;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1d";
const IS_PROD = process.env.NODE_ENV === "production";

// ── headers ───────────────────────────────────────────────────────────
function securityHeaders(req, res, next) {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
}

// ── rate limiter ──────────────────────────────────────────────────────
function rateLimit({ windowMs = 60_000, max = 60, name = "rl", key } = {}) {
  const hits = new Map(); // key -> { n, reset }
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.max(windowMs, 30_000));
  if (t.unref) t.unref();

  return function limiter(req, res, next) {
    const k = `${name}:${key ? key(req) : req.ip}`;
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    h.n++;
    if (h.n > max) {
      res.setHeader("Retry-After", Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: "Too many requests. Please try again shortly." });
    }
    next();
  };
}

// ── errors ────────────────────────────────────────────────────────────
function fail(res, tag, err) {
  console.error(`[${tag}]`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong. Please try again." });
}

/** async route wrapper: any throw becomes a logged, generic 500 */
const wrap = (tag, fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) { fail(res, tag, e); }
};

// ── sessions ──────────────────────────────────────────────────────────
const cache = new Map(); // sid -> { until, ctx }

function dropCached(sid) { cache.delete(sid); }
function dropCachedFor(institute_id) {
  for (const [sid, v] of cache) if (v.ctx.institute_id === institute_id) cache.delete(sid);
}

function signToken(institute, sid) {
  return jwt.sign(
    {
      institute_id: institute.institute_id,
      aishe_code: institute.aishe_code || null,
      email: institute.email,
      college_name: institute.college_name,
      sid,
    },
    process.env.JWT_SECRET,
    { algorithm: "HS256", expiresIn: JWT_EXPIRES_IN },
  );
}

async function createSession(institute, req) {
  const ref = instituteDb.collection(COLLECTIONS.INSTITUTE_SESSIONS).doc();
  const token = signToken(institute, ref.id);
  const exp = jwt.decode(token).exp * 1000;
  await ref.set({
    session_id: ref.id,
    institute_id: institute.institute_id,
    created_at: FieldValue.serverTimestamp(),
    expires_at: new Date(exp).toISOString(),
    is_valid: true,
    ip: req.ip || null,
    user_agent: String(req.headers["user-agent"] || "").slice(0, 200),
  });
  return token;
}

async function revokeSession(sid) {
  if (!sid) return;
  dropCached(sid);
  try {
    await instituteDb.collection(COLLECTIONS.INSTITUTE_SESSIONS).doc(String(sid)).update({ is_valid: false });
  } catch { /* already gone */ }
}

async function revokeAllSessions(institute_id) {
  dropCachedFor(institute_id);
  const snap = await instituteDb.collection(COLLECTIONS.INSTITUTE_SESSIONS)
    .where("institute_id", "==", institute_id).where("is_valid", "==", true).get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = instituteDb.batch();
    snap.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, { is_valid: false }));
    await batch.commit();
  }
}

function bearer(req) {
  const h = req.headers.authorization;
  return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/**
 * Sets req.institute = { institute_id, aishe_code, email, college_name, sid }.
 * aishe_code comes from the database record, not from the token.
 */
async function requireAuth(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "No token provided." });

    let claims;
    try {
      claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
      return res.status(401).json({ error: "Invalid or expired token." });
    }
    const sid = claims && claims.sid;
    if (!sid || typeof sid !== "string" || !claims.institute_id) {
      return res.status(401).json({ error: "Session expired. Please log in again." });
    }

    const hit = cache.get(sid);
    if (hit && hit.until > Date.now()) {
      req.institute = hit.ctx;
      return next();
    }

    const [sess, inst] = await Promise.all([
      instituteDb.collection(COLLECTIONS.INSTITUTE_SESSIONS).doc(sid).get(),
      instituteDb.collection(COLLECTIONS.INSTITUTES).doc(String(claims.institute_id)).get(),
    ]);
    const s = sess.exists ? sess.data() : null;
    if (!s || s.is_valid !== true || s.institute_id !== claims.institute_id) {
      return res.status(401).json({ error: "Session expired or logged out." });
    }
    if (!inst.exists || inst.data().is_active === false) {
      return res.status(403).json({ error: "This institute account has been deactivated." });
    }
    const i = inst.data();
    const ctx = {
      institute_id: claims.institute_id,
      aishe_code: i.aishe_code || null,
      email: i.email,
      college_name: i.college_name,
      sid,
    };
    cache.set(sid, { until: Date.now() + SESSION_CACHE_MS, ctx });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    req.institute = ctx;
    return next();
  } catch (e) {
    return fail(res, "AUTH", e);
  }
}

/** like requireAuth but also insists the institute has an AISHE code (everything under /institute needs one) */
function requireAishe(req, res, next) {
  if (!req.institute || !req.institute.aishe_code) {
    return res.status(400).json({ error: "No AISHE code on this account." });
  }
  next();
}

module.exports = {
  IS_PROD, securityHeaders, rateLimit, fail, wrap,
  createSession, revokeSession, revokeAllSessions, requireAuth, requireAishe, bearer,
};