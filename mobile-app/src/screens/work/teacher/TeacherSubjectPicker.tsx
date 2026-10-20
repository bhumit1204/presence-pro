import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Avatar, EmptyState, Header, R, SP, Screen, T, Tone, font, shadow } from "../../../components/ui";

const TONES: Tone[] = ["primary", "success", "warning", "danger", "info"];

export default function TeacherSubjectPicker() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { course, teacher_id } = route.params ?? {};
  const subjects: any[] = course?.subjects ?? [];

  return (
    <Screen>
      <Header title={course?.course_name || "Classwork"} subtitle="Choose a subject" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }} showsVerticalScrollIndicator={false}>
        {subjects.length === 0 ? (
          <EmptyState icon="folder-outline" title="No subjects found" text="This course has no subjects assigned to you." />
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SP.md }}>
            {subjects.map((sub, idx) => (
              <Pressable
                key={sub.subject_id ?? idx}
                onPress={() => navigation.navigate("TeacherSubjectFeed", { subject: sub, course, teacher_id })}
                accessibilityRole="button"
                accessibilityLabel={`Open ${sub.subject_name}`}
                style={({ pressed }) => [
                  {
                    width: "47.5%",
                    backgroundColor: T.surface,
                    borderRadius: R.lg,
                    borderWidth: 1,
                    borderColor: T.line,
                    padding: SP.lg,
                    opacity: pressed ? 0.75 : 1,
                  },
                  shadow,
                ]}
              >
                <Avatar name={sub.subject_name} tone={TONES[idx % TONES.length]} size={48} />
                <Text style={[font.h3, { marginTop: SP.md, lineHeight: 20 }]} numberOfLines={3}>
                  {sub.subject_name}
                </Text>
                <View style={{ alignSelf: "flex-end", marginTop: SP.sm }}>
                  <Ionicons name="arrow-forward" size={18} color={T.primary} />
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}