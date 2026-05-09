import type {
  GitTrackedRemoteRef,
  GitUpdateFetchFailure,
  GitUpdateFetchResult,
  GitUpdateFetchStrategy,
  GitUpdateRootRuntime,
} from "./types";

export type GitUpdateRootFetchPlan = {
  strategy: GitUpdateFetchStrategy;
  remotes: string[];
  upstream?: string;
  trackedRemote?: string;
  skippedReason?: string;
};

/**
 * 解析 Update Project fetch 阶段的远端选择策略，默认对齐 IDEA 使用 tracked remote。
 */
export function resolveUpdateFetchStrategy(payload: any): GitUpdateFetchStrategy {
  const explicitStrategy = String(payload?.fetchStrategy || "").trim();
  if (explicitStrategy === "tracked-remote" || explicitStrategy === "default-remote" || explicitStrategy === "all-remotes") {
    return explicitStrategy;
  }
  if (payload?.allRemotes === true) return "all-remotes";
  if (payload?.allRemotes === false || String(payload?.remote || "").trim()) return "default-remote";
  return "tracked-remote";
}

/**
 * 为单个 root 生成 fetch 计划，统一处理 tracked/default/all 三类远端选择语义。
 */
export async function buildRootFetchPlanAsync(
  runtime: Pick<GitUpdateRootRuntime, "listRemoteNamesAsync" | "getPreferredRemoteAsync">,
  payload: any,
  trackedRemote: GitTrackedRemoteRef,
): Promise<GitUpdateRootFetchPlan> {
  const strategy = resolveUpdateFetchStrategy(payload);
  const explicitRemote = String(payload?.remote || "").trim();
  if (strategy === "tracked-remote") {
    return {
      strategy,
      remotes: trackedRemote.remote ? [trackedRemote.remote] : [],
      upstream: trackedRemote.upstream,
      trackedRemote: trackedRemote.remote || undefined,
      skippedReason: trackedRemote.remote ? undefined : "当前分支未解析到可用的 tracked remote",
    };
  }

  const remoteNames = await runtime.listRemoteNamesAsync();
  const normalizedRemoteNames = Array.from(new Set(
    (Array.isArray(remoteNames) ? remoteNames : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  ));

  if (strategy === "default-remote") {
    const preferredRemote = explicitRemote || await runtime.getPreferredRemoteAsync(normalizedRemoteNames);
    if (preferredRemote) {
      return {
        strategy,
        remotes: [preferredRemote],
        upstream: trackedRemote.upstream,
        trackedRemote: trackedRemote.remote || undefined,
      };
    }
    const skippedReason = normalizedRemoteNames.length > 1
      ? "检测到多个远端，但无法确定默认远端"
      : "未配置可用远端，无法执行 fetch";
    return {
      strategy,
      remotes: [],
      upstream: trackedRemote.upstream,
      trackedRemote: trackedRemote.remote || undefined,
      skippedReason,
    };
  }

  return {
    strategy,
    remotes: normalizedRemoteNames,
    upstream: trackedRemote.upstream,
    trackedRemote: trackedRemote.remote || undefined,
    skippedReason: normalizedRemoteNames.length > 0 ? undefined : "未配置远端，已跳过 fetch",
  };
}

/**
 * 按计划执行单个 root 的 fetch，逐远端汇总成功/失败/取消结果。
 */
export async function executeRootFetchPlanAsync(
  runtime: Pick<GitUpdateRootRuntime, "emitProgress" | "isCancellationRequested" | "getCancellationReason" | "runGitSpawnAsync" | "toGitErrorMessage">,
  payload: any,
  plan: GitUpdateRootFetchPlan,
): Promise<GitUpdateFetchResult> {
  if (runtime.isCancellationRequested()) {
    return {
      status: "cancelled",
      strategy: plan.strategy,
      remotes: [...plan.remotes],
      fetchedRemotes: [],
      failedRemotes: [],
      upstream: plan.upstream,
      trackedRemote: plan.trackedRemote,
      error: String(runtime.getCancellationReason() || "").trim() || "更新项目已取消",
    };
  }

  if (plan.skippedReason || plan.remotes.length === 0) {
    return {
      status: "skipped",
      strategy: plan.strategy,
      remotes: [...plan.remotes],
      fetchedRemotes: [],
      failedRemotes: [],
      upstream: plan.upstream,
      trackedRemote: plan.trackedRemote,
      skippedReason: plan.skippedReason || "当前 root 无需执行 fetch",
    };
  }

  const fetchedRemotes: string[] = [];
  const failedRemotes: GitUpdateFetchFailure[] = [];
  const refspec = String(payload?.refspec || "").trim();
  const unshallow = payload?.unshallow === true;

  for (let index = 0; index < plan.remotes.length; index += 1) {
    const remote = plan.remotes[index];
    if (runtime.isCancellationRequested()) {
      return {
        status: "cancelled",
        strategy: plan.strategy,
        remotes: [...plan.remotes],
        fetchedRemotes,
        failedRemotes,
        upstream: plan.upstream,
        trackedRemote: plan.trackedRemote,
        error: String(runtime.getCancellationReason() || "").trim() || "更新项目已取消",
      };
    }

    const message = plan.remotes.length > 1
      ? `正在获取远端 ${remote}（${index + 1}/${plan.remotes.length}）`
      : plan.strategy === "tracked-remote"
        ? `正在获取上游远端 ${remote}`
        : `正在获取远端 ${remote}`;
    runtime.emitProgress(message, plan.upstream || refspec || undefined);
    const argv = ["fetch", "--prune", remote];
    if (unshallow) argv.push("--unshallow");
    if (refspec) argv.push(refspec);
    const res = await runtime.runGitSpawnAsync(argv, 300_000);
    if (res.ok) {
      fetchedRemotes.push(remote);
      continue;
    }
    if (String(res.error || "").trim().toLowerCase() === "aborted" || runtime.isCancellationRequested()) {
      return {
        status: "cancelled",
        strategy: plan.strategy,
        remotes: [...plan.remotes],
        fetchedRemotes,
        failedRemotes,
        upstream: plan.upstream,
        trackedRemote: plan.trackedRemote,
        error: String(runtime.getCancellationReason() || "").trim() || "更新项目已取消",
      };
    }
    failedRemotes.push({
      remote,
      error: runtime.toGitErrorMessage(res, `拉取远端 ${remote} 失败`),
    });
  }

  if (failedRemotes.length === 0) {
    return {
      status: "success",
      strategy: plan.strategy,
      remotes: [...plan.remotes],
      fetchedRemotes,
      failedRemotes: [],
      upstream: plan.upstream,
      trackedRemote: plan.trackedRemote,
    };
  }

  return {
    status: "failed",
    strategy: plan.strategy,
    remotes: [...plan.remotes],
    fetchedRemotes,
    failedRemotes,
    upstream: plan.upstream,
    trackedRemote: plan.trackedRemote,
    error: buildFetchFailureMessage(fetchedRemotes, failedRemotes),
  };
}

/**
 * 把多远端 fetch 失败汇总为稳定的中文错误摘要，便于 root 结果与聚合层复用。
 */
function buildFetchFailureMessage(
  fetchedRemotes: string[],
  failedRemotes: GitUpdateFetchFailure[],
): string {
  const failedText = failedRemotes
    .slice(0, 3)
    .map((item) => `${item.remote}: ${item.error}`)
    .join("；");
  const suffix = failedRemotes.length > 3 ? `；其余 ${failedRemotes.length - 3} 个远端也失败` : "";
  return `拉取远端失败（成功 ${fetchedRemotes.length} / 失败 ${failedRemotes.length}）：${failedText}${suffix}`;
}
