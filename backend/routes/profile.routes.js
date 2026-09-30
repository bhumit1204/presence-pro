// profile_routes.js
// Mount as: app.use("/api/profile", require("./routes/profile_routes"));

const express = require("express");
const router = express.Router();
const { admin, db } = require("../config/firebase");

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/student/:uid
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student/:uid", async (req, res) => {
  try {
    const { uid } = req.params;

    if (!uid) {
      return res.status(400).json({ success: false, error: "uid is required" });
    }

    const studentDoc = await db.collection("students").doc(uid).get();

    if (!studentDoc.exists) {
      const snap = await db
        .collection("students")
        .where("uid", "==", uid)
        .limit(1)
        .get();

      if (snap.empty) {
        return res
          .status(404)
          .json({ success: false, error: "Student not found" });
      }

      return res.status(200).json({
        success: true,
        profile: snap.docs[0].data(),
      });
    }

    return res.status(200).json({
      success: true,
      profile: studentDoc.data(),
    });
  } catch (error) {
    console.error("STUDENT PROFILE FETCH ERROR:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/teacher/:teacher_id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/teacher/:teacher_id", async (req, res) => {
  try {
    const { teacher_id } = req.params;

    if (!teacher_id) {
      return res
        .status(400)
        .json({ success: false, error: "teacher_id is required" });
    }

    const teacherDoc = await db.collection("teachers").doc(teacher_id).get();

    if (!teacherDoc.exists) {
      const snap = await db
        .collection("teachers")
        .where("teacher_id", "==", teacher_id)
        .limit(1)
        .get();

      if (snap.empty) {
        return res
          .status(404)
          .json({ success: false, error: "Teacher not found" });
      }

      const teacherData = snap.docs[0].data();
      let email = null;
      if (teacherData.user_id) {
        const userDoc = await db
          .collection("users")
          .doc(teacherData.user_id)
          .get();
        if (userDoc.exists) email = userDoc.data().email;
      }

      return res.status(200).json({
        success: true,
        profile: { ...teacherData, email },
      });
    }

    const teacherData = teacherDoc.data();
    let email = null;
    if (teacherData.user_id) {
      const userDoc = await db
        .collection("users")
        .doc(teacherData.user_id)
        .get();
      if (userDoc.exists) email = userDoc.data().email;
    }

    return res.status(200).json({
      success: true,
      profile: { ...teacherData, email },
    });
  } catch (error) {
    console.error("TEACHER PROFILE FETCH ERROR:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/profile/push-token
// Called by the app after login to register / update the Expo push token.
//
// Body:
//   uid        string  (Firebase Auth UID — required)
//   role       string  "student" | "teacher"  (required)
//   pushToken  string  Expo push token        (required)
//
// FIX: Student token save previously used db.collection("students").doc(uid)
// which assumes the Firestore doc ID equals the auth UID. This is often NOT
// the case — student docs may use auto-generated IDs with a `uid` field.
// We now query by `uid` field first, and only fall back to doc-ID lookup
// if the field query returns nothing (handles both schema patterns).
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/push-token", async (req, res) => {
  try {
    const { uid, role, pushToken } = req.body;

    if (!uid || !role || !pushToken) {
      return res.status(400).json({
        success: false,
        error: "uid, role, and pushToken are required",
      });
    }

    const tokenData = {
      pushToken,
      pushTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (role === "student") {
      // FIX: Try querying by `uid` field first — handles auto-ID doc schemas.
      // If nothing found, fall back to using uid directly as the doc ID.
      const snap = await db
        .collection("students")
        .where("uid", "==", uid)
        .limit(1)
        .get();

      if (!snap.empty) {
        // Found by uid field — update that specific doc
        await snap.docs[0].ref.update(tokenData);
      } else {
        // Fall back: try uid as doc ID (some schemas store it this way)
        const directDoc = await db.collection("students").doc(uid).get();
        if (directDoc.exists) {
          await directDoc.ref.update(tokenData);
        } else {
          // Student doc not found under either pattern
          console.warn(`[push-token] Student doc not found for uid=${uid}`);
          return res.status(404).json({ success: false, error: "Student not found" });
        }
      }
    } else {
      // Teachers: always stored with user_id as the auth UID field
      const snap = await db
        .collection("teachers")
        .where("user_id", "==", uid)
        .limit(1)
        .get();

      if (snap.empty) {
        return res.status(404).json({ success: false, error: "Teacher not found" });
      }

      await snap.docs[0].ref.update(tokenData);
    }

    return res.status(200).json({ success: true, message: "Push token saved" });
  } catch (error) {
    console.error("PUSH TOKEN SAVE ERROR:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
});

module.exports = router;