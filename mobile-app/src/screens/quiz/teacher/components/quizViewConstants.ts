// ─── Colors ────────────────────────────────────────────────────────────────────
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

export const API_URL = "http://10.132.90.56:5000";

// ─── Types ─────────────────────────────────────────────────────────────────────
export type QuizStatus = "live" | "scheduled" | "completed";

export interface QuizQuestion {
  question_id: string;
  order: number;
  type: "mcq" | "open_ended";
  question: string;
  options: string[] | null;
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
  join_code: string;
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
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit",
  });
}

export function msToCountdown(ms: number) {
  if (ms <= 0) return "00:00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}