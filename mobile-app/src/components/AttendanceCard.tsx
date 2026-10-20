// src/components/AttendanceCard.tsx
// The "class right now" card, used by the teacher Today tab and by the student dashboard.
// Props are unchanged from the previous version.
import React, { useState } from "react";
import { Platform, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import AttendanceModal from "./AttendanceModal";
import { Banner, Button, Chip, LiveBadge, T, SP, font } from "./ui";

interface AttendanceCardProps {
  lecture: any;
  lectureState: "idle" | "ongoing";
  userRole: "teacher" | "student";
  timerSeconds: number;
  onStartLecture: () => void;
  onEndLecture: () => void;
  onMethodSelected: (method: string) => void;
  markingStatus?: "open" | "closed";
  markingMethod?: string | null;
  alreadyMarked?: boolean;
  markPending?: boolean; // marked, but the room check was unsure -> waiting for the teacher
  onMarkAttendance?: () => void;
  isStarting?: boolean;
}

const fmtTimer = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, "0");
  const s = (sec % 60).toString().padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
};

const METHOD_NAME: Record<string, string> = {
  code: "digit code",
  qr: "QR code",
  bio_geo: "biometric",
  iot: "IoT device",
  multi: "multi method",
};

export default function AttendanceCard({
  lecture,
  lectureState,
  userRole,
  timerSeconds,
  onStartLecture,
  onEndLecture,
  onMethodSelected,
  markingStatus,
  markingMethod,
  alreadyMarked,
  markPending = false,
  onMarkAttendance,
  isStarting = false,
}: AttendanceCardProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  if (!lecture) return null;

  const live = lectureState === "ongoing";

  return (
    <View style={{ width: "100%" }}>
      <AttendanceModal
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelectMethod={(m) => {
          setPickerOpen(false);
          onMethodSelected(m);
        }}
      />

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        {live ? <LiveBadge label="LIVE NOW" /> : <Chip label="Up next" tone="warning" icon="time-outline" />}
        <Text style={{ fontSize: 12, fontWeight: "700", color: T.muted }}>
          {lecture.start_time} - {lecture.end_time}
        </Text>
      </View>

      <Text style={[font.h1, { marginTop: SP.lg }]} numberOfLines={2}>
        {lecture.subject_name}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
        <Ionicons name="location-outline" size={14} color={T.muted} />
        <Text style={font.body}>{lecture.room ? `Room ${lecture.room}` : "Room not set"}</Text>
        {lecture.is_temporary ? <Chip label="Covering" tone="info" style={{ marginLeft: 6 }} /> : null}
      </View>

      {live && (
        <View style={{ alignItems: "center", marginTop: SP.xl }}>
          <Text style={font.label}>Class running for</Text>
          <Text
            style={{
              fontSize: 46,
              fontWeight: "800",
              color: T.primary,
              letterSpacing: -1,
              fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
            }}
            accessibilityLabel={`Class running for ${fmtTimer(timerSeconds)}`}
          >
            {fmtTimer(timerSeconds)}
          </Text>
        </View>
      )}

      <View style={{ height: SP.xl }} />

      {userRole === "teacher" && !live && (
        <>
          <Button label="Start lecture" icon="play" onPress={onStartLecture} loading={isStarting} />
          <Text style={[font.small, { textAlign: "center", marginTop: SP.sm }]}>
            Starting uses your location so students can be checked against the room.
          </Text>
        </>
      )}

      {userRole === "teacher" && live && (
        <View style={{ gap: SP.sm }}>
          <Button label="Take attendance" icon="checkmark-done" variant="success" onPress={() => setPickerOpen(true)} />
          <Button label="End class" icon="stop-circle-outline" variant="dangerSoft" onPress={onEndLecture} />
        </View>
      )}

      {userRole === "student" && live && (
        <>
          {alreadyMarked ? (
            <Button label="Attendance marked" icon="checkmark-circle" variant="success" disabled />
          ) : markPending ? (
            <>
              <Banner tone="warning" title="Waiting for your teacher">
                We could not confirm you are in the room. Your teacher will review it.
              </Banner>
              {markingStatus === "open" && (
                <Button label="Try again" icon="refresh" variant="secondary" style={{ marginTop: SP.sm }} onPress={() => onMarkAttendance?.()} />
              )}
            </>
          ) : markingStatus === "open" ? (
            <>
              <Button label="Mark attendance" icon="finger-print" onPress={() => onMarkAttendance?.()} />
              {!!markingMethod && (
                <Text style={[font.small, { textAlign: "center", marginTop: SP.sm }]}>
                  Your teacher is using {METHOD_NAME[markingMethod] || markingMethod}.
                </Text>
              )}
            </>
          ) : (
            <>
              <Button label="Attendance not open yet" icon="lock-closed-outline" variant="secondary" disabled />
              <Text style={[font.small, { textAlign: "center", marginTop: SP.sm }]}>The button unlocks when your teacher starts attendance.</Text>
            </>
          )}
        </>
      )}
    </View>
  );
}