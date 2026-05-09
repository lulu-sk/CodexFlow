// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import { promises as fsp } from "node:fs";
import type { GitExecResult } from "./exec";

export type GitRollbackChange = {
  path: string;
  oldPath?: string;
  x?: string;
  y?: string;
  staged?: boolean;
  unstaged?: boolean;
  untracked?: boolean;
  ignored?: boolean;
  renamed?: boolean;
  deleted?: boolean;
};

type GitRollbackKind = "new" | "moved" | "modification" | "deleted" | "untracked";

export type GitRollbackRuntime = {
  runGitSpawnAsync(repoRoot: string, argv: string[], timeoutMs: number): Promise<GitExecResult>;
  toGitErrorMessage(res: GitExecResult, fallback: string): string;
};

/**
 * 规整提交回滚请求中的路径，统一去重并保持仓库内相对路径格式。
 */
function normalizeRollbackChanges(changesInput: GitRollbackChange[]): GitRollbackChange[] {
  const result: GitRollbackChange[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(changesInput) ? changesInput : []) {
    const filePath = String(raw?.path || "").trim().replace(/\\/g, "/");
    if (!filePath) continue;
    const oldPath = String(raw?.oldPath || "").trim().replace(/\\/g, "/") || undefined;
    const key = `${filePath}\u0000${oldPath || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      path: filePath,
      oldPath,
      x: String(raw?.x || "").trim(),
      y: String(raw?.y || "").trim(),
      staged: raw?.staged === true,
      unstaged: raw?.unstaged === true,
      untracked: raw?.untracked === true,
      ignored: raw?.ignored === true,
      renamed: raw?.renamed === true,
      deleted: raw?.deleted === true,
    });
  }
  return result;
}

/**
 * 从状态条目推断 Git rollback 所需的 change type，尽量贴近 IDEA 的 NEW/MOVED/MODIFICATION/DELETED 分支。
 */
function resolveRollbackKind(change: GitRollbackChange): GitRollbackKind {
  const x = String(change.x || "").trim().toUpperCase();
  const y = String(change.y || "").trim().toUpperCase();
  const stagedCode = x[0] || "";
  const unstagedCode = y[0] || "";
  if (change.untracked && !change.staged) return "untracked";
  if ((change.renamed || stagedCode === "R" || unstagedCode === "R") && change.oldPath)
    return "moved";
  if (change.deleted || stagedCode === "D" || unstagedCode === "D")
    return "deleted";
  if (stagedCode === "A" || unstagedCode === "A")
    return "new";
  return "modification";
}

/**
 * 判断回滚请求中是否至少存在一个可逆文件，显式排除纯 untracked/ignored 条目。
 */
export function hasReversibleRollbackChanges(changesInput: GitRollbackChange[]): boolean {
  return normalizeRollbackChanges(changesInput).some((change) => {
    if (change.ignored) return false;
    return resolveRollbackKind(change) !== "untracked";
  });
}

/**
 * 执行一次 `git rm --cached -f`，用于 NEW/MOVED 场景下把目标从索引中移除。
 */
async function unindexPathAsync(runtime: GitRollbackRuntime, repoRoot: string, filePath: string): Promise<void> {
  const res = await runtime.runGitSpawnAsync(repoRoot, ["rm", "--cached", "-f", "--", filePath], 120_000);
  if (!res.ok) throw new Error(runtime.toGitErrorMessage(res, `从索引移除 ${filePath} 失败`));
}

/**
 * 把指定路径恢复到 `HEAD` 版本，同时覆盖索引与工作区。
 */
async function restorePathFromHeadAsync(runtime: GitRollbackRuntime, repoRoot: string, filePath: string): Promise<void> {
  const res = await runtime.runGitSpawnAsync(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", filePath], 120_000);
  if (!res.ok) throw new Error(runtime.toGitErrorMessage(res, `恢复 ${filePath} 失败`));
}

/**
 * 在 MOVED 场景下删除新路径工作区文件，保持最终树回到 rename 前状态。
 */
async function deleteWorkingPathIfExistsAsync(repoRoot: string, filePath: string): Promise<void> {
  const absolutePath = path.join(repoRoot, filePath);
  try {
    await fsp.rm(absolutePath, { recursive: true, force: true });
  } catch {}
}

/**
 * 按 IDEA GitRollbackEnvironment 的四类 change type 执行真实回滚。
 * - `NEW`：从索引移除，保留为未跟踪文件；
 * - `MOVED`：移除新路径索引与工作区文件，并恢复旧路径；
 * - `MODIFICATION/DELETED`：直接恢复到 `HEAD`。
 */
export async function executeRollbackChangesAsync(
  runtime: GitRollbackRuntime,
  repoRoot: string,
  changesInput: GitRollbackChange[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const changes = normalizeRollbackChanges(changesInput).filter((change) => !change.ignored);
  if (changes.length <= 0) return { ok: false, error: "未选择需要回滚的文件" };
  if (!changes.some((change) => resolveRollbackKind(change) !== "untracked"))
    return { ok: false, error: "当前选择中没有可回滚的已跟踪改动" };

  try {
    for (const change of changes) {
      const kind = resolveRollbackKind(change);
      if (kind === "untracked") continue;
      if (kind === "new") {
        await unindexPathAsync(runtime, repoRoot, change.path);
        continue;
      }
      if (kind === "moved") {
        await unindexPathAsync(runtime, repoRoot, change.path);
        await deleteWorkingPathIfExistsAsync(repoRoot, change.path);
        await restorePathFromHeadAsync(runtime, repoRoot, String(change.oldPath || "").trim() || change.path);
        continue;
      }
      await restorePathFromHeadAsync(runtime, repoRoot, change.path);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: String((error as Error)?.message || error || "回滚失败"),
    };
  }
}
