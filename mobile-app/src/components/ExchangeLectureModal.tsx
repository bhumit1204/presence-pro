// src/components/ExchangeLectureModal.tsx
// Exchange one of my lectures with another teacher's lecture on the SAME date.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE } from "../services/api";
import { getUserSession } from "../services/session";
import { Avatar, Banner, Button, EmptyState, Sheet, TextField, T, R, SP, font } from "./ui";

interface Cand {
  id: string;
  subject_name: string;
  course_abbr: string;
  room: string;
  start_time: string;
  end_time: string;
}
interface CandTeacher {
  id: string;
  name: string;
  department: string;
  lectures: Cand[];
}

interface Props {
  visible: boolean;
  onClose: () => void;
  lecture: { id: string; subject_name?: string; start_time: string; end_time: string; day: string } | null;
  selectedDate: string;
  onSuccess?: () => void;
}

export default function ExchangeLectureModal({ visible, onClose, lecture, selectedDate, onSuccess }: Props) {
  const [teachers, setTeachers] = useState<CandTeacher[]>([]);
  const [picked, setPicked] = useState<string | null>(null); // partner lecture id
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const reqId = useRef(0);

  const load = useCallback(async () => {
    if (!lecture || !selectedDate) return;
    const my = ++reqId.current;
    setLoading(true);
    setLoadError("");
    try {
      const session = await getUserSession();
      const res = await apiFetch(
        `${API_BASE}/api/lectures/swap/candidates?uid=${encodeURIComponent(session.uid)}&date=${encodeURIComponent(selectedDate)}&lecture_id=${encodeURIComponent(lecture.id)}`
      );
      const data = await res.json();
      if (my !== reqId.current) return;
      if (data.success) {
        setTeachers(data.teachers || []);
        setNote(data.reason || "");
      } else setLoadError(data.error || "Could not load lectures.");
    } catch {
      if (my === reqId.current) setLoadError("Network error. Check your connection and try again.");
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, [lecture, selectedDate]);

  useEffect(() => {
    if (!visible) return;
    setTeachers([]);
    setPicked(null);
    setReason("");
    setError("");
    setNote("");
    load();
  }, [visible, load]);

  const send = async () => {
    if (!picked || !lecture) {
      setError("Pick a lecture to exchange with.");
      return;
    }
    setSending(true);
    setError("");
    try {
      const session = await getUserSession();
      const res = await apiFetch(`${API_BASE}/api/lectures/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: session.uid, lecture_id: lecture.id, partner_lecture_id: picked, date: selectedDate, reason: reason.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        onSuccess?.();
        onClose();
      } else {
        setError(data.error || "Could not send the request.");
        if (res.status === 409) load();
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={sending ? () => {} : onClose}
      title="Exchange lecture"
      subtitle={lecture ? `Your lecture ${lecture.start_time} - ${lecture.end_time}, ${selectedDate}` : undefined}
      footer={
        !loading && !loadError && teachers.length > 0 ? (
          <View style={{ paddingTop: SP.md }}>
            <Button label="Send request" icon="swap-horizontal" onPress={send} loading={sending} disabled={!picked} />
          </View>
        ) : null
      }
    >
      {loading ? (
        <View style={{ alignItems: "center", paddingVertical: 40, gap: SP.md }}>
          <ActivityIndicator size="large" color={T.primary} />
          <Text style={font.body}>Finding lectures you can exchange...</Text>
        </View>
      ) : loadError ? (
        <View style={{ gap: SP.md, paddingBottom: SP.md }}>
          <Banner tone="danger">{loadError}</Banner>
          <Button label="Try again" variant="secondary" icon="refresh" onPress={load} />
        </View>
      ) : teachers.length === 0 ? (
        <EmptyState icon="swap-horizontal-outline" title="Nothing to exchange with" text={note || "No other teacher has a lecture today that fits both timetables."} />
      ) : (
        <View style={{ gap: SP.md, paddingBottom: SP.sm }}>
          <Text style={font.small}>Pick the lecture you will take in return. Both of you must be free at the other's time.</Text>
          {teachers.map((t) => (
            <View key={t.id} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: SP.sm, marginTop: SP.xs }}>
                <Avatar name={t.name} tone="neutral" size={28} />
                <Text style={font.h3}>{t.name}</Text>
                {!!t.department && <Text style={font.small}>{t.department}</Text>}
              </View>
              {t.lectures.map((l) => {
                const on = picked === l.id;
                return (
                  <Pressable
                    key={l.id}
                    onPress={() => {
                      setPicked(l.id);
                      setError("");
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    style={[
                      { flexDirection: "row", alignItems: "center", gap: SP.md, padding: SP.md, borderRadius: R.md, borderWidth: 1.5, borderColor: on ? T.primary : T.line },
                      on && { backgroundColor: T.primarySoft },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={font.h3} numberOfLines={1}>
                        {l.subject_name}
                      </Text>
                      <Text style={font.small}>
                        {l.start_time} - {l.end_time}
                        {[l.course_abbr, l.room ? `Room ${l.room}` : ""].filter(Boolean).length ? `  |  ${[l.course_abbr, l.room ? `Room ${l.room}` : ""].filter(Boolean).join("  |  ")}` : ""}
                      </Text>
                    </View>
                    <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? T.primary : T.muted} />
                  </Pressable>
                );
              })}
            </View>
          ))}
          <TextField label="Reason" value={reason} onChangeText={setReason} placeholder="Short reason" multiline minHeight={70} maxLength={200} autoCapitalize="sentences" />
          {!!error && <Banner tone="danger">{error}</Banner>}
        </View>
      )}
    </Sheet>
  );
}