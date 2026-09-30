require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const routesDir = path.join(__dirname, "routes");

if (!fs.existsSync(routesDir)) {
  console.warn("/routes directory not found — no routes loaded.");
} else {
  const routeFiles = fs
    .readdirSync(routesDir)
    .filter((f) => f.endsWith(".routes.js"));

  if (routeFiles.length === 0) {
    console.warn("No *.routes.js files found in /routes.");
  }

  routeFiles.forEach((file) => {
    const fullPath = path.join(routesDir, file);
    const imported = require(fullPath);

    const router = imported.router || imported;
    const customPrefix = imported.prefix || null;

    const derivedPrefix =
      "/" + file.replace(".routes.js", "").replace(/_/g, "-");

    const mountPath = customPrefix || derivedPrefix;

    app.use(mountPath, router);
    console.log(`Mounted: ${mountPath}  ←  ${file}`);
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`\nInstitute backend running on port ${PORT}`);
});