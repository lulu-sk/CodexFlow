// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitStatusEntry } from "./types";
import type { GitUiActionGroup } from "./action-registry";
import { compactGitUiActionGroups } from "./action-registry";
import type { CommitGroupingKey } from "./commit-panel/types";
import {
  buildCommitTree,
  flattenCommitTree,
  formatCommitTreeGroupSummary,
} from "./commit-panel/changes-tree-view-model";

type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

export type GitRollbackBrowserEntryMatchSource = "status" | "path-only";
export type GitRollbackBrowserGroupingKey = "directory";

export type GitRollbackBrowserEntryGroupKey =
  | "modified"
  | "renamed"
  | "deleted"
  | "path-only";

export type GitRollbackBrowserEntry = GitStatusEntry & {
  matchSource: GitRollbackBrowserEntryMatchSource;
  groupKey: GitRollbackBrowserEntryGroupKey;
  groupLabel: string;
  directory: string;
};

export type GitRollbackBrowserDirectoryRow = {
  key: string;
  kind: "directory";
  depth: number;
  label: string;
  fileCount: number;
  directoryCount: number;
  filePaths: string[];
  expanded: boolean;
};

export type GitRollbackBrowserEntryRow = {
  key: string;
  kind: "entry";
  depth: number;
  entry: GitRollbackBrowserEntry;
};

export type GitRollbackBrowserRow = GitRollbackBrowserDirectoryRow | GitRollbackBrowserEntryRow;

export type GitRollbackBrowserActionKey =
  | "showDiff"
  | "refresh"
  | "selectAll"
  | "clearSelection"
  | "selectOnly"
  | "copyPath";

function normalizePath(value: string | undefined | null): string {
  return String(value || "").trim().replace(/\\/g, "/");
}

/**
 * 提取回滚条目的文件名；扁平模式按文件名优先排序与展示时统一复用。
 */
export function resolveRollbackEntryFileName(entryOrPath: Pick<GitRollbackBrowserEntry, "path"> | string): string {
  const normalizedPath = typeof entryOrPath === "string"
    ? normalizePath(entryOrPath)
    : normalizePath(entryOrPath.path);
  const parts = normalizedPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalizedPath;
}

function resolveRollbackDirectory(filePath: string, translate?: GitTranslate): string {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : (translate ? translate("rollbackViewer.labels.repositoryRoot", "仓库根") : "仓库根");
}

/**
 * 按 IDEA flattened comparator 语义比较路径；先比文件名，再回落到完整层级路径。
 */
function compareRollbackPaths(leftPath: string, rightPath: string, flattened: boolean): number {
  if (flattened) {
    const delta = resolveRollbackEntryFileName(leftPath).localeCompare(
      resolveRollbackEntryFileName(rightPath),
      undefined,
      { numeric: true, sensitivity: "base" },
    );
    if (delta !== 0) return delta;
  }
  return normalizePath(leftPath).localeCompare(normalizePath(rightPath), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * 按 IDEA rollback browser 的扁平/树形比较器统一排序条目，避免组件层散落重复排序规则。
 */
export function sortRollbackBrowserEntries(
  entries: GitRollbackBrowserEntry[],
  flattened: boolean,
): GitRollbackBrowserEntry[] {
  return [...(entries || [])].sort((left, right) => compareRollbackPaths(left.path, right.path, flattened));
}

function resolveRollbackGroup(
  entry: Pick<GitStatusEntry, "oldPath" | "renamed" | "deleted"> & { matchSource: GitRollbackBrowserEntryMatchSource },
  translate?: GitTranslate,
): {
  key: GitRollbackBrowserEntryGroupKey;
  label: string;
} {
  if (entry.matchSource === "path-only") {
    return {
      key: "path-only",
      label: translate ? translate("rollbackViewer.groups.pathOnly", "按路径匹配") : "按路径匹配",
    };
  }
  if (entry.deleted) {
    return {
      key: "deleted",
      label: translate ? translate("rollbackViewer.groups.deleted", "删除") : "删除",
    };
  }
  if (entry.renamed || entry.oldPath) {
    return {
      key: "renamed",
      label: translate ? translate("rollbackViewer.groups.renamed", "重命名") : "重命名",
    };
  }
  return {
    key: "modified",
    label: translate ? translate("rollbackViewer.groups.modified", "修改") : "修改",
  };
}

function toRollbackBrowserEntry(
  entry: GitStatusEntry,
  matchSource: GitRollbackBrowserEntryMatchSource,
  translate?: GitTranslate,
): GitRollbackBrowserEntry {
  const group = resolveRollbackGroup({
    oldPath: entry.oldPath,
    renamed: entry.renamed,
    deleted: entry.deleted,
    matchSource,
  }, translate);
  return {
    ...entry,
    path: normalizePath(entry.path),
    oldPath: normalizePath(entry.oldPath) || undefined,
    matchSource,
    groupKey: group.key,
    groupLabel: group.label,
    directory: resolveRollbackDirectory(entry.path, translate),
  };
}

function createPathOnlyRollbackEntry(filePath: string, translate?: GitTranslate): GitRollbackBrowserEntry {
  const normalizedPath = normalizePath(filePath);
  return toRollbackBrowserEntry({
    path: normalizedPath,
    x: "",
    y: "",
    staged: false,
    unstaged: true,
    untracked: false,
    ignored: false,
    renamed: false,
    deleted: false,
    statusText: translate ? translate("rollbackViewer.groups.pathOnlyStatus", "按路径匹配的本地更改") : "按路径匹配的本地更改",
    changeListId: "",
  }, "path-only", translate);
}

/**
 * 规范化 rollback viewer 允许的 grouping key 集；当前仅开放 IDEA 同源的目录分组。
 */
export function normalizeRollbackBrowserGroupingKeys(
  groupingKeysInput: ReadonlyArray<GitRollbackBrowserGroupingKey> | null | undefined,
): GitRollbackBrowserGroupingKey[] {
  const result: GitRollbackBrowserGroupingKey[] = [];
  for (const key of groupingKeysInput || []) {
    if (key !== "directory") continue;
    if (result.includes(key)) continue;
    result.push(key);
  }
  return result;
}

/**
 * 把 rollback viewer 的 grouping key 转成提交树模型可识别的 key，复用目录折叠与树形排序能力。
 */
function toRollbackBrowserCommitGroupingKeys(
  groupingKeys: GitRollbackBrowserGroupingKey[],
): CommitGroupingKey[] {
  return groupingKeys.includes("directory") ? ["directory"] : [];
}

/**
 * 把普通状态条目规整为 rollback browser 可直接消费的展示模型。
 */
export function buildRollbackBrowserEntriesFromStatusEntries(
  entries: GitStatusEntry[],
  translate?: GitTranslate,
): GitRollbackBrowserEntry[] {
  return (entries || [])
    .filter((entry) => !entry.ignored && !entry.untracked)
    .map((entry) => toRollbackBrowserEntry(entry, "status", translate));
}

/**
 * 根据 operation problem 的文件列表构建 rollback browser 条目；缺少快照时回退为 path-only 候选。
 */
export function buildOperationProblemRollbackEntries(
  problemFiles: string[],
  statusEntries: GitStatusEntry[],
  translate?: GitTranslate,
): GitRollbackBrowserEntry[] {
  const statusByPath = new Map<string, GitStatusEntry>();
  for (const entry of statusEntries || []) {
    if (entry.ignored || entry.untracked) continue;
    const path = normalizePath(entry.path);
    const oldPath = normalizePath(entry.oldPath);
    if (path && !statusByPath.has(path)) statusByPath.set(path, entry);
    if (oldPath && !statusByPath.has(oldPath)) statusByPath.set(oldPath, entry);
  }

  const result: GitRollbackBrowserEntry[] = [];
  const seenPaths = new Set<string>();
  for (const filePath of problemFiles || []) {
    const normalizedPath = normalizePath(filePath);
    if (!normalizedPath || seenPaths.has(normalizedPath)) continue;
    seenPaths.add(normalizedPath);
    const matchedEntry = statusByPath.get(normalizedPath);
    result.push(matchedEntry ? toRollbackBrowserEntry(matchedEntry, "status", translate) : createPathOnlyRollbackEntry(normalizedPath, translate));
  }
  return result;
}

/**
 * 构建 rollback viewer 的线性渲染行；目录分组开启时复用提交树目录折叠逻辑，否则走 IDEA 风格扁平列表。
 */
export function buildRollbackBrowserRows(
  entries: GitRollbackBrowserEntry[],
  groupingKeysInput: ReadonlyArray<GitRollbackBrowserGroupingKey> | null | undefined,
  expanded: Readonly<Record<string, boolean>>,
  translate?: GitTranslate,
): GitRollbackBrowserRow[] {
  const groupingKeys = normalizeRollbackBrowserGroupingKeys(groupingKeysInput);
  const sortedEntries = sortRollbackBrowserEntries(entries, !groupingKeys.includes("directory"));
  if (!groupingKeys.includes("directory")) {
    return sortedEntries.map((entry) => ({
      key: `rb:file:${entry.path}`,
      kind: "entry",
      depth: 0,
      entry,
    }));
  }

  const treeRows = flattenCommitTree(
    buildCommitTree(sortedEntries, "rollback-browser", toRollbackBrowserCommitGroupingKeys(groupingKeys), translate),
    expanded || {},
  );
  const result: GitRollbackBrowserRow[] = [];
  for (const { node, depth } of treeRows) {
    if (node.kind === "directory") {
      result.push({
        key: node.key,
        kind: "directory" as const,
        depth,
        label: String(node.textPresentation || node.name || "").trim(),
        fileCount: node.fileCount || node.filePaths.length,
        directoryCount: node.directoryCount || 0,
        filePaths: [...node.filePaths],
        expanded: expanded[node.key] !== false,
      });
      continue;
    }
    const entry = node.entry as GitRollbackBrowserEntry | undefined;
    if (!entry) continue;
    result.push({
      key: node.key,
      kind: "entry" as const,
      depth,
      entry,
    });
  }
  return result;
}

/**
 * 按 changes browser 分组语义组织 rollback 条目，供独立 browser 与测试共用。
 */
export function groupRollbackBrowserEntries(
  entries: GitRollbackBrowserEntry[],
): Array<{ key: GitRollbackBrowserEntryGroupKey; label: string; entries: GitRollbackBrowserEntry[] }> {
  const groups = new Map<GitRollbackBrowserEntryGroupKey, { key: GitRollbackBrowserEntryGroupKey; label: string; entries: GitRollbackBrowserEntry[] }>();
  for (const entry of entries || []) {
    const current = groups.get(entry.groupKey) || {
      key: entry.groupKey,
      label: entry.groupLabel,
      entries: [],
    };
    current.entries.push(entry);
    groups.set(entry.groupKey, current);
  }
  const orderedKeys: GitRollbackBrowserEntryGroupKey[] = ["modified", "renamed", "deleted", "path-only"];
  return orderedKeys
    .map((key) => groups.get(key))
    .filter((group): group is { key: GitRollbackBrowserEntryGroupKey; label: string; entries: GitRollbackBrowserEntry[] } => !!group)
    .map((group) => ({
      ...group,
      entries: sortRollbackBrowserEntries(group.entries, true),
    }));
}

/**
 * 统计 rollback browser 当前列表摘要，方便标题区与测试共用。
 */
export function buildRollbackBrowserSummary(entries: GitRollbackBrowserEntry[]): {
  renamed: number;
  deleted: number;
  modified: number;
  pathOnly: number;
} {
  let renamed = 0;
  let deleted = 0;
  let modified = 0;
  let pathOnly = 0;
  for (const entry of entries || []) {
    if (entry.matchSource === "path-only") {
      pathOnly += 1;
      continue;
    }
    if (entry.deleted) {
      deleted += 1;
      continue;
    }
    if (entry.renamed || entry.oldPath) {
      renamed += 1;
      continue;
    }
    modified += 1;
  }
  return { renamed, deleted, modified, pathOnly };
}

/**
 * 把文件状态映射为统一徽标色调，保证 rollback browser 的风险感知一致。
 */
export function resolveRollbackEntryTone(entry: GitRollbackBrowserEntry): string {
  if (entry.matchSource === "path-only") return "bg-[var(--cf-blue-light)] text-[var(--cf-blue)]";
  if (entry.deleted) return "bg-[var(--cf-red-light)] text-[var(--cf-red)]";
  if (entry.renamed || entry.oldPath) return "bg-[var(--cf-yellow-light)] text-[var(--cf-warning-foreground)]";
  if (entry.unstaged) return "bg-[var(--cf-accent-light)] text-[var(--cf-accent)]";
  return "bg-[var(--cf-surface-muted)] text-[var(--cf-text-secondary)]";
}

/**
 * 生成目录行右侧的简洁统计文案，对齐目录节点“聚合摘要而非重复明细”的展示原则。
 */
export function formatRollbackBrowserDirectorySummary(
  row: Pick<GitRollbackBrowserDirectoryRow, "fileCount" | "directoryCount">,
  translate?: GitTranslate,
): string {
  return formatCommitTreeGroupSummary({
    fileCount: row.fileCount,
    directoryCount: row.directoryCount,
  }, translate);
}

/**
 * 构造 rollback browser 的 toolbar / popup 动作分组，统一各入口的动作排序与可用性。
 */
export function buildRollbackBrowserActionGroups(args: {
  hasEntries: boolean;
  hasSelection: boolean;
  hasActiveEntry: boolean;
  translate?: GitTranslate;
}): GitUiActionGroup<GitRollbackBrowserActionKey>[] {
  const gt = args.translate;
  return compactGitUiActionGroups([
    {
      id: "navigate",
      items: [
        {
          id: "showDiff",
          label: gt ? gt("rollbackViewer.actions.showDiff", "显示差异") : "显示差异",
          shortcut: "Ctrl+D",
          enabled: args.hasActiveEntry,
        },
        {
          id: "refresh",
          label: gt ? gt("rollbackViewer.actions.refresh", "刷新") : "刷新",
          enabled: true,
        },
      ],
    },
    {
      id: "selection",
      items: [
        {
          id: "selectAll",
          label: gt ? gt("rollbackViewer.actions.selectAll", "全选") : "全选",
          enabled: args.hasEntries,
        },
        {
          id: "clearSelection",
          label: gt ? gt("rollbackViewer.actions.clearSelection", "取消全选") : "取消全选",
          enabled: args.hasSelection,
        },
        {
          id: "selectOnly",
          label: gt ? gt("rollbackViewer.actions.selectOnly", "仅选择当前项") : "仅选择当前项",
          enabled: args.hasActiveEntry,
        },
      ],
    },
    {
      id: "misc",
      items: [
        {
          id: "copyPath",
          label: gt ? gt("rollbackViewer.actions.copyPath", "复制路径") : "复制路径",
          enabled: args.hasActiveEntry,
        },
      ],
    },
  ]);
}
