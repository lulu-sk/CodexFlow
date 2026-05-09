// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitDiffEditorSelection, GitDiffHunk, GitDiffLineDecorations, GitDiffSnapshot } from "../types";
import type {
  PartialCommitSelectableLine,
  PartialCommitSelectionEntry,
  PartialCommitStoredHunk,
} from "./types";

export type PartialCommitAffectedLineSelection = {
  affectedLineKeysByHunkId: Record<string, string[]>;
  affectedLineCount: number;
  affectedHunkCount: number;
  hasExplicitSelection: boolean;
  focusLine?: number;
};

export type PartialCommitAffectedLineSelectionState = {
  hasIncluded: boolean;
  hasExcluded: boolean;
};

/**
 * 移除 diff 行内容里的 unified marker，统一还原成真实文本内容。
 */
function stripDiffLineMarker(kind: "context" | "add" | "del", content: string): string {
  const raw = String(content || "");
  if (kind === "context" && raw.startsWith(" ")) return raw.slice(1);
  if (kind === "add" && raw.startsWith("+")) return raw.slice(1);
  if (kind === "del" && raw.startsWith("-")) return raw.slice(1);
  return raw;
}

/**
 * 为 hunk 内可选 changed line 生成稳定键，供 refresh 前后复用。
 */
export function buildPartialCommitLineKey(args: {
  kind: "add" | "del";
  lineIndex: number;
  oldLineNumber?: number;
  newLineNumber?: number;
}): string {
  return [
    args.kind,
    Math.max(0, Math.floor(Number(args.lineIndex) || 0)),
    Math.max(0, Math.floor(Number(args.oldLineNumber) || 0)),
    Math.max(0, Math.floor(Number(args.newLineNumber) || 0)),
  ].join(":");
}

/**
 * 从单个 hunk 中提取真正可做 partial commit 的 changed line 列表。
 */
export function buildSelectableLinesForHunk(hunk: GitDiffHunk): PartialCommitSelectableLine[] {
  const out: PartialCommitSelectableLine[] = [];
  (hunk.lines || []).forEach((line, lineIndex) => {
    if (line.kind !== "add" && line.kind !== "del") return;
    out.push({
      key: buildPartialCommitLineKey({
        kind: line.kind,
        lineIndex,
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
      }),
      kind: line.kind,
      lineIndex,
      content: stripDiffLineMarker(line.kind, line.content),
      oldLineNumber: line.oldLineNumber,
      newLineNumber: line.newLineNumber,
    });
  });
  return out;
}

/**
 * 把 Diff hunk 规整为 partial commit 状态可直接存储的最小快照。
 */
export function buildStoredPartialCommitHunk(hunk: GitDiffHunk): PartialCommitStoredHunk {
  return {
    id: hunk.id,
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    patch: hunk.patch,
    lines: hunk.lines,
    selectableLines: buildSelectableLinesForHunk(hunk),
  };
}

/**
 * 按 hunk 当前 selectable line 集规整已选 line key，过滤掉失效项并保留声明顺序。
 */
export function normalizeSelectedLineKeys(hunk: PartialCommitStoredHunk | null | undefined, selectedLineKeys: string[]): string[] {
  if (!hunk) return [];
  const allowed = new Set(hunk.selectableLines.map((line) => line.key));
  const out: string[] = [];
  for (const lineKey of selectedLineKeys) {
    const cleanKey = String(lineKey || "").trim();
    if (!cleanKey || !allowed.has(cleanKey) || out.includes(cleanKey)) continue;
    out.push(cleanKey);
  }
  return out;
}

/**
 * 读取指定 hunk 当前已选的 changed line；若未显式记录，则按全选处理。
 */
export function getPartialCommitSelectedLineKeys(
  entry: PartialCommitSelectionEntry | null | undefined,
  hunkId: string,
): string[] {
  const cleanHunkId = String(hunkId || "").trim();
  if (!entry || !cleanHunkId) return [];
  const hunk = entry.hunksById[cleanHunkId];
  if (!hunk) return [];
  if (!entry.selectedHunkIds.includes(cleanHunkId)) return [];
  const stored = entry.selectedLineKeysByHunkId[cleanHunkId];
  if (!Array.isArray(stored) || stored.length === 0) {
    return hunk.selectableLines.map((line) => line.key);
  }
  return normalizeSelectedLineKeys(hunk, stored);
}

/**
 * 判断指定 hunk 是否保持“整块纳入”状态。
 */
export function isPartialCommitHunkFullySelected(
  entry: PartialCommitSelectionEntry | null | undefined,
  hunkId: string,
): boolean {
  const cleanHunkId = String(hunkId || "").trim();
  if (!entry || !cleanHunkId) return false;
  const hunk = entry.hunksById[cleanHunkId];
  if (!hunk) return false;
  if (!entry.selectedHunkIds.includes(cleanHunkId)) return false;
  return getPartialCommitSelectedLineKeys(entry, cleanHunkId).length >= hunk.selectableLines.length;
}

/**
 * 统计指定文件当前被纳入提交的 changed line 数量；未传 hunk 时统计整文件。
 */
export function countSelectedPartialCommitLines(
  entry: PartialCommitSelectionEntry | null | undefined,
  hunkId?: string,
): number {
  if (!entry) return 0;
  if (hunkId) return getPartialCommitSelectedLineKeys(entry, hunkId).length;
  return entry.allHunkIds.reduce((sum, currentHunkId) => sum + getPartialCommitSelectedLineKeys(entry, currentHunkId).length, 0);
}

/**
 * 判断当前 entry 是否仍处于“全文件全行纳入”的整文件语义。
 */
export function isPartialCommitEntryFullySelected(entry: PartialCommitSelectionEntry | null | undefined): boolean {
  if (!entry) return true;
  if (entry.selectedHunkIds.length < entry.allHunkIds.length) return false;
  return entry.allHunkIds.every((hunkId) => isPartialCommitHunkFullySelected(entry, hunkId));
}

/**
 * 把 unified range 规整成合法的 hunk 头格式。
 */
function formatUnifiedRange(start: number, lineCount: number): string {
  const safeStart = Math.max(0, Math.floor(Number(start) || 0));
  const safeLineCount = Math.max(0, Math.floor(Number(lineCount) || 0));
  return `${safeStart},${safeLineCount}`;
}

/**
 * 构造单个 hunk 在当前 line selection 下真正应写入 patch 的 body 与净行数变化。
 */
function buildSelectedHunkPatchBody(hunk: PartialCommitStoredHunk, selectedLineKeySet: Set<string>): {
  bodyLines: string[];
  hasAnyChange: boolean;
  selectedDelta: number;
} {
  const selectableLineByIndex = new Map<number, PartialCommitSelectableLine>();
  for (const selectableLine of hunk.selectableLines) {
    selectableLineByIndex.set(selectableLine.lineIndex, selectableLine);
  }

  const bodyLines: string[] = [];
  let hasAnyChange = false;
  for (let index = 0; index < (hunk.lines || []).length; index += 1) {
    const line = hunk.lines[index]!;
    if (line.kind === "context") {
      bodyLines.push(` ${stripDiffLineMarker("context", line.content)}`);
      continue;
    }

    const selectableLine = selectableLineByIndex.get(index);
    const lineKey = selectableLine?.key || "";
    const selected = !!lineKey && selectedLineKeySet.has(lineKey);
    if (line.kind === "del") {
      if (selected) {
        bodyLines.push(`-${stripDiffLineMarker("del", line.content)}`);
        hasAnyChange = true;
      } else {
        bodyLines.push(` ${stripDiffLineMarker("del", line.content)}`);
      }
      continue;
    }

    if (selected) {
      bodyLines.push(`+${stripDiffLineMarker("add", line.content)}`);
      hasAnyChange = true;
    }
  }

  const selectedNewLineCount = bodyLines.reduce((sum, lineText) => sum + (lineText.startsWith("-") ? 0 : 1), 0);
  return {
    bodyLines,
    hasAnyChange,
    selectedDelta: selectedNewLineCount - Math.max(0, Math.floor(Number(hunk.oldLines) || 0)),
  };
}

/**
 * 按当前 hunk/line 选择状态生成真正可提交的 unified patch。
 */
export function buildPartialCommitPatch(entry: PartialCommitSelectionEntry | null | undefined): string {
  if (!entry) return "";
  let cumulativeShift = 0;
  const patchChunks: string[] = [];
  for (const hunkId of entry.allHunkIds) {
    const hunk = entry.hunksById[hunkId];
    if (!hunk) continue;
    const selectedLineKeySet = new Set(getPartialCommitSelectedLineKeys(entry, hunkId));
    const selectedBody = buildSelectedHunkPatchBody(hunk, selectedLineKeySet);
    const originalDelta = Math.max(0, Math.floor(Number(hunk.newLines) || 0)) - Math.max(0, Math.floor(Number(hunk.oldLines) || 0));
    if (selectedBody.hasAnyChange) {
      const selectedNewLineCount = Math.max(0, Math.floor(Number(hunk.oldLines) || 0)) + selectedBody.selectedDelta;
      const selectedNewStart = Math.max(0, Math.floor(Number(hunk.newStart) || 0) + cumulativeShift);
      patchChunks.push(
        `${hunk.header.replace(
          /^@@ -[^ ]+ \+[^ ]+ @@/,
          `@@ -${formatUnifiedRange(hunk.oldStart, hunk.oldLines)} +${formatUnifiedRange(selectedNewStart, selectedNewLineCount)} @@`,
        )}\n${selectedBody.bodyLines.join("\n")}\n`,
      );
    }
    cumulativeShift += selectedBody.selectedDelta - originalDelta;
  }
  if (patchChunks.length === 0) return "";
  return `${entry.patchHeader}${patchChunks.join("")}`;
}

/**
 * 把当前 partial selection 转成 Monaco 所需的 excluded line 装饰数据。
 */
export function buildPartialCommitLineDecorations(
  diff: GitDiffSnapshot | null | undefined,
  entry: PartialCommitSelectionEntry | null | undefined,
): GitDiffLineDecorations {
  const excludedOriginalLines = new Set<number>();
  const excludedModifiedLines = new Set<number>();
  for (const hunk of diff?.hunks || []) {
    const storedHunk = entry?.hunksById[String(hunk.id || "").trim()] || buildStoredPartialCommitHunk(hunk);
    const selectedLineKeySet = new Set(getPartialCommitSelectedLineKeys(entry, hunk.id));
    for (const selectableLine of storedHunk.selectableLines) {
      if (selectedLineKeySet.has(selectableLine.key)) continue;
      if (selectableLine.kind === "del" && selectableLine.oldLineNumber) excludedOriginalLines.add(selectableLine.oldLineNumber);
      if (selectableLine.kind === "add" && selectableLine.newLineNumber) excludedModifiedLines.add(selectableLine.newLineNumber);
    }
  }
  return {
    excludedOriginalLines: Array.from(excludedOriginalLines).sort((left, right) => left - right),
    excludedModifiedLines: Array.from(excludedModifiedLines).sort((left, right) => left - right),
  };
}

/**
 * 将 Monaco 当前选中行/光标行映射为 partial commit 可消费的 changed line 集合。
 */
export function resolvePartialCommitAffectedLineSelection(
  diff: GitDiffSnapshot | null | undefined,
  selection: GitDiffEditorSelection | null | undefined,
): PartialCommitAffectedLineSelection {
  const originalSelectedLines = Array.isArray(selection?.originalSelectedLines)
    ? selection!.originalSelectedLines.map((line) => Math.max(1, Math.floor(Number(line) || 0))).filter(Boolean)
    : [];
  const modifiedSelectedLines = Array.isArray(selection?.modifiedSelectedLines)
    ? selection!.modifiedSelectedLines.map((line) => Math.max(1, Math.floor(Number(line) || 0))).filter(Boolean)
    : [];
  const hasExplicitSelection = originalSelectedLines.length > 0 || modifiedSelectedLines.length > 0;
  const focusSide = selection?.focusSide || null;
  const originalActiveLines = !hasExplicitSelection && focusSide === "original" && Number.isFinite(selection?.originalActiveLine)
    ? [Math.max(1, Math.floor(Number(selection?.originalActiveLine) || 0))]
    : [];
  const modifiedActiveLines = !hasExplicitSelection && focusSide === "modified" && Number.isFinite(selection?.modifiedActiveLine)
    ? [Math.max(1, Math.floor(Number(selection?.modifiedActiveLine) || 0))]
    : [];
  const originalLineSet = new Set<number>([...originalSelectedLines, ...originalActiveLines]);
  const modifiedLineSet = new Set<number>([...modifiedSelectedLines, ...modifiedActiveLines]);

  const affectedLineKeysByHunkId: Record<string, string[]> = {};
  let affectedLineCount = 0;
  let focusLine = Number.POSITIVE_INFINITY;
  for (const hunk of diff?.hunks || []) {
    const selectableLines = buildSelectableLinesForHunk(hunk);
    const affectedLineKeys: string[] = [];
    for (const selectableLine of selectableLines) {
      const matched = selectableLine.kind === "del"
        ? !!selectableLine.oldLineNumber && originalLineSet.has(selectableLine.oldLineNumber)
        : !!selectableLine.newLineNumber && modifiedLineSet.has(selectableLine.newLineNumber);
      if (!matched) continue;
      affectedLineKeys.push(selectableLine.key);
      const candidateLine = selectableLine.newLineNumber || selectableLine.oldLineNumber || Number.POSITIVE_INFINITY;
      focusLine = Math.min(focusLine, candidateLine);
    }
    if (affectedLineKeys.length === 0) continue;
    affectedLineKeysByHunkId[String(hunk.id || "").trim()] = affectedLineKeys;
    affectedLineCount += affectedLineKeys.length;
  }

  return {
    affectedLineKeysByHunkId,
    affectedLineCount,
    affectedHunkCount: Object.keys(affectedLineKeysByHunkId).length,
    hasExplicitSelection,
    focusLine: Number.isFinite(focusLine) ? focusLine : undefined,
  };
}

/**
 * 统计当前受影响 changed line 集中，哪些行已纳入提交、哪些行仍被排除。
 */
export function resolvePartialCommitAffectedLineSelectionState(
  entry: PartialCommitSelectionEntry | null | undefined,
  affectedLineKeysByHunkId: Record<string, string[]>,
): PartialCommitAffectedLineSelectionState {
  let hasIncluded = false;
  let hasExcluded = false;
  for (const [hunkId, lineKeys] of Object.entries(affectedLineKeysByHunkId)) {
    const selectedLineKeySet = new Set(getPartialCommitSelectedLineKeys(entry, hunkId));
    for (const lineKey of lineKeys) {
      if (selectedLineKeySet.has(lineKey)) hasIncluded = true;
      else hasExcluded = true;
      if (hasIncluded && hasExcluded) return { hasIncluded, hasExcluded };
    }
  }
  return { hasIncluded, hasExcluded };
}
