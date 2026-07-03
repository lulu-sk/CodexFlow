import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";

afterEach(() => {
  api.__resetGitFeatureApiForTests();
  delete (globalThis as any).window;
});

describe("git api alignment", () => {
  /**
   * 构造可手动释放的 Promise，用于模拟仍在进行中的 IPC 请求。
   */
  function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
      resolve = next;
    });
    return { promise, resolve };
  }

  it("不应再导出 update 专用 shelf API", () => {
    expect("getUpdateShelvesAsync" in api).toBe(false);
    expect("restoreUpdateShelveAsync" in api).toBe(false);
    expect("deleteUpdateShelveAsync" in api).toBe(false);
  });

  it("stageFilesAsync 应支持 intent-to-add 载荷", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    (globalThis as any).window = {
      host: {
        gitFeature: { call },
      },
    };

    await api.stageFilesAsync("/repo", ["new.txt"], { mode: "intentToAdd" });

    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      action: "changes.stage",
      payload: expect.objectContaining({
        repoPath: "/repo",
        files: ["new.txt"],
        mode: "intentToAdd",
      }),
    }));
  });

  it("应通过宿主 GitWorkbench 入口发出 Git.Show.Stage 请求", async () => {
    const show = vi.fn(async () => ({ ok: true }));
    (globalThis as any).window = {
      host: {
        gitWorkbench: { show },
      },
    };

    const result = await api.showGitWorkbenchAsync({
      projectPath: "/repo",
      prefillCommitMessage: "prefill",
      focusCommitMessage: true,
    });

    expect(result.ok).toBe(true);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "Git.Show.Stage",
      projectPath: "/repo",
      prefillCommitMessage: "prefill",
      focusCommitMessage: true,
      selectCommitMessage: false,
    }));
  });

  it("应通过宿主 GitWorkbench 入口发出 Git.Commit.Stage 请求", async () => {
    const show = vi.fn(async () => ({ ok: true }));
    (globalThis as any).window = {
      host: {
        gitWorkbench: { show },
      },
    };

    const result = await api.showGitCommitWorkbenchAsync({
      projectId: "project-1",
      prefillCommitMessage: "feat: message",
    });

    expect(result.ok).toBe(true);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "Git.Commit.Stage",
      projectId: "project-1",
      prefillCommitMessage: "feat: message",
      focusCommitMessage: true,
      selectCommitMessage: true,
    }));
  });

  it("showGitWorkbenchActionAsync 应支持新增公共 action，并对 commit-like 动作自动补齐焦点语义", async () => {
    const show = vi.fn(async () => ({ ok: true }));
    (globalThis as any).window = {
      host: {
        gitWorkbench: { show },
      },
    };

    const result = await api.showGitWorkbenchActionAsync("Git.Commit.And.Push.Executor", {
      projectPath: "/repo",
    });

    expect(result.ok).toBe(true);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "Git.Commit.And.Push.Executor",
      focusCommitMessage: true,
      selectCommitMessage: true,
    }));
  });

  it("应通过 git feature bridge 读写 commit panel 偏好", async () => {
    const call = vi.fn(async () => ({ ok: true, data: { commitAndPush: { previewOnCommitAndPush: true, previewProtectedOnly: false, protectedBranchPatterns: ["main"] }, commitHooks: { available: true, availableRepoRoots: ["/repo"], disabledByPolicy: false, runByDefault: true } } }));
    (globalThis as any).window = {
      host: {
        gitFeature: { call },
      },
    };

    await api.getCommitPanelPreferencesAsync("/repo");
    await api.saveCommitPanelPreferencesAsync("/repo", {
      commitAndPush: { previewProtectedOnly: true },
    });

    expect(call).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "commit.preferences.get",
      payload: expect.objectContaining({ repoPath: "/repo" }),
    }));
    expect(call).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "commit.preferences.set",
      payload: expect.objectContaining({
        repoPath: "/repo",
        commitAndPush: { previewProtectedOnly: true },
      }),
    }));
  });

  it("连续可取消 Git 读请求应取消同键旧请求，避免后台读取堆积", async () => {
    const firstDiff = createDeferred<{ ok: boolean }>();
    let firstDiffRequestId = 0;
    const call = vi.fn(async (args: any) => {
      if (args?.action === "diff.get" && !firstDiffRequestId) {
        firstDiffRequestId = Number(args.requestId || 0);
        return await firstDiff.promise;
      }
      return { ok: true };
    });
    (globalThis as any).window = {
      host: {
        gitFeature: { call },
      },
    };

    const first = api.getDiffAsync("/repo", { path: "src/a.ts", mode: "working" });
    await Promise.resolve();
    const second = api.getDiffAsync("/repo", { path: "src/a.ts", mode: "working" });
    await Promise.resolve();

    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      action: "request.cancel",
      payload: expect.objectContaining({
        targetRequestId: firstDiffRequestId,
      }),
      requestId: 0,
    }));
    firstDiff.resolve({ ok: true });
    await Promise.all([first, second]);
  });

  it("连续状态刷新不应取消旧 status.get 请求", async () => {
    const firstStatus = createDeferred<{ ok: boolean }>();
    const call = vi.fn(async (args: any) => {
      if (args?.action === "status.get")
        return await firstStatus.promise;
      return { ok: true };
    });
    (globalThis as any).window = {
      host: {
        gitFeature: { call },
      },
    };

    const first = api.getStatusAsync("/repo");
    await Promise.resolve();
    const second = api.getStatusAsync("/repo");
    await Promise.resolve();

    expect(call).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "request.cancel",
    }));
    firstStatus.resolve({ ok: true });
    await Promise.all([first, second]);
  });

  it("Git 写请求不应触发旧请求取消，避免误伤提交/暂存等真实操作", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    (globalThis as any).window = {
      host: {
        gitFeature: { call },
      },
    };

    await api.stageFilesAsync("/repo", ["a.txt"]);
    await api.stageFilesAsync("/repo", ["b.txt"]);

    expect(call).toHaveBeenCalledTimes(2);
    expect(call).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "request.cancel",
    }));
  });

  it("日志分页读取应按 cursor 区分取消键，避免加载更多时取消首屏或相邻页", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const filters = {
      text: "",
      caseSensitive: false,
      matchMode: "fuzzy" as const,
      branch: "",
      author: "",
      dateFrom: "",
      dateTo: "",
      path: "",
      revision: "",
      followRenames: false,
    };
    (globalThis as any).window = {
      host: {
        gitFeature: { call },
      },
    };

    await api.getLogAsync("/repo", 0, 200, filters);
    await api.getLogAsync("/repo", 200, 200, filters);

    expect(call).toHaveBeenCalledTimes(2);
    expect(call).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "request.cancel",
    }));
  });
});
