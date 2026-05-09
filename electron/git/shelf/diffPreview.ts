// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { parseGitUnifiedPatch } from "../diffHunks";
import {
  getShelvedRootDirectory,
  readShelfMetadataByRefAsync,
} from "./manager";
import type { GitShelfManagerRuntime, GitShelvedChangeListMetadata, GitShelvedRootEntry } from "./types";

export type GitShelfDiffMode = "shelf" | "shelfToWorking";

type GitShelfDiffRuntime = Pick<GitShelfManagerRuntime, "runGitExecAsync" | "runGitStdoutToFileAsync">;

type GitShelfPatchBlock = {
  oldPath: string;
  path: string;
  oldBlobId?: string;
  newBlobId?: string;
  patchText: string;
};

type GitShelfMaterializedPair = {
  workspaceDir: string;
  repoRoot: string;
  path: string;
  oldPath?: string;
  baseRelativePath?: string;
  shelfRelativePath?: string;
  basePreview: GitShelfPreviewSource;
  shelfPreview: GitShelfPreviewSource;
};

type GitShelfPreviewSource = {
  ok: boolean;
  text: string;
  isBinary?: boolean;
  tooLarge?: boolean;
};

type GitShelfDiffSnapshotData = {
  path: string;
  oldPath?: string;
  mode: GitShelfDiffMode;
  isBinary: boolean;
  tooLarge?: boolean;
  leftText?: string;
  rightText?: string;
  leftTitle: string;
  rightTitle: string;
  patch?: string;
  patchHeader?: string;
  fingerprint?: string;
  hunks?: any[];
  shelfRef: string;
};

/**
 * 规整 shelf 预览链路中的相对路径，避免分隔符或前导斜杠差异导致匹配失败。
 */
function normalizeShelfPath(pathText: string | undefined | null): string {
  return String(pathText || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * 判断 patch 头中的 blob id 是否为空对象；空对象一律视为空文件。
 */
function isZeroBlobId(blobId: string | undefined): boolean {
  const normalized = String(blobId || "").trim();
  return !normalized || /^0+$/.test(normalized);
}

/**
 * 去掉 Git diff 头中的前缀与外围引号，只保留仓库内相对路径。
 */
function stripGitDiffPathPrefix(value: string, prefix: "a/" | "b/"): string {
  const normalized = String(value || "").trim().replace(/^"+|"+$/g, "");
  if (!normalized) return "";
  if (normalized === "/dev/null") return normalized;
  const withSlash = normalized.replace(/\\/g, "/");
  return withSlash.startsWith(prefix) ? withSlash.slice(prefix.length) : withSlash;
}

/**
 * 解析 `diff --git` 头里的两个路径 token，兼容带引号与空格的路径表示。
 */
function parseGitDiffHeaderTokens(rawText: string): string[] {
  const text = String(rawText || "").trim();
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
    if (index >= text.length) break;
    if (text[index] === "\"") {
      index += 1;
      let token = "";
      while (index < text.length) {
        const current = text[index]!;
        if (current === "\"") {
          index += 1;
          break;
        }
        token += current;
        index += 1;
      }
      tokens.push(token);
      continue;
    }
    let token = "";
    while (index < text.length && !/\s/.test(text[index]!)) {
      token += text[index]!;
      index += 1;
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * 把单个 patch 文件拆成逐文件 block，便于按路径回溯 shelf 中某个文件的 base/final blob。
 */
function parseShelfPatchBlocks(patchText: string): GitShelfPatchBlock[] {
  const text = String(patchText || "").replace(/\r\n/g, "\n");
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const blocks: GitShelfPatchBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const headerLine = String(lines[index] || "");
    if (!headerLine.startsWith("diff --git ")) {
      index += 1;
      continue;
    }
    const nextIndex = (() => {
      let cursor = index + 1;
      while (cursor < lines.length && !String(lines[cursor] || "").startsWith("diff --git ")) cursor += 1;
      return cursor;
    })();
    const blockLines = lines.slice(index, nextIndex);
    index = nextIndex;
    const headerTokens = parseGitDiffHeaderTokens(headerLine.slice("diff --git ".length));
    const fallbackOldPath = stripGitDiffPathPrefix(headerTokens[0] || "", "a/");
    const fallbackPath = stripGitDiffPathPrefix(headerTokens[1] || "", "b/");
    let oldPath = fallbackOldPath;
    let currentPath = fallbackPath;
    let oldBlobId = "";
    let newBlobId = "";
    for (const blockLine of blockLines) {
      const line = String(blockLine || "");
      if (line.startsWith("rename from ")) {
        oldPath = normalizeShelfPath(line.slice("rename from ".length));
        continue;
      }
      if (line.startsWith("rename to ")) {
        currentPath = normalizeShelfPath(line.slice("rename to ".length));
        continue;
      }
      if (line.startsWith("--- ")) {
        const parsed = stripGitDiffPathPrefix(line.slice(4), "a/");
        if (parsed && parsed !== "/dev/null") oldPath = normalizeShelfPath(parsed);
        continue;
      }
      if (line.startsWith("+++ ")) {
        const parsed = stripGitDiffPathPrefix(line.slice(4), "b/");
        if (parsed && parsed !== "/dev/null") currentPath = normalizeShelfPath(parsed);
        continue;
      }
      const blobMatch = line.match(/^index\s+([0-9a-f]{40}|0+)\.\.([0-9a-f]{40}|0+)/i);
      if (!blobMatch) continue;
      oldBlobId = String(blobMatch[1] || "").trim();
      newBlobId = String(blobMatch[2] || "").trim();
    }
    if (!currentPath && !oldPath) continue;
    blocks.push({
      oldPath: normalizeShelfPath(oldPath || currentPath),
      path: normalizeShelfPath(currentPath || oldPath),
      oldBlobId: oldBlobId || undefined,
      newBlobId: newBlobId || undefined,
      patchText: `${blockLines.join("\n")}\n`,
    });
  }
  return blocks;
}

/**
 * 读取单个 patch 文件并解析为逐文件 block；文件缺失时静默回退为空列表。
 */
async function readShelfPatchBlocksAsync(
  patchFilePath: string,
): Promise<GitShelfPatchBlock[]> {
  try {
    const patchText = await fsp.readFile(patchFilePath, "utf8");
    return parseShelfPatchBlocks(String(patchText || ""));
  } catch {
    return [];
  }
}

/**
 * 在指定 root 中按目标路径查找对应的 tracked patch block；重命名场景同时允许命中 old/new path。
 */
async function findTrackedPatchBlocksByPathAsync(
  rootDir: string,
  rootEntry: GitShelvedRootEntry,
  targetPath: string,
): Promise<{ indexBlock: GitShelfPatchBlock | null; worktreeBlock: GitShelfPatchBlock | null }> {
  const normalizedTargetPath = normalizeShelfPath(targetPath);
  const [indexBlocks, worktreeBlocks] = await Promise.all([
    rootEntry.hasIndexPatch
      ? readShelfPatchBlocksAsync(path.join(rootDir, "index.patch"))
      : Promise.resolve([]),
    rootEntry.hasWorktreePatch
      ? readShelfPatchBlocksAsync(path.join(rootDir, "worktree.patch"))
      : Promise.resolve([]),
  ]);
  const match = (block: GitShelfPatchBlock): boolean => {
    const currentPath = normalizeShelfPath(block.path);
    const oldPath = normalizeShelfPath(block.oldPath);
    return currentPath === normalizedTargetPath || oldPath === normalizedTargetPath;
  };
  return {
    indexBlock: indexBlocks.find(match) || null,
    worktreeBlock: worktreeBlocks.find(match) || null,
  };
}

/**
 * 把 blob 内容直接写入临时文件，供后续统一做文本预览与 no-index patch 生成。
 */
async function writeBlobToFileAsync(
  runtime: GitShelfDiffRuntime,
  repoRoot: string,
  blobId: string,
  targetPath: string,
): Promise<boolean> {
  if (isZeroBlobId(blobId)) return false;
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const res = await runtime.runGitStdoutToFileAsync(repoRoot, ["show", String(blobId || "").trim()], targetPath, 30_000);
  return res.ok;
}

/**
 * 把单文件 patch block 回放到临时工作区；这是 shelf 预览读取 working patch 时避免依赖不可直读 blob id 的关键步骤。
 */
async function applyPatchBlockToWorkspaceAsync(
  runtime: GitShelfDiffRuntime,
  workspaceDir: string,
  patchText: string,
): Promise<boolean> {
  const normalizedPatchText = String(patchText || "");
  if (!normalizedPatchText.trim()) return true;
  const patchFilePath = path.join(workspaceDir, `patch-${Date.now()}-${Math.random().toString(16).slice(2)}.diff`);
  await fsp.writeFile(patchFilePath, normalizedPatchText, "utf8");
  try {
    const res = await runtime.runGitExecAsync(
      workspaceDir,
      ["apply", "--unsafe-paths", "--directory=right", patchFilePath],
      30_000,
    );
    return res.ok;
  } finally {
    await fsp.rm(patchFilePath, { force: true }).catch(() => undefined);
  }
}

/**
 * 判断临时工作区中的目标文件是否存在，供 delete / rename 后推导最终右侧文件路径。
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
 * 读取某个真实文件的预览文本；工作区侧沿用现有 2MB 阈值，避免把超大文件直接灌进 Monaco。
 */
async function readPreviewFromFileAsync(
  filePath: string | undefined,
  options?: { enforceSizeLimit?: boolean },
): Promise<GitShelfPreviewSource> {
  const normalizedFilePath = String(filePath || "").trim();
  if (!normalizedFilePath) {
    return {
      ok: true,
      text: "",
    };
  }
  try {
    const stat = await fsp.stat(normalizedFilePath);
    if (options?.enforceSizeLimit && stat.size > 2 * 1024 * 1024) {
      return {
        ok: false,
        text: "",
        tooLarge: true,
      };
    }
    const buffer = await fsp.readFile(normalizedFilePath);
    if (buffer.includes(0)) {
      return {
        ok: false,
        text: "",
        isBinary: true,
      };
    }
    return {
      ok: true,
      text: buffer.toString("utf8"),
    };
  } catch {
    return {
      ok: false,
      text: "",
    };
  }
}

/**
 * 把 `a/left/...`、`b/right/...` 这类临时路径替换回仓库内相对路径，避免导出的 patch 泄漏临时目录结构。
 */
function replaceGeneratedPatchPathVariants(
  patchText: string,
  generatedRelativePath: string | undefined,
  targetRelativePath: string,
  prefixes: string[],
): string {
  const generated = normalizeShelfPath(generatedRelativePath);
  const target = normalizeShelfPath(targetRelativePath);
  if (!generated || !target) return patchText;
  const variants = Array.from(new Set([
    generated,
    generated.replace(/\//g, "\\"),
  ]));
  let nextText = patchText;
  for (const prefix of prefixes) {
    for (const variant of variants) {
      nextText = nextText.split(`${prefix}${variant}`).join(`${prefix}${target}`);
      nextText = nextText.split(`"${prefix}${variant}"`).join(`"${prefix}${target}"`);
    }
  }
  return nextText;
}

/**
 * 基于 materialized 左右文件生成标准 patch；这是按 AGENTS.md 对 IDEA shelf diff 的 Git 面板内变通实现，
 * 通过现有 Git / Monaco Diff 宿主构造等价 patch，而不是新增一套普通编辑器式宿主。
 */
async function buildSyntheticPatchBetweenFilesAsync(
  runtime: GitShelfDiffRuntime,
  workspaceDir: string,
  payload: {
    leftRelativePath?: string;
    rightRelativePath?: string;
    oldPath: string;
    path: string;
  },
): Promise<string> {
  const leftRelativePath = normalizeShelfPath(payload.leftRelativePath);
  const rightRelativePath = normalizeShelfPath(payload.rightRelativePath);
  const leftArg = leftRelativePath || "/dev/null";
  const rightArg = rightRelativePath || "/dev/null";
  const res = await runtime.runGitExecAsync(
    workspaceDir,
    [
      "diff",
      "--no-index",
      "--binary",
      "--full-index",
      "-M",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      leftArg,
      rightArg,
    ],
    30_000,
  );
  let patchText = String(res.stdout || "");
  patchText = replaceGeneratedPatchPathVariants(patchText, leftRelativePath, payload.oldPath, ["a/", "b/"]);
  patchText = replaceGeneratedPatchPathVariants(patchText, rightRelativePath, payload.path, ["a/", "b/"]);
  return patchText;
}

/**
 * 解析目标 path 对应的 root 条目；沿用现有 shelf restore 的相对路径语义，多仓同路径时优先命中首个 root。
 */
function resolveShelfRootEntry(
  metadata: GitShelvedChangeListMetadata,
  targetPath: string,
): { rootEntry: GitShelvedRootEntry; untrackedStoragePath?: string } | null {
  const normalizedTargetPath = normalizeShelfPath(targetPath);
  for (const rootEntry of metadata.roots || []) {
    const untracked = (rootEntry.untrackedFiles || []).find((file) => (
      normalizeShelfPath(file.relativePath) === normalizedTargetPath
    ));
    if (untracked) {
      return {
        rootEntry,
        untrackedStoragePath: String(untracked.storagePath || "").trim() || undefined,
      };
    }
    const pathSet = new Set([
      ...rootEntry.savedPaths,
      ...rootEntry.indexPaths,
      ...rootEntry.worktreePaths,
    ].map((item) => normalizeShelfPath(item)));
    if (pathSet.has(normalizedTargetPath)) return { rootEntry };
  }
  return null;
}

/**
 * 把 tracked shelf 内容物化到临时目录，并同时准备 base/shelf 两侧的文本预览。
 */
async function materializeTrackedShelfPairAsync(
  runtime: GitShelfDiffRuntime,
  metadata: GitShelvedChangeListMetadata,
  rootEntry: GitShelvedRootEntry,
  rootDir: string,
  targetPath: string,
): Promise<GitShelfMaterializedPair | null> {
  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-shelf-diff-"));
  const normalizedTargetPath = normalizeShelfPath(targetPath);
  const { indexBlock, worktreeBlock } = await findTrackedPatchBlocksByPathAsync(rootDir, rootEntry, normalizedTargetPath);
  const baseBlobId = String(indexBlock?.oldBlobId || worktreeBlock?.oldBlobId || "").trim();
  const oldPath = normalizeShelfPath(indexBlock?.oldPath || worktreeBlock?.oldPath || normalizedTargetPath) || normalizedTargetPath;
  const currentPath = normalizeShelfPath(worktreeBlock?.path || indexBlock?.path || normalizedTargetPath) || normalizedTargetPath;
  const baseRelativePath = !isZeroBlobId(baseBlobId) ? `left/${oldPath}` : undefined;
  const mutableRightRelativePath = !isZeroBlobId(baseBlobId) ? `right/${oldPath}` : undefined;
  if (baseRelativePath) {
    const written = await writeBlobToFileAsync(runtime, rootEntry.repoRoot, baseBlobId, path.join(workspaceDir, ...baseRelativePath.split("/")));
    if (!written) {
      await fsp.rm(workspaceDir, { recursive: true, force: true });
      return null;
    }
  }
  if (mutableRightRelativePath && baseRelativePath) {
    const sourcePath = path.join(workspaceDir, ...baseRelativePath.split("/"));
    const targetPath = path.join(workspaceDir, ...mutableRightRelativePath.split("/"));
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fsp.copyFile(sourcePath, targetPath);
    } catch {
      await fsp.rm(workspaceDir, { recursive: true, force: true });
      return null;
    }
  }
  if (!(await applyPatchBlockToWorkspaceAsync(runtime, workspaceDir, String(indexBlock?.patchText || "")))) {
    await fsp.rm(workspaceDir, { recursive: true, force: true });
    return null;
  }
  if (!(await applyPatchBlockToWorkspaceAsync(runtime, workspaceDir, String(worktreeBlock?.patchText || "")))) {
    await fsp.rm(workspaceDir, { recursive: true, force: true });
    return null;
  }
  const shelfRelativePathCandidate = `right/${currentPath}`;
  const shelfRelativePath = await pathExistsAsync(path.join(workspaceDir, ...shelfRelativePathCandidate.split("/")))
    ? shelfRelativePathCandidate
    : undefined;
  return {
    workspaceDir,
    repoRoot: rootEntry.repoRoot,
    path: currentPath,
    oldPath: oldPath !== currentPath ? oldPath : undefined,
    baseRelativePath,
    shelfRelativePath,
    basePreview: await readPreviewFromFileAsync(baseRelativePath ? path.join(workspaceDir, ...baseRelativePath.split("/")) : undefined),
    shelfPreview: await readPreviewFromFileAsync(shelfRelativePath ? path.join(workspaceDir, ...shelfRelativePath.split("/")) : undefined),
  };
}

/**
 * 把 untracked shelf 快照映射成 base=空文件、shelf=存档文件 的标准预览对。
 */
async function materializeUntrackedShelfPairAsync(
  rootEntry: GitShelvedRootEntry,
  rootDir: string,
  targetPath: string,
  storagePath: string,
): Promise<GitShelfMaterializedPair> {
  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-shelf-diff-"));
  const normalizedTargetPath = normalizeShelfPath(targetPath);
  const shelfRelativePath = `right/${normalizedTargetPath}`;
  const sourcePath = path.join(rootDir, storagePath);
  const targetFilePath = path.join(workspaceDir, ...shelfRelativePath.split("/"));
  await fsp.mkdir(path.dirname(targetFilePath), { recursive: true });
  await fsp.copyFile(sourcePath, targetFilePath);
  return {
    workspaceDir,
    repoRoot: rootEntry.repoRoot,
    path: normalizedTargetPath,
    baseRelativePath: undefined,
    shelfRelativePath,
    basePreview: {
      ok: true,
      text: "",
    },
    shelfPreview: await readPreviewFromFileAsync(targetFilePath),
  };
}

/**
 * 解析目标 path 在 shelf 中对应的 base/final 物化结果；失败时返回 null 让上层统一给出用户可读错误。
 */
async function materializeShelfPairAsync(
  runtime: GitShelfDiffRuntime,
  userDataPath: string,
  repoRoot: string,
  ref: string,
  targetPath: string,
): Promise<GitShelfMaterializedPair | null> {
  const metadata = await readShelfMetadataByRefAsync(userDataPath, ref, repoRoot);
  if (!metadata) return null;
  const resolvedRoot = resolveShelfRootEntry(metadata, targetPath);
  if (!resolvedRoot) return null;
  const rootDir = getShelvedRootDirectory(userDataPath, ref, resolvedRoot.rootEntry.repoRoot, repoRoot);
  if (resolvedRoot.untrackedStoragePath) {
    return await materializeUntrackedShelfPairAsync(
      resolvedRoot.rootEntry,
      rootDir,
      targetPath,
      resolvedRoot.untrackedStoragePath,
    );
  }
  return await materializeTrackedShelfPairAsync(
    runtime,
    metadata,
    resolvedRoot.rootEntry,
    rootDir,
    targetPath,
  );
}

/**
 * 按当前 shelf 文件构建标准 Diff 快照；这是对 IDEA shelf diff / compare with local 的 Git 面板内等价实现。
 */
export async function loadShelfDiffSnapshotAsync(args: {
  runtime: GitShelfDiffRuntime;
  userDataPath: string;
  repoRoot: string;
  ref: string;
  path: string;
  mode: GitShelfDiffMode;
}): Promise<{ ok: true; data: GitShelfDiffSnapshotData } | { ok: false; error: string }> {
  const normalizedPath = normalizeShelfPath(args.path);
  if (!normalizedPath) return { ok: false, error: "缺少搁置文件路径" };
  const pair = await materializeShelfPairAsync(args.runtime, args.userDataPath, args.repoRoot, args.ref, normalizedPath);
  if (!pair) {
    return { ok: false, error: `未找到 ${args.ref} 中的文件 ${normalizedPath}` };
  }
  try {
    const compareWithLocal = args.mode === "shelfToWorking";
    const leftPreview = compareWithLocal ? pair.shelfPreview : pair.basePreview;
    const rightPreview = compareWithLocal
      ? await readPreviewFromFileAsync(path.join(pair.repoRoot, pair.path), { enforceSizeLimit: true })
      : pair.shelfPreview;
    const patchText = await buildSyntheticPatchBetweenFilesAsync(args.runtime, pair.workspaceDir, {
      leftRelativePath: compareWithLocal ? pair.shelfRelativePath : pair.baseRelativePath,
      rightRelativePath: compareWithLocal ? undefined : pair.shelfRelativePath,
      oldPath: normalizeShelfPath(compareWithLocal ? pair.path : (pair.oldPath || pair.path)),
      path: normalizeShelfPath(pair.path),
    });
    const comparedPatchText = compareWithLocal
      ? await buildSyntheticPatchBetweenFilesAsync(args.runtime, pair.workspaceDir, {
        leftRelativePath: pair.shelfRelativePath,
        rightRelativePath: await (async () => {
          const workingAbsolutePath = path.join(pair.repoRoot, pair.path);
          try {
            const stat = await fsp.stat(workingAbsolutePath);
            if (!stat.isFile()) return undefined;
            const relativePath = `working/${pair.path}`;
            const copiedTargetPath = path.join(pair.workspaceDir, ...relativePath.split("/"));
            await fsp.mkdir(path.dirname(copiedTargetPath), { recursive: true });
            await fsp.copyFile(workingAbsolutePath, copiedTargetPath);
            return relativePath;
          } catch {
            return undefined;
          }
        })(),
        oldPath: normalizeShelfPath(pair.path),
        path: normalizeShelfPath(pair.path),
      })
      : patchText;
    const effectivePatchText = compareWithLocal ? comparedPatchText : patchText;
    const structuredPatch = (!leftPreview.isBinary && !rightPreview.isBinary && !rightPreview.tooLarge)
      ? parseGitUnifiedPatch(effectivePatchText)
      : null;
    return {
      ok: true,
      data: {
        path: pair.path,
        oldPath: pair.oldPath,
        mode: args.mode,
        isBinary: leftPreview.isBinary === true || rightPreview.isBinary === true || rightPreview.tooLarge === true,
        tooLarge: rightPreview.tooLarge === true,
        leftText: leftPreview.ok ? leftPreview.text : "",
        rightText: rightPreview.ok ? rightPreview.text : "",
        leftTitle: compareWithLocal ? "Shelf" : (pair.baseRelativePath ? "Base" : "空"),
        rightTitle: compareWithLocal ? "Working Tree" : "Shelf",
        patch: structuredPatch?.patch,
        patchHeader: structuredPatch?.patchHeader,
        fingerprint: structuredPatch?.fingerprint,
        hunks: structuredPatch?.hunks,
        shelfRef: args.ref,
      },
    };
  } finally {
    await fsp.rm(pair.workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 导出某个 shelf 文件的最终 patch；统一按 base → shelf final 内容生成，确保 mixed staged/worktree 文件能合并成单补丁。
 */
export async function loadShelfDiffPatchAsync(args: {
  runtime: GitShelfDiffRuntime;
  userDataPath: string;
  repoRoot: string;
  ref: string;
  path: string;
}): Promise<{ ok: true; patch: string } | { ok: false; error: string }> {
  const normalizedPath = normalizeShelfPath(args.path);
  if (!normalizedPath) return { ok: false, error: "缺少搁置文件路径" };
  const pair = await materializeShelfPairAsync(args.runtime, args.userDataPath, args.repoRoot, args.ref, normalizedPath);
  if (!pair) {
    return { ok: false, error: `未找到 ${args.ref} 中的文件 ${normalizedPath}` };
  }
  try {
    const patch = await buildSyntheticPatchBetweenFilesAsync(args.runtime, pair.workspaceDir, {
      leftRelativePath: pair.baseRelativePath,
      rightRelativePath: pair.shelfRelativePath,
      oldPath: normalizeShelfPath(pair.oldPath || pair.path),
      path: normalizeShelfPath(pair.path),
    });
    return {
      ok: true,
      patch,
    };
  } finally {
    await fsp.rm(pair.workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
