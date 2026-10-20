/**
 * middleware/auth.js
 *
 * Token verification + identity guards for the PresencePro API.
 *
 * WHY: the original routes trust whatever `uid`, `teacher_id`, `student_uid`
 * the client sends, so anybody who can reach the server can read or change any
 * user's data. The fix is to verify the Firebase ID token the apps already have
 * and make sure the identity in the request matches the identity in the token.
 *
 * ROLLOUT (no behaviour change until you decide):
 *
 *   AUTH_MODE=off      – middleware does nothing at all.
 *   AUTH_MODE=soft     – DEFAULT. If a valid token is sent it is verified and
 *                        req.auth is filled in; identity mismatches are only
 *                        LOGGED ("would deny"). Requests without a token still
 *                        work exactly like before. Safe for old app versions.
 *   AUTH_MODE=enforce  – missing/invalid token -> 401, identity mismatch -> 403.
 *
 * Step 1: deploy with soft, ship app/web versions that send
 *         `Authorization: Bearer <idToken>` on every API call.
 * Step 2: watch the logs for "[auth:soft] would deny"; when it is quiet,
 *         set AUTH_MODE=enforce.
 *
 * Mount ONCE, before the routers:
 *     app.use("/api", authenticate);
 *
 * The decoded user is placed on `req.auth` (NOT `req.user`, because some route
 * files already look at `req.user`).
 */

const { admin, db } = require("../config/firebase");
const { TTLCache } = require("../utils/cache");

const TEACHER_ROLES = new Set(["teacher", "hod", "head_teacher", "admin"]);

const tokenCache = new TTLCache({ max: 20_000, ttlMs: 120_000 });
const teacherIdCache = new TTLCache({ max: 20_000, ttlMs: 300_000 });
const roleCache = new TTLCache({ max: 20_000, ttlMs: 300_000 });

const mode = () => {
  const m = String(process.env.AUTH_MODE || "soft").toLowerCase();
  return m === "off" || m === "enforce" ? m : "soft";
};

// Endpoints that must stay reachable without a user token.
const PUBLIC_PATHS = [
  /^\/api\/auth\/(register|login)\/?$/, // no token exists yet
  /^\/api\/colleges\//, // college picker on the registration screen
  /^\/api\/lectures\/attendance\/iot\//, // ESP32 devices (they use their own device key)
  /^\/health\/?$/,
];

function isPublic(req) {
  const url = (req.originalUrl || req.url || "").split("?")[0];
  return PUBLIC_PATHS.some((re) => re.test(url));
}

// ─── logging that cannot flood the disk ───────────────────────────────────────
const warned = new Map();
function softWarn(key, msg) {
  const now = Date.now();
  if ((warned.get(key) || 0) > now - 30_000) return;
  warned.set(key, now);
  if (warned.size > 2000) warned.clear();
  console.warn(`[auth:soft] would deny: ${msg}`);
}

// ─── token verification (cached; signature check is local after first key fetch)
async function verifyCached(token) {
  const hit = tokenCache.get(token);
  if (hit) return { decoded: hit };
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const ttl = Math.min(120_000, Math.max(1_000, decoded.exp * 1000 - Date.now()));
    tokenCache.set(token, decoded, ttl);
    return { decoded };
  } catch (e) {
    return { error: e.code || "auth/invalid" };
  }
}

/** Verify a raw ID token (uses the same cache). Returns decoded token or null. */
async function verifyToken(token) {
  const { decoded } = await verifyCached(token);
  return decoded || null;
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "").trim() : null;
}

async function authenticate(req, res, next) {
  const m = mode();
  if (m === "off") return next();

  const token = bearer(req);
  if (token) {
    const { decoded, error } = await verifyCached(token);
    if (decoded) {
      req.auth = { uid: decoded.uid, email: decoded.email || null };
      return next();
    }
    if (m === "enforce" && !isPublic(req)) {
      return res.status(401).json({ success: false, error: "Invalid or expired token", code: error });
    }
    return next();
  }

  if (m === "enforce" && !isPublic(req)) {
    return res.status(401).json({ success: false, error: "Authentication required", code: "auth/missing-token" });
  }
  return next();
}

// ─── identity lookups (cached) ────────────────────────────────────────────────

/** Firestore teacher doc id for an auth uid, or null. */
async function teacherIdForUid(uid) {
  if (!uid) return null;
  const hit = teacherIdCache.get(uid);
  if (hit !== undefined) return hit || null;
  const snap = await db.collection("teachers").where("user_id", "==", uid).limit(1).get();
  const id = snap.empty ? null : snap.docs[0].id;
  teacherIdCache.set(uid, id || "", id ? 300_000 : 30_000);
  return id;
}

/** users/{uid}.role, or null. */
async function roleForUid(uid) {
  if (!uid) return null;
  const hit = roleCache.get(uid);
  if (hit !== undefined) return hit || null;
  const doc = await db.collection("users").doc(uid).get();
  const role = doc.exists ? doc.data().role || null : null;
  roleCache.set(uid, role || "", role ? 300_000 : 30_000);
  return role;
}

async function isTeacherUid(uid) {
  const role = await roleForUid(uid);
  if (role && TEACHER_ROLES.has(role)) return true;
  return !!(await teacherIdForUid(uid));
}

function invalidateUser(uid) {
  teacherIdCache.del(uid);
  roleCache.del(uid);
}

// ─── guards ───────────────────────────────────────────────────────────────────

/**
 * Build a guard. `check(req)` returns true when the authenticated user may
 * make this request. Claims that are missing are left to the route's own
 * validation (it returns the same 400 as before).
 */
function makeGuard(label, check) {
  return async function guardMiddleware(req, res, next) {
    const m = mode();
    if (m === "off") return next();

    if (!req.auth) {
      if (m === "enforce") {
        return res.status(401).json({ success: false, error: "Authentication required", code: "auth/missing-token" });
      }
      return next(); // old client without a token — unchanged behaviour
    }

    let ok = false;
    try {
      ok = await check(req);
    } catch (e) {
      console.error(`[auth] guard ${label} failed:`, e.message);
      ok = m !== "enforce"; // fail open while rolling out, closed when enforcing
    }
    if (ok) return next();

    if (m === "enforce") {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    softWarn(`${label}:${req.auth.uid}:${req.baseUrl}${req.path}`, `${label} uid=${req.auth.uid} ${req.method} ${req.originalUrl}`);
    return next();
  };
}

/**
 * Resource-level check inside a handler (e.g. "does this teacher own this subject?").
 *   if (!(await allow(req, res, ok, "label"))) return;
 * - ok === true            -> continue
 * - ok === false, enforce  -> sends 403 and returns false
 * - ok === false, soft/off -> logs "would deny" (soft) and continues (original behaviour)
 */
function allow(req, res, ok, label) {
  if (ok) return true;
  const m = mode();
  if (m === "enforce") {
    res.status(403).json({ success: false, error: "Access denied" });
    return false;
  }
  if (m === "soft") softWarn(`${label}:${req.auth?.uid || "anon"}:${req.baseUrl}${req.path}`, `${label} ${req.method} ${req.originalUrl}`);
  return true;
}

// claim getters
const fromAny = (name) => (req) => req.params?.[name] ?? req.body?.[name] ?? req.query?.[name];
const fromQuery = (name) => (req) => req.query?.[name];
const fromBody = (name) => (req) => req.body?.[name];
const fromParams = (name) => (req) => req.params?.[name];

const guard = {
  /** Anyone logged in. */
  authed: makeGuard("authed", async () => true),

  /** claim must be MY teacher doc id (or my auth uid). */
  teacher(getter = fromAny("teacher_id")) {
    return makeGuard("teacher", async (req) => {
      const claimed = getter(req);
      if (claimed === undefined || claimed === null || claimed === "") return true;
      if (String(claimed) === req.auth.uid) return true;
      const tid = await teacherIdForUid(req.auth.uid);
      return !!tid && tid === String(claimed);
    });
  },

  /** claim must be MY auth uid (web teacher routes pass ?uid=). */
  self(getter = fromAny("uid"), label = "self") {
    return makeGuard(label, async (req) => {
      const claimed = getter(req);
      if (claimed === undefined || claimed === null || claimed === "") return true;
      return String(claimed) === req.auth.uid;
    });
  },

  /** claim is a student uid: must be me. */
  student(getter = fromAny("student_uid")) {
    return makeGuard("student", async (req) => {
      const claimed = getter(req);
      if (claimed === undefined || claimed === null || claimed === "") return true;
      return String(claimed) === req.auth.uid;
    });
  },

  /** me, OR any teacher (e.g. a teacher looking up a student's profile). */
  selfOrTeacher(getter = fromAny("uid")) {
    return makeGuard("selfOrTeacher", async (req) => {
      const claimed = getter(req);
      if (claimed === undefined || claimed === null || claimed === "") return true;
      if (String(claimed) === req.auth.uid) return true;
      return isTeacherUid(req.auth.uid);
    });
  },

  /** must be a teacher / HOD. */
  teacherOnly: makeGuard("teacherOnly", async (req) => isTeacherUid(req.auth.uid)),
};

module.exports = {
  authenticate,
  verifyToken,
  guard,
  allow,
  mode,
  teacherIdForUid,
  roleForUid,
  isTeacherUid,
  invalidateUser,
  fromAny,
  fromQuery,
  fromBody,
  fromParams,
  PUBLIC_PATHS,
  isPublic,
};
