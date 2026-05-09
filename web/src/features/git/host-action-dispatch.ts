// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import {
  GIT_WORKBENCH_COMMIT_AND_PUSH_ACTION_ID,
  GIT_WORKBENCH_COMMIT_OPTIONS_ACTION_ID,
  GIT_WORKBENCH_COMMIT_STAGE_ACTION_ID,
  GIT_WORKBENCH_FETCH_ACTION_ID,
  GIT_WORKBENCH_PULL_ACTION_ID,
  GIT_WORKBENCH_PUSH_ACTION_ID,
  GIT_WORKBENCH_RESOLVE_CONFLICTS_ACTION_ID,
  GIT_WORKBENCH_SHOW_STAGE_ACTION_ID,
  GIT_WORKBENCH_STASH_ACTION_ID,
  GIT_WORKBENCH_UNSTASH_ACTION_ID,
  GIT_WORKBENCH_UPDATE_OPTIONS_ACTION_ID,
  GIT_WORKBENCH_UPDATE_PROJECT_ACTION_ID,
  normalizeGitWorkbenchActionId,
} from "./git-workbench-bridge";

export type GitWorkbenchHostActionHandlers = {
  openCommitStage(options?: { preferPushAfter?: boolean; openOptions?: boolean }): void;
  openPushDialogAsync(): Promise<void>;
  openPullDialogAsync(): Promise<void>;
  openFetchDialogAsync(): Promise<void>;
  runUpdateProjectAsync(): Promise<void>;
  openUpdateOptionsDialogAsync(): Promise<void>;
  openConflictResolver(): void;
  openCreateStashDialogAsync(): Promise<void>;
  openSavedChangesView(): void;
};

/**
 * 把宿主 actionId 统一映射到 GitWorkbench 现有 handler，避免 toolbar、命令面板和宿主桥各自维护一套分发逻辑。
 */
export async function dispatchGitWorkbenchHostActionAsync(
  actionId: unknown,
  handlers: GitWorkbenchHostActionHandlers,
): Promise<void> {
  const normalizedActionId = normalizeGitWorkbenchActionId(actionId);
  if (normalizedActionId === GIT_WORKBENCH_SHOW_STAGE_ACTION_ID) {
    handlers.openCommitStage();
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_COMMIT_STAGE_ACTION_ID) {
    handlers.openCommitStage();
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_COMMIT_AND_PUSH_ACTION_ID) {
    handlers.openCommitStage({ preferPushAfter: true });
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_COMMIT_OPTIONS_ACTION_ID) {
    handlers.openCommitStage({ openOptions: true });
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_UPDATE_PROJECT_ACTION_ID) {
    await handlers.runUpdateProjectAsync();
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_UPDATE_OPTIONS_ACTION_ID) {
    await handlers.openUpdateOptionsDialogAsync();
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_PULL_ACTION_ID) {
    await handlers.openPullDialogAsync();
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_FETCH_ACTION_ID) {
    await handlers.openFetchDialogAsync();
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_PUSH_ACTION_ID) {
    await handlers.openPushDialogAsync();
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_RESOLVE_CONFLICTS_ACTION_ID) {
    handlers.openConflictResolver();
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_STASH_ACTION_ID) {
    await handlers.openCreateStashDialogAsync();
    return;
  }
  if (normalizedActionId === GIT_WORKBENCH_UNSTASH_ACTION_ID) {
    handlers.openSavedChangesView();
  }
}
