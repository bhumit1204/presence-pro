// src/components/CancelLectureModal.tsx
// Props are backward compatible; `lecture` and `busy` are optional extras.
import React from "react";
import { Text, View } from "react-native";
import { Button, Sheet, SP, font } from "./ui";

export default function CancelLectureModal({
  visible,
  onClose,
  onCancelLecture,
  onAssign,
  lecture,
  busy = false,
}: {
  visible: boolean;
  onClose: () => void;
  onCancelLecture: () => void;
  onAssign: () => void;
  lecture?: { subject_name?: string; start_time?: string; end_time?: string } | null;
  busy?: boolean;
}) {
  const when = lecture?.start_time ? `${lecture.subject_name ? lecture.subject_name + ", " : ""}${lecture.start_time} - ${lecture.end_time}` : undefined;
  return (
    <Sheet visible={visible} onClose={busy ? () => {} : onClose} title="Can't take this lecture?" subtitle={when}>
      <Text style={[font.body, { marginBottom: SP.lg }]}>
        You can hand it to a free teacher, or cancel it. Students are told either way.
      </Text>
      <View style={{ gap: SP.sm, paddingBottom: SP.sm }}>
        <Button label="Ask another teacher to take it" icon="swap-horizontal" onPress={onAssign} disabled={busy} />
        <Button label="Cancel this lecture" icon="close-circle-outline" variant="dangerSoft" onPress={onCancelLecture} loading={busy} />
        <Button label="Keep it" variant="ghost" onPress={onClose} disabled={busy} />
      </View>
    </Sheet>
  );
}