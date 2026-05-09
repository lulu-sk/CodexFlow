import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchGitPublicActionAsync, GIT_PUBLIC_ACTION_IDS } from "./action-registry";

afterEach(() => {
  delete (globalThis as any).window;
});

describe("git public action registry", () => {
  it("公共 action registry 只暴露宿主级打开动作，不包含面板内部 stage 操作", () => {
    expect(GIT_PUBLIC_ACTION_IDS).toEqual([
      "Git.Show.Stage",
      "Git.Commit.Stage",
      "Git.Commit.And.Push.Executor",
      "Git.Commit.Options",
      "Git.Update.Project",
      "Git.Update.Options",
      "Git.Pull",
      "Git.Fetch",
      "Git.Push",
      "Git.ResolveConflicts",
      "Git.Stash",
      "Git.Unstash",
    ]);
    expect(GIT_PUBLIC_ACTION_IDS).not.toContain("Git.Stage.Add.All");
  });

  it("应把 Git.Show.Stage 分发到宿主 GitWorkbench 入口", async () => {
    const show = vi.fn(async () => ({ ok: true }));
    (globalThis as any).window = {
      host: {
        gitWorkbench: { show },
      },
    };

    const result = await dispatchGitPublicActionAsync("Git.Show.Stage", {
      projectPath: "/repo",
      prefillCommitMessage: "prefill",
    });

    expect(result.ok).toBe(true);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "Git.Show.Stage",
      projectPath: "/repo",
      prefillCommitMessage: "prefill",
    }));
  });

  it("应把 Git.Commit.Stage 分发为聚焦并全选提交消息的请求", async () => {
    const show = vi.fn(async () => ({ ok: true }));
    (globalThis as any).window = {
      host: {
        gitWorkbench: { show },
      },
    };

    await dispatchGitPublicActionAsync("Git.Commit.Stage", { projectId: "project-1" });

    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "Git.Commit.Stage",
      projectId: "project-1",
      focusCommitMessage: true,
      selectCommitMessage: true,
    }));
  });

  it("提交并推送 action 应按 commit-like 语义分发到宿主入口", async () => {
    const show = vi.fn(async () => ({ ok: true }));
    (globalThis as any).window = {
      host: {
        gitWorkbench: { show },
      },
    };

    await dispatchGitPublicActionAsync("Git.Commit.And.Push.Executor", { projectPath: "/repo" });

    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "Git.Commit.And.Push.Executor",
      projectPath: "/repo",
      focusCommitMessage: true,
      selectCommitMessage: true,
    }));
  });
});
