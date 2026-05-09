// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitUiActionGroup } from "./action-registry";
import type {
  GitCommitDetailsActionAvailability,
  GitCommitDetailsActionItem,
  GitCommitDetailsActionKey,
  GitCommitDetailsSelectionChange,
} from "./types";

type GitDetailActionTextResolver = (key: string, fallback: string) => string;

type GitDetailFileChange = {
  path: string;
  oldPath?: string;
  status?: string;
};

export type GitCommitDetailsContextMenuActionKey =
  | "showDiff"
  | "compareRevisions"
  | "compareLocal"
  | "comparePreviousLocal"
  | "editSource"
  | "openRepositoryVersion"
  | "revertSelectedChanges"
  | "applySelectedChanges"
  | "extractSelectedChanges"
  | "dropSelectedChanges"
  | "createPatch"
  | "restoreFromRevision"
  | "pathHistory"
  | "toggleParentChanges";

export type GitCommitDetailsBrowserActionKey = GitCommitDetailsContextMenuActionKey;

export type GitCommitDetailsSelectionHashItem = {
  path: string;
  hashes: string[];
  uniqueHash?: string;
};

export type GitCommitDetailsSelectionHashResolution = {
  items: GitCommitDetailsSelectionHashItem[];
  uniqueHashes: string[];
  missingPaths: string[];
  ambiguousPaths: string[];
  allPathsHaveSingleHash: boolean;
};

/**
 * 把详情树当前选中的文件规整为 committed changes 选择载荷，供后端 availability/action 统一复用。
 */
export function buildCommitDetailsSelectionChanges(
  files: GitDetailFileChange[],
  selectedPaths: string[],
): GitCommitDetailsSelectionChange[] {
  const selectedSet = new Set(
    (selectedPaths || [])
      .map((path) => String(path || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  );
  return (files || [])
    .map((file) => ({
      path: String(file.path || "").trim().replace(/\\/g, "/"),
      oldPath: String(file.oldPath || "").trim().replace(/\\/g, "/") || undefined,
      status: String(file.status || "").trim() || undefined,
    }))
    .filter((file) => !!file.path && selectedSet.has(file.path));
}

/**
 * 解析详情树当前选中文件对应的提交哈希分布，供“两提交比较”和按哈希分组动作共用，避免聚合详情把同一路径跨提交版本误当成唯一来源。
 */
export function resolveCommitDetailsSelectionHashResolution(
  selectedPaths: string[],
  resolveCommitHashes: (path: string) => string[],
): GitCommitDetailsSelectionHashResolution {
  const normalizedPaths = Array.from(new Set(
    (selectedPaths || [])
      .map((path) => String(path || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
  const items: GitCommitDetailsSelectionHashItem[] = [];
  const uniqueHashes: string[] = [];
  const uniqueHashSet = new Set<string>();
  const missingPaths: string[] = [];
  const ambiguousPaths: string[] = [];

  for (const filePath of normalizedPaths) {
    const hashes = Array.from(new Set(
      (resolveCommitHashes(filePath) || [])
        .map((hash) => String(hash || "").trim())
        .filter(Boolean),
    ));
    if (hashes.length <= 0)
      missingPaths.push(filePath);
    if (hashes.length > 1)
      ambiguousPaths.push(filePath);
    for (const hash of hashes) {
      if (uniqueHashSet.has(hash)) continue;
      uniqueHashSet.add(hash);
      uniqueHashes.push(hash);
    }
    items.push({
      path: filePath,
      hashes,
      uniqueHash: hashes.length === 1 ? hashes[0] : undefined,
    });
  }

  return {
    items,
    uniqueHashes,
    missingPaths,
    ambiguousPaths,
    allPathsHaveSingleHash: normalizedPaths.length > 0 && missingPaths.length === 0 && ambiguousPaths.length === 0,
  };
}

/**
 * 读取指定 details action 的可用性项；缺失时统一回退到不可见且不可用，避免 UI 侧散落空值判断。
 */
export function getCommitDetailsActionItem(
  availability: GitCommitDetailsActionAvailability | null | undefined,
  key: GitCommitDetailsActionKey,
): GitCommitDetailsActionItem {
  const candidate = availability?.actions?.[key];
  if (!candidate) {
    return {
      visible: false,
      enabled: false,
    };
  }
  return {
    visible: candidate.visible === true,
    enabled: candidate.enabled === true,
    reason: String(candidate.reason || "").trim() || undefined,
  };
}

/**
 * 按 IDEA `Vcs.RepositoryChangesBrowserMenu` 与 Git 追加动作的层级，构建提交详情右键菜单分组。
 */
export function buildCommitDetailsContextMenuGroups(
  availability: GitCommitDetailsActionAvailability | null | undefined,
): GitCommitDetailsContextMenuActionKey[][] {
  return buildCommitDetailsActionGroups(availability).map((group) => group.items.map((item) => item.id));
}

/**
 * 按共享 action schema 构建 details browser 的动作分组，供 toolbar / popup / quick action 共用。
 */
export function buildCommitDetailsActionGroups(
  availability: GitCommitDetailsActionAvailability | null | undefined,
  resolveText?: GitDetailActionTextResolver,
): GitUiActionGroup<GitCommitDetailsBrowserActionKey>[] {
  const editSourceAction = getCommitDetailsActionItem(availability, "editSource");
  const openRepositoryVersionAction = getCommitDetailsActionItem(availability, "openRepositoryVersion");
  const revertSelectedChangesAction = getCommitDetailsActionItem(availability, "revertSelectedChanges");
  const applySelectedChangesAction = getCommitDetailsActionItem(availability, "applySelectedChanges");
  const extractAction = getCommitDetailsActionItem(availability, "extractSelectedChanges");
  const dropAction = getCommitDetailsActionItem(availability, "dropSelectedChanges");
  const showHistoryForRevisionAction = getCommitDetailsActionItem(availability, "showHistoryForRevision");
  /**
   * 统一从 details.actions 语言键解析动作文案；未注入翻译时回退到英文兜底，避免动作模型继续输出中文。
   */
  const resolveActionLabel = (actionId: GitCommitDetailsBrowserActionKey, fallback: string): string => {
    return resolveText ? resolveText(`details.actions.${actionId}`, fallback) : fallback;
  };

  const groups: GitUiActionGroup<GitCommitDetailsBrowserActionKey>[] = [
    {
      id: "compare",
      items: [
        { id: "showDiff", label: resolveActionLabel("showDiff", "Show Diff"), shortcut: "Ctrl+D" },
        { id: "compareRevisions", label: resolveActionLabel("compareRevisions", "Compare Versions") },
        { id: "compareLocal", label: resolveActionLabel("compareLocal", "Compare with Local") },
        { id: "comparePreviousLocal", label: resolveActionLabel("comparePreviousLocal", "Compare Previous Revision with Local") },
        ...(editSourceAction.visible ? [{
          id: "editSource" as const,
          label: resolveActionLabel("editSource", "Edit Source"),
          shortcut: "F4",
          enabled: editSourceAction.enabled,
          reason: editSourceAction.reason,
        }] : []),
        ...(openRepositoryVersionAction.visible ? [{
          id: "openRepositoryVersion" as const,
          label: resolveActionLabel("openRepositoryVersion", "Open Repository Version"),
          enabled: openRepositoryVersionAction.enabled,
          reason: openRepositoryVersionAction.reason,
        }] : []),
      ],
    },
    {
      id: "changes",
      items: [
        ...(revertSelectedChangesAction.visible ? [{
          id: "revertSelectedChanges" as const,
          label: resolveActionLabel("revertSelectedChanges", "Revert Selected Changes"),
          enabled: revertSelectedChangesAction.enabled,
          reason: revertSelectedChangesAction.reason,
        }] : []),
        ...(applySelectedChangesAction.visible ? [{
          id: "applySelectedChanges" as const,
          label: resolveActionLabel("applySelectedChanges", "Cherry-pick Selected Changes"),
          enabled: applySelectedChangesAction.enabled,
          reason: applySelectedChangesAction.reason,
        }] : []),
        ...(extractAction.visible ? [{
          id: "extractSelectedChanges" as const,
          label: resolveActionLabel("extractSelectedChanges", "Extract Selected Changes into a Separate Commit..."),
          enabled: extractAction.enabled,
          reason: extractAction.reason,
        }] : []),
        ...(dropAction.visible ? [{
          id: "dropSelectedChanges" as const,
          label: resolveActionLabel("dropSelectedChanges", "Drop Selected Changes"),
          enabled: dropAction.enabled,
          reason: dropAction.reason,
          tone: "danger" as const,
        }] : []),
        { id: "createPatch", label: resolveActionLabel("createPatch", "Create Patch...") },
        { id: "restoreFromRevision", label: resolveActionLabel("restoreFromRevision", "Restore from Revision") },
      ],
    },
    {
      id: "history",
      items: [
        ...(showHistoryForRevisionAction.visible ? [{
          id: "pathHistory" as const,
          label: resolveActionLabel("pathHistory", "History up to This Revision"),
          enabled: showHistoryForRevisionAction.enabled,
          reason: showHistoryForRevisionAction.reason,
        }] : []),
        { id: "toggleParentChanges", label: resolveActionLabel("toggleParentChanges", "Show Changes to Parent") },
      ],
    },
  ];

  return groups.filter((group) => group.items.length > 0);
}
