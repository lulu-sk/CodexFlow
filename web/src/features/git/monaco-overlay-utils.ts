// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type * as MonacoNS from "monaco-editor";

export type MonacoVisibleLineRange = {
  start: number;
  end: number;
};

export type MonacoEditorVerticalSpan = {
  top: number;
  bottom: number;
  center: number;
};

/**
 * 读取编辑器当前可视行范围，避免在不可见区域渲染无意义的叠层控件。
 */
export function resolveVisibleLineRange(
  editor: MonacoNS.editor.IStandaloneCodeEditor,
): MonacoVisibleLineRange | null {
  const ranges = editor.getVisibleRanges();
  if (!ranges || ranges.length === 0) return null;

  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const range of ranges) {
    start = Math.min(start, Math.max(1, range.startLineNumber || 1));
    end = Math.max(end, Math.max(1, range.endLineNumber || range.startLineNumber || 1));
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

/**
 * 判断指定行是否落在当前可视区域附近；额外保留一行缓冲，减少滚动时闪烁。
 */
export function isLineVisible(
  visibleLineRange: MonacoVisibleLineRange | null,
  lineNumber: number,
): boolean {
  if (!visibleLineRange) return false;
  return lineNumber >= visibleLineRange.start - 1 && lineNumber <= visibleLineRange.end + 1;
}

/**
 * 把逻辑行号转换成叠层按钮在根容器中的垂直中心点。
 */
export function resolveEditorAnchorTop(args: {
  rootNode: HTMLElement;
  editor: MonacoNS.editor.IStandaloneCodeEditor;
  lineNumber: number;
}): number | null {
  const { rootNode, editor, lineNumber } = args;
  const model = editor.getModel();
  if (!model) return null;

  const safeLineNumber = Math.max(1, Math.min(model.getLineCount(), Math.floor(Number(lineNumber) || 1)));
  const domNode = editor.getDomNode();
  if (!domNode) return null;

  const visiblePosition = editor.getScrolledVisiblePosition({ lineNumber: safeLineNumber, column: 1 });
  if (!visiblePosition) return null;

  const rootRect = rootNode.getBoundingClientRect();
  const editorRect = domNode.getBoundingClientRect();
  return editorRect.top - rootRect.top + visiblePosition.top + (visiblePosition.height / 2);
}

/**
 * 把一个行范围转换成根容器中的垂直包围盒，供 merge viewer 绘制连接带与空块锚点。
 */
export function resolveEditorVerticalSpan(args: {
  rootNode: HTMLElement;
  editor: MonacoNS.editor.IStandaloneCodeEditor;
  startLine: number;
  endLine: number;
  empty?: boolean;
}): MonacoEditorVerticalSpan | null {
  const { rootNode, editor } = args;
  const model = editor.getModel();
  if (!model) return null;

  const safeStartLine = Math.max(1, Math.min(model.getLineCount(), Math.floor(Number(args.startLine) || 1)));
  const safeEndLine = Math.max(safeStartLine, Math.min(model.getLineCount(), Math.floor(Number(args.endLine) || safeStartLine)));
  const domNode = editor.getDomNode();
  if (!domNode) return null;

  const startPosition = editor.getScrolledVisiblePosition({ lineNumber: safeStartLine, column: 1 });
  const endPosition = editor.getScrolledVisiblePosition({ lineNumber: safeEndLine, column: 1 });
  if (!startPosition || !endPosition) return null;

  const rootRect = rootNode.getBoundingClientRect();
  const editorRect = domNode.getBoundingClientRect();
  const baseTop = editorRect.top - rootRect.top;
  const top = baseTop + startPosition.top;

  if (args.empty) {
    const center = top + (startPosition.height / 2);
    return {
      top: center - 6,
      bottom: center + 6,
      center,
    };
  }

  const bottom = baseTop + endPosition.top + endPosition.height;
  return {
    top,
    bottom,
    center: (top + bottom) / 2,
  };
}
