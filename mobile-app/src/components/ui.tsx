// src/components/ui.tsx
// Shared look & feel for every attendance screen (teacher + student, all methods).
// One palette, one type scale, one set of buttons / cards / chips / result views, vector icons only.

import React from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleProp,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import { SafeAreaView, Edge } from "react-native-safe-area-context";
import { PHONE_PREFIX, sanitizePhoneInput } from "../utils/phone";
import { Ionicons } from "@expo/vector-icons";

/* ───────────────────────────── theme ───────────────────────────── */

export const T = {
  bg: "#F5F6FA",
  surface: "#FFFFFF",
  ink: "#0F172A",
  sub: "#475569",
  muted: "#94A3B8",
  line: "#E5E8F0",
  lineSoft: "#F0F2F7",

  primary: "#4834D4",
  primaryDark: "#3A29B5",
  primarySoft: "#EEF0FF",

  success: "#0E9F6E",
  successSoft: "#DCF5EA",
  warning: "#C77700",
  warningSoft: "#FFF3D6",
  danger: "#DC2626",
  dangerSoft: "#FDE8E8",
  info: "#2563EB",
  infoSoft: "#E3EDFF",
  dark: "#0B0B12",
} as const;

export type Tone = "primary" | "success" | "warning" | "danger" | "info" | "neutral";

export const TONE: Record<Tone, { fg: string; bg: string }> = {
  primary: { fg: T.primary, bg: T.primarySoft },
  success: { fg: T.success, bg: T.successSoft },
  warning: { fg: T.warning, bg: T.warningSoft },
  danger: { fg: T.danger, bg: T.dangerSoft },
  info: { fg: T.info, bg: T.infoSoft },
  neutral: { fg: T.sub, bg: T.lineSoft },
};

export const R = { sm: 10, md: 14, lg: 18, xl: 24, pill: 999 } as const;
export const SP = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;

export const font = {
  display: { fontSize: 30, fontWeight: "800" as const, letterSpacing: -0.5, color: T.ink },
  h1: { fontSize: 24, fontWeight: "800" as const, letterSpacing: -0.3, color: T.ink },
  h2: { fontSize: 18, fontWeight: "700" as const, color: T.ink },
  h3: { fontSize: 15, fontWeight: "700" as const, color: T.ink },
  body: { fontSize: 14, lineHeight: 21, color: T.sub },
  small: { fontSize: 12, lineHeight: 17, color: T.muted },
  label: { fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.9, color: T.muted, textTransform: "uppercase" as const },
};

export const shadow = Platform.select<ViewStyle>({
  ios: { shadowColor: "#1E1B4B", shadowOpacity: 0.07, shadowRadius: 14, shadowOffset: { width: 0, height: 5 } },
  android: { elevation: 2 },
  default: {},
}) as ViewStyle;

type IconName = React.ComponentProps<typeof Ionicons>["name"];

/* ───────────────────────────── layout ───────────────────────────── */

/**
 * Wrap a form (usually around a ScrollView) so it lifts above the keyboard on Android and iOS.
 * "padding" works on both: it adds only the part of the keyboard that really covers this view, so it does nothing
 * extra when Android already resized the window (softwareKeyboardLayoutMode "resize") and fixes it when it did not.
 */
export function KeyboardView({ children, style, offset = 0 }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; offset?: number }) {
  return (
    <KeyboardAvoidingView style={[{ flex: 1 }, style]} behavior="padding" keyboardVerticalOffset={offset}>
      {children}
    </KeyboardAvoidingView>
  );
}

/** Page wrapper: safe area + background + status bar. */
export function Screen({
  children,
  edges = ["top", "bottom"],
  dark = false,
  style,
}: {
  children: React.ReactNode;
  edges?: Edge[];
  dark?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: dark ? T.dark : T.bg }, style]}>
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} backgroundColor={dark ? T.dark : T.bg} />
      {children}
    </SafeAreaView>
  );
}

export function Header({
  title,
  subtitle,
  onBack,
  right,
  dark = false,
  border = true,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  dark?: boolean;
  border?: boolean;
}) {
  const fg = dark ? "#fff" : T.ink;
  return (
    <View style={[s.header, dark ? { backgroundColor: T.dark } : border && s.headerBorder]}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          hitSlop={8}
          style={({ pressed }) => [s.backBtn, dark && { backgroundColor: "rgba(255,255,255,0.12)", borderColor: "transparent" }, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={20} color={fg} />
        </Pressable>
      ) : (
        <View style={{ width: 4 }} />
      )}
      <View style={{ flex: 1 }}>
        <Text style={[font.h2, { color: fg }]} numberOfLines={1}>
          {title}
        </Text>
        {!!subtitle && (
          <Text style={[font.small, dark && { color: "rgba(255,255,255,0.55)" }, { marginTop: 1 }]} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {right}
    </View>
  );
}

export function Card({
  children,
  style,
  padded = true,
  tone,
  flat = false,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  tone?: Tone;
  /** No drop shadow: border only. Use for lists of many cards so the screen stays calm. */
  flat?: boolean;
}) {
  return (
    <View
      style={[
        s.card,
        padded && { padding: SP.lg },
        tone && { backgroundColor: TONE[tone].bg, borderColor: "transparent" },
        !tone && !flat && shadow,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionLabel({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[font.label, { marginBottom: SP.sm }, style]}>{children}</Text>;
}

export function Divider({ label }: { label?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginVertical: SP.lg }}>
      <View style={{ flex: 1, height: 1, backgroundColor: T.line }} />
      {!!label && <Text style={[font.label, { marginHorizontal: SP.md }]}>{label}</Text>}
      <View style={{ flex: 1, height: 1, backgroundColor: T.line }} />
    </View>
  );
}

/* ───────────────────────────── controls ───────────────────────────── */

type BtnVariant = "primary" | "secondary" | "danger" | "success" | "ghost" | "dangerSoft";

export function Button({
  label,
  onPress,
  icon,
  variant = "primary",
  loading = false,
  disabled = false,
  style,
  size = "lg",
}: {
  label: string;
  onPress?: () => void;
  icon?: IconName;
  variant?: BtnVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  size?: "md" | "lg";
}) {
  const v = {
    primary: { bg: T.primary, fg: "#fff", border: "transparent" },
    success: { bg: T.success, fg: "#fff", border: "transparent" },
    danger: { bg: T.danger, fg: "#fff", border: "transparent" },
    secondary: { bg: T.surface, fg: T.ink, border: T.line },
    ghost: { bg: "transparent", fg: T.primary, border: "transparent" },
    dangerSoft: { bg: T.dangerSoft, fg: T.danger, border: "transparent" },
  }[variant];
  const off = disabled || loading;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: loading }}
      style={({ pressed }) => [
        s.btn,
        size === "md" && { height: 44, borderRadius: R.sm + 2 },
        { backgroundColor: v.bg, borderColor: v.border },
        variant === "primary" && !off && s.btnGlow,
        off && { opacity: variant === "ghost" ? 0.5 : 0.45 },
        pressed && !off && { transform: [{ scale: 0.985 }], opacity: 0.92 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={v.fg} />
      ) : icon ? (
        <Ionicons name={icon} size={size === "md" ? 17 : 19} color={v.fg} />
      ) : null}
      <Text style={[s.btnText, size === "md" && { fontSize: 14 }, { color: v.fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Checkbox({ checked, onPress }: { checked: boolean; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="checkbox" accessibilityState={{ checked }}>
      <View style={[s.checkbox, checked && { backgroundColor: T.primary, borderColor: T.primary }]}>
        {checked && <Ionicons name="checkmark" size={14} color="#fff" />}
      </View>
    </Pressable>
  );
}

/* ───────────────────────────── status ───────────────────────────── */

export function Chip({
  label,
  tone = "neutral",
  icon,
  style,
}: {
  label: string;
  tone?: Tone;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const c = TONE[tone];
  return (
    <View style={[s.chip, { backgroundColor: c.bg }, style]}>
      {icon && <Ionicons name={icon} size={13} color={c.fg} />}
      <Text style={[s.chipText, { color: c.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Connection / radio status row item: icon + label + coloured state dot. */
export function StatusPill({
  icon,
  label,
  tone,
  busy = false,
  style,
}: {
  icon: IconName;
  label: string;
  tone: Tone;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = TONE[tone];
  return (
    <View style={[s.statusPill, { backgroundColor: c.bg }, style]}>
      {busy ? <ActivityIndicator size="small" color={c.fg} /> : <Ionicons name={icon} size={16} color={c.fg} />}
      <Text style={[s.statusPillText, { color: c.fg }]} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

export function LiveBadge({ label = "LIVE", tone = "success" }: { label?: string; tone?: Tone }) {
  const c = TONE[tone];
  return (
    <View style={[s.live, { backgroundColor: c.bg }]}>
      <View style={[s.liveDot, { backgroundColor: c.fg }]} />
      <Text style={[s.liveText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

export function IconBadge({
  icon,
  tone = "primary",
  size = 64,
  loading = false,
}: {
  icon: IconName;
  tone?: Tone;
  size?: number;
  loading?: boolean;
}) {
  const c = TONE[tone];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2.6, backgroundColor: c.bg, alignItems: "center", justifyContent: "center" }}>
      {loading ? <ActivityIndicator size="large" color={c.fg} /> : <Ionicons name={icon} size={size * 0.5} color={c.fg} />}
    </View>
  );
}

export function Banner({
  tone = "info",
  icon,
  title,
  children,
  style,
}: {
  tone?: Tone;
  icon?: IconName;
  title?: string;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const c = TONE[tone];
  const defaultIcon: IconName =
    tone === "danger" ? "alert-circle" : tone === "warning" ? "warning" : tone === "success" ? "checkmark-circle" : "information-circle";
  return (
    <View style={[s.banner, { backgroundColor: c.bg }, style]}>
      <Ionicons name={icon || defaultIcon} size={18} color={c.fg} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        {!!title && <Text style={[font.h3, { color: c.fg, fontSize: 13.5 }]}>{title}</Text>}
        {React.Children.toArray(children).length > 0 && React.Children.toArray(children).every((c) => typeof c === "string" || typeof c === "number" || (React.isValidElement(c) && c.type === Text)) ? (
          <Text style={[font.body, { fontSize: 13, lineHeight: 19, color: T.sub, marginTop: title ? 2 : 0 }]}>{children}</Text>
        ) : (
          children
        )}
      </View>
    </View>
  );
}

export function ProgressBar({ value, tone = "primary", height = 6 }: { value: number; tone?: Tone; height?: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View style={{ height, borderRadius: height, backgroundColor: T.line, overflow: "hidden" }}>
      <View style={{ width: `${pct}%`, height, borderRadius: height, backgroundColor: TONE[tone].fg }} />
    </View>
  );
}

/** Horizontal step tracker. `current` is the active index; anything before it is done. */
export function Steps({ steps, current }: { steps: { label: string; icon?: IconName }[]; current: number }) {
  return (
    <View style={s.steps}>
      {steps.map((st, i) => {
        const done = i < current;
        const active = i === current;
        const bg = done ? T.success : active ? T.primary : T.line;
        return (
          <React.Fragment key={st.label}>
            {i > 0 && <View style={[s.stepLine, (done || active) && { backgroundColor: done ? T.success : T.primary }]} />}
            <View style={{ alignItems: "center", width: 60 }}>
              <View style={[s.stepDot, { backgroundColor: bg }]}>
                {done ? (
                  <Ionicons name="checkmark" size={14} color="#fff" />
                ) : st.icon ? (
                  <Ionicons name={st.icon} size={14} color={active ? "#fff" : T.muted} />
                ) : (
                  <Text style={{ fontSize: 12, fontWeight: "800", color: active ? "#fff" : T.muted }}>{i + 1}</Text>
                )}
              </View>
              <Text style={[s.stepLabel, active && { color: T.primary, fontWeight: "700" }, done && { color: T.success }]} numberOfLines={1}>
                {st.label}
              </Text>
            </View>
          </React.Fragment>
        );
      })}
    </View>
  );
}

/** Initials of a name: first letter of the first and last word ("Priya Nair" -> "PN"). */
export function initialsOf(name: string, max = 2): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  const letters = [parts[0].charAt(0), parts[parts.length - 1].charAt(0)].join("").toUpperCase();
  return letters.slice(0, max);
}

export function Avatar({ name, tone = "neutral", size = 40, initials = false }: { name: string; tone?: Tone; size?: number; initials?: boolean }) {
  const c = TONE[tone];
  const text = initials ? initialsOf(name) : (name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2.8, backgroundColor: c.bg, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: size * (text.length > 1 ? 0.34 : 0.4), fontWeight: "800", color: c.fg }}>{text}</Text>
    </View>
  );
}

export function Stat({ value, label, tone = "neutral" }: { value: number | string; label: string; tone?: Tone }) {
  return (
    <View style={s.stat}>
      <Text style={[s.statNum, tone !== "neutral" && { color: TONE[tone].fg }]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, text }: { icon: IconName; title: string; text?: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: 36, paddingHorizontal: SP.xl, gap: SP.sm }}>
      <IconBadge icon={icon} tone="neutral" size={56} />
      <Text style={[font.h3, { marginTop: SP.sm }]}>{title}</Text>
      {!!text && <Text style={[font.body, { textAlign: "center" }]}>{text}</Text>}
    </View>
  );
}

/** Centred full-screen outcome (success / error / waiting / loading) with optional actions. */
export function ResultView({
  icon,
  tone,
  title,
  message,
  loading,
  children,
  actions,
}: {
  icon: IconName;
  tone: Tone;
  title: string;
  message?: string;
  loading?: boolean;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <View style={s.result}>
      <IconBadge icon={icon} tone={tone} size={92} loading={loading} />
      <Text style={[font.h1, { textAlign: "center", marginTop: SP.xl }]}>{title}</Text>
      {!!message && <Text style={[font.body, { textAlign: "center", marginTop: SP.sm, fontSize: 15, lineHeight: 22 }]}>{message}</Text>}
      {children}
      {!!actions && <View style={{ width: "100%", gap: SP.sm + 2, marginTop: SP.xxl }}>{actions}</View>}
    </View>
  );
}

/* ───────────────────────────── forms ───────────────────────────── */

/** Labelled text input with icon, inline error, helper text and a show/hide toggle for passwords. */
export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  icon,
  error,
  helper,
  secure = false,
  keyboardType,
  autoCapitalize = "none",
  autoComplete,
  textContentType,
  maxLength,
  returnKeyType,
  onSubmitEditing,
  inputRef,
  editable = true,
  right,
  style,
  multiline = false,
  minHeight,
  autoCorrect = false,
  phone = false,
}: {
  label?: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  icon?: IconName;
  error?: string | null;
  helper?: string;
  secure?: boolean;
  keyboardType?: any;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoComplete?: any;
  textContentType?: any;
  maxLength?: number;
  returnKeyType?: any;
  onSubmitEditing?: () => void;
  inputRef?: React.RefObject<any>;
  editable?: boolean;
  right?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Free-text areas (questions, descriptions): wraps, keeps spell-check and auto-correct on. */
  multiline?: boolean;
  minHeight?: number;
  autoCorrect?: boolean;
  /** Indian mobile number: shows a fixed +91 and keeps only the 10 digits that follow it. */
  phone?: boolean;
}) {
  const [focus, setFocus] = React.useState(false);
  const [shown, setShown] = React.useState(false);
  const border = error ? T.danger : focus ? T.primary : T.line;
  return (
    <View style={style}>
      {!!label && <Text style={s.fieldLabel}>{label}</Text>}
      <View style={[s.field, { borderColor: border, backgroundColor: editable ? T.surface : T.lineSoft }, focus && !error && s.fieldFocus, multiline && { alignItems: "flex-start", minHeight: minHeight ?? 96, paddingTop: 2 }]}>
        {icon && <Ionicons name={icon} size={19} color={focus ? T.primary : T.muted} style={multiline ? { marginTop: 15 } : undefined} />}
        {phone && <Text style={{ fontSize: 16, fontWeight: "700", color: T.ink }}>{PHONE_PREFIX}</Text>}
        <TextInput
          ref={inputRef}
          style={[s.fieldInput, multiline && { textAlignVertical: "top", minHeight: (minHeight ?? 96) - 8 }]}
          multiline={multiline}
          value={value}
          onChangeText={phone ? (t) => onChangeText(sanitizePhoneInput(t, value)) : onChangeText}
          placeholder={placeholder}
          placeholderTextColor={T.muted}
          secureTextEntry={secure && !shown}
          autoCapitalize={autoCapitalize}
          autoCorrect={multiline ? true : autoCorrect}
          autoComplete={autoComplete}
          textContentType={textContentType}
          keyboardType={phone ? "number-pad" : keyboardType}
          maxLength={phone ? 14 : maxLength}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          editable={editable}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          // never let the OS keep suggestions / history for secrets
          importantForAutofill={secure ? "yes" : "auto"}
          contextMenuHidden={secure}
          spellCheck={multiline}
        />
        {secure && (
          <Pressable onPress={() => setShown((v) => !v)} hitSlop={10} accessibilityLabel={shown ? "Hide password" : "Show password"}>
            <Ionicons name={shown ? "eye-off-outline" : "eye-outline"} size={20} color={T.sub} />
          </Pressable>
        )}
        {right}
      </View>
      {!!error ? (
        <View style={s.fieldMsg}>
          <Ionicons name="alert-circle" size={13} color={T.danger} />
          <Text style={[s.fieldMsgText, { color: T.danger }]}>{error}</Text>
        </View>
      ) : !!helper ? (
        <Text style={[s.fieldMsgText, { marginTop: 6, color: T.muted }]}>{helper}</Text>
      ) : null}
    </View>
  );
}

/** Label + helper text + native switch. */
export function ToggleRow({
  title,
  sub,
  value,
  onChange,
  disabled = false,
}: {
  title: string;
  sub?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SP.md, opacity: disabled ? 0.5 : 1 }}>
      <View style={{ flex: 1 }}>
        <Text style={font.h3}>{title}</Text>
        {!!sub && <Text style={[font.small, { marginTop: 2, fontSize: 12.5 }]}>{sub}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: T.line, true: T.primary }}
        thumbColor="#fff"
        accessibilityLabel={title}
      />
    </View>
  );
}

/** Two-to-four way segmented switch. */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: V; label: string; icon?: IconName }[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <View style={s.seg}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[s.segItem, on && s.segItemOn]}
          >
            {o.icon && <Ionicons name={o.icon} size={16} color={on ? T.primary : T.sub} />}
            <Text style={[s.segText, on && { color: T.primary }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Tap-to-open bottom-sheet picker (replaces hand-made dropdowns). */
export function SelectField({
  label,
  value,
  placeholder = "Select",
  options,
  onChange,
  icon,
  error,
  disabled = false,
  title,
}: {
  label?: string;
  value: string;
  placeholder?: string;
  options: { value: string; label: string; sub?: string }[];
  onChange: (v: string) => void;
  icon?: IconName;
  error?: string | null;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <View>
      {!!label && <Text style={s.fieldLabel}>{label}</Text>}
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        accessibilityRole="button"
        style={[s.field, { borderColor: error ? T.danger : T.line, backgroundColor: disabled ? T.lineSoft : T.surface }]}
      >
        {icon && <Ionicons name={icon} size={19} color={T.muted} />}
        <Text style={[s.fieldInput, { paddingVertical: 15, color: current ? T.ink : T.muted }]} numberOfLines={1}>
          {current ? current.label : placeholder}
        </Text>
        <Ionicons name="chevron-down" size={18} color={T.muted} />
      </Pressable>
      {!!error && (
        <View style={s.fieldMsg}>
          <Ionicons name="alert-circle" size={13} color={T.danger} />
          <Text style={[s.fieldMsgText, { color: T.danger }]}>{error}</Text>
        </View>
      )}
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.sheetBackdrop} onPress={() => setOpen(false)} />
        <View style={s.sheet}>
          <View style={s.sheetGrab} />
          <Text style={[font.h2, { marginBottom: SP.md }]}>{title || label || "Select"}</Text>
          <FlatList
            data={options}
            keyExtractor={(o) => o.value}
            style={{ maxHeight: 360 }}
            ListEmptyComponent={<Text style={[font.body, { paddingVertical: SP.lg }]}>Nothing to choose from yet.</Text>}
            renderItem={({ item }) => {
              const on = item.value === value;
              return (
                <Pressable
                  onPress={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                  style={[s.option, on && { backgroundColor: T.primarySoft }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[font.h3, on && { color: T.primary }]}>{item.label}</Text>
                    {!!item.sub && <Text style={font.small}>{item.sub}</Text>}
                  </View>
                  {on && <Ionicons name="checkmark-circle" size={20} color={T.primary} />}
                </Pressable>
              );
            }}
          />
        </View>
      </Modal>
    </View>
  );
}

/**
 * Bottom sheet. Tap the dim area or press Android back to close. Content scrolls when tall and lifts above the keyboard.
 */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  maxHeight = "86%",
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  maxHeight?: `${number}%` | number;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(15,23,42,0.45)" }]} onPress={onClose} accessibilityLabel="Close" />
        <View style={[s.sheet, { maxHeight }]}>
          <View style={s.sheetGrab} />
          {!!title && <Text style={font.h2}>{title}</Text>}
          {!!subtitle && <Text style={[font.body, { marginTop: 2 }]}>{subtitle}</Text>}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={{ flexGrow: 0, marginTop: title ? SP.md : 0 }}
          >
            {children}
          </ScrollView>
          {footer}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Live password strength: bar + the rules still missing. `checks` comes from utils/validation.passwordChecks. */
export function PasswordMeter({ checks }: { checks: { ok: boolean; label: string }[] }) {
  const done = checks.filter((c) => c.ok).length;
  const frac = checks.length ? done / checks.length : 0;
  const tone: Tone = frac < 0.5 ? "danger" : frac < 1 ? "warning" : "success";
  const word = frac < 0.5 ? "Weak" : frac < 1 ? "Almost there" : "Strong";
  return (
    <View style={{ gap: 8, marginTop: SP.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SP.sm }}>
        <View style={{ flex: 1 }}>
          <ProgressBar value={frac} tone={tone} height={5} />
        </View>
        <Text style={{ fontSize: 12, fontWeight: "700", color: TONE[tone].fg }}>{word}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {checks.map((c) => (
          <Chip key={c.label} label={c.label} tone={c.ok ? "success" : "neutral"} icon={c.ok ? "checkmark" : "ellipse-outline"} />
        ))}
      </View>
    </View>
  );
}

/* ───────────────────────────── helpers ───────────────────────────── */

/** Copy text to the clipboard with whichever library the app has (expo-clipboard preferred). */
export async function copyText(text: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("expo-clipboard");
    await mod.setStringAsync(text);
    return true;
  } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rn = require("react-native");
    if (rn.Clipboard?.setString) {
      rn.Clipboard.setString(text);
      return true;
    }
  } catch {}
  return false;
}

/* ───────────────────────────── styles ───────────────────────────── */

const s = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: SP.md, paddingHorizontal: SP.lg, paddingVertical: SP.md, backgroundColor: T.surface },
  headerBorder: { borderBottomWidth: 1, borderBottomColor: T.line },
  backBtn: { width: 38, height: 38, borderRadius: R.sm + 2, alignItems: "center", justifyContent: "center", backgroundColor: T.bg, borderWidth: 1, borderColor: T.line },

  card: { backgroundColor: T.surface, borderRadius: R.lg, borderWidth: 1, borderColor: T.line },

  btn: { height: 52, borderRadius: R.md, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: SP.xl },
  btnGlow: Platform.select<ViewStyle>({
    ios: { shadowColor: T.primary, shadowOpacity: 0.28, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
    android: { elevation: 3 },
    default: {},
  }) as ViewStyle,
  btnText: { fontSize: 16, fontWeight: "700" },

  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 2, borderColor: "#C5CBD8", alignItems: "center", justifyContent: "center" },

  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: R.pill, alignSelf: "flex-start" },
  chipText: { fontSize: 11.5, fontWeight: "700" },

  statusPill: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: SP.md, paddingVertical: 10, borderRadius: R.md },
  statusPillText: { flex: 1, fontSize: 12, fontWeight: "700" },

  live: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: R.pill },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { fontSize: 11, fontWeight: "800", letterSpacing: 1 },

  banner: { flexDirection: "row", gap: 10, padding: SP.md + 2, borderRadius: R.md },

  steps: { flexDirection: "row", alignItems: "flex-start", justifyContent: "center" },
  stepDot: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  stepLine: { flex: 1, height: 2, backgroundColor: T.line, marginTop: 14, marginHorizontal: -6 },
  stepLabel: { fontSize: 11, color: T.muted, marginTop: 6, fontWeight: "600" },

  stat: { flex: 1, alignItems: "center", paddingVertical: SP.md },
  statNum: { fontSize: 24, fontWeight: "800", color: T.ink },
  statLabel: { fontSize: 11, fontWeight: "700", color: T.muted, marginTop: 2, letterSpacing: 0.6, textTransform: "uppercase" },

  result: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: SP.xxl },

  fieldLabel: { fontSize: 12.5, fontWeight: "700", color: T.sub, marginBottom: 7, letterSpacing: 0.2 },
  field: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1.5, borderRadius: R.md, paddingHorizontal: SP.lg, minHeight: 54 },
  fieldFocus: Platform.select<ViewStyle>({ ios: { shadowColor: T.primary, shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } }, default: {} }) as ViewStyle,
  fieldInput: { flex: 1, fontSize: 15.5, color: T.ink, paddingVertical: 12 },
  fieldMsg: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 },
  fieldMsgText: { fontSize: 12, fontWeight: "600" },

  seg: { flexDirection: "row", backgroundColor: T.lineSoft, borderRadius: R.md, padding: 4 },
  segItem: { flex: 1, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", paddingVertical: 11, borderRadius: R.sm + 2 },
  segItemOn: { backgroundColor: T.surface, ...(shadow as object) },
  segText: { fontSize: 14, fontWeight: "700", color: T.sub },

  sheetBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.45)" },
  sheet: { backgroundColor: T.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: SP.xl, paddingBottom: SP.xxl },
  sheetGrab: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: T.line, marginBottom: SP.lg },
  option: { flexDirection: "row", alignItems: "center", gap: SP.md, paddingHorizontal: SP.md, paddingVertical: SP.md + 2, borderRadius: R.md },
});