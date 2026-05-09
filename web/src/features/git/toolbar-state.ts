// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TFunction } from "i18next";
import { resolveGitTextWith } from "./git-i18n";

export type GitToolbarActionState = {
  enabled: boolean;
  reason?: string;
};

export type GitToolbarState = {
  fetch: GitToolbarActionState;
  pull: GitToolbarActionState;
  commit: GitToolbarActionState;
  push: GitToolbarActionState;
  rollback: GitToolbarActionState;
};

export type GitCommitToolbarIntent = {
  shouldSwitchTab: boolean;
  shouldFocusEditor: boolean;
  shouldAlignTreeSelection: boolean;
};

type GitToolbarStateInput = {
  isRepo: boolean;
  repoDetached: boolean;
  hasRemotes: boolean;
  flowBusy: boolean;
  hasRollbackSelection: boolean;
};

/**
 * 统一解析 Git 工具栏文案，确保状态模块返回的禁用原因也能跟随当前语言切换。
 */
function translateGitToolbarText(
  t: TFunction<"git">,
  key: string,
  fallback: string,
): string {
  return resolveGitTextWith(t, key, fallback);
}

/**
 * 统一推导 Git 工具栏主要动作的 enablement，避免 `git-workbench` 内散落同类判断。
 */
export function resolveGitToolbarState(
  input: GitToolbarStateInput,
  t: TFunction<"git">,
): GitToolbarState {
  if (!input.isRepo) {
    const disabled = {
      enabled: false,
      reason: translateGitToolbarText(t, "workbench.topToolbar.disabled.notRepo", "当前目录不是 Git 仓库"),
    };
    return {
      fetch: disabled,
      pull: disabled,
      commit: disabled,
      push: disabled,
      rollback: disabled,
    };
  }

  const busyReason = input.flowBusy
    ? translateGitToolbarText(t, "workbench.topToolbar.disabled.busy", "当前有进行中的 Git 操作")
    : undefined;
  const fetch = !input.hasRemotes
    ? { enabled: false, reason: translateGitToolbarText(t, "workbench.topToolbar.disabled.noRemotes", "当前仓库没有可用远端") }
    : { enabled: !input.flowBusy, reason: busyReason };
  const pull = input.repoDetached
    ? { enabled: false, reason: translateGitToolbarText(t, "workbench.topToolbar.disabled.pullDetached", "游离 HEAD 状态下不支持拉取") }
    : !input.hasRemotes
      ? { enabled: false, reason: translateGitToolbarText(t, "workbench.topToolbar.disabled.noRemotes", "当前仓库没有可用远端") }
      : { enabled: !input.flowBusy, reason: busyReason };

  return {
    fetch,
    pull,
    commit: { enabled: !input.flowBusy, reason: busyReason },
    push: { enabled: !input.flowBusy, reason: busyReason },
    rollback: input.hasRollbackSelection
      ? { enabled: !input.flowBusy, reason: busyReason }
      : { enabled: false, reason: translateGitToolbarText(t, "workbench.topToolbar.disabled.noRollbackSelection", "当前没有可回滚的已跟踪改动") },
  };
}

/**
 * 提交按钮点击后始终要把焦点送回提交工作流；若当前已处于激活态，也不能退化为 no-op。
 */
export function resolveCommitToolbarIntent(commitToolbarActive: boolean): GitCommitToolbarIntent {
  return {
    shouldSwitchTab: commitToolbarActive !== true,
    shouldFocusEditor: true,
    shouldAlignTreeSelection: true,
  };
}
