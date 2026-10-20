// screens/quiz/teacher/components/quizViewConstants.ts
// Colours mirror the shared kit (components/ui.tsx); exports are unchanged so other screens keep working.
import { API_BASE } from "../../../../services/api";

export const PRIMARY       = "#4834D4";
export const PRIMARY_LIGHT = "#EEF0FF";
export const BG            = "#F5F6FA";
export const GREEN         = "#0E9F6E";
export const GREEN_LIGHT   = "#DCF5EA";
export const AMBER         = "#C77700";
export const AMBER_LIGHT   = "#FFF3D6";
export const RED           = "#DC2626";
export const RED_LIGHT     = "#FDE8E8";
export const GREY          = "#64748B";

export const API_URL = API_BASE;

// ─── Types ─────────────────────────────────────────────────────────────────────
export type QuizStatus = "live" | "scheduled" | "completed";

/** The server stores MCQ options either as plain strings or as { text, image_url } (manual quizzes with pictures). */
export type QuizOptionValue = string | { text: string; image_url?: string | null };

export interface QuizQuestion {
  question_id: string;
  order: number;
  type: "mcq" | "open_ended";
  question: string;
  image_url?: string | null;
  options: QuizOptionValue[] | null;
  correct_answer: string;
  marks: number;
}

export interface Submission {
  submission_id: string;
  student_uid: string;
  student_name?: string;
  student_roll?: string;
  marks_obtained: number;
  percentage: number;
  submitted_at: string | null;
}

export interface Quiz {
  quiz_id: string;
  teacher_id: string;
  subject_name: string;
  title: string;
  description?: string;
  /** null for open quizzes */
  join_code: string | null;
  join_code_expiry_at?: string | null;
  question_count: number;
  total_marks: number;
  time_limit_minutes: number;
  scheduled_start: string;
  scheduled_end: string;
  question_type: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
export function getStatus(quiz: Quiz): QuizStatus {
  const now   = new Date();
  const start = new Date(quiz.scheduled_start);
  const end   = new Date(quiz.scheduled_end);
  if (now >= start && now <= end) return "live";
  if (now < start) return "scheduled";
  return "completed";
}

export function fmtDate(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function fmtTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export function msToCountdown(ms: number) {
  if (!(ms > 0)) return "00:00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const optText = (o: QuizOptionValue | null | undefined): string => (typeof o === "string" ? o : o?.text ?? "");
export const optImage = (o: QuizOptionValue | null | undefined): string | null => (typeof o === "string" ? null : o?.image_url ?? null);

export async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}