// routes/notifyprefs.routes.js
// Mounted at /api/notify-prefs
//   GET /api/notify-prefs?uid=...   -> the student's notification settings (defaults filled in)
//   PUT /api/notify-prefs           -> { uid, lecture_start?, lecture_live?, low_attendance?, assignments?, quizzes?,
//                                       announcements?, window_before_min?, window_after_min? }  (only what is sent changes)
const express = require("express");
const router = express.Router();
const { admin, db } = require("../config/firebase");
const { guard, fromQuery, fromBody } = require("../middleware/auth");
const { rateLimit, byIp } = require("../utils/limiter");
const { prefsOf, sanitize, DEFAULTS } = require("../utils/notifyPrefs");
const { invalidateTokenCache } = require("../services/notify");

const limit = rateLimit({ windowMs: 60_000, max: 60, key: (req) => req.auth?.uid || byIp(req), name: "notify-prefs" });

async function studentRef(uid) {
  if (typeof uid !== "string" || !uid || uid.includes("/")) return null;
  const direct = await db.collection("students").doc(uid).get();
  if (direct.exists) return direct;
  const snap = await db.collection("students").where("uid", "==", uid).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

router.get("/", limit, guard.self(fromQuery("uid")), async (req, res) => {
  try {
    const uid = req.query.uid || req.auth?.uid;
    const doc = await studentRef(uid);
    if (!doc) return res.status(404).json({ success: false, error: "Student not found" });
    return res.json({ success: true, prefs: prefsOf(doc.data()), defaults: DEFAULTS });
  } catch (e) {
    console.error("NOTIFY PREFS GET ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.put("/", limit, guard.self(fromBody("uid")), async (req, res) => {
  try {
    const uid = req.body?.uid || req.auth?.uid;
    const check = sanitize(req.body);
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });
    if (!Object.keys(check.value).length) return res.status(400).json({ success: false, error: "Nothing to change" });
    const doc = await studentRef(uid);
    if (!doc) return res.status(404).json({ success: false, error: "Student not found" });

    const merged = { ...(doc.data().notify_prefs || {}), ...check.value };
    await doc.ref.update({ notify_prefs: merged, notify_prefs_updated_at: admin.firestore.FieldValue.serverTimestamp() });
    invalidateTokenCache(doc.data().uid || uid);
    return res.json({ success: true, prefs: prefsOf({ notify_prefs: merged }) });
  } catch (e) {
    console.error("NOTIFY PREFS PUT ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

module.exports = router;
