// app/admin/question-bot/page.js  (new file)
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseExamsidePage, buildOutput, subjectLetter, randomPrefix } from "@/lib/questionBot/parsePage";
import { chaptersFor, matchChapter } from "@/lib/questionBot/syllabus";
import styles from "./questionBot.module.css";

const API_FETCH = "/api/admin/question-bot/fetch";
const API_CONVERT = "/api/admin/question-bot/convert";
const LS_MODE = "qbot_processing_mode";

const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

async function ensurePng(bytes) {
  if (isPng(bytes)) return bytes;
  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

// LOCAL mode image download: try the CDN directly from the browser (free, no Vercel usage);
// if CORS blocks it, relay through the tiny proxy route.
async function fetchImageLocal(img) {
  let last = "no url";
  for (const u of [img.url, img.altUrl].filter(Boolean)) {
    try {
      const r = await fetch(u, { mode: "cors" });
      if (r.ok) return await ensurePng(new Uint8Array(await r.arrayBuffer()));
    } catch {}
    try {
      const r = await fetch(API_FETCH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: u, kind: "image" }),
      });
      if (r.ok) return await ensurePng(new Uint8Array(await r.arrayBuffer()));
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.message;
    }
  }
  throw new Error(last);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const slugify = (s) => (s || "questions").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "questions";

export default function QuestionBotPage() {
  const [inputMode, setInputMode] = useState("url"); // url | paste
  const [url, setUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [processing, setProcessing] = useState("local"); // local | server
  const [mathMode, setMathMode] = useState("mathml");
  const [settings, setSettings] = useState({ prefix: "", startNum: 1, section: "", chapterId: "", includeChapterId: true, quesType: "P", sourceStart: 1 });

  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [error, setError] = useState("");
  const [parsed, setParsed] = useState(null);
  const [imageData, setImageData] = useState({}); // key -> { bytes, blobUrl } | { error }
  const [selected, setSelected] = useState([]);
  const [answers, setAnswers] = useState({}); // manual answer picks: key -> "a".."d" / numeric text
  const [copied, setCopied] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    setSettings((s) => ({ ...s, prefix: s.prefix || randomPrefix() }));
    try {
      const saved = localStorage.getItem(LS_MODE);
      if (saved === "local" || saved === "server") setProcessing(saved);
    } catch {}
  }, []);

  function chooseProcessing(m) {
    setProcessing(m);
    try { localStorage.setItem(LS_MODE, m); } catch {}
  }
  const say = (m) => setLog((l) => [...l, m]);
  const set = (k) => (e) => setSettings((s) => ({ ...s, [k]: e.target.value }));

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setPasted(await f.text());
    e.target.value = "";
  }

  async function run() {
    setError("");
    setLog([]);
    setParsed(null);
    setImageData({});
    setAnswers({});
    setBusy(true);
    try {
      const usingPaste = inputMode === "paste";
      if (usingPaste && !pasted.trim()) throw new Error("Paste the page response (or choose the .txt file) first.");
      if (!usingPaste && !/^https:\/\/[^ ]+/i.test(url.trim())) throw new Error("Enter a full https:// ExamSIDE question URL.");

      let result, images = {};
      if (processing === "server") {
        say("Server mode: sending to /api/admin/question-bot/convert ...");
        const r = await fetch(API_CONVERT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(usingPaste ? { html: pasted } : { url: url.trim() }), mathMode }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Server answered ${r.status}`);
        result = data.parsed;
        for (const im of data.images) {
          if (im.error) images[im.key] = { error: im.error };
          else {
            const bytes = b64ToBytes(im.base64);
            images[im.key] = { bytes, blobUrl: URL.createObjectURL(new Blob([bytes], { type: "image/png" })) };
          }
        }
      } else {
        let html = pasted;
        if (!usingPaste) {
          say("Local mode: fetching the page through the relay ...");
          const r = await fetch(API_FETCH, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: url.trim(), kind: "html" }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `Relay answered ${r.status}`);
          html = data.html;
        }
        say("Parsing questions and converting math in this browser ...");
        result = parseExamsidePage(html, { mathMode, sourceUrl: usingPaste ? "" : url.trim() });
        if (!result.questions.length) throw new Error("No questions were found in that page.");
        let done = 0;
        for (const img of result.images) {
          say(`Downloading image ${++done}/${result.images.length} ...`);
          try {
            const bytes = await fetchImageLocal(img);
            images[img.key] = { bytes, blobUrl: URL.createObjectURL(new Blob([bytes], { type: "image/png" })) };
          } catch (e) {
            images[img.key] = { error: e.message };
          }
        }
      }

      setParsed(result);
      setImageData(images);
      setSelected(result.questions.map((q) => q.key));
      const hit = matchChapter(result.meta.subject, result.meta.chapter);
      setSettings((s) => ({
        ...s,
        section: hit ? hit.name : result.meta.chapter || s.section,
        chapterId: hit ? hit.id : "",
        quesType: subjectLetter(result.meta.subject),
        prefix: randomPrefix(),
      }));
      say(`Done: ${result.questions.length} question(s), ${result.images.length} image(s), math -> ${result.stats.mathml} MathML / ${result.stats.svg} SVG.`);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const built = useMemo(() => (parsed ? buildOutput(parsed, settings, selected, answers) : null), [parsed, settings, selected, answers]);
  const jsonText = useMemo(() => (built ? JSON.stringify(built.json, null, 2) : ""), [built]);
  const chosen = useMemo(() => (parsed ? parsed.questions.filter((q) => selected.includes(q.key)) : []), [parsed, selected]);

  const imageWarnings = useMemo(() => {
    if (!built) return [];
    return built.images.filter((im) => imageData[im.key]?.error).map((im) => `${im.name}: ${imageData[im.key].error}`);
  }, [built, imageData]);

  function withPreviewImages(html) {
    return html.replace(/\[href=(image\d+)\]/g, (_, name) => {
      const im = built.images.find((i) => i.name === `${name}.png`);
      return (im && imageData[im.key]?.blobUrl) || "";
    });
  }

  const baseName = slugify(`${parsed?.meta?.subject || ""}-${settings.section || parsed?.meta?.chapter || "questions"}`);

  function downloadJson() {
    download(new Blob([jsonText], { type: "application/json" }), `${baseName}.json`);
  }
  async function downloadZip() {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.folder("json").file(`${baseName}.json`, jsonText);
    const imgs = zip.folder("images");
    for (const im of built.images) {
      const d = imageData[im.key];
      if (d?.bytes) imgs.file(im.name, d.bytes);
    }
    download(await zip.generateAsync({ type: "blob" }), `${baseName}.zip`);
  }
  async function copyJson() {
    try {
      await navigator.clipboard.writeText(jsonText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }
  const setAnswer = (key, v) => setAnswers((a) => ({ ...a, [key]: v }));
  const toggle = (key) => setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.eyebrow}>Tools</div>
        <h1 className={styles.title}>Question Bot</h1>
        <p className={styles.sub}>
          Paste an ExamSIDE question link. The bot reads the page, converts every question on it to your exam-JSON
          format, grabs the images and gives you a ready-to-download JSON + ZIP.
        </p>
      </div>

      <section className={styles.card}>
        <div className={styles.row}>
          <div className={styles.seg} role="tablist" aria-label="Source type">
            <button type="button" className={inputMode === "url" ? styles.segOn : ""} onClick={() => setInputMode("url")}>Source URL</button>
            <button type="button" className={inputMode === "paste" ? styles.segOn : ""} onClick={() => setInputMode("paste")}>Paste / upload page</button>
          </div>
        </div>

        {inputMode === "url" ? (
          <input
            className={styles.input}
            placeholder="https://questions.examside.com/past-years/jee/question/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && run()}
            spellCheck={false}
          />
        ) : (
          <>
            <div className={styles.row}>
              <button type="button" className={styles.btnGhost} onClick={() => fileRef.current?.click()}>Choose .txt / .html file</button>
              <input ref={fileRef} type="file" accept=".txt,.html,.htm,text/*" hidden onChange={onFile} />
              <span className={styles.hint}>{pasted ? `${(pasted.length / 1024).toFixed(0)} KB loaded` : "or paste the page response below"}</span>
            </div>
            <textarea
              className={styles.textarea}
              placeholder="Paste the full page HTML response here (view-source / saved .txt)..."
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              spellCheck={false}
            />
          </>
        )}

        <div className={styles.grid2}>
          <div>
            <label className={styles.label}>Processing</label>
            <div className={styles.seg}>
              <button type="button" className={processing === "local" ? styles.segOn : ""} onClick={() => chooseProcessing("local")}>Local (browser)</button>
              <button type="button" className={processing === "server" ? styles.segOn : ""} onClick={() => chooseProcessing("server")}>Server-side</button>
            </div>
            <p className={styles.hint}>
              {processing === "local"
                ? "Free-plan friendly: the server only relays the raw page; parsing, math conversion and zipping happen in this browser."
                : "Everything runs in a Vercel function and returns the result. Best after upgrading (longer limits); on the free plan big pages can time out."}
            </p>
          </div>
          <div>
            <label className={styles.label}>Math formulas</label>
            <div className={styles.seg}>
              <button type="button" className={mathMode === "mathml" ? styles.segOn : ""} onClick={() => setMathMode("mathml")}>MathML (SVG fallback)</button>
              <button type="button" className={mathMode === "svg" ? styles.segOn : ""} onClick={() => setMathMode("svg")}>Keep as SVG</button>
            </div>
            <p className={styles.hint}>MathML matches your existing question_html. Formulas it cannot rebuild are kept as inline SVG automatically.</p>
          </div>
        </div>

        <div className={styles.row}>
          <button type="button" className={styles.btnPrimary} onClick={run} disabled={busy}>
            {busy ? "Working..." : "Convert"}
          </button>
        </div>
        {error && <p className={styles.error}>{error}</p>}
        {log.length > 0 && <pre className={styles.log}>{log.join("\n")}</pre>}
      </section>

      {parsed && built && (
        <>
          <section className={styles.card}>
            <h2 className={styles.h2}>Output settings</h2>
            <p className={styles.hint}>{parsed.meta.title}</p>
            <div className={styles.grid4}>
              <div><label className={styles.label}>q_id prefix</label><input className={styles.input} value={settings.prefix} onChange={set("prefix")} /></div>
              <div><label className={styles.label}>First q_num</label><input className={styles.input} type="number" min="1" value={settings.startNum} onChange={set("startNum")} /></div>
              <div><label className={styles.label}>ques_type</label><input className={styles.input} value={settings.quesType} onChange={set("quesType")} maxLength={2} /></div>
              <div><label className={styles.label}>First source_id</label><input className={styles.input} type="number" min="1" value={settings.sourceStart} onChange={set("sourceStart")} /></div>
            </div>
            <label className={styles.label} style={{ marginTop: 12 }}>section (syllabus chapter)</label>
            <select
              className={styles.input}
              value={settings.chapterId || ""}
              onChange={(e) => {
                const c = chaptersFor(parsed.meta.subject).find((x) => x.id === e.target.value);
                setSettings((s) => ({ ...s, chapterId: c ? c.id : "", section: c ? c.name : s.section }));
              }}
            >
              <option value="">Custom (type below)</option>
              {chaptersFor(parsed.meta.subject).map((c) => (
                <option key={c.id} value={c.id}>{c.standard} - {c.name} ({c.id})</option>
              ))}
            </select>
            {!settings.chapterId && <p className={styles.warn}>No syllabus chapter matched "{parsed.meta.chapter}" - pick one above or type a custom section.</p>}
            <input className={styles.input} style={{ marginTop: 8 }} value={settings.section} onChange={set("section")} />
            <label className={styles.hint} style={{ display: "block" }}>
              <input type="checkbox" checked={settings.includeChapterId} onChange={(e) => setSettings((s) => ({ ...s, includeChapterId: e.target.checked }))} /> add chapter_id field to each question
            </label>

            <div className={styles.row} style={{ marginTop: 16 }}>
              <button type="button" className={styles.btnPrimary} onClick={downloadZip} disabled={!built.json.length}>Download ZIP (json + images)</button>
              <button type="button" className={styles.btnGhost} onClick={downloadJson} disabled={!built.json.length}>Download JSON</button>
              <button type="button" className={styles.btnGhost} onClick={copyJson} disabled={!built.json.length}>{copied ? "Copied" : "Copy JSON"}</button>
            </div>
            <p className={styles.hint}>
              {built.json.length} question(s) - {built.images.filter((i) => imageData[i.key]?.bytes).length}/{built.images.length} image(s) in the zip
              - math: {parsed.stats.mathml} MathML, {parsed.stats.svg} SVG
            </p>
            {chosen.map((q, i) => {
              const needs = !q.answerKey || answers[q.key] !== undefined;
              if (!needs) return null;
              const qn = (Number(settings.startNum) || 1) + i;
              const cur = built.json[i].answer_key;
              return (
                <div key={q.key} className={`${styles.ansPick} ${cur ? "" : styles.ansMissing}`}>
                  <span className={styles.ansLabel}>
                    Q{qn} (page #{q.index}): {cur ? `answer set to ${cur.toUpperCase()}` : "answer not detected - choose:"}
                  </span>
                  {Object.keys(q.options).length > 0 ? (
                    Object.keys(q.options).map((L) => (
                      <button
                        key={L}
                        type="button"
                        className={`${styles.ansBtn} ${cur === L.toLowerCase() ? styles.ansBtnOn : ""}`}
                        onClick={() => setAnswer(q.key, L.toLowerCase())}
                      >{L}</button>
                    ))
                  ) : (
                    <input
                      className={styles.ansInput}
                      placeholder="numeric answer"
                      value={answers[q.key] ?? ""}
                      onChange={(e) => setAnswer(q.key, e.target.value)}
                    />
                  )}
                  {answers[q.key] !== undefined && (
                    <button type="button" className={styles.ansClear} onClick={() => setAnswers((a) => { const n = { ...a }; delete n[q.key]; return n; })}>reset</button>
                  )}
                </div>
              );
            })}
            {[...imageWarnings, ...built.warnings].map((w, i) => (
              <p key={i} className={styles.warn}>{w}</p>
            ))}
          </section>

          <section className={styles.card}>
            <h2 className={styles.h2}>Questions on this page</h2>
            <p className={styles.hint}>Untick any question you do not want in the JSON / zip.</p>
            {parsed.questions.map((q) => {
              const on = selected.includes(q.key);
              const outIdx = chosen.findIndex((c) => c.key === q.key);
              const out = outIdx >= 0 ? built.json[outIdx] : null;
              return (
                <div key={q.key} className={`${styles.q} ${on ? "" : styles.qOff}`}>
                  <label className={styles.qHead}>
                    <input type="checkbox" checked={on} onChange={() => toggle(q.key)} />
                    <b>#{q.index}</b>
                    <span className={styles.chip}>{q.paper}</span>
                    <span className={styles.chip}>answer: {(out ? out.answer_key : answers[q.key] || q.answerKey || "?").toUpperCase() || "?"}{answers[q.key] ? " (manual)" : ""}</span>
                    {out && <span className={styles.chip}>{out.q_id}</span>}
                  </label>
                  {out && (
                    <>
                      <div className={styles.prev} dangerouslySetInnerHTML={{ __html: withPreviewImages(out.question_html) }} />
                      <div className={styles.opts}>
                        {Object.entries(out.options).map(([L, h]) => (
                          <div key={L} className={`${styles.opt} ${L.toLowerCase() === out.answer_key ? styles.optOk : ""}`}>
                            <span>{L}</span>
                            <div className={styles.prev} dangerouslySetInnerHTML={{ __html: withPreviewImages(h) }} />
                          </div>
                        ))}
                      </div>
                      <details>
                        <summary>Solution</summary>
                        <div className={styles.prev} dangerouslySetInnerHTML={{ __html: withPreviewImages(out.solution_html) }} />
                      </details>
                    </>
                  )}
                </div>
              );
            })}
          </section>

          <section className={styles.card}>
            <details>
              <summary className={styles.h2}>JSON preview</summary>
              <textarea className={styles.textarea} style={{ minHeight: 280 }} readOnly value={jsonText} />
            </details>
          </section>
        </>
      )}
    </div>
  );
}
