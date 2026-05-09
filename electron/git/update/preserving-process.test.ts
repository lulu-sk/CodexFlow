import { afterEach, describe, expect, it, vi } from "vitest";
import { GitChangesSaver } from "./changeSaver";
import { GitPreservingProcess } from "./preservingProcess";
import type { GitUpdateUnfinishedState } from "./types";

type RuntimeOverrides = {
  detectIncompleteUpdateStateAsync?: (saved: any) => Promise<GitUpdateUnfinishedState | null>;
};

/**
 * 创建最小 preserving runtime，用于验证 `GitPreservingProcess` 的保存/恢复分支语义。
 */
function createRuntime(overrides?: RuntimeOverrides) {
  const calls: string[] = [];
  const saved = {
    ref: "stash@{0}",
    message: "demo",
    saveChangesPolicy: "stash" as const,
    displayName: "stash@{0}",
  };
  const runtime = {
    ctx: {
      action: "update.run",
      requestId: 1,
      gitPath: "git",
      userDataPath: "/tmp/codexflow-tests",
    },
    repoRoot: "/repo",
    emitProgress() {},
    async runGitExecAsync() {
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
    async runGitSpawnAsync() {
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
    toGitErrorMessage() {
      return "error";
    },
    notifyLocalChangesAreNotRestored(currentSaved: typeof saved, reason: "unfinished-state" | "restore-failed" | "manual-decision") {
      return {
        saveChangesPolicy: currentSaved.saveChangesPolicy,
        status: "kept-saved" as const,
        localChangesRestorePolicy: "keep-saved" as const,
        savedLocalChangesRef: currentSaved.ref,
        savedLocalChangesDisplayName: currentSaved.displayName,
        message: reason,
        notRestoredReason: reason,
      };
    },
    async detectIncompleteUpdateStateAsync(savedRecord: any) {
      if (overrides?.detectIncompleteUpdateStateAsync) {
        return await overrides.detectIncompleteUpdateStateAsync(savedRecord);
      }
      return null;
    },
  };
  const saver = {
    async trySaveLocalChanges() {
      calls.push("save");
      return {
        ok: true as const,
      };
    },
    getSavedLocalChanges() {
      return saved;
    },
    notifyLocalChangesAreNotRestored() {
      return runtime.notifyLocalChangesAreNotRestored(saved, "manual-decision");
    },
    showSavedChanges() {
      return {
        kind: "open-saved-changes" as const,
        label: "查看暂存列表",
        repoRoot: runtime.repoRoot,
        payload: {
          repoRoot: runtime.repoRoot,
          ref: saved.ref,
          saveChangesPolicy: "stash" as const,
          viewKind: "stash",
        },
      };
    },
    async load() {
      calls.push("restore");
      return {
        ok: true as const,
      };
    },
  };
  vi.spyOn(GitChangesSaver, "getSaver").mockReturnValue(saver as any);
  return { runtime, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("git preserving process", () => {
  it("多仓 preserving 应只调用一次全局 saver，并一次性覆盖全部 rootsToSave", async () => {
    const runtime = {
      repoRoot: "/workspace",
      userDataPath: "/tmp/codexflow-tests",
      emitProgress() {},
    };
    const saveCalls: string[][] = [];
    const loadCalls: string[] = [];
    const saver = {
      async trySaveLocalChanges(rootsToSave: string[]) {
        saveCalls.push([...rootsToSave]);
        return { ok: true as const };
      },
      getSavedLocalChangesList() {
        return [
          {
            repoRoot: "/repo/a",
            ref: "stash@{0}",
            message: "save a",
            saveChangesPolicy: "stash" as const,
            displayName: "stash@{0}",
          },
          {
            repoRoot: "/repo/b",
            ref: "stash@{1}",
            message: "save b",
            saveChangesPolicy: "stash" as const,
            displayName: "stash@{1}",
          },
        ];
      },
      async load() {
        loadCalls.push("load");
        return {
          ok: true as const,
          restoredRoots: ["/repo/a", "/repo/b"],
        };
      },
      getSavedChangesAction(saved: { repoRoot?: string; ref: string }) {
        return {
          kind: "open-saved-changes" as const,
          label: "查看暂存列表",
          repoRoot: saved.repoRoot,
          payload: {
            repoRoot: saved.repoRoot,
            ref: saved.ref,
            saveChangesPolicy: "stash" as const,
            viewKind: "stash",
          },
        };
      },
    };

    const process = new GitPreservingProcess(
      runtime as any,
      ["/repo/a", "/repo/b"],
      "update project",
      "remote",
      "stash",
      saver as any,
    );

    const result = await process.execute(async () => ({
      ok: true,
      data: {
        resultCode: "SUCCESS",
        roots: [
          { repoRoot: "/repo/a", ok: true, resultCode: "SUCCESS" },
          { repoRoot: "/repo/b", ok: true, resultCode: "SUCCESS" },
        ],
      },
    }), async () => true);

    expect(result.ok).toBe(true);
    expect(saveCalls).toEqual([["/repo/a", "/repo/b"]]);
    expect(loadCalls).toEqual(["load"]);
    expect(result.data?.savedLocalChangesEntries).toHaveLength(2);
    expect(result.data?.roots?.[0]?.preservingState?.status).toBe("restored");
    expect(result.data?.roots?.[1]?.preservingState?.status).toBe("restored");
  });

  it("更新成功后应自动恢复之前保存的本地改动", async () => {
    const { runtime, calls } = createRuntime();
    const process = new GitPreservingProcess(runtime as any, [runtime.repoRoot], "update rebase", "origin/main", "stash");

    const result = await process.execute(async () => ({
      ok: true,
      data: {
        method: "rebase",
      },
    }), async (operationResult) => operationResult.ok);

    expect(result.ok).toBe(true);
    expect(result.data?.savedLocalChanges).toBe(true);
    expect(result.data?.restoredLocalChanges).toBe(true);
    expect(calls).toEqual(["save", "restore"]);
  });

  it("更新失败且仓库未进入 unfinished state 时，不应自动恢复本地改动", async () => {
    const { runtime, calls } = createRuntime();
    const process = new GitPreservingProcess(runtime as any, [runtime.repoRoot], "update merge", "origin/main", "stash");

    const result = await process.execute(async () => ({
      ok: false,
      error: "merge failed",
      data: {
        resultCode: "ERROR",
      },
    }), async (operationResult) => operationResult.ok);

    expect(result.ok).toBe(false);
    expect(result.data?.preservingState?.status).toBe("kept-saved");
    expect(result.data?.preservingState?.notRestoredReason).toBe("manual-decision");
    expect(result.data?.preservingState?.savedChangesAction).toEqual(expect.objectContaining({
      kind: "open-saved-changes",
      label: "查看暂存列表",
      repoRoot: "/repo",
    }));
    expect(calls).toEqual(["save"]);
  });

  it("更新被取消时应显式保留已保存改动，并返回统一查看入口", async () => {
    const { runtime, calls } = createRuntime();
    const process = new GitPreservingProcess(runtime as any, [runtime.repoRoot], "update merge", "origin/main", "stash");

    const result = await process.execute(async () => ({
      ok: false,
      error: "用户取消了更新",
      data: {
        resultCode: "CANCEL",
      },
    }), async (operationResult) => operationResult.ok);

    expect(result.ok).toBe(false);
    expect(result.data?.resultCode).toBe("CANCEL");
    expect(result.data?.preservingState?.status).toBe("kept-saved");
    expect(result.data?.preservingState?.notRestoredReason).toBe("manual-decision");
    expect(result.data?.preservingState?.savedChangesAction).toEqual(expect.objectContaining({
      kind: "open-saved-changes",
      label: "查看暂存列表",
      repoRoot: "/repo",
    }));
    expect(calls).toEqual(["save"]);
  });

  it("进入 unfinished state 时应保留已保存改动，并标记 unfinished-state", async () => {
    const { runtime, calls } = createRuntime({
      async detectIncompleteUpdateStateAsync(saved) {
        return {
          code: "merge-in-progress",
          stage: "update",
          localChangesRestorePolicy: "keep-saved",
          savedLocalChangesRef: saved?.ref,
          message: "Merge 仍在进行中",
        };
      },
    });
    const process = new GitPreservingProcess(runtime as any, [runtime.repoRoot], "update merge", "origin/main", "stash");

    const result = await process.execute(async () => ({
      ok: false,
      error: "merge conflict",
      data: {
        resultCode: "ERROR",
      },
    }), async (operationResult) => operationResult.ok);

    expect(result.ok).toBe(false);
    expect(result.data?.resultCode).toBe("INCOMPLETE");
    expect(result.data?.preservingState?.status).toBe("kept-saved");
    expect(result.data?.preservingState?.notRestoredReason).toBe("unfinished-state");
    expect(result.data?.preservingState?.savedChangesAction?.kind).toBe("open-saved-changes");
    expect(calls).toEqual(["save"]);
  });

  it("恢复已保存改动发生冲突时应返回查看保存记录与处理冲突动作", async () => {
    const runtime = {
      repoRoot: "/repo",
      userDataPath: "/tmp/codexflow-tests",
      emitProgress() {},
    };
    const saver = {
      async trySaveLocalChanges() {
        return { ok: true as const };
      },
      getSavedLocalChangesList() {
        return [{
          repoRoot: "/repo",
          ref: "shelf@{demo}",
          message: "demo",
          saveChangesPolicy: "shelve" as const,
          displayName: "搁置记录 demo",
        }];
      },
      showSavedChanges() {
        return {
          kind: "open-saved-changes" as const,
          label: "查看搁置记录",
          repoRoot: "/repo",
          payload: {
            repoRoot: "/repo",
            ref: "shelf@{demo}",
            saveChangesPolicy: "shelve" as const,
            viewKind: "shelf",
            source: "system",
          },
        };
      },
      async load() {
        return {
          ok: false as const,
          error: "恢复已保存改动失败",
          failedRoots: ["/repo"],
          restoredRoots: [],
          conflictRoots: ["/repo"],
        };
      },
    };

    const process = new GitPreservingProcess(
      runtime as any,
      [runtime.repoRoot],
      "update merge",
      "origin/main",
      "shelve",
      saver as any,
    );

    const result = await process.execute(async () => ({
      ok: true,
      data: {
        roots: [{ repoRoot: "/repo", ok: true, resultCode: "SUCCESS" }],
      },
    }), async () => true);

    expect(result.ok).toBe(true);
    expect(result.data?.preservingState?.status).toBe("restore-failed");
    expect(result.data?.preservingState?.savedChangesAction).toEqual(expect.objectContaining({
      kind: "open-saved-changes",
      label: "查看搁置记录",
    }));
    expect(result.data?.preservingState?.resolveConflictsAction).toEqual(expect.objectContaining({
      kind: "resolve-conflicts",
      label: "处理冲突",
      repoRoot: "/repo",
    }));
    expect(result.data?.preservingState?.conflictResolverDialog).toEqual(expect.objectContaining({
      title: "恢复已保存改动时发现冲突",
      repoRoot: "/repo",
      reverseMerge: true,
    }));
  });
});
