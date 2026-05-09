// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitUpdateOperationProblem } from "../types";

export type {
  GitUpdateExecutionPhase,
  GitPushRejectedAction,
  GitPullCapabilities,
  GitPullOptionKey,
  GitPullOptions,
  GitPushRejectedDecision,
  GitUpdateMethod,
  GitUpdateOptionMethod,
  GitUpdateOperationProblem,
  GitUpdateOptions,
  GitUpdateOptionsSnapshot,
  GitUpdatePostAction,
  GitUpdateRebaseWarning,
  GitUpdateRootResultCode,
  GitUpdateSaveChangesPolicy,
  GitUpdateScopeOptions,
  GitUpdateScopePreview,
  GitUpdateScopePreviewRoot,
  GitUpdateSyncStrategy,
  GitUpdateSessionNotificationData,
  GitUpdateSessionProgressRoot,
  GitUpdateSessionProgressSnapshot,
  GitUpdateTrackedBranchIssue,
  GitUpdateTrackedBranchPreview,
  GitUpdateTrackedBranchSelection,
} from "../types";

export type UpdateOperationDialogProps = {
  open: boolean;
  problem: GitUpdateOperationProblem | null;
  submitting: boolean;
  onClose(): void;
  onViewChanges?(): void;
  onAction(payloadPatch: Record<string, any>): void;
};
