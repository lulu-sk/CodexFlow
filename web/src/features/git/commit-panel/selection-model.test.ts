import { describe, expect, it } from "vitest";
import {
  buildCommitMenuSelectionSnapshot,
  buildCommitRenderRowMap,
  buildCommitDiffSelection,
  buildCommitDiffSelectionFromNodes,
  buildCommitSelectionAnchors,
  deriveCommitSelectionContext,
  filterSelectableCommitNodeKeys,
  filterSelectableCommitRowKeys,
  resolveExactlySelectedChangePaths,
  resolveExplicitSelectedChangeListIds,
  resolveSelectedDeleteTargets,
  resolveSelectedDiffableCommitNodeKey,
  resolveSelectedSubtreeCommitNodeKeys,
  resolveSelectedChangeListIds,
  restoreCommitTreeSelection,
  selectCommitNodeByPath,
} from "./selection-model";
import type { CommitTreeNode } from "./types";

/**
 * 为选择模型测试构建最小树行索引，避免每个用例重复手写样板 group 结构。
 */
function createRowMap(rows: Array<{ key: string; node?: CommitTreeNode; changeListId?: string; label?: string }>) {
  return buildCommitRenderRowMap(rows.map((row) => (
    row.node
      ? {
          key: row.key,
          kind: "node" as const,
          group: {
            key: `group:${row.key}`,
            label: row.label || row.key,
            entries: [],
            kind: "changelist",
            changeListId: row.changeListId,
            treeNodes: [],
            treeRows: [],
          } as any,
          node: row.node as any,
          depth: 0,
          textPresentation: row.node.name,
        }
      : {
          key: row.key,
          kind: "group" as const,
          group: {
            key: String(row.key || "").replace(/^group:/, ""),
            label: row.label || row.key,
            entries: [],
            kind: "changelist",
            changeListId: row.changeListId,
            treeNodes: [],
            treeRows: [],
          } as any,
          textPresentation: row.label || row.key,
        }
  )));
}

describe("commit panel selection model", () => {
  it("按路径恢复选择时应优先回到正确 changelist 节点", () => {
    const nodeMap = new Map<string, CommitTreeNode>([
      ["one", {
        key: "one",
        name: "a.ts",
        fullPath: "src/a.ts",
        isFile: true,
        count: 1,
        filePaths: ["src/a.ts"],
        kind: "file",
        entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        children: [],
      }],
      ["two", {
        key: "two",
        stableId: "feature:a",
        name: "a.ts",
        fullPath: "src/a.ts",
        isFile: true,
        count: 1,
        filePaths: ["src/a.ts"],
        kind: "file",
        entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" },
        children: [],
      }],
    ]);
    const rowMap = createRowMap([
      { key: "node:one", node: nodeMap.get("one"), changeListId: "default" },
      { key: "node:two", node: nodeMap.get("two"), changeListId: "feature" },
    ]);
    const anchors = buildCommitSelectionAnchors(["node:two"], rowMap, nodeMap);
    const restored = restoreCommitTreeSelection(anchors, rowMap, nodeMap);
    expect(restored).toEqual(["node:two"]);
  });

  it("同路径重复出现时应优先按 stable identity 精确恢复", () => {
    const nodeMap = new Map<string, CommitTreeNode>([
      ["one", {
        key: "one",
        stableId: "default:a",
        name: "a.ts",
        fullPath: "src/a.ts",
        isFile: true,
        count: 1,
        filePaths: ["src/a.ts"],
        kind: "file",
        entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        children: [],
      }],
      ["two", {
        key: "two",
        stableId: "amend:a",
        name: "a.ts",
        fullPath: "src/a.ts",
        isFile: true,
        count: 1,
        filePaths: ["src/a.ts"],
        kind: "file",
        entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        children: [],
      }],
    ]);
    const rowMap = createRowMap([
      { key: "node:one", node: nodeMap.get("one"), changeListId: "default" },
      { key: "node:two", node: nodeMap.get("two"), changeListId: "default" },
    ]);
    const restored = restoreCommitTreeSelection([{ kind: "node", path: "src/a.ts", stableId: "amend:a" }], rowMap, nodeMap);
    expect(restored).toEqual(["node:two"]);
  });

  it("group 头应作为真实选择对象保留在树选区模型中", () => {
    const rowMap = createRowMap([
      { key: "group:cl:default", changeListId: "default", label: "默认" },
    ]);
    expect(filterSelectableCommitRowKeys(["group:cl:default"], rowMap, new Map())).toEqual(["group:cl:default"]);
    expect(resolveSelectedChangeListIds(["group:cl:default"], rowMap, new Map())).toEqual(["default"]);
    expect(resolveExplicitSelectedChangeListIds(["group:cl:default"], rowMap)).toEqual(["default"]);
  });

  it("删除目标应保留目录节点路径，且删除更改列表只接受显式 changelist 头选择", () => {
    const fileNode: CommitTreeNode = {
      key: "file:app",
      name: "App.tsx",
      fullPath: "web/src/App.tsx",
      isFile: true,
      count: 1,
      filePaths: ["web/src/App.tsx"],
      kind: "file",
      entry: { path: "web/src/App.tsx", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      children: [],
    };
    const directoryNode: CommitTreeNode = {
      key: "dir:web/src",
      name: "web/src",
      fullPath: "web/src",
      isFile: false,
      count: 1,
      filePaths: ["web/src/App.tsx"],
      kind: "directory",
      children: [fileNode],
    };
    const rowMap = createRowMap([
      { key: "group:cl:default", changeListId: "default", label: "默认" },
      { key: "node:dir:web/src", node: directoryNode, changeListId: "default" },
    ]);
    const nodeMap = new Map<string, CommitTreeNode>([
      [directoryNode.key, directoryNode],
      [fileNode.key, fileNode],
    ]);

    expect(resolveSelectedDeleteTargets(["node:dir:web/src"], rowMap, nodeMap)).toEqual(["web/src"]);
    expect(resolveExplicitSelectedChangeListIds(["node:dir:web/src"], rowMap)).toEqual([]);

    const ctx = deriveCommitSelectionContext({
      selectedEntries: [fileNode.entry!],
      selectedPaths: ["web/src/App.tsx"],
      selectedChangeListIds: ["default"],
      selectedExplicitChangeListIds: [],
      contextChangeListId: "default",
      contextChangeListExplicit: false,
      availableChangeListIds: new Set(["default"]),
      activeChangeListId: "feature",
      localChangesConfig: { stagingAreaEnabled: false, changeListsEnabled: true },
    });
    expect(ctx.canDeleteList).toBe(false);
    expect(ctx.canEditList).toBe(true);
  });

  it("右键菜单快照应冻结目录节点的 entries、删除目标与 changelist 语义", () => {
    const fileNode: CommitTreeNode = {
      key: "file:archive",
      name: "archive.zip",
      fullPath: "workflow-packs/archive.zip",
      isFile: true,
      count: 1,
      filePaths: ["workflow-packs/archive.zip"],
      kind: "file",
      sourceKind: "status",
      sourceId: "workflow-packs/archive.zip",
      entry: { path: "workflow-packs/archive.zip", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default" },
      children: [],
    };
    const directoryNode: CommitTreeNode = {
      key: "dir:workflow-packs",
      name: "workflow-packs",
      fullPath: "workflow-packs",
      isFile: false,
      count: 1,
      filePaths: ["workflow-packs/archive.zip"],
      kind: "directory",
      children: [fileNode],
    };
    const rowMap = buildCommitRenderRowMap([{
      key: "node:dir:workflow-packs",
      kind: "node" as const,
      group: {
        key: "cl:default",
        label: "默认",
        entries: [fileNode.entry!],
        kind: "changelist",
        changeListId: "default",
        treeNodes: [directoryNode],
        treeRows: [{ node: directoryNode, depth: 0 }],
      } as any,
      node: directoryNode,
      depth: 0,
      textPresentation: "workflow-packs",
    }]);
    const nodeMap = new Map<string, CommitTreeNode>([
      [directoryNode.key, directoryNode],
      [fileNode.key, fileNode],
    ]);

    const snapshot = buildCommitMenuSelectionSnapshot({
      selectedRowKeys: ["node:dir:workflow-packs"],
      rowMap,
      nodeMap,
    });

    expect(snapshot.selectedEntries).toEqual([fileNode.entry]);
    expect(snapshot.selectedPaths).toEqual(["workflow-packs/archive.zip"]);
    expect(snapshot.exactlySelectedPaths).toEqual([]);
    expect(snapshot.selectedDeleteTargets).toEqual(["workflow-packs"]);
    expect(snapshot.selectedChangeListIds).toEqual([]);
    expect(snapshot.selectedExplicitChangeListIds).toEqual([]);
    expect(snapshot.selectedNodeSources).toEqual([{ sourceKind: "status", sourceId: "workflow-packs/archive.zip" }]);
    expect(snapshot.selectedSingleNode?.key).toBe("dir:workflow-packs");
  });

  it("exact selection 与 selected subtree 应严格分离", () => {
    const fileNode: CommitTreeNode = {
      key: "file:a",
      name: "a.ts",
      fullPath: "src/a.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/a.ts"],
      kind: "file",
      entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      children: [],
    };
    const directoryNode: CommitTreeNode = {
      key: "dir:src",
      name: "src",
      fullPath: "src",
      isFile: false,
      count: 1,
      filePaths: ["src/a.ts"],
      kind: "directory",
      children: [fileNode],
    };
    const rowMap = createRowMap([
      { key: "node:dir:src", node: directoryNode, changeListId: "default" },
      { key: "node:file:a", node: fileNode, changeListId: "default" },
    ]);
    const nodeMap = new Map<string, CommitTreeNode>([
      [directoryNode.key, directoryNode],
      [fileNode.key, fileNode],
    ]);
    expect(resolveExactlySelectedChangePaths(["node:dir:src"], nodeMap)).toEqual([]);
    expect(resolveSelectedSubtreeCommitNodeKeys(["node:dir:src"], rowMap, nodeMap)).toEqual(["file:a"]);
    const ctx = deriveCommitSelectionContext({
      selectedEntries: [fileNode.entry!],
      selectedPaths: ["src/a.ts"],
      exactlySelectedPaths: [],
      selectedChangeListIds: [],
      availableChangeListIds: new Set(["default"]),
      activeChangeListId: "default",
      localChangesConfig: { stagingAreaEnabled: false, changeListsEnabled: true },
    });
    expect(ctx.exactlySelectedFiles).toEqual([]);
    expect(ctx.virtualFilePaths).toEqual(["src/a.ts"]);
    expect(ctx.navigatablePaths).toEqual(["src/a.ts"]);
  });

  it("group 头选中后若旧 diffable 仍在子树内，应优先保留旧 diffable", () => {
    const nodeA: CommitTreeNode = {
      key: "file:a",
      name: "a.ts",
      fullPath: "src/a.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/a.ts"],
      kind: "file",
      entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      children: [],
    };
    const nodeB: CommitTreeNode = {
      key: "file:b",
      name: "b.ts",
      fullPath: "src/b.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/b.ts"],
      kind: "file",
      entry: { path: "src/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      children: [],
    };
    const rowMap = buildCommitRenderRowMap([{
      key: "group:cl:default",
      kind: "group" as const,
      group: {
        key: "cl:default",
        label: "默认",
        entries: [nodeA.entry!, nodeB.entry!],
        kind: "changelist",
        changeListId: "default",
        treeNodes: [nodeA, nodeB],
        treeRows: [{ node: nodeA, depth: 0 }, { node: nodeB, depth: 0 }],
      } as any,
      textPresentation: "默认",
    }]);
    const nodeMap = new Map<string, CommitTreeNode>([
      [nodeA.key, nodeA],
      [nodeB.key, nodeB],
    ]);
    expect(resolveSelectedDiffableCommitNodeKey({
      selectedRowKeys: ["group:cl:default"],
      rowMap,
      nodeMap,
      previousNodeKey: "file:b",
    })).toBe("file:b");
  });

  it("基于 selection model 的菜单态应允许 ignored/unversioned 执行 add-to-vcs 与 move", () => {
    const ctx = deriveCommitSelectionContext({
      selectedEntries: [
        { path: "dist/a.js", x: "!", y: "!", staged: false, unstaged: false, untracked: false, ignored: true, renamed: false, deleted: false, statusText: "已忽略", changeListId: "" },
      ],
      selectedPaths: ["dist/a.js"],
      selectedChangeListIds: [],
      contextChangeListId: "default",
      availableChangeListIds: new Set(["default"]),
      activeChangeListId: "default",
      localChangesConfig: { stagingAreaEnabled: false, changeListsEnabled: true },
    });
    expect(ctx.canAddToVcs).toBe(true);
    expect(ctx.canMoveToList).toBe(true);
    expect(ctx.canCommit).toBe(false);
    expect(ctx.canOpenSource).toBe(true);
  });

  it("暂存区模式下应区分 add-without-content/reset/revert 与 stage compare 能力", () => {
    const ctx = deriveCommitSelectionContext({
      selectedEntries: [
        { path: "src/app.ts", x: "M", y: "M", staged: true, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default" },
      ],
      selectedPaths: ["src/app.ts"],
      exactlySelectedPaths: ["src/app.ts"],
      selectedChangeListIds: [],
      availableChangeListIds: new Set(["default"]),
      activeChangeListId: "default",
      localChangesConfig: { stagingAreaEnabled: true, changeListsEnabled: false },
    });

    expect(ctx.selectedStageablePaths).toEqual(["src/app.ts"]);
    expect(ctx.selectedTrackedUnstagedPaths).toEqual(["src/app.ts"]);
    expect(ctx.selectedStagedPaths).toEqual(["src/app.ts"]);
    expect(ctx.selectedStashablePaths).toEqual(["src/app.ts"]);
    expect(ctx.canStage).toBe(true);
    expect(ctx.canStageWithoutContent).toBe(false);
    expect(ctx.canUnstage).toBe(true);
    expect(ctx.canRevertUnstaged).toBe(true);
    expect(ctx.canStageStash).toBe(true);
    expect(ctx.canIgnore).toBe(false);
    expect(ctx.canShowStaged).toBe(true);
    expect(ctx.canShowLocal).toBe(true);
    expect(ctx.canCompareLocalToStaged).toBe(true);
    expect(ctx.canCompareStagedToLocal).toBe(true);
    expect(ctx.canCompareStagedToHead).toBe(true);
    expect(ctx.canCompareThreeVersions).toBe(true);
    expect(ctx.stagingAreaEnabled).toBe(true);
  });

  it("单选 untracked 文件时，应暴露 add-without-content 与 ignore 能力", () => {
    const ctx = deriveCommitSelectionContext({
      selectedEntries: [
        { path: "src/new.ts", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "" },
      ],
      selectedPaths: ["src/new.ts"],
      selectedChangeListIds: [],
      availableChangeListIds: new Set(["default"]),
      activeChangeListId: "default",
      localChangesConfig: { stagingAreaEnabled: true, changeListsEnabled: false },
    });

    expect(ctx.canStage).toBe(true);
    expect(ctx.canStageWithoutContent).toBe(true);
    expect(ctx.canIgnore).toBe(true);
  });

  it("单选 amend modifier 节点时，应按真实 amend 历史条目保留 IDEA 共享菜单动作", () => {
    const ctx = deriveCommitSelectionContext({
      selectedEntries: [
        { path: "src/amend.ts", x: "M", y: ".", staged: false, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "__amend__" },
      ],
      selectedPaths: ["src/amend.ts"],
      exactlySelectedPaths: ["src/amend.ts"],
      selectedNodeSources: [{ sourceKind: "modifier", sourceId: "amend" }],
      selectedChangeListIds: [],
      availableChangeListIds: new Set(["default"]),
      activeChangeListId: "default",
      localChangesConfig: { stagingAreaEnabled: false, changeListsEnabled: true },
    });

    expect(ctx.canCommit).toBe(true);
    expect(ctx.canRollback).toBe(true);
    expect(ctx.canShelve).toBe(true);
    expect(ctx.canMoveToList).toBe(true);
    expect(ctx.canShowDiff).toBe(true);
    expect(ctx.canOpenSource).toBe(true);
    expect(ctx.canDelete).toBe(true);
    expect(ctx.canAddToVcs).toBe(false);
    expect(ctx.canIgnore).toBe(false);
    expect(ctx.canStage).toBe(false);
    expect(ctx.canUnstage).toBe(false);
    expect(ctx.canShowLocal).toBe(false);
    expect(ctx.canShowHistory).toBe(true);
  });

  it("Git 不支持 stash pathspec 时，应禁用 stage stash 能力", () => {
    const ctx = deriveCommitSelectionContext({
      selectedEntries: [
        { path: "src/app.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      ],
      selectedPaths: ["src/app.ts"],
      selectedChangeListIds: [],
      availableChangeListIds: new Set(["default"]),
      activeChangeListId: "default",
      localChangesConfig: { stagingAreaEnabled: true, changeListsEnabled: false },
      stashPushPathspecSupported: false,
    });

    expect(ctx.canStageStash).toBe(false);
  });

  it("单选 tracked change 时，Diff 选择集应扩展为同 changelist 全部 change", () => {
    const selection = buildCommitDiffSelection({
      selectedEntries: [
        { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      ],
      allEntries: [
        { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        { path: "src/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        { path: "src/c.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" },
      ],
    });
    expect(selection).toEqual({
      primaryPath: "src/a.ts",
      paths: ["src/a.ts", "src/b.ts"],
      kind: "change",
    });
  });

  it("Select In Changes View 应优先命中指定 changelist 下的同路径节点", () => {
    const nodeMap = new Map<string, CommitTreeNode>([
      ["one", {
        key: "one",
        name: "a.ts",
        fullPath: "src/a.ts",
        isFile: true,
        count: 1,
        filePaths: ["src/a.ts"],
        kind: "file",
        entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        children: [],
      }],
      ["two", {
        key: "two",
        name: "a.ts",
        fullPath: "src/a.ts",
        isFile: true,
        count: 1,
        filePaths: ["src/a.ts"],
        kind: "file",
        entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" },
        children: [],
      }],
    ]);
    expect(selectCommitNodeByPath({
      path: "src/a.ts",
      preferredChangeListId: "feature",
      nodeMap,
    })).toEqual(["two"]);
  });

  it("单选 amend 节点时，Diff 选择集应扩展到同 modifier 来源下全部文件", () => {
    const nodeMap = new Map<string, CommitTreeNode>([
      ["amend:a", {
        key: "amend:a",
        name: "a.ts",
        fullPath: "src/a.ts",
        isFile: true,
        count: 1,
        filePaths: ["src/a.ts"],
        kind: "file",
        sourceGroupKey: "modifier:edited-commit:amend",
        sourceKind: "modifier",
        sourceId: "amend",
        entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        children: [],
      }],
      ["amend:b", {
        key: "amend:b",
        name: "b.ts",
        fullPath: "src/b.ts",
        isFile: true,
        count: 1,
        filePaths: ["src/b.ts"],
        kind: "file",
        sourceGroupKey: "modifier:edited-commit:amend",
        sourceKind: "modifier",
        sourceId: "amend",
        entry: { path: "src/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        children: [],
      }],
      ["default:a", {
        key: "default:a",
        name: "a.ts",
        fullPath: "src/a.ts",
        isFile: true,
        count: 1,
        filePaths: ["src/a.ts"],
        kind: "file",
        sourceGroupKey: "cl:default",
        sourceKind: "status",
        sourceId: "cl:default",
        entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        children: [],
      }],
    ]);
    expect(buildCommitDiffSelectionFromNodes({
      selectedNodeKeys: ["amend:a"],
      nodeMap,
    })).toEqual({
      primaryPath: "src/a.ts",
      paths: ["src/a.ts", "src/b.ts"],
      kind: "change",
    });
  });

  it("NON_SELECTABLE 节点不应进入最终选择集", () => {
    const nodeMap = new Map<string, CommitTreeNode>([
      ["file", {
        key: "file",
        name: "a.ts",
        fullPath: "src/a.ts",
        isFile: true,
        count: 1,
        filePaths: ["src/a.ts"],
        kind: "file",
        children: [],
      }],
      ["blocked", {
        key: "blocked",
        name: "blocked",
        fullPath: "blocked",
        isFile: false,
        count: 0,
        filePaths: [],
        kind: "directory",
        children: [],
        selectionFlags: {
          selectable: false,
          inclusionVisible: false,
          inclusionEnabled: false,
          hideInclusionCheckbox: true,
          helper: true,
          nonSelectable: true,
        },
      }],
    ]);
    expect(filterSelectableCommitNodeKeys(["blocked", "file"], nodeMap)).toEqual(["file"]);
  });
});
