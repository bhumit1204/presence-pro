const { db } = require("../config/firebase");

let _expo = null;
let _Expo = null;

async function getExpo() {
  if (_expo) return { expo: _expo, Expo: _Expo };
  const mod = await import("expo-server-sdk");
  _Expo = mod.Expo;
  _expo = new _Expo();
  return { expo: _expo, Expo: _Expo };
}

async function getTokensForUids(userIds) {
  if (!userIds || userIds.length === 0) return [];

  const { Expo } = await getExpo();

  const tokenSet = new Set();
  const tokens   = [];

  const addToken = (uid, token) => {
    if (token && Expo.isExpoPushToken(token) && !tokenSet.has(token)) {
      tokenSet.add(token);
      tokens.push({ uid, token });
    }
  };

  const CHUNK = 30;

  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK);

    await Promise.all([
      db.collection("students")
        .where("uid", "in", chunk)
        .get()
        .then((snap) => {
          snap.docs.forEach((doc) => {
            const d = doc.data();
            addToken(d.uid || doc.id, d.pushToken);
          });
        })
        .catch(() => {}),

      Promise.all(
        chunk.map((uid) =>
          db.collection("students").doc(uid).get()
            .then((doc) => {
              if (doc.exists) {
                const d = doc.data();
                addToken(d.uid || doc.id, d.pushToken);
              }
            })
            .catch(() => {})
        )
      ),

      db.collection("teachers")
        .where("user_id", "in", chunk)
        .get()
        .then((snap) => {
          snap.docs.forEach((doc) => {
            const d = doc.data();
            addToken(d.user_id, d.pushToken);
          });
        })
        .catch(() => {}),
    ]);
  }

  return tokens;
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

    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (_) {}
    }
  } catch (_) {}
}

async function getStudentUidsForSubject(subject_id) {
  try {
    const snap = await db
      .collection("students")
      .where("enrolled_subjects", "array-contains", subject_id)
      .where("approval_status", "==", "approved")
      .get();

    return snap.docs.map((d) => d.data().uid || d.id);
  } catch {
    return [];
  }
}

module.exports = { notify, getStudentUidsForSubject };