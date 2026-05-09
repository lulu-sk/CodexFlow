// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { doSystemUnshelveAsync } from "./vcsShelveUtils";
import type {
  GitShelfManagerRuntime,
  GitShelveRestoreOptions,
  GitShelfSource,
  GitShelfState,
  GitShelveChangeListDescriptor,
  GitShelvedChangeListItem,
  GitShelvedChangeListMetadata,
  GitShelvedChangeListSavedEntry,
  GitShelvedRootEntry,
} from "./types";

const GIT_SHELF_STORE_VERSION = 2;
const ACTIVE_SHELF_STATES = new Set<GitShelfState>(["saved", "restoring", "restore-failed"]);

/**
 * 为 shelf 记录生成稳定 id，避免不同保存批次相互覆盖。
 */
function createShelfId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * 把内部 id 包装成稳定的 shelf 引用格式。
 */
function buildShelfRef(id: string): string {
  return `shelf@{${id}}`;
}

/**
 * 从 shelf 引用中提取原始 id；格式异常时返回空字符串。
 */
function extractShelfId(ref: string): string {
  const matched = String(ref || "").trim().match(/^shelf@\{(.+)\}$/);
  return matched?.[1] ? matched[1].trim() : "";
}

/**
 * 为统一 shelf 记录构建展示名；优先展示原始 changelist 名称。
 */
export function buildShelvedChangeListDisplayName(ref: string, originalChangeListName?: string): string {
  const listName = String(originalChangeListName || "").trim();
  if (listName) return `搁置记录 ${listName}`;
  const normalizedRef = String(ref || "").trim();
  return normalizedRef ? `搁置记录 ${normalizedRef}` : "搁置记录";
}

/**
 * 返回工作区级 shelf 存储根目录；同一 `userDataPath` 下统一维护一套 shelf 记录。
 */
export function getShelfStoreRoot(userDataPath: string, _repoRoot?: string): string {
  return path.join(userDataPath, "git", "shelves");
}

/**
 * 解析指定 shelf 引用的资源目录。
 */
export function getShelfDirectory(userDataPath: string, ref: string, _repoRoot?: string): string {
  return path.join(getShelfStoreRoot(userDataPath), extractShelfId(ref));
}

/**
 * 确保目标目录存在，供补丁与未跟踪文件快照写入前复用。
 */
async function ensureDirectoryAsync(targetPath: string): Promise<void> {
  await fsp.mkdir(targetPath, { recursive: true });
}

/**
 * 把单条 shelf 元数据写入磁盘，保证状态机变更立即持久化。
 */
async function writeShelfMetadataAsync(shelfDir: string, metadata: GitShelvedChangeListMetadata): Promise<void> {
  await fsp.writeFile(path.join(shelfDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
}

/**
 * 向运行时广播 shelf 变更，供上层做列表刷新或通知聚合；未注册监听时保持静默。
 */
function emitShelfManagerChange(
  runtime: GitShelfManagerRuntime,
  event: { type: string; ref: string; repoRoot: string; state?: GitShelfState },
): void {
  runtime.onChange?.(event);
}

/**
 * 读取单条 shelf 元数据；仅接受当前版本结构。
 */
async function readShelfMetadataAsync(shelfDir: string): Promise<GitShelvedChangeListMetadata | null> {
  try {
    const raw = await fsp.readFile(path.join(shelfDir, "metadata.json"), "utf8");
    const parsed = JSON.parse(String(raw || "")) as GitShelvedChangeListMetadata;
    if (parsed?.version !== GIT_SHELF_STORE_VERSION) return null;
    if (!parsed?.id || !parsed?.ref || !Array.isArray(parsed?.repoRoots)) return null;
    return {
      ...parsed,
      repoRoots: parsed.repoRoots.map((item) => String(item || "").trim()).filter(Boolean),
      roots: (Array.isArray(parsed.roots) ? parsed.roots : []).map((rootEntry) => {
        const savedPaths = Array.isArray(rootEntry?.savedPaths)
          ? rootEntry.savedPaths.map((item) => String(item || "").trim().replace(/\\/g, "/")).filter(Boolean)
          : [];
        const indexPaths = Array.isArray(rootEntry?.indexPaths)
          ? rootEntry.indexPaths.map((item) => String(item || "").trim().replace(/\\/g, "/")).filter(Boolean)
          : savedPaths;
        const worktreePaths = Array.isArray(rootEntry?.worktreePaths)
          ? rootEntry.worktreePaths.map((item) => String(item || "").trim().replace(/\\/g, "/")).filter(Boolean)
          : savedPaths;
        return {
          ...rootEntry,
          repoRoot: String(rootEntry?.repoRoot || "").trim(),
          savedPaths,
          indexPaths,
          worktreePaths,
          untrackedFiles: Array.isArray(rootEntry?.untrackedFiles) ? rootEntry.untrackedFiles : [],
        };
      }),
      changeListSnapshots: Array.isArray(parsed.changeListSnapshots) ? parsed.changeListSnapshots : [],
    };
  } catch {
    return null;
  }
}

/**
 * 按 ref 读取单条 shelf 元数据，供 Git 面板内的只读预览链路复用同一套归一化结果。
 */
export async function readShelfMetadataByRefAsync(
  userDataPath: string,
  ref: string,
  repoRoot?: string,
): Promise<GitShelvedChangeListMetadata | null> {
  return await readShelfMetadataAsync(getShelfDirectory(userDataPath, ref, repoRoot));
}

/**
 * 把元数据投影成前端可直接消费的 shelf 列表项。
 */
function toShelfListItem(metadata: GitShelvedChangeListMetadata): GitShelvedChangeListItem {
  const paths = Array.from(new Set(
    metadata.roots.flatMap((item) => [
      ...(item.savedPaths || []),
      ...(item.untrackedFiles || []).map((file) => String(file.relativePath || "").trim().replace(/\\/g, "/")),
    ]),
  ));
  return {
    ref: metadata.ref,
    repoRoot: metadata.primaryRepoRoot,
    repoRoots: [...metadata.repoRoots],
    message: metadata.message,
    createdAt: metadata.createdAt,
    source: metadata.source,
    saveChangesPolicy: "shelve",
    state: metadata.state,
    displayName: buildShelvedChangeListDisplayName(metadata.ref, metadata.originalChangeListName),
    hasIndexPatch: metadata.roots.some((item) => item.hasIndexPatch),
    hasWorktreePatch: metadata.roots.some((item) => item.hasWorktreePatch),
    hasUntrackedFiles: metadata.roots.some((item) => item.untrackedFiles.length > 0),
    paths,
    originalChangeListName: metadata.originalChangeListName,
    lastError: String(metadata.lastError || "").trim() || undefined,
  };
}

/**
 * 将 Git 文本输出直接写入补丁文件，并返回是否生成了有效内容。
 */
async function writeGitTextOutputToFileAsync(
  runtime: Pick<GitShelfManagerRuntime, "runGitStdoutToFileAsync" | "toGitErrorMessage">,
  repoRoot: string,
  argv: string[],
  targetPath: string,
  fallback: string,
): Promise<{ ok: true; hasContent: boolean } | { ok: false; error: string }> {
  const res = await runtime.runGitStdoutToFileAsync(repoRoot, argv, targetPath, 10 * 60_000);
  if (!res.ok) {
    return {
      ok: false,
      error: runtime.toGitErrorMessage(res, fallback),
    };
  }
  const stat = await fsp.stat(targetPath).catch(() => null);
  return {
    ok: true,
    hasContent: (stat?.size || 0) > 0,
  };
}

/**
 * 读取指定补丁命令涉及的路径集合，供 partial unshelve 精准筛选 index/worktree 补丁目标。
 */
async function listGitPatchPathsAsync(
  runtime: Pick<GitShelfManagerRuntime, "runGitExecAsync">,
  repoRoot: string,
  argv: string[],
): Promise<string[]> {
  const res = await runtime.runGitExecAsync(repoRoot, argv, 10_000);
  if (!res.ok) return [];
  return Array.from(new Set(
    String(res.stdout || "")
      .split(/\r?\n/)
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
}

/**
 * 把目标根目录与路径集合编码成稳定目录名，避免路径中出现平台相关字符。
 */
function buildRootDirectoryName(repoRoot: string): string {
  return createHash("sha1").update(String(repoRoot || "").trim()).digest("hex");
}

/**
 * 返回指定 shelf 在目标仓根下的资源目录，供 diff/patch 等只读能力定位 patch 与未跟踪文件快照。
 */
export function getShelvedRootDirectory(
  userDataPath: string,
  ref: string,
  targetRepoRoot: string,
  currentRepoRoot?: string,
): string {
  return path.join(
    getShelfDirectory(userDataPath, ref, currentRepoRoot),
    "roots",
    buildRootDirectoryName(targetRepoRoot),
  );
}

/**
 * 为指定 root 写入 index/worktree 补丁文件；路径为空时创建空文件占位，便于后续统一流程处理。
 */
async function writeRootPatchFilesAsync(
  runtime: Pick<GitShelfManagerRuntime, "runGitStdoutToFileAsync" | "toGitErrorMessage">,
  repoRoot: string,
  rootDir: string,
  paths: string[],
): Promise<{
  ok: true;
  hasIndexPatch: boolean;
  hasWorktreePatch: boolean;
} | {
  ok: false;
  error: string;
}> {
  const normalizedPaths = Array.from(new Set(
    (Array.isArray(paths) ? paths : [])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
  const indexPatchPath = path.join(rootDir, "index.patch");
  const worktreePatchPath = path.join(rootDir, "worktree.patch");
  if (normalizedPaths.length <= 0) {
    await fsp.writeFile(indexPatchPath, "", "utf8");
    await fsp.writeFile(worktreePatchPath, "", "utf8");
    return {
      ok: true,
      hasIndexPatch: false,
      hasWorktreePatch: false,
    };
  }
  const [indexRes, worktreeRes] = await Promise.all([
    writeGitTextOutputToFileAsync(runtime, repoRoot, ["diff", "--cached", "--binary", "--full-index", "--", ...normalizedPaths], indexPatchPath, "生成已暂存改动补丁失败"),
    writeGitTextOutputToFileAsync(runtime, repoRoot, ["diff", "--binary", "--full-index", "--", ...normalizedPaths], worktreePatchPath, "生成工作区改动补丁失败"),
  ]);
  if (!indexRes.ok) return indexRes;
  if (!worktreeRes.ok) return worktreeRes;
  return {
    ok: true,
    hasIndexPatch: indexRes.hasContent,
    hasWorktreePatch: worktreeRes.hasContent,
  };
}

/**
 * 把未跟踪文件复制进 shelf 目录，并返回恢复时所需的文件清单。
 */
async function copyUntrackedPathToShelfAsync(sourcePath: string, targetPath: string): Promise<void> {
  const sourceStat = await fsp.stat(sourcePath);
  await ensureDirectoryAsync(path.dirname(targetPath));
  if (sourceStat.isDirectory()) {
    await fsp.cp(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: true });
    return;
  }
  await fsp.copyFile(sourcePath, targetPath);
}

/**
 * 把未跟踪文件或目录复制进 shelf 目录，并返回恢复时所需的文件清单。
 */
async function snapshotUntrackedFilesAsync(
  repoRoot: string,
  rootDir: string,
  files: string[],
): Promise<GitShelvedRootEntry["untrackedFiles"]> {
  const storedFiles: GitShelvedRootEntry["untrackedFiles"] = [];
  for (let index = 0; index < files.length; index += 1) {
    const relativePath = String(files[index] || "").trim().replace(/\\/g, "/");
    if (!relativePath) continue;
    const sourcePath = path.join(repoRoot, relativePath);
    const storagePath = path.join("untracked", String(index));
    const targetPath = path.join(rootDir, storagePath);
    await copyUntrackedPathToShelfAsync(sourcePath, targetPath);
    storedFiles.push({
      relativePath,
      storagePath,
    });
  }
  return storedFiles;
}

/**
 * 写入单条 shelf root 数据，并返回最终元数据片段。
 */
async function createShelvedRootEntryAsync(
  runtime: GitShelfManagerRuntime,
  shelfDir: string,
  rootChangeSet: GitShelveChangeListDescriptor["roots"][number],
): Promise<{ ok: true; entry: GitShelvedRootEntry } | { ok: false; error: string }> {
  const repoRoot = String(rootChangeSet.repoRoot || "").trim();
  const savedPaths = Array.from(new Set(
    (Array.isArray(rootChangeSet.paths) ? rootChangeSet.paths : [])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
  const untrackedPaths = Array.from(new Set(
    (Array.isArray(rootChangeSet.untrackedPaths) ? rootChangeSet.untrackedPaths : [])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
  const rootDir = path.join(shelfDir, "roots", buildRootDirectoryName(repoRoot));
  await ensureDirectoryAsync(rootDir);
  const patchRes = await writeRootPatchFilesAsync(runtime, repoRoot, rootDir, savedPaths);
  if (!patchRes.ok) return patchRes;
  const [indexPaths, worktreePaths] = await Promise.all([
    savedPaths.length > 0
      ? listGitPatchPathsAsync(runtime, repoRoot, ["diff", "--cached", "--name-only", "--", ...savedPaths])
      : Promise.resolve([]),
    savedPaths.length > 0
      ? listGitPatchPathsAsync(runtime, repoRoot, ["diff", "--name-only", "--", ...savedPaths])
      : Promise.resolve([]),
  ]);
  const storedUntrackedFiles = await snapshotUntrackedFilesAsync(repoRoot, rootDir, untrackedPaths);
  return {
    ok: true,
    entry: {
      repoRoot,
      savedPaths,
      indexPaths,
      worktreePaths,
      hasIndexPatch: patchRes.hasIndexPatch,
      hasWorktreePatch: patchRes.hasWorktreePatch,
      untrackedFiles: storedUntrackedFiles,
    },
  };
}

/**
 * 规整导入 patch 中解析出的路径；遇到 rename 简写时优先提取目标路径。
 */
function normalizeImportedPatchPath(rawPath: string): string {
  let nextPath = String(rawPath || "").trim().replace(/\\/g, "/");
  if (!nextPath) return "";
  const braceRenameMatch = nextPath.match(/^(.*)\{(.+?) => (.+?)\}(.*)$/);
  if (braceRenameMatch) {
    nextPath = `${braceRenameMatch[1] || ""}${braceRenameMatch[3] || ""}${braceRenameMatch[4] || ""}`;
  } else {
    const renameMatch = nextPath.match(/^(.+?) => (.+)$/);
    if (renameMatch?.[2]) nextPath = renameMatch[2];
  }
  if ((nextPath.startsWith("\"") && nextPath.endsWith("\"")) || (nextPath.startsWith("'") && nextPath.endsWith("'"))) {
    nextPath = nextPath.slice(1, -1);
  }
  return nextPath.trim();
}

/**
 * 借助 `git apply --numstat --summary` 验证 patch 文件并提取涉及路径，供导入 shelf 元数据复用。
 */
async function listImportedPatchPathsAsync(
  runtime: Pick<GitShelfManagerRuntime, "runGitExecAsync" | "toGitErrorMessage">,
  repoRoot: string,
  patchFilePath: string,
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const res = await runtime.runGitExecAsync(repoRoot, ["apply", "--numstat", "--summary", patchFilePath], 30_000);
  if (!res.ok) {
    return {
      ok: false,
      error: runtime.toGitErrorMessage(res, `解析 Patch 失败：${path.basename(patchFilePath)}`),
    };
  }
  const paths = Array.from(new Set(
    String(res.stdout || "")
      .split(/\r?\n/)
      .map((line) => {
        const segments = line.split("\t");
        return segments.length >= 3 ? normalizeImportedPatchPath(segments[segments.length - 1] || "") : "";
      })
      .filter(Boolean),
  ));
  if (paths.length <= 0) {
    return {
      ok: false,
      error: `未从 ${path.basename(patchFilePath)} 中解析出可恢复的文件路径`,
    };
  }
  return { ok: true, paths };
}

/**
 * 按 patch 文件名生成默认搁置说明，保持导入记录在列表中的可读性。
 */
function buildImportedPatchMessage(filePath: string): string {
  const baseName = path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, " ").trim();
  return baseName || `导入 Patch @ ${new Date().toISOString()}`;
}

/**
 * 把单个外部 patch 文件导入统一 shelf 平台，复用现有元数据结构，后续仍走同一套 unshelve 链路。
 */
async function importPatchFileAsync(
  runtime: GitShelfManagerRuntime,
  patchFilePath: string,
): Promise<{ ok: true; saved: GitShelvedChangeListSavedEntry } | { ok: false; error: string }> {
  const normalizedPatchFilePath = String(patchFilePath || "").trim();
  if (!normalizedPatchFilePath) return { ok: false, error: "缺少 Patch 文件路径" };
  const patchStat = await fsp.stat(normalizedPatchFilePath).catch(() => null);
  if (!patchStat?.isFile()) {
    return { ok: false, error: `Patch 文件不存在：${normalizedPatchFilePath}` };
  }
  const parsedPathsRes = await listImportedPatchPathsAsync(runtime, runtime.repoRoot, normalizedPatchFilePath);
  if (!parsedPathsRes.ok) return parsedPathsRes;

  const shelfId = createShelfId();
  const ref = buildShelfRef(shelfId);
  const shelfDir = getShelfDirectory(runtime.userDataPath, ref, runtime.repoRoot);
  const rootDir = path.join(shelfDir, "roots", buildRootDirectoryName(runtime.repoRoot));
  await ensureDirectoryAsync(rootDir);
  await Promise.all([
    fsp.writeFile(path.join(rootDir, "index.patch"), "", "utf8"),
    fsp.copyFile(normalizedPatchFilePath, path.join(rootDir, "worktree.patch")),
  ]);

  const message = buildImportedPatchMessage(normalizedPatchFilePath);
  const metadata: GitShelvedChangeListMetadata = {
    version: GIT_SHELF_STORE_VERSION,
    id: shelfId,
    ref,
    message,
    createdAt: new Date(patchStat.mtimeMs || Date.now()).toISOString(),
    source: "manual",
    saveChangesPolicy: "shelve",
    state: "saved",
    primaryRepoRoot: runtime.repoRoot,
    repoRoots: [runtime.repoRoot],
    roots: [{
      repoRoot: runtime.repoRoot,
      savedPaths: parsedPathsRes.paths,
      indexPaths: [],
      worktreePaths: parsedPathsRes.paths,
      hasIndexPatch: false,
      hasWorktreePatch: true,
      untrackedFiles: [],
    }],
    restoreProgress: {
      repoProgress: {},
    },
  };
  await writeShelfMetadataAsync(shelfDir, metadata);
  emitShelfManagerChange(runtime, {
    type: "created",
    ref,
    repoRoot: runtime.repoRoot,
    state: metadata.state,
  });
  return {
    ok: true,
    saved: {
      ref,
      repoRoot: runtime.repoRoot,
      repoRoots: [runtime.repoRoot],
      message,
      source: "manual",
      saveChangesPolicy: "shelve",
      displayName: buildShelvedChangeListDisplayName(ref),
      hasUntrackedFiles: false,
    },
  };
}

/**
 * 更新 shelf 状态机并立即回写磁盘。
 */
async function updateShelfStateAsync(
  shelfDir: string,
  metadata: GitShelvedChangeListMetadata,
  state: GitShelfState,
  patch?: {
    lastError?: string;
    restoreProgress?: GitShelvedChangeListMetadata["restoreProgress"];
  },
): Promise<GitShelvedChangeListMetadata> {
  const nextMetadata: GitShelvedChangeListMetadata = {
    ...metadata,
    state,
    lastError: patch?.lastError,
    restoreProgress: patch?.restoreProgress ?? metadata.restoreProgress,
  };
  await writeShelfMetadataAsync(shelfDir, nextMetadata);
  return nextMetadata;
}

/**
 * 判断当前 shelf 元数据是否仍保留可恢复内容，用于 partial unshelve 后决定保留还是删除条目。
 */
function hasRestorableShelfContent(metadata: GitShelvedChangeListMetadata): boolean {
  return metadata.roots.some((rootEntry) => (
    rootEntry.indexPaths.length > 0
    || rootEntry.worktreePaths.length > 0
    || rootEntry.untrackedFiles.length > 0
  ));
}

/**
 * 按本次已恢复路径裁剪剩余 shelf 元数据，支撑 partial unshelve 与“仅移除已成功应用文件”策略。
 */
function removeAppliedPathsFromMetadata(
  metadata: GitShelvedChangeListMetadata,
  appliedPathsByRepoRoot: Record<string, string[]>,
): GitShelvedChangeListMetadata {
  const nextRoots = metadata.roots.map((rootEntry) => {
    const appliedPathSet = new Set(
      (appliedPathsByRepoRoot[rootEntry.repoRoot] || [])
        .map((item) => String(item || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    );
    if (appliedPathSet.size <= 0) return rootEntry;
    const indexPaths = rootEntry.indexPaths.filter((item) => !appliedPathSet.has(item));
    const worktreePaths = rootEntry.worktreePaths.filter((item) => !appliedPathSet.has(item));
    const untrackedFiles = rootEntry.untrackedFiles.filter((item) => !appliedPathSet.has(String(item.relativePath || "").trim().replace(/\\/g, "/")));
    const savedPaths = Array.from(new Set([
      ...indexPaths,
      ...worktreePaths,
      ...untrackedFiles.map((item) => String(item.relativePath || "").trim().replace(/\\/g, "/")),
    ]));
    return {
      ...rootEntry,
      savedPaths,
      indexPaths,
      worktreePaths,
      hasIndexPatch: rootEntry.hasIndexPatch && indexPaths.length > 0,
      hasWorktreePatch: rootEntry.hasWorktreePatch && worktreePaths.length > 0,
      untrackedFiles,
    };
  }).filter((rootEntry) => (
    rootEntry.indexPaths.length > 0
    || rootEntry.worktreePaths.length > 0
    || rootEntry.untrackedFiles.length > 0
  ));
  return {
    ...metadata,
    roots: nextRoots,
    repoRoots: nextRoots.map((item) => item.repoRoot),
    primaryRepoRoot: nextRoots[0]?.repoRoot || metadata.primaryRepoRoot,
  };
}

/**
 * 列出当前仓库关联的 shelf 记录；默认仅返回可恢复的活动记录。
 */
export class ShelveChangesManager {
  private readonly runtime: GitShelfManagerRuntime;

  /**
   * 初始化 shelf 管理器。
   */
  constructor(runtime: GitShelfManagerRuntime) {
    this.runtime = runtime;
  }

  /**
   * 返回当前工作区的 shelf 资源根目录。
   */
  getShelfResourcesDirectory(): string {
    return getShelfStoreRoot(this.runtime.userDataPath, this.runtime.repoRoot);
  }

  /**
   * 列出当前仓库可见的 shelf 记录；多仓记录只要命中当前仓即可展示。
   */
  async listShelvedChangeListsAsync(payload?: {
    includeHidden?: boolean;
    source?: GitShelfSource | "all";
  }): Promise<GitShelvedChangeListItem[]> {
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(this.getShelfResourcesDirectory());
    } catch {
      return [];
    }
    const sourceFilter = payload?.source || "all";
    return (
      await Promise.all(
        entries.map(async (entry) => await readShelfMetadataAsync(path.join(this.getShelfResourcesDirectory(), entry))),
      )
    )
      .filter((metadata): metadata is GitShelvedChangeListMetadata => !!metadata)
      .filter((metadata) => metadata.repoRoots.includes(this.runtime.repoRoot))
      .filter((metadata) => sourceFilter === "all" || metadata.source === sourceFilter)
      .filter((metadata) => payload?.includeHidden === true || ACTIVE_SHELF_STATES.has(metadata.state))
      .map((metadata) => toShelfListItem(metadata))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  /**
   * 创建一条平台级 shelf 记录；调用方需在成功回滚后再将其标记为 `saved`。
   */
  async createShelvedChangeListAsync(
    descriptor: GitShelveChangeListDescriptor,
  ): Promise<{ ok: true; saved: GitShelvedChangeListSavedEntry | null } | { ok: false; error: string }> {
    const normalizedMessage = String(descriptor.message || "").trim() || `Shelf changes @ ${new Date().toISOString()}`;
    const normalizedRoots = Array.from(new Map(
      (Array.isArray(descriptor.roots) ? descriptor.roots : [])
        .map((item) => [String(item.repoRoot || "").trim(), {
          repoRoot: String(item.repoRoot || "").trim(),
          paths: Array.from(new Set((item.paths || []).map((pathItem) => String(pathItem || "").trim().replace(/\\/g, "/")).filter(Boolean))),
          untrackedPaths: Array.from(new Set((item.untrackedPaths || []).map((pathItem) => String(pathItem || "").trim().replace(/\\/g, "/")).filter(Boolean))),
        }]),
    ).values()).filter((item) => item.repoRoot);
    if (normalizedRoots.length <= 0) return { ok: true, saved: null };

    const shelfId = createShelfId();
    const ref = buildShelfRef(shelfId);
    const shelfDir = getShelfDirectory(this.runtime.userDataPath, ref, this.runtime.repoRoot);
    await ensureDirectoryAsync(shelfDir);
    this.runtime.emitProgress?.(this.runtime.repoRoot, "正在搁置本地改动", normalizedMessage);

    const rootEntries: GitShelvedRootEntry[] = [];
    for (const rootChangeSet of normalizedRoots) {
      const entryRes = await createShelvedRootEntryAsync(this.runtime, shelfDir, rootChangeSet);
      if (!entryRes.ok) {
        await fsp.rm(shelfDir, { recursive: true, force: true });
        return entryRes;
      }
      const hasSavedContent = entryRes.entry.hasIndexPatch || entryRes.entry.hasWorktreePatch || entryRes.entry.untrackedFiles.length > 0;
      if (hasSavedContent) rootEntries.push(entryRes.entry);
    }

    if (rootEntries.length <= 0) {
      await fsp.rm(shelfDir, { recursive: true, force: true });
      return { ok: true, saved: null };
    }

    const metadata: GitShelvedChangeListMetadata = {
      version: GIT_SHELF_STORE_VERSION,
      id: shelfId,
      ref,
      message: normalizedMessage,
      createdAt: new Date().toISOString(),
      source: descriptor.source,
      saveChangesPolicy: "shelve",
      state: "orphaned",
      primaryRepoRoot: rootEntries[0]!.repoRoot,
      repoRoots: rootEntries.map((item) => item.repoRoot),
      originalChangeListId: String(descriptor.changeListId || "").trim() || undefined,
      originalChangeListName: String(descriptor.changeListName || "").trim() || undefined,
      roots: rootEntries,
      changeListSnapshots: Array.isArray(descriptor.changeListSnapshots) ? descriptor.changeListSnapshots : undefined,
      restoreProgress: {
        repoProgress: {},
      },
    };
    await writeShelfMetadataAsync(shelfDir, metadata);
    emitShelfManagerChange(this.runtime, {
      type: "created",
      ref,
      repoRoot: metadata.primaryRepoRoot,
      state: metadata.state,
    });
    return {
      ok: true,
      saved: {
        ref,
        repoRoot: metadata.primaryRepoRoot,
        repoRoots: [...metadata.repoRoots],
        message: normalizedMessage,
        source: descriptor.source,
        saveChangesPolicy: "shelve",
        displayName: buildShelvedChangeListDisplayName(ref, metadata.originalChangeListName),
        hasUntrackedFiles: metadata.roots.some((item) => item.untrackedFiles.length > 0),
        originalChangeListId: metadata.originalChangeListId,
        originalChangeListName: metadata.originalChangeListName,
      },
    };
  }

  /**
   * 批量导入外部 patch/diff 文件；单文件失败不会回滚其他已成功导入的记录。
   */
  async importPatchFilesAsync(
    filePaths: string[],
  ): Promise<{ imported: GitShelvedChangeListSavedEntry[]; failed: Array<{ path: string; error: string }> }> {
    const normalizedFilePaths = Array.from(new Set(
      (Array.isArray(filePaths) ? filePaths : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ));
    const imported: GitShelvedChangeListSavedEntry[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const filePath of normalizedFilePaths) {
      const importRes = await importPatchFileAsync(this.runtime, filePath);
      if (!importRes.ok) {
        failed.push({
          path: filePath,
          error: importRes.error,
        });
        continue;
      }
      imported.push(importRes.saved);
    }
    return {
      imported,
      failed,
    };
  }

  /**
   * 把指定 shelf 标记为正常可恢复状态。
   */
  async markChangeListSavedAsync(ref: string): Promise<void> {
    const shelfDir = getShelfDirectory(this.runtime.userDataPath, ref, this.runtime.repoRoot);
    const metadata = await readShelfMetadataAsync(shelfDir);
    if (!metadata) return;
    const nextMetadata = await updateShelfStateAsync(shelfDir, metadata, "saved", {
      lastError: undefined,
      restoreProgress: {
        repoProgress: {},
      },
    });
    emitShelfManagerChange(this.runtime, {
      type: "saved",
      ref: nextMetadata.ref,
      repoRoot: nextMetadata.primaryRepoRoot,
      state: nextMetadata.state,
    });
  }

  /**
   * 把指定 shelf 标记为孤儿状态，并记录失败原因。
   */
  async markChangeListAsOrphanedAsync(ref: string, lastError: string): Promise<void> {
    const shelfDir = getShelfDirectory(this.runtime.userDataPath, ref, this.runtime.repoRoot);
    const metadata = await readShelfMetadataAsync(shelfDir);
    if (!metadata) return;
    const nextMetadata = await updateShelfStateAsync(shelfDir, metadata, "orphaned", {
      lastError: String(lastError || "").trim() || "搁置记录处于孤儿状态",
    });
    emitShelfManagerChange(this.runtime, {
      type: "orphaned",
      ref: nextMetadata.ref,
      repoRoot: nextMetadata.primaryRepoRoot,
      state: nextMetadata.state,
    });
  }

  /**
   * 重命名指定 shelf 记录，仅更新列表展示说明与持久化元数据。
   */
  async renameChangeListAsync(ref: string, message: string): Promise<void> {
    const shelfDir = getShelfDirectory(this.runtime.userDataPath, ref, this.runtime.repoRoot);
    const metadata = await readShelfMetadataAsync(shelfDir);
    if (!metadata) return;
    const nextMetadata = {
      ...metadata,
      message: String(message || "").trim() || metadata.message,
    };
    await writeShelfMetadataAsync(shelfDir, nextMetadata);
    emitShelfManagerChange(this.runtime, {
      type: "renamed",
      ref: nextMetadata.ref,
      repoRoot: nextMetadata.primaryRepoRoot,
      state: nextMetadata.state,
    });
  }

  /**
   * 把指定 shelf 记录移入回收区，供前端在 showRecycled 模式下继续查看与恢复。
   */
  async recycleChangeListAsync(ref: string): Promise<void> {
    const shelfDir = getShelfDirectory(this.runtime.userDataPath, ref, this.runtime.repoRoot);
    const metadata = await readShelfMetadataAsync(shelfDir);
    if (!metadata) return;
    const nextMetadata = await updateShelfStateAsync(shelfDir, metadata, "recycled", {
      lastError: undefined,
    });
    emitShelfManagerChange(this.runtime, {
      type: "recycled",
      ref: nextMetadata.ref,
      repoRoot: nextMetadata.primaryRepoRoot,
      state: nextMetadata.state,
    });
  }

  /**
   * 把回收区或已删除列表中的 shelf 记录恢复回活动视图。
   */
  async restoreArchivedChangeListAsync(ref: string): Promise<void> {
    const shelfDir = getShelfDirectory(this.runtime.userDataPath, ref, this.runtime.repoRoot);
    const metadata = await readShelfMetadataAsync(shelfDir);
    if (!metadata) return;
    const nextMetadata = await updateShelfStateAsync(shelfDir, metadata, "saved", {
      lastError: undefined,
    });
    emitShelfManagerChange(this.runtime, {
      type: "restored-to-list",
      ref: nextMetadata.ref,
      repoRoot: nextMetadata.primaryRepoRoot,
      state: nextMetadata.state,
    });
  }

  /**
   * 恢复指定 shelf 记录；成功后自动删除记录，失败时保留 `restore-failed` 以便后续重试。
   */
  async unshelveChangeListAsync(
    ref: string,
    options?: GitShelveRestoreOptions,
  ): Promise<{ ok: true } | { ok: false; error: string; conflictRepoRoots?: string[] }> {
    const shelfDir = getShelfDirectory(this.runtime.userDataPath, ref, this.runtime.repoRoot);
    const metadata = await readShelfMetadataAsync(shelfDir);
    if (!metadata) {
      return { ok: false, error: `未找到 ${ref} 对应的搁置记录` };
    }
    if (metadata.state === "orphaned") {
      return { ok: false, error: metadata.lastError || "该搁置记录处于孤儿状态，无法自动恢复" };
    }

    this.runtime.emitProgress?.(this.runtime.repoRoot, "正在恢复本地改动", metadata.ref);
    let currentMetadata = await updateShelfStateAsync(shelfDir, metadata, "restoring", {
      lastError: undefined,
      restoreProgress: metadata.restoreProgress || { repoProgress: {} },
    });
    const restoreRes = await doSystemUnshelveAsync(this.runtime, this.runtime.userDataPath, shelfDir, currentMetadata, options);
    if (!restoreRes.ok) {
      await updateShelfStateAsync(shelfDir, currentMetadata, "restore-failed", {
        lastError: restoreRes.error,
        restoreProgress: restoreRes.restoreProgress,
      });
      return {
        ok: false,
        error: restoreRes.error,
        conflictRepoRoots: restoreRes.conflictRepoRoots,
      };
    }

    currentMetadata = await updateShelfStateAsync(shelfDir, currentMetadata, "restoring", {
      restoreProgress: restoreRes.restoreProgress,
    });
    const removeAppliedFromShelf = options?.removeAppliedFromShelf !== false;
    if (!removeAppliedFromShelf) {
      await updateShelfStateAsync(shelfDir, currentMetadata, "saved", {
        lastError: undefined,
        restoreProgress: {
          repoProgress: {},
        },
      });
      return { ok: true };
    }
    const nextMetadata = removeAppliedPathsFromMetadata(currentMetadata, restoreRes.appliedPathsByRepoRoot);
    if (!hasRestorableShelfContent(nextMetadata)) {
      await fsp.rm(shelfDir, { recursive: true, force: true });
      emitShelfManagerChange(this.runtime, {
        type: "removed-after-unshelve",
        ref: metadata.ref,
        repoRoot: metadata.primaryRepoRoot,
      });
      return { ok: true };
    }
    const savedMetadata = await updateShelfStateAsync(shelfDir, nextMetadata, "saved", {
      lastError: undefined,
      restoreProgress: {
        repoProgress: {},
      },
    });
    emitShelfManagerChange(this.runtime, {
      type: "unshelved",
      ref: savedMetadata.ref,
      repoRoot: savedMetadata.primaryRepoRoot,
      state: savedMetadata.state,
    });
    return { ok: true };
  }

  /**
   * 删除指定 shelf 记录；默认先进入 deleted 状态，显式永久删除时才真正移除资源目录。
   */
  async deleteChangeListAsync(ref: string, options?: { permanently?: boolean }): Promise<void> {
    const shelfDir = getShelfDirectory(this.runtime.userDataPath, ref, this.runtime.repoRoot);
    const metadata = await readShelfMetadataAsync(shelfDir);
    if (!metadata) return;
    if (options?.permanently === true) {
      await fsp.rm(shelfDir, {
        recursive: true,
        force: true,
      });
      emitShelfManagerChange(this.runtime, {
        type: "removed",
        ref: metadata.ref,
        repoRoot: metadata.primaryRepoRoot,
      });
      return;
    }
    const nextMetadata = await updateShelfStateAsync(shelfDir, metadata, "deleted", {
      lastError: undefined,
    });
    emitShelfManagerChange(this.runtime, {
      type: "deleted",
      ref: nextMetadata.ref,
      repoRoot: nextMetadata.primaryRepoRoot,
      state: nextMetadata.state,
    });
  }
}
