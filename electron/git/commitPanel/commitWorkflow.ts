// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { promises as fsp } from "node:fs";
import path from "node:path";
import { toFsPathKey } from "../pathKey";
import {
  cleanupPreparedCommitIndexAsync,
  prepareCommitIndexAsync,
  resolveCommitSelectionItems,
  restorePreparedCommitIndexAsync,
  type NormalizedCommitSelectionItem,
} from "./partialCommit";
import { resolveGitStagedSaverStrategy } from "./stagedSaverStrategy";
import { parseStatusPorcelainV2Z } from "./statusModel";

type CommitWorkflowDependencies<GitCtx, GitExecResult> = {
  hasUnmergedFilesAsync: (ctx: GitCtx, repoRoot: string) => Promise<boolean>;
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
  writeTempGitFileAsync: (ctx: GitCtx, prefix: string, content: string) => Promise<string>;
  toGitErrorMessage: (res: GitExecResult, fallback: string) => string;
  formatGitAuthorDate: (input: any) => string | undefined;
  resolveDefaultAuthorAsync?: (ctx: GitCtx, repoRoot: string) => Promise<string>;
  getHeadInfoAsync?: (
    ctx: GitCtx,
    repoRoot: string,
  ) => Promise<{ branch?: string; detached?: boolean; headSha?: string }>;
  getRepositoryOperationStateAsync?: (ctx: GitCtx, repoRoot: string) => Promise<string>;
};

const RENAME_COMMIT_MESSAGE_PREFIX = "文件移动";
const LARGE_FILE_WARNING_THRESHOLD_BYTES = 10 * 1024 * 1024;
const CRLF_SCAN_MAX_BYTES = 1024 * 1024;
const WINDOWS_INVALID_CHARS = "<>:\"\\|?*";
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

type CommitWorkflowCheck = {
  id: string;
  level: "error" | "warning" | "info";
  message: string;
  blocking: boolean;
  confirmationRequired?: boolean;
};

/**
 * 统一规整 commit workflow 的动作意图，兼容旧版仅传 `pushAfter` 的载荷。
 */
function resolveCommitWorkflowIntent(payload: any): "commit" | "commitAndPush" {
  const explicitIntent = String(payload?.intent || "").trim();
  if (explicitIntent === "commit" || explicitIntent === "commitAndPush") return explicitIntent;
  return payload?.pushAfter === true ? "commitAndPush" : "commit";
}

/**
 * 解析当前提交流程的特殊提交模式；fixup/squash 会复用同一套 selection 真相源。
 */
function resolveCommitMode(payload: any): { type: "normal" } | { type: "fixup" | "squash"; target: string } {
  const mode = String(payload?.commitMode || payload?.options?.commitMode || "").trim();
  const target = String(payload?.targetHash || payload?.options?.targetHash || "").trim();
  if ((mode === "fixup" || mode === "squash") && target) {
    return {
      type: mode,
      target,
    };
  }
  return { type: "normal" };
}

/**
 * 把提交说明裁剪成稳定的首行 subject，供“文件移动单独提交”场景复用。
 */
function resolveCommitSubject(message: string): string {
  const subject = String(message || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return subject || "更新文件移动";
}

/**
 * 为“文件移动单独提交”构造附加提交说明，和主提交正文保持可读关联。
 */
function buildRenameCommitMessage(message: string): string {
  return `${RENAME_COMMIT_MESSAGE_PREFIX}: ${resolveCommitSubject(message)}`;
}

/**
 * 从 `git diff --name-status -z` 输出里提取 rename 的新路径集合，兼容“状态与首个路径同 token”两种 Git 输出形态。
 */
function parseRenamedPaths(stdout: string): Set<string> {
  const parts = String(stdout || "").split("\0");
  const renamedPaths = new Set<string>();
  let index = 0;
  while (index < parts.length) {
    const token = String(parts[index++] || "");
    if (!token) continue;
    const tabIndex = token.indexOf("\t");
    const status = (tabIndex >= 0 ? token.slice(0, tabIndex) : token).trim();
    const firstPath = tabIndex >= 0 ? token.slice(tabIndex + 1).trim() : "";
    const code = status[0] || "";
    if (code !== "R" && code !== "C") {
      if (!firstPath) index += 1;
      continue;
    }
    const oldPath = firstPath || String(parts[index++] || "").trim();
    if (!oldPath) continue;
    const nextPath = String(parts[index++] || "").trim();
    if (nextPath) renamedPaths.add(nextPath);
  }
  return renamedPaths;
}

/**
 * 通过一次“准备索引但不提交”的探测流程识别 rename 选区，确保未暂存移动也能被稳定识别。
 */
async function collectRenamedSelectionPathsAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  selections: NormalizedCommitSelectionItem[],
  strategy: ReturnType<typeof resolveGitStagedSaverStrategy>,
  dependencies: CommitWorkflowDependencies<GitCtx, GitExecResult>,
): Promise<{ ok: true; paths: Set<string> } | { ok: false; error: string }> {
  const selectedPathSet = new Set(selections.map((item) => String(item.path || "").trim()).filter(Boolean));
  if (selectedPathSet.size === 0) return { ok: true, paths: new Set<string>() };
  const explicitRenamePaths = new Set(
    selections
      .filter((item) => !!item.oldPath && item.oldPath !== item.path)
      .map((item) => item.path),
  );
  if (explicitRenamePaths.size > 0) return { ok: true, paths: explicitRenamePaths };

  const prepareRes = await prepareCommitIndexAsync(ctx, repoRoot, selections, strategy, {
    runGitSpawnAsync: dependencies.runGitSpawnAsync,
    runGitExecAsync: dependencies.runGitExecAsync,
    toGitErrorMessage: dependencies.toGitErrorMessage,
  });
  if (!prepareRes.ok) return prepareRes;

  let renamedPaths = new Set<string>();
  let probeError = "";
  try {
    const diffRes = await dependencies.runGitExecAsync(
      ctx,
      repoRoot,
      ["diff", "--cached", "--name-status", "-z", "-M", "--find-renames=50%"],
      20_000,
    );
    if (!diffRes.ok) {
      probeError = dependencies.toGitErrorMessage(diffRes, "识别文件移动失败");
    } else {
      renamedPaths = new Set(
        Array.from(parseRenamedPaths(String(diffRes.stdout || ""))).filter((path) => selectedPathSet.has(path)),
      );
    }
  } finally {
    const restoreRes = await restorePreparedCommitIndexAsync(ctx, repoRoot, prepareRes.state, {
      runGitSpawnAsync: dependencies.runGitSpawnAsync,
      runGitExecAsync: dependencies.runGitExecAsync,
      toGitErrorMessage: dependencies.toGitErrorMessage,
    }, "failure");
    await cleanupPreparedCommitIndexAsync(prepareRes.state);
    if (!restoreRes.ok && !probeError) probeError = restoreRes.error;
  }
  if (probeError) return { ok: false, error: probeError };
  return { ok: true, paths: renamedPaths };
}

/**
 * 按 rename 路径集合拆分本次提交选区，供“文件移动单独提交”双提交流程复用。
 */
function splitSelectionsForRenameCommit(
  selections: NormalizedCommitSelectionItem[],
  renamedPaths: Set<string>,
): { renameSelections: NormalizedCommitSelectionItem[]; remainingSelections: NormalizedCommitSelectionItem[] } {
  const renameSelections: NormalizedCommitSelectionItem[] = [];
  const remainingSelections: NormalizedCommitSelectionItem[] = [];
  for (const item of selections) {
    if (renamedPaths.has(item.path)) renameSelections.push(item);
    else remainingSelections.push(item);
  }
  return {
    renameSelections,
    remainingSelections,
  };
}

/**
 * 用子选区重建提交 payload，确保兼容旧字段与当前 selection 真相源。
 */
function buildCommitPayloadForSelections(
  payload: any,
  selections: NormalizedCommitSelectionItem[],
  message: string,
  intent: "commit" | "commitAndPush",
): any {
  const pushAfter = intent === "commitAndPush";
  const includedItems = selections.map((item) => ({
    repoRoot: item.repoRoot,
    path: item.path,
    oldPath: item.oldPath,
    kind: item.kind,
  }));
  return {
    ...payload,
    message,
    intent,
    pushAfter,
    selections,
    includedItems,
    files: selections.map((item) => item.path),
    commitRenamesSeparately: false,
    options: {
      ...(payload?.options || {}),
      commitRenamesSeparately: false,
    },
  };
}

/**
 * 按仓库根保持首出现顺序分组 selection，供多仓提交按根依次执行并汇总结果。
 */
function groupSelectionsByRepoRoot(
  selections: NormalizedCommitSelectionItem[],
): Array<{ repoRoot: string; selections: NormalizedCommitSelectionItem[] }> {
  const order: string[] = [];
  const grouped = new Map<string, { repoRoot: string; selections: NormalizedCommitSelectionItem[] }>();
  for (const selection of selections) {
    const repoRoot = String(selection.repoRoot || "").trim();
    if (!repoRoot) continue;
    const repoRootKey = toFsPathKey(repoRoot);
    const current = grouped.get(repoRootKey);
    if (current) {
      current.selections.push(selection);
      continue;
    }
    grouped.set(repoRootKey, {
      repoRoot,
      selections: [selection],
    });
    order.push(repoRootKey);
  }
  return order.map((repoRootKey) => grouped.get(repoRootKey)!).filter(Boolean);
}

/**
 * 构造统一的提交检查对象，供主进程返回给前端统一展示与确认。
 */
function buildCommitWorkflowCheck(args: {
  id: string;
  level: "error" | "warning" | "info";
  message: string;
  blocking?: boolean;
  confirmationRequired?: boolean;
}): CommitWorkflowCheck {
  return {
    id: args.id,
    level: args.level,
    message: args.message,
    blocking: args.blocking === true,
    confirmationRequired: args.confirmationRequired === true,
  };
}

/**
 * 把前端已确认的 warning ID 规整为集合，避免一次提交里重复触发相同确认。
 */
function normalizeConfirmedCommitCheckIds(payload: any): Set<string> {
  return new Set<string>(
    (Array.isArray(payload?.confirmedChecks) ? payload.confirmedChecks : [])
      .map((item: unknown) => String(item || "").trim())
      .filter((item: string): item is string => item.length > 0),
  );
}

/**
 * 把路径数组压缩成简洁摘要，避免 warning 提示被大批文件名撑爆。
 */
function formatCommitCheckPathPreview(paths: string[], limit: number = 3): string {
  const normalized = Array.from(new Set(
    paths
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
  const preview = normalized.slice(0, limit).join("、");
  if (!preview) return "";
  return normalized.length > limit ? `${preview} 等 ${normalized.length} 个文件` : preview;
}

/**
 * 判断路径里是否包含对 Windows 不友好的文件名片段，对齐 bad file name warning 的基础语义。
 */
function hasBadWindowsFileName(pathText: string): boolean {
  const segments = String(pathText || "").replace(/\\/g, "/").split("/").filter(Boolean);
  for (const segment of segments) {
    const dotIndex = segment.indexOf(".");
    const baseName = dotIndex >= 0 ? segment.slice(0, dotIndex) : segment;
    if (baseName.length >= 3 && baseName.length <= 4 && WINDOWS_RESERVED_NAMES.has(baseName.toUpperCase()))
      return true;
    if (Array.from(segment).some((char) => char.charCodeAt(0) <= 31 || WINDOWS_INVALID_CHARS.includes(char)))
      return true;
  }
  return false;
}

/**
 * 用轻量二进制探测跳过明显的二进制文件，避免 CRLF warning 误扫不可读内容。
 */
function isProbablyTextBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8_192);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return false;
  }
  return true;
}

/**
 * 扫描单仓选中文件的文件名/大文件/CRLF 风险，供 commit.create 的统一 precheck 复用。
 */
async function collectCommitWorkflowPathWarningsAsync(
  repoRoot: string,
  paths: string[],
): Promise<{
  badFileNamePaths: string[];
  largeFilePaths: string[];
  crlfPaths: string[];
}> {
  const badFileNamePaths = new Set<string>();
  const largeFilePaths = new Set<string>();
  const crlfPaths = new Set<string>();
  for (const rawPath of paths) {
    const normalizedPath = String(rawPath || "").trim().replace(/\\/g, "/");
    if (!normalizedPath) continue;
    if (hasBadWindowsFileName(normalizedPath)) badFileNamePaths.add(normalizedPath);

    const absolutePath = path.resolve(repoRoot, ...normalizedPath.split("/"));
    let stat: Awaited<ReturnType<typeof fsp.stat>> | null = null;
    try {
      stat = await fsp.stat(absolutePath);
    } catch {
      stat = null;
    }
    if (!stat?.isFile()) continue;
    if (stat.size > LARGE_FILE_WARNING_THRESHOLD_BYTES) largeFilePaths.add(normalizedPath);
    if (stat.size <= 0 || stat.size > CRLF_SCAN_MAX_BYTES) continue;
    try {
      const content = await fsp.readFile(absolutePath);
      if (!isProbablyTextBuffer(content)) continue;
      if (content.indexOf("\r\n") >= 0) crlfPaths.add(normalizedPath);
    } catch {}
  }
  return {
    badFileNamePaths: [...badFileNamePaths],
    largeFilePaths: [...largeFilePaths],
    crlfPaths: [...crlfPaths],
  };
}

/**
 * 在真正执行 Git 提交前运行统一 precheck，把阻塞错误与需确认 warning 都结构化返回给上层。
 */
export async function precheckCommitWorkflowAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  payload: any,
  dependencies: CommitWorkflowDependencies<GitCtx, GitExecResult>,
): Promise<CommitWorkflowCheck[]> {
  const checks: CommitWorkflowCheck[] = [];
  const selections = resolveCommitSelectionItems(repoRoot, payload);
  const groupedSelections = groupSelectionsByRepoRoot(selections);
  const targetGroups = groupedSelections.length > 0 ? groupedSelections : [{ repoRoot, selections: [] as NormalizedCommitSelectionItem[] }];
  const confirmedCheckIds = normalizeConfirmedCommitCheckIds(payload);
  const explicitAuthor = String(payload?.author || payload?.options?.author || "").trim();
  if (!explicitAuthor && dependencies.resolveDefaultAuthorAsync) {
    const defaultAuthor = String(await dependencies.resolveDefaultAuthorAsync(ctx, repoRoot) || "").trim();
    if (!defaultAuthor) {
      checks.push(buildCommitWorkflowCheck({
        id: "author-missing",
        level: "error",
        blocking: true,
        message: "未配置默认作者，请先设置 Git user.name / user.email，或在提交选项里填写作者。",
      }));
    }
  }

  for (const group of targetGroups) {
    const currentRepoRoot = String(group.repoRoot || "").trim();
    if (!currentRepoRoot) continue;
    const repoLabel = path.basename(currentRepoRoot) || currentRepoRoot;
    if (await dependencies.hasUnmergedFilesAsync(ctx, currentRepoRoot)) {
      checks.push(buildCommitWorkflowCheck({
        id: "unresolved-conflicts",
        level: "error",
        blocking: true,
        message: `仓库 ${repoLabel} 仍有未解决冲突，请先完成冲突处理后再提交。`,
      }));
    }

    const operationState = dependencies.getRepositoryOperationStateAsync
      ? String(await dependencies.getRepositoryOperationStateAsync(ctx, currentRepoRoot) || "").trim()
      : "";
    const headInfo = dependencies.getHeadInfoAsync
      ? await dependencies.getHeadInfoAsync(ctx, currentRepoRoot)
      : { detached: false };
    if (headInfo?.detached) {
      if (operationState === "rebasing" && !confirmedCheckIds.has("commit-during-rebase")) {
        checks.push(buildCommitWorkflowCheck({
          id: "commit-during-rebase",
          level: "warning",
          confirmationRequired: true,
          message: `仓库 ${repoLabel} 当前处于 Rebase 过程中的 Detached HEAD，继续提交可能改变后续 Rebase 流程。`,
        }));
      } else if (operationState !== "rebasing" && !confirmedCheckIds.has("detached-head")) {
        checks.push(buildCommitWorkflowCheck({
          id: "detached-head",
          level: "warning",
          confirmationRequired: true,
          message: `仓库 ${repoLabel} 当前处于 Detached HEAD，继续提交会生成游离提交。`,
        }));
      }
    }

    const selectedPaths = Array.from(new Set(
      group.selections
        .map((item) => String(item.path || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ));
    if (selectedPaths.length <= 0) continue;
    const warnings = await collectCommitWorkflowPathWarningsAsync(currentRepoRoot, selectedPaths);
    if (warnings.badFileNamePaths.length > 0 && !confirmedCheckIds.has("bad-file-name")) {
      checks.push(buildCommitWorkflowCheck({
        id: "bad-file-name",
        level: "warning",
        confirmationRequired: true,
        message: `仓库 ${repoLabel} 包含对 Windows 不友好的文件名：${formatCommitCheckPathPreview(warnings.badFileNamePaths)}。`,
      }));
    }
    if (warnings.largeFilePaths.length > 0 && !confirmedCheckIds.has("large-file")) {
      checks.push(buildCommitWorkflowCheck({
        id: "large-file",
        level: "warning",
        confirmationRequired: true,
        message: `仓库 ${repoLabel} 含有大文件（>${Math.floor(LARGE_FILE_WARNING_THRESHOLD_BYTES / 1024 / 1024)} MiB）：${formatCommitCheckPathPreview(warnings.largeFilePaths)}。`,
      }));
    }
    if (warnings.crlfPaths.length > 0 && !confirmedCheckIds.has("crlf")) {
      checks.push(buildCommitWorkflowCheck({
        id: "crlf",
        level: "warning",
        confirmationRequired: true,
        message: `仓库 ${repoLabel} 检测到 CRLF 行尾文件：${formatCommitCheckPathPreview(warnings.crlfPaths)}。`,
      }));
    }
  }
  return checks;
}

/**
 * 判断当前仓库是否处于 merge 中，供提交前的 merge exclusion 兜底校验复用。
 */
async function isRepositoryMergingAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  dependencies: CommitWorkflowDependencies<GitCtx, GitExecResult>,
): Promise<boolean> {
  const mergeHeadPathRes = await dependencies.runGitExecAsync(ctx, repoRoot, ["rev-parse", "--git-path", "MERGE_HEAD"], 5_000);
  if (!mergeHeadPathRes.ok) return false;
  const mergeHeadPathText = String(mergeHeadPathRes.stdout || "").trim();
  if (!mergeHeadPathText) return false;
  const mergeHeadPath = path.isAbsolute(mergeHeadPathText)
    ? mergeHeadPathText
    : path.resolve(repoRoot, mergeHeadPathText);
  try {
    const stat = await fsp.stat(mergeHeadPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 判断 merge 中是否还有本仓 tracked changes 被排除在本次提交之外，贴近 IDEA 的 excluded-changes precheck。
 */
async function hasExcludedMergeChangesAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  payload: any,
  selections: NormalizedCommitSelectionItem[],
  dependencies: CommitWorkflowDependencies<GitCtx, GitExecResult>,
): Promise<boolean> {
  if (payload?.mergeExclusionConfirmed === true) return false;
  const includedTrackedPaths = new Set(
    selections
      .filter((item) => item.kind === "change")
      .map((item) => String(item.path || "").trim())
      .filter(Boolean),
  );
  if (includedTrackedPaths.size <= 0) return false;
  if (!await isRepositoryMergingAsync(ctx, repoRoot, dependencies)) return false;

  const statusRes = await dependencies.runGitExecAsync(ctx, repoRoot, ["status", "--porcelain=v2", "-z"], 12_000);
  if (!statusRes.ok) return false;
  const trackedEntries = parseStatusPorcelainV2Z(String(statusRes.stdout || ""))
    .filter((entry) => !entry.ignored && !entry.untracked);
  return trackedEntries.some((entry) => !includedTrackedPaths.has(String(entry.path || "").trim()));
}

/**
 * 执行单个仓库根下的提交流程，统一复用 rename 拆分、partial commit 与恢复索引逻辑。
 */
async function executeRepoCommitWorkflowAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  payload: any,
  dependencies: CommitWorkflowDependencies<GitCtx, GitExecResult>,
  selections: NormalizedCommitSelectionItem[],
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const message = String(payload?.message || "").trim();
  const commitMode = resolveCommitMode(payload);
  const amend = payload?.amend === true || payload?.options?.amend === true;
  const selectedScopes = Array.from(new Set(selections.map((item) => item.path).filter(Boolean)));
  if (selectedScopes.length === 0 && !amend) return { ok: false, error: "未选择需要提交的变更" };

  const hasUnmerged = await dependencies.hasUnmergedFilesAsync(ctx, repoRoot);
  if (hasUnmerged) return { ok: false, error: "存在未解决冲突文件，请先解决后再提交" };
  if (await hasExcludedMergeChangesAsync(ctx, repoRoot, payload, selections, dependencies)) {
    return {
      ok: false,
      error: "当前仓库仍有 Merge 变更未纳入本次提交，请确认后重试",
      data: {
        mergeExclusionRequired: true,
      },
    };
  }

  const commitRenamesSeparately = payload?.commitRenamesSeparately === true || payload?.options?.commitRenamesSeparately === true;
  const stagedSaverStrategy = resolveGitStagedSaverStrategy(payload);
  if (commitRenamesSeparately && commitMode.type === "normal" && !amend) {
    const renamedPathsRes = await collectRenamedSelectionPathsAsync(ctx, repoRoot, selections, stagedSaverStrategy, dependencies);
    if (!renamedPathsRes.ok) return renamedPathsRes;
    const { renameSelections, remainingSelections } = splitSelectionsForRenameCommit(selections, renamedPathsRes.paths);
    if (renameSelections.length > 0 && remainingSelections.length > 0) {
      const renamePayload = buildCommitPayloadForSelections(payload, renameSelections, buildRenameCommitMessage(message), "commit");
      const renameCommitRes = await executeSingleCommitWorkflowAsync(ctx, repoRoot, renamePayload, dependencies, renameSelections);
      if (!renameCommitRes.ok) return renameCommitRes;

      const mainPayload = buildCommitPayloadForSelections(payload, remainingSelections, message, resolveCommitWorkflowIntent(payload));
      const mainCommitRes = await executeSingleCommitWorkflowAsync(ctx, repoRoot, mainPayload, dependencies, remainingSelections);
      if (!mainCommitRes.ok) {
        return {
          ok: false,
          error: `文件移动已单独提交，但主提交失败：${String(mainCommitRes.error || "提交失败")}`,
          data: {
            renameCommitHash: renameCommitRes.data?.commitHash,
          },
        };
      }

      return {
        ok: true,
        data: {
          ...mainCommitRes.data,
          commitHash: mainCommitRes.data?.commitHash,
          includedPaths: selectedScopes,
          selectionCount: selections.length,
          renameCommitHash: renameCommitRes.data?.commitHash,
        },
      };
    }
  }

  return await executeSingleCommitWorkflowAsync(ctx, repoRoot, payload, dependencies, selections);
}

/**
 * 读取目标提交的 subject，供 squash 默认消息生成使用。
 */
async function loadCommitSubjectAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  target: string,
  dependencies: CommitWorkflowDependencies<GitCtx, GitExecResult>,
): Promise<string> {
  const res = await dependencies.runGitExecAsync(ctx, repoRoot, ["log", "-1", "--format=%s", target], 10_000);
  if (!res.ok) return target.slice(0, 8);
  return String(res.stdout || "").trim() || target.slice(0, 8);
}

/**
 * 按提交模式生成真正的 `git commit` 参数；normal/fixup/squash 共用同一套 path selection。
 */
async function buildCommitArgvAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  payload: any,
  messageFile: string | undefined,
  dependencies: CommitWorkflowDependencies<GitCtx, GitExecResult>,
): Promise<string[]> {
  const commitMode = resolveCommitMode(payload);
  if (commitMode.type === "fixup") {
    return ["commit", `--fixup=${commitMode.target}`];
  }
  if (commitMode.type === "squash") {
    const argv = ["commit", `--squash=${commitMode.target}`];
    if (messageFile) argv.push("-F", messageFile);
    else {
      const subject = await loadCommitSubjectAsync(ctx, repoRoot, commitMode.target, dependencies);
      argv.push("-m", `squash! ${subject}`);
    }
    return argv;
  }

  const amend = payload?.amend === true || payload?.options?.amend === true;
  const signOff = payload?.signOff === true || payload?.options?.signOff === true;
  const skipHooks = payload?.skipHooks === true || payload?.options?.skipHooks === true;
  const cleanupMessage = payload?.cleanupMessage === true || payload?.options?.cleanupMessage === true;
  const author = String(payload?.author || payload?.options?.author || "").trim();
  const authorDate = dependencies.formatGitAuthorDate(payload?.authorDate ?? payload?.options?.authorDate);
  const argv: string[] = ["commit"];
  if (amend) argv.push("--amend");
  if (signOff) argv.push("--signoff");
  if (skipHooks) argv.push("--no-verify");
  if (cleanupMessage) argv.push("--cleanup=strip");
  if (author) argv.push(`--author=${author}`);
  if (authorDate) argv.push("--date", authorDate);
  if (messageFile) argv.push("-F", messageFile);
  return argv;
}

/**
 * 执行单次提交流程，统一处理 selection、partial commit、fixup/squash 与暂存区恢复。
 */
async function executeSingleCommitWorkflowAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  payload: any,
  dependencies: CommitWorkflowDependencies<GitCtx, GitExecResult>,
  selections: NormalizedCommitSelectionItem[],
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const message = String(payload?.message || "").trim();
  const commitMode = resolveCommitMode(payload);
  const selectedScopes = Array.from(new Set(selections.map((item) => item.path).filter(Boolean)));
  const stagedSaverStrategy = resolveGitStagedSaverStrategy(payload);

  const prepareRes = await prepareCommitIndexAsync(ctx, repoRoot, selections, stagedSaverStrategy, {
    runGitSpawnAsync: dependencies.runGitSpawnAsync,
    runGitExecAsync: dependencies.runGitExecAsync,
    toGitErrorMessage: dependencies.toGitErrorMessage,
  });
  if (!prepareRes.ok) return { ok: false, error: prepareRes.error };

  const preparedIndex = prepareRes.state;
  let commitFailedMessage = "";
  let restoreFailedMessage = "";
  let commitHash: string | undefined;
  let messageFile = "";
  let commitSucceeded = false;

  try {
    if (commitMode.type === "normal") {
      messageFile = await dependencies.writeTempGitFileAsync(ctx, "git-commit-msg", message);
    } else if (commitMode.type === "squash" && message) {
      messageFile = await dependencies.writeTempGitFileAsync(ctx, "git-squash-msg", message);
    }

    if (!commitFailedMessage) {
      const argv = await buildCommitArgvAsync(ctx, repoRoot, payload, messageFile || undefined, dependencies);
      const commitRes = await dependencies.runGitSpawnAsync(ctx, repoRoot, argv, 120_000);
      if (!commitRes.ok) {
        commitFailedMessage = dependencies.toGitErrorMessage(commitRes, commitMode.type === "normal"
          ? "提交失败"
          : commitMode.type === "fixup"
            ? "创建 Fixup 提交失败"
            : "创建 Squash 提交失败");
      } else {
        commitSucceeded = true;
        const headRes = await dependencies.runGitExecAsync(ctx, repoRoot, ["rev-parse", "HEAD"], 5000);
        commitHash = headRes.ok ? String(headRes.stdout || "").trim() : undefined;
      }
    }
  } catch (error: any) {
    commitFailedMessage = String(error?.message || error || "").trim() || "提交失败";
  } finally {
    if (messageFile) {
      try {
        await fsp.rm(messageFile, { force: true });
      } catch {}
    }
    const restoreRes = commitSucceeded
      ? await restorePreparedCommitIndexAsync(ctx, repoRoot, preparedIndex, {
          runGitSpawnAsync: dependencies.runGitSpawnAsync,
          runGitExecAsync: dependencies.runGitExecAsync,
          toGitErrorMessage: dependencies.toGitErrorMessage,
        }, "success")
      : await restorePreparedCommitIndexAsync(ctx, repoRoot, preparedIndex, {
          runGitSpawnAsync: dependencies.runGitSpawnAsync,
          runGitExecAsync: dependencies.runGitExecAsync,
          toGitErrorMessage: dependencies.toGitErrorMessage,
        }, "failure");
    if (!restoreRes.ok) restoreFailedMessage = String(restoreRes.error || "未知错误");
    await cleanupPreparedCommitIndexAsync(preparedIndex);
  }

  if (commitFailedMessage && restoreFailedMessage) {
    return { ok: false, error: `${commitFailedMessage}（恢复暂存区失败：${restoreFailedMessage}）` };
  }
  if (commitFailedMessage) return { ok: false, error: commitFailedMessage };
  if (restoreFailedMessage) return { ok: false, error: `提交成功，但恢复暂存区失败：${restoreFailedMessage}`, data: { commitHash } };

  return {
    ok: true,
    data: {
      commitHash,
      includedPaths: selectedScopes,
      selectionCount: selections.length,
    },
  };
}

/**
 * 为成功的提交结果补齐 push-after-commit 上下文，供前端按后端决策继续打开 push 预览或切仓续推。
 */
function attachPushAfterCommitContext(
  result: { ok: boolean; data?: any; error?: string },
  pushAfter: boolean,
  fallbackRepoRoots: string[],
): { ok: boolean; data?: any; error?: string } {
  if (!result.ok || !pushAfter) return result;
  const repoRoots = Array.from(new Set(
    (Array.isArray(result.data?.repoRoots) && result.data.repoRoots.length > 0
      ? result.data.repoRoots
      : fallbackRepoRoots)
      .map((item: unknown) => String(item || "").trim())
      .filter((item: string): item is string => item.length > 0),
  ));
  const commitHashes = Array.isArray(result.data?.commitHashes) && result.data.commitHashes.length > 0
    ? result.data.commitHashes
      .map((item: { repoRoot?: unknown; commitHash?: unknown }) => ({
        repoRoot: String(item?.repoRoot || "").trim(),
        commitHash: String(item?.commitHash || "").trim(),
      }))
      .filter((item: { repoRoot: string; commitHash: string }): item is { repoRoot: string; commitHash: string } => !!item.repoRoot && !!item.commitHash)
    : (() => {
        const singleCommitHash = String(result.data?.commitHash || "").trim();
        return singleCommitHash && repoRoots[0]
          ? [{ repoRoot: repoRoots[0], commitHash: singleCommitHash }]
          : [];
      })();
  return {
    ...result,
    data: {
      ...(result.data || {}),
      pushAfterCommit: {
        repoRoots,
        commitHashes,
        targetHash: commitHashes[0]?.commitHash,
      },
    },
  };
}

/**
 * 执行提交 workflow，统一处理 selection、partial commit、fixup/squash、暂存区恢复与 push-after-commit 上下文。
 */
export async function executeCommitWorkflowAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; stderr?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  payload: any,
  dependencies: CommitWorkflowDependencies<GitCtx, GitExecResult>,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const message = String(payload?.message || "").trim();
  const intent = resolveCommitWorkflowIntent(payload);
  const commitMode = resolveCommitMode(payload);
  const amend = payload?.amend === true || payload?.options?.amend === true;
  if (commitMode.type === "normal" && !message) return { ok: false, error: "提交信息不能为空" };

  const selections = resolveCommitSelectionItems(repoRoot, payload);
  const groupedSelections = groupSelectionsByRepoRoot(selections);
  if (groupedSelections.length === 0) {
    if (!amend) return { ok: false, error: "未选择需要提交的变更" };
    return attachPushAfterCommitContext(
      await executeSingleCommitWorkflowAsync(ctx, repoRoot, payload, dependencies, []),
      intent === "commitAndPush",
      [repoRoot],
    );
  }

  if (groupedSelections.length === 1) {
    const singleGroup = groupedSelections[0]!;
    return attachPushAfterCommitContext(
      await executeRepoCommitWorkflowAsync(ctx, singleGroup.repoRoot, payload, dependencies, singleGroup.selections),
      intent === "commitAndPush",
      [singleGroup.repoRoot],
    );
  }

  const completedResults: Array<{ repoRoot: string; data?: any }> = [];
  for (const group of groupedSelections) {
    const repoPayload = buildCommitPayloadForSelections(payload, group.selections, message, intent);
    const repoResult = await executeRepoCommitWorkflowAsync(ctx, group.repoRoot, repoPayload, dependencies, group.selections);
    if (!repoResult.ok) {
      if (completedResults.length === 0) return repoResult;
      const completedRepoRoots = completedResults.map((item) => item.repoRoot);
      const commitHashes = completedResults
        .map((item) => ({
          repoRoot: item.repoRoot,
          commitHash: String(item.data?.commitHash || "").trim(),
        }))
        .filter((item) => !!item.commitHash);
      const includedPaths = Array.from(new Set(completedResults.flatMap((item) => item.data?.includedPaths || [])));
      const selectionCount = completedResults.reduce((sum, item) => sum + Number(item.data?.selectionCount || 0), 0);
      return {
        ok: false,
        error: `部分仓库已提交，但仓库 '${group.repoRoot}' 提交失败：${String(repoResult.error || "提交失败")}`,
        data: {
          commitSucceeded: true,
          completedRepoRoots,
          repoRoots: completedRepoRoots,
          failedRepoRoot: group.repoRoot,
          failedRepoError: String(repoResult.error || "提交失败"),
          commitHashes,
          includedPaths,
          selectionCount,
        },
      };
    }
    completedResults.push({
      repoRoot: group.repoRoot,
      data: repoResult.data,
    });
  }

  const commitHashes = completedResults
    .map((item) => ({
      repoRoot: item.repoRoot,
      commitHash: String(item.data?.commitHash || "").trim(),
    }))
    .filter((item) => !!item.commitHash);
  const renameCommitHashes = completedResults
    .map((item) => ({
      repoRoot: item.repoRoot,
      commitHash: String(item.data?.renameCommitHash || "").trim(),
    }))
    .filter((item) => !!item.commitHash);
  const includedPaths = Array.from(new Set(completedResults.flatMap((item) => item.data?.includedPaths || [])));
  const selectionCount = completedResults.reduce((sum, item) => sum + Number(item.data?.selectionCount || 0), 0);
  return attachPushAfterCommitContext({
    ok: true,
    data: {
      commitHash: commitHashes[0]?.commitHash,
      commitHashes,
      renameCommitHash: renameCommitHashes[0]?.commitHash,
      renameCommitHashes,
      includedPaths,
      selectionCount,
      repoRoots: completedResults.map((item) => item.repoRoot),
    },
  }, intent === "commitAndPush", completedResults.map((item) => item.repoRoot));
}
