// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type {
  GitBranchPopupSnapshot,
  GitBranchCompareFilesResult,
  GitCommitAndPushPolicy,
  GitCommitDetailsActionAvailability,
  GitCommitDetailsSelectionChange,
  GitCommitHooksInfo,
  GitConflictMergeSnapshot,
  GitConflictMergeSessionSnapshot,
  GitConflictResolverActionResult,
  GitDiffMode,
  GitDiffSnapshot,
  GitInteractiveRebaseAction,
  GitInteractiveRebasePlan,
  GitInteractiveRebasePlanResult,
  GitIgnoreTarget,
  GitIgnoreTargetsSnapshot,
  GitLogActionAvailability,
  GitLogDetails,
  GitLogFilters,
  GitLogPage,
  GitIgnoredStatusSnapshot,
  GitLogItem,
  GitLogMessageDraft,
  GitMoveFilesToChangeListEntryState,
  GitPullOptions,
  GitPushPreview,
  GitConsoleEntry,
  GitManualShelveSelection,
  GitPostCommitPushResult,
  GitRollbackRequestChange,
  GitShelfItem,
  GitShelfViewState,
  GitStashItem,
  GitStatusSnapshot,
  GitUpdateOptions,
  GitUpdateOptionMethod,
  GitUpdateOptionsSnapshot,
  GitUpdateSessionProgressSnapshot,
  GitUpdateTrackedBranchPreview,
  GitUpdateTrackedBranchSelection,
  GitWorktreeItem,
} from "./types";
import {
  GIT_WORKBENCH_COMMIT_STAGE_ACTION_ID,
  GIT_WORKBENCH_SHOW_STAGE_ACTION_ID,
  isGitWorkbenchCommitLikeActionId,
  type GitWorkbenchPublicActionId,
} from "./git-workbench-bridge";
import type { CommitWorkflowSelectionItem } from "./commit-panel/types";
import type { CommitAdvancedOptionsPayload } from "./commit-panel/commit-options-model";
import type { GitCommitCheck } from "./commit-panel/checks";
import type { PushAfterCommitContext } from "./push-after-commit";
import { resolveGitText } from "./git-i18n";

export type GitFeatureResponse<T = any> = {
  ok: boolean;
  data?: T;
  error?: string;
  meta?: {
    requestId: number;
  };
};

export type GitFeatureActivity = {
  requestId: number;
  action: string;
  phase: "start" | "progress" | "finish";
  message: string;
  isConsoleAction: boolean;
  ok?: boolean;
  detail?: string;
  repoRoot?: string;
  updateSession?: GitUpdateSessionProgressSnapshot;
};

type GitFeatureActivityListener = (activity: GitFeatureActivity) => void;

const gitFeatureActivityListeners = new Set<GitFeatureActivityListener>();
const SILENT_GIT_ACTIVITY_ACTIONS = new Set<string>([
  "changes.writeWorkingFile",
  "changes.conflictResolver.get",
  "log.availability",
  "log.details.availability",
  "request.cancel",
  "update.options.get",
  "update.options.set",
]);

let gitFeatureActivitySeq = 0;
const gitFeatureProgressBridgeState: {
  installed: boolean;
} = (globalThis as any).__cf_git_feature_progress_bridge_state__ || ((globalThis as any).__cf_git_feature_progress_bridge_state__ = {
  installed: false,
});

/**
 * 向 Git 活动监听器广播状态变化，供工作台状态栏和控制台按需联动。
 */
function emitGitFeatureActivity(activity: GitFeatureActivity): void {
  for (const listener of gitFeatureActivityListeners) {
    try {
      listener(activity);
    } catch {}
  }
}

/**
 * 安装主进程 Git 进度事件桥接，把长操作过程步骤转为前端统一活动流。
 */
function ensureGitFeatureProgressBridge(): void {
  if (gitFeatureProgressBridgeState.installed) return;
  gitFeatureProgressBridgeState.installed = true;
  try {
    window.host.gitFeature?.onProgress?.((payload) => {
      const requestId = Math.max(0, Math.floor(Number(payload?.requestId) || 0));
      const action = String(payload?.action || "").trim();
      if (!requestId || !action) return;
      emitGitFeatureActivity({
        requestId,
        action,
        phase: "progress",
        message: String(payload?.message || "").trim() || resolveGitText("activity.progress.processing", "处理中"),
        detail: String(payload?.detail || "").trim() || undefined,
        repoRoot: String(payload?.repoRoot || "").trim() || undefined,
        updateSession: payload?.updateSession,
        isConsoleAction: isConsoleAction(action),
      });
    });
  } catch {}
}

/**
 * 判断当前动作是否属于 Git 控制台自身读写，避免触发额外的控制台自刷新。
 */
function isConsoleAction(action: string): boolean {
  return action === "console.get" || action === "console.clear";
}

/**
 * 判断当前动作是否需要进入 Git 活动状态栏统计，避免高频内部请求造成闪烁。
 */
function shouldEmitGitFeatureActivity(action: string): boolean {
  return !SILENT_GIT_ACTIVITY_ACTIONS.has(action);
}

/**
 * 根据分支动作参数生成面向状态栏的简短提示文案。
 */
function resolveBranchActionMessage(payload: any): string {
  const action = String(payload?.action || "").trim();
  switch (action) {
    case "new":
    case "newFrom":
      return resolveGitText("activity.branchAction.new", "新建分支");
    case "rename":
      return resolveGitText("activity.branchAction.rename", "重命名分支");
    case "delete":
      return resolveGitText("activity.branchAction.delete", "删除分支");
    case "deleteRemote":
      return resolveGitText("activity.branchAction.deleteRemote", "删除远端分支");
    case "addRemote":
      return resolveGitText("activity.branchAction.addRemote", "新增远端");
    case "editRemote":
      return resolveGitText("activity.branchAction.editRemote", "编辑远端");
    case "removeRemote":
      return resolveGitText("activity.branchAction.removeRemote", "移除远端");
    case "configureRemotes":
      return resolveGitText("activity.branchAction.configureRemotes", "配置远端");
    case "checkoutUpdate":
      return resolveGitText("activity.branchAction.checkoutUpdate", "签出并更新分支");
    case "checkoutRebaseToBranch":
    case "checkoutRebaseToMaster":
    case "checkoutRebaseCurrent":
    case "rebaseCurrentToTarget":
      return resolveGitText("activity.branchAction.rebase", "执行分支变基");
    case "mergeTargetToCurrent":
      return resolveGitText("activity.branchAction.merge", "执行分支合并");
    case "compareCurrent":
    case "worktreeDiff":
    case "compareFiles":
      return resolveGitText("activity.branchAction.compare", "加载分支差异");
    case "setShowOnlyMy":
      return resolveGitText("activity.branchAction.toggleMine", "切换我的分支筛选");
    case "updateBranch":
      return resolveGitText("activity.branchAction.updateBranch", "更新目标分支");
    case "pushBranch":
      return resolveGitText("activity.branchAction.pushBranch", "推送目标分支");
    case "createWorktree":
      return resolveGitText("activity.branchAction.createWorktree", "创建工作树");
    case "openExistingWorktree":
      return resolveGitText("activity.branchAction.openExistingWorktree", "打开已签出的工作树");
    case "pullRemote":
      return resolveGitText("activity.branchAction.pullRemote", "拉取远端分支");
    default:
      return resolveGitText("activity.branchAction.default", "执行分支操作");
  }
}

/**
 * 将底层 action 转换为状态栏可读文案，统一复用在 Git 工作台活动提示中。
 */
function resolveGitFeatureActivityMessage(action: string, payload?: any): string {
  switch (action) {
    case "repo.detect":
    case "status.get":
    case "branch.popup":
    case "shelf.list":
    case "stash.list":
    case "worktree.list":
      return resolveGitText("activity.actions.refreshWorkbench", "刷新 Git 工作台");
    case "repo.init":
      return resolveGitText("activity.actions.initRepo", "初始化 Git 仓库");
    case "branch.switch":
      return resolveGitText("activity.actions.switchBranch", "签出分支");
    case "branch.action":
      return resolveBranchActionMessage(payload);
    case "operation.continue":
      return resolveGitText("activity.actions.continueOperation", "继续 Git 操作");
    case "operation.abort":
      return resolveGitText("activity.actions.abortOperation", "中止 Git 操作");
    case "commit.create":
      return resolveGitText("activity.actions.createCommit", "创建提交");
    case "changes.rollback":
      return resolveGitText("activity.actions.rollbackChanges", "回滚文件变更");
    case "changes.delete":
      return resolveGitText("activity.actions.deleteFiles", "删除文件");
    case "changes.stage":
      return resolveGitText("activity.actions.stageFiles", "暂存文件");
    case "changes.unstage":
      return resolveGitText("activity.actions.unstageFiles", "从暂存区移除文件");
    case "changes.revertUnstaged":
      return resolveGitText("activity.actions.revertUnstaged", "还原未暂存更改");
    case "changes.conflictMerge.get":
      return resolveGitText("activity.actions.readConflictContent", "读取冲突内容");
    case "changes.restoreFromRevision":
      return resolveGitText("activity.actions.restoreFromRevision", "从修订恢复文件");
    case "diff.get":
      return resolveGitText("activity.actions.loadDiff", "加载差异");
    case "diff.patch":
      return resolveGitText("activity.actions.exportPatch", "导出补丁");
    case "log.get":
      return Number(payload?.cursor || 0) > 0
        ? resolveGitText("activity.actions.loadMoreHistory", "加载更多提交历史")
        : resolveGitText("activity.actions.loadHistory", "加载提交历史");
    case "log.details":
      return resolveGitText("activity.actions.readCommitDetails", "读取提交详情");
    case "log.details.availability":
      return resolveGitText("activity.actions.readCommitDetailActions", "读取提交详情动作");
    case "log.details.action":
      return resolveGitText("activity.actions.runCommitDetailAction", "执行提交详情动作");
    case "log.messageDraft":
      return resolveGitText("activity.actions.prepareCommitMessage", "准备提交消息");
    case "log.rebasePlan.get":
      return resolveGitText("activity.actions.prepareInteractiveRebase", "准备交互式变基");
    case "log.rebasePlan.run":
      return resolveGitText("activity.actions.runInteractiveRebase", "执行交互式变基");
    case "log.resolveFileHistoryPath":
      return resolveGitText("activity.actions.resolveFileHistoryPath", "解析文件历史路径");
    case "log.action":
      return resolveGitText("activity.actions.runLogAction", "执行日志操作");
    case "flow.fetch":
      return resolveGitText("activity.actions.fetchRemoteChanges", "获取远端变更");
    case "flow.pull":
      return resolveGitText("activity.actions.updateCurrentBranch", "更新当前分支");
    case "flow.push":
      return resolveGitText("activity.actions.pushToRemote", "推送到远端");
    case "update.trackedBranchPreview":
      return resolveGitText("activity.actions.readTrackedBranchFix", "读取跟踪分支修复建议");
    case "update.trackedBranchApply":
      return resolveGitText("activity.actions.applyTrackedBranchFix", "应用跟踪分支修复");
    case "push.preview":
      return resolveGitText("activity.actions.readPushPreview", "读取推送预览");
    case "push.execute":
      return resolveGitText("activity.actions.pushToRemote", "推送到远端");
    case "shelf.create":
      return resolveGitText("activity.actions.createShelf", "创建搁置");
    case "shelf.import":
      return resolveGitText("activity.actions.importShelfPatch", "导入搁置补丁");
    case "shelf.restore":
      return resolveGitText("activity.actions.restoreShelf", "取消搁置");
    case "shelf.delete":
      return resolveGitText("activity.actions.deleteShelf", "删除搁置");
    case "stash.create":
      return resolveGitText("activity.actions.createStash", "创建暂存");
    case "stash.apply":
      return resolveGitText("activity.actions.applyStash", "恢复暂存");
    case "stash.drop":
      return resolveGitText("activity.actions.dropStash", "删除暂存");
    case "worktree.add":
      return resolveGitText("activity.actions.addWorktree", "新增工作树");
    case "worktree.remove":
      return resolveGitText("activity.actions.removeWorktree", "移除工作树");
    case "console.get":
      return resolveGitText("activity.actions.readGitConsole", "读取 Git 控制台");
    case "console.clear":
      return resolveGitText("activity.actions.clearGitConsole", "清空 Git 控制台");
    case "changesView.setOption":
    case "changesView.setGroupingKeys":
      return resolveGitText("activity.actions.updateChangesView", "更新更改视图");
    case "localChanges.setOption":
    case "changelist.create":
    case "changelist.rename":
    case "changelist.delete":
    case "changelist.setActive":
    case "changelist.moveFiles":
    case "changelist.updateData":
      return resolveGitText("activity.actions.updateChangeLists", "更新变更列表");
    default:
      return resolveGitText("activity.actions.default", "处理 Git 操作");
  }
}

/**
 * 订阅 Git 活动状态，用于工作台状态栏与控制台按需刷新。
 */
export function subscribeGitFeatureActivity(listener: GitFeatureActivityListener): () => void {
  ensureGitFeatureProgressBridge();
  gitFeatureActivityListeners.add(listener);
  return () => {
    gitFeatureActivityListeners.delete(listener);
  };
}

/**
 * 统一调用主进程 Git 功能入口。
 */
export async function callGitFeatureAsync<T>(action: string, payload?: any): Promise<GitFeatureResponse<T>> {
  const normalizedAction = String(action || "").trim();
  const requestId = gitFeatureActivitySeq + 1;
  gitFeatureActivitySeq = requestId;
  const message = resolveGitFeatureActivityMessage(normalizedAction, payload);
  const emitActivity = shouldEmitGitFeatureActivity(normalizedAction);
  const consoleAction = isConsoleAction(normalizedAction);
  if (emitActivity) {
    emitGitFeatureActivity({
      requestId,
      action: normalizedAction,
      phase: "start",
      message,
      isConsoleAction: consoleAction,
    });
  }
  try {
    const res = await window.host.gitFeature?.call({ action: normalizedAction, payload, requestId });
    const normalizedResponse = res
      ? ({
          ...(res as GitFeatureResponse<T>),
          meta: {
            requestId,
          },
        } satisfies GitFeatureResponse<T>)
      : { ok: false, error: resolveGitText("activity.errors.featureUnavailable", "Git 功能不可用"), meta: { requestId } };
    if (emitActivity) {
      emitGitFeatureActivity({
        requestId,
        action: normalizedAction,
        phase: "finish",
        message,
        isConsoleAction: consoleAction,
        ok: normalizedResponse.ok,
      });
    }
    return normalizedResponse;
  } catch (e: any) {
    if (emitActivity) {
      emitGitFeatureActivity({
        requestId,
        action: normalizedAction,
        phase: "finish",
        message,
        isConsoleAction: consoleAction,
        ok: false,
      });
    }
    return { ok: false, error: String(e?.message || e), meta: { requestId } };
  }
}

/**
 * 检测目录是否 Git 仓库。
 */
export async function detectRepoAsync(repoPath: string): Promise<GitFeatureResponse<{ isRepo: boolean; repoRoot?: string; branch?: string; detached?: boolean; headSha?: string; error?: string }>> {
  return await callGitFeatureAsync("repo.detect", { repoPath });
}

/**
 * 初始化 Git 仓库。
 */
export async function initRepoAsync(dir: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("repo.init", { dir });
}

/**
 * 读取分支弹窗数据。
 */
export async function getBranchPopupAsync(repoPath: string): Promise<GitFeatureResponse<GitBranchPopupSnapshot>> {
  return await callGitFeatureAsync("branch.popup", { repoPath });
}

/**
 * 切换分支或修订。
 */
export async function switchBranchAsync(repoPath: string, ref: string, payload?: any): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("branch.switch", { repoPath, ref, ...(payload && typeof payload === "object" ? payload : {}) });
}

/**
 * 执行分支相关动作。
 */
export async function runBranchActionAsync(repoPath: string, payload: any): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("branch.action", { repoPath, ...payload });
}

/**
 * 读取两侧引用之间的文件差异列表，统一承接“分支 vs 分支 / 分支 vs 工作树”文件比较入口。
 */
export async function getBranchCompareFilesAsync(
  repoPath: string,
  payload: { leftRef: string; rightRef?: string },
): Promise<GitFeatureResponse<GitBranchCompareFilesResult>> {
  return await callGitFeatureAsync("branch.action", { repoPath, action: "compareFiles", ...payload });
}

/**
 * 继续当前仓库中的进行中 Git 操作，统一支持 rebase / merge / cherry-pick / revert。
 */
export async function continueRepositoryOperationAsync(repoPath: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("operation.continue", { repoPath });
}

/**
 * 中止当前仓库中的进行中 Git 操作，统一支持 rebase / merge / cherry-pick / revert。
 */
export async function abortRepositoryOperationAsync(repoPath: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("operation.abort", { repoPath });
}

/**
 * 读取工作区状态和变更列表。
 */
export async function getStatusAsync(repoPath: string): Promise<GitFeatureResponse<GitStatusSnapshot>> {
  return await callGitFeatureAsync("status.get", { repoPath });
}

/**
 * 独立读取已忽略文件快照。
 */
export async function getIgnoredStatusAsync(repoPath: string): Promise<GitFeatureResponse<GitIgnoredStatusSnapshot>> {
  return await callGitFeatureAsync("status.getIgnored", { repoPath });
}

/**
 * 预览 ignored special node 可用的 ignore 目标。
 */
export async function getIgnoreTargetsAsync(repoPath: string, paths: string[]): Promise<GitFeatureResponse<GitIgnoreTargetsSnapshot>> {
  return await callGitFeatureAsync("changes.ignoreTargets", { repoPath, paths });
}

/**
 * 把未跟踪文件写入用户选择的 ignore 目标。
 */
export async function ignoreFilesAsync(repoPath: string, paths: string[], target: GitIgnoreTarget): Promise<GitFeatureResponse<{ repoRoot: string; paths: string[]; target: GitIgnoreTarget; addedCount: number }>> {
  return await callGitFeatureAsync("changes.ignore", { repoPath, paths, target });
}

/**
 * 设置提交面板视图选项。
 */
export async function setChangesViewOptionAsync(
  repoPath: string,
  key: "groupByDirectory" | "showIgnored" | "detailsPreviewShown" | "diffPreviewOnDoubleClickOrEnter",
  value: boolean,
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changesView.setOption", { repoPath, key, value });
}

/**
 * 设置提交面板 grouping key 集，用于对齐 IDEA 的 directory/module/repository 组合分组。
 */
export async function setCommitGroupingKeysAsync(
  repoPath: string,
  groupingKeys: Array<"directory" | "module" | "repository">,
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changesView.setGroupingKeys", { repoPath, groupingKeys });
}

/**
 * 设置“配置本地更改”开关。
 */
export async function setLocalChangesOptionAsync(repoPath: string, key: "stagingAreaEnabled" | "changeListsEnabled" | "commitAllEnabled", value: boolean): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("localChanges.setOption", { repoPath, key, value });
}

/**
 * 新建变更列表。
 */
export async function createChangeListAsync(
  repoPath: string,
  name: string,
  options?: { setActive?: boolean },
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changelist.create", { repoPath, name, setActive: options?.setActive === true });
}

/**
 * 编辑变更列表。
 */
export async function renameChangeListAsync(repoPath: string, id: string, name: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changelist.rename", { repoPath, id, name });
}

/**
 * 删除变更列表。
 */
export async function deleteChangeListAsync(repoPath: string, id: string, targetListId?: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changelist.delete", { repoPath, id, targetListId });
}

/**
 * 设置活动更改列表。
 */
export async function setActiveChangeListAsync(repoPath: string, id: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changelist.setActive", { repoPath, id });
}

/**
 * 移动文件到目标变更列表。
 */
export async function moveFilesToChangeListAsync(
  repoPath: string,
  paths: string[],
  targetListId: string,
  entries?: GitMoveFilesToChangeListEntryState[],
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changelist.moveFiles", { repoPath, paths, targetListId, entries });
}

/**
 * 更新 changelist 的 comment/data 元数据，供按列表保存提交草稿、作者与作者时间复用。
 */
export async function updateChangeListDataAsync(
  repoPath: string,
  id: string,
  patch: { comment?: string | null; data?: Record<string, any> | null },
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changelist.updateData", { repoPath, id, ...patch });
}

/**
 * 创建提交。
 */
export async function createCommitAsync(
  repoPath: string,
  filesOrPayload: string[] | {
    files?: string[];
    message: string;
    intent?: "commit" | "commitAndPush";
    pushAfter: boolean;
    amend?: boolean;
    confirmedChecks?: string[];
    selections?: CommitWorkflowSelectionItem[];
    includedItems?: Array<{ path: string; kind: "change" | "unversioned" | "ignored" }>;
  } & CommitAdvancedOptionsPayload,
  message?: string,
  pushAfter?: boolean,
): Promise<GitFeatureResponse<{
  commitHash?: string;
  commitSucceeded?: boolean;
  mergeExclusionRequired?: boolean;
  commitHashes?: Array<{ repoRoot?: string; commitHash?: string }>;
  repoRoots?: string[];
  pushAfterCommit?: PushAfterCommitContext;
  postCommitPush?: GitPostCommitPushResult;
  checks?: GitCommitCheck[];
  blockingCheck?: GitCommitCheck;
  confirmationChecks?: GitCommitCheck[];
}>> {
  const payload = Array.isArray(filesOrPayload)
    ? {
        files: filesOrPayload,
        message: String(message || ""),
        intent: pushAfter === true ? "commitAndPush" : "commit",
        pushAfter: pushAfter === true,
      }
    : filesOrPayload;
  return await callGitFeatureAsync("commit.create", { repoPath, ...payload });
}

/**
 * 读取提交面板偏好，供 commit-and-push 与 hooks 选项共用同一份持久化配置。
 */
export async function getCommitPanelPreferencesAsync(repoPath: string): Promise<GitFeatureResponse<{
  commitAndPush: GitCommitAndPushPolicy;
  commitHooks: GitCommitHooksInfo;
}>> {
  return await callGitFeatureAsync("commit.preferences.get", { repoPath });
}

/**
 * 保存提交面板偏好，并返回最新快照以便前端即时回填。
 */
export async function saveCommitPanelPreferencesAsync(
  repoPath: string,
  payload: {
    commitAndPush?: Partial<GitCommitAndPushPolicy>;
    hooks?: { disableRunCommitHooks?: boolean };
  },
): Promise<GitFeatureResponse<{
  commitAndPush: GitCommitAndPushPolicy;
  commitHooks: GitCommitHooksInfo;
}>> {
  return await callGitFeatureAsync("commit.preferences.set", { repoPath, ...payload });
}

/**
 * 回滚文件。
 */
export async function rollbackFilesAsync(repoPath: string, files: string[]): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changes.rollback", { repoPath, files });
}

/**
 * 按结构化状态条目回滚文件，确保 NEW/MOVED/DELETED 等语义对齐后端 rollback 环境。
 */
export async function rollbackChangesAsync(
  repoPath: string,
  changes: GitRollbackRequestChange[],
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changes.rollback", { repoPath, changes });
}

/**
 * 删除文件。
 */
export async function deleteFilesAsync(
  repoPath: string,
  files: string[],
  untrackedFiles: string[],
  deleteTargets?: string[],
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changes.delete", { repoPath, files, untrackedFiles, deleteTargets });
}

/**
 * 优选（暂存）文件。
 */
export type GitStageFilesMode = "content" | "intentToAdd";

/**
 * 执行 Git Stage 动作；默认写入文件内容，也可切换为 intent-to-add。
 */
export async function stageFilesAsync(
  repoPath: string,
  files: string[],
  options?: { mode?: GitStageFilesMode },
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changes.stage", {
    repoPath,
    files,
    mode: options?.mode,
  });
}

/**
 * 从暂存区移除指定文件，但保留工作区改动。
 */
export async function unstageFilesAsync(repoPath: string, files: string[]): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changes.unstage", { repoPath, files });
}

/**
 * 仅还原工作区中的未暂存改动，对齐 Git Stage Revert 语义。
 */
export async function revertUnstagedFilesAsync(repoPath: string, files: string[]): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changes.revertUnstaged", { repoPath, files });
}

/**
 * 从指定修订恢复文件内容到工作区。
 */
export async function restoreFilesFromRevisionAsync(
  repoPath: string,
  files: string[],
  revision?: string,
  options?: {
    overwriteModified?: boolean;
  },
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changes.restoreFromRevision", {
    repoPath,
    files,
    revision,
    overwriteModified: options?.overwriteModified === true,
  });
}

/**
 * 写回工作区文件内容（供可编辑 Diff 使用）。
 */
export async function writeWorkingFileAsync(repoPath: string, path: string, content: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("changes.writeWorkingFile", { repoPath, path, content });
}

/**
 * 读取指定冲突文件的 base/ours/theirs/working 快照，供应用内 merge 对话框展示。
 */
export async function getConflictMergeSnapshotAsync(
  repoPath: string,
  path: string,
  options?: { reverse?: boolean },
): Promise<GitFeatureResponse<GitConflictMergeSnapshot>> {
  return await callGitFeatureAsync("changes.conflictMerge.get", {
    repoPath,
    path,
    reverse: options?.reverse === true,
  });
}

/**
 * 读取统一冲突 resolver 列表所需的条目元数据，补齐批量采用 ours/theirs 前的可视状态。
 */
export async function getConflictResolverEntriesAsync(
  repoPath: string,
  paths: string[],
  options?: { reverse?: boolean },
): Promise<GitFeatureResponse<GitConflictMergeSessionSnapshot>> {
  return await callGitFeatureAsync("changes.conflictResolver.get", {
    repoPath,
    paths,
    reverse: options?.reverse === true,
  });
}

/**
 * 批量采用 ours/theirs 并加入索引，供统一冲突入口复用。
 */
export async function applyConflictResolverSideAsync(
  repoPath: string,
  payload: { paths: string[]; side: "ours" | "theirs"; reverse?: boolean },
): Promise<GitFeatureResponse<GitConflictResolverActionResult>> {
  return await callGitFeatureAsync("changes.conflictResolver.apply", {
    repoPath,
    ...payload,
  });
}

/**
 * 读取双栏 Diff 内容。
 */
export async function getDiffAsync(
  repoPath: string,
  payload: { path: string; mode: GitDiffMode; hash?: string; hashes?: string[]; oldPath?: string; shelfRef?: string },
): Promise<GitFeatureResponse<GitDiffSnapshot>> {
  return await callGitFeatureAsync("diff.get", { repoPath, ...payload });
}

/**
 * 导出指定变更对象的原始 patch 文本。
 */
export async function getDiffPatchAsync(
  repoPath: string,
  payload: { path: string; mode: GitDiffMode; hash?: string; hashes?: string[]; oldPath?: string; shelfRef?: string },
): Promise<GitFeatureResponse<{ path: string; mode: string; patch: string }>> {
  return await callGitFeatureAsync("diff.patch", { repoPath, ...payload });
}

/**
 * 为当前 Diff 解析一个可供外部 IDE / 系统程序直接打开的真实文件路径。
 */
export async function getDiffOpenPathAsync(
  repoPath: string,
  payload: { path: string; mode: GitDiffMode; hash?: string; hashes?: string[]; oldPath?: string; shelfRef?: string },
): Promise<GitFeatureResponse<{ path: string; temporary?: boolean }>> {
  return await callGitFeatureAsync("diff.openPath", { repoPath, ...payload });
}

/**
 * 读取日志列表。
 */
export async function getLogAsync(repoPath: string, cursor: number, limit: number, filters: GitLogFilters): Promise<GitFeatureResponse<GitLogPage>> {
  return await callGitFeatureAsync("log.get", { repoPath, cursor, limit, filters });
}

/**
 * 解析文件历史模式下指定提交对应的真实文件路径，供自动联动 Diff 使用。
 */
export async function resolveFileHistoryPathAsync(
  repoPath: string,
  payload: { path: string; hash: string; revision?: string },
): Promise<GitFeatureResponse<{ path: string }>> {
  return await callGitFeatureAsync("log.resolveFileHistoryPath", { repoPath, ...payload });
}

/**
 * 读取日志详情（单选/多选）。
 */
export async function getLogDetailsAsync(repoPath: string, hashes: string[]): Promise<GitFeatureResponse<GitLogDetails>> {
  return await callGitFeatureAsync("log.details", { repoPath, hashes });
}

/**
 * 读取提交详情右键动作可用性，统一由主进程按 committed changes 语义判定 visible/enabled。
 */
export async function getLogDetailsActionAvailabilityAsync(
  repoPath: string,
  payload: {
    hash?: string;
    selectedChanges?: GitCommitDetailsSelectionChange[];
    allChanges?: GitCommitDetailsSelectionChange[];
  },
): Promise<GitFeatureResponse<GitCommitDetailsActionAvailability>> {
  return await callGitFeatureAsync("log.details.availability", { repoPath, ...(payload || {}) });
}

/**
 * 执行提交详情 committed changes 动作，避免回退为 working tree 文件操作。
 */
export async function runLogDetailsActionAsync(
  repoPath: string,
  payload: {
    action: "openRepositoryVersion" | "revertSelectedChanges" | "applySelectedChanges" | "extractSelectedChanges" | "dropSelectedChanges";
    hash?: string;
    selectedChanges?: GitCommitDetailsSelectionChange[];
    allChanges?: GitCommitDetailsSelectionChange[];
    message?: string;
    targetChangeListId?: string;
  },
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("log.details.action", { repoPath, ...(payload || {}) });
}

/**
 * 读取日志动作默认消息草稿（如 reword / squash 的初始文本）。
 */
export async function getLogMessageDraftAsync(
  repoPath: string,
  action: "editMessage" | "squashCommits",
  hashes: string[],
): Promise<GitFeatureResponse<GitLogMessageDraft>> {
  return await callGitFeatureAsync("log.messageDraft", { repoPath, action, hashes });
}

/**
 * 读取 interactive rebase 编辑器所需的提交计划快照。
 */
export async function getInteractiveRebasePlanAsync(
  repoPath: string,
  targetHash: string,
): Promise<GitFeatureResponse<GitInteractiveRebasePlanResult>> {
  return await callGitFeatureAsync("log.rebasePlan.get", { repoPath, targetHash });
}

/**
 * 提交 interactive rebase 编辑器中的计划变更并执行真实 `git rebase -i`。
 */
export async function runInteractiveRebasePlanAsync(
  repoPath: string,
  payload: {
    targetHash: string;
    headHash: string;
    entries: Array<{ hash: string; action: GitInteractiveRebaseAction; message?: string }>;
  },
): Promise<GitFeatureResponse<{ shouldRefresh?: boolean; operationState?: string; completed?: boolean }>> {
  return await callGitFeatureAsync("log.rebasePlan.run", { repoPath, ...payload });
}

/**
 * 读取日志右键动作可用性（统一由主进程按真实 Git 状态判定）。
 */
export async function getLogActionAvailabilityAsync(
  repoPath: string,
  hashes: string[],
  options?: { selectionCount?: number },
): Promise<GitFeatureResponse<GitLogActionAvailability>> {
  return await callGitFeatureAsync("log.availability", { repoPath, hashes, selectionCount: options?.selectionCount });
}

/**
 * 执行日志右键动作。
 */
export async function runLogActionAsync(repoPath: string, payload: any): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("log.action", { repoPath, ...payload });
}

/**
 * 执行 fetch/pull/push。
 */
export async function runFlowAsync(repoPath: string, action: "fetch" | "pull" | "push", payload?: any): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync(`flow.${action}`, { repoPath, ...(payload || {}) });
}

/**
 * 读取 Update Project 的 tracked branch 修复建议。
 */
export async function getUpdateTrackedBranchPreviewAsync(
  repoPath: string,
  payload?: any,
): Promise<GitFeatureResponse<GitUpdateTrackedBranchPreview>> {
  return await callGitFeatureAsync("update.trackedBranchPreview", { repoPath, ...(payload || {}) });
}

/**
 * 应用用户在修复对话框中选择的 tracked branch 配置。
 */
export async function applyUpdateTrackedBranchSelectionsAsync(
  repoPath: string,
  selections: GitUpdateTrackedBranchSelection[],
  updateMethod: GitUpdateOptionMethod,
): Promise<GitFeatureResponse<{ updatePayloadPatch: { updateTrackedBranches: Record<string, any>; updateMethod: GitUpdateOptionMethod }; appliedRoots: string[]; persistedRoots: string[] }>> {
  return await callGitFeatureAsync("update.trackedBranchApply", { repoPath, selections, updateMethod });
}

/**
 * 读取当前仓库的 Update Project 正式选项与生效策略预览。
 */
export async function getUpdateOptionsAsync(
  repoPath: string,
  payload?: any,
): Promise<GitFeatureResponse<GitUpdateOptionsSnapshot>> {
  return await callGitFeatureAsync("update.options.get", { repoPath, ...(payload || {}) });
}

/**
 * 保存 Update Project 正式选项，并返回最新的持久化快照。
 */
export async function saveUpdateOptionsAsync(
  repoPath: string,
  options: Partial<GitUpdateOptions>,
): Promise<GitFeatureResponse<GitUpdateOptionsSnapshot>> {
  return await callGitFeatureAsync("update.options.set", { repoPath, options });
}

/**
 * 单独保存 Pull 对话框持久化选项，复用统一 update options 存储文件而不污染 Update Project 表单提交口径。
 */
export async function savePullOptionsAsync(
  repoPath: string,
  pull: GitPullOptions,
): Promise<GitFeatureResponse<GitUpdateOptionsSnapshot>> {
  return await callGitFeatureAsync("update.options.set", { repoPath, options: { pull } });
}

/**
 * 读取统一搁置列表。
 */
export async function getShelvesAsync(repoPath: string): Promise<GitFeatureResponse<{ items: GitShelfItem[]; viewState?: GitShelfViewState }>> {
  return await callGitFeatureAsync("shelf.list", { repoPath });
}

/**
 * 创建统一搁置记录。
 */
export async function createShelveAsync(
  repoPath: string,
  message: string,
  selection: GitManualShelveSelection,
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("shelf.create", { repoPath, message, selection });
}

/**
 * 把外部 patch/diff 文件导入统一 shelf 平台，供后续在同一套列表中恢复。
 */
export async function importShelvePatchFilesAsync(
  repoPath: string,
  filePaths: string[],
): Promise<GitFeatureResponse<{ items: GitShelfItem[]; failed?: Array<{ path: string; error: string }> }>> {
  return await callGitFeatureAsync("shelf.import", { repoPath, filePaths });
}

/**
 * 恢复统一搁置记录。
 */
export async function restoreShelveAsync(
  repoPath: string,
  ref: string,
  options?: {
    selectedPaths?: string[];
    targetChangeListId?: string;
    removeAppliedFromShelf?: boolean;
  },
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("shelf.restore", { repoPath, ref, ...(options || {}) });
}

/**
 * 重命名统一搁置记录。
 */
export async function renameShelveAsync(repoPath: string, ref: string, message: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("shelf.rename", { repoPath, ref, message });
}

/**
 * 把统一搁置记录移入回收区。
 */
export async function recycleShelveAsync(repoPath: string, ref: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("shelf.recycle", { repoPath, ref });
}

/**
 * 把回收区或已删除列表中的搁置记录恢复回活动视图。
 */
export async function restoreArchivedShelveAsync(repoPath: string, ref: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("shelf.restoreArchived", { repoPath, ref });
}

/**
 * 保存 shelf 面板的 showRecycled/groupByDirectory 视图状态。
 */
export async function saveShelfViewStateAsync(
  repoPath: string,
  payload: Partial<GitShelfViewState>,
): Promise<GitFeatureResponse<{ viewState: GitShelfViewState }>> {
  return await callGitFeatureAsync("shelf.view.set", { repoPath, ...payload });
}

/**
 * 删除统一搁置记录。
 */
export async function deleteShelveAsync(repoPath: string, ref: string, permanently?: boolean): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("shelf.delete", { repoPath, ref, permanently });
}

/**
 * 按 requestId 请求主进程取消当前正在执行的 Git 长操作。
 */
export async function cancelGitFeatureRequestAsync(
  targetRequestId: number,
  reason?: string,
): Promise<GitFeatureResponse<{ targetRequestId: number; cancelled: boolean }>> {
  return await callGitFeatureAsync("request.cancel", {
    targetRequestId,
    reason,
  });
}

/**
 * 读取推送预览信息（分支映射、待推送提交与文件）。
 */
export async function getPushPreviewAsync(repoPath: string, payload?: { targetHash?: string }): Promise<GitFeatureResponse<GitPushPreview>> {
  return await callGitFeatureAsync("push.preview", { repoPath, ...(payload || {}) });
}

/**
 * 执行推送（支持强制推送、推送标签、目标提交）。
 */
export async function executePushAsync(
  repoPath: string,
  payload?: { targetHash?: string; forceWithLease?: boolean; forcePush?: boolean; force?: boolean; pushTags?: boolean; pushTagMode?: "all" | "follow"; setUpstream?: boolean; updateIfRejected?: boolean; skipHook?: boolean; skipHooks?: boolean },
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("push.execute", { repoPath, ...(payload || {}) });
}

/**
 * 读取暂存列表。
 */
export async function getStashListAsync(repoPath: string): Promise<GitFeatureResponse<{ items: GitStashItem[] }>> {
  return await callGitFeatureAsync("stash.list", { repoPath });
}

/**
 * 创建暂存。
 */
export async function createStashAsync(
  repoPath: string,
  message?: string,
  includeUntracked: boolean = false,
  files?: string[],
  options?: {
    keepIndex?: boolean;
  },
): Promise<GitFeatureResponse<{ warning?: string }>> {
  return await callGitFeatureAsync("stash.create", { repoPath, message, includeUntracked, files, ...(options || {}) });
}

/**
 * 应用或弹出暂存。
 */
export async function applyStashAsync(
  repoPath: string,
  ref: string,
  pop: boolean,
  options?: {
    reinstateIndex?: boolean;
    branchName?: string;
  },
): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("stash.apply", { repoPath, ref, pop, ...(options || {}) });
}

/**
 * 删除暂存。
 */
export async function dropStashAsync(repoPath: string, ref: string): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("stash.drop", { repoPath, ref });
}

/**
 * 读取 Worktree 列表。
 */
export async function getWorktreesAsync(repoPath: string): Promise<GitFeatureResponse<{ items: GitWorktreeItem[] }>> {
  return await callGitFeatureAsync("worktree.list", { repoPath });
}

/**
 * 新增 Worktree。
 */
export async function addWorktreeAsync(repoPath: string, payload: { path: string; ref?: string; createBranch?: boolean; branchName?: string }): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("worktree.add", { repoPath, ...payload });
}

/**
 * 移除 Worktree。
 */
export async function removeWorktreeAsync(repoPath: string, payload: { path: string; force?: boolean }): Promise<GitFeatureResponse> {
  return await callGitFeatureAsync("worktree.remove", { repoPath, ...payload });
}

/**
 * 读取 Git 命令控制台日志（展示主进程实际执行的 Git 指令与输出）。
 */
export async function getGitConsoleAsync(
  repoPath: string,
  limit: number = 200,
  options?: { includeLongText?: boolean },
): Promise<GitFeatureResponse<{ repoRoot?: string; items: GitConsoleEntry[] }>> {
  return await callGitFeatureAsync("console.get", {
    repoPath,
    limit,
    includeLongText: options?.includeLongText === true,
  });
}

/**
 * 清空 Git 命令控制台日志。
 */
export async function clearGitConsoleAsync(repoPath: string): Promise<GitFeatureResponse<{ repoRoot?: string; cleared: number }>> {
  return await callGitFeatureAsync("console.clear", { repoPath });
}

/**
 * 以 `Git.Show.Stage` 语义请求宿主打开 GitWorkbench。
 */
export async function showGitWorkbenchAsync(args: {
  projectId?: string;
  projectPath?: string;
  prefillCommitMessage?: string;
  focusCommitMessage?: boolean;
  selectCommitMessage?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  return await showGitWorkbenchActionAsync(GIT_WORKBENCH_SHOW_STAGE_ACTION_ID, args);
}

/**
 * 以 `Git.Commit.Stage` 语义请求宿主打开 GitWorkbench 并聚焦提交消息输入框。
 */
export async function showGitCommitWorkbenchAsync(args: {
  projectId?: string;
  projectPath?: string;
  prefillCommitMessage?: string;
}): Promise<{ ok: boolean; error?: string }> {
  return await showGitWorkbenchActionAsync(GIT_WORKBENCH_COMMIT_STAGE_ACTION_ID, args);
}

/**
 * 通过宿主桥打开任意 GitWorkbench 公共动作；commit-like 动作默认聚焦并全选提交输入框。
 */
export async function showGitWorkbenchActionAsync(
  actionId: GitWorkbenchPublicActionId,
  args?: {
    projectId?: string;
    projectPath?: string;
    prefillCommitMessage?: string;
    focusCommitMessage?: boolean;
    selectCommitMessage?: boolean;
  },
): Promise<{ ok: boolean; error?: string }> {
  const commitLike = isGitWorkbenchCommitLikeActionId(actionId);
  return await window.host.gitWorkbench?.show({
    actionId,
    projectId: args?.projectId,
    projectPath: args?.projectPath,
    prefillCommitMessage: args?.prefillCommitMessage,
    focusCommitMessage: args?.focusCommitMessage === true || commitLike,
    selectCommitMessage: args?.selectCommitMessage === true || commitLike,
  }) || { ok: false, error: resolveGitText("activity.errors.showWorkbenchUnsupported", "当前宿主不支持打开 Git 工作台") };
}
