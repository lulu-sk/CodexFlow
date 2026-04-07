/**
 * 中文说明：解析删除弹窗里“重置到分支”的默认目标分支。
 *
 * 选择优先级：
 * - 优先选择创建该 worktree 时记录的基分支；
 * - 若记录分支不存在，则退回到目标基 worktree 当前分支；
 * - 若仍不可用，则退回到首个可选分支。
 */
export function resolveWorktreeDeleteResetTargetBranch(args: {
  branches?: string[] | null;
  recordedBaseBranch?: string;
  repoCurrentBranch?: string;
}): string {
  const branches = Array.isArray(args.branches)
    ? Array.from(new Set(args.branches.map((item) => String(item || "").trim()).filter(Boolean)))
    : [];
  const branchSet = new Set<string>(branches);
  const recordedBaseBranch = String(args.recordedBaseBranch || "").trim();
  if (recordedBaseBranch && branchSet.has(recordedBaseBranch)) return recordedBaseBranch;
  const repoCurrentBranch = String(args.repoCurrentBranch || "").trim();
  if (repoCurrentBranch && branchSet.has(repoCurrentBranch)) return repoCurrentBranch;
  return branches[0] || "";
}
