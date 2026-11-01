// app/api/admin/question-bot/fetch/route.js  (new file)
//
// POST { url, kind: "html" | "image" }
// A thin relay used by LOCAL mode: the browser cannot read examside.com directly
// (CORS), so this just forwards the bytes and does NO parsing - which keeps the
// function tiny and fast on the Vercel free plan. Gated by proxy.js (/api/admin/*).

import { NextResponse } from "next/server";
import { fetchPageHtml, safeFetch, readBytes } from "@/lib/questionBot/safeFetch";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request) {
  try {
    const { url, kind } = await request.json();
    if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

    if (kind === "image") {
      const res = await safeFetch(url, { accept: "image/*,*/*;q=0.8" });
      if (!res.ok) return NextResponse.json({ error: `HTTP ${res.status}` }, { status: 502 });
      const bytes = await readBytes(res, 12 * 1024 * 1024);
      return new NextResponse(bytes, {
        headers: {
          "Content-Type": res.headers.get("content-type") || "application/octet-stream",
          "Cache-Control": "private, no-store",
        },
      });
    }

    const html = await fetchPageHtml(url);
    return NextResponse.json({ html }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e.message || "Fetch failed" }, { status: 502 });
  }
}
