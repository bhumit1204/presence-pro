// profile_routes.js
// Mount as: app.use("/api/profile", require("./routes/profile_routes"));

const express = require("express");
const router = express.Router();
const { admin, db } = require("../config/firebase");
const { guard, fromParams, fromBody } = require("../middleware/auth");
const { TTLCache } = require("../utils/cache");
const { invalidateTokenCache } = require("../services/notify");
const semInfo = require("../services/semesterInfo");

// Short-lived caches: the app opens several screens that each ask for the same
// profile, and 800 students opening the app together should cost 800 reads, not 4000.
const studentCache = new TTLCache({ max: 20_000, ttlMs: 15_000 });
const teacherCache = new TTLCache({ max: 5_000, ttlMs: 30_000 });

const PUSH_REFRESH_MS = 7 * 24 * 3600 * 1000; // re-write an unchanged token at most weekly

// Never hand a device push token to other users / the browser.
function sanitize(profile) {
  if (!profile) return profile;
  const { pushToken, pushTokenUpdatedAt, ...rest } = profile;
  return rest;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/student/:uid
// ─────────────────────────────────────────────────────────────────────────────
router.get("/student/:uid", guard.selfOrTeacher(fromParams("uid")), async (req, res) => {
  try {
    const { uid } = req.params;

    if (!uid) {
      return res.status(400).json({ success: false, error: "uid is required" });
    }

    const profile = await studentCache.memo(`s:${uid}`, 15_000, async () => {
      const studentDoc = await db.collection("students").doc(uid).get();
      if (studentDoc.exists) return sanitize(studentDoc.data());

      const snap = await db
        .collection("students")
        .where("uid", "==", uid)
        .limit(1)
        .get();

      if (snap.empty) return null;
      return sanitize(snap.docs[0].data());
    });

    if (!profile) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }

    return res.status(200).json({ success: true, profile });
  } catch (error) {
    console.error("STUDENT PROFILE FETCH ERROR:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/student/:uid/semester
// How far through the current semester the student is (days elapsed between the
// start and end dates the head entered). Read-only.
// ─────────────────────────────────────────────────────────────────────────────
const semesterCache = new TTLCache({ max: 20_000, ttlMs: 60_000 });

router.get("/student/:uid/semester", guard.selfOrTeacher(fromParams("uid")), async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ success: false, error: "uid is required" });

    const out = await semesterCache.memo(`sem:${uid}`, 60_000, async () => {
      let data = null;
      const direct = await db.collection("students").doc(uid).get();
      if (direct.exists) data = direct.data();
      else {
        const snap = await db.collection("students").where("uid", "==", uid).limit(1).get();
        if (!snap.empty) data = snap.docs[0].data();
      }
      if (!data) return null;

      const semester = semInfo.parseSem(data.semester);
      const course_id = await semInfo.courseIdOf(data);
      if (semester === null || !course_id) return { status: "not_set", semester: semester || null };
      if (data.semester_status === "completed") {
        return {
          status: "completed",
          semester,
          label: `Sem ${semester}`,
          total_semesters: semester,
          percent: 100,
        };
      }
      return semInfo.progressFor(course_id, semester);
    });

    if (!out) return res.status(404).json({ success: false, error: "Student not found" });
    return res.json({ success: true, progress: out });
  } catch (error) {
    console.error("SEMESTER PROGRESS ERROR:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ELECTIVES
//
// A semester can have several elective groups ("Elective 1", "Elective 2" ...), each with a few
// optional subjects (subjects.compulsary === false, subjects.elective_group). The student picks ONE
// subject from EACH group. Once saved the choice is final for that semester; it can only be made
// again after the semester changes.
//
//   GET  /api/profile/student/:uid/electives
//   POST /api/profile/student/:uid/electives      { selections: { "<group>": "<subject_id>", ... } }
//
// students.elective_choices = { "<semester number>": { "<group>": subject_id } }
// The chosen subjects are also added to students.enrolled_subjects, which every other feature
// (attendance, quizzes, assignments, broadcasts ...) already reads.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_GROUP = "Elective";
const electiveSubjectsCache = new TTLCache({ max: 2_000, ttlMs: 60_000 });

async function findStudentDoc(uid) {
  const direct = await db.collection("students").doc(uid).get();
  if (direct.exists) return direct;
  const snap = await db.collection("students").where("uid", "==", uid).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

/** [{ group, options: [{ subject_id, subject_name, subject_code, teacher_name }] }] for one course + semester. */
async function loadElectiveGroups(course_id, semester) {
  return electiveSubjectsCache.memo(`e:${course_id}|${semester}`, 60_000, async () => {
    const snap = await db
      .collection("subjects")
      .where("course_id", "==", course_id)
      .where("semester", "==", `Sem ${semester}`)
      .where("compulsary", "==", false)
      .get();
    if (snap.empty) return [];

    const teacherIds = [...new Set(snap.docs.map((d) => d.data().teacher_assigned).filter(Boolean))];
    const names = {};
    if (teacherIds.length) {
      try {
        const docs = await db.getAll(...teacherIds.map((t) => db.collection("teachers").doc(t)), {
          fieldMask: ["first_name", "last_name", "name"],
        });
        docs.forEach((t) => {
          if (!t.exists) return;
          const d = t.data();
          names[t.id] = (`${d.first_name || ""} ${d.last_name || ""}`).trim() || d.name || "";
        });
      } catch (_) {}
    }

    const groups = new Map();
    snap.docs.forEach((d) => {
      const x = d.data();
      const g = String(x.elective_group || "").trim() || DEFAULT_GROUP;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({
        subject_id: d.id,
        subject_name: x.subject_name || "",
        subject_code: x.subject_code || "",
        teacher_name: x.teacher_assigned ? names[x.teacher_assigned] || "" : "",
      });
    });
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([group, options]) => ({
        group,
        options: options.sort((a, b) => a.subject_name.localeCompare(b.subject_name)),
      }));
  });
}

router.get("/student/:uid/electives", guard.selfOrTeacher(fromParams("uid")), async (req, res) => {
  try {
    const doc = await findStudentDoc(req.params.uid);
    if (!doc) return res.status(404).json({ success: false, error: "Student not found" });
    const st = doc.data();

    const semester = semInfo.parseSem(st.semester);
    const course_id = await semInfo.courseIdOf(st);
    if (semester === null || !course_id || st.semester_status === "completed") {
      return res.json({ success: true, semester, groups: [], pending: 0, locked: false });
    }

    const chosen = (st.elective_choices && st.elective_choices[String(semester)]) || {};
    const groups = (await loadElectiveGroups(course_id, semester)).map((g) => {
      const picked = chosen[g.group] && g.options.some((o) => o.subject_id === chosen[g.group]) ? chosen[g.group] : null;
      return { group: g.group, chosen: picked, options: g.options };
    });
    const pending = groups.filter((g) => !g.chosen).length;

    return res.json({
      success: true,
      semester,
      groups,
      pending,                                   // groups still to choose
      locked: groups.length > 0 && pending === 0, // everything chosen: nothing left to change this semester
    });
  } catch (e) {
    console.error("ELECTIVES FETCH ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/student/:uid/electives", guard.student(fromParams("uid")), async (req, res) => {
  try {
    const { uid } = req.params;
    const selections = req.body && req.body.selections;
    if (!selections || typeof selections !== "object" || Array.isArray(selections) || Object.keys(selections).length > 20) {
      return res.status(400).json({ success: false, error: "selections is required" });
    }
    for (const [g, v] of Object.entries(selections)) {
      if (typeof g !== "string" || g.length > 80 || typeof v !== "string" || !v || v.length > 200 || v.includes("/")) {
        return res.status(400).json({ success: false, error: "Invalid selection" });
      }
    }

    const found = await findStudentDoc(uid);
    if (!found) return res.status(404).json({ success: false, error: "Student not found" });
    const ref = found.ref;

    class Reject extends Error {
      constructor(status, message) { super(message); this.status = status; }
    }

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const st = snap.data() || {};
      const semester = semInfo.parseSem(st.semester);
      const course_id = await semInfo.courseIdOf(st);
      if (semester === null || !course_id) throw new Reject(400, "Your semester is not set");
      if (st.semester_status === "completed") throw new Reject(400, "Your course is completed");

      const groups = await loadElectiveGroups(course_id, semester);
      const byGroup = new Map(groups.map((g) => [g.group, g]));
      const already = (st.elective_choices && st.elective_choices[String(semester)]) || {};

      // groups that still need a choice (a choice that points at a subject that no longer exists counts as missing)
      const open = groups.filter((g) => !(already[g.group] && g.options.some((o) => o.subject_id === already[g.group])));
      if (!groups.length) throw new Reject(400, "There are no elective subjects in your semester");
      if (!open.length) throw new Reject(409, "Your electives are already chosen for this semester");

      for (const g of Object.keys(selections)) {
        if (!byGroup.has(g)) throw new Reject(400, `Unknown elective group: ${g}`);
        if (!open.some((o) => o.group === g)) throw new Reject(409, `${g} is already chosen for this semester`);
        if (!byGroup.get(g).options.some((o) => o.subject_id === selections[g])) {
          throw new Reject(400, `That subject is not an option in ${g}`);
        }
      }
      const missing = open.filter((g) => !selections[g.group]);
      if (missing.length) throw new Reject(400, `Choose one subject in: ${missing.map((m) => m.group).join(", ")}`);

      const picked = {};
      open.forEach((g) => { picked[g.group] = selections[g.group]; });

      tx.set(
        ref,
        {
          elective_choices: { [String(semester)]: picked },
          enrolled_subjects: admin.firestore.FieldValue.arrayUnion(...Object.values(picked)),
          electives_chosen_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { semester, picked };
    });

    studentCache.del(`s:${uid}`);
    return res.json({ success: true, semester: result.semester, chosen: result.picked, message: "Electives saved" });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ success: false, error: e.message });
    console.error("ELECTIVES SAVE ERROR:", e);
    return res.status(500).json({ success: false, error: "Could not save electives" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DIVISION  (section A / B / C of the student's semester)
//
// The head creates divisions (divisions/{id}). A student without a division can pick one here; once set it can
// only be changed by the head. Students without a division see only the lectures common to everyone.
//
//   GET  /api/profile/student/:uid/divisions
//   POST /api/profile/student/:uid/division      { division_id }
// ─────────────────────────────────────────────────────────────────────────────
const { forgetStudent } = require("../utils/students");

/** [{ division_id, name }] of one course + semester, sorted by name (30 s cache) */
const divisionOptionsCache = new TTLCache({ max: 2_000, ttlMs: 30_000 });
function divisionOptions(course_id, semester) {
  return divisionOptionsCache.memo(`d:${course_id}|${semester}`, 30_000, async () => {
    const snap = await db.collection("divisions").where("course_id", "==", course_id).get();
    return snap.docs
      .map((d) => ({ division_id: d.id, name: d.data().name, semester: semInfo.parseSem(d.data().semester) }))
      .filter((d) => d.semester === semester)
      .map(({ division_id, name }) => ({ division_id, name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  });
}

router.get("/student/:uid/divisions", guard.selfOrTeacher(fromParams("uid")), async (req, res) => {
  try {
    const doc = await findStudentDoc(req.params.uid);
    if (!doc) return res.status(404).json({ success: false, error: "Student not found" });
    const st = doc.data();
    const semester = semInfo.parseSem(st.semester);
    const course_id = await semInfo.courseIdOf(st);
    const options = semester !== null && course_id ? await divisionOptions(course_id, semester) : [];
    const current = st.division_id ? { division_id: st.division_id, name: st.division || "" } : null;
    return res.json({ success: true, semester, current, options, can_choose: !current && options.length > 0 });
  } catch (e) {
    console.error("DIVISIONS FETCH ERROR:", e);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/student/:uid/division", guard.student(fromParams("uid")), async (req, res) => {
  try {
    const division_id = req.body && req.body.division_id;
    if (typeof division_id !== "string" || !division_id || division_id.length > 200 || division_id.includes("/")) {
      return res.status(400).json({ success: false, error: "Choose a division" });
    }
    const found = await findStudentDoc(req.params.uid);
    if (!found) return res.status(404).json({ success: false, error: "Student not found" });

    class Reject extends Error { constructor(status, message) { super(message); this.status = status; } }
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(found.ref);
      const st = snap.data() || {};
      if (st.division_id) throw new Reject(409, "Your division is already set. Ask your head if it needs to change.");
      const semester = semInfo.parseSem(st.semester);
      const course_id = await semInfo.courseIdOf(st);
      if (semester === null || !course_id) throw new Reject(400, "Your semester is not set");
      if (st.semester_status === "completed") throw new Reject(400, "Your course is completed");
      const dv = await tx.get(db.collection("divisions").doc(division_id));
      const d = dv.exists ? dv.data() : null;
      if (!d || d.course_id !== course_id || semInfo.parseSem(d.semester) !== semester) {
        throw new Reject(400, "That division is not available for your semester");
      }
      tx.update(found.ref, { division_id, division: d.name });
      return { division_id, name: d.name };
    });

    studentCache.del(`s:${req.params.uid}`);
    forgetStudent(req.params.uid);
    return res.json({ success: true, division: out, message: `Division ${out.name} saved` });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ success: false, error: e.message });
    console.error("DIVISION SAVE ERROR:", e);
    return res.status(500).json({ success: false, error: "Could not save your division" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/profile/teacher/:teacher_id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/teacher/:teacher_id", guard.authed, async (req, res) => {
  try {
    const { teacher_id } = req.params;

    if (!teacher_id) {
      return res
        .status(400)
        .json({ success: false, error: "teacher_id is required" });
    }

    const profile = await teacherCache.memo(`t:${teacher_id}`, 30_000, async () => {
      let teacherData;
      const teacherDoc = await db.collection("teachers").doc(teacher_id).get();
      if (teacherDoc.exists) {
        teacherData = teacherDoc.data();
      } else {
        const snap = await db
          .collection("teachers")
          .where("teacher_id", "==", teacher_id)
          .limit(1)
          .get();
        if (snap.empty) return null;
        teacherData = snap.docs[0].data();
      }

      let email = null;
      if (teacherData.user_id) {
        const userDoc = await db.collection("users").doc(teacherData.user_id).get();
        if (userDoc.exists) email = userDoc.data().email;
      }
      return { ...sanitize(teacherData), email };
    });

    if (!profile) {
      return res.status(404).json({ success: false, error: "Teacher not found" });
    }

    return res.status(200).json({ success: true, profile });
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
// Student docs may be keyed by uid OR by an auto id (with a `uid` field);
// both are handled. Teachers are found by `user_id`.
//
// Optimisations:
//  * the app calls this on every launch -> if the stored token is identical and
//    was refreshed within the last week we skip the write entirely;
//  * when a token moves to a different account (shared phone, logout/login) the
//    token is removed from the previous owner so their notifications stop
//    appearing on the new user's device.
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/push-token", guard.self(fromBody("uid")), async (req, res) => {
  try {
    const { uid, role, pushToken } = req.body;

    if (!uid || !role || !pushToken) {
      return res.status(400).json({
        success: false,
        error: "uid, role, and pushToken are required",
      });
    }
    if (typeof uid !== "string" || typeof pushToken !== "string" || pushToken.length > 300) {
      return res.status(400).json({ success: false, error: "Invalid uid or pushToken" });
    }

    let docRef;
    let current;

    if (role === "student") {
      // Doc id == uid is the common case (one direct read); otherwise query by uid field.
      const direct = await db.collection("students").doc(uid).get();
      if (direct.exists) {
        docRef = direct.ref;
        current = direct.data();
      } else {
        const snap = await db.collection("students").where("uid", "==", uid).limit(1).get();
        if (snap.empty) {
          console.warn(`[push-token] Student doc not found for uid=${uid}`);
          return res.status(404).json({ success: false, error: "Student not found" });
        }
        docRef = snap.docs[0].ref;
        current = snap.docs[0].data();
      }
    } else {
      // Teachers: always stored with user_id as the auth UID field
      const snap = await db.collection("teachers").where("user_id", "==", uid).limit(1).get();
      if (snap.empty) {
        return res.status(404).json({ success: false, error: "Teacher not found" });
      }
      docRef = snap.docs[0].ref;
      current = snap.docs[0].data();
    }

    const sameToken = current.pushToken === pushToken;
    const updatedAt = current.pushTokenUpdatedAt?.toDate?.()?.getTime?.() || 0;
    const fresh = Date.now() - updatedAt < PUSH_REFRESH_MS;

    if (!(sameToken && fresh)) {
      await docRef.update({
        pushToken,
        pushTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      invalidateTokenCache(uid);

      if (!sameToken) {
        // best effort, never blocks the response
        detachTokenFromOthers(pushToken, docRef.path).catch(() => {});
      }
    }

    return res.status(200).json({ success: true, message: "Push token saved" });
  } catch (error) {
    console.error("PUSH TOKEN SAVE ERROR:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
});

async function detachTokenFromOthers(pushToken, keepPath) {
  const [s, t] = await Promise.all([
    db.collection("students").where("pushToken", "==", pushToken).get(),
    db.collection("teachers").where("pushToken", "==", pushToken).get(),
  ]);
  const ops = [];
  for (const d of [...s.docs, ...t.docs]) {
    if (d.ref.path === keepPath) continue;
    invalidateTokenCache(d.data().uid || d.data().user_id || d.id);
    ops.push(d.ref.update({ pushToken: admin.firestore.FieldValue.delete() }));
  }
  await Promise.all(ops);
}

// used by the head routes after they change electives / divisions, so the app sees it at once
router.dropCaches = (uids) => {
  electiveSubjectsCache.clear();
  divisionOptionsCache.clear();
  (uids || []).forEach((u) => { studentCache.del(`s:${u}`); semesterCache.del(`sem:${u}`); });
};

module.exports = router;