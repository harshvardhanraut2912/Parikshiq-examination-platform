// lib/questionBot/miniDom.js  (new file)
//
// Tiny, dependency-free, tolerant HTML parser. It exists so the SAME parsing code
// runs in the browser ("local" mode) and in a Vercel function ("server" mode) --
// Node has no DOMParser and we do not want to add cheerio/jsdom to package.json.
// It is written for well-formed server-rendered pages (ExamSIDE is SvelteKit SSR),
// not for arbitrary tag soup.

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);
const RAW = new Set(["script", "style"]);
// opening <key> implicitly closes an open <value[i]> directly above it
const IMPLIED_CLOSE = {
  p: ["p"], li: ["li"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"],
  option: ["option"], dt: ["dt", "dd"], dd: ["dt", "dd"],
};

const TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(str) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(str))) {
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
  }
  return attrs;
}

export function parseHtml(src) {
  const root = { type: "el", tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;

  const pushText = (t) => {
    if (t) cur.children.push({ type: "text", text: t, parent: cur });
  };

  while ((m = TOKEN_RE.exec(src))) {
    pushText(src.slice(last, m.index));
    last = TOKEN_RE.lastIndex;
    if (m[2] === undefined) continue; // comment / doctype / cdata -> dropped

    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();

    if (closing) {
      // pop up to the nearest matching open element (ignore stray close tags)
      let n = cur;
      while (n && n !== root && n.tag !== tag) n = n.parent;
      if (n && n !== root) cur = n.parent;
      continue;
    }

    const rawAttrs = m[3] || "";
    const selfClose = /\/\s*$/.test(rawAttrs);

    const closes = IMPLIED_CLOSE[tag];
    if (closes && closes.includes(cur.tag)) cur = cur.parent;

    const el = { type: "el", tag, attrs: parseAttrs(rawAttrs), children: [], parent: cur };
    cur.children.push(el);

    if (VOID.has(tag) || selfClose) continue;

    if (RAW.has(tag)) {
      const end = src.toLowerCase().indexOf("</" + tag, last);
      const stop = end === -1 ? src.length : end;
      if (stop > last) el.children.push({ type: "text", text: src.slice(last, stop), parent: el });
      const gt = end === -1 ? src.length : src.indexOf(">", end);
      last = TOKEN_RE.lastIndex = gt === -1 ? src.length : gt + 1;
      continue;
    }
    cur = el;
  }
  pushText(src.slice(last));
  return root;
}

export const isEl = (n) => n && n.type === "el";
export const elChildren = (n) => (n.children || []).filter(isEl);
export function hasClass(el, cls) {
  const c = el.attrs && el.attrs.class;
  return !!c && (" " + c + " ").includes(" " + cls + " ");
}
export function walk(node, fn) {
  for (const ch of node.children || []) {
    if (fn(ch) === false) continue;
    if (isEl(ch)) walk(ch, fn);
  }
}
export function findAll(node, pred) {
  const out = [];
  walk(node, (n) => { if (isEl(n) && pred(n)) out.push(n); });
  return out;
}
export function findFirst(node, pred) {
  let hit = null;
  walk(node, (n) => {
    if (hit) return false;
    if (isEl(n) && pred(n)) { hit = n; return false; }
  });
  return hit;
}
export function textOf(node) {
  if (node.type === "text") return node.text;
  return (node.children || []).map(textOf).join("");
}
