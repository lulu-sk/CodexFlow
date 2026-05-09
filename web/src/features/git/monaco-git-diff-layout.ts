// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type * as MonacoNS from "monaco-editor";

export type MonacoGitDiffCheckboxLayoutInfo = Pick<
  MonacoNS.editor.EditorLayoutInfo,
  "glyphMarginLeft" | "glyphMarginWidth" | "lineNumbersLeft"
>;

/**
 * 计算 partial commit 复选框在单侧编辑器内的水平偏移，优先占用行号前的 glyph margin。
 */
export function resolveCheckboxGutterOffset(args: {
  layoutInfo: MonacoGitDiffCheckboxLayoutInfo;
  controlWidth: number;
}): number {
  const { layoutInfo, controlWidth } = args;
  const glyphMarginWidth = Math.max(0, layoutInfo.glyphMarginWidth);
  if (glyphMarginWidth >= controlWidth) {
    return layoutInfo.glyphMarginLeft + Math.floor((glyphMarginWidth - controlWidth) / 2);
  }
  return Math.max(0, layoutInfo.lineNumbersLeft - controlWidth - 2);
}
