import type {
  GitUpdateExecutionPhase,
  GitUpdateOperationProblem,
  GitUpdatePostAction,
  GitUpdateRootResultCode,
  GitUpdateSessionNotificationData,
  GitUpdateSessionProgressRoot,
  GitUpdateSessionProgressSnapshot,
} from "./types";
import { resolveGitText } from "../git-i18n";

export type GitUpdateSessionNoticeTone = "info" | "warn" | "danger";
export type GitUpdateSessionLifecycle = "running" | "finished" | "dismissed";

export type GitUpdateSessionViewRoot = GitUpdateSessionProgressRoot & {
  phaseLabel: string;
  resultLabel?: string;
  summaryLabel: string;
  detailLines: string[];
  badges: string[];
  actions: GitUpdatePostAction[];
  isActive: boolean;
  isFinished: boolean;
};

export type GitUpdateSessionViewState = {
  activeRepoRoot?: string;
  activeRootName?: string;
  activePhaseLabel: string;
  completedRoots: number;
  remainingRoots: number;
  runningRoots: number;
  totalRoots: number;
  multiRoot: boolean;
  roots: GitUpdateSessionViewRoot[];
};

export type GitUpdateSessionResultRootViewState = {
  repoRoot: string;
  rootName: string;
  kind: "repository" | "submodule";
  resultCode: GitUpdateRootResultCode;
  resultLabel: string;
  detail: string;
  detailLines: string[];
  badges: string[];
  actions: GitUpdatePostAction[];
  methodLabel?: string;
  rangeText?: string;
  isUpdated: boolean;
  isProblematic: boolean;
};

export type GitUpdateSessionResultViewState = {
  title: string;
  description?: string;
  updatedFilesCount?: number;
  receivedCommitsCount?: number;
  filteredCommitsCount?: number;
  rangeText?: string;
  skippedSummary?: string;
  postActions: GitUpdatePostAction[];
  roots: GitUpdateSessionResultRootViewState[];
};

/**
 * 统一读取更新会话相关文案，避免运行态与完成态在多个 helper 中重复硬编码。
 */
function resolveUpdateSessionText(key: string, fallback: string, values?: Record<string, unknown>): string {
  return resolveGitText(key, fallback, values);
}

/**
 * 构造统一的仓级动作对象，避免运行态与完成态分别散落拼装逻辑。
 */
function buildRootAction(
  kind: GitUpdatePostAction["kind"],
  label: string,
  repoRoot?: string,
  payload?: Record<string, any>,
): GitUpdatePostAction | null {
  const actionLabel = String(label || "").trim();
  const targetRepoRoot = String(repoRoot || "").trim();
  if (!actionLabel) return null;
  return {
    kind,
    label: actionLabel,
    repoRoot: targetRepoRoot || undefined,
    payload,
  };
}

/**
 * 判断当前 root 是否属于 detached 子模块，供动作分流时避免误给 tracked branch 修复入口。
 */
function isDetachedSubmoduleRoot(root: {
  kind?: string;
  submoduleUpdate?: { mode?: string; parentRepoRoot?: string };
}): boolean {
  return root.kind === "submodule" && root.submoduleUpdate?.mode === "detached";
}

/**
 * 判断当前 root 是否处于需要回到冲突处理的状态，统一覆盖 unfinishedState 与 merge-conflict 两类来源。
 */
function hasRootConflictRecovery(
  root: {
    resultCode?: GitUpdateRootResultCode;
    unfinishedState?: GitUpdateSessionProgressRoot["unfinishedState"];
    operationProblem?: GitUpdateOperationProblem;
    preservingState?: GitUpdateSessionProgressRoot["preservingState"];
  },
): boolean {
  return root.resultCode === "INCOMPLETE"
    || !!root.unfinishedState
    || root.operationProblem?.kind === "merge-conflict"
    || !!root.preservingState?.resolveConflictsAction;
}

/**
 * 判断当前 root 是否保留了未恢复的本地改动，供结果卡片追加“查看搁置/暂存”动作。
 */
function hasSavedChangesRecovery(
  root: {
    preservingState?: GitUpdateSessionProgressRoot["preservingState"];
  },
): boolean {
  return root.preservingState?.status === "kept-saved" || root.preservingState?.status === "restore-failed";
}

/**
 * 为单个 root 生成可执行动作，统一覆盖冲突恢复、tracked branch 修复、重试更新与保留改动查看。
 */
function buildRootActions(root: {
  repoRoot?: string;
  kind?: string;
  parentRepoRoot?: string;
  resultCode?: GitUpdateRootResultCode;
  failureCode?: string;
  skippedReasonCode?: string;
  fetchResult?: GitUpdateSessionProgressRoot["fetchResult"];
  unfinishedState?: GitUpdateSessionProgressRoot["unfinishedState"];
  preservingState?: GitUpdateSessionProgressRoot["preservingState"];
  submoduleUpdate?: GitUpdateSessionProgressRoot["submoduleUpdate"];
  operationProblem?: GitUpdateOperationProblem;
}): GitUpdatePostAction[] {
  const repoRoot = String(root.repoRoot || "").trim();
  if (!repoRoot) return [];
  const parentRepoRoot = String(root.parentRepoRoot || root.submoduleUpdate?.parentRepoRoot || "").trim();
  const detachedSubmodule = isDetachedSubmoduleRoot(root);
  const actions: Array<GitUpdatePostAction | null> = [];
  const primaryFailureCode = String(root.failureCode || root.skippedReasonCode || "").trim();

  if (hasRootConflictRecovery(root)) {
    if (root.preservingState?.resolveConflictsAction) {
      actions.push(root.preservingState.resolveConflictsAction);
    } else {
      actions.push(buildRootAction(
        "resolve-conflicts",
        resolveUpdateSessionText("updateSession.actions.resolveConflicts", "处理该仓冲突"),
        repoRoot,
        {
          repoRoot,
          parentRepoRoot: parentRepoRoot || undefined,
        },
      ));
    }
  } else if (primaryFailureCode === "no-tracked-branch") {
    if (!detachedSubmodule) {
      actions.push(buildRootAction("fix-tracked-branch", resolveUpdateSessionText("updateSession.actions.fixTrackedBranch", "修复上游分支"), repoRoot, {
        repoRoot,
      }));
    }
  } else if (primaryFailureCode === "detached-head") {
    actions.push(detachedSubmodule && parentRepoRoot
      ? buildRootAction("open-parent-repo", resolveUpdateSessionText("updateSession.actions.openParentRepo", "打开父仓"), parentRepoRoot, {
          repoRoot,
          childRepoRoot: repoRoot,
        })
      : buildRootAction("open-repo-root", resolveUpdateSessionText("updateSession.actions.openRepoRoot", "打开该仓"), repoRoot, { repoRoot }));
  } else if (root.skippedReasonCode === "updated-by-parent" || root.skippedReasonCode === "parent-failed") {
    if (parentRepoRoot) {
      actions.push(buildRootAction("open-parent-repo", resolveUpdateSessionText("updateSession.actions.openParentRepo", "打开父仓"), parentRepoRoot, {
        repoRoot,
        childRepoRoot: repoRoot,
      }));
    }
  } else if (
    root.fetchResult?.status === "failed"
    || root.fetchResult?.status === "skipped"
    || root.resultCode === "ERROR"
    || root.resultCode === "NOT_READY"
    || root.resultCode === "CANCEL"
  ) {
    actions.push(detachedSubmodule && parentRepoRoot
      ? buildRootAction("open-parent-repo", resolveUpdateSessionText("updateSession.actions.openParentRepo", "打开父仓"), parentRepoRoot, {
          repoRoot,
          childRepoRoot: repoRoot,
        })
      : buildRootAction("retry-update-root", resolveUpdateSessionText("updateSession.actions.retryUpdateRoot", "重试该仓更新"), repoRoot, { repoRoot }));
  }

  if (hasSavedChangesRecovery(root)) {
    actions.push(root.preservingState?.savedChangesAction || null);
  }

  const deduped: GitUpdatePostAction[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (!action) continue;
    const key = `${action.kind}:${action.repoRoot || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(action);
  }
  return deduped.slice(0, 2);
}

/**
 * 从 root 级动作中提炼结果卡片顶部的摘要动作，优先暴露最紧急的恢复入口。
 */
function buildResultSummaryPostActions(
  roots: Array<{ actions: GitUpdatePostAction[] }>,
): GitUpdatePostAction[] {
  const priority = [
    "resolve-conflicts",
    "fix-tracked-branch",
    "retry-update-root",
    "open-saved-changes",
    "open-parent-repo",
    "open-repo-root",
  ];
  const collected: GitUpdatePostAction[] = [];
  const seen = new Set<string>();
  for (const kind of priority) {
    const hit = roots.flatMap((root) => root.actions).find((action) => action.kind === kind);
    if (!hit) continue;
    const key = `${hit.kind}:${hit.repoRoot || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push(hit);
  }
  return collected.slice(0, 2);
}

export type GitUpdateSessionEntryState = {
  requestId: number;
  lifecycle: GitUpdateSessionLifecycle;
  createdAt: number;
  updatedAt: number;
  tone: GitUpdateSessionNoticeTone;
  message: string;
  expanded: boolean;
  autoCloseAt?: number;
  snapshot?: GitUpdateSessionProgressSnapshot;
  viewState?: GitUpdateSessionViewState;
  notification?: GitUpdateSessionNotificationData;
  resultView?: GitUpdateSessionResultViewState;
};

type UpsertRunningUpdateSessionArgs = {
  now: number;
  requestId: number;
  message: string;
  snapshot?: GitUpdateSessionProgressSnapshot | null;
};

type FinalizeUpdateSessionArgs = {
  now: number;
  requestId: number;
  tone: GitUpdateSessionNoticeTone;
  message: string;
  notification?: GitUpdateSessionNotificationData | null;
  resultData?: any;
  autoCloseDelayMs: number;
};

/**
 * 把执行阶段转换为前端可读文案，供会话卡片与详情列表统一展示。
 */
export function getUpdatePhaseLabel(phase?: GitUpdateExecutionPhase): string {
  switch (phase) {
    case "repository-graph":
      return resolveUpdateSessionText("updateSession.phases.repositoryGraph", "构建仓库图");
    case "preflight":
      return resolveUpdateSessionText("updateSession.phases.preflight", "前置检查");
    case "tracked-branch-config":
      return resolveUpdateSessionText("updateSession.phases.trackedBranchConfig", "解析跟踪分支");
    case "fetch":
      return resolveUpdateSessionText("updateSession.phases.fetch", "获取远端");
    case "updater-selection":
      return resolveUpdateSessionText("updateSession.phases.updaterSelection", "选择更新策略");
    case "save-if-needed":
      return resolveUpdateSessionText("updateSession.phases.saveIfNeeded", "保护本地改动");
    case "root-update":
      return resolveUpdateSessionText("updateSession.phases.rootUpdate", "执行更新");
    case "result-aggregation":
      return resolveUpdateSessionText("updateSession.phases.resultAggregation", "汇总结果");
    default:
      return resolveUpdateSessionText("updateSession.phases.waiting", "等待开始");
  }
}

/**
 * 把 root 结果码转换为短状态标签，避免会话详情只显示原始枚举。
 */
export function getRootResultLabel(resultCode?: GitUpdateRootResultCode): string | undefined {
  switch (resultCode) {
    case "SUCCESS":
      return resolveUpdateSessionText("updateSession.results.success", "成功");
    case "NOTHING_TO_UPDATE":
      return resolveUpdateSessionText("updateSession.results.nothingToUpdate", "已是最新");
    case "SKIPPED":
      return resolveUpdateSessionText("updateSession.results.skipped", "已跳过");
    case "CANCEL":
      return resolveUpdateSessionText("updateSession.results.cancelled", "已取消");
    case "INCOMPLETE":
      return resolveUpdateSessionText("updateSession.results.incomplete", "未完成");
    case "NOT_READY":
      return resolveUpdateSessionText("updateSession.results.notReady", "未就绪");
    case "ERROR":
      return resolveUpdateSessionText("updateSession.results.error", "失败");
    default:
      return undefined;
  }
}

/**
 * 把更新方法枚举转换为统一中文文案，供结果详情和控制台聚焦信息复用。
 */
function getUpdateMethodLabel(method?: string): string | undefined {
  switch (String(method || "").trim()) {
    case "merge":
      return resolveUpdateSessionText("updateSession.methods.merge", "合并");
    case "rebase":
      return resolveUpdateSessionText("updateSession.methods.rebase", "变基");
    case "reset":
      return resolveUpdateSessionText("updateSession.methods.reset", "Reset");
    case "fetch":
      return resolveUpdateSessionText("updateSession.methods.fetch", "Fetch");
    case "submodule":
      return resolveUpdateSessionText("updateSession.methods.submodule", "子模块更新");
    default:
      return undefined;
  }
}

/**
 * 将提交范围压缩为短文本，避免结果卡片直接展示完整哈希。
 */
function formatRevisionRange(start?: string, end?: string): string | undefined {
  const startText = String(start || "").trim();
  const endText = String(end || "").trim();
  if (!startText || !endText || startText === endText) return undefined;
  return `${startText.slice(0, 8)}..${endText.slice(0, 8)}`;
}

/**
 * 按“活动中 -> 运行中 -> 已完成”排序 root，保证会话详情优先展示最值得关注的仓库。
 */
function sortViewRoots(left: GitUpdateSessionViewRoot, right: GitUpdateSessionViewRoot): number {
  if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
  if (left.isFinished !== right.isFinished) return left.isFinished ? 1 : -1;
  return left.rootName.localeCompare(right.rootName, "zh-CN");
}

/**
 * 把 fetch 结果压缩为短标签，便于运行态和完成态统一显示远端获取边界。
 */
function getFetchSummary(fetchResult?: GitUpdateSessionProgressRoot["fetchResult"]): string | undefined {
  if (!fetchResult) return undefined;
  if (fetchResult.status === "success") {
    const remoteCount = (Array.isArray(fetchResult.fetchedRemotes) ? fetchResult.fetchedRemotes.length : 0)
      || (Array.isArray(fetchResult.remotes) ? fetchResult.remotes.length : 0);
    return remoteCount > 0
      ? resolveUpdateSessionText("updateSession.fetch.successWithRemoteCount", "获取 {{count}} 个远端", { count: remoteCount })
      : resolveUpdateSessionText("updateSession.fetch.success", "获取成功");
  }
  if (fetchResult.status === "skipped") return fetchResult.skippedReason || resolveUpdateSessionText("updateSession.fetch.skipped", "获取已跳过");
  if (fetchResult.status === "cancelled") return fetchResult.error || resolveUpdateSessionText("updateSession.fetch.cancelled", "获取已取消");
  if (fetchResult.status === "failed") {
    const failedRemote = Array.isArray(fetchResult.failedRemotes) ? fetchResult.failedRemotes[0]?.remote : undefined;
    return failedRemote
      ? resolveUpdateSessionText("updateSession.fetch.failedWithRemote", "获取失败 · {{remote}}", { remote: failedRemote })
      : (fetchResult.error || resolveUpdateSessionText("updateSession.fetch.failed", "获取失败"));
  }
  return undefined;
}

/**
 * 把仓库跳过原因码映射为稳定的前端文案，避免运行态与完成态直接展示主进程自由文本。
 */
function getSkippedReasonText(reasonCode?: string, fallback?: string): string | undefined {
  switch (String(reasonCode || "").trim()) {
    case "requested":
      return resolveUpdateSessionText("updateSession.skippedReasons.requested", "已按当前范围配置跳过");
    case "detached-head":
      return resolveUpdateSessionText("updateSession.skippedReasons.detachedHead", "当前仓库处于游离 HEAD");
    case "no-tracked-branch":
      return resolveUpdateSessionText("updateSession.skippedReasons.noTrackedBranch", "缺少可用的上游分支");
    case "remote-missing":
      return resolveUpdateSessionText("updateSession.skippedReasons.remoteMissing", "上游分支在本地不存在或已失效");
    case "parent-failed":
      return resolveUpdateSessionText("updateSession.skippedReasons.parentFailed", "父仓更新失败");
    case "fetch-failed":
      return resolveUpdateSessionText("updateSession.skippedReasons.fetchFailed", "获取远端失败");
    case "updated-by-parent":
      return resolveUpdateSessionText("updateSession.skippedReasons.updatedByParent", "已由父仓递归更新");
    default:
      return String(fallback || "").trim() || undefined;
  }
}

/**
 * 把 preserving state 转成用户可读文案，明确本地改动已恢复、保留还是恢复失败。
 */
function getPreservingSummary(preservingState?: GitUpdateSessionProgressRoot["preservingState"]): string | undefined {
  if (!preservingState) return undefined;
  const displayName = String(preservingState.savedLocalChangesDisplayName || preservingState.savedLocalChangesRef || "").trim();
  if (preservingState.status === "restored")
    return displayName
      ? resolveUpdateSessionText("updateSession.preserving.restoredWithName", "已恢复 {{name}}", { name: displayName })
      : resolveUpdateSessionText("updateSession.preserving.restored", "本地改动已恢复");
  if (preservingState.status === "saved")
    return displayName
      ? resolveUpdateSessionText("updateSession.preserving.savedWithName", "已暂存 {{name}}", { name: displayName })
      : resolveUpdateSessionText("updateSession.preserving.saved", "本地改动已保存");
  if (preservingState.status === "kept-saved")
    return displayName
      ? resolveUpdateSessionText("updateSession.preserving.keptSavedWithName", "保留 {{name}}", { name: displayName })
      : resolveUpdateSessionText("updateSession.preserving.keptSaved", "本地改动保留为已保存");
  if (preservingState.status === "restore-failed")
    return preservingState.message || (displayName
      ? resolveUpdateSessionText("updateSession.preserving.restoreFailedWithName", "{{name}} 恢复失败", { name: displayName })
      : resolveUpdateSessionText("updateSession.preserving.restoreFailed", "本地改动恢复失败"));
  return preservingState.message || undefined;
}

/**
 * 把 unfinished state 统一为稳定摘要，强调继续/中止前的阻塞原因。
 */
function getUnfinishedSummary(unfinishedState?: GitUpdateSessionProgressRoot["unfinishedState"]): string | undefined {
  if (!unfinishedState) return undefined;
  return String(unfinishedState.message || "").trim() || undefined;
}

/**
 * 把子模块更新模式压缩为短文案，区分 detached 子模块与普通跟踪分支子模块。
 */
function getSubmoduleSummary(submoduleUpdate?: GitUpdateSessionProgressRoot["submoduleUpdate"]): string | undefined {
  if (!submoduleUpdate) return undefined;
  const modeLabel = submoduleUpdate.mode === "detached"
    ? resolveUpdateSessionText("updateSession.submodule.detached", "游离 HEAD 子模块")
    : resolveUpdateSessionText("updateSession.submodule.branch", "子模块分支");
  if (submoduleUpdate.strategy === "updated-by-parent")
    return resolveUpdateSessionText("updateSession.submodule.updatedByParent", "{{mode}} · 由父仓递归更新", { mode: modeLabel });
  if (submoduleUpdate.strategy === "detached-updater")
    return resolveUpdateSessionText("updateSession.submodule.detachedUpdater", "{{mode}} · 独立更新器", { mode: modeLabel });
  return resolveUpdateSessionText("updateSession.submodule.asRoot", "{{mode}} · 作为根仓库执行", { mode: modeLabel });
}

/**
 * 为运行态 root 生成摘要与补充行，避免前端只剩单个 phaseLabel 看不出 fetch/skip/preserve 差异。
 */
function buildRunningRootSummary(root: GitUpdateSessionProgressRoot): {
  summaryLabel: string;
  detailLines: string[];
  badges: string[];
} {
  const skippedReason = getSkippedReasonText(root.skippedReasonCode, root.skippedReason);
  const detailLines = [
    skippedReason,
    getFetchSummary(root.fetchResult),
    getUnfinishedSummary(root.unfinishedState),
    getPreservingSummary(root.preservingState),
    getSubmoduleSummary(root.submoduleUpdate),
  ].filter((line): line is string => !!String(line || "").trim());
  const summaryLabel = skippedReason || detailLines[0] || getUpdatePhaseLabel(root.currentPhase);
  const badges: string[] = [];
  if (root.fetchResult?.status === "failed") badges.push(resolveUpdateSessionText("updateSession.badges.fetchFailed", "获取失败"));
  else if (root.fetchResult?.status === "skipped") badges.push(resolveUpdateSessionText("updateSession.badges.fetchSkipped", "获取跳过"));
  else if (root.fetchResult?.status === "success") badges.push(resolveUpdateSessionText("updateSession.badges.fetchDone", "获取完成"));
  if (root.preservingState?.status === "restore-failed") badges.push(resolveUpdateSessionText("updateSession.badges.restoreFailed", "恢复失败"));
  else if (root.preservingState?.status === "kept-saved") badges.push(resolveUpdateSessionText("updateSession.badges.keptSaved", "保留已保存"));
  if (root.unfinishedState) badges.push(resolveUpdateSessionText("updateSession.badges.unfinished", "未完成状态"));
  if (root.submoduleUpdate?.mode === "detached") badges.push(resolveUpdateSessionText("updateSession.badges.detachedSubmodule", "游离 HEAD 子模块"));
  return {
    summaryLabel,
    detailLines,
    badges,
  };
}

/**
 * 把原始会话快照整理成稳定的视图状态，供工作台渲染运行中 update session。
 */
export function buildUpdateSessionViewState(
  snapshot?: GitUpdateSessionProgressSnapshot | null,
): GitUpdateSessionViewState | null {
  if (!snapshot) return null;
  const activeRepoRoot = String(snapshot.activeRepoRoot || "").trim();
  const roots = Array.isArray(snapshot.roots)
    ? snapshot.roots.map((root) => {
      const resultLabel = getRootResultLabel(root.resultCode);
      const phaseLabel = getUpdatePhaseLabel(root.currentPhase);
      const isActive = !!activeRepoRoot && root.repoRoot === activeRepoRoot;
      const summary = buildRunningRootSummary(root);
      return {
        ...root,
        phaseLabel,
        resultLabel,
        summaryLabel: resultLabel || summary.summaryLabel,
        detailLines: summary.detailLines,
        badges: summary.badges,
        actions: buildRootActions(root),
        isActive,
        isFinished: !!root.resultCode,
      } satisfies GitUpdateSessionViewRoot;
    }).sort(sortViewRoots)
    : [];
  return {
    activeRepoRoot: activeRepoRoot || undefined,
    activeRootName: String(snapshot.activeRootName || "").trim() || roots.find((root) => root.isActive)?.rootName,
    activePhaseLabel: getUpdatePhaseLabel(snapshot.activePhase),
    completedRoots: Math.max(0, Math.floor(Number(snapshot.completedRoots) || 0)),
    remainingRoots: Math.max(0, Math.floor(Number(snapshot.remainingRoots) || 0)),
    runningRoots: Math.max(0, Math.floor(Number(snapshot.runningRoots) || 0)),
    totalRoots: Math.max(0, Math.floor(Number(snapshot.totalRoots) || 0)),
    multiRoot: snapshot.multiRoot === true,
    roots,
  };
}

/**
 * 判断运行态快照是否已无可取消任务，供异常或竞态下把顶部按钮降级为关闭。
 */
export function isUpdateSessionProgressSettled(viewState?: GitUpdateSessionViewState | null): boolean {
  if (!viewState || viewState.totalRoots <= 0) return false;
  if (viewState.runningRoots > 0 || viewState.remainingRoots > 0) return false;
  if (viewState.completedRoots < viewState.totalRoots) return false;
  return viewState.roots.length <= 0 || viewState.roots.every((root) => root.isFinished);
}

/**
 * 为单个 root 结果生成短说明，统一覆盖成功、跳过、失败和“已是最新”语义。
 */
function buildResultRootDetail(root: any): {
  detail: string;
  detailLines: string[];
  badges: string[];
  rangeText?: string;
  methodLabel?: string;
} {
  const resultCode = String(root?.resultCode || "").trim() as GitUpdateRootResultCode;
  const methodLabel = getUpdateMethodLabel(root?.method);
  const upstream = String(root?.upstream || "").trim();
  const rangeText = formatRevisionRange(root?.updatedRange?.start, root?.updatedRange?.end);
  const skippedReason = getSkippedReasonText(root?.skippedReasonCode, root?.skippedReason);
  const error = String(root?.error || "").trim();
  const detailLines = [
    skippedReason || undefined,
    getFetchSummary(root?.fetchResult),
    getUnfinishedSummary(root?.unfinishedState),
    getPreservingSummary(root?.preservingState),
    getSubmoduleSummary(root?.submoduleUpdate),
  ].filter((line): line is string => !!String(line || "").trim());
  const badges: string[] = [];
  if (root?.fetchResult?.status === "failed") badges.push(resolveUpdateSessionText("updateSession.badges.fetchFailed", "获取失败"));
  if (root?.fetchResult?.status === "skipped") badges.push(resolveUpdateSessionText("updateSession.badges.fetchSkipped", "获取跳过"));
  if (root?.preservingState?.status === "restore-failed") badges.push(resolveUpdateSessionText("updateSession.badges.restoreFailed", "恢复失败"));
  if (root?.preservingState?.status === "kept-saved") badges.push(resolveUpdateSessionText("updateSession.badges.keptSaved", "保留已保存"));
  if (root?.submoduleUpdate?.mode === "detached") badges.push(resolveUpdateSessionText("updateSession.badges.detachedSubmodule", "游离 HEAD 子模块"));
  if (resultCode === "SUCCESS") {
    if (rangeText && methodLabel)
      return {
        detail: resolveUpdateSessionText("updateSession.detail.updatedWithMethodAndRange", "{{method}} · {{range}}", { method: methodLabel, range: rangeText }),
        rangeText,
        methodLabel,
        detailLines,
        badges,
      };
    if (rangeText)
      return {
        detail: resolveUpdateSessionText("updateSession.detail.updatedRange", "已更新 · {{range}}", { range: rangeText }),
        rangeText,
        methodLabel,
        detailLines,
        badges,
      };
    if (methodLabel)
      return {
        detail: resolveUpdateSessionText("updateSession.detail.updatedMethodDone", "{{method}} 已完成", { method: methodLabel }),
        rangeText,
        methodLabel,
        detailLines,
        badges,
      };
    return { detail: resolveUpdateSessionText("updateSession.detail.updatedSuccess", "更新成功"), rangeText, methodLabel, detailLines, badges };
  }
  if (resultCode === "NOTHING_TO_UPDATE") {
    return {
      detail: upstream
        ? resolveUpdateSessionText("updateSession.detail.upToDateWithUpstream", "跟踪 {{upstream}}，当前已是最新", { upstream })
        : resolveUpdateSessionText("updateSession.detail.upToDate", "当前已是最新"),
      rangeText,
      methodLabel,
      detailLines,
      badges,
    };
  }
  if (resultCode === "SKIPPED") {
    return {
      detail: skippedReason || resolveUpdateSessionText("updateSession.detail.skipped", "当前仓库已跳过"),
      rangeText,
      methodLabel,
      detailLines,
      badges,
    };
  }
  if (error) return { detail: error, rangeText, methodLabel, detailLines, badges };
  if (skippedReason) return { detail: skippedReason, rangeText, methodLabel, detailLines, badges };
  if (methodLabel)
    return {
      detail: resolveUpdateSessionText("updateSession.detail.notCompletedWithMethod", "{{method}} 未完成", { method: methodLabel }),
      rangeText,
      methodLabel,
      detailLines,
      badges,
    };
  return { detail: resolveUpdateSessionText("updateSession.detail.notCompleted", "更新未完成"), rangeText, methodLabel, detailLines, badges };
}

/**
 * 从更新结果数据中提取 root 级详情，供完成态卡片展开查看。
 */
export function buildUpdateSessionResultViewState(
  notification?: GitUpdateSessionNotificationData | null,
  resultData?: any,
): GitUpdateSessionResultViewState | null {
  const roots: GitUpdateSessionResultRootViewState[] = Array.isArray(resultData?.roots)
    ? resultData.roots
      .map((root: any) => {
        const repoRoot = String(root?.repoRoot || "").trim();
        const rootName = String(root?.rootName || "").trim();
        const resultCode = String(root?.resultCode || "").trim() as GitUpdateRootResultCode;
        const resultLabel = getRootResultLabel(resultCode);
        if (!repoRoot || !rootName || !resultLabel) return null;
        const { detail, detailLines, badges, methodLabel, rangeText } = buildResultRootDetail(root);
        return {
          repoRoot,
          rootName,
          kind: root?.kind === "submodule" ? "submodule" : "repository",
          resultCode,
          resultLabel,
          detail,
          detailLines,
          badges,
          actions: buildRootActions(root),
          methodLabel,
          rangeText,
          isUpdated: !!rangeText,
          isProblematic: resultCode === "ERROR" || resultCode === "INCOMPLETE" || resultCode === "NOT_READY" || resultCode === "CANCEL",
        } satisfies GitUpdateSessionResultRootViewState;
      })
      .filter((root: GitUpdateSessionResultRootViewState | null): root is GitUpdateSessionResultRootViewState => !!root)
    : [];
  if (!notification && roots.length <= 0) return null;
  const primaryRange = notification?.primaryRange || notification?.ranges?.[0];
  const rangeText = notification?.ranges && notification.ranges.length > 1
    ? resolveUpdateSessionText("updateSession.result.multipleRanges", "共 {{count}} 个更新范围", { count: notification.ranges.length })
    : primaryRange
      ? resolveUpdateSessionText("updateSession.result.primaryRange", "{{rootName}} · {{range}}", {
          rootName: primaryRange.rootName,
          range: formatRevisionRange(primaryRange.range.start, primaryRange.range.end) || resolveUpdateSessionText("updateSession.result.updated", "已更新"),
        })
      : roots.find((root) => root.rangeText)?.rangeText;
  const skippedSummary = notification?.skippedRoots && notification.skippedRoots.length > 0
    ? notification.skippedRoots
      .slice(0, 3)
      .map((root) => `${root.rootName}（${root.reason}）`)
      .join("、")
    : undefined;
  return {
    title: String(notification?.title || "").trim() || resolveUpdateSessionText("updateSession.result.title", "更新项目已完成"),
    description: String(notification?.description || "").trim() || undefined,
    updatedFilesCount: typeof notification?.updatedFilesCount === "number" ? notification.updatedFilesCount : undefined,
    receivedCommitsCount: typeof notification?.receivedCommitsCount === "number" ? notification.receivedCommitsCount : undefined,
    filteredCommitsCount: typeof notification?.filteredCommitsCount === "number" ? notification.filteredCommitsCount : undefined,
    rangeText: rangeText || undefined,
    skippedSummary,
    postActions: buildResultSummaryPostActions(roots),
    roots,
  };
}

/**
 * 在收到运行中活动后更新会话条目；若首次出现，则按 requestId 创建新条目。
 */
export function upsertRunningUpdateSessionEntry(
  entries: GitUpdateSessionEntryState[],
  args: UpsertRunningUpdateSessionArgs,
): GitUpdateSessionEntryState[] {
  const nextViewState = buildUpdateSessionViewState(args.snapshot);
  const index = entries.findIndex((entry) => entry.requestId === args.requestId);
  if (index >= 0) {
    const next = entries.slice();
    const current = next[index];
    next[index] = {
      ...current,
      lifecycle: "running",
      updatedAt: args.now,
      tone: "info",
      message: args.message,
      autoCloseAt: undefined,
      snapshot: args.snapshot || current.snapshot,
      viewState: nextViewState || current.viewState,
    };
    return next;
  }
  const shouldExpand = nextViewState?.multiRoot === true || (nextViewState?.roots.length || 0) > 1;
  return [
    {
      requestId: args.requestId,
      lifecycle: "running",
      createdAt: args.now,
      updatedAt: args.now,
      tone: "info",
      message: args.message,
      expanded: shouldExpand,
      snapshot: args.snapshot || undefined,
      viewState: nextViewState || undefined,
    },
    ...entries,
  ];
}

/**
 * 在更新完成后把条目切换为结果态，并带上 30 秒自动关闭的过期时间。
 */
export function finalizeUpdateSessionEntry(
  entries: GitUpdateSessionEntryState[],
  args: FinalizeUpdateSessionArgs,
): GitUpdateSessionEntryState[] {
  const nextResultView = buildUpdateSessionResultViewState(args.notification, args.resultData);
  const shouldExpand = (nextResultView?.roots.length || 0) > 1
    || nextResultView?.roots.some((root) => root.isProblematic || root.actions.length > 0) === true;
  const index = entries.findIndex((entry) => entry.requestId === args.requestId);
  if (index >= 0) {
    const next = entries.slice();
    const current = next[index];
    next[index] = {
      ...current,
      lifecycle: "finished",
      updatedAt: args.now,
      tone: args.tone,
      message: args.message,
      autoCloseAt: args.now + args.autoCloseDelayMs,
      snapshot: undefined,
      notification: args.notification || undefined,
      resultView: nextResultView || current.resultView,
      expanded: shouldExpand || current.expanded,
    };
    return next;
  }
  return [
    {
      requestId: args.requestId,
      lifecycle: "finished",
      createdAt: args.now,
      updatedAt: args.now,
      tone: args.tone,
      message: args.message,
      expanded: shouldExpand,
      autoCloseAt: args.now + args.autoCloseDelayMs,
      notification: args.notification || undefined,
      resultView: nextResultView || undefined,
    },
    ...entries,
  ];
}

/**
 * 切换指定会话条目的展开状态，供运行态和完成态卡片共用。
 */
export function toggleUpdateSessionEntryExpanded(
  entries: GitUpdateSessionEntryState[],
  requestId: number,
): GitUpdateSessionEntryState[] {
  return entries.map((entry) => entry.requestId === requestId ? { ...entry, expanded: !entry.expanded } : entry);
}

/**
 * 将指定会话条目标记为已关闭，便于工作台统一清理焦点和定时器。
 */
export function dismissUpdateSessionEntry(
  entries: GitUpdateSessionEntryState[],
  requestId: number,
): GitUpdateSessionEntryState[] {
  return entries
    .map((entry) => entry.requestId === requestId ? { ...entry, lifecycle: "dismissed" as const } : entry)
    .filter((entry) => entry.lifecycle !== "dismissed");
}
