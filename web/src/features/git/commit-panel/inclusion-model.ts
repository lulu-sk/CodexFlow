// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitStatusEntry } from "../types";
import type { ChangeEntryGroup, CommitInclusionItem, CommitInclusionState, CommitTreeNode } from "./types";

/**
 * 比较两个字符串数组是否完全一致（顺序敏感），供 inclusion 状态 no-op 复用判断复用。
 */
function isSameStringArray(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * 统一规整提交面板里的仓库根路径文本，避免分隔符差异导致多仓状态被误判为不同根。
 */
export function normalizeCommitRepoRoot(repoRoot: string | undefined): string {
  return String(repoRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 为“仓库根 + 相对路径”组合生成稳定查询键，供多仓同路径场景下的映射与查找复用。
 */
export function buildCommitInclusionLookupKey(pathText: string, repoRoot?: string): string {
  const cleanPath = String(pathText || "").trim().replace(/\\/g, "/");
  const cleanRepoRoot = normalizeCommitRepoRoot(repoRoot);
  return cleanRepoRoot ? `${cleanRepoRoot}::${cleanPath}` : cleanPath;
}

/**
 * 按首次出现顺序去重字符串列表，保证状态快照稳定且比较成本可控。
 */
function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = String(value || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/**
 * 比较两份 inclusion item 索引是否语义一致；完全一致时可直接复用旧状态对象。
 */
function isSameCommitInclusionItemsById(
  previousItemsById: Record<string, CommitInclusionItem>,
  nextItemsById: Record<string, CommitInclusionItem>,
): boolean {
  const previousIds = Object.keys(previousItemsById);
  const nextIds = Object.keys(nextItemsById);
  if (previousIds.length !== nextIds.length) return false;
  for (const itemId of nextIds) {
    const previousItem = previousItemsById[itemId];
    const nextItem = nextItemsById[itemId];
    if (!previousItem || !nextItem) return false;
    if (previousItem.path !== nextItem.path) return false;
    if (String(previousItem.oldPath || "") !== String(nextItem.oldPath || "")) return false;
    if (previousItem.kind !== nextItem.kind) return false;
    if (previousItem.changeListId !== nextItem.changeListId) return false;
    if (String(previousItem.repoRoot || "") !== String(nextItem.repoRoot || "")) return false;
    if ((previousItem.staged === true) !== (nextItem.staged === true)) return false;
    if ((previousItem.tracked === true) !== (nextItem.tracked === true)) return false;
    if (String(previousItem.conflictState || "") !== String(nextItem.conflictState || "")) return false;
  }
  return true;
}

/**
 * 判断条目是否允许参与提交 inclusion；已忽略文件需先进入 add-to-vcs 链路，因此不直接纳入提交集合。
 */
export function isEntryActionable(entry: GitStatusEntry): boolean {
  return !entry.ignored;
}

/**
 * 创建空的 inclusion model 状态。
 */
export function createCommitInclusionState(commitAllEnabled: boolean = true): CommitInclusionState {
  return {
    includedIds: [],
    includedRepoRoots: [],
    userTouched: false,
    rootsUserTouched: false,
    commitAllEnabled,
    stagedRepoRoots: [],
    changedRepoRoots: [],
    conflictedRepoRoots: [],
    rootsToCommit: [],
    isCommitAll: false,
    itemsById: {},
  };
}

/**
 * 判断两份 inclusion 状态是否完全一致；完全一致时应直接复用旧对象，避免提交面板进入重复渲染。
 */
export function isSameCommitInclusionState(
  previousState: CommitInclusionState,
  nextState: CommitInclusionState,
): boolean {
  if (previousState === nextState) return true;
  if (previousState.userTouched !== nextState.userTouched) return false;
  if (previousState.rootsUserTouched !== nextState.rootsUserTouched) return false;
  if ((previousState.commitAllEnabled !== false) !== (nextState.commitAllEnabled !== false)) return false;
  if (!isSameStringArray(previousState.includedIds, nextState.includedIds)) return false;
  if (!isSameStringArray(previousState.includedRepoRoots, nextState.includedRepoRoots)) return false;
  if (!isSameStringArray(previousState.stagedRepoRoots, nextState.stagedRepoRoots)) return false;
  if (!isSameStringArray(previousState.changedRepoRoots, nextState.changedRepoRoots)) return false;
  if (!isSameStringArray(previousState.conflictedRepoRoots, nextState.conflictedRepoRoots)) return false;
  if (!isSameStringArray(previousState.rootsToCommit, nextState.rootsToCommit)) return false;
  if (previousState.isCommitAll !== nextState.isCommitAll) return false;
  return isSameCommitInclusionItemsById(previousState.itemsById, nextState.itemsById);
}

/**
 * 构建单个状态条目的稳定 inclusion item id，供 inclusion 同步与 commit workflow 激活态复用。
 */
export function buildCommitInclusionItemId(
  entry: Pick<GitStatusEntry, "untracked" | "changeListId" | "conflictState" | "path" | "repositoryRoot">,
): string {
  const cleanRepoRoot = normalizeCommitRepoRoot(entry.repositoryRoot);
  const suffix = `${entry.untracked ? "u" : "c"}:${entry.changeListId || "default"}:${entry.conflictState || "normal"}:${entry.path}`;
  return cleanRepoRoot ? `r:${cleanRepoRoot}:${suffix}` : suffix;
}

/**
 * 为状态条目生成稳定 inclusion item，避免把 `path -> boolean` 当作唯一真相源。
 */
export function buildCommitInclusionItems(entries: GitStatusEntry[]): CommitInclusionItem[] {
  return entries
    .filter((entry) => isEntryActionable(entry))
    .map((entry) => ({
      id: buildCommitInclusionItemId(entry),
      path: entry.path,
      oldPath: String(entry.oldPath || "").trim() || undefined,
      kind: entry.untracked ? "unversioned" : "change",
      changeListId: entry.changeListId || "default",
      repoRoot: normalizeCommitRepoRoot(entry.repositoryRoot),
      staged: entry.staged,
      tracked: !entry.untracked,
      conflictState: entry.conflictState,
    }));
}

/**
 * 把 inclusion item 数组转为按 id 索引的字典，便于后续快速同步与查询。
 */
function indexItemsById(items: CommitInclusionItem[]): Record<string, CommitInclusionItem> {
  const out: Record<string, CommitInclusionItem> = {};
  for (const item of items) {
    out[item.id] = item;
  }
  return out;
}

/**
 * 按给定条件提取稳定有序的仓库根集合，供 root inclusion 与 commit-all 语义复用。
 */
function collectRepoRoots(
  items: CommitInclusionItem[],
  predicate?: (item: CommitInclusionItem) => boolean,
): string[] {
  return uniqueStrings(items.flatMap((item) => {
    if (predicate && !predicate(item)) return [];
    const repoRoot = normalizeCommitRepoRoot(item.repoRoot);
    return repoRoot ? [repoRoot] : [];
  }));
}

/**
 * 基于当前 inclusion 条目与交互标记推导 root 级状态，对齐 staged-root / changed-root / commit-all 的核心语义。
 */
function buildCommitInclusionState(args: {
  includedIds: Set<string>;
  items: CommitInclusionItem[];
  itemsById: Record<string, CommitInclusionItem>;
  userTouched: boolean;
  rootsUserTouched: boolean;
  commitAllEnabled?: boolean;
  includedRepoRootsSeed?: string[];
}): CommitInclusionState {
  const allRepoRoots = collectRepoRoots(args.items);
  const stagedRepoRoots = collectRepoRoots(args.items, (item) => item.tracked === true && item.staged === true);
  const changedRepoRoots = collectRepoRoots(args.items, (item) => item.tracked === true);
  const conflictedRepoRoots = collectRepoRoots(args.items, (item) => item.conflictState === "conflict");
  const includedItemRepoRoots = collectRepoRoots(args.items, (item) => args.includedIds.has(item.id));
  const commitAllEnabled = args.commitAllEnabled !== false;
  const isCommitAll = commitAllEnabled && stagedRepoRoots.length === 0 && changedRepoRoots.length > 0;

  const availableRootSet = new Set(allRepoRoots);
  const includedRootSeed = uniqueStrings(
    (args.includedRepoRootsSeed || []).map((root) => normalizeCommitRepoRoot(root)),
  ).filter((root) => availableRootSet.size === 0 || availableRootSet.has(root));
  const nextIncludedRepoRoots = new Set<string>(args.rootsUserTouched
    ? includedRootSeed
    : (isCommitAll ? changedRepoRoots : stagedRepoRoots));
  for (const repoRoot of includedItemRepoRoots)
    nextIncludedRepoRoots.add(repoRoot);

  const effectiveIncludedRepoRoots = Array.from(nextIncludedRepoRoots);
  const commitRootSource = isCommitAll ? changedRepoRoots : stagedRepoRoots;
  const rootsToCommit = commitRootSource.filter((repoRoot) => nextIncludedRepoRoots.has(repoRoot));

  return {
    includedIds: Array.from(args.includedIds),
    includedRepoRoots: effectiveIncludedRepoRoots,
    userTouched: args.userTouched,
    rootsUserTouched: args.rootsUserTouched,
    commitAllEnabled,
    stagedRepoRoots,
    changedRepoRoots,
    conflictedRepoRoots,
    rootsToCommit,
    isCommitAll,
    itemsById: args.itemsById,
  };
}

/**
 * 判断当前 inclusion 是否仍保持“活动 changelist 的普通 change 全量纳入”语义，供刷新时决定是否自动补入新项。
 */
function shouldAutoIncludeNewActiveItems(
  includedIds: Set<string>,
  previousItemsById: Record<string, CommitInclusionItem>,
  nextItemsById: Record<string, CommitInclusionItem>,
  activeChangeListId: string,
): boolean {
  const previousAutoIncludedIds = Object.values(previousItemsById)
    .filter((item) => isAutoIncludedActiveChangeItem(item, activeChangeListId))
    .map((item) => item.id);
  if (previousAutoIncludedIds.length === 0) return false;
  for (const itemId of includedIds) {
    const item = nextItemsById[itemId];
    if (!item) continue;
    if (item.conflictState === "resolved") continue;
    if (!isAutoIncludedActiveChangeItem(item, activeChangeListId)) return false;
  }
  return previousAutoIncludedIds.every((itemId) => includedIds.has(itemId));
}

/**
 * 判断 inclusion 项是否属于“resolved conflict 自动纳入”集合；该规则独立于 checkbox 可见性。
 */
function isResolvedConflictItem(item: CommitInclusionItem): boolean {
  return item.kind === "change" && item.conflictState === "resolved";
}

/**
 * 判断 inclusion 项是否属于活动 changelist 的默认自动纳入集合；未解决冲突与未跟踪文件不参与该默认规则。
 */
function isAutoIncludedActiveChangeItem(item: CommitInclusionItem, activeChangeListId: string): boolean {
  return item.kind === "change" && !item.conflictState && item.changeListId === activeChangeListId;
}

/**
 * 把 resolved conflict 自动纳入当前 inclusion 集；即使用户未手动勾选，也要与 IDEA workflow 语义保持一致。
 */
function includeResolvedConflictItems(
  includedIds: Set<string>,
  items: CommitInclusionItem[],
): void {
  for (const item of items) {
    if (!isResolvedConflictItem(item)) continue;
    includedIds.add(item.id);
  }
}

/**
 * 将最新可提交项同步到 inclusion model。
 * - 已失效条目会被 retain 过滤掉；
 * - 初次加载时仅自动纳入 resolved conflicts；普通 changes 需用户显式勾选，避免打开 Git 面板时默认全选；
 * - 用户已发生交互后，仍会继续自动纳入 resolved conflicts；活动 changelist 的新项仅在现有 inclusion 仍保持“活动列表全集”语义时增量纳入。
 */
export function syncCommitInclusionState(
  prev: CommitInclusionState,
  items: CommitInclusionItem[],
  activeChangeListId: string,
  commitAllEnabled: boolean = prev.commitAllEnabled !== false,
): CommitInclusionState {
  const itemsById = indexItemsById(items);
  const validIds = new Set(items.map((item) => item.id));
  const includedIds = new Set(prev.includedIds.filter((itemId) => validIds.has(itemId)));
  const previousItemIds = new Set(Object.keys(prev.itemsById));

  includeResolvedConflictItems(includedIds, items);

  if (!prev.userTouched) {
    const nextState = buildCommitInclusionState({
      includedIds,
      items,
      itemsById,
      userTouched: false,
      rootsUserTouched: prev.rootsUserTouched,
      commitAllEnabled,
      includedRepoRootsSeed: prev.includedRepoRoots,
    });
    return isSameCommitInclusionState(prev, nextState) ? prev : nextState;
  }

  const canAutoInclude = shouldAutoIncludeNewActiveItems(includedIds, prev.itemsById, itemsById, activeChangeListId);
  if (canAutoInclude) {
    for (const item of items) {
      if (includedIds.has(item.id) || previousItemIds.has(item.id)) continue;
      if (isAutoIncludedActiveChangeItem(item, activeChangeListId)) {
        includedIds.add(item.id);
      }
    }
  }

  const nextState = buildCommitInclusionState({
    includedIds,
    items,
    itemsById,
    userTouched: prev.userTouched,
    rootsUserTouched: prev.rootsUserTouched,
    commitAllEnabled,
    includedRepoRootsSeed: prev.includedRepoRoots,
  });
  return isSameCommitInclusionState(prev, nextState) ? prev : nextState;
}

/**
 * 按 IDEA `CheckinActionUtil.setCommitState(initialChangeList, included, ...)` 语义重建提交入口的 inclusion 状态。
 * - 存在显式 selected changes / unversioned 时，只纳入这些显式选项，并保留 resolved conflict 自动纳入。
 * - 否则按 initial changelist 语义纳入目标 changelist 的普通 change，不默认纳入 unversioned。
 */
export function resolveCommitActivationInclusionState(args: {
  items: CommitInclusionItem[];
  activeChangeListId?: string;
  selectedEntries?: GitStatusEntry[];
  selectedChangeListIds?: string[];
  commitAllEnabled?: boolean;
}): CommitInclusionState {
  const itemsById = indexItemsById(args.items);
  const includedIds = new Set<string>();
  includeResolvedConflictItems(includedIds, args.items);

  const selectedEntryIds = Array.from(new Set(
    (args.selectedEntries || [])
      .filter((entry) => isEntryActionable(entry))
      .map((entry) => buildCommitInclusionItemId(entry)),
  )).filter((itemId) => !!itemsById[itemId]);

  if (selectedEntryIds.length > 0) {
    for (const itemId of selectedEntryIds)
      includedIds.add(itemId);
    return buildCommitInclusionState({
      includedIds,
      items: args.items,
      itemsById,
      userTouched: true,
      rootsUserTouched: false,
      commitAllEnabled: args.commitAllEnabled,
    });
  }

  const normalizedSelectedChangeListIds = Array.from(new Set(
    (args.selectedChangeListIds || [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  ));
  const targetChangeListId = normalizedSelectedChangeListIds.length === 1
    ? normalizedSelectedChangeListIds[0]
    : String(args.activeChangeListId || "").trim();

  if (targetChangeListId) {
    for (const item of args.items) {
      if (isAutoIncludedActiveChangeItem(item, targetChangeListId))
        includedIds.add(item.id);
    }
  }

  return buildCommitInclusionState({
    includedIds,
    items: args.items,
    itemsById,
    userTouched: true,
    rootsUserTouched: false,
    commitAllEnabled: args.commitAllEnabled,
  });
}

/**
 * 按给定 item id 集合切换 inclusion，供分组/目录/单文件复选框统一复用。
 */
export function setCommitInclusionForItemIds(
  prev: CommitInclusionState,
  itemIds: string[],
  included: boolean,
  repoRoots?: string[],
): CommitInclusionState {
  const nextIncluded = new Set(prev.includedIds);
  let changed = false;
  for (const itemId of itemIds) {
    if (!prev.itemsById[itemId]) continue;
    if (included) {
      if (!nextIncluded.has(itemId)) {
        nextIncluded.add(itemId);
        changed = true;
      }
      continue;
    }
    if (nextIncluded.delete(itemId)) changed = true;
  }
  const nextIncludedRepoRootSeed = new Set(prev.includedRepoRoots.map((root) => normalizeCommitRepoRoot(root)));
  const normalizedRepoRoots = uniqueStrings((repoRoots || []).map((root) => normalizeCommitRepoRoot(root)));
  for (const repoRoot of normalizedRepoRoots) {
    if (included) nextIncludedRepoRootSeed.add(repoRoot);
    else nextIncludedRepoRootSeed.delete(repoRoot);
  }
  if (!changed && normalizedRepoRoots.length === 0) {
    return prev.userTouched
      ? prev
      : buildCommitInclusionState({
          includedIds: nextIncluded,
          items: Object.values(prev.itemsById),
          itemsById: prev.itemsById,
          userTouched: true,
          rootsUserTouched: prev.rootsUserTouched,
          commitAllEnabled: prev.commitAllEnabled,
          includedRepoRootsSeed: prev.includedRepoRoots,
        });
  }
  return buildCommitInclusionState({
    includedIds: nextIncluded,
    items: Object.values(prev.itemsById),
    itemsById: prev.itemsById,
    userTouched: true,
    rootsUserTouched: prev.rootsUserTouched || normalizedRepoRoots.length > 0,
    commitAllEnabled: prev.commitAllEnabled,
    includedRepoRootsSeed: Array.from(nextIncludedRepoRootSeed),
  });
}

/**
 * 基于 inclusion model 判断一组 item 的三态复选框结果。
 */
export function getCommitInclusionCheckState(
  state: CommitInclusionState,
  itemIds: string[],
): { allChecked: boolean; partial: boolean; checkedCount: number } {
  const validIds = itemIds.filter((itemId) => !!state.itemsById[itemId]);
  if (validIds.length === 0) return { allChecked: false, partial: false, checkedCount: 0 };
  const included = new Set(state.includedIds);
  const checkedCount = validIds.reduce((sum, itemId) => sum + (included.has(itemId) ? 1 : 0), 0);
  return {
    allChecked: checkedCount === validIds.length,
    partial: checkedCount > 0 && checkedCount < validIds.length,
    checkedCount,
  };
}

/**
 * 判断分组头部是否应显示 inclusion checkbox，对齐 IDEA changelist/unversioned/ignored 规则。
 */
export function isCommitGroupInclusionVisible(group: Pick<ChangeEntryGroup, "kind" | "entries">): boolean {
  if (group.kind === "ignored") return false;
  if (group.kind === "unversioned") return group.entries.length > 0;
  if (group.kind !== "changelist") return false;
  return group.entries.length > 0;
}

/**
 * 判断树节点是否应显示 inclusion checkbox；隐藏语义由模型层统一决定，组件不再渲染占位 disabled checkbox。
 */
export function isCommitNodeInclusionVisible(node: Pick<CommitTreeNode, "selectionFlags" | "isFile" | "filePaths">): boolean {
  if (node.selectionFlags?.hideInclusionCheckbox) return false;
  if (typeof node.selectionFlags?.inclusionVisible === "boolean") return node.selectionFlags.inclusionVisible;
  return node.isFile || (node.filePaths?.length || 0) > 0;
}

/**
 * 按 IDEA Space toggle 语义批量切换 inclusion；若目标集合存在任一未选项则整体纳入，否则整体排除。
 */
export function toggleCommitInclusionForItemIds(
  prev: CommitInclusionState,
  itemIds: string[],
): CommitInclusionState {
  const validIds = Array.from(new Set(itemIds.filter((itemId) => !!prev.itemsById[itemId])));
  if (validIds.length === 0) return prev;
  const included = new Set(prev.includedIds);
  const shouldInclude = validIds.some((itemId) => !included.has(itemId));
  return setCommitInclusionForItemIds(prev, validIds, shouldInclude);
}

/**
 * 按路径读取 inclusion 布尔态，仅作为 UI 渲染派生值使用，不能反向作为状态真相源。
 */
export function buildIncludedPathMap(state: CommitInclusionState): Record<string, boolean> {
  const included = new Set(state.includedIds);
  const out: Record<string, boolean> = {};
  for (const item of Object.values(state.itemsById)) {
    out[buildCommitInclusionLookupKey(item.path, item.repoRoot)] = included.has(item.id);
  }
  return out;
}

/**
 * 导出当前已纳入提交的 item 集合，供 workflow 层构造提交请求。
 */
export function listIncludedCommitItems(state: CommitInclusionState): CommitInclusionItem[] {
  const included = new Set(state.includedIds);
  return Object.values(state.itemsById).filter((item) => included.has(item.id));
}
