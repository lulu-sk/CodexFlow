import { describe, expect, it } from "vitest";
import type { GitDiffSnapshot } from "../types";
import {
  buildCommitWorkflowSelectionItem,
  buildPartialCommitStateKey,
  createPartialCommitSelectionState,
  setPartialCommitLineKeysSelected,
  syncPartialCommitSelectionWithSnapshot,
} from "./partial-commit-model";
import {
  buildPartialCommitLineDecorations,
  resolvePartialCommitAffectedLineSelection,
  resolvePartialCommitAffectedLineSelectionState,
} from "./partial-commit-lines";

/**
 * 构造带单 hunk 双修改点的最小 Diff 快照，供 line 级 partial commit 测试复用。
 */
function createLineLevelDiffSnapshot(): GitDiffSnapshot {
  return {
    path: "src/app.ts",
    mode: "working",
    isBinary: false,
    leftText: "line-01\nline-02\nline-03\nline-04\n",
    rightText: "line-01 changed\nline-02\nline-03 changed\nline-04\n",
    leftTitle: "HEAD",
    rightTitle: "Working Tree",
    patchHeader: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n",
    fingerprint: "line-fingerprint-1",
    patch: [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,4 +1,4 @@",
      "-line-01",
      "+line-01 changed",
      " line-02",
      "-line-03",
      "+line-03 changed",
      " line-04",
      "",
    ].join("\n"),
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
  };
}

describe("partial commit lines", () => {
  /**
   * 统一按“仓库根 + 路径”读取 partial commit 条目，避免测试继续依赖旧单路径键。
   */
  function getPartialCommitEntryKey(): string {
    return buildPartialCommitStateKey("src/app.ts", "/repo");
  }

  it("只保留 hunk 内部分 changed line 时，应生成真实的 line 级 partial patch", () => {
    const synced = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: createLineLevelDiffSnapshot(),
    }).state;
    const entry = synced.entriesByPath[getPartialCommitEntryKey()]!;
    const hunkLines = entry.hunksById["hunk-1"]!.selectableLines;
    const firstModificationLineKeys = hunkLines
      .filter((line) => line.oldLineNumber === 1 || line.newLineNumber === 1)
      .map((line) => line.key);
    const partialState = setPartialCommitLineKeysSelected(synced, "src/app.ts", {
      "hunk-1": firstModificationLineKeys,
    }, false);

    const selection = buildCommitWorkflowSelectionItem({
      id: "change:default:src/app.ts",
      path: "src/app.ts",
      kind: "change",
      changeListId: "default",
      repoRoot: "/repo",
    }, partialState, "/repo");

    expect(selection).toEqual({
      repoRoot: "/repo",
      changeListId: "default",
      path: "src/app.ts",
      kind: "change",
      selectionMode: "partial",
      snapshotFingerprint: "line-fingerprint-1",
      patch: [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,4 +1,4 @@",
        " line-01",
        " line-02",
        "-line-03",
        "+line-03 changed",
        " line-04",
        "",
      ].join("\n"),
      selectedHunkIds: ["hunk-1"],
    });
  });

  it("行级排除后应把左右侧对应 changed line 标成 excluded 装饰", () => {
    const synced = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: createLineLevelDiffSnapshot(),
    }).state;
    const entry = synced.entriesByPath[getPartialCommitEntryKey()]!;
    const firstModificationLineKeys = entry.hunksById["hunk-1"]!.selectableLines
      .filter((line) => line.oldLineNumber === 1 || line.newLineNumber === 1)
      .map((line) => line.key);
    const partialState = setPartialCommitLineKeysSelected(synced, "src/app.ts", {
      "hunk-1": firstModificationLineKeys,
    }, false);

    expect(buildPartialCommitLineDecorations(createLineLevelDiffSnapshot(), partialState.entriesByPath[getPartialCommitEntryKey()]!)).toEqual({
      excludedOriginalLines: [1],
      excludedModifiedLines: [1],
    });
  });

  it("Diff 当前选区应能映射为 affected line，并区分已纳入/已排除状态", () => {
    const synced = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: createLineLevelDiffSnapshot(),
    }).state;
    const entry = synced.entriesByPath[getPartialCommitEntryKey()]!;
    const selection = resolvePartialCommitAffectedLineSelection(createLineLevelDiffSnapshot(), {
      focusSide: "modified",
      originalSelectedLines: [],
      modifiedSelectedLines: [1, 3],
      modifiedActiveLine: 3,
    });
    const firstModificationLineKeys = entry.hunksById["hunk-1"]!.selectableLines
      .filter((line) => line.newLineNumber === 1)
      .map((line) => line.key);
    const partialState = setPartialCommitLineKeysSelected(synced, "src/app.ts", {
      "hunk-1": firstModificationLineKeys,
    }, false);

    expect(selection.affectedLineCount).toBe(2);
    expect(selection.affectedHunkCount).toBe(1);
    expect(resolvePartialCommitAffectedLineSelectionState(partialState.entriesByPath[getPartialCommitEntryKey()]!, selection.affectedLineKeysByHunkId)).toEqual({
      hasIncluded: true,
      hasExcluded: true,
    });
  });
});
