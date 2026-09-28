/* ============================================================================
 *  Markdown Editor β — Notion のように、記号を見ずに書ける編集画面の試作
 *  編集部品は Milkdown Crepe（ProseMirror）。build.mjs で beta.html 1つにまとめる。
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

const VERSION = "β0.3 (2026-09-28)";
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
const doc = { name: "", fm: "", eol: "\n", handle: null, saved: "", md: "" };
let crepe = null;

const fullText = () => {
  const body = doc.md.replace(/\n/g, doc.eol);
  return doc.fm ? doc.fm + (doc.fm.endsWith("\n") ? "" : doc.eol) + body : body;
};
const isDirty = () => doc.md !== doc.saved;

function renderTitle() {
  els.name.innerHTML = "";
  els.name.append(doc.name || "無題.md");
  if (isDirty()) {
    const dot = document.createElement("span");
    dot.className = "dot"; dot.textContent = " ●"; dot.title = "保存していない変更があります";
    els.name.append(dot);
  }
  els.save.classList.toggle("dirty", isDirty());
  document.title = (doc.name || "無題.md") + " — Markdown Editor β";
}

async function openText(name, text, handle, restoredMd) {
  const m = FM.exec(text);
  doc.name = name; doc.handle = handle || null;
  doc.eol = /\r\n/.test(text) ? "\r\n" : "\n";
  doc.fm = m ? m[0] : "";
  const body = (m ? text.slice(m[0].length) : text).replace(/\r\n?/g, "\n");

  await makeEditor(restoredMd != null ? restoredMd : body);
  /* 部品が書き直した形を「保存済み」の基準にする（開いただけで ● が付かないように） */
  doc.saved = restoredMd != null ? null : doc.md;
  renderTitle(); updateUndo();
  if (!touch) els.root.querySelector(".ProseMirror")?.focus();
}

/* 編集部品を作り直す（ファイルを開いたとき・表示のみから戻ったとき） */
async function makeEditor(md) {
  if (crepe) await crepe.destroy();
  els.root.innerHTML = "";
  crepe = new CrepeBuilder({ root: els.root, defaultValue: md });
  crepe.addFeature(cursor).addFeature(listItem).addFeature(linkTooltip).addFeature(table)
       .addFeature(imageBlock, JA.imageBlock).addFeature(placeholder, JA.placeholder)
       .addFeature(blockEdit, JA.blockEdit).addFeature(toolbar, JA.toolbar);
  /* スマホは選択して出るバーが使いにくいので、書式のバーを上に常に出す */
  if (touch) crepe.addFeature(topBar, JA.topBar);
  /* 保存するときの書き方を、よく使われる形にそろえる（箇条書きは「- 」、区切り線は「---」） */
  crepe.editor.config(ctx => ctx.update(remarkStringifyOptionsCtx, o => ({ ...o, bullet: "-", rule: "-" })));
  crepe.on(api => {
    api.markdownUpdated((ctx, md) => {
      doc.md = md;
      renderTitle(); updateUndo();
      clearTimeout(openText.t);
      openText.t = setTimeout(saveDraft, 400);
    });
    api.selectionUpdated(followCaret);
  });
  await crepe.create();
  crepe.setReadonly(readonly);
  doc.md = crepe.getMarkdown();
}

/* ------------------------------------------------------------ 日本語の表示 */
const JA = {
  placeholder: { text: "「/」でメニュー。そのまま書き始めてもOK", mode: "block" },
  blockEdit: {
    textGroup: {
      label: "文章", text: { label: "本文" }, h1: { label: "見出し 大" }, h2: { label: "見出し 中" },
      h3: { label: "見出し 小" }, h4: { label: "見出し 4" }, h5: { label: "見出し 5" }, h6: { label: "見出し 6" },
      quote: { label: "引用" }, divider: { label: "区切り線" },
    },
    listGroup: { label: "リスト", bulletList: { label: "箇条書き" }, orderedList: { label: "番号付き" }, taskList: { label: "チェックリスト" } },
    advancedGroup: { label: "そのほか", image: { label: "画像" }, codeBlock: { label: "コード" }, table: { label: "表" }, math: null },
  },
  toolbar: { boldLabel: "太字", italicLabel: "斜体", strikethroughLabel: "取り消し線", codeLabel: "コード", linkLabel: "リンク" },
  topBar: {
    headingOptions: [
      { label: "本文", level: null }, { label: "見出し 大", level: 1 },
      { label: "見出し 中", level: 2 }, { label: "見出し 小", level: 3 },
    ],
  },
  imageBlock: { inlineUploadPlaceholderText: "または画像のURLを貼り付け", blockUploadPlaceholderText: "または画像のURLを貼り付け",
                                inlineUploadButton: "画像を選ぶ", blockUploadButton: "画像を選ぶ", blockCaptionPlaceholderText: "説明を書く" },
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

/* ------------------------------------------------------------ 表示のみ */
async function setReadonly(on) {
  readonly = on;
  document.body.classList.toggle("readonly", on);
  els.view.setAttribute("aria-pressed", String(on));
  els.view.title = on ? "編集に戻る" : "表示のみ（編集しない）";
  const label = els.view.querySelector(".label"); if (label) label.textContent = on ? "編集する" : "表示のみ";
  if (!crepe) return;
  if (on) {
    crepe.setReadonly(true);
    if (document.activeElement) document.activeElement.blur();   /* キーボードを閉じる */
    return;
  }
  /* 部品の書式バーは、一度読むだけにすると編集に戻しても出てこない（部品側の不具合）。
     なので今の本文で編集部品を作り直す。表示位置は保つ。戻る・やり直すの履歴はここで区切られる */
  const y = window.scrollY, saved = doc.saved;
  await makeEditor(doc.md);
  doc.saved = saved; renderTitle();
  window.scrollTo(0, y);
}
els.view.addEventListener("click", () => { setReadonly(!readonly); toast(readonly ? "表示のみにしました" : "編集できるようにしました"); });

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
  store.set("draft", isDirty() ? { name: doc.name, fm: doc.fm, eol: doc.eol, md: doc.md } : null);
}
window.addEventListener("beforeunload", e => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } });

/* ------------------------------------------------------------ 開く */
const OK = /\.(md|markdown|mkd|mdown|mdx|txt|text)$/i;
const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(f, "UTF-8"); });
const confirmDiscard = () => !isDirty() || confirm("保存していない変更があります。破棄して開きますか？");

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
$("#btnOpen").addEventListener("click", pick);
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
  if (!f || !OK.test(f.name)) { toast("Markdownファイルではないようです"); return; }
  await openText(f.name, await readFile(f), handle);
  toast(f.name + " を開きました");
});

/* URL の # で受け取る（iPhone のショートカットから）: beta.html#name=メモ.md&md=<URLエンコードした本文> */
async function openFromHash() {
  const h = location.hash.slice(1);
  if (!/(^|&)md=/.test(h)) return false;
  const p = {};
  for (const kv of h.split("&")) {
    const i = kv.indexOf("=");
    if (i > 0) { try { p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { return false; } }
  }
  history.replaceState(null, "", location.pathname + location.search);
  if (!confirmDiscard()) return true;
  await openText(p.name || "共有.md", p.md || "");
  toast("共有されたファイルを開きました");
  return true;
}
window.addEventListener("hashchange", openFromHash);

/* ------------------------------------------------------------ 保存 */
async function writeTo(handle, text) {
  if (handle.queryPermission && await handle.queryPermission({ mode: "readwrite" }) !== "granted" &&
      await handle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("denied");
  const w = await handle.createWritable();
  await w.write(text); await w.close();
}
function saved(msg) { doc.saved = doc.md; saveDraft(); renderTitle(); toast(msg); }

async function saveDoc() {
  if (!crepe) return;
  doc.md = crepe.getMarkdown();
  const text = fullText();
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
    toast("保存できませんでした");
  }
}
els.save.addEventListener("click", saveDoc);
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveDoc(); }
  if ((e.ctrlKey || e.metaKey) && e.key === "o") { e.preventDefault(); pick(); }
});

/* ------------------------------------------------------------ テーマ */
const themes = ["auto", "light", "dark"];
let theme = store.get("theme", "auto");
const applyTheme = () => { document.documentElement.dataset.theme = theme; };
$("#btnTheme").addEventListener("click", () => {
  theme = themes[(themes.indexOf(theme) + 1) % 3]; store.set("theme", theme); applyTheme();
  toast("テーマ: " + { auto: "自動", light: "ライト", dark: "ダーク" }[theme]);
});
applyTheme();

/* ------------------------------------------------------------ 起動 */
const WELCOME = [
  "# Markdown Editor β へようこそ",
  "",
  "ここは **Notion のように書ける** 編集画面の試作です。記号を覚えなくても書けます。",
  "",
  "## 書き方",
  "",
  "- 行のはじめで「/」を押すと、見出しやリストのメニューが出ます",
  "- 文字を選ぶと、太字やリンクのボタンが浮かびます",
  "- 行の左の ⋮⋮ をつかむと、段落ごと並べ替えられます",
  "- 行のはじめで `- ` `## ` `- [ ] ` のように打つと、その場で箇条書き・見出し・チェックに変わります",
  "",
  "## やること",
  "",
  "- [x] 試作を開く",
  "- [ ] 書き心地を試す",
  "- [ ] 気になったところを伝える",
  "",
  "| 操作 | PC | iPhone |",
  "| --- | --- | --- |",
  "| 保存 | Ctrl + S | 上の保存ボタン |",
  "| 読むだけにする | 上の「表示のみ」 | 上の目のボタン |",
  "| 戻る | Ctrl + Z | 上の戻るボタン |",
  "",
].join("\n");

(async () => {
  if (await openFromHash()) return;
  const d = store.get("draft", null);
  if (d && typeof d.md === "string") {
    doc.fm = d.fm || ""; await openText(d.name || "無題.md", "", null, d.md);
    doc.fm = d.fm || ""; doc.eol = d.eol || "\n";
    toast("保存していない編集を復元しました");
    return;
  }
  await openText("ようこそ.md", WELCOME);
})();
