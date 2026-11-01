// lib/questionBot/safeFetch.js  (new file)  -- SERVER ONLY
//
// Fetch helper for the Question Bot routes. Only ExamSIDE / ExamGoal hosts are allowed
// (so the admin-only proxy can never be abused to reach internal addresses), redirects
// are followed manually and each hop is re-checked, and download size is capped.

const ALLOWED_HOSTS = [/(^|\.)examside\.com$/i, /(^|\.)examgoal\.net$/i, /(^|\.)examgoal\.com$/i];

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

export function assertAllowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Invalid URL"); }
  if (u.protocol !== "https:") throw new Error("Only https:// URLs are allowed");
  if (!ALLOWED_HOSTS.some((re) => re.test(u.hostname))) {
    throw new Error(`Host "${u.hostname}" is not allowed (only examside.com / examgoal.net)`);
  }
  return u.href;
}

export async function safeFetch(rawUrl, { accept, timeoutMs = 20000 } = {}) {
  let url = assertAllowedUrl(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...BROWSER_HEADERS,
        Accept: accept || "*/*",
        Referer: "https://questions.examside.com/",
      },
      cache: "no-store",
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = assertAllowedUrl(new URL(res.headers.get("location"), url).href);
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

export async function readBytes(res, maxBytes) {
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("Response too large");
  return buf;
}

export const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

export async function fetchPageHtml(url) {
  const res = await safeFetch(url, { accept: "text/html,application/xhtml+xml" });
  if (!res.ok) throw new Error(`ExamSIDE answered ${res.status} ${res.statusText}. Use "Paste / upload page" with the saved response instead.`);
  const bytes = await readBytes(res, 8 * 1024 * 1024);
  const html = new TextDecoder("utf-8").decode(bytes);
  if (!/data-question|question-component|q-prose|application\/ld\+json|class="[^"]*\boption\b/.test(html)) {
    throw new Error("The page loaded but contains no questions (blocked / bot-check page?). Use \"Paste / upload page\" instead.");
  }
  return html;
}

export async function fetchImagePng(img) {
  let lastErr = "no url";
  for (const u of [img.url, img.altUrl].filter(Boolean)) {
    try {
      const res = await safeFetch(u, { accept: "image/png,image/*,*/*;q=0.8" });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      let bytes = await readBytes(res, 12 * 1024 * 1024);
      if (!isPng(bytes)) {
        try {
          const mod = "sharp"; // variable name: keeps the bundler from failing if sharp is not installed
          const sharp = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ mod)).default;
          bytes = new Uint8Array(await sharp(bytes).png().toBuffer());
        } catch {
          /* sharp unavailable: keep original bytes (still saved as .png) */
        }
      }
      return bytes;
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  throw new Error(lastErr);
}
