// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitDiffSnapshot } from "../types";
import type {
  CommitInclusionItem,
  CommitWorkflowSelectionItem,
  PartialCommitSelectionEntry,
  PartialCommitSelectionState,
  PartialCommitStoredHunk,
} from "./types";
import { buildCommitInclusionLookupKey, normalizeCommitRepoRoot } from "./inclusion-model";
import {
  buildPartialCommitPatch,
  buildStoredPartialCommitHunk,
  countSelectedPartialCommitLines,
  getPartialCommitSelectedLineKeys,
  isPartialCommitEntryFullySelected,
  normalizeSelectedLineKeys,
} from "./partial-commit-lines";

type SyncPartialCommitSelectionArgs = {
  path: string;
  repoRoot: string;
  changeListId: string;
  snapshot: GitDiffSnapshot | null | undefined;
};

type SyncPartialCommitSelectionResult = {
  state: PartialCommitSelectionState;
  invalidatedPath?: string;
};

/**
 * 将路径规整为 partial commit 状态使用的稳定键。
 */
function normalizePartialCommitPath(pathText: string): string {
  return String(pathText || "").trim().replace(/\\/g, "/");
}

/**
 * 按“仓库根 + 相对路径”为 partial commit 条目生成稳定键，避免多仓同路径互相覆盖。
 */
export function buildPartialCommitStateKey(pathText: string, repoRoot?: string): string {
  return buildCommitInclusionLookupKey(normalizePartialCommitPath(pathText), normalizeCommitRepoRoot(repoRoot));
}

/**
 * 按给定路径优先解析精确仓根键；旧调用点未传 repoRoot 时，允许在唯一命中路径时回退到兼容键。
 */
function resolvePartialCommitStateKey(
  state: PartialCommitSelectionState,
  pathText: string,
  repoRoot?: string,
): string {
  const exactKey = buildPartialCommitStateKey(pathText, repoRoot);
  if (exactKey && state.entriesByPath[exactKey]) return exactKey;
  if (repoRoot) return exactKey;

  const cleanPath = normalizePartialCommitPath(pathText);
  const matchedKeys = Object.keys(state.entriesByPath).filter((key) => state.entriesByPath[key]?.path === cleanPath);
  if (matchedKeys.length === 1) return matchedKeys[0]!;
  return exactKey;
}

/**
 * 创建空的 partial commit 选择状态。
 */
export function createPartialCommitSelectionState(): PartialCommitSelectionState {
  return {
    entriesByPath: {},
  };
}

/**
 * 读取指定路径的 partial commit 状态；路径不存在时返回空值。
 */
export function getPartialCommitSelectionEntry(
  state: PartialCommitSelectionState,
  pathText: string,
  repoRoot?: string,
): PartialCommitSelectionEntry | null {
  const pathKey = resolvePartialCommitStateKey(state, pathText, repoRoot);
  if (!pathKey) return null;
  return state.entriesByPath[pathKey] || null;
}

/**
 * 判断指定路径是否处于“部分提交”状态；只要未纳入内容不是完整文件，就视为激活。
 */
export function isPartialCommitSelectionActive(
  state: PartialCommitSelectionState,
  pathText: string,
  repoRoot?: string,
): boolean {
  const entry = getPartialCommitSelectionEntry(state, pathText, repoRoot);
  if (!entry) return false;
  return countSelectedPartialCommitLines(entry) > 0 && !isPartialCommitEntryFullySelected(entry);
}

/**
 * 按当前 hunk 集校正已选 hunk 列表，避免快照刷新后残留无效 hunk id。
 */
function normalizeSelectedHunkIds(allHunkIds: string[], selectedHunkIds: string[]): string[] {
  const allowed = new Set(allHunkIds);
  const out: string[] = [];
  for (const hunkId of selectedHunkIds) {
    const cleanId = String(hunkId || "").trim();
    if (!cleanId || !allowed.has(cleanId) || out.includes(cleanId)) continue;
    out.push(cleanId);
  }
  return out;
}

/**
 * 把 Diff 快照中的 hunk 列表规整为按 id 可直接寻址的稳定快照字典。
 */
function buildHunksById(snapshot: GitDiffSnapshot): Record<string, PartialCommitStoredHunk> {
  const out: Record<string, PartialCommitStoredHunk> = {};
  for (const hunk of snapshot.hunks || []) {
    const hunkId = String(hunk.id || "").trim();
    if (!hunkId) continue;
    out[hunkId] = buildStoredPartialCommitHunk(hunk);
  }
  return out;
}

/**
 * 展开指定 hunk 全量纳入提交时应包含的全部 changed line key。
 */
function listAllHunkLineKeys(hunk: PartialCommitStoredHunk | null | undefined): string[] {
  if (!hunk) return [];
  return hunk.selectableLines.map((line) => line.key);
}

/**
 * 按当前 hunk 快照同步 selected line key，确保 refresh 后不会残留失效行。
 */
function syncSelectedLineKeysByHunkId(
  previousEntry: PartialCommitSelectionEntry | null,
  hunksById: Record<string, PartialCommitStoredHunk>,
  selectedHunkIds: string[],
  keepPreviousSelection: boolean,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const hunkId of selectedHunkIds) {
    const hunk = hunksById[hunkId];
    if (!hunk) continue;
    const selectedLineKeys = keepPreviousSelection
      ? normalizeSelectedLineKeys(hunk, previousEntry?.selectedLineKeysByHunkId[hunkId] || listAllHunkLineKeys(hunk))
      : listAllHunkLineKeys(hunk);
    out[hunkId] = selectedLineKeys.length > 0 ? selectedLineKeys : listAllHunkLineKeys(hunk);
  }
  return out;
}

/**
 * 把最新 Diff 快照同步到 partial commit 模型。
 * - 指纹未变时保留用户已选 hunk/line；
 * - 指纹变化且之前存在真正 partial 选区时，显式失效并回退；
 * - 没有可用 hunk 时移除该路径的 partial 状态。
 */
export function syncPartialCommitSelectionWithSnapshot(
  prev: PartialCommitSelectionState,
  args: SyncPartialCommitSelectionArgs,
): SyncPartialCommitSelectionResult {
  const cleanPath = normalizePartialCommitPath(args.path || args.snapshot?.path || "");
  const pathKey = buildPartialCommitStateKey(cleanPath, args.repoRoot);
  if (!pathKey) return { state: prev };

  const nextEntriesByPath = { ...prev.entriesByPath };
  const previousEntry = nextEntriesByPath[pathKey] || null;
  const snapshot = args.snapshot || null;
  const fingerprint = String(snapshot?.fingerprint || "").trim();
  const patchHeader = String(snapshot?.patchHeader || "");
  const allHunkIds = (snapshot?.hunks || []).map((hunk) => String(hunk.id || "").trim()).filter(Boolean);

  if (!snapshot || !fingerprint || !patchHeader || allHunkIds.length === 0) {
    if (previousEntry) delete nextEntriesByPath[pathKey];
    return {
      state: { entriesByPath: nextEntriesByPath },
      invalidatedPath: previousEntry && !isPartialCommitEntryFullySelected(previousEntry) ? cleanPath : undefined,
    };
  }

  if (previousEntry && previousEntry.snapshotFingerprint !== fingerprint && !isPartialCommitEntryFullySelected(previousEntry)) {
    delete nextEntriesByPath[pathKey];
    return {
      state: { entriesByPath: nextEntriesByPath },
      invalidatedPath: cleanPath,
    };
  }

  const keepPreviousSelection = !!previousEntry && previousEntry.snapshotFingerprint === fingerprint;
  const selectedHunkIds = keepPreviousSelection
    ? normalizeSelectedHunkIds(allHunkIds, previousEntry.selectedHunkIds)
    : allHunkIds;
  const hunksById = buildHunksById(snapshot);

  nextEntriesByPath[pathKey] = {
    path: cleanPath,
    repoRoot: normalizeCommitRepoRoot(args.repoRoot || previousEntry?.repoRoot),
    changeListId: String(args.changeListId || previousEntry?.changeListId || "default").trim() || "default",
    diffMode: snapshot.mode === "staged" ? "staged" : "working",
    snapshotFingerprint: fingerprint,
    patchHeader,
    allHunkIds,
    selectedHunkIds,
    hunksById,
    selectedLineKeysByHunkId: syncSelectedLineKeysByHunkId(previousEntry, hunksById, selectedHunkIds, keepPreviousSelection),
  };
  return {
    state: { entriesByPath: nextEntriesByPath },
  };
}

/**
 * 按单个 hunk 切换 partial commit 选区；整块选中时同步恢复全部 changed line。
 */
export function setPartialCommitHunkSelected(
  prev: PartialCommitSelectionState,
  pathText: string,
  hunkId: string,
  selected: boolean,
  repoRoot?: string,
): PartialCommitSelectionState {
  const pathKey = resolvePartialCommitStateKey(prev, pathText, repoRoot);
  const entry = pathKey ? prev.entriesByPath[pathKey] : null;
  if (!entry) return prev;

  const cleanHunkId = String(hunkId || "").trim();
  const hunk = entry.hunksById[cleanHunkId];
  if (!cleanHunkId || !hunk) return prev;

  const nextSelected = new Set(entry.selectedHunkIds);
  const nextSelectedLineKeysByHunkId = { ...entry.selectedLineKeysByHunkId };
  if (selected) {
    nextSelected.add(cleanHunkId);
    nextSelectedLineKeysByHunkId[cleanHunkId] = listAllHunkLineKeys(hunk);
  } else {
    nextSelected.delete(cleanHunkId);
    delete nextSelectedLineKeysByHunkId[cleanHunkId];
  }

  return {
    entriesByPath: {
      ...prev.entriesByPath,
      [pathKey]: {
        ...entry,
        selectedHunkIds: normalizeSelectedHunkIds(entry.allHunkIds, Array.from(nextSelected)),
        selectedLineKeysByHunkId: nextSelectedLineKeysByHunkId,
      },
    },
  };
}

/**
 * 按当前 Diff 命中的 changed line 集批量切换纳入状态；hunk 为空时自动回退为未选中。
 */
export function setPartialCommitLineKeysSelected(
  prev: PartialCommitSelectionState,
  pathText: string,
  lineKeysByHunkId: Record<string, string[]>,
  selected: boolean,
  repoRoot?: string,
): PartialCommitSelectionState {
  const pathKey = resolvePartialCommitStateKey(prev, pathText, repoRoot);
  const entry = pathKey ? prev.entriesByPath[pathKey] : null;
  if (!entry) return prev;

  const nextSelectedHunkIds = new Set(entry.selectedHunkIds);
  const nextSelectedLineKeysByHunkId = { ...entry.selectedLineKeysByHunkId };
  for (const [hunkId, lineKeys] of Object.entries(lineKeysByHunkId)) {
    const cleanHunkId = String(hunkId || "").trim();
    const hunk = entry.hunksById[cleanHunkId];
    if (!cleanHunkId || !hunk) continue;
    const nextSelectedLineKeys = new Set(getPartialCommitSelectedLineKeys(entry, cleanHunkId));
    for (const lineKey of lineKeys) {
      const cleanLineKey = String(lineKey || "").trim();
      if (!cleanLineKey) continue;
      if (selected) nextSelectedLineKeys.add(cleanLineKey);
      else nextSelectedLineKeys.delete(cleanLineKey);
    }
    const normalizedSelectedLineKeys = normalizeSelectedLineKeys(hunk, Array.from(nextSelectedLineKeys));
    if (normalizedSelectedLineKeys.length > 0) {
      nextSelectedHunkIds.add(cleanHunkId);
      nextSelectedLineKeysByHunkId[cleanHunkId] = normalizedSelectedLineKeys;
    } else {
      nextSelectedHunkIds.delete(cleanHunkId);
      delete nextSelectedLineKeysByHunkId[cleanHunkId];
    }
  }

  return {
    entriesByPath: {
      ...prev.entriesByPath,
      [pathKey]: {
        ...entry,
        selectedHunkIds: normalizeSelectedHunkIds(entry.allHunkIds, Array.from(nextSelectedHunkIds)),
        selectedLineKeysByHunkId: nextSelectedLineKeysByHunkId,
      },
    },
  };
}

/**
 * 一次性切换指定路径下的全部 hunk 选区，供“全选/全不选”入口复用。
 */
export function setAllPartialCommitHunksSelected(
  prev: PartialCommitSelectionState,
  pathText: string,
  selected: boolean,
  repoRoot?: string,
): PartialCommitSelectionState {
  const pathKey = resolvePartialCommitStateKey(prev, pathText, repoRoot);
  const entry = pathKey ? prev.entriesByPath[pathKey] : null;
  if (!entry) return prev;
  const selectedLineKeysByHunkId: Record<string, string[]> = {};
  if (selected) {
    for (const hunkId of entry.allHunkIds) {
      selectedLineKeysByHunkId[hunkId] = listAllHunkLineKeys(entry.hunksById[hunkId]);
    }
  }
  return {
    entriesByPath: {
      ...prev.entriesByPath,
      [pathKey]: {
        ...entry,
        selectedHunkIds: selected ? [...entry.allHunkIds] : [],
        selectedLineKeysByHunkId,
      },
    },
  };
}

/**
 * 清除指定路径的 partial commit 选区，回退到普通整文件提交语义。
 */
export function clearPartialCommitSelection(
  prev: PartialCommitSelectionState,
  pathText: string,
  repoRoot?: string,
): PartialCommitSelectionState {
  const pathKey = resolvePartialCommitStateKey(prev, pathText, repoRoot);
  if (!pathKey || !prev.entriesByPath[pathKey]) return prev;
  const nextEntriesByPath = { ...prev.entriesByPath };
  delete nextEntriesByPath[pathKey];
  return {
    entriesByPath: nextEntriesByPath,
  };
}

/**
 * 把 inclusion item 与 partial commit 状态汇总成最终提交 selection；
 * - 没有 partial 记录或 hunk/line 全选时，按整文件提交；
 * - 只纳入部分 hunk/line 时，输出真正的 partial selection；
 * - 没有任何行被纳入时，不为该文件生成 selection。
 */
export function buildCommitWorkflowSelectionItem(
  item: CommitInclusionItem,
  state: PartialCommitSelectionState,
  fallbackRepoRoot: string,
): CommitWorkflowSelectionItem | null {
  const repoRoot = normalizeCommitRepoRoot(item.repoRoot || fallbackRepoRoot);
  const pathKey = buildPartialCommitStateKey(item.path, repoRoot);
  const partialEntry = state.entriesByPath[pathKey];
  if (!partialEntry || isPartialCommitEntryFullySelected(partialEntry)) {
    return {
      repoRoot,
      changeListId: String(item.changeListId || "default").trim() || "default",
      path: item.path,
      oldPath: item.oldPath,
      kind: item.kind,
      selectionMode: "full-file",
    };
  }

  const patchText = buildPartialCommitPatch(partialEntry);
  if (!patchText.trim()) return null;

  return {
    repoRoot: String(partialEntry.repoRoot || repoRoot).trim(),
    changeListId: String(partialEntry.changeListId || item.changeListId || "default").trim() || "default",
    path: item.path,
    oldPath: item.oldPath,
    kind: item.kind,
    selectionMode: "partial",
    snapshotFingerprint: partialEntry.snapshotFingerprint,
    patch: patchText,
    selectedHunkIds: [...partialEntry.selectedHunkIds],
  };
}
