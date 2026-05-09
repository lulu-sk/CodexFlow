// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { CommitTreeGroupKind, CommitTreeHoverAction, CommitTreeOpenHandler } from "./types";
import { resolveGitText } from "../git-i18n";

/**
 * 按提交树分组语义生成节点 hover/open 动作，统一覆盖 conflict 与 stage/reset 两类入口。
 */
export function resolveCommitConflictNodeActions(nodeKey: string, groupKind: CommitTreeGroupKind, isFile: boolean): {
  hoverAction?: CommitTreeHoverAction;
  openHandler?: CommitTreeOpenHandler;
} {
  if (groupKind === "staged") {
    return {
      hoverAction: {
        id: `${nodeKey}:unstage`,
        iconLabel: resolveGitText("commitTree.conflictActions.unstage.icon", "重置"),
        tooltip: resolveGitText("commitTree.conflictActions.unstage.tooltip", "从暂存区移除"),
        action: "unstage",
      },
    };
  }
  if (groupKind === "unstaged" || groupKind === "unversioned") {
    return {
      hoverAction: {
        id: `${nodeKey}:stage`,
        iconLabel: resolveGitText("commitTree.conflictActions.stage.icon", "暂存"),
        tooltip: resolveGitText("commitTree.conflictActions.stage.tooltip", "暂存更改"),
        action: "stage",
      },
    };
  }
  if (!isFile) return {};
  if (groupKind === "conflict") {
    return {
      hoverAction: {
        id: `${nodeKey}:open-merge`,
        iconLabel: resolveGitText("commitTree.conflictActions.merge.icon", "合并"),
        tooltip: resolveGitText("commitTree.conflictActions.merge.tooltip", "打开 Merge 工具"),
        action: "open-merge",
      },
      openHandler: {
        action: "open-merge",
      },
    };
  }
  if (groupKind === "resolved-conflict") {
    return {
      hoverAction: {
        id: `${nodeKey}:rollback-resolved`,
        iconLabel: resolveGitText("commitTree.conflictActions.rollbackResolved.icon", "回滚"),
        tooltip: resolveGitText("commitTree.conflictActions.rollbackResolved.tooltip", "回滚已解决冲突"),
        action: "rollback-resolved",
      },
    };
  }
  return {};
}
