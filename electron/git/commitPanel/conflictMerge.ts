// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { GitExecResult } from "../exec";
import { buildConflictMergeMetadata } from "./conflictMergeMetadata";
import type {
  GitConflictMergeBlockData as GitCommitPanelConflictMergeBlockData,
  GitConflictMergeImportMetadata as GitCommitPanelConflictMergeImportMetadata,
  GitConflictMergeMetadata as GitCommitPanelConflictMergeMetadata,
} from "./conflictMergeShared";
import { decodeGitEscapedText } from "./statusModel";

const MAX_CONFLICT_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_CONFLICT_TEXT_LINE_COUNT = 20_000;

export type GitCommitPanelConflictSourceKey = "base" | "ours" | "theirs" | "working";

export type GitCommitPanelConflictRevision = {
  label: string;
  text: string;
  available: boolean;
  isBinary?: boolean;
  tooLarge?: boolean;
};

export type GitCommitPanelConflictMergeSnapshot = {
  path: string;
  reverseSides?: boolean;
  base: GitCommitPanelConflictRevision;
  ours: GitCommitPanelConflictRevision;
  theirs: GitCommitPanelConflictRevision;
  working: GitCommitPanelConflictRevision;
  merge: GitCommitPanelConflictMergeMetadata;
};

export type {
  GitCommitPanelConflictMergeBlockData,
  GitCommitPanelConflictMergeImportMetadata,
  GitCommitPanelConflictMergeMetadata,
};

export type GitCommitPanelConflictResolverEntry = {
  path: string;
  reverseSides: boolean;
  canOpenMerge: boolean;
  base: Omit<GitCommitPanelConflictRevision, "text">;
  ours: Omit<GitCommitPanelConflictRevision, "text">;
  theirs: Omit<GitCommitPanelConflictRevision, "text">;
  working: Omit<GitCommitPanelConflictRevision, "text">;
};

export type GitCommitPanelConflictRuntime = {
  runGitExecAsync(argv: string[], timeoutMs?: number): Promise<GitExecResult>;
};

export type GitCommitPanelConflictResolverRuntime = GitCommitPanelConflictRuntime & {
  runGitSpawnAsync(argv: string[], timeoutMs?: number): Promise<GitExecResult>;
};

/**
 * 统一归一化冲突路径，确保后续 Git 参数和文件系统访问基于同一相对路径语义。
 */
function normalizeConflictPath(pathText: string): string {
  return String(pathText || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 校验并解析仓库内文件的绝对路径，阻止越界访问工作区外部路径。
 */
function resolveRepoFileAbsolutePath(repoRoot: string, relPath: string): string | null {
  const repoAbs = path.resolve(repoRoot);
  const targetAbs = path.resolve(repoAbs, relPath);
  const relative = path.relative(repoAbs, targetAbs).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../")) return null;
  return targetAbs;
}

/**
 * 按 stage 号映射冲突来源标签，供前端对话框直接复用。
 */
function resolveConflictStageLabel(stage: 1 | 2 | 3, reverse: boolean): string {
  if (stage === 1) return "基线";
  if (stage === 2) return reverse ? "他们的更改" : "你的更改";
  return reverse ? "你的更改" : "他们的更改";
}

/**
 * 构造一个“当前来源不可直接展示文本”的占位结果，统一 binary/tooLarge/missing 三类状态。
 */
function createUnavailableConflictRevision(label: string, patch?: Partial<GitCommitPanelConflictRevision>): GitCommitPanelConflictRevision {
  return {
    label,
    text: "",
    available: false,
    ...patch,
  };
}

/**
 * 统计文本行数；阈值对齐 IDEA `DiffConfig.DELTA_THRESHOLD_SIZE`，用于在进入三路文本 merge 前提前降级超大行数场景。
 */
function countConflictTextLines(text: string): number {
  const value = String(text || "");
  if (!value) return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") lines += 1;
  }
  return lines;
}

/**
 * 按当前仓库的文本 merge 保护阈值判断内容是否过大；同时考虑字节体积与 IDEA 行数阈值，避免构建大 diff 时堆内存暴涨。
 */
function isConflictTextTooLargeForTextMerge(text: string): boolean {
  const value = String(text || "");
  if (!value) return false;
  if (Buffer.byteLength(value, "utf8") > MAX_CONFLICT_TEXT_BYTES) return true;
  return countConflictTextLines(value) > MAX_CONFLICT_TEXT_LINE_COUNT;
}

/**
 * 解析 `git ls-files --resolve-undo` 输出，提取真正的相对路径集合。
 */
export function parseResolvedConflictPaths(stdout: string): string[] {
  const pathSet = new Set<string>();
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    const tabIndex = line.indexOf("\t");
    const rawPath = tabIndex >= 0 ? line.slice(tabIndex + 1) : "";
    const cleanPath = normalizeConflictPath(decodeGitEscapedText(rawPath));
    if (cleanPath) pathSet.add(cleanPath);
  }
  return Array.from(pathSet);
}

/**
 * 判断一个 revision 是否仍可作为文本 merge 输入；缺失 stage 允许按空文本继续，而 binary / tooLarge 必须直接降级。
 */
function canUseConflictRevisionInTextMerge(
  revision: GitCommitPanelConflictRevision,
): boolean {
  return !revision.isBinary && !revision.tooLarge;
}

/**
 * 统一判断单文件冲突是否允许进入应用内三方文本 merge，避免 UI 与 action 入口各自散落 binary / tooLarge 规则。
 */
function canOpenConflictTextMerge(args: {
  base: GitCommitPanelConflictRevision;
  ours: GitCommitPanelConflictRevision;
  theirs: GitCommitPanelConflictRevision;
  working: GitCommitPanelConflictRevision;
}): boolean {
  if (!canUseConflictRevisionInTextMerge(args.base)) return false;
  if (!canUseConflictRevisionInTextMerge(args.ours)) return false;
  if (!canUseConflictRevisionInTextMerge(args.theirs)) return false;
  if (!canUseConflictRevisionInTextMerge(args.working)) return false;
  return args.base.available || args.ours.available || args.theirs.available || args.working.available;
}

/**
 * 把完整冲突来源快照裁剪为 resolver 列表所需的轻量元数据，避免列表层持有整段文本。
 */
function toConflictResolverRevisionMeta(
  revision: GitCommitPanelConflictRevision,
): Omit<GitCommitPanelConflictRevision, "text"> {
  return {
    label: revision.label,
    available: revision.available,
    isBinary: revision.isBinary,
    tooLarge: revision.tooLarge,
  };
}

/**
 * 读取工作区文件的轻量冲突元数据；不要求文件仍处于 unmerged，供 resolved conflict 列表复用。
 */
export async function describeConflictWorkingTreeRevisionAsync(args: {
  repoRoot: string;
  relPath: string;
}): Promise<Omit<GitCommitPanelConflictRevision, "text">> {
  const revision = await readWorkingConflictTextAsync(args.repoRoot, args.relPath);
  return toConflictResolverRevisionMeta(revision);
}

/**
 * 把单文件冲突快照转换为 resolver 列表可直接渲染的条目，补齐是否支持应用内 merge 的判定。
 */
function buildConflictResolverEntry(
  snapshot: Pick<GitCommitPanelConflictMergeSnapshot, "path" | "reverseSides" | "base" | "ours" | "theirs" | "working">,
): GitCommitPanelConflictResolverEntry {
  return {
    path: snapshot.path,
    reverseSides: snapshot.reverseSides === true,
    canOpenMerge: canOpenConflictTextMerge({
      base: snapshot.base,
      ours: snapshot.ours,
      theirs: snapshot.theirs,
      working: snapshot.working,
    }),
    base: toConflictResolverRevisionMeta(snapshot.base),
    ours: toConflictResolverRevisionMeta(snapshot.ours),
    theirs: toConflictResolverRevisionMeta(snapshot.theirs),
    working: toConflictResolverRevisionMeta(snapshot.working),
  };
}

/**
 * 读取 Git `resolve-undo` 真值链返回的已解决冲突文件列表，用于给提交树直接打 resolved 标记。
 */
export async function listResolvedConflictPathsAsync(
  runtime: GitCommitPanelConflictRuntime,
): Promise<string[]> {
  const result = await runtime.runGitExecAsync(["ls-files", "--resolve-undo"], 10_000);
  if (!result.ok) return [];
  return parseResolvedConflictPaths(result.stdout);
}

/**
 * 读取指定 stage 的文本内容；stage 缺失时返回不可用状态而不是抛错，便于 UI 按来源降级展示。
 */
async function readConflictStageTextAsync(
  runtime: GitCommitPanelConflictRuntime,
  relPath: string,
  stage: 1 | 2 | 3,
  reverse: boolean,
): Promise<GitCommitPanelConflictRevision> {
  const label = resolveConflictStageLabel(stage, reverse);
  const sizeResult = await runtime.runGitExecAsync(["cat-file", "-s", `:${stage}:${relPath}`], 8_000);
  if (!sizeResult.ok) return createUnavailableConflictRevision(label);
  const size = Math.max(0, Number.parseInt(String(sizeResult.stdout || "").trim(), 10) || 0);
  if (size > MAX_CONFLICT_TEXT_BYTES) {
    return createUnavailableConflictRevision(label, { tooLarge: true });
  }
  const result = await runtime.runGitExecAsync(["show", `:${stage}:${relPath}`], 12_000);
  if (!result.ok) return createUnavailableConflictRevision(label);
  const text = String(result.stdout || "");
  if (text.includes("\u0000")) {
    return createUnavailableConflictRevision(label, { isBinary: true });
  }
  if (isConflictTextTooLargeForTextMerge(text)) {
    return createUnavailableConflictRevision(label, { tooLarge: true });
  }
  return {
    label,
    text,
    available: true,
  };
}

/**
 * 读取工作区当前文件文本，沿用 Diff 侧的体积与二进制保护阈值。
 */
async function readWorkingConflictTextAsync(
  repoRoot: string,
  relPath: string,
): Promise<GitCommitPanelConflictRevision> {
  const targetAbs = resolveRepoFileAbsolutePath(repoRoot, relPath);
  if (!targetAbs) return createUnavailableConflictRevision("结果");
  try {
    const stats = await fsp.stat(targetAbs);
    if (stats.size > MAX_CONFLICT_TEXT_BYTES) {
      return createUnavailableConflictRevision("结果", { tooLarge: true });
    }
    const buffer = await fsp.readFile(targetAbs);
    if (buffer.includes(0)) {
      return createUnavailableConflictRevision("结果", { isBinary: true });
    }
    const text = buffer.toString("utf8");
    if (isConflictTextTooLargeForTextMerge(text)) {
      return createUnavailableConflictRevision("结果", { tooLarge: true });
    }
    return {
      label: "结果",
      text,
      available: true,
    };
  } catch {
    return createUnavailableConflictRevision("结果");
  }
}

/**
 * 批量读取单文件冲突的四路 revision 元数据；供完整 snapshot 与 resolver 轻量列表共用，避免列表层重复构建整套 merge metadata。
 */
async function readConflictMergeRevisionsAsync(args: {
  runtime: GitCommitPanelConflictRuntime;
  repoRoot: string;
  relPath: string;
  reverse: boolean;
}): Promise<{
  base: GitCommitPanelConflictRevision;
  ours: GitCommitPanelConflictRevision;
  theirs: GitCommitPanelConflictRevision;
  working: GitCommitPanelConflictRevision;
}> {
  const [base, ours, theirs, working] = await Promise.all([
    readConflictStageTextAsync(args.runtime, args.relPath, 1, args.reverse),
    readConflictStageTextAsync(args.runtime, args.relPath, 2, args.reverse),
    readConflictStageTextAsync(args.runtime, args.relPath, 3, args.reverse),
    readWorkingConflictTextAsync(args.repoRoot, args.relPath),
  ]);
  return {
    base,
    ours,
    theirs,
    working,
  };
}

/**
 * 读取指定文件的冲突快照，包含 base/ours/theirs/index 外的工作区当前内容，供应用内 merge 对话框使用。
 */
export async function getConflictMergeSnapshotAsync(args: {
  runtime: GitCommitPanelConflictRuntime;
  repoRoot: string;
  relPath: string;
  reverse?: boolean;
}): Promise<{ ok: true; snapshot: GitCommitPanelConflictMergeSnapshot } | { ok: false; error: string }> {
  const relPath = normalizeConflictPath(args.relPath);
  if (!relPath) return { ok: false, error: "缺少冲突文件路径" };
  const reverse = args.reverse === true;

  const unmergedResult = await args.runtime.runGitExecAsync(["ls-files", "--unmerged", "--", relPath], 8_000);
  if (!unmergedResult.ok) {
    return {
      ok: false,
      error: String(unmergedResult.stderr || unmergedResult.error || "读取冲突文件失败").trim() || "读取冲突文件失败",
    };
  }
  if (!String(unmergedResult.stdout || "").trim()) {
    return { ok: false, error: "当前文件已不再处于未解决冲突状态" };
  }

  const {
    base,
    ours,
    theirs,
    working,
  } = await readConflictMergeRevisionsAsync({
    runtime: args.runtime,
    repoRoot: args.repoRoot,
    relPath,
    reverse,
  });
  const merge = buildConflictMergeMetadata({
    path: relPath,
    baseText: base.text,
    oursText: ours.text,
    theirsText: theirs.text,
  });

  return {
    ok: true,
    snapshot: {
      path: relPath,
      reverseSides: reverse,
      base,
      ours,
      theirs,
      working,
      merge,
    },
  };
}

/**
 * 批量读取 resolver 列表所需的冲突元数据，让前端能一次性展示 binary/过大/可否应用内 merge。
 */
export async function describeConflictResolverEntriesAsync(args: {
  runtime: GitCommitPanelConflictRuntime;
  repoRoot: string;
  relPaths: string[];
  reverse?: boolean;
}): Promise<GitCommitPanelConflictResolverEntry[]> {
  const relPaths = Array.from(new Set(args.relPaths.map((one) => normalizeConflictPath(one)).filter(Boolean)));
  if (relPaths.length <= 0) return [];
  const reverse = args.reverse === true;
  const results = await Promise.all(relPaths.map(async (relPath) => {
    const unmergedResult = await args.runtime.runGitExecAsync(["ls-files", "--unmerged", "--", relPath], 8_000);
    if (!unmergedResult.ok || !String(unmergedResult.stdout || "").trim()) return null;
    const revisions = await readConflictMergeRevisionsAsync({
      runtime: args.runtime,
      repoRoot: args.repoRoot,
      relPath,
      reverse,
    });
    return buildConflictResolverEntry({
      path: relPath,
      reverseSides: reverse,
      base: revisions.base,
      ours: revisions.ours,
      theirs: revisions.theirs,
      working: revisions.working,
    });
  }));
  return results.filter((item): item is GitCommitPanelConflictResolverEntry => !!item);
}

/**
 * 把 UI 语义的 ours/theirs 解析为真实 Git checkout stage 选项，兼容 rebase 的 sides 反转语义。
 */
function resolveConflictCheckoutFlag(
  side: "ours" | "theirs",
  reverse: boolean,
): "--ours" | "--theirs" {
  if (side === "ours") return reverse ? "--theirs" : "--ours";
  return reverse ? "--ours" : "--theirs";
}

/**
 * 批量采用 ours/theirs 并重新加入索引，补齐接近 IDEA `GitConflictResolver` 的快速处理动作。
 */
export async function applyConflictResolverSideAsync(args: {
  runtime: GitCommitPanelConflictResolverRuntime;
  repoRoot: string;
  relPaths: string[];
  side: "ours" | "theirs";
  reverse?: boolean;
}): Promise<{ ok: true; appliedPaths: string[] } | { ok: false; error: string }> {
  const relPaths = Array.from(new Set(args.relPaths.map((one) => normalizeConflictPath(one)).filter(Boolean)));
  if (relPaths.length <= 0) return { ok: false, error: "缺少冲突文件路径" };
  const checkoutFlag = resolveConflictCheckoutFlag(args.side, args.reverse === true);
  const checkoutRes = await args.runtime.runGitSpawnAsync(["checkout", checkoutFlag, "--", ...relPaths], 120_000);
  if (!checkoutRes.ok) {
    return {
      ok: false,
      error: String(checkoutRes.stderr || checkoutRes.error || `采用 ${args.side} 失败`).trim() || `采用 ${args.side} 失败`,
    };
  }
  const addRes = await args.runtime.runGitSpawnAsync(["add", "--", ...relPaths], 120_000);
  if (!addRes.ok) {
    return {
      ok: false,
      error: String(addRes.stderr || addRes.error || "标记冲突为已解决失败").trim() || "标记冲突为已解决失败",
    };
  }
  return {
    ok: true,
    appliedPaths: relPaths,
  };
}
