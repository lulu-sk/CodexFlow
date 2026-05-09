// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { PartialCommitSelectionEntry } from "./commit-panel/types";
import type { CommitDiffOpenRequest } from "./commit-panel/main-chain";
import type { GitConsoleEntry, GitDiffSnapshot, GitLogItem, GitStatusEntry, GitStatusSnapshot, GitUpdateOperationProblem } from "./types";
import { resolveGitText } from "./git-i18n";

export type GitWorkbenchSelectionScope = "commit" | "detail" | null;
export type GitWorkbenchOperationState = "rebasing" | "merging" | "grafting" | "reverting";

type PartialCommitAvailabilityEntry = Pick<GitStatusEntry, "staged" | "untracked" | "ignored">;

export type GitStageOperationBatch = {
  repoRoot: string;
  paths: string[];
};

export type GitWorkingTreePatchRequest = {
  repoRoot: string;
  path: string;
  oldPath?: string;
  mode: "working" | "staged";
};

export type GitPatchPathspecItem = {
  path: string;
  oldPath?: string;
  renamed?: boolean;
  status?: string;
};

export type GitLogCheckoutMenuModel = {
  checkoutBranchNames: string[];
  useSubmenu: boolean;
};

export type GitOperationProblemConflictResolverRequest = {
  title: string;
  description: string;
  scopeRepoRoot?: string;
  focusPath?: string;
  checkedPaths: string[];
};

/**
 * 统一规整 Git 相对路径，避免 `\` 与重复斜杠导致的去重失效。
 */
function normalizeGitPath(pathText: string | undefined): string {
  return String(pathText || "").trim().replace(/\\/g, "/");
}

/**
 * 统一规整仓库根路径，避免批处理时把同一根拆成多个 bucket。
 */
function normalizeGitRepoRoot(repoRoot: string | undefined): string {
  return String(repoRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 把目标仓库根转换为当前工作台内的 resolver scope key；若目标仓库不在当前工作台范围内，则返回 null。
 */
function resolveConflictResolverScopeKey(
  workspaceRepoRoot: string,
  targetRepoRoot: string,
): string | null {
  const workspace = normalizeGitRepoRoot(workspaceRepoRoot);
  const target = normalizeGitRepoRoot(targetRepoRoot);
  if (!workspace || !target) return null;
  if (workspace === target) return "";
  if (!target.startsWith(`${workspace}/`)) return null;
  return target.slice(workspace.length + 1);
}

/**
 * 判断 patch pathspec 是否需要同时带上旧路径，保证 rename/copy patch 头信息不丢失。
 */
function isRenameLikePatchItem(item: GitPatchPathspecItem): boolean {
  const statusCode = String(item.status || "").trim().toUpperCase()[0] || "";
  return item.renamed === true || statusCode === "R" || statusCode === "C";
}

/**
 * 把任意文本清洗为适合保存 patch 默认文件名的片段。
 */
function sanitizePatchFileNameSegment(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 按 IDEA `GitCheckoutActionGroup` 规则构建日志右键“签出”菜单模型：
 * 仅纳入本地分支引用，排除当前分支；只要存在分支签出入口，顶层就升级为子菜单。
 */
export function buildGitLogCheckoutMenuModel(args: {
  localBranchRefs: string[];
  currentBranch: string;
}): GitLogCheckoutMenuModel {
  const currentBranch = String(args.currentBranch || "").trim();
  const checkoutBranchNames = Array.from(new Set(
    (args.localBranchRefs || [])
      .map((one) => String(one || "").trim())
      .filter((name) => !!name && name !== currentBranch),
  ));
  return {
    checkoutBranchNames,
    useSubmenu: checkoutBranchNames.length > 0,
  };
}

/**
 * 按动作语义规整日志多选提交的执行顺序。
 * IDEA 的 Cherry-pick 会把 UI 中“新到旧”的选区反转为“旧到新”后再执行，避免多提交应用顺序颠倒。
 */
export function resolveLogActionExecutionHashes(args: {
  action: string;
  hashesNewestFirst: string[];
}): string[] {
  if (args.action === "cherryPick") return [...args.hashesNewestFirst].reverse();
  return [...args.hashesNewestFirst];
}

/**
 * 把提交树当前选区规整成稳定签名，供“仅在真实选区变化时才滚动到可见区”逻辑复用。
 */
export function buildCommitSelectionSignature(rowKeys: string[]): string {
  return rowKeys
    .map((one) => String(one || "").trim())
    .filter(Boolean)
    .join("|");
}

/**
 * 把“提交详情”请求规整成稳定键，供日志详情面板按选区去重，避免刷新/重渲染时反复读取同一提交。
 */
export function buildCommitDetailsRequestKey(repoRoot: string, hashesKey: string): string {
  const normalizedRepoRoot = String(repoRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedHashesKey = String(hashesKey || "").trim();
  if (!normalizedRepoRoot || !normalizedHashesKey) return "";
  return `${normalizedRepoRoot}::${normalizedHashesKey}`;
}

/**
 * 判断当前“提交详情”请求是否可直接复用已加载或正在加载的同键请求，避免同一选区进入重复拉取回路。
 */
export function shouldSkipCommitDetailsRequest(args: {
  requestKey: string;
  loadedRequestKey: string;
  requestedRequestKey: string;
}): boolean {
  const requestKey = String(args.requestKey || "").trim();
  if (!requestKey) return true;
  return requestKey === String(args.loadedRequestKey || "").trim()
    || requestKey === String(args.requestedRequestKey || "").trim();
}

/**
 * 把 Diff 打开请求规整成稳定签名，用于去重进行中的同一预览请求，避免大仓库下重复拉起 `diff.get`。
 */
export function buildCommitDiffRequestSignature(request: CommitDiffOpenRequest): string {
  return [
    String(request.mode || "").trim(),
    String(request.path || "").trim().replace(/\\/g, "/"),
    String(request.oldPath || "").trim().replace(/\\/g, "/"),
    String(request.hash || "").trim(),
    (request.hashes || []).map((one) => String(one || "").trim()).filter(Boolean).join(","),
    String(request.shelfRef || "").trim(),
    (request.selectionPaths || []).map((one) => String(one || "").trim().replace(/\\/g, "/")).filter(Boolean).join(","),
    String(request.selectionKind || "").trim(),
    String(Number.isFinite(request.selectionIndex) ? request.selectionIndex : 0),
  ].join("::");
}

/**
 * 把当前已加载的 Diff 快照回写成同构签名，用于跳过与当前展示内容完全一致的重复请求。
 */
export function buildCommitDiffSnapshotSignature(snapshot: GitDiffSnapshot | null | undefined): string {
  const path = normalizeGitPath(snapshot?.path);
  if (!path) return "";
  const selectionIndex = Number(snapshot?.selectionIndex);
  return buildCommitDiffRequestSignature({
    path,
    oldPath: normalizeGitPath(snapshot?.oldPath) || undefined,
      mode: snapshot?.mode || "working",
      hash: String(snapshot?.hash || "").trim() || undefined,
      hashes: Array.isArray(snapshot?.hashes) ? snapshot.hashes : [],
      shelfRef: String(snapshot?.shelfRef || "").trim() || undefined,
      selectionPaths: Array.isArray(snapshot?.selectionPaths) && snapshot.selectionPaths.length > 0
        ? snapshot.selectionPaths
        : [path],
    selectionKind: snapshot?.selectionKind || "single",
    selectionIndex: Number.isFinite(selectionIndex) ? selectionIndex : 0,
  });
}

/**
 * 优先从已加载的文件历史日志项中解析选中提交对应的真实路径。
 * - 命中 `historyPath` 时可直接打开 Diff，避免再次请求 `log.resolveFileHistoryPath`；
 * - 未命中时返回原始筛选路径，并提示调用方继续走后端回退解析。
 */
export function resolveLoadedFileHistoryPath(args: {
  logItems: GitLogItem[];
  selectedHash: string;
  fallbackPath: string;
}): { path: string; fromLogItem: boolean } {
  const selectedHash = String(args.selectedHash || "").trim();
  const fallbackPath = normalizeGitPath(args.fallbackPath);
  if (!selectedHash) return { path: fallbackPath, fromLogItem: false };
  const matched = (args.logItems || []).find((item) => String(item?.hash || "").trim() === selectedHash);
  const historyPath = normalizeGitPath(matched?.historyPath);
  if (historyPath) return { path: historyPath, fromLogItem: true };
  return { path: fallbackPath, fromLogItem: false };
}

/**
 * 判断当前 pending 提交选中是否可以直接落到现有日志项。
 * - 普通日志模式下，只要命中同哈希即可立即选中；
 * - 文件历史模式下，必须等到携带 `historyPath` 的新日志项到位，避免误命中切换前的旧日志列表。
 */
export function resolvePendingLogSelectionItem(args: {
  logItems: GitLogItem[];
  targetHash: string;
  requireHistoryPath: boolean;
}): GitLogItem | null {
  const targetHash = String(args.targetHash || "").trim();
  if (!targetHash) return null;
  const matched = (args.logItems || []).find((item) => String(item?.hash || "").trim() === targetHash);
  if (!matched) return null;
  if (!args.requireHistoryPath) return matched;
  return String(matched.historyPath || "").trim() ? matched : null;
}

/**
 * 按仓库根把当前要执行的 stage/unstage 路径分桶，供工作台复用同一批处理执行器。
 */
export function buildGitStageOperationBatches(args: {
  entries: GitStatusEntry[];
  fallbackRepoRoot: string;
  predicate?: (entry: GitStatusEntry) => boolean;
}): GitStageOperationBatch[] {
  const buckets = new Map<string, string[]>();
  for (const entry of args.entries || []) {
    if (args.predicate && !args.predicate(entry)) continue;
    const repoRoot = normalizeGitRepoRoot(entry.repositoryRoot || args.fallbackRepoRoot);
    const path = normalizeGitPath(entry.path);
    if (!repoRoot || !path) continue;
    const bucket = buckets.get(repoRoot);
    if (bucket) {
      if (!bucket.includes(path)) bucket.push(path);
      continue;
    }
    buckets.set(repoRoot, [path]);
  }
  return Array.from(buckets.entries()).map(([repoRoot, paths]) => ({ repoRoot, paths }));
}

/**
 * 按整棵提交树聚合 Git.Stage.Add.All 需要的批次，覆盖 tracked unstaged 与 untracked 两类入口。
 */
export function buildGitStageAllOperationBatches(args: {
  entries: GitStatusEntry[];
  fallbackRepoRoot: string;
}): GitStageOperationBatch[] {
  return buildGitStageOperationBatches({
    entries: args.entries,
    fallbackRepoRoot: args.fallbackRepoRoot,
    predicate: (entry) => !entry.ignored && (entry.unstaged || entry.untracked),
  });
}

/**
 * 把工作区/暂存区树选区转换为逐文件 patch 请求；mixed entry 默认导出 HEAD→LOCAL 全量 patch。
 */
export function buildWorkingTreePatchRequests(args: {
  entries: GitStatusEntry[];
  fallbackRepoRoot: string;
}): GitWorkingTreePatchRequest[] {
  const requests: GitWorkingTreePatchRequest[] = [];
  const seen = new Set<string>();
  for (const entry of args.entries || []) {
    if (entry.ignored) continue;
    const repoRoot = normalizeGitRepoRoot(entry.repositoryRoot || args.fallbackRepoRoot);
    const path = normalizeGitPath(entry.path);
    if (!repoRoot || !path) continue;
    const key = `${repoRoot}::${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({
      repoRoot,
      path,
      oldPath: normalizeGitPath(entry.oldPath) || undefined,
      mode: entry.untracked || entry.unstaged ? "working" : "staged",
    });
  }
  return requests;
}

/**
 * 为提交 patch 生成 pathspec；rename/copy 同时带上新旧路径，避免 patch 丢失 rename 头。
 */
export function buildCommitPatchPathspecs(changes: GitPatchPathspecItem[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const change of changes || []) {
    const path = normalizeGitPath(change.path);
    if (path && !seen.has(path)) {
      seen.add(path);
      result.push(path);
    }
    const oldPath = normalizeGitPath(change.oldPath);
    if (oldPath && isRenameLikePatchItem(change) && !seen.has(oldPath)) {
      seen.add(oldPath);
      result.push(oldPath);
    }
  }
  return result;
}

/**
 * 按当前 patch 上下文生成默认保存文件名，尽量保留提交哈希或单文件语义。
 */
export function buildPatchExportFileName(args: {
  paths?: string[];
  hash?: string;
  hashes?: string[];
}): string {
  const paths = Array.from(new Set((args.paths || []).map((one) => normalizeGitPath(one)).filter(Boolean)));
  const hashes = Array.from(new Set((args.hashes || []).map((one) => String(one || "").trim()).filter(Boolean)));
  const primaryHash = String(args.hash || hashes[hashes.length - 1] || "").trim();
  const primaryPath = paths[0] || "";
  const baseName = sanitizePatchFileNameSegment(primaryPath.split("/").pop() || "");
  if (primaryHash) {
    const shortHash = primaryHash.slice(0, 7) || "commit";
    return baseName ? `commit-${shortHash}-${baseName}.patch` : `commit-${shortHash}.patch`;
  }
  if (paths.length === 1 && baseName) return `${baseName}.patch`;
  if (paths.length > 1) return "changes.patch";
  if (hashes.length > 1) return "commits.patch";
  return "changes.patch";
}

/**
 * 判断当前激活周期内是否应触发 Git 工作台首刷，避免同一 `repoPath` 在一次打开过程中被重复初始化刷新。
 */
export function resolveGitWorkbenchBootstrapRefresh(args: {
  active: boolean;
  repoPath: string;
  lastBootstrapRepoPath: string;
}): { shouldRefresh: boolean; nextBootstrapRepoPath: string } {
  const cleanRepoPath = String(args.repoPath || "").trim();
  if (!args.active || !cleanRepoPath) {
    return {
      shouldRefresh: false,
      nextBootstrapRepoPath: "",
    };
  }
  if (cleanRepoPath === String(args.lastBootstrapRepoPath || "").trim()) {
    return {
      shouldRefresh: false,
      nextBootstrapRepoPath: cleanRepoPath,
    };
  }
  return {
    shouldRefresh: true,
    nextBootstrapRepoPath: cleanRepoPath,
  };
}

/**
 * 判断当前 Diff 是否具备 partial commit 的基础条件；working 与 staged diff 都允许进入同一套选择模型。
 */
export function canUseDiffPartialCommit(args: {
  diff: GitDiffSnapshot | null | undefined;
  entry: PartialCommitAvailabilityEntry | null | undefined;
}): boolean {
  const diff = args.diff;
  const entry = args.entry;
  const diffPath = String(diff?.path || "").trim().replace(/\\/g, "/");
  if (!diff || !diffPath || diff.isBinary) return false;
  if (!entry || entry.untracked || entry.ignored) return false;
  if (diff.mode === "working") return true;
  if (diff.mode === "staged") return !!entry.staged;
  return false;
}

/**
 * 判断当前 Diff 是否应显示 partial commit 控件；除基础可用性外，还要求存在可选 hunk。
 */
export function shouldShowDiffPartialCommit(args: {
  diff: GitDiffSnapshot | null | undefined;
  entry: PartialCommitAvailabilityEntry | null | undefined;
}): boolean {
  return canUseDiffPartialCommit(args) && (args.diff?.hunks?.length || 0) > 0;
}

/**
 * 解析 partial commit 提交前应回读哪一种 Diff；优先复用建模时存下的 mode，避免 staged 选区被误按 working 校验。
 */
export function resolvePartialCommitValidationDiffMode(args: {
  partialEntry: Pick<PartialCommitSelectionEntry, "diffMode"> | null | undefined;
  entry: Pick<GitStatusEntry, "staged"> | null | undefined;
}): "working" | "staged" {
  if (args.partialEntry?.diffMode === "working" || args.partialEntry?.diffMode === "staged") {
    return args.partialEntry.diffMode;
  }
  return args.entry?.staged ? "staged" : "working";
}

/**
 * 判断当前状态是否应按 IDEA apply-changes 语义进入“提交更改完成 Cherry-pick”阶段。
 * 只要仓库仍处于 grafting、没有未解决冲突，且 Git 已提供建议提交消息，就应切到提交收尾；
 * 不要求当前状态列表里仍显式保留“已解决冲突文件”条目。
 */
export function shouldFinalizeCherryPickByCommit(args: {
  status: Pick<GitStatusSnapshot, "operationState" | "operationSuggestedCommitMessage"> | null | undefined;
  unresolvedConflictCount: number;
  hasChanges: boolean;
}): boolean {
  if (String(args.status?.operationState || "").trim() !== "grafting") return false;
  if (args.unresolvedConflictCount > 0) return false;
  if (!args.hasChanges) return false;
  return String(args.status?.operationSuggestedCommitMessage || "").trim().length > 0;
}

/**
 * 把 `merge-conflict` 问题投影为冲突 resolver 打开请求；仅当当前工作台里确实存在可处理冲突时才返回。
 */
export function resolveOperationProblemConflictResolverRequest(args: {
  problem: GitUpdateOperationProblem | null | undefined;
  entries: Array<Pick<GitStatusEntry, "path" | "conflictState" | "repositoryRoot">>;
  workspaceRepoRoot?: string;
}): GitOperationProblemConflictResolverRequest | null {
  const problem = args.problem;
  if (!problem || problem.kind !== "merge-conflict") return null;

  const workspaceRepoRoot = normalizeGitRepoRoot(args.workspaceRepoRoot);
  const targetRepoRoot = normalizeGitRepoRoot(problem.repoRoot || args.workspaceRepoRoot);
  if (!targetRepoRoot) return null;

  const scopeKey = workspaceRepoRoot
    ? resolveConflictResolverScopeKey(workspaceRepoRoot, targetRepoRoot)
    : "";
  if (scopeKey === null) return null;

  const scopedEntries = (args.entries || []).filter((entry) => {
    const entryRepoRoot = normalizeGitRepoRoot(entry.repositoryRoot || args.workspaceRepoRoot);
    return entryRepoRoot === targetRepoRoot;
  });
  if (scopedEntries.length <= 0) return null;

  const checkedPathSet = new Set(scopedEntries.map((entry) => normalizeGitPath(entry.path)).filter(Boolean));
  const checkedPaths = Array.from(new Set(
    (problem.files || []).map((filePath) => normalizeGitPath(filePath)).filter((filePath) => checkedPathSet.has(filePath)),
  ));
  const unresolvedPaths = scopedEntries
    .filter((entry) => entry.conflictState === "conflict")
    .map((entry) => normalizeGitPath(entry.path))
    .filter(Boolean);
  const resolvedPaths = scopedEntries
    .filter((entry) => entry.conflictState === "resolved")
    .map((entry) => normalizeGitPath(entry.path))
    .filter(Boolean);
  const focusPath = checkedPaths.find((pathText) => unresolvedPaths.includes(pathText))
    || unresolvedPaths[0]
    || checkedPaths[0]
    || resolvedPaths[0]
    || "";

  return {
    title: String(problem.title || "").trim() || resolveGitText("workbench.misc.conflicts.title", "解决冲突"),
    description: String(problem.description || "").trim() || resolveGitText("workbench.misc.conflicts.operationProblemDescription", "当前仓库存在未解决冲突，请先完成处理。"),
    scopeRepoRoot: scopeKey || undefined,
    focusPath: focusPath || undefined,
    checkedPaths,
  };
}

/**
 * 将仓库进行中状态映射为 UI 可读名称，供“失败但已进入进行中状态”的提示文案复用。
 */
function resolveOperationStateLabel(state: GitWorkbenchOperationState): string {
  if (state === "rebasing") return resolveGitText("workbench.operationState.states.rebasing.badge", "变基");
  if (state === "merging") return resolveGitText("workbench.operationState.states.merging.badge", "合并");
  if (state === "grafting") return resolveGitText("workbench.operationState.states.grafting.badge", "优选");
  return resolveGitText("workbench.operationState.states.reverting.badge", "还原");
}

/**
 * 把日志动作映射为用户侧操作名，供冲突/中断提示复用；未知动作统一回退为“当前 Git 操作”。
 */
function resolveLogActionLabel(action: string): string {
  if (action === "cherryPick") return resolveGitText("workbench.logAction.cherryPick", "优选");
  if (action === "revert") return resolveGitText("workbench.logAction.revert", "还原提交");
  return resolveGitText("workbench.logAction.currentOperation", "当前 Git 操作");
}

/**
 * 判断日志动作失败是否已经把仓库带入进行中状态；若是，则返回更适合 UI 的 warning 提示，避免继续显示底层 Git 错误墙。
 */
export function resolveLogActionOperationFailureFeedback(args: {
  action: string;
  error: unknown;
  data: any;
}): {
  operationState: GitWorkbenchOperationState;
  shouldRefresh: boolean;
  message: string;
} | null {
  const operationState = String(args.data?.operationState || "").trim();
  if (operationState !== "rebasing" && operationState !== "merging" && operationState !== "grafting" && operationState !== "reverting") {
    return null;
  }
  const actionLabel = resolveLogActionLabel(String(args.action || "").trim());
  const operationLabel = resolveOperationStateLabel(operationState);
  const errorText = String(args.error || "").trim();
  const hasConflict = /(?:^|\n)\s*CONFLICT\b/i.test(errorText)
    || /could not apply/i.test(errorText)
    || /after resolving the conflicts/i.test(errorText);
  return {
    operationState,
    shouldRefresh: args.data?.shouldRefresh === true,
    message: hasConflict
      ? resolveGitText("workbench.logAction.feedback.conflictEnteredOperation", "{{action}}发生冲突，仓库已进入 {{operation}} 状态，可继续或中止", { action: actionLabel, operation: operationLabel })
      : resolveGitText("workbench.logAction.feedback.enteredOperation", "{{action}}未自动完成，仓库已进入 {{operation}} 状态，可继续或中止", { action: actionLabel, operation: operationLabel }),
  };
}

/**
 * 判断 continue/abort 失败是否其实仍处于进行中状态；若是，则返回更适合 UI 的 warning 提示，
 * 避免把“继续后再次冲突”等半成功结果误展示为最终失败。
 */
export function resolveOperationControlFailureFeedback(args: {
  control: "continue" | "abort";
  error: unknown;
  data: any;
}): {
  operationState: GitWorkbenchOperationState;
  shouldRefresh: boolean;
  message: string;
} | null {
  const operationState = String(args.data?.operationState || "").trim();
  if (operationState !== "rebasing" && operationState !== "merging" && operationState !== "grafting" && operationState !== "reverting") {
    return null;
  }
  const operationLabel = resolveOperationStateLabel(operationState);
  const errorText = String(args.error || "").trim();
  const hasConflict = /(?:^|\n)\s*CONFLICT\b/i.test(errorText)
    || /could not apply/i.test(errorText)
    || /after resolving the conflicts/i.test(errorText);
  if (args.control === "continue") {
    return {
      operationState,
      shouldRefresh: args.data?.shouldRefresh === true,
      message: hasConflict
        ? resolveGitText("workbench.operationState.feedback.continueConflict", "继续 {{operation}} 时再次发生冲突，仓库仍处于进行中状态", { operation: operationLabel })
        : resolveGitText("workbench.operationState.feedback.continueRunning", "已继续 {{operation}}，仓库仍处于进行中状态", { operation: operationLabel }),
    };
  }
  return {
    operationState,
    shouldRefresh: args.data?.shouldRefresh === true,
    message: resolveGitText("workbench.operationState.feedback.abortRunning", "{{operation}} 尚未中止，仓库仍处于进行中状态", { operation: operationLabel }),
  };
}

/**
 * 判断关闭统一问题弹窗后是否需要立刻刷新工作台，确保冲突已把仓库带入进行中状态时能及时显示状态条。
 */
export function shouldRefreshAfterClosingOperationProblem(problem: GitUpdateOperationProblem | null | undefined): boolean {
  if (!problem) return false;
  return problem.kind === "merge-conflict";
}

/**
 * 把提交详情里的增删行统计规整成稳定展示文案，保留 `+ / - / 共`，并额外给出净增减信息。
 */
export function buildCommitLineStatsSummary(
  lineStats: { additions?: number; deletions?: number } | null | undefined,
): {
  additions: number;
  deletions: number;
  total: number;
  net: number;
  netDirection: "increase" | "decrease" | "neutral";
  totalText: string;
  additionsText: string;
  deletionsText: string;
  netText: string;
} {
  const additions = Math.max(0, Math.floor(Number(lineStats?.additions) || 0));
  const deletions = Math.max(0, Math.floor(Number(lineStats?.deletions) || 0));
  const total = additions + deletions;
  const net = additions - deletions;
  const netDirection = net > 0 ? "increase" : net < 0 ? "decrease" : "neutral";
  return {
    additions,
    deletions,
    total,
    net,
    netDirection,
    totalText: resolveGitText("details.browser.meta.totalLines", "共 {{count}} 行", { count: total }),
    additionsText: `+${additions}`,
    deletionsText: `-${deletions}`,
    netText: net > 0
      ? resolveGitText("details.browser.meta.netIncrease", "净增 {{count}} 行", { count: net })
      : net < 0
        ? resolveGitText("details.browser.meta.netDecrease", "净减 {{count}} 行", { count: Math.abs(net) })
        : resolveGitText("details.browser.meta.netNeutral", "净变化 0 行"),
  };
}

/**
 * 判断当前是否应由提交面板主树接管 Diff 自动预览；当焦点已切到详情树时必须停止覆盖当前预览。
 */
export function shouldAutoPreviewCommitSelection(args: {
  activeSelectionScope: GitWorkbenchSelectionScope;
  previewEnabled: boolean;
  hasLoadedDiff: boolean;
  diffPinned?: boolean;
}): boolean {
  if (!args.previewEnabled) return false;
  if (args.diffPinned) return false;
  if (args.activeSelectionScope === "detail") return false;
  if (args.activeSelectionScope === "commit") return true;
  return !args.hasLoadedDiff;
}

/**
 * 把 Git 控制台条目拼成可复制文本，保留时间、状态、退出码、命令与输出，便于用户回传日志排查问题。
 */
export function buildGitConsoleCopyText(entries: GitConsoleEntry[]): string {
  return entries
    .map((entry) => {
      const exitCode = Number.isFinite(Number(entry.exitCode)) ? Math.floor(Number(entry.exitCode)) : 0;
      const header = [
        `[${new Date(Number(entry.timestamp) || 0).toISOString()}]`,
        entry.running ? "RUN" : entry.ok ? "OK" : "FAIL",
        `${Math.max(0, Math.floor(Number(entry.durationMs) || 0))}ms`,
        String(entry.cwd || "").trim(),
      ].filter(Boolean).join(" ");
      return [
        header,
        entry.running ? "" : `exitCode: ${exitCode}`,
        `$ ${String(entry.command || "").trim()}`,
        String(entry.stdout || ""),
        String(entry.stderr || ""),
        String(entry.error || ""),
      ].filter((one) => one.length > 0).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}
