// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { execGitAsync, spawnGitAsync } from "./exec";
import { toFsPathAbs, toFsPathKey } from "./pathKey";
import { getWorktreeMeta, setWorktreeMeta, type WorktreeMeta } from "../stores/worktreeMetaStore";

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
    const meta = getWorktreeMeta(wt);
    if (!meta) return { ok: false, needsForce: false, error: "missing worktree meta" };

    const gitPath = req.gitPath;
    const repoMainPath = toFsPathAbs(String(meta.repoMainPath || ""));
    const wtBranch = String(meta.wtBranch || "").trim();
    const baseBranch = String(meta.baseBranch || "").trim();
    const targetRef = String(req.targetRef || baseBranch).trim();
    if (!repoMainPath || !wtBranch || !targetRef) return { ok: false, needsForce: false, error: "missing args" };

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
    const nextMeta: WorktreeMeta = {
      ...meta,
      baseRefAtCreate: sha || meta.baseRefAtCreate,
    };
    try { setWorktreeMeta(wt, nextMeta); } catch {}
    return { ok: true };
  })();

  resetWorktreeTaskByPathKey.set(key, task);
  try {
    return await task;
  } finally {
    resetWorktreeTaskByPathKey.delete(key);
  }
}
