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


// ---------------------------------------------------------------------------
// Layout-tolerant helpers (added so single-question pages such as
// questions.examside.com/past-years/<exam>/question/<slug> work like the chapter pages).
// ---------------------------------------------------------------------------
const EXPL_RE =
  /^(?:detailed\s+|step[-\s]by[-\s]step\s+)?(?:explanation|solution|answer\s*(?:&|and)\s*explanation|explanation\s*(?:&|and)\s*solution)\s*:?$/i;
const EXPL_CLASS_RE = /(^|[\s_-])(explanation|solution|q-expl\w*|q-sol\w*)($|[\s_-])/i;
const STOP_CLASS_RE = /(^|[\s_-])(pdf|download|related|pagination|pager|prev-next|q-nav|breadcrumb|sidebar|footer|share|ads|advert)($|[\s_-])/i;
const LABEL_TAGS = new Set(["div", "span", "p", "strong", "b", "summary", "legend", "header", "label", "h1", "h2", "h3", "h4", "h5", "h6"]);
const headingLevel = (n) => (isEl(n) && /^h([1-6])$/.test(n.tag) ? Number(n.tag[1]) : 0);
const isQuestionEl = (n) => isEl(n) && hasClass(n, "question-component");
const containsQuestion = (n) => isQuestionEl(n) || !!findFirst(n, isQuestionEl);
const hasMedia = (n) => n.type === "el" && (n.tag === "img" || n.tag === "mjx-container" || !!findFirst(n, (x) => x.tag === "img" || x.tag === "mjx-container"));
const nodeHasContent = (n) => (n.type === "text" ? !!n.text.trim() : !!clean(textOf(n)) || hasMedia(n));

function insideClass(node, cls, stopAt) {
  for (let p = node.parent; p && p !== stopAt; p = p.parent) if (hasClass(p, cls)) return true;
  return false;
}

// Removes a leading "Explanation" / "Solution" label from serialised html.
function stripLabel(html) {
  return html.replace(/^\s*<(h[1-6]|p|div|strong|b|span)[^>]*>\s*(?:explanation|solution)\s*:?\s*<\/\1>\s*/i, "");
}

function findExplanationHeading(scope) {
  return findFirst(scope, (n) => {
    if (!LABEL_TAGS.has(n.tag) || isQuestionEl(n)) return false;
    if (elChildren(n).length > 2) return false;
    const t = clean(textOf(n));
    return t.length > 0 && t.length < 40 && EXPL_RE.test(t);
  });
}

// Nodes that follow an "Explanation" heading until the next heading / pdf / nav block.
function collectAfterHeading(h) {
  const lvl = headingLevel(h) || 6;
  let node = h;
  for (let up = 0; up < 4 && node && node.parent; up++) {
    const sibs = node.parent.children;
    const got = [];
    for (let i = sibs.indexOf(node) + 1; i < sibs.length; i++) {
      const s = sibs[i];
      if (isEl(s)) {
        const hl = headingLevel(s);
        if (hl && hl <= lvl) break;
        if (["nav", "footer", "aside", "header"].includes(s.tag)) break;
        if (STOP_CLASS_RE.test(s.attrs.class || "")) break;
        if (containsQuestion(s)) break;
        if (/^\s*(download as pdf|pdf\b|related|previous|next)/i.test(clean(textOf(s)))) break;
      }
      got.push(s);
    }
    if (got.some(nodeHasContent)) return got;
    node = node.parent;
  }
  return [];
}

// Siblings (and ancestors' siblings) after the question card, up to the next question card.
function trailingRegion(qEl) {
  const nodes = [];
  let node = qEl;
  for (let up = 0; up < 3 && node && node.parent; up++) {
    const sibs = node.parent.children;
    let hitNext = false;
    for (let i = sibs.indexOf(node) + 1; i < sibs.length; i++) {
      if (isEl(sibs[i]) && containsQuestion(sibs[i])) { hitNext = true; break; }
      nodes.push(sibs[i]);
    }
    if (hitNext || nodes.some((x) => isEl(x) && findExplanationHeading({ children: [x] }))) break;
    node = node.parent;
  }
  return nodes;
}

function extractSolution(qEl, ctx) {
  const pack = (nodes) => {
    const html = stripLabel(toBlockHtml(serializeNodes(nodes, ctx)));
    const text = clean(nodes.map(textOf).join(" "));
    return html && (text || /<img|<math|<svg/.test(html)) ? { html, text } : null;
  };
  const resultEl = findFirst(qEl, (n) => hasClass(n, "q-result"));

  // 1. original layout: .q-result > .question.q-prose
  if (resultEl) {
    const el = findFirst(resultEl, (n) => hasClass(n, "question") && hasClass(n, "q-prose")) || findFirst(resultEl, (n) => hasClass(n, "q-prose"));
    const r = el && pack(el.children);
    if (r) return r;
  }
  // 2. any element classed explanation / solution (not a bare label)
  const byClass = findFirst(qEl, (n) =>
    EXPL_CLASS_RE.test(n.attrs.class || "") &&
    !hasClass(n, "q-body") && !EXPL_RE.test(clean(textOf(n))) && nodeHasContent(n));
  if (byClass) { const r = pack(byClass.children); if (r) return r; }
  // 3. the whole result block
  if (resultEl) { const r = pack(resultEl.children); if (r) return r; }
  // 4. "Explanation" heading inside the card, then in what follows the card
  let h = findExplanationHeading(qEl);
  if (h) { const r = pack(collectAfterHeading(h)); if (r) return r; }
  for (const sib of trailingRegion(qEl)) {
    if (!isEl(sib)) continue;
    if (EXPL_CLASS_RE.test(sib.attrs.class || "") && nodeHasContent(sib)) { const r = pack(sib.children); if (r) return r; }
    h = EXPL_RE.test(clean(textOf(sib))) && LABEL_TAGS.has(sib.tag) ? sib : findExplanationHeading(sib);
    if (h) { const r = pack(collectAfterHeading(h)); if (r) return r; }
  }
  // 5. a second prose block in the card
  const proses = findAll(qEl, (n) => hasClass(n, "q-prose"));
  if (proses.length > 1) { const r = pack(proses[proses.length - 1].children); if (r) return r; }
  return { html: "", text: "" };
}

function extractStem(qEl, ctx) {
  const body = findFirst(qEl, (n) => hasClass(n, "q-body")) || qEl;
  const notInResult = (n) => !insideClass(n, "q-result", qEl) && !insideClass(n, "option", qEl) && !hasClass(n, "option");
  const el =
    findFirst(body, (n) => hasClass(n, "question") && hasClass(n, "q-prose") && notInResult(n)) ||
    findFirst(body, (n) => hasClass(n, "q-prose") && notInResult(n)) ||
    findFirst(qEl, (n) => /(^|[\s_-])(question-text|q-text|q-stem|question-body)($|[\s_-])/i.test(n.attrs.class || "") && notInResult(n));
  return el ? toBlockHtml(serializeNodes(el.children, ctx)) : "";
}

function markedCorrectOption(opt) {
  const cls = (opt.attrs.class || "").split(/\s+/);
  if (cls.some((c) => /^(correct|is-correct|option-correct|correct-answer|right|right-answer)$/i.test(c))) return true;
  return ["data-correct", "data-is-correct", "data-answer"].some((a) => /^(true|1|correct)$/i.test(opt.attrs[a] || ""));
}

// "Correct option: Option C." / "... Hence ... Option C" / "Answer: (B)"
function guessTrailingOption(solutionText) {
  const t = solutionText.replace(/\s+/g, " ").trim();
  let m, last = null;
  const explicit = /correct\s+(?:option|answer|choice)\s*[:\-]\s*(?:option\s*)?\(?\s*([A-Da-d])\s*\)?(?![\w])/gi;
  while ((m = explicit.exec(t))) last = m[1];
  if (last) return last.toLowerCase();
  m = /(?:option|answer|ans\.?|choice)\s*[:\-]?\s*\(?\s*([A-Da-d])\s*\)?\s*[.)!]*\s*$/i.exec(t);
  if (m) return m[1].toLowerCase();
  m = /(?:answer|ans\.?)\s*(?:is|:)\s*\(?\s*([A-Da-d])\s*\)?(?![\w])/i.exec(t);
  return m ? m[1].toLowerCase() : "";
}

// Last-resort: schema.org Question JSON-LD (pages whose cards are not server-rendered).
function questionsFromJsonLd(root, baseCtx) {
  const found = [];
  const visit = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(visit);
    const t = [].concat(o["@type"] || []).join(" ");
    if (/\bQuestion\b/.test(t)) found.push(o);
    Object.values(o).forEach(visit);
  };
  for (const sc of findAll(root, (n) => n.tag === "script" && /ld\+json/i.test(n.attrs.type || ""))) {
    try { visit(JSON.parse(textOf(sc))); } catch {}
  }
  const frag = (v) => {
    const str = String(v || "").trim();
    if (!str) return "";
    if (!/</.test(str)) return toBlockHtml(esc(str).replace(/\n/g, "<br>"));
    return toBlockHtml(serializeNodes(parseHtml(str).children, { ...baseCtx, usedImages: new Set() }));
  };
  return found.map((q, idx) => {
    const acc = [].concat(q.acceptedAnswer || [])[0];
    const sug = [].concat(q.suggestedAnswer || []);
    const solutionHtml = frag(acc && (acc.text || acc.name));
    const options = {};
    if (sug.length > 1) sug.forEach((a, i) => { options[String.fromCharCode(65 + i)] = frag(a.text || a.name); });
    const accText = clean(acc ? String(acc.text || acc.name || "") : "");
    let answerKey = "";
    sug.forEach((a, i) => { if (clean(String(a.text || a.name || "")) === accText && accText) answerKey = String.fromCharCode(97 + i); });
    if (!answerKey) answerKey = guessAnswerKey(accText) || guessTrailingOption(accText);
    return {
      key: idx, qid: "", index: idx + 1, paper: "", typeLabel: "", marks: "", negMarks: "",
      questionHtml: frag(q.text || q.name), options, solutionHtml, answerKey,
      imageKeys: [], warnings: ["Read from the page's structured data (JSON-LD) - check formulas / images"],
    };
  });
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
  let qEls = findAll(root, (n) => n.attrs && n.attrs["data-question"] !== undefined && hasClass(n, "question-component"));
  if (!qEls.length) qEls = findAll(root, (n) => hasClass(n, "question-component"));
  if (!qEls.length) qEls = findAll(root, (n) => n.attrs && n.attrs["data-qid"] !== undefined);

  let questions = qEls.map((qEl, idx) => {
    const ctx = { ...baseCtx, usedImages: new Set() };
    const warnings = [];

    const idxEl = findFirst(qEl, (n) => hasClass(n, "q-index"));
    const paperEl = findFirst(qEl, (n) => hasClass(n, "q-paper"));
    const typeEl = findFirst(qEl, (n) => hasClass(n, "q-chip-type"));
    const plus = findFirst(qEl, (n) => hasClass(n, "marks-plus"));
    const minus = findFirst(qEl, (n) => hasClass(n, "marks-minus"));

    const questionHtml = extractStem(qEl, ctx);
    if (!questionHtml) warnings.push("No question text found");

    const options = {};
    let markedLetter = "";
    let optEls = findAll(qEl, (n) => hasClass(n, "option") && n.attrs["data-option"] !== undefined);
    if (!optEls.length) optEls = findAll(qEl, (n) => hasClass(n, "option") || n.attrs["data-option"] !== undefined);
    optEls = optEls.filter((o) => !optEls.some((p) => p !== o && findFirst(p, (x) => x === o)));
    for (const opt of optEls) {
      const badge = findFirst(opt, (n) => hasClass(n, "option-badge"));
      const content = findFirst(opt, (n) => hasClass(n, "option-content"));
      const letter = clean(badge ? textOf(badge) : "").charAt(0).toUpperCase() || String.fromCharCode(65 + Object.keys(options).length);
      options[letter] = content ? toBlockHtml(serializeNodes(content.children, ctx)) : "";
      if (!markedLetter && markedCorrectOption(opt)) markedLetter = letter.toLowerCase();
    }

    const sol = extractSolution(qEl, ctx);
    const solutionHtml = sol.html;
    const solText = sol.text;

    const hasOptions = Object.keys(options).length > 0;
    let answerKey;
    if (hasOptions) {
      answerKey = guessAnswerKey(solText) || markedLetter || guessTrailingOption(solText);
    } else {
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

  if (!questions.length) questions = questionsFromJsonLd(root, baseCtx);

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
 * overrides   : { [questionKey]: "a"|"b"|... } manual answer choices (win over detection)
 * returns { json, images:[{name,key,url,altUrl}], warnings }
 */
export function buildOutput(parsed, settings, selectedKeys, overrides = {}) {
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
      answer_key: overrides[q.key] !== undefined && overrides[q.key] !== "" ? String(overrides[q.key]).toLowerCase() : q.answerKey,
      exam_history: q.paper ? [q.paper] : [],
      question_html: swap(q.questionHtml),
      solution_html: swap(q.solutionHtml),
    };
  });

  const warnings = [];
  chosen.forEach((q, i) => q.warnings.forEach((w) => (overrides[q.key] && /correct answer/i.test(w) ? null : warnings.push(`Q${startNum + i} (page #${q.index}): ${w}`))));
  return { json, images: imageList, warnings };
}
