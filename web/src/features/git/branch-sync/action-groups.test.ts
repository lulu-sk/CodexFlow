import { describe, expect, it } from "vitest";
import { buildBranchPopupActionGroups } from "./action-groups";
import { buildBranchPopupWarningPresentation } from "./presentation";
import { buildBranchPopupRows, createDefaultBranchPopupGroupOpen } from "./tree-model";
import type { GitBranchPopupSnapshot } from "../types";

function createSnapshot(): GitBranchPopupSnapshot {
  return {
    selectedRepoRoot: "/workspace/root",
    multiRoot: false,
    currentBranch: "main",
    detached: false,
    syncEnabled: true,
    showOnlyMy: false,
    currentBranchSync: {
      upstream: "origin/main",
      incoming: 1,
      outgoing: 1,
      hasUnfetched: false,
      status: "diverged",
    },
    remotes: [],
    dataContext: {
      selectedRepoRoot: "/workspace/root",
      affectedRepoRoots: ["/workspace/root"],
    },
    quickActions: [
      { id: "update", label: "更新项目" },
      { id: "configureRemotes", label: "配置远端..." },
    ],
    repositories: [{
      repoRoot: "/workspace/root",
      rootName: "root",
      kind: "repository",
      currentBranch: "main",
      detached: false,
      syncEnabled: true,
      showOnlyMy: false,
      currentBranchSync: {
        upstream: "origin/main",
        incoming: 1,
        outgoing: 1,
        hasUnfetched: false,
        status: "diverged",
      },
      remotes: [],
      groups: {
        favorites: [{ name: "main", favorite: true, current: true }],
        recent: [{ name: "feature/recent" }],
        local: [{ name: "main", favorite: true, current: true }],
        remote: [{ name: "origin/main" }],
      },
    }],
    groups: {
      favorites: [{ name: "main", favorite: true, current: true }],
      recent: [{ name: "feature/recent" }],
      local: [{ name: "main", favorite: true, current: true }],
      remote: [{ name: "origin/main" }],
    },
  };
}

describe("branch popup action groups", () => {
  it("应把 header 与 quick actions 收敛到共享 action schema", () => {
    const groups = buildBranchPopupActionGroups(createSnapshot(), (key, fallback) => {
      const map: Record<string, string> = {
        "workbench.branches.popup.header.fetch": "获取",
        "workbench.branches.popup.header.syncStatus": "同步状态",
        "workbench.branches.popup.header.myBranchesOnly": "只看我的分支",
        "workbench.topToolbar.updateProject": "更新项目",
        "workbench.branches.context.configureRemotes": "配置远端...",
      };
      return map[key] || fallback;
    });

    expect(groups).toEqual([
      {
        id: "header",
        items: [
          { id: "fetch", label: "获取" },
          { id: "toggleSyncEnabled", label: "同步状态", checked: true },
          { id: "toggleShowOnlyMy", label: "只看我的分支", checked: false },
        ],
      },
      {
        id: "quick",
        items: [
          { id: "update", label: "更新项目", shortcut: undefined },
          { id: "configureRemotes", label: "配置远端...", shortcut: undefined },
        ],
      },
    ]);
  });

  it("diverged 时应生成 warning，且 popup group 可按 state 折叠", () => {
    const snapshot = createSnapshot();
    const rows = buildBranchPopupRows({
      snapshot,
      selectedRepoRoot: snapshot.selectedRepoRoot,
      step: "branches",
      groupOpen: {
        ...createDefaultBranchPopupGroupOpen(),
        local: false,
      },
    });

    expect(buildBranchPopupWarningPresentation(snapshot.currentBranchSync)).toEqual({
      visible: true,
      text: "当前分支与上游已分叉，请先查看 incoming / outgoing 变化后再执行签出或更新。",
    });
    expect(rows.some((row) => row.kind === "group" && row.key === "group:local")).toBe(true);
    expect(rows.some((row) => row.kind === "branch" && row.section === "local")).toBe(false);
  });
});
