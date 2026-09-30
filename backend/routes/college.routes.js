const express = require("express");
const router = express.Router();
const { db } = require("../config/firebase");

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

    //  ONE efficient Admin SDK query
    const snapshot = await db
      .collection("colleges")
      .where("aishe_code", "==", aisheCode)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({
        success: false,
        error: "College not found",
      });
    }

    const doc = snapshot.docs[0];

    return res.status(200).json({
      success: true,
      college_id: doc.id,
      college: doc.data(),
    });
  } catch (error) {
    console.error("AISHE verify error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// 📚 Fetch courses for college (NO N+1)
router.get("/:aisheCode/courses", async (req, res) => {
  try {
    const aisheCode = req.params.aisheCode?.trim().toUpperCase();

    if (!aisheCode) {
      return res.status(400).json({
        success: false,
        error: "AISHE code is required",
      });
    }

    //  SINGLE QUERY
    const snapshot = await db
      .collection("courses")
      .where("aishe_code", "==", aisheCode)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({
        success: false,
        error: "No courses found for this college",
      });
    }

    const courses = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.status(200).json({
      success: true,
      count: courses.length,
      courses,
    });
  } catch (error) {
    console.error("Fetch courses error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

module.exports = router;
