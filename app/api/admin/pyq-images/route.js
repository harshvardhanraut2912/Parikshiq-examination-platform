// 📂 SAVE THIS FILE AT: app/api/admin/pyq-images/route.js
//
// CMS v3: uploads images from the local PYQ folder to the NEW bucket "PYQ_IMAGES".
//
//   POST { folderPath, chapterId, names: ["image1.png", ...] }
//   -> { uploaded: { "image1.png": { url, path } }, failed: [{ name, error }] }
//
// Every image is renamed to a random 6-hex name and stored under its chapter:
//   PYQ_IMAGES/<chapterId>/<random>.png
// so the bucket stays arranged chapter-wise. Public URL format is identical to the
// v2 one:  <SUPABASE_URL>/storage/v1/object/public/PYQ_IMAGES/<chapterId>/<random>.png

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { IMAGE_EXT, resolveFolder, findSubdir } from "@/lib/pyqLocal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = "PYQ_IMAGES";

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { data: existing } = await supabaseAdmin.storage.getBucket(BUCKET);
  if (!existing) {
    const { error } = await supabaseAdmin.storage.createBucket(BUCKET, { public: true });
    if (error && !/already exists/i.test(error.message)) {
      throw new Error(`Bucket "${BUCKET}" does not exist and could not be created: ${error.message}. Run the SQL first.`);
    }
  }
  bucketReady = true;
}

async function uploadOne(buffer, chapterId, ext, contentType) {
  // Random name, never overwrites: on a (very unlikely) clash pick another name.
  for (let attempt = 0; attempt < 6; attempt++) {
    const fileName = `${crypto.randomBytes(3).toString("hex")}.${ext}`;
    const storagePath = `${chapterId}/${fileName}`;
    const { error } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, buffer, { contentType, upsert: false });
    if (!error) {
      const url = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl;
      return { url, path: storagePath };
    }
    if (!/already exists|duplicate/i.test(error.message)) throw new Error(error.message);
  }
  throw new Error("Could not find a free random file name.");
}

export async function POST(request) {
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "Local folder upload only works when the site runs on your own PC." }, { status: 400 });
  }
  try {
    const { folderPath, chapterId, names } = await request.json();

    if (!chapterId || !/^[A-Za-z0-9_-]+$/.test(String(chapterId))) {
      return NextResponse.json({ error: "A valid chapterId is required." }, { status: 400 });
    }
    if (!Array.isArray(names) || names.length === 0) {
      return NextResponse.json({ error: "No images to upload." }, { status: 400 });
    }

    const folder = resolveFolder(folderPath);
    const imagesDir = await findSubdir(folder, "images");
    if (!imagesDir) return NextResponse.json({ error: "No images folder inside that path." }, { status: 404 });

    await ensureBucket();

    const uploaded = {};
    const failed = [];
    let next = 0;
    async function worker() {
      while (next < names.length) {
        const name = String(names[next++]);
        const ext = path.extname(name).toLowerCase();
        try {
          if (path.basename(name) !== name || !IMAGE_EXT[ext]) throw new Error("Bad image name.");
          const buffer = await fs.readFile(path.join(imagesDir, name));
          uploaded[name] = await uploadOne(buffer, chapterId, ext.slice(1) === "jpeg" ? "jpg" : ext.slice(1), IMAGE_EXT[ext]);
        } catch (e) {
          failed.push({ name, error: e.message });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, names.length) }, worker));

    return NextResponse.json({ uploaded, failed });
  } catch (e) {
    console.error("pyq-images error:", e);
    return NextResponse.json({ error: e.message || "Upload failed." }, { status: 500 });
  }
}
