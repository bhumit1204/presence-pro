import React, { useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Banner, Card, EmptyState, Header, SP, Screen, SectionLabel, T, font } from "../../../components/ui";
import { HeaderIconButton } from "../../reports/teacher/ReportShared";
import { ResourceList, api, fmtDateTime, isPinActive } from "../WorkShared";

export default function AnnouncementDetail() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { announcement, teacher_id } = route.params ?? {};
  const [deleting, setDeleting] = useState(false);

  if (!announcement) {
    return (
      <Screen>
        <Header title="Announcement" onBack={() => navigation.goBack()} />
        <EmptyState icon="alert-circle-outline" title="Announcement not available" text="Go back and open it again." />
      </Screen>
    );
  }

  const pinned = isPinActive(announcement);

  const remove = () => {
    Alert.alert("Delete announcement?", "Students will no longer see it. This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setDeleting(true);
          try {
            await api(`/api/assignments/announcements/${announcement.announcement_id}?teacher_id=${encodeURIComponent(teacher_id)}`, { method: "DELETE" });
            navigation.goBack();
          } catch (e: any) {
            Alert.alert("Could not delete", e.message);
            setDeleting(false);
          }
        },
      },
    ]);
  };

  const hasResources = (announcement.attachments?.length ?? 0) > 0 || (announcement.links?.length ?? 0) > 0;

  return (
    <Screen>
      <Header
        title="Announcement"
        onBack={() => navigation.goBack()}
        right={deleting ? undefined : <HeaderIconButton icon="trash-outline" label="Delete announcement" onPress={remove} />}
      />
      <ScrollView contentContainerStyle={{ padding: SP.lg, paddingBottom: SP.xxl }} showsVerticalScrollIndicator={false}>
        {pinned && (
          <Banner tone="info" icon="pin" title="Pinned" style={{ marginBottom: SP.md }}>
            {announcement.pin_expires_at ? `Stays at the top until ${fmtDateTime(announcement.pin_expires_at)}.` : "Stays at the top of the stream."}
          </Banner>
        )}

        <Text style={font.h1}>{announcement.title}</Text>
        <Text style={[font.small, { marginTop: SP.xs, marginBottom: SP.lg }]}>{fmtDateTime(announcement.created_at)}</Text>

        <Card style={{ marginBottom: SP.md }}>
          <Text style={[font.body, { color: T.ink, fontSize: 15, lineHeight: 23 }]}>{announcement.text}</Text>
        </Card>

        {hasResources && (
          <Card>
            <SectionLabel>Attachments and links</SectionLabel>
            <ResourceList attachments={announcement.attachments} links={announcement.links} />
          </Card>
        )}
        {deleting && <Text style={[font.small, { textAlign: "center", marginTop: SP.lg }]}>Deleting...</Text>}
        <View style={{ height: SP.lg }} />
      </ScrollView>
    </Screen>
  );
}