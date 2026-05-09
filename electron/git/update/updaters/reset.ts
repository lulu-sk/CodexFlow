import { buildUpdateSuccessData, finalizeSuccessfulUpdateAsync, handleUpdateCommandFailureAsync } from "./base";
import { buildOperationProblemFromFileList, parseSmartOperationProblem } from "../conflicts";
import type {
  GitUpdateActionResult,
  GitUpdateProblemFileList,
  GitUpdateResetRuntime,
  GitUpdateSaveChangesPolicy,
} from "../types";

export type GitPlannedResetUpdate = {
  saveNeeded: false;
};

/**
 * 构建 branch reset 命令参数，显式使用 `checkout -B` 对齐 IDEA 的 branch reset 语义。
 */
function buildBranchResetArgv(currentBranch: string, upstreamRef: string): string[] {
  return ["checkout", "-B", currentBranch, upstreamRef];
}

/**
 * 把 reset 的分支重置元数据统一回填到结果中，便于前端与文档识别当前完成边界。
 */
function attachResetResultData(
  result: GitUpdateActionResult,
  smartOperationProblem?: GitUpdateProblemFileList,
): GitUpdateActionResult {
  return {
    ...result,
    data: {
      ...(result.data && typeof result.data === "object" ? result.data : {}),
      resetMode: "branch-reset",
      branchReset: true,
      operationProblem: smartOperationProblem
        ? buildOperationProblemFromFileList(smartOperationProblem, "smart-operation")
        : undefined,
      smartOperationProblem,
    },
  };
}

/**
 * 执行一次 branch reset，并统一发送进度提示。
 */
async function runBranchResetAsync(
  runtime: GitUpdateResetRuntime,
  currentBranch: string,
  upstreamRef: string,
): Promise<Awaited<ReturnType<GitUpdateResetRuntime["runGitSpawnAsync"]>>> {
  runtime.emitProgress("正在按分支 Reset 对齐上游", `${currentBranch} -> ${upstreamRef}`);
  return await runtime.runGitSpawnAsync(buildBranchResetArgv(currentBranch, upstreamRef), 180_000);
}

/**
 * 规划 Reset 更新；对齐 IDEA `GitResetUpdater`，默认不走全局 preserving。
 */
export async function planResetUpdateAsync(): Promise<GitPlannedResetUpdate> {
  return { saveNeeded: false };
}

/**
 * 执行不带 preserving 包装的 Reset 核心更新逻辑，供全局 update 主链复用。
 */
export async function runResetUpdateCoreAsync(
  runtime: GitUpdateResetRuntime,
  currentBranch: string,
  upstreamRef: string,
  saveChangesPolicy: GitUpdateSaveChangesPolicy,
): Promise<GitUpdateActionResult> {
  const hasLocalChanges = await runtime.hasLocalChangesAsync();
  if (hasLocalChanges)
    runtime.emitProgress("正在尝试直接保留非冲突本地改动并执行 Reset", upstreamRef);

  const directResetRes = await runBranchResetAsync(runtime, currentBranch, upstreamRef);
  if (directResetRes.ok) {
    return attachResetResultData({
      ok: true,
      data: buildUpdateSuccessData("reset", upstreamRef, {
        preservedLocalChanges: hasLocalChanges,
      }),
    });
  }

  const directProblem = parseSmartOperationProblem(directResetRes, "reset");
  if (!hasLocalChanges || directProblem?.kind !== "local-changes-overwritten") {
    const failureResult = await handleUpdateCommandFailureAsync(runtime, "更新项目失败", directResetRes, null);
    return attachResetResultData(failureResult, directProblem);
  }

  runtime.emitProgress("检测到与 Reset 冲突的本地改动，正在临时保存后重试", upstreamRef);
  const saveRes = await runtime.saveLocalChangesForUpdateAsync("update reset", saveChangesPolicy);
  if (!saveRes.ok) {
    return attachResetResultData({
      ok: false,
      error: saveRes.error,
    }, directProblem);
  }

  const resetRes = await runBranchResetAsync(runtime, currentBranch, upstreamRef);
  if (!resetRes.ok) {
    const failureResult = await handleUpdateCommandFailureAsync(runtime, "更新项目失败", resetRes, saveRes.saved);
    return attachResetResultData(failureResult, parseSmartOperationProblem(resetRes, "reset") || directProblem);
  }

  const successResult = await finalizeSuccessfulUpdateAsync(runtime, "reset", upstreamRef, saveRes.saved);
  return attachResetResultData(successResult, directProblem);
}

/**
 * 按 IDEA Reset updater 语义执行更新。
 */
export async function executeResetUpdateAsync(
  runtime: GitUpdateResetRuntime,
  currentBranch: string,
  upstreamRef: string,
  saveChangesPolicy: GitUpdateSaveChangesPolicy,
): Promise<GitUpdateActionResult> {
  return await runResetUpdateCoreAsync(runtime, currentBranch, upstreamRef, saveChangesPolicy);
}
