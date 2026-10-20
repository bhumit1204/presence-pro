import { apiFetch, API_BASE } from "../../../services/api";
import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Share, RefreshControl, Modal, Pressable, Alert,
} from "react-native";
import { getUserSession, updateSessionProfile, signOutAndClear } from "../../../services/session";
import { Ionicons } from "@expo/vector-icons";
import QRCode from "react-native-qrcode-svg";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Avatar, Button, Card, Chip, Header, ProgressBar, Screen, SectionLabel, SP, T, font } from "../../../components/ui";

const API_URL = API_BASE;

// ─── Semester progress ───────────────────────────────────────────────────────
type SemProgress = {
  status: "active" | "ended" | "not_started" | "not_set" | "completed";
  semester: number | null;
  total_semesters?: number;
  start_date?: string | null;
  end_date?: string | null;
  days_left?: number;
  days_until_start?: number | null;
  elapsed_days?: number;
  total_days?: number;
  percent?: number;
};

const shortDate = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

function SemesterCard({ p }: { p: SemProgress }) {
  if (!p || p.status === "not_set" || !p.semester) return null;

  const pct = p.status === "completed" || p.status === "ended" ? 100 : p.percent ?? 0;
  const of = p.total_semesters && p.status !== "completed" ? ` of ${p.total_semesters}` : "";
  const note =
    p.status === "active"
      ? p.days_left === 0 ? "Last day of the semester" : `${p.days_left} day${p.days_left === 1 ? "" : "s"} left`
      : p.status === "ended"
        ? "Semester finished. The next one starts soon."
        : p.status === "completed"
          ? "Course completed"
          : p.days_until_start != null
            ? `Starts in ${p.days_until_start} day${p.days_until_start === 1 ? "" : "s"}`
            : "";

  return (
    <Card style={S.semCard}>
      <View style={S.semTop}>
        <View style={{ flex: 1 }}>
          <Text style={font.label}>Semester progress</Text>
          <Text style={[font.h2, { marginTop: 2 }]}>Semester {p.semester}{of}</Text>
        </View>
        <Chip label={`${pct}%`} tone={p.status === "ended" || p.status === "completed" ? "success" : "primary"} />
      </View>
      <View style={{ marginTop: SP.md }}>
        <ProgressBar value={pct / 100} tone={p.status === "ended" || p.status === "completed" ? "success" : "primary"} height={10} />
      </View>
      <View style={S.semDates}>
        <Text style={font.small}>{shortDate(p.start_date)}</Text>
        <Text style={[font.small, { fontWeight: "700", color: T.ink }]}>{note}</Text>
        <Text style={font.small}>{shortDate(p.end_date)}</Text>
      </View>
    </Card>
  );
}

// ─── Sub-Components ──────────────────────────────────────────────────────────
const InfoRow = ({ icon, label, value, isLast = false }: { icon: any; label: string; value: string; isLast?: boolean }) => {
  if (!value || value === "null") return null;
  return (
    <View style={[S.infoRow, isLast && { borderBottomWidth: 0 }]}>
      <View style={S.iconBox}>
        <Ionicons name={icon} size={18} color={T.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={font.label}>{label}</Text>
        <Text style={S.infoValue}>{value}</Text>
      </View>
    </View>
  );
};

export default function StudentProfile() {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uid, setUid] = useState<string>("");
  const [qrZoom, setQrZoom] = useState(false);
  const [semProgress, setSemProgress] = useState<SemProgress | null>(null);
  const [division, setDivision] = useState<{ current: { division_id: string; name: string } | null; options: { division_id: string; name: string }[]; can_choose: boolean } | null>(null);
  const [divPicker, setDivPicker] = useState(false);
  const [divSaving, setDivSaving] = useState(false);
  const navigation = useNavigation<any>();

  const handleLogout = () => {
    Alert.alert("Log out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log out",
        style: "destructive",
        onPress: async () => {
          await signOutAndClear();
          navigation.reset({
            index: 0,
            routes: [{ name: "Auth" }],
          });
        },
      },
    ]);
  };

  const chooseDivision = (d: { division_id: string; name: string }) => {
    Alert.alert(`Join division ${d.name}?`, "You can set this only once. If it is wrong, your head teacher can change it.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Confirm",
        onPress: async () => {
          if (divSaving) return;
          setDivSaving(true);
          try {
            const res = await apiFetch(`${API_URL}/api/profile/student/${uid}/division`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ division_id: d.division_id }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.success) {
              Alert.alert("Could not save", json.error || "Something went wrong. Please try again.");
            } else {
              setDivPicker(false);
              setDivision((x) => (x ? { ...x, current: { division_id: d.division_id, name: d.name }, can_choose: false } : x));
              loadProfile(true);
            }
          } catch {
            Alert.alert("Could not save", "Could not reach the server. Please try again.");
          } finally {
            setDivSaving(false);
          }
        },
      },
    ]);
  };

  const loadProfile = useCallback(async (isRefresh = false) => {
    try {
      if (!isRefresh) setLoading(true);
      const session = await getUserSession();
      if (!session?.uid) return;
      setUid(session.uid);

      const profileRes = await apiFetch(`${API_URL}/api/profile/student/${session.uid}`);
      if (profileRes.ok) {
        const json = await profileRes.json();
        if (json.success) {
          setProfile(json.profile);
          await updateSessionProfile(json.profile);
        }
      } else if (session.profile) {
        setProfile(session.profile);
      }

      // division is a nice-to-have too
      try {
        const dr = await apiFetch(`${API_URL}/api/profile/student/${session.uid}/divisions`);
        if (dr.ok) {
          const dj = await dr.json();
          if (dj.success) setDivision({ current: dj.current, options: dj.options || [], can_choose: !!dj.can_choose });
        }
      } catch {}

      // semester progress is a nice-to-have: never block or fail the profile because of it
      try {
        const semRes = await apiFetch(`${API_URL}/api/profile/student/${session.uid}/semester`);
        if (semRes.ok) {
          const sj = await semRes.json();
          if (sj.success) setSemProgress(sj.progress);
        }
      } catch {}
    } catch (e) {
      const session = await getUserSession();
      if (session?.profile) setProfile(session.profile);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadProfile(); }, [loadProfile]));

  const shareId = () => {
    const shareMessage = [
      `STUDENT DIGITAL ID`,
      `--------------------------`,
      `Name: ${profile?.name}`,
      `Roll No: ${profile?.roll_no}`,
      `Course: ${profile?.course_name}`,
      `Year: ${profile?.year || "N/A"}`,
      `College: ${profile?.college_name}`,
      `--------------------------`,
      `Verified via Digital Portal`,
    ].join("\n");

    Share.share({
      title: "Student Profile Details",
      message: shareMessage,
    });
  };

  if (loading) return (
    <Screen edges={["top"]}>
      <View style={S.center}>
        <ActivityIndicator color={T.primary} size="large" />
      </View>
    </Screen>
  );

  const qrPayload = JSON.stringify({ uid, type: "student_id" });

  return (
    <Screen edges={["top"]}>
      <Header
        title="Student profile"
        onBack={() => navigation.goBack()}
        right={
          <TouchableOpacity style={S.iconBtn} onPress={shareId} accessibilityLabel="Share ID">
            <Ionicons name="share-social-outline" size={19} color={T.ink} />
          </TouchableOpacity>
        }
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={S.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadProfile(true)} colors={[T.primary]} />}
      >
        {/* ID card */}
        <Card style={S.idCard}>
          <View style={S.idTop}>
            <View>
              <Avatar name={profile?.name || "Student"} initials tone="primary" size={60} />
              {profile?.approval_status === "approved" && (
                <View style={S.verifiedDot}>
                  <Ionicons name="checkmark" size={10} color="#FFF" />
                </View>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={font.h1} numberOfLines={2}>{profile?.name}</Text>
              <Text style={[font.body, { marginTop: 2 }]}>Roll no. {profile?.roll_no}</Text>
              <View style={S.chipRow}>
                {!!profile?.course_name && <Chip label={profile.course_name} tone="primary" />}
                {profile?.approval_status === "approved" && <Chip label="Verified" tone="success" icon="shield-checkmark-outline" />}
              </View>
            </View>
          </View>

          <Pressable style={S.qrSection} onPress={() => setQrZoom(true)}>
            <View style={S.qrBg}>
              <QRCode value={qrPayload} size={176} color={T.ink} backgroundColor="transparent" />
            </View>
            <View style={S.zoomHint}>
              <Ionicons name="expand-outline" size={13} color={T.primary} />
              <Text style={S.zoomText}>Tap to enlarge</Text>
            </View>
          </Pressable>
        </Card>

        {/* Semester progress */}
        {semProgress && <SemesterCard p={semProgress} />}

        {/* Contact */}
        <SectionLabel style={S.sectionGap}>Contact</SectionLabel>
        <Card flat padded={false} style={S.listCard}>
          <InfoRow icon="person-outline" label="Full name" value={profile?.name} />
          <InfoRow icon="mail-outline" label="Email" value={profile?.email} />
          <InfoRow icon="call-outline" label="Phone" value={profile?.phone} />
          <InfoRow icon="ribbon-outline" label="University" value={profile?.university_name} isLast />
        </Card>

        {/* Academic */}
        <SectionLabel style={S.sectionGap}>Academic</SectionLabel>
        <Card flat padded={false} style={S.listCard}>
          <InfoRow icon="business-outline" label="Institution" value={profile?.college_name} />
          <InfoRow icon="book-outline" label="Course" value={profile?.course_name} />
          <InfoRow icon="layers-outline" label="Semester" value={profile?.semester ? `Semester ${String(profile.semester).replace(/[^0-9]/g, "") || profile.semester}` : "N/A"} />
          <InfoRow icon="calendar-outline" label="Academic year" value={profile?.year} />
          {division?.current ? (
            <InfoRow icon="people-outline" label="Division" value={division.current.name} />
          ) : division?.can_choose ? (
            <TouchableOpacity style={S.infoRow} activeOpacity={0.7} onPress={() => setDivPicker(true)}>
              <View style={S.iconBox}>
                <Ionicons name="people-outline" size={18} color={T.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={font.label}>Division</Text>
                <Text style={[S.infoValue, { color: T.primary }]}>Not chosen yet. Tap to choose</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={T.muted} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={[S.infoRow, { borderBottomWidth: 0 }]} activeOpacity={0.7} onPress={() => navigation.navigate("ElectiveSelection")}>
            <View style={S.iconBox}>
              <Ionicons name="library-outline" size={18} color={T.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={font.label}>Electives</Text>
              <Text style={S.infoValue}>View or choose your electives</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={T.muted} />
          </TouchableOpacity>
        </Card>

        <Button
          label="Log out"
          icon="log-out-outline"
          variant="dangerSoft"
          onPress={handleLogout}
          style={{ marginTop: SP.xxl }}
        />
        <View style={{ height: SP.xxl }} />
      </ScrollView>

      {/* QR zoom */}
      <Modal visible={divPicker} transparent animationType="fade" onRequestClose={() => setDivPicker(false)}>
        <Pressable style={S.divOverlay} onPress={() => !divSaving && setDivPicker(false)}>
          <Pressable style={S.divSheet} onPress={() => {}}>
            <Text style={font.h2}>Choose your division</Text>
            <Text style={[font.small, { marginTop: 4, marginBottom: SP.md }]}>Your timetable and attendance follow your division.</Text>
            {(division?.options || []).map((d) => (
              <TouchableOpacity key={d.division_id} style={S.divOption} disabled={divSaving} activeOpacity={0.8} onPress={() => chooseDivision(d)}>
                <Text style={font.h3}>Division {d.name}</Text>
                <Ionicons name="chevron-forward" size={18} color={T.muted} />
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={{ alignSelf: "center", padding: SP.md }} onPress={() => setDivPicker(false)} disabled={divSaving}>
              <Text style={[font.small, { fontWeight: "700" }]}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={qrZoom} transparent animationType="fade" onRequestClose={() => setQrZoom(false)}>
        <Pressable style={S.modalOverlay} onPress={() => setQrZoom(false)}>
          <View style={S.modalContent}>
            <Text style={font.h1}>{profile?.name}</Text>
            <Text style={[font.body, { marginTop: 2, marginBottom: SP.xl }]}>Scan for student verification</Text>
            <View style={S.modalQr}>
              <QRCode value={qrPayload} size={270} color={T.ink} backgroundColor="#FFF" />
            </View>
            <Button label="Close" onPress={() => setQrZoom(false)} style={{ alignSelf: "stretch", marginTop: SP.xl }} />
          </View>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const S = StyleSheet.create({
  divOverlay: { flex: 1, backgroundColor: "rgba(15,23,42,0.55)", justifyContent: "flex-end" },
  divSheet: { backgroundColor: T.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: SP.xl, paddingBottom: SP.xxl },
  divOption: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 16, borderTopWidth: 1, borderTopColor: T.line },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  scroll: { padding: SP.xl, paddingBottom: SP.xxl },
  iconBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: T.surface, borderWidth: 1, borderColor: T.line, alignItems: "center", justifyContent: "center" },

  idCard:  { padding: SP.xl, borderRadius: 26 },
  idTop:   { flexDirection: "row", alignItems: "center", gap: SP.lg, marginBottom: SP.xl },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: SP.sm },
  verifiedDot: {
    position: "absolute", bottom: -3, right: -3, backgroundColor: T.success,
    borderRadius: 12, padding: 3, borderWidth: 3, borderColor: T.surface,
  },

  qrSection: { alignItems: "center" },
  qrBg:      { padding: SP.xl, backgroundColor: T.bg, borderRadius: 22 },
  zoomHint:  { flexDirection: "row", alignItems: "center", gap: 6, marginTop: SP.md, backgroundColor: T.primarySoft, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
  zoomText:  { fontSize: 11.5, fontWeight: "700", color: T.primary },

  semCard:  { marginTop: SP.lg, padding: SP.xl, borderRadius: 22 },
  semTop:   { flexDirection: "row", alignItems: "center", gap: SP.md },
  semDates: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: SP.sm, gap: SP.sm },

  sectionGap: { marginTop: SP.xxl },
  listCard:   { paddingHorizontal: SP.lg },
  infoRow:    { flexDirection: "row", alignItems: "center", gap: SP.md, paddingVertical: SP.md + 2, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  iconBox:    { width: 38, height: 38, borderRadius: 12, backgroundColor: T.primarySoft, justifyContent: "center", alignItems: "center" },
  infoValue:  { fontSize: 15, color: T.ink, fontWeight: "700", marginTop: 2 },

  modalOverlay: { flex: 1, backgroundColor: "rgba(15,23,42,0.88)", justifyContent: "center", alignItems: "center", padding: SP.xl },
  modalContent: { backgroundColor: T.surface, width: "100%", borderRadius: 32, padding: SP.xxl, alignItems: "center" },
  modalQr:      { padding: SP.xl, backgroundColor: "#FFF", borderRadius: 24, borderWidth: 1, borderColor: T.line },
});