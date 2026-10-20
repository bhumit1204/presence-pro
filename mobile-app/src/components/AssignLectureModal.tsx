// src/components/AssignLectureModal.tsx
// Ask a free teacher to take one lecture. Same props as before.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE } from "../services/api";
import { getUserSession } from "../services/session";
import { Avatar, Banner, Button, EmptyState, Sheet, TextField, T, R, SP, font } from "./ui";

interface Teacher {
  id: string;
  name: string;
  department: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  lecture: { id: string; start_time: string; end_time: string; day: string } | null;
  selectedDate: string;
  onSuccess?: () => void;
}

export default function AssignLectureModal({ visible, onClose, lecture, selectedDate, onSuccess }: Props) {
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState("");
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
        `${API_BASE}/api/lectures/teachers/available?uid=${encodeURIComponent(session.uid)}&date=${encodeURIComponent(selectedDate)}&start_time=${encodeURIComponent(lecture.start_time)}&end_time=${encodeURIComponent(lecture.end_time)}`
      );
      const data = await res.json();
      if (my !== reqId.current) return;
      if (data.success) setTeachers(data.available || []);
      else setLoadError(data.error || "Could not load teachers.");
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
    setQuery("");
    setReason("");
    setError("");
    load();
  }, [visible, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teachers;
    return teachers.filter((t) => t.name.toLowerCase().includes(q) || (t.department || "").toLowerCase().includes(q));
  }, [teachers, query]);

  const send = async () => {
    if (!picked || !lecture) {
      setError("Pick a teacher first.");
      return;
    }
    setSending(true);
    setError("");
    try {
      const session = await getUserSession();
      const res = await apiFetch(`${API_BASE}/api/lectures/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uid: session.uid,
          lecture_id: lecture.id,
          assigned_teacher_id: picked,
          date: selectedDate,
          start_time: lecture.start_time,
          end_time: lecture.end_time,
          reason: reason.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        onSuccess?.();
        onClose();
      } else setError(data.error || "Could not send the request.");
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
      title="Ask a teacher to take over"
      subtitle={lecture ? `${lecture.day}, ${lecture.start_time} - ${lecture.end_time}` : undefined}
      footer={
        !loading && !loadError && teachers.length > 0 ? (
          <View style={{ paddingTop: SP.md }}>
            <Button label="Send request" icon="paper-plane-outline" onPress={send} loading={sending} disabled={!picked} />
          </View>
        ) : null
      }
    >
      {loading ? (
        <View style={{ alignItems: "center", paddingVertical: 40, gap: SP.md }}>
          <ActivityIndicator size="large" color={T.primary} />
          <Text style={font.body}>Finding teachers who are free...</Text>
        </View>
      ) : loadError ? (
        <View style={{ gap: SP.md, paddingBottom: SP.md }}>
          <Banner tone="danger">{loadError}</Banner>
          <Button label="Try again" variant="secondary" icon="refresh" onPress={load} />
        </View>
      ) : teachers.length === 0 ? (
        <EmptyState icon="people-outline" title="Nobody is free" text="No teacher in your institution is free for this slot. You can still cancel the lecture instead." />
      ) : (
        <View style={{ gap: SP.md, paddingBottom: SP.sm }}>
          {teachers.length > 6 && <TextField value={query} onChangeText={setQuery} placeholder="Search by name or department" icon="search" />}
          <View style={{ gap: 6 }}>
            {shown.map((t) => {
              const on = picked === t.id;
              return (
                <Pressable
                  key={t.id}
                  onPress={() => {
                    setPicked(t.id);
                    setError("");
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  style={[
                    { flexDirection: "row", alignItems: "center", gap: SP.md, padding: SP.md, borderRadius: R.md, borderWidth: 1.5, borderColor: on ? T.primary : T.line },
                    on && { backgroundColor: T.primarySoft },
                  ]}
                >
                  <Avatar name={t.name} tone={on ? "primary" : "neutral"} size={38} />
                  <View style={{ flex: 1 }}>
                    <Text style={font.h3}>{t.name}</Text>
                    {!!t.department && <Text style={font.small}>{t.department}</Text>}
                  </View>
                  <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={20} color={on ? T.primary : T.muted} />
                </Pressable>
              );
            })}
            {shown.length === 0 && <Text style={[font.body, { textAlign: "center", paddingVertical: SP.lg }]}>No match for "{query}".</Text>}
          </View>
          <TextField
            label="Reason (optional)"
            value={reason}
            onChangeText={setReason}
            placeholder="For example: medical appointment"
            multiline
            minHeight={70}
            maxLength={200}
            autoCapitalize="sentences"
            helper={`${reason.length}/200`}
          />
          {!!error && <Banner tone="danger">{error}</Banner>}
        </View>
      )}
    </Sheet>
  );
}