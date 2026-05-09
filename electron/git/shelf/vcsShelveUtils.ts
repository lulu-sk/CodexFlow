// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { ChangeListManagerEx } from "../changelists";
import type {
  GitShelfManagerRuntime,
  GitShelveRestoreOptions,
  GitShelvedChangeListMetadata,
  GitShelvedRootEntry,
} from "./types";

export type GitSystemUnshelveResult =
  | {
      ok: true;
      restoreProgress: NonNullable<GitShelvedChangeListMetadata["restoreProgress"]>;
      appliedPathsByRepoRoot: Record<string, string[]>;
    }
  | {
      ok: false;
      error: string;
      conflictRepoRoots?: string[];
      restoreProgress: NonNullable<GitShelvedChangeListMetadata["restoreProgress"]>;
      appliedPathsByRepoRoot: Record<string, string[]>;
    };

/**
 * 确保目标目录存在，供恢复未跟踪文件时安全创建父目录。
 */
async function ensureDirectoryAsync(targetPath: string): Promise<void> {
  await fsp.mkdir(targetPath, { recursive: true });
}

/**
 * 判断目标路径是否已存在，避免 unshelve 恢复未跟踪文件时发生静默覆盖。
 */
async function pathExistsAsync(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 比较 shelf 存档文件与目标路径内容是否完全一致；仅当两端都是常规文件且字节全等时返回 `true`。
 */
async function hasSameStoredPathContentAsync(sourcePath: string, targetPath: string): Promise<boolean> {
  try {
    const [sourceStat, targetStat] = await Promise.all([fsp.stat(sourcePath), fsp.stat(targetPath)]);
    if (sourceStat.isDirectory() || targetStat.isDirectory()) {
      if (!sourceStat.isDirectory() || !targetStat.isDirectory()) return false;
      const [sourceEntries, targetEntries] = await Promise.all([
        fsp.readdir(sourcePath, { withFileTypes: true }),
        fsp.readdir(targetPath, { withFileTypes: true }),
      ]);
      if (sourceEntries.length !== targetEntries.length) return false;
      const targetEntryMap = new Map(targetEntries.map((entry) => [entry.name, entry]));
      for (const sourceEntry of sourceEntries) {
        const targetEntry = targetEntryMap.get(sourceEntry.name);
        if (!targetEntry) return false;
        if (sourceEntry.isDirectory() !== targetEntry.isDirectory()) return false;
        if (sourceEntry.isFile() !== targetEntry.isFile()) return false;
        const childSourcePath = path.join(sourcePath, sourceEntry.name);
        const childTargetPath = path.join(targetPath, sourceEntry.name);
        if (!(await hasSameStoredPathContentAsync(childSourcePath, childTargetPath))) return false;
      }
      return true;
    }
    if (!sourceStat.isFile() || !targetStat.isFile()) return false;
    if (sourceStat.size !== targetStat.size) return false;
    const [sourceBuffer, targetBuffer] = await Promise.all([fsp.readFile(sourcePath), fsp.readFile(targetPath)]);
    return sourceBuffer.equals(targetBuffer);
  } catch {
    return false;
  }
}

/**
 * 把 shelf 中保存的未跟踪文件或目录复制回工作区，统一兼容普通文件与目录快照。
 */
async function restoreStoredUntrackedPathAsync(sourcePath: string, targetPath: string): Promise<void> {
  const sourceStat = await fsp.stat(sourcePath);
  await ensureDirectoryAsync(path.dirname(targetPath));
  if (sourceStat.isDirectory()) {
    await fsp.cp(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: true });
    return;
  }
  await fsp.copyFile(sourcePath, targetPath);
}

/**
 * 把目标根目录编码成稳定目录名，和 shelf manager 的根目录布局保持一致。
 */
function buildRootDirectoryName(repoRoot: string): string {
  return createHash("sha1").update(String(repoRoot || "").trim()).digest("hex");
}

/**
 * 读取指定仓库当前的未合并文件列表，供 `doSystemUnshelve` 识别冲突恢复场景。
 */
async function listUnmergedPathsAsync(
  runtime: Pick<GitShelfManagerRuntime, "runGitExecAsync">,
  repoRoot: string,
): Promise<string[]> {
  const res = await runtime.runGitExecAsync(repoRoot, ["diff", "--name-only", "--diff-filter=U"], 10_000);
  if (!res.ok) return [];
  return String(res.stdout || "")
    .split(/\r?\n/)
    .map((item) => String(item || "").trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

/**
 * 规整 restore 选中的路径集合；空集合表示恢复全部文件。
 */
function normalizeRestoreSelectedPaths(selectedPaths?: string[]): Set<string> {
  return new Set(
    (Array.isArray(selectedPaths) ? selectedPaths : [])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  );
}

/**
 * 执行 `git apply` 恢复指定补丁文件，并把失败转换为统一错误文本。
 */
async function applyShelvedPatchAsync(
  runtime: GitShelfManagerRuntime,
  repoRoot: string,
  patchPath: string,
  withIndex: boolean,
  fallback: string,
  includedPaths?: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalizedIncludedPaths = Array.from(new Set(
    (Array.isArray(includedPaths) ? includedPaths : [])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
  if (normalizedIncludedPaths.length <= 0) return { ok: true };
  const primaryArgv = withIndex
    ? ["apply", "--3way", "--index", "--whitespace=nowarn", ...normalizedIncludedPaths.map((item) => `--include=${item}`), patchPath]
    : ["apply", "--3way", "--whitespace=nowarn", ...normalizedIncludedPaths.map((item) => `--include=${item}`), patchPath];
  const res = await runtime.runGitSpawnAsync(repoRoot, primaryArgv, 180_000);
  if (!res.ok && !withIndex) {
    const fallbackRes = await runtime.runGitSpawnAsync(
      repoRoot,
      ["apply", "--whitespace=nowarn", ...normalizedIncludedPaths.map((item) => `--include=${item}`), patchPath],
      180_000,
    );
    if (fallbackRes.ok) return { ok: true };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: runtime.toGitErrorMessage(res, fallback),
    };
  }
  return { ok: true };
}

/**
 * 恢复单个 root 的未跟踪文件；若目标路径已存在且内容一致则视为已恢复，否则拒绝覆盖，避免静默覆盖用户当前文件。
 */
async function restoreShelvedUntrackedFilesAsync(
  repoRoot: string,
  rootDir: string,
  rootEntry: GitShelvedRootEntry,
  selectedPathSet?: Set<string>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const file of rootEntry.untrackedFiles) {
    const relativePath = String(file.relativePath || "").trim().replace(/\\/g, "/");
    if (!relativePath) continue;
    if (selectedPathSet && selectedPathSet.size > 0 && !selectedPathSet.has(relativePath))
      continue;
    const sourcePath = path.join(rootDir, file.storagePath);
    const targetPath = path.join(repoRoot, relativePath);
    if (await pathExistsAsync(targetPath)) {
      if (await hasSameStoredPathContentAsync(sourcePath, targetPath))
        continue;
      return {
        ok: false,
        error: `恢复 ${relativePath} 失败：目标路径已存在同名文件，且内容不同`,
      };
    }
    await restoreStoredUntrackedPathAsync(sourcePath, targetPath);
  }
  return { ok: true };
}

/**
 * 把 changelist 快照回写到各自仓库，用于 unshelve 后恢复文件归属与默认列表。
 */
function restoreChangeListSnapshots(
  snapshots: GitShelvedChangeListMetadata["changeListSnapshots"],
  userDataPath: string,
): void {
  for (const snapshot of snapshots || [])
    new ChangeListManagerEx({ userDataPath, repoRoot: snapshot.repoRoot }).restoreSnapshot(snapshot);
}

/**
 * 执行系统级 unshelve，统一承接补丁应用、未跟踪文件恢复与 changelist 快照回写。
 */
export async function doSystemUnshelveAsync(
  runtime: GitShelfManagerRuntime,
  userDataPath: string,
  shelfDir: string,
  metadata: GitShelvedChangeListMetadata,
  options?: GitShelveRestoreOptions,
): Promise<GitSystemUnshelveResult> {
  const repoProgress = { ...(metadata.restoreProgress?.repoProgress || {}) };
  const appliedPathsByRepoRoot: Record<string, string[]> = {};
  const selectedPathSet = normalizeRestoreSelectedPaths(options?.selectedPaths);

  for (const rootEntry of metadata.roots) {
    const rootDir = path.join(shelfDir, "roots", buildRootDirectoryName(rootEntry.repoRoot));
    const currentRootProgress = { ...(repoProgress[rootEntry.repoRoot] || {}) };
    const targetedIndexPaths = selectedPathSet.size > 0
      ? rootEntry.indexPaths.filter((item) => selectedPathSet.has(item))
      : rootEntry.indexPaths;
    const targetedWorktreePaths = selectedPathSet.size > 0
      ? rootEntry.worktreePaths.filter((item) => selectedPathSet.has(item))
      : rootEntry.worktreePaths;
    const targetedUntrackedPaths = selectedPathSet.size > 0
      ? rootEntry.untrackedFiles
        .map((item) => String(item.relativePath || "").trim().replace(/\\/g, "/"))
        .filter((item) => selectedPathSet.has(item))
      : rootEntry.untrackedFiles.map((item) => String(item.relativePath || "").trim().replace(/\\/g, "/")).filter(Boolean);
    const appliedPathSet = new Set(
      (appliedPathsByRepoRoot[rootEntry.repoRoot] || [])
        .map((item) => String(item || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    );

    if (rootEntry.hasIndexPatch && currentRootProgress.indexApplied !== true && targetedIndexPaths.length > 0) {
      const applyRes = await applyShelvedPatchAsync(
        runtime,
        rootEntry.repoRoot,
        path.join(rootDir, "index.patch"),
        true,
        "恢复已暂存改动失败",
        targetedIndexPaths,
      );
      if (!applyRes.ok) {
        const conflictRepoRoots = (await listUnmergedPathsAsync(runtime, rootEntry.repoRoot)).length > 0
          ? [rootEntry.repoRoot]
          : undefined;
        return {
          ok: false,
          error: applyRes.error,
          conflictRepoRoots,
          restoreProgress: {
            ...(metadata.restoreProgress || {}),
            repoProgress,
          },
          appliedPathsByRepoRoot,
        };
      }
      currentRootProgress.indexApplied = true;
      repoProgress[rootEntry.repoRoot] = currentRootProgress;
      targetedIndexPaths.forEach((item) => appliedPathSet.add(item));
    }

    if (rootEntry.hasWorktreePatch && currentRootProgress.worktreeApplied !== true && targetedWorktreePaths.length > 0) {
      const applyRes = await applyShelvedPatchAsync(
        runtime,
        rootEntry.repoRoot,
        path.join(rootDir, "worktree.patch"),
        false,
        "恢复工作区改动失败",
        targetedWorktreePaths,
      );
      if (!applyRes.ok) {
        const conflictRepoRoots = (await listUnmergedPathsAsync(runtime, rootEntry.repoRoot)).length > 0
          ? [rootEntry.repoRoot]
          : undefined;
        return {
          ok: false,
          error: applyRes.error,
          conflictRepoRoots,
          restoreProgress: {
            ...(metadata.restoreProgress || {}),
            repoProgress,
          },
          appliedPathsByRepoRoot,
        };
      }
      currentRootProgress.worktreeApplied = true;
      repoProgress[rootEntry.repoRoot] = currentRootProgress;
      targetedWorktreePaths.forEach((item) => appliedPathSet.add(item));
    }

    if (rootEntry.untrackedFiles.length > 0 && currentRootProgress.untrackedApplied !== true && targetedUntrackedPaths.length > 0) {
      const untrackedRes = await restoreShelvedUntrackedFilesAsync(rootEntry.repoRoot, rootDir, rootEntry, selectedPathSet);
      if (!untrackedRes.ok) {
        return {
          ok: false,
          error: untrackedRes.error,
          restoreProgress: {
            ...(metadata.restoreProgress || {}),
            repoProgress,
          },
          appliedPathsByRepoRoot,
        };
      }
      currentRootProgress.untrackedApplied = true;
      repoProgress[rootEntry.repoRoot] = currentRootProgress;
      targetedUntrackedPaths.forEach((item) => appliedPathSet.add(item));
    }

    if (appliedPathSet.size > 0) {
      appliedPathsByRepoRoot[rootEntry.repoRoot] = Array.from(appliedPathSet);
    }
  }

  restoreChangeListSnapshots(metadata.changeListSnapshots, userDataPath);
  const targetChangeListId = String(options?.targetChangeListId || "").trim();
  if (targetChangeListId) {
    const targetPaths = appliedPathsByRepoRoot[runtime.repoRoot] || [];
    if (targetPaths.length > 0) {
      new ChangeListManagerEx({ userDataPath, repoRoot: runtime.repoRoot }).moveFilesToChangeList(targetPaths, targetChangeListId);
    }
  }
  return {
    ok: true,
    restoreProgress: {
      repoProgress,
      changeListsRestored: true,
    },
    appliedPathsByRepoRoot,
  };
}
