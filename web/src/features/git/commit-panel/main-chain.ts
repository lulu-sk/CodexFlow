// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitDiffMode, GitDiffSnapshot, GitLocalChangesConfig, GitStatusEntry } from "../types";
import { resolveCommitPreviewDiffMode } from "./interaction-model";
import {
  buildCommitDiffSelection,
  buildCommitDiffSelectionFromNodes,
  type CommitDiffSelection,
} from "./selection-model";
import type { CommitTreeNode } from "./types";

export type CommitDiffSelectionKind = CommitDiffSelection["kind"] | "single";

export type CommitDiffOpenRequest = {
  path: string;
  oldPath?: string;
  mode: GitDiffMode;
  hash?: string;
  hashes?: string[];
  shelfRef?: string;
  selectionPaths: string[];
  selectionKind: CommitDiffSelectionKind;
  selectionIndex: number;
};

/**
 * 将任意 diff 选择结果规整成主链路可消费的路径集合，并保证当前主路径始终包含在内。
 */
function normalizeCommitDiffSelectionPaths(primaryPath: string, selection?: CommitDiffSelection | null): string[] {
  const normalizedPrimaryPath = String(primaryPath || "").trim().replace(/\\/g, "/");
  const pathSet = new Set<string>();
  for (const one of selection?.paths || []) {
    const cleanPath = String(one || "").trim().replace(/\\/g, "/");
    if (cleanPath) pathSet.add(cleanPath);
  }
  if (normalizedPrimaryPath) pathSet.add(normalizedPrimaryPath);
  return Array.from(pathSet);
}

/**
 * 把 selection builder 结果转成真正的 Diff 打开请求，统一附带组选区元数据。
 */
function buildCommitDiffOpenRequestFromSelection(args: {
  path: string;
  oldPath?: string;
  mode: GitDiffMode;
  hash?: string;
  hashes?: string[];
  selection?: CommitDiffSelection | null;
}): CommitDiffOpenRequest | null {
  const path = String(args.path || "").trim().replace(/\\/g, "/");
  if (!path) return null;
  const selectionPaths = normalizeCommitDiffSelectionPaths(path, args.selection);
  const selectionIndex = Math.max(0, selectionPaths.indexOf(path));
  return {
    path,
    oldPath: String(args.oldPath || "").trim().replace(/\\/g, "/") || undefined,
    mode: args.mode,
    hash: String(args.hash || "").trim() || undefined,
    hashes: Array.from(new Set((args.hashes || []).map((one) => String(one || "").trim()).filter(Boolean))),
    shelfRef: undefined,
    selectionPaths,
    selectionKind: args.selection?.kind || "single",
    selectionIndex,
  };
}

/**
 * 按当前主树选择构建提交面板 Diff 打开请求，真正把 changelist/amend/unversioned 整组选区接入主链路。
 */
export function buildCommitDiffOpenRequest(args: {
  entry: GitStatusEntry;
  selectedNodeKeys: string[];
  nodeMap: Map<string, CommitTreeNode>;
  selectedEntries: GitStatusEntry[];
  allEntries: GitStatusEntry[];
  localChangesConfig: GitLocalChangesConfig;
  hash?: string;
  hashes?: string[];
  mode?: GitDiffMode;
}): CommitDiffOpenRequest | null {
  const entry = args.entry;
  const hasLeadNodeSelection = args.selectedNodeKeys.some((nodeKey) => {
    const node = args.nodeMap.get(nodeKey);
    return (
      !!node?.entry
      && String(node.entry.path || "").replace(/\\/g, "/") === String(entry.path || "").replace(/\\/g, "/")
      && String(node.entry.changeListId || "") === String(entry.changeListId || "")
    );
  });
  const selection = hasLeadNodeSelection
    ? buildCommitDiffSelectionFromNodes({
        selectedNodeKeys: args.selectedNodeKeys,
        nodeMap: args.nodeMap,
      })
    : buildCommitDiffSelection({
        selectedEntries: args.selectedEntries.some((selected) => (
          String(selected.path || "").replace(/\\/g, "/") === String(entry.path || "").replace(/\\/g, "/")
          && String(selected.changeListId || "") === String(entry.changeListId || "")
        ))
          ? args.selectedEntries
          : [entry],
        allEntries: args.allEntries,
      });
  return buildCommitDiffOpenRequestFromSelection({
    path: entry.path,
    mode: args.mode || resolveCommitPreviewDiffMode(entry, args.localChangesConfig),
    hash: args.hash,
    hashes: args.hashes,
    selection,
  });
}

/**
 * 按单个树节点构建 hover/双击专用 Diff 请求，确保节点覆写动作也能携带同来源整组选区。
 */
export function buildCommitNodeDiffOpenRequest(args: {
  nodeKey: string;
  nodeMap: Map<string, CommitTreeNode>;
  localChangesConfig: GitLocalChangesConfig;
  hash?: string;
  hashes?: string[];
  mode?: GitDiffMode;
}): CommitDiffOpenRequest | null {
  const node = args.nodeMap.get(args.nodeKey);
  if (!node?.entry) return null;
  const selection = buildCommitDiffSelectionFromNodes({
    selectedNodeKeys: [args.nodeKey],
    nodeMap: args.nodeMap,
  });
  return buildCommitDiffOpenRequestFromSelection({
    path: node.entry.path,
    mode: args.mode || resolveCommitPreviewDiffMode(node.entry, args.localChangesConfig),
    hash: args.hash,
    hashes: args.hashes,
    selection,
  });
}

/**
 * 把主链路携带的组选区元数据回写到 Diff 快照，供右侧工具栏与文件切换继续复用。
 */
export function applyCommitDiffOpenRequestToSnapshot(
  snapshot: GitDiffSnapshot | null,
  request: CommitDiffOpenRequest,
): GitDiffSnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    path: request.path,
    oldPath: request.oldPath,
    selectionPaths: request.selectionPaths,
    selectionKind: request.selectionKind,
    selectionIndex: request.selectionIndex,
    shelfRef: request.shelfRef,
  };
}

/**
 * 基于当前 Diff 快照解析上一文件/下一文件请求，保证文件组导航复用同一组选区上下文。
 */
export function buildAdjacentCommitDiffOpenRequest(
  snapshot: GitDiffSnapshot | null | undefined,
  direction: "prev" | "next",
): CommitDiffOpenRequest | null {
  if (!snapshot) return null;
  const currentPath = String(snapshot.path || "").trim().replace(/\\/g, "/");
  if (!currentPath) return null;
  const selectionPaths = Array.from(new Set(
    [
      ...(snapshot.selectionPaths || []).map((one) => String(one || "").trim().replace(/\\/g, "/")).filter(Boolean),
      currentPath,
    ],
  ));
  if (selectionPaths.length <= 1) return null;
  const currentIndex = selectionPaths.indexOf(currentPath);
  const baseIndex = currentIndex >= 0 ? currentIndex : Math.max(0, Math.min(selectionPaths.length - 1, snapshot.selectionIndex || 0));
  const nextIndex = direction === "prev"
    ? (baseIndex - 1 + selectionPaths.length) % selectionPaths.length
    : (baseIndex + 1) % selectionPaths.length;
  return {
    path: selectionPaths[nextIndex],
    oldPath: snapshot.oldPath,
    mode: snapshot.mode,
    hash: snapshot.hash,
    hashes: snapshot.hashes,
    shelfRef: snapshot.shelfRef,
    selectionPaths,
    selectionKind: snapshot.selectionKind || "single",
    selectionIndex: nextIndex,
  };
}
