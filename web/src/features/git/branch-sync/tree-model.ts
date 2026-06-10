// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitBranchItem, GitBranchPopupRepository, GitBranchPopupSnapshot } from "../types";
import { resolveBranchPopupQuickActionLabel } from "./branch-popup-i18n";

type GitBranchTextResolver = (key: string, fallback: string, values?: Record<string, unknown>) => string;

export type GitBranchPopupStep = "repositories" | "branches";

export type BranchPopupRow =
  | { kind: "action"; id: string; label: string; shortcut?: string; repoRoot?: string }
  | { kind: "back"; label: string; repoRoot: string }
  | { kind: "group"; key: string; label: string; section: "favorites" | "recent" | "local" | "remote" | "repositories" }
  | { kind: "repository"; repoRoot: string; rootName: string; currentBranch: string; detached: boolean; item: GitBranchPopupRepository }
  | { kind: "branch"; name: string; section: "favorites" | "recent" | "local" | "remote"; repoRoot: string; item?: GitBranchItem };

export type BranchPanelRow =
  | {
      kind: "group";
      key: string;
      label: string;
      section?: "favorites" | "local" | "remote";
      depth?: number;
      directoryPath?: string;
      parentKey?: string;
    }
  | {
      kind: "branch";
      key: string;
      name: string;
      displayName: string;
      section: "favorites" | "local" | "remote";
      repoRoot: string;
      textPresentation: string;
      item?: GitBranchItem;
      depth: number;
      parentKey?: string;
    };

export type BranchPanelGroupOpen = {
  favorites: boolean;
  local: boolean;
  remote: boolean;
};

export type BranchPopupGroupOpen = {
  favorites: boolean;
  recent: boolean;
  local: boolean;
  remote: boolean;
};

type BranchPathNode = {
  key: string;
  label: string;
  path: string;
  depth: number;
  children: BranchPathNode[];
  item?: GitBranchItem;
  isLeaf: boolean;
};

/**
 * 统一规范化分支引用名，避免目录分组与复制文本在 Windows 路径分隔符上出现不一致。
 */
function normalizeBranchRefName(value: string): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * 计算分支目录分组的稳定节点键；叶子节点保留完整引用名，目录节点按路径段递进生成。
 */
function buildBranchPathKey(section: string, repoRoot: string, path: string): string {
  return `branch:${repoRoot}:${section}:${path}`;
}

/**
 * 计算分支目录节点的稳定键，避免同名目录和同名分支叶子互相覆盖。
 */
function buildBranchDirectoryKey(section: string, repoRoot: string, path: string): string {
  return `branch-dir:${repoRoot}:${section}:${path}`;
}

/**
 * 把分支引用按 `/` 切成目录树，叶子仍保留完整分支名，供显示与动作复用。
 */
function buildBranchPathNodes(section: string, repoRoot: string, items: GitBranchItem[] | undefined): BranchPathNode[] {
  const roots: BranchPathNode[] = [];
  const directoryByKey = new Map<string, BranchPathNode>();
  const branchByKey = new Set<string>();
  if (!Array.isArray(items) || items.length <= 0) return [];
  for (const item of items) {
    const name = normalizeBranchRefName(item?.name || "");
    if (!name) continue;
    const segments = name.split("/").filter(Boolean);
    if (segments.length <= 0) continue;
    let parent: BranchPathNode | undefined;
    let currentPath = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] || "";
      if (!segment) continue;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const nodeKey = buildBranchDirectoryKey(section, repoRoot, currentPath);
      let node = directoryByKey.get(nodeKey);
      if (!node) {
        node = {
          key: nodeKey,
          label: segment,
          path: currentPath,
          depth: index,
          children: [],
          isLeaf: false,
        };
        directoryByKey.set(nodeKey, node);
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
      parent = node;
    }
    const leafKey = buildBranchPathKey(section, repoRoot, name);
    if (branchByKey.has(leafKey)) continue;
    branchByKey.add(leafKey);
    const leaf: BranchPathNode = {
      key: leafKey,
      label: name,
      path: name,
      depth: Math.max(0, segments.length - 1),
      children: [],
      item,
      isLeaf: true,
    };
    if (parent) parent.children.push(leaf);
    else roots.push(leaf);
  }
  return roots;
}

/**
 * 递归收集目录树中所有分支叶子，保持当前面板的显示顺序与路径层级。
 */
function flattenBranchPathNodes(nodes: BranchPathNode[], depth = 0, parentKey?: string): BranchPanelRow[] {
  const out: BranchPanelRow[] = [];
  for (const node of nodes) {
    if (node.isLeaf) {
      const segments = node.path.split("/").filter(Boolean);
      const displayName = segments[segments.length - 1] || node.label;
      out.push({
        kind: "branch",
        key: node.key,
        name: node.path,
        displayName,
        section: "local",
        repoRoot: "",
        textPresentation: node.path,
        item: node.item,
        depth,
        parentKey,
      });
      continue;
    }
    out.push({
      kind: "group",
      key: node.key,
      label: node.label,
      depth,
      directoryPath: node.path,
      parentKey,
    });
    out.push(...flattenBranchPathNodes(node.children, depth + 1, node.key));
  }
  return out;
}

/**
 * 按屏幕显示顺序导出分支面板选中行文本，用于工作台复制处理。
 */
export function buildBranchPanelCopyText(args: {
  rows: BranchPanelRow[];
  focusedRowKey?: string;
}): string {
  const focusedRowKey = String(args.focusedRowKey || "").trim();
  const row = args.rows.find((item) => item.key === focusedRowKey);
  if (!row) return "";
  if (row.kind === "branch") return String(row.displayName || row.textPresentation || "").trim();
  return String(row.directoryPath || row.label || "").trim();
}

/**
 * 返回 branch popup 分组展开状态的默认值；默认全部展开，贴近常见分支弹窗体验。
 */
export function createDefaultBranchPopupGroupOpen(): BranchPopupGroupOpen {
  return {
    favorites: true,
    recent: true,
    local: true,
    remote: true,
  };
}

/**
 * 按选中的仓库根定位 branch popup 当前工作上下文；未命中时回退到快照主选仓。
 */
export function resolveSelectedBranchPopupRepository(
  snapshot: GitBranchPopupSnapshot | null,
  selectedRepoRoot: string,
): GitBranchPopupRepository | null {
  if (!snapshot) return null;
  const normalizedSelectedRepoRoot = String(selectedRepoRoot || snapshot.selectedRepoRoot || "").trim();
  const repositories = Array.isArray(snapshot.repositories) ? snapshot.repositories : [];
  if (repositories.length <= 0) return null;
  return repositories.find((item) => String(item.repoRoot || "").trim() === normalizedSelectedRepoRoot) || repositories[0] || null;
}

/**
 * 构建分支弹窗行模型；多仓时先展示仓库 step，进入二级 step 后再展示目标仓分支树。
 */
export function buildBranchPopupRows(args: {
  snapshot: GitBranchPopupSnapshot | null;
  selectedRepoRoot: string;
  step: GitBranchPopupStep;
  groupOpen?: BranchPopupGroupOpen;
  resolveText?: GitBranchTextResolver;
}): BranchPopupRow[] {
  const snapshot = args.snapshot;
  if (!snapshot) return [];
  const resolveLabel = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return args.resolveText ? args.resolveText(key, fallback, values) : fallback;
  };
  const rows: BranchPopupRow[] = [];
  const selectedRepository = resolveSelectedBranchPopupRepository(snapshot, args.selectedRepoRoot);
  const multiRoot = snapshot.multiRoot === true && (snapshot.repositories?.length || 0) > 1;
  for (const item of snapshot.quickActions || []) {
    rows.push({
      kind: "action",
      id: item.id,
      label: resolveBranchPopupQuickActionLabel(item.id, item.label, (key, fallback) => resolveLabel(key, fallback)),
      shortcut: item.shortcut,
      repoRoot: selectedRepository?.repoRoot,
    });
  }

  if (multiRoot && args.step === "repositories") {
    rows.push({
      kind: "group",
      key: "group:repositories",
      label: resolveLabel("workbench.branches.common.groups.repositories", "仓库"),
      section: "repositories",
    });
    for (const repository of snapshot.repositories || []) {
      rows.push({
        kind: "repository",
        repoRoot: repository.repoRoot,
        rootName: repository.rootName,
        currentBranch: repository.currentBranch,
        detached: repository.detached,
        item: repository,
      });
    }
    return rows;
  }

  if (!selectedRepository) return rows;
  if (multiRoot) {
    rows.push({
      kind: "back",
      label: resolveLabel("workbench.branches.common.backToRepositories", "返回仓库列表"),
      repoRoot: selectedRepository.repoRoot,
    });
  }

  const groups = selectedRepository.groups || snapshot.groups;
  const pushGroupRows = (label: string, section: "favorites" | "recent" | "local" | "remote", items: GitBranchItem[] | undefined): void => {
    if (!Array.isArray(items) || items.length <= 0) return;
    rows.push({ kind: "group", key: `group:${section}`, label, section });
    if (args.groupOpen && args.groupOpen[section] === false) return;
    for (const item of items) {
      const name = String(item?.name || "").trim();
      if (!name) continue;
      rows.push({
        kind: "branch",
        name,
        section,
        repoRoot: selectedRepository.repoRoot,
        item,
      });
    }
  };

  pushGroupRows(resolveLabel("workbench.branches.common.groups.favorites", "收藏"), "favorites", groups?.favorites);
  pushGroupRows(resolveLabel("workbench.branches.common.groups.recent", "最近"), "recent", groups?.recent);
  pushGroupRows(resolveLabel("workbench.branches.common.groups.local", "本地"), "local", groups?.local);
  pushGroupRows(resolveLabel("workbench.branches.common.groups.remote", "远端"), "remote", groups?.remote);
  return rows;
}

/**
 * 为左侧分支面板构建可见行；当前先聚焦一个选中仓库，但分组语义与 popup 保持一致。
 */
export function buildBranchPanelRows(
  snapshot: GitBranchPopupSnapshot | null,
  selectedRepoRoot: string,
  groupOpen: BranchPanelGroupOpen,
  groupByDirectory: boolean = false,
  directoryOpen: Record<string, boolean> = {},
  resolveText?: GitBranchTextResolver,
): BranchPanelRow[] {
  const resolveLabel = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveText ? resolveText(key, fallback, values) : fallback;
  };
  const selectedRepository = resolveSelectedBranchPopupRepository(snapshot, selectedRepoRoot);
  if (!selectedRepository) return [];
  const rows: BranchPanelRow[] = [];
  const groups = selectedRepository.groups;
  const pushBranchRows = (section: "favorites" | "local" | "remote", items: GitBranchItem[] | undefined): void => {
    if (!Array.isArray(items) || items.length <= 0) return;
    if (!groupByDirectory) {
      for (const item of items) {
        const name = normalizeBranchRefName(item?.name || "");
        if (!name) continue;
        rows.push({
          kind: "branch",
          key: buildBranchPathKey(section, selectedRepository.repoRoot, name),
          name,
          displayName: name,
          section,
          repoRoot: selectedRepository.repoRoot,
          textPresentation: name,
          item,
          depth: 0,
        });
      }
      return;
    }
    const groupedRows = buildBranchPathNodes(section, selectedRepository.repoRoot, items);
    const flatRows = flattenBranchPathNodes(groupedRows);
    const hiddenDirectoryKeys = new Set<string>();
    for (const row of flatRows) {
      const parentHidden = !!row.parentKey && (directoryOpen[row.parentKey] === false || hiddenDirectoryKeys.has(row.parentKey));
      if (parentHidden) {
        if (row.kind === "group") hiddenDirectoryKeys.add(row.key);
        continue;
      }
      if (row.kind === "group") {
        rows.push({ ...row, section });
        if (directoryOpen[row.key] === false) hiddenDirectoryKeys.add(row.key);
        continue;
      }
      rows.push({
        ...row,
        section,
        repoRoot: selectedRepository.repoRoot,
      });
    }
  };

  if ((groups?.favorites || []).length > 0) {
    rows.push({ kind: "group", key: "group:favorites", label: resolveLabel("workbench.branches.common.groups.favorites", "收藏"), section: "favorites" });
    if (groupOpen.favorites) pushBranchRows("favorites", groups.favorites);
  }
  rows.push({ kind: "group", key: "group:local", label: resolveLabel("workbench.branches.common.groups.local", "本地"), section: "local" });
  if (groupOpen.local) pushBranchRows("local", groups?.local);
  rows.push({ kind: "group", key: "group:remote", label: resolveLabel("workbench.branches.common.groups.remote", "远端"), section: "remote" });
  if (groupOpen.remote) pushBranchRows("remote", groups?.remote);
  return rows;
}
