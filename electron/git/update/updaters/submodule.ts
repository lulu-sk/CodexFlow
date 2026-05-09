import path from "node:path";
import { handleUpdateCommandFailureAsync } from "./base";
import type {
  GitUpdateActionResult,
  GitUpdateSubmoduleRuntime,
  GitUpdateSubmoduleUpdate,
} from "../types";

/**
 * 把子模块路径转换为相对父仓的工作区路径，供 `git submodule update` 精确更新指定子模块。
 */
function resolveRelativeSubmodulePath(parentRepoRoot: string, submoduleRepoRoot: string): string {
  const relativePath = path.relative(parentRepoRoot, submoduleRepoRoot).replace(/\\/g, "/").trim();
  if (!relativePath || relativePath === ".") return "";
  if (relativePath.startsWith("../")) return "";
  return relativePath;
}

/**
 * 把结构化子模块更新元数据追加到返回结果，保证 root/session/compoundResult 可以统一聚合。
 */
function attachSubmoduleUpdateData(
  result: GitUpdateActionResult,
  submoduleUpdate: GitUpdateSubmoduleUpdate,
): GitUpdateActionResult {
  return {
    ...result,
    data: {
      ...(result.data && typeof result.data === "object" ? result.data : {}),
      method: "submodule",
      submoduleUpdate,
      shouldRefresh: true,
    },
  };
}

/**
 * 在用户取消 Detached 子模块更新时返回统一取消结果；本地改动恢复交给 preserving process 外层决定。
 */
async function handleCancelledSubmoduleUpdateAsync(
  runtime: GitUpdateSubmoduleRuntime,
  submoduleUpdate: GitUpdateSubmoduleUpdate,
): Promise<GitUpdateActionResult> {
  const cancelMessage = String(runtime.getCancellationReason() || "").trim() || "更新项目已取消";
  return attachSubmoduleUpdateData({
    ok: false,
    error: cancelMessage,
    data: {
      cancelled: true,
      resultCode: "CANCEL",
    },
  }, submoduleUpdate);
}

/**
 * 执行不带 preserving 包装的 Detached 子模块核心更新逻辑，供全局 update 主链复用。
 */
export async function runSubmoduleUpdateCoreAsync(
  runtime: GitUpdateSubmoduleRuntime,
  submoduleUpdate: GitUpdateSubmoduleUpdate,
): Promise<GitUpdateActionResult> {
  const relativePath = resolveRelativeSubmodulePath(runtime.parentRepoRoot, runtime.submoduleRepoRoot);
  if (!relativePath) {
    return attachSubmoduleUpdateData({
      ok: false,
      error: "未能识别 Detached 子模块相对父仓的路径，无法执行子模块更新",
    }, submoduleUpdate);
  }

  const detachedSubmoduleUpdate = {
    ...submoduleUpdate,
    relativePath,
  };
  runtime.emitProgress("正在通过父仓递归更新 Detached 子模块", relativePath);
  const updateRes = await runtime.runGitSpawnAsync(["submodule", "update", "--recursive", "--", relativePath], 300_000);
  if (!updateRes.ok) {
    if (String(updateRes.error || "").trim().toLowerCase() === "aborted" || runtime.isCancellationRequested())
      return await handleCancelledSubmoduleUpdateAsync(runtime, detachedSubmoduleUpdate);
    const failureResult = await handleUpdateCommandFailureAsync(runtime, "更新 Detached 子模块失败", updateRes, null);
    return attachSubmoduleUpdateData(failureResult, detachedSubmoduleUpdate);
  }
  return attachSubmoduleUpdateData({
    ok: true,
    data: {
      method: "submodule",
      submoduleUpdate: detachedSubmoduleUpdate,
      shouldRefresh: true,
    },
  }, detachedSubmoduleUpdate);
}
