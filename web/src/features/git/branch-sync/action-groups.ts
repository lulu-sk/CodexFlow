// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitUiActionGroup } from "../action-registry";
import { compactGitUiActionGroups } from "../action-registry";
import type { GitBranchPopupSnapshot } from "../types";
import { resolveBranchPopupQuickActionLabel } from "./branch-popup-i18n";

type GitBranchPopupTextResolver = (key: string, fallback: string) => string;

export type GitBranchPopupActionKey =
  | "update"
  | "commit"
  | "push"
  | "newBranch"
  | "checkoutRevision"
  | "configureRemotes"
  | "fetch"
  | "toggleSyncEnabled"
  | "toggleShowOnlyMy";

/**
 * 按共享 action schema 构建 branch popup 的 header / quick actions，避免按钮与菜单各自拼装。
 */
export function buildBranchPopupActionGroups(
  snapshot: GitBranchPopupSnapshot | null,
  resolveText?: GitBranchPopupTextResolver,
): GitUiActionGroup<GitBranchPopupActionKey>[] {
  const syncEnabled = snapshot?.syncEnabled !== false;
  const showOnlyMy = snapshot?.showOnlyMy === true;
  /**
   * 统一解析分支弹窗头部固定动作文案。
   */
  const resolveHeaderLabel = (key: string, fallback: string): string => {
    return resolveText ? resolveText(`workbench.branches.popup.header.${key}`, fallback) : fallback;
  };
  const quickActionItems = (snapshot?.quickActions || []).map((item) => ({
    id: item.id as GitBranchPopupActionKey,
    label: resolveBranchPopupQuickActionLabel(item.id, String(item.label || "").trim(), resolveText),
    shortcut: String(item.shortcut || "").trim() || undefined,
  })).filter((item) => !!item.label);

  return compactGitUiActionGroups([
    {
      id: "header",
      items: [
        {
          id: "fetch",
          label: resolveHeaderLabel("fetch", "Fetch"),
        },
        {
          id: "toggleSyncEnabled",
          label: resolveHeaderLabel("syncStatus", "Sync Status"),
          checked: syncEnabled,
        },
        {
          id: "toggleShowOnlyMy",
          label: resolveHeaderLabel("myBranchesOnly", "My Branches Only"),
          checked: showOnlyMy,
        },
      ],
    },
    {
      id: "quick",
      items: quickActionItems,
    },
  ]);
}
