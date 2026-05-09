// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitStatusEntry } from "../types";
import { COMMIT_TREE_ACTION_GROUPS } from "./action-groups";
import { resolveCommitConflictNodeActions } from "./conflict-actions";
import { DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID, normalizeCommitGroupingKeys, normalizeCommitPanelManyFilesThreshold } from "./config";
import { isEntryActionable } from "./inclusion-model";
import type {
  BuildChangeEntryGroupsArgs,
  ChangeEntryGroup,
  CommitPanelRenderRow,
  CommitTreeGroup,
  CommitTreeGroupState,
  CommitTreeGroupSummary,
  CommitTreeNode,
  CommitTreeRenderPayload,
  CommitTreeSelectionFlags,
} from "./types";

type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

const COMMIT_GROUP_SORT_WEIGHT: Record<ChangeEntryGroup["kind"], number> = {
  "conflict": 0,
  "resolved-conflict": 0,
  "changelist": 1,
  "edited-commit": 10,
  "repository": 3,
  "module": 4,
  "staged": 7,
  "unstaged": 7,
  "local": 10,
  "unversioned": 9,
  "ignored": 11,
};

const DIRECTORY_NODE_SORT_WEIGHT = 5;
const FILE_NODE_SORT_WEIGHT = 7;

/**
 * 统一归一化提交树使用的仓库相对路径，避免同一路径因分隔符差异形成重复节点。
 */
function normalizeCommitPath(pathText: string): string {
  return String(pathText || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * 把提交树展示路径统一转成平台风格的反斜杠文案，内部索引仍保持 `/`。
 */
function formatCommitDisplayPath(pathText: string): string {
  return normalizeCommitPath(pathText).replace(/\//g, "\\");
}

/**
 * 按当前可见父节点裁剪折叠目录文案，确保子目录折叠后显示相对路径而非整段仓库根前缀。
 */
function buildCollapsedDirectoryTextPresentation(basePath: string, targetPath: string): string {
  const normalizedBasePath = normalizeCommitPath(basePath);
  const normalizedTargetPath = normalizeCommitPath(targetPath);
  if (!normalizedTargetPath) return "";
  if (!normalizedBasePath) return formatCommitDisplayPath(normalizedTargetPath);
  const relativePath = normalizedTargetPath === normalizedBasePath
    ? normalizedTargetPath
    : normalizedTargetPath.startsWith(`${normalizedBasePath}/`)
      ? normalizedTargetPath.slice(normalizedBasePath.length + 1)
      : normalizedTargetPath;
  return formatCommitDisplayPath(relativePath || normalizedTargetPath);
}

/**
 * 对齐上游 `ChangesBrowserSpecificNode.isManyFiles()` 语义。
 */
function isManySpecialFiles(entries: GitStatusEntry[], manyFilesThreshold: number): boolean {
  return entries.length > manyFilesThreshold;
}

/**
 * 按当前 group kind 构建基础选择标记，后续渲染、复制、键盘与右键上下文都复用这套元数据。
 */
function buildGroupSelectionFlags(group: Pick<ChangeEntryGroup, "helper" | "kind" | "entries">): CommitTreeSelectionFlags {
  const inclusionVisible = (
    group.kind === "changelist"
    || (group.kind === "unversioned" && group.entries.length > 0)
  );
  return {
    selectable: true,
    inclusionVisible,
    inclusionEnabled: inclusionVisible && group.entries.length > 0,
    hideInclusionCheckbox: !inclusionVisible,
    helper: group.helper === true || group.kind !== "changelist",
  };
}

/**
 * 按节点类型推导统一排序权重，避免 UI 再散写临时排序逻辑。
 */
function resolveGroupSortWeight(group: Pick<ChangeEntryGroup, "kind" | "changeListId">): number {
  if (group.kind !== "changelist") return COMMIT_GROUP_SORT_WEIGHT[group.kind];
  return String(group.changeListId || "").trim() === DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID ? 1 : 2;
}

/**
 * 统一构建 group renderer/search/copy 共用的显示载荷。
 */
function buildGroupRenderPayload(group: ChangeEntryGroup): CommitTreeRenderPayload {
  const countText = group.summary ? formatCommitTreeGroupSummary(group.summary) : undefined;
  return {
    textPresentation: group.label,
    countText,
    tooltipText: group.state?.frozenReason,
    manyFiles: group.manyFiles === true,
    browseActionVisible: group.manyFiles === true,
    updating: group.state?.updating === true,
    frozenReason: group.state?.frozenReason,
    outdatedFileCount: group.state?.outdatedFileCount || 0,
    infoMarkerVisible: group.kind === "changelist" && String(group.changeListId || "").trim() === DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID,
    isDefault: group.kind === "changelist" && String(group.changeListId || "").trim() === DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID,
  };
}

/**
 * 按 group 权重与文案稳定排序，确保 changelist/helper node 混排时顺序可预测。
 */
function sortGroups(groups: ChangeEntryGroup[]): ChangeEntryGroup[] {
  return [...groups].sort((left, right) => {
    const weightDiff = (left.sortWeight ?? 10) - (right.sortWeight ?? 10);
    if (weightDiff !== 0) return weightDiff;
    if (left.kind === "changelist" && right.kind === "changelist") {
      const defaultLeft = String(left.changeListId || "").trim() === DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID ? 0 : 1;
      const defaultRight = String(right.changeListId || "").trim() === DEFAULT_COMMIT_PANEL_CHANGE_LIST_ID ? 0 : 1;
      if (defaultLeft !== defaultRight) return defaultLeft - defaultRight;
    }
    return left.label.localeCompare(right.label, "zh-CN");
  });
}

/**
 * 统计 helper node 的目录数与文件数，供标题计数文案复用。
 */
export function buildCommitTreeGroupSummary(entries: GitStatusEntry[]): CommitTreeGroupSummary {
  const fileSet = new Set<string>();
  const directorySet = new Set<string>();
  for (const entry of entries) {
    const cleanPath = normalizeCommitPath(entry.path);
    if (!cleanPath) continue;
    fileSet.add(cleanPath);
    const parts = cleanPath.split("/").filter(Boolean);
    let current = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = current ? `${current}/${parts[index]}` : parts[index];
      directorySet.add(current);
    }
  }
  return {
    fileCount: fileSet.size,
    directoryCount: directorySet.size,
  };
}

/**
 * 把目录/文件统计转成 helper node 标题计数字样。
 */
export function formatCommitTreeGroupSummary(summary: CommitTreeGroupSummary | undefined, translate?: GitTranslate): string {
  if (!summary) return translate ? translate("commitTree.summary.zeroFiles", "0 个文件") : "0 个文件";
  const directoryCount = Math.max(0, Math.floor(summary.directoryCount));
  const fileCount = Math.max(0, Math.floor(summary.fileCount));
  if (directoryCount > 0 && fileCount > 0) {
    return translate
      ? translate("commitTree.summary.directoriesAndFiles", "{{directoryCount}} 个目录，{{fileCount}} 个文件", { directoryCount, fileCount })
      : `${directoryCount} 个目录，${fileCount} 个文件`;
  }
  if (directoryCount > 0) {
    return translate
      ? translate("commitTree.summary.directoriesOnly", "{{directoryCount}} 个目录", { directoryCount })
      : `${directoryCount} 个目录`;
  }
  return translate
    ? translate("commitTree.summary.filesOnly", "{{fileCount}} 个文件", { fileCount })
    : `${fileCount} 个文件`;
}

/**
 * 统一构建 helper node 的 updating / frozen / outdated 状态模型。
 */
export function buildCommitTreeGroupState(input?: Partial<CommitTreeGroupState>): CommitTreeGroupState {
  return {
    updating: input?.updating === true,
    frozenReason: String(input?.frozenReason || "").trim() || undefined,
    outdatedFileCount: Math.max(0, Math.floor(Number(input?.outdatedFileCount) || 0)),
  };
}

/**
 * 输出 group 级统一文本表示，供 renderer/speed search/copy provider 复用。
 */
export function getCommitGroupTextPresentation(group: Pick<ChangeEntryGroup, "label" | "renderPayload">): string {
  return String(group.renderPayload?.textPresentation || group.label || "").trim();
}

/**
 * 输出 node 级统一文本表示，供 renderer/speed search/copy provider 复用。
 */
export function getCommitNodeTextPresentation(node: Pick<CommitTreeNode, "textPresentation" | "name" | "fullPath">): string {
  return String(node.textPresentation || node.name || node.fullPath || "").trim();
}

/**
 * 按提交面板模式构建 section；结构对齐上游 changelist/helper node 思路，并预留 conflict/resolved conflict 扩展。
 */
export function buildChangeEntryGroups(args: BuildChangeEntryGroupsArgs): ChangeEntryGroup[] {
  const gt = args.translate;
  const manyFilesThreshold = normalizeCommitPanelManyFilesThreshold(args.manyFilesThreshold);
  const frozenReason = args.operationState && args.operationState !== "normal"
    ? (gt ? gt("commitTree.frozenReason", "当前仓库处于 {{state}} 状态", { state: args.operationState }) : `当前仓库处于 ${args.operationState} 状态`)
    : "";

  /**
   * 为分组填充统一摘要、排序权重、显示载荷与选择标记，避免 UI 自己拼条件。
   */
  const finalizeGroup = (group: ChangeEntryGroup): ChangeEntryGroup => {
    const withSummary: ChangeEntryGroup = {
      ...group,
      summary: buildCommitTreeGroupSummary(group.entries),
      state: buildCommitTreeGroupState({
        frozenReason,
        ...args.stateByGroupKey?.[group.key],
      }),
    };
    return {
      ...withSummary,
      sortWeight: resolveGroupSortWeight(withSummary),
      stableId: withSummary.key,
      selectionFlags: buildGroupSelectionFlags(withSummary),
      renderPayload: buildGroupRenderPayload(withSummary),
      sourceKind: withSummary.sourceKind || "status",
      sourceId: withSummary.sourceId || withSummary.key,
      actionGroupId: withSummary.actionGroupId || COMMIT_TREE_ACTION_GROUPS.mainPopup,
      toolbarActionGroupId: withSummary.toolbarActionGroupId || COMMIT_TREE_ACTION_GROUPS.mainToolbar,
    };
  };

  const actionableEntries = args.entries.filter((entry) => isEntryActionable(entry));
  const conflictEntries = actionableEntries.filter((entry) => entry.conflictState === "conflict");
  const resolvedConflictEntries = actionableEntries.filter((entry) => entry.conflictState === "resolved");
  const normalEntries = actionableEntries.filter((entry) => !entry.conflictState);
  const trackedEntries = normalEntries.filter((entry) => !entry.untracked);
  const unversionedEntries = normalEntries.filter((entry) => entry.untracked);
  const ignoredEntries = args.ignoredEntries;
  const out: ChangeEntryGroup[] = [];

  if (conflictEntries.length > 0) {
    out.push(finalizeGroup({
      key: "special:conflicts",
      label: gt ? gt("commitTree.groups.conflict", "冲突") : "冲突",
      entries: conflictEntries,
      kind: "conflict",
      helper: true,
    }));
  }
  if (resolvedConflictEntries.length > 0) {
    out.push(finalizeGroup({
      key: "special:resolved-conflicts",
      label: gt ? gt("commitTree.groups.resolvedConflict", "已解决冲突") : "已解决冲突",
      entries: resolvedConflictEntries,
      kind: "resolved-conflict",
      helper: true,
    }));
  }

  if (args.options.stagingAreaEnabled) {
    const stagedEntries = trackedEntries.filter((entry) => entry.staged);
    const unstagedEntries = trackedEntries.filter((entry) => entry.unstaged || !entry.staged);
    if (stagedEntries.length > 0) out.push(finalizeGroup({ key: "staging:staged", label: gt ? gt("commitTree.groups.staged", "已暂存") : "已暂存", entries: stagedEntries, kind: "staged" }));
    if (unstagedEntries.length > 0) out.push(finalizeGroup({ key: "staging:unstaged", label: gt ? gt("commitTree.groups.unstaged", "未暂存") : "未暂存", entries: unstagedEntries, kind: "unstaged" }));
  } else if (args.options.changeListsEnabled) {
    const grouped = new Map<string, GitStatusEntry[]>();
    for (const list of args.changeLists) grouped.set(list.id, []);
    for (const entry of trackedEntries) {
      if (!grouped.has(entry.changeListId)) grouped.set(entry.changeListId, []);
      grouped.get(entry.changeListId)?.push(entry);
    }
    for (const list of args.changeLists) {
      out.push(finalizeGroup({
        key: `cl:${list.id}`,
        label: list.name,
        entries: grouped.get(list.id) || [],
        kind: "changelist",
        changeListId: list.id,
        helper: false,
      }));
    }
  } else {
    out.push(finalizeGroup({
      key: "local:changes",
      label: gt ? gt("commitTree.groups.localChanges", "更改") : "更改",
      entries: trackedEntries,
      kind: "local",
      showHeader: false,
      helper: true,
    }));
  }

  if (unversionedEntries.length > 0) {
    out.push(finalizeGroup({
      key: "special:unversioned",
      label: gt ? gt("commitTree.groups.unversioned", "未跟踪文件") : "未跟踪文件",
      entries: unversionedEntries,
      kind: "unversioned",
      helper: true,
      manyFiles: isManySpecialFiles(unversionedEntries, manyFilesThreshold),
    }));
  }
  if (ignoredEntries.length > 0) {
    out.push(finalizeGroup({
      key: "special:ignored",
      label: gt ? gt("commitTree.groups.ignored", "已忽略文件") : "已忽略文件",
      entries: ignoredEntries,
      kind: "ignored",
      helper: true,
      manyFiles: isManySpecialFiles(ignoredEntries, manyFilesThreshold),
    }));
  }
  for (const modifierGroup of args.modifierGroups || []) {
    out.push(finalizeGroup({
      ...modifierGroup,
      helper: modifierGroup.helper !== false,
      sourceKind: modifierGroup.sourceKind || "modifier",
      sourceId: modifierGroup.sourceId || modifierGroup.key,
    }));
  }
  return sortGroups(out);
}

/**
 * 按文件条目构建叶子节点，复用统一 metadata 契约，避免 UI 再回头从 entry 猜节点语义。
 */
function buildCommitFileNode(entry: GitStatusEntry, keyPrefix: string): CommitTreeNode {
  const cleanPath = normalizeCommitPath(entry.path);
  const parts = cleanPath.split("/").filter(Boolean);
  const name = parts[parts.length - 1] || cleanPath;
  const textPresentation = name || formatCommitDisplayPath(cleanPath);
  return {
    key: `ct:${keyPrefix}:${entry.changeListId || "none"}:${cleanPath}`,
    stableId: `${keyPrefix}:${entry.changeListId || "none"}:${cleanPath}:${entry.conflictState || "normal"}`,
    name,
    fullPath: cleanPath,
    isFile: true,
    count: 1,
    fileCount: 1,
    directoryCount: 0,
    filePaths: cleanPath ? [cleanPath] : [],
    entry,
    kind: "file",
    children: [],
    sortWeight: FILE_NODE_SORT_WEIGHT,
    helper: false,
    textPresentation,
    sourceGroupKey: keyPrefix,
    repositoryId: entry.repositoryId,
    moduleId: entry.moduleId,
    selectionFlags: {
      selectable: true,
      inclusionVisible: !entry.ignored,
      inclusionEnabled: !entry.ignored,
      hideInclusionCheckbox: entry.ignored,
      helper: false,
    },
    renderPayload: {
      textPresentation,
      manyFiles: false,
      browseActionVisible: false,
      updating: false,
      outdatedFileCount: 0,
      infoMarkerVisible: false,
      isDefault: false,
    },
    sourceKind: "status",
    sourceId: keyPrefix,
  };
}

type MutableCommitTreeNode = {
  key: string;
  stableId: string;
  name: string;
  fullPath: string;
  kind: CommitTreeNode["kind"];
  entry?: GitStatusEntry;
  children: Map<string, MutableCommitTreeNode>;
  filePaths: string[];
  repositoryId?: string;
  moduleId?: string;
};

/**
 * 创建 repository/module/directory 这类辅助节点的可变中间结构，统一复用在 grouping policy 链中。
 */
function createMutableHelperNode(args: {
  key: string;
  stableId: string;
  name: string;
  fullPath: string;
  kind: CommitTreeNode["kind"];
  repositoryId?: string;
  moduleId?: string;
}): MutableCommitTreeNode {
  return {
    key: args.key,
    stableId: args.stableId,
    name: args.name,
    fullPath: args.fullPath,
    kind: args.kind,
    children: new Map<string, MutableCommitTreeNode>(),
    filePaths: [],
    repositoryId: args.repositoryId,
    moduleId: args.moduleId,
  };
}

/**
 * 为折叠后的目录节点同步可见文案，确保提交树展示与上游的单子目录折叠路径一致。
 */
function applyCollapsedDirectoryPresentation(node: CommitTreeNode, textPresentation: string): CommitTreeNode {
  if (node.kind !== "directory") return node;
  return {
    ...node,
    name: textPresentation,
    textPresentation,
    renderPayload: node.renderPayload
      ? {
          ...node.renderPayload,
          textPresentation,
        }
      : node.renderPayload,
  };
}

/**
 * 对齐上游 `TreeModelBuilder.collapseDirectories()`，折叠连续的单子目录链，避免出现 `web -> src` 这类冗余层级。
 */
function collapseCommitDirectoryNodes(nodes: CommitTreeNode[], parentPath: string = ""): CommitTreeNode[] {
  return nodes.map((node) => {
    let visibleNode: CommitTreeNode = node;
    let collapsed = false;
    while (
      visibleNode.kind === "directory"
      && visibleNode.children.length === 1
    ) {
      const onlyChild = visibleNode.children[0];
      if (onlyChild.isFile || onlyChild.kind !== "directory") break;
      visibleNode = onlyChild;
      collapsed = true;
    }
    const visiblePath = normalizeCommitPath(visibleNode.fullPath);
    const nextChildren = collapseCommitDirectoryNodes(visibleNode.children, visiblePath);
    const normalizedNode: CommitTreeNode = {
      ...visibleNode,
      children: nextChildren,
    };
    return collapsed && normalizedNode.kind === "directory"
      ? applyCollapsedDirectoryPresentation(
          normalizedNode,
          buildCollapsedDirectoryTextPresentation(parentPath, normalizedNode.fullPath || normalizedNode.name),
        )
      : normalizedNode;
  });
}

/**
 * 判断仓库分组是否真正需要显示；单一项目根仓时不创建额外根节点。
 */
function shouldUseRepositoryGrouping(entries: GitStatusEntry[]): boolean {
  const repositories = new Map<string, string>();
  for (const entry of entries) {
    const repositoryId = String(entry.repositoryId || "").trim();
    if (!repositoryId) continue;
    repositories.set(repositoryId, normalizeCommitPath(entry.repositoryRoot || ""));
  }
  if (repositories.size <= 0) return false;
  if (repositories.size > 1) return true;
  const onlyRoot = repositories.values().next().value || "";
  return !!onlyRoot;
}

/**
 * 按当前状态条目收敛有效 grouping key，避免单仓场景额外显示项目根节点。
 */
function resolveEffectiveCommitGroupingKeys(
  entries: GitStatusEntry[],
  groupingKeys: Array<"directory" | "module" | "repository">,
): Array<"directory" | "module" | "repository"> {
  if (!groupingKeys.includes("repository")) return groupingKeys;
  if (shouldUseRepositoryGrouping(entries)) return groupingKeys;
  return groupingKeys.filter((key) => key !== "repository");
}

/**
 * 按 grouping key 链把文件条目灌入可变树结构，支持 repository/module/directory 组合分组。
 */
export function buildCommitTree(
  entries: GitStatusEntry[],
  keyPrefix: string,
  groupingKeysInput: boolean | Array<"directory" | "module" | "repository">,
  translate?: GitTranslate,
): CommitTreeNode[] {
  const groupingKeys = typeof groupingKeysInput === "boolean"
    ? normalizeCommitGroupingKeys(groupingKeysInput ? ["directory"] : [], false)
    : normalizeCommitGroupingKeys(groupingKeysInput, false);
  const effectiveGroupingKeys = resolveEffectiveCommitGroupingKeys(entries, groupingKeys);
  if (effectiveGroupingKeys.length === 0) {
    return entries
      .map((entry) => buildCommitFileNode(entry, keyPrefix))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  const root = new Map<string, MutableCommitTreeNode>();
  for (const entry of entries) {
    const cleanPath = normalizeCommitPath(entry.path);
    if (!cleanPath) continue;
    let cursor = root;
    const stripPrefixes: string[] = [];

    for (const groupingKey of effectiveGroupingKeys) {
      if (groupingKey === "repository") {
        const repositoryId = String(entry.repositoryId || "").trim();
        if (!repositoryId) continue;
        const repositoryName = String(entry.repositoryName || entry.repositoryRoot || repositoryId).trim();
        const relativeRepositoryRoot = normalizeCommitPath(entry.repositoryRoot || repositoryId);
        if (relativeRepositoryRoot && (cleanPath === relativeRepositoryRoot || cleanPath.startsWith(`${relativeRepositoryRoot}/`))) {
          stripPrefixes.push(relativeRepositoryRoot);
        }
        const nodeKey = `ct:${keyPrefix}:repository:${repositoryId}`;
        if (!cursor.has(nodeKey)) {
          cursor.set(nodeKey, createMutableHelperNode({
            key: nodeKey,
            stableId: `${keyPrefix}:repository:${repositoryId}`,
            name: repositoryName,
            fullPath: relativeRepositoryRoot,
            kind: "repository",
            repositoryId,
            moduleId: entry.moduleId,
          }));
        }
        const node = cursor.get(nodeKey)!;
        node.filePaths.push(cleanPath);
        cursor = node.children;
        continue;
      }
      if (groupingKey === "module") {
        const moduleId = String(entry.moduleId || "").trim();
        if (!moduleId) continue;
        const moduleName = String(entry.moduleName || moduleId).trim();
        const relativeModuleRoot = normalizeCommitPath(moduleId);
        if (relativeModuleRoot && (cleanPath === relativeModuleRoot || cleanPath.startsWith(`${relativeModuleRoot}/`))) {
          stripPrefixes.push(relativeModuleRoot);
        }
        const nodeKey = `ct:${keyPrefix}:module:${moduleId}`;
        if (!cursor.has(nodeKey)) {
          cursor.set(nodeKey, createMutableHelperNode({
            key: nodeKey,
            stableId: `${keyPrefix}:module:${moduleId}`,
            name: moduleName,
            fullPath: moduleId,
            kind: "module",
            repositoryId: entry.repositoryId,
            moduleId,
          }));
        }
        const node = cursor.get(nodeKey)!;
        node.filePaths.push(cleanPath);
        cursor = node.children;
        continue;
      }
      const stripPrefix = [...stripPrefixes].sort((left, right) => right.length - left.length)[0] || "";
      const directoryPath = stripPrefix && (cleanPath === stripPrefix || cleanPath.startsWith(`${stripPrefix}/`))
        ? cleanPath.slice(stripPrefix.length).replace(/^\/+/, "")
        : cleanPath;
      const parts = directoryPath.split("/").filter(Boolean);
      let currentPath = "";
      for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const nodeKey = `ct:${keyPrefix}:${entry.changeListId || "none"}:${currentPath}`;
        if (!cursor.has(nodeKey)) {
          cursor.set(nodeKey, createMutableHelperNode({
            key: nodeKey,
            stableId: `${keyPrefix}:${entry.changeListId || "none"}:${currentPath}`,
            name: part,
            fullPath: currentPath,
            kind: "directory",
            repositoryId: entry.repositoryId,
            moduleId: entry.moduleId,
          }));
        }
        const node = cursor.get(nodeKey)!;
        node.filePaths.push(cleanPath);
        cursor = node.children;
      }
    }

    const fileNode = buildCommitFileNode(entry, keyPrefix);
    cursor.set(fileNode.key, {
      key: fileNode.key,
      stableId: String(fileNode.stableId || fileNode.key),
      name: fileNode.name,
      fullPath: fileNode.fullPath,
      kind: "file",
      entry,
      children: new Map<string, MutableCommitTreeNode>(),
      filePaths: [...fileNode.filePaths],
      repositoryId: entry.repositoryId,
      moduleId: entry.moduleId,
    });
  }

  /**
   * 把可变 grouping 树归一化为最终节点，并补齐聚合计数、render payload 与稳定排序。
   */
  const normalize = (input: Map<string, MutableCommitTreeNode>): CommitTreeNode[] => {
    const out: CommitTreeNode[] = [];
    for (const node of input.values()) {
      if (node.kind === "file" && node.entry) {
        out.push(buildCommitFileNode(node.entry, keyPrefix));
        continue;
      }
      const children = normalize(node.children);
      const uniquePaths = Array.from(new Set(node.filePaths.map((one) => normalizeCommitPath(one)).filter(Boolean)));
      const fileCount = uniquePaths.length;
      const directoryCount = children.reduce((sum, child) => sum + (child.isFile ? 0 : 1 + (child.directoryCount || 0)), 0);
      const countText = node.kind === "directory"
        ? (translate ? translate("commitTree.summary.filesOnly", "{{fileCount}} 个文件", { fileCount }) : `${fileCount} 个文件`)
        : formatCommitTreeGroupSummary({ fileCount, directoryCount }, translate);
      out.push({
        key: node.key,
        stableId: node.stableId,
        name: node.name,
        fullPath: node.fullPath,
        isFile: false,
        count: fileCount,
        fileCount,
        directoryCount,
        filePaths: uniquePaths,
        kind: node.kind,
        children,
        sortWeight: node.kind === "repository"
          ? COMMIT_GROUP_SORT_WEIGHT.repository
          : node.kind === "module"
            ? COMMIT_GROUP_SORT_WEIGHT.module
            : DIRECTORY_NODE_SORT_WEIGHT,
        helper: true,
        textPresentation: node.kind === "directory" ? formatCommitDisplayPath(node.name) : node.name,
        sourceGroupKey: keyPrefix,
        repositoryId: node.repositoryId,
        moduleId: node.moduleId,
        selectionFlags: {
          selectable: true,
          inclusionVisible: true,
          inclusionEnabled: fileCount > 0,
          hideInclusionCheckbox: false,
          helper: true,
        },
        renderPayload: {
          textPresentation: node.kind === "directory" ? formatCommitDisplayPath(node.name) : node.name,
          countText,
          manyFiles: false,
          browseActionVisible: false,
          updating: false,
          outdatedFileCount: 0,
          infoMarkerVisible: false,
          isDefault: false,
        },
      });
    }
    return out.sort((left, right) => {
      const weightDiff = (left.sortWeight || 10) - (right.sortWeight || 10);
      if (weightDiff !== 0) return weightDiff;
      if (left.isFile !== right.isFile) return left.isFile ? 1 : -1;
      return left.name.localeCompare(right.name, "zh-CN");
    });
  };

  return collapseCommitDirectoryNodes(normalize(root));
}

/**
 * 将目录树按展开状态扁平化为线性渲染行。
 */
export function flattenCommitTree(
  nodes: CommitTreeNode[],
  expanded: Record<string, boolean>,
  depth: number = 0,
): Array<{ node: CommitTreeNode; depth: number }> {
  const out: Array<{ node: CommitTreeNode; depth: number }> = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (!node.isFile && expanded[node.key] !== false) {
      out.push(...flattenCommitTree(node.children, expanded, depth + 1));
    }
  }
  return out;
}

/**
 * 把分组语义与目录树结果组合为提交面板树分组，统一复用在渲染与选择恢复链路。
 */
export function buildCommitTreeGroups(
  groups: ChangeEntryGroup[],
  groupingKeys: boolean | Array<"directory" | "module" | "repository">,
  expanded: Record<string, boolean>,
): CommitTreeGroup[] {
  /**
   * 把 group 级元数据递归复制到树节点上，保证扩展来源、hover 与节点动作能真正进入主链路。
   */
  const decorateNodes = (nodes: CommitTreeNode[], group: ChangeEntryGroup): CommitTreeNode[] => {
    return nodes.map((node) => {
      const hideGroupInclusion = (
        group.kind === "conflict"
        || group.kind === "resolved-conflict"
        || group.kind === "edited-commit"
      );
      const selectionFlags = {
        ...node.selectionFlags,
        selectable: node.selectionFlags?.selectable !== false,
        inclusionVisible: hideGroupInclusion ? false : node.selectionFlags?.inclusionVisible === true,
        inclusionEnabled: hideGroupInclusion ? false : node.selectionFlags?.inclusionEnabled === true,
        hideInclusionCheckbox: hideGroupInclusion ? true : node.selectionFlags?.hideInclusionCheckbox === true,
        helper: node.selectionFlags?.helper === true,
        nonSelectable: node.selectionFlags?.nonSelectable === true,
      };
      const nextNode: CommitTreeNode = {
        ...node,
        selectionFlags,
        sourceKind: group.sourceKind || "status",
        sourceId: group.sourceId || group.key,
        ...resolveCommitConflictNodeActions(node.key, group.kind, node.isFile),
        children: decorateNodes(node.children, group),
      };
      return nextNode;
    });
  };

  return groups.map((group) => {
    const treeNodes = group.manyFiles ? [] : decorateNodes(buildCommitTree(group.entries, group.key, groupingKeys), group);
    const treeRows = group.manyFiles ? [] : flattenCommitTree(treeNodes, expanded);
    return {
      ...group,
      treeNodes,
      treeRows,
    };
  });
}

/**
 * 判断提交面板分组是否应显示；空 changelist 仍需可见，其余辅助分组仅在有条目时展示。
 */
export function isCommitTreeGroupVisible(group: CommitTreeGroup): boolean {
  if (group.kind === "edited-commit") {
    return group.state?.updating === true || group.entries.length > 0 || group.sourceKind === "modifier";
  }
  return group.kind === "changelist" || group.entries.length > 0;
}

/**
 * 按当前分组展开态构建线性渲染行，便于窗口化渲染大量 ignored/unversioned 节点。
 */
export function buildCommitPanelRenderRows(
  groups: CommitTreeGroup[],
  groupExpanded: Record<string, boolean>,
): CommitPanelRenderRow[] {
  const out: CommitPanelRenderRow[] = [];
  for (const group of groups) {
    if (!isCommitTreeGroupVisible(group)) continue;
    if (group.showHeader !== false) {
      out.push({
        key: `group:${group.key}`,
        kind: "group",
        group,
        textPresentation: getCommitGroupTextPresentation(group),
      });
    }
    if (groupExpanded[group.key] === false) continue;
    for (const row of group.treeRows) {
      out.push({
        key: `node:${row.node.key}`,
        kind: "node",
        group,
        node: row.node,
        depth: row.depth,
        textPresentation: getCommitNodeTextPresentation(row.node),
      });
    }
  }
  return out;
}

/**
 * 构建提交树节点索引，供选择恢复与右键菜单反查使用。
 */
export function buildCommitNodeMap(groups: CommitTreeGroup[]): Map<string, CommitTreeNode> {
  const map = new Map<string, CommitTreeNode>();
  /**
   * 递归登记整棵提交树节点，确保隐藏子节点在选择恢复、Select In 与 diffable 语义里也可被命中。
   */
  const visit = (nodes: CommitTreeNode[]): void => {
    for (const node of nodes) {
      map.set(node.key, node);
      if (!node.isFile) visit(node.children);
    }
  };
  for (const group of groups) {
    visit(group.treeNodes);
  }
  return map;
}

/**
 * 列出当前可见提交节点键序列，供 Shift 选择与键盘导航复用。
 */
export function listCommitVisibleNodeKeys(
  groups: CommitTreeGroup[],
  groupExpanded: Record<string, boolean>,
): string[] {
  const out: string[] = [];
  for (const row of buildCommitPanelRenderRows(groups, groupExpanded)) {
    if (row.kind !== "node") continue;
    out.push(row.node.key);
  }
  return out;
}
