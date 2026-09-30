import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  Animated,
  Share,
  StatusBar,
  RefreshControl,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getUserSession, updateSessionProfile, clearSession } from "../../../services/session";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";

// ─── Constants ────────────────────────────────────────────────────────────────
const { width: SCREEN_W } = Dimensions.get("window");
const CARD_W = SCREEN_W - 40;

const PRIMARY      = "#4834D4";
const PRIMARY_SOFT = "#EEF2FF";
const INDIGO_DARK  = "#1e1b4b";
const ACCENT       = "#7C3AED";
const GREEN        = "#10B981";
const AMBER        = "#F59E0B";
const RED          = "#EF4444";
const BG           = "#F3F4F6";  // matches TeacherAttendance / TeacherQuizzes
const WHITE        = "#FFFFFF";
const GREY         = "#6B7280";
const DARK         = "#111827";

const API_URL = "http://10.132.90.56:5000";

// ─── Sub-components ───────────────────────────────────────────────────────────

function InfoRow({ icon, label, value }: { icon: any; label: string; value: string }) {
  if (!value || value === "null" || value === "undefined") return null;
  return (
    <View style={S.infoRow}>
      <View style={S.infoIconWrap}>
        <Ionicons name={icon} size={15} color={PRIMARY} />
      </View>
      <View style={S.infoText}>
        <Text style={S.infoLabel}>{label}</Text>
        <Text style={S.infoValue}>{value}</Text>
      </View>
    </View>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <View style={S.sectionHeader}>
      <View style={S.sectionDot} />
      <Text style={S.sectionTitle}>{title}</Text>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function TeacherProfile() {
  const navigation = useNavigation<any>();
  const [profile, setProfile]     = useState<any>(null);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [teacherId, setTeacherId] = useState<string>("");

  // Animations
  const cardAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // ── Load profile ──────────────────────────────────────────────────────
  const loadProfile = useCallback(async (isRefresh = false) => {
    try {
      if (!isRefresh) setLoading(true);

      const session = await getUserSession();
      if (!session?.teacher_id) return;

      const tid = session.teacher_id;
      setTeacherId(tid);

      //  Fetch fresh data from backend
      const [profileRes] = await Promise.all([
        fetch(`${API_URL}/api/profile/teacher/${tid}`),
      ]);

      if (profileRes.ok) {
        const profileJson = await profileRes.json();
        if (profileJson.success && profileJson.profile) {
          setProfile(profileJson.profile);
          await updateSessionProfile(profileJson.profile);
        }
      } else if (session.profile) {
        setProfile(session.profile);
      }
    } catch (e) {
      console.log("TEACHER PROFILE LOAD ERROR:", e);
      try {
        const session = await getUserSession();
        if (session?.profile)     setProfile(session.profile);
        if (session?.teacher_id)  setTeacherId(session.teacher_id);
      } catch (_) {}
    } finally {
      setLoading(false);
      setRefreshing(false);

      Animated.parallel([
        Animated.spring(cardAnim, { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]).start();
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadProfile();
    }, [loadProfile])
  );

  // ── Logout ────────────────────────────────────────────────────────────
  const handleLogout = () => {
    Alert.alert(
      "Log Out",
      "Are you sure you want to log out?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Log Out",
          style: "destructive",
          onPress: async () => {
            await clearSession();
            // Navigate back to auth/login — adjust route name to match your navigator
            navigation.reset({ index: 0, routes: [{ name: "Login" as never }] });
          },
        },
      ]
    );
  };

  // ── Share profile ─────────────────────────────────────────────────────
  const handleShare = async () => {
    if (!profile) return;
    try {
      await Share.share({
        message: `Teacher Profile\nName: ${profile.first_name} ${profile.last_name}\nDesignation: ${profile.designation}\nDepartments: ${(profile.departments || []).join(", ")}`,
      });
    } catch (e) {
      console.log("SHARE ERROR:", e);
    }
  };

  // ── Avatar initials ───────────────────────────────────────────────────
  const getInitials = () => {
    if (!profile) return "T";
    const f = profile.first_name?.[0] || "";
    const l = profile.last_name?.[0]  || "";
    return (f + l).toUpperCase() || "T";
  };

  const fullName = profile
    ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim()
    : "";

  // ── Loading state ─────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.loader}>
          <ActivityIndicator size="large" color={PRIMARY} />
          <Text style={S.loadingText}>Loading profile…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!profile) {
    return (
      <SafeAreaView style={S.safe}>
        <View style={S.loader}>
          <Ionicons name="person-circle-outline" size={64} color={GREY} />
          <Text style={S.emptyTitle}>Profile not found</Text>
          <Text style={S.emptySubtitle}>Please contact your institution.</Text>
          <TouchableOpacity style={S.retryBtn} onPress={() => loadProfile()}>
            <Text style={S.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <StatusBar barStyle="dark-content" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={S.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadProfile(true); }}
            colors={[PRIMARY]}
            tintColor={PRIMARY}
          />
        }
      >
        {/* ── HEADER ──────────────────────────────────────────────────── */}
        <View style={S.header}>
          <View>
            <Text style={S.headerTitle}>My Profile</Text>
            <Text style={S.headerSub}>Manage your account</Text>
          </View>
          <TouchableOpacity style={S.shareBtn} onPress={handleShare}>
            <Ionicons name="share-outline" size={20} color={PRIMARY} />
          </TouchableOpacity>
        </View>

        {/* ── ID CARD ─────────────────────────────────────────────────── */}
        <Animated.View
          style={[
            S.idCard,
            {
              opacity: fadeAnim,
              transform: [{
                translateY: cardAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [30, 0],
                }),
              }],
            },
          ]}
        >
          {/* Strip */}
          <View style={S.cardStrip}>
            <View style={S.cardStripDots}>
              {[0, 1, 2, 3, 4].map((i) => (
                <View key={i} style={[S.stripDot, { opacity: 0.15 + i * 0.17 }]} />
              ))}
            </View>
            <Text style={S.cardInstitution} numberOfLines={1}>
              {profile.aishe_code ? `AISHE: ${profile.aishe_code}` : "Institution"}
            </Text>
            <Text style={S.cardType}>FACULTY ID</Text>
          </View>

          {/* Body */}
          <View style={S.cardBody}>
            {/* Avatar */}
            <View style={S.avatarWrap}>
              <View style={S.avatarRing}>
                <View style={S.avatar}>
                  <Text style={S.avatarText}>{getInitials()}</Text>
                </View>
              </View>
              {profile.approval_status === "approved" && (
                <View style={S.verifiedBadge}>
                  <Ionicons name="checkmark" size={10} color={WHITE} />
                </View>
              )}
            </View>

            <Text style={S.cardName}>{fullName}</Text>
            <Text style={S.cardDesignation}>{profile.designation || "Teacher"}</Text>

            {/* Department pills */}
            {Array.isArray(profile.departments) && profile.departments.length > 0 && (
              <View style={S.pillsRow}>
                {profile.departments.map((dep: string, i: number) => (
                  <View key={i} style={S.pill}>
                    <Text style={S.pillText}>{dep}</Text>
                  </View>
                ))}
              </View>
            )}

            <View style={S.cardDivider} />

            <View style={S.cardFooter}>
              <Ionicons name="shield-checkmark-outline" size={13} color={GREY} />
              <Text style={S.cardUidText} numberOfLines={1}>
                ID: {teacherId.slice(0, 10)}…
              </Text>
              <View style={[S.activeDot, {
                backgroundColor: profile.approval_status === "approved" ? GREEN : AMBER,
              }]} />
              <Text style={[S.activeText, {
                color: profile.approval_status === "approved" ? GREEN : AMBER,
              }]}>
                {profile.approval_status === "approved" ? "Approved" : "Pending"}
              </Text>
            </View>
          </View>
        </Animated.View>

        {/* ── PERSONAL DETAILS ────────────────────────────────────────── */}
        <Animated.View style={[S.detailsCard, { opacity: fadeAnim }]}>
          <SectionHeader title="Personal Information" />
          <InfoRow icon="person-outline"  label="Full Name"   value={fullName} />
          <InfoRow icon="call-outline"    label="Phone"       value={profile.contact_phone} />
          <InfoRow icon="mail-outline"    label="Email"       value={profile.email || "—"} />
          <InfoRow
            icon="male-female-outline"
            label="Gender"
            value={profile.gender
              ? profile.gender.charAt(0).toUpperCase() + profile.gender.slice(1)
              : ""}
          />
        </Animated.View>

        {/* ── PROFESSIONAL DETAILS ────────────────────────────────────── */}
        <Animated.View style={[S.detailsCard, { opacity: fadeAnim }]}>
          <SectionHeader title="Professional Details" />
          <InfoRow icon="briefcase-outline"  label="Designation"   value={profile.designation} />
          <InfoRow icon="barcode-outline"    label="AISHE Code"    value={profile.aishe_code} />

          {/* Departments list */}
          {Array.isArray(profile.departments) && profile.departments.length > 0 && (
            <View style={S.infoRow}>
              <View style={S.infoIconWrap}>
                <Ionicons name="library-outline" size={15} color={PRIMARY} />
              </View>
              <View style={S.infoText}>
                <Text style={S.infoLabel}>Departments</Text>
                <View style={S.subjectGrid}>
                  {profile.departments.map((dep: string, i: number) => (
                    <View key={i} style={S.subjectChip}>
                      <Text style={S.subjectChipText}>{dep}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          )}
        </Animated.View>

        {/* ── STATUS FOOTER ───────────────────────────────────────────── */}
        <Animated.View
          style={[
            S.statusCard,
            {
              opacity: fadeAnim,
              backgroundColor: profile.approval_status === "approved" ? "#F0FDF4" : "#FFFBEB",
              borderColor:     profile.approval_status === "approved" ? "#A7F3D0" : "#FDE68A",
            },
          ]}
        >
          <View style={S.statusRow}>
            <Ionicons
              name={profile.approval_status === "approved" ? "shield-checkmark" : "time-outline"}
              size={20}
              color={profile.approval_status === "approved" ? GREEN : AMBER}
            />
            <Text style={[S.statusText, {
              color: profile.approval_status === "approved" ? GREEN : AMBER,
            }]}>
              {profile.approval_status === "approved" ? "Verified Faculty Member" : "Awaiting Admin Approval"}
            </Text>
          </View>
          <Text style={S.statusSub}>
            Your identity is securely managed by the institution
          </Text>
        </Animated.View>

        {/* ── LOGOUT BUTTON ───────────────────────────────────────────── */}
        <Animated.View style={{ opacity: fadeAnim }}>
          <TouchableOpacity style={S.logoutBtn} onPress={handleLogout} activeOpacity={0.85}>
            <Ionicons name="log-out-outline" size={20} color={RED} />
            <Text style={S.logoutText}>Log Out</Text>
          </TouchableOpacity>
        </Animated.View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: BG },
  scroll:        { paddingHorizontal: 20, paddingBottom: 20 },
  loader:        { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  loadingText:   { fontSize: 14, color: GREY, fontWeight: "600" },
  emptyTitle:    { fontSize: 18, fontWeight: "800", color: DARK, marginTop: 8 },
  emptySubtitle: { fontSize: 14, color: GREY },
  retryBtn:      { marginTop: 16, backgroundColor: PRIMARY, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 50 },
  retryText:     { color: WHITE, fontWeight: "700", fontSize: 14 },

  // Header
  header:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 16, marginBottom: 20 },
  headerTitle: { fontSize: 28, fontWeight: "800", color: DARK, letterSpacing: 0.2 },
  headerSub:   { fontSize: 14, color: GREY, marginTop: 2 },
  shareBtn:    { width: 40, height: 40, borderRadius: 12, backgroundColor: PRIMARY_SOFT, justifyContent: "center", alignItems: "center" },

  // ID Card
  idCard: {
    width: CARD_W,
    borderRadius: 24,
    backgroundColor: WHITE,
    marginBottom: 16,
    overflow: "hidden",
    shadowColor: PRIMARY,
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
    borderWidth: 1,
    borderColor: "#E0E7FF",
  },
  cardStrip: {
    backgroundColor: PRIMARY,
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    overflow: "hidden",
  },
  cardStripDots:   { position: "absolute", left: 0, top: 0, bottom: 0, flexDirection: "row", alignItems: "center", paddingLeft: 12, gap: 6 },
  stripDot:        { width: 28, height: 28, borderRadius: 14, backgroundColor: WHITE },
  cardInstitution: { flex: 1, fontSize: 12, fontWeight: "700", color: "rgba(255,255,255,0.85)", letterSpacing: 0.3, marginLeft: 8 },
  cardType:        { fontSize: 11, fontWeight: "800", color: WHITE, letterSpacing: 1.5, backgroundColor: "rgba(255,255,255,0.2)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },

  cardBody:    { alignItems: "center", padding: 24, paddingTop: 20 },
  avatarWrap:  { position: "relative", marginBottom: 12 },
  avatarRing:  { width: 80, height: 80, borderRadius: 40, borderWidth: 3, borderColor: PRIMARY, padding: 3 },
  avatar:      { flex: 1, borderRadius: 36, backgroundColor: PRIMARY_SOFT, justifyContent: "center", alignItems: "center" },
  avatarText:  { fontSize: 26, fontWeight: "800", color: PRIMARY },
  verifiedBadge: { position: "absolute", bottom: 2, right: 2, width: 20, height: 20, borderRadius: 10, backgroundColor: GREEN, justifyContent: "center", alignItems: "center", borderWidth: 2, borderColor: WHITE },

  cardName:        { fontSize: 20, fontWeight: "800", color: DARK, letterSpacing: 0.2, textAlign: "center" },
  cardDesignation: { fontSize: 13, fontWeight: "600", color: GREY, marginTop: 2, marginBottom: 12 },

  pillsRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, marginBottom: 16 },
  pill:     { backgroundColor: PRIMARY_SOFT, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20 },
  pillText: { fontSize: 12, fontWeight: "700", color: PRIMARY },

  cardDivider: { width: "100%", height: 1, backgroundColor: "#E5E7EB", marginBottom: 12 },
  cardFooter:  { flexDirection: "row", alignItems: "center", gap: 5 },
  cardUidText: { fontSize: 11, color: GREY, fontFamily: "monospace" as any, flex: 1 },
  activeDot:   { width: 6, height: 6, borderRadius: 3, backgroundColor: GREEN },
  activeText:  { fontSize: 11, fontWeight: "700", color: GREEN },


  // Details
  detailsCard:  { backgroundColor: WHITE, borderRadius: 20, padding: 18, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB", shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 8, elevation: 2 },
  sectionHeader:{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 },
  sectionDot:   { width: 4, height: 18, borderRadius: 2, backgroundColor: PRIMARY },
  sectionTitle: { fontSize: 14, fontWeight: "800", color: DARK, letterSpacing: 0.2 },

  infoRow:      { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  infoIconWrap: { width: 30, height: 30, borderRadius: 8, backgroundColor: PRIMARY_SOFT, justifyContent: "center", alignItems: "center", marginTop: 1 },
  infoText:     { flex: 1 },
  infoLabel:    { fontSize: 11, fontWeight: "700", color: GREY, textTransform: "uppercase", letterSpacing: 0.5 },
  infoValue:    { fontSize: 14, fontWeight: "600", color: DARK, marginTop: 2 },

  subjectGrid:    { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 6 },
  subjectChip:    { backgroundColor: PRIMARY_SOFT, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: "#C7D2FE" },
  subjectChipText:{ fontSize: 12, fontWeight: "700", color: PRIMARY },

  // Status
  statusCard: { borderRadius: 18, padding: 16, borderWidth: 1, alignItems: "center", gap: 6, marginBottom: 12 },
  statusRow:  { flexDirection: "row", alignItems: "center", gap: 8 },
  statusText: { fontSize: 14, fontWeight: "800" },
  statusSub:  { fontSize: 12, color: GREY, textAlign: "center" },

  // Logout
  logoutBtn:  { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: "#FEF2F2", borderRadius: 18, paddingVertical: 16, borderWidth: 1, borderColor: "#FECACA" },
  logoutText: { fontSize: 15, fontWeight: "700", color: "#EF4444" },
});