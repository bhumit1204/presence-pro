import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#4834D4";

interface Props {
  visible: boolean;
  onClose: () => void;
  onCancelLecture: () => void;
  onAssign: () => void;
}

export default function CancelLectureModal({
  visible,
  onClose,
  onCancelLecture,
  onAssign,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>

          {/* Prevent outside click */}
          <TouchableWithoutFeedback>
            <View style={styles.modalContainer}>

              {/* CLOSE ICON */}
              <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
                <Ionicons name="close" size={22} color="#555" />
              </TouchableOpacity>

              {/* TITLE */}
              <Text style={styles.title}>Cancel Lecture</Text>

              {/* MESSAGE */}
              <Text style={styles.message}>
                Are you sure you want to cancel this lecture?
              </Text>

              {/* BUTTONS */}
              <View style={styles.btnContainer}>

                {/* ASSIGN */}
                <TouchableOpacity style={styles.assignBtn} onPress={onAssign}>
                  <Text style={styles.assignText}>Assign Task Instead</Text>
                </TouchableOpacity>

                {/* CANCEL */}
                <TouchableOpacity style={styles.cancelBtn} onPress={onCancelLecture}>
                  <Text style={styles.cancelText}>Cancel Lecture</Text>
                </TouchableOpacity>

              </View>

            </View>
          </TouchableWithoutFeedback>

        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },

  modalContainer: {
    width: "85%",
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
    elevation: 10,
  },

  closeBtn: {
    position: "absolute",
    right: 15,
    top: 15,
    zIndex: 10,
  },

  title: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#111",
    textAlign: "center",
    marginBottom: 10,
  },

  message: {
    textAlign: "center",
    color: "#666",
    fontSize: 14,
    marginBottom: 20,
  },

  btnContainer: {
    gap: 10,
  },

  assignBtn: {
    backgroundColor: PRIMARY,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },

  assignText: {
    color: "#fff",
    fontWeight: "600",
  },

  cancelBtn: {
    borderWidth: 1,
    borderColor: PRIMARY,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },

  cancelText: {
    color: PRIMARY,
    fontWeight: "600",
  },
});