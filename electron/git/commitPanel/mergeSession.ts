// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import {
  describeConflictResolverEntriesAsync,
  describeConflictWorkingTreeRevisionAsync,
  type GitCommitPanelConflictResolverEntry,
  type GitCommitPanelConflictRuntime,
  type GitCommitPanelConflictRevision,
} from "./conflictMerge";
import type {
  GitResolvedConflictsHolderSnapshot,
} from "./resolvedConflicts";

export type GitCommitPanelMergeSessionSideState = "modified" | "deleted" | "resolved";

export type GitCommitPanelMergeSessionRevision = Omit<GitCommitPanelConflictRevision, "text">;

export type GitCommitPanelMergeSessionEntry = {
  path: string;
  fileName: string;
  directoryPath: string;
  conflictState: "unresolved" | "resolved";
  reverseSides: boolean;
  canOpenMerge: boolean;
  canOpenFile: boolean;
  oursState: GitCommitPanelMergeSessionSideState;
  theirsState: GitCommitPanelMergeSessionSideState;
  base: GitCommitPanelMergeSessionRevision;
  ours: GitCommitPanelMergeSessionRevision;
  theirs: GitCommitPanelMergeSessionRevision;
  working: GitCommitPanelMergeSessionRevision;
};

export type GitCommitPanelMergeSessionSnapshot = {
  reverseSides: boolean;
  labels: {
    base: string;
    ours: string;
    theirs: string;
    working: string;
  };
  unresolvedCount: number;
  resolvedCount: number;
  unresolvedEntries: GitCommitPanelMergeSessionEntry[];
  resolvedEntries: GitCommitPanelMergeSessionEntry[];
  entries: GitCommitPanelMergeSessionEntry[];
  resolvedHolder: GitResolvedConflictsHolderSnapshot;
};

/**
 * 统一规整冲突文件路径，保证 merge session 列表和 holder 使用同一相对路径键。
 */
function normalizeMergeSessionPath(pathText: string): string {
  return String(pathText || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 从仓库内相对路径推导展示所需的文件名。
 */
function resolveMergeSessionFileName(relPath: string): string {
  const cleanPath = normalizeMergeSessionPath(relPath);
  if (!cleanPath) return "";
  return path.posix.basename(cleanPath) || cleanPath;
}

/**
 * 从仓库内相对路径推导目录分组键，根目录文件统一回落为“仓库根目录”。
 */
function resolveMergeSessionDirectoryPath(relPath: string): string {
  const cleanPath = normalizeMergeSessionPath(relPath);
  if (!cleanPath) return "";
  const directoryPath = path.posix.dirname(cleanPath);
  if (!directoryPath || directoryPath === ".") return "仓库根目录";
  return directoryPath;
}

/**
 * 构造不可用 revision 的轻量占位值，供 resolved entry 复用固定标签和空状态。
 */
function createUnavailableMergeSessionRevision(label: string): GitCommitPanelMergeSessionRevision {
  return {
    label,
    available: false,
  };
}

/**
 * 把 resolver 条目的 revision 元数据转换为 session 列需要的 side 状态列。
 */
function resolveMergeSessionSideState(
  revision: GitCommitPanelMergeSessionRevision,
): GitCommitPanelMergeSessionSideState {
  return revision.available || revision.isBinary || revision.tooLarge ? "modified" : "deleted";
}

/**
 * 把 side 状态格式化为表格列可直接展示的简短文案。
 */
function resolveMergeSessionStateLabel(
  state: GitCommitPanelMergeSessionSideState,
): string {
  if (state === "deleted") return "删除";
  if (state === "resolved") return "已解决";
  return "修改";
}

/**
 * 将单个 unresolved resolver 条目转换为 merge session 行，补齐文件名、目录和状态列。
 */
function buildUnresolvedMergeSessionEntry(
  entry: GitCommitPanelConflictResolverEntry,
): GitCommitPanelMergeSessionEntry {
  return {
    path: entry.path,
    fileName: resolveMergeSessionFileName(entry.path),
    directoryPath: resolveMergeSessionDirectoryPath(entry.path),
    conflictState: "unresolved",
    reverseSides: entry.reverseSides === true,
    canOpenMerge: entry.canOpenMerge,
    canOpenFile: true,
    oursState: resolveMergeSessionSideState(entry.ours),
    theirsState: resolveMergeSessionSideState(entry.theirs),
    base: entry.base,
    ours: entry.ours,
    theirs: entry.theirs,
    working: entry.working,
  };
}

/**
 * 根据 reverse sides 语义生成默认标签，确保 resolved entry 仍保留与 unresolved 相同的列标题。
 */
function resolveDefaultSessionLabels(reverse: boolean): GitCommitPanelMergeSessionSnapshot["labels"] {
  return {
    base: "基线",
    ours: reverse ? "他们的更改" : "你的更改",
    theirs: reverse ? "你的更改" : "他们的更改",
    working: "结果",
  };
}

/**
 * 构建单个 resolved conflict 的 session 行；resolved 后仍保留 working 元数据与 reopen 入口。
 */
async function buildResolvedMergeSessionEntryAsync(args: {
  repoRoot: string;
  relPath: string;
  reverse: boolean;
}): Promise<GitCommitPanelMergeSessionEntry> {
  const labels = resolveDefaultSessionLabels(args.reverse);
  const working = await describeConflictWorkingTreeRevisionAsync({
    repoRoot: args.repoRoot,
    relPath: args.relPath,
  });
  return {
    path: args.relPath,
    fileName: resolveMergeSessionFileName(args.relPath),
    directoryPath: resolveMergeSessionDirectoryPath(args.relPath),
    conflictState: "resolved",
    reverseSides: args.reverse,
    canOpenMerge: false,
    canOpenFile: true,
    oursState: "resolved",
    theirsState: "resolved",
    base: createUnavailableMergeSessionRevision(labels.base),
    ours: createUnavailableMergeSessionRevision(labels.ours),
    theirs: createUnavailableMergeSessionRevision(labels.theirs),
    working,
  };
}

/**
 * 按当前仓库状态构建多文件 merge session 快照，供 MultipleFileMergeDialog 与 manager 共享。
 */
export async function buildConflictMergeSessionSnapshotAsync(args: {
  runtime: GitCommitPanelConflictRuntime;
  repoRoot: string;
  unresolvedPaths: string[];
  reverse?: boolean;
  resolvedHolder: GitResolvedConflictsHolderSnapshot;
}): Promise<GitCommitPanelMergeSessionSnapshot> {
  const reverse = args.reverse === true;
  const unresolvedPaths = Array.from(
    new Set(args.unresolvedPaths.map((one) => normalizeMergeSessionPath(one)).filter(Boolean)),
  );
  const unresolvedResolverEntries = await describeConflictResolverEntriesAsync({
    runtime: args.runtime,
    repoRoot: args.repoRoot,
    relPaths: unresolvedPaths,
    reverse,
  });
  const unresolvedEntries = unresolvedResolverEntries.map((entry) => buildUnresolvedMergeSessionEntry(entry));
  const unresolvedPathSet = new Set(unresolvedEntries.map((entry) => entry.path));
  const resolvedPaths = Array.from(
    new Set(args.resolvedHolder.paths.map((one) => normalizeMergeSessionPath(one)).filter(Boolean)),
  ).filter((one) => !unresolvedPathSet.has(one));
  const resolvedEntries = await Promise.all(
    resolvedPaths.map(async (relPath) => {
      return await buildResolvedMergeSessionEntryAsync({
        repoRoot: args.repoRoot,
        relPath,
        reverse,
      });
    }),
  );
  const labels = unresolvedEntries[0]
    ? {
        base: unresolvedEntries[0].base.label,
        ours: unresolvedEntries[0].ours.label,
        theirs: unresolvedEntries[0].theirs.label,
        working: unresolvedEntries[0].working.label,
      }
    : resolveDefaultSessionLabels(reverse);
  return {
    reverseSides: reverse,
    labels,
    unresolvedCount: unresolvedEntries.length,
    resolvedCount: resolvedEntries.length,
    unresolvedEntries,
    resolvedEntries,
    entries: [...unresolvedEntries, ...resolvedEntries],
    resolvedHolder: args.resolvedHolder,
  };
}

/**
 * 把 session side 状态值转换为 UI 文案，供前端表格与测试直接复用一致的显示语义。
 */
export function formatMergeSessionSideState(
  state: GitCommitPanelMergeSessionSideState,
): string {
  return resolveMergeSessionStateLabel(state);
}
