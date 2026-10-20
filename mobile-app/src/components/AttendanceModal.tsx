// src/components/AttendanceModal.tsx
// Pick how students mark attendance. Same props as before: { visible, onClose, onSelectMethod(id) }.
import React from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Sheet, T, R, SP, font, shadow, Tone, TONE } from "./ui";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

const METHODS: { id: string; label: string; icon: IconName; tone: Tone; desc: string; best: string }[] = [
  { id: "code", label: "Digit code", icon: "keypad-outline", tone: "primary", desc: "Students type a short code", best: "Quickest to start" },
  { id: "qr", label: "QR code", icon: "qr-code-outline", tone: "danger", desc: "Rotating QR on a projector", best: "Large halls" },
  { id: "bio_geo", label: "Biometric + location", icon: "finger-print-outline", tone: "success", desc: "Fingerprint inside the geofence", best: "Stops proxies" },
  { id: "iot", label: "IoT device", icon: "wifi-outline", tone: "warning", desc: "Classroom sensor based", best: "Rooms with a device" },
];

export default function AttendanceModal({
  visible,
  onClose,
  onSelectMethod,
}: {
  visible: boolean;
  onClose: () => void;
  onSelectMethod: (method: string) => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Take attendance" subtitle="Choose how students will mark. You can start another method later.">
      <View style={{ gap: SP.sm, paddingBottom: SP.md }}>
        {METHODS.map((m) => (
          <Pressable
            key={m.id}
            onPress={() => onSelectMethod(m.id)}
            accessibilityRole="button"
            accessibilityLabel={`${m.label}. ${m.desc}`}
            style={({ pressed }) => [
              { flexDirection: "row", alignItems: "center", gap: SP.md, padding: SP.md, borderRadius: R.lg, backgroundColor: T.surface, borderWidth: 1, borderColor: T.line },
              pressed && { backgroundColor: T.lineSoft },
            ]}
          >
            <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: TONE[m.tone].bg, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name={m.icon} size={23} color={TONE[m.tone].fg} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={font.h3}>{m.label}</Text>
              <Text style={font.small}>{m.desc}</Text>
            </View>
            <Text style={{ fontSize: 11, fontWeight: "700", color: TONE[m.tone].fg }}>{m.best}</Text>
          </Pressable>
        ))}

        <Pressable
          onPress={() => onSelectMethod("multi")}
          accessibilityRole="button"
          accessibilityLabel="Multi method. Each student picks a digit code or biometric."
          style={({ pressed }) => [
            { flexDirection: "row", alignItems: "center", gap: SP.md, padding: SP.md, borderRadius: R.lg, backgroundColor: T.primarySoft, borderWidth: 1, borderColor: T.primary + "33" },
            pressed && { opacity: 0.8 },
          ]}
        >
          <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: T.surface, alignItems: "center", justifyContent: "center", ...shadow }}>
            <Ionicons name="layers-outline" size={23} color={T.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[font.h3, { color: T.primary }]}>Multi method</Text>
            <Text style={[font.small, { color: T.primary }]}>Each student chooses a digit code or biometric. Both confirm they are in the room.</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={T.primary} />
        </Pressable>
      </View>
    </Sheet>
  );
}