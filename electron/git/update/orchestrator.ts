import path from "node:path";
import { toFsPathKey } from "../pathKey";
import { buildRootFetchPlanAsync, executeRootFetchPlanAsync } from "./fetch";
import { buildUpdateSessionNotificationAsync } from "./notifications";
import { aggregateUpdateRootResults, buildRepositoryGraphAsync } from "./repositoryGraph";
import type { GitChangesSaverRuntime } from "./changeSaver";
import { createWorkspaceChangesSaver, GitPreservingProcess } from "./preservingProcess";
import {
  createUpdateExecutionSession,
  finalizeUpdateExecutionSession,
  markUpdateSessionCancelled,
  recordUpdateRootFetchResult,
  recordUpdateRootResult,
  recordUpdateSessionPhase,
  resolveCompoundResultCode,
} from "./session";
import { planMergeUpdateAsync, runMergeUpdateCoreAsync } from "./updaters/merge";
import { planRebaseUpdateAsync, runRebaseUpdateCoreAsync } from "./updaters/rebase";
import { planResetUpdateAsync, runResetUpdateCoreAsync } from "./updaters/reset";
import { runSubmoduleUpdateCoreAsync } from "./updaters/submodule";
import type {
  GitUpdateCommitRange,
  GitTrackedRemoteRef,
  GitUpdateActionResult,
  GitUpdateAggregatedSession,
  GitUpdateExecutionSession,
  GitUpdateFetchResult,
  GitUpdateMethodResolution,
  GitUpdateOperationProblem,
  GitUpdateOrchestratorRuntime,
  GitUpdateRepositoryNode,
  GitUpdateRebaseRuntime,
  GitUpdateResultCode,
  GitUpdateMergeRuntime,
  GitUpdateRootRuntime,
  GitUpdateRootSessionResult,
  GitUpdateSubmoduleRuntime,
  GitUpdateSessionProgressSnapshot,
  GitUpdateSkipReasonCode,
  GitUpdateSubmoduleUpdate,
  GitUpdateSubmoduleUpdateStrategy,
  GitUpdateResetRuntime,
} from "./types";

type GitExecutedRootResult = Omit<GitUpdateRootSessionResult, "rootName" | "kind" | "parentRepoRoot">;
type GitPreparedRootKind = "branch" | "detached-submodule";

type GitPreparedRootContext = {
  node: GitUpdateRepositoryNode;
  runtime: GitUpdateRootRuntime;
  kind: GitPreparedRootKind;
  branch?: string;
  trackedRemote?: GitTrackedRemoteRef;
  upstreamRef?: string;
  submoduleUpdate?: GitUpdateSubmoduleUpdate;
  fetchResult?: GitUpdateFetchResult;
};

type GitPlannedExecutableUpdateKind = "merge" | "rebase" | "reset" | "submodule";

type GitPreparedRootUpdatePlan =
  | {
      type: "result";
      result: GitExecutedRootResult;
    }
  | {
      type: "execute";
      context: GitPreparedRootContext;
      updateKind: GitPlannedExecutableUpdateKind;
      methodResolution: GitUpdateMethodResolution;
      saveRepoRoot?: string;
      updatedRangeStart?: string;
      runAsync(): Promise<GitUpdateActionResult>;
    };

/**
 * 判断根级失败是否可在多仓场景下降级为 skipped root。
 */
function isSoftSkipEligibleFailureCode(
  code?: GitExecutedRootResult["failureCode"],
): code is Extract<GitExecutedRootResult["failureCode"], "detached-head" | "no-tracked-branch"> {
  return code === "detached-head" || code === "no-tracked-branch";
}

/**
 * 根据单仓更新返回结果推导聚合层 result code，尽量贴近 IDEA `GitUpdateResult`。
 */
function resolveExecutedRootResultCode(result: GitUpdateActionResult): GitUpdateResultCode {
  const errorText = String(result.error || "").trim().toLowerCase();
  if (errorText === "aborted" || result.data?.resultCode === "CANCEL") {
    return "CANCEL";
  }
  if (result.data?.resultCode === "INCOMPLETE" || result.data?.unfinishedState?.stage === "update") {
    return "INCOMPLETE";
  }
  if (result.ok) {
    if (result.data?.nothingToUpdate === true || result.data?.method === "none") {
      return "NOTHING_TO_UPDATE";
    }
    return "SUCCESS";
  }
  return "ERROR";
}

/**
 * 为子模块构建稳定的更新元数据，区分普通 root、Detached 专用 updater 与递归父子模块跳过。
 */
function buildSubmoduleUpdateMetadata(
  node: Pick<GitUpdateRepositoryNode, "repoRoot" | "kind" | "submoduleMode" | "parentRepoRoot" | "detachedHead">,
  strategy: GitUpdateSubmoduleUpdateStrategy,
): GitUpdateSubmoduleUpdate | undefined {
  if (node.kind !== "submodule") return undefined;
  const parentRepoRoot = String(node.parentRepoRoot || "").trim() || undefined;
  const relativePath = parentRepoRoot ? path.relative(parentRepoRoot, node.repoRoot).replace(/\\/g, "/") : undefined;
  return {
    mode: node.submoduleMode || (node.detachedHead ? "detached" : "branch"),
    strategy,
    parentRepoRoot,
    relativePath: relativePath && relativePath !== "." ? relativePath : undefined,
    recursive: strategy !== "root",
    detachedHead: node.detachedHead,
  };
}

/**
 * 为 root 级结果补齐 graph 元数据，保证聚合结果可直接回传给会话层。
 */
function attachNodeMetadata(
  node: GitUpdateRepositoryNode,
  result: GitExecutedRootResult,
): GitUpdateRootSessionResult {
  return {
    ...result,
    rootName: node.rootName,
    kind: node.kind,
    submoduleUpdate: result.submoduleUpdate || buildSubmoduleUpdateMetadata(
      node,
      node.kind === "submodule" && node.submoduleMode === "detached" ? "detached-updater" : "root",
    ),
    parentRepoRoot: node.parentRepoRoot,
  };
}

/**
 * 为 skipped root 生成统一的结果对象，便于后续聚合与 UI 展示。
 */
function buildSkippedRootResult(
  node: GitUpdateRepositoryNode,
  reasonCode: GitUpdateSkipReasonCode,
  reason: string,
  source?: Partial<GitExecutedRootResult>,
): GitUpdateRootSessionResult {
  return {
    repoRoot: node.repoRoot,
    rootName: node.rootName,
    kind: node.kind,
    submoduleUpdate: source?.submoduleUpdate || buildSubmoduleUpdateMetadata(
      node,
      reasonCode === "updated-by-parent" ? "updated-by-parent" : node.kind === "submodule" && node.submoduleMode === "detached"
        ? "detached-updater"
        : "root",
    ),
    parentRepoRoot: node.parentRepoRoot,
    ok: true,
    resultCode: "SKIPPED",
    branch: source?.branch,
    upstream: source?.upstream,
    method: source?.method,
    nothingToUpdate: source?.nothingToUpdate,
    data: source?.data,
    failureCode: source?.failureCode,
    fetchResult: source?.fetchResult,
    skippedReasonCode: reasonCode,
    skippedReason: reason,
  };
}

/**
 * 生成“父仓失败后跳过子仓”的提示文本，突出依赖顺序导致的跳过原因。
 */
function buildParentFailedReason(node: GitUpdateRepositoryNode): string {
  const parentName = node.parentRepoRoot ? path.basename(node.parentRepoRoot) || node.parentRepoRoot : "父仓";
  return `父仓 ${parentName} 更新失败，已跳过当前仓库`;
}

/**
 * 生成“父级 Detached 子模块会递归更新当前子模块”的跳过提示，避免重复执行专用 updater。
 */
function buildUpdatedByParentReason(node: GitUpdateRepositoryNode): string {
  const parentName = node.parentRepoRoot ? path.basename(node.parentRepoRoot) || node.parentRepoRoot : "父级子模块";
  return `父级子模块 ${parentName} 会以递归方式更新当前子模块，已跳过独立更新`;
}

/**
 * 生成 fetch 阶段失败后用于跳过其余 root updater 的提示文本。
 */
function buildFetchBlockedReason(node: GitUpdateRepositoryNode): string {
  return `fetch 阶段存在失败仓库，已跳过 ${node.rootName} 的 updater 执行`;
}

/**
 * 将软失败原因码翻译为用户可读的 skipped reason。
 */
function resolveSoftSkipReason(
  node: GitUpdateRepositoryNode,
  reasonCode: Extract<GitUpdateSkipReasonCode, "detached-head" | "no-tracked-branch" | "remote-missing">,
  fallback?: string,
): string {
  if (fallback) return fallback;
  if (reasonCode === "detached-head") {
    return node.kind === "submodule"
      ? "子模块当前处于 Detached HEAD，已暂时跳过"
      : "当前仓库处于 Detached HEAD，已暂时跳过";
  }
  if (reasonCode === "no-tracked-branch") {
    return "当前分支未配置远端上游分支，已暂时跳过";
  }
  return "当前仓库缺少可用的远端跟踪引用，已暂时跳过";
}

/**
 * 判断当前 root 运行期是否已收到取消请求；若已取消则返回统一的取消结果。
 */
function resolveCancelledRootResult(
  runtime: Pick<GitUpdateRootRuntime, "repoRoot" | "isCancellationRequested" | "getCancellationReason">,
  fallbackMessage: string,
  source?: Partial<GitExecutedRootResult>,
): GitExecutedRootResult | null {
  if (!runtime.isCancellationRequested()) return null;
  const message = String(runtime.getCancellationReason() || "").trim() || fallbackMessage;
  return {
    repoRoot: runtime.repoRoot,
    ok: false,
    resultCode: "CANCEL",
    branch: source?.branch,
    upstream: source?.upstream,
    configuredMethod: source?.configuredMethod,
    methodResolvedSource: source?.methodResolvedSource,
    method: source?.method,
    submoduleUpdate: source?.submoduleUpdate,
    fetchResult: source?.fetchResult,
    error: message,
    data: {
      ...(source?.data && typeof source.data === "object" ? source.data : {}),
      cancelled: true,
      resultCode: "CANCEL",
      ...(source?.fetchResult ? { fetchResult: source.fetchResult } : {}),
    },
  };
}

/**
 * 为当前 root 记录阶段开始/结束事件，形成显式的 orchestrator phase 轨迹。
 */
function recordRootPhase(
  session: GitUpdateExecutionSession,
  repoRoot: string,
  phase: Parameters<typeof recordUpdateSessionPhase>[1],
  status: Parameters<typeof recordUpdateSessionPhase>[2],
  message: string,
  progress?: {
    runtime: Pick<GitUpdateRootRuntime, "emitProgress">;
    detail?: string;
  },
): void {
  recordUpdateSessionPhase(session, phase, status, message, repoRoot);
  if (progress) {
    emitUpdateSessionProgress(progress.runtime, session, message, progress.detail);
  }
}

/**
 * 把 fetch 结果摘要转成阶段记录文案，便于 session/rootState 明确反映 fetch 边界。
 */
function buildFetchPhaseSummary(fetchResult: GitUpdateFetchResult): string {
  if (fetchResult.status === "success") {
    const remoteText = fetchResult.fetchedRemotes.length > 0
      ? fetchResult.fetchedRemotes.join("、")
      : fetchResult.remotes.join("、");
    return remoteText ? `已完成远端获取：${remoteText}` : "已完成远端获取";
  }
  if (fetchResult.status === "skipped") {
    return fetchResult.skippedReason || "已跳过当前 root 的 fetch";
  }
  return fetchResult.error || "fetch 阶段执行失败";
}

/**
 * 读取当前 root 的 HEAD 提交哈希，供后续生成结构化更新范围。
 */
async function resolveHeadCommitAsync(
  runtime: Pick<GitUpdateRootRuntime, "runGitExecAsync">,
): Promise<string | undefined> {
  const res = await runtime.runGitExecAsync(["rev-parse", "HEAD"], 10_000);
  if (!res.ok) return undefined;
  const head = String(res.stdout || "").trim();
  return head || undefined;
}

/**
 * 读取本地分支与跟踪分支的 merge-base，供 updated ranges 对齐 IDEA 的 published tip 语义。
 */
async function resolveMergeBaseCommitAsync(
  runtime: Pick<GitUpdateRootRuntime, "runGitExecAsync">,
  firstRef?: string,
  secondRef?: string,
): Promise<string | undefined> {
  const leftRef = String(firstRef || "").trim();
  const rightRef = String(secondRef || "").trim();
  if (!leftRef || !rightRef) return undefined;
  const res = await runtime.runGitExecAsync(["merge-base", leftRef, rightRef], 10_000);
  if (!res.ok) return undefined;
  const mergeBase = String(res.stdout || "").trim();
  return mergeBase || undefined;
}

/**
 * 根据更新前后的 published tip/merge-base 构建提交范围；若未发生移动则不返回范围。
 */
function buildUpdatedCommitRange(
  start?: string,
  end?: string,
): GitUpdateCommitRange | undefined {
  const from = String(start || "").trim();
  const to = String(end || "").trim();
  if (!from || !to || from === to) return undefined;
  return {
    start: from,
    end: to,
  };
}

/**
 * 把执行会话压缩为前端可直接渲染的进度快照，避免渲染层再从 phase history 反推状态。
 */
function buildUpdateSessionProgressSnapshot(
  session: GitUpdateExecutionSession,
): GitUpdateSessionProgressSnapshot {
  const rootItems = Object.values(session.rootStates).map((rootState) => ({
    repoRoot: rootState.repoRoot,
    rootName: String(rootState.rootName || "").trim() || rootState.repoRoot,
    kind: rootState.kind || "repository",
    parentRepoRoot: String(rootState.parentRepoRoot || "").trim() || undefined,
    currentPhase: rootState.currentPhase,
    resultCode: rootState.resultCode,
    failureCode: rootState.failureCode,
    skippedReason: String(rootState.skippedReason || "").trim() || undefined,
    skippedReasonCode: rootState.skippedReasonCode,
    fetchResult: rootState.fetchResult,
    unfinishedState: rootState.unfinishedState,
    preservingState: rootState.preservingState,
    submoduleUpdate: rootState.submoduleUpdate,
    operationProblem: rootState.operationProblem,
  }));
  const activeRoot = [...rootItems].reverse().find((root) => !root.resultCode && !!root.currentPhase);
  const completedRoots = rootItems.filter((root) => !!root.resultCode).length;
  const runningRoots = rootItems.filter((root) => !root.resultCode && !!root.currentPhase).length;
  return {
    requestedRepoRoot: session.requestedRepoRoot,
    currentPhase: session.currentPhase,
    activeRepoRoot: activeRoot?.repoRoot,
    activeRootName: activeRoot?.rootName,
    activePhase: activeRoot?.currentPhase,
    cancelled: session.cancelled,
    cancelReason: session.cancelReason,
    totalRoots: rootItems.length,
    completedRoots,
    runningRoots,
    remainingRoots: Math.max(0, rootItems.length - completedRoots),
    multiRoot: rootItems.length > 1,
    roots: rootItems,
  };
}

/**
 * 在会话进度发生变化后主动广播最新快照，供前端顶部会话视图实时刷新。
 */
function emitUpdateSessionProgress(
  runtime: Pick<GitUpdateRootRuntime, "emitProgress">,
  session: GitUpdateExecutionSession,
  message: string,
  detail?: string,
): void {
  runtime.emitProgress(message, detail, buildUpdateSessionProgressSnapshot(session));
}

/**
 * 把 fetch 取消结果转换为统一的 root 级取消结果。
 */
function buildCancelledResultFromFetch(
  context: GitPreparedRootContext,
  fetchResult: GitUpdateFetchResult,
): GitExecutedRootResult {
  return {
    repoRoot: context.runtime.repoRoot,
    ok: false,
    resultCode: "CANCEL",
    branch: context.branch,
    upstream: context.upstreamRef,
    method: context.kind === "detached-submodule" ? "submodule" : undefined,
    submoduleUpdate: context.submoduleUpdate,
    fetchResult,
    error: fetchResult.error || "更新项目已取消",
    data: {
      cancelled: true,
      resultCode: "CANCEL",
      fetchResult,
    },
  };
}

/**
 * 把 fetch 失败结果转换为 root 级失败结果，阻断后续 updater 执行。
 */
function buildFetchFailureRootResult(
  context: GitPreparedRootContext,
  fetchResult: GitUpdateFetchResult,
): GitExecutedRootResult {
  return {
    repoRoot: context.runtime.repoRoot,
    ok: false,
    resultCode: "NOT_READY",
    branch: context.branch,
    upstream: context.upstreamRef,
    method: context.kind === "detached-submodule" ? "submodule" : undefined,
    submoduleUpdate: context.submoduleUpdate,
    fetchResult,
    error: fetchResult.error || "fetch 阶段执行失败，已停止更新",
    failureCode: "fetch-failed",
    data: {
      resultCode: "NOT_READY",
      fetchResult,
    },
  };
}

/**
 * 把普通 root 的 fetch 跳过结果转换为 root 级未就绪结果，避免在未取回远端信息时继续执行 updater。
 */
function buildFetchSkippedRootResult(
  context: GitPreparedRootContext,
  fetchResult: GitUpdateFetchResult,
): GitExecutedRootResult {
  return {
    repoRoot: context.runtime.repoRoot,
    ok: false,
    resultCode: "NOT_READY",
    branch: context.branch,
    upstream: context.upstreamRef,
    submoduleUpdate: context.submoduleUpdate,
    fetchResult,
    error: fetchResult.skippedReason || "当前 root 的 fetch 已跳过，无法继续更新",
    data: {
      resultCode: "NOT_READY",
      fetchResult,
    },
  };
}

/**
 * 为普通 root 预先解析 preflight 与 tracked branch，形成后续全局 fetch 阶段所需的上下文。
 */
async function prepareRootUpdateContextAsync(
  node: GitUpdateRepositoryNode,
  runtime: GitUpdateRootRuntime,
  payload: any,
  session: GitUpdateExecutionSession,
): Promise<{ ready: true; context: GitPreparedRootContext } | { ready: false; result: GitExecutedRootResult }> {
  if (node.kind === "submodule" && node.submoduleMode === "detached") {
    const submoduleUpdate = buildSubmoduleUpdateMetadata(node, "detached-updater") || {
      mode: "detached" as const,
      strategy: "detached-updater" as const,
      parentRepoRoot: String(node.parentRepoRoot || "").trim() || undefined,
      recursive: true,
      detachedHead: true,
    };
    const cancelledBeforeStart = resolveCancelledRootResult(runtime, "更新项目已取消", {
      method: "submodule",
      submoduleUpdate,
    });
    if (cancelledBeforeStart) {
      recordRootPhase(session, runtime.repoRoot, "preflight", "cancelled", cancelledBeforeStart.error || "更新项目已取消", { runtime });
      return { ready: false, result: cancelledBeforeStart };
    }

    const parentRepoRoot = String(node.parentRepoRoot || "").trim();
    if (!parentRepoRoot) {
      recordRootPhase(session, runtime.repoRoot, "preflight", "completed", "未识别到 Detached 子模块父仓", { runtime });
      return {
        ready: false,
        result: {
          repoRoot: runtime.repoRoot,
          ok: false,
          resultCode: "ERROR",
          method: "submodule",
          error: "未识别到 Detached 子模块的父仓，无法执行子模块更新",
          submoduleUpdate,
        },
      };
    }

    recordRootPhase(session, runtime.repoRoot, "preflight", "running", "正在识别 Detached 子模块更新上下文", { runtime });
    runtime.emitProgress("正在识别 Detached 子模块更新上下文");
    recordRootPhase(session, runtime.repoRoot, "preflight", "completed", "Detached 子模块将通过父仓递归更新", { runtime });
    recordRootPhase(session, runtime.repoRoot, "tracked-branch-config", "running", "Detached 子模块无需检查 tracked branch", { runtime });
    recordRootPhase(session, runtime.repoRoot, "tracked-branch-config", "completed", "已跳过 Detached 子模块 tracked branch 检查", { runtime });
    return {
      ready: true,
      context: {
        node,
        runtime,
        kind: "detached-submodule",
        submoduleUpdate,
      },
    };
  }

  const cancelledBeforeStart = resolveCancelledRootResult(runtime, "更新项目已取消");
  if (cancelledBeforeStart) {
    recordRootPhase(session, runtime.repoRoot, "preflight", "cancelled", cancelledBeforeStart.error || "更新项目已取消", { runtime });
    return { ready: false, result: cancelledBeforeStart };
  }

  recordRootPhase(session, runtime.repoRoot, "preflight", "running", "正在检查更新前置条件", { runtime });
  runtime.emitProgress("正在检查更新前置条件");
  const preflight = await runtime.prepareUpdateProjectContextAsync(payload);
  recordRootPhase(session, runtime.repoRoot, "preflight", "completed", preflight.ok ? "更新前置条件检查通过" : preflight.error, { runtime });
  if (!preflight.ok) {
    return {
      ready: false,
      result: {
        repoRoot: runtime.repoRoot,
        ok: false,
        resultCode: "NOT_READY",
        error: preflight.error,
        branch: preflight.branch,
        failureCode: preflight.code,
        unfinishedState: preflight.unfinishedState,
        localChangesRestorePolicy: preflight.unfinishedState?.localChangesRestorePolicy,
        data: preflight.unfinishedState
          ? {
              resultCode: "NOT_READY",
              unfinishedState: preflight.unfinishedState,
              localChangesRestorePolicy: preflight.unfinishedState.localChangesRestorePolicy,
            }
          : undefined,
      },
    };
  }

  recordRootPhase(session, runtime.repoRoot, "tracked-branch-config", "running", "正在解析 tracked branch 配置", { runtime });
  const trackedRemote = preflight.trackedSource === "override"
    ? {
        upstream: preflight.upstream,
        remote: preflight.upstreamPair?.remote || "",
        branch: preflight.upstreamPair?.branch || "",
      }
    : await runtime.resolveBranchTrackedRemoteAsync(preflight.branch);
  if (!trackedRemote?.upstream || !trackedRemote.remote || !trackedRemote.branch) {
    recordRootPhase(session, runtime.repoRoot, "tracked-branch-config", "completed", `当前分支 ${preflight.branch} 缺少有效 tracked branch`, { runtime });
    return {
      ready: false,
      result: {
        repoRoot: runtime.repoRoot,
        ok: false,
        resultCode: "NOT_READY",
        branch: preflight.branch,
        error: `当前分支 ${preflight.branch} 未配置有效上游分支，无法执行更新项目`,
        failureCode: "no-tracked-branch",
      },
    };
  }
  recordRootPhase(session, runtime.repoRoot, "tracked-branch-config", "completed", `${preflight.branch} -> ${trackedRemote.upstream}`, { runtime });
  return {
    ready: true,
    context: {
      node,
      runtime,
      kind: "branch",
      branch: preflight.branch,
      trackedRemote,
      upstreamRef: trackedRemote.upstream,
      submoduleUpdate: buildSubmoduleUpdateMetadata(node, "root"),
    },
  };
}

/**
 * 执行显式 fetch 阶段，并把结构化 fetch 结果同步写回 root 上下文与执行会话。
 */
async function executePreparedRootFetchAsync(
  context: GitPreparedRootContext,
  payload: any,
  session: GitUpdateExecutionSession,
): Promise<GitUpdateFetchResult> {
  if (context.kind === "detached-submodule") {
    recordRootPhase(session, context.runtime.repoRoot, "fetch", "running", "Detached 子模块无需单独获取远端", { runtime: context.runtime });
    const skippedFetch: GitUpdateFetchResult = {
      status: "skipped",
      strategy: "tracked-remote",
      remotes: [],
      fetchedRemotes: [],
      failedRemotes: [],
      skippedReason: "Detached 子模块将通过父仓递归更新，已跳过独立 fetch",
    };
    context.fetchResult = skippedFetch;
    recordUpdateRootFetchResult(session, context.runtime.repoRoot, skippedFetch);
    recordRootPhase(session, context.runtime.repoRoot, "fetch", "completed", buildFetchPhaseSummary(skippedFetch), { runtime: context.runtime });
    return skippedFetch;
  }

  recordRootPhase(session, context.runtime.repoRoot, "fetch", "running", "正在规划并执行 fetch 阶段", { runtime: context.runtime });
  const plan = await buildRootFetchPlanAsync(context.runtime, payload, context.trackedRemote!);
  const fetchResult = await executeRootFetchPlanAsync(context.runtime, payload, plan);
  context.fetchResult = fetchResult;
  recordUpdateRootFetchResult(session, context.runtime.repoRoot, fetchResult);
  recordRootPhase(
    session,
    context.runtime.repoRoot,
    "fetch",
    fetchResult.status === "cancelled" ? "cancelled" : "completed",
    buildFetchPhaseSummary(fetchResult),
    { runtime: context.runtime },
  );
  return fetchResult;
}

/**
 * 把更新方法转换为人类可读名称，供进度与阶段记录复用。
 */
function toUpdateMethodLabel(method: GitPlannedExecutableUpdateKind | GitUpdateMethodResolution["resolvedMethod"]): string {
  if (method === "rebase") return "Rebase";
  if (method === "reset") return "Reset";
  if (method === "submodule") return "Detached 子模块";
  return "Merge";
}

/**
 * 把普通 root 的 update 结果压成聚合层统一结构，并补齐 preserving 对应的宿主 root 信息。
 */
function buildExecutedBranchRootResult(
  context: GitPreparedRootContext,
  methodResolution: GitUpdateMethodResolution,
  updateResult: GitUpdateActionResult,
  updatedRange?: GitUpdateCommitRange,
  preservingRepoRoot?: string,
): GitExecutedRootResult {
  const updateMethod = methodResolution.resolvedMethod;
  const normalizedPreservingRepoRoot = String(
    updateResult.data?.preservingRepoRoot || preservingRepoRoot || context.runtime.repoRoot || "",
  ).trim();
  return {
    repoRoot: context.runtime.repoRoot,
    ok: updateResult.ok,
    resultCode: resolveExecutedRootResultCode(updateResult),
    branch: context.branch,
    upstream: context.upstreamRef,
    configuredMethod: methodResolution.selectedMethod,
    methodResolvedSource: methodResolution.resolvedSource,
    method: String(updateResult.data?.method || updateMethod || "").trim() || updateMethod,
    nothingToUpdate: updateResult.data?.nothingToUpdate === true || updateResult.data?.method === "none",
    error: updateResult.error,
    fetchResult: context.fetchResult,
    updatedRange,
    unfinishedState: updateResult.data?.unfinishedState,
    localChangesRestorePolicy: updateResult.data?.localChangesRestorePolicy,
    preservingState: updateResult.data?.preservingState,
    submoduleUpdate: updateResult.data?.submoduleUpdate || context.submoduleUpdate,
    data: {
      ...(updateResult.data && typeof updateResult.data === "object" ? updateResult.data : {}),
      configuredMethod: methodResolution.selectedMethod,
      methodResolvedSource: methodResolution.resolvedSource,
      selectionSource: methodResolution.selectionSource,
      saveChangesPolicy: methodResolution.saveChangesPolicy,
      fetchResult: context.fetchResult,
      updatedRange,
      preservingRepoRoot: normalizedPreservingRepoRoot || undefined,
    },
  };
}

/**
 * 把 Detached 子模块 update 结果压成聚合层统一结构，并显式映射到父仓 preserving 宿主。
 */
function buildExecutedDetachedSubmoduleResult(
  context: GitPreparedRootContext,
  methodResolution: GitUpdateMethodResolution,
  updateResult: GitUpdateActionResult,
  submoduleUpdate: GitUpdateSubmoduleUpdate,
  updatedRange?: GitUpdateCommitRange,
): GitExecutedRootResult {
  const parentRepoRoot = String(submoduleUpdate.parentRepoRoot || context.node.parentRepoRoot || "").trim();
  const normalizedPreservingRepoRoot = String(
    updateResult.data?.preservingRepoRoot || parentRepoRoot || "",
  ).trim();
  return {
    repoRoot: context.runtime.repoRoot,
    ok: updateResult.ok,
    resultCode: resolveExecutedRootResultCode(updateResult),
    configuredMethod: methodResolution.selectedMethod,
    methodResolvedSource: methodResolution.resolvedSource,
    method: "submodule",
    error: updateResult.error,
    fetchResult: context.fetchResult,
    updatedRange,
    unfinishedState: updateResult.data?.unfinishedState,
    localChangesRestorePolicy: updateResult.data?.localChangesRestorePolicy,
    preservingState: updateResult.data?.preservingState,
    submoduleUpdate: updateResult.data?.submoduleUpdate || submoduleUpdate,
    data: {
      ...(updateResult.data && typeof updateResult.data === "object" ? updateResult.data : {}),
      configuredMethod: methodResolution.selectedMethod,
      methodResolvedSource: methodResolution.resolvedSource,
      selectionSource: methodResolution.selectionSource,
      saveChangesPolicy: methodResolution.saveChangesPolicy,
      fetchResult: context.fetchResult,
      updatedRange,
      preservingRepoRoot: normalizedPreservingRepoRoot || undefined,
    },
  };
}

/**
 * 为普通 root 规划 updater，统一产出“直接结果”或“待执行 core updater”。
 */
async function planPreparedBranchRootUpdateAsync(
  context: GitPreparedRootContext,
  orchestratorRuntime: GitUpdateOrchestratorRuntime,
  payload: any,
  session: GitUpdateExecutionSession,
): Promise<GitPreparedRootUpdatePlan> {
  const runtime = context.runtime;
  const trackedRemote = context.trackedRemote!;
  const upstreamRef = context.upstreamRef!;
  const updatedRangeStart = await resolveMergeBaseCommitAsync(runtime, `refs/heads/${context.branch || ""}`, upstreamRef);

  if (!(await runtime.hasRemoteTrackingRefAsync(trackedRemote.remote, trackedRemote.branch))) {
    return {
      type: "result",
      result: {
        repoRoot: runtime.repoRoot,
        ok: false,
        resultCode: "NOT_READY",
        branch: context.branch,
        upstream: upstreamRef,
        fetchResult: context.fetchResult,
        error: `上游分支 ${trackedRemote.upstream} 不存在或尚未获取到本地，无法执行更新项目`,
        failureCode: "remote-missing",
        submoduleUpdate: context.submoduleUpdate,
        data: {
          resultCode: "NOT_READY",
          fetchResult: context.fetchResult,
        },
      },
    };
  }

  runtime.emitProgress("正在检查是否存在远端新提交", upstreamRef);
  const hasRemote = await runtime.hasRemoteChangesAsync(upstreamRef);
  if (!hasRemote) {
    return {
      type: "result",
      result: {
        repoRoot: runtime.repoRoot,
        ok: true,
        resultCode: "NOTHING_TO_UPDATE",
        branch: context.branch,
        upstream: upstreamRef,
        method: "none",
        nothingToUpdate: true,
        fetchResult: context.fetchResult,
        submoduleUpdate: context.submoduleUpdate,
        data: {
          method: "none",
          upstream: upstreamRef,
          nothingToUpdate: true,
          fetchResult: context.fetchResult,
        },
      },
    };
  }

  const cancelledBeforeUpdater = resolveCancelledRootResult(runtime, "更新项目已取消", {
    branch: context.branch,
    upstream: upstreamRef,
    fetchResult: context.fetchResult,
    submoduleUpdate: context.submoduleUpdate,
  });
  if (cancelledBeforeUpdater) {
    recordRootPhase(session, runtime.repoRoot, "updater-selection", "cancelled", cancelledBeforeUpdater.error || "更新项目已取消", { runtime });
    return {
      type: "result",
      result: cancelledBeforeUpdater,
    };
  }

  recordRootPhase(session, runtime.repoRoot, "updater-selection", "running", "正在选择 updater 策略", { runtime });
  const methodResolution = await runtime.resolvePullUpdateMethodAsync(payload);
  const updateMethod = methodResolution.resolvedMethod;
  recordRootPhase(
    session,
    runtime.repoRoot,
    "updater-selection",
    "completed",
    `已选择 ${toUpdateMethodLabel(updateMethod)} 策略`,
    { runtime, detail: upstreamRef },
  );
  runtime.emitProgress(
    `已选择 ${toUpdateMethodLabel(updateMethod)} 策略`,
    upstreamRef,
  );

  if (updateMethod === "rebase") {
    const rebaseRuntime = orchestratorRuntime.createRebaseRuntime(runtime.repoRoot);
    const rebasePlan = await planRebaseUpdateAsync(rebaseRuntime, context.branch!, upstreamRef, payload);
    if (rebasePlan.type === "result") {
      const updatedRange = rebasePlan.result.ok && rebasePlan.result.data?.method !== "none"
        ? buildUpdatedCommitRange(
            updatedRangeStart,
            await resolveMergeBaseCommitAsync(runtime, `refs/heads/${context.branch || ""}`, upstreamRef),
          )
        : undefined;
      return {
        type: "result",
        result: buildExecutedBranchRootResult(context, methodResolution, rebasePlan.result, updatedRange),
      };
    }
    recordRootPhase(session, runtime.repoRoot, "save-if-needed", "running", "Rebase 策略会在需要时先保护本地改动", { runtime, detail: upstreamRef });
    recordRootPhase(session, runtime.repoRoot, "save-if-needed", "completed", "已进入本地改动保护阶段", { runtime, detail: upstreamRef });
    return {
      type: "execute",
      context,
      updateKind: "rebase",
      methodResolution,
      saveRepoRoot: rebasePlan.saveNeeded ? runtime.repoRoot : undefined,
      updatedRangeStart,
      runAsync: async () => await runRebaseUpdateCoreAsync(rebaseRuntime, upstreamRef, payload),
    };
  }

  if (updateMethod === "reset") {
    await planResetUpdateAsync();
    recordRootPhase(session, runtime.repoRoot, "save-if-needed", "running", "Reset 策略不会预先保护本地改动", { runtime, detail: upstreamRef });
    recordRootPhase(session, runtime.repoRoot, "save-if-needed", "completed", "Reset 策略无需预保存本地改动", { runtime, detail: upstreamRef });
    const resetRuntime = orchestratorRuntime.createResetRuntime(runtime.repoRoot);
    return {
      type: "execute",
      context,
      updateKind: "reset",
      methodResolution,
      updatedRangeStart,
      runAsync: async () => await runResetUpdateCoreAsync(resetRuntime, context.branch!, upstreamRef, methodResolution.saveChangesPolicy),
    };
  }

  const mergeRuntime = orchestratorRuntime.createMergeRuntime(runtime.repoRoot);
  const mergePlan = await planMergeUpdateAsync(mergeRuntime, context.branch!, upstreamRef);
  recordRootPhase(
    session,
    runtime.repoRoot,
    "save-if-needed",
    "running",
    mergePlan.saveNeeded ? "Merge 策略将按需保护本地改动" : "Merge 策略无需预保存本地改动",
    { runtime, detail: upstreamRef },
  );
  recordRootPhase(
    session,
    runtime.repoRoot,
    "save-if-needed",
    "completed",
    mergePlan.saveNeeded ? "已进入按需保护本地改动阶段" : "Merge 策略确认无需保存本地改动",
    { runtime, detail: upstreamRef },
  );
  return {
    type: "execute",
    context,
    updateKind: "merge",
    methodResolution,
    saveRepoRoot: mergePlan.saveNeeded ? runtime.repoRoot : undefined,
    updatedRangeStart,
    runAsync: async () => await runMergeUpdateCoreAsync(mergeRuntime, upstreamRef, payload),
  };
}

/**
 * 为 Detached 子模块规划 updater，保留“通过父仓递归更新 + 由父仓承担 preserving”的语义。
 */
async function planPreparedDetachedSubmoduleUpdateAsync(
  context: GitPreparedRootContext,
  orchestratorRuntime: GitUpdateOrchestratorRuntime,
  payload: any,
  session: GitUpdateExecutionSession,
): Promise<GitPreparedRootUpdatePlan> {
  const parentRepoRoot = String(context.node.parentRepoRoot || "").trim();
  const submoduleUpdate = context.submoduleUpdate || buildSubmoduleUpdateMetadata(context.node, "detached-updater") || {
    mode: "detached" as const,
    strategy: "detached-updater" as const,
    parentRepoRoot: parentRepoRoot || undefined,
    recursive: true,
    detachedHead: true,
  };
  recordRootPhase(session, context.runtime.repoRoot, "updater-selection", "running", "正在选择 Detached 子模块 updater", { runtime: context.runtime });
  const methodResolution = await context.runtime.resolvePullUpdateMethodAsync(payload);
  recordRootPhase(session, context.runtime.repoRoot, "updater-selection", "completed", "已选择 Detached 子模块专用 updater", { runtime: context.runtime });
  recordRootPhase(session, context.runtime.repoRoot, "save-if-needed", "running", "Detached 子模块会联动父仓保护本地改动", { runtime: context.runtime });
  recordRootPhase(session, context.runtime.repoRoot, "save-if-needed", "completed", "已进入父仓本地改动保护阶段", { runtime: context.runtime });
  const submoduleRuntime = orchestratorRuntime.createSubmoduleRuntime(parentRepoRoot, context.node.repoRoot);
  return {
    type: "execute",
    context,
    updateKind: "submodule",
    methodResolution,
    saveRepoRoot: parentRepoRoot || undefined,
    runAsync: async () => await runSubmoduleUpdateCoreAsync(submoduleRuntime, {
      ...submoduleUpdate,
      parentRepoRoot,
    }),
  };
}

/**
 * 根据上下文规划 root 级更新，统一输出“立即结果”或“待执行 plan”。
 */
async function planPreparedRootUpdateAsync(
  context: GitPreparedRootContext,
  orchestratorRuntime: GitUpdateOrchestratorRuntime,
  payload: any,
  session: GitUpdateExecutionSession,
): Promise<GitPreparedRootUpdatePlan> {
  if (context.kind === "detached-submodule")
    return await planPreparedDetachedSubmoduleUpdateAsync(context, orchestratorRuntime, payload, session);
  return await planPreparedBranchRootUpdateAsync(context, orchestratorRuntime, payload, session);
}

/**
 * 执行已规划好的 core updater；preserving 由 orchestrator 外层统一承担。
 */
async function executePlannedRootUpdateAsync(
  plan: Extract<GitPreparedRootUpdatePlan, { type: "execute" }>,
  session: GitUpdateExecutionSession,
): Promise<GitExecutedRootResult> {
  const context = plan.context;
  const detail = context.kind === "branch" ? context.upstreamRef : context.submoduleUpdate?.relativePath;
  recordRootPhase(
    session,
    context.runtime.repoRoot,
    "root-update",
    "running",
    plan.updateKind === "submodule" ? "正在执行 Detached 子模块更新" : "正在执行 root 级更新",
    { runtime: context.runtime, detail },
  );
  const beforeHead = await resolveHeadCommitAsync(context.runtime);
  const updateResult = await plan.runAsync();
  const updateResultCode = resolveExecutedRootResultCode(updateResult);
  recordRootPhase(
    session,
    context.runtime.repoRoot,
    "root-update",
    updateResultCode === "CANCEL" ? "cancelled" : "completed",
    updateResult.ok
      ? (plan.updateKind === "submodule" ? "Detached 子模块更新完成" : "root 更新执行完成")
      : String(updateResult.error || (plan.updateKind === "submodule" ? "Detached 子模块更新失败" : "root 更新失败")),
    { runtime: context.runtime, detail },
  );
  const afterHead = updateResult.ok ? await resolveHeadCommitAsync(context.runtime) : undefined;
  const updatedRange = updateResult.ok && updateResult.data?.nothingToUpdate !== true && updateResult.data?.method !== "none"
    ? context.kind === "branch"
      ? buildUpdatedCommitRange(
          plan.updatedRangeStart,
          await resolveMergeBaseCommitAsync(context.runtime, `refs/heads/${context.branch || ""}`, context.upstreamRef),
        )
      : buildUpdatedCommitRange(beforeHead, afterHead)
    : undefined;
  if (plan.updateKind === "submodule") {
    const submoduleUpdate = context.submoduleUpdate || buildSubmoduleUpdateMetadata(context.node, "detached-updater") || {
      mode: "detached" as const,
      strategy: "detached-updater" as const,
      parentRepoRoot: String(context.node.parentRepoRoot || "").trim() || undefined,
      recursive: true,
      detachedHead: true,
    };
    return buildExecutedDetachedSubmoduleResult(context, plan.methodResolution, updateResult, submoduleUpdate, updatedRange);
  }
  return buildExecutedBranchRootResult(context, plan.methodResolution, updateResult, updatedRange, plan.saveRepoRoot);
}

/**
 * 选择最终回传给 IPC 的代表性 root 结果，优先当前触发仓，再退化到首个非 skipped root。
 */
function pickRepresentativeRootResult(
  aggregated: GitUpdateAggregatedSession,
  requestedRepoRoot: string,
): GitUpdateRootSessionResult | null {
  const requestedKey = toFsPathKey(requestedRepoRoot);
  const requestedRoot = aggregated.roots.find((root) => root.resultCode !== "SKIPPED" && toFsPathKey(root.repoRoot) === requestedKey);
  if (requestedRoot) return requestedRoot;
  const firstExecuted = aggregated.roots.find((root) => root.resultCode !== "SKIPPED");
  if (firstExecuted) return firstExecuted;
  return aggregated.roots[0] || null;
}

/**
 * 为问题模型补齐来源 root 元数据，便于多仓场景在工作台明确指出问题所属仓库。
 */
function attachProblemRootMetadata(
  problem: GitUpdateOperationProblem,
  root: Pick<GitUpdateRootSessionResult, "repoRoot" | "rootName">,
): GitUpdateOperationProblem {
  return {
    ...problem,
    repoRoot: String(problem.repoRoot || root.repoRoot || "").trim() || undefined,
    rootName: String(problem.rootName || root.rootName || "").trim() || undefined,
    actions: Array.isArray(problem.actions) ? problem.actions.map((action) => ({
      ...action,
      payloadPatch: action?.payloadPatch && typeof action.payloadPatch === "object"
        ? { ...action.payloadPatch }
        : {},
    })) : [],
  };
}

/**
 * 从单个 root 结果里提取统一问题模型，优先使用结构化字段，避免回退为字符串解析。
 */
function extractRootOperationProblem(root: GitUpdateRootSessionResult): GitUpdateOperationProblem | null {
  const candidate = root.data?.operationProblem;
  if (!candidate || typeof candidate !== "object") return null;
  const kind = String(candidate.kind || "").trim();
  if (
    kind !== "local-changes-overwritten"
    && kind !== "untracked-overwritten"
    && kind !== "merge-conflict"
  ) {
    return null;
  }
  const operationRaw = String(candidate.operation || "").trim();
  const operation = operationRaw === "reset" || operationRaw === "checkout" || operationRaw === "merge"
    ? operationRaw
    : "merge";
  return attachProblemRootMetadata({
    operation,
    kind,
    title: String(candidate.title || "").trim(),
    description: String(candidate.description || "").trim(),
    files: Array.isArray(candidate.files)
      ? candidate.files.map((filePath: unknown) => String(filePath || "").trim()).filter(Boolean)
      : [],
    source: candidate.source === "branch-switch" || candidate.source === "merge-failure" || candidate.source === "smart-operation"
      ? candidate.source
      : "smart-operation",
    repoRoot: String(candidate.repoRoot || "").trim() || undefined,
    rootName: String(candidate.rootName || "").trim() || undefined,
    mergeFailureType: candidate.mergeFailureType,
    actions: Array.isArray(candidate.actions) ? candidate.actions : [],
  }, root);
}

/**
 * 为统一问题模型计算优先级，保证多仓聚合时先展示覆盖文件，再展示普通冲突提示。
 */
function resolveOperationProblemPriority(problem: GitUpdateOperationProblem): number {
  if (problem.kind === "local-changes-overwritten") return 300;
  if (problem.kind === "untracked-overwritten") return 290;
  return 200;
}

/**
 * 从聚合结果中选出需要优先回传到顶层 `data` 的主问题，减少前端自行遍历 roots 的协议分散。
 */
function pickAggregateOperationProblem(
  aggregated: GitUpdateAggregatedSession,
  representative: GitUpdateRootSessionResult | null,
): GitUpdateOperationProblem | null {
  const representativeKey = representative ? toFsPathKey(representative.repoRoot) : "";
  let bestProblem: GitUpdateOperationProblem | null = null;
  let bestScore = -1;
  for (const root of aggregated.roots) {
    const problem = extractRootOperationProblem(root);
    if (!problem) continue;
    const score = resolveOperationProblemPriority(problem)
      + (root.ok ? 0 : 20)
      + (representativeKey && toFsPathKey(root.repoRoot) === representativeKey ? 5 : 0);
    if (score <= bestScore) continue;
    bestProblem = problem;
    bestScore = score;
  }
  return bestProblem;
}

/**
 * 把 root 级聚合结果压平回现有 IPC `data` 结构，同时追加多仓补充字段。
 */
function buildAggregateData(
  aggregated: GitUpdateAggregatedSession,
  representative: GitUpdateRootSessionResult | null,
): Record<string, any> {
  const baseData = representative?.data && typeof representative.data === "object"
    ? { ...representative.data }
    : {};
  const shouldRefresh = aggregated.roots.some((root) => root.data?.shouldRefresh === true);
  if (!baseData.upstream && representative?.upstream) baseData.upstream = representative.upstream;
  if (!baseData.method && representative?.method) baseData.method = representative.method;
  if (!baseData.submoduleUpdate && representative?.submoduleUpdate) baseData.submoduleUpdate = representative.submoduleUpdate;
  if (!baseData.fetchResult && representative?.fetchResult) baseData.fetchResult = representative.fetchResult;
  if (representative?.nothingToUpdate === true) baseData.nothingToUpdate = true;
  if (!baseData.unfinishedState && representative?.unfinishedState) baseData.unfinishedState = representative.unfinishedState;
  if (!baseData.localChangesRestorePolicy && representative?.localChangesRestorePolicy) {
    baseData.localChangesRestorePolicy = representative.localChangesRestorePolicy;
  }
  if (!baseData.preservingState && representative?.preservingState) baseData.preservingState = representative.preservingState;
  if (!baseData.updatedRange && representative?.updatedRange) baseData.updatedRange = representative.updatedRange;
  if (!baseData.operationProblem) {
    const aggregateProblem = pickAggregateOperationProblem(aggregated, representative);
    if (aggregateProblem) baseData.operationProblem = aggregateProblem;
  }
  if (!baseData.notification && aggregated.notification) baseData.notification = aggregated.notification;
  if (shouldRefresh) baseData.shouldRefresh = true;
  if (aggregated.resultCode === "CANCEL") baseData.cancelled = true;
  return {
    ...baseData,
    resultCode: aggregated.resultCode,
    roots: aggregated.roots,
    compoundResult: aggregated.compoundResult,
    session: aggregated.session,
    successRoots: aggregated.successRoots,
    failedRoots: aggregated.failedRoots,
    skippedRoots: aggregated.skippedRoots,
    fetchSuccessRoots: aggregated.fetchSuccessRoots,
    fetchFailedRoots: aggregated.fetchFailedRoots,
    fetchSkippedRoots: aggregated.fetchSkippedRoots,
    nothingToUpdateRoots: aggregated.nothingToUpdateRoots,
    updatedRoots: aggregated.updatedRoots,
    executedRoots: aggregated.executedRoots,
    multiRoot: aggregated.multiRoot,
  };
}

/**
 * 将聚合结果压缩为一段中文摘要，兼容当前工作台只展示单条错误文案的现状。
 */
function buildAggregateErrorMessage(aggregated: GitUpdateAggregatedSession): string {
  const summaryParts: string[] = [];
  if (aggregated.updatedRoots.length > 0) summaryParts.push(`${aggregated.updatedRoots.length} 个仓库更新成功`);
  if (aggregated.nothingToUpdateRoots.length > 0) summaryParts.push(`${aggregated.nothingToUpdateRoots.length} 个仓库已是最新`);
  if (aggregated.skippedRoots.length > 0) summaryParts.push(`${aggregated.skippedRoots.length} 个仓库已跳过`);

  if (aggregated.resultCode === "CANCEL") {
    const prefix = summaryParts.length > 0 ? `${summaryParts.join("，")}；` : "";
    return `${prefix}${String(aggregated.session?.cancelReason || "").trim() || "更新项目已取消"}`;
  }

  const firstFailedRoot = aggregated.roots.find((root) => root.resultCode !== "SKIPPED" && !root.ok);
  if (firstFailedRoot?.error) {
    const prefix = summaryParts.length > 0 ? `${summaryParts.join("，")}；` : "";
    return `${prefix}仓库 ${firstFailedRoot.rootName} 更新失败：${firstFailedRoot.error}`;
  }

  const firstSkippedRoot = aggregated.skippedRoots[0];
  if (firstSkippedRoot) {
    const prefix = summaryParts.length > 0 ? `${summaryParts.join("，")}；` : "";
    return `${prefix}未找到可更新的仓库：${firstSkippedRoot.rootName}（${firstSkippedRoot.reason}）`;
  }

  return "更新项目未就绪";
}

/**
 * 把 orchestrator runtime 适配为跨 root preserving saver runtime，供全局 `GitPreservingProcess` 复用。
 */
function createWorkspaceSaverRuntime(runtime: GitUpdateOrchestratorRuntime): GitChangesSaverRuntime {
  return {
    ctx: {
      gitPath: runtime.gitPath,
      userDataPath: runtime.userDataPath,
    },
    userDataPath: runtime.userDataPath,
    repoRoot: runtime.repoRoot,
    runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
      return runtime.runGitExecAsync(targetRepoRoot, argv, timeoutMs);
    },
    runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv) {
      return runtime.runGitSpawnAsync(targetRepoRoot, argv, timeoutMs, envPatch);
    },
    runGitStdoutToFileAsync(targetRepoRoot: string, argv: string[], targetPath: string, timeoutMs?: number) {
      return runtime.runGitStdoutToFileAsync(targetRepoRoot, argv, targetPath, timeoutMs);
    },
    emitProgress(targetRepoRoot: string, message: string, detail?: string) {
      runtime.createRootRuntime(targetRepoRoot).emitProgress(message, detail);
    },
    toGitErrorMessage(res: any, fallback: string) {
      return runtime.toGitErrorMessage(res, fallback);
    },
  };
}

/**
 * 把 root 级结果聚合为最终 IPC 结构；preserving 外层会在其后追加 saved entries / keep-saved 状态。
 */
async function finalizeAggregatedActionResultAsync(
  runtime: GitUpdateOrchestratorRuntime,
  repositoryGraph: Awaited<ReturnType<typeof buildRepositoryGraphAsync>>,
  session: GitUpdateExecutionSession,
  rootResults: GitUpdateRootSessionResult[],
): Promise<GitUpdateActionResult> {
  recordUpdateSessionPhase(session, "result-aggregation", "running", "正在聚合 root 更新结果");
  const aggregated = aggregateUpdateRootResults(rootResults);
  aggregated.resultCode = resolveCompoundResultCode(aggregated, session);
  aggregated.compoundResult = finalizeUpdateExecutionSession(session, aggregated, aggregated.resultCode).compoundResult;
  aggregated.session = session;
  aggregated.notification = await buildUpdateSessionNotificationAsync(
    runtime.repositoryGraphRuntime,
    repositoryGraph.requestedRepoRoot,
    aggregated,
  );
  recordUpdateSessionPhase(
    session,
    "result-aggregation",
    aggregated.resultCode === "CANCEL" ? "cancelled" : "completed",
    aggregated.resultCode === "CANCEL" ? (session.cancelReason || "更新项目已取消") : `已完成 ${rootResults.length} 个 root 的结果聚合`,
  );
  const representative = pickRepresentativeRootResult(aggregated, repositoryGraph.requestedRepoRoot);
  const data = buildAggregateData(aggregated, representative);
  if (aggregated.resultCode === "SUCCESS" || aggregated.resultCode === "NOTHING_TO_UPDATE") {
    return {
      ok: true,
      data,
    };
  }
  return {
    ok: false,
    error: buildAggregateErrorMessage(aggregated),
    data,
  };
}

/**
 * 按 IDEA `GitUpdateProcess` 的多仓模型编排 Update Project，并聚合 root 级结果。
 */
export async function runUpdateProjectAsync(
  runtime: GitUpdateOrchestratorRuntime,
  payload: any,
): Promise<GitUpdateActionResult> {
  const initialCancelled = runtime.isCancellationRequested();
  if (initialCancelled) {
    const initialMessage = String(runtime.getCancellationReason() || "").trim() || "更新项目已取消";
    return {
      ok: false,
      error: initialMessage,
      data: {
        resultCode: "CANCEL",
        roots: [],
        compoundResult: {
          resultCode: "CANCEL",
          successRoots: [],
          failedRoots: [],
          skippedRoots: [],
          fetchSuccessRoots: [],
          fetchFailedRoots: [],
          fetchSkippedRoots: [],
          nothingToUpdateRoots: [],
          updatedRoots: [],
          executedRoots: [],
          multiRoot: false,
          rootResults: [],
        },
        session: {
          requestedRepoRoot: runtime.repoRoot,
          currentPhase: "result-aggregation",
          phaseHistory: [],
          rootStates: {},
          cancelled: true,
          cancelReason: initialMessage,
        },
      },
    };
  }

  runtime.emitProgress("正在构建多仓更新图");
  const repositoryGraph = await buildRepositoryGraphAsync(runtime.repositoryGraphRuntime, payload);
  const session = createUpdateExecutionSession(repositoryGraph.requestedRepoRoot, repositoryGraph.roots);
  recordUpdateSessionPhase(session, "repository-graph", "completed", "多仓更新图构建完成");
  const repositoryNodeByKey = new Map(
    repositoryGraph.roots.map((node) => [toFsPathKey(node.repoRoot), node] as const),
  );
  const preparedContexts = new Map<string, GitPreparedRootContext>();
  const terminalResults = new Map<string, GitUpdateRootSessionResult>();

  for (const node of repositoryGraph.roots) {
    const rootKey = toFsPathKey(node.repoRoot);
    if (!rootKey) continue;

    if (node.requestedSkip) {
      terminalResults.set(rootKey, buildSkippedRootResult(node, node.requestedSkip.reasonCode, node.requestedSkip.reason));
      continue;
    }

    const parentKey = toFsPathKey(node.parentRepoRoot || "");
    const directParentNode = parentKey ? repositoryNodeByKey.get(parentKey) : undefined;
    if (
      node.kind === "submodule"
      && node.submoduleMode === "detached"
      && directParentNode?.kind === "submodule"
      && directParentNode.submoduleMode === "detached"
      && !directParentNode.requestedSkip
    ) {
      terminalResults.set(rootKey, buildSkippedRootResult(node, "updated-by-parent", buildUpdatedByParentReason(node), {
        method: "submodule",
        submoduleUpdate: buildSubmoduleUpdateMetadata(node, "updated-by-parent"),
      }));
      continue;
    }

    const rootRuntime = runtime.createRootRuntime(node.repoRoot);
    const prepared = await prepareRootUpdateContextAsync(node, rootRuntime, payload, session);
    if (!prepared.ready) {
      if (repositoryGraph.roots.length > 1 && isSoftSkipEligibleFailureCode(prepared.result.failureCode)) {
        terminalResults.set(rootKey, buildSkippedRootResult(
          node,
          prepared.result.failureCode,
          resolveSoftSkipReason(node, prepared.result.failureCode, prepared.result.error),
          prepared.result,
        ));
      } else {
        terminalResults.set(rootKey, attachNodeMetadata(node, prepared.result));
      }
      if (prepared.result.resultCode === "CANCEL") {
        markUpdateSessionCancelled(session, "preflight", prepared.result.error, node.repoRoot);
        break;
      }
      continue;
    }

    preparedContexts.set(rootKey, prepared.context);
  }

  let fetchBarrierTriggered = false;
  if (!session.cancelled) {
    for (const node of repositoryGraph.roots) {
      const rootKey = toFsPathKey(node.repoRoot);
      if (!rootKey) continue;
      const preparedContext = preparedContexts.get(rootKey);
      if (!preparedContext) continue;
      const fetchResult = await executePreparedRootFetchAsync(preparedContext, payload, session);
      if (fetchResult.status === "cancelled") {
        terminalResults.set(rootKey, attachNodeMetadata(node, buildCancelledResultFromFetch(preparedContext, fetchResult)));
        markUpdateSessionCancelled(session, "fetch", fetchResult.error, node.repoRoot);
        break;
      }
      if (fetchResult.status === "skipped" && preparedContext.kind === "branch") {
        terminalResults.set(rootKey, attachNodeMetadata(node, buildFetchSkippedRootResult(preparedContext, fetchResult)));
        continue;
      }
      if (fetchResult.status === "failed") {
        fetchBarrierTriggered = true;
      }
    }
  }

  const plannedUpdates = new Map<string, Extract<GitPreparedRootUpdatePlan, { type: "execute" }>>();
  if (!session.cancelled) {
    for (const node of repositoryGraph.roots) {
      const rootKey = toFsPathKey(node.repoRoot);
      if (!rootKey || terminalResults.has(rootKey)) continue;
      const preparedContext = preparedContexts.get(rootKey);
      if (!preparedContext) continue;

      if (fetchBarrierTriggered) {
        const fetchResult = preparedContext.fetchResult;
        const barrierResult = fetchResult?.status === "failed"
          ? attachNodeMetadata(node, buildFetchFailureRootResult(preparedContext, fetchResult))
          : buildSkippedRootResult(node, "fetch-failed", buildFetchBlockedReason(node), {
              branch: preparedContext.branch,
              upstream: preparedContext.upstreamRef,
              method: preparedContext.kind === "detached-submodule" ? "submodule" : undefined,
              submoduleUpdate: preparedContext.submoduleUpdate,
              fetchResult,
              data: fetchResult ? { fetchResult } : undefined,
            });
        terminalResults.set(rootKey, barrierResult);
        continue;
      }

      const planned = await planPreparedRootUpdateAsync(preparedContext, runtime, payload, session);
      if (planned.type === "result") {
        const terminalResult = repositoryGraph.roots.length > 1 && isSoftSkipEligibleFailureCode(planned.result.failureCode)
          ? buildSkippedRootResult(
              node,
              planned.result.failureCode,
              resolveSoftSkipReason(node, planned.result.failureCode, planned.result.error),
              planned.result,
            )
          : attachNodeMetadata(node, planned.result);
        terminalResults.set(rootKey, terminalResult);
        if (planned.result.resultCode === "CANCEL") {
          markUpdateSessionCancelled(
            session,
            session.rootStates[toFsPathKey(node.repoRoot)]?.currentPhase || "updater-selection",
            planned.result.error,
            node.repoRoot,
          );
          break;
        }
        continue;
      }

      plannedUpdates.set(rootKey, planned);
    }
  }

  const executePlannedUpdatesAsync = async (allowExecution: boolean): Promise<GitUpdateActionResult> => {
    const rootResults: GitUpdateRootSessionResult[] = [];
    const failedRootKeys = new Set<string>();

    for (const node of repositoryGraph.roots) {
      const rootKey = toFsPathKey(node.repoRoot);
      if (!rootKey) continue;

      const terminalResult = terminalResults.get(rootKey);
      if (terminalResult) {
        rootResults.push(terminalResult);
        recordUpdateRootResult(session, terminalResult);
        emitUpdateSessionProgress(runtime.createRootRuntime(node.repoRoot), session, `已记录 ${node.rootName} 的更新结果`);
        if (terminalResult.resultCode === "CANCEL") break;
        if (!terminalResult.ok && terminalResult.resultCode !== "SKIPPED")
          failedRootKeys.add(rootKey);
        continue;
      }

      const planned = plannedUpdates.get(rootKey);
      const preparedContext = preparedContexts.get(rootKey);
      if (!planned || !preparedContext) continue;

      if (!allowExecution) continue;

      const parentKey = toFsPathKey(node.parentRepoRoot || "");
      if (parentKey && failedRootKeys.has(parentKey)) {
        const skippedRoot = buildSkippedRootResult(node, "parent-failed", buildParentFailedReason(node), {
          branch: preparedContext.branch,
          upstream: preparedContext.upstreamRef,
          method: preparedContext.kind === "detached-submodule" ? "submodule" : undefined,
          submoduleUpdate: preparedContext.submoduleUpdate,
          fetchResult: preparedContext.fetchResult,
        });
        rootResults.push(skippedRoot);
        recordUpdateRootResult(session, skippedRoot);
        emitUpdateSessionProgress(preparedContext.runtime, session, `已记录 ${node.rootName} 的更新结果`);
        continue;
      }

      const executedResult = await executePlannedRootUpdateAsync(planned, session);
      if (repositoryGraph.roots.length > 1 && isSoftSkipEligibleFailureCode(executedResult.failureCode)) {
        const skippedRoot = buildSkippedRootResult(
          node,
          executedResult.failureCode,
          resolveSoftSkipReason(node, executedResult.failureCode, executedResult.error),
          executedResult,
        );
        rootResults.push(skippedRoot);
        recordUpdateRootResult(session, skippedRoot);
        emitUpdateSessionProgress(preparedContext.runtime, session, `已记录 ${node.rootName} 的更新结果`);
        continue;
      }

      const rootResult = attachNodeMetadata(node, executedResult);
      rootResults.push(rootResult);
      recordUpdateRootResult(session, rootResult);
      emitUpdateSessionProgress(preparedContext.runtime, session, `已记录 ${node.rootName} 的更新结果`);
      if (rootResult.resultCode === "CANCEL") {
        markUpdateSessionCancelled(
          session,
          session.rootStates[toFsPathKey(node.repoRoot)]?.currentPhase || "root-update",
          rootResult.error,
          node.repoRoot,
        );
        break;
      }
      if (!rootResult.ok)
        failedRootKeys.add(rootKey);
    }

    return await finalizeAggregatedActionResultAsync(runtime, repositoryGraph, session, rootResults);
  };

  if (session.cancelled)
    return await executePlannedUpdatesAsync(false);

  const rootsToSave = Array.from(new Set(
    Array.from(plannedUpdates.values())
      .map((plan) => String(plan.saveRepoRoot || "").trim())
      .filter(Boolean),
  ));
  if (rootsToSave.length <= 0)
    return await executePlannedUpdatesAsync(true);

  const savePolicy = plannedUpdates.values().next().value?.methodResolution.saveChangesPolicy || "stash";
  const saver = createWorkspaceChangesSaver(
    createWorkspaceSaverRuntime(runtime),
    savePolicy,
    `codexflow update: update project @ ${new Date().toISOString()}`,
  );
  const preservingProcess = new GitPreservingProcess(
    {
      repoRoot: runtime.repoRoot,
      userDataPath: runtime.userDataPath,
      emitProgress(message: string, detail?: string): void {
        runtime.emitProgress(message, detail);
      },
    },
    rootsToSave,
    "update project",
    "remote",
    savePolicy,
    saver,
  );
  return await preservingProcess.execute(
    async () => await executePlannedUpdatesAsync(true),
    async (result) => result.ok,
  );
}
