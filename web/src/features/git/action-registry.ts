// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { showGitWorkbenchActionAsync } from "./api";
import {
  GIT_WORKBENCH_PUBLIC_ACTION_IDS,
  type GitWorkbenchPublicActionId,
} from "./git-workbench-bridge";

export type GitUiActionTone = "default" | "danger";

/**
 * 公共 action registry 暴露 GitWorkbench 可承接的宿主级动作。
 * 面板内部动作如 `Git.Stage.Add.All` 仍留在工作台内部，不直接出现在公共 action 表。
 */
export const GIT_PUBLIC_ACTION_IDS = GIT_WORKBENCH_PUBLIC_ACTION_IDS;

export type GitPublicActionId = GitWorkbenchPublicActionId;

export type GitUiActionGroupRefs = {
  toolbarActionGroupId: string;
  popupActionGroupId: string;
};

export type GitUiActionItem<ActionId extends string = string> = {
  id: ActionId;
  label: string;
  shortcut?: string;
  visible?: boolean;
  enabled?: boolean;
  reason?: string;
  tone?: GitUiActionTone;
  checked?: boolean;
};

export type GitUiActionGroup<ActionId extends string = string> = {
  id: string;
  items: GitUiActionItem<ActionId>[];
};

/**
 * 清洗动作分组，统一去掉不可见项与空分组，供 toolbar / popup 共用。
 */
export function compactGitUiActionGroups<ActionId extends string>(
  groups: GitUiActionGroup<ActionId>[],
): GitUiActionGroup<ActionId>[] {
  return (groups || [])
    .map((group) => ({
      ...group,
      items: (group.items || []).filter((item) => item.visible !== false),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * 把分组动作压平成线性列表，便于按 id 做查找或驱动键盘快捷动作。
 */
export function flattenGitUiActions<ActionId extends string>(
  groups: GitUiActionGroup<ActionId>[],
): GitUiActionItem<ActionId>[] {
  return compactGitUiActionGroups(groups).flatMap((group) => group.items);
}

/**
 * 按动作 id 查找当前可见动作，避免调用方自行遍历分组。
 */
export function findGitUiAction<ActionId extends string>(
  groups: GitUiActionGroup<ActionId>[],
  actionId: ActionId,
): GitUiActionItem<ActionId> | null {
  return flattenGitUiActions(groups).find((item) => item.id === actionId) || null;
}

/**
 * 统一分发 Git 公共动作入口，供外部流程按 actionId 调用 GitWorkbench 宿主桥。
 */
export async function dispatchGitPublicActionAsync(
  actionId: GitPublicActionId,
  args?: {
    projectId?: string;
    projectPath?: string;
    prefillCommitMessage?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  return await showGitWorkbenchActionAsync(actionId, {
    projectId: args?.projectId,
    projectPath: args?.projectPath,
    prefillCommitMessage: args?.prefillCommitMessage,
  });
}
