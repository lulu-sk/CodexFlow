// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitUiActionGroupRefs } from "../action-registry";

/**
 * 集中声明提交面板与 Browse 树使用的 action group 标识，避免主树与对话框散落硬编码字符串。
 */
export const COMMIT_TREE_ACTION_GROUPS = {
  mainToolbar: "ChangesViewToolbar.Shared",
  mainPopup: "ChangesViewPopupMenuShared",
  unversionedBrowseToolbar: "Unversioned.Files.Dialog",
  unversionedBrowsePopup: "Unversioned.Files.Dialog.Popup",
  ignoredBrowseToolbar: "Delete",
  ignoredBrowsePopup: "Delete",
  conflictBrowseToolbar: "ChangesView.Conflicts.Dialog",
  conflictBrowsePopup: "ChangesView.Conflicts.Dialog.Popup",
} as const;

/**
 * 按 Browse 对话框类型解析对应 toolbar / popup action group，供 UI 与测试共用。
 */
export function resolveSpecialFilesActionGroups(
  kind: "ignored" | "unversioned" | "conflict",
): GitUiActionGroupRefs {
  if (kind === "ignored") {
    return {
      toolbarActionGroupId: COMMIT_TREE_ACTION_GROUPS.ignoredBrowseToolbar,
      popupActionGroupId: COMMIT_TREE_ACTION_GROUPS.ignoredBrowsePopup,
    };
  }
  if (kind === "conflict") {
    return {
      toolbarActionGroupId: COMMIT_TREE_ACTION_GROUPS.conflictBrowseToolbar,
      popupActionGroupId: COMMIT_TREE_ACTION_GROUPS.conflictBrowsePopup,
    };
  }
  return {
    toolbarActionGroupId: COMMIT_TREE_ACTION_GROUPS.unversionedBrowseToolbar,
    popupActionGroupId: COMMIT_TREE_ACTION_GROUPS.unversionedBrowsePopup,
  };
}
