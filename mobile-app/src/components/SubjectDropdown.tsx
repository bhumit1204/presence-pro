import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  FlatList,
  StyleSheet
} from "react-native";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";

interface Subject {
  subject_name: string;
  subject_code: string;
}

interface Props {
  subjects: Subject[];
  selectedSubject: Subject | null;
  onSelect: (subject: Subject) => void;
}

export default function SubjectDropdown({
  subjects,
  selectedSubject,
  onSelect
}: Props) {

  const [visible, setVisible] = useState(false);

  const handleSelect = (subject: Subject) => {
    onSelect(subject);
    setVisible(false);
  };

  return (
    <>
      {/* Dropdown Button */}
      <TouchableOpacity
        style={styles.dropdown}
        onPress={() => setVisible(true)}
      >
        <Text style={styles.dropdownText}>
          {selectedSubject
            ? `${selectedSubject.subject_name} (${selectedSubject.subject_code})`
            : "Select Subject"}
        </Text>

        <Text style={styles.arrow}>⌄</Text>
      </TouchableOpacity>

      {/* Modal */}
      <Modal visible={visible} transparent animationType="slide">
        <View style={styles.overlay}>

          <View style={styles.modal}>

            <Text style={styles.title}>Select Subject</Text>

            <FlatList
              data={subjects}
              keyExtractor={(item) => item.subject_code}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.subjectItem}
                  onPress={() => handleSelect(item)}
                >
                  <Text style={styles.subjectName}>
                    {item.subject_name}
                  </Text>

                  <Text style={styles.subjectCode}>
                    {item.subject_code}
                  </Text>
                </TouchableOpacity>
              )}
            />

            <TouchableOpacity
              style={styles.closeBtn}
              onPress={() => setVisible(false)}
            >
              <Text style={styles.closeText}>Cancel</Text>
            </TouchableOpacity>

          </View>

        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({

  dropdown: {
    backgroundColor: "#FFF",
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 18,

    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",

    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 3
  },

  dropdownText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#1F2937"
  },

  arrow: {
    fontSize: 20,
    color: "#6B7280"
  },

  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.4)"
  },

  modal: {
    backgroundColor: "#FFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    maxHeight: "60%"
  },

  title: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 16,
    color: "#111827"
  },

  subjectItem: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#F1F5F9"
  },

  subjectName: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1F2937"
  },

  subjectCode: {
    fontSize: 13,
    color: "#6B7280",
    marginTop: 2
  },

  closeBtn: {
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    backgroundColor: BG,
    alignItems: "center"
  },

  closeText: {
    fontSize: 15,
    fontWeight: "600"
  }
});