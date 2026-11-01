// lib/questionBot/parsePage.js  (new file)
//
// ExamSIDE page HTML  ->  { meta, questions[], images[] }   (parseExamsidePage)
// parsed result + user settings -> final JSON array + image list  (buildOutput)
//
// Pure JS, no DOM/Node APIs: runs identically in the browser and in a server route.

import {
  parseHtml, isEl, elChildren, hasClass, findAll, findFirst, textOf,
} from "./miniDom.js";
import { collectGlyphDefs, convertMjx, isMjx } from "./mathConvert.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const IMG_TOKEN = (k) => `[[IMG:${k}]]`;

const KEEP_ATTRS = { a: ["href"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] };
const DROP_TAGS = new Set(["script", "style", "button", "ins", "noscript", "iframe", "svg", "link", "meta"]);
const VOID_OUT = new Set(["br", "hr"]);

function safeHref(h) {
  return /^(https?:\/\/|\/|#)/i.test(h || "") ? h : null;
}

// Serialises a node's children to clean question-bank HTML.
function serializeNodes(nodes, ctx) {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") { out += n.text; continue; }
    if (!isEl(n)) continue;
    const tag = n.tag;

    if (isMjx(n)) {
      const r = convertMjx(n, ctx.defs, ctx.mathMode);
      if (r.kind === "mathml") ctx.stats.mathml++;
      else if (r.kind === "svg") ctx.stats.svg++;
      out += r.html;
      continue;
    }
    if (tag === "img") {
      const url = n.attrs.src || n.attrs["data-orsrc"] || "";
      if (!url) continue;
      const key = ctx.imageKey(url, n.attrs["data-orsrc"]);
      ctx.usedImages.add(key);
      out += `<img src="${IMG_TOKEN(key)}" alt="${esc(n.attrs.alt || "")}" class="question-image" style="height:auto; max-width:100%"/>`;
      continue;
    }
    if (DROP_TAGS.has(tag)) continue;

    if (VOID_OUT.has(tag)) { out += `<${tag}>`; continue; }

    let attrs = "";
    for (const a of KEEP_ATTRS[tag] || []) {
      let v = n.attrs[a];
      if (a === "href") v = safeHref(v);
      if (v) attrs += ` ${a}="${esc(v)}"`;
    }
    out += `<${tag}${attrs}>${serializeNodes(n.children, ctx)}</${tag}>`;
  }
  return out;
}

const BLOCK_START = /^\s*<(p|div|ul|ol|table|pre|h[1-6]|blockquote)[\s>]/i;
function toBlockHtml(h) {
  h = h.replace(/\u00a0/g, " ").trim();
  if (!h) return "";
  if (BLOCK_START.test(h)) return h;
  h = h.replace(/^(\s*<br\s*\/?>)+|(<br\s*\/?>\s*)+$/gi, "");
  h = h.replace(/(<br\s*\/?>\s*){2,}/gi, "</p><p>");
  return `<p>${h}</p>`;
}

function guessAnswerKey(solutionText) {
  const t = solutionText.replace(/\s+/g, " ");
  const re = /correct\s+(?:option|answer|choice)\s*(?:is|:)?\s*\(?\s*([A-Da-d])\s*\)?(?![\w])/gi;
  let m, last = null;
  while ((m = re.exec(t))) last = m[1];
  return last ? last.toLowerCase() : "";
}
function guessNumericAnswer(solutionText) {
  const t = solutionText.replace(/\s+/g, " ");
  const m = /correct\s+answer\s*(?:is|:)\s*([-+]?[\d.]+(?:\s*[a-zA-Zμ°%\/]+)?)/i.exec(t);
  return m ? m[1].trim() : "";
}

export function parseExamsidePage(html, opts = {}) {
  const mathMode = opts.mathMode || "mathml";
  const root = parseHtml(html);
  const defs = collectGlyphDefs(root);

  // ---- page meta -----------------------------------------------------------
  const titleEl = findFirst(root, (n) => n.tag === "title");
  const title = clean(titleEl ? textOf(titleEl) : "");
  const crumbs = [];
  const nav = findFirst(root, (n) => n.tag === "nav" && n.attrs["aria-label"] === "Breadcrumb");
  if (nav) {
    for (const li of findAll(nav, (n) => n.tag === "li")) crumbs.push(clean(textOf(li)));
  }
  const h1 = findFirst(root, (n) => n.tag === "h1" && hasClass(n, "page-title"));
  const canonical = findFirst(root, (n) => n.tag === "link" && n.attrs.rel === "canonical");
  const meta = {
    title,
    sourceUrl: canonical ? canonical.attrs.href : opts.sourceUrl || "",
    exam: crumbs[0] || "",
    subject: crumbs[1] || "",
    chapter: clean(h1 ? textOf(h1) : "") || crumbs[2] || "",
    typeLabel: crumbs[3] || "",
  };

  // ---- images registry -------------------------------------------------------
  const images = [];
  const urlToKey = new Map();
  const stats = { mathml: 0, svg: 0 };
  const baseCtx = {
    defs, mathMode, stats,
    imageKey(url, orig) {
      if (urlToKey.has(url)) return urlToKey.get(url);
      const key = images.length;
      images.push({ key, url, altUrl: orig && orig !== url ? orig : "" });
      urlToKey.set(url, key);
      return key;
    },
  };

  // ---- questions -------------------------------------------------------------
  const qEls = findAll(root, (n) => n.attrs && n.attrs["data-question"] !== undefined && hasClass(n, "question-component"));
  const questions = qEls.map((qEl, idx) => {
    const ctx = { ...baseCtx, usedImages: new Set() };
    const warnings = [];

    const idxEl = findFirst(qEl, (n) => hasClass(n, "q-index"));
    const paperEl = findFirst(qEl, (n) => hasClass(n, "q-paper"));
    const typeEl = findFirst(qEl, (n) => hasClass(n, "q-chip-type"));
    const plus = findFirst(qEl, (n) => hasClass(n, "marks-plus"));
    const minus = findFirst(qEl, (n) => hasClass(n, "marks-minus"));

    const body = findFirst(qEl, (n) => hasClass(n, "q-body"));
    const stemEl = body && findFirst(body, (n) => hasClass(n, "question") && hasClass(n, "q-prose"));
    const questionHtml = stemEl ? toBlockHtml(serializeNodes(stemEl.children, ctx)) : "";
    if (!questionHtml) warnings.push("No question text found");

    const options = {};
    for (const opt of findAll(qEl, (n) => hasClass(n, "option") && n.attrs["data-option"] !== undefined)) {
      const badge = findFirst(opt, (n) => hasClass(n, "option-badge"));
      const content = findFirst(opt, (n) => hasClass(n, "option-content"));
      const letter = clean(badge ? textOf(badge) : "").charAt(0).toUpperCase() || String.fromCharCode(65 + Object.keys(options).length);
      options[letter] = content ? toBlockHtml(serializeNodes(content.children, ctx)) : "";
    }

    const resultEl = findFirst(qEl, (n) => hasClass(n, "q-result"));
    const solEl = resultEl && findFirst(resultEl, (n) => hasClass(n, "question") && hasClass(n, "q-prose"));
    const solutionHtml = solEl ? toBlockHtml(serializeNodes(solEl.children, ctx)) : "";
    const solText = solEl ? clean(textOf(solEl)) : "";

    let answerKey = guessAnswerKey(solText);
    const hasOptions = Object.keys(options).length > 0;
    if (!hasOptions) {
      answerKey = guessNumericAnswer(solText);
      warnings.push("No options on this question (numerical?)");
    }
    if (!answerKey) warnings.push("Could not detect the correct answer - fill answer_key by hand");
    if (!solutionHtml) warnings.push("No explanation found");

    return {
      key: idx,
      qid: qEl.attrs["data-qid"] || "",
      index: parseInt(clean(idxEl ? textOf(idxEl) : ""), 10) || idx + 1,
      paper: clean(paperEl ? textOf(paperEl) : ""),
      typeLabel: clean(typeEl ? textOf(typeEl) : ""),
      marks: clean(plus ? textOf(plus) : ""),
      negMarks: clean(minus ? textOf(minus) : ""),
      questionHtml, options, solutionHtml, answerKey,
      imageKeys: [...ctx.usedImages],
      warnings,
    };
  });

  return { meta, questions, images, stats };
}

const SUBJECT_LETTER = { physics: "P", chemistry: "C", mathematics: "M", maths: "M", math: "M", biology: "B" };
export const subjectLetter = (subject) => SUBJECT_LETTER[(subject || "").trim().toLowerCase()] || "P";

export function randomPrefix(len = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
const hex4 = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");

/**
 * parsed      : result of parseExamsidePage
 * settings    : { prefix, startNum, section, quesType, sourceStart }
 * selectedKeys: array of question keys to include (page order is kept)
 * returns { json, images:[{name,key,url,altUrl}], warnings }
 */
export function buildOutput(parsed, settings, selectedKeys) {
  const chosen = parsed.questions.filter((q) => selectedKeys.includes(q.key));
  const nameByKey = new Map();
  const imageList = [];
  const nameFor = (key) => {
    if (!nameByKey.has(key)) {
      const name = `image${nameByKey.size + 1}.png`;
      nameByKey.set(key, name);
      const src = parsed.images.find((i) => i.key === key);
      imageList.push({ name, key, url: src.url, altUrl: src.altUrl });
    }
    return nameByKey.get(key);
  };
  const swap = (html) =>
    html.replace(/\[\[IMG:(\d+)\]\]/g, (_, k) => `[href=${nameFor(Number(k)).replace(/\.png$/, "")}]`);

  const startNum = Number(settings.startNum) || 1;
  const sourceStart = Number(settings.sourceStart) || 1;
  const json = chosen.map((q, i) => {
    const options = {};
    for (const [L, h] of Object.entries(q.options)) options[L] = swap(h);
    // order of appearance for image numbering: question, options, solution
    return {
      q_id: `${settings.prefix}_${startNum + i}_${hex4()}`,
      q_num: startNum + i,
      options,
      section: settings.section || "",
      ...(settings.chapterId && settings.includeChapterId !== false ? { chapter_id: settings.chapterId } : {}),
      ques_type: settings.quesType || "P",
      source_id: String(sourceStart + i),
      answer_key: q.answerKey,
      exam_history: q.paper ? [q.paper] : [],
      question_html: swap(q.questionHtml),
      solution_html: swap(q.solutionHtml),
    };
  });

  const warnings = [];
  chosen.forEach((q, i) => q.warnings.forEach((w) => warnings.push(`Q${startNum + i} (page #${q.index}): ${w}`)));
  return { json, images: imageList, warnings };
}
