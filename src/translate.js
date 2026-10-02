/* ============================================================================
 *  英語の段落の下に、和訳を表示する（Google の翻訳サービス Cloud Translation API v2）
 *  - 訳は表示だけ（ProseMirror の装飾）。ファイルの中身は英語のまま
 *  - コード枠は訳さない。段落の中のインラインのコードは translate="no" で包んで、そのまま残す
 *  - 一度訳した文は、この端末に覚えておく（同じ文をもう一度訳さない）
 * ==========================================================================*/
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

const key = new PluginKey("translate");

export const trPlugin = $prose(() => new Plugin({
  key,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const next = tr.getMeta(key);
      return next !== undefined ? next : set.map(tr.mapping, tr.doc);
    },
  },
  props: { decorations: state => key.getState(state) },
}));

export const setTr = (view, set) => view.dispatch(view.state.tr.setMeta(key, set).setMeta("addToHistory", false));

const escH = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* 英語の文か（ローマ字が3文字以上あり、ひらがな・カタカナ・漢字がほとんどない） */
function isEnglish(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(/[぀-ヿ㐀-鿿ｦ-ﾟ]/g) || []).length;
  return latin >= 3 && cjk <= (latin + cjk) * 0.15;
}

/* 訳す段落の並び。html は翻訳サービスに送る形（インラインのコードは translate="no" で包む） */
export function trBlocks(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === "code_block") return false;
    let html = "", plain = "";
    node.forEach(ch => {
      if (ch.isText) {
        const code = ch.marks.some(m => m.type.name === "inlineCode");
        html += code ? '<span translate="no">' + escH(ch.text) + "</span>" : escH(ch.text);
        if (!code) plain += ch.text;
      } else if (ch.type.name === "hardbreak") html += "<br>";
    });
    if (plain.trim() && isEnglish(plain)) out.push({ pos, end: pos + node.nodeSize, html, inCell: /table_(cell|header)/.test(doc.resolve(pos).parent.type.name) });
    return false;
  });
  return out;
}

/* ---- 訳の覚え書き（この端末だけ、新しい3000件まで） */
const CACHE_KEY = "mdb.trcache", CACHE_MAX = 3000;
let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = new Map(JSON.parse(localStorage.getItem(CACHE_KEY) || "[]")); } catch (e) { cache = new Map(); }
  return cache;
}
function saveCache() {
  try {
    const all = [...cache];
    localStorage.setItem(CACHE_KEY, JSON.stringify(all.slice(Math.max(0, all.length - CACHE_MAX))));
  } catch (e) { /* 覚えられなくても、訳はその場で出せる */ }
}
export const cached = html => loadCache().get(html);

/* まだ訳していない文を、まとめて訳す（1回に100件・2万5千文字まで） */
export async function translateMissing(htmls, apiKey) {
  const c = loadCache();
  const todo = [...new Set(htmls.filter(h => !c.has(h)))];
  for (let i = 0; i < todo.length;) {
    const batch = [];
    let size = 0;
    while (i < todo.length && batch.length < 100 && (size + todo[i].length <= 25000 || !batch.length)) { size += todo[i].length; batch.push(todo[i++]); }
    const r = await fetch("https://translation.googleapis.com/language/translate/v2?key=" + encodeURIComponent(apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: batch, source: "en", target: "ja", format: "html" }),
    });
    if (!r.ok) {
      let reason = "";
      try { reason = ((await r.json()).error || {}).message || ""; } catch (e) {}
      throw Object.assign(new Error("translate " + r.status), { status: r.status, reason });
    }
    const out = ((await r.json()).data || {}).translations || [];
    batch.forEach((h, k) => { if (out[k]) c.set(h, out[k].translatedText); });
  }
  if (todo.length) saveCache();
}

/* 翻訳サービスから返った HTML を、文字と「訳さなかったコード」だけの要素にする */
function trNode(html, inCell) {
  const box = document.createElement("div");
  box.className = "tr-ja" + (inCell ? " in-cell" : "");
  box.contentEditable = "false";
  box.setAttribute("lang", "ja");
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const walk = (from, to) => {
    for (const n of from.childNodes) {
      if (n.nodeType === 3) to.append(n.textContent);
      else if (n.nodeType === 1 && n.tagName === "BR") to.append(document.createElement("br"));
      else if (n.nodeType === 1 && n.getAttribute("translate") === "no") { const c = document.createElement("code"); c.textContent = n.textContent; to.append(c); }
      else if (n.nodeType === 1) walk(n, to);
    }
  };
  walk(tpl.content, box);
  return box;
}

/* 訳のある段落の下に、訳を出す装飾 */
export function trDecorations(doc) {
  const decos = [];
  for (const b of trBlocks(doc)) {
    const ja = cached(b.html);
    if (!ja) continue;
    decos.push(Decoration.widget(b.end, () => trNode(ja, b.inCell), { side: -1, ignoreSelection: true, key: "tr:" + b.html.slice(0, 80) + ":" + ja.length }));
  }
  return DecorationSet.create(doc, decos);
}
