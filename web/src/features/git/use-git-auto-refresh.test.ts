// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGitAutoRefresh } from "./use-git-auto-refresh";

type HostListener<TPayload> = ((payload: TPayload) => void) | null;

type HostApis = {
  fileIndex: {
    setActiveRoots: ReturnType<typeof vi.fn>;
    onChanged: ReturnType<typeof vi.fn>;
  };
  gitRepoWatch: {
    setActiveRoots: ReturnType<typeof vi.fn>;
    onChanged: ReturnType<typeof vi.fn>;
  };
  emitFileIndex(payload: { root?: string; reason?: string }): void;
  emitRepoWatch(payload: { repoRoot?: string; reason?: string; paths?: string[] }): void;
};

/**
 * 构造最小 host watcher 桩，便于精确驱动 hook 的订阅、切仓与卸载行为。
 */
function createHostApis(): HostApis {
  let fileIndexListener: HostListener<{ root?: string; reason?: string }> = null;
  let repoWatchListener: HostListener<{ repoRoot?: string; reason?: string; paths?: string[] }> = null;
  const fileIndex = {
    setActiveRoots: vi.fn(async (_roots: string[]) => {}),
    onChanged: vi.fn((listener: (payload: { root?: string; reason?: string }) => void) => {
      fileIndexListener = listener;
      return () => {
        if (fileIndexListener === listener) fileIndexListener = null;
      };
    }),
  };
  const gitRepoWatch = {
    setActiveRoots: vi.fn(async (_roots: string[]) => {}),
    onChanged: vi.fn((listener: (payload: { repoRoot?: string; reason?: string; paths?: string[] }) => void) => {
      repoWatchListener = listener;
      return () => {
        if (repoWatchListener === listener) repoWatchListener = null;
      };
    }),
  };
  return {
    fileIndex,
    gitRepoWatch,
    emitFileIndex(payload) {
      fileIndexListener?.(payload);
    },
    emitRepoWatch(payload) {
      repoWatchListener?.(payload);
    },
  };
}

/**
 * 挂载测试组件以驱动 `useGitAutoRefresh` hook。
 */
function TestHarness(props: {
  active: boolean;
  repoRoot: string;
  repoRoots?: string[];
  refreshAllAsync: (options?: { keepLog?: boolean; debounceMs?: number }) => Promise<void>;
  refreshWorktreesAsync?: (options?: { debounceMs?: number }) => Promise<void>;
}): JSX.Element | null {
  useGitAutoRefresh(props);
  return null;
}

/**
 * 等待 hook 内部异步回调完成一个事件循环，避免断言抢跑。
 */
async function flushMicrotasksAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useGitAutoRefresh", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushMicrotasksAsync();
    });
    root = null;
    container?.remove();
    container = null;
    delete (window as any).host;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("应同时订阅 fileIndex 与 gitRepoWatch，并按不同来源透传去抖参数", async () => {
    vi.useFakeTimers();
    const hostApis = createHostApis();
    const refreshAllAsync = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {});
    const refreshWorktreesAsync = vi.fn(async (_options?: { debounceMs?: number }) => {});
    Object.defineProperty(window, "host", {
      configurable: true,
      writable: true,
      value: {
        fileIndex: hostApis.fileIndex,
        gitRepoWatch: hostApis.gitRepoWatch,
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(React.createElement(TestHarness, {
        active: true,
        repoRoot: "/repo-a",
        refreshAllAsync,
        refreshWorktreesAsync,
      }));
      await flushMicrotasksAsync();
    });

    expect(hostApis.fileIndex.setActiveRoots).toHaveBeenCalledWith(["/repo-a"]);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenCalledWith(["/repo-a"]);

    await act(async () => {
      hostApis.emitRepoWatch({ repoRoot: "/repo-a", reason: "head", paths: ["/repo-a/.git/HEAD"] });
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenLastCalledWith({ keepLog: false, debounceMs: 80 });

    await act(async () => {
      hostApis.emitFileIndex({ root: "/repo-a" });
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2500);
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenCalledTimes(2);
    expect(refreshAllAsync).toHaveBeenLastCalledWith({ keepLog: false, debounceMs: 180 });

    await act(async () => {
      hostApis.emitRepoWatch({ repoRoot: "/repo-b" });
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenCalledTimes(2);
  });

  it("worktrees 元数据事件应只刷新 worktree 列表，不触发整仓刷新", async () => {
    vi.useFakeTimers();
    const hostApis = createHostApis();
    const refreshAllAsync = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {});
    const refreshWorktreesAsync = vi.fn(async (_options?: { debounceMs?: number }) => {});
    Object.defineProperty(window, "host", {
      configurable: true,
      writable: true,
      value: {
        fileIndex: hostApis.fileIndex,
        gitRepoWatch: hostApis.gitRepoWatch,
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(React.createElement(TestHarness, {
        active: true,
        repoRoot: "/repo-a",
        refreshAllAsync,
        refreshWorktreesAsync,
      }));
      await flushMicrotasksAsync();
    });

    await act(async () => {
      hostApis.emitRepoWatch({ repoRoot: "/repo-a", reason: "worktrees", paths: ["/repo-a/.git/worktrees/wt-2/HEAD"] });
      await flushMicrotasksAsync();
    });

    expect(refreshAllAsync).not.toHaveBeenCalled();
    expect(refreshWorktreesAsync).toHaveBeenCalledTimes(1);
    expect(refreshWorktreesAsync).toHaveBeenLastCalledWith({ debounceMs: 80 });
  });

  it("切仓与卸载时应清理旧订阅，并把活跃 roots 回收为空集", async () => {
    const hostApis = createHostApis();
    const refreshAllAsync = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {});
    Object.defineProperty(window, "host", {
      configurable: true,
      writable: true,
      value: {
        fileIndex: hostApis.fileIndex,
        gitRepoWatch: hostApis.gitRepoWatch,
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(React.createElement(TestHarness, {
        active: true,
        repoRoot: "/repo-a",
        refreshAllAsync,
      }));
      await flushMicrotasksAsync();
    });

    await act(async () => {
      root!.render(React.createElement(TestHarness, {
        active: true,
        repoRoot: "/repo-b",
        refreshAllAsync,
      }));
      await flushMicrotasksAsync();
    });

    expect(hostApis.fileIndex.setActiveRoots).toHaveBeenNthCalledWith(1, ["/repo-a"]);
    expect(hostApis.fileIndex.setActiveRoots).toHaveBeenNthCalledWith(2, []);
    expect(hostApis.fileIndex.setActiveRoots).toHaveBeenNthCalledWith(3, ["/repo-b"]);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenNthCalledWith(1, ["/repo-a"]);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenNthCalledWith(2, []);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenNthCalledWith(3, ["/repo-b"]);

    await act(async () => {
      hostApis.emitFileIndex({ root: "/repo-a" });
      hostApis.emitRepoWatch({ repoRoot: "/repo-a" });
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).not.toHaveBeenCalled();

    await act(async () => {
      hostApis.emitFileIndex({ root: "/repo-b" });
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenCalledTimes(1);
    expect(refreshAllAsync).toHaveBeenLastCalledWith({ keepLog: false, debounceMs: 180 });

    await act(async () => {
      root!.unmount();
      await flushMicrotasksAsync();
    });
    root = null;

    expect(hostApis.fileIndex.setActiveRoots).toHaveBeenLastCalledWith([]);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenLastCalledWith([]);
  });

  it("应把工作台级 repoRoots 一并注册给 watcher，并允许非当前 repo 的事件触发刷新", async () => {
    const hostApis = createHostApis();
    const refreshAllAsync = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {});
    Object.defineProperty(window, "host", {
      configurable: true,
      writable: true,
      value: {
        fileIndex: hostApis.fileIndex,
        gitRepoWatch: hostApis.gitRepoWatch,
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(React.createElement(TestHarness, {
        active: true,
        repoRoot: "/repo-a",
        repoRoots: ["/repo-a", "/repo-b"],
        refreshAllAsync,
      }));
      await flushMicrotasksAsync();
    });

    expect(hostApis.fileIndex.setActiveRoots).toHaveBeenCalledWith(["/repo-a", "/repo-b"]);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenCalledWith(["/repo-a", "/repo-b"]);

    await act(async () => {
      hostApis.emitRepoWatch({ repoRoot: "/repo-b", reason: "head" });
      await flushMicrotasksAsync();
    });

    expect(refreshAllAsync).toHaveBeenCalledWith({ keepLog: false, debounceMs: 80 });
  });

  it("刷新中的 index 元数据事件应视为自噪音，不能继续触发无限回刷", async () => {
    vi.useFakeTimers();
    const hostApis = createHostApis();
    let resolveRefresh: (() => void) | null = null;
    const refreshAllAsync = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {
      await new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    Object.defineProperty(window, "host", {
      configurable: true,
      writable: true,
      value: {
        fileIndex: hostApis.fileIndex,
        gitRepoWatch: hostApis.gitRepoWatch,
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(React.createElement(TestHarness, {
        active: true,
        repoRoot: "/repo-a",
        refreshAllAsync,
      }));
      await flushMicrotasksAsync();
    });

    await act(async () => {
      hostApis.emitFileIndex({ root: "/repo-a" });
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      hostApis.emitRepoWatch({ repoRoot: "/repo-a", reason: "index", paths: ["/repo-a/.git/index"] });
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh?.();
      await flushMicrotasksAsync();
    });

    await act(async () => {
      vi.advanceTimersByTime(2500);
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenCalledTimes(1);
  });

  it("刷新中的非 index 元数据事件仍应在静默窗口后补一次刷新", async () => {
    vi.useFakeTimers();
    const hostApis = createHostApis();
    const refreshResolvers: Array<() => void> = [];
    const refreshAllAsync = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {
      await new Promise<void>((resolve) => {
        refreshResolvers.push(resolve);
      });
    });
    Object.defineProperty(window, "host", {
      configurable: true,
      writable: true,
      value: {
        fileIndex: hostApis.fileIndex,
        gitRepoWatch: hostApis.gitRepoWatch,
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(React.createElement(TestHarness, {
        active: true,
        repoRoot: "/repo-a",
        refreshAllAsync,
      }));
      await flushMicrotasksAsync();
    });

    await act(async () => {
      hostApis.emitFileIndex({ root: "/repo-a" });
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      hostApis.emitRepoWatch({ repoRoot: "/repo-a", reason: "head", paths: ["/repo-a/.git/HEAD"] });
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      refreshResolvers.shift()?.();
      await flushMicrotasksAsync();
    });

    await act(async () => {
      vi.advanceTimersByTime(2500);
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).toHaveBeenCalledTimes(2);
  });
});
