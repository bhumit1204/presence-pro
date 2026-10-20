// src/components/AttendanceList.tsx
// "Students attended" list. Same prop: { students: { uid, name, roll }[] }.
import React from "react";
import { Text, View } from "react-native";
import { Avatar, Card, Chip, EmptyState, T, SP, font } from "./ui";

interface Props {
  students: any[];
  title?: string;
}

export default function AttendanceList({ students, title = "Students attended" }: Props) {
  const list = students || [];
  return (
    <View style={{ padding: SP.lg }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: SP.md }}>
        <Text style={font.h3}>{title}</Text>
        <Chip label={`${list.length}`} tone={list.length ? "success" : "neutral"} icon="people" />
      </View>
      <Card padded={false}>
        {list.length === 0 ? (
          <EmptyState icon="people-outline" title="No attendance yet" text="Students will appear here as they mark." />
        ) : (
          list.map((item, i) => (
            <View
              key={item.uid ?? `${item.roll}-${i}`}
              style={{ flexDirection: "row", alignItems: "center", gap: SP.md, paddingHorizontal: SP.lg, paddingVertical: SP.md, borderTopWidth: i ? 1 : 0, borderTopColor: T.lineSoft }}
            >
              <Avatar name={item.name} size={34} tone="success" />
              <Text style={[font.h3, { flex: 1, fontWeight: "600" }]} numberOfLines={1}>
                {item.name}
              </Text>
              {!!item.roll && <Text style={font.small}>Roll {item.roll}</Text>}
            </View>
          ))
        )}
      </Card>
    </View>
  );
}