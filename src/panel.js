/* ============================================================================
 *  PC の編集パネル（左）: 書式ボタンと目次
 *  中身の操作は、部品の書式バー（Crepe の TopBar）と同じコマンドを呼ぶ
 * ==========================================================================*/
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import {
  toggleStrongCommand, strongSchema, toggleEmphasisCommand, emphasisSchema,
  toggleInlineCodeCommand, inlineCodeSchema, linkSchema,
  bulletListSchema, orderedListSchema, listItemSchema, blockquoteSchema, hrSchema,
  codeBlockSchema, paragraphSchema, headingSchema,
  wrapInBlockTypeCommand, addBlockTypeCommand, setBlockTypeCommand, selectTextNearPosCommand,
  isMarkSelectedCommand, sinkListItemCommand, liftListItemCommand,
} from "@milkdown/kit/preset/commonmark";
import { toggleStrikethroughCommand, strikethroughSchema, createTable } from "@milkdown/kit/preset/gfm";
import { toggleLinkCommand } from "@milkdown/kit/component/link-tooltip";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";

const call = (ctx, cmd, payload) => ctx.get(commandsCtx).call(cmd.key, payload);

function markActive(ctx, type) {
  if (call(ctx, isMarkSelectedCommand, type)) return true;
  const { state } = ctx.get(editorViewCtx);
  if (state.storedMarks) return state.storedMarks.some(m => m.type === type);
  const $c = state.selection.$cursor;
  return $c ? $c.marks().some(m => m.type === type) : false;
}

/* カーソルが空のときは「これから打つ文字」に効かせる（部品の書式バーと同じ動き） */
function toggleMark(ctx, schema, cmd) {
  const view = ctx.get(editorViewCtx), { state } = view, type = schema.type(ctx);
  if (state.selection.empty) {
    view.dispatch(markActive(ctx, type) ? state.tr.removeStoredMark(type) : state.tr.addStoredMark(type.create()));
  } else call(ctx, cmd);
}

/* 今カーソルがある段落の種類（0 = 本文、1〜6 = 見出し） */
export function headingLevel(ctx) {
  const { $from } = ctx.get(editorViewCtx).state.selection;
  const n = $from.parent;
  return n.type === headingSchema.type(ctx) ? n.attrs.level : 0;
}
export function setHeading(ctx, level) {
  if (!level) call(ctx, setBlockTypeCommand, { nodeType: paragraphSchema.type(ctx) });
  else call(ctx, setBlockTypeCommand, { nodeType: headingSchema.type(ctx), attrs: { level } });
}

/* ---- 字下げ（箇条書き・番号・チェックの項目を1段下げる / 上げる） */
export function inList(ctx) {
  const { $from } = ctx.get(editorViewCtx).state.selection, li = listItemSchema.type(ctx);
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === li) return true;
  return false;
}
export const inCode = ctx => ctx.get(editorViewCtx).state.selection.$from.parent.type === codeBlockSchema.type(ctx);
/* 下げられなかった理由を返す（下げられたら null） */
export function indent(ctx, back) {
  if (!inList(ctx)) return "字下げは、箇条書き・番号付き・チェックの中で使えます";
  if (back) return call(ctx, liftListItemCommand) ? null : "";
  return call(ctx, sinkListItemCommand) ? null : "上の項目より1段深くまでしか下げられません";
}

export const ACTIONS = {
  bold:   { run: ctx => toggleMark(ctx, strongSchema, toggleStrongCommand), active: ctx => markActive(ctx, strongSchema.type(ctx)) },
  italic: { run: ctx => toggleMark(ctx, emphasisSchema, toggleEmphasisCommand), active: ctx => markActive(ctx, emphasisSchema.type(ctx)) },
  strike: { run: ctx => toggleMark(ctx, strikethroughSchema, toggleStrikethroughCommand), active: ctx => markActive(ctx, strikethroughSchema.type(ctx)) },
  code:   { run: ctx => toggleMark(ctx, inlineCodeSchema, toggleInlineCodeCommand), active: ctx => markActive(ctx, inlineCodeSchema.type(ctx)) },
  link: {
    run: ctx => {
      const view = ctx.get(editorViewCtx), type = linkSchema.type(ctx);
      if (view.state.selection.empty && markActive(ctx, type)) view.dispatch(view.state.tr.removeStoredMark(type));
      else call(ctx, toggleLinkCommand);
    },
    active: ctx => markActive(ctx, linkSchema.type(ctx)),
  },
  ul:    { run: ctx => call(ctx, wrapInBlockTypeCommand, { nodeType: bulletListSchema.type(ctx) }) },
  ol:    { run: ctx => call(ctx, wrapInBlockTypeCommand, { nodeType: orderedListSchema.type(ctx) }) },
  task:  { run: ctx => call(ctx, wrapInBlockTypeCommand, { nodeType: listItemSchema.type(ctx), attrs: { checked: false } }) },
  quote: { run: ctx => call(ctx, wrapInBlockTypeCommand, { nodeType: blockquoteSchema.type(ctx) }) },
  hr:    { run: ctx => call(ctx, addBlockTypeCommand, { nodeType: hrSchema.type(ctx) }) },
  codeblock: { run: ctx => call(ctx, setBlockTypeCommand, { nodeType: codeBlockSchema.type(ctx) }) },
  image: { run: ctx => call(ctx, addBlockTypeCommand, { nodeType: imageBlockSchema.type(ctx) }) },
  table: {
    run: ctx => {
      const { from } = ctx.get(editorViewCtx).state.selection;
      call(ctx, addBlockTypeCommand, { nodeType: createTable(ctx, 3, 3) });
      call(ctx, selectTextNearPosCommand, { pos: from });
    },
  },
};
