// src/screens/teacher/TeacherDashboard.tsx
// Tab shell for teachers (also used by hod / head_teacher). Four tabs: Today, Classes, Inbox, Profile.
// Tabs mount the first time they are opened and then stay mounted, so switching is instant and scroll
// positions survive. The inbox count (lecture requests + pending OD) is loaded here and shown as a badge.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import GlassBottomBar, { BarTab } from "../../components/GlassBottomBar";
import { TabContext } from "../../navigation/TabContext";
import { getUserSession } from "../../services/session";
import { T, initialsOf } from "../../components/ui";
import { InboxCtx, InboxState, LectureRequest, SwapState, TeacherCtx, TeacherInfo, enc, getJson, postJson } from "./teacherShared";
import TeacherToday from "./tabs/TeacherToday";
import TeacherClasses from "./tabs/TeacherClasses";
import TeacherInbox from "./tabs/TeacherInbox";
import TeacherProfile from "./tabs/TeacherProfile";

const BASE_TABS: BarTab[] = [
  { key: "today", label: "Today", icon: "calendar" },
  { key: "classes", label: "Classes", icon: "school" },
  { key: "inbox", label: "Inbox", icon: "notifications" },
  { key: "profile", label: "Profile", icon: "person" },
];

const SCREENS: Record<string, React.ComponentType> = {
  today: TeacherToday,
  classes: TeacherClasses,
  inbox: TeacherInbox,
  profile: TeacherProfile,
};

export default function TeacherDashboard() {
  const navigation = useNavigation<any>();
  const [teacher, setTeacher] = useState<TeacherInfo | null>(null);
  const [currentTab, setCurrentTab] = useState("today");
  const [visited, setVisited] = useState<string[]>(["today"]);

  const [requests, setRequests] = useState<LectureRequest[]>([]);
  const [sent, setSent] = useState<any[]>([]);
  const [swaps, setSwaps] = useState<SwapState>({ incoming: [], sent: [] });
  const [odPending, setOdPending] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* who is logged in */
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await getUserSession();
      if (!alive) return;
      if (!s?.uid) {
        navigation.reset({ index: 0, routes: [{ name: "Auth" }] });
        return;
      }
      const p = s.profile || {};
      const first = p.first_name || "";
      setTeacher({
        uid: s.uid,
        teacherId: s.teacher_id || "",
        firstName: first,
        name: `${first} ${p.last_name || ""}`.trim() || "Teacher",
        profile: p,
      });
    })();
    return () => {
      alive = false;
    };
  }, [navigation]);

  /* the session cache may not have the name yet: fetch it once so the initials are right */
  useEffect(() => {
    if (!teacher || teacher.firstName || !teacher.teacherId) return;
    let alive = true;
    getJson(`/api/profile/teacher/${enc(teacher.teacherId)}`)
      .then((j) => {
        const p = j.profile;
        if (!alive || !p) return;
        const first = p.first_name || "";
        setTeacher((prev) =>
          prev ? { ...prev, profile: p, firstName: first, name: `${first} ${p.last_name || ""}`.trim() || prev.name } : prev
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [teacher]);

  /* inbox data */
  const refresh = useCallback(async () => {
    if (!teacher) return;
    const [r, snt, od, sw] = await Promise.allSettled([
      getJson(`/api/lectures/assign/requests?uid=${enc(teacher.uid)}`),
      getJson(`/api/lectures/assign/sent?uid=${enc(teacher.uid)}`),
      teacher.teacherId ? getJson(`/api/od/teacher/${enc(teacher.teacherId)}?status=pending`) : Promise.resolve(null),
      getJson(`/api/lectures/swap/mine?uid=${enc(teacher.uid)}`),
    ]);
    if (sw.status === "fulfilled") setSwaps({ incoming: sw.value.incoming || [], sent: sw.value.sent || [] });
    if (r.status === "fulfilled") setRequests(r.value.requests || []);
    if (snt.status === "fulfilled") setSent((snt.value.assignments || []).filter((a: any) => a.status === "pending"));
    if (od.status === "fulfilled" && od.value) setOdPending(od.value.summary?.pending ?? (od.value.requests || []).length);
    const failed = [r, snt, od, sw].every((x) => x.status === "rejected");
    setError(failed ? "Could not refresh. Pull down to try again." : null);
    setLoaded(true);
  }, [teacher]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  // light polling while the shell is open
  useEffect(() => {
    if (!teacher) return;
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [teacher, refresh]);

  const respond = useCallback(
    async (id: string, action: "accept" | "reject") => {
      try {
        await postJson("/api/lectures/assign/respond", { uid: teacher!.uid, assignment_id: id, action });
        setRequests((p) => p.filter((x) => x.assignment_id !== id));
        return null;
      } catch (e: any) {
        return e?.message || "Could not respond to the request.";
      }
    },
    [teacher]
  );

  const respondSwap = useCallback(
    async (id: string, action: "accept" | "reject" | "cancel") => {
      try {
        await postJson("/api/lectures/swap/respond", { uid: teacher!.uid, swap_id: id, action });
        setSwaps((p) => ({
          incoming: p.incoming.filter((x) => x.swap_id !== id),
          sent: p.sent.map((x) => (x.swap_id === id && action === "cancel" ? { ...x, status: "cancelled" } : x)),
        }));
        if (action === "accept") refresh();
        return null;
      } catch (e: any) {
        refresh();
        return e?.message || "Could not respond to the request.";
      }
    },
    [teacher, refresh]
  );

  const inbox: InboxState = useMemo(
    () => ({ requests, sent, swaps, respondSwap, odPending, loaded, error, refresh, respond }),
    [requests, sent, swaps, respondSwap, odPending, loaded, error, refresh, respond]
  );

  /* tabs */
  const go = useCallback((key: string) => {
    setCurrentTab(key);
    setVisited((v) => (v.includes(key) ? v : [...v, key]));
  }, []);

  // Android back: any tab -> Today first, then exit.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (currentTab !== "today") {
          setCurrentTab("today");
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [currentTab])
  );

  const tabs = useMemo(
    () => BASE_TABS.map((x) => (x.key === "profile" && teacher?.name && teacher.name !== "Teacher" ? { ...x, initials: initialsOf(teacher.name) } : x)),
    [teacher?.name]
  );
  const badges = useMemo(() => ({ inbox: requests.length + swaps.incoming.length + odPending }), [requests.length, swaps.incoming.length, odPending]);
  const ctx = useMemo(() => ({ currentTab, setCurrentTab: go, badges }), [currentTab, go, badges]);

  if (!teacher) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={T.primary} />
      </View>
    );
  }

  return (
    <TeacherCtx.Provider value={teacher}>
      <InboxCtx.Provider value={inbox}>
        <TabContext.Provider value={ctx}>
          <View style={{ flex: 1, backgroundColor: T.bg }}>
            {tabs.map((t) => {
              if (!visited.includes(t.key)) return null;
              const Screen = SCREENS[t.key];
              const on = currentTab === t.key;
              return (
                <View
                  key={t.key}
                  style={{ flex: 1, display: on ? "flex" : "none" }}
                  accessibilityElementsHidden={!on}
                  importantForAccessibility={on ? "auto" : "no-hide-descendants"}
                >
                  <Screen />
                </View>
              );
            })}
            <GlassBottomBar tabs={tabs} badges={badges} />
          </View>
        </TabContext.Provider>
      </InboxCtx.Provider>
    </TeacherCtx.Provider>
  );
}