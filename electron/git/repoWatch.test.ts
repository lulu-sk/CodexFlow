import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repoWatchTestState = vi.hoisted(() => ({
  watcherInstances: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    on(event: string, handler: (...args: any[]) => void): any;
    emit(event: string, ...args: any[]): void;
  }>,
  browserSendMock: vi.fn(),
  execGitAsyncMock: vi.fn(async ({ cwd, argv }: { cwd: string; argv: string[] }) => {
    if (argv[1] === "--git-dir")
      return { ok: true, stdout: `${cwd}/.git` };
    if (argv[1] === "--git-common-dir")
      return { ok: true, stdout: `${cwd}/.git` };
    return { ok: false, stderr: "unexpected git argv" };
  }),
}));

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const watcher = {
        close: vi.fn(async () => {}),
        on(event: string, handler: (...args: any[]) => void) {
          const current = handlers.get(event) || [];
          current.push(handler);
          handlers.set(event, current);
          return watcher;
        },
        emit(event: string, ...args: any[]) {
          for (const handler of handlers.get(event) || [])
            handler(...args);
        },
      };
      repoWatchTestState.watcherInstances.push(watcher);
      return watcher;
    }),
  },
}));

vi.mock("./exec", () => ({
  execGitAsync: repoWatchTestState.execGitAsyncMock,
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: repoWatchTestState.browserSendMock,
        },
      },
    ],
  },
}));

import { classifyRepoWatchPath, onRepoWatchChanged, setActiveRepoRootsAsync } from "./repoWatch";

describe("repoWatch", () => {
  beforeEach(() => {
    repoWatchTestState.watcherInstances.length = 0;
    repoWatchTestState.browserSendMock.mockReset();
    repoWatchTestState.execGitAsyncMock.mockClear();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await setActiveRepoRootsAsync([]);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    repoWatchTestState.watcherInstances.length = 0;
  });

  it("应识别需要刷新的关键 .git 元数据路径", () => {
    expect(classifyRepoWatchPath({
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      filePath: "/repo/.git/index",
    })).toBe("index");
    expect(classifyRepoWatchPath({
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      filePath: "/repo/.git/refs/heads/main",
    })).toBe("refs");
    expect(classifyRepoWatchPath({
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      filePath: "/repo/.git/rebase-merge/git-rebase-todo",
    })).toBe("rebase");
    expect(classifyRepoWatchPath({
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      filePath: "/repo/.git/MERGE_HEAD",
    })).toBe("merge");
    expect(classifyRepoWatchPath({
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      filePath: "/repo/.git/objects/ab/cdef",
    })).toBeNull();
  });

  it("Windows worktree gitdir 大小写抖动时，仍应识别 worktree 专属元数据事件", () => {
    expect(classifyRepoWatchPath({
      gitDir: "G:/Repo/.git/worktrees/wt1",
      commonDir: "G:/Repo/.git",
      filePath: "g:\\Repo\\.git\\worktrees\\wt1\\MERGE_HEAD",
    })).toBe("merge");
    expect(classifyRepoWatchPath({
      gitDir: "G:/Repo/.git/worktrees/wt1",
      commonDir: "G:/Repo/.git",
      filePath: "g:\\Repo\\.git\\worktrees\\wt1\\rebase-merge\\git-rebase-todo",
    })).toBe("rebase");
    expect(classifyRepoWatchPath({
      gitDir: "G:/Repo/.git/worktrees/wt1",
      commonDir: "G:/Repo/.git",
      filePath: "g:\\Repo\\.git\\refs\\heads\\main",
    })).toBe("refs");
  });

  it("应为活跃仓库建立 watcher，并聚合广播关键元数据变化", async () => {
    const listener = vi.fn();
    const unsubscribe = onRepoWatchChanged(listener);
    try {
      const opened = await setActiveRepoRootsAsync(["/repo-a"]);
      expect(opened).toEqual({ opened: 1, closed: 0, remain: 1 });
      expect(repoWatchTestState.watcherInstances).toHaveLength(1);

      repoWatchTestState.watcherInstances[0]!.emit("all", "change", "/repo-a/.git/index");
      await vi.advanceTimersByTimeAsync(160);

      expect(listener).toHaveBeenCalledWith({
        repoRoot: "/repo-a",
        reason: "index",
        paths: ["/repo-a/.git/index"],
      });
      expect(repoWatchTestState.browserSendMock).toHaveBeenCalledWith("gitRepoWatch:changed", {
        repoRoot: "/repo-a",
        reason: "index",
        paths: ["/repo-a/.git/index"],
      });

      repoWatchTestState.watcherInstances[0]!.emit("all", "change", "/repo-a/.git/objects/ab/cdef");
      await vi.advanceTimersByTimeAsync(160);
      expect(listener).toHaveBeenCalledTimes(1);

      const closed = await setActiveRepoRootsAsync([]);
      expect(closed).toEqual({ opened: 0, closed: 1, remain: 0 });
      expect(repoWatchTestState.watcherInstances[0]!.close).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});
