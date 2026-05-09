import { describe, expect, it } from "vitest";
import {
  applyMovedPathsToStatusSnapshot,
  buildChangeListSelectOptions,
  buildMoveEntryStatePayload,
  resolveDisplayChangeListName,
  resolveMoveDialogLists,
} from "./changelist-ui";
import type { GitStatusEntry, GitStatusSnapshot } from "./types";

/**
 * 创建最小化的状态条目夹具，避免重复书写冗长字段。
 */
function createStatusEntry(input: Partial<GitStatusEntry> & Pick<GitStatusEntry, "path" | "changeListId">): GitStatusEntry {
  return {
    path: input.path,
    x: input.x || "M",
    y: input.y || ".",
    staged: input.staged === true,
    unstaged: input.unstaged !== false,
    untracked: input.untracked === true,
    ignored: input.ignored === true,
    renamed: input.renamed === true,
    deleted: input.deleted === true,
    statusText: input.statusText || "已修改",
    changeListId: input.changeListId,
  };
}

/**
 * 创建最小化的 Git 状态快照，便于验证 changelist UI 辅助逻辑。
 */
function createStatusSnapshot(): GitStatusSnapshot {
  return {
    repoRoot: "/repo",
    detached: false,
    commitAndPush: {
      previewOnCommitAndPush: true,
      previewProtectedOnly: false,
      protectedBranchPatterns: ["main"],
    },
    commitHooks: {
      available: false,
      availableRepoRoots: [],
      disabledByPolicy: false,
      runByDefault: true,
    },
    entries: [
      createStatusEntry({ path: "src/a.ts", changeListId: "feature" }),
      createStatusEntry({ path: "src/b.ts", changeListId: "feature" }),
      createStatusEntry({ path: "src/c.ts", changeListId: "default" }),
    ],
    ignoredEntries: [],
    viewOptions: {
      groupByDirectory: true,
      groupingKeys: ["directory"],
      availableGroupingKeys: ["directory"],
      showIgnored: false,
      detailsPreviewShown: true,
      diffPreviewOnDoubleClickOrEnter: true,
      manyFilesThreshold: 1000,
    },
    localChanges: {
      stagingAreaEnabled: false,
      changeListsEnabled: true,
    },
    changeLists: {
      activeListId: "default",
      lists: [
        { id: "default", name: "default", fileCount: 1, files: ["src/c.ts"] },
        { id: "feature", name: "功能开发", fileCount: 2, files: ["src/a.ts", "src/b.ts"] },
      ],
    },
  };
}

describe("changelist ui helpers", () => {
  it("默认列表显示名应兼容历史英文名并输出本地化标签", () => {
    expect(resolveDisplayChangeListName({ id: "default", name: "default" })).toBe("默认");
    expect(buildChangeListSelectOptions([
      { id: "default", name: "default", fileCount: 0, files: [] },
      { id: "feature", name: "功能开发", fileCount: 0, files: [] },
    ])).toEqual([
      { value: "default", label: "默认" },
      { value: "feature", label: "功能开发" },
    ]);
  });

  it("移动对话框在单一来源列表时应优先排除当前列表", () => {
    const lists = [
      { id: "default", name: "default", fileCount: 1, files: ["src/c.ts"] },
      { id: "feature", name: "功能开发", fileCount: 2, files: ["src/a.ts", "src/b.ts"] },
    ];
    const selectedEntries = [
      createStatusEntry({ path: "src/a.ts", changeListId: "feature" }),
      createStatusEntry({ path: "src/b.ts", changeListId: "feature" }),
    ];
    expect(resolveMoveDialogLists(lists, selectedEntries).map((item) => item.id)).toEqual(["default"]);
  });

  it("移动条目状态载荷与前端快照补丁应只覆盖目标路径", () => {
    const snapshot = createStatusSnapshot();
    const entryMap = new Map<string, GitStatusEntry>(snapshot.entries.map((entry) => [entry.path, entry] as const));
    expect(buildMoveEntryStatePayload(["src/a.ts", "src/c.ts"], entryMap)).toEqual([
      { path: "src/a.ts", untracked: false, ignored: false },
      { path: "src/c.ts", untracked: false, ignored: false },
    ]);

    const moved = applyMovedPathsToStatusSnapshot(snapshot, ["src/a.ts"], "default");
    expect(moved.entries.find((entry) => entry.path === "src/a.ts")?.changeListId).toBe("default");
    expect(moved.entries.find((entry) => entry.path === "src/b.ts")?.changeListId).toBe("feature");
    expect(moved.changeLists.lists.find((list) => list.id === "default")?.files).toEqual(["src/c.ts", "src/a.ts"]);
    expect(moved.changeLists.lists.find((list) => list.id === "feature")?.files).toEqual(["src/b.ts"]);
  });
});
