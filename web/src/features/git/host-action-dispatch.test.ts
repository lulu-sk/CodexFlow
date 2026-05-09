import { describe, expect, it, vi } from "vitest";
import { dispatchGitWorkbenchHostActionAsync } from "./host-action-dispatch";

function createHandlers() {
  return {
    openCommitStage: vi.fn(),
    openPushDialogAsync: vi.fn(async () => {}),
    openPullDialogAsync: vi.fn(async () => {}),
    openFetchDialogAsync: vi.fn(async () => {}),
    runUpdateProjectAsync: vi.fn(async () => {}),
    openUpdateOptionsDialogAsync: vi.fn(async () => {}),
    openConflictResolver: vi.fn(),
    openCreateStashDialogAsync: vi.fn(async () => {}),
    openSavedChangesView: vi.fn(),
  };
}

describe("host action dispatch", () => {
  it("应把 commit-like action 映射到统一的提交工作流入口", async () => {
    const handlers = createHandlers();

    await dispatchGitWorkbenchHostActionAsync("Git.Commit.And.Push.Executor", handlers);
    await dispatchGitWorkbenchHostActionAsync("Git.Commit.Options", handlers);

    expect(handlers.openCommitStage).toHaveBeenNthCalledWith(1, { preferPushAfter: true });
    expect(handlers.openCommitStage).toHaveBeenNthCalledWith(2, { openOptions: true });
  });

  it("应把 fetch/pull/push/update/conflict/stash/unstash 分发到既有 handler", async () => {
    const handlers = createHandlers();

    await dispatchGitWorkbenchHostActionAsync("Git.Update.Project", handlers);
    await dispatchGitWorkbenchHostActionAsync("Git.Update.Options", handlers);
    await dispatchGitWorkbenchHostActionAsync("Git.Pull", handlers);
    await dispatchGitWorkbenchHostActionAsync("Git.Fetch", handlers);
    await dispatchGitWorkbenchHostActionAsync("Git.Push", handlers);
    await dispatchGitWorkbenchHostActionAsync("Git.ResolveConflicts", handlers);
    await dispatchGitWorkbenchHostActionAsync("Git.Stash", handlers);
    await dispatchGitWorkbenchHostActionAsync("Git.Unstash", handlers);

    expect(handlers.runUpdateProjectAsync).toHaveBeenCalledTimes(1);
    expect(handlers.openUpdateOptionsDialogAsync).toHaveBeenCalledTimes(1);
    expect(handlers.openPullDialogAsync).toHaveBeenCalledTimes(1);
    expect(handlers.openFetchDialogAsync).toHaveBeenCalledTimes(1);
    expect(handlers.openPushDialogAsync).toHaveBeenCalledTimes(1);
    expect(handlers.openConflictResolver).toHaveBeenCalledTimes(1);
    expect(handlers.openCreateStashDialogAsync).toHaveBeenCalledTimes(1);
    expect(handlers.openSavedChangesView).toHaveBeenCalledTimes(1);
  });
});
