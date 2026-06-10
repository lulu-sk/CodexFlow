import { describe, expect, it } from "vitest";
import { buildBranchPanelCopyText, buildBranchPanelRows, buildBranchPopupRows, resolveSelectedBranchPopupRepository } from "./tree-model";
import type { GitBranchPopupSnapshot } from "../types";

/**
 * 构造最小分支快照夹具，减少每个测试的样板数据。
 */
function createBranchPopupSnapshot(): GitBranchPopupSnapshot {
  return {
    selectedRepoRoot: "/workspace/root",
    multiRoot: true,
    currentBranch: "main",
    detached: false,
    syncEnabled: true,
    remotes: [],
    currentBranchSync: {
      upstream: "origin/main",
      incoming: 1,
      outgoing: 0,
      hasUnfetched: false,
      status: "incoming",
    },
    dataContext: {
      selectedRepoRoot: "/workspace/root",
      affectedRepoRoots: ["/workspace/root", "/workspace/root/modules/lib"],
    },
    quickActions: [
      { id: "update", label: "更新项目" },
    ],
    repositories: [
      {
        repoRoot: "/workspace/root",
        rootName: "root",
        kind: "repository",
        currentBranch: "main",
        detached: false,
        syncEnabled: true,
        remotes: [],
        currentBranchSync: {
          upstream: "origin/main",
          incoming: 1,
          outgoing: 0,
          hasUnfetched: false,
          status: "incoming",
        },
        groups: {
          favorites: [{ name: "main", favorite: true, current: true, secondaryText: "origin/main" }],
          recent: [{ name: "feature/recent" }],
          local: [
            { name: "main", favorite: true, current: true, secondaryText: "origin/main" },
            { name: "feature/api/refactor" },
          ],
          remote: [
            { name: "origin/main" },
            { name: "origin/feature/api/refactor" },
          ],
        },
      },
      {
        repoRoot: "/workspace/root/modules/lib",
        rootName: "lib",
        kind: "submodule",
        currentBranch: "release",
        detached: false,
        syncEnabled: true,
        remotes: [],
        groups: {
          favorites: [],
          recent: [{ name: "release" }],
          local: [{ name: "release", current: true }],
          remote: [{ name: "origin/release" }],
        },
      },
    ],
    groups: {
      favorites: [{ name: "main", favorite: true, current: true, secondaryText: "origin/main" }],
      recent: [{ name: "feature/recent" }],
      local: [{ name: "main", favorite: true, current: true, secondaryText: "origin/main" }],
      remote: [{ name: "origin/main" }],
    },
  };
}

describe("branch tree model", () => {
  it("多仓首级 step 应输出仓库列表而不是直接展开分支", () => {
    const snapshot = createBranchPopupSnapshot();
    const rows = buildBranchPopupRows({
      snapshot,
      selectedRepoRoot: snapshot.selectedRepoRoot,
      step: "repositories",
    });

    expect(rows[0]).toEqual(expect.objectContaining({ kind: "action", id: "update" }));
    expect(rows.some((row) => row.kind === "repository" && row.rootName === "root")).toBe(true);
    expect(rows.some((row) => row.kind === "branch")).toBe(false);
  });

  it("进入二级 step 后应展示返回入口、收藏、本地与远端分组", () => {
    const snapshot = createBranchPopupSnapshot();
    const rows = buildBranchPopupRows({
      snapshot,
      selectedRepoRoot: snapshot.selectedRepoRoot,
      step: "branches",
      resolveText: (key, fallback) => {
        const map: Record<string, string> = {
          "workbench.topToolbar.updateProject": "更新项目",
          "workbench.branches.common.backToRepositories": "返回仓库列表",
          "workbench.branches.common.groups.favorites": "收藏",
          "workbench.branches.common.groups.recent": "最近",
          "workbench.branches.common.groups.local": "本地",
          "workbench.branches.common.groups.remote": "远端",
        };
        return map[key] || fallback;
      },
    });

    expect(rows.some((row) => row.kind === "back")).toBe(true);
    expect(rows.some((row) => row.kind === "group" && row.label === "收藏")).toBe(true);
    expect(rows.some((row) => row.kind === "branch" && row.section === "favorites" && row.name === "main")).toBe(true);
    expect(rows.some((row) => row.kind === "branch" && row.section === "remote" && row.name === "origin/main")).toBe(true);
  });

  it("分支面板应跟随 selectedRepoRoot 切换到目标仓上下文", () => {
    const snapshot = createBranchPopupSnapshot();
    const selectedRepository = resolveSelectedBranchPopupRepository(snapshot, "/workspace/root/modules/lib");
    const rows = buildBranchPanelRows(snapshot, "/workspace/root/modules/lib", {
      favorites: true,
      local: true,
      remote: true,
    });

    expect(selectedRepository?.rootName).toBe("lib");
    expect(rows.some((row) => row.kind === "branch" && row.repoRoot === "/workspace/root/modules/lib" && row.name === "release")).toBe(true);
    expect(rows.some((row) => row.kind === "branch" && row.repoRoot === "/workspace/root" && row.name === "main")).toBe(false);
  });

  it("分支面板关闭目录分组时应保持分支名平铺显示", () => {
    const snapshot = createBranchPopupSnapshot();
    const rows = buildBranchPanelRows(snapshot, "/workspace/root", {
      favorites: true,
      local: true,
      remote: true,
    });

    expect(rows.some((row) => row.kind === "group" && row.directoryPath === "feature")).toBe(false);
    expect(rows.some((row) => row.kind === "branch" && row.name === "feature/api/refactor" && row.displayName === "feature/api/refactor")).toBe(true);
  });

  it("分支面板开启目录分组后应按斜杠生成目录节点并保留完整动作分支名", () => {
    const snapshot = createBranchPopupSnapshot();
    const rows = buildBranchPanelRows(snapshot, "/workspace/root", {
      favorites: true,
      local: true,
      remote: true,
    }, true);

    expect(rows.some((row) => row.kind === "group" && row.directoryPath === "feature")).toBe(true);
    expect(rows.some((row) => row.kind === "group" && row.directoryPath === "feature/api")).toBe(true);
    expect(rows.some((row) => row.kind === "branch" && row.name === "feature/api/refactor" && row.displayName === "refactor")).toBe(true);
    expect(rows.some((row) => row.kind === "branch" && row.name === "origin/feature/api/refactor" && row.displayName === "refactor")).toBe(true);
  });

  it("分支面板目录分组下应保留完整分支名供 speed search 使用", () => {
    const snapshot = createBranchPopupSnapshot();
    const rows = buildBranchPanelRows(snapshot, "/workspace/root", {
      favorites: true,
      local: true,
      remote: true,
    }, true);
    const branch = rows.find((row) => row.kind === "branch" && row.name === "feature/api/refactor");

    if (!branch || branch.kind !== "branch")
      throw new Error("missing feature branch row");
    expect(branch.displayName).toBe("refactor");
    expect(branch.textPresentation).toBe("feature/api/refactor");
  });

  it("分支面板目录节点收起后应隐藏子目录与子分支", () => {
    const snapshot = createBranchPopupSnapshot();
    const openRows = buildBranchPanelRows(snapshot, "/workspace/root", {
      favorites: true,
      local: true,
      remote: true,
    }, true);
    const featureGroup = openRows.find((row) => row.kind === "group" && row.directoryPath === "feature");
    expect(featureGroup?.kind).toBe("group");

    const rows = buildBranchPanelRows(snapshot, "/workspace/root", {
      favorites: true,
      local: true,
      remote: true,
    }, true, featureGroup ? { [featureGroup.key]: false } : {});

    expect(rows.some((row) => row.kind === "group" && row.directoryPath === "feature/api")).toBe(false);
    expect(rows.some((row) => row.kind === "branch" && row.name === "feature/api/refactor")).toBe(false);
  });

  it("分支面板 copy provider 应复制当前聚焦行的显示文本", () => {
    const snapshot = createBranchPopupSnapshot();
    const rows = buildBranchPanelRows(snapshot, "/workspace/root", {
      favorites: true,
      local: true,
      remote: true,
    }, true);
    const branch = rows.find((row) => row.kind === "branch" && row.name === "feature/api/refactor");
    const group = rows.find((row) => row.kind === "group" && row.directoryPath === "feature/api");

    expect(buildBranchPanelCopyText({ rows, focusedRowKey: branch?.key })).toBe("refactor");
    expect(buildBranchPanelCopyText({ rows, focusedRowKey: group?.key })).toBe("feature/api");
  });
});
