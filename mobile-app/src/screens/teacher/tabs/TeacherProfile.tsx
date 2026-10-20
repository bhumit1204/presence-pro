// src/screens/teacher/tabs/TeacherProfile.tsx
// Who you are, what you teach, and log out. Works for teachers, HODs and head teachers.
import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { getUserSession, signOutAndClear, updateSessionProfile } from "../../../services/session";
import { useOnTabActive, useTab } from "../../../navigation/TabContext";
import { Avatar, Banner, Button, Card, Chip, SectionLabel, T, SP, font } from "../../../components/ui";
import { Subject, enc, getJson, groupCourses, useTeacher } from "../teacherShared";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function Row({ icon, label, value }: { icon: IconName; label: string; value?: string | null }) {
  if (!value || value === "null" || value === "undefined") return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md, paddingVertical: 10 }}>
      <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: T.primarySoft, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={17} color={T.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={font.small}>{label}</Text>
        <Text style={[font.h3, { fontWeight: "600" }]} selectable>{value}</Text>
      </View>
    </View>
  );
}

const roleLabel = (raw?: string | null) => {
  const r = String(raw || "").toLowerCase().replace(/[\s-]/g, "_");
  if (r === "hod") return "Head of Department";
  if (r === "head_teacher") return "Head Teacher";
  return "Teacher";
};

export default function TeacherProfile() {
  const navigation = useNavigation<any>();
  const { setCurrentTab } = useTab();
  const teacher = useTeacher();
  const [profile, setProfile] = useState<any>(teacher.profile || null);
  const [rawRole, setRawRole] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(!teacher.profile);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const load = useCallback(async () => {
    const [p, s, sess] = await Promise.allSettled([
      getJson(`/api/profile/teacher/${enc(teacher.teacherId)}`),
      getJson(`/api/lectures/teachers/subjects?teacher_id=${enc(teacher.teacherId)}`),
      getUserSession(),
    ]);
    if (p.status === "fulfilled" && p.value.profile) {
      setProfile(p.value.profile);
      updateSessionProfile(p.value.profile);
      setError(null);
    } else if (!profile) {
      setError("Could not load your profile. Pull down to retry.");
    }
    if (s.status === "fulfilled") setSubjects(s.value.subjects || []);
    if (sess.status === "fulfilled") setRawRole(sess.value?.raw_role ?? null);
    setLoading(false);
    setRefreshing(false);
  }, [teacher.teacherId, profile]);

  useOnTabActive("profile", () => {
    load();
  });

  const courses = useMemo(() => groupCourses(subjects), [subjects]);

  const fullName = profile ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim() || teacher.name : teacher.name;
  const departments: string[] = Array.isArray(profile?.departments) ? profile.departments : [];
  const approved = profile?.approval_status ? profile.approval_status === "approved" : true;

  const replayGuide = async () => {
    try {
      await AsyncStorage.removeItem("tp_guide_seen_v1");
    } catch {}
    setCurrentTab("today");
  };

  const logout = () => {
    Alert.alert("Log out?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log out",
        style: "destructive",
        onPress: async () => {
          setLoggingOut(true);
          await signOutAndClear();
          navigation.reset({ index: 0, routes: [{ name: "Auth" }] });
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={T.primary} size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: T.bg }}
      contentContainerStyle={{ paddingHorizontal: SP.xl, paddingTop: SP.xxl + 24, paddingBottom: 140 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={T.primary} />}
    >
      <Text style={[font.h1, { marginBottom: SP.lg }]}>Profile</Text>
      {!!error && <Banner tone="danger" style={{ marginBottom: SP.lg }}>{error}</Banner>}

      {/* identity */}
      <Card flat style={{ alignItems: "center", paddingVertical: SP.xxl }}>
        <Avatar name={fullName} tone="primary" size={80} initials />
        <Text style={[font.h1, { marginTop: SP.md, textAlign: "center" }]}>{fullName}</Text>
        <Text style={[font.body, { marginTop: 2 }]}>{profile?.designation || roleLabel(rawRole)}</Text>
        <View style={{ flexDirection: "row", gap: SP.sm, marginTop: SP.md, flexWrap: "wrap", justifyContent: "center" }}>
          <Chip label={roleLabel(rawRole)} tone="primary" icon="ribbon-outline" />
          <Chip label={approved ? "Approved" : "Approval pending"} tone={approved ? "success" : "warning"} icon={approved ? "checkmark-circle" : "time-outline"} />
        </View>
      </Card>

      {/* teaching */}
      <SectionLabel style={{ marginTop: SP.xxl }}>What you teach</SectionLabel>
      <Card flat>
        {departments.length > 0 && (
          <View style={{ marginBottom: SP.md }}>
            <Text style={[font.small, { marginBottom: 6 }]}>Departments</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {departments.map((d) => (
                <Chip key={d} label={d} tone="info" />
              ))}
            </View>
          </View>
        )}
        {courses.length === 0 ? (
          <Text style={font.body}>No subjects yet</Text>
        ) : (
          courses.map((c, ci) => (
            <View key={c.course_id || c.course_name} style={{ marginTop: ci ? SP.md : 0 }}>
              <Text style={[font.small, { marginBottom: 4 }]}>{c.course_name}</Text>
              {c.subjects.map((s) => (
                <Pressable
                  key={s.subject_id}
                  onPress={() => navigation.navigate("SubjectHub", { subject: s, course: { course_id: c.course_id, course_name: c.course_name }, teacher_id: teacher.teacherId })}
                  accessibilityRole="button"
                  style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: SP.sm, paddingVertical: 9 }, pressed && { opacity: 0.6 }]}
                >
                  <Ionicons name="book-outline" size={16} color={T.primary} />
                  <Text style={[font.h3, { flex: 1, fontWeight: "600" }]} numberOfLines={1}>{s.subject_name}</Text>
                  <Text style={font.small}>{s.subject_code}</Text>
                  <Ionicons name="chevron-forward" size={15} color={T.muted} />
                </Pressable>
              ))}
            </View>
          ))
        )}
      </Card>

      {/* personal */}
      <SectionLabel style={{ marginTop: SP.xxl }}>Details</SectionLabel>
      <Card flat>
        <Row icon="person-outline" label="Full name" value={fullName} />
        <Row icon="mail-outline" label="Email" value={profile?.email} />
        <Row icon="call-outline" label="Phone" value={profile?.contact_phone} />
        <Row icon="briefcase-outline" label="Designation" value={profile?.designation} />
        <Row icon="male-female-outline" label="Gender" value={profile?.gender ? profile.gender.charAt(0).toUpperCase() + profile.gender.slice(1) : null} />
        <Row icon="business-outline" label="AISHE code" value={profile?.aishe_code} />
      </Card>
      <Text style={[font.small, { marginTop: SP.sm }]}>Managed by your admin</Text>

      {/* help + logout */}
      <View style={{ height: SP.xxl }} />
      <View style={{ gap: SP.sm }}>
        <Button label="App tour" icon="compass-outline" variant="ghost" onPress={replayGuide} />
        <Button label="Log out" icon="log-out-outline" variant="dangerSoft" onPress={logout} loading={loggingOut} />
      </View>
    </ScrollView>
  );
}