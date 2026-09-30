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
import { remarkStringifyOptionsCtx, editorViewCtx } from "@milkdown/kit/core";
import { blockServiceInstance } from "@milkdown/kit/plugin/block";
import { undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import * as drive from "./drive.js";
import { ACTIONS, headingLevel, setHeading, indent, inCode } from "./panel.js";
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
const VERSION = "2026-09-30";
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
const doc = { name: "", fm: "", eol: "\n", handle: null, drive: null, saved: "", md: "" };
let crepe = null;

const fullText = () => {
  const body = doc.md.replace(/\n/g, doc.eol);
  return doc.fm ? doc.fm + (doc.fm.endsWith("\n") ? "" : doc.eol) + body : body;
};
const isDirty = () => doc.md !== doc.saved;

function renderTitle() {
  els.name.innerHTML = "";
  if (doc.drive) {
    const g = document.createElement("span");
    g.className = "gd"; g.title = "Googleドライブのファイル（保存するとドライブに上書き）";
    g.innerHTML = DRIVE_ICON;
    els.name.append(g);
  }
  els.name.append(doc.name || "無題.md");
  if (isDirty()) {
    const dot = document.createElement("span");
    dot.className = "dot"; dot.textContent = " ●"; dot.title = "保存していない変更があります";
    els.name.append(dot);
  }
  els.save.classList.toggle("dirty", isDirty());
  document.title = (doc.name || "無題.md") + " — Markdown Viewer";
}

async function openText(name, text, handle, restoredMd) {
  const m = FM.exec(text);
  doc.name = name; doc.handle = handle || null; doc.drive = null;
  doc.eol = /\r\n/.test(text) ? "\r\n" : "\n";
  doc.fm = m ? m[0] : "";
  const body = (m ? text.slice(m[0].length) : text).replace(/\r\n?/g, "\n");

  await makeEditor(restoredMd != null ? restoredMd : body);
  /* 部品が書き直した形を「保存済み」の基準にする（開いただけで ● が付かないように） */
  doc.saved = restoredMd != null ? null : doc.md;
  renderTitle(); updateUndo();
  if (!touch) els.root.querySelector(".ProseMirror")?.focus();
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
  crepe.on(api => {
    api.markdownUpdated((ctx, md) => {
      doc.md = md;
      renderTitle(); updateUndo(); schedulePanel();
      clearTimeout(openText.t);
      openText.t = setTimeout(saveDraft, 400);
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
function updateToc() {
  const toc = $("#toc");
  const hs = [...els.root.querySelectorAll(".ProseMirror > h1, .ProseMirror > h2, .ProseMirror > h3")].filter(h => h.textContent.trim());
  toc.innerHTML = hs.length ? "" : '<div class="none">見出しを作ると、ここに並びます</div>';
  hs.forEach(h => {
    const a = document.createElement("a");
    a.className = "l" + h.tagName[1];
    a.textContent = h.textContent;
    a.title = h.textContent;
    a.addEventListener("click", () => window.scrollTo({ top: h.getBoundingClientRect().top + window.scrollY - 64, behavior: "smooth" }));
    toc.append(a);
  });
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
    buildTopBar: builder => builder.addGroup("indent", "字下げ")
      .addItem("sink", { icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M11 12h10M11 18h10"/><path d="m3 10 4 3-4 3"/></svg>', active: () => false, onRun: ctx => { const why = indent(ctx, false); if (why) toast(why); } })
      .addItem("lift", { icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M11 12h10M11 18h10"/><path d="m7 10-4 3 4 3"/></svg>', active: () => false, onRun: ctx => { const why = indent(ctx, true); if (why) toast(why); } }),
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
  const y = window.scrollY, saved = doc.saved;
  await makeEditor(doc.md);
  doc.saved = saved; renderTitle();
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

/* ------------------------------------------------------------ 下書き */
function saveDraft() {
  store.set("draft", isDirty() ? { name: doc.name, fm: doc.fm, eol: doc.eol, md: doc.md, drive: doc.drive } : null);
}
window.addEventListener("beforeunload", e => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } });

/* ------------------------------------------------------------ 開く */
const OK = /\.(md|markdown|mkd|mdown|mdx|txt|text)$/i;
const DRIVE_ICON = '<svg viewBox="0 0 87.3 78" aria-hidden="true"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>';
const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(f, "UTF-8"); });
const confirmDiscard = () => !isDirty() || confirm("保存していない変更があります。変更を捨てて開きますか？");

async function pick() {
  if (!confirmDiscard()) return;
  if (!window.showOpenFilePicker || touch) { els.picker.click(); return; }
  try {
    const [h] = await showOpenFilePicker({ types: [{ description: "Markdown",
      accept: { "text/markdown": [".md", ".markdown", ".mdx", ".mkd"], "text/plain": [".txt"] } }] });
    const f = await h.getFile();
    await openText(f.name, await readFile(f), h);
    toast(f.name + " を開きました");
  } catch (e) { /* 取り消し */ }
}
/* 「開く」: ドライブが使えるときは、この端末かドライブかを選ぶ小さなメニューを出す */
const menu = $("#openMenu");
$("#btnOpen").addEventListener("click", e => {
  if (!drive.configured()) return pick();
  e.stopPropagation();
  menu.hidden = !menu.hidden;
});
document.addEventListener("click", e => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
$("#openLocal").addEventListener("click", () => { menu.hidden = true; pick(); });
$("#openDrive").addEventListener("click", () => { menu.hidden = true; openDrive(); });

/* ドライブから開く。ログインのポップアップを止められないよう、最初の await より前にトークンを頼む */
async function openDrive() {
  if (!confirmDiscard()) return;
  if (!drive.ready()) { toast("Googleドライブに接続中です。数秒待ってから、もう一度押してください"); return; }
  const tp = drive.getToken();
  try {
    const r = await drive.open(tp);
    if (!r) return;
    if (!OK.test(r.meta.name) && !confirm(r.meta.name + " はMarkdown（.md）ではないため、正しく表示できないことがあります。開きますか？")) return;
    await openText(r.meta.name, r.text);
    doc.drive = r.meta; renderTitle();
    toast("ドライブの " + r.meta.name + " を開きました");
  } catch (e) {
    if (e && e.name === "AbortError") return;
    toast(e && e.message === "expired" ? "ログインの期限が切れたため、開けませんでした。もう一度「開く」を押してください" : "通信がうまくいかず、開けませんでした。通信を確かめて、もう一度開いてください");
  }
}
els.picker.addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  await openText(f.name, await readFile(f));
  toast(f.name + " を開きました");
});
$("#btnNew").addEventListener("click", async () => {
  if (!confirmDiscard()) return;
  await openText("無題.md", "");
});

let depth = 0;
window.addEventListener("dragenter", e => { if ([...(e.dataTransfer.types || [])].includes("Files")) { e.preventDefault(); depth++; els.drop.classList.add("on"); } });
window.addEventListener("dragover", e => { if ([...(e.dataTransfer.types || [])].includes("Files")) e.preventDefault(); });
window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; els.drop.classList.remove("on"); } });
window.addEventListener("drop", async e => {
  if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes("Files")) return;
  e.preventDefault(); depth = 0; els.drop.classList.remove("on");
  if (!confirmDiscard()) return;
  let handle = null;
  const it = e.dataTransfer.items && e.dataTransfer.items[0];
  if (it && it.getAsFileSystemHandle) { try { const h = await it.getAsFileSystemHandle(); if (h && h.kind === "file") handle = h; } catch (err) {} }
  const f = e.dataTransfer.files[0];
  if (!f || !OK.test(f.name)) { toast("Markdown（.md）ではないため開けません。.md か .txt のファイルを置いてください"); return; }
  await openText(f.name, await readFile(f), handle);
  toast(f.name + " を開きました");
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
  if (!confirmDiscard()) return true;
  await openText(p.name || "共有.md", p.md || "");
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
        r.found.slice(0, 6).map(f => [f.where || f.meta.name, () => openMeta(f.meta, tp)]).concat([["やめる", hideCard]]));
    }
    await openMeta(r.found[0].meta, tp);
  } catch (e) {
    if (e && e.name === "AbortError") return hideCard();
    showCard(head + '<p>' + (e && e.message === "expired" ? "ログインの期限が切れたため、開けません。リンクをもう一度押してください。" : "通信がうまくいかず、開けません。少し待ってから、リンクをもう一度押してください。") + '</p>', [["閉じる", hideCard]]);
  }
}

async function openMeta(meta, tp) {
  if (!confirmDiscard()) return hideCard();
  showCard('<b>' + esc(meta.name) + '</b><p>読み込んでいます…</p>', []);
  const text = await drive.read(tp || drive.getToken(), meta);
  await openText(meta.name, text);
  doc.drive = meta; renderTitle(); saveDraft();
  hideCard();
  toast("PC のファイルを開きました。保存するとPCにも反映されます");
}

/* ------------------------------------------------------------ 保存 */
async function writeTo(handle, text) {
  if (handle.queryPermission && await handle.queryPermission({ mode: "readwrite" }) !== "granted" &&
      await handle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("denied");
  const w = await handle.createWritable();
  await w.write(text); await w.close();
}
function saved(msg) { doc.saved = doc.md; saveDraft(); renderTitle(); toast(msg); }

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
      await writeTo(h, text); doc.handle = h; doc.name = h.name;
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
  "- 行の左の ⋮⋮ をつかむと、段落ごと並べ替えられます",
  "- 行のはじめで `- ` `## ` `- [ ] ` と打つと、その場で箇条書き・見出し・チェックに変わります",
  "",
  "## ファイルを開く",
  "",
  "- 右上の「開く」から、この端末かGoogleドライブのファイルを選びます",
  "- PC では、ファイルをこの画面に置いても開けます",
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

(async () => {
  if (await openFromHash()) return;
  const d = store.get("draft", null);
  if (d && typeof d.md === "string") {
    doc.fm = d.fm || ""; await openText(d.name || "無題.md", "", null, d.md);
    doc.fm = d.fm || ""; doc.eol = d.eol || "\n";
    if (d.drive && d.drive.id) { doc.drive = d.drive; renderTitle(); }
    toast("保存していない編集を復元しました");
    return;
  }
  await openText("ようこそ.md", WELCOME);
})();
