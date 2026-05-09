// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type {
  GitChangeList,
  GitMoveFilesToChangeListEntryState,
  GitStatusEntry,
  GitStatusSnapshot,
} from "./types";
import { resolveGitText } from "./git-i18n";

const DEFAULT_CHANGE_LIST_ID = "default";

/**
 * 统一归一化 changelist 相关路径，避免不同分隔符导致映射键不一致。
 */
function normalizeChangeListPath(pathText: string): string {
  return String(pathText || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * 返回 changelist 的最终显示名；默认列表会兼容历史英文名并统一显示为中文标签。
 */
export function resolveDisplayChangeListName(list: Pick<GitChangeList, "id" | "name">): string {
  const id = String(list.id || "").trim();
  const name = String(list.name || "").trim();
  if (id === DEFAULT_CHANGE_LIST_ID && (!name || /^default$/i.test(name)))
    return resolveGitText("changelist.defaultName", "默认");
  return name || id;
}

/**
 * 构建目标 changelist 下拉项；显示层只暴露名称，值层始终绑定稳定 id。
 */
export function buildChangeListSelectOptions(lists: GitChangeList[]): Array<{ value: string; label: string }> {
  return lists.map((list) => ({
    value: list.id,
    label: resolveDisplayChangeListName(list),
  }));
}

/**
 * 按 IDEA 的单列表移动语义过滤候选列表；若仅从一个列表移动，则优先排除该源列表。
 */
export function resolveMoveDialogLists(lists: GitChangeList[], selectedEntries: GitStatusEntry[]): GitChangeList[] {
  const affectedIds = new Set(
    selectedEntries
      .map((entry) => String(entry.changeListId || "").trim())
      .filter(Boolean),
  );
  if (affectedIds.size !== 1)
    return [...lists];
  const filtered = lists.filter((list) => !affectedIds.has(String(list.id || "").trim()));
  return filtered.length > 0 ? filtered : [...lists];
}

/**
 * 从当前前端状态提取移动所需的最小条目状态，供后端直接复用并跳过重复扫描。
 */
export function buildMoveEntryStatePayload(
  paths: string[],
  statusEntryByPath: Map<string, GitStatusEntry>,
): GitMoveFilesToChangeListEntryState[] {
  const out: GitMoveFilesToChangeListEntryState[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    const path = normalizeChangeListPath(rawPath);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const entry = statusEntryByPath.get(path);
    if (!entry) continue;
    out.push({
      path,
      untracked: entry.untracked === true,
      ignored: entry.ignored === true,
    });
  }
  return out;
}

/**
 * 在 tracked-only 场景下本地同步 changelist 映射，避免移动完成后再整页刷新造成明显卡顿。
 */
export function applyMovedPathsToStatusSnapshot(
  snapshot: GitStatusSnapshot,
  paths: string[],
  targetListId: string,
): GitStatusSnapshot {
  const normalizedTargetListId = String(targetListId || "").trim();
  if (!normalizedTargetListId)
    return snapshot;

  const movedPathSet = new Set(
    paths.map((path) => normalizeChangeListPath(path)).filter(Boolean),
  );
  if (movedPathSet.size <= 0)
    return snapshot;

  const targetExists = snapshot.changeLists.lists.some((list) => String(list.id || "").trim() === normalizedTargetListId);
  if (!targetExists)
    return snapshot;

  const movedPaths = Array.from(movedPathSet);
  const nextEntries = snapshot.entries.map((entry) => {
    const path = normalizeChangeListPath(entry.path);
    if (!movedPathSet.has(path) || String(entry.changeListId || "").trim() === normalizedTargetListId)
      return entry;
    return {
      ...entry,
      changeListId: normalizedTargetListId,
    };
  });
  const nextLists = snapshot.changeLists.lists.map((list) => {
    const retainedFiles = list.files.filter((file) => !movedPathSet.has(normalizeChangeListPath(file)));
    if (String(list.id || "").trim() !== normalizedTargetListId) {
      return {
        ...list,
        files: retainedFiles,
        fileCount: retainedFiles.length,
      };
    }
    const existingFiles = new Set(retainedFiles.map((file) => normalizeChangeListPath(file)));
    const mergedFiles = [...retainedFiles];
    for (const movedPath of movedPaths) {
      if (existingFiles.has(movedPath)) continue;
      mergedFiles.push(movedPath);
      existingFiles.add(movedPath);
    }
    return {
      ...list,
      files: mergedFiles,
      fileCount: mergedFiles.length,
    };
  });
  return {
    ...snapshot,
    entries: nextEntries,
    changeLists: {
      ...snapshot.changeLists,
      lists: nextLists,
    },
  };
}
