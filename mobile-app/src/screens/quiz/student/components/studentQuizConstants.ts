// screens/quiz/student/components/studentQuizConstants.ts
// Colours here mirror the shared kit (components/ui.tsx) so older screens that still import them look the same.
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

/** One place decides the server address (services/api.ts). */
export const API_URL = API_BASE;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface StudentQuiz {
  quiz_id:            string;
  title:              string;
  description?:       string;
  subject_name:       string;
  subject_id:         string;
  /**
   * null  → open quiz (no code required)
   * string → 6-char join code
   */
  join_code:          string | null;
  /** Optional ISO timestamp after which the join code stops working. */
  join_code_expiry_at?: string | null;
  question_count:     number;
  total_marks:        number;
  time_limit_minutes: number;
  question_type:      string;
  scheduled_start:    string;
  scheduled_end:      string;
  has_submitted:      boolean;
  submission?: {
    submission_id:  string;
    marks_obtained: number;
    percentage:     number;
    submitted_at:   string;
  } | null;
}

export interface QuizOption {
  text:      string;
  image_url: string | null;
}

export interface QuizQuestion {
  question_id:  string;
  order:        number;
  type:         "mcq" | "open_ended";
  question:     string;
  image_url:    string | null;
  options:      QuizOption[] | string[] | null;
  marks:        number;
}

export interface GradedAnswer {
  question_id:    string;
  question_text:  string;
  type:           string;
  student_answer: string | null;
  correct_answer: string;
  is_correct:     boolean;
  similarity_score?: number | null;
  marks_obtained: number;
  marks_possible: number;
  feedback:       string;
}

export interface QuizResult {
  submission_id:  string;
  quiz_id:        string;
  total_marks:    number;
  marks_obtained: number;
  percentage:     number;
  submitted_at:   string;
  answers:        GradedAnswer[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function fmtDate(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-IN", {
    day:    "2-digit",
    month:  "short",
    year:   "numeric",
    hour:   "2-digit",
    minute: "2-digit",
  });
}

export function msToCountdown(ms: number) {
  if (!(ms > 0)) return "00:00";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function getStatusColor(status: "live" | "scheduled" | "completed") {
  return { live: GREEN, scheduled: AMBER, completed: GREY }[status];
}

/**
 * Returns true if the quiz's join code is currently expired.
 * Always returns false for open quizzes or when no expiry is set.
 */
export function isJoinCodeExpired(quiz: StudentQuiz): boolean {
  if (!quiz.join_code || !quiz.join_code_expiry_at) return false;
  return new Date() > new Date(quiz.join_code_expiry_at);
}

/** Text of an option whether the server sent a plain string or { text, image_url }. */
export function optionText(o: QuizOption | string | null | undefined): string {
  return typeof o === "string" ? o : o?.text ?? "";
}
export function optionImage(o: QuizOption | string | null | undefined): string | null {
  return typeof o === "string" ? null : o?.image_url ?? null;
}

/** res.json() that never throws on an empty / HTML body. */
export async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}