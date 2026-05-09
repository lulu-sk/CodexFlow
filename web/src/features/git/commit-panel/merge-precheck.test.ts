import { describe, expect, it } from "vitest";
import { resolveMergeExclusionPrecheck } from "./merge-precheck";

describe("merge precheck", () => {
  it("merge 中若同仓仍有 tracked changes 未纳入本次提交，应要求确认", () => {
    const result = resolveMergeExclusionPrecheck({
      fallbackRepoRoot: "/repo",
      status: {
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
        operationState: "merging",
        entries: [
          { path: "selected.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default" },
          { path: "left.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default" },
        ],
        ignoredEntries: [],
        viewOptions: {
          groupByDirectory: true,
          showIgnored: false,
          detailsPreviewShown: true,
          diffPreviewOnDoubleClickOrEnter: true,
          manyFilesThreshold: 500,
        },
        localChanges: {
          stagingAreaEnabled: true,
          changeListsEnabled: false,
        },
        changeLists: {
          activeListId: "default",
          lists: [],
        },
      },
      payload: {
        selections: [{
          repoRoot: "/repo",
          changeListId: "default",
          path: "selected.txt",
          kind: "change",
          selectionMode: "full-file",
        }],
      },
    });

    expect(result.requiresConfirmation).toBe(true);
    expect(result.excludedEntries.map((entry) => entry.path)).toEqual(["left.txt"]);
  });

  it("非 merge 或未排除 tracked changes 时不应要求确认", () => {
    const result = resolveMergeExclusionPrecheck({
      fallbackRepoRoot: "/repo",
      status: {
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
        operationState: "normal",
        entries: [
          { path: "selected.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default" },
        ],
        ignoredEntries: [],
        viewOptions: {
          groupByDirectory: true,
          showIgnored: false,
          detailsPreviewShown: true,
          diffPreviewOnDoubleClickOrEnter: true,
          manyFilesThreshold: 500,
        },
        localChanges: {
          stagingAreaEnabled: true,
          changeListsEnabled: false,
        },
        changeLists: {
          activeListId: "default",
          lists: [],
        },
      },
      payload: {
        selections: [{
          repoRoot: "/repo",
          changeListId: "default",
          path: "selected.txt",
          kind: "change",
          selectionMode: "full-file",
        }],
      },
    });

    expect(result.requiresConfirmation).toBe(false);
    expect(result.excludedEntries).toEqual([]);
  });
});
