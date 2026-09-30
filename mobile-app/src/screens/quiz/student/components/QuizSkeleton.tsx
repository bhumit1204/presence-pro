import React, { useEffect, useRef } from "react";
import { View, StyleSheet, Animated } from "react-native";

// ─── Single shimmer block ──────────────────────────────────────────────────────
function ShimmerBlock({ width = "100%", height = 16, style = {} }: {
  width?: number | string;
  height?: number;
  style?: object;
}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const opacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: 8, backgroundColor: "#E5E7EB", opacity },
        style,
      ]}
    />
  );
}

// ─── Quiz list card skeleton ───────────────────────────────────────────────────
export function QuizCardSkeleton() {
  return (
    <View style={S.card}>
      <View style={S.topRow}>
        <ShimmerBlock width="60%" height={16} />
        <ShimmerBlock width={50} height={22} style={{ borderRadius: 10 }} />
      </View>
      <ShimmerBlock width="40%" height={12} style={{ marginTop: 8 }} />
      <View style={S.bottomRow}>
        <ShimmerBlock width={80} height={12} />
        <ShimmerBlock width={60} height={12} />
        <ShimmerBlock width={70} height={12} />
      </View>
    </View>
  );
}

// ─── Quiz page (result / scheduled) skeleton ──────────────────────────────────
export function QuizPageSkeleton() {
  return (
    <View style={S.page}>
      <ShimmerBlock width={38} height={38} style={{ borderRadius: 19, marginBottom: 16 }} />
      <ShimmerBlock width="70%" height={28} style={{ marginBottom: 8 }} />
      <ShimmerBlock width="50%" height={14} style={{ marginBottom: 24 }} />
      {/* Info card */}
      <View style={S.infoCard}>
        <ShimmerBlock height={20} style={{ marginBottom: 12 }} />
        <ShimmerBlock width="80%" height={14} style={{ marginBottom: 8 }} />
        <ShimmerBlock width="60%" height={14} style={{ marginBottom: 8 }} />
        <ShimmerBlock width="70%" height={14} />
      </View>
      {/* Questions */}
      {[1, 2, 3].map((i) => (
        <View key={i} style={S.infoCard}>
          <ShimmerBlock width="90%" height={16} style={{ marginBottom: 10 }} />
          <ShimmerBlock height={12} style={{ marginBottom: 6 }} />
          <ShimmerBlock width="70%" height={12} />
        </View>
      ))}
    </View>
  );
}

const S = StyleSheet.create({
  card: {
    backgroundColor: "#FFF",
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    gap: 0,
  },
  topRow:    { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  bottomRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 12 },
  page:      { paddingHorizontal: 20, paddingTop: 16 },
  infoCard:  { backgroundColor: "#FFF", borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#E5E7EB" },
});