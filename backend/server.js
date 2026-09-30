require("dotenv").config(); // ← MUST be first, before any other require

const express = require("express");
const { db } = require("./config/firebase");
const collegeRoutes = require("./routes/college.routes");
const authRoutes    = require("./routes/auth.routes");
const app  = express();
const PORT = process.env.PORT || 5000;
const cors = require("cors");
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/auth",            authRoutes);
app.use("/api/colleges",    collegeRoutes);
app.use("/api/lectures",    require("./routes/lecture.routes"));
app.use("/api/quizzes",     require("./routes/quiz.routes"));
app.use("/api/assignments", require("./routes/assignment.routes"));
app.use("/api/profile",     require("./routes/profile.routes"));
app.use("/api/reports",     require("./routes/reports.routes"));
app.use("/api/broadcasts",  require("./routes/broadcast.routes"));
app.use("/api/manage",      require("./routes/manage.routes"));
app.use("/api/od", require("./routes/od.routes"));
app.use("/api/web/teacher", require("./routes/web/teacher.routes"));

app.get("/", (req, res) => res.send("PresencePro Backend Running"));

app.get("/users", async (req, res) => {
  try {
    const snapshot = await db.collection("users").get();
    const users = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/users/:id", async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user: { id: doc.id, ...doc.data() } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/users", async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) return res.status(400).json({ error: "email and role are required" });

    const userData = {
      email,
      role,
      approval_status:      "pending",
      is_active:            true,
      is_profile_complete:  false,
      created_at:           new Date(),
    };

    const docRef = await db.collection("users").add(userData);
    res.status(201).json({ success: true, id: docRef.id, user: userData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/users/:id", async (req, res) => {
  try {
    await db.collection("users").doc(req.params.id).update(req.body);
    res.json({ success: true, message: "User updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

module.exports = app;