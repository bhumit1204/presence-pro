// src/screens/teacher/LectureSchedule.tsx
// Full calendar view of the schedule (opened from "Full calendar" on the Today tab).
import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import AttendanceCalendar, { PickedDate } from "../../../components/AttendanceCalendar";
import { Header, Screen, SectionLabel, SP, font } from "../../../components/ui";
import { DayLectures, parseYmd, ymd } from "../teacherShared";

const toYmd = (d: PickedDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.date).padStart(2, "0")}`;

export default function LectureSchedule() {
  const navigation = useNavigation<any>();
  const [date, setDate] = useState(ymd(new Date()));

  return (
    <Screen>
      <Header title="My schedule" subtitle="Pick a day to see, cancel or hand over lectures" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
        <AttendanceCalendar mode="future" onDateSelect={(d) => setDate(toYmd(d))} />
        <SectionLabel style={{ marginTop: SP.xl }}>
          {parseYmd(date).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
        </SectionLabel>
        <DayLectures date={date} />
      </ScrollView>
    </Screen>
  );
}