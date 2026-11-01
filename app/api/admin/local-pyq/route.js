// 📂 SAVE THIS FILE AT: app/api/admin/local-pyq/route.js
//
// CMS v3 helper. Reads a folder on the PC that is running the Next.js server
// (i.e. `npm run dev` on your own machine). The folder is the one the Question
// Bot's "Download ZIP" produces once unzipped:
//
//   <folder>/json/<anything>.json
//   <folder>/images/image1.png, image2.png ...
//
//   GET ?action=scan&path=<folder>              -> { jsonFile, questions, images, warnings }
//   GET ?action=image&path=<folder>&name=a.png  -> the image bytes (used for the preview)
//
// This can NOT work on Vercel (the server is not your PC), so it refuses to run there.
// Only files inside <folder>/json and <folder>/images are ever read, and only
// *.json / image extensions - it is not a general file reader.

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { IMAGE_EXT, resolveFolder, findSubdir } from "@/lib/pyqLocal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fail(message, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request) {
  if (process.env.VERCEL) {
    return fail("Reading a local folder only works when the site runs on your own PC (npm run dev). It cannot run on Vercel.");
  }

  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "scan";

  let folder;
  try {
    folder = resolveFolder(searchParams.get("path"));
  } catch (e) {
    return fail(e.message);
  }

  try {
    const stat = await fs.stat(folder).catch(() => null);
    if (!stat || !stat.isDirectory()) return fail(`Folder not found: ${folder}`, 404);

    const jsonDir = await findSubdir(folder, "json");
    const imagesDir = await findSubdir(folder, "images");

    // ---------------- image bytes ----------------
    if (action === "image") {
      const name = searchParams.get("name") || "";
      const ext = path.extname(name).toLowerCase();
      if (!imagesDir) return fail("No images folder inside that path.", 404);
      if (path.basename(name) !== name || !IMAGE_EXT[ext]) return fail("Bad image name.");
      const bytes = await fs.readFile(path.join(imagesDir, name)).catch(() => null);
      if (!bytes) return fail("Image not found.", 404);
      return new NextResponse(bytes, {
        headers: { "Content-Type": IMAGE_EXT[ext], "Cache-Control": "private, no-store" },
      });
    }

    // ---------------- scan ----------------
    const warnings = [];
    if (!jsonDir) return fail(`There is no "json" folder inside ${folder}`, 404);
    if (!imagesDir) warnings.push(`There is no "images" folder inside ${folder} - every image reference will be flagged as missing.`);

    const jsonFiles = (await fs.readdir(jsonDir))
      .filter((f) => f.toLowerCase().endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
    if (jsonFiles.length === 0) return fail(`No .json file found inside ${jsonDir}`, 404);
    if (jsonFiles.length > 1) warnings.push(`${jsonFiles.length} JSON files found in the json folder - using "${jsonFiles[0]}" only.`);

    const jsonFile = jsonFiles[0];
    let raw = await fs.readFile(path.join(jsonDir, jsonFile), "utf8");
    raw = raw.replace(/^\uFEFF/, "");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return fail(`${jsonFile} is not valid JSON: ${e.message}`, 422);
    }
    const questions = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.questions)
      ? parsed.questions
      : parsed && typeof parsed === "object"
      ? [parsed]
      : [];

    let images = [];
    if (imagesDir) {
      const names = await fs.readdir(imagesDir);
      for (const n of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
        if (!IMAGE_EXT[path.extname(n).toLowerCase()]) continue;
        const s = await fs.stat(path.join(imagesDir, n)).catch(() => null);
        if (s?.isFile()) images.push({ name: n, size: s.size });
      }
    }

    return NextResponse.json(
      { folder, jsonFile, questions, images, warnings },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    console.error("local-pyq error:", e);
    return fail(e.message || "Could not read that folder.", 500);
  }
}
