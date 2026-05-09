// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useEffect, useRef } from "react";
import { useLatestAsyncRunner } from "./commit-panel/refresh-controller";

type UseGitAutoRefreshArgs = {
  active: boolean;
  repoRoot: string;
  repoRoots?: string[];
  refreshAllAsync: (options?: { keepLog?: boolean; debounceMs?: number }) => Promise<void>;
  refreshWorktreesAsync?: (options?: { debounceMs?: number }) => Promise<void>;
};

const GIT_AUTO_REFRESH_SELF_NOISE_COOLDOWN_MS = 2000;

type GitAutoRefreshKind = "full" | "worktrees";

type GitAutoRefreshState = {
  runningKind: GitAutoRefreshKind | null;
  suppressedUntil: number;
  pendingKind: GitAutoRefreshKind | null;
  pendingDebounceMs: number;
  pendingTimerId: number | null;
};

/**
 * 合并待执行刷新类型；只要任一请求需要整仓刷新，就以整仓刷新为准。
 */
function mergeRefreshKind(
  currentKind: GitAutoRefreshKind | null,
  nextKind: GitAutoRefreshKind,
): GitAutoRefreshKind {
  if (currentKind === "full" || nextKind === "full") return "full";
  return currentKind || nextKind;
}

/**
 * 在 Git 面板激活时接入工作区文件 watcher 与 `.git` 元数据 watcher，
 * 所有外部变化都统一回落到既有 `refreshAllAsync()` 串行刷新链路。
 */
export function useGitAutoRefresh(args: UseGitAutoRefreshArgs): void {
  const refreshRunner = useLatestAsyncRunner(args.refreshAllAsync);
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
  });

  useEffect(() => {
    const fileIndexApi = window.host.fileIndex;
    const repoWatchApi = window.host.gitRepoWatch;
    const roots = args.active
      ? Array.from(new Set(
          [args.repoRoot, ...(args.repoRoots || [])]
            .map((root) => String(root || "").trim())
            .filter(Boolean),
        ))
      : [];
    const activeRootSet = new Set(roots);
    const refreshState = refreshStateRef.current;

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
     * - `worktrees` 对齐 IDEA `workingTreeHolder.scheduleReload()` 语义，仅刷新 worktree 列表；
     * - 其它事件继续走整仓刷新链路。
     */
    const resolveRefreshKind = (source: "fileIndex" | "repoWatch", reason?: string): GitAutoRefreshKind => {
      if (source === "repoWatch" && String(reason || "").trim() === "worktrees" && args.refreshWorktreesAsync)
        return "worktrees";
      return "full";
    };

    /**
     * 处理单次 watcher 触发；刷新中的 `index` 元数据事件直接视为自噪音，其它事件最多排队补一次刷新。
     */
    const triggerRefresh = (payloadRoot: string | undefined, debounceMs: number, source: "fileIndex" | "repoWatch", reason?: string): void => {
      const changedRoot = String(payloadRoot || "").trim();
      if (!changedRoot || !activeRootSet.has(changedRoot)) return;
      const nextKind = resolveRefreshKind(source, reason);
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

    void fileIndexApi?.setActiveRoots?.(roots);
    void repoWatchApi?.setActiveRoots?.(roots);

    if (roots.length <= 0) {
      return () => {
        clearPendingTimer();
        refreshState.runningKind = null;
        refreshState.suppressedUntil = 0;
        refreshState.pendingKind = null;
        refreshState.pendingDebounceMs = 0;
        void fileIndexApi?.setActiveRoots?.([]);
        void repoWatchApi?.setActiveRoots?.([]);
      };
    }

    const unsubscribeFileIndex = fileIndexApi?.onChanged?.((payload) => {
      triggerRefresh(payload?.root, 180, "fileIndex", payload?.reason);
    });
    const unsubscribeRepoWatch = repoWatchApi?.onChanged?.((payload) => {
      triggerRefresh(payload?.repoRoot, 80, "repoWatch", payload?.reason);
    });

    return () => {
      try { unsubscribeFileIndex?.(); } catch {}
      try { unsubscribeRepoWatch?.(); } catch {}
      clearPendingTimer();
      refreshState.runningKind = null;
      refreshState.suppressedUntil = 0;
      refreshState.pendingKind = null;
      refreshState.pendingDebounceMs = 0;
      void fileIndexApi?.setActiveRoots?.([]);
      void repoWatchApi?.setActiveRoots?.([]);
    };
  }, [args.active, args.refreshWorktreesAsync, args.repoRoot, args.repoRoots, refreshRunner, refreshWorktreesRunner]);
}
