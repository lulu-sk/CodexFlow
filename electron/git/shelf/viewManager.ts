// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// Shelf 视图状态管理参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 Electron/TypeScript 架构重写。

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { GitUpdatePostAction } from "../update/types";
import type { GitShelfViewState, GitShelvedChangeListItem, GitShelvedChangeListSavedEntry } from "./types";

type ShelvedViewTarget = Pick<GitShelvedChangeListSavedEntry, "ref" | "repoRoot" | "repoRoots" | "source">
  | Pick<GitShelvedChangeListItem, "ref" | "repoRoot" | "repoRoots" | "source">;

const DEFAULT_SHELF_VIEW_STATE: GitShelfViewState = {
  showRecycled: false,
  groupByDirectory: false,
};

/**
 * 对齐 IDEA `ShelvedChangesViewManager` 的轻量视图管理器，负责持久化 shelf 视图状态并生成激活动作。
 */
export class ShelvedChangesViewManager {
  private readonly repoRoot: string;
  private readonly userDataPath: string;

  /**
   * 初始化 shelf 视图管理器。
   */
  constructor(repoRoot: string, userDataPath?: string) {
    this.repoRoot = String(repoRoot || "").trim();
    this.userDataPath = String(userDataPath || "").trim();
  }

  /**
   * 返回 shelf 视图状态持久化文件路径；未提供 userDataPath 时回退为仅内存默认值。
   */
  private getViewStateStorePath(): string {
    return path.join(this.userDataPath, "git", "shelf-view.json");
  }

  /**
   * 读取指定仓库的 shelf 视图状态；文件缺失或损坏时统一回退默认值。
   */
  async getViewStateAsync(): Promise<GitShelfViewState> {
    if (!this.userDataPath || !this.repoRoot) return { ...DEFAULT_SHELF_VIEW_STATE };
    try {
      const raw = await fsp.readFile(this.getViewStateStorePath(), "utf8");
      const parsed = JSON.parse(String(raw || "")) as { byRepoRoot?: Record<string, Partial<GitShelfViewState>> };
      const stored = parsed?.byRepoRoot?.[this.repoRoot];
      return {
        showRecycled: stored?.showRecycled === true,
        groupByDirectory: stored?.groupByDirectory === true,
      };
    } catch {
      return { ...DEFAULT_SHELF_VIEW_STATE };
    }
  }

  /**
   * 按增量补丁更新 shelf 视图状态，并把 showRecycled/groupByDirectory 持久化到工作区级文件。
   */
  async updateViewStateAsync(patch: Partial<GitShelfViewState>): Promise<GitShelfViewState> {
    const previous = await this.getViewStateAsync();
    const nextState: GitShelfViewState = {
      showRecycled: patch.showRecycled ?? previous.showRecycled,
      groupByDirectory: patch.groupByDirectory ?? previous.groupByDirectory,
    };
    if (!this.userDataPath || !this.repoRoot) return nextState;
    const storePath = this.getViewStateStorePath();
    let rawStore: { byRepoRoot?: Record<string, Partial<GitShelfViewState>> } = {};
    try {
      rawStore = JSON.parse(await fsp.readFile(storePath, "utf8"));
    } catch {
      rawStore = {};
    }
    const nextStore = {
      byRepoRoot: {
        ...(rawStore.byRepoRoot || {}),
        [this.repoRoot]: nextState,
      },
    };
    await fsp.mkdir(path.dirname(storePath), { recursive: true });
    await fsp.writeFile(storePath, `${JSON.stringify(nextStore, null, 2)}\n`, "utf8");
    return nextState;
  }

  /**
   * 生成“打开搁置视图”的动作描述；当前宿主由前端据此激活对应 shelf 面板。
   */
  activateView(target?: ShelvedViewTarget | null): GitUpdatePostAction | null {
    const repoRoot = String(target?.repoRoot || this.repoRoot || "").trim();
    if (!repoRoot) return null;
    return {
      kind: "open-saved-changes",
      label: "查看搁置记录",
      repoRoot,
      payload: {
        repoRoot,
        ref: target?.ref,
        repoRoots: Array.isArray(target?.repoRoots) ? target.repoRoots : undefined,
        source: target?.source || "manual",
        saveChangesPolicy: "shelve",
        viewKind: "shelf",
      },
    };
  }
}
