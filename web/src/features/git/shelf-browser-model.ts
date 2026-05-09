// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitStatusEntry } from "./types";
import type { CommitGroupingKey } from "./commit-panel/types";
import {
  buildCommitTree,
  buildCommitTreeGroupSummary,
  flattenCommitTree,
  formatCommitTreeGroupSummary,
} from "./commit-panel/changes-tree-view-model";
import type { GitShelfItem } from "./types";

type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

export type GitShelfBrowserGroupingKey = "directory";

export type GitShelfBrowserTagRow = {
  key: string;
  kind: "tag";
  depth: number;
  label: string;
  expanded: boolean;
  itemCount: number;
};

export type GitShelfBrowserShelfRow = {
  key: string;
  kind: "shelf";
  depth: number;
  shelf: GitShelfItem;
  expanded: boolean;
  fileCount: number;
  directoryCount: number;
};

export type GitShelfBrowserDirectoryRow = {
  key: string;
  kind: "directory";
  depth: number;
  shelf: GitShelfItem;
  label: string;
  fileCount: number;
  directoryCount: number;
  filePaths: string[];
  expanded: boolean;
};

export type GitShelfBrowserFileRow = {
  key: string;
  kind: "file";
  depth: number;
  shelf: GitShelfItem;
  path: string;
  fileName: string;
  directory: string;
};

export type GitShelfBrowserRow =
  | GitShelfBrowserTagRow
  | GitShelfBrowserShelfRow
  | GitShelfBrowserDirectoryRow
  | GitShelfBrowserFileRow;

type ShelfPathEntry = GitStatusEntry & {
  readonly __cfShelfPathEntry: true;
};

/**
 * 规整 shelf 里记录的路径，避免分隔符与空白差异导致树节点重复。
 */
function normalizeShelfPath(pathText: string | undefined | null): string {
  return String(pathText || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * 输出 shelf 文件项展示用的文件名；空路径时直接回退原始文本。
 */
export function resolveShelfBrowserFileName(pathText: string): string {
  const normalizedPath = normalizeShelfPath(pathText);
  const parts = normalizedPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalizedPath;
}

/**
 * 输出 shelf 文件项展示用的目录文本；仓库根目录统一显示为“仓库根”。
 */
export function resolveShelfBrowserDirectory(pathText: string, translate?: GitTranslate): string {
  const normalizedPath = normalizeShelfPath(pathText);
  const index = normalizedPath.lastIndexOf("/");
  return index > 0 ? normalizedPath.slice(0, index) : (translate ? translate("shelf.labels.repositoryRoot", "仓库根") : "仓库根");
}

/**
 * 规范化 shelf browser 的 grouping key；当前仅开放 IDEA 同源的目录分组。
 */
export function normalizeShelfBrowserGroupingKeys(
  groupingKeysInput: ReadonlyArray<GitShelfBrowserGroupingKey> | null | undefined,
): GitShelfBrowserGroupingKey[] {
  const result: GitShelfBrowserGroupingKey[] = [];
  for (const key of groupingKeysInput || []) {
    if (key !== "directory") continue;
    if (result.includes(key)) continue;
    result.push(key);
  }
  return result;
}

/**
 * 把 shelf browser 的 grouping key 映射成提交树模型可识别的 key，复用目录折叠与排序逻辑。
 */
function toShelfBrowserCommitGroupingKeys(
  groupingKeys: GitShelfBrowserGroupingKey[],
): CommitGroupingKey[] {
  return groupingKeys.includes("directory") ? ["directory"] : [];
}

/**
 * 按 IDEA shelf tree 的扁平比较器比较路径；无目录分组时先按文件名，再回落完整路径。
 */
function compareShelfPaths(leftPath: string, rightPath: string, flattened: boolean): number {
  if (flattened) {
    const fileNameDelta = resolveShelfBrowserFileName(leftPath).localeCompare(
      resolveShelfBrowserFileName(rightPath),
      undefined,
      { numeric: true, sensitivity: "base" },
    );
    if (fileNameDelta !== 0) return fileNameDelta;
  }
  return normalizeShelfPath(leftPath).localeCompare(normalizeShelfPath(rightPath), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * 按当前 shelf 条目构造伪状态项，借用提交树模型完成目录分组与连续目录折叠。
 */
function buildShelfPathEntry(shelf: GitShelfItem, filePath: string): ShelfPathEntry {
  const normalizedPath = normalizeShelfPath(filePath);
  return {
    __cfShelfPathEntry: true,
    path: normalizedPath,
    x: "",
    y: "",
    staged: false,
    unstaged: true,
    untracked: false,
    ignored: false,
    renamed: false,
    deleted: false,
    statusText: "shelf-path",
    changeListId: shelf.ref,
    repositoryId: shelf.repoRoot,
    repositoryRoot: shelf.repoRoot,
    repositoryName: shelf.repoRoots[0] || shelf.repoRoot,
  };
}

/**
 * 返回单条 shelf 记录里的唯一路径列表，并按当前展示模式稳定排序。
 */
function collectShelfPaths(
  shelf: GitShelfItem,
  flattened: boolean,
): string[] {
  return Array.from(new Set(
    (shelf.paths || [])
      .map((item) => normalizeShelfPath(item))
      .filter(Boolean),
  )).sort((left, right) => compareShelfPaths(left, right, flattened));
}

/**
 * 统计单条 shelf 的目录数与文件数，供列表节点摘要复用。
 */
function buildShelfSummary(shelf: GitShelfItem): { fileCount: number; directoryCount: number } {
  return buildCommitTreeGroupSummary(
    collectShelfPaths(shelf, false).map((filePath) => buildShelfPathEntry(shelf, filePath)),
  );
}

/**
 * 为单条 shelf 记录生成稳定的行 key 片段，避免 ref 中的特殊字符污染后续拼接。
 */
function resolveShelfKeyFragment(ref: string): string {
  return String(ref || "").trim().replace(/[^a-zA-Z0-9_-]+/g, "_") || "unknown";
}

/**
 * 按目录分组设置构造单条 shelf 的子路径行；无目录分组时退化为扁平文件列表。
 */
function buildShelfChildRows(
  shelf: GitShelfItem,
  depth: number,
  groupingKeys: GitShelfBrowserGroupingKey[],
  expanded: Readonly<Record<string, boolean>>,
  translate?: GitTranslate,
): GitShelfBrowserRow[] {
  const pathEntries = collectShelfPaths(shelf, !groupingKeys.includes("directory"))
    .map((filePath) => buildShelfPathEntry(shelf, filePath));
  if (pathEntries.length <= 0) return [];
  if (!groupingKeys.includes("directory")) {
    return pathEntries.map((entry) => ({
      key: `shelf:file:${resolveShelfKeyFragment(shelf.ref)}:${entry.path}`,
      kind: "file" as const,
      depth,
      shelf,
      path: entry.path,
      fileName: resolveShelfBrowserFileName(entry.path),
      directory: resolveShelfBrowserDirectory(entry.path, translate),
    }));
  }
  const treeRows = flattenCommitTree(
    buildCommitTree(pathEntries, `shelf-browser:${resolveShelfKeyFragment(shelf.ref)}`, toShelfBrowserCommitGroupingKeys(groupingKeys), translate),
    expanded || {},
  );
  const result: GitShelfBrowserRow[] = [];
  for (const { node, depth: nodeDepth } of treeRows) {
    if (node.kind === "directory") {
      result.push({
        key: node.key,
        kind: "directory" as const,
        depth: depth + nodeDepth,
        shelf,
        label: String(node.textPresentation || node.name || "").trim(),
        fileCount: node.fileCount || node.filePaths.length,
        directoryCount: node.directoryCount || 0,
        filePaths: [...node.filePaths],
        expanded: expanded[node.key] !== false,
      });
      continue;
    }
    const entry = node.entry as ShelfPathEntry | undefined;
    if (!entry?.__cfShelfPathEntry) continue;
    result.push({
      key: `shelf:file:${resolveShelfKeyFragment(shelf.ref)}:${entry.path}`,
      kind: "file" as const,
      depth: depth + nodeDepth,
      shelf,
      path: entry.path,
      fileName: resolveShelfBrowserFileName(entry.path),
      directory: resolveShelfBrowserDirectory(entry.path, translate),
    });
  }
  return result;
}

/**
 * 把单条 shelf 记录投影成浏览器行；默认根级列表深度为 0，最近删除标签下的列表从 1 开始。
 */
function buildShelfRows(
  shelf: GitShelfItem,
  depth: number,
  groupingKeys: GitShelfBrowserGroupingKey[],
  expanded: Readonly<Record<string, boolean>>,
  translate?: GitTranslate,
): GitShelfBrowserRow[] {
  const shelfKey = `shelf:list:${resolveShelfKeyFragment(shelf.ref)}`;
  const summary = buildShelfSummary(shelf);
  const row: GitShelfBrowserShelfRow = {
    key: shelfKey,
    kind: "shelf",
    depth,
    shelf,
    expanded: expanded[shelfKey] !== false,
    fileCount: summary.fileCount,
    directoryCount: summary.directoryCount,
  };
  if (expanded[shelfKey] === false) return [row];
  return [
    row,
    ...buildShelfChildRows(shelf, depth + 1, groupingKeys, expanded, translate),
  ];
}

/**
 * 判断当前 shelf 是否应显示在活动列表；deleted 固定单独进入“最近删除”，recycled 仅在 showRecycled 下展示。
 */
function isVisibleActiveShelf(shelf: GitShelfItem, showRecycled: boolean): boolean {
  if (shelf.state === "deleted") return false;
  if (shelf.state === "recycled") return showRecycled;
  return true;
}

/**
 * 构建 shelf browser 的线性渲染行，对齐 IDEA 的活动列表 + 最近删除标签结构。
 */
export function buildShelfBrowserRows(args: {
  items: GitShelfItem[];
  showRecycled: boolean;
  groupingKeys?: ReadonlyArray<GitShelfBrowserGroupingKey> | null;
  expanded?: Readonly<Record<string, boolean>>;
  translate?: GitTranslate;
}): GitShelfBrowserRow[] {
  const groupingKeys = normalizeShelfBrowserGroupingKeys(args.groupingKeys);
  const expanded = args.expanded || {};
  const gt = args.translate;
  const activeShelves = (args.items || []).filter((item) => isVisibleActiveShelf(item, args.showRecycled));
  const deletedShelves = (args.items || []).filter((item) => item.state === "deleted");
  const result: GitShelfBrowserRow[] = [];
  for (const shelf of activeShelves) {
    result.push(...buildShelfRows(shelf, 0, groupingKeys, expanded, gt));
  }
  if (deletedShelves.length <= 0) return result;
  const deletedTagKey = "shelf:tag:recently-deleted";
  result.push({
    key: deletedTagKey,
    kind: "tag",
    depth: 0,
    label: gt ? gt("shelf.recentlyDeleted", "最近删除") : "最近删除",
    expanded: expanded[deletedTagKey] !== false,
    itemCount: deletedShelves.length,
  });
  if (expanded[deletedTagKey] === false) return result;
  for (const shelf of deletedShelves) {
    result.push(...buildShelfRows(shelf, 1, groupingKeys, expanded, gt));
  }
  return result;
}

/**
 * 格式化目录行摘要，保持目录节点只展示聚合计数而不重复列出细节。
 */
export function formatShelfBrowserDirectorySummary(
  row: Pick<GitShelfBrowserDirectoryRow, "fileCount" | "directoryCount">,
  translate?: GitTranslate,
): string {
  return formatCommitTreeGroupSummary({
    fileCount: row.fileCount,
    directoryCount: row.directoryCount,
  }, translate);
}
