// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TFunction } from "i18next";
import { resolveGitTextWith } from "./git-i18n";

export type GitStageGlobalActionState = {
  label: string;
  enabled: boolean;
  reason?: string;
};

export type GitStageGlobalActionAvailability = {
  stageAll: GitStageGlobalActionState;
  stageTracked: GitStageGlobalActionState;
};

/**
 * 统一解析 Stage 全局动作文案，确保工具栏与右键菜单共用同一套多语言输出。
 */
function translateGitStageActionText(
  t: TFunction<"git">,
  key: string,
  fallback: string,
): string {
  return resolveGitTextWith(t, key, fallback);
}

/**
 * 统一推导 Git Stage 全局动作的启用态与禁用文案，供 toolbar/context menu 共用。
 */
export function resolveGitStageGlobalActionAvailability(args: {
  canStageAll: boolean;
  canStageAllTracked: boolean;
}, t: TFunction<"git">): GitStageGlobalActionAvailability {
  return {
    stageAll: args.canStageAll
      ? {
          label: translateGitStageActionText(t, "workbench.changes.actions.stageAll", "暂存所有更改"),
          enabled: true,
        }
      : {
          label: translateGitStageActionText(t, "workbench.changes.actions.stageAll", "暂存所有更改"),
          enabled: false,
          reason: translateGitStageActionText(t, "workbench.changes.actions.stageAllDisabled", "当前仓库没有可全局暂存的未跟踪或未暂存更改"),
        },
    stageTracked: args.canStageAllTracked
      ? {
          label: translateGitStageActionText(t, "workbench.changes.actions.stageTracked", "暂存所有已跟踪更改"),
          enabled: true,
        }
      : {
          label: translateGitStageActionText(t, "workbench.changes.actions.stageTracked", "暂存所有已跟踪更改"),
          enabled: false,
          reason: translateGitStageActionText(t, "workbench.changes.actions.stageTrackedDisabled", "当前仓库没有可全局暂存的已跟踪更改"),
        },
  };
}
