import { describe, expect, it } from "vitest";
import {
  buildOperationProblemRollbackEntries,
  buildRollbackBrowserActionGroups,
  buildRollbackBrowserEntriesFromStatusEntries,
  buildRollbackBrowserRows,
  buildRollbackBrowserSummary,
  groupRollbackBrowserEntries,
} from "./rollback-browser-model";
import type { GitStatusEntry } from "./types";

const STATUS_ENTRIES: GitStatusEntry[] = [
  {
    path: "src/app.ts",
    x: "M",
    y: ".",
    staged: true,
    unstaged: false,
    untracked: false,
    ignored: false,
    renamed: false,
    deleted: false,
    statusText: "已暂存修改",
    changeListId: "default",
  },
  {
    path: "src/renamed.ts",
    oldPath: "src/old.ts",
    x: "R",
    y: ".",
    staged: true,
    unstaged: false,
    untracked: false,
    ignored: false,
    renamed: true,
    deleted: false,
    statusText: "已暂存重命名",
    changeListId: "default",
  },
];

describe("rollback-browser-model", () => {
  it("operation problem 在缺少状态快照时应回退为 path-only 候选", () => {
    const entries = buildOperationProblemRollbackEntries([
      "src/app.ts",
      "src/missing.ts",
    ], STATUS_ENTRIES);

    expect(entries).toEqual([
      expect.objectContaining({
        path: "src/app.ts",
        matchSource: "status",
      }),
      expect.objectContaining({
        path: "src/missing.ts",
        matchSource: "path-only",
        statusText: "按路径匹配的本地更改",
      }),
    ]);
  });

  it("应按修改/重命名/path-only 分组并输出摘要", () => {
    const entries = buildOperationProblemRollbackEntries([
      "src/app.ts",
      "src/old.ts",
      "src/missing.ts",
    ], STATUS_ENTRIES);
    const groups = groupRollbackBrowserEntries(entries);
    const summary = buildRollbackBrowserSummary(entries);

    expect(groups.map((group) => group.key)).toEqual(["modified", "renamed", "path-only"]);
    expect(summary).toEqual({
      modified: 1,
      renamed: 1,
      deleted: 0,
      pathOnly: 1,
    });
  });

  it("扁平模式应按 IDEA 风格优先使用文件名排序", () => {
    const entries = buildRollbackBrowserEntriesFromStatusEntries([
      {
        path: "web/src/zeta.ts",
        x: "M",
        y: ".",
        staged: true,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
        statusText: "已暂存修改",
        changeListId: "default",
      },
      {
        path: "web/src/alpha.ts",
        x: "M",
        y: ".",
        staged: true,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
        statusText: "已暂存修改",
        changeListId: "default",
      },
      {
        path: "docs/beta.ts",
        x: "M",
        y: ".",
        staged: true,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
        statusText: "已暂存修改",
        changeListId: "default",
      },
    ]);

    const rows = buildRollbackBrowserRows(entries, [], {});

    expect(rows.map((row) => row.kind === "entry" ? row.entry.path : row.label)).toEqual([
      "web/src/alpha.ts",
      "docs/beta.ts",
      "web/src/zeta.ts",
    ]);
  });

  it("目录分组开启后应输出目录行与子文件行", () => {
    const rows = buildRollbackBrowserRows(buildRollbackBrowserEntriesFromStatusEntries(STATUS_ENTRIES), ["directory"], {});

    expect(rows[0]).toEqual(expect.objectContaining({
      kind: "directory",
      label: "src",
      depth: 0,
    }));
    expect(rows.slice(1).map((row) => row.kind)).toEqual(["entry", "entry"]);
    expect(rows.slice(1).every((row) => row.depth === 1)).toBe(true);
  });

  it("动作分组应按 browser 上下文收敛可见性与 enablement", () => {
    const groups = buildRollbackBrowserActionGroups({
      hasEntries: true,
      hasSelection: false,
      hasActiveEntry: true,
    });

    const allActions = groups.flatMap((group) => group.items);
    expect(allActions.find((action) => action.id === "showDiff")?.enabled).toBe(true);
    expect(allActions.find((action) => action.id === "clearSelection")?.enabled).toBe(false);
  });

  it("手动回滚入口应把普通状态条目规整为 browser 条目", () => {
    const entries = buildRollbackBrowserEntriesFromStatusEntries(STATUS_ENTRIES);

    expect(entries[0]).toEqual(expect.objectContaining({
      path: "src/app.ts",
      matchSource: "status",
      groupKey: "modified",
      directory: "src",
    }));
  });
});
