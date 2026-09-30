import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, PanResponder } from "react-native";

const PRIMARY = "#4834D4";
const BG = "#F3F4F6";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Props {
  onDateSelect: (date: {
    day: string;
    date: number;
    month: number;
    year: number;
  }) => void;
  mode?: "past" | "future";
}

export default function AttendanceCalendar({ onDateSelect, mode = "past" }: Props) {

  const today = new Date();

  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState(today.getDate());

  const months = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December"
  ];

  const getDaysInMonth = (month: number, year: number) => {
    return new Date(year, month + 1, 0).getDate();
  };

  const getFirstDay = (month: number, year: number) => {
    return new Date(year, month, 1).getDay();
  };

  const swipeThreshold = 80;

  const panResponder = PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => {
      return Math.abs(gestureState.dx) > 20;
    },
    onPanResponderRelease: (_, gestureState) => {
      if (gestureState.dx > swipeThreshold) changeMonth(-1);
      if (gestureState.dx < -swipeThreshold) changeMonth(1);
    }
  });

  const changeMonth = (direction: number) => {
    let newMonth = currentMonth + direction;
    let newYear = currentYear;

    if (newMonth < 0) { newMonth = 11; newYear -= 1; }
    if (newMonth > 11) { newMonth = 0; newYear += 1; }

    const newDate = new Date(newYear, newMonth);
    const todayMonth = new Date(today.getFullYear(), today.getMonth());

    // past mode: block navigating into the future
    if (mode === "past" && newDate > todayMonth) return;

    // future mode: block navigating into the past
    if (mode === "future" && newDate < todayMonth) return;

    setCurrentMonth(newMonth);
    setCurrentYear(newYear);
  };

  const selectDate = (date: number) => {
    setSelectedDate(date);
    const d = new Date(currentYear, currentMonth, date);
    onDateSelect({
      day: days[d.getDay()],
      date,
      month: currentMonth + 1,
      year: currentYear
    });
  };

  const totalDays = getDaysInMonth(currentMonth, currentYear);
  const firstDay = getFirstDay(currentMonth, currentYear);

  const calendarCells = [];

  for (let i = 0; i < firstDay; i++) {
    calendarCells.push(<View key={"empty" + i} style={styles.emptyCell} />);
  }

  for (let d = 1; d <= totalDays; d++) {
    const isSelected = d === selectedDate;
    const dateObj = new Date(currentYear, currentMonth, d);

    // past mode: disable future dates
    // future mode: disable past dates
    const isDisabled =
      mode === "past"
        ? dateObj > today
        : dateObj < new Date(today.getFullYear(), today.getMonth(), today.getDate());

    calendarCells.push(
      <TouchableOpacity
        key={d}
        disabled={isDisabled}
        style={[
          styles.dateCell,
          isSelected && styles.selectedDate,
          isDisabled && styles.disabledDate,
        ]}
        onPress={() => selectDate(d)}
      >
        <Text style={[styles.dateText, isSelected && styles.selectedText]}>
          {d}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container} {...panResponder.panHandlers}>

      {/* Month Header */}
      <View style={styles.header}>

        <TouchableOpacity style={styles.navButton} onPress={() => changeMonth(-1)}>
          <Text style={styles.navText}>‹</Text>
        </TouchableOpacity>

        <Text style={styles.monthText}>
          {months[currentMonth]} {currentYear}
        </Text>

        <TouchableOpacity style={styles.navButton} onPress={() => changeMonth(1)}>
          <Text style={styles.navText}>›</Text>
        </TouchableOpacity>

      </View>

      {/* Week Days */}
      <View style={styles.weekRow}>
        {days.map((d) => (
          <Text key={d} style={styles.weekDay}>{d}</Text>
        ))}
      </View>

      {/* Calendar Grid */}
      <View style={styles.grid}>
        {calendarCells}
      </View>

    </View>
  );
}

const styles = StyleSheet.create({

  container: {
    backgroundColor: "#FFF",
    borderRadius: 18,
    padding: 16,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 4
  },

  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14
  },

  monthText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111827"
  },

  navButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#EEF2FF"
  },

  navText: {
    fontSize: 20,
    fontWeight: "700",
    color: PRIMARY
  },

  weekRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10
  },

  weekDay: {
    width: "14%",
    textAlign: "center",
    fontWeight: "600",
    color: "#6B7280",
    fontSize: 12
  },

  grid: {
    flexDirection: "row",
    flexWrap: "wrap"
  },

  emptyCell: {
    width: "14%",
    height: 40
  },

  dateCell: {
    width: "14%",
    height: 40,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 10
  },

  dateText: {
    fontSize: 14,
    color: "#111827"
  },

  selectedDate: {
    backgroundColor: PRIMARY
  },

  selectedText: {
    color: "#FFF",
    fontWeight: "700"
  },

  disabledDate: {
    opacity: 0.3
  },

});