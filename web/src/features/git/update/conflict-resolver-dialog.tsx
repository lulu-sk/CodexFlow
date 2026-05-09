// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import type { GitConflictMergeSessionSnapshot } from "../types";
import { MultipleFileMergeDialog } from "./multiple-file-merge-dialog";

type GitRepositoryOperationState = "normal" | "rebasing" | "merging" | "grafting" | "reverting";

type ConflictResolverDialogProps = {
  open: boolean;
  title: string;
  description: string;
  snapshot: GitConflictMergeSessionSnapshot | null;
  selectedPath: string;
  checkedPaths: string[];
  groupByDirectory: boolean;
  showResolved: boolean;
  operationState?: GitRepositoryOperationState;
  loading?: boolean;
  submitting: "continue" | "abort" | null;
  applyingSide: "ours" | "theirs" | null;
  onOpenChange(open: boolean): void;
  onSelectPath(path: string): void;
  onTogglePath(path: string, checked: boolean): void;
  onToggleAll(checked: boolean): void;
  onToggleGroupByDirectory(): void;
  onToggleShowResolved(): void;
  onOpenSelected(): void;
  onOpenSelectedInIde?(): void;
  onOpenSelectedInSystem?(): void;
  onShowInCommitPanel?(): void;
  onRefresh(): void;
  onSelectNext(): void;
  onApplySide(side: "ours" | "theirs"): void;
  continueLabel?: string;
  onContinue?(): void;
  onAbort?(): void;
};

/**
 * 保留原有组件入口名，内部转发到新的 MultipleFileMergeDialog，减少工作台调用面的改动。
 */
export function ConflictResolverDialog(props: ConflictResolverDialogProps): React.ReactElement {
  return <MultipleFileMergeDialog {...props} />;
}
