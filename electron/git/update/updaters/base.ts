import type { GitExecResult } from "../../exec";
import type {
  GitSavedLocalChanges,
  GitUpdateActionResult,
  GitUpdateFinalizeRuntime,
  GitUpdateMethod,
  GitUpdateSuccessOptions,
} from "../types";

/**
 * 构建 Update Project 成功返回结构，统一补齐上游与本地改动恢复标记。
 */
export function buildUpdateSuccessData(
  method: GitUpdateMethod,
  upstream: string,
  extra?: GitUpdateSuccessOptions,
): Record<string, any> {
  return {
    method,
    upstream,
    fastForwardOptimized: extra?.fastForwardOptimized === true || undefined,
    savedLocalChanges: extra?.savedLocalChanges === true || undefined,
    restoredLocalChanges: extra?.restoredLocalChanges === true || undefined,
    preservedLocalChanges: extra?.preservedLocalChanges === true || undefined,
    preservingState: extra?.preservingState,
    savedLocalChangesRef: extra?.preservingState?.savedLocalChangesRef,
  };
}

/**
 * 处理更新命令失败后的本地改动恢复策略。
 */
export async function handleUpdateCommandFailureAsync(
  runtime: GitUpdateFinalizeRuntime,
  fallback: string,
  commandRes: GitExecResult,
  saved: GitSavedLocalChanges | null,
): Promise<GitUpdateActionResult> {
  const baseError = runtime.toGitErrorMessage(commandRes, fallback);
  const unfinishedState = await runtime.detectIncompleteUpdateStateAsync(saved);
  const incomplete = unfinishedState !== null;
  if (!saved) {
    return {
      ok: false,
      error: incomplete ? `${baseError}\n更新已进入未完成状态，请先处理当前冲突或完成进行中的更新操作。` : baseError,
      data: incomplete
        ? {
            shouldRefresh: true,
            resultCode: "INCOMPLETE",
            unfinishedState,
            localChangesRestorePolicy: unfinishedState.localChangesRestorePolicy,
          }
        : undefined,
    };
  }
  if (incomplete) {
    const preservingState = runtime.notifyLocalChangesAreNotRestored(saved, "unfinished-state");
    return {
      ok: false,
      error: `${baseError}\n${preservingState.message}`,
      data: {
        shouldRefresh: true,
        resultCode: "INCOMPLETE",
        unfinishedState,
        localChangesRestorePolicy: unfinishedState.localChangesRestorePolicy,
        savedLocalChangesRef: unfinishedState.savedLocalChangesRef,
        preservingState,
      },
    };
  }
  const restoreRes = await runtime.restoreLocalChangesAfterUpdateAsync(saved);
  if (!restoreRes.ok) {
    return {
      ok: false,
      error: `${baseError}\n${restoreRes.error}`,
      data: {
        shouldRefresh: true,
        localChangesRestorePolicy: restoreRes.preservingState.localChangesRestorePolicy,
        savedLocalChangesRef: restoreRes.preservingState.savedLocalChangesRef,
        preservingState: restoreRes.preservingState,
      },
    };
  }
  return {
    ok: false,
    error: baseError,
    data: restoreRes.preservingState
      ? {
          localChangesRestorePolicy: restoreRes.preservingState.localChangesRestorePolicy,
          savedLocalChangesRef: restoreRes.preservingState.savedLocalChangesRef,
          preservingState: restoreRes.preservingState,
        }
      : undefined,
  };
}

/**
 * 在更新成功后恢复临时保存的本地改动，并统一返回成功结构。
 */
export async function finalizeSuccessfulUpdateAsync(
  runtime: GitUpdateFinalizeRuntime,
  method: GitUpdateMethod,
  upstreamRef: string,
  saved: GitSavedLocalChanges | null,
  extra?: GitUpdateSuccessOptions,
): Promise<GitUpdateActionResult> {
  const restoreRes = await runtime.restoreLocalChangesAfterUpdateAsync(saved);
  if (!restoreRes.ok) {
    return {
      ok: true,
      data: {
        ...buildUpdateSuccessData(method, upstreamRef, {
          fastForwardOptimized: extra?.fastForwardOptimized,
          savedLocalChanges: extra?.savedLocalChanges ?? !!saved,
          restoredLocalChanges: false,
          preservedLocalChanges: extra?.preservedLocalChanges,
          preservingState: restoreRes.preservingState,
        }),
        shouldRefresh: true,
        localChangesRestorePolicy: restoreRes.preservingState.localChangesRestorePolicy,
      },
    };
  }
  return {
    ok: true,
    data: buildUpdateSuccessData(method, upstreamRef, {
      fastForwardOptimized: extra?.fastForwardOptimized,
      savedLocalChanges: extra?.savedLocalChanges ?? !!saved,
      restoredLocalChanges: extra?.restoredLocalChanges ?? !!saved,
      preservedLocalChanges: extra?.preservedLocalChanges,
      preservingState: restoreRes.preservingState || extra?.preservingState,
    }),
  };
}
