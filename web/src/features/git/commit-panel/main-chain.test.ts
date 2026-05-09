import { describe, expect, it } from "vitest";
import type { GitDiffSnapshot, GitStatusEntry } from "../types";
import {
  applyCommitDiffOpenRequestToSnapshot,
  buildAdjacentCommitDiffOpenRequest,
  buildCommitDiffOpenRequest,
  buildCommitNodeDiffOpenRequest,
} from "./main-chain";
import type { CommitTreeNode } from "./types";

const LOCAL_CHANGES_CONFIG = {
  stagingAreaEnabled: false,
  changeListsEnabled: true,
} as const;

/**
 * 构建最小状态条目，便于聚焦提交面板主链路而非测试样板数据。
 */
function createEntry(input: Partial<GitStatusEntry> & Pick<GitStatusEntry, "path">): GitStatusEntry {
  return {
    oldPath: undefined,
    x: "M",
    y: ".",
    staged: true,
    unstaged: false,
    untracked: false,
    ignored: false,
    renamed: false,
    deleted: false,
    statusText: "已暂存",
    changeListId: "default",
    ...input,
  };
}

/**
 * 构建最小文件节点，模拟主树已选节点进入 Diff 主链路时的真实输入。
 */
function createFileNode(input: {
  key: string;
  entry: GitStatusEntry;
  sourceGroupKey?: string;
  sourceId?: string;
}): CommitTreeNode {
  return {
    key: input.key,
    name: input.entry.path.split("/").pop() || input.entry.path,
    fullPath: input.entry.path,
    isFile: true,
    count: 1,
    filePaths: [input.entry.path],
    entry: input.entry,
    kind: "file",
    children: [],
    sourceGroupKey: input.sourceGroupKey,
    sourceId: input.sourceId,
  };
}

describe("commit panel main chain", () => {
  it("单选 changelist 文件时，Diff 请求应真正携带同 changelist 全组选区", () => {
    const entryA = createEntry({ path: "src/a.ts", changeListId: "default" });
    const entryB = createEntry({ path: "src/b.ts", changeListId: "default" });
    const entryC = createEntry({ path: "src/c.ts", changeListId: "feature" });

    const request = buildCommitDiffOpenRequest({
      entry: entryA,
      selectedNodeKeys: [],
      nodeMap: new Map<string, CommitTreeNode>(),
      selectedEntries: [entryA],
      allEntries: [entryA, entryB, entryC],
      localChangesConfig: LOCAL_CHANGES_CONFIG,
    });

    expect(request).toMatchObject({
      path: "src/a.ts",
      selectionPaths: ["src/a.ts", "src/b.ts"],
      selectionKind: "change",
      selectionIndex: 0,
    });
  });

  it("单选 amend 节点文件时，Diff 请求应带入同 amend source 全组选区", () => {
    const entryA = createEntry({ path: "src/amend-a.ts" });
    const entryB = createEntry({ path: "src/amend-b.ts" });
    const nodeMap = new Map<string, CommitTreeNode>([
      ["node:amend-a", createFileNode({ key: "node:amend-a", entry: entryA, sourceGroupKey: "modifier:edited-commit:amend", sourceId: "amend" })],
      ["node:amend-b", createFileNode({ key: "node:amend-b", entry: entryB, sourceGroupKey: "modifier:edited-commit:amend", sourceId: "amend" })],
    ]);

    const request = buildCommitNodeDiffOpenRequest({
      nodeKey: "node:amend-a",
      nodeMap,
      localChangesConfig: LOCAL_CHANGES_CONFIG,
    });

    expect(request).toMatchObject({
      path: "src/amend-a.ts",
      selectionPaths: ["src/amend-a.ts", "src/amend-b.ts"],
      selectionKind: "change",
      selectionIndex: 0,
    });
  });

  it("单选 unversioned 文件时，Diff 请求应带入全部 unversioned", () => {
    const entryA = createEntry({ path: "new-a.ts", staged: false, unstaged: true, untracked: true, statusText: "未跟踪", changeListId: "" });
    const entryB = createEntry({ path: "new-b.ts", staged: false, unstaged: true, untracked: true, statusText: "未跟踪", changeListId: "" });

    const request = buildCommitDiffOpenRequest({
      entry: entryA,
      selectedNodeKeys: [],
      nodeMap: new Map<string, CommitTreeNode>(),
      selectedEntries: [entryA],
      allEntries: [entryA, entryB],
      localChangesConfig: LOCAL_CHANGES_CONFIG,
    });

    expect(request).toMatchObject({
      path: "new-a.ts",
      selectionPaths: ["new-a.ts", "new-b.ts"],
      selectionKind: "unversioned",
      selectionIndex: 0,
    });
  });

  it("Diff 快照应保留组选区，并支持上一文件/下一文件切换", () => {
    const snapshot: GitDiffSnapshot = {
      path: "src/a.ts",
      mode: "working",
      isBinary: false,
      leftText: "a",
      rightText: "b",
      leftTitle: "HEAD",
      rightTitle: "Working Tree",
    };
    const request = buildCommitDiffOpenRequest({
      entry: createEntry({ path: "src/a.ts" }),
      selectedNodeKeys: [],
      nodeMap: new Map<string, CommitTreeNode>(),
      selectedEntries: [createEntry({ path: "src/a.ts" }), createEntry({ path: "src/b.ts" })],
      allEntries: [createEntry({ path: "src/a.ts" }), createEntry({ path: "src/b.ts" })],
      localChangesConfig: LOCAL_CHANGES_CONFIG,
    });
    const nextSnapshot = applyCommitDiffOpenRequestToSnapshot(snapshot, request!);

    expect(nextSnapshot?.selectionPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(nextSnapshot?.selectionIndex).toBe(0);
    expect(buildAdjacentCommitDiffOpenRequest(nextSnapshot, "next")).toMatchObject({
      path: "src/b.ts",
      selectionPaths: ["src/a.ts", "src/b.ts"],
      selectionIndex: 1,
    });
    expect(buildAdjacentCommitDiffOpenRequest(nextSnapshot, "prev")).toMatchObject({
      path: "src/b.ts",
      selectionPaths: ["src/a.ts", "src/b.ts"],
      selectionIndex: 1,
    });
  });

  it("提交面板主链路写回 Diff 请求时，不应丢失 partial commit 所需的 patch 元数据", () => {
    const snapshot: GitDiffSnapshot = {
      path: "src/a.ts",
      mode: "working",
      isBinary: false,
      leftText: "before",
      rightText: "after",
      leftTitle: "HEAD",
      rightTitle: "Working Tree",
      patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n",
      patchHeader: "diff --git a/src/a.ts b/src/a.ts\n",
      fingerprint: "fp-1",
      hunks: [{
        id: "hunk-1",
        header: "@@ -1,1 +1,1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        preview: "b",
        patch: "@@ -1,1 +1,1 @@\n-a\n+b\n",
        lines: [
          { kind: "del", content: "a", oldLineNumber: 1 },
          { kind: "add", content: "b", newLineNumber: 1 },
        ],
      }],
    };
    const request = buildCommitDiffOpenRequest({
      entry: createEntry({ path: "src/a.ts" }),
      selectedNodeKeys: [],
      nodeMap: new Map<string, CommitTreeNode>(),
      selectedEntries: [createEntry({ path: "src/a.ts" }), createEntry({ path: "src/b.ts" })],
      allEntries: [createEntry({ path: "src/a.ts" }), createEntry({ path: "src/b.ts" })],
      localChangesConfig: LOCAL_CHANGES_CONFIG,
    });
    const nextSnapshot = applyCommitDiffOpenRequestToSnapshot(snapshot, request!);

    expect(nextSnapshot?.patchHeader).toBe("diff --git a/src/a.ts b/src/a.ts\n");
    expect(nextSnapshot?.fingerprint).toBe("fp-1");
    expect(nextSnapshot?.hunks?.map((hunk) => hunk.id)).toEqual(["hunk-1"]);
    expect(nextSnapshot?.selectionPaths).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
