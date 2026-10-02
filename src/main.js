/* ============================================================================
 *  Markdown Viewer — Markdown を読みやすく表示し、記号を見ずにそのまま書き直せる
 *  編集部品は Milkdown Crepe（ProseMirror）。build.mjs で index.html 1つにまとめる。
 * ==========================================================================*/
/* Crepe 本体は数式・コード色分けまで読み込んで重いので、使う機能だけを組み立てる */
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { imageBlock } from "@milkdown/crepe/feature/image-block";
import { table } from "@milkdown/crepe/feature/table";
import { topBar } from "@milkdown/crepe/feature/top-bar";
import { callCommand } from "@milkdown/kit/utils";
import { remarkStringifyOptionsCtx, editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { blockServiceInstance } from "@milkdown/kit/plugin/block";
import { undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import * as drive from "./drive.js";
import { ACTIONS, headingLevel, setHeading, indent, inCode } from "./panel.js";
import { moveBlocks, multiRange, showRange, dragRange } from "./move.js";
import { changesPlugin, diffDecorations, setDecorations, spotPositions } from "./changes.js";
import { trPlugin, trBlocks, trDecorations, translateMissing, setTr } from "./translate.js";
import { DecorationSet } from "@milkdown/kit/prose/view";
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/image-block.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/common/top-bar.css";
import "@milkdown/crepe/theme/classic.css";

/* キャッシュで古い画面が出ていないか確かめる用。設定メニューの下に「最終更新」として出す */
const VERSION = "2026-10-03 12:00";
const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem("mdb." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("mdb." + k, JSON.stringify(v)); } catch (e) {} },
};
const touch = matchMedia("(pointer:coarse)").matches;

const els = {
  root: $("#editor"), name: $("#docName"), save: $("#btnSave"), undo: $("#btnUndo"), redo: $("#btnRedo"),
  toast: $("#toast"), picker: $("#picker"), drop: $("#dropzone"), view: $("#btnView"),
};
let readonly = false;
document.querySelectorAll(".app-ver").forEach(e => e.textContent = VERSION);

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => els.toast.classList.remove("on"), 1900);
}

/* ------------------------------------------------------------ 文書 */
/* 編集部品はフロントマター（先頭の --- で囲んだ情報欄）を扱えないので、外しておいて保存時に戻す */
const FM = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
/* 開いているファイル。1件ごとに中身・保存済みの中身・読んでいた位置・色付けの状態を持つ。
   doc は、いま画面に出しているファイル（files の中の1件） */
let uidSeq = Date.now();
const blank = o => Object.assign({ uid: "f" + (uidSeq++), name: "", fm: "", eol: "\n", handle: null, drive: null, folder: "",
  saved: "", md: "", scroll: 0, chgBase: null, chgFrom: "", chgCount: 0, welcome: false }, o);
const files = [];
let doc = blank();
let crepe = null;

const fullText = () => {
  const body = doc.md.replace(/\n/g, doc.eol);
  return doc.fm ? doc.fm + (doc.fm.endsWith("\n") ? "" : doc.eol) + body : body;
};
const dirtyOf = f => f.md !== f.saved;
const isDirty = () => dirtyOf(doc);

const IC = n => '<svg class="ic"><use href="#i-' + n + '"/></svg>';
function renderTitle() {
  const nm = doc.name || "無題.md";
  els.name.innerHTML =
    (doc.drive ? '<span class="gd" title="Googleドライブのファイル（保存するとドライブに上書き）">' + DRIVE_ICON + "</span>" : "") +
    (doc.folder ? '<span class="fold">' + esc(doc.folder) + '</span><span class="slash">/</span>' : "") +
    '<span class="nm">' + esc(nm) + "</span>" +
    (isDirty() ? '<span class="dot" title="保存していない変更があります"></span>' : "") +
    '<svg class="car"><use href="#i-car"/></svg>';
  els.name.title = (doc.folder ? doc.folder + " / " : "") + nm + "（押すと、開いているファイルを切り替えられます）";
  els.save.classList.toggle("dirty", isDirty());
  document.title = nm + " — Markdown Viewer";
  renderFiles();
}

/* 開いているファイルの一覧（左のパネルと、ファイル名を押したときのメニュー） */
function fileRow(f, inMenu) {
  const b = document.createElement("div");
  b.className = "frow" + (f === doc ? " on" : "");
  b.setAttribute("role", "button"); b.tabIndex = 0;
  b.title = (f.folder ? f.folder + " / " : "") + (f.name || "無題.md");
  const cnt = f === doc ? spots().length : f.chgCount;
  b.innerHTML = (f.drive ? '<span class="gd">' + DRIVE_ICON + "</span>" : IC("doc")) +
    '<span class="nm">' + esc(f.name || "無題.md") + "</span>" +
    (cnt ? '<span class="cnt" title="変わった所の数">' + cnt + "</span>" : "") +
    (dirtyOf(f) ? '<span class="dot" title="保存していない変更があります"></span>' : "") +
    '<button class="x" aria-label="閉じる" title="閉じる">' + IC("x") + "</button>";
  b.addEventListener("click", e => {
    if (e.target.closest(".x")) { e.stopPropagation(); closeFile(f); return; }
    if (inMenu) $("#filesMenu").hidden = true;
    if (f !== doc) show(f);
  });
  b.addEventListener("keydown", e => { if (e.key === "Enter") b.click(); });
  return b;
}
function renderFiles() {
  const list = $("#fileList"), menuEl = $("#filesMenu");
  list.innerHTML = "";
  files.forEach(f => list.append(fileRow(f, false)));
  if (!menuEl.hidden) fillFilesMenu();
}
function fillFilesMenu() {
  const menuEl = $("#filesMenu");
  menuEl.innerHTML = "";
  files.forEach(f => menuEl.append(fileRow(f, true)));
  const add = document.createElement("button");
  add.className = "frow add"; add.innerHTML = IC("plus") + '<span class="nm">ファイルを開く</span>';
  add.addEventListener("click", e => { e.stopPropagation(); menuEl.hidden = true; startOpen(); });
  menuEl.append(add);
}
els.name.addEventListener("click", e => {
  e.stopPropagation();
  const menuEl = $("#filesMenu");
  menuEl.hidden = !menuEl.hidden;
  if (!menuEl.hidden) fillFilesMenu();
});
document.addEventListener("click", e => { const m = $("#filesMenu"); if (!m.hidden && !m.contains(e.target)) m.hidden = true; });

/* 同じファイルがもう開いているか（ドライブは ID、この端末のファイルは同じファイルの手がかりか名前） */
async function findOpen(name, opts) {
  for (const f of files) {
    if (opts.drive && f.drive && f.drive.id === opts.drive.id) return f;
    if (!opts.drive && !f.drive && f.name === name) {
      if (opts.handle && f.handle && f.handle.isSameEntry) { try { if (await f.handle.isSameEntry(opts.handle)) return f; } catch (e) {} continue; }
      if (!opts.handle && !f.handle) return f;
    }
  }
  return null;
}
/* ファイルを開く。開いていなければ一覧に足し、開いていれば中身を新しくする（保存していない変更があるときは、そのまま見せる） */
async function openText(name, text, opts = {}) {
  const m = FM.exec(text);
  const body = (m ? text.slice(m[0].length) : text).replace(/\r\n?/g, "\n");
  let f = await findOpen(name, opts);
  if (f && dirtyOf(f)) {
    await show(f);
    toast("保存していない変更があるため、編集中の中身を表示しています");
    return f;
  }
  if (!f) {
    f = blank({ name });
    /* まだ何も書いていない「ようこそ」は、ファイルを開いたら閉じる */
    const w = files.findIndex(x => x.welcome && !dirtyOf(x));
    if (w >= 0) files.splice(w, 1);
    const at = files.indexOf(doc);
    files.splice(at >= 0 ? at + 1 : files.length, 0, f);
  }
  Object.assign(f, { name, eol: /\r\n/.test(text) ? "\r\n" : "\n", fm: m ? m[0] : "", md: body, saved: null, scroll: 0,
    chgBase: null, chgCount: 0, welcome: !!opts.welcome });
  if (opts.handle !== undefined) f.handle = opts.handle || null;
  if (opts.drive !== undefined) f.drive = opts.drive || null;
  if (opts.folder !== undefined) f.folder = opts.folder || "";
  await show(f, { fresh: true });
  return f;
}

/* 画面に出すファイルを切り替える。fresh: 開いたばかり（部品が書き直した形を「保存済み」にする） */
async function show(f, o = {}) {
  if (doc !== f && files.includes(doc)) { doc.scroll = window.scrollY; doc.chgCount = spots().length; }
  doc = f; chg.idx = -1;
  const wasClean = f.md === f.saved;
  await makeEditor(f.md);
  /* 部品が書き直した形を「保存済み」の基準にする（開いただけで ● が付かないように） */
  if (o.fresh || f.saved == null || wasClean) f.saved = f.md;
  renderTitle(); updateUndo();
  applyChanges(); applyTr();
  window.scrollTo(0, f.scroll || 0);
  if (!touch && o.fresh) els.root.querySelector(".ProseMirror")?.focus();
  persist();
  if (!o.fresh) refreshIfChanged(f);
}

/* 閉じる。保存していない変更があれば確かめる */
async function closeFile(f) {
  if (dirtyOf(f) && !confirm((f.name || "無題.md") + " には保存していない変更があります。変更を捨てて閉じますか？")) return;
  const i = files.indexOf(f);
  if (i < 0) return;
  files.splice(i, 1);
  if (f === doc) {
    const next = files[Math.min(i, files.length - 1)];
    if (next) await show(next);
    else await openText("ようこそ.md", WELCOME, { welcome: true });
  } else { renderFiles(); persist(); }
}

/* 編集部品を作り直す（ファイルを開いたとき・閲覧から編集に戻ったとき） */
async function makeEditor(md) {
  if (crepe) await crepe.destroy();
  els.root.innerHTML = "";
  crepe = new CrepeBuilder({ root: els.root, defaultValue: md });
  crepe.addFeature(cursor).addFeature(listItem).addFeature(linkTooltip, JA.linkTooltip).addFeature(table)
       .addFeature(imageBlock, JA.imageBlock).addFeature(placeholder, JA.placeholder)
       .addFeature(blockEdit, JA.blockEdit).addFeature(toolbar, JA.toolbar);
  /* スマホは選択して出るバーが使いにくいので、書式のバーを上に常に出す */
  if (touch) crepe.addFeature(topBar, JA.topBar);
  /* 保存するときの書き方を、よく使われる形にそろえる（箇条書きは「- 」、区切り線は「---」） */
  crepe.editor.config(ctx => ctx.update(remarkStringifyOptionsCtx, o => ({ ...o, bullet: "-", rule: "-" })));
  /* 前に見た中身から変わった所に色を付ける部品 */
  crepe.editor.use(changesPlugin);
  /* 英語の段落の下に和訳を出す部品 */
  crepe.editor.use(trPlugin);
  crepe.on(api => {
    api.markdownUpdated((ctx, md) => {
      doc.md = md;
      renderTitle(); updateUndo(); schedulePanel(); showChgBar(); trSoon();
      persist();
    });
    api.selectionUpdated(() => { followCaret(); schedulePanel(); });
  });
  await crepe.create();
  crepe.setReadonly(readonly);
  doc.md = crepe.getMarkdown();
  schedulePanel();
}

/* ------------------------------------------------------------ Tab キー */
/* 部品の標準では、下げられないときに Tab が本文へ空白を入れてしまい、ファイルにゴミが残る。
   なので本文より先に受け取って、箇条書きの中なら字下げ / 戻す、それ以外は何もしない（コード枠は除く） */
els.root.addEventListener("keydown", e => {
  if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey || !crepe || readonly || e.isComposing) return;
  let handled = false;
  crepe.editor.action(ctx => {
    if (inCode(ctx)) return;
    handled = true;
    const why = indent(ctx, e.shiftKey);
    if (why) toast(why);
  });
  if (handled) { e.preventDefault(); e.stopPropagation(); schedulePanel(); }
}, true);

/* ------------------------------------------------------------ iPhone の変換確定の改行 */
/* iPhone の日本語入力は、変換の確定に改行キーを使う。編集部品はこの改行を無視するが、Safari が同じ改行を
   「段落の追加」としても実行してしまい、確定のたびに下へ空の段落が増えていた。
   変換中と、確定した直後（0.5秒以内）の1回目だけ、この段落の追加を止める。2回目以降の改行はふだんどおり効く */
let composing = false, composeEnd = 0;
els.root.addEventListener("compositionstart", () => { composing = true; }, true);
els.root.addEventListener("compositionend", () => { composing = false; composeEnd = Date.now(); }, true);
els.root.addEventListener("beforeinput", e => {
  if (e.inputType !== "insertParagraph" && e.inputType !== "insertLineBreak") return;
  if (composing || e.isComposing || Date.now() - composeEnd < 500) { composeEnd = 0; e.preventDefault(); }
}, true);

/* ------------------------------------------------------------ 段落をまとめて動かす */
/* 上へ / 下へ（キー・ボタン共通）。選んでいる範囲にかかる段落を1つずつ動かす */
function move(dir) {
  if (!crepe || readonly) return;
  crepe.editor.action(ctx => {
    const v = ctx.get(editorViewCtx);
    const why = moveBlocks(v, dir);
    if (why) toast(why);
    if (!v.hasFocus()) v.focus();
  });
  schedulePanel();
}
/* Ctrl（Mac は ⌘）+ Shift + ↑ / ↓ */
els.root.addEventListener("keydown", e => {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault(); e.stopPropagation();
  move(e.key === "ArrowUp" ? -1 : 1);
}, true);

/* ⋮⋮ でつかんだとき: 直前の選択が複数の段落にかかっていて、つかんだ段落がその中なら、まとめて運ぶ。
   部品は ⋮⋮ を押した瞬間に1段落だけを選び直すので、その前（capture）に選択を控えておく */
let multi = null;
document.addEventListener("mousedown", e => {
  multi = null;
  if (!crepe || readonly || !e.target.closest || !e.target.closest(".milkdown-block-handle")) return;
  crepe.editor.action(ctx => { multi = multiRange(ctx.get(editorViewCtx).state); });
}, true);
document.addEventListener("mousedown", () => {
  if (!multi) return;
  crepe.editor.action(ctx => { if (!showRange(ctx.get(editorViewCtx), multi)) multi = null; });
});
document.addEventListener("dragstart", e => {
  if (!multi || !crepe || !e.target.closest || !e.target.closest(".milkdown-block-handle")) return;
  crepe.editor.action(ctx => dragRange(ctx.get(editorViewCtx), multi, e));
});
document.addEventListener("dragend", () => { multi = null; });

/* ------------------------------------------------------------ PC の編集パネル */
/* 幅の広い PC だけ。開け閉めは端末ごとに覚える */
const wide = matchMedia("(min-width:900px)");
let panelOn = store.get("panel", true);
function applyPanel() {
  const can = !touch && wide.matches;
  document.body.classList.toggle("can-panel", can);
  document.body.classList.toggle("has-panel", can && panelOn);
  $("#btnPanel").setAttribute("aria-pressed", String(can && panelOn));
  schedulePanel();
}
wide.addEventListener("change", applyPanel);
$("#btnPanel").addEventListener("click", () => { panelOn = !panelOn; store.set("panel", panelOn); applyPanel(); });

/* ボタンを押しても本文のカーソルと選択が外れないように、押した瞬間の既定動作を止める */
function panelAction(fn) {
  if (!crepe || readonly) return;
  try {
    crepe.editor.action(ctx => {
      fn(ctx);
      /* 本文にカーソルがあるときは触らない（focus し直すと、直後の矢印キーが一瞬効かなくなる） */
      const v = ctx.get(editorViewCtx); if (!v.hasFocus()) v.focus();
    });
  } catch (e) { toast("この位置では使えません。本文の中にカーソルを置いてから押してください"); }
  schedulePanel();
}
document.querySelectorAll("#panel [data-a]").forEach(b => {
  b.addEventListener("mousedown", e => e.preventDefault());
  b.addEventListener("click", () => {
    const a = b.dataset.a;
    if (a === "undo") return run(undoCommand);
    if (a === "redo") return run(redoCommand);
    if (a === "indent" || a === "outdent") return panelAction(ctx => { const why = indent(ctx, a === "outdent"); if (why) toast(why); });
    if (a === "up" || a === "down") return move(a === "up" ? -1 : 1);
    panelAction(ACTIONS[a].run);
  });
});
document.querySelectorAll("#segHeading [data-h]").forEach(b => {
  b.addEventListener("mousedown", e => e.preventDefault());
  b.addEventListener("click", () => panelAction(ctx => setHeading(ctx, +b.dataset.h)));
});

/* いまのカーソル位置で効いている書式を光らせる。目次と文字数も更新する */
function schedulePanel() {
  cancelAnimationFrame(schedulePanel.f);
  schedulePanel.f = requestAnimationFrame(updatePanel);
}
function updatePanel() {
  if (!crepe || !document.body.classList.contains("has-panel")) return;
  try {
    crepe.editor.action(ctx => {
      document.querySelectorAll("#panel [data-a]").forEach(b => {
        const act = ACTIONS[b.dataset.a];
        b.classList.toggle("on", !!(act && act.active && act.active(ctx)));
      });
      const lv = headingLevel(ctx);
      document.querySelectorAll("#segHeading [data-h]").forEach(b => b.classList.toggle("on", +b.dataset.h === lv));
    });
  } catch (e) { /* 作り直しの途中 */ }
  clearTimeout(updatePanel.t);
  updatePanel.t = setTimeout(updateToc, 300);
}
/* 読んでいる見出しを、目次で光らせる */
function markTocCur() {
  const links = [...document.querySelectorAll("#toc a")];
  let cur = null;
  for (const a of links) { if (a._h && a._h.getBoundingClientRect().top < 140) cur = a; }
  if (!cur) cur = links[0];
  links.forEach(a => a.classList.toggle("cur", a === cur));
}
window.addEventListener("scroll", () => { cancelAnimationFrame(markTocCur.f); markTocCur.f = requestAnimationFrame(markTocCur); }, { passive: true });
function updateToc() {
  const toc = $("#toc");
  const hs = [...els.root.querySelectorAll(".ProseMirror > h1, .ProseMirror > h2, .ProseMirror > h3")].filter(h => h.textContent.trim());
  toc.innerHTML = hs.length ? "" : '<div class="none">見出しを作ると、ここに並びます</div>';
  hs.forEach(h => {
    const a = document.createElement("a");
    a.className = "l" + h.tagName[1];
    a.textContent = h.textContent;
    a.title = h.textContent;
    a._h = h;
    a.addEventListener("click", () => window.scrollTo({ top: h.getBoundingClientRect().top + window.scrollY - 64, behavior: "smooth" }));
    toc.append(a);
  });
  markTocCur();
  $("#stat").textContent = doc.md.replace(/\s/g, "").length.toLocaleString() + " 文字";
}

/* ------------------------------------------------------------ 日本語の表示 */
const JA = {
  placeholder: { text: "文字を入力。「/」で見出しや表を挿入", mode: "block" },
  blockEdit: {
    textGroup: {
      label: "文章", text: { label: "本文" }, h1: { label: "見出し 大" }, h2: { label: "見出し 中" },
      h3: { label: "見出し 小" }, h4: { label: "見出し 4" }, h5: { label: "見出し 5" }, h6: { label: "見出し 6" },
      quote: { label: "引用" }, divider: { label: "区切り線" },
    },
    listGroup: { label: "リスト", bulletList: { label: "箇条書き" }, orderedList: { label: "番号付き" }, taskList: { label: "チェック" } },
    advancedGroup: { label: "そのほか", image: { label: "画像" }, codeBlock: { label: "コード枠" }, table: { label: "表" }, math: null },
  },
  toolbar: { boldLabel: "太字", italicLabel: "斜体", strikethroughLabel: "取り消し線", codeLabel: "コード", linkLabel: "リンク" },
  linkTooltip: { inputPlaceholder: "リンク先のURLを貼り付け" },
  topBar: {
    /* iPhone にはTabキーがないので、書式のバーに字下げ・字下げの解除を足す */
    buildTopBar: builder => { builder.addGroup("indent", "字下げ")
      .addItem("sink", { icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M11 12h10M11 18h10"/><path d="m3 10 4 3-4 3"/></svg>', active: () => false, onRun: ctx => { const why = indent(ctx, false); if (why) toast(why); } })
      .addItem("lift", { icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M11 12h10M11 18h10"/><path d="m7 10-4 3 4 3"/></svg>', active: () => false, onRun: ctx => { const why = indent(ctx, true); if (why) toast(why); } });
      /* 選んでいる段落を上へ / 下へ（iPhone ではドラッグしにくいので、ボタンで動かす）。まとまりは builder から足す */
      builder.addGroup("move", "移動")
      .addItem("move-up", { icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>', active: () => false, onRun: ctx => { const why = moveBlocks(ctx.get(editorViewCtx), -1); if (why) toast(why); } })
      .addItem("move-down", { icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m18 13-6 6-6-6"/></svg>', active: () => false, onRun: ctx => { const why = moveBlocks(ctx.get(editorViewCtx), 1); if (why) toast(why); } }); },
    headingOptions: [
      { label: "本文", level: null }, { label: "見出し 大", level: 1 },
      { label: "見出し 中", level: 2 }, { label: "見出し 小", level: 3 },
    ],
  },
  imageBlock: { inlineUploadPlaceholderText: "または画像のURLを貼り付け", blockUploadPlaceholderText: "または画像のURLを貼り付け",
                                inlineUploadButton: "画像を選ぶ", blockUploadButton: "画像を選ぶ", blockCaptionPlaceholderText: "説明を書く", blockConfirmButton: "挿入" },
};

/* ------------------------------------------------------------ ⋮⋮ を入力位置に出す */
/* 部品は ⋮⋮ をポインタの位置に出す作りで、ポインタのない iPhone ではずれて見えるので、
   入力位置（カーソルのある行）の高さでポインタが動いたことにして出し直す */
function followCaret() {
  clearTimeout(followCaret.t);
  followCaret.t = setTimeout(() => {
    if (!crepe || readonly) return;
    try {
      crepe.editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        if (!view.hasFocus() || view.composing) return;
        const c = view.coordsAtPos(view.state.selection.from);
        ctx.get(blockServiceInstance.key).mousemoveCallback(view, { clientY: (c.top + c.bottom) / 2 });
      });
    } catch (e) { /* 描き直しの途中などは次の機会に */ }
  }, 250);
}

/* ------------------------------------------------------------ キーボードが出ているときの上の帯 */
/* iPhone ではキーボードが出ると、ページはそのままで「見えている範囲」だけが下へずれ、上端に貼りつけた帯が画面の外へ出る。
   見えている範囲のずれを --vv に入れて、帯をその分だけ下げる */
if (window.visualViewport) {
  const vv = window.visualViewport;
  const follow = () => document.documentElement.style.setProperty("--vv", Math.max(0, Math.round(vv.offsetTop)) + "px");
  vv.addEventListener("resize", follow);
  vv.addEventListener("scroll", follow);
  follow();
}

/* ------------------------------------------------------------ 閲覧（書き換えを止める） */
async function setReadonly(on) {
  readonly = on;
  document.body.classList.toggle("readonly", on);
  els.view.setAttribute("aria-pressed", String(on));
  const text = on ? "編集に切り替え" : "閲覧に切り替え";
  els.view.title = on ? text : text + "（書き換えを止める）";
  els.view.setAttribute("aria-label", text);
  const label = els.view.querySelector(".label"); if (label) label.textContent = text;
  if (!crepe) return;
  if (on) {
    crepe.setReadonly(true);
    if (document.activeElement) document.activeElement.blur();   /* キーボードを閉じる */
    return;
  }
  /* 部品の書式バーは、一度閲覧にすると編集に戻しても出てこない（部品側の不具合）。
     なので今の本文で編集部品を作り直す。表示位置は保つ。戻る・やり直すの履歴はここで区切られる */
  const y = window.scrollY;
  await makeEditor(doc.md);
  renderTitle();
  applyChanges(); applyTr();
  window.scrollTo(0, y);
}
els.view.addEventListener("click", () => { setReadonly(!readonly); toast(readonly ? "閲覧に切り替えました" : "編集に切り替えました"); });

/* ------------------------------------------------------------ 戻る / やり直す */
function run(cmd) {
  if (!crepe || readonly) return;
  crepe.editor.action(callCommand(cmd.key));
}
function updateUndo() {
  /* 取り消せるかどうかは部品の中にあるので、ボタンはいつも押せる形にしておく */
  els.undo.disabled = els.redo.disabled = !crepe;
}
const keep = btn => {
  btn.addEventListener("mousedown", e => e.preventDefault());
  btn.addEventListener("touchstart", e => e.preventDefault(), { passive: false });
  btn.addEventListener("touchend", e => { e.preventDefault(); btn.click(); });
};
els.undo.addEventListener("click", () => run(undoCommand)); keep(els.undo);
els.redo.addEventListener("click", () => run(redoCommand)); keep(els.redo);

/* ------------------------------------------------------------ 開いているファイルを覚える（画面を更新しても戻る） */
/* ブラウザの中の保存場所（IndexedDB）に、開いているファイル・中身・読んでいた位置を残す。
   保存していない編集もここに残るので、画面を更新しても消えない */
const idb = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open("mdb", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction("kv", mode), st = t.objectStore("kv"), r = fn(st);
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
  return { get: k => tx("readonly", st => st.get(k)), set: (k, v) => tx("readwrite", st => st.put(v, k)) };
})();
let persistOk = true, restoring = true;
function snapshot(withHandles) {
  return {
    active: doc.uid,
    files: files.map(f => ({ uid: f.uid, name: f.name, fm: f.fm, eol: f.eol, drive: f.drive, folder: f.folder, saved: f.saved, md: f.md,
      scroll: f === doc ? window.scrollY : f.scroll, chgBase: f.chgBase, chgFrom: f.chgFrom, chgCount: f === doc ? spots().length : f.chgCount,
      welcome: f.welcome, handle: withHandles ? f.handle : null })),
  };
}
function persist() {
  if (restoring) return;
  clearTimeout(persist.t);
  persist.t = setTimeout(async () => {
    try { await idb.set("session", snapshot(true)); persistOk = true; }
    catch (e) {
      /* ファイルの手がかりを入れられないブラウザでは、手がかりなしで残す */
      try { await idb.set("session", snapshot(false)); persistOk = true; } catch (e2) { persistOk = false; }
    }
  }, 400);
}
window.addEventListener("scroll", () => { clearTimeout(persist.s); persist.s = setTimeout(persist, 600); }, { passive: true });
/* 残せなかったときだけ、閉じる前に確かめる */
window.addEventListener("beforeunload", e => { if (!persistOk && files.some(dirtyOf)) { e.preventDefault(); e.returnValue = ""; } });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && !restoring) { clearTimeout(persist.t); idb.set("session", snapshot(true)).catch(() => idb.set("session", snapshot(false)).catch(() => {})); } });

/* 前に開いたあとで、ドライブ側で更新されていたら読み直す（保存していない変更があるときは読み直さない） */
async function refreshIfChanged(f) {
  if (!f.drive || f._checked || dirtyOf(f) || !drive.hasToken()) return;
  f._checked = true;
  try {
    const now = await drive.meta(drive.getToken(), f.drive);
    if (!now || now.modifiedTime === f.drive.modifiedTime || f !== doc || dirtyOf(f)) return;
    const text = await drive.read(drive.getToken(), now);
    if (f !== doc || dirtyOf(f)) return;
    await openText(now.name, text, { drive: now, folder: f.folder });
    toast(now.name + " はドライブで更新されていたため、読み直しました");
    afterOpen();
  } catch (e) { /* 読み直せなければ、覚えていた中身のまま */ }
}

/* ------------------------------------------------------------ 開く */
const OK = /\.(md|markdown|mkd|mdown|mdx|txt|text)$/i;
const DRIVE_ICON = '<svg viewBox="0 0 87.3 78" aria-hidden="true"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>';
const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(f, "UTF-8"); });

async function pick() {
  if (!window.showOpenFilePicker || touch) { els.picker.click(); return; }
  try {
    const [h] = await showOpenFilePicker({ types: [{ description: "Markdown",
      accept: { "text/markdown": [".md", ".markdown", ".mdx", ".mkd"], "text/plain": [".txt"] } }] });
    const f = await h.getFile();
    await openText(f.name, await readFile(f), { handle: h });
    toast(f.name + " を開きました");
    afterOpen();
  } catch (e) { /* 取り消し */ }
}
/* 「開く」: ドライブが使えるときは、この端末かドライブかを選ぶ小さなメニューを出す */
const menu = $("#openMenu"), pMenu = $("#pOpenMenu");
function startOpen() {
  if (!drive.configured()) return pick();
  if (document.body.classList.contains("has-panel")) pMenu.hidden = false;
  else menu.hidden = false;
}
$("#pOpen").addEventListener("click", e => { e.stopPropagation(); if (!drive.configured()) return pick(); pMenu.hidden = !pMenu.hidden; });
pMenu.addEventListener("click", e => {
  const b = e.target.closest("[data-o]"); if (!b) return;
  pMenu.hidden = true;
  if (b.dataset.o === "drive") openDrive(); else pick();
});
document.addEventListener("click", e => { if (!pMenu.hidden && !pMenu.contains(e.target)) pMenu.hidden = true; });
$("#pNew").addEventListener("click", () => newFile());
$("#btnOpen").addEventListener("click", e => {
  if (!drive.configured()) return pick();
  e.stopPropagation();
  menu.hidden = !menu.hidden;
});
document.addEventListener("click", e => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
$("#openLocal").addEventListener("click", () => { menu.hidden = true; pick(); });
$("#openDrive").addEventListener("click", () => { menu.hidden = true; openDrive(); });

/* ドライブから開く。ログインのポップアップを止められないよう、最初の await より前にトークンを頼む。
   ファイルは、この画面の中の一覧（#driveSheet）から選ぶ */
const sheet = $("#driveSheet"), dsList = $("#dsList"), dsQuery = $("#dsQuery");
const fmtTime = t => { try { return new Date(t).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } };
const note = html => { dsList.innerHTML = '<p class="ds-note">' + html + "</p>"; };
/* 「最近のファイル」と「フォルダから選ぶ」。どちらで開いたか・最後にいたフォルダは端末ごとに覚える */
let dsMode = store.get("dsMode", "recent");
let dsStack = store.get("dsPath", []);
function setMode(m) {
  dsMode = m; store.set("dsMode", m);
  document.querySelectorAll(".ds-tabs button").forEach(b => { b.classList.toggle("on", b.dataset.m === m); b.setAttribute("aria-selected", String(b.dataset.m === m)); });
  $("#dsSearch").hidden = m !== "recent";
  $("#dsPath").hidden = m !== "folder";
}
document.querySelectorAll(".ds-tabs button").forEach(b => b.addEventListener("click", () => {
  if (b.dataset.m === dsMode) return;
  setMode(b.dataset.m);
  if (dsMode === "recent") showList(drive.getToken(), dsQuery.value.trim()); else showFolder(drive.getToken());
}));
async function openDrive() {
  if (!drive.ready()) { toast("Googleドライブに接続中です。数秒待ってから、もう一度押してください"); return; }
  const tp = drive.getToken();
  dsQuery.value = "";
  sheet.hidden = false;
  setMode(dsMode);
  if (dsMode === "recent") showList(tp, ""); else showFolder(tp);
}
/* フォルダの中を並べる。dsStack が空なら、いちばん上（マイドライブ・パソコン） */
function renderPath() {
  const nav = $("#dsPath");
  nav.innerHTML = "";
  const crumbs = [{ name: "ドライブ" }].concat(dsStack);
  crumbs.forEach((c, i) => {
    if (i) { const sl = document.createElement("span"); sl.className = "sl"; sl.textContent = "/"; nav.append(sl); }
    const b = document.createElement("button");
    b.textContent = c.name; b.title = c.name;
    b.addEventListener("click", () => { dsStack = dsStack.slice(0, i); showFolder(drive.getToken()); });
    nav.append(b);
  });
}
function folderButton(icon, name, sub, onClick) {
  const b = document.createElement("button");
  b.className = "ds-item fo";
  b.innerHTML = IC(icon) + "<b>" + esc(name) + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</b>" + IC("chev");
  b.addEventListener("click", onClick);
  return b;
}
async function showFolder(tp) {
  const seq = ++listSeq;
  store.set("dsPath", dsStack);
  renderPath();
  note("読み込んでいます…");
  try {
    if (!dsStack.length) {
      const rs = await drive.roots(tp);
      if (seq !== listSeq || sheet.hidden) return;
      dsList.innerHTML = "";
      for (const r of rs) {
        dsList.append(folderButton(r.kind === "pc" ? "pc" : "drive", r.name, r.kind === "pc" ? "パソコンから同期しているフォルダ" : "",
          () => { dsStack = [{ id: r.id, name: r.name }]; showFolder(drive.getToken()); }));
      }
      return;
    }
    const here = dsStack[dsStack.length - 1];
    const c = await drive.children(tp, here.id);
    if (seq !== listSeq || sheet.hidden) return;
    dsList.innerHTML = "";
    for (const fo of c.folders) {
      dsList.append(folderButton("folder", fo.name, "", () => { dsStack = dsStack.concat([{ id: fo.id, name: fo.name }]); showFolder(drive.getToken()); }));
    }
    for (const f of c.files) {
      const b = document.createElement("button");
      b.className = "ds-item";
      b.innerHTML = '<span class="fi">' + IC("doc") + "<b>" + esc(f.meta.name) + "<small>" + esc(fmtTime(f.meta.modifiedTime)) + "</small></b></span>";
      b.addEventListener("click", () => pickDrive(f.meta, here.name));
      dsList.append(b);
    }
    if (!c.folders.length && !c.files.length) note("このフォルダには、フォルダも md ファイルもありません。上の「/」の左の名前を押すと、前のフォルダに戻れます。");
  } catch (e) {
    if (seq !== listSeq) return;
    if (e && e.name === "AbortError") { sheet.hidden = true; return; }
    /* 覚えていたフォルダが消えていたときなどは、いちばん上に戻す */
    if (dsStack.length && !(e && e.message === "expired")) { dsStack = []; store.set("dsPath", dsStack); }
    note(e && e.message === "expired" ? "ログインの期限が切れたため、フォルダを出せません。閉じてから、もう一度「開く」を押してください。"
                                      : "通信がうまくいかず、フォルダを出せません。通信を確かめて、閉じてからもう一度「開く」を押してください。");
  }
}
let listSeq = 0;
async function showList(tp, q) {
  const seq = ++listSeq;
  note("読み込んでいます…");
  try {
    const files = await drive.list(tp, q);
    if (seq !== listSeq || sheet.hidden) return;
    if (!files.length) {
      return note(q ? "「" + esc(q) + "」に合う md ファイルは見つかりません。別の言葉で探してください。"
                    : "Googleドライブに md ファイルが見つかりません。PC で、md ファイルのあるフォルダがGoogleドライブと同期されているかを確かめてください。");
    }
    dsList.innerHTML = "";
    for (const f of files) {
      const b = document.createElement("button");
      b.className = "ds-item";
      b.innerHTML = "<b>" + esc(f.meta.name) + "</b><small>" + esc([f.folder, fmtTime(f.meta.modifiedTime)].filter(Boolean).join(" ・ ")) + "</small>";
      b.addEventListener("click", () => pickDrive(f.meta, f.folder));
      dsList.append(b);
    }
  } catch (e) {
    if (seq !== listSeq) return;
    if (e && e.name === "AbortError") { sheet.hidden = true; return; }   /* ログインを取り消した */
    note(e && e.message === "expired" ? "ログインの期限が切れたため、一覧を出せません。閉じてから、もう一度「開く」を押してください。"
                                      : "通信がうまくいかず、一覧を出せません。通信を確かめて、閉じてからもう一度「開く」を押してください。");
  }
}
async function pickDrive(meta, folder) {
  listSeq++;
  note(esc(meta.name) + " を読み込んでいます…");
  try {
    const text = await drive.read(drive.getToken(), meta);
    await openText(meta.name, text, { drive: meta, folder: folder || "" });
    sheet.hidden = true;
    afterOpen();
    toast("ドライブの " + meta.name + " を開きました");
  } catch (e) {
    note(e && e.message === "expired" ? "ログインの期限が切れたため、開けません。閉じてから、もう一度「開く」を押してください。"
                                      : "通信がうまくいかず、開けません。通信を確かめて、もう一度ファイルを選んでください。");
  }
}
/* 探す欄: 打ち終わって少ししてから探す */
dsQuery.addEventListener("input", () => {
  clearTimeout(dsQuery.t);
  dsQuery.t = setTimeout(() => showList(drive.getToken(), dsQuery.value.trim()), 450);
});
const closeSheet = () => { listSeq++; sheet.hidden = true; };
$("#dsClose").addEventListener("click", closeSheet);
sheet.addEventListener("click", e => { if (e.target === sheet) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
els.picker.addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  await openText(f.name, await readFile(f), { handle: null });
  toast(f.name + " を開きました");
  afterOpen();
});
/* 新しいファイル。名前が重ならないように番号を付ける */
async function newFile() {
  let name = "無題.md", n = 2;
  while (files.some(f => f.name === name && !f.drive && !f.handle)) name = "無題 " + (n++) + ".md";
  await openText(name, "", { handle: null, drive: null, folder: "" });
}
$("#btnNew").addEventListener("click", newFile);

let depth = 0;
window.addEventListener("dragenter", e => { if ([...(e.dataTransfer.types || [])].includes("Files")) { e.preventDefault(); depth++; els.drop.classList.add("on"); } });
window.addEventListener("dragover", e => { if ([...(e.dataTransfer.types || [])].includes("Files")) e.preventDefault(); });
window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; els.drop.classList.remove("on"); } });
window.addEventListener("drop", async e => {
  if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes("Files")) return;
  e.preventDefault(); depth = 0; els.drop.classList.remove("on");
  /* 置いたファイルは、この処理の最初（await より前）でしか読めない。await のあとは中身が空になるので、先に取っておく */
  const f = e.dataTransfer.files[0];
  const it = e.dataTransfer.items && e.dataTransfer.items[0];
  const hp = it && it.getAsFileSystemHandle ? it.getAsFileSystemHandle().catch(() => null) : null;
  if (!f || !OK.test(f.name)) { toast("Markdown（.md）ではないため開けません。.md か .txt のファイルを置いてください"); return; }
  /* 上書き保存に使う手がかり（Chrome / Edge のみ） */
  const h = hp && await hp;
  const handle = h && h.kind === "file" ? h : null;
  await openText(f.name, await readFile(f), { handle });
  toast(f.name + " を開きました");
  afterOpen();
});

/* URL の # で受け取る（iPhone のショートカットから）: index.html#name=メモ.md&md=<URLエンコードした本文> */
async function openFromHash() {
  const h = location.hash.slice(1);
  /* PC のパスで開く: index.html#path=C:\Users\...\メモ.md（Claude Code が返すリンク） */
  const pm = /(?:^|&)path=(.*)$/.exec(h);
  if (pm) {
    let path = pm[1];
    try { path = decodeURIComponent(path); } catch (e) { /* エンコードされていないパスはそのまま使う */ }
    history.replaceState(null, "", location.pathname + location.search);
    openByPath(path);
    return false;   /* 下ではいつもどおり編集画面を用意しておく（カードを閉じても空にならないように） */
  }
  if (!/(^|&)md=/.test(h)) return false;
  const p = {};
  for (const kv of h.split("&")) {
    const i = kv.indexOf("=");
    if (i > 0) { try { p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { return false; } }
  }
  history.replaceState(null, "", location.pathname + location.search);
  await openText(p.name || "共有.md", p.md || "", { handle: null, drive: null });
  afterOpen();
  toast((p.name || "共有.md") + " を開きました");
  return true;
}
window.addEventListener("hashchange", openFromHash);

/* ---- PC のパスから、Google ドライブの同じファイルを開く */
const card = $("#pathCard");
function showCard(html, buttons) {
  card.querySelector(".pc-body").innerHTML = html;
  const row = card.querySelector(".pc-btns"); row.innerHTML = "";
  for (const [label, fn, primary] of buttons) {
    const b = document.createElement("button");
    b.className = "btn" + (primary ? " pri" : ""); b.textContent = label;
    b.addEventListener("click", fn);
    row.append(b);
  }
  card.hidden = false;
}
const hideCard = () => { card.hidden = true; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function openByPath(path) {
  if (!drive.configured()) { toast("Googleドライブにつながらないため、パスからは開けません"); return; }
  const name = drive.splitPath(path).pop() || path;
  const head = '<b>' + esc(name) + '</b><small>' + esc(path) + '</small>';
  /* ログイン済みなら、そのまま探して開く。まだなら、ログインの窓は押したときにしか開けないのでボタンを出す */
  if (drive.hasToken()) {
    await drive.preload().catch(() => {});
    return findAndOpen(path, head);
  }
  showCard(head + '<p>Googleドライブの中から、このファイルを探して開きます。</p>', [
    ["やめる", hideCard],
    ["Googleドライブで開く", () => {
      if (!drive.ready()) { toast("Googleドライブに接続中です。数秒待ってから、もう一度押してください"); return; }
      findAndOpen(path, head, drive.getToken());
    }, true],
  ]);
  drive.preload().catch(() => showCard(head + '<p>Googleに接続できないため、開けません。通信を確かめて、ページを開き直してください。</p>', [["閉じる", hideCard]]));
}

async function findAndOpen(path, head, tp) {
  showCard(head + '<p>探しています…</p>', []);
  try {
    const r = await drive.findByPath(tp || drive.getToken(), path);
    if (!r.found.length) {
      return showCard(head + '<p>このファイルはGoogleドライブに見つかりません。PC でフォルダがGoogleドライブと同期されているか、同期が終わっているかを確かめてください。</p>',
        [["閉じる", hideCard]]);
    }
    if (r.found.length > 1) {
      /* 同じ名前・同じ場所に見えるファイルが複数あるときは選んでもらう */
      return showCard(head + '<p>同じ名前のファイルが複数あります。開くものを選んでください。</p>',
        r.found.slice(0, 6).map(f => [f.where || f.meta.name, () => openMeta(f.meta, tp, f.where)]).concat([["やめる", hideCard]]));
    }
    await openMeta(r.found[0].meta, tp, r.found[0].where);
  } catch (e) {
    if (e && e.name === "AbortError") return hideCard();
    showCard(head + '<p>' + (e && e.message === "expired" ? "ログインの期限が切れたため、開けません。リンクをもう一度押してください。" : "通信がうまくいかず、開けません。少し待ってから、リンクをもう一度押してください。") + '</p>', [["閉じる", hideCard]]);
  }
}

async function openMeta(meta, tp, where) {
  showCard('<b>' + esc(meta.name) + '</b><p>読み込んでいます…</p>', []);
  const text = await drive.read(tp || drive.getToken(), meta);
  /* where は「マイドライブ / フォルダ / …」。いちばん近いフォルダの名前を出す */
  const folder = where ? where.split(" / ").pop() : "";
  await openText(meta.name, text, { drive: meta, folder });
  hideCard();
  toast("PC のファイルを開きました。保存するとPCにも反映されます");
  afterOpen();
}

/* ------------------------------------------------------------ 前に見たときから変わった所 */
/* この端末で前に開いた・保存した中身を、ファイルごとに覚えておく（新しい40件まで）。
   次に開いたとき、そこから変わった所に色を付ける。覚えていなければ、ドライブの1つ前の版と比べる */
const SEEN_MAX = 40;
const docKey = () => doc.drive ? "d:" + doc.drive.id : doc.name ? "f:" + doc.name : null;
function seenGet(k) {
  try { const all = JSON.parse(localStorage.getItem("mdb.seen") || "{}"); return all[k] ? all[k].md : null; } catch (e) { return null; }
}
function seenSet(k, md) {
  if (!k || md.length > 300000) return;
  try {
    const all = JSON.parse(localStorage.getItem("mdb.seen") || "{}");
    all[k] = { md, t: Date.now() };
    const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
    for (const old of keys.slice(SEEN_MAX)) delete all[old];
    localStorage.setItem("mdb.seen", JSON.stringify(all));
  } catch (e) { /* 覚えられなくても、表示はふつうにできる */ }
}

const chg = { idx: -1 };
async function afterOpen() {
  const k = docKey();
  if (!k || doc.welcome) return;
  const opened = doc.md, meta = doc.drive;
  let base = seenGet(k), from = "seen";
  seenSet(k, opened);
  if (base == null && meta && drive.hasToken()) {
    try {
      const prev = await drive.previous(drive.getToken(), meta);
      if (prev != null) {
        const m = FM.exec(prev);
        base = (m ? prev.slice(m[0].length) : prev).replace(/\r\n?/g, "\n");
        from = "rev";
      }
    } catch (e) { /* 前の版が取れなければ、色は付けない */ }
  }
  /* 待っているあいだに別のファイルを開いていたら、何もしない */
  if (base == null || docKey() !== k || base === opened) return;
  doc.chgBase = base; doc.chgFrom = from; chg.idx = -1;
  applyChanges(); persist();
}
/* もとの中身と今の本文を比べて、色を付け直す */
function applyChanges() {
  if (!crepe || doc.chgBase == null) return showChgBar();
  try {
    crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const baseDoc = ctx.get(parserCtx)(doc.chgBase);
      setDecorations(view, diffDecorations(baseDoc, view.state.doc).set);
    });
  } catch (e) { doc.chgBase = null; }
  showChgBar();
}
function spots() {
  let list = [];
  if (crepe && doc.chgBase != null) { try { crepe.editor.action(ctx => { list = spotPositions(ctx.get(editorViewCtx).state); }); } catch (e) {} }
  return list;
}
function showChgBar() {
  const n = spots().length;
  $("#chgBar").hidden = !n;
  document.body.classList.toggle("has-chg", !!n);
  if (n !== showChgBar.n) { showChgBar.n = n; renderFilesSoon(); }
  if (n) $("#chgText").textContent = (doc.chgFrom === "rev" ? "1つ前の版から" : "前に開いたときから") + "変わった所：" + n + "か所";
}
$("#chgNext").addEventListener("click", () => {
  const list = spots();
  if (!list.length) return;
  chg.idx = (chg.idx + 1) % list.length;
  crepe.editor.action(ctx => {
    const view = ctx.get(editorViewCtx);
    const c = view.coordsAtPos(list[chg.idx]);
    window.scrollTo({ top: c.top + window.scrollY - window.innerHeight / 3, behavior: "smooth" });
  });
});
function renderFilesSoon() { clearTimeout(renderFilesSoon.t); renderFilesSoon.t = setTimeout(renderFiles, 50); }
$("#chgClear").addEventListener("click", () => {
  doc.chgBase = null; persist();
  if (crepe) crepe.editor.action(ctx => setDecorations(ctx.get(editorViewCtx), DecorationSet.empty));
  showChgBar();
});

/* ------------------------------------------------------------ 和訳 */
/* 「和訳を表示」を押すと、英語の段落の下に和訳を出す。表示するかどうかは端末ごとに覚える。
   書き換えたら少し待って、変わった段落だけ訳し直す */
const btnTr = $("#btnTr");
let trOn = store.get("tr", false), trSeq = 0;
btnTr.hidden = !drive.GOOGLE.translateKey;
function renderTrBtn(busy) {
  const text = busy ? "訳しています…" : trOn ? "和訳を隠す" : "和訳を表示";
  btnTr.setAttribute("aria-pressed", String(trOn));
  btnTr.setAttribute("aria-label", text);
  btnTr.title = trOn ? "和訳を隠す" : "英語の段落の下に和訳を表示";
  const l = btnTr.querySelector(".label"); if (l) l.textContent = text;
}
async function applyTr(manual) {
  if (!crepe || !drive.GOOGLE.translateKey) return;
  const seq = ++trSeq, f = doc;
  const view = () => { let v; crepe.editor.action(ctx => { v = ctx.get(editorViewCtx); }); return v; };
  if (!trOn) { setTr(view(), DecorationSet.empty); return; }
  const htmls = trBlocks(view().state.doc).map(b => b.html);
  if (manual && !htmls.length) toast("訳す英語の段落が見つかりません。コード枠の中は訳しません");
  renderTrBtn(true);
  try {
    await translateMissing(htmls, drive.GOOGLE.translateKey);
  } catch (e) {
    if (seq !== trSeq) return;
    trOn = false; store.set("tr", false); renderTrBtn();
    const why = String(e.reason || "");
    toast(e.status === 403 || e.status === 400
      ? (/billing/i.test(why) ? "Google Cloud で支払い方法が登録されていないため、訳せません。登録してから、もう一度押してください"
        : /not been used|disabled/i.test(why) ? "Google Cloud で翻訳サービスが有効になっていないため、訳せません。有効にしてから、もう一度押してください"
        : "翻訳サービスの API キーが使えないため、訳せません。Google Cloud で API キーの設定を確かめてください")
      : e.status === 429 ? "翻訳サービスの上限に達したため、訳せません。少し待ってから、もう一度押してください"
      : "通信がうまくいかず、訳せません。通信を確かめて、もう一度押してください");
    return;
  }
  if (seq !== trSeq || f !== doc || !crepe) return;
  renderTrBtn();
  const v = view();
  setTr(v, trDecorations(v.state.doc));
}
function trSoon() { if (!trOn) return; clearTimeout(trSoon.t); trSoon.t = setTimeout(applyTr, 1500); }
btnTr.addEventListener("click", () => {
  trOn = !trOn; store.set("tr", trOn); renderTrBtn();
  applyTr(true);
});
renderTrBtn();

/* ------------------------------------------------------------ 保存 */
async function writeTo(handle, text) {
  if (handle.queryPermission && await handle.queryPermission({ mode: "readwrite" }) !== "granted" &&
      await handle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("denied");
  const w = await handle.createWritable();
  await w.write(text); await w.close();
}
function saved(msg) { doc.saved = doc.md; renderTitle(); toast(msg); seenSet(docKey(), doc.md); persist(); }

/* ドライブの原本に上書きする。ここも最初の await より前にトークンを頼む */
async function saveDrive(text) {
  if (!drive.ready()) { toast("Googleドライブに接続中です。数秒待ってから、もう一度押してください"); return; }
  const tp = drive.getToken();
  try {
    doc.drive = await drive.save(tp, doc.drive, text,
      () => confirm("開いたあとに、ドライブ側でこのファイルが更新されています。上書きしますか？"));
    saved("Googleドライブに保存しました");
  } catch (e) {
    if (e && e.name === "AbortError") return;
    toast(e && e.message === "expired" ? "ログインの期限が切れたため、保存できませんでした。もう一度「保存」を押してください" : "通信がうまくいかず、保存できませんでした。通信を確かめて、もう一度「保存」を押してください");
  }
}

async function saveDoc() {
  if (!crepe) return;
  doc.md = crepe.getMarkdown();
  const text = fullText();
  if (doc.drive) return saveDrive(text);
  const name = /\.[^.]+$/.test(doc.name) ? doc.name : (doc.name || "無題") + ".md";
  try {
    if (doc.handle && doc.handle.createWritable) { await writeTo(doc.handle, text); return saved("上書き保存しました"); }
    if (window.showSaveFilePicker && !touch) {
      const h = await showSaveFilePicker({ suggestedName: name,
        types: [{ description: "Markdown", accept: { "text/markdown": [".md", ".markdown", ".mdx", ".mkd", ".txt"] } }] });
      await writeTo(h, text); doc.handle = h; doc.name = h.name; doc.welcome = false;
      return saved(h.name + " に保存しました");
    }
    const file = new File([text], name, { type: "text/plain" });
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return saved("共有メニューに渡しました");
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    saved(name + " をダウンロードしました");
  } catch (e) {
    if (e && e.name === "AbortError") return;
    toast("保存できませんでした。保存先を選び直して、もう一度「保存」を押してください");
  }
}
els.save.addEventListener("click", saveDoc);
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveDoc(); }
  if ((e.ctrlKey || e.metaKey) && e.key === "o") { e.preventDefault(); pick(); }
});

/* ------------------------------------------------------------ 文字の大きさ・テーマ（端末ごとに覚える） */
let theme = store.get("theme", "auto");
let fs = store.get("fs", 15);
let cw = store.get("cw", 860);
function applyCfg() {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty("--fs", fs + "px");
  document.documentElement.style.setProperty("--cw", cw + "px");
  document.querySelectorAll("#segCw button").forEach(b => b.classList.toggle("on", +b.dataset.v === cw));
  document.querySelectorAll("#segTheme button").forEach(b => b.classList.toggle("on", b.dataset.v === theme));
  document.querySelectorAll("#segFs button").forEach(b => b.classList.toggle("on", +b.dataset.v === fs));
}
const cfgMenu = $("#cfgMenu");
$("#btnCfg").addEventListener("click", e => { e.stopPropagation(); cfgMenu.hidden = !cfgMenu.hidden; });
document.addEventListener("click", e => { if (!cfgMenu.hidden && !cfgMenu.contains(e.target)) cfgMenu.hidden = true; });
$("#segTheme").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; theme = b.dataset.v; store.set("theme", theme); applyCfg(); });
$("#segCw").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; cw = +b.dataset.v; store.set("cw", cw); applyCfg(); });
$("#segFs").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; fs = +b.dataset.v; store.set("fs", fs); applyCfg(); });
applyCfg();

/* ------------------------------------------------------------ 起動 */
const WELCOME = [
  "# ようこそ",
  "",
  "Markdown を読みやすく表示して、そのまま書き直せます。記号を覚えなくても書けます。",
  "",
  "## 書き方",
  "",
  "- 行のはじめで「/」を押すと、見出しや表を挿入できます",
  "- 文字を選ぶと、太字やリンクのボタンが出ます",
  "- 行の左の ⋮⋮ をつかむと、段落ごと並べ替えられます。複数の段落にまたがって文字を選んでからつかむと、まとめて動かせます",
  "- Ctrl（Mac は ⌘）+ Shift + ↑ / ↓ でも、選んだ段落を上下に動かせます",
  "- 行のはじめで `- ` `## ` `- [ ] ` と打つと、その場で箇条書き・見出し・チェックに変わります",
  "",
  "## ファイルを開く",
  "",
  "- 右上の「開く」から、この端末かGoogleドライブのファイルを選びます",
  "- PC では、ファイルをこの画面に置いても開けます",
  "- 前に開いたときから変わった所は、文字の色が変わります（Claude が直した所の確認に）。色は表示だけで、ファイルには入りません",
  "",
  "| 操作 | PC | iPhone |",
  "| --- | --- | --- |",
  "| 保存 | Ctrl + S | 上の保存ボタン |",
  "| 閲覧に切り替え | 上の「閲覧に切り替え」 | 上の目のボタン |",
  "| 元に戻す | Ctrl + Z | 上の矢印のボタン |",
  "",
].join("\n");

applyPanel();
drive.preload().catch(() => { /* 読めなければドライブのメニューは使えないだけ */ });

/* 起動: 前に開いていたファイルを戻す。なければ「ようこそ」を出す */
async function restore() {
  let ses = null;
  try { ses = await idb.get("session"); } catch (e) { persistOk = false; }
  if (ses && ses.files && ses.files.length) {
    for (const x of ses.files) files.push(blank(x));
    const act = files.find(f => f.uid === ses.active) || files[0];
    await show(act);
    return true;
  }
  /* 前の作りで残した下書き（1件だけ）があれば、それを戻す */
  const d = store.get("draft", null);
  if (d && typeof d.md === "string") {
    const f = blank({ name: d.name || "無題.md", fm: d.fm || "", eol: d.eol || "\n", drive: d.drive && d.drive.id ? d.drive : null, md: d.md, saved: "" });
    files.push(f);
    await show(f);
    store.set("draft", null);
    toast("保存していない編集を復元しました");
    return true;
  }
  return false;
}

(async () => {
  const had = await restore();
  if (!had) await openText("ようこそ.md", WELCOME, { welcome: true });
  restoring = false; persist();
  await openFromHash();
})();
