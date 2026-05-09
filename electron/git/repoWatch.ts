// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { BrowserWindow } from "electron";
import { execGitAsync } from "./exec";

export type GitRepoWatchPayload = {
  repoRoot: string;
  reason: string;
  paths: string[];
};

type RepoWatchConfig = {
  repoRoot: string;
  gitDir: string;
  commonDir: string;
  watchRoots: string[];
};

type RepoWatchState = RepoWatchConfig & {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  dirtyPaths: Set<string>;
  reasons: Set<string>;
};

type RepoWatchListener = (payload: GitRepoWatchPayload) => void;

const repoWatchers = new Map<string, RepoWatchState>();
const repoWatchListeners = new Set<RepoWatchListener>();

/**
 * 将仓库路径规整为 repo watcher 内部使用的稳定键。
 */
function normalizeRepoWatchKey(repoRoot: string): string {
  return String(repoRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 把任意路径规整为统一的 POSIX 绝对路径文本，便于后续路径匹配。
 */
function normalizeAbsolutePath(pathText: string): string {
  return String(pathText || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 为路径归类专门生成稳定比较键；Windows 盘符路径按非区分大小写语义整体转小写，避免 worktree gitdir 事件因大小写抖动漏判。
 */
function normalizeRepoWatchComparisonPath(pathText: string): string {
  const normalized = normalizeAbsolutePath(pathText);
  if (/^[A-Za-z]:\//.test(normalized)) return normalized.toLowerCase();
  return normalized;
}

/**
 * 把 Git 返回的相对目录解析成绝对路径，兼容普通仓库与 worktree。
 */
function resolveGitPath(repoRoot: string, gitPath: string): string {
  const cleanPath = String(gitPath || "").trim();
  if (!cleanPath) return "";
  if (path.isAbsolute(cleanPath)) return normalizeAbsolutePath(cleanPath);
  return normalizeAbsolutePath(path.resolve(repoRoot, cleanPath));
}

/**
 * 判断 `.git` 目录下哪些路径属于真正需要触发工作台刷新的 Git 元数据。
 */
export function classifyRepoWatchPath(args: {
  gitDir: string;
  commonDir: string;
  filePath: string;
}): string | null {
  const absolutePath = normalizeRepoWatchComparisonPath(args.filePath);
  const gitDir = normalizeRepoWatchComparisonPath(args.gitDir);
  const commonDir = normalizeRepoWatchComparisonPath(args.commonDir);
  const toRelative = (basePath: string): string => {
    if (!basePath) return "";
    if (absolutePath === basePath) return "";
    const prefix = `${basePath}/`;
    if (!absolutePath.startsWith(prefix)) return "";
    return absolutePath.slice(prefix.length).replace(/\\/g, "/");
  };

  const candidates = [toRelative(gitDir), toRelative(commonDir)].filter(Boolean);
  for (const relativePath of candidates) {
    const normalizedRelativePath = relativePath.toLowerCase();
    if (normalizedRelativePath === "index") return "index";
    if (normalizedRelativePath === "head" || normalizedRelativePath === "orig_head") return "head";
    if (normalizedRelativePath === "packed-refs") return "refs";
    if (normalizedRelativePath === "info/exclude") return "exclude";
    if (normalizedRelativePath.startsWith("refs/heads/") || normalizedRelativePath.startsWith("refs/remotes/")) return "refs";
    if (normalizedRelativePath.startsWith("rebase-merge/") || normalizedRelativePath.startsWith("rebase-apply/")) return "rebase";
    if (normalizedRelativePath.startsWith("worktrees/")) return "worktrees";
    if (normalizedRelativePath === "merge_head" || normalizedRelativePath === "merge_msg" || normalizedRelativePath === "auto_merge") return "merge";
    if (normalizedRelativePath === "cherry_pick_head") return "cherry-pick";
    if (normalizedRelativePath === "revert_head") return "revert";
  }
  return null;
}

/**
 * 判断某路径是否属于 repo watcher 应忽略的 Git 内部噪音目录，避免对象库变化引发刷新风暴。
 */
function shouldIgnoreRepoWatchPath(watchedPath: string): boolean {
  const normalized = normalizeAbsolutePath(watchedPath).toLowerCase();
  return normalized.includes("/objects/")
    || normalized.endsWith("/objects")
    || normalized.includes("/logs/")
    || normalized.endsWith("/logs")
    || normalized.includes("/hooks/")
    || normalized.endsWith("/hooks")
    || normalized.includes("/rr-cache/")
    || normalized.endsWith("/rr-cache");
}

/**
 * 向订阅者和所有窗口广播 repo dirty 事件。
 */
function emitRepoWatchPayload(payload: GitRepoWatchPayload): void {
  for (const listener of Array.from(repoWatchListeners)) {
    try {
      listener(payload);
    } catch {}
  }
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        window.webContents.send("gitRepoWatch:changed", payload);
      } catch {}
    }
  }
  catch {}
}

/**
 * 按仓库聚合高频 Git 元数据事件，避免 `git add/reset/rebase` 等操作触发刷新风暴。
 */
function scheduleRepoWatchFlush(state: RepoWatchState): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    const reasons = Array.from(state.reasons);
    const paths = Array.from(state.dirtyPaths);
    state.reasons.clear();
    state.dirtyPaths.clear();
    if (reasons.length === 0 && paths.length === 0) return;
    emitRepoWatchPayload({
      repoRoot: state.repoRoot,
      reason: reasons[0] || "git",
      paths,
    });
  }, 140);
}

/**
 * 关闭指定仓库对应的 watcher，并释放相关内存状态。
 */
function stopRepoWatcherByKey(repoKey: string): void {
  const state = repoWatchers.get(repoKey);
  if (!state) return;
  try {
    if (state.timer) clearTimeout(state.timer);
  } catch {}
  try {
    void state.watcher.close();
  } catch {}
  repoWatchers.delete(repoKey);
}

/**
 * 解析仓库的 git/common 目录位置，为 repo watcher 提供跨普通仓库与 worktree 的统一输入。
 */
async function resolveRepoWatchConfigAsync(repoRoot: string): Promise<RepoWatchConfig | null> {
  const cleanRepoRoot = String(repoRoot || "").trim();
  if (!cleanRepoRoot) return null;
  const [gitDirRes, commonDirRes] = await Promise.all([
    execGitAsync({ cwd: cleanRepoRoot, argv: ["rev-parse", "--git-dir"], timeoutMs: 15_000 }),
    execGitAsync({ cwd: cleanRepoRoot, argv: ["rev-parse", "--git-common-dir"], timeoutMs: 15_000 }),
  ]);
  if (!gitDirRes.ok || !commonDirRes.ok) return null;
  const gitDir = resolveGitPath(cleanRepoRoot, gitDirRes.stdout);
  const commonDir = resolveGitPath(cleanRepoRoot, commonDirRes.stdout);
  const watchRoots = Array.from(new Set([gitDir, commonDir].filter(Boolean)));
  if (watchRoots.length === 0) return null;
  return {
    repoRoot: cleanRepoRoot,
    gitDir,
    commonDir,
    watchRoots,
  };
}

/**
 * 确保指定仓库的 repo watcher 已创建；已存在时复用旧实例。
 */
async function ensureRepoWatcherAsync(repoRoot: string): Promise<boolean> {
  const repoKey = normalizeRepoWatchKey(repoRoot);
  if (!repoKey) return false;
  if (repoWatchers.has(repoKey)) return false;
  const config = await resolveRepoWatchConfigAsync(repoRoot);
  if (!config) return false;

  const watcher = chokidar.watch(config.watchRoots, {
    ignoreInitial: true,
    persistent: true,
    disableGlobbing: true,
    ignored: shouldIgnoreRepoWatchPath,
    awaitWriteFinish: false,
  });

  const state: RepoWatchState = {
    ...config,
    watcher,
    timer: null,
    dirtyPaths: new Set<string>(),
    reasons: new Set<string>(),
  };

  watcher.on("all", (_eventName, rawPath) => {
    const absolutePath = normalizeAbsolutePath(rawPath);
    const reason = classifyRepoWatchPath({
      gitDir: state.gitDir,
      commonDir: state.commonDir,
      filePath: absolutePath,
    });
    if (!reason) return;
    state.reasons.add(reason);
    state.dirtyPaths.add(absolutePath);
    scheduleRepoWatchFlush(state);
  });

  watcher.on("error", () => {
    stopRepoWatcherByKey(repoKey);
  });

  repoWatchers.set(repoKey, state);
  return true;
}

/**
 * 统一设置当前活跃仓库根集合；多余 watcher 会被关闭，缺失 watcher 会被补建。
 */
export async function setActiveRepoRootsAsync(repoRoots: string[]): Promise<{ opened: number; closed: number; remain: number }> {
  const normalizedRoots = Array.from(new Set(
    (repoRoots || [])
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  ));
  const allowedKeys = new Set(normalizedRoots.map((repoRoot) => normalizeRepoWatchKey(repoRoot)));
  let closed = 0;
  for (const repoKey of Array.from(repoWatchers.keys())) {
    if (allowedKeys.has(repoKey)) continue;
    stopRepoWatcherByKey(repoKey);
    closed += 1;
  }

  let opened = 0;
  for (const repoRoot of normalizedRoots) {
    if (await ensureRepoWatcherAsync(repoRoot)) opened += 1;
  }

  return {
    opened,
    closed,
    remain: repoWatchers.size,
  };
}

/**
 * 订阅 repo-level Git 元数据脏事件；测试与主进程桥接都复用这条能力。
 */
export function onRepoWatchChanged(listener: RepoWatchListener): () => void {
  repoWatchListeners.add(listener);
  return () => {
    repoWatchListeners.delete(listener);
  };
}
