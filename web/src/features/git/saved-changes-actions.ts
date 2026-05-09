// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitFeatureResponse } from "./api";
import type {
  GitManualShelveSelection,
  GitShelfItem,
  GitStashItem,
  GitStatusEntry,
} from "./types";

type SavedChangesPolicy = "stash" | "shelve";

type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

const PENDING_SAVED_CHANGES_OPEN_STORAGE_KEY = "cf.git.pendingSavedChangesOpen";

type SavedChangesOpenPayload = {
  repoRoot?: string;
  repoRoots?: string[];
  ref?: string;
  source?: string;
  viewKind?: string;
};

type PendingSavedChangesOpenRequest = {
  targetRepoRoot: string;
  saveChangesPolicy: SavedChangesPolicy;
  payload?: SavedChangesOpenPayload;
};

type SavedChangesStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type OpenSavedChangesViewArgs = {
  currentRepoRoot: string;
  targetRepoRoot: string;
  saveChangesPolicy: SavedChangesPolicy;
  payload?: SavedChangesOpenPayload;
  translate?: GitTranslate;
  getShelvesAsync(repoRoot: string): Promise<GitFeatureResponse<{ items: GitShelfItem[] }>>;
  getStashListAsync(repoRoot: string): Promise<GitFeatureResponse<{ items: GitStashItem[] }>>;
  openRepoRootInAppAsync(repoRoot: string, options: { successMessage: string }): Promise<boolean>;
  setLeftTab(value: "shelve"): void;
  setShelfItems(items: GitShelfItem[]): void;
  setStashItems(items: GitStashItem[]): void;
  setError(message: string): void;
  formatError(error: string | undefined, fallback: string): string;
};

type RunShelfEntryActionArgs = {
  repoRoot: string;
  shelf: GitShelfItem;
  action: "restore" | "delete";
  options?: {
    selectedPaths?: string[];
    targetChangeListId?: string;
    removeAppliedFromShelf?: boolean;
  };
  translate?: GitTranslate;
  restoreShelveAsync(
    repoRoot: string,
    ref: string,
    options?: {
      selectedPaths?: string[];
      targetChangeListId?: string;
      removeAppliedFromShelf?: boolean;
    },
  ): Promise<GitFeatureResponse>;
  deleteShelveAsync(repoRoot: string, ref: string): Promise<GitFeatureResponse>;
  refreshAllAsync(options: { keepLog: boolean }): Promise<void>;
  openConflictResolverDialog(payload: { title: string; description: string; reverseMerge?: boolean }): void;
  isLikelyConflictErrorText(error: string | undefined): boolean;
  setError(message: string): void;
  formatError(error: string | undefined, fallback: string): string;
  onDeleteSuccess?(shelf: GitShelfItem): void | Promise<void>;
};

type RunStashEntryActionArgs = {
  repoRoot: string;
  stash: GitStashItem;
  action: "apply" | "pop" | "branch" | "drop";
  options?: {
    reinstateIndex?: boolean;
    branchName?: string;
  };
  translate?: GitTranslate;
  applyStashAsync(
    repoRoot: string,
    ref: string,
    pop: boolean,
    options?: {
      reinstateIndex?: boolean;
      branchName?: string;
    },
  ): Promise<GitFeatureResponse>;
  dropStashAsync(repoRoot: string, ref: string): Promise<GitFeatureResponse>;
  refreshAllAsync(options: { keepLog: boolean }): Promise<void>;
  openConflictResolverDialog(payload: { title: string; description: string; reverseMerge?: boolean }): void;
  isLikelyConflictErrorText(error: string | undefined): boolean;
  setError(message: string): void;
  formatError(error: string | undefined, fallback: string): string;
};

/**
 * 把目标 ref 对应的已保存记录置顶，确保用户通过通知或结果卡片打开时能直接看到目标条目。
 */
export function prioritizeSavedEntry<T extends { ref: string }>(items: T[], targetRef?: string): T[] {
  const normalizedRef = String(targetRef || "").trim();
  if (!normalizedRef) return items;
  const matched = items.find((item) => String(item.ref || "").trim() === normalizedRef);
  if (!matched) return items;
  return [matched, ...items.filter((item) => String(item.ref || "").trim() !== normalizedRef)];
}

/**
 * 解析当前环境可用的本地存储实现，兼容浏览器与测试宿主。
 */
function getSavedChangesStorage(): SavedChangesStorageLike | null {
  const globalStorage = (globalThis as { localStorage?: SavedChangesStorageLike }).localStorage;
  if (globalStorage) return globalStorage;
  const windowStorage = (globalThis as { window?: { localStorage?: SavedChangesStorageLike } }).window?.localStorage;
  return windowStorage || null;
}

/**
 * 持久化一次“切仓后继续打开保存改动”的请求，确保跨仓通知动作不会丢失目标 ref。
 */
export function persistPendingSavedChangesOpenRequest(request: PendingSavedChangesOpenRequest): void {
  const storage = getSavedChangesStorage();
  if (!storage) return;
  const targetRepoRoot = String(request.targetRepoRoot || "").trim();
  if (!targetRepoRoot) return;
  try {
    storage.setItem(PENDING_SAVED_CHANGES_OPEN_STORAGE_KEY, JSON.stringify({
      targetRepoRoot,
      saveChangesPolicy: request.saveChangesPolicy === "shelve" ? "shelve" : "stash",
      payload: request.payload,
    }));
  } catch {}
}

/**
 * 清理待消费的跨仓保存改动请求，避免过期动作在后续仓库切换中误触发。
 */
export function clearPendingSavedChangesOpenRequest(): void {
  const storage = getSavedChangesStorage();
  if (!storage) return;
  try {
    storage.removeItem(PENDING_SAVED_CHANGES_OPEN_STORAGE_KEY);
  } catch {}
}

/**
 * 按当前仓库消费一次待打开请求；仅当目标仓匹配时才返回，消费后会立刻清理存储。
 */
export function consumePendingSavedChangesOpenRequest(currentRepoRoot: string): PendingSavedChangesOpenRequest | null {
  const storage = getSavedChangesStorage();
  if (!storage) return null;
  const normalizedCurrentRepoRoot = String(currentRepoRoot || "").trim();
  if (!normalizedCurrentRepoRoot) return null;
  try {
    const raw = storage.getItem(PENDING_SAVED_CHANGES_OPEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingSavedChangesOpenRequest | null;
    const targetRepoRoot = String(parsed?.targetRepoRoot || "").trim();
    if (!targetRepoRoot || targetRepoRoot !== normalizedCurrentRepoRoot) return null;
    clearPendingSavedChangesOpenRequest();
    return {
      targetRepoRoot,
      saveChangesPolicy: parsed?.saveChangesPolicy === "shelve" ? "shelve" : "stash",
      payload: parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : undefined,
    };
  } catch {
    clearPendingSavedChangesOpenRequest();
    return null;
  }
}

/**
 * 按当前选择、当前更改列表与当前可见受影响变更构建手动搁置载荷，对齐 IDEA 的手动 shelf 入口语义。
 */
export function buildManualShelveSelection(args: {
  selectedEntries: GitStatusEntry[];
  statusEntries: GitStatusEntry[];
  changeListsEnabled: boolean;
  targetChangeListId?: string;
  targetChangeListName?: string;
}): GitManualShelveSelection {
  const selectedPaths = Array.from(new Set(
    args.selectedEntries
      .filter((entry) => !entry.ignored && (entry.staged || entry.unstaged || entry.untracked))
      .map((entry) => String(entry.path || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
  const availablePaths = Array.from(new Set(
    args.statusEntries
      .filter((entry) => !entry.ignored && (entry.staged || entry.unstaged || entry.untracked))
      .map((entry) => String(entry.path || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
  return {
    selectedPaths,
    availablePaths,
    targetChangeListId: String(args.targetChangeListId || "").trim() || undefined,
    targetChangeListName: String(args.targetChangeListName || "").trim() || undefined,
    changeListsEnabled: args.changeListsEnabled,
  };
}

/**
 * 统一打开 stash/shelf 列表，并在需要时把目标仓切到当前工作台实例。
 */
export async function openSavedChangesViewAsync(args: OpenSavedChangesViewArgs): Promise<void> {
  const effectiveRepoRoot = String(args.targetRepoRoot || "").trim();
  const targetRef = String(args.payload?.ref || "").trim();
  const gt = args.translate;
  if (!effectiveRepoRoot) return;
  if (args.currentRepoRoot && effectiveRepoRoot !== args.currentRepoRoot) {
    persistPendingSavedChangesOpenRequest({
      targetRepoRoot: effectiveRepoRoot,
      saveChangesPolicy: args.saveChangesPolicy,
      payload: args.payload,
    });
    const opened = await args.openRepoRootInAppAsync(effectiveRepoRoot, {
      successMessage: args.saveChangesPolicy === "shelve"
        ? (gt ? gt("savedChanges.openTarget.shelfSuccess", "已打开目标仓库，可继续查看其搁置列表") : "已打开目标仓库，可继续查看其搁置列表")
        : (gt ? gt("savedChanges.openTarget.stashSuccess", "已打开目标仓库，可继续查看其暂存列表") : "已打开目标仓库，可继续查看其暂存列表"),
    });
    if (!opened) {
      clearPendingSavedChangesOpenRequest();
      return;
    }
    return;
  }
  if (args.payload?.viewKind === "stash" || args.saveChangesPolicy === "stash") {
    const res = await args.getStashListAsync(effectiveRepoRoot);
    if (!res.ok || !res.data) {
      args.setError(args.formatError(res.error, gt ? gt("savedChanges.errors.loadStashFailed", "读取暂存列表失败") : "读取暂存列表失败"));
      return;
    }
    args.setStashItems(prioritizeSavedEntry(res.data.items || [], targetRef));
    args.setLeftTab("shelve");
    return;
  }
  const res = await args.getShelvesAsync(effectiveRepoRoot);
  if (!res.ok || !res.data) {
    args.setError(args.formatError(res.error, gt ? gt("savedChanges.errors.loadShelfFailed", "读取搁置列表失败") : "读取搁置列表失败"));
    return;
  }
  args.setShelfItems(prioritizeSavedEntry(res.data.items || [], targetRef));
  args.setLeftTab("shelve");
}

/**
 * 统一执行 shelf 面板上的取消搁置/删除动作，并在取消搁置冲突时拉起同一套 resolver 入口。
 */
export async function runShelfEntryActionAsync(args: RunShelfEntryActionArgs): Promise<void> {
  const gt = args.translate;
  if (args.action === "delete") {
    const res = await args.deleteShelveAsync(args.repoRoot, args.shelf.ref);
    if (!res.ok) {
      args.setError(args.formatError(res.error, gt ? gt("savedChanges.errors.deleteShelfFailed", "删除搁置失败") : "删除搁置失败"));
      return;
    }
    await args.refreshAllAsync({ keepLog: true });
    await args.onDeleteSuccess?.(args.shelf);
    return;
  }

  const restoreRes = await args.restoreShelveAsync(args.repoRoot, args.shelf.ref, args.options);
  if (!restoreRes.ok) {
    args.setError(args.formatError(restoreRes.error, gt ? gt("savedChanges.errors.restoreShelfFailed", "取消搁置失败") : "取消搁置失败"));
    if ((Array.isArray(restoreRes.data?.conflictRepoRoots) && restoreRes.data.conflictRepoRoots.length > 0) || args.isLikelyConflictErrorText(restoreRes.error)) {
      await args.refreshAllAsync({ keepLog: true });
      args.openConflictResolverDialog({
        title: gt ? gt("savedChanges.conflicts.restoreShelfTitle", "解决取消搁置冲突") : "解决取消搁置冲突",
        description: gt
          ? gt("savedChanges.conflicts.restoreShelfDescription", "取消搁置 {{ref}} 后检测到冲突；可在这里逐个打开冲突文件继续处理。", { ref: args.shelf.ref })
          : `取消搁置 ${args.shelf.ref} 后检测到冲突；可在这里逐个打开冲突文件继续处理。`,
        reverseMerge: true,
      });
    }
    return;
  }
  await args.refreshAllAsync({ keepLog: true });
}

/**
 * 统一执行 stash 面板上的应用/弹出/删除动作，并复用 preserving 冲突恢复链路。
 */
export async function runStashEntryActionAsync(args: RunStashEntryActionArgs): Promise<void> {
  const gt = args.translate;
  if (args.action === "drop") {
    const res = await args.dropStashAsync(args.repoRoot, args.stash.ref);
    if (!res.ok) {
      args.setError(args.formatError(res.error, gt ? gt("savedChanges.errors.deleteStashFailed", "删除暂存失败") : "删除暂存失败"));
      return;
    }
    await args.refreshAllAsync({ keepLog: true });
    return;
  }

  const pop = args.action === "pop";
  const branchName = args.action === "branch"
    ? String(args.options?.branchName || "").trim()
    : "";
  const reinstateIndex = args.options?.reinstateIndex === true && !branchName;
  const restoreRes = await args.applyStashAsync(args.repoRoot, args.stash.ref, pop, {
    reinstateIndex,
    branchName: branchName || undefined,
  });
  const fallbackError = branchName
    ? (gt ? gt("savedChanges.errors.branchRestoreStashFailed", "以分支恢复暂存失败") : "以分支恢复暂存失败")
    : (pop ? (gt ? gt("savedChanges.errors.restoreStashFailed", "恢复暂存失败") : "恢复暂存失败") : (gt ? gt("savedChanges.errors.applyStashFailed", "应用暂存失败") : "应用暂存失败"));
  if (!restoreRes.ok) {
    args.setError(args.formatError(restoreRes.error, fallbackError));
    if ((Array.isArray(restoreRes.data?.conflictRepoRoots) && restoreRes.data.conflictRepoRoots.length > 0) || args.isLikelyConflictErrorText(restoreRes.error)) {
      await args.refreshAllAsync({ keepLog: true });
      args.openConflictResolverDialog({
        title: branchName
          ? (gt ? gt("savedChanges.conflicts.branchRestoreStashTitle", "解决暂存分支冲突") : "解决暂存分支冲突")
          : (pop ? (gt ? gt("savedChanges.conflicts.restoreStashTitle", "解决恢复暂存冲突") : "解决恢复暂存冲突") : (gt ? gt("savedChanges.conflicts.applyStashTitle", "解决应用暂存冲突") : "解决应用暂存冲突")),
        description: branchName
          ? (gt
            ? gt("savedChanges.conflicts.branchRestoreStashDescription", "以分支 {{branch}} 恢复暂存 {{ref}} 后检测到冲突；可在这里逐个打开冲突文件继续处理。", { branch: branchName, ref: args.stash.ref })
            : `以分支 ${branchName} 恢复暂存 ${args.stash.ref} 后检测到冲突；可在这里逐个打开冲突文件继续处理。`)
          : (pop
            ? (gt
              ? gt("savedChanges.conflicts.restoreStashDescription", "恢复暂存 {{ref}} 后检测到冲突；可在这里逐个打开冲突文件继续处理。", { ref: args.stash.ref })
              : `恢复暂存 ${args.stash.ref} 后检测到冲突；可在这里逐个打开冲突文件继续处理。`)
            : (gt
              ? gt("savedChanges.conflicts.applyStashDescription", "应用暂存 {{ref}} 后检测到冲突；可在这里逐个打开冲突文件继续处理。", { ref: args.stash.ref })
              : `应用暂存 ${args.stash.ref} 后检测到冲突；可在这里逐个打开冲突文件继续处理。`)),
        reverseMerge: true,
      });
    }
    return;
  }
  await args.refreshAllAsync({ keepLog: true });
}
