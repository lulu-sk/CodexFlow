// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type GitCommitPanelStatusEntry = {
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

export type GitCommitPanelViewOptions = {
  groupByDirectory: boolean;
  groupingKeys?: ReadonlyArray<"directory" | "module" | "repository">;
  availableGroupingKeys?: ReadonlyArray<"directory" | "module" | "repository">;
  showIgnored: boolean;
  detailsPreviewShown: boolean;
  diffPreviewOnDoubleClickOrEnter: boolean;
  manyFilesThreshold: number;
};

export type GitCommitPanelLocalChangesConfig = {
  stagingAreaEnabled: boolean;
  changeListsEnabled: boolean;
  commitAllEnabled?: boolean;
};

export type GitCommitPanelCapabilityState = GitCommitPanelLocalChangesConfig;

export type ChangeListItem = {
  id: string;
  name: string;
  comment?: string;
  data?: Record<string, any> | null;
  readOnly?: boolean;
  files: string[];
  createdAt: number;
  updatedAt: number;
};

export type RepoChangeLists = {
  repoRoot: string;
  activeListId: string;
  lists: ChangeListItem[];
  fileToList: Record<string, string>;
};

export type ChangeListsStore = {
  version: 1;
  repos: Record<string, RepoChangeLists>;
};

export type RepoViewSettings = {
  repoRoot: string;
  options: GitCommitPanelViewOptions;
};

export type ViewSettingsStore = {
  version: 1;
  applicationOptions?: GitCommitPanelViewOptions;
  repos: Record<string, RepoViewSettings>;
};

export type RepoLocalChangesConfig = {
  repoRoot: string;
  config: GitCommitPanelLocalChangesConfig;
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

export type LocalChangesConfigStore = {
  version: 1;
  applicationConfig?: GitCommitPanelLocalChangesConfig;
  repos: Record<string, RepoLocalChangesConfig>;
};

export type ParsedGitStatusEntry = Omit<GitCommitPanelStatusEntry, "changeListId" | "statusText">;

export type GitCommitPanelStatusSnapshot = {
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
  entries: GitCommitPanelStatusEntry[];
  ignoredEntries: GitCommitPanelStatusEntry[];
  viewOptions: GitCommitPanelViewOptions;
  localChanges: GitCommitPanelLocalChangesConfig;
  changeLists: {
    activeListId: string;
    lists: Array<{
      id: string;
      name: string;
      comment?: string;
      data?: Record<string, any> | null;
      readOnly?: boolean;
      fileCount: number;
      files: string[];
    }>;
  };
};
