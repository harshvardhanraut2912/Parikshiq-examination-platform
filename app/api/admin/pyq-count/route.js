// 📂 SAVE THIS FILE AT: app/api/admin/pyq-count/route.js
// GET ?chapter_id=XXXX -> { count }  (questions already stored for that chapter in pyq_mht_cet)

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function GET(req) {
  const chapterId = new URL(req.url).searchParams.get("chapter_id");
  if (!chapterId) return NextResponse.json({ error: "chapter_id is required." }, { status: 400 });
  try {
    const { data, error } = await supabaseAdmin
      .from("pyq_mht_cet")
      .select("questions")
      .eq("chapter_id", chapterId)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ count: Array.isArray(data?.questions) ? data.questions.length : 0 });
  } catch (err) {
    console.error("pyq-count failed:", err);
    return NextResponse.json({ error: err.message || "Failed to fetch count." }, { status: 500 });
  }
}
