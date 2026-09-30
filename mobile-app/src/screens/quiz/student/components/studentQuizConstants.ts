// ─── Colors (match app theme) ─────────────────────────────────────────────────
export const PRIMARY       = "#4834D4";
export const PRIMARY_LIGHT = "#EEF2FF";
export const BG            = "#F3F4F6";
export const GREEN         = "#10B981";
export const GREEN_LIGHT   = "#D1FAE5";
export const AMBER         = "#F59E0B";
export const AMBER_LIGHT   = "#FEF3C7";
export const RED           = "#EF4444";
export const RED_LIGHT     = "#FEF2F2";
export const GREY          = "#6B7280";

export const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://10.132.90.56:5000";

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
  /**
   * Optional ISO timestamp after which the join code stops working.
   * Only present when the teacher configured an expiry.
   */
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
  return new Date(iso).toLocaleString("en-IN", {
    day:    "2-digit",
    month:  "short",
    year:   "numeric",
    hour:   "2-digit",
    minute: "2-digit",
  });
}

export function msToCountdown(ms: number) {
  if (ms <= 0) return "00:00";
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