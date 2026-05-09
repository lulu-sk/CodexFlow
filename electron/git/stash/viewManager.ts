// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// Stash 视图动作模型参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 Electron/TypeScript 架构重写。

import type { GitUpdatePostAction } from "../update/types";

type GitStashViewTarget = {
  repoRoot?: string;
  repoRoots?: string[];
  ref?: string;
};

/**
 * 对齐 IDEA `GitStashUIHandler` 的轻量视图管理器，统一生成 stash 视图激活动作。
 */
export class GitStashViewManager {
  private readonly repoRoot: string;

  /**
   * 初始化 stash 视图管理器。
   */
  constructor(repoRoot: string) {
    this.repoRoot = String(repoRoot || "").trim();
  }

  /**
   * 生成“打开暂存列表”的动作描述，供 preserving、通知与工作台列表共用。
   */
  activateView(target?: GitStashViewTarget | null): GitUpdatePostAction | null {
    const repoRoot = String(target?.repoRoot || this.repoRoot || "").trim();
    if (!repoRoot) return null;
    return {
      kind: "open-saved-changes",
      label: "查看暂存列表",
      repoRoot,
      payload: {
        repoRoot,
        ref: String(target?.ref || "").trim() || undefined,
        repoRoots: Array.isArray(target?.repoRoots) ? target.repoRoots : undefined,
        saveChangesPolicy: "stash",
        viewKind: "stash",
      },
    };
  }
}
