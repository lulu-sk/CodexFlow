/**
 * 中文说明：构建“回收 worktree”对话框读取分支列表的候选路径。
 * 优先级：已记录的目标 worktree > 通过 Git 推断的 fallback 目标 > 当前子 worktree。
 */
export function buildWorktreeRecycleBranchListCandidates(args: {
  repoMainPath?: string;
  fallbackRepoPath?: string;
  projectPath?: string;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [args.repoMainPath, args.fallbackRepoPath, args.projectPath]) {
    const path = String(raw || "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * 中文说明：解析回收对话框后续动作应展示/使用的目标 worktree 路径。
 * - 若分支列表直接从目标 worktree / fallback 目标读取成功，则直接使用该路径；
 * - 若只能从当前子 worktree 读取分支列表，但已推断出 fallback 目标，则仍保留 fallback，避免 UI 把目标 worktree 错认为当前子 worktree；
 * - 若无更可靠候选，则回退到实际读取成功路径。
 */
export function resolveWorktreeRecycleRepoMainPath(args: {
  branchListPath?: string;
  fallbackRepoPath?: string;
  projectPath?: string;
}): string {
  const branchListPath = String(args.branchListPath || "").trim();
  const fallbackRepoPath = String(args.fallbackRepoPath || "").trim();
  const projectPath = String(args.projectPath || "").trim();
  if (branchListPath && branchListPath !== projectPath) return branchListPath;
  if (fallbackRepoPath) return fallbackRepoPath;
  return branchListPath || projectPath;
}
