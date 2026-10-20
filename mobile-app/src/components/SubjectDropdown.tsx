// src/components/SubjectDropdown.tsx
// Subject picker. Same props; subjects may also carry course_name / subject_id, and the list is searchable.
import React, { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { EmptyState, Sheet, TextField, T, R, SP, font, shadow } from "./ui";

interface Subject {
  subject_name: string;
  subject_code: string;
  subject_id?: string;
  course_name?: string;
  [k: string]: any;
}

interface Props {
  subjects: Subject[];
  selectedSubject: Subject | null;
  onSelect: (subject: Subject) => void;
  placeholder?: string;
}

const keyOf = (s: Subject, i: number) => s.subject_id || s.subject_code || String(i);

export default function SubjectDropdown({ subjects, selectedSubject, onSelect, placeholder = "Select subject" }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const list = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return subjects;
    return subjects.filter((s) => `${s.subject_name} ${s.subject_code} ${s.course_name || ""}`.toLowerCase().includes(query));
  }, [subjects, q]);

  const close = () => {
    setOpen(false);
    setQ("");
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={selectedSubject ? `Subject: ${selectedSubject.subject_name}. Tap to change.` : placeholder}
        style={[{ backgroundColor: T.surface, borderRadius: R.lg, paddingVertical: 14, paddingHorizontal: SP.lg, flexDirection: "row", alignItems: "center", gap: SP.md }, shadow]}
      >
        <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: T.primarySoft, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="book-outline" size={18} color={T.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[font.h3, !selectedSubject && { color: T.muted }]} numberOfLines={1}>
            {selectedSubject ? selectedSubject.subject_name : placeholder}
          </Text>
          {!!selectedSubject && (
            <Text style={font.small} numberOfLines={1}>
              {[selectedSubject.subject_code, selectedSubject.course_name].filter(Boolean).join("  |  ")}
            </Text>
          )}
        </View>
        <Ionicons name="chevron-down" size={18} color={T.muted} />
      </Pressable>

      <Sheet visible={open} onClose={close} title="Choose a subject">
        {subjects.length > 5 && <TextField value={q} onChangeText={setQ} placeholder="Search subject or code" icon="search" style={{ marginBottom: SP.sm }} />}
        {list.length === 0 ? (
          <EmptyState icon="book-outline" title="No subjects" text={q ? "Nothing matches your search." : "No subject is assigned to you yet. Ask your admin."} />
        ) : (
          <View style={{ paddingBottom: SP.md }}>
            {list.map((item, i) => {
              const on = !!selectedSubject && keyOf(selectedSubject, 0) === keyOf(item, 0);
              return (
                <Pressable
                  key={keyOf(item, i)}
                  onPress={() => {
                    onSelect(item);
                    close();
                  }}
                  style={[{ flexDirection: "row", alignItems: "center", gap: SP.md, padding: SP.md, borderRadius: R.md }, on && { backgroundColor: T.primarySoft }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[font.h3, on && { color: T.primary }]}>{item.subject_name}</Text>
                    <Text style={font.small}>{[item.subject_code, item.course_name].filter(Boolean).join("  |  ")}</Text>
                  </View>
                  {on && <Ionicons name="checkmark-circle" size={20} color={T.primary} />}
                </Pressable>
              );
            })}
          </View>
        )}
      </Sheet>
    </>
  );
}