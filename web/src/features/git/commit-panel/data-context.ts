// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitLocalChangesConfig, GitStatusEntry } from "../types";
import { COMMIT_TREE_ACTION_GROUPS, resolveSpecialFilesActionGroups } from "./action-groups";
import { deriveCommitSelectionContext } from "./selection-model";
import type { CommitTreeDataSnapshot } from "./types";

/**
 * 为主提交树构建统一 data snapshot，集中承载选择快照与 action group 标识。
 */
export function buildCommitTreeDataSnapshot(args: {
  selectedEntries: GitStatusEntry[];
  selectedPaths: string[];
  exactlySelectedPaths?: string[];
  selectedNodeSources?: Array<{ sourceKind?: "status" | "modifier"; sourceId?: string }>;
  selectedChangeListIds: string[];
  selectedExplicitChangeListIds?: string[];
  contextChangeListId?: string;
  contextChangeListExplicit?: boolean;
  availableChangeListIds: Set<string>;
  activeChangeListId: string;
  localChangesConfig: GitLocalChangesConfig;
  stashPushPathspecSupported?: boolean;
}): CommitTreeDataSnapshot {
  return {
    ...deriveCommitSelectionContext(args),
    treeId: "commit-tree",
    popupActionGroupId: COMMIT_TREE_ACTION_GROUPS.mainPopup,
    toolbarActionGroupId: COMMIT_TREE_ACTION_GROUPS.mainToolbar,
  };
}

/**
 * 为 ignored / unversioned Browse 树构建 data snapshot，避免对话框继续仅靠路径数组判断 enablement。
 */
export function buildSpecialFilesDataSnapshot(args: {
  kind: "ignored" | "unversioned" | "conflict";
  selectedEntries: GitStatusEntry[];
  selectedPaths: string[];
  exactlySelectedPaths?: string[];
  localChangesConfig: GitLocalChangesConfig;
  stashPushPathspecSupported?: boolean;
}): CommitTreeDataSnapshot {
  const actionGroups = resolveSpecialFilesActionGroups(args.kind);
  const base = deriveCommitSelectionContext({
    selectedEntries: args.selectedEntries,
    selectedPaths: args.selectedPaths,
    exactlySelectedPaths: args.exactlySelectedPaths,
    selectedChangeListIds: [],
    availableChangeListIds: new Set<string>(),
    activeChangeListId: "",
    localChangesConfig: args.localChangesConfig,
    stashPushPathspecSupported: args.stashPushPathspecSupported,
  });
  return {
    ...base,
    treeId: args.kind === "ignored"
      ? "browse-ignored"
      : args.kind === "conflict"
        ? "browse-conflict"
        : "browse-unversioned",
    popupActionGroupId: actionGroups.popupActionGroupId,
    toolbarActionGroupId: actionGroups.toolbarActionGroupId,
    canDelete: args.kind === "ignored" ? args.selectedPaths.length > 0 : base.canDelete,
    canAddToVcs: args.kind === "unversioned" ? args.selectedPaths.length > 0 : base.canAddToVcs,
  };
}
