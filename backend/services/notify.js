const { admin, db } = require("../config/firebase");
const { TTLCache } = require("../utils/cache");
const { createGate } = require("../utils/limiter");

// ─── Expo SDK (ESM-only package, loaded lazily, once) ────────────────────────
let _expoPromise = null;
function getExpo() {
  if (!_expoPromise) {
    _expoPromise = import("expo-server-sdk").then((mod) => ({ Expo: mod.Expo, expo: new mod.Expo() }));
    _expoPromise.catch(() => {
      _expoPromise = null; // allow a retry if the import failed
    });
  }
  return _expoPromise;
}

// ─── caches ──────────────────────────────────────────────────────────────────
// uid -> expo token ("" = user has no token). Short TTL so a re-registered
// device is picked up quickly; profile.routes calls invalidateTokenCache().
const tokenCache = new TTLCache({ max: 50_000, ttlMs: 120_000 });
// subject_id -> [student uid]
const subjectStudentsCache = new TTLCache({ max: 2_000, ttlMs: 30_000 });

const sendGate = createGate(4); // never hammer the Expo API with more than 4 parallel requests

function invalidateTokenCache(uid) {
  if (uid) tokenCache.del(`t:${uid}`);
}
function invalidateSubjectStudents(subject_id) {
  if (subject_id) subjectStudentsCache.del(subject_id);
}

const CHUNK = 30; // Firestore `in` limit

/**
 * Resolve push tokens for a list of auth uids.
 *
 * Original behaviour: for every chunk of 30 uids it ran THREE lookups
 * (students by `uid`, one extra GET per uid on students/{uid}, teachers by
 * `user_id`), i.e. ~32 reads per 30 recipients even though most uids were
 * already found by the first query.
 *
 * Now: students are matched by the `uid` field first (1 query / 30 uids). The
 * extra students/{uid} lookup and the teachers query only run for uids that the
 * first query did NOT find. Results are cached for 2 minutes.
 */
async function getTokensForUids(userIds) {
  if (!userIds || userIds.length === 0) return [];

  const { Expo } = await getExpo();
  const uniq = [...new Set(userIds.filter(Boolean))];

  const tokenSet = new Set();
  const tokens = [];
  const addToken = (uid, token) => {
    if (token && Expo.isExpoPushToken(token) && !tokenSet.has(token)) {
      tokenSet.add(token);
      tokens.push({ uid, token });
    }
  };

  const missing = [];
  for (const uid of uniq) {
    const c = tokenCache.get(`t:${uid}`);
    if (c === undefined) missing.push(uid);
    else if (c) addToken(uid, c);
  }
  if (!missing.length) return tokens;

  const found = new Map(); // uid -> token string ("" when none)
  const resolvedAsStudent = new Set();

  // Pass 1 — students by uid field
  const chunks = [];
  for (let i = 0; i < missing.length; i += CHUNK) chunks.push(missing.slice(i, i + CHUNK));

  await Promise.all(
    chunks.map((chunk) =>
      db
        .collection("students")
        .where("uid", "in", chunk)
        .select("uid", "pushToken")
        .get()
        .then((snap) => {
          snap.docs.forEach((doc) => {
            const d = doc.data();
            const uid = d.uid || doc.id;
            resolvedAsStudent.add(uid);
            if (d.pushToken && !found.get(uid)) found.set(uid, d.pushToken);
          });
        })
        .catch(() => {})
    )
  );

  // Pass 2 — only for uids not matched above: students/{uid} + teachers.user_id
  const rest = missing.filter((u) => !resolvedAsStudent.has(u));
  if (rest.length) {
    const restChunks = [];
    for (let i = 0; i < rest.length; i += CHUNK) restChunks.push(rest.slice(i, i + CHUNK));

    await Promise.all([
      // direct doc lookups in ONE round trip per chunk (was one GET per uid)
      ...restChunks.map((chunk) =>
        db
          .getAll(...chunk.map((u) => db.collection("students").doc(u)), { fieldMask: ["uid", "pushToken"] })
          .then((snaps) => {
            snaps.forEach((s) => {
              if (!s.exists) return;
              const d = s.data();
              const uid = d.uid || s.id;
              if (d.pushToken && !found.get(uid)) found.set(uid, d.pushToken);
            });
          })
          .catch(() => {})
      ),
      ...restChunks.map((chunk) =>
        db
          .collection("teachers")
          .where("user_id", "in", chunk)
          .select("user_id", "pushToken")
          .get()
          .then((snap) => {
            snap.docs.forEach((doc) => {
              const d = doc.data();
              if (d.pushToken && !found.get(d.user_id)) found.set(d.user_id, d.pushToken);
            });
          })
          .catch(() => {})
      ),
    ]);
  }

  for (const uid of missing) {
    const t = found.get(uid) || "";
    tokenCache.set(`t:${uid}`, t);
    if (t) addToken(uid, t);
  }
  return tokens;
}

/** Remove tokens Expo says are dead (app uninstalled) so we stop paying to send to them. */
async function pruneDeadTokens(deadTokens) {
  for (const token of deadTokens) {
    try {
      const [s, t] = await Promise.all([
        db.collection("students").where("pushToken", "==", token).get(),
        db.collection("teachers").where("pushToken", "==", token).get(),
      ]);
      const ops = [];
      s.docs.forEach((d) => {
        tokenCache.del(`t:${d.data().uid || d.id}`);
        ops.push(d.ref.update({ pushToken: admin.firestore.FieldValue.delete() }));
      });
      t.docs.forEach((d) => {
        tokenCache.del(`t:${d.data().user_id}`);
        ops.push(d.ref.update({ pushToken: admin.firestore.FieldValue.delete() }));
      });
      await Promise.all(ops);
    } catch (_) {
      /* best effort */
    }
  }
}

async function notify({ userIds, title, body, data = {}, sound = "default" }) {
  try {
    if (!userIds || userIds.length === 0) return;

    const { expo } = await getExpo();

    const tokenObjs = await getTokensForUids(userIds);
    if (tokenObjs.length === 0) return;

    const messages = tokenObjs.map(({ token }) => ({
      to: token,
      sound,
      title,
      body,
      data,
    }));

    const chunks = expo.chunkPushNotifications(messages);
    const dead = [];

    await Promise.all(
      chunks.map((chunk) =>
        sendGate
          .run(() => expo.sendPushNotificationsAsync(chunk))
          .then((tickets) => {
            (tickets || []).forEach((tk, i) => {
              if (tk && tk.status === "error" && tk.details && tk.details.error === "DeviceNotRegistered") {
                dead.push(chunk[i].to);
              }
            });
          })
          .catch(() => {})
      )
    );

    if (dead.length) pruneDeadTokens(dead).catch(() => {});
  } catch (_) {}
}

async function getStudentUidsForSubject(subject_id) {
  try {
    return await subjectStudentsCache.memo(subject_id, 30_000, async () => {
      const snap = await db
        .collection("students")
        .where("enrolled_subjects", "array-contains", subject_id)
        .where("approval_status", "==", "approved")
        .select("uid")
        .get();
      return snap.docs.map((d) => d.data().uid || d.id);
    });
  } catch {
    return [];
  }
}

module.exports = { notify, getStudentUidsForSubject, invalidateTokenCache, invalidateSubjectStudents };
