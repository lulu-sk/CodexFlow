// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitDiffSnapshot } from "../types";
import type {
  PartialCommitSelectableLine,
  PartialCommitSelectionEntry,
  PartialCommitStoredHunk,
} from "./types";
import {
  buildStoredPartialCommitHunk,
  countSelectedPartialCommitLines,
  getPartialCommitSelectedLineKeys,
} from "./partial-commit-lines";

export type PartialCommitDiffControlSide = "original" | "modified";

export type PartialCommitDiffHunkControlState = "full" | "partial" | "excluded";

export type PartialCommitDiffHunkControl = {
  hunkId: string;
  anchorSide: PartialCommitDiffControlSide;
  anchorLineNumber: number;
  focusLineNumber: number;
  selectionState: PartialCommitDiffHunkControlState;
  selectedLineCount: number;
  totalLineCount: number;
};

export type PartialCommitDiffLineControl = {
  key: string;
  hunkId: string;
  side: PartialCommitDiffControlSide;
  lineNumber: number;
  lineKey: string;
  included: boolean;
};

export type PartialCommitDiffControls = {
  hunkControls: PartialCommitDiffHunkControl[];
  lineControls: PartialCommitDiffLineControl[];
};

/**
 * 优先从已同步的 partial entry 读取 hunk 快照；缺失时再回退到当前 Diff hunk。
 */
function resolveStoredHunk(
  entry: PartialCommitSelectionEntry | null | undefined,
  hunkId: string,
  fallbackHunk: PartialCommitStoredHunk,
): PartialCommitStoredHunk {
  const cleanHunkId = String(hunkId || "").trim();
  return entry?.hunksById[cleanHunkId] || fallbackHunk;
}

/**
 * 为 Diff 内块级复选框选择最靠前、最稳定的锚点行。
 */
function resolveHunkAnchor(
  hunk: PartialCommitStoredHunk,
): { anchorSide: PartialCommitDiffControlSide; anchorLineNumber: number } {
  const firstAddedLine = hunk.selectableLines.find((line) => line.kind === "add" && !!line.newLineNumber);
  if (firstAddedLine?.newLineNumber) {
    return {
      anchorSide: "modified",
      anchorLineNumber: firstAddedLine.newLineNumber,
    };
  }

  const firstDeletedLine = hunk.selectableLines.find((line) => line.kind === "del" && !!line.oldLineNumber);
  if (firstDeletedLine?.oldLineNumber) {
    return {
      anchorSide: "original",
      anchorLineNumber: firstDeletedLine.oldLineNumber,
    };
  }

  if (hunk.newStart > 0) {
    return {
      anchorSide: "modified",
      anchorLineNumber: hunk.newStart,
    };
  }

  return {
    anchorSide: "original",
    anchorLineNumber: Math.max(1, hunk.oldStart || 1),
  };
}

/**
 * 把单行 changed line 规整为 Diff 叠层所需的侧别与行号。
 */
function buildPartialCommitDiffLineControl(
  hunkId: string,
  selectableLine: PartialCommitSelectableLine,
  included: boolean,
): PartialCommitDiffLineControl | null {
  if (selectableLine.kind === "add" && selectableLine.newLineNumber) {
    return {
      key: `${hunkId}:${selectableLine.key}`,
      hunkId,
      side: "modified",
      lineNumber: selectableLine.newLineNumber,
      lineKey: selectableLine.key,
      included,
    };
  }

  if (selectableLine.kind === "del" && selectableLine.oldLineNumber) {
    return {
      key: `${hunkId}:${selectableLine.key}`,
      hunkId,
      side: "original",
      lineNumber: selectableLine.oldLineNumber,
      lineKey: selectableLine.key,
      included,
    };
  }

  return null;
}

/**
 * 把 hunk 当前已选行数规整为统一的块级选择态，供 Diff 内复选框复用。
 */
function resolveHunkSelectionState(
  selectedLineCount: number,
  totalLineCount: number,
): PartialCommitDiffHunkControlState {
  if (selectedLineCount <= 0) return "excluded";
  if (selectedLineCount >= totalLineCount) return "full";
  return "partial";
}

/**
 * 按当前 partial selection 生成 Diff 内的块级/行级控件描述。
 */
export function buildPartialCommitDiffControls(
  diff: GitDiffSnapshot | null | undefined,
  entry: PartialCommitSelectionEntry | null | undefined,
): PartialCommitDiffControls {
  const hunkControls: PartialCommitDiffHunkControl[] = [];
  const lineControls: PartialCommitDiffLineControl[] = [];

  for (const diffHunk of diff?.hunks || []) {
    const hunkId = String(diffHunk.id || "").trim();
    if (!hunkId) continue;
    const storedHunk = resolveStoredHunk(entry, hunkId, buildStoredPartialCommitHunk(diffHunk));
    const totalLineCount = storedHunk.selectableLines.length;
    const selectedLineKeys = entry
      ? getPartialCommitSelectedLineKeys(entry, hunkId)
      : storedHunk.selectableLines.map((line) => line.key);
    const selectedLineKeySet = new Set(selectedLineKeys);
    const selectedLineCount = entry
      ? countSelectedPartialCommitLines(entry, hunkId)
      : totalLineCount;
    const selectionState = resolveHunkSelectionState(selectedLineCount, totalLineCount);
    const { anchorSide, anchorLineNumber } = resolveHunkAnchor(storedHunk);

    hunkControls.push({
      hunkId,
      anchorSide,
      anchorLineNumber,
      focusLineNumber: anchorLineNumber,
      selectionState,
      selectedLineCount,
      totalLineCount,
    });

    for (const selectableLine of storedHunk.selectableLines) {
      const lineControl = buildPartialCommitDiffLineControl(hunkId, selectableLine, selectedLineKeySet.has(selectableLine.key));
      if (lineControl) lineControls.push(lineControl);
    }
  }

  return {
    hunkControls,
    lineControls,
  };
}
