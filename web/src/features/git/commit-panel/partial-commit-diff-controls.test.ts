import { describe, expect, it } from "vitest";
import {
  buildPartialCommitStateKey,
  createPartialCommitSelectionState,
  setPartialCommitLineKeysSelected,
  syncPartialCommitSelectionWithSnapshot,
} from "./partial-commit-model";
import { buildPartialCommitDiffControls } from "./partial-commit-diff-controls";
import type { GitDiffSnapshot } from "../types";

/**
 * 构造带单 hunk 双修改点的最小 Diff 快照，供 Diff 内 partial commit 控件测试复用。
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

describe("partial commit diff controls", () => {
  /**
   * 统一按“仓库根 + 路径”读取 partial commit 条目，避免多仓键改造后测试继续走旧路径键。
   */
  function getPartialCommitEntryKey(): string {
    return buildPartialCommitStateKey("src/app.ts", "/repo");
  }

  it("尚未建立 partial entry 时，应保持整文件全纳入的默认语义", () => {
    expect(buildPartialCommitDiffControls(createLineLevelDiffSnapshot(), null)).toEqual({
      hunkControls: [{
        hunkId: "hunk-1",
        anchorSide: "modified",
        anchorLineNumber: 1,
        focusLineNumber: 1,
        selectionState: "full",
        selectedLineCount: 4,
        totalLineCount: 4,
      }],
      lineControls: [
        {
          key: "hunk-1:del:0:1:0",
          hunkId: "hunk-1",
          side: "original",
          lineNumber: 1,
          lineKey: "del:0:1:0",
          included: true,
        },
        {
          key: "hunk-1:add:1:0:1",
          hunkId: "hunk-1",
          side: "modified",
          lineNumber: 1,
          lineKey: "add:1:0:1",
          included: true,
        },
        {
          key: "hunk-1:del:3:3:0",
          hunkId: "hunk-1",
          side: "original",
          lineNumber: 3,
          lineKey: "del:3:3:0",
          included: true,
        },
        {
          key: "hunk-1:add:4:0:3",
          hunkId: "hunk-1",
          side: "modified",
          lineNumber: 3,
          lineKey: "add:4:0:3",
          included: true,
        },
      ],
    });
  });

  it("整块纳入时应只生成块级控件，不展开逐行复选框", () => {
    const synced = syncPartialCommitSelectionWithSnapshot(createPartialCommitSelectionState(), {
      path: "src/app.ts",
      repoRoot: "/repo",
      changeListId: "default",
      snapshot: createLineLevelDiffSnapshot(),
    }).state;

    expect(buildPartialCommitDiffControls(createLineLevelDiffSnapshot(), synced.entriesByPath[getPartialCommitEntryKey()]!)).toEqual({
      hunkControls: [{
        hunkId: "hunk-1",
        anchorSide: "modified",
        anchorLineNumber: 1,
        focusLineNumber: 1,
        selectionState: "full",
        selectedLineCount: 4,
        totalLineCount: 4,
      }],
      lineControls: [
        {
          key: "hunk-1:del:0:1:0",
          hunkId: "hunk-1",
          side: "original",
          lineNumber: 1,
          lineKey: "del:0:1:0",
          included: true,
        },
        {
          key: "hunk-1:add:1:0:1",
          hunkId: "hunk-1",
          side: "modified",
          lineNumber: 1,
          lineKey: "add:1:0:1",
          included: true,
        },
        {
          key: "hunk-1:del:3:3:0",
          hunkId: "hunk-1",
          side: "original",
          lineNumber: 3,
          lineKey: "del:3:3:0",
          included: true,
        },
        {
          key: "hunk-1:add:4:0:3",
          hunkId: "hunk-1",
          side: "modified",
          lineNumber: 3,
          lineKey: "add:4:0:3",
          included: true,
        },
      ],
    });
  });

  it("行级部分纳入时应输出左右两侧逐行控件，并保留每行纳入状态", () => {
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

    expect(buildPartialCommitDiffControls(createLineLevelDiffSnapshot(), partialState.entriesByPath[getPartialCommitEntryKey()]!)).toEqual({
      hunkControls: [{
        hunkId: "hunk-1",
        anchorSide: "modified",
        anchorLineNumber: 1,
        focusLineNumber: 1,
        selectionState: "partial",
        selectedLineCount: 2,
        totalLineCount: 4,
      }],
      lineControls: [
        {
          key: "hunk-1:del:0:1:0",
          hunkId: "hunk-1",
          side: "original",
          lineNumber: 1,
          lineKey: "del:0:1:0",
          included: false,
        },
        {
          key: "hunk-1:add:1:0:1",
          hunkId: "hunk-1",
          side: "modified",
          lineNumber: 1,
          lineKey: "add:1:0:1",
          included: false,
        },
        {
          key: "hunk-1:del:3:3:0",
          hunkId: "hunk-1",
          side: "original",
          lineNumber: 3,
          lineKey: "del:3:3:0",
          included: true,
        },
        {
          key: "hunk-1:add:4:0:3",
          hunkId: "hunk-1",
          side: "modified",
          lineNumber: 3,
          lineKey: "add:4:0:3",
          included: true,
        },
      ],
    });
  });
});
