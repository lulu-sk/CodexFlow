// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitBranchPopupSnapshot, GitLogItem } from "../types";
import {
  buildFileHistoryGraphCells,
  buildLogGraphCells,
  type GitGraphCell,
} from "./model";
import { resolveLogGraphWidth } from "./metrics";

export type GitLogVisiblePack = {
  items: GitLogItem[];
  graphCells: GitGraphCell[];
  maxLane: number;
  graphColumnWidth: number;
};

export type GitLogBranchesDashboardSelectionAction = "filter" | "navigate";

export type GitLogBranchesDashboardGrouping = "directory" | "repository";

export type GitLogBranchesDashboardState = {
  visible: boolean;
  selectionAction: GitLogBranchesDashboardSelectionAction;
  grouping: GitLogBranchesDashboardGrouping;
};

export type GitLogBranchesDashboard = {
  visible: boolean;
  selectionAction: GitLogBranchesDashboardSelectionAction;
  grouping: GitLogBranchesDashboardGrouping;
  selectedRepoRoot: string;
  currentBranch: string;
  multiRoot: boolean;
  repositories: Array<{
    repoRoot: string;
    rootName: string;
    kind: "repository" | "submodule";
    currentBranch: string;
    detached: boolean;
    directoryKey: string;
    directoryLabel: string;
  }>;
  groups: Array<{
    key: string;
    label: string;
    repositories: Array<{
      repoRoot: string;
      rootName: string;
      kind: "repository" | "submodule";
      currentBranch: string;
      detached: boolean;
      directoryKey: string;
      directoryLabel: string;
    }>;
  }>;
};

const GIT_LOG_BRANCHES_DASHBOARD_STORAGE_KEY = "cf.gitWorkbench.logBranchesDashboard.v1";

/**
 * 构建日志分支 dashboard 默认设置，首次进入默认不显示概览，但仍保留“选择即筛选”作为默认交互语义。
 */
export function createDefaultGitLogBranchesDashboardState(): GitLogBranchesDashboardState {
  return {
    visible: false,
    selectionAction: "filter",
    grouping: "repository",
  };
}

/**
 * 规范化日志分支 dashboard 设置，兜底非法值并兼容旧缓存缺字段场景；缺省显示态回落到默认设置。
 */
export function normalizeGitLogBranchesDashboardState(
  raw: Partial<GitLogBranchesDashboardState> | null | undefined,
): GitLogBranchesDashboardState {
  const fallback = createDefaultGitLogBranchesDashboardState();
  return {
    visible: raw?.visible === true ? true : fallback.visible,
    selectionAction: raw?.selectionAction === "navigate" ? "navigate" : fallback.selectionAction,
    grouping: raw?.grouping === "directory" ? "directory" : fallback.grouping,
  };
}

/**
 * 读取日志分支 dashboard 本地缓存，失败时静默回退到默认设置。
 */
export function loadGitLogBranchesDashboardState(): GitLogBranchesDashboardState {
  if (typeof window === "undefined") return createDefaultGitLogBranchesDashboardState();
  try {
    const raw = window.localStorage.getItem(GIT_LOG_BRANCHES_DASHBOARD_STORAGE_KEY);
    if (!raw) return createDefaultGitLogBranchesDashboardState();
    return normalizeGitLogBranchesDashboardState(JSON.parse(raw || "{}") as Partial<GitLogBranchesDashboardState>);
  } catch {
    return createDefaultGitLogBranchesDashboardState();
  }
}

/**
 * 持久化日志分支 dashboard 设置；写失败时忽略，避免影响主流程。
 */
export function saveGitLogBranchesDashboardState(state: GitLogBranchesDashboardState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      GIT_LOG_BRANCHES_DASHBOARD_STORAGE_KEY,
      JSON.stringify(normalizeGitLogBranchesDashboardState(state)),
    );
  } catch {
    // 忽略缓存写入失败
  }
}

/**
 * 规范化仓库根路径，统一目录分组与 selectedRepoRoot 命中逻辑。
 */
function normalizeDashboardRepoRoot(repoRoot: string): string {
  return String(repoRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 按路径片段提取目录分组标签，多级路径保留末两段，根仓则回退到仓库名。
 */
function resolveDashboardDirectoryInfo(repoRoot: string, rootName: string): { directoryKey: string; directoryLabel: string } {
  const normalizedRepoRoot = normalizeDashboardRepoRoot(repoRoot);
  const parts = normalizedRepoRoot.split("/").filter(Boolean);
  if (parts.length <= 1) {
    const fallback = String(rootName || normalizedRepoRoot || "仓库").trim() || "仓库";
    return {
      directoryKey: `directory:${fallback}`,
      directoryLabel: fallback,
    };
  }
  const parentParts = parts.slice(0, -1);
  const label = parentParts.slice(-2).join("/") || parentParts[parentParts.length - 1] || String(rootName || "仓库").trim() || "仓库";
  return {
    directoryKey: `directory:${parentParts.join("/") || label}`,
    directoryLabel: label,
  };
}

/**
 * 在运行时输出 Git 图谱构建摘要；若命中用户反馈的 wt7 截图序列，再追加详细行级数据。
 * 该探针只在 Electron renderer 的真实宿主环境中生效，用于先确认当前界面到底画的是哪一份日志，再核对 `laneCells[index]`。
 */
function emitGitLogGraphRuntimeProbe(
  items: GitLogItem[],
  graphItems: GitLogItem[],
  graphCells: GitGraphCell[],
  fileHistoryMode: boolean,
): void {
  if (typeof window === "undefined" || !(window as any)?.host) return;
  const runtime = globalThis as typeof globalThis & {
    __cfGitLogGraphRuntimeProbeSummaryKeys__?: Record<string, boolean>;
    __cfGitLogGraphRuntimeProbeDone__?: boolean;
  };
  const summaryKey = [
    fileHistoryMode ? "file-history" : "log",
    String(items.length),
    String(graphItems.length),
    items.slice(0, 3).map((item) => String(item.subject || "").trim()).join(" | "),
  ].join("::");
  if (!runtime.__cfGitLogGraphRuntimeProbeSummaryKeys__)
    runtime.__cfGitLogGraphRuntimeProbeSummaryKeys__ = {};
  if (!runtime.__cfGitLogGraphRuntimeProbeSummaryKeys__[summaryKey]) {
    runtime.__cfGitLogGraphRuntimeProbeSummaryKeys__[summaryKey] = true;
    console.log("[git-graph-runtime-probe-summary]", JSON.stringify({
      fileHistoryMode,
      itemsCount: items.length,
      graphItemsCount: graphItems.length,
      firstSubjects: items.slice(0, 8).map((item) => String(item.subject || "")),
    }));
  }
  const fixIndex = items.findIndex((item) => String(item.subject || "").includes("fix(worktree)"));
  const renderErrorIndex = items.findIndex((item) => String(item.subject || "").includes("渲染出错"));
  const capabilityIndex = items.findIndex((item) => String(item.subject || "").includes("三者可用性"));
  if (runtime.__cfGitLogGraphRuntimeProbeDone__ === true) return;
  if (fixIndex < 0 || renderErrorIndex < 0 || capabilityIndex < 0) return;

  runtime.__cfGitLogGraphRuntimeProbeDone__ = true;
  const start = Math.max(0, fixIndex - 4);
  const end = Math.min(items.length, capabilityIndex + 3);
  const rows = items.slice(start, end).map((item, offset) => {
    const rowIndex = start + offset;
    const cell = graphCells[rowIndex];
    return {
      rowIndex,
      hash: String(item.hash || "").slice(0, 8),
      subject: String(item.subject || ""),
      decorations: String(item.decorations || ""),
      lane: cell?.lane,
      incomingFromLane: cell?.incomingFromLane ?? null,
      incomingFromLanes: cell?.incomingFromLanes || [],
      tracks: (cell?.tracks || []).map((track) => ({
        lane: track.lane,
        incomingFromLanes: track.incomingFromLanes,
        outgoingToLane: track.outgoingToLane,
        sourceLane: track.sourceLane,
        targetLane: track.targetLane,
        hash: String(track.hash || "").slice(0, 8),
      })),
      edges: (cell?.edges || []).map((edge) => ({
        from: edge.from,
        to: edge.to,
        sourceLane: edge.sourceLane,
        targetLane: edge.targetLane,
        targetHash: String(edge.targetHash || "").slice(0, 8),
      })),
    };
  });
  console.log("[git-graph-runtime-probe]", JSON.stringify({
    start,
    end,
    fixIndex,
    renderErrorIndex,
    capabilityIndex,
    rows,
  }));
}

/**
 * 把当前日志可见列表压成稳定的 visible pack 边界，便于后续替换为 permanent graph / VisiblePack 时只换数据源。
 */
export function buildGitLogVisiblePack(args: {
  items: GitLogItem[];
  graphItems?: GitLogItem[];
  fileHistoryMode: boolean;
}): GitLogVisiblePack {
  const items = Array.isArray(args.items) ? args.items : [];
  const graphItems = Array.isArray(args.graphItems) ? args.graphItems : items;
  const graphCells = args.fileHistoryMode ? buildFileHistoryGraphCells(items) : buildLogGraphCells(items, graphItems);
  emitGitLogGraphRuntimeProbe(items, graphItems, graphCells, args.fileHistoryMode);
  let maxLane = 1;
  for (const cell of graphCells) {
    const lane = Number(cell?.maxLane ?? 0);
    if (!Number.isFinite(lane)) continue;
    if (lane > maxLane) maxLane = lane;
  }
  return {
    items,
    graphCells,
    maxLane,
    graphColumnWidth: resolveLogGraphWidth(maxLane),
  };
}

/**
 * 从 branch popup 快照提炼日志分支 dashboard 所需的最小上下文，避免日志侧直接耦合 popup 原始结构。
 */
export function buildGitLogBranchesDashboard(
  snapshot?: GitBranchPopupSnapshot | null,
  state?: GitLogBranchesDashboardState | null,
): GitLogBranchesDashboard {
  const normalizedState = normalizeGitLogBranchesDashboardState(state);
  const repositories = Array.isArray(snapshot?.repositories)
    ? snapshot!.repositories.map((item) => ({
        repoRoot: normalizeDashboardRepoRoot(item.repoRoot),
        rootName: item.rootName,
        kind: item.kind,
        currentBranch: item.currentBranch,
        detached: item.detached,
        ...resolveDashboardDirectoryInfo(item.repoRoot, item.rootName),
      }))
    : [];
  const selectedRepoRoot = normalizeDashboardRepoRoot(String(snapshot?.selectedRepoRoot || ""));
  const selectedRepository = repositories.find((item) => item.repoRoot === selectedRepoRoot) || repositories[0];
  const sortedRepositories = [...repositories].sort((left, right) => {
    if (normalizedState.grouping === "directory") {
      return left.directoryLabel.localeCompare(right.directoryLabel) || left.rootName.localeCompare(right.rootName);
    }
    return left.rootName.localeCompare(right.rootName) || left.repoRoot.localeCompare(right.repoRoot);
  });
  const groupsMap = new Map<string, GitLogBranchesDashboard["groups"][number]>();
  for (const repository of sortedRepositories) {
    const groupKey = normalizedState.grouping === "directory"
      ? repository.directoryKey
      : `repository:${repository.repoRoot}`;
    const groupLabel = normalizedState.grouping === "directory"
      ? repository.directoryLabel
      : repository.rootName;
    const group = groupsMap.get(groupKey) || {
      key: groupKey,
      label: groupLabel,
      repositories: [],
    };
    group.repositories.push(repository);
    groupsMap.set(groupKey, group);
  }
  return {
    ...normalizedState,
    selectedRepoRoot: selectedRepoRoot || selectedRepository?.repoRoot || "",
    currentBranch: selectedRepository?.currentBranch || String(snapshot?.currentBranch || "").trim(),
    multiRoot: snapshot?.multiRoot === true,
    repositories: sortedRepositories,
    groups: Array.from(groupsMap.values()),
  };
}
