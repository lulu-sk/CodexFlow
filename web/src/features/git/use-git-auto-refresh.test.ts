// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGitAutoRefresh } from "./use-git-auto-refresh";

type HostApis = {
  fileIndex: {
    setActiveRoots: ReturnType<typeof vi.fn>;
    onChanged: ReturnType<typeof vi.fn>;
  };
  gitRepoWatch: {
    setActiveRoots: ReturnType<typeof vi.fn>;
    onChanged: ReturnType<typeof vi.fn>;
  };
  fileIndexListeners: Set<(payload: { root?: string; reason?: string }) => void>;
  repoWatchListeners: Set<(payload: { repoRoot?: string; reason?: string; paths?: string[] }) => void>;
  emitFileIndex(payload: { root?: string; reason?: string }): void;
  emitRepoWatch(payload: { repoRoot?: string; reason?: string; paths?: string[] }): void;
};

/**
 * 构造最小 host watcher 桩，便于精确驱动 hook 的订阅、切仓与卸载行为。
 */
function createHostApis(): HostApis {
  const fileIndexListeners = new Set<(payload: { root?: string; reason?: string }) => void>();
  const repoWatchListeners = new Set<(payload: { repoRoot?: string; reason?: string; paths?: string[] }) => void>();
  const fileIndex = {
    setActiveRoots: vi.fn(async (_roots: string[]) => {}),
    onChanged: vi.fn((listener: (payload: { root?: string; reason?: string }) => void) => {
      fileIndexListeners.add(listener);
      return () => {
        fileIndexListeners.delete(listener);
      };
    }),
  };
  const gitRepoWatch = {
    setActiveRoots: vi.fn(async (_roots: string[]) => {}),
    onChanged: vi.fn((listener: (payload: { repoRoot?: string; reason?: string; paths?: string[] }) => void) => {
      repoWatchListeners.add(listener);
      return () => {
        repoWatchListeners.delete(listener);
      };
    }),
  };
  return {
    fileIndex,
    gitRepoWatch,
    fileIndexListeners,
    repoWatchListeners,
    emitFileIndex(payload) {
      for (const listener of Array.from(fileIndexListeners)) listener(payload);
    },
    emitRepoWatch(payload) {
      for (const listener of Array.from(repoWatchListeners)) listener(payload);
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
  refreshStatusAsync?: (options?: { debounceMs?: number }) => Promise<void>;
  refreshRefsAsync?: (options?: { debounceMs?: number }) => Promise<void>;
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

  it("应同时订阅 fileIndex 与 gitRepoWatch，并按来源选择轻量刷新入口", async () => {
    vi.useFakeTimers();
    const hostApis = createHostApis();
    const refreshAllAsync = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {});
    const refreshStatusAsync = vi.fn(async (_options?: { debounceMs?: number }) => {});
    const refreshRefsAsync = vi.fn(async (_options?: { debounceMs?: number }) => {});
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
        refreshStatusAsync,
        refreshRefsAsync,
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
    expect(refreshRefsAsync).toHaveBeenLastCalledWith({ debounceMs: 80 });
    expect(refreshAllAsync).not.toHaveBeenCalled();

    await act(async () => {
      hostApis.emitFileIndex({ root: "/repo-a" });
      await flushMicrotasksAsync();
    });
    expect(refreshStatusAsync).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2500);
      await flushMicrotasksAsync();
    });
    expect(refreshStatusAsync).toHaveBeenCalledTimes(1);
    expect(refreshStatusAsync).toHaveBeenLastCalledWith({ debounceMs: 180 });
    expect(refreshAllAsync).not.toHaveBeenCalled();

    await act(async () => {
      hostApis.emitRepoWatch({ repoRoot: "/repo-b" });
      await flushMicrotasksAsync();
    });
    expect(refreshAllAsync).not.toHaveBeenCalled();
    expect(refreshRefsAsync).toHaveBeenCalledTimes(1);
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

  it("状态类事件应只刷新 status", async () => {
    const hostApis = createHostApis();
    const refreshAllAsync = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {});
    const refreshStatusAsync = vi.fn(async (_options?: { debounceMs?: number }) => {});
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
        refreshStatusAsync,
      }));
      await flushMicrotasksAsync();
    });

    await act(async () => {
      hostApis.emitRepoWatch({ repoRoot: "/repo-a", reason: "index", paths: ["/repo-a/.git/index"] });
      await flushMicrotasksAsync();
    });

    expect(refreshStatusAsync).toHaveBeenCalledTimes(1);
    expect(refreshStatusAsync).toHaveBeenLastCalledWith({ debounceMs: 80 });
    expect(refreshAllAsync).not.toHaveBeenCalled();
  });

  it("引用类事件应只刷新 refs", async () => {
    const hostApis = createHostApis();
    const refreshAllAsync = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {});
    const refreshRefsAsync = vi.fn(async (_options?: { debounceMs?: number }) => {});
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
        refreshRefsAsync,
      }));
      await flushMicrotasksAsync();
    });

    await act(async () => {
      hostApis.emitRepoWatch({ repoRoot: "/repo-a", reason: "head", paths: ["/repo-a/.git/HEAD"] });
      await flushMicrotasksAsync();
    });

    expect(refreshRefsAsync).toHaveBeenCalledTimes(1);
    expect(refreshRefsAsync).toHaveBeenLastCalledWith({ debounceMs: 80 });
    expect(refreshAllAsync).not.toHaveBeenCalled();
  });

  it("切仓与卸载时应从窗口级 watcher 聚合中移除旧 roots", async () => {
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
    expect(hostApis.fileIndex.setActiveRoots).toHaveBeenNthCalledWith(2, ["/repo-b"]);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenNthCalledWith(1, ["/repo-a"]);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenNthCalledWith(2, ["/repo-b"]);

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

  it("同窗口多个 Git 工作台应聚合 watcher roots，避免互相覆盖", async () => {
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
      root!.render(React.createElement(React.Fragment, null,
        React.createElement(TestHarness, {
          active: true,
          repoRoot: "/repo-a",
          refreshAllAsync,
        }),
        React.createElement(TestHarness, {
          active: false,
          repoRoot: "/repo-b",
          refreshAllAsync,
        }),
      ));
      await flushMicrotasksAsync();
    });

    expect(hostApis.fileIndex.setActiveRoots).toHaveBeenLastCalledWith(["/repo-a", "/repo-b"]);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenLastCalledWith(["/repo-a", "/repo-b"]);
    expect(hostApis.fileIndexListeners.size).toBe(2);
    expect(hostApis.repoWatchListeners.size).toBe(2);
  });

  it("inactive 热 watcher roots 到期后应自动释放", async () => {
    vi.useFakeTimers();
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
        active: false,
        repoRoot: "/repo-a",
        refreshAllAsync,
      }));
      await flushMicrotasksAsync();
    });

    expect(hostApis.fileIndex.setActiveRoots).toHaveBeenLastCalledWith(["/repo-a"]);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenLastCalledWith(["/repo-a"]);

    await act(async () => {
      vi.advanceTimersByTime((2 * 60 + 5) * 60 * 1000 + 1);
      await flushMicrotasksAsync();
    });

    expect(hostApis.fileIndex.setActiveRoots).toHaveBeenLastCalledWith([]);
    expect(hostApis.gitRepoWatch.setActiveRoots).toHaveBeenLastCalledWith([]);
  });

  it("失活期间的 watcher 事件只记录脏类型，重新激活后再按粒度刷新", async () => {
    const hostApis = createHostApis();
    const refreshAllAsync = vi.fn(async (_options?: { keepLog?: boolean; debounceMs?: number }) => {});
    const refreshStatusAsync = vi.fn(async (_options?: { debounceMs?: number }) => {});
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
        active: false,
        repoRoot: "/repo-a",
        refreshAllAsync,
        refreshStatusAsync,
      }));
      await flushMicrotasksAsync();
    });

    await act(async () => {
      hostApis.emitFileIndex({ root: "/repo-a" });
      await flushMicrotasksAsync();
    });

    expect(refreshStatusAsync).not.toHaveBeenCalled();
    expect(refreshAllAsync).not.toHaveBeenCalled();

    await act(async () => {
      root!.render(React.createElement(TestHarness, {
        active: true,
        repoRoot: "/repo-a",
        refreshAllAsync,
        refreshStatusAsync,
      }));
      await flushMicrotasksAsync();
    });

    expect(refreshStatusAsync).toHaveBeenCalledTimes(1);
    expect(refreshStatusAsync).toHaveBeenLastCalledWith({ debounceMs: 180 });
    expect(refreshAllAsync).not.toHaveBeenCalled();
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
