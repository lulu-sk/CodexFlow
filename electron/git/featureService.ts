// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import {
  createChangeList as createCommitPanelChangeList,
  deleteChangeList as deleteCommitPanelChangeList,
  moveFilesToChangeListAsync as moveCommitPanelFilesToChangeListAsync,
  renameChangeList as renameCommitPanelChangeList,
  setActiveChangeList as setCommitPanelActiveChangeList,
  updateChangeListData as updateCommitPanelChangeListData,
} from "./commitPanel/changelistService";
import { executeCommitWorkflowAsync, precheckCommitWorkflowAsync } from "./commitPanel/commitWorkflow";
import {
  applyIgnoreTargetAsync as applyCommitPanelIgnoreTargetAsync,
  listIgnoreTargetsAsync as listCommitPanelIgnoreTargetsAsync,
  type CommitPanelIgnoreTarget,
} from "./commitPanel/ignoreTargets";
import {
  buildCommitPanelGroupingSnapshotAsync,
} from "./commitPanel/groupingMetadata";
import {
  detectCommitHooksAvailableAsync,
  isGitProtectedBranch,
  readGitCommitPanelPreferencesAsync,
  updateGitCommitPanelPreferencesAsync,
} from "./commitPanel/preferences";
import { GitFreezingProcess } from "./freeze/freezingProcess";
import {
  applyConflictResolverSideAsync as applyCommitPanelConflictResolverSideAsync,
  describeConflictResolverEntriesAsync as describeCommitPanelConflictResolverEntriesAsync,
  getConflictMergeSnapshotAsync as getCommitPanelConflictMergeSnapshotAsync,
} from "./commitPanel/conflictMerge";
import {
  buildConflictMergeSessionSnapshotAsync as buildCommitPanelConflictMergeSessionSnapshotAsync,
} from "./commitPanel/mergeSession";
import { normalizeRepoPaths as normalizeCommitPanelRepoPaths } from "./commitPanel/pathUtils";
import {
  getResolvedConflictHolderSnapshotAsync as getCommitPanelResolvedConflictHolderSnapshotAsync,
  invalidateResolvedConflictHolder as invalidateCommitPanelResolvedConflictHolder,
} from "./commitPanel/resolvedConflicts";
import { buildCommitPanelStatusSnapshot, parseStatusPorcelainV2Z as parseCommitPanelStatusPorcelainV2Z } from "./commitPanel/statusModel";
import {
  ChangeListPlatformService,
  type ChangeListViewOptionKey,
  type LocalChangesConfigKey,
} from "./changelists";
import {
  isGitBranchFavorite,
  setGitBranchFavorite,
  type GitBranchFavoriteKind,
} from "./branchFavorites";
import { readGitBranchSyncSettings, writeGitBranchSyncSettings } from "./branchSyncConfig";
import { buildGitBranchSyncState, parseGitLsRemoteHeads, type GitBranchSyncState } from "./branchSyncState";
import { GitConsoleStore } from "./consoleStore";
import * as gitExec from "./exec";
import type { GitExecResult } from "./exec";
import { parseGitUnifiedPatch } from "./diffHunks";
import { parseWorktreeListPorcelain } from "./worktreeList";
import { toFsPathAbs, toFsPathKey } from "./pathKey";
import { buildGitCapabilityState, type GitCapabilityState } from "./git-capabilities";
import {
  loadShelfDiffPatchAsync,
  loadShelfDiffSnapshotAsync,
} from "./shelf/diffPreview";
import {
  applyCommitDetailsSelectionPatchAsync,
  getCommitDetailsActionAvailabilityAsync,
  openCommitDetailsRepositoryVersionAsync,
  runCommitDetailsHistoryRewriteAsync,
} from "./commitDetailsActions";
import {
  executeRollbackChangesAsync,
  type GitRollbackChange,
} from "./rollback";
import {
  applyUpdateOptionsPayloadDefaults,
  applyTrackedBranchSelectionsAsync,
  getUpdateOptionsSnapshotAsync,
  updateStoredUpdateOptionsAsync,
  getTrackedBranchPreviewAsync,
  resolveTrackedBranchOverride,
} from "./update/config";
import {
  buildMergeConflictOperationProblem,
  buildOperationProblemFromFileList,
  parseMergeFailure,
  buildUpdateProblemAction,
  parseSmartOperationProblem,
} from "./update/conflicts";
import { buildRepositoryGraphAsync } from "./update/repositoryGraph";
import {
  GitPreservingProcess,
  notifyLocalChangesAreNotRestored as notifyUpdateLocalChangesNotRestored,
  restoreLocalChangesAfterUpdateAsync as restoreUpdateLocalChangesAsync,
  saveLocalChangesForUpdateAsync as saveUpdateLocalChangesAsync,
} from "./update/preservingProcess";
import { runUpdateProjectAsync as runUpdateProjectOrchestratorAsync } from "./update/orchestrator";
import { planMergeUpdateAsync, runMergeUpdateCoreAsync } from "./update/updaters/merge";
import { planRebaseUpdateAsync, runRebaseUpdateCoreAsync } from "./update/updaters/rebase";
import { ShelveChangesManager } from "./shelf/manager";
import { ShelvedChangesViewManager } from "./shelf/viewManager";
import type { GitManualShelveSelection, GitShelfManagerRuntime } from "./shelf/types";

/**
 * 缓存 `ls-remote --heads` 结果，避免自动刷新链路对同一 remote 频繁发起网络探测。
 */
const BRANCH_SYNC_REMOTE_HEADS_CACHE_TTL_MS = 30_000;

/**
 * 按 `repoRoot + remote` 维度缓存远端分支头信息。
 */
const branchSyncRemoteHeadsCache = new Map<string, { fetchedAt: number; heads: Map<string, string> }>();

/**
 * 按仓库串行化显式 Fetch，请求到达顺序与执行顺序保持一致，避免并发 Fetch 互相覆盖状态。
 */
const fetchFlowQueueByRepoRoot = new Map<string, Promise<void>>();
/**
 * 记录“保存本地改动后进入进行中 Git 操作”的临时保存条目。
 * 仅在当前主进程生命周期内保留，用于在 Cherry-pick 最终结束时自动恢复 stash/shelf。
 */
const ongoingOperationSavedLocalChangesByRepoRoot = new Map<string, {
  operationState: GitRepositoryOperationState;
  saved: GitSavedLocalChanges;
}>();
import { VcsShelveChangesSaver } from "./shelf/vcsShelveChangesSaver";
import type {
  GitSavedLocalChanges,
  GitUpdateConfigRuntime,
  GitUpdateCommonRuntime,
  GitUpdateFeatureContext,
  GitUpdateLocalChangesRestorePolicy,
  GitUpdateMergeRuntime,
  GitUpdateMethodResolution,
  GitUpdateOrchestratorRuntime,
  GitUpdateSessionProgressSnapshot,
  GitUpdateProblemFileList,
  GitUpdateOperationProblem,
  GitUpdatePreflightResult,
  GitUpdatePreservingNotRestoredReason,
  GitUpdatePreservingState,
  GitUpdatePreservingRuntime,
  GitUpdateRepositoryGraphRuntime,
  GitUpdateRebaseRuntime,
  GitUpdateResetRuntime,
  GitUpdateRootRuntime,
  GitUpdateSaveChangesPolicy,
  GitUpdateSubmoduleRuntime,
  GitUpdateUnfinishedState,
  GitUpdateUnfinishedStateCode,
} from "./update/types";

export type GitFeatureActionArgs = {
  action: string;
  payload?: any;
  gitPath?: string;
  userDataPath: string;
  requestId?: number;
  emitProgress?: (payload: {
    requestId: number;
    action: string;
    repoRoot?: string;
    message: string;
    detail?: string;
    updateSession?: GitUpdateSessionProgressSnapshot;
  }) => void;
};

export type GitFeatureActionResult = {
  ok: boolean;
  data?: any;
  error?: string;
};

type GitHistoryRewriteAction =
  | "interactive-rebase"
  | "edit-message"
  | "delete-commit"
  | "extract-selected-changes"
  | "drop-selected-changes";
type GitHistoryRewriteTone = "info" | "warn" | "danger";

type GitHistoryRewriteUndoPayload = {
  kind: "delete-commit";
  repoRoot?: string;
  oldHead: string;
  newHead: string;
};

type GitHistoryRewriteUndoInfo = {
  label?: string;
  payload: GitHistoryRewriteUndoPayload;
};

type GitHistoryRewriteFeedback = {
  action: GitHistoryRewriteAction;
  tone: GitHistoryRewriteTone;
  title: string;
  message: string;
  detailLines?: string[];
  undo?: GitHistoryRewriteUndoInfo;
  reasonCode?: string;
  operationState?: GitRepositoryOperationState;
  shouldRefresh?: boolean;
  completed?: boolean;
};

type GitTextMatchMode = "fuzzy" | "exact" | "regex";

type GitLogPostFilter = {
  authorFilters: string[];
  textFilter: string;
  hashFilters: string[];
  caseSensitive: boolean;
  matchMode: GitTextMatchMode;
};

type GitLogActionAvailabilityKey =
  | "copyRevision"
  | "createPatch"
  | "cherryPick"
  | "checkoutRevision"
  | "showRepoAtRevision"
  | "compareLocal"
  | "reset"
  | "revert"
  | "undoCommit"
  | "editMessage"
  | "fixup"
  | "squashTo"
  | "squashCommits"
  | "deleteCommit"
  | "interactiveRebase"
  | "pushAllPrevious"
  | "newBranch"
  | "newTag";

type GitLogActionAvailability = {
  selectionCount: number;
  single: boolean;
  headHash?: string;
  isHeadCommit: boolean;
  hasMergeCommit: boolean;
  hasRootCommit: boolean;
  hasLocalChanges: boolean;
  isAncestorOfHead: boolean;
  isPublishedToUpstream: boolean;
  actions: Record<GitLogActionAvailabilityKey, { enabled: boolean; reason?: string }>;
};

type GitRepositoryOperationState = "normal" | "rebasing" | "merging" | "grafting" | "reverting";

type GitFirstParentCommitNode = {
  hash: string;
  parentCount: number;
};

type SingleCommitDetailsCacheEntry = {
  fetchedAt: number;
  detail: any;
};

type GitPushCommit = {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  subject: string;
  parents: string[];
  files?: GitCommitChangedFile[];
};

type GitInteractiveRebaseAction = "pick" | "edit" | "reword" | "squash" | "fixup" | "drop";

type GitInteractiveRebasePlanEntry = {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorDate: string;
  fullMessage: string;
  action: GitInteractiveRebaseAction;
  message?: string;
  originalIndex: number;
  autosquashCandidate?: boolean;
};

/**
 * 短时间缓存单提交详情，贴近上游 `commitDetailsGetter` 的复用语义，避免 amend / 详情面板并发或抖动时重复起 Git 进程。
 */
const SINGLE_COMMIT_DETAILS_CACHE_TTL_MS = 15_000;

/**
 * 限制单提交详情缓存规模，防止长会话下 Map 无界增长。
 */
const SINGLE_COMMIT_DETAILS_CACHE_MAX_ENTRIES = 128;

/**
 * 保存近期成功读取过的单提交详情；缓存仅跨 `log.details` 读取链路复用，写操作会在入口统一清空。
 */
const singleCommitDetailsCache = new Map<string, SingleCommitDetailsCacheEntry>();

/**
 * 合并同一提交详情的并发读取，避免多个 UI 消费者同时对同一哈希重复执行 `git show/diff-tree/...`。
 */
const singleCommitDetailsInFlight = new Map<string, Promise<any>>();

/**
 * 缓存 Git 能力探测结果，避免每次 `status.get` / stash gating 都重复执行 `git version`。
 */
const gitCapabilityCache = new Map<string, GitCapabilityState>();

/**
 * 只有真正可能改动 refs / history 的动作才需要清空单提交详情缓存。
 * 上游 commit details getter 会在读取链路间复用详情；只读动作（如 `status.get`、`log.availability`）不应打断这层复用。
 */
const COMMIT_DETAILS_CACHE_INVALIDATE_ACTIONS = new Set<string>([
  "repo.init",
  "branch.switch",
  "branch.action",
  "operation.continue",
  "operation.abort",
  "commit.create",
  "log.details.action",
  "log.rebasePlan.run",
  "log.action",
  "flow.fetch",
  "flow.pull",
  "flow.push",
  "push.execute",
]);

type GitInteractiveRebasePlanWarningCode = "autosquash" | "update-refs";

type GitInteractiveRebasePlanWarning = {
  code: GitInteractiveRebasePlanWarningCode;
  title: string;
  message: string;
};

type GitInteractiveRebasePlanFailureCode =
  | "detached-head"
  | "missing-hash"
  | "commit-not-found"
  | "target-outside-head"
  | "merge-commit"
  | "non-linear-history"
  | "unexpected-hash"
  | "unresolved-hash";

type GitInteractiveRebasePlanFailureResult = {
  ok: false;
  error: string;
  data?: {
    reasonCode: GitInteractiveRebasePlanFailureCode;
    reasonMessage: string;
  };
};

type GitInteractiveRebasePlanSnapshot = {
  targetHash: string;
  headHash: string;
  baseHash?: string;
  rootMode: boolean;
  entries: GitInteractiveRebasePlanEntry[];
  warnings?: GitInteractiveRebasePlanWarning[];
};

type GitInteractiveRebaseEditorQueueItem = {
  useDefault?: boolean;
  message?: string;
};

type GitInteractiveRebaseEditorArtifacts = {
  dirPath: string;
  sequenceEditorScriptPath: string;
  commitEditorScriptPath: string;
  todoFilePath: string;
  queueFilePath: string;
  queueStateFilePath: string;
};

type GitStatusEntry = {
  path: string;
  oldPath?: string;
  x: string;
  y: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  ignored: boolean;
  renamed: boolean;
  deleted: boolean;
  statusText: string;
  changeListId: string;
  conflictState?: "conflict" | "resolved";
  repositoryId?: string;
  repositoryRoot?: string;
  repositoryName?: string;
  repositoryExternal?: boolean;
  repositoryParentId?: string;
  moduleId?: string;
  moduleName?: string;
  moduleInternal?: boolean;
};

type GitFeatureContext = {
  action: string;
  requestId: number;
  gitPath: string;
  userDataPath: string;
  abortSignal?: AbortSignal;
  isCancellationRequested(): boolean;
  getCancellationReason(): string | undefined;
  emitProgress?: GitFeatureActionArgs["emitProgress"];
};

type GitDiffMode =
  | "working"
  | "staged"
  | "localToStaged"
  | "stagedToLocal"
  | "commit"
  | "revisionToRevision"
  | "revisionToWorking"
  | "parentToWorking"
  | "shelf"
  | "shelfToWorking";

type GitTerminalInteraction = {
  title: string;
  startupCmd: string;
  hint?: string;
};

const LOG_ACTION_KEYS: GitLogActionAvailabilityKey[] = [
  "copyRevision",
  "createPatch",
  "cherryPick",
  "checkoutRevision",
  "showRepoAtRevision",
  "compareLocal",
  "reset",
  "revert",
  "undoCommit",
  "editMessage",
  "fixup",
  "squashTo",
  "squashCommits",
  "deleteCommit",
  "interactiveRebase",
  "pushAllPrevious",
  "newBranch",
  "newTag",
];
const LOG_ALL_REFS = ["HEAD", "--branches", "--remotes", "--tags"];
const gitConsoleStore = new GitConsoleStore();
const REPO_ROOT_RESOLVE_CACHE_TTL_MS = 1500;
const repoRootResolveCache = new Map<string, { repoRoot: string; expiresAt: number }>();
const gitFeatureCancellationMap = new Map<number, { controller: AbortController; cancelled: boolean; reason?: string }>();

/**
 * 为指定请求创建或复用取消控制器，供长耗时 Git 操作共享同一取消信号。
 */
function ensureGitFeatureCancellationEntry(requestId: number): { controller: AbortController; cancelled: boolean; reason?: string } | null {
  const normalizedRequestId = Math.max(0, Math.floor(Number(requestId) || 0));
  if (!normalizedRequestId) return null;
  const existing = gitFeatureCancellationMap.get(normalizedRequestId);
  if (existing) return existing;
  const created = {
    controller: new AbortController(),
    cancelled: false,
    reason: undefined as string | undefined,
  };
  gitFeatureCancellationMap.set(normalizedRequestId, created);
  return created;
}

/**
 * 按请求号触发取消；若目标请求仍在运行，则会中断其后续 Git spawn 阶段。
 */
function cancelGitFeatureRequest(requestId: number, reason?: string): boolean {
  const normalizedRequestId = Math.max(0, Math.floor(Number(requestId) || 0));
  if (!normalizedRequestId) return false;
  const entry = gitFeatureCancellationMap.get(normalizedRequestId);
  if (!entry) return false;
  if (entry.cancelled) return true;
  entry.cancelled = true;
  entry.reason = String(reason || "").trim() || "更新项目已取消";
  try { entry.controller.abort(); } catch {}
  return true;
}

/**
 * 向渲染层广播 Git 过程提示，用于顶部提示与状态栏显示。
 */
function emitGitFeatureProgress(
  ctx: GitFeatureContext,
  repoRoot: string,
  message: string,
  detail?: string,
  updateSession?: GitUpdateSessionProgressSnapshot,
): void {
  if (!ctx.emitProgress || !ctx.requestId) return;
  const text = String(message || "").trim();
  if (!text) return;
  try {
    ctx.emitProgress({
      requestId: ctx.requestId,
      action: ctx.action,
      repoRoot: String(repoRoot || "").trim() || undefined,
      message: text,
      detail: String(detail || "").trim() || undefined,
      updateSession,
    });
  } catch {}
}


/**
 * 统一拼接 Git 全局参数，确保跨平台输出稳定。
 * - `core.quotepath=false`：避免中文路径被八进制转义；
 * - `i18n.*=utf-8`：统一日志/提交消息编码；
 * - `color.ui=false`：关闭 ANSI 颜色，避免污染解析；
 * - `--no-pager`：非交互场景禁用分页器。
 */
function buildNormalizedGitArgv(argv: string[]): string[] {
  return [
    "-c",
    "core.quotepath=false",
    "-c",
    "i18n.logOutputEncoding=utf-8",
    "-c",
    "i18n.commitEncoding=utf-8",
    "-c",
    "color.ui=false",
    "--no-pager",
    ...argv,
  ];
}

/**
 * 统一执行 Git 命令（短命令），并在失败时返回可读错误摘要。
 */
async function runGitExecAsync(
  ctx: GitFeatureContext,
  cwd: string,
  argv: string[],
  timeoutMs: number = 8000,
  envPatch?: NodeJS.ProcessEnv,
): Promise<GitExecResult> {
  const normalizedArgv = buildNormalizedGitArgv(argv);
  const startedAt = Date.now();
  const res = await gitExec.execGitAsync({
    gitPath: ctx.gitPath,
    cwd,
    argv: normalizedArgv,
    timeoutMs,
    envPatch,
  });
  gitConsoleStore.appendCompletedEntry({
    cwd,
    gitPath: ctx.gitPath,
    argv: normalizedArgv,
    result: res,
    durationMs: Date.now() - startedAt,
  });
  return res;
}

/**
 * 统一执行 Git 命令（长命令），用于 push/pull/fetch 等耗时操作。
 */
async function runGitSpawnAsync(
  ctx: GitFeatureContext,
  cwd: string,
  argv: string[],
  timeoutMs: number = 300_000,
  envPatch?: NodeJS.ProcessEnv,
  stdin?: string | Buffer,
): Promise<GitExecResult> {
  const normalizedArgv = buildNormalizedGitArgv(argv);
  const startedAt = Date.now();
  const consoleEntry = gitConsoleStore.createRunningEntry({
    cwd,
    gitPath: ctx.gitPath,
    argv: normalizedArgv,
  });
  const res = await gitExec.spawnGitAsync({
    gitPath: ctx.gitPath,
    cwd,
    argv: normalizedArgv,
    timeoutMs,
    envPatch,
    stdin,
    signal: ctx.abortSignal,
    onStdout: (chunk) => {
      gitConsoleStore.appendRunningOutput(consoleEntry.id, { stdoutChunk: chunk });
    },
    onStderr: (chunk) => {
      gitConsoleStore.appendRunningOutput(consoleEntry.id, { stderrChunk: chunk });
    },
  });
  gitConsoleStore.finishRunningEntry(consoleEntry.id, res, Date.now() - startedAt);
  return res;
}

/**
 * 统一执行“stdout 直接落盘”的 Git 命令，避免大补丁输出占满内存。
 */
async function runGitStdoutToFileAsync(
  ctx: GitFeatureContext,
  cwd: string,
  argv: string[],
  targetPath: string,
  timeoutMs: number = 300_000,
  envPatch?: NodeJS.ProcessEnv,
): Promise<GitExecResult> {
  const normalizedArgv = buildNormalizedGitArgv(argv);
  const startedAt = Date.now();
  const consoleEntry = gitConsoleStore.createRunningEntry({
    cwd,
    gitPath: ctx.gitPath,
    argv: normalizedArgv,
  });
  const res = await gitExec.spawnGitStdoutToFileAsync({
    gitPath: ctx.gitPath,
    cwd,
    argv: normalizedArgv,
    outFile: targetPath,
    timeoutMs,
    envPatch,
    signal: ctx.abortSignal,
    onStderr: (chunk) => {
      gitConsoleStore.appendRunningOutput(consoleEntry.id, { stderrChunk: chunk });
    },
  });
  gitConsoleStore.finishRunningEntry(consoleEntry.id, res, Date.now() - startedAt);
  return res;
}

/**
 * 执行不应进入 Git 控制台的轻量探测命令，供仓库根/伪引用/内部路径判断复用。
 */
async function runGitExecQuietAsync(
  ctx: GitFeatureContext,
  cwd: string,
  argv: string[],
  timeoutMs: number = 8000,
  envPatch?: NodeJS.ProcessEnv,
): Promise<GitExecResult> {
  return await gitExec.execGitAsync({
    gitPath: ctx.gitPath,
    cwd,
    argv: buildNormalizedGitArgv(argv),
    timeoutMs,
    envPatch,
  });
}

/**
 * 清洗 Git 输出中的控制分隔符与格式占位符，避免 `%x1e`、`%x00` 或 NUL 文本直接泄露到 UI。
 */
function sanitizeGitUiText(raw: string): string {
  return String(raw || "")
    .replace(/%x(?:00|1e)/gi, " ")
    .replace(/\x00|\x1e/g, "\n")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * 判断 stdout 是否明显属于机器解析协议输出；这类内容失败时不应作为用户可读错误直接展示。
 */
function isMachineReadableGitStdout(raw: string): boolean {
  const text = String(raw || "");
  if (!text) return false;
  return /%x(?:00|1e)/i.test(text) || text.includes("\x00") || text.includes("\x1e");
}

/**
 * 将 Git 命令失败结果转为面向 UI 的错误文案。
 */
export function toGitErrorMessage(res: GitExecResult, fallback: string): string {
  const stderr = String(res.stderr || "");
  const stdout = String(res.stdout || "");
  const rawError = String(res.error || "");
  const sanitizedStderr = sanitizeGitUiText(stderr);
  const sanitizedStdout = sanitizeGitUiText(stdout);
  const sanitizedError = sanitizeGitUiText(rawError);
  const hasInfrastructureError = rawError.length > 0 && (
    rawError.includes("maxBuffer")
    || rawError.includes("timeout after")
    || rawError.includes("spawn ")
    || rawError.includes("ENOENT")
    || rawError.includes("EACCES")
  );
  const msg = hasInfrastructureError
    ? sanitizedError
    : (sanitizedStderr || (!isMachineReadableGitStdout(stdout) ? sanitizedStdout : "") || sanitizedError);
  if (!msg) return fallback;
  if (gitExec.isGitExecutableUnavailable(res)) return `未找到 Git 可执行文件：${msg}`;
  if (looksLikeGitRemoteConfigError(msg)) return `${fallback}：远端仓库配置错误或目标不存在\n${msg}`;
  if (looksLikeGitNetworkError(msg)) return `${fallback}：网络或主机解析失败，请检查远端地址与网络环境\n${msg}`;
  if (looksLikeGitAuthenticationError(msg)) return `${fallback}：认证失败，请检查凭据、SSH Key 或仓库访问权限\n${msg}`;
  if (isPushRejectedNoFastForward(res)) return `${fallback}：远端存在新提交，请先更新后再推送\n${msg}`;
  if (looksLikeGitConflictError(msg)) return `${fallback}：检测到冲突，请先解决冲突后再继续\n${msg}`;
  return msg;
}

/**
 * 判断 Git 输出是否属于“远端配置错误/远端名错误/目标不存在”。
 */
function looksLikeGitRemoteConfigError(message: string): boolean {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return text.includes("does not appear to be a git repository")
    || text.includes("no such remote")
    || text.includes("src refspec")
    || text.includes("dst refspec")
    || text.includes("couldn't find remote ref");
}

/**
 * 判断 Git 输出是否属于网络不可达或主机解析失败，避免误报为认证问题。
 */
function looksLikeGitNetworkError(message: string): boolean {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return text.includes("could not resolve hostname")
    || text.includes("name or service not known")
    || text.includes("network is unreachable")
    || text.includes("connection timed out");
}

/**
 * 判断 Git 输出是否属于认证/鉴权失败。
 */
function looksLikeGitAuthenticationError(message: string): boolean {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return text.includes("authentication failed")
    || text.includes("permission denied")
    || text.includes("repository not found")
    || text.includes("access denied")
    || (text.includes("fatal: could not read from remote repository")
      && !looksLikeGitRemoteConfigError(text)
      && !looksLikeGitNetworkError(text))
    || text.includes("http basic: access denied");
}

/**
 * 判断 Git 输出是否包含冲突/未解决合并等提示。
 */
function looksLikeGitConflictError(message: string): boolean {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return text.includes("merge conflict")
    || text.includes("merge conflicts")
    || text.includes("merge conflict in ")
    || text.includes("conflict (content)")
    || text.includes("conflict (add/add)")
    || text.includes("conflict (modify/delete)")
    || text.includes("conflict (rename/delete)")
    || text.includes("conflict markers")
    || text.includes("unmerged files")
    || text.includes("resolve all conflicts manually")
    || text.includes("fix conflicts and then run")
    || text.includes("you need to resolve your current index first");
}

/**
 * 判断本地分支安全删除失败是否因为“存在未完全合并的提交”，用于对齐上游的自动强删回退逻辑。
 */
function isBranchNotFullyMergedError(res: GitExecResult): boolean {
  const text = `${String(res.stderr || "")}\n${String(res.stdout || "")}\n${String(res.error || "")}`.toLowerCase();
  if (!text.trim()) return false;
  return text.includes("not fully merged")
    || text.includes("not yet merged")
    || text.includes("git branch -d")
    || text.includes("如果您确认要删除")
    || text.includes("未完全合并");
}

type GitRewordEditorArtifacts = {
  dirPath: string;
  sequenceEditorScriptPath: string;
  commitEditorScriptPath: string;
  messageFilePath: string;
  targetPrefix: string;
};

/**
 * 将命令路径包装为 Git 可执行的 editor 命令字符串（处理空格和双引号）。
 */
function toGitEditorCommand(execPath: string, scriptPath: string): string {
  const escapedExec = String(execPath || "").replace(/"/g, "\\\"");
  const escapedScript = String(scriptPath || "").replace(/"/g, "\\\"");
  return `"${escapedExec}" "${escapedScript}"`;
}

/**
 * 删除路径（不存在时忽略），用于清理临时脚本目录。
 */
async function removePathIfExistsAsync(targetPath: string): Promise<void> {
  const target = String(targetPath || "").trim();
  if (!target) return;
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch {}
}

/**
 * 生成 reword 所需临时脚本与消息文件，供 `GIT_SEQUENCE_EDITOR/GIT_EDITOR` 调用。
 */
async function createGitRewordEditorArtifactsAsync(
  ctx: GitFeatureContext,
  messageInput: string,
  targetHashInput: string,
): Promise<GitRewordEditorArtifacts> {
  const targetHash = String(targetHashInput || "").trim().toLowerCase();
  if (!targetHash) throw new Error("缺少目标提交哈希");
  const targetPrefix = targetHash.slice(0, 7);
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const dirPath = path.join(ctx.userDataPath, "git", "tmp", "reword", stamp);
  await fsp.mkdir(dirPath, { recursive: true });

  const messageFilePath = path.join(dirPath, "message.txt");
  let normalizedMessage = String(messageInput || "");
  if (!normalizedMessage.endsWith("\n")) normalizedMessage = `${normalizedMessage}\n`;
  await fsp.writeFile(messageFilePath, normalizedMessage, "utf8");

  const sequenceEditorScriptPath = path.join(dirPath, "sequence-editor.cjs");
  const sequenceScript = `"use strict";
const fs = require("node:fs");
const todoPath = String(process.argv[2] || "");
const target = String(process.env.GIT_REWORD_TARGET || "").trim().toLowerCase();
if (!todoPath || !target || !fs.existsSync(todoPath)) process.exit(0);
const content = String(fs.readFileSync(todoPath, "utf8") || "");
const rows = content.split(/\\r?\\n/);
let replaced = false;
for (let idx = 0; idx < rows.length; idx += 1) {
  if (replaced) continue;
  const line = rows[idx];
  const hit = line.match(/^(\\s*)pick(\\s+)([0-9a-fA-F]+)(\\s+.*)?$/);
  if (!hit) continue;
  const hashText = String(hit[3] || "").toLowerCase();
  if (!hashText.startsWith(target)) continue;
  rows[idx] = \`\${hit[1]}reword\${hit[2]}\${hit[3]}\${hit[4] || ""}\`;
  replaced = true;
}
if (!replaced) {
  process.stderr.write("target commit not found in rebase todo\\n");
  process.exit(2);
}
let output = rows.join("\\n");
if (!output.endsWith("\\n")) output += "\\n";
fs.writeFileSync(todoPath, output, "utf8");
`;
  await fsp.writeFile(sequenceEditorScriptPath, sequenceScript, "utf8");

  const commitEditorScriptPath = path.join(dirPath, "commit-editor.cjs");
  const commitScript = `"use strict";
const fs = require("node:fs");
const commitMessagePath = String(process.argv[2] || "");
const sourcePath = String(process.env.GIT_REWORD_MESSAGE_FILE || "");
if (!commitMessagePath || !sourcePath || !fs.existsSync(sourcePath)) process.exit(0);
let message = String(fs.readFileSync(sourcePath, "utf8") || "");
if (!message.endsWith("\\n")) message += "\\n";
fs.writeFileSync(commitMessagePath, message, "utf8");
`;
  await fsp.writeFile(commitEditorScriptPath, commitScript, "utf8");

  return {
    dirPath,
    sequenceEditorScriptPath,
    commitEditorScriptPath,
    messageFilePath,
    targetPrefix,
  };
}

/**
 * 将任意路径归一化为仓库内相对路径（统一 `/` 分隔符）。
 */
function toRepoRelativePath(repoRoot: string, rawPath: string): string {
  const repoAbs = toFsPathAbs(repoRoot);
  const targetAbs = toFsPathAbs(rawPath);
  const rel = path.relative(repoAbs, targetAbs).replace(/\\/g, "/");
  if (!rel || rel === ".") return "";
  if (rel.startsWith("../") || rel === "..") return rawPath.replace(/\\/g, "/");
  return rel;
}

/**
 * 解码 Git 可能返回的八进制转义文本（如 `\346\260\264`）。
 */
function decodeGitEscapedText(raw: string): string {
  const text = String(raw || "");
  if (!/\\[0-7]{3}/.test(text)) return text;

  const bytes: number[] = [];
  for (let idx = 0; idx < text.length;) {
    if (text[idx] === "\\" && idx + 3 < text.length) {
      const octal = text.slice(idx + 1, idx + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
        idx += 4;
        continue;
      }
    }
    const chunk = Buffer.from(text[idx], "utf8");
    for (const one of chunk.values()) bytes.push(one);
    idx += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * 读取仓库根目录；若当前目录不是仓库则返回 null。
 */
async function resolveRepoRootAsync(ctx: GitFeatureContext, repoPath: string): Promise<{ ok: boolean; repoRoot?: string; error?: string }> {
  const dir = toFsPathAbs(String(repoPath || "").trim());
  if (!dir) return { ok: false, error: "缺少仓库路径" };
  const now = Date.now();
  const cached = repoRootResolveCache.get(dir);
  if (cached && cached.expiresAt > now) {
    return { ok: true, repoRoot: cached.repoRoot };
  }
  const top = await runGitExecQuietAsync(ctx, dir, ["rev-parse", "--show-toplevel"], 6000);
  if (!top.ok) {
    repoRootResolveCache.delete(dir);
    return { ok: false, error: toGitErrorMessage(top, "未检测到 Git 仓库") };
  }
  const repoRoot = String(top.stdout || "").trim();
  if (!repoRoot) return { ok: false, error: "未检测到 Git 仓库" };
  repoRootResolveCache.set(dir, {
    repoRoot,
    expiresAt: now + REPO_ROOT_RESOLVE_CACHE_TTL_MS,
  });
  return { ok: true, repoRoot };
}

/**
 * 为“日志/控制台”面板解析仓库过滤路径（只做路径归一化，避免额外 Git IO）。
 */
function resolveConsoleRepoPath(repoPathInput: string): string {
  return toFsPathAbs(String(repoPathInput || "").trim());
}

/**
 * 读取当前分支与 HEAD 信息。
 */
async function getHeadInfoAsync(ctx: GitFeatureContext, repoRoot: string): Promise<{ branch?: string; detached: boolean; headSha?: string }> {
  const branchRes = await runGitExecQuietAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 5000);
  const branch = decodeGitEscapedText(String(branchRes.stdout || "").trim());
  const detached = !branch;
  const shaRes = await runGitExecQuietAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 5000);
  const headSha = shaRes.ok ? String(shaRes.stdout || "").trim() : undefined;
  return {
    branch: branch || undefined,
    detached,
    headSha,
  };
}

/**
 * 解析 `git status --porcelain=v2 -z` 输出。
 */
function parseStatusPorcelainV2Z(stdout: string): Array<Omit<GitStatusEntry, "changeListId" | "statusText"> & { statusText?: string }> {
  const parts = String(stdout || "").split("\0").filter((x) => x.length > 0);
  const out: Array<Omit<GitStatusEntry, "changeListId" | "statusText"> & { statusText?: string }> = [];
  let i = 0;
  while (i < parts.length) {
    const line = parts[i++] || "";
    if (!line) continue;

    if (line.startsWith("1 ")) {
      const m = line.match(/^1\s+([^.A-Z?][^\s]|..|\S\S)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      const xy = m?.[1] || "..";
      const p = decodeGitEscapedText(m?.[2] || "");
      if (!p) continue;
      out.push({
        path: p,
        x: xy[0] || ".",
        y: xy[1] || ".",
        staged: (xy[0] || ".") !== ".",
        unstaged: (xy[1] || ".") !== ".",
        untracked: false,
        ignored: false,
        renamed: (xy[0] || ".") === "R" || (xy[1] || ".") === "R",
        deleted: (xy[0] || ".") === "D" || (xy[1] || ".") === "D",
      });
      continue;
    }

    if (line.startsWith("2 ")) {
      const m = line.match(/^2\s+(\S\S)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      const xy = m?.[1] || "..";
      const p = decodeGitEscapedText(m?.[2] || "");
      const oldPath = i < parts.length ? decodeGitEscapedText(parts[i++] || "") : "";
      if (!p) continue;
      out.push({
        path: p,
        oldPath: oldPath || undefined,
        x: xy[0] || ".",
        y: xy[1] || ".",
        staged: (xy[0] || ".") !== ".",
        unstaged: (xy[1] || ".") !== ".",
        untracked: false,
        ignored: false,
        renamed: true,
        deleted: (xy[0] || ".") === "D" || (xy[1] || ".") === "D",
      });
      continue;
    }

    if (line.startsWith("u ")) {
      const m = line.match(/^u\s+(\S\S)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      const xy = m?.[1] || "UU";
      const p = decodeGitEscapedText(m?.[2] || "");
      if (!p) continue;
      out.push({
        path: p,
        x: xy[0] || "U",
        y: xy[1] || "U",
        staged: true,
        unstaged: true,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
      });
      continue;
    }

    if (line.startsWith("? ")) {
      const p = decodeGitEscapedText(line.slice(2));
      if (!p) continue;
      out.push({
        path: p,
        x: "?",
        y: "?",
        staged: false,
        unstaged: true,
        untracked: true,
        ignored: false,
        renamed: false,
        deleted: false,
      });
      continue;
    }

    if (line.startsWith("! ")) {
      const p = decodeGitEscapedText(line.slice(2));
      if (!p) continue;
      out.push({
        path: p,
        x: "!",
        y: "!",
        staged: false,
        unstaged: false,
        untracked: false,
        ignored: true,
        renamed: false,
        deleted: false,
      });
      continue;
    }
  }
  return out;
}

/**
 * 将状态码映射为可读文本，用于 UI 展示。
 */
function toStatusText(entry: { x: string; y: string; untracked: boolean; ignored: boolean; renamed: boolean; deleted: boolean; staged: boolean; unstaged: boolean }): string {
  if (entry.ignored) return "已忽略";
  if (entry.untracked) return "未跟踪";
  if (entry.renamed) return "重命名";
  if (entry.deleted) return "删除";
  if (entry.staged && entry.unstaged) return "已暂存且有修改";
  if (entry.staged) return "已暂存";
  if (entry.unstaged) return "已修改";
  return "已变化";
}

/**
 * 将任意路径数组转为仓库内相对路径数组。
 */
function normalizeRepoPaths(repoRoot: string, pathsInput: any): string[] {
  const arr = Array.isArray(pathsInput) ? pathsInput : [];
  const out: string[] = [];
  for (const raw of arr) {
    const v = String(raw || "").trim();
    if (!v) continue;
    const rel = path.isAbsolute(v) ? toRepoRelativePath(repoRoot, v) : v.replace(/\\/g, "/");
    const clean = rel.replace(/^\.\//, "").replace(/\\/g, "/");
    if (!clean) continue;
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/**
 * 规整分支同步远端缓存键，避免同仓不同 remote 的缓存互串。
 */
function buildBranchSyncRemoteHeadsCacheKey(repoRoot: string, remote: string): string {
  return `${String(repoRoot || "").trim()}\u0000${String(remote || "").trim()}`;
}

type BranchPopupLocalRow = {
  name: string;
  hash: string;
  upstream?: string;
  trackShort?: string;
  remote?: string;
  remoteBranch?: string;
  sync?: GitBranchSyncState;
};

type BranchPopupRepositoryNode = {
  repoRoot: string;
  rootName: string;
  kind: "repository" | "submodule";
};

/**
 * 读取仓库远端名称列表，供 upstream 解析与 `ls-remote` 探测复用。
 */
async function readRemoteNamesAsync(ctx: GitFeatureContext, repoRoot: string): Promise<string[]> {
  const remoteRes = await runGitExecQuietAsync(ctx, repoRoot, ["remote"], 8_000);
  if (!remoteRes.ok) return [];
  return Array.from(new Set(
    String(remoteRes.stdout || "")
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter(Boolean),
  )).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * 解析本地分支列表原始输出，并补齐 upstream 对应的 remote / branch 元信息。
 */
function parseLocalBranchPopupRows(raw: string, remoteNames: string[]): BranchPopupLocalRow[] {
  const rows = String(raw || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: BranchPopupLocalRow[] = [];
  for (const row of rows) {
    const segs = row.split("\0");
    const name = decodeGitEscapedText(String(segs[0] || "").trim());
    if (!name) continue;
    const upstream = decodeGitEscapedText(String(segs[2] || "").trim()) || undefined;
    const parsedUpstream = upstream ? parseUpstreamRef(upstream, remoteNames) : null;
    out.push({
      name,
      hash: String(segs[1] || "").trim(),
      upstream,
      trackShort: String(segs[3] || "").trim() || undefined,
      remote: parsedUpstream?.remote,
      remoteBranch: parsedUpstream?.branch,
    });
  }
  return out;
}

/**
 * 解析本地/远端分支列表公共输出，统一补齐 favorites、repo 归属和次级说明所需字段。
 */
function parseBranchPopupBranchRows(
  raw: string,
  options?: {
    repoRoot?: string;
    repositoryName?: string;
    favoriteKind?: GitBranchFavoriteKind;
    favoriteLookup?: (name: string, kind: GitBranchFavoriteKind) => boolean;
    secondaryTextResolver?: (upstream: string | undefined, name: string) => string | undefined;
  },
): Array<{
  name: string;
  hash: string;
  upstream?: string;
  secondaryText?: string;
  favorite?: boolean;
  repoRoot?: string;
  repositoryName?: string;
}> {
  const rows = String(raw || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: Array<{
    name: string;
    hash: string;
    upstream?: string;
    secondaryText?: string;
    favorite?: boolean;
    repoRoot?: string;
    repositoryName?: string;
  }> = [];
  for (const row of rows) {
    const segs = row.split("\0");
    const name = decodeGitEscapedText(String(segs[0] || "").trim());
    if (!name) continue;
    const upstream = decodeGitEscapedText(String(segs[2] || "").trim()) || undefined;
    const favoriteKind = options?.favoriteKind;
    out.push({
      name,
      hash: String(segs[1] || "").trim(),
      upstream,
      secondaryText: options?.secondaryTextResolver?.(upstream, name),
      favorite: favoriteKind ? options?.favoriteLookup?.(name, favoriteKind) === true : undefined,
      repoRoot: String(options?.repoRoot || "").trim() || undefined,
      repositoryName: String(options?.repositoryName || "").trim() || undefined,
    });
  }
  return out;
}

/**
 * 过滤 branch popup 里的远端分支行，排除裸远端符号引用（如 `origin`）与 `remote/HEAD`，
 * 只保留可映射为真实远端分支的引用，和上游 `getRemoteBranches()` 的可见集合保持一致。
 */
function filterRemoteBranchPopupRows(
  rows: Array<{
    name: string;
    hash: string;
    upstream?: string;
    secondaryText?: string;
    favorite?: boolean;
    repoRoot?: string;
    repositoryName?: string;
  }>,
  remoteNames: string[],
): Array<{
  name: string;
  hash: string;
  upstream?: string;
  secondaryText?: string;
  favorite?: boolean;
  repoRoot?: string;
  repositoryName?: string;
}> {
  return rows.filter((row) => {
    const parsed = parseUpstreamRef(String(row.name || "").trim(), remoteNames);
    return !!parsed?.remote && !!parsed.branch && parsed.branch !== "HEAD";
  });
}

type GitRemoteConfigRow = {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
};

/**
 * 解析 `git remote -v` 输出，收敛为远端名 + fetch/push URL 结构，供远端管理对话框复用。
 */
function parseGitRemoteConfigRows(raw: string): GitRemoteConfigRow[] {
  const out = new Map<string, GitRemoteConfigRow>();
  const rows = String(raw || "").split(/\r?\n/).map((line) => String(line || "").trim()).filter(Boolean);
  for (const row of rows) {
    const match = row.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const name = String(match[1] || "").trim();
    const url = String(match[2] || "").trim();
    const kind = String(match[3] || "").trim();
    if (!name || !url) continue;
    const hit = out.get(name) || { name };
    if (kind === "fetch") hit.fetchUrl = url;
    if (kind === "push") hit.pushUrl = url;
    out.set(name, hit);
  }
  return Array.from(out.values()).sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 读取仓库远端配置列表；命令失败时返回空列表，避免影响分支快照主流程。
 */
async function readGitRemoteConfigRowsAsync(ctx: GitFeatureContext, repoRoot: string): Promise<GitRemoteConfigRow[]> {
  const res = await runGitExecQuietAsync(ctx, repoRoot, ["remote", "-v"], 8_000);
  if (!res.ok) return [];
  return parseGitRemoteConfigRows(res.stdout);
}

/**
 * 把 `Name <email>` 规整为可比较的作者身份；任一字段缺失时保留为空字符串。
 */
function parseGitAuthorIdentity(author: string): { name: string; email: string } {
  const text = String(author || "").trim();
  if (!text) return { name: "", email: "" };
  const match = text.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return {
      name: String(match[1] || "").trim(),
      email: String(match[2] || "").trim(),
    };
  }
  if (text.includes("@")) return { name: "", email: text };
  return { name: text, email: "" };
}

/**
 * 统一规整作者名/邮箱，比较“我的提交”时忽略大小写与首尾空白差异。
 */
function normalizeGitIdentityValue(value: string): string {
  return String(value || "").trim().toLowerCase();
}

/**
 * 读取当前仓库默认作者身份，供 “Show Only My Branches” 过滤逻辑复用。
 */
async function resolveMyBranchIdentityAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
): Promise<{ name: string; email: string }> {
  const parsed = parseGitAuthorIdentity(await resolveDefaultCommitAuthorAsync(ctx, repoRoot));
  return {
    name: normalizeGitIdentityValue(parsed.name),
    email: normalizeGitIdentityValue(parsed.email),
  };
}

/**
 * 判断目标分支的 exclusive commits 是否全部属于当前作者；无 exclusive commits 时视为非“我的分支”。
 */
async function isMyBranchAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  branchName: string,
  allBranchNames: string[],
  identity: { name: string; email: string },
): Promise<boolean> {
  const normalizedBranchName = String(branchName || "").trim();
  if (!normalizedBranchName) return false;
  if (!identity.name && !identity.email) return false;
  const exclusions = allBranchNames
    .map((name) => String(name || "").trim())
    .filter((name) => !!name && name !== normalizedBranchName && !name.endsWith("/HEAD"));
  const res = await runGitExecQuietAsync(
    ctx,
    repoRoot,
    ["log", "--format=%ae%x00%an", normalizedBranchName, ...exclusions.map((name) => `^${name}`)],
    30_000,
  );
  if (!res.ok) return false;
  const rows = String(res.stdout || "").split(/\r?\n/).map((line) => String(line || "").trim()).filter(Boolean);
  if (rows.length <= 0) return false;
  for (const row of rows) {
    const seg = row.split("\0");
    const email = normalizeGitIdentityValue(String(seg[0] || ""));
    const name = normalizeGitIdentityValue(String(seg[1] || ""));
    const matchesEmail = !!identity.email && email === identity.email;
    const matchesName = !!identity.name && name === identity.name;
    if (!matchesEmail && !matchesName) return false;
  }
  return true;
}

/**
 * 按“exclusive commits 全由当前作者提交”规则过滤本地/远端分支，等价承接上游的 Show Only My Branches。
 */
async function filterMyBranchPopupRowsAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  localRows: Array<{ name: string }>,
  remoteRows: Array<{ name: string }>,
): Promise<{
  localNames: Set<string>;
  remoteNames: Set<string>;
}> {
  const identity = await resolveMyBranchIdentityAsync(ctx, repoRoot);
  const allBranchNames = [
    ...localRows.map((item) => String(item.name || "").trim()),
    ...remoteRows.map((item) => String(item.name || "").trim()),
  ].filter((name) => !!name && !name.endsWith("/HEAD"));
  const localNames = new Set<string>();
  const remoteNames = new Set<string>();
  if (allBranchNames.length <= 0) return { localNames, remoteNames };
  for (const item of localRows) {
    const name = String(item.name || "").trim();
    if (!name || name.endsWith("/HEAD")) continue;
    if (await isMyBranchAsync(ctx, repoRoot, name, allBranchNames, identity)) localNames.add(name);
  }
  for (const item of remoteRows) {
    const name = String(item.name || "").trim();
    if (!name || name.endsWith("/HEAD")) continue;
    if (await isMyBranchAsync(ctx, repoRoot, name, allBranchNames, identity)) remoteNames.add(name);
  }
  return { localNames, remoteNames };
}

/**
 * 按 remote 读取远端 heads，并优先复用短时缓存，减少自动刷新阶段的重复网络探测。
 */
async function readBranchSyncRemoteHeadsAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  remoteNames: string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const now = Date.now();
  for (const remote of Array.from(new Set(remoteNames.map((one) => String(one || "").trim()).filter(Boolean)))) {
    const cacheKey = buildBranchSyncRemoteHeadsCacheKey(repoRoot, remote);
    const cached = branchSyncRemoteHeadsCache.get(cacheKey);
    if (cached && now - cached.fetchedAt <= BRANCH_SYNC_REMOTE_HEADS_CACHE_TTL_MS) {
      out.set(remote, cached.heads);
      continue;
    }
    const remoteRes = await runGitExecQuietAsync(ctx, repoRoot, ["ls-remote", "--heads", remote], 12_000);
    if (!remoteRes.ok) {
      if (cached) out.set(remote, cached.heads);
      continue;
    }
    const heads = parseGitLsRemoteHeads(String(remoteRes.stdout || ""));
    branchSyncRemoteHeadsCache.set(cacheKey, { fetchedAt: now, heads });
    out.set(remote, heads);
  }
  return out;
}

/**
 * 读取本地跟踪引用的哈希与 ahead/behind 计数，供分支同步状态拼装复用。
 */
async function readLocalBranchIncomingOutgoingSnapshotAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  branchName: string,
  remoteName: string,
  remoteBranch: string,
  trackShort?: string,
): Promise<{ trackingHash?: string; incoming?: number; outgoing?: number }> {
  const trackingRef = `refs/remotes/${remoteName}/${remoteBranch}`;
  const trackingRes = await runGitExecQuietAsync(ctx, repoRoot, ["rev-parse", "--verify", "-q", trackingRef], 8_000);
  const trackingHash = trackingRes.ok ? String(trackingRes.stdout || "").trim() || undefined : undefined;
  if (!trackingHash) return {};
  if (trackShort === "=") {
    return {
      trackingHash,
      incoming: 0,
      outgoing: 0,
    };
  }

  const countRes = await runGitExecQuietAsync(
    ctx,
    repoRoot,
    ["rev-list", "--left-right", "--count", `refs/heads/${branchName}...${trackingRef}`],
    12_000,
  );
  if (!countRes.ok) return { trackingHash };

  const parts = String(countRes.stdout || "").trim().split(/\s+/);
  const outgoing = Number.parseInt(String(parts[0] || "0"), 10);
  const incoming = Number.parseInt(String(parts[1] || "0"), 10);
  return {
    trackingHash,
    incoming: Number.isFinite(incoming) ? Math.max(0, incoming) : undefined,
    outgoing: Number.isFinite(outgoing) ? Math.max(0, outgoing) : undefined,
  };
}

/**
 * 为本地分支补齐 incoming / outgoing / hasUnfetched / tooltip 级别的同步状态。
 */
async function attachLocalBranchSyncStatesAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  rows: BranchPopupLocalRow[],
  remoteHeadsByRemote: Map<string, Map<string, string>>,
): Promise<BranchPopupLocalRow[]> {
  const out: BranchPopupLocalRow[] = [];
  for (const row of rows) {
    if (!row.upstream || !row.remote || !row.remoteBranch) {
      out.push(row);
      continue;
    }

    const snapshot = await readLocalBranchIncomingOutgoingSnapshotAsync(
      ctx,
      repoRoot,
      row.name,
      row.remote,
      row.remoteBranch,
      row.trackShort,
    );
    const remoteHeads = remoteHeadsByRemote.get(row.remote);
    const remoteHead = remoteHeads?.get(row.remoteBranch);
    const hasUnfetched = !!remoteHead && remoteHead !== snapshot.trackingHash;
    const gone = remoteHeadsByRemote.has(row.remote) && !remoteHead;
    out.push({
      ...row,
      sync: buildGitBranchSyncState({
        upstream: row.upstream,
        remote: row.remote,
        remoteBranch: row.remoteBranch,
        incoming: snapshot.incoming,
        outgoing: snapshot.outgoing,
        hasUnfetched,
        gone,
      }),
    });
  }
  return out;
}

/**
 * 在 Fetch 成功后清理当前仓库的远端 heads 缓存，确保后续同步状态基于最新远端结果重算。
 */
function invalidateBranchSyncRemoteHeadsCache(repoRoot: string): void {
  const normalizedRepoRoot = String(repoRoot || "").trim();
  if (!normalizedRepoRoot) return;
  for (const key of Array.from(branchSyncRemoteHeadsCache.keys())) {
    if (!key.startsWith(`${normalizedRepoRoot}\u0000`)) continue;
    branchSyncRemoteHeadsCache.delete(key);
  }
}

/**
 * 从本地/远端分支集合中提取 favorites 分组，保持当前分支优先且去除重复项。
 */
function collectFavoriteBranchItems(args: {
  local: Array<Record<string, any>>;
  remote: Array<Record<string, any>>;
  currentBranch?: string;
}): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  const pushItem = (section: "local" | "remote", item: Record<string, any>): void => {
    const name = String(item?.name || "").trim();
    if (!name || item?.favorite !== true) return;
    const key = `${section}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      ...item,
      section,
    });
  };
  const currentBranch = String(args.currentBranch || "").trim();
  if (currentBranch) {
    const currentLocal = args.local.find((item) => String(item?.name || "").trim() === currentBranch);
    if (currentLocal?.favorite === true) pushItem("local", currentLocal);
  }
  for (const item of args.local) pushItem("local", item);
  for (const item of args.remote) pushItem("remote", item);
  return out;
}

/**
 * 为指定仓库构建完整 branch popup 快照，统一收敛 tracked branch 文案、favorites 与 incoming/outgoing 状态。
 */
async function buildBranchPopupRepositorySnapshotAsync(
  ctx: GitFeatureContext,
  repo: BranchPopupRepositoryNode,
  options?: {
    syncEnabled?: boolean;
    showOnlyMy?: boolean;
  },
): Promise<{
  repoRoot: string;
  rootName: string;
  kind: "repository" | "submodule";
  currentBranch: string;
  detached: boolean;
  headSha?: string;
  syncEnabled: boolean;
  showOnlyMy: boolean;
  remotes: GitRemoteConfigRow[];
  currentBranchSync?: GitBranchSyncState;
  groups: {
    favorites: Array<Record<string, any>>;
    recent: Array<Record<string, any>>;
    local: Array<Record<string, any>>;
    remote: Array<Record<string, any>>;
  };
}> {
  const repoRoot = String(repo.repoRoot || "").trim();
  const headInfo = await getHeadInfoAsync(ctx, repoRoot);
  const [remoteNames, localRes] = await Promise.all([
    readRemoteNamesAsync(ctx, repoRoot),
    runGitExecAsync(
      ctx,
      repoRoot,
      ["for-each-ref", "--sort=refname", "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:trackshort)", "refs/heads"],
      8_000,
    ),
  ]);
  if (!localRes.ok) throw new Error(toGitErrorMessage(localRes, `读取仓库 ${repo.rootName} 的本地分支失败`));

  const remoteRes = await runGitExecAsync(
    ctx,
    repoRoot,
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)%00%(objectname)%00%(upstream:short)", "refs/remotes"],
    8_000,
  );
  if (!remoteRes.ok) throw new Error(toGitErrorMessage(remoteRes, `读取仓库 ${repo.rootName} 的远程分支失败`));

  const recentRes = await runGitExecAsync(
    ctx,
    repoRoot,
    ["for-each-ref", "--sort=-committerdate", "--count=10", "--format=%(refname:short)", "refs/heads"],
    8_000,
  );

  const favoriteLookup = (name: string, kind: GitBranchFavoriteKind): boolean => (
    isGitBranchFavorite(ctx.userDataPath, repoRoot, kind, name)
  );
  const localBaseRows = parseLocalBranchPopupRows(localRes.stdout, remoteNames);
  const syncEnabled = options?.syncEnabled !== false;
  const showOnlyMy = options?.showOnlyMy === true;
  const remoteHeadsByRemote = syncEnabled
    ? await readBranchSyncRemoteHeadsAsync(
        ctx,
        repoRoot,
        localBaseRows.map((row) => String(row.remote || "").trim()).filter(Boolean),
      )
    : new Map<string, Map<string, string>>();
  const localWithSync = syncEnabled
    ? await attachLocalBranchSyncStatesAsync(ctx, repoRoot, localBaseRows, remoteHeadsByRemote)
    : localBaseRows;
  const local = localWithSync.map((item) => ({
    ...item,
    secondaryText: item.upstream,
    favorite: favoriteLookup(item.name, "local"),
    current: item.name === headInfo.branch,
    repoRoot,
    repositoryName: repo.rootName,
  }));
  const remote = filterRemoteBranchPopupRows(parseBranchPopupBranchRows(remoteRes.stdout, {
    repoRoot,
    repositoryName: repo.rootName,
    favoriteKind: "remote",
    favoriteLookup,
  }), remoteNames);
  const remotes = await readGitRemoteConfigRowsAsync(ctx, repoRoot);
  const myBranchNames = showOnlyMy
    ? await filterMyBranchPopupRowsAsync(ctx, repoRoot, local, remote)
    : { localNames: new Set<string>(), remoteNames: new Set<string>() };
  const filteredLocal = showOnlyMy ? local.filter((item) => myBranchNames.localNames.has(String(item.name || "").trim())) : local;
  const filteredRemote = showOnlyMy ? remote.filter((item) => myBranchNames.remoteNames.has(String(item.name || "").trim())) : remote;
  const localByName = new Map(filteredLocal.map((item) => [String(item.name || "").trim(), item]));
  const recent = String(recentRes.stdout || "")
    .split(/\r?\n/)
    .map((line) => decodeGitEscapedText(String(line || "").trim()))
    .filter(Boolean)
    .map((name) => {
      const hit = localByName.get(name);
      return hit
        ? { ...hit }
        : {
            name,
            current: name === headInfo.branch,
            favorite: favoriteLookup(name, "local"),
            repoRoot,
            repositoryName: repo.rootName,
          };
    })
    .filter((item) => !showOnlyMy || filteredLocal.some((branch) => branch.name === item.name));

  return {
    repoRoot,
    rootName: repo.rootName,
    kind: repo.kind,
    currentBranch: headInfo.branch || "HEAD",
    detached: headInfo.detached,
    headSha: headInfo.headSha,
    syncEnabled,
    showOnlyMy,
    remotes,
    currentBranchSync: syncEnabled ? filteredLocal.find((item) => item.name === headInfo.branch)?.sync : undefined,
    groups: {
      favorites: collectFavoriteBranchItems({
        local: filteredLocal,
        remote: filteredRemote,
        currentBranch: headInfo.branch,
      }),
      recent,
      local: filteredLocal,
      remote: filteredRemote,
    },
  };
}

/**
 * 读取分支弹窗数据（最近/本地/远程）。
 */
async function getBranchPopupDataAsync(ctx: GitFeatureContext, repoRoot: string): Promise<GitFeatureActionResult> {
  try {
    const branchSyncSettings = readGitBranchSyncSettings(ctx.userDataPath);
    const repositoryGraph = await buildRepositoryGraphAsync({
      repoRoot,
      runGitExecAsync: async (runtimeRepoRoot, argv, timeoutMs) => {
        return await runGitExecAsync(ctx, runtimeRepoRoot, argv, timeoutMs);
      },
    }, {});
    const repositories = await Promise.all(repositoryGraph.roots.map(async (node) => {
      return await buildBranchPopupRepositorySnapshotAsync(ctx, {
        repoRoot: node.repoRoot,
        rootName: node.rootName,
        kind: node.kind,
      }, {
        syncEnabled: branchSyncSettings.enabled,
        showOnlyMy: branchSyncSettings.showOnlyMy,
      });
    }));
    const requestedRepoRoot = String(repositoryGraph.requestedRepoRoot || repoRoot).trim() || repoRoot;
    const selectedRepoRoot = repositories.some((item) => toFsPathKey(item.repoRoot) === toFsPathKey(requestedRepoRoot))
      ? requestedRepoRoot
      : (repositories[0]?.repoRoot || requestedRepoRoot);
    const selectedRepository = repositories.find((item) => toFsPathKey(item.repoRoot) === toFsPathKey(selectedRepoRoot)) || repositories[0];
    if (!selectedRepository) return { ok: false, error: "未找到可用仓库分支数据" };

    return {
      ok: true,
      data: {
        selectedRepoRoot,
        multiRoot: repositories.length > 1,
        currentBranch: selectedRepository.currentBranch,
        detached: selectedRepository.detached,
        headSha: selectedRepository.headSha,
        syncEnabled: branchSyncSettings.enabled,
        showOnlyMy: branchSyncSettings.showOnlyMy,
        remotes: selectedRepository.remotes,
        currentBranchSync: selectedRepository.currentBranchSync,
        repositories,
        dataContext: {
          selectedRepoRoot,
          affectedRepoRoots: repositories.map((item) => item.repoRoot),
        },
        quickActions: [
          { id: "update", label: "更新项目" },
          { id: "commit", label: "提交..." },
          { id: "push", label: "推送...", shortcut: "Ctrl+Shift+K" },
          { id: "newBranch", label: "新建分支...", shortcut: "Ctrl+Alt+N" },
          { id: "checkoutRevision", label: "签出标记或修订..." },
          { id: "configureRemotes", label: "配置远端..." },
        ],
        groups: selectedRepository.groups,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error instanceof Error ? error.message : error || "读取分支弹窗失败").trim() || "读取分支弹窗失败",
    };
  }
}

/**
 * 执行分支签出（优先 switch，失败回退 checkout）。
 */
type GitBranchSwitchAttemptResult =
  | {
      ok: true;
      data: {
        switched: true;
        tracked?: true;
        forced?: true;
      };
    }
  | {
      ok: false;
      commandRes: GitExecResult;
    };

/**
 * 执行一次普通 ref 签出尝试，优先 `git switch`，必要时回退到 `git checkout`，并兼容强制签出模式。
 */
async function executeDirectSwitchRefAttemptAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  ref: string,
  forceCheckout: boolean,
): Promise<GitBranchSwitchAttemptResult> {
  const target = String(ref || "").trim();
  const switchArgv = forceCheckout ? ["switch", "--discard-changes", target] : ["switch", target];
  const switchRes = await runGitSpawnAsync(ctx, repoRoot, switchArgv, 120_000);
  if (switchRes.ok) {
    return {
      ok: true,
      data: {
        switched: true,
        forced: forceCheckout || undefined,
      },
    };
  }

  if (target.includes("/")) {
    const trackArgv = forceCheckout
      ? ["switch", "--discard-changes", "--track", target]
      : ["switch", "--track", target];
    const trackRes = await runGitSpawnAsync(ctx, repoRoot, trackArgv, 120_000);
    if (trackRes.ok) {
      return {
        ok: true,
        data: {
          switched: true,
          tracked: true,
          forced: forceCheckout || undefined,
        },
      };
    }
  }

  const checkoutArgv = forceCheckout ? ["checkout", "-f", target] : ["checkout", target];
  const checkoutRes = await runGitSpawnAsync(ctx, repoRoot, checkoutArgv, 120_000);
  if (checkoutRes.ok) {
    return {
      ok: true,
      data: {
        switched: true,
        forced: forceCheckout || undefined,
      },
    };
  }
  return {
    ok: false,
    commandRes: checkoutRes,
  };
}

/**
 * 为远端分支推断应落到的本地分支名；优先复用已跟踪该远端的本地分支，其次复用同名本地分支。
 */
async function resolveRemoteCheckoutLocalBranchAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  remoteRef: string,
  remoteNamesInput?: string[] | null,
): Promise<string> {
  const remoteNames = Array.from(new Set(
    (Array.isArray(remoteNamesInput) ? remoteNamesInput : (await readRemoteNamesAsync(ctx, repoRoot)))
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  ));
  const parsedRemote = parseUpstreamRef(remoteRef, remoteNames);
  if (!parsedRemote?.remote || !parsedRemote.branch || parsedRemote.branch === "HEAD") return "";
  const localRes = await runGitExecQuietAsync(
    ctx,
    repoRoot,
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:trackshort)", "refs/heads"],
    8_000,
  );
  if (!localRes.ok) return "";
  const localRows = parseLocalBranchPopupRows(localRes.stdout, remoteNames);
  const trackedLocal = localRows.find((row) => (
    String(row.upstream || "").trim() === remoteRef
      || (row.remote === parsedRemote.remote && row.remoteBranch === parsedRemote.branch)
  ));
  if (trackedLocal?.name) return trackedLocal.name;
  const sameNameLocal = localRows.find((row) => String(row.name || "").trim() === parsedRemote.branch);
  return String(sameNameLocal?.name || "").trim();
}

/**
 * 执行远端分支签出尝试，优先落到已存在/应复用的本地分支，否则创建并跟踪本地分支，
 * 避免把 `origin/master` 之类的签出错误降级成 detached HEAD。
 */
async function executeRemoteBranchSwitchAttemptAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  remoteRef: string,
  forceCheckout: boolean,
  remoteNamesInput?: string[] | null,
): Promise<GitBranchSwitchAttemptResult> {
  const localBranch = await resolveRemoteCheckoutLocalBranchAsync(ctx, repoRoot, remoteRef, remoteNamesInput);
  if (localBranch) {
    return await executeDirectSwitchRefAttemptAsync(ctx, repoRoot, localBranch, forceCheckout);
  }

  const switchTrackArgv = forceCheckout
    ? ["switch", "--discard-changes", "--track", remoteRef]
    : ["switch", "--track", remoteRef];
  const switchTrackRes = await runGitSpawnAsync(ctx, repoRoot, switchTrackArgv, 120_000);
  if (switchTrackRes.ok) {
    return {
      ok: true,
      data: {
        switched: true,
        tracked: true,
        forced: forceCheckout || undefined,
      },
    };
  }

  const checkoutTrackArgv = forceCheckout
    ? ["checkout", "-f", "--track", remoteRef]
    : ["checkout", "--track", remoteRef];
  const checkoutTrackRes = await runGitSpawnAsync(ctx, repoRoot, checkoutTrackArgv, 120_000);
  if (checkoutTrackRes.ok) {
    return {
      ok: true,
      data: {
        switched: true,
        tracked: true,
        forced: forceCheckout || undefined,
      },
    };
  }

  return {
    ok: false,
    commandRes: checkoutTrackRes,
  };
}

/**
 * 执行一次分支签出尝试；远端分支优先落到本地跟踪分支，其余引用复用普通 switch/checkout 流程。
 */
async function executeSwitchRefAttemptAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  ref: string,
  forceCheckout: boolean,
): Promise<GitBranchSwitchAttemptResult> {
  const target = String(ref || "").trim();
  if (target.includes("/")) {
    const remoteNames = await readRemoteNamesAsync(ctx, repoRoot);
    const parsedRemote = parseUpstreamRef(target, remoteNames);
    if (parsedRemote?.remote && parsedRemote.branch && parsedRemote.branch !== "HEAD") {
      return await executeRemoteBranchSwitchAttemptAsync(ctx, repoRoot, target, forceCheckout, remoteNames);
    }
  }
  return await executeDirectSwitchRefAttemptAsync(ctx, repoRoot, target, forceCheckout);
}

/**
 * 根据 checkout 覆盖问题生成可复用的用户决策动作，统一承载智能签出与强制签出入口。
 */
function buildSwitchProblemActions(
  problem: GitUpdateProblemFileList,
  payload?: any,
): ReturnType<typeof buildUpdateProblemAction>[] {
  if (problem.operation !== "checkout" || problem.kind !== "local-changes-overwritten") return [];
  const smartAlreadyRequested = payload?.smartCheckout === true;
  const forceAlreadyRequested = payload?.forceCheckout === true;
  const saveChangesPolicy = payload?.saveChangesPolicy === "shelve" ? "shelve" : "stash";
  const actions: ReturnType<typeof buildUpdateProblemAction>[] = [];
  if (!smartAlreadyRequested) {
    actions.push({
      ...buildUpdateProblemAction("smart", "智能签出", {
        smartCheckout: true,
        saveChangesPolicy,
      }, "primary"),
      description: saveChangesPolicy === "shelve"
        ? "先搁置本地改动，签出完成后再尝试恢复。"
        : "先暂存本地改动，签出完成后再尝试恢复。",
    });
  }
  if (!forceAlreadyRequested) {
    actions.push(buildUpdateProblemAction("force", "强制签出", {
      forceCheckout: true,
    }, "danger"));
  }
  return actions;
}

/**
 * 把 checkout 覆盖问题打包为统一错误结果，供工作台弹窗与重试逻辑复用。
 */
function buildSwitchProblemResult(
  commandRes: GitExecResult,
  problem: GitUpdateProblemFileList,
  payload?: any,
  errorOverride?: string,
  extraData?: Record<string, any>,
): GitFeatureActionResult {
  return {
    ok: false,
    error: String(errorOverride || "").trim() || toGitErrorMessage(commandRes, "签出失败"),
    data: {
      ...(extraData || {}),
      shouldRefresh: true,
      smartOperationProblem: problem,
      operationProblem: buildOperationProblemFromFileList(problem, "branch-switch", {
        actions: buildSwitchProblemActions(problem, payload),
      }),
    },
  };
}

/**
 * 在智能签出重试失败后恢复之前保存的本地改动，并回传稳定的 preserving/problem 字段。
 */
async function buildSmartSwitchRetryFailureResultAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
  commandRes: GitExecResult,
  fallbackProblem: GitUpdateProblemFileList,
  saved: GitSavedLocalChanges | null,
): Promise<GitFeatureActionResult> {
  const retryProblem = parseSmartOperationProblem(commandRes, "checkout") || fallbackProblem;
  const restoreRes = await restoreLocalChangesAfterUpdateAsync(ctx, repoRoot, saved);
  if (!restoreRes.ok) {
    return buildSwitchProblemResult(commandRes, retryProblem, payload, undefined, {
      preservingState: restoreRes.preservingState,
      localChangesRestorePolicy: restoreRes.preservingState.localChangesRestorePolicy,
      savedLocalChangesRef: restoreRes.preservingState.savedLocalChangesRef,
    });
  }
  return buildSwitchProblemResult(commandRes, retryProblem, payload, undefined, restoreRes.preservingState
    ? {
        preservingState: restoreRes.preservingState,
        localChangesRestorePolicy: restoreRes.preservingState.localChangesRestorePolicy,
        savedLocalChangesRef: restoreRes.preservingState.savedLocalChangesRef,
      }
    : undefined);
}

/**
 * 在智能签出成功后恢复本地改动，并把 preserving 结果压平回前端可复用字段。
 */
async function finalizeSmartSwitchSuccessAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  attemptData: GitBranchSwitchAttemptResult & { ok: true },
  saved: GitSavedLocalChanges | null,
): Promise<GitFeatureActionResult> {
  const restoreRes = await restoreLocalChangesAfterUpdateAsync(ctx, repoRoot, saved);
  if (!restoreRes.ok) {
    return {
      ok: true,
      data: {
        ...attemptData.data,
        shouldRefresh: true,
        savedLocalChanges: !!saved,
        restoredLocalChanges: false,
        preservingState: restoreRes.preservingState,
        localChangesRestorePolicy: restoreRes.preservingState.localChangesRestorePolicy,
        savedLocalChangesRef: restoreRes.preservingState.savedLocalChangesRef,
      },
    };
  }
  return {
    ok: true,
    data: {
      ...attemptData.data,
      savedLocalChanges: !!saved,
      restoredLocalChanges: !!saved,
      preservingState: restoreRes.preservingState,
      localChangesRestorePolicy: restoreRes.preservingState?.localChangesRestorePolicy,
      savedLocalChangesRef: restoreRes.preservingState?.savedLocalChangesRef,
    },
  };
}

/**
 * 执行分支签出（优先 switch，失败回退 checkout），并对齐 checkout 覆盖问题的结构化提示与智能签出重试。
 */
async function switchRefAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  ref: string,
  payload?: any,
): Promise<GitFeatureActionResult> {
  const target = String(ref || "").trim();
  if (!target) return { ok: false, error: "缺少目标分支/引用" };
  const smartCheckout = payload?.smartCheckout === true;
  const forceCheckout = payload?.forceCheckout === true;

  const firstAttempt = await executeSwitchRefAttemptAsync(ctx, repoRoot, target, forceCheckout);
  if (firstAttempt.ok) return { ok: true, data: firstAttempt.data };

  const initialProblem = parseSmartOperationProblem(firstAttempt.commandRes, "checkout");
  if (!initialProblem) {
    return {
      ok: false,
      error: toGitErrorMessage(firstAttempt.commandRes, "签出失败"),
    };
  }

  if (!smartCheckout || initialProblem.kind !== "local-changes-overwritten") {
    const actionPayload = initialProblem.kind === "local-changes-overwritten"
      ? {
        ...(payload || {}),
        saveChangesPolicy: await resolveUpdateSaveChangesPolicyAsync(ctx, repoRoot, payload),
      }
      : payload;
    return buildSwitchProblemResult(firstAttempt.commandRes, initialProblem, actionPayload);
  }

  const optionsSnapshot = await getUpdateOptionsSnapshotAsync(createGitUpdateConfigRuntime(ctx, repoRoot), payload || {});
  const saveRes = await saveLocalChangesForUpdateAsync(
    ctx,
    repoRoot,
    `switch ${target}`,
    optionsSnapshot.methodResolution.saveChangesPolicy,
  );
  if (!saveRes.ok) {
    return buildSwitchProblemResult(firstAttempt.commandRes, initialProblem, payload, saveRes.error, {
      saveChangesPolicy: optionsSnapshot.methodResolution.saveChangesPolicy,
    });
  }

  const retryAttempt = await executeSwitchRefAttemptAsync(ctx, repoRoot, target, false);
  if (!retryAttempt.ok) {
    return await buildSmartSwitchRetryFailureResultAsync(
      ctx,
      repoRoot,
      payload,
      retryAttempt.commandRes,
      initialProblem,
      saveRes.saved,
    );
  }
  return await finalizeSmartSwitchSuccessAsync(ctx, repoRoot, retryAttempt, saveRes.saved);
}

/**
 * 读取工作区状态 + changelist 映射。
 */
async function getStatusWithChangeListsAsync(ctx: GitFeatureContext, repoRoot: string, projectPath?: string): Promise<GitFeatureActionResult> {
  const headInfo = await getHeadInfoAsync(ctx, repoRoot);
  const operationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  const operationSuggestedCommitMessage = await readOngoingOperationSuggestedCommitMessageAsync(ctx, repoRoot, operationState);
  const commitPanelPreferences = await readGitCommitPanelPreferencesAsync(ctx.userDataPath);
  const changeListPlatform = new ChangeListPlatformService({ userDataPath: ctx.userDataPath, repoRoot, projectPath });
  const snapshotState = changeListPlatform.getSnapshotState();
  const defaultCommitAuthor = await resolveDefaultCommitAuthorAsync(ctx, repoRoot);
  const gitCapabilityState = await getGitCapabilityStateAsync(ctx, repoRoot);
  const res = await runGitExecAsync(ctx, repoRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], 12_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "读取状态失败") };
  const parsed = parseCommitPanelStatusPorcelainV2Z(res.stdout);
  await hydrateCommitPanelConflictStateAsync(ctx, repoRoot, operationState, parsed);
  const groupingSnapshot = await buildCommitPanelGroupingSnapshotAsync({
    runGitExecAsync: async (runtimeRepoRoot, argv, timeoutMs) => {
      return await runGitExecAsync(ctx, runtimeRepoRoot, argv, timeoutMs);
    },
  }, repoRoot, parsed.map((entry) => entry.path));
  const sanitizedGroupingKeys = Array.from(new Set(
    (snapshotState.viewOptions.groupingKeys || []).filter((key) => groupingSnapshot.availableKeys.includes(key)),
  ));
  const viewOptions = sanitizedGroupingKeys.length !== (snapshotState.viewOptions.groupingKeys || []).length
    ? changeListPlatform.updateGroupingKeys(sanitizedGroupingKeys)
    : snapshotState.viewOptions;
  for (const entry of parsed) {
    const metadata = groupingSnapshot.entryMetadataByPath[String(entry.path || "").replace(/\\/g, "/")] || {};
    Object.assign(entry, metadata);
  }
  const commitPanelRepoRoots = Array.from(new Set(
    [repoRoot, ...parsed.map((entry) => String(entry.repositoryRoot || "").trim())]
      .map((root) => toFsPathAbs(root))
      .filter(Boolean),
  ));
  const commitHooksAvailableRepoRoots: string[] = [];
  for (const candidateRepoRoot of commitPanelRepoRoots) {
    if (!await detectCommitHooksAvailableAsync(ctx, candidateRepoRoot, runGitExecAsync))
      continue;
    commitHooksAvailableRepoRoots.push(candidateRepoRoot);
  }
  const changedPaths = parsed.filter((entry) => !entry.ignored).map((entry) => entry.path);
  const built = buildCommitPanelStatusSnapshot({
    repoRoot,
    branch: headInfo.branch,
    detached: headInfo.detached,
    headSha: headInfo.headSha,
    defaultCommitAuthor,
    stashPushPathspecSupported: gitCapabilityState.stashPushPathspecSupported,
    commitAndPush: commitPanelPreferences.commitAndPush,
    commitHooks: {
      available: commitHooksAvailableRepoRoots.length > 0,
      availableRepoRoots: commitHooksAvailableRepoRoots,
      disabledByPolicy: commitPanelPreferences.hooks.disableRunCommitHooks,
      runByDefault: !commitPanelPreferences.hooks.disableRunCommitHooks,
    },
    operationState,
    operationSuggestedCommitMessage,
    parsedEntries: parsed,
    repo: snapshotState.repo,
    viewOptions: {
      ...viewOptions,
      availableGroupingKeys: groupingSnapshot.availableKeys,
      groupByDirectory: sanitizedGroupingKeys.includes("directory"),
    },
    localChanges: snapshotState.localChanges,
  });
  if (built.changed) changeListPlatform.syncStatusChangedPaths(changedPaths);

  return {
    ok: true,
    data: built.snapshot,
  };
}

/**
 * 读取当前仓库可见的 commit panel 偏好快照，供前端提交选项 UI 与主流程共享。
 */
async function getCommitPanelPreferencesAsync(ctx: GitFeatureContext, repoRoot: string): Promise<GitFeatureActionResult> {
  const preferences = await readGitCommitPanelPreferencesAsync(ctx.userDataPath);
  const hooksAvailable = await detectCommitHooksAvailableAsync(ctx, repoRoot, runGitExecAsync);
  return {
    ok: true,
    data: {
      commitAndPush: preferences.commitAndPush,
      commitHooks: {
        available: hooksAvailable,
        availableRepoRoots: hooksAvailable ? [repoRoot] : [],
        disabledByPolicy: preferences.hooks.disableRunCommitHooks,
        runByDefault: !preferences.hooks.disableRunCommitHooks,
      },
    },
  };
}

/**
 * 保存 commit panel 偏好，并返回最新的规范化快照供前端即时刷新。
 */
async function saveCommitPanelPreferencesAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const preferences = await updateGitCommitPanelPreferencesAsync(ctx.userDataPath, {
    commitAndPush: payload?.commitAndPush && typeof payload.commitAndPush === "object" ? payload.commitAndPush : undefined,
    hooks: payload?.hooks && typeof payload.hooks === "object" ? payload.hooks : undefined,
  });
  const hooksAvailable = await detectCommitHooksAvailableAsync(ctx, repoRoot, runGitExecAsync);
  return {
    ok: true,
    data: {
      commitAndPush: preferences.commitAndPush,
      commitHooks: {
        available: hooksAvailable,
        availableRepoRoots: hooksAvailable ? [repoRoot] : [],
        disabledByPolicy: preferences.hooks.disableRunCommitHooks,
        runByDefault: !preferences.hooks.disableRunCommitHooks,
      },
    },
  };
}

/**
 * 从 `git var GIT_AUTHOR_IDENT` 提取默认作者；命令不可用时回退到 `user.name/user.email`。
 */
async function resolveDefaultCommitAuthorAsync(ctx: GitFeatureContext, repoRoot: string): Promise<string> {
  const identRes = await runGitExecAsync(ctx, repoRoot, ["var", "GIT_AUTHOR_IDENT"], 4_000);
  const identAuthor = normalizeGitAuthorIdent(String(identRes.stdout || ""));
  if (identAuthor) return identAuthor;
  const [nameRes, emailRes] = await Promise.all([
    runGitExecAsync(ctx, repoRoot, ["config", "--get", "user.name"], 4_000),
    runGitExecAsync(ctx, repoRoot, ["config", "--get", "user.email"], 4_000),
  ]);
  const name = String(nameRes.stdout || "").trim();
  const email = String(emailRes.stdout || "").trim();
  if (name && email) return `${name} <${email}>`;
  if (name) return name;
  if (email) return `<${email}>`;
  return "";
}

/**
 * 从 `git var GIT_AUTHOR_IDENT` 的原始输出里裁剪出 `Name <email>` 片段，忽略时间戳与时区。
 */
function normalizeGitAuthorIdent(stdout: string): string {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^(.*?<[^>]+>)(?:\s+\d+\s+[+-]\d{4})?$/);
  return String(match?.[1] || "").trim() || trimmed;
}

/**
 * 为 Git 能力缓存生成稳定键，保证不同 gitPath / repoRoot 组合互不污染。
 */
function buildGitCapabilityCacheKey(ctx: GitFeatureContext, repoRoot: string): string {
  return `${String(ctx.gitPath || "").trim()}::${String(repoRoot || "").trim()}`;
}

/**
 * 读取并缓存当前仓库的 Git 能力；探测失败时回退为最保守能力集。
 */
async function getGitCapabilityStateAsync(ctx: GitFeatureContext, repoRoot: string): Promise<GitCapabilityState> {
  const cacheKey = buildGitCapabilityCacheKey(ctx, repoRoot);
  const cached = gitCapabilityCache.get(cacheKey);
  if (cached) return cached;
  const versionRes = await runGitExecAsync(ctx, repoRoot, ["version"], 4_000);
  const nextState = versionRes.ok
    ? buildGitCapabilityState(String(versionRes.stdout || ""))
    : { stashPushPathspecSupported: false };
  gitCapabilityCache.set(cacheKey, nextState);
  return nextState;
}

/**
 * 独立读取 ignored 文件节点，避免与普通变更共用整表刷新链路。
 */
async function getIgnoredStatusAsync(ctx: GitFeatureContext, repoRoot: string): Promise<GitFeatureActionResult> {
  const res = await runGitSpawnAsync(ctx, repoRoot, ["ls-files", "--others", "-i", "--exclude-standard", "-z"], 120_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "读取已忽略文件失败") };
  const ignoredPaths = String(res.stdout || "")
    .split("\0")
    .map((one) => String(one || "").trim().replace(/\\/g, "/"))
    .filter(Boolean);
  const groupingSnapshot = await buildCommitPanelGroupingSnapshotAsync({
    runGitExecAsync: async (runtimeRepoRoot, argv, timeoutMs) => {
      return await runGitExecAsync(ctx, runtimeRepoRoot, argv, timeoutMs);
    },
  }, repoRoot, ignoredPaths);
  return {
    ok: true,
    data: {
      repoRoot,
      entries: ignoredPaths.map((ignoredPath) => ({
        path: ignoredPath,
        x: "!",
        y: "!",
        staged: false,
        unstaged: false,
        untracked: false,
        ignored: true,
        renamed: false,
        deleted: false,
        statusText: "已忽略",
        changeListId: "",
        ...(groupingSnapshot.entryMetadataByPath[ignoredPath] || {}),
      })),
    },
  };
}

/**
 * 解析 Git 目录下的真实路径；worktree 下 `.git` 可能是转发文件，因此必须走 `rev-parse --git-path`。
 */
async function resolveGitPathAsync(ctx: GitFeatureContext, repoRoot: string, gitPath: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const res = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", gitPath], 12_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, `解析 Git 路径失败：${gitPath}`) };
  const resolvedPath = String(res.stdout || "").trim();
  if (!resolvedPath) return { ok: false, error: `解析 Git 路径失败：${gitPath}` };
  return { ok: true, path: resolvedPath };
}

/**
 * 更新提交面板视图选项（目录 / 已忽略文件 / 预览行为）。
 */
function updateGitViewOption(ctx: GitFeatureContext, repoRoot: string, key: string, value: boolean, projectPath?: string): GitFeatureActionResult {
  try {
    const viewOptions = new ChangeListPlatformService({ userDataPath: ctx.userDataPath, repoRoot, projectPath })
      .updateViewOption(key as ChangeListViewOptionKey, value);
    return { ok: true, data: { viewOptions } };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || "不支持的视图选项") };
  }
}

/**
 * 更新提交面板 grouping key 集；以持久化 key 集替代旧版单一目录开关。
 */
function updateGitGroupingKeys(ctx: GitFeatureContext, repoRoot: string, payload: any, projectPath?: string): GitFeatureActionResult {
  const viewOptions = new ChangeListPlatformService({ userDataPath: ctx.userDataPath, repoRoot, projectPath })
    .updateGroupingKeys(payload?.groupingKeys);
  return { ok: true, data: { viewOptions } };
}

/**
 * 更新“配置本地更改”选项（暂存区域 / 变更列表）。
 */
function updateLocalChangesConfig(ctx: GitFeatureContext, repoRoot: string, key: string, value: boolean): GitFeatureActionResult {
  try {
    const localChanges = new ChangeListPlatformService({ userDataPath: ctx.userDataPath, repoRoot })
      .updateLocalChangesConfig(key as LocalChangesConfigKey, value);
    return { ok: true, data: { localChanges } };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || "不支持的本地更改配置项") };
  }
}

/**
 * 创建变更列表。
 */
function createChangeList(ctx: GitFeatureContext, repoRoot: string, name: string, setActive: boolean): GitFeatureActionResult {
  return createCommitPanelChangeList(ctx.userDataPath, repoRoot, name, setActive);
}

/**
 * 重命名变更列表。
 */
function renameChangeList(ctx: GitFeatureContext, repoRoot: string, id: string, name: string): GitFeatureActionResult {
  return renameCommitPanelChangeList(ctx.userDataPath, repoRoot, id, name);
}

/**
 * 删除变更列表，并将文件归并到活动更改列表。
 */
function deleteChangeList(ctx: GitFeatureContext, repoRoot: string, id: string, targetListIdInput?: string): GitFeatureActionResult {
  return deleteCommitPanelChangeList(ctx.userDataPath, repoRoot, id, targetListIdInput);
}

/**
 * 设置活动更改列表（新变更默认归入该列表）。
 */
function setActiveChangeList(ctx: GitFeatureContext, repoRoot: string, id: string): GitFeatureActionResult {
  return setCommitPanelActiveChangeList(ctx.userDataPath, repoRoot, id);
}

/**
 * 更新更改列表 comment/data 元数据，供按列表提交草稿与作者信息持久化复用。
 */
function updateChangeListData(ctx: GitFeatureContext, repoRoot: string, payload: any): GitFeatureActionResult {
  return updateCommitPanelChangeListData(ctx.userDataPath, repoRoot, String(payload?.id || ""), {
    comment: Object.prototype.hasOwnProperty.call(payload || {}, "comment") ? payload?.comment : undefined,
    data: Object.prototype.hasOwnProperty.call(payload || {}, "data") ? payload?.data : undefined,
  });
}

/**
 * 把前端提供的 move 条目状态规整为路径索引表；仅保留本次请求实际涉及的路径。
 */
function normalizeMoveEntryStateByPath(
  repoRoot: string,
  paths: string[],
  entryStatesInput: any,
): Record<string, { untracked: boolean; ignored: boolean }> {
  const expectedPaths = new Set(paths);
  const normalized: Record<string, { untracked: boolean; ignored: boolean }> = {};
  for (const entry of Array.isArray(entryStatesInput) ? entryStatesInput : []) {
    const path = normalizeCommitPanelRepoPaths(repoRoot, [entry?.path])[0] || "";
    if (!path || !expectedPaths.has(path)) continue;
    normalized[path] = {
      untracked: entry?.untracked === true,
      ignored: entry?.ignored === true,
    };
  }
  return normalized;
}

/**
 * 判断移动请求是否已具备完整条目状态；完整时可直接复用前端快照，避免整仓重复扫描。
 */
function hasCompleteMoveEntryState(
  paths: string[],
  entryStateByPath: Record<string, { untracked: boolean; ignored: boolean }>,
): boolean {
  return paths.every((path) => Object.prototype.hasOwnProperty.call(entryStateByPath, path));
}

/**
 * 移动文件到指定变更列表；仅在状态缺失时回退到 Git 扫描链路。
 */
async function moveFilesToChangeList(
  ctx: GitFeatureContext,
  repoRoot: string,
  pathsInput: any,
  targetListId: string,
  entryStatesInput?: any,
): Promise<GitFeatureActionResult> {
  const paths = normalizeCommitPanelRepoPaths(repoRoot, pathsInput);
  const entryStateByPath = normalizeMoveEntryStateByPath(repoRoot, paths, entryStatesInput);
  if (!hasCompleteMoveEntryState(paths, entryStateByPath)) {
    const statusRes = await runGitExecAsync(ctx, repoRoot, ["status", "--porcelain=v2", "-z", "--ignored=matching"], 12_000);
    if (!statusRes.ok) return { ok: false, error: toGitErrorMessage(statusRes, "读取文件状态失败") };
    Object.assign(
      entryStateByPath,
      Object.fromEntries(
        parseCommitPanelStatusPorcelainV2Z(statusRes.stdout).map((entry) => [entry.path, {
          untracked: entry.untracked,
          ignored: entry.ignored,
        }]),
      ),
    );
    const ignoredRes = await getIgnoredStatusAsync(ctx, repoRoot);
    if (ignoredRes.ok && Array.isArray(ignoredRes.data?.entries)) {
      for (const entry of ignoredRes.data.entries) {
        const path = String(entry.path || "").replace(/\\/g, "/");
        entryStateByPath[path] = {
          ignored: true,
          untracked: entryStateByPath[path]?.untracked === true,
        };
      }
    }
  }
  return await moveCommitPanelFilesToChangeListAsync(
    ctx.userDataPath,
    repoRoot,
    paths,
    targetListId,
    entryStateByPath,
    {
      addUntrackedPathsAsync: async (onePaths) => {
        const res = await runGitSpawnAsync(ctx, repoRoot, ["add", "--", ...onePaths], 120_000);
        return res.ok ? { ok: true } : { ok: false, error: toGitErrorMessage(res, "添加未跟踪文件失败") };
      },
      forceAddIgnoredPathsAsync: async (onePaths) => {
        const res = await runGitSpawnAsync(ctx, repoRoot, ["add", "-f", "--", ...onePaths], 120_000);
        return res.ok ? { ok: true } : { ok: false, error: toGitErrorMessage(res, "添加已忽略文件失败") };
      },
    },
  );
}

/**
 * 预览 ignored special node 可用的 ignore 目标，对齐上游的 ignore action group。
 */
async function getIgnoreTargetsAsync(ctx: GitFeatureContext, repoRoot: string, pathsInput: any): Promise<GitFeatureActionResult> {
  const gitExcludePath = await resolveGitPathAsync(ctx, repoRoot, "info/exclude");
  if (!gitExcludePath.ok || !gitExcludePath.path) return { ok: false, error: gitExcludePath.error || "解析 .git/info/exclude 失败" };
  return await listCommitPanelIgnoreTargetsAsync({
    repoRoot,
    gitExcludeFile: gitExcludePath.path,
    pathsInput,
  });
}

/**
 * 把未跟踪文件写入用户选择的 ignore 目标，并保持 worktree 场景下的 Git 目录路径正确。
 */
async function ignoreFilesAsync(ctx: GitFeatureContext, repoRoot: string, payload: { paths?: any; target?: CommitPanelIgnoreTarget }): Promise<GitFeatureActionResult> {
  const gitExcludePath = await resolveGitPathAsync(ctx, repoRoot, "info/exclude");
  if (!gitExcludePath.ok || !gitExcludePath.path) return { ok: false, error: gitExcludePath.error || "解析 .git/info/exclude 失败" };
  return await applyCommitPanelIgnoreTargetAsync({
    repoRoot,
    gitExcludeFile: gitExcludePath.path,
    pathsInput: payload?.paths,
    targetInput: payload?.target,
  });
}

/**
 * 提交选中文件（仅提交传入路径）。
 */
function normalizePushAfterCommitContext(
  data: any,
  fallbackRepoRoot: string,
): {
  repoRoots: string[];
  commitHashes: Array<{ repoRoot: string; commitHash: string }>;
  targetHash?: string;
} | null {
  const repoRoots = Array.from(new Set<string>(
    (Array.isArray(data?.repoRoots) ? data.repoRoots : [fallbackRepoRoot])
      .map((item: unknown) => String(item || "").trim())
      .filter((item: string): item is string => item.length > 0),
  ));
  const commitHashes = Array.isArray(data?.commitHashes)
    ? data.commitHashes
      .map((item: { repoRoot?: unknown; commitHash?: unknown }) => ({
        repoRoot: String(item?.repoRoot || "").trim(),
        commitHash: String(item?.commitHash || "").trim(),
      }))
      .filter((item: { repoRoot: string; commitHash: string }) => !!item.repoRoot && !!item.commitHash)
    : [];
  if (commitHashes.length <= 0) {
    const commitHash = String(data?.commitHash || "").trim();
    if (commitHash && repoRoots[0]) {
      commitHashes.push({
        repoRoot: repoRoots[0],
        commitHash,
      });
    }
  }
  if (commitHashes.length <= 0) return null;
  return {
    repoRoots,
    commitHashes,
    targetHash: String(data?.targetHash || commitHashes[0]?.commitHash || "").trim() || undefined,
  };
}

/**
 * 按 commit-and-push 设置决定“提交后直接推送还是打开预览”，并把结果统一回填到 commit.create 返回值。
 */
async function resolvePostCommitPushResultAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
  commitResult: GitFeatureActionResult,
): Promise<GitFeatureActionResult> {
  const commitIntent = String(payload?.intent || "").trim();
  const shouldPushAfterCommit = commitIntent
    ? commitIntent === "commitAndPush"
    : payload?.pushAfter === true;
  if (!commitResult.ok || !shouldPushAfterCommit) return commitResult;
  const pushAfterCommitContext = normalizePushAfterCommitContext(commitResult.data, repoRoot);
  if (!pushAfterCommitContext) return commitResult;

  const preferences = await readGitCommitPanelPreferencesAsync(ctx.userDataPath);
  let hasProtectedTarget = false;
  let shouldPreviewBecauseCannotPush = false;
  for (const entry of pushAfterCommitContext.commitHashes) {
    const previewRes = await getPushPreviewAsync(ctx, entry.repoRoot, { targetHash: entry.commitHash });
    if (!previewRes.ok || !previewRes.data) {
      shouldPreviewBecauseCannotPush = true;
      continue;
    }
    if (previewRes.data.protectedTarget === true) hasProtectedTarget = true;
    if (previewRes.data.canPush !== true) shouldPreviewBecauseCannotPush = true;
  }

  const shouldPreview = shouldPreviewBecauseCannotPush
    || (preferences.commitAndPush.previewOnCommitAndPush
      && (!preferences.commitAndPush.previewProtectedOnly || hasProtectedTarget));
  if (shouldPreview) {
    return {
      ...commitResult,
      data: {
        ...(commitResult.data || {}),
        pushAfterCommit: pushAfterCommitContext,
        postCommitPush: {
          mode: "preview",
          context: pushAfterCommitContext,
          protectedTarget: hasProtectedTarget,
        },
      },
    };
  }

  const pushResults: Array<{
    repoRoot: string;
    commitHash: string;
    remote?: string;
    remoteBranch?: string;
    upstream?: string;
  }> = [];
  for (const entry of pushAfterCommitContext.commitHashes) {
    const pushRes = await executePushAsync(ctx, entry.repoRoot, { targetHash: entry.commitHash });
    if (!pushRes.ok) {
      return {
        ok: false,
        error: `提交已创建，但自动推送失败：${String(pushRes.error || "推送失败")}`,
        data: {
          ...(commitResult.data || {}),
          commitSucceeded: true,
          pushAfterCommit: undefined,
          postCommitPush: {
            mode: "failed",
            repoRoot: entry.repoRoot,
            commitHash: entry.commitHash,
            error: String(pushRes.error || "推送失败"),
          },
        },
      };
    }
    pushResults.push({
      repoRoot: entry.repoRoot,
      commitHash: entry.commitHash,
      remote: String(pushRes.data?.remote || "").trim() || undefined,
      remoteBranch: String(pushRes.data?.remoteBranch || "").trim() || undefined,
      upstream: String(pushRes.data?.upstream || "").trim() || undefined,
    });
  }

  return {
    ...commitResult,
    data: {
      ...(commitResult.data || {}),
      pushAfterCommit: undefined,
      postCommitPush: {
        mode: "pushed",
        results: pushResults,
      },
    },
  };
}

/**
 * 提交选中文件（仅提交传入路径）。
 */
async function commitSelectedFilesAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  let emptyCherryPickCommitRepoRoot = "";
  const dependencies = {
    hasUnmergedFilesAsync,
    /**
     * 在提交工作流内部旁路观察 `git commit` 结果；若当前仓库处于 Cherry-pick 收尾阶段且命中 empty commit，
     * 则延后到外层统一执行 `git cherry-pick --skip`，避免改动通用 commit workflow 主干。
     */
    runGitSpawnAsync: async (
      runtimeCtx: GitFeatureContext,
      runtimeRepoRoot: string,
      argv: string[],
      timeoutMs?: number,
      envPatch?: NodeJS.ProcessEnv,
      stdin?: string | Buffer,
    ): Promise<GitExecResult> => {
      const result = await runGitSpawnAsync(runtimeCtx, runtimeRepoRoot, argv, timeoutMs, envPatch, stdin);
      if (
        !result.ok
        && runtimeRepoRoot === repoRoot
        && argv[0] === "commit"
        && await getRepositoryOperationStateAsync(ctx, runtimeRepoRoot) === "grafting"
        && isEmptyCherryPickResult(result)
      ) {
        emptyCherryPickCommitRepoRoot = runtimeRepoRoot;
      }
      return result;
    },
    runGitExecAsync,
    writeTempGitFileAsync,
    toGitErrorMessage,
    formatGitAuthorDate,
    resolveDefaultAuthorAsync: resolveDefaultCommitAuthorAsync,
    getHeadInfoAsync,
    getRepositoryOperationStateAsync,
  };
  const precheckChecks = await precheckCommitWorkflowAsync(ctx, repoRoot, payload, dependencies);
  const blockingCheck = precheckChecks.find((check) => check.blocking) || null;
  const confirmationChecks = precheckChecks.filter((check) => check.confirmationRequired === true);
  if (blockingCheck || confirmationChecks.length > 0) {
    return {
      ok: false,
      error: blockingCheck?.message || confirmationChecks[0]?.message || "提交前检查未通过",
      data: {
        checks: precheckChecks,
        blockingCheck: blockingCheck || undefined,
        confirmationChecks: confirmationChecks.length > 0 ? confirmationChecks : undefined,
      },
    };
  }
  const commitResult = await executeCommitWorkflowAsync(ctx, repoRoot, payload, dependencies);
  const finalCommitResult = !commitResult.ok && emptyCherryPickCommitRepoRoot
    ? await skipEmptyCherryPickAsync(ctx, emptyCherryPickCommitRepoRoot)
    : commitResult;
  const pushedCommitResult = await resolvePostCommitPushResultAsync(ctx, repoRoot, payload, finalCommitResult);
  if (!readOngoingOperationSavedLocalChanges(repoRoot))
    return pushedCommitResult;
  const nextOperationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  return await finalizeOngoingOperationSavedLocalChangesAsync(ctx, repoRoot, {
    ...pushedCommitResult,
    data: {
      ...(pushedCommitResult.data || {}),
      operationState: nextOperationState,
      completed: nextOperationState === "normal",
      shouldRefresh: pushedCommitResult.ok ? true : pushedCommitResult.data?.shouldRefresh === true,
    },
  }, nextOperationState);
}

/**
 * 为 rollback 动作补齐结构化 change 信息；若前端未显式传入状态，则回读当前 `git status` 推断。
 */
async function resolveRollbackChangesAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
): Promise<GitRollbackChange[]> {
  const explicitChanges = Array.isArray(payload?.changes)
    ? payload.changes
      .map((change: any) => ({
        path: String(change?.path || "").trim().replace(/\\/g, "/"),
        oldPath: String(change?.oldPath || "").trim().replace(/\\/g, "/") || undefined,
        x: String(change?.x || "").trim(),
        y: String(change?.y || "").trim(),
        staged: change?.staged === true,
        unstaged: change?.unstaged === true,
        untracked: change?.untracked === true,
        ignored: change?.ignored === true,
        renamed: change?.renamed === true,
        deleted: change?.deleted === true,
      }))
      .filter((change: GitRollbackChange) => !!change.path)
    : [];
  if (explicitChanges.length > 0) return explicitChanges;

  const files = normalizeRepoPaths(repoRoot, payload?.files);
  if (files.length <= 0) return [];

  const statusRes = await runGitExecAsync(ctx, repoRoot, ["status", "--porcelain=v2", "-z"], 12_000);
  if (!statusRes.ok) {
    return files.map((filePath) => ({ path: filePath }));
  }

  const statusEntries = parseCommitPanelStatusPorcelainV2Z(statusRes.stdout);
  const statusByPath = new Map<string, (typeof statusEntries)[number]>();
  for (const entry of statusEntries) {
    const filePath = String(entry.path || "").trim().replace(/\\/g, "/");
    if (filePath && !statusByPath.has(filePath)) statusByPath.set(filePath, entry);
    const oldPath = String(entry.oldPath || "").trim().replace(/\\/g, "/");
    if (oldPath && !statusByPath.has(oldPath)) statusByPath.set(oldPath, entry);
  }

  return files.map((filePath) => {
    const entry = statusByPath.get(filePath);
    if (!entry) return { path: filePath };
    return {
      path: String(entry.path || "").trim().replace(/\\/g, "/"),
      oldPath: String(entry.oldPath || "").trim().replace(/\\/g, "/") || undefined,
      x: String(entry.x || "").trim(),
      y: String(entry.y || "").trim(),
      staged: entry.staged === true,
      unstaged: entry.unstaged === true,
      untracked: entry.untracked === true,
      ignored: entry.ignored === true,
      renamed: entry.renamed === true,
      deleted: entry.deleted === true,
    } satisfies GitRollbackChange;
  });
}

/**
 * 回滚文件变更（包含暂存与工作区）。
 */
async function rollbackFilesAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const changes = await resolveRollbackChangesAsync(ctx, repoRoot, payload);
  return await executeRollbackChangesAsync({
    async runGitSpawnAsync(runtimeRepoRoot, argv, timeoutMs) {
      return await runGitSpawnAsync(ctx, runtimeRepoRoot, argv, timeoutMs);
    },
    toGitErrorMessage,
  }, repoRoot, changes);
}

/**
 * 按上游 `VirtualFileDeleteProvider` 语义删除文件/目录，仅做文件系统删除，不直接改写 Git 索引。
 */
async function deleteFilesAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  void ctx;
  const files = normalizeRepoPaths(repoRoot, payload?.files);
  const deleteTargets = normalizeRepoPaths(repoRoot, payload?.deleteTargets);
  const effectiveTargets = Array.from(new Set((deleteTargets.length > 0 ? deleteTargets : files).filter(Boolean)))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (effectiveTargets.length === 0) return { ok: false, error: "未选择需要删除的文件" };

  for (const rel of effectiveTargets) {
    const abs = path.join(repoRoot, rel);
    try {
      await fsp.rm(abs, { recursive: true, force: true });
    } catch (e: any) {
      return { ok: false, error: `删除文件失败：${String(e?.message || e)}` };
    }
  }
  return { ok: true };
}

/**
 * 优选（暂存）指定文件变更。
 */
async function stageFilesAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const files = normalizeRepoPaths(repoRoot, payload?.files);
  if (files.length === 0) return { ok: false, error: "未选择需要优选的文件" };
  const mode = String(payload?.mode || "content").trim();
  if (mode === "intentToAdd") {
    const intentToAddRes = await runGitSpawnAsync(ctx, repoRoot, ["add", "--intent-to-add", "--", ...files], 120_000);
    if (!intentToAddRes.ok) return { ok: false, error: toGitErrorMessage(intentToAddRes, "暂存但不添加内容失败") };
    invalidateCommitPanelResolvedConflictHolder(repoRoot);
    return { ok: true };
  }
  const addRes = await runGitSpawnAsync(ctx, repoRoot, ["add", "--", ...files], 120_000);
  if (!addRes.ok) {
    const forceAddRes = await runGitSpawnAsync(ctx, repoRoot, ["add", "-f", "--", ...files], 120_000);
    if (!forceAddRes.ok) return { ok: false, error: toGitErrorMessage(forceAddRes, "优选失败") };
  }
  invalidateCommitPanelResolvedConflictHolder(repoRoot);
  return { ok: true };
}

/**
 * 把指定文件从暂存区移除，仅恢复索引内容，不改动工作区文本。
 */
async function unstageFilesAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const files = normalizeRepoPaths(repoRoot, payload?.files);
  if (files.length === 0) return { ok: false, error: "未选择需要从暂存区移除的文件" };
  const res = await runGitSpawnAsync(ctx, repoRoot, ["restore", "--staged", "--", ...files], 120_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "从暂存区移除失败") };
  invalidateCommitPanelResolvedConflictHolder(repoRoot);
  return { ok: true };
}

/**
 * 仅还原工作区中的未暂存改动，对齐 Git Stage Revert 语义。
 */
async function revertUnstagedFilesAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const files = normalizeRepoPaths(repoRoot, payload?.files);
  if (files.length === 0) return { ok: false, error: "未选择需要还原的未暂存文件" };
  const res = await runGitSpawnAsync(ctx, repoRoot, ["restore", "--worktree", "--", ...files], 120_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "还原未暂存更改失败") };
  invalidateCommitPanelResolvedConflictHolder(repoRoot);
  return { ok: true };
}

/**
 * 按上游 `ReplaceFileConfirmationDialog` 语义，筛出“从修订中获取”前需要确认的本地已修改目标文件。
 */
async function collectRestoreFromRevisionModifiedFilesAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  files: string[],
): Promise<string[]> {
  if (files.length === 0) return [];

  const statusRes = await runGitExecAsync(ctx, repoRoot, ["status", "--porcelain=v2", "-z", "--", ...files], 12_000);
  if (!statusRes.ok) return [];

  const statusEntries = parseCommitPanelStatusPorcelainV2Z(statusRes.stdout);
  const candidateSet = new Set(files.map((filePath) => String(filePath || "").trim().replace(/\\/g, "/")).filter(Boolean));
  const modified = new Set<string>();

  for (const entry of statusEntries) {
    if (entry.ignored || entry.untracked) continue;

    const matchedTargets = [
      String(entry.path || "").trim().replace(/\\/g, "/"),
      String(entry.oldPath || "").trim().replace(/\\/g, "/"),
    ].filter((filePath) => candidateSet.has(filePath));

    for (const targetPath of matchedTargets) {
      if (!targetPath) continue;
      if (!fs.existsSync(path.join(repoRoot, targetPath))) continue;
      modified.add(targetPath);
    }
  }

  return files.filter((filePath) => modified.has(filePath));
}

/**
 * 构建“从修订中获取”覆盖本地修改前的确认问题，转译上游 `GetVersionAction` 的覆盖确认语义。
 */
function buildRestoreFromRevisionOverwriteProblem(repoRoot: string, files: string[]): GitFeatureActionResult {
  const normalizedFiles = Array.from(new Set(files.map((filePath) => String(filePath || "").trim().replace(/\\/g, "/")).filter(Boolean)));
  const description = normalizedFiles.length === 1
    ? "目标文件在本地已修改。继续后会覆盖当前本地内容。"
    : "部分目标文件在本地已修改。继续后会覆盖这些本地内容。";
  return {
    ok: false,
    error: description,
    data: {
      operationProblem: {
        operation: "checkout",
        kind: "local-changes-overwritten",
        title: "获取修订",
        description,
        files: normalizedFiles,
        source: "smart-operation",
        repoRoot,
        actions: [
          buildUpdateProblemAction("force", "覆盖已修改的文件", { overwriteModified: true }, "primary"),
        ],
      },
    },
  };
}

/**
 * 从指定修订恢复文件到当前工作区。
 */
async function restoreFilesFromRevisionAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const files = normalizeRepoPaths(repoRoot, payload?.files);
  const revision = String(payload?.revision || payload?.hash || "").trim() || "HEAD";
  const overwriteModified = payload?.overwriteModified === true;
  if (files.length === 0) return { ok: false, error: "未选择需要恢复的文件" };
  if (!overwriteModified) {
    const modifiedFiles = await collectRestoreFromRevisionModifiedFilesAsync(ctx, repoRoot, files);
    if (modifiedFiles.length > 0) return buildRestoreFromRevisionOverwriteProblem(repoRoot, modifiedFiles);
  }
  const checkoutRes = await runGitSpawnAsync(ctx, repoRoot, ["checkout", revision, "--", ...files], 120_000);
  if (!checkoutRes.ok) return { ok: false, error: toGitErrorMessage(checkoutRes, "从修订恢复失败") };
  return { ok: true };
}

/**
 * 写回工作区文件内容（文本模式），用于可编辑 Diff 场景。
 */
async function writeWorkingFileAsync(repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const relPath = String(payload?.path || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!relPath) return { ok: false, error: "缺少文件路径" };
  const targetAbs = path.resolve(repoRoot, relPath);
  const repoAbs = path.resolve(repoRoot);
  const rel = path.relative(repoAbs, targetAbs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === "..")
    return { ok: false, error: "非法文件路径" };
  try {
    await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
    await fsp.writeFile(targetAbs, String(payload?.content ?? ""), "utf8");
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || "写入文件失败") };
  }
}

/**
 * 读取应用内 merge 对话框所需的冲突快照，统一返回 base/ours/theirs/working 四份文本。
 */
async function getConflictMergeSnapshotActionAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
): Promise<GitFeatureActionResult> {
  /**
   * 当前 action 仍保留独立入口，但冲突 sides 是否反转统一通过仓库操作状态判定。
   */
  const operationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  const relPath = String(payload?.path || "").trim();
  if (!relPath) {
    return {
      ok: false,
      error: "缺少冲突文件路径",
    };
  }
  const resolverEntries = await describeCommitPanelConflictResolverEntriesAsync({
    runtime: {
      runGitExecAsync: async (argv, timeoutMs) => {
        return await runGitExecAsync(ctx, repoRoot, argv, timeoutMs);
      },
    },
    repoRoot,
    relPaths: [relPath],
    reverse: payload?.reverse === true || operationState === "rebasing",
  });
  const resolverEntry = resolverEntries[0];
  if (!resolverEntry) {
    return {
      ok: false,
      error: "当前文件已不再处于未解决冲突状态",
    };
  }
  if (!resolverEntry.canOpenMerge) {
    return {
      ok: false,
      error: "当前冲突文件过大或包含二进制内容，无法在应用内合并",
    };
  }
  const result = await getCommitPanelConflictMergeSnapshotAsync({
    runtime: {
      runGitExecAsync: async (argv, timeoutMs) => {
        return await runGitExecAsync(ctx, repoRoot, argv, timeoutMs);
      },
    },
    repoRoot,
    relPath,
    reverse: payload?.reverse === true || operationState === "rebasing",
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
    };
  }
  return {
    ok: true,
    data: result.snapshot,
  };
}

/**
 * 读取统一 merge session 快照，让多文件冲突表与 resolved holder 共享同一份状态源。
 */
async function getConflictResolverEntriesActionAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
): Promise<GitFeatureActionResult> {
  const paths = normalizeRepoPaths(repoRoot, payload?.paths);
  const operationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  const resolvedHolder = await getCommitPanelResolvedConflictHolderSnapshotAsync({
    runtime: {
      runGitExecAsync: async (argv, timeoutMs) => {
        return await runGitExecAsync(ctx, repoRoot, argv, timeoutMs);
      },
    },
    repoRoot,
    operationState,
    forceRefresh: true,
  });
  const snapshot = await buildCommitPanelConflictMergeSessionSnapshotAsync({
    runtime: {
      runGitExecAsync: async (argv, timeoutMs) => {
        return await runGitExecAsync(ctx, repoRoot, argv, timeoutMs);
      },
    },
    repoRoot,
    unresolvedPaths: paths,
    reverse: payload?.reverse === true || operationState === "rebasing",
    resolvedHolder,
  });
  return {
    ok: true,
    data: snapshot,
  };
}

/**
 * 批量采用 ours/theirs 并加入索引，补齐统一冲突入口的快速解析动作。
 */
async function applyConflictResolverSideActionAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
): Promise<GitFeatureActionResult> {
  const paths = normalizeRepoPaths(repoRoot, payload?.paths);
  const side = String(payload?.side || "").trim();
  if (side !== "ours" && side !== "theirs") return { ok: false, error: "不支持的冲突处理动作" };
  if (paths.length <= 0) return { ok: false, error: "缺少冲突文件路径" };
  const operationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  const result = await applyCommitPanelConflictResolverSideAsync({
    runtime: {
      runGitExecAsync: async (argv, timeoutMs) => {
        return await runGitExecAsync(ctx, repoRoot, argv, timeoutMs);
      },
      runGitSpawnAsync: async (argv, timeoutMs) => {
        return await runGitSpawnAsync(ctx, repoRoot, argv, timeoutMs);
      },
    },
    repoRoot,
    relPaths: paths,
    side,
    reverse: payload?.reverse === true || operationState === "rebasing",
  });
  if (!result.ok) return result;
  invalidateCommitPanelResolvedConflictHolder(repoRoot);
  return {
    ok: true,
    data: {
      appliedPaths: result.appliedPaths,
    },
  };
}

/**
 * 为 stage 专用比较模式构建底层 git diff 命令，统一处理方向翻转与 patch/numstat 读取。
 */
function buildStageCompareDiffArgv(mode: GitDiffMode, relPath: string, forNumstat: boolean = false): string[] | null {
  if (mode === "stagedToLocal") {
    return forNumstat
      ? ["diff", "--numstat", "--", relPath]
      : ["diff", "--", relPath];
  }
  if (mode === "localToStaged") {
    return forNumstat
      ? ["diff", "-R", "--numstat", "--", relPath]
      : ["diff", "-R", "--", relPath];
  }
  return null;
}

/**
 * 规整 diff 路径参数；rename 场景下同时携带 old/new path，避免只按单侧路径读取导致内容缺失。
 */
function resolveDiffPathspecs(relPath: string, oldPath?: string): string[] {
  const pathSet = new Set<string>();
  const normalizedRelPath = String(relPath || "").trim().replace(/\\/g, "/");
  const normalizedOldPath = String(oldPath || "").trim().replace(/\\/g, "/");
  if (normalizedOldPath) pathSet.add(normalizedOldPath);
  if (normalizedRelPath) pathSet.add(normalizedRelPath);
  return Array.from(pathSet);
}

/**
 * 为“引用 vs 引用 / 引用 vs 工作树”比较构建底层 git diff 命令，统一处理 rename 与路径过滤。
 */
function buildRevisionCompareDiffArgv(args: {
  leftRef: string;
  rightRef?: string;
  relPath: string;
  oldPath?: string;
  forNumstat?: boolean;
}): string[] | null {
  const leftRef = String(args.leftRef || "").trim();
  if (!leftRef) return null;
  const argv = ["diff", "-M"];
  if (args.forNumstat) argv.push("--numstat");
  argv.push(leftRef);
  const rightRef = String(args.rightRef || "").trim();
  if (rightRef) argv.push(rightRef);
  const pathspecs = resolveDiffPathspecs(args.relPath, args.oldPath);
  if (pathspecs.length > 0) argv.push("--", ...pathspecs);
  return argv;
}

/**
 * 从 diff 请求里解析左右引用；`revisionToRevision` 固定使用 `hashes[0/1]` 作为左右两侧。
 */
function resolveRevisionCompareRefs(payload: {
  hash?: string;
  hashes?: string[];
}): { leftRef: string; rightRef: string } | null {
  const hashes = Array.isArray(payload.hashes) ? payload.hashes.map((one) => String(one || "").trim()).filter(Boolean) : [];
  if (hashes.length >= 2) {
    return {
      leftRef: hashes[0]!,
      rightRef: hashes[1]!,
    };
  }
  return null;
}

/**
 * 把引用标题压缩为适合 Diff 头部展示的短文本；哈希保留 8 位，分支/标签则直接显示原名。
 */
function formatDiffRevisionTitle(ref: string, fallback: string): string {
  const value = String(ref || "").trim();
  if (!value) return fallback;
  return /^[0-9a-f]{7,40}$/i.test(value) ? value.slice(0, 8) : value;
}

/**
 * 判断 diff 是否为二进制。
 */
async function isBinaryDiffAsync(ctx: GitFeatureContext, repoRoot: string, mode: string, relPath: string, hash?: string): Promise<boolean> {
  if (!relPath) return false;
  let argv: string[] = [];
  if (mode === "staged") argv = ["diff", "--cached", "--numstat", "--", relPath];
  else if (mode === "commit") argv = ["show", "--numstat", "--pretty=format:", String(hash || "HEAD"), "--", relPath];
  else argv = buildStageCompareDiffArgv(mode as GitDiffMode, relPath, true) || ["diff", "--numstat", "--", relPath];
  const res = await runGitExecAsync(ctx, repoRoot, argv, 10000);
  if (!res.ok) return false;
  const lines = String(res.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return lines.some((line) => {
    const cols = line.split(/\s+/);
    return cols.length >= 3 && cols[0] === "-" && cols[1] === "-";
  });
}

/**
 * 读取 Git blob 文本内容（不存在时返回空字符串）。
 */
async function readGitBlobTextAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  spec: string,
): Promise<{ ok: boolean; text: string; isBinary?: boolean }> {
  const res = await runGitExecAsync(ctx, repoRoot, ["show", spec], 12000);
  if (!res.ok) return { ok: false, text: "" };
  const text = String(res.stdout || "");
  if (text.includes("\u0000")) return { ok: false, text: "", isBinary: true };
  return { ok: true, text };
}

/**
 * 读取工作区文件文本内容（不存在时返回空字符串）。
 */
async function readWorkingTextAsync(
  repoRoot: string,
  relPath: string,
): Promise<{ ok: boolean; text: string; tooLarge?: boolean; isBinary?: boolean }> {
  const abs = path.join(repoRoot, relPath);
  try {
    const st = await fsp.stat(abs);
    if (st.size > 2 * 1024 * 1024) return { ok: false, text: "", tooLarge: true };
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return { ok: false, text: "", isBinary: true };
    return { ok: true, text: buf.toString("utf8") };
  } catch {
    return { ok: false, text: "" };
  }
}

type GitCommitChangedFile = {
  status: string;
  path: string;
  oldPath?: string;
};

type GitCommitLineStats = {
  additions: number;
  deletions: number;
};

type GitFileHistoryCommitEntry = {
  hash: string;
  files: GitCommitChangedFile[];
};

type GitStructuredLogEntry = {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  subject: string;
  decorations: string;
  files: GitCommitChangedFile[];
};

type GitStructuredFileHistoryEntry = GitStructuredLogEntry & {
  historyPath: string;
};

type GitFileHistoryStart = {
  revisions: string[];
  path: string;
};

/**
 * 解析 `git diff-tree --name-status` 输出，统一得到“当前路径 + 旧路径”结构。
 * - 普通状态：`M<TAB>path`
 * - 重命名/复制：`R100<TAB>old<TAB>new`
 */
function parseCommitChangedFiles(stdout: string): GitCommitChangedFile[] {
  const files: GitCommitChangedFile[] = [];
  const rows = String(stdout || "").split(/\r?\n/).map((one) => String(one || "").trim()).filter(Boolean);
  for (const row of rows) {
    const cols = row.split(/\t+/);
    if (cols.length < 2) continue;
    const status = String(cols[0] || "").trim();
    const statusCode = status[0] || "";
    if ((statusCode === "R" || statusCode === "C") && cols.length >= 3) {
      const oldPath = decodeGitEscapedText(String(cols[1] || "").trim());
      const filePath = decodeGitEscapedText(String(cols[2] || "").trim());
      if (filePath) files.push({ status, path: filePath, oldPath: oldPath || undefined });
      continue;
    }
    const filePath = decodeGitEscapedText(String(cols[1] || "").trim());
    if (filePath) files.push({ status, path: filePath });
  }
  return files;
}

/**
 * 解析 `git show --numstat --format=` 输出，汇总单个提交的新增/删除行数。
 * - 二进制文件以 `-` 表示，不计入文本行数统计；
 * - 仅依赖前两列数值，路径列即使包含 rename 展示也不会影响统计。
 */
function parseCommitLineStats(stdout: string): GitCommitLineStats {
  const rows = String(stdout || "").split(/\r?\n/).map((one) => String(one || "").trim()).filter(Boolean);
  let additions = 0;
  let deletions = 0;
  for (const row of rows) {
    const cols = row.split(/\t+/);
    if (cols.length < 3) continue;
    const added = Number.parseInt(String(cols[0] || "").trim(), 10);
    const deleted = Number.parseInt(String(cols[1] || "").trim(), 10);
    if (Number.isFinite(added) && added >= 0) additions += added;
    if (Number.isFinite(deleted) && deleted >= 0) deletions += deleted;
  }
  return { additions, deletions };
}

/**
 * 解析 `git log --follow --name-status --format=%H` 输出，得到“提交 -> 变更文件”列表。
 */
function parseFileHistoryCommitEntries(stdout: string): GitFileHistoryCommitEntry[] {
  const blocks = String(stdout || "")
    .split(/\r?\n\r?\n+/)
    .map((one) => String(one || "").trim())
    .filter(Boolean);
  const entries: GitFileHistoryCommitEntry[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((one) => String(one || "").trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const hash = String(lines[0] || "").trim();
    if (!hash) continue;
    const files = parseCommitChangedFiles(lines.slice(1).join("\n"));
    entries.push({ hash, files });
  }
  return entries;
}

/**
 * 统一解析单条 git log 头部字段，供普通日志与文件历史专用日志共用。
 */
function parseStructuredLogHeader(row: string): Omit<GitStructuredLogEntry, "files"> | null {
  const seg = String(row || "").trim().split("\x00");
  const hash = String(seg[0] || "").trim();
  if (!hash) return null;
  return {
    hash,
    parents: String(seg[1] || "").trim().split(/\s+/).filter(Boolean),
    authorName: String(seg[2] || "").trim(),
    authorEmail: String(seg[3] || "").trim(),
    authorDate: String(seg[4] || "").trim(),
    subject: decodeGitEscapedText(String(seg[5] || "")),
    decorations: decodeGitEscapedText(String(seg[6] || "").trim()),
  };
}

/**
 * 解析带 `--name-status` 的结构化日志输出，得到“提交元数据 + 变更文件”列表。
 */
function parseStructuredLogEntries(stdout: string): GitStructuredLogEntry[] {
  const blocks = String(stdout || "")
    .split("\x1e")
    .map((one) => String(one || "").trim())
    .filter(Boolean);
  const entries: GitStructuredLogEntry[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const header = parseStructuredLogHeader(String(lines[0] || ""));
    if (!header) continue;
    entries.push({
      ...header,
      files: parseCommitChangedFiles(lines.slice(1).join("\n")),
    });
  }
  return entries;
}

/**
 * 把内部结构化日志项压平成前端日志列表项，保持既有 UI 数据契约稳定。
 * - 文件历史专用快路径会附带 `historyPath`，供前端直接打开对应提交的 Diff。
 */
function toGitLogListItem(entry: Omit<GitStructuredLogEntry, "files"> & { historyPath?: string }): any {
  const item: any = {
    hash: entry.hash,
    shortHash: entry.hash.slice(0, 8),
    parents: entry.parents,
    authorName: entry.authorName,
    authorEmail: entry.authorEmail,
    authorDate: entry.authorDate,
    subject: entry.subject,
    decorations: entry.decorations,
  };
  const historyPath = normalizeGitRelativePath(entry.historyPath || "");
  if (historyPath) item.historyPath = historyPath;
  return item;
}

/**
 * 为文件历史链路规整相对路径，统一使用 `/` 分隔，避免 rename 续追时路径键不一致。
 */
function normalizeGitRelativePath(value: string): string {
  return String(value || "").trim().replace(/\\/g, "/");
}

/**
 * 构造文件历史续追队列键，避免 merge/rename 场景重复排入同一路径与起点。
 */
function buildFileHistoryStartKey(start: GitFileHistoryStart): string {
  return `${normalizeGitRelativePath(start.path)}@@${start.revisions.map((one) => String(one || "").trim()).filter(Boolean).join("|")}`;
}

/**
 * 根据当前日志过滤器判断是否可切到平台风格的文件历史专用快路径。
 * - 仅支持 path + followRenames，且不叠加 author/date/text 过滤；
 * - 与上游 `GitLogHistoryHandler` 一致，只优先对齐 revision/branch 入口语义。
 */
function shouldUseDedicatedFileHistoryLog(filters: {
  followRenames: boolean;
  pathFilter: string;
  authorFilters: string[];
  dateFrom: string;
  dateTo: string;
  textFilter: string;
}): boolean {
  return !!filters.followRenames
    && !!normalizeGitRelativePath(filters.pathFilter)
    && filters.authorFilters.length <= 0
    && !String(filters.dateFrom || "").trim()
    && !String(filters.dateTo || "").trim()
    && !String(filters.textFilter || "").trim();
}

/**
 * 把日志过滤器映射为文件历史的起始修订集合，对齐上游 `History Up to Here / Show File History` 入口。
 */
function buildFileHistoryStartRevisions(branchFilter: string, revisionFilter: string): string[] {
  const revision = String(revisionFilter || "").trim();
  if (revision) return [revision];
  const branch = String(branchFilter || "").trim();
  if (branch && branch !== "all") return [branch];
  return ["HEAD"];
}

/**
 * 执行单段文件历史日志读取。
 * - 不直接使用 `--follow`，而是先取“当前路径段”的历史；
 * - 当命中 rename 边界时，再由调用方续追旧路径，贴近上游 `getHistoryFast + collectHistory` 的职责拆分。
 */
async function loadFileHistorySegmentAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  start: GitFileHistoryStart,
  limit: number,
): Promise<{ ok: true; entries: GitStructuredLogEntry[] } | { ok: false; error: string }> {
  const revisions = start.revisions.map((one) => String(one || "").trim()).filter(Boolean);
  if (revisions.length === 0) return { ok: true, entries: [] };
  const argv = [
    "log",
    "--name-status",
    "--date=iso-strict",
    "--pretty=format:%x1e%H%x00%P%x00%an%x00%ae%x00%ad%x00%s%x00",
    "--encoding=UTF-8",
    "--max-count",
    String(Math.max(1, limit)),
    ...revisions,
    "--",
    normalizeGitRelativePath(start.path),
  ];
  const res = await runGitExecAsync(ctx, repoRoot, argv, 15_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "读取文件历史失败") };
  return { ok: true, entries: parseStructuredLogEntries(res.stdout) };
}

/**
 * 读取 rename 边界提交在完整提交视角下的旧路径，并据此生成下一段历史起点。
 */
async function resolveFileHistoryRenameStartsAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  trackedPath: string,
  entry: GitStructuredLogEntry,
  parentMap: Map<string, string[]>,
): Promise<GitFileHistoryStart[]> {
  const parents = parentMap.get(entry.hash) || [];
  if (parents.length === 0) return [];
  const changedFiles = await getCommitChangedFilesAsync(ctx, repoRoot, entry.hash);
  const normalizedTrackedPath = normalizeGitRelativePath(trackedPath);
  const renameMatch = changedFiles.find((file) => (
    normalizeGitRelativePath(file.path) === normalizedTrackedPath
      && !!normalizeGitRelativePath(file.oldPath || "")
  ));
  let previousPath = normalizeGitRelativePath(renameMatch?.oldPath || "");
  if (!previousPath) {
    const addedMatch = changedFiles.find((file) => (
      normalizeGitRelativePath(file.path) === normalizedTrackedPath
        && String(file.status || "").trim().charAt(0).toUpperCase() === "A"
    ));
    const deletedFiles = changedFiles.filter((file) => (
      String(file.status || "").trim().charAt(0).toUpperCase() === "D"
        && !!normalizeGitRelativePath(file.path)
    ));
    if (addedMatch && deletedFiles.length === 1) {
      previousPath = normalizeGitRelativePath(deletedFiles[0]?.path || "");
    }
  }
  if (!previousPath) return [];
  return parents
    .map((parent) => String(parent || "").trim())
    .filter(Boolean)
    .map((parent) => ({
      revisions: [parent],
      path: previousPath,
    }));
}

/**
 * 按 rename 边界逐段收集文件历史。
 * - 每一段仅查询当前路径的直接历史，避免 `git log --follow` 首屏扫描整条 rename 链；
 * - 当段尾命中 rename 候选提交时，再读取整提交变更并续追旧路径；
 * - 每条结果额外写回其所在路径段，供前端直接定位该提交对应的历史路径。
 */
async function collectDedicatedFileHistoryEntriesAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  initialPath: string,
  initialRevisions: string[],
  take: number,
): Promise<{ ok: true; entries: GitStructuredFileHistoryEntry[] } | { ok: false; error: string }> {
  const normalizedPath = normalizeGitRelativePath(initialPath);
  const queue: GitFileHistoryStart[] = [{
    revisions: initialRevisions.map((one) => String(one || "").trim()).filter(Boolean),
    path: normalizedPath,
  }];
  const queued = new Set<string>(queue.map(buildFileHistoryStartKey));
  const visitedCommits = new Set<string>();
  const collected: GitStructuredFileHistoryEntry[] = [];

  while (queue.length > 0 && collected.length < take) {
    const start = queue.shift()!;
    const remaining = take - collected.length;
    const segmentRes = await loadFileHistorySegmentAsync(ctx, repoRoot, start, remaining);
    if (!segmentRes.ok) return segmentRes;
    const segmentHistoryPath = normalizeGitRelativePath(start.path);
    const segmentEntries = segmentRes.entries
      .filter((entry) => {
        if (visitedCommits.has(entry.hash)) return false;
        visitedCommits.add(entry.hash);
        return true;
      })
      .map((entry) => ({
        ...entry,
        historyPath: segmentHistoryPath,
      }));
    if (segmentEntries.length === 0) continue;

    collected.push(...segmentEntries);
    if (collected.length >= take) break;

    const boundaryEntry = segmentEntries[segmentEntries.length - 1];
    if (!boundaryEntry) continue;
    const parentMap = await loadCommitParentMapAsync(ctx, repoRoot, [boundaryEntry.hash]);
    const renameStarts = await resolveFileHistoryRenameStartsAsync(ctx, repoRoot, start.path, boundaryEntry, parentMap);
    for (const renameStart of renameStarts) {
      const key = buildFileHistoryStartKey(renameStart);
      if (queued.has(key)) continue;
      queued.add(key);
      queue.push(renameStart);
    }
  }

  return { ok: true, entries: collected };
}

/**
 * 读取单个提交的变更文件列表，并尽量识别重命名后保留旧路径信息。
 */
async function getCommitChangedFilesAsync(ctx: GitFeatureContext, repoRoot: string, hash: string): Promise<GitCommitChangedFile[]> {
  const res = await runGitExecAsync(ctx, repoRoot, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", hash], 12_000);
  if (!res.ok) return [];
  return parseCommitChangedFiles(res.stdout);
}

/**
 * 读取单个提交的文本行数统计，返回总新增/总删除行数。
 */
async function getCommitLineStatsAsync(ctx: GitFeatureContext, repoRoot: string, hash: string): Promise<GitCommitLineStats> {
  const res = await runGitExecAsync(ctx, repoRoot, ["show", "--numstat", "--format=", hash], 12_000);
  if (!res.ok) return { additions: 0, deletions: 0 };
  return parseCommitLineStats(res.stdout);
}

/**
 * 解析文件历史模式下“选中提交对应的真实文件路径”，用于 rename 链路中的自动 Diff 联动。
 */
async function resolveFileHistoryPathAtCommitAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const inputPath = String(payload?.path || "").trim().replace(/\\/g, "/");
  const targetHash = String(payload?.hash || payload?.targetHash || "").trim();
  const revision = String(payload?.revision || "").trim();
  if (!inputPath) return { ok: false, error: "缺少文件路径" };
  if (!targetHash) return { ok: false, error: "缺少目标提交哈希" };

  const argv = ["log", "--follow", "--name-status", "--format=%H", "-M"] as string[];
  if (revision) argv.push(revision);
  argv.push("--", inputPath);

  const res = await runGitExecAsync(ctx, repoRoot, argv, 20_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "解析文件历史路径失败") };

  const entries = parseFileHistoryCommitEntries(res.stdout);
  let trackedPath = inputPath;
  for (const entry of entries) {
    const matched = entry.files.find((file) => {
      const filePath = String(file.path || "").trim();
      const oldPath = String(file.oldPath || "").trim();
      return filePath === trackedPath || oldPath === trackedPath;
    });
    if (entry.hash === targetHash) {
      return {
        ok: true,
        data: {
          path: String(matched?.path || trackedPath).trim() || trackedPath,
        },
      };
    }
    if (matched?.oldPath && String(matched.path || "").trim() === trackedPath) {
      trackedPath = String(matched.oldPath || "").trim() || trackedPath;
      continue;
    }
    if (matched?.path) trackedPath = String(matched.path || "").trim() || trackedPath;
  }

  return {
    ok: true,
    data: {
      path: trackedPath,
    },
  };
}

/**
 * 从提交消息中提取 subject（首行），用于对齐上游的 squash 消息整理规则。
 */
function getCommitMessageSubject(message: string): string {
  const text = String(message || "");
  return text.split(/\r?\n/, 1)[0] || "";
}

/**
 * 判断消息是否为 autosquash（fixup!/squash!/amend!）前缀。
 */
function isAutosquashCommitMessage(message: string): boolean {
  return /^(fixup|squash|amend)! /i.test(getCommitMessageSubject(message));
}

/**
 * 当 autosquash 目标提交也在集合中时，去掉前缀 subject，仅保留正文。
 */
function trimAutosquashCommitMessage(message: string): string {
  if (!isAutosquashCommitMessage(message)) return String(message || "");
  const body = String(message || "").split(/\r?\n/).slice(1).join("\n").trim();
  return body;
}

/**
 * 按上游 `GitSquashedCommitsMessage.prettySquash` 思路生成压缩提交初始消息。
 */
function buildPrettySquashMessage(messagesInput: string[]): string {
  const messages = messagesInput.map((one) => String(one || "")).filter((one) => one.length > 0);
  const distinctSubjects = new Set(
    messages
      .map((one) => (isAutosquashCommitMessage(one) ? "" : getCommitMessageSubject(one)))
      .filter(Boolean),
  );
  const uniqueMessages: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    let normalized = message;
    const subject = getCommitMessageSubject(message);
    const autosquashMatch = subject.match(/^(fixup|squash|amend)! (.+)$/i);
    if (autosquashMatch && distinctSubjects.has(String(autosquashMatch[2] || "").trim())) {
      normalized = trimAutosquashCommitMessage(message);
    }
    const clean = String(normalized || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    uniqueMessages.push(clean);
  }
  return uniqueMessages.join("\n\n\n");
}

/**
 * 判断 action 是否会产出一个“保留提交”的 rebase 节点。
 */
function isInteractiveRebaseKeepAction(action: GitInteractiveRebaseAction): boolean {
  return action === "pick" || action === "edit" || action === "reword";
}

/**
 * 判断提交标题是否属于 autosquash 语义，便于在应用内编辑器中给出接近上游的显式提示。
 */
function isAutosquashCommitSubject(subject: string): boolean {
  return /^(fixup|squash|amend)! /i.test(getCommitMessageSubject(String(subject || "")));
}

/**
 * 构造结构化 interactive rebase 不可用结果，便于前端在错误提示外拿到稳定 reason code。
 */
function buildInteractiveRebasePlanFailure(
  reasonCode: GitInteractiveRebasePlanFailureCode,
  reasonMessage: string,
): GitInteractiveRebasePlanFailureResult {
  const message = String(reasonMessage || "").trim() || "读取交互式变基计划失败";
  return {
    ok: false,
    error: message,
    data: {
      reasonCode,
      reasonMessage: message,
    },
  };
}

/**
 * 构造统一历史改写反馈对象，供 interactive rebase / editMessage / deleteCommit 共用。
 */
function buildHistoryRewriteFeedback(args: {
  action: GitHistoryRewriteAction;
  tone: GitHistoryRewriteTone;
  title: string;
  message: string;
  detailLines?: string[];
  undo?: GitHistoryRewriteUndoInfo;
  reasonCode?: string;
  operationState?: GitRepositoryOperationState;
  shouldRefresh?: boolean;
  completed?: boolean;
}): GitHistoryRewriteFeedback {
  const detailLines = Array.from(new Set(
    (Array.isArray(args.detailLines) ? args.detailLines : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  ));
  const undoPayload = args.undo?.payload;
  const undo = undoPayload
    && String(undoPayload.oldHead || "").trim()
    && String(undoPayload.newHead || "").trim()
    ? {
        label: String(args.undo?.label || "").trim() || "撤销",
        payload: {
          kind: "delete-commit" as const,
          repoRoot: String(undoPayload.repoRoot || "").trim() || undefined,
          oldHead: String(undoPayload.oldHead || "").trim(),
          newHead: String(undoPayload.newHead || "").trim(),
        },
      }
    : undefined;
  return {
    action: args.action,
    tone: args.tone,
    title: String(args.title || "").trim() || "历史改写结果",
    message: String(args.message || "").trim() || "Git 历史改写已处理",
    detailLines: detailLines.length > 0 ? detailLines : undefined,
    undo,
    reasonCode: String(args.reasonCode || "").trim() || undefined,
    operationState: args.operationState,
    shouldRefresh: args.shouldRefresh === true,
    completed: args.completed !== false,
  };
}

/**
 * 构造统一历史改写失败结果，并把原始附加数据与 historyRewriteFeedback 合并返回给前端。
 */
function buildHistoryRewriteFailure(args: {
  action: GitHistoryRewriteAction;
  title: string;
  message: string;
  detailLines?: string[];
  undo?: GitHistoryRewriteUndoInfo;
  reasonCode?: string;
  tone?: GitHistoryRewriteTone;
  operationState?: GitRepositoryOperationState;
  shouldRefresh?: boolean;
  completed?: boolean;
  data?: Record<string, any>;
}): GitFeatureActionResult {
  const message = String(args.message || "").trim() || "历史改写失败";
  return {
    ok: false,
    error: message,
    data: {
      ...(args.data || {}),
      historyRewriteFeedback: buildHistoryRewriteFeedback({
        action: args.action,
        tone: args.tone || "danger",
        title: args.title,
        message,
        detailLines: args.detailLines,
        undo: args.undo,
        reasonCode: args.reasonCode,
        operationState: args.operationState,
        shouldRefresh: args.shouldRefresh,
        completed: args.completed,
      }),
    },
  };
}

/**
 * 构造统一历史改写成功结果，避免不同入口各自拼装成功提示与刷新标记。
 */
function buildHistoryRewriteSuccess(args: {
  action: GitHistoryRewriteAction;
  title: string;
  message: string;
  detailLines?: string[];
  undo?: GitHistoryRewriteUndoInfo;
  tone?: GitHistoryRewriteTone;
  reasonCode?: string;
  operationState?: GitRepositoryOperationState;
  shouldRefresh?: boolean;
  completed?: boolean;
  data?: Record<string, any>;
}): GitFeatureActionResult {
  return {
    ok: true,
    data: {
      ...(args.data || {}),
      historyRewriteFeedback: buildHistoryRewriteFeedback({
        action: args.action,
        tone: args.tone || "info",
        title: args.title,
        message: args.message,
        detailLines: args.detailLines,
        undo: args.undo,
        reasonCode: args.reasonCode,
        operationState: args.operationState,
        shouldRefresh: args.shouldRefresh,
        completed: args.completed,
      }),
    },
  };
}

/**
 * 读取指定提交集合的主题摘要，供删除提交通知直接展示可读标题而非裸哈希。
 */
async function listCommitSubjectsAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  hashes: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const hash of Array.from(new Set(
    (Array.isArray(hashes) ? hashes : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  ))) {
    const res = await runGitExecAsync(ctx, repoRoot, ["log", "-1", "--format=%s", hash], 10_000);
    const subject = res.ok ? decodeGitEscapedText(String(res.stdout || "").trim()) : "";
    out.push(subject || hash.slice(0, 8));
  }
  return out;
}

/**
 * 把删除提交主题压缩为适合 notice 展示的摘要列表，避免通知正文出现无意义数字或过长文本。
 */
function buildDeletedCommitDetailLines(subjects: string[], totalCount: number): string[] {
  const normalized = Array.from(new Set(
    (Array.isArray(subjects) ? subjects : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  ));
  const detailLines = normalized.slice(0, 3).map((subject) => `“${subject}”`);
  if (normalized.length > 3 || totalCount > normalized.length) {
    detailLines.push(`…… 其余 ${Math.max(totalCount - Math.min(normalized.length, 3), 0)} 个提交`);
  }
  return detailLines;
}

/**
 * 在删除提交失败时统一处理本地改动恢复，避免 preserving 分支与普通失败分支各自散落。
 */
async function finalizeDeleteCommitFailureAsync(args: {
  ctx: GitFeatureContext;
  repoRoot: string;
  title: string;
  message: string;
  reasonCode?: string;
  tone?: GitHistoryRewriteTone;
  operationState?: GitRepositoryOperationState;
  shouldRefresh?: boolean;
  completed?: boolean;
  detailLines?: string[];
  savedLocalChanges?: GitSavedLocalChanges | null;
  data?: Record<string, any>;
}): Promise<GitFeatureActionResult> {
  if (!args.savedLocalChanges) {
    return buildHistoryRewriteFailure({
      action: "delete-commit",
      title: args.title,
      message: args.message,
      detailLines: args.detailLines,
      reasonCode: args.reasonCode,
      tone: args.tone,
      operationState: args.operationState,
      shouldRefresh: args.shouldRefresh,
      completed: args.completed,
      data: args.data,
    });
  }
  if (args.operationState && args.operationState !== "normal") {
    return buildHistoryRewriteFailure({
      action: "delete-commit",
      title: args.title,
      message: args.message,
      detailLines: args.detailLines,
      reasonCode: args.reasonCode,
      tone: args.tone,
      operationState: args.operationState,
      shouldRefresh: args.shouldRefresh !== false,
      completed: args.completed,
      data: {
        ...(args.data || {}),
        preservingState: notifyUpdateLocalChangesNotRestored(args.savedLocalChanges, "manual-decision"),
      },
    });
  }

  const restoreRes = await restoreLocalChangesAfterUpdateAsync(args.ctx, args.repoRoot, args.savedLocalChanges);
  if (!restoreRes.ok) {
    return buildHistoryRewriteFailure({
      action: "delete-commit",
      title: args.title,
      message: String(restoreRes.preservingState?.message || restoreRes.error || args.message).trim() || args.message,
      detailLines: args.detailLines,
      reasonCode: args.reasonCode,
      tone: "warn",
      operationState: args.operationState,
      shouldRefresh: true,
      completed: args.completed,
      data: {
        ...(args.data || {}),
        preservingState: restoreRes.preservingState,
      },
    });
  }

  return buildHistoryRewriteFailure({
    action: "delete-commit",
    title: args.title,
    message: args.message,
    detailLines: args.detailLines,
    reasonCode: args.reasonCode,
    tone: args.tone,
    operationState: args.operationState,
    shouldRefresh: args.shouldRefresh,
    completed: args.completed,
    data: args.data,
  });
}

/**
 * 撤销最近一次删除提交改写；仅当 HEAD 仍停留在改写后位置时才允许执行，核心回退方式对齐上游的 `git reset --keep`。
 */
async function undoDeleteCommitAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
): Promise<GitFeatureActionResult> {
  const oldHead = String(payload?.oldHead || "").trim();
  const newHead = String(payload?.newHead || "").trim();
  if (!oldHead || !newHead) {
    return buildHistoryRewriteFailure({
      action: "delete-commit",
      title: "无法撤销删除提交",
      message: "缺少撤销所需的提交定位信息",
      reasonCode: "missing-undo-payload",
      completed: false,
    });
  }

  const headRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 10_000);
  if (!headRes.ok) {
    return buildHistoryRewriteFailure({
      action: "delete-commit",
      title: "无法撤销删除提交",
      message: toGitErrorMessage(headRes, "读取当前 HEAD 失败"),
      completed: false,
    });
  }
  const currentHead = String(headRes.stdout || "").trim();
  if (currentHead !== newHead) {
    return buildHistoryRewriteFailure({
      action: "delete-commit",
      title: "无法撤销删除提交",
      message: "当前 HEAD 已变化，无法安全回退到删除前状态",
      reasonCode: "head-moved",
      completed: false,
    });
  }

  const resetRes = await runGitSpawnAsync(ctx, repoRoot, ["reset", "--keep", oldHead], 120_000);
  if (!resetRes.ok) {
    return buildHistoryRewriteFailure({
      action: "delete-commit",
      title: "撤销删除提交失败",
      message: toGitErrorMessage(resetRes, "撤销删除提交失败"),
      completed: false,
    });
  }

  return buildHistoryRewriteSuccess({
    action: "delete-commit",
    title: "已撤销删除提交",
    message: "已恢复删除前的提交历史",
    shouldRefresh: true,
    completed: true,
  });
}

/**
 * 读取 `rebase.updateRefs` 配置，用于提示当前计划可能与应用内编辑体验存在语义差异。
 */
async function isRebaseUpdateRefsEnabledAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
): Promise<boolean> {
  const res = await runGitExecAsync(ctx, repoRoot, ["config", "--bool", "--get", "rebase.updateRefs"], 8_000);
  if (!res.ok) return false;
  const value = String(res.stdout || "").trim().toLowerCase();
  return value === "true" || value === "yes" || value === "on" || value === "1";
}

/**
 * 读取交互式变基目标提交链上的基础快照，要求其位于当前 HEAD 的 first-parent 线性历史上。
 */
async function resolveInteractiveRebasePlanAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  targetHashInput: string,
): Promise<{ ok: true; data: GitInteractiveRebasePlanSnapshot } | GitInteractiveRebasePlanFailureResult> {
  const requestedHash = String(targetHashInput || "").trim();
  if (!requestedHash) return buildInteractiveRebasePlanFailure("missing-hash", "缺少提交哈希");

  const branchRes = await runGitExecAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 10_000);
  const branchName = branchRes.ok ? String(branchRes.stdout || "").trim() : "";
  if (!branchName) return buildInteractiveRebasePlanFailure("detached-head", "当前处于 Detached HEAD，无法执行交互式变基");

  const commitRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "--verify", `${requestedHash}^{commit}`], 10_000);
  if (!commitRes.ok) return buildInteractiveRebasePlanFailure("commit-not-found", toGitErrorMessage(commitRes, "读取提交信息失败"));
  const targetHash = String(commitRes.stdout || "").trim();
  if (!targetHash) return buildInteractiveRebasePlanFailure("commit-not-found", "读取提交信息失败");

  const headRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 10_000);
  if (!headRes.ok) return { ok: false, error: toGitErrorMessage(headRes, "读取 HEAD 失败") };
  const headHash = String(headRes.stdout || "").trim();
  if (!headHash) return { ok: false, error: "读取 HEAD 失败" };

  const nodes = await getHeadFirstParentNodesAsync(ctx, repoRoot);
  if (nodes.length <= 0) return { ok: false, error: "读取提交链失败" };
  const index = nodes.findIndex((one) => one.hash === targetHash);
  if (index < 0) return buildInteractiveRebasePlanFailure("target-outside-head", "提交不在当前 HEAD 历史线上");

  const selectedNodes = nodes.slice(0, index + 1);
  const selectedTarget = selectedNodes[selectedNodes.length - 1];
  if (!selectedTarget) return { ok: false, error: "读取提交链失败" };
  if (selectedTarget.parentCount > 1) return buildInteractiveRebasePlanFailure("merge-commit", "合并提交不支持交互式变基");
  if (selectedNodes.slice(0, -1).some((one) => one.parentCount !== 1)) {
    return buildInteractiveRebasePlanFailure("non-linear-history", "提交路径包含合并或根提交，当前操作仅支持线性历史");
  }

  const chainHashes = selectedNodes.map((one) => one.hash).reverse();
  const rootMode = selectedTarget.parentCount === 0;
  let baseHash = "";
  if (!rootMode) {
    const parentRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", `${targetHash}^`], 10_000);
    if (!parentRes.ok) return { ok: false, error: toGitErrorMessage(parentRes, "读取父提交失败") };
    baseHash = String(parentRes.stdout || "").trim();
    if (!baseHash) return { ok: false, error: "读取父提交失败" };
  }

  const rangeRes = await runGitExecAsync(
    ctx,
    repoRoot,
    rootMode
      ? ["log", "--first-parent", "--reverse", "--format=%H%x00%an%x00%aI%x00%B%x1e", "HEAD"]
      : ["log", "--first-parent", "--reverse", "--format=%H%x00%an%x00%aI%x00%B%x1e", `${baseHash}..HEAD`],
    20_000,
  );
  if (!rangeRes.ok) return { ok: false, error: toGitErrorMessage(rangeRes, "读取交互式变基计划失败") };

  const parsedEntries: GitInteractiveRebasePlanEntry[] = [];
  for (const rawRecord of String(rangeRes.stdout || "").split("\x1e")) {
    const record = String(rawRecord || "").replace(/\r/g, "");
    if (!record.trim()) continue;
    const fields = record.split("\x00");
    const hash = String(fields[0] || "").trim();
    if (!hash) continue;
    const authorName = String(fields[1] || "").trim();
    const authorDate = String(fields[2] || "").trim();
    const fullMessage = fields.slice(3).join("\x00").replace(/\s+$/, "");
    parsedEntries.push({
      hash,
      shortHash: hash.slice(0, 8),
      subject: getCommitMessageSubject(fullMessage) || "(无标题)",
      authorName,
      authorDate,
      fullMessage,
      action: "pick",
      originalIndex: parsedEntries.length,
      autosquashCandidate: isAutosquashCommitSubject(fullMessage),
    });
  }

  if (parsedEntries.length !== chainHashes.length) {
    return buildInteractiveRebasePlanFailure("unresolved-hash", "读取交互式变基计划失败：提交数量不匹配");
  }
  if (parsedEntries.some((entry, idx) => entry.hash !== chainHashes[idx])) {
    return buildInteractiveRebasePlanFailure("unexpected-hash", "读取交互式变基计划失败：提交顺序不匹配");
  }

  const warnings: GitInteractiveRebasePlanWarning[] = [];
  if (parsedEntries.some((entry) => entry.autosquashCandidate === true)) {
    warnings.push({
      code: "autosquash",
      title: "检测到 autosquash 提交",
      message: "当前计划包含 fixup!/squash!/amend! 提交。应用内编辑器会固定展示真实 replay 顺序，并以 `--no-autosquash` 执行。",
    });
  }
  if (await isRebaseUpdateRefsEnabledAsync(ctx, repoRoot)) {
    warnings.push({
      code: "update-refs",
      title: "检测到 rebase.updateRefs",
      message: "当前 Git 配置启用了 `rebase.updateRefs`。应用内结果仍会按真实 Git 执行，但相关引用会在变基期间被联动改写。",
    });
  }

  return {
    ok: true,
    data: {
      targetHash,
      headHash,
      baseHash: baseHash || undefined,
      rootMode,
      entries: parsedEntries,
      warnings: warnings.length > 0 ? warnings : undefined,
    },
  };
}

/**
 * 校验 interactive rebase 草稿，确保 squash/fixup 前方存在可合并的目标提交。
 */
function validateInteractiveRebaseEntries(entries: GitInteractiveRebasePlanEntry[]): string {
  if (entries.length <= 0) return "交互式变基计划不能为空";
  let canAttachToPrevious = false;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.action === "drop") {
      canAttachToPrevious = false;
      continue;
    }
    if (entry.action === "fixup" || entry.action === "squash") {
      if (!canAttachToPrevious) return `第 ${index + 1} 条提交前缺少可合并的目标提交`;
      continue;
    }
    if (entry.action === "reword") {
      const message = String(entry.message || "").trim() || String(entry.fullMessage || "").trim();
      if (!message) return `第 ${index + 1} 条提交的提交信息不能为空`;
    }
    canAttachToPrevious = isInteractiveRebaseKeepAction(entry.action);
  }
  return "";
}

/**
 * 生成 interactive rebase 所需临时脚本与队列文件，统一驱动 todo 写回与 message 编辑。
 */
async function createGitInteractiveRebaseEditorArtifactsAsync(
  ctx: GitFeatureContext,
  todoRows: string[],
  queueItems: GitInteractiveRebaseEditorQueueItem[],
): Promise<GitInteractiveRebaseEditorArtifacts> {
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const dirPath = path.join(ctx.userDataPath, "git", "tmp", "interactive-rebase", stamp);
  await fsp.mkdir(dirPath, { recursive: true });

  const todoFilePath = path.join(dirPath, "todo.txt");
  const todoText = `${todoRows.map((row) => String(row || "").replace(/\r?\n/g, " ").trim()).filter(Boolean).join("\n")}\n`;
  await fsp.writeFile(todoFilePath, todoText, "utf8");

  const queueFilePath = path.join(dirPath, "queue.json");
  await fsp.writeFile(queueFilePath, JSON.stringify(queueItems), "utf8");

  const queueStateFilePath = path.join(dirPath, "queue-state.txt");
  await fsp.writeFile(queueStateFilePath, "0", "utf8");

  const sequenceEditorScriptPath = path.join(dirPath, "sequence-editor.cjs");
  const sequenceScript = `"use strict";
const fs = require("node:fs");
const todoPath = String(process.argv[2] || "");
const sourcePath = String(process.env.CODEXFLOW_GIT_REBASE_TODO_FILE || "");
if (!todoPath || !sourcePath || !fs.existsSync(sourcePath)) process.exit(0);
let content = String(fs.readFileSync(sourcePath, "utf8") || "");
if (!content.endsWith("\\n")) content += "\\n";
fs.writeFileSync(todoPath, content, "utf8");
`;
  await fsp.writeFile(sequenceEditorScriptPath, sequenceScript, "utf8");

  const commitEditorScriptPath = path.join(dirPath, "commit-editor.cjs");
  const commitScript = `"use strict";
const fs = require("node:fs");
const targetPath = String(process.argv[2] || "");
const queuePath = String(process.env.CODEXFLOW_GIT_REBASE_QUEUE_FILE || "");
const statePath = String(process.env.CODEXFLOW_GIT_REBASE_QUEUE_STATE_FILE || "");
if (!targetPath || !queuePath || !statePath || !fs.existsSync(queuePath)) process.exit(0);
let index = 0;
if (fs.existsSync(statePath)) {
  const rawIndex = Number.parseInt(String(fs.readFileSync(statePath, "utf8") || "0"), 10);
  if (Number.isFinite(rawIndex) && rawIndex >= 0) index = rawIndex;
}
let queue = [];
try {
  const parsed = JSON.parse(String(fs.readFileSync(queuePath, "utf8") || "[]"));
  queue = Array.isArray(parsed) ? parsed : [];
} catch {}
const current = queue[index];
fs.writeFileSync(statePath, String(index + 1), "utf8");
if (!current || current.useDefault === true) process.exit(0);
let message = String(current.message || "");
if (!message.trim()) process.exit(0);
if (!message.endsWith("\\n")) message += "\\n";
fs.writeFileSync(targetPath, message, "utf8");
`;
  await fsp.writeFile(commitEditorScriptPath, commitScript, "utf8");

  return {
    dirPath,
    sequenceEditorScriptPath,
    commitEditorScriptPath,
    todoFilePath,
    queueFilePath,
    queueStateFilePath,
  };
}

type GitResolvedCommitDiff = {
  leftHash?: string;
  rightHash: string;
  leftPath: string;
  rightPath: string;
  resolvedHashes: string[];
  deletedInRight: boolean;
};

/**
 * 为单提交或多提交聚合详情解析真实的左右比较对象，兼容重命名与多选路径聚合。
 */
async function resolveCommitDiffSelectionAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  hashesInput: string[],
  relPathInput: string,
): Promise<GitResolvedCommitDiff | null> {
  const hashes = Array.from(new Set(
    (hashesInput || [])
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  ));
  const relPath = String(relPathInput || "").trim().replace(/\\/g, "/");
  if (!relPath || hashes.length === 0) return null;

  let firstMatch: { hash: string; entry: GitCommitChangedFile } | null = null;
  let lastMatch: { hash: string; entry: GitCommitChangedFile } | null = null;
  let trackedPath = relPath;

  for (const hash of hashes) {
    const files = await getCommitChangedFilesAsync(ctx, repoRoot, hash);
    const match = files.find((entry) => {
      const nextPath = String(entry.path || "").trim();
      const oldPath = String(entry.oldPath || "").trim();
      return nextPath === trackedPath || oldPath === trackedPath;
    });
    if (!match) continue;
    if (!firstMatch) firstMatch = { hash, entry: match };
    lastMatch = { hash, entry: match };
    trackedPath = String(match.path || trackedPath).trim() || trackedPath;
  }

  const fallbackHash = hashes[hashes.length - 1] || hashes[0];
  if (!lastMatch) {
    return {
      leftHash: undefined,
      rightHash: fallbackHash,
      leftPath: relPath,
      rightPath: relPath,
      resolvedHashes: hashes,
      deletedInRight: false,
    };
  }

  const firstEntry = firstMatch || lastMatch;
  const leftHashRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", `${firstEntry.hash}^`], 8_000);
  const leftHash = leftHashRes.ok ? String(leftHashRes.stdout || "").trim() : "";
  const rightStatusCode = String(lastMatch.entry.status || "").trim()[0] || "";
  const deletedInRight = rightStatusCode === "D";
  return {
    leftHash: leftHash || undefined,
    rightHash: lastMatch.hash,
    leftPath: String(firstEntry.entry.oldPath || firstEntry.entry.path || relPath).trim() || relPath,
    rightPath: String(lastMatch.entry.path || relPath).trim() || relPath,
    resolvedHashes: hashes,
    deletedInRight,
  };
}

/**
 * 按当前 Diff 模式读取 unified patch，并在可行时补齐 hunk 元数据。
 */
async function loadStructuredDiffPatchAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: { path: string; mode: GitDiffMode; hash?: string; hashes?: string[]; oldPath?: string },
): Promise<{ patch?: string; patchHeader?: string; fingerprint?: string; hunks?: any[] }> {
  const relPath = String(payload.path || "").trim().replace(/\\/g, "/");
  const oldPath = String(payload.oldPath || "").trim().replace(/\\/g, "/");
  const mode = payload.mode;
  const hash = String(payload.hash || "").trim();
  const hashes = Array.isArray(payload.hashes) ? payload.hashes.map((one) => String(one || "").trim()).filter(Boolean) : [];
  if (!relPath) return {};

  let patchText = "";
  if (mode === "working") {
    const res = await runGitExecAsync(ctx, repoRoot, ["diff", "--", relPath], 30_000);
    if (!res.ok) return {};
    patchText = String(res.stdout || "");
  } else if (mode === "staged") {
    const res = await runGitExecAsync(ctx, repoRoot, ["diff", "--cached", "--", relPath], 30_000);
    if (!res.ok) return {};
    patchText = String(res.stdout || "");
  } else if (mode === "commit") {
    const selectedHashes = hashes.length > 0 ? hashes : (hash ? [hash] : []);
    if (selectedHashes.length !== 1) return {};
    const res = await runGitExecAsync(ctx, repoRoot, ["show", "--pretty=format:", selectedHashes[0], "--", relPath], 30_000);
    if (!res.ok) return {};
    patchText = String(res.stdout || "");
  } else if (mode === "revisionToRevision") {
    const refs = resolveRevisionCompareRefs({ hash, hashes });
    const argv = refs
      ? buildRevisionCompareDiffArgv({
          leftRef: refs.leftRef,
          rightRef: refs.rightRef,
          relPath,
          oldPath,
        })
      : null;
    if (!argv) return {};
    const res = await runGitExecAsync(ctx, repoRoot, argv, 30_000);
    if (!res.ok) return {};
    patchText = String(res.stdout || "");
  } else if (mode === "localToStaged" || mode === "stagedToLocal") {
    const argv = buildStageCompareDiffArgv(mode, relPath, false);
    if (!argv) return {};
    const res = await runGitExecAsync(ctx, repoRoot, argv, 30_000);
    if (!res.ok) return {};
    patchText = String(res.stdout || "");
  } else {
    return {};
  }

  const parsed = parseGitUnifiedPatch(patchText);
  if (!parsed) return {};
  return {
    patch: parsed.patch,
    patchHeader: parsed.patchHeader,
    fingerprint: parsed.fingerprint,
    hunks: parsed.hunks,
  };
}

/**
 * 获取 Diff 双栏文本数据。
 */
async function getDiffContentAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const relPath = String(payload?.path || "").trim().replace(/\\/g, "/");
  const oldPath = String(payload?.oldPath || "").trim().replace(/\\/g, "/");
  const mode = String(payload?.mode || "working").trim() as GitDiffMode;
  const hash = String(payload?.hash || "").trim();
  const hashes = Array.isArray(payload?.hashes) ? payload.hashes.map((one: any) => String(one || "").trim()).filter(Boolean) : [];
  const shelfRef = String(payload?.shelfRef || "").trim();
  if (!relPath) return { ok: false, error: "缺少文件路径" };

  if (mode === "shelf" || mode === "shelfToWorking") {
    if (!shelfRef) return { ok: false, error: "缺少搁置记录引用" };
    const res = await loadShelfDiffSnapshotAsync({
      runtime: createGitShelfDiffRuntime(ctx),
      userDataPath: ctx.userDataPath,
      repoRoot,
      ref: shelfRef,
      path: relPath,
      mode,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: res.data };
  }

  if (mode === "staged") {
    const binary = await isBinaryDiffAsync(ctx, repoRoot, mode, relPath, hash || undefined);
    if (binary) {
      return {
        ok: true,
        data: {
          path: relPath,
          mode,
          isBinary: true,
          leftTitle: "左侧版本",
          rightTitle: "右侧版本",
        },
      };
    }
    const left = await readGitBlobTextAsync(ctx, repoRoot, `HEAD:${relPath}`);
    const right = await readGitBlobTextAsync(ctx, repoRoot, `:${relPath}`);
    const structuredPatch = await loadStructuredDiffPatchAsync(ctx, repoRoot, { path: relPath, mode, hash });
    return {
      ok: true,
      data: {
        path: relPath,
        mode,
        isBinary: false,
        leftText: left.text,
        rightText: right.text,
        leftTitle: "HEAD",
        rightTitle: "Index",
        patch: structuredPatch.patch,
        patchHeader: structuredPatch.patchHeader,
        fingerprint: structuredPatch.fingerprint,
        hunks: structuredPatch.hunks,
      },
    };
  }

  if (mode === "localToStaged" || mode === "stagedToLocal") {
    const binary = await isBinaryDiffAsync(ctx, repoRoot, mode, relPath, hash || undefined);
    const working = await readWorkingTextAsync(repoRoot, relPath);
    const index = await readGitBlobTextAsync(ctx, repoRoot, `:${relPath}`);
    const left = mode === "localToStaged" ? working : index;
    const right = mode === "localToStaged" ? index : working;
    if (binary || !!left.isBinary || !!right.isBinary || !!working.tooLarge) {
      return {
        ok: true,
        data: {
          path: relPath,
          mode,
          isBinary: true,
          tooLarge: !!working.tooLarge,
          leftTitle: mode === "localToStaged" ? "Working Tree" : "Index",
          rightTitle: mode === "localToStaged" ? "Index" : "Working Tree",
        },
      };
    }
    const structuredPatch = await loadStructuredDiffPatchAsync(ctx, repoRoot, { path: relPath, mode, hash });
    return {
      ok: true,
      data: {
        path: relPath,
        mode,
        isBinary: false,
        leftText: left.text,
        rightText: right.text,
        leftTitle: mode === "localToStaged" ? "Working Tree" : "Index",
        rightTitle: mode === "localToStaged" ? "Index" : "Working Tree",
        patch: structuredPatch.patch,
        patchHeader: structuredPatch.patchHeader,
        fingerprint: structuredPatch.fingerprint,
        hunks: structuredPatch.hunks,
      },
    };
  }

  if (mode === "commit") {
    const selectedHashes = hashes.length > 0 ? hashes : (hash ? [hash] : ["HEAD"]);
    const resolved = await resolveCommitDiffSelectionAsync(ctx, repoRoot, selectedHashes, relPath);
    const rightTarget = resolved?.rightHash || hash || "HEAD";
    const leftTarget = resolved?.leftHash || "";
    const leftPath = resolved?.leftPath || relPath;
    const rightPath = resolved?.rightPath || relPath;
    const left = leftTarget ? await readGitBlobTextAsync(ctx, repoRoot, `${leftTarget}:${leftPath}`) : { ok: false, text: "" };
    const right = resolved?.deletedInRight
      ? { ok: true, text: "" }
      : await readGitBlobTextAsync(ctx, repoRoot, `${rightTarget}:${rightPath}`);
    const isBinary = !!left.isBinary || !!right.isBinary;
    const structuredPatch = await loadStructuredDiffPatchAsync(ctx, repoRoot, {
      path: relPath,
      mode,
      hash: rightTarget,
      hashes: resolved?.resolvedHashes || selectedHashes,
    });
    return {
      ok: true,
      data: {
        path: relPath,
        oldPath: leftPath !== rightPath ? leftPath : undefined,
        mode,
        isBinary,
        leftText: left.text,
        rightText: right.text,
        leftTitle: leftTarget ? `${leftTarget.slice(0, 8)}` : "空",
        rightTitle: rightTarget.slice(0, 8),
        hash: rightTarget,
        hashes: resolved?.resolvedHashes || selectedHashes,
        patch: structuredPatch.patch,
        patchHeader: structuredPatch.patchHeader,
        fingerprint: structuredPatch.fingerprint,
        hunks: structuredPatch.hunks,
      },
    };
  }

  if (mode === "revisionToRevision") {
    const refs = resolveRevisionCompareRefs({ hash, hashes });
    if (!refs?.leftRef || !refs.rightRef) return { ok: false, error: "缺少比较引用" };
    const leftPath = oldPath || relPath;
    const rightPath = relPath;
    const left = await readGitBlobTextAsync(ctx, repoRoot, `${refs.leftRef}:${leftPath}`);
    const right = await readGitBlobTextAsync(ctx, repoRoot, `${refs.rightRef}:${rightPath}`);
    const isBinary = !!left.isBinary || !!right.isBinary;
    const structuredPatch = await loadStructuredDiffPatchAsync(ctx, repoRoot, {
      path: relPath,
      oldPath,
      mode,
      hash: refs.rightRef,
      hashes: [refs.leftRef, refs.rightRef],
    });
    return {
      ok: true,
      data: {
        path: relPath,
        oldPath: leftPath !== rightPath ? leftPath : undefined,
        mode,
        isBinary,
        leftText: left.text,
        rightText: right.text,
        leftTitle: formatDiffRevisionTitle(refs.leftRef, "左侧版本"),
        rightTitle: formatDiffRevisionTitle(refs.rightRef, "右侧版本"),
        hash: refs.rightRef,
        hashes: [refs.leftRef, refs.rightRef],
        patch: structuredPatch.patch,
        patchHeader: structuredPatch.patchHeader,
        fingerprint: structuredPatch.fingerprint,
        hunks: structuredPatch.hunks,
      },
    };
  }

  if (mode === "revisionToWorking" || mode === "parentToWorking") {
    const target = hash || "HEAD";
    const parentRes = mode === "parentToWorking"
      ? await runGitExecAsync(ctx, repoRoot, ["rev-parse", `${target}^`], 6000)
      : null;
    const leftHash = mode === "parentToWorking"
      ? (parentRes?.ok ? String(parentRes.stdout || "").trim() : "")
      : target;
    const leftPath = oldPath || relPath;
    const left = leftHash ? await readGitBlobTextAsync(ctx, repoRoot, `${leftHash}:${leftPath}`) : { ok: false, text: "" };
    const right = await readWorkingTextAsync(repoRoot, relPath);
    const binary = !!left.isBinary || !!right.isBinary || !!right.tooLarge;
    if (binary) {
      return {
        ok: true,
        data: {
          path: relPath,
          oldPath: leftPath !== relPath ? leftPath : undefined,
          mode,
          isBinary: true,
          tooLarge: !!right.tooLarge,
          leftTitle: formatDiffRevisionTitle(leftHash, "空"),
          rightTitle: "Working Tree",
        },
      };
    }
    return {
      ok: true,
      data: {
        path: relPath,
        oldPath: leftPath !== relPath ? leftPath : undefined,
        mode,
        isBinary: false,
        leftText: left.text,
        rightText: right.text,
        leftTitle: formatDiffRevisionTitle(leftHash, "空"),
        rightTitle: "Working Tree",
      },
    };
  }

  const binary = await isBinaryDiffAsync(ctx, repoRoot, mode, relPath, hash || undefined);
  if (binary) {
    return {
      ok: true,
      data: {
        path: relPath,
        mode,
        isBinary: true,
        leftTitle: "左侧版本",
        rightTitle: "右侧版本",
      },
    };
  }
  const left = await readGitBlobTextAsync(ctx, repoRoot, `HEAD:${relPath}`);
  const right = await readWorkingTextAsync(repoRoot, relPath);
  const structuredPatch = await loadStructuredDiffPatchAsync(ctx, repoRoot, { path: relPath, mode, hash });
  if (right.tooLarge) {
    return {
      ok: true,
      data: {
        path: relPath,
        mode,
        isBinary: true,
        tooLarge: true,
        leftTitle: "HEAD",
        rightTitle: "Working Tree",
      },
    };
  }
  return {
    ok: true,
    data: {
      path: relPath,
      mode,
      isBinary: false,
      leftText: left.text,
      rightText: right.text,
      leftTitle: "HEAD",
      rightTitle: "Working Tree",
      patch: structuredPatch.patch,
      patchHeader: structuredPatch.patchHeader,
      fingerprint: structuredPatch.fingerprint,
      hunks: structuredPatch.hunks,
    },
  };
}

/**
 * 解析 git log 行记录。
 */
function parseLogRows(stdout: string): any[] {
  const rows = String(stdout || "").split("\x1e").map((x) => x.trim()).filter(Boolean);
  const out: any[] = [];
  for (const row of rows) {
    const parsed = parseStructuredLogHeader(row);
    if (!parsed) continue;
    out.push(toGitLogListItem(parsed));
  }
  return out;
}

/**
 * 归一化日志筛选多值，兼容旧版单值字段与新版数组字段。
 */
function normalizeLogFilterValues(
  valuesInput: any,
  legacyValue: string,
  options?: { ignoreAll?: boolean },
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pushValue = (value: any): void => {
    const clean = String(value || "").trim();
    if (!clean) return;
    if (options?.ignoreAll && clean === "all") return;
    if (seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  if (Array.isArray(valuesInput)) {
    for (const value of valuesInput) pushValue(value);
  }
  if (out.length <= 0) pushValue(legacyValue);
  return out;
}

/**
 * 按上游 `VcsLogFilterObject.fromHash` 的规则解析文本框里的哈希片段。
 */
function parseGitLogHashFilter(text: string): string[] {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) return [];
  const tokens = normalizedText.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
  if (tokens.length <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!/^[a-fA-F0-9]{7,40}$/.test(token)) return [];
    const normalizedToken = token.toLowerCase();
    if (seen.has(normalizedToken)) continue;
    seen.add(normalizedToken);
    out.push(normalizedToken);
  }
  return out;
}

/**
 * 判断提交是否命中文本框派生出的哈希过滤，支持完整哈希与短哈希前缀。
 */
function matchesHashFilter(item: any, hashFilters: string[]): boolean {
  if (hashFilters.length <= 0) return false;
  const hash = String(item?.hash || "").trim().toLowerCase();
  const shortHash = String(item?.shortHash || "").trim().toLowerCase();
  if (!hash && !shortHash) return false;
  return hashFilters.some((part) => hash.startsWith(part) || shortHash.startsWith(part));
}

/**
 * 判断提交作者是否命中多选作者筛选；多值间使用 OR 语义。
 */
function matchesAuthorFilter(item: any, authorFilters: string[]): boolean {
  if (authorFilters.length <= 0) return true;
  const authorName = String(item?.authorName || "").trim().toLowerCase();
  const authorEmail = String(item?.authorEmail || "").trim().toLowerCase();
  const authorComposite = authorName && authorEmail ? `${authorName} <${authorEmail}>` : "";
  return authorFilters.some((value) => {
    const normalizedValue = String(value || "").trim().toLowerCase();
    if (!normalizedValue) return false;
    return normalizedValue === authorName
      || normalizedValue === authorEmail
      || normalizedValue === authorComposite;
  });
}

/**
 * 统一判断提交是否命中需要在本地补齐的后置过滤条件。
 */
function matchesLogPostFilter(item: any, filter: GitLogPostFilter): boolean {
  if (!matchesAuthorFilter(item, filter.authorFilters)) return false;
  if (!filter.textFilter) return true;
  if (matchesHashFilter(item, filter.hashFilters)) return true;
  return matchesTextFilter(item, filter.textFilter, filter.caseSensitive, filter.matchMode);
}

/**
 * 把 revision / branch 多选筛选映射成 git log 的 revision 参数序列。
 */
function resolveLogRevisionArgs(
  revisionFilter: string,
  branchFilters: string[],
  useImplicitHeadHistory: boolean,
): string[] {
  const revision = String(revisionFilter || "").trim();
  if (revision) return [revision];
  if (branchFilters.length > 0) return branchFilters;
  if (useImplicitHeadHistory) return [];
  return LOG_ALL_REFS;
}

/**
 * 构造普通日志查询参数，供首屏图谱上下文模式与筛选后分页模式共用。
 */
function buildLogQueryArgv(args: {
  take: number;
  skip: number;
  revisionArgs: string[];
  authorFilter?: string;
  dateFrom: string;
  dateTo: string;
  followRenames: boolean;
  pathFilter: string;
}): string[] {
  const argv: string[] = [
    "log",
    "--date-order",
    "--date=iso-strict",
    "--pretty=format:%H%x00%P%x00%an%x00%ae%x00%ad%x00%s%x00%D%x1e",
    "--decorate=short",
    "--max-count",
    String(Math.max(1, Math.floor(Number(args.take) || 0))),
    "--skip",
    String(Math.max(0, Math.floor(Number(args.skip) || 0))),
  ];
  if (args.revisionArgs.length > 0) argv.push(...args.revisionArgs);
  if (args.authorFilter) argv.push(`--author=${args.authorFilter}`);
  if (args.dateFrom) argv.push(`--since=${args.dateFrom}`);
  if (args.dateTo) argv.push(`--until=${args.dateTo}`);
  if (args.followRenames) argv.push("--follow");
  if (args.pathFilter) argv.push("--", args.pathFilter);
  return argv;
}

/**
 * 按“筛选后的可见结果”重新分页，避免文本/多值筛选时 `items` 与 `graphItems` 行索引脱节。
 */
async function loadFilteredLogPageAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  args: {
    cursor: number;
    limit: number;
    revisionArgs: string[];
    gitAuthorFilter?: string;
    dateFrom: string;
    dateTo: string;
    followRenames: boolean;
    pathFilter: string;
    postFilter: GitLogPostFilter;
  },
): Promise<{ ok: true; items: any[]; nextCursor: number; hasMore: boolean } | { ok: false; error: string }> {
  const targetCount = args.cursor + args.limit + 1;
  const batchTake = Math.max(200, resolveLogGraphQueryTake(args.limit));
  const matchedItems: any[] = [];
  const hashMatchedItems: any[] = [];
  const hasHashPriority = args.postFilter.hashFilters.length > 0;
  let rawSkip = 0;

  while (matchedItems.length < targetCount) {
    const argv = buildLogQueryArgv({
      take: batchTake,
      skip: rawSkip,
      revisionArgs: args.revisionArgs,
      authorFilter: args.gitAuthorFilter,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      followRenames: args.followRenames,
      pathFilter: args.pathFilter,
    });
    const res = await runGitExecAsync(ctx, repoRoot, argv, 20_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "读取日志失败") };
    const batchItems = parseLogRows(res.stdout);
    if (batchItems.length <= 0) break;
    for (const item of batchItems) {
      if (!matchesAuthorFilter(item, args.postFilter.authorFilters)) continue;
      if (hasHashPriority) {
        if (matchesHashFilter(item, args.postFilter.hashFilters)) {
          hashMatchedItems.push(item);
          if (hashMatchedItems.length >= targetCount) break;
          continue;
        }
        if (hashMatchedItems.length <= 0 && args.postFilter.textFilter
          && matchesTextFilter(item, args.postFilter.textFilter, args.postFilter.caseSensitive, args.postFilter.matchMode)) {
          matchedItems.push(item);
        }
        continue;
      }
      if (!matchesLogPostFilter(item, args.postFilter)) continue;
      matchedItems.push(item);
      if (matchedItems.length >= targetCount) break;
    }
    if (hasHashPriority && hashMatchedItems.length >= targetCount) break;
    if (batchItems.length < batchTake) break;
    rawSkip += batchItems.length;
  }

  const preferredItems = hasHashPriority && hashMatchedItems.length > 0
    ? hashMatchedItems
    : matchedItems;
  const items = preferredItems.slice(args.cursor, args.cursor + args.limit);
  return {
    ok: true,
    items,
    nextCursor: args.cursor + items.length,
    hasMore: preferredItems.length > args.cursor + args.limit,
  };
}

/**
 * 批量标注提交是否属于当前分支，供前端 current branch highlighter 复用。
 */
async function annotateLogItemsWithCurrentBranchAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  items: any[],
): Promise<any[]> {
  if (items.length <= 0) return items;
  const headInfo = await getHeadInfoAsync(ctx, repoRoot);
  const currentBranch = String(headInfo.branch || "").trim();
  if (!currentBranch) return items;

  const hashes = items
    .map((item) => String(item?.hash || "").trim())
    .filter(Boolean);
  if (hashes.length <= 0) return items;

  const nameRevRes = await runGitExecQuietAsync(
    ctx,
    repoRoot,
    ["name-rev", "--name-only", `--refs=refs/heads/${currentBranch}`, ...hashes],
    12_000,
  );
  if (!nameRevRes.ok) return items;

  const names = String(nameRevRes.stdout || "").split(/\r?\n/);
  return items.map((item, index) => {
    const marker = String(names[index] || "").trim();
    return {
      ...item,
      containedInCurrentBranch: !!marker && marker !== "undefined",
    };
  });
}

/**
 * 文本匹配（支持大小写、精确、正则、模糊）。
 */
function matchesTextFilter(item: any, text: string, caseSensitive: boolean, mode: GitTextMatchMode): boolean {
  const query = String(text || "");
  if (!query) return true;
  const target = [item.hash, item.shortHash, item.subject, item.authorName, item.authorEmail, item.decorations].join("\n");

  if (mode === "regex") {
    try {
      const reg = new RegExp(query, caseSensitive ? "" : "i");
      return reg.test(target);
    } catch {
      return true;
    }
  }

  const src = caseSensitive ? target : target.toLowerCase();
  const q = caseSensitive ? query : query.toLowerCase();
  if (mode === "exact") return src.includes(q);

  // 模糊匹配：字符顺序匹配
  let pos = 0;
  for (const ch of q) {
    const found = src.indexOf(ch, pos);
    if (found < 0) return false;
    pos = found + 1;
  }
  return true;
}

/**
 * 读取 Git 日志列表（支持分页与过滤）。
 */
async function getLogAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor) || 0));
  const limit = Math.max(20, Math.min(1000, Math.floor(Number(payload?.limit) || 200)));
  const filters = payload?.filters && typeof payload.filters === "object" ? payload.filters : {};
  const branchFilter = String(filters.branch || "all").trim();
  const authorFilter = String(filters.author || "").trim();
  const branchFilters = normalizeLogFilterValues(filters.branchValues, branchFilter, { ignoreAll: true });
  const authorFilters = normalizeLogFilterValues(filters.authorValues, authorFilter);
  const pathFilter = String(filters.path || "").trim();
  const revisionFilter = String(filters.revision || "").trim();
  const dateFrom = String(filters.dateFrom || "").trim();
  const dateTo = String(filters.dateTo || "").trim();
  const textFilter = String(filters.text || "").trim();
  const caseSensitive = !!filters.caseSensitive;
  const followRenames = !!filters.followRenames && !!pathFilter;
  const matchMode = (String(filters.matchMode || "fuzzy") as GitTextMatchMode);
  const hashFilters = parseGitLogHashFilter(textFilter);

  if (shouldUseDedicatedFileHistoryLog({ followRenames, pathFilter, authorFilters, dateFrom, dateTo, textFilter })) {
    const take = cursor + limit + 1;
    const dedicatedRes = await collectDedicatedFileHistoryEntriesAsync(
      ctx,
      repoRoot,
      pathFilter,
      revisionFilter ? [revisionFilter] : (branchFilters.length > 0 ? branchFilters : buildFileHistoryStartRevisions(branchFilter, revisionFilter)),
      take,
    );
    if (!dedicatedRes.ok) return dedicatedRes;

    let items = dedicatedRes.entries
      .slice(cursor, cursor + limit)
      .map((entry) => toGitLogListItem(entry));
    items = await annotateLogItemsWithCurrentBranchAsync(ctx, repoRoot, items);
    return {
      ok: true,
      data: {
        items,
        graphItems: items,
        nextCursor: cursor + limit,
        hasMore: dedicatedRes.entries.length > cursor + limit,
      },
    };
  }

  const useImplicitHeadHistory = followRenames && !revisionFilter && branchFilters.length <= 0;
  const revisionArgs = resolveLogRevisionArgs(revisionFilter, branchFilters, useImplicitHeadHistory);
  const graphTake = resolveLogGraphQueryTake(limit);
  const shouldUseFilteredPaging = !!textFilter || authorFilters.length > 1;

  if (shouldUseFilteredPaging) {
    const filteredRes = await loadFilteredLogPageAsync(ctx, repoRoot, {
      cursor,
      limit,
      revisionArgs,
      gitAuthorFilter: authorFilters.length === 1 ? authorFilters[0] : undefined,
      dateFrom,
      dateTo,
      followRenames,
      pathFilter,
      postFilter: {
        authorFilters,
        textFilter,
        hashFilters,
        caseSensitive,
        matchMode,
      },
    });
    if (!filteredRes.ok) return filteredRes;
    const items = await annotateLogItemsWithCurrentBranchAsync(ctx, repoRoot, filteredRes.items);
    return {
      ok: true,
      data: {
        items,
        graphItems: items,
        nextCursor: filteredRes.nextCursor,
        hasMore: filteredRes.hasMore,
      },
    };
  }

  const argv = buildLogQueryArgv({
    take: graphTake,
    skip: cursor,
    revisionArgs,
    authorFilter: authorFilters.length === 1 ? authorFilters[0] : undefined,
    dateFrom,
    dateTo,
    followRenames,
    pathFilter,
  });
  const res = await runGitExecAsync(ctx, repoRoot, argv, 20_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "读取日志失败") };

  const parsedRows = parseLogRows(res.stdout);
  const graphItems = parsedRows;
  let items = parsedRows;
  if (textFilter) {
    items = items.filter((item) => matchesTextFilter(item, textFilter, caseSensitive, matchMode));
  }

  const nextCursor = cursor + limit;
  const hasMore = parsedRows.length > limit;
  if (items.length > limit) items = items.slice(0, limit);
  items = await annotateLogItemsWithCurrentBranchAsync(ctx, repoRoot, items);
  return {
    ok: true,
    data: {
      items,
      graphItems,
      nextCursor,
      hasMore,
    },
  };
}

/**
 * 创建日志动作可用性默认结构。
 */
function createDefaultLogActionAvailability(selectionCount: number): GitLogActionAvailability {
  const actions = {} as GitLogActionAvailability["actions"];
  for (const key of LOG_ACTION_KEYS) {
    actions[key] = { enabled: false, reason: "请先选择提交" };
  }
  return {
    selectionCount,
    single: selectionCount === 1,
    headHash: undefined,
    isHeadCommit: false,
    hasMergeCommit: false,
    hasRootCommit: false,
    hasLocalChanges: false,
    isAncestorOfHead: false,
    isPublishedToUpstream: false,
    actions,
  };
}

/**
 * 设置日志动作可用性项，统一处理禁用原因。
 */
function setLogActionAvailability(
  snapshot: GitLogActionAvailability,
  key: GitLogActionAvailabilityKey,
  enabled: boolean,
  reasonWhenDisabled: string,
): void {
  snapshot.actions[key] = enabled
    ? { enabled: true }
    : { enabled: false, reason: reasonWhenDisabled };
}

/**
 * 判断 ancestor 是否为 descendant 的祖先提交。
 */
async function checkIsAncestorAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const a = String(ancestor || "").trim();
  const d = String(descendant || "").trim();
  if (!a || !d) return false;
  const res = await runGitExecAsync(ctx, repoRoot, ["merge-base", "--is-ancestor", a, d], 10_000);
  if (res.ok) return true;
  if (res.exitCode === 1) return false;
  return false;
}

/**
 * 批量读取提交父节点信息（hash -> parents[]）。
 */
async function loadCommitParentMapAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  hashesInput: string[],
): Promise<Map<string, string[]>> {
  const hashes = Array.from(new Set(
    hashesInput
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  ));
  const parentMap = new Map<string, string[]>();
  if (hashes.length === 0) return parentMap;

  const showRes = await runGitExecAsync(
    ctx,
    repoRoot,
    ["show", "-s", "--pretty=format:%H%x00%P%x1e", ...hashes],
    12_000,
  );
  if (showRes.ok) {
    const rows = String(showRes.stdout || "").split("\x1e").map((one) => one.trim()).filter(Boolean);
    for (const row of rows) {
      const seg = row.split("\x00");
      const hash = String(seg[0] || "").trim();
      if (!hash) continue;
      const parents = String(seg[1] || "").trim().split(/\s+/).filter(Boolean);
      parentMap.set(hash, parents);
    }
  }

  for (const hash of hashes) {
    if (parentMap.has(hash)) continue;
    const res = await runGitExecAsync(ctx, repoRoot, ["rev-list", "--parents", "-n", "1", hash], 10_000);
    if (!res.ok) {
      parentMap.set(hash, []);
      continue;
    }
    const line = String(res.stdout || "").trim().split(/\r?\n/)[0] || "";
    const cols = line.split(/\s+/).filter(Boolean);
    if (cols.length <= 1) {
      parentMap.set(hash, []);
      continue;
    }
    parentMap.set(hash, cols.slice(1));
  }

  return parentMap;
}

/**
 * 判断当前仓库是否存在本地待提交改动。
 */
async function hasLocalChangesAsync(ctx: GitFeatureContext, repoRoot: string): Promise<boolean> {
  const res = await runGitExecAsync(ctx, repoRoot, ["status", "--porcelain"], 10_000);
  if (!res.ok) return false;
  return String(res.stdout || "").trim().length > 0;
}

/**
 * 判断远端是否存在未合并到本地 HEAD 的提交。
 */
async function hasRemoteChangesAsync(ctx: GitFeatureContext, repoRoot: string, upstreamRef: string): Promise<boolean> {
  const upstream = String(upstreamRef || "").trim();
  if (!upstream) return false;
  const res = await runGitExecAsync(ctx, repoRoot, ["rev-list", "-1", `HEAD..${upstream}`], 10_000);
  if (!res.ok) return false;
  return String(res.stdout || "").trim().length > 0;
}

/**
 * 读取 `git ... --name-only` 输出中的路径列表，并做去重规整。
 */
function parseGitNameOnlyPaths(raw: string): string[] {
  return Array.from(new Set(
    String(raw || "")
      .split(/\r?\n/)
      .map((one) => String(one || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
}

/**
 * 读取当前仓库的本地变更路径（未暂存/已暂存/未跟踪），用于评估更新前是否需要暂存。
 */
async function listLocalChangePathsAsync(ctx: GitFeatureContext, repoRoot: string): Promise<string[]> {
  const results = await Promise.all([
    runGitExecAsync(ctx, repoRoot, ["diff", "--name-only"], 10_000),
    runGitExecAsync(ctx, repoRoot, ["diff", "--cached", "--name-only"], 10_000),
    runGitExecAsync(ctx, repoRoot, ["ls-files", "--others", "--exclude-standard"], 10_000),
  ]);
  const combined = new Set<string>();
  for (const result of results) {
    if (!result.ok) continue;
    for (const one of parseGitNameOnlyPaths(result.stdout))
      combined.add(one);
  }
  return Array.from(combined);
}

/**
 * 判断当前仓库是否存在已暂存改动；Merge 策略下这类改动需要先保存。
 */
async function hasStagedChangesAsync(ctx: GitFeatureContext, repoRoot: string): Promise<boolean> {
  const res = await runGitExecAsync(ctx, repoRoot, ["diff", "--cached", "--name-only"], 10_000);
  if (!res.ok) return false;
  return parseGitNameOnlyPaths(res.stdout).length > 0;
}

/**
 * 判断两组路径是否存在交集（忽略分隔符差异）。
 */
function hasPathIntersection(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const lookup = new Set(left.map((one) => String(one || "").trim().replace(/\\/g, "/")).filter(Boolean));
  for (const item of right) {
    const key = String(item || "").trim().replace(/\\/g, "/");
    if (key && lookup.has(key)) return true;
  }
  return false;
}

/**
 * 读取上游分支相对当前分支的远端变更路径，用于判断 Merge 前是否需要保护本地改动。
 */
async function listIncomingChangedPathsAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  currentBranch: string,
  upstreamRef: string,
): Promise<string[]> {
  const branch = String(currentBranch || "").trim();
  const upstream = String(upstreamRef || "").trim();
  if (!branch || !upstream) return [];
  const res = await runGitExecAsync(ctx, repoRoot, ["diff", "--name-only", `${branch}..${upstream}`], 20_000);
  if (!res.ok) return [];
  return parseGitNameOnlyPaths(res.stdout);
}

/**
 * 按上游 Merge updater 规则判断是否需要先保存本地改动。
 * - 暂存区存在内容时直接保存；
 * - 工作区改动与远端 incoming 文件有交集时也需要保存。
 */
async function shouldSaveLocalChangesForMergeAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  currentBranch: string,
  upstreamRef: string,
): Promise<boolean> {
  if (await hasStagedChangesAsync(ctx, repoRoot)) return true;
  const [localPaths, incomingPaths] = await Promise.all([
    listLocalChangePathsAsync(ctx, repoRoot),
    listIncomingChangedPathsAsync(ctx, repoRoot, currentBranch, upstreamRef),
  ]);
  return hasPathIntersection(localPaths, incomingPaths);
}

/**
 * 在更新流程中临时保存本地改动，默认同时包含未跟踪文件。
 */
async function saveLocalChangesForUpdateAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  reason: string,
  saveChangesPolicy: GitUpdateSaveChangesPolicy,
): Promise<{ ok: true; saved: GitSavedLocalChanges | null } | { ok: false; error: string }> {
  return await saveUpdateLocalChangesAsync(createGitUpdatePreservingRuntime(ctx, repoRoot), reason, saveChangesPolicy);
}

/**
 * 在更新完成后恢复之前临时保存的本地改动；若恢复失败，则保留对应的已保存记录供用户继续处理。
 */
async function restoreLocalChangesAfterUpdateAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  saved: GitSavedLocalChanges | null,
): Promise<
  | { ok: true; preservingState?: GitUpdatePreservingState }
  | { ok: false; error: string; preservingState: GitUpdatePreservingState }
> {
  return await restoreUpdateLocalChangesAsync(createGitUpdatePreservingRuntime(ctx, repoRoot), saved);
}

/**
 * 构建“本地改动未自动恢复”的统一 preserving state。
 */
function notifyLocalChangesAreNotRestored(
  _ctx: GitFeatureContext,
  _repoRoot: string,
  saved: GitSavedLocalChanges,
  reason: GitUpdatePreservingNotRestoredReason,
  error?: string,
) {
  return notifyUpdateLocalChangesNotRestored(saved, reason, error);
}

/**
 * 读取 HEAD first-parent 提交链节点（从新到旧，含父提交数量）。
 */
async function getHeadFirstParentNodesAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  maxCount: number = 4000,
): Promise<GitFirstParentCommitNode[]> {
  const res = await runGitExecAsync(
    ctx,
    repoRoot,
    ["rev-list", "--first-parent", "--parents", "--max-count", String(Math.max(50, maxCount)), "HEAD"],
    15_000,
  );
  if (!res.ok) return [];
  const out: GitFirstParentCommitNode[] = [];
  const rows = String(res.stdout || "").split(/\r?\n/);
  for (const row of rows) {
    const cols = String(row || "").trim().split(/\s+/).filter(Boolean);
    if (cols.length <= 0) continue;
    const hash = String(cols[0] || "").trim();
    if (!hash) continue;
    out.push({
      hash,
      parentCount: Math.max(0, cols.length - 1),
    });
  }
  return out;
}

/**
 * 读取 HEAD first-parent 提交链（从新到旧）。
 */
async function getHeadFirstParentChainAsync(ctx: GitFeatureContext, repoRoot: string, maxCount: number = 4000): Promise<string[]> {
  const nodes = await getHeadFirstParentNodesAsync(ctx, repoRoot, maxCount);
  return nodes.map((one) => one.hash);
}

type CommitIndexRange = {
  start: number;
  end: number;
};

/**
 * 将升序提交索引拆分为连续区间（`start/end` 均为闭区间）。
 */
function buildContiguousIndexRanges(indexesInput: number[]): CommitIndexRange[] {
  const indexes = Array.from(new Set(
    indexesInput
      .map((one) => Number(one))
      .filter((one) => Number.isFinite(one) && one >= 0),
  ))
    .sort((a, b) => a - b);
  if (indexes.length === 0) return [];
  const out: CommitIndexRange[] = [];
  let start = indexes[0];
  let prev = indexes[0];
  for (let i = 1; i < indexes.length; i += 1) {
    const current = indexes[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    out.push({ start, end: prev });
    start = current;
    prev = current;
  }
  out.push({ start, end: prev });
  return out;
}

/**
 * 读取当前分支上游引用（如 origin/main），未配置则返回空字符串。
 */
async function getUpstreamRefAsync(ctx: GitFeatureContext, repoRoot: string): Promise<string> {
  const res = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], 10_000);
  if (!res.ok) return "";
  return String(res.stdout || "").trim();
}

/**
 * 读取指定本地分支的上游引用（如 origin/main），未配置则返回空字符串。
 */
async function getBranchUpstreamRefAsync(ctx: GitFeatureContext, repoRoot: string, branchName: string): Promise<string> {
  const branch = String(branchName || "").trim();
  if (!branch) return "";
  const ref = `refs/heads/${branch}`;
  const res = await runGitExecAsync(ctx, repoRoot, ["for-each-ref", "--format=%(upstream:short)", ref], 10_000);
  if (!res.ok) return "";
  const text = String(res.stdout || "").split(/\r?\n/)[0] || "";
  return String(text).trim();
}

/**
 * 读取指定分支的 merge 配置（如 `refs/heads/main`），未配置时返回空字符串。
 */
async function getBranchMergeRefAsync(ctx: GitFeatureContext, repoRoot: string, branchName: string): Promise<string> {
  const branch = String(branchName || "").trim();
  if (!branch) return "";
  const res = await runGitExecAsync(ctx, repoRoot, ["config", "--get", `branch.${branch}.merge`], 10_000);
  if (!res.ok) return "";
  return String(res.stdout || "").trim();
}

/**
 * 读取 Git config 单值，未配置或读取失败时返回空字符串。
 */
async function getGitConfigValueAsync(ctx: GitFeatureContext, repoRoot: string, key: string): Promise<string> {
  const name = String(key || "").trim();
  if (!name) return "";
  const res = await runGitExecAsync(ctx, repoRoot, ["config", "--get", name], 10_000);
  if (!res.ok) return "";
  return String(res.stdout || "").trim();
}

/**
 * 规整 Git 配置里的 remote 名称，过滤本地仓库标记 `.` 与空值。
 */
function normalizeGitRemoteName(raw: string): string {
  const value = String(raw || "").trim();
  if (!value || value === ".") return "";
  return value;
}

/**
 * 判断仓库是否存在未解决冲突文件（unmerged）。
 */
async function hasUnmergedFilesAsync(ctx: GitFeatureContext, repoRoot: string): Promise<boolean> {
  const res = await runGitExecAsync(ctx, repoRoot, ["diff", "--name-only", "--diff-filter=U"], 10_000);
  if (!res.ok) return false;
  return String(res.stdout || "").trim().length > 0;
}

/**
 * 在提交面板状态链路中补齐 resolved conflict 真值，避免前端只能消费死类型。
 */
async function hydrateCommitPanelConflictStateAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  operationState: GitRepositoryOperationState,
  parsedEntries: Array<{
    path: string;
    x: string;
    y: string;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    ignored: boolean;
    renamed: boolean;
    deleted: boolean;
    conflictState?: "conflict" | "resolved";
  }>,
): Promise<void> {
  if (operationState === "normal") return;

  const unresolvedPaths = new Set(
    parsedEntries
      .filter((entry) => entry.conflictState === "conflict")
      .map((entry) => String(entry.path || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  );
  const resolvedHolder = await getCommitPanelResolvedConflictHolderSnapshotAsync({
    runtime: {
      runGitExecAsync: async (argv, timeoutMs) => {
        return await runGitExecAsync(ctx, repoRoot, argv, timeoutMs);
      },
    },
    repoRoot,
    operationState,
    forceRefresh: true,
  });
  const resolvedPaths = new Set(resolvedHolder.paths);
  const existingPaths = new Set<string>();

  for (const entry of parsedEntries) {
    const cleanPath = String(entry.path || "").trim().replace(/\\/g, "/");
    if (cleanPath) existingPaths.add(cleanPath);
    if (!cleanPath || entry.ignored || entry.untracked) continue;
    if (unresolvedPaths.has(cleanPath)) continue;
    if (!resolvedPaths.has(cleanPath)) continue;
    if (!entry.staged && !entry.unstaged && !entry.renamed && !entry.deleted) continue;
    entry.conflictState = "resolved";
  }

  for (const resolvedPath of resolvedPaths) {
    if (!resolvedPath || unresolvedPaths.has(resolvedPath) || existingPaths.has(resolvedPath)) continue;
    parsedEntries.push({
      path: resolvedPath,
      x: "M",
      y: ".",
      staged: true,
      unstaged: false,
      untracked: false,
      ignored: false,
      renamed: false,
      deleted: false,
      conflictState: "resolved",
    });
  }
}

/**
 * 判断是否存在进行中的 merge。
 */
async function isMergeInProgressAsync(ctx: GitFeatureContext, repoRoot: string): Promise<boolean> {
  const res = await runGitExecQuietAsync(ctx, repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], 8000);
  return res.ok;
}

/**
 * 读取 Git 内部路径的绝对路径。
 */
async function resolveGitInternalPathAsync(ctx: GitFeatureContext, repoRoot: string, gitPath: string): Promise<string> {
  const res = await runGitExecQuietAsync(ctx, repoRoot, ["rev-parse", "--git-path", gitPath], 8000);
  if (!res.ok) return "";
  const value = String(res.stdout || "").trim();
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

/**
 * 判断是否存在进行中的 rebase。
 */
async function isRebaseInProgressAsync(ctx: GitFeatureContext, repoRoot: string): Promise<boolean> {
  const mergeDir = await resolveGitInternalPathAsync(ctx, repoRoot, "rebase-merge");
  if (mergeDir && fs.existsSync(mergeDir)) return true;
  const applyDir = await resolveGitInternalPathAsync(ctx, repoRoot, "rebase-apply");
  return !!applyDir && fs.existsSync(applyDir);
}

/**
 * 将未完成更新状态码映射为统一中文提示，避免 preflight 与 update 中途失败文案分叉。
 */
function getUpdateUnfinishedStateMessage(code: GitUpdateUnfinishedStateCode): string {
  if (code === "rebase-in-progress") return "检测到未完成的 Rebase，请先处理完成后再更新项目";
  if (code === "merge-in-progress") return "检测到未完成的 Merge，请先处理完成后再更新项目";
  return "存在未解决冲突文件，请先解决后再更新项目";
}

/**
 * 构造结构化的未完成更新状态，作为 preflight / updater 之间共享的稳定模型。
 */
function buildGitUpdateUnfinishedState(
  code: GitUpdateUnfinishedStateCode,
  stage: "preflight" | "update",
  localChangesRestorePolicy: GitUpdateLocalChangesRestorePolicy,
  savedLocalChangesRef?: string,
): GitUpdateUnfinishedState {
  return {
    code,
    stage,
    localChangesRestorePolicy,
    savedLocalChangesRef: String(savedLocalChangesRef || "").trim() || undefined,
    message: getUpdateUnfinishedStateMessage(code),
  };
}

/**
 * 统一探测仓库是否处于未完成更新状态，并补齐恢复策略语义，供 preflight 与 update 失败路径复用。
 */
async function detectUpdateUnfinishedStateAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  stage: "preflight" | "update",
  localChangesRestorePolicy: GitUpdateLocalChangesRestorePolicy,
  savedLocalChangesRef?: string,
): Promise<GitUpdateUnfinishedState | null> {
  const normalizedRef = String(savedLocalChangesRef || "").trim() || undefined;
  if (await isRebaseInProgressAsync(ctx, repoRoot)) {
    return buildGitUpdateUnfinishedState("rebase-in-progress", stage, localChangesRestorePolicy, normalizedRef);
  }
  if (await isMergeInProgressAsync(ctx, repoRoot)) {
    return buildGitUpdateUnfinishedState("merge-in-progress", stage, localChangesRestorePolicy, normalizedRef);
  }
  if (await hasUnmergedFilesAsync(ctx, repoRoot)) {
    return buildGitUpdateUnfinishedState("unmerged-files", stage, localChangesRestorePolicy, normalizedRef);
  }
  return null;
}

/**
 * 探测更新过程中是否已进入未完成状态，并在有临时暂存时显式标记“不恢复本地改动”。
 */
async function detectIncompleteUpdateStateAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  saved: GitSavedLocalChanges | null,
): Promise<GitUpdateUnfinishedState | null> {
  return await detectUpdateUnfinishedStateAsync(
    ctx,
    repoRoot,
    "update",
    saved ? "keep-saved" : "not-applicable",
    saved?.ref,
  );
}

/**
 * 生成“进行中操作保存记录”的稳定 key，避免同一路径大小写差异导致条目丢失。
 */
function getOngoingOperationSavedLocalChangesKey(repoRoot: string): string {
  return toFsPathKey(repoRoot) || String(repoRoot || "").trim();
}

/**
 * 缓存指定仓库当前进行中操作关联的已保存本地改动，供后续 continue/commit/abort 收尾自动恢复。
 */
function rememberOngoingOperationSavedLocalChanges(
  repoRoot: string,
  operationState: GitRepositoryOperationState,
  saved: GitSavedLocalChanges | null,
): void {
  const key = getOngoingOperationSavedLocalChangesKey(repoRoot);
  if (!key || !saved) {
    if (key) ongoingOperationSavedLocalChangesByRepoRoot.delete(key);
    return;
  }
  ongoingOperationSavedLocalChangesByRepoRoot.set(key, {
    operationState,
    saved: {
      ...saved,
    },
  });
}

/**
 * 读取指定仓库当前挂起的已保存本地改动记录；返回副本以避免调用方意外改写缓存。
 */
function readOngoingOperationSavedLocalChanges(
  repoRoot: string,
): { operationState: GitRepositoryOperationState; saved: GitSavedLocalChanges } | null {
  const entry = ongoingOperationSavedLocalChangesByRepoRoot.get(getOngoingOperationSavedLocalChangesKey(repoRoot)) || null;
  if (!entry) return null;
  return {
    operationState: entry.operationState,
    saved: {
      ...entry.saved,
    },
  };
}

/**
 * 清理指定仓库挂起的已保存本地改动记录；当操作已结束并尝试恢复后必须调用。
 */
function clearOngoingOperationSavedLocalChanges(repoRoot: string): void {
  ongoingOperationSavedLocalChangesByRepoRoot.delete(getOngoingOperationSavedLocalChangesKey(repoRoot));
}

/**
 * 判断指定 Git 内部引用（如 CHERRY_PICK_HEAD / REVERT_HEAD）是否存在。
 */
async function hasGitPseudoRefAsync(ctx: GitFeatureContext, repoRoot: string, refName: string): Promise<boolean> {
  const name = String(refName || "").trim();
  if (!name) return false;
  const res = await runGitExecQuietAsync(ctx, repoRoot, ["rev-parse", "-q", "--verify", name], 8_000);
  return res.ok;
}

/**
 * 读取 sequencer 队列首条指令，识别 multi-commit cherry-pick / revert 进行中状态。
 */
async function getSequencerOperationStateAsync(ctx: GitFeatureContext, repoRoot: string): Promise<GitRepositoryOperationState> {
  const sequencerPath = await resolveGitInternalPathAsync(ctx, repoRoot, "sequencer");
  if (!sequencerPath) return "normal";
  try {
    const stat = await fsp.stat(sequencerPath);
    if (!stat.isDirectory()) return "normal";
  } catch {
    return "normal";
  }

  try {
    const todoText = await fsp.readFile(path.join(sequencerPath, "todo"), "utf8");
    const firstInstruction = todoText
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));
    if (!firstInstruction) return "grafting";
    if (/^revert\b/i.test(firstInstruction)) return "reverting";
    return "grafting";
  } catch {
    return "grafting";
  }
}

/**
 * 读取进行中操作建议使用的提交消息；当前仅为 Cherry-pick 对齐上游的“冲突解决后进入提交”流程提供消息源。
 */
async function readOngoingOperationSuggestedCommitMessageAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  operationState: GitRepositoryOperationState,
): Promise<string | undefined> {
  if (operationState !== "grafting") return undefined;
  const mergeMessagePath = await resolveGitInternalPathAsync(ctx, repoRoot, "MERGE_MSG");
  if (!mergeMessagePath) return undefined;
  try {
    const message = String(await fsp.readFile(mergeMessagePath, "utf8") || "").trim();
    return message || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 判断当前仓库是否存在 Git sequencer 目录；多提交 cherry-pick/revert 继续时需保持 Git 原生命令推进语义。
 */
async function hasSequencerDirectoryAsync(ctx: GitFeatureContext, repoRoot: string): Promise<boolean> {
  const sequencerPath = await resolveGitInternalPathAsync(ctx, repoRoot, "sequencer");
  if (!sequencerPath) return false;
  try {
    const stat = await fsp.stat(sequencerPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 判断当前进行中操作是否仍有 tracked 变更待收尾；用于区分“进入提交完成模式”与“empty 直接 skip”。
 */
async function hasTrackedChangesForOngoingCommitAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
): Promise<boolean> {
  const res = await runGitExecAsync(ctx, repoRoot, ["status", "--porcelain=v2", "-z"], 12_000);
  if (!res.ok) return false;
  const parsed = parseCommitPanelStatusPorcelainV2Z(res.stdout);
  return parsed.some((entry) => (
    !entry.ignored
    && !entry.untracked
    && (
      entry.staged
      || entry.unstaged
      || entry.conflictState === "conflict"
      || entry.conflictState === "resolved"
    )
  ));
}

/**
 * 在 Cherry-pick `continue` 前先按上游状态机判断下一步该“提交完成”“跳过空提交”还是继续执行 Git 命令”。
 */
async function resolveGraftingContinueModeAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
): Promise<
  | { mode: "run-git-continue" }
  | { mode: "complete-by-commit"; suggestedCommitMessage: string }
  | { mode: "skip-empty-cherry-pick" }
> {
  if (await hasUnmergedFilesAsync(ctx, repoRoot))
    return { mode: "run-git-continue" };
  const hasTrackedChanges = await hasTrackedChangesForOngoingCommitAsync(ctx, repoRoot);
  if (!hasTrackedChanges)
    return { mode: "skip-empty-cherry-pick" };
  if (await hasSequencerDirectoryAsync(ctx, repoRoot))
    return { mode: "run-git-continue" };
  const suggestedCommitMessage = String(await readOngoingOperationSuggestedCommitMessageAsync(ctx, repoRoot, "grafting") || "").trim();
  if (suggestedCommitMessage)
    return {
      mode: "complete-by-commit",
      suggestedCommitMessage,
    };
  return { mode: "run-git-continue" };
}

/**
 * 在进行中操作推进后处理先前保存的本地改动。
 * - 若操作仍未结束，仅继续暴露 kept-saved 状态；
 * - 若操作已结束，则立即尝试自动恢复；
 * - 恢复失败时保留结构化 preservingState，让前端显示“查看已保存改动/处理冲突”入口。
 */
async function finalizeOngoingOperationSavedLocalChangesAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  result: GitFeatureActionResult,
  nextOperationStateInput?: GitRepositoryOperationState,
): Promise<GitFeatureActionResult> {
  const pending = readOngoingOperationSavedLocalChanges(repoRoot);
  if (!pending) return result;

  const nextOperationState = (
    String(nextOperationStateInput || result.data?.operationState || "").trim() as GitRepositoryOperationState
  ) || "normal";
  if (nextOperationState !== "normal") {
    rememberOngoingOperationSavedLocalChanges(repoRoot, nextOperationState, pending.saved);
    return {
      ...result,
      data: {
        ...(result.data || {}),
        preservingState: notifyUpdateLocalChangesNotRestored(pending.saved, "manual-decision"),
      },
    };
  }

  clearOngoingOperationSavedLocalChanges(repoRoot);
  const restoreRes = await restoreLocalChangesAfterUpdateAsync(ctx, repoRoot, pending.saved);
  const mergedData = {
    ...(result.data || {}),
    shouldRefresh: true,
    operationState: "normal" as GitRepositoryOperationState,
    preservingState: restoreRes.preservingState,
    localChangesRestorePolicy: restoreRes.preservingState?.localChangesRestorePolicy,
    savedLocalChangesRef: restoreRes.preservingState?.savedLocalChangesRef,
  };
  return {
    ...result,
    data: mergedData,
  };
}

/**
 * 读取仓库当前操作状态，用于对齐上游的提交编辑动作禁用条件。
 */
async function getRepositoryOperationStateAsync(ctx: GitFeatureContext, repoRoot: string): Promise<GitRepositoryOperationState> {
  if (await isRebaseInProgressAsync(ctx, repoRoot)) return "rebasing";
  if (await isMergeInProgressAsync(ctx, repoRoot)) return "merging";
  if (await hasGitPseudoRefAsync(ctx, repoRoot, "CHERRY_PICK_HEAD")) return "grafting";
  if (await hasGitPseudoRefAsync(ctx, repoRoot, "REVERT_HEAD")) return "reverting";
  const sequencerState = await getSequencerOperationStateAsync(ctx, repoRoot);
  if (sequencerState !== "normal") return sequencerState;
  return "normal";
}

/**
 * 将“仓库处于进行中操作”的状态转为可读禁用原因。
 */
function getCommitEditingStateBlockedReason(state: GitRepositoryOperationState, operationName: string): string {
  const op = String(operationName || "").trim() || "该操作";
  if (state === "rebasing") return `当前仓库处于 Rebase 过程中，无法执行${op}`;
  if (state === "merging") return `当前仓库处于 Merge 过程中，无法执行${op}`;
  if (state === "grafting") return `当前仓库处于 Cherry-pick 过程中，无法执行${op}`;
  if (state === "reverting") return `当前仓库处于 Revert 过程中，无法执行${op}`;
  return "";
}

/**
 * 统一返回“仓库已有进行中操作”的禁用原因，供 apply changes 类日志动作复用。
 */
function getOngoingRepositoryOperationBlockedReason(state: GitRepositoryOperationState): string {
  return state === "normal" ? "" : "当前仓库已有进行中的 Git 操作";
}

/**
 * 计算日志右键动作可用性（参考上游规则并结合当前已实现能力）。
 */
async function getLogActionAvailabilityAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const hashes: string[] = Array.isArray(payload?.hashes)
    ? payload.hashes.map((one: any) => String(one || "").trim()).filter((one: string) => one.length > 0)
    : [];

  const snapshot = createDefaultLogActionAvailability(hashes.length);
  if (hashes.length === 0) return { ok: true, data: snapshot };

  const single = hashes.length === 1;
  const selectedHash = single ? hashes[0] : "";
  const parentsMap = await loadCommitParentMapAsync(ctx, repoRoot, hashes);
  const selectedParents: string[][] = hashes.map((hash: string) => parentsMap.get(hash) || []);
  const hasMergeCommit = selectedParents.some((parents: string[]) => parents.length > 1);
  const hasRootCommit = selectedParents.some((parents: string[]) => parents.length === 0);

  const branchRes = await runGitExecAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 8_000);
  const currentBranch = branchRes.ok ? String(branchRes.stdout || "").trim() : "";
  const hasHeadBranch = !!currentBranch;
  const headRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 10_000);
  const headHash = headRes.ok ? String(headRes.stdout || "").trim() : "";
  const isHeadCommit = single && !!selectedHash && !!headHash && selectedHash === headHash;

  const inHeadHistoryMap = new Map<string, boolean>();
  if (headHash) {
    for (const oneHash of hashes) {
      inHeadHistoryMap.set(oneHash, await checkIsAncestorAsync(ctx, repoRoot, oneHash, headHash));
    }
  } else {
    for (const oneHash of hashes) inHeadHistoryMap.set(oneHash, false);
  }
  const isAncestorOfHead = single ? !!inHeadHistoryMap.get(selectedHash) : false;
  const singleInHeadHistory = single ? !!inHeadHistoryMap.get(selectedHash) : false;
  const allSelectedInHeadHistory = hashes.length > 0 && hashes.every((oneHash) => !!inHeadHistoryMap.get(oneHash));
  const upstreamRef = await getUpstreamRefAsync(ctx, repoRoot);
  const remoteNames = await listRemoteNamesAsync(ctx, repoRoot);
  const upstreamPair = parseUpstreamRef(upstreamRef, remoteNames);
  const preferredRemote = upstreamPair?.remote || await getPreferredRemoteAsync(ctx, repoRoot, remoteNames);
  const hasPushRemote = !!String(preferredRemote || "").trim();
  const remoteUpstreamRef = upstreamPair ? upstreamRef : "";
  const isPublishedToUpstream = single && !!selectedHash && !!remoteUpstreamRef
    ? await checkIsAncestorAsync(ctx, repoRoot, selectedHash, remoteUpstreamRef)
    : false;
  const hasLocalChanges = await hasLocalChangesAsync(ctx, repoRoot);
  const explicitSelectionCount = Math.max(0, Math.floor(Number(payload?.selectionCount) || 0));
  const hasExplicitSelection = explicitSelectionCount > 0;
  const repositoryState = await getRepositoryOperationStateAsync(ctx, repoRoot);

  snapshot.single = single;
  snapshot.headHash = headHash || undefined;
  snapshot.isHeadCommit = isHeadCommit;
  snapshot.hasMergeCommit = hasMergeCommit;
  snapshot.hasRootCommit = hasRootCommit;
  snapshot.hasLocalChanges = hasLocalChanges;
  snapshot.isAncestorOfHead = isAncestorOfHead;
  snapshot.isPublishedToUpstream = isPublishedToUpstream;

  const reasonNeedSelection = "请先选择提交";
  const reasonSingleOnly = "仅支持单选提交";
  const reasonMergeCommit = "合并提交不支持该操作";
  const reasonNeedHead = "仅支持当前 HEAD 提交";
  const reasonNeedHeadBranch = "当前处于 Detached HEAD，无法执行该操作";
  const reasonNotInHeadLine = "提交不在当前 HEAD 历史线上";
  const reasonNeedLocalChanges = "没有可提交的本地改动";
  const reasonNeedSelectedChanges = "当前没有已选中的可提交改动";
  const reasonNeedAtLeastTwo = "至少选择 2 个提交";
  const reasonOngoingRepositoryOperation = getOngoingRepositoryOperationBlockedReason(repositoryState);

  setLogActionAvailability(snapshot, "copyRevision", hashes.length > 0, reasonNeedSelection);
  setLogActionAvailability(snapshot, "createPatch", hashes.length > 0, reasonNeedSelection);
  setLogActionAvailability(
    snapshot,
    "cherryPick",
    hashes.length > 0 && !reasonOngoingRepositoryOperation,
    reasonOngoingRepositoryOperation || reasonNeedSelection,
  );
  setLogActionAvailability(
    snapshot,
    "revert",
    hashes.length > 0 && !hasMergeCommit && !reasonOngoingRepositoryOperation,
    hasMergeCommit ? reasonMergeCommit : (reasonOngoingRepositoryOperation || reasonNeedSelection),
  );

  setLogActionAvailability(snapshot, "checkoutRevision", single, reasonSingleOnly);
  setLogActionAvailability(snapshot, "showRepoAtRevision", single, reasonSingleOnly);
  setLogActionAvailability(snapshot, "compareLocal", single, reasonSingleOnly);
  setLogActionAvailability(snapshot, "reset", single, reasonSingleOnly);
  setLogActionAvailability(snapshot, "newBranch", single, !single ? "选择单个提交以创建新分支" : reasonNeedSelection);
  setLogActionAvailability(snapshot, "newTag", single, reasonSingleOnly);
  const canPushUpToCommit = single && hasHeadBranch && singleInHeadHistory && hasPushRemote;
  const pushUpToCommitReason = !single
    ? reasonSingleOnly
    : (!hasHeadBranch ? reasonNeedHeadBranch : (!singleInHeadHistory ? reasonNotInHeadLine : (!hasPushRemote ? "未配置远程仓库，无法推送" : reasonNeedSelection)));
  setLogActionAvailability(snapshot, "pushAllPrevious", canPushUpToCommit, pushUpToCommitReason);

  const canUndoCommit = single && hasHeadBranch && isHeadCommit && !hasMergeCommit;
  const undoCommitReason = !single
    ? reasonSingleOnly
    : (!hasHeadBranch ? reasonNeedHeadBranch : (hasMergeCommit ? reasonMergeCommit : reasonNeedHead));
  setLogActionAvailability(snapshot, "undoCommit", canUndoCommit, undoCommitReason);

  const editMessageStateReason = repositoryState === "rebasing" && isHeadCommit
    ? ""
    : getCommitEditingStateBlockedReason(repositoryState, "编辑提交消息");
  const editMergeReason = hasMergeCommit && !isHeadCommit ? reasonMergeCommit : "";
  const canEditMessage = single && hasHeadBranch && singleInHeadHistory && !editMessageStateReason && !editMergeReason;
  const editMessageReason = !single
    ? reasonSingleOnly
    : (!hasHeadBranch ? reasonNeedHeadBranch : (!singleInHeadHistory ? reasonNotInHeadLine : (editMergeReason || editMessageStateReason || reasonNeedHead)));
  setLogActionAvailability(snapshot, "editMessage", canEditMessage, editMessageReason);

  const interactiveStateReason = getCommitEditingStateBlockedReason(repositoryState, "交互式变基");
  const canInteractiveRebase = single && hasHeadBranch && singleInHeadHistory && !interactiveStateReason;
  const interactiveReason = !single
    ? reasonSingleOnly
    : (!hasHeadBranch ? reasonNeedHeadBranch : (!singleInHeadHistory ? reasonNotInHeadLine : interactiveStateReason));
  setLogActionAvailability(snapshot, "interactiveRebase", canInteractiveRebase, interactiveReason);
  const canAutoSquash = single && hasHeadBranch && singleInHeadHistory && !hasMergeCommit && hasExplicitSelection;
  const autoSquashReason = !single
    ? reasonSingleOnly
    : (!hasHeadBranch ? reasonNeedHeadBranch : (!singleInHeadHistory ? reasonNotInHeadLine : (hasMergeCommit ? reasonMergeCommit : reasonNeedSelectedChanges)));
  setLogActionAvailability(snapshot, "fixup", canAutoSquash, autoSquashReason);
  setLogActionAvailability(snapshot, "squashTo", canAutoSquash, autoSquashReason);
  const canDeleteCommitRange = hashes.length > 0
    && hasHeadBranch
    && allSelectedInHeadHistory
    && !hasMergeCommit;
  const deleteCommitReason = !hasHeadBranch
    ? reasonNeedHeadBranch
    : (!allSelectedInHeadHistory ? reasonNotInHeadLine : (hasMergeCommit ? reasonMergeCommit : reasonNeedSelection));
  setLogActionAvailability(snapshot, "deleteCommit", canDeleteCommitRange, deleteCommitReason);
  const canSquashCommits = hashes.length >= 2
    && hasHeadBranch
    && allSelectedInHeadHistory
    && !hasMergeCommit;
  let squashCommitsReason = "";
  if (hashes.length < 2) squashCommitsReason = reasonNeedAtLeastTwo;
  else if (!hasHeadBranch) squashCommitsReason = reasonNeedHeadBranch;
  else if (!allSelectedInHeadHistory) squashCommitsReason = reasonNotInHeadLine;
  else if (hasMergeCommit) squashCommitsReason = reasonMergeCommit;
  setLogActionAvailability(snapshot, "squashCommits", canSquashCommits, squashCommitsReason || reasonNeedAtLeastTwo);

  return {
    ok: true,
    data: snapshot,
  };
}

/**
 * 解析上游引用为 remote/branch（如 origin/main -> {remote:origin, branch:main}）。
 */
function parseUpstreamRef(upstreamRef: string, remoteNamesInput?: string[] | null): { remote: string; branch: string } | null {
  const upstream = String(upstreamRef || "").trim();
  if (!upstream) return null;
  const remoteNames = Array.from(new Set(
    (remoteNamesInput || [])
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  )).sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (remoteNames.length > 0) {
    for (const remote of remoteNames) {
      const prefix = `${remote}/`;
      if (!upstream.startsWith(prefix)) continue;
      const branch = upstream.slice(prefix.length).trim();
      if (!branch) return null;
      return { remote, branch };
    }
    return null;
  }
  const idx = upstream.indexOf("/");
  if (idx <= 0 || idx >= upstream.length - 1) return null;
  return {
    remote: upstream.slice(0, idx),
    branch: upstream.slice(idx + 1),
  };
}

/**
 * 将 merge 配置规整为远端分支短名（如 `refs/heads/main` -> `main`）。
 */
function normalizeMergeRefBranchName(mergeRef: string, remoteName?: string): string {
  const ref = String(mergeRef || "").trim();
  const remote = String(remoteName || "").trim();
  if (!ref) return "";
  if (remote) {
    const remotePrefix = `refs/remotes/${remote}/`;
    if (ref.startsWith(remotePrefix)) return ref.slice(remotePrefix.length).trim();
  }
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length).trim();
  if (ref.startsWith("refs/remotes/")) {
    const remain = ref.slice("refs/remotes/".length).trim();
    const parsed = parseUpstreamRef(remain, remote ? [remote] : undefined);
    if (parsed) return parsed.branch;
  }
  return ref.replace(/^heads\//, "").replace(/^remotes\//, "").trim();
}

type GitTrackedRemoteRef = {
  upstream: string;
  remote: string;
  branch: string;
  remoteNames: string[];
};

/**
 * 解析指定本地分支对应的“远端跟踪目标”；若只跟踪本地分支，则返回空。
 */
async function resolveBranchTrackedRemoteAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  branchName: string,
  remoteNamesInput?: string[] | null,
): Promise<GitTrackedRemoteRef | null> {
  const branch = String(branchName || "").trim();
  if (!branch) return null;
  const remoteNames = Array.from(new Set(
    (Array.isArray(remoteNamesInput) ? remoteNamesInput : ((await listRemoteNamesAsync(ctx, repoRoot)) || []))
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  ));
  const upstream = await getBranchUpstreamRefAsync(ctx, repoRoot, branch);
  const upstreamPair = parseUpstreamRef(upstream, remoteNames);
  if (upstreamPair?.remote && upstreamPair?.branch) {
    return {
      upstream,
      remote: upstreamPair.remote,
      branch: upstreamPair.branch,
      remoteNames,
    };
  }

  const branchRemote = normalizeGitRemoteName(await getGitConfigValueAsync(ctx, repoRoot, `branch.${branch}.remote`));
  if (!branchRemote || (remoteNames.length > 0 && !remoteNames.includes(branchRemote))) return null;
  const mergeRef = await getBranchMergeRefAsync(ctx, repoRoot, branch);
  const mergeBranch = normalizeMergeRefBranchName(mergeRef, branchRemote);
  if (!mergeBranch) return null;
  return {
    upstream: `${branchRemote}/${mergeBranch}`,
    remote: branchRemote,
    branch: mergeBranch,
    remoteNames,
  };
}

type GitResolvedPushTarget = {
  upstream?: string;
  remote: string;
  remoteBranch: string;
  shouldSetUpstream: boolean;
  comparisonRef?: string;
};

/**
 * 检查本地是否已存在对应的远端跟踪引用，用于推送预览比较区间。
 */
async function hasRemoteTrackingRefAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  remote: string,
  branch: string,
): Promise<boolean> {
  const remoteName = String(remote || "").trim();
  const remoteBranch = String(branch || "").trim();
  if (!remoteName || !remoteBranch) return false;
  const res = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "--verify", "-q", `refs/remotes/${remoteName}/${remoteBranch}`], 8_000);
  return res.ok;
}

/**
 * 解析指定本地分支的推送目标，避免把本地上游分支误判成远端仓库名。
 */
async function resolveBranchPushTargetAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  branchName: string,
): Promise<GitResolvedPushTarget> {
  const branch = String(branchName || "").trim();
  if (!branch) {
    return {
      remote: "",
      remoteBranch: "",
      shouldSetUpstream: false,
    };
  }
  const remoteNames = Array.from(new Set(
    ((await listRemoteNamesAsync(ctx, repoRoot)) || [])
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  ));
  const trackedRemote = await resolveBranchTrackedRemoteAsync(ctx, repoRoot, branch, remoteNames);
  const branchPushRemote = normalizeGitRemoteName(await getGitConfigValueAsync(ctx, repoRoot, `branch.${branch}.pushRemote`));
  const branchRemote = normalizeGitRemoteName(await getGitConfigValueAsync(ctx, repoRoot, `branch.${branch}.remote`));
  const remotePushDefault = normalizeGitRemoteName(await getGitConfigValueAsync(ctx, repoRoot, "remote.pushDefault"));
  const preferredRemote = await getPreferredRemoteAsync(ctx, repoRoot, remoteNames);
  const remoteCandidates = [branchPushRemote, remotePushDefault, trackedRemote?.remote || "", branchRemote, preferredRemote];
  const remote = remoteCandidates.find((one) => !!one && (remoteNames.length === 0 || remoteNames.includes(one))) || "";
  const remoteBranch = trackedRemote?.remote === remote
    ? trackedRemote.branch
    : branch;
  const comparisonRef = remote && remoteBranch && await hasRemoteTrackingRefAsync(ctx, repoRoot, remote, remoteBranch)
    ? `${remote}/${remoteBranch}`
    : undefined;
  const shouldSetUpstream = !!remote && (!trackedRemote || trackedRemote.remote !== remote || trackedRemote.branch !== remoteBranch);
  return {
    upstream: trackedRemote?.upstream,
    remote,
    remoteBranch,
    shouldSetUpstream,
    comparisonRef,
  };
}

/**
 * 解析 Update Project 应使用的更新策略（merge/rebase/reset）。
 */
async function resolvePullUpdateMethodAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
): Promise<GitUpdateMethodResolution> {
  return (await getUpdateOptionsSnapshotAsync(createGitUpdateConfigRuntime(ctx, repoRoot), payload)).methodResolution;
}

/**
 * 校验 Update Project 前置条件，并返回当前分支上游信息。
 */
async function prepareUpdateProjectContextAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload?: any,
): Promise<GitUpdatePreflightResult> {
  const unfinishedState = await detectUpdateUnfinishedStateAsync(ctx, repoRoot, "preflight", "not-applicable");
  if (unfinishedState) {
    return {
      ok: false,
      code: unfinishedState.code,
      error: unfinishedState.message,
      unfinishedState,
    };
  }

  const branchRes = await runGitExecAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 8000);
  const branch = branchRes.ok ? String(branchRes.stdout || "").trim() : "";
  if (!branch) {
    return { ok: false, code: "detached-head", error: "当前处于 Detached HEAD，无法执行更新项目" };
  }

  const trackedOverride = resolveTrackedBranchOverride(payload, repoRoot);
  if (trackedOverride) {
    if (trackedOverride.localBranch !== branch) {
      return {
        ok: false,
        code: "no-tracked-branch",
        branch,
        error: `当前分支已从 ${trackedOverride.localBranch} 切换为 ${branch}，请重新确认 tracked branch 修复配置`,
      };
    }
    return {
      ok: true,
      branch,
      upstream: trackedOverride.upstream,
      upstreamPair: {
        remote: trackedOverride.remote,
        branch: trackedOverride.remoteBranch,
      },
      trackedSource: "override",
    };
  }

  const trackedRemote = await resolveBranchTrackedRemoteAsync(ctx, repoRoot, branch);
  if (!trackedRemote) {
    return {
      ok: false,
      code: "no-tracked-branch",
      branch,
      error: `当前分支 ${branch} 未配置远端上游分支，无法执行更新项目`,
    };
  }
  return {
    ok: true,
    branch,
    upstream: trackedRemote.upstream,
    upstreamPair: {
      remote: trackedRemote.remote,
      branch: trackedRemote.branch,
    },
    trackedSource: "config",
  };
}

/**
 * 构建 Merge updater 使用的命令参数。
 * - 默认贴近上游：`git merge --no-stat -v <upstream>`；
 * - 若调用方显式提供 ff/squash/no-commit 等参数，则在不破坏语义时透传。
 */
function buildMergeUpdateArgv(upstreamRef: string, payload: any): string[] {
  const upstream = String(upstreamRef || "").trim();
  const ffOnly = hasPullOption(payload, "ffOnly", "--ff-only");
  const noFf = hasPullOption(payload, "noFf", "--no-ff");
  const squash = hasPullOption(payload, "squash", "--squash");
  const noCommit = hasPullOption(payload, "noCommit", "--no-commit");
  const noVerify = hasPullOption(payload, "noVerify", "--no-verify");
  const argv: string[] = ["merge"];
  if (ffOnly) argv.push("--ff-only");
  else if (noFf) argv.push("--no-ff");
  if (squash) argv.push("--squash");
  if (noCommit && !squash) argv.push("--no-commit");
  if (noVerify) argv.push("--no-verify");
  if (!ffOnly && !noFf && !squash && !noCommit) {
    argv.push("--no-stat", "-v");
  }
  argv.push(upstream);
  return argv;
}

/**
 * 构建独立 Pull 对话框使用的命令参数，对齐上游 `GitPull.getHandlerProvider()` 的直接 `git pull` 路径。
 */
function buildPullRemoteArgv(remote: string, remoteBranch: string, payload: any): string[] {
  const cleanRemote = String(remote || "").trim();
  const cleanRemoteBranch = String(remoteBranch || "").trim();
  const ffOnly = hasPullOption(payload, "ffOnly", "--ff-only");
  const noFf = hasPullOption(payload, "noFf", "--no-ff");
  const squash = hasPullOption(payload, "squash", "--squash");
  const noCommit = hasPullOption(payload, "noCommit", "--no-commit");
  const noVerify = hasPullOption(payload, "noVerify", "--no-verify");
  const argv: string[] = ["pull", "--no-stat"];
  if (ffOnly) argv.push("--ff-only");
  else if (noFf) argv.push("--no-ff");
  if (squash) argv.push("--squash");
  if (noCommit && !squash) argv.push("--no-commit");
  if (noVerify) argv.push("--no-verify");
  argv.push("-v");
  if (cleanRemote) argv.push(cleanRemote);
  if (cleanRemoteBranch) argv.push(cleanRemoteBranch);
  return argv;
}

/**
 * 判断 `git reset --merge` 是否只是命中了“当前没有 merge 可回滚”的无害场景。
 */
function isResetMergeNoopResult(res: GitExecResult): boolean {
  const message = `${String(res.stderr || "")}\n${String(res.stdout || "")}\n${String(res.error || "")}`.toLowerCase();
  return message.includes("there is no merge to abort") || message.includes("merge_head missing");
}

/**
 * 判断 `git rebase --abort` 是否只是命中了“当前没有 rebase 可回滚”的无害场景。
 */
function isAbortRebaseNoopResult(res: GitExecResult): boolean {
  const message = `${String(res.stderr || "")}\n${String(res.stdout || "")}\n${String(res.error || "")}`.toLowerCase();
  return message.includes("no rebase in progress")
    || message.includes("there is no rebase in progress")
    || message.includes("no rebase to abort");
}

/**
 * 判断 `git merge --abort` 是否只是命中了“当前没有 merge 可中止”的无害场景。
 */
function isAbortMergeNoopResult(res: GitExecResult): boolean {
  const message = `${String(res.stderr || "")}\n${String(res.stdout || "")}\n${String(res.error || "")}`.toLowerCase();
  return message.includes("there is no merge to abort")
    || message.includes("merge_head missing")
    || message.includes("no merge to abort");
}

/**
 * 判断 `git cherry-pick --abort` 是否只是命中了“当前没有 cherry-pick 可中止”的无害场景。
 */
function isAbortCherryPickNoopResult(res: GitExecResult): boolean {
  const message = `${String(res.stderr || "")}\n${String(res.stdout || "")}\n${String(res.error || "")}`.toLowerCase();
  return message.includes("no cherry-pick or revert in progress")
    || message.includes("no cherry-pick in progress")
    || message.includes("no cherry-pick to abort");
}

/**
 * 判断 `git revert --abort` 是否只是命中了“当前没有 revert 可中止”的无害场景。
 */
function isAbortRevertNoopResult(res: GitExecResult): boolean {
  const message = `${String(res.stderr || "")}\n${String(res.stdout || "")}\n${String(res.error || "")}`.toLowerCase();
  return message.includes("no cherry-pick or revert in progress")
    || message.includes("no revert in progress")
    || message.includes("no revert to abort");
}

/**
 * 把 Git 功能上下文适配为 update 子系统上下文。
 */
function createGitUpdateFeatureContext(ctx: GitFeatureContext): GitUpdateFeatureContext {
  return {
    action: ctx.action,
    requestId: ctx.requestId,
    gitPath: ctx.gitPath,
    userDataPath: ctx.userDataPath,
    emitProgress: ctx.emitProgress,
  };
}

/**
 * 创建 update preserving 流程 runtime 适配器。
 */
function createGitUpdatePreservingRuntime(ctx: GitFeatureContext, repoRoot: string): GitUpdatePreservingRuntime {
  return {
    ctx: createGitUpdateFeatureContext(ctx),
    repoRoot,
    hasLocalChangesAsync(): Promise<boolean> {
      return hasLocalChangesAsync(ctx, repoRoot);
    },
    runGitExecAsync(argv: string[], timeoutMs?: number): Promise<GitExecResult> {
      return runGitExecAsync(ctx, repoRoot, argv, timeoutMs);
    },
    runGitSpawnAsync(argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult> {
      return runGitSpawnAsync(ctx, repoRoot, argv, timeoutMs, envPatch);
    },
    emitProgress(message: string, detail?: string): void {
      emitGitFeatureProgress(ctx, repoRoot, message, detail);
    },
    toGitErrorMessage(res: GitExecResult, fallback: string): string {
      return toGitErrorMessage(res, fallback);
    },
    isRebaseInProgressAsync(): Promise<boolean> {
      return isRebaseInProgressAsync(ctx, repoRoot);
    },
    isMergeInProgressAsync(): Promise<boolean> {
      return isMergeInProgressAsync(ctx, repoRoot);
    },
    hasUnmergedFilesAsync(): Promise<boolean> {
      return hasUnmergedFilesAsync(ctx, repoRoot);
    },
  };
}

/**
 * 创建 update 公共 runtime 适配器。
 */
function createGitUpdateCommonRuntime(ctx: GitFeatureContext, repoRoot: string): GitUpdateCommonRuntime {
  return {
    ctx,
    repoRoot,
    emitProgress(message: string, detail?: string): void {
      emitGitFeatureProgress(ctx, repoRoot, message, detail);
    },
    runGitExecAsync(argv: string[], timeoutMs?: number): Promise<GitExecResult> {
      return runGitExecAsync(ctx, repoRoot, argv, timeoutMs);
    },
    runGitSpawnAsync(argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult> {
      return runGitSpawnAsync(ctx, repoRoot, argv, timeoutMs, envPatch);
    },
    saveLocalChangesForUpdateAsync(reason: string, saveChangesPolicy: GitUpdateSaveChangesPolicy) {
      return saveLocalChangesForUpdateAsync(ctx, repoRoot, reason, saveChangesPolicy);
    },
    restoreLocalChangesAfterUpdateAsync(saved: GitSavedLocalChanges | null) {
      return restoreLocalChangesAfterUpdateAsync(ctx, repoRoot, saved);
    },
    notifyLocalChangesAreNotRestored(saved: GitSavedLocalChanges, reason: GitUpdatePreservingNotRestoredReason, error?: string) {
      return notifyLocalChangesAreNotRestored(ctx, repoRoot, saved, reason, error);
    },
    detectIncompleteUpdateStateAsync(saved: GitSavedLocalChanges | null): Promise<GitUpdateUnfinishedState | null> {
      return detectIncompleteUpdateStateAsync(ctx, repoRoot, saved);
    },
    toGitErrorMessage(res: GitExecResult, fallback: string): string {
      return toGitErrorMessage(res, fallback);
    },
    isRebaseInProgressAsync(): Promise<boolean> {
      return isRebaseInProgressAsync(ctx, repoRoot);
    },
    isMergeInProgressAsync(): Promise<boolean> {
      return isMergeInProgressAsync(ctx, repoRoot);
    },
    hasUnmergedFilesAsync(): Promise<boolean> {
      return hasUnmergedFilesAsync(ctx, repoRoot);
    },
  };
}

/**
 * 创建 update Rebase runtime 适配器。
 */
function createGitUpdateRebaseRuntime(ctx: GitFeatureContext, repoRoot: string): GitUpdateRebaseRuntime {
  return {
    ...createGitUpdateCommonRuntime(ctx, repoRoot),
    hasLocalChangesAsync(): Promise<boolean> {
      return hasLocalChangesAsync(ctx, repoRoot);
    },
    isCancellationRequested(): boolean {
      return ctx.isCancellationRequested();
    },
    getCancellationReason(): string | undefined {
      return ctx.getCancellationReason();
    },
    async abortRebaseUpdateAsync(): Promise<{ ok: true } | { ok: false; error: string }> {
      const abortCtx = {
        ...ctx,
        abortSignal: undefined,
      };
      const res = await runGitSpawnAsync(abortCtx, repoRoot, ["rebase", "--abort"], 120_000);
      if (res.ok || isAbortRebaseNoopResult(res)) return { ok: true };
      return {
        ok: false,
        error: toGitErrorMessage(res, "取消 Rebase 更新时执行 rebase --abort 失败"),
      };
    },
  };
}

/**
 * 创建 update Merge runtime 适配器。
 */
function createGitUpdateMergeRuntime(ctx: GitFeatureContext, repoRoot: string): GitUpdateMergeRuntime {
  return {
    ...createGitUpdateCommonRuntime(ctx, repoRoot),
    shouldSaveLocalChangesForMergeAsync(currentBranch: string, upstreamRef: string): Promise<boolean> {
      return shouldSaveLocalChangesForMergeAsync(ctx, repoRoot, currentBranch, upstreamRef);
    },
    buildMergeUpdateArgv(upstreamRef: string, payload: any): string[] {
      return buildMergeUpdateArgv(upstreamRef, payload);
    },
    isCancellationRequested(): boolean {
      return ctx.isCancellationRequested();
    },
    getCancellationReason(): string | undefined {
      return ctx.getCancellationReason();
    },
    async cancelMergeUpdateAsync(): Promise<{ ok: true } | { ok: false; error: string }> {
      const resetCtx = {
        ...ctx,
        abortSignal: undefined,
      };
      const res = await runGitSpawnAsync(resetCtx, repoRoot, ["reset", "--merge"], 120_000);
      if (res.ok || isResetMergeNoopResult(res)) return { ok: true };
      return {
        ok: false,
        error: toGitErrorMessage(res, "取消 Merge 更新时执行 reset --merge 失败"),
      };
    },
  };
}

/**
 * 创建 update Reset runtime 适配器。
 */
function createGitUpdateResetRuntime(ctx: GitFeatureContext, repoRoot: string): GitUpdateResetRuntime {
  return {
    ...createGitUpdateCommonRuntime(ctx, repoRoot),
    hasLocalChangesAsync(): Promise<boolean> {
      return hasLocalChangesAsync(ctx, repoRoot);
    },
  };
}

/**
 * 创建 Detached 子模块 updater runtime，命令与本地改动保护均在父仓执行。
 */
function createGitUpdateSubmoduleRuntime(
  ctx: GitFeatureContext,
  parentRepoRoot: string,
  submoduleRepoRoot: string,
): GitUpdateSubmoduleRuntime {
  return {
    ...createGitUpdateCommonRuntime(ctx, parentRepoRoot),
    parentRepoRoot,
    submoduleRepoRoot,
    isCancellationRequested(): boolean {
      return ctx.isCancellationRequested();
    },
    getCancellationReason(): string | undefined {
      return ctx.getCancellationReason();
    },
  };
}

/**
 * 创建 update 单仓 root runtime 适配器，供多仓 orchestrator 按 root 复用现有能力。
 */
function createGitUpdateRootRuntime(ctx: GitFeatureContext, repoRoot: string): GitUpdateRootRuntime {
  return {
    repoRoot,
    emitProgress(message: string, detail?: string, updateSession?: GitUpdateSessionProgressSnapshot): void {
      emitGitFeatureProgress(ctx, repoRoot, message, detail, updateSession);
    },
    isCancellationRequested(): boolean {
      return ctx.isCancellationRequested();
    },
    getCancellationReason(): string | undefined {
      return ctx.getCancellationReason();
    },
    prepareUpdateProjectContextAsync(payload?: any) {
      return prepareUpdateProjectContextAsync(ctx, repoRoot, payload);
    },
    runGitExecAsync(argv: string[], timeoutMs?: number): Promise<GitExecResult> {
      return runGitExecAsync(ctx, repoRoot, argv, timeoutMs);
    },
    runGitSpawnAsync(argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult> {
      return runGitSpawnAsync(ctx, repoRoot, argv, timeoutMs, envPatch);
    },
    toGitErrorMessage(res: GitExecResult, fallback: string): string {
      return toGitErrorMessage(res, fallback);
    },
    listRemoteNamesAsync() {
      return listRemoteNamesAsync(ctx, repoRoot);
    },
    getPreferredRemoteAsync(remoteNames?: string[] | null) {
      return getPreferredRemoteAsync(ctx, repoRoot, remoteNames);
    },
    resolveBranchTrackedRemoteAsync(branch: string) {
      return resolveBranchTrackedRemoteAsync(ctx, repoRoot, branch);
    },
    hasRemoteTrackingRefAsync(remote: string, branch: string) {
      return hasRemoteTrackingRefAsync(ctx, repoRoot, remote, branch);
    },
    hasRemoteChangesAsync(upstreamRef: string) {
      return hasRemoteChangesAsync(ctx, repoRoot, upstreamRef);
    },
    resolvePullUpdateMethodAsync(payload: any) {
      return resolvePullUpdateMethodAsync(ctx, repoRoot, payload);
    },
  };
}

/**
 * 创建 repository graph runtime 适配器，仅暴露多仓发现所需的 Git 读取能力。
 */
function createGitUpdateRepositoryGraphRuntime(ctx: GitFeatureContext, repoRoot: string): GitUpdateRepositoryGraphRuntime {
  return {
    repoRoot,
    runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number): Promise<GitExecResult> {
      return runGitExecAsync(ctx, targetRepoRoot, argv, timeoutMs);
    },
  };
}

/**
 * 创建 tracked branch 配置分析 runtime，供预览与修复配置复用。
 */
function createGitUpdateConfigRuntime(ctx: GitFeatureContext, repoRoot: string): GitUpdateConfigRuntime {
  return {
    ...createGitUpdateRepositoryGraphRuntime(ctx, repoRoot),
    userDataPath: ctx.userDataPath,
    runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult> {
      return runGitSpawnAsync(ctx, targetRepoRoot, argv, timeoutMs, envPatch);
    },
    emitProgress(targetRepoRoot: string, message: string, detail?: string): void {
      emitGitFeatureProgress(ctx, targetRepoRoot, message, detail);
    },
    toGitErrorMessage(res: GitExecResult, fallback: string): string {
      return toGitErrorMessage(res, fallback);
    },
  };
}

/**
 * 创建统一 shelf manager runtime，供手动 shelve 与 update preserving 共用。
 */
function createGitShelfManagerRuntime(ctx: GitFeatureContext, repoRoot: string): GitShelfManagerRuntime {
  return {
    repoRoot,
    userDataPath: ctx.userDataPath,
    runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
      return runGitExecAsync(ctx, targetRepoRoot, argv, timeoutMs);
    },
    runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv) {
      return runGitSpawnAsync(ctx, targetRepoRoot, argv, timeoutMs, envPatch);
    },
    runGitStdoutToFileAsync(targetRepoRoot: string, argv: string[], targetPath: string, timeoutMs?: number) {
      return runGitStdoutToFileAsync(ctx, targetRepoRoot, argv, targetPath, timeoutMs);
    },
    emitProgress(targetRepoRoot: string, message: string, detail?: string) {
      emitGitFeatureProgress(ctx, targetRepoRoot, message, detail);
    },
    toGitErrorMessage(res: GitExecResult, fallback: string) {
      return toGitErrorMessage(res, fallback);
    },
  };
}

/**
 * 创建 update orchestrator runtime 适配器，负责在多仓场景下派生 root runtime。
 */
function createGitUpdateOrchestratorRuntime(ctx: GitFeatureContext, repoRoot: string): GitUpdateOrchestratorRuntime {
  return {
    repoRoot,
    userDataPath: ctx.userDataPath,
    gitPath: ctx.gitPath,
    emitProgress(message: string, detail?: string): void {
      emitGitFeatureProgress(ctx, repoRoot, message, detail);
    },
    isCancellationRequested(): boolean {
      return ctx.isCancellationRequested();
    },
    getCancellationReason(): string | undefined {
      return ctx.getCancellationReason();
    },
    createRootRuntime(targetRepoRoot: string): GitUpdateRootRuntime {
      return createGitUpdateRootRuntime(ctx, targetRepoRoot);
    },
    createRebaseRuntime(targetRepoRoot: string): GitUpdateRebaseRuntime {
      return createGitUpdateRebaseRuntime(ctx, targetRepoRoot);
    },
    createMergeRuntime(targetRepoRoot: string): GitUpdateMergeRuntime {
      return createGitUpdateMergeRuntime(ctx, targetRepoRoot);
    },
    createResetRuntime(targetRepoRoot: string): GitUpdateResetRuntime {
      return createGitUpdateResetRuntime(ctx, targetRepoRoot);
    },
    createSubmoduleRuntime(parentRepoRoot: string, submoduleRepoRoot: string): GitUpdateSubmoduleRuntime {
      return createGitUpdateSubmoduleRuntime(ctx, parentRepoRoot, submoduleRepoRoot);
    },
    repositoryGraphRuntime: createGitUpdateRepositoryGraphRuntime(ctx, repoRoot),
    runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number): Promise<GitExecResult> {
      return runGitExecAsync(ctx, targetRepoRoot, argv, timeoutMs);
    },
    runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult> {
      return runGitSpawnAsync(ctx, targetRepoRoot, argv, timeoutMs, envPatch);
    },
    runGitStdoutToFileAsync(targetRepoRoot: string, argv: string[], targetPath: string, timeoutMs?: number): Promise<GitExecResult> {
      return runGitStdoutToFileAsync(ctx, targetRepoRoot, argv, targetPath, timeoutMs);
    },
    toGitErrorMessage(res: GitExecResult, fallback: string): string {
      return toGitErrorMessage(res, fallback);
    },
  };
}

/**
 * 执行 Update Project 主编排流程。
 */
async function runUpdateProjectAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const optionsSnapshot = await getUpdateOptionsSnapshotAsync(createGitUpdateConfigRuntime(ctx, repoRoot), payload);
  const normalizedPayload = applyUpdateOptionsPayloadDefaults(repoRoot, payload, optionsSnapshot.options);
  return await runUpdateProjectOrchestratorAsync(createGitUpdateOrchestratorRuntime(ctx, repoRoot), normalizedPayload);
}

/**
 * 判断当前推送是否允许在 reject 后进入正式 Update Project 决策流。
 */
function canAutoUpdateAfterPushReject(payload: any): boolean {
  if (payload?.updateIfRejected !== true) return false;
  if (payload?.forceWithLease === true) return false;
  if (payload?.forcePush === true || payload?.force === true) return false;
  const targetHash = String(payload?.targetHash || "").trim();
  if (targetHash) return false;
  return true;
}

/**
 * 提取推送被拒绝时可直接展示给用户的关键信息，避免把整段 stderr 原样塞进弹窗。
 */
function extractPushRejectedDetailText(res: GitExecResult): string {
  return `${String(res.stderr || "")}\n${String(res.stdout || "")}`
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter((line) => line && !line.startsWith("To "))
    .slice(0, 2)
    .join("；");
}

/**
 * 构建 Push 被拒绝后的结构化决策模型，供前端显式进入 Merge / Rebase / Force / Cancel 流程。
 */
function buildPushRejectedDecisionData(args: {
  type: "no-fast-forward" | "stale-info" | "rejected-other";
  branch: string;
  upstream?: string;
  remote: string;
  remoteBranch: string;
  errorText?: string;
  allowUpdateActions?: boolean;
  forceWithLeaseAttempted?: boolean;
}): any {
  const detailText = String(args.errorText || "").trim();
  if (args.type === "stale-info") {
    return {
      type: "stale-info",
      title: "Force with Lease 被拒绝",
      description: detailText
        ? `远端引用已变化，当前 lease 信息已过期。若你确认仍需覆盖远端，可改为普通强制推送继续。\n\nGit 输出：${detailText}`
        : "远端引用已变化，当前 lease 信息已过期。若你确认仍需覆盖远端，可改为普通强制推送继续。",
      detailText: detailText || undefined,
      branch: args.branch,
      upstream: args.upstream,
      remote: args.remote,
      remoteBranch: args.remoteBranch,
      actions: [
        {
          kind: "force-push",
          label: "继续强制推送（无 Lease）",
          payloadPatch: {
            forcePush: true,
            forceWithLease: false,
          },
          variant: "danger",
        },
        {
          kind: "cancel",
          label: "取消",
          payloadPatch: {},
          variant: "secondary",
        },
      ],
    };
  }
  if (args.type === "rejected-other") {
    return {
      type: "rejected-other",
      title: "远端拒绝了推送",
      description: detailText
        ? `远端拒绝接收当前推送，请先处理远端策略或服务端 hook 限制后再重试。\n\nGit 输出：${detailText}`
        : "远端拒绝接收当前推送，请先处理远端策略或服务端 hook 限制后再重试。",
      detailText: detailText || undefined,
      branch: args.branch,
      upstream: args.upstream,
      remote: args.remote,
      remoteBranch: args.remoteBranch,
      actions: [
        {
          kind: "cancel",
          label: "关闭",
          payloadPatch: {},
          variant: "secondary",
        },
      ],
    };
  }
  const actions: any[] = [];
  if (args.allowUpdateActions !== false) {
    actions.push(
      {
        kind: "update-with-merge",
        label: "先更新（Merge）再推送",
        payloadPatch: {
          updateMethod: "merge",
        },
        variant: "primary",
      },
      {
        kind: "update-with-rebase",
        label: "先更新（Rebase）再推送",
        payloadPatch: {
          updateMethod: "rebase",
        },
        variant: "secondary",
      },
    );
  }
  if (args.forceWithLeaseAttempted !== true) {
    actions.push({
      kind: "force-with-lease",
      label: "强制推送（Force with Lease）",
      payloadPatch: {
        forceWithLease: true,
      },
      variant: "danger",
    });
  }
  actions.push({
    kind: "cancel",
    label: "取消",
    payloadPatch: {},
    variant: "secondary",
  });
  return {
    type: "no-fast-forward",
    title: "推送被拒绝，需要先同步远端",
    description: args.upstream
      ? `远端分支 ${args.upstream} 已领先于当前分支，请先更新后再重试推送，或在确认覆盖远端时改用 Force with Lease。`
      : `远端 ${args.remote}/${args.remoteBranch} 已领先于当前分支，请先更新后再重试推送，或在确认覆盖远端时改用 Force with Lease。`,
    detailText: detailText || undefined,
    branch: args.branch,
    upstream: args.upstream,
    remote: args.remote,
    remoteBranch: args.remoteBranch,
    actions,
  };
}

/**
 * 为日志图谱请求补充额外尾部上下文。
 * 上游 graph layout 建立在更完整的 permanent graph 上；这里无法一次拿到全量图，
 * 因此至少为每一页额外多取几页尾部提交，减少当前页 lane 排序因上下文不足而整体漂移。
 */
function resolveLogGraphQueryTake(limit: number): number {
  const normalizedLimit = Math.max(1, Math.floor(Number(limit) || 0));
  return Math.max(normalizedLimit + 1, normalizedLimit * 4);
}

/**
 * 为 shelf diff / patch 预览构造最小运行时，复用现有 Git 执行与 blob 落盘能力。
 */
function createGitShelfDiffRuntime(ctx: GitFeatureContext) {
  return {
    runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
      return runGitExecAsync(ctx, targetRepoRoot, argv, timeoutMs);
    },
    runGitStdoutToFileAsync(targetRepoRoot: string, argv: string[], targetPath: string, timeoutMs?: number) {
      return runGitStdoutToFileAsync(ctx, targetRepoRoot, argv, targetPath, timeoutMs);
    },
  };
}

/**
 * 把 tag 获取策略映射为 `git fetch` 参数，统一复用到显式 Fetch 与 Pull 对话框刷新链路。
 */
function appendFetchTagModeArgv(argv: string[], tagModeInput: string): void {
  const tagMode = String(tagModeInput || "").trim().toLowerCase();
  if (tagMode === "all") argv.push("--tags");
  else if (tagMode === "none") argv.push("--no-tags");
}

/**
 * 串行化同仓库的显式 Fetch，请求到达时若已有执行中的任务，会先进入队列等待。
 */
async function runQueuedFetchFlowAsync<T>(
  repoRoot: string,
  onQueued: () => void,
  runner: () => Promise<T>,
): Promise<T> {
  const normalizedRepoRoot = String(repoRoot || "").trim();
  const previousTail = fetchFlowQueueByRepoRoot.get(normalizedRepoRoot) || Promise.resolve();
  if (fetchFlowQueueByRepoRoot.has(normalizedRepoRoot)) onQueued();
  let releaseTail: () => void = () => undefined;
  const currentTail = new Promise<void>((resolve) => {
    releaseTail = () => {
      resolve();
    };
  });
  const nextTail = previousTail.catch(() => undefined).then(async () => {
    await currentTail;
  });
  fetchFlowQueueByRepoRoot.set(normalizedRepoRoot, nextTail);
  try {
    await previousTail.catch(() => undefined);
    return await runner();
  } finally {
    releaseTail();
    if (fetchFlowQueueByRepoRoot.get(normalizedRepoRoot) === nextTail) {
      fetchFlowQueueByRepoRoot.delete(normalizedRepoRoot);
    }
  }
}

/**
 * 执行 Fetch（支持 all remotes/default remote/specific remote、tag mode、refspec 与队列等待）。
 */
async function runFetchFlowAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  return await runQueuedFetchFlowAsync(
    repoRoot,
    () => {
      emitGitFeatureProgress(ctx, repoRoot, "已有 Fetch 正在执行，已加入队列等待");
    },
    async () => {
      const remoteFromPayload = String(payload?.remote || "").trim();
      const refspec = String(payload?.refspec || "").trim();
      const unshallow = payload?.unshallow === true;
      const tagMode = String(payload?.tagMode || "").trim().toLowerCase();
      const allRemotes = payload?.allRemotes !== false && !remoteFromPayload;

      if (remoteFromPayload) {
        emitGitFeatureProgress(ctx, repoRoot, `正在获取远端 ${remoteFromPayload}`, refspec || undefined);
        const argv: string[] = ["fetch", remoteFromPayload];
        if (unshallow) argv.push("--unshallow");
        appendFetchTagModeArgv(argv, tagMode);
        if (refspec) argv.push(refspec);
        const res = await runGitSpawnAsync(ctx, repoRoot, argv, 300_000);
        if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "拉取远端信息失败") };
        invalidateBranchSyncRemoteHeadsCache(repoRoot);
        return {
          ok: true,
          data: {
            fetchedRemotes: [remoteFromPayload],
            tagMode: tagMode || "auto",
          },
        };
      }

      const remotes = await listRemoteNamesAsync(ctx, repoRoot);
      if (remotes === null) {
        emitGitFeatureProgress(ctx, repoRoot, allRemotes ? "正在获取全部远端" : "正在获取默认远端");
        const fallbackArgv = allRemotes ? ["fetch", "--all"] : ["fetch"];
        if (unshallow) fallbackArgv.push("--unshallow");
        appendFetchTagModeArgv(fallbackArgv, tagMode);
        if (refspec) fallbackArgv.push(refspec);
        const fallbackRes = await runGitSpawnAsync(ctx, repoRoot, fallbackArgv, 300_000);
        if (!fallbackRes.ok) return { ok: false, error: toGitErrorMessage(fallbackRes, "拉取远端信息失败") };
        invalidateBranchSyncRemoteHeadsCache(repoRoot);
        return {
          ok: true,
          data: {
            fetchedRemotes: [],
            fallback: true,
            tagMode: tagMode || "auto",
          },
        };
      }
      if (!allRemotes) {
        const preferredRemote = await getPreferredRemoteAsync(ctx, repoRoot, remotes);
        if (!preferredRemote) {
          if (remotes.length > 0) {
            return {
              ok: true,
              data: {
                fetchedRemotes: [],
                skipped: true,
                reason: "检测到多个远程仓库，且无法确定默认远程（缺少当前分支上游且无 origin）",
              },
            };
          }
          return {
            ok: true,
            data: {
              fetchedRemotes: [],
              skipped: true,
              reason: "未配置远程仓库",
            },
          };
        }
        emitGitFeatureProgress(ctx, repoRoot, `正在获取远端 ${preferredRemote}`, refspec || undefined);
        const argv = ["fetch", preferredRemote];
        if (unshallow) argv.push("--unshallow");
        appendFetchTagModeArgv(argv, tagMode);
        if (refspec) argv.push(refspec);
        const res = await runGitSpawnAsync(ctx, repoRoot, argv, 300_000);
        if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "拉取远端信息失败") };
        invalidateBranchSyncRemoteHeadsCache(repoRoot);
        return {
          ok: true,
          data: {
            fetchedRemotes: [preferredRemote],
            tagMode: tagMode || "auto",
          },
        };
      }

      if (remotes.length === 0) {
        return {
          ok: true,
          data: {
            fetchedRemotes: [],
            tagMode: tagMode || "auto",
          },
        };
      }

      const fetchedRemotes: string[] = [];
      const failedRemotes: Array<{ remote: string; error: string }> = [];
      for (let index = 0; index < remotes.length; index += 1) {
        const remote = remotes[index];
        emitGitFeatureProgress(ctx, repoRoot, `正在获取远端 ${remote}（${index + 1}/${remotes.length}）`, refspec || undefined);
        const argv = ["fetch", remote];
        if (unshallow) argv.push("--unshallow");
        appendFetchTagModeArgv(argv, tagMode);
        if (refspec) argv.push(refspec);
        const oneRes = await runGitSpawnAsync(ctx, repoRoot, argv, 300_000);
        if (!oneRes.ok) {
          failedRemotes.push({
            remote,
            error: toGitErrorMessage(oneRes, `拉取远端 ${remote} 失败`),
          });
          continue;
        }
        fetchedRemotes.push(remote);
      }
      if (fetchedRemotes.length > 0) invalidateBranchSyncRemoteHeadsCache(repoRoot);
      if (failedRemotes.length > 0) {
        const failedText = failedRemotes
          .slice(0, 3)
          .map((one) => `${one.remote}: ${one.error}`)
          .join("；");
        const suffix = failedRemotes.length > 3 ? `；其余 ${failedRemotes.length - 3} 个远程也失败` : "";
        return {
          ok: false,
          error: `拉取远端失败（成功 ${fetchedRemotes.length} / 失败 ${failedRemotes.length}）：${failedText}${suffix}`,
          data: {
            fetchedRemotes,
            failedRemotes: failedRemotes.map((one) => one.remote),
            tagMode: tagMode || "auto",
          },
        };
      }
      return {
        ok: true,
        data: {
          fetchedRemotes,
          tagMode: tagMode || "auto",
        },
      };
    },
  );
}

/**
 * 判断推送失败是否属于“非快进被拒绝”。
 */
function isPushRejectedNoFastForward(res: GitExecResult): boolean {
  const combined = `${String(res.stderr || "")}\n${String(res.stdout || "")}`.toLowerCase();
  if (!combined) return false;
  if (combined.includes("non-fast-forward")) return true;
  if (combined.includes("fetch first")) return true;
  if (combined.includes("failed to lock")) return true;
  if (combined.includes("updates were rejected")) return true;
  if (combined.includes("remote contains work")) return true;
  return combined.includes("tip of your current branch is behind");
}

/**
 * 判断推送失败是否属于 `--force-with-lease` 的 stale info 拒绝。
 */
function isPushRejectedStaleInfo(res: GitExecResult): boolean {
  const combined = `${String(res.stderr || "")}\n${String(res.stdout || "")}`.toLowerCase();
  if (!combined) return false;
  return combined.includes("stale info");
}

/**
 * 判断推送失败是否属于远端自定义策略或 hook 导致的其他 reject。
 */
function isPushRejectedOther(res: GitExecResult): boolean {
  const combined = `${String(res.stderr || "")}\n${String(res.stdout || "")}`.toLowerCase();
  if (!combined) return false;
  if (isPushRejectedNoFastForward(res) || isPushRejectedStaleInfo(res)) return false;
  if (combined.includes("[remote rejected]")) return true;
  if (combined.includes("remote rejected")) return true;
  return combined.includes("[rejected]") && combined.includes("failed to push some refs");
}

/**
 * 将作者日期格式化为 Git 命令可识别文本。
 */
function formatGitAuthorDate(raw: any): string {
  if (raw === null || raw === undefined || raw === "") return "";
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 判断 pull 选项是否被启用（支持布尔字段与 options 数组混用）。
 */
function hasPullOption(payload: any, fieldName: string, cliOption: string): boolean {
  if (payload?.[fieldName] === true) return true;
  const options = Array.isArray(payload?.options) ? payload.options : [];
  const normalized = options.map((one: any) => String(one || "").trim().toLowerCase()).filter(Boolean);
  return normalized.includes(String(cliOption || "").trim().toLowerCase());
}

/**
 * 按固定大小切分路径列表，避免命令行参数过长。
 */
function chunkPathList(paths: string[], chunkSize: number = 160): string[][] {
  const clean = Array.from(new Set((paths || []).map((one) => String(one || "").trim()).filter(Boolean)));
  if (clean.length === 0) return [];
  const size = Math.max(20, Math.floor(chunkSize));
  const out: string[][] = [];
  for (let index = 0; index < clean.length; index += size) {
    out.push(clean.slice(index, index + size));
  }
  return out;
}

/**
 * 判断某路径是否被“提交选择范围”覆盖（支持目录路径覆盖其子文件）。
 */
function isPathCoveredByCommitScopes(relPath: string, selectedScopes: string[]): boolean {
  const target = String(relPath || "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!target) return false;
  for (const rawScope of selectedScopes) {
    const scope = String(rawScope || "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!scope) continue;
    if (target === scope) return true;
    if (target.startsWith(`${scope}/`)) return true;
  }
  return false;
}

/**
 * 读取当前暂存区中已暂存的路径集合（包含重命名 oldPath）。
 */
async function listStagedPathsAsync(ctx: GitFeatureContext, repoRoot: string): Promise<string[]> {
  const res = await runGitExecAsync(
    ctx,
    repoRoot,
    ["status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignored=no"],
    20_000,
  );
  if (!res.ok) return [];
  const entries = parseStatusPorcelainV2Z(String(res.stdout || ""));
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.staged) continue;
    if (entry.path) paths.push(entry.path);
    if (entry.oldPath) paths.push(entry.oldPath);
  }
  return Array.from(new Set(paths));
}

type PreservedStagedState = {
  excludedPaths: string[];
  patchFile: string;
};

/**
 * 提交前暂存区保护状态的空对象。
 */
function createEmptyPreservedStagedState(): PreservedStagedState {
  return {
    excludedPaths: [],
    patchFile: "",
  };
}

/**
 * 在提交前暂时剔除“未选中文件”的已暂存变更，并保存可恢复补丁。
 */
async function preserveExcludedStagedChangesAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  selectedScopes: string[],
): Promise<{ ok: true; state: PreservedStagedState } | { ok: false; error: string }> {
  const stagedPaths = await listStagedPathsAsync(ctx, repoRoot);
  if (stagedPaths.length === 0) return { ok: true, state: createEmptyPreservedStagedState() };

  const excludedPaths = stagedPaths.filter((one) => !isPathCoveredByCommitScopes(one, selectedScopes));
  if (excludedPaths.length === 0) return { ok: true, state: createEmptyPreservedStagedState() };

  const diffArgv = ["diff", "--cached", "--binary", "--", ...excludedPaths];
  const diffRes = await runGitExecAsync(ctx, repoRoot, diffArgv, 120_000);
  if (!diffRes.ok) return { ok: false, error: toGitErrorMessage(diffRes, "读取暂存区补丁失败") };
  const patchText = String(diffRes.stdout || "");
  if (!patchText.trim()) return { ok: true, state: createEmptyPreservedStagedState() };

  const patchFile = await writeTempGitFileAsync(ctx, "git-staged-preserve", patchText);
  for (const chunk of chunkPathList(excludedPaths, 120)) {
    const resetRes = await runGitSpawnAsync(ctx, repoRoot, ["reset", "HEAD", "--", ...chunk], 120_000);
    if (!resetRes.ok) {
      try {
        await fsp.rm(patchFile, { force: true });
      } catch {}
      return { ok: false, error: toGitErrorMessage(resetRes, "准备提交时重置暂存区失败") };
    }
  }

  return { ok: true, state: { excludedPaths, patchFile } };
}

/**
 * 提交后恢复此前剔除的“未选中文件”暂存变更。
 */
async function restoreExcludedStagedChangesAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  state: PreservedStagedState,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const patchFile = String(state?.patchFile || "").trim();
  if (!patchFile) return { ok: true };

  const applyRes = await runGitSpawnAsync(ctx, repoRoot, ["apply", "--cached", "--whitespace=nowarn", patchFile], 120_000);
  try {
    await fsp.rm(patchFile, { force: true });
  } catch {}
  if (!applyRes.ok) return { ok: false, error: toGitErrorMessage(applyRes, "恢复暂存区失败") };
  return { ok: true };
}

/**
 * 写入 Git 临时文件（提交消息、补丁等）。
 */
async function writeTempGitFileAsync(
  ctx: GitFeatureContext,
  prefix: string,
  content: string,
  options?: { fileNameHint?: string },
): Promise<string> {
  const dir = path.join(ctx.userDataPath, "git", "temp");
  await fsp.mkdir(dir, { recursive: true });
  const fileNameHint = path.basename(String(options?.fileNameHint || "").trim());
  const sanitizedHint = fileNameHint.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-");
  const extension = path.extname(sanitizedHint) || ".txt";
  const baseName = sanitizedHint
    ? sanitizedHint.slice(0, Math.max(1, sanitizedHint.length - extension.length))
    : "git-temp";
  const file = path.join(
    dir,
    `${String(prefix || "git-temp")}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${baseName}${extension}`,
  );
  await fsp.writeFile(file, String(content || ""), "utf8");
  return file;
}

/**
 * 读取仓库远程名列表，命令失败时返回 null。
 */
async function listRemoteNamesAsync(ctx: GitFeatureContext, repoRoot: string): Promise<string[] | null> {
  const remoteRes = await runGitExecAsync(ctx, repoRoot, ["remote"], 10_000);
  if (!remoteRes.ok) return null;
  return String(remoteRes.stdout || "")
    .split(/\r?\n/)
    .map((one) => String(one || "").trim())
    .filter(Boolean);
}

/**
 * 读取仓库默认远程名，规则对齐上游（单远程直接返回；多远程优先上游 remote，再 fallback origin）。
 */
async function getPreferredRemoteAsync(ctx: GitFeatureContext, repoRoot: string, remoteNamesInput?: string[] | null): Promise<string> {
  const fallbackRemoteNames = Array.isArray(remoteNamesInput) ? null : await listRemoteNamesAsync(ctx, repoRoot);
  const names = Array.from(new Set(
    (Array.isArray(remoteNamesInput) ? remoteNamesInput : (fallbackRemoteNames || []))
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  ));
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] || "";
  const upstream = await getUpstreamRefAsync(ctx, repoRoot);
  const upstreamPair = parseUpstreamRef(upstream, names);
  if (upstreamPair?.remote && names.includes(upstreamPair.remote)) return upstreamPair.remote;
  const origin = names.find((one) => one === "origin");
  return origin || "";
}

/**
 * 解析推送预览提交列表输出。
 */
function parsePushCommits(stdout: string): GitPushCommit[] {
  const rows = String(stdout || "").split("\x1e").map((one) => one.trim()).filter(Boolean);
  const out: GitPushCommit[] = [];
  for (const row of rows) {
    const seg = row.split("\x00");
    const hash = String(seg[0] || "").trim();
    if (!hash) continue;
    out.push({
      hash,
      shortHash: String(seg[1] || "").trim() || hash.slice(0, 8),
      authorName: decodeGitEscapedText(String(seg[2] || "").trim()),
      authorEmail: decodeGitEscapedText(String(seg[3] || "").trim()),
      authorDate: String(seg[4] || "").trim(),
      subject: decodeGitEscapedText(String(seg[5] || "").trim()),
      parents: String(seg[6] || "").trim().split(/\s+/).filter(Boolean),
    });
  }
  return out;
}

/**
 * 读取推送预览（分支映射、待推送提交、文件并集）。
 */
async function getPushPreviewAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const commitPanelPreferences = await readGitCommitPanelPreferencesAsync(ctx.userDataPath);
  const targetHashInput = String(payload?.targetHash || "").trim();
  const headRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 10_000);
  const headHash = headRes.ok ? String(headRes.stdout || "").trim() : "";
  const branchRes = await runGitExecAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 10_000);
  const branch = branchRes.ok ? String(branchRes.stdout || "").trim() : "";
  const detached = !branch;
  const pushTarget = branch
    ? await resolveBranchPushTargetAsync(ctx, repoRoot, branch)
    : { upstream: undefined, remote: "", remoteBranch: "", shouldSetUpstream: false, comparisonRef: undefined };
  const upstream = String(pushTarget.upstream || "").trim();
  const preferredRemote = String(pushTarget.remote || "").trim();
  const remoteBranch = String(pushTarget.remoteBranch || "").trim();
  const protectedTarget = isGitProtectedBranch(remoteBranch, commitPanelPreferences.commitAndPush.protectedBranchPatterns);
  const targetHash = targetHashInput || headHash;

  let disabledReason = "";
  let canPush = !!targetHash && !detached && !!preferredRemote && !!remoteBranch;
  if (!targetHash) disabledReason = "未读取到可推送的目标提交";
  else if (detached) disabledReason = "Detached HEAD 状态下不支持直接推送";
  else if (!preferredRemote) disabledReason = "未配置远程仓库，无法推送";
  else if (!remoteBranch) disabledReason = "未确定远端分支目标";
  if (canPush && targetHashInput && headHash) {
    const isInHead = await checkIsAncestorAsync(ctx, repoRoot, targetHashInput, headHash);
    if (!isInHead) {
      canPush = false;
      disabledReason = "所选提交不在当前分支 HEAD 历史线上";
    }
  }

  const commits: GitPushCommit[] = [];
  if (targetHash) {
    const comparisonRef = String(pushTarget.comparisonRef || "").trim();
    const argv = comparisonRef
      ? [
          "log",
          "--date=iso-strict",
          "--pretty=format:%H%x00%h%x00%an%x00%ae%x00%ad%x00%s%x00%P%x1e",
          `${comparisonRef}..${targetHash}`,
        ]
      : (preferredRemote
        ? [
            "log",
            "--date=iso-strict",
            "--pretty=format:%H%x00%h%x00%an%x00%ae%x00%ad%x00%s%x00%P%x1e",
            targetHash,
            "--not",
            `--remotes=${preferredRemote}`,
            "--max-count=1000",
          ]
      : [
          "log",
          "--date=iso-strict",
          "--pretty=format:%H%x00%h%x00%an%x00%ae%x00%ad%x00%s%x00%P%x1e",
          "--max-count",
          "120",
          targetHash,
        ]);
    const commitsRes = await runGitExecAsync(ctx, repoRoot, argv, 20_000);
    if (commitsRes.ok) {
      const parsed = parsePushCommits(commitsRes.stdout);
      commits.push(...parsed);
    }
  }

  const fileMap = new Map<string, GitCommitChangedFile>();
  for (const commit of commits.slice(0, 80)) {
    const rows = await getCommitChangedFilesAsync(ctx, repoRoot, commit.hash);
    commit.files = rows.map((row) => ({
      status: row.status,
      path: row.path,
      oldPath: row.oldPath,
    }));
    for (const row of rows) {
      const filePath = String(row.path || "").trim();
      if (!filePath || fileMap.has(filePath)) continue;
      fileMap.set(filePath, {
        status: row.status,
        path: filePath,
        oldPath: String(row.oldPath || "").trim() || undefined,
      });
    }
  }

  const pushRef = detached
    ? "Detached HEAD（不可直接推送）"
    : `${branch || "HEAD"} → ${upstream || `${preferredRemote || "remote"} : ${remoteBranch || (branch || "HEAD")}`}`;

  if (commits.length === 0) {
    canPush = false;
    if (!disabledReason) disabledReason = "没有可推送的提交";
  }

  return {
    ok: true,
    data: {
      headHash: headHash || undefined,
      targetHash: targetHash || undefined,
      detached,
      branch: branch || undefined,
      upstream: upstream || undefined,
      remote: preferredRemote || undefined,
      remoteBranch: remoteBranch || undefined,
      protectedTarget,
      canPush,
      disabledReason: disabledReason || undefined,
      pushRef,
      commitCount: commits.length,
      commits,
      files: Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path)),
    },
  };
}

/**
 * 执行推送（支持强制推送、推送标签、指定目标提交）。
 */
async function executePushAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const forceWithLease = payload?.forceWithLease === true;
  const forcePush = payload?.forcePush === true || payload?.force === true;
  const pushTagMode = String(payload?.pushTagMode || "").trim().toLowerCase();
  const pushTags = payload?.pushTags === true || pushTagMode === "all" || pushTagMode === "follow";
  const skipHook = payload?.skipHook === true || payload?.skipHooks === true;
  const updateIfRejected = canAutoUpdateAfterPushReject(payload);
  const targetHash = String(payload?.targetHash || "").trim();
  emitGitFeatureProgress(ctx, repoRoot, "正在解析推送目标");
  const branchRes = await runGitExecAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 10_000);
  const branch = branchRes.ok ? String(branchRes.stdout || "").trim() : "";
  if (!branch) return { ok: false, error: "Detached HEAD 状态下不支持该推送操作" };

  const pushTarget = await resolveBranchPushTargetAsync(ctx, repoRoot, branch);
  const upstream = String(pushTarget.upstream || "").trim();
  const remote = String(pushTarget.remote || "").trim();
  const remoteBranch = String(pushTarget.remoteBranch || "").trim() || branch;
  if (!remote) return { ok: false, error: "未配置远程仓库，无法推送" };

  const argv: string[] = ["push"];
  if (forceWithLease) argv.push("--force-with-lease");
  else if (forcePush) argv.push("--force");
  if (pushTags) {
    if (pushTagMode === "follow") argv.push("--follow-tags");
    else argv.push("--tags");
  }
  if (skipHook) argv.push("--no-verify");
  const upstreamSet = payload?.setUpstream === true || !upstream || pushTarget.shouldSetUpstream;
  if (upstreamSet) argv.push("-u");
  argv.push(remote, `${targetHash || "HEAD"}:${remoteBranch}`);
  emitGitFeatureProgress(ctx, repoRoot, `正在推送到 ${remote}/${remoteBranch}`, targetHash || branch);
  const res = await runGitSpawnAsync(ctx, repoRoot, argv, 300_000);
  if (res.ok) {
    return {
      ok: true,
      data: {
        branch,
        remote,
        remoteBranch,
        upstream: upstream || undefined,
        upstreamSet,
        retried: false,
        attempts: 1,
      },
    };
  }
  if (updateIfRejected && upstream && isPushRejectedNoFastForward(res)) {
    return {
      ok: false,
      error: `推送被拒绝：远端 ${upstream} 已领先于当前分支`,
      data: {
        pushRejected: buildPushRejectedDecisionData({
          type: "no-fast-forward",
          branch,
          upstream,
          remote,
          remoteBranch,
          allowUpdateActions: true,
          forceWithLeaseAttempted: forceWithLease,
          errorText: extractPushRejectedDetailText(res),
        }),
      },
    };
  }
  if (isPushRejectedStaleInfo(res)) {
    return {
      ok: false,
      error: "Force with Lease 被拒绝：远端引用已变化",
      data: {
        pushRejected: buildPushRejectedDecisionData({
          type: "stale-info",
          branch,
          upstream: upstream || undefined,
          remote,
          remoteBranch,
          forceWithLeaseAttempted: forceWithLease,
          errorText: extractPushRejectedDetailText(res),
        }),
      },
    };
  }
  if (isPushRejectedOther(res)) {
    return {
      ok: false,
      error: "推送被远端拒绝",
      data: {
        pushRejected: buildPushRejectedDecisionData({
          type: "rejected-other",
          branch,
          upstream: upstream || undefined,
          remote,
          remoteBranch,
          forceWithLeaseAttempted: forceWithLease,
          errorText: extractPushRejectedDetailText(res),
        }),
      },
    };
  }
  return {
    ok: false,
    error: toGitErrorMessage(res, "推送失败"),
  };
}

/**
 * 导出指定对象的原始 patch 文本。
 */
async function getDiffPatchAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const relPath = String(payload?.path || "").trim().replace(/\\/g, "/");
  const oldPath = String(payload?.oldPath || "").trim().replace(/\\/g, "/");
  const mode = String(payload?.mode || "working").trim() as GitDiffMode;
  const hash = String(payload?.hash || "").trim();
  const hashes = Array.isArray(payload?.hashes) ? payload.hashes.map((one: any) => String(one || "").trim()).filter(Boolean) : [];
  const shelfRef = String(payload?.shelfRef || "").trim();
  if (!relPath) return { ok: false, error: "缺少文件路径" };
  if (mode === "shelf") {
    if (!shelfRef) return { ok: false, error: "缺少搁置记录引用" };
    const res = await loadShelfDiffPatchAsync({
      runtime: createGitShelfDiffRuntime(ctx),
      userDataPath: ctx.userDataPath,
      repoRoot,
      ref: shelfRef,
      path: relPath,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      data: {
        path: relPath,
        mode,
        patch: res.patch,
      },
    };
  }
  if (mode === "shelfToWorking") {
    return { ok: false, error: "当前比较视图不支持直接导出 Patch" };
  }
  if (mode === "revisionToWorking" || mode === "parentToWorking") {
    return { ok: false, error: "当前比较视图不支持直接导出 Patch" };
  }

  let argv: string[] = [];
  if (mode === "staged") {
    argv = ["diff", "--cached", "--", relPath];
  } else if (mode === "localToStaged" || mode === "stagedToLocal") {
    const stageCompareArgv = buildStageCompareDiffArgv(mode, relPath, false);
    if (!stageCompareArgv) return { ok: false, error: "当前比较视图不支持直接导出 Patch" };
    argv = stageCompareArgv;
  } else if (mode === "commit") {
    const selectedHashes = hashes.length > 0 ? hashes : (hash ? [hash] : ["HEAD"]);
    if (selectedHashes.length > 1) {
      const chunks: string[] = [];
      for (const oneHash of selectedHashes) {
        const res = await runGitExecAsync(ctx, repoRoot, ["show", "--pretty=format:", oneHash, "--", relPath], 30_000);
        if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "导出 patch 失败") };
        const patchText = String(res.stdout || "");
        if (patchText.trim()) chunks.push(patchText);
      }
      return {
        ok: true,
        data: {
          path: relPath,
          mode,
          patch: chunks.join("\n"),
        },
      };
    }
    const target = selectedHashes[0] || hash || "HEAD";
    argv = ["show", "--pretty=format:", target, "--", relPath];
  } else if (mode === "revisionToRevision") {
    const refs = resolveRevisionCompareRefs({ hash, hashes });
    const compareArgv = refs
      ? buildRevisionCompareDiffArgv({
          leftRef: refs.leftRef,
          rightRef: refs.rightRef,
          relPath,
          oldPath,
        })
      : null;
    if (!compareArgv) return { ok: false, error: "当前比较视图缺少有效的左右引用" };
    argv = compareArgv;
  } else {
    argv = ["diff", "--", relPath];
  }

  const res = await runGitExecAsync(ctx, repoRoot, argv, 30_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "导出 patch 失败") };
  return {
    ok: true,
    data: {
      path: relPath,
      mode,
      patch: String(res.stdout || ""),
    },
  };
}

/**
 * 把某个 Git 对象版本落成临时文件，供外部 IDE / 系统程序直接打开。
 */
async function materializeGitRevisionFileAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  objectRef: string,
  fileNameHint: string,
): Promise<{ ok: true; path: string; temporary: true } | { ok: false; error: string }> {
  const tempPath = await writeTempGitFileAsync(ctx, "git-diff-open", "", { fileNameHint });
  const showRes = await runGitStdoutToFileAsync(ctx, repoRoot, ["show", objectRef], tempPath, 60_000);
  if (!showRes.ok) {
    try {
      await fsp.rm(tempPath, { force: true });
    } catch {}
    return { ok: false, error: toGitErrorMessage(showRes, "读取比较版本失败") };
  }
  return {
    ok: true,
    path: tempPath,
    temporary: true,
  };
}

/**
 * 为当前 Diff 解析一个可外部打开的真实文件路径；优先对齐当前比较右侧，缺失时再回退到仍存在的另一侧版本。
 */
async function getDiffOpenPathAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const relPath = String(payload?.path || "").trim().replace(/\\/g, "/");
  const oldPath = String(payload?.oldPath || "").trim().replace(/\\/g, "/") || undefined;
  const mode = String(payload?.mode || "working").trim() as GitDiffMode;
  const hash = String(payload?.hash || "").trim();
  const hashes: string[] = Array.from(new Set(
    (Array.isArray(payload?.hashes) ? payload.hashes : [])
      .map((item: unknown) => String(item || "").trim())
      .filter(Boolean),
  ));
  if (!relPath) return { ok: false, error: "缺少文件路径" };

  /**
   * 把当前工作区文件转成可直接打开的绝对路径，避免历史 Diff 错误回落到无关文件。
   */
  const resolveWorkspaceOpenPathAsync = async (
    filePath: string,
  ): Promise<{ ok: true; path: string; temporary?: false } | { ok: false; error: string }> => {
    const absolutePath = path.join(repoRoot, filePath);
    try {
      await fsp.access(absolutePath);
      return { ok: true, path: absolutePath };
    } catch {
      return { ok: false, error: "当前工作区文件不存在" };
    }
  };

  if (mode === "working" || mode === "revisionToWorking" || mode === "parentToWorking" || mode === "stagedToLocal") {
    const openPathRes = await resolveWorkspaceOpenPathAsync(relPath);
    if (!openPathRes.ok) return openPathRes;
    return {
      ok: true,
      data: {
        path: openPathRes.path,
      },
    };
  }

  if (mode === "staged" || mode === "localToStaged") {
    const openPathRes = await materializeGitRevisionFileAsync(ctx, repoRoot, `:${relPath}`, relPath);
    if (!openPathRes.ok) return openPathRes;
    return {
      ok: true,
      data: {
        path: openPathRes.path,
        temporary: openPathRes.temporary,
      },
    };
  }

  if (mode === "commit") {
    const selectedHashes = hashes.length > 0 ? hashes : (hash ? [hash] : ["HEAD"]);
    const resolved = await resolveCommitDiffSelectionAsync(ctx, repoRoot, selectedHashes, relPath);
    const targetHash = resolved?.deletedInRight
      ? String(resolved?.leftHash || "").trim()
      : String(resolved?.rightHash || hash || "").trim();
    const targetPath = resolved?.deletedInRight
      ? String(resolved?.leftPath || oldPath || relPath).trim()
      : String(resolved?.rightPath || relPath).trim();
    if (!targetHash || !targetPath) return { ok: false, error: "当前比较对象没有可打开的仓库版本" };
    const openPathRes = await materializeGitRevisionFileAsync(ctx, repoRoot, `${targetHash}:${targetPath}`, targetPath);
    if (!openPathRes.ok) return openPathRes;
    return {
      ok: true,
      data: {
        path: openPathRes.path,
        temporary: openPathRes.temporary,
      },
    };
  }

  if (mode === "revisionToRevision") {
    const refs = resolveRevisionCompareRefs({ hash, hashes });
    const leftRef = String(refs?.leftRef || "").trim();
    const rightRef = String(refs?.rightRef || "").trim();
    const candidates = [
      { ref: rightRef, filePath: relPath },
      { ref: leftRef, filePath: oldPath || relPath },
    ];
    let lastError = "";
    const seenCandidates = new Set<string>();
    for (const candidate of candidates) {
      const candidateRef = String(candidate.ref || "").trim();
      const candidatePath = String(candidate.filePath || "").trim();
      if (!candidateRef || !candidatePath) continue;
      const candidateKey = `${candidateRef}\u0000${candidatePath}`;
      if (seenCandidates.has(candidateKey)) continue;
      seenCandidates.add(candidateKey);
      const openPathRes = await materializeGitRevisionFileAsync(ctx, repoRoot, `${candidateRef}:${candidatePath}`, candidatePath);
      if (!openPathRes.ok) {
        lastError = openPathRes.error;
        continue;
      }
      return {
        ok: true,
        data: {
          path: openPathRes.path,
          temporary: openPathRes.temporary,
        },
      };
    }
    return { ok: false, error: lastError || "当前比较对象没有可打开的仓库版本" };
  }

  return { ok: false, error: "当前比较视图暂不支持外部打开" };
}

/**
 * 读取单个提交的详细信息与文件列表。
 */
async function getSingleCommitDetailsAsync(ctx: GitFeatureContext, repoRoot: string, hash: string): Promise<any> {
  const metaRes = await runGitExecAsync(
    ctx,
    repoRoot,
    ["show", "-s", "--date=iso-strict", "--pretty=format:%H%x00%P%x00%an%x00%ae%x00%ad%x00%s%x00%B", hash],
    12_000,
  );
  if (!metaRes.ok) throw new Error(toGitErrorMessage(metaRes, "读取提交详情失败"));

  const parts = String(metaRes.stdout || "").split("\x00");
  const commitHash = String(parts[0] || "").trim();
  const resolvedHash = commitHash || String(hash || "").trim();
  const parents = String(parts[1] || "").trim().split(/\s+/).filter(Boolean);
  const authorName = String(parts[2] || "").trim();
  const authorEmail = String(parts[3] || "").trim();
  const authorDate = String(parts[4] || "").trim();
  const subject = decodeGitEscapedText(String(parts[5] || "").trim());
  const body = decodeGitEscapedText(String(parts.slice(6).join("\x00") || ""));

  const files = await getCommitChangedFilesAsync(ctx, repoRoot, resolvedHash);
  const lineStats = await getCommitLineStatsAsync(ctx, repoRoot, resolvedHash);

  const branchContainsRes = await runGitExecAsync(ctx, repoRoot, ["branch", "--contains", resolvedHash], 8000);
  const branches = branchContainsRes.ok
    ? String(branchContainsRes.stdout || "")
        .split(/\r?\n/)
        .map((x) => decodeGitEscapedText(x.replace(/^\*\s*/, "").trim()))
        .filter(Boolean)
    : [];

  const tagContainsRes = await runGitExecAsync(ctx, repoRoot, ["tag", "--contains", resolvedHash], 8000);
  const tags = tagContainsRes.ok
    ? String(tagContainsRes.stdout || "").split(/\r?\n/).map((x) => decodeGitEscapedText(x.trim())).filter(Boolean)
    : [];

  return {
    hash: commitHash,
    shortHash: commitHash.slice(0, 8),
    parents,
    authorName,
    authorEmail,
    authorDate,
    subject,
    body,
    files,
    lineStats,
    branches,
    tags,
  };
}

/**
 * 规整单提交详情缓存使用的提交哈希；Git 哈希大小写不敏感，因此统一按小写键比较。
 */
function normalizeSingleCommitDetailsCacheHash(hash: string): string {
  return String(hash || "").trim().toLowerCase();
}

/**
 * 构造单提交详情缓存键；仓库路径与提交哈希的精确请求键共同决定唯一性，兼容同一进程内多仓并存。
 */
function buildSingleCommitDetailsCacheKey(repoRoot: string, hash: string): string {
  const normalizedRepoRoot = String(repoRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const normalizedHash = normalizeSingleCommitDetailsCacheHash(hash);
  if (!normalizedRepoRoot || !normalizedHash) return "";
  return `${normalizedRepoRoot}::${normalizedHash}`;
}

/**
 * 把单提交详情缓存条目挂到指定精确请求键下；当前行为与上游 `Hash` 语义一致，不做短前缀别名折叠。
 */
function rememberSingleCommitDetailsCacheEntry(repoRoot: string, hash: string, entry: SingleCommitDetailsCacheEntry): void {
  const cacheKey = buildSingleCommitDetailsCacheKey(repoRoot, hash);
  if (!cacheKey) return;
  if (singleCommitDetailsCache.has(cacheKey))
    singleCommitDetailsCache.delete(cacheKey);
  singleCommitDetailsCache.set(cacheKey, entry);
  while (singleCommitDetailsCache.size > SINGLE_COMMIT_DETAILS_CACHE_MAX_ENTRIES) {
    const oldestKey = singleCommitDetailsCache.keys().next().value;
    if (!oldestKey) break;
    singleCommitDetailsCache.delete(oldestKey);
  }
}

/**
 * 清空单提交详情缓存与在途请求；遇到非 `log.details` 动作时调用，避免 refs/history 变更后继续复用旧详情或旧 Promise。
 */
function clearSingleCommitDetailsCache(): void {
  singleCommitDetailsCache.clear();
  singleCommitDetailsInFlight.clear();
}

/**
 * 尝试读取仍在 TTL 内的单提交详情缓存；当前只按精确请求键命中，不做短前缀等价折叠。
 */
function getCachedSingleCommitDetails(repoRoot: string, hash: string): any | null {
  const cacheKey = buildSingleCommitDetailsCacheKey(repoRoot, hash);
  if (!cacheKey) return null;
  const cached = singleCommitDetailsCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > SINGLE_COMMIT_DETAILS_CACHE_TTL_MS) {
    singleCommitDetailsCache.delete(cacheKey);
    return null;
  }
  return cached.detail;
}

/**
 * 写入单提交详情缓存；优先使用当前请求键，保持与调用方传入的 canonical Hash 一一对应。
 */
function storeSingleCommitDetailsCache(repoRoot: string, hash: string, detail: any): void {
  const normalizedHash = normalizeSingleCommitDetailsCacheHash(hash);
  if (!normalizedHash) return;
  const entry = {
    fetchedAt: Date.now(),
    detail,
  };
  rememberSingleCommitDetailsCacheEntry(repoRoot, normalizedHash, entry);
}

/**
 * 判断当前动作是否应失效单提交详情缓存；仅 refs / history 可能变化时才清空，避免只读刷新打断详情复用。
 */
function shouldInvalidateSingleCommitDetailsCache(action: string): boolean {
  return COMMIT_DETAILS_CACHE_INVALIDATE_ACTIONS.has(String(action || "").trim());
}

/**
 * 按上游 `commitDetailsGetter` 近似语义读取单提交详情；优先复用精确键缓存，其次合并同键并发请求。
 */
async function getSingleCommitDetailsWithCacheAsync(ctx: GitFeatureContext, repoRoot: string, hash: string): Promise<any> {
  const cacheHit = getCachedSingleCommitDetails(repoRoot, hash);
  if (cacheHit) return cacheHit;

  const cacheKey = buildSingleCommitDetailsCacheKey(repoRoot, hash);
  if (!cacheKey) return await getSingleCommitDetailsAsync(ctx, repoRoot, hash);

  const inFlight = singleCommitDetailsInFlight.get(cacheKey);
  if (inFlight) return await inFlight;

  const task = (async (): Promise<any> => {
    const detail = await getSingleCommitDetailsAsync(ctx, repoRoot, hash);
    storeSingleCommitDetailsCache(repoRoot, hash, detail);
    return detail;
  })();

  singleCommitDetailsInFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    if (singleCommitDetailsInFlight.get(cacheKey) === task)
      singleCommitDetailsInFlight.delete(cacheKey);
  }
}

/**
 * 读取当前操作应使用的本地改动保护策略，供分支侧的 Merge/Rebase/PullRemote 复用 Update Project 的 preserving 模型。
 */
async function resolveUpdateSaveChangesPolicyAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload?: any,
): Promise<GitUpdateSaveChangesPolicy> {
  return (await getUpdateOptionsSnapshotAsync(createGitUpdateConfigRuntime(ctx, repoRoot), payload || {})).methodResolution.saveChangesPolicy;
}

/**
 * 把日志 apply-changes 动作映射为结构化问题里的操作名，便于复用统一 smart operation 对话框。
 */
function resolveLogApplyChangesProblemOperation(action: string): "cherry-pick" {
  void action;
  return "cherry-pick";
}

/**
 * 根据保存策略构造“保存并重试”按钮文案，对齐上游在 apply changes 失败通知中的动作语义。
 */
function getLogApplyChangesRetryActionLabel(saveChangesPolicy: GitUpdateSaveChangesPolicy): string {
  return saveChangesPolicy === "shelve" ? "搁置更改并重试" : "暂存更改并重试";
}

/**
 * 为日志 apply-changes 动作补齐统一问题标题与描述；即使底层 Git 用 merge 语义报错，UI 仍按用户发起的 Cherry-pick 呈现。
 */
function getLogApplyChangesProblemTexts(
  action: string,
  kind: GitUpdateProblemFileList["kind"],
): { title: string; description: string } {
  if (action === "cherryPick") {
    return kind === "untracked-overwritten"
      ? {
          title: "优选失败",
          description: "未跟踪文件将被优选覆盖。请先移动、删除，或纳入版本控制后再继续。",
        }
      : {
          title: "优选失败",
          description: "您的本地更改将被优选覆盖。提交、搁置或还原您的更改以继续。",
        };
  }
  return kind === "untracked-overwritten"
    ? {
        title: "未跟踪文件会被当前 Git 操作覆盖",
        description: "以下未跟踪文件会被当前 Git 操作覆盖。请先移动、删除，或纳入版本控制后再重试。",
      }
    : {
        title: "本地改动会被当前 Git 操作覆盖",
        description: "以下文件的本地改动会被当前 Git 操作覆盖。请先提交、暂存，或改用保存本地改动后再重试。",
      };
}

/**
 * 收集待应用提交影响的路径集合，供本地改动覆盖问题补齐受影响文件列表。
 */
async function collectLogApplyChangesPathsAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  hashes: string[],
): Promise<string[]> {
  const files = new Set<string>();
  for (const hash of hashes) {
    const changedFiles = await getCommitChangedFilesAsync(ctx, repoRoot, hash);
    for (const file of changedFiles) {
      const pathText = String(file.path || "").trim().replace(/\\/g, "/");
      const oldPathText = String(file.oldPath || "").trim().replace(/\\/g, "/");
      if (pathText) files.add(pathText);
      if (oldPathText) files.add(oldPathText);
    }
  }
  return Array.from(files);
}

/**
 * 在真正执行 Cherry-pick 前，按上游 apply-changes 语义预判“本地更改/未跟踪文件将被覆盖”；
 * 命中时直接返回结构化失败，避免先启动 sequencer 再让前端看到“优选失败”。
 */
async function detectCherryPickPreflightOperationProblemAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  hashes: string[],
  payload?: any,
) {
  const affectedPaths = await collectLogApplyChangesPathsAsync(ctx, repoRoot, hashes);
  if (affectedPaths.length <= 0) return null;
  const statusRes = await runGitExecAsync(ctx, repoRoot, ["status", "--porcelain=v2", "-z"], 12_000);
  if (!statusRes.ok) return null;
  const entries = parseCommitPanelStatusPorcelainV2Z(statusRes.stdout);
  const normalizePath = (value: string): string => String(value || "").trim().replace(/\\/g, "/");
  const affectedLookup = new Set(affectedPaths.map(normalizePath).filter(Boolean));
  const untrackedFiles = new Set<string>();
  let hasTrackedLocalChanges = false;
  for (const entry of entries) {
    const pathText = normalizePath(entry.path);
    const oldPathText = normalizePath(entry.oldPath || "");
    const matchedPath = (pathText && affectedLookup.has(pathText))
      ? pathText
      : (oldPathText && affectedLookup.has(oldPathText) ? oldPathText : "");
    if (!matchedPath) continue;
    if (entry.untracked) {
      untrackedFiles.add(matchedPath);
      continue;
    }
  }
  for (const entry of entries) {
    if (entry.ignored || entry.untracked) continue;
    if (entry.staged || entry.unstaged || entry.conflictState === "conflict" || entry.conflictState === "resolved") {
      hasTrackedLocalChanges = true;
      break;
    }
  }
  if (untrackedFiles.size > 0) {
    const problemTexts = getLogApplyChangesProblemTexts("cherryPick", "untracked-overwritten");
    return buildOperationProblemFromFileList(
      {
        operation: "cherry-pick",
        kind: "untracked-overwritten",
        title: problemTexts.title,
        description: problemTexts.description,
        files: Array.from(untrackedFiles),
      },
      "smart-operation",
      { repoRoot },
    );
  }
  if (hasTrackedLocalChanges) {
    const problemTexts = getLogApplyChangesProblemTexts("cherryPick", "local-changes-overwritten");
    const saveChangesPolicy = await resolveUpdateSaveChangesPolicyAsync(ctx, repoRoot, payload);
    return buildOperationProblemFromFileList(
      {
        operation: "cherry-pick",
        kind: "local-changes-overwritten",
        title: problemTexts.title,
        description: problemTexts.description,
        files: affectedPaths,
      },
      "smart-operation",
      {
        repoRoot,
        actions: [
          buildUpdateProblemAction(
            "smart",
            getLogApplyChangesRetryActionLabel(saveChangesPolicy),
            {
              autoSaveLocalChanges: true,
              saveChangesPolicy,
            },
            "primary",
          ),
        ],
      },
    );
  }
  return null;
}

/**
 * 为 cherry-pick 的“本地改动/未跟踪文件将被覆盖”失败构建结构化问题，并补齐“保存并重试”动作。
 */
async function buildLogApplyChangesOperationProblemAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  action: string,
  hashes: string[],
  commandRes: GitExecResult,
  payload?: any,
) {
  const problemOperation = resolveLogApplyChangesProblemOperation(action);
  const parsedProblem = parseSmartOperationProblem(commandRes, problemOperation) || parseSmartOperationProblem(commandRes, "merge");
  if (!parsedProblem) return null;
  const problemTexts = getLogApplyChangesProblemTexts(action, parsedProblem.kind);

  let files = parsedProblem.files;
  if (parsedProblem.kind === "local-changes-overwritten" && files.length <= 0) {
    const [localPaths, affectedPaths] = await Promise.all([
      listLocalChangePathsAsync(ctx, repoRoot),
      collectLogApplyChangesPathsAsync(ctx, repoRoot, hashes),
    ]);
    const localLookup = new Set(localPaths.map((item) => String(item || "").trim().replace(/\\/g, "/")).filter(Boolean));
    const matchedPaths = affectedPaths.filter((item) => localLookup.has(String(item || "").trim().replace(/\\/g, "/")));
    files = matchedPaths.length > 0 ? matchedPaths : affectedPaths;
  }

  const extraActions = [];
  if (parsedProblem.kind === "local-changes-overwritten") {
    const saveChangesPolicy = await resolveUpdateSaveChangesPolicyAsync(ctx, repoRoot, payload);
    extraActions.push(buildUpdateProblemAction(
      "smart",
      getLogApplyChangesRetryActionLabel(saveChangesPolicy),
      {
        autoSaveLocalChanges: true,
        saveChangesPolicy,
      },
      "primary",
    ));
  }

  return buildOperationProblemFromFileList(
    {
      ...parsedProblem,
      operation: problemOperation,
      title: problemTexts.title,
      description: problemTexts.description,
      files,
    },
    "smart-operation",
    {
      repoRoot,
      actions: extraActions,
    },
  );
}

/**
 * 在日志 apply-changes 动作重试前临时保存本地改动，并在成功后自动恢复；若进入进行中状态，则保留保存记录供用户手动恢复。
 */
async function runLogApplyChangesWithPreservedLocalChangesAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  action: "cherryPick",
  hashes: string[],
  payload: any,
): Promise<GitFeatureActionResult> {
  const fallback = action === "cherryPick" ? "摘取提交失败" : "执行 Git 日志动作失败";
  const saveChangesPolicy = payload?.saveChangesPolicy === "shelve" ? "shelve" : "stash";
  const saveRes = await saveLocalChangesForUpdateAsync(ctx, repoRoot, `log ${action}`, saveChangesPolicy);
  if (!saveRes.ok) return saveRes;

  const argv = action === "cherryPick" ? ["cherry-pick", "-x", ...hashes] : hashes;
  const commandRes = await runGitSpawnAsync(ctx, repoRoot, argv, 180_000);
  if (!commandRes.ok) {
    if (action === "cherryPick" && isEmptyCherryPickResult(commandRes)) {
      const skipRes = await skipEmptyCherryPickAsync(ctx, repoRoot);
      if (skipRes.ok) {
        const restoreRes = await restoreLocalChangesAfterUpdateAsync(ctx, repoRoot, saveRes.saved);
        if (!restoreRes.ok) {
          return {
            ok: false,
            error: restoreRes.error,
            data: {
              shouldRefresh: true,
              preservingState: restoreRes.preservingState,
            },
          };
        }
        return {
          ok: true,
          data: {
            ...(skipRes.data || {}),
            ...(restoreRes.preservingState ? { preservingState: restoreRes.preservingState } : {}),
          },
        };
      }
      const operationState = String(skipRes.data?.operationState || "").trim();
      if (operationState) {
        if (saveRes.saved)
          rememberOngoingOperationSavedLocalChanges(repoRoot, operationState as GitRepositoryOperationState, saveRes.saved);
        return {
          ok: false,
          error: skipRes.error,
          data: {
            ...(skipRes.data || {}),
            preservingState: saveRes.saved
              ? notifyUpdateLocalChangesNotRestored(saveRes.saved, "manual-decision")
              : undefined,
          },
        };
      }
      return skipRes;
    }
    const operationAware = await buildOperationAwareGitFailureResultAsync(ctx, repoRoot, commandRes, fallback);
    const operationState = String(operationAware.data?.operationState || "").trim();
    if (operationState) {
      if (saveRes.saved)
        rememberOngoingOperationSavedLocalChanges(repoRoot, operationState as GitRepositoryOperationState, saveRes.saved);
      return {
        ok: false,
        error: operationAware.error,
        data: {
          ...(operationAware.data || {}),
          preservingState: saveRes.saved
            ? notifyUpdateLocalChangesNotRestored(saveRes.saved, "manual-decision")
            : undefined,
        },
      };
    }

    const restoreRes = await restoreLocalChangesAfterUpdateAsync(ctx, repoRoot, saveRes.saved);
    if (!restoreRes.ok) {
      return {
        ok: false,
        error: restoreRes.error,
        data: {
          shouldRefresh: true,
          preservingState: restoreRes.preservingState,
        },
      };
    }

    const operationProblem = await buildLogApplyChangesOperationProblemAsync(ctx, repoRoot, action, hashes, commandRes, payload);
    if (operationProblem) {
      return {
        ok: false,
        error: toGitErrorMessage(commandRes, fallback),
        data: {
          operationProblem,
        },
      };
    }
    return {
      ok: false,
      error: toGitErrorMessage(commandRes, fallback),
    };
  }

  const restoreRes = await restoreLocalChangesAfterUpdateAsync(ctx, repoRoot, saveRes.saved);
  if (!restoreRes.ok) {
    return {
      ok: false,
      error: restoreRes.error,
      data: {
        shouldRefresh: true,
        preservingState: restoreRes.preservingState,
      },
    };
  }

  return {
    ok: true,
    data: restoreRes.preservingState
      ? {
          preservingState: restoreRes.preservingState,
        }
      : undefined,
  };
}

/**
 * 判断一次智能签出结果是否已经进入“本地改动未恢复”的阻断状态，避免继续执行后续 Merge/Rebase 叠加风险。
 */
function hasBlockingPreservingState(data: any): boolean {
  const status = String(data?.preservingState?.status || "").trim();
  return status === "restore-failed" || status === "kept-saved";
}

/**
 * 为复合分支动作执行前置签出；若签出链已经命中结构化问题或本地改动未恢复，则直接返回给前端处理。
 */
async function prepareCompositeBranchSwitchAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  ref: string,
  payload?: any,
): Promise<
  | { ok: true; branchName: string }
  | { ok: false; result: GitFeatureActionResult }
> {
  const switchRes = await switchRefAsync(ctx, repoRoot, ref, payload);
  if (!switchRes.ok) {
    return {
      ok: false,
      result: switchRes,
    };
  }
  if (hasBlockingPreservingState(switchRes.data)) {
    return {
      ok: false,
      result: switchRes,
    };
  }
  const headInfo = await getHeadInfoAsync(ctx, repoRoot);
  const branchName = String(headInfo.branch || "").trim();
  if (headInfo.detached || !branchName) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "签出目标分支后未能定位当前分支，无法继续后续操作",
      },
    };
  }
  return {
    ok: true,
    branchName,
  };
}

/**
 * 解析分支侧复合动作最终应执行的更新方式。
 * - 默认按入口语义执行 Merge/Rebase；
 * - 当 Rebase warning 的替代动作把 `updateMethod=merge` 并回原 payload 时，复合动作会自动切换到 Merge。
 */
function resolveCompositeBranchUpdateMethod(
  payload: any,
  fallbackMethod: "merge" | "rebase",
): "merge" | "rebase" {
  const explicitMethod = String(payload?.updateMethod || "").trim();
  if (explicitMethod === "merge" || explicitMethod === "rebase") return explicitMethod;
  return fallbackMethod;
}

/**
 * 执行分支侧的 Merge/Rebase 更新链，统一复用 Update Project 的 warning / preserving / problem 模型。
 */
async function executeCompositeBranchUpdateAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  currentBranch: string,
  upstreamRef: string,
  payload: any,
  fallbackMethod: "merge" | "rebase",
): Promise<GitFeatureActionResult> {
  const method = resolveCompositeBranchUpdateMethod(payload, fallbackMethod);
  const saveChangesPolicy = await resolveUpdateSaveChangesPolicyAsync(ctx, repoRoot, payload);
  if (method === "merge") {
    const runtime = createGitUpdateMergeRuntime(ctx, repoRoot);
    const plan = await planMergeUpdateAsync(runtime, currentBranch, upstreamRef);
    const preservingProcess = new GitPreservingProcess(
      runtime,
      plan.saveNeeded ? [runtime.repoRoot] : [],
      "update merge",
      upstreamRef,
      saveChangesPolicy,
    );
    return await preservingProcess.execute(
      async () => await runMergeUpdateCoreAsync(runtime, upstreamRef, payload),
      async (result) => result.ok,
    );
  }
  const runtime = createGitUpdateRebaseRuntime(ctx, repoRoot);
  const plan = await planRebaseUpdateAsync(runtime, currentBranch, upstreamRef, payload);
  if (plan.type === "result") return plan.result;
  const preservingProcess = new GitPreservingProcess(
    runtime,
    plan.saveNeeded ? [runtime.repoRoot] : [],
    "update rebase",
    upstreamRef,
    saveChangesPolicy,
  );
  return await preservingProcess.execute(
    async () => await runRebaseUpdateCoreAsync(runtime, upstreamRef, payload),
    async (result) => result.ok,
  );
}

/**
 * 执行“签出后再 Merge/Rebase”的复合分支动作，先收口 checkout 问题，再进入统一 updater 分流。
 */
async function executeCheckoutThenCompositeUpdateAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  switchRef: string,
  upstreamRef: string,
  payload: any,
  fallbackMethod: "merge" | "rebase",
): Promise<GitFeatureActionResult> {
  const switchState = await prepareCompositeBranchSwitchAsync(ctx, repoRoot, switchRef, payload);
  if (!switchState.ok) return switchState.result;
  return await executeCompositeBranchUpdateAsync(
    ctx,
    repoRoot,
    switchState.branchName,
    upstreamRef,
    payload,
    fallbackMethod,
  );
}

/**
 * 执行“在指定本地分支上 Merge/Rebase”的复合分支动作，必要时会先安全签出到目标分支。
 */
async function executeBranchToTargetUpdateAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  baseBranch: string,
  upstreamRef: string,
  payload: any,
  fallbackMethod: "merge" | "rebase",
): Promise<GitFeatureActionResult> {
  const currentHead = await getHeadInfoAsync(ctx, repoRoot);
  let currentBranch = String(currentHead.branch || "").trim();
  if (currentHead.detached) {
    return {
      ok: false,
      error: "Detached HEAD 状态下不支持该操作",
    };
  }
  if (!currentBranch || currentBranch !== baseBranch) {
    const switchState = await prepareCompositeBranchSwitchAsync(ctx, repoRoot, baseBranch, payload);
    if (!switchState.ok) return switchState.result;
    currentBranch = switchState.branchName;
  }
  if (!currentBranch) {
    return {
      ok: false,
      error: "未能解析当前分支，无法继续后续操作",
    };
  }
  return await executeCompositeBranchUpdateAsync(
    ctx,
    repoRoot,
    currentBranch,
    upstreamRef,
    payload,
    fallbackMethod,
  );
}

/**
 * 执行远端拉取后的 Merge/Rebase 链路，先显式 fetch，再复用统一 updater 处理 warning/problem。
 */
async function executePullRemoteCompositeUpdateAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  currentBranch: string,
  remote: string,
  remoteBranch: string,
  payload: any,
  fallbackMethod: "merge" | "rebase",
): Promise<GitFeatureActionResult> {
  emitGitFeatureProgress(ctx, repoRoot, "正在获取远端分支", `${remote}/${remoteBranch}`);
  const fetchRes = await runGitSpawnAsync(ctx, repoRoot, ["fetch", remote, remoteBranch], 300_000);
  if (!fetchRes.ok) {
    return {
      ok: false,
      error: toGitErrorMessage(fetchRes, "获取远端分支失败"),
    };
  }
  return await executeCompositeBranchUpdateAsync(
    ctx,
    repoRoot,
    currentBranch,
    `${remote}/${remoteBranch}`,
    payload,
    fallbackMethod,
  );
}

/**
 * 执行独立 Pull（Merge）链路，对齐上游的默认 Pull 行为，不复用 Update Project 的 fetch/orchestrator 主链。
 */
async function executeDirectPullRemoteAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  currentBranch: string,
  remote: string,
  remoteBranch: string,
  payload: any,
): Promise<GitFeatureActionResult> {
  emitGitFeatureProgress(ctx, repoRoot, "正在拉取远端分支", `${remote}/${remoteBranch}`);
  const pullRes = await runGitSpawnAsync(ctx, repoRoot, buildPullRemoteArgv(remote, remoteBranch, payload), 300_000);
  if (pullRes.ok) {
    return {
      ok: true,
      data: {
        branch: currentBranch,
        remote,
        remoteBranch,
        upstream: `${remote}/${remoteBranch}`,
      },
    };
  }

  const mergeFailure = parseMergeFailure(pullRes);
  if (mergeFailure.type === "OTHER") {
    return await buildOperationAwareGitFailureResultAsync(ctx, repoRoot, pullRes, "拉取远端分支失败");
  }

  const operationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  return {
    ok: false,
    error: mergeFailure.message || toGitErrorMessage(pullRes, "拉取远端分支失败"),
    data: {
      shouldRefresh: operationState !== "normal",
      operationState: operationState !== "normal" ? operationState : undefined,
      mergeFailure,
      smartOperationProblem: mergeFailure.fileList,
      operationProblem: mergeFailure.problem,
    },
  };
}

/**
 * 为继续/中止进行中的 Git 操作准备无交互环境变量，避免命令等待外部编辑器而悬挂。
 */
function buildOngoingOperationEnvPatch(operationState: GitRepositoryOperationState): NodeJS.ProcessEnv | undefined {
  if (operationState === "normal") return undefined;
  const patch: NodeJS.ProcessEnv = {
    GIT_EDITOR: "true",
  };
  if (operationState === "merging") patch.GIT_MERGE_AUTOEDIT = "no";
  return patch;
}

/**
 * 将当前仓库操作状态转成面向用户的简短标签，供 continue/abort 提示与前端状态条复用。
 */
function getRepositoryOperationLabel(operationState: GitRepositoryOperationState): string {
  if (operationState === "rebasing") return "Rebase";
  if (operationState === "merging") return "Merge";
  if (operationState === "grafting") return "Cherry-pick";
  if (operationState === "reverting") return "Revert";
  return "Git 操作";
}

/**
 * 识别 Cherry-pick 执行/继续时的 empty commit 结果，供后端对齐上游的 empty cherry-pick 策略。
 */
function isEmptyCherryPickResult(commandRes: GitExecResult): boolean {
  const stdout = String(commandRes.stdout || "");
  const stderr = String(commandRes.stderr || "");
  return stdout.includes("nothing to commit")
    || stdout.includes("nothing added to commit but untracked files present")
    || stdout.includes("The previous cherry-pick is now empty")
    || stderr.includes("previous cherry-pick is now empty");
}

/**
 * 按上游默认策略在 empty cherry-pick 时自动执行 `git cherry-pick --skip`，推进 sequencer 到后续提交。
 */
async function skipEmptyCherryPickAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
): Promise<GitFeatureActionResult> {
  const skipRes = await runGitSpawnAsync(
    ctx,
    repoRoot,
    ["cherry-pick", "--skip"],
    120_000,
    buildOngoingOperationEnvPatch("grafting"),
  );
  if (!skipRes.ok)
    return await buildOperationAwareGitFailureResultAsync(ctx, repoRoot, skipRes, "跳过空优选提交失败");
  const nextOperationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  return {
    ok: true,
    data: {
      shouldRefresh: true,
      operationState: nextOperationState,
      operation: "grafting",
      control: "continue",
      completed: nextOperationState === "normal",
      skippedEmptyCherryPick: true,
    },
  };
}

/**
 * 为 continue 后再次进入冲突的进行中操作构造结构化问题；当前优先覆盖 Cherry-pick 与 Merge，
 * 这样前端可以复用统一冲突对话框，而不是把 Git 底层报错直接展示为最终失败。
 */
function buildOngoingOperationConflictProblem(
  repoRoot: string,
  operationState: GitRepositoryOperationState,
): GitUpdateOperationProblem | null {
  if (operationState === "grafting") {
    return {
      operation: "cherry-pick",
      kind: "merge-conflict",
      title: "Cherry-pick 过程中出现冲突",
      description: "当前仓库已进入 Cherry-pick 冲突状态，请先解决冲突并继续或中止本次 Cherry-pick。",
      files: [],
      source: "smart-operation",
      repoRoot,
      mergeFailureType: "CONFLICT",
      actions: [],
    };
  }
  if (operationState === "merging") {
    return buildMergeConflictOperationProblem({
      repoRoot,
      mergeFailureType: "CONFLICT",
    });
  }
  return null;
}

/**
 * 将 continue/abort 的失败结果规整为统一返回值；若 continue 实际已把仓库推进到新的进行中状态，
 * 则保留刷新与状态信息，并在冲突场景下附带结构化问题供前端继续走冲突处理流程。
 */
async function buildOperationControlFailureResultAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  control: "continue" | "abort",
  operationState: GitRepositoryOperationState,
  commandRes: GitExecResult,
): Promise<GitFeatureActionResult> {
  const operationLabel = getRepositoryOperationLabel(operationState);
  const error = toGitErrorMessage(
    commandRes,
    control === "continue" ? `继续 ${operationLabel} 失败` : `中止 ${operationLabel} 失败`,
  );
  const nextOperationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  const mergeFailure = parseMergeFailure(commandRes);
  const operationProblem = control === "continue" && mergeFailure.type === "CONFLICT"
    ? buildOngoingOperationConflictProblem(repoRoot, nextOperationState)
    : null;
  return {
    ok: false,
    error,
    data: {
      shouldRefresh: true,
      operationState: nextOperationState,
      operation: operationState,
      control,
      completed: false,
      operationProblem: operationProblem || undefined,
    },
  };
}

/**
 * 中止进行中的 Merge；优先使用 `merge --abort`，必要时回退到 `reset --merge`。
 */
async function abortMergeOperationAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const envPatch = buildOngoingOperationEnvPatch("merging");
  const mergeAbortRes = await runGitSpawnAsync(ctx, repoRoot, ["merge", "--abort"], 120_000, envPatch);
  if (mergeAbortRes.ok || isAbortMergeNoopResult(mergeAbortRes)) return { ok: true };
  const resetRes = await runGitSpawnAsync(ctx, repoRoot, ["reset", "--merge"], 120_000, envPatch);
  if (resetRes.ok || isResetMergeNoopResult(resetRes)) return { ok: true };
  return {
    ok: false,
    error: toGitErrorMessage(resetRes, "中止 Merge 失败"),
  };
}

/**
 * 执行进行中 Git 操作的 continue/abort，统一支持 rebase / merge / cherry-pick / revert。
 */
async function executeRepositoryOperationControlAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  control: "continue" | "abort",
): Promise<GitFeatureActionResult> {
  const operationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  if (operationState === "normal") {
    return {
      ok: false,
      error: "当前仓库没有可继续或中止的进行中 Git 操作",
    };
  }

  const operationLabel = getRepositoryOperationLabel(operationState);
  emitGitFeatureProgress(
    ctx,
    repoRoot,
    control === "continue" ? `正在继续 ${operationLabel}` : `正在中止 ${operationLabel}`,
    undefined,
  );

  const envPatch = buildOngoingOperationEnvPatch(operationState);
  let commandRes: GitExecResult | null = null;
  if (control === "continue") {
    if (operationState === "grafting") {
      const continueMode = await resolveGraftingContinueModeAsync(ctx, repoRoot);
      if (continueMode.mode === "complete-by-commit") {
        return await finalizeOngoingOperationSavedLocalChangesAsync(ctx, repoRoot, {
          ok: true,
          data: {
            shouldRefresh: true,
            operationState: "grafting",
            operation: operationState,
            control,
            completed: false,
            requiresCommitCompletion: true,
            operationSuggestedCommitMessage: continueMode.suggestedCommitMessage,
          },
        }, "grafting");
      }
      if (continueMode.mode === "skip-empty-cherry-pick") {
        return await finalizeOngoingOperationSavedLocalChangesAsync(
          ctx,
          repoRoot,
          await skipEmptyCherryPickAsync(ctx, repoRoot),
        );
      }
    }
    const argv = operationState === "rebasing"
      ? ["rebase", "--continue"]
      : operationState === "merging"
        ? ["merge", "--continue"]
        : operationState === "grafting"
          ? ["cherry-pick", "--continue"]
          : ["revert", "--continue"];
    commandRes = await runGitSpawnAsync(ctx, repoRoot, argv, 120_000, envPatch);
  } else if (operationState === "merging") {
    const abortRes = await abortMergeOperationAsync(ctx, repoRoot);
    if (!abortRes.ok) {
      commandRes = {
        ok: false,
        stdout: "",
        stderr: abortRes.error,
        error: abortRes.error,
        exitCode: 1,
      };
    } else {
      commandRes = {
        ok: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    }
  } else {
    const argv = operationState === "rebasing"
      ? ["rebase", "--abort"]
      : operationState === "grafting"
        ? ["cherry-pick", "--abort"]
        : ["revert", "--abort"];
    const res = await runGitSpawnAsync(ctx, repoRoot, argv, 120_000, envPatch);
    const isNoop = operationState === "rebasing"
      ? isAbortRebaseNoopResult(res)
      : operationState === "grafting"
        ? isAbortCherryPickNoopResult(res)
        : isAbortRevertNoopResult(res);
    commandRes = res.ok || isNoop
      ? {
          ok: true,
          stdout: String(res.stdout || ""),
          stderr: String(res.stderr || ""),
          error: "",
          exitCode: 0,
        }
      : res;
  }

  if (control === "continue" && operationState === "grafting" && commandRes && !commandRes.ok && isEmptyCherryPickResult(commandRes))
    return await finalizeOngoingOperationSavedLocalChangesAsync(
      ctx,
      repoRoot,
      await skipEmptyCherryPickAsync(ctx, repoRoot),
    );

  if (!commandRes?.ok)
    return await buildOperationControlFailureResultAsync(
      ctx,
      repoRoot,
      control,
      operationState,
      commandRes as GitExecResult,
    );

  const nextOperationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  return await finalizeOngoingOperationSavedLocalChangesAsync(ctx, repoRoot, {
    ok: true,
    data: {
      shouldRefresh: true,
      operationState: nextOperationState,
      operation: operationState,
      control,
      completed: nextOperationState === "normal",
    },
  }, nextOperationState);
}

/**
 * 把可能进入进行中状态的 Git 日志动作失败包装为统一结果；一旦仓库进入 rebase/merge/cherry-pick/revert，中断后会要求前端刷新并显示继续/中止入口。
 */
async function buildOperationAwareGitFailureResultAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  commandRes: GitExecResult,
  fallback: string,
): Promise<GitFeatureActionResult> {
  const error = toGitErrorMessage(commandRes, fallback);
  const operationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
  if (operationState === "normal") {
    return {
      ok: false,
      error,
    };
  }
  const mergeFailure = parseMergeFailure(commandRes);
  const operationProblem = mergeFailure.type === "CONFLICT"
    ? buildOngoingOperationConflictProblem(repoRoot, operationState)
    : null;
  return {
    ok: false,
    error,
    data: {
      shouldRefresh: true,
      operationState,
      operationProblem: operationProblem || undefined,
    },
  };
}

/**
 * 读取提交详情（支持单选与多选）。
 */
async function getCommitDetailsAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const hashes = Array.isArray(payload?.hashes) ? payload.hashes.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
  if (hashes.length === 0) return { ok: false, error: "缺少提交哈希" };

  if (hashes.length === 1) {
    try {
      const detail = await getSingleCommitDetailsWithCacheAsync(ctx, repoRoot, hashes[0]);
      return { ok: true, data: { mode: "single", detail } };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  const fileMap = new Map<string, { path: string; count: number; status?: string; oldPath?: string; hashes: string[] }>();
  for (const hash of hashes.slice(0, 50)) {
    const rows = await getCommitChangedFilesAsync(ctx, repoRoot, hash);
    for (const row of rows) {
      const key = String(row.path || "").trim();
      if (!key) continue;
      const hit = fileMap.get(key) || { path: key, count: 0, status: row.status || undefined, oldPath: row.oldPath || undefined, hashes: [] };
      hit.count += 1;
      hit.status = row.status || hit.status;
      hit.oldPath = row.oldPath || hit.oldPath;
      hit.hashes.push(hash);
      fileMap.set(key, hit);
    }
  }

  const files = Array.from(fileMap.values())
    .map((file) => ({
      path: file.path,
      count: file.count,
      status: file.status,
      oldPath: file.oldPath,
      hashes: Array.from(new Set(file.hashes)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    ok: true,
    data: {
      mode: "multiple",
      selectedCount: hashes.length,
      files,
    },
  };
}

/**
 * 构造 committed changes 右键动作所需运行时，统一复用主进程现有 Git 执行与错误适配能力。
 */
function createCommitDetailsRuntime(ctx: GitFeatureContext, repoRoot: string) {
  return {
    async runGitExecAsync(runtimeRepoRoot: string, argv: string[], timeoutMs: number, envPatch?: NodeJS.ProcessEnv) {
      return await runGitExecAsync(ctx, runtimeRepoRoot, argv, timeoutMs, envPatch);
    },
    async runGitSpawnAsync(runtimeRepoRoot: string, argv: string[], timeoutMs: number, envPatch?: NodeJS.ProcessEnv) {
      return await runGitSpawnAsync(ctx, runtimeRepoRoot, argv, timeoutMs, envPatch);
    },
    async getHeadFirstParentNodesAsync(runtimeRepoRoot: string) {
      return await getHeadFirstParentNodesAsync(ctx, runtimeRepoRoot);
    },
    async getRepositoryOperationStateAsync(runtimeRepoRoot: string) {
      return await getRepositoryOperationStateAsync(ctx, runtimeRepoRoot);
    },
    toGitErrorMessage,
    async writeTempFileAsync(prefix: string, content: string, options?: { fileNameHint?: string }) {
      return await writeTempGitFileAsync(ctx, prefix, content, options);
    },
  };
}

/**
 * 读取提交详情右键动作可用性，确保前端菜单与上游 `update` 语义一致。
 */
async function getCommitDetailsAvailabilityAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
): Promise<GitFeatureActionResult> {
  return {
    ok: true,
    data: await getCommitDetailsActionAvailabilityAsync(
      createCommitDetailsRuntime(ctx, repoRoot),
      repoRoot,
      payload || {},
    ),
  };
}

/**
 * 执行提交详情 committed changes 动作，并在历史改写前后保护当前工作区的本地改动。
 */
async function runCommitDetailsActionAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
): Promise<GitFeatureActionResult> {
  const action = String(payload?.action || "").trim();
  if (action === "openRepositoryVersion") {
    const openRes = await openCommitDetailsRepositoryVersionAsync(createCommitDetailsRuntime(ctx, repoRoot), repoRoot, payload || {});
    if (!openRes.ok) return { ok: false, error: openRes.error };
    return {
      ok: true,
      data: openRes.data,
    };
  }
  if (action === "revertSelectedChanges" || action === "applySelectedChanges") {
    const targetChangeListId = String(payload?.targetChangeListId || "").trim();
    const changedPaths = normalizeCommitPanelRepoPaths(
      repoRoot,
      (Array.isArray(payload?.selectedChanges) ? payload.selectedChanges : []).map((change: any) => change?.path),
    );
    if (targetChangeListId) {
      const changeListPlatformService = new ChangeListPlatformService({ userDataPath: ctx.userDataPath, repoRoot });
      const availability = changeListPlatformService.getOperationAvailability();
      if (!availability.operationsAllowed) {
        return { ok: false, error: availability.error || "当前仓库已禁用更改列表" };
      }
      const hasTargetChangeList = changeListPlatformService.getSnapshotState().repo.lists
        .some((item) => String(item.id || "").trim() === targetChangeListId);
      if (!hasTargetChangeList) {
        return { ok: false, error: "目标更改列表不存在" };
      }
    }
    const applyRes = await applyCommitDetailsSelectionPatchAsync(
      createCommitDetailsRuntime(ctx, repoRoot),
      repoRoot,
      action === "revertSelectedChanges" ? "revert" : "apply",
      payload || {},
    );
    let moveWarning = "";
    const moveChangedPathsToTargetAsync = async (): Promise<void> => {
      if (targetChangeListId && changedPaths.length > 0) {
        const moveRes = await moveCommitPanelFilesToChangeListAsync(
          ctx.userDataPath,
          repoRoot,
          changedPaths,
          targetChangeListId,
          {},
        );
        if (!moveRes.ok) moveWarning = String(moveRes.error || "移动到目标更改列表失败");
      }
    };
    if (!applyRes.ok) {
      const conflictRepoRoots = await hasUnmergedFilesAsync(ctx, repoRoot) ? [repoRoot] : undefined;
      if (conflictRepoRoots) {
        await moveChangedPathsToTargetAsync();
      }
      return {
        ok: false,
        error: applyRes.error,
        data: {
          conflictRepoRoots,
          targetChangeListId: targetChangeListId || undefined,
          moveWarning: moveWarning || undefined,
        },
      };
    }
    await moveChangedPathsToTargetAsync();
    return {
      ok: true,
      data: {
        shouldRefresh: true,
        targetChangeListId: targetChangeListId || undefined,
        moveWarning: moveWarning || undefined,
      },
    };
  }
  const isExtract = action === "extractSelectedChanges";
  const isDrop = action === "dropSelectedChanges";
  if (!isExtract && !isDrop) return { ok: false, error: `不支持的提交详情动作：${action}` };

  const mode = isExtract ? "extract" : "drop";
  const feedbackAction: GitHistoryRewriteAction = isExtract ? "extract-selected-changes" : "drop-selected-changes";
  const successTitle = isExtract ? "所选更改已提取" : "所选更改已删除";
  const successMessage = isExtract ? "已将所选更改提取到单独提交" : "已从目标提交中删除所选更改";
  const failureTitle = isExtract ? "提取所选更改失败" : "删除所选更改失败";

  const saveChangesPolicy = await resolveUpdateSaveChangesPolicyAsync(ctx, repoRoot, payload);
  let savedLocalChanges: GitSavedLocalChanges | null = null;
  if (await hasLocalChangesAsync(ctx, repoRoot)) {
    const saveRes = await saveLocalChangesForUpdateAsync(
      ctx,
      repoRoot,
      isExtract ? "extract selected changes" : "drop selected changes",
      saveChangesPolicy,
    );
    if (!saveRes.ok) {
      return buildHistoryRewriteFailure({
        action: feedbackAction,
        title: failureTitle,
        message: saveRes.error,
        completed: false,
      });
    }
    savedLocalChanges = saveRes.saved;
  }

  const finalizeRestoreFailure = (
    message: string,
    preservingState: GitUpdatePreservingState,
    completed: boolean,
  ): GitFeatureActionResult => {
    return completed
      ? buildHistoryRewriteSuccess({
        action: feedbackAction,
        title: successTitle,
        message,
        tone: "warn",
        shouldRefresh: true,
        completed: true,
        data: {
          shouldRefresh: true,
          completed: true,
          operationState: "normal",
          preservingState,
        },
      })
      : buildHistoryRewriteFailure({
        action: feedbackAction,
        title: failureTitle,
        message,
        tone: "warn",
        shouldRefresh: true,
        completed: false,
        data: {
          shouldRefresh: true,
          preservingState,
        },
      });
  };

  const rewriteRes = await runCommitDetailsHistoryRewriteAsync(
    createCommitDetailsRuntime(ctx, repoRoot),
    repoRoot,
    mode,
    payload || {},
  );

  if (!rewriteRes.ok) {
    if (savedLocalChanges) {
      const restoreRes = await restoreLocalChangesAfterUpdateAsync(ctx, repoRoot, savedLocalChanges);
      if (!restoreRes.ok) {
        return finalizeRestoreFailure(
          `${rewriteRes.error}；且本地改动未自动恢复，可在“已保存的更改”中继续处理`,
          restoreRes.preservingState,
          false,
        );
      }
    }
    return buildHistoryRewriteFailure({
      action: feedbackAction,
      title: failureTitle,
      message: rewriteRes.error,
      completed: false,
    });
  }

  if (savedLocalChanges) {
    const restoreRes = await restoreLocalChangesAfterUpdateAsync(ctx, repoRoot, savedLocalChanges);
    if (!restoreRes.ok) {
      return finalizeRestoreFailure(
        `${successMessage}，但本地改动未自动恢复，可在“已保存的更改”中继续处理`,
        restoreRes.preservingState,
        true,
      );
    }
    return buildHistoryRewriteSuccess({
      action: feedbackAction,
      title: successTitle,
      message: successMessage,
      shouldRefresh: true,
      completed: true,
      data: {
        shouldRefresh: true,
        completed: true,
        operationState: "normal",
        preservingState: restoreRes.preservingState,
      },
    });
  }

  return buildHistoryRewriteSuccess({
    action: feedbackAction,
    title: successTitle,
    message: successMessage,
    shouldRefresh: true,
    completed: true,
    data: {
      shouldRefresh: true,
      completed: true,
      operationState: "normal",
    },
  });
}

/**
 * 批量读取提交完整消息，保持输入顺序，供 reword/squash 初始文本生成使用。
 */
async function loadCommitMessagesAsync(ctx: GitFeatureContext, repoRoot: string, hashesInput: string[]): Promise<string[]> {
  const hashes = Array.from(new Set(
    (hashesInput || [])
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  ));
  const out: string[] = [];
  for (const hash of hashes) {
    const res = await runGitExecAsync(ctx, repoRoot, ["show", "-s", "--format=%B", hash], 12_000);
    if (!res.ok) continue;
    out.push(String(res.stdout || "").replace(/\s+$/, ""));
  }
  return out;
}

/**
 * 读取日志动作默认消息草稿，对齐上游的 reword/squash 初始编辑内容。
 */
async function getLogMessageDraftAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const action = String(payload?.action || "").trim() as "editMessage" | "squashCommits";
  const hashes = Array.isArray(payload?.hashes) ? payload.hashes.map((one: any) => String(one || "").trim()).filter(Boolean) : [];
  if (action !== "editMessage" && action !== "squashCommits") return { ok: false, error: "不支持的消息草稿动作" };
  if (hashes.length === 0) return { ok: false, error: "缺少提交哈希" };

  if (action === "editMessage") {
    const res = await runGitExecAsync(ctx, repoRoot, ["show", "-s", "--format=%B", hashes[0]], 12_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "读取提交消息失败") };
    return {
      ok: true,
      data: {
        action,
        message: String(res.stdout || "").replace(/\s+$/, ""),
      },
    };
  }

  const messages = await loadCommitMessagesAsync(ctx, repoRoot, hashes);
  return {
    ok: true,
    data: {
      action,
      message: buildPrettySquashMessage(messages),
    },
  };
}

/**
 * 读取 interactive rebase 对话框所需的提交列表快照，按 oldest -> newest 返回。
 */
async function getInteractiveRebasePlanActionAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
): Promise<GitFeatureActionResult> {
  const plan = await resolveInteractiveRebasePlanAsync(ctx, repoRoot, String(payload?.targetHash || payload?.hash || ""));
  if (plan.ok) return { ok: true, data: plan.data };
  return buildHistoryRewriteFailure({
    action: "interactive-rebase",
    title: "无法打开交互式变基",
    message: String(plan.error || "").trim() || "读取交互式变基计划失败",
    reasonCode: String(plan.data?.reasonCode || "").trim() || undefined,
    completed: false,
    data: plan.data,
  });
}

/**
 * 判断字符串是否为受支持的 interactive rebase action。
 */
function isInteractiveRebaseAction(value: string): value is GitInteractiveRebaseAction {
  return value === "pick" || value === "edit" || value === "reword" || value === "squash" || value === "fixup" || value === "drop";
}

/**
 * 执行 interactive rebase 计划，使用自定义 sequence/editor 脚本避免外部编辑器阻塞。
 */
async function runInteractiveRebasePlanActionAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  payload: any,
): Promise<GitFeatureActionResult> {
  const planResult = await resolveInteractiveRebasePlanAsync(ctx, repoRoot, String(payload?.targetHash || ""));
  if (!planResult.ok) {
    return buildHistoryRewriteFailure({
      action: "interactive-rebase",
      title: "无法执行交互式变基",
      message: String(planResult.error || "").trim() || "读取交互式变基计划失败",
      reasonCode: String(planResult.data?.reasonCode || "").trim() || undefined,
      completed: false,
      data: planResult.data,
    });
  }
  const plan = planResult.data;

  const expectedHeadHash = String(payload?.headHash || "").trim();
  if (expectedHeadHash && expectedHeadHash !== plan.headHash) {
    return buildHistoryRewriteFailure({
      action: "interactive-rebase",
      title: "交互式变基计划已失效",
      message: "提交历史已发生变化，请重新打开交互式变基对话框",
      reasonCode: "unexpected-hash",
      completed: false,
    });
  }

  const requestedEntries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (requestedEntries.length !== plan.entries.length) {
    return buildHistoryRewriteFailure({
      action: "interactive-rebase",
      title: "交互式变基计划已失效",
      message: "提交链已发生变化，请重新打开交互式变基对话框",
      reasonCode: "unresolved-hash",
      completed: false,
    });
  }

  const availableByHash = new Map(plan.entries.map((entry) => [entry.hash, entry] as const));
  const normalizedEntries: GitInteractiveRebasePlanEntry[] = [];
  const seenHashes = new Set<string>();
  for (const rawEntry of requestedEntries) {
    const hash = String(rawEntry?.hash || "").trim();
    if (!hash) {
      return buildHistoryRewriteFailure({
        action: "interactive-rebase",
        title: "交互式变基计划无效",
        message: "交互式变基计划包含空提交哈希",
        reasonCode: "unresolved-hash",
        completed: false,
      });
    }
    if (seenHashes.has(hash)) {
      return buildHistoryRewriteFailure({
        action: "interactive-rebase",
        title: "交互式变基计划无效",
        message: "交互式变基计划包含重复提交",
        reasonCode: "unexpected-hash",
        completed: false,
      });
    }
    seenHashes.add(hash);
    const source = availableByHash.get(hash);
    if (!source) {
      return buildHistoryRewriteFailure({
        action: "interactive-rebase",
        title: "交互式变基计划已失效",
        message: "提交链中存在无法解析的提交，请刷新日志后重试",
        reasonCode: "unresolved-hash",
        completed: false,
      });
    }
    const actionText = String(rawEntry?.action || "pick").trim();
    if (!isInteractiveRebaseAction(actionText)) {
      return buildHistoryRewriteFailure({
        action: "interactive-rebase",
        title: "交互式变基计划无效",
        message: `不支持的交互式变基动作：${actionText}`,
        completed: false,
      });
    }
    const messageText = typeof rawEntry?.message === "string" ? rawEntry.message : undefined;
    normalizedEntries.push({
      ...source,
      action: actionText,
      message: typeof messageText === "string" && messageText.trim() ? messageText : undefined,
    });
  }
  if (normalizedEntries.length !== plan.entries.length || seenHashes.size !== availableByHash.size) {
    return buildHistoryRewriteFailure({
      action: "interactive-rebase",
      title: "交互式变基计划已失效",
      message: "交互式变基计划已失效，请重新打开对话框",
      reasonCode: "unexpected-hash",
      completed: false,
    });
  }

  const validationError = validateInteractiveRebaseEntries(normalizedEntries);
  if (validationError) {
    return buildHistoryRewriteFailure({
      action: "interactive-rebase",
      title: "交互式变基计划无效",
      message: validationError,
      completed: false,
    });
  }

  const todoRows = normalizedEntries.map((entry) => {
    const subject = String(entry.subject || "").replace(/\r?\n/g, " ").trim() || "(无标题)";
    return `${entry.action} ${entry.hash} ${subject}`;
  });
  const queueItems: GitInteractiveRebaseEditorQueueItem[] = [];
  for (const entry of normalizedEntries) {
    if (entry.action === "reword") {
      const message = String(entry.message || "").trim() || String(entry.fullMessage || "").trim() || String(entry.subject || "").trim();
      queueItems.push({ message });
      continue;
    }
    if (entry.action === "squash") {
      const override = String(entry.message || "").trim();
      queueItems.push(override ? { message: override } : { useDefault: true });
    }
  }

  let artifacts: GitInteractiveRebaseEditorArtifacts | null = null;
  try {
    artifacts = await createGitInteractiveRebaseEditorArtifactsAsync(ctx, todoRows, queueItems);
    const envPatch: NodeJS.ProcessEnv = {
      CODEXFLOW_GIT_REBASE_TODO_FILE: artifacts.todoFilePath,
      CODEXFLOW_GIT_REBASE_QUEUE_FILE: artifacts.queueFilePath,
      CODEXFLOW_GIT_REBASE_QUEUE_STATE_FILE: artifacts.queueStateFilePath,
      GIT_SEQUENCE_EDITOR: toGitEditorCommand(process.execPath, artifacts.sequenceEditorScriptPath),
      GIT_EDITOR: toGitEditorCommand(process.execPath, artifacts.commitEditorScriptPath),
    };
    const argv = plan.rootMode
      ? ["rebase", "-i", "--root", "--no-autosquash"]
      : ["rebase", "-i", "--no-autosquash", String(plan.baseHash || "")];
    const rebaseRes = await runGitSpawnAsync(ctx, repoRoot, argv, 300_000, envPatch);
    if (!rebaseRes.ok) {
      const failure = await buildOperationAwareGitFailureResultAsync(ctx, repoRoot, rebaseRes, "执行交互式变基失败");
      const operationState = String(failure.data?.operationState || "").trim() as GitRepositoryOperationState;
      if (operationState && operationState !== "normal") {
        return buildHistoryRewriteFailure({
          action: "interactive-rebase",
          title: "交互式变基未完成",
          message: "仓库已进入进行中状态，请先处理当前步骤后继续或中止交互式变基",
          tone: "warn",
          operationState,
          shouldRefresh: true,
          completed: false,
          data: failure.data,
        });
      }
      return buildHistoryRewriteFailure({
        action: "interactive-rebase",
        title: "执行交互式变基失败",
        message: String(failure.error || "").trim() || "执行交互式变基失败",
        completed: false,
        data: failure.data,
      });
    }
    const operationState = await getRepositoryOperationStateAsync(ctx, repoRoot);
    return buildHistoryRewriteSuccess({
      action: "interactive-rebase",
      title: operationState === "normal" ? "交互式变基已完成" : "交互式变基已暂停",
      message: operationState === "normal"
        ? "已按当前计划改写提交历史"
        : "当前仓库仍处于进行中状态，可继续处理后续步骤或直接中止",
      tone: operationState === "normal" ? "info" : "warn",
      operationState,
      shouldRefresh: true,
      completed: operationState === "normal",
      data: {
        shouldRefresh: true,
        operationState,
        completed: operationState === "normal",
      },
    });
  } finally {
    if (artifacts?.dirPath) await removePathIfExistsAsync(artifacts.dirPath);
  }
}

/**
 * 将 remote URL 规整为可在浏览器访问的仓库地址。
 */
function normalizeRemoteWebUrl(remoteUrl: string): string {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\.git$/i, "");
  const sshMatch = raw.match(/^git@([^:]+):(.+)$/i);
  if (sshMatch) {
    const host = String(sshMatch[1] || "").trim();
    const repoPath = String(sshMatch[2] || "").trim().replace(/\.git$/i, "");
    if (!host || !repoPath) return "";
    return `https://${host}/${repoPath}`;
  }
  return "";
}

/**
 * 根据仓库地址生成提交浏览器链接（尽量兼容常见托管平台）。
 */
function buildCommitWebUrl(remoteWebUrl: string, hash: string): string {
  const base = String(remoteWebUrl || "").replace(/\/+$/, "");
  const commit = String(hash || "").trim();
  if (!base || !commit) return "";
  if (base.includes("gitlab")) return `${base}/-/commit/${commit}`;
  if (base.includes("bitbucket")) return `${base}/commits/${commit}`;
  return `${base}/commit/${commit}`;
}

/**
 * 读取默认远程仓库 Web 地址（优先 origin）。
 */
async function getDefaultRemoteWebUrlAsync(ctx: GitFeatureContext, repoRoot: string): Promise<string> {
  const remoteNamesRes = await runGitExecAsync(ctx, repoRoot, ["remote"], 10_000);
  if (!remoteNamesRes.ok) return "";
  const names = String(remoteNamesRes.stdout || "").split(/\r?\n/).map((one) => String(one || "").trim()).filter(Boolean);
  const remote = names.find((one) => one === "origin") || names[0] || "";
  if (!remote) return "";
  const urlRes = await runGitExecAsync(ctx, repoRoot, ["remote", "get-url", remote], 10_000);
  if (!urlRes.ok) return "";
  return normalizeRemoteWebUrl(String(urlRes.stdout || "").trim());
}

/**
 * 读取默认远程仓库提交链接。
 */
async function getCommitWebUrlAsync(ctx: GitFeatureContext, repoRoot: string, hash: string): Promise<string> {
  const web = await getDefaultRemoteWebUrlAsync(ctx, repoRoot);
  return buildCommitWebUrl(web, hash);
}

/**
 * 构造“交互式变基”所需的应用内终端启动参数。
 */
async function createInteractiveRebaseTerminalPlanAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  hashInput: string,
): Promise<{ ok: true; data: GitTerminalInteraction } | { ok: false; error: string }> {
  const requestedHash = String(hashInput || "").trim();
  if (!requestedHash) return { ok: false, error: "缺少提交哈希" };

  const commitRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "--verify", `${requestedHash}^{commit}`], 10_000);
  if (!commitRes.ok) return { ok: false, error: toGitErrorMessage(commitRes, "读取提交信息失败") };
  const commitHash = String(commitRes.stdout || "").trim() || requestedHash;

  const parentRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", `${commitHash}^`], 10_000);
  const hasParent = parentRes.ok && !!String(parentRes.stdout || "").trim();
  const startupCmd = hasParent ? `git rebase -i ${commitHash}^` : "git rebase -i --root";
  const title = hasParent ? `Git Rebase -i ${commitHash.slice(0, 8)}` : "Git Rebase -i --root";

  return {
    ok: true,
    data: {
      title,
      startupCmd,
      hint: "已在应用内终端启动交互式变基；完成后请返回 Git 面板刷新状态。",
    },
  };
}

/**
 * 执行日志右键动作（checkout/reset/revert/cherry-pick 等）。
 */
async function runLogActionAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const action = String(payload?.action || "").trim();
  const hash = String(payload?.hash || "").trim();
  const hashes = Array.isArray(payload?.hashes) ? payload.hashes.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
  const paths = Array.isArray(payload?.paths) ? payload.paths.map((one: any) => String(one || "").trim().replace(/\\/g, "/")).filter(Boolean) : [];

  if (action === "createPatch") {
    const selected: string[] = Array.from(new Set((hashes.length > 0 ? hashes : (hash ? [hash] : ["HEAD"])).filter(Boolean)));
    if (selected.length === 0) return { ok: false, error: "缺少提交哈希" };
    const ordered: string[] = selected.length > 1 ? [...selected].reverse() : selected;
    const patchChunks: string[] = [];
    for (const oneHash of ordered) {
      const argv = ["show", "--pretty=format:", oneHash];
      if (paths.length > 0) argv.push("--", ...paths);
      const res = await runGitExecAsync(ctx, repoRoot, argv, 60_000);
      if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "创建补丁失败") };
      const patchText = String(res.stdout || "");
      if (patchText.trim()) patchChunks.push(patchText);
    }
    return { ok: true, data: { patch: patchChunks.join("\n") } };
  }
  if (action === "openInBrowser") {
    const target = hash || "";
    if (!target) return { ok: false, error: "缺少提交哈希" };
    const url = await getCommitWebUrlAsync(ctx, repoRoot, target);
    if (!url) return { ok: false, error: "未能解析远程仓库提交链接" };
    return { ok: true, data: { url } };
  }
  if (action === "checkout") return await switchRefAsync(ctx, repoRoot, hash);
  if (action === "newBranch") {
    const name = String(payload?.name || "").trim();
    if (!name) return { ok: false, error: "分支名不能为空" };
    const res = await runGitSpawnAsync(ctx, repoRoot, ["switch", "-c", name, hash || "HEAD"], 120_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "新建分支失败") };
    return { ok: true };
  }
  if (action === "newTag") {
    return await createTagAtRevisionAsync(ctx, repoRoot, String(payload?.name || ""), hash || "HEAD", "新建标签失败");
  }
  if (action === "reset") {
    const mode = String(payload?.mode || "mixed").trim();
    const target = hash || "HEAD";
    const flag = mode === "soft" ? "--soft" : mode === "hard" ? "--hard" : "--mixed";
    const res = await runGitSpawnAsync(ctx, repoRoot, ["reset", flag, target], 120_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "重置失败") };
    return { ok: true };
  }
  if (action === "revert") {
    const sourceList: string[] = hashes.length > 0 ? hashes : (hash ? [hash] : []);
    const list = Array.from(new Set(
      sourceList
        .map((one: string) => String(one || "").trim())
        .filter(Boolean),
    ));
    if (list.length === 0) return { ok: false, error: "缺少提交哈希" };
    const res = await runGitSpawnAsync(ctx, repoRoot, ["revert", ...list], 180_000);
    if (!res.ok) return await buildOperationAwareGitFailureResultAsync(ctx, repoRoot, res, "还原提交失败");
    return { ok: true };
  }
  if (action === "cherryPick") {
    const sourceList: string[] = hashes.length > 0 ? hashes : (hash ? [hash] : []);
    const list = Array.from(new Set(
      sourceList
        .map((one: string) => String(one || "").trim())
        .filter(Boolean),
    ));
    if (list.length === 0) return { ok: false, error: "缺少提交哈希" };
    if (payload?.autoSaveLocalChanges === true) {
      return await runLogApplyChangesWithPreservedLocalChangesAsync(ctx, repoRoot, "cherryPick", list, payload || {});
    }
    const preflightProblem = await detectCherryPickPreflightOperationProblemAsync(ctx, repoRoot, list, payload);
    if (preflightProblem) {
      return {
        ok: false,
        error: "优选失败",
        data: {
          operationProblem: preflightProblem,
        },
      };
    }
    const res = await runGitSpawnAsync(ctx, repoRoot, ["cherry-pick", "-x", ...list], 180_000);
    if (!res.ok) {
      if (isEmptyCherryPickResult(res))
        return await skipEmptyCherryPickAsync(ctx, repoRoot);
      const operationProblem = await buildLogApplyChangesOperationProblemAsync(ctx, repoRoot, "cherryPick", list, res, payload);
      if (operationProblem) {
        return {
          ok: false,
          error: toGitErrorMessage(res, "摘取提交失败"),
          data: {
            operationProblem,
          },
        };
      }
      return await buildOperationAwareGitFailureResultAsync(ctx, repoRoot, res, "摘取提交失败");
    }
    return { ok: true };
  }
  if (action === "fixup" || action === "squashTo") {
    const target = hash || "";
    if (!target) return { ok: false, error: "缺少提交哈希" };
    const commitPayload = {
      ...((payload?.commitPayload && typeof payload.commitPayload === "object") ? payload.commitPayload : payload),
      commitMode: action === "fixup" ? "fixup" : "squash",
      targetHash: target,
    };
    const commitRes = await commitSelectedFilesAsync(ctx, repoRoot, commitPayload);
    if (commitRes.ok) return commitRes;
    const errorText = String(commitRes.error || "").trim();
    if (errorText === "未选择需要提交的变更") {
      return { ok: false, error: "nothing to commit" };
    }
    return commitRes;
  }
  if (action === "squashCommits") {
    const sourceList: string[] = hashes.length > 0 ? hashes : (hash ? [hash] : []);
    const list: string[] = Array.from(new Set(
      sourceList
        .map((one: string) => String(one || "").trim())
        .filter(Boolean),
    ));
    if (list.length < 2) return { ok: false, error: "至少选择 2 个提交" };
    if (await hasLocalChangesAsync(ctx, repoRoot)) {
      return { ok: false, error: "存在本地改动，请先提交或搁置后再执行该操作" };
    }
    const headRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 10_000);
    if (!headRes.ok || !String(headRes.stdout || "").trim()) return { ok: false, error: toGitErrorMessage(headRes, "读取 HEAD 失败") };
    const branchRes = await runGitExecAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 10_000);
    if (!branchRes.ok || !String(branchRes.stdout || "").trim()) return { ok: false, error: "当前处于 Detached HEAD，无法执行该操作" };
    const headNodes = await getHeadFirstParentNodesAsync(ctx, repoRoot);
    const chain = headNodes.map((one) => one.hash);
    if (chain.length === 0) return { ok: false, error: "读取提交链失败" };
    const indexMap = new Map<string, number>();
    chain.forEach((one, idx) => indexMap.set(one, idx));
    const indexes: number[] = [];
    for (const one of list) {
      const idx = indexMap.get(one);
      if (typeof idx !== "number") return { ok: false, error: "提交不在当前 HEAD 历史线上" };
      indexes.push(idx);
    }
    const uniqueIndexes = Array.from(new Set(indexes));
    if (uniqueIndexes.length !== list.length) return { ok: false, error: "提交列表包含重复项" };
    const minIndex = Math.min(...uniqueIndexes);
    const maxIndex = Math.max(...uniqueIndexes);
    if (maxIndex - minIndex + 1 !== uniqueIndexes.length) return { ok: false, error: "仅支持连续提交范围" };
    if (uniqueIndexes.some((idx) => (headNodes[idx]?.parentCount || 0) === 0)) {
      return { ok: false, error: "根提交不支持该操作" };
    }
    if (headNodes.slice(0, maxIndex + 1).some((one) => one.parentCount !== 1)) {
      return { ok: false, error: "提交路径包含合并或根提交，当前操作仅支持线性历史" };
    }
    const newest = chain[minIndex];
    const oldest = chain[maxIndex];
    if (!newest || !oldest) return { ok: false, error: "读取提交链失败" };
    const parentRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", `${oldest}^`], 10_000);
    if (!parentRes.ok) return { ok: false, error: toGitErrorMessage(parentRes, "读取父提交失败") };
    const parentHash = String(parentRes.stdout || "").trim();
    if (!parentHash) return { ok: false, error: "根提交不支持该操作" };
    let message = String(payload?.message || "").trim();
    if (!message) {
      const messages = await loadCommitMessagesAsync(ctx, repoRoot, list);
      message = buildPrettySquashMessage(messages);
    }
    if (!message) message = "squash commits";
    const resetRes = await runGitSpawnAsync(ctx, repoRoot, ["reset", "--hard", parentHash], 120_000);
    if (!resetRes.ok) return { ok: false, error: toGitErrorMessage(resetRes, "压缩提交失败（reset）") };
    const pickRangeRes = await runGitSpawnAsync(ctx, repoRoot, ["cherry-pick", "--no-commit", `${oldest}^..${newest}`], 300_000);
    if (!pickRangeRes.ok) {
      void runGitSpawnAsync(ctx, repoRoot, ["cherry-pick", "--abort"], 30_000);
      return { ok: false, error: toGitErrorMessage(pickRangeRes, "压缩提交失败（cherry-pick）") };
    }
    const commitRes = await runGitSpawnAsync(ctx, repoRoot, ["commit", "-m", message], 120_000);
    if (!commitRes.ok) return { ok: false, error: toGitErrorMessage(commitRes, "压缩提交失败（commit）") };
    if (minIndex > 0) {
      const replayHashes: string[] = [];
      for (let idx = minIndex - 1; idx >= 0; idx -= 1) {
        const replayHash = chain[idx];
        if (replayHash) replayHashes.push(replayHash);
      }
      if (replayHashes.length > 0) {
        const replayRes = await runGitSpawnAsync(ctx, repoRoot, ["cherry-pick", ...replayHashes], 300_000);
        if (!replayRes.ok) {
          void runGitSpawnAsync(ctx, repoRoot, ["cherry-pick", "--abort"], 30_000);
          return { ok: false, error: toGitErrorMessage(replayRes, "压缩提交失败（重放后续提交）") };
        }
      }
    }
    return { ok: true };
  }
  if (action === "interactiveRebase") {
    const plan = await createInteractiveRebaseTerminalPlanAsync(ctx, repoRoot, hash || "");
    if (!plan.ok) return plan;
    return {
      ok: true,
      data: {
        terminalInteraction: plan.data,
      },
    };
  }
  if (action === "undoCommit") {
    const target = hash || "";
    if (!target) return { ok: false, error: "缺少提交哈希" };
    const headRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 10_000);
    if (!headRes.ok) return { ok: false, error: toGitErrorMessage(headRes, "读取 HEAD 失败") };
    const headHash = String(headRes.stdout || "").trim();
    if (headHash !== target) return { ok: false, error: "仅支持撤消当前 HEAD 提交" };

    const parentRes = await runGitExecAsync(ctx, repoRoot, ["rev-list", "--parents", "-n", "1", target], 10_000);
    if (!parentRes.ok) return { ok: false, error: toGitErrorMessage(parentRes, "读取提交父节点失败") };
    const parentRow = String(parentRes.stdout || "").trim().split(/\s+/).filter(Boolean);
    const parentHashes = parentRow.slice(1);
    if (parentHashes.length <= 0) return { ok: false, error: "首个提交不支持撤消提交" };
    if (parentHashes.length > 1) return { ok: false, error: "合并提交不支持撤消提交" };

    const targetChangeListId = String(payload?.targetChangeListId || "").trim();
    if (targetChangeListId) {
      const changeListPlatformService = new ChangeListPlatformService({ userDataPath: ctx.userDataPath, repoRoot });
      const availability = changeListPlatformService.getOperationAvailability();
      if (!availability.operationsAllowed) {
        return { ok: false, error: availability.error || "当前仓库已禁用更改列表" };
      }
      const hasTargetChangeList = changeListPlatformService.getSnapshotState().repo.lists
        .some((item) => String(item.id || "").trim() === targetChangeListId);
      if (!hasTargetChangeList) {
        return { ok: false, error: "目标更改列表不存在" };
      }
    }

    const messageRes = await runGitExecAsync(ctx, repoRoot, ["log", "-1", "--format=%B", target], 10_000);
    const restoredCommitMessage = messageRes.ok
      ? String(messageRes.stdout || "").replace(/\s+$/, "")
      : "";

    let changedPaths: string[] = [];
    let moveWarning = "";
    if (targetChangeListId) {
      const changedPathsRes = await runGitExecAsync(ctx, repoRoot, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", target], 10_000);
      if (changedPathsRes.ok) {
        changedPaths = normalizeCommitPanelRepoPaths(repoRoot, String(changedPathsRes.stdout || "").split(/\r?\n/));
      } else {
        moveWarning = toGitErrorMessage(changedPathsRes, "读取撤消提交涉及的文件失败");
      }
    }

    const res = await runGitSpawnAsync(ctx, repoRoot, ["reset", "--soft", `${target}^`], 120_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "撤消提交失败") };

    if (targetChangeListId && changedPaths.length > 0) {
      const moveRes = await moveCommitPanelFilesToChangeListAsync(
        ctx.userDataPath,
        repoRoot,
        changedPaths,
        targetChangeListId,
        {},
      );
      if (!moveRes.ok) moveWarning = String(moveRes.error || "移动到目标更改列表失败");
    }

    return {
      ok: true,
      data: {
        restoredCommitMessage: restoredCommitMessage || undefined,
        targetChangeListId: targetChangeListId || undefined,
        moveWarning: moveWarning || undefined,
      },
    };
  }
  if (action === "deleteCommitUndo") {
    return await undoDeleteCommitAsync(ctx, repoRoot, payload);
  }
  if (action === "editMessage") {
    const target = hash || "";
    const message = String(payload?.message || "").trim();
    if (!target) {
      return buildHistoryRewriteFailure({
        action: "edit-message",
        title: "无法编辑提交消息",
        message: "缺少提交哈希",
        completed: false,
      });
    }
    if (!message) {
      return buildHistoryRewriteFailure({
        action: "edit-message",
        title: "无法编辑提交消息",
        message: "提交信息不能为空",
        completed: false,
      });
    }
    const branchRes = await runGitExecAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 10_000);
    const currentBranch = branchRes.ok ? String(branchRes.stdout || "").trim() : "";
    if (!currentBranch) {
      return buildHistoryRewriteFailure({
        action: "edit-message",
        title: "无法编辑提交消息",
        message: "当前处于 Detached HEAD，无法执行该操作",
        reasonCode: "detached-head",
        completed: false,
      });
    }
    const headRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 10_000);
    if (!headRes.ok) {
      return buildHistoryRewriteFailure({
        action: "edit-message",
        title: "无法编辑提交消息",
        message: toGitErrorMessage(headRes, "读取 HEAD 失败"),
        completed: false,
      });
    }
    const headHash = String(headRes.stdout || "").trim();
    if (!headHash) {
      return buildHistoryRewriteFailure({
        action: "edit-message",
        title: "无法编辑提交消息",
        message: "读取 HEAD 失败",
        completed: false,
      });
    }
    const isInHead = await checkIsAncestorAsync(ctx, repoRoot, target, headHash);
    if (!isInHead) {
      return buildHistoryRewriteFailure({
        action: "edit-message",
        title: "无法编辑提交消息",
        message: "提交不在当前 HEAD 历史线上",
        completed: false,
      });
    }

    const parentMap = await loadCommitParentMapAsync(ctx, repoRoot, [target]);
    const targetParents = parentMap.get(target) || [];
    if (targetParents.length > 1 && target !== headHash) {
      return buildHistoryRewriteFailure({
        action: "edit-message",
        title: "无法编辑提交消息",
        message: "合并提交不支持该操作",
        completed: false,
      });
    }

    if (target === headHash) {
      const amendRes = await runGitSpawnAsync(ctx, repoRoot, ["commit", "--amend", "--only", "--no-verify", "-m", message], 120_000);
      if (!amendRes.ok) {
        return buildHistoryRewriteFailure({
          action: "edit-message",
          title: "编辑提交消息失败",
          message: toGitErrorMessage(amendRes, "编辑提交消息失败"),
          completed: false,
        });
      }
      return buildHistoryRewriteSuccess({
        action: "edit-message",
        title: "提交消息已更新",
        message: "已修改当前 HEAD 提交的消息",
        shouldRefresh: true,
        completed: true,
        data: {
          shouldRefresh: true,
          completed: true,
          operationState: "normal",
        },
      });
    }

    if (await hasLocalChangesAsync(ctx, repoRoot)) {
      return buildHistoryRewriteFailure({
        action: "edit-message",
        title: "无法编辑提交消息",
        message: "存在本地改动，请先提交或搁置后再执行该操作",
        completed: false,
      });
    }
    let artifacts: GitRewordEditorArtifacts | null = null;
    try {
      artifacts = await createGitRewordEditorArtifactsAsync(ctx, message, target);
      const envPatch: NodeJS.ProcessEnv = {
        GIT_SEQUENCE_EDITOR: toGitEditorCommand(process.execPath, artifacts.sequenceEditorScriptPath),
        GIT_EDITOR: toGitEditorCommand(process.execPath, artifacts.commitEditorScriptPath),
        GIT_REWORD_TARGET: artifacts.targetPrefix,
        GIT_REWORD_MESSAGE_FILE: artifacts.messageFilePath,
      };
      const baseArgv = targetParents.length === 0 ? ["rebase", "-i", "--root"] : ["rebase", "-i", `${target}^`];
      const rebaseRes = await runGitSpawnAsync(ctx, repoRoot, baseArgv, 300_000, envPatch);
      if (!rebaseRes.ok) {
        const failure = await buildOperationAwareGitFailureResultAsync(ctx, repoRoot, rebaseRes, "编辑提交消息失败");
        const operationState = String(failure.data?.operationState || "").trim() as GitRepositoryOperationState;
        if (operationState && operationState !== "normal") {
          return buildHistoryRewriteFailure({
            action: "edit-message",
            title: "提交消息改写未完成",
            message: "仓库已进入 rebase 状态，请先处理冲突后继续或中止当前改写",
            tone: "warn",
            operationState,
            shouldRefresh: true,
            completed: false,
            data: failure.data,
          });
        }
        return buildHistoryRewriteFailure({
          action: "edit-message",
          title: "编辑提交消息失败",
          message: String(failure.error || "").trim() || "编辑提交消息失败",
          completed: false,
          data: failure.data,
        });
      }
    } finally {
      if (artifacts?.dirPath) await removePathIfExistsAsync(artifacts.dirPath);
    }
    return buildHistoryRewriteSuccess({
      action: "edit-message",
      title: "提交消息已更新",
      message: "已改写目标提交的消息",
      shouldRefresh: true,
      completed: true,
      data: {
        shouldRefresh: true,
        completed: true,
        operationState: "normal",
      },
    });
  }
  if (action === "deleteCommit") {
    const sourceList: string[] = hashes.length > 0 ? hashes : (hash ? [hash] : []);
    const list = Array.from(new Set(
      sourceList
        .map((one: string) => String(one || "").trim())
        .filter(Boolean),
    ));
    if (list.length === 0) {
      return buildHistoryRewriteFailure({
        action: "delete-commit",
        title: "无法删除提交",
        message: "缺少提交哈希",
        completed: false,
      });
    }
    const deletedSubjects = await listCommitSubjectsAsync(ctx, repoRoot, list);
    const detailLines = buildDeletedCommitDetailLines(deletedSubjects, list.length);
    const headRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 10_000);
    if (!headRes.ok) {
      return buildHistoryRewriteFailure({
        action: "delete-commit",
        title: "无法删除提交",
        message: toGitErrorMessage(headRes, "读取 HEAD 失败"),
        completed: false,
      });
    }
    const headHash = String(headRes.stdout || "").trim();
    if (!headHash) {
      return buildHistoryRewriteFailure({
        action: "delete-commit",
        title: "无法删除提交",
        message: "读取 HEAD 失败",
        completed: false,
      });
    }
    const saveChangesPolicy = await resolveUpdateSaveChangesPolicyAsync(ctx, repoRoot, payload);
    let savedLocalChanges: GitSavedLocalChanges | null = null;
    if (await hasLocalChangesAsync(ctx, repoRoot)) {
      const saveRes = await saveLocalChangesForUpdateAsync(ctx, repoRoot, `log ${action}`, saveChangesPolicy);
      if (!saveRes.ok) {
        return buildHistoryRewriteFailure({
          action: "delete-commit",
          title: "无法删除提交",
          message: String(saveRes.error || "保存本地改动失败").trim() || "保存本地改动失败",
          completed: false,
        });
      }
      savedLocalChanges = saveRes.saved;
    }
    const headNodes = await getHeadFirstParentNodesAsync(ctx, repoRoot);
    const chain = headNodes.map((one) => one.hash);
    if (chain.length === 0) {
      return await finalizeDeleteCommitFailureAsync({
        ctx,
        repoRoot,
        title: "无法删除提交",
        message: "读取提交链失败",
        completed: false,
        savedLocalChanges,
      });
    }
    const branchRes = await runGitExecAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 10_000);
    if (!branchRes.ok || !String(branchRes.stdout || "").trim()) {
      return await finalizeDeleteCommitFailureAsync({
        ctx,
        repoRoot,
        title: "无法删除提交",
        message: "当前处于 Detached HEAD，无法执行该操作",
        reasonCode: "detached-head",
        completed: false,
        savedLocalChanges,
      });
    }
    const indexMap = new Map<string, number>();
    chain.forEach((one, idx) => indexMap.set(one, idx));
    const indexes: number[] = [];
    for (const one of list) {
      const idx = indexMap.get(one);
      if (typeof idx !== "number") {
        return await finalizeDeleteCommitFailureAsync({
          ctx,
          repoRoot,
          title: "无法删除提交",
          message: "提交不在当前 HEAD 历史线上",
          completed: false,
          savedLocalChanges,
        });
      }
      indexes.push(idx);
    }
    if (indexes.some((idx) => (headNodes[idx]?.parentCount || 0) === 0)) {
      return await finalizeDeleteCommitFailureAsync({
        ctx,
        repoRoot,
        title: "无法删除提交",
        message: "根提交不支持该操作",
        completed: false,
        savedLocalChanges,
      });
    }
    const maxSelectedIndex = Math.max(...indexes);
    if (headNodes.slice(0, maxSelectedIndex + 1).some((one) => one.parentCount !== 1)) {
      return await finalizeDeleteCommitFailureAsync({
        ctx,
        repoRoot,
        title: "无法删除提交",
        message: "提交路径包含合并或根提交，当前操作仅支持线性历史",
        completed: false,
        savedLocalChanges,
      });
    }
    const ranges = buildContiguousIndexRanges(indexes);
    if (ranges.length <= 0) {
      return await finalizeDeleteCommitFailureAsync({
        ctx,
        repoRoot,
        title: "无法删除提交",
        message: "未找到可删除提交",
        completed: false,
        savedLocalChanges,
      });
    }
    for (const range of ranges) {
      const newest = chain[range.start];
      const oldest = chain[range.end];
      if (!newest || !oldest) {
        return await finalizeDeleteCommitFailureAsync({
          ctx,
          repoRoot,
          title: "无法删除提交",
          message: "读取提交链失败",
          completed: false,
          savedLocalChanges,
        });
      }
      const parentRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", `${oldest}^`], 10_000);
      if (!parentRes.ok) {
        return await finalizeDeleteCommitFailureAsync({
          ctx,
          repoRoot,
          title: "无法删除提交",
          message: toGitErrorMessage(parentRes, "读取父提交失败"),
          completed: false,
          savedLocalChanges,
        });
      }
      const parentHash = String(parentRes.stdout || "").trim();
      if (!parentHash) {
        return await finalizeDeleteCommitFailureAsync({
          ctx,
          repoRoot,
          title: "无法删除提交",
          message: "根提交不支持该操作",
          completed: false,
          savedLocalChanges,
        });
      }
      if (range.start === 0) {
        const resetRes = await runGitSpawnAsync(ctx, repoRoot, ["reset", "--hard", parentHash], 120_000);
        if (!resetRes.ok) {
          return await finalizeDeleteCommitFailureAsync({
            ctx,
            repoRoot,
            title: "删除提交失败",
            message: toGitErrorMessage(resetRes, "删除提交失败"),
            completed: false,
            savedLocalChanges,
          });
        }
      } else {
        const rebaseRes = await runGitSpawnAsync(ctx, repoRoot, ["rebase", "--onto", parentHash, newest], 300_000);
        if (!rebaseRes.ok) {
          const failure = await buildOperationAwareGitFailureResultAsync(ctx, repoRoot, rebaseRes, "删除提交失败");
          const operationState = String(failure.data?.operationState || "").trim() as GitRepositoryOperationState;
          if (operationState && operationState !== "normal") {
            return await finalizeDeleteCommitFailureAsync({
              ctx,
              repoRoot,
              title: "删除提交未完成",
              message: "仓库已进入 rebase 状态，请先处理冲突后继续或中止当前改写",
              tone: "warn",
              operationState,
              shouldRefresh: true,
              completed: false,
              savedLocalChanges,
              data: failure.data,
            });
          }
          return await finalizeDeleteCommitFailureAsync({
            ctx,
            repoRoot,
            title: "删除提交失败",
            message: String(failure.error || "").trim() || "删除提交失败",
            completed: false,
            savedLocalChanges,
            data: failure.data,
          });
        }
      }
    }
    const newHeadRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 10_000);
    if (!newHeadRes.ok) {
      return await finalizeDeleteCommitFailureAsync({
        ctx,
        repoRoot,
        title: "删除提交失败",
        message: toGitErrorMessage(newHeadRes, "读取改写后的 HEAD 失败"),
        completed: false,
        savedLocalChanges,
      });
    }
    const newHead = String(newHeadRes.stdout || "").trim();
    const undo = newHead
      ? {
          label: "撤销",
          payload: {
            kind: "delete-commit" as const,
            repoRoot,
            oldHead: headHash,
            newHead,
          },
        }
      : undefined;
    if (savedLocalChanges) {
      const restoreRes = await restoreLocalChangesAfterUpdateAsync(ctx, repoRoot, savedLocalChanges);
      if (!restoreRes.ok) {
        return buildHistoryRewriteFailure({
          action: "delete-commit",
          title: `已删除 ${list.length} 个提交`,
          message: String(restoreRes.preservingState?.message || restoreRes.error || "已删除目标提交，但本地改动未自动恢复").trim() || "已删除目标提交，但本地改动未自动恢复",
          detailLines,
          undo,
          tone: "warn",
          shouldRefresh: true,
          completed: true,
          data: {
            shouldRefresh: true,
            completed: true,
            operationState: "normal",
            preservingState: restoreRes.preservingState,
          },
        });
      }
    }
    return buildHistoryRewriteSuccess({
      action: "delete-commit",
      title: `已删除 ${list.length} 个提交`,
      message: "已改写当前分支历史并移除目标提交",
      detailLines,
      undo,
      shouldRefresh: true,
      completed: true,
      data: {
        shouldRefresh: true,
        completed: true,
        operationState: "normal",
      },
    });
  }
  if (action === "pushAllPrevious") {
    const res = await runGitSpawnAsync(ctx, repoRoot, ["push"], 300_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "推送失败") };
    return { ok: true };
  }
  if (action === "push") {
    const res = await runGitSpawnAsync(ctx, repoRoot, ["push"], 300_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "推送失败") };
    return { ok: true };
  }
  return { ok: false, error: `不支持的日志动作：${action}` };
}

/**
 * 读取 stash 列表。
 */
async function getStashListAsync(ctx: GitFeatureContext, repoRoot: string): Promise<GitFeatureActionResult> {
  const res = await runGitExecAsync(
    ctx,
    repoRoot,
    ["stash", "list", "--date=iso-strict", "--pretty=format:%gd%x00%H%x00%cd%x00%s%x1e"],
    10_000,
  );
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "读取暂存列表失败") };
  const rows = String(res.stdout || "").split("\x1e").map((x) => x.trim()).filter(Boolean);
  const items = rows.map((row) => {
    const seg = row.split("\x00");
    return {
      ref: String(seg[0] || "").trim(),
      hash: String(seg[1] || "").trim(),
      date: String(seg[2] || "").trim(),
      message: decodeGitEscapedText(String(seg[3] || "").trim()),
    };
  }).filter((x) => x.ref);
  return { ok: true, data: { items } };
}

/**
 * 读取统一 shelf 列表，供手动“搁置”面板展示。
 */
async function getShelfListAsync(ctx: GitFeatureContext, repoRoot: string): Promise<GitFeatureActionResult> {
  const shelfManager = new ShelveChangesManager(createGitShelfManagerRuntime(ctx, repoRoot));
  const shelfViewManager = new ShelvedChangesViewManager(repoRoot, ctx.userDataPath);
  const viewState = await shelfViewManager.getViewStateAsync();
  const items = await shelfManager.listShelvedChangeListsAsync({
    includeHidden: viewState.showRecycled,
  });
  return { ok: true, data: { items, viewState } };
}

/**
 * 创建统一 shelf 记录，对齐上游的 Shelve Changes 入口。
 */
async function createShelveAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const message = String(payload?.message || "搁置变更").trim() || "搁置变更";
  const selection = resolveManualShelveSelection(repoRoot, payload);
  const saver = new VcsShelveChangesSaver(createGitShelfManagerRuntime(ctx, repoRoot), message, "manual");
  const freezingProcess = new GitFreezingProcess(
    {
      repoRoot,
      emitProgress(messageText: string, detail?: string) {
        emitGitFeatureProgress(ctx, repoRoot, messageText, detail);
      },
    },
    "搁置本地改动",
    async () => {
      await saver.saveSelection(repoRoot, selection);
      return { ok: true } as GitFeatureActionResult;
    },
  );
  try {
    return await freezingProcess.execute();
  } catch (error) {
    return {
      ok: false,
      error: String((error as Error)?.message || "创建搁置失败"),
    };
  }
}

/**
 * 把外部 patch/diff 文件导入统一 shelf 平台，供后续在同一套列表中恢复。
 */
async function importShelvePatchFilesAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const filePaths: string[] = Array.from(new Set<string>(
    (Array.isArray(payload?.filePaths) ? payload.filePaths : [])
      .map((item: unknown) => String(item || "").trim())
      .filter((item: string): item is string => item.length > 0),
  ));
  if (filePaths.length <= 0) return { ok: false, error: "缺少 Patch 文件路径" };
  const shelfManager = new ShelveChangesManager(createGitShelfManagerRuntime(ctx, repoRoot));
  const importRes = await shelfManager.importPatchFilesAsync(filePaths);
  if (importRes.imported.length <= 0) {
    return {
      ok: false,
      error: importRes.failed[0]?.error || "未导入任何 Patch",
    };
  }
  return {
    ok: true,
    data: {
      items: await getShelfListAsync(ctx, repoRoot).then((res) => Array.isArray(res.data?.items) ? res.data.items : []),
      failed: importRes.failed.length > 0 ? importRes.failed : undefined,
    },
  };
}

/**
 * 恢复统一 shelf 记录；支持 partial unshelve、目标更改列表与“移除已成功应用文件”策略。
 */
async function restoreShelveAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const ref = String(payload?.ref || "").trim();
  if (!ref) return { ok: false, error: "缺少搁置记录引用" };
  const selectedPaths = normalizeCommitPanelRepoPaths(repoRoot, payload?.selectedPaths);
  const targetChangeListId = String(payload?.targetChangeListId || "").trim();
  const removeAppliedFromShelf = payload?.removeAppliedFromShelf !== false;
  if (targetChangeListId) {
    const changeListPlatformService = new ChangeListPlatformService({ userDataPath: ctx.userDataPath, repoRoot });
    const availability = changeListPlatformService.getOperationAvailability();
    if (!availability.operationsAllowed) {
      return { ok: false, error: availability.error || "当前仓库已禁用更改列表" };
    }
    const hasTargetChangeList = changeListPlatformService.getSnapshotState().repo.lists
      .some((item) => String(item.id || "").trim() === targetChangeListId);
    if (!hasTargetChangeList) {
      return { ok: false, error: "目标更改列表不存在" };
    }
  }
  const shelfManager = new ShelveChangesManager(createGitShelfManagerRuntime(ctx, repoRoot));
  const freezingProcess = new GitFreezingProcess(
    {
      repoRoot,
      emitProgress(messageText: string, detail?: string) {
        emitGitFeatureProgress(ctx, repoRoot, messageText, detail);
      },
    },
    "恢复搁置记录",
    async () => {
      const result = await shelfManager.unshelveChangeListAsync(ref, {
        selectedPaths,
        targetChangeListId: targetChangeListId || undefined,
        removeAppliedFromShelf,
      });
      return result.ok
        ? { ok: true }
        : {
            ok: false,
            error: result.error,
            data: Array.isArray(result.conflictRepoRoots) && result.conflictRepoRoots.length > 0
              ? { conflictRepoRoots: result.conflictRepoRoots }
              : undefined,
          };
    },
  );
  return await freezingProcess.execute();
}

/**
 * 重命名统一 shelf 记录，保持存储结构不变，仅更新展示说明。
 */
async function renameShelveAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const ref = String(payload?.ref || "").trim();
  const message = String(payload?.message || "").trim();
  if (!ref) return { ok: false, error: "缺少搁置记录引用" };
  if (!message) return { ok: false, error: "搁置说明不能为空" };
  const shelfManager = new ShelveChangesManager(createGitShelfManagerRuntime(ctx, repoRoot));
  await shelfManager.renameChangeListAsync(ref, message);
  return { ok: true };
}

/**
 * 把统一 shelf 记录移入回收区，供 showRecycled 视图继续管理。
 */
async function recycleShelveAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const ref = String(payload?.ref || "").trim();
  if (!ref) return { ok: false, error: "缺少搁置记录引用" };
  const shelfManager = new ShelveChangesManager(createGitShelfManagerRuntime(ctx, repoRoot));
  await shelfManager.recycleChangeListAsync(ref);
  return { ok: true };
}

/**
 * 把回收区或已删除列表中的 shelf 记录恢复回活动视图。
 */
async function restoreArchivedShelveAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const ref = String(payload?.ref || "").trim();
  if (!ref) return { ok: false, error: "缺少搁置记录引用" };
  const shelfManager = new ShelveChangesManager(createGitShelfManagerRuntime(ctx, repoRoot));
  await shelfManager.restoreArchivedChangeListAsync(ref);
  return { ok: true };
}

/**
 * 保存 shelf 面板的 showRecycled/groupByDirectory 状态，供同仓库再次打开时复用。
 */
async function saveShelfViewStateAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const shelfViewManager = new ShelvedChangesViewManager(repoRoot, ctx.userDataPath);
  const viewState = await shelfViewManager.updateViewStateAsync({
    showRecycled: payload?.showRecycled === true,
    groupByDirectory: payload?.groupByDirectory === true,
  });
  return { ok: true, data: { viewState } };
}

/**
 * 删除统一 shelf 记录。
 */
async function deleteShelveAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const ref = String(payload?.ref || "").trim();
  if (!ref) return { ok: false, error: "缺少搁置记录引用" };
  const shelfManager = new ShelveChangesManager(createGitShelfManagerRuntime(ctx, repoRoot));
  await shelfManager.deleteChangeListAsync(ref, {
    permanently: payload?.permanently === true,
  });
  return { ok: true };
}

/**
 * 把前端传入的手动搁置上下文归一化为平台层选择载荷，严格按“当前选择 / 当前更改列表 / 当前受影响变更”顺序处理。
 */
function resolveManualShelveSelection(repoRoot: string, payload: any): GitManualShelveSelection {
  const selection = payload?.selection && typeof payload.selection === "object" ? payload.selection : {};
  return {
    selectedPaths: normalizeCommitPanelRepoPaths(repoRoot, selection.selectedPaths),
    availablePaths: normalizeCommitPanelRepoPaths(repoRoot, selection.availablePaths),
    targetChangeListId: String(selection.targetChangeListId || "").trim() || undefined,
    targetChangeListName: String(selection.targetChangeListName || "").trim() || undefined,
    changeListsEnabled: selection.changeListsEnabled === true,
  };
}

/**
 * 创建 stash 记录，对齐 Git 原生暂存栈语义。
 */
async function createStashAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const message = String(payload?.message || "").trim();
  const includeUntracked = payload?.includeUntracked === true;
  const keepIndex = payload?.keepIndex === true;
  const files = normalizeRepoPaths(repoRoot, payload?.files);
  const gitCapabilityState = await getGitCapabilityStateAsync(ctx, repoRoot);
  if (files.length > 0 && !gitCapabilityState.stashPushPathspecSupported)
    return { ok: false, error: "当前 Git 版本不支持按路径创建 Stash（需要 Git 2.13+）" };
  const argv = ["stash", "push"];
  if (keepIndex) argv.push("--keep-index");
  if (includeUntracked) argv.push("--include-untracked");
  if (message) argv.push("-m", message);
  if (files.length > 0) {
    argv.push("--", ...files);
  }
  const res = await runGitSpawnAsync(ctx, repoRoot, argv, 120_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "创建暂存失败") };
  if (files.length <= 0) return { ok: true };
  const selectedPathSet = new Set(files);
  const remainingStagedPaths = await listStagedPathsAsync(ctx, repoRoot);
  const hasRemainingStagedPaths = remainingStagedPaths.some((onePath) => !selectedPathSet.has(onePath));
  if (!hasRemainingStagedPaths) return { ok: true };
  return {
    ok: true,
    data: {
      warning: "已创建 Stash，但暂存区仍保留其他已暂存更改。",
    },
  };
}

/**
 * 应用或弹出 stash；冲突时回传结构化仓库列表供前端直接拉起冲突处理入口。
 */
async function applyStashAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const ref = String(payload?.ref || "").trim();
  if (!ref) return { ok: false, error: "缺少 stash 引用" };
  const pop = payload?.pop === true;
  const reinstateIndex = payload?.reinstateIndex === true;
  const branchName = String(payload?.branchName || "").trim();
  const argv = branchName
    ? ["stash", "branch", branchName, ref]
    : pop
      ? ["stash", "pop", ...(reinstateIndex ? ["--index"] : []), ref]
      : ["stash", "apply", ...(reinstateIndex ? ["--index"] : []), ref];
  const res = await runGitSpawnAsync(ctx, repoRoot, argv, 120_000);
  if (!res.ok) {
    const conflictRepoRoots = await hasUnmergedFilesAsync(ctx, repoRoot) ? [repoRoot] : undefined;
    return {
      ok: false,
      error: toGitErrorMessage(res, branchName ? "以分支恢复暂存失败" : (pop ? "恢复暂存失败" : "应用暂存失败")),
      data: conflictRepoRoots ? { conflictRepoRoots } : undefined,
    };
  }
  return {
    ok: true,
    data: branchName ? { branchName } : undefined,
  };
}

/**
 * 删除 stash。
 */
async function dropStashAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const ref = String(payload?.ref || "").trim();
  if (!ref) return { ok: false, error: "缺少 stash 引用" };
  const res = await runGitSpawnAsync(ctx, repoRoot, ["stash", "drop", ref], 60_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "删除暂存失败") };
  return { ok: true };
}

/**
 * 解析 `git worktree list` 的普通文本输出（非 porcelain 兜底）。
 */
function parseWorktreeListPlainText(stdout: string): Array<{ path: string; head?: string; branch?: string; detached?: boolean }> {
  const rows = String(stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const out: Array<{ path: string; head?: string; branch?: string; detached?: boolean }> = [];
  for (const row of rows) {
    const m = row.match(/^(.+?)\s+([0-9a-fA-F]{7,40})\s+(\(.+\)|\[.+\])$/);
    if (!m) continue;
    const worktreePath = String(m[1] || "").trim();
    const head = String(m[2] || "").trim();
    const marker = String(m[3] || "").trim();
    const branchPart = marker.replace(/^\(|\)$|^\[|\]$/g, "").trim();
    const detached = /detached/i.test(branchPart);
    const branch = detached ? undefined : branchPart.replace(/^branch\s+/i, "").trim();
    if (!worktreePath) continue;
    out.push({
      path: worktreePath,
      head: head || undefined,
      branch: branch || undefined,
      detached,
    });
  }
  return out;
}

/**
 * 读取 worktree 列表。
 */
async function getWorktreesAsync(ctx: GitFeatureContext, repoRoot: string): Promise<GitFeatureActionResult> {
  const porcelainRes = await runGitExecAsync(ctx, repoRoot, ["worktree", "list", "--porcelain"], 10_000);
  if (!porcelainRes.ok) {
    const plainRes = await runGitExecAsync(ctx, repoRoot, ["worktree", "list"], 10_000);
    if (!plainRes.ok) return { ok: false, error: toGitErrorMessage(porcelainRes, "读取 Worktree 列表失败") };
    const fallbackItems = parseWorktreeListPlainText(plainRes.stdout).map((one) => ({
      path: String(one.path || ""),
      bare: false,
      detached: !!one.detached,
      branch: one.branch,
      head: one.head,
      locked: undefined,
      prunable: undefined,
    }));
    return { ok: true, data: { items: fallbackItems } };
  }

  const porcelainItems = parseWorktreeListPorcelain(porcelainRes.stdout);
  if (porcelainItems.length === 0) {
    const plainRes = await runGitExecAsync(ctx, repoRoot, ["worktree", "list"], 10_000);
    if (plainRes.ok) {
      const fallbackItems = parseWorktreeListPlainText(plainRes.stdout).map((one) => ({
        path: String(one.path || ""),
        bare: false,
        detached: !!one.detached,
        branch: one.branch,
        head: one.head,
        locked: undefined,
        prunable: undefined,
      }));
      return { ok: true, data: { items: fallbackItems } };
    }
  }

  const items = porcelainItems.map((one) => {
    const rawBranch = String(one.branch || "").trim();
    const shortBranch = rawBranch.startsWith("refs/heads/") ? rawBranch.slice("refs/heads/".length) : rawBranch;
    return {
      path: String(one.worktree || ""),
      bare: false,
      detached: !!one.detached,
      branch: shortBranch || undefined,
      head: String(one.head || "").trim() || undefined,
      locked: one.locked ? "locked" : undefined,
      prunable: one.prune ? "prunable" : undefined,
    };
  });
  return { ok: true, data: { items } };
}

/**
 * 新增 worktree。
 */
async function addWorktreeAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const worktreePath = toFsPathAbs(String(payload?.path || "").trim());
  const ref = String(payload?.ref || "").trim() || "HEAD";
  const createBranch = payload?.createBranch === true;
  const branchName = String(payload?.branchName || "").trim();
  if (!worktreePath) return { ok: false, error: "缺少 worktree 路径" };

  const argv = ["worktree", "add"];
  if (createBranch && branchName) argv.push("-b", branchName);
  argv.push(worktreePath, ref);
  const res = await runGitSpawnAsync(ctx, repoRoot, argv, 300_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "新增 Worktree 失败") };
  return { ok: true };
}

/**
 * 移除 worktree。
 */
async function removeWorktreeAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const worktreePath = toFsPathAbs(String(payload?.path || "").trim());
  const force = payload?.force === true;
  if (!worktreePath) return { ok: false, error: "缺少 worktree 路径" };
  const argv = force ? ["worktree", "remove", "--force", worktreePath] : ["worktree", "remove", worktreePath];
  const res = await runGitSpawnAsync(ctx, repoRoot, argv, 180_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "移除 Worktree 失败") };
  return { ok: true };
}

/**
 * 执行 fetch/pull/push。
 */
async function runSimpleGitFlowAsync(ctx: GitFeatureContext, repoRoot: string, action: "fetch" | "pull" | "push", payload: any): Promise<GitFeatureActionResult> {
  if (action === "fetch") {
    return await runFetchFlowAsync(ctx, repoRoot, payload || {});
  }

  if (action === "pull") {
    return await runUpdateProjectAsync(ctx, repoRoot, payload || {});
  }

  return await executePushAsync(ctx, repoRoot, {
    ...(payload || {}),
    updateIfRejected: payload?.updateIfRejected !== false,
  });
}

/**
 * 读取当前所有本地分支与其上游引用，供“删除 tracked branch”可用性判断复用。
 */
async function listLocalBranchUpstreamsAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
): Promise<Array<{ branch: string; upstream: string }>> {
  const res = await runGitExecAsync(ctx, repoRoot, ["for-each-ref", "--format=%(refname:short)%00%(upstream:short)", "refs/heads"], 10_000);
  if (!res.ok) return [];
  return String(res.stdout || "")
    .split(/\r?\n/)
    .map((row) => {
      const [branch, upstream] = String(row || "").split("\0");
      return {
        branch: String(branch || "").trim(),
        upstream: String(upstream || "").trim(),
      };
    })
    .filter((item) => !!item.branch);
}

/**
 * 构造分支删除成功后的补救信息，供前端 notice 渲染 Restore / View commits / Delete tracked branch。
 */
async function buildDeletedBranchRecoveryInfoAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  branchName: string,
): Promise<{
  deletedBranchName: string;
  deletedTipHash?: string;
  baseBranch?: string;
  viewRevision?: string;
  trackedRemoteRef?: string;
  canDeleteTrackedBranch?: boolean;
}> {
  const cleanBranchName = String(branchName || "").trim();
  const tipRes = cleanBranchName
    ? await runGitExecAsync(ctx, repoRoot, ["rev-parse", cleanBranchName], 10_000)
    : null;
  const currentBranchRes = await runGitExecAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 10_000);
  const deletedTipHash = tipRes?.ok ? String(tipRes.stdout || "").trim() : "";
  const baseBranch = currentBranchRes.ok ? String(currentBranchRes.stdout || "").trim() : "";
  const trackedRemote = cleanBranchName
    ? await resolveBranchTrackedRemoteAsync(ctx, repoRoot, cleanBranchName)
    : null;
  const trackedRemoteRef = trackedRemote?.remote && trackedRemote?.branch
    ? `${trackedRemote.remote}/${trackedRemote.branch}`
    : "";
  let canDeleteTrackedBranch = false;
  if (trackedRemoteRef) {
    const branchUpstreams = await listLocalBranchUpstreamsAsync(ctx, repoRoot);
    canDeleteTrackedBranch = !branchUpstreams.some((item) => item.branch !== cleanBranchName && item.upstream === trackedRemoteRef);
  }
  return {
    deletedBranchName: cleanBranchName,
    deletedTipHash: deletedTipHash || undefined,
    baseBranch: baseBranch || undefined,
    viewRevision: deletedTipHash ? (baseBranch ? `${baseBranch}..${deletedTipHash}` : deletedTipHash) : undefined,
    trackedRemoteRef: trackedRemoteRef || undefined,
    canDeleteTrackedBranch,
  };
}

/**
 * 在删除标签前解析恢复所需的目标提交，供前端在成功通知中生成“恢复标签”动作。
 */
async function buildDeletedTagRecoveryInfoAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  tagName: string,
): Promise<{
  deletedTagName: string;
  deletedTagTarget?: string;
}> {
  const cleanTagName = String(tagName || "").trim();
  const targetRes = cleanTagName
    ? await runGitExecAsync(ctx, repoRoot, ["rev-parse", `refs/tags/${cleanTagName}^{}`], 10_000)
    : null;
  const deletedTagTarget = targetRes?.ok ? String(targetRes.stdout || "").trim() : "";
  return {
    deletedTagName: cleanTagName,
    deletedTagTarget: deletedTagTarget || undefined,
  };
}

/**
 * 在指定目标上创建标签，供日志里的新建标签与删除标签后的恢复动作复用。
 */
async function createTagAtRevisionAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  tagName: string,
  targetRef: string,
  fallbackMessage: string,
): Promise<GitFeatureActionResult> {
  const cleanTagName = String(tagName || "").trim();
  const cleanTargetRef = String(targetRef || "").trim();
  if (!cleanTagName) return { ok: false, error: "标签名不能为空" };
  if (!cleanTargetRef) return { ok: false, error: "缺少标签目标提交" };
  const res = await runGitSpawnAsync(ctx, repoRoot, ["tag", cleanTagName, cleanTargetRef], 60_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, fallbackMessage) };
  return { ok: true };
}

/**
 * 执行分支与标签相关动作（新建/重命名/删除/签出修订/标签恢复）。
 */
async function runBranchActionAsync(ctx: GitFeatureContext, repoRoot: string, payload: any): Promise<GitFeatureActionResult> {
  const action = String(payload?.action || "").trim();
  if (action === "setSyncEnabled") {
    const settings = writeGitBranchSyncSettings(ctx.userDataPath, {
      enabled: payload?.enabled !== false,
    });
    return {
      ok: true,
      data: {
        enabled: settings.enabled,
      },
    };
  }
  if (action === "setShowOnlyMy") {
    const settings = writeGitBranchSyncSettings(ctx.userDataPath, {
      showOnlyMy: payload?.enabled === true,
    });
    return {
      ok: true,
      data: {
        showOnlyMy: settings.showOnlyMy,
      },
    };
  }
  if (action === "toggleFavorite") {
    const refKind = String(payload?.refKind || "").trim() === "remote" ? "remote" : "local";
    const name = String(payload?.name || payload?.ref || "").trim();
    if (!name) return { ok: false, error: "缺少目标分支" };
    const favorite = typeof payload?.favorite === "boolean"
      ? setGitBranchFavorite(ctx.userDataPath, repoRoot, refKind, name, payload.favorite === true)
      : setGitBranchFavorite(ctx.userDataPath, repoRoot, refKind, name, !isGitBranchFavorite(ctx.userDataPath, repoRoot, refKind, name));
    return {
      ok: true,
      data: {
        favorite,
      },
    };
  }
  if (action === "addRemote") {
    const name = String(payload?.name || "").trim();
    const url = String(payload?.url || "").trim();
    const pushUrl = String(payload?.pushUrl || "").trim();
    if (!name) return { ok: false, error: "远端名称不能为空" };
    if (!url) return { ok: false, error: "远端地址不能为空" };
    const addRes = await runGitSpawnAsync(ctx, repoRoot, ["remote", "add", name, url], 30_000);
    if (!addRes.ok) return { ok: false, error: toGitErrorMessage(addRes, "新增远端失败") };
    if (pushUrl && pushUrl !== url) {
      const pushRes = await runGitSpawnAsync(ctx, repoRoot, ["remote", "set-url", "--push", name, pushUrl], 30_000);
      if (!pushRes.ok) return { ok: false, error: toGitErrorMessage(pushRes, "更新远端 Push 地址失败") };
    }
    return {
      ok: true,
      data: {
        name,
        url,
        pushUrl: pushUrl || undefined,
      },
    };
  }
  if (action === "editRemote") {
    const name = String(payload?.name || "").trim();
    const nextName = String(payload?.nextName || payload?.newName || "").trim() || name;
    const url = String(payload?.url || "").trim();
    const pushUrl = String(payload?.pushUrl || "").trim();
    if (!name) return { ok: false, error: "远端名称不能为空" };
    if (!nextName) return { ok: false, error: "新远端名称不能为空" };
    if (!url) return { ok: false, error: "远端地址不能为空" };
    if (nextName !== name) {
      const renameRes = await runGitSpawnAsync(ctx, repoRoot, ["remote", "rename", name, nextName], 30_000);
      if (!renameRes.ok) return { ok: false, error: toGitErrorMessage(renameRes, "重命名远端失败") };
    }
    const effectiveName = nextName || name;
    const setFetchRes = await runGitSpawnAsync(ctx, repoRoot, ["remote", "set-url", effectiveName, url], 30_000);
    if (!setFetchRes.ok) return { ok: false, error: toGitErrorMessage(setFetchRes, "更新远端地址失败") };
    const effectivePushUrl = pushUrl || url;
    const setPushRes = await runGitSpawnAsync(ctx, repoRoot, ["remote", "set-url", "--push", effectiveName, effectivePushUrl], 30_000);
    if (!setPushRes.ok) return { ok: false, error: toGitErrorMessage(setPushRes, "更新远端 Push 地址失败") };
    return {
      ok: true,
      data: {
        name: effectiveName,
        previousName: name,
        url,
        pushUrl: effectivePushUrl,
      },
    };
  }
  if (action === "removeRemote") {
    const name = String(payload?.name || payload?.remote || "").trim();
    if (!name) return { ok: false, error: "远端名称不能为空" };
    const removeRes = await runGitSpawnAsync(ctx, repoRoot, ["remote", "remove", name], 30_000);
    if (!removeRes.ok) return { ok: false, error: toGitErrorMessage(removeRes, "移除远端失败") };
    return {
      ok: true,
      data: {
        name,
      },
    };
  }

  if (action === "new") {
    const name = String(payload?.name || "").trim();
    const startPoint = String(payload?.startPoint || "").trim();
    if (!name) return { ok: false, error: "分支名不能为空" };
    const argv = startPoint ? ["switch", "-c", name, startPoint] : ["switch", "-c", name];
    const res = await runGitSpawnAsync(ctx, repoRoot, argv, 120_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "新建分支失败") };
    return { ok: true };
  }

  if (action === "rename") {
    const oldName = String(payload?.oldName || "").trim();
    const newName = String(payload?.newName || "").trim();
    if (!oldName || !newName) return { ok: false, error: "分支名不能为空" };
    const res = await runGitSpawnAsync(ctx, repoRoot, ["branch", "-m", oldName, newName], 60_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "重命名分支失败") };
    return { ok: true };
  }

  if (action === "delete") {
    const name = String(payload?.name || "").trim();
    if (!name) return { ok: false, error: "分支名不能为空" };
    const recoveryInfo = await buildDeletedBranchRecoveryInfoAsync(ctx, repoRoot, name);
    const safeDeleteRes = await runGitSpawnAsync(ctx, repoRoot, ["branch", "-d", name], 60_000);
    if (safeDeleteRes.ok) {
      return {
        ok: true,
        data: recoveryInfo,
      };
    }
    if (!isBranchNotFullyMergedError(safeDeleteRes)) {
      return { ok: false, error: toGitErrorMessage(safeDeleteRes, "删除分支失败") };
    }
    const forceDeleteRes = await runGitSpawnAsync(ctx, repoRoot, ["branch", "-D", name], 60_000);
    if (!forceDeleteRes.ok) return { ok: false, error: toGitErrorMessage(forceDeleteRes, "删除分支失败") };
    return {
      ok: true,
      data: {
        forcedAfterNotFullyMerged: true,
        ...recoveryInfo,
      },
    };
  }

  if (action === "checkoutRevision") {
    const rev = String(payload?.revision || "").trim();
    if (!rev) return { ok: false, error: "修订号不能为空" };
    const res = await runGitSpawnAsync(ctx, repoRoot, ["checkout", rev], 120_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "签出修订失败") };
    return { ok: true };
  }

  if (action === "checkoutUpdate") {
    const ref = String(payload?.ref || payload?.name || "").trim();
    if (!ref) return { ok: false, error: "缺少目标分支/引用" };
    const switchRes = await switchRefAsync(ctx, repoRoot, ref, payload);
    if (!switchRes.ok) return switchRes;
    if (hasBlockingPreservingState(switchRes.data)) return switchRes;
    const updateRes = await runUpdateProjectAsync(ctx, repoRoot, payload || {});
    if (!updateRes.ok) return updateRes;
    return {
      ...updateRes,
      data: {
        ...(updateRes.data && typeof updateRes.data === "object" ? updateRes.data : {}),
        smartCheckoutResult: switchRes.data && typeof switchRes.data === "object"
          ? switchRes.data
          : undefined,
      },
    };
  }

  if (action === "checkoutRebaseToBranch" || action === "checkoutRebaseToMaster") {
    const name = String(payload?.name || "").trim();
    const onto = action === "checkoutRebaseToMaster" ? "master" : String(payload?.onto || "").trim();
    if (!name) return { ok: false, error: "分支名不能为空" };
    if (!onto) return { ok: false, error: "缺少变基基准分支" };
    return await executeCheckoutThenCompositeUpdateAsync(
      ctx,
      repoRoot,
      name,
      onto,
      payload,
      "rebase",
    );
  }

  if (action === "rebaseBranchTo" || action === "rebaseMasterTo") {
    const base = action === "rebaseMasterTo" ? "master" : String(payload?.base || "").trim();
    const target = String(payload?.target || payload?.onto || "").trim();
    if (!base) return { ok: false, error: "缺少基准分支" };
    if (!target) return { ok: false, error: "缺少目标分支" };
    return await executeBranchToTargetUpdateAsync(
      ctx,
      repoRoot,
      base,
      target,
      payload,
      "rebase",
    );
  }

  if (action === "mergeIntoBranch" || action === "mergeIntoMaster") {
    const base = action === "mergeIntoMaster" ? "master" : String(payload?.base || "").trim();
    const source = String(payload?.source || payload?.target || "").trim();
    if (!base) return { ok: false, error: "缺少基准分支" };
    if (!source) return { ok: false, error: "缺少来源分支" };
    return await executeBranchToTargetUpdateAsync(
      ctx,
      repoRoot,
      base,
      source,
      payload,
      "merge",
    );
  }
  if (action === "pullRemote") {
    const remoteRef = String(payload?.ref || payload?.name || "").trim();
    const remoteNames = await listRemoteNamesAsync(ctx, repoRoot);
    const refPair = parseUpstreamRef(remoteRef, remoteNames);
    if (!refPair?.remote || !refPair?.branch) return { ok: false, error: "远端分支格式应为 remote/branch" };
    const mode = String(payload?.mode || "").trim().toLowerCase() === "rebase" ? "rebase" : "merge";
    const explicitUpdateMethod = String(payload?.updateMethod || "").trim().toLowerCase();
    const headInfo = await getHeadInfoAsync(ctx, repoRoot);
    if (headInfo.detached || !String(headInfo.branch || "").trim()) {
      return { ok: false, error: "Detached HEAD 状态下不支持该操作" };
    }
    if (mode === "merge" && !explicitUpdateMethod) {
      return await executeDirectPullRemoteAsync(
        ctx,
        repoRoot,
        String(headInfo.branch || "").trim(),
        refPair.remote,
        refPair.branch,
        payload,
      );
    }
    return await executePullRemoteCompositeUpdateAsync(
      ctx,
      repoRoot,
      String(headInfo.branch || "").trim(),
      refPair.remote,
      refPair.branch,
      payload,
      mode,
    );
  }
  if (action === "deleteTag") {
    const name = String(payload?.name || "").trim();
    if (!name) return { ok: false, error: "标签名不能为空" };
    const recoveryInfo = await buildDeletedTagRecoveryInfoAsync(ctx, repoRoot, name);
    const res = await runGitSpawnAsync(ctx, repoRoot, ["tag", "-d", name], 60_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "删除标签失败") };
    return {
      ok: true,
      data: recoveryInfo,
    };
  }
  if (action === "restoreTag") {
    return await createTagAtRevisionAsync(
      ctx,
      repoRoot,
      String(payload?.name || ""),
      String(payload?.target || ""),
      "恢复标签失败",
    );
  }
  if (action === "pushTag") {
    const name = String(payload?.name || "").trim();
    if (!name) return { ok: false, error: "标签名不能为空" };
    let remote = String(payload?.remote || "").trim();
    if (!remote) remote = await getPreferredRemoteAsync(ctx, repoRoot);
    if (!remote) return { ok: false, error: "未配置远程仓库，无法推送标签" };
    const tagRef = `refs/tags/${name}`;
    const res = await runGitSpawnAsync(ctx, repoRoot, ["push", remote, `${tagRef}:${tagRef}`], 300_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "推送标签失败") };
    return {
      ok: true,
      data: {
        remote,
        tag: name,
      },
    };
  }
  if (action === "deleteRemote") {
    const remoteRef = String(payload?.name || payload?.ref || "").trim();
    const remoteNames = await listRemoteNamesAsync(ctx, repoRoot);
    const refPair = parseUpstreamRef(remoteRef, remoteNames);
    if (!refPair?.remote || !refPair?.branch) return { ok: false, error: "远端分支格式应为 remote/branch" };
    if (refPair.branch === "HEAD") return { ok: false, error: "不支持删除远端 HEAD 引用" };
    const res = await runGitSpawnAsync(ctx, repoRoot, ["push", refPair.remote, "--delete", refPair.branch], 300_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "删除远端分支失败") };
    return { ok: true };
  }
  if (action === "compareFiles") {
    const leftRef = String(payload?.leftRef || "").trim();
    const rightRef = String(payload?.rightRef || "").trim();
    if (!leftRef) return { ok: false, error: "缺少比较基准引用" };
    const argv = buildRevisionCompareDiffArgv({
      leftRef,
      rightRef: rightRef || undefined,
      relPath: "",
    });
    if (!argv) return { ok: false, error: "无法构造比较命令" };
    argv.splice(2, 0, "--name-status");
    const res = await runGitExecAsync(ctx, repoRoot, argv, 30_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "读取文件差异失败") };
    return {
      ok: true,
      data: {
        repoRoot,
        leftRef,
        rightRef: rightRef || undefined,
        files: parseCommitChangedFiles(res.stdout).sort((left, right) => (
          String(left.path || "").localeCompare(String(right.path || ""), "zh-CN")
        )),
      },
    };
  }
  if (action === "updateBranch") {
    const name = String(payload?.name || "").trim();
    if (!name) return { ok: false, error: "分支名不能为空" };

    const headInfo = await getHeadInfoAsync(ctx, repoRoot);
    if (headInfo.detached) return { ok: false, error: "Detached HEAD 状态下无法更新分支" };
    if (headInfo.branch === name) {
      return await runUpdateProjectAsync(ctx, repoRoot, payload || {});
    }

    const trackedRemote = await resolveBranchTrackedRemoteAsync(ctx, repoRoot, name);
    if (!trackedRemote?.remote || !trackedRemote?.branch) {
      return { ok: false, error: `分支 ${name} 未配置远端上游分支，无法更新` };
    }

    const refspec = `${trackedRemote.branch}:${name}`;
    const fetchRes = await runGitSpawnAsync(ctx, repoRoot, ["fetch", trackedRemote.remote, refspec], 300_000);
    if (!fetchRes.ok) return { ok: false, error: toGitErrorMessage(fetchRes, "更新分支失败") };
    return {
      ok: true,
      data: {
        method: "fetch",
        branch: name,
        upstream: trackedRemote.upstream,
      },
    };
  }
  if (action === "pushBranch") {
    const name = String(payload?.name || "").trim();
    if (!name) return { ok: false, error: "分支名不能为空" };
    const currentBranchRes = await runGitExecAsync(ctx, repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 10_000);
    const currentBranch = currentBranchRes.ok ? String(currentBranchRes.stdout || "").trim() : "";
    if (currentBranch && currentBranch === name) {
      return await executePushAsync(ctx, repoRoot, {
        updateIfRejected: payload?.updateIfRejected !== false,
        forceWithLease: payload?.forceWithLease === true,
        pushTags: payload?.pushTags === true,
        skipHook: payload?.skipHook === true || payload?.skipHooks === true,
      });
    }

    const pushTarget = await resolveBranchPushTargetAsync(ctx, repoRoot, name);
    const remote = String(pushTarget.remote || "").trim();
    if (!remote) return { ok: false, error: "未配置远程仓库，无法推送分支" };
    const remoteBranch = String(pushTarget.remoteBranch || "").trim() || name;
    const argv = ["push"];
    if (!pushTarget.upstream || pushTarget.shouldSetUpstream) argv.push("--set-upstream");
    argv.push(remote, `${name}:${remoteBranch}`);
    const res = await runGitSpawnAsync(ctx, repoRoot, argv, 300_000);
    if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "推送失败") };
    return {
      ok: true,
      data: {
        branch: name,
        remote,
        remoteBranch,
        upstreamSet: !pushTarget.upstream || pushTarget.shouldSetUpstream,
      },
    };
  }

  return { ok: false, error: `不支持的分支动作：${action}` };
}

/**
 * 执行进行中 Git 操作的继续/中止入口，统一复用仓库级操作状态机。
 */
async function runOperationControlActionAsync(
  ctx: GitFeatureContext,
  repoRoot: string,
  action: "operation.continue" | "operation.abort",
): Promise<GitFeatureActionResult> {
  return await executeRepositoryOperationControlAsync(
    ctx,
    repoRoot,
    action === "operation.continue" ? "continue" : "abort",
  );
}

/**
 * 初始化仓库（当目录还不是 Git 仓库时使用）。
 */
async function initRepoAsync(ctx: GitFeatureContext, payload: any): Promise<GitFeatureActionResult> {
  const dir = toFsPathAbs(String(payload?.dir || "").trim());
  if (!dir) return { ok: false, error: "缺少目录路径" };
  const res = await runGitSpawnAsync(ctx, dir, ["init"], 60_000);
  if (!res.ok) return { ok: false, error: toGitErrorMessage(res, "初始化仓库失败") };
  return { ok: true };
}

/**
 * 分发 Git 功能动作。
 */
export async function dispatchGitFeatureAction(args: GitFeatureActionArgs): Promise<GitFeatureActionResult> {
  const action = String(args?.action || "").trim();
  if (shouldInvalidateSingleCommitDetailsCache(action))
    clearSingleCommitDetailsCache();
  const requestId = Math.max(0, Math.floor(Number(args?.requestId) || 0));
  const cancellationEntry = action === "request.cancel" ? null : ensureGitFeatureCancellationEntry(requestId);
  const ctx: GitFeatureContext = {
    action,
    requestId,
    gitPath: String(args?.gitPath || "").trim() || "git",
    userDataPath: String(args?.userDataPath || "").trim(),
    abortSignal: cancellationEntry?.controller.signal,
    isCancellationRequested(): boolean {
      return cancellationEntry?.cancelled === true;
    },
    getCancellationReason(): string | undefined {
      return cancellationEntry?.reason;
    },
    emitProgress: args?.emitProgress,
  };

  try {
    if (!ctx.userDataPath) return { ok: false, error: "缺少 userData 路径" };

    if (action === "request.cancel") {
      const targetRequestId = Math.max(0, Math.floor(Number(args?.payload?.targetRequestId ?? args?.payload?.requestId) || 0));
      if (!targetRequestId) return { ok: false, error: "缺少待取消的 requestId" };
      const cancelled = cancelGitFeatureRequest(targetRequestId, String(args?.payload?.reason || "").trim() || "更新项目已取消");
      return {
        ok: true,
        data: {
          targetRequestId,
          cancelled,
        },
      };
    }

    if (action === "console.get") {
      const repoPath = String(args.payload?.repoPath || "").trim();
      const limit = Math.max(20, Math.min(500, Math.floor(Number(args.payload?.limit) || 200)));
      const mode = args.payload?.includeLongText === true ? "copy" : "view";
      const repoRoot = repoPath ? resolveConsoleRepoPath(repoPath) : "";
      return {
        ok: true,
        data: {
          repoRoot: repoRoot || undefined,
          items: gitConsoleStore.listEntries(repoRoot, limit, mode),
        },
      };
    }

    if (action === "console.clear") {
      const repoPath = String(args.payload?.repoPath || "").trim();
      const repoRoot = repoPath ? resolveConsoleRepoPath(repoPath) : "";
      const cleared = gitConsoleStore.clearEntries(repoRoot);
      return {
        ok: true,
        data: {
          repoRoot: repoRoot || undefined,
          cleared,
        },
      };
    }

    if (action === "repo.detect") {
      const repoPath = String(args.payload?.repoPath || "").trim();
      const detected = await resolveRepoRootAsync(ctx, repoPath);
      if (!detected.ok) return { ok: true, data: { isRepo: false, error: detected.error } };
      const headInfo = await getHeadInfoAsync(ctx, String(detected.repoRoot || ""));
      return {
        ok: true,
        data: {
          isRepo: true,
          repoRoot: detected.repoRoot,
          ...headInfo,
        },
      };
    }

    if (action === "repo.init") {
      return await initRepoAsync(ctx, args.payload || {});
    }

    const repoPath = String(args.payload?.repoPath || "").trim();
    const repoResolved = await resolveRepoRootAsync(ctx, repoPath);
    if (!repoResolved.ok || !repoResolved.repoRoot) {
      return { ok: false, error: repoResolved.error || "未检测到 Git 仓库" };
    }
    const repoRoot = repoResolved.repoRoot;

    if (action === "branch.popup") return await getBranchPopupDataAsync(ctx, repoRoot);
    if (action === "branch.switch") return await switchRefAsync(ctx, repoRoot, String(args.payload?.ref || ""), args.payload || {});
    if (action === "branch.action") return await runBranchActionAsync(ctx, repoRoot, args.payload || {});
    if (action === "operation.continue" || action === "operation.abort") {
      return await runOperationControlActionAsync(ctx, repoRoot, action as "operation.continue" | "operation.abort");
    }

    if (action === "status.get") return await getStatusWithChangeListsAsync(ctx, repoRoot, repoPath);
    if (action === "commit.preferences.get") return await getCommitPanelPreferencesAsync(ctx, repoRoot);
    if (action === "commit.preferences.set") return await saveCommitPanelPreferencesAsync(ctx, repoRoot, args.payload || {});
    if (action === "status.getIgnored") return await getIgnoredStatusAsync(ctx, repoRoot);
    if (action === "changesView.setOption") return updateGitViewOption(ctx, repoRoot, String(args.payload?.key || ""), args.payload?.value === true, repoPath);
    if (action === "changesView.setGroupingKeys") return updateGitGroupingKeys(ctx, repoRoot, args.payload || {}, repoPath);
    if (action === "localChanges.setOption") return updateLocalChangesConfig(ctx, repoRoot, String(args.payload?.key || ""), args.payload?.value === true);
    if (action === "changelist.create") return createChangeList(ctx, repoRoot, String(args.payload?.name || ""), args.payload?.setActive === true);
    if (action === "changelist.rename") return renameChangeList(ctx, repoRoot, String(args.payload?.id || ""), String(args.payload?.name || ""));
    if (action === "changelist.delete") return deleteChangeList(ctx, repoRoot, String(args.payload?.id || ""), String(args.payload?.targetListId || ""));
    if (action === "changelist.setActive") return setActiveChangeList(ctx, repoRoot, String(args.payload?.id || ""));
    if (action === "changelist.updateData") return updateChangeListData(ctx, repoRoot, args.payload || {});
    if (action === "changelist.moveFiles") return await moveFilesToChangeList(ctx, repoRoot, args.payload?.paths, String(args.payload?.targetListId || ""), args.payload?.entries);
    if (action === "changes.ignoreTargets") return await getIgnoreTargetsAsync(ctx, repoRoot, args.payload?.paths);
    if (action === "changes.ignore") return await ignoreFilesAsync(ctx, repoRoot, args.payload || {});

    if (action === "commit.create") return await commitSelectedFilesAsync(ctx, repoRoot, args.payload || {});
    if (action === "changes.rollback") return await rollbackFilesAsync(ctx, repoRoot, args.payload || {});
    if (action === "changes.delete") return await deleteFilesAsync(ctx, repoRoot, args.payload || {});
    if (action === "changes.stage") return await stageFilesAsync(ctx, repoRoot, args.payload || {});
    if (action === "changes.unstage") return await unstageFilesAsync(ctx, repoRoot, args.payload || {});
    if (action === "changes.revertUnstaged") return await revertUnstagedFilesAsync(ctx, repoRoot, args.payload || {});
    if (action === "changes.restoreFromRevision") return await restoreFilesFromRevisionAsync(ctx, repoRoot, args.payload || {});
    if (action === "changes.writeWorkingFile") return await writeWorkingFileAsync(repoRoot, args.payload || {});
    if (action === "changes.conflictMerge.get") return await getConflictMergeSnapshotActionAsync(ctx, repoRoot, args.payload || {});
    if (action === "changes.conflictResolver.get") return await getConflictResolverEntriesActionAsync(ctx, repoRoot, args.payload || {});
    if (action === "changes.conflictResolver.apply") return await applyConflictResolverSideActionAsync(ctx, repoRoot, args.payload || {});

    if (action === "diff.get") return await getDiffContentAsync(ctx, repoRoot, args.payload || {});
    if (action === "diff.patch") return await getDiffPatchAsync(ctx, repoRoot, args.payload || {});
    if (action === "diff.openPath") return await getDiffOpenPathAsync(ctx, repoRoot, args.payload || {});

    if (action === "log.get") return await getLogAsync(ctx, repoRoot, args.payload || {});
    if (action === "log.resolveFileHistoryPath") return await resolveFileHistoryPathAtCommitAsync(ctx, repoRoot, args.payload || {});
    if (action === "log.availability") return await getLogActionAvailabilityAsync(ctx, repoRoot, args.payload || {});
    if (action === "log.details") return await getCommitDetailsAsync(ctx, repoRoot, args.payload || {});
    if (action === "log.details.availability") return await getCommitDetailsAvailabilityAsync(ctx, repoRoot, args.payload || {});
    if (action === "log.details.action") return await runCommitDetailsActionAsync(ctx, repoRoot, args.payload || {});
    if (action === "log.messageDraft") return await getLogMessageDraftAsync(ctx, repoRoot, args.payload || {});
    if (action === "log.rebasePlan.get") return await getInteractiveRebasePlanActionAsync(ctx, repoRoot, args.payload || {});
    if (action === "log.rebasePlan.run") return await runInteractiveRebasePlanActionAsync(ctx, repoRoot, args.payload || {});
    if (action === "log.action") return await runLogActionAsync(ctx, repoRoot, args.payload || {});

    if (action === "update.trackedBranchPreview") {
      return {
        ok: true,
        data: await getTrackedBranchPreviewAsync(createGitUpdateConfigRuntime(ctx, repoRoot), args.payload || {}),
      };
    }
    if (action === "update.trackedBranchApply") {
      return await applyTrackedBranchSelectionsAsync(createGitUpdateConfigRuntime(ctx, repoRoot), args.payload || {});
    }
    if (action === "update.options.get") {
      return {
        ok: true,
        data: await getUpdateOptionsSnapshotAsync(createGitUpdateConfigRuntime(ctx, repoRoot), args.payload || {}),
      };
    }
    if (action === "update.options.set") {
      return await updateStoredUpdateOptionsAsync(createGitUpdateConfigRuntime(ctx, repoRoot), args.payload || {});
    }
    if (action === "flow.fetch") return await runSimpleGitFlowAsync(ctx, repoRoot, "fetch", args.payload || {});
    if (action === "flow.pull") return await runSimpleGitFlowAsync(ctx, repoRoot, "pull", args.payload || {});
    if (action === "flow.push") return await runSimpleGitFlowAsync(ctx, repoRoot, "push", args.payload || {});
    if (action === "push.preview") return await getPushPreviewAsync(ctx, repoRoot, args.payload || {});
    if (action === "push.execute") return await executePushAsync(ctx, repoRoot, args.payload || {});

    if (action === "shelf.list") return await getShelfListAsync(ctx, repoRoot);
    if (action === "shelf.create") return await createShelveAsync(ctx, repoRoot, args.payload || {});
    if (action === "shelf.import") return await importShelvePatchFilesAsync(ctx, repoRoot, args.payload || {});
    if (action === "shelf.restore") return await restoreShelveAsync(ctx, repoRoot, args.payload || {});
    if (action === "shelf.rename") return await renameShelveAsync(ctx, repoRoot, args.payload || {});
    if (action === "shelf.recycle") return await recycleShelveAsync(ctx, repoRoot, args.payload || {});
    if (action === "shelf.restoreArchived") return await restoreArchivedShelveAsync(ctx, repoRoot, args.payload || {});
    if (action === "shelf.view.set") return await saveShelfViewStateAsync(ctx, repoRoot, args.payload || {});
    if (action === "shelf.delete") return await deleteShelveAsync(ctx, repoRoot, args.payload || {});

    if (action === "stash.list") return await getStashListAsync(ctx, repoRoot);
    if (action === "stash.create") return await createStashAsync(ctx, repoRoot, args.payload || {});
    if (action === "stash.apply") return await applyStashAsync(ctx, repoRoot, args.payload || {});
    if (action === "stash.drop") return await dropStashAsync(ctx, repoRoot, args.payload || {});

    if (action === "worktree.list") return await getWorktreesAsync(ctx, repoRoot);
    if (action === "worktree.add") return await addWorktreeAsync(ctx, repoRoot, args.payload || {});
    if (action === "worktree.remove") return await removeWorktreeAsync(ctx, repoRoot, args.payload || {});

    return { ok: false, error: `未知动作：${action}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    if (requestId > 0 && action !== "request.cancel") {
      gitFeatureCancellationMap.delete(requestId);
    }
  }
}
