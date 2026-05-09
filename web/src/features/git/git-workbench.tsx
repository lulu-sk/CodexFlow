// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// Git 工作台交互模型参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 React/TypeScript 架构重写。

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CircleArrowDown,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Download,
  Eye,
  FileCode2,
  FilterX,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  Loader2,
  MoreHorizontal,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCcw,
  Search,
  Star,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { interpolateI18nText } from "@/lib/translate";
import {
  addWorktreeAsync,
  abortRepositoryOperationAsync,
  applyUpdateTrackedBranchSelectionsAsync,
  applyConflictResolverSideAsync as applyConflictResolverSideApiAsync,
  applyStashAsync,
  cancelGitFeatureRequestAsync,
  clearGitConsoleAsync,
  continueRepositoryOperationAsync,
  createChangeListAsync,
  createCommitAsync,
  createStashAsync,
  createShelveAsync,
  deleteShelveAsync,
  deleteChangeListAsync,
  deleteFilesAsync,
  dropStashAsync,
  detectRepoAsync,
  executePushAsync,
  getBranchPopupAsync,
  getBranchCompareFilesAsync,
  getConflictMergeSnapshotAsync,
  getConflictResolverEntriesAsync,
  getDiffAsync,
  getDiffOpenPathAsync,
  getDiffPatchAsync,
  getGitConsoleAsync,
  getInteractiveRebasePlanAsync,
  getIgnoreTargetsAsync,
  getIgnoredStatusAsync,
  getLogAsync,
  getLogActionAvailabilityAsync,
  getLogDetailsAsync,
  getLogDetailsActionAvailabilityAsync,
  getLogMessageDraftAsync,
  importShelvePatchFilesAsync,
  getPushPreviewAsync,
  getShelvesAsync,
  getStashListAsync,
  getUpdateOptionsAsync,
  getUpdateTrackedBranchPreviewAsync,
  runInteractiveRebasePlanAsync,
  resolveFileHistoryPathAsync,
  getStatusAsync,
  getWorktreesAsync,
  initRepoAsync,
  ignoreFilesAsync,
  moveFilesToChangeListAsync,
  recycleShelveAsync,
  removeWorktreeAsync,
  renameChangeListAsync,
  renameShelveAsync,
  restoreArchivedShelveAsync,
  restoreShelveAsync,
  restoreFilesFromRevisionAsync,
  rollbackFilesAsync,
  revertUnstagedFilesAsync,
  runBranchActionAsync,
  runFlowAsync,
  runLogDetailsActionAsync,
  runLogActionAsync,
  saveCommitPanelPreferencesAsync,
  saveShelfViewStateAsync,
  savePullOptionsAsync,
  saveUpdateOptionsAsync,
  stageFilesAsync,
  setCommitGroupingKeysAsync,
  setActiveChangeListAsync,
  setChangesViewOptionAsync,
  setLocalChangesOptionAsync,
  subscribeGitFeatureActivity,
  switchBranchAsync,
  unstageFilesAsync,
  updateChangeListDataAsync,
  writeWorkingFileAsync,
} from "./api";
import {
  buildGitLogColumnStyle,
  estimateGitLogColumnWidth,
  GIT_LOG_COLUMN_DEFINITIONS,
  type GitLogColumnId,
  type GitLogColumnLayout,
  loadGitLogColumnLayout,
  moveGitLogColumn,
  resolveGitLogColumnWidth,
  resizeGitLogColumn,
  saveGitLogColumnLayout,
} from "./log-columns";
import {
  getGitLogAuthorFilterValues,
  getGitLogBranchFilterValues,
  normalizeGitLogFilters,
} from "./log-filters";
import {
  GitLogDateFilterButton,
  GitLogMultiSelectFilterButton,
  type GitLogMultiSelectFilterOption,
} from "./log-filter-popups";
import {
  buildCurrentBranchPresentation,
  buildBranchRowPresentation,
  buildBranchPopupWarningPresentation,
  type GitBranchRowPresentation,
  type GitCurrentBranchPresentation,
} from "./branch-sync/presentation";
import { shouldAutoRefreshBranchSyncAfterActivity } from "./branch-sync/activity";
import {
  buildBranchPanelRows,
  buildBranchPopupRows,
  createDefaultBranchPopupGroupOpen,
  resolveSelectedBranchPopupRepository,
  type BranchPanelGroupOpen,
  type BranchPanelRow,
  type BranchPopupGroupOpen,
  type BranchPopupRow,
  type GitBranchPopupStep,
} from "./branch-sync/tree-model";
import { buildBranchPopupActionGroups, type GitBranchPopupActionKey } from "./branch-sync/action-groups";
import { loadGitBranchPopupState, saveGitBranchPopupState } from "./branch-sync/popup-state";
import {
  buildBranchCompareDialogConfig,
  buildBranchCompareRevision,
  formatBranchCompareLabel,
  type BranchCompareMode,
} from "./branch-sync/compare-model";
import { BranchSyncBadges, BranchSyncStatusIcon } from "./branch-sync/widgets";
import { buildGitLogRowStyle } from "./log-style/log-row-style";
import { GitLogGraphCell } from "./log-graph/cell";
import type { GitGraphCell } from "./log-graph/model";
import {
  buildGitLogBranchesDashboard,
  buildGitLogVisiblePack,
  loadGitLogBranchesDashboardState,
  saveGitLogBranchesDashboardState,
  type GitLogBranchesDashboardState,
} from "./log-graph/visible-pack";
import {
  buildCommitPatchPathspecs,
  buildCommitDetailsRequestKey,
  buildCommitLineStatsSummary,
  buildCommitDiffRequestSignature,
  buildCommitDiffSnapshotSignature,
  buildCommitSelectionSignature,
  buildGitStageAllOperationBatches,
  buildGitConsoleCopyText,
  buildGitLogCheckoutMenuModel,
  buildGitStageOperationBatches,
  buildPatchExportFileName,
  buildWorkingTreePatchRequests,
  canUseDiffPartialCommit,
  resolveLoadedFileHistoryPath,
  resolveLogActionExecutionHashes,
  resolveOperationProblemConflictResolverRequest,
  resolveOperationControlFailureFeedback,
  resolvePendingLogSelectionItem,
  resolveLogActionOperationFailureFeedback,
  resolveGitWorkbenchBootstrapRefresh,
  resolvePartialCommitValidationDiffMode,
  shouldFinalizeCherryPickByCommit,
  shouldRefreshAfterClosingOperationProblem,
  shouldSkipCommitDetailsRequest,
  shouldAutoPreviewCommitSelection,
  shouldShowDiffPartialCommit,
} from "./git-workbench-utils";
import { toErrorText } from "./error-text";
import { resolveGitUpdateMethodLabel } from "./git-i18n";
import {
  buildCommitDetailsContextMenuGroups,
  buildCommitDetailsSelectionChanges,
  getCommitDetailsActionItem,
  resolveCommitDetailsSelectionHashResolution,
} from "./detail-actions";
import {
  buildConflictContextActionKeys,
  resolveConflictContextMenuRequest,
} from "./change-context-actions";
import { FetchDialog, type GitFetchDialogRepositoryOption, type GitFetchDialogValue } from "./fetch-dialog";
import {
  PullDialog,
  type GitPullDialogRemoteOption,
  type GitPullDialogRepositoryOption,
  type GitPullDialogValue,
} from "./pull-dialog";
import { ShelfRestoreDialog, type GitShelfRestoreDialogValue } from "./shelf-restore-dialog";
import { ShelfBrowserPane } from "./shelf-browser-pane";
import { RollbackViewerDialog } from "./rollback-viewer-dialog";
import {
  buildOperationProblemRollbackEntries,
  buildRollbackBrowserEntriesFromStatusEntries,
  type GitRollbackBrowserEntry,
  type GitRollbackBrowserGroupingKey,
} from "./rollback-browser-model";
import { GitDetailsBrowser } from "./details-browser";
import { ContextMenu, ContextMenuItem, ContextMenuSubmenu, renderContextMenuSections } from "./context-menu";
import { resolveGitStageGlobalActionAvailability } from "./stage-action-model";
import { resolveCommitToolbarIntent, resolveGitToolbarState } from "./toolbar-state";
import {
  applyMovedPathsToStatusSnapshot,
  buildChangeListSelectOptions,
  buildMoveEntryStatePayload,
  resolveDisplayChangeListName,
  resolveMoveDialogLists,
} from "./changelist-ui";
import {
  DEFAULT_BRANCH_PANEL_PROPORTION,
  DEFAULT_DETAIL_PANEL_PROPORTION,
  DEFAULT_MAIN_PANEL_PROPORTION,
  normalizeMainPanelStoredWidth,
  resolveBottomPanelLayout,
  resolveCommitMessageEditorHeight,
  resolveMainPanelLayout,
} from "./workbench-layout";
import {
  findBlockingCommitCheck,
  runBeforeCommitChecks,
  type GitCommitCheck,
} from "./commit-panel/checks";
import {
  readLastCommitMessage,
  resolveInitialCommitMessage,
  shouldPersistLastCommitMessage,
  writeLastCommitMessage,
} from "./commit-panel/message-policy";
import {
  buildCommitTreeSharedMenuSections,
  shouldShowCommitTreeSharedDeleteAction,
  type CommitTreeSharedMenuNode,
} from "./commit-panel/context-menu-model";
import type {
  GitBranchCompareFilesResult,
  GitChangeList,
  GitBranchItem,
  GitRemoteConfigItem,
  GitBranchPopupRepository,
  GitBranchPopupSnapshot,
  GitCommitDetailsActionAvailability,
  GitConflictMergeSnapshot,
  GitConflictMergeSessionSnapshot,
  GitConsoleEntry,
  GitChangedFile,
  GitDiffMode,
  GitDiffEditorSelection,
  GitDiffLineDecorations,
  GitDiffSnapshot,
  GitHistoryRewriteFeedback,
  GitInteractiveRebaseEntry,
  GitInteractiveRebasePlan,
  GitIgnoreTarget,
  GitLogActionAvailability,
  GitLogActionAvailabilityKey,
  GitLogDetails,
  GitLogFilters,
  GitLogItem,
  GitLogMessageDraft,
  GitPushRejectedAction,
  GitPushRejectedDecision,
  GitPushPreview,
  GitPullCapabilities,
  GitPullOptions,
  GitShelfItem,
  GitShelfViewState,
  GitStashItem,
  GitStatusEntry,
  GitStatusSnapshot,
  GitUpdateNotificationRange,
  GitUpdateOptionMethod,
  GitUpdateOperationProblem,
  GitUpdateOptions,
  GitUpdateOptionsSnapshot,
  GitUpdateProblemAction,
  GitUpdatePostAction,
  GitUpdateRebaseWarning,
  GitUpdateSessionProgressSnapshot,
  GitUpdateSessionNotificationData,
  GitUpdateTrackedBranchPreview,
  GitUpdateTrackedBranchSelection,
  GitWorktreeItem,
} from "./types";
import {
  buildCommitWorkflowPayload,
  buildCommitWorkflowPayloadFromEntries,
  resolveGitCommitIntent,
  type GitCommitIntent,
} from "./commit-panel/commit-workflow";
import { CommitOptionsPopover } from "./commit-panel/commit-options-popover";
import {
  buildCommitAdvancedOptionsSummary,
  createCommitAdvancedOptionsState,
  hasCommitAdvancedOptions,
  patchCommitAdvancedOptionsState,
  resolveCommitHooksAvailability,
  sanitizeCommitAdvancedOptionsState,
  type CommitAdvancedOptionsState,
} from "./commit-panel/commit-options-model";
import { resolveMergeExclusionPrecheck } from "./commit-panel/merge-precheck";
import {
  areChangeListCommitDraftsEqual,
  buildChangeListCommitDraftPatch,
  readChangeListCommitDraft,
  type GitChangeListCommitDraft,
} from "./commit-panel/changelist-draft";
import {
  finalizeGitCommitWorkflowSuccess,
  prepareGitCommitWorkflowAsync,
} from "./commit-panel/workflow-handler";
import {
  buildCommitActionLabel,
  buildCommitAmendDetails,
  buildCommitAmendGroupLabel,
  COMMIT_AMEND_SOURCE_ID,
  createCommitAmendRestoreSnapshot,
  isSameCommitHashIdentity,
  isCommitAmendNode,
  shouldApplyCommitAmendMessage,
  shouldRestoreCommitAmendAuthor,
  shouldRestoreCommitAmendMessage,
  type CommitAmendDetails,
  type CommitAmendRestoreSnapshot,
} from "./commit-panel/amend-model";
import {
  buildCommitInclusionItemId,
  buildCommitInclusionLookupKey,
  buildCommitInclusionItems,
  createCommitInclusionState,
  isSameCommitInclusionState,
  normalizeCommitRepoRoot,
  resolveCommitActivationInclusionState,
  setCommitInclusionForItemIds,
  syncCommitInclusionState,
  isEntryActionable as isCommitEntryActionable,
} from "./commit-panel/inclusion-model";
import {
  clearPartialCommitSelection,
  createPartialCommitSelectionState,
  getPartialCommitSelectionEntry,
  isPartialCommitSelectionActive,
  setAllPartialCommitHunksSelected,
  setPartialCommitLineKeysSelected,
  syncPartialCommitSelectionWithSnapshot,
} from "./commit-panel/partial-commit-model";
import {
  buildPartialCommitLineDecorations,
  countSelectedPartialCommitLines,
  resolvePartialCommitAffectedLineSelection,
  resolvePartialCommitAffectedLineSelectionState,
} from "./commit-panel/partial-commit-lines";
import { buildPartialCommitDiffControls } from "./commit-panel/partial-commit-diff-controls";
import {
  buildChangeEntryGroups as buildCommitPanelChangeEntryGroups,
  buildCommitPanelRenderRows,
  buildCommitNodeMap,
  buildCommitTreeGroups,
} from "./commit-panel/changes-tree-view-model";
import {
  canOpenDiffForCommitEntry,
  resolveCommitOpenAction,
  resolveCommitPreviewDiffMode,
} from "./commit-panel/interaction-model";
import {
  findCommitSpeedSearchMatch,
  findCommitSpeedSearchRanges,
} from "./commit-panel/tree-interactions";
import {
  buildCommitMenuSelectionSnapshot,
  buildCommitRenderRowMap,
  buildCommitSelectionAnchors,
  filterSelectableCommitRowKeys,
  resolveExactlySelectedChangePaths as resolveCommitExactlySelectedChangePaths,
  resolveExplicitSelectedChangeListIds as resolveCommitExplicitSelectedChangeListIds,
  resolveSelectedChangeListIds as resolveCommitSelectedChangeListIds,
  resolveSelectedCommitNodeKeys,
  resolveSelectedDeleteTargets as resolveCommitSelectedDeleteTargets,
  resolveSelectedDiffableCommitNodeKey,
  selectCommitNodeByPath,
  resolveSelectedChangePaths as resolveCommitSelectedChangePaths,
  resolveSelectedSubtreeCommitNodeKeys,
  resolveSingleChangeListId as resolveCommitSingleChangeListId,
  restoreCommitTreeSelection,
} from "./commit-panel/selection-model";
import { COMMIT_TREE_ACTION_GROUPS } from "./commit-panel/action-groups";
import { buildCommitTreeDataSnapshot } from "./commit-panel/data-context";
import {
  consumeGitWorkbenchHostRequest,
  normalizeGitWorkbenchProjectPathKey,
  subscribeGitWorkbenchHostRequests,
  type GitWorkbenchHostRequest,
} from "./git-workbench-bridge";
import { dispatchGitWorkbenchHostActionAsync, type GitWorkbenchHostActionHandlers } from "./host-action-dispatch";
import {
  applyCommitDiffOpenRequestToSnapshot,
  buildAdjacentCommitDiffOpenRequest,
  buildCommitDiffOpenRequest,
  buildCommitNodeDiffOpenRequest,
  type CommitDiffOpenRequest,
} from "./commit-panel/main-chain";
import {
  createCommitTreeStateSnapshot,
  resolveAutoExpandedDirectoryState,
  resolveCommitFallbackRowSelection,
  resolveCommitGroupExpandedState,
  resolveCommitTreeExpandedState,
} from "./commit-panel/tree-state-strategy";
import { ConflictMergeDialog } from "./commit-panel/conflict-merge-dialog";
import { ConflictMergeThreeWayEditor } from "./commit-panel/conflict-merge-three-way-editor";
import { CommitTreePane } from "./commit-panel/commit-tree-pane";
import { createCommitRefreshController, useLatestAsyncRunner } from "./commit-panel/refresh-controller";
import { mergePagedGitLogGraphItems } from "./log-graph/graph-items";
import { GitActionDialog, type ActionDialogConfig } from "./action-dialog";
import {
  buildCommitDetailsPatchDialogConfig,
  buildCreateBranchDialogConfig,
  buildCreateTagDialogConfig,
  buildDeleteCommitDialogConfig,
  buildEditCommitMessageDialogConfig,
  buildGitDialogText,
  buildResetCurrentBranchDialogConfig,
  buildUndoCommitDialogConfig,
} from "./action-dialog-presets";
import { InteractiveRebaseDialog } from "./interactive-rebase-dialog";
import { loadGitLogCommitEditingPrefs, saveGitLogCommitEditingPrefs } from "./log-commit-editing-prefs";
import {
  buildInteractiveRebaseRunPayload,
  cloneInteractiveRebaseEntries,
  hasInteractiveRebaseDraftChanges,
  moveInteractiveRebaseEntry,
  moveInteractiveRebaseEntryToEdge,
  restoreInteractiveRebaseSelection,
  resolveInteractiveRebaseSuggestedMessage,
  updateInteractiveRebaseEntryAction,
  updateInteractiveRebaseEntryMessage,
  validateInteractiveRebasePlanEntries,
} from "./interactive-rebase-model";
import { IgnoreTargetDialog } from "./commit-panel/ignore-target-dialog";
import { SpecialFilesDialog } from "./commit-panel/special-files-dialog";
import {
  COMMIT_TREE_ROW_HEIGHT,
  canCommitTreeNodeExpandSafely,
  isCommitTreeResetRequired,
  normalizeCommitGroupingKeys,
} from "./commit-panel/config";
import type {
  ChangeEntryGroup as CommitPanelChangeEntryGroup,
  CommitGroupingKey,
  CommitInclusionState,
  PartialCommitSelectionState,
  CommitSpecialFilesDialogKind,
  CommitSelectionAnchor,
  CommitTreeGroup as CommitPanelTreeGroup,
  CommitTreeNode as CommitPanelTreeNode,
} from "./commit-panel/types";
import { FixTrackedBranchDialog } from "./update/fix-tracked-branch-dialog";
import { ConflictResolverDialog } from "./update/conflict-resolver-dialog";
import {
  buildRemainingMergeConflictNoticeMessage,
  getSelectedMergeConflictEntry,
  resolveEffectiveMergeConflictPaths,
  resolveNextMergeConflictPath,
  sanitizeMergeConflictSelection,
  shouldNotifyRemainingMergeConflicts,
  shouldAutoCloseMergeConflictDialog,
} from "./update/merge-conflict-manager";
import {
  buildPushRejectedRetrySuccessMessage,
  resolvePushRejectedUpdateMethod,
} from "./update/push-rejected-flow";
import { useGitAutoRefresh } from "./use-git-auto-refresh";
import { PushRejectedDialog } from "./update/push-rejected-dialog";
import { RebaseWarningDialog } from "./update/rebase-warning-dialog";
import { ResultNotification, UpdateSessionProgressCard } from "./update/result-notification";
import {
  consumePendingPushAfterCommitRequest,
  persistPendingPushAfterCommitRequest,
  type PushAfterCommitContext,
} from "./push-after-commit";
import {
  buildManualShelveSelection,
  consumePendingSavedChangesOpenRequest,
  openSavedChangesViewAsync,
  runShelfEntryActionAsync,
  runStashEntryActionAsync,
} from "./saved-changes-actions";
import {
  dismissUpdateSessionEntry,
  finalizeUpdateSessionEntry,
  type GitUpdateSessionEntryState,
  isUpdateSessionProgressSettled,
  toggleUpdateSessionEntryExpanded,
  upsertRunningUpdateSessionEntry,
} from "./update/session-store";
import {
  buildConflictsPanelSnapshot,
  clearDismissedConflictsPanelSignature,
  createDefaultConflictsPanelPreferences,
  dismissConflictsPanelForSnapshot,
  loadConflictsPanelPreferences,
  revealConflictsPanel,
  saveConflictsPanelPreferences,
  setConflictsPanelGateEnabled,
  shouldShowConflictsPanel,
  type ConflictsPanelSnapshot,
} from "./update/conflicts-panel-state";
import {
  buildUpdateInfoLogState,
  resolveUpdateInfoLogRange,
  selectUpdateInfoLogRange,
  type UpdateInfoLogState,
} from "./update/update-info-log";
import { SmartOperationDialog } from "./update/smart-operation-dialog";
import { OperationStateCard } from "./update/operation-state-card";
import { shouldPromptRuntimeUpdateScope } from "./update/scope-preview";
import { UntrackedOverwriteDialog } from "./update/untracked-overwrite-dialog";
import { UpdateOptionsDialog } from "./update/update-options-dialog";
import { UpdateRuntimeScopeDialog } from "./update/update-runtime-scope-dialog";
import { useVirtualWindow } from "./use-virtual-window";
import {
  createDefaultWorktreeTabPreferences,
  loadWorktreeTabPreferences,
  markWorktreeFeatureUsed,
  markWorktreeTabOpenedByUser,
  saveWorktreeTabPreferences,
  shouldShowWorktreeNewBadge,
  shouldShowWorktreeTab,
} from "./worktree-tab-state";

const MonacoGitDiff = React.lazy(async () => await import("./monaco-git-diff"));

type GitWorkbenchProps = {
  repoPath: string;
  active: boolean;
  onOpenProjectInApp?: (projectPath: string) => Promise<boolean>;
  onOpenTerminalInApp?: (args: { projectPath: string; startupCmd: string; title?: string }) => Promise<boolean>;
};

type MenuState = {
  x: number;
  y: number;
  type: "changes" | "log" | "branch" | "detail";
  target?: string;
  targetKind?: "file" | "folder" | "changelist";
  changeListId?: string;
  selectionRowKeys?: string[];
};

type ConflictMergeDialogState = {
  repoRoot: string;
  relativePath: string;
  loading: boolean;
  saving: boolean;
  snapshot: GitConflictMergeSnapshot | null;
  reverse?: boolean;
};

type IgnoreTargetDialogRequest = {
  repoRoot: string;
  paths: string[];
  targets: GitIgnoreTarget[];
};

type StageThreeWayDialogState = {
  path: string;
  loading: boolean;
  error?: string;
  headText: string;
  indexText: string;
  workingText: string;
  headRenderable: boolean;
  indexRenderable: boolean;
  workingRenderable: boolean;
  headFallbackText: string;
  indexFallbackText: string;
  workingFallbackText: string;
};

type ConflictResolverDialogState = {
  title: string;
  description: string;
  scopeRepoRoot?: string;
  selectedPath: string;
  checkedPaths: string[];
  sessionSnapshot: GitConflictMergeSessionSnapshot | null;
  groupByDirectory: boolean;
  showResolved: boolean;
  loading: boolean;
  applyingSide: "ours" | "theirs" | null;
  autoCloseWhenResolved: boolean;
  reverseMerge?: boolean;
};

type InteractiveRebaseDialogState = {
  plan: GitInteractiveRebasePlan;
  entries: GitInteractiveRebaseEntry[];
  selectedHash: string;
  selectedDiffPathByHash: Record<string, string>;
  submitting: boolean;
  error: string;
  detailsByHash: Record<string, GitLogDetails>;
  detailsLoadingHash?: string;
};

type GitPullLikeResponse = {
  ok: boolean;
  data?: any;
  error?: string;
  meta?: { requestId: number };
};

type RollbackViewerState = {
  title: string;
  description: string;
  entries: GitRollbackBrowserEntry[];
  selectedPaths: string[];
  activePath?: string;
  continueLabel?: string;
  refreshPaths: string[];
};

type RollbackDiffOverlayRestoreSnapshot = {
  diff: GitDiffSnapshot | null;
  diffActiveLine: number;
  diffFullscreen: boolean;
  diffPinned: boolean;
  loadedDiffRequestSignature: string;
};

type GitUiTone = "accent" | "success" | "warning" | "danger" | "info" | "muted";

type GitDecorationPill = {
  key: string;
  label: string;
  tone: GitUiTone;
};

/**
 * 提供工作台级别的通用 Git 文案翻译入口，供组件外的 helper 直接复用。
 */
function gitWorkbenchText(key: string, fallback: string, values?: Record<string, unknown>): string {
  return interpolateI18nText(String(i18next.t(key, {
    ns: "git",
    defaultValue: fallback,
    ...(values || {}),
  })), values);
}

/**
 * 供组件外 helper 统一生成本地化错误文案，避免结构化 fallback 退回为硬编码字符串。
 */
function gitWorkbenchErrorText(raw: unknown, key: string, fallback: string, values?: Record<string, unknown>): string {
  return toErrorText(raw, gitWorkbenchText(key, fallback, values));
}

/**
 * 把后端结构化 interactive rebase 不可用原因转换为更接近 IDEA gating 的用户提示。
 */
function resolveInteractiveRebasePlanErrorText(error: string | undefined, data: any): string {
  const reasonCode = String(data?.reasonCode || "").trim();
  const reasonMessage = String(data?.reasonMessage || "").trim();
  if (reasonCode === "merge-commit") return reasonMessage || gitWorkbenchText("dialogs.interactiveRebase.reason.mergeCommit", "当前选中提交是 merge commit，应用内交互式变基暂不支持。");
  if (reasonCode === "non-linear-history") return reasonMessage || gitWorkbenchText("dialogs.interactiveRebase.reason.nonLinearHistory", "当前提交范围不属于线性 first-parent 历史，应用内交互式变基暂不支持。");
  if (reasonCode === "target-outside-head") return reasonMessage || gitWorkbenchText("dialogs.interactiveRebase.reason.targetOutsideHead", "当前提交已不在 HEAD 历史线上，请刷新日志后重试。");
  if (reasonCode === "unexpected-hash") return reasonMessage || gitWorkbenchText("dialogs.interactiveRebase.reason.unexpectedHash", "提交历史已发生变化，请刷新日志后重试。");
  if (reasonCode === "unresolved-hash") return reasonMessage || gitWorkbenchText("dialogs.interactiveRebase.reason.unresolvedHash", "读取当前提交链失败，请刷新日志后重试。");
  if (reasonCode === "detached-head") return reasonMessage || gitWorkbenchText("dialogs.interactiveRebase.reason.detachedHead", "游离 HEAD 状态下无法打开交互式变基编辑器。");
  if (reasonCode === "commit-not-found") return reasonMessage || gitWorkbenchText("dialogs.interactiveRebase.reason.commitNotFound", "读取目标提交失败，请刷新日志后重试。");
  return toErrorText(error, gitWorkbenchText("dialogs.interactiveRebase.failed", "读取交互式变基计划失败"));
}

/**
 * 将绝对仓库路径转换为当前工作台根目录下的相对仓库键，供多仓冲突 resolver 按 root 过滤。
 */
function resolveConflictResolverScopeKey(
  workspaceRepoRoot: string,
  targetRepoRoot: string,
): string | null {
  const normalize = (value: string): string => String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const workspace = normalize(workspaceRepoRoot);
  const target = normalize(targetRepoRoot);
  if (!workspace || !target) return null;
  if (workspace === target) return "";
  if (!target.startsWith(`${workspace}/`)) return null;
  return target.slice(workspace.length + 1);
}

/**
 * 规整仓库相对路径，统一处理斜杠、前缀分隔符与尾部分隔符。
 */
function normalizeRepoRelativePath(value: string | undefined | null): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * 拼接仓库根路径与仓库内相对路径，供多仓冲突 fallback/外部打开动作复用。
 */
function buildRepoFileAbsolutePath(repoRootInput: string, relativePathInput: string): string {
  const repo = String(repoRootInput || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const relativePath = normalizeRepoRelativePath(relativePathInput);
  if (!repo || !relativePath) return "";
  return `${repo}/${relativePath}`;
}

/**
 * 将工作台作用域键转换为真实 repo root，供多仓冲突操作切到目标仓执行 Git 命令。
 */
function resolveScopedRepoRoot(
  workspaceRepoRoot: string,
  scopeRepoRoot?: string,
): string {
  const workspace = String(workspaceRepoRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const scope = normalizeRepoRelativePath(scopeRepoRoot);
  if (!workspace) return "";
  if (!scope) return workspace;
  return `${workspace}/${scope}`;
}

/**
 * 把工作台相对路径切到目标仓内部路径，供 scoped repo 的冲突 API 调用。
 */
function resolveScopedRepoRelativePath(
  workspaceRelativePath: string,
  scopeRepoRoot?: string,
): string {
  const cleanPath = normalizeRepoRelativePath(workspaceRelativePath);
  const scope = normalizeRepoRelativePath(scopeRepoRoot);
  if (!cleanPath) return "";
  if (!scope) return cleanPath;
  if (cleanPath === scope) return "";
  if (cleanPath.startsWith(`${scope}/`)) return cleanPath.slice(scope.length + 1);
  return cleanPath;
}

/**
 * 按当前 resolver scope 过滤冲突条目，确保多仓入口只显示目标仓文件。
 */
function filterConflictEntriesByScope(
  entries: GitStatusEntry[],
  scopeRepoRoot?: string,
): GitStatusEntry[] {
  const scope = normalizeRepoRelativePath(scopeRepoRoot);
  return entries.filter((entry) => normalizeRepoRelativePath(entry.repositoryRoot) === scope);
}

/**
 * 提取历史改写统一反馈模型，供 interactive rebase / editMessage / deleteCommit / committed changes 改写共用通知逻辑。
 */
function extractHistoryRewriteFeedback(data: any): GitHistoryRewriteFeedback | null {
  const candidate = data?.historyRewriteFeedback;
  if (!candidate || typeof candidate !== "object") return null;
  const action = String(candidate.action || "").trim();
  const tone = String(candidate.tone || "").trim();
  const title = String(candidate.title || "").trim();
  const message = String(candidate.message || "").trim();
  if (!title || !message) return null;
  if (
    action !== "interactive-rebase"
    && action !== "edit-message"
    && action !== "delete-commit"
    && action !== "extract-selected-changes"
    && action !== "drop-selected-changes"
  ) return null;
  if (tone !== "info" && tone !== "warn" && tone !== "danger") return null;
  const operationState = String(candidate.operationState || "").trim();
  const detailLines: string[] = Array.from(new Set(
    (Array.isArray(candidate.detailLines) ? candidate.detailLines : ([] as unknown[]))
      .map((item: unknown) => String(item || "").trim())
      .filter(Boolean),
  ));
  const undoPayload = candidate.undo?.payload;
  const undoKind = String(undoPayload?.kind || "").trim();
  const undoOldHead = String(undoPayload?.oldHead || "").trim();
  const undoNewHead = String(undoPayload?.newHead || "").trim();
  const undo = undoKind === "delete-commit" && undoOldHead && undoNewHead
    ? {
        label: String(candidate.undo?.label || "").trim() || gitWorkbenchText("workbench.common.undo", "撤销"),
        payload: {
          kind: "delete-commit" as const,
          repoRoot: String(undoPayload?.repoRoot || "").trim() || undefined,
          oldHead: undoOldHead,
          newHead: undoNewHead,
        },
      }
    : undefined;
  return {
    action,
    tone,
    title,
    message,
    detailLines: detailLines.length > 0 ? detailLines : undefined,
    undo,
    reasonCode: String(candidate.reasonCode || "").trim() || undefined,
    operationState: operationState === "rebasing" || operationState === "merging" || operationState === "grafting" || operationState === "reverting" || operationState === "normal"
      ? operationState
      : undefined,
    shouldRefresh: candidate.shouldRefresh === true,
    completed: candidate.completed !== false,
  };
}

/**
 * 为 interactive rebase 当前详情选择一个稳定的 diff 目标文件，优先保留旧选区，否则回退首个文件。
 */
function resolveInteractiveRebaseDiffPath(
  details: GitLogDetails | null | undefined,
  selectedDiffPathByHash: Record<string, string>,
  hash: string,
): string {
  if (!details || details.mode !== "single" || details.detail.hash !== hash) return "";
  const files = details.detail.files || [];
  if (files.length <= 0) return "";
  const remembered = String(selectedDiffPathByHash[hash] || "").trim();
  if (remembered && files.some((file) => file.path === remembered)) return remembered;
  return String(files[0]?.path || "").trim();
}

const LOG_PAGE_SIZE = 200;
const LOG_BRANCH_GROUP_MAX_VISIBLE = 2;
const LOG_TAG_GROUP_MAX_VISIBLE = 1;
const GIT_CONSOLE_VIEW_LIMIT = 250;
const GIT_CONSOLE_COPY_LIMIT = 500;
const DEFAULT_BOTTOM_HEIGHT = 260;
const DEFAULT_LEFT_PANEL_WIDTH = 360;
const DEFAULT_BRANCH_PANEL_WIDTH = 220;
const DEFAULT_DETAIL_PANEL_WIDTH = 320;
const SPLITTER_SIZE = 8;
const COLLAPSED_BOTTOM_HEIGHT = 28;
const GIT_LAYOUT_STORAGE_KEY = "cf.gitWorkbench.layout.v1";
const GIT_NOTICE_AUTO_CLOSE_MS = 30_000;
const TOOLBAR_MENU_PANEL_CLASS = "min-w-[140px] rounded-[10px] border border-[color:var(--cf-border)] bg-[var(--cf-surface-solid)] p-0.5 shadow-[0_10px_24px_rgba(15,23,42,0.12)]";
const TOOLBAR_MENU_ITEM_CLASS = "!min-h-[26px] gap-2 rounded-[7px] !px-2 !py-1 !text-[12px] font-apple-medium !leading-4 text-[var(--cf-text-primary)]";
const TOOLBAR_MENU_LABEL_CLASS = "!px-2 !pb-0.5 !pt-1 !text-[10px] font-apple-medium !leading-4 normal-case tracking-[0.01em] text-[var(--cf-text-secondary)]";
const TOOLBAR_MENU_SEPARATOR_CLASS = "my-1";
const TOOLBAR_SUBMENU_TRIGGER_CLASS = "flex min-h-[26px] w-full items-center justify-between gap-2 rounded-[7px] px-2 py-1 text-[12px] font-apple-medium leading-4 text-[var(--cf-text-primary)] transition-all duration-apple-fast hover:bg-[var(--cf-surface-hover)]";
const DEFAULT_GIT_VIEW_OPTIONS: GitStatusSnapshot["viewOptions"] = {
  groupByDirectory: true,
  groupingKeys: ["directory", "module", "repository"],
  availableGroupingKeys: ["directory"],
  showIgnored: false,
  detailsPreviewShown: true,
  diffPreviewOnDoubleClickOrEnter: true,
  manyFilesThreshold: 1000,
};
const DEFAULT_LOCAL_CHANGES_CONFIG = {
  stagingAreaEnabled: false,
  changeListsEnabled: true,
  commitAllEnabled: true,
} as const;

const DEFAULT_LOG_FILTERS: GitLogFilters = normalizeGitLogFilters({
  text: "",
  caseSensitive: false,
  matchMode: "fuzzy",
  branch: "all",
  author: "",
  dateFrom: "",
  dateTo: "",
  path: "",
  revision: "",
  followRenames: false,
});

const LOG_ROW_HEIGHT = 32;
const VIRTUAL_OVERSCAN = 8;
const CONTEXT_MENU_SAFE_GAP = 6;
const TREE_DEPTH_INDENT = 18;
const DETAIL_TREE_BASE_PADDING = 12;
const GIT_PANEL_CLASS = "cf-git-pane flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-surface-solid)]";
const GIT_PANEL_HEADER_CLASS = "cf-git-pane-header flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple px-1.5 py-[3px]";
const GIT_STICKY_HEADER_CLASS = "cf-git-pane-header sticky top-0 z-10 flex items-center justify-between border-b border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple px-1.5 py-[3px]";
const GIT_PANEL_FOOTER_CLASS = "cf-git-pane-footer shrink-0 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple px-1.5 py-1";
const GIT_SPLITTER_CLASS = "cf-git-splitter group relative";
const GIT_BOTTOM_TABS_LIST_CLASS = "cf-git-bottom-tabs-list gap-0.5 p-[3px]";
const GIT_BOTTOM_TABS_TRIGGER_CLASS = "cf-git-bottom-tabs-trigger shadow-none dark:shadow-none";
const GIT_TONE_CLASSNAME: Record<GitUiTone, string> = {
  accent: "cf-git-tone-accent",
  success: "cf-git-tone-success",
  warning: "cf-git-tone-warning",
  danger: "cf-git-tone-danger",
  info: "cf-git-tone-info",
  muted: "cf-git-tone-muted",
};

type GitWorkbenchLayout = {
  leftPanelWidth: number;
  leftPanelProportion?: number | null;
  branchPanelWidth: number;
  branchPanelProportion?: number | null;
  detailPanelWidth: number;
  detailPanelProportion?: number | null;
  bottomHeight: number;
  ignoreWhitespace: boolean;
  diffMode: "side" | "unified";
  collapseUnchanged: boolean;
  highlightWords: boolean;
};

type DetailTreeNode = {
  key: string;
  name: string;
  fullPath: string;
  isFile: boolean;
  count: number;
  status?: string;
  oldPath?: string;
  filePaths: string[];
  children: DetailTreeNode[];
};

type WorktreeTreeRow = {
  key: string;
  depth: number;
  kind: "group" | "repo" | "item";
  canExpand: boolean;
  expanded: boolean;
  label: string;
  secondary?: string;
  item?: GitWorktreeItem;
  isMainWorktree?: boolean;
  isCurrentWorktree?: boolean;
};

type FlowFeedbackTone = "info" | "warn";

type FlowFeedbackState = {
  tone: FlowFeedbackTone;
  message: string;
};

type GitNoticeTone = FlowFeedbackTone | "danger";

type GitNoticeActionItem = {
  id: string;
  label: string;
  onClick(): void | Promise<void>;
};

type GitNoticeItem = {
  id: number;
  requestId?: number;
  action: string;
  tone: GitNoticeTone;
  message: string;
  detailLines?: string[];
  running: boolean;
  createdAt: number;
  updateNotification?: GitUpdateSessionNotificationData;
  actions?: GitNoticeActionItem[];
};

type GitDeletedBranchRecoveryInfo = {
  forcedAfterNotFullyMerged?: boolean;
  deletedBranchName?: string;
  deletedTipHash?: string;
  baseBranch?: string;
  viewRevision?: string;
  trackedRemoteRef?: string;
  canDeleteTrackedBranch?: boolean;
};

type GitDeletedTagRecoveryInfo = {
  deletedTagName?: string;
  deletedTagTarget?: string;
};

type PushExecutionPayload = {
  targetHash?: string;
  forceWithLease?: boolean;
  forcePush?: boolean;
  force?: boolean;
  pushTags?: boolean;
  pushTagMode?: "all" | "follow";
  setUpstream?: boolean;
  updateIfRejected?: boolean;
  skipHook?: boolean;
  skipHooks?: boolean;
};

type UpdateCommitRangeChoiceState = {
  notification: GitUpdateSessionNotificationData;
  ranges: GitUpdateNotificationRange[];
};

type BranchCompareState = {
  repoRoot: string;
  leftRef: string;
  rightRef: string;
  revision: string;
};

type BranchCompareFilesDialogState = GitBranchCompareFilesResult;

type BranchRemoteManagerDialogState = {
  repoRoot: string;
};

/**
 * 判断当前 Diff 模式是否支持直接导出 Patch。
 */
function canExportPatchFromDiffMode(mode?: GitDiffMode): boolean {
  return mode === "working"
    || mode === "staged"
    || mode === "localToStaged"
    || mode === "stagedToLocal"
    || mode === "commit"
    || mode === "shelf"
    || mode === "revisionToRevision";
}

/**
 * 判断当前 Diff 是否支持解析到一个可被外部 IDE / 系统程序直接打开的真实文件目标。
 */
function canOpenExternalDiffTarget(diff: GitDiffSnapshot | null | undefined): boolean {
  const mode = diff?.mode;
  return !!diff?.path && (
    mode === "working"
    || mode === "staged"
    || mode === "localToStaged"
    || mode === "stagedToLocal"
    || mode === "commit"
    || mode === "revisionToWorking"
    || mode === "parentToWorking"
    || mode === "revisionToRevision"
  );
}

/**
 * 判断当前 Diff 是否属于 stage 专用比较模式，供失效清理与入口高亮复用。
 */
function isStageCompareDiffMode(mode?: GitDiffMode): boolean {
  return mode === "localToStaged" || mode === "stagedToLocal";
}

/**
 * 把双栏 Diff 快照的一侧文本转换为三栏只读对话框可消费的 pane 状态。
 */
function resolveStageThreeWayPaneState(
  snapshot: GitDiffSnapshot | null | undefined,
  side: "left" | "right",
  label: string,
): { text: string; renderable: boolean; fallbackText: string; label: string } {
  if (!snapshot) {
    return {
      label,
      text: "",
      renderable: false,
      fallbackText: gitWorkbenchText(
        side === "left" ? "workbench.stageThreeWay.headUnavailable" : "workbench.stageThreeWay.workingTreeUnavailable",
        "{{label}} 快照不可用",
        { label },
      ),
    };
  }
  if (snapshot.isBinary) {
    return {
      label,
      text: "",
      renderable: false,
      fallbackText: snapshot.tooLarge
        ? gitWorkbenchText(
            side === "left" ? "workbench.stageThreeWay.headTooLarge" : "workbench.stageThreeWay.workingTreeTooLarge",
            "{{label}} 内容过大，无法在应用内展示",
            { label },
          )
        : gitWorkbenchText(
            side === "left" ? "workbench.stageThreeWay.headBinary" : "workbench.stageThreeWay.workingTreeBinary",
            "{{label}} 为二进制内容，暂不支持内联展示",
            { label },
          ),
    };
  }
  return {
    label,
    text: side === "left" ? String(snapshot.leftText || "") : String(snapshot.rightText || ""),
    renderable: true,
    fallbackText: "",
  };
}

/**
 * 基于流程动作返回值生成顶部提示文案，覆盖 fetch/pull/push/分支更新与推送。
 */
function buildFlowFeedback(
  action: "fetch" | "pull" | "push" | "updateBranch" | "pushBranch",
  data: any,
  options?: { branchName?: string },
): FlowFeedbackState | null {
  if (!data) return null;
  const branchName = String(options?.branchName || "").trim();
  if (action === "fetch") {
    if (data?.skipped === true) {
      return {
        tone: "warn",
        message: gitWorkbenchText("flow.fetchSkipped", "已跳过获取：{{reason}}", { reason: String(data?.reason || gitWorkbenchText("flow.noAvailableRemote", "未命中可用远端")) }),
      };
    }
    const fetchedRemotes = Array.isArray(data?.fetchedRemotes)
      ? data.fetchedRemotes.map((one: any) => String(one || "").trim()).filter(Boolean)
      : [];
    if (fetchedRemotes.length > 0) {
      return {
        tone: "info",
        message: gitWorkbenchText("flow.fetchRemotes", "已获取远端：{{remotes}}", { remotes: fetchedRemotes.join("、") }),
      };
    }
    if (data?.fallback === true) {
      return {
        tone: "info",
        message: gitWorkbenchText("flow.fetchFallbackDone", "已完成获取（使用默认 Git 流程）"),
      };
    }
    return {
      tone: "info",
      message: gitWorkbenchText("flow.noFetchRemotes", "当前仓库没有可获取的远端"),
    };
  }

  if (action === "pull" || action === "updateBranch") {
    const subject = branchName ? gitWorkbenchText("flow.branchWithName", "分支 '{{name}}'", { name: branchName }) : gitWorkbenchText("flow.currentBranch", "当前分支");
    const upstream = String(data?.upstream || "").trim();
    const upstreamSuffix = upstream ? `（${upstream}）` : "";
    if (data?.nothingToUpdate === true || data?.method === "none") {
      return {
        tone: "info",
        message: gitWorkbenchText("flow.upToDate", "{{subject}} 已是最新{{upstreamSuffix}}", { subject, upstreamSuffix }),
      };
    }
    if (data?.fastForwardOptimized === true) {
      return {
        tone: "info",
        message: gitWorkbenchText("flow.fastForwardUpdated", "{{subject}} 已通过快速前移更新{{upstreamSuffix}}，并保留本地改动", { subject, upstreamSuffix }),
      };
    }
    if (data?.method === "fetch") {
      return {
        tone: "info",
        message: gitWorkbenchText("flow.remoteRefUpdated", "已更新 {{subject}} 的远端引用{{upstreamSuffix}}", { subject, upstreamSuffix }),
      };
    }
    const methodMap: Record<string, string> = {
      rebase: gitWorkbenchText("flow.methodRebase", "变基"),
      merge: gitWorkbenchText("flow.methodMerge", "合并"),
      reset: gitWorkbenchText("flow.methodReset", "Reset"),
    };
    const methodLabel = methodMap[String(data?.method || "").trim()] || gitWorkbenchText("flow.methodPull", "拉取");
    const preservingState = data?.preservingState && typeof data.preservingState === "object"
      ? data.preservingState
      : undefined;
    const preservingStatus = String(preservingState?.status || "").trim();
    if (preservingStatus === "restore-failed" || preservingStatus === "kept-saved") {
      const notRestoredMessage = String(preservingState?.message || "").trim();
      return {
        tone: "warn",
        message: upstream
          ? gitWorkbenchText("flow.updatedWithUpstreamAndRestoreFailed", "已通过 {{method}} 更新{{subject}}{{upstreamSuffix}}{{suffix}}", {
              method: methodLabel,
              subject,
              upstreamSuffix,
              suffix: notRestoredMessage ? `；${notRestoredMessage}` : gitWorkbenchText("flow.localChangesNotRestored", "，但本地改动未自动恢复"),
            })
          : gitWorkbenchText("flow.updatedAndRestoreFailed", "已通过 {{method}} 更新{{subject}}{{suffix}}", {
              method: methodLabel,
              subject,
              suffix: notRestoredMessage ? `；${notRestoredMessage}` : gitWorkbenchText("flow.localChangesNotRestored", "，但本地改动未自动恢复"),
            }),
      };
    }
    const suffixes: string[] = [];
    if (data?.preservedLocalChanges === true) suffixes.push(gitWorkbenchText("flow.preservedLocalChanges", "并保留本地改动"));
    if (data?.restoredLocalChanges === true) suffixes.push(gitWorkbenchText("flow.restoredLocalChanges", "已恢复本地改动"));
    const suffixText = suffixes.length > 0 ? `，${suffixes.join("，")}` : "";
    return {
      tone: "info",
      message: upstream
        ? gitWorkbenchText("flow.updatedWithUpstream", "已通过 {{method}} 更新{{subject}}{{upstreamSuffix}}{{suffixText}}", {
            method: methodLabel,
            subject,
            upstreamSuffix,
            suffixText,
          })
        : gitWorkbenchText("flow.updated", "已通过 {{method}} 更新{{subject}}{{suffixText}}", {
            method: methodLabel,
            subject,
            suffixText,
          }),
    };
  }

  if (action === "push" || action === "pushBranch") {
    const remote = String(data?.remote || "").trim();
    const remoteBranch = String(data?.remoteBranch || "").trim();
    let message = branchName ? gitWorkbenchText("flow.pushedBranch", "已推送分支 '{{name}}'", { name: branchName }) : gitWorkbenchText("flow.pushDone", "已完成推送");
    if (remote) {
      message += remoteBranch
        ? gitWorkbenchText("flow.pushToRemoteBranch", " 到 '{{remote}}/{{remoteBranch}}'", { remote, remoteBranch })
        : gitWorkbenchText("flow.pushToRemote", " 到 '{{remote}}'", { remote });
    }
    if (data?.upstreamSet === true) message += gitWorkbenchText("flow.upstreamSet", "，并已设置上游分支");
    if (data?.autoUpdated === true) {
      const attempts = Math.max(1, Math.floor(Number(data?.attempts) || 1));
      message += gitWorkbenchText("flow.pushAutoUpdated", "，推送前已自动更新并重试 {{count}} 次", { count: attempts });
      return { tone: "warn", message };
    }
    if (data?.retried === true) {
      const attempts = Math.max(1, Math.floor(Number(data?.attempts) || 1));
      message += attempts > 1 ? gitWorkbenchText("flow.retryCount", "，已重试 {{count}} 次", { count: attempts }) : gitWorkbenchText("flow.retried", "，已重试");
    }
    return { tone: "info", message };
  }

  return null;
}

/**
 * 提取“智能签出”提示所需的数据源；普通签出直接读取根结果，签出并更新则只读取后端显式透传的 smartCheckoutResult。
 */
function resolveSmartSwitchNoticeData(
  action: "branch.switch" | "branch.action",
  data: any,
): any {
  if (!data || typeof data !== "object") return null;
  if (action === "branch.switch") return data;
  const smartCheckoutResult = data?.smartCheckoutResult;
  return smartCheckoutResult && typeof smartCheckoutResult === "object" ? smartCheckoutResult : null;
}

/**
 * 根据智能签出返回值生成顶部提示文案；仅当签出流程实际走过“保存/恢复本地改动”链路时才返回结果。
 */
function buildSmartSwitchFeedback(
  data: any,
  targetBranch: string,
): FlowFeedbackState | null {
  if (!data || typeof data !== "object") return null;
  const preservingState = data?.preservingState && typeof data?.preservingState === "object"
    ? data.preservingState
    : undefined;
  const preservingStatus = String(preservingState?.status || "").trim();
  const smartCheckoutTriggered = data?.savedLocalChanges === true
    || data?.restoredLocalChanges === true
    || !!preservingState;
  if (!smartCheckoutTriggered) return null;
  const targetLabel = String(targetBranch || "").trim() ? gitWorkbenchText("flow.branchWithName", "分支 '{{name}}'", { name: String(targetBranch || "").trim() }) : gitWorkbenchText("flow.targetBranch", "目标分支");
  if (preservingStatus === "restore-failed" || preservingStatus === "kept-saved") {
    const detail = String(preservingState?.message || "").trim();
    return {
      tone: "warn",
      message: detail
        ? gitWorkbenchText("flow.smartSwitchFailedWithDetail", "已智能签出到{{targetLabel}}；{{detail}}", { targetLabel, detail })
        : gitWorkbenchText("flow.smartSwitchFailed", "已智能签出到{{targetLabel}}，但本地改动未自动恢复", { targetLabel }),
    };
  }
  if (data?.restoredLocalChanges === true || preservingStatus === "restored") {
    return {
      tone: "info",
      message: gitWorkbenchText("flow.smartSwitchRestored", "已智能签出到{{targetLabel}}，并恢复本地改动", { targetLabel }),
    };
  }
  return {
    tone: "info",
    message: gitWorkbenchText("flow.smartSwitchDone", "已智能签出到{{targetLabel}}", { targetLabel }),
  };
}

const TRACKED_BRANCH_REPAIR_REASON_CODES = new Set<string>([
  "no-tracked-branch",
  "remote-missing",
]);

/**
 * 判断本次 Update Project 结果里是否包含可触发 tracked branch 修复对话框的问题。
 */
function hasTrackedBranchRepairCandidate(data: any): boolean {
  const roots = Array.isArray(data?.roots) ? data.roots : [];
  for (const root of roots) {
    const failureCode = String(root?.failureCode || "").trim();
    const skippedReasonCode = String(root?.skippedReasonCode || "").trim();
    if (TRACKED_BRANCH_REPAIR_REASON_CODES.has(failureCode) || TRACKED_BRANCH_REPAIR_REASON_CODES.has(skippedReasonCode)) {
      return true;
    }
  }
  const skippedRoots = Array.isArray(data?.skippedRoots) ? data.skippedRoots : [];
  for (const root of skippedRoots) {
    const reasonCode = String(root?.reasonCode || "").trim();
    if (TRACKED_BRANCH_REPAIR_REASON_CODES.has(reasonCode)) {
      return true;
    }
  }
  return false;
}

/**
 * 为 smart operation 问题构建默认标题，兼容旧返回值未显式提供标题的场景。
 */
function getDefaultSmartOperationProblemTitle(
  operation: GitUpdateOperationProblem["operation"],
  kind: GitUpdateOperationProblem["kind"],
): string {
  const operationLabel = operation === "reset"
    ? gitWorkbenchText("flow.operation.reset", "重置")
    : operation === "checkout"
      ? gitWorkbenchText("flow.operation.checkout", "签出")
      : operation === "cherry-pick"
        ? gitWorkbenchText("flow.operation.cherryPick", "优选")
        : gitWorkbenchText("flow.operation.merge", "合并");
  if (kind === "merge-conflict") return gitWorkbenchText("flow.mergeConflict", "合并过程中出现冲突");
  return kind === "untracked-overwritten"
    ? gitWorkbenchText("flow.untrackedOverwritten", "未跟踪文件会被 {{operationLabel}} 覆盖", { operationLabel })
    : gitWorkbenchText("flow.localChangesOverwritten", "本地改动会被 {{operationLabel}} 覆盖", { operationLabel });
}

/**
 * 为 smart operation 问题构建默认说明文案，兼容旧返回值未显式提供描述的场景。
 */
function getDefaultSmartOperationProblemDescription(
  operation: GitUpdateOperationProblem["operation"],
  kind: GitUpdateOperationProblem["kind"],
): string {
  const operationLabel = operation === "reset"
    ? gitWorkbenchText("flow.operation.reset", "重置")
    : operation === "checkout"
      ? gitWorkbenchText("flow.operation.checkout", "签出")
      : operation === "cherry-pick"
        ? gitWorkbenchText("flow.operation.cherryPick", "优选")
        : gitWorkbenchText("flow.operation.merge", "合并");
  if (kind === "merge-conflict") {
    return gitWorkbenchText("flow.resolveMergeConflictFirst", "请先解决当前合并冲突，并完成或中止本次合并，然后再继续后续操作。");
  }
  return kind === "untracked-overwritten"
    ? gitWorkbenchText("flow.untrackedOverwrittenDescription", "请先处理这些未跟踪文件后再继续本次 {{operationLabel}}。", { operationLabel })
    : gitWorkbenchText("flow.localChangesOverwrittenDescription", "请先处理这些本地改动后再继续本次 {{operationLabel}}。", { operationLabel });
}

/**
 * 判断当前问题是否属于“从修订恢复文件会覆盖本地修改”场景，供标题与动作文案走专用翻译分支。
 */
function isRestoreFromRevisionProblem(problem: {
  operation?: GitUpdateOperationProblem["operation"];
  source?: GitUpdateOperationProblem["source"];
  actions?: Array<{ payloadPatch?: Record<string, any> }>;
}): boolean {
  if (problem.operation !== "checkout" || problem.source !== "smart-operation") return false;
  return Array.isArray(problem.actions) && problem.actions.some((action) => action?.payloadPatch?.overwriteModified === true);
}

/**
 * 为结构化覆盖问题生成正式标题，统一用稳定 code 与 payload 推导，避免直接依赖主进程自由文本。
 */
function getLocalizedSmartOperationProblemTitle(problem: {
  operation: GitUpdateOperationProblem["operation"];
  kind: GitUpdateOperationProblem["kind"];
  source: GitUpdateOperationProblem["source"];
  actions: GitUpdateOperationProblem["actions"];
}): string {
  if (problem.kind === "merge-conflict") {
    if (problem.operation === "cherry-pick")
      return gitWorkbenchText("dialogs.smartOperation.titles.mergeConflict.cherryPick", "优选过程中出现冲突");
    return gitWorkbenchText("dialogs.smartOperation.titles.mergeConflict.merge", "合并过程中出现冲突");
  }
  if (isRestoreFromRevisionProblem(problem))
    return gitWorkbenchText("dialogs.smartOperation.titles.restoreFromRevision", "从修订恢复将覆盖本地修改");
  const titleGroup = problem.kind === "untracked-overwritten" ? "untrackedOverwritten" : "localChangesOverwritten";
  const operationKey = problem.operation === "reset"
    ? "reset"
    : problem.operation === "checkout"
      ? "checkout"
      : problem.operation === "cherry-pick"
        ? "cherryPick"
        : "merge";
  return gitWorkbenchText(
    `dialogs.smartOperation.titles.${titleGroup}.${operationKey}`,
    getDefaultSmartOperationProblemTitle(problem.operation, problem.kind),
  );
}

/**
 * 为结构化覆盖问题生成正式说明文案；已知问题统一走 i18n 资源，未知场景再回退旧描述。
 */
function getLocalizedSmartOperationProblemDescription(problem: {
  operation: GitUpdateOperationProblem["operation"];
  kind: GitUpdateOperationProblem["kind"];
  source: GitUpdateOperationProblem["source"];
  actions: GitUpdateOperationProblem["actions"];
}): string {
  if (problem.kind === "merge-conflict") {
    if (problem.operation === "cherry-pick")
      return gitWorkbenchText("dialogs.smartOperation.descriptions.mergeConflict.cherryPick", "当前仓库已进入优选冲突状态，请先解决冲突并继续或中止本次优选。");
    return gitWorkbenchText("dialogs.smartOperation.descriptions.mergeConflict.merge", "当前仓库已进入合并冲突状态，请先解决冲突并完成或中止本次合并，然后再继续后续更新操作。");
  }
  if (isRestoreFromRevisionProblem(problem))
    return gitWorkbenchText("dialogs.smartOperation.descriptions.restoreFromRevision", "目标文件在本地已修改。继续后会覆盖当前本地内容。");
  const descriptionGroup = problem.kind === "untracked-overwritten" ? "untrackedOverwritten" : "localChangesOverwritten";
  const operationKey = problem.operation === "reset"
    ? "reset"
    : problem.operation === "checkout"
      ? "checkout"
      : problem.operation === "cherry-pick"
        ? "cherryPick"
        : "merge";
  return gitWorkbenchText(
    `dialogs.smartOperation.descriptions.${descriptionGroup}.${operationKey}`,
    getDefaultSmartOperationProblemDescription(problem.operation, problem.kind),
  );
}

/**
 * 把 smart operation 的重试动作映射为可翻译文案，按 payload 区分智能签出、保存改动后重试与覆盖写回。
 */
function getLocalizedSmartOperationActionLabel(
  problem: Pick<GitUpdateOperationProblem, "operation">,
  action: Pick<GitUpdateProblemAction, "kind" | "label" | "payloadPatch">,
): string {
  const rawLabel = String(action.label || "").trim();
  if (action.kind === "smart") {
    const saveChangesPolicy = action.payloadPatch?.saveChangesPolicy === "shelve" ? "shelve" : "stash";
    if (action.payloadPatch?.smartCheckout === true)
      return gitWorkbenchText("dialogs.smartOperation.actions.smartCheckout.label", "智能签出");
    if (action.payloadPatch?.autoSaveLocalChanges === true) {
      return saveChangesPolicy === "shelve"
        ? gitWorkbenchText("dialogs.smartOperation.actions.retryWithShelve.label", "先搁置后重试")
        : gitWorkbenchText("dialogs.smartOperation.actions.retryWithStash.label", "先暂存后重试");
    }
  }
  if (action.kind === "force") {
    if (action.payloadPatch?.overwriteModified === true)
      return gitWorkbenchText("dialogs.smartOperation.actions.overwriteModified.label", "覆盖已修改的文件");
    if (action.payloadPatch?.forceCheckout === true)
      return gitWorkbenchText("dialogs.smartOperation.actions.forceCheckout.label", "强制签出");
    return gitWorkbenchText("dialogs.smartOperation.actions.force.label", problem.operation === "checkout" ? "强制签出" : "强制继续");
  }
  if (action.kind === "rollback")
    return gitWorkbenchText("dialogs.smartOperation.actions.rollback.label", rawLabel || "回滚这些更改");
  return rawLabel;
}

/**
 * 把 smart operation 的辅助说明映射到资源文件，保证“搁置/暂存/智能签出”提示可审查可翻译。
 */
function getLocalizedSmartOperationActionDescription(
  action: Pick<GitUpdateProblemAction, "kind" | "description" | "payloadPatch">,
): string | undefined {
  const rawDescription = String(action.description || "").trim() || undefined;
  if (action.kind !== "smart") return rawDescription;
  const saveChangesPolicy = action.payloadPatch?.saveChangesPolicy === "shelve" ? "shelve" : "stash";
  if (action.payloadPatch?.smartCheckout === true) {
    return saveChangesPolicy === "shelve"
      ? gitWorkbenchText("dialogs.smartOperation.actions.smartCheckout.description.shelve", "先搁置本地改动，签出完成后再尝试恢复。")
      : gitWorkbenchText("dialogs.smartOperation.actions.smartCheckout.description.stash", "先暂存本地改动，签出完成后再尝试恢复。");
  }
  if (action.payloadPatch?.autoSaveLocalChanges === true) {
    return saveChangesPolicy === "shelve"
      ? gitWorkbenchText("dialogs.smartOperation.actions.retryWithShelve.description", "先搁置本地改动，成功后再自动恢复并重试当前操作。")
      : gitWorkbenchText("dialogs.smartOperation.actions.retryWithStash.description", "先暂存本地改动，成功后再自动恢复并重试当前操作。");
  }
  return rawDescription;
}

/**
 * 从 Git 操作返回值中提取统一问题模型，优先使用顶层结构化字段，再兼容旧版 smart operation/merge failure 契约。
 */
function extractOperationProblem(data: any): GitUpdateOperationProblem | null {
  const directProblem = data?.operationProblem;
  const rootProblem = Array.isArray(data?.roots)
    ? data.roots
      .map((root: any) => root?.data?.operationProblem)
      .find((candidate: any) => candidate && typeof candidate === "object")
    : null;
  const legacyDirectFileList = data?.smartOperationProblem || data?.mergeFailure?.problem || data?.mergeFailure?.fileList;
  const legacyRootFileList = Array.isArray(data?.roots)
    ? data.roots
      .map((root: any) => root?.data?.operationProblem || root?.data?.mergeFailure?.problem || root?.data?.smartOperationProblem || root?.data?.mergeFailure?.fileList)
      .find((candidate: any) => candidate && typeof candidate === "object")
    : null;
  const problem = directProblem && typeof directProblem === "object"
    ? directProblem
    : rootProblem && typeof rootProblem === "object"
      ? rootProblem
      : legacyDirectFileList && typeof legacyDirectFileList === "object"
        ? legacyDirectFileList
        : legacyRootFileList;
  if (!problem || typeof problem !== "object") return null;
  const files = Array.isArray(problem.files)
    ? problem.files.map((item: unknown) => String(item || "").trim()).filter(Boolean)
    : [];
  const kind = String(problem.kind || "").trim();
  if (
    kind !== "local-changes-overwritten"
    && kind !== "untracked-overwritten"
    && kind !== "merge-conflict"
  ) {
    return null;
  }
  const operationRaw = String(problem.operation || "").trim();
  const operation = operationRaw === "reset" || operationRaw === "checkout" || operationRaw === "merge" || operationRaw === "cherry-pick"
    ? operationRaw
    : "merge";
  const source = problem.source === "branch-switch" || problem.source === "merge-failure" || problem.source === "smart-operation"
    ? problem.source
    : "smart-operation";
  const actions = Array.isArray(problem.actions)
    ? problem.actions
      .map((action: any) => {
        const actionKind = String(action?.kind || "").trim();
        if (actionKind !== "smart" && actionKind !== "force" && actionKind !== "rollback") return null;
        const payloadPatch = action?.payloadPatch && typeof action.payloadPatch === "object"
          ? action.payloadPatch
          : {};
        const normalizedAction = {
          kind: actionKind as GitUpdateOperationProblem["actions"][number]["kind"],
          label: String(action?.label || "").trim(),
          description: String(action?.description || "").trim() || undefined,
          payloadPatch,
          variant: action?.variant === "danger" || action?.variant === "primary" || action?.variant === "secondary"
            ? action.variant
            : undefined,
        } satisfies GitUpdateOperationProblem["actions"][number];
        return {
          ...normalizedAction,
          label: getLocalizedSmartOperationActionLabel({ operation }, normalizedAction),
          description: getLocalizedSmartOperationActionDescription(normalizedAction),
        };
      })
      .filter((action: GitUpdateOperationProblem["actions"][number] | null): action is GitUpdateOperationProblem["actions"][number] => !!action)
    : [];
  const normalizedProblem = {
    operation,
    kind: kind as GitUpdateOperationProblem["kind"],
    source,
    actions,
  } satisfies Pick<GitUpdateOperationProblem, "operation" | "kind" | "source" | "actions">;
  return {
    operation,
    kind,
    title: getLocalizedSmartOperationProblemTitle(normalizedProblem),
    description: getLocalizedSmartOperationProblemDescription(normalizedProblem),
    files,
    source,
    repoRoot: String(problem.repoRoot || "").trim() || undefined,
    rootName: String(problem.rootName || "").trim() || undefined,
    mergeFailureType: problem.mergeFailureType,
    actions,
  };
}

/**
 * 校验并规整单个更新范围对象，避免工作台结果卡片依赖未校验的 IPC 数据。
 */
function normalizeUpdateNotificationRange(candidate: any): GitUpdateNotificationRange | null {
  if (!candidate || typeof candidate !== "object") return null;
  const repoRoot = String(candidate.repoRoot || "").trim();
  const rootName = String(candidate.rootName || "").trim();
  const start = String(candidate.range?.start || "").trim();
  const end = String(candidate.range?.end || "").trim();
  if (!repoRoot || !rootName || !start || !end || start === end) return null;
  return {
    repoRoot,
    rootName,
    branch: String(candidate.branch || "").trim() || undefined,
    upstream: String(candidate.upstream || "").trim() || undefined,
    method: String(candidate.method || "").trim() || undefined,
    range: {
      start,
      end,
    },
    commitCount: Math.max(0, Math.floor(Number(candidate.commitCount) || 0)),
    fileCount: Math.max(0, Math.floor(Number(candidate.fileCount) || 0)),
  };
}

/**
 * 从进度事件中提取结构化 update session 快照，避免运行中会话视图直接依赖未校验对象。
 */
function extractUpdateSessionProgressSnapshot(data: any): GitUpdateSessionProgressSnapshot | null {
  if (!data || typeof data !== "object") return null;
  const roots = Array.isArray(data.roots)
    ? data.roots
      .map((root: any) => {
        const repoRoot = String(root?.repoRoot || "").trim();
        const rootName = String(root?.rootName || "").trim();
        if (!repoRoot || !rootName) return null;
        return {
          repoRoot,
          rootName,
          kind: root?.kind === "submodule" ? "submodule" : "repository",
          parentRepoRoot: String(root?.parentRepoRoot || "").trim() || undefined,
          currentPhase: String(root?.currentPhase || "").trim() as GitUpdateSessionProgressSnapshot["roots"][number]["currentPhase"],
          resultCode: String(root?.resultCode || "").trim() as GitUpdateSessionProgressSnapshot["roots"][number]["resultCode"],
          failureCode: String(root?.failureCode || "").trim() as GitUpdateSessionProgressSnapshot["roots"][number]["failureCode"],
          skippedReason: String(root?.skippedReason || "").trim() || undefined,
          skippedReasonCode: String(root?.skippedReasonCode || "").trim() as GitUpdateSessionProgressSnapshot["roots"][number]["skippedReasonCode"],
          fetchResult: root?.fetchResult && typeof root.fetchResult === "object"
            ? {
                status: String(root.fetchResult.status || "").trim() as NonNullable<GitUpdateSessionProgressSnapshot["roots"][number]["fetchResult"]>["status"],
                strategy: String(root.fetchResult.strategy || "").trim() as NonNullable<GitUpdateSessionProgressSnapshot["roots"][number]["fetchResult"]>["strategy"],
                remotes: Array.isArray(root.fetchResult.remotes) ? root.fetchResult.remotes.map((item: any) => String(item || "").trim()).filter(Boolean) : [],
                fetchedRemotes: Array.isArray(root.fetchResult.fetchedRemotes) ? root.fetchResult.fetchedRemotes.map((item: any) => String(item || "").trim()).filter(Boolean) : [],
                failedRemotes: Array.isArray(root.fetchResult.failedRemotes)
                  ? root.fetchResult.failedRemotes
                    .map((item: any) => ({
                      remote: String(item?.remote || "").trim(),
                      error: String(item?.error || "").trim(),
                    }))
                    .filter((item: { remote: string; error: string }) => !!item.remote || !!item.error)
                  : [],
                upstream: String(root.fetchResult.upstream || "").trim() || undefined,
                trackedRemote: String(root.fetchResult.trackedRemote || "").trim() || undefined,
                skippedReason: String(root.fetchResult.skippedReason || "").trim() || undefined,
                error: String(root.fetchResult.error || "").trim() || undefined,
              }
            : undefined,
          unfinishedState: root?.unfinishedState && typeof root.unfinishedState === "object"
            ? {
                code: String(root.unfinishedState.code || "").trim() as NonNullable<GitUpdateSessionProgressSnapshot["roots"][number]["unfinishedState"]>["code"],
                stage: String(root.unfinishedState.stage || "").trim() as NonNullable<GitUpdateSessionProgressSnapshot["roots"][number]["unfinishedState"]>["stage"],
                localChangesRestorePolicy: String(root.unfinishedState.localChangesRestorePolicy || "").trim() as NonNullable<GitUpdateSessionProgressSnapshot["roots"][number]["unfinishedState"]>["localChangesRestorePolicy"],
                savedLocalChangesRef: String(root.unfinishedState.savedLocalChangesRef || "").trim() || undefined,
                message: String(root.unfinishedState.message || "").trim(),
              }
            : undefined,
          preservingState: root?.preservingState && typeof root.preservingState === "object"
            ? {
                saveChangesPolicy: root.preservingState.saveChangesPolicy === "shelve" ? "shelve" : "stash",
                status: String(root.preservingState.status || "").trim() as NonNullable<GitUpdateSessionProgressSnapshot["roots"][number]["preservingState"]>["status"],
                localChangesRestorePolicy: String(root.preservingState.localChangesRestorePolicy || "").trim() as NonNullable<GitUpdateSessionProgressSnapshot["roots"][number]["preservingState"]>["localChangesRestorePolicy"],
                savedLocalChangesRef: String(root.preservingState.savedLocalChangesRef || "").trim() || undefined,
                savedLocalChangesDisplayName: String(root.preservingState.savedLocalChangesDisplayName || "").trim() || undefined,
                message: String(root.preservingState.message || "").trim() || undefined,
                notRestoredReason: String(root.preservingState.notRestoredReason || "").trim() as NonNullable<GitUpdateSessionProgressSnapshot["roots"][number]["preservingState"]>["notRestoredReason"],
              }
            : undefined,
          submoduleUpdate: root?.submoduleUpdate && typeof root.submoduleUpdate === "object"
            ? {
                mode: String(root.submoduleUpdate.mode || "").trim() as NonNullable<GitUpdateSessionProgressSnapshot["roots"][number]["submoduleUpdate"]>["mode"],
                strategy: String(root.submoduleUpdate.strategy || "").trim() as NonNullable<GitUpdateSessionProgressSnapshot["roots"][number]["submoduleUpdate"]>["strategy"],
                parentRepoRoot: String(root.submoduleUpdate.parentRepoRoot || "").trim() || undefined,
                relativePath: String(root.submoduleUpdate.relativePath || "").trim() || undefined,
                recursive: root.submoduleUpdate.recursive === true,
                detachedHead: root.submoduleUpdate.detachedHead === true,
              }
            : undefined,
          operationProblem: root?.operationProblem && typeof root.operationProblem === "object"
            ? {
                operation: String(root.operationProblem.operation || "").trim() as GitUpdateOperationProblem["operation"],
                kind: String(root.operationProblem.kind || "").trim() as GitUpdateOperationProblem["kind"],
                title: String(root.operationProblem.title || "").trim(),
                description: String(root.operationProblem.description || "").trim(),
                files: Array.isArray(root.operationProblem.files)
                  ? root.operationProblem.files.map((item: any) => String(item || "").trim()).filter(Boolean)
                  : [],
                source: String(root.operationProblem.source || "").trim() as GitUpdateOperationProblem["source"],
                repoRoot: String(root.operationProblem.repoRoot || "").trim() || undefined,
                rootName: String(root.operationProblem.rootName || "").trim() || undefined,
                mergeFailureType: String(root.operationProblem.mergeFailureType || "").trim() as GitUpdateOperationProblem["mergeFailureType"],
                actions: Array.isArray(root.operationProblem.actions)
                  ? root.operationProblem.actions
                    .map((action: any) => ({
                      kind: String(action?.kind || "").trim(),
                      label: String(action?.label || "").trim(),
                      description: String(action?.description || "").trim() || undefined,
                      payloadPatch: action?.payloadPatch && typeof action.payloadPatch === "object" ? action.payloadPatch : {},
                      variant: String(action?.variant || "").trim() as GitUpdateOperationProblem["actions"][number]["variant"],
                    }))
                    .filter((action: GitUpdateOperationProblem["actions"][number]) => !!action.kind && !!action.label)
                  : [],
              }
            : undefined,
        };
      })
      .filter((root: GitUpdateSessionProgressSnapshot["roots"][number] | null): root is GitUpdateSessionProgressSnapshot["roots"][number] => !!root)
    : [];
  if (roots.length <= 0) return null;
  return {
    requestedRepoRoot: String(data.requestedRepoRoot || "").trim(),
    currentPhase: String(data.currentPhase || "").trim() as GitUpdateSessionProgressSnapshot["currentPhase"],
    activeRepoRoot: String(data.activeRepoRoot || "").trim() || undefined,
    activeRootName: String(data.activeRootName || "").trim() || undefined,
    activePhase: String(data.activePhase || "").trim() as GitUpdateSessionProgressSnapshot["activePhase"],
    cancelled: data.cancelled === true,
    cancelReason: String(data.cancelReason || "").trim() || undefined,
    totalRoots: Math.max(0, Math.floor(Number(data.totalRoots) || 0)),
    completedRoots: Math.max(0, Math.floor(Number(data.completedRoots) || 0)),
    runningRoots: Math.max(0, Math.floor(Number(data.runningRoots) || 0)),
    remainingRoots: Math.max(0, Math.floor(Number(data.remainingRoots) || 0)),
    multiRoot: data.multiRoot === true,
    roots,
  };
}

/**
 * 把 update session 的跳过原因码转换为可翻译短文案，避免结果摘要直接渲染主进程自由文本。
 */
function resolveUpdateSkippedReasonText(reasonCode?: string, fallback?: string): string {
  switch (String(reasonCode || "").trim()) {
    case "requested":
      return gitWorkbenchText("dialogs.updateResult.skippedReasons.requested", "已按当前范围配置跳过");
    case "detached-head":
      return gitWorkbenchText("dialogs.updateResult.skippedReasons.detachedHead", "当前仓库处于游离 HEAD");
    case "no-tracked-branch":
      return gitWorkbenchText("dialogs.updateResult.skippedReasons.noTrackedBranch", "缺少可用的上游分支");
    case "remote-missing":
      return gitWorkbenchText("dialogs.updateResult.skippedReasons.remoteMissing", "上游分支在本地不存在或已失效");
    case "parent-failed":
      return gitWorkbenchText("dialogs.updateResult.skippedReasons.parentFailed", "父仓更新失败");
    case "fetch-failed":
      return gitWorkbenchText("dialogs.updateResult.skippedReasons.fetchFailed", "获取远端失败");
    case "updated-by-parent":
      return gitWorkbenchText("dialogs.updateResult.skippedReasons.updatedByParent", "已由父仓递归更新");
    default:
      return String(fallback || "").trim();
  }
}

/**
 * 统一解析 Update Session 顶部动作文案，确保通知卡片与日志入口不再依赖主进程返回标签。
 */
function resolveUpdateNotificationPostActionLabel(action: { kind?: string; label?: string }): string {
  const rawLabel = String(action.label || "").trim();
  switch (String(action.kind || "").trim()) {
    case "view-commits":
      return gitWorkbenchText("dialogs.updateResult.postActions.viewCommits", rawLabel || "查看提交");
    case "copy-revision-range":
      return gitWorkbenchText("dialogs.updateResult.postActions.copyRevisionRange", rawLabel || "复制提交范围");
    case "resolve-conflicts":
      return gitWorkbenchText("dialogs.updateResult.postActions.resolveConflicts", rawLabel || "处理该仓冲突");
    case "open-saved-changes":
      return gitWorkbenchText("dialogs.updateResult.postActions.openSavedChanges", rawLabel || "查看已保存改动");
    case "fix-tracked-branch":
      return gitWorkbenchText("dialogs.updateResult.postActions.fixTrackedBranch", rawLabel || "修复上游分支");
    case "open-parent-repo":
      return gitWorkbenchText("dialogs.updateResult.postActions.openParentRepo", rawLabel || "打开父仓");
    case "open-repo-root":
      return gitWorkbenchText("dialogs.updateResult.postActions.openRepoRoot", rawLabel || "打开该仓");
    case "retry-update-root":
      return gitWorkbenchText("dialogs.updateResult.postActions.retryUpdateRoot", rawLabel || "重试该仓更新");
    default:
      return rawLabel;
  }
}

/**
 * 从更新返回值中提取结果通知模型，供顶部结果卡片与“查看提交”入口复用。
 */
function extractUpdateSessionNotification(data: any): GitUpdateSessionNotificationData | null {
  const candidate = data?.notification;
  if (!candidate || typeof candidate !== "object") return null;
  const ranges = Array.isArray(candidate.ranges)
    ? candidate.ranges
      .map((item: any) => normalizeUpdateNotificationRange(item))
      .filter((item: GitUpdateNotificationRange | null): item is GitUpdateNotificationRange => !!item)
    : [];
  if (ranges.length <= 0) return null;
  const primaryRange = normalizeUpdateNotificationRange(candidate.primaryRange)
    || ranges.find((item: GitUpdateNotificationRange) => item.repoRoot === String(candidate.primaryRange?.repoRoot || "").trim())
    || ranges[0];
  const updatedFilesCount = Math.max(0, Math.floor(Number(candidate.updatedFilesCount) || 0))
    || ranges.reduce((sum: number, item: GitUpdateNotificationRange) => sum + item.fileCount, 0);
  const receivedCommitsCount = Math.max(0, Math.floor(Number(candidate.receivedCommitsCount) || 0))
    || ranges.reduce((sum: number, item: GitUpdateNotificationRange) => sum + item.commitCount, 0);
  const filteredCommitsCount = candidate.filteredCommitsCount == null
    ? undefined
    : Math.max(0, Math.floor(Number(candidate.filteredCommitsCount) || 0));
  const skippedRoots = Array.isArray(candidate.skippedRoots)
    ? candidate.skippedRoots
      .map((root: any) => {
        const repoRoot = String(root?.repoRoot || "").trim();
        const rootName = String(root?.rootName || "").trim();
        if (!repoRoot || !rootName) return null;
        const reasonCode = String(root?.reasonCode || "").trim() as GitUpdateSessionNotificationData["skippedRoots"][number]["reasonCode"];
        return {
          repoRoot,
          rootName,
          kind: root?.kind === "submodule" ? "submodule" : "repository",
          parentRepoRoot: String(root?.parentRepoRoot || "").trim() || undefined,
          reasonCode,
          reason: resolveUpdateSkippedReasonText(reasonCode, String(root?.reason || "").trim()),
        };
      })
      .filter((root: GitUpdateSessionNotificationData["skippedRoots"][number] | null): root is GitUpdateSessionNotificationData["skippedRoots"][number] => !!root && !!root.reason)
    : [];
  const descriptionParts: string[] = [];
  if (typeof filteredCommitsCount === "number" && filteredCommitsCount > 0 && filteredCommitsCount !== receivedCommitsCount) {
    descriptionParts.push(gitWorkbenchText("dialogs.updateResult.summary.filteredCommits", "当前日志视图聚焦主仓范围，可查看 {{count}} 个提交。", {
      count: filteredCommitsCount,
    }));
  }
  if (skippedRoots.length > 0) {
    descriptionParts.push(gitWorkbenchText("dialogs.updateResult.summary.skippedRoots", "另有 {{count}} 个仓库被跳过，可展开查看原因。", {
      count: skippedRoots.length,
    }));
  }
  return {
    title: gitWorkbenchText("dialogs.updateResult.summary.title", "{{files}} 个文件在 {{commits}} 个提交中已更新", {
      files: updatedFilesCount,
      commits: receivedCommitsCount,
    }),
    description: descriptionParts.join(" ") || undefined,
    updatedFilesCount,
    receivedCommitsCount,
    filteredCommitsCount,
    ranges,
    primaryRange,
    skippedRoots,
    postActions: Array.isArray(candidate.postActions)
      ? candidate.postActions
        .map((action: any) => ({
          kind: String(action?.kind || "").trim() as GitUpdatePostAction["kind"],
          label: resolveUpdateNotificationPostActionLabel(action),
          repoRoot: String(action?.repoRoot || "").trim() || undefined,
          revision: String(action?.revision || "").trim() || undefined,
          payload: action?.payload && typeof action.payload === "object" ? action.payload : undefined,
        }))
        .filter((action: GitUpdateSessionNotificationData["postActions"][number]) => !!action.kind && !!action.label)
      : [],
  };
}

/**
 * 构建正式的 Rebase 风险提示详情，统一基于结构化计数渲染，避免直接透传后端拼接文本。
 */
function resolveRebaseWarningDetails(warning: {
  type: GitUpdateRebaseWarning["type"];
  totalCommitCount?: number;
  publishedCommitCount?: number;
  mergeCommitCount?: number;
}): string | undefined {
  if (warning.type === "published-commits") {
    const published = Math.max(0, Math.floor(Number(warning.publishedCommitCount) || 0));
    const total = Math.max(0, Math.floor(Number(warning.totalCommitCount) || 0));
    if (published > 0 && total > 0) {
      return gitWorkbenchText("dialogs.rebaseWarning.details.publishedCommits", "检测到待变基的 {{total}} 个提交里至少有 {{published}} 个已经出现在远端引用中。", {
        total,
        published,
      });
    }
    if (published > 0) {
      return gitWorkbenchText("dialogs.rebaseWarning.details.publishedCommitsWithoutTotal", "检测到至少有 {{published}} 个待变基提交已经出现在远端引用中。", {
        published,
      });
    }
    return undefined;
  }
  const mergeCommitCount = Math.max(0, Math.floor(Number(warning.mergeCommitCount) || 0));
  if (mergeCommitCount > 0) {
    return gitWorkbenchText("dialogs.rebaseWarning.details.mergeCommits", "检测到 {{count}} 个合并提交。你可以改用合并更新，或明确确认后继续变基。", {
      count: mergeCommitCount,
    });
  }
  return undefined;
}

/**
 * 从结构化拒绝类型生成 Push Rejected 的标题与说明，统一收口英文/中文资源并按需追加 Git 输出。
 */
function buildLocalizedPushRejectedDescription(args: {
  type: GitPushRejectedDecision["type"];
  upstream?: string;
  remote?: string;
  remoteBranch?: string;
  detailText?: string;
}): { title: string; description: string } {
  const detailText = String(args.detailText || "").trim();
  const withDetail = (base: string): string => detailText
    ? gitWorkbenchText("dialogs.pushRejected.descriptions.withGitOutput", "{{base}}\n\nGit 输出：{{detail}}", {
        base,
        detail: detailText,
      })
    : base;
  if (args.type === "stale-info") {
    const base = gitWorkbenchText("dialogs.pushRejected.descriptions.staleInfo", "远端引用已变化，当前租约保护已过期。如果你仍想覆盖远端，请使用普通强制推送继续。");
    return {
      title: gitWorkbenchText("dialogs.pushRejected.titles.staleInfo", "带租约保护的强制推送被拒绝"),
      description: withDetail(base),
    };
  }
  if (args.type === "rejected-other") {
    const base = gitWorkbenchText("dialogs.pushRejected.descriptions.rejectedOther", "远端拒绝了推送。请先处理远端策略或服务端钩子限制，然后重试。");
    return {
      title: gitWorkbenchText("dialogs.pushRejected.titles.rejectedOther", "远端拒绝了推送"),
      description: withDetail(base),
    };
  }
  const base = args.upstream
    ? gitWorkbenchText("dialogs.pushRejected.descriptions.noFastForwardWithUpstream", "远端分支 {{upstream}} 已领先于当前分支，请先更新后再重试推送，或在确认覆盖远端时改用带租约保护的强制推送。", {
        upstream: args.upstream,
      })
    : gitWorkbenchText("dialogs.pushRejected.descriptions.noFastForwardWithRemote", "远端 {{remote}}/{{branch}} 已领先于当前分支，请先更新后再重试推送，或在确认覆盖远端时改用带租约保护的强制推送。", {
        remote: args.remote || "origin",
        branch: args.remoteBranch || "HEAD",
      });
  return {
    title: gitWorkbenchText("dialogs.pushRejected.titles.noFastForward", "推送被拒绝，需要先同步远端"),
    description: withDetail(base),
  };
}

/**
 * 统一解析 Push Rejected 动作文案，按 kind 生成稳定翻译，避免按钮直接显示主进程文案。
 */
function getLocalizedPushRejectedActionLabel(
  action: Pick<GitPushRejectedAction, "kind" | "label">,
): string {
  const rawLabel = String(action.label || "").trim();
  switch (action.kind) {
    case "update-with-merge":
      return gitWorkbenchText("dialogs.pushRejected.actions.updateWithMerge", rawLabel || "先更新（合并）再推送");
    case "update-with-rebase":
      return gitWorkbenchText("dialogs.pushRejected.actions.updateWithRebase", rawLabel || "先更新（变基）再推送");
    case "force-with-lease":
      return gitWorkbenchText("dialogs.pushRejected.actions.forceWithLease", rawLabel || "强制推送（保留租约保护）");
    case "force-push":
      return gitWorkbenchText("dialogs.pushRejected.actions.forcePush", rawLabel || "继续强制推送（无租约保护）");
    case "cancel":
      return gitWorkbenchText("dialogs.pushRejected.actions.cancel", rawLabel || "取消");
    default:
      return rawLabel;
  }
}

/**
 * 从 Update Project 返回值中提取结构化 rebase warning，供工作台弹出确认对话框。
 */
function extractRebaseWarning(data: any): GitUpdateRebaseWarning | null {
  const directWarning = data?.rebaseWarning;
  const rootWarning = Array.isArray(data?.roots)
    ? data.roots
      .map((root: any) => root?.data?.rebaseWarning)
      .find((candidate: any) => candidate && typeof candidate === "object")
    : null;
  const warning = directWarning && typeof directWarning === "object" ? directWarning : rootWarning;
  if (!warning || typeof warning !== "object") return null;
  const type = String(warning.type || "").trim();
  if (type !== "published-commits" && type !== "merge-commits") return null;
  const confirmPatch = warning.confirmAction?.payloadPatch && typeof warning.confirmAction.payloadPatch === "object"
    ? warning.confirmAction.payloadPatch
    : null;
  if (!confirmPatch) return null;
  const alternativeAction = warning.alternativeAction && typeof warning.alternativeAction === "object"
    ? {
        label: gitWorkbenchText("dialogs.rebaseWarning.actions.useMerge", "改用合并"),
        payloadPatch: warning.alternativeAction.payloadPatch && typeof warning.alternativeAction.payloadPatch === "object"
          ? warning.alternativeAction.payloadPatch
          : {},
      }
    : undefined;
  return {
    type,
    title: type === "published-commits"
      ? gitWorkbenchText("dialogs.rebaseWarning.titles.publishedCommits", "变基会改写已发布提交")
      : gitWorkbenchText("dialogs.rebaseWarning.titles.mergeCommits", "变基将跨越合并提交"),
    description: type === "published-commits"
      ? gitWorkbenchText("dialogs.rebaseWarning.descriptions.publishedCommits", "当前分支存在已经发布到远端的提交。继续变基会改写这些提交历史，可能影响其他协作者。")
      : gitWorkbenchText("dialogs.rebaseWarning.descriptions.mergeCommits", "当前分支包含合并提交。继续变基可能改变这些合并点的历史结构。"),
    details: resolveRebaseWarningDetails({
      type,
      totalCommitCount: warning.totalCommitCount,
      publishedCommitCount: warning.publishedCommitCount,
      mergeCommitCount: warning.mergeCommitCount,
    }) || String(warning.details || "").trim() || undefined,
    totalCommitCount: Math.max(0, Math.floor(Number(warning.totalCommitCount) || 0)) || undefined,
    publishedCommitCount: Math.max(0, Math.floor(Number(warning.publishedCommitCount) || 0)) || undefined,
    mergeCommitCount: Math.max(0, Math.floor(Number(warning.mergeCommitCount) || 0)) || undefined,
    confirmAction: {
      label: gitWorkbenchText("dialogs.rebaseWarning.actions.continueRebase", "仍然变基"),
      payloadPatch: confirmPatch,
    },
    alternativeAction,
    cancelText: gitWorkbenchText("dialogs.rebaseWarning.cancel", "取消"),
  };
}

/**
 * 判断当前 payload 是否已经显式携带运行期仓库范围；若已携带，则不再重复弹出一次性范围对话框。
 */
function hasExplicitRuntimeUpdateScopePayload(payload: Record<string, any> | null | undefined): boolean {
  const nextPayload = payload && typeof payload === "object" ? payload : {};
  const toStringList = (value: unknown): string[] => Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return toStringList(nextPayload.repoRoots).length > 0
    || toStringList(nextPayload.roots).length > 0
    || toStringList(nextPayload.additionalRepoRoots).length > 0
    || toStringList(nextPayload.skipRoots).length > 0
    || toStringList(nextPayload.skippedRoots).length > 0
    || Object.prototype.hasOwnProperty.call(nextPayload, "includeNestedRoots")
    || Object.prototype.hasOwnProperty.call(nextPayload, "includeDiscoveredNestedRoots")
    || Object.prototype.hasOwnProperty.call(nextPayload, "rootScanMaxDepth");
}

/**
 * 按 Git 常见报错关键字判断当前失败是否大概率已进入冲突状态，供 stash/unstash 等链路决定是否拉起统一冲突入口。
 */
function isLikelyConflictErrorText(error: unknown): boolean {
  const text = String(error || "").trim().toLowerCase();
  if (!text) return false;
  return text.includes("conflict")
    || text.includes("fix conflicts")
    || text.includes("resolve all conflicts")
    || text.includes("could not apply")
    || text.includes("merge conflict");
}

/**
 * 从 Push 返回值中提取结构化 rejected 决策模型，供前端进入正式 update / force / cancel 决策流。
 */
function extractPushRejectedDecision(data: any): GitPushRejectedDecision | null {
  const candidate = data?.pushRejected;
  if (!candidate || typeof candidate !== "object") return null;
  const type = String(candidate.type || "").trim();
  if (type !== "no-fast-forward" && type !== "stale-info" && type !== "rejected-other") return null;
  const actions = Array.isArray(candidate.actions)
    ? candidate.actions
      .map((action: any) => {
        const kind = String(action?.kind || "").trim();
        const label = String(action?.label || "").trim();
        if (!label) return null;
        if (
          kind !== "update-with-merge"
          && kind !== "update-with-rebase"
          && kind !== "force-with-lease"
          && kind !== "force-push"
          && kind !== "cancel"
        ) {
          return null;
        }
        return {
          kind: kind as GitPushRejectedAction["kind"],
          label: getLocalizedPushRejectedActionLabel({
            kind: kind as GitPushRejectedAction["kind"],
            label,
          }),
          payloadPatch: action?.payloadPatch && typeof action.payloadPatch === "object"
            ? action.payloadPatch
            : {},
          variant: action?.variant === "primary" || action?.variant === "secondary" || action?.variant === "danger"
            ? action.variant
            : undefined,
        } satisfies GitPushRejectedAction;
      })
      .filter((action: GitPushRejectedAction | null): action is GitPushRejectedAction => !!action)
    : [];
  if (actions.length <= 0) return null;
  const localizedDescription = buildLocalizedPushRejectedDescription({
    type,
    upstream: String(candidate.upstream || "").trim() || undefined,
    remote: String(candidate.remote || "").trim() || undefined,
    remoteBranch: String(candidate.remoteBranch || "").trim() || undefined,
    detailText: String(candidate.detailText || "").trim() || undefined,
  });
  return {
    type,
    title: localizedDescription.title,
    description: localizedDescription.description,
    detailText: String(candidate.detailText || "").trim() || undefined,
    branch: String(candidate.branch || "").trim() || undefined,
    upstream: String(candidate.upstream || "").trim() || undefined,
    remote: String(candidate.remote || "").trim() || undefined,
    remoteBranch: String(candidate.remoteBranch || "").trim() || undefined,
    actions,
  };
}

/**
 * 把 Update Project 配置中的更新方式转换为顶部提示可读文案。
 */
function getUpdateMethodPreferenceLabel(value: GitUpdateOptions["updateMethod"]): string {
  return resolveGitUpdateMethodLabel(value, gitWorkbenchText)
    || gitWorkbenchText("dialogs.updateOptions.methods.merge.title", "Merge");
}

/**
 * 把 save changes policy 转换为简短中文文案。
 */
function getSaveChangesPolicyLabel(value: GitUpdateOptions["saveChangesPolicy"]): string {
  return value === "shelve" ? gitWorkbenchText("flow.saveChanges.shelve", "搁置（shelve）") : gitWorkbenchText("flow.saveChanges.stash", "暂存（stash）");
}

/**
 * 判断当前顶部 Git 提示是否支持直接触发“取消更新项目”。
 */
function isCancellableGitNotice(notice: GitNoticeItem): boolean {
  return notice.running === true
    && Math.max(0, Math.floor(Number(notice.requestId) || 0)) > 0
    && notice.action === "flow.pull";
}

/**
 * 格式化提交时间显示。
 */
function toLocalDateText(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * 格式化日志表格中的紧凑日期，避免列宽不足导致文本重叠。
 */
function toCompactDateText(iso: string): string {
  if (!iso) return "";
  try {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return iso;
    return dt.toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

/**
 * 将路径归一化为可比较字符串（忽略大小写与分隔符差异）。
 */
function normalizePathKey(pathText: string): string {
  return String(pathText || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 提取路径末段名称，作为树节点展示名称。
 */
function getPathBaseName(pathText: string): string {
  const clean = String(pathText || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!clean) return "";
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] || clean;
}

/**
 * 将 Worktrees 列表映射为“Repositories”树形行。
 */
function buildWorktreeTreeRows(
  repoRoot: string,
  items: GitWorktreeItem[],
  expandedState: Record<string, boolean>,
): WorktreeTreeRow[] {
  const rows: WorktreeTreeRow[] = [];
  const currentPathKey = normalizePathKey(repoRoot);
  const uniqueMap = new Map<string, GitWorktreeItem>();
  for (const item of items) {
    const key = normalizePathKey(item.path);
    if (!key || uniqueMap.has(key)) continue;
    uniqueMap.set(key, item);
  }
  const uniqueItems = Array.from(uniqueMap.values());
  const mainWorktree = uniqueItems[0] || ({
    path: repoRoot,
    bare: false,
    detached: false,
  } as GitWorktreeItem);
  const mainPathKey = normalizePathKey(mainWorktree.path);
  const childItems = uniqueItems
    .filter((one) => normalizePathKey(one.path) !== mainPathKey)
    .sort((a, b) => String(a.path || "").localeCompare(String(b.path || "")));

  const groupKey = "worktrees.group.repositories";
  const repoNodeKey = `worktrees.repo.${mainPathKey || "current"}`;
  const groupExpanded = expandedState[groupKey] !== false;
  const repoExpanded = expandedState[repoNodeKey] !== false;
  const repoLabel = getPathBaseName(mainWorktree.path || repoRoot) || gitWorkbenchText("workbench.worktrees.mainRepository", "主仓库");
  rows.push({
    key: groupKey,
    depth: 0,
    kind: "group",
    canExpand: true,
    expanded: groupExpanded,
    label: gitWorkbenchText("workbench.worktrees.repositories", "Repositories"),
    secondary: undefined,
  });
  if (!groupExpanded) return rows;

  rows.push({
    key: repoNodeKey,
    depth: 1,
    kind: "repo",
    canExpand: true,
    expanded: repoExpanded,
    label: `${repoLabel}${childItems.length > 0 ? ` (${childItems.length})` : ""}`,
    secondary: mainWorktree.path || repoRoot,
    item: mainWorktree,
    isMainWorktree: true,
    isCurrentWorktree: mainPathKey === currentPathKey,
  });
  if (!repoExpanded) return rows;

  for (const item of childItems) {
    const pathKey = normalizePathKey(item.path);
    const itemLabel = getPathBaseName(item.path || "") || item.path;
    const branchText = item.branch || (item.detached ? "(detached)" : "HEAD");
    const headText = item.head ? String(item.head).slice(0, 8) : "";
    const flagText = [
      pathKey === mainPathKey ? gitWorkbenchText("workbench.worktrees.mainWorktree", "主工作树") : "",
      pathKey === currentPathKey ? gitWorkbenchText("workbench.worktrees.current", "当前") : "",
    ].filter(Boolean).join(" · ");
    const details = [branchText, headText, flagText].filter(Boolean).join(" · ");
    rows.push({
      key: `worktrees.item.${pathKey}`,
      depth: 2,
      kind: "item",
      canExpand: false,
      expanded: false,
      label: itemLabel,
      secondary: details ? `${details} · ${item.path}` : item.path,
      item,
      isMainWorktree: pathKey === mainPathKey,
      isCurrentWorktree: pathKey === currentPathKey,
    });
  }
  return rows;
}

/**
 * 读取 Git 工作台布局（宽度/高度）缓存。
 */
function loadWorkbenchLayout(): GitWorkbenchLayout {
  const fallback: GitWorkbenchLayout = {
    leftPanelWidth: DEFAULT_LEFT_PANEL_WIDTH,
    leftPanelProportion: DEFAULT_MAIN_PANEL_PROPORTION,
    branchPanelWidth: DEFAULT_BRANCH_PANEL_WIDTH,
    branchPanelProportion: DEFAULT_BRANCH_PANEL_PROPORTION,
    detailPanelWidth: DEFAULT_DETAIL_PANEL_WIDTH,
    detailPanelProportion: DEFAULT_DETAIL_PANEL_PROPORTION,
    bottomHeight: DEFAULT_BOTTOM_HEIGHT,
    ignoreWhitespace: false,
    diffMode: "side",
    collapseUnchanged: true,
    highlightWords: true,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(GIT_LAYOUT_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw || "{}") as Partial<GitWorkbenchLayout>;
    const rawLeftPanelWidth = Number(parsed.leftPanelWidth);
    const rawLeftPanelProportion = Number(parsed.leftPanelProportion);
    const hasLegacyDefaultMainProportion = Number.isFinite(rawLeftPanelProportion) && Math.abs(rawLeftPanelProportion - 0.34) < 0.02;
    const hasBuggyNarrowMainLayout = (Number.isFinite(rawLeftPanelWidth) && rawLeftPanelWidth <= 320)
      && (!Number.isFinite(rawLeftPanelProportion) || rawLeftPanelProportion < 0.36);
    const shouldMigrateLegacyMainWidth = (hasLegacyDefaultMainProportion && (!Number.isFinite(rawLeftPanelWidth) || rawLeftPanelWidth <= 400))
      || hasBuggyNarrowMainLayout;
    const nextLeftPanelWidth = shouldMigrateLegacyMainWidth
      ? fallback.leftPanelWidth
      : normalizeMainPanelStoredWidth(rawLeftPanelWidth || fallback.leftPanelWidth);
    const nextLeftPanelProportion = shouldMigrateLegacyMainWidth
      ? fallback.leftPanelProportion
      : (typeof parsed.leftPanelProportion === "number" && Number.isFinite(parsed.leftPanelProportion)
          ? parsed.leftPanelProportion
          : null);
    const next: GitWorkbenchLayout = {
      leftPanelWidth: nextLeftPanelWidth,
      leftPanelProportion: nextLeftPanelProportion,
      branchPanelWidth: Math.max(160, Math.min(420, Number(parsed.branchPanelWidth) || fallback.branchPanelWidth)),
      branchPanelProportion: typeof parsed.branchPanelProportion === "number" && Number.isFinite(parsed.branchPanelProportion)
        ? parsed.branchPanelProportion
        : null,
      detailPanelWidth: Math.max(220, Math.min(520, Number(parsed.detailPanelWidth) || fallback.detailPanelWidth)),
      detailPanelProportion: typeof parsed.detailPanelProportion === "number" && Number.isFinite(parsed.detailPanelProportion)
        ? parsed.detailPanelProportion
        : null,
      bottomHeight: Math.max(COLLAPSED_BOTTOM_HEIGHT + 2, Math.min(10_000, Number(parsed.bottomHeight) || fallback.bottomHeight)),
      ignoreWhitespace: parsed.ignoreWhitespace === true,
      diffMode: parsed.diffMode === "unified" ? "unified" : "side",
      collapseUnchanged: parsed.collapseUnchanged !== false,
      highlightWords: parsed.highlightWords !== false,
    };
    return next;
  } catch {
    return fallback;
  }
}

/**
 * 保存 Git 工作台布局缓存。
 */
function saveWorkbenchLayout(layout: GitWorkbenchLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GIT_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // 忽略缓存写入失败，避免影响主流程
  }
}

/**
 * 构建提交详情文件树（目录优先 + 文件计数 + 文件状态）。
 */
function buildDetailTree(items: Array<{ path: string; status?: string; oldPath?: string }>): DetailTreeNode[] {
  const root = new Map<string, any>();
  for (const item of items) {
    const clean = String(item.path || "").trim().replace(/\\/g, "/");
    if (!clean) continue;
    const parts = clean.split("/").filter(Boolean);
    let cursor = root;
    let currentPath = "";
    for (let idx = 0; idx < parts.length; idx += 1) {
      const part = parts[idx];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = idx === parts.length - 1;
      if (!cursor.has(part)) {
        cursor.set(part, {
          key: currentPath,
          name: part,
          fullPath: currentPath,
          isFile,
          count: 0,
          status: isFile ? String(item.status || "").trim() || undefined : undefined,
          oldPath: isFile ? String(item.oldPath || "").trim() || undefined : undefined,
          filePaths: [],
          children: new Map<string, any>(),
        });
      }
      const node = cursor.get(part);
      if (isFile) {
        node.isFile = true;
        node.status = String(item.status || "").trim() || node.status;
        node.oldPath = String(item.oldPath || "").trim() || node.oldPath;
      }
      node.filePaths.push(clean);
      cursor = node.children;
    }
  }

  /**
   * 递归扁平化目录树并聚合文件计数。
   */
  const normalize = (input: Map<string, any>): DetailTreeNode[] => {
    const nodes: DetailTreeNode[] = [];
    for (const item of input.values()) {
      const children = normalize(item.children as Map<string, any>);
      const count = item.isFile ? 1 : children.reduce((sum, one) => sum + one.count, 0);
      const filePaths = item.isFile
        ? [String(item.fullPath || "")]
        : children.flatMap((child) => child.filePaths);
      nodes.push({
        key: item.key,
        name: item.name,
        fullPath: item.fullPath,
        isFile: !!item.isFile,
        count,
        status: item.status,
        oldPath: item.oldPath,
        filePaths: Array.from(new Set(filePaths.filter(Boolean))),
        children,
      });
    }
    return nodes.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  };

  return normalize(root);
}

/**
 * 展开文件树节点，输出为线性可渲染列表。
 */
function flattenDetailTree(nodes: DetailTreeNode[], expanded: Record<string, boolean>, depth: number = 0): Array<{ node: DetailTreeNode; depth: number }> {
  const out: Array<{ node: DetailTreeNode; depth: number }> = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (!node.isFile && expanded[node.key] !== false) {
      out.push(...flattenDetailTree(node.children, expanded, depth + 1));
    }
  }
  return out;
}

/**
 * 按统一 speed search 规则在详情树节点里查找下一个或上一个命中项，供详情树 Ctrl+F / F3 / Shift+F3 复用。
 */
function findDetailSpeedSearchNodeKey(args: {
  rows: Array<{ node: DetailTreeNode; depth: number }>;
  query: string;
  currentNodeKey: string;
  direction?: "next" | "previous";
}): string {
  const rows = args.rows.map((row) => ({
    key: row.node.key,
    textPresentation: row.node.name,
  }));
  return findCommitSpeedSearchMatch({
    rows,
    query: args.query,
    currentRowKey: args.currentNodeKey,
    direction: args.direction,
  });
}

/**
 * 把 speed search 命中的文本片段渲染为高亮节点；未命中时保持原始文本，供详情树与后续其他树视图复用。
 */
function renderGitSpeedSearchText(text: string, query: string): React.ReactNode {
  const ranges = findCommitSpeedSearchRanges({ text, query });
  if (!ranges || ranges.length <= 0) return text;
  const fragments: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      fragments.push(<React.Fragment key={`plain:${index}:${cursor}`}>{text.slice(cursor, range.start)}</React.Fragment>);
    }
    fragments.push(
      <span
        key={`match:${index}:${range.start}`}
        className="cf-git-speed-search-hit rounded-[3px] bg-[var(--cf-yellow)] px-[2px] font-apple-medium text-[var(--cf-warning-foreground)] shadow-[inset_0_0_0_1px_rgba(120,76,0,0.28)]"
      >
        {text.slice(range.start, range.end)}
      </span>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) {
    fragments.push(<React.Fragment key={`plain:tail:${cursor}`}>{text.slice(cursor)}</React.Fragment>);
  }
  return fragments;
}

/**
 * 格式化控制台日志时间戳。
 */
function toConsoleTimeText(timestamp: number): string {
  if (!timestamp) return "";
  try {
    const dt = new Date(timestamp);
    return dt.toLocaleTimeString();
  } catch {
    return String(timestamp);
  }
}

/**
 * 将鼠标事件坐标规整为视口坐标，兼容缩放/滚动场景。
 */
function resolveMenuAnchorPoint(args: { clientX: number; clientY: number; pageX?: number; pageY?: number }): { x: number; y: number } {
  const ww = typeof window !== "undefined" ? Math.max(1, window.innerWidth) : 1;
  const wh = typeof window !== "undefined" ? Math.max(1, window.innerHeight) : 1;
  const ratio = typeof window !== "undefined" ? Math.max(1, window.devicePixelRatio || 1) : 1;

  let x = Number(args.clientX);
  let y = Number(args.clientY);

  if ((!Number.isFinite(x) || x < -1 || x > ww * 1.5) && Number.isFinite(Number(args.pageX))) {
    x = Number(args.pageX) - (typeof window !== "undefined" ? window.scrollX : 0);
  }
  if ((!Number.isFinite(y) || y < -1 || y > wh * 1.5) && Number.isFinite(Number(args.pageY))) {
    y = Number(args.pageY) - (typeof window !== "undefined" ? window.scrollY : 0);
  }
  if (x > ww + 24 && ratio > 1.1) x = x / ratio;
  if (y > wh + 24 && ratio > 1.1) y = y / ratio;

  return {
    x: Math.max(CONTEXT_MENU_SAFE_GAP, Math.min(ww - CONTEXT_MENU_SAFE_GAP, Math.floor(x))),
    y: Math.max(CONTEXT_MENU_SAFE_GAP, Math.min(wh - CONTEXT_MENU_SAFE_GAP, Math.floor(y))),
  };
}

/**
 * 比较两个字符串数组是否完全一致（顺序敏感）。
 */
function isSameStringArray(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let idx = 0; idx < a.length; idx += 1) {
    if (a[idx] !== b[idx]) return false;
  }
  return true;
}

/**
 * 比较两份提交树选择锚点是否完全一致（顺序敏感），供选区恢复链路复用旧状态对象。
 */
function isSameCommitSelectionAnchors(a: CommitSelectionAnchor[], b: CommitSelectionAnchor[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let idx = 0; idx < a.length; idx += 1) {
    const previous = a[idx];
    const next = b[idx];
    if (!previous || !next) return false;
    if (previous.kind !== next.kind) return false;
    if (String(previous.path || "") !== String(next.path || "")) return false;
    if (String(previous.changeListId || "") !== String(next.changeListId || "")) return false;
    if (String(previous.rowKey || "") !== String(next.rowKey || "")) return false;
    if (String(previous.stableId || "") !== String(next.stableId || "")) return false;
    if (String(previous.groupStableId || "") !== String(next.groupStableId || "")) return false;
  }
  return true;
}

type CommitWorkflowActivationResetRequest = {
  activeChangeListId: string;
  selectedEntries: GitStatusEntry[];
  selectedChangeListIds: string[];
};

/**
 * 将提交哈希按日志列表可视顺序排序，保证多选动作（revert/cherry-pick）与 UI 顺序一致。
 */
function sortHashesByLogUiOrder(selectedHashes: string[], logItems: GitLogItem[]): string[] {
  const indexMap = new Map<string, number>();
  for (let idx = 0; idx < logItems.length; idx += 1) {
    const hash = String(logItems[idx]?.hash || "").trim();
    if (!hash || indexMap.has(hash)) continue;
    indexMap.set(hash, idx);
  }
  const normalized = selectedHashes
    .map((one, selectionIndex) => ({ hash: String(one || "").trim(), selectionIndex }))
    .filter((one) => one.hash.length > 0);
  normalized.sort((a, b) => {
    const ai = indexMap.get(a.hash);
    const bi = indexMap.get(b.hash);
    const av = typeof ai === "number" ? ai : Number.MAX_SAFE_INTEGER;
    const bv = typeof bi === "number" ? bi : Number.MAX_SAFE_INTEGER;
    if (av !== bv) return av - bv;
    return a.selectionIndex - b.selectionIndex;
  });
  return Array.from(new Set(normalized.map((one) => one.hash)));
}

/**
 * 将提交详情中的 Git 状态码映射为可读文案。
 */
function toCommitFileStatusText(statusRaw: string): string {
  const status = String(statusRaw || "").trim().toUpperCase();
  const code = status[0] || "";
  if (code === "A") return gitWorkbenchText("workbench.statusCodes.added", "新增");
  if (code === "M") return gitWorkbenchText("workbench.statusCodes.modified", "修改");
  if (code === "D") return gitWorkbenchText("workbench.statusCodes.deleted", "删除");
  if (code === "R") return gitWorkbenchText("workbench.statusCodes.renamed", "重命名");
  if (code === "C") return gitWorkbenchText("workbench.statusCodes.copied", "复制");
  if (code === "T") return gitWorkbenchText("workbench.statusCodes.typeChanged", "类型");
  if (code === "U") return gitWorkbenchText("workbench.statusCodes.conflicted", "冲突");
  return status || "";
}

/**
 * 根据 Git 状态码归一化视觉色调，统一用于状态徽标与文件树细节提示。
 */
function resolveGitToneFromStatus(statusRaw: string): GitUiTone {
  const status = String(statusRaw || "").trim().toUpperCase();
  const code = status[0] || "";
  if (code === "A" || code === "?") return "success";
  if (code === "M" || code === "T") return "accent";
  if (code === "D") return "danger";
  if (code === "R" || code === "C") return "info";
  if (code === "U") return "warning";
  return "muted";
}

/**
 * 将日志 decorations 压缩成单行引用徽标，优先突出 HEAD、本地分支、远端与标签。
 */
function buildLogDecorationPills(
  decorationsRaw: string,
  snapshot: GitBranchPopupSnapshot | null,
  currentBranch: string,
): GitDecorationPill[] {
  const parsed = parseLogDecorationRefs(decorationsRaw, snapshot, currentBranch);
  const pills: GitDecorationPill[] = [];
  const seen = new Set<string>();
  const pushPill = (key: string, label: string, tone: GitUiTone): void => {
    const trimmedKey = String(key || "").trim();
    const trimmedLabel = String(label || "").trim();
    if (!trimmedKey || !trimmedLabel || seen.has(trimmedKey)) return;
    seen.add(trimmedKey);
    pills.push({ key: trimmedKey, label: trimmedLabel, tone });
  };

  const rawRows = String(decorationsRaw || "")
    .split(",")
    .map((one) => String(one || "").trim())
    .filter(Boolean);
  if (rawRows.some((one) => one === "HEAD" || one.startsWith("HEAD ->"))) pushPill("head", "HEAD", "accent");

  for (const branch of parsed.localBranches) {
    const branchName = String(branch || "").trim();
    if (!branchName) continue;
    pushPill(`local:${branchName}`, branchName, branchName === String(currentBranch || "").trim() ? "accent" : "success");
  }
  for (const branch of parsed.remoteBranches) {
    const branchName = String(branch || "").trim();
    if (!branchName) continue;
    pushPill(`remote:${branchName}`, branchName, "info");
  }
  for (const tagName of parsed.tags) {
    const trimmedTag = String(tagName || "").trim();
    if (!trimmedTag) continue;
    pushPill(`tag:${trimmedTag}`, trimmedTag, "warning");
  }

  if (pills.length <= 2) return pills;
  return [
    ...pills.slice(0, 2),
    {
      key: `more:${pills.length - 2}`,
      label: `+${pills.length - 2}`,
      tone: "muted",
    },
  ];
}

/**
 * 根据日志 decorations 推断新建分支默认名称（与 IDEA 建议逻辑保持接近）。
 */
function suggestBranchNameFromDecorations(decorationsRaw: string): string {
  const rows = String(decorationsRaw || "")
    .split(",")
    .map((one) => String(one || "").trim())
    .filter(Boolean);
  const names: string[] = [];
  for (const row of rows) {
    if (!row || row === "HEAD" || row.startsWith("tag:")) continue;
    if (row.startsWith("HEAD ->")) {
      const local = row.slice("HEAD ->".length).trim();
      if (local) names.push(local);
      continue;
    }
    names.push(row);
  }
  const normalized = names
    .map((one) => {
      const text = String(one || "").trim();
      if (!text) return "";
      const slashIndex = text.indexOf("/");
      if (slashIndex > 0 && slashIndex < text.length - 1) {
        return text.slice(slashIndex + 1).trim();
      }
      return text;
    })
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));
  return unique.length === 1 ? unique[0] || "" : "";
}

type ParsedLogDecorationRefs = {
  localBranches: string[];
  remoteBranches: string[];
  tags: string[];
};

/**
 * 解析日志 decorations 中的分支/远端/标签引用，并尽量按仓库实际引用类型归类。
 */
function parseLogDecorationRefs(
  decorationsRaw: string,
  branchPopup: GitBranchPopupSnapshot | null,
  currentBranch: string,
): ParsedLogDecorationRefs {
  const localKnown = new Set((branchPopup?.groups?.local || []).map((one) => String(one.name || "").trim()).filter(Boolean));
  const remoteKnown = new Set((branchPopup?.groups?.remote || []).map((one) => String(one.name || "").trim()).filter(Boolean));
  const remotePrefixKnown = new Set(
    Array.from(remoteKnown)
      .map((one) => {
        const idx = one.indexOf("/");
        if (idx <= 0) return "";
        return one.slice(0, idx).trim();
      })
      .filter(Boolean),
  );
  const current = String(currentBranch || "").trim();
  const localBranches: string[] = [];
  const remoteBranches: string[] = [];
  const tags: string[] = [];
  const localSet = new Set<string>();
  const remoteSet = new Set<string>();
  const tagSet = new Set<string>();
  const rows = String(decorationsRaw || "")
    .split(",")
    .map((one) => String(one || "").trim())
    .filter(Boolean);

  /**
   * 将引用加入目标集合（保持插入顺序且去重）。
   */
  const pushUnique = (list: string[], seen: Set<string>, value: string): void => {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    list.push(text);
  };

  for (const row of rows) {
    if (!row || row === "HEAD") continue;
    if (row.startsWith("tag:")) {
      const tagName = row.slice("tag:".length).trim();
      pushUnique(tags, tagSet, tagName);
      continue;
    }
    const name = row.startsWith("HEAD ->") ? row.slice("HEAD ->".length).trim() : row;
    if (!name) continue;
    if (localKnown.has(name)) {
      if (name !== current) pushUnique(localBranches, localSet, name);
      continue;
    }
    if (remoteKnown.has(name)) {
      pushUnique(remoteBranches, remoteSet, name);
      continue;
    }
    const slash = name.indexOf("/");
    if (slash > 0 && remotePrefixKnown.has(name.slice(0, slash))) {
      pushUnique(remoteBranches, remoteSet, name);
      continue;
    }
    if (name !== current) pushUnique(localBranches, localSet, name);
  }

  return {
    localBranches,
    remoteBranches,
    tags,
  };
}

/**
 * 解析远端分支短名（`remote/branch`），无法解析时返回空值。
 */
function parseRemoteBranchRefName(remoteRefName: string, remoteNamesInput?: string[] | null): { remote: string; branch: string } | null {
  const text = String(remoteRefName || "").trim();
  if (!text) return null;
  const remoteNames = Array.from(new Set(
    (remoteNamesInput || [])
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  )).sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (remoteNames.length > 0) {
    for (const remote of remoteNames) {
      const prefix = `${remote}/`;
      if (!text.startsWith(prefix)) continue;
      const branch = text.slice(prefix.length).trim();
      if (!branch) return null;
      return { remote, branch };
    }
    return null;
  }
  const idx = text.indexOf("/");
  if (idx <= 0 || idx >= text.length - 1) return null;
  return {
    remote: text.slice(0, idx),
    branch: text.slice(idx + 1),
  };
}

/**
 * 把 branch popup 中单个仓库的远端分支分组转为 Pull 对话框可消费的 remote -> branches 结构。
 */
function buildPullDialogRemoteOptions(repository: GitBranchPopupRepository): GitPullDialogRemoteOption[] {
  const remoteNames = Array.from(new Set(
    (repository.remotes || [])
      .map((item) => String(item.name || "").trim())
      .filter(Boolean),
  )).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const branchSetByRemote = new Map<string, Set<string>>();
  for (const item of repository.groups.remote || []) {
    const parsed = parseRemoteBranchRefName(String(item.name || "").trim(), remoteNames);
    if (!parsed?.remote || !parsed.branch || parsed.branch === "HEAD") continue;
    const branchSet = branchSetByRemote.get(parsed.remote) || new Set<string>();
    branchSet.add(parsed.branch);
    branchSetByRemote.set(parsed.remote, branchSet);
  }
  return Array.from(branchSetByRemote.entries())
    .map(([name, branches]) => ({
      name,
      branches: Array.from(branches).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 解析仓库在 Pull/Fetch 对话框中的默认远端，优先当前分支上游，其次回退到第一个远端。
 */
function resolveBranchPopupDefaultRemoteName(repository: GitBranchPopupRepository): string {
  const remoteNames = Array.from(new Set(
    (repository.remotes || [])
      .map((item) => String(item.name || "").trim())
      .filter(Boolean),
  )).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const currentUpstream = String(
    (repository.groups.local || []).find((item) => String(item.name || "").trim() === String(repository.currentBranch || "").trim())?.upstream || "",
  ).trim();
  const parsed = parseRemoteBranchRefName(currentUpstream, remoteNames);
  if (parsed?.remote) return parsed.remote;
  return remoteNames[0] || "";
}

/**
 * 从菜单目标 key 中解析变更列表 ID（格式：cl:<id>）。
 */
function parseChangeListIdFromMenuTarget(target: string | undefined): string {
  const text = String(target || "").trim();
  if (!text.startsWith("cl:")) return "";
  return String(text.slice(3) || "").trim();
}

/**
 * 由“详情面板已选节点键”推导实际选中文件路径集合。
 */
function resolveSelectedDetailPaths(
  selectedNodeKeys: string[],
  nodeMap: Map<string, DetailTreeNode>,
): string[] {
  const set = new Set<string>();
  for (const key of selectedNodeKeys) {
    const node = nodeMap.get(key);
    if (!node) continue;
    for (const pathText of node.filePaths) set.add(pathText);
  }
  return Array.from(set.values());
}

/**
 * 按关键字过滤分支弹窗行。
 */
function filterBranchRows(rows: BranchPopupRow[], keyword: string): BranchPopupRow[] {
  const q = String(keyword || "").trim().toLowerCase();
  if (!q) return rows;
  const out: BranchPopupRow[] = [];
  for (const row of rows) {
    if (row.kind === "group") {
      out.push(row);
      continue;
    }
    const text = row.kind === "action"
      ? row.label
      : row.kind === "repository"
        ? [row.rootName, row.currentBranch].filter(Boolean).join("\n")
        : row.kind === "back"
          ? row.label
          : [row.name, row.item?.secondaryText || row.item?.upstream || "", row.item?.sync?.tooltip || ""].filter(Boolean).join("\n");
    const hit = text.toLowerCase().includes(q);
    if (hit) {
      out.push(row);
      continue;
    }
  }
  if (out.length === 0) return rows.filter((row) => row.kind === "action" && row.label.toLowerCase().includes(q));
  const cleaned: BranchPopupRow[] = [];
  for (let i = 0; i < out.length; i += 1) {
    const row = out[i];
    if (row.kind !== "group") {
      cleaned.push(row);
      continue;
    }
    const next = out[i + 1];
    if (next && next.kind !== "group") cleaned.push(row);
  }
  return cleaned;
}

/**
 * 按统一 speed search 规则在分支面板可见分支里查找下一项或上一项命中，保持与提交树一致的回绕语义。
 */
function findBranchPanelSpeedSearchRowKey(args: {
  rows: BranchPanelRow[];
  query: string;
  currentRowKey: string;
  direction?: "next" | "previous";
}): string {
  const searchableRows = args.rows.filter((row): row is Extract<BranchPanelRow, { kind: "branch" }> => row.kind === "branch");
  return findCommitSpeedSearchMatch({
    rows: searchableRows,
    query: args.query,
    currentRowKey: args.currentRowKey,
    direction: args.direction,
  });
}

type ToolbarDropdownSubmenuProps = {
  label: string;
  panelClassName?: string;
  children: React.ReactNode;
};

/**
 * 工具栏下拉菜单专用子菜单，尺寸与普通下拉项保持一致，不复用右键菜单样式。
 */
function ToolbarDropdownSubmenu(props: ToolbarDropdownSubmenuProps): JSX.Element {
  const { label, panelClassName, children } = props;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<boolean>(false);
  const [openToLeft, setOpenToLeft] = useState<boolean>(false);

  useLayoutEffect(() => {
    if (!open) {
      if (openToLeft) setOpenToLeft(false);
      return;
    }
    const wrapper = wrapperRef.current;
    const panel = panelRef.current;
    if (!wrapper || !panel) return;
    const triggerRect = wrapper.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const shouldOpenLeft = panelRect.right > window.innerWidth - 8 && triggerRect.left >= panelRect.width + 8;
    if (shouldOpenLeft !== openToLeft) setOpenToLeft(shouldOpenLeft);
  }, [children, open, openToLeft]);

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={TOOLBAR_SUBMENU_TRIGGER_CLASS}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
      >
        <span>{label}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
      </button>
      {open ? (
        <div
          ref={panelRef}
          className={cn(
            "absolute top-0 z-[1202] min-w-full rounded-[10px] border border-[color:var(--cf-border)] bg-[var(--cf-surface-solid)] p-0.5 shadow-[0_10px_24px_rgba(15,23,42,0.12)]",
            openToLeft ? "right-full mr-0.5" : "left-full ml-0.5",
            panelClassName,
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Git 工作台，按 Rider/IntelliJ 风格组织提交、Diff、日志与分支交互。
 */
export default function GitWorkbench(props: GitWorkbenchProps): JSX.Element {
  const { t } = useTranslation(["git", "common"]);
  const { repoPath, active, onOpenProjectInApp, onOpenTerminalInApp } = props;
  const gt = useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return interpolateI18nText(String(t(key, {
      ns: "git",
      defaultValue: fallback,
      ...(values || {}),
    })), values);
  }, [t]);
  /**
   * 统一把宿主错误与当前语言下的 Git 兜底文案合并，减少工作台内部重复包裹 `toErrorText(gt(...))`。
   */
  const getErrorText = useCallback((raw: unknown, key: string, fallback: string, values?: Record<string, unknown>): string => {
    return toErrorText(raw, gt(key, fallback, values));
  }, [gt]);
  const projectScopePath = String(repoPath || "").trim();
  const initialLayout = useMemo(() => loadWorkbenchLayout(), []);
  const initialBranchPopupState = useMemo(() => loadGitBranchPopupState(), []);

  const [repoRoot, setRepoRoot] = useState<string>("");
  const [repoBranch, setRepoBranch] = useState<string>("");
  const [repoDetached, setRepoDetached] = useState<boolean>(false);
  const [isRepo, setIsRepo] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [gitNotices, setGitNotices] = useState<GitNoticeItem[]>([]);
  const [updateSessionEntries, setUpdateSessionEntries] = useState<GitUpdateSessionEntryState[]>([]);
  const [focusedUpdateSessionRequestId, setFocusedUpdateSessionRequestId] = useState<number | null>(null);
  const [updateInfoLogState, setUpdateInfoLogState] = useState<UpdateInfoLogState | null>(null);
  const [worktreeTabPreferences, setWorktreeTabPreferences] = useState(() => {
    return typeof window === "undefined"
      ? createDefaultWorktreeTabPreferences()
      : loadWorktreeTabPreferences(window.localStorage);
  });
  const [conflictsPanelPreferences, setConflictsPanelPreferences] = useState(() => {
    return typeof window === "undefined"
      ? createDefaultConflictsPanelPreferences()
      : loadConflictsPanelPreferences(window.localStorage);
  });
  const [hostWorkbenchRequest, setHostWorkbenchRequest] = useState<GitWorkbenchHostRequest | null>(() => {
    if (typeof window === "undefined") return null;
    return consumeGitWorkbenchHostRequest(repoPath);
  });
  const [preferredCommitAction, setPreferredCommitAction] = useState<"commit" | "commitAndPush">("commit");

  const [branchPopupOpen, setBranchPopupOpen] = useState<boolean>(false);
  const [branchPopupQuery, setBranchPopupQuery] = useState<string>("");
  const [branchPopupIndex, setBranchPopupIndex] = useState<number>(0);
  const [branchPopup, setBranchPopup] = useState<GitBranchPopupSnapshot | null>(null);
  const [branchSelectedRepoRoot, setBranchSelectedRepoRoot] = useState<string>(initialBranchPopupState.selectedRepoRoot);
  const [branchPopupStep, setBranchPopupStep] = useState<GitBranchPopupStep>(initialBranchPopupState.step);
  const [branchPanelSpeedSearch, setBranchPanelSpeedSearch] = useState<string>("");
  const [branchPanelSpeedSearchOpen, setBranchPanelSpeedSearchOpen] = useState<boolean>(false);
  const [branchPanelFocusedRowKey, setBranchPanelFocusedRowKey] = useState<string>("");
  const [logBranchesDashboardState, setLogBranchesDashboardState] = useState<GitLogBranchesDashboardState>(() => loadGitLogBranchesDashboardState());

  const [leftTab, setLeftTab] = useState<"commit" | "shelve">("commit");
  const [commitMessage, setCommitMessage] = useState<string>("");
  const [status, setStatus] = useState<GitStatusSnapshot | null>(null);
  const [ignoredEntries, setIgnoredEntries] = useState<GitStatusEntry[]>([]);
  const [ignoredLoading, setIgnoredLoading] = useState<boolean>(false);
  const [commitTreeBusy, setCommitTreeBusy] = useState<boolean>(false);
  const [commitTreeResetPending, setCommitTreeResetPending] = useState<boolean>(false);
  const [commitInclusionState, setCommitInclusionState] = useState<CommitInclusionState>(() => createCommitInclusionState());
  const [partialCommitSelectionState, setPartialCommitSelectionState] = useState<PartialCommitSelectionState>(() => createPartialCommitSelectionState());
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [exactlySelectedPaths, setExactlySelectedPaths] = useState<string[]>([]);
  const [selectedCommitTreeKeys, setSelectedCommitTreeKeys] = useState<string[]>([]);
  const [selectedDiffableCommitNodeKey, setSelectedDiffableCommitNodeKey] = useState<string>("");
  const [commitSelectionAnchors, setCommitSelectionAnchors] = useState<CommitSelectionAnchor[]>([]);
  const [commitTreeExpanded, setCommitTreeExpanded] = useState<Record<string, boolean>>({});
  const [commitGroupExpanded, setCommitGroupExpanded] = useState<Record<string, boolean>>({});
  const [commitAmendEnabled, setCommitAmendEnabled] = useState<boolean>(false);
  const [commitAmendLoading, setCommitAmendLoading] = useState<boolean>(false);
  const [commitAmendDetails, setCommitAmendDetails] = useState<CommitAmendDetails | null>(null);
  const [commitAdvancedOptionsState, setCommitAdvancedOptionsState] = useState<CommitAdvancedOptionsState>(() => createCommitAdvancedOptionsState());
  const [commitOptionsOpen, setCommitOptionsOpen] = useState<boolean>(false);
  const [specialFilesDialogState, setSpecialFilesDialogState] = useState<null | {
    cacheKey: string;
    kind: CommitSpecialFilesDialogKind;
    title: string;
    description: string;
    entries: GitStatusEntry[];
  }>(null);
  const [ignoreTargetDialogState, setIgnoreTargetDialogState] = useState<null | {
    requests: IgnoreTargetDialogRequest[];
    activeIndex: number;
    applyingTargetId?: string;
    anchor?: { x: number; y: number };
  }>(null);
  const [conflictResolverDialogState, setConflictResolverDialogState] = useState<ConflictResolverDialogState | null>(null);
  const [conflictMergeDialogState, setConflictMergeDialogState] = useState<ConflictMergeDialogState | null>(null);
  const [stageThreeWayDialogState, setStageThreeWayDialogState] = useState<StageThreeWayDialogState | null>(null);
  const [interactiveRebaseDialogState, setInteractiveRebaseDialogState] = useState<InteractiveRebaseDialogState | null>(null);
  const activeIgnoreTargetDialogRequest = ignoreTargetDialogState
    ? (ignoreTargetDialogState.requests[ignoreTargetDialogState.activeIndex] || null)
    : null;

  const [diff, setDiff] = useState<GitDiffSnapshot | null>(null);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState<boolean>(initialLayout.ignoreWhitespace);
  const [diffMode, setDiffMode] = useState<"side" | "unified">(initialLayout.diffMode);
  const [collapseUnchanged, setCollapseUnchanged] = useState<boolean>(initialLayout.collapseUnchanged);
  const [highlightWords, setHighlightWords] = useState<boolean>(initialLayout.highlightWords);
  const [diffActiveLine, setDiffActiveLine] = useState<number>(-1);
  const [changedDiffLineIndexes, setChangedDiffLineIndexes] = useState<number[]>([]);
  const [diffFullscreen, setDiffFullscreen] = useState<boolean>(false);
  const [diffPinned, setDiffPinned] = useState<boolean>(false);
  const [diffEditorSelection, setDiffEditorSelection] = useState<GitDiffEditorSelection>({
    focusSide: null,
    originalSelectedLines: [],
    modifiedSelectedLines: [],
  });

  const [bottomCollapsed, setBottomCollapsed] = useState<boolean>(false);
  const [bottomHeight, setBottomHeight] = useState<number>(initialLayout.bottomHeight);
  const [bottomTab, setBottomTab] = useState<"git" | "log" | "worktrees" | "conflicts">("git");
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(initialLayout.leftPanelWidth);
  const [leftPanelProportion, setLeftPanelProportion] = useState<number | null>(null);
  const [branchPanelWidth, setBranchPanelWidth] = useState<number>(initialLayout.branchPanelWidth);
  const [branchPanelProportion, setBranchPanelProportion] = useState<number | null>(initialLayout.branchPanelProportion ?? null);
  const [detailPanelWidth, setDetailPanelWidth] = useState<number>(initialLayout.detailPanelWidth);
  const [detailPanelProportion, setDetailPanelProportion] = useState<number | null>(initialLayout.detailPanelProportion ?? null);
  const upperLayoutRef = useRef<HTMLDivElement>(null);
  const bottomLayoutRef = useRef<HTMLDivElement>(null);
  const [upperLayoutWidth, setUpperLayoutWidth] = useState<number>(0);
  const [upperLayoutHeight, setUpperLayoutHeight] = useState<number>(0);
  const [bottomLayoutWidth, setBottomLayoutWidth] = useState<number>(0);
  const draggingBottomRef = useRef<boolean>(false);
  const draggingLayoutRef = useRef<null | {
    kind: "main" | "bottomLeft" | "bottomRight";
    startX: number;
    startLeftPanelWidth: number;
    startBranchPanelWidth: number;
    startDetailPanelWidth: number;
  }>(null);
  const draggingLogColumnRef = useRef<null | {
    columnId: GitLogColumnId;
    startX: number;
    startWidth: number;
  }>(null);
  const draggingLogColumnIdRef = useRef<GitLogColumnId | null>(null);
  const previousCommitChangeGroupsRef = useRef<CommitPanelChangeEntryGroup[]>([]);
  const conflictMergeLoadSeqRef = useRef<number>(0);
  const updateInfoAutoOpenedRequestIdsRef = useRef<Set<number>>(new Set());
  const conflictPanelSignatureRef = useRef<string>("");

  const [logItems, setLogItems] = useState<GitLogItem[]>([]);
  const [logGraphItems, setLogGraphItems] = useState<GitLogItem[]>([]);
  const [logColumnLayout, setLogColumnLayout] = useState<GitLogColumnLayout>(() => loadGitLogColumnLayout());
  const [logCursor, setLogCursor] = useState<number>(0);
  const [logHasMore, setLogHasMore] = useState<boolean>(false);
  const [logLoading, setLogLoading] = useState<boolean>(false);
  const [logFilters, setLogFilters] = useState<GitLogFilters>(DEFAULT_LOG_FILTERS);
  const [selectedCommitHashes, setSelectedCommitHashes] = useState<string[]>([]);
  const [pendingLogSelectionHash, setPendingLogSelectionHash] = useState<string>("");
  const [logActionAvailability, setLogActionAvailability] = useState<GitLogActionAvailability | null>(null);
  const [logActionAvailabilityHashesKey, setLogActionAvailabilityHashesKey] = useState<string>("");
  const [logActionAvailabilityLoading, setLogActionAvailabilityLoading] = useState<boolean>(false);
  const [details, setDetails] = useState<GitLogDetails | null>(null);
  const [selectedDetailNodeKeys, setSelectedDetailNodeKeys] = useState<string[]>([]);
  const [detailTreeExpanded, setDetailTreeExpanded] = useState<Record<string, boolean>>({});
  const [branchCompareFilesTreeExpanded, setBranchCompareFilesTreeExpanded] = useState<Record<string, boolean>>({});
  const [detailSpeedSearch, setDetailSpeedSearch] = useState<string>("");
  const [detailSpeedSearchOpen, setDetailSpeedSearchOpen] = useState<boolean>(false);
  const [showParentChanges, setShowParentChanges] = useState<boolean>(true);
  const [detailActionAvailability, setDetailActionAvailability] = useState<GitCommitDetailsActionAvailability | null>(null);
  const [detailActionAvailabilityKey, setDetailActionAvailabilityKey] = useState<string>("");
  const [pullDialogOpen, setPullDialogOpen] = useState<boolean>(false);
  const [pullDialogValue, setPullDialogValue] = useState<GitPullDialogValue>({
    repoRoot: "",
    remote: "",
    branch: "",
    mode: "merge",
    options: [],
  });
  const [pullDialogCapabilities, setPullDialogCapabilities] = useState<GitPullCapabilities>({ noVerify: false });
  const [pullDialogSubmitting, setPullDialogSubmitting] = useState<boolean>(false);
  const [fetchDialogOpen, setFetchDialogOpen] = useState<boolean>(false);
  const [fetchDialogValue, setFetchDialogValue] = useState<GitFetchDialogValue>({
    repoRoot: "",
    mode: "default-remote",
    remote: "",
    refspec: "",
    unshallow: false,
    tagMode: "auto",
  });
  const [fetchDialogSubmitting, setFetchDialogSubmitting] = useState<boolean>(false);
  const [rollbackViewerState, setRollbackViewerState] = useState<RollbackViewerState | null>(null);
  const [rollbackViewerSubmitting, setRollbackViewerSubmitting] = useState<boolean>(false);
  const [rollbackViewerRefreshing, setRollbackViewerRefreshing] = useState<boolean>(false);
  const [rollbackDiffOverlayOpen, setRollbackDiffOverlayOpen] = useState<boolean>(false);

  const [shelfItems, setShelfItems] = useState<GitShelfItem[]>([]);
  const [shelfViewState, setShelfViewState] = useState<GitShelfViewState>({ showRecycled: false, groupByDirectory: false });
  const [stashItems, setStashItems] = useState<GitStashItem[]>([]);
  const [shelfRestoreDialogOpen, setShelfRestoreDialogOpen] = useState<boolean>(false);
  const [shelfRestoreDialogSubmitting, setShelfRestoreDialogSubmitting] = useState<boolean>(false);
  const [shelfRestoreDialogShelf, setShelfRestoreDialogShelf] = useState<GitShelfItem | null>(null);
  const [shelfRestoreDialogValue, setShelfRestoreDialogValue] = useState<GitShelfRestoreDialogValue>({
    selectedPaths: [],
    targetChangeListId: "",
    removeAppliedFromShelf: true,
  });
  const [worktreeItems, setWorktreeItems] = useState<GitWorktreeItem[]>([]);
  const [worktreeTreeExpanded, setWorktreeTreeExpanded] = useState<Record<string, boolean>>({});
  const [gitConsoleItems, setGitConsoleItems] = useState<GitConsoleEntry[]>([]);
  const [gitConsoleLoading, setGitConsoleLoading] = useState<boolean>(false);
  const [gitConsoleLiveUpdatesPaused, setGitConsoleLiveUpdatesPaused] = useState<boolean>(false);
  const [gitActivityCount, setGitActivityCount] = useState<number>(0);
  const [gitActivityText, setGitActivityText] = useState<string>(gitWorkbenchText("workbench.misc.status.ready", "就绪"));
  const [loadingFlow, setLoadingFlow] = useState<boolean>(false);
  const [updateRuntimeScopeDialogOpen, setUpdateRuntimeScopeDialogOpen] = useState<boolean>(false);
  const [updateRuntimeScopeSnapshot, setUpdateRuntimeScopeSnapshot] = useState<GitUpdateOptionsSnapshot | null>(null);
  const [updateRuntimeScopeSubmitting, setUpdateRuntimeScopeSubmitting] = useState<boolean>(false);
  const [updateOptionsDialogOpen, setUpdateOptionsDialogOpen] = useState<boolean>(false);
  const [updateOptionsSnapshot, setUpdateOptionsSnapshot] = useState<GitUpdateOptionsSnapshot | null>(null);
  const [updateOptionsSubmitting, setUpdateOptionsSubmitting] = useState<boolean>(false);
  const [rebaseWarningDialogOpen, setRebaseWarningDialogOpen] = useState<boolean>(false);
  const [rebaseWarning, setRebaseWarning] = useState<GitUpdateRebaseWarning | null>(null);
  const [rebaseWarningSubmitting, setRebaseWarningSubmitting] = useState<boolean>(false);
  const [operationProblemDialogOpen, setOperationProblemDialogOpen] = useState<boolean>(false);
  const [operationProblem, setOperationProblem] = useState<GitUpdateOperationProblem | null>(null);
  const [operationProblemSubmitting, setOperationProblemSubmitting] = useState<boolean>(false);
  const [operationStateSubmitting, setOperationStateSubmitting] = useState<"continue" | "abort" | null>(null);
  const [pushDialogOpen, setPushDialogOpen] = useState<boolean>(false);
  const [pushDialogLoading, setPushDialogLoading] = useState<boolean>(false);
  const [pushDialogSubmitting, setPushDialogSubmitting] = useState<boolean>(false);
  const [pushForceMenuOpen, setPushForceMenuOpen] = useState<boolean>(false);
  const [pushDialogPushTags, setPushDialogPushTags] = useState<boolean>(false);
  const [pushDialogTagMode, setPushDialogTagMode] = useState<"all" | "follow">("all");
  const [pushDialogRunHooks, setPushDialogRunHooks] = useState<boolean>(true);
  const [pushDialogUpdateIfRejected, setPushDialogUpdateIfRejected] = useState<boolean>(true);
  const [pushDialogTargetHash, setPushDialogTargetHash] = useState<string>("");
  const [pushRejectedDialogOpen, setPushRejectedDialogOpen] = useState<boolean>(false);
  const [pushRejectedDecision, setPushRejectedDecision] = useState<GitPushRejectedDecision | null>(null);
  const [pushRejectedSubmitting, setPushRejectedSubmitting] = useState<boolean>(false);
  const [pushPreview, setPushPreview] = useState<GitPushPreview | null>(null);
  const [pushSelectedCommitHash, setPushSelectedCommitHash] = useState<string>("");
  const [pushRepoCommitsExpanded, setPushRepoCommitsExpanded] = useState<boolean>(true);
  const [pushFileTreeExpanded, setPushFileTreeExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [actionDialogOpen, setActionDialogOpen] = useState<boolean>(false);
  const [actionDialogConfig, setActionDialogConfig] = useState<ActionDialogConfig | null>(null);
  const [actionDialogValues, setActionDialogValues] = useState<Record<string, string>>({});
  const [actionDialogSubmitting, setActionDialogSubmitting] = useState<boolean>(false);
  const [fixTrackedBranchDialogOpen, setFixTrackedBranchDialogOpen] = useState<boolean>(false);
  const [fixTrackedBranchPreview, setFixTrackedBranchPreview] = useState<GitUpdateTrackedBranchPreview | null>(null);
  const [fixTrackedBranchSubmitting, setFixTrackedBranchSubmitting] = useState<boolean>(false);
  const [fixTrackedBranchContinueMode, setFixTrackedBranchContinueMode] = useState<"update" | "reset">("update");
  const [updateResetDialogOpen, setUpdateResetDialogOpen] = useState<boolean>(false);
  const [updateResetSnapshot, setUpdateResetSnapshot] = useState<GitUpdateOptionsSnapshot | null>(null);
  const [updateResetSubmitting, setUpdateResetSubmitting] = useState<boolean>(false);
  const [updateCommitRangeChoice, setUpdateCommitRangeChoice] = useState<UpdateCommitRangeChoiceState | null>(null);
  const [branchCompareState, setBranchCompareState] = useState<BranchCompareState | null>(null);
  const [branchCompareFilesDialogState, setBranchCompareFilesDialogState] = useState<BranchCompareFilesDialogState | null>(null);
  const [branchRemoteManagerDialogState, setBranchRemoteManagerDialogState] = useState<BranchRemoteManagerDialogState | null>(null);
  const actionDialogResolveRef = useRef<((value: Record<string, string> | null) => void) | null>(null);
  const commitOptionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const diffRequestSeqRef = useRef<number>(0);
  const bootstrapRefreshRepoPathRef = useRef<string>("");
  const logRequestSeqRef = useRef<number>(0);
  const worktreeRequestSeqRef = useRef<number>(0);
  const detailRequestSeqRef = useRef<number>(0);
  const detailLoadedRequestKeyRef = useRef<string>("");
  const detailRequestedRequestKeyRef = useRef<string>("");
  const fileHistoryDiffSeqRef = useRef<number>(0);
  const logActionAvailabilitySeqRef = useRef<number>(0);
  const autoLoadLogLockRef = useRef<boolean>(false);
  const leftExpandedWidthRef = useRef<number>(initialLayout.leftPanelWidth);
  const gitNoticesRef = useRef<GitNoticeItem[]>([]);
  const gitNoticeSeqRef = useRef<number>(0);
  const gitNoticeTimersRef = useRef<Map<number, number>>(new Map());
  const updateSessionTimersRef = useRef<Map<number, number>>(new Map());
  const branchSyncRefreshTimerRef = useRef<number | null>(null);
  const workingWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateRuntimeScopeContinueRef = useRef<((payloadPatch: Record<string, any>) => Promise<void>) | null>(null);
  const rebaseWarningRetryRef = useRef<((payloadPatch: Record<string, any>) => Promise<void>) | null>(null);
  const operationProblemRetryRef = useRef<((payloadPatch: Record<string, any>) => Promise<void>) | null>(null);
  const rollbackViewerContinueRef = useRef<(() => Promise<void>) | null>(null);
  const trackedBranchRetryRef = useRef<((payloadPatch: Record<string, any>) => Promise<void>) | null>(null);
  const trackedBranchAfterSuccessRef = useRef<(() => Promise<void>) | null>(null);
  const pushRejectedPayloadRef = useRef<PushExecutionPayload | null>(null);
  const workingWritePayloadRef = useRef<{ path: string; content: string } | null>(null);
  const pendingCommitTreeStateRef = useRef<ReturnType<typeof createCommitTreeStateSnapshot> | null>(null);
  const autoExpandedCommitSelectionSignatureRef = useRef<string>("");
  const commitAmendLoadSeqRef = useRef<number>(0);
  const commitAmendRequestedHashRef = useRef<string>("");
  const commitAmendRestoreRef = useRef<CommitAmendRestoreSnapshot | null>(null);
  const pendingDiffRequestRef = useRef<{ requestId: number; signature: string } | null>(null);
  const conflictResolverLoadSeqRef = useRef<number>(0);
  const conflictResolverAutoContinueKeyRef = useRef<string>("");
  const interactiveRebaseDetailsSeqRef = useRef<number>(0);
  const ignoredRequestSeqRef = useRef<number>(0);
  const ignoredEntriesCacheRef = useRef<Map<string, GitStatusEntry[]>>(new Map());
  const statusRef = useRef<GitStatusSnapshot | null>(null);
  const pendingCommitWorkflowActivationResetRef = useRef<CommitWorkflowActivationResetRequest | null>(null);
  const persistChangeListDraftTimerRef = useRef<number | null>(null);
  const restoredChangeListDraftListIdRef = useRef<string>("");
  const requestCommitSelectionVisibleRef = useRef<boolean>(false);
  const loadedDiffRequestSignatureRef = useRef<string>("");
  const rollbackDiffOverlayRestoreRef = useRef<RollbackDiffOverlayRestoreSnapshot | null>(null);
  const commitMessageValueRef = useRef<string>("");
  const commitAuthorValueRef = useRef<string>("");
  const restoredPersistedCommitMessageRepoRef = useRef<string>("");
  const handledHostWorkbenchRequestIdRef = useRef<number>(0);
  const hostActionHandlersRef = useRef<GitWorkbenchHostActionHandlers>({
    openCommitStage: () => {},
    openPushDialogAsync: async () => {},
    openPullDialogAsync: async () => {},
    openFetchDialogAsync: async () => {},
    runUpdateProjectAsync: async () => {},
    openUpdateOptionsDialogAsync: async () => {},
    openConflictResolver: () => {},
    openCreateStashDialogAsync: async () => {},
    openSavedChangesView: () => {},
  });
  const commitTreeViewStateRef = useRef<{
    selectedRowKeys: string[];
    groupExpanded: Record<string, boolean>;
    treeExpanded: Record<string, boolean>;
  }>({
    selectedRowKeys: [],
    groupExpanded: {},
    treeExpanded: {},
  });
  commitMessageValueRef.current = commitMessage;
  commitAuthorValueRef.current = sanitizeCommitAdvancedOptionsState(commitAdvancedOptionsState).author;
  const commitMessageInputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const commitTreeContainerRef = useRef<HTMLDivElement>(null);
  const branchPanelSpeedSearchRootRef = useRef<HTMLDivElement>(null);
  const branchPanelSpeedSearchInputRef = useRef<HTMLInputElement>(null);
  const branchPanelContainerRef = useRef<HTMLDivElement>(null);
  const branchPanelRowElementsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const detailTreeSpeedSearchRootRef = useRef<HTMLDivElement>(null);
  const detailTreeContainerRef = useRef<HTMLDivElement>(null);
  const [activeSelectionScope, setActiveSelectionScope] = useState<"commit" | "detail" | null>(null);

  /**
   * 当日志修订筛选不再匹配当前 compare range 时，自动清空比较态，避免 chip 文案与实际过滤条件脱节。
   */
  useEffect(() => {
    if (!branchCompareState) return;
    if (String(logFilters.revision || "").trim() === branchCompareState.revision) return;
    setBranchCompareState(null);
  }, [branchCompareState, logFilters.revision]);

  const activeBranchCompareLabel = useMemo<string>(() => {
    if (!branchCompareState) return "";
    if (String(logFilters.revision || "").trim() !== branchCompareState.revision) return "";
    return formatBranchCompareLabel(branchCompareState.leftRef, branchCompareState.rightRef);
  }, [branchCompareState, logFilters.revision]);

  const commitHooksAvailability = useMemo(() => resolveCommitHooksAvailability(status?.commitHooks), [
    status?.commitHooks?.available,
    status?.commitHooks?.disabledByPolicy,
    status?.commitHooks?.runByDefault,
  ]);
  const commitAdvancedOptionsSummary = useMemo(
    () => buildCommitAdvancedOptionsSummary(commitAdvancedOptionsState, commitHooksAvailability, gt),
    [commitAdvancedOptionsState, commitHooksAvailability, gt],
  );
  const commitAdvancedOptionsEnabled = useMemo(
    () => hasCommitAdvancedOptions(commitAdvancedOptionsState, commitHooksAvailability),
    [commitAdvancedOptionsState, commitHooksAvailability],
  );
  useEffect(() => {
    if (commitHooksAvailability.disabledByPolicy !== true) return;
    setCommitAdvancedOptionsState((prev) => (
      prev.runHooks === false ? prev : patchCommitAdvancedOptionsState(prev, { runHooks: false })
    ));
  }, [commitHooksAvailability.disabledByPolicy]);
  const defaultCommitAuthor = useMemo<string>(() => String(status?.defaultCommitAuthor || "").trim(), [status?.defaultCommitAuthor]);
  const commitChecks = useMemo<GitCommitCheck[]>(() => {
    const sanitized = sanitizeCommitAdvancedOptionsState(commitAdvancedOptionsState);
    return runBeforeCommitChecks({
      message: commitMessage,
      cleanupMessage: sanitized.cleanupMessage,
      explicitAuthor: sanitized.author,
      defaultAuthor: defaultCommitAuthor,
      authorDate: sanitized.authorDate,
      showEmptyMessageError: false,
    });
  }, [commitAdvancedOptionsState, commitMessage, defaultCommitAuthor]);
  const blockingCommitCheck = useMemo<GitCommitCheck | null>(() => {
    return findBlockingCommitCheck(commitChecks);
  }, [commitChecks]);
  const currentCommitComposerDraft = useMemo<GitChangeListCommitDraft>(() => {
    const sanitized = sanitizeCommitAdvancedOptionsState(commitAdvancedOptionsState);
    return {
      message: commitMessage,
      author: sanitized.author,
      authorDate: sanitized.authorDate,
      commitRenamesSeparately: sanitized.commitRenamesSeparately,
    };
  }, [commitAdvancedOptionsState, commitMessage]);
  const commitAmendAvailable = useMemo<boolean>(() => !!String(status?.headSha || "").trim(), [status?.headSha]);
  const commitPrimaryPushAfter = preferredCommitAction === "commitAndPush";
  const commitPrimaryActionLabel = useMemo<string>(() => {
    return buildCommitActionLabel(commitAmendEnabled, commitPrimaryPushAfter, !commitPrimaryPushAfter && commitInclusionState.isCommitAll);
  }, [commitAmendEnabled, commitInclusionState.isCommitAll, commitPrimaryPushAfter]);
  const commitSecondaryActionLabel = useMemo<string>(() => {
    return buildCommitActionLabel(commitAmendEnabled, !commitPrimaryPushAfter);
  }, [commitAmendEnabled, commitPrimaryPushAfter]);

  const [branchGroupOpen, setBranchGroupOpen] = useState<BranchPanelGroupOpen>({
    favorites: true,
    local: true,
    remote: true,
  });
  const [branchPopupGroupOpen, setBranchPopupGroupOpen] = useState<BranchPopupGroupOpen>(initialBranchPopupState.groupOpen || createDefaultBranchPopupGroupOpen());

  const selectedBranchRepository = useMemo(() => {
    return resolveSelectedBranchPopupRepository(branchPopup, branchSelectedRepoRoot);
  }, [branchPopup, branchSelectedRepoRoot]);
  const branchRows = useMemo<BranchPopupRow[]>(() => {
    const rows = buildBranchPopupRows({
      snapshot: branchPopup,
      selectedRepoRoot: branchSelectedRepoRoot,
      step: branchPopupStep,
      groupOpen: branchPopupGroupOpen,
      resolveText: gt,
    });
    return filterBranchRows(rows, branchPopupQuery);
  }, [branchPopup, branchPopupGroupOpen, branchPopupQuery, branchPopupStep, branchSelectedRepoRoot, gt]);
  const currentBranchPresentation = useMemo<GitCurrentBranchPresentation>(() => {
    return buildCurrentBranchPresentation({
      branchName: repoBranch,
      detached: repoDetached,
      sync: branchPopup?.currentBranchSync,
      resolveText: gt,
    });
  }, [branchPopup?.currentBranchSync, gt, repoBranch, repoDetached]);
  const branchPopupPresentationByKey = useMemo<Map<string, GitBranchRowPresentation>>(() => {
    const map = new Map<string, GitBranchRowPresentation>();
    for (const row of branchRows) {
      if (row.kind !== "branch") continue;
      map.set(
        `popup:${row.repoRoot}:${row.section}:${row.name}`,
        buildBranchRowPresentation(row.item || { name: row.name }, gt),
      );
    }
    return map;
  }, [branchRows, gt]);
  const branchPopupWarning = useMemo(() => {
    return buildBranchPopupWarningPresentation(selectedBranchRepository?.currentBranchSync || branchPopup?.currentBranchSync, gt);
  }, [branchPopup?.currentBranchSync, gt, selectedBranchRepository?.currentBranchSync]);
  const branchPopupActionGroups = useMemo(
    () => buildBranchPopupActionGroups(branchPopup, (key, fallback) => gt(key, fallback)),
    [branchPopup, gt],
  );

  const branchPanelRows = useMemo<BranchPanelRow[]>(
    () => buildBranchPanelRows(branchPopup, branchSelectedRepoRoot, branchGroupOpen, gt),
    [branchGroupOpen, branchPopup, branchSelectedRepoRoot, gt],
  );
  useEffect(() => {
    saveGitBranchPopupState({
      selectedRepoRoot: branchSelectedRepoRoot,
      step: branchPopupStep,
      groupOpen: branchPopupGroupOpen,
    });
  }, [branchPopupGroupOpen, branchPopupStep, branchSelectedRepoRoot]);
  const branchPanelPresentationByKey = useMemo<Map<string, GitBranchRowPresentation>>(() => {
    const map = new Map<string, GitBranchRowPresentation>();
    for (const row of branchPanelRows) {
      if (row.kind !== "branch") continue;
      map.set(row.key, buildBranchRowPresentation(row.item || { name: row.name }, gt));
    }
    return map;
  }, [branchPanelRows, gt]);
  const selectedBranchKnownRemoteNames = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const item of selectedBranchRepository?.groups?.remote || []) {
      const parsed = parseRemoteBranchRefName(String(item.name || "").trim());
      if (parsed?.remote) set.add(parsed.remote);
    }
    return Array.from(set).sort((a, b) => b.length - a.length || a.localeCompare(b));
  }, [selectedBranchRepository?.groups?.remote]);
  const selectedBranchRemoteConfigs = useMemo<GitRemoteConfigItem[]>(() => {
    return selectedBranchRepository?.remotes || [];
  }, [selectedBranchRepository?.remotes]);
  const branchRemoteManagerRemoteConfigs = useMemo<GitRemoteConfigItem[]>(() => {
    const targetRepoRoot = String(branchRemoteManagerDialogState?.repoRoot || "").trim();
    if (!targetRepoRoot) return [];
    return resolveSelectedBranchPopupRepository(branchPopup, targetRepoRoot)?.remotes || [];
  }, [branchPopup, branchRemoteManagerDialogState?.repoRoot]);
  const activeUpdateInfoRange = useMemo<GitUpdateNotificationRange | null>(() => {
    return resolveUpdateInfoLogRange(updateInfoLogState);
  }, [updateInfoLogState]);
  const activeLogFilters = useMemo<GitLogFilters>(() => {
    return updateInfoLogState?.filters || logFilters;
  }, [logFilters, updateInfoLogState?.filters]);
  const updateInfoLogEnabled = !!updateInfoLogState;

  /**
   * 统一写入当前生效的日志过滤器；Update Info 模式下只改独立视图状态，不污染普通日志过滤。
   */
  const updateActiveLogFilters = useCallback((updater: (prev: GitLogFilters) => GitLogFilters): void => {
    if (updateInfoLogEnabled) {
      setUpdateInfoLogState((prev) => prev ? { ...prev, filters: normalizeGitLogFilters(updater(prev.filters)) } : prev);
      return;
    }
    setLogFilters((prev) => normalizeGitLogFilters(updater(prev)));
  }, [updateInfoLogEnabled]);

  /**
   * 统一持久化 Worktrees 页签偏好，保证 opened/closed/NEW badge 状态与本地缓存保持一致。
   */
  const updateWorktreeTabPreferences = useCallback((updater: (prev: ReturnType<typeof loadWorktreeTabPreferences>) => ReturnType<typeof loadWorktreeTabPreferences>): void => {
    setWorktreeTabPreferences((prev) => {
      const next = updater(prev);
      saveWorktreeTabPreferences(typeof window === "undefined" ? null : window.localStorage, next);
      return next;
    });
  }, []);

  /**
   * 统一持久化冲突面板偏好，覆盖 gate 与当前 signature 的关闭记忆。
   */
  const updateConflictsPanelPreferences = useCallback((updater: (prev: ReturnType<typeof loadConflictsPanelPreferences>) => ReturnType<typeof loadConflictsPanelPreferences>): void => {
    setConflictsPanelPreferences((prev) => {
      const next = updater(prev);
      saveConflictsPanelPreferences(typeof window === "undefined" ? null : window.localStorage, next);
      return next;
    });
  }, []);

  const branchSelectableIndexes = useMemo<number[]>(() => {
    const out: number[] = [];
    branchRows.forEach((row, idx) => {
      if (row.kind !== "group") out.push(idx);
    });
    return out;
  }, [branchRows]);

  useEffect(() => {
    if (!branchPopup) {
      setBranchSelectedRepoRoot("");
      setBranchPopupStep("branches");
      return;
    }
    const fallbackRepoRoot = String(branchPopup.selectedRepoRoot || branchPopup.repositories?.[0]?.repoRoot || "").trim();
    const knownRepoRoots = new Set((branchPopup.repositories || []).map((item) => String(item.repoRoot || "").trim()).filter(Boolean));
    setBranchSelectedRepoRoot((prev) => {
      const next = String(prev || "").trim();
      return knownRepoRoots.has(next) ? next : fallbackRepoRoot;
    });
    if (branchPopup.multiRoot !== true)
      setBranchPopupStep("branches");
  }, [branchPopup]);

  useEffect(() => {
    const preferredRowKey = branchPanelRows.find((row) => row.kind === "branch")?.key || "";
    if (branchPanelFocusedRowKey && branchPanelRows.some((row) => row.kind === "branch" && row.key === branchPanelFocusedRowKey)) return;
    if (branchPanelFocusedRowKey === preferredRowKey) return;
    setBranchPanelFocusedRowKey(preferredRowKey);
  }, [branchPanelFocusedRowKey, branchPanelRows]);

  useEffect(() => {
    if (!branchPanelFocusedRowKey) return;
    const rowElement = branchPanelRowElementsRef.current[branchPanelFocusedRowKey];
    rowElement?.scrollIntoView?.({ block: "nearest" });
  }, [branchPanelFocusedRowKey]);

  /**
   * 统一关闭并清空分支面板 speed search，复用到 Esc、失焦、点击外部与输入清空后的收口逻辑。
   */
  const resetBranchPanelSpeedSearch = useCallback((options?: { restoreFocus?: boolean }): void => {
    setBranchPanelSpeedSearchOpen(false);
    setBranchPanelSpeedSearch("");
    if (options?.restoreFocus)
      window.requestAnimationFrame(() => {
        branchPanelContainerRef.current?.focus();
      });
  }, []);

  /**
   * 判断焦点是否仍停留在分支面板整体区域内，供滚动容器与搜索输入框共享失焦豁免。
   */
  const isFocusWithinBranchPanel = useCallback((target: Node | null): boolean => {
    const root = branchPanelSpeedSearchRootRef.current;
    return !!root && !!target && root.contains(target);
  }, []);

  /**
   * 把分支面板 speed search 命中的分支行落成当前焦点行，并保持滚动定位到可见区域。
   */
  const applyBranchPanelSpeedSearchSelection = useCallback((rowKey: string): void => {
    if (!rowKey) return;
    setBranchPanelFocusedRowKey(rowKey);
  }, []);

  /**
   * 按当前分支面板查询跳到上一项或下一项命中，供输入联动与 F3 / Shift+F3 统一复用。
   */
  const applyBranchPanelSpeedSearch = useCallback((query: string, direction: "next" | "previous" = "next"): void => {
    const currentRowKey = branchPanelFocusedRowKey || branchPanelRows.find((row) => row.kind === "branch")?.key || "";
    const nextRowKey = findBranchPanelSpeedSearchRowKey({
      rows: branchPanelRows,
      query,
      currentRowKey,
      direction,
    });
    applyBranchPanelSpeedSearchSelection(nextRowKey);
  }, [applyBranchPanelSpeedSearchSelection, branchPanelFocusedRowKey, branchPanelRows]);

  /**
   * 同步分支面板可编辑搜索框内容，沿用现有匹配与焦点跳转逻辑。
   */
  const handleBranchPanelSpeedSearchInputChange = useCallback((nextQuery: string): void => {
    setBranchPanelSpeedSearch(nextQuery);
    if (!nextQuery.trim()) return;
    applyBranchPanelSpeedSearch(nextQuery);
  }, [applyBranchPanelSpeedSearch]);

  useEffect(() => {
    if (!branchPanelSpeedSearchOpen) return;

    /**
     * 点击分支面板外部时按 IDEA `focusLost -> manageSearchPopup(null)` 语义关闭并清空当前搜索。
     */
    const handleBranchPanelSpeedSearchOutsideMouseDown = (event: MouseEvent): void => {
      const root = branchPanelSpeedSearchRootRef.current;
      const target = event.target as Node | null;
      if (!root || !target || root.contains(target)) return;
      resetBranchPanelSpeedSearch();
    };

    document.addEventListener("mousedown", handleBranchPanelSpeedSearchOutsideMouseDown, true);
    return () => {
      document.removeEventListener("mousedown", handleBranchPanelSpeedSearchOutsideMouseDown, true);
    };
  }, [branchPanelSpeedSearchOpen, resetBranchPanelSpeedSearch]);

  useEffect(() => {
    if (!branchPanelSpeedSearchOpen) return;
    const input = branchPanelSpeedSearchInputRef.current;
    if (!input) return;
    input.focus();
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
  }, [branchPanelSpeedSearchOpen]);

  /**
   * 判断某个 Git 活动是否需要展示为顶部过程提示，避免后台刷新类请求打扰用户。
   */
  const shouldShowGitNoticeForAction = useCallback((action: string): boolean => {
    return action === "flow.fetch" || action === "push.execute";
  }, []);

  /**
   * 判断某个活动是否应纳入正式 Update Session 视图；当前仅收口普通“更新项目”主流程。
   */
  const shouldTrackUpdateSessionForAction = useCallback((action: string): boolean => {
    return action === "flow.pull";
  }, []);

  /**
   * 清理指定提示的自动关闭定时器，避免重复关闭与内存泄漏。
   */
  const clearGitNoticeTimer = useCallback((noticeId: number): void => {
    const timers = gitNoticeTimersRef.current;
    const timerId = timers.get(noticeId);
    if (timerId === undefined) return;
    window.clearTimeout(timerId);
    timers.delete(noticeId);
  }, []);

  /**
   * 移除顶部 Git 提示，并同步回收其自动关闭定时器。
   */
  const removeGitNotice = useCallback((noticeId: number): void => {
    clearGitNoticeTimer(noticeId);
    setGitNotices((prev) => prev.filter((item) => item.id !== noticeId));
  }, [clearGitNoticeTimer]);

  /**
   * 按 requestId 移除顶部 Git 提示，供“失败已转入进行中状态”的场景直接撤掉误导性报错横幅。
   */
  const removeGitNoticeByRequestId = useCallback((requestId?: number): void => {
    const normalizedRequestId = Math.max(0, Math.floor(Number(requestId) || 0));
    if (!normalizedRequestId) return;
    const targetNotice = gitNoticesRef.current.find((item) => item.requestId === normalizedRequestId);
    if (!targetNotice) return;
    removeGitNotice(targetNotice.id);
  }, [removeGitNotice]);

  /**
   * 为已完成的顶部 Git 提示安排 30 秒自动关闭。
   */
  const scheduleGitNoticeAutoClose = useCallback((noticeId: number): void => {
    clearGitNoticeTimer(noticeId);
    const timerId = window.setTimeout(() => {
      removeGitNotice(noticeId);
    }, GIT_NOTICE_AUTO_CLOSE_MS);
    gitNoticeTimersRef.current.set(noticeId, timerId);
  }, [clearGitNoticeTimer, removeGitNotice]);

  /**
   * 根据活动事件创建或更新“执行中”提示，确保用户能看到当前 Git 正在做什么。
   */
  const upsertRunningGitNotice = useCallback((activity: {
    requestId: number;
    action: string;
    message: string;
  }): void => {
    if (!shouldShowGitNoticeForAction(activity.action)) return;
    const requestId = Math.max(0, Math.floor(Number(activity.requestId) || 0));
    if (!requestId) return;
    setGitNotices((prev) => {
      const index = prev.findIndex((item) => item.requestId === requestId);
      if (index >= 0) {
        const next = prev.slice();
        next[index] = {
          ...next[index],
          message: activity.message,
          running: true,
          tone: "info",
        };
        return next;
      }
      const notice: GitNoticeItem = {
        id: gitNoticeSeqRef.current + 1,
        requestId,
        action: activity.action,
        tone: "info",
        message: activity.message,
        running: true,
        createdAt: Date.now(),
      };
      gitNoticeSeqRef.current = notice.id;
      return [notice, ...prev];
    });
  }, [shouldShowGitNoticeForAction]);

  /**
   * 清理指定 Update Session 的自动关闭定时器，避免结束态重复排程。
   */
  const clearUpdateSessionTimer = useCallback((requestId: number): void => {
    const timers = updateSessionTimersRef.current;
    const timerId = timers.get(requestId);
    if (timerId == null) return;
    window.clearTimeout(timerId);
    timers.delete(requestId);
  }, []);

  /**
   * 关闭指定 Update Session 条目，并在必要时同步清理控制台聚焦状态。
   */
  const removeUpdateSessionEntry = useCallback((requestId: number): void => {
    clearUpdateSessionTimer(requestId);
    setUpdateSessionEntries((prev) => dismissUpdateSessionEntry(prev, requestId));
    setFocusedUpdateSessionRequestId((prev) => (prev === requestId ? null : prev));
  }, [clearUpdateSessionTimer]);

  /**
   * 为完成态 Update Session 安排自动关闭，默认保留 30 秒供用户查看结果详情。
   */
  const scheduleUpdateSessionAutoClose = useCallback((requestId: number): void => {
    clearUpdateSessionTimer(requestId);
    const timerId = window.setTimeout(() => {
      removeUpdateSessionEntry(requestId);
    }, GIT_NOTICE_AUTO_CLOSE_MS);
    updateSessionTimersRef.current.set(requestId, timerId);
  }, [clearUpdateSessionTimer, removeUpdateSessionEntry]);

  /**
   * 根据 start/progress 活动更新正式 Update Session 条目，统一承载运行中生命周期与 root 级快照。
   */
  const upsertRunningUpdateSession = useCallback((activity: {
    requestId: number;
    action: string;
    message: string;
    updateSession?: GitUpdateSessionProgressSnapshot;
  }): void => {
    if (!shouldTrackUpdateSessionForAction(activity.action)) return;
    const requestId = Math.max(0, Math.floor(Number(activity.requestId) || 0));
    if (!requestId) return;
    clearUpdateSessionTimer(requestId);
    setUpdateSessionEntries((prev) => upsertRunningUpdateSessionEntry(prev, {
      now: Date.now(),
      requestId,
      message: activity.message,
      snapshot: activity.updateSession,
    }));
  }, [clearUpdateSessionTimer, shouldTrackUpdateSessionForAction]);

  /**
   * 将运行中的 Git 提示收口为结果提示；若不存在对应运行项，则直接补一条最终提示。
   */
  const finalizeGitNotice = useCallback((args: {
    requestId?: number;
    action: string;
    tone: GitNoticeTone;
    message: string;
    detailLines?: string[];
    updateNotification?: GitUpdateSessionNotificationData | null;
    actions?: GitNoticeActionItem[];
  }): void => {
    const requestId = Math.max(0, Math.floor(Number(args.requestId) || 0));
    const existing = requestId > 0 ? gitNoticesRef.current.find((item) => item.requestId === requestId) : undefined;
    const finalizedNoticeId = existing?.id || (gitNoticeSeqRef.current + 1);
    setGitNotices((prev) => {
      const index = requestId > 0 ? prev.findIndex((item) => item.requestId === requestId) : -1;
      if (index >= 0) {
        const next = prev.slice();
        const current = next[index];
        next[index] = {
          ...current,
          tone: args.tone,
          message: args.message,
          detailLines: args.detailLines,
          running: false,
          updateNotification: args.updateNotification || undefined,
          actions: args.actions,
        };
        return next;
      }
      const notice: GitNoticeItem = {
        id: gitNoticeSeqRef.current + 1,
        requestId: requestId || undefined,
        action: args.action,
        tone: args.tone,
        message: args.message,
        detailLines: args.detailLines,
        running: false,
        createdAt: Date.now(),
        updateNotification: args.updateNotification || undefined,
        actions: args.actions,
      };
      gitNoticeSeqRef.current = notice.id;
      return [notice, ...prev];
    });
    scheduleGitNoticeAutoClose(finalizedNoticeId);
  }, [scheduleGitNoticeAutoClose]);

  /**
   * 收口 Update Session 结果态，统一保留 notification/root 详情并触发 30 秒自动关闭。
   */
  const finalizeUpdateSessionNotice = useCallback((args: {
    requestId?: number;
    tone: GitNoticeTone;
    message: string;
    updateNotification?: GitUpdateSessionNotificationData | null;
    resultData?: any;
  }): void => {
    const requestId = Math.max(0, Math.floor(Number(args.requestId) || 0));
    if (!requestId) return;
    setUpdateSessionEntries((prev) => finalizeUpdateSessionEntry(prev, {
      now: Date.now(),
      requestId,
      tone: args.tone === "danger" ? "danger" : args.tone === "warn" ? "warn" : "info",
      message: args.message,
      notification: args.updateNotification,
      resultData: args.resultData,
      autoCloseDelayMs: GIT_NOTICE_AUTO_CLOSE_MS,
    }));
    scheduleUpdateSessionAutoClose(requestId);
  }, [scheduleUpdateSessionAutoClose]);

  /**
   * 对支持取消的运行中 Git 提示发出取消请求；当前主要用于 Update Project。
   */
  const cancelRunningGitNoticeAsync = useCallback(async (notice: GitNoticeItem): Promise<void> => {
    const requestId = Math.max(0, Math.floor(Number(notice.requestId) || 0));
    if (!requestId) return;
    const res = await cancelGitFeatureRequestAsync(requestId, gitWorkbenchText("workbench.notices.updateCancelled", "更新项目已取消"));
    if (!res.ok) {
      setError(toErrorText(res.error, gitWorkbenchText("workbench.notices.cancelRequestFailed", "发送取消请求失败")));
      return;
    }
    if (res.data?.cancelled !== true) {
      setError(gitWorkbenchText("workbench.notices.updateRequestNotCancelable", "当前更新请求已结束或不可取消"));
    }
  }, []);

  /**
   * 把流程返回值生成的提示文案转换为顶部通知，统一支持 30 秒自动关闭。
   */
  const pushFlowFeedbackNotice = useCallback((args: {
    action: "fetch" | "pull" | "push" | "updateBranch" | "pushBranch";
    requestId?: number;
    data?: any;
    branchName?: string;
  }): void => {
    const feedback = buildFlowFeedback(args.action, args.data, { branchName: args.branchName });
    if (!feedback) return;
    const updateNotification = args.action === "pull" || args.action === "updateBranch"
      ? extractUpdateSessionNotification(args.data)
      : null;
    if (args.action === "pull") {
      finalizeUpdateSessionNotice({
        requestId: args.requestId,
        tone: feedback.tone,
        message: feedback.message,
        updateNotification,
        resultData: args.data,
      });
      return;
    }
    finalizeGitNotice({
      requestId: args.requestId,
      action: args.action,
      tone: feedback.tone,
      message: feedback.message,
      updateNotification,
    });
  }, [finalizeGitNotice, finalizeUpdateSessionNotice]);

  /**
   * 同步缓存当前 Git 提示列表，供自动关闭排程与按 requestId 查找复用。
   */
  useEffect(() => {
    gitNoticesRef.current = gitNotices;
  }, [gitNotices]);

  /**
   * 切换 Update Session 卡片展开状态，统一用于运行态与完成态详情视图。
   */
  const toggleUpdateSessionExpanded = useCallback((requestId: number): void => {
    setUpdateSessionEntries((prev) => toggleUpdateSessionEntryExpanded(prev, requestId));
  }, []);

  /**
   * 将底部控制台显式聚焦到指定 Update Session，补齐“按当前 session 查看控制台”的展示语义。
   */
  const focusUpdateSessionConsole = useCallback((requestId: number): void => {
    setBottomCollapsed(false);
    setBottomTab("log");
    setFocusedUpdateSessionRequestId(requestId);
  }, []);

  /**
   * 取消当前控制台上的 Update Session 聚焦，恢复普通控制台浏览状态。
   */
  const clearFocusedUpdateSession = useCallback((): void => {
    setFocusedUpdateSessionRequestId(null);
  }, []);

  /**
   * 当分支弹窗内容变化时，自动校正当前选中项到可选行。
   */
  useEffect(() => {
    if (!branchPopupOpen) return;
    if (branchSelectableIndexes.length === 0) {
      setBranchPopupIndex(0);
      return;
    }
    if (!branchSelectableIndexes.includes(branchPopupIndex)) {
      setBranchPopupIndex(branchSelectableIndexes[0]);
    }
  }, [branchPopupIndex, branchPopupOpen, branchSelectableIndexes]);

  /**
   * 统一打开右键菜单，收敛事件坐标并记录目标对象。
   */
  const openContextMenu = useCallback((
    event: React.MouseEvent,
    type: MenuState["type"],
    target?: string,
    targetKind?: MenuState["targetKind"],
    changeListId?: string,
    selectionRowKeys?: string[],
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    const point = resolveMenuAnchorPoint({
      clientX: event.clientX,
      clientY: event.clientY,
      pageX: event.pageX,
      pageY: event.pageY,
    });
    setMenu({ x: point.x, y: point.y, type, target, targetKind, changeListId, selectionRowKeys });
  }, []);

  /**
   * 将仓库相对路径转换为绝对路径，供外部编辑器打开。
   */
  const toRepoAbsolutePath = useCallback((relPath: string, targetRepoRoot?: string): string => {
    return buildRepoFileAbsolutePath(String(targetRepoRoot || repoRoot || ""), relPath);
  }, [repoRoot]);

  /**
   * 在外部 IDE 中打开文件（对应菜单“编辑源”）。
   */
  const openSourceInIdeAsync = useCallback(async (relPath: string, targetRepoRoot?: string): Promise<void> => {
    const absoluteRepoRoot = String(targetRepoRoot || repoRoot || "").trim();
    const abs = toRepoAbsolutePath(relPath, absoluteRepoRoot);
    if (!abs) return;
    const res = await window.host.utils.openPathAtPosition(abs, { projectPath: absoluteRepoRoot || repoPath });
    if (!res?.ok) setError(toErrorText(res?.error, gitWorkbenchText("workbench.errors.openFileFailed", "打开文件失败")));
  }, [repoPath, repoRoot, toRepoAbsolutePath]);

  /**
   * 在外部 IDE 中打开任意绝对路径文件，供“打开仓库版本”这类临时文件动作复用。
   */
  const openAbsolutePathInIdeAsync = useCallback(async (absolutePath: string, projectRoot?: string): Promise<void> => {
    const abs = String(absolutePath || "").trim();
    if (!abs) return;
    const res = await window.host.utils.openPathAtPosition(abs, { projectPath: String(projectRoot || repoRoot || repoPath || "").trim() || undefined });
    if (!res?.ok) setError(toErrorText(res?.error, gitWorkbenchText("workbench.errors.openFileFailed", "打开文件失败")));
  }, [repoPath, repoRoot]);

  /**
   * 用系统默认程序打开任意绝对路径文件，供临时修订文件与仓库内真实文件共用。
   */
  const openAbsolutePathInSystemAsync = useCallback(async (absolutePath: string): Promise<void> => {
    const abs = String(absolutePath || "").trim();
    if (!abs) return;
    const res = await window.host.utils.openPath(abs);
    if (!res?.ok) setError(toErrorText(res?.error, gitWorkbenchText("workbench.errors.openFileFailed", "打开文件失败")));
  }, []);

  /**
   * 用系统默认方式打开仓库内文件，作为 binary/过大冲突条目的直接 fallback。
   */
  const openRepoPathInSystemAsync = useCallback(async (relPath: string, targetRepoRoot?: string): Promise<void> => {
    const abs = toRepoAbsolutePath(relPath, targetRepoRoot);
    if (!abs) return;
    await openAbsolutePathInSystemAsync(abs);
  }, [openAbsolutePathInSystemAsync, toRepoAbsolutePath]);

  /**
   * 把当前 Diff 解析成真实外部打开目标，历史/索引版本会先由主进程落成临时文件后再交给外部程序。
   */
  const openDiffExternalTargetAsync = useCallback(async (target: "ide" | "system"): Promise<void> => {
    if (!repoRoot || !diff || !canOpenExternalDiffTarget(diff)) return;
    const res = await getDiffOpenPathAsync(repoRoot, {
      path: diff.path,
      oldPath: diff.oldPath,
      mode: diff.mode,
      hash: diff.mode === "commit" ? (diff.hash || selectedCommitHashes[0]) : diff.hash,
      hashes: diff.mode === "commit" ? diff.hashes : diff.hashes,
      shelfRef: diff.shelfRef,
    });
    const absolutePath = String(res.data?.path || "").trim();
    if (!res.ok || !absolutePath) {
      setError(getErrorText(res.error, "workbench.diff.openExternalFailed", "打开比较文件失败"));
      return;
    }
    if (target === "ide") {
      await openAbsolutePathInIdeAsync(absolutePath, repoRoot);
      return;
    }
    await openAbsolutePathInSystemAsync(absolutePath);
  }, [diff, getErrorText, openAbsolutePathInIdeAsync, openAbsolutePathInSystemAsync, repoRoot, selectedCommitHashes]);

  /**
   * 在当前工作台或新开的仓库窗口中打开指定 repo root，供多仓结果动作跳回目标仓继续处理。
   */
  const openRepoRootInAppAsync = useCallback(async (
    targetRepoRoot: string,
    options?: {
      rootName?: string;
      successMessage?: string;
    },
  ): Promise<boolean> => {
    const effectiveRepoRoot = String(targetRepoRoot || "").trim();
    if (!effectiveRepoRoot) return false;
    if (repoRoot && effectiveRepoRoot === repoRoot) return true;
    if (onOpenProjectInApp) {
      const ok = await onOpenProjectInApp(effectiveRepoRoot);
      if (!ok) {
        setError(gitWorkbenchText("workbench.errors.openProjectFailed", "应用内打开项目失败"));
        return false;
      }
    } else {
      const openRes = await window.host.utils.openPath(effectiveRepoRoot);
      if (!openRes?.ok) {
        setError(toErrorText(openRes?.error, gitWorkbenchText("workbench.errors.openFileFailed", "打开目录失败")));
        return false;
      }
    }
    finalizeGitNotice({
      action: "flow.pull",
      tone: "info",
      message: String(options?.successMessage || "").trim() || gitWorkbenchText("workbench.errors.openProjectOpened", "已打开 {{rootName}}", {
        rootName: options?.rootName || effectiveRepoRoot,
      }),
    });
    return true;
  }, [finalizeGitNotice, onOpenProjectInApp, repoRoot]);

  /**
   * 关闭当前 Update Info 视图并恢复普通日志筛选上下文。
   */
  const closeUpdateInfoLogView = useCallback((): void => {
    setUpdateInfoLogState(null);
    setPendingLogSelectionHash("");
  }, []);

  /**
   * 当前仓按规则豁免 IDE Local History 宿主能力，因此统一映射到 Git 文件历史；仍支持携带目标修订号，对齐 IDEA “Show History / Show History for Revision” 的入口语义。
   */
  const showPathHistory = useCallback((relPath: string, options?: { revision?: string; followRenames?: boolean }): void => {
    const clean = String(relPath || "").trim().replace(/\\/g, "/");
    if (!clean) return;
    const revision = String(options?.revision || "").trim();
    const followRenames = options?.followRenames !== false;
    closeUpdateInfoLogView();
    setBottomCollapsed(false);
    setBottomTab("git");
    setSelectedCommitHashes([]);
    setDetails(null);
    setPendingLogSelectionHash(revision);
    setLogFilters(normalizeGitLogFilters({
      ...DEFAULT_LOG_FILTERS,
      path: clean,
      revision,
      followRenames,
    }));
  }, [closeUpdateInfoLogView]);

  /**
   * 显式显示 Worktrees 页签；对齐 IDEA openedByUser 语义，并消耗 NEW badge。
   */
  const showWorktreesTabByUser = useCallback((options?: { select?: boolean }): void => {
    updateWorktreeTabPreferences((prev) => markWorktreeTabOpenedByUser(prev));
    if (options?.select === false) return;
    setBottomCollapsed(false);
    setBottomTab("worktrees");
  }, [updateWorktreeTabPreferences]);

  /**
   * 标记用户已经实际使用过 worktree 能力，避免 NEW badge 在创建/打开/删除后继续保留。
   */
  const markWorktreeCapabilityUsed = useCallback((): void => {
    updateWorktreeTabPreferences((prev) => markWorktreeFeatureUsed(prev));
  }, [updateWorktreeTabPreferences]);

  /**
   * 显式显示冲突面板；会重置当前关闭记忆，并在需要时重新开启自动面板 gate。
   */
  const showConflictsPanelByUser = useCallback((options?: { select?: boolean }): void => {
    updateConflictsPanelPreferences((prev) => revealConflictsPanel(prev));
    if (options?.select === false) return;
    setBottomCollapsed(false);
    setBottomTab("conflicts");
  }, [updateConflictsPanelPreferences]);

  /**
   * 完全停用冲突自动面板 gate；用于替代 IDEA registry 开关的当前仓等价实现。
   */
  const disableConflictsPanelGate = useCallback((): void => {
    updateConflictsPanelPreferences((prev) => setConflictsPanelGateEnabled(prev, false));
    if (bottomTab === "conflicts") setBottomTab("git");
  }, [bottomTab, updateConflictsPanelPreferences]);

  /**
   * 按指定 root 范围激活独立 Update Info 日志视图，避免污染普通日志筛选。
   */
  const openUpdateNotificationRange = useCallback((notification: GitUpdateSessionNotificationData, range: GitUpdateNotificationRange, autoOpened: boolean = false): void => {
    if (repoRoot && range.repoRoot !== repoRoot) {
      void (async () => {
        const opened = await openRepoRootInAppAsync(range.repoRoot, {
          rootName: range.rootName,
          successMessage: gitWorkbenchText("workbench.errors.openProjectContinueUpdates", "已在应用内打开 {{rootName}}，可继续查看该仓库的更新提交", { rootName: range.rootName }),
        });
        if (!opened) setError(gitWorkbenchText("workbench.errors.openProjectFailed", "应用内打开项目失败"));
      })();
      return;
    }
    const nextState = buildUpdateInfoLogState({
      notification,
      preferredRepoRoot: range.repoRoot,
      autoOpened,
      currentPathFilter: activeLogFilters.path,
    });
    if (!nextState) {
      setError(gt("workbench.updateResult.viewCommitsUnavailable", "当前结果未提供可查看的提交范围"));
      return;
    }
    setBottomCollapsed(false);
    setBottomTab("git");
    setBranchCompareState(null);
    setUpdateInfoLogState(nextState);
    setPendingLogSelectionHash(range.range.end);
  }, [activeLogFilters.path, openRepoRootInAppAsync, repoRoot]);

  /**
   * 根据通知里的多范围数据决定直接打开日志还是先展示范围选择器。
   */
  const openUpdateNotificationCommits = useCallback((notification: GitUpdateSessionNotificationData): void => {
    const ranges = Array.isArray(notification.ranges)
      ? notification.ranges.filter((range) => !!range?.repoRoot && !!range?.range?.start && !!range?.range?.end)
      : [];
    if (ranges.length <= 0) return;
    if (ranges.length === 1) {
      openUpdateNotificationRange(notification, ranges[0]!);
      return;
    }
    setUpdateCommitRangeChoice({
      notification,
      ranges,
    });
  }, [openUpdateNotificationRange]);

  useEffect(() => {
    for (const entry of updateSessionEntries) {
      if (entry.lifecycle !== "finished" || !entry.notification) continue;
      if (updateInfoAutoOpenedRequestIdsRef.current.has(entry.requestId)) continue;
      updateInfoAutoOpenedRequestIdsRef.current.add(entry.requestId);
      const notification = entry.notification;
      const ranges = Array.isArray(notification.ranges)
        ? notification.ranges.filter((range) => !!String(range.repoRoot || "").trim())
        : [];
      const preferredRange = ranges.find((range) => range.repoRoot === repoRoot)
        || notification.primaryRange
        || ranges[0];
      if (!preferredRange || !repoRoot || preferredRange.repoRoot !== repoRoot) continue;
      openUpdateNotificationRange(notification, preferredRange, true);
      break;
    }
  }, [openUpdateNotificationRange, repoRoot, updateSessionEntries]);

  /**
   * 将当前 root 更新约束为单仓执行，避免 result/session 卡片上的“重试该仓”再次带出整组多仓范围。
   */
  const buildSingleRootUpdatePayload = useCallback((targetRepoRoot: string, payloadPatch?: Record<string, any>): Record<string, any> => {
    return {
      repoRoots: [targetRepoRoot],
      skipRoots: [],
      skippedRoots: [],
      includeNestedRoots: false,
      rootScanMaxDepth: 0,
      ...(payloadPatch || {}),
    };
  }, []);

  /**
   * 打开保存改动的恢复入口；优先遵循后端 view manager 给出的视图载荷，再切换到对应列表面板。
   */
  const openSavedChangesRecoveryAsync = useCallback(async (
    targetRepoRoot: string,
    saveChangesPolicy: "stash" | "shelve",
    payload?: {
      repoRoots?: string[];
      ref?: string;
      source?: string;
      viewKind?: string;
    },
  ): Promise<void> => {
    await openSavedChangesViewAsync({
      currentRepoRoot: repoRoot,
      targetRepoRoot,
      saveChangesPolicy,
      payload,
      translate: gt,
      getShelvesAsync,
      getStashListAsync,
      openRepoRootInAppAsync,
      setLeftTab,
      setShelfItems,
      setStashItems,
      setError,
      formatError: toErrorText,
    });
  }, [gt, openRepoRootInAppAsync, repoRoot]);

  /**
   * 把 preserving 结果里的“查看已保存改动”动作转成 notice 按钮，确保保存后未恢复的改动仍能直接回到对应 stash/shelf。
   */
  const buildPreservingNoticeActions = useCallback((data: any): GitNoticeActionItem[] => {
    const candidates: GitUpdatePostAction[] = [];
    const pushCandidate = (candidate: unknown): void => {
      if (!candidate || typeof candidate !== "object") return;
      const kind = String((candidate as any).kind || "").trim();
      const label = String((candidate as any).label || "").trim();
      if (!kind || !label) return;
      if (kind !== "open-saved-changes") return;
      candidates.push(candidate as GitUpdatePostAction);
    };

    pushCandidate(data?.preservingState?.savedChangesAction);

    return candidates.map((action, index) => ({
      id: `${String(action.kind || "").trim()}:${String(action.label || "").trim()}:${index}`,
      label: action.label,
      onClick: async () => {
        if (action.kind === "open-saved-changes") {
          const targetRepoRoot = String(action.repoRoot || action.payload?.repoRoot || "").trim();
          const saveChangesPolicy = action.payload?.saveChangesPolicy === "shelve" ? "shelve" : "stash";
          if (!targetRepoRoot) {
            setError(gt("workbench.updateResult.savedChangesRepoUnavailable", "当前结果未提供保存改动所属仓库"));
            return;
          }
          await openSavedChangesRecoveryAsync(targetRepoRoot, saveChangesPolicy, action.payload && typeof action.payload === "object" ? action.payload : undefined);
        }
      },
    }));
  }, [openSavedChangesRecoveryAsync]);

  /**
   * 消费跨仓保存改动打开请求，确保切仓后仍能自动定位到目标 stash/shelf 记录。
   */
  useEffect(() => {
    if (!repoRoot) return;
    const pending = consumePendingSavedChangesOpenRequest(repoRoot);
    if (!pending) return;
    void openSavedChangesRecoveryAsync(
      pending.targetRepoRoot,
      pending.saveChangesPolicy,
      pending.payload,
    );
  }, [openSavedChangesRecoveryAsync, repoRoot]);

  /**
   * 统一导出 Patch 文本；保存模式走宿主保存对话框，复制模式保持剪贴板链路不变。
   */
  const exportPatchTextAsync = useCallback(async (
    patchText: string,
    options: {
      mode: "save" | "clipboard";
      defaultPath?: string;
    },
  ): Promise<void> => {
    if (options.mode === "save") {
      const saved = await window.host.utils.saveText(patchText, options.defaultPath);
      if (!saved?.ok && !saved?.canceled) setError(toErrorText(saved?.error, gt("workbench.patch.saveFailed", "保存补丁失败")));
      return;
    }
    const copied = await window.host.utils.copyText(patchText);
    if (!copied?.ok) setError(toErrorText(copied?.error, gt("workbench.patch.copyFailed", "补丁已生成，但复制失败")));
  }, []);

  const viewOptions = status?.viewOptions || DEFAULT_GIT_VIEW_OPTIONS;
  const localChangesConfig = status?.localChanges || DEFAULT_LOCAL_CHANGES_CONFIG;
  const effectiveCommitAllSetting = localChangesConfig.stagingAreaEnabled && localChangesConfig.commitAllEnabled !== false;
  const displayChangeLists = useMemo(() => {
    return (status?.changeLists?.lists || []).map((one) => ({
      ...one,
      name: resolveDisplayChangeListName(one),
    }));
  }, [status?.changeLists?.lists]);
  const activeChangeListId = useMemo<string>(() => {
    return String(status?.changeLists?.activeListId || "").trim();
  }, [status?.changeLists?.activeListId]);
  const activeChangeList = useMemo<GitChangeList | null>(() => {
    return displayChangeLists.find((item) => String(item.id || "").trim() === activeChangeListId) || null;
  }, [activeChangeListId, displayChangeLists]);
  const activeChangeListDraft = useMemo<GitChangeListCommitDraft>(() => {
    return readChangeListCommitDraft(activeChangeList);
  }, [activeChangeList]);
  useEffect(() => {
    if (commitAmendEnabled) return;
    if (!repoRoot) return;
    if (restoredPersistedCommitMessageRepoRef.current === repoRoot) return;
    const nextMessage = resolveInitialCommitMessage({
      currentMessage: commitMessageValueRef.current,
      persistedMessage: typeof window === "undefined" ? "" : readLastCommitMessage(window.localStorage),
      changeListDraftMessage: activeChangeListDraft.message,
      changeListsEnabled: localChangesConfig.changeListsEnabled,
      stagingAreaEnabled: localChangesConfig.stagingAreaEnabled,
      commitAmendEnabled,
    });
    restoredPersistedCommitMessageRepoRef.current = repoRoot;
    if (!nextMessage || nextMessage === commitMessageValueRef.current) return;
    setCommitMessage(nextMessage);
  }, [
    activeChangeListDraft.message,
    commitAmendEnabled,
    localChangesConfig.changeListsEnabled,
    localChangesConfig.stagingAreaEnabled,
    repoRoot,
  ]);
  useEffect(() => {
    return () => {
      if (typeof window === "undefined") return;
      const sanitized = sanitizeCommitAdvancedOptionsState(commitAdvancedOptionsState);
      if (!shouldPersistLastCommitMessage(commitMessageValueRef.current, sanitized.cleanupMessage)) return;
      writeLastCommitMessage(window.localStorage, commitMessageValueRef.current);
    };
  }, [commitAdvancedOptionsState, repoRoot]);
  const availableCommitGroupingKeys = useMemo<CommitGroupingKey[]>(() => {
    return normalizeCommitGroupingKeys(viewOptions.availableGroupingKeys, true);
  }, [viewOptions.availableGroupingKeys]);
  const activeCommitGroupingKeys = useMemo<CommitGroupingKey[]>(() => {
    const preferred = normalizeCommitGroupingKeys(viewOptions.groupingKeys, viewOptions.groupByDirectory);
    return preferred.filter((key) => availableCommitGroupingKeys.includes(key));
  }, [availableCommitGroupingKeys, viewOptions.groupByDirectory, viewOptions.groupingKeys]);
  const visibleIgnoredEntries = useMemo<GitStatusEntry[]>(() => {
    return viewOptions.showIgnored ? ignoredEntries : [];
  }, [ignoredEntries, viewOptions.showIgnored]);
  const combinedStatusEntries = useMemo<GitStatusEntry[]>(() => {
    return [...(status?.entries || []), ...visibleIgnoredEntries];
  }, [status?.entries, visibleIgnoredEntries]);
  const unresolvedConflictEntries = useMemo<GitStatusEntry[]>(() => {
    return (status?.entries || []).filter((entry) => entry.conflictState === "conflict");
  }, [status?.entries]);
  const conflictsPanelSnapshot = useMemo<ConflictsPanelSnapshot>(() => {
    return buildConflictsPanelSnapshot(status?.entries || []);
  }, [status?.entries]);
  const conflictResolverScopeRepoRoot = useMemo<string>(() => {
    return normalizeRepoRelativePath(conflictResolverDialogState?.scopeRepoRoot);
  }, [conflictResolverDialogState?.scopeRepoRoot]);
  const conflictResolverScopedEntries = useMemo<GitStatusEntry[]>(() => {
    if (!conflictResolverScopeRepoRoot) return unresolvedConflictEntries;
    return filterConflictEntriesByScope(unresolvedConflictEntries, conflictResolverScopeRepoRoot);
  }, [conflictResolverScopeRepoRoot, unresolvedConflictEntries]);
  const resolvedConflictEntries = useMemo<GitStatusEntry[]>(() => {
    return (status?.entries || []).filter((entry) => entry.conflictState === "resolved");
  }, [status?.entries]);
  const conflictResolverScopedResolvedEntries = useMemo<GitStatusEntry[]>(() => {
    if (!conflictResolverScopeRepoRoot) return resolvedConflictEntries;
    return filterConflictEntriesByScope(resolvedConflictEntries, conflictResolverScopeRepoRoot);
  }, [conflictResolverScopeRepoRoot, resolvedConflictEntries]);
  const worktreeTabVisible = useMemo<boolean>(() => {
    return shouldShowWorktreeTab({
      preferences: worktreeTabPreferences,
      items: worktreeItems,
    });
  }, [worktreeItems, worktreeTabPreferences]);
  const showWorktreeNewBadge = useMemo<boolean>(() => {
    return shouldShowWorktreeNewBadge({
      preferences: worktreeTabPreferences,
      items: worktreeItems,
    });
  }, [worktreeItems, worktreeTabPreferences]);
  const displayWorktreeItems = useMemo<GitWorktreeItem[]>(() => {
    return worktreeItems.length > 1 ? worktreeItems : [];
  }, [worktreeItems]);
  const conflictsPanelVisible = useMemo<boolean>(() => {
    return shouldShowConflictsPanel({
      preferences: conflictsPanelPreferences,
      snapshot: conflictsPanelSnapshot,
    });
  }, [conflictsPanelPreferences, conflictsPanelSnapshot]);
  useEffect(() => {
    updateConflictsPanelPreferences((prev) => clearDismissedConflictsPanelSignature(prev, conflictsPanelSnapshot));
  }, [conflictsPanelSnapshot, updateConflictsPanelPreferences]);
  useEffect(() => {
    const currentSignature = String(conflictsPanelSnapshot.signature || "").trim();
    if (!currentSignature || currentSignature === conflictPanelSignatureRef.current) {
      conflictPanelSignatureRef.current = currentSignature;
      return;
    }
    conflictPanelSignatureRef.current = currentSignature;
    if (!conflictsPanelPreferences.gateEnabled || !conflictsPanelSnapshot.hasAny) return;
    setBottomCollapsed(false);
  }, [conflictsPanelPreferences.gateEnabled, conflictsPanelSnapshot.hasAny, conflictsPanelSnapshot.signature]);
  useEffect(() => {
    if (bottomTab === "worktrees" && !worktreeTabVisible) {
      setBottomTab("git");
      return;
    }
    if (bottomTab === "conflicts" && !conflictsPanelVisible) {
      setBottomTab("git");
    }
  }, [bottomTab, conflictsPanelVisible, worktreeTabVisible]);
  /**
   * 仅关闭当前冲突 signature 的自动面板，不禁用功能；新的冲突集仍会重新出现。
   */
  const closeConflictsPanelByUser = useCallback((): void => {
    updateConflictsPanelPreferences((prev) => dismissConflictsPanelForSnapshot(prev, conflictsPanelSnapshot));
    if (bottomTab === "conflicts") setBottomTab("git");
  }, [bottomTab, conflictsPanelSnapshot, updateConflictsPanelPreferences]);
  const unresolvedConflictCount = useMemo<number>(() => {
    return unresolvedConflictEntries.length;
  }, [unresolvedConflictEntries]);
  const resolvedConflictCount = useMemo<number>(() => {
    return resolvedConflictEntries.length;
  }, [resolvedConflictEntries]);
  const shouldUseCherryPickCommitCompletion = useMemo<boolean>(() => {
    return shouldFinalizeCherryPickByCommit({
      status,
      unresolvedConflictCount,
      hasChanges: (status?.entries?.length || 0) > 0,
    });
  }, [status, unresolvedConflictCount]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  /**
   * 切换活动 changelist 时恢复对应的提交草稿；amend 模式下不覆盖当前正在回填的上一提交内容。
   */
  useEffect(() => {
    if (commitAmendEnabled) return;
    if (!localChangesConfig.changeListsEnabled || localChangesConfig.stagingAreaEnabled) return;
    if (!activeChangeListId || restoredChangeListDraftListIdRef.current === activeChangeListId) return;
    restoredChangeListDraftListIdRef.current = activeChangeListId;
    setCommitMessage(activeChangeListDraft.message);
    setCommitAdvancedOptionsState((prev) => patchCommitAdvancedOptionsState(prev, {
      author: activeChangeListDraft.author,
      authorDate: activeChangeListDraft.authorDate,
      commitRenamesSeparately: activeChangeListDraft.commitRenamesSeparately,
    }));
  }, [
    activeChangeListDraft.author,
    activeChangeListDraft.authorDate,
    activeChangeListDraft.commitRenamesSeparately,
    activeChangeListDraft.message,
    activeChangeListId,
    commitAmendEnabled,
    localChangesConfig.changeListsEnabled,
    localChangesConfig.stagingAreaEnabled,
  ]);
  /**
   * 非 amend 提交流程下按活动 changelist 持久化提交草稿，避免列表切换后丢失 message/author/authorDate/rename 选项。
   */
  useEffect(() => {
    if (commitAmendEnabled) return;
    if (!repoRoot || !activeChangeListId || !activeChangeList || activeChangeList.readOnly) return;
    if (!localChangesConfig.changeListsEnabled || localChangesConfig.stagingAreaEnabled) return;
    if (areChangeListCommitDraftsEqual(activeChangeListDraft, currentCommitComposerDraft)) return;
    if (persistChangeListDraftTimerRef.current) {
      window.clearTimeout(persistChangeListDraftTimerRef.current);
      persistChangeListDraftTimerRef.current = null;
    }
    persistChangeListDraftTimerRef.current = window.setTimeout(() => {
      persistChangeListDraftTimerRef.current = null;
      const patch = buildChangeListCommitDraftPatch(activeChangeList, currentCommitComposerDraft);
      void updateChangeListDataAsync(repoRoot, activeChangeListId, patch).then((res) => {
        if (!res.ok) {
          setError(toErrorText(res.error, gt("workbench.changelist.saveCommitDraftFailed", "保存更改列表提交草稿失败")));
          return;
        }
        setStatus((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            changeLists: {
              ...prev.changeLists,
              lists: (prev.changeLists?.lists || []).map((item) => {
                if (String(item.id || "").trim() !== activeChangeListId) return item;
                return {
                  ...item,
                  comment: patch.comment,
                  data: patch.data,
                };
              }),
            },
          };
        });
      });
    }, 300);
    return () => {
      if (!persistChangeListDraftTimerRef.current) return;
      window.clearTimeout(persistChangeListDraftTimerRef.current);
      persistChangeListDraftTimerRef.current = null;
    };
  }, [
    activeChangeList,
    activeChangeListDraft,
    activeChangeListId,
    commitAmendEnabled,
    currentCommitComposerDraft,
    localChangesConfig.changeListsEnabled,
    localChangesConfig.stagingAreaEnabled,
    repoRoot,
  ]);
  useEffect(() => {
    if (!conflictResolverDialogState?.sessionSnapshot) return;
    const nextSelection = sanitizeMergeConflictSelection({
      snapshot: conflictResolverDialogState.sessionSnapshot,
      selectedPath: conflictResolverDialogState.selectedPath,
      checkedPaths: conflictResolverDialogState.checkedPaths,
      showResolved: conflictResolverDialogState.showResolved,
    });
    if (
      nextSelection.selectedPath === conflictResolverDialogState.selectedPath
      && nextSelection.checkedPaths.join("\u0000") === conflictResolverDialogState.checkedPaths.join("\u0000")
    ) {
      return;
    }
    setConflictResolverDialogState((prev) => prev ? { ...prev, ...nextSelection } : prev);
  }, [conflictResolverDialogState]);
  useEffect(() => {
    if (!conflictResolverDialogState) return;
    if (!shouldAutoCloseMergeConflictDialog(
      conflictResolverDialogState.sessionSnapshot,
      conflictResolverDialogState.autoCloseWhenResolved,
    )) {
      return;
    }
    if (status?.operationState && status.operationState !== "normal") return;
    conflictResolverLoadSeqRef.current += 1;
    setConflictResolverDialogState(null);
  }, [conflictResolverDialogState, status?.operationState]);
  const commitInclusionItems = useMemo(() => {
    return buildCommitInclusionItems(status?.entries || []);
  }, [status?.entries]);
  const currentCommitSelectionCount = useMemo<number>(() => {
    if (!repoRoot) return 0;
    return buildCommitWorkflowPayload(
      commitInclusionState,
      partialCommitSelectionState,
      repoRoot,
      "",
      "commit",
      undefined,
      commitHooksAvailability,
      status?.entries || [],
    ).selections.length;
  }, [commitHooksAvailability, commitInclusionState, partialCommitSelectionState, repoRoot, status?.entries]);
  /**
   * 统一计算提交按钮的可用态与阻塞原因，优先覆盖多仓 root inclusion、commit-all 与未解决冲突场景。
   */
  const commitActionBlockedReason = useMemo<string>(() => {
    if (!repoRoot) return gitWorkbenchText("commit.blocked.repoUnavailable", "当前仓库不可用");
    if (commitAmendLoading) return gitWorkbenchText("commit.blocked.readingAmend", "正在读取上一提交详情");
    if (commitAmendEnabled) return "";
    if (commitInclusionState.conflictedRepoRoots.length > 0) return gitWorkbenchText("commit.blocked.conflicts", "存在未解决冲突文件，请先解决后再提交");
    if (commitInclusionState.isCommitAll) {
      if (commitInclusionState.includedRepoRoots.length === 0) return gitWorkbenchText("commit.blocked.selectRepository", "请先选择需要提交的仓库");
      if (currentCommitSelectionCount === 0) return gitWorkbenchText("commit.blocked.noTrackedChanges", "当前所选仓库没有可提交的已跟踪更改");
      return "";
    }
    return currentCommitSelectionCount > 0 ? "" : gitWorkbenchText("commit.blocked.selectFiles", "请先勾选需要提交的文件");
  }, [
    commitAmendEnabled,
    commitAmendLoading,
    commitInclusionState.conflictedRepoRoots.length,
    commitInclusionState.includedRepoRoots.length,
    commitInclusionState.isCommitAll,
    currentCommitSelectionCount,
    repoRoot,
  ]);
  const commitActionDisabled = commitActionBlockedReason.length > 0;
  const helperGroupStateByKey = useMemo<Record<string, { updating?: boolean }>>(() => ({
    "special:ignored": { updating: ignoredLoading },
    "special:unversioned": { updating: commitTreeBusy && !status },
    "modifier:edited-commit:amend": { updating: commitAmendLoading },
  }), [commitAmendLoading, commitTreeBusy, ignoredLoading, status]);
  const commitTreeModifierGroups = useMemo<CommitPanelChangeEntryGroup[]>(() => {
    if (!commitAmendEnabled) return [];
    if (commitAmendLoading) {
      return [{
        key: "modifier:edited-commit:amend",
        label: gitWorkbenchText("commit.amendLoading", "正在读取上一提交"),
        entries: [],
        kind: "edited-commit",
        helper: true,
        sourceKind: "modifier",
        sourceId: COMMIT_AMEND_SOURCE_ID,
        actionGroupId: COMMIT_TREE_ACTION_GROUPS.mainPopup,
        toolbarActionGroupId: COMMIT_TREE_ACTION_GROUPS.mainToolbar,
      }];
    }
    if (!commitAmendDetails) return [];
    return [{
      key: "modifier:edited-commit:amend",
      label: buildCommitAmendGroupLabel(commitAmendDetails),
      entries: commitAmendDetails.entries,
      kind: "edited-commit",
      helper: true,
      sourceKind: "modifier",
      sourceId: COMMIT_AMEND_SOURCE_ID,
      actionGroupId: COMMIT_TREE_ACTION_GROUPS.mainPopup,
      toolbarActionGroupId: COMMIT_TREE_ACTION_GROUPS.mainToolbar,
    }];
  }, [commitAmendDetails, commitAmendEnabled, commitAmendLoading]);

  const changeEntryGroups = useMemo<CommitPanelChangeEntryGroup[]>(() => {
    const lists = displayChangeLists.map((one) => ({ id: one.id, name: one.name }));
    return buildCommitPanelChangeEntryGroups({
      entries: status?.entries || [],
      ignoredEntries: visibleIgnoredEntries,
      changeLists: lists,
      options: localChangesConfig,
      translate: gt,
      manyFilesThreshold: viewOptions.manyFilesThreshold,
      operationState: status?.operationState,
      stateByGroupKey: helperGroupStateByKey,
      modifierGroups: commitTreeModifierGroups,
    });
  }, [
    commitTreeModifierGroups,
    displayChangeLists,
    gt,
    helperGroupStateByKey,
    localChangesConfig,
    status?.entries,
    status?.operationState,
    viewOptions.manyFilesThreshold,
    visibleIgnoredEntries,
  ]);

  const commitTreeGroups = useMemo<CommitPanelTreeGroup[]>(() => {
    return buildCommitTreeGroups(changeEntryGroups, activeCommitGroupingKeys, commitTreeExpanded);
  }, [activeCommitGroupingKeys, changeEntryGroups, commitTreeExpanded]);
  const commitRenderRows = useMemo(() => {
    return buildCommitPanelRenderRows(commitTreeGroups, commitGroupExpanded);
  }, [commitGroupExpanded, commitTreeGroups]);
  const commitRenderRowByKey = useMemo(() => {
    return buildCommitRenderRowMap(commitRenderRows);
  }, [commitRenderRows]);
  const commitNodeByKey = useMemo<Map<string, CommitPanelTreeNode>>(() => {
    return buildCommitNodeMap(commitTreeGroups);
  }, [commitTreeGroups]);
  const commitVisibleRowKeys = useMemo<string[]>(() => {
    return commitRenderRows.map((row) => row.key);
  }, [commitRenderRows]);
  const totalCommitTreeFileCount = useMemo<number>(() => {
    return commitTreeGroups.reduce((sum, group) => sum + (group.summary?.fileCount || group.entries.length), 0);
  }, [commitTreeGroups]);
  /**
   * 按左侧面板宽度与上半区高度动态收敛提交消息输入框高度，缩小时优先让出空间给变更列表。
   */
  const commitMessageEditorHeight = useMemo<number>(() => {
    return resolveCommitMessageEditorHeight(leftPanelWidth, upperLayoutHeight);
  }, [leftPanelWidth, upperLayoutHeight]);
  /**
   * 按路径索引状态条目，便于右键菜单快速反推所属更改列表。
   */
  const statusEntryByPath = useMemo<Map<string, GitStatusEntry>>(() => {
    const map = new Map<string, GitStatusEntry>();
    for (const entry of combinedStatusEntries) {
      const key = String(entry.path || "").replace(/\\/g, "/");
      if (!key) continue;
      map.set(key, entry);
    }
    return map;
  }, [combinedStatusEntries]);
  /**
   * 按相对路径保留全部命中条目，供多仓同路径节点在 inclusion 与提交校验时按仓根二次收敛。
   */
  const statusEntriesByPath = useMemo<Map<string, GitStatusEntry[]>>(() => {
    const map = new Map<string, GitStatusEntry[]>();
    for (const entry of combinedStatusEntries) {
      const key = String(entry.path || "").replace(/\\/g, "/");
      if (!key) continue;
      const bucket = map.get(key);
      if (bucket) bucket.push(entry);
      else map.set(key, [entry]);
    }
    return map;
  }, [combinedStatusEntries]);
  /**
   * 按“仓库根 + 路径”构建精确索引，供多仓提交前校验 partial selection 与状态条目匹配。
   */
  const statusEntryByScopedPath = useMemo<Map<string, GitStatusEntry>>(() => {
    const map = new Map<string, GitStatusEntry>();
    for (const entry of combinedStatusEntries) {
      map.set(buildCommitInclusionLookupKey(entry.path, entry.repositoryRoot), entry);
    }
    return map;
  }, [combinedStatusEntries]);
  /**
   * 解析提交树当前 lead file entry，供右键菜单、Diff 组选区与 hover/Select In 主链路统一复用。
   */
  const selectedLeadCommitNode = useMemo<CommitPanelTreeNode | null>(() => {
    return selectedDiffableCommitNodeKey ? (commitNodeByKey.get(selectedDiffableCommitNodeKey) || null) : null;
  }, [commitNodeByKey, selectedDiffableCommitNodeKey]);

  /**
   * 关闭当前 Diff 并清理固定/全屏状态；当工作区/暂存区里的目标文件已失效时，也统一复用这条收口逻辑。
   */
  const closeDiffPreview = useCallback((): void => {
    setDiff(null);
    setDiffActiveLine(-1);
    setDiffFullscreen(false);
    setDiffPinned(false);
  }, []);

  useEffect(() => {
    if (!diff) return;
    if (diff.mode !== "working" && diff.mode !== "staged" && !isStageCompareDiffMode(diff.mode)) return;
    const diffPath = String(diff.path || "").trim().replace(/\\/g, "/");
    if (!diffPath) return;
    const entry = statusEntryByPath.get(diffPath);
    const stillValid = diff.mode === "staged"
      ? !!entry?.staged
      : isStageCompareDiffMode(diff.mode)
        ? !!entry?.staged && !entry.deleted
        : !!(entry && (entry.unstaged || entry.untracked));
    if (stillValid) return;
    closeDiffPreview();
  }, [closeDiffPreview, diff, statusEntryByPath]);

  /**
   * 统一应用提交树真实树行选择，并同步恢复锚点与可执行动作文件集合。
   */
  const applyCommitNodeSelection = useCallback((nextRowKeys: string[]): void => {
    const next = filterSelectableCommitRowKeys(nextRowKeys.filter((one) => !!one), commitRenderRowByKey, commitNodeByKey);
    const nextAnchors = buildCommitSelectionAnchors(next, commitRenderRowByKey, commitNodeByKey);
    const nextSelectedPaths = resolveCommitSelectedChangePaths(next, commitRenderRowByKey, commitNodeByKey);
    const nextExactlySelectedPaths = resolveCommitExactlySelectedChangePaths(next, commitNodeByKey);
    pendingCommitWorkflowActivationResetRef.current = null;
    setSelectedCommitTreeKeys((prev) => {
      const changed = !isSameStringArray(prev, next);
      if (changed) requestCommitSelectionVisibleRef.current = next.length > 0;
      return changed ? next : prev;
    });
    setCommitSelectionAnchors((prev) => (isSameCommitSelectionAnchors(prev, nextAnchors) ? prev : nextAnchors));
    setSelectedPaths((prev) => (isSameStringArray(prev, nextSelectedPaths) ? prev : nextSelectedPaths));
    setExactlySelectedPaths((prev) => (isSameStringArray(prev, nextExactlySelectedPaths) ? prev : nextExactlySelectedPaths));
  }, [commitNodeByKey, commitRenderRowByKey]);
  const selectedCommitNodeKeys = useMemo<string[]>(() => {
    return resolveSelectedCommitNodeKeys(selectedCommitTreeKeys, commitNodeByKey);
  }, [commitNodeByKey, selectedCommitTreeKeys]);
  /**
   * 保留提交树“真实单选节点”快照，供右键菜单判断目录/模块/仓库类节点能力时使用，
   * 避免误用 diff lead file 导致目录节点被当成文件节点。
   */
  const selectedSingleCommitNode = useMemo<CommitPanelTreeNode | null>(() => {
    if (selectedCommitNodeKeys.length !== 1) return null;
    return commitNodeByKey.get(selectedCommitNodeKeys[0]) || null;
  }, [commitNodeByKey, selectedCommitNodeKeys]);
  /**
   * 按 selected subtree 语义展开当前树选区中的全部文件节点，供 diffable selection 与预览链路复用。
   */
  const selectedCommitSubtreeNodeKeys = useMemo<string[]>(() => {
    return resolveSelectedSubtreeCommitNodeKeys(selectedCommitTreeKeys, commitRenderRowByKey, commitNodeByKey);
  }, [commitNodeByKey, commitRenderRowByKey, selectedCommitTreeKeys]);
  /**
   * 按提交树真实文件节点精确提取当前选中条目，避免 amend/helper 与本地更改仅按路径合并后发生语义串线。
   */
  const selectedEntries = useMemo<GitStatusEntry[]>(() => {
    return selectedCommitSubtreeNodeKeys
      .map((nodeKey) => commitNodeByKey.get(nodeKey)?.entry || null)
      .filter((entry): entry is GitStatusEntry => !!entry);
  }, [commitNodeByKey, selectedCommitSubtreeNodeKeys]);
  /**
   * 从当前提交树选区提取节点来源快照，供 selection model 区分普通状态节点与 amend 等 modifier 节点。
   */
  const selectedCommitNodeSources = useMemo<Array<{ sourceKind?: "status" | "modifier"; sourceId?: string }>>(() => {
    return Array.from(new Map(
      selectedCommitSubtreeNodeKeys
        .map((nodeKey) => commitNodeByKey.get(nodeKey))
        .filter((node): node is CommitPanelTreeNode => !!node)
        .map((node) => {
          const sourceKind = node.sourceKind;
          const sourceId = node.sourceId;
          return [`${String(sourceKind || "")}:${String(sourceId || "")}`, { sourceKind, sourceId }] as const;
        }),
    ).values());
  }, [commitNodeByKey, selectedCommitSubtreeNodeKeys]);
  /**
   * 解析提交树当前 lead file entry，供右键菜单、Diff 组选区与 hover/Select In 主链路统一复用。
   */
  const selectedLeadCommitEntry = useMemo<GitStatusEntry | null>(() => {
    if (selectedLeadCommitNode?.entry) return selectedLeadCommitNode.entry;
    return selectedEntries[0] || null;
  }, [selectedEntries, selectedLeadCommitNode]);
  const diffPartialCommitEntry = useMemo(() => {
    return getPartialCommitSelectionEntry(partialCommitSelectionState, diff?.path || "", normalizeCommitRepoRoot(selectedLeadCommitEntry?.repositoryRoot || repoRoot));
  }, [diff?.path, partialCommitSelectionState, repoRoot, selectedLeadCommitEntry?.repositoryRoot]);
  const diffPartialCommitActive = useMemo(() => {
    return isPartialCommitSelectionActive(partialCommitSelectionState, diff?.path || "", normalizeCommitRepoRoot(selectedLeadCommitEntry?.repositoryRoot || repoRoot));
  }, [diff?.path, partialCommitSelectionState, repoRoot, selectedLeadCommitEntry?.repositoryRoot]);
  const diffAffectedLineSelection = useMemo(() => {
    return resolvePartialCommitAffectedLineSelection(diff, diffEditorSelection);
  }, [diff, diffEditorSelection]);
  const diffAffectedLineSelectionState = useMemo(() => {
    return resolvePartialCommitAffectedLineSelectionState(diffPartialCommitEntry, diffAffectedLineSelection.affectedLineKeysByHunkId);
  }, [diffAffectedLineSelection.affectedLineKeysByHunkId, diffPartialCommitEntry]);
  const diffPartialCommitLineDecorations = useMemo<GitDiffLineDecorations>(() => {
    return buildPartialCommitLineDecorations(diff, diffPartialCommitEntry);
  }, [diff, diffPartialCommitEntry]);
  const diffPartialCommitControls = useMemo(() => {
    return buildPartialCommitDiffControls(diff, diffPartialCommitEntry);
  }, [diff, diffPartialCommitEntry]);
  const selectedActionableEntries = useMemo<GitStatusEntry[]>(() => {
    return selectedEntries.filter((entry) => isCommitEntryActionable(entry));
  }, [selectedEntries]);
  const selectedRollbackEntries = useMemo<GitStatusEntry[]>(() => {
    return selectedActionableEntries.filter((entry) => !entry.ignored && !entry.untracked);
  }, [selectedActionableEntries]);
  const selectedActionablePaths = useMemo<string[]>(() => {
    return selectedActionableEntries.map((entry) => entry.path);
  }, [selectedActionableEntries]);
  /**
   * 为主树当前选区生成 Patch 文本；保存文件与复制剪贴板共用同一条 working/staged 推导链。
   */
  const exportPatchFromChangeSelectionAsync = useCallback(async (mode: "save" | "clipboard"): Promise<void> => {
    if (!repoRoot) return;
    const requests = buildWorkingTreePatchRequests({
      entries: selectedActionableEntries,
      fallbackRepoRoot: repoRoot,
    });
    if (requests.length === 0) return;
    const patchChunks: string[] = [];
    for (const request of requests) {
      const res = await getDiffPatchAsync(request.repoRoot, {
        path: request.path,
        oldPath: request.oldPath,
        mode: request.mode,
      });
      if (!res.ok || !res.data) {
        setError(toErrorText(res.error, gt("workbench.patch.createFailed", "创建补丁失败")));
        return;
      }
      patchChunks.push(String(res.data.patch || ""));
    }
    await exportPatchTextAsync(patchChunks.join("\n"), {
      mode,
      defaultPath: buildPatchExportFileName({ paths: requests.map((request) => request.path) }),
    });
  }, [exportPatchTextAsync, repoRoot, selectedActionableEntries]);
  const selectedChangeListIds = useMemo<string[]>(() => {
    return resolveCommitSelectedChangeListIds(selectedCommitTreeKeys, commitRenderRowByKey, commitNodeByKey);
  }, [commitNodeByKey, commitRenderRowByKey, selectedCommitTreeKeys]);
  const selectedExplicitChangeListIds = useMemo<string[]>(() => {
    return resolveCommitExplicitSelectedChangeListIds(selectedCommitTreeKeys, commitRenderRowByKey);
  }, [commitRenderRowByKey, selectedCommitTreeKeys]);
  const selectedDeleteTargets = useMemo<string[]>(() => {
    return resolveCommitSelectedDeleteTargets(selectedCommitTreeKeys, commitRenderRowByKey, commitNodeByKey);
  }, [commitNodeByKey, commitRenderRowByKey, selectedCommitTreeKeys]);
  /**
   * 为当前右键菜单冻结提交树选择快照。
   * - 对齐 IDEA DataContext：菜单项执行时应使用打开菜单那一刻的树选择，而不是依赖后续可能变化的全局状态。
   */
  const menuCommitSelectionSnapshot = useMemo(() => {
    const selectedRowKeys = menu?.type === "changes"
      ? (Array.isArray(menu.selectionRowKeys) ? menu.selectionRowKeys : selectedCommitTreeKeys)
      : selectedCommitTreeKeys;
    return buildCommitMenuSelectionSnapshot({
      selectedRowKeys,
      rowMap: commitRenderRowByKey,
      nodeMap: commitNodeByKey,
    });
  }, [commitNodeByKey, commitRenderRowByKey, menu?.selectionRowKeys, menu?.type, selectedCommitTreeKeys]);
  /**
   * 为当前提交树选区统一派生 stage/menu/toolbar enablement，避免同一规则在多个入口各自猜测。
   */
  const commitSelectionContext = useMemo(() => {
    const availableChangeListIds = new Set((status?.changeLists?.lists || []).map((one) => String(one.id || "").trim()).filter(Boolean));
    return buildCommitTreeDataSnapshot({
      selectedEntries,
      selectedPaths,
      exactlySelectedPaths,
      selectedNodeSources: selectedCommitNodeSources,
      selectedChangeListIds,
      selectedExplicitChangeListIds,
      availableChangeListIds,
      activeChangeListId: String(status?.changeLists?.activeListId || "").trim(),
      localChangesConfig,
      stashPushPathspecSupported: status?.stashPushPathspecSupported,
    });
  }, [
    exactlySelectedPaths,
    localChangesConfig,
    selectedChangeListIds,
    selectedCommitNodeSources,
    selectedExplicitChangeListIds,
    selectedEntries,
    selectedPaths,
    status?.changeLists?.activeListId,
    status?.changeLists?.lists,
    status?.stashPushPathspecSupported,
  ]);
  /**
   * 按整棵提交树聚合 Git.Stage.Add.All 所需批次，覆盖 tracked unstaged 与 untracked 两类文件。
   */
  const stageAllOperationBatches = useMemo(() => {
    return buildGitStageAllOperationBatches({
      entries: status?.entries || [],
      fallbackRepoRoot: repoRoot,
    });
  }, [repoRoot, status?.entries]);
  /**
   * 按整棵提交树聚合所有 tracked unstaged 文件，供 Git.Stage.Add.Tracked 全局动作直接复用。
   */
  const trackedStageOperationBatches = useMemo(() => {
    return buildGitStageOperationBatches({
      entries: status?.entries || [],
      fallbackRepoRoot: repoRoot,
      predicate: (entry) => !entry.ignored && entry.unstaged && !entry.untracked,
    });
  }, [repoRoot, status?.entries]);
  /**
   * Stage toolbar 的全局 stage-all enablement 必须基于整棵树，而非当前选中集。
   */
  const canStageAll = stageAllOperationBatches.length > 0;
  /**
   * Stage toolbar 的全局 tracked-stage enablement 必须基于整棵树，而非当前选中集。
   */
  const canStageAllTracked = trackedStageOperationBatches.length > 0;
  /**
   * 统一推导全局暂存动作的 enablement 与禁用提示，供 toolbar/context menu 共用。
   */
  const globalStageActionAvailability = useMemo(() => {
    return resolveGitStageGlobalActionAvailability({
      canStageAll,
      canStageAllTracked,
    }, t);
  }, [canStageAll, canStageAllTracked, t]);
  /**
   * Git.Stash.Silently 对齐为“当前仓所有 changed roots”，只要存在任意非 ignored change 即可用。
   */
  const changedRepoRoots = useMemo(() => {
    return Array.from(new Set(
      (status?.entries || [])
        .filter((entry) => !entry.ignored)
        .map((entry) => normalizeCommitRepoRoot(entry.repositoryRoot || repoRoot))
        .filter(Boolean),
    ));
  }, [repoRoot, status?.entries]);
  const canStashAllChangedRoots = changedRepoRoots.length > 0;
  /**
   * 解析手动搁置当前应绑定的更改列表上下文；优先尊重显式提示，其次使用当前唯一目标列表，最后回退到活动列表。
   */
  const resolveManualShelveChangeListContext = useCallback((changeListIdHint?: string): { id?: string; name?: string } => {
    const changeListsEnabled = localChangesConfig.changeListsEnabled && !localChangesConfig.stagingAreaEnabled;
    if (!changeListsEnabled) return {};
    const availableChangeListIds = new Set(displayChangeLists.map((one) => String(one.id || "").trim()).filter(Boolean));
    const resolvedId = resolveCommitSingleChangeListId([changeListIdHint], selectedChangeListIds, availableChangeListIds)
      || String(status?.changeLists?.activeListId || "").trim();
    if (!resolvedId) return {};
    const resolvedName = displayChangeLists.find((one) => String(one.id || "").trim() === resolvedId)?.name || "";
    return {
      id: resolvedId,
      name: String(resolvedName || "").trim() || undefined,
    };
  }, [displayChangeLists, localChangesConfig.changeListsEnabled, localChangesConfig.stagingAreaEnabled, selectedChangeListIds, status?.changeLists?.activeListId]);
  /**
   * 按 IDEA selectedDiffableNode 语义维护当前 diffable 节点；group/目录选中时优先保留仍在子树中的旧 diffable。
   */
  useEffect(() => {
    setSelectedDiffableCommitNodeKey((prev) => {
      const next = resolveSelectedDiffableCommitNodeKey({
        selectedRowKeys: selectedCommitTreeKeys,
        rowMap: commitRenderRowByKey,
        nodeMap: commitNodeByKey,
        previousNodeKey: prev,
      });
      return next === prev ? prev : next;
    });
  }, [commitNodeByKey, commitRenderRowByKey, selectedCommitTreeKeys]);
  /**
   * 解析当前可自动预览的 diffable 文件节点；group/目录头选中时会复用已保留的 diffable selection。
   */
  const selectedDiffableCommitPreviewEntry = useMemo<GitStatusEntry | null>(() => {
    return canOpenDiffForCommitEntry(selectedLeadCommitEntry) ? selectedLeadCommitEntry : null;
  }, [selectedLeadCommitEntry]);
  /**
   * 按提交树节点反查真实状态条目；目录/仓库节点会按 repository/module 元数据二次收敛，避免多仓同路径串选。
   */
  const resolveCommitTreeNodeEntries = useCallback((node: CommitPanelTreeNode): GitStatusEntry[] => {
    if (node.entry) return [node.entry];
    const out: GitStatusEntry[] = [];
    const seen = new Set<string>();
    for (const one of node.filePaths) {
      const pathKey = String(one || "").replace(/\\/g, "/");
      const candidates = statusEntriesByPath.get(pathKey) || [];
      for (const candidate of candidates) {
        if (node.repositoryId && candidate.repositoryId && node.repositoryId !== candidate.repositoryId) continue;
        if (node.moduleId && candidate.moduleId && node.moduleId !== candidate.moduleId) continue;
        const itemId = buildCommitInclusionItemId(candidate);
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        out.push(candidate);
      }
    }
    return out;
  }, [statusEntriesByPath]);
  /**
   * 把提交树当前选择/展开态写入稳定 ref，避免刷新入口依赖这些高频状态后形成初始化自激刷新。
   */
  commitTreeViewStateRef.current = {
    selectedRowKeys: selectedCommitTreeKeys,
    groupExpanded: commitGroupExpanded,
    treeExpanded: commitTreeExpanded,
  };
  /**
   * 仓库切换时清理提交树可见性请求与进行中的 Diff 去重签名，避免旧仓状态污染新仓。
   */
  useEffect(() => {
    pendingDiffRequestRef.current = null;
    pendingCommitWorkflowActivationResetRef.current = null;
    if (persistChangeListDraftTimerRef.current) {
      window.clearTimeout(persistChangeListDraftTimerRef.current);
      persistChangeListDraftTimerRef.current = null;
    }
    restoredChangeListDraftListIdRef.current = "";
    restoredPersistedCommitMessageRepoRef.current = "";
    handledHostWorkbenchRequestIdRef.current = 0;
    requestCommitSelectionVisibleRef.current = false;
    autoExpandedCommitSelectionSignatureRef.current = "";
    loadedDiffRequestSignatureRef.current = "";
    rollbackDiffOverlayRestoreRef.current = null;
    setRollbackDiffOverlayOpen(false);
    setHostWorkbenchRequest(consumeGitWorkbenchHostRequest(repoPath));
    setPartialCommitSelectionState(createPartialCommitSelectionState());
    commitAmendLoadSeqRef.current += 1;
    commitAmendRequestedHashRef.current = "";
    commitAmendRestoreRef.current = null;
    setCommitAmendLoading(false);
    setCommitAmendDetails(null);
    setCommitAmendEnabled(false);
    setStageThreeWayDialogState(null);
  }, [repoPath, repoRoot]);

  /**
   * 订阅宿主侧 GitWorkbench 打开请求，只消费发给当前仓库路径的事件。
   */
  useEffect(() => {
    const normalizedRepoPathKey = normalizeGitWorkbenchProjectPathKey(repoPath);
    return subscribeGitWorkbenchHostRequests((request) => {
      if (!normalizedRepoPathKey) return;
      if (normalizeGitWorkbenchProjectPathKey(request.projectPath || "") !== normalizedRepoPathKey) return;
      setHostWorkbenchRequest(request);
    });
  }, [repoPath]);

  /**
   * 同步缓存当前右侧已展示的 Diff 请求签名，避免自动预览反复打开同一内容。
   */
  useEffect(() => {
    loadedDiffRequestSignatureRef.current = buildCommitDiffSnapshotSignature(diff);
  }, [diff]);

  /**
   * 切换 Diff 内容时清空旧编辑器选区，避免行级 partial commit 操作误用到上一文件。
   */
  useEffect(() => {
    setDiffEditorSelection({
      focusSide: null,
      originalSelectedLines: [],
      modifiedSelectedLines: [],
    });
  }, [diff?.fingerprint, diff?.hash, diff?.mode, diff?.path]);

  /**
   * 把当前已打开的 working/staged Diff hunk 快照同步进 partial commit 模型；若底层指纹变化，则显式清除失效选区。
   */
  useEffect(() => {
    const diffPath = String(diff?.path || "").trim().replace(/\\/g, "/");
    const entry = statusEntryByPath.get(diffPath);
    if (!canUseDiffPartialCommit({ diff, entry })) return;
    if (!entry) return;
    let invalidatedPath = "";
    setPartialCommitSelectionState((prev) => {
      const result = syncPartialCommitSelectionWithSnapshot(prev, {
        path: diffPath,
        repoRoot: String(entry.repositoryRoot || repoRoot || "").trim(),
        changeListId: String(entry.changeListId || "default").trim() || "default",
        snapshot: diff,
      });
      invalidatedPath = String(result.invalidatedPath || "").trim();
      return result.state;
    });
    if (!invalidatedPath) return;
    finalizeGitNotice({
      action: "commit.partial",
      tone: "warn",
      message: gitWorkbenchText("commit.partialSelectionInvalidated", "文件 '{{path}}' 的部分提交选区已失效，已回退为重新选择状态", { path: invalidatedPath }),
    });
  }, [diff, finalizeGitNotice, repoRoot, statusEntryByPath]);

  /**
   * 按当前文件路径在提交树中回选节点，并把焦点收回左侧树容器，对齐 Select In Changes View 的基础语义。
   */
  const selectInCommitTreeByPath = useCallback((pathText: string, preferredChangeListId?: string): void => {
    const nextNodeKeys = selectCommitNodeByPath({
      path: pathText,
      nodeMap: commitNodeByKey,
      preferredChangeListId,
    });
    if (nextNodeKeys.length === 0) return;
    if (leftCollapsed) setLeftCollapsed(false);
    setActiveSelectionScope("commit");
    applyCommitNodeSelection(nextNodeKeys.map((nodeKey) => `node:${nodeKey}`));
    window.setTimeout(() => {
      commitTreeContainerRef.current?.focus();
    }, 0);
  }, [applyCommitNodeSelection, commitNodeByKey, leftCollapsed]);

  /**
   * 按当前激活上下文快照提交入口 reset 请求；只有当前焦点确实来自 commit tree 时，才沿用显式 selected changes。
   */
  const buildCommitWorkflowActivationResetRequest = useCallback((): CommitWorkflowActivationResetRequest => {
    const canReuseCommitSelection = leftTab === "commit" && activeSelectionScope === "commit";
    return {
      activeChangeListId: String(status?.changeLists?.activeListId || "").trim(),
      selectedEntries: canReuseCommitSelection ? [...selectedActionableEntries] : [],
      selectedChangeListIds: canReuseCommitSelection ? [...selectedChangeListIds] : [],
    };
  }, [activeSelectionScope, leftTab, selectedActionableEntries, selectedChangeListIds, status?.changeLists?.activeListId]);

  /**
   * 对齐 IDEA `setCommitState(initialChangeList, included, ...)` 语义；显式进入提交流程时，需同步重建 included changes 与树选区。
   */
  const applyCommitWorkflowActivationReset = useCallback((request: CommitWorkflowActivationResetRequest): boolean => {
    if (commitTreeBusy || !status) return false;
    const activeChangeListId = String(request.activeChangeListId || status.changeLists?.activeListId || "").trim();
    const nextInclusionState = resolveCommitActivationInclusionState({
      items: commitInclusionItems,
      activeChangeListId,
      selectedEntries: request.selectedEntries,
      selectedChangeListIds: request.selectedChangeListIds,
      commitAllEnabled: effectiveCommitAllSetting,
    });
    setCommitInclusionState((prev) => (isSameCommitInclusionState(prev, nextInclusionState) ? prev : nextInclusionState));
    const nextSelection = filterSelectableCommitRowKeys(
      resolveCommitFallbackRowSelection({
        groups: commitTreeGroups,
        inclusionState: nextInclusionState,
        activeChangeListId,
      }),
      commitRenderRowByKey,
      commitNodeByKey,
    );
    pendingCommitWorkflowActivationResetRef.current = null;
    applyCommitNodeSelection(nextSelection);
    return true;
  }, [applyCommitNodeSelection, commitInclusionItems, commitNodeByKey, commitRenderRowByKey, commitTreeBusy, commitTreeGroups, effectiveCommitAllSetting, status]);

  /**
   * 若提交入口触发时状态树仍在刷新，则在树模型恢复后补落 inclusion/selection reset，避免旧 checkbox 状态残留。
   */
  useEffect(() => {
    const request = pendingCommitWorkflowActivationResetRef.current;
    if (!request) return;
    applyCommitWorkflowActivationReset(request);
  }, [applyCommitWorkflowActivationReset]);

  /**
   * 显式激活提交工作流，并在已激活时把焦点送回提交输入框，避免工具栏按钮点击退化为无动作。
   */
  const activateCommitWorkflow = useCallback((options?: {
    focusEditor?: boolean;
    selectEditor?: boolean;
    preferPushAfter?: boolean;
    openOptions?: boolean;
  }): void => {
    const intent = resolveCommitToolbarIntent(leftTab === "commit" && !leftCollapsed);
    const activationRequest = buildCommitWorkflowActivationResetRequest();
    if (leftCollapsed) setLeftCollapsed(false);
    if (intent.shouldSwitchTab) setLeftTab("commit");
    setPreferredCommitAction(options?.preferPushAfter === true ? "commitAndPush" : "commit");
    if (options?.openOptions === true) setCommitOptionsOpen(true);
    setActiveSelectionScope("commit");
    if (intent.shouldAlignTreeSelection) {
      pendingCommitWorkflowActivationResetRef.current = activationRequest;
      applyCommitWorkflowActivationReset(activationRequest);
    }
    const shouldFocusEditor = options?.focusEditor ?? intent.shouldFocusEditor;
    if (!shouldFocusEditor) return;
    window.setTimeout(() => {
      const editor = commitMessageInputRef.current;
      if (editor) {
        editor.focus();
        if (options?.selectEditor && typeof editor.select === "function")
          editor.select();
        return;
      }
      commitTreeContainerRef.current?.focus();
    }, 0);
  }, [applyCommitWorkflowActivationReset, buildCommitWorkflowActivationResetRequest, leftCollapsed, leftTab]);

  /**
   * 消费宿主下发的公共 Git action，请求先落提交消息意图，再统一复用工作台内部现有 handler。
   */
  useEffect(() => {
    if (!hostWorkbenchRequest) return;
    if (handledHostWorkbenchRequestIdRef.current === hostWorkbenchRequest.requestId) return;
    handledHostWorkbenchRequestIdRef.current = hostWorkbenchRequest.requestId;
    const requestedMessage = String(hostWorkbenchRequest.prefillCommitMessage || "");
    if (requestedMessage && requestedMessage !== commitMessageValueRef.current) {
      setCommitMessage(requestedMessage);
      if (typeof window !== "undefined")
        writeLastCommitMessage(window.localStorage, requestedMessage);
    }
    void dispatchGitWorkbenchHostActionAsync(hostWorkbenchRequest.actionId, {
      ...hostActionHandlersRef.current,
      openCommitStage: (options) => {
        activateCommitWorkflow({
          focusEditor: hostWorkbenchRequest.focusCommitMessage,
          selectEditor: hostWorkbenchRequest.selectCommitMessage,
          preferPushAfter: options?.preferPushAfter,
          openOptions: options?.openOptions,
        });
      },
    });
  }, [activateCommitWorkflow, hostWorkbenchRequest]);

  /**
   * 归一化当前生效的分支多选值，兼容旧版单值筛选状态。
   */
  const activeLogBranchValues = useMemo<string[]>(() => {
    return getGitLogBranchFilterValues(activeLogFilters);
  }, [activeLogFilters]);

  /**
   * 归一化当前生效的作者多选值，兼容旧版单值筛选状态。
   */
  const activeLogAuthorValues = useMemo<string[]>(() => {
    return getGitLogAuthorFilterValues(activeLogFilters);
  }, [activeLogFilters]);

  const logAuthorOptions = useMemo<GitLogMultiSelectFilterOption[]>(() => {
    const set = new Set<string>();
    for (const item of logItems) {
      const name = String(item.authorName || "").trim();
      if (name) set.add(name);
    }
    for (const activeAuthor of activeLogAuthorValues) {
      if (activeAuthor) set.add(activeAuthor);
    }
    const authors = Array.from(set).sort((a, b) => a.localeCompare(b));
    return authors.map((name) => ({ value: name, label: name }));
  }, [activeLogAuthorValues, logItems]);

  const logBranchOptions = useMemo<GitLogMultiSelectFilterOption[]>(() => {
    const out: GitLogMultiSelectFilterOption[] = [
      { value: "HEAD", label: gitWorkbenchText("workbench.branchFilter.currentBranch", "当前分支"), keywords: ["head", "current"] },
    ];
    const seen = new Set<string>(["HEAD"]);
    const pushBranch = (name: string): void => {
      const clean = String(name || "").trim();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      out.push({ value: clean, label: clean });
    };
    for (const b of branchPopup?.groups?.local || []) pushBranch(b.name);
    for (const b of branchPopup?.groups?.remote || []) pushBranch(b.name);
    for (const activeBranch of activeLogBranchValues) pushBranch(activeBranch);
    return out;
  }, [activeLogBranchValues, branchPopup?.groups?.local, branchPopup?.groups?.remote]);

  /**
   * 提取当前 Git 面板可见的远端仓库名称，避免把本地分支误判为 `remote/branch`。
   */
  const knownRemoteNames = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const item of branchPopup?.groups?.remote || []) {
      const name = String(item.name || "").trim();
      const parsed = parseRemoteBranchRefName(name);
      if (parsed?.remote) set.add(parsed.remote);
    }
    return Array.from(set).sort((a, b) => b.length - a.length || a.localeCompare(b));
  }, [branchPopup?.groups?.remote]);
  const hasKnownRemotes = useMemo<boolean>(() => {
    if ((branchPopup?.groups?.remote?.length || 0) > 0) return true;
    return (branchPopup?.groups?.local || []).some((item) => {
      const upstream = String(item.upstream || "").trim();
      return !!parseRemoteBranchRefName(upstream, knownRemoteNames);
    });
  }, [branchPopup?.groups?.local, branchPopup?.groups?.remote, knownRemoteNames]);
  const pullDialogRepositories = useMemo<GitPullDialogRepositoryOption[]>(() => {
    const repositories = branchPopup?.repositories || [];
    if (repositories.length > 0) {
      return repositories.map((repository) => ({
        repoRoot: repository.repoRoot,
        label: repositories.length > 1 ? `${repository.rootName} · ${repository.repoRoot}` : (repository.rootName || repository.repoRoot),
        currentBranchName: String(repository.currentBranch || "").trim() || undefined,
        remotes: buildPullDialogRemoteOptions(repository),
      }));
    }
    if (!repoRoot) return [];
    return [{
      repoRoot,
      label: repoRoot,
      currentBranchName: String(repoBranch || "").trim() || undefined,
      remotes: buildPullDialogRemoteOptions({
        repoRoot,
        rootName: repoRoot,
        kind: "repository",
        currentBranch: String(repoBranch || "").trim(),
        detached: repoDetached,
        syncEnabled: branchPopup?.syncEnabled === true,
        remotes: branchPopup?.remotes || [],
        currentBranchSync: branchPopup?.currentBranchSync,
        groups: {
          favorites: [],
          recent: [],
          local: branchPopup?.groups?.local || [],
          remote: branchPopup?.groups?.remote || [],
        },
      }),
    }];
  }, [
    branchPopup?.currentBranchSync,
    branchPopup?.groups?.local,
    branchPopup?.groups?.remote,
    branchPopup?.remotes,
    branchPopup?.repositories,
    branchPopup?.syncEnabled,
    repoBranch,
    repoDetached,
    repoRoot,
  ]);
  const fetchDialogRepositories = useMemo<GitFetchDialogRepositoryOption[]>(() => {
    const repositories = branchPopup?.repositories || [];
    if (repositories.length > 0) {
      return repositories.map((repository) => ({
        repoRoot: repository.repoRoot,
        label: repositories.length > 1 ? `${repository.rootName} · ${repository.repoRoot}` : (repository.rootName || repository.repoRoot),
        remotes: (repository.remotes || []).map((remote) => ({
          name: String(remote.name || "").trim(),
          fetchUrl: String(remote.fetchUrl || "").trim() || undefined,
        })).filter((remote) => !!remote.name),
        defaultRemote: resolveBranchPopupDefaultRemoteName(repository),
      }));
    }
    if (!repoRoot) return [];
    return [{
      repoRoot,
      label: repoRoot,
      remotes: (branchPopup?.remotes || []).map((remote) => ({
        name: String(remote.name || "").trim(),
        fetchUrl: String(remote.fetchUrl || "").trim() || undefined,
      })).filter((remote) => !!remote.name),
      defaultRemote: String(branchPopup?.currentBranchSync?.remote || "").trim() || undefined,
    }];
  }, [branchPopup?.currentBranchSync?.remote, branchPopup?.remotes, branchPopup?.repositories, repoRoot]);
  const toolbarState = useMemo(() => resolveGitToolbarState({
    isRepo,
    repoDetached,
    hasRemotes: hasKnownRemotes,
    flowBusy: loadingFlow,
    hasRollbackSelection: selectedRollbackEntries.length > 0,
  }, t), [hasKnownRemotes, isRepo, loadingFlow, repoDetached, selectedRollbackEntries.length, t]);

  const lastAutoResolvedUpperLayoutWidthRef = useRef<number>(0);
  const consoleListRef = useRef<HTMLDivElement>(null);
  const gitActivityCountRef = useRef<number>(0);
  const gitConsoleRefreshTimerRef = useRef<number | null>(null);
  const gitConsoleLiveRefreshTimerRef = useRef<number | null>(null);
  const logHeaderScrollRef = useRef<HTMLDivElement>(null);
  const logScrollSyncLockRef = useRef<boolean>(false);
  const logVirtual = useVirtualWindow(logItems.length, LOG_ROW_HEIGHT, VIRTUAL_OVERSCAN, `${bottomTab}:${bottomCollapsed ? 1 : 0}:${diffFullscreen ? 1 : 0}`);
  const worktreeTreeRows = useMemo<WorktreeTreeRow[]>(() => {
    return buildWorktreeTreeRows(repoRoot, displayWorktreeItems, worktreeTreeExpanded);
  }, [displayWorktreeItems, repoRoot, worktreeTreeExpanded]);

  const pushSelectedCommit = useMemo(() => {
    const selected = String(pushSelectedCommitHash || "").trim();
    if (!pushPreview || !selected) return null;
    return pushPreview.commits.find((one) => one.hash === selected) || null;
  }, [pushPreview, pushSelectedCommitHash]);
  /**
   * 提取 Push 对话框中的仓库显示名，对齐 IDEA 顶层仓库节点的简短命名。
   */
  const pushRepoDisplayName = useMemo<string>(() => {
    const clean = String(repoRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!clean) return gitWorkbenchText("workbench.branchFilter.currentRepository", "当前仓库");
    const parts = clean.split("/").filter(Boolean);
    return parts[parts.length - 1] || clean;
  }, [repoRoot]);
  /**
   * 计算 Push 对话框仓库节点右侧的源分支与目标分支文案。
   */
  const pushRepoRoute = useMemo<{ source: string; target: string }>(() => {
    const source = String(pushPreview?.branch || "").trim() || "HEAD";
    const upstream = String(pushPreview?.upstream || "").trim();
    const remote = String(pushPreview?.remote || "").trim();
    const remoteBranch = String(pushPreview?.remoteBranch || "").trim();
    const target = upstream || (remote && remoteBranch ? `${remote}/${remoteBranch}` : gitWorkbenchText("workbench.branchFilter.noRemote", "未配置远端"));
    return { source, target };
  }, [pushPreview?.branch, pushPreview?.remote, pushPreview?.remoteBranch, pushPreview?.upstream]);
  /**
   * 判断 Push 对话框当前是否选中了仓库总览节点；未选提交时展示全部文件并集。
   */
  const pushRepoSelected = useMemo<boolean>(() => {
    return !String(pushSelectedCommitHash || "").trim();
  }, [pushSelectedCommitHash]);
  /**
   * 判断 Push 对话框是否存在待推送内容；空状态下用于收紧布局，避免大面积留白。
   */
  const pushPreviewHasContent = useMemo<boolean>(() => {
    return (pushPreview?.commits.length || 0) > 0 || (pushPreview?.files.length || 0) > 0;
  }, [pushPreview?.commits.length, pushPreview?.files.length]);
  /**
   * 判断 Push 空状态是否需要额外展示第二行原因，避免“没有可推送的提交”重复提示。
   */
  const pushShouldShowEmptyReason = useMemo<boolean>(() => {
    const reason = String(pushPreview?.disabledReason || "").replace(/[。！!]/g, "").trim();
    return !!reason && reason !== "没有可推送的提交";
  }, [pushPreview?.disabledReason]);
  /**
   * 构建 Push 左侧树的可见节点顺序，供键盘导航与选择同步使用。
   */
  const pushTreeRows = useMemo<Array<{ key: string; type: "repo" | "commit"; hash?: string }>>(() => {
    const rows: Array<{ key: string; type: "repo" | "commit"; hash?: string }> = [{ key: "__repo__", type: "repo" }];
    if (!pushRepoCommitsExpanded) return rows;
    for (const commit of pushPreview?.commits || []) {
      rows.push({ key: commit.hash, type: "commit", hash: commit.hash });
    }
    return rows;
  }, [pushPreview?.commits, pushRepoCommitsExpanded]);

  /**
   * 计算 Push 对话框右侧应展示的文件列表；优先展示当前选中提交的文件，回退到整体并集。
   */
  const pushSelectedFiles = useMemo<Array<{ path: string; status?: string; oldPath?: string }>>(() => {
    const selectedFiles = (pushSelectedCommit?.files || [])
      .map((one) => ({
        path: String(one?.path || "").trim(),
        status: String(one?.status || "").trim() || undefined,
        oldPath: String(one?.oldPath || "").trim() || undefined,
      }))
      .filter((one) => !!one.path);
    if (selectedFiles.length > 0) return selectedFiles;
    return (pushPreview?.files || [])
      .map((one) => ({
        path: String(one?.path || "").trim(),
        status: String(one?.status || "").trim() || undefined,
        oldPath: String(one?.oldPath || "").trim() || undefined,
      }))
      .filter((one) => !!one.path);
  }, [pushPreview?.files, pushSelectedCommit?.files]);
  const pushFileTree = useMemo<DetailTreeNode[]>(() => {
    return buildDetailTree(pushSelectedFiles);
  }, [pushSelectedFiles]);
  const pushFileRows = useMemo<Array<{ node: DetailTreeNode; depth: number }>>(() => {
    return flattenDetailTree(pushFileTree, pushFileTreeExpanded);
  }, [pushFileTree, pushFileTreeExpanded]);

  /**
   * 定位当前控制台聚焦的 Update Session 条目，供顶部卡片按钮和控制台提示复用。
   */
  const focusedUpdateSessionEntry = useMemo<GitUpdateSessionEntryState | null>(() => {
    if (!focusedUpdateSessionRequestId) return null;
    return updateSessionEntries.find((entry) => entry.requestId === focusedUpdateSessionRequestId) || null;
  }, [focusedUpdateSessionRequestId, updateSessionEntries]);

  const orderedSelectedCommitHashesNewestFirst = useMemo<string[]>(() => {
    return sortHashesByLogUiOrder(selectedCommitHashes, logItems);
  }, [logItems, selectedCommitHashes]);

  const orderedSelectedCommitHashesOldestFirst = useMemo<string[]>(() => {
    return [...orderedSelectedCommitHashesNewestFirst].reverse();
  }, [orderedSelectedCommitHashesNewestFirst]);
  /**
   * 判断当前日志是否处于“文件历史”模式；仅该模式下需要随提交选择自动联动文件 Diff。
   */
  const isFileHistoryMode = useMemo<boolean>(() => {
    return !!String(activeLogFilters.path || "").trim() && !!activeLogFilters.followRenames;
  }, [activeLogFilters.followRenames, activeLogFilters.path]);
  /**
   * 把详情请求真正会使用的提交哈希规整成稳定签名，避免日志顺序/回调重建引起同一提交详情被重复拉取。
   */
  const detailRequestHashesKey = useMemo<string>(() => {
    const requestHashes = orderedSelectedCommitHashesNewestFirst.length > 0
      ? orderedSelectedCommitHashesNewestFirst
      : selectedCommitHashes;
    return buildCommitSelectionSignature(requestHashes);
  }, [orderedSelectedCommitHashesNewestFirst, selectedCommitHashes]);
  const logVisiblePack = useMemo(() => {
    return buildGitLogVisiblePack({
      items: logItems,
      graphItems: logGraphItems,
      fileHistoryMode: isFileHistoryMode,
    });
  }, [isFileHistoryMode, logGraphItems, logItems]);
  const logBranchesDashboard = useMemo(
    () => buildGitLogBranchesDashboard(branchPopup, logBranchesDashboardState),
    [branchPopup, logBranchesDashboardState],
  );
  const logDashboardRepositoryName = useMemo<string>(() => {
    const selectedRepository = logBranchesDashboard.repositories.find((item) => item.repoRoot === logBranchesDashboard.selectedRepoRoot);
    return String(selectedRepository?.rootName || "").trim();
  }, [logBranchesDashboard]);
  useEffect(() => {
    saveGitLogBranchesDashboardState(logBranchesDashboardState);
  }, [logBranchesDashboardState]);
  const laneCells = logVisiblePack.graphCells;

  const detailFileItems = useMemo<Array<{ path: string; status?: string; oldPath?: string }>>(() => {
    if (!details) return [];
    if (details.mode === "single") {
      return details.detail.files.map((one) => ({
        path: one.path,
        status: one.status,
        oldPath: one.oldPath,
      }));
    }
    return details.files.map((one) => ({
      path: one.path,
      status: one.status,
      oldPath: one.oldPath,
    }));
  }, [details]);
  const detailHashMap = useMemo<Map<string, string[]>>(() => {
    const map = new Map<string, string[]>();
    if (!details) return map;
    if (details.mode === "single") {
      for (const file of details.detail.files) {
        map.set(file.path, [details.detail.hash]);
      }
      return map;
    }
    for (const file of details.files) {
      map.set(file.path, Array.from(new Set((file.hashes || []).map((one) => String(one || "").trim()).filter(Boolean))));
    }
    return map;
  }, [details]);
  /**
   * 解析某个详情文件对应的提交哈希集合，并按日志中的时间顺序（老 -> 新）返回。
   */
  const resolveDetailPathCommitHashes = useCallback((targetPath: string, fallbackHashes?: string[]): string[] => {
    const normalizedPath = String(targetPath || "").trim();
    const localHashes = detailHashMap.get(normalizedPath) || fallbackHashes || [];
    const set = new Set(localHashes.map((one) => String(one || "").trim()).filter(Boolean));
    if (set.size === 0) return [];
    const ordered = orderedSelectedCommitHashesOldestFirst.filter((one) => set.has(one));
    if (ordered.length > 0) return ordered;
    return Array.from(set);
  }, [detailHashMap, orderedSelectedCommitHashesOldestFirst]);

  /**
   * 统一解析详情树当前文件选择的哈希归属，供两提交比较与按提交分组动作共用，避免各处重复拼装哈希集合。
   */
  const resolveDetailSelectionHashResolution = useCallback((paths: string[]) => {
    return resolveCommitDetailsSelectionHashResolution(paths, (filePath) => resolveDetailPathCommitHashes(filePath));
  }, [resolveDetailPathCommitHashes]);

  /**
   * 把详情树选中的文件按唯一提交哈希分组；仅在每个文件都能唯一映射到一个提交时返回，避免聚合详情误把跨提交同路径当成可批量执行。
   */
  const groupDetailSelectionChangesByUniqueHash = useCallback((
    selectedChanges: ReturnType<typeof buildCommitDetailsSelectionChanges>,
  ): Array<{ hash: string; changes: ReturnType<typeof buildCommitDetailsSelectionChanges>; paths: string[] }> | null => {
    const normalizedChanges = selectedChanges.filter((change) => !!String(change.path || "").trim());
    const hashResolution = resolveDetailSelectionHashResolution(normalizedChanges.map((change) => change.path));
    if (!hashResolution.allPathsHaveSingleHash) return null;
    const changeByPath = new Map(
      normalizedChanges.map((change) => [String(change.path || "").trim().replace(/\\/g, "/"), change] as const),
    );
    const groupedChanges = new Map<string, ReturnType<typeof buildCommitDetailsSelectionChanges>>();
    for (const item of hashResolution.items) {
      if (!item.uniqueHash) continue;
      const change = changeByPath.get(item.path);
      if (!change) continue;
      const current = groupedChanges.get(item.uniqueHash) || [];
      groupedChanges.set(item.uniqueHash, [...current, change]);
    }
    return hashResolution.uniqueHashes
      .map((oneHash) => {
        const changes = groupedChanges.get(oneHash) || [];
        return {
          hash: oneHash,
          changes,
          paths: changes.map((change) => change.path),
        };
      })
      .filter((group) => group.changes.length > 0);
  }, [resolveDetailSelectionHashResolution]);
  const detailFilesFlat = useMemo<string[]>(() => {
    return detailFileItems.map((one) => one.path);
  }, [detailFileItems]);
  const branchCompareFiles = useMemo<GitChangedFile[]>(() => {
    return branchCompareFilesDialogState?.files || [];
  }, [branchCompareFilesDialogState?.files]);
  const branchCompareFileTree = useMemo<DetailTreeNode[]>(() => {
    return buildDetailTree(branchCompareFiles);
  }, [branchCompareFiles]);
  const branchCompareFileRows = useMemo<Array<{ node: DetailTreeNode; depth: number }>>(() => {
    return flattenDetailTree(branchCompareFileTree, branchCompareFilesTreeExpanded);
  }, [branchCompareFileTree, branchCompareFilesTreeExpanded]);
  const detailFileTree = useMemo<DetailTreeNode[]>(() => buildDetailTree(detailFileItems), [detailFileItems]);
  const detailFileRows = useMemo<Array<{ node: DetailTreeNode; depth: number }>>(() => {
    return flattenDetailTree(detailFileTree, detailTreeExpanded);
  }, [detailFileTree, detailTreeExpanded]);
  const detailNodeByKey = useMemo<Map<string, DetailTreeNode>>(() => {
    const map = new Map<string, DetailTreeNode>();
    for (const row of detailFileRows) map.set(row.node.key, row.node);
    return map;
  }, [detailFileRows]);
  const detailVisibleNodeKeys = useMemo<string[]>(() => {
    return detailFileRows.map((one) => one.node.key);
  }, [detailFileRows]);
  const detailNodeKeyByPath = useMemo<Map<string, string>>(() => {
    const map = new Map<string, string>();
    for (const row of detailFileRows) map.set(row.node.fullPath, row.node.key);
    return map;
  }, [detailFileRows]);
  const selectedDetailPaths = useMemo<string[]>(() => {
    return resolveSelectedDetailPaths(selectedDetailNodeKeys, detailNodeByKey);
  }, [detailNodeByKey, selectedDetailNodeKeys]);
  const selectedDetailPrimaryPath = useMemo<string>(() => {
    const key = selectedDetailNodeKeys[0];
    if (!key) return "";
    return detailNodeByKey.get(key)?.fullPath || "";
  }, [detailNodeByKey, selectedDetailNodeKeys]);
  const detailLineStatsSummary = useMemo(() => {
    if (!details || details.mode !== "single") return null;
    return buildCommitLineStatsSummary(details.detail.lineStats);
  }, [details]);

  /**
   * 按日志表可见顺序拼接选中哈希（旧 -> 新），用于“复制修订号”。
   */
  const buildSelectedRevisionText = useCallback((): string => {
    if (selectedCommitHashes.length === 0) return "";
    const selectedSet = new Set(selectedCommitHashes);
    const orderedByTable = logItems
      .filter((item) => selectedSet.has(item.hash))
      .map((item) => item.hash);
    const hashes = orderedByTable.length > 0 ? orderedByTable.reverse() : [...selectedCommitHashes].reverse();
    return hashes.join(" ").trim();
  }, [logItems, selectedCommitHashes]);

  const logDecorationPillsByHash = useMemo<Map<string, GitDecorationPill[]>>(() => {
    const map = new Map<string, GitDecorationPill[]>();
    for (const item of logItems) {
      map.set(
        item.hash,
        buildLogDecorationPills(String(item.decorations || ""), branchPopup, String(repoBranch || "")),
      );
    }
    return map;
  }, [branchPopup, logItems, repoBranch]);

  /**
   * 基于当前日志内容估算短列最佳宽度，减少作者/时间/哈希/引用列的无效留白。
   */
  const logColumnPreferredWidthMap = useMemo<Map<GitLogColumnId, number>>(() => {
    const sampleItems = logItems.slice(0, 200);
    const map = new Map<GitLogColumnId, number>();
    map.set("author", estimateGitLogColumnWidth("author", sampleItems.map((one) => one.authorName || "-")));
    map.set("date", estimateGitLogColumnWidth("date", sampleItems.map((one) => toCompactDateText(one.authorDate) || "-")));
    map.set("hash", estimateGitLogColumnWidth("hash", sampleItems.map((one) => one.shortHash || "-")));
    map.set("refs", estimateGitLogColumnWidth("refs", sampleItems.map((one) => {
      const pills = logDecorationPillsByHash.get(one.hash) || [];
      return pills.length > 0 ? pills.map((pill) => pill.label).join(" ") : "—";
    })));
    return map;
  }, [logDecorationPillsByHash, logItems]);

  /**
   * 解析日志列当前实际生效宽度，供渲染与拖拽调整统一复用。
   */
  const logColumnResolvedWidthMap = useMemo<Map<GitLogColumnId, number>>(() => {
    const map = new Map<GitLogColumnId, number>();
    for (const column of logColumnLayout.order) {
      map.set(column, resolveGitLogColumnWidth(logColumnLayout, column, logColumnPreferredWidthMap.get(column)));
    }
    return map;
  }, [logColumnLayout, logColumnPreferredWidthMap]);

  /**
   * 按当前列布局生成日志表头/单元格的弹性样式，支持拖拽调整后立即生效。
   */
  const logColumnStyleMap = useMemo<Map<GitLogColumnId, React.CSSProperties>>(() => {
    const map = new Map<GitLogColumnId, React.CSSProperties>();
    for (const column of logColumnLayout.order) {
      map.set(column, buildGitLogColumnStyle(logColumnLayout, column, logColumnPreferredWidthMap.get(column)));
    }
    return map;
  }, [logColumnLayout, logColumnPreferredWidthMap]);

  /**
   * 渲染日志表某一列的内容；`subject` 列会把图谱嵌入提交文本前，对齐 IDEA 在同一单元格内绘制 graph 的方式。
   */
  const renderLogColumnContent = useCallback((
    item: GitLogItem,
    columnId: GitLogColumnId,
    options?: {
      graphCell?: GitGraphCell;
      graphSelected?: boolean;
      graphColumnWidth?: number;
    },
  ): JSX.Element => {
    if (columnId === "author") {
      return <span className="block truncate text-[10px] leading-4 text-[var(--cf-text-secondary)]" title={item.authorName || "-"}>{item.authorName || "-"}</span>;
    }
    if (columnId === "date") {
      return <span className="block truncate text-[10px] leading-4 text-[var(--cf-text-secondary)]" title={toLocalDateText(item.authorDate)}>{toCompactDateText(item.authorDate)}</span>;
    }
    if (columnId === "hash") {
      return <span className="block truncate text-right text-[10px] leading-4 text-[var(--cf-text-secondary)]" title={item.hash}>{item.shortHash}</span>;
    }
    if (columnId === "refs") {
      const pills = logDecorationPillsByHash.get(item.hash) || [];
      if (pills.length === 0)
        return <span className="block truncate text-[10px] leading-4 text-[var(--cf-text-muted)]">—</span>;
      return (
        <span className="cf-git-ref-pills w-full" title={item.decorations || ""}>
          {pills.map((pill) => (
            <span key={`${item.hash}:${pill.key}`} className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME[pill.tone])}>
              {pill.label}
            </span>
          ))}
        </span>
      );
    }
    return (
      <div className="flex min-w-0 items-center gap-1">
        <div className="shrink-0" style={{ width: options?.graphColumnWidth }}>
          <GitLogGraphCell
            cell={options?.graphCell}
            selected={options?.graphSelected === true}
            rowHeight={LOG_ROW_HEIGHT}
          />
        </div>
        <span className="cf-git-log-subject-text block min-w-0 flex-1 truncate leading-[18px] text-[var(--cf-text-primary)]" title={item.subject || gitWorkbenchText("workbench.log.noTitle", "(无标题)")}>
          {item.subject || gitWorkbenchText("workbench.log.noTitle", "(无标题)")}
        </span>
      </div>
    );
  }, [logDecorationPillsByHash]);

  /**
   * 读取日志动作默认消息草稿，对齐 IDEA 的 reword/squash 初始编辑体验。
   */
  const loadLogMessageDraftValueAsync = useCallback(
    async (action: "editMessage" | "squashCommits", hashes: string[]): Promise<string> => {
      if (!repoRoot || hashes.length === 0) return "";
      const res = await getLogMessageDraftAsync(repoRoot, action, hashes);
      if (!res.ok || !res.data) {
        setError(toErrorText(res.error, gt("workbench.log.messageDraftLoadFailed", "读取提交消息失败")));
        return "";
      }
      return String((res.data as GitLogMessageDraft).message || "");
    },
    [repoRoot],
  );

  /**
   * 根据详情树上下文菜单目标，计算应执行动作的文件集合（支持文件夹递归）。
   */
  const resolveDetailMenuFileTargets = useCallback((targetPath: string): string[] => {
    const cleanPath = String(targetPath || "").trim();
    const nodeKey = detailNodeKeyByPath.get(cleanPath) || "";
    const targetInSelection = nodeKey ? selectedDetailNodeKeys.includes(nodeKey) : false;
    const fromSelection = selectedDetailPaths
      .map((one) => String(one || "").trim())
      .filter(Boolean);
    if (fromSelection.length > 0 && (!cleanPath || targetInSelection)) return Array.from(new Set(fromSelection));
    if (!cleanPath) return [];
    const node = nodeKey ? detailNodeByKey.get(nodeKey) : null;
    if (node && node.filePaths.length > 0) {
      return Array.from(new Set(node.filePaths.map((one) => String(one || "").trim()).filter(Boolean)));
    }
    return [cleanPath];
  }, [detailNodeByKey, detailNodeKeyByPath, selectedDetailNodeKeys, selectedDetailPaths]);

  /**
   * 根据当前详情选择同步 committed changes 动作可用性，确保 details browser 的 toolbar 与 popup 共用同一后端语义。
   */
  useEffect(() => {
    if (!repoRoot || !details) {
      setDetailActionAvailability(null);
      setDetailActionAvailabilityKey("");
      return;
    }

    const targetPath = (menu?.type === "detail" ? menu.target : "") || selectedDetailPrimaryPath || selectedDetailPaths[0] || "";
    const targetFiles = resolveDetailMenuFileTargets(targetPath);
    if (targetFiles.length <= 0) {
      setDetailActionAvailability(null);
      setDetailActionAvailabilityKey("");
      return;
    }

    const targetCommitHashSet = new Set<string>();
    for (const filePath of targetFiles) {
      for (const oneHash of resolveDetailPathCommitHashes(filePath))
        targetCommitHashSet.add(oneHash);
    }
    const targetCommitHashes = orderedSelectedCommitHashesOldestFirst.filter((one) => targetCommitHashSet.has(one));
    const targetHash = details.mode === "single"
      ? details.detail.hash
      : (targetCommitHashes[targetCommitHashes.length - 1] || orderedSelectedCommitHashesNewestFirst[0] || "");
    const selectedChanges = buildCommitDetailsSelectionChanges(detailFileItems, targetFiles);
    const allChanges = detailFileItems.map((file) => ({
      path: String(file.path || "").trim().replace(/\\/g, "/"),
      oldPath: String(file.oldPath || "").trim().replace(/\\/g, "/") || undefined,
      status: String(file.status || "").trim() || undefined,
    }));
    const availabilityKey = [
      targetHash,
      ...selectedChanges.map((change) => `${change.path}\u0000${change.oldPath || ""}\u0000${change.status || ""}`),
    ].join("\n");
    if (!targetHash || selectedChanges.length <= 0) {
      setDetailActionAvailability(null);
      setDetailActionAvailabilityKey(availabilityKey);
      return;
    }
    if (availabilityKey === detailActionAvailabilityKey) return;

    let cancelled = false;
    void getLogDetailsActionAvailabilityAsync(repoRoot, {
      hash: targetHash,
      selectedChanges,
      allChanges,
    }).then((res) => {
      if (cancelled) return;
      setDetailActionAvailabilityKey(availabilityKey);
      if (!res.ok || !res.data) {
        setDetailActionAvailability(null);
        return;
      }
      setDetailActionAvailability(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [
    detailActionAvailability,
    detailActionAvailabilityKey,
    detailFileItems,
    details,
    menu,
    orderedSelectedCommitHashesNewestFirst,
    orderedSelectedCommitHashesOldestFirst,
    repoRoot,
    resolveDetailMenuFileTargets,
    resolveDetailPathCommitHashes,
    selectedDetailPaths,
    selectedDetailPrimaryPath,
  ]);

  /**
   * 加载日志数据（支持分页与覆盖）。
   */
  const loadLogAsync = useCallback(
    async (targetRepoRoot: string, cursor: number, overwrite: boolean): Promise<void> => {
      if (!targetRepoRoot || !active) return;
      const requestId = logRequestSeqRef.current + 1;
      logRequestSeqRef.current = requestId;
      setLogLoading(true);
      const res = await getLogAsync(targetRepoRoot, cursor, LOG_PAGE_SIZE, activeLogFilters);
      if (requestId !== logRequestSeqRef.current) return;
      if (!res.ok || !res.data) {
        setLogLoading(false);
        setError(toErrorText(res.error, gt("workbench.log.loadFailed", "读取日志失败")));
        return;
      }
      setLogItems((prev) => (overwrite ? res.data?.items || [] : [...prev, ...(res.data?.items || [])]));
      setLogGraphItems((prev) => {
        const nextGraphItems = res.data?.graphItems || res.data?.items || [];
        return overwrite ? nextGraphItems : mergePagedGitLogGraphItems(prev, nextGraphItems);
      });
      setLogCursor(res.data.nextCursor || 0);
      setLogHasMore(!!res.data.hasMore);
      setLogLoading(false);
    },
    [active, activeLogFilters],
  );

  /**
   * 独立刷新 ignored 节点；优先回放同仓缓存，再异步拉取最新结果，避免切换显示时整页卡顿。
   */
  const refreshIgnoredEntriesAsync = useCallback(async (
    nextRepoRoot?: string,
    options?: { preferCache?: boolean },
  ): Promise<void> => {
    const targetRepoRoot = String(nextRepoRoot || repoRoot || "").trim();
    if (!targetRepoRoot) return;
    if (options?.preferCache && ignoredEntriesCacheRef.current.has(targetRepoRoot)) {
      setIgnoredEntries(ignoredEntriesCacheRef.current.get(targetRepoRoot) || []);
    }
    const requestId = ignoredRequestSeqRef.current + 1;
    ignoredRequestSeqRef.current = requestId;
    setIgnoredLoading(true);
    const res = await getIgnoredStatusAsync(targetRepoRoot);
    if (requestId !== ignoredRequestSeqRef.current) return;
    setIgnoredLoading(false);
    if (!res.ok || !res.data) {
      setError(toErrorText(res.error, gitWorkbenchText("workbench.errors.readIgnoredFilesFailed", "读取已忽略文件失败")));
      return;
    }
    const nextEntries = res.data.entries || [];
    ignoredEntriesCacheRef.current.set(targetRepoRoot, nextEntries);
    setIgnoredEntries(nextEntries);
  }, [repoRoot]);

  /**
   * 独立刷新 worktree 列表；对齐 IDEA `worktreesChanged` 只更新 worktree 视图的语义，
   * 避免把 `.git/worktrees/*` 变化错误放大成整仓刷新。
   */
  const refreshWorktreeItemsAsync = useCallback(async (nextRepoRoot?: string): Promise<void> => {
    const targetRepoRoot = String(nextRepoRoot || repoRoot || "").trim();
    if (!targetRepoRoot) return;
    const requestId = worktreeRequestSeqRef.current + 1;
    worktreeRequestSeqRef.current = requestId;
    const res = await getWorktreesAsync(targetRepoRoot);
    if (requestId !== worktreeRequestSeqRef.current) return;
    if (!res.ok || !res.data) return;
    setWorktreeItems(res.data.items || []);
  }, [repoRoot]);

  /**
   * 给自动刷新链路提供“仅刷新 worktree 列表”的轻量入口，保留与整仓刷新一致的去抖语义。
   */
  const refreshWorktreeItemsForAutoRefreshAsync = useCallback(async (
    options?: { debounceMs?: number },
  ): Promise<void> => {
    const debounceMs = Math.max(0, Math.floor(Number(options?.debounceMs) || 0));
    if (debounceMs > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, debounceMs);
      });
    }
    await refreshWorktreeItemsAsync();
  }, [refreshWorktreeItemsAsync]);

  /**
   * 执行通用刷新（状态/日志/分支/搁置/worktree），并始终使用最新日志筛选条件重载列表。
   */
  const runRefreshAllTaskAsync = useCallback(async (options?: { keepLog?: boolean }): Promise<void> => {
    if (!repoPath || !active) return;
    setLoading(true);
    setCommitTreeBusy(true);
    setError("");
    try {
      const detect = await detectRepoAsync(repoPath);
      if (!detect.ok) {
        setError(toErrorText(detect.error, gt("workbench.repo.detectFailed", "检测仓库失败")));
        return;
      }

      const repo = detect.data;
      if (!repo?.isRepo || !repo.repoRoot) {
        setIsRepo(false);
        setRepoRoot("");
        setRepoBranch("");
        setRepoDetached(false);
        ignoredRequestSeqRef.current += 1;
        setIgnoredLoading(false);
        setIgnoredEntries([]);
        setShelfItems([]);
        setShelfViewState({ showRecycled: false, groupByDirectory: false });
        setStashItems([]);
        setCommitInclusionState(createCommitInclusionState());
        setPartialCommitSelectionState(createPartialCommitSelectionState());
        return;
      }

      setIsRepo(true);
      setRepoRoot(repo.repoRoot);
      setRepoBranch(String(repo.branch || "HEAD"));
      setRepoDetached(!!repo.detached);

      const statusTask = getStatusAsync(projectScopePath || repo.repoRoot);
      const branchTask = getBranchPopupAsync(repo.repoRoot);
      const shelfTask = getShelvesAsync(repo.repoRoot);
      const stashTask = getStashListAsync(repo.repoRoot);
      const worktreeTask = refreshWorktreeItemsAsync(repo.repoRoot);

      /**
       * 提交树只依赖状态链路；branch/stash/worktree/log 即使慢或失败，也不应让左侧提交树一直卡在 busy。
       */
      try {
        const statusRes = await statusTask;
        if (statusRes.ok && statusRes.data) {
          const statusData = statusRes.data;
          setStatus(statusData);
          setCommitInclusionState((prev) => syncCommitInclusionState(
            prev,
            buildCommitInclusionItems(statusData.entries || []),
            String(statusData.changeLists?.activeListId || ""),
            effectiveCommitAllSetting,
          ));
          if (statusData.viewOptions?.showIgnored) {
            void refreshIgnoredEntriesAsync(repo.repoRoot, { preferCache: true });
          } else {
            ignoredRequestSeqRef.current += 1;
            setIgnoredLoading(false);
            setIgnoredEntries([]);
          }
        } else {
          ignoredRequestSeqRef.current += 1;
          setIgnoredLoading(false);
          setIgnoredEntries([]);
        }
      } finally {
        setCommitTreeBusy(false);
      }

      const [branchRes, shelfRes, stashRes] = await Promise.all([
        branchTask,
        shelfTask,
        stashTask,
        worktreeTask,
      ]);

      if (branchRes.ok && branchRes.data) {
        setBranchPopup(branchRes.data);
        setRepoBranch(String(branchRes.data.currentBranch || repo.branch || "HEAD"));
        setRepoDetached(!!branchRes.data.detached);
      }

      if (shelfRes.ok && shelfRes.data) {
        setShelfItems(shelfRes.data.items || []);
        setShelfViewState(shelfRes.data.viewState || { showRecycled: false, groupByDirectory: false });
      }
      if (stashRes.ok && stashRes.data) setStashItems(stashRes.data.items || []);

      if (!options?.keepLog) {
        await loadLogAsync(repo.repoRoot, 0, true);
      }
    } finally {
      setLoading(false);
      setCommitTreeBusy(false);
    }
  }, [active, buildCommitInclusionItems, effectiveCommitAllSetting, loadLogAsync, projectScopePath, refreshIgnoredEntriesAsync, refreshWorktreeItemsAsync, repoPath, syncCommitInclusionState]);

  const refreshAllController = useMemo(() => createCommitRefreshController<{ keepLog?: boolean; debounceMs?: number }>(
    async (options) => {
      const debounceMs = Math.max(0, Math.floor(Number(options?.debounceMs) || 0));
      if (debounceMs > 0) await new Promise<void>((resolve) => {
        window.setTimeout(resolve, debounceMs);
      });
      await runRefreshAllTaskAsync({ keepLog: options?.keepLog });
    },
    (running, pending) => ({
      keepLog: (running?.keepLog !== false) && (pending?.keepLog !== false),
      debounceMs: Math.max(Number(running?.debounceMs) || 0, Number(pending?.debounceMs) || 0),
    }),
  ), [runRefreshAllTaskAsync]);

  /**
   * 执行通用刷新（状态/日志/分支/搁置/worktree），并通过串行控制器保证最多一个运行中 + 一个排队中。
   */
  const refreshAllAsync = useCallback(async (options?: {
    keepLog?: boolean;
    debounceMs?: number;
    resetView?: boolean;
    afterRefresh?: () => Promise<void> | void;
  }): Promise<void> => {
    const currentCommitTreeViewState = commitTreeViewStateRef.current;
    pendingCommitTreeStateRef.current = createCommitTreeStateSnapshot({
      selectedRowKeys: currentCommitTreeViewState.selectedRowKeys,
      groupExpanded: currentCommitTreeViewState.groupExpanded,
      treeExpanded: currentCommitTreeViewState.treeExpanded,
      scrollTop: commitTreeContainerRef.current?.scrollTop || 0,
    });
    if (options?.resetView) setCommitTreeResetPending(true);
    await refreshAllController.request({
      keepLog: options?.keepLog,
      debounceMs: options?.debounceMs,
    });
    await refreshAllController.awaitNotBusy();
    if (options?.afterRefresh) await options.afterRefresh();
  }, [refreshAllController]);

  /**
   * 按 repoRoot 批量执行 stage/unstage；stage 侧额外支持 intent-to-add 变体，供 Add Without Content 复用。
   */
  const executeStageBatchesAsync = useCallback(async (
    batches: Array<{ repoRoot: string; paths: string[] }>,
    action: "stage" | "unstage",
    options?: { mode?: "content" | "intentToAdd" },
  ): Promise<void> => {
    if (batches.length === 0) return;
    let hasAppliedChange = false;
    for (const batch of batches) {
      const targetRepoRoot = normalizeCommitRepoRoot(batch.repoRoot);
      const paths = Array.from(new Set(
        (batch.paths || [])
          .map((one) => String(one || "").trim().replace(/\\/g, "/"))
          .filter(Boolean),
      ));
      if (!targetRepoRoot || paths.length === 0) continue;
      const result = action === "stage"
        ? await stageFilesAsync(targetRepoRoot, paths, { mode: options?.mode })
        : await unstageFilesAsync(targetRepoRoot, paths);
      if (!result.ok) {
        setError(toErrorText(
          result.error,
          action === "stage"
            ? gt("workbench.changes.stageFailed", "暂存失败")
            : gt("workbench.changes.unstageFailed", "从暂存区移除失败"),
        ));
        if (hasAppliedChange) await refreshAllAsync({ keepLog: true });
        return;
      }
      hasAppliedChange = true;
    }
    if (hasAppliedChange) await refreshAllAsync({ keepLog: true });
  }, [refreshAllAsync]);

  /**
   * 按 repoRoot 分批创建 Stash；选中文件 stash 与 toolbar 的全局 silent stash 共用同一通知/刷新闭环。
   */
  const runCreateStashBatchesAsync = useCallback(async (
    batches: Array<{ repoRoot: string; paths?: string[] }>,
    options: {
      includeUntracked: boolean;
      failureText: string;
      noticeAction: string;
    },
  ): Promise<void> => {
    if (batches.length === 0) return;
    let hasAppliedChange = false;
    const warnings: string[] = [];
    for (const batch of batches) {
      const targetRepoRoot = normalizeCommitRepoRoot(batch.repoRoot);
      if (!targetRepoRoot) continue;
      const result = await createStashAsync(
        targetRepoRoot,
        "",
        options.includeUntracked,
        Array.isArray(batch.paths) && batch.paths.length > 0 ? batch.paths : undefined,
      );
      if (!result.ok) {
        setError(toErrorText(result.error, options.failureText));
        if (hasAppliedChange) await refreshAllAsync({ keepLog: true });
        return;
      }
      hasAppliedChange = true;
      const warningText = String(result.data?.warning || "").trim();
      if (warningText) warnings.push(warningText);
    }
    const mergedWarning = Array.from(new Set(warnings)).join("；");
    if (mergedWarning) {
      finalizeGitNotice({
        action: options.noticeAction,
        tone: "warn",
        message: mergedWarning,
      });
    }
    if (hasAppliedChange) await refreshAllAsync({ keepLog: true });
  }, [finalizeGitNotice, refreshAllAsync]);

  /**
   * 统一按 repoRoot 分批执行 stage/unstage，供菜单、hover 与拖拽投放复用，避免每个入口各自拆分路径。
   */
  const runCommitTreeStageOperationAsync = useCallback(async (
    entries: GitStatusEntry[],
    action: "stage" | "unstage",
  ): Promise<void> => {
    const batches = buildGitStageOperationBatches({
      entries,
      fallbackRepoRoot: repoRoot,
      predicate: (entry) => (
        action === "stage"
          ? (!entry.ignored && (entry.untracked || entry.unstaged || !entry.staged))
          : (!entry.ignored && entry.staged)
      ),
    });
    await executeStageBatchesAsync(batches, action);
  }, [executeStageBatchesAsync, repoRoot]);

  /**
   * 执行“移动到更改列表”；tracked-only 直接本地补丁状态，其余场景再回退到完整刷新链路。
   */
  const moveFilesBetweenChangeListsAsync = useCallback(async (paths: string[], targetListId: string): Promise<void> => {
    if (!repoRoot) return;
    const normalizedPaths = Array.from(new Set(
      paths
        .map((one) => String(one || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ));
    const normalizedTargetListId = String(targetListId || "").trim();
    if (normalizedPaths.length <= 0 || !normalizedTargetListId) return;
    const res = await moveFilesToChangeListAsync(
      repoRoot,
      normalizedPaths,
      normalizedTargetListId,
      buildMoveEntryStatePayload(normalizedPaths, statusEntryByPath),
    );
    if (!res.ok) {
      setError(toErrorText(res.error, gt("workbench.changes.moveFailed", "移动失败")));
      return;
    }
    const addedToVcsCount = Math.max(0, Math.floor(Number(res.data?.addedToVcsCount) || 0));
    if (addedToVcsCount > 0) {
      await refreshAllAsync({ keepLog: true });
      return;
    }
    setStatus((prev) => prev ? applyMovedPathsToStatusSnapshot(prev, normalizedPaths, normalizedTargetListId) : prev);
  }, [refreshAllAsync, repoRoot, statusEntryByPath]);
  const invokeRefreshAllAsync = useLatestAsyncRunner(refreshAllAsync);
  const autoRefreshRepoRoots = useMemo(() => {
    return Array.from(new Set(
      [
        repoRoot,
        ...(branchPopup?.repositories || []).map((item) => item.repoRoot),
        ...(status?.entries || []).map((entry) => String(entry.repositoryRoot || "").trim()),
        ...(shelfItems || []).flatMap((item) => item.repoRoots || [item.repoRoot]),
      ]
        .map((root) => String(root || "").trim())
        .filter(Boolean),
    ));
  }, [branchPopup?.repositories, repoRoot, shelfItems, status?.entries]);
  useGitAutoRefresh({
    active,
    repoRoot,
    repoRoots: autoRefreshRepoRoots,
    refreshAllAsync,
    refreshWorktreesAsync: refreshWorktreeItemsForAutoRefreshAsync,
  });

  /**
   * 统一展示历史改写反馈，供 interactive rebase / editMessage / deleteCommit 共用通知与刷新语义。
   */
  const presentHistoryRewriteFeedbackAsync = useCallback(async (
    feedback: GitHistoryRewriteFeedback,
    options?: { requestId?: number },
  ): Promise<void> => {
    if (feedback.shouldRefresh) {
      await refreshAllAsync({ keepLog: false });
    }
    const noticeActions: GitNoticeActionItem[] = [];
    const undoPayload = feedback.undo?.payload;
    const actionRepoRoot = String(undoPayload?.repoRoot || repoRoot || "").trim();
    if (undoPayload?.kind === "delete-commit" && undoPayload.oldHead && undoPayload.newHead && actionRepoRoot) {
      noticeActions.push({
        id: `history-rewrite-undo:${undoPayload.oldHead}:${undoPayload.newHead}`,
        label: String(feedback.undo?.label || "").trim() || gt("workbench.common.undo", "撤销"),
        onClick: async () => {
          const undoRes = await runLogActionAsync(actionRepoRoot, {
            action: "deleteCommitUndo",
            oldHead: undoPayload.oldHead,
            newHead: undoPayload.newHead,
          });
          const undoFeedback = extractHistoryRewriteFeedback(undoRes.data);
          if (undoFeedback) {
            await presentHistoryRewriteFeedbackAsync(undoFeedback, { requestId: undoRes.meta?.requestId });
            return;
          }
          if (!undoRes.ok) {
            setError(toErrorText(undoRes.error, gt("workbench.historyRewrite.undoDeleteCommitFailed", "撤销删除提交失败")));
            return;
          }
          await refreshAllAsync({ keepLog: false });
          finalizeGitNotice({
            requestId: undoRes.meta?.requestId,
            action: "log.deleteCommitUndo",
            tone: "info",
            message: gt("workbench.historyRewrite.deleteCommitUndone", "已撤销删除提交"),
            detailLines: [gt("workbench.historyRewrite.deleteCommitUndoneDetail", "已恢复删除前的提交历史")],
          });
        },
      });
    }
    finalizeGitNotice({
      requestId: options?.requestId,
      action: "log.historyRewrite",
      tone: feedback.tone === "danger" ? "danger" : feedback.tone === "warn" ? "warn" : "info",
      message: feedback.title,
      detailLines: [feedback.message, ...(feedback.detailLines || [])],
      actions: noticeActions.length > 0 ? noticeActions : undefined,
    });
  }, [finalizeGitNotice, refreshAllAsync, repoRoot]);

  /**
   * 统一清理 amend 运行时状态；关闭 amend 或提交成功后调用，可按需恢复旧草稿与旧作者。
   */
  const clearCommitAmendRuntimeState = useCallback((restoreDraft: boolean): void => {
    commitAmendLoadSeqRef.current += 1;
    commitAmendRequestedHashRef.current = "";
    setCommitAmendLoading(false);
    setCommitAmendDetails(null);
    const snapshot = commitAmendRestoreRef.current;
    commitAmendRestoreRef.current = null;
    if (!restoreDraft || !snapshot) return;
    if (shouldRestoreCommitAmendAuthor(commitAuthorValueRef.current, snapshot)) {
      setCommitAdvancedOptionsState((prev) => patchCommitAdvancedOptionsState(prev, {
        author: snapshot.beforeAuthor,
      }));
    }
    if (shouldRestoreCommitAmendMessage(commitMessageValueRef.current, snapshot)) {
      setCommitMessage(snapshot.beforeMessage);
    }
  }, []);

  /**
   * 读取当前 HEAD 的提交详情，并把上一提交的 message/author 回填到非模态提交工作流。
   */
  const loadCommitAmendDetailsAsync = useCallback(async (targetHash: string): Promise<void> => {
    const normalizedHash = String(targetHash || "").trim();
    if (!repoRoot || !normalizedHash) return;
    if (isSameCommitHashIdentity(commitAmendRequestedHashRef.current, normalizedHash)) return;
    const requestId = commitAmendLoadSeqRef.current + 1;
    const beforeMessage = commitMessageValueRef.current;
    const beforeAuthor = commitAuthorValueRef.current;
    commitAmendLoadSeqRef.current = requestId;
    commitAmendRequestedHashRef.current = normalizedHash;
    setCommitAmendLoading(true);
    setCommitAmendDetails(null);
    const res = await getLogDetailsAsync(repoRoot, [normalizedHash]);
    if (requestId !== commitAmendLoadSeqRef.current) return;
    setCommitAmendLoading(false);
    if (!res.ok || !res.data || res.data.mode !== "single") {
      setError(toErrorText(res.error, gt("workbench.commit.amendLoadFailed", "读取上一提交详情失败")));
      return;
    }
    const nextDetails = buildCommitAmendDetails(res.data.detail);
    commitAmendRequestedHashRef.current = String(nextDetails.hash || normalizedHash).trim() || normalizedHash;
    commitAmendRestoreRef.current = createCommitAmendRestoreSnapshot(beforeMessage, beforeAuthor, nextDetails);
    setCommitAmendDetails(nextDetails);
    if (nextDetails.author && nextDetails.author !== commitAuthorValueRef.current) {
      setCommitAdvancedOptionsState((prev) => patchCommitAdvancedOptionsState(prev, {
        author: nextDetails.author,
      }));
    }
    if (shouldApplyCommitAmendMessage(commitMessageValueRef.current, nextDetails.fullMessage)) {
      setCommitMessage(nextDetails.fullMessage);
    }
  }, [repoRoot]);

  /**
   * 进入 amend 模式后自动跟随当前 HEAD 读取目标提交详情；若 HEAD 变化，则按最新提交重新回填。
   */
  useEffect(() => {
    if (!commitAmendEnabled) return;
    const targetHash = String(status?.headSha || "").trim();
    if (!repoRoot || !targetHash) return;
    if (isSameCommitHashIdentity(commitAmendDetails?.hash || "", targetHash)) return;
    if (isSameCommitHashIdentity(commitAmendRequestedHashRef.current, targetHash)) return;
    void loadCommitAmendDetailsAsync(targetHash);
  }, [commitAmendDetails?.hash, commitAmendEnabled, loadCommitAmendDetailsAsync, repoRoot, status?.headSha]);

  /**
   * 切换“修改上一提交”模式；开启时读取 HEAD 详情并回填 message/author，关闭时按 IDEA 语义恢复旧草稿。
   */
  const handleCommitAmendToggleAsync = useCallback(async (enabled: boolean): Promise<void> => {
    if (!enabled) {
      clearCommitAmendRuntimeState(true);
      setCommitAmendEnabled(false);
      return;
    }
    const targetHash = String(status?.headSha || "").trim();
    if (!repoRoot || !targetHash) {
      setError(gt("commit.amend.noPreviousCommit", "当前没有可修改的上一提交"));
      return;
    }
    setCommitAmendEnabled(true);
  }, [clearCommitAmendRuntimeState, repoRoot, status?.headSha]);

  /**
   * 预览 ignored special node 的 ignore 目标，并拉起目标选择弹层。
   */
  const openIgnoreTargetDialogAsync = useCallback(async (
    paths: string[],
    targetRepoRoot?: string,
    anchor?: { x: number; y: number },
  ): Promise<void> => {
    const actionRepoRoot = String(targetRepoRoot || repoRoot || "").trim();
    if (!actionRepoRoot) return;
    const res = await getIgnoreTargetsAsync(actionRepoRoot, paths);
    if (!res.ok || !res.data) {
      setError(toErrorText(res.error, gt("workbench.commit.ignoreTargetsLoadFailed", "读取忽略目标失败")));
      return;
    }
    if ((res.data.targets || []).length === 0) {
      setError(gt("commit.ignoreTarget.noAvailableTargets", "当前未找到可用的忽略目标"));
      return;
    }
    setIgnoreTargetDialogState({
      requests: [{
        repoRoot: actionRepoRoot,
        paths: res.data.paths || paths,
        targets: res.data.targets || [],
      }],
      activeIndex: 0,
      anchor,
    });
  }, [gt, repoRoot]);

  /**
   * 按仓库分批预读 ignore 目标；多仓时顺序复用同一 popup，避免在真正执行时再临时中断。
   */
  const openIgnoreTargetDialogsByRepoAsync = useCallback(async (
    requests: Array<{ repoRoot: string; paths: string[] }>,
    anchor?: { x: number; y: number },
  ): Promise<void> => {
    const normalizedRequests = requests
      .map((request) => ({
        repoRoot: String(request.repoRoot || "").trim(),
        paths: Array.from(new Set((request.paths || []).map((item) => String(item || "").trim()).filter(Boolean))),
      }))
      .filter((request) => !!request.repoRoot && request.paths.length > 0);
    if (normalizedRequests.length <= 0) return;
    const resolvedRequests: IgnoreTargetDialogRequest[] = [];
    for (const request of normalizedRequests) {
      const res = await getIgnoreTargetsAsync(request.repoRoot, request.paths);
      if (!res.ok || !res.data) {
        setError(toErrorText(res.error, gt("workbench.commit.ignoreTargetsLoadFailed", "读取忽略目标失败")));
        return;
      }
      if ((res.data.targets || []).length <= 0) {
        setError(gt("commit.ignoreTarget.noAvailableTargets", "当前未找到可用的忽略目标"));
        return;
      }
      resolvedRequests.push({
        repoRoot: request.repoRoot,
        paths: res.data.paths || request.paths,
        targets: res.data.targets || [],
      });
    }
    setIgnoreTargetDialogState({
      requests: resolvedRequests,
      activeIndex: 0,
      anchor,
    });
  }, [gt]);

  /**
   * 按条目仓库归属分组后打开 ignore 目标弹层，供主树与 Browse 对话框共用，避免跨仓选择误写到当前仓。
   */
  const openIgnoreTargetDialogForEntriesAsync = useCallback(async (
    entries: GitStatusEntry[],
    anchor?: { x: number; y: number },
  ): Promise<void> => {
    const groupedIgnoreRequests = Array.from(entries.reduce((map, entry) => {
      const targetRepoRoot = normalizeCommitRepoRoot(entry.repositoryRoot || repoRoot);
      const normalizedPath = String(entry.path || "").trim();
      if (!targetRepoRoot || !normalizedPath) return map;
      const hit = map.get(targetRepoRoot) || [];
      hit.push(normalizedPath);
      map.set(targetRepoRoot, hit);
      return map;
    }, new Map<string, string[]>()).entries()).map(([targetRepoRoot, paths]) => ({
      repoRoot: targetRepoRoot,
      paths,
    }));
    if (groupedIgnoreRequests.length <= 0) return;
    if (groupedIgnoreRequests.length === 1) {
      await openIgnoreTargetDialogAsync(groupedIgnoreRequests[0]?.paths || [], groupedIgnoreRequests[0]?.repoRoot, anchor);
      return;
    }
    await openIgnoreTargetDialogsByRepoAsync(groupedIgnoreRequests, anchor);
  }, [openIgnoreTargetDialogAsync, openIgnoreTargetDialogsByRepoAsync, repoRoot]);

  /**
   * 把拖拽到 ignored special node 的未跟踪文件写入选中的 ignore 目标。
   */
  const applyIgnoreTargetAsync = useCallback(async (target: GitIgnoreTarget): Promise<void> => {
    if (!ignoreTargetDialogState) return;
    const activeRequest = ignoreTargetDialogState.requests[ignoreTargetDialogState.activeIndex] || null;
    if (!activeRequest) {
      setIgnoreTargetDialogState(null);
      return;
    }
    setIgnoreTargetDialogState((prev) => prev ? { ...prev, applyingTargetId: target.id } : prev);
    const res = await ignoreFilesAsync(activeRequest.repoRoot, activeRequest.paths, target);
    if (!res.ok) {
      setIgnoreTargetDialogState((prev) => prev ? { ...prev, applyingTargetId: undefined } : prev);
      setError(toErrorText(res.error, gt("workbench.commit.ignoreRuleWriteFailed", "写入忽略规则失败")));
      return;
    }
    const hasNextRequest = ignoreTargetDialogState.activeIndex < ignoreTargetDialogState.requests.length - 1;
    if (hasNextRequest) {
      setIgnoreTargetDialogState((prev) => prev ? {
        ...prev,
        activeIndex: Math.min(prev.activeIndex + 1, prev.requests.length - 1),
        applyingTargetId: undefined,
      } : prev);
      return;
    }
    setIgnoreTargetDialogState(null);
    await refreshAllAsync({ keepLog: true });
  }, [gt, ignoreTargetDialogState, refreshAllAsync]);

  /**
   * 切换提交面板视图选项（目录 / 已忽略文件），统一复用刷新逻辑。
   */
  const applyChangesViewOptionAsync = useCallback(async (
    key: "groupByDirectory" | "showIgnored" | "detailsPreviewShown" | "diffPreviewOnDoubleClickOrEnter",
    value: boolean,
  ): Promise<void> => {
    if (!repoRoot) return;
    const res = await setChangesViewOptionAsync(projectScopePath || repoRoot, key, value);
    if (!res.ok) {
      setError(toErrorText(res.error, gt("workbench.changes.viewOptionsSaveFailed", "更新视图选项失败")));
      return;
    }
    setStatus((prev) => prev ? {
      ...prev,
      viewOptions: {
        ...prev.viewOptions,
        [key]: value,
        groupingKeys: key === "groupByDirectory"
          ? (value
            ? normalizeCommitGroupingKeys([...(prev.viewOptions.groupingKeys || []), "directory"], false)
            : normalizeCommitGroupingKeys(prev.viewOptions.groupingKeys || [], false).filter((one) => one !== "directory"))
          : prev.viewOptions.groupingKeys,
      },
    } : prev);
    if (key === "showIgnored") {
      if (value) {
        void refreshIgnoredEntriesAsync(repoRoot, { preferCache: true });
      } else {
        ignoredRequestSeqRef.current += 1;
        setIgnoredLoading(false);
        setIgnoredEntries([]);
      }
      return;
    }
    if (key === "detailsPreviewShown" && !value) closeDiffPreview();
    if (key === "groupByDirectory") {
      await refreshAllAsync({ keepLog: true, resetView: true });
    }
  }, [closeDiffPreview, projectScopePath, refreshAllAsync, refreshIgnoredEntriesAsync, repoRoot]);

  /**
   * 切换提交面板 grouping key 集；统一走持久化配置并触发一次串行刷新。
   */
  const applyCommitGroupingKeyAsync = useCallback(async (groupingKey: CommitGroupingKey): Promise<void> => {
    if (!repoRoot) return;
    const nextKeys = activeCommitGroupingKeys.includes(groupingKey)
      ? activeCommitGroupingKeys.filter((key) => key !== groupingKey)
      : [...activeCommitGroupingKeys, groupingKey];
    const normalizedKeys = normalizeCommitGroupingKeys(nextKeys, false)
      .filter((key) => availableCommitGroupingKeys.includes(key));
    const res = await setCommitGroupingKeysAsync(projectScopePath || repoRoot, normalizedKeys);
    if (!res.ok) {
      setError(toErrorText(res.error, gt("workbench.changes.groupingSaveFailed", "更新分组依据失败")));
      return;
    }
    setStatus((prev) => prev ? {
      ...prev,
      viewOptions: {
        ...prev.viewOptions,
        groupingKeys: normalizedKeys,
        groupByDirectory: normalizedKeys.includes("directory"),
      },
    } : prev);
    await refreshAllAsync({ keepLog: true, resetView: true });
  }, [activeCommitGroupingKeys, availableCommitGroupingKeys, projectScopePath, refreshAllAsync, repoRoot]);

  /**
   * 持久化 rollback viewer 的目录分组开关，并与提交面板共享同一套 grouping key 配置，确保跨次打开保持一致。
   */
  const applyRollbackViewerGroupingKeysAsync = useCallback(async (
    groupingKeys: GitRollbackBrowserGroupingKey[],
  ): Promise<void> => {
    if (!repoRoot) return;
    const directoryEnabled = groupingKeys.includes("directory");
    const nextKeys = directoryEnabled
      ? normalizeCommitGroupingKeys([...activeCommitGroupingKeys.filter((key) => key !== "directory"), "directory"], false)
      : activeCommitGroupingKeys.filter((key) => key !== "directory");
    const normalizedKeys = normalizeCommitGroupingKeys(nextKeys, false)
      .filter((key) => availableCommitGroupingKeys.includes(key));
    const res = await setCommitGroupingKeysAsync(projectScopePath || repoRoot, normalizedKeys);
    if (!res.ok) {
      setError(toErrorText(res.error, gt("workbench.rollbackViewer.groupingSaveFailed", "更新回滚窗口分组依据失败")));
      return;
    }
    setStatus((prev) => prev ? {
      ...prev,
      viewOptions: {
        ...prev.viewOptions,
        groupingKeys: normalizedKeys,
        groupByDirectory: normalizedKeys.includes("directory"),
      },
    } : prev);
  }, [activeCommitGroupingKeys, availableCommitGroupingKeys, projectScopePath, repoRoot]);

  /**
   * 切换“配置本地更改”选项（暂存区域 / 变更列表 / Commit All），统一复用持久化与刷新逻辑。
   */
  const applyLocalChangesOptionAsync = useCallback(async (key: "stagingAreaEnabled" | "changeListsEnabled" | "commitAllEnabled", value: boolean): Promise<void> => {
    if (!repoRoot) return;
    const res = await setLocalChangesOptionAsync(repoRoot, key, value);
    if (!res.ok) {
      setError(toErrorText(res.error, gt("workbench.changes.localChangesOptionSaveFailed", "更新本地更改配置失败")));
      return;
    }
    await refreshAllAsync({ keepLog: true, resetView: key !== "commitAllEnabled" });
  }, [refreshAllAsync, repoRoot]);

  /**
   * 根据当前选中的提交加载右侧详情。
   */
  const refreshDetailsAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot) return;
    const requestKey = buildCommitDetailsRequestKey(repoRoot, detailRequestHashesKey);
    const requestId = detailRequestSeqRef.current + 1;
    detailRequestSeqRef.current = requestId;
    if (selectedCommitHashes.length === 0) {
      detailLoadedRequestKeyRef.current = "";
      detailRequestedRequestKeyRef.current = "";
      setDetails(null);
      return;
    }
    if (shouldSkipCommitDetailsRequest({
      requestKey,
      loadedRequestKey: detailLoadedRequestKeyRef.current,
      requestedRequestKey: detailRequestedRequestKeyRef.current,
    })) return;
    detailRequestedRequestKeyRef.current = requestKey;
    const requestHashes = orderedSelectedCommitHashesNewestFirst.length > 0 ? orderedSelectedCommitHashesNewestFirst : selectedCommitHashes;
    const res = await getLogDetailsAsync(repoRoot, requestHashes);
    if (requestId !== detailRequestSeqRef.current) return;
    detailRequestedRequestKeyRef.current = "";
    if (!res.ok) {
      setError(toErrorText(res.error, gt("workbench.details.loadFailed", "读取提交详情失败")));
      return;
    }
    detailLoadedRequestKeyRef.current = requestKey;
    setDetails((res.data || null) as GitLogDetails | null);
  }, [detailRequestHashesKey, orderedSelectedCommitHashesNewestFirst, repoRoot, selectedCommitHashes]);
  const invokeRefreshDetailsAsync = useLatestAsyncRunner(refreshDetailsAsync);

  /**
   * 读取日志右键菜单动作可用性，避免前端猜测导致启用状态不准确。
   */
  const refreshLogActionAvailabilityAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot) {
      logActionAvailabilitySeqRef.current += 1;
      setLogActionAvailability(null);
      setLogActionAvailabilityHashesKey("");
      setLogActionAvailabilityLoading(false);
      return;
    }
    const hashes = selectedCommitHashes.filter((one) => !!String(one || "").trim());
    const hashesKey = hashes.join("|");
    if (hashes.length === 0) {
      logActionAvailabilitySeqRef.current += 1;
      setLogActionAvailability(null);
      setLogActionAvailabilityHashesKey("");
      setLogActionAvailabilityLoading(false);
      return;
    }
    const requestId = logActionAvailabilitySeqRef.current + 1;
    logActionAvailabilitySeqRef.current = requestId;
    setLogActionAvailabilityLoading(true);
    const res = await getLogActionAvailabilityAsync(repoRoot, hashes, {
      selectionCount: currentCommitSelectionCount,
    });
    if (requestId !== logActionAvailabilitySeqRef.current) return;
    setLogActionAvailabilityLoading(false);
    if (!res.ok || !res.data) {
      setLogActionAvailability(null);
      setLogActionAvailabilityHashesKey(hashesKey);
      return;
    }
    setLogActionAvailability(res.data);
    setLogActionAvailabilityHashesKey(hashesKey);
  }, [currentCommitSelectionCount, repoRoot, selectedCommitHashes]);

  /**
   * 读取 Git 控制台日志（展示实际执行命令与输出）。
   */
  const loadGitConsoleAsync = useCallback(async (options?: { silent?: boolean }): Promise<void> => {
    if (!repoRoot || !active) return;
    if (!options?.silent) setGitConsoleLoading(true);
    const res = await getGitConsoleAsync(repoRoot, GIT_CONSOLE_VIEW_LIMIT);
    if (!options?.silent) setGitConsoleLoading(false);
    if (!res.ok || !res.data) {
      setError(toErrorText(res.error, gt("workbench.console.loadFailed", "读取 Git 控制台失败")));
      return;
    }
    setGitConsoleItems(res.data.items || []);
  }, [active, repoRoot]);

  /**
   * 复制当前 Git 控制台日志，便于用户直接回传命令与输出进行排查。
   */
  const copyGitConsoleAsync = useCallback(async (): Promise<void> => {
    let entries = gitConsoleItems;
    let fetchError = "";
    if (repoRoot) {
      const res = await getGitConsoleAsync(repoRoot, GIT_CONSOLE_COPY_LIMIT, { includeLongText: true });
      if (res.ok && res.data) {
        entries = Array.isArray(res.data.items) ? res.data.items : [];
      } else {
        fetchError = toErrorText(res.error, gt("workbench.console.loadFailed", "读取 Git 控制台失败"));
      }
    }
    const text = buildGitConsoleCopyText(entries);
    if (!text) {
      if (fetchError && gitConsoleItems.length <= 0) setError(fetchError);
      return;
    }
    const copied = await window.host.utils.copyText(text);
    if (!copied?.ok) {
      setError(toErrorText(copied?.error, gt("workbench.console.copyFailed", "复制 Git 控制台日志失败")));
    }
  }, [gitConsoleItems, repoRoot]);

  /**
   * 打开通用输入对话框，用于替代浏览器 prompt，保证交互一致性。
   */
  const openActionDialogAsync = useCallback((config: ActionDialogConfig): Promise<Record<string, string> | null> => {
    return new Promise((resolve) => {
      const defaults: Record<string, string> = {};
      for (const field of config.fields) {
        const hasDefaultValue = Object.prototype.hasOwnProperty.call(config.defaults || {}, field.key);
        const fromDefaults = hasDefaultValue ? String(config.defaults?.[field.key] ?? "") : "";
        if (hasDefaultValue) {
          defaults[field.key] = fromDefaults;
          continue;
        }
        if (field.type === "select" && field.options && field.options.length > 0) {
          defaults[field.key] = String(field.options[0].value || "");
        } else {
          defaults[field.key] = "";
        }
      }
      actionDialogResolveRef.current = resolve;
      setActionDialogConfig(config);
      setActionDialogValues(defaults);
      setActionDialogSubmitting(false);
      setActionDialogOpen(true);
    });
  }, []);

  /**
   * 关闭输入对话框并返回结果。
   */
  const closeActionDialog = useCallback((result: Record<string, string> | null): void => {
    const resolve = actionDialogResolveRef.current;
    actionDialogResolveRef.current = null;
    setActionDialogOpen(false);
    setActionDialogSubmitting(false);
    setActionDialogConfig(null);
    setActionDialogValues({});
    if (resolve) resolve(result);
  }, []);

  /**
   * 提交输入对话框，执行必填校验后回传字段值。
   */
  const submitActionDialog = useCallback((): void => {
    if (!actionDialogConfig) return;
    const next: Record<string, string> = {};
    for (const field of actionDialogConfig.fields) {
      const value = field.type === "checkbox"
        ? (String(actionDialogValues[field.key] ?? "false") === "true" ? "true" : "false")
        : String(actionDialogValues[field.key] ?? "").trim();
      if (field.required && field.type !== "checkbox" && !value) return;
      next[field.key] = value;
    }
    setActionDialogSubmitting(true);
    closeActionDialog(next);
  }, [actionDialogConfig, actionDialogValues, closeActionDialog]);

  /**
   * 关闭 interactive rebase 对话框，放弃当前草稿编辑状态。
   */
  const closeInteractiveRebaseDialog = useCallback((): void => {
    interactiveRebaseDetailsSeqRef.current += 1;
    setInteractiveRebaseDialogState(null);
  }, []);

  /**
   * 在 interactive rebase 草稿已修改时确认是否放弃，避免误关对话框丢失当前排序与动作编辑。
   */
  const requestCloseInteractiveRebaseDialog = useCallback((): void => {
    if (!interactiveRebaseDialogState || interactiveRebaseDialogState.submitting) return;
    if (hasInteractiveRebaseDraftChanges(interactiveRebaseDialogState.plan.entries || [], interactiveRebaseDialogState.entries)) {
      const confirmed = window.confirm(gt("dialogs.interactiveRebase.discardChangesConfirm", "当前交互式变基计划已修改，确定放弃这些更改吗？"));
      if (!confirmed) return;
    }
    closeInteractiveRebaseDialog();
  }, [closeInteractiveRebaseDialog, interactiveRebaseDialogState]);

  /**
   * 读取 interactive rebase 计划并打开应用内编辑器，替换旧的终端确认流程。
   */
  const openInteractiveRebaseDialogAsync = useCallback(async (targetHash: string): Promise<void> => {
    if (!repoRoot) return;
    const cleanHash = String(targetHash || "").trim();
    if (!cleanHash) return;
    const res = await getInteractiveRebasePlanAsync(repoRoot, cleanHash);
    const feedback = extractHistoryRewriteFeedback(res.data);
    if (feedback) {
      await presentHistoryRewriteFeedbackAsync(feedback, { requestId: res.meta?.requestId });
    }
    if (!res.ok || !res.data || !Array.isArray(res.data.entries)) {
      if (feedback) return;
      const reasonCode = String(res.data?.reasonCode || "").trim();
      if ((reasonCode === "merge-commit" || reasonCode === "non-linear-history") && onOpenTerminalInApp) {
        const fallbackRes = await runLogActionAsync(repoRoot, {
          action: "interactiveRebase",
          hash: cleanHash,
        });
        const terminalInteraction = fallbackRes.data?.terminalInteraction;
        const startupCmd = String(terminalInteraction?.startupCmd || "").trim();
        if (fallbackRes.ok && startupCmd) {
          const opened = await onOpenTerminalInApp({
            projectPath: repoRoot,
            startupCmd,
            title: String(terminalInteraction?.title || "").trim() || undefined,
          });
          if (opened) {
            finalizeGitNotice({
              requestId: fallbackRes.meta?.requestId,
              action: "log.interactiveRebase",
              tone: "info",
              message: gt(
                "dialogs.interactiveRebase.fallback.started",
                "当前历史不适合应用内变基编辑器，已改为在应用内终端启动传统 interactive rebase；完成后请返回 Git 面板刷新状态。",
              ),
            });
            return;
          }
          setError(gt(
            "dialogs.interactiveRebase.fallback.openTerminalFailed",
            "无法在应用内终端启动传统 interactive rebase，请稍后重试或改用外部终端。",
          ));
          return;
        }
        setError(toErrorText(
          fallbackRes.error,
          gt("dialogs.interactiveRebase.fallback.prepareFailed", "准备传统 interactive rebase 回退链路失败"),
        ));
        return;
      }
      setError(resolveInteractiveRebasePlanErrorText(res.error, res.data));
      return;
    }
    const plan = res.data as GitInteractiveRebasePlan;
    const entries = cloneInteractiveRebaseEntries(plan.entries || []);
    setInteractiveRebaseDialogState({
      plan,
      entries,
      selectedHash: entries[0]?.hash || "",
      selectedDiffPathByHash: {},
      submitting: false,
      error: "",
      detailsByHash: {},
      detailsLoadingHash: undefined,
    });
  }, [finalizeGitNotice, gt, onOpenTerminalInApp, presentHistoryRewriteFeedbackAsync, repoRoot]);

  /**
   * 切换 interactive rebase 当前聚焦的提交行。
   */
  const selectInteractiveRebaseEntry = useCallback((hash: string): void => {
    const cleanHash = String(hash || "").trim();
    setInteractiveRebaseDialogState((prev) => prev ? {
      ...prev,
      selectedHash: restoreInteractiveRebaseSelection(prev.entries, cleanHash, prev.selectedHash),
      error: "",
    } : prev);
  }, []);

  /**
   * 调整 interactive rebase 中某条提交的顺序。
   */
  const moveInteractiveRebaseDialogEntry = useCallback((hash: string, offset: -1 | 1): void => {
    setInteractiveRebaseDialogState((prev) => {
      if (!prev) return prev;
      const entries = moveInteractiveRebaseEntry(prev.entries, hash, offset);
      return {
        ...prev,
        entries,
        selectedHash: restoreInteractiveRebaseSelection(entries, hash, prev.selectedHash),
        error: "",
      };
    });
  }, []);

  /**
   * 更新 interactive rebase 行动作，并清空上一轮校验错误。
   */
  const updateInteractiveRebaseDialogAction = useCallback((hash: string, action: GitInteractiveRebaseEntry["action"]): void => {
    setInteractiveRebaseDialogState((prev) => {
      if (!prev) return prev;
      const entries = updateInteractiveRebaseEntryAction(prev.entries, hash, action);
      return {
        ...prev,
        entries,
        selectedHash: restoreInteractiveRebaseSelection(entries, hash, prev.selectedHash),
        error: "",
      };
    });
  }, []);

  /**
   * 更新 interactive rebase 提交消息覆盖值，支持 reword 与 squash 两类动作。
   */
  const updateInteractiveRebaseDialogMessage = useCallback((hash: string, message: string): void => {
    setInteractiveRebaseDialogState((prev) => {
      if (!prev) return prev;
      const entries = updateInteractiveRebaseEntryMessage(prev.entries, hash, message);
      return {
        ...prev,
        entries,
        selectedHash: restoreInteractiveRebaseSelection(entries, hash, prev.selectedHash),
        error: "",
      };
    });
  }, []);

  /**
   * 将当前行的建议消息写入输入框，便于快速生成 squash/reword 文案。
   */
  const fillInteractiveRebaseSuggestedMessage = useCallback((hash: string): void => {
    setInteractiveRebaseDialogState((prev) => {
      if (!prev) return prev;
      const message = resolveInteractiveRebaseSuggestedMessage(prev.entries, hash);
      const entries = updateInteractiveRebaseEntryMessage(prev.entries, hash, message);
      return {
        ...prev,
        entries,
        selectedHash: restoreInteractiveRebaseSelection(entries, hash, prev.selectedHash),
        error: "",
      };
    });
  }, []);

  /**
   * 把 interactive rebase 草稿恢复到后端初始快照，便于重新排布计划。
   */
  const resetInteractiveRebaseDialog = useCallback((): void => {
    setInteractiveRebaseDialogState((prev) => {
      if (!prev) return prev;
      const entries = cloneInteractiveRebaseEntries(prev.plan.entries || []);
      return {
        ...prev,
        entries,
        selectedHash: restoreInteractiveRebaseSelection(entries, prev.selectedHash),
        error: "",
      };
    });
  }, []);

  /**
   * 把当前选中的提交直接移动到顶部或底部，补齐接近 IDEA 上下文动作的快速重排体验。
   */
  const moveInteractiveRebaseDialogEntryToEdge = useCallback((hash: string, edge: "top" | "bottom"): void => {
    setInteractiveRebaseDialogState((prev) => {
      if (!prev) return prev;
      const entries = moveInteractiveRebaseEntryToEdge(prev.entries, hash, edge);
      return {
        ...prev,
        entries,
        selectedHash: restoreInteractiveRebaseSelection(entries, hash, prev.selectedHash),
        error: "",
      };
    });
  }, []);

  /**
   * 记录 interactive rebase 当前选中提交的 diff 文件，保证 details 切换后仍能恢复到用户上次查看的文件。
   */
  const selectInteractiveRebaseDiffPath = useCallback((pathText: string): void => {
    const cleanPath = String(pathText || "").trim().replace(/\\/g, "/");
    if (!cleanPath) return;
    setInteractiveRebaseDialogState((prev) => {
      if (!prev || !prev.selectedHash) return prev;
      return {
        ...prev,
        selectedDiffPathByHash: {
          ...prev.selectedDiffPathByHash,
          [prev.selectedHash]: cleanPath,
        },
      };
    });
  }, []);

  /**
   * 提交 interactive rebase 草稿到主进程执行，并在成功后统一刷新 Git 工作台。
   */
  const submitInteractiveRebaseDialogAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot || !interactiveRebaseDialogState) return;
    const validationError = validateInteractiveRebasePlanEntries(interactiveRebaseDialogState.entries, gt);
    if (validationError) {
      setInteractiveRebaseDialogState((prev) => prev ? { ...prev, error: validationError } : prev);
      return;
    }
    setInteractiveRebaseDialogState((prev) => prev ? { ...prev, submitting: true, error: "" } : prev);
    const res = await runInteractiveRebasePlanAsync(
      repoRoot,
      buildInteractiveRebaseRunPayload(interactiveRebaseDialogState.plan, interactiveRebaseDialogState.entries),
    );
    const feedback = extractHistoryRewriteFeedback(res.data);
    if (!res.ok) {
      if (feedback) {
        if (feedback.shouldRefresh) {
          setInteractiveRebaseDialogState(null);
        } else {
          setInteractiveRebaseDialogState((prev) => prev ? { ...prev, submitting: false, error: "" } : prev);
        }
        await presentHistoryRewriteFeedbackAsync(feedback, { requestId: res.meta?.requestId });
        return;
      }
      const nextError = toErrorText(res.error, gt("interactiveRebase.failed", "执行交互式变基失败"));
      if (res.data?.shouldRefresh === true) {
        setInteractiveRebaseDialogState(null);
        await refreshAllAsync({ keepLog: false });
        setError(nextError);
        return;
      }
      setInteractiveRebaseDialogState((prev) => prev ? { ...prev, submitting: false, error: nextError } : prev);
      return;
    }
    if (feedback) {
      setInteractiveRebaseDialogState(null);
      await presentHistoryRewriteFeedbackAsync(feedback, { requestId: res.meta?.requestId });
      return;
    }
    setInteractiveRebaseDialogState(null);
    await refreshAllAsync({ keepLog: false });
  }, [interactiveRebaseDialogState, presentHistoryRewriteFeedbackAsync, refreshAllAsync, repoRoot]);

  /**
   * 当 interactive rebase 焦点提交变化时按需拉取真实 commit details，供右侧详情区复用。
   */
  useEffect(() => {
    if (!repoRoot || !interactiveRebaseDialogState?.selectedHash) return;
    const selectedHash = interactiveRebaseDialogState.selectedHash;
    if (interactiveRebaseDialogState.detailsByHash[selectedHash]) return;
    if (interactiveRebaseDialogState.detailsLoadingHash === selectedHash) return;
    const requestSeq = interactiveRebaseDetailsSeqRef.current + 1;
    interactiveRebaseDetailsSeqRef.current = requestSeq;
    setInteractiveRebaseDialogState((prev) => prev ? { ...prev, detailsLoadingHash: selectedHash } : prev);
    void (async () => {
      const res = await getLogDetailsAsync(repoRoot, [selectedHash]);
      if (interactiveRebaseDetailsSeqRef.current !== requestSeq) return;
      setInteractiveRebaseDialogState((prev) => {
        if (!prev || prev.selectedHash !== selectedHash) return prev;
        if (!res.ok || !res.data) {
          return {
            ...prev,
            detailsLoadingHash: undefined,
          };
        }
        return {
          ...prev,
          detailsLoadingHash: undefined,
          detailsByHash: {
            ...prev.detailsByHash,
            [selectedHash]: res.data,
          },
          selectedDiffPathByHash: {
            ...prev.selectedDiffPathByHash,
            [selectedHash]: resolveInteractiveRebaseDiffPath(
              res.data,
              prev.selectedDiffPathByHash,
              selectedHash,
            ),
          },
        };
      });
    })();
  }, [interactiveRebaseDialogState, repoRoot]);

  /**
   * 关闭 stage three versions 对话框，供显式取消与完成后复用同一收口逻辑。
   */
  const closeStageThreeWayDialog = useCallback((): void => {
    setStageThreeWayDialogState(null);
  }, []);

  /**
   * 按当前文件装配 HEAD / Index / Working Tree 三份快照，复用现有 diff.get 链路实现只读三栏比较。
   */
  const openStageThreeWayDialogAsync = useCallback(async (pathText: string): Promise<void> => {
    const cleanPath = String(pathText || "").trim().replace(/\\/g, "/");
    if (!repoRoot || !cleanPath) return;
    setStageThreeWayDialogState({
      path: cleanPath,
      loading: true,
      headText: "",
      indexText: "",
      workingText: "",
      headRenderable: false,
      indexRenderable: false,
      workingRenderable: false,
      headFallbackText: "",
      indexFallbackText: "",
      workingFallbackText: "",
    });
    const [stagedRes, workingRes] = await Promise.all([
      getDiffAsync(repoRoot, { path: cleanPath, mode: "staged" }),
      getDiffAsync(repoRoot, { path: cleanPath, mode: "working" }),
    ]);
    if (!stagedRes.ok || !workingRes.ok) {
      setStageThreeWayDialogState({
        path: cleanPath,
        loading: false,
        error: getErrorText(stagedRes.error || workingRes.error, "workbench.stageThreeWay.loadFailed", "读取三版本比较失败"),
        headText: "",
        indexText: "",
        workingText: "",
        headRenderable: false,
        indexRenderable: false,
        workingRenderable: false,
        headFallbackText: gt("workbench.stageThreeWay.headUnavailable", "HEAD 快照不可用"),
        indexFallbackText: gt("workbench.stageThreeWay.indexUnavailable", "Index 快照不可用"),
        workingFallbackText: gt("workbench.stageThreeWay.workingTreeUnavailable", "Working Tree 快照不可用"),
      });
      return;
    }
    const headPane = resolveStageThreeWayPaneState(stagedRes.data, "left", gt("workbench.stageThreeWay.head", "HEAD"));
    const indexPane = resolveStageThreeWayPaneState(stagedRes.data, "right", gt("workbench.stageThreeWay.index", "Index"));
    const workingPane = resolveStageThreeWayPaneState(workingRes.data, "right", gt("workbench.stageThreeWay.workingTree", "Working Tree"));
    setStageThreeWayDialogState({
      path: cleanPath,
      loading: false,
      headText: headPane.text,
      indexText: indexPane.text,
      workingText: workingPane.text,
      headRenderable: headPane.renderable,
      indexRenderable: indexPane.renderable,
      workingRenderable: workingPane.renderable,
      headFallbackText: headPane.fallbackText,
      indexFallbackText: indexPane.fallbackText,
      workingFallbackText: workingPane.fallbackText,
    });
  }, [repoRoot]);

  /**
   * 按选中对象加载 Diff。
   */
  const openDiffRequestAsync = useCallback(
    async (request: CommitDiffOpenRequest, repoRootOverride?: string): Promise<void> => {
      const targetRepoRoot = String(repoRootOverride || repoRoot || "").trim();
      if (!targetRepoRoot || !request.path) return;
      const requestSignature = buildCommitDiffRequestSignature(request);
      if (loadedDiffRequestSignatureRef.current === requestSignature) return;
      if (pendingDiffRequestRef.current?.signature === requestSignature) return;
      const requestId = diffRequestSeqRef.current + 1;
      diffRequestSeqRef.current = requestId;
      pendingDiffRequestRef.current = { requestId, signature: requestSignature };
      const normalizedHashes = Array.from(new Set((request.hashes || []).map((one) => String(one || "").trim()).filter(Boolean)));
      try {
        const res = await getDiffAsync(targetRepoRoot, {
          path: request.path,
          oldPath: request.oldPath,
          mode: request.mode,
          hash: request.hash,
          hashes: normalizedHashes.length > 0 ? normalizedHashes : undefined,
          shelfRef: request.shelfRef,
        });
        if (requestId !== diffRequestSeqRef.current) return;
        if (!res.ok) {
          setError(toErrorText(res.error, gt("workbench.diff.loadFailed", "读取差异失败")));
          return;
        }
        const nextDiff = applyCommitDiffOpenRequestToSnapshot(res.data || null, {
          ...request,
          hash: request.hash,
          hashes: normalizedHashes,
        });
        loadedDiffRequestSignatureRef.current = nextDiff ? requestSignature : "";
        setDiff(nextDiff);
        setDiffActiveLine(-1);
      } finally {
        if (pendingDiffRequestRef.current?.requestId === requestId)
          pendingDiffRequestRef.current = null;
      }
    },
    [repoRoot],
  );

  /**
   * 把 `Diff.ShowStandaloneDiff` 落为 Git 面板内的独立 Diff 打开入口；仅保留显式动作触发，不再提供工具栏常驻固定按钮。
   */
  const openPinnedDiffRequestAsync = useCallback(async (
    request: CommitDiffOpenRequest,
    repoRootOverride?: string,
  ): Promise<void> => {
    const requestSignature = buildCommitDiffRequestSignature(request);
    await openDiffRequestAsync(request, repoRootOverride);
    if (loadedDiffRequestSignatureRef.current !== requestSignature) return;
    setDiffPinned(true);
    setDiffFullscreen(true);
  }, [openDiffRequestAsync]);

  /**
   * 兼容旧调用方式的 Diff 打开入口；无显式组选区时自动退化为单文件快照。
   */
  const openDiffAsync = useCallback(
    async (
      path: string,
      mode: GitDiffMode,
      hash?: string,
      hashes?: string[],
      selection?: {
        paths?: string[];
        kind?: GitDiffSnapshot["selectionKind"];
        index?: number;
        oldPath?: string;
        repoRoot?: string;
      },
    ): Promise<void> => {
      const cleanPath = String(path || "").trim().replace(/\\/g, "/");
      if (!cleanPath) return;
      const selectionPaths = Array.from(new Set(
        (selection?.paths || [])
          .map((one) => String(one || "").trim().replace(/\\/g, "/"))
          .filter(Boolean),
      ));
      const normalizedSelectionPaths = Array.from(new Set(
        selectionPaths.length > 0 ? [...selectionPaths, cleanPath] : [cleanPath],
      ));
      const selectionIndex = normalizedSelectionPaths.indexOf(cleanPath);
      await openDiffRequestAsync({
        path: cleanPath,
        oldPath: String(selection?.oldPath || "").trim().replace(/\\/g, "/") || undefined,
        mode,
        hash: String(hash || "").trim() || undefined,
        hashes,
        selectionPaths: normalizedSelectionPaths,
        selectionKind: selection?.kind || (normalizedSelectionPaths.length > 1 ? "mixed" : "single"),
        selectionIndex: selectionIndex >= 0 ? selectionIndex : Math.max(0, Number(selection?.index || 0)),
      }, String(selection?.repoRoot || "").trim() || undefined);
    },
    [openDiffRequestAsync],
  );

  /**
   * 为回滚弹窗临时 Diff 浮层保存打开前的工作台 Diff 状态。
   * 这是对齐 IDEA“在当前流程里临时查看差异”的变通设计：当前产品没有独立的 Diff 窗口宿主，因此改为前置浮层并在关闭后恢复原状态。
   */
  const captureRollbackDiffOverlayRestoreSnapshot = useCallback((): void => {
    if (rollbackDiffOverlayRestoreRef.current) return;
    rollbackDiffOverlayRestoreRef.current = {
      diff,
      diffActiveLine,
      diffFullscreen,
      diffPinned,
      loadedDiffRequestSignature: loadedDiffRequestSignatureRef.current,
    };
  }, [diff, diffActiveLine, diffFullscreen, diffPinned]);

  /**
   * 关闭回滚弹窗专用的前置 Diff 浮层，并恢复打开前的工作台 Diff 状态。
   */
  const closeRollbackDiffOverlay = useCallback((): void => {
    const restoreSnapshot = rollbackDiffOverlayRestoreRef.current;
    rollbackDiffOverlayRestoreRef.current = null;
    setRollbackDiffOverlayOpen(false);
    if (!restoreSnapshot) {
      closeDiffPreview();
      return;
    }
    loadedDiffRequestSignatureRef.current = restoreSnapshot.loadedDiffRequestSignature;
    setDiff(restoreSnapshot.diff);
    setDiffActiveLine(restoreSnapshot.diffActiveLine);
    setDiffFullscreen(restoreSnapshot.diffFullscreen);
    setDiffPinned(restoreSnapshot.diffPinned);
  }, [closeDiffPreview]);

  /**
   * 从 rollback viewer 打开临时前置 Diff 浮层；成功后浮在当前弹窗之上，关闭时恢复原 Diff。
   */
  const openRollbackViewerDiffAsync = useCallback(async (entry: GitRollbackBrowserEntry): Promise<void> => {
    const pathText = String(entry.path || "").trim().replace(/\\/g, "/");
    if (!pathText) return;
    const mode = resolveCommitPreviewDiffMode(entry, localChangesConfig);
    const request: CommitDiffOpenRequest = {
      path: pathText,
      oldPath: String(entry.oldPath || "").trim().replace(/\\/g, "/") || undefined,
      mode,
      selectionPaths: [pathText],
      selectionKind: "single",
      selectionIndex: 0,
    };
    const requestSignature = buildCommitDiffRequestSignature(request);
    captureRollbackDiffOverlayRestoreSnapshot();
    await openDiffRequestAsync(request);
    if (loadedDiffRequestSignatureRef.current !== requestSignature) {
      rollbackDiffOverlayRestoreRef.current = null;
      return;
    }
    setDiffFullscreen(false);
    setDiffPinned(false);
    setRollbackDiffOverlayOpen(true);
  }, [captureRollbackDiffOverlayRestoreSnapshot, localChangesConfig, openDiffRequestAsync]);

  /**
   * 按提交树当前 lead node 构建真正的 Diff 请求；amend helper 节点需切到 commit diff 并绑定目标提交哈希。
   */
  const buildLeadCommitDiffRequest = useCallback((mode?: GitDiffMode): CommitDiffOpenRequest | null => {
    if (selectedLeadCommitNode?.entry && isCommitAmendNode(selectedLeadCommitNode) && commitAmendDetails?.hash) {
      return buildCommitNodeDiffOpenRequest({
        nodeKey: selectedLeadCommitNode.key,
        nodeMap: commitNodeByKey,
        localChangesConfig,
        mode: "commit",
        hash: commitAmendDetails.hash,
        hashes: [commitAmendDetails.hash],
      });
    }
    if (!selectedLeadCommitEntry) return null;
    return buildCommitDiffOpenRequest({
      entry: selectedLeadCommitEntry,
      selectedNodeKeys: selectedCommitSubtreeNodeKeys,
      nodeMap: commitNodeByKey,
      selectedEntries,
      allEntries: status?.entries || [],
      localChangesConfig,
      mode,
    });
  }, [
    commitAmendDetails?.hash,
    commitNodeByKey,
    localChangesConfig,
    selectedCommitSubtreeNodeKeys,
    selectedEntries,
    selectedLeadCommitEntry,
    selectedLeadCommitNode,
    status?.entries,
  ]);

  /**
   * 按具体树节点构建 Diff 请求；amend helper 节点与工作区节点共享调用口，但会自动切到 commit diff 模式。
   */
  const buildCommitNodeDiffRequest = useCallback((node: CommitPanelTreeNode): CommitDiffOpenRequest | null => {
    if (isCommitAmendNode(node) && commitAmendDetails?.hash) {
      return buildCommitNodeDiffOpenRequest({
        nodeKey: node.key,
        nodeMap: commitNodeByKey,
        localChangesConfig,
        mode: "commit",
        hash: commitAmendDetails.hash,
        hashes: [commitAmendDetails.hash],
      });
    }
    return buildCommitNodeDiffOpenRequest({
      nodeKey: node.key,
      nodeMap: commitNodeByKey,
      localChangesConfig,
    });
  }, [commitAmendDetails?.hash, commitNodeByKey, localChangesConfig]);

  /**
   * 从 interactive rebase 当前选中提交直接打开 diff，保持列表、详情与 diff 使用同一份选中上下文。
   */
  const openInteractiveRebaseDiffAsync = useCallback(async (): Promise<void> => {
    if (!interactiveRebaseDialogState?.selectedHash) return;
    const selectedHash = interactiveRebaseDialogState.selectedHash;
    const selectedDetails = interactiveRebaseDialogState.detailsByHash[selectedHash];
    if (!selectedDetails || selectedDetails.mode !== "single") return;
    const targetPath = resolveInteractiveRebaseDiffPath(
      selectedDetails,
      interactiveRebaseDialogState.selectedDiffPathByHash,
      selectedHash,
    );
    if (!targetPath) return;
    const selectionPaths = selectedDetails.detail.files.map((file) => file.path).filter(Boolean);
    const selectionIndex = Math.max(0, selectionPaths.indexOf(targetPath));
    await openDiffAsync(targetPath, "commit", selectedHash, [selectedHash], {
      paths: selectionPaths,
      kind: selectionPaths.length > 1 ? "change" : "single",
      index: selectionIndex,
    });
  }, [interactiveRebaseDialogState, openDiffAsync]);

  /**
   * 按统一交互配置执行提交面板文件打开动作，复用到主树、Browse、键盘快捷键三条链路。
   */
  const runCommitFileOpenActionAsync = useCallback(async (entry: GitStatusEntry, intent: "singleClick" | "enter" | "doubleClick" | "f4"): Promise<void> => {
    const action = resolveCommitOpenAction(viewOptions, intent, canOpenDiffForCommitEntry(entry));
    if (action === "diff") {
      const diffRequest = buildLeadCommitDiffRequest();
      if (!diffRequest) return;
      await openDiffRequestAsync(diffRequest);
      return;
    }
    if (action === "source") {
      await openSourceInIdeAsync(entry.path);
    }
  }, [buildLeadCommitDiffRequest, openDiffRequestAsync, openSourceInIdeAsync, viewOptions]);

  /**
   * 可编辑 Diff 的工作区文本变更回写（防抖写盘，避免频繁 I/O）。
   */
  const scheduleWriteWorkingFile = useCallback((pathText: string, content: string): void => {
    if (!repoRoot) return;
    const cleanPath = String(pathText || "").trim();
    if (!cleanPath) return;
    workingWritePayloadRef.current = { path: cleanPath, content: String(content ?? "") };
    if (workingWriteTimerRef.current) clearTimeout(workingWriteTimerRef.current);
    workingWriteTimerRef.current = setTimeout(() => {
      const payload = workingWritePayloadRef.current;
      workingWriteTimerRef.current = null;
      workingWritePayloadRef.current = null;
      if (!payload) return;
      void (async () => {
        const res = await writeWorkingFileAsync(repoRoot, payload.path, payload.content);
        if (!res.ok) setError(toErrorText(res.error, gt("workbench.stageThreeWay.writeWorkingFileFailed", "写入工作区文件失败")));
      })();
    }, 180);
  }, [repoRoot]);

  /**
   * 关闭统一冲突解决入口对话框，不影响已打开的单文件 merge 对话框。
   */
  const closeConflictResolverDialog = useCallback((): void => {
    const currentState = conflictResolverDialogState;
    conflictResolverLoadSeqRef.current += 1;
    conflictResolverAutoContinueKeyRef.current = "";
    setConflictResolverDialogState(null);
    if (!currentState?.sessionSnapshot || !shouldNotifyRemainingMergeConflicts(currentState.sessionSnapshot)) return;
    const operationState = String(statusRef.current?.operationState || "").trim();
    const reopenState = {
      ...currentState,
      selectedPath: currentState.sessionSnapshot.unresolvedEntries[0]?.path || currentState.selectedPath || "",
      checkedPaths: [],
      loading: true,
      applyingSide: null,
      sessionSnapshot: null,
    };
    finalizeGitNotice({
      action: "conflict.resolver",
      tone: "warn",
      message: buildRemainingMergeConflictNoticeMessage(operationState, gt),
      actions: [{
        id: `conflict-resolver-reopen:${Date.now()}`,
        label: gt("dialogs.multipleFileMerge.reopenAction", "继续处理冲突"),
        onClick: () => {
          conflictResolverAutoContinueKeyRef.current = "";
          setConflictResolverDialogState(reopenState);
        },
      }],
    });
  }, [conflictResolverDialogState, finalizeGitNotice]);

  /**
   * 打开统一冲突解决入口，并尽量保留调用方希望优先聚焦的冲突文件路径。
   */
  const openConflictResolverDialog = useCallback((options?: {
    title?: string;
    description?: string;
    scopeRepoRoot?: string;
    focusPath?: string;
    checkedPaths?: string[];
    reverseMerge?: boolean;
  }): void => {
    const scopeRepoRoot = normalizeRepoRelativePath(options?.scopeRepoRoot);
    const entries = filterConflictEntriesByScope(
      (statusRef.current?.entries || []).filter((entry) => entry.conflictState === "conflict"),
      scopeRepoRoot,
    );
    const resolvedCount = filterConflictEntriesByScope(
      (statusRef.current?.entries || []).filter((entry) => entry.conflictState === "resolved"),
      scopeRepoRoot,
    ).length;
    if (entries.length <= 0 && resolvedCount <= 0) {
      setError(gt("workbench.misc.conflicts.noEntries", "当前没有可处理的冲突文件"));
      return;
    }
    const focusPath = String(options?.focusPath || "").trim().replace(/\\/g, "/");
    const checkedPathSet = new Set(entries.map((entry) => entry.path));
    const checkedPaths = Array.from(new Set(
      (options?.checkedPaths || [])
        .map((pathText) => String(pathText || "").trim().replace(/\\/g, "/"))
        .filter((pathText) => checkedPathSet.has(pathText)),
    ));
    const selectedPath = entries.some((entry) => entry.path === focusPath)
      ? focusPath
      : (entries[0]?.path || "");
    conflictResolverAutoContinueKeyRef.current = "";
    setConflictResolverDialogState({
      title: options?.title || gt("workbench.misc.conflicts.title", "解决冲突"),
      description: options?.description || gt("workbench.misc.conflicts.dialogDescription", "统一查看当前仓库里的冲突文件，支持表格式合并/打开、目录分组，以及与提交面板共享的已解决冲突状态源。"),
      scopeRepoRoot: scopeRepoRoot || undefined,
      selectedPath,
      checkedPaths,
      sessionSnapshot: null,
      groupByDirectory: false,
      showResolved: resolvedCount > 0,
      loading: true,
      applyingSide: null,
      autoCloseWhenResolved: entries.length > 0,
      reverseMerge: options?.reverseMerge === true,
    });
  }, []);

  /**
   * 关闭统一问题对话框，并清理挂起的重试动作，避免旧问题上下文残留到下一次操作。
   */
  const closeOperationProblemDialog = useCallback((): void => {
    if (operationProblemSubmitting) return;
    const shouldRefresh = shouldRefreshAfterClosingOperationProblem(operationProblem);
    setOperationProblemDialogOpen(false);
    setOperationProblem(null);
    setOperationProblemSubmitting(false);
    operationProblemRetryRef.current = null;
    if (shouldRefresh)
      void refreshAllAsync({ keepLog: false });
  }, [operationProblem, operationProblemSubmitting, refreshAllAsync]);

  /**
   * 打开统一问题对话框；若调用方提供重试入口，则允许对话框动作直接回连到原始 Git 操作。
   */
  const openOperationProblemDialog = useCallback((
    problem: GitUpdateOperationProblem,
    retryAsync?: (payloadPatch: Record<string, any>) => Promise<void>,
  ): void => {
    const conflictResolverRequest = resolveOperationProblemConflictResolverRequest({
      problem,
      entries: statusRef.current?.entries || [],
      workspaceRepoRoot: repoRoot || undefined,
    });
    if (conflictResolverRequest) {
      operationProblemRetryRef.current = null;
      setOperationProblem(null);
      setOperationProblemSubmitting(false);
      setOperationProblemDialogOpen(false);
      openConflictResolverDialog({
        title: conflictResolverRequest.title,
        description: conflictResolverRequest.description,
        scopeRepoRoot: conflictResolverRequest.scopeRepoRoot,
        focusPath: conflictResolverRequest.focusPath,
        checkedPaths: conflictResolverRequest.checkedPaths,
      });
      return;
    }
    operationProblemRetryRef.current = retryAsync || null;
    setOperationProblem(problem);
    setOperationProblemSubmitting(false);
    setOperationProblemDialogOpen(true);
  }, [openConflictResolverDialog, repoRoot]);

  /**
   * 提交统一问题对话框中的用户决策；若当前问题只需查看，则会直接关闭对话框。
   */
  const submitOperationProblemDecisionAsync = useCallback(async (payloadPatch: Record<string, any>): Promise<void> => {
    const retryAsync = operationProblemRetryRef.current;
    if (!retryAsync) {
      closeOperationProblemDialog();
      return;
    }
    setOperationProblemSubmitting(true);
    try {
      await retryAsync(payloadPatch || {});
    } finally {
      setOperationProblemSubmitting(false);
    }
  }, [closeOperationProblemDialog]);

  /**
   * 在分支签出成功后统一补发智能签出提示，并串联回滚 / 冲突恢复 / 保存策略配置入口。
   */
  const finishBranchCheckoutAsync = useCallback(async (args: {
    requestId?: number;
    action: "branch.switch" | "branch.action";
    repoRootOverride?: string;
    targetBranch: string;
    previousBranch?: string;
    data?: any;
  }): Promise<void> => {
    await refreshAllAsync({ keepLog: false });
    const smartSwitchData = resolveSmartSwitchNoticeData(args.action, args.data);
    const feedback = buildSmartSwitchFeedback(smartSwitchData, args.targetBranch);
    if (!feedback) return;

    const actionRepoRoot = String(args.repoRootOverride || repoRoot || "").trim();
    const previousBranch = String(args.previousBranch || "").trim();
    const targetBranch = String(args.targetBranch || "").trim();
    const actions: GitNoticeActionItem[] = [];

    if (actionRepoRoot && previousBranch && previousBranch !== targetBranch) {
      actions.push({
        id: `smart-switch-rollback:${actionRepoRoot}:${previousBranch}`,
        label: gt("rollbackViewer.actions.rollback", "回滚"),
        onClick: async () => {
          /**
           * 执行智能签出 notice 里的回滚动作；若回滚再次命中覆盖问题，则继续走统一问题弹窗与重试闭环。
           */
          const submitRollbackAsync = async (payloadPatch?: Record<string, any>): Promise<void> => {
            const rollbackRes = await switchBranchAsync(actionRepoRoot, previousBranch, payloadPatch || {});
            if (!rollbackRes.ok) {
              const rollbackProblem = extractOperationProblem(rollbackRes.data);
              if (rollbackProblem) {
                openOperationProblemDialog(rollbackProblem, async (nextPayloadPatch) => {
                  await submitRollbackAsync(nextPayloadPatch);
                });
                return;
              }
              setError(toErrorText(rollbackRes.error, gitWorkbenchText("workbench.branch.rollbackToBranchFailed", "回滚到分支 '{{branch}}' 失败", { branch: previousBranch })));
              return;
            }
            const rollbackSmartData = resolveSmartSwitchNoticeData("branch.switch", rollbackRes.data);
            if (buildSmartSwitchFeedback(rollbackSmartData, previousBranch)) {
              await finishBranchCheckoutAsync({
                requestId: rollbackRes.meta?.requestId,
                action: "branch.switch",
                repoRootOverride: actionRepoRoot,
                targetBranch: previousBranch,
                previousBranch: targetBranch,
                data: rollbackRes.data,
              });
              return;
            }
            await refreshAllAsync({ keepLog: false });
            finalizeGitNotice({
              requestId: rollbackRes.meta?.requestId,
              action: "branch.switch",
              tone: "info",
              message: gitWorkbenchText("workbench.branch.returnedToBranch", "已回到分支 '{{branch}}'", { branch: previousBranch }),
            });
          };

          await submitRollbackAsync();
        },
      });
    }

    const resolveConflictsAction = smartSwitchData?.preservingState?.resolveConflictsAction;
    if (resolveConflictsAction?.kind === "resolve-conflicts") {
      actions.push({
        id: `smart-switch-resolve:${String(resolveConflictsAction.repoRoot || actionRepoRoot || "").trim() || targetBranch}`,
        label: String(resolveConflictsAction.label || "").trim() || gt("workbench.misc.conflicts.resolveAction", "处理冲突"),
        onClick: () => {
          const targetRepoRoot = String(resolveConflictsAction.repoRoot || resolveConflictsAction.payload?.repoRoot || actionRepoRoot).trim();
          if (!targetRepoRoot) {
            setError(gt("workbench.updateResult.conflictRepoUnavailable", "当前结果未提供冲突所属仓库"));
            return;
          }
          openConflictResolverDialog({
          title: gt("workbench.misc.conflicts.restoreSavedChangesTitle", "恢复已保存改动时发现冲突"),
          description: String(resolveConflictsAction.payload?.description || "").trim() || gt("workbench.misc.conflicts.restoreSavedChangesDescription", "请先解决恢复本地改动时产生的冲突。"),
            scopeRepoRoot: targetRepoRoot,
            reverseMerge: resolveConflictsAction.payload?.reverseMerge === true,
          });
        },
      });
    }

    actions.push(...buildPreservingNoticeActions(smartSwitchData));
    actions.push({
      id: `smart-switch-configure:${actionRepoRoot || targetBranch}`,
      label: gt("workbench.common.configure", "配置..."),
      onClick: async () => {
        const targetRepoRoot = actionRepoRoot || String(repoRoot || "").trim();
        if (!targetRepoRoot) return;
        const res = await getUpdateOptionsAsync(targetRepoRoot);
        if (!res.ok || !res.data) {
          setError(getErrorText(res.error, "workbench.updateOptions.loadFailed", "读取 Update Options 失败"));
          return;
        }
        setUpdateOptionsSnapshot(res.data);
        setUpdateOptionsDialogOpen(true);
      },
    });

    const dedupedActions = actions.filter((action, index, list) => {
      return list.findIndex((candidate) => candidate.id === action.id) === index;
    });

    finalizeGitNotice({
      requestId: args.requestId,
      action: args.action,
      tone: feedback.tone,
      message: feedback.message,
      actions: dedupedActions.length > 0 ? dedupedActions : undefined,
    });
  }, [buildPreservingNoticeActions, finalizeGitNotice, getUpdateOptionsAsync, openConflictResolverDialog, openOperationProblemDialog, refreshAllAsync, repoRoot, switchBranchAsync]);

  /**
   * 按当前选择构造手动搁置请求，并统一提交到主进程，确保 manual shelf 不再退化为整仓搁置。
   */
  const createManualShelveRecordAsync = useCallback(async (message: string, changeListIdHint?: string): Promise<void> => {
    if (!repoRoot) return;
    const changeListContext = resolveManualShelveChangeListContext(changeListIdHint);
    const selection = buildManualShelveSelection({
      selectedEntries,
      statusEntries: status?.entries || [],
      changeListsEnabled: localChangesConfig.changeListsEnabled && !localChangesConfig.stagingAreaEnabled,
      targetChangeListId: changeListContext.id,
      targetChangeListName: changeListContext.name,
    });
    const res = await createShelveAsync(repoRoot, message, selection);
    if (!res.ok) {
      setError(toErrorText(res.error, gt("workbench.shelf.createFailed", "创建搁置失败")));
      return;
    }
    await refreshAllAsync({ keepLog: true });
  }, [
    buildManualShelveSelection,
    localChangesConfig.changeListsEnabled,
    localChangesConfig.stagingAreaEnabled,
    refreshAllAsync,
    repoRoot,
    resolveManualShelveChangeListContext,
    selectedEntries,
    status?.entries,
  ]);

  /**
   * 打开 shelf 恢复对话框，并以当前记录内容初始化 partial unshelve 选项。
   */
  const openShelfRestoreDialog = useCallback((shelf: GitShelfItem, preferredSelectedPaths?: string[]): void => {
    const availablePaths = Array.from(new Set(
      (shelf.paths || [])
        .map((item) => String(item || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ));
    const selectedPaths = (() => {
      const normalizedPreferred = Array.from(new Set(
        (preferredSelectedPaths || [])
          .map((item) => String(item || "").trim().replace(/\\/g, "/"))
          .filter(Boolean),
      ));
      if (normalizedPreferred.length <= 0) return availablePaths;
      const selected = normalizedPreferred.filter((item) => availablePaths.includes(item));
      return selected.length > 0 ? selected : availablePaths;
    })();
    setShelfRestoreDialogShelf(shelf);
    setShelfRestoreDialogValue({
      selectedPaths,
      targetChangeListId: localChangesConfig.changeListsEnabled && !localChangesConfig.stagingAreaEnabled
        ? activeChangeListId
        : "",
      removeAppliedFromShelf: true,
    });
    setShelfRestoreDialogSubmitting(false);
    setShelfRestoreDialogOpen(true);
  }, [activeChangeListId, localChangesConfig.changeListsEnabled, localChangesConfig.stagingAreaEnabled]);

  /**
   * 关闭 shelf 恢复对话框并清理临时状态，避免旧选择串到下一条记录。
   */
  const closeShelfRestoreDialog = useCallback((): void => {
    if (shelfRestoreDialogSubmitting) return;
    setShelfRestoreDialogOpen(false);
    setShelfRestoreDialogShelf(null);
    setShelfRestoreDialogValue({
      selectedPaths: [],
      targetChangeListId: "",
      removeAppliedFromShelf: true,
    });
  }, [shelfRestoreDialogSubmitting]);

  /**
   * 提交当前 shelf 恢复请求，统一承接 partial unshelve、目标更改列表和 remove policy。
   */
  const submitShelfRestoreDialogAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot || !shelfRestoreDialogShelf) return;
    const selectedPaths = Array.from(new Set(
      (shelfRestoreDialogValue.selectedPaths || [])
        .map((item) => String(item || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ));
    if (selectedPaths.length <= 0) {
      setError(gt("workbench.shelf.restoreSelectionRequired", "请至少选择一个需要取消搁置的文件"));
      return;
    }
    setShelfRestoreDialogSubmitting(true);
    await runShelfEntryActionAsync({
      repoRoot,
      shelf: shelfRestoreDialogShelf,
      action: "restore",
      options: {
        selectedPaths,
        targetChangeListId: String(shelfRestoreDialogValue.targetChangeListId || "").trim() || undefined,
        removeAppliedFromShelf: shelfRestoreDialogValue.removeAppliedFromShelf,
      },
      translate: gt,
      restoreShelveAsync,
      deleteShelveAsync,
      refreshAllAsync,
      openConflictResolverDialog,
      isLikelyConflictErrorText,
      setError,
      formatError: toErrorText,
    });
    setShelfRestoreDialogSubmitting(false);
    setShelfRestoreDialogOpen(false);
    setShelfRestoreDialogShelf(null);
  }, [
    deleteShelveAsync,
    openConflictResolverDialog,
    refreshAllAsync,
    repoRoot,
    shelfRestoreDialogShelf,
    shelfRestoreDialogValue,
  ]);

  /**
   * 统一处理左侧 shelf 面板动作，恢复时先显式收集 restore 选项，删除仍走直接路径。
   */
  const handleShelfEntryActionAsync = useCallback(async (
    shelf: GitShelfItem,
    action: "restore" | "delete",
  ): Promise<void> => {
    if (!repoRoot) return;
    if (action === "restore") {
      openShelfRestoreDialog(shelf);
      return;
    }
    await runShelfEntryActionAsync({
      repoRoot,
      shelf,
      action,
      translate: gt,
      restoreShelveAsync,
      deleteShelveAsync,
      refreshAllAsync,
      openConflictResolverDialog,
      isLikelyConflictErrorText,
      setError,
      formatError: toErrorText,
      onDeleteSuccess: async (deletedShelf) => {
        const deletedLabel = deletedShelf.message || deletedShelf.displayName || deletedShelf.ref;
        finalizeGitNotice({
          action: "shelf.delete",
          tone: "info",
          message: gt("workbench.shelf.deletedNotice", "已删除搁置 {{label}}", { label: deletedLabel }),
          actions: [{
            id: `shelf-delete-undo:${deletedShelf.ref}:${Date.now()}`,
            label: gt("workbench.shelf.undoDelete", "撤销删除"),
            onClick: async () => {
              const restoreRes = await restoreArchivedShelveAsync(repoRoot, deletedShelf.ref);
              if (!restoreRes.ok) {
                setError(toErrorText(restoreRes.error, gt("workbench.shelf.restoreFailed", "恢复搁置记录失败")));
                return;
              }
              await refreshAllAsync({ keepLog: true });
              finalizeGitNotice({
                action: "shelf.delete.undo",
                tone: "info",
                message: gt("workbench.shelf.restoredNotice", "已恢复搁置记录 {{label}}", { label: deletedLabel }),
              });
            },
          }],
        });
      },
    });
  }, [finalizeGitNotice, gt, openConflictResolverDialog, openShelfRestoreDialog, refreshAllAsync, repoRoot]);

  /**
   * 从本地选择 Patch 文件导入统一 shelf 平台，保持外部补丁也能进入同一套恢复与回收流程。
   */
  const handleImportShelfPatchFilesAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot) return;
    const chooseRes = await window.host.utils.chooseFiles({
      title: gt("workbench.shelf.importPatchTitle", "导入 Patch 到搁置列表"),
      multiSelections: true,
      filters: [
        { name: "Patch Files", extensions: ["patch", "diff"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (!chooseRes.ok) {
      if (chooseRes.canceled !== true) setError(toErrorText(chooseRes.error, gt("workbench.shelf.choosePatchFailed", "选择 Patch 文件失败")));
      return;
    }
    const filePaths = Array.from(new Set(
      (Array.isArray(chooseRes.paths) ? chooseRes.paths : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ));
    if (filePaths.length <= 0) return;
    const res = await importShelvePatchFilesAsync(repoRoot, filePaths);
    if (!res.ok) {
      setError(toErrorText(res.error, gt("workbench.shelf.importPatchFailed", "导入 Patch 失败")));
      return;
    }
    setLeftTab("shelve");
    await refreshAllAsync({ keepLog: true });
    const failed = Array.isArray(res.data?.failed) ? res.data.failed : [];
    const importedCount = Math.max(0, filePaths.length - failed.length);
    if (failed.length > 0) {
      finalizeGitNotice({
        action: "shelf.import",
        tone: "warn",
        message: gitWorkbenchText("workbench.shelf.importPatchWithFailures", "已导入 {{importedCount}} 个 Patch，另有 {{failedCount}} 个文件导入失败", {
          importedCount,
          failedCount: failed.length,
        }),
      });
      setError(failed.map((item) => `${item.path}: ${item.error}`).join("\n"));
      return;
    }
    finalizeGitNotice({
      action: "shelf.import",
      tone: "info",
      message: gitWorkbenchText("workbench.shelf.importPatchDone", "已导入 {{count}} 个 Patch 到搁置列表", { count: importedCount }),
    });
  }, [finalizeGitNotice, refreshAllAsync, repoRoot]);

  /**
   * 保存 shelf 面板视图状态，并在持久化成功后刷新列表以同步 showRecycled/groupByDirectory 结果。
   */
  const updateShelfViewStateAsync = useCallback(async (patch: Partial<GitShelfViewState>): Promise<void> => {
    if (!repoRoot) return;
    const previousState = shelfViewState;
    const nextState: GitShelfViewState = {
      showRecycled: patch.showRecycled ?? previousState.showRecycled,
      groupByDirectory: patch.groupByDirectory ?? previousState.groupByDirectory,
    };
    setShelfViewState(nextState);
    const res = await saveShelfViewStateAsync(repoRoot, nextState);
    if (!res.ok) {
      setShelfViewState(previousState);
      setError(toErrorText(res.error, gt("workbench.shelf.viewStateSaveFailed", "保存搁置视图状态失败")));
      return;
    }
    const persistedState = res.data?.viewState || nextState;
    setShelfViewState(persistedState);
    if (persistedState.showRecycled !== previousState.showRecycled) {
      await refreshAllAsync({ keepLog: true });
    }
  }, [refreshAllAsync, repoRoot, shelfViewState]);

  /**
   * 按 AGENTS.md 的 Git 面板对齐规则，Shelf 的“显示差异 / 在新标签页中显示差异 / 与本地比较”
   * 统一映射到现有 GitWorkbench + Monaco Diff 宿主；其中“新标签页”用 pinned/fullscreen 作为 IDEA 标签页的等价变通实现。
   */
  const runShelfDiffActionAsync = useCallback(async (
    shelf: GitShelfItem,
    selectedPaths: string[],
    action: "showDiff" | "showStandaloneDiff" | "compareWithLocal",
  ): Promise<void> => {
    if (!repoRoot) return;
    const shelfRef = String(shelf.ref || "").trim();
    const normalizedPaths = Array.from(new Set(
      (selectedPaths || [])
        .map((one) => String(one || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ));
    const primaryPath = normalizedPaths[0] || "";
    if (!shelfRef || !primaryPath) return;
    const request: CommitDiffOpenRequest = {
      path: primaryPath,
      mode: action === "compareWithLocal" ? "shelfToWorking" : "shelf",
      shelfRef,
      selectionPaths: normalizedPaths,
      selectionKind: normalizedPaths.length > 1 ? "change" : "single",
      selectionIndex: 0,
    };
    setActiveSelectionScope(null);
    if (action === "showStandaloneDiff") {
      await openPinnedDiffRequestAsync(request);
      return;
    }
    await openDiffRequestAsync(request);
  }, [openDiffRequestAsync, openPinnedDiffRequestAsync, repoRoot]);

  /**
   * 按 AGENTS.md 的 Git 面板对齐规则，Shelf 的 Create Patch / Copy Patch 复用现有补丁导出链路；
   * 多文件选择会逐文件读取 shelf patch 后再聚合导出，而不是新增 IDEA 原生 patch 对话框宿主。
   */
  const exportShelfPatchSelectionAsync = useCallback(async (
    shelf: GitShelfItem,
    selectedPaths: string[],
    mode: "save" | "clipboard",
  ): Promise<void> => {
    if (!repoRoot) return;
    const shelfRef = String(shelf.ref || "").trim();
    const normalizedPaths = Array.from(new Set(
      (selectedPaths || [])
        .map((one) => String(one || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ));
    if (!shelfRef || normalizedPaths.length <= 0) return;
    const patchChunks: string[] = [];
    for (const targetPath of normalizedPaths) {
      const res = await getDiffPatchAsync(repoRoot, {
        path: targetPath,
        mode: "shelf",
        shelfRef,
      });
      if (!res.ok) {
        setError(toErrorText(res.error, gt("workbench.shelf.createPatchFailed", "创建搁置补丁失败")));
        return;
      }
      const patchText = String(res.data?.patch || "");
      if (patchText.trim()) patchChunks.push(patchText);
    }
    if (patchChunks.length <= 0) {
      setError(gt("workbench.shelf.noPatchToExport", "当前选择未生成可导出的补丁"));
      return;
    }
    await exportPatchTextAsync(patchChunks.join("\n"), {
      mode,
      defaultPath: buildPatchExportFileName({ paths: normalizedPaths }),
    });
  }, [exportPatchTextAsync, repoRoot]);

  /**
   * 统一执行 shelf 的重命名/回收/恢复列表/彻底删除动作，保持所有入口都复用同一条 IPC 链路。
   */
  const runShelfManagementActionAsync = useCallback(async (
    shelf: GitShelfItem,
    action: "rename" | "recycle" | "restoreArchived" | "deleteForever",
  ): Promise<void> => {
    if (!repoRoot) return;
    if (action === "rename") {
      const form = await openActionDialogAsync({
        title: gt("workbench.shelf.renameTitle", "重命名搁置记录"),
        description: gitWorkbenchText("workbench.shelf.modifyDescription", "修改 {{ref}} 的展示说明。", { ref: shelf.ref }),
        confirmText: gt("workbench.common.save", "保存"),
        fields: [{ key: "message", label: gt("actionDialogs.shelveChanges.messageLabel", "说明"), required: true }],
        defaults: { message: shelf.message || shelf.displayName || shelf.ref },
      });
      if (!form) return;
      const res = await renameShelveAsync(repoRoot, shelf.ref, String(form.message || "").trim());
      if (!res.ok) {
        setError(toErrorText(res.error, gt("workbench.shelf.renameFailed", "重命名搁置失败")));
        return;
      }
      await refreshAllAsync({ keepLog: true });
      return;
    }
    if (action === "recycle") {
      const res = await recycleShelveAsync(repoRoot, shelf.ref);
      if (!res.ok) {
        setError(toErrorText(res.error, gt("workbench.shelf.recycleFailed", "移动搁置到回收区失败")));
        return;
      }
      await refreshAllAsync({ keepLog: true });
      return;
    }
    if (action === "restoreArchived") {
      const res = await restoreArchivedShelveAsync(repoRoot, shelf.ref);
      if (!res.ok) {
        setError(toErrorText(res.error, gt("workbench.shelf.restoreArchivedFailed", "恢复搁置记录失败")));
        return;
      }
      await refreshAllAsync({ keepLog: true });
      return;
    }
    const confirmed = await openActionDialogAsync({
      title: gt("workbench.shelf.deleteForeverTitle", "彻底删除搁置记录"),
      description: gitWorkbenchText("workbench.shelf.deleteDescription", "将永久移除 {{ref}}，且无法再从回收区恢复。", { ref: shelf.ref }),
      confirmText: gt("workbench.shelf.deleteForeverConfirm", "永久删除"),
      fields: [],
    });
    if (!confirmed) return;
    const res = await deleteShelveAsync(repoRoot, shelf.ref, true);
    if (!res.ok) {
      setError(toErrorText(res.error, gt("workbench.shelf.deleteForeverFailed", "彻底删除搁置失败")));
      return;
    }
    await refreshAllAsync({ keepLog: true });
  }, [openActionDialogAsync, refreshAllAsync, repoRoot]);

  /**
   * 统一创建当前仓库的 stash 记录，并显式暴露 keep-index / include-untracked 选项。
   */
  const openCreateStashDialogAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot) return;
    const form = await openActionDialogAsync({
      title: gt("workbench.stash.createTitle", "创建暂存"),
      description: gt("workbench.stash.createDescription", "为当前仓库创建新的 stash，并可选择是否保留暂存区或包含未跟踪文件。"),
      confirmText: gt("workbench.stash.createConfirm", "创建暂存"),
      fields: [
        {
          key: "message",
          label: gt("actionDialogs.shelveChanges.messageLabel", "说明"),
          placeholder: gt("workbench.stash.createMessagePlaceholder", "临时保存当前改动"),
        },
        {
          key: "includeUntracked",
          label: gt("workbench.stash.includeUntracked", "包含未跟踪文件"),
          type: "checkbox",
          description: gt("workbench.stash.includeUntrackedDescription", "对齐 `git stash push --include-untracked`，同时保存当前未跟踪文件。"),
        },
        {
          key: "keepIndex",
          label: gt("workbench.stash.keepIndex", "保留暂存区内容"),
          type: "checkbox",
          description: gt("workbench.stash.keepIndexDescription", "对齐 `git stash push --keep-index`，仅把工作区改动压入 stash。"),
        },
      ],
      defaults: {
        message: "",
        includeUntracked: "false",
        keepIndex: "false",
      },
      width: "wide",
    });
    if (!form) return;
    const result = await createStashAsync(
      repoRoot,
      String(form.message || "").trim(),
      form.includeUntracked === "true",
      undefined,
      {
        keepIndex: form.keepIndex === "true",
      },
    );
    if (!result.ok) {
      setError(toErrorText(result.error, gt("workbench.stash.createFailed", "创建暂存失败")));
      return;
    }
    const warningText = String(result.data?.warning || "").trim();
    if (warningText) {
      finalizeGitNotice({
        action: "stash.create",
        tone: "warn",
        message: warningText,
      });
    }
    await refreshAllAsync({ keepLog: true });
  }, [finalizeGitNotice, openActionDialogAsync, refreshAllAsync, repoRoot]);

  /**
   * 统一处理左侧 stash 面板动作，按动作类型显式收集 reinstate-index 或 branch 参数。
   */
  const handleStashEntryActionAsync = useCallback(async (
    stash: GitStashItem,
    action: "apply" | "pop" | "branch" | "drop",
  ): Promise<void> => {
    if (!repoRoot) return;
    let options: { reinstateIndex?: boolean; branchName?: string } | undefined;
    if (action === "branch") {
      const form = await openActionDialogAsync({
        title: gt("workbench.stash.branchTitle", "恢复暂存为分支"),
        description: gt("workbench.stash.branchDescription", "基于 {{ref}} 创建并切换到新分支，对齐 `git stash branch` 语义。", { ref: stash.ref }),
        confirmText: gt("workbench.stash.branchConfirm", "恢复为分支"),
        fields: [{
          key: "branchName",
          label: gt("workbench.stash.branchNameLabel", "新分支名"),
          placeholder: gt("workbench.stash.branchNamePlaceholder", "feature/unstash"),
          required: true,
        }],
      });
      if (!form) return;
      options = {
        branchName: String(form.branchName || "").trim(),
      };
      if (!options.branchName) {
        setError(gt("workbench.stash.branchNameRequired", "分支名不能为空"));
        return;
      }
    } else if (action === "apply" || action === "pop") {
      const form = await openActionDialogAsync({
        title: action === "pop" ? gt("workbench.stash.popTitle", "恢复暂存") : gt("workbench.stash.applyTitle", "应用暂存"),
        description: action === "pop"
          ? gt("workbench.stash.popDescription", "恢复 {{ref}}，并可选择是否同时恢复暂存区内容。", { ref: stash.ref })
          : gt("workbench.stash.applyDescription", "应用 {{ref}}，并可选择是否同时恢复暂存区内容。", { ref: stash.ref }),
        confirmText: action === "pop" ? gt("workbench.stash.popConfirm", "恢复暂存") : gt("workbench.stash.applyConfirm", "应用暂存"),
        fields: [{
          key: "reinstateIndex",
          label: gt("workbench.stash.reinstateIndex", "同时恢复暂存区内容"),
          type: "checkbox",
          description: gt("workbench.stash.reinstateIndexDescription", "对齐 `git stash apply/pop --index`，恢复工作区与 Index 两侧内容。"),
        }],
        defaults: {
          reinstateIndex: "false",
        },
      });
      if (!form) return;
      options = {
        reinstateIndex: form.reinstateIndex === "true",
      };
    }
    await runStashEntryActionAsync({
      repoRoot,
      stash,
      action,
      options,
      translate: gt,
      applyStashAsync,
      dropStashAsync,
      refreshAllAsync,
      openConflictResolverDialog,
      isLikelyConflictErrorText,
      setError,
      formatError: toErrorText,
    });
  }, [gt, openActionDialogAsync, openConflictResolverDialog, refreshAllAsync, repoRoot]);

  /**
   * 切换统一冲突入口里当前聚焦的冲突文件，供列表单击与刷新恢复共用。
   */
  const selectConflictResolverPath = useCallback((pathText: string): void => {
    const cleanPath = String(pathText || "").trim().replace(/\\/g, "/");
    setConflictResolverDialogState((prev) => prev ? { ...prev, selectedPath: cleanPath } : prev);
  }, []);

  /**
   * 切换统一冲突入口中的批量勾选集合，默认保持当前选中行不变，便于继续逐个检查。
   */
  const toggleConflictResolverCheckedPath = useCallback((pathText: string, checked: boolean): void => {
    const cleanPath = String(pathText || "").trim().replace(/\\/g, "/");
    if (!cleanPath) return;
    setConflictResolverDialogState((prev) => {
      if (!prev) return prev;
      const nextSet = new Set(prev.checkedPaths);
      if (checked) nextSet.add(cleanPath);
      else nextSet.delete(cleanPath);
      return {
        ...prev,
        checkedPaths: Array.from(nextSet),
        selectedPath: prev.selectedPath || cleanPath,
      };
    });
  }, []);

  /**
   * 统一切换所有未解决冲突的勾选状态，供批量采用 ours/theirs 动作快速复用。
   */
  const toggleAllConflictResolverCheckedPaths = useCallback((checked: boolean): void => {
    setConflictResolverDialogState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        checkedPaths: checked ? (prev.sessionSnapshot?.unresolvedEntries || []).map((entry) => entry.path) : [],
      };
    });
  }, []);

  /**
   * 切换冲突表的目录分组视图；仅影响显示结构，不改当前 session 快照。
   */
  const toggleConflictResolverGroupByDirectory = useCallback((): void => {
    setConflictResolverDialogState((prev) => prev ? { ...prev, groupByDirectory: !prev.groupByDirectory } : prev);
  }, []);

  /**
   * 切换 resolved conflict 的可见性；隐藏后会自动把焦点回退到 unresolved 列表。
   */
  const toggleConflictResolverResolvedVisibility = useCallback((): void => {
    setConflictResolverDialogState((prev) => prev ? { ...prev, showResolved: !prev.showResolved } : prev);
  }, []);

  /**
   * 把 resolver 焦点切到下一个未解决文件，形成 closer to IDEA 的 resolver 回跳闭环。
   */
  const selectNextConflictResolverPath = useCallback((): void => {
    setConflictResolverDialogState((prev) => {
      if (!prev || (prev.sessionSnapshot?.unresolvedCount || 0) <= 1) return prev;
      const nextPath = resolveNextMergeConflictPath(prev.sessionSnapshot, prev.selectedPath);
      return {
        ...prev,
        selectedPath: nextPath || prev.selectedPath,
      };
    });
  }, []);

  /**
   * 当 resolver 打开且未解决列表变化时刷新元数据，确保 binary/过大/反转 sides 状态始终基于最新仓库状态。
   */
  useEffect(() => {
    if (!repoRoot || !conflictResolverDialogState) return;
    const targetRepoRoot = resolveScopedRepoRoot(repoRoot, conflictResolverScopeRepoRoot);
    const requestSeq = conflictResolverLoadSeqRef.current + 1;
    conflictResolverLoadSeqRef.current = requestSeq;
    const unresolvedPaths = conflictResolverScopedEntries
      .map((entry) => resolveScopedRepoRelativePath(entry.path, conflictResolverScopeRepoRoot))
      .filter(Boolean);
    setConflictResolverDialogState((prev) => prev ? { ...prev, loading: true } : prev);
    void (async () => {
      const res = await getConflictResolverEntriesAsync(targetRepoRoot, unresolvedPaths, {
        reverse: conflictResolverDialogState.reverseMerge === true,
      });
      if (conflictResolverLoadSeqRef.current !== requestSeq) return;
      if (!res.ok || !res.data) {
        setConflictResolverDialogState((prev) => prev ? { ...prev, loading: false } : prev);
        setError(toErrorText(res.error, gt("workbench.misc.conflicts.tableLoadFailed", "读取冲突表失败")));
        return;
      }
      setConflictResolverDialogState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          loading: false,
          sessionSnapshot: res.data || null,
        };
      });
    })();
  }, [
    conflictResolverDialogState?.reverseMerge,
    conflictResolverScopeRepoRoot,
    conflictResolverScopedEntries,
    repoRoot,
  ]);

  /**
   * 按指定路径集合直接采用 ours/theirs，供树右键快捷动作与 resolver 对话框复用同一后端链路。
   */
  const applyConflictResolverSideByPathsAsync = useCallback(async (
    side: "ours" | "theirs",
    options: {
      paths: string[];
      scopeRepoRoot?: string;
      reverse?: boolean;
      failureActionText?: string;
    },
  ): Promise<boolean> => {
    if (!repoRoot) return false;
    const targetRepoRoot = resolveScopedRepoRoot(repoRoot, options.scopeRepoRoot);
    const targetPaths = Array.from(new Set(
      options.paths
        .map((pathText) => resolveScopedRepoRelativePath(pathText, options.scopeRepoRoot))
        .filter(Boolean),
    ));
    if (targetPaths.length <= 0) return false;
    const res = await applyConflictResolverSideApiAsync(targetRepoRoot, {
      paths: targetPaths,
      side,
      reverse: options.reverse === true,
    });
    if (!res.ok) {
      const failureActionText = String(options.failureActionText || gitWorkbenchText(
        "workbench.misc.conflicts.applySide",
        "采用 {{side}}",
        { side: side === "ours" ? "ours" : "theirs" },
      )).trim();
      setError(toErrorText(res.error, gitWorkbenchText("workbench.misc.conflicts.applySideFailed", "{{action}}失败", { action: failureActionText })));
      return false;
    }
    await refreshAllAsync({ keepLog: false });
    return true;
  }, [refreshAllAsync, repoRoot]);

  /**
   * 批量采用 ours/theirs 并刷新工作台，让 resolver 在动作完成后自动回到剩余未解决冲突。
   */
  const applyConflictResolverSideFromDialogAsync = useCallback(async (side: "ours" | "theirs"): Promise<void> => {
    if (!conflictResolverDialogState) return;
    const targetPaths = resolveEffectiveMergeConflictPaths({
      snapshot: conflictResolverDialogState.sessionSnapshot,
      selectedPath: conflictResolverDialogState.selectedPath,
      checkedPaths: conflictResolverDialogState.checkedPaths,
    });
    if (targetPaths.length <= 0) return;
    setConflictResolverDialogState((prev) => prev ? { ...prev, applyingSide: side } : prev);
    const applied = await applyConflictResolverSideByPathsAsync(side, {
      paths: targetPaths,
      scopeRepoRoot: conflictResolverDialogState.scopeRepoRoot,
      reverse: conflictResolverDialogState.reverseMerge === true,
      failureActionText: gitWorkbenchText("dialogs.multipleFileMerge.actions.acceptSideWithLabel", "接受{{label}}", { label: side === "ours" ? "Yours" : "Theirs" }),
    });
    if (!applied) {
      setConflictResolverDialogState((prev) => prev ? { ...prev, applyingSide: null } : prev);
      return;
    }
    setConflictResolverDialogState((prev) => prev ? { ...prev, checkedPaths: [], applyingSide: null } : prev);
  }, [applyConflictResolverSideByPathsAsync, conflictResolverDialogState]);

  /**
   * 关闭应用内冲突处理对话框，并让后续异步加载结果自动失效，避免旧请求回写新状态。
   */
  const closeConflictMergeDialog = useCallback((): void => {
    conflictMergeLoadSeqRef.current += 1;
    setConflictMergeDialogState(null);
  }, []);

  /**
   * 打开应用内冲突处理对话框，读取 base/ours/theirs/working 四份快照并初始化右侧编辑区。
   */
  const openConflictMergeDialogAsync = useCallback(async (
    pathText: string,
    options?: { reverse?: boolean; scopeRepoRoot?: string },
  ): Promise<void> => {
    if (!repoRoot) return;
    const cleanPath = String(pathText || "").trim().replace(/\\/g, "/");
    if (!cleanPath) return;
    const reverse = options?.reverse === true;
    const scopeRepoRoot = normalizeRepoRelativePath(options?.scopeRepoRoot);
    const targetRepoRoot = resolveScopedRepoRoot(repoRoot, scopeRepoRoot);
    const targetRelativePath = resolveScopedRepoRelativePath(cleanPath, scopeRepoRoot);
    if (!targetRepoRoot || !targetRelativePath) return;
    const requestSeq = conflictMergeLoadSeqRef.current + 1;
    conflictMergeLoadSeqRef.current = requestSeq;
    setConflictMergeDialogState({
      repoRoot: targetRepoRoot,
      relativePath: targetRelativePath,
      loading: true,
      saving: false,
      snapshot: null,
      reverse,
    });
    const res = await getConflictMergeSnapshotAsync(targetRepoRoot, targetRelativePath, { reverse });
    if (conflictMergeLoadSeqRef.current !== requestSeq) return;
    if (!res.ok || !res.data) {
      setConflictMergeDialogState(null);
      setError(getErrorText(res.error, "workbench.misc.conflicts.contentLoadFailed", "读取冲突内容失败"));
      return;
    }
    setConflictMergeDialogState({
      repoRoot: targetRepoRoot,
      relativePath: targetRelativePath,
      loading: false,
      saving: false,
      snapshot: res.data,
      reverse,
    });
  }, [repoRoot]);

  /**
   * 从统一冲突入口跳转到单文件应用内 merge；rebase 会自动反转 sides，unstash 可显式传 reverse。
   */
  const openSelectedConflictFromResolverAsync = useCallback(async (): Promise<void> => {
    const selectedEntry = getSelectedMergeConflictEntry(
      conflictResolverDialogState?.sessionSnapshot,
      String(conflictResolverDialogState?.selectedPath || ""),
    );
    if (!selectedEntry) return;
    if (selectedEntry.conflictState !== "unresolved" || !selectedEntry.canOpenMerge) {
      if (!repoRoot || !conflictResolverDialogState?.selectedPath) return;
      const targetRepoRoot = resolveScopedRepoRoot(repoRoot, conflictResolverDialogState.scopeRepoRoot);
      const targetRelativePath = resolveScopedRepoRelativePath(
        conflictResolverDialogState.selectedPath,
        conflictResolverDialogState.scopeRepoRoot,
      );
      if (!targetRepoRoot || !targetRelativePath) return;
      await openSourceInIdeAsync(targetRelativePath, targetRepoRoot);
      return;
    }
    const pathText = String(conflictResolverDialogState?.selectedPath || "").trim();
    if (!pathText) return;
    await openConflictMergeDialogAsync(pathText, {
      reverse: conflictResolverDialogState?.reverseMerge === true,
      scopeRepoRoot: conflictResolverDialogState?.scopeRepoRoot,
    });
  }, [conflictResolverDialogState, openConflictMergeDialogAsync, openSourceInIdeAsync, repoRoot]);

  /**
   * 把当前 resolver 选中文件交给外部 IDE 打开，作为 binary/过大冲突的首选 fallback。
   */
  const openSelectedConflictInIdeAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot || !conflictResolverDialogState?.selectedPath) return;
    const targetRepoRoot = resolveScopedRepoRoot(repoRoot, conflictResolverDialogState.scopeRepoRoot);
    const targetRelativePath = resolveScopedRepoRelativePath(
      conflictResolverDialogState.selectedPath,
      conflictResolverDialogState.scopeRepoRoot,
    );
    if (!targetRepoRoot || !targetRelativePath) return;
    await openSourceInIdeAsync(targetRelativePath, targetRepoRoot);
  }, [conflictResolverDialogState, openSourceInIdeAsync, repoRoot]);

  /**
   * 把当前 resolver 选中文件交给系统默认程序打开，作为无法应用内 merge 时的兜底入口。
   */
  const openSelectedConflictInSystemAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot || !conflictResolverDialogState?.selectedPath) return;
    const targetRepoRoot = resolveScopedRepoRoot(repoRoot, conflictResolverDialogState.scopeRepoRoot);
    const targetRelativePath = resolveScopedRepoRelativePath(
      conflictResolverDialogState.selectedPath,
      conflictResolverDialogState.scopeRepoRoot,
    );
    if (!targetRepoRoot || !targetRelativePath) return;
    await openRepoPathInSystemAsync(targetRelativePath, targetRepoRoot);
  }, [conflictResolverDialogState, openRepoPathInSystemAsync, repoRoot]);

  /**
   * 从 merge conflict manager 回到提交面板冲突视图，并尽量保留当前文件选区。
   */
  const showMergeConflictInCommitPanel = useCallback((): void => {
    if (leftCollapsed) setLeftCollapsed(false);
    setLeftTab("commit");
    const pathText = String(conflictResolverDialogState?.selectedPath || "").trim();
    if (pathText) {
      setSelectedPaths([pathText]);
      setExactlySelectedPaths([pathText]);
    }
    closeConflictResolverDialog();
  }, [closeConflictResolverDialog, conflictResolverDialogState?.selectedPath, leftCollapsed]);

  /**
   * 按指定提交消息直接切入 Cherry-pick 提交收尾模式，供“应用冲突后自动分析”与显式继续按钮共用。
   */
  const enterCherryPickCommitCompletionModeWithMessage = useCallback((message: string, options?: {
    closeResolver?: boolean;
    focusEditor?: boolean;
  }): boolean => {
    const suggestedMessage = String(message || "").trim();
    if (!suggestedMessage) return false;
    if (options?.closeResolver === true)
      closeConflictResolverDialog();
    if (suggestedMessage !== commitMessageValueRef.current) {
      setCommitMessage(suggestedMessage);
      if (typeof window !== "undefined")
        writeLastCommitMessage(window.localStorage, suggestedMessage);
    }
    activateCommitWorkflow({
      focusEditor: options?.focusEditor !== false,
    });
    return true;
  }, [activateCommitWorkflow, closeConflictResolverDialog]);

  /**
   * 在应用内 merge 已把文件写回并 `git add` 之后，按 IDEA `GitConflictResolver#proceedAfterAllMerged`
   * 的收尾语义直接继续当前 Git 操作；后续是否还能继续、是否再次冲突、是否已自动结束，统一以后端真实仓库状态为准。
   */
  const continueResolvedOperationAsync = useCallback(async (
    targetRepoRoot: string,
    options?: {
      dedupeKey?: string;
      closeResolver?: boolean;
    },
  ): Promise<void> => {
    const normalizedTargetRepoRoot = normalizeCommitRepoRoot(targetRepoRoot);
    if (!normalizedTargetRepoRoot) return;
    if (options?.dedupeKey) {
      if (conflictResolverAutoContinueKeyRef.current === options.dedupeKey) return;
      conflictResolverAutoContinueKeyRef.current = options.dedupeKey;
    }
    if (options?.closeResolver) closeConflictResolverDialog();
    const res = await continueRepositoryOperationAsync(normalizedTargetRepoRoot);
    if (res.ok || res.data?.shouldRefresh === true) {
      await refreshAllAsync({ keepLog: false });
    }
    if (res.data?.requiresCommitCompletion === true) {
      const suggestedMessage = String(res.data?.operationSuggestedCommitMessage || "").trim();
      if (enterCherryPickCommitCompletionModeWithMessage(suggestedMessage, { closeResolver: true, focusEditor: true }))
        return;
    }
    if (!res.ok) {
      const nextOperationProblem = extractOperationProblem(res.data);
      const operationFailureFeedback = resolveOperationControlFailureFeedback({
        control: "continue",
        error: res.error,
        data: res.data,
      });
      if (nextOperationProblem) {
        setError("");
        removeGitNoticeByRequestId(res.meta?.requestId);
        openOperationProblemDialog(nextOperationProblem);
        return;
      }
      if (operationFailureFeedback) {
        setError("");
        removeGitNoticeByRequestId(res.meta?.requestId);
        return;
      }
      finalizeGitNotice({
        requestId: res.meta?.requestId,
        action: "operation.continue",
        tone: "danger",
        message: getErrorText(res.error, "workbench.operation.continueFailed", "继续当前操作失败"),
      });
      return;
    }
    const nextOperationProblem = extractOperationProblem(res.data);
    if (nextOperationProblem) {
      openOperationProblemDialog(nextOperationProblem);
      return;
    }
    const stillRunning = String(res.data?.operationState || "").trim();
      finalizeGitNotice({
        requestId: res.meta?.requestId,
        action: "operation.continue",
        tone: String(res.data?.preservingState?.status || "").trim() === "restore-failed"
          ? "warn"
          : (stillRunning && stillRunning !== "normal" ? "warn" : "info"),
        message: String(res.data?.preservingState?.status || "").trim() === "restored"
          ? gt("workbench.operation.continueRestored", "已继续当前 Git 操作，本地改动已自动恢复")
          : String(res.data?.preservingState?.status || "").trim() === "restore-failed"
            ? (String(res.data?.preservingState?.message || "").trim() || gt("workbench.operation.continueRestoreFailed", "当前 Git 操作已完成，但本地改动恢复失败"))
            : stillRunning && stillRunning !== "normal"
              ? gt("workbench.operation.continueStillRunning", "已继续当前 Git 操作，仓库仍处于进行中状态")
              : gt("workbench.operation.continueDone", "已继续当前 Git 操作"),
      });
  }, [closeConflictResolverDialog, finalizeGitNotice, openOperationProblemDialog, refreshAllAsync, repoRoot]);

  /**
   * 将当前对话框中的编辑结果写回工作区并执行 `git add`，完成应用内“标记为已解决”闭环。
   */
  const resolveConflictMergeAsync = useCallback(async (resultText: string): Promise<void> => {
    if (!conflictMergeDialogState?.snapshot) return;
    const snapshot = conflictMergeDialogState.snapshot;
    const targetRepoRoot = normalizeCommitRepoRoot(conflictMergeDialogState.repoRoot);
    setConflictMergeDialogState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        saving: true,
      };
    });
    const writeRes = await writeWorkingFileAsync(
      conflictMergeDialogState.repoRoot,
      snapshot.path,
      resultText,
    );
    if (!writeRes.ok) {
      setConflictMergeDialogState((prev) => prev ? { ...prev, saving: false } : prev);
      setError(getErrorText(writeRes.error, "workbench.misc.conflicts.writeResultFailed", "写入冲突结果失败"));
      return;
    }
    const stageRes = await stageFilesAsync(conflictMergeDialogState.repoRoot, [snapshot.path]);
    if (!stageRes.ok) {
      setConflictMergeDialogState((prev) => prev ? { ...prev, saving: false } : prev);
      setError(getErrorText(stageRes.error, "workbench.misc.conflicts.markResolvedFailed", "标记冲突为已解决失败"));
      return;
    }
    closeConflictMergeDialog();
    if (!targetRepoRoot) return;
    await continueResolvedOperationAsync(targetRepoRoot);
  }, [closeConflictMergeDialog, conflictMergeDialogState, continueResolvedOperationAsync]);

  /**
   * 按 IDEA 底部“接受左侧/接受右侧”语义直接采用整侧内容并完成写回。
   */
  const resolveConflictMergeWithSourceAsync = useCallback(async (source: "ours" | "theirs"): Promise<void> => {
    const snapshot = conflictMergeDialogState?.snapshot;
    if (!snapshot) return;
    await resolveConflictMergeAsync(String(snapshot[source]?.text || ""));
  }, [conflictMergeDialogState?.snapshot, resolveConflictMergeAsync]);

  /**
   * 在 Diff 中定位到上一个/下一个变更行。
   */
  const navigateDiffLine = useCallback((direction: "prev" | "next"): void => {
    if (changedDiffLineIndexes.length === 0) return;
    let nextLine = changedDiffLineIndexes[0];
    if (diffActiveLine >= 0) {
      if (direction === "next") {
        const hit = changedDiffLineIndexes.find((line) => line > diffActiveLine);
        nextLine = typeof hit === "number" ? hit : changedDiffLineIndexes[0];
      } else {
        const reversed = [...changedDiffLineIndexes].reverse();
        const hit = reversed.find((line) => line < diffActiveLine);
        nextLine = typeof hit === "number" ? hit : reversed[0];
      }
    } else if (direction === "prev") {
      nextLine = changedDiffLineIndexes[changedDiffLineIndexes.length - 1];
    }
    setDiffActiveLine(nextLine);
  }, [changedDiffLineIndexes, diffActiveLine]);

  /**
   * 在当前 Diff 文件组选区里切换上一文件/下一文件，保持 mode/hash/组选区上下文不丢失。
   */
  const navigateDiffFileAsync = useCallback((direction: "prev" | "next"): void => {
    const nextRequest = buildAdjacentCommitDiffOpenRequest(diff, direction);
    if (!nextRequest) return;
    setActiveSelectionScope(null);
    void openDiffRequestAsync(nextRequest);
  }, [diff, openDiffRequestAsync]);

  /**
   * 导出当前 Diff 的 Patch 文本到文件，作为 Create Patch 对话框的面板内等价实现。
   */
  const exportPatchAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot || !diff) return;
    if (!canExportPatchFromDiffMode(diff.mode)) {
      setError(gt("workbench.misc.diff.exportUnsupported", "当前比较视图不支持导出 Patch"));
      return;
    }
    const res = await getDiffPatchAsync(repoRoot, {
      path: diff.path,
      oldPath: diff.oldPath,
      mode: diff.mode,
      hash: diff.mode === "commit" ? (diff.hash || selectedCommitHashes[0]) : undefined,
      hashes: diff.mode === "commit" ? diff.hashes : undefined,
      shelfRef: diff.shelfRef,
    });
    if (!res.ok || !res.data) {
      setError(getErrorText(res.error, "workbench.diff.exportPatchFailed", "导出 Patch 失败"));
      return;
    }
    await exportPatchTextAsync(String(res.data.patch || ""), {
      mode: "save",
      defaultPath: buildPatchExportFileName({
        paths: [diff.path],
        hash: diff.mode === "commit" ? (diff.hash || selectedCommitHashes[0]) : undefined,
        hashes: diff.mode === "commit" ? diff.hashes : undefined,
      }),
    });
  }, [diff, exportPatchTextAsync, repoRoot, selectedCommitHashes]);

  /**
   * 打开推送预览对话框，展示待推送提交与文件。
   */
  const openPushDialogAsync = useCallback(async (targetHash?: string): Promise<void> => {
    if (!repoRoot) return;
    setPushDialogOpen(true);
    setPushDialogLoading(true);
    setPushDialogSubmitting(false);
    setPushForceMenuOpen(false);
    setPushDialogPushTags(false);
    setPushDialogTagMode("all");
    setPushDialogRunHooks(true);
    setPushDialogUpdateIfRejected(true);
    setPushRejectedDialogOpen(false);
    setPushRejectedDecision(null);
    setPushRejectedSubmitting(false);
    pushRejectedPayloadRef.current = null;
    setPushRepoCommitsExpanded(true);
    setPushFileTreeExpanded({});
    const normalizedTarget = String(targetHash || "").trim();
    setPushDialogTargetHash(normalizedTarget);
    const res = await getPushPreviewAsync(repoRoot, normalizedTarget ? { targetHash: normalizedTarget } : {});
    setPushDialogLoading(false);
    if (!res.ok || !res.data) {
      setPushPreview(null);
      setPushSelectedCommitHash("");
      setError(getErrorText(res.error, "workbench.misc.push.previewLoadFailed", "读取推送预览失败"));
      return;
    }
    const data = res.data;
    setPushPreview(data);
    setPushSelectedCommitHash(data.commits[0]?.hash || "");
  }, [repoRoot]);

  /**
   * 消费跨仓 push-after-commit 请求，确保切仓后仍能自动续上目标仓库的 push 预览。
   */
  useEffect(() => {
    if (!repoRoot) return;
    const pending = consumePendingPushAfterCommitRequest(repoRoot);
    if (!pending) return;
    void openPushDialogAsync(pending.targetHash || undefined);
  }, [openPushDialogAsync, repoRoot]);

  /**
   * 按后端返回的 push-after-commit 上下文继续后续动作；当前仓直接打开预览，跨仓则持久化后切仓续推。
   */
  const openPushAfterCommitAsync = useCallback(async (context: PushAfterCommitContext | null | undefined): Promise<void> => {
    const repoRoots = Array.from(new Set(
      (context?.repoRoots || [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ));
    if (repoRoots.length <= 0) return;
    const commitHashByRepoRoot = new Map<string, string>(
      (context?.commitHashes || [])
        .map((item) => [
          String(item?.repoRoot || "").trim(),
          String(item?.commitHash || "").trim(),
        ] as const)
        .filter((item) => !!item[0] && !!item[1]),
    );
    let targetRepoRoot = repoRoots[0] || "";
    if (repoRoots.length > 1) {
      const form = await openActionDialogAsync({
        title: gt("workbench.push.selectRepoTitle", "选择待推送仓库"),
        description: gt("workbench.push.selectRepoDescription", "本次提交涉及多个仓库，请选择要继续打开 push 预览的目标仓库。"),
        confirmText: gt("workbench.push.selectRepoConfirm", "继续推送"),
        fields: [{
          key: "repoRoot",
          label: gt("workbench.push.targetRepoLabel", "目标仓库"),
          type: "select",
          required: true,
          options: repoRoots.map((item) => ({
            value: item,
            label: item,
          })),
        }],
        defaults: {
          repoRoot: targetRepoRoot,
        },
        width: "wide",
      });
      if (!form) return;
      targetRepoRoot = String(form.repoRoot || "").trim() || targetRepoRoot;
    }
    if (!targetRepoRoot) return;
    const targetHash = commitHashByRepoRoot.get(targetRepoRoot) || String(context?.targetHash || "").trim() || undefined;
    if (targetRepoRoot === repoRoot) {
      await openPushDialogAsync(targetHash);
      return;
    }
    persistPendingPushAfterCommitRequest({
      targetRepoRoot,
      targetHash,
    });
    const opened = await openRepoRootInAppAsync(targetRepoRoot, {
      successMessage: gt("workbench.push.openTargetRepoSuccess", "已打开目标仓库，继续加载其推送预览"),
    });
    if (!opened) return;
  }, [openActionDialogAsync, openPushDialogAsync, openRepoRootInAppAsync, repoRoot]);

  /**
   * 保存 commit-and-push 偏好，并立即回填当前状态快照，确保推送预览中的策略切换与后端 show-or-push 判定保持同一真相源。
   */
  const updateCommitAndPushPreferencesAsync = useCallback(async (
    patch: Partial<GitStatusSnapshot["commitAndPush"]>,
  ): Promise<void> => {
    if (!repoRoot) return;
    const res = await saveCommitPanelPreferencesAsync(repoRoot, {
      commitAndPush: patch,
    });
    if (!res.ok || !res.data) {
      setError(toErrorText(res.error, gitWorkbenchText("workbench.errors.saveCommitPushPreferencesFailed", "保存提交并推送偏好失败")));
      return;
    }
    const nextPreferences = res.data;
    setStatus((prev) => prev ? {
      ...prev,
      commitAndPush: nextPreferences.commitAndPush,
      commitHooks: nextPreferences.commitHooks,
    } : prev);
  }, [repoRoot]);

  /**
   * 执行一次实际 push，并统一收口成功、失败以及 push rejected 决策分支。
   */
  const runPushExecutionAsync = useCallback(async (
    pushPayload: PushExecutionPayload,
    options?: {
      closePushDialogOnSuccess?: boolean;
      fallbackErrorMessage?: string;
      successMessageOverride?: string;
    },
  ): Promise<boolean> => {
    if (!repoRoot) return false;
    const res = await executePushAsync(repoRoot, pushPayload);
    const pushRejected = extractPushRejectedDecision(res.data);
    if (pushRejected) {
      pushRejectedPayloadRef.current = pushPayload;
      setPushRejectedDecision(pushRejected);
      setPushRejectedDialogOpen(true);
      finalizeGitNotice({
        requestId: res.meta?.requestId,
        action: "push.execute",
        tone: "warn",
        message: toErrorText(res.error, pushRejected.title),
      });
      return false;
    }
    if (!res.ok) {
      if (res.data?.shouldRefresh === true) {
        await refreshAllAsync({ keepLog: false });
      }
      finalizeGitNotice({
        requestId: res.meta?.requestId,
        action: "push.execute",
        tone: "danger",
        message: toErrorText(res.error, options?.fallbackErrorMessage || gt("workbench.push.failed", "推送失败")),
      });
      return false;
    }
    pushRejectedPayloadRef.current = null;
    setPushRejectedDecision(null);
    setPushRejectedDialogOpen(false);
    setPushRejectedSubmitting(false);
    setPushForceMenuOpen(false);
    if (options?.closePushDialogOnSuccess !== false) {
      setPushDialogOpen(false);
    }
    await refreshAllAsync({ keepLog: false });
    if (options?.successMessageOverride) {
      finalizeGitNotice({
        requestId: res.meta?.requestId,
        action: "push.execute",
        tone: "info",
        message: options.successMessageOverride,
      });
    } else {
      pushFlowFeedbackNotice({
        action: "push",
        requestId: res.meta?.requestId,
        data: res.data,
      });
    }
    return true;
  }, [finalizeGitNotice, pushFlowFeedbackNotice, refreshAllAsync, repoRoot]);

  /**
   * 把 Push Rejected 对话框里用户明确选择的更新方式写回 Update Project 偏好；失败时提示但不阻断本次操作。
   */
  const persistPushRejectedUpdateMethodPreferenceAsync = useCallback(async (
    updateMethod: GitUpdateOptionMethod,
  ): Promise<void> => {
    if (!repoRoot) return;
    const res = await saveUpdateOptionsAsync(repoRoot, { updateMethod });
    if (res.ok) return;
    finalizeGitNotice({
      action: "update.options.set",
      tone: "warn",
      message: toErrorText(res.error, gt("workbench.updateOptions.saveMethodPreferenceFailed", "保存更新方式偏好失败，本次仍会继续执行")),
    });
  }, [finalizeGitNotice, repoRoot]);

  /**
   * 执行推送对话框确认动作（普通推送/强制推送）。
   */
  const submitPushDialogAsync = useCallback(async (forceWithLease: boolean): Promise<void> => {
    if (!repoRoot) return;
    setError("");
    setPushDialogSubmitting(true);
    const pushPayload = {
      targetHash: pushDialogTargetHash || undefined,
      forceWithLease,
      pushTags: pushDialogPushTags,
      pushTagMode: pushDialogPushTags ? pushDialogTagMode : undefined,
      updateIfRejected: pushDialogUpdateIfRejected,
      skipHook: !pushDialogRunHooks,
      setUpstream: !pushPreview?.upstream,
    } satisfies PushExecutionPayload;
    const pushSucceeded = await runPushExecutionAsync(pushPayload, {
      closePushDialogOnSuccess: true,
      fallbackErrorMessage: gt("workbench.push.failed", "推送失败"),
    });
    setPushDialogSubmitting(false);
    if (pushSucceeded) {
      setPushRejectedDecision(null);
      setPushRejectedDialogOpen(false);
    }
  }, [pushDialogPushTags, pushDialogRunHooks, pushDialogTagMode, pushDialogTargetHash, pushDialogUpdateIfRejected, pushPreview?.upstream, repoRoot, runPushExecutionAsync]);

  /**
   * 关闭 Push Rejected 决策对话框，并保留原推送对话框供用户继续调整。
   */
  const closePushRejectedDialog = useCallback((): void => {
    if (pushRejectedSubmitting) return;
    setPushRejectedDialogOpen(false);
    setPushRejectedDecision(null);
    setPushRejectedSubmitting(false);
    pushRejectedPayloadRef.current = null;
  }, [pushRejectedSubmitting]);

  /**
   * 读取 tracked branch 修复建议并打开专用对话框。
   */
  const openTrackedBranchFixDialogAsync = useCallback(async (options?: {
    repoRoot?: string;
    continueMode?: "update" | "reset";
    retryAsync?: (payloadPatch: Record<string, any>) => Promise<void>;
    onSuccess?: () => Promise<void>;
  }): Promise<boolean> => {
    const targetRepoRoot = String(options?.repoRoot || repoRoot || "").trim();
    if (!targetRepoRoot) return false;
    const previewRes = await getUpdateTrackedBranchPreviewAsync(targetRepoRoot);
    if (!previewRes.ok || !previewRes.data || previewRes.data.issues.length <= 0) {
      return false;
    }
    setFixTrackedBranchContinueMode(options?.continueMode || "update");
    trackedBranchRetryRef.current = options?.retryAsync || null;
    trackedBranchAfterSuccessRef.current = options?.onSuccess || null;
    setFixTrackedBranchPreview(previewRes.data);
    setFixTrackedBranchDialogOpen(true);
    return true;
  }, [repoRoot]);

  /**
   * 关闭 Rebase warning 对话框，并清理待重试动作，避免用户取消后残留旧上下文。
   */
  const closeRebaseWarningDialog = useCallback((): void => {
    if (rebaseWarningSubmitting) return;
    setRebaseWarningDialogOpen(false);
    setRebaseWarning(null);
    rebaseWarningRetryRef.current = null;
  }, [rebaseWarningSubmitting]);

  /**
   * 执行“从修订中获取”；若命中覆盖预检查，则拉起统一问题对话框并支持确认后重试。
   */
  const executeRestoreFilesFromRevisionAsync = useCallback(async (
    paths: string[],
    revision: string,
    options?: {
      overwriteModified?: boolean;
    },
  ): Promise<boolean> => {
    if (!repoRoot || paths.length === 0) return false;
    const res = await restoreFilesFromRevisionAsync(repoRoot, paths, revision, {
      overwriteModified: options?.overwriteModified === true,
    });
    const problem = extractOperationProblem(res.data);
    if (problem) {
      openOperationProblemDialog(problem, async (payloadPatch) => {
        setOperationProblemDialogOpen(false);
        setOperationProblem(null);
        operationProblemRetryRef.current = null;
        await executeRestoreFilesFromRevisionAsync(paths, revision, {
          overwriteModified: payloadPatch.overwriteModified === true,
        });
      });
      return false;
    }
    if (!res.ok) {
      setError(getErrorText(res.error, "workbench.details.restoreFromRevisionFailed", "从修订恢复失败"));
      return false;
    }
    await refreshAllAsync({ keepLog: true });
    return true;
  }, [openOperationProblemDialog, refreshAllAsync, repoRoot]);

  /**
   * 从指定修订恢复文件内容到当前工作区。
   */
  const restoreFilesFromRevisionDialogAsync = useCallback(async (paths: string[]): Promise<void> => {
    if (!repoRoot || paths.length === 0) return;
    const form = await openActionDialogAsync({
      title: gt("details.actions.restoreFromRevision", "从修订中获取"),
      description: gt("actionDialogs.checkoutRevision.description", "请输入 Tag 名称或提交哈希"),
      confirmText: gt("workbench.misc.restoreFromRevision.confirm", "恢复"),
      fields: [{ key: "revision", label: gt("workbench.misc.restoreFromRevision.label", "修订"), placeholder: gt("workbench.misc.restoreFromRevision.placeholder", "HEAD~1 或 a1b2c3d"), required: true }],
    });
    if (!form) return;
    const revision = String(form.revision || "").trim();
    if (!revision) return;
    await executeRestoreFilesFromRevisionAsync(paths, revision);
  }, [executeRestoreFilesFromRevisionAsync, openActionDialogAsync, repoRoot]);

  /**
   * 关闭 rollback-capable viewer，并清理挂起的“继续原操作”回调。
   */
  const closeRollbackViewerDialog = useCallback((): void => {
    if (rollbackViewerSubmitting) return;
    if (rollbackDiffOverlayOpen) closeRollbackDiffOverlay();
    setRollbackViewerState(null);
    setRollbackViewerSubmitting(false);
    setRollbackViewerRefreshing(false);
    rollbackViewerContinueRef.current = null;
  }, [closeRollbackDiffOverlay, rollbackDiffOverlayOpen, rollbackViewerSubmitting]);

  /**
   * 打开 rollback-capable viewer；默认选中全部可回滚条目，并允许调用方挂接“回滚后继续”链路。
   */
  const openRollbackViewerDialog = useCallback((args: {
    title: string;
    description: string;
    entries: GitRollbackBrowserEntry[];
    selectedPaths?: string[];
    activePath?: string;
    continueLabel?: string;
    refreshPaths?: string[];
    onContinue?: () => Promise<void>;
  }): void => {
    const entries = (args.entries || []).filter((entry) => !entry.ignored && !entry.untracked);
    const allowedPaths = new Set(entries.map((entry) => String(entry.path || "").trim()).filter(Boolean));
    const selectedPaths = (args.selectedPaths || []).filter((path) => allowedPaths.has(String(path || "").trim()));
    const normalizedRefreshPaths = Array.from(new Set(
      (args.refreshPaths || entries.map((entry) => entry.path))
        .map((path) => String(path || "").trim())
        .filter(Boolean),
    ));
    const activePath = allowedPaths.has(String(args.activePath || "").trim())
      ? String(args.activePath || "").trim()
      : (selectedPaths[0] || entries[0]?.path || "");
    rollbackViewerContinueRef.current = args.onContinue || null;
    setRollbackViewerSubmitting(false);
    setRollbackViewerRefreshing(false);
    setRollbackViewerState({
      title: args.title,
      description: args.description,
      entries,
      selectedPaths: selectedPaths.length > 0 ? selectedPaths : Array.from(allowedPaths),
      activePath,
      continueLabel: args.continueLabel,
      refreshPaths: normalizedRefreshPaths,
    });
  }, []);

  /**
   * 提交 rollback-capable viewer 的回滚动作；成功后可继续原始 Pull/Update 重试链路。
   */
  const submitRollbackViewerAsync = useCallback(async (continueAfterRollback: boolean): Promise<void> => {
    if (!repoRoot || !rollbackViewerState) return;
    const rollbackPaths = rollbackViewerState.selectedPaths.map((path) => String(path || "").trim()).filter(Boolean);
    if (rollbackPaths.length <= 0) {
      setError(gt("workbench.rollbackViewer.selectChangesRequired", "请选择需要回滚的更改"));
      return;
    }

    setRollbackViewerSubmitting(true);
    const res = await rollbackFilesAsync(repoRoot, rollbackPaths);
    setRollbackViewerSubmitting(false);
    if (!res.ok) {
      setError(toErrorText(res.error, gt("workbench.rollbackViewer.rollbackFailed", "回滚失败")));
      return;
    }

    const continueAsync = continueAfterRollback ? rollbackViewerContinueRef.current : null;
    closeRollbackViewerDialog();
    await refreshAllAsync({ keepLog: false });
    if (continueAsync) await continueAsync();
  }, [closeRollbackViewerDialog, refreshAllAsync, repoRoot, rollbackViewerState]);

  /**
   * 在 rollback browser 内按当前 refreshPaths 重新查询本地状态，支持 blocked-changes 与手动回滚共用刷新链路。
   */
  const refreshRollbackViewerAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot || !rollbackViewerState) return;
    setRollbackViewerRefreshing(true);
    const res = await getStatusAsync(projectScopePath || repoRoot);
    setRollbackViewerRefreshing(false);
    if (!res.ok || !res.data) {
      setError(toErrorText(res.error, gt("workbench.rollbackViewer.refreshFailed", "刷新可回滚更改失败")));
      return;
    }
    setStatus(res.data);
    const nextEntries = buildOperationProblemRollbackEntries(rollbackViewerState.refreshPaths, res.data.entries || []);
    const allowedPaths = new Set(nextEntries.map((entry) => String(entry.path || "").trim()).filter(Boolean));
    const nextSelectedPaths = rollbackViewerState.selectedPaths.filter((path) => allowedPaths.has(String(path || "").trim()));
    const fallbackSelectedPaths = nextSelectedPaths.length > 0 ? nextSelectedPaths : Array.from(allowedPaths);
    const nextActivePath = allowedPaths.has(String(rollbackViewerState.activePath || "").trim())
      ? String(rollbackViewerState.activePath || "").trim()
      : (fallbackSelectedPaths[0] || nextEntries[0]?.path || "");
    setRollbackViewerState((prev) => prev ? {
      ...prev,
      entries: nextEntries,
      selectedPaths: fallbackSelectedPaths,
      activePath: nextActivePath,
    } : prev);
  }, [projectScopePath, repoRoot, rollbackViewerState]);

  /**
   * 把 local-changes-overwritten 问题切到 rollback-capable viewer；Cherry-pick 仅允许查看/回滚文件，
   * 其余支持重试的流程才保留“回滚并继续”入口，避免串到错误的操作语义。
   */
  const viewOperationProblemChangesAsync = useCallback(async (): Promise<void> => {
    if (!operationProblem || operationProblem.kind !== "local-changes-overwritten") return;
    if (operationProblem.repoRoot && repoRoot && operationProblem.repoRoot !== repoRoot) {
      setError(gt("workbench.rollbackViewer.openTargetRepoFirst", "请先打开目标仓库后再查看这些变更"));
      return;
    }
    const problemFiles = Array.from(new Set(
      (operationProblem.files || []).map((filePath) => String(filePath || "").trim().replace(/\\/g, "/")).filter(Boolean),
    ));
    const entries = buildOperationProblemRollbackEntries(problemFiles, status?.entries || []);
    if (entries.length <= 0) {
      setError(gt("workbench.rollbackViewer.noLocalChanges", "当前未找到可回滚的本地更改"));
      return;
    }
    const retryAsync = operationProblemRetryRef.current;
    const continueLabel = operationProblem.operation === "cherry-pick"
      ? undefined
      : operationProblem.source === "branch-switch"
        ? gt("workbench.rollbackViewer.continueCheckout", "回滚并继续签出")
        : operationProblem.operation === "checkout"
          ? gt("workbench.rollbackViewer.continueCheckout", "回滚并继续签出")
          : operationProblem.operation === "reset"
            ? gt("workbench.rollbackViewer.continueReset", "回滚并继续重置")
            : gt("workbench.rollbackViewer.continuePull", "回滚并继续拉取");
    setOperationProblemDialogOpen(false);
    openRollbackViewerDialog({
      title: operationProblem.title,
      description: operationProblem.description,
      entries,
      selectedPaths: problemFiles,
      activePath: problemFiles[0] || entries[0]?.path,
      continueLabel,
      refreshPaths: problemFiles,
      onContinue: continueLabel && retryAsync ? async () => {
        await retryAsync({});
      } : undefined,
    });
  }, [openRollbackViewerDialog, operationProblem, repoRoot, status?.entries]);

  /**
   * 在 Cherry-pick 冲突全部解决后切换到提交工作流，并预填 Git 建议的提交消息，对齐 IDEA 的收尾方式。
   */
  const enterCherryPickCommitCompletionMode = useCallback((options?: {
    closeResolver?: boolean;
    focusEditor?: boolean;
  }): boolean => {
    if (!shouldUseCherryPickCommitCompletion) return false;
    return enterCherryPickCommitCompletionModeWithMessage(
      String(status?.operationSuggestedCommitMessage || ""),
      options,
    );
  }, [
    enterCherryPickCommitCompletionModeWithMessage,
    shouldUseCherryPickCommitCompletion,
    status?.operationSuggestedCommitMessage,
  ]);

  /**
   * 统一处理“更新项目”类动作返回值；若命中 tracked branch 问题则优先拉起修复对话框。
   */
  const handlePullLikeResultAsync = useCallback(async (
    action: "pull" | "updateBranch",
    res: GitPullLikeResponse,
    options?: {
      branchName?: string;
      targetRepoRoot?: string;
      fallbackMessage?: string;
      retryAsync?: (payloadPatch: Record<string, any>) => Promise<void>;
      onSuccess?: () => Promise<void>;
      trackedBranchContinueMode?: "update" | "reset";
    },
  ): Promise<boolean> => {
    const updateNotification = extractUpdateSessionNotification(res.data);
    const trackedBranchCandidate = hasTrackedBranchRepairCandidate(res.data);
    if (trackedBranchCandidate) {
      if (res.data?.shouldRefresh === true || res.ok) {
        await refreshAllAsync({ keepLog: false });
      }
      const opened = await openTrackedBranchFixDialogAsync({
        repoRoot: options?.targetRepoRoot,
        continueMode: options?.trackedBranchContinueMode || "update",
        retryAsync: options?.retryAsync,
        onSuccess: options?.onSuccess,
      });
      if (opened) return true;
    }

    const rebaseWarningCandidate = extractRebaseWarning(res.data);
    if (rebaseWarningCandidate && options?.retryAsync) {
      rebaseWarningRetryRef.current = options.retryAsync;
      setRebaseWarning(rebaseWarningCandidate);
      setRebaseWarningSubmitting(false);
      setRebaseWarningDialogOpen(true);
      return true;
    }

    if (!res.ok && String(res.data?.resultCode || "").trim() === "CANCEL") {
      if (res.data?.shouldRefresh === true) {
        await refreshAllAsync({ keepLog: false });
      }
      const nextMessage = toErrorText(res.error, options?.fallbackMessage || gt("workbench.notices.updateCancelled", "更新已取消"));
      if (action === "pull") {
        finalizeUpdateSessionNotice({
          requestId: res.meta?.requestId,
          tone: "info",
          message: nextMessage,
          updateNotification,
          resultData: res.data,
        });
      } else {
        finalizeGitNotice({
          requestId: res.meta?.requestId,
          action: "branch.action",
          tone: "info",
          message: nextMessage,
          updateNotification,
        });
      }
      trackedBranchAfterSuccessRef.current = null;
      return true;
    }

    if (!res.ok) {
      const nextOperationProblem = extractOperationProblem(res.data);
      if (res.data?.shouldRefresh === true) {
        await refreshAllAsync({ keepLog: false });
      }
      if (nextOperationProblem) {
        openOperationProblemDialog(nextOperationProblem, options?.retryAsync);
      }
      const nextTone = updateNotification ? "warn" : "danger";
      const nextMessage = toErrorText(res.error, options?.fallbackMessage || gt("workbench.update.failed", "更新失败"));
      if (action === "pull") {
        finalizeUpdateSessionNotice({
          requestId: res.meta?.requestId,
          tone: nextTone,
          message: nextMessage,
          updateNotification,
          resultData: res.data,
        });
      } else {
        finalizeGitNotice({
          requestId: res.meta?.requestId,
          action: "branch.action",
          tone: nextTone,
          message: nextMessage,
          updateNotification,
        });
      }
      trackedBranchAfterSuccessRef.current = null;
      return true;
    }

    await refreshAllAsync({ keepLog: false });
    pushFlowFeedbackNotice({
      action,
      requestId: res.meta?.requestId,
      data: res.data,
      branchName: options?.branchName,
    });
    if (options?.onSuccess) {
      const continueAsync = options.onSuccess;
      trackedBranchAfterSuccessRef.current = null;
      await continueAsync();
    } else {
      trackedBranchAfterSuccessRef.current = null;
    }
    return true;
  }, [finalizeGitNotice, finalizeUpdateSessionNotice, openOperationProblemDialog, openTrackedBranchFixDialogAsync, pushFlowFeedbackNotice, refreshAllAsync]);

  /**
   * 关闭本次 Update Project 运行期范围对话框，并清理挂起的继续回调。
   */
  const closeUpdateRuntimeScopeDialog = useCallback((): void => {
    if (updateRuntimeScopeSubmitting) return;
    setUpdateRuntimeScopeDialogOpen(false);
    setUpdateRuntimeScopeSnapshot(null);
    updateRuntimeScopeContinueRef.current = null;
  }, [updateRuntimeScopeSubmitting]);

  /**
   * 为正式 Update Project 读取一次性运行期范围；若当前 payload 已显式带 scope，则直接沿用原 payload。
   */
  const continueUpdateWithRuntimeScopeAsync = useCallback(async (
    targetRepoRoot: string,
    basePayload: Record<string, any>,
    onProceed: (payload: Record<string, any>) => Promise<void>,
  ): Promise<void> => {
    const effectiveRepoRoot = String(targetRepoRoot || "").trim();
    if (!effectiveRepoRoot) return;
    if (hasExplicitRuntimeUpdateScopePayload(basePayload)) {
      await onProceed(basePayload);
      return;
    }
    const snapshotRes = await getUpdateOptionsAsync(effectiveRepoRoot, basePayload);
    if (!snapshotRes.ok || !snapshotRes.data) {
      setError(getErrorText(snapshotRes.error, "workbench.updateOptions.loadRuntimeScopeFailed", "读取本次更新范围失败"));
      return;
    }
    if (!shouldPromptRuntimeUpdateScope(snapshotRes.data.scopePreview)) {
      await onProceed(basePayload);
      return;
    }
    updateRuntimeScopeContinueRef.current = async (payloadPatch) => {
      await onProceed({
        ...(basePayload || {}),
        ...(payloadPatch || {}),
      });
    };
    setUpdateRuntimeScopeSnapshot(snapshotRes.data);
    setUpdateRuntimeScopeDialogOpen(true);
  }, []);

  /**
   * 提交本次 Update Project 的一次性范围选择，并把显式 scope patch 回并到正式执行 payload。
   */
  const submitUpdateRuntimeScopeDialogAsync = useCallback(async (payloadPatch: Record<string, any>): Promise<void> => {
    const continueAsync = updateRuntimeScopeContinueRef.current;
    if (!continueAsync) {
      closeUpdateRuntimeScopeDialog();
      return;
    }
    setUpdateRuntimeScopeSubmitting(true);
    setUpdateRuntimeScopeDialogOpen(false);
    setUpdateRuntimeScopeSnapshot(null);
    updateRuntimeScopeContinueRef.current = null;
    try {
      await continueAsync(payloadPatch || {});
    } finally {
      setUpdateRuntimeScopeSubmitting(false);
    }
  }, [closeUpdateRuntimeScopeDialog]);

  /**
   * 按当前 payload 重新执行 Update Project，并允许在多次 warning 间继续叠加确认补丁。
   */
  const retryPullUpdateAsync = useCallback(async (
    basePayload: Record<string, any>,
    payloadPatch: Record<string, any>,
    targetRepoRoot?: string,
    onSuccess?: () => Promise<void>,
  ): Promise<void> => {
    const effectiveRepoRoot = String(targetRepoRoot || repoRoot || "").trim();
    if (!effectiveRepoRoot) return;
    const mergedPayload = {
      ...(basePayload || {}),
      ...(payloadPatch || {}),
    };
    setRebaseWarningDialogOpen(false);
    setRebaseWarning(null);
    rebaseWarningRetryRef.current = null;
    setOperationProblemDialogOpen(false);
    setOperationProblem(null);
    operationProblemRetryRef.current = null;
    setRebaseWarningSubmitting(true);
    const res = await runFlowAsync(effectiveRepoRoot, "pull", mergedPayload);
    setRebaseWarningSubmitting(false);
    await handlePullLikeResultAsync("pull", res, {
      fallbackMessage: gt("workbench.update.failed", "更新失败"),
      retryAsync: async (nextPayloadPatch) => {
        await retryPullUpdateAsync(mergedPayload, nextPayloadPatch, effectiveRepoRoot, onSuccess);
      },
      onSuccess,
    });
  }, [handlePullLikeResultAsync, repoRoot]);

  /**
   * 在 push rejected 后先执行正式 Update Session，成功后再自动重试一次 push。
   */
  const continuePushAfterUpdateAsync = useCallback(async (
    basePushPayload: PushExecutionPayload,
    updatePayloadPatch: Record<string, any>,
  ): Promise<void> => {
    if (!repoRoot) return;
    const selectedUpdateMethod = resolvePushRejectedUpdateMethod({
      kind: "update-with-merge",
      label: "",
      payloadPatch: updatePayloadPatch || {},
    });
    const updatePayload = {
      ...(updatePayloadPatch || {}),
    };
    const retryPushAsync = async (): Promise<void> => {
      await runPushExecutionAsync({
        ...basePushPayload,
        updateIfRejected: false,
      }, {
        closePushDialogOnSuccess: true,
        successMessageOverride: buildPushRejectedRetrySuccessMessage(selectedUpdateMethod),
      });
    };
    await continueUpdateWithRuntimeScopeAsync(repoRoot, updatePayload, async (runtimePayload) => {
      const pullRes = await runFlowAsync(repoRoot, "pull", runtimePayload);
      await handlePullLikeResultAsync("pull", pullRes, {
        fallbackMessage: gt("workbench.update.failed", "更新失败"),
        retryAsync: async (nextPayloadPatch) => {
          await retryPullUpdateAsync(runtimePayload, nextPayloadPatch, repoRoot, retryPushAsync);
        },
        onSuccess: retryPushAsync,
      });
    });
  }, [continueUpdateWithRuntimeScopeAsync, handlePullLikeResultAsync, repoRoot, retryPullUpdateAsync, runPushExecutionAsync]);

  /**
   * 处理 Push Rejected 对话框中的用户决策，显式走 update flow 或 force with lease，而不是主进程黑盒自动重试。
   */
  const submitPushRejectedDecisionAsync = useCallback(async (action: GitPushRejectedAction): Promise<void> => {
    if (!repoRoot) return;
    const basePushPayload = pushRejectedPayloadRef.current;
    if (!basePushPayload) {
      closePushRejectedDialog();
      return;
    }
    if (action.kind === "cancel") {
      closePushRejectedDialog();
      return;
    }
    const selectedUpdateMethod = resolvePushRejectedUpdateMethod(action);
    if (selectedUpdateMethod) {
      await persistPushRejectedUpdateMethodPreferenceAsync(selectedUpdateMethod);
    }
    setPushRejectedSubmitting(true);
    setPushRejectedDialogOpen(false);
    try {
      if (action.kind === "force-with-lease") {
        await runPushExecutionAsync({
          ...basePushPayload,
          ...(action.payloadPatch || {}),
          forceWithLease: true,
          forcePush: false,
          force: false,
          updateIfRejected: false,
        }, {
          closePushDialogOnSuccess: true,
          fallbackErrorMessage: gt("workbench.push.forceWithLeaseFailed", "强制推送失败"),
        });
        return;
      }
      if (action.kind === "force-push") {
        await runPushExecutionAsync({
          ...basePushPayload,
          ...(action.payloadPatch || {}),
          forceWithLease: false,
          forcePush: true,
          force: true,
          updateIfRejected: false,
        }, {
          closePushDialogOnSuccess: true,
          fallbackErrorMessage: gt("workbench.push.forcePushFailed", "普通强制推送失败"),
        });
        return;
      }
      await continuePushAfterUpdateAsync(basePushPayload, action.payloadPatch || {});
    } finally {
      setPushRejectedSubmitting(false);
    }
  }, [closePushRejectedDialog, continuePushAfterUpdateAsync, persistPushRejectedUpdateMethodPreferenceAsync, repoRoot, runPushExecutionAsync]);

  /**
   * 重新执行“更新当前分支”动作，并复用同一套 rebase warning 决策闭环。
   */
  const retryUpdateBranchAsync = useCallback(async (
    branchName: string,
    basePayload: Record<string, any>,
    payloadPatch: Record<string, any>,
    repoRootOverride?: string,
  ): Promise<void> => {
    const actionRepoRoot = String(repoRootOverride || repoRoot || "").trim();
    if (!actionRepoRoot) return;
    const mergedPayload = {
      ...(basePayload || {}),
      ...(payloadPatch || {}),
    };
    setRebaseWarningDialogOpen(false);
    setRebaseWarning(null);
    rebaseWarningRetryRef.current = null;
    setOperationProblemDialogOpen(false);
    setOperationProblem(null);
    operationProblemRetryRef.current = null;
    setRebaseWarningSubmitting(true);
    const res = await runBranchActionAsync(actionRepoRoot, {
      ...mergedPayload,
      action: "updateBranch",
      name: branchName,
    });
    setRebaseWarningSubmitting(false);
    await handlePullLikeResultAsync("updateBranch", res, {
      branchName,
      fallbackMessage: gt("workbench.update.failed", "更新失败"),
      retryAsync: async (nextPayloadPatch) => {
        await retryUpdateBranchAsync(branchName, mergedPayload, nextPayloadPatch, actionRepoRoot);
      },
    });
  }, [handlePullLikeResultAsync, repoRoot]);

  /**
   * 按当前 payload 重新执行分支签出，并把 checkout 覆盖问题继续收口到统一问题对话框。
   */
  const retryCheckoutBranchAsync = useCallback(async (
    target: string,
    basePayload: Record<string, any>,
    payloadPatch: Record<string, any>,
    previousBranch?: string,
    repoRootOverride?: string,
  ): Promise<void> => {
    const actionRepoRoot = String(repoRootOverride || repoRoot || "").trim();
    if (!actionRepoRoot) return;
    const mergedPayload = {
      ...(basePayload || {}),
      ...(payloadPatch || {}),
    };
    setOperationProblemDialogOpen(false);
    setOperationProblem(null);
    operationProblemRetryRef.current = null;
    setOperationProblemSubmitting(true);
    const res = await switchBranchAsync(actionRepoRoot, target, mergedPayload);
    setOperationProblemSubmitting(false);
    if (!res.ok) {
      const nextOperationProblem = extractOperationProblem(res.data);
      if (res.data?.shouldRefresh === true) {
        await refreshAllAsync({ keepLog: false });
      }
      if (nextOperationProblem) {
        openOperationProblemDialog(nextOperationProblem, async (nextPayloadPatch) => {
          await retryCheckoutBranchAsync(target, mergedPayload, nextPayloadPatch, previousBranch, actionRepoRoot);
        });
        return;
      }
      setError(getErrorText(res.error, "workbench.branch.checkoutFailed", "签出分支失败"));
      return;
    }
    await finishBranchCheckoutAsync({
      requestId: res.meta?.requestId,
      action: "branch.switch",
      repoRootOverride: actionRepoRoot,
      targetBranch: target,
      previousBranch,
      data: res.data,
    });
  }, [finishBranchCheckoutAsync, openOperationProblemDialog, refreshAllAsync, repoRoot]);

  /**
   * 按当前 payload 重新执行“签出并更新”，并复用统一问题提示与 Update Project 重试闭环。
   */
  const retryCheckoutUpdateAsync = useCallback(async (
    target: string,
    basePayload: Record<string, any>,
    payloadPatch: Record<string, any>,
    previousBranch?: string,
    repoRootOverride?: string,
  ): Promise<void> => {
    const actionRepoRoot = String(repoRootOverride || repoRoot || "").trim();
    if (!actionRepoRoot) return;
    const mergedPayload = {
      ...(basePayload || {}),
      ...(payloadPatch || {}),
    };
    setOperationProblemDialogOpen(false);
    setOperationProblem(null);
    operationProblemRetryRef.current = null;
    setOperationProblemSubmitting(true);
    const res = await runBranchActionAsync(actionRepoRoot, {
      ...mergedPayload,
      action: "checkoutUpdate",
      ref: target,
    });
    setOperationProblemSubmitting(false);
    if (!res.ok) {
      const nextOperationProblem = extractOperationProblem(res.data);
      if (nextOperationProblem) {
        if (res.data?.shouldRefresh === true) {
          await refreshAllAsync({ keepLog: false });
        }
        openOperationProblemDialog(nextOperationProblem, async (nextPayloadPatch) => {
          await retryCheckoutUpdateAsync(target, mergedPayload, nextPayloadPatch, previousBranch, actionRepoRoot);
        });
        return;
      }
      await handlePullLikeResultAsync("updateBranch", res, {
        branchName: target,
        fallbackMessage: gt("workbench.branch.checkoutUpdateFailed", "签出并更新失败"),
        retryAsync: async (nextPayloadPatch) => {
          await retryCheckoutUpdateAsync(target, mergedPayload, nextPayloadPatch, previousBranch, actionRepoRoot);
        },
      });
      return;
    }
    await finishBranchCheckoutAsync({
      requestId: res.meta?.requestId,
      action: "branch.action",
      repoRootOverride: actionRepoRoot,
      targetBranch: target,
      previousBranch,
      data: res.data,
    });
  }, [finishBranchCheckoutAsync, handlePullLikeResultAsync, openOperationProblemDialog, refreshAllAsync, repoRoot]);

  /**
   * 按当前 payload 重新执行分支侧的 Merge/Rebase/PullRemote 等“pull-like”动作，并复用统一 warning/problem 分流。
   */
  const retryBranchPullLikeActionAsync = useCallback(async (
    basePayload: Record<string, any>,
    payloadPatch: Record<string, any>,
    options?: {
      branchName?: string;
      fallbackMessage?: string;
      repoRoot?: string;
    },
  ): Promise<void> => {
    const actionRepoRoot = String(options?.repoRoot || repoRoot || "").trim();
    if (!actionRepoRoot) return;
    const mergedPayload = {
      ...(basePayload || {}),
      ...(payloadPatch || {}),
    };
    setRebaseWarningDialogOpen(false);
    setRebaseWarning(null);
    rebaseWarningRetryRef.current = null;
    setOperationProblemDialogOpen(false);
    setOperationProblem(null);
    operationProblemRetryRef.current = null;
    setRebaseWarningSubmitting(true);
    const res = await runBranchActionAsync(actionRepoRoot, mergedPayload);
    setRebaseWarningSubmitting(false);
    await handlePullLikeResultAsync("updateBranch", res, {
      branchName: options?.branchName,
      fallbackMessage: options?.fallbackMessage || gt("workbench.common.operationFailed", "操作失败"),
      retryAsync: async (nextPayloadPatch) => {
        await retryBranchPullLikeActionAsync(mergedPayload, nextPayloadPatch, {
          ...(options || {}),
          repoRoot: actionRepoRoot,
        });
      },
    });
  }, [handlePullLikeResultAsync, repoRoot]);

  /**
   * 继续或中止当前仓库中的进行中 Git 操作，并在完成后统一刷新工作台与通知条。
   */
  const submitOperationStateControlAsync = useCallback(async (
    control: "continue" | "abort",
  ): Promise<void> => {
    if (!repoRoot || operationStateSubmitting) return;
    setError("");
    setOperationStateSubmitting(control);
    const res = control === "continue"
      ? await continueRepositoryOperationAsync(repoRoot)
      : await abortRepositoryOperationAsync(repoRoot);
    setOperationStateSubmitting(null);
    if (res.data?.shouldRefresh === true || res.ok) {
      await refreshAllAsync({ keepLog: false });
    }
    if (control === "continue" && res.data?.requiresCommitCompletion === true) {
      const suggestedMessage = String(res.data?.operationSuggestedCommitMessage || "").trim();
      if (enterCherryPickCommitCompletionModeWithMessage(suggestedMessage, { focusEditor: true }))
        return;
    }
    if (!res.ok) {
      const nextOperationProblem = extractOperationProblem(res.data);
      const operationFailureFeedback = resolveOperationControlFailureFeedback({
        control,
        error: res.error,
        data: res.data,
      });
      if (nextOperationProblem) {
        setError("");
        removeGitNoticeByRequestId(res.meta?.requestId);
        openOperationProblemDialog(nextOperationProblem);
        return;
      }
      if (operationFailureFeedback) {
        setError("");
        removeGitNoticeByRequestId(res.meta?.requestId);
        return;
      }
      finalizeGitNotice({
        requestId: res.meta?.requestId,
        action: control === "continue" ? "operation.continue" : "operation.abort",
        tone: "danger",
        message: toErrorText(
          res.error,
          control === "continue"
            ? gt("workbench.operation.continueFailed", "继续当前操作失败")
            : gt("workbench.operation.abortFailed", "中止当前操作失败"),
        ),
      });
      return;
    }
    const stillRunning = String(res.data?.operationState || "").trim();
    finalizeGitNotice({
      requestId: res.meta?.requestId,
      action: control === "continue" ? "operation.continue" : "operation.abort",
      tone: String(res.data?.preservingState?.status || "").trim() === "restore-failed"
        ? "warn"
        : (control === "continue" && stillRunning && stillRunning !== "normal" ? "warn" : "info"),
      message: control === "continue"
        ? (String(res.data?.preservingState?.status || "").trim() === "restored"
            ? gt("workbench.operation.continueRestored", "已继续当前 Git 操作，本地改动已自动恢复")
            : String(res.data?.preservingState?.status || "").trim() === "restore-failed"
              ? (String(res.data?.preservingState?.message || "").trim() || gt("workbench.operation.continueRestoreFailed", "当前 Git 操作已完成，但本地改动恢复失败"))
              : (stillRunning && stillRunning !== "normal"
                  ? gt("workbench.operation.continueStillRunning", "已继续当前 Git 操作，仓库仍处于进行中状态")
                  : gt("workbench.operation.continueDone", "已继续当前 Git 操作")))
        : (String(res.data?.preservingState?.status || "").trim() === "restored"
            ? gt("workbench.operation.abortRestored", "已中止当前 Git 操作，本地改动已自动恢复")
            : String(res.data?.preservingState?.status || "").trim() === "restore-failed"
              ? (String(res.data?.preservingState?.message || "").trim() || gt("workbench.operation.abortRestoreFailed", "当前 Git 操作已中止，但本地改动恢复失败"))
              : gt("workbench.operation.abortDone", "已中止当前 Git 操作")),
    });
  }, [enterCherryPickCommitCompletionModeWithMessage, finalizeGitNotice, openOperationProblemDialog, operationStateSubmitting, refreshAllAsync, removeGitNoticeByRequestId, repoRoot]);

  useEffect(() => {
    if (!conflictResolverDialogState?.sessionSnapshot) {
      conflictResolverAutoContinueKeyRef.current = "";
      return;
    }
    const operationState = String(status?.operationState || "").trim();
    if (!operationState || operationState === "normal") {
      conflictResolverAutoContinueKeyRef.current = "";
      return;
    }
    if (!conflictResolverDialogState.autoCloseWhenResolved) return;
    if ((conflictResolverDialogState.sessionSnapshot.unresolvedCount || 0) > 0) {
      conflictResolverAutoContinueKeyRef.current = "";
      return;
    }
    if (operationStateSubmitting) return;
    const targetRepoRoot = resolveScopedRepoRoot(repoRoot, conflictResolverDialogState.scopeRepoRoot);
    if (!targetRepoRoot) return;
    const continueKey = `${targetRepoRoot}\u0000${operationState}\u0000${conflictResolverDialogState.sessionSnapshot.resolvedCount}`;
    void continueResolvedOperationAsync(targetRepoRoot, {
      dedupeKey: continueKey,
      closeResolver: true,
    });
  }, [
    continueResolvedOperationAsync,
    conflictResolverDialogState,
    operationStateSubmitting,
    repoRoot,
    status,
    status?.operationState,
  ]);

  /**
   * 执行分支树里的 Merge/Rebase/PullRemote 等 pull-like 动作；若命中结构化问题则先弹窗，否则统一交给 pull-like 分流器处理。
   */
  const runBranchPullLikeActionAsync = useCallback(async (
    basePayload: Record<string, any>,
    options: {
      branchName?: string;
      fallbackMessage: string;
      repoRoot?: string;
    },
  ): Promise<void> => {
    const actionRepoRoot = String(options.repoRoot || repoRoot || "").trim();
    if (!actionRepoRoot) return;
    const res = await runBranchActionAsync(actionRepoRoot, basePayload);
    const nextOperationProblem = extractOperationProblem(res.data);
    if (nextOperationProblem) {
      openOperationProblemDialog(nextOperationProblem, async (payloadPatch) => {
        await retryBranchPullLikeActionAsync(basePayload, payloadPatch, {
          ...options,
          repoRoot: actionRepoRoot,
        });
      });
      return;
    }
    await handlePullLikeResultAsync("updateBranch", res, {
      branchName: options.branchName,
      fallbackMessage: options.fallbackMessage,
      retryAsync: async (payloadPatch) => {
        await retryBranchPullLikeActionAsync(basePayload, payloadPatch, {
          ...options,
          repoRoot: actionRepoRoot,
        });
      },
    });
  }, [handlePullLikeResultAsync, openOperationProblemDialog, repoRoot, retryBranchPullLikeActionAsync]);

  /**
   * 执行一次显式 Fetch，并统一收口取消、失败与成功后的刷新通知。
   */
  const executeFetchFlowAsync = useCallback(async (
    targetRepoRoot: string,
    payload?: Record<string, any>,
  ): Promise<boolean> => {
    const actionRepoRoot = String(targetRepoRoot || "").trim();
    if (!actionRepoRoot) return false;
    setLoadingFlow(true);
    const res = await runFlowAsync(actionRepoRoot, "fetch", payload || {});
    setLoadingFlow(false);
    if (!res.ok) {
      if (String(res.data?.resultCode || "").trim() === "CANCEL") {
        finalizeGitNotice({
          requestId: res.meta?.requestId,
          action: "flow.fetch",
          tone: "info",
          message: getErrorText(res.error, "workbench.fetch.cancelled", "获取已取消"),
        });
        return false;
      }
      if (res.data?.shouldRefresh === true) {
        await refreshAllAsync({ keepLog: false });
      }
      finalizeGitNotice({
        requestId: res.meta?.requestId,
        action: "flow.fetch",
        tone: "danger",
        message: getErrorText(res.error, "workbench.fetch.failed", "获取失败"),
      });
      return false;
    }
    await refreshAllAsync({ keepLog: false });
    pushFlowFeedbackNotice({
      action: "fetch",
      requestId: res.meta?.requestId,
      data: res.data,
    });
    return true;
  }, [finalizeGitNotice, pushFlowFeedbackNotice, refreshAllAsync]);

  /**
   * 打开显式 Fetch 对话框，统一暴露 root、远端范围、refspec、tag mode 与 unshallow 选项。
   */
  const openFetchDialogAsync = useCallback((): void => {
    if (fetchDialogRepositories.length <= 0) {
      setError(gt("flow.noAvailableRemote", "未找到可用远端"));
      return;
    }
    const selectedRepoRoot = String(branchPopup?.selectedRepoRoot || repoRoot || "").trim();
    const selectedRepository = fetchDialogRepositories.find((repository) => repository.repoRoot === selectedRepoRoot)
      || fetchDialogRepositories[0]
      || null;
    if (!selectedRepository) {
      setError(gt("flow.noAvailableRemote", "未找到可用远端"));
      return;
    }
    setFetchDialogValue({
      repoRoot: selectedRepository.repoRoot,
      mode: "default-remote",
      remote: selectedRepository.defaultRemote || selectedRepository.remotes[0]?.name || "",
      refspec: "",
      unshallow: false,
      tagMode: "auto",
    });
    setFetchDialogOpen(true);
  }, [branchPopup?.selectedRepoRoot, fetchDialogRepositories, repoRoot]);

  /**
   * 提交显式 Fetch 对话框，把对话框值映射为后端 `flow.fetch` 载荷。
   */
  const submitFetchDialogAsync = useCallback(async (): Promise<void> => {
    const targetRepoRoot = String(fetchDialogValue.repoRoot || "").trim();
    if (!targetRepoRoot) {
      setError(gt("workbench.fetch.selectRepository", "请选择需要执行 Fetch 的仓库"));
      return;
    }
    const payload: Record<string, any> = {
      refspec: String(fetchDialogValue.refspec || "").trim() || undefined,
      unshallow: fetchDialogValue.unshallow === true,
      tagMode: fetchDialogValue.tagMode,
    };
    if (fetchDialogValue.mode === "all-remotes") {
      payload.allRemotes = true;
    } else if (fetchDialogValue.mode === "specific-remote") {
      const remote = String(fetchDialogValue.remote || "").trim();
      if (!remote) {
        setError(gt("workbench.fetch.selectRemote", "请选择要获取的远端"));
        return;
      }
      payload.remote = remote;
      payload.allRemotes = false;
    } else {
      payload.allRemotes = false;
    }
    setFetchDialogSubmitting(true);
    setFetchDialogOpen(false);
    await executeFetchFlowAsync(targetRepoRoot, payload);
    setFetchDialogSubmitting(false);
  }, [executeFetchFlowAsync, fetchDialogValue]);

  /**
   * 打开独立 Pull 对话框，并按当前分支跟踪远端预选 remote/branch。
   */
  const openPullDialogAsync = useCallback(async (): Promise<void> => {
    const selectedRepoRoot = String(branchPopup?.selectedRepoRoot || repoRoot || "").trim();
    const selectedRepository = pullDialogRepositories.find((repository) => repository.repoRoot === selectedRepoRoot)
      || pullDialogRepositories[0]
      || null;
    const selectedPopupRepository = (branchPopup?.repositories || []).find((repository) => repository.repoRoot === selectedRepository?.repoRoot) || null;
    const currentBranch = String(selectedPopupRepository?.currentBranch || repoBranch || "").trim();
    const detached = selectedPopupRepository?.detached === true || (!selectedPopupRepository && repoDetached);
    if (!selectedRepository) {
      setError(gt("flow.noAvailableRemote", "未找到可用远端"));
      return;
    }
    if (detached || !currentBranch) {
      setError(gt("workbench.pull.detachedHeadUnsupported", "游离 HEAD 状态下不支持拉取"));
      return;
    }
    if (selectedRepository.remotes.length <= 0) {
      setError(gt("flow.noAvailableRemote", "未找到可用远端"));
      return;
    }
    const currentUpstream = String(
      (selectedPopupRepository?.groups.local || branchPopup?.groups?.local || [])
        .find((item) => String(item.name || "").trim() === currentBranch)?.upstream || "",
    ).trim();
    const repoRemoteNames = selectedRepository.remotes.map((item) => item.name);
    const upstreamParsed = parseRemoteBranchRefName(currentUpstream, repoRemoteNames);
    const defaultRemote = selectedRepository.remotes.find((item) => item.name === upstreamParsed?.remote)
      || selectedRepository.remotes[0]
      || null;
    const defaultBranch = upstreamParsed?.branch && defaultRemote?.branches.includes(upstreamParsed.branch)
      ? upstreamParsed.branch
      : (defaultRemote?.branches[0] || "");
    let storedPullOptions: GitPullOptions = {
      mode: "merge",
      options: [],
    };
    let capabilities: GitPullCapabilities = { noVerify: false };
    const updateOptionsRes = await getUpdateOptionsAsync(selectedRepository.repoRoot);
    if (updateOptionsRes.ok && updateOptionsRes.data) {
      storedPullOptions = updateOptionsRes.data.options.pull || storedPullOptions;
      capabilities = updateOptionsRes.data.pullCapabilities;
    }
    setPullDialogCapabilities(capabilities);
    setPullDialogValue({
      repoRoot: selectedRepository.repoRoot,
      remote: defaultRemote?.name || "",
      branch: defaultBranch,
      mode: storedPullOptions.mode || "merge",
      options: (storedPullOptions.options || []).filter((option) => option !== "rebase"),
    });
    setPullDialogOpen(true);
  }, [branchPopup?.groups?.local, branchPopup?.repositories, branchPopup?.selectedRepoRoot, pullDialogRepositories, repoBranch, repoDetached, repoRoot]);

  /**
   * 提交独立 Pull 对话框，显式走 `branch.action -> pullRemote`，不复用 `flow.pull`。
   */
  const submitPullDialogAsync = useCallback(async (): Promise<void> => {
    const targetRepoRoot = String(pullDialogValue.repoRoot || "").trim();
    const remote = String(pullDialogValue.remote || "").trim();
    const branch = String(pullDialogValue.branch || "").trim();
    if (!targetRepoRoot || !remote || !branch) {
      setError(gt("workbench.pull.selectRemoteBranch", "请选择要拉取的远端分支"));
      return;
    }
    const selectedPopupRepository = (branchPopup?.repositories || []).find((repository) => repository.repoRoot === targetRepoRoot) || null;
    const currentBranch = String(selectedPopupRepository?.currentBranch || repoBranch || "").trim() || undefined;
    setPullDialogSubmitting(true);
    setPullDialogOpen(false);
    await savePullOptionsAsync(targetRepoRoot, {
      mode: pullDialogValue.mode,
      options: pullDialogValue.options,
    });
    await runBranchPullLikeActionAsync(
      {
        action: "pullRemote",
        ref: `${remote}/${branch}`,
        mode: pullDialogValue.mode,
        options: pullDialogValue.options,
        ffOnly: pullDialogValue.options.includes("ffOnly"),
        noFf: pullDialogValue.options.includes("noFf"),
        squash: pullDialogValue.options.includes("squash"),
        noCommit: pullDialogValue.options.includes("noCommit"),
        noVerify: pullDialogValue.options.includes("noVerify"),
      },
      {
        repoRoot: targetRepoRoot,
        branchName: currentBranch,
        fallbackMessage: pullDialogValue.mode === "rebase"
          ? gt("workbench.pull.rebaseFailed", "Pull（Rebase）失败")
          : gt("workbench.pull.mergeFailed", "Pull（Merge）失败"),
      },
    );
    setPullDialogSubmitting(false);
  }, [branchPopup?.repositories, pullDialogValue, repoBranch, runBranchPullLikeActionAsync]);

  /**
   * 提交 Rebase warning 对话框里的用户决策，并按返回的 payload patch 自动重试。
   */
  const submitRebaseWarningDecisionAsync = useCallback(async (payloadPatch: Record<string, any>): Promise<void> => {
    const retryAsync = rebaseWarningRetryRef.current;
    if (!retryAsync) {
      closeRebaseWarningDialog();
      return;
    }
    await retryAsync(payloadPatch || {});
  }, [closeRebaseWarningDialog]);

  /**
   * 提交 tracked branch 修复对话框；应用配置后立即重试 Update Project。
   */
  const submitFixTrackedBranchDialogAsync = useCallback(async (
    payload: { selections: GitUpdateTrackedBranchSelection[]; updateMethod: GitUpdateOptionMethod },
  ): Promise<void> => {
    const targetRepoRoot = String(fixTrackedBranchPreview?.requestedRepoRoot || repoRoot || "").trim();
    if (!targetRepoRoot) return;
    setFixTrackedBranchSubmitting(true);
    const applyRes = await applyUpdateTrackedBranchSelectionsAsync(targetRepoRoot, payload.selections, payload.updateMethod);
    if (!applyRes.ok || !applyRes.data) {
      setFixTrackedBranchSubmitting(false);
      setError(getErrorText(applyRes.error, "workbench.updateResult.applyTrackedBranchFixFailed", "应用跟踪分支修复失败"));
      return;
    }
    setFixTrackedBranchSubmitting(false);
    setFixTrackedBranchDialogOpen(false);
    setFixTrackedBranchPreview(null);
    setFixTrackedBranchContinueMode("update");
    const retryAsync = trackedBranchRetryRef.current;
    trackedBranchRetryRef.current = null;
    if (retryAsync) {
      await retryAsync(applyRes.data.updatePayloadPatch || {});
      return;
    }
    await continueUpdateWithRuntimeScopeAsync(targetRepoRoot, applyRes.data.updatePayloadPatch || {}, async (runtimePayload) => {
      const pullRes = await runFlowAsync(targetRepoRoot, "pull", runtimePayload);
      await handlePullLikeResultAsync("pull", pullRes, {
        targetRepoRoot,
        fallbackMessage: gt("workbench.update.failed", "更新失败"),
        retryAsync: async (payloadPatch) => {
          await retryPullUpdateAsync(runtimePayload, payloadPatch, targetRepoRoot, trackedBranchAfterSuccessRef.current || undefined);
        },
        onSuccess: trackedBranchAfterSuccessRef.current || undefined,
      });
    });
  }, [continueUpdateWithRuntimeScopeAsync, fixTrackedBranchPreview?.requestedRepoRoot, handlePullLikeResultAsync, repoRoot, retryPullUpdateAsync]);

  /**
   * 重试单个 root 的 Update Project，供失败仓、跳过仓和 fetch 阶段失败仓在结果卡片上直接恢复。
   */
  const retryUpdateRootAsync = useCallback(async (
    targetRepoRoot: string,
    payloadPatch?: Record<string, any>,
  ): Promise<void> => {
    const effectiveRepoRoot = String(targetRepoRoot || "").trim();
    if (!effectiveRepoRoot) return;
    const basePayload = buildSingleRootUpdatePayload(effectiveRepoRoot, payloadPatch);
    const res = await runFlowAsync(effectiveRepoRoot, "pull", basePayload);
    await handlePullLikeResultAsync("pull", res, {
      targetRepoRoot: effectiveRepoRoot,
      fallbackMessage: gt("workbench.update.failed", "更新失败"),
      retryAsync: async (nextPayloadPatch) => {
        await retryUpdateRootAsync(effectiveRepoRoot, {
          ...(payloadPatch || {}),
          ...(nextPayloadPatch || {}),
        });
      },
    });
  }, [buildSingleRootUpdatePayload, handlePullLikeResultAsync]);

  /**
   * 执行 Update Session 的后续动作，统一收口查看提交、仓级恢复和保留改动入口。
   */
  const handleUpdatePostActionAsync = useCallback(async (
    notification: GitUpdateSessionNotificationData | null,
    action: GitUpdatePostAction,
  ): Promise<void> => {
    if (action.kind === "view-commits") {
      if (!notification) {
        setError(gt("workbench.updateResult.viewCommitsUnavailable", "当前结果未提供可查看的提交范围"));
        return;
      }
      const payloadRanges = Array.isArray(action.payload?.ranges)
        ? action.payload.ranges
          .map((item: any) => normalizeUpdateNotificationRange(item))
          .filter((item: GitUpdateNotificationRange | null): item is GitUpdateNotificationRange => !!item)
        : [];
      if (payloadRanges.length > 1) {
        setUpdateCommitRangeChoice({
          notification: {
            ...notification,
            ranges: payloadRanges,
            primaryRange: payloadRanges.find((range) => range.repoRoot === action.payload?.primaryRepoRoot) || notification.primaryRange,
          },
          ranges: payloadRanges,
        });
        return;
      }
      openUpdateNotificationCommits(notification);
      return;
    }
    if (action.kind === "copy-revision-range") {
      const revision = String(action.revision || "").trim();
      if (!revision) {
        setError(gt("workbench.updateResult.copyRangeUnavailable", "当前结果未提供可复制的提交范围"));
        return;
      }
      const copied = await window.host.utils.copyText(revision);
      if (!copied?.ok) {
        setError(getErrorText(copied?.error, "workbench.updateResult.copyRangeFailed", "复制提交范围失败"));
        return;
      }
      finalizeGitNotice({
        action: "flow.pull",
        tone: "info",
        message: gitWorkbenchText("details.commitRangeCopied", "已复制提交范围：{{revision}}", { revision }),
      });
      return;
    }
    if (action.kind === "resolve-conflicts") {
      const targetRepoRoot = String(action.repoRoot || action.payload?.repoRoot || "").trim();
      if (!targetRepoRoot) {
        setError(gt("workbench.updateResult.conflictRepoUnavailable", "当前结果未提供冲突所属仓库"));
        return;
      }
      const scopeKey = repoRoot ? resolveConflictResolverScopeKey(repoRoot, targetRepoRoot) : null;
      if (scopeKey === null && repoRoot && targetRepoRoot !== repoRoot) {
        await openRepoRootInAppAsync(targetRepoRoot, {
          successMessage: gt("dialogs.multipleFileMerge.openTargetRepoSuccess", "已打开目标仓库，可继续处理其冲突"),
        });
        return;
      }
      openConflictResolverDialog({
        title: gt("dialogs.multipleFileMerge.reopenTitle", "继续处理冲突"),
        description: String(action.payload?.description || "").trim() || gt("dialogs.multipleFileMerge.reopenDescription", "当前仓库仍有未解决冲突，可直接回到统一 resolver 继续处理。"),
        reverseMerge: action.payload?.reverseMerge === true,
        scopeRepoRoot: scopeKey || undefined,
      });
      return;
    }
    if (action.kind === "retry-update-root") {
      const targetRepoRoot = String(action.repoRoot || action.payload?.repoRoot || "").trim();
      if (!targetRepoRoot) {
        setError(gt("workbench.updateResult.retryRepoUnavailable", "当前结果未提供可重试的仓库"));
        return;
      }
      await retryUpdateRootAsync(targetRepoRoot, action.payload && typeof action.payload === "object" ? action.payload : undefined);
      return;
    }
    if (action.kind === "fix-tracked-branch") {
      const targetRepoRoot = String(action.repoRoot || action.payload?.repoRoot || "").trim();
      if (!targetRepoRoot) {
        setError(gt("workbench.updateResult.fixRepoUnavailable", "当前结果未提供需要修复的仓库"));
        return;
      }
      const opened = await openTrackedBranchFixDialogAsync({
        repoRoot: targetRepoRoot,
        continueMode: "update",
        retryAsync: async (payloadPatch) => {
          await retryUpdateRootAsync(targetRepoRoot, payloadPatch);
        },
      });
      if (!opened) setError(gt("workbench.updateResult.noTrackedBranchIssue", "当前仓库没有可修复的上游分支问题"));
      return;
    }
    if (action.kind === "open-saved-changes") {
      const targetRepoRoot = String(action.repoRoot || action.payload?.repoRoot || "").trim();
      const saveChangesPolicy = action.payload?.saveChangesPolicy === "shelve" ? "shelve" : "stash";
      if (!targetRepoRoot) {
        setError(gt("workbench.updateResult.savedChangesRepoUnavailable", "当前结果未提供保存改动所属仓库"));
        return;
      }
      await openSavedChangesRecoveryAsync(targetRepoRoot, saveChangesPolicy, action.payload && typeof action.payload === "object" ? action.payload : undefined);
      return;
    }
    if (action.kind === "open-parent-repo" || action.kind === "open-repo-root") {
      const targetRepoRoot = String(action.repoRoot || action.payload?.repoRoot || action.payload?.childRepoRoot || "").trim();
      if (!targetRepoRoot) {
        setError(gt("workbench.updateResult.targetRepoUnavailable", "当前结果未提供目标仓库路径"));
        return;
      }
      await openRepoRootInAppAsync(targetRepoRoot, {
        successMessage: action.kind === "open-parent-repo"
          ? gt("workbench.updateResult.openParentRepoSuccess", "已打开父仓，可继续处理该子仓更新问题")
          : gt("workbench.updateResult.openTargetRepoSuccess", "已打开目标仓库"),
      });
      return;
    }
    finalizeGitNotice({
      action: "flow.pull",
      tone: "warn",
      message: gitWorkbenchText("workbench.misc.actionUnsupported", "暂不支持动作：{{label}}", { label: action.label }),
    });
  }, [
    finalizeGitNotice,
    openConflictResolverDialog,
    openRepoRootInAppAsync,
    openSavedChangesRecoveryAsync,
    openTrackedBranchFixDialogAsync,
    openUpdateNotificationCommits,
    repoRoot,
    retryUpdateRootAsync,
  ]);

  /**
   * 读取当前仓库的正式 Update Options，并打开持久化设置对话框。
   */
  const openUpdateOptionsDialogAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot) return;
    const res = await getUpdateOptionsAsync(repoRoot);
    if (!res.ok || !res.data) {
      setError(toErrorText(res.error, gt("workbench.updateOptions.loadFailed", "读取 Update Options 失败")));
      return;
    }
    setUpdateOptionsSnapshot(res.data);
    setUpdateOptionsDialogOpen(true);
  }, [repoRoot]);

  /**
   * 按当前 Update Options 草稿重新请求多仓范围预览，供对话框展示真实 repository graph 结果。
   */
  const requestUpdateScopePreviewAsync = useCallback(async (options: GitUpdateOptions): Promise<GitUpdateOptionsSnapshot["scopePreview"] | null> => {
    if (!repoRoot) return null;
    const res = await getUpdateOptionsAsync(repoRoot, { options });
    if (!res.ok || !res.data?.scopePreview) {
      setError(toErrorText(res.error, gt("workbench.updateOptions.refreshScopePreviewFailed", "刷新多仓范围预览失败")));
      return null;
    }
    return res.data.scopePreview;
  }, [repoRoot]);

  /**
   * 读取 Reset 独立入口所需上下文；Detached HEAD 仍直接阻断，其余情况统一复用后端修复链路。
   */
  const openUpdateResetDialogAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot) return;
    const res = await getUpdateOptionsAsync(repoRoot);
    if (!res.ok || !res.data) {
      setError(toErrorText(res.error, gt("workbench.updateReset.loadFailed", "读取 Reset 预览失败")));
      return;
    }
    const branchName = String(res.data.methodResolution.currentBranch || "").trim();
    if (!branchName) {
      setError(gt("workbench.updateReset.detachedHeadUnsupported", "当前处于游离 HEAD，无法执行重置更新"));
      return;
    }
    setUpdateResetSnapshot(res.data);
    setUpdateResetDialogOpen(true);
  }, [repoRoot]);

  /**
   * 关闭 Reset 独立确认对话框，并清理当前预览上下文。
   */
  const closeUpdateResetDialog = useCallback((): void => {
    if (updateResetSubmitting) return;
    setUpdateResetDialogOpen(false);
    setUpdateResetSnapshot(null);
  }, [updateResetSubmitting]);

  /**
   * 按独立危险动作执行 Reset 更新，并复用正式 Update Project 的结果处理链路。
   */
  const submitUpdateResetDialogAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot) return;
    const basePayload = { updateMethod: "reset" };
    setUpdateResetSubmitting(true);
    setUpdateResetDialogOpen(false);
    setUpdateResetSnapshot(null);
    await continueUpdateWithRuntimeScopeAsync(repoRoot, basePayload, async (runtimePayload) => {
      const res = await runFlowAsync(repoRoot, "pull", runtimePayload);
      await handlePullLikeResultAsync("pull", res, {
        fallbackMessage: gt("workbench.updateReset.failed", "重置更新失败"),
        retryAsync: async (payloadPatch) => {
          await retryPullUpdateAsync(runtimePayload, {
            ...(payloadPatch || {}),
            updateMethod: "reset",
          });
        },
        trackedBranchContinueMode: "reset",
      });
    });
    setUpdateResetSubmitting(false);
  }, [continueUpdateWithRuntimeScopeAsync, handlePullLikeResultAsync, repoRoot, retryPullUpdateAsync]);

  /**
   * 保存 Update Options 正式配置，并在顶部提示本次持久化结果。
   */
  const submitUpdateOptionsDialogAsync = useCallback(async (options: GitUpdateOptions): Promise<void> => {
    if (!repoRoot) return;
    setUpdateOptionsSubmitting(true);
    const res = await saveUpdateOptionsAsync(repoRoot, options);
    setUpdateOptionsSubmitting(false);
    if (!res.ok || !res.data) {
      setError(toErrorText(res.error, gt("workbench.updateOptions.saveFailed", "保存 Update Options 失败")));
      return;
    }
    setUpdateOptionsSnapshot(res.data);
    setUpdateOptionsDialogOpen(false);
    finalizeGitNotice({
      action: "update.options",
      tone: "info",
      message: gitWorkbenchText("workbench.misc.updateOptions.saved", "已保存更新项目选项：{{updateMethod}}；save changes policy 已记录为 {{policy}}", {
        updateMethod: getUpdateMethodPreferenceLabel(res.data.options.updateMethod),
        policy: getSaveChangesPolicyLabel(res.data.options.saveChangesPolicy),
      }),
    });
  }, [finalizeGitNotice, repoRoot]);

  /**
   * 统一应用 Push 左侧树节点选择，仓库节点使用空哈希表示“整体总览”。
   */
  const applyPushTreeSelection = useCallback((rowKey: string): void => {
    if (rowKey === "__repo__") {
      setPushSelectedCommitHash("");
      return;
    }
    setPushSelectedCommitHash(String(rowKey || "").trim());
  }, []);

  /**
   * 切换 Push 仓库节点展开状态；收起时自动回退到仓库总览，避免隐藏选中项。
   */
  const setPushRepoExpanded = useCallback((nextExpanded: boolean): void => {
    setPushRepoCommitsExpanded(nextExpanded);
    if (!nextExpanded && String(pushSelectedCommitHash || "").trim()) setPushSelectedCommitHash("");
  }, [pushSelectedCommitHash]);

  /**
   * 处理 Push 左侧树的键盘导航，行为尽量对齐 IDEA 的树选择体验。
   */
  const handlePushTreeKeyboardNavigation = useCallback((event: KeyboardEvent): void => {
    if (!pushDialogOpen || pushDialogLoading) return;
    const target = event.target as HTMLElement | null;
    const tagName = String(target?.tagName || "").toUpperCase();
    if (target?.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return;
    const selectedKey = String(pushSelectedCommitHash || "").trim() || "__repo__";
    const currentIndex = Math.max(0, pushTreeRows.findIndex((row) => row.key === selectedKey));
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextRow = pushTreeRows[Math.min(pushTreeRows.length - 1, currentIndex + 1)];
      if (nextRow) applyPushTreeSelection(nextRow.key);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const nextRow = pushTreeRows[Math.max(0, currentIndex - 1)];
      if (nextRow) applyPushTreeSelection(nextRow.key);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      applyPushTreeSelection("__repo__");
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const lastRow = pushTreeRows[pushTreeRows.length - 1];
      if (lastRow) applyPushTreeSelection(lastRow.key);
      return;
    }
    if (event.key === "ArrowLeft") {
      if (selectedKey !== "__repo__") {
        event.preventDefault();
        applyPushTreeSelection("__repo__");
        return;
      }
      if (pushRepoCommitsExpanded && (pushPreview?.commits.length || 0) > 0) {
        event.preventDefault();
        setPushRepoExpanded(false);
      }
      return;
    }
    if (event.key === "ArrowRight") {
      if (!pushRepoCommitsExpanded && (pushPreview?.commits.length || 0) > 0) {
        event.preventDefault();
        setPushRepoExpanded(true);
        return;
      }
      if (selectedKey === "__repo__") {
        const firstCommit = pushPreview?.commits?.[0];
        if (firstCommit) {
          event.preventDefault();
          applyPushTreeSelection(firstCommit.hash);
        }
      }
    }
  }, [applyPushTreeSelection, pushDialogLoading, pushDialogOpen, pushPreview?.commits, pushRepoCommitsExpanded, pushSelectedCommitHash, pushTreeRows, setPushRepoExpanded]);

  /**
   * 执行 push/pull/fetch 流程动作。
   */
  const runFlowActionAsync = useCallback(
    async (action: "push" | "pull" | "fetch"): Promise<void> => {
      if (!repoRoot) return;
      if (action === "push") {
        await openPushDialogAsync();
        return;
      }
      if (action === "fetch") {
        openFetchDialogAsync();
        return;
      }
      setError("");
      if (action === "pull") {
        await continueUpdateWithRuntimeScopeAsync(repoRoot, {}, async (runtimePayload) => {
          setLoadingFlow(true);
          const res = await runFlowAsync(repoRoot, action, runtimePayload);
          setLoadingFlow(false);
          await handlePullLikeResultAsync("pull", res, {
            fallbackMessage: gt("workbench.update.failed", "更新失败"),
            retryAsync: async (payloadPatch) => {
              await retryPullUpdateAsync(runtimePayload, payloadPatch);
            },
          });
        });
        return;
      }
    },
    [continueUpdateWithRuntimeScopeAsync, handlePullLikeResultAsync, openFetchDialogAsync, openPushDialogAsync, repoRoot, retryPullUpdateAsync],
  );

  hostActionHandlersRef.current = {
    openCommitStage: () => {},
    openPushDialogAsync: async () => {
      await openPushDialogAsync();
    },
    openPullDialogAsync: async () => {
      await openPullDialogAsync();
    },
    openFetchDialogAsync: async () => {
      openFetchDialogAsync();
    },
    runUpdateProjectAsync: async () => {
      await runFlowActionAsync("pull");
    },
    openUpdateOptionsDialogAsync: async () => {
      await openUpdateOptionsDialogAsync();
    },
    openConflictResolver: () => {
      openConflictResolverDialog({
        reverseMerge: statusRef.current?.operationState === "rebasing",
      });
    },
    openCreateStashDialogAsync: async () => {
      await openCreateStashDialogAsync();
    },
    openSavedChangesView: () => {
      if (leftCollapsed) setLeftCollapsed(false);
      setLeftTab("shelve");
    },
  };

  /**
   * 仅刷新分支 popup 快照，供收藏切换与弹窗初始化复用，避免把整页状态都拉一遍。
   */
  const reloadBranchPopupAsync = useCallback(async (options?: {
    preferredRepoRoot?: string;
    preferredStep?: GitBranchPopupStep;
    resetQuery?: boolean;
  }): Promise<GitBranchPopupSnapshot | null> => {
    if (!repoRoot) return null;
    const res = await getBranchPopupAsync(repoRoot);
    if (!res.ok || !res.data) {
      setError(getErrorText(res.error, "workbench.branches.loadFailed", "读取分支列表失败"));
      return null;
    }
    setBranchPopup(res.data);
    setRepoBranch(String(res.data.currentBranch || "HEAD"));
    setRepoDetached(!!res.data.detached);
    setBranchSelectedRepoRoot(String(options?.preferredRepoRoot || res.data.selectedRepoRoot || "").trim());
    setBranchPopupStep(options?.preferredStep || (res.data.multiRoot ? "repositories" : "branches"));
    if (options?.resetQuery === true) {
      setBranchPopupQuery("");
      setBranchPopupIndex(0);
    }
    return res.data;
  }, [repoRoot]);

  /**
   * 对分支快照刷新做一次短暂去抖，避免 fetch/commit 等连续成功动作导致分支状态重复拉取。
   */
  const scheduleBranchPopupReload = useCallback((options?: {
    preferredRepoRoot?: string;
    preferredStep?: GitBranchPopupStep;
  }): void => {
    if (branchSyncRefreshTimerRef.current) {
      window.clearTimeout(branchSyncRefreshTimerRef.current);
      branchSyncRefreshTimerRef.current = null;
    }
    branchSyncRefreshTimerRef.current = window.setTimeout(() => {
      branchSyncRefreshTimerRef.current = null;
      void reloadBranchPopupAsync(options);
    }, 120);
  }, [reloadBranchPopupAsync]);

  /**
   * 切换项目级分支同步开关；成功后只重载分支快照，不触发整页刷新。
   */
  const setBranchSyncEnabledAsync = useCallback(async (enabled: boolean): Promise<void> => {
    const targetRepoRoot = String(selectedBranchRepository?.repoRoot || branchSelectedRepoRoot || repoRoot || "").trim();
    if (!targetRepoRoot) return;
    const res = await runBranchActionAsync(targetRepoRoot, {
      action: "setSyncEnabled",
      enabled,
    });
    if (!res.ok) {
      setError(getErrorText(
        res.error,
        enabled ? "workbench.branches.syncEnableFailed" : "workbench.branches.syncDisableFailed",
        enabled ? "开启分支同步失败" : "关闭分支同步失败",
      ));
      return;
    }
    await reloadBranchPopupAsync({
      preferredRepoRoot: targetRepoRoot,
      preferredStep: branchPopupStep,
    });
    finalizeGitNotice({
      requestId: res.meta?.requestId,
      action: "branch.action",
      tone: "info",
      message: enabled
        ? gt("workbench.branches.syncEnabled", "已开启分支同步")
        : gt("workbench.branches.syncDisabled", "已关闭分支同步"),
    });
  }, [branchPopupStep, branchSelectedRepoRoot, finalizeGitNotice, reloadBranchPopupAsync, repoRoot, selectedBranchRepository?.repoRoot]);

  /**
   * 切换“只看我的分支”开关；成功后仅重载分支快照，保持当前仓与 step 不丢失。
   */
  const setBranchShowOnlyMyAsync = useCallback(async (enabled: boolean): Promise<void> => {
    const targetRepoRoot = String(selectedBranchRepository?.repoRoot || branchSelectedRepoRoot || repoRoot || "").trim();
    if (!targetRepoRoot) return;
    const res = await runBranchActionAsync(targetRepoRoot, {
      action: "setShowOnlyMy",
      enabled,
    });
    if (!res.ok) {
      setError(getErrorText(
        res.error,
        enabled ? "workbench.branches.myBranchesEnableFailed" : "workbench.branches.myBranchesDisableFailed",
        enabled ? "开启我的分支筛选失败" : "关闭我的分支筛选失败",
      ));
      return;
    }
    await reloadBranchPopupAsync({
      preferredRepoRoot: targetRepoRoot,
      preferredStep: branchPopupStep,
    });
    finalizeGitNotice({
      requestId: res.meta?.requestId,
      action: "branch.action",
      tone: "info",
      message: enabled
        ? gt("workbench.branches.myBranchesEnabled", "已开启只看我的分支")
        : gt("workbench.branches.myBranchesDisabled", "已关闭只看我的分支"),
    });
  }, [branchPopupStep, branchSelectedRepoRoot, finalizeGitNotice, reloadBranchPopupAsync, repoRoot, selectedBranchRepository?.repoRoot]);

  /**
   * 按目标仓根打开远端管理对话框，统一承接 configure/edit/remove remote 的当前架构等价实现。
   */
  const openBranchRemoteManagerDialog = useCallback((targetRepoRoot?: string): void => {
    const actionRepoRoot = String(targetRepoRoot || selectedBranchRepository?.repoRoot || branchSelectedRepoRoot || repoRoot || "").trim();
    if (!actionRepoRoot) return;
    setBranchRemoteManagerDialogState({
      repoRoot: actionRepoRoot,
    });
  }, [branchSelectedRepoRoot, repoRoot, selectedBranchRepository?.repoRoot]);

  /**
   * 通过统一表单新增或编辑远端；保存后重载 branch popup 快照，确保远端分组与分支引用同步刷新。
   */
  const openBranchRemoteEditorAsync = useCallback(async (
    targetRepoRoot?: string,
    remoteName?: string,
  ): Promise<void> => {
    const actionRepoRoot = String(targetRepoRoot || selectedBranchRepository?.repoRoot || branchSelectedRepoRoot || repoRoot || "").trim();
    if (!actionRepoRoot) return;
    const repository = resolveSelectedBranchPopupRepository(branchPopup, actionRepoRoot) || selectedBranchRepository || null;
    const existingRemote = (repository?.remotes || []).find((item) => String(item.name || "").trim() === String(remoteName || "").trim()) || null;
    const form = await openActionDialogAsync({
      title: existingRemote
        ? buildGitDialogText("actionDialogs.remoteEditor.editTitle", "编辑远端")
        : buildGitDialogText("actionDialogs.remoteEditor.addTitle", "新增远端"),
      description: existingRemote
        ? buildGitDialogText("actionDialogs.remoteEditor.editDescription", "更新远端 {{name}} 的名称与地址", { name: existingRemote.name })
        : buildGitDialogText("actionDialogs.remoteEditor.addDescription", "添加新的 Git 远端配置"),
      confirmText: existingRemote
        ? buildGitDialogText("actionDialogs.remoteEditor.saveConfirm", "保存")
        : buildGitDialogText("actionDialogs.remoteEditor.addConfirm", "新增"),
      fields: [
        {
          key: "name",
          label: buildGitDialogText("actionDialogs.remoteEditor.nameLabel", "远端名称"),
          placeholder: buildGitDialogText("actionDialogs.remoteEditor.namePlaceholder", "origin"),
          required: true,
        },
        {
          key: "url",
          label: buildGitDialogText("actionDialogs.remoteEditor.fetchUrlLabel", "获取地址"),
          placeholder: buildGitDialogText("actionDialogs.remoteEditor.fetchUrlPlaceholder", "https://example.com/repo.git"),
          required: true,
        },
        { key: "pushUrl", label: buildGitDialogText("actionDialogs.remoteEditor.pushUrlLabel", "推送地址"), placeholder: buildGitDialogText("actionDialogs.remoteEditor.pushUrlPlaceholder", "留空则沿用获取地址") },
      ],
      defaults: {
        name: existingRemote?.name || "",
        url: existingRemote?.fetchUrl || "",
        pushUrl: existingRemote?.pushUrl || existingRemote?.fetchUrl || "",
      },
    });
    if (!form) return;
    const payload = existingRemote
      ? {
          action: "editRemote",
          name: existingRemote.name,
          nextName: String(form.name || "").trim(),
          url: String(form.url || "").trim(),
          pushUrl: String(form.pushUrl || "").trim() || undefined,
        }
      : {
          action: "addRemote",
          name: String(form.name || "").trim(),
          url: String(form.url || "").trim(),
          pushUrl: String(form.pushUrl || "").trim() || undefined,
        };
    const res = await runBranchActionAsync(actionRepoRoot, payload);
    if (!res.ok) {
      setError(getErrorText(
        res.error,
        existingRemote ? "workbench.branches.remote.editFailed" : "workbench.branches.remote.addFailed",
        existingRemote ? "编辑远端失败" : "新增远端失败",
      ));
      return;
    }
    await reloadBranchPopupAsync({
      preferredRepoRoot: actionRepoRoot,
      preferredStep: branchPopupStep,
    });
    finalizeGitNotice({
      requestId: res.meta?.requestId,
      action: "branch.action",
      tone: "info",
      message: existingRemote
        ? gitWorkbenchText("flow.remoteUpdated", "已更新远端 '{{name}}'", { name: String(payload.name || "").trim() })
        : gitWorkbenchText("flow.remoteAdded", "已新增远端 '{{name}}'", { name: String(payload.name || "").trim() }),
    });
  }, [branchPopup, branchPopupStep, branchSelectedRepoRoot, finalizeGitNotice, openActionDialogAsync, reloadBranchPopupAsync, repoRoot, selectedBranchRepository]);

  /**
   * 移除远端配置；先二次确认，再刷新分支弹窗与远端管理视图。
   */
  const removeBranchRemoteAsync = useCallback(async (
    remoteName: string,
    targetRepoRoot?: string,
  ): Promise<void> => {
    const actionRepoRoot = String(targetRepoRoot || selectedBranchRepository?.repoRoot || branchSelectedRepoRoot || repoRoot || "").trim();
    const normalizedRemoteName = String(remoteName || "").trim();
    if (!actionRepoRoot || !normalizedRemoteName) return;
    const form = await openActionDialogAsync({
      title: buildGitDialogText("actionDialogs.remoteEditor.removeTitle", "移除远端"),
      description: buildGitDialogText("actionDialogs.remoteEditor.removeDescription", "确定移除远端 {{name}} 吗？", { name: normalizedRemoteName }),
      confirmText: buildGitDialogText("actionDialogs.remoteEditor.removeConfirm", "移除"),
      fields: [],
    });
    if (!form) return;
    const res = await runBranchActionAsync(actionRepoRoot, {
      action: "removeRemote",
      name: normalizedRemoteName,
    });
    if (!res.ok) {
      setError(getErrorText(res.error, "workbench.branches.remote.removeFailed", "移除远端失败"));
      return;
    }
    await reloadBranchPopupAsync({
      preferredRepoRoot: actionRepoRoot,
      preferredStep: branchPopupStep,
    });
    finalizeGitNotice({
      requestId: res.meta?.requestId,
      action: "branch.action",
      tone: "info",
      message: gitWorkbenchText("flow.remoteRemoved", "已移除远端 '{{name}}'", { name: normalizedRemoteName }),
    });
  }, [branchPopupStep, branchSelectedRepoRoot, finalizeGitNotice, openActionDialogAsync, reloadBranchPopupAsync, repoRoot, selectedBranchRepository?.repoRoot]);

  /**
   * 切换分支收藏状态后重载 popup/tree 快照，统一保持收藏分组、次级文本和星标展示一致。
   */
  const toggleBranchFavoriteAsync = useCallback(async (
    item: GitBranchItem,
    repoRootOverride?: string,
    section?: "favorites" | "recent" | "local" | "remote",
  ): Promise<void> => {
    const targetRepoRoot = String(repoRootOverride || item.repoRoot || branchSelectedRepoRoot || repoRoot || "").trim();
    const branchName = String(item.name || "").trim();
    const storedSection = String((item as GitBranchItem & { section?: string }).section || "").trim();
    const refKind = (section === "remote" || (section === "favorites" && storedSection === "remote")) ? "remote" : "local";
    if (!targetRepoRoot || !branchName) return;
    const res = await runBranchActionAsync(targetRepoRoot, {
      action: "toggleFavorite",
      refKind,
      name: branchName,
      favorite: item.favorite !== true,
    });
    if (!res.ok) {
      setError(getErrorText(
        res.error,
        item.favorite ? "workbench.branches.favoriteRemoveFailed" : "workbench.branches.favoriteAddFailed",
        item.favorite ? "取消收藏失败" : "收藏分支失败",
      ));
      return;
    }
    await reloadBranchPopupAsync({
      preferredRepoRoot: targetRepoRoot,
      preferredStep: branchPopupStep,
    });
  }, [branchPopupStep, branchSelectedRepoRoot, reloadBranchPopupAsync, repoRoot]);

  /**
   * 处理分支弹窗动作（快捷动作 + 分支签出）。
   */
  const applyBranchPopupRowAsync = useCallback(
    async (row: BranchPopupRow): Promise<void> => {
      const targetRepoRoot = String(
        row.kind === "branch" || row.kind === "repository" || row.kind === "back"
          ? row.repoRoot
          : ((row.kind === "action" ? row.repoRoot : "") || selectedBranchRepository?.repoRoot || branchSelectedRepoRoot || repoRoot || ""),
      ).trim();
      if (!repoRoot) return;
      if (row.kind === "repository") {
        setBranchSelectedRepoRoot(row.repoRoot);
        setBranchPopupStep("branches");
        setBranchPopupIndex(0);
        return;
      }
      if (row.kind === "back") {
        setBranchPopupStep("repositories");
        setBranchPopupIndex(0);
        return;
      }
      if (row.kind === "branch") {
        const previousBranch = targetRepoRoot === repoRoot
          ? String(repoBranch || "").trim()
          : String(selectedBranchRepository?.currentBranch || "").trim();
        const res = await switchBranchAsync(targetRepoRoot, row.name);
        if (!res.ok) {
          const nextOperationProblem = extractOperationProblem(res.data);
          if (nextOperationProblem) {
            setBranchPopupOpen(false);
            openOperationProblemDialog(nextOperationProblem, async (payloadPatch) => {
              await retryCheckoutBranchAsync(row.name, {}, payloadPatch, previousBranch, targetRepoRoot);
            });
            return;
          }
          setError(getErrorText(res.error, "workbench.branch.checkoutFailed", "切换分支失败"));
          return;
        }
        setBranchPopupOpen(false);
        await finishBranchCheckoutAsync({
          requestId: res.meta?.requestId,
          action: "branch.switch",
          repoRootOverride: targetRepoRoot,
          targetBranch: row.name,
          previousBranch,
          data: res.data,
        });
        return;
      }
      if (row.kind !== "action") return;

      if (row.id === "update") {
        await runFlowActionAsync("pull");
        setBranchPopupOpen(false);
        return;
      }
      if (row.id === "commit") {
        activateCommitWorkflow();
        setBranchPopupOpen(false);
        return;
      }
      if (row.id === "push") {
        await runFlowActionAsync("push");
        setBranchPopupOpen(false);
        return;
      }
      if (row.id === "newBranch") {
        const form = await openActionDialogAsync(buildCreateBranchDialogConfig({
          description: buildGitDialogText("actionDialogs.branch.newDescription", "请输入新分支名称"),
        }));
        if (!form) return;
        const res = await runBranchActionAsync(targetRepoRoot, { action: "new", name: form.name });
        if (!res.ok) {
          setError(getErrorText(res.error, "workbench.branch.createFailed", "新建分支失败"));
          return;
        }
        setBranchPopupOpen(false);
        await refreshAllAsync({ keepLog: false });
        return;
      }
      if (row.id === "checkoutRevision") {
        const form = await openActionDialogAsync({
          title: buildGitDialogText("actionDialogs.checkoutRevision.title", "签出标签或修订"),
          description: buildGitDialogText("actionDialogs.checkoutRevision.description", "请输入标签名称或提交哈希"),
          confirmText: buildGitDialogText("actionDialogs.checkoutRevision.confirm", "签出"),
          fields: [{ key: "revision", label: buildGitDialogText("actionDialogs.checkoutRevision.label", "标签 / 修订"), placeholder: buildGitDialogText("actionDialogs.checkoutRevision.placeholder", "v1.0.0 或 a1b2c3d"), required: true }],
        });
        if (!form) return;
        const res = await runBranchActionAsync(targetRepoRoot, { action: "checkoutRevision", revision: form.revision });
        if (!res.ok) {
          setError(getErrorText(res.error, "workbench.branch.checkoutRevisionFailed", "签出修订失败"));
          return;
        }
        setBranchPopupOpen(false);
        await refreshAllAsync({ keepLog: false });
        return;
      }
      if (row.id === "configureRemotes") {
        setBranchPopupOpen(false);
        openBranchRemoteManagerDialog(targetRepoRoot);
      }
    },
    [activateCommitWorkflow, branchSelectedRepoRoot, finishBranchCheckoutAsync, openActionDialogAsync, openBranchRemoteManagerDialog, openOperationProblemDialog, refreshAllAsync, repoBranch, repoRoot, retryCheckoutBranchAsync, runFlowActionAsync, selectedBranchRepository?.currentBranch, selectedBranchRepository?.repoRoot],
  );

  /**
   * 统一处理 branch popup header 与 quick action，收敛 fetch/settings/快捷入口的分发逻辑。
   */
  const runBranchPopupActionAsync = useCallback(async (actionId: GitBranchPopupActionKey): Promise<void> => {
    if (actionId === "fetch") {
      await runFlowActionAsync("fetch");
      return;
    }
    if (actionId === "toggleSyncEnabled") {
      await setBranchSyncEnabledAsync(branchPopup?.syncEnabled === false);
      return;
    }
    if (actionId === "toggleShowOnlyMy") {
      await setBranchShowOnlyMyAsync(!(branchPopup?.showOnlyMy === true));
      return;
    }
    if (actionId === "configureRemotes") {
      openBranchRemoteManagerDialog();
      return;
    }
    const row = branchRows.find((candidate) => candidate.kind === "action" && candidate.id === actionId);
    if (row?.kind === "action") await applyBranchPopupRowAsync(row);
  }, [
    applyBranchPopupRowAsync,
    branchPopup?.showOnlyMy,
    branchPopup?.syncEnabled,
    branchRows,
    openBranchRemoteManagerDialog,
    runFlowActionAsync,
    setBranchShowOnlyMyAsync,
    setBranchSyncEnabledAsync,
  ]);

  /**
   * 在真正发起提交前校验 partial selection 与最新 Diff 快照是否仍然一致；
   * 若底层指纹已变化，则清理失效选区并阻止继续提交，避免静默退化成整文件提交。
   */
  const resolveCommitWorkflowPayloadAsync = useCallback(
    async (args: { message: string; intent: GitCommitIntent; entries?: GitStatusEntry[] }): Promise<{ ok: true; payload: ReturnType<typeof buildCommitWorkflowPayload> } | { ok: false; error: string }> => {
      if (!repoRoot) return { ok: false, error: gt("workbench.commit.blocked.repoUnavailable", "当前仓库不可用") };

      const buildPayload = (state: PartialCommitSelectionState) => (
        args.entries && args.entries.length > 0
          ? buildCommitWorkflowPayloadFromEntries(
              args.entries,
              state,
              repoRoot,
              args.message,
              args.intent,
              commitAdvancedOptionsState,
              commitHooksAvailability,
            )
          : buildCommitWorkflowPayload(
              commitInclusionState,
              state,
              repoRoot,
              args.message,
              args.intent,
              commitAdvancedOptionsState,
              commitHooksAvailability,
              status?.entries || [],
            )
      );

      let nextPartialState = partialCommitSelectionState;
      let nextPayload = buildPayload(nextPartialState);
      const partialSelections = nextPayload.selections.filter((item) => item.selectionMode === "partial");
      if (partialSelections.length === 0) return { ok: true, payload: nextPayload };

      for (const selection of partialSelections) {
        const selectionRepoRoot = normalizeCommitRepoRoot(selection.repoRoot || repoRoot);
        const entry = (args.entries || []).find((candidate) => (
          candidate.path === selection.path
          && normalizeCommitRepoRoot(candidate.repositoryRoot || repoRoot) === selectionRepoRoot
        ))
          || statusEntryByScopedPath.get(buildCommitInclusionLookupKey(selection.path, selectionRepoRoot))
          || statusEntryByPath.get(selection.path);
        if (!entry || entry.untracked || entry.ignored) continue;
        const partialEntry = getPartialCommitSelectionEntry(nextPartialState, selection.path, selectionRepoRoot);
        const diffRes = await getDiffAsync(selectionRepoRoot || repoRoot, {
          path: selection.path,
          mode: resolvePartialCommitValidationDiffMode({
            partialEntry,
            entry,
          }),
        });
        if (!diffRes.ok || !diffRes.data) {
          return {
            ok: false,
            error: toErrorText(diffRes.error, gitWorkbenchText("commit.partialSelectionCheckFailed", "校验文件 '{{path}}' 的部分提交选区失败", { path: selection.path })),
          };
        }
        const syncRes = syncPartialCommitSelectionWithSnapshot(nextPartialState, {
          path: selection.path,
        repoRoot: normalizeCommitRepoRoot(entry.repositoryRoot || repoRoot),
        changeListId: String(entry.changeListId || "default").trim() || "default",
        snapshot: diffRes.data,
      });
        nextPartialState = syncRes.state;
        if (syncRes.invalidatedPath) {
          setPartialCommitSelectionState(nextPartialState);
          return {
            ok: false,
            error: gitWorkbenchText("commit.partialSelectionInvalidated", "文件 '{{path}}' 的部分提交选区已失效，请重新选择后再提交", { path: syncRes.invalidatedPath }),
          };
        }
      }

      if (nextPartialState !== partialCommitSelectionState) {
        setPartialCommitSelectionState(nextPartialState);
      }
      nextPayload = buildPayload(nextPartialState);
      return { ok: true, payload: nextPayload };
    },
    [commitAdvancedOptionsState, commitHooksAvailability, commitInclusionState, partialCommitSelectionState, repoRoot, status?.entries, statusEntryByPath, statusEntryByScopedPath],
  );

  /**
   * 在真正提交前补齐 merge exclusion 确认；merge 中若仍有 tracked changes 被排除在本次提交之外，则先弹确认框。
   */
  const ensureMergePrecheckConfirmedAsync = useCallback(async (
    payload: ReturnType<typeof buildCommitWorkflowPayload>,
  ): Promise<ReturnType<typeof buildCommitWorkflowPayload> | null> => {
    const precheck = resolveMergeExclusionPrecheck({
      status,
      payload,
      fallbackRepoRoot: repoRoot,
    });
    if (!precheck.requiresConfirmation) return payload;
    const previewEntries = precheck.excludedEntries
      .slice(0, 5)
      .map((entry) => entry.path)
      .filter(Boolean);
    const description = gitWorkbenchText("commit.mergePrecheckConflictSummary", "当前仓库正处于合并过程中，仍有 {{count}} 项已跟踪变更未纳入本次提交。", { count: precheck.excludedEntries.length })
      + (previewEntries.length > 0
        ? gitWorkbenchText("commit.mergePrecheckPreview", "未纳入的示例：{{examples}}{{suffix}}", {
            examples: previewEntries.join("、"),
            suffix: precheck.excludedEntries.length > previewEntries.length ? " 等。" : "。",
          })
        : gt("commit.mergePrecheckRemainingHint", "若继续提交，剩余变更将留在工作区等待后续处理。"));
    const confirmed = await openActionDialogAsync({
      title: gt("commit.mergePrecheckTitle", "存在未纳入提交的合并变更"),
      description,
      confirmText: gt("commit.mergePrecheckConfirm", "仍然提交"),
      fields: [],
    });
    if (!confirmed) return null;
    return {
      ...payload,
      mergeExclusionConfirmed: true,
    };
  }, [openActionDialogAsync, repoRoot, status]);

  /**
   * 统一确认后端 precheck 返回的 warning，避免主提交与右键提交各自维护一套重复弹窗逻辑。
   */
  const confirmCommitWarningChecksAsync = useCallback(async (
    checks: GitCommitCheck[],
  ): Promise<string[] | null> => {
    const normalizedChecks = checks.filter((check) => check.confirmationRequired === true);
    if (normalizedChecks.length <= 0) return [];
    const description = normalizedChecks
      .map((check) => `- ${check.message}`)
      .join("\n");
    const confirmed = await openActionDialogAsync({
      title: gt("commit.warningChecks.title", "提交前存在需要确认的风险"),
      description,
      confirmText: gt("commit.warningChecks.confirm", "继续提交"),
      fields: [],
    });
    if (!confirmed) return null;
    return normalizedChecks
      .map((check) => String(check.id || "").trim())
      .filter(Boolean);
  }, [openActionDialogAsync]);

  /**
   * 统一重置提交草稿状态，确保主提交、提交并推送与右键提交成功后使用同一清理口径。
   */
  const resetCommitComposerState = useCallback((options?: { preserveChangeListDraftOptions?: boolean }): void => {
    clearCommitAmendRuntimeState(false);
    setCommitMessage("");
    setCommitAmendEnabled(false);
    restoredChangeListDraftListIdRef.current = "";
    setCommitAdvancedOptionsState((prev) => {
      const defaultState = createCommitAdvancedOptionsState({ runHooks: commitHooksAvailability.runByDefault });
      if (options?.preserveChangeListDraftOptions !== true) return defaultState;
      const sanitized = sanitizeCommitAdvancedOptionsState(prev);
      return {
        ...defaultState,
        author: sanitized.author,
        authorDate: sanitized.authorDate,
        commitRenamesSeparately: sanitized.commitRenamesSeparately,
      };
    });
    setCommitOptionsOpen(false);
  }, [clearCommitAmendRuntimeState, commitHooksAvailability.runByDefault]);

  /**
   * 提交成功后清空当前 changelist 的消息草稿，但保留 author/authorDate/rename 选项以便后续继续复用。
   */
  const clearActiveChangeListDraftMessageAsync = useCallback(async (): Promise<void> => {
    if (!repoRoot || !activeChangeListId || !activeChangeList || activeChangeList.readOnly) return;
    if (!localChangesConfig.changeListsEnabled || localChangesConfig.stagingAreaEnabled) return;
    const patch = buildChangeListCommitDraftPatch(activeChangeList, {
      ...currentCommitComposerDraft,
      message: "",
    });
    const res = await updateChangeListDataAsync(repoRoot, activeChangeListId, patch);
    if (!res.ok) {
      setError(getErrorText(res.error, "workbench.changelist.clearCommitDraftsFailed", "清理更改列表提交草稿失败"));
      return;
    }
    setStatus((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        changeLists: {
          ...prev.changeLists,
          lists: (prev.changeLists?.lists || []).map((item) => {
            if (String(item.id || "").trim() !== activeChangeListId) return item;
            return {
              ...item,
              comment: patch.comment,
              data: patch.data,
            };
          }),
        },
      };
    });
  }, [
    activeChangeList,
    activeChangeListId,
    currentCommitComposerDraft,
    localChangesConfig.changeListsEnabled,
    localChangesConfig.stagingAreaEnabled,
    repoRoot,
  ]);

  /**
   * 统一执行提交流程，收敛提交/提交并推送/右键提交入口的 payload 组装、merge exclusion 确认、成功清理与 push-after 后续动作。
   */
  const submitGitCommitAsync = useCallback(async (args: {
    message: string;
    intent: GitCommitIntent;
    entries?: GitStatusEntry[];
    amend: boolean;
  }): Promise<boolean> => {
    if (!repoRoot) return false;
    const sanitizedOptions = sanitizeCommitAdvancedOptionsState(commitAdvancedOptionsState);
    const workflowRes = await prepareGitCommitWorkflowAsync({
      message: args.message,
      intent: args.intent,
      cleanupMessage: sanitizedOptions.cleanupMessage,
      explicitAuthor: sanitizedOptions.author,
      defaultAuthor: defaultCommitAuthor,
      authorDate: sanitizedOptions.authorDate,
      entries: args.entries,
      resolvePayloadAsync: resolveCommitWorkflowPayloadAsync,
    });
    if (!workflowRes.ok) {
      if (workflowRes.blockingCheck?.id === "author-missing") setCommitOptionsOpen(true);
      setError(workflowRes.error);
      return false;
    }
    const commitPayload = {
      ...workflowRes.workflow.payload,
      amend: args.amend,
    };
    if (commitPayload.includedItems.length === 0 && !args.amend) {
      setError(gt("commit.blocked.selectFiles", "请先勾选需要提交的文件"));
      return false;
    }
    if (!commitPayload.message) {
      setError(gt("commit.checks.emptyMessage", "提交信息不能为空"));
      return false;
    }

    const initialConfirmedPayload = await ensureMergePrecheckConfirmedAsync(commitPayload);
    if (!initialConfirmedPayload) return false;
    let confirmedPayload = initialConfirmedPayload;

    let res = await createCommitAsync(repoRoot, confirmedPayload);
    for (let retryIndex = 0; retryIndex < 3; retryIndex += 1) {
      if (!res.ok && Array.isArray(res.data?.confirmationChecks) && res.data.confirmationChecks.length > 0) {
        const confirmedCheckIds = await confirmCommitWarningChecksAsync(res.data.confirmationChecks);
        if (!confirmedCheckIds || confirmedCheckIds.length <= 0) return false;
        confirmedPayload = {
          ...confirmedPayload,
          confirmedChecks: Array.from(new Set([
            ...((Array.isArray(confirmedPayload.confirmedChecks) ? confirmedPayload.confirmedChecks : []).map((item: string) => String(item || "").trim()).filter(Boolean)),
            ...confirmedCheckIds,
          ])),
        };
        res = await createCommitAsync(repoRoot, confirmedPayload);
        continue;
      }
      if (!res.ok && res.data?.mergeExclusionRequired === true && confirmedPayload.mergeExclusionConfirmed !== true) {
        const retriedPayload = await ensureMergePrecheckConfirmedAsync({
          ...confirmedPayload,
          mergeExclusionConfirmed: false,
        });
        if (!retriedPayload) return false;
        confirmedPayload = retriedPayload;
        res = await createCommitAsync(repoRoot, confirmedPayload);
        continue;
      }
      break;
    }
    if (!res.ok) {
      if (res.data?.blockingCheck?.id === "author-missing") setCommitOptionsOpen(true);
      if (res.data?.blockingCheck?.id === "unresolved-conflicts") {
        openConflictResolverDialog({
          title: gt("workbench.misc.conflicts.resolveBeforeCommitTitle", "解决提交前冲突"),
          description: gt("workbench.misc.conflicts.resolveBeforeCommitDescription", "当前提交范围内仍存在未解决冲突，请先完成冲突处理后再重新提交。"),
        });
      }
      if (res.data?.commitSucceeded === true) {
        await clearActiveChangeListDraftMessageAsync();
        resetCommitComposerState({ preserveChangeListDraftOptions: true });
        await refreshAllAsync({ keepLog: false });
      } else if (args.amend) {
        clearCommitAmendRuntimeState(true);
        setCommitAmendEnabled(false);
      }
      setError(getErrorText(res.error, "workbench.commit.failed", "提交失败"));
      return false;
    }
    const createdCommitHash = String(res.data?.commitHash || "").trim();
    const postCommitPush = res.data?.postCommitPush;
    const pushAfterCommit = postCommitPush?.mode === "preview"
      ? postCommitPush.context
      : res.data?.pushAfterCommit;
    await clearActiveChangeListDraftMessageAsync();
    resetCommitComposerState({ preserveChangeListDraftOptions: true });
    const successState = finalizeGitCommitWorkflowSuccess({
      message: workflowRes.workflow.message,
      cleanupMessage: sanitizedOptions.cleanupMessage,
      amend: args.amend,
      intent: args.intent,
      commitHash: createdCommitHash,
      postCommitPush,
    });
    if (successState.shouldPersistMessage && typeof window !== "undefined")
      writeLastCommitMessage(window.localStorage, workflowRes.workflow.message);
    if (successState.postChecks.length > 0) {
      finalizeGitNotice({
        requestId: res.meta?.requestId,
        action: "commit.create",
        tone: "info",
        message: successState.postChecks.map((item) => item.message).join(" "),
      });
    }
    await refreshAllAsync({ keepLog: false });
    if (postCommitPush?.mode === "preview" && pushAfterCommit) {
      await openPushAfterCommitAsync(pushAfterCommit);
    }
    return true;
  }, [
    clearActiveChangeListDraftMessageAsync,
    clearCommitAmendRuntimeState,
    commitAdvancedOptionsState,
    confirmCommitWarningChecksAsync,
    defaultCommitAuthor,
    ensureMergePrecheckConfirmedAsync,
    finalizeGitNotice,
    openConflictResolverDialog,
    openPushAfterCommitAsync,
    refreshAllAsync,
    repoRoot,
    resetCommitComposerState,
    resolveCommitWorkflowPayloadAsync,
  ]);

  /**
   * 执行提交。
   */
  const handleCommitAsync = useCallback(
    async (pushAfter: boolean): Promise<void> => {
      if (!repoRoot) return;
      if (!commitAmendEnabled && commitActionBlockedReason) {
        setError(commitActionBlockedReason);
        return;
      }
      await submitGitCommitAsync({
        message: commitMessage,
        intent: resolveGitCommitIntent(pushAfter),
        amend: commitAmendEnabled,
      });
    },
    [commitActionBlockedReason, commitAmendEnabled, commitMessage, repoRoot, submitGitCommitAsync],
  );

  /**
   * 处理提交树真实树行选择（支持 group/目录/文件 + Ctrl/Shift 多选）。
   */
  const selectCommitTreeRow = useCallback(
    (rowKey: string, event: React.MouseEvent): void => {
      if (!rowKey) return;
      if (event.shiftKey && selectedCommitTreeKeys.length > 0) {
        const last = selectedCommitTreeKeys[selectedCommitTreeKeys.length - 1];
        const from = commitVisibleRowKeys.indexOf(last);
        const to = commitVisibleRowKeys.indexOf(rowKey);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const range = commitVisibleRowKeys.slice(start, end + 1);
          applyCommitNodeSelection(range);
          return;
        }
      }
      if (event.ctrlKey || event.metaKey) {
        const next = selectedCommitTreeKeys.includes(rowKey)
          ? selectedCommitTreeKeys.filter((one) => one !== rowKey)
          : [...selectedCommitTreeKeys, rowKey];
        applyCommitNodeSelection(next);
        return;
      }
      applyCommitNodeSelection([rowKey]);
    },
    [applyCommitNodeSelection, commitVisibleRowKeys, selectedCommitTreeKeys],
  );

  /**
   * 处理日志列表提交选择（支持 Ctrl/Shift 多选）。
   */
  const selectCommitHash = useCallback(
    (hash: string, event: React.MouseEvent): void => {
      if (!hash) return;
      if (event.shiftKey && selectedCommitHashes.length > 0) {
        const last = selectedCommitHashes[selectedCommitHashes.length - 1];
        const from = logItems.findIndex((x) => x.hash === last);
        const to = logItems.findIndex((x) => x.hash === hash);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const range = logItems.slice(start, end + 1).map((x) => x.hash);
          setSelectedCommitHashes(range);
          return;
        }
      }
      if (event.ctrlKey || event.metaKey) {
        setSelectedCommitHashes((prev) => (prev.includes(hash) ? prev.filter((x) => x !== hash) : [...prev, hash]));
        return;
      }
      setSelectedCommitHashes([hash]);
    },
    [logItems, selectedCommitHashes],
  );

  /**
   * 处理详情树节点选择（支持文件/文件夹 + Ctrl/Shift 多选）。
   */
  const selectDetailNode = useCallback(
    (nodeKey: string, event: React.MouseEvent): void => {
      if (!nodeKey) return;
      if (event.shiftKey && selectedDetailNodeKeys.length > 0) {
        const last = selectedDetailNodeKeys[selectedDetailNodeKeys.length - 1];
        const from = detailVisibleNodeKeys.indexOf(last);
        const to = detailVisibleNodeKeys.indexOf(nodeKey);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          setSelectedDetailNodeKeys(detailVisibleNodeKeys.slice(start, end + 1));
          return;
        }
      }
      if (event.ctrlKey || event.metaKey) {
        setSelectedDetailNodeKeys((prev) => (prev.includes(nodeKey) ? prev.filter((one) => one !== nodeKey) : [...prev, nodeKey]));
        return;
      }
      setSelectedDetailNodeKeys([nodeKey]);
    },
    [detailVisibleNodeKeys, selectedDetailNodeKeys],
  );

  /**
   * 统一关闭并清空提交详情树 speed search，复用到 Esc、失焦、点击外部与输入清空后的收口逻辑。
   */
  const resetDetailSpeedSearch = useCallback((options?: { restoreFocus?: boolean }): void => {
    setDetailSpeedSearchOpen(false);
    setDetailSpeedSearch("");
    if (options?.restoreFocus)
      window.requestAnimationFrame(() => {
        detailTreeContainerRef.current?.focus();
      });
  }, []);

  /**
   * 把详情树 speed search 的命中节点落成真实选区，并在开启一键预览时同步打开对应 Diff。
   */
  const applyDetailSpeedSearchSelection = useCallback((nodeKey: string): void => {
    if (!nodeKey) return;
    const node = detailNodeByKey.get(nodeKey);
    if (!node) return;
    setActiveSelectionScope("detail");
    setSelectedDetailNodeKeys([nodeKey]);
    if (!viewOptions.detailsPreviewShown || !node.isFile) return;
    const nodeCommitHashes = resolveDetailPathCommitHashes(node.fullPath);
    const activeDetailHash = details?.mode === "single" ? details.detail.hash : (orderedSelectedCommitHashesNewestFirst[0] || "");
    const nodePrimaryHash = nodeCommitHashes[nodeCommitHashes.length - 1] || activeDetailHash;
    if (!nodePrimaryHash) return;
    void openDiffAsync(node.fullPath, "commit", nodePrimaryHash, nodeCommitHashes.length > 1 ? nodeCommitHashes : undefined);
  }, [
    detailNodeByKey,
    details,
    openDiffAsync,
    orderedSelectedCommitHashesNewestFirst,
    resolveDetailPathCommitHashes,
    viewOptions.detailsPreviewShown,
  ]);

  /**
   * 按当前详情树查询跳到上一项或下一项命中，供输入联动与 F3 / Shift+F3 统一复用。
   */
  const applyDetailSpeedSearch = useCallback((query: string, direction: "next" | "previous" = "next"): void => {
    const currentNodeKey = selectedDetailNodeKeys[0] || detailFileRows[0]?.node.key || "";
    const nextNodeKey = findDetailSpeedSearchNodeKey({
      rows: detailFileRows,
      query,
      currentNodeKey,
      direction,
    });
    applyDetailSpeedSearchSelection(nextNodeKey);
  }, [applyDetailSpeedSearchSelection, detailFileRows, selectedDetailNodeKeys]);

  /**
   * 同步提交详情可编辑搜索框内容，沿用现有匹配、选区与 Diff 预览联动逻辑。
   */
  const handleDetailSpeedSearchInputChange = useCallback((nextQuery: string): void => {
    setDetailSpeedSearch(nextQuery);
    if (!nextQuery.trim()) return;
    applyDetailSpeedSearch(nextQuery);
  }, [applyDetailSpeedSearch]);

  useEffect(() => {
    if (!detailSpeedSearchOpen) return;

    /**
     * 点击详情树外部时按 IDEA `focusLost -> manageSearchPopup(null)` 语义关闭并清空当前搜索。
     */
    const handleDetailSpeedSearchOutsideMouseDown = (event: MouseEvent): void => {
      const root = detailTreeSpeedSearchRootRef.current;
      const target = event.target as Node | null;
      if (!root || !target || root.contains(target)) return;
      resetDetailSpeedSearch();
    };

    document.addEventListener("mousedown", handleDetailSpeedSearchOutsideMouseDown, true);
    return () => {
      document.removeEventListener("mousedown", handleDetailSpeedSearchOutsideMouseDown, true);
    };
  }, [detailSpeedSearchOpen, resetDetailSpeedSearch]);

  /**
   * 执行日志右键命令。
   */
  const runLogMenuActionAsync = useCallback(
    async (action: string): Promise<void> => {
      if (!repoRoot) return;
      const hashes = resolveLogActionExecutionHashes({
        action,
        hashesNewestFirst: sortHashesByLogUiOrder(selectedCommitHashes, logItems),
      });
      const hash = hashes[0] || "";
      if (!hash) return;

      if (action === "createPatch") {
        const res = await runLogActionAsync(repoRoot, { action: "createPatch", hash, hashes });
        if (!res.ok) {
          setError(getErrorText(res.error, "workbench.patch.createFailed", "创建补丁失败"));
          return;
        }
        await exportPatchTextAsync(String((res.data as any)?.patch || ""), {
          mode: "save",
          defaultPath: buildPatchExportFileName({ hash, hashes }),
        });
        return;
      }
      if (action === "showRepoAtRevision") {
        const detailRes = await getLogDetailsAsync(repoRoot, [hash]);
        if (!detailRes.ok || !detailRes.data || detailRes.data.mode !== "single") {
          setError(getErrorText(detailRes.error, "workbench.log.revisionDetailsLoadFailed", "读取修订详情失败"));
          return;
        }
        const firstPath = detailRes.data.detail.files[0]?.path || "";
        setSelectedCommitHashes([hash]);
        if (firstPath) await openDiffAsync(firstPath, "commit", hash);
        return;
      }
      if (action === "compareLocal") {
        const detailRes = details?.mode === "single" && details.detail.hash === hash
          ? { ok: true, data: details }
          : await getLogDetailsAsync(repoRoot, [hash]);
        if (!detailRes.ok || !detailRes.data || detailRes.data.mode !== "single") {
          setError(getErrorText(detailRes.error, "workbench.log.revisionDetailsLoadFailed", "读取修订详情失败"));
          return;
        }
        const firstPath = detailRes.data.detail.files[0]?.path || "";
        if (!firstPath) return;
        await openDiffAsync(firstPath, "revisionToWorking", hash);
        return;
      }
      if (action === "gotoParent" || action === "gotoChild") {
        const currentIndex = logItems.findIndex((item) => item.hash === hash);
        if (currentIndex < 0) return;
        const nextIndex = action === "gotoParent" ? currentIndex + 1 : currentIndex - 1;
        const next = logItems[nextIndex];
        if (!next) return;
        setSelectedCommitHashes([next.hash]);
        return;
      }
      if (action === "pushAllPrevious") {
        await openPushDialogAsync(hash);
        return;
      }
      if (action === "interactiveRebase") {
        await openInteractiveRebaseDialogAsync(hash);
        return;
      }
      if (action === "deleteCommit") {
        const editingPrefs = loadGitLogCommitEditingPrefs();
        if (editingPrefs.showDropCommitConfirmation) {
          const form = await openActionDialogAsync(buildDeleteCommitDialogConfig({
            commitCount: hashes.length > 0 ? hashes.length : 1,
            branchName: String(repoBranch || "").trim() || undefined,
          }));
          if (!form) return;
          if (String(form.dontAskAgain || "false") === "true") {
            saveGitLogCommitEditingPrefs({ showDropCommitConfirmation: false });
          }
        }
      }

      const mappedAction = action === "checkoutRevision" ? "checkout" : action;
      const payload: any = { action: mappedAction, hash, hashes };
      if (mappedAction === "newBranch") {
        const selectedItem = logItems.find((one) => one.hash === hash);
        const suggestedName = suggestBranchNameFromDecorations(String(selectedItem?.decorations || ""));
        const form = await openActionDialogAsync(buildCreateBranchDialogConfig({
          description: buildGitDialogText("actionDialogs.branch.fromCommitDescription", "基于当前提交创建新分支"),
          defaultName: suggestedName || undefined,
        }));
        if (!form) return;
        payload.name = form.name;
      }
      if (mappedAction === "newTag") {
        const form = await openActionDialogAsync(buildCreateTagDialogConfig());
        if (!form) return;
        payload.name = form.name;
      }
      if (mappedAction === "reset") {
        const form = await openActionDialogAsync(buildResetCurrentBranchDialogConfig());
        if (!form) return;
        payload.mode = form.mode;
      }
      if (mappedAction === "fixup" || mappedAction === "squashTo") {
        const commitPayloadRes = await resolveCommitWorkflowPayloadAsync({
          message: "",
          intent: "commit",
        });
        if (!commitPayloadRes.ok) {
          setError(commitPayloadRes.error);
          return;
        }
        if (commitPayloadRes.payload.selections.length === 0) {
          setError(gt("commit.blocked.selectFiles", "请先勾选需要提交的文件"));
          return;
        }
        const form = await openActionDialogAsync({
          title: mappedAction === "fixup"
            ? gt("actionDialogs.fixup.title", "创建 Fixup 提交")
            : gt("actionDialogs.squashTo.title", "创建 Squash 提交"),
          description: mappedAction === "fixup"
            ? gt("actionDialogs.fixup.description", "仅基于当前 Git 面板中已选中的 {{count}} 项改动创建自动提交，不会扩大到整仓改动。", { count: commitPayloadRes.payload.selections.length })
            : gt("actionDialogs.squashTo.description", "仅基于当前 Git 面板中已选中的 {{count}} 项改动创建自动提交，不会扩大到整仓改动。", { count: commitPayloadRes.payload.selections.length }),
          confirmText: mappedAction === "fixup"
            ? gt("actionDialogs.fixup.confirm", "继续")
            : gt("actionDialogs.squashTo.confirm", "继续"),
          fields: [],
        });
        if (!form) return;
        payload.commitPayload = commitPayloadRes.payload;
      }
      if (mappedAction === "squashCommits") {
        const draftMessage = await loadLogMessageDraftValueAsync("squashCommits", hashes);
        const form = await openActionDialogAsync({
          title: gt("actionDialogs.squashCommits.title", "压缩提交"),
          description: gt("actionDialogs.squashCommits.description", "将所选连续提交压缩为一个提交（需位于当前分支主线，且工作区干净）。"),
          confirmText: gt("actionDialogs.squashCommits.confirm", "压缩"),
          fields: [{ key: "message", label: gt("actionDialogs.squashCommits.messageLabel", "新提交信息"), placeholder: gt("actionDialogs.squashCommits.messagePlaceholder", "请输入提交信息"), required: true, type: "textarea", rows: 12 }],
          defaults: { message: draftMessage || "squash commits" },
        });
        if (!form) return;
        payload.message = String(form.message || "").trim();
      }
      if (mappedAction === "undoCommit") {
        const undoCommitChangeLists = localChangesConfig.changeListsEnabled && !localChangesConfig.stagingAreaEnabled
          ? displayChangeLists.map((item) => ({ id: item.id, name: item.name }))
          : [];
        const form = await openActionDialogAsync(buildUndoCommitDialogConfig({
          changeLists: undoCommitChangeLists,
          activeChangeListId,
        }));
        if (!form) return;
        const targetChangeListId = String(form.targetChangeListId || "").trim();
        if (targetChangeListId) payload.targetChangeListId = targetChangeListId;
      }
      if (mappedAction === "editMessage") {
        const draftMessage = await loadLogMessageDraftValueAsync("editMessage", [hash]);
        const form = await openActionDialogAsync(buildEditCommitMessageDialogConfig(draftMessage || ""));
        if (!form) return;
        payload.message = String(form.message || "").trim();
      }

      const retryLogActionAsync = async (basePayload: any, payloadPatch: Record<string, any>): Promise<void> => {
        if (!repoRoot) return;
        const mergedPayload = {
          ...(basePayload || {}),
          ...(payloadPatch || {}),
        };
        setOperationProblemDialogOpen(false);
        setOperationProblem(null);
        operationProblemRetryRef.current = null;
        setOperationProblemSubmitting(true);
        const retryRes = await runLogActionAsync(repoRoot, mergedPayload);
        setOperationProblemSubmitting(false);
        const retryHistoryRewriteFeedback = extractHistoryRewriteFeedback(retryRes.data);
        if (!retryRes.ok) {
          if (retryHistoryRewriteFeedback) {
            await presentHistoryRewriteFeedbackAsync(retryHistoryRewriteFeedback, { requestId: retryRes.meta?.requestId });
            return;
          }
          const nextOperationProblem = extractOperationProblem(retryRes.data);
          const operationFailureFeedback = resolveLogActionOperationFailureFeedback({
            action: mappedAction,
            error: retryRes.error,
            data: retryRes.data,
          });
          const noticeActions = buildPreservingNoticeActions(retryRes.data);
          if (retryRes.data?.shouldRefresh === true || operationFailureFeedback?.shouldRefresh) {
            await refreshAllAsync({ keepLog: false });
          }
          if (nextOperationProblem) {
            openOperationProblemDialog(nextOperationProblem, async (nextPayloadPatch) => {
              await retryLogActionAsync(mergedPayload, nextPayloadPatch);
            });
            return;
          }
          if (operationFailureFeedback) {
            setError("");
            removeGitNoticeByRequestId(retryRes.meta?.requestId);
            return;
          }
          if (noticeActions.length > 0) {
            finalizeGitNotice({
              requestId: retryRes.meta?.requestId,
              action: `log.${mappedAction}`,
              tone: "warn",
              message: getErrorText(retryRes.error, "workbench.log.actionFailed", "执行 Git 日志动作失败"),
              actions: noticeActions,
            });
            return;
          }
          setError(getErrorText(retryRes.error, "workbench.log.actionFailed", "执行 Git 日志动作失败"));
          return;
        }
        if (retryHistoryRewriteFeedback) {
          await presentHistoryRewriteFeedbackAsync(retryHistoryRewriteFeedback, { requestId: retryRes.meta?.requestId });
          return;
        }
        await refreshAllAsync({ keepLog: false });
      };

      const res = await runLogActionAsync(repoRoot, payload);
      const historyRewriteFeedback = extractHistoryRewriteFeedback(res.data);
      if (!res.ok) {
        if (historyRewriteFeedback) {
          await presentHistoryRewriteFeedbackAsync(historyRewriteFeedback, { requestId: res.meta?.requestId });
          return;
        }
        const nextOperationProblem = extractOperationProblem(res.data);
        const operationFailureFeedback = resolveLogActionOperationFailureFeedback({
          action: mappedAction,
          error: res.error,
          data: res.data,
        });
        const noticeActions = buildPreservingNoticeActions(res.data);
        if (res.data?.shouldRefresh === true || operationFailureFeedback?.shouldRefresh) {
          await refreshAllAsync({ keepLog: false });
        }
        if (nextOperationProblem) {
          openOperationProblemDialog(nextOperationProblem, async (payloadPatch) => {
            await retryLogActionAsync(payload, payloadPatch);
          });
          return;
        }
        if (operationFailureFeedback) {
          setError("");
          removeGitNoticeByRequestId(res.meta?.requestId);
          return;
        }
        if (noticeActions.length > 0) {
          finalizeGitNotice({
            requestId: res.meta?.requestId,
            action: `log.${mappedAction}`,
            tone: "warn",
            message: getErrorText(res.error, "workbench.log.actionFailed", "执行 Git 日志动作失败"),
            actions: noticeActions,
          });
          return;
        }
        setError(getErrorText(res.error, "workbench.log.actionFailed", "执行 Git 日志动作失败"));
        return;
      }
      if (historyRewriteFeedback) {
        await presentHistoryRewriteFeedbackAsync(historyRewriteFeedback, { requestId: res.meta?.requestId });
        return;
      }
      if (mappedAction === "undoCommit") {
        const restoredCommitMessage = String(res.data?.restoredCommitMessage || "").replace(/\s+$/, "");
        const targetChangeListId = String(res.data?.targetChangeListId || payload.targetChangeListId || "").trim();
        if (targetChangeListId && targetChangeListId !== activeChangeListId) {
          const activateRes = await setActiveChangeListAsync(repoRoot, targetChangeListId);
          if (activateRes.ok) {
            setStatus((prev) => prev ? ({
              ...prev,
              changeLists: {
                ...prev.changeLists,
                activeListId: targetChangeListId,
              },
            }) : prev);
          }
        }
        if (targetChangeListId && restoredCommitMessage) {
          const targetChangeList = displayChangeLists.find((item) => String(item.id || "").trim() === targetChangeListId) || null;
          const patch = buildChangeListCommitDraftPatch(targetChangeList, {
            ...readChangeListCommitDraft(targetChangeList),
            message: restoredCommitMessage,
          });
          const updateRes = await updateChangeListDataAsync(repoRoot, targetChangeListId, patch);
          if (updateRes.ok) {
            setStatus((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                changeLists: {
                  ...prev.changeLists,
                  lists: (prev.changeLists?.lists || []).map((item) => {
                    if (String(item.id || "").trim() !== targetChangeListId) return item;
                    return {
                      ...item,
                      comment: patch.comment,
                      data: patch.data,
                    };
                  }),
                },
              };
            });
            restoredChangeListDraftListIdRef.current = targetChangeListId;
          }
        }
        if (restoredCommitMessage) {
          clearCommitAmendRuntimeState(false);
          setCommitAmendEnabled(false);
          setCommitMessage(restoredCommitMessage);
        }
        if (res.data?.moveWarning) {
          finalizeGitNotice({
            requestId: res.meta?.requestId,
            action: "log.undoCommit",
            tone: "warn",
            message: String(res.data.moveWarning || gt("workbench.historyRewrite.undoCommitMoveWarningFallback", "撤销提交后移动更改列表失败")),
          });
        }
      }
      if (mappedAction === "checkout" || mappedAction === "newBranch" || mappedAction === "newTag" || mappedAction === "reset" || mappedAction === "revert" || mappedAction === "cherryPick" || mappedAction === "push" || mappedAction === "undoCommit" || mappedAction === "editMessage" || mappedAction === "deleteCommit" || mappedAction === "pushAllPrevious" || mappedAction === "fixup" || mappedAction === "squashTo" || mappedAction === "squashCommits")
        await refreshAllAsync({ keepLog: false });
    },
    [activeChangeListId, buildPreservingNoticeActions, clearCommitAmendRuntimeState, details, displayChangeLists, exportPatchTextAsync, finalizeGitNotice, loadLogMessageDraftValueAsync, localChangesConfig.changeListsEnabled, localChangesConfig.stagingAreaEnabled, logItems, openActionDialogAsync, openDiffAsync, openInteractiveRebaseDialogAsync, openOperationProblemDialog, openPushDialogAsync, presentHistoryRewriteFeedbackAsync, refreshAllAsync, removeGitNoticeByRequestId, repoBranch, repoRoot, resolveCommitWorkflowPayloadAsync, selectedCommitHashes],
  );

  /**
   * 处理变更文件右键菜单动作。
   */
  const runChangeMenuActionAsync = useCallback(
    async (
      action: string,
      changeListIdHint?: string,
      options?: {
        selectionSnapshot?: ReturnType<typeof buildCommitMenuSelectionSnapshot>;
        targetKindHint?: MenuState["targetKind"];
      },
    ): Promise<void> => {
      if (!repoRoot) return;
      const actionSelectionSnapshot = options?.selectionSnapshot;
      const actionSelectedEntries = actionSelectionSnapshot?.selectedEntries || selectedEntries;
      const actionSelectedPaths = actionSelectionSnapshot?.selectedPaths || selectedPaths;
      const actionExactlySelectedPaths = actionSelectionSnapshot?.exactlySelectedPaths || exactlySelectedPaths;
      const actionSelectedDeleteTargets = actionSelectionSnapshot?.selectedDeleteTargets || selectedDeleteTargets;
      const actionSelectedChangeListIds = actionSelectionSnapshot?.selectedChangeListIds || selectedChangeListIds;
      const actionSelectedExplicitChangeListIds = actionSelectionSnapshot?.selectedExplicitChangeListIds || selectedExplicitChangeListIds;
      const actionSelectedNodeSources = actionSelectionSnapshot?.selectedNodeSources || selectedCommitNodeSources;
      const actionSelectionContext = actionSelectionSnapshot
        ? buildCommitTreeDataSnapshot({
            selectedEntries: actionSelectedEntries,
            selectedPaths: actionSelectedPaths,
            exactlySelectedPaths: actionExactlySelectedPaths,
            selectedNodeSources: actionSelectedNodeSources,
            selectedChangeListIds: actionSelectedChangeListIds,
            selectedExplicitChangeListIds: actionSelectedExplicitChangeListIds,
            availableChangeListIds: new Set((status?.changeLists?.lists || []).map((one) => String(one.id || "").trim()).filter(Boolean)),
            activeChangeListId: String(status?.changeLists?.activeListId || "").trim(),
            localChangesConfig,
            stashPushPathspecSupported: status?.stashPushPathspecSupported,
          })
        : commitSelectionContext;
      const actionSelectedActionableEntries = actionSelectedEntries.filter((entry) => isCommitEntryActionable(entry));
      const actionSelectedRollbackEntries = actionSelectedActionableEntries.filter((entry) => !entry.ignored && !entry.untracked);
      const files = actionSelectedActionableEntries.map((entry) => entry.path);
      const selectedEntryPaths = actionSelectedEntries.map((entry) => entry.path);
      const firstFile = actionSelectionContext.leadSelectionPath || selectedEntryPaths[0] || files[0] || "";
      const stageableFiles = actionSelectionContext.selectedStageablePaths;
      const stagedFiles = actionSelectionContext.selectedStagedPaths;
      const trackedUnstagedFiles = actionSelectionContext.selectedTrackedUnstagedPaths;
      const stashableFiles = actionSelectionContext.selectedStashablePaths;
      const selectedUnversionedEntries = actionSelectedEntries.filter((entry) => entry.untracked && !entry.ignored);
      const selectedStashOperationBatches = buildGitStageOperationBatches({
        entries: actionSelectedEntries,
        fallbackRepoRoot: repoRoot,
        predicate: (entry) => !entry.ignored && (entry.staged || entry.unstaged || entry.untracked),
      });
      const availableChangeListIds = new Set((status?.changeLists?.lists || []).map((one) => String(one.id || "").trim()).filter(Boolean));
      /**
       * 生成与 IDEA `VirtualFileDeleteProvider` 一致的删除确认文案。
       */
      const confirmDeleteSelectionAsync = async (): Promise<boolean> => {
        const effectiveTargets = Array.from(new Set((actionSelectedDeleteTargets.length > 0 ? actionSelectedDeleteTargets : files).filter(Boolean)));
        if (effectiveTargets.length === 0) return false;
        const targetName = String(effectiveTargets[0] || "").trim().replace(/\\/g, "/").split("/").filter(Boolean).pop() || effectiveTargets[0] || "";
        const description = effectiveTargets.length === 1
          ? (options?.targetKindHint === "folder"
              ? gt("workbench.changes.deleteFolderConfirm", "确定删除所选文件夹 '{{name}}' 吗？", { name: targetName })
              : gt("workbench.changes.deleteFileConfirm", "确定删除所选文件 '{{name}}' 吗？", { name: targetName }))
          : gt("workbench.changes.deleteItemsConfirm", "确定删除所选 {{count}} 个项目吗？", { count: effectiveTargets.length });
        const form = await openActionDialogAsync({
          title: gt("workbench.common.delete", "删除"),
          description,
          confirmText: gt("workbench.common.delete", "删除"),
          fields: [],
        });
        return !!form;
      };
      /**
       * 解析变更列表动作的目标列表，遵循“唯一目标列表”规则。
       */
      const resolveActionChangeListId = (): string => {
        return resolveCommitSingleChangeListId([changeListIdHint], actionSelectedChangeListIds, availableChangeListIds);
      };
      /**
       * 解析“删除更改列表”目标集合，优先尊重多选，其次回退到唯一目标列表。
       */
      const resolveActionChangeListIds = (): string[] => {
        const out = new Set<string>();
        const hint = String(changeListIdHint || "").trim();
        if (hint && availableChangeListIds.has(hint)) out.add(hint);
        for (const one of actionSelectedChangeListIds) {
          const id = String(one || "").trim();
          if (id && availableChangeListIds.has(id)) out.add(id);
        }
        if (out.size === 0) {
          const singleId = resolveActionChangeListId();
          if (singleId) out.add(singleId);
        }
        return Array.from(out);
      };
      if (action === "commitFile") {
        if (!files.length) return;
        const form = await openActionDialogAsync({
          title: gt("actionDialogs.commitFiles.title", "提交文件"),
          description: gt("actionDialogs.commitFiles.description", "将提交 {{count}} 个文件", { count: files.length }),
          confirmText: gt("actionDialogs.commitFiles.confirm", "提交"),
          fields: [{ key: "message", label: gt("actionDialogs.commitFiles.messageLabel", "提交信息"), placeholder: gt("actionDialogs.commitFiles.messagePlaceholder", "请输入提交信息"), required: true }],
          defaults: { message: commitMessage || "" },
        });
        if (!form) return;
        const message = String(form.message || "").trim();
        if (!message) {
          setError(gt("commit.checks.emptyMessage", "提交信息不能为空"));
          return;
        }
        await submitGitCommitAsync({
          message,
          intent: "commit",
          entries: actionSelectedEntries,
          amend: false,
        });
        return;
      }
      if (action === "rollback") {
        if (actionSelectedRollbackEntries.length <= 0) {
          setError(gt("workbench.rollbackViewer.noTrackedChanges", "当前选择中没有可回滚的已跟踪改动"));
          return;
        }
        openRollbackViewerDialog({
          title: gt("workbench.rollbackViewer.title", "回滚更改"),
          description: gt("workbench.rollbackViewer.description", "将所选已跟踪更改恢复到 HEAD。"),
          entries: buildRollbackBrowserEntriesFromStatusEntries(actionSelectedRollbackEntries),
          selectedPaths: actionSelectedRollbackEntries.map((entry) => entry.path),
          activePath: actionSelectedRollbackEntries[0]?.path,
          refreshPaths: actionSelectedRollbackEntries.map((entry) => entry.path),
        });
        return;
      }
      if (action === "move") {
        if (!selectedEntryPaths.length) return;
        const lists = resolveMoveDialogLists(displayChangeLists, actionSelectedEntries);
        const options = buildChangeListSelectOptions(lists);
        const form = await openActionDialogAsync({
          title: gt("actionDialogs.moveToChangelist.title", "移动到变更列表"),
          description: gt("actionDialogs.moveToChangelist.description", "选择目标变更列表"),
          confirmText: gt("actionDialogs.moveToChangelist.confirm", "移动"),
          fields: [{
            key: "target",
            label: gt("actionDialogs.moveToChangelist.targetLabel", "目标列表"),
            type: "select",
            options: options.length > 0 ? options : [{ value: "default", label: gt("actionDialogs.common.defaultBadge", "默认") }],
            required: true,
          }],
        });
        if (!form) return;
        await moveFilesBetweenChangeListsAsync(selectedEntryPaths, String(form.target || "").trim());
        return;
      }
      if (action === "showDiff") {
        const diffRequest = buildLeadCommitDiffRequest();
        if (!diffRequest) return;
        await openDiffRequestAsync(diffRequest);
        return;
      }
      if (action === "showStandaloneDiff") {
        const diffRequest = buildLeadCommitDiffRequest();
        if (!diffRequest) return;
        await openPinnedDiffRequestAsync(diffRequest);
        return;
      }
      if (action === "compareLocal") {
        const diffRequest = buildLeadCommitDiffRequest("working");
        if (!diffRequest) return;
        await openDiffRequestAsync(diffRequest);
        return;
      }
      if (action === "editSource") {
        if (!firstFile) return;
        await openSourceInIdeAsync(firstFile);
        return;
      }
      if (action === "mergeConflicts" || action === "acceptTheirs" || action === "acceptYours") {
        const request = resolveConflictContextMenuRequest(action, actionSelectedEntries, (key, fallback) => gt(key, fallback));
        if (!request) return;
        if (request.kind === "openMergeDialog") {
          await openConflictMergeDialogAsync(request.path);
          return;
        }
        if (request.kind === "openResolverDialog") {
          openConflictResolverDialog({
            title: request.title,
            description: request.description,
            focusPath: request.focusPath,
            checkedPaths: request.checkedPaths,
          });
          return;
        }
        await applyConflictResolverSideByPathsAsync(request.side, {
          paths: request.paths,
          failureActionText: request.failureActionText,
        });
        return;
      }
      if (action === "delete") {
        if (!files.length) return;
        const confirmed = await confirmDeleteSelectionAsync();
        if (!confirmed) return;
        const untracked = actionSelectedActionableEntries.filter((x) => x.untracked).map((x) => x.path);
        const res = await deleteFilesAsync(repoRoot, files, untracked, actionSelectedDeleteTargets);
        if (!res.ok) setError(getErrorText(res.error, "workbench.changes.deleteFailed", "删除失败"));
        else await refreshAllAsync({ keepLog: true });
        return;
      }
      if (action === "addToVcs") {
        const addTargets = Array.from(new Set(
          (actionSelectedDeleteTargets.length > 0 ? actionSelectedDeleteTargets : actionSelectedPaths)
            .map((one) => String(one || "").trim())
            .filter(Boolean),
        ));
        if (addTargets.length === 0) return;
        const res = await stageFilesAsync(repoRoot, addTargets);
        if (!res.ok) setError(getErrorText(res.error, "workbench.changes.addToVcsFailed", "添加到 VCS 失败"));
        else await refreshAllAsync({ keepLog: true });
        return;
      }
      if (action === "stage") {
        if (stageableFiles.length === 0) return;
        await runCommitTreeStageOperationAsync(actionSelectedEntries, "stage");
        return;
      }
      if (action === "stageWithoutContent") {
        const intentToAddBatches = buildGitStageOperationBatches({
          entries: selectedUnversionedEntries,
          fallbackRepoRoot: repoRoot,
          predicate: (entry) => entry.untracked && !entry.ignored,
        });
        if (intentToAddBatches.length === 0) return;
        await executeStageBatchesAsync(intentToAddBatches, "stage", { mode: "intentToAdd" });
        return;
      }
      if (action === "stageAll") {
        if (!canStageAll) return;
        await executeStageBatchesAsync(stageAllOperationBatches, "stage");
        return;
      }
      if (action === "stageTracked") {
        if (!canStageAllTracked) return;
        await executeStageBatchesAsync(trackedStageOperationBatches, "stage");
        return;
      }
      if (action === "unstage") {
        if (stagedFiles.length === 0) return;
        await runCommitTreeStageOperationAsync(actionSelectedEntries, "unstage");
        return;
      }
      if (action === "revertUnstaged") {
        if (trackedUnstagedFiles.length === 0) return;
        const res = await revertUnstagedFilesAsync(repoRoot, trackedUnstagedFiles);
        if (!res.ok) setError(getErrorText(res.error, "workbench.changes.revertUnstagedFailed", "还原未暂存更改失败"));
        else await refreshAllAsync({ keepLog: true });
        return;
      }
      if (action === "showStaged") {
        if (!firstFile) return;
        await openDiffAsync(firstFile, "staged");
        return;
      }
      if (action === "showLocal") {
        if (!firstFile) return;
        await openDiffAsync(firstFile, "working");
        return;
      }
      if (action === "compareLocalToStaged") {
        if (!firstFile) return;
        await openDiffAsync(firstFile, "localToStaged");
        return;
      }
      if (action === "compareStagedToLocal") {
        if (!firstFile) return;
        await openDiffAsync(firstFile, "stagedToLocal");
        return;
      }
      if (action === "compareStagedToHead") {
        if (!firstFile) return;
        await openDiffAsync(firstFile, "staged");
        return;
      }
      if (action === "compareThreeVersions") {
        if (!firstFile) return;
        await openStageThreeWayDialogAsync(firstFile);
        return;
      }
      if (action === "stageStash") {
        if (stashableFiles.length === 0) return;
        await runCreateStashBatchesAsync(
          selectedStashOperationBatches.map((batch) => ({ repoRoot: batch.repoRoot, paths: batch.paths })),
          {
            includeUntracked: true,
            failureText: gt("workbench.stash.stageSelectedFailed", "暂存选中文件失败"),
            noticeAction: "stash.selection",
          },
        );
        return;
      }
      if (action === "stashSilently") {
        if (!canStashAllChangedRoots) return;
        await runCreateStashBatchesAsync(
          changedRepoRoots.map((targetRepoRoot) => ({ repoRoot: targetRepoRoot })),
          {
            includeUntracked: false,
            failureText: gt("workbench.stash.createSilentlyFailed", "创建 Stash 失败"),
            noticeAction: "stash.silently",
          },
        );
        return;
      }
      if (action === "ignore") {
        if (selectedUnversionedEntries.length === 0) return;
        await openIgnoreTargetDialogForEntriesAsync(selectedUnversionedEntries);
        return;
      }
      if (action === "extractCommit") {
        await runChangeMenuActionAsync("commitFile");
        return;
      }
      if (action === "restoreFromRevision") {
        if (!files.length) return;
        await restoreFilesFromRevisionDialogAsync(files);
        return;
      }
      if (action === "pathHistory") {
        if (!firstFile) return;
        showPathHistory(firstFile, { followRenames: true });
        return;
      }
      if (action === "refresh") {
        await refreshAllAsync({ keepLog: false });
        return;
      }
      if (action === "shelve") {
        const form = await openActionDialogAsync({
          title: gt("actionDialogs.shelveChanges.title", "搁置更改"),
          description: gt("actionDialogs.shelveChanges.description", "请输入搁置说明"),
          confirmText: gt("actionDialogs.shelveChanges.confirm", "搁置"),
          fields: [{ key: "message", label: gt("actionDialogs.shelveChanges.messageLabel", "说明"), placeholder: gt("actionDialogs.shelveChanges.messagePlaceholder", "搁置所选更改"), required: true }],
          defaults: { message: gt("actionDialogs.shelveChanges.messagePlaceholder", "搁置所选更改") },
        });
        if (!form) return;
        await createManualShelveRecordAsync(
          String(form.message || "").trim() || gt("actionDialogs.shelveChanges.messagePlaceholder", "搁置所选更改"),
          resolveActionChangeListId() || undefined,
        );
        return;
      }
      if (action === "newList") {
        const form = await openActionDialogAsync({
          title: gt("actionDialogs.newChangeList.title", "新建更改列表"),
          description: gt("actionDialogs.newChangeList.description", "请输入更改列表名称"),
          confirmText: gt("actionDialogs.newChangeList.confirm", "创建"),
          fields: [
            { key: "name", label: gt("actionDialogs.newChangeList.nameLabel", "列表名称"), placeholder: gt("actionDialogs.newChangeList.namePlaceholder", "默认更改列表"), required: true },
            { key: "setActive", label: gt("actionDialogs.newChangeList.setActiveLabel", "设为活动更改列表"), type: "checkbox" },
          ],
          defaults: { setActive: "false" },
        });
        if (!form) return;
        const res = await createChangeListAsync(repoRoot, form.name, {
          setActive: form.setActive === "true",
        });
        if (!res.ok) setError(getErrorText(res.error, "workbench.changelist.createFailed", "创建变更列表失败"));
        else await refreshAllAsync({ keepLog: true });
        return;
      }
      if (action === "setActiveList") {
        const currentListId = resolveActionChangeListId();
        if (!currentListId) {
          setError(gt("workbench.changelist.targetNotFound", "未找到目标更改列表"));
          return;
        }
        const res = await setActiveChangeListAsync(repoRoot, currentListId);
        if (!res.ok) setError(getErrorText(res.error, "workbench.changelist.activateFailed", "设置活动更改列表失败"));
        else await refreshAllAsync({ keepLog: true });
        return;
      }
      if (action === "editList") {
        const currentListId = resolveActionChangeListId();
        if (!currentListId) {
          setError(gt("workbench.changelist.targetNotFound", "未找到目标更改列表"));
          return;
        }
        const currentName = displayChangeLists.find((one) => one.id === currentListId)?.name || "";
        const form = await openActionDialogAsync({
          title: gt("actionDialogs.editChangeList.title", "编辑更改列表"),
          description: gt("actionDialogs.editChangeList.description", "请输入新的更改列表名称"),
          confirmText: gt("actionDialogs.editChangeList.confirm", "保存"),
          fields: [{ key: "name", label: gt("actionDialogs.editChangeList.nameLabel", "列表名称"), placeholder: gt("actionDialogs.editChangeList.namePlaceholder", "请输入名称"), required: true }],
          defaults: { name: currentName },
        });
        if (!form) return;
        const res = await renameChangeListAsync(repoRoot, currentListId, form.name);
        if (!res.ok) setError(getErrorText(res.error, "workbench.changelist.editFailed", "编辑变更列表失败"));
        else await refreshAllAsync({ keepLog: true });
        return;
      }
      if (action === "removeList") {
        const currentListIds = resolveActionChangeListIds();
        if (currentListIds.length === 0) {
          setError(gt("workbench.changelist.targetNotFound", "未找到目标更改列表"));
          return;
        }
        const lists = displayChangeLists;
        const activeListId = String(status?.changeLists?.activeListId || "").trim();
        const currentSet = new Set(currentListIds);
        const names = currentListIds.map((id) => lists.find((one) => one.id === id)?.name || id);
        const activeSelected = !!activeListId && currentSet.has(activeListId);
        const candidates = lists.filter((one) => !currentSet.has(one.id));
        let targetListId = "";
        if (activeSelected && candidates.length > 0) {
          const targetForm = await openActionDialogAsync({
            title: gt("actionDialogs.deleteChangeList.chooseNextTitle", "选择新的活动更改列表"),
            description: gt("actionDialogs.deleteChangeList.chooseNextDescription", "删除活动更改列表前，请先选择新的活动列表用于接收文件。"),
            confirmText: gt("actionDialogs.deleteChangeList.chooseNextConfirm", "下一步"),
            fields: [{
              key: "targetListId",
              label: gt("actionDialogs.deleteChangeList.targetLabel", "目标列表"),
              type: "select",
              options: buildChangeListSelectOptions(candidates),
              required: true,
            }],
            defaults: { targetListId: candidates[0]?.id || "" },
          });
          if (!targetForm) return;
          targetListId = String(targetForm.targetListId || "").trim();
          if (!targetListId) {
            setError(gt("workbench.changelist.selectTarget", "请选择目标更改列表"));
            return;
          }
        }
        const form = await openActionDialogAsync({
          title: gt("actionDialogs.deleteChangeList.title", "删除更改列表"),
          description: targetListId
            ? gt("actionDialogs.deleteChangeList.descriptionWithTarget", "将删除 {{count}} 个更改列表（{{names}}），其中的文件会移动到所选目标列表。", { count: currentListIds.length, names: names.join("、") })
            : gt("actionDialogs.deleteChangeList.descriptionWithoutTarget", "将删除 {{count}} 个更改列表（{{names}}），其中的文件会回到活动更改列表。", { count: currentListIds.length, names: names.join("、") }),
          confirmText: gt("actionDialogs.deleteChangeList.confirm", "删除"),
          fields: [],
        });
        if (!form) return;
        const orderedIds = activeSelected
          ? [activeListId, ...currentListIds.filter((id) => id !== activeListId)]
          : currentListIds;
        for (const listId of orderedIds) {
          const res = await deleteChangeListAsync(
            repoRoot,
            listId,
            listId === activeListId && targetListId ? targetListId : undefined,
          );
          if (!res.ok) {
            setError(toErrorText(res.error, gt("actionDialogs.deleteChangeList.failed", "删除更改列表失败")));
            return;
          }
        }
        await refreshAllAsync({ keepLog: true });
        return;
      }
    },
    [applyConflictResolverSideByPathsAsync, buildLeadCommitDiffRequest, canStageAll, canStageAllTracked, canStashAllChangedRoots, changedRepoRoots, clearActiveChangeListDraftMessageAsync, commitAdvancedOptionsState, commitMessage, commitNodeByKey, commitSelectionContext, createManualShelveRecordAsync, defaultCommitAuthor, displayChangeLists, ensureMergePrecheckConfirmedAsync, exactlySelectedPaths, executeStageBatchesAsync, localChangesConfig, moveFilesBetweenChangeListsAsync, openActionDialogAsync, openConflictMergeDialogAsync, openConflictResolverDialog, openDiffAsync, openDiffRequestAsync, openIgnoreTargetDialogForEntriesAsync, openPinnedDiffRequestAsync, openRollbackViewerDialog, openSourceInIdeAsync, openStageThreeWayDialogAsync, refreshAllAsync, repoRoot, resetCommitComposerState, resolveCommitWorkflowPayloadAsync, restoreFilesFromRevisionDialogAsync, runCommitTreeStageOperationAsync, runCreateStashBatchesAsync, selectedActionableEntries, selectedActionablePaths, selectedChangeListIds, selectedCommitNodeSources, selectedCommitSubtreeNodeKeys, selectedDeleteTargets, selectedEntries, selectedExplicitChangeListIds, selectedLeadCommitEntry, selectedPaths, selectedRollbackEntries, showPathHistory, stageAllOperationBatches, status?.changeLists?.activeListId, status?.changeLists?.lists, status?.entries, status?.stashPushPathspecSupported, submitGitCommitAsync, trackedStageOperationBatches],
  );

  /**
   * 处理“提交详情文件树”右键菜单动作。
   */
  const runDetailMenuActionAsync = useCallback(
    async (action: string, targetPath: string, targetHash?: string, targetPaths?: string[], targetHashes?: string[]): Promise<void> => {
      const path = String(targetPath || "").trim();
      const normalizedPaths = Array.from(new Set((targetPaths || [path]).map((one) => String(one || "").trim()).filter(Boolean)));
      const hashResolution = resolveDetailSelectionHashResolution(normalizedPaths);
      const normalizedCommitHashes = Array.from(new Set(
        ((targetHashes && targetHashes.length > 0) ? targetHashes : hashResolution.uniqueHashes)
          .map((one) => String(one || "").trim())
          .filter(Boolean),
      ));
      const hash = String(targetHash || normalizedCommitHashes[normalizedCommitHashes.length - 1] || "").trim();
      const primaryPath = normalizedPaths[0] || path;
      const primaryEntry = statusEntryByPath.get(primaryPath.replace(/\\/g, "/"));
      const localDiffMode = primaryEntry ? resolveCommitPreviewDiffMode(primaryEntry, localChangesConfig) : "working";
      const isMultiCommitContext = normalizedCommitHashes.length > 1;
      const selectedChanges = buildCommitDetailsSelectionChanges(detailFileItems, normalizedPaths);
      const allChanges = detailFileItems.map((file) => ({
        path: String(file.path || "").trim().replace(/\\/g, "/"),
        oldPath: String(file.oldPath || "").trim().replace(/\\/g, "/") || undefined,
        status: String(file.status || "").trim() || undefined,
      }));
      const diffSelectionMeta = {
        paths: normalizedPaths,
        kind: normalizedPaths.length > 1 ? "mixed" as const : "single" as const,
        index: Math.max(0, normalizedPaths.indexOf(primaryPath)),
      };
      if (!repoRoot || !primaryPath) return;
      if (action === "showDiff") {
        await openDiffAsync(primaryPath, hash ? "commit" : localDiffMode, hash || undefined, isMultiCommitContext ? normalizedCommitHashes : undefined, diffSelectionMeta);
        return;
      }
      if (action === "compareRevisions") {
        if (normalizedCommitHashes.length !== 2) {
          setError(gt("details.actions.compareRevisionsTwoCommits", "仅支持恰好两个提交的版本比较"));
          return;
        }
        const primaryChange = selectedChanges.find((change) => change.path === primaryPath) || selectedChanges[0];
        await openDiffAsync(primaryPath, "revisionToRevision", normalizedCommitHashes[1], normalizedCommitHashes, {
          ...diffSelectionMeta,
          oldPath: String(primaryChange?.oldPath || "").trim().replace(/\\/g, "/") || undefined,
        });
        return;
      }
      if (action === "compareLocal") {
        if (isMultiCommitContext) {
          setError(gt("workbench.details.compareLocalMultiCommitUnsupported", "多选提交聚合详情暂不支持与本地比较"));
          return;
        }
        await openDiffAsync(primaryPath, hash ? "revisionToWorking" : "working", hash || undefined, undefined, diffSelectionMeta);
        return;
      }
      if (action === "comparePreviousLocal") {
        if (isMultiCommitContext) {
          setError(gt("workbench.details.comparePreviousLocalMultiCommitUnsupported", "多选提交聚合详情暂不支持“之前版本与本地比较”"));
          return;
        }
        await openDiffAsync(primaryPath, hash ? "parentToWorking" : "working", hash || undefined, undefined, diffSelectionMeta);
        return;
      }
      if (action === "editSource") {
        const editSourceAction = getCommitDetailsActionItem(detailActionAvailability, "editSource");
        if (!editSourceAction.visible || !editSourceAction.enabled) {
          setError(editSourceAction.reason || gt("workbench.details.editSourceUnsupported", "当前选择不支持编辑源"));
          return;
        }
        await openSourceInIdeAsync(primaryPath);
        return;
      }
      if (action === "openRepositoryVersion") {
        const openRepositoryVersionAction = getCommitDetailsActionItem(detailActionAvailability, "openRepositoryVersion");
        if (!openRepositoryVersionAction.visible || !openRepositoryVersionAction.enabled) {
          setError(openRepositoryVersionAction.reason || gt("workbench.details.openRepositoryVersionUnsupported", "当前选择不支持打开仓库版本"));
          return;
        }
        const repositoryVersionChanges = selectedChanges.filter((change) => !/^D$/i.test(String(change.status || "").trim()));
        if (repositoryVersionChanges.length <= 0) {
          setError(openRepositoryVersionAction.reason || gt("workbench.details.openRepositoryVersionUnsupported", "当前选择不支持打开仓库版本"));
          return;
        }
        const groupedChanges = groupDetailSelectionChangesByUniqueHash(repositoryVersionChanges);
        if (!groupedChanges) {
          setError(gt("details.actions.selectionMustResolveToSingleCommit", "当前选择中的文件必须各自唯一映射到一个提交"));
          return;
        }
        for (const group of groupedChanges) {
          const res = await runLogDetailsActionAsync(repoRoot, {
            action: "openRepositoryVersion",
            hash: group.hash,
            selectedChanges: group.changes,
          });
          if (!res.ok) {
            setError(getErrorText(res.error, "workbench.details.openRepositoryVersionFailed", "打开仓库版本失败"));
            return;
          }
          for (const item of Array.isArray((res.data as any)?.files) ? (res.data as any).files : []) {
            const tempPath = String(item?.tempPath || "").trim();
            if (!tempPath) continue;
            await openAbsolutePathInIdeAsync(tempPath, repoRoot);
          }
        }
        return;
      }
      if (action === "revertSelectedChanges" || action === "applySelectedChanges") {
        const detailPatchAction = getCommitDetailsActionItem(
          detailActionAvailability,
          action === "revertSelectedChanges" ? "revertSelectedChanges" : "applySelectedChanges",
        );
        if (!detailPatchAction.visible || !detailPatchAction.enabled) {
          setError(detailPatchAction.reason || (action === "revertSelectedChanges"
            ? gt("workbench.details.revertSelectedUnsupported", "当前选择不支持还原所选更改")
            : gt("workbench.details.applySelectedUnsupported", "当前选择不支持优选所选更改")));
          return;
        }
        if (isMultiCommitContext) {
          setError(action === "revertSelectedChanges"
            ? gt("workbench.details.revertSelectedMultiCommitUnsupported", "多选提交聚合详情暂不支持还原所选更改")
            : gt("workbench.details.applySelectedMultiCommitUnsupported", "多选提交聚合详情暂不支持优选所选更改"));
          return;
        }
        const detailPatchChangeLists = localChangesConfig.changeListsEnabled && !localChangesConfig.stagingAreaEnabled
          ? displayChangeLists.map((item) => ({ id: item.id, name: item.name }))
          : [];
        const payload: {
          action: "revertSelectedChanges" | "applySelectedChanges";
          hash?: string;
          selectedChanges?: typeof selectedChanges;
          targetChangeListId?: string;
        } = {
          action,
          hash,
          selectedChanges,
        };
        if (detailPatchChangeLists.length > 0) {
          const form = await openActionDialogAsync(buildCommitDetailsPatchDialogConfig(
            action === "revertSelectedChanges" ? "revert" : "apply",
            {
              changeLists: detailPatchChangeLists,
              activeChangeListId,
            },
          ));
          if (!form) return;
          const targetChangeListId = String(form.targetChangeListId || "").trim();
          if (!targetChangeListId) {
            setError(gt("workbench.changelist.selectTarget", "请选择目标更改列表"));
            return;
          }
          payload.targetChangeListId = targetChangeListId;
        }
        const res = await runLogDetailsActionAsync(repoRoot, payload);
        if (!res.ok) {
          setError(getErrorText(
            res.error,
            action === "revertSelectedChanges" ? "workbench.details.revertSelectedFailed" : "workbench.details.applySelectedFailed",
            action === "revertSelectedChanges" ? "还原所选更改失败" : "优选所选更改失败",
          ));
          if ((Array.isArray(res.data?.conflictRepoRoots) && res.data.conflictRepoRoots.length > 0) || isLikelyConflictErrorText(res.error)) {
            await refreshAllAsync({ keepLog: true });
            openConflictResolverDialog({
              title: action === "revertSelectedChanges"
                ? gt("workbench.details.resolveRevertSelectedConflictsTitle", "解决还原所选更改冲突")
                : gt("workbench.details.resolveApplySelectedConflictsTitle", "解决优选所选更改冲突"),
              description: gitWorkbenchText(
                "workbench.misc.conflicts.resolutionConflictDetected",
                "{{action}}提交详情中的所选更改后检测到冲突；可在这里逐个打开冲突文件继续处理。",
                { action: action === "revertSelectedChanges" ? "还原" : "优选" },
              ),
              focusPath: primaryPath,
              checkedPaths: normalizedPaths,
            });
            return;
          }
          return;
        }
        if (res.data?.shouldRefresh === true)
          await refreshAllAsync({ keepLog: true });
        else
          await refreshAllAsync({ keepLog: false });
        return;
      }
      if (action === "extractSelectedChanges") {
        const extractAction = getCommitDetailsActionItem(detailActionAvailability, "extractSelectedChanges");
        if (!extractAction.visible || !extractAction.enabled) {
          setError(extractAction.reason || gt("workbench.details.extractSelectedUnsupported", "当前选择不支持提取所选更改"));
          return;
        }
        const form = await openActionDialogAsync({
          title: gt("details.actions.extractSelectedChanges", "将所选更改提取到单独的提交..."),
          description: gt("details.actions.extractSelectedChangesDescription", "从当前提交中提取所选更改，并直接改写目标提交历史。"),
          confirmText: gt("details.actions.extractSelectedChangesConfirm", "提取"),
          fields: [{ key: "message", label: gt("actionDialogs.editCommitMessage.messageLabel", "提交信息"), placeholder: gt("actionDialogs.editCommitMessage.messagePlaceholder", "请输入新的提交信息"), required: true }],
          defaults: {
            message: (
              details?.mode === "single" && details.detail.hash === hash
                ? details.detail.subject
                : logItems.find((item) => item.hash === hash)?.subject
            ) || "",
          },
        });
        if (!form) return;
        const message = String(form.message || "").trim();
        if (!message) {
          setError(gt("commit.checks.emptyMessage", "提交信息不能为空"));
          return;
        }
        const res = await runLogDetailsActionAsync(repoRoot, {
          action: "extractSelectedChanges",
          hash,
          selectedChanges,
          allChanges,
          message,
        });
        const historyRewriteFeedback = extractHistoryRewriteFeedback(res.data);
        if (!res.ok) {
          if (historyRewriteFeedback) {
            await presentHistoryRewriteFeedbackAsync(historyRewriteFeedback, { requestId: res.meta?.requestId });
            return;
          }
          if (res.data?.shouldRefresh === true) {
            await refreshAllAsync({ keepLog: false });
          }
          setError(getErrorText(res.error, "workbench.details.extractSelectedFailed", "提取所选更改失败"));
          return;
        }
        if (historyRewriteFeedback) {
          await presentHistoryRewriteFeedbackAsync(historyRewriteFeedback, { requestId: res.meta?.requestId });
          return;
        }
        await refreshAllAsync({ keepLog: false });
        return;
      }
      if (action === "dropSelectedChanges") {
        const dropAction = getCommitDetailsActionItem(detailActionAvailability, "dropSelectedChanges");
        if (!dropAction.visible || !dropAction.enabled) {
          setError(dropAction.reason || gt("workbench.details.dropSelectedUnsupported", "当前选择不支持删除所选更改"));
          return;
        }
        const res = await runLogDetailsActionAsync(repoRoot, {
          action: "dropSelectedChanges",
          hash,
          selectedChanges,
          allChanges,
        });
        const historyRewriteFeedback = extractHistoryRewriteFeedback(res.data);
        if (!res.ok) {
          if (historyRewriteFeedback) {
            await presentHistoryRewriteFeedbackAsync(historyRewriteFeedback, { requestId: res.meta?.requestId });
            return;
          }
          if (res.data?.shouldRefresh === true) {
            await refreshAllAsync({ keepLog: false });
          }
          setError(getErrorText(res.error, "workbench.details.dropSelectedFailed", "删除所选更改失败"));
          return;
        }
        if (historyRewriteFeedback) {
          await presentHistoryRewriteFeedbackAsync(historyRewriteFeedback, { requestId: res.meta?.requestId });
          return;
        }
        await refreshAllAsync({ keepLog: false });
        return;
      }
      if (action === "createPatch") {
        const selectedPatchItems = allChanges.filter((change) => normalizedPaths.includes(change.path));
        const patchPaths = buildCommitPatchPathspecs(selectedPatchItems);
        if (hash) {
          const patchHashes = normalizedCommitHashes.length > 0 ? normalizedCommitHashes : [hash];
          const res = await runLogActionAsync(repoRoot, {
            action: "createPatch",
            hash: patchHashes[patchHashes.length - 1],
            hashes: [...patchHashes].reverse(),
            paths: patchPaths,
          });
          if (!res.ok) {
            setError(getErrorText(res.error, "workbench.patch.createFailed", "创建补丁失败"));
            return;
          }
          await exportPatchTextAsync(String((res.data as any)?.patch || ""), {
            mode: "save",
            defaultPath: buildPatchExportFileName({
              paths: patchPaths,
              hash: patchHashes[patchHashes.length - 1],
              hashes: patchHashes,
            }),
          });
          return;
        }
        const patchRequests = buildWorkingTreePatchRequests({
          entries: normalizedPaths
            .map((onePath) => statusEntryByPath.get(onePath.replace(/\\/g, "/")))
            .filter((entry): entry is GitStatusEntry => !!entry),
          fallbackRepoRoot: repoRoot,
        });
        if (patchRequests.length === 0) return;
        const patchChunks: string[] = [];
        for (const request of patchRequests) {
          const res = await getDiffPatchAsync(request.repoRoot, {
            path: request.path,
            oldPath: request.oldPath,
            mode: request.mode,
            hash: hash || undefined,
          });
          if (!res.ok || !res.data) {
            setError(getErrorText(res.error, "workbench.patch.createFailed", "创建补丁失败"));
            return;
          }
          patchChunks.push(String(res.data.patch || ""));
        }
        await exportPatchTextAsync(patchChunks.join("\n"), {
          mode: "save",
          defaultPath: buildPatchExportFileName({ paths: patchRequests.map((request) => request.path) }),
        });
        return;
      }
      if (action === "restoreFromRevision") {
        const restorableChanges = selectedChanges.filter((change) => !/^D$/i.test(String(change.status || "").trim()));
        if (restorableChanges.length <= 0) {
          setError(gt("workbench.details.restoreFromRevisionUnsupported", "当前选择不支持从修订恢复"));
          return;
        }
        const groupedChanges = groupDetailSelectionChangesByUniqueHash(restorableChanges);
        if (!groupedChanges) {
          setError(gt("details.actions.selectionMustResolveToSingleCommit", "当前选择中的文件必须各自唯一映射到一个提交"));
          return;
        }
        for (const group of groupedChanges) {
          const restored = await executeRestoreFilesFromRevisionAsync(group.paths, group.hash);
          if (!restored) return;
        }
        return;
      }
      if (action === "pathHistory") {
        showPathHistory(path || primaryPath, {
          revision: hash || "",
          followRenames: true,
        });
        return;
      }
      if (action === "refresh") {
        await refreshAllAsync({ keepLog: false });
      }
    },
    [activeChangeListId, detailActionAvailability, detailFileItems, details, displayChangeLists, executeRestoreFilesFromRevisionAsync, exportPatchTextAsync, groupDetailSelectionChangesByUniqueHash, isLikelyConflictErrorText, localChangesConfig, logItems, openAbsolutePathInIdeAsync, openActionDialogAsync, openConflictResolverDialog, openDiffAsync, openSourceInIdeAsync, presentHistoryRewriteFeedbackAsync, refreshAllAsync, repoRoot, resolveDetailSelectionHashResolution, runLogActionAsync, showPathHistory, statusEntryByPath],
  );

  /**
   * 在应用内（优先）或系统文件管理器中打开指定项目目录。
   */
  const openProjectAtPathAsync = useCallback(async (projectPath: string): Promise<void> => {
    const targetPath = String(projectPath || "").trim();
    if (!targetPath) return;
    markWorktreeCapabilityUsed();
    if (onOpenProjectInApp) {
      const ok = await onOpenProjectInApp(targetPath);
      if (!ok) setError(gitWorkbenchText("workbench.errors.openProjectFailed", "应用内打开项目失败"));
      return;
    }
    const openRes = await window.host.utils.openPath(targetPath);
    if (!openRes?.ok) setError(getErrorText(openRes?.error, "workbench.errors.openDirectoryFailed", "打开目录失败"));
  }, [markWorktreeCapabilityUsed, onOpenProjectInApp]);

  /**
   * 基于指定引用创建新的 Worktree（若不传引用则默认使用 HEAD）。
   */
  const createWorktreeFromRefAsync = useCallback(async (refName?: string, repoRootOverride?: string): Promise<void> => {
    const actionRepoRoot = String(repoRootOverride || repoRoot || "").trim();
    if (!actionRepoRoot) return;
    markWorktreeCapabilityUsed();
    const normalizedRef = String(refName || "").trim();
    const form = await openActionDialogAsync({
      title: gt("actionDialogs.worktree.title", "新增工作树"),
      description: normalizedRef
        ? gt("actionDialogs.worktree.descriptionWithRef", "填写新工作树目录与可选分支名称（基于 {{ref}}）", { ref: normalizedRef })
        : gt("actionDialogs.worktree.description", "填写新工作树目录与可选分支名称"),
      confirmText: gt("actionDialogs.worktree.confirm", "创建"),
      fields: [
        { key: "path", label: gt("actionDialogs.worktree.pathLabel", "目录"), placeholder: gt("actionDialogs.worktree.pathPlaceholder", "/path/to/worktree"), required: true },
        { key: "branchName", label: gt("actionDialogs.worktree.branchNameLabel", "新分支（可选）"), placeholder: gt("actionDialogs.worktree.branchNamePlaceholder", "feature/xxx") },
      ],
    });
    if (!form) return;
    const worktreePath = String(form.path || "").trim();
    const branchName = String(form.branchName || "").trim();
    if (!worktreePath) {
      setError(gt("actionDialogs.worktree.emptyPathError", "工作树目录不能为空"));
      return;
    }
    const res = await addWorktreeAsync(actionRepoRoot, {
      path: worktreePath,
      ref: normalizedRef || undefined,
      createBranch: !!branchName,
      branchName: branchName || undefined,
    });
    if (!res.ok) {
      setError(getErrorText(res.error, "actionDialogs.worktree.createFailed", "新增工作树失败"));
      return;
    }
    showWorktreesTabByUser({ select: false });
    await refreshAllAsync({ keepLog: true });
  }, [markWorktreeCapabilityUsed, openActionDialogAsync, refreshAllAsync, repoRoot, showWorktreesTabByUser]);

  /**
   * 按目标仓根解析分支比较上下文，统一复用 branch popup 当前仓快照，避免多仓菜单误用主仓数据。
   */
  const resolveBranchCompareRepository = useCallback((targetRepoRoot?: string): GitBranchPopupRepository | null => {
    const normalizedRepoRoot = String(targetRepoRoot || selectedBranchRepository?.repoRoot || branchSelectedRepoRoot || repoRoot || "").trim();
    return resolveSelectedBranchPopupRepository(branchPopup || null, normalizedRepoRoot) || selectedBranchRepository || null;
  }, [branchPopup, branchSelectedRepoRoot, repoRoot, selectedBranchRepository]);

  /**
   * 把两分支比较落到现有日志视图，用 revision range 驱动真实 compare，而不是退化成单纯 branch filter。
   */
  const openBranchCompareCommits = useCallback((targetRepoRoot: string, leftRef: string, rightRef: string): void => {
    const revision = buildBranchCompareRevision(leftRef, rightRef);
    if (!revision) {
      setError(gt("workbench.branchCompare.invalidRef", "缺少有效的比较引用"));
      return;
    }
    closeUpdateInfoLogView();
    setBottomCollapsed(false);
    setBottomTab("git");
    setPendingLogSelectionHash("");
    setBranchCompareState({
      repoRoot: String(targetRepoRoot || "").trim(),
      leftRef: String(leftRef || "").trim(),
      rightRef: String(rightRef || "").trim(),
      revision,
    });
    setLogFilters((prev) => normalizeGitLogFilters({
      ...prev,
      branch: "all",
      revision,
      path: "",
      followRenames: false,
    }));
  }, [closeUpdateInfoLogView]);

  /**
   * 读取两侧引用之间的文件差异列表，并打开专用对话框承接 branch-to-branch / branch-to-working file diff。
   */
  const openBranchCompareFilesDialogAsync = useCallback(async (
    targetRepoRoot: string,
    leftRef: string,
    rightRef?: string,
  ): Promise<void> => {
    const actionRepoRoot = String(targetRepoRoot || "").trim();
    const normalizedLeftRef = String(leftRef || "").trim();
    const normalizedRightRef = String(rightRef || "").trim();
    if (!actionRepoRoot || !normalizedLeftRef) return;
    const res = await getBranchCompareFilesAsync(actionRepoRoot, {
      leftRef: normalizedLeftRef,
      rightRef: normalizedRightRef || undefined,
    });
    if (!res.ok) {
      setError(getErrorText(res.error, "workbench.branchCompare.fileDiffLoadFailed", "读取文件差异失败"));
      return;
    }
    setBranchCompareFilesDialogState(res.data || {
      repoRoot: actionRepoRoot,
      leftRef: normalizedLeftRef,
      rightRef: normalizedRightRef || undefined,
      files: [],
    });
  }, []);

  /**
   * 处理“任选另一分支比较”入口；若用户未显式提供另一侧，则先弹出统一选择对话框再分流到提交或文件比较。
   */
  const runArbitraryBranchCompareAsync = useCallback(async (
    mode: BranchCompareMode,
    targetRef: string,
    targetRepoRoot?: string,
  ): Promise<void> => {
    const repository = resolveBranchCompareRepository(targetRepoRoot);
    const actionRepoRoot = String(targetRepoRoot || repository?.repoRoot || repoRoot || "").trim();
    const normalizedTargetRef = String(targetRef || "").trim();
    if (!actionRepoRoot || !normalizedTargetRef) return;
    const config = buildBranchCompareDialogConfig({
      repository,
      targetRef: normalizedTargetRef,
      mode,
    });
    if (!config) {
      setError(gt("workbench.branchCompare.noOtherBranch", "当前仓库没有可用于比较的其他分支"));
      return;
    }
    const form = await openActionDialogAsync(config);
    if (!form) return;
    const otherRef = String(form.otherRef || "").trim();
    if (!otherRef) return;
    if (mode === "files") {
      await openBranchCompareFilesDialogAsync(actionRepoRoot, normalizedTargetRef, otherRef);
      return;
    }
    openBranchCompareCommits(actionRepoRoot, normalizedTargetRef, otherRef);
  }, [buildBranchCompareDialogConfig, openActionDialogAsync, openBranchCompareCommits, openBranchCompareFilesDialogAsync, repoRoot, resolveBranchCompareRepository]);

  /**
   * 为“删除分支成功”提示构造补救动作，对齐 IDEA 的 Restore / View commits / Delete tracked branch 语义。
   */
  const buildDeletedBranchRecoveryNoticeActions = useCallback((recoveryInfo: GitDeletedBranchRecoveryInfo, repoRootOverride?: string): GitNoticeActionItem[] => {
    const actionRepoRoot = String(repoRootOverride || repoRoot || "").trim();
    const deletedBranchName = String(recoveryInfo.deletedBranchName || "").trim();
    const deletedTipHash = String(recoveryInfo.deletedTipHash || "").trim();
    const viewRevision = String(recoveryInfo.viewRevision || "").trim();
    const trackedRemoteRef = String(recoveryInfo.trackedRemoteRef || "").trim();
    const actions: GitNoticeActionItem[] = [];

    if (deletedBranchName && deletedTipHash) {
      actions.push({
        id: "restore",
        label: gt("workbench.branch.restoreDeletedBranchAction", "恢复分支"),
        onClick: async () => {
          if (!actionRepoRoot) return;
          setError("");
          const res = await runBranchActionAsync(actionRepoRoot, {
            action: "new",
            name: deletedBranchName,
            startPoint: deletedTipHash,
          });
          if (!res.ok) {
            setError(toErrorText(res.error, gitWorkbenchText("workbench.branch.restoreDeletedBranchFailed", "恢复分支 '{{name}}' 失败", { name: deletedBranchName })));
            return;
          }
          await refreshAllAsync({ keepLog: false });
          finalizeGitNotice({
            action: "branch.action",
            tone: "info",
            message: gitWorkbenchText("workbench.branch.restoredDeletedBranch", "已恢复分支 '{{name}}'", { name: deletedBranchName }),
          });
        },
      });
    }

    if (viewRevision && recoveryInfo.forcedAfterNotFullyMerged === true) {
      actions.push({
        id: "view-commits",
        label: gt("workbench.branch.viewDeletedBranchCommitsAction", "查看提交"),
        onClick: () => {
          closeUpdateInfoLogView();
          setBottomCollapsed(false);
          setBottomTab("log");
          setPendingLogSelectionHash(deletedTipHash);
          setLogFilters((prev) => normalizeGitLogFilters({
            ...prev,
            revision: viewRevision,
            branch: "all",
            path: "",
            followRenames: false,
          }));
        },
      });
    }

    if (trackedRemoteRef && recoveryInfo.canDeleteTrackedBranch === true) {
      actions.push({
        id: "delete-tracked-branch",
        label: gt("workbench.branch.deleteTrackedRemoteBranchAction", "删除跟踪远端分支"),
        onClick: async () => {
          if (!actionRepoRoot) return;
          const form = await openActionDialogAsync({
            title: gt("workbench.branch.deleteTrackedRemoteBranchTitle", "删除跟踪远端分支"),
            description: gitWorkbenchText("workbench.branch.deleteRemoteDescription", "确定删除远端分支 {{name}} 吗？", { name: trackedRemoteRef }),
            confirmText: gt("workbench.common.delete", "删除"),
            fields: [],
          });
          if (!form) return;
          setError("");
          const res = await runBranchActionAsync(actionRepoRoot, {
            action: "deleteRemote",
            name: trackedRemoteRef,
          });
          if (!res.ok) {
            setError(toErrorText(res.error, gitWorkbenchText("workbench.branch.deleteRemoteFailed", "删除远端分支 '{{name}}' 失败", { name: trackedRemoteRef })));
            return;
          }
          await refreshAllAsync({ keepLog: false });
          finalizeGitNotice({
            action: "branch.action",
            tone: "info",
            message: gitWorkbenchText("workbench.branch.deletedRemoteBranch", "已删除远端分支 '{{name}}'", { name: trackedRemoteRef }),
          });
        },
      });
    }

    return actions;
  }, [closeUpdateInfoLogView, finalizeGitNotice, openActionDialogAsync, refreshAllAsync, repoRoot]);

  /**
   * 为删除标签成功 notice 构建恢复动作，保持与删除分支后的恢复交互一致。
   */
  const buildDeletedTagRecoveryNoticeActions = useCallback((recoveryInfo: GitDeletedTagRecoveryInfo, repoRootOverride?: string): GitNoticeActionItem[] => {
    const actionRepoRoot = String(repoRootOverride || repoRoot || "").trim();
    const deletedTagName = String(recoveryInfo.deletedTagName || "").trim();
    const deletedTagTarget = String(recoveryInfo.deletedTagTarget || "").trim();
    if (!actionRepoRoot || !deletedTagName || !deletedTagTarget) return [];
    return [{
      id: "restore-tag",
      label: gt("workbench.branch.restoreTagAction", "恢复标签"),
      onClick: async () => {
        setError("");
        const res = await runBranchActionAsync(actionRepoRoot, {
          action: "restoreTag",
          name: deletedTagName,
          target: deletedTagTarget,
        });
        if (!res.ok) {
          setError(toErrorText(res.error, gitWorkbenchText("workbench.branch.restoreTagFailed", "恢复标签 '{{name}}' 失败", { name: deletedTagName })));
          return;
        }
        await refreshAllAsync({ keepLog: false });
        finalizeGitNotice({
          action: "branch.action",
          tone: "info",
          message: gitWorkbenchText("workbench.branch.restoredTag", "已恢复标签 '{{name}}'", { name: deletedTagName }),
        });
      },
    }];
  }, [finalizeGitNotice, refreshAllAsync, repoRoot]);

  /**
   * 处理分支树右键动作。
   */
  const runBranchTreeActionAsync = useCallback(
    async (
      action:
        | "checkout"
        | "checkoutUpdate"
        | "rename"
        | "delete"
        | "deleteRemote"
        | "new"
        | "newFrom"
        | "createWorktree"
        | "openExistingWorktree"
        | "checkoutRebaseCurrent"
        | "compareCurrent"
        | "compareAny"
        | "worktreeDiff"
        | "compareAnyFiles"
        | "configureRemotes"
        | "editRemote"
        | "removeRemote"
        | "rebaseCurrentToTarget"
        | "mergeTargetToCurrent"
        | "pullRemoteMerge"
        | "pullRemoteRebase"
        | "update"
        | "push",
      target?: string,
      targetRepoRoot?: string,
    ): Promise<void> => {
      const actionRepoRoot = String(targetRepoRoot || selectedBranchRepository?.repoRoot || branchSelectedRepoRoot || repoRoot || "").trim();
      const actionCurrentBranch = String(selectedBranchRepository?.currentBranch || repoBranch || "").trim();
      const actionDetached = selectedBranchRepository?.detached ?? repoDetached;
      const actionKnownRemoteNames = selectedBranchKnownRemoteNames.length > 0 ? selectedBranchKnownRemoteNames : knownRemoteNames;
      if (!actionRepoRoot) return;
      if (action === "configureRemotes") {
        openBranchRemoteManagerDialog(actionRepoRoot);
        return;
      }
      if (action === "editRemote" && target) {
        await openBranchRemoteEditorAsync(actionRepoRoot, target);
        return;
      }
      if (action === "removeRemote" && target) {
        await removeBranchRemoteAsync(target, actionRepoRoot);
        return;
      }
      if (action === "checkout" && target) {
        const res = await switchBranchAsync(actionRepoRoot, target);
        if (!res.ok) {
          const nextOperationProblem = extractOperationProblem(res.data);
          if (nextOperationProblem) {
            openOperationProblemDialog(nextOperationProblem, async (payloadPatch) => {
              await retryCheckoutBranchAsync(target, {}, payloadPatch, actionCurrentBranch, actionRepoRoot);
            });
            return;
          }
          setError(getErrorText(res.error, "workbench.branch.checkoutFailed", "签出分支失败"));
        } else {
          await finishBranchCheckoutAsync({
            requestId: res.meta?.requestId,
            action: "branch.switch",
            repoRootOverride: actionRepoRoot,
            targetBranch: target,
            previousBranch: actionCurrentBranch,
            data: res.data,
          });
        }
        return;
      }
        if (action === "checkoutUpdate" && target) {
        const res = await runBranchActionAsync(actionRepoRoot, { action: "checkoutUpdate", ref: target });
        if (!res.ok) {
          const nextOperationProblem = extractOperationProblem(res.data);
          if (nextOperationProblem) {
            openOperationProblemDialog(nextOperationProblem, async (payloadPatch) => {
              await retryCheckoutUpdateAsync(target, {}, payloadPatch, actionCurrentBranch, actionRepoRoot);
            });
            return;
          }
          await handlePullLikeResultAsync("updateBranch", res, {
            branchName: target,
            fallbackMessage: gt("workbench.branch.checkoutUpdateFailed", "签出并更新失败"),
            retryAsync: async (payloadPatch) => {
              await retryCheckoutUpdateAsync(target, {}, payloadPatch, actionCurrentBranch, actionRepoRoot);
            },
          });
        } else {
          await finishBranchCheckoutAsync({
            requestId: res.meta?.requestId,
            action: "branch.action",
            repoRootOverride: actionRepoRoot,
            targetBranch: target,
            previousBranch: actionCurrentBranch,
            data: res.data,
          });
        }
        return;
      }
      if (action === "rename" && target) {
        const form = await openActionDialogAsync({
          title: gt("workbench.branch.renameTitle", "重命名分支"),
          description: gitWorkbenchText("workbench.branch.currentBranchDescription", "当前分支：{{branch}}", { branch: target }),
          confirmText: gt("workbench.common.save", "保存"),
          fields: [{
            key: "newName",
            label: gt("workbench.branch.newNameLabel", "新分支名"),
            placeholder: gt("workbench.branch.newNamePlaceholder", "功能/xxx"),
            required: true,
          }],
          defaults: { newName: target },
        });
        if (!form) return;
        const res = await runBranchActionAsync(actionRepoRoot, { action: "rename", oldName: target, newName: form.newName });
        if (!res.ok) setError(getErrorText(res.error, "workbench.branch.renameFailed", "重命名分支失败"));
        else await refreshAllAsync({ keepLog: false });
        return;
      }
      if (action === "delete" && target) {
        const form = await openActionDialogAsync({
          title: gt("workbench.branch.deleteTitle", "删除分支"),
          description: gitWorkbenchText("workbench.branch.deleteDescription", "确定删除分支 {{name}} 吗？", { name: target }),
          confirmText: gt("workbench.common.delete", "删除"),
          fields: [],
        });
        if (!form) return;
        const res = await runBranchActionAsync(actionRepoRoot, { action: "delete", name: target });
        if (!res.ok) setError(getErrorText(res.error, "workbench.branch.deleteFailed", "删除分支失败"));
        else {
          const recoveryInfo = res.data && typeof res.data === "object"
            ? res.data as GitDeletedBranchRecoveryInfo
            : {};
          const deletedBranchName = String(recoveryInfo.deletedBranchName || target).trim() || target;
          const noticeActions = buildDeletedBranchRecoveryNoticeActions(recoveryInfo, actionRepoRoot);
          await refreshAllAsync({ keepLog: false });
          finalizeGitNotice({
            action: "branch.action",
            tone: recoveryInfo.forcedAfterNotFullyMerged === true ? "warn" : "info",
            message: recoveryInfo.forcedAfterNotFullyMerged === true
              ? gitWorkbenchText("workbench.branch.forceDeletedWithUnmerged", "分支 '{{name}}' 已强制删除；检测到未合并提交，可通过下方动作恢复或查看影响范围", { name: deletedBranchName })
              : gitWorkbenchText("workbench.branch.deleted", "分支 '{{name}}' 已删除", { name: deletedBranchName }),
            actions: noticeActions.length > 0 ? noticeActions : undefined,
          });
        }
        return;
      }
      if (action === "deleteRemote" && target) {
        const parsed = parseRemoteBranchRefName(target, actionKnownRemoteNames);
        if (!parsed || parsed.branch === "HEAD") {
          setError(gt("workbench.branch.invalidRemoteBranchForDelete", "远端分支格式无效或不支持删除远端 HEAD 引用"));
          return;
        }
        const form = await openActionDialogAsync({
          title: gt("workbench.branch.deleteRemoteTitle", "删除远端分支"),
          description: gitWorkbenchText("workbench.branch.deleteRemoteDescription", "确定删除远端分支 {{name}} 吗？", { name: target }),
          confirmText: gt("workbench.common.delete", "删除"),
          fields: [],
        });
        if (!form) return;
        const res = await runBranchActionAsync(actionRepoRoot, { action: "deleteRemote", name: target });
        if (!res.ok) setError(getErrorText(res.error, "workbench.branch.deleteRemoteGenericFailed", "删除远端分支失败"));
        else await refreshAllAsync({ keepLog: false });
        return;
      }
      if (action === "new") {
        const form = await openActionDialogAsync(buildCreateBranchDialogConfig({
          description: buildGitDialogText("actionDialogs.branch.newDescription", "请输入新分支名称"),
        }));
        if (!form) return;
        const res = await runBranchActionAsync(actionRepoRoot, { action: "new", name: form.name });
        if (!res.ok) setError(getErrorText(res.error, "workbench.branch.createFailed", "新建分支失败"));
        else await refreshAllAsync({ keepLog: false });
        return;
      }
      if (action === "newFrom" && target) {
        const form = await openActionDialogAsync(buildCreateBranchDialogConfig({
          title: buildGitDialogText("actionDialogs.branch.title", "新建分支"),
          description: buildGitDialogText("actionDialogs.branch.fromRefDescription", "基于 {{target}} 创建新分支", { target }),
        }));
        if (!form) return;
        const res = await runBranchActionAsync(actionRepoRoot, { action: "new", name: form.name, startPoint: target });
        if (!res.ok) setError(getErrorText(res.error, "workbench.branch.createFailed", "新建分支失败"));
        else await refreshAllAsync({ keepLog: false });
        return;
      }
      if (action === "createWorktree") {
        await createWorktreeFromRefAsync(target, actionRepoRoot);
        return;
      }
      if (action === "openExistingWorktree" && target) {
        const normalizePathForCompare = (value: string): string => String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const currentWorktreePath = normalizePathForCompare(actionRepoRoot);
        const existing = worktreeItems.find((item) => {
          const branch = String(item.branch || "").trim();
          if (!branch || branch !== target) return false;
          return normalizePathForCompare(String(item.path || "")) !== currentWorktreePath;
        });
        const pathText = String(existing?.path || "").trim();
        if (!pathText) {
          setError(gt("workbench.branch.checkedOutWorktreeNotFound", "未找到该分支对应的已签出工作树"));
          return;
        }
        await openProjectAtPathAsync(pathText);
        return;
      }
      if (action === "checkoutRebaseCurrent" && target) {
        const baseBranch = actionCurrentBranch;
        if (!baseBranch || actionDetached) {
          setError(gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持"));
          return;
        }
        const form = await openActionDialogAsync({
          title: gt("workbench.branches.context.checkoutAndRebaseToCurrent", "签出并变基到 '{{branch}}'", { branch: baseBranch }),
          description: gt("actionDialogs.checkoutRebaseCurrent.description", "将签出 {{target}} 并执行 git rebase {{branch}}", { target, branch: baseBranch }),
          confirmText: gt("actionDialogs.checkoutRebaseCurrent.confirm", "执行"),
          fields: [],
        });
        if (!form) return;
        await runBranchPullLikeActionAsync(
          { action: "checkoutRebaseToBranch", name: target, onto: baseBranch },
          {
            branchName: target,
            fallbackMessage: gt("actionDialogs.checkoutRebaseCurrent.failed", "签出并变基失败"),
            repoRoot: actionRepoRoot,
          },
        );
        return;
      }
      if (action === "compareCurrent" && target) {
        if (!actionCurrentBranch || actionDetached) {
          setError(gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持"));
          return;
        }
        openBranchCompareCommits(actionRepoRoot, target, actionCurrentBranch);
        return;
      }
      if (action === "compareAny" && target) {
        await runArbitraryBranchCompareAsync("commits", target, actionRepoRoot);
        return;
      }
      if (action === "worktreeDiff" && target) {
        await openBranchCompareFilesDialogAsync(actionRepoRoot, target);
        return;
      }
      if (action === "compareAnyFiles" && target) {
        await runArbitraryBranchCompareAsync("files", target, actionRepoRoot);
        return;
      }
      if (action === "rebaseCurrentToTarget" && target) {
        const baseBranch = actionCurrentBranch;
        if (!baseBranch || actionDetached) {
          setError(gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持"));
          return;
        }
        const form = await openActionDialogAsync({
          title: gt("workbench.branches.context.rebaseCurrentToTarget", "将 '{{branch}}' 变基到 '{{target}}'", { branch: baseBranch, target }),
          description: gt("actionDialogs.rebaseCurrentToTarget.description", "将执行：checkout {{branch}} && rebase {{target}}", { branch: baseBranch, target }),
          confirmText: gt("actionDialogs.rebaseCurrentToTarget.confirm", "执行"),
          fields: [],
        });
        if (!form) return;
        await runBranchPullLikeActionAsync(
          { action: "rebaseBranchTo", base: baseBranch, target },
          {
            branchName: baseBranch,
            fallbackMessage: gt("actionDialogs.rebaseCurrentToTarget.failed", "变基失败"),
            repoRoot: actionRepoRoot,
          },
        );
        return;
      }
      if (action === "mergeTargetToCurrent" && target) {
        const baseBranch = actionCurrentBranch;
        if (!baseBranch || actionDetached) {
          setError(gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持"));
          return;
        }
        const form = await openActionDialogAsync({
          title: gt("workbench.branches.context.mergeTargetToCurrent", "将 '{{target}}' 合并到 '{{branch}}' 中", { target, branch: baseBranch }),
          description: gt("actionDialogs.mergeTargetToCurrent.description", "将执行：checkout {{branch}} && merge {{target}}", { branch: baseBranch, target }),
          confirmText: gt("actionDialogs.mergeTargetToCurrent.confirm", "合并"),
          fields: [],
        });
        if (!form) return;
        await runBranchPullLikeActionAsync(
          { action: "mergeIntoBranch", base: baseBranch, source: target },
          {
            branchName: baseBranch,
            fallbackMessage: gt("actionDialogs.mergeTargetToCurrent.failed", "合并失败"),
            repoRoot: actionRepoRoot,
          },
        );
        return;
      }
      if ((action === "pullRemoteMerge" || action === "pullRemoteRebase") && target) {
        const parsed = parseRemoteBranchRefName(target, actionKnownRemoteNames);
        if (!parsed || parsed.branch === "HEAD") {
          setError(gt("workbench.branches.context.invalidRemoteBranch", "远端分支格式无效或不支持该引用"));
          return;
        }
        if (actionDetached || !actionCurrentBranch) {
          setError(gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持"));
          return;
        }
        const useRebase = action === "pullRemoteRebase";
        const form = await openActionDialogAsync({
          title: useRebase
            ? gt("workbench.branches.context.pullRemoteRebase", "将 '{{branch}}' 与该远端分支变基拉取", { branch: actionCurrentBranch })
            : gt("workbench.branches.context.pullRemoteMerge", "将 '{{branch}}' 与该远端分支合并拉取", { branch: actionCurrentBranch }),
          description: useRebase
            ? gt("actionDialogs.pullRemoteToCurrent.rebaseDescription", "将执行：git pull --rebase {{remote}} {{branch}}", { remote: parsed.remote, branch: parsed.branch })
            : gt("actionDialogs.pullRemoteToCurrent.mergeDescription", "将执行：git pull {{remote}} {{branch}}", { remote: parsed.remote, branch: parsed.branch }),
          confirmText: gt("actionDialogs.pullRemoteToCurrent.confirm", "执行"),
          fields: [],
        });
        if (!form) return;
        await runBranchPullLikeActionAsync(
          {
            action: "pullRemote",
            ref: target,
            mode: useRebase ? "rebase" : "merge",
          },
          {
            branchName: actionCurrentBranch || undefined,
            fallbackMessage: useRebase
              ? gt("workbench.pull.rebaseFailed", "Pull（Rebase）失败")
              : gt("workbench.pull.mergeFailed", "Pull（Merge）失败"),
            repoRoot: actionRepoRoot,
          },
        );
        return;
      }
      if (action === "update" && target) {
        setError("");
        const res = await runBranchActionAsync(actionRepoRoot, { action: "updateBranch", name: target });
        if (target === actionCurrentBranch) {
          await handlePullLikeResultAsync("updateBranch", res, {
            branchName: target,
            fallbackMessage: gt("workbench.update.failed", "更新失败"),
            retryAsync: async (payloadPatch) => {
              await retryUpdateBranchAsync(target, {}, payloadPatch, actionRepoRoot);
            },
          });
          return;
        }
        if (!res.ok) {
          if (res.data?.shouldRefresh === true) {
            await refreshAllAsync({ keepLog: false });
          }
          finalizeGitNotice({
            requestId: res.meta?.requestId,
            action: "branch.action",
            tone: "danger",
            message: toErrorText(res.error, gt("workbench.update.failed", "更新失败")),
          });
        } else {
          await refreshAllAsync({ keepLog: false });
          pushFlowFeedbackNotice({
            action: "updateBranch",
            requestId: res.meta?.requestId,
            data: res.data,
            branchName: target,
          });
        }
        return;
      }
      if (action === "push" && target) {
        setError("");
        const res = await runBranchActionAsync(actionRepoRoot, { action: "pushBranch", name: target });
        if (!res.ok) {
          if (res.data?.shouldRefresh === true) {
            await refreshAllAsync({ keepLog: false });
          }
          finalizeGitNotice({
            requestId: res.meta?.requestId,
            action: "branch.action",
            tone: "danger",
            message: getErrorText(res.error, "workbench.push.failed", "推送失败"),
          });
        } else {
          await refreshAllAsync({ keepLog: false });
          pushFlowFeedbackNotice({
            action: "pushBranch",
            requestId: res.meta?.requestId,
            data: res.data,
            branchName: target,
          });
        }
      }
    },
    [branchSelectedRepoRoot, buildDeletedBranchRecoveryNoticeActions, createWorktreeFromRefAsync, finalizeGitNotice, finishBranchCheckoutAsync, handlePullLikeResultAsync, knownRemoteNames, openActionDialogAsync, openBranchCompareCommits, openBranchCompareFilesDialogAsync, openBranchRemoteEditorAsync, openBranchRemoteManagerDialog, openOperationProblemDialog, openProjectAtPathAsync, pushFlowFeedbackNotice, refreshAllAsync, removeBranchRemoteAsync, repoDetached, repoBranch, repoRoot, retryCheckoutBranchAsync, retryCheckoutUpdateAsync, retryUpdateBranchAsync, runArbitraryBranchCompareAsync, runBranchPullLikeActionAsync, selectedBranchKnownRemoteNames, selectedBranchRepository?.currentBranch, selectedBranchRepository?.detached, selectedBranchRepository?.repoRoot, worktreeItems],
  );

  /**
   * 执行日志菜单中的“提交 refs 分支/标签操作”（对齐 IDEA Git.BranchOperationGroup 主链路）。
   */
  const runLogRefMenuActionAsync = useCallback(
    async (
      action:
        | "checkout"
        | "checkoutUpdate"
        | "newFrom"
        | "createWorktree"
        | "openExistingWorktree"
        | "checkoutRebaseCurrent"
        | "compareCurrent"
        | "compareAny"
        | "worktreeDiff"
        | "compareAnyFiles"
        | "configureRemotes"
        | "editRemote"
        | "removeRemote"
        | "rebaseCurrentToTarget"
        | "mergeTargetToCurrent"
        | "pullRemoteMerge"
        | "pullRemoteRebase"
        | "update"
        | "push"
        | "rename"
        | "delete"
        | "deleteRemote"
        | "deleteTag"
        | "pushTag",
      target: string,
    ): Promise<void> => {
      if (!repoRoot) return;
      const refName = String(target || "").trim();
      if (!refName) return;
        if (action === "deleteTag") {
          const form = await openActionDialogAsync({
          title: gt("workbench.misc.push.deleteTagTitle", "删除标签"),
          description: gt("workbench.misc.push.deleteTagDescription", "确定删除标签 {{name}} 吗？", { name: refName }),
          confirmText: gt("workbench.misc.push.deleteTagConfirm", "删除"),
          fields: [],
        });
        if (!form) return;
        const res = await runBranchActionAsync(repoRoot, { action: "deleteTag", name: refName });
        if (!res.ok) {
          setError(toErrorText(res.error, gt("workbench.misc.push.deleteTagFailed", "删除标签失败")));
          return;
        }
        const recoveryInfo = res.data && typeof res.data === "object"
          ? res.data as GitDeletedTagRecoveryInfo
          : {};
        const deletedTagName = String(recoveryInfo.deletedTagName || refName).trim() || refName;
        const noticeActions = buildDeletedTagRecoveryNoticeActions(recoveryInfo, repoRoot);
        await refreshAllAsync({ keepLog: false });
        finalizeGitNotice({
          action: "branch.action",
          tone: "info",
          message: gitWorkbenchText("workbench.branch.deletedTag", "已删除标签 '{{name}}'", { name: deletedTagName }),
          actions: noticeActions.length > 0 ? noticeActions : undefined,
        });
        return;
      }
      if (action === "pushTag") {
        const remoteCandidates = Array.from(new Set(
          (branchPopup?.groups?.remote || [])
            .map((one) => parseRemoteBranchRefName(String(one.name || "").trim(), knownRemoteNames)?.remote || "")
            .filter(Boolean),
        ));
        const defaultRemote = remoteCandidates.includes("origin") ? "origin" : (remoteCandidates[0] || "");
        if (!defaultRemote) {
          setError(gt("workbench.misc.push.noTags", "未检测到可用远端仓库，无法推送标签"));
          return;
        }
        let remote = defaultRemote;
        if (remoteCandidates.length > 1) {
          const form = await openActionDialogAsync({
            title: gt("workbench.misc.push.pushTags", "推送标签"),
            description: gt("workbench.misc.push.pushTagsDescription", "请选择标签 {{name}} 的推送远端", { name: refName }),
            confirmText: gt("workbench.misc.push.push", "推送"),
            fields: [{
              key: "remote",
              label: gt("workbench.misc.push.remoteRepository", "远端仓库"),
              type: "select",
              options: remoteCandidates.map((one) => ({ value: one, label: one })),
              required: true,
            }],
            defaults: { remote: defaultRemote },
          });
          if (!form) return;
          remote = String(form.remote || "").trim() || defaultRemote;
        }
        const res = await runBranchActionAsync(repoRoot, { action: "pushTag", name: refName, remote });
        if (!res.ok) setError(toErrorText(res.error, gt("workbench.misc.push.pushTagFailed", "推送标签失败")));
        else await refreshAllAsync({ keepLog: true });
        return;
      }
      await runBranchTreeActionAsync(action as Exclude<typeof action, "deleteTag" | "pushTag">, refName);
    },
    [
      branchPopup?.groups?.remote,
      buildDeletedTagRecoveryNoticeActions,
      finalizeGitNotice,
      knownRemoteNames,
      openActionDialogAsync,
      refreshAllAsync,
      repoRoot,
      runBranchTreeActionAsync,
    ],
  );

  /**
   * 双击分支节点时切换日志分支筛选；再次双击同一分支则恢复全部。
   */
  const toggleBranchFilter = useCallback((branchName: string): void => {
    const name = String(branchName || "").trim();
    if (!name) return;
    closeUpdateInfoLogView();
    setBottomTab("git");
    setPendingLogSelectionHash("");
    setLogFilters((prev) => {
      const currentValues = getGitLogBranchFilterValues(prev);
      const shouldClear = currentValues.length === 1 && currentValues[0] === name;
      return normalizeGitLogFilters({
        ...prev,
        revision: "",
        branch: shouldClear ? "all" : name,
        branchValues: shouldClear ? [] : [name],
      });
    });
  }, [closeUpdateInfoLogView]);

  /**
   * 统一更新日志分支 dashboard 设置，避免多个入口各自拼接状态对象。
   */
  const updateLogBranchesDashboardState = useCallback((patch: Partial<GitLogBranchesDashboardState>): void => {
    setLogBranchesDashboardState((prev) => ({ ...prev, ...patch }));
  }, []);

  /**
   * 执行日志分支 dashboard 的“选择分支”动作。
   * 在 Git 面板“分支”侧栏的双击交互范围内，当前产品设计要求双击分支优先切换当前日志筛选，不再因仓库上下文不一致而中断；
   * 若所选分支并非当前日志仓，或路径只在大小写/分隔符层面不同，则直接按分支名切换筛选。
   * 设计如此，此处在“分支侧栏双击筛选”范围内继续不对齐 IDEA，以保证交互稳定可用。
   */
  const applyLogBranchSelection = useCallback((args: {
    branchName: string;
    repoRoot?: string;
    hash?: string;
  }): void => {
    const branchName = String(args.branchName || "").trim();
    const targetRepoRoot = String(args.repoRoot || repoRoot || "").trim();
    const normalizedCurrentRepoRoot = String(repoRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const normalizedTargetRepoRoot = targetRepoRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!branchName) return;
    if (!normalizedCurrentRepoRoot || !normalizedTargetRepoRoot || normalizedTargetRepoRoot !== normalizedCurrentRepoRoot) {
      toggleBranchFilter(branchName);
      return;
    }
    if (logBranchesDashboardState.selectionAction === "navigate") {
      const targetHash = String(args.hash || "").trim();
      closeUpdateInfoLogView();
      setBottomTab("git");
      setPendingLogSelectionHash(targetHash);
      setLogFilters(normalizeGitLogFilters({ ...DEFAULT_LOG_FILTERS, branch: "all", revision: "" }));
      if (!targetHash) {
        toggleBranchFilter(branchName);
      }
      return;
    }
    toggleBranchFilter(branchName);
  }, [closeUpdateInfoLogView, logBranchesDashboardState.selectionAction, repoRoot, toggleBranchFilter]);

  /**
   * 折叠/展开左侧提交面板，恢复时优先回到用户上次拖拽设置的固定像素宽度。
   */
  const toggleLeftPanelCollapsed = useCallback((): void => {
    if (leftCollapsed) {
      const resolved = resolveMainPanelLayout(
        upperLayoutRef.current?.clientWidth || upperLayoutWidth || 0,
        null,
        Math.max(220, leftExpandedWidthRef.current || DEFAULT_LEFT_PANEL_WIDTH),
        SPLITTER_SIZE,
      );
      setLeftPanelWidth(resolved.width);
      setLeftPanelProportion(null);
      setLeftCollapsed(false);
      return;
    }
    setLeftCollapsed(true);
  }, [leftCollapsed, upperLayoutWidth]);

  /**
   * 提交面板一键展开所有分组与目录节点。
   */
  const expandAllCommitTree = useCallback((): void => {
    setCommitGroupExpanded((prev) => {
      const next = { ...prev };
      for (const group of commitTreeGroups) next[group.key] = true;
      return next;
    });
    setCommitTreeExpanded((prev) => {
      const next = { ...prev };
      const walk = (nodes: CommitPanelTreeNode[]) => {
        for (const node of nodes) {
          if (node.isFile) continue;
          if (!canCommitTreeNodeExpandSafely(node.fileCount || node.count || 0)) continue;
          next[node.key] = true;
          walk(node.children);
        }
      };
      for (const group of commitTreeGroups) {
        walk(group.treeNodes);
      }
      return next;
    });
  }, [commitTreeGroups]);

  /**
   * 提交面板一键收起所有分组与目录节点。
   */
  const collapseAllCommitTree = useCallback((): void => {
    setCommitGroupExpanded((prev) => {
      const next = { ...prev };
      for (const group of commitTreeGroups) next[group.key] = false;
      return next;
    });
    setCommitTreeExpanded((prev) => {
      const next = { ...prev };
      const walk = (nodes: CommitPanelTreeNode[]) => {
        for (const node of nodes) {
          if (node.isFile) continue;
          next[node.key] = false;
          walk(node.children);
        }
      };
      for (const group of commitTreeGroups) {
        walk(group.treeNodes);
      }
      return next;
    });
  }, [commitTreeGroups]);

  /**
   * 详情面板一键展开所有目录节点。
   */
  const expandAllDetailTree = useCallback((): void => {
    setDetailTreeExpanded((prev) => {
      const next = { ...prev };
      const walk = (nodes: DetailTreeNode[]) => {
        for (const node of nodes) {
          if (node.isFile) continue;
          next[node.key] = true;
          walk(node.children);
        }
      };
      walk(detailFileTree);
      return next;
    });
  }, [detailFileTree]);

  /**
   * 详情面板一键收起所有目录节点。
   */
  const collapseAllDetailTree = useCallback((): void => {
    setDetailTreeExpanded((prev) => {
      const next = { ...prev };
      const walk = (nodes: DetailTreeNode[]) => {
        for (const node of nodes) {
          if (node.isFile) continue;
          next[node.key] = false;
          walk(node.children);
        }
      };
      walk(detailFileTree);
      return next;
    });
  }, [detailFileTree]);

  /**
   * 切换 Worktree 树节点展开状态，默认展开。
   */
  const toggleWorktreeTreeExpanded = useCallback((nodeKey: string): void => {
    const key = String(nodeKey || "").trim();
    if (!key) return;
    setWorktreeTreeExpanded((prev) => ({ ...prev, [key]: prev[key] === false }));
  }, []);

  /**
   * 应用日志日期筛选预设；自定义范围通过对话框录入。
   */
  const applyDateFilterPresetAsync = useCallback(async (preset: string): Promise<void> => {
    const mode = String(preset || "").trim();
    if (mode === "all") {
      updateActiveLogFilters((prev) => ({ ...prev, dateFrom: "", dateTo: "" }));
      return;
    }
    if (mode === "1d" || mode === "7d" || mode === "30d") {
      const days = mode === "1d" ? 1 : (mode === "7d" ? 7 : 30);
      const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      updateActiveLogFilters((prev) => ({ ...prev, dateFrom: start, dateTo: "" }));
      return;
    }

    const form = await openActionDialogAsync({
      title: gt("actionDialogs.dateFilter.title", "日期筛选"),
      description: gt("actionDialogs.dateFilter.description", "请输入日期范围（ISO 日期格式，如 2026-03-05）"),
      confirmText: gt("actionDialogs.dateFilter.confirm", "应用"),
      fields: [
        { key: "dateFrom", label: gt("actionDialogs.dateFilter.fromLabel", "起始日期"), placeholder: gt("actionDialogs.dateFilter.fromPlaceholder", "YYYY-MM-DD") },
        { key: "dateTo", label: gt("actionDialogs.dateFilter.toLabel", "结束日期"), placeholder: gt("actionDialogs.dateFilter.toPlaceholder", "YYYY-MM-DD") },
      ],
      defaults: { dateFrom: activeLogFilters.dateFrom || "", dateTo: activeLogFilters.dateTo || "" },
    });
    if (!form) return;
    updateActiveLogFilters((prev) => ({
      ...prev,
      dateFrom: String(form.dateFrom || "").trim(),
      dateTo: String(form.dateTo || "").trim(),
    }));
  }, [activeLogFilters.dateFrom, activeLogFilters.dateTo, openActionDialogAsync, updateActiveLogFilters]);

  /**
   * 初始化与激活时加载数据，未激活时不做请求；同一激活周期内对同一 repoPath 只做一次首刷。
   */
  useEffect(() => {
    const bootstrap = resolveGitWorkbenchBootstrapRefresh({
      active,
      repoPath,
      lastBootstrapRepoPath: bootstrapRefreshRepoPathRef.current,
    });
    bootstrapRefreshRepoPathRef.current = bootstrap.nextBootstrapRepoPath;
    if (!bootstrap.shouldRefresh) return;
    void invokeRefreshAllAsync({ keepLog: false });
  }, [active, invokeRefreshAllAsync, repoPath]);

  /**
   * 订阅底层 Git 活动，统一驱动状态栏文案，并在控制台页签下按操作完成后做一次去抖刷新。
   */
  useEffect(() => {
    if (!active) {
      gitActivityCountRef.current = 0;
      setGitActivityCount(0);
      setGitActivityText(gitWorkbenchText("workbench.misc.status.ready", "就绪"));
      if (gitConsoleRefreshTimerRef.current) {
        window.clearTimeout(gitConsoleRefreshTimerRef.current);
        gitConsoleRefreshTimerRef.current = null;
      }
      if (gitConsoleLiveRefreshTimerRef.current) {
        window.clearInterval(gitConsoleLiveRefreshTimerRef.current);
        gitConsoleLiveRefreshTimerRef.current = null;
      }
      if (branchSyncRefreshTimerRef.current) {
        window.clearTimeout(branchSyncRefreshTimerRef.current);
        branchSyncRefreshTimerRef.current = null;
      }
      return;
    }
    const unsubscribe = subscribeGitFeatureActivity((activity) => {
      const updateSession = extractUpdateSessionProgressSnapshot(activity.updateSession);
      if (activity.phase === "progress") {
        setGitActivityText(activity.message);
        upsertRunningGitNotice(activity);
        upsertRunningUpdateSession({ ...activity, updateSession: updateSession || undefined });
        return;
      }
      if (activity.phase === "start") {
        gitActivityCountRef.current += 1;
        setGitActivityCount(gitActivityCountRef.current);
        setGitActivityText(activity.message);
        upsertRunningGitNotice(activity);
        upsertRunningUpdateSession({ ...activity, updateSession: updateSession || undefined });
        return;
      }
      if (shouldAutoRefreshBranchSyncAfterActivity(activity.action, activity.ok) && repoRoot) {
        scheduleBranchPopupReload({
          preferredRepoRoot: String(activity.repoRoot || branchSelectedRepoRoot || repoRoot || "").trim() || undefined,
          preferredStep: branchPopupStep,
        });
      }
      gitActivityCountRef.current = Math.max(0, gitActivityCountRef.current - 1);
      setGitActivityCount(gitActivityCountRef.current);
      if (gitActivityCountRef.current > 0 || bottomTab !== "log" || gitConsoleLiveUpdatesPaused || activity.isConsoleAction || !repoRoot) return;
      if (gitConsoleRefreshTimerRef.current) window.clearTimeout(gitConsoleRefreshTimerRef.current);
      gitConsoleRefreshTimerRef.current = window.setTimeout(() => {
        gitConsoleRefreshTimerRef.current = null;
        if (!active || bottomTab !== "log" || gitConsoleLiveUpdatesPaused || !repoRoot) return;
        void loadGitConsoleAsync();
      }, 120);
    });
    return () => {
      unsubscribe();
      if (gitConsoleRefreshTimerRef.current) {
        window.clearTimeout(gitConsoleRefreshTimerRef.current);
        gitConsoleRefreshTimerRef.current = null;
      }
      if (gitConsoleLiveRefreshTimerRef.current) {
        window.clearInterval(gitConsoleLiveRefreshTimerRef.current);
        gitConsoleLiveRefreshTimerRef.current = null;
      }
      if (branchSyncRefreshTimerRef.current) {
        window.clearTimeout(branchSyncRefreshTimerRef.current);
        branchSyncRefreshTimerRef.current = null;
      }
    };
  }, [active, bottomTab, branchPopupStep, branchSelectedRepoRoot, gitConsoleLiveUpdatesPaused, loadGitConsoleAsync, repoRoot, scheduleBranchPopupReload, upsertRunningGitNotice, upsertRunningUpdateSession]);

  /**
   * 当“Git 控制台”页签处于打开且存在进行中操作时，按固定频率拉取最新输出，实现过程可见。
   */
  useEffect(() => {
    if (!active || bottomTab !== "log" || gitConsoleLiveUpdatesPaused || !repoRoot || gitActivityCount <= 0) {
      if (gitConsoleLiveRefreshTimerRef.current) {
        window.clearInterval(gitConsoleLiveRefreshTimerRef.current);
        gitConsoleLiveRefreshTimerRef.current = null;
      }
      return;
    }
    void loadGitConsoleAsync({ silent: true });
    if (gitConsoleLiveRefreshTimerRef.current) {
      window.clearInterval(gitConsoleLiveRefreshTimerRef.current);
    }
    gitConsoleLiveRefreshTimerRef.current = window.setInterval(() => {
      if (!active || bottomTab !== "log" || gitConsoleLiveUpdatesPaused || !repoRoot || gitActivityCountRef.current <= 0) return;
      void loadGitConsoleAsync({ silent: true });
    }, 600);
    return () => {
      if (gitConsoleLiveRefreshTimerRef.current) {
        window.clearInterval(gitConsoleLiveRefreshTimerRef.current);
        gitConsoleLiveRefreshTimerRef.current = null;
      }
    };
  }, [active, bottomTab, gitActivityCount, gitConsoleLiveUpdatesPaused, loadGitConsoleAsync, repoRoot]);

  /**
   * 组件卸载时结束仍在等待的对话框 Promise，避免悬挂。
   */
  useEffect(() => {
    return () => {
      if (actionDialogResolveRef.current) {
        actionDialogResolveRef.current(null);
        actionDialogResolveRef.current = null;
      }
      if (gitConsoleRefreshTimerRef.current) {
        window.clearTimeout(gitConsoleRefreshTimerRef.current);
        gitConsoleRefreshTimerRef.current = null;
      }
      if (gitConsoleLiveRefreshTimerRef.current) {
        window.clearInterval(gitConsoleLiveRefreshTimerRef.current);
        gitConsoleLiveRefreshTimerRef.current = null;
      }
      for (const timerId of gitNoticeTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      gitNoticeTimersRef.current.clear();
      for (const timerId of updateSessionTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      updateSessionTimersRef.current.clear();
    };
  }, []);

  /**
   * 筛选条件变更时重载日志。
   */
  useEffect(() => {
    if (!active || !repoRoot) return;
    const id = window.setTimeout(() => {
      void loadLogAsync(repoRoot, 0, true);
    }, 260);
    return () => window.clearTimeout(id);
  }, [active, activeLogFilters, loadLogAsync, repoRoot]);

  /**
   * 文件历史按修订打开后，待日志首屏加载完成时自动选中目标提交，避免停留在旧选择上。
   */
  useEffect(() => {
    const targetHash = String(pendingLogSelectionHash || "").trim();
    if (!targetHash) return;
    const hit = resolvePendingLogSelectionItem({
      logItems,
      targetHash,
      requireHistoryPath: isFileHistoryMode && !!String(activeLogFilters.path || "").trim(),
    });
    if (hit) {
      setSelectedCommitHashes((prev) => (prev.length === 1 && prev[0] === targetHash ? prev : [targetHash]));
      setPendingLogSelectionHash("");
      return;
    }
    if (!logLoading && !logHasMore) {
      setPendingLogSelectionHash("");
    }
  }, [activeLogFilters.path, isFileHistoryMode, logHasMore, logItems, logLoading, pendingLogSelectionHash]);

  /**
   * 文件历史模式下，单击提交记录后自动打开该文件在该提交上的 Diff，对齐 IDEA 文件历史联动行为。
   */
  useEffect(() => {
    if (!active || !repoRoot || !isFileHistoryMode) return;
    if (selectedCommitHashes.length !== 1) return;
    const selectedHash = String(selectedCommitHashes[0] || "").trim();
    const historyPath = String(activeLogFilters.path || "").trim();
    if (!selectedHash || !historyPath) return;
    const loadedHistoryPath = resolveLoadedFileHistoryPath({
      logItems,
      selectedHash,
      fallbackPath: historyPath,
    });

    const requestId = fileHistoryDiffSeqRef.current + 1;
    fileHistoryDiffSeqRef.current = requestId;
    let cancelled = false;

    void (async () => {
      if (loadedHistoryPath.fromLogItem) {
        if (cancelled || requestId !== fileHistoryDiffSeqRef.current) return;
        if (diff?.mode === "commit" && diff.hash === selectedHash && diff.path === loadedHistoryPath.path) return;
        await openDiffAsync(loadedHistoryPath.path, "commit", selectedHash);
        return;
      }

      let resolvedPath = historyPath;
      const resolved = await resolveFileHistoryPathAsync(repoRoot, {
        path: historyPath,
        hash: selectedHash,
        revision: String(activeLogFilters.revision || "").trim() || undefined,
      });
      if (!cancelled && requestId === fileHistoryDiffSeqRef.current && resolved.ok && resolved.data?.path) {
        resolvedPath = String(resolved.data.path || "").trim() || historyPath;
      }
      if (cancelled || requestId !== fileHistoryDiffSeqRef.current) return;
      if (diff?.mode === "commit" && diff.hash === selectedHash && diff.path === resolvedPath) return;
      await openDiffAsync(resolvedPath, "commit", selectedHash);
    })();

    return () => {
      cancelled = true;
    };
  }, [active, activeLogFilters.path, activeLogFilters.revision, diff?.hash, diff?.mode, diff?.path, isFileHistoryMode, logItems, openDiffAsync, repoRoot, selectedCommitHashes]);

  /**
   * 日志列表滚动接近底部时自动分页加载。
   */
  useEffect(() => {
    if (!active || !repoRoot || bottomTab !== "git" || bottomCollapsed) return;
    const el = logVirtual.containerRef.current;
    if (!el) return;

    const tryAutoLoad = () => {
      if (logLoading || !logHasMore || autoLoadLogLockRef.current) return;
      const remain = el.scrollHeight - (el.scrollTop + el.clientHeight);
      const viewportNotFilled = el.scrollHeight <= el.clientHeight + LOG_ROW_HEIGHT * 2;
      if (!viewportNotFilled && remain > LOG_ROW_HEIGHT * 6) return;
      autoLoadLogLockRef.current = true;
      void loadLogAsync(repoRoot, logCursor, false).finally(() => {
        autoLoadLogLockRef.current = false;
      });
    };

    el.addEventListener("scroll", tryAutoLoad, { passive: true });
    tryAutoLoad();
    return () => el.removeEventListener("scroll", tryAutoLoad);
  }, [active, bottomCollapsed, bottomTab, logCursor, logHasMore, logItems.length, logLoading, loadLogAsync, logVirtual.containerRef, repoRoot]);

  /**
   * 同步“提交记录”表头与列表的横向滚动，避免标题与内容错位/重叠。
   */
  useEffect(() => {
    if (!active || !repoRoot || bottomTab !== "git" || bottomCollapsed) return;
    const headerEl = logHeaderScrollRef.current;
    const bodyEl = logVirtual.containerRef.current;
    if (!headerEl || !bodyEl) return;

    const syncFromBody = () => {
      if (logScrollSyncLockRef.current) return;
      logScrollSyncLockRef.current = true;
      try { headerEl.scrollLeft = bodyEl.scrollLeft; } catch {}
      logScrollSyncLockRef.current = false;
    };

    const syncFromHeader = () => {
      if (logScrollSyncLockRef.current) return;
      logScrollSyncLockRef.current = true;
      try { bodyEl.scrollLeft = headerEl.scrollLeft; } catch {}
      logScrollSyncLockRef.current = false;
    };

    bodyEl.addEventListener("scroll", syncFromBody, { passive: true });
    headerEl.addEventListener("scroll", syncFromHeader, { passive: true });
    syncFromBody();
    return () => {
      bodyEl.removeEventListener("scroll", syncFromBody);
      headerEl.removeEventListener("scroll", syncFromHeader);
    };
  }, [active, bottomCollapsed, bottomTab, logVirtual.containerRef, repoRoot]);

  /**
   * 切换到“日志（控制台）”页签时只读取一次控制台内容，后续由实际 Git 操作完成后按需刷新。
   */
  useEffect(() => {
    if (!active || !repoRoot || bottomTab !== "log" || gitConsoleLiveUpdatesPaused) return;
    void loadGitConsoleAsync();
  }, [active, bottomTab, gitConsoleLiveUpdatesPaused, loadGitConsoleAsync, repoRoot]);

  /**
   * 控制台日志更新后自动滚动到底部，便于观察最新命令输出。
   */
  useEffect(() => {
    if (bottomTab !== "log" || gitConsoleLiveUpdatesPaused) return;
    const el = consoleListRef.current;
    if (!el) return;
    try {
      el.scrollTop = el.scrollHeight;
    } catch {}
  }, [bottomTab, gitConsoleItems.length, gitConsoleLiveUpdatesPaused]);

  /**
   * 提交选择变更后刷新详情。
   */
  useEffect(() => {
    if (!active || !repoRoot) return;
    void invokeRefreshDetailsAsync();
  }, [active, detailRequestHashesKey, invokeRefreshDetailsAsync, repoRoot]);

  /**
   * 提交选择变更后刷新日志菜单可用性，确保按钮启用状态与真实 Git 状态一致。
   */
  useEffect(() => {
    if (!active || !repoRoot) {
      logActionAvailabilitySeqRef.current += 1;
      setLogActionAvailability(null);
      setLogActionAvailabilityHashesKey("");
      setLogActionAvailabilityLoading(false);
      return;
    }
    void refreshLogActionAvailabilityAsync();
  }, [active, refreshLogActionAvailabilityAsync, repoRoot, status?.operationState]);

  /**
   * 提交树变化时，收敛无效选择并同步选中文件集合。
   */
  useEffect(() => {
    setSelectedCommitTreeKeys((prev) => {
      const restored = filterSelectableCommitRowKeys(
        restoreCommitTreeSelection(commitSelectionAnchors, commitRenderRowByKey, commitNodeByKey),
        commitRenderRowByKey,
        commitNodeByKey,
      );
      const nextSelection = restored.length > 0
        ? restored
        : (() => {
          const retained = filterSelectableCommitRowKeys(prev, commitRenderRowByKey, commitNodeByKey);
          if (retained.length > 0) return retained;
          return filterSelectableCommitRowKeys(
            resolveCommitFallbackRowSelection({
              groups: commitTreeGroups,
              inclusionState: commitInclusionState,
              activeChangeListId: String(status?.changeLists?.activeListId || "").trim(),
            }),
            commitRenderRowByKey,
            commitNodeByKey,
          );
        })();
      if (!isSameStringArray(prev, nextSelection))
        requestCommitSelectionVisibleRef.current = nextSelection.length > 0;
      return isSameStringArray(prev, nextSelection) ? prev : nextSelection;
    });
  }, [commitInclusionState, commitNodeByKey, commitRenderRowByKey, commitSelectionAnchors, commitTreeGroups, status?.changeLists?.activeListId]);

  /**
   * 根据提交树节点选择结果实时推导可执行动作的文件路径集合。
   */
  useEffect(() => {
    const next = resolveCommitSelectedChangePaths(selectedCommitTreeKeys, commitRenderRowByKey, commitNodeByKey);
    setSelectedPaths((prev) => (isSameStringArray(prev, next) ? prev : next));
    const nextExactlySelectedPaths = resolveCommitExactlySelectedChangePaths(selectedCommitTreeKeys, commitNodeByKey);
    setExactlySelectedPaths((prev) => (isSameStringArray(prev, nextExactlySelectedPaths) ? prev : nextExactlySelectedPaths));
  }, [commitNodeByKey, commitRenderRowByKey, selectedCommitTreeKeys]);

  /**
   * 刷新完成后恢复提交树滚动位置，避免仅恢复选择态导致视野被重置到顶部。
   */
  useEffect(() => {
    if (commitTreeBusy) return;
    const snapshot = pendingCommitTreeStateRef.current;
    if (!snapshot) return;
    const container = commitTreeContainerRef.current;
    if (container) {
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.min(snapshot.scrollTop, maxScrollTop);
    }
    pendingCommitTreeStateRef.current = null;
  }, [commitTreeBusy, commitTreeGroups]);

  /**
   * 确保当前主树选中行始终滚动到可视区域内，对齐 IDEA `selectNode/selectPath -> makeVisible()` 的语义。
   */
  useEffect(() => {
    if (commitTreeBusy) return;
    if (!requestCommitSelectionVisibleRef.current) return;
    const container = commitTreeContainerRef.current;
    const targetRowKey = selectedCommitTreeKeys[selectedCommitTreeKeys.length - 1] || "";
    if (!targetRowKey) {
      requestCommitSelectionVisibleRef.current = false;
      return;
    }
    const targetIndex = commitRenderRows.findIndex((row) => row.key === targetRowKey);
    if (!container || targetIndex < 0) return;
    const rowTop = targetIndex * COMMIT_TREE_ROW_HEIGHT;
    const rowBottom = rowTop + COMMIT_TREE_ROW_HEIGHT;
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    requestCommitSelectionVisibleRef.current = false;
    if (rowTop < viewportTop) {
      container.scrollTop = rowTop;
      return;
    }
    if (rowBottom > viewportBottom) {
      container.scrollTop = Math.max(0, rowBottom - container.clientHeight);
    }
  }, [commitRenderRows, commitTreeBusy, selectedCommitTreeKeys]);

  /**
   * reset-then-refresh 完成后清空临时空树态，确保 busy 期间不会闪出 empty，而刷新结束后能恢复真实树模型。
   */
  useEffect(() => {
    if (commitTreeBusy) return;
    if (!commitTreeResetPending) return;
    setCommitTreeResetPending(false);
  }, [commitTreeBusy, commitTreeResetPending]);

  /**
   * 提交树选中 diffable 节点时自动同步右侧 Diff，刷新后也尽量保持树选中与预览一致。
   */
  useEffect(() => {
    if (loading) return;
    if (commitTreeBusy) return;
    if (!selectedDiffableCommitPreviewEntry) return;
    if (!shouldAutoPreviewCommitSelection({
      activeSelectionScope,
      previewEnabled: resolveCommitOpenAction(viewOptions, "singleClick", true) === "diff",
      hasLoadedDiff: !!diff,
      diffPinned,
    })) return;
    const diffRequest = buildLeadCommitDiffRequest();
    if (!diffRequest) return;
    if (
      diff?.mode === diffRequest.mode
      && String(diff.path || "").replace(/\\/g, "/") === diffRequest.path
      && String((diff.selectionPaths || []).join("|")) === diffRequest.selectionPaths.join("|")
    ) return;
    void openDiffRequestAsync(diffRequest);
  }, [activeSelectionScope, buildLeadCommitDiffRequest, commitTreeBusy, diff, diff?.mode, diff?.path, diff?.selectionPaths, diffPinned, loading, openDiffRequestAsync, selectedDiffableCommitPreviewEntry, viewOptions]);

  /**
   * 详情树变化时收敛无效选择，避免悬挂旧节点。
   */
  useEffect(() => {
    if (!details) {
      setSelectedDetailNodeKeys((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    setSelectedDetailNodeKeys((prev) => {
      const next = prev.filter((one) => detailNodeByKey.has(one));
      return isSameStringArray(prev, next) ? prev : next;
    });
  }, [detailNodeByKey, details]);

  /**
   * 提交面板树节点变化时默认展开目录节点，并保留用户已调整的折叠状态。
   */
  useEffect(() => {
    if (isCommitTreeResetRequired(totalCommitTreeFileCount)) return;
    const selectedNodeSignature = Array.from(new Set(selectedCommitNodeKeys)).sort().join("\n");
    const shouldExpandSelectedNodeAncestors = selectedNodeSignature !== autoExpandedCommitSelectionSignatureRef.current;
    autoExpandedCommitSelectionSignatureRef.current = selectedNodeSignature;
    setCommitTreeExpanded((prev) => resolveCommitTreeExpandedState({
      groups: commitTreeGroups,
      previousExpanded: prev,
      selectedNodeKeys: selectedCommitNodeKeys,
      expandSelectedNodeAncestors: shouldExpandSelectedNodeAncestors,
    }));
  }, [commitTreeGroups, selectedCommitNodeKeys, totalCommitTreeFileCount]);

  /**
   * 提交分组变化时默认全部展开，并保留用户已调整状态。
   */
  useEffect(() => {
    setCommitGroupExpanded((prev) => resolveCommitGroupExpandedState({
      previousGroups: previousCommitChangeGroupsRef.current,
      nextGroups: commitTreeGroups,
      selectedNodeKeys: selectedCommitNodeKeys,
      previousExpanded: prev,
    }));
    previousCommitChangeGroupsRef.current = changeEntryGroups;
  }, [changeEntryGroups, commitTreeGroups, selectedCommitNodeKeys]);

  /**
   * 详情文件树变化时默认展开所有目录节点，并保留已有展开状态。
   */
  useEffect(() => {
    setDetailTreeExpanded((prev) => resolveAutoExpandedDirectoryState({
      nodes: detailFileTree,
      previousExpanded: prev,
    }));
  }, [detailFileTree]);

  /**
   * 分支比较文件树变化时默认展开所有目录节点，并保留已有展开状态。
   */
  useEffect(() => {
    setBranchCompareFilesTreeExpanded((prev) => resolveAutoExpandedDirectoryState({
      nodes: branchCompareFileTree,
      previousExpanded: prev,
    }));
  }, [branchCompareFileTree]);

  /**
   * 当 diff 变更时，默认定位到第一处差异，提升键盘导航体验。
   */
  useEffect(() => {
    if (!diff) {
      if (changedDiffLineIndexes.length > 0) setChangedDiffLineIndexes([]);
      if (diffActiveLine !== -1) setDiffActiveLine(-1);
    }
  }, [changedDiffLineIndexes.length, diff, diffActiveLine]);

  useEffect(() => {
    if (changedDiffLineIndexes.length === 0) {
      if (diffActiveLine !== -1) setDiffActiveLine(-1);
      return;
    }
    if (diffActiveLine >= 0 && changedDiffLineIndexes.includes(diffActiveLine)) return;
    setDiffActiveLine(changedDiffLineIndexes[0]);
  }, [changedDiffLineIndexes, diffActiveLine]);

  /**
   * 关闭 Diff 时同步退出全屏与固定态，避免保留空白预览或阻塞后续自动预览。
   */
  useEffect(() => {
    if (diff || (!diffFullscreen && !diffPinned)) return;
    setDiffFullscreen(false);
    setDiffPinned(false);
  }, [diff, diffFullscreen, diffPinned]);

  useEffect(() => {
    return () => {
      if (workingWriteTimerRef.current) clearTimeout(workingWriteTimerRef.current);
      workingWriteTimerRef.current = null;
      workingWritePayloadRef.current = null;
    };
  }, []);

  /**
   * 监听上半区容器尺寸，为左侧提交面板与提交输入区的自适应提供基准。
   */
  useLayoutEffect(() => {
    const element = upperLayoutRef.current;
    if (!element) return;

    const updateSize = (): void => {
      const nextWidth = Math.max(0, Math.round(element.clientWidth || 0));
      const nextHeight = Math.max(0, Math.round(element.clientHeight || 0));
      setUpperLayoutWidth((prev) => (prev === nextWidth ? prev : nextWidth));
      setUpperLayoutHeight((prev) => (prev === nextHeight ? prev : nextHeight));
    };

    updateSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }

    const observer = new ResizeObserver(() => updateSize());
    observer.observe(element);
    return () => {
      try { observer.disconnect(); } catch {}
    };
  }, [diffFullscreen, isRepo]);

  /**
   * 监听底部三列容器宽度，供分支树/日志/详情三栏按比例重算。
   */
  useLayoutEffect(() => {
    const element = bottomLayoutRef.current;
    if (!element) return;

    const updateWidth = (): void => {
      const nextWidth = Math.max(0, Math.round(element.clientWidth || 0));
      setBottomLayoutWidth((prev) => (prev === nextWidth ? prev : nextWidth));
    };

    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(element);
    return () => {
      try { observer.disconnect(); } catch {}
    };
  }, [bottomCollapsed, bottomTab, isRepo]);

  /**
   * 当上半区宽度变化时，仅对左侧提交面板执行安全夹紧；
   * 若窗口重新变宽，则优先恢复到用户上次设置的固定像素宽度。
   */
  useEffect(() => {
    if (leftCollapsed) {
      lastAutoResolvedUpperLayoutWidthRef.current = 0;
      return;
    }
    if (upperLayoutWidth <= 0) return;
    if (lastAutoResolvedUpperLayoutWidthRef.current === upperLayoutWidth) return;
    lastAutoResolvedUpperLayoutWidthRef.current = upperLayoutWidth;
    const preferredWidth = Math.max(220, leftExpandedWidthRef.current || leftPanelWidth || DEFAULT_LEFT_PANEL_WIDTH);
    const resolved = resolveMainPanelLayout(upperLayoutWidth, null, preferredWidth, SPLITTER_SIZE);
    if (Math.abs(resolved.width - leftPanelWidth) > 1) setLeftPanelWidth(resolved.width);
  }, [leftCollapsed, leftPanelWidth, upperLayoutWidth]);

  /**
   * 当底部容器宽度变化时，按比例重算左右栏宽度，把新增/减少的空间优先回馈给中间日志区。
   */
  useEffect(() => {
    if (bottomCollapsed) return;
    if (bottomTab !== "git") return;
    if (bottomLayoutWidth <= 0) return;
    const resolved = resolveBottomPanelLayout(
      bottomLayoutWidth,
      branchPanelProportion,
      detailPanelProportion,
      branchPanelWidth,
      detailPanelWidth,
      SPLITTER_SIZE,
    );
    if (Math.abs(resolved.branchWidth - branchPanelWidth) > 1) setBranchPanelWidth(resolved.branchWidth);
    if (Math.abs(resolved.detailWidth - detailPanelWidth) > 1) setDetailPanelWidth(resolved.detailWidth);
    if (branchPanelProportion == null || Math.abs(resolved.branchProportion - branchPanelProportion) > 0.001) {
      setBranchPanelProportion(resolved.branchProportion);
    }
    if (detailPanelProportion == null || Math.abs(resolved.detailProportion - detailPanelProportion) > 0.001) {
      setDetailPanelProportion(resolved.detailProportion);
    }
  }, [bottomCollapsed, bottomLayoutWidth, bottomTab]);

  useEffect(() => {
    saveWorkbenchLayout({
      leftPanelWidth,
      leftPanelProportion,
      branchPanelWidth,
      branchPanelProportion,
      detailPanelWidth,
      detailPanelProportion,
      bottomHeight,
      ignoreWhitespace,
      diffMode,
      collapseUnchanged,
      highlightWords,
    });
  }, [
    bottomHeight,
    branchPanelProportion,
    branchPanelWidth,
    collapseUnchanged,
    detailPanelProportion,
    detailPanelWidth,
    diffMode,
    highlightWords,
    ignoreWhitespace,
    leftPanelProportion,
    leftPanelWidth,
  ]);

  useEffect(() => {
    saveGitLogColumnLayout(logColumnLayout);
  }, [logColumnLayout]);

  /**
   * 全局快捷键（仅在 Git 标签页激活时生效）。
   */
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const target = event.target as HTMLElement | null;
      const tag = String(target?.tagName || "").toLowerCase();
      const isTextEditable = !!target && (target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select");
      if (ctrl && !event.altKey && !event.shiftKey && key === "a") {
        if (isTextEditable) return;
        let scope: "commit" | "detail" | null = activeSelectionScope;
        if (target && detailTreeContainerRef.current?.contains(target)) scope = "detail";
        else if (target && commitTreeContainerRef.current?.contains(target)) scope = "commit";
        if (!scope) {
          if (selectedDetailNodeKeys.length > 0) scope = "detail";
          else if (selectedCommitTreeKeys.length > 0) scope = "commit";
        }
        if (scope === "detail" && detailVisibleNodeKeys.length > 0) {
          event.preventDefault();
          setSelectedDetailNodeKeys(detailVisibleNodeKeys);
          return;
        }
        if (scope === "commit" && commitVisibleRowKeys.length > 0) {
          event.preventDefault();
          applyCommitNodeSelection(commitVisibleRowKeys);
        }
        return;
      }
      if (ctrl && event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        void runFlowActionAsync("push");
        return;
      }
      if (ctrl && event.altKey && !event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void runChangeMenuActionAsync("rollback");
        return;
      }
      if (ctrl && event.altKey && !event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void runBranchTreeActionAsync("new");
        return;
      }
      if (ctrl && event.altKey && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        const text = buildSelectedRevisionText();
        if (!text) return;
        void window.host.utils.copyText(text);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    active,
    activeSelectionScope,
    applyCommitNodeSelection,
    commitVisibleRowKeys,
    detailVisibleNodeKeys,
    runBranchTreeActionAsync,
    runChangeMenuActionAsync,
    runFlowActionAsync,
    buildSelectedRevisionText,
    selectedCommitHashes,
    selectedCommitTreeKeys.length,
    selectedDetailNodeKeys.length,
  ]);

  /**
   * 分支弹窗键盘导航（上下/回车/Esc）。
   */
  useEffect(() => {
    if (!branchPopupOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setBranchPopupOpen(false);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (branchSelectableIndexes.length === 0) return;
        const idx = branchSelectableIndexes.findIndex((x) => x === branchPopupIndex);
        const nextIdx = idx < 0 ? 0 : (idx + 1) % branchSelectableIndexes.length;
        setBranchPopupIndex(branchSelectableIndexes[nextIdx]);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (branchSelectableIndexes.length === 0) return;
        const idx = branchSelectableIndexes.findIndex((x) => x === branchPopupIndex);
        const nextIdx = idx <= 0 ? branchSelectableIndexes.length - 1 : idx - 1;
        setBranchPopupIndex(branchSelectableIndexes[nextIdx]);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const row = branchRows[branchPopupIndex];
        if (!row || row.kind === "group") return;
        void applyBranchPopupRowAsync(row);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyBranchPopupRowAsync, branchPopupIndex, branchPopupOpen, branchRows, branchSelectableIndexes]);

  /**
   * 当 Push 预览数据变化时，清理已失效的提交选择，避免右侧详情停留在旧状态。
   */
  useEffect(() => {
    if (!pushDialogOpen) return;
    const selected = String(pushSelectedCommitHash || "").trim();
    if (!selected) return;
    const exists = (pushPreview?.commits || []).some((one) => one.hash === selected);
    if (!exists) setPushSelectedCommitHash("");
  }, [pushDialogOpen, pushPreview?.commits, pushSelectedCommitHash]);

  /**
   * Push 对话框树形列表键盘导航（上下/左右/Home/End）。
   */
  useEffect(() => {
    if (!pushDialogOpen) return;
    const onKey = (event: KeyboardEvent) => {
      handlePushTreeKeyboardNavigation(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePushTreeKeyboardNavigation, pushDialogOpen]);

  /**
   * 处理日志列宽拖拽，行为对齐 IDEA 的可调列表头。
   */
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const draggingColumn = draggingLogColumnRef.current;
      if (!draggingColumn) return;
      event.preventDefault();
      const delta = event.clientX - draggingColumn.startX;
      const nextWidth = draggingColumn.startWidth + delta;
      setLogColumnLayout((prev) => resizeGitLogColumn(prev, draggingColumn.columnId, nextWidth));
    };
    const onUp = () => {
      draggingLogColumnRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  /**
   * 处理所有分栏拖拽（上方左右、下方左右、底部高度）。
   */
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const layoutDrag = draggingLayoutRef.current;
      if (layoutDrag) {
        if (layoutDrag.kind === "main") {
          const containerWidth = upperLayoutRef.current?.clientWidth || 0;
          if (containerWidth > 0) {
            const delta = event.clientX - layoutDrag.startX;
            const resolved = resolveMainPanelLayout(
              containerWidth,
              null,
              layoutDrag.startLeftPanelWidth + delta,
              SPLITTER_SIZE,
            );
            setLeftPanelWidth(resolved.width);
            leftExpandedWidthRef.current = resolved.width;
            setLeftPanelProportion(null);
            if (leftCollapsed && resolved.width > 60) setLeftCollapsed(false);
          }
          return;
        }

        if (layoutDrag.kind === "bottomLeft") {
          const containerWidth = bottomLayoutRef.current?.clientWidth || 0;
          if (containerWidth > 0) {
            const delta = event.clientX - layoutDrag.startX;
            const next = resolveBottomPanelLayout(
              containerWidth,
              null,
              null,
              layoutDrag.startBranchPanelWidth + delta,
              layoutDrag.startDetailPanelWidth,
              SPLITTER_SIZE,
            );
            setBranchPanelWidth(next.branchWidth);
            setBranchPanelProportion(next.branchProportion);
            if (Math.abs(next.detailWidth - detailPanelWidth) > 1) setDetailPanelWidth(next.detailWidth);
            if (detailPanelProportion == null || Math.abs(next.detailProportion - detailPanelProportion) > 0.001) {
              setDetailPanelProportion(next.detailProportion);
            }
          }
          return;
        }

        if (layoutDrag.kind === "bottomRight") {
          const containerWidth = bottomLayoutRef.current?.clientWidth || 0;
          if (containerWidth > 0) {
            const delta = event.clientX - layoutDrag.startX;
            const next = resolveBottomPanelLayout(
              containerWidth,
              null,
              null,
              layoutDrag.startBranchPanelWidth,
              layoutDrag.startDetailPanelWidth - delta,
              SPLITTER_SIZE,
            );
            setDetailPanelWidth(next.detailWidth);
            setDetailPanelProportion(next.detailProportion);
            if (Math.abs(next.branchWidth - branchPanelWidth) > 1) setBranchPanelWidth(next.branchWidth);
            if (branchPanelProportion == null || Math.abs(next.branchProportion - branchPanelProportion) > 0.001) {
              setBranchPanelProportion(next.branchProportion);
            }
          }
          return;
        }
      }

      if (!draggingBottomRef.current) return;
      const viewportHeight = window.innerHeight;
      const maxHeight = Math.max(COLLAPSED_BOTTOM_HEIGHT + 2, viewportHeight - 8);
      const next = Math.max(COLLAPSED_BOTTOM_HEIGHT, Math.min(maxHeight, viewportHeight - event.clientY));
      setBottomHeight(next);
      if (next > COLLAPSED_BOTTOM_HEIGHT + 4) setBottomCollapsed(false);
    };
    const onUp = () => {
      draggingBottomRef.current = false;
      draggingLayoutRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [branchPanelProportion, branchPanelWidth, detailPanelProportion, detailPanelWidth, leftCollapsed]);

  /**
   * 渲染 Git 仓库缺失时的空状态，提供初始化与重新检测入口。
   */
  const renderNoRepo = (): JSX.Element => {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="cf-git-empty-state w-[560px] max-w-full rounded-apple-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] p-6 text-sm text-[var(--cf-text-primary)]">
          <div className="mb-4 flex items-start gap-3">
            <div className="cf-git-empty-state-icon inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-apple-lg">
              <GitBranch className="h-6 w-6 text-[var(--cf-accent)]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-base font-apple-semibold">{gt("workbench.misc.noRepo.title", "未检测到 Git 仓库")}</div>
              <div className="text-xs leading-5 text-[var(--cf-text-secondary)]">
                {gt("workbench.misc.noRepo.description", "当前目录尚未初始化 Git。你可以在此目录执行 `git init`，或者点击下方按钮直接创建仓库。")}
              </div>
            </div>
          </div>
          <div className="cf-git-inline-card mb-4 flex items-center gap-2 rounded-apple-lg border border-[var(--cf-border)] px-3 py-2 text-xs text-[var(--cf-text-secondary)]">
            <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-muted)]" />
            <span className="truncate">{repoPath}</span>
          </div>
          <div className="flex items-center gap-2">
              <Button
                size="xs"
                onClick={async () => {
                  const res = await initRepoAsync(repoPath);
                  if (!res.ok) {
                    setError(getErrorText(res.error, "workbench.misc.noRepo.initFailed", "初始化仓库失败"));
                    return;
                  }
                  await refreshAllAsync({ keepLog: false });
                }}
              >
              {gt("workbench.misc.noRepo.init", "初始化仓库")}
              </Button>
              <Button size="xs" variant="secondary" onClick={() => void refreshAllAsync({ keepLog: false })}>
              {gt("workbench.misc.noRepo.redetect", "重新检测")}
              </Button>
          </div>
        </div>
      </div>
    );
  };

  /**
   * 渲染左侧提交 / 搁置面板，统一承载变更树、提交消息与 stash 列表。
   */
  const renderCommitPanel = (): JSX.Element => {
    return (
      <div className={GIT_PANEL_CLASS}>
        <div
          className={GIT_PANEL_HEADER_CLASS}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            event.stopPropagation();
            toggleLeftPanelCollapsed();
          }}
          title={gt("workbench.leftPanel.middleClickToggle", "鼠标中键：收起/展开左侧提交面板")}
        >
          <div className="shrink-0">
            <Tabs
              value={leftTab}
              onValueChange={(value) => setLeftTab(value === "shelve" ? "shelve" : "commit")}
            >
              <TabsList className="gap-0.5 p-0.5">
                <TabsTrigger value="commit" compact>
                  {gt("workbench.leftPanel.tabs.commit", "提交")}
                </TabsTrigger>
                <TabsTrigger value="shelve" compact>
                  {gt("workbench.leftPanel.tabs.shelve", "搁置")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {leftTab === "commit" ? (
            <div className="cf-git-toolbar-scroll no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap">
              <Button size="icon-sm" variant="ghost" onClick={() => void refreshAllAsync({ keepLog: false })} title={gt("workbench.common.refresh", "刷新")}>
                <RefreshCcw className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!toolbarState.rollback.enabled}
                onClick={() => void runChangeMenuActionAsync("rollback")}
                title={toolbarState.rollback.reason || gt("workbench.changes.toolbar.rollback", "回滚 Ctrl+Alt+Z")}
              >
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
            {commitSelectionContext.stagingAreaEnabled ? (
              <>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!commitSelectionContext.canStage}
                  onClick={() => void runChangeMenuActionAsync("stage")}
                  title={commitSelectionContext.canStage
                    ? gt("workbench.changes.actions.stageSelected", "暂存选中文件")
                    : gt("workbench.changes.actions.stageSelectedDisabled", "当前选择中没有可暂存文件")}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!commitSelectionContext.canUnstage}
                  onClick={() => void runChangeMenuActionAsync("unstage")}
                  title={commitSelectionContext.canUnstage
                    ? gt("workbench.changes.actions.unstageSelected", "从暂存区移除选中文件")
                    : gt("workbench.changes.actions.unstageSelectedDisabled", "当前选择中没有已暂存文件")}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!commitSelectionContext.canRevertUnstaged}
                  onClick={() => void runChangeMenuActionAsync("revertUnstaged")}
                  title={commitSelectionContext.canRevertUnstaged
                    ? gt("workbench.changes.actions.revertUnstaged", "还原未暂存更改")
                    : gt("workbench.changes.actions.revertUnstagedDisabled", "当前选择中没有可还原的未暂存更改")}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger>
                    <Button size="icon-sm" variant="ghost" title={gt("workbench.changes.toolbar.stageActions", "暂存区动作")}>
                      <GitCompare className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className={cn(TOOLBAR_MENU_PANEL_CLASS, "min-w-[186px]")}>
                    <DropdownMenuItem
                      className={cn(TOOLBAR_MENU_ITEM_CLASS, !commitSelectionContext.canStage ? "pointer-events-none opacity-50" : "")}
                      aria-disabled={!commitSelectionContext.canStage}
                      title={commitSelectionContext.canStage ? undefined : gt("workbench.changes.actions.stageSelectedDisabled", "当前选择中没有可暂存文件")}
                      onClick={commitSelectionContext.canStage ? () => void runChangeMenuActionAsync("stage") : undefined}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.stageSelected", "暂存选中文件")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={cn(TOOLBAR_MENU_ITEM_CLASS, !commitSelectionContext.canStageWithoutContent ? "pointer-events-none opacity-50" : "")}
                      aria-disabled={!commitSelectionContext.canStageWithoutContent}
                      title={commitSelectionContext.canStageWithoutContent ? undefined : gt("workbench.changes.actions.stageWithoutContentDisabled", "当前选择中没有可执行 intent-to-add 的未跟踪文件")}
                      onClick={commitSelectionContext.canStageWithoutContent ? () => void runChangeMenuActionAsync("stageWithoutContent") : undefined}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.stageWithoutContent", "暂存但不添加内容")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={cn(TOOLBAR_MENU_ITEM_CLASS, !globalStageActionAvailability.stageAll.enabled ? "pointer-events-none opacity-50" : "")}
                      aria-disabled={!globalStageActionAvailability.stageAll.enabled}
                      title={globalStageActionAvailability.stageAll.reason}
                      onClick={globalStageActionAvailability.stageAll.enabled ? () => void runChangeMenuActionAsync("stageAll") : undefined}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                      {globalStageActionAvailability.stageAll.label}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={cn(TOOLBAR_MENU_ITEM_CLASS, !globalStageActionAvailability.stageTracked.enabled ? "pointer-events-none opacity-50" : "")}
                      aria-disabled={!globalStageActionAvailability.stageTracked.enabled}
                      title={globalStageActionAvailability.stageTracked.reason}
                      onClick={globalStageActionAvailability.stageTracked.enabled ? () => void runChangeMenuActionAsync("stageTracked") : undefined}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                      {globalStageActionAvailability.stageTracked.label}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={cn(TOOLBAR_MENU_ITEM_CLASS, !commitSelectionContext.canUnstage ? "pointer-events-none opacity-50" : "")}
                      aria-disabled={!commitSelectionContext.canUnstage}
                      title={commitSelectionContext.canUnstage ? undefined : gt("workbench.changes.actions.unstageSelectedDisabled", "当前选择中没有已暂存文件")}
                      onClick={commitSelectionContext.canUnstage ? () => void runChangeMenuActionAsync("unstage") : undefined}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.unstage", "从暂存区移除")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={cn(TOOLBAR_MENU_ITEM_CLASS, !commitSelectionContext.canRevertUnstaged ? "pointer-events-none opacity-50" : "")}
                      aria-disabled={!commitSelectionContext.canRevertUnstaged}
                      title={commitSelectionContext.canRevertUnstaged ? undefined : gt("workbench.changes.actions.revertUnstagedDisabled", "当前选择中没有可还原的未暂存更改")}
                      onClick={commitSelectionContext.canRevertUnstaged ? () => void runChangeMenuActionAsync("revertUnstaged") : undefined}
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.revertUnstaged", "还原未暂存更改")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className={TOOLBAR_MENU_SEPARATOR_CLASS} />
                    <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void runChangeMenuActionAsync("showStaged")}>
                      <Eye className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.showStaged", "显示暂存版本")}
                    </DropdownMenuItem>
                    <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void runChangeMenuActionAsync("showLocal")}>
                      <Eye className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.showLocal", "显示工作区版本")}
                    </DropdownMenuItem>
                    <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void runChangeMenuActionAsync("compareLocalToStaged")}>
                      <GitCompare className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.compareLocalToStaged", "工作区 → 暂存区")}
                    </DropdownMenuItem>
                    <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void runChangeMenuActionAsync("compareStagedToLocal")}>
                      <GitCompare className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.compareStagedToLocal", "暂存区 → 工作区")}
                    </DropdownMenuItem>
                    <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void runChangeMenuActionAsync("compareStagedToHead")}>
                      <GitCompare className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.compareStagedToHead", "暂存区 ↔ HEAD")}
                    </DropdownMenuItem>
                    <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void runChangeMenuActionAsync("compareThreeVersions")}>
                      <GitCompare className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.compareThreeVersions", "比较三个版本")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className={TOOLBAR_MENU_SEPARATOR_CLASS} />
                    <DropdownMenuItem
                      className={cn(TOOLBAR_MENU_ITEM_CLASS, !commitSelectionContext.canStageStash ? "pointer-events-none opacity-50" : "")}
                      aria-disabled={!commitSelectionContext.canStageStash}
                      title={commitSelectionContext.canStageStash ? undefined : gt("workbench.changes.actions.stageStashDisabled", "当前选择不支持按路径写入 Stash")}
                      onClick={commitSelectionContext.canStageStash ? () => void runChangeMenuActionAsync("stageStash") : undefined}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.stageStash", "暂存选中文件到 Stash")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={cn(TOOLBAR_MENU_ITEM_CLASS, !canStashAllChangedRoots ? "pointer-events-none opacity-50" : "")}
                      aria-disabled={!canStashAllChangedRoots}
                      title={canStashAllChangedRoots ? undefined : gt("workbench.changes.actions.stashSilentlyDisabled", "当前仓库没有可写入 Stash 的改动")}
                      onClick={canStashAllChangedRoots ? () => void runChangeMenuActionAsync("stashSilently") : undefined}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {gt("workbench.changes.actions.stashSilently", "暂存全部改动到 Stash")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button size="icon-sm" variant="ghost" title={gt("workbench.changes.toolbar.viewOptions", "视图选项")}>
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={TOOLBAR_MENU_PANEL_CLASS}>
                <DropdownMenuLabel className={TOOLBAR_MENU_LABEL_CLASS}>{gt("workbench.changes.viewMenu.groupBy", "分组依据")}</DropdownMenuLabel>
                <DropdownMenuItem
                  className={cn(TOOLBAR_MENU_ITEM_CLASS, !availableCommitGroupingKeys.includes("repository") ? "cursor-not-allowed opacity-50 hover:bg-transparent" : "")}
                  aria-disabled={!availableCommitGroupingKeys.includes("repository")}
                  onClick={() => {
                    if (!availableCommitGroupingKeys.includes("repository")) return;
                    void applyCommitGroupingKeyAsync("repository");
                  }}
                >
                  <Check className={`mr-2 h-3.5 w-3.5 ${activeCommitGroupingKeys.includes("repository") ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                  {gt("workbench.changes.viewMenu.groupRepository", "仓库")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={cn(TOOLBAR_MENU_ITEM_CLASS, !availableCommitGroupingKeys.includes("module") ? "cursor-not-allowed opacity-50 hover:bg-transparent" : "")}
                  aria-disabled={!availableCommitGroupingKeys.includes("module")}
                  onClick={() => {
                    if (!availableCommitGroupingKeys.includes("module")) return;
                    void applyCommitGroupingKeyAsync("module");
                  }}
                >
                  <Check className={`mr-2 h-3.5 w-3.5 ${activeCommitGroupingKeys.includes("module") ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                  {gt("workbench.changes.viewMenu.groupModule", "模块")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={cn(TOOLBAR_MENU_ITEM_CLASS, !availableCommitGroupingKeys.includes("directory") ? "cursor-not-allowed opacity-50 hover:bg-transparent" : "")}
                  aria-disabled={!availableCommitGroupingKeys.includes("directory")}
                  onClick={() => {
                    if (!availableCommitGroupingKeys.includes("directory")) return;
                    void applyCommitGroupingKeyAsync("directory");
                  }}
                >
                  <Check className={`mr-2 h-3.5 w-3.5 ${activeCommitGroupingKeys.includes("directory") ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                  {gt("workbench.changes.viewMenu.groupDirectory", "目录")}
                </DropdownMenuItem>
                <DropdownMenuSeparator className={TOOLBAR_MENU_SEPARATOR_CLASS} />
                <DropdownMenuLabel className={TOOLBAR_MENU_LABEL_CLASS}>{gt("workbench.changes.viewMenu.display", "显示")}</DropdownMenuLabel>
                <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void applyChangesViewOptionAsync("showIgnored", !viewOptions.showIgnored)}>
                  <Check className={`mr-2 h-3.5 w-3.5 ${viewOptions.showIgnored ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                  {gt("workbench.changes.viewMenu.showIgnored", "已忽略的文件")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="icon-sm" variant="ghost" onClick={expandAllCommitTree} title={gt("workbench.changes.toolbar.expandAll", "展开全部")}>
              <ChevronsUpDown className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={collapseAllCommitTree} title={gt("workbench.changes.toolbar.collapseAll", "收起全部")}>
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button size="icon-sm" variant="ghost" title={gt("workbench.changes.toolbar.moreOptions", "更多选项")}>
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={cn(TOOLBAR_MENU_PANEL_CLASS, "min-w-[168px]")}>
                <ToolbarDropdownSubmenu label={gt("workbench.changes.moreMenu.configureLocalChanges", "配置本地更改")} panelClassName={cn(TOOLBAR_MENU_PANEL_CLASS, "min-w-[188px]")}>
                  <DropdownMenuLabel className={TOOLBAR_MENU_LABEL_CLASS}>{gt("workbench.changes.moreMenu.displayAs", "显示为")}</DropdownMenuLabel>
                  <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void applyLocalChangesOptionAsync("stagingAreaEnabled", true)}>
                    <Check className={`mr-2 h-3.5 w-3.5 ${localChangesConfig.stagingAreaEnabled ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                    {gt("workbench.changes.moreMenu.stagingArea", "暂存区域")}
                  </DropdownMenuItem>
                  <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void applyLocalChangesOptionAsync("changeListsEnabled", true)}>
                    <Check className={`mr-2 h-3.5 w-3.5 ${localChangesConfig.changeListsEnabled ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                    {gt("workbench.changes.moreMenu.changeLists", "变更列表")}
                  </DropdownMenuItem>
                  {localChangesConfig.stagingAreaEnabled ? (
                    <>
                      <DropdownMenuSeparator className={TOOLBAR_MENU_SEPARATOR_CLASS} />
                      <DropdownMenuLabel className={TOOLBAR_MENU_LABEL_CLASS}>{gt("workbench.changes.moreMenu.commit", "提交")}</DropdownMenuLabel>
                      <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void applyLocalChangesOptionAsync("commitAllEnabled", localChangesConfig.commitAllEnabled === false)}>
                        <Check className={`mr-2 h-3.5 w-3.5 ${localChangesConfig.commitAllEnabled !== false ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                        {gt("workbench.changes.moreMenu.commitAllWhenEmpty", "暂存区为空时全部提交")}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </ToolbarDropdownSubmenu>
                <DropdownMenuSeparator className={TOOLBAR_MENU_SEPARATOR_CLASS} />
                <ToolbarDropdownSubmenu label={gt("workbench.changes.moreMenu.doubleClickEnterOpen", "双击/回车打开")} panelClassName={cn(TOOLBAR_MENU_PANEL_CLASS, "min-w-[152px]")}>
                  <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void applyChangesViewOptionAsync("diffPreviewOnDoubleClickOrEnter", true)}>
                    <Check className={`mr-2 h-3.5 w-3.5 ${viewOptions.diffPreviewOnDoubleClickOrEnter ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                    {gt("workbench.changes.moreMenu.diffPreview", "差异预览")}
                  </DropdownMenuItem>
                  <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void applyChangesViewOptionAsync("diffPreviewOnDoubleClickOrEnter", false)}>
                    <Check className={`mr-2 h-3.5 w-3.5 ${!viewOptions.diffPreviewOnDoubleClickOrEnter ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                    {gt("workbench.changes.moreMenu.sourceFile", "源文件")}
                  </DropdownMenuItem>
                </ToolbarDropdownSubmenu>
                <DropdownMenuSeparator className={TOOLBAR_MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void applyChangesViewOptionAsync("detailsPreviewShown", !viewOptions.detailsPreviewShown)}>
                  <Check className={`mr-2 h-3.5 w-3.5 ${viewOptions.detailsPreviewShown ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                  {gt("workbench.changes.moreMenu.oneClickPreview", "一键显示差异预览")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </div>
          ) : null}
        </div>

        {leftTab === "commit" ? (
          <>
            <CommitTreePane
              groups={commitTreeResetPending ? [] : commitTreeGroups}
              inclusionState={commitInclusionState}
              statusEntryByPath={statusEntryByPath}
              statusEntriesByPath={statusEntriesByPath}
              selectedRowKeys={selectedCommitTreeKeys}
              selectedPaths={selectedPaths}
              groupExpanded={commitGroupExpanded}
              treeExpanded={commitTreeExpanded}
              localChangesConfig={localChangesConfig}
              activeChangeListId={String(status?.changeLists?.activeListId || "").trim()}
              selectedDiffableEntry={selectedLeadCommitEntry}
              ignoredLoading={ignoredLoading}
              busy={commitTreeBusy}
              containerRef={commitTreeContainerRef}
              onActivate={() => setActiveSelectionScope("commit")}
              onSelectRow={(rowKey, event) => {
                selectCommitTreeRow(rowKey, event);
              }}
              onApplyTreeSelection={applyCommitNodeSelection}
              onInvokeEntryAction={(entry, intent) => {
                void runCommitFileOpenActionAsync(entry, intent);
              }}
              onInvokeHoverAction={(node, action) => {
                if (action === "stage" || action === "unstage") {
                  const nodeEntries = resolveCommitTreeNodeEntries(node);
                  if (nodeEntries.length === 0) return;
                  void runCommitTreeStageOperationAsync(nodeEntries, action);
                  return;
                }
                if (!node.entry) return;
                if (action === "select-in") {
                  selectInCommitTreeByPath(node.entry.path, node.entry.changeListId);
                  return;
                }
                if (action === "open-source") {
                  void openSourceInIdeAsync(node.entry.path);
                  return;
                }
                if (action === "open-merge") {
                  void openConflictMergeDialogAsync(node.entry.path);
                  return;
                }
                if (action === "rollback-resolved") {
                  if (!repoRoot) return;
                  void (async () => {
                    const res = await rollbackFilesAsync(repoRoot, [node.entry!.path]);
                    if (!res.ok) {
                      setError(getErrorText(res.error, "workbench.misc.conflicts.rollbackResolvedFailed", "回滚已解决冲突失败"));
                      return;
                    }
                    await refreshAllAsync({ keepLog: false });
                  })();
                  return;
                }
                const diffRequest = buildCommitNodeDiffRequest(node);
                if (!diffRequest) return;
                void openDiffRequestAsync(diffRequest);
              }}
              onResolveConflictGroup={(group) => {
                openConflictResolverDialog({
                  title: gt("workbench.misc.conflicts.title", "Git 冲突"),
                  description: gt("workbench.misc.conflicts.dialogDescription", "统一查看当前仓库里的冲突文件，支持表格式合并/打开、目录分组，以及与提交面板共享的已解决冲突状态源。"),
                  focusPath: group.entries[0]?.path,
                });
              }}
              onBrowseGroup={(group) => {
                setSpecialFilesDialogState({
                  cacheKey: group.kind,
                  kind: group.kind === "ignored" ? "ignored" : group.kind === "conflict" ? "conflict" : "unversioned",
                  title: group.label,
                  description: gt("workbench.misc.changeListManyFilesDescription", "该节点包含 {{count}} 个文件，按 IDEA 的 many files 语义改为通过浏览对话框查看。", { count: group.entries.length }),
                  entries: group.entries,
                });
              }}
              onIgnorePaths={(paths, anchor) => {
                void openIgnoreTargetDialogAsync(paths, repoRoot, anchor);
              }}
              onPerformStageOperation={async (entries, action) => {
                await runCommitTreeStageOperationAsync(entries, action);
              }}
              onToggleGroupExpanded={(groupKey) => {
                setCommitGroupExpanded((prev) => ({ ...prev, [groupKey]: prev[groupKey] === false }));
              }}
              onToggleTreeExpanded={(nodeKey) => {
                setCommitTreeExpanded((prev) => ({ ...prev, [nodeKey]: prev[nodeKey] === false }));
              }}
              onToggleInclusion={(itemIds, included, repoRoots) => {
                setCommitInclusionState((prev) => setCommitInclusionForItemIds(prev, itemIds, included, repoRoots));
              }}
              onOpenContextMenu={(event, target, targetKind, changeListId) => {
                openContextMenu(event, "changes", target, targetKind, changeListId);
              }}
              onMoveFilesToChangeList={async (paths, targetListId) => {
                await moveFilesBetweenChangeListsAsync(paths, targetListId);
              }}
              resolveStatusToneClassName={(statusRaw) => GIT_TONE_CLASSNAME[resolveGitToneFromStatus(statusRaw)]}
            />
                <SpecialFilesDialog
                  open={!!specialFilesDialogState}
                  cacheKey={specialFilesDialogState?.cacheKey || "special-files"}
                  kind={specialFilesDialogState?.kind || "unversioned"}
                  title={specialFilesDialogState?.title || gt("workbench.specialFiles.browseTitle", "浏览文件")}
                  description={specialFilesDialogState?.description || ""}
              entries={specialFilesDialogState?.entries || []}
              viewOptions={viewOptions}
              initialGroupingKeys={activeCommitGroupingKeys}
              availableGroupingKeys={availableCommitGroupingKeys}
              onOpenChange={(open) => {
                if (!open) setSpecialFilesDialogState(null);
              }}
              onInvokeEntryAction={(entry, intent) => {
                if (specialFilesDialogState?.kind === "conflict") {
                  void openConflictMergeDialogAsync(entry.path);
                  return;
                }
                void runCommitFileOpenActionAsync(entry, intent);
              }}
              onStagePaths={async (paths) => {
                if (!repoRoot || paths.length === 0) return;
                const res = await stageFilesAsync(repoRoot, paths);
                if (!res.ok) {
                  setError(getErrorText(res.error, "workbench.changes.stageFailed", "暂存失败"));
                  return;
                }
                await refreshAllAsync({ keepLog: true });
              }}
              onDeletePaths={async (paths) => {
                if (!repoRoot || paths.length === 0) return;
                const res = await deleteFilesAsync(repoRoot, paths, paths);
                if (!res.ok) {
                  setError(getErrorText(res.error, "workbench.changes.deleteFailed", "删除失败"));
                  return;
                }
                await refreshAllAsync({ keepLog: true });
              }}
              onIgnoreEntries={(entries, anchor) => {
                void openIgnoreTargetDialogForEntriesAsync(entries, anchor);
              }}
            />
            <IgnoreTargetDialog
              open={!!ignoreTargetDialogState}
              paths={activeIgnoreTargetDialogRequest?.paths || []}
              targets={activeIgnoreTargetDialogRequest?.targets || []}
              repoRoot={activeIgnoreTargetDialogRequest?.repoRoot}
              repoIndex={(ignoreTargetDialogState?.activeIndex || 0) + 1}
              repoCount={ignoreTargetDialogState?.requests.length || 0}
              applyingTargetId={ignoreTargetDialogState?.applyingTargetId}
              anchor={ignoreTargetDialogState?.anchor}
              onOpenChange={(open) => {
                if (!open) setIgnoreTargetDialogState(null);
              }}
              onSelectTarget={(target) => {
                void applyIgnoreTargetAsync(target);
              }}
            />
            <ConflictMergeDialog
              open={!!conflictMergeDialogState}
              loading={conflictMergeDialogState?.loading === true}
              saving={conflictMergeDialogState?.saving === true}
              snapshot={conflictMergeDialogState?.snapshot || null}
              onOpenChange={(open) => {
                if (!open) closeConflictMergeDialog();
              }}
              onRefresh={() => {
                const pathText = String(conflictMergeDialogState?.relativePath || "").trim();
                if (!pathText) return;
                const scopeRepoRoot = repoRoot
                  ? resolveConflictResolverScopeKey(repoRoot, String(conflictMergeDialogState?.repoRoot || "").trim()) || undefined
                  : undefined;
                void openConflictMergeDialogAsync(pathText, {
                  reverse: conflictMergeDialogState?.reverse === true,
                  scopeRepoRoot,
                });
              }}
              onResolve={(resultText) => {
                void resolveConflictMergeAsync(resultText);
              }}
              onResolveWithSource={(source) => {
                void resolveConflictMergeWithSourceAsync(source);
              }}
              onOpenInIde={() => {
                const targetPath = String(conflictMergeDialogState?.relativePath || "").trim();
                const targetRepoRoot = String(conflictMergeDialogState?.repoRoot || "").trim();
                if (!targetPath || !targetRepoRoot) return;
                void openSourceInIdeAsync(targetPath, targetRepoRoot);
              }}
              onOpenInSystem={() => {
                const targetPath = String(conflictMergeDialogState?.relativePath || "").trim();
                const targetRepoRoot = String(conflictMergeDialogState?.repoRoot || "").trim();
                if (!targetPath || !targetRepoRoot) return;
                void openRepoPathInSystemAsync(targetPath, targetRepoRoot);
              }}
            />
            <div className={GIT_PANEL_FOOTER_CLASS}>
              <Input
                ref={commitMessageInputRef}
                multiline
                className="cf-git-editor-input text-xs leading-5"
                style={{ height: `${commitMessageEditorHeight}px` }}
                placeholder={gt("actionDialogs.editCommitMessage.messagePlaceholder", "请输入新的提交信息")}
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
              />
              {commitChecks.length > 0 ? (
                <div className="mt-1.5 flex flex-col gap-1">
                  {commitChecks.map((check) => (
                    <div
                      key={check.id}
                      className={cn(
                        "rounded-apple-sm border px-2 py-1 text-[11px]",
                        check.level === "error"
                          ? "border-[var(--cf-red)]/20 bg-[var(--cf-red-light)] text-[var(--cf-red)]"
                          : check.level === "warning"
                            ? "border-[var(--cf-yellow)]/20 bg-[var(--cf-yellow-light)] text-[var(--cf-warning-foreground)]"
                            : "border-[var(--cf-border)] bg-[var(--cf-surface-muted)] text-[var(--cf-text-secondary)]",
                      )}
                    >
                      <span>{check.message}</span>
                      {check.id === "author-missing" ? (
                        <button
                          className="ml-2 text-[var(--cf-accent)] underline-offset-2 hover:underline"
                          onClick={() => {
                            setCommitOptionsOpen(true);
                          }}
                        >
                          {gt("workbench.commitOptions.open", "打开提交选项")}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1 text-[11px] text-[var(--cf-text-secondary)]">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[var(--cf-accent)]"
                    checked={commitAmendEnabled}
                    disabled={!commitAmendEnabled && !commitAmendAvailable}
                    onChange={(event) => {
                      void handleCommitAmendToggleAsync(event.target.checked);
                    }}
                  />
                  {gt("commit.amendToggleLabel", "修改上一提交")}
                </label>
                {commitAmendEnabled ? (
                  <span
                    className="max-w-[240px] truncate text-[11px] text-[var(--cf-text-secondary)]"
                    title={commitAmendLoading
                      ? gt("commit.blocked.readingAmend", "正在读取上一提交详情")
                      : commitAmendDetails
                        ? `${commitAmendDetails.shortHash || commitAmendDetails.hash} · ${commitAmendDetails.subject}`
                        : gt("commit.amendNoDetails", "未读取到上一提交详情")}
                  >
                    {commitAmendLoading
                      ? gt("commit.amendLoading", "正在读取上一提交...")
                      : commitAmendDetails
                        ? `${commitAmendDetails.shortHash || commitAmendDetails.hash} · ${commitAmendDetails.subject}`
                        : gt("commit.amendNoDetails", "未读取到上一提交详情")}
                  </span>
                ) : null}
                <Button
                  ref={commitOptionsTriggerRef}
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    setCommitOptionsOpen((prev) => !prev);
                  }}
                >
                  <ChevronsUpDown className="mr-1 h-3 w-3" />
                  {gt("workbench.commitOptions.toggle", "提交选项")}
                  {commitAdvancedOptionsEnabled ? <Badge className="ml-1 rounded-full px-1.5 py-0 text-[10px]" variant="info">{commitAdvancedOptionsSummary.length}</Badge> : null}
                </Button>
                <div
                  className="min-w-[180px] flex-1 truncate text-[11px] text-[var(--cf-text-secondary)]"
                  title={commitAdvancedOptionsEnabled ? commitAdvancedOptionsSummary.join(" · ") : gt("workbench.commitOptions.empty", "未设置提交高级选项")}
                >
                  {commitAdvancedOptionsEnabled ? commitAdvancedOptionsSummary.join(" · ") : gt("workbench.commitOptions.empty", "未设置提交高级选项")}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <Button size="xs" disabled={commitActionDisabled} title={commitActionBlockedReason || undefined} onClick={() => void handleCommitAsync(commitPrimaryPushAfter)}>
                    {commitPrimaryActionLabel}
                  </Button>
                  <Button size="xs" variant="secondary" disabled={commitActionDisabled} title={commitActionBlockedReason || undefined} onClick={() => void handleCommitAsync(!commitPrimaryPushAfter)}>
                    {commitSecondaryActionLabel}
                  </Button>
                </div>
              </div>
              <CommitOptionsPopover
                open={commitOptionsOpen}
                anchorRef={commitOptionsTriggerRef}
                value={commitAdvancedOptionsState}
                commitHooks={commitHooksAvailability}
                commitRenamesSeparatelyDisabled={commitAmendEnabled}
                commitRenamesSeparatelyHint={commitAmendEnabled ? gt("commit.renamesSeparatelyHint", "修改上一提交时不支持将文件移动单独提交。") : undefined}
                onOpenChange={setCommitOptionsOpen}
                onChange={setCommitAdvancedOptionsState}
              />
            </div>
          </>
        ) : (
          <ShelfBrowserPane
            items={shelfItems}
            stashItems={stashItems}
            viewState={shelfViewState}
            refreshing={loading}
            onRefresh={() => {
              void refreshAllAsync({ keepLog: false });
            }}
            onImportPatch={() => {
              void handleImportShelfPatchFilesAsync();
            }}
            onViewStateChange={(patch) => {
              void updateShelfViewStateAsync(patch);
            }}
            onOpenShelfRestore={(shelf, selectedPaths) => {
              openShelfRestoreDialog(shelf, selectedPaths);
            }}
            onRenameShelf={(shelf) => {
              void runShelfManagementActionAsync(shelf, "rename");
            }}
            onRecycleShelf={(shelf) => {
              void runShelfManagementActionAsync(shelf, "recycle");
            }}
            onRestoreArchivedShelf={(shelf) => {
              void runShelfManagementActionAsync(shelf, "restoreArchived");
            }}
            onDeleteShelfPermanently={(shelf) => {
              void runShelfManagementActionAsync(shelf, "deleteForever");
            }}
            onRunDiffAction={(shelf, selectedPaths, action) => {
              void runShelfDiffActionAsync(shelf, selectedPaths, action);
            }}
            onCreatePatch={(shelf, selectedPaths, mode) => {
              void exportShelfPatchSelectionAsync(shelf, selectedPaths, mode);
            }}
            onStashAction={(stash, action) => {
              void handleStashEntryActionAsync(stash, action);
            }}
          />
        )}
      </div>
    );
  };

  /**
   * 渲染底部工具窗，承载分支树、日志、提交详情、控制台、Worktrees 与冲突面板。
   */
  const renderBottomPanel = (): JSX.Element => {
    const showGitLike = bottomTab === "git";
    const showLogConsole = bottomTab === "log";
    const showConflictsLike = bottomTab === "conflicts";
    const activeDetailHash = details?.mode === "single" ? details.detail.hash : (orderedSelectedCommitHashesNewestFirst[0] || "");
    const branchPanelSpeedSearchQuery = branchPanelSpeedSearch.trim();
    const branchPanelRepositories = branchPopup?.repositories || [];
    const selectedBranchRepositoryIndex = Math.max(0, branchPanelRepositories.findIndex((item) => item.repoRoot === selectedBranchRepository?.repoRoot));
    const detailSpeedSearchQuery = detailSpeedSearch.trim();
    const detailCountMap = details?.mode === "multiple"
      ? new Map(details.files.map((one) => [one.path, one.count]))
      : new Map<string, number>();
    const collapsedBottomLabel = bottomTab === "log"
      ? gt("workbench.misc.bottomTabs.log", "日志")
      : bottomTab === "worktrees"
        ? gt("workbench.misc.worktrees.title", "工作树")
        : bottomTab === "conflicts"
          ? gt("workbench.misc.conflicts.title", "冲突")
          : gt("workbench.misc.bottomTabs.git", "Git");
    return (
      <div
        className="cf-git-bottom-panel flex min-h-0 flex-col overflow-hidden border-t border-[var(--cf-border)] bg-[var(--cf-surface-solid)]"
        style={{ height: bottomCollapsed ? COLLAPSED_BOTTOM_HEIGHT : bottomHeight }}
      >
        <div
          className="cf-git-bottom-handle group h-[3px] cursor-row-resize border-b border-[var(--cf-border)] bg-[var(--cf-surface-muted)]"
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            draggingBottomRef.current = true;
          }}
          onDoubleClick={() => {
            setBottomCollapsed((v) => !v);
          }}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            event.stopPropagation();
            setBottomCollapsed((v) => !v);
          }}
          title={gt("workbench.misc.splitter.bottom", "拖拽调整高度；鼠标中键收起/展开")}
        >
          <div className="mx-auto h-[2px] w-20 rounded-full bg-[var(--cf-accent)] opacity-0 transition-opacity duration-apple group-hover:opacity-60" />
        </div>
        <div
          className={cn(
            "cf-git-pane-header flex items-center justify-between border-b border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple px-2",
            bottomCollapsed ? "h-6" : "min-h-[34px] py-1",
          )}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            event.stopPropagation();
            setBottomCollapsed((v) => !v);
          }}
          title={gt("workbench.misc.splitter.bottomPanel", "鼠标中键收起/展开底部面板")}
        >
          {bottomCollapsed ? (
            <div className="text-[11px] text-[var(--cf-text-secondary)]">{collapsedBottomLabel}</div>
          ) : (
            <Tabs
              value={bottomTab}
              onValueChange={(value) => {
                if (value === "log") {
                  setBottomTab("log");
                  return;
                }
                if (value === "worktrees") {
                  showWorktreesTabByUser();
                  return;
                }
                if (value === "conflicts") {
                  showConflictsPanelByUser();
                  return;
                }
                setBottomTab("git");
              }}
            >
              <TabsList className={GIT_BOTTOM_TABS_LIST_CLASS}>
                <TabsTrigger value="git" className={cn(GIT_BOTTOM_TABS_TRIGGER_CLASS, "min-w-[52px] pr-3")}>
                  {gt("workbench.misc.bottomTabs.git", "Git")}
                </TabsTrigger>
                <TabsTrigger value="log" className={cn(GIT_BOTTOM_TABS_TRIGGER_CLASS, "min-w-[52px] pr-3")}>
                  {gt("workbench.misc.bottomTabs.log", "Log")}
                </TabsTrigger>
                {worktreeTabVisible ? (
                  <div className="flex items-center gap-1">
                    {/* 当前产品设计要求 Git 面板底部页签区里的 Worktrees 页签常驻且不可关闭，因此这里不再暴露关闭按钮。
                        设计如此，此处在“底部页签显隐与关闭入口”范围内继续不对齐 IDEA。 */}
                    <TabsTrigger value="worktrees" className={cn(GIT_BOTTOM_TABS_TRIGGER_CLASS, "min-w-[92px] pr-2")}>
                      <span className="flex items-center gap-1">
                        <span>{gt("workbench.misc.worktrees.title", "工作树")}</span>
                        {showWorktreeNewBadge ? <Badge variant="secondary" className="px-1 py-0 text-[9px] leading-4">{gt("workbench.misc.worktrees.newBadge", "NEW")}</Badge> : null}
                      </span>
                    </TabsTrigger>
                  </div>
                ) : null}
                {conflictsPanelVisible ? (
                  <div className="flex items-center gap-1">
                    <TabsTrigger value="conflicts" className={cn(GIT_BOTTOM_TABS_TRIGGER_CLASS, "min-w-[76px] pr-2")}>
                      <span className="flex items-center gap-1">
                        <span>{gt("workbench.misc.conflicts.title", "冲突")}</span>
                        {conflictsPanelSnapshot.unresolvedCount > 0 ? (
                          <Badge variant="secondary" className="px-1 py-0 text-[9px] leading-4">
                            {conflictsPanelSnapshot.unresolvedCount}
                          </Badge>
                        ) : null}
                      </span>
                    </TabsTrigger>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="h-6 w-6"
                      title={gt("workbench.misc.conflicts.closeCurrentPanel", "关闭当前冲突面板")}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        closeConflictsPanelByUser();
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : null}
              </TabsList>
            </Tabs>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setBottomCollapsed((v) => !v)}
            title={bottomCollapsed ? gt("workbench.misc.splitter.expandBottomPanel", "展开底部面板") : gt("workbench.misc.splitter.collapseBottomPanel", "收起底部面板")}
          >
            {bottomCollapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {!bottomCollapsed ? (
          showGitLike ? (
            <div
              ref={bottomLayoutRef}
              className="grid min-h-0 flex-1"
              style={{ gridTemplateColumns: `${branchPanelWidth}px ${SPLITTER_SIZE}px minmax(0,1fr) ${SPLITTER_SIZE}px ${detailPanelWidth}px` }}
            >
              <div
                ref={branchPanelSpeedSearchRootRef}
                className="relative min-h-0 overflow-hidden"
              >
                {branchPanelSpeedSearchOpen ? (
                  <div
                    data-testid="branch-panel-speed-search"
                    className="absolute left-3 top-10 z-20 flex max-w-[calc(100%-24px)] items-center gap-1 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-2 py-1 text-xs shadow-apple-md"
                  >
                    <Search className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                    <input
                      ref={branchPanelSpeedSearchInputRef}
                      data-testid="branch-panel-speed-search-input"
                      type="text"
                      value={branchPanelSpeedSearch}
                      placeholder={gt("workbench.misc.branchPopup.search", "搜索分支/标签/远端")}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="min-w-[32px] flex-1 bg-transparent text-xs text-[var(--cf-text-primary)] outline-none placeholder:text-[var(--cf-text-secondary)]"
                      onChange={(event) => {
                        handleBranchPanelSpeedSearchInputChange(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "F3") {
                          event.preventDefault();
                          applyBranchPanelSpeedSearch(branchPanelSpeedSearchQuery, event.shiftKey ? "previous" : "next");
                          return;
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          resetBranchPanelSpeedSearch({ restoreFocus: true });
                          return;
                        }
                        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
                          event.preventDefault();
                          event.currentTarget.select();
                        }
                      }}
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (isFocusWithinBranchPanel(nextTarget)) return;
                        resetBranchPanelSpeedSearch();
                      }}
                    />
                  </div>
                ) : null}
                <div
                  ref={branchPanelContainerRef}
                  className="min-h-0 h-full overflow-auto cf-scroll-area outline-none"
                  tabIndex={0}
                  onBlur={(event) => {
                    const nextTarget = event.relatedTarget as Node | null;
                    if (isFocusWithinBranchPanel(nextTarget)) return;
                    resetBranchPanelSpeedSearch();
                  }}
                  onMouseDown={() => {
                    branchPanelContainerRef.current?.focus();
                  }}
                  onKeyDown={(event) => {
                    const ctrl = event.ctrlKey || event.metaKey;
                    if (ctrl && !event.altKey && event.key.toLowerCase() === "f") {
                      event.preventDefault();
                      setBranchPanelSpeedSearchOpen(true);
                      return;
                    }
                    if (branchPanelSpeedSearchOpen) {
                      if (event.key === "F3") {
                        event.preventDefault();
                        applyBranchPanelSpeedSearch(branchPanelSpeedSearchQuery, event.shiftKey ? "previous" : "next");
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        resetBranchPanelSpeedSearch();
                        return;
                      }
                      if (event.key === "Backspace") {
                        event.preventDefault();
                        const nextQuery = branchPanelSpeedSearch.slice(0, -1);
                        if (!nextQuery.trim()) {
                          resetBranchPanelSpeedSearch();
                          return;
                        }
                        setBranchPanelSpeedSearch(nextQuery);
                        applyBranchPanelSpeedSearch(nextQuery);
                        return;
                      }
                      if (!ctrl && !event.altKey && event.key.length === 1) {
                        event.preventDefault();
                        const nextQuery = `${branchPanelSpeedSearch}${event.key}`;
                        setBranchPanelSpeedSearch(nextQuery);
                        applyBranchPanelSpeedSearch(nextQuery);
                        return;
                      }
                    }
                    if (event.key === "Enter") {
                      const focusedRow = branchPanelRows.find((row) => row.kind === "branch" && row.key === branchPanelFocusedRowKey);
                      if (focusedRow?.kind === "branch") {
                        event.preventDefault();
                        applyLogBranchSelection({
                          branchName: focusedRow.name,
                          repoRoot: focusedRow.repoRoot,
                          hash: focusedRow.item?.hash,
                        });
                      }
                      return;
                    }
                    if (!ctrl && !event.altKey && !event.shiftKey && event.key.length === 1 && /[\w\-./\\\s]/.test(event.key)) {
                      event.preventDefault();
                      const nextQuery = `${branchPanelSpeedSearch}${event.key}`;
                      setBranchPanelSpeedSearchOpen(true);
                      setBranchPanelSpeedSearch(nextQuery);
                      applyBranchPanelSpeedSearch(nextQuery);
                    }
                  }}
                >
                  <div className={GIT_STICKY_HEADER_CLASS}>
                    <span>{gt("workbench.branches.panel.title", "分支")}</span>
                    {selectedBranchRepository ? (
                      <span className="max-w-[120px] truncate rounded-apple-sm bg-[var(--cf-surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--cf-text-secondary)]" title={selectedBranchRepository.repoRoot}>
                        {selectedBranchRepository.rootName}
                      </span>
                    ) : null}
                    <div className="ml-auto flex items-center gap-1">
                      {/* 当前产品设计把 Git 面板“分支”侧栏头部的低频控制统一收敛到一个下拉菜单，避免头部横向拥挤并减少多按钮并排造成的误触。
                          设计如此，此处在“分支侧栏头部操作入口”范围内继续不对齐 IDEA。 */}
                      <DropdownMenu>
                        <DropdownMenuTrigger>
                          <Button size="icon-sm" variant="ghost" title={gt("workbench.branches.panel.actionsTitle", "分支面板操作")}>
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className={cn(TOOLBAR_MENU_PANEL_CLASS, "min-w-[220px]")}>
                          <DropdownMenuLabel className={TOOLBAR_MENU_LABEL_CLASS}>{gt("workbench.branches.panel.menu.display", "显示")}</DropdownMenuLabel>
                          <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void setBranchSyncEnabledAsync(branchPopup?.syncEnabled === false)}>
                            <Check className={`mr-2 h-3.5 w-3.5 ${branchPopup?.syncEnabled !== false ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                            {gt("workbench.branches.panel.menu.incomingOutgoing", "传入/传出")}
                          </DropdownMenuItem>
                          <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void setBranchShowOnlyMyAsync(branchPopup?.showOnlyMy !== true)}>
                            <Check className={`mr-2 h-3.5 w-3.5 ${branchPopup?.showOnlyMy === true ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                            {gt("workbench.branches.panel.menu.myBranches", "我的分支")}
                          </DropdownMenuItem>
                          {branchPanelRepositories.length > 1 ? (
                            <>
                              <DropdownMenuSeparator className={TOOLBAR_MENU_SEPARATOR_CLASS} />
                              <DropdownMenuLabel className={TOOLBAR_MENU_LABEL_CLASS}>{gt("workbench.branches.panel.menu.repositories", "仓库")}</DropdownMenuLabel>
                              <DropdownMenuItem
                                className={TOOLBAR_MENU_ITEM_CLASS}
                                onClick={() => {
                                  const length = branchPanelRepositories.length;
                                  if (length <= 1) return;
                                  const nextIndex = (selectedBranchRepositoryIndex - 1 + length) % length;
                                  const nextRepoRoot = String(branchPanelRepositories[nextIndex]?.repoRoot || "").trim();
                                  if (nextRepoRoot) setBranchSelectedRepoRoot(nextRepoRoot);
                                }}
                              >
                                {gt("workbench.branches.panel.menu.previousRepository", "上一个仓库")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className={TOOLBAR_MENU_ITEM_CLASS}
                                onClick={() => {
                                  const length = branchPanelRepositories.length;
                                  if (length <= 1) return;
                                  const nextIndex = (selectedBranchRepositoryIndex + 1) % length;
                                  const nextRepoRoot = String(branchPanelRepositories[nextIndex]?.repoRoot || "").trim();
                                  if (nextRepoRoot) setBranchSelectedRepoRoot(nextRepoRoot);
                                }}
                              >
                                {gt("workbench.branches.panel.menu.nextRepository", "下一个仓库")}
                              </DropdownMenuItem>
                            </>
                          ) : null}
                          <DropdownMenuSeparator className={TOOLBAR_MENU_SEPARATOR_CLASS} />
                          <DropdownMenuLabel className={TOOLBAR_MENU_LABEL_CLASS}>{gt("workbench.branches.panel.menu.actions", "操作")}</DropdownMenuLabel>
                          <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => openBranchRemoteManagerDialog(selectedBranchRepository?.repoRoot)}>
                            {selectedBranchRemoteConfigs.length > 0
                              ? gt("workbench.branches.panel.menu.remoteConfigWithCount", "远端配置（{{count}}）", { count: selectedBranchRemoteConfigs.length })
                              : gt("workbench.branches.panel.menu.remoteConfig", "远端配置")}
                          </DropdownMenuItem>
                          <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => void runBranchTreeActionAsync("new", undefined, selectedBranchRepository?.repoRoot)}>
                            {gt("workbench.branches.panel.menu.newBranch", "新建分支")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  <div className="p-1 text-xs">
                    <div className="cf-git-inline-card mb-1 rounded-apple-sm px-2 py-1 text-[11px] text-[var(--cf-text-secondary)]">
                      <span className="mr-1">{gt("workbench.branches.panel.currentHead", "HEAD(当前分支)")}</span>
                      <span className="cf-git-inline-badge ml-1 font-medium text-[var(--cf-text-primary)]">{selectedBranchRepository?.currentBranch || repoBranch || "HEAD"}</span>
                    </div>
                    {branchPanelRows.map((row, index) => {
                      if (row.kind === "group") {
                        const expanded = row.key === "group:favorites"
                          ? branchGroupOpen.favorites
                          : row.key === "group:local"
                            ? branchGroupOpen.local
                            : branchGroupOpen.remote;
                        return (
                          <button
                            key={row.key}
                            className={cn("cf-git-section-toggle flex w-full items-center gap-0.5 px-1 py-0.5 text-left text-[11px]", index > 0 ? "mt-0.5" : "")}
                            onClick={() => {
                              setBranchGroupOpen((prev) => ({
                                ...prev,
                                favorites: row.key === "group:favorites" ? !prev.favorites : prev.favorites,
                                local: row.key === "group:local" ? !prev.local : prev.local,
                                remote: row.key === "group:remote" ? !prev.remote : prev.remote,
                              }));
                            }}
                          >
                            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} {row.label}
                          </button>
                        );
                      }
                      const isCurrentBranch = row.item?.current === true || (row.section !== "remote" && row.name === selectedBranchRepository?.currentBranch);
                      const isFilteredBranch = row.repoRoot === repoRoot && activeLogBranchValues.includes(row.name);
                      const isSpeedSearchFocused = !!branchPanelSpeedSearchQuery && branchPanelFocusedRowKey === row.key;
                      const presentation = branchPanelPresentationByKey.get(row.key) || buildBranchRowPresentation(row.item || { name: row.name }, gt);
                      return (
                        <div
                          key={row.key}
                          ref={(node) => {
                            if (node) branchPanelRowElementsRef.current[row.key] = node;
                            else delete branchPanelRowElementsRef.current[row.key];
                          }}
                          data-branch-panel-row-key={row.key}
                          className={cn(
                            "cf-git-list-row ml-3 flex min-h-[24px] cursor-default items-center justify-between gap-1.5 rounded-apple-sm px-1.5 py-0.5",
                            row.section === "remote" ? "text-[11px] text-[var(--cf-text-secondary)]" : "",
                            row.section === "local" && isCurrentBranch ? "cf-git-row-selected" : "",
                            row.section === "local" && isFilteredBranch ? "cf-git-row-filtered" : "",
                            row.section === "remote" && isFilteredBranch ? "cf-git-row-selected text-[var(--cf-text-primary)]" : "",
                            isSpeedSearchFocused ? "cf-git-row-selected text-[var(--cf-text-primary)]" : "",
                          )}
                          title={presentation.tooltip}
                          onMouseDown={() => {
                            setBranchPanelFocusedRowKey(row.key);
                            setBranchSelectedRepoRoot(row.repoRoot);
                            branchPanelContainerRef.current?.focus();
                          }}
                          onDoubleClick={() => {
                            applyLogBranchSelection({
                              branchName: row.name,
                              repoRoot: row.repoRoot,
                              hash: row.item?.hash,
                            });
                          }}
                          onContextMenu={(event) => {
                            setBranchSelectedRepoRoot(row.repoRoot);
                            openContextMenu(event, "branch", row.name);
                          }}
                        >
                          <span className="min-w-0 flex-1" title={row.name}>
                            <span className="block truncate text-[11px] leading-5">
                              {branchPanelSpeedSearchQuery ? renderGitSpeedSearchText(row.name, branchPanelSpeedSearchQuery) : row.name}
                            </span>
                          </span>
                          <div className="ml-1 flex shrink-0 items-center gap-1">
                            {row.item ? (
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                className={cn("h-5 w-5", row.item.favorite ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-secondary)]")}
                                title={row.item.favorite
                                  ? gt("workbench.branches.common.unfavorite", "取消收藏")
                                  : gt("workbench.branches.common.favorite", "收藏分支")}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void toggleBranchFavoriteAsync(row.item!, row.repoRoot, row.section);
                                }}
                              >
                                <Star className={cn("h-3.5 w-3.5", row.item.favorite ? "fill-current" : "")} />
                              </Button>
                            ) : null}
                            <BranchSyncBadges
                              incoming={presentation.incomingBadge}
                              outgoing={presentation.outgoingBadge}
                              compact
                            />
                            {row.section !== "remote" ? (
                              <>
                              {isFilteredBranch ? <span className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.accent)}>{gt("workbench.branches.common.filtered", "筛选")}</span> : null}
                              {isCurrentBranch ? <span className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.success)}>{gt("workbench.misc.headBadge", "HEAD")}</span> : null}
                              </>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div
                className={GIT_SPLITTER_CLASS + " cursor-col-resize"}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  draggingLayoutRef.current = {
                    kind: "bottomLeft",
                    startX: event.clientX,
                    startLeftPanelWidth: leftPanelWidth,
                    startBranchPanelWidth: branchPanelWidth,
                    startDetailPanelWidth: detailPanelWidth,
                  };
                }}
              >
                <div className="mx-auto h-full w-px bg-[var(--cf-border)] transition-all duration-apple group-hover:bg-[var(--cf-accent)] group-hover:opacity-60" />
              </div>

              <div className="flex min-h-0 flex-col overflow-hidden">
                <div className="cf-git-filterbar border-b border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple px-2 py-1">
                  {updateInfoLogState ? (
                    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-accent-light)] px-2 py-2 text-[11px]">
                      <span className="font-apple-medium text-[var(--cf-text-primary)]">{gt("workbench.misc.updateInfo.title", "Update Info")}</span>
                      <span className="max-w-[420px] truncate text-[var(--cf-text-secondary)]" title={updateInfoLogState.notification.title}>
                        {updateInfoLogState.notification.title}
                      </span>
                      {activeUpdateInfoRange ? (
                        <span
                          className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.info)}
                          title={`${activeUpdateInfoRange.rootName} · ${activeUpdateInfoRange.range.start}..${activeUpdateInfoRange.range.end}`}
                        >
                          {`${activeUpdateInfoRange.rootName} · ${activeUpdateInfoRange.range.start.slice(0, 8)}..${activeUpdateInfoRange.range.end.slice(0, 8)}`}
                        </span>
                      ) : null}
                      {updateInfoLogState.ranges.length > 1 ? (
                        <Select
                          value={activeUpdateInfoRange?.repoRoot || updateInfoLogState.selectedRepoRoot}
                          onValueChange={(value) => {
                            const nextRange = updateInfoLogState.ranges.find((range) => range.repoRoot === value);
                            if (!nextRange) return;
                            if (repoRoot && nextRange.repoRoot !== repoRoot) {
                              openUpdateNotificationRange(updateInfoLogState.notification, nextRange);
                              return;
                            }
                            setUpdateInfoLogState((prev) => prev ? selectUpdateInfoLogRange(prev, value) : prev);
                            setPendingLogSelectionHash(nextRange.range.end);
                          }}
                        >
                          <SelectTrigger className="cf-git-filter-input h-7 min-w-[160px] px-2 text-xs" title={gt("workbench.misc.updateInfo.range", "切换 Update Info 范围")}>
                            <SelectValue placeholder={gt("workbench.misc.updateInfo.rangePlaceholder", "范围")} />
                          </SelectTrigger>
                          <SelectContent fitContent maxContentWidth={420}>
                            {updateInfoLogState.ranges.map((range) => (
                              <SelectItem key={`update-info-range:${range.repoRoot}`} value={range.repoRoot}>
                                {`${range.rootName} · ${range.range.start.slice(0, 8)}..${range.range.end.slice(0, 8)}`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                      <Button
                        size="xs"
                        variant="outline"
                        className="max-w-[220px] justify-start px-2"
                          title={activeLogFilters.path || gt("workbench.misc.updateInfo.range", "切换 Update Info 范围")}
                          onClick={async () => {
                            const form = await openActionDialogAsync({
                              title: gt("workbench.misc.updateInfo.range", "切换 Update Info 范围"),
                              description: gt("workbench.misc.updateInfo.pathFilterDescription", "输入目录或文件路径（相对仓库根目录）"),
                              confirmText: gt("workbench.misc.updateInfo.apply", "应用"),
                              fields: [{ key: "path", label: gt("workbench.misc.updateInfo.pathLabel", "路径"), placeholder: gt("workbench.misc.updateInfo.pathPlaceholder", "src/components/...") }],
                              defaults: { path: activeLogFilters.path || "" },
                            });
                          if (!form) return;
                          setPendingLogSelectionHash("");
                          updateActiveLogFilters((prev) => ({
                            ...prev,
                            path: String(form.path || "").trim(),
                            followRenames: false,
                          }));
                        }}
                      >
                        <span className="truncate">{activeLogFilters.path ? gt("workbench.misc.updateInfo.pathValue", "路径：{{path}}", { path: activeLogFilters.path }) : gt("workbench.misc.updateInfo.pathLabel", "路径")}</span>
                      </Button>
                      <Button size="xs" variant="ghost" className="ml-auto px-2" onClick={closeUpdateInfoLogView}>
                        {gt("workbench.common.close", "关闭")}
                      </Button>
                    </div>
                  ) : null}
                  <div className="cf-git-toolbar-scroll flex items-center gap-1 overflow-x-auto whitespace-nowrap no-scrollbar">
                    <div className="relative min-w-[196px] flex-1">
                      <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                      <Input
                        className="cf-git-filter-input h-7 pl-7 text-xs"
                        placeholder={gt("workbench.misc.updateInfo.textPlaceholder", "文本或哈希")}
                        value={activeLogFilters.text}
                        disabled={updateInfoLogEnabled}
                        onChange={(e) => updateActiveLogFilters((prev) => ({ ...prev, text: e.target.value }))}
                      />
                    </div>
                    <Button
                      size="xs"
                      variant={activeLogFilters.matchMode === "regex" ? "secondary" : "outline"}
                      className="w-10 px-0 font-mono"
                      disabled={updateInfoLogEnabled}
                      onClick={() => updateActiveLogFilters((prev) => ({ ...prev, matchMode: prev.matchMode === "regex" ? "fuzzy" : "regex" }))}
                      title={gt("workbench.misc.updateInfo.regexMode", "匹配模式（Regex）")}
                    >
                      .*
                    </Button>
                    <Button
                      size="xs"
                      variant={activeLogFilters.caseSensitive ? "secondary" : "outline"}
                      className="w-10 px-0 font-apple-medium"
                      disabled={updateInfoLogEnabled}
                      onClick={() => updateActiveLogFilters((prev) => ({ ...prev, caseSensitive: !prev.caseSensitive }))}
                      title={gt("workbench.misc.updateInfo.caseSensitive", "大小写敏感")}
                    >
                      Aa
                    </Button>
                    <div className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
                    <GitLogMultiSelectFilterButton
                      label={gt("workbench.misc.updateInfo.branchFilter", "分支")}
                      values={activeLogBranchValues}
                      options={logBranchOptions}
                      disabled={updateInfoLogEnabled}
                      searchPlaceholder={gt("workbench.misc.updateInfo.branchSearchPlaceholder", "搜索分支")}
                      triggerClassName="cf-git-filter-input h-7"
                      onChange={(values) => {
                        setPendingLogSelectionHash("");
                        updateActiveLogFilters((prev) => ({
                          ...prev,
                          branchValues: values,
                          branch: values.length === 1 ? values[0] : "all",
                          revision: "",
                        }));
                      }}
                    />
                    <GitLogMultiSelectFilterButton
                      label={gt("workbench.misc.updateInfo.authorFilter", "用户")}
                      values={activeLogAuthorValues}
                      options={logAuthorOptions}
                      disabled={updateInfoLogEnabled}
                      searchPlaceholder={gt("workbench.misc.updateInfo.authorSearchPlaceholder", "搜索用户")}
                      triggerClassName="cf-git-filter-input h-7"
                      onChange={(values) => {
                        updateActiveLogFilters((prev) => ({
                          ...prev,
                          authorValues: values,
                          author: values.length === 1 ? values[0] : "",
                        }));
                      }}
                    />
                    <GitLogDateFilterButton
                      label={gt("workbench.misc.updateInfo.dateFilter", "日期")}
                      dateFrom={activeLogFilters.dateFrom}
                      dateTo={activeLogFilters.dateTo}
                      disabled={updateInfoLogEnabled}
                      triggerClassName="cf-git-filter-input h-7"
                      onSelectPreset={(value) => void applyDateFilterPresetAsync(value)}
                    />
                    <Button
                      size="xs"
                      variant="outline"
                      className="max-w-[156px] justify-start px-2"
                      title={activeLogFilters.path || gt("workbench.misc.updateInfo.pathLabel", "路径")}
                      onClick={async () => {
                        const form = await openActionDialogAsync({
                          title: gt("workbench.misc.updateInfo.pathFilterTitle", "路径筛选"),
                          description: gt("workbench.misc.updateInfo.pathFilterDescription", "输入目录或文件路径（相对仓库根目录）"),
                          confirmText: gt("workbench.misc.updateInfo.apply", "应用"),
                          fields: [{ key: "path", label: gt("workbench.misc.updateInfo.pathLabel", "路径"), placeholder: gt("workbench.misc.updateInfo.pathPlaceholder", "src/components/...") }],
                          defaults: { path: activeLogFilters.path || "" },
                        });
                        if (!form) return;
                        setPendingLogSelectionHash("");
                        updateActiveLogFilters((prev) => ({
                          ...prev,
                          path: String(form.path || "").trim(),
                          followRenames: false,
                        }));
                      }}
                    >
                      <span className="truncate">{activeLogFilters.path ? gt("workbench.misc.updateInfo.pathValue", "路径：{{path}}", { path: activeLogFilters.path }) : gt("workbench.misc.updateInfo.pathLabel", "路径")}</span>
                    </Button>
                    {!updateInfoLogEnabled && activeLogFilters.revision ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        className={cn("justify-start px-2", activeBranchCompareLabel ? "max-w-[220px]" : "max-w-[124px]")}
                        title={activeBranchCompareLabel
                          ? gt("workbench.log.compareSelectionActive", "比较 {{label}}；点击清除比较范围", { label: activeBranchCompareLabel })
                          : gt("workbench.log.fileHistoryActive", "文件历史截至 {{revision}}；点击清除修订锚点", { revision: activeLogFilters.revision })}
                        onClick={() => {
                          setPendingLogSelectionHash("");
                          setBranchCompareState(null);
                          setLogFilters((prev) => normalizeGitLogFilters({ ...prev, revision: "" }));
                        }}
                      >
                        <span className="truncate">{activeBranchCompareLabel ? gt("workbench.log.compareSelectionLabel", "比较 {{label}}", { label: activeBranchCompareLabel }) : gt("workbench.log.historyUntilLabel", "历史至 {{revision}}", { revision: activeLogFilters.revision.slice(0, 8) })}</span>
                      </Button>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger>
                        <Button
                          size="xs"
                          variant={logBranchesDashboard.visible ? "secondary" : "outline"}
                          className="px-2"
                          disabled={updateInfoLogEnabled}
                          title={gt("workbench.misc.updateInfo.dashboard", "日志分支 Dashboard 设置")}
                        >
                          <GitBranch className="mr-1 h-3.5 w-3.5" />
                          {gt("workbench.branches.panel.title", "分支")}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className={cn(TOOLBAR_MENU_PANEL_CLASS, "min-w-[188px]")}>
                        <DropdownMenuLabel className={TOOLBAR_MENU_LABEL_CLASS}>{gt("workbench.misc.updateInfo.show", "显示")}</DropdownMenuLabel>
                        <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => updateLogBranchesDashboardState({ visible: !logBranchesDashboard.visible })}>
                          <Check className={`mr-2 h-3.5 w-3.5 ${logBranchesDashboard.visible ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                          {logBranchesDashboard.visible ? gt("workbench.misc.updateInfo.hideBranchOverview", "隐藏分支概览") : gt("workbench.misc.updateInfo.showBranchOverview", "显示分支概览")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className={TOOLBAR_MENU_SEPARATOR_CLASS} />
                        <DropdownMenuLabel className={TOOLBAR_MENU_LABEL_CLASS}>{gt("workbench.misc.updateInfo.whenSelectingBranch", "选择分支时")}</DropdownMenuLabel>
                        <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => updateLogBranchesDashboardState({ selectionAction: "filter" })}>
                          <Check className={`mr-2 h-3.5 w-3.5 ${logBranchesDashboard.selectionAction === "filter" ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                          {gt("workbench.misc.updateInfo.selectionFilter", "更改日志筛选")}
                        </DropdownMenuItem>
                        <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => updateLogBranchesDashboardState({ selectionAction: "navigate" })}>
                          <Check className={`mr-2 h-3.5 w-3.5 ${logBranchesDashboard.selectionAction === "navigate" ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                          {gt("workbench.misc.updateInfo.navigateToBranch", "导航到分支")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className={TOOLBAR_MENU_SEPARATOR_CLASS} />
                        <DropdownMenuLabel className={TOOLBAR_MENU_LABEL_CLASS}>{gt("workbench.misc.updateInfo.grouping", "分组")}</DropdownMenuLabel>
                        <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => updateLogBranchesDashboardState({ grouping: "repository" })}>
                          <Check className={`mr-2 h-3.5 w-3.5 ${logBranchesDashboard.grouping === "repository" ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                          {gt("workbench.misc.updateInfo.groupByRepository", "按仓库分组")}
                        </DropdownMenuItem>
                        <DropdownMenuItem className={TOOLBAR_MENU_ITEM_CLASS} onClick={() => updateLogBranchesDashboardState({ grouping: "directory" })}>
                          <Check className={`mr-2 h-3.5 w-3.5 ${logBranchesDashboard.grouping === "directory" ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0"}`} />
                          {gt("workbench.misc.updateInfo.groupByDirectory", "按目录分组")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {logBranchesDashboard.visible && (logBranchesDashboard.selectedRepoRoot || logBranchesDashboard.currentBranch) ? (
                      <div className="ml-1 flex items-center gap-1 text-[10px] text-[var(--cf-text-secondary)]">
                        <span className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.info)}>
                          {logBranchesDashboard.selectionAction === "filter" ? gt("workbench.misc.updateInfo.selectionFilter", "选择即筛选") : gt("workbench.misc.updateInfo.selectionNavigate", "选择即导航")}
                        </span>
                        <span className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.muted)}>
                          {logBranchesDashboard.grouping === "directory" ? gt("workbench.misc.updateInfo.directoryGrouping", "目录分组") : gt("workbench.misc.updateInfo.repositoryGrouping", "仓库分组")}
                        </span>
                        {logBranchesDashboard.multiRoot && logDashboardRepositoryName ? (
                          <span
                            className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.info)}
                            title={logBranchesDashboard.selectedRepoRoot}
                          >
                            {logDashboardRepositoryName}
                          </span>
                        ) : null}
                        {logBranchesDashboard.currentBranch ? (
                          <span className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.muted)}>
                            {logBranchesDashboard.currentBranch}
                          </span>
                        ) : null}
                        {logBranchesDashboard.groups.map((group) => (
                          <span
                            key={`log-branch-dashboard-group:${group.key}`}
                            className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.muted)}
                            title={group.repositories.map((repository) => repository.repoRoot).join("\n")}
                          >
                            {logBranchesDashboard.grouping === "directory"
                              ? `${group.label}${group.repositories.length > 1 ? ` · ${group.repositories.length}` : ""}`
                              : group.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={updateInfoLogEnabled}
                      title={gt("workbench.misc.updateInfo.clearFilters", "清空筛选")}
                      onClick={() => {
                        setPendingLogSelectionHash("");
                        setLogFilters((prev) => normalizeGitLogFilters({
                          ...DEFAULT_LOG_FILTERS,
                          text: prev.text,
                          caseSensitive: prev.caseSensitive,
                          matchMode: prev.matchMode,
                        }));
                      }}
                    >
                      <FilterX className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div ref={logHeaderScrollRef} className="cf-git-log-header border-b border-[var(--cf-border)] overflow-x-auto overflow-y-hidden no-scrollbar">
                  <div className="flex min-w-full items-stretch">
                    <div className="flex min-w-0 flex-1 items-center gap-1 px-1 py-[2px] text-[10px] font-apple-medium uppercase tracking-[0.04em] text-[var(--cf-text-secondary)]">
                      {logColumnLayout.order.map((columnId) => {
                        const definition = GIT_LOG_COLUMN_DEFINITIONS.find((one) => one.id === columnId) || GIT_LOG_COLUMN_DEFINITIONS[0];
                        return (
                          <div
                            key={`log-column-header:${columnId}`}
                            draggable
                            className="group relative min-w-0 overflow-hidden select-none truncate"
                            style={logColumnStyleMap.get(columnId)}
                            onDragStart={(event) => {
                              draggingLogColumnIdRef.current = columnId;
                              try {
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", columnId);
                              } catch {}
                            }}
                            onDragOver={(event) => {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const sourceId = draggingLogColumnIdRef.current;
                              draggingLogColumnIdRef.current = null;
                              if (!sourceId || sourceId === columnId) return;
                              setLogColumnLayout((prev) => moveGitLogColumn(prev, sourceId, columnId));
                            }}
                            onDragEnd={() => {
                              draggingLogColumnIdRef.current = null;
                            }}
                          >
                            <div className="block truncate pr-1.5">{definition.label}</div>
                            <button
                              className="absolute -right-1 top-0 h-full w-2 cursor-col-resize opacity-0 transition-opacity group-hover:opacity-100"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                draggingLogColumnRef.current = {
                                  columnId,
                                  startX: event.clientX,
                                  startWidth: logColumnResolvedWidthMap.get(columnId) || definition.defaultWidth,
                                };
                              }}
                              title={gt("workbench.misc.updateInfo.resizeColumn", "拖拽调整“{{label}}”列宽", { label: definition.label })}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div
                  ref={logVirtual.containerRef}
                  className="min-h-0 flex-1 overflow-auto cf-scroll-area"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const rowEl = (event.target as HTMLElement | null)?.closest?.("[data-log-hash]") as HTMLElement | null;
                    const rowHash = String(rowEl?.getAttribute("data-log-hash") || "").trim();
                    const hash = rowHash || selectedCommitHashes[0] || "";
                    if (!hash) return;
                    if (!selectedCommitHashes.includes(hash)) setSelectedCommitHashes([hash]);
                    openContextMenu(event, "log", hash);
                  }}
                >
                  <div style={{ height: logVirtual.totalHeight }}>
                    <div style={{ height: logVirtual.windowState.top }} />
                    {logItems.slice(logVirtual.windowState.start, logVirtual.windowState.end).map((item, localIndex) => {
                      const index = logVirtual.windowState.start + localIndex;
                      const selected = selectedCommitHashes.includes(item.hash);
                      const laneCell = laneCells[index];
                      const rowStyle = buildGitLogRowStyle({
                        selected,
                        currentBranch: repoBranch,
                        branchFilter: activeLogFilters.branch,
                        containedInCurrentBranch: item.containedInCurrentBranch,
                      });
                      return (
                        <div
                          key={item.hash}
                          data-log-hash={item.hash}
                          className={cn(
                            "cf-git-log-row flex cursor-default items-stretch text-xs",
                            ...rowStyle.classNames,
                          )}
                          style={{ height: LOG_ROW_HEIGHT }}
                          onClick={(e) => selectCommitHash(item.hash, e)}
                          onDoubleClick={() => {
                            const targetPath = details && details.mode === "single" ? details.detail.files[0]?.path : "";
                            if (targetPath) void openDiffAsync(targetPath, "commit", item.hash);
                          }}
                          onContextMenu={(e) => {
                            if (!selectedCommitHashes.includes(item.hash)) setSelectedCommitHashes([item.hash]);
                            openContextMenu(e, "log", item.hash);
                          }}
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-1 border-b border-[var(--cf-border)] px-1 py-px">
                            {logColumnLayout.order.map((columnId) => (
                              <div
                                key={`${item.hash}:${columnId}`}
                                className={cn("min-w-0", columnId === "subject" ? "overflow-visible" : "overflow-hidden")}
                                style={logColumnStyleMap.get(columnId)}
                              >
                                {renderLogColumnContent(item, columnId, {
                                  graphCell: laneCell,
                                  graphSelected: rowStyle.graphSelected,
                                  graphColumnWidth: logVisiblePack.graphColumnWidth,
                                })}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ height: logVirtual.windowState.bottom }} />
                  </div>
                </div>
                {logLoading ? (
                  <div className="border-t border-[var(--cf-border)] px-2 py-1 text-center text-[11px] text-[var(--cf-text-secondary)]">
                    <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                    {gt("workbench.misc.updateInfo.loadingCommits", "正在加载提交...")}
                  </div>
                ) : null}
              </div>

              <div
                className={GIT_SPLITTER_CLASS + " cursor-col-resize"}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  draggingLayoutRef.current = {
                    kind: "bottomRight",
                    startX: event.clientX,
                    startLeftPanelWidth: leftPanelWidth,
                    startBranchPanelWidth: branchPanelWidth,
                    startDetailPanelWidth: detailPanelWidth,
                  };
                }}
              >
                <div className="mx-auto h-full w-px bg-[var(--cf-border)] transition-all duration-apple group-hover:bg-[var(--cf-accent)] group-hover:opacity-60" />
              </div>

              <GitDetailsBrowser
                details={details}
                detailFilesFlat={detailFilesFlat}
                detailFileRows={detailFileRows}
                detailCountMap={detailCountMap}
                selectedDetailNodeKeys={selectedDetailNodeKeys}
                selectedDetailPaths={selectedDetailPaths}
                selectedDetailPrimaryPath={selectedDetailPrimaryPath}
                detailTreeExpanded={detailTreeExpanded}
                detailSpeedSearch={detailSpeedSearch}
                detailSpeedSearchOpen={detailSpeedSearchOpen}
                activeDetailHash={activeDetailHash}
                showParentChanges={showParentChanges}
                detailActionAvailability={detailActionAvailability}
                detailLineStatsSummary={detailLineStatsSummary}
                orderedSelectedCommitHashesNewestFirst={orderedSelectedCommitHashesNewestFirst}
                orderedSelectedCommitHashesOldestFirst={orderedSelectedCommitHashesOldestFirst}
                speedSearchRootRef={detailTreeSpeedSearchRootRef}
                containerRef={detailTreeContainerRef}
                renderSpeedSearchText={renderGitSpeedSearchText}
                resolveDetailPathCommitHashes={resolveDetailPathCommitHashes}
                toCommitFileStatusText={toCommitFileStatusText}
                toLocalDateText={toLocalDateText}
                resolveStatusToneClassName={(status) => GIT_TONE_CLASSNAME[resolveGitToneFromStatus(String(status || ""))]}
                onExpandAll={expandAllDetailTree}
                onCollapseAll={collapseAllDetailTree}
                onFocus={() => setActiveSelectionScope("detail")}
                onBlur={(event) => {
                  const nextTarget = event.relatedTarget as Node | null;
                  const root = detailTreeSpeedSearchRootRef.current;
                  if (root && nextTarget && root.contains(nextTarget)) return;
                  resetDetailSpeedSearch();
                }}
                onKeyDown={(event) => {
                  const ctrl = event.ctrlKey || event.metaKey;
                  if (ctrl && !event.altKey && event.key.toLowerCase() === "f") {
                    event.preventDefault();
                    setDetailSpeedSearchOpen(true);
                    return;
                  }
                  if (detailSpeedSearchOpen) {
                    if (event.key === "F3") {
                      event.preventDefault();
                      applyDetailSpeedSearch(detailSpeedSearchQuery, event.shiftKey ? "previous" : "next");
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      resetDetailSpeedSearch();
                      return;
                    }
                    if (event.key === "Backspace") {
                      event.preventDefault();
                      const nextQuery = detailSpeedSearch.slice(0, -1);
                      if (!nextQuery.trim()) {
                        resetDetailSpeedSearch();
                        return;
                      }
                      setDetailSpeedSearch(nextQuery);
                      applyDetailSpeedSearch(nextQuery);
                      return;
                    }
                    if (!ctrl && !event.altKey && event.key.length === 1) {
                      event.preventDefault();
                      const nextQuery = `${detailSpeedSearch}${event.key}`;
                      setDetailSpeedSearch(nextQuery);
                      applyDetailSpeedSearch(nextQuery);
                      return;
                    }
                  }
                  if (!ctrl && !event.altKey && !event.shiftKey && event.key.length === 1 && /[\w\-./\\\s]/.test(event.key)) {
                    event.preventDefault();
                    const nextQuery = `${detailSpeedSearch}${event.key}`;
                    setDetailSpeedSearchOpen(true);
                    setDetailSpeedSearch(nextQuery);
                    applyDetailSpeedSearch(nextQuery);
                  }
                }}
                onMouseDown={() => setActiveSelectionScope("detail")}
                onSpeedSearchChange={handleDetailSpeedSearchInputChange}
                onMoveSpeedSearchMatch={(direction) => {
                  applyDetailSpeedSearch(detailSpeedSearchQuery, direction);
                }}
                onResetSpeedSearch={resetDetailSpeedSearch}
                onSelectNode={selectDetailNode}
                onToggleExpanded={(nodeKey) => {
                  setDetailTreeExpanded((prev) => ({ ...prev, [nodeKey]: !(prev[nodeKey] !== false) }));
                }}
                onEnsureSelected={(nodeKey) => {
                  setActiveSelectionScope("detail");
                  if (!selectedDetailNodeKeys.includes(nodeKey)) setSelectedDetailNodeKeys([nodeKey]);
                }}
                onOpenDiff={(path, hash, hashes) => {
                  void openDiffAsync(path, "commit", hash, hashes);
                }}
                onRunAction={(action, targetPath, targetHash, targetPaths, targetHashes) => {
                  void runDetailMenuActionAsync(action, targetPath, targetHash, targetPaths, targetHashes);
                }}
                onRefresh={() => {
                  void refreshAllAsync({ keepLog: true });
                }}
                onToggleShowParentChanges={() => {
                  setShowParentChanges((prev) => !prev);
                }}
              />
            </div>
          ) : (
            showLogConsole ? (
              <div className="flex min-h-0 flex-1 flex-col p-2 text-xs">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium">{gt("workbench.misc.console.title", "Git 控制台")}</span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => setGitConsoleLiveUpdatesPaused((prev) => !prev)}
                      title={gitConsoleLiveUpdatesPaused ? gt("workbench.misc.console.resumeAutoRefresh", "恢复自动刷新") : gt("workbench.misc.console.pauseAutoRefresh", "暂停自动刷新")}
                    >
                      {gitConsoleLiveUpdatesPaused ? <Play className="mr-1 h-3.5 w-3.5" /> : <Pause className="mr-1 h-3.5 w-3.5" />}
                      {gitConsoleLiveUpdatesPaused ? gt("workbench.misc.console.resumeAutoRefresh", "恢复") : gt("workbench.misc.console.pauseAutoRefresh", "暂停")}
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => void copyGitConsoleAsync()}
                      disabled={gitConsoleItems.length === 0}
                      title={gt("workbench.misc.console.copyCurrentLog", "复制当前控制台日志")}
                    >
                      <Copy className="mr-1 h-3.5 w-3.5" />
                      {gt("workbench.misc.console.copy", "复制")}
                    </Button>
                    <Button size="xs" variant="secondary" onClick={() => void loadGitConsoleAsync()} disabled={gitConsoleLoading}>
                      {gitConsoleLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                      {gt("workbench.misc.console.refresh", "刷新")}
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={async () => {
                        if (!repoRoot) return;
                        const res = await clearGitConsoleAsync(repoRoot);
                        if (!res.ok) {
                          setError(getErrorText(res.error, "workbench.console.clearFailed", "清空控制台失败"));
                          return;
                        }
                        setGitConsoleItems([]);
                      }}
                    >
                      {gt("workbench.misc.console.clear", "清空")}
                    </Button>
                  </div>
                </div>
                {gitConsoleLiveUpdatesPaused ? (
                  <div className="mb-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-2 text-[11px] text-[var(--cf-text-secondary)]">
                    {gt("workbench.misc.console.pausedNotice", "Git 控制台已暂停自动刷新。可先复制日志，再点击“恢复”继续跟踪实时输出。")}
                  </div>
                ) : null}
                {focusedUpdateSessionEntry ? (
                  <div className="mb-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-2 text-[11px]">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--cf-text-primary)]">
                          {gt("workbench.misc.console.focusedTitle", "已聚焦 Update Session #{{requestId}}", { requestId: focusedUpdateSessionEntry.requestId })}
                        </div>
                        <div className="truncate text-[var(--cf-text-secondary)]">
                          {focusedUpdateSessionEntry.lifecycle === "running"
                              ? focusedUpdateSessionEntry.viewState?.activeRootName
                                ? `${focusedUpdateSessionEntry.viewState.activeRootName} · ${focusedUpdateSessionEntry.viewState.activePhaseLabel}`
                                : (focusedUpdateSessionEntry.message || gt("workbench.misc.console.focusedRunning", "正在执行更新"))
                            : (focusedUpdateSessionEntry.resultView?.title || focusedUpdateSessionEntry.message || gt("workbench.misc.console.focusedCompleted", "更新已完成"))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {focusedUpdateSessionEntry.lifecycle === "finished" && focusedUpdateSessionEntry.resultView?.rangeText ? (
                          <Badge variant="secondary" className="text-[10px]">
                            {focusedUpdateSessionEntry.resultView.rangeText}
                          </Badge>
                        ) : null}
                        <Button size="xs" variant="secondary" onClick={clearFocusedUpdateSession}>
                          {gt("workbench.misc.console.cancelFocus", "取消聚焦")}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
                <div ref={consoleListRef} className="cf-git-console min-h-0 flex-1 overflow-auto cf-scroll-area rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] p-2 font-mono text-[11px] leading-5">
                  {gitConsoleItems.length === 0 ? <div className="cf-git-empty-panel text-[var(--cf-text-secondary)]">{gt("workbench.misc.console.empty", "暂无日志，执行 Git 操作后会显示命令与输出。")}</div> : null}
                  {gitConsoleItems.map((entry) => (
                    <div key={entry.id} className="cf-git-console-entry mb-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] p-2">
                      <div className="mb-1 flex items-center gap-2 text-[10px]">
                        <span className={cn(
                          "cf-git-ref-pill",
                          entry.running
                            ? GIT_TONE_CLASSNAME.info
                            : entry.ok
                              ? GIT_TONE_CLASSNAME.success
                              : GIT_TONE_CLASSNAME.danger,
                        )}>
                          {entry.running ? "RUN" : entry.ok ? "OK" : "FAIL"}
                        </span>
                        <span className="text-[var(--cf-text-secondary)]">{toConsoleTimeText(entry.timestamp)}</span>
                        <span className="text-[var(--cf-text-secondary)]">{entry.durationMs}ms</span>
                        <span className="truncate text-[var(--cf-text-secondary)]">{entry.cwd}</span>
                      </div>
                      <div className="whitespace-pre-wrap break-all text-[11px] text-[var(--cf-accent)]">$ {entry.command}</div>
                      {entry.stdout ? <div className="mt-1 whitespace-pre-wrap break-all text-[10px] text-[var(--cf-text-primary)]">{entry.stdout}</div> : null}
                      {entry.stderr ? <div className="mt-1 whitespace-pre-wrap break-all text-[10px] text-[var(--cf-red)]">{entry.stderr}</div> : null}
                      {entry.error ? <div className="mt-1 whitespace-pre-wrap break-all text-[10px] text-[var(--cf-red)]">{entry.error}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : showConflictsLike ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2 text-xs">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{gt("workbench.misc.conflicts.title", "Git 冲突")}</span>
                      <Badge variant="secondary" className="text-[10px]">
                        {gt("workbench.misc.conflicts.unresolved", "未解决 {{count}}", { count: conflictsPanelSnapshot.unresolvedCount })}
                      </Badge>
                      {conflictsPanelSnapshot.resolvedCount > 0 ? (
                        <Badge variant="outline" className="text-[10px]">
                          {gt("workbench.misc.conflicts.resolved", "已解决 {{count}}", { count: conflictsPanelSnapshot.resolvedCount })}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">
                      {gt("workbench.misc.conflicts.strategyDescription", "基于当前 status 链路自动显隐；新的冲突集会重新出现，用户也可在此直接进入统一 resolver。")}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => {
                        openConflictResolverDialog({
                          title: gt("workbench.misc.conflicts.title", "Git 冲突"),
                          description: gt("workbench.misc.conflicts.openUnifiedDescription", "独立冲突面板与统一 resolver 共享同一组冲突状态源。"),
                        });
                      }}
                    >
                      {gt("workbench.misc.conflicts.openUnifiedResolver", "统一处理")}
                    </Button>
                    <Button size="xs" variant="secondary" onClick={() => void refreshAllAsync({ keepLog: true })}>
                      {gt("workbench.common.refresh", "刷新")}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={disableConflictsPanelGate}>
                      {gt("workbench.misc.conflicts.disableAutoPanel", "停用自动面板")}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={closeConflictsPanelByUser}>
                      {gt("workbench.common.close", "关闭")}
                    </Button>
                  </div>
                </div>
                {conflictsPanelSnapshot.hasAny ? (
                  <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
                    <div className="min-h-0 overflow-auto cf-scroll-area rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)]">
                      <div className="border-b border-[var(--cf-border)] px-3 py-2 text-[11px] font-medium text-[var(--cf-text-secondary)]">
                        {gt("workbench.misc.conflicts.conflictFiles", "冲突文件")}
                      </div>
                      {[{
                        label: gt("workbench.misc.conflicts.unresolvedSection", "未解决冲突"),
                        entries: unresolvedConflictEntries,
                        tone: GIT_TONE_CLASSNAME.danger,
                      }, {
                        label: gt("workbench.misc.conflicts.resolvedSection", "已解决冲突"),
                        entries: resolvedConflictEntries,
                        tone: GIT_TONE_CLASSNAME.success,
                      }].map((section) => (
                        <div key={`conflicts-panel:${section.label}`}>
                          {section.entries.length > 0 ? (
                            <div className="border-b border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-3 py-2 text-[11px] font-medium text-[var(--cf-text-secondary)]">
                              {section.label} · {section.entries.length}
                            </div>
                          ) : null}
                          {section.entries.map((entry) => {
                            const scopeRepoRoot = repoRoot
                              ? resolveConflictResolverScopeKey(repoRoot, String(entry.repositoryRoot || "").trim()) || undefined
                              : undefined;
                            const canOpenMerge = entry.conflictState === "conflict";
                            return (
                              <div
                                key={`conflicts-panel-row:${entry.repositoryRoot || repoRoot}:${entry.path}:${entry.conflictState || "normal"}`}
                                className="flex items-center gap-3 border-b border-[var(--cf-border)] px-3 py-2"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[12px] font-medium text-[var(--cf-text-primary)]" title={entry.path}>
                                    {entry.path}
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--cf-text-secondary)]">
                                    <span className={cn("cf-git-ref-pill", section.tone)}>
                                      {entry.conflictState === "resolved" ? gt("workbench.misc.conflicts.resolvedSection", "已解决") : gt("workbench.misc.conflicts.unresolvedSection", "冲突")}
                                    </span>
                                    {entry.repositoryRoot && entry.repositoryRoot !== repoRoot ? (
                                      <span className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.muted)} title={entry.repositoryRoot}>
                                        {entry.repositoryName || entry.repositoryRoot}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                  <Button
                                    size="xs"
                                    variant="secondary"
                                    onClick={() => {
                                      openConflictResolverDialog({
                                        title: gt("workbench.misc.conflicts.title", "Git 冲突"),
                                        description: gt("workbench.misc.conflicts.openUnifiedDescription", "独立冲突面板与统一 resolver 共享同一组冲突状态源。"),
                                        focusPath: entry.path,
                                        scopeRepoRoot,
                                        reverseMerge: status?.operationState === "rebasing",
                                      });
                                    }}
                                  >
                                    {gt("workbench.misc.conflicts.openUnifiedResolver", "Resolver")}
                                  </Button>
                                  {canOpenMerge ? (
                                    <Button
                                      size="xs"
                                      variant="secondary"
                                      onClick={() => {
                                        void openConflictMergeDialogAsync(entry.path, {
                                          reverse: status?.operationState === "rebasing",
                                          scopeRepoRoot,
                                        });
                                      }}
                                    >
                                      {gt("workbench.misc.conflicts.merge", "合并…")}
                                    </Button>
                                  ) : null}
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => {
                                      void openSourceInIdeAsync(entry.path, scopeRepoRoot ? resolveScopedRepoRoot(repoRoot, scopeRepoRoot) : undefined);
                                    }}
                                  >
                                      {gt("workbench.misc.conflicts.open", "打开")}
                                    </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    <div className="flex min-h-0 flex-col gap-3">
                      <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-3 text-[11px] leading-5 text-[var(--cf-text-secondary)]">
                        <div className="mb-2 font-medium text-[var(--cf-text-primary)]">{gt("workbench.misc.conflicts.currentStrategy", "当前策略")}</div>
                        <div>{gt("workbench.misc.conflicts.strategyDescription", "冲突面板由 status 刷新链驱动，覆盖 staging area changes 与仓库映射变化后的自动显隐。")}</div>
                        <div className="mt-2">{gt("workbench.misc.conflicts.openUnifiedDescription", "若关闭当前面板，仅会抑制当前这组冲突；出现新的冲突文件集合时会再次自动显示。")}</div>
                      </div>
                      <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-3 text-[11px] leading-5 text-[var(--cf-text-secondary)]">
                        <div className="mb-2 font-medium text-[var(--cf-text-primary)]">{gt("workbench.misc.conflicts.shortcutActions", "快捷操作")}</div>
                        <Button
                          size="sm"
                          className="mb-2 w-full justify-center"
                          onClick={() => {
                            openConflictResolverDialog({
                              title: gt("workbench.misc.conflicts.title", "Git 冲突"),
                              description: gt("workbench.misc.conflicts.openUnifiedDescription", "独立冲突面板与统一 resolver 共享同一组冲突状态源。"),
                            });
                          }}
                        >
                          {gt("workbench.misc.conflicts.openUnifiedResolver", "打开统一 Resolver")}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="w-full justify-center"
                          onClick={() => {
                            activateCommitWorkflow();
                          }}
                        >
                          {gt("workbench.misc.conflicts.backToCommitPanel", "回到提交面板")}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="cf-git-empty-panel text-[var(--cf-text-secondary)]">
                    {gt("workbench.misc.conflicts.empty", "当前没有需要处理的冲突文件。")}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2 text-xs">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium">{gt("workbench.misc.worktrees.title", "工作树")}</span>
                  <Button
                    size="xs"
                    onClick={async () => {
                      await createWorktreeFromRefAsync();
                    }}
                  >
                    {gt("workbench.misc.worktrees.new", "新增工作树")}
                  </Button>
                </div>
                {displayWorktreeItems.length === 0 ? (
                  <div className="cf-git-empty-panel flex flex-col items-start gap-2 text-[var(--cf-text-secondary)]">
                    <div>{gt("workbench.misc.worktrees.empty", "暂无额外工作树。创建后会显示在这里，并支持关闭记忆与 NEW 标识收口。")}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="xs" variant="secondary" onClick={async () => { await createWorktreeFromRefAsync(); }}>
                        {gt("workbench.misc.worktrees.createNow", "立即创建")}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={async () => {
                          const res = await window.host.utils.openExternalUrl("https://git-scm.com/docs/git-worktree");
                          if (!res?.ok) setError(getErrorText(res?.error, "workbench.misc.worktrees.helpOpenFailed", "打开工作树帮助失败"));
                        }}
                      >
                        {gt("workbench.misc.worktrees.help", "了解 Git 工作树")}
                      </Button>
                    </div>
                  </div>
                ) : null}
                <div className="cf-git-worktree-panel min-h-0 flex-1 overflow-auto cf-scroll-area rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)]">
                  {worktreeTreeRows.map((row) => {
                    const item = row.item;
                    const isLeaf = row.kind === "item";
                    const canOpenInApp = !!item?.path && row.kind !== "group";
                    const canRemove = !!item?.path && !row.isMainWorktree && !row.isCurrentWorktree;
                    return (
                      <div
                        key={row.key}
                        className={cn(
                          "cf-git-worktree-row flex min-h-[26px] items-center gap-1 border-b border-[var(--cf-border)] px-1.5",
                          isLeaf ? "cf-git-list-row" : "cf-git-group-row",
                        )}
                        style={{ paddingLeft: 6 + row.depth * 12 }}
                      >
                        {row.canExpand ? (
                          <button
                            className="rounded-apple-sm p-[1px] hover:bg-[var(--cf-surface-hover)]"
                            onClick={() => toggleWorktreeTreeExpanded(row.key)}
                            title={row.expanded ? gt("workbench.details.context.collapse", "折叠") : gt("workbench.details.context.expand", "展开")}
                          >
                            {row.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        ) : (
                          <span className="inline-block h-3.5 w-3.5"></span>
                        )}
                        {row.kind === "group" ? <Folder className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" /> : <GitBranch className="h-3.5 w-3.5 text-[var(--cf-accent)] opacity-90" />}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-medium" title={row.label}>{row.label}</div>
                          {row.secondary ? <div className="truncate text-[10px] text-[var(--cf-text-secondary)]" title={row.secondary}>{row.secondary}</div> : null}
                        </div>
                        {canOpenInApp ? (
                          <Button
                            size="xs"
                            variant="secondary"
                            className="h-[22px] px-1.5 text-[11px]"
                            onClick={async () => {
                              if (!item?.path) return;
                              await openProjectAtPathAsync(item.path);
                            }}
                          >
                            {gt("workbench.misc.worktrees.openProject", "打开项目")}
                          </Button>
                        ) : null}
                        {isLeaf && canRemove ? (
                          <Button
                            size="xs"
                            variant="secondary"
                            className="h-[22px] px-1.5 text-[11px]"
                            onClick={async () => {
                              if (!item?.path) return;
                              const form = await openActionDialogAsync({
                                title: gt("actionDialogs.removeWorktree.title", "移除工作树"),
                                description: gt("actionDialogs.removeWorktree.description", "将移除：{{path}}", { path: item.path }),
                                confirmText: gt("actionDialogs.removeWorktree.confirm", "移除"),
                                fields: [{
                                  key: "force",
                                  label: gt("actionDialogs.removeWorktree.strategyLabel", "移除策略"),
                                  type: "select",
                                  options: [
                                    { value: "safe", label: gt("actionDialogs.removeWorktree.safeLabel", "普通移除") },
                                    { value: "force", label: gt("actionDialogs.removeWorktree.forceLabel", "强制移除") },
                                  ],
                                  required: true,
                                }],
                                defaults: { force: "safe" },
                              });
                              if (!form) return;
                              const force = form.force === "force";
                              markWorktreeCapabilityUsed();
                              const res = await removeWorktreeAsync(repoRoot, { path: item.path, force });
                              if (!res.ok) setError(getErrorText(res.error, "actionDialogs.removeWorktree.failed", "移除工作树失败"));
                              else await refreshAllAsync({ keepLog: true });
                            }}
                          >
                            {gt("actionDialogs.removeWorktree.confirm", "移除")}
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )
          )
        ) : null}
      </div>
    );
  };

  /**
   * 按当前 Diff 文件同步 partial commit 选区，并把“是否仍有任何纳入内容”回写到 inclusion model。
   */
  const syncDiffPartialHunkSelection = useCallback((updater: (prev: PartialCommitSelectionState, pathText: string) => PartialCommitSelectionState): void => {
    const pathText = String(diff?.path || "").trim().replace(/\\/g, "/");
    if (!pathText) return;
    const diffRepoRoot = normalizeCommitRepoRoot(selectedLeadCommitEntry?.repositoryRoot || repoRoot);
    const diffEntry = statusEntryByScopedPath.get(buildCommitInclusionLookupKey(pathText, diffRepoRoot)) || statusEntryByPath.get(pathText);
    const inclusionItemId = diffEntry ? buildCommitInclusionItemId(diffEntry) : "";
    let nextSelectedCount = 0;
    setPartialCommitSelectionState((prev) => {
      const next = updater(prev, pathText);
      nextSelectedCount = countSelectedPartialCommitLines(getPartialCommitSelectionEntry(next, pathText, diffRepoRoot));
      return next;
    });
    if (inclusionItemId) {
      setCommitInclusionState((prev) => setCommitInclusionForItemIds(prev, [inclusionItemId], nextSelectedCount > 0));
    }
  }, [diff?.path, repoRoot, selectedLeadCommitEntry?.repositoryRoot, statusEntryByPath, statusEntryByScopedPath]);

  /**
   * 按 Diff 内单个复选框切换某一行是否参与提交，并把焦点落到对应变更行。
   */
  const toggleDiffPartialSingleLineSelection = useCallback((hunkId: string, lineKey: string, selected: boolean, lineNumber?: number): void => {
    if (!String(hunkId || "").trim() || !String(lineKey || "").trim()) return;
    syncDiffPartialHunkSelection((prev, pathText) => (
      setPartialCommitLineKeysSelected(prev, pathText, { [hunkId]: [lineKey] }, selected, normalizeCommitRepoRoot(selectedLeadCommitEntry?.repositoryRoot || repoRoot))
    ));
    if (typeof lineNumber === "number" && Number.isFinite(lineNumber)) {
      setDiffActiveLine(Math.max(0, Math.floor(lineNumber) - 1));
    }
  }, [repoRoot, selectedLeadCommitEntry?.repositoryRoot, syncDiffPartialHunkSelection]);

  /**
   * 按 Diff 内当前差异块命中的行集批量切换纳入状态，供中缝箭头与块级复选框复用。
   */
  const toggleDiffPartialLineGroupSelection = useCallback((lineKeysByHunkId: Record<string, string[]>, selected: boolean, lineNumber?: number): void => {
    if (Object.keys(lineKeysByHunkId).length === 0) return;
    syncDiffPartialHunkSelection((prev, pathText) => (
      setPartialCommitLineKeysSelected(prev, pathText, lineKeysByHunkId, selected, normalizeCommitRepoRoot(selectedLeadCommitEntry?.repositoryRoot || repoRoot))
    ));
    if (typeof lineNumber === "number" && Number.isFinite(lineNumber)) {
      setDiffActiveLine(Math.max(0, Math.floor(lineNumber) - 1));
    }
  }, [repoRoot, selectedLeadCommitEntry?.repositoryRoot, syncDiffPartialHunkSelection]);

  /**
   * 按当前 Diff 选中的 changed line 批量纳入或排除提交，并尽量把焦点移动到首个命中行。
   */
  const toggleDiffPartialLineSelection = useCallback((selected: boolean): void => {
    if (diffAffectedLineSelection.affectedLineCount === 0) return;
    syncDiffPartialHunkSelection((prev, pathText) => (
      setPartialCommitLineKeysSelected(prev, pathText, diffAffectedLineSelection.affectedLineKeysByHunkId, selected, normalizeCommitRepoRoot(selectedLeadCommitEntry?.repositoryRoot || repoRoot))
    ));
    if (typeof diffAffectedLineSelection.focusLine === "number" && Number.isFinite(diffAffectedLineSelection.focusLine)) {
      setDiffActiveLine(Math.max(0, Math.floor(diffAffectedLineSelection.focusLine) - 1));
    }
  }, [diffAffectedLineSelection, repoRoot, selectedLeadCommitEntry?.repositoryRoot, syncDiffPartialHunkSelection]);

  /**
   * 批量切换当前 Diff 文件的全部 hunk 选区。
   */
  const setAllDiffPartialHunksSelected = useCallback((selected: boolean): void => {
    syncDiffPartialHunkSelection((prev, pathText) => setAllPartialCommitHunksSelected(prev, pathText, selected, normalizeCommitRepoRoot(selectedLeadCommitEntry?.repositoryRoot || repoRoot)));
  }, [repoRoot, selectedLeadCommitEntry?.repositoryRoot, syncDiffPartialHunkSelection]);

  /**
   * 清除当前 Diff 文件的 partial 选区，显式回退到整文件提交语义。
   */
  const clearDiffPartialCommitSelection = useCallback((): void => {
    const pathText = String(diff?.path || "").trim().replace(/\\/g, "/");
    if (!pathText) return;
    const diffRepoRoot = normalizeCommitRepoRoot(selectedLeadCommitEntry?.repositoryRoot || repoRoot);
    setPartialCommitSelectionState((prev) => clearPartialCommitSelection(prev, pathText, diffRepoRoot));
    const diffEntry = statusEntryByScopedPath.get(buildCommitInclusionLookupKey(pathText, diffRepoRoot)) || statusEntryByPath.get(pathText);
    const inclusionItemId = diffEntry ? buildCommitInclusionItemId(diffEntry) : "";
    if (inclusionItemId) {
      setCommitInclusionState((prev) => setCommitInclusionForItemIds(prev, [inclusionItemId], true));
    }
  }, [diff?.path, repoRoot, selectedLeadCommitEntry?.repositoryRoot, statusEntryByPath, statusEntryByScopedPath]);

  /**
   * 渲染中间 Diff 面板；全屏模式下复用同一套工具栏与查看器，只改变承载方式。
   */
  const renderDiffPanel = (
    fullscreen: boolean = false,
    options?: {
      onClose?: () => void;
      allowFullscreenToggle?: boolean;
    },
  ): JSX.Element => {
    const allowFullscreenToggle = options?.allowFullscreenToggle !== false;
    const handleClose = options?.onClose || closeDiffPreview;
    const diffModeCompactLabel = diffMode === "side" ? gt("workbench.misc.diff.side", "并排") : gt("workbench.misc.diff.unified", "统一");
    const whitespaceCompactLabel = ignoreWhitespace ? gt("workbench.misc.diff.ignoreWhitespace", "忽略") : gt("workbench.misc.diff.whitespace", "空白");
    const highlightCompactLabel = highlightWords ? gt("workbench.misc.diff.on", "高亮") : gt("workbench.misc.diff.off", "关闭");
    const diffPath = String(diff?.path || "").trim().replace(/\\/g, "/");
    const diffRepoRoot = normalizeCommitRepoRoot(selectedLeadCommitEntry?.repositoryRoot || repoRoot);
    const diffEntry = diffPath
      ? statusEntryByScopedPath.get(buildCommitInclusionLookupKey(diffPath, diffRepoRoot)) || statusEntryByPath.get(diffPath)
      : undefined;
    const diffHunks = diff?.hunks || [];
    const partialCommitVisible = shouldShowDiffPartialCommit({
      diff,
      entry: diffEntry,
    });
    const selectedHunkCount = partialCommitVisible
      ? diffPartialCommitControls.hunkControls.reduce((sum, control) => sum + (control.selectionState === "excluded" ? 0 : 1), 0)
      : 0;
    const selectedChangedLineCount = partialCommitVisible
      ? countSelectedPartialCommitLines(diffPartialCommitEntry)
      : 0;
    const totalChangedLineCount = partialCommitVisible
      ? diffPartialCommitControls.hunkControls.reduce((sum, control) => sum + control.totalLineCount, 0)
      : 0;
    const diffLineActionLabel = diffAffectedLineSelection.hasExplicitSelection
      ? gt("workbench.misc.diff.selectedLines", "所选行")
      : diffAffectedLineSelection.affectedLineCount === 1
        ? gt("workbench.misc.diff.currentLine", "当前行")
        : gt("workbench.misc.diff.matchedLines", "命中行");
    const canIncludeDiffSelectedLines = partialCommitVisible
      && diffAffectedLineSelection.affectedLineCount > 0
      && diffAffectedLineSelectionState.hasExcluded;
    const canExcludeDiffSelectedLines = partialCommitVisible
      && diffAffectedLineSelection.affectedLineCount > 0
      && diffAffectedLineSelectionState.hasIncluded;
    const partialCommitSummaryText = partialCommitVisible
      ? gt("workbench.misc.diff.partialSummary", "已纳入 {{selectedHunkCount}}/{{hunkCount}} 个 hunk，{{selectedLineCount}}/{{totalLineCount}} 行", {
        selectedHunkCount,
        hunkCount: diffHunks.length,
        selectedLineCount: selectedChangedLineCount,
        totalLineCount: totalChangedLineCount,
      })
      : "";
    const diffLineActionHintText = diffAffectedLineSelection.affectedLineCount > 0
      ? gt("workbench.misc.diff.partialHint", "{{label}}命中 {{lineCount}} 行 / {{hunkCount}} 个 hunk", {
        label: diffLineActionLabel,
        lineCount: diffAffectedLineSelection.affectedLineCount,
        hunkCount: diffAffectedLineSelection.affectedHunkCount,
      })
      : gt("workbench.misc.diff.partialGuide", "可直接点击 Diff 中缝与行侧复选框，或先框选 changed line 后批量纳入 / 排除");
    const diffSelectionPaths = Array.from(new Set(
      (diff?.selectionPaths || [])
        .map((one) => String(one || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ));
    const diffFileSelectionCount = diffSelectionPaths.length;
    const diffFileSelectionIndex = diff
      ? Math.max(0, diffSelectionPaths.indexOf(String(diff.path || "").trim().replace(/\\/g, "/")))
      : -1;
    if (!viewOptions.detailsPreviewShown && !diff) {
      return (
        <div className={cn(GIT_PANEL_CLASS, fullscreen ? "cf-git-diff-panel-fullscreen" : "cf-git-diff-panel")}>
          <div className="cf-git-pane-header flex items-center justify-between border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1">
      <span className="text-xs text-[var(--cf-text-secondary)]">{gt("workbench.misc.diff.detailsPreviewClosed", "详情预览已关闭")}</span>
            <Button size="xs" variant="secondary" onClick={() => void applyChangesViewOptionAsync("detailsPreviewShown", true)}>
              {gt("workbench.misc.diff.showPreview", "显示预览")}
            </Button>
          </div>
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-[var(--cf-text-secondary)]">
            {gt("workbench.misc.diff.clickToOpenNote", "单击文件不再自动切换 Diff，可通过回车、双击、右键“显示差异”或重新开启详情预览查看。")}
          </div>
        </div>
      );
    }
    return (
      <div className={cn(GIT_PANEL_CLASS, fullscreen ? "cf-git-diff-panel-fullscreen" : "cf-git-diff-panel")}>
        <div className="cf-git-pane-header flex items-center justify-between border-b border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple px-2 py-1">
          <div className="cf-git-toolbar-scroll no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap pr-2">
            <Button size="icon-sm" variant="ghost" title={gt("workbench.misc.diff.previous", "上一个差异")} onClick={() => navigateDiffLine("prev")} disabled={changedDiffLineIndexes.length === 0}>
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon-sm" variant="ghost" title={gt("workbench.misc.diff.next", "下一个差异")} onClick={() => navigateDiffLine("next")} disabled={changedDiffLineIndexes.length === 0}>
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            <div className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
            <Button
              size="icon-sm"
              variant="ghost"
              title={diffFileSelectionCount > 1 ? gt("workbench.misc.diff.previousFile", "上一文件") : gt("workbench.misc.diff.noFileSwitch", "当前没有可切换的文件组选区")}
              onClick={() => navigateDiffFileAsync("prev")}
              disabled={diffFileSelectionCount <= 1}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title={diffFileSelectionCount > 1 ? gt("workbench.misc.diff.nextFile", "下一文件") : gt("workbench.misc.diff.noFileSwitch", "当前没有可切换的文件组选区")}
              onClick={() => navigateDiffFileAsync("next")}
              disabled={diffFileSelectionCount <= 1}
            >
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            {diffFileSelectionCount > 1 ? (
              <div className="text-[11px] text-[var(--cf-text-secondary)]">
                {`${diffFileSelectionIndex + 1}/${diffFileSelectionCount}`}
              </div>
            ) : null}
            <Button size="icon-sm" variant="ghost" title={gt("workbench.misc.diff.copyPath", "复制路径")} disabled={!diff?.path} onClick={async () => {
              if (!diff?.path) return;
              await window.host.utils.copyText(diff.path);
            }}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <div className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
            <Select value={diffMode} onValueChange={(value) => setDiffMode(value === "unified" ? "unified" : "side")}>
              <SelectTrigger className="cf-git-filter-input h-7 w-auto min-w-0 max-w-[68px] flex-none justify-start px-1.5 text-xs" title={gt("workbench.misc.diff.viewerMode", "查看器模式")}>
                <span className="truncate text-left">{diffModeCompactLabel}</span>
              </SelectTrigger>
              <SelectContent fitContent maxContentWidth={320}>
                <SelectItem value="side">{gt("workbench.misc.diff.side", "并排查看器")}</SelectItem>
                <SelectItem value="unified">{gt("workbench.misc.diff.unified", "统一查看器")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={ignoreWhitespace ? "ignore" : "none"} onValueChange={(value) => setIgnoreWhitespace(value === "ignore")}>
              <SelectTrigger className="cf-git-filter-input h-7 w-auto min-w-0 max-w-[68px] flex-none justify-start px-1.5 text-xs" title={gt("workbench.misc.diff.whitespace", "空白忽略策略")}>
                <span className="truncate text-left">{whitespaceCompactLabel}</span>
              </SelectTrigger>
              <SelectContent fitContent maxContentWidth={320}>
                <SelectItem value="none">{gt("workbench.misc.diff.none", "不忽略")}</SelectItem>
                <SelectItem value="ignore">{gt("workbench.misc.diff.ignoreWhitespace", "忽略空白")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={highlightWords ? "on" : "off"} onValueChange={(value) => setHighlightWords(value === "on")}>
              <SelectTrigger className="cf-git-filter-input h-7 w-auto min-w-0 max-w-[68px] flex-none justify-start px-1.5 text-xs" title={gt("workbench.misc.diff.highlight", "单词高亮")}>
                <span className="truncate text-left">{highlightCompactLabel}</span>
              </SelectTrigger>
              <SelectContent fitContent maxContentWidth={320}>
                <SelectItem value="on">{gt("workbench.misc.diff.on", "高亮显示单词")}</SelectItem>
                <SelectItem value="off">{gt("workbench.misc.diff.off", "关闭高亮")}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="icon-sm" variant={collapseUnchanged ? "secondary" : "ghost"} title={gt("workbench.misc.diff.collapseUnchanged", "收起未变更")} onClick={() => setCollapseUnchanged((v) => !v)}>
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void exportPatchAsync()}
              disabled={!diff || diff.isBinary || !canExportPatchFromDiffMode(diff.mode)}
              title={!diff
                ? gt("workbench.misc.diff.exportPatch", "导出当前文件 Patch")
                : (canExportPatchFromDiffMode(diff.mode) ? gt("workbench.misc.diff.exportPatch", "导出当前文件 Patch") : gt("workbench.misc.diff.exportUnsupported", "当前比较视图不支持导出 Patch"))}
            >
              {gt("workbench.misc.diff.exportPatchShort", "导出 Patch")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!diff?.path || isCommitTreeResetRequired(totalCommitTreeFileCount)}
              onClick={() => {
                const targetPath = String(diff?.path || "").trim();
                if (!targetPath) return;
                const preferredChangeListId = statusEntryByPath.get(targetPath)?.changeListId;
                selectInCommitTreeByPath(targetPath, preferredChangeListId);
              }}
               title={!diff?.path
                 ? gt("workbench.misc.diff.noLocateFile", "当前没有可定位的文件")
                 : isCommitTreeResetRequired(totalCommitTreeFileCount)
                   ? gt("workbench.misc.diff.locateDisabled", "当前变更树过大，已禁用定位")
                   : gt("workbench.misc.diff.locateInChanges", "在更改中定位")}
            >
              {gt("workbench.misc.diff.locateInChanges", "在更改中定位")}
            </Button>
            {partialCommitVisible ? (
              <>
                <div className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
                {diffPartialCommitActive ? (
                  <span className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.accent)}>{gt("workbench.misc.diff.partialLabel", "Partial")}</span>
                ) : null}
                <div
                  className="max-w-[220px] truncate text-[11px] text-[var(--cf-text-secondary)]"
                  title={diffLineActionHintText}
                >
                  {partialCommitSummaryText}
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => toggleDiffPartialLineSelection(true)}
                  disabled={!canIncludeDiffSelectedLines}
                  title={gt("workbench.misc.diff.partialInclude", "纳入{{label}}", { label: diffLineActionLabel })}
                >
                  {gt("workbench.misc.diff.partialInclude", "纳入{{label}}", { label: diffLineActionLabel })}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => toggleDiffPartialLineSelection(false)}
                  disabled={!canExcludeDiffSelectedLines}
                  title={gt("workbench.misc.diff.partialExclude", "排除{{label}}", { label: diffLineActionLabel })}
                >
                  {gt("workbench.misc.diff.partialExclude", "排除{{label}}", { label: diffLineActionLabel })}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger>
                    <Button size="icon-sm" variant="ghost" title={gt("workbench.misc.diff.moreActions", "部分提交更多操作")}>
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuLabel>{gt("workbench.misc.diff.moreActions", "部分提交")}</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => setAllDiffPartialHunksSelected(true)}>
                      {gt("workbench.misc.diff.includeAll", "全部纳入")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAllDiffPartialHunksSelected(false)}>
                      {gt("workbench.misc.diff.excludeAll", "全部排除")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => clearDiffPartialCommitSelection()}>
                      {gt("workbench.misc.diff.revertWholeFile", "回退整文件")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : null}
          </div>
          <div className="ml-2 flex shrink-0 items-center gap-1">
            <div className="hidden xl:block text-[11px] text-[var(--cf-text-secondary)]">{gt("workbench.misc.diff.selectedLines", "差异行 {{count}}", { count: changedDiffLineIndexes.length })}</div>
            {diff?.path ? <div className="hidden 2xl:block max-w-[300px] truncate text-[11px] text-[var(--cf-text-secondary)]">{diff.path}</div> : null}
            {allowFullscreenToggle ? (
              <Button
                size="icon-sm"
                variant={diffFullscreen ? "secondary" : "ghost"}
                title={diffFullscreen ? gt("workbench.misc.diff.exitFullscreen", "退出全屏 Diff") : gt("workbench.misc.diff.enterFullscreen", "全屏查看 Diff")}
                onClick={() => setDiffFullscreen((prev) => !prev)}
                disabled={!diff}
              >
                {diffFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </Button>
            ) : null}
            <Button size="icon-sm" variant="ghost" onClick={handleClose} title={gt("workbench.misc.diff.close", "关闭 Diff")}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {!highlightWords ? (
          <div className="cf-git-inline-note border-b border-[var(--cf-border)] px-2 py-[2px] text-[10px] text-[var(--cf-text-secondary)]">
            {gt("workbench.misc.diff.wordHighlightDisabledNote", "当前已关闭单词高亮，仅显示行级差异。")}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          <React.Suspense fallback={<div className="h-full w-full p-4 text-xs text-[var(--cf-text-secondary)]">{gt("workbench.misc.diff.loading", "正在加载 Diff 组件...")}</div>}>
            <MonacoGitDiff
              diff={diff}
              sideBySide={diffMode === "side"}
              ignoreWhitespace={ignoreWhitespace}
              collapseUnchanged={collapseUnchanged}
              modifiedEditable={diff?.mode === "working"}
              lineDecorations={partialCommitVisible ? diffPartialCommitLineDecorations : null}
              partialCommitControls={partialCommitVisible ? diffPartialCommitControls : null}
              onPartialCommitBlockToggle={partialCommitVisible ? toggleDiffPartialLineGroupSelection : undefined}
              onPartialCommitLineToggle={partialCommitVisible ? toggleDiffPartialSingleLineSelection : undefined}
              onModifiedContentChange={(content) => {
                if (!diff || diff.mode !== "working") return;
                scheduleWriteWorkingFile(diff.path, content);
              }}
              onSelectionChange={setDiffEditorSelection}
              activeLine={diffActiveLine}
              onChangedLines={setChangedDiffLineIndexes}
              onOpenInIde={canOpenExternalDiffTarget(diff) ? () => {
                void openDiffExternalTargetAsync("ide");
              } : undefined}
              onOpenInSystem={canOpenExternalDiffTarget(diff) ? () => {
                void openDiffExternalTargetAsync("system");
              } : undefined}
              onExportPatch={diff && canExportPatchFromDiffMode(diff.mode) ? () => {
                void exportPatchAsync();
              } : undefined}
            />
          </React.Suspense>
        </div>
      </div>
    );
  };

  /**
   * 渲染分支快速切换弹窗，支持键盘筛选与操作入口聚合。
   */
  const renderBranchPopup = (): JSX.Element | null => {
    if (!branchPopupOpen) return null;
    const headerActions = branchPopupActionGroups.find((group) => group.id === "header")?.items || [];
    const quickActions = branchPopupActionGroups.find((group) => group.id === "quick")?.items || [];
    return (
      <>
        <div className="fixed inset-0 z-[1100]" onMouseDown={() => setBranchPopupOpen(false)}></div>
        <div
          className="cf-git-dialog-panel fixed left-1/2 top-[84px] z-[1101] flex h-[520px] w-[560px] -translate-x-1/2 flex-col overflow-hidden rounded-apple-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-primary)]"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="cf-git-pane-header border-b border-[var(--cf-border)] p-3">
            <div className="flex items-center gap-3">
              <Input
                autoFocus
                className="cf-git-filter-input h-9 text-[var(--cf-text-primary)]"
                placeholder={gt("workbench.misc.branchPopup.search", "搜索分支/标签/远端")}
                value={branchPopupQuery}
                onChange={(e) => {
                  setBranchPopupQuery(e.target.value);
                  setBranchPopupIndex(0);
                }}
              />
              {headerActions.map((action) => (
                <Button
                  key={`branch-popup-header:${action.id}`}
                  size="xs"
                  variant="secondary"
                  className={cn(
                    "h-8 shrink-0 px-2",
                    action.checked ? "border-[var(--cf-accent)] text-[var(--cf-accent)]" : "",
                  )}
                  onClick={() => {
                    void runBranchPopupActionAsync(action.id);
                  }}
                >
                  {action.checked ? "✓ " : ""}
                  {action.label}
                </Button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--cf-text-secondary)]">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {selectedBranchRepository?.rootName || gt("workbench.misc.branchPopup.currentRepo", "当前仓")}
                  </Badge>
                  <span className="truncate">
                    {gt("workbench.misc.branchPopup.head", "HEAD:")} {selectedBranchRepository?.currentBranch || repoBranch || "HEAD"}
                  </span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {quickActions.map((action) => (
                  <Button
                    key={`branch-popup-quick:${action.id}`}
                    size="xs"
                    variant="ghost"
                    className="h-7 px-2"
                    title={action.shortcut}
                    onClick={() => {
                      void runBranchPopupActionAsync(action.id);
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            </div>
            {branchPopupWarning?.visible ? (
              <div className="mt-2 rounded-apple border border-[var(--cf-warning)]/30 bg-[var(--cf-yellow-light)] px-3 py-2 text-[11px] text-[var(--cf-warning-foreground)]">
                {branchPopupWarning.text}
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2 text-sm">
            {branchRows.map((row, index) => {
              if (row.kind === "group") {
                if (row.section === "repositories") {
                  return <div key={row.key} className="px-2 py-0.5 text-xs font-apple-medium text-[var(--cf-text-secondary)]">{row.label}</div>;
                }
                const section = row.section;
                const expanded = branchPopupGroupOpen[section];
                return (
                  <button
                    key={row.key}
                    className="flex w-full items-center gap-0.5 px-2 py-0.5 text-left text-xs font-apple-medium text-[var(--cf-text-secondary)]"
                    onClick={() => {
                      setBranchPopupGroupOpen((prev) => ({
                        ...prev,
                        [section]: !prev[section],
                      }));
                    }}
                  >
                    {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    <span>{row.label}</span>
                  </button>
                );
              }
              const selected = index === branchPopupIndex;
              const presentation = row.kind === "branch"
                ? branchPopupPresentationByKey.get(`popup:${row.repoRoot}:${row.section}:${row.name}`) || buildBranchRowPresentation(row.item || { name: row.name }, gt)
                : null;
              return (
                <div
                  key={row.kind === "branch"
                    ? `branch:${row.repoRoot}:${row.section}:${row.name}`
                    : row.kind === "action"
                      ? `action:${row.id}`
                      : row.kind === "repository"
                        ? `repository:${row.repoRoot}`
                        : `back:${row.repoRoot}`}
                  className={cn(
                    "cf-git-list-row flex w-full items-center justify-between gap-1.5 rounded-apple-sm px-2 py-0.75 text-left",
                    selected ? "cf-git-row-selected" : "",
                  )}
                  title={row.kind === "branch" ? presentation?.tooltip : row.kind === "repository" ? row.repoRoot : undefined}
                  onMouseEnter={() => setBranchPopupIndex(index)}
                  onClick={() => void applyBranchPopupRowAsync(row)}
                >
                  {row.kind === "back" ? <ArrowLeft className="h-4 w-4 shrink-0 text-[var(--cf-text-secondary)]" /> : null}
                  {row.kind === "repository" ? <Folder className="h-4 w-4 shrink-0 text-[var(--cf-text-secondary)]" /> : null}
                  <span
                    className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden"
                    title={row.kind === "branch" ? row.name : row.kind === "repository" ? row.rootName : row.label}
                  >
                    <span className="truncate font-apple-medium text-[13px] leading-5">
                      {row.kind === "branch" ? row.name : row.kind === "repository" ? row.rootName : row.label}
                    </span>
                    {row.kind === "branch" && presentation?.secondaryText ? (
                      <span className="truncate text-[11px] text-[var(--cf-text-secondary)]" title={presentation.secondaryText}>
                        {presentation.secondaryText}
                      </span>
                    ) : null}
                    {row.kind === "repository" ? (
                      <span className="truncate text-[11px] text-[var(--cf-text-secondary)]" title={row.currentBranch}>
                        {row.detached
                          ? gt("workbench.branches.common.detachedBranch", "Detached {{branch}}", { branch: row.currentBranch })
                          : row.currentBranch}
                      </span>
                    ) : null}
                  </span>
                  {row.kind === "branch" ? (
                    <div className="ml-2 flex shrink-0 items-center gap-1">
                      {row.item ? (
                        <Button
                        size="icon-sm"
                        variant="ghost"
                        className={cn("h-6 w-6", row.item.favorite ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-secondary)]")}
                        title={row.item.favorite
                          ? gt("workbench.branches.common.unfavorite", "取消收藏")
                          : gt("workbench.branches.common.favorite", "收藏分支")}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                            void toggleBranchFavoriteAsync(row.item!, row.repoRoot, row.section);
                          }}
                        >
                          <Star className={cn("h-3.5 w-3.5", row.item.favorite ? "fill-current" : "")} />
                        </Button>
                      ) : null}
                      <BranchSyncBadges
                        incoming={presentation?.incomingBadge || null}
                        outgoing={presentation?.outgoingBadge || null}
                      />
                      {row.item?.current ? <span className={cn("cf-git-ref-pill", GIT_TONE_CLASSNAME.success)}>{gt("workbench.misc.headBadge", "HEAD")}</span> : null}
                    </div>
                  ) : null}
                  {row.kind === "repository" ? (
                    <div className="ml-2 flex shrink-0 items-center gap-1">
                      <span className={cn("cf-git-ref-pill", row.item.kind === "submodule" ? GIT_TONE_CLASSNAME.warning : GIT_TONE_CLASSNAME.info)}>
                        {row.item.kind === "submodule"
                          ? gt("workbench.branches.common.submodule", "子模块")
                          : gt("workbench.branches.common.repository", "仓库")}
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                    </div>
                  ) : null}
                  {row.kind === "action" && row.shortcut ? <span className="text-xs text-[var(--cf-text-secondary)]">{row.shortcut}</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  };

  const renderMenu = (): JSX.Element | null => {
    if (!menu) return null;
    if (menu.type === "changes") {
      const menuTargetPath = String(menu.target || "").trim().replace(/\\/g, "/");
      const inferredIdsFromTargetPath = menuTargetPath
        ? Array.from(new Set(combinedStatusEntries
          .filter((entry) => {
            const pathText = String(entry.path || "").replace(/\\/g, "/");
            return pathText === menuTargetPath || pathText.startsWith(`${menuTargetPath}/`);
          })
          .map((entry) => String(entry.changeListId || "").trim())
          .filter(Boolean)))
        : [];
      const inferredChangeListId = inferredIdsFromTargetPath.length === 1 ? inferredIdsFromTargetPath[0] : "";
      const contextChangeListId = String(menu.changeListId || parseChangeListIdFromMenuTarget(menu.target) || inferredChangeListId || "").trim();
      const availableChangeListIds = new Set((status?.changeLists?.lists || []).map((one) => String(one.id || "").trim()).filter(Boolean));
      const selectionContext = buildCommitTreeDataSnapshot({
        selectedEntries: menuCommitSelectionSnapshot.selectedEntries,
        selectedPaths: menuCommitSelectionSnapshot.selectedPaths,
        exactlySelectedPaths: menuCommitSelectionSnapshot.exactlySelectedPaths,
        selectedNodeSources: menuCommitSelectionSnapshot.selectedNodeSources,
        selectedChangeListIds: menuCommitSelectionSnapshot.selectedChangeListIds,
        selectedExplicitChangeListIds: menuCommitSelectionSnapshot.selectedExplicitChangeListIds,
        contextChangeListId,
        contextChangeListExplicit: menu.targetKind === "changelist",
        availableChangeListIds,
        activeChangeListId: String(status?.changeLists?.activeListId || "").trim(),
        localChangesConfig,
      });
      const singleTreeSelection = menuCommitSelectionSnapshot.selectedRowKeys.length === 1;
      const showAddToVcsAction = selectionContext.canAddToVcs || (
        singleTreeSelection
        && !!menuCommitSelectionSnapshot.selectedSingleNode
        && !menuCommitSelectionSnapshot.selectedSingleNode.isFile
        && (menuCommitSelectionSnapshot.selectedSingleNode.kind === "directory" || menuCommitSelectionSnapshot.selectedSingleNode.kind === "module" || menuCommitSelectionSnapshot.selectedSingleNode.kind === "repository")
      );
      const conflictContextActionKeys = buildConflictContextActionKeys(menuCommitSelectionSnapshot.selectedEntries);
      /**
       * 菜单项统一复用打开菜单时冻结的选择快照，避免右键动作执行时误用新的全局选区。
       */
      const runMenuChangeAction = (action: string): void => {
        setMenu(null);
        void runChangeMenuActionAsync(action, contextChangeListId || undefined, {
          selectionSnapshot: menuCommitSelectionSnapshot,
          targetKindHint: menu.targetKind,
        });
      };
      const sharedMenuSections = buildCommitTreeSharedMenuSections({
        selection: selectionContext,
        singleSelection: singleTreeSelection,
        showAddToVcs: showAddToVcsAction,
        showDelete: shouldShowCommitTreeSharedDeleteAction({
          exactlySelectedFileCount: selectionContext.exactlySelectedFiles.length,
          singleSelection: singleTreeSelection,
          selectedNodeKind: menuCommitSelectionSnapshot.selectedSingleNode?.kind,
          selectedNodeDisplayPath: menuCommitSelectionSnapshot.selectedSingleNode?.textPresentation || menuCommitSelectionSnapshot.selectedSingleNode?.name,
        }),
        showEditSource: selectionContext.exactlySelectedFiles.length === 1,
      });
      /**
       * 把提交树共享菜单模型渲染成具体菜单项，统一承接 IDEA 提交工具窗口层级与当前产品豁免映射。
       */
      const renderSharedMenuNode = (node: CommitTreeSharedMenuNode): JSX.Element | null => {
        if (node.kind === "submenu") {
          if (node.id === "localHistory") {
            return (
              <ContextMenuSubmenu
                key="local-history-menu"
                label={gt("workbench.changes.context.localHistory", "本地历史记录(H)")}
                disabled={node.disabled}
                title={node.title}
              >
                {node.children.map((child) => renderSharedMenuNode(child))}
              </ContextMenuSubmenu>
            );
          }
          return (
            <ContextMenuSubmenu
              key="git-menu"
              label={gt("workbench.changes.context.gitMenu", "Git(G)")}
              disabled={node.disabled}
              title={node.title}
            >
              {node.children.map((child) => renderSharedMenuNode(child))}
            </ContextMenuSubmenu>
          );
        }
        if (node.id === "commitFile") {
          return <ContextMenuItem key="commit" label={gt("workbench.changes.context.commitFiles", "提交(I)文件...")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("commitFile"); }} />;
        }
        if (node.id === "rollback") {
          return <ContextMenuItem key="rollback" label={gt("workbench.changes.context.rollback", "回滚(R)...")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("rollback"); }} />;
        }
        if (node.id === "move") {
          return <ContextMenuItem key="move" label={gt("workbench.changes.context.moveToAnotherChangelist", "移至另一个更改列表...")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("move"); }} />;
        }
        if (node.id === "showDiff") {
          return <ContextMenuItem key="diff" label={gt("workbench.changes.context.showDiff", "显示差异")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("showDiff"); }} />;
        }
        if (node.id === "showStandaloneDiff") {
          return <ContextMenuItem key="standalone-diff" label={gt("workbench.changes.context.showInStandaloneDiff", "在独立 Diff 中显示")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("showStandaloneDiff"); }} />;
        }
        if (node.id === "editSource") {
          return <ContextMenuItem key="source" label={gt("workbench.changes.context.jumpToSource", "跳转到源(J)")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("editSource"); }} />;
        }
        if (node.id === "delete") {
          return <ContextMenuItem key="delete" label={gt("workbench.changes.context.delete", "删除(D)...")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("delete"); }} />;
        }
        if (node.id === "addToVcs") {
          return <ContextMenuItem key="add-to-vcs" label={gt("workbench.changes.context.addToVcs", "添加到 VCS")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("addToVcs"); }} />;
        }
        if (node.id === "ignore") {
          return <ContextMenuItem key="ignore" label={gt("workbench.changes.context.ignore", "忽略")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("ignore"); }} />;
        }
        if (node.id === "createPatch") {
          return <ContextMenuItem key="create-patch" label={gt("workbench.changes.context.createPatchFromLocalCommit", "从本地更改创建补丁...")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { setMenu(null); void exportPatchFromChangeSelectionAsync("save"); }} />;
        }
        if (node.id === "copyPatch") {
          return <ContextMenuItem key="copy-patch" label={gt("workbench.changes.context.copyPatchToClipboard", "作为补丁复制到剪贴板")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { setMenu(null); void exportPatchFromChangeSelectionAsync("clipboard"); }} />;
        }
        if (node.id === "shelve") {
          return <ContextMenuItem key="shelve" label={gt("workbench.changes.context.shelveChanges", "搁置更改...")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("shelve"); }} />;
        }
        if (node.id === "refresh") {
          return <ContextMenuItem key="refresh" label={gt("workbench.common.refresh", "刷新")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("refresh"); }} />;
        }
        if (node.id === "showHistory") {
          return <ContextMenuItem key="history" label={gt("workbench.changes.context.showHistory", "显示历史记录...")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { runMenuChangeAction("pathHistory"); }} />;
        }
        if (node.id === "showWorktrees") {
          return <ContextMenuItem key="worktree" label={gt("workbench.changes.context.gitWorktreeItem", "工作树")} disabled={node.disabled} shortcut={node.shortcut} title={node.title} onClick={() => { setMenu(null); showWorktreesTabByUser(); }} />;
        }
        return null;
      };
      return (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} actionGroupId={selectionContext.popupActionGroupId}>
          {renderContextMenuSections([
            conflictContextActionKeys.length > 0 ? [
              ...conflictContextActionKeys.map((actionKey) => (
                <ContextMenuItem
                  key={actionKey}
                  label={actionKey === "mergeConflicts"
                    ? gt("workbench.changes.context.merge", "Merge")
                    : (actionKey === "acceptTheirs"
                        ? gt("workbench.changes.context.acceptTheirs", "接受 Theirs")
                        : gt("workbench.changes.context.acceptYours", "接受 Yours"))}
                  onClick={() => {
                    runMenuChangeAction(actionKey);
                  }}
                />
              )),
            ] : [],
            sharedMenuSections[0]?.map((node) => renderSharedMenuNode(node)) || [],
            [
              ...(sharedMenuSections[1]?.map((node) => renderSharedMenuNode(node)).filter(Boolean) || []),
              selectionContext.stagingAreaEnabled ? <ContextMenuItem key="stage" label={gt("workbench.changes.actions.stageSelected", "暂存选中文件")} disabled={!selectionContext.canStage} onClick={() => { runMenuChangeAction("stage"); }} /> : null,
              selectionContext.stagingAreaEnabled ? <ContextMenuItem key="stage-without-content" label={gt("workbench.changes.actions.stageWithoutContent", "暂存但不添加内容")} disabled={!selectionContext.canStageWithoutContent} onClick={() => { runMenuChangeAction("stageWithoutContent"); }} /> : null,
              selectionContext.stagingAreaEnabled ? <ContextMenuItem key="stage-all" label={globalStageActionAvailability.stageAll.label} disabled={!globalStageActionAvailability.stageAll.enabled} title={globalStageActionAvailability.stageAll.reason} onClick={() => { runMenuChangeAction("stageAll"); }} /> : null,
              selectionContext.stagingAreaEnabled ? <ContextMenuItem key="unstage" label={gt("workbench.changes.actions.unstage", "从暂存区移除")} disabled={!selectionContext.canUnstage} onClick={() => { runMenuChangeAction("unstage"); }} /> : null,
              selectionContext.stagingAreaEnabled ? <ContextMenuItem key="revert-unstaged" label={gt("workbench.changes.actions.revertUnstaged", "还原未暂存更改")} disabled={!selectionContext.canRevertUnstaged} onClick={() => { runMenuChangeAction("revertUnstaged"); }} /> : null,
            ],
            selectionContext.stagingAreaEnabled ? [
              <ContextMenuItem key="show-staged" label={gt("workbench.changes.actions.showStaged", "显示暂存版本")} disabled={!selectionContext.canShowStaged || !singleTreeSelection} onClick={() => { runMenuChangeAction("showStaged"); }} />,
              <ContextMenuItem key="show-local" label={gt("workbench.changes.actions.showLocal", "显示工作区版本")} disabled={!selectionContext.canShowLocal || !singleTreeSelection} onClick={() => { runMenuChangeAction("showLocal"); }} />,
              <ContextMenuItem key="compare-local-staged" label={gt("workbench.changes.context.compareLocalToStaged", "比较 工作区 → 暂存区")} disabled={!selectionContext.canCompareLocalToStaged || !singleTreeSelection} onClick={() => { runMenuChangeAction("compareLocalToStaged"); }} />,
              <ContextMenuItem key="compare-staged-local" label={gt("workbench.changes.context.compareStagedToLocal", "比较 暂存区 → 工作区")} disabled={!selectionContext.canCompareStagedToLocal || !singleTreeSelection} onClick={() => { runMenuChangeAction("compareStagedToLocal"); }} />,
              <ContextMenuItem key="compare-staged-head" label={gt("workbench.changes.context.compareStagedToHead", "比较 暂存区 ↔ HEAD")} disabled={!selectionContext.canCompareStagedToHead || !singleTreeSelection} onClick={() => { runMenuChangeAction("compareStagedToHead"); }} />,
              <ContextMenuItem key="compare-three" label={gt("workbench.changes.actions.compareThreeVersions", "比较三个版本")} disabled={!selectionContext.canCompareThreeVersions || !singleTreeSelection} onClick={() => { runMenuChangeAction("compareThreeVersions"); }} />,
              <ContextMenuItem key="stash-selection" label={gt("workbench.changes.actions.stageStash", "暂存选中文件到 Stash")} disabled={!selectionContext.canStageStash} onClick={() => { runMenuChangeAction("stageStash"); }} />,
            ] : [],
            sharedMenuSections[2]?.map((node) => renderSharedMenuNode(node)) || [],
            sharedMenuSections[3]?.map((node) => renderSharedMenuNode(node)) || [],
          ])}
        </ContextMenu>
      );
    }

    if (menu.type === "log") {
      const disabled = selectedCommitHashes.length === 0;
      const single = selectedCommitHashes.length === 1;
      const currentHash = selectedCommitHashes[0] || "";
      const currentItem = currentHash ? logItems.find((one) => one.hash === currentHash) : null;
      const selectedLogItems = selectedCommitHashes
        .map((hash) => logItems.find((one) => one.hash === hash))
        .filter((one): one is GitLogItem => !!one);
      const currentIndex = currentHash ? logItems.findIndex((one) => one.hash === currentHash) : -1;
      const canGotoParent = single && currentIndex >= 0 && currentIndex < logItems.length - 1;
      const canGotoChild = single && currentIndex > 0;
      const hasMergeCommit = selectedLogItems.some((one) => one.parents.length > 1);
      const isHeadCommit = !!(currentItem && String(currentItem.decorations || "").includes("HEAD"));
      const selectedHashesKey = selectedCommitHashes.join("|");
      const availabilityLoaded = logActionAvailabilityHashesKey === selectedHashesKey && !!logActionAvailability?.actions;
      const availabilityActions = availabilityLoaded ? logActionAvailability?.actions : undefined;
      const availabilityPending = !disabled && logActionAvailabilityLoading && !availabilityLoaded;
      const availabilityUnavailableReason = availabilityPending
        ? gitWorkbenchText("workbench.log.actions.loadingAvailability", "正在读取动作可用性...")
        : gitWorkbenchText("workbench.log.actions.unavailable", "无法读取动作可用性");
      const resolveLogActionAvailability = (
        actionKey: GitLogActionAvailabilityKey,
        fallbackReason: string,
      ): { enabled: boolean; reason?: string } => {
        if (disabled) return { enabled: false, reason: gitWorkbenchText("workbench.log.actions.selectCommit", "请先选择提交") };
        if (!availabilityActions) return { enabled: false, reason: availabilityUnavailableReason };
        const hit = availabilityActions?.[actionKey];
        if (hit && typeof hit.enabled === "boolean") {
          if (hit.enabled) return { enabled: true };
          return { enabled: false, reason: String(hit.reason || fallbackReason) };
        }
        return { enabled: false, reason: fallbackReason || availabilityUnavailableReason };
      };
      const copyRevisionAction = resolveLogActionAvailability("copyRevision", gitWorkbenchText("workbench.log.actions.selectCommit", "请先选择提交"));
      const createPatchAction = resolveLogActionAvailability("createPatch", gitWorkbenchText("workbench.log.actions.selectCommit", "请先选择提交"));
      const cherryPickAction = resolveLogActionAvailability("cherryPick", gitWorkbenchText("workbench.log.actions.selectCommit", "请先选择提交"));
      const checkoutAction = resolveLogActionAvailability("checkoutRevision", gitWorkbenchText("workbench.log.actions.singleSelectionOnly", "仅支持单选提交"));
      const showRepoAction = resolveLogActionAvailability("showRepoAtRevision", gitWorkbenchText("workbench.log.actions.singleSelectionOnly", "仅支持单选提交"));
      const compareLocalAction = resolveLogActionAvailability("compareLocal", gitWorkbenchText("workbench.log.actions.singleSelectionOnly", "仅支持单选提交"));
      const resetAction = resolveLogActionAvailability("reset", gitWorkbenchText("workbench.log.actions.singleSelectionOnly", "仅支持单选提交"));
      const revertAction = resolveLogActionAvailability("revert", hasMergeCommit ? gitWorkbenchText("workbench.log.actions.mergeCommitUnsupported", "合并提交不支持该操作") : gitWorkbenchText("workbench.log.actions.selectCommit", "请先选择提交"));
      const undoCommitAction = resolveLogActionAvailability("undoCommit", gitWorkbenchText("workbench.log.actions.currentHeadOnly", "仅支持当前 HEAD 提交"));
      const editMessageAction = resolveLogActionAvailability("editMessage", gitWorkbenchText("workbench.log.actions.conditionNotMet", "当前条件不满足"));
      const fixupAction = resolveLogActionAvailability("fixup", gitWorkbenchText("workbench.log.actions.conditionNotMet", "当前条件不满足"));
      const squashToAction = resolveLogActionAvailability("squashTo", gitWorkbenchText("workbench.log.actions.conditionNotMet", "当前条件不满足"));
      const squashCommitsAction = resolveLogActionAvailability("squashCommits", selectedCommitHashes.length >= 2 ? gitWorkbenchText("workbench.log.actions.conditionNotMet", "当前条件不满足") : gitWorkbenchText("workbench.log.actions.selectAtLeastTwo", "至少选择 2 个提交"));
      const deleteCommitAction = resolveLogActionAvailability("deleteCommit", gitWorkbenchText("workbench.log.actions.conditionNotMet", "当前条件不满足"));
      const interactiveRebaseAction = resolveLogActionAvailability("interactiveRebase", gitWorkbenchText("workbench.log.actions.conditionNotMet", "当前条件不满足"));
      const pushAllPreviousAction = resolveLogActionAvailability("pushAllPrevious", gitWorkbenchText("workbench.log.actions.singleSelectionOnly", "仅支持单选提交"));
      const newBranchAction = resolveLogActionAvailability("newBranch", gitWorkbenchText("workbench.log.actions.singleSelectionOnly", "仅支持单选提交"));
      const newTagAction = resolveLogActionAvailability("newTag", gitWorkbenchText("workbench.log.actions.singleSelectionOnly", "仅支持单选提交"));
      const pushActionLabel = isHeadCommit ? gitWorkbenchText("workbench.log.actions.push", "推送...") : gitWorkbenchText("workbench.log.actions.pushAllPrevious", "推送此前所有提交...");
      const pushActionShortcut = isHeadCommit ? "Ctrl+Shift+K" : undefined;
      const localBranchByName = new Map((branchPopup?.groups?.local || []).map((one) => [String(one.name || "").trim(), one] as const).filter((one) => !!one[0]));
      const parsedRefs = single
        ? parseLogDecorationRefs(String(currentItem?.decorations || ""), branchPopup, String(repoBranch || ""))
        : { localBranches: [], remoteBranches: [], tags: [] };
      const branchRefs = [
        ...parsedRefs.localBranches.map((name) => ({ kind: "local" as const, name })),
        ...parsedRefs.remoteBranches.map((name) => ({ kind: "remote" as const, name })),
      ];
      const tagRefs = parsedRefs.tags.map((name) => ({ kind: "tag" as const, name }));
      const visibleBranchRefs = branchRefs;
      const visibleTagRefs = tagRefs;
      const logCheckoutMenu = buildGitLogCheckoutMenuModel({
        localBranchRefs: parsedRefs.localBranches,
        currentBranch: String(repoBranch || ""),
      });
      const hasCurrentBranch = !repoDetached && !!String(repoBranch || "").trim();
      const normalizePathForCompare = (value: string): string => String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const currentWorktreePath = normalizePathForCompare(String(repoRoot || ""));
      const currentBranchLabel = String(repoBranch || "").trim() || gitWorkbenchText("workbench.branchFilter.currentBranch", "当前分支");

      /**
       * 渲染日志 refs 中的跟踪分支子菜单，复用远端分支动作集。
       */
      const renderLogTrackedBranchSubmenu = (
        trackingRemoteRef: string,
        canCurrentBranchBasedOperation: boolean,
        canPullTrackingRemote: boolean,
      ): JSX.Element | null => {
        if (!trackingRemoteRef) return null;
        const trackingRemoteParsed = parseRemoteBranchRefName(trackingRemoteRef, knownRemoteNames);
        const trackingRemoteName = String(trackingRemoteParsed?.remote || "").trim();
        return (
          <ContextMenuSubmenu label={gt("workbench.branches.context.trackingBranch", "跟踪分支 '{{branch}}'", { branch: trackingRemoteRef })}>
            {renderContextMenuSections([
              [
                <ContextMenuItem key="checkout" label={gt("workbench.branches.context.checkout", "签出")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("checkout", trackingRemoteRef); }} />,
                <ContextMenuItem key="newFrom" label={gt("workbench.branches.context.newBranchFrom", "从 '{{target}}' 新建分支...", { target: trackingRemoteRef })} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("newFrom", trackingRemoteRef); }} />,
                <ContextMenuItem
                  key="checkoutRebaseCurrent"
                  label={gt("workbench.branches.context.checkoutAndRebaseToCurrent", "签出并变基到 '{{branch}}'", { branch: currentBranchLabel })}
                  disabled={!canCurrentBranchBasedOperation}
                  title={canCurrentBranchBasedOperation ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                  onClick={() => { setMenu(null); void runLogRefMenuActionAsync("checkoutRebaseCurrent", trackingRemoteRef); }}
                />,
              ],
              [
                <ContextMenuItem
                  key="compareCurrent"
                  label={gt("workbench.branches.context.compareWithCurrent", "与 '{{branch}}' 比较", { branch: currentBranchLabel })}
                  disabled={!canCurrentBranchBasedOperation}
                  title={canCurrentBranchBasedOperation ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                  onClick={() => { setMenu(null); void runLogRefMenuActionAsync("compareCurrent", trackingRemoteRef); }}
                />,
                <ContextMenuItem key="compareAny" label={gt("workbench.branches.context.compareCommitsWithAnyBranch", "与任意分支比较提交...")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("compareAny", trackingRemoteRef); }} />,
                <ContextMenuItem key="worktreeDiff" label={gt("workbench.branches.context.showWorktreeDiff", "显示与工作树的差异")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("worktreeDiff", trackingRemoteRef); }} />,
                <ContextMenuItem key="compareAnyFiles" label={gt("workbench.branches.context.compareFilesWithAnyBranch", "与任意分支比较文件...")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("compareAnyFiles", trackingRemoteRef); }} />,
              ],
              [
                <ContextMenuItem
                  key="rebaseCurrentToTarget"
                  label={gt("workbench.branches.context.rebaseCurrentToTarget", "将 '{{branch}}' 变基到 '{{target}}'", { branch: currentBranchLabel, target: trackingRemoteRef })}
                  disabled={!canCurrentBranchBasedOperation}
                  title={canCurrentBranchBasedOperation ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                  onClick={() => { setMenu(null); void runLogRefMenuActionAsync("rebaseCurrentToTarget", trackingRemoteRef); }}
                />,
                <ContextMenuItem
                  key="mergeTargetToCurrent"
                  label={gt("workbench.branches.context.mergeTargetToCurrent", "将 '{{target}}' 合并到 '{{branch}}' 中", { target: trackingRemoteRef, branch: currentBranchLabel })}
                  disabled={!canCurrentBranchBasedOperation}
                  title={canCurrentBranchBasedOperation ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                  onClick={() => { setMenu(null); void runLogRefMenuActionAsync("mergeTargetToCurrent", trackingRemoteRef); }}
                />,
                <ContextMenuItem key="createWorktree" label={gt("workbench.branches.context.createWorktree", "创建新工作树...")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("createWorktree", trackingRemoteRef); }} />,
              ],
              [
                <ContextMenuItem
                  key="pullRemoteRebase"
                  label={gt("workbench.branches.context.pullRemoteRebase", "将 '{{branch}}' 与该远端分支变基拉取", { branch: currentBranchLabel })}
                  disabled={!canPullTrackingRemote}
                  title={canPullTrackingRemote ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                  onClick={() => { setMenu(null); void runLogRefMenuActionAsync("pullRemoteRebase", trackingRemoteRef); }}
                />,
                <ContextMenuItem
                  key="pullRemoteMerge"
                  label={gt("workbench.branches.context.pullRemoteMerge", "将 '{{branch}}' 与该远端分支合并拉取", { branch: currentBranchLabel })}
                  disabled={!canPullTrackingRemote}
                  title={canPullTrackingRemote ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                  onClick={() => { setMenu(null); void runLogRefMenuActionAsync("pullRemoteMerge", trackingRemoteRef); }}
                />,
                <ContextMenuItem key="deleteRemote" label={gt("workbench.branches.context.deleteTrackedRemoteBranch", "删除跟踪远端分支(D)")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("deleteRemote", trackingRemoteRef); }} />,
                <ContextMenuItem
                  key="editRemote"
                  label={trackingRemoteName ? gt("workbench.branches.context.editRemote", "编辑远端 '{{remote}}'...", { remote: trackingRemoteName }) : gt("workbench.branches.context.editRemote", "编辑远端 '{{remote}}'...", { remote: "" })}
                  disabled={!trackingRemoteName}
                  onClick={() => { setMenu(null); if (!trackingRemoteName) return; void runLogRefMenuActionAsync("editRemote", trackingRemoteName); }}
                />,
                <ContextMenuItem
                  key="removeRemote"
                  label={trackingRemoteName ? gt("workbench.branches.context.removeRemote", "移除远端 '{{remote}}'", { remote: trackingRemoteName }) : gt("workbench.branches.context.removeRemote", "移除远端 '{{remote}}'", { remote: "" })}
                  disabled={!trackingRemoteName}
                  onClick={() => { setMenu(null); if (!trackingRemoteName) return; void runLogRefMenuActionAsync("removeRemote", trackingRemoteName); }}
                />,
                <ContextMenuItem key="configureRemotes" label={gt("workbench.branches.context.configureRemotes", "配置远端...")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("configureRemotes", trackingRemoteRef); }} />,
              ],
            ])}
          </ContextMenuSubmenu>
        );
      };

      /**
       * 渲染日志 refs 中单个分支的层级子菜单，按本地/远端场景收口可见项。
       */
      const renderLogBranchRefSubmenu = (
        ref: { kind: "local" | "remote"; name: string },
        nested: boolean,
      ): JSX.Element | null => {
        const refName = String(ref.name || "").trim();
        if (!refName) return null;
        const isLocal = ref.kind === "local" && localBranchByName.has(refName);
        const isRemote = ref.kind === "remote";
        const remoteParsed = isRemote ? parseRemoteBranchRefName(refName, knownRemoteNames) : null;
        const remoteName = String(remoteParsed?.remote || "").trim();
        if (isRemote && (!remoteParsed || remoteParsed.branch === "HEAD")) return null;
        const isCurrentBranchTarget = isLocal && refName === String(repoBranch || "").trim();
        const checkedOutInOtherWorktree = isLocal
          ? (worktreeItems.find((item) => {
              const branch = String(item.branch || "").trim();
              if (!branch || branch !== refName) return false;
              return normalizePathForCompare(String(item.path || "")) !== currentWorktreePath;
            }) || null)
          : null;
        const branchCheckedOutInOtherWorktreePath = checkedOutInOtherWorktree ? String(checkedOutInOtherWorktree.path || "").trim() : "";
        const canCheckout = !isCurrentBranchTarget && !branchCheckedOutInOtherWorktreePath;
        const canCurrentBranchBasedOperation = hasCurrentBranch && !isCurrentBranchTarget;
        const trackingRemoteRef = isLocal ? String(localBranchByName.get(refName)?.upstream || "").trim() : "";
        const trackingRemoteParsed = parseRemoteBranchRefName(trackingRemoteRef, knownRemoteNames);
        const hasTrackingRemote = !!trackingRemoteParsed && trackingRemoteParsed.branch !== "HEAD";
        const canUpdateSelectedBranch = isLocal && hasTrackingRemote;
        const canCheckoutUpdate = isLocal && canCheckout && canUpdateSelectedBranch;
        const canUpdate = canUpdateSelectedBranch && !branchCheckedOutInOtherWorktreePath;
        const canPullTrackingRemote = hasTrackingRemote && hasCurrentBranch;
        const submenuLabel = nested ? refName : gt("workbench.branches.context.branchSubmenu", "分支 '{{branch}}'", { branch: refName });
        const sections: Array<Array<React.ReactNode | null | false>> = [
          [
            !isCurrentBranchTarget ? (
              <ContextMenuItem
                key="checkout"
                label={gt("workbench.branches.context.checkout", "签出")}
                disabled={!canCheckout}
                title={branchCheckedOutInOtherWorktreePath ? gt("workbench.branches.context.checkedOutInOtherWorktree", "已在其他 Worktree 签出：{{path}}", { path: branchCheckedOutInOtherWorktreePath }) : undefined}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("checkout", refName); }}
              />
            ) : null,
            isLocal ? (
              <ContextMenuItem
                key="openExistingWorktree"
                label={gt("workbench.branches.context.openInCheckedOutWorktree", "在已签出的工作树中打开")}
                disabled={!branchCheckedOutInOtherWorktreePath}
                title={branchCheckedOutInOtherWorktreePath ? undefined : gt("workbench.branches.context.notCheckedOutInOtherWorktree", "该分支未在其他工作树签出")}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("openExistingWorktree", refName); }}
              />
            ) : null,
            isLocal && !isCurrentBranchTarget ? (
              <ContextMenuItem
                key="checkoutUpdate"
                label={gt("workbench.branches.context.checkoutAndUpdate", "签出并更新")}
                disabled={!canCheckoutUpdate}
                title={!canUpdateSelectedBranch ? gt("workbench.branches.context.noTrackingUpstream", "该分支未配置跟踪上游") : (branchCheckedOutInOtherWorktreePath ? gt("workbench.branches.context.checkedOutInOtherWorktree", "已在其他 Worktree 签出：{{path}}", { path: branchCheckedOutInOtherWorktreePath }) : undefined)}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("checkoutUpdate", refName); }}
              />
            ) : null,
            <ContextMenuItem key="newFrom" label={gt("workbench.branches.context.newBranchFrom", "从 '{{target}}' 新建分支...", { target: refName })} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("newFrom", refName); }} />,
            !isCurrentBranchTarget ? (
              <ContextMenuItem
                key="checkoutRebaseCurrent"
                label={gt("workbench.branches.context.checkoutAndRebaseToCurrent", "签出并变基到 '{{branch}}'", { branch: currentBranchLabel })}
                disabled={!hasCurrentBranch}
                title={hasCurrentBranch ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("checkoutRebaseCurrent", refName); }}
              />
            ) : null,
          ],
          [
            !isCurrentBranchTarget ? (
              <ContextMenuItem
                key="compareCurrent"
                label={gt("workbench.branches.context.compareWithCurrent", "与 '{{branch}}' 比较", { branch: currentBranchLabel })}
                disabled={!hasCurrentBranch}
                title={hasCurrentBranch ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("compareCurrent", refName); }}
              />
            ) : null,
            <ContextMenuItem key="compareAny" label={gt("workbench.branches.context.compareCommitsWithAnyBranch", "与任意分支比较提交...")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("compareAny", refName); }} />,
            <ContextMenuItem key="worktreeDiff" label={gt("workbench.branches.context.showWorktreeDiff", "显示与工作树的差异")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("worktreeDiff", refName); }} />,
            <ContextMenuItem key="compareAnyFiles" label={gt("workbench.branches.context.compareFilesWithAnyBranch", "与任意分支比较文件...")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("compareAnyFiles", refName); }} />,
          ],
          [
            !isCurrentBranchTarget ? (
              <ContextMenuItem
                key="rebaseCurrentToTarget"
                label={gt("workbench.branches.context.rebaseCurrentToTarget", "将 '{{branch}}' 变基到 '{{target}}'", { branch: currentBranchLabel, target: refName })}
                disabled={!hasCurrentBranch}
                title={hasCurrentBranch ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("rebaseCurrentToTarget", refName); }}
              />
            ) : null,
            !isCurrentBranchTarget ? (
              <ContextMenuItem
                key="mergeTargetToCurrent"
                label={gt("workbench.branches.context.mergeTargetToCurrent", "将 '{{target}}' 合并到 '{{branch}}' 中", { target: refName, branch: currentBranchLabel })}
                disabled={!hasCurrentBranch}
                title={hasCurrentBranch ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("mergeTargetToCurrent", refName); }}
              />
            ) : null,
            <ContextMenuItem key="createWorktree" label={gt("workbench.branches.context.createWorktree", "创建新工作树...")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("createWorktree", refName); }} />,
          ],
          [
            isLocal ? (
              <ContextMenuItem
                key="update"
                label={gt("workbench.branches.context.update", "更新")}
                disabled={!canUpdate}
                title={!canUpdateSelectedBranch ? gt("workbench.branches.context.noTrackingUpstream", "该分支未配置跟踪上游") : (branchCheckedOutInOtherWorktreePath ? gt("workbench.branches.context.checkedOutInOtherWorktree", "已在其他 Worktree 签出：{{path}}", { path: branchCheckedOutInOtherWorktreePath }) : undefined)}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("update", refName); }}
              />
            ) : null,
            isLocal ? (
              <ContextMenuItem key="push" label={gt("workbench.branches.context.pushWithEllipsis", "推送...")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("push", refName); }} />
            ) : null,
            isRemote ? (
              <ContextMenuItem
                key="pullRemoteRebase"
                label={gt("workbench.branches.context.pullRemoteRebase", "将 '{{branch}}' 与该远端分支变基拉取", { branch: currentBranchLabel })}
                disabled={!hasCurrentBranch}
                title={hasCurrentBranch ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("pullRemoteRebase", refName); }}
              />
            ) : null,
            isLocal && hasTrackingRemote ? renderLogTrackedBranchSubmenu(trackingRemoteRef, hasCurrentBranch, canPullTrackingRemote) : null,
            isRemote ? (
              <ContextMenuItem
                key="pullRemoteMerge"
                label={gt("workbench.branches.context.pullRemoteMerge", "将 '{{branch}}' 与该远端分支合并拉取", { branch: currentBranchLabel })}
                disabled={!hasCurrentBranch}
                title={hasCurrentBranch ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("pullRemoteMerge", refName); }}
              />
            ) : null,
          ],
          [
            isLocal ? (
            <ContextMenuItem key="rename" label={gt("workbench.branches.context.renameWithEllipsis", "重命名...")} shortcut="Ctrl+R, R" onClick={() => { setMenu(null); void runLogRefMenuActionAsync("rename", refName); }} />
            ) : null,
            isLocal && !isCurrentBranchTarget ? (
              <ContextMenuItem key="delete" label={gt("workbench.branches.context.delete", "删除(D)")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("delete", refName); }} />
            ) : null,
            isRemote ? (
              <ContextMenuItem key="deleteRemote" label={gt("workbench.branches.context.delete", "删除(D)")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("deleteRemote", refName); }} />
            ) : null,
            isRemote ? (
              <ContextMenuItem
                key="editRemote"
                label={gt("workbench.branches.context.editRemote", "编辑远端 '{{remote}}'...", { remote: remoteName })}
                disabled={!remoteName}
                onClick={() => { setMenu(null); if (!remoteName) return; void runLogRefMenuActionAsync("editRemote", remoteName); }}
              />
            ) : null,
            isRemote ? (
              <ContextMenuItem
                key="removeRemote"
                label={gt("workbench.branches.context.removeRemote", "移除远端 '{{remote}}'", { remote: remoteName })}
                disabled={!remoteName}
                onClick={() => { setMenu(null); if (!remoteName) return; void runLogRefMenuActionAsync("removeRemote", remoteName); }}
              />
            ) : null,
            isRemote ? (
              <ContextMenuItem key="configureRemotes" label={gt("workbench.branches.context.configureRemotes", "配置远端...")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("configureRemotes", refName); }} />
            ) : null,
          ],
        ];
        if (!sections.some((section) => section.some(Boolean))) return null;
        return (
          <ContextMenuSubmenu key={`log-ref-branch-${ref.kind}-${refName}`} label={submenuLabel}>
            {renderContextMenuSections(sections)}
          </ContextMenuSubmenu>
        );
      };

      /**
       * 渲染日志 refs 中单个标签的层级子菜单，补齐签出/显示差异/推送标签等语义。
       */
      const renderLogTagRefSubmenu = (refName: string, nested: boolean): JSX.Element | null => {
        const cleanName = String(refName || "").trim();
        if (!cleanName) return null;
        const isCurrentTagTarget = repoDetached && isHeadCommit && cleanName === String(repoBranch || "").trim();
        const submenuLabel = nested ? cleanName : gt("workbench.branches.panel.menu.tags", "标签 '{{name}}'", { name: cleanName });
        const sections: Array<Array<React.ReactNode | null | false>> = [
          [
            !isCurrentTagTarget ? (
              <ContextMenuItem key="checkout" label={gt("workbench.branches.context.checkout", "签出")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("checkout", cleanName); }} />
            ) : null,
          ],
          [
            <ContextMenuItem key="worktreeDiff" label={gt("workbench.branches.context.showWorktreeDiff", "显示与工作树的差异")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("worktreeDiff", cleanName); }} />,
            !isCurrentTagTarget ? (
              <ContextMenuItem
                key="mergeTargetToCurrent"
                label={gt("workbench.branches.context.mergeTargetToCurrent", "将 '{{target}}' 合并到 '{{branch}}' 中", { target: cleanName, branch: currentBranchLabel })}
                disabled={!hasCurrentBranch}
                title={hasCurrentBranch ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")}
                onClick={() => { setMenu(null); void runLogRefMenuActionAsync("mergeTargetToCurrent", cleanName); }}
              />
            ) : null,
          ],
          [
            <ContextMenuItem key="pushTag" label={gt("workbench.misc.push.pushTagsTo", "推送标签到...")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("pushTag", cleanName); }} />,
            !isCurrentTagTarget ? (
              <ContextMenuItem key="deleteTag" label={gt("workbench.misc.push.deleteTag", "删除标签")} onClick={() => { setMenu(null); void runLogRefMenuActionAsync("deleteTag", cleanName); }} />
            ) : null,
          ],
        ];
        if (!sections.some((section) => section.some(Boolean))) return null;
        return (
          <ContextMenuSubmenu key={`log-ref-tag-${cleanName}`} label={submenuLabel}>
            {renderContextMenuSections(sections)}
          </ContextMenuSubmenu>
        );
      };

      const branchRefSubmenus = visibleBranchRefs
        .map((ref) => renderLogBranchRefSubmenu(ref, visibleBranchRefs.length > LOG_BRANCH_GROUP_MAX_VISIBLE))
        .filter((node): node is JSX.Element => !!node);
      const tagRefSubmenus = visibleTagRefs
        .map((ref) => renderLogTagRefSubmenu(ref.name, visibleTagRefs.length > LOG_TAG_GROUP_MAX_VISIBLE))
        .filter((node): node is JSX.Element => !!node);
      return (
        <ContextMenu menu={menu} onClose={() => setMenu(null)}>
          <ContextMenuItem label={gt("details.actions.copyRevision", "复制修订号")} shortcut="Ctrl+Alt+Shift+C" disabled={!copyRevisionAction.enabled} title={copyRevisionAction.reason} onClick={async () => {
            setMenu(null);
            const text = buildSelectedRevisionText();
            if (!text) return;
            await window.host.utils.copyText(text);
          }} />
          <ContextMenuItem label={gt("details.actions.createPatch", "创建补丁...")} disabled={!createPatchAction.enabled} title={createPatchAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("createPatch"); }} />
          <ContextMenuItem label={gt("details.actions.applySelectedChanges", "优选所选更改")} disabled={!cherryPickAction.enabled} title={cherryPickAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("cherryPick"); }} />
          <div className="my-1 h-px bg-[var(--cf-border)]"></div>
          {logCheckoutMenu.useSubmenu ? (
            <ContextMenuSubmenu label={gt("workbench.branches.context.checkout", "签出")}>
              {renderContextMenuSections([[
                ...logCheckoutMenu.checkoutBranchNames.map((name) => (
                  <ContextMenuItem
                    key={`checkout-branch:${name}`}
                    label={name}
                    onClick={() => { setMenu(null); void runLogRefMenuActionAsync("checkout", name); }}
                  />
                )),
                <ContextMenuItem
                  key="checkoutRevision"
                  label={gt("details.actions.checkoutRevision", "签出修订")}
                  disabled={!checkoutAction.enabled}
                  title={checkoutAction.reason}
                  onClick={() => { setMenu(null); void runLogMenuActionAsync("checkoutRevision"); }}
                />,
              ]])}
            </ContextMenuSubmenu>
          ) : (
            <ContextMenuItem label={gt("details.actions.checkoutRevision", "签出修订")} disabled={!checkoutAction.enabled} title={checkoutAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("checkoutRevision"); }} />
          )}
          <ContextMenuItem label={gt("details.actions.showRepoAtRevision", "在修订版中显示仓库")} disabled={!showRepoAction.enabled} title={showRepoAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("showRepoAtRevision"); }} />
          <ContextMenuItem label={gt("details.actions.compareLocal", "与本地比较")} disabled={!compareLocalAction.enabled} title={compareLocalAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("compareLocal"); }} />
          <div className="my-1 h-px bg-[var(--cf-border)]"></div>
          <ContextMenuItem label={gt("details.actions.resetCurrentBranchToHere", "将当前分支重置到此处...")} disabled={!resetAction.enabled} title={resetAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("reset"); }} />
          <ContextMenuItem label={gt("details.actions.revertCommit", "还原提交")} disabled={!revertAction.enabled} title={revertAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("revert"); }} />
          <ContextMenuItem label={gt("actionDialogs.undoCommit.title", "撤销提交...")} disabled={!undoCommitAction.enabled} title={undoCommitAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("undoCommit"); }} />
          <ContextMenuItem label={gt("actionDialogs.editCommitMessage.title", "编辑提交信息...")} shortcut="Ctrl+R, R" disabled={!editMessageAction.enabled} title={editMessageAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("editMessage"); }} />
          <ContextMenuItem label={gt("interactiveRebase.actions.fixup", "Fixup...")} disabled={!fixupAction.enabled} title={fixupAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("fixup"); }} />
          <ContextMenuItem label={gt("details.actions.squashTo", "压缩到...")} disabled={!squashToAction.enabled} title={squashToAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("squashTo"); }} />
          <ContextMenuItem label={gt("actionDialogs.deleteCommit.title", "删除提交")} disabled={!deleteCommitAction.enabled} title={deleteCommitAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("deleteCommit"); }} />
          {selectedCommitHashes.length > 1 ? (
            <ContextMenuItem label={gt("interactiveRebase.actions.squash", "压缩提交...")} disabled={!squashCommitsAction.enabled} title={squashCommitsAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("squashCommits"); }} />
          ) : null}
          <ContextMenuItem label={gt("interactiveRebase.title", "从这里进行交互式变基...")} disabled={!interactiveRebaseAction.enabled} title={interactiveRebaseAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("interactiveRebase"); }} />
          <ContextMenuItem label={pushActionLabel} shortcut={pushActionShortcut} disabled={!pushAllPreviousAction.enabled} title={pushAllPreviousAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("pushAllPrevious"); }} />
          {branchRefSubmenus.length > 0 || tagRefSubmenus.length > 0 ? <div className="my-1 h-px bg-[var(--cf-border)]"></div> : null}
          {renderContextMenuSections([
            branchRefSubmenus.length > LOG_BRANCH_GROUP_MAX_VISIBLE
              ? [(
                <ContextMenuSubmenu key="log-ref-branches" label={gt("workbench.branches.panel.title", "分支")}>
                  {renderContextMenuSections(branchRefSubmenus.map((node) => [node]))}
                </ContextMenuSubmenu>
              )]
              : branchRefSubmenus,
            tagRefSubmenus.length > LOG_TAG_GROUP_MAX_VISIBLE
              ? [(
                <ContextMenuSubmenu key="log-ref-tags" label={gt("workbench.branches.panel.menu.tags", "标签")}>
                  {renderContextMenuSections(tagRefSubmenus.map((node) => [node]))}
                </ContextMenuSubmenu>
              )]
              : tagRefSubmenus,
          ])}
          {branchRefSubmenus.length > 0 || tagRefSubmenus.length > 0 ? <div className="my-1 h-px bg-[var(--cf-border)]"></div> : null}
          <ContextMenuItem label={gt("workbench.branches.panel.menu.newBranch", "新建分支...")} shortcut="Ctrl+Alt+N" disabled={!newBranchAction.enabled} title={newBranchAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("newBranch"); }} />
          <ContextMenuItem label={gt("workbench.branches.panel.menu.newTag", "新建标签...")} disabled={!newTagAction.enabled} title={newTagAction.reason} onClick={() => { setMenu(null); void runLogMenuActionAsync("newTag"); }} />
          <ContextMenuItem label={gt("details.actions.gotoChild", "Go to Child Commit")} shortcut="Left Arrow" disabled={!canGotoChild} onClick={() => { setMenu(null); void runLogMenuActionAsync("gotoChild"); }} />
          <ContextMenuItem label={gt("details.actions.gotoParent", "Go to Parent Commit")} shortcut="Right Arrow" disabled={!canGotoParent} onClick={() => { setMenu(null); void runLogMenuActionAsync("gotoParent"); }} />
        </ContextMenu>
      );
    }

    if (menu.type === "detail") {
      const targetPath = menu.target || selectedDetailPrimaryPath || selectedDetailPaths[0] || "";
      const targetIsFile = menu.targetKind !== "folder";
      const targetFiles = resolveDetailMenuFileTargets(targetPath);
      const detailHashResolution = resolveDetailSelectionHashResolution(targetFiles);
      const targetCommitHashSet = new Set(detailHashResolution.uniqueHashes);
      const orderedTargetCommitHashes = orderedSelectedCommitHashesOldestFirst.filter((one) => targetCommitHashSet.has(one));
      const targetCommitHashes = orderedTargetCommitHashes.length > 0 ? orderedTargetCommitHashes : detailHashResolution.uniqueHashes;
      const targetHash = details?.mode === "single"
        ? details.detail.hash
        : (targetCommitHashes[targetCommitHashes.length - 1] || orderedSelectedCommitHashesNewestFirst[0] || "");
      const detailEditSourceAction = getCommitDetailsActionItem(detailActionAvailability, "editSource");
      const detailOpenRepositoryVersionAction = getCommitDetailsActionItem(detailActionAvailability, "openRepositoryVersion");
      const detailRevertSelectedChangesAction = getCommitDetailsActionItem(detailActionAvailability, "revertSelectedChanges");
      const detailApplySelectedChangesAction = getCommitDetailsActionItem(detailActionAvailability, "applySelectedChanges");
      const detailExtractAction = getCommitDetailsActionItem(detailActionAvailability, "extractSelectedChanges");
      const detailDropAction = getCommitDetailsActionItem(detailActionAvailability, "dropSelectedChanges");
      const detailContextMenuGroups = buildCommitDetailsContextMenuGroups(detailActionAvailability);
      const disabled = !targetPath;
      const targetNodeKey = detailNodeKeyByPath.get(targetPath) || "";
      const expanded = targetNodeKey ? detailTreeExpanded[targetNodeKey] !== false : false;
      const noFiles = targetFiles.length === 0;
      const canSingleFileAction = targetFiles.length === 1;
      const singleHashContext = targetCommitHashes.length === 1;
      const isMultiCommitContext = !singleHashContext;
      const compareRevisionsContext = targetCommitHashes.length === 2;
      const allPathsHaveSingleHash = detailHashResolution.allPathsHaveSingleHash;
      const canShowRevisionHistory = targetIsFile && canSingleFileAction && singleHashContext && !!targetHash;
      /**
       * 渲染单个提交详情菜单动作，保持 committed changes 菜单顺序和危险动作语义与 IDEA 一致。
       */
      const renderDetailContextMenuAction = (actionKey: ReturnType<typeof buildCommitDetailsContextMenuGroups>[number][number]): JSX.Element | null => {
        if (actionKey === "showDiff") {
          return (
            <ContextMenuItem
              key="showDiff"
              label={gt("details.actions.showDiff", "显示差异")}
              shortcut="Ctrl+D"
              disabled={noFiles || !targetHash}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("showDiff", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "compareRevisions") {
          return (
            <ContextMenuItem
              key="compareRevisions"
              label={gt("details.actions.compareRevisions", "比较版本")}
              disabled={noFiles || !compareRevisionsContext}
              title={!noFiles && !compareRevisionsContext ? gt("details.actions.compareRevisionsTwoCommits", "仅支持恰好两个提交的版本比较") : undefined}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("compareRevisions", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "compareLocal") {
          return (
            <ContextMenuItem
              key="compareLocal"
              label={gt("details.actions.compareLocal", "与本地比较")}
              disabled={noFiles || !singleHashContext}
              title={!noFiles && !singleHashContext ? gitWorkbenchText("details.actions.multiCommitUnsupported", "多选提交聚合详情暂不支持") : undefined}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("compareLocal", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "comparePreviousLocal") {
          return (
            <ContextMenuItem
              key="comparePreviousLocal"
              label={gt("details.actions.comparePreviousLocal", "将之前版本与本地版本进行比较")}
              disabled={noFiles || !repoRoot || !singleHashContext}
              title={!noFiles && !singleHashContext ? gitWorkbenchText("details.actions.multiCommitUnsupported", "多选提交聚合详情暂不支持") : undefined}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("comparePreviousLocal", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "editSource") {
          return (
            <ContextMenuItem
              key="editSource"
              label={gt("details.actions.editSource", "编辑源")}
              shortcut="F4"
              disabled={!detailEditSourceAction.enabled}
              title={detailEditSourceAction.reason}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("editSource", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "openRepositoryVersion") {
          return (
            <ContextMenuItem
              key="openRepositoryVersion"
              label={gt("details.actions.openRepositoryVersion", "打开仓库版本")}
              disabled={!detailOpenRepositoryVersionAction.enabled || !allPathsHaveSingleHash}
              title={!allPathsHaveSingleHash
                ? gt("details.actions.selectionMustResolveToSingleCommit", "当前选择中的文件必须各自唯一映射到一个提交")
                : detailOpenRepositoryVersionAction.reason}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("openRepositoryVersion", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "revertSelectedChanges") {
          return (
            <ContextMenuItem
              key="revertSelectedChanges"
              label={gt("details.actions.revertSelectedChanges", "还原所选更改")}
              disabled={!detailRevertSelectedChangesAction.enabled || isMultiCommitContext}
              title={isMultiCommitContext ? gitWorkbenchText("details.actions.multiCommitUnsupported", "多选提交聚合详情暂不支持") : detailRevertSelectedChangesAction.reason}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("revertSelectedChanges", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "applySelectedChanges") {
          return (
            <ContextMenuItem
              key="applySelectedChanges"
              label={gt("details.actions.applySelectedChanges", "优选所选更改")}
              disabled={!detailApplySelectedChangesAction.enabled || isMultiCommitContext}
              title={isMultiCommitContext ? gitWorkbenchText("details.actions.multiCommitUnsupported", "多选提交聚合详情暂不支持") : detailApplySelectedChangesAction.reason}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("applySelectedChanges", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "extractSelectedChanges") {
          return (
            <ContextMenuItem
              key="extractSelectedChanges"
              label={gt("details.actions.extractSelectedChanges", "将所选更改提取到单独的提交...")}
              disabled={!detailExtractAction.enabled}
              title={detailExtractAction.reason}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("extractSelectedChanges", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "dropSelectedChanges") {
          return (
            <ContextMenuItem
              key="dropSelectedChanges"
              label={gt("details.actions.dropSelectedChanges", "删除所选更改")}
              tone="danger"
              disabled={!detailDropAction.enabled}
              title={detailDropAction.reason}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("dropSelectedChanges", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "createPatch") {
          return (
            <ContextMenuItem
              key="createPatch"
              label={gt("details.actions.createPatch", "创建补丁...")}
              disabled={noFiles}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("createPatch", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "restoreFromRevision") {
          return (
            <ContextMenuItem
              key="restoreFromRevision"
              label={gt("details.actions.restoreFromRevision", "从修订中获取")}
              disabled={noFiles || !allPathsHaveSingleHash}
              title={!noFiles && !allPathsHaveSingleHash
                ? gt("details.actions.selectionMustResolveToSingleCommit", "当前选择中的文件必须各自唯一映射到一个提交")
                : undefined}
              onClick={() => {
                setMenu(null);
                if (!targetPath) return;
                void runDetailMenuActionAsync("restoreFromRevision", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "pathHistory") {
          return (
            <ContextMenuItem
              key="pathHistory"
              label={gt("details.actions.pathHistory", "迄今为止的历史记录")}
              disabled={!canShowRevisionHistory}
              title={!canShowRevisionHistory
                ? (targetCommitHashes.length > 1
                  ? gitWorkbenchText("details.actions.multiCommitUnsupported", "多选提交聚合详情暂不支持")
                  : gitWorkbenchText("details.actions.singleCommitFileOnly", "仅支持单提交详情中的单个文件"))
                : undefined}
              onClick={() => {
                setMenu(null);
                void runDetailMenuActionAsync("pathHistory", targetPath, targetHash, targetFiles, targetCommitHashes);
              }}
            />
          );
        }
        if (actionKey === "toggleParentChanges") {
          return (
            <ContextMenuItem
              key="toggleParentChanges"
              label={gt("details.actions.toggleParentChanges", "显示对父项的更改")}
              checked={showParentChanges}
              onClick={() => {
                setMenu(null);
                setShowParentChanges((prev) => !prev);
              }}
            />
          );
        }
        return null;
      };
      return (
        <ContextMenu menu={menu} onClose={() => setMenu(null)}>
          {!targetIsFile ? (
            <>
              <ContextMenuItem label={expanded ? gt("workbench.details.context.collapse", "折叠") : gt("workbench.details.context.expand", "展开")} disabled={disabled} onClick={() => {
                setMenu(null);
                if (!targetNodeKey) return;
                setDetailTreeExpanded((prev) => ({ ...prev, [targetNodeKey]: !expanded }));
              }} />
              <ContextMenuItem label={gt("workbench.details.context.copyPath", "复制路径")} disabled={disabled} onClick={async () => {
                setMenu(null);
                if (!targetPath) return;
                await window.host.utils.copyText(targetPath);
              }} />
              <div className="my-1 h-px bg-[var(--cf-border)]"></div>
            </>
          ) : null}
          {detailContextMenuGroups.map((group, groupIndex) => (
            <React.Fragment key={`detail-menu-group:${groupIndex}`}>
              {group.map((actionKey) => renderDetailContextMenuAction(actionKey))}
              {groupIndex < detailContextMenuGroups.length - 1 ? <div className="my-1 h-px bg-[var(--cf-border)]"></div> : null}
            </React.Fragment>
          ))}
        </ContextMenu>
      );
    }

    const target = menu.target || "";
    const menuBranchRepository = selectedBranchRepository;
    const menuBranchRepoRoot = String(menuBranchRepository?.repoRoot || branchSelectedRepoRoot || repoRoot || "").trim();
    const menuCurrentBranch = String(menuBranchRepository?.currentBranch || repoBranch || "").trim();
    const menuRepoDetached = menuBranchRepository?.detached ?? repoDetached;
    const menuKnownRemoteNames = selectedBranchKnownRemoteNames.length > 0 ? selectedBranchKnownRemoteNames : knownRemoteNames;
    const localBranchByName = new Map((menuBranchRepository?.groups?.local || []).map((item) => [item.name, item] as const));
    const remoteBranchByName = new Map((menuBranchRepository?.groups?.remote || []).map((item) => [item.name, item] as const));
    const isLocalBranchTarget = localBranchByName.has(target);
    const isRemoteBranchTarget = remoteBranchByName.has(target);
    const isBranchTarget = isLocalBranchTarget || isRemoteBranchTarget;
    const isCurrentBranchTarget = isLocalBranchTarget && !!target && target === menuCurrentBranch;
    const canLocalBranchOperation = !!target && isLocalBranchTarget;
    const currentBranchLabel = menuCurrentBranch || gt("workbench.branches.context.currentBranch", "当前分支");
    const normalizePathForCompare = (value: string): string => String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const currentWorktreePath = normalizePathForCompare(menuBranchRepoRoot);
    const checkedOutInOtherWorktree = canLocalBranchOperation
      ? (worktreeItems.find((item) => {
          const branch = String(item.branch || "").trim();
          if (!branch || branch !== target) return false;
          return normalizePathForCompare(String(item.path || "")) !== currentWorktreePath;
        }) || null)
      : null;
    const branchCheckedOutInOtherWorktreePath = checkedOutInOtherWorktree ? String(checkedOutInOtherWorktree.path || "").trim() : "";
    const hasCurrentBranch = !menuRepoDetached && !!menuCurrentBranch;
    const canCurrentBranchBasedOperation = isBranchTarget && hasCurrentBranch;
    const canSelectedBranchBasedOperation = canCurrentBranchBasedOperation && !isCurrentBranchTarget;
    const selectedBranchOperationDisabledReason = !hasCurrentBranch
      ? gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")
      : (isCurrentBranchTarget ? gt("workbench.branches.context.currentBranchUnsupported", "当前分支不支持该操作") : undefined);
    const canCheckoutBranch = !!target && isBranchTarget && !isCurrentBranchTarget && !branchCheckedOutInOtherWorktreePath;
    const canDeleteBranch = canLocalBranchOperation && !isCurrentBranchTarget;
    const remoteParsed = parseRemoteBranchRefName(target, menuKnownRemoteNames);
    const canPullRemoteBranch = isRemoteBranchTarget && !!remoteParsed && remoteParsed.branch !== "HEAD" && hasCurrentBranch;
    const canDeleteRemoteBranch = isRemoteBranchTarget && !!remoteParsed && remoteParsed.branch !== "HEAD";
    const trackingRemoteRef = isLocalBranchTarget ? String(localBranchByName.get(target)?.upstream || "").trim() : "";
    const trackingRemoteParsed = parseRemoteBranchRefName(trackingRemoteRef, menuKnownRemoteNames);
    const hasTrackingRemote = !!trackingRemoteParsed && trackingRemoteParsed.branch !== "HEAD";
    const canUpdateSelectedBranch = canLocalBranchOperation && hasTrackingRemote;
    const canCheckoutUpdate = canLocalBranchOperation && canCheckoutBranch && canUpdateSelectedBranch;
    const canUpdateBranch = canUpdateSelectedBranch && !branchCheckedOutInOtherWorktreePath;
    const canPullTrackingRemoteBranch = hasTrackingRemote && hasCurrentBranch;
    return (
      <ContextMenu menu={menu} onClose={() => setMenu(null)}>
        <ContextMenuItem label={gt("workbench.branches.context.checkout", "签出")} disabled={!canCheckoutBranch} title={!target ? gt("workbench.branches.context.missingTarget", "缺少目标分支") : (isCurrentBranchTarget ? gt("workbench.branches.context.alreadyCurrent", "已在当前分支") : (branchCheckedOutInOtherWorktreePath ? gt("workbench.branches.context.checkedOutInOtherWorktree", "已在其他 Worktree 签出：{{path}}", { path: branchCheckedOutInOtherWorktreePath }) : undefined))} onClick={() => { setMenu(null); void runBranchTreeActionAsync("checkout", target); }} />
        {isLocalBranchTarget ? (
          <ContextMenuItem label={gt("workbench.branches.context.openInCheckedOutWorktree", "在已签出的工作树中打开")} disabled={!branchCheckedOutInOtherWorktreePath} title={branchCheckedOutInOtherWorktreePath ? undefined : gt("workbench.branches.context.notCheckedOutInOtherWorktree", "该分支未在其他工作树签出")} onClick={() => { setMenu(null); void runBranchTreeActionAsync("openExistingWorktree", target); }} />
        ) : null}
        {isLocalBranchTarget ? (
          <ContextMenuItem label={gt("workbench.branches.context.checkoutAndUpdate", "签出并更新")} disabled={!canCheckoutUpdate} title={isCurrentBranchTarget ? gt("workbench.branches.context.alreadyCurrent", "已在当前分支") : (!canUpdateSelectedBranch ? gt("workbench.branches.context.noTrackingUpstream", "该分支未配置跟踪上游") : (branchCheckedOutInOtherWorktreePath ? gt("workbench.branches.context.checkedOutInOtherWorktree", "已在其他 Worktree 签出：{{path}}", { path: branchCheckedOutInOtherWorktreePath }) : undefined))} onClick={() => { setMenu(null); void runBranchTreeActionAsync("checkoutUpdate", target); }} />
        ) : null}
        <ContextMenuItem label={gt("workbench.branches.context.newBranchFrom", "从 '{{target}}' 新建分支...", { target: target || gt("workbench.branches.context.currentBranch", "当前分支") })} disabled={!target || !isBranchTarget} onClick={() => { setMenu(null); void runBranchTreeActionAsync("newFrom", target); }} />
        <ContextMenuItem label={gt("workbench.branches.context.checkoutAndRebaseToCurrent", "签出并变基到 '{{branch}}'", { branch: currentBranchLabel })} disabled={!canSelectedBranchBasedOperation} title={canSelectedBranchBasedOperation ? undefined : selectedBranchOperationDisabledReason} onClick={() => { setMenu(null); void runBranchTreeActionAsync("checkoutRebaseCurrent", target); }} />
        <div className="my-1 h-px bg-[var(--cf-border)]"></div>
        <ContextMenuItem label={gt("workbench.branches.context.compareWithCurrent", "与 '{{branch}}' 比较", { branch: currentBranchLabel })} disabled={!canSelectedBranchBasedOperation} title={canSelectedBranchBasedOperation ? undefined : selectedBranchOperationDisabledReason} onClick={() => { setMenu(null); void runBranchTreeActionAsync("compareCurrent", target); }} />
        <ContextMenuItem label={gt("workbench.branches.context.compareCommitsWithAnyBranch", "与任意分支比较提交...")} disabled={!isBranchTarget} title={!isBranchTarget ? gt("workbench.branches.context.missingTarget", "缺少目标分支") : undefined} onClick={() => { setMenu(null); void runBranchTreeActionAsync("compareAny", target); }} />
        <ContextMenuItem label={gt("workbench.branches.context.showWorktreeDiff", "显示与工作树的差异")} disabled={!isBranchTarget} title={!isBranchTarget ? gt("workbench.branches.context.missingTarget", "缺少目标分支") : undefined} onClick={() => { setMenu(null); void runBranchTreeActionAsync("worktreeDiff", target); }} />
        <ContextMenuItem label={gt("workbench.branches.context.compareFilesWithAnyBranch", "与任意分支比较文件...")} disabled={!isBranchTarget} title={!isBranchTarget ? gt("workbench.branches.context.missingTarget", "缺少目标分支") : undefined} onClick={() => { setMenu(null); void runBranchTreeActionAsync("compareAnyFiles", target); }} />
        <div className="my-1 h-px bg-[var(--cf-border)]"></div>
        <ContextMenuItem label={gt("workbench.branches.context.rebaseCurrentToTarget", "将 '{{branch}}' 变基到 '{{target}}'", { branch: currentBranchLabel, target: target || gt("workbench.branches.context.targetBranch", "目标分支") })} disabled={!canSelectedBranchBasedOperation} title={canSelectedBranchBasedOperation ? undefined : selectedBranchOperationDisabledReason} onClick={() => { setMenu(null); void runBranchTreeActionAsync("rebaseCurrentToTarget", target); }} />
        <ContextMenuItem label={gt("workbench.branches.context.mergeTargetToCurrent", "将 '{{target}}' 合并到 '{{branch}}' 中", { branch: currentBranchLabel, target: target || gt("workbench.branches.context.targetBranch", "目标分支") })} disabled={!canSelectedBranchBasedOperation} title={canSelectedBranchBasedOperation ? undefined : selectedBranchOperationDisabledReason} onClick={() => { setMenu(null); void runBranchTreeActionAsync("mergeTargetToCurrent", target); }} />
        <ContextMenuItem label={gt("workbench.branches.context.createWorktree", "创建新工作树...")} disabled={!target || !isBranchTarget} onClick={() => { setMenu(null); void runBranchTreeActionAsync("createWorktree", target); }} />
        {isRemoteBranchTarget ? (
          <>
            <ContextMenuItem label={gt("workbench.branches.context.pullRemoteRebase", "将 '{{branch}}' 与该远端分支变基拉取", { branch: currentBranchLabel })} disabled={!canPullRemoteBranch} title={!hasCurrentBranch ? gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持") : (!remoteParsed ? gt("workbench.branches.context.invalidRemoteBranch", "远端分支格式无效") : (remoteParsed.branch === "HEAD" ? gt("workbench.branches.context.unsupportedRef", "不支持该引用") : undefined))} onClick={() => { setMenu(null); void runBranchTreeActionAsync("pullRemoteRebase", target); }} />
            <ContextMenuItem label={gt("workbench.branches.context.pullRemoteMerge", "将 '{{branch}}' 与该远端分支合并拉取", { branch: currentBranchLabel })} disabled={!canPullRemoteBranch} title={!hasCurrentBranch ? gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持") : (!remoteParsed ? gt("workbench.branches.context.invalidRemoteBranch", "远端分支格式无效") : (remoteParsed.branch === "HEAD" ? gt("workbench.branches.context.unsupportedRef", "不支持该引用") : undefined))} onClick={() => { setMenu(null); void runBranchTreeActionAsync("pullRemoteMerge", target); }} />
          </>
        ) : null}
        <div className="my-1 h-px bg-[var(--cf-border)]"></div>
        {isLocalBranchTarget ? (
          <>
            <ContextMenuItem label={gt("workbench.branches.context.update", "更新")} disabled={!canUpdateBranch} title={!canUpdateSelectedBranch ? gt("workbench.branches.context.noTrackingUpstream", "该分支未配置跟踪上游") : (branchCheckedOutInOtherWorktreePath ? gt("workbench.branches.context.checkedOutInOtherWorktree", "已在其他 Worktree 签出：{{path}}", { path: branchCheckedOutInOtherWorktreePath }) : undefined)} onClick={() => { setMenu(null); void runBranchTreeActionAsync("update", target); }} />
            <ContextMenuItem label={gt("workbench.branches.context.pushWithEllipsis", "推送...")} disabled={!canLocalBranchOperation} title={!canLocalBranchOperation ? gt("workbench.branches.context.localBranchOnly", "仅支持本地分支") : undefined} onClick={() => { setMenu(null); void runBranchTreeActionAsync("push", target); }} />
            {hasTrackingRemote ? (
              <ContextMenuSubmenu label={gt("workbench.branches.context.trackingBranch", "跟踪分支 '{{branch}}'", { branch: trackingRemoteRef })}>
                {renderContextMenuSections([
                  [
                    <ContextMenuItem key="checkout" label={gt("workbench.branches.context.checkout", "签出")} disabled={!trackingRemoteRef} onClick={() => { setMenu(null); void runBranchTreeActionAsync("checkout", trackingRemoteRef); }} />,
                    <ContextMenuItem key="newFrom" label={gt("workbench.branches.context.newBranchFrom", "从 '{{target}}' 新建分支...", { target: trackingRemoteRef })} disabled={!trackingRemoteRef} onClick={() => { setMenu(null); void runBranchTreeActionAsync("newFrom", trackingRemoteRef); }} />,
                    <ContextMenuItem key="checkoutRebaseCurrent" label={gt("workbench.branches.context.checkoutAndRebaseToCurrent", "签出并变基到 '{{branch}}'", { branch: currentBranchLabel })} disabled={!canCurrentBranchBasedOperation} title={!canCurrentBranchBasedOperation ? gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持") : undefined} onClick={() => { setMenu(null); void runBranchTreeActionAsync("checkoutRebaseCurrent", trackingRemoteRef); }} />,
                  ],
                  [
                    <ContextMenuItem key="compareCurrent" label={gt("workbench.branches.context.compareWithCurrent", "与 '{{branch}}' 比较", { branch: currentBranchLabel })} disabled={!canCurrentBranchBasedOperation} title={!canCurrentBranchBasedOperation ? gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持") : undefined} onClick={() => { setMenu(null); void runBranchTreeActionAsync("compareCurrent", trackingRemoteRef); }} />,
                    <ContextMenuItem key="compareAny" label={gt("workbench.branches.context.compareCommitsWithAnyBranch", "与任意分支比较提交...")} disabled={!trackingRemoteRef} onClick={() => { setMenu(null); void runBranchTreeActionAsync("compareAny", trackingRemoteRef); }} />,
                    <ContextMenuItem key="worktreeDiff" label={gt("workbench.branches.context.showWorktreeDiff", "显示与工作树的差异")} disabled={!trackingRemoteRef} onClick={() => { setMenu(null); void runBranchTreeActionAsync("worktreeDiff", trackingRemoteRef); }} />,
                    <ContextMenuItem key="compareAnyFiles" label={gt("workbench.branches.context.compareFilesWithAnyBranch", "与任意分支比较文件...")} disabled={!trackingRemoteRef} onClick={() => { setMenu(null); void runBranchTreeActionAsync("compareAnyFiles", trackingRemoteRef); }} />,
                  ],
                  [
                    <ContextMenuItem key="rebaseCurrentToTarget" label={gt("workbench.branches.context.rebaseCurrentToTarget", "将 '{{branch}}' 变基到 '{{target}}'", { branch: currentBranchLabel, target: trackingRemoteRef })} disabled={!canCurrentBranchBasedOperation} title={!canCurrentBranchBasedOperation ? gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持") : undefined} onClick={() => { setMenu(null); void runBranchTreeActionAsync("rebaseCurrentToTarget", trackingRemoteRef); }} />,
                    <ContextMenuItem key="mergeTargetToCurrent" label={gt("workbench.branches.context.mergeTargetToCurrent", "将 '{{target}}' 合并到 '{{branch}}' 中", { branch: currentBranchLabel, target: trackingRemoteRef })} disabled={!canCurrentBranchBasedOperation} title={!canCurrentBranchBasedOperation ? gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持") : undefined} onClick={() => { setMenu(null); void runBranchTreeActionAsync("mergeTargetToCurrent", trackingRemoteRef); }} />,
                    <ContextMenuItem key="createWorktree" label={gt("workbench.branches.context.createWorktree", "创建新工作树...")} disabled={!trackingRemoteRef} onClick={() => { setMenu(null); void runBranchTreeActionAsync("createWorktree", trackingRemoteRef); }} />,
                  ],
                  [
                    <ContextMenuItem key="pullRemoteRebase" label={gt("workbench.branches.context.pullRemoteRebase", "将 '{{branch}}' 与该远端分支变基拉取", { branch: currentBranchLabel })} disabled={!canPullTrackingRemoteBranch} title={canPullTrackingRemoteBranch ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")} onClick={() => { setMenu(null); void runBranchTreeActionAsync("pullRemoteRebase", trackingRemoteRef); }} />,
                    <ContextMenuItem key="pullRemoteMerge" label={gt("workbench.branches.context.pullRemoteMerge", "将 '{{branch}}' 与该远端分支合并拉取", { branch: currentBranchLabel })} disabled={!canPullTrackingRemoteBranch} title={canPullTrackingRemoteBranch ? undefined : gt("workbench.branches.context.detachedHeadUnsupported", "游离 HEAD 状态下不支持")} onClick={() => { setMenu(null); void runBranchTreeActionAsync("pullRemoteMerge", trackingRemoteRef); }} />,
                    <ContextMenuItem key="deleteRemote" label={gt("workbench.branches.context.deleteTrackedRemoteBranch", "删除跟踪远端分支(D)")} disabled={!trackingRemoteRef} onClick={() => { setMenu(null); void runBranchTreeActionAsync("deleteRemote", trackingRemoteRef); }} />,
                    <ContextMenuItem key="editRemote" label={gt("workbench.branches.context.editRemote", "编辑远端 '{{remote}}'...", { remote: trackingRemoteParsed?.remote || "" })} disabled={!trackingRemoteParsed?.remote} onClick={() => { setMenu(null); if (!trackingRemoteParsed?.remote) return; void runBranchTreeActionAsync("editRemote", trackingRemoteParsed.remote); }} />,
                    <ContextMenuItem key="removeRemote" label={gt("workbench.branches.context.removeRemote", "移除远端 '{{remote}}'", { remote: trackingRemoteParsed?.remote || "" })} disabled={!trackingRemoteParsed?.remote} onClick={() => { setMenu(null); if (!trackingRemoteParsed?.remote) return; void runBranchTreeActionAsync("removeRemote", trackingRemoteParsed.remote); }} />,
                    <ContextMenuItem key="configureRemotes" label={gt("workbench.branches.context.configureRemotes", "配置远端...")} onClick={() => { setMenu(null); void runBranchTreeActionAsync("configureRemotes", trackingRemoteRef); }} />,
                  ],
                ])}
              </ContextMenuSubmenu>
            ) : null}
            <div className="my-1 h-px bg-[var(--cf-border)]"></div>
            <ContextMenuItem label={gt("workbench.branches.context.renameWithEllipsis", "重命名...")} shortcut="Ctrl+R, R" disabled={!canLocalBranchOperation} title={!canLocalBranchOperation ? gt("workbench.branches.context.localBranchOnly", "仅支持本地分支") : undefined} onClick={() => { setMenu(null); void runBranchTreeActionAsync("rename", target); }} />
            <ContextMenuItem label={gt("workbench.branches.context.delete", "删除(D)")} disabled={!canDeleteBranch} title={isCurrentBranchTarget ? gt("workbench.branches.context.currentBranchCannotDelete", "当前分支不支持删除") : undefined} onClick={() => { setMenu(null); void runBranchTreeActionAsync("delete", target); }} />
          </>
        ) : null}
        {isRemoteBranchTarget ? (
          <>
            <ContextMenuItem label={gt("workbench.branches.context.delete", "删除(D)")} disabled={!canDeleteRemoteBranch} title={!remoteParsed ? gt("workbench.branches.context.invalidRemoteBranch", "远端分支格式无效") : (remoteParsed.branch === "HEAD" ? gt("workbench.branches.context.remoteHeadCannotDelete", "不支持删除远端 HEAD 引用") : undefined)} onClick={() => { setMenu(null); void runBranchTreeActionAsync("deleteRemote", target); }} />
            <ContextMenuItem label={gt("workbench.branches.context.editRemote", "编辑远端 '{{remote}}'...", { remote: remoteParsed?.remote || "" })} disabled={!remoteParsed?.remote} onClick={() => { setMenu(null); if (!remoteParsed?.remote) return; void runBranchTreeActionAsync("editRemote", remoteParsed.remote); }} />
            <ContextMenuItem label={gt("workbench.branches.context.removeRemote", "移除远端 '{{remote}}'", { remote: remoteParsed?.remote || "" })} disabled={!remoteParsed?.remote} onClick={() => { setMenu(null); if (!remoteParsed?.remote) return; void runBranchTreeActionAsync("removeRemote", remoteParsed.remote); }} />
            <ContextMenuItem label={gt("workbench.branches.context.configureRemotes", "配置远端...")} onClick={() => { setMenu(null); void runBranchTreeActionAsync("configureRemotes", target); }} />
          </>
        ) : null}
        <ContextMenuItem label={gt("workbench.branches.context.gitWorktree", "Git Worktree ›")} onClick={() => { setMenu(null); showWorktreesTabByUser(); }} />
      </ContextMenu>
    );
  };

  /**
   * 渲染推送预览对话框，提供提交列表、文件列表与推送选项。
   */
  const renderPushDialog = (): JSX.Element | null => {
    if (!pushDialogOpen) return null;
    return (
      <Dialog open={pushDialogOpen} onOpenChange={(next) => {
        if (!next) {
          setPushDialogOpen(false);
          setPushForceMenuOpen(false);
        }
      }}>
        <DialogContent className="cf-git-dialog-panel w-[820px] max-w-[calc(100vw-4rem)] overflow-hidden p-0">
          <div className={`grid min-h-0 ${pushPreviewHasContent ? "h-[min(560px,calc(100vh-5rem))] grid-rows-[minmax(160px,190px)_minmax(0,1fr)] lg:grid-cols-[250px_minmax(0,1fr)] lg:grid-rows-none" : "h-[420px] grid-rows-[150px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)] lg:grid-rows-none"}`}>
            <div className={`cf-git-dialog-sidebar min-h-0 overflow-auto border-b border-[var(--cf-border)] bg-[var(--cf-surface-solid)] lg:border-b-0 lg:border-r ${pushPreviewHasContent ? "max-h-[190px] lg:max-h-none" : "max-h-[150px] lg:max-h-none"}`}>
              {!pushDialogLoading ? (
                <div className="border-b border-[var(--cf-border)] p-2">
                  <button
                    className={cn(
                      "cf-git-list-row flex w-full items-start gap-2 rounded-apple border px-2 py-2 text-left text-xs",
                      pushRepoSelected ? "cf-git-row-selected border-[var(--cf-accent)]" : "border-transparent",
                    )}
                    onClick={() => applyPushTreeSelection("__repo__")}
                    title={`${pushRepoRoute.source} -> ${pushRepoRoute.target}`}
                  >
                    <span
                      className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-apple-sm ${(pushPreview?.commits.length || 0) > 0 ? "hover:bg-[var(--cf-surface-hover)]" : "opacity-40"}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if ((pushPreview?.commits.length || 0) === 0) return;
                        setPushRepoExpanded(!pushRepoCommitsExpanded);
                      }}
                      title={pushRepoCommitsExpanded ? gt("workbench.details.context.collapse", "折叠") : gt("workbench.details.context.expand", "展开")}
                    >
                      {(pushPreview?.commits.length || 0) > 0 ? (
                        pushRepoCommitsExpanded ? <ChevronDown className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" /> : <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
                      ) : (
                        <span className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)] opacity-90" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{pushRepoDisplayName}</span>
                        <span className="shrink-0 text-[10px] text-[var(--cf-text-secondary)]">
                          {gt("workbench.misc.push.commitCount", "提交 {{count}}", { count: pushPreview?.commitCount || 0 })}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-[10px] text-[var(--cf-text-secondary)]">
                        <span className="min-w-0 truncate">{pushRepoRoute.source}</span>
                        <ArrowRight className="h-3 w-3 shrink-0" />
                        <span className="min-w-0 truncate">{pushRepoRoute.target}</span>
                      </div>
                    </div>
                  </button>
                </div>
              ) : null}
              {pushDialogLoading ? (
                  <div className="flex h-full items-center justify-center text-xs text-[var(--cf-text-secondary)]">
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    {gt("workbench.misc.push.loadingPreview", "正在读取推送预览...")}
                  </div>
              ) : null}
              {!pushDialogLoading && pushPreview?.commits.length === 0 ? (
                <div className="space-y-1 p-3 text-xs text-[var(--cf-text-secondary)]">
                  <div>{gt("workbench.misc.push.noCommits", "没有可推送的提交。")}</div>
                  {pushShouldShowEmptyReason ? <div>{pushPreview?.disabledReason}</div> : null}
                </div>
              ) : null}
              {!pushDialogLoading && pushRepoCommitsExpanded && (pushPreview?.commits.length || 0) > 0 ? (
                <div className="px-2 pb-2 pt-1">
                  <div className="ml-[9px] border-l border-[var(--cf-border)]/80 pl-2">
                    {(pushPreview?.commits || []).map((commit) => {
                      const selected = commit.hash === pushSelectedCommitHash;
                      const fileCount = Array.isArray(commit.files) ? commit.files.length : 0;
                      return (
                        <button
                          key={commit.hash}
                          className={cn(
                            "cf-git-list-row mt-[1px] flex w-full items-start gap-2 rounded-apple-sm px-2 py-[7px] text-left text-xs",
                            selected ? "cf-git-row-selected" : "",
                          )}
                          onClick={() => setPushSelectedCommitHash(commit.hash)}
                          title={commit.subject || commit.hash}
                        >
                          <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${selected ? "bg-[var(--cf-accent)]" : "bg-[var(--cf-text-secondary)]/75"}`} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{commit.subject || gitWorkbenchText("workbench.misc.push.noTitle", "(无标题)")}</div>
                            <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--cf-text-secondary)]">
                              <span>{commit.shortHash}</span>
                              <span>{commit.authorName}</span>
                              <span>{toCompactDateText(commit.authorDate)}</span>
                              {fileCount > 0 ? <span>{gt("workbench.misc.push.fileCount", "{{count}} 个文件", { count: fileCount })}</span> : null}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="flex min-h-0 flex-col bg-[var(--cf-surface-solid)]">
              {!pushDialogLoading ? (
                <div className="cf-git-pane-header border-b border-[var(--cf-border)] bg-[var(--cf-surface-muted)]/70 px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                        {pushSelectedCommit ? gt("workbench.misc.push.selectedCommit", "当前选中提交") : gt("workbench.misc.push.overview", "推送总览")}
                      </div>
                      <div className="mt-1 truncate text-sm font-medium">
                        {pushSelectedCommit ? (pushSelectedCommit.subject || gt("workbench.misc.push.noTitle", "(无标题)")) : pushRepoDisplayName}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--cf-text-secondary)]">
                        {pushSelectedCommit ? (
                          <>
                            <span>{pushSelectedCommit.shortHash || pushSelectedCommit.hash}</span>
                            <span>{pushSelectedCommit.authorName}</span>
                            <span>{toLocalDateText(pushSelectedCommit.authorDate)}</span>
                            <span>{gt("workbench.misc.push.fileCount", "{{count}} 个文件", { count: pushSelectedFiles.length })}</span>
                          </>
                        ) : (
                          <>
                            <span>{pushRepoRoute.source} → {pushRepoRoute.target}</span>
                            <span>{gt("workbench.misc.push.commitCount", "{{count}} 个提交", { count: pushPreview?.commitCount || 0 })}</span>
                            <span>{gt("workbench.misc.push.fileCount", "{{count}} 个文件", { count: pushPreview?.files.length || 0 })}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <Badge variant={pushPreview?.canPush ? "success" : "warning"} className="shrink-0">
                      {pushPreview?.canPush ? gt("workbench.misc.push.canPush", "可推送") : gt("workbench.misc.push.needsAttention", "待处理")}
                    </Badge>
                  </div>
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
                {pushPreviewHasContent ? (
                  <>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="font-medium">{gt("workbench.misc.push.changedFiles", "变更文件")}</div>
                      <div className="text-[10px] text-[var(--cf-text-secondary)]">
                        {pushSelectedCommit ? gt("workbench.misc.push.fileCount", "{{count}} 个文件", { count: pushSelectedFiles.length }) : gt("workbench.misc.push.totalFileCount", "共 {{count}} 个文件", { count: pushPreview?.files.length || 0 })}
                      </div>
                    </div>
                    {pushSelectedFiles.length === 0 ? (
                      <div className="text-[var(--cf-text-secondary)]">{gt("workbench.misc.push.noFileChanges", "无文件变更")}</div>
                    ) : (
                      <div className="space-y-[1px]">
                        {pushFileRows.map(({ node, depth }) => {
                          const expanded = pushFileTreeExpanded[node.key] !== false;
                          const statusText = node.isFile ? toCommitFileStatusText(node.status || "") : "";
                          return (
                            <div
                              key={`push-file:${node.key}`}
                              className={cn(
                                "cf-git-tree-row flex gap-1 rounded-apple-sm px-1 py-[2px] text-[11px]",
                                node.isFile && node.oldPath ? "items-start" : "items-center",
                              )}
                              style={{ paddingLeft: `${4 + depth * 14}px` }}
                              title={node.isFile ? (node.oldPath ? `${node.fullPath}\n${gt("dialogs.branchCompareFiles.fromPath", "来自 {{path}}", { path: node.oldPath })}` : node.fullPath) : node.fullPath}
                            >
                              {!node.isFile ? (
                                <button
                                  className="flex h-4 w-4 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]"
                                  onClick={() => setPushFileTreeExpanded((prev) => ({ ...prev, [node.key]: !expanded }))}
                                  title={expanded ? gt("workbench.misc.push.collapse", "收起") : gt("workbench.misc.push.expand", "展开")}
                                >
                                  {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                </button>
                              ) : (
                                <span className="block h-4 w-4" />
                              )}
                              {node.isFile ? (
                                <FileCode2 className="h-3.5 w-3.5 text-[var(--cf-accent)] opacity-90" />
                              ) : (
                                <Folder className="h-3.5 w-3.5 text-[var(--cf-orange)] opacity-90" />
                              )}
                              {node.isFile ? (
                                <span className={cn("cf-git-status-badge w-10 shrink-0 pt-[1px] text-center text-[10px] leading-none", GIT_TONE_CLASSNAME[resolveGitToneFromStatus(String(node.status || ""))])}>
                                  {statusText}
                                </span>
                              ) : null}
                              <div className="min-w-0 flex-1">
                                <div className="truncate">{node.name}</div>
                                {node.isFile && node.oldPath ? (
                                  <div className="truncate text-[10px] text-[var(--cf-text-secondary)]">{gt("workbench.misc.push.fromPath", "来自 {{path}}", { path: node.oldPath })}</div>
                                ) : null}
                              </div>
                              {!node.isFile ? <span className="shrink-0 text-[10px] text-[var(--cf-text-secondary)]">{node.count}</span> : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="max-w-[280px] rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-4 text-center">
                      <div className="text-sm font-medium">{gt("workbench.misc.push.noContent", "当前没有需要推送的内容")}</div>
                      <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">
                        {pushShouldShowEmptyReason ? pushPreview?.disabledReason : gt("workbench.misc.push.synced", "本地分支与远端分支已同步。")}
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="border-t border-[var(--cf-border)] px-3 py-3">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <label className="flex items-center gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-2.5 py-1.5">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--cf-accent)]"
                          checked={pushDialogPushTags}
                          onChange={(event) => setPushDialogPushTags(event.target.checked)}
                        />
                        <span>{gt("workbench.misc.push.pushTags", "推送标签")}</span>
                      </label>
                      {pushDialogPushTags ? (
                        <Select
                          value={pushDialogTagMode}
                          onValueChange={(value) => setPushDialogTagMode(value === "follow" ? "follow" : "all")}
                        >
                            <SelectTrigger className="cf-git-filter-input h-8 min-w-[126px] bg-[var(--cf-surface)] px-2 text-xs" title={gt("workbench.misc.push.tagMode", "推送标签模式")}>
                            <SelectValue placeholder={gt("workbench.misc.push.tagModePlaceholder", "标签模式")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">{gt("workbench.misc.push.allTags", "全部标签")}</SelectItem>
                            <SelectItem value="follow">{gt("workbench.misc.push.follow", "当前分支相关")}</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <div className="rounded-apple border border-dashed border-[var(--cf-border)] px-2.5 py-1.5 text-[11px] text-[var(--cf-text-secondary)]">
                          {gt("workbench.misc.push.noTags", "当前不推送标签")}
                        </div>
                      )}
                      <label className="flex items-center gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-2.5 py-1.5">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--cf-accent)]"
                          checked={pushDialogRunHooks}
                          onChange={(event) => setPushDialogRunHooks(event.target.checked)}
                        />
                        <span>{gt("workbench.misc.push.runHooks", "运行 Git 挂钩")}</span>
                      </label>
                      {pushDialogTargetHash ? (
                        <>
                          <label className="flex items-center gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-2.5 py-1.5">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[var(--cf-accent)]"
                              checked={status?.commitAndPush.previewOnCommitAndPush !== false}
                              onChange={(event) => {
                                void updateCommitAndPushPreferencesAsync({
                                  previewOnCommitAndPush: event.target.checked,
                                });
                              }}
                            />
                            <span>{gt("workbench.misc.push.previewBeforeCommitPush", "提交并推送时先预览")}</span>
                          </label>
                          <label className={cn(
                            "flex items-center gap-2 rounded-apple border border-[var(--cf-border)] px-2.5 py-1.5",
                            status?.commitAndPush.previewOnCommitAndPush !== false
                              ? "bg-[var(--cf-surface-muted)]"
                              : "bg-[var(--cf-surface)] text-[var(--cf-text-secondary)] opacity-70",
                          )}>
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[var(--cf-accent)]"
                              checked={status?.commitAndPush.previewProtectedOnly === true}
                              disabled={status?.commitAndPush.previewOnCommitAndPush !== true}
                              onChange={(event) => {
                                void updateCommitAndPushPreferencesAsync({
                                  previewProtectedOnly: event.target.checked,
                                  previewOnCommitAndPush: true,
                                });
                              }}
                            />
                            <span>{gt("workbench.misc.push.previewProtectedBranches", "仅保护分支预览")}</span>
                          </label>
                        </>
                      ) : null}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--cf-text-secondary)]">
                        <span>{gt("workbench.misc.push.pendingCommits", "待推送提交：{{count}}", { count: pushPreview?.commitCount || 0 })}</span>
                        <span>{gt("workbench.misc.push.changedFilesCount", "变更文件：{{count}}", { count: pushPreview?.files.length || 0 })}</span>
                    </div>
                    {pushPreview?.disabledReason && pushPreviewHasContent ? (
                      <div className="mt-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-2.5 py-2 text-[11px] text-[var(--cf-text-secondary)]">
                        {pushPreview.disabledReason}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-end gap-2">
                      <Button size="xs" variant="secondary" onClick={() => setPushDialogOpen(false)} data-cf-dialog-cancel="true">
                      {gt("workbench.common.close", "取消")}
                    </Button>
                    <div className="relative flex items-center">
                      <Button size="xs" title={pushPreview?.canPush ? undefined : (pushPreview?.disabledReason || gt("workbench.misc.push.unavailable", "当前不可推送"))} disabled={pushDialogSubmitting || !pushPreview?.canPush} onClick={() => void submitPushDialogAsync(false)} data-cf-dialog-primary="true">
                        {pushDialogSubmitting ? gt("workbench.misc.push.pushing", "推送中...") : gt("workbench.misc.push.push", "推送")}
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        className="ml-1 px-2"
                        title={pushPreview?.canPush ? gt("workbench.misc.push.moreOptions", "更多推送选项") : (pushPreview?.disabledReason || gt("workbench.misc.push.unavailable", "当前不可推送"))}
                        disabled={pushDialogSubmitting || !pushPreview?.canPush}
                        onClick={() => setPushForceMenuOpen((prev) => !prev)}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                      {pushForceMenuOpen ? (
                        <div className="cf-git-menu-panel absolute bottom-9 right-0 z-[1300] min-w-[230px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple p-1.5">
                          <label className="cf-git-menu-item flex cursor-pointer items-center gap-2 rounded-apple-sm px-2 py-2 text-left text-xs">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[var(--cf-accent)]"
                              checked={pushDialogUpdateIfRejected}
                              onChange={(event) => setPushDialogUpdateIfRejected(event.target.checked)}
                            />
                            <span>{gt("workbench.misc.push.pushRejectedToUpdateFlow", "推送被拒绝时进入更新决策流")}</span>
                          </label>
                          <div className="my-1 h-px bg-[var(--cf-border)]" />
                          <button
                            className="cf-git-menu-item flex h-7 w-full items-center rounded-apple-sm px-2 text-left text-xs"
                            onClick={() => {
                              setPushForceMenuOpen(false);
                              void submitPushDialogAsync(true);
                            }}
                          >
                            {gt("workbench.misc.push.forceWithLease", "强制推送（保留租约保护）")}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  };

  /**
   * 渲染通用动作输入对话框，承载分支/标签/变更列表等参数采集。
   */
  const renderActionDialog = (): JSX.Element | null => {
    return (
      <GitActionDialog
        open={actionDialogOpen}
        config={actionDialogConfig}
        values={actionDialogValues}
        submitting={actionDialogSubmitting}
        onClose={() => closeActionDialog(null)}
        onSubmit={submitActionDialog}
        onChangeField={(key, value) => {
          setActionDialogValues((prev) => ({ ...prev, [key]: value }));
        }}
      />
    );
  };

  /**
   * 渲染 tracked branch 修复对话框，承载多仓逐项修复与继续更新流程。
   */
  const renderFixTrackedBranchDialog = (): JSX.Element | null => {
    if (!fixTrackedBranchPreview) return null;
    return (
      <FixTrackedBranchDialog
        open={fixTrackedBranchDialogOpen}
        preview={fixTrackedBranchPreview}
        submitting={fixTrackedBranchSubmitting}
        continueMode={fixTrackedBranchContinueMode}
        onClose={() => {
          if (fixTrackedBranchSubmitting) return;
          setFixTrackedBranchDialogOpen(false);
          setFixTrackedBranchPreview(null);
          setFixTrackedBranchContinueMode("update");
          trackedBranchRetryRef.current = null;
          trackedBranchAfterSuccessRef.current = null;
        }}
        onConfirm={(payload) => {
          void submitFixTrackedBranchDialogAsync(payload);
        }}
      />
    );
  };

  /**
   * 渲染统一冲突解决入口，收口多文件冲突列表与继续/中止当前操作的入口。
   */
  const renderConflictResolverDialog = (): JSX.Element | null => {
    if (!conflictResolverDialogState) return null;
    return (
      <ConflictResolverDialog
        open={!!conflictResolverDialogState}
        title={conflictResolverDialogState.title}
        description={conflictResolverDialogState.description}
        snapshot={conflictResolverDialogState.sessionSnapshot}
        selectedPath={conflictResolverDialogState.selectedPath}
        checkedPaths={conflictResolverDialogState.checkedPaths}
        groupByDirectory={conflictResolverDialogState.groupByDirectory}
        showResolved={conflictResolverDialogState.showResolved}
        operationState={status?.operationState}
        loading={conflictResolverDialogState.loading}
        submitting={operationStateSubmitting}
        applyingSide={conflictResolverDialogState.applyingSide}
        onOpenChange={(open) => {
          if (!open) closeConflictResolverDialog();
        }}
        onSelectPath={selectConflictResolverPath}
        onTogglePath={toggleConflictResolverCheckedPath}
        onToggleAll={toggleAllConflictResolverCheckedPaths}
        onToggleGroupByDirectory={toggleConflictResolverGroupByDirectory}
        onToggleShowResolved={toggleConflictResolverResolvedVisibility}
        onOpenSelected={() => {
          void openSelectedConflictFromResolverAsync();
        }}
        onOpenSelectedInIde={() => {
          void openSelectedConflictInIdeAsync();
        }}
        onOpenSelectedInSystem={() => {
          void openSelectedConflictInSystemAsync();
        }}
        onShowInCommitPanel={showMergeConflictInCommitPanel}
        onSelectNext={selectNextConflictResolverPath}
        onApplySide={(side) => {
          void applyConflictResolverSideFromDialogAsync(side);
        }}
        onRefresh={() => {
          void refreshAllAsync({ keepLog: false });
        }}
        continueLabel={shouldFinalizeCherryPickByCommit(
          {
            status,
            unresolvedConflictCount: conflictResolverDialogState.sessionSnapshot?.unresolvedCount || 0,
            hasChanges: (status?.entries?.length || 0) > 0,
          },
        ) ? gt("workbench.operationState.submitChanges", "提交更改") : undefined}
        onContinue={status?.operationState && status.operationState !== "normal"
          ? () => {
              if (enterCherryPickCommitCompletionMode({ closeResolver: true, focusEditor: true })) return;
              void submitOperationStateControlAsync("continue");
            }
          : undefined}
        onAbort={status?.operationState && status.operationState !== "normal"
          ? () => {
              void submitOperationStateControlAsync("abort");
            }
          : undefined}
      />
    );
  };

  /**
   * 渲染 interactive rebase 应用内编辑器，统一承载提交顺序、动作与消息编辑。
   */
  const renderInteractiveRebaseDialog = (): JSX.Element | null => {
    if (!interactiveRebaseDialogState) return null;
    return (
      <InteractiveRebaseDialog
        open={!!interactiveRebaseDialogState}
        plan={interactiveRebaseDialogState.plan}
        entries={interactiveRebaseDialogState.entries}
        selectedHash={interactiveRebaseDialogState.selectedHash}
        submitting={interactiveRebaseDialogState.submitting}
        detailsLoading={interactiveRebaseDialogState.detailsLoadingHash === interactiveRebaseDialogState.selectedHash}
        selectedDetails={interactiveRebaseDialogState.detailsByHash[interactiveRebaseDialogState.selectedHash] || null}
        selectedDiffPath={interactiveRebaseDialogState.selectedDiffPathByHash[interactiveRebaseDialogState.selectedHash] || ""}
        error={interactiveRebaseDialogState.error}
        onOpenChange={(open) => {
          if (!open) requestCloseInteractiveRebaseDialog();
        }}
        onSelectHash={selectInteractiveRebaseEntry}
        onMoveEntry={moveInteractiveRebaseDialogEntry}
        onMoveEntryToEdge={moveInteractiveRebaseDialogEntryToEdge}
        onChangeAction={updateInteractiveRebaseDialogAction}
        onChangeMessage={updateInteractiveRebaseDialogMessage}
        onSelectDiffPath={selectInteractiveRebaseDiffPath}
        onOpenDiff={() => {
          void openInteractiveRebaseDiffAsync();
        }}
        onFillSuggestedMessage={fillInteractiveRebaseSuggestedMessage}
        onReset={resetInteractiveRebaseDialog}
        onSubmit={() => {
          void submitInteractiveRebaseDialogAsync();
        }}
        onRequestCancel={requestCloseInteractiveRebaseDialog}
      />
    );
  };

  /**
   * 渲染正式的 Update Options 对话框，承载持久化更新方式与 save changes policy。
   */
  const renderUpdateOptionsDialog = (): JSX.Element | null => {
    if (!updateOptionsSnapshot) return null;
    return (
        <UpdateOptionsDialog
          open={updateOptionsDialogOpen}
          snapshot={updateOptionsSnapshot}
          submitting={updateOptionsSubmitting}
          onClose={() => {
            if (updateOptionsSubmitting) return;
            setUpdateOptionsDialogOpen(false);
          }}
          onRequestScopePreview={requestUpdateScopePreviewAsync}
          onConfirm={(options) => {
            void submitUpdateOptionsDialogAsync(options);
          }}
        />
    );
  };

  /**
   * 渲染本次 Update Project 的运行期范围对话框，只回并一次性 payload，不改持久化默认值。
   */
  const renderUpdateRuntimeScopeDialog = (): JSX.Element | null => {
    if (!updateRuntimeScopeSnapshot) return null;
    return (
      <UpdateRuntimeScopeDialog
        open={updateRuntimeScopeDialogOpen}
        snapshot={updateRuntimeScopeSnapshot}
        submitting={updateRuntimeScopeSubmitting}
        onClose={closeUpdateRuntimeScopeDialog}
        onConfirm={(payloadPatch) => {
          void submitUpdateRuntimeScopeDialogAsync(payloadPatch);
        }}
      />
    );
  };

  /**
   * 渲染 Reset 独立确认对话框，显式承接“重置到远端跟踪分支”的危险动作。
   */
  const renderUpdateResetDialog = (): JSX.Element | null => {
    if (!updateResetSnapshot) return null;
    const branchName = String(updateResetSnapshot.methodResolution.currentBranch || "").trim();
    const upstream = String(updateResetSnapshot.methodResolution.currentUpstream || "").trim();
    return (
      <Dialog
        open={updateResetDialogOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeUpdateResetDialog();
        }}
      >
        <DialogContent className="max-w-[560px] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-0 text-[var(--cf-text-primary)]">
          <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
            <DialogTitle className="text-base font-semibold">{gt("dialogs.updateReset.title", "重置到远端跟踪分支")}</DialogTitle>
            <DialogDescription className="text-xs text-[var(--cf-text-secondary)]">
              {gt("dialogs.updateReset.description", "该操作会以 Reset 路径更新当前仓库，并可能覆盖本地工作区内容。请确认后再继续。")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-5 py-4">
            <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3 text-sm">
              <div>{gt("dialogs.updateReset.currentBranch", "当前分支：{{branch}}", { branch: branchName || "HEAD" })}</div>
              <div className="mt-1 text-[var(--cf-text-secondary)]">
                {gt("dialogs.updateReset.upstreamBranch", "远端跟踪分支：{{branch}}", {
                  branch: upstream || gt("dialogs.updateReset.unconfigured", "未配置"),
                })}
              </div>
            </div>
            <div className="rounded-apple border border-[var(--cf-red)]/20 bg-[var(--cf-red-light)] px-4 py-3 text-xs text-[var(--cf-red)]">
              {gt("dialogs.updateReset.warning", "这不是普通 Update 选项。它只会对当前仓库执行一次独立 Reset，不会改写已保存的 Merge / Rebase 默认设置。")}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-[var(--cf-border)] px-5 py-4">
            <Button size="xs" variant="secondary" onClick={closeUpdateResetDialog} disabled={updateResetSubmitting} data-cf-dialog-cancel="true">
              {gt("dialogs.updateReset.cancel", "取消")}
            </Button>
            <Button size="xs" variant="danger" onClick={() => { void submitUpdateResetDialogAsync(); }} disabled={updateResetSubmitting} data-cf-dialog-primary="true">
              {updateResetSubmitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              {gt("dialogs.updateReset.submit", "重置并更新")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  };

  /**
   * 渲染 Rebase warning 对话框，统一承载 rebase 风险确认与改用 Merge 的重试入口。
   */
  const renderRebaseWarningDialog = (): JSX.Element | null => {
    if (!rebaseWarning) return null;
    return (
      <RebaseWarningDialog
        open={rebaseWarningDialogOpen}
        warning={rebaseWarning}
        submitting={rebaseWarningSubmitting}
        onClose={closeRebaseWarningDialog}
        onConfirm={(payloadPatch) => {
          void submitRebaseWarningDecisionAsync(payloadPatch);
        }}
        onAlternative={(payloadPatch) => {
          void submitRebaseWarningDecisionAsync(payloadPatch);
        }}
      />
    );
  };

  /**
   * 渲染统一问题提示对话框，承载覆盖文件、未跟踪文件与 Merge 冲突等正式问题提示。
   */
  const renderSmartOperationDialog = (): JSX.Element | null => {
    if (!operationProblem) return null;
    if (operationProblem.kind === "untracked-overwritten") {
      return (
        <UntrackedOverwriteDialog
          open={operationProblemDialogOpen}
          problem={operationProblem}
          submitting={operationProblemSubmitting}
          onClose={closeOperationProblemDialog}
          onAction={(payloadPatch) => {
            void submitOperationProblemDecisionAsync(payloadPatch);
          }}
        />
      );
    }
    return (
      <SmartOperationDialog
        open={operationProblemDialogOpen}
        problem={operationProblem}
        submitting={operationProblemSubmitting}
        onClose={closeOperationProblemDialog}
        onViewChanges={() => {
          void viewOperationProblemChangesAsync();
        }}
        onAction={(payloadPatch) => {
          void submitOperationProblemDecisionAsync(payloadPatch);
        }}
      />
    );
  };

  /**
   * 渲染显式 Fetch 对话框，统一承载 root/remote/refspec/tag mode 等参数。
   */
  const renderFetchDialog = (): JSX.Element | null => {
    return (
      <FetchDialog
        open={fetchDialogOpen}
        repositories={fetchDialogRepositories}
        value={fetchDialogValue}
        submitting={fetchDialogSubmitting}
        onClose={() => {
          if (fetchDialogSubmitting) return;
          setFetchDialogOpen(false);
        }}
        onChange={(nextValue) => {
          setFetchDialogValue(nextValue);
        }}
        onSubmit={() => {
          void submitFetchDialogAsync();
        }}
      />
    );
  };

  /**
   * 渲染独立 Pull 对话框，显式承载 remote/branch/mode 选择。
   */
  const renderPullDialog = (): JSX.Element | null => {
    return (
      <PullDialog
        open={pullDialogOpen}
        repositories={pullDialogRepositories}
        value={pullDialogValue}
        capabilities={pullDialogCapabilities}
        submitting={pullDialogSubmitting}
        refreshing={loadingFlow}
        onClose={() => {
          if (pullDialogSubmitting) return;
          setPullDialogOpen(false);
        }}
        onChange={(nextValue) => {
          setPullDialogValue(nextValue);
        }}
        onRefresh={({ repoRoot: targetRepoRoot, remote }) => {
          void executeFetchFlowAsync(targetRepoRoot, { remote, allRemotes: false });
        }}
        onSubmit={() => {
          void submitPullDialogAsync();
        }}
      />
    );
  };

  /**
   * 渲染 shelf 恢复对话框，统一暴露 partial unshelve 与 changelist/remove policy 选项。
   */
  const renderShelfRestoreDialog = (): JSX.Element | null => {
    return (
      <ShelfRestoreDialog
        open={shelfRestoreDialogOpen}
        shelf={shelfRestoreDialogShelf}
        changeListOptions={displayChangeLists.map((item) => ({ id: item.id, name: item.name }))}
        changeListsEnabled={localChangesConfig.changeListsEnabled && !localChangesConfig.stagingAreaEnabled}
        submitting={shelfRestoreDialogSubmitting}
        value={shelfRestoreDialogValue}
        onClose={closeShelfRestoreDialog}
        onChange={setShelfRestoreDialogValue}
        onSubmit={() => {
          void submitShelfRestoreDialogAsync();
        }}
      />
    );
  };

  /**
   * 渲染 rollback viewer 之上的临时 Diff 浮层。
   * 这是对齐 IDEA“当前流程内查看差异”的变通设计：现有产品没有单独的 Diff 窗口宿主，因此复用工作台 Diff 面板并临时前置显示。
   */
  const renderRollbackDiffOverlay = (): JSX.Element | null => {
    if (!rollbackDiffOverlayOpen || !diff) return null;
    return (
      <Dialog
        open={rollbackDiffOverlayOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeRollbackDiffOverlay();
        }}
      >
        <DialogContent className="cf-git-dialog-panel h-[calc(100vh-3rem)] w-[min(1440px,calc(100vw-3rem))] max-w-[calc(100vw-3rem)] overflow-hidden p-0">
          {renderDiffPanel(false, {
            onClose: closeRollbackDiffOverlay,
            allowFullscreenToggle: false,
          })}
        </DialogContent>
      </Dialog>
    );
  };

  /**
   * 渲染可回滚本地更改的 viewer，对齐普通 rollback 与 pull blocker 的共享入口。
   */
  const renderRollbackViewerDialog = (): JSX.Element | null => {
    if (!rollbackViewerState) return null;
    return (
      <RollbackViewerDialog
        open={!!rollbackViewerState}
        title={rollbackViewerState.title}
        description={rollbackViewerState.description}
        entries={rollbackViewerState.entries}
        selectedPaths={rollbackViewerState.selectedPaths}
        activePath={rollbackViewerState.activePath}
        groupingKeys={activeCommitGroupingKeys.includes("directory") ? ["directory"] : []}
        submitting={rollbackViewerSubmitting}
        refreshing={rollbackViewerRefreshing}
        continueLabel={rollbackViewerState.continueLabel}
        onClose={closeRollbackViewerDialog}
        onSelectionChange={(nextPaths) => {
          setRollbackViewerState((prev) => prev ? { ...prev, selectedPaths: nextPaths } : prev);
        }}
        onGroupingKeysChange={(nextKeys) => {
          void applyRollbackViewerGroupingKeysAsync(nextKeys);
        }}
        onActivePathChange={(nextPath) => {
          setRollbackViewerState((prev) => prev ? { ...prev, activePath: nextPath } : prev);
        }}
        onOpenDiff={(entry) => {
          void openRollbackViewerDiffAsync(entry);
        }}
        onRefresh={() => {
          void refreshRollbackViewerAsync();
        }}
        onRollback={() => {
          void submitRollbackViewerAsync(false);
        }}
        onRollbackAndContinue={rollbackViewerContinueRef.current ? () => {
          void submitRollbackViewerAsync(true);
        } : undefined}
      />
    );
  };

  /**
   * 渲染 stage three versions 只读比较对话框，复用现有三栏编辑器而不引入并行 viewer 状态。
   */
  const renderStageThreeWayDialog = (): JSX.Element | null => {
    if (!stageThreeWayDialogState) return null;
    return (
      <Dialog
        open={!!stageThreeWayDialogState}
        onOpenChange={(open) => {
          if (!open) closeStageThreeWayDialog();
        }}
      >
        <DialogContent className="h-[min(86vh,920px)] max-w-[min(96vw,1360px)] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-0 text-[var(--cf-text-primary)]">
          <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
            <DialogTitle className="text-base font-semibold">{gt("workbench.misc.diff.compareThreeVersions", "比较三个版本")}</DialogTitle>
            <DialogDescription className="text-xs text-[var(--cf-text-secondary)]">
              {stageThreeWayDialogState.path}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
            {stageThreeWayDialogState.error ? (
              <div className="rounded-apple border border-[var(--cf-red)]/20 bg-[var(--cf-red-light)] px-3 py-2 text-xs text-[var(--cf-red)]">
                {stageThreeWayDialogState.error}
              </div>
            ) : null}
            {stageThreeWayDialogState.loading ? (
              <div className="flex min-h-[320px] flex-1 items-center justify-center text-sm text-[var(--cf-text-secondary)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {gt("workbench.stageThreeWay.loading", "正在读取 HEAD / Index / Working Tree 快照...")}
              </div>
            ) : (
              <div className="min-h-0 flex-1">
                <ConflictMergeThreeWayEditor
                  language="plaintext"
                  saving={true}
                  busy={false}
                  collapseUnchanged={false}
                  leftPane={{
                    label: gt("workbench.stageThreeWay.head", "HEAD"),
                    text: stageThreeWayDialogState.headText,
                    renderable: stageThreeWayDialogState.headRenderable,
                    fallbackText: stageThreeWayDialogState.headFallbackText,
                  }}
                  rightPane={{
                    label: gt("workbench.stageThreeWay.workingTree", "Working Tree"),
                    text: stageThreeWayDialogState.workingText,
                    renderable: stageThreeWayDialogState.workingRenderable,
                    fallbackText: stageThreeWayDialogState.workingFallbackText,
                  }}
                  resultLabel={gt("workbench.stageThreeWay.index", "Index")}
                  resultText={stageThreeWayDialogState.indexText}
                  blocks={[]}
                  selectedBlock={null}
                  onResultTextChange={() => {}}
                />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  };

  /**
   * 渲染分支比较文件对话框，统一承接“分支 vs 分支 / 分支 vs 工作树”文件列表，并在点击文件后直接打开 Diff。
   */
  const renderBranchCompareFilesDialog = (): JSX.Element | null => {
    if (!branchCompareFilesDialogState) return null;
    const compareLabel = formatBranchCompareLabel(
      branchCompareFilesDialogState.leftRef,
      branchCompareFilesDialogState.rightRef,
    );
    const isRevisionCompare = !!String(branchCompareFilesDialogState.rightRef || "").trim();
    return (
      <Dialog
        open={!!branchCompareFilesDialogState}
        onOpenChange={(open) => {
          if (!open) setBranchCompareFilesDialogState(null);
        }}
      >
        <DialogContent className="cf-git-dialog-panel w-[760px] max-w-[calc(100vw-4rem)] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-0 text-[var(--cf-text-primary)]">
          <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <GitCompare className="h-4 w-4 text-[var(--cf-accent)]" />
              {gt("dialogs.branchCompareFiles.title", "比较文件")}
            </DialogTitle>
            <DialogDescription className="text-xs text-[var(--cf-text-secondary)]">
              {compareLabel ? gt("dialogs.branchCompareFiles.scope", "范围：{{label}}。", { label: compareLabel }) : ""}
              {gt("dialogs.branchCompareFiles.description", "共 {{count}} 个文件，单击文件即可打开差异。", { count: branchCompareFiles.length })}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-auto px-3 py-3">
            {branchCompareFileRows.length <= 0 ? (
              <div className="rounded-apple border border-dashed border-[var(--cf-border)] px-4 py-8 text-center text-sm text-[var(--cf-text-secondary)]">
                {gt("dialogs.branchCompareFiles.empty", "当前比较范围内没有文件差异。")}
              </div>
            ) : (
              <div className="space-y-0.5">
                {branchCompareFileRows.map(({ node, depth }) => {
                  const expanded = branchCompareFilesTreeExpanded[node.key] !== false;
                  const statusText = node.isFile ? toCommitFileStatusText(node.status || "") : "";
                  return (
                    <button
                      key={node.key}
                      className="cf-git-tree-row flex w-full items-center gap-0 rounded-apple-sm px-1 py-[3px] text-left text-xs hover:bg-[var(--cf-surface-hover)]"
                      style={{ paddingLeft: DETAIL_TREE_BASE_PADDING + depth * TREE_DEPTH_INDENT }}
                      title={node.isFile
                        ? (node.oldPath
                          ? `${node.fullPath}\n${gt("dialogs.branchCompareFiles.fromPath", "来自 {{path}}", { path: node.oldPath })}`
                          : node.fullPath)
                        : node.fullPath}
                      onClick={() => {
                        if (!node.isFile) {
                          setBranchCompareFilesTreeExpanded((prev) => ({ ...prev, [node.key]: !expanded }));
                          return;
                        }
                        void openDiffAsync(
                          node.fullPath,
                          isRevisionCompare ? "revisionToRevision" : "revisionToWorking",
                          isRevisionCompare ? branchCompareFilesDialogState.rightRef : branchCompareFilesDialogState.leftRef,
                          isRevisionCompare ? [branchCompareFilesDialogState.leftRef, branchCompareFilesDialogState.rightRef || ""] : undefined,
                          {
                            oldPath: node.oldPath,
                            repoRoot: branchCompareFilesDialogState.repoRoot,
                          },
                        ).then(() => {
                          setBranchCompareFilesDialogState(null);
                        });
                      }}
                    >
                      {node.isFile ? (
                        <>
                          <span className="h-3.5 w-3.5 shrink-0" />
                          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)] opacity-90" />
                        </>
                      ) : (
                        <>
                          <span
                            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-apple-sm hover:bg-[var(--cf-surface-hover)]"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setBranchCompareFilesTreeExpanded((prev) => ({ ...prev, [node.key]: !expanded }));
                            }}
                            title={expanded ? gt("details.browser.tree.collapse", "收起") : gt("details.browser.tree.expand", "展开")}
                          >
                            {expanded ? <ChevronDown className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" /> : <ChevronRight className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />}
                          </span>
                          <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-secondary)]" />
                        </>
                      )}
                      {node.isFile ? (
                        <span
                          className={cn(
                            "cf-git-status-badge mr-1 w-10 shrink-0 text-center text-[10px] leading-none",
                            GIT_TONE_CLASSNAME[resolveGitToneFromStatus(String(node.status || ""))],
                          )}
                        >
                          {statusText}
                        </span>
                      ) : null}
                      <span className={cn("min-w-0 flex-1", node.isFile && node.oldPath ? "space-y-0.5" : "")}>
                        <span className="block truncate">{node.name}</span>
                        {node.isFile && node.oldPath ? (
                          <span className="block truncate text-[10px] text-[var(--cf-text-secondary)]">
                            {gt("dialogs.branchCompareFiles.fromPath", "来自 {{path}}", { path: node.oldPath })}
                          </span>
                        ) : null}
                      </span>
                      {!node.isFile ? <span className="ml-0.5 shrink-0 text-[10px] text-[var(--cf-text-secondary)]">{gt("details.browser.tree.nodeFileCount", "{{count}} 个文件", { count: node.count })}</span> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  };

  /**
   * 渲染远端管理对话框，统一承接新增、编辑、移除远端的当前架构等价实现。
   */
  const renderBranchRemoteManagerDialog = (): JSX.Element | null => {
    if (!branchRemoteManagerDialogState) return null;
    const managerRepoRoot = String(branchRemoteManagerDialogState.repoRoot || "").trim();
    return (
      <Dialog
        open={!!branchRemoteManagerDialogState}
        onOpenChange={(open) => {
          if (!open) setBranchRemoteManagerDialogState(null);
        }}
      >
        <DialogContent className="cf-git-dialog-panel w-[720px] max-w-[calc(100vw-4rem)] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-0 text-[var(--cf-text-primary)]">
          <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
            <DialogTitle className="text-base font-semibold">{gt("dialogs.remoteManager.title", "远端管理")}</DialogTitle>
            <DialogDescription className="text-xs text-[var(--cf-text-secondary)]">
              {managerRepoRoot || gt("dialogs.remoteManager.currentRepository", "当前仓库")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-[var(--cf-text-secondary)]">
                {branchRemoteManagerRemoteConfigs.length > 0
                  ? gt("dialogs.remoteManager.count", "共 {{count}} 个远端配置", { count: branchRemoteManagerRemoteConfigs.length })
                  : gt("dialogs.remoteManager.emptyInline", "当前仓尚未配置远端")}
              </div>
              <Button size="xs" variant="secondary" onClick={() => { void openBranchRemoteEditorAsync(managerRepoRoot); }}>
                {gt("dialogs.remoteManager.addRemote", "新增远端")}
              </Button>
            </div>
            {branchRemoteManagerRemoteConfigs.length <= 0 ? (
              <div className="rounded-apple border border-dashed border-[var(--cf-border)] px-4 py-8 text-center text-sm text-[var(--cf-text-secondary)]">
                {gt("dialogs.remoteManager.empty", "当前仓库没有远端配置。可通过“新增远端”录入 fetch / push 地址。")}
              </div>
            ) : (
              <div className="space-y-2">
                {branchRemoteManagerRemoteConfigs.map((item) => (
                  <div
                    key={`branch-remote:${managerRepoRoot}:${item.name}`}
                    className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="cf-git-inline-badge font-medium text-[var(--cf-text-primary)]">{item.name}</span>
                        </div>
                        <div className="min-w-0 truncate text-xs text-[var(--cf-text-secondary)]" title={item.fetchUrl || ""}>
                          {gt("dialogs.remoteManager.fetchUrl", "Fetch: {{value}}", {
                            value: item.fetchUrl || gt("dialogs.remoteManager.unconfigured", "未配置"),
                          })}
                        </div>
                        <div className="min-w-0 truncate text-xs text-[var(--cf-text-secondary)]" title={item.pushUrl || item.fetchUrl || ""}>
                          {gt("dialogs.remoteManager.pushUrl", "Push: {{value}}", {
                            value: item.pushUrl || item.fetchUrl || gt("dialogs.remoteManager.unconfigured", "未配置"),
                          })}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="xs" variant="ghost" onClick={() => { void openBranchRemoteEditorAsync(managerRepoRoot, item.name); }}>
                          {gt("dialogs.remoteManager.edit", "编辑")}
                        </Button>
                        <Button size="xs" variant="danger" onClick={() => { void removeBranchRemoteAsync(item.name, managerRepoRoot); }}>
                          {gt("dialogs.remoteManager.remove", "移除")}
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  };

  /**
   * 渲染 Push Rejected 决策对话框，显式承接 update / force / cancel 用户决策流。
   */
  const renderPushRejectedDialog = (): JSX.Element | null => {
    if (!pushRejectedDecision) return null;
    return (
      <PushRejectedDialog
        open={pushRejectedDialogOpen}
        decision={pushRejectedDecision}
        submitting={pushRejectedSubmitting}
        onClose={closePushRejectedDialog}
        onAction={(action) => {
          void submitPushRejectedDecisionAsync(action);
        }}
      />
    );
  };

  const gitBusy = gitActivityCount > 0;
  const gitStatusText = gitBusy
    ? gt("workbench.misc.status.busy", "正在{{activity}}", { activity: gitActivityText })
    : (isRepo ? gt("workbench.misc.status.ready", "就绪") : gt("workbench.misc.status.noRepo", "未检测到 Git 仓库"));
  const commitToolbarActive = leftTab === "commit" && !leftCollapsed;

  if (!active) {
    return <div className="h-full w-full bg-[var(--cf-surface-solid)]"></div>;
  }

  return (
    <div className="cf-git-workbench relative flex h-full min-h-0 flex-col overflow-hidden rounded-[inherit] bg-[var(--cf-surface-muted)]">
      <div className="cf-git-toolbar flex items-center justify-between border-b border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple px-2 py-1">
        <div className="cf-git-toolbar-scroll no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap pr-2">
          <Button size="xs" variant="secondary" className="shrink-0 gap-1" title={currentBranchPresentation.tooltip} onClick={async () => {
            if (!repoRoot) return;
            const snapshot = await reloadBranchPopupAsync({ resetQuery: true });
            if (!snapshot) return;
            setBranchPopupOpen(true);
          }}>
            <BranchSyncStatusIcon sync={branchPopup?.currentBranchSync} className="shrink-0" />
            <span>{currentBranchPresentation.label}</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <div className="flex shrink-0 items-center">
            <Button
              size="xs"
              variant="ghost"
              className="gap-1.5 rounded-r-none"
              onClick={() => void runFlowActionAsync("pull")}
            >
              <CircleArrowDown className="h-3.5 w-3.5" />
              <span>{gt("workbench.topToolbar.updateProject", "更新项目")}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button size="xs" variant="ghost" className="rounded-l-none px-2" title={gt("workbench.topToolbar.updateOptions", "更新选项")}>
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>{gt("workbench.topToolbar.updateProject", "更新项目")}</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => void runFlowActionAsync("pull")}>{gt("workbench.topToolbar.updateNow", "立即更新")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void openUpdateOptionsDialogAsync()}>{gt("workbench.topToolbar.updateOptionsWithEllipsis", "更新选项...")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void openUpdateResetDialogAsync()}>{gt("workbench.topToolbar.resetToTracked", "重置到远端跟踪分支...")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 gap-1.5"
            disabled={!toolbarState.pull.enabled}
            title={toolbarState.pull.reason || gt("workbench.topToolbar.pull", "拉取远端分支")}
            onClick={() => {
              void openPullDialogAsync();
            }}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            <span>{gt("workbench.topToolbar.pullShort", "拉取")}</span>
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 gap-1.5"
            disabled={!toolbarState.fetch.enabled}
            title={toolbarState.fetch.reason || gt("workbench.topToolbar.fetch", "获取远端变更")}
            onClick={() => void runFlowActionAsync("fetch")}
          >
            <Download className="h-3.5 w-3.5" />
            <span>{gt("workbench.topToolbar.fetchShort", "获取")}</span>
          </Button>
          <div className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
          <Button
            size="xs"
            variant={commitToolbarActive ? "secondary" : "ghost"}
            className="shrink-0 gap-1.5"
            disabled={!toolbarState.commit.enabled}
            title={toolbarState.commit.reason || gt("workbench.topToolbar.commit", "打开提交工作流")}
            onClick={() => {
              activateCommitWorkflow();
            }}
          >
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span>{gt("workbench.topToolbar.commitShort", "提交")}</span>
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 gap-1.5"
            disabled={!toolbarState.push.enabled}
            title={toolbarState.push.reason || gt("workbench.topToolbar.push", "推送到远端")}
            onClick={() => void runFlowActionAsync("push")}
          >
            <Upload className="h-3.5 w-3.5" />
            <span>{gt("workbench.topToolbar.pushShort", "推送")}</span>
          </Button>
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-secondary)]">
          {gitBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          <span className="hidden md:inline truncate max-w-[44vw]">{repoRoot || repoPath}</span>
          {conflictsPanelSnapshot.hasAny || conflictsPanelPreferences.gateEnabled === false ? (
            <Button
              size="xs"
              variant={conflictsPanelPreferences.gateEnabled === false ? "secondary" : "ghost"}
              className="gap-1"
              title={conflictsPanelPreferences.gateEnabled === false
                ? gt("workbench.topToolbar.enableConflictsPanel", "重新启用冲突自动面板")
                : gt("workbench.topToolbar.showConflictsPanel", "显示冲突面板")}
              onClick={() => {
                showConflictsPanelByUser();
              }}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>{conflictsPanelPreferences.gateEnabled === false
                ? gt("workbench.topToolbar.enableConflictsPanelShort", "启用冲突面板")
                : gt("workbench.topToolbar.conflicts", "冲突")}</span>
            </Button>
          ) : null}
          <Button size="icon-sm" variant="ghost" onClick={() => void refreshAllAsync({ keepLog: false })} title={gt("workbench.common.refresh", "刷新")}>
            <RefreshCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="cf-git-banner cf-git-banner-danger flex items-center justify-between border-b border-[var(--cf-border)] bg-[var(--cf-red-light)] px-2 py-1 text-xs text-[var(--cf-red)]">
          <span className="truncate">{error}</span>
          <button className="rounded-apple-sm p-1 hover:bg-[var(--cf-surface-hover)]" onClick={() => setError("")}>{gt("workbench.common.close", "关闭")}</button>
        </div>
      ) : null}

      {updateSessionEntries.length > 0 ? (
        <div className="flex flex-col">
          {updateSessionEntries.map((entry) => (
            <div
              key={`update-session:${entry.requestId}`}
              className={cn(
                "cf-git-banner border-b border-[var(--cf-border)] px-2 py-2 text-xs",
                entry.tone === "danger"
                  ? "cf-git-banner-danger bg-[var(--cf-red-light)] text-[var(--cf-red)]"
                  : entry.tone === "warn"
                    ? "cf-git-banner-warn bg-[var(--cf-yellow-light)] text-[var(--cf-warning-foreground)]"
                    : "cf-git-banner-info bg-[var(--cf-accent-light)] text-[var(--cf-text-primary)]",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {entry.lifecycle === "running" ? (
                    <UpdateSessionProgressCard
                      message={entry.message}
                      snapshot={entry.snapshot}
                      expanded={entry.expanded}
                      consoleFocused={focusedUpdateSessionRequestId === entry.requestId}
                      onToggleExpanded={() => {
                        toggleUpdateSessionExpanded(entry.requestId);
                      }}
                      onFocusConsole={() => {
                        focusUpdateSessionConsole(entry.requestId);
                      }}
                      onPostAction={(action) => {
                        void handleUpdatePostActionAsync(entry.notification || null, action);
                      }}
                    />
                  ) : (entry.notification || entry.resultView) ? (
                    <ResultNotification
                      notification={entry.notification || null}
                      resultView={entry.resultView}
                      expanded={entry.expanded}
                      consoleFocused={focusedUpdateSessionRequestId === entry.requestId}
                      onToggleExpanded={() => {
                        toggleUpdateSessionExpanded(entry.requestId);
                      }}
                      onFocusConsole={() => {
                        focusUpdateSessionConsole(entry.requestId);
                      }}
                      onPostAction={(action) => {
                        void handleUpdatePostActionAsync(entry.notification || null, action);
                      }}
                    />
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{entry.message}</span>
                      {entry.lifecycle === "finished" ? (
                        <span className="shrink-0 text-[10px] opacity-75">{gt("workbench.notices.autoCloseIn30s", "30 秒后自动关闭")}</span>
                      ) : null}
                    </div>
                  )}
                </div>
                <button
                  className="shrink-0 rounded-apple-sm p-1 hover:bg-[var(--cf-surface-hover)]"
                  onClick={() => {
                    if (entry.lifecycle === "running" && !isUpdateSessionProgressSettled(entry.viewState)) {
                      void cancelRunningGitNoticeAsync({
                        id: entry.requestId,
                        requestId: entry.requestId,
                        action: "flow.pull",
                        tone: entry.tone,
                        message: entry.message,
                        running: true,
                        createdAt: entry.createdAt,
                      });
                      return;
                    }
                    removeUpdateSessionEntry(entry.requestId);
                  }}
                >
                  {entry.lifecycle === "running" && !isUpdateSessionProgressSettled(entry.viewState) ? gt("workbench.notices.cancel", "取消") : gt("workbench.common.close", "关闭")}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {gitNotices.length > 0 ? (
        <div className="flex flex-col">
          {gitNotices.map((notice) => (
            <div
              key={notice.id}
              className={cn(
                "cf-git-banner flex items-start justify-between gap-3 border-b border-[var(--cf-border)] px-2 py-1 text-xs",
                notice.tone === "danger"
                  ? "cf-git-banner-danger bg-[var(--cf-red-light)] text-[var(--cf-red)]"
                  : notice.tone === "warn"
                    ? "cf-git-banner-warn bg-[var(--cf-yellow-light)] text-[var(--cf-warning-foreground)]"
                    : "cf-git-banner-info bg-[var(--cf-accent-light)] text-[var(--cf-text-primary)]",
              )}
            >
              <div className="min-w-0 flex-1">
                {notice.updateNotification && !notice.running ? (
                  <ResultNotification
                    notification={notice.updateNotification}
                    resultView={null}
                    expanded={false}
                    consoleFocused={false}
                    onToggleExpanded={() => {}}
                    onFocusConsole={() => {
                      setBottomCollapsed(false);
                      setBottomTab("log");
                    }}
                    onPostAction={(action) => {
                      void handleUpdatePostActionAsync(notice.updateNotification!, action);
                    }}
                  />
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex min-w-0 items-start gap-2">
                      {notice.running ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 break-words font-medium leading-5">{notice.message}</span>
                          {!notice.running ? (
                            <span className="shrink-0 text-[10px] opacity-75">{gt("workbench.notices.autoCloseIn30s", "30 秒后自动关闭")}</span>
                          ) : null}
                        </div>
                        {notice.detailLines && notice.detailLines.length > 0 ? (
                          <div className="space-y-0.5 text-[11px] leading-5 opacity-85">
                            {notice.detailLines.map((line, index) => (
                              <div key={`${notice.id}:detail:${index}`} className="break-words">
                                {line}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {notice.actions && notice.actions.length > 0 ? (
                      <div className="flex flex-wrap gap-2 pl-5">
                        {notice.actions.map((actionItem) => (
                          <button
                            key={actionItem.id}
                            className="rounded-apple-sm border border-current/25 bg-white/30 px-2.5 py-1 text-[11px] font-medium opacity-95 transition hover:bg-white/45"
                            onClick={() => {
                              void Promise.resolve()
                                .then(() => actionItem.onClick())
                                .catch((err) => {
                                setError(toErrorText(err, gt("workbench.notices.actionFailed", "执行 Git 提示动作失败")));
                                });
                            }}
                          >
                            {actionItem.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
              <button
                className="shrink-0 rounded-apple-sm p-1 hover:bg-[var(--cf-surface-hover)]"
                onClick={() => {
                  if (isCancellableGitNotice(notice)) {
                    void cancelRunningGitNoticeAsync(notice);
                    return;
                  }
                  removeGitNotice(notice.id);
                }}
              >
                {isCancellableGitNotice(notice) ? gt("workbench.notices.cancel", "取消") : gt("workbench.common.close", "关闭")}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {isRepo ? (
        <OperationStateCard
          state={status?.operationState}
          unresolvedConflictCount={unresolvedConflictCount}
          resolvedConflictCount={resolvedConflictCount}
          submitting={operationStateSubmitting}
          continueLabelOverride={shouldUseCherryPickCommitCompletion ? gt("workbench.operationState.submitChanges", "提交更改") : undefined}
          hintOverride={shouldUseCherryPickCommitCompletion
            ? gt("workbench.operationState.cherryPickResolved", "所有冲突已解决，现在请提交更改以完成当前优选。")
            : undefined}
          onResolveConflicts={() => {
            openConflictResolverDialog({
              title: gt("workbench.operationState.resolveConflictsTitle", "解决当前操作冲突"),
              description: shouldUseCherryPickCommitCompletion
                ? gt("workbench.operationState.resolveConflictsDescriptionForCherryPick", "统一查看并处理当前仓库中的冲突文件；全部解决后，请提交更改以完成当前优选。")
                : gt("workbench.operationState.resolveConflictsDescription", "统一查看并处理当前仓库中的冲突文件；全部解决后可直接继续或中止当前 Git 操作。"),
            });
          }}
          onContinue={() => {
            if (enterCherryPickCommitCompletionMode({ focusEditor: true })) return;
            void submitOperationStateControlAsync("continue");
          }}
          onAbort={() => {
            void submitOperationStateControlAsync("abort");
          }}
        />
      ) : null}

      {!isRepo ? renderNoRepo() : (
        diffFullscreen && diff ? (
          <div className="min-h-0 flex flex-1 flex-col bg-[var(--cf-surface-solid)]">
            {renderDiffPanel(true)}
          </div>
        ) : (
          <>
            <div
              ref={upperLayoutRef}
              className="grid min-h-0 flex-1 overflow-hidden"
              style={{ gridTemplateColumns: `${leftCollapsed ? 0 : leftPanelWidth}px ${SPLITTER_SIZE}px minmax(0,1fr)` }}
            >
              <div className="h-full min-h-0 overflow-hidden">
                {renderCommitPanel()}
              </div>
              <div
                className={GIT_SPLITTER_CLASS + " cursor-col-resize"}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  draggingLayoutRef.current = {
                    kind: "main",
                    startX: event.clientX,
                    startLeftPanelWidth: leftCollapsed ? 0 : leftPanelWidth,
                    startBranchPanelWidth: branchPanelWidth,
                    startDetailPanelWidth: detailPanelWidth,
                  };
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  event.stopPropagation();
                  toggleLeftPanelCollapsed();
                }}
                title={gt("workbench.misc.splitter.main", "拖拽调整左右宽度；鼠标中键收起/展开左侧")}
              >
                <div className="mx-auto h-full w-px bg-[var(--cf-border)] transition-all duration-apple group-hover:bg-[var(--cf-accent)] group-hover:opacity-60" />
              </div>
              <div className="h-full min-h-0 overflow-hidden">
                {renderDiffPanel(false)}
              </div>
            </div>
            {renderBottomPanel()}
          </>
        )
      )}
      <div className="cf-git-footer flex h-7 shrink-0 items-center justify-between border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 text-[11px] text-[var(--cf-text-secondary)]">
        <div className="flex min-w-0 items-center gap-1.5">
          {gitBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--cf-accent)]" /> : null}
          <span className={`truncate ${gitBusy ? "text-[var(--cf-text-primary)]" : ""}`}>{gitStatusText}</span>
        </div>
        <div className="ml-3 truncate text-right">{repoRoot || repoPath}</div>
      </div>

      {renderBranchPopup()}
      {renderMenu()}
      {renderPushDialog()}
      {renderPushRejectedDialog()}
      {renderActionDialog()}
      {renderFetchDialog()}
      {renderInteractiveRebaseDialog()}
      {renderConflictResolverDialog()}
      {renderUpdateRuntimeScopeDialog()}
      {renderUpdateOptionsDialog()}
      {renderUpdateResetDialog()}
      {renderFixTrackedBranchDialog()}
      {renderRebaseWarningDialog()}
      {renderSmartOperationDialog()}
      {renderPullDialog()}
      {renderShelfRestoreDialog()}
      {renderRollbackViewerDialog()}
      {renderRollbackDiffOverlay()}
      {renderStageThreeWayDialog()}
      {renderBranchCompareFilesDialog()}
      {renderBranchRemoteManagerDialog()}
      <Dialog
        open={!!updateCommitRangeChoice}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setUpdateCommitRangeChoice(null);
        }}
      >
        <DialogContent className="cf-git-dialog-panel w-[720px] max-w-[calc(100vw-4rem)] p-0">
          <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
            <DialogTitle className="text-base">{gt("dialogs.updateCommitRanges.title", "查看更新提交")}</DialogTitle>
            <DialogDescription>
              {gt("dialogs.updateCommitRanges.description", "当前更新涉及多个仓库，请选择要查看的提交范围。")}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-auto px-5 py-4">
            {(updateCommitRangeChoice?.ranges || []).map((range) => (
              <div key={range.repoRoot} className="flex items-start justify-between gap-3 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface)] p-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="truncate">{range.rootName}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {gt("dialogs.updateCommitRanges.commitCount", "提交 {{count}}", { count: range.commitCount })}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      {gt("dialogs.updateCommitRanges.fileCount", "文件 {{count}}", { count: range.fileCount })}
                    </Badge>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">
                    {`${range.range.start.slice(0, 8)}..${range.range.end.slice(0, 8)}`}
                  </div>
                </div>
                <Button
                  size="xs"
                  onClick={() => {
                    if (!updateCommitRangeChoice?.notification) return;
                    openUpdateNotificationRange(updateCommitRangeChoice.notification, range);
                    setUpdateCommitRangeChoice(null);
                  }}
                >
                  {gt("dialogs.updateCommitRanges.viewCommits", "查看提交")}
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
