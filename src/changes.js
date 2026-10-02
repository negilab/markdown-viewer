/* ============================================================================
 *  前に見た中身から変わった所に、色を付けて表示する
 *  - 比べる相手（もと）は、この端末で前に開いた・保存した中身。初めてのファイルは、ドライブの1つ前の版
 *  - 色は表示だけ（ProseMirror の装飾）。ファイルの中身には何も足さない
 *  - 段落ごとに並びを比べ、変わった段落の中は文字ごとに比べる。消えた段落の場所には「削除あり」の印を出す
 * ==========================================================================*/
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

const key = new PluginKey("changes");

/* 装飾を持っておくだけの部品。編集したら位置を追いかける */
export const changesPlugin = $prose(() => new Plugin({
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

/* ---- 段落（文字の入るまとまり）を順に並べる。画像や区切り線もひとつのまとまりとして数える */
function blocks(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      let text = "";
      const map = [];
      node.forEach((ch, off) => {
        const p = pos + 1 + off;
        if (ch.isText) { for (let i = 0; i < ch.text.length; i++) map.push(p + i); text += ch.text; }
        else { map.push(p); text += "￼"; }
      });
      if (text.trim()) out.push({ node, pos, text, map, key: node.type.name + ":" + text });
      return false;
    }
    if (node.isBlock && node.isAtom) {
      out.push({ node, pos, atom: true, text: "", key: "@" + node.type.name + ":" + JSON.stringify(node.attrs) });
      return false;
    }
    return true;
  });
  return out;
}

/* 2つの並びで、同じものどうしの組（最長共通部分列）。前後の同じ部分は先に除いて軽くする */
function lcsPairs(a, b, eq) {
  let s = 0;
  while (s < a.length && s < b.length && eq(a[s], b[s])) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && eq(a[ea - 1], b[eb - 1])) { ea--; eb--; }
  const pairs = [];
  for (let i = 0; i < s; i++) pairs.push([i, i]);
  const n = ea - s, m = eb - s;
  if (n && m && n * m <= 4e6) {
    const w = m + 1, dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = eq(a[s + i], b[s + j]) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (eq(a[s + i], b[s + j])) { pairs.push([s + i, s + j]); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }
  for (let i = 0; i < a.length - ea; i++) pairs.push([ea + i, eb + i]);
  return pairs;
}

/* 文字ごとに比べて、新しい側で変わった文字の範囲 [始め, 終わり) の並び。比べきれないときは null */
function charRuns(oldText, newText) {
  if (oldText.length * newText.length > 4e6) return null;
  const same = new Uint8Array(newText.length);
  for (const [, j] of lcsPairs([...oldText], [...newText].map(c => c), (x, y) => x === y)) same[j] = 1;
  /* 文字の位置は UTF-16 で数える（絵文字などは2つぶん） */
  const units = [];
  let u = 0;
  for (const c of newText) { units.push([u, u + c.length]); u += c.length; }
  const runs = [];
  for (let k = 0; k < units.length; k++) {
    if (same[k]) continue;
    const last = runs[runs.length - 1];
    /* 1文字だけ挟んで続く変化は、1つにまとめる（まだらに見えないように） */
    if (last && units[k][0] - last[1] <= 1) last[1] = units[k][1];
    else runs.push([units[k][0], units[k][1]]);
  }
  return runs;
}

/* もとの中身（ProseMirror の文書）から今の文書への変化を、装飾と「変わった所」の数にする */
export function diffDecorations(baseDoc, doc) {
  const A = blocks(baseDoc), B = blocks(doc);
  const pairs = lcsPairs(A, B, (x, y) => x.key === y.key);
  const decos = [];
  let spots = 0;
  const whole = b => {
    if (b.atom) decos.push(Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: "chg-node" }));
    else decos.push(Decoration.inline(b.pos + 1, b.pos + b.node.nodeSize - 1, { class: "chg" }));
  };
  const delMark = (pos, side, removed) => {
    const text = removed.map(r => r.atom ? "（画像など）" : r.text).join(" / ");
    decos.push(Decoration.widget(pos, () => {
      const s = document.createElement("span");
      s.className = "chg-del";
      s.textContent = "削除あり";
      s.title = "ここにあった文が消されています: " + (text.length > 120 ? text.slice(0, 120) + "…" : text);
      s.contentEditable = "false";
      return s;
    }, { side, ignoreSelection: true, key: "del" + pos + text.slice(0, 20) }));
  };
  /* 組の間（変わった所）を順に見る */
  const bounds = pairs.concat([[A.length, B.length]]);
  let pa = 0, pb = 0;
  for (const [ia, ib] of bounds) {
    const olds = A.slice(pa, ia), news = B.slice(pb, ib);
    let changed = false;
    news.forEach((nb, k) => {
      const ob = olds[k];
      if (nb.atom || !ob || ob.atom) { whole(nb); changed = true; return; }
      const runs = charRuns(ob.text, nb.text);
      const count = runs ? runs.reduce((n, r) => n + r[1] - r[0], 0) : nb.text.length;
      if (!runs || count > nb.text.length * 0.6) { whole(nb); changed = true; return; }
      if (!runs.length) {
        /* 文字は同じで、見出し・太字など書式だけ変わった */
        if (!ob.node.eq(nb.node)) { whole(nb); changed = true; }
        return;
      }
      for (const [s, e] of runs) decos.push(Decoration.inline(nb.map[s], nb.map[e - 1] + 1, { class: "chg" }));
      changed = true;
    });
    if (olds.length > news.length) {
      const removed = olds.slice(news.length);
      const before = news[news.length - 1] || B[pb - 1];
      const next = B[ib];
      /* 消えた所の印は、手前の段落の終わりに置く（先頭が消えたときは、次の段落の頭に置く） */
      if (before && !before.atom) delMark(before.pos + before.node.nodeSize - 1, 1, removed);
      else if (next && !next.atom) delMark(next.pos + 1, -1, removed);
      else if (next) delMark(next.pos, -1, removed);
      changed = true;
    }
    if (changed) spots += Math.max(news.length, 1);
    pa = ia + 1; pb = ib + 1;
  }
  return { set: DecorationSet.create(doc, decos), spots };
}

/* 装飾を入れ替える（空にするときは DecorationSet.empty） */
export function setDecorations(view, set) {
  view.dispatch(view.state.tr.setMeta(key, set).setMeta("addToHistory", false));
}

/* いま色が付いている所の位置（段落ごとに1つ、上から順） */
export function spotPositions(state) {
  const set = key.getState(state);
  if (!set) return [];
  const seen = new Set(), out = [];
  for (const d of set.find().sort((a, b) => a.from - b.from)) {
    const pos = Math.min(d.from, state.doc.content.size);
    const $p = state.doc.resolve(pos);
    const start = $p.parent.isTextblock ? $p.start() : pos;
    if (seen.has(start)) continue;
    seen.add(start); out.push(pos);
  }
  return out;
}
