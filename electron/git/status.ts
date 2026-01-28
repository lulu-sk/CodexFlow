// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { promises as fsp } from "node:fs";
import { execGitAsync } from "./exec";
import { toFsPathAbs, toFsPathKey } from "./pathKey";
import { parseWorktreeListPorcelain, type WorktreeListEntry } from "./worktreeList";

export type GitDirInfo = {
  /** 输入目录（绝对路径，尽量与持久化 Key 对齐） */
  dir: string;
  /** 目录是否存在 */
  exists: boolean;
  /** 是否为目录 */
  isDirectory: boolean;
  /** 是否位于 git work tree 内（含子目录） */
  isInsideWorkTree: boolean;
  /** 若 isInsideWorkTree=true，返回仓库顶层目录 */
  repoRoot?: string;
  /** 是否“目录本身就是仓库顶层”（用于显示分支/下拉） */
  isRepoRoot: boolean;
  /** 当前分支（short），detached 时为空 */
  branch?: string;
  /** detached HEAD 标记 */
  detached: boolean;
  /** detached 时的 short sha（可选） */
  headSha?: string;
  /** 是否在 `git worktree list` 中登记为 worktree 根（含主 worktree） */
  isWorktree: boolean;
  /** worktree 列表（仅当 isRepoRoot=true 且能读取时返回） */
  worktrees?: WorktreeListEntry[];
  /** 主 worktree 路径（约定为 porcelain 列表中的第一项） */
  mainWorktree?: string;
  /** 错误摘要（用于 UI 提示） */
  error?: string;
};

type CacheEntry = { at: number; value: GitDirInfo };
const cache = new Map<string, CacheEntry>();

/**
 * 获取指定目录的 git 仓库/工作树信息（带短 TTL 缓存，避免列表渲染时重复调用）。
 */
export async function getGitDirInfoAsync(args: {
  dir: string;
  gitPath?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
}): Promise<GitDirInfo> {
  const abs = toFsPathAbs(args.dir);
  const key = toFsPathKey(abs);
  const ttl = Math.max(0, Math.min(10_000, Number(args.cacheTtlMs ?? 1500)));
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at >= 0 && now - hit.at < ttl) {
    return hit.value;
  }

  const base: GitDirInfo = {
    dir: abs,
    exists: false,
    isDirectory: false,
    isInsideWorkTree: false,
    isRepoRoot: false,
    detached: false,
    isWorktree: false,
  };

  try {
    const st = await fsp.stat(abs);
    base.exists = true;
    base.isDirectory = st.isDirectory();
    if (!base.isDirectory) {
      cache.set(key, { at: now, value: base });
      return base;
    }
  } catch (e: any) {
    base.error = String(e?.message || e);
    cache.set(key, { at: now, value: base });
    return base;
  }

  const timeoutMs = Math.max(200, Math.min(30_000, Number(args.timeoutMs ?? 2500)));
  const gitPath = args.gitPath;

  // 1) 是否位于 work tree 内
  const inside = await execGitAsync({
    gitPath,
    argv: ["-C", abs, "rev-parse", "--is-inside-work-tree"],
    timeoutMs,
  });
  if (!inside.ok || inside.stdout.trim() !== "true") {
    base.isInsideWorkTree = false;
    base.error = inside.error || inside.stderr.trim() || base.error;
    cache.set(key, { at: now, value: base });
    return base;
  }
  base.isInsideWorkTree = true;

  // 2) 仓库顶层
  const top = await execGitAsync({
    gitPath,
    argv: ["-C", abs, "rev-parse", "--show-toplevel"],
    timeoutMs,
  });
  if (!top.ok) {
    base.error = top.error || top.stderr.trim();
    cache.set(key, { at: now, value: base });
    return base;
  }
  const repoRoot = String(top.stdout || "").trim();
  base.repoRoot = repoRoot;
  base.isRepoRoot = toFsPathKey(repoRoot) === toFsPathKey(abs);

  // 非仓库顶层：按“普通目录节点”对待（不展示分支/下拉）
  if (!base.isRepoRoot) {
    cache.set(key, { at: now, value: base });
    return base;
  }

  // 3) 分支 / detached
  const br = await execGitAsync({
    gitPath,
    argv: ["-C", abs, "symbolic-ref", "--short", "-q", "HEAD"],
    timeoutMs,
  });
  const branch = String(br.stdout || "").trim();
  if (br.ok && branch) {
    base.branch = branch;
    base.detached = false;
  } else {
    base.detached = true;
    const sha = await execGitAsync({
      gitPath,
      argv: ["-C", abs, "rev-parse", "--short", "HEAD"],
      timeoutMs,
    });
    if (sha.ok) base.headSha = String(sha.stdout || "").trim();
  }

  // 4) worktree list（用于识别是否为 worktree 与主 worktree）
  const wt = await execGitAsync({
    gitPath,
    argv: ["-C", abs, "worktree", "list", "--porcelain"],
    timeoutMs: Math.max(timeoutMs, 4000),
  });
  if (wt.ok) {
    const list = parseWorktreeListPorcelain(wt.stdout);
    base.worktrees = list;
    base.mainWorktree = list[0]?.worktree;
    const targetKey = toFsPathKey(abs);
    base.isWorktree = list.some((x) => toFsPathKey(x.worktree) === targetKey);
  } else {
    // worktree list 失败不应影响“分支展示”，因此只做弱错误记录
    base.error = base.error || wt.error || wt.stderr.trim();
  }

  cache.set(key, { at: now, value: base });
  return base;
}

/**
 * 批量获取目录的 git 信息（并发受限 + 复用缓存）。
 */
export async function getGitDirInfoBatchAsync(args: {
  dirs: string[];
  gitPath?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  concurrency?: number;
}): Promise<GitDirInfo[]> {
  const list = Array.isArray(args.dirs) ? args.dirs.map((x) => String(x || "")).filter(Boolean) : [];
  const max = Math.max(1, Math.min(16, Number(args.concurrency ?? 6)));
  let running = 0;
  const q: Array<() => void> = [];
  const limit = async <T>(fn: () => Promise<T>): Promise<T> =>
    await new Promise<T>((resolve, reject) => {
      const run = () => {
        running++;
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            running--;
            const next = q.shift();
            if (next) next();
          });
      };
      if (running < max) run();
      else q.push(run);
    });

  const out: GitDirInfo[] = new Array(list.length);
  await Promise.all(
    list.map((dir, idx) =>
      limit(async () => {
        out[idx] = await getGitDirInfoAsync({
          dir,
          gitPath: args.gitPath,
          timeoutMs: args.timeoutMs,
          cacheTtlMs: args.cacheTtlMs,
        });
      })
    )
  );
  return out;
}
