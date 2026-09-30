import React from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
} from "react-native";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";

interface Props {
  students: any[];
}

export default function AttendanceList({ students }: Props) {

  const renderItem = ({ item }: any) => (
    <View style={styles.row}>
      <Text style={styles.name}>{item.name}</Text>
      <Text style={styles.roll}>Roll no: {item.roll}</Text>
    </View>
  );

  return (
    <View style={{padding:18}}>
    <Text style={styles.sectionTitle}>Students Attended</Text>

      <View style={styles.card}>

        <FlatList
          data={students}
          keyExtractor={(item) => item.uid}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              No attendance data available
            </Text>
          }
        />

      </View>
    </View>
  );
}

const styles = StyleSheet.create({

  sectionTitle: {
    fontWeight: "700",
    color: PRIMARY,
    marginBottom: 12,
  },

  card: {
    backgroundColor: "#fff",
    borderRadius: 18,
    paddingVertical: 6,
  },

  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",

    paddingHorizontal: 16,
    paddingVertical: 14,
  },

  name: {
    fontSize: 16,
    fontWeight: "500",
    color: "#222",
  },

  roll: {
    fontSize: 14,
    color: "#888",
  },

  divider: {
    height: 1,
    backgroundColor: "#F0F0F0",
    marginHorizontal: 16,
  },

  emptyText: {
    textAlign: "center",
    padding: 20,
    color: "#888",
  },
});