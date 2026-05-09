import { describe, expect, it } from "vitest";
import { buildBranchPanelRows, buildBranchPopupRows, resolveSelectedBranchPopupRepository } from "./tree-model";
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
          local: [{ name: "main", favorite: true, current: true, secondaryText: "origin/main" }],
          remote: [{ name: "origin/main" }],
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
});
