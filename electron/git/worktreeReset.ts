// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { execGitAsync, spawnGitAsync } from "./exec";
import { toFsPathAbs, toFsPathKey } from "./pathKey";
import { resolveRepoMainPathFromWorktreeAsync } from "./worktreeMetaResolve";
import { buildNextWorktreeMeta, getWorktreeMeta, setWorktreeMeta, type WorktreeMeta } from "../stores/worktreeMetaStore";

export type ResetWorktreeResult =
  | { ok: true }
  | { ok: false; needsForce?: boolean; error?: string };

const resetWorktreeTaskByPathKey = new Map<string, Promise<ResetWorktreeResult>>();

/**
 * 中文说明：对齐 worktree 到主工作区当前基线，并恢复为干净状态（保持目录，不删除）。
 *
 * 行为约定：
 * - 以 targetRef（默认 baseBranch）为“主工作区当前基线”。
 * - 将 worktree 分支（wtBranch）强制 reset 到 targetRef，并执行 `git clean -fd` 清理未跟踪文件（保留 ignored）。
 * - 若 worktree 有未提交修改且未传 force，则返回 needsForce=true，等待 UI 二次确认。
 * - 成功后会把 meta.baseRefAtCreate 更新为 targetRef 的最新提交号，确保后续“按分叉点回收”边界正确。
 */
export async function resetWorktreeAsync(req: {
  worktreePath: string;
  gitPath?: string;
  targetRef?: string;
  force?: boolean;
}): Promise<ResetWorktreeResult> {
  const wt = toFsPathAbs(req.worktreePath);
  const key = toFsPathKey(wt);
  if (!key) return { ok: false, needsForce: false, error: "missing worktreePath" };

  const existing = resetWorktreeTaskByPathKey.get(key);
  if (existing) return await existing;

  const task = (async (): Promise<ResetWorktreeResult> => {
    const gitPath = req.gitPath;

    // 1) 读取创建记录；缺失时通过 git worktree 信息推断 repoMainPath/baseBranch/wtBranch
    const existingMeta = getWorktreeMeta(wt);
    let repoMainPath = toFsPathAbs(String(existingMeta?.repoMainPath || ""));
    if (!repoMainPath) {
      const inferred = await resolveRepoMainPathFromWorktreeAsync({ worktreePath: wt, gitPath, timeoutMs: 12_000 });
      if (!inferred.ok) return { ok: false, needsForce: false, error: inferred.error || "missing repoMainPath" };
      repoMainPath = inferred.repoMainPath;
    }

    const metaWtBranch = String(existingMeta?.wtBranch || "").trim();
    const metaBaseBranch = String(existingMeta?.baseBranch || "").trim();
    let wtBranch = metaWtBranch;
    if (!wtBranch) {
      const br = await execGitAsync({ gitPath, argv: ["-C", wt, "symbolic-ref", "--short", "-q", "HEAD"], timeoutMs: 8000 });
      wtBranch = String(br.stdout || "").trim();
    }
    if (!wtBranch) return { ok: false, needsForce: false, error: "无法确定 worktree 当前分支（可能处于 detached HEAD）" };

    let baseBranch = metaBaseBranch;
    if (!baseBranch) {
      const br = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "symbolic-ref", "--short", "-q", "HEAD"], timeoutMs: 8000 });
      baseBranch = String(br.stdout || "").trim();
    }

    const targetRef = String(req.targetRef || baseBranch).trim();
    if (!targetRef) return { ok: false, needsForce: false, error: "无法确定目标基线（请手动指定 targetRef）" };

    // 2) 写入/更新映射，保证后续 delete/recycle/fork-point 等功能无需依赖“创建时记录”
    let meta: WorktreeMeta = buildNextWorktreeMeta({ existing: existingMeta, repoMainPath, baseBranch: baseBranch || metaBaseBranch, wtBranch });
    try { setWorktreeMeta(wt, meta); } catch {}

    // 1) 检查 worktree 是否有未提交修改（未确认 force 则拒绝）
    const st = await execGitAsync({ gitPath, argv: ["-C", wt, "status", "--porcelain"], timeoutMs: 8000 });
    const isDirty = st.ok && String(st.stdout || "").trim().length > 0;
    if (isDirty && req.force !== true) return { ok: false, needsForce: true, error: "检测到未提交修改" };

    // 2) 切回 worktree 分支并对齐到目标基线
    const switchRes = await spawnGitAsync({ gitPath, argv: ["-C", wt, "switch", wtBranch], timeoutMs: 12_000 });
    if (!switchRes.ok) return { ok: false, needsForce: false, error: switchRes.error || switchRes.stderr.trim() || "git switch failed" };

    // 中文说明：大仓库 reset/clean 可能较慢，给更宽松超时。
    const resetTimeoutMs = 15 * 60_000;
    const cleanTimeoutMs = 15 * 60_000;

    const resetRes = await spawnGitAsync({ gitPath, argv: ["-C", wt, "reset", "--hard", targetRef], timeoutMs: resetTimeoutMs });
    if (!resetRes.ok) return { ok: false, needsForce: false, error: resetRes.error || resetRes.stderr.trim() || "git reset --hard failed" };

    const cleanRes = await spawnGitAsync({ gitPath, argv: ["-C", wt, "clean", "-fd"], timeoutMs: cleanTimeoutMs });
    if (!cleanRes.ok) return { ok: false, needsForce: false, error: cleanRes.error || cleanRes.stderr.trim() || "git clean -fd failed" };

    // 3) 更新创建基线（用于后续回收默认边界）
    const shaRes = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", targetRef], timeoutMs: 12_000 });
    const sha = shaRes.ok ? String(shaRes.stdout || "").trim() : "";
    meta = buildNextWorktreeMeta({ existing: meta, repoMainPath, baseBranch: baseBranch || meta.baseBranch, wtBranch, baseRefAtCreate: sha || meta.baseRefAtCreate });
    try { setWorktreeMeta(wt, meta); } catch {}
    return { ok: true };
  })();

  resetWorktreeTaskByPathKey.set(key, task);
  try {
    return await task;
  } finally {
    resetWorktreeTaskByPathKey.delete(key);
  }
}
