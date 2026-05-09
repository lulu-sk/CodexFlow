import { describe, expect, it } from "vitest";
import { buildCommitWorkflowPayload, buildCommitWorkflowPayloadFromEntries } from "./commit-workflow";
import { patchCommitAdvancedOptionsState, createCommitAdvancedOptionsState } from "./commit-options-model";
import { createCommitInclusionState, syncCommitInclusionState, buildCommitInclusionItems } from "./inclusion-model";
import { buildPartialCommitStateKey, createPartialCommitSelectionState, setPartialCommitHunkSelected, setPartialCommitLineKeysSelected, syncPartialCommitSelectionWithSnapshot } from "./partial-commit-model";

describe("commit workflow payload", () => {
  it("应从 inclusion model 生成结构化提交请求，而非仅传 checked path", () => {
    const items = buildCommitInclusionItems([
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    let state = syncCommitInclusionState(createCommitInclusionState(), items, "default");
    state = {
      ...state,
      includedIds: [items[0]!.id],
      userTouched: true,
    };
    const payload = buildCommitWorkflowPayload(state, createPartialCommitSelectionState(), "/repo", "message", "commitAndPush");
    expect(payload).toEqual({
      message: "message",
      intent: "commitAndPush",
      pushAfter: true,
      selections: [{
        repoRoot: "/repo",
        changeListId: "default",
        path: "a.txt",
        kind: "change",
        selectionMode: "full-file",
      }],
      includedItems: [{ repoRoot: "/repo", path: "a.txt", kind: "change" }],
      files: ["a.txt"],
    });
  });

  it("右键提交文件应按结构化 workflow items 提交，不再回退到裸 path 数组", () => {
    const payload = buildCommitWorkflowPayloadFromEntries([
      { path: "tracked.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "new.txt", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default" },
      { path: "dist/cache.txt", x: "!", y: "!", staged: false, unstaged: false, untracked: false, ignored: true, renamed: false, deleted: false, statusText: "已忽略", changeListId: "" },
    ], createPartialCommitSelectionState(), "/repo", "message", "commit");
    expect(payload).toEqual({
      message: "message",
      intent: "commit",
      pushAfter: false,
      selections: [
        {
          repoRoot: "/repo",
          changeListId: "default",
          path: "tracked.txt",
          kind: "change",
          selectionMode: "full-file",
        },
        {
          repoRoot: "/repo",
          changeListId: "default",
          path: "new.txt",
          kind: "unversioned",
          selectionMode: "full-file",
        },
      ],
      includedItems: [
        { repoRoot: "/repo", path: "tracked.txt", kind: "change" },
        { repoRoot: "/repo", path: "new.txt", kind: "unversioned" },
      ],
      files: ["tracked.txt", "new.txt"],
    });
  });

  it("提交 payload builder 应携带高级选项，并忽略空白或无效字段", () => {
    const items = buildCommitInclusionItems([
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    const inclusionState = {
      ...syncCommitInclusionState(createCommitInclusionState(), items, "default"),
      includedIds: [items[0]!.id],
      userTouched: true,
    };
    const options = patchCommitAdvancedOptionsState(createCommitAdvancedOptionsState(), {
      signOff: true,
      runHooks: false,
      author: "  Alice <alice@example.com>  ",
      authorDate: "2026-03-12 10:11:12",
      cleanupMessage: true,
      commitRenamesSeparately: true,
    });

    expect(buildCommitWorkflowPayload(
      inclusionState,
      createPartialCommitSelectionState(),
      "/repo",
      "message",
      "commit",
      options,
      { available: true, disabledByPolicy: false },
    )).toEqual({
      message: "message",
      intent: "commit",
      pushAfter: false,
      selections: [{
        repoRoot: "/repo",
        changeListId: "default",
        path: "a.txt",
        kind: "change",
        selectionMode: "full-file",
      }],
      includedItems: [{ repoRoot: "/repo", path: "a.txt", kind: "change" }],
      files: ["a.txt"],
      signOff: true,
      skipHooks: true,
      author: "Alice <alice@example.com>",
      authorDate: "2026-03-12T10:11:12",
      cleanupMessage: true,
      commitRenamesSeparately: true,
    });

    expect(buildCommitWorkflowPayloadFromEntries([
      { path: "tracked.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ], createPartialCommitSelectionState(), "/repo", "message", "commit", {
      author: "   ",
      authorDate: "invalid-date",
      signOff: false,
      runHooks: true,
      cleanupMessage: false,
      commitRenamesSeparately: false,
    })).toEqual({
      message: "message",
      intent: "commit",
      pushAfter: false,
      selections: [{
        repoRoot: "/repo",
        changeListId: "default",
        path: "tracked.txt",
        kind: "change",
        selectionMode: "full-file",
      }],
      includedItems: [{ repoRoot: "/repo", path: "tracked.txt", kind: "change" }],
      files: ["tracked.txt"],
    });
  });

  it("rename 条目应把 oldPath 透传到 workflow selection 与兼容 includedItems", () => {
    const payload = buildCommitWorkflowPayloadFromEntries([
      {
        path: "new-name.txt",
        oldPath: "old-name.txt",
        x: "R",
        y: ".",
        staged: true,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: true,
        deleted: false,
        statusText: "已重命名",
        changeListId: "default",
      },
    ], createPartialCommitSelectionState(), "/repo", "rename", "commit");

    expect(payload).toEqual({
      message: "rename",
      intent: "commit",
      pushAfter: false,
      selections: [{
        repoRoot: "/repo",
        changeListId: "default",
        path: "new-name.txt",
        oldPath: "old-name.txt",
        kind: "change",
        selectionMode: "full-file",
      }],
      includedItems: [{ repoRoot: "/repo", path: "new-name.txt", oldPath: "old-name.txt", kind: "change" }],
      files: ["new-name.txt"],
    });
  });

  it("存在 hunk 级 partial selection 时，请求体应输出 partial selection 而不是整文件 paths", () => {
    const items = buildCommitInclusionItems([
      { path: "src/app.ts", x: "M", y: ".", staged: true, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default" },
    ]);
    let inclusionState = syncCommitInclusionState(createCommitInclusionState(), items, "default");
    inclusionState = {
      ...inclusionState,
      includedIds: [items[0]!.id],
      userTouched: true,
    };

    const synced = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: {
        path: "src/app.ts",
        mode: "working",
        isBinary: false,
        leftText: "before",
        rightText: "after",
        leftTitle: "HEAD",
        rightTitle: "Working Tree",
        patchHeader: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n",
        fingerprint: "fp-1",
        hunks: [
          {
            id: "hunk-1",
            header: "@@ -1,1 +1,1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            preview: "const a = 2;",
            patch: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;\n",
            lines: [
              { kind: "del", content: "const a = 1;", oldLineNumber: 1 },
              { kind: "add", content: "const a = 2;", newLineNumber: 1 },
            ],
          },
          {
            id: "hunk-2",
            header: "@@ -10,1 +10,1 @@",
            oldStart: 10,
            oldLines: 1,
            newStart: 10,
            newLines: 1,
            preview: "const z = 2;",
            patch: "@@ -10,1 +10,1 @@\n-const z = 1;\n+const z = 2;\n",
            lines: [
              { kind: "del", content: "const z = 1;", oldLineNumber: 10 },
              { kind: "add", content: "const z = 2;", newLineNumber: 10 },
            ],
          },
        ],
      },
    }).state;
    const partialState = setPartialCommitHunkSelected(synced, "src/app.ts", "hunk-2", false);

    const payload = buildCommitWorkflowPayload(inclusionState, partialState, "/repo", "partial", "commit");

    expect(payload.selections).toEqual([
      {
        repoRoot: "/repo",
        changeListId: "default",
        path: "src/app.ts",
        kind: "change",
        selectionMode: "partial",
        snapshotFingerprint: "fp-1",
        patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;\n",
        selectedHunkIds: ["hunk-1"],
      },
    ]);
    expect(payload.files).toEqual(["src/app.ts"]);
  });

  it("commit-all 开启时应按 rootsToCommit 收敛 tracked changes，关闭时仍只提交显式 inclusion 项", () => {
    const items = buildCommitInclusionItems([
      { path: "packages/app/index.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo-a" },
      { path: "packages/lib/index.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo-b" },
      { path: "packages/lib/new.ts", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default", repositoryRoot: "/repo-b" },
    ]);
    const allEntries = [
      { path: "packages/app/index.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo-a" },
      { path: "packages/lib/index.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo-b" },
      { path: "packages/lib/new.ts", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default", repositoryRoot: "/repo-b" },
    ];

    const commitAllState = syncCommitInclusionState(createCommitInclusionState(true), items, "default");
    expect(commitAllState.isCommitAll).toBe(true);
    const commitAllPayload = buildCommitWorkflowPayload(
      commitAllState,
      createPartialCommitSelectionState(),
      "/repo-a",
      "commit all",
      "commit",
      undefined,
      undefined,
      allEntries,
    );
    expect(commitAllPayload.selections).toEqual([
      {
        repoRoot: "/repo-a",
        changeListId: "default",
        path: "packages/app/index.ts",
        kind: "change",
        selectionMode: "full-file",
      },
      {
        repoRoot: "/repo-b",
        changeListId: "default",
        path: "packages/lib/index.ts",
        kind: "change",
        selectionMode: "full-file",
      },
    ]);
    expect(commitAllPayload.files).toEqual(["packages/app/index.ts", "packages/lib/index.ts"]);

    const commitSelectedOnlyState = {
      ...syncCommitInclusionState(createCommitInclusionState(false), items, "default"),
      includedIds: [items[0]!.id],
      userTouched: true,
    };
    expect(commitSelectedOnlyState.isCommitAll).toBe(false);
    const selectedOnlyPayload = buildCommitWorkflowPayload(
      commitSelectedOnlyState,
      createPartialCommitSelectionState(),
      "/repo-a",
      "selected only",
      "commit",
      undefined,
      undefined,
      allEntries,
    );
    expect(selectedOnlyPayload.selections).toEqual([
      {
        repoRoot: "/repo-a",
        changeListId: "default",
        path: "packages/app/index.ts",
        kind: "change",
        selectionMode: "full-file",
      },
    ]);
    expect(selectedOnlyPayload.files).toEqual(["packages/app/index.ts"]);
  });

  it("存在 line 级 partial selection 时，请求体应输出按 changed line 重建后的 patch", () => {
    const items = buildCommitInclusionItems([
      { path: "src/app.ts", x: "M", y: ".", staged: true, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default" },
    ]);
    let inclusionState = syncCommitInclusionState(createCommitInclusionState(), items, "default");
    inclusionState = {
      ...inclusionState,
      includedIds: [items[0]!.id],
      userTouched: true,
    };

    const synced = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: {
        path: "src/app.ts",
        mode: "working",
        isBinary: false,
        leftText: "line-01\nline-02\nline-03\nline-04\n",
        rightText: "line-01 changed\nline-02\nline-03 changed\nline-04\n",
        leftTitle: "HEAD",
        rightTitle: "Working Tree",
        patchHeader: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n",
        fingerprint: "fp-line-1",
        hunks: [
          {
            id: "hunk-1",
            header: "@@ -1,4 +1,4 @@",
            oldStart: 1,
            oldLines: 4,
            newStart: 1,
            newLines: 4,
            preview: "line-03 changed",
            patch: "@@ -1,4 +1,4 @@\n-line-01\n+line-01 changed\n line-02\n-line-03\n+line-03 changed\n line-04\n",
            lines: [
              { kind: "del", content: "line-01", oldLineNumber: 1 },
              { kind: "add", content: "line-01 changed", newLineNumber: 1 },
              { kind: "context", content: "line-02", oldLineNumber: 2, newLineNumber: 2 },
              { kind: "del", content: "line-03", oldLineNumber: 3 },
              { kind: "add", content: "line-03 changed", newLineNumber: 3 },
              { kind: "context", content: "line-04", oldLineNumber: 4, newLineNumber: 4 },
            ],
          },
        ],
      },
    }).state;
    const firstModificationLineKeys = synced.entriesByPath[buildPartialCommitStateKey("src/app.ts", "/repo")]!.hunksById["hunk-1"]!.selectableLines
      .filter((line) => line.oldLineNumber === 1 || line.newLineNumber === 1)
      .map((line) => line.key);
    const partialState = setPartialCommitLineKeysSelected(synced, "src/app.ts", {
      "hunk-1": firstModificationLineKeys,
    }, false);

    const payload = buildCommitWorkflowPayload(inclusionState, partialState, "/repo", "partial lines", "commit");

    expect(payload.selections).toEqual([
      {
        repoRoot: "/repo",
        changeListId: "default",
        path: "src/app.ts",
        kind: "change",
        selectionMode: "partial",
        snapshotFingerprint: "fp-line-1",
        patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,4 +1,4 @@\n line-01\n line-02\n-line-03\n+line-03 changed\n line-04\n",
        selectedHunkIds: ["hunk-1"],
      },
    ]);
  });

  it("staging area 处于 commit-all 语义时，应按 included roots 汇总 tracked changes，而不是依赖显式勾选文件", () => {
    const items = buildCommitInclusionItems([
      { path: "root-a/staged.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo/root-a" },
      { path: "root-b/skip.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo/root-b" },
      { path: "root-b/new.ts", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default", repositoryRoot: "/repo/root-b" },
    ]);
    const baseState = syncCommitInclusionState(createCommitInclusionState(), items, "default");
    const inclusionState = {
      ...baseState,
      rootsUserTouched: true,
      includedRepoRoots: ["/repo/root-a"],
      rootsToCommit: ["/repo/root-a"],
      isCommitAll: true,
    };

    const payload = buildCommitWorkflowPayload(
      inclusionState,
      createPartialCommitSelectionState(),
      "/repo",
      "commit all",
      "commit",
      undefined,
      undefined,
      [
        { path: "root-a/staged.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo/root-a" },
        { path: "root-b/skip.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo/root-b" },
        { path: "root-b/new.ts", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default", repositoryRoot: "/repo/root-b" },
      ],
    );

    expect(payload.selections).toEqual([
      {
        repoRoot: "/repo/root-a",
        changeListId: "default",
        path: "root-a/staged.ts",
        kind: "change",
        selectionMode: "full-file",
      },
    ]);
    expect(payload.includedItems).toEqual([
      {
        repoRoot: "/repo/root-a",
        path: "root-a/staged.ts",
        kind: "change",
      },
    ]);
  });

  it("多仓 workflow payload 应保留各自 repoRoot，避免后端按当前仓错误归一化", () => {
    const payload = buildCommitWorkflowPayloadFromEntries([
      { path: "packages/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default", repositoryRoot: "/repo-a" },
      { path: "packages/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default", repositoryRoot: "/repo-b" },
    ], createPartialCommitSelectionState(), "/repo-a", "multi-root", "commit");

    expect(payload.selections).toEqual([
      {
        repoRoot: "/repo-a",
        changeListId: "default",
        path: "packages/a.ts",
        kind: "change",
        selectionMode: "full-file",
      },
      {
        repoRoot: "/repo-b",
        changeListId: "default",
        path: "packages/b.ts",
        kind: "change",
        selectionMode: "full-file",
      },
    ]);
    expect(payload.includedItems).toEqual([
      { repoRoot: "/repo-a", path: "packages/a.ts", kind: "change" },
      { repoRoot: "/repo-b", path: "packages/b.ts", kind: "change" },
    ]);
  });
});
