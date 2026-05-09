// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import {
  DEFAULT_CHANGE_LIST_ID,
  rebuildChangeListFiles,
} from "../changelists";
import type {
  GitCommitPanelStatusEntry,
  GitCommitPanelStatusSnapshot,
  ParsedGitStatusEntry,
  RepoChangeLists,
} from "./types";

/**
 * 解码 Git 可能返回的八进制转义文本（如 `\\346\\260\\264`）。
 */
export function decodeGitEscapedText(raw: string): string {
  const text = String(raw || "");
  if (!/\\[0-7]{3}/.test(text)) return text;
  const bytes: number[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] === "\\" && index + 3 < text.length) {
      const octal = text.slice(index + 1, index + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
        index += 4;
        continue;
      }
    }
    const chunk = Buffer.from(text[index], "utf8");
    for (const value of chunk.values()) bytes.push(value);
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * 将 Git 状态码映射为前端可直接展示的简短文案。
 */
export function toStatusText(entry: {
  x: string;
  y: string;
  untracked: boolean;
  ignored: boolean;
  conflictState?: "conflict" | "resolved";
  renamed: boolean;
  deleted: boolean;
  staged: boolean;
  unstaged: boolean;
}): string {
  if (entry.conflictState === "conflict") return "冲突";
  if (entry.conflictState === "resolved") return "已解决冲突";
  if (entry.ignored) return "已忽略";
  if (entry.untracked) return "未跟踪";
  if (entry.renamed) return "重命名";
  if (entry.deleted) return "删除";
  if (entry.staged && entry.unstaged) return "已暂存且有修改";
  if (entry.staged) return "已暂存";
  if (entry.unstaged) return "已修改";
  return "已变化";
}

/**
 * 解析 `git status --porcelain=v2 -z` 输出，得到提交面板统一状态条目。
 */
export function parseStatusPorcelainV2Z(stdout: string): ParsedGitStatusEntry[] {
  const parts = String(stdout || "").split("\0").filter((item) => item.length > 0);
  const out: ParsedGitStatusEntry[] = [];
  let index = 0;
  while (index < parts.length) {
    const line = parts[index++] || "";
    if (!line) continue;

    if (line.startsWith("1 ")) {
      const match = line.match(/^1\s+([^.A-Z?][^\s]|..|\S\S)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      const xy = match?.[1] || "..";
      const filePath = decodeGitEscapedText(match?.[2] || "");
      if (!filePath) continue;
      out.push({
        path: filePath,
        x: xy[0] || ".",
        y: xy[1] || ".",
        staged: (xy[0] || ".") !== ".",
        unstaged: (xy[1] || ".") !== ".",
        untracked: false,
        ignored: false,
        renamed: (xy[0] || ".") === "R" || (xy[1] || ".") === "R",
        deleted: (xy[0] || ".") === "D" || (xy[1] || ".") === "D",
      });
      continue;
    }

    if (line.startsWith("2 ")) {
      const match = line.match(/^2\s+(\S\S)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      const xy = match?.[1] || "..";
      const filePath = decodeGitEscapedText(match?.[2] || "");
      const oldPath = index < parts.length ? decodeGitEscapedText(parts[index++] || "") : "";
      if (!filePath) continue;
      out.push({
        path: filePath,
        oldPath: oldPath || undefined,
        x: xy[0] || ".",
        y: xy[1] || ".",
        staged: (xy[0] || ".") !== ".",
        unstaged: (xy[1] || ".") !== ".",
        untracked: false,
        ignored: false,
        renamed: true,
        deleted: (xy[0] || ".") === "D" || (xy[1] || ".") === "D",
      });
      continue;
    }

    if (line.startsWith("u ")) {
      const match = line.match(/^u\s+(\S\S)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      const xy = match?.[1] || "UU";
      const filePath = decodeGitEscapedText(match?.[2] || "");
      if (!filePath) continue;
      out.push({
        path: filePath,
        x: xy[0] || "U",
        y: xy[1] || "U",
        staged: true,
        unstaged: true,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
        conflictState: "conflict",
      });
      continue;
    }

    if (line.startsWith("? ")) {
      const filePath = decodeGitEscapedText(line.slice(2));
      if (!filePath) continue;
      out.push({
        path: filePath,
        x: "?",
        y: "?",
        staged: false,
        unstaged: true,
        untracked: true,
        ignored: false,
        renamed: false,
        deleted: false,
      });
      continue;
    }

    if (line.startsWith("! ")) {
      const filePath = decodeGitEscapedText(line.slice(2));
      if (!filePath) continue;
      out.push({
        path: filePath,
        x: "!",
        y: "!",
        staged: false,
        unstaged: false,
        untracked: false,
        ignored: true,
        renamed: false,
        deleted: false,
      });
    }
  }
  return out;
}

/**
 * 将解析后的 Git 状态与 changelist 映射合并，并同步重建 list 文件清单。
 */
export function buildCommitPanelStatusSnapshot(args: {
  repoRoot: string;
  branch?: string;
  detached: boolean;
  headSha?: string;
  defaultCommitAuthor?: string;
  stashPushPathspecSupported?: boolean;
  commitAndPush: GitCommitPanelStatusSnapshot["commitAndPush"];
  commitHooks: GitCommitPanelStatusSnapshot["commitHooks"];
  operationState?: GitCommitPanelStatusSnapshot["operationState"];
  operationSuggestedCommitMessage?: string;
  parsedEntries: ParsedGitStatusEntry[];
  repo: RepoChangeLists;
  viewOptions: GitCommitPanelStatusSnapshot["viewOptions"];
  localChanges: GitCommitPanelStatusSnapshot["localChanges"];
}): { snapshot: GitCommitPanelStatusSnapshot; changed: boolean } {
  const changedPaths = args.parsedEntries.filter((entry) => !entry.ignored).map((entry) => entry.path);
  const existingListIds = new Set(args.repo.lists.map((item) => item.id));
  let changed = false;
  for (const filePath of changedPaths) {
    const mappedListId = args.repo.fileToList[filePath];
    if (mappedListId && existingListIds.has(mappedListId)) continue;
    args.repo.fileToList[filePath] = args.repo.activeListId || DEFAULT_CHANGE_LIST_ID;
    changed = true;
  }
  rebuildChangeListFiles(args.repo, changedPaths);

  const actionableEntries: GitCommitPanelStatusEntry[] = [];
  const ignoredEntries: GitCommitPanelStatusEntry[] = [];
  for (const entry of args.parsedEntries) {
    const merged: GitCommitPanelStatusEntry = {
      path: entry.path,
      oldPath: entry.oldPath,
      x: entry.x,
      y: entry.y,
      staged: entry.staged,
      unstaged: entry.unstaged,
      untracked: entry.untracked,
      ignored: entry.ignored,
      renamed: entry.renamed,
      deleted: entry.deleted,
      statusText: toStatusText(entry),
      changeListId: entry.ignored ? "" : (args.repo.fileToList[entry.path] || args.repo.activeListId || DEFAULT_CHANGE_LIST_ID),
      conflictState: entry.conflictState,
      repositoryId: entry.repositoryId,
      repositoryRoot: entry.repositoryRoot,
      repositoryName: entry.repositoryName,
      repositoryExternal: entry.repositoryExternal,
      repositoryParentId: entry.repositoryParentId,
      moduleId: entry.moduleId,
      moduleName: entry.moduleName,
      moduleInternal: entry.moduleInternal,
    };
    if (merged.ignored) ignoredEntries.push(merged);
    else actionableEntries.push(merged);
  }

  const snapshot: GitCommitPanelStatusSnapshot = {
    repoRoot: args.repoRoot,
    branch: args.branch,
    detached: args.detached,
    headSha: args.headSha,
    defaultCommitAuthor: String(args.defaultCommitAuthor || "").trim() || undefined,
    stashPushPathspecSupported: args.stashPushPathspecSupported === true,
    commitAndPush: {
      previewOnCommitAndPush: args.commitAndPush.previewOnCommitAndPush !== false,
      previewProtectedOnly: args.commitAndPush.previewProtectedOnly === true,
      protectedBranchPatterns: [...(args.commitAndPush.protectedBranchPatterns || [])],
    },
    commitHooks: {
      available: args.commitHooks.available === true,
      availableRepoRoots: [...(args.commitHooks.availableRepoRoots || [])],
      disabledByPolicy: args.commitHooks.disabledByPolicy === true,
      runByDefault: args.commitHooks.runByDefault !== false,
    },
    operationState: args.operationState,
    operationSuggestedCommitMessage: String(args.operationSuggestedCommitMessage || "").trim() || undefined,
    entries: actionableEntries,
    ignoredEntries,
    viewOptions: args.viewOptions,
    localChanges: args.localChanges,
    changeLists: {
      activeListId: args.repo.activeListId,
      lists: args.repo.lists.map((item) => ({
        id: item.id,
        name: item.name,
        comment: String(item.comment || "").trim() || undefined,
        data: item.data ? JSON.parse(JSON.stringify(item.data)) as Record<string, any> : null,
        readOnly: item.readOnly === true,
        fileCount: item.files.length,
        files: [...item.files],
      })),
    },
  };
  return { snapshot, changed };
}
