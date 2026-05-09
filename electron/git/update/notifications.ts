import { toFsPathKey } from "../pathKey";
import type {
  GitUpdateAggregatedSession,
  GitUpdateCommitRange,
  GitUpdateNotificationRange,
  GitUpdatePostAction,
  GitUpdateRepositoryGraphRuntime,
  GitUpdateRootSessionResult,
  GitUpdateSessionNotificationData,
} from "./types";

type GitUpdateRangeStats = {
  commitCount: number;
  fileCount: number;
};

/**
 * 判断某个更新范围是否完整可用，避免把空哈希或相同起止点误当成真实更新结果。
 */
function isValidCommitRange(range?: GitUpdateCommitRange): range is GitUpdateCommitRange {
  const start = String(range?.start || "").trim();
  const end = String(range?.end || "").trim();
  return !!start && !!end && start !== end;
}

/**
 * 把 Git 输出中的计数文本安全转换为非负整数，异常场景统一回退为 0。
 */
function parseNonNegativeInt(raw: string): number {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * 统计单个范围内新增提交数与受影响文件数，供 Update Session 通知摘要直接复用。
 */
async function collectRangeStatsAsync(
  runtime: GitUpdateRepositoryGraphRuntime,
  repoRoot: string,
  range: GitUpdateCommitRange,
): Promise<GitUpdateRangeStats> {
  const revision = `${range.start}..${range.end}`;
  const [commitRes, fileRes] = await Promise.all([
    runtime.runGitExecAsync(repoRoot, ["rev-list", "--count", revision], 20_000),
    runtime.runGitExecAsync(repoRoot, ["diff", "--name-only", revision], 20_000),
  ]);
  const commitCount = commitRes.ok ? parseNonNegativeInt(String(commitRes.stdout || "")) : 0;
  const fileCount = fileRes.ok
    ? new Set(
      String(fileRes.stdout || "")
        .split(/\r?\n/)
        .map((line) => String(line || "").trim())
        .filter(Boolean),
    ).size
    : 0;
  return {
    commitCount,
    fileCount,
  };
}

/**
 * 把 root 级更新结果转换为通知范围对象，并补齐当前范围的提交数与文件数统计。
 */
async function buildNotificationRangeAsync(
  runtime: GitUpdateRepositoryGraphRuntime,
  root: GitUpdateRootSessionResult,
): Promise<GitUpdateNotificationRange | null> {
  if (!isValidCommitRange(root.updatedRange)) return null;
  const stats = await collectRangeStatsAsync(runtime, root.repoRoot, root.updatedRange);
  if (stats.commitCount <= 0) return null;
  return {
    repoRoot: root.repoRoot,
    rootName: root.rootName,
    branch: root.branch,
    upstream: root.upstream,
    method: root.method,
    range: root.updatedRange,
    commitCount: stats.commitCount,
    fileCount: stats.fileCount,
  };
}

/**
 * 根据请求仓与首个有效范围选择主范围，保证“查看提交”优先回到当前仓上下文。
 */
function pickPrimaryNotificationRange(
  requestedRepoRoot: string,
  ranges: GitUpdateNotificationRange[],
): GitUpdateNotificationRange | undefined {
  const requestedKey = toFsPathKey(requestedRepoRoot);
  if (!requestedKey) return ranges[0];
  return ranges.find((range) => toFsPathKey(range.repoRoot) === requestedKey) || ranges[0];
}

/**
 * 基于主范围构建稳定 revision 文本，供结果卡片动作与日志跳转复用。
 */
function buildRangeRevision(range?: GitUpdateNotificationRange): string | undefined {
  if (!range) return undefined;
  return `${range.range.start}..${range.range.end}`;
}

/**
 * 构建单个 post action，集中约束合法 kind 与可选 revision/repoRoot 载荷。
 */
function buildPostAction(
  kind: string,
  label: string,
  options?: {
    primaryRange?: GitUpdateNotificationRange;
    repoRoot?: string;
    payload?: Record<string, any>;
  },
): GitUpdatePostAction | null {
  const trimmedLabel = String(label || "").trim();
  const primaryRange = options?.primaryRange;
  if (!trimmedLabel) return null;
  return {
    kind,
    label: trimmedLabel,
    repoRoot: String(options?.repoRoot || primaryRange?.repoRoot || "").trim() || undefined,
    revision: buildRangeRevision(primaryRange),
    payload: options?.payload,
  };
}

/**
 * 挑选一个最值得在通知顶部直接继续处理冲突的 root，优先当前请求仓，其次首个未完成冲突仓。
 */
function pickConflictRoot(
  requestedRepoRoot: string,
  aggregated?: GitUpdateAggregatedSession,
): { repoRoot: string; rootName: string } | null {
  const roots = aggregated?.roots || [];
  const requestedKey = toFsPathKey(requestedRepoRoot);
  const candidates = roots.filter((root) => {
    if (root.resultCode === "INCOMPLETE") return true;
    if (root.unfinishedState) return true;
    return root.data?.operationProblem?.kind === "merge-conflict";
  });
  if (candidates.length <= 0) return null;
  const requestedRoot = candidates.find((root) => toFsPathKey(root.repoRoot) === requestedKey);
  const picked = requestedRoot || candidates[0];
  if (!picked) return null;
  return {
    repoRoot: picked.repoRoot,
    rootName: picked.rootName,
  };
}

/**
 * 为“查看已保存改动”挑选最合适的 root，优先当前主范围仓库，其次退化到首个仍保留保存记录的 root。
 */
function pickSavedChangesRoot(
  requestedRepoRoot: string,
  aggregated?: GitUpdateAggregatedSession,
): GitUpdateRootSessionResult | null {
  const candidates = (aggregated?.roots || []).filter((root) => {
    const status = String(root.preservingState?.status || "").trim();
    return status === "restore-failed" || status === "kept-saved";
  });
  if (candidates.length <= 0) return null;
  const requestedKey = toFsPathKey(requestedRepoRoot);
  if (!requestedKey) return candidates[0] || null;
  return candidates.find((root) => toFsPathKey(root.repoRoot) === requestedKey) || candidates[0] || null;
}

/**
 * 构建更新后动作模型，当前显式提供“查看提交 + 复制范围”两类真实闭环动作。
 */
function buildPostActions(
  ranges: GitUpdateNotificationRange[],
  primaryRange?: GitUpdateNotificationRange,
  aggregated?: GitUpdateAggregatedSession,
): GitUpdatePostAction[] {
  const preservingConflictAction = (aggregated?.roots || [])
    .map((root) => root.preservingState?.resolveConflictsAction)
    .find((action): action is GitUpdatePostAction => !!action);
  const savedChangesRoot = pickSavedChangesRoot(primaryRange?.repoRoot || "", aggregated);
  const actions = [
    buildPostAction("view-commits", "查看提交", {
      primaryRange,
      payload: {
        ranges,
        primaryRepoRoot: primaryRange?.repoRoot,
      },
    }),
    buildPostAction("copy-revision-range", "复制提交范围", { primaryRange }),
    (() => {
      if (preservingConflictAction) {
        return buildPostAction(preservingConflictAction.kind, preservingConflictAction.label, {
          primaryRange,
          repoRoot: preservingConflictAction.repoRoot,
          payload: preservingConflictAction.payload,
        });
      }
      const conflictRoot = aggregated ? pickConflictRoot(primaryRange?.repoRoot || "", aggregated) : null;
      if (!conflictRoot) return null;
      return buildPostAction("resolve-conflicts", `处理 ${conflictRoot.rootName} 冲突`, {
        repoRoot: conflictRoot.repoRoot,
        payload: {
          repoRoot: conflictRoot.repoRoot,
        },
      });
    })(),
    savedChangesRoot?.preservingState?.savedChangesAction
      ? buildPostAction(
          savedChangesRoot.preservingState.savedChangesAction.kind,
          savedChangesRoot.preservingState.savedChangesAction.label,
          {
            primaryRange,
            repoRoot: savedChangesRoot.preservingState.savedChangesAction.repoRoot || savedChangesRoot.repoRoot,
            payload: savedChangesRoot.preservingState.savedChangesAction.payload,
          },
        )
      : null,
  ];
  return actions.filter((action): action is GitUpdatePostAction => !!action);
}

/**
 * 生成 Update Session 结果通知模型，对齐 IDEA 的 updated files / received commits / View Commits 语义。
 */
export async function buildUpdateSessionNotificationAsync(
  runtime: GitUpdateRepositoryGraphRuntime,
  requestedRepoRoot: string,
  aggregated: GitUpdateAggregatedSession,
): Promise<GitUpdateSessionNotificationData | undefined> {
  const ranges = (
    await Promise.all(
      aggregated.roots.map(async (root) => await buildNotificationRangeAsync(runtime, root)),
    )
  ).filter((range): range is GitUpdateNotificationRange => !!range);
  if (ranges.length <= 0) return undefined;

  const updatedFilesCount = ranges.reduce((sum, range) => sum + range.fileCount, 0);
  const receivedCommitsCount = ranges.reduce((sum, range) => sum + range.commitCount, 0);
  if (receivedCommitsCount <= 0) return undefined;

  const primaryRange = pickPrimaryNotificationRange(requestedRepoRoot, ranges);
  const filteredCommitsCount = primaryRange?.commitCount || 0;
  const skippedRoots = [...aggregated.skippedRoots];
  const descriptionParts: string[] = [];
  if (filteredCommitsCount > 0 && filteredCommitsCount !== receivedCommitsCount) {
    descriptionParts.push(`日志视图当前聚焦主仓范围，可查看 ${filteredCommitsCount} 个提交。`);
  }
  if (skippedRoots.length > 0) {
    descriptionParts.push(`另有 ${skippedRoots.length} 个仓库被跳过，可展开查看原因。`);
  }
  return {
    title: `${updatedFilesCount} 个文件在 ${receivedCommitsCount} 个提交中已更新`,
    description: descriptionParts.join(" ") || undefined,
    updatedFilesCount,
    receivedCommitsCount,
    filteredCommitsCount,
    ranges,
    primaryRange,
    skippedRoots,
    postActions: buildPostActions(ranges, primaryRange, aggregated),
  };
}
