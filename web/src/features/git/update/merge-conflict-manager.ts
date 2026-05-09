// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type {
  GitConflictMergeSessionEntry,
  GitConflictMergeSessionSnapshot,
  GitStatusEntry,
} from "../types";
import {
  buildCommitTree,
  flattenCommitTree,
} from "../commit-panel/changes-tree-view-model";
import type { CommitTreeNode } from "../commit-panel/types";

export type MergeConflictPrimaryActionKind = "merge" | "open";
type MergeConflictLabelResolver = (key: string, fallback: string, values?: Record<string, unknown>) => string;

export type MergeConflictTableRow =
  | { kind: "section"; key: string; label: string; count: number }
  | {
    kind: "node";
    key: string;
    sectionKey: "unresolved" | "resolved";
    node: CommitTreeNode;
    depth: number;
    entry: GitConflictMergeSessionEntry | null;
  };

/**
 * 把 merge session 条目适配成提交面板树模型所需的最小 GitStatusEntry，复用目录树构建语义。
 */
function adaptMergeConflictEntryToStatusEntry(
  entry: GitConflictMergeSessionEntry,
  sectionKey: "unresolved" | "resolved",
): GitStatusEntry {
  return {
    path: entry.path,
    x: entry.conflictState === "resolved" ? "M" : "U",
    y: entry.conflictState === "resolved" ? "." : "U",
    staged: entry.conflictState === "resolved",
    unstaged: entry.conflictState !== "resolved",
    untracked: false,
    ignored: false,
    renamed: false,
    deleted: false,
    statusText: entry.conflictState === "resolved" ? "已解决冲突" : "冲突",
    changeListId: `resolver:${sectionKey}`,
    conflictState: entry.conflictState === "resolved" ? "resolved" : "conflict",
  };
}

/**
 * 统一读取多文件冲突处理器的展示文案，支持组件层注入翻译函数并保留本地回退。
 */
function resolveMergeConflictLabel(
  resolveLabel: MergeConflictLabelResolver | undefined,
  key: string,
  fallback: string,
  values?: Record<string, unknown>,
): string {
  if (!resolveLabel) return fallback;
  return resolveLabel(key, fallback, values);
}

/**
 * 基于提交面板同源的树构建逻辑生成当前 section 的目录树行，保证目录层级与展开行为一致。
 */
function buildMergeConflictTreeRows(args: {
  entries: GitConflictMergeSessionEntry[];
  sectionKey: "unresolved" | "resolved";
  expanded: Record<string, boolean>;
}): MergeConflictTableRow[] {
  const statusEntries = args.entries.map((entry) => adaptMergeConflictEntryToStatusEntry(entry, args.sectionKey));
  const entryByPath = new Map(args.entries.map((entry) => [entry.path, entry] as const));
  const treeNodes = buildCommitTree(statusEntries, `merge-conflict:${args.sectionKey}`, ["directory"]);
  const treeRows = flattenCommitTree(treeNodes, args.expanded);
  return treeRows.map((row) => {
    const leadPath = row.node.isFile ? row.node.filePaths[0] : "";
    return {
      kind: "node",
      key: `node:${args.sectionKey}:${row.node.key}`,
      sectionKey: args.sectionKey,
      node: row.node,
      depth: row.depth,
      entry: leadPath ? (entryByPath.get(leadPath) || null) : null,
    };
  });
}

/**
 * 计算当前 session 是否应强制展示 resolved 条目，避免最后一个冲突处理后列表瞬间变空。
 */
function shouldForceShowResolvedEntries(
  snapshot: GitConflictMergeSessionSnapshot | null | undefined,
  showResolved: boolean,
): boolean {
  if (!snapshot) return false;
  if (showResolved) return snapshot.resolvedEntries.length > 0;
  return snapshot.unresolvedEntries.length <= 0 && snapshot.resolvedEntries.length > 0;
}

/**
 * 定位当前选中文件在目录树中的全部祖先节点键，供 resolver 自动展开对应目录链。
 */
export function findMergeConflictAncestorNodeKeys(args: {
  snapshot: GitConflictMergeSessionSnapshot | null | undefined;
  selectedPath: string;
  showResolved: boolean;
}): string[] {
  const cleanPath = String(args.selectedPath || "").trim().replace(/\\/g, "/");
  if (!cleanPath || !args.snapshot) return [];
  const showResolved = shouldForceShowResolvedEntries(args.snapshot, args.showResolved);
  const sections: Array<{ key: "unresolved" | "resolved"; entries: GitConflictMergeSessionEntry[] }> = [
    {
      key: "unresolved",
      entries: args.snapshot.unresolvedEntries || [],
    },
  ];
  if (showResolved) {
    sections.push({
      key: "resolved",
      entries: args.snapshot.resolvedEntries || [],
    });
  }

  /**
   * 递归查找命中文件，并在命中时回溯收集祖先目录键。
   */
  const collectAncestors = (nodes: CommitTreeNode[], ancestors: string[]): string[] | null => {
    for (const node of nodes) {
      if (node.isFile) {
        if (node.filePaths.includes(cleanPath)) return ancestors;
        continue;
      }
      const hit = collectAncestors(node.children, [...ancestors, node.key]);
      if (hit) return hit;
    }
    return null;
  };

  for (const section of sections) {
    const statusEntries = section.entries.map((entry) => adaptMergeConflictEntryToStatusEntry(entry, section.key));
    const treeNodes = buildCommitTree(statusEntries, `merge-conflict:${section.key}`, ["directory"]);
    const hit = collectAncestors(treeNodes, []);
    if (hit) return hit;
  }
  return [];
}

/**
 * 格式化 merge session 的 side 状态列，保持表格显示与测试断言共享同一文案语义。
 */
export function formatMergeConflictSideState(
  state: GitConflictMergeSessionEntry["oursState"],
  resolveLabel?: MergeConflictLabelResolver,
): string {
  if (state === "deleted") return resolveMergeConflictLabel(resolveLabel, "dialogs.multipleFileMerge.sideStates.deleted", "删除");
  if (state === "resolved") return resolveMergeConflictLabel(resolveLabel, "dialogs.multipleFileMerge.sideStates.resolved", "已解决");
  return resolveMergeConflictLabel(resolveLabel, "dialogs.multipleFileMerge.sideStates.modified", "修改");
}

/**
 * 从 session 快照中提取当前可见条目；默认只显示 unresolved，按需拼入 resolved 列表。
 */
export function getVisibleMergeConflictEntries(
  snapshot: GitConflictMergeSessionSnapshot | null | undefined,
  showResolved: boolean,
): GitConflictMergeSessionEntry[] {
  if (!snapshot) return [];
  if (!shouldForceShowResolvedEntries(snapshot, showResolved)) return [...snapshot.unresolvedEntries];
  return [...snapshot.unresolvedEntries, ...snapshot.resolvedEntries];
}

/**
 * 规整 manager 当前选区，确保选中行与批量勾选始终落在最新 session 快照里。
 */
export function sanitizeMergeConflictSelection(args: {
  snapshot: GitConflictMergeSessionSnapshot | null | undefined;
  selectedPath: string;
  checkedPaths: string[];
  showResolved: boolean;
}): { selectedPath: string; checkedPaths: string[] } {
  const visibleEntries = getVisibleMergeConflictEntries(args.snapshot, args.showResolved);
  const visiblePathSet = new Set(visibleEntries.map((entry) => entry.path));
  const unresolvedPathSet = new Set((args.snapshot?.unresolvedEntries || []).map((entry) => entry.path));
  const checkedPaths = args.checkedPaths.filter((path) => unresolvedPathSet.has(path));
  const selectedPath = visiblePathSet.has(args.selectedPath)
    ? args.selectedPath
    : (args.snapshot?.unresolvedEntries[0]?.path || visibleEntries[0]?.path || "");
  return {
    selectedPath,
    checkedPaths,
  };
}

/**
 * 解析当前选中的 merge session 条目；resolved 与 unresolved 都允许选中。
 */
export function getSelectedMergeConflictEntry(
  snapshot: GitConflictMergeSessionSnapshot | null | undefined,
  selectedPath: string,
): GitConflictMergeSessionEntry | null {
  if (!snapshot) return null;
  return snapshot.entries.find((entry) => entry.path === selectedPath) || null;
}

/**
 * 计算当前条目的主操作按钮语义；未解决文本冲突走 Merge，其余统一走 Open。
 */
export function resolveMergeConflictPrimaryAction(
  entry: GitConflictMergeSessionEntry | null,
  resolveLabel?: MergeConflictLabelResolver,
): { kind: MergeConflictPrimaryActionKind; label: string; enabled: boolean } {
  if (!entry) return { kind: "merge", label: resolveMergeConflictLabel(resolveLabel, "dialogs.multipleFileMerge.primaryActions.merge", "合并…"), enabled: false };
  if (entry.conflictState === "unresolved" && entry.canOpenMerge) {
    return { kind: "merge", label: resolveMergeConflictLabel(resolveLabel, "dialogs.multipleFileMerge.primaryActions.merge", "合并…"), enabled: true };
  }
  return { kind: "open", label: resolveMergeConflictLabel(resolveLabel, "dialogs.multipleFileMerge.primaryActions.open", "打开"), enabled: entry.canOpenFile };
}

/**
 * 根据冲突来源标签生成“接受某一侧更改”的动作文案，统一复用到 resolver 按钮区。
 */
export function buildAcceptConflictSideActionLabel(
  label: string,
  resolveLabel?: MergeConflictLabelResolver,
): string {
  const cleanLabel = String(label || "").trim();
  if (cleanLabel) {
    return resolveMergeConflictLabel(resolveLabel, "dialogs.multipleFileMerge.actions.acceptSideWithLabel", `接受${cleanLabel}`, { label: cleanLabel });
  }
  return resolveMergeConflictLabel(resolveLabel, "dialogs.multipleFileMerge.actions.acceptSide", "接受该侧更改");
}

/**
 * 解析批量采用 ours/theirs 的目标集合；优先使用显式勾选，否则回落到当前选中的 unresolved 行。
 */
export function resolveEffectiveMergeConflictPaths(args: {
  snapshot: GitConflictMergeSessionSnapshot | null | undefined;
  selectedPath: string;
  checkedPaths: string[];
}): string[] {
  const unresolvedPathSet = new Set((args.snapshot?.unresolvedEntries || []).map((entry) => entry.path));
  const checkedPaths = args.checkedPaths.filter((path) => unresolvedPathSet.has(path));
  if (checkedPaths.length > 0) return checkedPaths;
  return unresolvedPathSet.has(args.selectedPath) ? [args.selectedPath] : [];
}

/**
 * 定位下一个 unresolved 文件，保证 resolved 行可见时仍沿着未解决冲突顺序导航。
 */
export function resolveNextMergeConflictPath(
  snapshot: GitConflictMergeSessionSnapshot | null | undefined,
  selectedPath: string,
): string {
  const unresolvedEntries = snapshot?.unresolvedEntries || [];
  if (unresolvedEntries.length <= 0) return "";
  const currentIndex = unresolvedEntries.findIndex((entry) => entry.path === selectedPath);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % unresolvedEntries.length;
  return unresolvedEntries[nextIndex]?.path || "";
}

/**
 * 按 section 与目录分组构造多文件 merge 表格行，避免组件层手写重复分组逻辑。
 */
export function buildMergeConflictTableRows(args: {
  snapshot: GitConflictMergeSessionSnapshot | null | undefined;
  groupByDirectory: boolean;
  showResolved: boolean;
  expanded?: Record<string, boolean>;
  resolveLabel?: MergeConflictLabelResolver;
}): MergeConflictTableRow[] {
  const rows: MergeConflictTableRow[] = [];
  const showResolved = shouldForceShowResolvedEntries(args.snapshot, args.showResolved);
  const sections: Array<{ key: "unresolved" | "resolved"; label: string; entries: GitConflictMergeSessionEntry[] }> = [
    {
      key: "unresolved",
      label: resolveMergeConflictLabel(args.resolveLabel, "dialogs.multipleFileMerge.sections.unresolved", "未解决冲突"),
      entries: [...(args.snapshot?.unresolvedEntries || [])],
    },
  ];
  if (showResolved) {
    sections.push({
      key: "resolved",
      label: resolveMergeConflictLabel(args.resolveLabel, "dialogs.multipleFileMerge.sections.resolved", "已解决冲突"),
      entries: [...(args.snapshot?.resolvedEntries || [])],
    });
  }

  for (const section of sections) {
    if (section.entries.length <= 0) continue;
    rows.push({
      kind: "section",
      key: `section:${section.key}`,
      label: section.label,
      count: section.entries.length,
    });
    if (!args.groupByDirectory) {
      rows.push(...section.entries.map((entry) => ({
        kind: "node" as const,
        key: `node:${section.key}:file:${entry.path}`,
        sectionKey: section.key,
        node: {
          key: `merge-conflict:file:${section.key}:${entry.path}`,
          name: entry.fileName,
          fullPath: entry.path,
          isFile: true,
          count: 1,
          filePaths: [entry.path],
          kind: "file" as const,
          children: [],
        },
        depth: 0,
        entry,
      })));
      continue;
    }
    rows.push(...buildMergeConflictTreeRows({
      entries: section.entries,
      sectionKey: section.key,
      expanded: args.expanded || {},
    }));
  }
  return rows;
}

/**
 * 判断当前 dialog 是否应在“全部 unresolved 清空”后自动关闭。
 */
export function shouldAutoCloseMergeConflictDialog(
  snapshot: GitConflictMergeSessionSnapshot | null | undefined,
  autoCloseWhenResolved: boolean,
): boolean {
  return autoCloseWhenResolved && !!snapshot && snapshot.unresolvedCount <= 0;
}

/**
 * 判断关闭 resolver 时是否仍应提示“还有未解决冲突”，用于对齐 GitConflictResolver 的后置 warning 语义。
 */
export function shouldNotifyRemainingMergeConflicts(
  snapshot: GitConflictMergeSessionSnapshot | null | undefined,
): boolean {
  return !!snapshot && snapshot.unresolvedCount > 0;
}

/**
 * 生成关闭 resolver 后的未解决冲突提示文案；若仓库仍处于进行中状态，则明确提示后续还需要继续当前操作。
 */
export function buildRemainingMergeConflictNoticeMessage(
  operationState?: string,
  resolveLabel?: MergeConflictLabelResolver,
): string {
  const normalizedOperationState = String(operationState || "").trim();
  if (normalizedOperationState && normalizedOperationState !== "normal") {
    return resolveMergeConflictLabel(resolveLabel, "dialogs.multipleFileMerge.notices.remainingWithOperation", "仍有未解决冲突，请继续处理后再继续当前 Git 操作。");
  }
  return resolveMergeConflictLabel(resolveLabel, "dialogs.multipleFileMerge.notices.remaining", "仍有未解决冲突，可稍后重新打开冲突处理器继续完成。");
}
