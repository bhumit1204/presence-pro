require("dotenv").config(); // ← MUST be first, before any other require

const express = require("express");
const cors = require("cors");
const { db } = require("./config/firebase");
const { authenticate } = require("./middleware/auth");
const collegeRoutes = require("./routes/college.routes");
const authRoutes    = require("./routes/auth.routes");
const otpRoutes     = require("./routes/otp.routes");

const app  = express();
const PORT = process.env.PORT || 5000;

// Vercel -> nginx -> node (2 proxies). Use 1 if only nginx is in front, 0 if node is exposed directly.
// Needed so rate limiting sees the real client IP instead of the proxy's.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 2));
app.disable("x-powered-by");

// optional hardening / gzip — only active if you ran `npm i helmet compression`
try { app.use(require("helmet")()); } catch (_) { /* not installed */ }
try { app.use(require("compression")()); } catch (_) { /* not installed */ }

app.use(cors());
app.use(express.json({ limit: "1mb" })); // file uploads use multer, so JSON never needs more
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Verifies the Firebase ID token once per request (AUTH_MODE=off|soft|enforce). MUST be before the /api routers.
app.use("/api", authenticate);

app.use("/auth",            authRoutes);
app.use("/auth",            otpRoutes);   // /auth/otp/send, /auth/otp/verify, /auth/password/reset
app.use("/api/colleges",    collegeRoutes);
app.use("/api/lectures",    require("./routes/lecture.routes"));
app.use("/api/quizzes",     require("./routes/quiz.routes"));
app.use("/api/assignments", require("./routes/assignment.routes"));
app.use("/api/profile",     require("./routes/profile.routes"));
app.use("/api/reports",     require("./routes/reports.routes"));
app.use("/api/broadcasts",  require("./routes/broadcast.routes"));
app.use("/api/od",          require("./routes/od.routes"));
app.use("/api/notify-prefs", require("./routes/notifyprefs.routes"));
app.use("/api/web/teacher", require("./routes/web/teacher.routes"));
app.use("/api/web/head",    require("./routes/web/head.routes"));
app.use("/api/web/student", require("./routes/web/student.routes"));

app.get("/", (req, res) => res.send("PresencePro Backend Running"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ─── Legacy /users routes ────────────────────────────────────────────────────
// These were completely unauthenticated: anyone could list every user, create users,
// or PATCH any user (e.g. set role / approval_status). The mobile app does not use them.
// They are OFF by default. If your web app still needs them, set ENABLE_LEGACY_USERS=1:
// they then require a valid Firebase token, are limited to the caller's own record and
// can no longer change role / approval / active flags.
if (process.env.ENABLE_LEGACY_USERS === "1") {
  const { verifyToken } = require("./middleware/auth");
  const requireUser = async (req, res, next) => {
    const h = req.headers.authorization || "";
    const token = /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "").trim() : null;
    const decoded = token ? await verifyToken(token).catch(() => null) : null;
    if (!decoded) return res.status(401).json({ error: "Authentication required" });
    req.auth = { uid: decoded.uid };
    next();
  };
  const PROTECTED = ["role", "approval_status", "is_active", "is_profile_complete", "uid", "email"];

  app.get("/users/:id", requireUser, async (req, res) => {
    try {
      if (req.params.id !== req.auth.uid) return res.status(403).json({ error: "Access denied" });
      const doc = await db.collection("users").doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: "User not found" });
      res.json({ success: true, user: { id: doc.id, ...doc.data() } });
    } catch (error) {
      console.error("GET /users/:id", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/users/:id", requireUser, async (req, res) => {
    try {
      if (req.params.id !== req.auth.uid) return res.status(403).json({ error: "Access denied" });
      const update = { ...(req.body || {}) };
      PROTECTED.forEach((k) => delete update[k]);
      if (!Object.keys(update).length) return res.status(400).json({ error: "Nothing to update" });
      await db.collection("users").doc(req.params.id).update(update);
      res.json({ success: true, message: "User updated successfully" });
    } catch (error) {
      console.error("PATCH /users/:id", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
} else {
  app.use("/users", (req, res) => res.status(404).json({ error: "Not found" }));
}

// ─── error handler: bad JSON / too-large body / anything unexpected ──────────
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === "entity.too.large") return res.status(413).json({ success: false, error: "Request too large" });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ success: false, error: "Invalid JSON" });
  console.error("Unhandled error:", err && err.message);
  res.status(500).json({ success: false, error: "Internal server error" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

// keep-alive longer than nginx's (default 75s) so nginx never reuses a socket node just closed (502s under load)
server.keepAliveTimeout = 80_000;
server.headersTimeout   = 85_000;

// lecture notifications: "starting now" + low-attendance reminders (one light check a minute; LECTURE_ALERTS=off disables)
if (process.env.NODE_ENV !== "test") require("./services/lectureAlerts").start();

// ─── graceful shutdown: write batched counters / read receipts / present_students before exit ───
const assignments = require("./routes/assignment.routes");
const lectures    = require("./routes/lecture.routes");
const broadcasts  = require("./routes/broadcast.routes");
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await Promise.race([
      Promise.allSettled([assignments.flushPending(), lectures.flushPending(), broadcasts.flushPending()]),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    process.exit(0);
  });
}

module.exports = app;