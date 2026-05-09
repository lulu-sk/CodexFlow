// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitStatusEntry } from "./types";

type GitConflictTextResolver = (key: string, fallback: string) => string;

export type GitConflictContextActionKey = "mergeConflicts" | "acceptTheirs" | "acceptYours";

type GitConflictEntryLike = Pick<GitStatusEntry, "path" | "conflictState">;

export type GitConflictContextMenuRequest =
  | {
    kind: "openMergeDialog";
    path: string;
  }
  | {
    kind: "openResolverDialog";
    title: string;
    description: string;
    focusPath: string;
    checkedPaths: string[];
  }
  | {
    kind: "applySide";
    side: "ours" | "theirs";
    paths: string[];
    failureActionText: string;
  };

const CONFLICT_CONTEXT_ACTION_ORDER: GitConflictContextActionKey[] = ["mergeConflicts", "acceptTheirs", "acceptYours"];

/**
 * 收集当前选择中的未解决冲突路径，统一去重并规范为 `/` 分隔，供右键菜单与动作分发复用。
 */
export function collectSelectedConflictPaths(entries: GitConflictEntryLike[]): string[] {
  return Array.from(new Set(
    (entries || [])
      .filter((entry) => entry.conflictState === "conflict")
      .map((entry) => String(entry.path || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
}

/**
 * 仅在当前选择包含冲突文件时暴露 IDEA 对齐的右键快捷动作，并固定顺序为 Merge/Theirs/Yours。
 */
export function buildConflictContextActionKeys(entries: GitConflictEntryLike[]): GitConflictContextActionKey[] {
  return collectSelectedConflictPaths(entries).length > 0 ? CONFLICT_CONTEXT_ACTION_ORDER : [];
}

/**
 * 把冲突右键动作转换为纯数据请求，避免组件里散落路径归一化、单选/多选分支与 ours/theirs 映射。
 */
export function resolveConflictContextMenuRequest(
  action: GitConflictContextActionKey,
  entries: GitConflictEntryLike[],
  resolveText?: GitConflictTextResolver,
): GitConflictContextMenuRequest | null {
  const selectedConflictPaths = collectSelectedConflictPaths(entries);
  /**
   * 统一解析冲突批量处理请求里的展示文案；未注入翻译时回退到英文兜底，避免请求对象继续夹带中文。
   */
  const resolveLabel = (key: string, fallback: string): string => {
    return resolveText ? resolveText(`workbench.changes.context.conflictDialog.${key}`, fallback) : fallback;
  };
  if (selectedConflictPaths.length <= 0) return null;
  if (action === "mergeConflicts") {
    if (selectedConflictPaths.length === 1) {
      return {
        kind: "openMergeDialog",
        path: selectedConflictPaths[0]!,
      };
    }
    return {
      kind: "openResolverDialog",
      title: resolveLabel("title", "Resolve Conflicts"),
      description: resolveLabel("description", "The selected conflict files are preselected. You can accept Yours/Theirs in batch or continue opening the Merge tool one by one."),
      focusPath: selectedConflictPaths[0]!,
      checkedPaths: selectedConflictPaths,
    };
  }
  return {
    kind: "applySide",
    side: action === "acceptYours" ? "ours" : "theirs",
    paths: selectedConflictPaths,
    failureActionText: action === "acceptYours"
      ? resolveLabel("acceptYoursAction", "Accept Yours ")
      : resolveLabel("acceptTheirsAction", "Accept Theirs "),
  };
}
