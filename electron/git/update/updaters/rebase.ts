import { buildUpdateSuccessData, handleUpdateCommandFailureAsync } from "./base";
import type {
  GitUpdateActionResult,
  GitUpdateRebaseRuntime,
  GitUpdateRebaseWarning,
} from "../types";

export type GitPlannedRebaseUpdate =
  | { type: "execute"; saveNeeded: boolean }
  | { type: "result"; result: GitUpdateActionResult };

/**
 * 从 `git rev-list --count` 输出中读取提交数量；命令失败时返回 `null` 供上层决定是否降级。
 */
async function readCommitCountAsync(
  runtime: Pick<GitUpdateRebaseRuntime, "runGitExecAsync">,
  argv: string[],
  timeoutMs: number,
): Promise<number | null> {
  const res = await runtime.runGitExecAsync(argv, timeoutMs);
  if (!res.ok) return null;
  const count = Number.parseInt(String(res.stdout || "").trim(), 10);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

/**
 * 判断当前 rebase 范围内是否包含已发布到任意远端引用的提交。
 */
async function detectPublishedCommitWarningAsync(
  runtime: Pick<GitUpdateRebaseRuntime, "runGitExecAsync">,
  currentBranch: string,
  upstreamRef: string,
): Promise<GitUpdateRebaseWarning | null> {
  const range = `${upstreamRef}..${currentBranch}`;
  const totalCount = await readCommitCountAsync(runtime, ["rev-list", "--count", range], 20_000);
  if (totalCount === null || totalCount <= 0) return null;
  const unpublishedCount = await readCommitCountAsync(runtime, ["rev-list", "--count", range, "--not", "--remotes"], 20_000);
  if (unpublishedCount === null) return null;
  const publishedCount = Math.max(0, totalCount - unpublishedCount);
  if (publishedCount <= 0) return null;
  return {
    type: "published-commits",
    title: "Rebase 会改写已发布提交",
    description: "当前分支存在已经发布到远端的提交。继续 Rebase 会改写这些提交历史，可能影响其他协作者。",
    details: `检测到待 Rebase 的 ${totalCount} 个提交里至少有 ${publishedCount} 个已经出现在远端引用中。`,
    totalCommitCount: totalCount,
    publishedCommitCount: publishedCount,
    confirmAction: {
      label: "仍然 Rebase",
      payloadPatch: {
        rebaseAllowPublishedCommits: true,
      },
    },
    cancelText: "取消",
  };
}

/**
 * 判断当前 rebase 范围内是否包含 merge 提交；命中时提示用户改用 Merge 或继续 Rebase。
 */
async function detectRebaseOverMergeWarningAsync(
  runtime: Pick<GitUpdateRebaseRuntime, "runGitExecAsync">,
  currentBranch: string,
  upstreamRef: string,
): Promise<GitUpdateRebaseWarning | null> {
  const range = `${upstreamRef}..${currentBranch}`;
  const mergeCommitCount = await readCommitCountAsync(runtime, ["rev-list", "--count", "--min-parents=2", range], 20_000);
  if (mergeCommitCount === null || mergeCommitCount <= 0) return null;
  return {
    type: "merge-commits",
    title: "Rebase 将跨越 Merge 提交",
    description: "当前分支包含 Merge 提交。继续 Rebase 可能改变这些合并点的历史结构。",
    details: `检测到 ${mergeCommitCount} 个 Merge 提交。你可以改用 Merge 更新，或明确确认后继续 Rebase。`,
    mergeCommitCount,
    confirmAction: {
      label: "仍然 Rebase",
      payloadPatch: {
        rebaseAllowMergeCommits: true,
      },
    },
    alternativeAction: {
      label: "改用 Merge",
      payloadPatch: {
        updateMethod: "merge",
      },
    },
    cancelText: "取消",
  };
}

/**
 * 把结构化 rebase warning 包装为统一更新结果，交由前端弹窗决定后续动作。
 */
function buildRebaseWarningResult(warning: GitUpdateRebaseWarning): GitUpdateActionResult {
  return {
    ok: false,
    error: warning.description,
    data: {
      resultCode: "CANCEL",
      rebaseWarning: warning,
    },
  };
}

/**
 * 判断当前 Rebase 更新是否显式请求 `--no-verify`；兼容布尔字段与 options 数组两种传法。
 */
function hasRebaseNoVerifyOption(payload: any): boolean {
  if (payload?.noVerify === true) return true;
  const options = Array.isArray(payload?.options) ? payload.options : [];
  return options
    .map((item: any) => String(item || "").trim().toLowerCase())
    .filter(Boolean)
    .includes("noverify")
    || options
      .map((item: any) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
      .includes("no-verify")
    || options
      .map((item: any) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
      .includes("--no-verify");
}

/**
 * 在用户取消 Rebase 更新时执行 `rebase --abort`，尽量把仓库恢复到取消前状态。
 */
async function handleCancelledRebaseAsync(runtime: GitUpdateRebaseRuntime): Promise<GitUpdateActionResult> {
  runtime.emitProgress("正在取消 Rebase 更新", "git rebase --abort");
  const abortRes = await runtime.abortRebaseUpdateAsync();
  const cancelMessage = String(runtime.getCancellationReason() || "").trim() || "更新项目已取消";
  if (!abortRes.ok) {
    return {
      ok: false,
      error: `${cancelMessage}\n${abortRes.error}`,
      data: {
        cancelled: true,
        resultCode: "CANCEL",
        shouldRefresh: true,
        cancelRollbackFailed: true,
      },
    };
  }
  return {
    ok: false,
    error: cancelMessage,
    data: {
      cancelled: true,
      resultCode: "CANCEL",
      shouldRefresh: true,
    },
  };
}

/**
 * 在 preserving 之前规划 Rebase 更新流程，统一处理 fast-forward 优化与 warning 决策。
 */
export async function planRebaseUpdateAsync(
  runtime: GitUpdateRebaseRuntime,
  currentBranch: string,
  upstreamRef: string,
  payload: any,
): Promise<GitPlannedRebaseUpdate> {
  const hasLocalChanges = await runtime.hasLocalChangesAsync();
  if (hasLocalChanges) {
    runtime.emitProgress("正在尝试快速前移当前分支", upstreamRef);
    const fastForwardRes = await runtime.runGitSpawnAsync(["merge", "--ff-only", upstreamRef], 180_000);
    if (fastForwardRes.ok) {
      return {
        type: "result",
        result: {
          ok: true,
          data: buildUpdateSuccessData("rebase", upstreamRef, {
            fastForwardOptimized: true,
            preservedLocalChanges: true,
          }),
        },
      };
    }
    runtime.emitProgress("快速前移不可用，改用 Rebase 更新", upstreamRef);
  }

  if (payload?.rebaseAllowMergeCommits !== true) {
    const mergeWarning = await detectRebaseOverMergeWarningAsync(runtime, currentBranch, upstreamRef);
    if (mergeWarning) {
      return {
        type: "result",
        result: buildRebaseWarningResult(mergeWarning),
      };
    }
  }

  if (payload?.rebaseAllowPublishedCommits !== true) {
    const publishedWarning = await detectPublishedCommitWarningAsync(runtime, currentBranch, upstreamRef);
    if (publishedWarning) {
      return {
        type: "result",
        result: buildRebaseWarningResult(publishedWarning),
      };
    }
  }

  return {
    type: "execute",
    saveNeeded: hasLocalChanges,
  };
}

/**
 * 执行不带 preserving 包装的 Rebase 核心更新逻辑，供全局 update preserving 复用。
 */
export async function runRebaseUpdateCoreAsync(
  runtime: GitUpdateRebaseRuntime,
  upstreamRef: string,
  payload?: any,
): Promise<GitUpdateActionResult> {
  runtime.emitProgress("正在执行 Rebase 更新", upstreamRef);
  const rebaseArgv = ["rebase", ...(hasRebaseNoVerifyOption(payload) ? ["--no-verify"] : []), upstreamRef];
  const rebaseRes = await runtime.runGitSpawnAsync(rebaseArgv, 300_000);
  if (!rebaseRes.ok) {
    if (String(rebaseRes.error || "").trim().toLowerCase() === "aborted" || runtime.isCancellationRequested())
      return await handleCancelledRebaseAsync(runtime);
    return await handleUpdateCommandFailureAsync(runtime, "更新项目失败", rebaseRes, null);
  }
  return {
    ok: true,
    data: buildUpdateSuccessData("rebase", upstreamRef),
  };
}
