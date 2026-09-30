import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

const { width } = Dimensions.get("window");
const PRIMARY    = "#4834D4";
const BG_OVERLAY = "rgba(0,0,0,0.5)";
const OD_COLOR   = "#7C3AED";

// ─── Single methods ──────────────────────────────────────────────────────────
const METHODS = [
  {
    id:          "code",
    label:       "Digit Code",
    icon:        "keypad-outline",
    description: "Students enter a digit code",
    color:       "#EEF2FF",
    iconColor:   PRIMARY,
  },
  {
    id:          "bio_geo",
    label:       "Bio & Geofence",
    icon:        "finger-print-outline",
    description: "Biometric scan within location",
    color:       "#F0FDF4",
    iconColor:   "#10B981",
  },
  {
    id:          "qr",
    label:       "QR Code",
    icon:        "qr-code-outline",
    description: "Rotating QR on projector / screen",
    color:       "#FEF2F2",
    iconColor:   "#EF4444",
  },
  {
    id:          "iot",
    label:       "IoT Device",
    icon:        "wifi-outline",
    description: "Smart sensor based tracking",
    color:       "#FFF7ED",
    iconColor:   "#F59E0B",
  },
];

// ─── Valid combo pairs ────────────────────────────────────────────────────────
// Primary method is what the student tries first.
// Bio & Geofence is always the fallback (secondary).
const COMBO_PRIMARY_OPTIONS = [
  {
    id:          "code",
    label:       "Digit Code",
    icon:        "keypad-outline",
    color:       "#EEF2FF",
    iconColor:   PRIMARY,
  },
  {
    id:          "qr",
    label:       "QR Code",
    icon:        "qr-code-outline",
    color:       "#FEF2F2",
    iconColor:   "#EF4444",
  },
];

const COMBO_SECONDARY = {
  id:        "bio_geo",
  label:     "Bio & Geofence",
  icon:      "finger-print-outline",
  color:     "#F0FDF4",
  iconColor: "#10B981",
};

interface AttendanceModalProps {
  visible:        boolean;
  onClose:        () => void;
  onSelectMethod: (method: string) => void;
}

export default function AttendanceModal({
  visible,
  onClose,
  onSelectMethod,
}: AttendanceModalProps) {
  const [comboModalVisible, setComboModalVisible] = useState(false);
  const [selectedPrimary, setSelectedPrimary]     = useState<string | null>(null);

  const openComboModal = () => setComboModalVisible(true);

  const handleComboConfirm = () => {
    if (!selectedPrimary) return;
    // Format: "primary+secondary" e.g. "code+bio_geo" or "qr+bio_geo"
    onSelectMethod(`${selectedPrimary}+${COMBO_SECONDARY.id}`);
    setComboModalVisible(false);
    setSelectedPrimary(null);
  };

  const handleComboCancel = () => {
    setComboModalVisible(false);
    setSelectedPrimary(null);
  };

  return (
    <>
      {/* ═══════════════════════════════════════════════════════════════════
          Main modal — single method selection + combo entry point
      ═══════════════════════════════════════════════════════════════════ */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={visible}
        onRequestClose={onClose}
      >
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={S.overlay}>
            <TouchableWithoutFeedback>
              <View style={S.sheet}>

                {/* Handle */}
                <View style={S.handleWrap}>
                  <View style={S.handle} />
                </View>

                <Text style={S.title}>Start Attendance</Text>
                <Text style={S.subtitle}>Choose how students mark their presence</Text>

                {/* 2×2 grid — single methods */}
                <View style={S.grid}>
                  {METHODS.map((m) => (
                    <TouchableOpacity
                      key={m.id}
                      style={S.card}
                      activeOpacity={0.75}
                      onPress={() => onSelectMethod(m.id)}
                    >
                      <View style={[S.iconWrap, { backgroundColor: m.color }]}>
                        <Ionicons name={m.icon as any} size={26} color={m.iconColor} />
                      </View>
                      <Text style={S.methodLabel}>{m.label}</Text>
                      <Text style={S.methodDesc}>{m.description}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* ── Combo Mode banner ─────────────────────────────────── */}
                <TouchableOpacity
                  style={S.comboBanner}
                  activeOpacity={0.8}
                  onPress={openComboModal}
                >
                  {/* Left: icon stack showing two methods merging */}
                  <View style={S.comboIconStack}>
                    <View style={[S.comboIconBubble, { backgroundColor: "#EEF2FF", zIndex: 2 }]}>
                      <Ionicons name="keypad-outline" size={14} color={PRIMARY} />
                    </View>
                    <View style={[S.comboIconBubble, S.comboIconBubbleOverlap, { backgroundColor: "#FEF2F2" }]}>
                      <Ionicons name="qr-code-outline" size={14} color="#EF4444" />
                    </View>
                    <View style={[S.comboIconBubble, S.comboIconBubbleOverlap2, { backgroundColor: "#F0FDF4" }]}>
                      <Ionicons name="finger-print-outline" size={14} color="#10B981" />
                    </View>
                  </View>

                  {/* Text */}
                  <View style={S.comboTextWrap}>
                    <View style={S.comboTitleRow}>
                      <Text style={S.comboBannerTitle}>Combo Mode</Text>
                      <View style={S.comboBadge}>
                        <Text style={S.comboBadgeText}>NEW</Text>
                      </View>
                    </View>
                    <Text style={S.comboBannerDesc}>
                      Let students use Code or QR, with Bio as fallback
                    </Text>
                  </View>

                  <Ionicons name="chevron-forward" size={18} color={OD_COLOR} />
                </TouchableOpacity>

                <TouchableOpacity style={S.cancelBtn} onPress={onClose}>
                  <Text style={S.cancelTxt}>Cancel</Text>
                </TouchableOpacity>

              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* ═══════════════════════════════════════════════════════════════════
          Combo picker modal
      ═══════════════════════════════════════════════════════════════════ */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={comboModalVisible}
        onRequestClose={handleComboCancel}
      >
        <TouchableWithoutFeedback onPress={handleComboCancel}>
          <View style={S.overlay}>
            <TouchableWithoutFeedback>
              <View style={S.sheet}>

                {/* Handle */}
                <View style={S.handleWrap}>
                  <View style={S.handle} />
                </View>

                {/* Header */}
                <View style={S.comboModalHeader}>
                  <TouchableOpacity onPress={handleComboCancel} style={S.comboBackBtn}>
                    <Ionicons name="arrow-back" size={20} color="#374151" />
                  </TouchableOpacity>
                  <View style={{ flex: 1 }}>
                    <Text style={S.title}>Combo Mode</Text>
                    <Text style={S.subtitle} numberOfLines={1}>
                      Students try primary first, fallback to Bio
                    </Text>
                  </View>
                </View>

                {/* How it works info strip */}
                <View style={S.howItWorks}>
                  <Ionicons name="information-circle-outline" size={16} color={OD_COLOR} />
                  <Text style={S.howItWorksText}>
                    Student tries the primary method. If it doesn't work, they fall back to Bio & Geofence automatically.
                  </Text>
                </View>

                {/* Step 1 — pick primary */}
                <Text style={S.stepLabel}>
                  <Text style={S.stepNum}>Step 1 </Text>
                  Choose primary method
                </Text>

                <View style={S.comboPickerRow}>
                  {COMBO_PRIMARY_OPTIONS.map((m) => {
                    const isSelected = selectedPrimary === m.id;
                    return (
                      <TouchableOpacity
                        key={m.id}
                        style={[
                          S.comboPickerCard,
                          isSelected && S.comboPickerCardSelected,
                        ]}
                        activeOpacity={0.8}
                        onPress={() => setSelectedPrimary(m.id)}
                      >
                        <View style={[S.comboPickerIcon, { backgroundColor: m.color }]}>
                          <Ionicons name={m.icon as any} size={24} color={m.iconColor} />
                        </View>
                        <Text style={[S.comboPickerLabel, isSelected && S.comboPickerLabelSelected]}>
                          {m.label}
                        </Text>
                        {/* Selection tick */}
                        <View style={[S.comboTick, isSelected && S.comboTickSelected]}>
                          {isSelected && <Ionicons name="checkmark" size={11} color="#fff" />}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Step 2 — fallback (always Bio, shown statically) */}
                <Text style={[S.stepLabel, { marginTop: 20 }]}>
                  <Text style={S.stepNum}>Step 2 </Text>
                  Fallback method (fixed)
                </Text>

                <View style={S.comboFallbackCard}>
                  <View style={[S.comboPickerIcon, { backgroundColor: COMBO_SECONDARY.color }]}>
                    <Ionicons name={COMBO_SECONDARY.icon as any} size={24} color={COMBO_SECONDARY.iconColor} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={S.comboPickerLabel}>{COMBO_SECONDARY.label}</Text>
                    <Text style={S.comboFallbackNote}>Always used as fallback — cannot be changed</Text>
                  </View>
                  <Ionicons name="lock-closed-outline" size={16} color="#9CA3AF" />
                </View>

                {/* Preview pill — shows the selected combo */}
                {selectedPrimary && (
                  <View style={S.comboPreview}>
                    <Text style={S.comboPreviewText}>
                      {COMBO_PRIMARY_OPTIONS.find((m) => m.id === selectedPrimary)?.label}
                    </Text>
                    <Ionicons name="arrow-forward" size={14} color={OD_COLOR} style={{ marginHorizontal: 6 }} />
                    <Text style={S.comboPreviewText}>{COMBO_SECONDARY.label}</Text>
                  </View>
                )}

                {/* Confirm */}
                <TouchableOpacity
                  style={[S.comboConfirmBtn, !selectedPrimary && S.comboConfirmBtnDisabled]}
                  activeOpacity={selectedPrimary ? 0.8 : 1}
                  onPress={handleComboConfirm}
                  disabled={!selectedPrimary}
                >
                  <Ionicons name="checkmark-circle-outline" size={18} color="#fff" style={{ opacity: selectedPrimary ? 1 : 0.5 }} />
                  <Text style={[S.comboConfirmText, !selectedPrimary && { opacity: 0.5 }]}>
                    Start Combo Attendance
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity style={S.cancelBtn} onPress={handleComboCancel}>
                  <Text style={S.cancelTxt}>Cancel</Text>
                </TouchableOpacity>

              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: BG_OVERLAY,
    justifyContent:  "flex-end",
  },
  sheet: {
    backgroundColor:      "#FFF",
    borderTopLeftRadius:  28,
    borderTopRightRadius: 28,
    paddingHorizontal:    20,
    paddingBottom:        40,
    paddingTop:           10,
  },
  handleWrap: { alignItems: "center", marginBottom: 18 },
  handle:     { width: 40, height: 5, backgroundColor: "#E0E0E0", borderRadius: 10 },

  title:    { fontSize: 22, fontWeight: "800", color: "#111827", textAlign: "center" },
  subtitle: { fontSize: 13, color: "#9CA3AF", textAlign: "center", marginTop: 4, marginBottom: 24, fontWeight: "500" },

  // ── Single method grid ──
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  card: {
    width:           (width - 52) / 2,
    backgroundColor: "#F9FAFB",
    borderRadius:    20,
    padding:         16,
    marginBottom:    14,
    alignItems:      "center",
    borderWidth:     1,
    borderColor:     "#F3F4F6",
    shadowColor:     "#000",
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.04,
    shadowRadius:    4,
    elevation:       2,
  },
  iconWrap: {
    width:          52,
    height:         52,
    borderRadius:   14,
    justifyContent: "center",
    alignItems:     "center",
    marginBottom:   10,
  },
  methodLabel: { fontSize: 15, fontWeight: "700", color: "#374151", marginBottom: 4 },
  methodDesc:  { fontSize: 11, color: "#9CA3AF", textAlign: "center", lineHeight: 15 },

  // ── Combo banner ──
  comboBanner: {
    flexDirection:  "row",
    alignItems:     "center",
    gap:            12,
    backgroundColor: "#F5F3FF",
    borderRadius:   18,
    padding:        16,
    marginBottom:   16,
    borderWidth:    1,
    borderColor:    OD_COLOR + "33",
  },
  comboIconStack:         { flexDirection: "row", width: 52, height: 32 },
  comboIconBubble:        { width: 28, height: 28, borderRadius: 8, justifyContent: "center", alignItems: "center", borderWidth: 1.5, borderColor: "#fff" },
  comboIconBubbleOverlap: { marginLeft: -8 },
  comboIconBubbleOverlap2:{ marginLeft: -8 },
  comboTextWrap:          { flex: 1 },
  comboTitleRow:          { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 3 },
  comboBannerTitle:       { fontSize: 15, fontWeight: "800", color: OD_COLOR },
  comboBadge:             { backgroundColor: OD_COLOR, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  comboBadgeText:         { fontSize: 9, fontWeight: "800", color: "#fff", letterSpacing: 0.5 },
  comboBannerDesc:        { fontSize: 11, color: "#6D28D9", lineHeight: 15 },

  // ── Combo modal internals ──
  comboModalHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 0 },
  comboBackBtn:     { width: 36, height: 36, borderRadius: 10, backgroundColor: "#F3F4F6", justifyContent: "center", alignItems: "center", marginTop: 2 },

  howItWorks: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    gap:             8,
    backgroundColor: "#F5F3FF",
    borderRadius:    12,
    padding:         12,
    marginBottom:    20,
    borderWidth:     1,
    borderColor:     OD_COLOR + "22",
  },
  howItWorksText: { flex: 1, fontSize: 12, color: "#5B21B6", lineHeight: 17, fontWeight: "500" },

  stepLabel: { fontSize: 12, fontWeight: "700", color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 10 },
  stepNum:   { color: OD_COLOR },

  // ── Combo picker cards (primary selection) ──
  comboPickerRow: { flexDirection: "row", gap: 12 },
  comboPickerCard: {
    flex:            1,
    backgroundColor: "#F9FAFB",
    borderRadius:    16,
    padding:         14,
    alignItems:      "center",
    borderWidth:     1.5,
    borderColor:     "#E5E7EB",
    position:        "relative",
  },
  comboPickerCardSelected: {
    backgroundColor: "#F5F3FF",
    borderColor:     OD_COLOR,
  },
  comboPickerIcon:  { width: 48, height: 48, borderRadius: 13, justifyContent: "center", alignItems: "center", marginBottom: 8 },
  comboPickerLabel: { fontSize: 13, fontWeight: "700", color: "#374151", textAlign: "center" },
  comboPickerLabelSelected: { color: OD_COLOR },

  // Selection tick in corner
  comboTick: {
    position:        "absolute",
    top:             8,
    right:           8,
    width:           18,
    height:          18,
    borderRadius:    9,
    borderWidth:     1.5,
    borderColor:     "#D1D5DB",
    backgroundColor: "#fff",
    justifyContent:  "center",
    alignItems:      "center",
  },
  comboTickSelected: { backgroundColor: OD_COLOR, borderColor: OD_COLOR },

  // ── Fallback card (static, locked) ──
  comboFallbackCard: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             12,
    backgroundColor: "#F9FAFB",
    borderRadius:    16,
    padding:         14,
    borderWidth:     1.5,
    borderColor:     "#E5E7EB",
    opacity:         0.85,
  },
  comboFallbackNote: { fontSize: 11, color: "#9CA3AF", marginTop: 2 },

  // ── Combo preview pill ──
  comboPreview: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    marginTop:       16,
    backgroundColor: "#F5F3FF",
    borderRadius:    50,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderWidth:     1,
    borderColor:     OD_COLOR + "44",
  },
  comboPreviewText: { fontSize: 13, fontWeight: "700", color: OD_COLOR },

  // ── Confirm button ──
  comboConfirmBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             8,
    backgroundColor: OD_COLOR,
    borderRadius:    50,
    paddingVertical: 16,
    marginTop:       16,
  },
  comboConfirmBtnDisabled: { backgroundColor: "#C4B5FD" },
  comboConfirmText: { fontSize: 15, fontWeight: "700", color: "#fff" },

  cancelBtn: { marginTop: 8, alignSelf: "center", paddingVertical: 10, paddingHorizontal: 20 },
  cancelTxt: { fontSize: 15, fontWeight: "600", color: "#EF4444" },
});