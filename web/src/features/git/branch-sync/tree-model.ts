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
  | { kind: "group"; key: string; label: string }
  | { kind: "branch"; key: string; name: string; section: "favorites" | "local" | "remote"; repoRoot: string; textPresentation: string; item?: GitBranchItem };

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

/**
 * 返回 branch popup 分组展开状态的默认值；默认全部展开，贴近 IDEA 首次打开体验。
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
    for (const item of items) {
      const name = String(item?.name || "").trim();
      if (!name) continue;
      rows.push({
        kind: "branch",
        key: `branch:${selectedRepository.repoRoot}:${section}:${name}`,
        name,
        section,
        repoRoot: selectedRepository.repoRoot,
        textPresentation: name,
        item,
      });
    }
  };

  if ((groups?.favorites || []).length > 0) {
    rows.push({ kind: "group", key: "group:favorites", label: resolveLabel("workbench.branches.common.groups.favorites", "收藏") });
    if (groupOpen.favorites) pushBranchRows("favorites", groups.favorites);
  }
  rows.push({ kind: "group", key: "group:local", label: resolveLabel("workbench.branches.common.groups.local", "本地") });
  if (groupOpen.local) pushBranchRows("local", groups?.local);
  rows.push({ kind: "group", key: "group:remote", label: resolveLabel("workbench.branches.common.groups.remote", "远端") });
  if (groupOpen.remote) pushBranchRows("remote", groups?.remote);
  return rows;
}
