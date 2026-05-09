// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { CommitSelectionContext } from "./types";

export type CommitTreeSharedMenuActionId =
  | "commitFile"
  | "rollback"
  | "move"
  | "showDiff"
  | "showStandaloneDiff"
  | "editSource"
  | "delete"
  | "addToVcs"
  | "ignore"
  | "createPatch"
  | "copyPatch"
  | "shelve"
  | "refresh"
  | "showHistory"
  | "showWorktrees";

export type CommitTreeSharedMenuNode =
  | {
    kind: "action";
    id: CommitTreeSharedMenuActionId;
    disabled?: boolean;
    shortcut?: string;
    title?: string;
  }
  | {
    kind: "submenu";
    id: "localHistory" | "git";
    disabled?: boolean;
    title?: string;
    children: CommitTreeSharedMenuNode[];
  };

/**
 * 判断当前目录节点是否是“折叠后的多级路径展示”。
 * IDEA 会把连续单子目录折叠成展示文案，但这类节点的菜单能力不能简单等同于普通目录。
 */
function isCollapsedDirectoryDisplayPath(pathText: string | undefined): boolean {
  const normalized = String(pathText || "").trim();
  return normalized.includes("\\") || normalized.includes("/");
}

type CommitTreeSharedSelectionSnapshot = Pick<
  CommitSelectionContext,
  | "canCommit"
  | "canRollback"
  | "canMoveToList"
  | "canShowDiff"
  | "canOpenSource"
  | "canDelete"
  | "canAddToVcs"
  | "canIgnore"
  | "canShowHistory"
  | "canShelve"
>;

/**
 * 对齐 IDEA 提交树共享菜单的删除入口显示规则。
 * 单文件精确选择始终显示；目录 / 模块 / 仓库节点单选时也保留删除入口。
 */
export function shouldShowCommitTreeSharedDeleteAction(args: {
  exactlySelectedFileCount: number;
  singleSelection: boolean;
  selectedNodeKind?: string;
  selectedNodeDisplayPath?: string;
}): boolean {
  if (args.exactlySelectedFileCount > 0) return true;
  if (!args.singleSelection) return false;
  if (args.selectedNodeKind === "directory") {
    return !isCollapsedDirectoryDisplayPath(args.selectedNodeDisplayPath);
  }
  return args.selectedNodeKind === "directory"
    || args.selectedNodeKind === "module"
    || args.selectedNodeKind === "repository";
}

/**
 * 创建标准动作菜单节点，统一收口禁用态、快捷键与提示文案。
 */
function createActionNode(
  id: CommitTreeSharedMenuActionId,
  options?: {
    disabled?: boolean;
    shortcut?: string;
    title?: string;
  },
): CommitTreeSharedMenuNode {
  return {
    kind: "action",
    id,
    disabled: options?.disabled,
    shortcut: options?.shortcut,
    title: options?.title,
  };
}

/**
 * 创建标准子菜单节点，统一收口提交工具窗口共享菜单的层级结构。
 */
function createSubmenuNode(
  id: "localHistory" | "git",
  children: CommitTreeSharedMenuNode[],
  options?: {
    disabled?: boolean;
    title?: string;
  },
): CommitTreeSharedMenuNode {
  return {
    kind: "submenu",
    id,
    disabled: options?.disabled,
    title: options?.title,
    children,
  };
}

/**
 * 按 IDEA 提交工具窗口 `MultipleLocalChangeListsBrowser` 的结构构建主提交树共享右键菜单。
 * 这里故意不输出 changelist 管理项，只保留 commit tool window 实际会出现的公共动作与共享子菜单。
 */
export function buildCommitTreeSharedMenuSections(args: {
  selection: CommitTreeSharedSelectionSnapshot;
  singleSelection: boolean;
  showAddToVcs?: boolean;
  showDelete?: boolean;
  showEditSource?: boolean;
}): CommitTreeSharedMenuNode[][] {
  const { selection, singleSelection } = args;
  const canShowHistory = selection.canShowHistory && singleSelection;
  const showAddToVcs = args.showAddToVcs ?? selection.canAddToVcs;
  const showDelete = args.showDelete ?? true;
  const showEditSource = args.showEditSource ?? true;

  return [
    [
      createActionNode("commitFile", { disabled: !selection.canCommit }),
      createActionNode("rollback", { disabled: !selection.canRollback, shortcut: "Ctrl+Alt+Z" }),
      createActionNode("move", { disabled: !selection.canMoveToList, shortcut: "Alt+Shift+M" }),
      createActionNode("showDiff", { disabled: !selection.canShowDiff, shortcut: "Ctrl+D" }),
      createActionNode("showStandaloneDiff", { disabled: !selection.canShowDiff }),
      ...(showEditSource
        ? [createActionNode("editSource", { disabled: !selection.canOpenSource || !singleSelection, shortcut: "F4" })]
        : []),
    ],
    [
      ...(showDelete
        ? [createActionNode("delete", { disabled: !selection.canDelete, shortcut: "Delete" })]
        : []),
      ...(showAddToVcs
        ? [createActionNode("addToVcs", { shortcut: "Ctrl+Alt+A" })]
        : []),
      ...(selection.canIgnore
        ? [createActionNode("ignore")]
        : []),
    ],
    [
      createActionNode("createPatch", { disabled: !selection.canShowDiff }),
      createActionNode("copyPatch", { disabled: !selection.canShowDiff, shortcut: "F24" }),
      createActionNode("shelve", { disabled: !selection.canShelve }),
    ],
    [
      createActionNode("refresh"),
      createSubmenuNode(
        "localHistory",
        [createActionNode("showHistory", { disabled: !canShowHistory })],
        { disabled: !canShowHistory },
      ),
      createSubmenuNode("git", [createActionNode("showWorktrees")]),
    ],
  ];
}
