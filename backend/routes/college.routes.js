const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");
const { TTLCache } = require("../utils/cache");
const { rateLimit } = require("../utils/limiter");

// College / course data almost never changes, and every new registration hits
// these two endpoints. Cache per AISHE code and let browsers / nginx / CDN
// cache the answer too.
const cache = new TTLCache({ max: 2000, ttlMs: 300_000 });
const FOUND_TTL = 300_000;
const MISSING_TTL = 30_000;

// Public endpoints -> keep a generous limit (a whole campus can share one IP).
router.use(rateLimit({ windowMs: 60_000, max: 600, name: "college" }));

async function cachedLookup(key, loader) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const v = await cache.memo(key, FOUND_TTL, loader);
  // "not found" is cached only briefly so a newly added college shows up quickly
  if (v && !v.found) cache.set(key, v, MISSING_TTL);
  return v;
}

// 🔍 Verify college by AISHE code
router.get("/verify/:aisheCode", async (req, res) => {
  try {
    const aisheCode = req.params.aisheCode?.trim().toUpperCase();

    if (!aisheCode) {
      return res.status(400).json({
        success: false,
        error: "AISHE code is required",
      });
    }

    const result = await cachedLookup(`verify:${aisheCode}`, async () => {
      const snapshot = await db
        .collection("colleges")
        .where("aishe_code", "==", aisheCode)
        .limit(1)
        .get();
      if (snapshot.empty) return { found: false };
      const doc = snapshot.docs[0];
      return { found: true, college_id: doc.id, college: doc.data() };
    });

    if (!result.found) {
      return res.status(404).json({
        success: false,
        error: "College not found",
      });
    }

    res.set("Cache-Control", "public, max-age=60");
    return res.status(200).json({
      success: true,
      college_id: result.college_id,
      college: result.college,
    });
  } catch (error) {
    console.error("AISHE verify error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// 📚 Fetch courses for college
router.get("/:aisheCode/courses", async (req, res) => {
  try {
    const aisheCode = req.params.aisheCode?.trim().toUpperCase();

    if (!aisheCode) {
      return res.status(400).json({
        success: false,
        error: "AISHE code is required",
      });
    }

    const result = await cachedLookup(`courses:${aisheCode}`, async () => {
      const snapshot = await db
        .collection("courses")
        .where("aishe_code", "==", aisheCode)
        .get();
      if (snapshot.empty) return { found: false };
      return {
        found: true,
        courses: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      };
    });

    if (!result.found) {
      return res.status(404).json({
        success: false,
        error: "No courses found for this college",
      });
    }

    res.set("Cache-Control", "public, max-age=60");
    return res.status(200).json({
      success: true,
      count: result.courses.length,
      courses: result.courses,
    });
  } catch (error) {
    console.error("Fetch courses error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// 🧭 Divisions (sections) the head created for one course + semester. Used by the student sign-up form.
router.get("/:aisheCode/courses/:courseId/divisions", async (req, res) => {
  try {
    const aisheCode = req.params.aisheCode?.trim().toUpperCase();
    const courseId = String(req.params.courseId || "");
    const sem = parseInt(String(req.query.semester || "").replace(/[^0-9]/g, ""), 10);
    if (!aisheCode || !courseId || courseId.includes("/") || !Number.isInteger(sem) || sem < 1) {
      return res.status(400).json({ success: false, error: "AISHE code, course and semester are required" });
    }
    const result = await cache.memo(`divisions:${aisheCode}|${courseId}|${sem}`, 30_000, async () => {
      const snap = await db.collection("divisions").where("course_id", "==", courseId).get();
      return snap.docs
        .map((d) => ({ division_id: d.id, ...d.data() }))
        .filter((d) => d.aishe_code === aisheCode && Number(d.semester) === sem)
        .map((d) => ({ division_id: d.division_id, name: d.name }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
    });
    res.set("Cache-Control", "public, max-age=30");
    return res.status(200).json({ success: true, divisions: result });
  } catch (error) {
    console.error("Fetch divisions error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

module.exports = router;