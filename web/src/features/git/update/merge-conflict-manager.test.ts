import { describe, expect, it } from "vitest";
import type { GitConflictMergeSessionSnapshot } from "../types";
import {
  buildRemainingMergeConflictNoticeMessage,
  buildMergeConflictTableRows,
  findMergeConflictAncestorNodeKeys,
  resolveEffectiveMergeConflictPaths,
  resolveMergeConflictPrimaryAction,
  sanitizeMergeConflictSelection,
  shouldNotifyRemainingMergeConflicts,
  shouldAutoCloseMergeConflictDialog,
} from "./merge-conflict-manager";

/**
 * 创建最小 merge session 快照，覆盖 unresolved、resolved 与目录分组场景。
 */
function createSnapshot(): GitConflictMergeSessionSnapshot {
  const unresolvedEntries: GitConflictMergeSessionSnapshot["unresolvedEntries"] = [
    {
      path: "src/a.ts",
      fileName: "a.ts",
      directoryPath: "src",
      conflictState: "unresolved",
      reverseSides: false,
      canOpenMerge: true,
      canOpenFile: true,
      oursState: "modified",
      theirsState: "modified",
      base: { label: "Base", available: true },
      ours: { label: "Ours", available: true },
      theirs: { label: "Theirs", available: true },
      working: { label: "结果", available: true },
    },
    {
      path: "docs/readme.md",
      fileName: "readme.md",
      directoryPath: "docs",
      conflictState: "unresolved",
      reverseSides: false,
      canOpenMerge: false,
      canOpenFile: true,
      oursState: "deleted",
      theirsState: "modified",
      base: { label: "Base", available: true },
      ours: { label: "Ours", available: false },
      theirs: { label: "Theirs", available: true },
      working: { label: "结果", available: true },
    },
  ];
  const resolvedEntries: GitConflictMergeSessionSnapshot["resolvedEntries"] = [
    {
      path: "src/resolved.ts",
      fileName: "resolved.ts",
      directoryPath: "src",
      conflictState: "resolved",
      reverseSides: false,
      canOpenMerge: false,
      canOpenFile: true,
      oursState: "resolved",
      theirsState: "resolved",
      base: { label: "Base", available: false },
      ours: { label: "Ours", available: false },
      theirs: { label: "Theirs", available: false },
      working: { label: "结果", available: true },
    },
  ];
  return {
    reverseSides: false,
    labels: {
      base: "Base",
      ours: "Ours",
      theirs: "Theirs",
      working: "结果",
    },
    unresolvedCount: unresolvedEntries.length,
    resolvedCount: resolvedEntries.length,
    unresolvedEntries,
    resolvedEntries,
    entries: [...unresolvedEntries, ...resolvedEntries],
    resolvedHolder: {
      source: "resolve-undo",
      operationState: "merging",
      inUpdate: false,
      paths: ["src/resolved.ts"],
    },
  };
}

describe("merge-conflict-manager", () => {
  it("目录分组开启时应按 section 与目录输出表格行", () => {
    const rows = buildMergeConflictTableRows({
      snapshot: createSnapshot(),
      groupByDirectory: true,
      showResolved: true,
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "section",
      "node",
      "node",
      "node",
      "node",
      "section",
      "node",
      "node",
    ]);
    const directoryRows = rows.filter((row): row is Extract<typeof rows[number], { kind: "node" }> => row.kind === "node" && !row.node.isFile);
    expect(directoryRows.map((row) => row.node.name)).toEqual(["docs", "src", "src"]);
    expect(rows[5]).toMatchObject({ kind: "section", label: "已解决冲突" });
  });

  it("应能定位选中文件对应的目录祖先节点", () => {
    const snapshot = createSnapshot();
    snapshot.unresolvedEntries = [
      {
        ...snapshot.unresolvedEntries[0],
        path: "src/components/a.ts",
        directoryPath: "src/components",
      },
    ];
    snapshot.entries = [...snapshot.unresolvedEntries, ...snapshot.resolvedEntries];
    snapshot.unresolvedCount = snapshot.unresolvedEntries.length;

    const keys = findMergeConflictAncestorNodeKeys({
      snapshot,
      selectedPath: "src/components/a.ts",
      showResolved: true,
    });

    expect(keys).toEqual([
      expect.stringContaining("src/components"),
    ]);
  });

  it("批量采用动作应优先使用 checked unresolved 路径，并过滤 resolved 项", () => {
    const paths = resolveEffectiveMergeConflictPaths({
      snapshot: createSnapshot(),
      selectedPath: "src/resolved.ts",
      checkedPaths: ["src/a.ts", "src/resolved.ts"],
    });

    expect(paths).toEqual(["src/a.ts"]);
  });

  it("打开/合并主动作与自动关闭逻辑应基于 session 快照计算", () => {
    const snapshot = createSnapshot();
    expect(resolveMergeConflictPrimaryAction(snapshot.unresolvedEntries[0])).toEqual({
      kind: "merge",
      label: "合并…",
      enabled: true,
    });
    expect(resolveMergeConflictPrimaryAction(snapshot.resolvedEntries[0])).toEqual({
      kind: "open",
      label: "打开",
      enabled: true,
    });
    expect(shouldAutoCloseMergeConflictDialog(snapshot, true)).toBe(false);
    expect(shouldAutoCloseMergeConflictDialog({
      ...snapshot,
      unresolvedCount: 0,
      unresolvedEntries: [],
      entries: [...snapshot.resolvedEntries],
    }, true)).toBe(true);
  });

  it("关闭 resolver 时若仍有 unresolved，应生成与操作态一致的提示语义", () => {
    const snapshot = createSnapshot();
    expect(shouldNotifyRemainingMergeConflicts(snapshot)).toBe(true);
    expect(buildRemainingMergeConflictNoticeMessage("merging")).toBe("仍有未解决冲突，请继续处理后再继续当前 Git 操作。");
    expect(buildRemainingMergeConflictNoticeMessage("")).toBe("仍有未解决冲突，可稍后重新打开冲突处理器继续完成。");
    expect(shouldNotifyRemainingMergeConflicts({
      ...snapshot,
      unresolvedCount: 0,
      unresolvedEntries: [],
      entries: [...snapshot.resolvedEntries],
    })).toBe(false);
  });

  it("隐藏 resolved 后应自动把选区回退到 unresolved 条目", () => {
    const selection = sanitizeMergeConflictSelection({
      snapshot: createSnapshot(),
      selectedPath: "src/resolved.ts",
      checkedPaths: ["src/a.ts", "src/resolved.ts"],
      showResolved: false,
    });

    expect(selection.selectedPath).toBe("src/a.ts");
    expect(selection.checkedPaths).toEqual(["src/a.ts"]);
  });

  it("最后一个 unresolved 被处理后，即使 showResolved 仍关闭也应继续展示 resolved 条目", () => {
    const snapshot = createSnapshot();
    snapshot.unresolvedEntries = [];
    snapshot.unresolvedCount = 0;
    snapshot.entries = [...snapshot.resolvedEntries];

    const rows = buildMergeConflictTableRows({
      snapshot,
      groupByDirectory: false,
      showResolved: false,
    });
    const selection = sanitizeMergeConflictSelection({
      snapshot,
      selectedPath: "",
      checkedPaths: [],
      showResolved: false,
    });

    expect(rows).toContainEqual(expect.objectContaining({
      kind: "section",
      label: "已解决冲突",
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      kind: "node",
      entry: expect.objectContaining({ path: "src/resolved.ts", conflictState: "resolved" }),
    }));
    expect(selection.selectedPath).toBe("src/resolved.ts");
  });
});
