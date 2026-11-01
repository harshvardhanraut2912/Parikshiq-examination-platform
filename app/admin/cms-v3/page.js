// 📂 SAVE THIS FILE AT: app/admin/cms-v3/page.js
//
// CMS v3 — PYQ pipeline. Takes the folder the Question Bot produced:
//     <folder>/json/<any name>.json     (MathML questions, images as [href=image1])
//     <folder>/images/image1.png ...
// and publishes it into the pyq_mht_cet table + the PYQ_IMAGES bucket.
//
// Flow:  type folder path → Load  →  check preview (red = image missing)
//        → pick chapter in the top bar → Upload Images (random names, chapter-wise)
//        → tokens become real public URLs (highlighted green) → Deploy.
//
// The folder is read by the Next.js server, so this page only works when the site runs
// on your own PC (npm run dev). See app/api/admin/local-pyq/route.js.

"use client";

import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { supabase } from "../../../lib/supabase";
import "../cms-v2/cms-v2.css";
import "./cms-v3.css";

// ---------------------------------------------------------------------------
// Sanitizing (same approach as CMS v2: DOMPurify from CDN, basic strip fallback)
// ---------------------------------------------------------------------------
function basicStrip(raw) {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/ on[a-z]+="[^"]*"/gi, "");
}

function sanitizeHtml(raw) {
  if (!raw) return "";
  if (typeof window !== "undefined" && window.DOMPurify) {
    try {
      const clean = window.DOMPurify.sanitize(raw, { ADD_ATTR: ["mathvariant", "xmlns", "data-badge"] });
      if (!clean && raw.trim()) return basicStrip(raw);
      return clean;
    } catch (err) {
      console.error("sanitizeHtml: DOMPurify threw, using basic strip.", err);
      return basicStrip(raw);
    }
  }
  return basicStrip(raw);
}

// ---------------------------------------------------------------------------
// Image token helpers.  The bot writes  src="[href=image1]"  (no extension);
// "[href=image1.png]" and the typo "[herf=...]" are accepted too.
// ---------------------------------------------------------------------------
const TOKEN_G = /\[(?:href|herf)=([^\]]+)\]/gi;
const TOKEN_1 = /\[(?:href|herf)=([^\]]+)\]/i;
const IMG_TAG_G = /<img\b[^>]*>/gi;

const normName = (n) => {
  const s = String(n).trim().replace(/^["']+|["']+$/g, "");
  return (/\.(png|jpe?g|webp|gif)$/i.test(s) ? s : `${s}.png`).toLowerCase();
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fieldsOf(item) {
  return [item.question_html, item.solution_html, ...Object.values(item.options || {})];
}

function refsOf(item) {
  const out = [];
  for (const f of fieldsOf(item)) {
    if (!f) continue;
    for (const m of String(f).matchAll(TOKEN_G)) out.push(normName(m[1]));
  }
  return out;
}

// What gets STORED: every token swapped for the real public URL, nothing else touched
// (the <img ... class="question-image" ...> tag stays exactly as the bot wrote it).
function finalizeHtml(html, ctx) {
  if (!html) return "";
  return String(html).replace(TOKEN_G, (full, name) => {
    const file = ctx.files.get(normName(name));
    const up = file && ctx.uploaded[file];
    return up ? up.url : full;
  });
}

// What gets SHOWN: same swap, but wrapped in a highlight span.
//   red    = file not in the images folder
//   orange = found locally, shown from your PC, not uploaded yet
//   green  = uploaded, the public URL is now in the HTML
function previewHtml(html, ctx) {
  if (!html) return "";
  return String(html).replace(IMG_TAG_G, (tag) => {
    const m = tag.match(TOKEN_1);
    if (!m) return tag;
    const wanted = normName(m[1]);
    const file = ctx.files.get(wanted);
    if (!file) {
      return `<span class="pyq-img pyq-img--missing">⚠ ${esc(wanted)} not found in images folder</span>`;
    }
    const up = ctx.uploaded[file];
    if (up) {
      const shortName = up.path.split("/").pop();
      return `<span class="pyq-img pyq-img--done" data-badge="✓ inserted · ${esc(shortName)}">${tag.replace(TOKEN_1, () => up.url)}</span>`;
    }
    const local = `/api/admin/local-pyq?action=image&amp;path=${encodeURIComponent(ctx.folder)}&amp;name=${encodeURIComponent(file)}`;
    return `<span class="pyq-img pyq-img--local" data-badge="local · ${esc(file)}">${tag.replace(TOKEN_1, () => local)}</span>`;
  });
}

const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// ---------------------------------------------------------------------------
// Preview card
// ---------------------------------------------------------------------------
const OptionRow = memo(function OptionRow({ letter, html, isAnswer }) {
  return (
    <div className={`qv2-option ${isAnswer ? "is-answer" : ""}`}>
      <span className="qv2-option-letter">{letter}</span>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

const QuestionCard = memo(function QuestionCard({ item, ctx, ctxVersion, onAnswerChange, onRemove }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- ctxVersion is the deliberate trigger (ctx content changes on load/upload)
  const clean = useMemo(() => {
    const o = item.options || {};
    return {
      q: sanitizeHtml(previewHtml(item.question_html, ctx)),
      A: sanitizeHtml(previewHtml(o.A, ctx)),
      B: sanitizeHtml(previewHtml(o.B, ctx)),
      C: sanitizeHtml(previewHtml(o.C, ctx)),
      D: sanitizeHtml(previewHtml(o.D, ctx)),
      sol: sanitizeHtml(previewHtml(item.solution_html, ctx)),
    };
  }, [item, ctxVersion]);

  const refs = useMemo(() => refsOf(item), [item]);
  const missing = [...new Set(refs.filter((r) => !ctx.files.has(r)))];

  return (
    <div className={`qv2-card ${item.parseError || missing.length ? "has-error" : ""}`}>
      <div className="qv2-card-head">
        <span className="qv2-card-title">
          Question <strong>#{item.q_num}</strong>
          {item.source_id ? <> — src id {item.source_id}</> : null}
        </span>
        <div className="actions">
          <select className="qv2-answer-select" value={item.answer_key} onChange={(e) => onAnswerChange(item.localId, e.target.value)}>
            {["a", "b", "c", "d"].map((l) => (
              <option key={l} value={l}>{l.toUpperCase()}</option>
            ))}
          </select>
          <button type="button" className="qv2-icon-btn" onClick={() => onRemove(item.localId)}>Remove</button>
        </div>
      </div>

      <div className="qv2-body">
        {item.parseError && <div className="qv2-warning-banner">{item.parseError}</div>}
        {missing.length > 0 && (
          <div className="qv2-warning-banner">Missing image file(s): {missing.join(", ")}</div>
        )}

        <div dangerouslySetInnerHTML={{ __html: clean.q }} />

        <div className="qv2-options">
          {["A", "B", "C", "D"].map((L) => (
            <OptionRow key={L} letter={L} html={clean[L]} isAnswer={item.answer_key === L.toLowerCase()} />
          ))}
        </div>

        {clean.sol && (
          <div className="qv2-solution">
            <div className="qv2-solution-label">Solution</div>
            <div dangerouslySetInnerHTML={{ __html: clean.sol }} />
          </div>
        )}

        <div className="qv2-meta-row">
          {item.section && <span className="qv2-meta-chip">{item.section}</span>}
          {item.ques_type && <span className="qv2-meta-chip">{item.ques_type === "P" ? "Numerical" : item.ques_type === "T" ? "Theory" : item.ques_type}</span>}
          {refs.length > 0 && <span className="qv2-meta-chip">{refs.length} image ref{refs.length > 1 ? "s" : ""}</span>}
          {(item.exam_history || []).map((e, i) => (
            <span key={i} className="qv2-meta-chip">
              {typeof e === "string" ? e : [e.examName, e.examYear].filter(Boolean).join(" ") || JSON.stringify(e)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function CmsV3() {
  // taxonomy (same source as v2: syllabus_chapters_v2)
  const [chapterOptions, setChapterOptions] = useState([]);
  const [standard, setStandard] = useState("12th");
  const [subject, setSubject] = useState("Physics");
  const [chapterId, setChapterId] = useState("");
  const [chapterQuestionCount, setChapterQuestionCount] = useState(0);

  // folder + parsed data
  const [folderPath, setFolderPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [scan, setScan] = useState(null); // { folder, jsonFile, images, warnings }
  const [items, setItems] = useState([]);

  // upload / deploy state
  const [uploaded, setUploaded] = useState({}); // actual file name -> { url, path }
  const [uploadProgress, setUploadProgress] = useState({ isActive: false, current: 0, total: 0 });
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployed, setDeployed] = useState(false);

  const [toast, setToast] = useState(null);
  const [modalConfig, setModalConfig] = useState({ isOpen: false, title: "", message: "", onConfirm: null });

  // DOMPurify from CDN
  const [, setDompurifyReady] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.DOMPurify) { setDompurifyReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.5/purify.min.js";
    script.async = true;
    script.onload = () => setDompurifyReady(true);
    document.body.appendChild(script);
  }, []);

  // chapters
  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase
          .from("syllabus_chapters_v2")
          .select("id, exam, standard, subject, chapter_name, default_weight")
          .eq("standard", standard)
          .eq("subject", subject)
          .order("chapter_name", { ascending: true });
        if (error) throw error;
        setChapterOptions(data || []);
        setChapterId(data && data.length > 0 ? data[0].id : "");
      } catch (err) {
        console.error("syllabus_chapters_v2 fetch failed:", err);
        setChapterOptions([]);
      }
    })();
  }, [standard, subject]);

  const activeChapterRow = chapterOptions.find((c) => c.id === chapterId) || null;

  // how many PYQ questions this chapter already has
  const loadCount = useCallback(async (id) => {
    if (!id) { setChapterQuestionCount(0); return; }
    try {
      const res = await fetch(`/api/admin/pyq-count?chapter_id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load count.");
      setChapterQuestionCount(Number(data.count) || 0);
    } catch (err) {
      console.error("PYQ count fetch failed:", err);
      setChapterQuestionCount(0);
    }
  }, []);
  useEffect(() => { loadCount(chapterId); }, [chapterId, loadCount]);

  // --- Load folder ---------------------------------------------------------
  async function handleLoad() {
    if (!folderPath.trim()) { setLoadError("Type the folder path first."); return; }
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/admin/local-pyq?action=scan&path=${encodeURIComponent(folderPath.trim())}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not read the folder.");

      const parsed = (data.questions || []).map((q, idx) => {
        const o = q.options || {};
        let parseError = null;
        if (!q.question_html) parseError = "Missing question_html.";
        if (!o.A || !o.B || !o.C || !o.D) parseError = (parseError ? parseError + " " : "") + "Missing one or more options (A-D).";
        if (!q.answer_key) parseError = (parseError ? parseError + " " : "") + "Missing answer key.";
        return {
          localId: `item_${idx}_${q.q_id ?? idx}`,
          q_num: q.q_num ?? idx + 1,
          options: o,
          section: q.section || "",
          ques_type: q.ques_type || "",
          source_id: q.source_id != null ? String(q.source_id) : "",
          answer_key: String(q.answer_key || "a").toLowerCase(),
          exam_history: Array.isArray(q.exam_history) ? q.exam_history : [],
          question_html: q.question_html || "",
          solution_html: q.solution_html || "",
          parseError,
        };
      });

      setScan({ folder: data.folder, jsonFile: data.jsonFile, images: data.images || [], warnings: data.warnings || [] });
      setItems(parsed);
      setUploaded({});
      setDeployed(false);
      if (parsed.length === 0) setLoadError(`${data.jsonFile} has no questions in it.`);
    } catch (err) {
      setScan(null);
      setItems([]);
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // --- derived: image bookkeeping -------------------------------------------
  const files = useMemo(() => {
    const m = new Map();
    for (const im of scan?.images || []) m.set(im.name.toLowerCase(), im.name);
    return m;
  }, [scan]);

  const ctx = useMemo(() => ({ files, uploaded, folder: scan?.folder || "" }), [files, uploaded, scan]);
  const ctxVersion = useMemo(() => `${scan?.folder}|${Object.keys(uploaded).length}|${files.size}`, [scan, uploaded, files]);

  const imageStats = useMemo(() => {
    const usage = new Map(); // normalized token name -> count
    for (const it of items) for (const r of refsOf(it)) usage.set(r, (usage.get(r) || 0) + 1);
    const missing = [...usage.keys()].filter((r) => !files.has(r));
    const referencedFiles = [...new Set([...usage.keys()].filter((r) => files.has(r)).map((r) => files.get(r)))];
    const pending = referencedFiles.filter((f) => !uploaded[f]);
    const unused = (scan?.images || []).filter((im) => !usage.has(im.name.toLowerCase()));
    return { usage, missing, referencedFiles, pending, unused };
  }, [items, files, uploaded, scan]);

  const validItems = items.filter((it) => !it.parseError);
  const errorCount = items.length - validItems.length;
  const locked = Object.keys(uploaded).length > 0; // chapter decides the bucket folder -> lock after first upload

  const handleAnswerChange = useCallback((localId, key) => {
    setItems((prev) => prev.map((it) => (it.localId === localId ? { ...it, answer_key: key } : it)));
    setDeployed(false);
  }, []);
  const handleRemoveItem = useCallback((localId) => {
    setItems((prev) => prev.filter((it) => it.localId !== localId));
    setDeployed(false);
  }, []);

  // --- Upload images -------------------------------------------------------
  async function handleUploadImages() {
    if (!chapterId) { setToast({ type: "error", message: "Pick a chapter in the top bar first." }); return; }
    const names = imageStats.pending;
    if (names.length === 0) { setToast({ type: "error", message: "No images waiting to be uploaded." }); return; }

    setUploadProgress({ isActive: true, current: 0, total: names.length });
    const BATCH = 6;
    let done = 0;
    const failed = [];
    const got = {};
    for (let i = 0; i < names.length; i += BATCH) {
      const batch = names.slice(i, i + BATCH);
      try {
        const res = await fetch("/api/admin/pyq-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderPath: scan.folder, chapterId, names: batch }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed.");
        Object.assign(got, data.uploaded || {});
        if (data.failed?.length) failed.push(...data.failed);
        setUploaded((prev) => ({ ...prev, ...(data.uploaded || {}) }));
      } catch (err) {
        batch.forEach((n) => failed.push({ name: n, error: err.message }));
      }
      done += batch.length;
      setUploadProgress({ isActive: true, current: done, total: names.length });
    }
    setUploadProgress({ isActive: false, current: 0, total: 0 });

    const okCount = Object.keys(got).length;
    if (failed.length) {
      console.error("Image upload failures:", failed);
      setToast({ type: "error", message: `${okCount} uploaded, ${failed.length} failed (${failed[0].name}: ${failed[0].error}). Click again to retry the rest.` });
    } else {
      setToast({ type: "success", message: `Uploaded ${okCount} image(s) to PYQ_IMAGES/${chapterId}/. Links inserted (green).` });
    }
  }

  // --- Deploy ----------------------------------------------------------------
  function handleDeploy() {
    if (!chapterId) {
      setModalConfig({ isOpen: true, title: "No chapter selected", message: "Pick a chapter from the top bar before deploying.", onConfirm: null });
      return;
    }
    if (imageStats.missing.length || imageStats.pending.length) {
      setModalConfig({
        isOpen: true,
        title: "Images not ready",
        message: imageStats.missing.length
          ? `Missing image file(s): ${imageStats.missing.join(", ")}. Add them to the images folder and Load again, or remove those questions.`
          : "Upload the images first so every [href=...] becomes a real link.",
        onConfirm: null,
      });
      return;
    }
    setModalConfig({
      isOpen: true,
      title: "Confirm deployment",
      message: `Deploy ${validItems.length} question(s) into "${activeChapterRow?.chapter_name}" (PYQ, MHT-CET)? They are added after the ${chapterQuestionCount} already there.`,
      onConfirm: runDeploy,
    });
  }

  async function runDeploy() {
    setIsDeploying(true);
    try {
      const questions = validItems.map((it) => ({
        options: Object.fromEntries(["A", "B", "C", "D"].map((L) => [L, finalizeHtml(it.options[L], ctx)])),
        section: it.section,
        ques_type: it.ques_type,
        source_id: it.source_id,
        answer_key: it.answer_key,
        exam_history: it.exam_history,
        question_html: finalizeHtml(it.question_html, ctx),
        solution_html: finalizeHtml(it.solution_html, ctx),
      }));

      const res = await fetch("/api/admin/pyq-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chapterId,
          exam: activeChapterRow?.exam || "MHT-CET",
          subject,
          chapter: activeChapterRow?.chapter_name || "",
          questions,
        }),
      });
      const result = await res.json();
      if (!res.ok || !result.success) throw new Error(result.error || "Deploy failed.");

      setDeployed(true);
      setChapterQuestionCount(result.totalCount);
      setToast({ type: "success", message: `Deployed ${questions.length} question(s). Chapter total: ${result.totalCount}.` });
    } catch (err) {
      setToast({ type: "error", message: err.message });
    } finally {
      setIsDeploying(false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const canUpload = !uploadProgress.isActive && !!chapterId && imageStats.pending.length > 0;
  const fileNameFor = (usageKey) => files.get(usageKey);

  return (
    <div className="cmsv2-root">
      {/* ---------------- TOPBAR ---------------- */}
      <header className="cmsv2-topbar">
        <div className="cmsv2-brand">
          <span className="dot" />
          EXAM ENGINE
          <span className="badge">CMS v3 · PYQ</span>
        </div>

        <div className="cmsv2-taxonomy">
          <select className="cmsv2-select" value={standard} onChange={(e) => setStandard(e.target.value)} disabled={locked}>
            <option value="11th">11th</option>
            <option value="12th">12th</option>
          </select>
          <select className="cmsv2-select" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={locked}>
            {["Physics", "Chemistry", "Mathematics", "Biology"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select className="cmsv2-select" value={chapterId} onChange={(e) => setChapterId(e.target.value)} disabled={chapterOptions.length === 0 || locked}>
            {chapterOptions.length === 0 && <option value="">No chapters found</option>}
            {chapterOptions.map((c) => (
              <option key={c.id} value={c.id}>{c.chapter_name}</option>
            ))}
          </select>
        </div>

        <div className="cmsv2-count-pill">
          Already in PYQ: <strong>{chapterQuestionCount}</strong>
        </div>
      </header>

      {/* ---------------- SPLIT: FOLDER | OVERVIEW ---------------- */}
      <div className="cmsv2-main">
        <div className="cmsv2-editor-pane">
          <div className="cmsv2-pane-header">
            <span>Local PYQ folder</span>
          </div>
          <div className="pyq-left-scroll">
            <div>
              <div className="pyq-path-row">
                <input
                  className="pyq-path-input"
                  placeholder="/home/harshvardhan/PYQ_DB/Maths/1. LOGIC/mathematics-mathematical-reasoning (7)"
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleLoad(); }}
                  spellCheck={false}
                />
                <button type="button" className="cmsv2-btn cmsv2-btn-primary" onClick={handleLoad} disabled={loading}>
                  {loading ? "Loading…" : "Load"}
                </button>
              </div>
              <div className="pyq-hint" style={{ marginTop: 8 }}>
                The folder must contain <code>json/</code> (one .json file) and <code>images/</code>, exactly as the Question Bot ZIP unzips.
                Needs the site running on this PC (<code>npm run dev</code>).
              </div>
            </div>

            {loadError && <div className="pyq-error">{loadError}</div>}
            {(scan?.warnings || []).map((w, i) => <div key={i} className="pyq-warn">{w}</div>)}

            {scan && (
              <div className="pyq-box">
                <div className="pyq-box-title">Loaded</div>
                <div><strong>{scan.jsonFile}</strong> — {items.length} question(s){errorCount ? `, ${errorCount} flagged` : ""}</div>
                <div>{scan.images.length} image file(s) in the images folder</div>
              </div>
            )}

            {imageStats.missing.length > 0 && (
              <div className="pyq-error">
                <strong>{imageStats.missing.length} image(s) referenced in the JSON are NOT in the images folder:</strong>{" "}
                {imageStats.missing.join(", ")}. Deploy is blocked until they are added (then Load again) or their questions are removed.
              </div>
            )}

            {scan && (imageStats.usage.size > 0 || scan.images.length > 0) && (
              <div className="pyq-box">
                <div className="pyq-box-title">Images</div>
                <table className="pyq-table">
                  <thead>
                    <tr><th>Reference</th><th>Used</th><th>Size</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {[...imageStats.usage.keys()].map((key) => {
                      const file = fileNameFor(key);
                      const up = file && uploaded[file];
                      const im = file && scan.images.find((x) => x.name === file);
                      return (
                        <tr key={key} className={file ? "" : "is-missing"}>
                          <td className="mono">{file || key}</td>
                          <td>×{imageStats.usage.get(key)}</td>
                          <td>{im ? fmtSize(im.size) : "—"}</td>
                          <td>
                            {!file && <span className="pyq-chip bad">missing</span>}
                            {file && !up && <span className="pyq-chip info">ready</span>}
                            {up && <span className="pyq-chip ok">→ {up.path}</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {imageStats.unused.map((im) => (
                      <tr key={im.name}>
                        <td className="mono">{im.name}</td>
                        <td>—</td>
                        <td>{fmtSize(im.size)}</td>
                        <td><span className="pyq-chip">not used in JSON</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="cmsv2-preview-pane">
          <div className="cmsv2-pane-header">
            <span>
              Overview {items.length > 0 && `(${validItems.length} ready${errorCount ? `, ${errorCount} flagged` : ""})`}
            </span>
          </div>
          <div className="cmsv2-preview-scroll">
            {items.length === 0 && (
              <div className="qv2-empty-state">
                Enter the folder path on the left and press Load.<br />
                Every question shows up here — images found locally are outlined orange, uploaded ones green, missing ones red.
              </div>
            )}
            {items.map((item) => (
              <QuestionCard
                key={item.localId}
                item={item}
                ctx={ctx}
                ctxVersion={ctxVersion}
                onAnswerChange={handleAnswerChange}
                onRemove={handleRemoveItem}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ---------------- FOOTER ---------------- */}
      <footer className="cmsv2-footer">
        <div className="cmsv2-breadcrumb">
          <strong>{activeChapterRow?.exam || "MHT-CET"}</strong> → PYQ → {standard} → {subject} → {activeChapterRow?.chapter_name || "—"}
        </div>

        <div className="cmsv2-actions">
          {uploadProgress.isActive && (
            <div className="cmsv2-progress-line">
              <div className="cmsv2-progress-fill" style={{ width: uploadProgress.total > 0 ? `${(uploadProgress.current / uploadProgress.total) * 100}%` : "0%" }} />
            </div>
          )}

          <button
            type="button"
            className="cmsv2-btn"
            onClick={handleUploadImages}
            disabled={!canUpload}
            style={locked && imageStats.pending.length === 0 && !uploadProgress.isActive ? { backgroundColor: "#34c759", borderColor: "#34c759", color: "#fff" } : undefined}
          >
            {uploadProgress.isActive
              ? `Uploading ${uploadProgress.current}/${uploadProgress.total}…`
              : locked && imageStats.pending.length === 0
              ? "✓ Images uploaded"
              : `Upload Images${imageStats.pending.length ? ` (${imageStats.pending.length})` : ""}`}
          </button>

          <button
            type="button"
            className="cmsv2-btn cmsv2-btn-primary"
            onClick={handleDeploy}
            disabled={isDeploying || deployed || validItems.length === 0}
            style={deployed ? { backgroundColor: "#34c759", borderColor: "#34c759", color: "#fff" } : undefined}
          >
            {isDeploying ? "Deploying…" : deployed ? "✓ Deployed" : `Deploy ${validItems.length || ""}`}
          </button>
        </div>
      </footer>

      {/* ---------------- MODAL ---------------- */}
      {modalConfig.isOpen && (
        <div className="cmsv2-modal-overlay">
          <div className="cmsv2-modal-box">
            <h3>{modalConfig.title}</h3>
            <p>{modalConfig.message}</p>
            <div className="cmsv2-modal-row">
              <button type="button" className="cmsv2-btn" onClick={() => setModalConfig((p) => ({ ...p, isOpen: false }))}>
                {modalConfig.onConfirm ? "Cancel" : "Close"}
              </button>
              {modalConfig.onConfirm && (
                <button
                  type="button"
                  className="cmsv2-btn cmsv2-btn-primary"
                  onClick={() => {
                    modalConfig.onConfirm();
                    setModalConfig((p) => ({ ...p, isOpen: false }));
                  }}
                >
                  Continue
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`cmsv2-toast ${toast.type === "success" ? "is-success" : "is-error"}`}>{toast.message}</div>
      )}
    </div>
  );
}
