// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useEffect, useRef } from "react";
import { useLatestAsyncRunner } from "./commit-panel/refresh-controller";

type UseGitAutoRefreshArgs = {
  active: boolean;
  repoRoot: string;
  repoRoots?: string[];
  refreshAllAsync: (options?: { keepLog?: boolean; debounceMs?: number }) => Promise<void>;
  refreshStatusAsync?: (options?: { debounceMs?: number }) => Promise<void>;
  refreshRefsAsync?: (options?: { debounceMs?: number }) => Promise<void>;
  refreshWorktreesAsync?: (options?: { debounceMs?: number }) => Promise<void>;
};

const GIT_AUTO_REFRESH_SELF_NOISE_COOLDOWN_MS = 2000;

type GitAutoRefreshKind = "full" | "status" | "refs" | "worktrees";

type GitAutoRefreshRootRegistration = {
  roots: string[];
  active: boolean;
  lastAccessedAt: number;
};

type GitAutoRefreshState = {
  runningKind: GitAutoRefreshKind | null;
  suppressedUntil: number;
  pendingKind: GitAutoRefreshKind | null;
  pendingDebounceMs: number;
  pendingTimerId: number | null;
  inactiveDirtyKind: GitAutoRefreshKind | null;
  inactiveDirtyDebounceMs: number;
};

const GIT_AUTO_REFRESH_HOT_ROOT_MAX_ENTRIES = 3;
const GIT_AUTO_REFRESH_HOT_ROOT_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const GIT_AUTO_REFRESH_HOT_ROOT_TRIM_INTERVAL_MS = 5 * 60 * 1000;
let gitAutoRefreshRegistrationSeq = 0;
let lastPublishedGitAutoRefreshRootsKey = "";
let gitAutoRefreshRootTrimTimerId: number | null = null;
const gitAutoRefreshRootRegistrations = new Map<number, GitAutoRefreshRootRegistration>();

/**
 * 规范化 watcher 根路径，保持同一窗口内多 Git 工作台聚合时可稳定去重。
 */
function normalizeGitAutoRefreshRoot(root: string): string {
  return String(root || "").trim();
}

/**
 * 生成 Git watcher roots 的稳定 key，避免相同集合反复下发给主进程。
 */
function buildGitAutoRefreshRootsKey(roots: string[]): string {
  return roots.join("\n");
}

/**
 * 清理超过热保活预算的 inactive Git watcher roots。
 */
function trimGitAutoRefreshRootRegistrations(now: number = Date.now()): void {
  for (const [id, registration] of Array.from(gitAutoRefreshRootRegistrations.entries())) {
    if (registration.active) continue;
    if (now - registration.lastAccessedAt > GIT_AUTO_REFRESH_HOT_ROOT_IDLE_TTL_MS)
      gitAutoRefreshRootRegistrations.delete(id);
  }
}

/**
 * 计算当前窗口应交给主进程保活的 watcher roots；active roots 不限量，inactive roots 只保留最近几个仓库。
 */
function collectGitAutoRefreshPublishedRoots(now: number = Date.now()): string[] {
  trimGitAutoRefreshRootRegistrations(now);
  const activeRoots: string[] = [];
  const activeRootSet = new Set<string>();
  for (const registration of gitAutoRefreshRootRegistrations.values()) {
    if (!registration.active) continue;
    for (const root of registration.roots) {
      if (activeRootSet.has(root)) continue;
      activeRootSet.add(root);
      activeRoots.push(root);
    }
  }

  const hotRoots: string[] = [];
  const hotRootSet = new Set<string>();
  const inactiveRegistrations = Array.from(gitAutoRefreshRootRegistrations.values())
    .filter((registration) => !registration.active)
    .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  for (const registration of inactiveRegistrations) {
    for (const root of registration.roots) {
      if (activeRootSet.has(root) || hotRootSet.has(root)) continue;
      hotRootSet.add(root);
      hotRoots.push(root);
      if (hotRoots.length >= GIT_AUTO_REFRESH_HOT_ROOT_MAX_ENTRIES) break;
    }
    if (hotRoots.length >= GIT_AUTO_REFRESH_HOT_ROOT_MAX_ENTRIES) break;
  }

  return [...activeRoots, ...hotRoots];
}

/**
 * 把窗口内所有 Git 工作台 roots 聚合后统一下发，避免多个 tab 互相覆盖主进程 watcher roots。
 */
function publishGitAutoRefreshRoots(): void {
  const roots = collectGitAutoRefreshPublishedRoots();
  const rootsKey = buildGitAutoRefreshRootsKey(roots);
  if (rootsKey === lastPublishedGitAutoRefreshRootsKey) return;
  lastPublishedGitAutoRefreshRootsKey = rootsKey;
  void window.host.fileIndex?.setActiveRoots?.(roots);
  void window.host.gitRepoWatch?.setActiveRoots?.(roots);
}

/**
 * 启动窗口级 watcher roots 定时收敛，确保 inactive 热保活到期后主动释放主进程 watcher。
 */
function ensureGitAutoRefreshRootTrimTimer(): void {
  if (gitAutoRefreshRootTrimTimerId != null) return;
  gitAutoRefreshRootTrimTimerId = window.setInterval(() => {
    publishGitAutoRefreshRoots();
    if (gitAutoRefreshRootRegistrations.size > 0) return;
    if (gitAutoRefreshRootTrimTimerId != null)
      window.clearInterval(gitAutoRefreshRootTrimTimerId);
    gitAutoRefreshRootTrimTimerId = null;
  }, GIT_AUTO_REFRESH_HOT_ROOT_TRIM_INTERVAL_MS);
}

/**
 * 更新当前工作台在窗口级 watcher registry 中的 roots 与活跃状态。
 */
function upsertGitAutoRefreshRootRegistration(id: number, roots: string[], active: boolean): void {
  const now = Date.now();
  gitAutoRefreshRootRegistrations.set(id, {
    roots,
    active,
    lastAccessedAt: now,
  });
  ensureGitAutoRefreshRootTrimTimer();
  publishGitAutoRefreshRoots();
}

/**
 * 移除当前工作台的 watcher roots，并刷新窗口级 roots 聚合。
 */
function deleteGitAutoRefreshRootRegistration(id: number): void {
  gitAutoRefreshRootRegistrations.delete(id);
  publishGitAutoRefreshRoots();
  if (gitAutoRefreshRootRegistrations.size > 0 || gitAutoRefreshRootTrimTimerId == null) return;
  window.clearInterval(gitAutoRefreshRootTrimTimerId);
  gitAutoRefreshRootTrimTimerId = null;
}

/**
 * 合并待执行刷新类型；只要任一请求需要整仓刷新，就以整仓刷新为准。
 */
function mergeRefreshKind(
  currentKind: GitAutoRefreshKind | null,
  nextKind: GitAutoRefreshKind,
): GitAutoRefreshKind {
  if (!currentKind || currentKind === nextKind) return currentKind || nextKind;
  if (currentKind === "full" || nextKind === "full") return "full";
  return "full";
}

/**
 * 在 Git 面板激活时接入工作区文件 watcher 与 `.git` 元数据 watcher，
 * 并按 watcher 脏类型分派到状态、引用、worktree 或兜底全量刷新链路。
 */
export function useGitAutoRefresh(args: UseGitAutoRefreshArgs): void {
  const registrationIdRef = useRef<number>(0);
  const rootsKeyRef = useRef<string>("");
  if (registrationIdRef.current <= 0) {
    gitAutoRefreshRegistrationSeq += 1;
    registrationIdRef.current = gitAutoRefreshRegistrationSeq;
  }
  const refreshRunner = useLatestAsyncRunner(args.refreshAllAsync);
  const refreshStatusRunner = useLatestAsyncRunner(async (options?: { debounceMs?: number }) => {
    if (args.refreshStatusAsync) {
      await args.refreshStatusAsync(options);
      return;
    }
    await args.refreshAllAsync({ keepLog: true, debounceMs: options?.debounceMs });
  });
  const refreshRefsRunner = useLatestAsyncRunner(async (options?: { debounceMs?: number }) => {
    if (args.refreshRefsAsync) {
      await args.refreshRefsAsync(options);
      return;
    }
    await args.refreshAllAsync({ keepLog: false, debounceMs: options?.debounceMs });
  });
  const refreshWorktreesRunner = useLatestAsyncRunner(async (options?: { debounceMs?: number }) => {
    if (args.refreshWorktreesAsync) {
      await args.refreshWorktreesAsync(options);
      return;
    }
    await args.refreshAllAsync({ keepLog: false, debounceMs: options?.debounceMs });
  });
  const refreshStateRef = useRef<GitAutoRefreshState>({
    runningKind: null,
    suppressedUntil: 0,
    pendingKind: null,
    pendingDebounceMs: 0,
    pendingTimerId: null,
    inactiveDirtyKind: null,
    inactiveDirtyDebounceMs: 0,
  });

  useEffect(() => {
    return () => {
      deleteGitAutoRefreshRootRegistration(registrationIdRef.current);
    };
  }, []);

  useEffect(() => {
    const roots = Array.from(new Set(
      [args.repoRoot, ...(args.repoRoots || [])]
        .map(normalizeGitAutoRefreshRoot)
        .filter(Boolean),
    ));
    const rootsKey = buildGitAutoRefreshRootsKey(roots);
    const activeRootSet = new Set(roots);
    const refreshState = refreshStateRef.current;
    if (rootsKeyRef.current !== rootsKey) {
      rootsKeyRef.current = rootsKey;
      refreshState.inactiveDirtyKind = null;
      refreshState.inactiveDirtyDebounceMs = 0;
    }

    /**
     * 清理延后自动刷新定时器，避免切仓或卸载后继续回刷旧仓库。
     */
    const clearPendingTimer = (): void => {
      if (refreshState.pendingTimerId == null) return;
      window.clearTimeout(refreshState.pendingTimerId);
      refreshState.pendingTimerId = null;
    };

    /**
     * 合并一个待执行的自动刷新请求；`worktrees` 只升级列表刷新，`full` 可覆盖所有较轻量请求。
     */
    const queuePendingRefresh = (kind: GitAutoRefreshKind, debounceMs: number): void => {
      refreshState.pendingKind = mergeRefreshKind(refreshState.pendingKind, kind);
      refreshState.pendingDebounceMs = Math.max(refreshState.pendingDebounceMs, debounceMs);
    };

    /**
     * 在安全窗口结束后补执行一次被合并的自动刷新，确保真实外部变化不会被永久吞掉。
     */
    const schedulePendingRefresh = (): void => {
      clearPendingTimer();
      const delayMs = Math.max(0, refreshState.suppressedUntil - Date.now());
      refreshState.pendingTimerId = window.setTimeout(() => {
        refreshState.pendingTimerId = null;
        if (refreshState.runningKind) {
          schedulePendingRefresh();
          return;
        }
        if (Date.now() < refreshState.suppressedUntil) {
          schedulePendingRefresh();
          return;
        }
        const refreshKind = refreshState.pendingKind;
        const debounceMs = refreshState.pendingDebounceMs;
        refreshState.pendingKind = null;
        refreshState.pendingDebounceMs = 0;
        if (!refreshKind || debounceMs <= 0) return;
        void runRefreshAsync(refreshKind, debounceMs);
      }, delayMs);
    };

    /**
     * 串行执行一次自动刷新，并在结束后进入短暂静默窗口，避免 watcher 读到自身 Git 访问带来的元数据抖动。
     */
    const runRefreshAsync = async (kind: GitAutoRefreshKind, debounceMs: number): Promise<void> => {
      if (refreshState.runningKind) {
        queuePendingRefresh(kind, debounceMs);
        schedulePendingRefresh();
        return;
      }
      refreshState.runningKind = kind;
      clearPendingTimer();
      try {
        if (kind === "worktrees")
          await refreshWorktreesRunner({ debounceMs });
        else if (kind === "status")
          await refreshStatusRunner({ debounceMs });
        else if (kind === "refs")
          await refreshRefsRunner({ debounceMs });
        else
          await refreshRunner({ keepLog: false, debounceMs });
      } finally {
        refreshState.runningKind = null;
        refreshState.suppressedUntil = Date.now() + GIT_AUTO_REFRESH_SELF_NOISE_COOLDOWN_MS;
        if (refreshState.pendingKind && refreshState.pendingDebounceMs > 0)
          schedulePendingRefresh();
      }
    };

    /**
     * 根据 watcher 来源与原因决定刷新粒度。
     * - `worktrees` 保持与参考实现一致的 `workingTreeHolder.scheduleReload()` 语义，仅刷新 worktree 列表；
     * - `index`/工作区文件变化只刷新本地状态；
     * - `HEAD`/refs/操作状态变化刷新分支与日志；
     * - 未知事件继续走整仓刷新链路。
     */
    const resolveRefreshKind = (source: "fileIndex" | "repoWatch", reason?: string): GitAutoRefreshKind => {
      if (source === "fileIndex")
        return args.refreshStatusAsync ? "status" : "full";
      const normalizedReason = String(reason || "").trim();
      if (source === "repoWatch" && String(reason || "").trim() === "worktrees" && args.refreshWorktreesAsync)
        return "worktrees";
      if ((normalizedReason === "index" || normalizedReason === "exclude") && args.refreshStatusAsync)
        return "status";
      if (
        (normalizedReason === "head"
          || normalizedReason === "refs"
          || normalizedReason === "rebase"
          || normalizedReason === "merge"
          || normalizedReason === "cherry-pick"
          || normalizedReason === "revert")
        && args.refreshRefsAsync
      )
        return "refs";
      return "full";
    };

    /**
     * 处理单次 watcher 触发；刷新中的 `index` 元数据事件直接视为自噪音，其它事件最多排队补一次刷新。
     */
    const triggerRefresh = (payloadRoot: string | undefined, debounceMs: number, source: "fileIndex" | "repoWatch", reason?: string): void => {
      const changedRoot = String(payloadRoot || "").trim();
      if (!changedRoot || !activeRootSet.has(changedRoot)) return;
      const nextKind = resolveRefreshKind(source, reason);
      if (!args.active) {
        refreshState.inactiveDirtyKind = mergeRefreshKind(refreshState.inactiveDirtyKind, nextKind);
        refreshState.inactiveDirtyDebounceMs = Math.max(refreshState.inactiveDirtyDebounceMs, debounceMs);
        upsertGitAutoRefreshRootRegistration(registrationIdRef.current, roots, false);
        return;
      }
      const inSuppressedWindow = !!refreshState.runningKind || Date.now() < refreshState.suppressedUntil;
      const normalizedReason = String(reason || "").trim();
      if (inSuppressedWindow && source === "repoWatch" && normalizedReason === "index")
        return;
      if (inSuppressedWindow) {
        queuePendingRefresh(nextKind, debounceMs);
        schedulePendingRefresh();
        return;
      }
      void runRefreshAsync(nextKind, debounceMs);
    };

    if (roots.length <= 0) {
      deleteGitAutoRefreshRootRegistration(registrationIdRef.current);
      return () => {
        clearPendingTimer();
        refreshState.runningKind = null;
        refreshState.suppressedUntil = 0;
        refreshState.pendingKind = null;
        refreshState.pendingDebounceMs = 0;
        refreshState.inactiveDirtyKind = null;
        refreshState.inactiveDirtyDebounceMs = 0;
      };
    }

    upsertGitAutoRefreshRootRegistration(registrationIdRef.current, roots, args.active);

    const unsubscribeFileIndex = window.host.fileIndex?.onChanged?.((payload) => {
      triggerRefresh(payload?.root, 180, "fileIndex", payload?.reason);
    });
    const unsubscribeRepoWatch = window.host.gitRepoWatch?.onChanged?.((payload) => {
      triggerRefresh(payload?.repoRoot, 80, "repoWatch", payload?.reason);
    });
    if (args.active && refreshState.inactiveDirtyKind) {
      const dirtyKind = refreshState.inactiveDirtyKind;
      const debounceMs = refreshState.inactiveDirtyDebounceMs || 80;
      refreshState.inactiveDirtyKind = null;
      refreshState.inactiveDirtyDebounceMs = 0;
      void runRefreshAsync(dirtyKind, debounceMs);
    }

    return () => {
      try { unsubscribeFileIndex?.(); } catch {}
      try { unsubscribeRepoWatch?.(); } catch {}
      clearPendingTimer();
      refreshState.runningKind = null;
      refreshState.suppressedUntil = 0;
      refreshState.pendingKind = null;
      refreshState.pendingDebounceMs = 0;
    };
  }, [
    args.active,
    args.refreshRefsAsync,
    args.refreshStatusAsync,
    args.refreshWorktreesAsync,
    args.repoRoot,
    args.repoRoots,
    refreshRefsRunner,
    refreshRunner,
    refreshStatusRunner,
    refreshWorktreesRunner,
  ]);
}
