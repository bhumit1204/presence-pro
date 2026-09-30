const express = require("express");
const router = express.Router();
const { admin, db } = require("../config/firebase");
const Groq = require("groq-sdk");
const dotenv = require("dotenv");
dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const { notify, getStudentUidsForSubject } = require("../services/notify");

// ─────────────────────────────────────────────────────────────
// 🔧 HELPER: Generate a random 6-char alphanumeric join code
// ─────────────────────────────────────────────────────────────
function generateJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

// ─────────────────────────────────────────────────────────────
// 🔧 HELPER: Ensure join code is unique in Firestore
// ─────────────────────────────────────────────────────────────
async function getUniqueJoinCode() {
  let join_code = generateJoinCode();
  let exists = true;

  while (exists) {
    const snap = await db
      .collection("quizzes")
      .where("join_code", "==", join_code)
      .limit(1)
      .get();
    exists = !snap.empty;
    if (exists) join_code = generateJoinCode();
  }

  return join_code;
}

// ─────────────────────────────────────────────────────────────
// 🔧 HELPER: Grade an open-ended answer via Groq
// ─────────────────────────────────────────────────────────────
async function gradeOpenEnded(question, expectedAnswer, studentAnswer) {
  const prompt = `
    You are an academic evaluator. A student answered a quiz question.

    Question: "${question}"
    Expected Answer: "${expectedAnswer}"
    Student Answer: "${studentAnswer}"

    Evaluate the student's answer based on semantic similarity and correctness.
    Respond ONLY with a valid JSON object (no explanation, no markdown):
    {
    "score": <number between 0 and 1>,
    "feedback": "<one short sentence of feedback>"
    }
`;

  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 200,
  });

  const raw = response.choices[0]?.message?.content?.trim() || "{}";

  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { score: 0, feedback: "Could not evaluate answer." };
  }
}

// ═══════════════════════════════════════════════════════════════════
// 📌 POST /api/quizzes/generate-preview
//
// STEP 1 OF 2 — AI generates questions from syllabus.
// Nothing is saved to Firestore yet.
// Teacher reviews/edits on frontend, then calls /create to finalize.
//
// Body:
// {
//   teacher_id           : string,
//   subject_id           : string,
//   syllabus             : string,        — topic / syllabus text from UI
//   question_count       : number,        — e.g. 10 (from UI dropdown)
//   question_type        : "mcq"          — only MCQ
//                        | "open_ended"   — only open-ended
//                        | "mixed"        — Groq decides the split (~60/40)
//
//   — Marks toggle —
//   custom_marks_enabled : boolean,
//     false → marks_per_question : number   (same marks for every question, e.g. 2)
//                                           Groq bakes this value into all questions.
//     true  → marks_per_question is ignored.
//             Groq uses 1 as placeholder; teacher edits each
//             question's marks individually on the preview screen
//             before calling /create.
// }
//
// Returns: preview questions array (NOT persisted)
// ═══════════════════════════════════════════════════════════════════
router.post("/generate-preview", async (req, res) => {
  try {
    const {
      teacher_id,
      subject_id,
      syllabus,
      difficulty,
      question_count,
      question_type,
      custom_marks_enabled,   // boolean — toggle state from UI
      marks_per_question,     // number  — only used when custom_marks_enabled is false
    } = req.body;

    const validDifficulties = ["easy", "medium", "hard"];
        if (!difficulty || !validDifficulties.includes(difficulty)) {
        return res.status(400).json({
            success: false,
            error: `difficulty must be one of: ${validDifficulties.join(", ")}`,
        });
        }

    // ── 1. Validate ──────────────────────────────────────────────
    if (!teacher_id || !subject_id || !syllabus || !question_count || !question_type) {
      return res.status(400).json({
        success: false,
        error: "teacher_id, subject_id, syllabus, question_count and question_type are required",
      });
    }

    // When toggle is OFF, teacher must supply a uniform marks value
    if (custom_marks_enabled === false) {
      const mpq = Number(marks_per_question);
      if (!marks_per_question || isNaN(mpq) || mpq < 1) {
        return res.status(400).json({
          success: false,
          error: "marks_per_question is required and must be >= 1 when custom_marks_enabled is false",
        });
      }
    }

    const validTypes = ["mcq", "open_ended", "mixed"];
    if (!validTypes.includes(question_type)) {
      return res.status(400).json({
        success: false,
        error: `question_type must be one of: ${validTypes.join(", ")}`,
      });
    }

    const count = parseInt(question_count);
    if (isNaN(count) || count < 1 || count > 50) {
      return res.status(400).json({
        success: false,
        error: "question_count must be a number between 1 and 50",
      });
    }

    // ── 2. Fetch subject + course for richer Groq context ────────
    const subjectDoc = await db.collection("subjects").doc(subject_id).get();

    if (!subjectDoc.exists) {
      return res.status(404).json({ success: false, error: "Subject not found" });
    }

    const subjectData = subjectDoc.data();

    if (subjectData.teacher_assigned !== teacher_id) {
      return res.status(403).json({
        success: false,
        error: "You are not assigned to this subject",
      });
    }

    const subject_name = subjectData.subject_name || "Unknown Subject";

    let course_name = "Unknown Course";
    if (subjectData.course_id) {
      const courseDoc = await db
        .collection("courses")
        .doc(subjectData.course_id)
        .get();
      if (courseDoc.exists) {
        course_name = courseDoc.data().course_name || course_name;
      }
    }

    // ── 3. Build Groq prompt based on question_type ──────────────
    let typeInstruction = "";

    if (question_type === "mcq") {
      typeInstruction = `All ${count} questions must be MCQ. Each must have exactly 4 options and one correct answer.`;
    } else if (question_type === "open_ended") {
      typeInstruction = `All ${count} questions must be open-ended (written answer). No options needed. Provide a clear model answer for each.`;
    } else {
      // mixed — ~60% MCQ, ~40% open-ended
      const mcqCount = Math.round(count * 0.6);
      const openCount = count - mcqCount;
      typeInstruction = `Generate ${mcqCount} MCQ questions (each with exactly 4 options and 1 correct answer) and ${openCount} open-ended questions (each with a model answer). Mix them in the output array.`;
    }

    // ── Marks instruction for the prompt ────────────────────────
    // Toggle OFF → uniform value teacher supplied
    // Toggle ON  → placeholder 1, teacher will edit per question on preview screen
    const marksValue = custom_marks_enabled === false
      ? Number(marks_per_question)
      : 1;

    const marksInstruction = custom_marks_enabled === false
    ? `Every question MUST have "marks": ${marksValue}. This is non-negotiable. Do not deviate.`
    : `Set "marks": 1 for every question. This is a placeholder only — the teacher will edit marks per question after preview.`;

    // ── Difficulty instruction ───────────────────────────────────
    // difficulty: "easy" | "medium" | "hard"
    const difficultyGuide = {
    easy: `
    - Questions should test basic recall and simple definitions.
    - Use straightforward language. Avoid tricky or ambiguous phrasing.
    - MCQ wrong options should be clearly incorrect (not confusingly similar).
    - Open-ended answers should require 1–2 simple sentences.`,

    medium: `
    - Questions should test understanding and application of concepts.
    - Expect students to explain "why" or "how", not just "what".
    - MCQ wrong options should be plausible but clearly wrong on deeper inspection.
    - Open-ended answers should require 2–3 sentences with some reasoning.`,

    hard: `
    - Questions should test deep analysis, evaluation, and synthesis.
    - Require students to compare, contrast, critique, or apply concepts to new scenarios.
    - MCQ wrong options should be very close to correct — only a thorough understanding reveals the right answer.
    - Open-ended answers should require 3–5 sentences with detailed reasoning and examples.`,
    };

    const difficultyInstruction = difficultyGuide[difficulty] || difficultyGuide["medium"];

    // ── Prompt ───────────────────────────────────────────────────
    const prompt = `
    You are a senior academic examiner with expertise in generating high-quality quiz questions for university-level students.

    === CONTEXT ===
    Course       : ${course_name}
    Subject      : ${subject_name}
    Syllabus     : ${syllabus}
    Difficulty   : ${difficulty.toUpperCase()}
    Total Count  : ${count} questions

    === DIFFICULTY REQUIREMENTS (${difficulty.toUpperCase()}) ===
    ${difficultyInstruction}

    === QUESTION TYPE INSTRUCTIONS ===
    ${typeInstruction}

    === STRICT RULES ===
    1. Every question must be directly derived from the syllabus. Do not go off-topic.
    2. MCQ rules:
    - "options" must be an array of EXACTLY 4 strings.
    - "correct_answer" must be an EXACT character-for-character match of one option.
    - Wrong options must be believable — not obviously silly.
    3. Open-ended rules:
    - "options" must be null (not an empty array, not omitted — exactly null).
    - "correct_answer" must be a complete model answer appropriate for the difficulty level.
    4. Marks rule: ${marksInstruction}
    5. No two questions should test the same concept or fact.
    6. Do NOT include question numbers, prefixes, or labels inside the "question" field.
    7. Respond ONLY with a raw valid JSON array.
    - No markdown, no code fences, no explanation, no text before or after the array.
    - The response must start with [ and end with ].

    === OUTPUT FORMAT ===
    [
    {
        "type": "mcq",
        "question": "<clear, complete question text>",
        "options": ["<option 1>", "<option 2>", "<option 3>", "<option 4>"],
        "correct_answer": "<must exactly match one of the options above>",
        "marks": ${marksValue}
    },
    {
        "type": "open_ended",
        "question": "<clear, complete question text>",
        "options": null,
        "correct_answer": "<model answer appropriate for ${difficulty} difficulty>",
        "marks": ${marksValue}
    }
    ]
    `.trim();

    // ── 4. Call Groq ─────────────────────────────────────────────
    const groqResponse = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
      max_tokens: 4000,
    });

    const raw = groqResponse.choices[0]?.message?.content?.trim() || "[]";

    let questions = [];
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      questions = JSON.parse(clean);
    } catch {
      return res.status(500).json({
        success: false,
        error: "Groq returned malformed JSON. Please try again.",
        raw_response: raw,
      });
    }

    // ── 5. Sanitize + add order index + editable_marks flag ─────
    questions = questions
      .filter((q) => q && q.question && q.type && q.correct_answer)
      .map((q, index) => ({
        order: index + 1,
        type: q.type,
        question: q.question,
        options: q.type === "mcq" ? (q.options || []) : null,
        correct_answer: q.correct_answer,
        // If toggle ON → marks is a placeholder; frontend should allow editing
        // If toggle OFF → marks is the teacher-set uniform value; lock the field
        marks: custom_marks_enabled === false ? marksValue : (Number(q.marks) || 1),
        editable_marks: custom_marks_enabled === true,  // hint for frontend
      }));

    const total_marks = questions.reduce((sum, q) => sum + q.marks, 0);

    // ── 6. Return preview — nothing saved ────────────────────────
    return res.status(200).json({
      success: true,
      message: "Preview generated. Review and confirm to save.",
      meta: {
        subject_name,
        course_name,
        question_type,
        question_count: questions.length,
        total_marks,
        custom_marks_enabled: custom_marks_enabled === true,
        // If toggle OFF, remind frontend what uniform value was applied
        marks_per_question: custom_marks_enabled === false ? marksValue : null,
      },
      questions,
    });
  } catch (error) {
    console.error("GENERATE PREVIEW ERROR:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to generate questions",
    });
  }
});

router.patch("/:quiz_id/reschedule", async (req, res) => {
  try {
    const { quiz_id } = req.params;
    const { teacher_id, scheduled_start, scheduled_end } = req.body;

    if (!teacher_id || !scheduled_start || !scheduled_end) {
      return res.status(400).json({
        success: false,
        error: "teacher_id, scheduled_start and scheduled_end are required",
      });
    }

    const startDate = new Date(scheduled_start);
    const endDate   = new Date(scheduled_end);

    if (isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({ success: false, error: "Invalid date format" });
    }

    if (endDate <= startDate) {
      return res.status(400).json({ success: false, error: "scheduled_end must be after scheduled_start" });
    }

    const quizDoc = await db.collection("quizzes").doc(quiz_id).get();
    if (!quizDoc.exists) {
      return res.status(404).json({ success: false, error: "Quiz not found" });
    }

    const quiz = quizDoc.data();

    if (quiz.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    // Only allow rescheduling if quiz hasn't started yet
    const now = new Date();
    const currentStart = quiz.scheduled_start?.toDate();
    if (currentStart && now >= currentStart) {
      return res.status(400).json({ success: false, error: "Cannot reschedule a quiz that has already started" });
    }

    await quizDoc.ref.update({
      scheduled_start: admin.firestore.Timestamp.fromDate(startDate),
      scheduled_end:   admin.firestore.Timestamp.fromDate(endDate),
    });

    return res.json({
      success: true,
      message: "Quiz rescheduled successfully",
      scheduled_start: startDate.toISOString(),
      scheduled_end:   endDate.toISOString(),
    });
  } catch (error) {
    console.error("RESCHEDULE QUIZ ERROR:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to reschedule quiz" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 📌 DELETE /api/quizzes/:quiz_id
// Teacher cancels/deletes a scheduled quiz
// Body: { teacher_id }
// ═══════════════════════════════════════════════════════════════════
router.delete("/:quiz_id", async (req, res) => {
  try {
    const { quiz_id } = req.params;
    const { teacher_id } = req.body;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id is required" });
    }

    const quizDoc = await db.collection("quizzes").doc(quiz_id).get();
    if (!quizDoc.exists) {
      return res.status(404).json({ success: false, error: "Quiz not found" });
    }

    const quiz = quizDoc.data();

    if (quiz.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    // Delete subcollection questions first (Firestore doesn't cascade)
    const questionsSnap = await quizDoc.ref.collection("questions").get();
    const batch = db.batch();
    questionsSnap.docs.forEach((doc) => batch.delete(doc.ref));
    batch.delete(quizDoc.ref);
    await batch.commit();

    return res.json({ success: true, message: "Quiz cancelled and deleted successfully" });
  } catch (error) {
    console.error("DELETE QUIZ ERROR:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to delete quiz" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 📌 PATCH /api/quizzes/:quiz_id/update-questions
// Teacher edits questions on a scheduled (not yet live) quiz
// Body: { teacher_id, questions: [{ question_id, type, question, options, correct_answer, marks }] }
// ═══════════════════════════════════════════════════════════════════
router.patch("/:quiz_id/update-questions", async (req, res) => {
  try {
    const { quiz_id } = req.params;
    const { teacher_id, questions } = req.body;

    if (!teacher_id || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, error: "teacher_id and questions array are required" });
    }

    const quizDoc = await db.collection("quizzes").doc(quiz_id).get();
    if (!quizDoc.exists) {
      return res.status(404).json({ success: false, error: "Quiz not found" });
    }

    if (quizDoc.data().teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const batch = db.batch();

    for (const q of questions) {
      if (!q.question_id) continue;
      const qRef = quizDoc.ref.collection("questions").doc(q.question_id);
      batch.update(qRef, {
        type:           q.type,
        question:       q.question,
        options:        q.type === "mcq" ? (q.options ?? null) : null,
        correct_answer: q.correct_answer,
        marks:          Number(q.marks) || 1,
      });
    }

    // Recalculate total_marks
    const total_marks = questions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0);
    batch.update(quizDoc.ref, { total_marks });

    await batch.commit();

    return res.json({ success: true, message: "Questions updated successfully", total_marks });
  } catch (error) {
    console.error("UPDATE QUESTIONS ERROR:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to update questions" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 📌 GET /api/quizzes/:quiz_id/result
// Student fetches their own graded submission for a quiz
// Query: ?student_uid=xxx
// ═══════════════════════════════════════════════════════════════════
router.get("/:quiz_id/result", async (req, res) => {
  try {
    const { quiz_id } = req.params;
    const { student_uid } = req.query;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid query param required" });
    }

    const quizDoc = await db.collection("quizzes").doc(quiz_id).get();
    if (!quizDoc.exists) {
      return res.status(404).json({ success: false, error: "Quiz not found" });
    }

    const quiz = quizDoc.data();

    const subSnap = await db
      .collection("quiz_submissions")
      .where("quiz_id", "==", quiz_id)
      .where("student_uid", "==", student_uid)
      .limit(1)
      .get();

    if (subSnap.empty) {
      return res.status(404).json({ success: false, error: "No submission found" });
    }

    const sub = subSnap.docs[0].data();

    return res.json({
      success: true,
      quiz: {
        title:        quiz.title,
        subject_name: quiz.subject_name,
      },
      submission: {
        submission_id:  sub.submission_id,
        total_marks:    sub.total_marks,
        marks_obtained: sub.marks_obtained,
        percentage:     sub.percentage,
        submitted_at:   sub.submitted_at?.toDate?.()?.toISOString() || null,
        answers: (sub.answers || []).map((a) => ({
          question_id:     a.question_id,
          question_text:   a.question_text,
          type:            a.type,
          student_answer:  a.answer,          // Firestore stores as "answer"
          correct_answer:  a.correct_answer,
          is_correct:      a.is_correct,
          marks_obtained:  a.marks_obtained,
          marks_possible:  a.marks_possible,
          feedback:        a.feedback || null,
        })),
      },
    });
  } catch (error) {
    console.error("FETCH STUDENT RESULT ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch result" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 📌 POST /api/quizzes/create
//
// STEP 2 OF 2 — Teacher confirms after previewing/editing.
// This persists the quiz + questions to Firestore.
//
// Body:
// {
//   teacher_id          : string,
//   subject_id          : string,
//   title               : string,
//   description?        : string,
//   syllabus?           : string,          — stored for reference
//   question_type       : "mcq" | "open_ended" | "mixed",
//   time_limit_minutes  : number,          — from UI Duration dropdown
//   scheduled_start     : ISO string,      — from UI Date & Time picker
//   scheduled_end       : ISO string,
//   notify_students     : boolean,
//   questions           : [                — teacher-confirmed (possibly edited) list
//     {
//       type            : "mcq" | "open_ended",
//       question        : string,
//       options?        : string[],         required for mcq
//       correct_answer  : string,
//       marks           : number
//     }
//   ]
// }
// ═══════════════════════════════════════════════════════════════════
router.post("/create", async (req, res) => {
  try {
    const {
      teacher_id,
      subject_id,
      title,
      description,
      syllabus,
      question_type,
      time_limit_minutes,
      scheduled_start,
      scheduled_end,
      notify_students,
      questions,
      // Optional join-code settings
      // use_join_code: boolean  — true → generate a code, false/omitted → open quiz
      // join_code_duration_minutes: number — how long the code stays valid after quiz start
      use_join_code,
      join_code_duration_minutes,
    } = req.body;

    // ── 1. Required field validation ─────────────────────────────
    if (
      !teacher_id || !subject_id || !title ||
      !time_limit_minutes || !scheduled_start ||
      !scheduled_end || !question_type
    ) {
      return res.status(400).json({
        success: false,
        error: "teacher_id, subject_id, title, question_type, time_limit_minutes, scheduled_start and scheduled_end are required",
      });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        success: false,
        error: "At least one question is required",
      });
    }

    const startDate = new Date(scheduled_start);
    const endDate = new Date(scheduled_end);

    if (isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({
        success: false,
        error: "Invalid scheduled_start or scheduled_end datetime",
      });
    }

    if (endDate <= startDate) {
      return res.status(400).json({
        success: false,
        error: "scheduled_end must be after scheduled_start",
      });
    }

    // ── 2. Validate each question ────────────────────────────────
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];

      if (!q.type || !["mcq", "open_ended"].includes(q.type)) {
        return res.status(400).json({
          success: false,
          error: `Question ${i + 1}: type must be "mcq" or "open_ended"`,
        });
      }

      if (!q.question || !q.correct_answer || !q.marks) {
        return res.status(400).json({
          success: false,
          error: `Question ${i + 1}: question, correct_answer and marks are required`,
        });
      }

      if (q.type === "mcq") {
        if (!Array.isArray(q.options) || q.options.length < 2) {
          return res.status(400).json({
            success: false,
            error: `Question ${i + 1}: MCQ requires at least 2 options`,
          });
        }
        const optionTexts = q.options.map((o) => (typeof o === "string" ? o : o.text || ""));
        const validOptions = q.options.filter((o) =>
          typeof o === "string" ? o.trim() : (o.text?.trim() || o.image_url)
        );
        if (validOptions.length < 2) {
          return res.status(400).json({
            success: false,
            error: `Question ${i + 1}: MCQ requires at least 2 non-empty options`,
          });
        }
        if (!optionTexts.map(t => t.trim()).includes((q.correct_answer || "").trim())) {
          return res.status(400).json({
            success: false,
            error: `Question ${i + 1}: correct_answer must match the text of one of the provided options`,
          });
        }
      }
    }

    // ── 3. Verify teacher exists ─────────────────────────────────
    const teacherDoc = await db.collection("teachers").doc(teacher_id).get();
    if (!teacherDoc.exists) {
      return res.status(404).json({ success: false, error: "Teacher not found" });
    }

    // ── 4. Verify subject belongs to teacher ─────────────────────
    const subjectDoc = await db.collection("subjects").doc(subject_id).get();
    if (!subjectDoc.exists) {
      return res.status(404).json({ success: false, error: "Subject not found" });
    }

    const subjectData = subjectDoc.data();
    if (subjectData.teacher_assigned !== teacher_id) {
      return res.status(403).json({
        success: false,
        error: "You are not assigned to this subject",
      });
    }

    // ── 5. Join code — optional ──────────────────────────────────
    // Only generate a join code when the teacher explicitly requests one.
    // For open quizzes (use_join_code falsy), join_code is null and students
    // can enter via /join-open/:quiz_id without a code.
    let join_code = null;
    let join_code_expiry_at = null;

    if (use_join_code === true) {
      join_code = await getUniqueJoinCode();

      // Optional: code expires N minutes after the quiz starts.
      // Defaults to the full quiz window (scheduled_end) when not specified.
      if (join_code_duration_minutes && Number(join_code_duration_minutes) > 0) {
        join_code_expiry_at = new Date(
          startDate.getTime() + Number(join_code_duration_minutes) * 60 * 1000
        );
      }
    }

    // ── 6. Total marks ───────────────────────────────────────────
    const total_marks = questions.reduce((sum, q) => sum + Number(q.marks), 0);

    // ── 7. Write quiz + questions in one batch ───────────────────
    const quizRef = db.collection("quizzes").doc();
    const batch = db.batch();

    const quizData = {
      quiz_id: quizRef.id,
      teacher_id,
      subject_id,
      subject_name: subjectData.subject_name || null,
      course_id: subjectData.course_id || null,
      aishe_code: subjectData.aishe_code || teacherDoc.data().aishe_code || null,

      title,
      description: description || null,
      syllabus: syllabus || null,
      question_type,                         // "mcq" | "open_ended" | "mixed"

      time_limit_minutes: Number(time_limit_minutes),
      total_marks,
      question_count: questions.length,

      scheduled_start: admin.firestore.Timestamp.fromDate(startDate),
      scheduled_end: admin.firestore.Timestamp.fromDate(endDate),

      join_code: join_code || null,                  // null = open quiz
      join_code_expiry_at: join_code_expiry_at
        ? admin.firestore.Timestamp.fromDate(join_code_expiry_at)
        : null,
      notify_students: notify_students === true,

      status: "scheduled", 
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    batch.set(quizRef, quizData);

    questions.forEach((q, index) => {
      const qRef = quizRef.collection("questions").doc();
      const normalizedOptions = q.type === "mcq"
        ? q.options.map((o) =>
            typeof o === "string"
              ? { text: o, image_url: null }
              : { text: o.text || "", image_url: o.image_url || null }
          )
        : null;

      batch.set(qRef, {
        question_id: qRef.id,
        order: index + 1,
        type: q.type,
        question: q.question,
        image_url: q.image_url || null,
        options: normalizedOptions,
        correct_answer: q.correct_answer,
        marks: Number(q.marks),
      });
    });

    await batch.commit();

    if (notify_students === true) {
      try {
        const studentIds = await getStudentUidsForSubject(subject_id);
        notify({
          userIds: studentIds,
          title: `📊 New Quiz: ${title}`,
          body: `Scheduled for ${startDate.toLocaleDateString()} • ${subjectData.subject_name}`,
          data: { screen: "StudentQuizzes" },
        });
      } catch (notifErr) {
        console.error("Push notification failed (non-fatal):", notifErr);
      }
    }

    return res.status(201).json({
      success: true,
      message: "Quiz created and scheduled successfully",
      quiz_id: quizRef.id,
      join_code: join_code || null,
      join_code_expiry_at: join_code_expiry_at ? join_code_expiry_at.toISOString() : null,
      question_type,
      question_count: questions.length,
      total_marks,
      scheduled_start: startDate.toISOString(),
      scheduled_end: endDate.toISOString(),
    });
  } catch (error) {
    console.error("CREATE QUIZ ERROR:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

router.get("/teacher/:teacher_id", async (req, res) => {
  try {
    const { teacher_id } = req.params;

    const quizSnap = await db
      .collection("quizzes")
      .where("teacher_id", "==", teacher_id)
      .orderBy("scheduled_start", "desc")
      .get();

    const quizzes = quizSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        scheduled_start: d.scheduled_start?.toDate?.()?.toISOString() || null,
        scheduled_end: d.scheduled_end?.toDate?.()?.toISOString() || null,
        created_at: d.created_at?.toDate?.()?.toISOString() || null,
      };
    });

    return res.json({ success: true, count: quizzes.length, quizzes });
  } catch (error) {
    console.error("FETCH TEACHER QUIZZES ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch quizzes" });
  }
});

router.get("/join/:join_code", async (req, res) => {
  try {
    const join_code = req.params.join_code?.trim().toUpperCase();

    if (!join_code) {
      return res.status(400).json({ success: false, error: "join_code required" });
    }

    const quizSnap = await db
      .collection("quizzes")
      .where("join_code", "==", join_code)
      .limit(1)
      .get();

    if (quizSnap.empty) {
      return res.status(404).json({ success: false, error: "Invalid join code" });
    }

    const quizDoc = quizSnap.docs[0];
    const quiz = quizDoc.data();

    const now = new Date();
    const start = quiz.scheduled_start?.toDate();
    const end = quiz.scheduled_end?.toDate();

    if (now < start) {
      return res.status(403).json({
        success: false,
        error: "Quiz has not started yet",
        scheduled_start: start.toISOString(),
      });
    }

    if (now > end) {
      return res.status(403).json({ success: false, error: "Quiz has ended" });
    }

    // Enforce join code expiry when the teacher set a code duration
    if (quiz.join_code_expiry_at) {
      const expiry = quiz.join_code_expiry_at.toDate();
      if (now > expiry) {
        return res.status(403).json({
          success: false,
          error: "join_code_expired",
          message: "The join code has expired. Please ask your teacher for a new one.",
        });
      }
    }

    // Fetch questions — strip correct_answer before sending
    const questionsSnap = await quizDoc.ref
      .collection("questions")
      .orderBy("order")
      .get();

    const questions = questionsSnap.docs.map((doc) => {
      const { correct_answer, ...safe } = doc.data();
      return safe;
    });

    return res.json({
      success: true,
      quiz: {
        quiz_id: quiz.quiz_id,
        title: quiz.title,
        description: quiz.description,
        subject_name: quiz.subject_name,
        question_type: quiz.question_type,
        time_limit_minutes: quiz.time_limit_minutes,
        total_marks: quiz.total_marks,
        scheduled_start: start.toISOString(),
        scheduled_end: end.toISOString(),
      },
      questions,
    });
  } catch (error) {
    console.error("JOIN QUIZ ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch quiz" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 📌 GET /api/quizzes/join-open/:quiz_id
//
// Student joins an OPEN quiz (no join code required).
// Called by the frontend when quiz.join_code is null/undefined.
//
// Validates:
//  • Quiz exists and is currently live (within scheduled window)
//  • Quiz is actually an open quiz (join_code must be null in Firestore)
// Returns: same shape as /join/:join_code so TakeQuiz.tsx can use it directly.
// ═══════════════════════════════════════════════════════════════════
router.get("/join-open/:quiz_id", async (req, res) => {
  try {
    const { quiz_id } = req.params;

    const quizDoc = await db.collection("quizzes").doc(quiz_id).get();
    if (!quizDoc.exists) {
      return res.status(404).json({ success: false, error: "Quiz not found" });
    }

    const quiz = quizDoc.data();

    // Safety guard: if this quiz actually has a join code, reject open-join
    if (quiz.join_code) {
      return res.status(403).json({
        success: false,
        error: "This quiz requires a join code. Please use the code provided by your teacher.",
      });
    }

    const now   = new Date();
    const start = quiz.scheduled_start?.toDate();
    const end   = quiz.scheduled_end?.toDate();

    if (now < start) {
      return res.status(403).json({
        success: false,
        error: "Quiz has not started yet",
        scheduled_start: start.toISOString(),
      });
    }

    if (now > end) {
      return res.status(403).json({ success: false, error: "Quiz has ended" });
    }

    // Fetch questions — strip correct_answer before sending to client
    const questionsSnap = await quizDoc.ref
      .collection("questions")
      .orderBy("order")
      .get();

    const questions = questionsSnap.docs.map((doc) => {
      const { correct_answer, ...safe } = doc.data();
      return safe;
    });

    return res.json({
      success: true,
      quiz: {
        quiz_id:            quiz.quiz_id,
        title:              quiz.title,
        description:        quiz.description || null,
        subject_name:       quiz.subject_name,
        question_type:      quiz.question_type,
        time_limit_minutes: quiz.time_limit_minutes,
        total_marks:        quiz.total_marks,
        scheduled_start:    start.toISOString(),
        scheduled_end:      end.toISOString(),
      },
      questions,
    });
  } catch (error) {
    console.error("JOIN OPEN QUIZ ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch quiz" });
  }
});

router.get("/student-quizzes/:student_uid", async (req, res) => {
  try {
    const { student_uid } = req.params;

    if (!student_uid) {
      return res.status(400).json({ success: false, error: "student_uid required" });
    }

    // ── 1. Fetch student profile to get enrolled_subjects ─────────
    const studentSnap = await db
      .collection("students")
      .where("uid", "==", student_uid)
      .limit(1)
      .get();

    if (studentSnap.empty) {
      return res.status(404).json({ success: false, error: "Student not found" });
    }

    const student = studentSnap.docs[0].data();
    const enrolledSubjects = student.enrolled_subjects || [];

    if (enrolledSubjects.length === 0) {
      return res.json({
        success: true,
        live: [], 
        scheduled: [], 
        completed: [],
      });
    }

    const CHUNK = 30;
    let allQuizzes = [];

    for (let i = 0; i < enrolledSubjects.length; i += CHUNK) {
      const chunk = enrolledSubjects.slice(i, i + CHUNK);
      const snap = await db
        .collection("quizzes")
        .where("subject_id", "in", chunk)
        .orderBy("scheduled_start", "desc")
        .get();

      snap.docs.forEach((doc) => {
        const d = doc.data();
        allQuizzes.push({
          quiz_id:              d.quiz_id,
          title:                d.title,
          description:          d.description || null,
          subject_name:         d.subject_name || null,
          subject_id:           d.subject_id,
          join_code:            d.join_code || null,
          join_code_expiry_at:  d.join_code_expiry_at?.toDate?.()?.toISOString() || null,
          question_count:       d.question_count,
          total_marks:          d.total_marks,
          time_limit_minutes:   d.time_limit_minutes,
          question_type:        d.question_type,
          scheduled_start:      d.scheduled_start?.toDate?.()?.toISOString() || null,
          scheduled_end:        d.scheduled_end?.toDate?.()?.toISOString()   || null,
        });
      });
    }

    // ── 3. Fetch student's submissions ───────────────────────────
    const submissionsSnap = await db
      .collection("quiz_submissions")
      .where("student_uid", "==", student_uid)
      .get();

    // Build submission lookup: quiz_id → submission data
    const submissionMap = {};
    submissionsSnap.docs.forEach((doc) => {
      const d = doc.data();
      submissionMap[d.quiz_id] = {
        submission_id:  d.submission_id,
        marks_obtained: d.marks_obtained,
        percentage:     d.percentage,
        submitted_at:   d.submitted_at?.toDate?.()?.toISOString() || null,
      };
    });

    // ── 4. Classify each quiz ─────────────────────────────────────
    const now = new Date();
    const live = [], scheduled = [], completed = [];

    allQuizzes.forEach((q) => {
      const start = new Date(q.scheduled_start);
      const end   = new Date(q.scheduled_end);
      const sub   = submissionMap[q.quiz_id] || null;

      const enriched = { ...q, submission: sub, has_submitted: !!sub };

      // Classification logic:
      // - COMPLETED: Student already submitted (regardless of quiz window) OR quiz has ended
      // - LIVE:      Quiz is currently open AND student has NOT submitted yet
      // - SCHEDULED: Quiz hasn't started yet

      if (sub) {
        // Student submitted → always goes to completed (removes from live if open)
        completed.push(enriched);
      } else if (now < start) {
        // Quiz hasn't started yet and no submission
        scheduled.push(enriched);
      } else if (now >= start && now <= end) {
        // Quiz is live and student hasn't submitted yet
        live.push(enriched);
      } else {
        // Quiz ended, no submission — still show in completed as "missed"
        completed.push(enriched);
      }
    });

    return res.json({ success: true, live, scheduled, completed });

  } catch (error) {
    console.error("❌ Error fetching student quizzes:", error);
    return res.status(500).json({ 
      success: false, 
      error: error.message || "Internal server error" 
    });
  }
});

// ─── EXPORT ──────────────────────────────────────────────────────────────────
module.exports = router;

// ═══════════════════════════════════════════════════════════════════
// 📌 GET /api/quizzes/student/:student_uid
// Student views their own quiz submission history (summary)
// ═══════════════════════════════════════════════════════════════════
router.get("/student/:student_uid", async (req, res) => {
  try {
    const { student_uid } = req.params;

    const submissionsSnap = await db
      .collection("quiz_submissions")
      .where("student_uid", "==", student_uid)
      .orderBy("submitted_at", "desc")
      .get();

    const submissions = submissionsSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        submission_id: d.submission_id,
        quiz_id: d.quiz_id,
        subject_id: d.subject_id,
        total_marks: d.total_marks,
        marks_obtained: d.marks_obtained,
        percentage: d.percentage,
        submitted_at: d.submitted_at?.toDate?.()?.toISOString() || null,
      };
    });

    return res.json({ success: true, count: submissions.length, submissions });
  } catch (error) {
    console.error("FETCH STUDENT SUBMISSIONS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch submissions" });
  }
});

router.get("/:quiz_id", async (req, res) => {
  try {
    const { quiz_id } = req.params;
    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id query param required" });
    }

    const quizDoc = await db.collection("quizzes").doc(quiz_id).get();
    if (!quizDoc.exists) {
      return res.status(404).json({ success: false, error: "Quiz not found" });
    }

    const quiz = quizDoc.data();

    if (quiz.teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const questionsSnap = await quizDoc.ref
      .collection("questions")
      .orderBy("order")
      .get();

    const questions = questionsSnap.docs.map((doc) => ({
      question_id: doc.id,
      ...doc.data(),
    }));

    return res.json({
      success: true,
      quiz: {
        ...quiz,
        scheduled_start: quiz.scheduled_start?.toDate?.()?.toISOString() || null,
        scheduled_end:   quiz.scheduled_end?.toDate?.()?.toISOString()   || null,
        created_at:      quiz.created_at?.toDate?.()?.toISOString()      || null,
      },
      questions,
    });
  } catch (error) {
    console.error("FETCH QUIZ ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch quiz" });
  }
});

router.post("/submit", async (req, res) => {
  try {
    const { quiz_id, student_uid, answers } = req.body;

    if (!quiz_id || !student_uid || !Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        error: "quiz_id, student_uid and answers are required",
      });
    }

    const quizDoc = await db.collection("quizzes").doc(quiz_id).get();
    if (!quizDoc.exists) {
      return res.status(404).json({ success: false, error: "Quiz not found" });
    }

    const quiz = quizDoc.data();
    const now = new Date();
    const start = quiz.scheduled_start?.toDate();
    const end = quiz.scheduled_end?.toDate();

    if (now < start) {
      return res.status(403).json({ success: false, error: "Quiz has not started yet" });
    }

    if (now > end) {
      return res.status(403).json({
        success: false,
        error: "Quiz window has closed. Submission not accepted.",
      });
    }

    // Prevent duplicate submission
    const dupSnap = await db
      .collection("quiz_submissions")
      .where("quiz_id", "==", quiz_id)
      .where("student_uid", "==", student_uid)
      .limit(1)
      .get();

    if (!dupSnap.empty) {
      return res.status(409).json({
        success: false,
        error: "You have already submitted this quiz",
      });
    }

    // Fetch questions with correct answers for grading
    const questionsSnap = await quizDoc.ref
      .collection("questions")
      .orderBy("order")
      .get();

    const questionsMap = {};
    questionsSnap.docs.forEach((doc) => {
      questionsMap[doc.id] = doc.data();
    });

    // Grade each answer
    let total_obtained = 0;
    const gradedAnswers = [];

    for (const submission of answers) {
      const { question_id, answer } = submission;
      const question = questionsMap[question_id];

      if (!question) {
        gradedAnswers.push({
          question_id,
          answer,
          is_correct: false,
          marks_obtained: 0,
          feedback: "Question not found",
        });
        continue;
      }

      if (question.type === "mcq") {
        const is_correct =
          answer?.trim().toLowerCase() ===
          question.correct_answer?.trim().toLowerCase();

        const marks_obtained = is_correct ? question.marks : 0;
        total_obtained += marks_obtained;

        gradedAnswers.push({
          question_id,
          question_text: question.question,
          type: "mcq",
          answer,
          correct_answer: question.correct_answer,
          is_correct,
          marks_obtained,
          marks_possible: question.marks,
          feedback: is_correct
            ? "Correct!"
            : `Correct answer: ${question.correct_answer}`,
        });
      } else if (question.type === "open_ended") {
        let score = 0;
        let feedback = "Could not evaluate.";

        try {
          const result = await gradeOpenEnded(
            question.question,
            question.correct_answer,
            answer || ""
          );
          score = Math.min(Math.max(result.score || 0, 0), 1);
          feedback = result.feedback || feedback;
        } catch (groqErr) {
          console.error("Groq grading error:", groqErr);
        }

        const marks_obtained = parseFloat((score * question.marks).toFixed(2));
        total_obtained += marks_obtained;

        gradedAnswers.push({
          question_id,
          question_text: question.question,
          type: "open_ended",
          answer,
          similarity_score: score,
          marks_obtained,
          marks_possible: question.marks,
          feedback,
        });
      }
    }

    const percentage =
      quiz.total_marks > 0
        ? parseFloat(((total_obtained / quiz.total_marks) * 100).toFixed(2))
        : 0;

    const submissionRef = db.collection("quiz_submissions").doc();

    await submissionRef.set({
      submission_id: submissionRef.id,
      quiz_id,
      student_uid,
      subject_id: quiz.subject_id || null,
      teacher_id: quiz.teacher_id || null,
      answers: gradedAnswers,
      total_marks: quiz.total_marks,
      marks_obtained: total_obtained,
      percentage,
      submitted_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(201).json({
      success: true,
      message: "Quiz submitted and graded successfully",
      submission_id: submissionRef.id,
      total_marks: quiz.total_marks,
      marks_obtained: total_obtained,
      percentage,
      graded_answers: gradedAnswers,
    });
  } catch (error) {
    console.error("SUBMIT QUIZ ERROR:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to submit quiz",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REPLACE the entire GET /:quiz_id/results route in quiz_routes.js
// with this version that resolves student names from the students collection.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:quiz_id/results", async (req, res) => {
  try {
    const { quiz_id }   = req.params;
    const { teacher_id } = req.query;

    if (!teacher_id) {
      return res.status(400).json({ success: false, error: "teacher_id query param required" });
    }

    const quizDoc = await db.collection("quizzes").doc(quiz_id).get();
    if (!quizDoc.exists) {
      return res.status(404).json({ success: false, error: "Quiz not found" });
    }
    if (quizDoc.data().teacher_id !== teacher_id) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const submissionsSnap = await db
      .collection("quiz_submissions")
      .where("quiz_id", "==", quiz_id)
      .get();

    if (submissionsSnap.empty) {
      return res.json({ success: true, quiz_id, total_submissions: 0, avg_percentage: 0, submissions: [] });
    }

    // Collect all unique student UIDs
    const uids = [...new Set(submissionsSnap.docs.map((d) => d.data().student_uid).filter(Boolean))];

    // Batch-fetch student docs — query by uid field (students.uid == Firebase UID)
    // Firestore "in" supports up to 30 items per query
    const studentMap = {};
    const CHUNK = 30;
    for (let i = 0; i < uids.length; i += CHUNK) {
      const chunk = uids.slice(i, i + CHUNK);
      const snap  = await db.collection("students").where("uid", "in", chunk).get();
      snap.docs.forEach((doc) => {
        const s = doc.data();
        const uid = s.uid || doc.id;
        studentMap[uid] = {
          name:    s.name || `${s.first_name || ""} ${s.last_name || ""}`.trim() || null,
          roll_no: s.roll_no || s.roll_number || null,
        };
      });
    }

    let submissions = submissionsSnap.docs.map((doc) => {
      const d   = doc.data();
      const stu = studentMap[d.student_uid] || {};
      return {
        ...d,
        student_name: stu.name    || d.student_name || null,
        student_roll: stu.roll_no || d.student_roll  || null,
        submitted_at: d.submitted_at?.toDate?.()?.toISOString() || null,
      };
    });

    submissions.sort((a, b) =>
      new Date(b.submitted_at || 0).getTime() - new Date(a.submitted_at || 0).getTime()
    );

    const avg_percentage = submissions.length > 0
      ? parseFloat((submissions.reduce((sum, s) => sum + (s.percentage || 0), 0) / submissions.length).toFixed(2))
      : 0;

    return res.json({ success: true, quiz_id, total_submissions: submissions.length, avg_percentage, submissions });

  } catch (error) {
    console.error("FETCH RESULTS ERROR:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch results" });
  }
});

// ─── FIXED: Student Quizzes Endpoint ─────────────────────────────────────────
// Replace the section starting at line 920 with this:



module.exports = router;