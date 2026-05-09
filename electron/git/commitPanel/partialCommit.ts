// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { decodeGitEscapedText } from "./statusModel";
import { normalizeRepoPaths } from "./pathUtils";
import { toFsPathKey } from "../pathKey";
import type { GitStagedSaverStrategy } from "./stagedSaverStrategy";

export type CommitSelectionMode = "full-file" | "partial";

export type CommitSelectionItem = {
  repoRoot?: string;
  changeListId?: string;
  path: string;
  oldPath?: string;
  kind?: "change" | "unversioned" | "ignored";
  selectionMode?: CommitSelectionMode;
  snapshotFingerprint?: string;
  patch?: string;
  selectedHunkIds?: string[];
};

type CommitIndexDependencies<GitCtx, GitExecResult> = {
  runGitSpawnAsync: (
    ctx: GitCtx,
    repoRoot: string,
    argv: string[],
    timeoutMs?: number,
    envPatch?: NodeJS.ProcessEnv,
    stdin?: string | Buffer,
  ) => Promise<GitExecResult>;
  runGitExecAsync: (
    ctx: GitCtx,
    repoRoot: string,
    argv: string[],
    timeoutMs?: number,
    envPatch?: NodeJS.ProcessEnv,
  ) => Promise<GitExecResult>;
  toGitErrorMessage: (res: GitExecResult, fallback: string) => string;
};

export type NormalizedCommitSelectionItem = {
  repoRoot: string;
  changeListId: string;
  path: string;
  oldPath?: string;
  kind: "change" | "unversioned" | "ignored";
  selectionMode: CommitSelectionMode;
  snapshotFingerprint?: string;
  patch?: string;
  selectedHunkIds: string[];
};

export type PreparedCommitIndexState = {
  strategy: GitStagedSaverStrategy;
  originalStagedChanges: SavedStagedChange[];
  successRestoreStagedChanges: SavedStagedChange[];
  touchedTrackedPaths: string[];
  touchedAddedPaths: string[];
  cleanupFiles: string[];
};

type SavedStagedChange = {
  path: string;
  isSubmodule: boolean;
  headHash: string;
  stagedHash: string;
  headMode: string;
  stagedMode: string;
};

type ParsedStagedStatusRecord =
  | { kind: "staged"; change: SavedStagedChange }
  | { kind: "unmerged"; path: string };

type FullSelectionStagePlan = {
  addPaths: string[];
  removePaths: string[];
};

const NULL_GIT_HASH = "0000000000000000000000000000000000000000";
const STATUS_SUBMODULE_NONE = "N...";

/**
 * 将 selection mode 规整为受支持的提交模式；未知值一律回退到整文件。
 */
function normalizeCommitSelectionMode(value: unknown): CommitSelectionMode {
  return value === "partial" ? "partial" : "full-file";
}

/**
 * 把任意路径规整为仓库相对路径文本，统一使用 `/` 分隔符。
 */
function normalizeCommitSelectionPath(repoRoot: string, rawPath: string): string {
  return normalizeRepoPaths(repoRoot, [rawPath])[0] || "";
}

/**
 * 为 selection 生成“仓库根 + 路径”去重键，避免多仓同路径在后端被意外合并。
 */
function buildCommitSelectionIdentityKey(repoRoot: string, filePath: string): string {
  return `${toFsPathKey(repoRoot)}::${String(filePath || "").trim()}`;
}

/**
 * 从 payload 中读取结构化 selection；若调用方仍传旧字段，则自动回退为整文件 selection。
 */
export function resolveCommitSelectionItems(repoRoot: string, payload: any): NormalizedCommitSelectionItem[] {
  const rawSelections = Array.isArray(payload?.selections) ? payload.selections : [];
  if (rawSelections.length > 0) {
    return rawSelections
      .map((item: CommitSelectionItem) => {
        const normalizedRepoRoot = String(item?.repoRoot || repoRoot || "").trim() || repoRoot;
        const normalizedPath = normalizeCommitSelectionPath(normalizedRepoRoot, item?.path || "");
        const selectionMode = normalizeCommitSelectionMode(item?.selectionMode);
        const patchText = String(item?.patch || "");
        const kind = item?.kind === "ignored" || item?.kind === "unversioned" ? item.kind : "change";
        return {
          repoRoot: normalizedRepoRoot,
          changeListId: String(item?.changeListId || "default").trim() || "default",
          path: normalizedPath,
          oldPath: normalizeCommitSelectionPath(normalizedRepoRoot, item?.oldPath || "") || undefined,
          kind,
          selectionMode,
          snapshotFingerprint: String(item?.snapshotFingerprint || "").trim() || undefined,
          patch: selectionMode === "partial" ? patchText : undefined,
          selectedHunkIds: Array.isArray(item?.selectedHunkIds)
            ? item.selectedHunkIds.map((one) => String(one || "").trim()).filter(Boolean)
            : [],
        } satisfies NormalizedCommitSelectionItem;
      })
      .filter((item: NormalizedCommitSelectionItem) => !!item.repoRoot && !!item.path)
      .filter((item: NormalizedCommitSelectionItem, index: number, list: NormalizedCommitSelectionItem[]) => (
        list.findIndex((candidate: NormalizedCommitSelectionItem) => (
          buildCommitSelectionIdentityKey(candidate.repoRoot, candidate.path) === buildCommitSelectionIdentityKey(item.repoRoot, item.path)
        )) === index
      ));
  }

  const rawItems = Array.isArray(payload?.includedItems) ? payload.includedItems : [];
  if (rawItems.length > 0) {
    return rawItems
      .map((item: any) => {
        const normalizedRepoRoot = String(item?.repoRoot || repoRoot || "").trim() || repoRoot;
        return {
          repoRoot: normalizedRepoRoot,
        changeListId: String(item?.changeListId || "default").trim() || "default",
          path: normalizeCommitSelectionPath(normalizedRepoRoot, item?.path || ""),
          oldPath: normalizeCommitSelectionPath(normalizedRepoRoot, item?.oldPath || "") || undefined,
        kind: item?.kind === "ignored" || item?.kind === "unversioned" ? item.kind : "change",
        selectionMode: "full-file" as const,
        selectedHunkIds: [],
        };
      })
      .filter((item: NormalizedCommitSelectionItem) => !!item.repoRoot && !!item.path)
      .filter((item: NormalizedCommitSelectionItem, index: number, list: NormalizedCommitSelectionItem[]) => (
        list.findIndex((candidate: NormalizedCommitSelectionItem) => (
          buildCommitSelectionIdentityKey(candidate.repoRoot, candidate.path) === buildCommitSelectionIdentityKey(item.repoRoot, item.path)
        )) === index
      ));
  }

  return normalizeRepoPaths(repoRoot, payload?.files).map((filePath) => ({
    repoRoot,
    changeListId: "default",
    path: filePath,
    kind: "change" as const,
    selectionMode: "full-file" as const,
    selectedHunkIds: [],
  }));
}

/**
 * 按 selection 模式拆分整文件提交与 partial commit 集合。
 */
function splitCommitSelectionItems(items: NormalizedCommitSelectionItem[]): {
  fullSelections: NormalizedCommitSelectionItem[];
  partialSelections: NormalizedCommitSelectionItem[];
} {
  const fullSelections: NormalizedCommitSelectionItem[] = [];
  const partialSelections: NormalizedCommitSelectionItem[] = [];
  for (const item of items) {
    if (item.selectionMode === "partial") {
      partialSelections.push(item);
      continue;
    }
    fullSelections.push(item);
  }
  return {
    fullSelections,
    partialSelections,
  };
}

/**
 * 按整文件 selection 构造提交专用暂存计划。
 * - 对齐上游提交索引链路的 `stageForCommit` 语义；
 * - `oldPath` 统一走 remove，避免把已不存在路径继续塞进 `git add`；
 * - 待提交路径统一作为精确选区写入 index，底层 add 阶段再使用 force 兼容被忽略路径。
 */
function splitFullSelectionAddGroups(items: NormalizedCommitSelectionItem[]): FullSelectionStagePlan {
  const addSet = new Set<string>();
  const removeSet = new Set<string>();
  for (const item of items) {
    addSet.add(item.path);
    if (item.kind === "change" && item.oldPath && item.oldPath !== item.path)
      removeSet.add(item.oldPath);
  }
  for (const addPath of addSet) {
    removeSet.delete(addPath);
  }
  return {
    addPaths: Array.from(addSet),
    removePaths: Array.from(removeSet),
  };
}

/**
 * 按固定大小切分路径列表，避免单次命令行参数过长。
 */
function chunkPathList(paths: string[], chunkSize: number = 160): string[][] {
  const clean = Array.from(new Set(paths.map((one) => String(one || "").trim()).filter(Boolean)));
  if (clean.length === 0) return [];
  const size = Math.max(20, Math.floor(chunkSize));
  const out: string[][] = [];
  for (let index = 0; index < clean.length; index += size) {
    out.push(clean.slice(index, index + size));
  }
  return out;
}

/**
 * 按固定大小切分任意数组，供 `update-index --index-info` 等批处理命令复用。
 */
function chunkCommitItems<T>(items: T[], chunkSize: number = 160): T[][] {
  if (items.length === 0) return [];
  const size = Math.max(20, Math.floor(chunkSize));
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * 创建用于保存临时补丁文件的唯一路径。
 */
async function createTempPatchFilePathAsync(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `${String(prefix || "codexflow-patch")}-`));
  return path.join(dir, "patch.diff");
}

/**
 * 写入临时补丁文件，供 `git apply --cached` 直接消费。
 */
async function writePatchFileAsync(prefix: string, patchText: string): Promise<string> {
  const patchFilePath = await createTempPatchFilePathAsync(prefix);
  await fsp.writeFile(patchFilePath, String(patchText || ""), "utf8");
  return patchFilePath;
}

/**
 * 删除临时文件，并在文件所在目录为空时顺手清理目录。
 */
async function safeRemoveTempFileAsync(filePath: string): Promise<void> {
  const cleanPath = String(filePath || "").trim();
  if (!cleanPath) return;
  try {
    await fsp.rm(cleanPath, { force: true });
  } catch {}
  try {
    await fsp.rm(path.dirname(cleanPath), { recursive: true, force: true });
  } catch {}
}

/**
 * 在准备阶段提前失败时，尽力回收已经创建的全部临时文件。
 */
async function cleanupTempFilesBestEffortAsync(filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    await safeRemoveTempFileAsync(filePath);
  }
}

/**
 * 解析 `git status --porcelain=v2 -z --no-renames` 的 staged 元数据。
 * - 只保留普通 staged 记录；
 * - 一旦出现 `u` 记录，交由上层按“未解决冲突”失败。
 */
function parseSavedStagedStatusRecords(stdout: string): ParsedStagedStatusRecord[] {
  const parts = String(stdout || "").split("\0").filter((item) => item.length > 0);
  const out: ParsedStagedStatusRecord[] = [];
  for (const line of parts) {
    if (!line) continue;
    if (line.startsWith("u ")) {
      const match = line.match(/^u\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
      const filePath = decodeGitEscapedText(match?.[1] || "");
      if (filePath) out.push({ kind: "unmerged", path: filePath });
      continue;
    }
    if (!line.startsWith("1 ")) continue;
    const match = line.match(/^1\s+(\S\S)\s+(\S+)\s+(\S+)\s+(\S+)\s+\S+\s+(\S+)\s+(\S+)\s+(.+)$/);
    const stagedCode = String(match?.[1] || "..")[0] || ".";
    if (stagedCode === ".") continue;
    const filePath = decodeGitEscapedText(match?.[7] || "");
    if (!filePath) continue;
    out.push({
      kind: "staged",
      change: {
        path: filePath,
        isSubmodule: String(match?.[2] || STATUS_SUBMODULE_NONE) !== STATUS_SUBMODULE_NONE,
        headMode: String(match?.[3] || "").trim(),
        stagedMode: String(match?.[4] || "").trim(),
        headHash: String(match?.[5] || "").trim() || NULL_GIT_HASH,
        stagedHash: String(match?.[6] || "").trim() || NULL_GIT_HASH,
      },
    });
  }
  return out;
}

/**
 * 读取当前暂存区的结构化状态快照，供提交前排除与提交后恢复共用。
 */
async function listSavedStagedChangesAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
): Promise<{ ok: true; changes: SavedStagedChange[] } | { ok: false; error: string }> {
  const res = await dependencies.runGitExecAsync(
    ctx,
    repoRoot,
    ["status", "--porcelain=v2", "-z", "--no-renames", "--no-ahead-behind", "--no-show-stash", "--untracked-files=no", "--ignored=no"],
    20_000,
  );
  if (!res.ok) return { ok: false, error: dependencies.toGitErrorMessage(res, "读取暂存区状态失败") };
  const records = parseSavedStagedStatusRecords(String(res.stdout || ""));
  const unmerged = records.find((record) => record.kind === "unmerged");
  if (unmerged?.path) return { ok: false, error: "存在未解决冲突文件，请先解决后再提交" };
  const changes = records
    .filter((record): record is Extract<ParsedStagedStatusRecord, { kind: "staged" }> => record.kind === "staged")
    .map((record) => record.change)
    .filter((change, index, list) => list.findIndex((candidate) => candidate.path === change.path) === index);
  return { ok: true, changes };
}

/**
 * 按 selection 构造“失败时要回滚到 HEAD/移出 index”的路径集合。
 */
function buildTouchedCommitPaths(selections: NormalizedCommitSelectionItem[]): { trackedPaths: string[]; addedPaths: string[] } {
  const trackedPathSet = new Set<string>();
  const addedPathSet = new Set<string>();
  for (const item of selections) {
    if (!item.path) continue;
    if (item.kind === "change") {
      trackedPathSet.add(item.path);
      if (item.oldPath) trackedPathSet.add(item.oldPath);
    }
    else addedPathSet.add(item.path);
  }
  return {
    trackedPaths: Array.from(trackedPathSet),
    addedPaths: Array.from(addedPathSet),
  };
}

/**
 * 把一条 staged 快照转成 `git update-index --index-info` 可直接消费的输入行。
 */
function buildUpdateIndexInfoLine(change: SavedStagedChange, target: "head" | "staged"): string {
  const hash = target === "head" ? change.headHash : change.stagedHash;
  if (!hash || hash === NULL_GIT_HASH) return `0 ${NULL_GIT_HASH}\t${change.path}`;
  const mode = (target === "head" ? change.headMode : change.stagedMode).trim();
  return `${mode} ${hash} 0\t${change.path}`;
}

/**
 * 批量把 staged 快照写回 index；既可用于“准备提交前排除”，也可用于“提交后恢复”。
 */
async function applySavedStagedChangesAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  changes: SavedStagedChange[],
  target: "head" | "staged",
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
  fallback: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const chunk of chunkCommitItems(changes, 120)) {
    const stdin = chunk.map((change) => buildUpdateIndexInfoLine(change, target)).join("\n").trim();
    if (!stdin) continue;
    const res = await dependencies.runGitSpawnAsync(ctx, repoRoot, ["update-index", "--index-info"], 120_000, undefined, `${stdin}\n`);
    if (!res.ok) return { ok: false, error: dependencies.toGitErrorMessage(res, fallback) };
  }
  return { ok: true };
}

/**
 * 提取一批 staged 快照涉及的唯一路径，供 reset-add 策略统一复用。
 */
function collectSavedStagedChangePaths(changes: SavedStagedChange[]): string[] {
  return Array.from(new Set(
    (changes || [])
      .map((change) => String(change.path || "").trim())
      .filter(Boolean),
  ));
}

/**
 * reset-add 策略下，先通过 `git reset --` 把本次不应提交的 staged 路径排除出 index。
 */
async function resetSavedStagedChangesAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  changes: SavedStagedChange[],
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
  fallback: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const paths = collectSavedStagedChangePaths(changes);
  for (const chunk of chunkPathList(paths, 120)) {
    const res = await dependencies.runGitSpawnAsync(ctx, repoRoot, ["reset", "--", ...chunk], 120_000);
    if (!res.ok) return { ok: false, error: dependencies.toGitErrorMessage(res, fallback) };
  }
  return { ok: true };
}

/**
 * reset-add 策略下，通过 `git add -A -f` 重新暂存原本应保留的路径集合。
 */
async function restageSavedStagedChangesAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  changes: SavedStagedChange[],
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
  fallback: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const paths = collectSavedStagedChangePaths(changes);
  for (const chunk of chunkPathList(paths, 120)) {
    const res = await dependencies.runGitSpawnAsync(ctx, repoRoot, ["add", "-A", "-f", "--", ...chunk], 120_000);
    if (!res.ok) return { ok: false, error: dependencies.toGitErrorMessage(res, fallback) };
  }
  return { ok: true };
}

/**
 * 在提交失败后，把本次尝试临时写入 index 的 tracked 选择重置回 HEAD。
 */
async function resetTouchedTrackedPathsAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  trackedPaths: string[],
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const chunk of chunkPathList(trackedPaths, 120)) {
    const res = await dependencies.runGitSpawnAsync(ctx, repoRoot, ["reset", "HEAD", "--", ...chunk], 120_000);
    if (!res.ok) return { ok: false, error: dependencies.toGitErrorMessage(res, "恢复暂存区失败") };
  }
  return { ok: true };
}

/**
 * 在提交失败后，把本次尝试临时加入 index 的 unversioned/ignored 选择从暂存区移除。
 */
async function unstageTouchedAddedPathsAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  addedPaths: string[],
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const chunk of chunkPathList(addedPaths, 120)) {
    const res = await dependencies.runGitSpawnAsync(ctx, repoRoot, ["rm", "--cached", "--ignore-unmatch", "--", ...chunk], 120_000);
    if (!res.ok) return { ok: false, error: dependencies.toGitErrorMessage(res, "恢复暂存区失败") };
  }
  return { ok: true };
}

/**
 * 把 partial commit 生成的补丁写入当前 index；优先使用 `--3way`，未知选项时自动回退。
 */
async function applyPatchToIndexAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  patchFilePath: string,
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
  envPatch?: NodeJS.ProcessEnv,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const baseArgv = ["apply", "--cached", "--whitespace=nowarn"];
  const res3way = await dependencies.runGitSpawnAsync(ctx, repoRoot, [...baseArgv, "--3way", patchFilePath], 120_000, envPatch);
  if (res3way.ok) return { ok: true };

  const message = `${String(res3way.stderr || "")}\n${String(res3way.stdout || "")}`.trim();
  const unknown3way = /unknown option.*--3way|unknown option.*3way|unrecognized option.*--3way/i.test(message);
  if (!unknown3way) {
    return { ok: false, error: dependencies.toGitErrorMessage(res3way, "写入部分提交索引失败") };
  }

  const fallbackRes = await dependencies.runGitSpawnAsync(ctx, repoRoot, [...baseArgv, patchFilePath], 120_000, envPatch);
  if (fallbackRes.ok) return { ok: true };
  return { ok: false, error: dependencies.toGitErrorMessage(fallbackRes, "写入部分提交索引失败") };
}

/**
 * 把整文件 selection 写入真实 index。
 */
async function stageFullSelectionsAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  fullSelections: NormalizedCommitSelectionItem[],
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { addPaths, removePaths } = splitFullSelectionAddGroups(fullSelections);
  for (const chunk of chunkPathList(removePaths, 120)) {
    const res = await dependencies.runGitSpawnAsync(ctx, repoRoot, ["rm", "--cached", "--ignore-unmatch", "-r", "--", ...chunk], 120_000);
    if (!res.ok) return { ok: false, error: dependencies.toGitErrorMessage(res, "暂存待删除路径失败") };
  }
  for (const chunk of chunkPathList(addPaths, 120)) {
    const res = await dependencies.runGitSpawnAsync(ctx, repoRoot, ["add", "-A", "-f", "--", ...chunk], 120_000);
    if (!res.ok) return { ok: false, error: dependencies.toGitErrorMessage(res, "暂存文件失败") };
  }
  return { ok: true };
}

/**
 * 把 partial selection 对应的 patch 合并后写入真实 index。
 */
async function stagePartialSelectionsAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  partialSelections: NormalizedCommitSelectionItem[],
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
  cleanupFiles: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const patchText = partialSelections
    .map((item) => String(item.patch || ""))
    .filter((text) => !!text.trim())
    .join("");
  if (!patchText.trim()) return { ok: true };

  const patchFilePath = await writePatchFileAsync("codexflow-partial-stage", patchText);
  cleanupFiles.push(patchFilePath);
  const applyRes = await applyPatchToIndexAsync(ctx, repoRoot, patchFilePath, dependencies);
  if (!applyRes.ok) return applyRes;
  return { ok: true };
}

/**
 * 把主错误与恢复错误拼成单条返回文案，避免恢复失败吞掉原始根因。
 */
function mergeCommitIndexFailureMessage(primaryError: string, restoreError: string): string {
  const primary = String(primaryError || "").trim() || "准备部分提交索引失败";
  const restore = String(restoreError || "").trim();
  if (!restore) return primary;
  return `${primary}（恢复暂存区失败：${restore}）`;
}

/**
 * 将真实 index 调整为“仅包含本次提交选区”的临时状态。
 * - 对齐上游暂存区状态管理语义：提交前只排除“不应进入本次提交”的 staged 状态；
 * - 不再复制 `.git/index`，避免 Windows worktree 下 `copyfile` 失败。
 */
export async function prepareCommitIndexAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  selections: NormalizedCommitSelectionItem[],
  strategy: GitStagedSaverStrategy,
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
): Promise<{ ok: true; state: PreparedCommitIndexState } | { ok: false; error: string }> {
  const cleanupFiles: string[] = [];
  const { fullSelections, partialSelections } = splitCommitSelectionItems(selections);
  const stagedChangesRes = await listSavedStagedChangesAsync(ctx, repoRoot, dependencies);
  if (!stagedChangesRes.ok) return stagedChangesRes;

  const originalStagedChanges = stagedChangesRes.changes;
  const partialPathSet = new Set(partialSelections.flatMap((item) => [item.path, item.oldPath].filter(Boolean) as string[]));
  const fullPathSet = new Set(fullSelections.flatMap((item) => [item.path, item.oldPath].filter(Boolean) as string[]));
  const successRestoreStagedChanges = originalStagedChanges.filter((change) => partialPathSet.has(change.path) || !fullPathSet.has(change.path));
  const touchedPaths = buildTouchedCommitPaths(selections);
  const preparedState: PreparedCommitIndexState = {
    strategy,
    originalStagedChanges,
    successRestoreStagedChanges,
    touchedTrackedPaths: touchedPaths.trackedPaths,
    touchedAddedPaths: touchedPaths.addedPaths,
    cleanupFiles,
  };

  try {
    const excludeRes = strategy === "reset-add"
      ? await resetSavedStagedChangesAsync(
          ctx,
          repoRoot,
          successRestoreStagedChanges,
          dependencies,
          "准备提交时重置暂存区失败",
        )
      : await applySavedStagedChangesAsync(
          ctx,
          repoRoot,
          successRestoreStagedChanges,
          "head",
          dependencies,
          "准备提交时重置暂存区失败",
        );
    if (!excludeRes.ok) {
      await cleanupTempFilesBestEffortAsync(cleanupFiles);
      return excludeRes;
    }

    const stageFullRes = await stageFullSelectionsAsync(ctx, repoRoot, fullSelections, dependencies);
    if (!stageFullRes.ok) {
      const restoreRes = await restorePreparedCommitIndexAsync(ctx, repoRoot, preparedState, dependencies, "failure");
      await cleanupTempFilesBestEffortAsync(cleanupFiles);
      return { ok: false, error: mergeCommitIndexFailureMessage(stageFullRes.error, restoreRes.ok ? "" : restoreRes.error) };
    }

    const stagePartialRes = await stagePartialSelectionsAsync(ctx, repoRoot, partialSelections, dependencies, cleanupFiles);
    if (!stagePartialRes.ok) {
      const restoreRes = await restorePreparedCommitIndexAsync(ctx, repoRoot, preparedState, dependencies, "failure");
      await cleanupTempFilesBestEffortAsync(cleanupFiles);
      return { ok: false, error: mergeCommitIndexFailureMessage(stagePartialRes.error, restoreRes.ok ? "" : restoreRes.error) };
    }

    return {
      ok: true,
      state: preparedState,
    };
  } catch (error: any) {
    const restoreRes = await restorePreparedCommitIndexAsync(ctx, repoRoot, preparedState, dependencies, "failure");
    await cleanupTempFilesBestEffortAsync(cleanupFiles);
    return {
      ok: false,
      error: mergeCommitIndexFailureMessage(
        String(error?.message || error || "").trim() || "准备部分提交索引失败",
        restoreRes.ok ? "" : restoreRes.error,
      ),
    };
  }
}

/**
 * 按提交结果恢复 staged 状态。
 * - 成功时只恢复“本次未提交但原本已 staged”的那部分；
 * - 失败时先撤掉本次尝试写入 index 的变更，再完整恢复原始 staged 快照。
 */
export async function restorePreparedCommitIndexAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  state: PreparedCommitIndexState,
  dependencies: CommitIndexDependencies<GitCtx, GitExecResult>,
  result: "success" | "failure",
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (result === "success") {
    return state.strategy === "reset-add"
      ? await restageSavedStagedChangesAsync(
          ctx,
          repoRoot,
          state.successRestoreStagedChanges,
          dependencies,
          "恢复暂存区失败",
        )
      : await applySavedStagedChangesAsync(
          ctx,
          repoRoot,
          state.successRestoreStagedChanges,
          "staged",
          dependencies,
          "恢复暂存区失败",
        );
  }

  const resetTrackedRes = await resetTouchedTrackedPathsAsync(ctx, repoRoot, state.touchedTrackedPaths, dependencies);
  if (!resetTrackedRes.ok) return resetTrackedRes;
  const unstageAddedRes = await unstageTouchedAddedPathsAsync(ctx, repoRoot, state.touchedAddedPaths, dependencies);
  if (!unstageAddedRes.ok) return unstageAddedRes;
  return state.strategy === "reset-add"
    ? await restageSavedStagedChangesAsync(
        ctx,
        repoRoot,
        state.originalStagedChanges,
        dependencies,
        "恢复暂存区失败",
      )
    : await applySavedStagedChangesAsync(
        ctx,
        repoRoot,
        state.originalStagedChanges,
        "staged",
        dependencies,
        "恢复暂存区失败",
      );
}

/**
 * 统一清理 partial commit 过程中产生的临时补丁文件。
 */
export async function cleanupPreparedCommitIndexAsync(state: PreparedCommitIndexState | null | undefined): Promise<void> {
  for (const filePath of state?.cleanupFiles || []) {
    await safeRemoveTempFileAsync(filePath);
  }
}
