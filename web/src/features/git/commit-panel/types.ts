// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitDiffHunk, GitLocalChangesConfig, GitStatusEntry } from "../types";

export type CommitTreeGroupKind =
  | "staged"
  | "unstaged"
  | "changelist"
  | "edited-commit"
  | "ignored"
  | "local"
  | "unversioned"
  | "conflict"
  | "resolved-conflict"
  | "repository"
  | "module";

export type CommitTreeNodeKind =
  | "root"
  | "directory"
  | "file"
  | "change"
  | "virtual-file"
  | "repository"
  | "module";

export type CommitGroupingKey = "directory" | "module" | "repository";

export type CommitTreeSelectionFlags = {
  selectable: boolean;
  inclusionVisible: boolean;
  inclusionEnabled: boolean;
  hideInclusionCheckbox: boolean;
  helper: boolean;
  nonSelectable?: boolean;
};

export type CommitTreeRenderPayload = {
  textPresentation: string;
  countText?: string;
  tooltipText?: string;
  manyFiles: boolean;
  browseActionVisible: boolean;
  updating: boolean;
  frozenReason?: string;
  outdatedFileCount: number;
  infoMarkerVisible: boolean;
  isDefault: boolean;
};

export type CommitTreeNodeAction =
  | "show-diff"
  | "open-source"
  | "select-in"
  | "open-merge"
  | "rollback-resolved"
  | "stage"
  | "unstage";

export type CommitTreeHoverAction = {
  id: string;
  iconLabel: string;
  tooltip: string;
  action: CommitTreeNodeAction;
};

export type CommitTreeOpenHandler = {
  action: Exclude<CommitTreeNodeAction, "select-in" | "rollback-resolved" | "stage" | "unstage">;
};

export type ChangeEntryGroup = {
  key: string;
  label: string;
  entries: GitStatusEntry[];
  kind: CommitTreeGroupKind;
  changeListId?: string;
  showHeader?: boolean;
  helper?: boolean;
  manyFiles?: boolean;
  summary?: CommitTreeGroupSummary;
  state?: CommitTreeGroupState;
  sortWeight?: number;
  stableId?: string;
  selectionFlags?: CommitTreeSelectionFlags;
  renderPayload?: CommitTreeRenderPayload;
  repositoryId?: string;
  moduleId?: string;
  sourceKind?: "status" | "modifier";
  sourceId?: string;
  actionGroupId?: string;
  toolbarActionGroupId?: string;
};

export type CommitTreeGroupSummary = {
  fileCount: number;
  directoryCount: number;
};

export type CommitTreeGroupState = {
  updating: boolean;
  frozenReason?: string;
  outdatedFileCount: number;
};

export type CommitTreeNode = {
  key: string;
  name: string;
  fullPath: string;
  isFile: boolean;
  count: number;
  filePaths: string[];
  entry?: GitStatusEntry;
  kind: CommitTreeNodeKind;
  children: CommitTreeNode[];
  stableId?: string;
  sortWeight?: number;
  helper?: boolean;
  fileCount?: number;
  directoryCount?: number;
  textPresentation?: string;
  renderPayload?: CommitTreeRenderPayload;
  selectionFlags?: CommitTreeSelectionFlags;
  hoverAction?: CommitTreeHoverAction;
  openHandler?: CommitTreeOpenHandler;
  sourceGroupKey?: string;
  sourceKind?: "status" | "modifier";
  sourceId?: string;
  repositoryId?: string;
  moduleId?: string;
};

export type CommitTreeGroup = ChangeEntryGroup & {
  treeNodes: CommitTreeNode[];
  treeRows: Array<{ node: CommitTreeNode; depth: number }>;
};

export type CommitWorkflowItemKind = "change" | "unversioned" | "ignored";

export type CommitWorkflowSelectionMode = "full-file" | "partial";

export type CommitWorkflowSelectionItem = {
  repoRoot: string;
  changeListId: string;
  path: string;
  oldPath?: string;
  kind: CommitWorkflowItemKind;
  selectionMode: CommitWorkflowSelectionMode;
  snapshotFingerprint?: string;
  patch?: string;
  selectedHunkIds?: string[];
};

export type CommitSpecialFilesDialogKind = "ignored" | "unversioned" | "conflict";

export type CommitInclusionItem = {
  id: string;
  path: string;
  oldPath?: string;
  kind: CommitWorkflowItemKind;
  changeListId: string;
  repoRoot?: string;
  staged?: boolean;
  tracked?: boolean;
  conflictState?: "conflict" | "resolved";
};

export type CommitInclusionState = {
  includedIds: string[];
  includedRepoRoots: string[];
  userTouched: boolean;
  rootsUserTouched: boolean;
  commitAllEnabled?: boolean;
  stagedRepoRoots: string[];
  changedRepoRoots: string[];
  conflictedRepoRoots: string[];
  rootsToCommit: string[];
  isCommitAll: boolean;
  itemsById: Record<string, CommitInclusionItem>;
};

export type PartialCommitSelectionEntry = {
  path: string;
  repoRoot: string;
  changeListId: string;
  diffMode: "working" | "staged";
  snapshotFingerprint: string;
  patchHeader: string;
  allHunkIds: string[];
  selectedHunkIds: string[];
  hunksById: Record<string, PartialCommitStoredHunk>;
  selectedLineKeysByHunkId: Record<string, string[]>;
};

export type PartialCommitSelectionState = {
  entriesByPath: Record<string, PartialCommitSelectionEntry>;
};

export type PartialCommitSelectableLine = {
  key: string;
  kind: "add" | "del";
  lineIndex: number;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export type PartialCommitStoredHunk = Pick<GitDiffHunk, "id" | "header" | "oldStart" | "oldLines" | "newStart" | "newLines" | "patch" | "lines"> & {
  selectableLines: PartialCommitSelectableLine[];
};

export type CommitSelectionAnchor = {
  kind: "group" | "node";
  path?: string;
  changeListId?: string;
  rowKey?: string;
  stableId?: string;
  groupStableId?: string;
};

export type CommitSelectionContext = {
  selectedEntries: GitStatusEntry[];
  selectedChanges: GitStatusEntry[];
  selectedPaths: string[];
  selectedUnversionedPaths: string[];
  selectedIgnoredPaths: string[];
  selectedStageablePaths: string[];
  selectedTrackedUnstagedPaths: string[];
  selectedStagedPaths: string[];
  selectedStashablePaths: string[];
  selectedChangeListIds: string[];
  exactlySelectedFiles: string[];
  virtualFilePaths: string[];
  navigatablePaths: string[];
  leadSelectionPath?: string;
  helpId: string;
  targetChangeListId: string;
  removableChangeListIds: string[];
  canEditList: boolean;
  canDeleteList: boolean;
  canSetActiveList: boolean;
  canMoveToList: boolean;
  canAddToVcs: boolean;
  canStage: boolean;
  canStageWithoutContent: boolean;
  canUnstage: boolean;
  canRevertUnstaged: boolean;
  canStageStash: boolean;
  canIgnore: boolean;
  canCommit: boolean;
  canRollback: boolean;
  canShelve: boolean;
  canShowDiff: boolean;
  canShowStaged: boolean;
  canShowLocal: boolean;
  canCompareLocalToStaged: boolean;
  canCompareStagedToLocal: boolean;
  canCompareStagedToHead: boolean;
  canCompareThreeVersions: boolean;
  canOpenSource: boolean;
  canDelete: boolean;
  canShowHistory: boolean;
  changeListsEnabled: boolean;
  stagingAreaEnabled: boolean;
};

export type BuildChangeEntryGroupsArgs = {
  entries: GitStatusEntry[];
  ignoredEntries: GitStatusEntry[];
  changeLists: Array<{ id: string; name: string }>;
  options: GitLocalChangesConfig;
  translate?: (key: string, fallback: string, values?: Record<string, unknown>) => string;
  manyFilesThreshold?: number;
  operationState?: "normal" | "rebasing" | "merging" | "grafting" | "reverting";
  stateByGroupKey?: Record<string, Partial<CommitTreeGroupState>>;
  groupingKeys?: CommitGroupingKey[];
  modifierGroups?: ChangeEntryGroup[];
};

export type CommitPanelRenderRow =
  | {
    key: string;
    kind: "group";
    group: CommitTreeGroup;
    textPresentation: string;
  }
  | {
    key: string;
    kind: "node";
    group: CommitTreeGroup;
    node: CommitTreeNode;
    depth: number;
    textPresentation: string;
  };

export type CommitTreeDataSnapshot = CommitSelectionContext & {
  treeId: "commit-tree" | "browse-unversioned" | "browse-ignored" | "browse-conflict";
  popupActionGroupId: string;
  toolbarActionGroupId: string;
};
