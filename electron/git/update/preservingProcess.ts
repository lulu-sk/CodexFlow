// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// Git update preserving 流程参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 Electron/TypeScript 架构重写。

import { GitFreezingProcess } from "../freeze/freezingProcess";
import {
  adaptSingleRootSaverRuntime,
  GitChangesSaver,
  type GitChangesSaverRuntime,
} from "./changeSaver";
import {
  buildLocalChangesNotRestoredMessage,
  buildPreservingState,
  buildSavedLocalChangesDisplayName,
} from "./conflicts";
import type {
  GitSavedLocalChanges,
  GitUpdateActionResult,
  GitUpdatePostAction,
  GitUpdatePreservingNotRestoredReason,
  GitUpdatePreservingState,
  GitUpdatePreservingRuntime,
  GitUpdateSaveChangesPolicy,
  GitUpdateUnfinishedState,
} from "./types";

type GitUpdatePreservingProcessRuntime = {
  repoRoot: string;
  ctx?: {
    userDataPath?: string;
  };
  userDataPath?: string;
  emitProgress(message: string, detail?: string): void;
  detectIncompleteUpdateStateAsync?(saved: GitSavedLocalChanges | null): Promise<GitUpdateUnfinishedState | null>;
};

/**
 * 将保存记录投影成前端可复用的统一条目列表，避免结果层只保留单条 preservingState。
 */
function buildSavedLocalChangesEntries(savedItems: GitSavedLocalChanges[]): Array<{
  repoRoot?: string;
  ref: string;
  message: string;
  saveChangesPolicy: GitSavedLocalChanges["saveChangesPolicy"];
  displayName: string;
}> {
  return savedItems.map((item) => ({
    repoRoot: String(item.repoRoot || "").trim() || undefined,
    ref: item.ref,
    message: item.message,
    saveChangesPolicy: item.saveChangesPolicy,
    displayName: item.displayName,
  }));
}

/**
 * 为指定仓库挑选最合适的保存记录；优先精确命中 repoRoot，未命中时退化到首条记录。
 */
function pickSavedChangeForRepo(savedItems: GitSavedLocalChanges[], repoRoot?: string): GitSavedLocalChanges | null {
  const normalizedRepoRoot = String(repoRoot || "").trim();
  if (normalizedRepoRoot) {
    const matched = savedItems.find((item) => String(item.repoRoot || "").trim() === normalizedRepoRoot);
    if (matched) return matched;
  }
  return savedItems[0] || null;
}

/**
 * 读取 root 结果真正对应的 preserving 宿主仓；Detached 子模块会映射到父仓。
 */
function resolveRootPreservingRepoRoot(root: any): string {
  const direct = String(root?.data?.preservingRepoRoot || root?.repoRoot || "").trim();
  return direct;
}

/**
 * 根据 update 结果推导 keep-saved 原因，区分未完成更新与普通失败/取消分支。
 */
function resolveNotRestoredReason(result: GitUpdateActionResult): GitUpdatePreservingNotRestoredReason {
  if (result.data?.resultCode === "INCOMPLETE" || result.data?.unfinishedState?.stage === "update")
    return "unfinished-state";
  return "manual-decision";
}

/**
 * 基于保存记录构建统一的“查看已保存改动”动作，供单仓与多仓结果模型共用。
 */
function buildSavedChangesAction(saved: GitSavedLocalChanges): GitUpdatePostAction | undefined {
  const repoRoot = String(saved.repoRoot || "").trim();
  if (!repoRoot) return undefined;
  return {
    kind: "open-saved-changes",
    label: saved.saveChangesPolicy === "shelve" ? "查看搁置记录" : "查看暂存列表",
    repoRoot,
    payload: {
      repoRoot,
      ref: saved.ref,
      saveChangesPolicy: saved.saveChangesPolicy,
      viewKind: saved.saveChangesPolicy === "shelve" ? "shelf" : "stash",
    },
  };
}

/**
 * 为本地改动恢复冲突构建统一对话框文案，便于工作台直接拉起冲突 resolver。
 */
function buildRestoreConflictDialog(
  saved: GitSavedLocalChanges,
  repoRoot: string,
  operationTitle?: string,
  destinationName?: string,
): NonNullable<GitUpdatePreservingState["conflictResolverDialog"]> {
  const displayName = saved.displayName || buildSavedLocalChangesDisplayName(saved);
  const normalizedOperation = String(operationTitle || "").trim() || "当前 Git 操作";
  const normalizedDestination = String(destinationName || "").trim() || "更新结果";
  return {
    title: "恢复已保存改动时发现冲突",
    description: `${normalizedOperation} 已完成，但恢复 ${displayName} 到 ${normalizedDestination} 时检测到冲突。请先处理冲突，再按需继续恢复已保存改动。`,
    repoRoot,
    reverseMerge: true,
  };
}

/**
 * 把冲突对话框模型投影为统一 post action，供结果卡片直接挂出“处理冲突”入口。
 */
function buildResolveConflictsAction(
  dialog: NonNullable<GitUpdatePreservingState["conflictResolverDialog"]>,
): GitUpdatePostAction {
  return {
    kind: "resolve-conflicts",
    label: "处理冲突",
    repoRoot: dialog.repoRoot,
    payload: {
      repoRoot: dialog.repoRoot,
      description: dialog.description,
      reverseMerge: dialog.reverseMerge === true,
    },
  };
}

/**
 * 将单条 preserving state 应用到 root 结果对象，保证 session/result 视图直接可消费。
 */
function applyPreservingStateToRoot(root: any, preservingState: GitUpdatePreservingState): any {
  return {
    ...root,
    preservingState,
    localChangesRestorePolicy: preservingState.localChangesRestorePolicy,
    savedLocalChangesRef: preservingState.savedLocalChangesRef,
    savedLocalChangesDisplayName: preservingState.savedLocalChangesDisplayName,
    data: {
      ...(root?.data && typeof root.data === "object" ? root.data : {}),
      preservingState,
      localChangesRestorePolicy: preservingState.localChangesRestorePolicy,
      savedLocalChangesRef: preservingState.savedLocalChangesRef,
      savedLocalChangesDisplayName: preservingState.savedLocalChangesDisplayName,
    },
  };
}

/**
 * 把按 root 构建的 preserving state 合并回最终结果，同时补齐多 root 保存记录数组。
 */
function mergePreservingStatesIntoResult(args: {
  result: GitUpdateActionResult;
  savedItems: GitSavedLocalChanges[];
  statesByRoot: Map<string, GitUpdatePreservingState>;
  shouldRefresh?: boolean;
}): GitUpdateActionResult {
  const baseData = args.result.data && typeof args.result.data === "object" ? args.result.data : {};
  const roots = Array.isArray(baseData.roots)
    ? baseData.roots.map((root: any) => {
        const repoRoot = resolveRootPreservingRepoRoot(root);
        const matchedState = args.statesByRoot.get(repoRoot);
        return matchedState ? applyPreservingStateToRoot(root, matchedState) : root;
      })
    : baseData.roots;
  const representativeSaved = pickSavedChangeForRepo(args.savedItems, baseData?.requestedRepoRoot || baseData?.repoRoot);
  const representativeState = representativeSaved
    ? args.statesByRoot.get(String(representativeSaved.repoRoot || "").trim()) || args.statesByRoot.values().next().value
    : args.statesByRoot.values().next().value;
  return {
    ...args.result,
    data: {
      ...baseData,
      roots,
      savedLocalChanges: args.savedItems.length > 0 || baseData.savedLocalChanges === true || undefined,
      restoredLocalChanges: representativeState?.status === "restored" ? true : baseData.restoredLocalChanges,
      preservingState: representativeState,
      localChangesRestorePolicy: representativeState?.localChangesRestorePolicy || baseData.localChangesRestorePolicy,
      savedLocalChangesRef: representativeState?.savedLocalChangesRef || baseData.savedLocalChangesRef,
      savedLocalChangesDisplayName: representativeState?.savedLocalChangesDisplayName || baseData.savedLocalChangesDisplayName,
      savedLocalChangesEntries: buildSavedLocalChangesEntries(args.savedItems),
      shouldRefresh: args.shouldRefresh === true || baseData.shouldRefresh === true || undefined,
    },
  };
}

/**
 * 对齐 IDEA `GitPreservingProcess`，负责包裹保存/执行/恢复三阶段。
 */
export class GitPreservingProcess {
  private readonly runtime: GitUpdatePreservingProcessRuntime;

  private readonly rootsToSave: string[];

  private readonly operationTitle: string;

  private readonly destinationName: string;

  private readonly saver: GitChangesSaver;

  private isLoaded = false;

  /**
   * 初始化 preserving process；若未显式传入 saver，则按保存策略自动创建。
   */
  constructor(
    runtime: GitUpdatePreservingProcessRuntime,
    rootsToSave: string[],
    operationTitle: string,
    destinationName: string,
    saveChangesPolicy: GitUpdateSaveChangesPolicy,
    saver?: GitChangesSaver,
  ) {
    this.runtime = runtime;
    this.rootsToSave = Array.from(new Set(
      (Array.isArray(rootsToSave) ? rootsToSave : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ));
    this.operationTitle = String(operationTitle || "").trim() || "update";
    this.destinationName = String(destinationName || "").trim() || "update destination";
    this.saver = saver || GitChangesSaver.getSaver(
      adaptSingleRootSaverRuntime(runtime as any),
      saveChangesPolicy,
      `codexflow update: ${this.operationTitle} @ ${new Date().toISOString()}`,
    );
  }

  /**
   * 执行一次带 preserving 的操作；保存成功后始终走 `finally(load or keep-saved)` 顺序。
   */
  async execute(
    operation: () => Promise<GitUpdateActionResult>,
    autoLoadDecision?: (result: GitUpdateActionResult) => boolean | Promise<boolean>,
  ): Promise<GitUpdateActionResult> {
    const freezingProcess = new GitFreezingProcess(
      this.runtime,
      this.operationTitle,
      async () => {
        const saveRes = this.rootsToSave.length > 0
          ? await this.saver.trySaveLocalChanges(this.rootsToSave)
          : { ok: true as const };
        if (!saveRes.ok) {
          return {
            ok: false,
            error: saveRes.error,
          };
        }

        let operationResult: GitUpdateActionResult = { ok: false, error: `${this.operationTitle} 执行失败` };
        let operationThrew = false;
        try {
          operationResult = await operation();
        } catch (error) {
          operationThrew = true;
          operationResult = {
            ok: false,
            error: String((error as Error)?.message || `${this.operationTitle} 执行失败`),
          };
        } finally {
          const savedItems = this.getSavedLocalChangesList();
          if (savedItems.length > 0) {
            if (!operationResult.ok && operationResult.data?.resultCode !== "INCOMPLETE" && typeof this.runtime.detectIncompleteUpdateStateAsync === "function") {
              const unfinishedState = await this.runtime.detectIncompleteUpdateStateAsync(savedItems[0] || null);
              if (unfinishedState) {
                operationResult = {
                  ...operationResult,
                  data: {
                    ...(operationResult.data && typeof operationResult.data === "object" ? operationResult.data : {}),
                    resultCode: "INCOMPLETE",
                    unfinishedState,
                    localChangesRestorePolicy: unfinishedState.localChangesRestorePolicy,
                    savedLocalChangesRef: unfinishedState.savedLocalChangesRef,
                  },
                };
              }
            }
            const shouldAutoLoad = autoLoadDecision ? await autoLoadDecision(operationResult) : true;
            if (!shouldAutoLoad || operationThrew) {
              const statesByRoot = new Map<string, GitUpdatePreservingState>();
              const notRestoredReason = resolveNotRestoredReason(operationResult);
              for (const saved of savedItems) {
                const savedChangesAction = this.getSavedChangesAction(saved);
                statesByRoot.set(
                  String(saved.repoRoot || "").trim(),
                  buildPreservingState(
                    saved,
                    "kept-saved",
                    "keep-saved",
                    buildLocalChangesNotRestoredMessage(saved, notRestoredReason, this.operationTitle),
                    notRestoredReason,
                    {
                      savedChangesAction,
                    },
                  ),
                );
              }
              operationResult = mergePreservingStatesIntoResult({
                result: operationResult,
                savedItems,
                statesByRoot,
                shouldRefresh: true,
              });
            } else {
              const loadRes = await this.loadSavedChangesOnceAsync();
              const statesByRoot = new Map<string, GitUpdatePreservingState>();
              if (loadRes.ok) {
                const restoredRootSet = new Set(loadRes.restoredRoots);
                for (const saved of savedItems) {
                  const repoRoot = String(saved.repoRoot || "").trim();
                  if (!restoredRootSet.has(repoRoot)) continue;
                  statesByRoot.set(repoRoot, buildPreservingState(saved, "restored", "restore"));
                }
                operationResult = mergePreservingStatesIntoResult({
                  result: operationResult,
                  savedItems,
                  statesByRoot,
                });
              } else {
                const restoredRootSet = new Set(loadRes.restoredRoots);
                const failedRootSet = new Set(loadRes.failedRoots);
                const conflictRootSet = new Set(
                  (Array.isArray(loadRes.conflictRoots) ? loadRes.conflictRoots : [])
                    .map((item) => String(item || "").trim())
                    .filter(Boolean),
                );
                for (const saved of savedItems) {
                  const repoRoot = String(saved.repoRoot || "").trim();
                  const savedChangesAction = this.getSavedChangesAction(saved);
                  const status = restoredRootSet.has(repoRoot) ? "restored" : "restore-failed";
                  const policy = restoredRootSet.has(repoRoot) ? "restore" : "keep-saved";
                  const conflictResolverDialog = conflictRootSet.has(repoRoot)
                    ? buildRestoreConflictDialog(saved, repoRoot, this.operationTitle, this.destinationName)
                    : undefined;
                  const resolveConflictsAction = conflictResolverDialog
                    ? buildResolveConflictsAction(conflictResolverDialog)
                    : undefined;
                  statesByRoot.set(repoRoot, buildPreservingState(
                    saved,
                    status,
                    policy,
                    restoredRootSet.has(repoRoot)
                      ? undefined
                      : buildLocalChangesNotRestoredMessage(saved, "restore-failed", loadRes.error),
                    restoredRootSet.has(repoRoot) ? undefined : "restore-failed",
                    {
                      savedChangesAction,
                      resolveConflictsAction,
                      conflictResolverDialog,
                    },
                  ));
                  if (!failedRootSet.has(repoRoot) && !restoredRootSet.has(repoRoot))
                    failedRootSet.add(repoRoot);
                }
                operationResult = mergePreservingStatesIntoResult({
                  result: operationResult,
                  savedItems,
                  statesByRoot,
                  shouldRefresh: true,
                });
              }
            }
          }
        }
        return operationResult;
      },
    );
    const result = await freezingProcess.execute();
    return result || {
      ok: false,
      error: `${this.operationTitle} 执行失败`,
    };
  }

  /**
   * 执行一次性恢复保护，避免同一 preserving 过程重复 load。
   */
  private async loadSavedChangesOnceAsync(): Promise<
    | { ok: true; restoredRoots: string[] }
    | { ok: false; error: string; failedRoots: string[]; restoredRoots: string[]; conflictRoots?: string[] }
  > {
    if (this.isLoaded)
      return { ok: true, restoredRoots: this.getSavedLocalChangesList().map((item) => String(item.repoRoot || "").trim()).filter(Boolean) };
    this.isLoaded = true;
    const loadRes = await this.saver.load();
    if (loadRes.ok) {
      const restoredRoots = Array.isArray(loadRes.restoredRoots) && loadRes.restoredRoots.length > 0
        ? loadRes.restoredRoots
        : this.getSavedLocalChangesList().map((item) => String(item.repoRoot || "").trim()).filter(Boolean);
      return {
        ok: true,
        restoredRoots,
      };
    }
    return loadRes;
  }

  /**
   * 兼容旧测试替身与单仓 saver，统一读取当前 preserving 过程持有的保存记录集合。
   */
  private getSavedLocalChangesList(): GitSavedLocalChanges[] {
    const saverAny = this.saver as GitChangesSaver & {
      getSavedLocalChangesList?: () => GitSavedLocalChanges[];
      getSavedLocalChanges?: () => GitSavedLocalChanges | null;
    };
    const normalizedRepoRoot = String(this.runtime.repoRoot || "").trim() || undefined;
    const normalizeItems = (items: GitSavedLocalChanges[]): GitSavedLocalChanges[] => {
      return items.map((item) => ({
        ...item,
        repoRoot: String(item.repoRoot || normalizedRepoRoot || "").trim() || undefined,
      }));
    };
    if (typeof saverAny.getSavedLocalChangesList === "function")
      return normalizeItems(saverAny.getSavedLocalChangesList());
    const single = typeof saverAny.getSavedLocalChanges === "function" ? saverAny.getSavedLocalChanges() : null;
    return single ? normalizeItems([single]) : [];
  }

  /**
   * 兼容旧替身与新 saver，实现按 root 读取最合适的“查看已保存改动”动作。
   */
  private getSavedChangesAction(saved: GitSavedLocalChanges): GitUpdatePostAction | undefined {
    const saverAny = this.saver as GitChangesSaver & {
      getSavedChangesAction?: (savedItem: GitSavedLocalChanges) => GitUpdatePostAction | null;
      showSavedChanges?: () => GitUpdatePostAction | null;
    };
    if (typeof saverAny.getSavedChangesAction === "function")
      return saverAny.getSavedChangesAction(saved) || undefined;
    return saverAny.showSavedChanges?.() || undefined;
  }
}

/**
 * 在更新流程中临时保存单仓本地改动，统一委托给 preserving 策略层。
 */
export async function saveLocalChangesForUpdateAsync(
  runtime: GitUpdatePreservingRuntime,
  reason: string,
  saveChangesPolicy: GitUpdateSaveChangesPolicy,
): Promise<{ ok: true; saved: GitSavedLocalChanges | null } | { ok: false; error: string }> {
  if (!(await runtime.hasLocalChangesAsync()))
    return { ok: true, saved: null };
  const saver = GitChangesSaver.getSaver(
    adaptSingleRootSaverRuntime(runtime as any),
    saveChangesPolicy,
    `codexflow update: ${String(reason || "preserve").trim() || "preserve"} @ ${new Date().toISOString()}`,
  );
  const saveRes = await saver.trySaveLocalChanges([runtime.repoRoot]);
  if (!saveRes.ok) return saveRes;
  return {
    ok: true,
    saved: saver.getSavedLocalChanges(),
  };
}

/**
 * 构建“本地改动未恢复”的 preserving state，供成功/失败路径统一复用。
 */
export function notifyLocalChangesAreNotRestored(
  saved: GitSavedLocalChanges,
  reason: GitUpdatePreservingNotRestoredReason,
  error?: string,
): GitUpdatePreservingState {
  const savedChangesAction = buildSavedChangesAction(saved);
  return buildPreservingState(
    saved,
    reason === "restore-failed" ? "restore-failed" : "kept-saved",
    "keep-saved",
    buildLocalChangesNotRestoredMessage(saved, reason, error),
    reason,
    {
      savedChangesAction,
    },
  );
}

/**
 * 在更新完成后恢复之前临时保存的单仓本地改动；若恢复失败，则返回结构化 preserving state 供外层提示。
 */
export async function restoreLocalChangesAfterUpdateAsync(
  runtime: GitUpdatePreservingRuntime,
  saved: GitSavedLocalChanges | null,
): Promise<
  | { ok: true; preservingState?: GitUpdatePreservingState }
  | { ok: false; error: string; preservingState: GitUpdatePreservingState }
> {
  if (!saved) return { ok: true };
  const saver = GitChangesSaver.create(adaptSingleRootSaverRuntime(runtime as any), saved.saveChangesPolicy);
  saver.rehydrateSavedLocalChanges([saved]);
  const restoreRes = await saver.loadLocalChangesAsync(saved);
  if (!restoreRes.ok) {
    const conflictResolverDialog = Array.isArray(restoreRes.conflictRoots) && restoreRes.conflictRoots.length > 0
      ? buildRestoreConflictDialog(saved, restoreRes.conflictRoots[0] || String(saved.repoRoot || "").trim() || runtime.repoRoot)
      : undefined;
    const preservingState = buildPreservingState(
      saved,
      "restore-failed",
      "keep-saved",
      buildLocalChangesNotRestoredMessage(saved, "restore-failed", restoreRes.error),
      "restore-failed",
      {
        savedChangesAction: saver.getSavedChangesAction(saved) || buildSavedChangesAction(saved),
        resolveConflictsAction: conflictResolverDialog ? buildResolveConflictsAction(conflictResolverDialog) : undefined,
        conflictResolverDialog,
      },
    );
    return {
      ok: false,
      error: preservingState.message || restoreRes.error,
      preservingState,
    };
  }
  return {
    ok: true,
    preservingState: buildPreservingState(saved, "restored", "restore"),
  };
}

/**
 * 判断更新命令失败后仓库是否已进入未完成更新态。
 */
export async function hasIncompleteUpdateStateAsync(runtime: GitUpdatePreservingRuntime): Promise<boolean> {
  if (await runtime.isRebaseInProgressAsync()) return true;
  if (await runtime.isMergeInProgressAsync()) return true;
  return await runtime.hasUnmergedFilesAsync();
}

/**
 * 为全局 multi-root preserving 创建跨仓 saver。
 */
export function createWorkspaceChangesSaver(
  runtime: GitChangesSaverRuntime,
  saveChangesPolicy: GitUpdateSaveChangesPolicy,
  stashMessage: string,
): GitChangesSaver {
  return GitChangesSaver.getSaver(runtime, saveChangesPolicy, stashMessage);
}
