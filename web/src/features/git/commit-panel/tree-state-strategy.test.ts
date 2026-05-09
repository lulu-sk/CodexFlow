import { describe, expect, it } from "vitest";
import {
  resolveAutoExpandedDirectoryState,
  resolveCommitFallbackRowSelection,
  resolveCommitGroupExpandedState,
  resolveCommitTreeExpandedState,
  shouldExpandDefaultChangeList,
} from "./tree-state-strategy";
import { createCommitInclusionState } from "./inclusion-model";
import type { ChangeEntryGroup, CommitTreeGroup } from "./types";

type TestDetailTreeNode = {
  key: string;
  isFile: boolean;
  children: TestDetailTreeNode[];
};

/**
 * 构建最小 changelist 分组输入，便于树状态策略测试。
 */
function createChangeGroup(input: Partial<ChangeEntryGroup> & Pick<ChangeEntryGroup, "key" | "label" | "entries" | "kind">): ChangeEntryGroup {
  return {
    helper: false,
    showHeader: true,
    summary: { fileCount: input.entries.length, directoryCount: 0 },
    state: { updating: false, outdatedFileCount: 0 },
    ...input,
  };
}

/**
 * 构建最小树分组输入，供默认回落选择测试复用。
 */
function createTreeGroup(input: Partial<CommitTreeGroup> & Pick<CommitTreeGroup, "key" | "label" | "entries" | "kind">): CommitTreeGroup {
  return {
    helper: false,
    showHeader: true,
    summary: { fileCount: input.entries.length, directoryCount: 0 },
    state: { updating: false, outdatedFileCount: 0 },
    treeNodes: [],
    treeRows: [],
    ...input,
  };
}

/**
 * 构建最小详情树节点输入，供目录默认展开策略测试复用。
 */
function createDetailTreeNode(input: {
  key: string;
  isFile: boolean;
  children?: TestDetailTreeNode[];
}): TestDetailTreeNode {
  return {
    key: input.key,
    isFile: input.isFile,
    children: input.children || [],
  };
}

describe("commit panel tree state strategy", () => {
  it("默认列表之前为空且其他列表未展开时，应自动展开默认列表", () => {
    const previousGroups = [
      createChangeGroup({ key: "cl:default", label: "默认", entries: [], kind: "changelist", changeListId: "default" }),
      createChangeGroup({ key: "cl:feature", label: "功能", entries: [{ path: "feature.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" }], kind: "changelist", changeListId: "feature" }),
    ];
    const nextGroups = [
      createChangeGroup({ key: "cl:default", label: "默认", entries: [{ path: "a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }], kind: "changelist", changeListId: "default" }),
      createChangeGroup({ key: "cl:feature", label: "功能", entries: [{ path: "feature.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" }], kind: "changelist", changeListId: "feature" }),
    ];
    expect(shouldExpandDefaultChangeList({
      previousGroups,
      nextGroups,
      previousExpanded: { "cl:default": false, "cl:feature": false },
    })).toBe(true);
    expect(resolveCommitGroupExpandedState({
      previousGroups,
      nextGroups,
      previousExpanded: { "cl:default": false, "cl:feature": false },
    })).toEqual({ "cl:default": true, "cl:feature": false });
  });

  it("默认列表之前为空但其他列表已展开时，不应强行展开默认列表", () => {
    const previousGroups = [
      createChangeGroup({ key: "cl:default", label: "默认", entries: [], kind: "changelist", changeListId: "default" }),
      createChangeGroup({ key: "cl:feature", label: "功能", entries: [{ path: "feature.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" }], kind: "changelist", changeListId: "feature" }),
    ];
    const nextGroups = [
      createChangeGroup({ key: "cl:default", label: "默认", entries: [{ path: "a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }], kind: "changelist", changeListId: "default" }),
      createChangeGroup({ key: "cl:feature", label: "功能", entries: [{ path: "feature.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" }], kind: "changelist", changeListId: "feature" }),
    ];
    expect(shouldExpandDefaultChangeList({
      previousGroups,
      nextGroups,
      previousExpanded: { "cl:default": false, "cl:feature": true },
    })).toBe(false);
  });

  it("提交分组展开态在无语义变化时应复用旧对象，避免 effect 反复触发", () => {
    const previousGroups = [
      createChangeGroup({ key: "cl:default", label: "默认", entries: [{ path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }], kind: "changelist", changeListId: "default" }),
      createChangeGroup({ key: "cl:feature", label: "功能", entries: [{ path: "src/feature.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" }], kind: "changelist", changeListId: "feature" }),
    ];
    const previousExpanded = { "cl:default": true, "cl:feature": false };
    const resolved = resolveCommitGroupExpandedState({
      previousGroups,
      nextGroups: previousGroups,
      previousExpanded,
    });
    expect(resolved).toBe(previousExpanded);
  });

  it("选择失效后应回落到默认 changelist 的 group 头", () => {
    const groups = [
      createTreeGroup({
        key: "cl:default",
        label: "默认",
        entries: [{ path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }],
        kind: "changelist",
        changeListId: "default",
        treeRows: [{
          node: {
            key: "node:a",
            name: "a.ts",
            fullPath: "src/a.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/a.ts"],
            entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
    ];
    expect(resolveCommitFallbackRowSelection({ groups })).toEqual(["group:cl:default"]);
  });

  it("存在冲突分组时，应优先回落到首个冲突文件节点", () => {
    const groups = [
      createTreeGroup({
        key: "special:conflicts",
        label: "冲突",
        entries: [{ path: "src/conflict.ts", x: "U", y: "U", staged: true, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "冲突", changeListId: "default", conflictState: "conflict" }],
        kind: "conflict",
        treeRows: [{
          node: {
            key: "node:conflict",
            name: "conflict.ts",
            fullPath: "src/conflict.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/conflict.ts"],
            entry: { path: "src/conflict.ts", x: "U", y: "U", staged: true, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "冲突", changeListId: "default", conflictState: "conflict" },
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
      createTreeGroup({
        key: "cl:default",
        label: "默认",
        entries: [{ path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }],
        kind: "changelist",
        changeListId: "default",
        treeRows: [{
          node: {
            key: "node:a",
            name: "a.ts",
            fullPath: "src/a.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/a.ts"],
            entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
    ];
    expect(resolveCommitFallbackRowSelection({ groups })).toEqual(["node:node:conflict"]);
  });

  it("resolved conflict 存在时，应优先回落到首个已解决冲突文件节点", () => {
    const groups = [
      createTreeGroup({
        key: "special:resolved-conflicts",
        label: "已解决冲突",
        entries: [{ path: "src/resolved.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已解决冲突", changeListId: "default", conflictState: "resolved" }],
        kind: "resolved-conflict",
        treeNodes: [{
          key: "node:resolved",
          name: "resolved.ts",
          fullPath: "src/resolved.ts",
          isFile: true,
          count: 1,
          filePaths: ["src/resolved.ts"],
          entry: { path: "src/resolved.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已解决冲突", changeListId: "default", conflictState: "resolved" },
          kind: "file",
          children: [],
        }],
        treeRows: [{
          node: {
            key: "node:resolved",
            name: "resolved.ts",
            fullPath: "src/resolved.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/resolved.ts"],
            entry: { path: "src/resolved.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已解决冲突", changeListId: "default", conflictState: "resolved" },
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
    ];
    expect(resolveCommitFallbackRowSelection({ groups })).toEqual(["node:node:resolved"]);
  });

  it("活动 changelist 全量纳入时，应回落到其 group 头", () => {
    const groups = [
      createTreeGroup({
        key: "cl:default",
        label: "默认",
        entries: [{ path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }],
        kind: "changelist",
        changeListId: "default",
        treeRows: [{
          node: {
            key: "node:a",
            name: "a.ts",
            fullPath: "src/a.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/a.ts"],
            entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
    ];
    expect(resolveCommitFallbackRowSelection({
      groups,
      activeChangeListId: "default",
      inclusionState: {
        ...createCommitInclusionState(),
        includedIds: ["c:default:normal:src/a.ts"],
        userTouched: false,
        itemsById: {
          "c:default:normal:src/a.ts": { id: "c:default:normal:src/a.ts", path: "src/a.ts", kind: "change", changeListId: "default" },
        },
      },
    })).toEqual(["group:cl:default"]);
  });

  it("显式激活提交流程时，应按活动 changelist 回落到对应 group 头", () => {
    const groups = [
      createTreeGroup({
        key: "cl:default",
        label: "默认",
        entries: [{ path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }],
        kind: "changelist",
        changeListId: "default",
        treeRows: [{
          node: {
            key: "node:a",
            name: "a.ts",
            fullPath: "src/a.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/a.ts"],
            entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
      createTreeGroup({
        key: "cl:feature",
        label: "功能",
        entries: [{ path: "src/feature.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" }],
        kind: "changelist",
        changeListId: "feature",
        treeRows: [{
          node: {
            key: "node:feature",
            name: "feature.ts",
            fullPath: "src/feature.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/feature.ts"],
            entry: { path: "src/feature.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" },
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
    ];
    expect(resolveCommitFallbackRowSelection({
      groups,
      activeChangeListId: "feature",
      inclusionState: {
        ...createCommitInclusionState(),
        includedIds: ["c:feature:normal:src/feature.ts"],
        userTouched: false,
        itemsById: {
          "c:feature:normal:src/feature.ts": { id: "c:feature:normal:src/feature.ts", path: "src/feature.ts", kind: "change", changeListId: "feature" },
        },
      },
    })).toEqual(["group:cl:feature"]);
  });

  it("部分 inclusion 时，应回落到首个已纳入文件节点而不是 group 头", () => {
    const groups = [
      createTreeGroup({
        key: "cl:default",
        label: "默认",
        entries: [
          { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
          { path: "src/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        ],
        kind: "changelist",
        changeListId: "default",
        treeRows: [
          {
            node: {
              key: "node:a",
              name: "a.ts",
              fullPath: "src/a.ts",
              isFile: true,
              count: 1,
              filePaths: ["src/a.ts"],
              entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
              kind: "file",
              children: [],
            },
            depth: 0,
          },
          {
            node: {
              key: "node:b",
              name: "b.ts",
              fullPath: "src/b.ts",
              isFile: true,
              count: 1,
              filePaths: ["src/b.ts"],
              entry: { path: "src/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
              kind: "file",
              children: [],
            },
            depth: 0,
          },
        ],
      }),
    ];
    expect(resolveCommitFallbackRowSelection({
      groups,
      activeChangeListId: "default",
      inclusionState: {
        ...createCommitInclusionState(),
        includedIds: ["c:default:normal:src/b.ts"],
        userTouched: true,
        itemsById: {
          "c:default:normal:src/b.ts": { id: "c:default:normal:src/b.ts", path: "src/b.ts", kind: "change", changeListId: "default" },
        },
      },
    })).toEqual(["node:node:b"]);
  });

  it("提交树默认展开态在没有新增目录键时应复用旧对象，避免进入重复渲染", () => {
    const previousExpanded = { "dir:src": true };
    const groups = [
      createTreeGroup({
        key: "cl:default",
        label: "默认",
        entries: [{ path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }],
        kind: "changelist",
        changeListId: "default",
        treeNodes: [{
          key: "dir:src",
          name: "src",
          fullPath: "src",
          isFile: false,
          count: 1,
          fileCount: 1,
          filePaths: ["src/a.ts"],
          kind: "directory",
          children: [{
            key: "node:a",
            name: "a.ts",
            fullPath: "src/a.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/a.ts"],
            entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
            kind: "file",
            children: [],
          }],
        }],
      }),
    ];
    const resolved = resolveCommitTreeExpandedState({
      groups,
      previousExpanded,
    });
    expect(resolved).toBe(previousExpanded);
  });

  it("提交树默认展开态应只补齐新增目录键，并保留用户既有折叠状态", () => {
    const previousExpanded = { "dir:src": false };
    const groups = [
      createTreeGroup({
        key: "cl:default",
        label: "默认",
        entries: [
          { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
          { path: "pkg/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        ],
        kind: "changelist",
        changeListId: "default",
        treeNodes: [
          {
            key: "dir:src",
            name: "src",
            fullPath: "src",
            isFile: false,
            count: 1,
            fileCount: 1,
            filePaths: ["src/a.ts"],
            kind: "directory",
            children: [],
          },
          {
            key: "dir:pkg",
            name: "pkg",
            fullPath: "pkg",
            isFile: false,
            count: 1,
            fileCount: 1,
            filePaths: ["pkg/b.ts"],
            kind: "directory",
            children: [],
          },
        ],
      }),
    ];
    const resolved = resolveCommitTreeExpandedState({
      groups,
      previousExpanded,
    });
    expect(resolved).toEqual({
      "dir:src": false,
      "dir:pkg": true,
    });
  });

  it("详情树默认展开态在没有新增目录键时应复用旧对象，避免进入重复渲染", () => {
    const previousExpanded = { "dir:src": true };
    const resolved = resolveAutoExpandedDirectoryState({
      previousExpanded,
      nodes: [createDetailTreeNode({
        key: "dir:src",
        isFile: false,
        children: [createDetailTreeNode({
          key: "file:src/a.ts",
          isFile: true,
        })],
      })],
    });
    expect(resolved).toBe(previousExpanded);
  });

  it("详情树默认展开态应只补齐新增目录键，并保留既有折叠状态", () => {
    const previousExpanded = { "dir:src": false };
    const resolved = resolveAutoExpandedDirectoryState({
      previousExpanded,
      nodes: [
        createDetailTreeNode({
          key: "dir:src",
          isFile: false,
          children: [createDetailTreeNode({
            key: "file:src/a.ts",
            isFile: true,
          })],
        }),
        createDetailTreeNode({
          key: "dir:pkg",
          isFile: false,
          children: [createDetailTreeNode({
            key: "file:pkg/b.ts",
            isFile: true,
          })],
        }),
      ],
    });
    expect(resolved).toEqual({
      "dir:src": false,
      "dir:pkg": true,
    });
  });

  it("刷新后恢复隐藏文件选择时，应强制展开其祖先目录", () => {
    const groups = [
      createTreeGroup({
        key: "cl:default",
        label: "默认",
        entries: [{ path: "src/nested/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }],
        kind: "changelist",
        changeListId: "default",
        treeNodes: [{
          key: "dir:src",
          name: "src",
          fullPath: "src",
          isFile: false,
          count: 1,
          fileCount: 1,
          filePaths: ["src/nested/a.ts"],
          kind: "directory",
          children: [{
            key: "dir:nested",
            name: "nested",
            fullPath: "src/nested",
            isFile: false,
            count: 1,
            fileCount: 1,
            filePaths: ["src/nested/a.ts"],
            kind: "directory",
            children: [{
              key: "node:a",
              name: "a.ts",
              fullPath: "src/nested/a.ts",
              isFile: true,
              count: 1,
              filePaths: ["src/nested/a.ts"],
              entry: { path: "src/nested/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
              kind: "file",
              children: [],
            }],
          }],
        }],
      }),
    ];
    const resolved = resolveCommitTreeExpandedState({
      groups,
      previousExpanded: {
        "dir:src": false,
        "dir:nested": false,
      },
      selectedNodeKeys: ["node:a"],
    });
    expect(resolved).toEqual({
      "dir:src": true,
      "dir:nested": true,
    });
  });

  it("选区未变化的普通状态同步不应重新展开用户手动折叠的祖先目录", () => {
    const previousExpanded = { "dir:src": false };
    const groups = [
      createTreeGroup({
        key: "cl:default",
        label: "默认",
        entries: [{ path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }],
        kind: "changelist",
        changeListId: "default",
        treeNodes: [{
          key: "dir:src",
          name: "src",
          fullPath: "src",
          isFile: false,
          count: 1,
          fileCount: 1,
          filePaths: ["src/a.ts"],
          kind: "directory",
          children: [{
            key: "node:a",
            name: "a.ts",
            fullPath: "src/a.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/a.ts"],
            entry: { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
            kind: "file",
            children: [],
          }],
        }],
      }),
    ];
    const resolved = resolveCommitTreeExpandedState({
      groups,
      previousExpanded,
      selectedNodeKeys: ["node:a"],
      expandSelectedNodeAncestors: false,
    });
    expect(resolved).toBe(previousExpanded);
  });
});
