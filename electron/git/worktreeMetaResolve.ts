// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import { execGitAsync } from "./exec";
import { toFsPathAbs, toFsPathKey } from "./pathKey";
import { parseWorktreeListPorcelain, type WorktreeListEntry } from "./worktreeList";

export type WorktreeListSnapshot = {
  /** 仓库顶层目录（git rev-parse --show-toplevel）。 */
  repoRoot: string;
  /** `git worktree list --porcelain` 的解析结果（路径为 git 输出原样）。 */
  worktrees: WorktreeListEntry[];
  /** 主 worktree 路径（约定为 porcelain 列表第一项；已尽力解析为绝对路径）。 */
  mainWorktree?: string;
};

export type ReadWorktreeListSnapshotResult =
  | { ok: true; snapshot: WorktreeListSnapshot }
  | { ok: false; error: string };

/**
 * 中文说明：判断路径字符串是否为“绝对路径”（兼容 Windows/Posix）。
 */
function isAnyAbsolutePath(p: string): boolean {
  const s = String(p || "").trim();
  if (!s) return false;
  // UNC 路径（Windows）也视为绝对路径
  if (s.startsWith("\\\\") || s.startsWith("//")) return true;
  return path.win32.isAbsolute(s) || path.posix.isAbsolute(s);
}

/**
 * 中文说明：将 git 输出的路径（可能为相对路径）解析为绝对路径。
 */
function resolveGitPath(baseDir: string, rawPath: string): string {
  const base = toFsPathAbs(baseDir);
  const p = String(rawPath || "").trim();
  if (!base || !p) return "";
  if (isAnyAbsolutePath(p)) return toFsPathAbs(p);
  return toFsPathAbs(path.resolve(base, p));
}

/**
 * 中文说明：将 `refs/heads/<name>` 形式的分支引用转换为短分支名。
 */
function toShortBranchName(ref: string): string {
  const r = String(ref || "").trim();
  if (!r) return "";
  return r.startsWith("refs/heads/") ? r.slice("refs/heads/".length) : r;
}

/**
 * 中文说明：读取指定目录所属仓库的 worktree 列表快照，并解析主 worktree 路径。
 * - 设计目标：在缺失 worktree-meta.json 创建记录时，仍可通过 git 本身信息推断主 worktree。
 * - 约定：主 worktree 为 `git worktree list --porcelain` 输出的第一项（与 UI/statusBatch 逻辑一致）。
 */
export async function readWorktreeListSnapshotAsync(args: {
  dir: string;
  gitPath?: string;
  timeoutMs?: number;
}): Promise<ReadWorktreeListSnapshotResult> {
  const dirAbs = toFsPathAbs(args.dir);
  const timeoutMs = Math.max(200, Math.min(30_000, Number(args.timeoutMs ?? 8000)));
  const gitPath = args.gitPath;
  if (!dirAbs) return { ok: false, error: "missing dir" };

  const top = await execGitAsync({ gitPath, argv: ["-C", dirAbs, "rev-parse", "--show-toplevel"], timeoutMs });
  if (!top.ok) return { ok: false, error: String(top.error || top.stderr || top.stdout || "git rev-parse failed").trim() || "git rev-parse failed" };
  const repoRoot = String(top.stdout || "").trim();
  if (!repoRoot) return { ok: false, error: "empty repoRoot" };

  const wt = await execGitAsync({ gitPath, argv: ["-C", repoRoot, "worktree", "list", "--porcelain"], timeoutMs: Math.max(timeoutMs, 4000) });
  if (!wt.ok) return { ok: false, error: String(wt.error || wt.stderr || wt.stdout || "git worktree list failed").trim() || "git worktree list failed" };
  const worktrees = parseWorktreeListPorcelain(wt.stdout);

  const mainWorktreeRaw = String(worktrees[0]?.worktree || "").trim();
  const mainWorktree = mainWorktreeRaw ? resolveGitPath(repoRoot, mainWorktreeRaw) : undefined;

  return { ok: true, snapshot: { repoRoot: toFsPathAbs(repoRoot), worktrees, mainWorktree } };
}

export type ResolveRepoMainPathResult =
  | { ok: true; repoMainPath: string; repoRoot: string; source: "worktree-list" | "repo-root" }
  | { ok: false; error: string };

export type PickRepoMainPathSource = "branch-owner" | "fallback" | "main-worktree" | "repo-root";

export type PickRepoMainPathResult = {
  repoMainPath: string;
  repoRoot: string;
  source: PickRepoMainPathSource;
};

/**
 * 中文说明：将 worktree 条目解析为绝对路径；失败时返回空字符串。
 */
function resolveWorktreeEntryPath(snapshot: WorktreeListSnapshot, entry: WorktreeListEntry | null | undefined): string {
  const repoRoot = toFsPathAbs(snapshot.repoRoot);
  const raw = String(entry?.worktree || "").trim();
  if (!repoRoot || !raw) return "";
  return resolveGitPath(repoRoot, raw);
}

/**
 * 中文说明：在快照中查找“当前持有指定分支”的 worktree 路径。
 */
function findWorktreePathByBranch(snapshot: WorktreeListSnapshot, branch: string): string {
  const shortBranch = toShortBranchName(branch);
  if (!shortBranch) return "";
  for (const item of snapshot.worktrees) {
    if (toShortBranchName(String(item?.branch || "").trim()) !== shortBranch) continue;
    const abs = resolveWorktreeEntryPath(snapshot, item);
    if (abs) return abs;
  }
  return "";
}

/**
 * 中文说明：在快照中查找“与给定路径匹配”的已登记 worktree 路径。
 */
function findWorktreePathByKey(snapshot: WorktreeListSnapshot, candidatePath: string): string {
  const targetKey = toFsPathKey(candidatePath);
  if (!targetKey) return "";
  for (const item of snapshot.worktrees) {
    const abs = resolveWorktreeEntryPath(snapshot, item);
    if (!abs) continue;
    if (toFsPathKey(abs) === targetKey) return abs;
  }
  return "";
}

/**
 * 中文说明：基于 worktree 快照挑选“最适合作为后续操作落点”的 repoMainPath。
 * - 若基分支当前已被某个 worktree 持有，则优先返回该 worktree；
 * - 否则优先复用调用方给定的 fallbackPath（前提是它仍登记在 worktree 列表中）；
 * - 再回退到主 worktree，最后回退到 repoRoot。
 */
export function pickRepoMainPathFromSnapshot(args: {
  snapshot: WorktreeListSnapshot;
  branch?: string;
  fallbackPath?: string;
}): PickRepoMainPathResult {
  const snapshot = args.snapshot;
  const repoRoot = toFsPathAbs(snapshot.repoRoot);
  const byBranch = findWorktreePathByBranch(snapshot, String(args.branch || "").trim());
  if (byBranch) return { repoMainPath: byBranch, repoRoot, source: "branch-owner" };

  const byFallback = findWorktreePathByKey(snapshot, String(args.fallbackPath || "").trim());
  if (byFallback) return { repoMainPath: byFallback, repoRoot, source: "fallback" };

  const mainWorktree = toFsPathAbs(String(snapshot.mainWorktree || "").trim());
  if (mainWorktree) return { repoMainPath: mainWorktree, repoRoot, source: "main-worktree" };
  return { repoMainPath: repoRoot, repoRoot, source: "repo-root" };
}

/**
 * 中文说明：在缺失创建记录时，从 git 信息推断主 worktree 路径（repoMainPath）。
 * - 优先使用 `git worktree list --porcelain` 的第一项。
 * - 若读取失败，则回退到 repoRoot（保证尽量可用，但可能不是真正的“主 worktree”）。
 */
export async function resolveRepoMainPathFromWorktreeAsync(args: {
  worktreePath: string;
  gitPath?: string;
  timeoutMs?: number;
}): Promise<ResolveRepoMainPathResult> {
  const wt = toFsPathAbs(args.worktreePath);
  if (!wt) return { ok: false, error: "missing worktreePath" };

  const snap = await readWorktreeListSnapshotAsync({ dir: wt, gitPath: args.gitPath, timeoutMs: args.timeoutMs });
  if (!snap.ok) return { ok: false, error: snap.error };

  const picked = pickRepoMainPathFromSnapshot({ snapshot: snap.snapshot });
  return {
    ok: true,
    repoMainPath: picked.repoMainPath,
    repoRoot: picked.repoRoot,
    source: picked.source === "repo-root" ? "repo-root" : "worktree-list",
  };
}

export type ResolveRepoMainPathForBranchResult =
  | { ok: true; repoMainPath: string; repoRoot: string; source: PickRepoMainPathSource }
  | { ok: false; error: string };

/**
 * 中文说明：按“基分支当前所属 worktree”优先解析 repoMainPath。
 * - 适用场景：回收/重置等需要在某个可切换到基分支的 worktree 上执行；
 * - 若基分支未被任何 worktree 持有，则回退到 fallbackPath / 主 worktree / repoRoot。
 */
export async function resolveRepoMainPathForBranchAsync(args: {
  dir: string;
  branch?: string;
  fallbackPath?: string;
  gitPath?: string;
  timeoutMs?: number;
}): Promise<ResolveRepoMainPathForBranchResult> {
  const dirAbs = toFsPathAbs(args.dir);
  if (!dirAbs) return { ok: false, error: "missing dir" };

  const snap = await readWorktreeListSnapshotAsync({ dir: dirAbs, gitPath: args.gitPath, timeoutMs: args.timeoutMs });
  if (!snap.ok) return { ok: false, error: snap.error };

  const picked = pickRepoMainPathFromSnapshot({
    snapshot: snap.snapshot,
    branch: String(args.branch || "").trim(),
    fallbackPath: String(args.fallbackPath || "").trim(),
  });
  return { ok: true, ...picked };
}

export type ResolveWorktreeBranchResult =
  | { ok: true; branch: string; detached: boolean; source: "worktree-list" | "symbolic-ref" }
  | { ok: false; error: string };

/**
 * 中文说明：尽力解析指定 worktree 的当前分支名（short）。
 * - 优先从 `git worktree list --porcelain` 中匹配 worktreePath 获取分支（避免依赖目录仍存在/可进入）。
 * - 若未命中，则回退到 `git symbolic-ref --short -q HEAD`（若 detached 则返回 branch="" 且 detached=true）。
 */
export async function resolveWorktreeBranchNameAsync(args: {
  repoDir: string;
  worktreePath: string;
  gitPath?: string;
  timeoutMs?: number;
}): Promise<ResolveWorktreeBranchResult> {
  const repoDir = toFsPathAbs(args.repoDir);
  const worktreePath = toFsPathAbs(args.worktreePath);
  const timeoutMs = Math.max(200, Math.min(30_000, Number(args.timeoutMs ?? 8000)));
  const gitPath = args.gitPath;
  if (!repoDir || !worktreePath) return { ok: false, error: "missing args" };

  // A) 尝试从 worktree list 里匹配（repoDir 可能是任意 worktree 根或子目录）
  const snap = await readWorktreeListSnapshotAsync({ dir: repoDir, gitPath, timeoutMs });
  if (snap.ok) {
    const targetKey = toFsPathKey(worktreePath);
    const hit = snap.snapshot.worktrees.find((x) => {
      const raw = String(x?.worktree || "").trim();
      if (!raw) return false;
      const abs = resolveGitPath(snap.snapshot.repoRoot, raw);
      return abs ? toFsPathKey(abs) === targetKey : false;
    });
    if (hit) {
      const ref = String(hit.branch || "").trim();
      const short = toShortBranchName(ref);
      const detached = hit.detached === true;
      if (short) return { ok: true, branch: short, detached: false, source: "worktree-list" };
      if (detached) return { ok: true, branch: "", detached: true, source: "worktree-list" };
      // 未标记 detached 但也无 branch：按空处理，回退 symbolic-ref 再判定
    }
  }

  // B) 回退：symbolic-ref
  const br = await execGitAsync({ gitPath, argv: ["-C", worktreePath, "symbolic-ref", "--short", "-q", "HEAD"], timeoutMs });
  const branch = String(br.stdout || "").trim();
  if (br.ok && branch) return { ok: true, branch, detached: false, source: "symbolic-ref" };
  return { ok: true, branch: "", detached: true, source: "symbolic-ref" };
}
