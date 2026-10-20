require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

// ── refuse to start without a real signing secret ─────────────────────
const secret = process.env.JWT_SECRET || "";
if (secret.length < 16 || /^(secret|changeme|password|jwt_secret)$/i.test(secret)) {
  console.error("JWT_SECRET is missing or too short. Set a long random value in .env. Refusing to start.");
  process.exit(1);
}
if (secret.length < 32) console.warn("JWT_SECRET is shorter than 32 characters - please replace it with a longer random one.");

const { securityHeaders, rateLimit, IS_PROD } = require("./middleware/security");

const app = express();

// Behind Caddy/nginx/ALB the client IP is in X-Forwarded-For. Rate limits need it.
// Set TRUST_PROXY=0 if the app is exposed directly.
app.set("trust proxy", process.env.TRUST_PROXY === "0" ? false : Number(process.env.TRUST_PROXY || 1));
app.disable("x-powered-by");
app.use(securityHeaders);

// CORS: set INSTITUTE_CORS_ORIGINS="https://portal.example.com,https://www.example.com".
// Unset = open (as before) with a warning, so nothing breaks on upgrade.
const origins = (process.env.INSTITUTE_CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (origins.length === 0) console.warn("INSTITUTE_CORS_ORIGINS is not set - CORS is open to every website.");
app.use(cors({
  origin: origins.length ? origins : true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  maxAge: 600,
}));

app.use(rateLimit({ windowMs: 60_000, max: 300, name: "global" }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

const routesDir = path.join(__dirname, "routes");
if (!fs.existsSync(routesDir)) {
  console.warn("/routes directory not found - no routes loaded.");
} else {
  const routeFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith(".routes.js"));
  if (routeFiles.length === 0) console.warn("No *.routes.js files found in /routes.");

  routeFiles.forEach((file) => {
    const imported = require(path.join(routesDir, file));
    const router = imported.router || imported;
    const mountPath = imported.prefix || "/" + file.replace(".routes.js", "").replace(/_/g, "-");
    app.use(mountPath, router);
    console.log(`Mounted: ${mountPath}  <-  ${file}`);
  });
}

app.use((req, res) => res.status(404).json({ error: "Not found." }));

// body-parser / CORS / anything else that throws
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request too large." });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  console.error("Unhandled error:", err);
  res.status(500).json({ error: IS_PROD ? "Something went wrong." : String((err && err.message) || err) });
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`\nInstitute backend running on port ${PORT}`);

  // Institutes that turned auto-approve on before the registration copy existed:
  // copy their settings across once (safe to repeat).
  setTimeout(async () => {
    try {
      const { instituteDb, workingDb, COLLECTIONS } = require("./config/firebase");
      const n = await require("./utils/autoApprove").syncAllMirrors({ instituteDb, workingDb, COLLECTIONS });
      if (n) console.log(`[auto-approve] synced settings for ${n} institute(s)`);
    } catch (e) {
      console.error("[auto-approve] start-up sync failed:", e.message);
    }
  }, 3000);
});

module.exports = app; // for tests