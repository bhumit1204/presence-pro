// screens/work/workShared.tsx
// Shared pieces for the classwork screens (assignments, announcements, submissions):
// formatting, API helper, file / link rows, attachment editor and the due-date field.

import React, { useState } from "react";
import { Alert, Linking, Platform, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import * as DocumentPicker from "expo-document-picker";
import DateTimePicker from "@react-native-community/datetimepicker";
import { apiFetch, API_BASE } from "../../services/api";
import { Button, Chip, IconBadge, R, SP, SectionLabel, T, TONE, TextField, Tone, font } from "../../components/ui";

export const API_URL = API_BASE;
export type IconName = React.ComponentProps<typeof Ionicons>["name"];

/* ───────────── types ───────────── */
export interface Attachment {
  url: string;
  key?: string;
  name: string;
  size?: number;
  type?: string;
}
export interface LinkItem {
  url: string;
  label: string;
}

/* ───────────── dates ───────────── */
function toDate(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
/** "12 Oct 2026, 11:59 pm" */
export function fmtDateTime(iso?: string | null): string {
  const d = toDate(iso);
  if (!d) return "-";
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}
/** "12 Oct 2026" */
export function fmtDay(iso?: string | null): string {
  const d = toDate(iso);
  return d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";
}
/** "12 Oct" */
export function fmtShort(iso?: string | null): string {
  const d = toDate(iso);
  return d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "-";
}
export function isPastDue(iso?: string | null): boolean {
  const d = toDate(iso);
  return !!d && d.getTime() < Date.now();
}
export function isPinActive(item: { is_pinned?: boolean; pin_expires_at?: string | null }): boolean {
  if (!item?.is_pinned) return false;
  if (!item.pin_expires_at) return true;
  const d = toDate(item.pin_expires_at);
  return !d || d.getTime() > Date.now();
}
/** Millisecond timestamp for sorting; missing dates sort last. */
export const ts = (iso?: string | null): number => toDate(iso)?.getTime() ?? 0;

/* ───────────── files ───────────── */
export function fileIcon(type?: string | null): IconName {
  const t = (type || "").toLowerCase();
  if (t.includes("pdf")) return "document-text-outline";
  if (t.includes("image")) return "image-outline";
  if (t.includes("sheet") || t.includes("excel")) return "grid-outline";
  if (t.includes("presentation") || t.includes("powerpoint")) return "easel-outline";
  if (t.includes("word") || t.includes("document")) return "document-outline";
  return "attach-outline";
}
export function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export async function openUrl(url?: string | null) {
  if (!url) return;
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert("Could not open", "This file or link could not be opened.");
    }
  }
}

/** Accepts "example.com/x" (adds https://) and rejects anything that is not a web address. */
export function normalizeUrl(input: string): string | null {
  let v = input.trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `https://${v}`;
  return /^https?:\/\/[^\s/]+\.[^\s/]{2,}(\S*)$/i.test(v) || /^https?:\/\/localhost(:\d+)?(\S*)$/i.test(v) ? v : null;
}

/* ───────────── API ───────────── */
function friendly(e: any): string {
  const m = String(e?.message || "");
  if (/network request failed|failed to fetch|timeout|abort/i.test(m)) return "Could not reach the server. Check your connection.";
  return m || "Something went wrong.";
}
/**
 * Call the API and return the parsed body. Throws an Error with a readable message
 * when the request fails, the body is not JSON, or `success` is false.
 */
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(`${API_URL}${path}`, init);
  } catch (e) {
    throw new Error(friendly(e));
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok || !data || data.success === false) {
    throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  }
  return data as T;
}
export const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Upload picked files to the shared upload endpoint. */
export async function uploadFiles(files: DocumentPicker.DocumentPickerAsset[], folder: "assignments" | "announcements" | "submissions", entityId?: string): Promise<Attachment[]> {
  if (!files.length) return [];
  const fd = new FormData();
  fd.append("folder", folder);
  if (entityId) fd.append("entity_id", entityId);
  files.forEach((f) => fd.append("files", { uri: f.uri, name: f.name, type: f.mimeType || "application/octet-stream" } as any));
  const data = await api<{ files: Attachment[] }>("/api/assignments/upload", { method: "POST", body: fd });
  return data.files || [];
}

/* ───────────── rows ───────────── */
/** One file or link line. Tap opens it; `onRemove` shows a remove button instead of the open arrow. */
export function FileRow({
  icon,
  name,
  meta,
  tone = "primary",
  onPress,
  onRemove,
  dashed = false,
}: {
  icon: IconName;
  name: string;
  meta?: string;
  tone?: Tone;
  onPress?: () => void;
  onRemove?: () => void;
  dashed?: boolean;
}) {
  const c = TONE[tone];
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: SP.md,
        backgroundColor: T.surface,
        borderRadius: R.md,
        borderWidth: 1,
        borderStyle: dashed ? "dashed" : "solid",
        borderColor: dashed ? T.primary : T.line,
        padding: SP.md,
        marginBottom: SP.sm,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: c.bg, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={19} color={c.fg} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[font.h3, { fontSize: 13.5 }]} numberOfLines={1}>
          {name}
        </Text>
        {!!meta && <Text style={[font.small, { marginTop: 1 }]}>{meta}</Text>}
      </View>
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${name}`}>
          <Ionicons name="close-circle" size={22} color={T.danger} />
        </Pressable>
      ) : onPress ? (
        <Ionicons name="open-outline" size={17} color={T.muted} />
      ) : null}
    </Pressable>
  );
}

/** Read-only list of attachments and links. Renders nothing when both are empty. */
export function ResourceList({ attachments, links }: { attachments?: Attachment[] | null; links?: LinkItem[] | null }) {
  const files = attachments || [];
  const urls = links || [];
  if (!files.length && !urls.length) return null;
  return (
    <View>
      {files.map((a, i) => (
        <FileRow key={a.key || `${a.url}-${i}`} icon={fileIcon(a.type)} name={a.name || "File"} meta={formatBytes(a.size)} onPress={() => openUrl(a.url)} />
      ))}
      {urls.map((l, i) => (
        <FileRow key={`${l.url}-${i}`} icon="link-outline" tone="success" name={l.label || l.url} onPress={() => openUrl(l.url)} />
      ))}
    </View>
  );
}


/* ───────────── list card ───────────── */
/** Feed card: icon, title, optional text, date line and chips. Used by the student and teacher feeds. */
export function ItemCard({
  icon,
  tone = "primary",
  title,
  line,
  meta,
  chips,
  onPress,
  pinned = false,
}: {
  icon: IconName;
  tone?: Tone;
  title: string;
  line?: string;
  meta?: string;
  chips?: { label: string; tone?: Tone }[];
  onPress: () => void;
  pinned?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: SP.md,
        alignItems: "flex-start",
        backgroundColor: T.surface,
        borderRadius: R.md,
        borderWidth: pinned ? 1.5 : 1,
        borderColor: pinned ? T.primary : T.line,
        padding: SP.md,
        marginBottom: SP.sm,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <IconBadge icon={icon} tone={tone} size={42} />
      <View style={{ flex: 1 }}>
        <Text style={font.h3} numberOfLines={2}>
          {title}
        </Text>
        {!!line && (
          <Text style={[font.body, { fontSize: 13, lineHeight: 18, marginTop: 2 }]} numberOfLines={2}>
            {line}
          </Text>
        )}
        {!!meta && <Text style={[font.small, { marginTop: 3 }]}>{meta}</Text>}
        {!!chips?.length && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: SP.sm }}>
            {chips.map((c) => (
              <Chip key={c.label} label={c.label} tone={c.tone} />
            ))}
          </View>
        )}
      </View>
      <Ionicons name="chevron-forward" size={17} color={T.muted} style={{ marginTop: 4 }} />
    </Pressable>
  );
}

/* ───────────── attachment editor ───────────── */
export const MAX_NEW_FILES = 10;

/**
 * Add files and links, and remove them again. Fully controlled:
 *  - `existing`  files already stored on the server (removable through onRemoveExisting)
 *  - `files`     newly picked files that are not uploaded yet
 *  - `links`     every link of the item (existing and new)
 */
export function AttachmentEditor({
  existing = [],
  onRemoveExisting,
  files,
  onFiles,
  links,
  onLinks,
  disabled = false,
}: {
  existing?: Attachment[];
  onRemoveExisting?: (a: Attachment) => void;
  files: DocumentPicker.DocumentPickerAsset[];
  onFiles: (f: DocumentPicker.DocumentPickerAsset[]) => void;
  links: LinkItem[];
  onLinks: (l: LinkItem[]) => void;
  disabled?: boolean;
}) {
  const [linkText, setLinkText] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const pick = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (r.canceled || !r.assets?.length) return;
      const known = new Set(files.map((f) => f.uri));
      const fresh = r.assets.filter((a) => !known.has(a.uri));
      const next = [...files, ...fresh];
      if (next.length > MAX_NEW_FILES) {
        Alert.alert("Too many files", `You can add up to ${MAX_NEW_FILES} files at a time.`);
        onFiles(next.slice(0, MAX_NEW_FILES));
        return;
      }
      onFiles(next);
    } catch {
      Alert.alert("Error", "Could not pick files.");
    }
  };

  const addLink = () => {
    if (!linkText.trim()) return;
    const url = normalizeUrl(linkText);
    if (!url) {
      setLinkError("Enter a valid web address, for example https://example.com");
      return;
    }
    if (links.some((l) => l.url === url)) {
      setLinkError("This link is already added.");
      return;
    }
    onLinks([...links, { url, label: url }]);
    setLinkText("");
    setLinkError(null);
  };

  return (
    <View>
      {existing.map((a, i) => (
        <FileRow
          key={a.key || `${a.url}-${i}`}
          icon={fileIcon(a.type)}
          name={a.name || "File"}
          meta={formatBytes(a.size)}
          onPress={() => openUrl(a.url)}
          onRemove={onRemoveExisting && !disabled ? () => onRemoveExisting(a) : undefined}
        />
      ))}
      {files.map((f, i) => (
        <FileRow
          key={`${f.uri}-${i}`}
          icon={fileIcon(f.mimeType)}
          name={f.name}
          meta={f.size ? `${formatBytes(f.size)} - will upload on save` : "Will upload on save"}
          dashed
          onRemove={disabled ? undefined : () => onFiles(files.filter((_, j) => j !== i))}
        />
      ))}
      {links.map((l, i) => (
        <FileRow
          key={`${l.url}-${i}`}
          icon="link-outline"
          tone="success"
          name={l.label || l.url}
          onPress={() => openUrl(l.url)}
          onRemove={disabled ? undefined : () => onLinks(links.filter((_, j) => j !== i))}
        />
      ))}

      <Button label="Add files" icon="attach" variant="secondary" size="md" onPress={pick} disabled={disabled} style={{ marginTop: SP.xs }} />

      <View style={{ flexDirection: "row", gap: SP.sm, marginTop: SP.md, alignItems: "flex-start" }}>
        <TextField
          value={linkText}
          onChangeText={(t) => {
            setLinkText(t);
            if (linkError) setLinkError(null);
          }}
          placeholder="Paste a link"
          icon="link-outline"
          keyboardType="url"
          error={linkError}
          editable={!disabled}
          returnKeyType="done"
          onSubmitEditing={addLink}
          style={{ flex: 1 }}
        />
        <Button label="Add" size="md" variant="secondary" onPress={addLink} disabled={disabled || !linkText.trim()} style={{ height: 52, paddingHorizontal: SP.lg }} />
      </View>
    </View>
  );
}

/* ───────────── date and time ───────────── */
/** Date and time buttons for a single Date value. The time of day is kept when the date changes, and the other way round. */
export function DateTimeField({
  label,
  value,
  onChange,
  minimumDate,
  error,
}: {
  label: string;
  value: Date;
  onChange: (d: Date) => void;
  minimumDate?: Date;
  error?: string | null;
}) {
  const [open, setOpen] = useState<null | "date" | "time">(null);
  const ios = Platform.OS === "ios";

  const handle = (mode: "date" | "time") => (event: any, picked?: Date) => {
    if (!ios) setOpen(null);
    if (event?.type === "dismissed" || !picked) return;
    const next = new Date(value);
    if (mode === "date") next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
    else next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
    onChange(next);
  };

  const field = (mode: "date" | "time", icon: IconName, text: string, grow: number) => (
    <Pressable
      onPress={() => setOpen(open === mode ? null : mode)}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flex: grow,
        minWidth: 0,
        flexDirection: "row",
        alignItems: "center",
        gap: SP.sm,
        height: 52,
        paddingHorizontal: SP.md,
        borderRadius: R.md,
        borderWidth: 1.5,
        borderColor: error ? T.danger : open === mode ? T.primary : T.line,
        backgroundColor: T.surface,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={18} color={T.primary} />
      <Text style={[font.h3, { fontSize: 14, flex: 1 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
        {text}
      </Text>
    </Pressable>
  );

  return (
    <View>
      <Text style={[font.label, { marginBottom: SP.sm }]}>{label}</Text>
      <View style={{ flexDirection: "row", gap: SP.sm }}>
        {field("date", "calendar-outline", value.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }), 3)}
        {field("time", "time-outline", value.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }), 2)}
      </View>
      {!!error && <Text style={{ color: T.danger, fontSize: 12.5, marginTop: SP.xs }}>{error}</Text>}
      {open && (
        <View>
          <DateTimePicker
            value={value}
            mode={open}
            minimumDate={open === "date" ? minimumDate : undefined}
            display={ios ? "spinner" : "default"}
            onChange={handle(open)}
          />
          {ios && <Button label="Done" variant="ghost" size="md" onPress={() => setOpen(null)} />}
        </View>
      )}
    </View>
  );
}

/** A labelled card section header used above groups of rows. */
export function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: SP.lg }}>
      <SectionLabel>{title}</SectionLabel>
      {children}
    </View>
  );
}

/** Start of today, used as the earliest selectable due date. */
export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
/** Today 23:59, the default due time. */
export function defaultDueDate(): Date {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return d;
}