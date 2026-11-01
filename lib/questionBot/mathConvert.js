// lib/questionBot/mathConvert.js  (new file)
//
// ExamSIDE pre-renders every formula with MathJax into SVG (glyph <use> references +
// positioned <g> groups). The LaTeX / MathML source is NOT in the page, so we rebuild
// MathML from the glyph ids (MJX-TEX-<variant>-<hex codepoint>) and the group layout:
//   * fraction  = group holding a <rect> bar + numerator (y>0) + denominator (y<0)
//   * sub / sup = sibling group scaled by 0.707 (y<0 = subscript, y>0 = superscript)
//   * sqrt      = group holding a radical glyph + <rect> overbar + radicand group
//   * \text{}   = <text>
// Anything we do not recognise (stretchy brackets, matrices, n-th roots, ...) makes the
// converter throw and the formula is emitted instead as a standalone inline <svg>
// (glyph paths inlined) so it still renders exactly like on the source page.

import { isEl, elChildren, findAll, textOf, hasClass } from "./miniDom.js";

const ALLOWED_VARIANTS = new Set(["N", "I", "B", "BI", "V"]);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

class Unsupported extends Error {}

export function collectGlyphDefs(root) {
  const defs = {};
  for (const p of findAll(root, (n) => n.tag === "path" && n.attrs.id && n.attrs.id.startsWith("MJX-"))) {
    defs[p.attrs.id] = p.attrs.d || "";
  }
  return defs;
}

function glyphInfo(id) {
  const m = /^MJX-TEX-([A-Za-z0-9]+)-([0-9A-Fa-f]+)$/.exec(id || "");
  if (!m) throw new Unsupported("glyph id " + id);
  return { variant: m[1], cp: parseInt(m[2], 16) };
}

function parseTransform(t) {
  const out = { x: 0, y: 0, s: 1 };
  if (!t) return out;
  let m = /translate\(\s*([-\d.eE]+)[\s,]+([-\d.eE]+)\s*\)/.exec(t);
  if (m) { out.x = parseFloat(m[1]); out.y = parseFloat(m[2]); }
  m = /scale\(\s*([-\d.eE]+)/.exec(t);
  if (m) out.s = parseFloat(m[1]);
  return out;
}

function glyphToken(useEl) {
  const href = useEl.attrs.href || useEl.attrs["xlink:href"] || "";
  const { variant, cp } = glyphInfo(href.replace(/^#/, ""));
  if (!ALLOWED_VARIANTS.has(variant)) throw new Unsupported("variant " + variant);
  const ch = String.fromCodePoint(cp).normalize("NFKC");
  if (/^[0-9.]$/.test(ch) && (variant === "N" || variant === "V")) return { k: "n", ch };
  if (/^\p{L}$/u.test(ch)) {
    let mv = "";
    if (variant === "N") mv = ' mathvariant="normal"';
    else if (variant === "B") mv = ' mathvariant="bold"';
    else if (variant === "BI") mv = ' mathvariant="bold-italic"';
    return { k: "i", ch, mv };
  }
  return { k: "o", ch };
}

const render = {
  n: (t) => `<mn>${esc(t.ch)}</mn>`,
  i: (t) => `<mi${t.mv || ""}>${esc(t.ch)}</mi>`,
  o: (t) => `<mo>${esc(t.ch)}</mo>`,
};

const row = (parts) => (parts.length === 1 ? parts[0] : `<mrow>${parts.join("")}</mrow>`);

// Converts the children of one <g> into a flat list of MathML strings.
function convGroup(g) {
  const items = []; // { kind:'tok'|'mml', tok?, mml?, sub?, sup? }
  for (const ch of elChildren(g)) {
    if (ch.tag === "use") {
      items.push({ kind: "tok", tok: glyphToken(ch) });
    } else if (ch.tag === "g") {
      const kids = elChildren(ch);
      const rect = kids.find((k) => k.tag === "rect");
      const tr = parseTransform(ch.attrs.transform);

      if (rect) {
        items.push({ kind: "mml", mml: convBarGroup(ch, kids) });
      } else if (tr.s < 0.99 && items.length) {
        // script attached to the previous item
        const prev = items[items.length - 1];
        const content = row(convGroup(ch));
        if (tr.y < 0) {
          if (prev.sub) throw new Unsupported("double sub");
          prev.sub = content;
        } else if (tr.y > 0) {
          if (prev.sup) throw new Unsupported("double sup");
          prev.sup = content;
        } else throw new Unsupported("flat script");
      } else if (tr.s < 0.99) {
        throw new Unsupported("script without base");
      } else {
        const inner = convGroup(ch);
        if (inner.length) items.push({ kind: "mml", mml: row(inner), plainRow: inner });
      }
    } else if (ch.tag === "text") {
      const t = textOf(ch).replace(/^ | $/g, "\u00a0");
      if (t.length) items.push({ kind: "mml", mml: `<mtext>${esc(t)}</mtext>` });
    } else if (ch.tag === "rect" || ch.tag === "path") {
      throw new Unsupported(ch.tag);
    } else {
      throw new Unsupported("tag " + ch.tag);
    }
  }

  // merge neighbouring digit tokens (and "." between digits) into one <mn>, but never across a script
  const out = [];
  let numBuf = null;
  const flushNum = () => { if (numBuf) { out.push(`<mn>${esc(numBuf)}</mn>`); numBuf = null; } };
  for (const it of items) {
    const scripted = it.sub || it.sup;
    let base;
    if (it.kind === "tok") {
      if (it.tok.k === "n" && !scripted) { numBuf = (numBuf || "") + it.tok.ch; continue; }
      base = render[it.tok.k](it.tok);
    } else base = it.mml;
    flushNum();
    if (it.sub && it.sup) out.push(`<msubsup>${base}${it.sub}${it.sup}</msubsup>`);
    else if (it.sub) out.push(`<msub>${base}${it.sub}</msub>`);
    else if (it.sup) out.push(`<msup>${base}${it.sup}</msup>`);
    else out.push(base);
  }
  flushNum();
  return out;
}

function convBarGroup(g, kids) {
  const radical = kids.find((k) => {
    if (k.tag !== "use") return false;
    try { return glyphInfo((k.attrs.href || "").replace(/^#/, "")).cp === 0x221a; } catch { return false; }
  });
  const subs = kids.filter((k) => k.tag === "g");
  if (radical) {
    if (subs.length !== 1) throw new Unsupported("n-th root / odd sqrt");
    return `<msqrt>${row(convGroup(subs[0]))}</msqrt>`;
  }
  if (subs.length !== 2) throw new Unsupported("bar group");
  const [a, b] = subs;
  const ya = parseTransform(a.attrs.transform).y;
  const yb = parseTransform(b.attrs.transform).y;
  const num = ya >= yb ? a : b;
  const den = ya >= yb ? b : a;
  // numerator / denominator groups carry the translate(+scale) themselves; convert their CONTENT
  return `<mfrac>${row(convGroup(num))}${row(convGroup(den))}</mfrac>`;
}

function isDisplayOnly(container) {
  const p = container.parent;
  if (!p || p.tag !== "p") return false;
  return p.children.every((c) => c === container || (c.type === "text" && !c.text.trim()));
}

function inlineSvg(svg, defs) {
  const ser = (n) => {
    if (n.type === "text") return esc(n.text);
    if (n.tag === "use") {
      const id = (n.attrs.href || n.attrs["xlink:href"] || "").replace(/^#/, "");
      if (defs[id] !== undefined) {
        const tf = n.attrs.transform ? ` transform="${n.attrs.transform}"` : "";
        return `<path d="${defs[id]}"${tf}/>`;
      }
      return "";
    }
    let attrs = "";
    for (const [k, v] of Object.entries(n.attrs)) {
      if (k.startsWith("data-") || k === "role" || k === "class") continue;
      const name = k === "viewbox" ? "viewBox" : k; // our HTML parser lowercases attribute names
      attrs += ` ${name}="${String(v).replace(/"/g, "&quot;")}"`;
    }
    const inner = (n.children || []).map(ser).join("");
    return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
  };
  return ser(svg).replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
}

/**
 * mjxEl: an <mjx-container> element.  mode: "mathml" (SVG fallback) | "svg"
 * returns { html, kind: "mathml" | "svg" | "empty" }
 */
export function convertMjx(mjxEl, defs, mode = "mathml") {
  const svg = elChildren(mjxEl).find((c) => c.tag === "svg");
  if (!svg) return { html: "", kind: "empty" };

  if (mode !== "svg") {
    try {
      const rootG = elChildren(svg).find((c) => c.tag === "g");
      const parts = convGroup({ children: [rootG] });
      let mml = `<math xmlns="http://www.w3.org/1998/Math/MathML">${parts.join("")}</math>`;
      if (isDisplayOnly(mjxEl)) {
        mml = `<div style="display:block;text-align:left;margin:2px 0">${mml}</div>`;
      }
      return { html: mml, kind: "mathml" };
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      // fall through to SVG
    }
  }
  return { html: inlineSvg(svg, defs), kind: "svg" };
}

export const isMjx = (n) => isEl(n) && n.tag === "mjx-container";
export { hasClass };
