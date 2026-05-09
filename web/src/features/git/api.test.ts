import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";

afterEach(() => {
  delete (globalThis as any).window;
});

describe("git api alignment", () => {
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
});
