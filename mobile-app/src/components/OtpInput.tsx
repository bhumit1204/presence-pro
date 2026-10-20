// src/components/OtpInput.tsx — six code boxes driven by one hidden input (paste, autofill and backspace just work)
import React, { useRef } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SP, T } from "./ui";

export default function OtpInput({
  value,
  onChange,
  length = 6,
  error = false,
  editable = true,
  autoFocus = true,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  error?: boolean;
  editable?: boolean;
  autoFocus?: boolean;
}) {
  const ref = useRef<any>(null);
  const [focused, setFocused] = React.useState(false);

  return (
    <Pressable onPress={() => ref.current?.focus()} accessibilityLabel="Verification code">
      <View style={st.row}>
        {Array.from({ length }).map((_, i) => {
          const ch = value[i] || "";
          const active = focused && i === Math.min(value.length, length - 1);
          return (
            <View key={i} style={[st.box, active && st.boxActive, error && st.boxError, !!ch && !error && st.boxFilled]}>
              <Text style={st.digit}>{ch}</Text>
            </View>
          );
        })}
      </View>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={(t) => onChange(t.replace(/\D/g, "").slice(0, length))}
        keyboardType="number-pad"
        maxLength={length}
        editable={editable}
        autoFocus={autoFocus}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        caretHidden
        style={st.hidden}
      />
    </Pressable>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", gap: SP.sm },
  box: {
    flex: 1,
    height: 58,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: T.line,
    backgroundColor: T.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  boxActive: { borderColor: T.primary, backgroundColor: T.primarySoft },
  boxFilled: { borderColor: T.primary },
  boxError: { borderColor: T.danger, backgroundColor: T.dangerSoft },
  digit: { fontSize: 24, fontWeight: "800", color: T.ink },
  hidden: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, opacity: 0.02, color: "transparent" },
});