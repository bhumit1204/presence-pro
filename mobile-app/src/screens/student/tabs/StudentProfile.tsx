import React, { useState, useCallback } from "react";
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
  Modal,
  Pressable,
  Alert
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getUserSession, updateSessionProfile, clearSession } from "../../../services/session";
import { Ionicons } from "@expo/vector-icons";
import QRCode from "react-native-qrcode-svg";
import { useFocusEffect } from "@react-navigation/native";
import { useNavigation } from "@react-navigation/native";

const { width: SCREEN_W } = Dimensions.get("window");

const PRIMARY = "#4834D4";
const PRIMARY_SOFT = "#EEF2FF";
const GREEN = "#10B981";
const BG = "#F8FAFC"; 
const WHITE = "#FFFFFF";
const GREY = "#64748B";
const DARK = "#1E293B";
const BORDER = "#E2E8F0";

// const API_URL = "http://10.132.90.56:5000";
const API_URL = "http://10.132.90.56:5000";

// ─── Sub-Components ──────────────────────────────────────────────────────────
const InfoRow = ({ icon, label, value, isLast = false }: { icon: any; label: string; value: string; isLast?: boolean }) => {
  if (!value || value === "null") return null;
  return (
    <View style={[S.infoRow, isLast && { borderBottomWidth: 0 }]}>
      <View style={S.iconBox}>
        <Ionicons name={icon} size={18} color={PRIMARY} />
      </View>
      <View style={S.infoContent}>
        <Text style={S.infoLabel}>{label}</Text>
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
  const navigation = useNavigation<any>();

  const handleLogout = () => {
  Alert.alert("Logout", "Are you sure you want to logout?", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Logout",
      style: "destructive",
      onPress: async () => {
        await clearSession();
        navigation.reset({
          index: 0,
          routes: [{ name: "Auth" }],
        });
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

      const profileRes = await fetch(`${API_URL}/api/profile/student/${session.uid}`);
      if (profileRes.ok) {
        const json = await profileRes.json();
        if (json.success) {
          setProfile(json.profile);
          await updateSessionProfile(json.profile);
        }
      } else if (session.profile) {
        setProfile(session.profile);
      }
    } catch (e) {
      const session = await getUserSession();
      if (session?.profile) setProfile(session.profile);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadProfile(); }, [loadProfile]));

  if (loading) return (
    <View style={[S.safe, S.center]}>
      <ActivityIndicator color={PRIMARY} size="large" />
    </View>
  );

  const qrPayload = JSON.stringify({ uid, type: "student_id" });

  return (
    <SafeAreaView style={S.safe} edges={["top"]}>
      <StatusBar barStyle="dark-content" />
      
      <ScrollView 
        showsVerticalScrollIndicator={false}
        contentContainerStyle={S.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadProfile(true)} />}
      >
        {/* Header */}
        <View style={S.header}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12,}}>
          <TouchableOpacity style={S.backBtn} onPress={() => navigation.goBack()}>
            <Text style={S.backIcon}>‹</Text>
          </TouchableOpacity>
          <Text style={S.headerTitle}>Student Profile</Text>
          </ View>
          <TouchableOpacity 
            style={S.iconBtn}
            onPress={() => {
              const shareMessage = [
                `STUDENT DIGITAL ID`,
                `--------------------------`,
                `Name: ${profile?.name}`,
                `Roll No: ${profile?.roll_no}`,
                `Course: ${profile?.course_name}`,
                `Year: ${profile?.year || 'N/A'}`,
                `College: ${profile?.college_name}`,
                `--------------------------`,
                `Verified via Digital Portal`
              ].join('\n');

              Share.share({
                title: 'Student Profile Details',
                message: shareMessage,
              });
            }}
          >
            <Ionicons name="share-social-outline" size={20} color={DARK} />
          </TouchableOpacity>
        </View>

        {/* Main ID Card with Enlarged QR */}
        <View style={S.mainCard}>
          <View style={S.cardHeader}>
            <View style={S.avatar}>
              <Text style={S.avatarText}>{profile?.name?.charAt(0)}</Text>
              {profile?.approval_status === "approved" && (
                <View style={S.verifiedDot}>
                  <Ionicons name="checkmark" size={10} color={WHITE} />
                </View>
              )}
            </View>
            <View style={S.cardHeaderText}>
              <Text style={S.cardName}>{profile?.name}</Text>
              <Text style={S.cardRoll}>Student Roll No: {profile?.roll_no}</Text>
            </View>
          </View>

          <Pressable style={S.qrSection} onPress={() => setQrZoom(true)}>
            <View style={S.qrBg}>
              <QRCode value={qrPayload} size={180} color={DARK} backgroundColor="transparent" />
            </View>
            <View style={S.zoomHint}>
              <Ionicons name="expand-outline" size={12} color={PRIMARY} />
              <Text style={S.zoomText}>TAP TO ENLARGE</Text>
            </View>
          </Pressable>
        </View>

        {/* Structured Row-based Info */}
        <Text style={[S.sectionHeading, { marginTop: 24 }]}>Contact & Registry</Text>
          <View style={S.listCard}>
            <InfoRow icon="person-outline" label="Full Name" value={profile?.name} />
            <InfoRow icon="mail-outline" label="Email Address" value={profile?.email} />
            <InfoRow icon="call-outline" label="Phone Number" value={profile?.phone} />
            <InfoRow icon="ribbon-outline" label="University" value={profile?.university_name} isLast />
          </View>

        <View style={S.infoContainer}>
          <Text style={S.sectionHeading}>Academic Details</Text>
          <View style={S.listCard}>
            <InfoRow icon="business-outline" label="Institution" value={profile?.college_name} />
            <InfoRow icon="book-outline" label="Course Name" value={profile?.course_name} />
            <InfoRow icon="layers-outline" label="Current Semester" value={profile?.semester ? `${profile.semester} Semester` : "N/A"} />
            <InfoRow icon="calendar-outline" label="Academic Year" value={profile?.year} isLast />
          </View>
        </View>

        <TouchableOpacity style={S.logoutBtn} onPress={handleLogout}>
        <Ionicons name="log-out-outline" size={20} color="#EF4444" />
        <Text style={S.logoutText}>Logout</Text>
      </TouchableOpacity>
      </ScrollView>

      {/* QR Zoom Modal */}
      <Modal visible={qrZoom} transparent animationType="fade">
        <Pressable style={S.modalOverlay} onPress={() => setQrZoom(false)}>
          <View style={S.modalContent}>
            <Text style={S.modalTitle}>{profile?.name}</Text>
            <Text style={S.modalSub}>Scan for Student Verification</Text>
            <View style={S.modalQr}>
               <QRCode value={qrPayload} size={280} color={DARK} backgroundColor={WHITE} />
            </View>
            <TouchableOpacity style={S.closeBtn} onPress={() => setQrZoom(false)}>
              <Text style={S.closeBtnText}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  center: { justifyContent: "center", alignItems: "center" },
  scroll: { padding: 20, paddingBottom: 40 },
  
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  headerTitle: { fontSize: 22, fontWeight: "800", color: DARK, letterSpacing: -0.5 },
  iconBtn: { padding: 8, backgroundColor: WHITE, borderRadius: 12, borderWidth: 1, borderColor: BORDER },

  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center", elevation: 2, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6 },
    backIcon:{ fontSize: 22, fontWeight: "700", color: PRIMARY },
  
  // Main Card Styling
  mainCard: {
    backgroundColor: WHITE,
    borderRadius: 32,
    padding: 24,
    borderWidth: 1,
    borderColor: BORDER,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 12,
    elevation: 3,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", marginBottom: 30 },
  avatar: { width: 60, height: 60, borderRadius: 20, backgroundColor: PRIMARY_SOFT, justifyContent: "center", alignItems: "center", position: "relative" },
  avatarText: { fontSize: 24, fontWeight: "bold", color: PRIMARY },
  verifiedDot: { position: "absolute", bottom: -2, right: -2, backgroundColor: GREEN, borderRadius: 12, padding: 3, borderWidth: 3, borderColor: WHITE },
  cardHeaderText: { marginLeft: 16 },
  cardName: { fontSize: 20, fontWeight: "800", color: DARK },
  cardRoll: { fontSize: 13, color: GREY, fontWeight: "600", marginTop: 2 },
  
  qrSection: { alignItems: "center" },
  qrBg: { padding: 20, backgroundColor: "#F1F5F9", borderRadius: 24 },
  zoomHint: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 16, backgroundColor: PRIMARY_SOFT, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
  zoomText: { fontSize: 10, fontWeight: "800", color: PRIMARY, letterSpacing: 1 },
  
  // Info Section Styling
  infoContainer: { marginTop: 32 },
  sectionHeading: { fontSize: 13, fontWeight: "800", color: GREY, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12, marginLeft: 4 },
  
  listCard: { backgroundColor: WHITE, borderRadius: 24, paddingHorizontal: 16, borderWidth: 1, borderColor: BORDER },
  infoRow: { flexDirection: "row", alignItems: "center", paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#F1F5F9" },
  iconBox: { width: 40, height: 40, borderRadius: 12, backgroundColor: PRIMARY_SOFT, justifyContent: "center", alignItems: "center" },
  infoContent: { marginLeft: 16, flex: 1 },
  infoLabel: { fontSize: 10, color: GREY, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
  infoValue: { fontSize: 15, color: DARK, fontWeight: "700", marginTop: 2 },

  // Modal Styling
  modalOverlay: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.9)", justifyContent: "center", alignItems: "center", padding: 20 },
  modalContent: { backgroundColor: WHITE, width: "100%", borderRadius: 40, padding: 30, alignItems: "center" },
  modalTitle: { fontSize: 22, fontWeight: "800", color: DARK, marginBottom: 4 },
  modalSub: { fontSize: 14, color: GREY, marginBottom: 30 },
  modalQr: { padding: 24, backgroundColor: WHITE, borderRadius: 24, shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 20, elevation: 10 },
  closeBtn: { marginTop: 40, paddingVertical: 14, paddingHorizontal: 50, backgroundColor: DARK, borderRadius: 20 },
  closeBtnText: { color: WHITE, fontWeight: "700", fontSize: 16 },
  logoutBtn: {
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  marginTop: 32,
  paddingVertical: 16,
  borderRadius: 20,
  borderWidth: 1.5,
  borderColor: "#FEE2E2",
  backgroundColor: "#FFF5F5",
},
logoutText: {
  fontSize: 15,
  fontWeight: "700",
  color: "#EF4444",
},
});