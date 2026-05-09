import { describe, expect, it } from "vitest";
import {
  buildGitLogBranchesDashboard,
  buildGitLogVisiblePack,
  createDefaultGitLogBranchesDashboardState,
  loadGitLogBranchesDashboardState,
  normalizeGitLogBranchesDashboardState,
  saveGitLogBranchesDashboardState,
} from "./visible-pack";
import { resolveLogGraphWidth } from "./metrics";
import type { GitBranchPopupSnapshot, GitLogItem } from "../types";

/**
 * 构造最小日志项夹具，避免测试关注点被无关字段淹没。
 */
function createLogItem(input: Partial<GitLogItem> & Pick<GitLogItem, "hash" | "parents">): GitLogItem {
  return {
    hash: input.hash,
    shortHash: input.hash.slice(0, 8),
    parents: input.parents,
    authorName: "CodexFlow",
    authorEmail: "codexflow@example.com",
    authorDate: "2026-03-20T00:00:00.000Z",
    subject: input.subject || input.hash,
    decorations: input.decorations || "",
    containedInCurrentBranch: input.containedInCurrentBranch,
  };
}

/**
 * 构造最小分支快照夹具，验证日志 dashboard 的上下文收敛边界。
 */
function createBranchPopupSnapshot(): GitBranchPopupSnapshot {
  return {
    selectedRepoRoot: "/workspace/root/modules/lib",
    multiRoot: true,
    currentBranch: "release",
    detached: false,
    syncEnabled: true,
    remotes: [],
    repositories: [
      {
        repoRoot: "/workspace/root",
        rootName: "root",
        kind: "repository",
        currentBranch: "main",
        detached: false,
        syncEnabled: true,
        remotes: [],
        groups: {
          favorites: [],
          recent: [],
          local: [],
          remote: [],
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
          recent: [],
          local: [],
          remote: [],
        },
      },
    ],
    dataContext: {
      selectedRepoRoot: "/workspace/root/modules/lib",
      affectedRepoRoots: ["/workspace/root", "/workspace/root/modules/lib"],
    },
    quickActions: [],
    groups: {
      favorites: [],
      recent: [],
      local: [],
      remote: [],
    },
  };
}

describe("git log visible pack", () => {
  it("普通日志模式应复用 graph 计算结果并给出稳定列宽", () => {
    const pack = buildGitLogVisiblePack({
      items: [
        createLogItem({ hash: "head", parents: ["base"], decorations: "HEAD -> main, origin/main" }),
        createLogItem({ hash: "base", parents: [] }),
      ],
      fileHistoryMode: false,
    });

    expect(pack.items).toHaveLength(2);
    expect(pack.graphCells).toHaveLength(2);
    expect(pack.maxLane).toBeGreaterThanOrEqual(1);
    expect(pack.graphColumnWidth).toBeGreaterThan(0);
  });

  it("文件历史模式应退化为单轨 visible pack", () => {
    const pack = buildGitLogVisiblePack({
      items: [
        createLogItem({ hash: "head", parents: ["prev"], decorations: "HEAD -> main, origin/main" }),
        createLogItem({ hash: "prev", parents: [] }),
      ],
      fileHistoryMode: true,
    });

    expect(pack.graphCells.every((cell) => cell.lane === 0)).toBe(true);
    expect(pack.maxLane).toBe(1);
  });

  it("搜索后的稀疏结果应保持紧凑图谱列，不能挤压提交信息", () => {
    const pack = buildGitLogVisiblePack({
      items: [
        createLogItem({ hash: "merge-hit", parents: ["main-hidden", "feature-hidden"], decorations: "HEAD -> main, origin/main" }),
        createLogItem({ hash: "fix-hit", parents: ["fix-hidden"] }),
        createLogItem({ hash: "search-hit", parents: ["search-hidden"] }),
      ],
      fileHistoryMode: false,
    });

    expect(pack.graphColumnWidth).toBeCloseTo(resolveLogGraphWidth(0), 4);
    expect(pack.graphCells[1]?.maxLane).toBe(0);
    expect(pack.graphCells[2]?.maxLane).toBe(0);
  });

  it("带图谱上下文行时应保留隐藏提交撑起的主干连线", () => {
    const visibleItems = [
      createLogItem({ hash: "head-visible", parents: ["mid-hidden"], decorations: "HEAD -> main, origin/main" }),
      createLogItem({ hash: "base-visible", parents: [] }),
    ];
    const pack = buildGitLogVisiblePack({
      items: visibleItems,
      graphItems: [
        visibleItems[0]!,
        createLogItem({ hash: "mid-hidden", parents: ["base-visible"] }),
        visibleItems[1]!,
      ],
      fileHistoryMode: false,
    });

    expect(pack.graphCells).toHaveLength(2);
    expect(pack.graphCells[0]?.edges).toEqual([
      expect.objectContaining({ from: 0, to: 0, style: "solid" }),
    ]);
    expect(pack.graphCells[1]?.incomingFromLane).toBe(0);
  });

  it("branches dashboard 应只暴露日志真正需要的最小仓库上下文", () => {
    const dashboard = buildGitLogBranchesDashboard(createBranchPopupSnapshot());

    expect(dashboard.selectedRepoRoot).toBe("/workspace/root/modules/lib");
    expect(dashboard.currentBranch).toBe("release");
    expect(dashboard.multiRoot).toBe(true);
    expect(dashboard.repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({ repoRoot: "/workspace/root", rootName: "root", kind: "repository" }),
      expect.objectContaining({ repoRoot: "/workspace/root/modules/lib", rootName: "lib", kind: "submodule" }),
    ]));
  });

  it("branches dashboard 应支持按目录分组并保留选择行为设置", () => {
    const dashboard = buildGitLogBranchesDashboard(createBranchPopupSnapshot(), {
      visible: true,
      selectionAction: "navigate",
      grouping: "directory",
    });

    expect(dashboard.selectionAction).toBe("navigate");
    expect(dashboard.grouping).toBe("directory");
    expect(dashboard.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "root/modules",
        repositories: [
          expect.objectContaining({ repoRoot: "/workspace/root/modules/lib", rootName: "lib" }),
        ],
      }),
      expect.objectContaining({
        label: "workspace",
        repositories: [
          expect.objectContaining({ repoRoot: "/workspace/root", rootName: "root" }),
        ],
      }),
    ]));
  });

  it("branches dashboard 设置应能归一化并安全读写本地缓存", () => {
    const storage = new Map<string, string>();
    const windowStub = {
      localStorage: {
        getItem(key: string) {
          return storage.has(key) ? storage.get(key)! : null;
        },
        setItem(key: string, value: string) {
          storage.set(key, value);
        },
      },
    };
    const runtime = globalThis as any;
    const previousWindow = runtime.window;
    runtime.window = windowStub;
    try {
      expect(createDefaultGitLogBranchesDashboardState()).toEqual({
        visible: false,
        selectionAction: "filter",
        grouping: "repository",
      });
      expect(normalizeGitLogBranchesDashboardState({ visible: false, selectionAction: "navigate", grouping: "directory" })).toEqual({
        visible: false,
        selectionAction: "navigate",
        grouping: "directory",
      });
      expect(normalizeGitLogBranchesDashboardState({ selectionAction: "navigate" })).toEqual({
        visible: false,
        selectionAction: "navigate",
        grouping: "repository",
      });
      expect(loadGitLogBranchesDashboardState()).toEqual(createDefaultGitLogBranchesDashboardState());
      saveGitLogBranchesDashboardState({ visible: false, selectionAction: "navigate", grouping: "directory" });
      expect(loadGitLogBranchesDashboardState()).toEqual({
        visible: false,
        selectionAction: "navigate",
        grouping: "directory",
      });
    } finally {
      runtime.window = previousWindow;
    }
  });
});
