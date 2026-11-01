// app/api/admin/question-bot/convert/route.js  (new file)
//
// SERVER mode: POST { url } or { html }, plus { mathMode }.
// Downloads the page (if a url is given), parses it, converts the math, downloads
// every image (PNG) and returns it all. The browser then only builds the JSON / zip.
//
// NOTE (Vercel): the response carries the images as base64 and must stay under
// ~4.5 MB on the free plan - fine for a normal 4-question page. Raise maxDuration
// after upgrading if you start converting bigger pages.

import { NextResponse } from "next/server";
import { parseExamsidePage } from "@/lib/questionBot/parsePage";
import { fetchPageHtml, fetchImagePng } from "@/lib/questionBot/safeFetch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    })
  );
  return results;
}

export async function POST(request) {
  try {
    const body = await request.json();
    const html = body.html ? String(body.html) : await fetchPageHtml(body.url);
    const parsed = parseExamsidePage(html, { mathMode: body.mathMode || "mathml", sourceUrl: body.url || "" });

    const images = await pool(parsed.images, 4, async (img) => {
      try {
        const bytes = await fetchImagePng(img);
        return { key: img.key, base64: Buffer.from(bytes).toString("base64") };
      } catch (e) {
        return { key: img.key, error: e.message || "download failed" };
      }
    });

    return NextResponse.json({ parsed, images }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e.message || "Conversion failed" }, { status: 502 });
  }
}
