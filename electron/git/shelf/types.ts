// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { RepoChangeListSnapshot } from "../changelists";
import type { GitExecResult } from "../exec";

export type GitShelfSource = "manual" | "system";

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

export type GitShelvedStoredFile = {
  relativePath: string;
  storagePath: string;
};

export type GitShelvedRootEntry = {
  repoRoot: string;
  savedPaths: string[];
  indexPaths: string[];
  worktreePaths: string[];
  hasIndexPatch: boolean;
  hasWorktreePatch: boolean;
  untrackedFiles: GitShelvedStoredFile[];
};

export type GitShelveRootChangeSet = {
  repoRoot: string;
  paths: string[];
  untrackedPaths: string[];
};

export type GitManualShelveSelection = {
  selectedPaths: string[];
  availablePaths?: string[];
  targetChangeListId?: string;
  targetChangeListName?: string;
  changeListsEnabled?: boolean;
};

export type GitShelveChangeListDescriptor = {
  message: string;
  source: GitShelfSource;
  changeListId?: string;
  changeListName?: string;
  roots: GitShelveRootChangeSet[];
  changeListSnapshots?: RepoChangeListSnapshot[];
};

export type GitShelvedChangeListMetadata = {
  version: 2;
  id: string;
  ref: string;
  message: string;
  createdAt: string;
  source: GitShelfSource;
  saveChangesPolicy: "shelve";
  state: GitShelfState;
  primaryRepoRoot: string;
  repoRoots: string[];
  originalChangeListId?: string;
  originalChangeListName?: string;
  roots: GitShelvedRootEntry[];
  changeListSnapshots?: RepoChangeListSnapshot[];
  lastError?: string;
  restoreProgress?: {
    repoProgress?: Record<string, {
      indexApplied?: boolean;
      worktreeApplied?: boolean;
      untrackedApplied?: boolean;
    }>;
    changeListsRestored?: boolean;
  };
};

export type GitShelvedChangeListItem = {
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

export type GitShelvedChangeListSavedEntry = {
  ref: string;
  repoRoot: string;
  repoRoots: string[];
  message: string;
  source: GitShelfSource;
  saveChangesPolicy: "shelve";
  displayName: string;
  hasUntrackedFiles: boolean;
  originalChangeListId?: string;
  originalChangeListName?: string;
};

export type GitShelveRestoreOptions = {
  selectedPaths?: string[];
  targetChangeListId?: string;
  removeAppliedFromShelf?: boolean;
};

export type GitShelfManagerRuntime = {
  repoRoot: string;
  userDataPath: string;
  runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number): Promise<GitExecResult>;
  runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult>;
  /** 将指定 Git 命令的 stdout 直接写入文件，供大补丁与大文本输出场景复用。 */
  runGitStdoutToFileAsync(targetRepoRoot: string, argv: string[], targetPath: string, timeoutMs?: number): Promise<GitExecResult>;
  emitProgress?(targetRepoRoot: string, message: string, detail?: string): void;
  onChange?(event: { type: string; ref: string; repoRoot: string; state?: GitShelfState }): void;
  toGitErrorMessage(res: GitExecResult, fallback: string): string;
};
