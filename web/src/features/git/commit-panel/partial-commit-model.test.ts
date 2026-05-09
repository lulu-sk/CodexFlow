import { describe, expect, it } from "vitest";
import type { GitDiffSnapshot } from "../types";
import {
  buildPartialCommitStateKey,
  buildCommitWorkflowSelectionItem,
  createPartialCommitSelectionState,
  isPartialCommitSelectionActive,
  setAllPartialCommitHunksSelected,
  setPartialCommitHunkSelected,
  syncPartialCommitSelectionWithSnapshot,
} from "./partial-commit-model";

/**
 * 构造带两个 hunk 的最小 Diff 快照，供 partial commit 模型测试复用。
 */
function createDiffSnapshot(args?: { fingerprint?: string }): GitDiffSnapshot {
  const fingerprint = String(args?.fingerprint || "fingerprint-1");
  return {
    path: "src/app.ts",
    mode: "working",
    isBinary: false,
    leftText: "before",
    rightText: "after",
    leftTitle: "HEAD",
    rightTitle: "Working Tree",
    patchHeader: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n",
    fingerprint,
    patch: [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "@@ -10,1 +10,1 @@",
      "-const z = 1;",
      "+const z = 2;",
      "",
    ].join("\n"),
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
  };
}

describe("partial commit model", () => {
  it("初次同步快照时应默认选中全部 hunk，并回退为整文件提交语义", () => {
    const result = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: createDiffSnapshot(),
    });
    const selection = buildCommitWorkflowSelectionItem({
      id: "change:default:src/app.ts",
      path: "src/app.ts",
      kind: "change",
      changeListId: "default",
      repoRoot: "/repo",
    }, result.state, "/repo");

    expect(result.invalidatedPath).toBeUndefined();
    expect(result.state.entriesByPath[buildPartialCommitStateKey("src/app.ts", "/repo")]?.selectedHunkIds).toEqual(["hunk-1", "hunk-2"]);
    expect(isPartialCommitSelectionActive(result.state, "src/app.ts")).toBe(false);
    expect(selection).toEqual({
      repoRoot: "/repo",
      changeListId: "default",
      path: "src/app.ts",
      kind: "change",
      selectionMode: "full-file",
    });
  });

  it("只保留部分 hunk 时应输出真正的 partial selection patch", () => {
    const synced = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: createDiffSnapshot(),
    }).state;
    const partialState = setPartialCommitHunkSelected(synced, "src/app.ts", "hunk-2", false);
    const selection = buildCommitWorkflowSelectionItem({
      id: "change:default:src/app.ts",
      path: "src/app.ts",
      kind: "change",
      changeListId: "default",
      repoRoot: "/repo",
    }, partialState, "/repo");

    expect(isPartialCommitSelectionActive(partialState, "src/app.ts")).toBe(true);
    expect(selection).toEqual({
      repoRoot: "/repo",
      changeListId: "default",
      path: "src/app.ts",
      kind: "change",
      selectionMode: "partial",
      snapshotFingerprint: "fingerprint-1",
      patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;\n",
      selectedHunkIds: ["hunk-1"],
    });
  });

  it("同步 staged Diff 时应记录 mode，供提交前按正确基线重新校验 partial 选区", () => {
    const result = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: {
        ...createDiffSnapshot(),
        mode: "staged",
        leftTitle: "HEAD",
        rightTitle: "Index",
      },
    });

    expect(result.state.entriesByPath[buildPartialCommitStateKey("src/app.ts", "/repo")]?.diffMode).toBe("staged");
  });

  it("全部 hunk 取消后不应再生成提交选区", () => {
    const synced = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: createDiffSnapshot(),
    }).state;
    const emptyState = setAllPartialCommitHunksSelected(synced, "src/app.ts", false);
    const selection = buildCommitWorkflowSelectionItem({
      id: "change:default:src/app.ts",
      path: "src/app.ts",
      kind: "change",
      changeListId: "default",
      repoRoot: "/repo",
    }, emptyState, "/repo");

    expect(emptyState.entriesByPath[buildPartialCommitStateKey("src/app.ts", "/repo")]?.selectedHunkIds).toEqual([]);
    expect(selection).toBeNull();
  });

  it("已有真实 partial 选区时，底层指纹变化应清空并返回失效路径", () => {
    const synced = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: createDiffSnapshot(),
    }).state;
    const partialState = setPartialCommitHunkSelected(synced, "src/app.ts", "hunk-2", false);
    const invalidated = syncPartialCommitSelectionWithSnapshot(partialState, {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: createDiffSnapshot({ fingerprint: "fingerprint-2" }),
    });

    expect(invalidated.invalidatedPath).toBe("src/app.ts");
    expect(invalidated.state.entriesByPath[buildPartialCommitStateKey("src/app.ts", "/repo")]).toBeUndefined();
  });

  it("多仓同路径应分别存储 partial selection，避免后写入覆盖先前仓根状态", () => {
    const base = createPartialCommitSelectionState();
    const stateA = syncPartialCommitSelectionWithSnapshot(base, {
      path: "src/app.ts",
      repoRoot: "/repo-a",
      changeListId: "default",
      snapshot: createDiffSnapshot({ fingerprint: "repo-a" }),
    }).state;
    const stateB = syncPartialCommitSelectionWithSnapshot(stateA, {
      path: "src/app.ts",
      repoRoot: "/repo-b",
      changeListId: "default",
      snapshot: createDiffSnapshot({ fingerprint: "repo-b" }),
    }).state;

    expect(stateB.entriesByPath[buildPartialCommitStateKey("src/app.ts", "/repo-a")]?.snapshotFingerprint).toBe("repo-a");
    expect(stateB.entriesByPath[buildPartialCommitStateKey("src/app.ts", "/repo-b")]?.snapshotFingerprint).toBe("repo-b");
  });
});
