// 📂 SAVE THIS FILE AT: lib/pyqLocal.js
// Shared helpers for the CMS v3 routes that read a PYQ folder from the local disk.
// (Kept out of the route files because Next.js route files may only export HTTP handlers.)

import fs from "fs/promises";
import path from "path";
import os from "os";

export const IMAGE_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function resolveFolder(raw) {
  let p = String(raw || "").trim().replace(/^["']+|["']+$/g, "");
  if (!p) throw new Error("Folder path is empty.");
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

// Finds a direct child directory by name, ignoring case ("JSON", "Images" ...).
export async function findSubdir(parent, wanted) {
  const entries = await fs.readdir(parent, { withFileTypes: true });
  const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === wanted);
  return hit ? path.join(parent, hit.name) : null;
}
