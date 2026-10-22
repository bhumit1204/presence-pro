// screens/work/workShared.tsx
// Shared pieces for the classwork screens (assignments, announcements, submissions):
// formatting, API helper, file / link rows, attachment editor and the due-date field.

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import * as DocumentPicker from "expo-document-picker";
import DateTimePicker from "@react-native-community/datetimepicker";
import { apiFetch, API_BASE } from "../../services/api";
import { Button, Chip, Header, IconBadge, R, SP, Screen, SectionLabel, T, TONE, TextField, Tone, font } from "../../components/ui";

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

/* ───────────── kind: lecture work, lab work, tutorial work ───────────── */
export type WorkKind = "assignment" | "lab_work" | "tutorial_work";
export const KIND_ORDER: WorkKind[] = ["assignment", "lab_work", "tutorial_work"];
/** Long names, used on cards and headers. */
export const KIND_LABEL: Record<WorkKind, string> = { assignment: "Lecture work", lab_work: "Lab work", tutorial_work: "Tutorial work" };
/** Short names, used on filter chips. */
export const KIND_SHORT: Record<WorkKind, string> = { assignment: "Lecture", lab_work: "Lab", tutorial_work: "Tutorial" };
export const KIND_ICON: Record<WorkKind, IconName> = { assignment: "document-text-outline", lab_work: "flask-outline", tutorial_work: "school-outline" };
export const KIND_TONE: Record<WorkKind, Tone> = { assignment: "primary", lab_work: "success", tutorial_work: "info" };
/** Old assignments have no kind: they are lecture work. */
export const kindOf = (a: any): WorkKind => (a?.kind === "lab_work" || a?.kind === "tutorial_work" ? a.kind : "assignment");

/** "draft" | "scheduled" | "published". Older assignments have no state: they are published. */
export type WorkState = "draft" | "scheduled" | "published";
export function stateOf(a: any): WorkState {
  if (a?.state === "draft" || a?.state === "scheduled") return a.state;
  if (a?.status === "draft") return "draft";
  if (a?.status === "scheduled" && a?.publish_at && new Date(a.publish_at).getTime() > Date.now()) return "scheduled";
  return "published";
}

/** What kinds of work a subject can have. Lab work needs a lab, tutorial work needs a tutorial. */
export function kindOptions(subject: any): Record<WorkKind, boolean> {
  // the subject documents carry has_lab / has_tutorial / kind; if a screen was given something slimmer, leave the choice open (the server checks)
  const full = !!subject && ("compulsary" in subject || "teacher_assigned" in subject || "has_lab" in subject || "has_tutorial" in subject);
  if (!full) return { assignment: true, lab_work: true, tutorial_work: true };
  return { assignment: true, lab_work: subject.kind === "lab" || !!subject.has_lab, tutorial_work: !!subject.has_tutorial && subject.kind !== "lab" };
}

/** Choose lecture work, lab work or tutorial work. Kinds the subject does not have are greyed out. */
export function KindPicker({ value, onChange, subject, disabled = false }: { value: WorkKind; onChange: (k: WorkKind) => void; subject?: any; disabled?: boolean }) {
  const ok = kindOptions(subject);
  const hint =
    value === "lab_work" ? "Lab work goes to the whole division, not to one batch."
    : value === "tutorial_work" ? "Tutorial work goes to everyone who takes this subject."
    : !ok.lab_work && !ok.tutorial_work ? "This subject has no lab or tutorial. Add one in Manage > Subjects on the web to post lab or tutorial work."
    : "";
  return (
    <View>
      <Text style={[font.label, { marginBottom: SP.sm }]}>Type</Text>
      <View style={{ flexDirection: "row", gap: SP.sm }}>
        {KIND_ORDER.map((k) => {
          const on = value === k;
          const off = !ok[k] && !on;
          return (
            <Pressable
              key={k}
              onPress={() => onChange(k)}
              disabled={disabled || off}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, disabled: disabled || off }}
              accessibilityLabel={KIND_LABEL[k]}
              style={{
                flex: 1,
                alignItems: "center",
                gap: 4,
                paddingVertical: SP.md,
                paddingHorizontal: 4,
                borderRadius: R.md,
                borderWidth: 1.5,
                borderColor: on ? T.primary : T.line,
                backgroundColor: on ? T.primarySoft : T.surface,
                opacity: off ? 0.4 : 1,
              }}
            >
              <Ionicons name={KIND_ICON[k]} size={20} color={on ? T.primary : T.sub} />
              <Text style={{ fontSize: 12.5, fontWeight: "800", color: on ? T.primary : T.sub }} numberOfLines={1}>{KIND_SHORT[k]}</Text>
            </Pressable>
          );
        })}
      </View>
      {!!hint && <Text style={[font.small, { marginTop: SP.sm }]}>{hint}</Text>}
    </View>
  );
}

/** A row of All / Lecture / Lab / Tutorial chips with counts. Renders nothing when only one kind exists. */
export function KindFilter({ value, onChange, items }: { value: WorkKind | "all"; onChange: (k: WorkKind | "all") => void; items: any[] }) {
  const counts: Record<WorkKind, number> = { assignment: 0, lab_work: 0, tutorial_work: 0 };
  items.forEach((a) => { counts[kindOf(a)]++; });
  if (KIND_ORDER.filter((k) => counts[k] > 0).length < 2) return null;
  const opts: { key: WorkKind | "all"; label: string; n: number }[] = [
    { key: "all", label: "All", n: items.length },
    ...KIND_ORDER.filter((k) => counts[k] > 0).map((k) => ({ key: k, label: KIND_SHORT[k], n: counts[k] })),
  ];
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SP.sm, marginBottom: SP.md }}>
      {opts.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: R.pill, borderWidth: 1, borderColor: on ? T.primary : T.line, backgroundColor: on ? T.primarySoft : T.surface }}
          >
            {o.key !== "all" && <Ionicons name={KIND_ICON[o.key]} size={14} color={on ? T.primary : T.sub} />}
            <Text style={{ fontSize: 12.5, fontWeight: "700", color: on ? T.primary : T.sub }}>{o.label} {o.n}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ───────────── classwork tags (topics): "CA Assignment", "Syllabus", ... ───────────── */
export interface WorkTag { tag_id: string; name: string; order?: number }

/** The tags of one subject. Failing to load them never blocks the screen: the list is just empty. */
export function useTags(subject_id?: string, course_id?: string) {
  const [tags, setTags] = useState<WorkTag[]>([]);
  const reload = useCallback(async () => {
    if (!subject_id || !course_id) return [] as WorkTag[];
    try {
      const r = await api<{ tags: WorkTag[] }>(`/api/assignments/tags?subject_id=${encodeURIComponent(subject_id)}&course_id=${encodeURIComponent(course_id)}`);
      setTags(r.tags || []);
      return r.tags || [];
    } catch { return [] as WorkTag[]; }
  }, [subject_id, course_id]);
  useEffect(() => { reload(); }, [reload]);
  return { tags, reload, setTags };
}

export const tagNameOf = (tags: WorkTag[], id?: string | null): string | null => (id ? tags.find((t) => t.tag_id === id)?.name ?? null : null);

/** "all", a tag id, or "none" (work without a tag). */
export type TagSel = "all" | "none" | string;
export const applyTagFilter = <X extends { tag_id?: string | null }>(items: X[], sel: TagSel): X[] =>
  sel === "all" ? items : sel === "none" ? items.filter((x) => !x.tag_id) : items.filter((x) => x.tag_id === sel);

/** Items grouped by tag, in the teacher's tag order, untagged last. One unnamed group when nothing is tagged. */
export function groupByTag<X extends { tag_id?: string | null }>(items: X[], tags: WorkTag[]): { key: string; label: string; items: X[] }[] {
  const known = new Set(tags.map((t) => t.tag_id));
  const tagged = items.filter((x) => x.tag_id && known.has(x.tag_id));
  if (!tagged.length) return [{ key: "all", label: "", items }];
  const out = tags.map((t) => ({ key: t.tag_id, label: t.name, items: items.filter((x) => x.tag_id === t.tag_id) })).filter((g) => g.items.length);
  const rest = items.filter((x) => !x.tag_id || !known.has(x.tag_id));
  if (rest.length) out.push({ key: "none", label: "Other", items: rest });
  return out;
}

/** Filter chips: All / each tag in use / Other. Nothing is shown when no item is tagged. */
export function TagFilter({ tags, items, value, onChange }: { tags: WorkTag[]; items: { tag_id?: string | null }[]; value: TagSel; onChange: (v: TagSel) => void }) {
  const known = new Set(tags.map((t) => t.tag_id));
  const used = tags.filter((t) => items.some((x) => x.tag_id === t.tag_id));
  if (!used.length) return null;
  const rest = items.filter((x) => !x.tag_id || !known.has(x.tag_id)).length;
  const opts: { key: TagSel; label: string; n: number }[] = [
    { key: "all", label: "All", n: items.length },
    ...used.map((t) => ({ key: t.tag_id, label: t.name, n: items.filter((x) => x.tag_id === t.tag_id).length })),
    ...(rest ? [{ key: "none", label: "Other", n: rest }] : []),
  ];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: SP.md, flexGrow: 0 }} contentContainerStyle={{ gap: SP.sm }}>
      {opts.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: R.pill, borderWidth: 1, borderColor: on ? T.primary : T.line, backgroundColor: on ? T.primarySoft : T.surface }}
          >
            {o.key !== "all" && <Ionicons name="pricetag-outline" size={13} color={on ? T.primary : T.sub} />}
            <Text style={{ fontSize: 12.5, fontWeight: "700", color: on ? T.primary : T.sub }}>{o.label} {o.n}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Rename and delete the tags of a subject. Deleting a tag keeps its work, it just becomes untagged. */
function TagManager({ tags, teacher_id, onClose, onChanged }: { tags: WorkTag[]; teacher_id: string; onClose: () => void; onChanged: () => void }) {
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(tags.map((t) => [t.tag_id, t.name])));
  const [busy, setBusy] = useState<string | null>(null);
  const save = async (t: WorkTag) => {
    const name = (names[t.tag_id] || "").trim();
    if (!name || name === t.name) return;
    setBusy(t.tag_id);
    try { await api(`/api/assignments/tags/${t.tag_id}`, jsonInit("PUT", { teacher_id, name })); onChanged(); }
    catch (e: any) { Alert.alert("Could not rename", e.message); setNames((n) => ({ ...n, [t.tag_id]: t.name })); }
    finally { setBusy(null); }
  };
  const remove = (t: WorkTag) =>
    Alert.alert(`Delete "${t.name}"?`, "Work with this tag stays, it just loses the tag.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          setBusy(t.tag_id);
          try { await api(`/api/assignments/tags/${t.tag_id}?teacher_id=${encodeURIComponent(teacher_id)}`, { method: "DELETE" }); onChanged(); }
          catch (e: any) { Alert.alert("Could not delete", e.message); }
          finally { setBusy(null); }
        },
      },
    ]);
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Screen>
        <Header
          title="Manage tags"
          right={
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={{ padding: SP.xs }}>
              <Ionicons name="close" size={24} color={T.sub} />
            </Pressable>
          }
        />
        <ScrollView contentContainerStyle={{ padding: SP.lg, gap: SP.md }} keyboardShouldPersistTaps="handled">
          {tags.length === 0 && <Text style={font.body}>No tags yet. Add one while posting.</Text>}
          {tags.map((t) => (
            <View key={t.tag_id} style={{ flexDirection: "row", alignItems: "center", gap: SP.sm }}>
              <View style={{ flex: 1 }}>
                <TextField
                  label=""
                  value={names[t.tag_id] ?? t.name}
                  onChangeText={(v) => setNames((n) => ({ ...n, [t.tag_id]: v }))}
                  onBlur={() => save(t)}
                  onSubmitEditing={() => save(t)}
                  maxLength={40}
                  editable={busy !== t.tag_id}
                />
              </View>
              {busy === t.tag_id ? <ActivityIndicator color={T.primary} /> : (
                <Pressable onPress={() => remove(t)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Delete ${t.name}`} style={{ padding: SP.sm }}>
                  <Ionicons name="trash-outline" size={20} color={T.danger} />
                </Pressable>
              )}
            </View>
          ))}
        </ScrollView>
      </Screen>
    </Modal>
  );
}

/**
 * Teacher: pick the tag of a post, make a new one on the spot, or manage the list.
 * `value` is a tag id or null. A new tag is selected right away.
 */
export function TagPicker({ subject_id, course_id, teacher_id, value, onChange, disabled = false }: {
  subject_id: string; course_id: string; teacher_id: string; value: string | null; onChange: (id: string | null) => void; disabled?: boolean;
}) {
  const { tags, reload } = useTags(subject_id, course_id);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [manage, setManage] = useState(false);

  const add = async () => {
    const n = name.trim();
    if (!n || saving) return;
    setSaving(true);
    try {
      const r = await api<{ tag: WorkTag }>("/api/assignments/tags", jsonInit("POST", { teacher_id, subject_id, course_id, name: n }));
      await reload();
      onChange(r.tag.tag_id);
      setName(""); setAdding(false);
    } catch (e: any) { Alert.alert("Could not add the tag", e.message); }
    finally { setSaving(false); }
  };

  const chip = (label: string, on: boolean, press: () => void, icon?: IconName) => (
    <Pressable
      key={label}
      onPress={press}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: R.pill, borderWidth: 1, borderColor: on ? T.primary : T.line, backgroundColor: on ? T.primarySoft : T.surface, opacity: disabled ? 0.6 : 1 }}
    >
      {icon && <Ionicons name={icon} size={13} color={on ? T.primary : T.sub} />}
      <Text style={{ fontSize: 12.5, fontWeight: "700", color: on ? T.primary : T.sub }}>{label}</Text>
    </Pressable>
  );

  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: SP.sm }}>
        <Text style={[font.label, { flex: 1 }]}>Tag (optional)</Text>
        {tags.length > 0 && (
          <Pressable onPress={() => setManage(true)} disabled={disabled} hitSlop={8} accessibilityRole="button">
            <Text style={{ color: T.primary, fontWeight: "700", fontSize: 12.5 }}>Manage</Text>
          </Pressable>
        )}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SP.sm }}>
        {chip("No tag", value === null, () => onChange(null))}
        {tags.map((t) => chip(t.name, value === t.tag_id, () => onChange(t.tag_id), "pricetag-outline"))}
        {chip("New tag", adding, () => setAdding((v) => !v), "add")}
      </View>
      {adding && (
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: SP.sm, marginTop: SP.sm }}>
          <View style={{ flex: 1 }}>
            <TextField label="" value={name} onChangeText={setName} placeholder="e.g. CA Assignment, Syllabus" maxLength={40} autoCapitalize="sentences" onSubmitEditing={add} editable={!saving} />
          </View>
          <Button label="Add" size="md" onPress={add} loading={saving} disabled={!name.trim()} />
        </View>
      )}
      {manage && (
        <TagManager
          tags={tags}
          teacher_id={teacher_id}
          onClose={() => setManage(false)}
          onChanged={async () => {
            const fresh = await reload();
            if (value && !fresh.some((t) => t.tag_id === value)) onChange(null);
          }}
        />
      )}
    </View>
  );
}

/** The next full hour, the default time to post a scheduled assignment. */
export function defaultPublishAt(): Date {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d;
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