// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitExecResult } from "../exec";

export type GitUpdateFeatureContext = {
  action: string;
  requestId: number;
  gitPath: string;
  userDataPath: string;
  emitProgress?: (payload: {
    requestId: number;
    action: string;
    repoRoot?: string;
    message: string;
    detail?: string;
    updateSession?: GitUpdateSessionProgressSnapshot;
  }) => void;
};

export type GitUpdateActionResult = {
  ok: boolean;
  data?: any;
  error?: string;
};

export type GitUpdateMethod = "merge" | "rebase" | "reset";
export type GitUpdateOptionMethod = "merge" | "rebase";
export type GitUpdateSaveChangesPolicy = "stash" | "shelve";
export type GitUpdateSyncStrategy = "current" | "linked";
export type GitUpdateOptionsSource = "payload" | "stored";
export type GitUpdateMethodResolvedSource = "explicit" | "branch-config" | "pull-config" | "fallback";
export type GitPullOptionKey = "rebase" | "ffOnly" | "noFf" | "squash" | "noCommit" | "noVerify";

export type GitPullOptions = {
  mode: GitUpdateOptionMethod;
  options: GitPullOptionKey[];
};

export type GitPullCapabilities = {
  noVerify: boolean;
};

export type GitUpdateScopeOptions = {
  syncStrategy: GitUpdateSyncStrategy;
  linkedRepoRoots: string[];
  skippedRepoRoots: string[];
  includeNestedRoots: boolean;
  rootScanMaxDepth: number;
};

export type GitUpdateOptions = {
  updateMethod: GitUpdateOptionMethod;
  saveChangesPolicy: GitUpdateSaveChangesPolicy;
  scope: GitUpdateScopeOptions;
  pull?: GitPullOptions;
};

export type GitUpdateMethodResolution = {
  selectedMethod: GitUpdateMethod;
  selectionSource: GitUpdateOptionsSource;
  resolvedMethod: GitUpdateMethod;
  resolvedSource: GitUpdateMethodResolvedSource;
  currentBranch?: string;
  currentUpstream?: string;
  currentRemote?: string;
  currentRemoteBranch?: string;
  branchRebaseKey?: string;
  branchRebaseValue?: string;
  pullRebaseValue?: string;
  saveChangesPolicy: GitUpdateSaveChangesPolicy;
};

export type GitUpdateOptionsSnapshot = {
  options: GitUpdateOptions;
  methodResolution: GitUpdateMethodResolution;
  scopePreview: GitUpdateScopePreview;
  pullCapabilities: GitPullCapabilities;
};

export type GitUpdateSuccessOptions = {
  fastForwardOptimized?: boolean;
  savedLocalChanges?: boolean;
  restoredLocalChanges?: boolean;
  preservedLocalChanges?: boolean;
  preservingState?: GitUpdatePreservingState;
};

export type GitSavedLocalChanges = {
  repoRoot?: string;
  ref: string;
  message: string;
  saveChangesPolicy: GitUpdateSaveChangesPolicy;
  displayName: string;
};

export type GitUpdateTrackedUpstream = {
  remote: string;
  branch: string;
};

export type GitTrackedRemoteRef = GitUpdateTrackedUpstream & {
  upstream: string;
};

export type GitUpdateFetchStrategy =
  | "tracked-remote"
  | "default-remote"
  | "all-remotes";

export type GitUpdateFetchStatus =
  | "success"
  | "failed"
  | "skipped"
  | "cancelled";

export type GitUpdateFetchFailure = {
  remote: string;
  error: string;
};

export type GitUpdateFetchResult = {
  status: GitUpdateFetchStatus;
  strategy: GitUpdateFetchStrategy;
  remotes: string[];
  fetchedRemotes: string[];
  failedRemotes: GitUpdateFetchFailure[];
  upstream?: string;
  trackedRemote?: string;
  skippedReason?: string;
  error?: string;
};

export type GitUpdateTrackedBranchSource = "config" | "override";

export type GitUpdateTrackedBranchOverride = {
  localBranch: string;
  remote: string;
  remoteBranch: string;
  upstream: string;
  setAsTracked?: boolean;
};

export type GitUpdateProblemFileListKind =
  | "local-changes-overwritten"
  | "untracked-overwritten";

export type GitUpdateProblemOperation = "merge" | "reset" | "checkout" | "cherry-pick";

export type GitUpdateProblemFileList = {
  operation: GitUpdateProblemOperation;
  kind: GitUpdateProblemFileListKind;
  title: string;
  description: string;
  files: string[];
};

export type GitUpdateMergeFailureType =
  | "CONFLICT"
  | "LOCAL_CHANGES"
  | "UNTRACKED"
  | "OTHER";

export type GitUpdateProblemSource =
  | "smart-operation"
  | "merge-failure"
  | "branch-switch";

export type GitUpdateOperationProblemKind =
  | GitUpdateProblemFileListKind
  | "merge-conflict";

export type GitUpdateProblemActionKind =
  | "smart"
  | "force"
  | "rollback";

export type GitUpdateProblemActionVariant = "primary" | "secondary" | "danger";

export type GitUpdateProblemAction = {
  kind: GitUpdateProblemActionKind;
  label: string;
  description?: string;
  payloadPatch: Record<string, any>;
  variant?: GitUpdateProblemActionVariant;
};

export type GitUpdateOperationProblem = {
  operation: GitUpdateProblemOperation;
  kind: GitUpdateOperationProblemKind;
  title: string;
  description: string;
  files: string[];
  source: GitUpdateProblemSource;
  repoRoot?: string;
  rootName?: string;
  mergeFailureType?: GitUpdateMergeFailureType;
  actions: GitUpdateProblemAction[];
};

export type GitUpdateMergeFailure = {
  type: GitUpdateMergeFailureType;
  message: string;
  fileList?: GitUpdateProblemFileList;
  problem?: GitUpdateOperationProblem;
};

export type GitUpdateRebaseWarningType =
  | "published-commits"
  | "merge-commits";

export type GitUpdateRebaseWarningAction = {
  label: string;
  payloadPatch: Record<string, any>;
};

export type GitUpdateRebaseWarning = {
  type: GitUpdateRebaseWarningType;
  title: string;
  description: string;
  details?: string;
  totalCommitCount?: number;
  publishedCommitCount?: number;
  mergeCommitCount?: number;
  confirmAction: GitUpdateRebaseWarningAction;
  alternativeAction?: GitUpdateRebaseWarningAction;
  cancelText: string;
};

export type GitUpdateUnfinishedStateCode =
  | "rebase-in-progress"
  | "merge-in-progress"
  | "unmerged-files";

export type GitUpdatePreflightErrorCode =
  | GitUpdateUnfinishedStateCode
  | "detached-head"
  | "no-tracked-branch";

export type GitUpdateUnfinishedStateStage = "preflight" | "update";

export type GitUpdateLocalChangesRestorePolicy = "not-applicable" | "restore" | "keep-saved";

export type GitUpdatePreservingStatus =
  | "not-needed"
  | "saved"
  | "restored"
  | "kept-saved"
  | "restore-failed";

export type GitUpdatePreservingNotRestoredReason =
  | "unfinished-state"
  | "restore-failed"
  | "manual-decision";

export type GitUpdateConflictResolverDialog = {
  title: string;
  description: string;
  repoRoot?: string;
  reverseMerge?: boolean;
};

export type GitUpdatePreservingState = {
  saveChangesPolicy: GitUpdateSaveChangesPolicy;
  status: GitUpdatePreservingStatus;
  localChangesRestorePolicy: GitUpdateLocalChangesRestorePolicy;
  savedLocalChangesRef?: string;
  savedLocalChangesDisplayName?: string;
  message?: string;
  notRestoredReason?: GitUpdatePreservingNotRestoredReason;
  savedChangesAction?: GitUpdatePostAction;
  resolveConflictsAction?: GitUpdatePostAction;
  conflictResolverDialog?: GitUpdateConflictResolverDialog;
};

export type GitUpdateUnfinishedState = {
  code: GitUpdateUnfinishedStateCode;
  stage: GitUpdateUnfinishedStateStage;
  localChangesRestorePolicy: GitUpdateLocalChangesRestorePolicy;
  savedLocalChangesRef?: string;
  message: string;
};

export type GitUpdatePreflightResult =
  | {
      ok: true;
      branch: string;
      upstream: string;
      upstreamPair: GitUpdateTrackedUpstream | null;
      trackedSource?: GitUpdateTrackedBranchSource;
    }
  | {
      ok: false;
      code: GitUpdatePreflightErrorCode;
      error: string;
      branch?: string;
      unfinishedState?: GitUpdateUnfinishedState;
    };

export type GitUpdateResultCode =
  | "NOTHING_TO_UPDATE"
  | "SUCCESS"
  | "INCOMPLETE"
  | "CANCEL"
  | "ERROR"
  | "NOT_READY";

export type GitUpdateExecutionPhase =
  | "repository-graph"
  | "preflight"
  | "tracked-branch-config"
  | "fetch"
  | "updater-selection"
  | "save-if-needed"
  | "root-update"
  | "result-aggregation";

export type GitUpdateExecutionPhaseStatus = "running" | "completed" | "cancelled";

export type GitUpdateExecutionPhaseRecord = {
  phase: GitUpdateExecutionPhase;
  status: GitUpdateExecutionPhaseStatus;
  message: string;
  repoRoot?: string;
  startedAt: number;
  finishedAt: number;
};

export type GitUpdateRepositoryKind = "repository" | "submodule";
export type GitUpdateSubmoduleMode = "branch" | "detached";
export type GitUpdateSubmoduleUpdateStrategy = "root" | "detached-updater" | "updated-by-parent";

export type GitUpdateSkipReasonCode =
  | "requested"
  | "detached-head"
  | "no-tracked-branch"
  | "remote-missing"
  | "parent-failed"
  | "fetch-failed"
  | "updated-by-parent";

export type GitUpdateSubmoduleUpdate = {
  mode: GitUpdateSubmoduleMode;
  strategy: GitUpdateSubmoduleUpdateStrategy;
  parentRepoRoot?: string;
  relativePath?: string;
  recursive: boolean;
  detachedHead: boolean;
};

export type GitUpdateCommitRange = {
  start: string;
  end: string;
};

export type GitUpdateTrackedBranchIssueCode =
  | "detached-head"
  | "no-tracked-branch"
  | "remote-missing";

export type GitUpdateSkippedRoot = {
  repoRoot: string;
  rootName: string;
  kind: GitUpdateRepositoryKind;
  parentRepoRoot?: string;
  reasonCode: GitUpdateSkipReasonCode;
  reason: string;
};

export type GitUpdateScopePreviewSource = "current" | "linked" | "nested" | "submodule";

export type GitUpdateScopePreviewRoot = {
  repoRoot: string;
  rootName: string;
  kind: GitUpdateRepositoryKind;
  parentRepoRoot?: string;
  depth: number;
  detachedHead: boolean;
  source: GitUpdateScopePreviewSource;
  included: boolean;
};

export type GitUpdateScopePreview = {
  requestedRepoRoot: string;
  multiRoot: boolean;
  roots: GitUpdateScopePreviewRoot[];
  includedRepoRoots: string[];
  skippedRoots: GitUpdateSkippedRoot[];
};

export type GitUpdateNotificationRange = {
  repoRoot: string;
  rootName: string;
  branch?: string;
  upstream?: string;
  method?: string;
  range: GitUpdateCommitRange;
  commitCount: number;
  fileCount: number;
};

export type GitUpdatePostAction = {
  kind: string;
  label: string;
  repoRoot?: string;
  revision?: string;
  payload?: Record<string, any>;
};

export type GitUpdateSessionNotificationData = {
  title: string;
  description?: string;
  updatedFilesCount: number;
  receivedCommitsCount: number;
  filteredCommitsCount?: number;
  ranges: GitUpdateNotificationRange[];
  primaryRange?: GitUpdateNotificationRange;
  skippedRoots: GitUpdateSkippedRoot[];
  postActions: GitUpdatePostAction[];
};

export type GitUpdateRepositoryNode = {
  repoRoot: string;
  rootName: string;
  kind: GitUpdateRepositoryKind;
  submoduleMode?: GitUpdateSubmoduleMode;
  parentRepoRoot?: string;
  depth: number;
  detachedHead: boolean;
  headSha?: string;
  requestedSkip?: GitUpdateSkippedRoot;
};

export type GitUpdateRepositoryGraph = {
  requestedRepoRoot: string;
  roots: GitUpdateRepositoryNode[];
  discoveredRepoRoots: string[];
};

export type GitUpdateRootResultCode = GitUpdateResultCode | "SKIPPED";

export type GitUpdateRootSessionResult = {
  repoRoot: string;
  rootName: string;
  kind: GitUpdateRepositoryKind;
  submoduleUpdate?: GitUpdateSubmoduleUpdate;
  parentRepoRoot?: string;
  ok: boolean;
  resultCode: GitUpdateRootResultCode;
  branch?: string;
  upstream?: string;
  method?: GitUpdateMethod | "none" | "fetch" | string;
  configuredMethod?: GitUpdateMethod;
  methodResolvedSource?: GitUpdateMethodResolvedSource;
  nothingToUpdate?: boolean;
  error?: string;
  data?: any;
  failureCode?: GitUpdatePreflightErrorCode | GitUpdateSkipReasonCode;
  skippedReason?: string;
  skippedReasonCode?: GitUpdateSkipReasonCode;
  fetchResult?: GitUpdateFetchResult;
  updatedRange?: GitUpdateCommitRange;
  unfinishedState?: GitUpdateUnfinishedState;
  localChangesRestorePolicy?: GitUpdateLocalChangesRestorePolicy;
  preservingState?: GitUpdatePreservingState;
};

export type GitUpdateExecutionRootState = {
  repoRoot: string;
  rootName?: string;
  kind?: GitUpdateRepositoryKind;
  parentRepoRoot?: string;
  currentPhase?: GitUpdateExecutionPhase;
  phaseHistory: GitUpdateExecutionPhaseRecord[];
  resultCode?: GitUpdateRootResultCode;
  failureCode?: GitUpdatePreflightErrorCode | GitUpdateSkipReasonCode;
  skippedReason?: string;
  skippedReasonCode?: GitUpdateSkipReasonCode;
  submoduleUpdate?: GitUpdateSubmoduleUpdate;
  fetchResult?: GitUpdateFetchResult;
  updatedRange?: GitUpdateCommitRange;
  unfinishedState?: GitUpdateUnfinishedState;
  localChangesRestorePolicy?: GitUpdateLocalChangesRestorePolicy;
  preservingState?: GitUpdatePreservingState;
  operationProblem?: GitUpdateOperationProblem;
};

export type GitUpdateSessionProgressRoot = {
  repoRoot: string;
  rootName: string;
  kind: GitUpdateRepositoryKind;
  parentRepoRoot?: string;
  currentPhase?: GitUpdateExecutionPhase;
  resultCode?: GitUpdateRootResultCode;
  failureCode?: GitUpdatePreflightErrorCode | GitUpdateSkipReasonCode;
  skippedReason?: string;
  skippedReasonCode?: GitUpdateSkipReasonCode;
  fetchResult?: GitUpdateFetchResult;
  unfinishedState?: GitUpdateUnfinishedState;
  preservingState?: GitUpdatePreservingState;
  submoduleUpdate?: GitUpdateSubmoduleUpdate;
  operationProblem?: GitUpdateOperationProblem;
};

export type GitUpdateSessionProgressSnapshot = {
  requestedRepoRoot: string;
  currentPhase?: GitUpdateExecutionPhase;
  activeRepoRoot?: string;
  activeRootName?: string;
  activePhase?: GitUpdateExecutionPhase;
  cancelled: boolean;
  cancelReason?: string;
  totalRoots: number;
  completedRoots: number;
  runningRoots: number;
  remainingRoots: number;
  multiRoot: boolean;
  roots: GitUpdateSessionProgressRoot[];
};

export type GitUpdateCompoundResult = {
  resultCode: GitUpdateResultCode;
  successRoots: string[];
  failedRoots: string[];
  skippedRoots: GitUpdateSkippedRoot[];
  fetchSuccessRoots: string[];
  fetchFailedRoots: string[];
  fetchSkippedRoots: string[];
  nothingToUpdateRoots: string[];
  updatedRoots: string[];
  executedRoots: string[];
  multiRoot: boolean;
  rootResults: GitUpdateRootSessionResult[];
};

export type GitUpdateExecutionSession = {
  requestedRepoRoot: string;
  currentPhase?: GitUpdateExecutionPhase;
  phaseHistory: GitUpdateExecutionPhaseRecord[];
  rootStates: Record<string, GitUpdateExecutionRootState>;
  cancelled: boolean;
  cancelReason?: string;
  compoundResult?: GitUpdateCompoundResult;
};

export type GitUpdateAggregatedSession = {
  resultCode: GitUpdateResultCode;
  roots: GitUpdateRootSessionResult[];
  successRoots: string[];
  failedRoots: string[];
  skippedRoots: GitUpdateSkippedRoot[];
  fetchSuccessRoots: string[];
  fetchFailedRoots: string[];
  fetchSkippedRoots: string[];
  nothingToUpdateRoots: string[];
  updatedRoots: string[];
  executedRoots: string[];
  multiRoot: boolean;
  notification?: GitUpdateSessionNotificationData;
  compoundResult?: GitUpdateCompoundResult;
  session?: GitUpdateExecutionSession;
};

export type GitUpdateTrackedBranchRemoteOption = {
  name: string;
  branches: string[];
};

export type GitUpdateTrackedBranchIssue = {
  repoRoot: string;
  rootName: string;
  kind: GitUpdateRepositoryKind;
  parentRepoRoot?: string;
  issueCode: GitUpdateTrackedBranchIssueCode;
  message: string;
  branch?: string;
  currentUpstream?: string;
  currentRemote?: string;
  currentRemoteBranch?: string;
  suggestedRemote?: string;
  suggestedRemoteBranch?: string;
  suggestedLocalBranchName?: string;
  detachedHead?: boolean;
  remoteOptions: GitUpdateTrackedBranchRemoteOption[];
  canFix: boolean;
  canSetAsTracked: boolean;
};

export type GitUpdateTrackedBranchPreview = {
  requestedRepoRoot: string;
  multiRoot: boolean;
  defaultUpdateMethod: GitUpdateOptionMethod;
  issues: GitUpdateTrackedBranchIssue[];
  hasFixableIssues: boolean;
};

export type GitUpdateTrackedBranchSelection = {
  repoRoot: string;
  remote?: string;
  remoteBranch?: string;
  setAsTracked?: boolean;
};

export type GitUpdateTrackedBranchApplyResult = {
  updatePayloadPatch: {
    updateTrackedBranches: Record<string, GitUpdateTrackedBranchOverride>;
    updateMethod: GitUpdateOptionMethod;
  };
  appliedRoots: string[];
  persistedRoots: string[];
};

export type GitUpdatePreservingRuntime = {
  ctx: GitUpdateFeatureContext;
  repoRoot: string;
  hasLocalChangesAsync(): Promise<boolean>;
  runGitExecAsync(argv: string[], timeoutMs?: number): Promise<GitExecResult>;
  runGitSpawnAsync(argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult>;
  emitProgress(message: string, detail?: string): void;
  toGitErrorMessage(res: GitExecResult, fallback: string): string;
  isRebaseInProgressAsync(): Promise<boolean>;
  isMergeInProgressAsync(): Promise<boolean>;
  hasUnmergedFilesAsync(): Promise<boolean>;
};

export type GitUpdateFinalizeRuntime = {
  repoRoot: string;
  restoreLocalChangesAfterUpdateAsync(
    saved: GitSavedLocalChanges | null,
  ): Promise<{ ok: true; preservingState?: GitUpdatePreservingState } | { ok: false; error: string; preservingState: GitUpdatePreservingState }>;
  notifyLocalChangesAreNotRestored(
    saved: GitSavedLocalChanges,
    reason: GitUpdatePreservingNotRestoredReason,
    error?: string,
  ): GitUpdatePreservingState;
  detectIncompleteUpdateStateAsync(saved: GitSavedLocalChanges | null): Promise<GitUpdateUnfinishedState | null>;
  toGitErrorMessage(res: GitExecResult, fallback: string): string;
};

export type GitUpdateCommonRuntime = GitUpdateFinalizeRuntime & {
  ctx: GitUpdateFeatureContext;
  repoRoot: string;
  emitProgress(message: string, detail?: string): void;
  runGitExecAsync(argv: string[], timeoutMs?: number): Promise<GitExecResult>;
  runGitSpawnAsync(argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult>;
  toGitErrorMessage(res: GitExecResult, fallback: string): string;
  isRebaseInProgressAsync(): Promise<boolean>;
  isMergeInProgressAsync(): Promise<boolean>;
  hasUnmergedFilesAsync(): Promise<boolean>;
  saveLocalChangesForUpdateAsync(
    reason: string,
    saveChangesPolicy: GitUpdateSaveChangesPolicy,
  ): Promise<{ ok: true; saved: GitSavedLocalChanges | null } | { ok: false; error: string }>;
};

export type GitUpdateRebaseRuntime = GitUpdateCommonRuntime & {
  hasLocalChangesAsync(): Promise<boolean>;
  isCancellationRequested(): boolean;
  getCancellationReason(): string | undefined;
  abortRebaseUpdateAsync(): Promise<{ ok: true } | { ok: false; error: string }>;
};

export type GitUpdateMergeRuntime = GitUpdateCommonRuntime & {
  shouldSaveLocalChangesForMergeAsync(currentBranch: string, upstreamRef: string): Promise<boolean>;
  buildMergeUpdateArgv(upstreamRef: string, payload: any): string[];
  isCancellationRequested(): boolean;
  getCancellationReason(): string | undefined;
  cancelMergeUpdateAsync(): Promise<{ ok: true } | { ok: false; error: string }>;
};

export type GitUpdateResetRuntime = GitUpdateCommonRuntime & {
  hasLocalChangesAsync(): Promise<boolean>;
};

export type GitUpdateSubmoduleRuntime = GitUpdateCommonRuntime & {
  parentRepoRoot: string;
  submoduleRepoRoot: string;
  isCancellationRequested(): boolean;
  getCancellationReason(): string | undefined;
};

export type GitUpdateRootRuntime = {
  repoRoot: string;
  emitProgress(message: string, detail?: string, updateSession?: GitUpdateSessionProgressSnapshot): void;
  isCancellationRequested(): boolean;
  getCancellationReason(): string | undefined;
  prepareUpdateProjectContextAsync(payload?: any): Promise<GitUpdatePreflightResult>;
  runGitExecAsync(argv: string[], timeoutMs?: number): Promise<GitExecResult>;
  runGitSpawnAsync(argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult>;
  toGitErrorMessage(res: GitExecResult, fallback: string): string;
  listRemoteNamesAsync(): Promise<string[] | null>;
  getPreferredRemoteAsync(remoteNames?: string[] | null): Promise<string>;
  resolveBranchTrackedRemoteAsync(branch: string): Promise<GitTrackedRemoteRef | null>;
  hasRemoteTrackingRefAsync(remote: string, branch: string): Promise<boolean>;
  hasRemoteChangesAsync(upstreamRef: string): Promise<boolean>;
  resolvePullUpdateMethodAsync(payload: any): Promise<GitUpdateMethodResolution>;
};

export type GitUpdateRepositoryGraphRuntime = {
  repoRoot: string;
  runGitExecAsync(repoRoot: string, argv: string[], timeoutMs?: number): Promise<GitExecResult>;
};

export type GitUpdateConfigRuntime = GitUpdateRepositoryGraphRuntime & {
  userDataPath: string;
  runGitSpawnAsync(repoRoot: string, argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult>;
  emitProgress?(repoRoot: string, message: string, detail?: string): void;
  toGitErrorMessage(res: GitExecResult, fallback: string): string;
};

export type GitUpdateOrchestratorRuntime = {
  repoRoot: string;
  userDataPath: string;
  gitPath?: string;
  emitProgress(message: string, detail?: string): void;
  isCancellationRequested(): boolean;
  getCancellationReason(): string | undefined;
  createRootRuntime(repoRoot: string): GitUpdateRootRuntime;
  createRebaseRuntime(repoRoot: string): GitUpdateRebaseRuntime;
  createMergeRuntime(repoRoot: string): GitUpdateMergeRuntime;
  createResetRuntime(repoRoot: string): GitUpdateResetRuntime;
  createSubmoduleRuntime(parentRepoRoot: string, submoduleRepoRoot: string): GitUpdateSubmoduleRuntime;
  repositoryGraphRuntime: GitUpdateRepositoryGraphRuntime;
  runGitExecAsync(repoRoot: string, argv: string[], timeoutMs?: number): Promise<GitExecResult>;
  runGitSpawnAsync(repoRoot: string, argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult>;
  runGitStdoutToFileAsync(repoRoot: string, argv: string[], targetPath: string, timeoutMs?: number): Promise<GitExecResult>;
  toGitErrorMessage(res: GitExecResult, fallback: string): string;
};
