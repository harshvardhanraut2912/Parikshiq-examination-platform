// 📂 SAVE THIS FILE AT: app/api/admin/pyq-push/route.js
//
// CMS v3 "Deploy": appends the questions to pyq_mht_cet.questions for the chosen chapter.
// One row per chapter (no question_type - theory and numerical live together).
// Images are already uploaded to PYQ_IMAGES by this point, so the HTML here must already
// contain real URLs; any leftover [href=imageN] token is rejected instead of being stored.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const dynamic = "force-dynamic";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TABLE = "pyq_mht_cet";
const LEFTOVER_TOKEN = /\[(?:href|herf)=[^\]]*\]/i;

export async function POST(request) {
  try {
    const { chapterId, exam, subject, chapter, questions } = await request.json();

    if (!chapterId) return NextResponse.json({ success: false, error: "chapterId is required." }, { status: 400 });
    if (!Array.isArray(questions) || questions.length === 0) {
      return NextResponse.json({ success: false, error: "No questions in payload." }, { status: 400 });
    }

    for (const [i, q] of questions.entries()) {
      const label = `Question ${i + 1}`;
      if (!q || !q.question_html || !q.options || !q.answer_key) {
        return NextResponse.json({ success: false, error: `${label}: incomplete (question, options or answer key missing).` }, { status: 400 });
      }
      const blob = [q.question_html, q.solution_html || "", ...Object.values(q.options)].join("\n");
      if (LEFTOVER_TOKEN.test(blob)) {
        return NextResponse.json({ success: false, error: `${label}: still has an un-replaced [href=...] image token. Upload the images first.` }, { status: 400 });
      }
    }

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from(TABLE)
      .select("questions")
      .eq("chapter_id", chapterId)
      .maybeSingle();
    if (fetchError) throw fetchError;

    const current = Array.isArray(existing?.questions) ? existing.questions : [];

    // New questions are appended after what is already there; q_num / q_id are
    // re-issued from the chapter's current length (same rule as v2).
    const qIds = [];
    for (const q of questions) {
      const qNum = current.length + 1;
      const qId = `${chapterId}_${qNum}_${crypto.randomBytes(2).toString("hex")}`;
      current.push({
        q_id: qId,
        q_num: qNum,
        options: { A: q.options.A, B: q.options.B, C: q.options.C, D: q.options.D },
        section: q.section || "",
        ques_type: q.ques_type || "",
        source_id: q.source_id != null ? String(q.source_id) : "",
        answer_key: String(q.answer_key).toLowerCase(),
        exam_history: Array.isArray(q.exam_history) ? q.exam_history : [],
        question_html: q.question_html,
        solution_html: q.solution_html || "",
      });
      qIds.push(qId);
    }

    const { error: upsertError } = await supabaseAdmin.from(TABLE).upsert(
      {
        chapter_id: chapterId,
        exam: exam || "MHT-CET",
        subject: subject || "",
        chapter: chapter || "",
        questions: current,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "chapter_id" }
    );
    if (upsertError) throw upsertError;

    return NextResponse.json({ success: true, totalCount: current.length, qIds });
  } catch (err) {
    console.error("pyq-push error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
