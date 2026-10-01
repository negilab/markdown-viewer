/* ============================================================================
 *  段落（ブロック）をまとめて動かす
 *  - 選んでいる範囲にかかる段落を、上下に1つずつ動かす（キー・ボタン）
 *  - ⋮⋮ でつかんだとき、選んでいる範囲が複数の段落にかかっていれば、まとめてドラッグで運ぶ
 *  動かす単位: 箇条書きの中なら項目ごと、表の中なら表ごと、それ以外は段落ごと
 * ==========================================================================*/
import { Selection, TextSelection } from "@milkdown/kit/prose/state";
import { NodeRange } from "@milkdown/kit/prose/model";

/* この中に並んでいるものなら、並べ替えてよい（表のセルや項目の中の段落は、外側ごと動かす） */
const MOVABLE_IN = new Set(["doc", "blockquote", "bullet_list", "ordered_list"]);

/* 選んでいる範囲にかかる段落の並び（NodeRange）。見つからなければ null */
export function blockRange(state) {
  const { $from, $to } = state.selection;
  let range = $from.blockRange($to);
  while (range && !MOVABLE_IN.has(range.parent.type.name)) {
    const d = range.depth;
    if (d === 0) return null;
    const doc = state.doc;
    range = new NodeRange(doc.resolve(range.$from.before(d)), doc.resolve(range.$to.after(d)), d - 1);
  }
  return range;
}

/* 範囲の段落を1つ上 / 下へ動かす。動かせなかった理由を返す（動かせたら null） */
export function moveBlocks(view, dir) {
  const { state } = view;
  const range = blockRange(state);
  if (!range) return "ここでは動かせません";
  const parent = range.parent, tr = state.tr;
  if (dir < 0) {
    if (range.startIndex === 0) return "これより上へは動かせません";
    const prev = parent.child(range.startIndex - 1);
    tr.delete(range.start - prev.nodeSize, range.start);
    tr.insert(range.end - prev.nodeSize, prev);
  } else {
    if (range.endIndex >= parent.childCount) return "これより下へは動かせません";
    const next = parent.child(range.endIndex);
    tr.delete(range.end, range.end + next.nodeSize);
    tr.insert(range.start, next);
  }
  view.dispatch(tr.scrollIntoView());
  return null;
}

/* ドラッグで運ぶ範囲。置いたとき、編集部品はこの範囲を消してから置き先へ入れる（replace を呼ぶ） */
class BlockRangeSelection extends Selection {
  map(doc, mapping) { return new BlockRangeSelection(doc.resolve(mapping.map(this.from)), doc.resolve(mapping.map(this.to))); }
  eq(other) { return other instanceof BlockRangeSelection && other.from === this.from && other.to === this.to; }
  toJSON() { return { type: "blockrange", from: this.from, to: this.to }; }
}

/* ⋮⋮ を押す直前の選択が、複数の段落にかかっているか。かかっていればその範囲 { from, to } */
export function multiRange(state) {
  const r = blockRange(state);
  return r && r.endIndex - r.startIndex > 1 ? { from: r.start, to: r.end } : null;
}

/* つかんだ段落が範囲の中なら、範囲全体を選んだ見た目にする */
export function showRange(view, m) {
  const { state } = view, at = state.selection.from;
  if (at < m.from || at >= m.to) return false;
  view.dispatch(state.tr.setSelection(TextSelection.between(state.doc.resolve(m.from), state.doc.resolve(m.to))));
  return true;
}

/* ドラッグで運ぶ中身を、範囲全体に差し替える */
export function dragRange(view, m, event) {
  const { doc } = view.state;
  const slice = doc.slice(m.from, m.to);
  if (event.dataTransfer) {
    const { dom, text } = view.serializeForClipboard(slice);
    event.dataTransfer.clearData();
    event.dataTransfer.setData("text/html", dom.innerHTML);
    event.dataTransfer.setData("text/plain", text);
  }
  view.dragging = { slice, move: true, node: new BlockRangeSelection(doc.resolve(m.from), doc.resolve(m.to)) };
}
