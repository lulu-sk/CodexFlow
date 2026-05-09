import { toFsPathKey } from "../pathKey";
import type {
  GitUpdateAggregatedSession,
  GitUpdateCompoundResult,
  GitUpdateExecutionPhase,
  GitUpdateExecutionPhaseRecord,
  GitUpdateExecutionPhaseStatus,
  GitUpdateFetchResult,
  GitUpdateExecutionRootState,
  GitUpdateExecutionSession,
  GitUpdateRepositoryNode,
  GitUpdateResultCode,
  GitUpdateRootResultCode,
  GitUpdateRootSessionResult,
} from "./types";

/**
 * 初始化 Update Project 执行会话，预先为每个 root 建立阶段状态槽位。
 */
export function createUpdateExecutionSession(
  requestedRepoRoot: string,
  roots: Pick<GitUpdateRepositoryNode, "repoRoot" | "rootName" | "kind" | "parentRepoRoot">[],
): GitUpdateExecutionSession {
  const rootStates: Record<string, GitUpdateExecutionRootState> = {};
  for (const root of roots) {
    const repoRoot = String(root.repoRoot || "").trim();
    if (!repoRoot) continue;
    rootStates[toFsPathKey(repoRoot)] = {
      repoRoot,
      rootName: String(root.rootName || "").trim() || undefined,
      kind: root.kind,
      parentRepoRoot: String(root.parentRepoRoot || "").trim() || undefined,
      phaseHistory: [],
    };
  }
  return {
    requestedRepoRoot: String(requestedRepoRoot || "").trim(),
    phaseHistory: [],
    rootStates,
    cancelled: false,
  };
}

/**
 * 向会话追加一条阶段记录，并同步当前阶段到 session / root 视图。
 */
export function recordUpdateSessionPhase(
  session: GitUpdateExecutionSession,
  phase: GitUpdateExecutionPhase,
  status: GitUpdateExecutionPhaseStatus,
  message: string,
  repoRoot?: string,
): GitUpdateExecutionPhaseRecord {
  const now = Date.now();
  const record: GitUpdateExecutionPhaseRecord = {
    phase,
    status,
    message: String(message || "").trim() || phase,
    repoRoot: String(repoRoot || "").trim() || undefined,
    startedAt: now,
    finishedAt: now,
  };
  session.currentPhase = phase;
  session.phaseHistory.push(record);

  const rootKey = toFsPathKey(record.repoRoot || "");
  if (!rootKey) return record;
  const rootState = session.rootStates[rootKey] || {
    repoRoot: record.repoRoot || "",
    rootName: undefined,
    kind: undefined,
    parentRepoRoot: undefined,
    phaseHistory: [],
  };
  rootState.currentPhase = phase;
  rootState.phaseHistory.push(record);
  session.rootStates[rootKey] = rootState;
  return record;
}

/**
 * 把 root 级最终结果同步回执行会话，供后续 UI / compound result 读取。
 */
export function recordUpdateRootResult(
  session: GitUpdateExecutionSession,
  result: GitUpdateRootSessionResult,
): void {
  const rootKey = toFsPathKey(result.repoRoot);
  if (!rootKey) return;
  const rootState = session.rootStates[rootKey] || {
    repoRoot: result.repoRoot,
    rootName: result.rootName,
    kind: result.kind,
    parentRepoRoot: result.parentRepoRoot,
    phaseHistory: [],
  };
  rootState.rootName = result.rootName;
  rootState.kind = result.kind;
  rootState.parentRepoRoot = result.parentRepoRoot;
  rootState.resultCode = normalizeRootResultCode(result.resultCode);
  rootState.failureCode = result.failureCode;
  rootState.skippedReason = result.skippedReason;
  rootState.skippedReasonCode = result.skippedReasonCode;
  rootState.submoduleUpdate = result.submoduleUpdate;
  rootState.fetchResult = result.fetchResult;
  rootState.updatedRange = result.updatedRange;
  rootState.unfinishedState = result.unfinishedState;
  rootState.localChangesRestorePolicy = result.localChangesRestorePolicy;
  rootState.preservingState = result.preservingState;
  rootState.operationProblem = result.data?.operationProblem;
  session.rootStates[rootKey] = rootState;
}

/**
 * 把 fetch 阶段的结构化结果同步回执行会话，保证 session 能反映显式 fetch 边界。
 */
export function recordUpdateRootFetchResult(
  session: GitUpdateExecutionSession,
  repoRoot: string,
  fetchResult: GitUpdateFetchResult,
): void {
  const rootKey = toFsPathKey(repoRoot);
  if (!rootKey) return;
  const rootState = session.rootStates[rootKey] || {
    repoRoot,
    rootName: undefined,
    kind: undefined,
    parentRepoRoot: undefined,
    phaseHistory: [],
  };
  rootState.fetchResult = fetchResult;
  session.rootStates[rootKey] = rootState;
}

/**
 * 把当前会话标记为已取消，并记录最终取消原因。
 */
export function markUpdateSessionCancelled(
  session: GitUpdateExecutionSession,
  phase: GitUpdateExecutionPhase,
  reason?: string,
  repoRoot?: string,
): void {
  const message = String(reason || "").trim() || "更新项目已取消";
  session.cancelled = true;
  session.cancelReason = message;
  recordUpdateSessionPhase(session, phase, "cancelled", message, repoRoot);
}

/**
 * 基于 root 级聚合结果构造 compound result，必要时允许用显式结果码覆盖。
 */
export function buildUpdateCompoundResult(
  aggregated: GitUpdateAggregatedSession,
  overrideResultCode?: GitUpdateResultCode,
): GitUpdateCompoundResult {
  return {
    resultCode: overrideResultCode || aggregated.resultCode,
    successRoots: [...aggregated.successRoots],
    failedRoots: [...aggregated.failedRoots],
    skippedRoots: [...aggregated.skippedRoots],
    fetchSuccessRoots: [...aggregated.fetchSuccessRoots],
    fetchFailedRoots: [...aggregated.fetchFailedRoots],
    fetchSkippedRoots: [...aggregated.fetchSkippedRoots],
    nothingToUpdateRoots: [...aggregated.nothingToUpdateRoots],
    updatedRoots: [...aggregated.updatedRoots],
    executedRoots: [...aggregated.executedRoots],
    multiRoot: aggregated.multiRoot,
    rootResults: [...aggregated.roots],
  };
}

/**
 * 将 compound result 回填到执行会话，形成最终的 session 快照。
 */
export function finalizeUpdateExecutionSession(
  session: GitUpdateExecutionSession,
  aggregated: GitUpdateAggregatedSession,
  overrideResultCode?: GitUpdateResultCode,
): GitUpdateExecutionSession {
  session.compoundResult = buildUpdateCompoundResult(aggregated, overrideResultCode);
  return session;
}

/**
 * 从 root 级结果推导 session compound result 的统一结果码。
 */
export function resolveCompoundResultCode(
  aggregated: GitUpdateAggregatedSession,
  session: GitUpdateExecutionSession,
): GitUpdateResultCode {
  if (session.cancelled) return "CANCEL";
  return aggregated.resultCode;
}

/**
 * 把 root 级结果码规整为最终 rootState 可记录的稳定值。
 */
export function normalizeRootResultCode(resultCode: GitUpdateRootResultCode): GitUpdateRootResultCode {
  return resultCode;
}
