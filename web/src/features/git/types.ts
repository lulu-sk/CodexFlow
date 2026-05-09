// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type GitStatusEntry = {
  path: string;
  oldPath?: string;
  x: string;
  y: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  ignored: boolean;
  renamed: boolean;
  deleted: boolean;
  statusText: string;
  changeListId: string;
  conflictState?: "conflict" | "resolved";
  repositoryId?: string;
  repositoryRoot?: string;
  repositoryName?: string;
  repositoryExternal?: boolean;
  repositoryParentId?: string;
  moduleId?: string;
  moduleName?: string;
  moduleInternal?: boolean;
};

export type GitRollbackRequestChange = Pick<
  GitStatusEntry,
  "path" | "oldPath" | "x" | "y" | "staged" | "unstaged" | "untracked" | "ignored" | "renamed" | "deleted"
>;

export type GitViewOptions = {
  groupByDirectory: boolean;
  groupingKeys?: ReadonlyArray<"directory" | "module" | "repository">;
  availableGroupingKeys?: ReadonlyArray<"directory" | "module" | "repository">;
  showIgnored: boolean;
  detailsPreviewShown: boolean;
  diffPreviewOnDoubleClickOrEnter: boolean;
  manyFilesThreshold: number;
};

export type GitLocalChangesConfig = {
  stagingAreaEnabled: boolean;
  changeListsEnabled: boolean;
  commitAllEnabled?: boolean;
};

export type GitCommitAndPushPolicy = {
  previewOnCommitAndPush: boolean;
  previewProtectedOnly: boolean;
  protectedBranchPatterns: string[];
};

export type GitCommitHooksInfo = {
  available: boolean;
  availableRepoRoots: string[];
  disabledByPolicy: boolean;
  runByDefault: boolean;
};

export type GitChangeList = {
  id: string;
  name: string;
  comment?: string;
  data?: Record<string, any> | null;
  readOnly?: boolean;
  fileCount: number;
  files: string[];
};

export type GitMoveFilesToChangeListEntryState = {
  path: string;
  untracked: boolean;
  ignored: boolean;
};

export type GitStatusSnapshot = {
  repoRoot: string;
  branch?: string;
  detached: boolean;
  headSha?: string;
  defaultCommitAuthor?: string;
  stashPushPathspecSupported?: boolean;
  commitAndPush: GitCommitAndPushPolicy;
  commitHooks: GitCommitHooksInfo;
  operationState?: "normal" | "rebasing" | "merging" | "grafting" | "reverting";
  operationSuggestedCommitMessage?: string;
  entries: GitStatusEntry[];
  ignoredEntries: GitStatusEntry[];
  viewOptions: GitViewOptions;
  localChanges: GitLocalChangesConfig;
  changeLists: {
    activeListId: string;
    lists: GitChangeList[];
  };
};

export type GitIgnoredStatusSnapshot = {
  repoRoot: string;
  entries: GitStatusEntry[];
};

export type GitIgnoreTargetKind = "ignore-file" | "create-ignore-file" | "git-exclude";

export type GitIgnoreTarget = {
  id: string;
  kind: GitIgnoreTargetKind;
  label: string;
  description: string;
  targetPath: string;
  displayPath: string;
};

export type GitIgnoreTargetsSnapshot = {
  repoRoot: string;
  paths: string[];
  targets: GitIgnoreTarget[];
};

export type GitBranchSyncStatus = "untracked" | "synced" | "incoming" | "outgoing" | "diverged";

export type GitBranchSyncState = {
  upstream?: string;
  remote?: string;
  remoteBranch?: string;
  incoming?: number;
  outgoing?: number;
  hasUnfetched: boolean;
  gone?: boolean;
  status: GitBranchSyncStatus;
  tooltip?: string;
};

export type GitBranchItem = {
  name: string;
  hash?: string;
  upstream?: string;
  secondaryText?: string;
  favorite?: boolean;
  current?: boolean;
  repoRoot?: string;
  repositoryName?: string;
  sync?: GitBranchSyncState;
};

export type GitRemoteConfigItem = {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
};

export type GitBranchPopupRepository = {
  repoRoot: string;
  rootName: string;
  kind: "repository" | "submodule";
  currentBranch: string;
  detached: boolean;
  headSha?: string;
  syncEnabled: boolean;
  showOnlyMy?: boolean;
  remotes: GitRemoteConfigItem[];
  currentBranchSync?: GitBranchSyncState;
  groups: {
    favorites: GitBranchItem[];
    recent: GitBranchItem[];
    local: GitBranchItem[];
    remote: GitBranchItem[];
  };
};

export type GitBranchPopupSnapshot = {
  selectedRepoRoot: string;
  multiRoot: boolean;
  currentBranch: string;
  detached: boolean;
  headSha?: string;
  syncEnabled: boolean;
  showOnlyMy?: boolean;
  remotes: GitRemoteConfigItem[];
  currentBranchSync?: GitBranchSyncState;
  repositories: GitBranchPopupRepository[];
  dataContext: {
    selectedRepoRoot: string;
    affectedRepoRoots: string[];
  };
  quickActions: Array<{ id: string; label: string; shortcut?: string }>;
  groups: {
    favorites: GitBranchItem[];
    recent: GitBranchItem[];
    local: GitBranchItem[];
    remote: GitBranchItem[];
  };
};

export type GitUpdateMethod = "merge" | "rebase" | "reset";
export type GitUpdateOptionMethod = "merge" | "rebase";
export type GitUpdateSaveChangesPolicy = "stash" | "shelve";
export type GitUpdateSyncStrategy = "current" | "linked";
export type GitUpdateMethodResolvedSource = "explicit" | "branch-config" | "pull-config" | "fallback";
export type GitUpdateOptionsSource = "payload" | "stored";
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

export type GitUpdateTrackedBranchIssueCode =
  | "detached-head"
  | "no-tracked-branch"
  | "remote-missing";

export type GitUpdateTrackedBranchRemoteOption = {
  name: string;
  branches: string[];
};

export type GitUpdateTrackedBranchIssue = {
  repoRoot: string;
  rootName: string;
  kind: "repository" | "submodule";
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

export type GitShelfState =
  | "saved"
  | "restoring"
  | "restore-failed"
  | "restored"
  | "recycled"
  | "deleted"
  | "orphaned";

export type GitShelfViewState = {
  showRecycled: boolean;
  groupByDirectory: boolean;
};

export type GitShelfSource = "manual" | "system";

export type GitShelfItem = {
  ref: string;
  repoRoot: string;
  repoRoots: string[];
  message: string;
  createdAt: string;
  source: GitShelfSource;
  saveChangesPolicy: "shelve";
  state: GitShelfState;
  displayName: string;
  hasIndexPatch: boolean;
  hasWorktreePatch: boolean;
  hasUntrackedFiles: boolean;
  paths: string[];
  originalChangeListName?: string;
  lastError?: string;
};

export type GitManualShelveSelection = {
  selectedPaths: string[];
  availablePaths: string[];
  targetChangeListId?: string;
  targetChangeListName?: string;
  changeListsEnabled: boolean;
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

export type GitUpdateUnfinishedStateCode =
  | "rebase-in-progress"
  | "merge-in-progress"
  | "unmerged-files";

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

export type GitUpdateRepositoryKind = "repository" | "submodule";

export type GitUpdateSkipReasonCode =
  | "requested"
  | "detached-head"
  | "no-tracked-branch"
  | "remote-missing"
  | "parent-failed"
  | "fetch-failed"
  | "updated-by-parent";

export type GitUpdateSubmoduleMode = "branch" | "detached";
export type GitUpdateSubmoduleUpdateStrategy = "root" | "detached-updater" | "updated-by-parent";

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

export type GitUpdateExecutionPhase =
  | "repository-graph"
  | "preflight"
  | "tracked-branch-config"
  | "fetch"
  | "updater-selection"
  | "save-if-needed"
  | "root-update"
  | "result-aggregation";

export type GitUpdateRootResultCode =
  | "NOTHING_TO_UPDATE"
  | "SUCCESS"
  | "INCOMPLETE"
  | "CANCEL"
  | "ERROR"
  | "NOT_READY"
  | "SKIPPED";

export type GitUpdateSessionProgressRoot = {
  repoRoot: string;
  rootName: string;
  kind: GitUpdateRepositoryKind;
  parentRepoRoot?: string;
  currentPhase?: GitUpdateExecutionPhase;
  resultCode?: GitUpdateRootResultCode;
  failureCode?: GitUpdateTrackedBranchIssueCode | GitUpdateSkipReasonCode | "fetch-failed";
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

export type GitPushRejectedActionKind =
  | "update-with-merge"
  | "update-with-rebase"
  | "force-with-lease"
  | "force-push"
  | "cancel";

export type GitPushRejectedActionVariant = "primary" | "secondary" | "danger";

export type GitPushRejectedAction = {
  kind: GitPushRejectedActionKind;
  label: string;
  payloadPatch: Record<string, any>;
  variant?: GitPushRejectedActionVariant;
};

export type GitPushRejectedDecisionType =
  | "no-fast-forward"
  | "stale-info"
  | "rejected-other";

export type GitPushRejectedDecision = {
  type: GitPushRejectedDecisionType;
  title: string;
  description: string;
  detailText?: string;
  branch?: string;
  upstream?: string;
  remote?: string;
  remoteBranch?: string;
  actions: GitPushRejectedAction[];
};

export type GitDiffMode =
  | "working"
  | "staged"
  | "localToStaged"
  | "stagedToLocal"
  | "commit"
  | "revisionToRevision"
  | "revisionToWorking"
  | "parentToWorking"
  | "shelf"
  | "shelfToWorking";

export type GitDiffHunkLineKind = "context" | "add" | "del";

export type GitDiffHunkLine = {
  kind: GitDiffHunkLineKind;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export type GitDiffHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  preview: string;
  patch: string;
  lines: GitDiffHunkLine[];
};

export type GitDiffEditorSelectionSide = "original" | "modified";

export type GitDiffEditorSelection = {
  focusSide: GitDiffEditorSelectionSide | null;
  originalSelectedLines: number[];
  modifiedSelectedLines: number[];
  originalActiveLine?: number;
  modifiedActiveLine?: number;
};

export type GitDiffLineDecorations = {
  excludedOriginalLines: number[];
  excludedModifiedLines: number[];
};

export type GitDiffSnapshot = {
  path: string;
  oldPath?: string;
  mode: GitDiffMode;
  isBinary: boolean;
  tooLarge?: boolean;
  leftText?: string;
  rightText?: string;
  leftTitle: string;
  rightTitle: string;
  hash?: string;
  hashes?: string[];
  shelfRef?: string;
  selectionPaths?: string[];
  selectionKind?: "change" | "unversioned" | "mixed" | "single";
  selectionIndex?: number;
  patch?: string;
  patchHeader?: string;
  fingerprint?: string;
  hunks?: GitDiffHunk[];
};

export type GitConflictMergeSourceKey = "base" | "ours" | "theirs" | "working";

export type GitConflictMergeRevision = {
  label: string;
  text: string;
  available: boolean;
  isBinary?: boolean;
  tooLarge?: boolean;
};

export type GitConflictMergeBlockData = {
  index: number;
  kind: "change" | "conflict";
  conflictType: "INSERTED" | "DELETED" | "MODIFIED" | "CONFLICT";
  resolutionStrategy: GitConflictMergeResolutionStrategy;
  semanticResolverId: string | null;
  semanticResolvedText: string | null;
  isImportChange: boolean;
  changedInOurs: boolean;
  changedInTheirs: boolean;
  baseStart: number;
  baseEnd: number;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
};

export type GitConflictMergeResolutionStrategy = "DEFAULT" | "TEXT" | "SEMANTIC" | null;

export type GitConflictMergeTokenRange = {
  start: number;
  end: number;
};

export type GitConflictMergeImportEntry = {
  statement: string;
  importedSymbols: string[];
  moduleSpecifier: string | null;
  lineStart: number;
  lineEnd: number;
};

export type GitConflictMergeImportMetadata = {
  supported: boolean;
  autoResolveEnabled: boolean;
  baseRange: GitConflictMergeTokenRange | null;
  oursRange: GitConflictMergeTokenRange | null;
  theirsRange: GitConflictMergeTokenRange | null;
  oursEntries: GitConflictMergeImportEntry[];
  theirsEntries: GitConflictMergeImportEntry[];
};

export type GitConflictMergeMetadata = {
  blocks: GitConflictMergeBlockData[];
  importMetadata: GitConflictMergeImportMetadata | null;
  semanticResolverId: string | null;
};

export type GitConflictMergeSnapshot = {
  path: string;
  reverseSides?: boolean;
  base: GitConflictMergeRevision;
  ours: GitConflictMergeRevision;
  theirs: GitConflictMergeRevision;
  working: GitConflictMergeRevision;
  merge: GitConflictMergeMetadata;
};

export type GitConflictResolverRevision = Omit<GitConflictMergeRevision, "text">;

export type GitResolvedConflictHolder = {
  source: "resolve-undo";
  operationState: "normal" | "rebasing" | "merging" | "grafting" | "reverting";
  inUpdate: boolean;
  paths: string[];
};

export type GitConflictMergeSessionSideState = "modified" | "deleted" | "resolved";

export type GitConflictMergeSessionEntry = {
  path: string;
  fileName: string;
  directoryPath: string;
  conflictState: "unresolved" | "resolved";
  reverseSides: boolean;
  canOpenMerge: boolean;
  canOpenFile: boolean;
  oursState: GitConflictMergeSessionSideState;
  theirsState: GitConflictMergeSessionSideState;
  base: GitConflictResolverRevision;
  ours: GitConflictResolverRevision;
  theirs: GitConflictResolverRevision;
  working: GitConflictResolverRevision;
};

export type GitConflictMergeSessionSnapshot = {
  reverseSides: boolean;
  labels: {
    base: string;
    ours: string;
    theirs: string;
    working: string;
  };
  unresolvedCount: number;
  resolvedCount: number;
  unresolvedEntries: GitConflictMergeSessionEntry[];
  resolvedEntries: GitConflictMergeSessionEntry[];
  entries: GitConflictMergeSessionEntry[];
  resolvedHolder: GitResolvedConflictHolder;
};

export type GitConflictResolverActionResult = {
  appliedPaths: string[];
};

export type GitLogItem = {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  subject: string;
  decorations: string;
  containedInCurrentBranch?: boolean;
  historyPath?: string;
};

export type GitLogPage = {
  items: GitLogItem[];
  graphItems?: GitLogItem[];
  nextCursor: number;
  hasMore: boolean;
};

export type GitLogFilters = {
  text: string;
  caseSensitive: boolean;
  matchMode: "fuzzy" | "exact" | "regex";
  branch: string;
  branchValues?: string[];
  author: string;
  authorValues?: string[];
  dateFrom: string;
  dateTo: string;
  path: string;
  revision: string;
  followRenames: boolean;
};

export type GitLogActionAvailabilityKey =
  | "copyRevision"
  | "createPatch"
  | "cherryPick"
  | "checkoutRevision"
  | "showRepoAtRevision"
  | "compareLocal"
  | "reset"
  | "revert"
  | "undoCommit"
  | "editMessage"
  | "fixup"
  | "squashTo"
  | "squashCommits"
  | "deleteCommit"
  | "interactiveRebase"
  | "pushAllPrevious"
  | "newBranch"
  | "newTag";

export type GitLogActionAvailabilityItem = {
  enabled: boolean;
  reason?: string;
};

export type GitLogActionAvailability = {
  selectionCount: number;
  single: boolean;
  headHash?: string;
  isHeadCommit: boolean;
  hasMergeCommit: boolean;
  hasRootCommit: boolean;
  hasLocalChanges: boolean;
  isAncestorOfHead: boolean;
  isPublishedToUpstream: boolean;
  actions: Record<GitLogActionAvailabilityKey, GitLogActionAvailabilityItem>;
};

export type GitLogDetailsSingle = {
  mode: "single";
  detail: {
    hash: string;
    shortHash: string;
    parents: string[];
    authorName: string;
    authorEmail: string;
    authorDate: string;
    subject: string;
    body: string;
    files: GitChangedFile[];
    lineStats: {
      additions: number;
      deletions: number;
    };
    branches: string[];
    tags: string[];
  };
};

export type GitLogDetailsMulti = {
  mode: "multiple";
  selectedCount: number;
  files: Array<{ path: string; count: number; status?: string; oldPath?: string; hashes: string[] }>;
};

export type GitLogDetails = GitLogDetailsSingle | GitLogDetailsMulti;

export type GitChangedFile = {
  status: string;
  path: string;
  oldPath?: string;
};

export type GitBranchCompareFilesResult = {
  repoRoot: string;
  leftRef: string;
  rightRef?: string;
  files: GitChangedFile[];
};

export type GitCommitDetailsActionKey =
  | "editSource"
  | "openRepositoryVersion"
  | "revertSelectedChanges"
  | "applySelectedChanges"
  | "extractSelectedChanges"
  | "dropSelectedChanges"
  | "showHistoryForRevision";

export type GitCommitDetailsActionItem = {
  visible: boolean;
  enabled: boolean;
  reason?: string;
};

export type GitCommitDetailsActionAvailability = {
  actions: Record<GitCommitDetailsActionKey, GitCommitDetailsActionItem>;
};

export type GitCommitDetailsSelectionChange = {
  path: string;
  oldPath?: string;
  status?: string;
};

export type GitLogMessageDraft = {
  action: "editMessage" | "squashCommits";
  message: string;
};

export type GitInteractiveRebaseAction = "pick" | "edit" | "reword" | "squash" | "fixup" | "drop";

export type GitInteractiveRebaseWarningCode = "autosquash" | "update-refs";

export type GitInteractiveRebaseWarning = {
  code: GitInteractiveRebaseWarningCode;
  title: string;
  message: string;
};

export type GitInteractiveRebaseEntry = {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorDate: string;
  fullMessage: string;
  action: GitInteractiveRebaseAction;
  message?: string;
  originalIndex: number;
  autosquashCandidate?: boolean;
};

export type GitInteractiveRebasePlan = {
  targetHash: string;
  headHash: string;
  baseHash?: string;
  rootMode: boolean;
  entries: GitInteractiveRebaseEntry[];
  warnings?: GitInteractiveRebaseWarning[];
  reasonCode?: string;
  reasonMessage?: string;
};

export type GitInteractiveRebasePlanFailure = {
  entries?: never;
  reasonCode: string;
  reasonMessage: string;
};

export type GitInteractiveRebasePlanResult = GitInteractiveRebasePlan | GitInteractiveRebasePlanFailure;

export type GitHistoryRewriteAction =
  | "interactive-rebase"
  | "edit-message"
  | "delete-commit"
  | "extract-selected-changes"
  | "drop-selected-changes";

export type GitHistoryRewriteTone = "info" | "warn" | "danger";

export type GitHistoryRewriteUndoPayload = {
  kind: "delete-commit";
  repoRoot?: string;
  oldHead: string;
  newHead: string;
};

export type GitHistoryRewriteUndoInfo = {
  label?: string;
  payload: GitHistoryRewriteUndoPayload;
};

export type GitHistoryRewriteFeedback = {
  action: GitHistoryRewriteAction;
  tone: GitHistoryRewriteTone;
  title: string;
  message: string;
  detailLines?: string[];
  undo?: GitHistoryRewriteUndoInfo;
  reasonCode?: string;
  operationState?: "normal" | "rebasing" | "merging" | "grafting" | "reverting";
  shouldRefresh?: boolean;
  completed?: boolean;
};

export type GitStashItem = {
  ref: string;
  hash: string;
  date: string;
  message: string;
};

export type GitWorktreeItem = {
  path: string;
  bare: boolean;
  detached: boolean;
  branch?: string;
  head?: string;
  locked?: string;
  prunable?: string;
};

export type GitPushCommit = {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  subject: string;
  parents: string[];
  files?: GitChangedFile[];
};

export type GitPushPreview = {
  headHash?: string;
  targetHash?: string;
  detached: boolean;
  branch?: string;
  upstream?: string;
  remote?: string;
  remoteBranch?: string;
  protectedTarget?: boolean;
  canPush: boolean;
  disabledReason?: string;
  pushRef: string;
  commitCount: number;
  commits: GitPushCommit[];
  files: GitChangedFile[];
};

export type GitPostCommitPushResult =
  | {
      mode: "preview";
      context: {
        repoRoots: string[];
        commitHashes: Array<{ repoRoot: string; commitHash: string }>;
        targetHash?: string;
      };
      protectedTarget?: boolean;
    }
  | {
      mode: "pushed";
      results: Array<{
        repoRoot: string;
        commitHash: string;
        remote?: string;
        remoteBranch?: string;
        upstream?: string;
      }>;
    }
  | {
      mode: "failed";
      repoRoot?: string;
      commitHash?: string;
      error: string;
    };

export type GitConsoleEntry = {
  id: number;
  timestamp: number;
  cwd: string;
  repoRootKey: string;
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
  running?: boolean;
};
