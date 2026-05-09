import { buildUpdateSuccessData, handleUpdateCommandFailureAsync } from "./base";
import { parseMergeFailure } from "../conflicts";
import type { GitUpdateActionResult, GitUpdateMergeRuntime } from "../types";

export type GitPlannedMergeUpdate = {
  saveNeeded: boolean;
};

/**
 * 把 Merge 失败分类追加到统一更新结果中，便于前端继续展示文件列表与失败类型。
 */
function attachMergeFailureData(
  result: GitUpdateActionResult,
  mergeFailure: ReturnType<typeof parseMergeFailure>,
): GitUpdateActionResult {
  return {
    ...result,
    data: {
      ...(result.data && typeof result.data === "object" ? result.data : {}),
      mergeFailure,
      operationProblem: mergeFailure.problem,
      smartOperationProblem: mergeFailure.fileList,
    },
  };
}

/**
 * 在用户取消 Merge 更新时执行 `reset --merge`，尽量把仓库恢复到取消前状态。
 */
async function handleCancelledMergeAsync(
  runtime: GitUpdateMergeRuntime,
  mergeFailure?: ReturnType<typeof parseMergeFailure>,
): Promise<GitUpdateActionResult> {
  runtime.emitProgress("正在取消 Merge 更新", "git reset --merge");
  const resetRes = await runtime.cancelMergeUpdateAsync();
  const cancelMessage = String(runtime.getCancellationReason() || "").trim() || "更新项目已取消";
  if (!resetRes.ok) {
    return attachMergeFailureData({
      ok: false,
      error: `${cancelMessage}\n${resetRes.error}`,
      data: {
        cancelled: true,
        resultCode: "CANCEL",
        shouldRefresh: true,
        cancelRollbackFailed: true,
      },
    }, mergeFailure || {
      type: "OTHER",
      message: cancelMessage,
    });
  }
  return attachMergeFailureData({
    ok: false,
    error: cancelMessage,
    data: {
      cancelled: true,
      resultCode: "CANCEL",
      shouldRefresh: true,
    },
  }, mergeFailure || {
    type: "OTHER",
    message: cancelMessage,
  });
}

/**
 * 在 preserving 之前规划 Merge 更新，判断是否需要保存本地改动。
 */
export async function planMergeUpdateAsync(
  runtime: GitUpdateMergeRuntime,
  currentBranch: string,
  upstreamRef: string,
): Promise<GitPlannedMergeUpdate> {
  return {
    saveNeeded: await runtime.shouldSaveLocalChangesForMergeAsync(currentBranch, upstreamRef),
  };
}

/**
 * 执行不带 preserving 包装的 Merge 核心更新逻辑，供全局 update preserving 复用。
 */
export async function runMergeUpdateCoreAsync(
  runtime: GitUpdateMergeRuntime,
  upstreamRef: string,
  payload: any,
): Promise<GitUpdateActionResult> {
  runtime.emitProgress("正在执行 Merge 更新", upstreamRef);
  const mergeRes = await runtime.runGitSpawnAsync(runtime.buildMergeUpdateArgv(upstreamRef, payload), 300_000);
  if (!mergeRes.ok) {
    const mergeFailure = parseMergeFailure(mergeRes);
    if (String(mergeRes.error || "").trim().toLowerCase() === "aborted" || runtime.isCancellationRequested())
      return await handleCancelledMergeAsync(runtime, mergeFailure);
    const failureResult = await handleUpdateCommandFailureAsync(runtime, "更新项目失败", mergeRes, null);
    return attachMergeFailureData(failureResult, mergeFailure);
  }
  return {
    ok: true,
    data: buildUpdateSuccessData("merge", upstreamRef),
  };
}
