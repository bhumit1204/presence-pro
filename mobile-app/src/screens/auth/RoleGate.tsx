// src/screens/auth/RoleGate.tsx
// Decides where a signed-in user goes. Never leaves a half-signed-in user behind:
// blocked / failed states offer Retry and Sign out.
//   - no collection scans (the old fallback downloaded every teacher document)
//   - no ID token is stored
//   - pending / rejected / disabled accounts are stopped here

import { ActivityIndicator, View } from "react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { doc, getDoc, collection, query, where, getDocs, limit } from "firebase/firestore";
import { useNavigation } from "@react-navigation/native";
import { onAuthStateChanged, User } from "firebase/auth";
import { auth, db } from "../../services/firebase";
import { saveUserSession, savePushToken, signOutAndClear } from "../../services/session";
import { registerForPushNotifications } from "../../services/notifications";
import Logo from "../../components/Logo";
import { Button, ResultView, Screen, T } from "../../components/ui";

// On a cold start auth.currentUser is null until Firebase has restored the saved login from storage.
// Wait for that first answer, otherwise a signed-in user is sent to the login screen on every app start.
const waitForAuth = (): Promise<User | null> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (u: User | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(u);
    };
    const unsub = onAuthStateChanged(auth, (u) => finish(u), () => finish(null));
    const timer = setTimeout(() => finish(auth.currentUser), 8000);
  });

type Phase =
  | { kind: "loading" }
  | { kind: "inactive" }
  | { kind: "pending" }
  | { kind: "rejected" }
  | { kind: "error"; message: string };

export default function RoleGate() {
  const navigation = useNavigation<any>();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const alive = useRef(true);

  const toAuth = useCallback(() => navigation.replace("Auth"), [navigation]);

  const init = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const user = auth.currentUser || (await waitForAuth());
      if (!alive.current) return;
      if (!user) return toAuth();

      const snap = await getDoc(doc(db, "users", user.uid));
      if (!alive.current) return;
      if (!snap.exists()) {
        await signOutAndClear();
        return toAuth();
      }
      const data = snap.data() as any;

      if (data?.is_active === false) return setPhase({ kind: "inactive" });
      const approval = String(data?.approval_status || "").toLowerCase();
      if (approval === "pending") return setPhase({ kind: "pending" });
      if (approval === "rejected") return setPhase({ kind: "rejected" });

      // hod / head_teacher accounts are plain teachers here (same app, same screens)
      const rawRole = String(data?.role || "student").toLowerCase();
      const role = ["hod", "head_teacher", "head teacher", "teacher"].includes(rawRole) ? "teacher" : "student";

      let teacher_id: string | null = null;
      if (role === "teacher") {
        const byUser = await getDocs(query(collection(db, "teachers"), where("user_id", "==", user.uid), limit(1)));
        if (!byUser.empty) {
          teacher_id = byUser.docs[0].id;
        } else {
          // teacher documents created by an admin may use the uid as the document id
          const direct = await getDoc(doc(db, "teachers", user.uid));
          if (direct.exists()) teacher_id = direct.id;
        }
      }
      if (!alive.current) return;

      await saveUserSession({
        uid: user.uid,
        role,
        is_active: data?.is_active ?? true,
        approval_status: data?.approval_status ?? null,
        teacher_id,
        student_id: role === "student" ? user.uid : null,
      });

      // best effort: never block navigation on the push token
      registerForPushNotifications()
        .then((token) => {
          if (token) savePushToken(user.uid, role, token);
        })
        .catch(() => {});

      navigation.replace(role === "teacher" ? "TeacherDashboard" : "StudentDashboard");
    } catch (e: any) {
      if (!alive.current) return;
      const offline = /network|unavailable|offline/i.test(String(e?.code || e?.message || ""));
      setPhase({
        kind: "error",
        message: offline
          ? "Could not reach the server. Check your internet connection and try again."
          : "We could not load your account. Please try again.",
      });
    }
  }, [navigation, toAuth]);

  useEffect(() => {
    alive.current = true;
    init();
    return () => {
      alive.current = false;
    };
  }, [init]);

  const signOutBtn = (
    <Button
      label="Sign out"
      icon="log-out-outline"
      variant="secondary"
      onPress={async () => {
        await signOutAndClear();
        toAuth();
      }}
    />
  );

  return (
    <Screen>
      {phase.kind === "loading" && (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 28 }}>
          <Logo width={220} />
          <ActivityIndicator size="large" color={T.primary} />
        </View>
      )}
      {phase.kind === "inactive" && (
        <ResultView
          icon="lock-closed"
          tone="danger"
          title="Account disabled"
          message="Your account is currently inactive. Please contact your institute administrator."
          actions={signOutBtn}
        />
      )}
      {phase.kind === "pending" && (
        <ResultView
          icon="time"
          tone="warning"
          title="Waiting for approval"
          message="Your registration has been received. You can sign in once your institute approves it."
          actions={
            <>
              <Button label="Check again" icon="refresh" onPress={init} />
              {signOutBtn}
            </>
          }
        />
      )}
      {phase.kind === "rejected" && (
        <ResultView
          icon="close-circle"
          tone="danger"
          title="Registration not approved"
          message="Your registration was not approved. Please contact your institute."
          actions={signOutBtn}
        />
      )}
      {phase.kind === "error" && (
        <ResultView
          icon="cloud-offline"
          tone="danger"
          title="Something went wrong"
          message={phase.message}
          actions={
            <>
              <Button label="Try again" icon="refresh" onPress={init} />
              {signOutBtn}
            </>
          }
        />
      )}
    </Screen>
  );
}