// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import type { GitExecResult } from "./exec";

export type GitCommitDetailsActionKey =
  | "editSource"
  | "openRepositoryVersion"
  | "revertSelectedChanges"
  | "applySelectedChanges"
  | "extractSelectedChanges"
  | "dropSelectedChanges"
  | "showHistoryForRevision";

export type GitCommitDetailsActionItem = {
  visible: boolean;
  enabled: boolean;
  reason?: string;
};

export type GitCommitDetailsActionAvailability = {
  actions: Record<GitCommitDetailsActionKey, GitCommitDetailsActionItem>;
};

export type GitCommitDetailsSelectionChange = {
  path: string;
  oldPath?: string;
  status?: string;
};

export type GitCommitDetailsActionAvailabilityPayload = {
  hash?: string;
  selectedChanges?: GitCommitDetailsSelectionChange[];
  allChanges?: GitCommitDetailsSelectionChange[];
};

export type GitCommitDetailsHistoryRewriteMode = "extract" | "drop";

export type GitCommitDetailsHistoryRewritePayload = {
  hash?: string;
  selectedChanges?: GitCommitDetailsSelectionChange[];
  allChanges?: GitCommitDetailsSelectionChange[];
  message?: string;
};

export type GitCommitDetailsPatchApplyMode = "apply" | "revert";

export type GitCommitDetailsPatchApplyPayload = {
  hash?: string;
  selectedChanges?: GitCommitDetailsSelectionChange[];
};

export type GitCommitDetailsOpenRepositoryVersionPayload = {
  hash?: string;
  selectedChanges?: GitCommitDetailsSelectionChange[];
};

export type GitCommitDetailsOpenRepositoryVersionResult = {
  files: Array<{
    path: string;
    tempPath: string;
  }>;
};

export type GitCommitDetailsRuntime = {
  runGitExecAsync(repoRoot: string, argv: string[], timeoutMs: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult>;
  runGitSpawnAsync(repoRoot: string, argv: string[], timeoutMs: number, envPatch?: NodeJS.ProcessEnv): Promise<GitExecResult>;
  getHeadFirstParentNodesAsync(repoRoot: string): Promise<Array<{ hash: string; parentCount: number }>>;
  getRepositoryOperationStateAsync(repoRoot: string): Promise<"normal" | "rebasing" | "merging" | "grafting" | "reverting">;
  toGitErrorMessage(res: GitExecResult, fallback: string): string;
  writeTempFileAsync(prefix: string, content: string, options?: { fileNameHint?: string }): Promise<string>;
};

type NormalizedSelectionChange = {
  path: string;
  oldPath?: string;
  status: string;
};

type CommitMetadata = {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  message: string;
};

const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * 规整 details action 里传入的 committed changes 选择，统一去重并保留 rename oldPath 信息。
 */
function normalizeSelectionChanges(changesInput: GitCommitDetailsSelectionChange[]): NormalizedSelectionChange[] {
  const result: NormalizedSelectionChange[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(changesInput) ? changesInput : []) {
    const filePath = String(raw?.path || "").trim().replace(/\\/g, "/");
    if (!filePath) continue;
    const oldPath = String(raw?.oldPath || "").trim().replace(/\\/g, "/") || undefined;
    const status = String(raw?.status || "").trim().toUpperCase();
    const key = `${filePath}\u0000${oldPath || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      path: filePath,
      oldPath,
      status,
    });
  }
  return result;
}

/**
 * 把 selected/all changes 转成稳定路径集合，便于判断“是否全选提交内全部更改”。
 */
function buildSelectionPathSet(changes: NormalizedSelectionChange[]): Set<string> {
  return new Set(
    changes
      .flatMap((change) => [change.path, change.oldPath || ""])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  );
}

/**
 * 根据状态码判断当前 change 是否为 rename/copy，后续 patch pathspec 需要同时带上新旧路径。
 */
function isRenameLikeChange(change: NormalizedSelectionChange): boolean {
  const statusCode = String(change.status || "").trim().toUpperCase()[0] || "";
  return (statusCode === "R" || statusCode === "C") && !!String(change.oldPath || "").trim();
}

/**
 * 判断 committed change 在目标提交中是否仍有仓库版本；删除文件不应暴露“打开仓库版本”。
 */
function hasRepositoryVersion(change: NormalizedSelectionChange): boolean {
  const statusCode = String(change.status || "").trim().toUpperCase()[0] || "";
  return statusCode !== "D";
}

/**
 * 为 patch 生成 pathspec；rename/copy 同时包含新旧路径，避免 patch 丢失 rename 头信息。
 */
function buildPatchPathspecs(changes: NormalizedSelectionChange[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    const currentPath = String(change.path || "").trim();
    if (currentPath && !seen.has(currentPath)) {
      seen.add(currentPath);
      result.push(currentPath);
    }
    const oldPath = String(change.oldPath || "").trim();
    if (isRenameLikeChange(change) && oldPath && !seen.has(oldPath)) {
      seen.add(oldPath);
      result.push(oldPath);
    }
  }
  return result;
}

/**
 * 判断当前 selection 是否覆盖了单个提交中的全部 committed changes。
 */
function isAllChangesSelected(selectedChanges: NormalizedSelectionChange[], allChanges: NormalizedSelectionChange[]): boolean {
  if (selectedChanges.length <= 0 || allChanges.length <= 0) return false;
  if (selectedChanges.length < allChanges.length) return false;
  const selectedPaths = buildSelectionPathSet(selectedChanges);
  const allPaths = buildSelectionPathSet(allChanges);
  if (selectedPaths.size < allPaths.size) return false;
  for (const filePath of allPaths) {
    if (!selectedPaths.has(filePath)) return false;
  }
  return true;
}

/**
 * 判断当前文件是否仍存在于工作区，用于 `Edit Source` 的 navigatable gating。
 */
async function fileExistsAsync(repoRoot: string, filePath: string): Promise<boolean> {
  const absolutePath = path.join(repoRoot, filePath);
  try {
    await fsp.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 统一创建 details action 可用性项，避免前后端各自拼 visible/enabled 默认值。
 */
function buildAvailabilityItem(visible: boolean, enabled: boolean, reason?: string): GitCommitDetailsActionItem {
  return {
    visible,
    enabled,
    reason: String(reason || "").trim() || undefined,
  };
}

/**
 * 读取当前分支名；为空时表示 Detached HEAD。
 */
async function readCurrentBranchAsync(runtime: GitCommitDetailsRuntime, repoRoot: string): Promise<string> {
  const res = await runtime.runGitExecAsync(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 10_000);
  return res.ok ? String(res.stdout || "").trim() : "";
}

/**
 * 读取单个提交的 author/message 元数据，供 replay commit 时复用。
 */
async function readCommitMetadataAsync(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  hash: string,
): Promise<{ ok: true; data: CommitMetadata } | { ok: false; error: string }> {
  const res = await runtime.runGitExecAsync(
    repoRoot,
    ["show", "-s", "--format=%H%x00%an%x00%ae%x00%aI%x00%B", hash],
    12_000,
  );
  if (!res.ok)
    return { ok: false, error: runtime.toGitErrorMessage(res, "读取提交元数据失败") };
  const fields = String(res.stdout || "").split("\x00");
  const commitHash = String(fields[0] || "").trim();
  if (!commitHash)
    return { ok: false, error: "读取提交元数据失败" };
  return {
    ok: true,
    data: {
      hash: commitHash,
      authorName: String(fields[1] || "").trim(),
      authorEmail: String(fields[2] || "").trim(),
      authorDate: String(fields[3] || "").trim(),
      message: fields.slice(4).join("\x00").replace(/\s+$/, ""),
    },
  };
}

/**
 * 读取单个提交的 first-parent 父提交哈希；root commit 返回空字符串。
 */
async function readFirstParentHashAsync(runtime: GitCommitDetailsRuntime, repoRoot: string, hash: string): Promise<string> {
  const res = await runtime.runGitExecAsync(repoRoot, ["rev-parse", `${hash}^`], 10_000);
  return res.ok ? String(res.stdout || "").trim() : "";
}

/**
 * 读取当前临时 worktree 中是否存在已暂存改动；空 patch 会直接跳过提交。
 */
async function hasStagedChangesAsync(runtime: GitCommitDetailsRuntime, repoRoot: string): Promise<boolean> {
  const res = await runtime.runGitExecAsync(repoRoot, ["diff", "--cached", "--name-only"], 10_000);
  if (!res.ok) return false;
  return String(res.stdout || "")
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .length > 0;
}

/**
 * 生成单个提交的全量 patch，后续通过 `git apply --3way --index` 在临时 worktree 中重放。
 */
async function buildCommitPatchAsync(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  parentHash: string,
  commitHash: string,
  pathspecs?: string[],
): Promise<{ ok: true; patch: string } | { ok: false; error: string }> {
  const argv = [
    "diff",
    "--binary",
    "--find-renames",
    "--full-index",
    parentHash || EMPTY_TREE_HASH,
    commitHash,
  ];
  const normalizedPathspecs = Array.from(new Set(
    (Array.isArray(pathspecs) ? pathspecs : [])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
  if (normalizedPathspecs.length > 0) argv.push("--", ...normalizedPathspecs);
  const res = await runtime.runGitExecAsync(repoRoot, argv, 20_000);
  if (!res.ok)
    return { ok: false, error: runtime.toGitErrorMessage(res, "读取提交补丁失败") };
  return { ok: true, patch: String(res.stdout || "") };
}

/**
 * 在临时 worktree 中应用 patch；失败时统一返回用户可读错误。
 */
async function applyPatchAsync(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  patchFile: string,
  mode: "forward" | "reverse",
  fallback: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const argv = ["apply", "--3way", "--index"];
  if (mode === "reverse") argv.push("-R");
  argv.push("--whitespace=nowarn", patchFile);
  const res = await runtime.runGitSpawnAsync(repoRoot, argv, 120_000);
  if (!res.ok)
    return { ok: false, error: runtime.toGitErrorMessage(res, fallback) };
  return { ok: true };
}

/**
 * 把 committed changes patch 应用到当前工作区；正向应用优先尝试 3-way，以减少因上下文轻微漂移导致的 `patch does not apply`。
 */
async function applyPatchToWorkspaceAsync(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  patchFile: string,
  mode: GitCommitDetailsPatchApplyMode,
  fallback: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const candidates = mode === "apply"
    ? [
        ["apply", "--whitespace=nowarn", patchFile],
        ["apply", "--3way", "--whitespace=nowarn", patchFile],
      ]
    : [
        ["apply", "-R", "--whitespace=nowarn", patchFile],
      ];
  let lastRes: GitExecResult | null = null;
  for (const argv of candidates) {
    const res = await runtime.runGitSpawnAsync(repoRoot, argv, 120_000);
    if (res.ok) return { ok: true };
    lastRes = res;
  }
  return {
    ok: false,
    error: lastRes ? runtime.toGitErrorMessage(lastRes, fallback) : fallback,
  };
}

/**
 * 在临时 worktree 中创建一个重放后的提交；普通 replay 复用 `-C` 保持原 message/author。
 */
async function commitReplayAsync(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  commitHash: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await runtime.runGitSpawnAsync(repoRoot, ["commit", "--no-verify", "-C", commitHash], 120_000);
  if (!res.ok)
    return { ok: false, error: runtime.toGitErrorMessage(res, "写入重放提交失败") };
  return { ok: true };
}

/**
 * 为“提取到单独提交”写入新的 commit；默认沿用原提交 author/date，仅替换 message。
 */
async function commitExtractedAsync(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  sourceCommit: CommitMetadata,
  message: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const messageFile = await runtime.writeTempFileAsync("git-details-extract-message", message);
  try {
    const envPatch: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: sourceCommit.authorName || undefined,
      GIT_AUTHOR_EMAIL: sourceCommit.authorEmail || undefined,
      GIT_AUTHOR_DATE: sourceCommit.authorDate || undefined,
      GIT_COMMITTER_DATE: sourceCommit.authorDate || undefined,
    };
    const res = await runtime.runGitSpawnAsync(
      repoRoot,
      ["commit", "--no-verify", "-F", messageFile],
      120_000,
      envPatch,
    );
    if (!res.ok)
      return { ok: false, error: runtime.toGitErrorMessage(res, "写入提取提交失败") };
    return { ok: true };
  } finally {
    try {
      await fsp.rm(messageFile, { force: true });
    } catch {}
  }
}

/**
 * 在临时 worktree 上完成一次细粒度历史重写，并返回新的 HEAD 哈希。
 */
async function replayHistoryAsync(
  runtime: GitCommitDetailsRuntime,
  tempRepoRoot: string,
  chainOldestToNewest: string[],
  targetHash: string,
  selectedPatch: string,
  mode: GitCommitDetailsHistoryRewriteMode,
  extractMessage: string,
): Promise<{ ok: true; newHead: string } | { ok: false; error: string }> {
  let previousHash = await readFirstParentHashAsync(runtime, tempRepoRoot, targetHash);
  const selectedPatchFile = await runtime.writeTempFileAsync("git-details-selected-changes", selectedPatch);
  try {
    for (const commitHash of chainOldestToNewest) {
      const patchRes = await buildCommitPatchAsync(runtime, tempRepoRoot, previousHash || EMPTY_TREE_HASH, commitHash);
      if (!patchRes.ok) return patchRes;
      const fullPatchFile = await runtime.writeTempFileAsync("git-details-full-commit", patchRes.patch);
      try {
        const applyRes = await applyPatchAsync(runtime, tempRepoRoot, fullPatchFile, "forward", "重放提交补丁失败");
        if (!applyRes.ok) return applyRes;
      } finally {
        try {
          await fsp.rm(fullPatchFile, { force: true });
        } catch {}
      }

      if (commitHash === targetHash) {
        const reverseRes = await applyPatchAsync(runtime, tempRepoRoot, selectedPatchFile, "reverse", "移除所选更改失败");
        if (!reverseRes.ok) return reverseRes;
        if (await hasStagedChangesAsync(runtime, tempRepoRoot)) {
          const commitRes = await commitReplayAsync(runtime, tempRepoRoot, commitHash);
          if (!commitRes.ok) return commitRes;
        }
        if (mode === "extract") {
          const metadataRes = await readCommitMetadataAsync(runtime, tempRepoRoot, commitHash);
          if (!metadataRes.ok) return metadataRes;
          const forwardRes = await applyPatchAsync(runtime, tempRepoRoot, selectedPatchFile, "forward", "恢复所选更改失败");
          if (!forwardRes.ok) return forwardRes;
          if (!(await hasStagedChangesAsync(runtime, tempRepoRoot)))
            return { ok: false, error: "提取所选更改失败：目标补丁为空" };
          const commitExtractedRes = await commitExtractedAsync(runtime, tempRepoRoot, metadataRes.data, extractMessage);
          if (!commitExtractedRes.ok) return commitExtractedRes;
        }
      } else {
        if (!(await hasStagedChangesAsync(runtime, tempRepoRoot))) {
          previousHash = commitHash;
          continue;
        }
        const commitRes = await commitReplayAsync(runtime, tempRepoRoot, commitHash);
        if (!commitRes.ok) return commitRes;
      }
      previousHash = commitHash;
    }
    const headRes = await runtime.runGitExecAsync(tempRepoRoot, ["rev-parse", "HEAD"], 10_000);
    if (!headRes.ok)
      return { ok: false, error: runtime.toGitErrorMessage(headRes, "读取改写后 HEAD 失败") };
    const newHead = String(headRes.stdout || "").trim();
    if (!newHead)
      return { ok: false, error: "读取改写后 HEAD 失败" };
    return { ok: true, newHead };
  } finally {
    try {
      await fsp.rm(selectedPatchFile, { force: true });
    } catch {}
  }
}

/**
 * 创建一次隔离的临时 worktree，让细粒度历史重写不会污染用户当前工作树。
 */
async function withTemporaryWorktreeAsync<T>(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  startHash: string,
  runAsync: (tempRepoRoot: string) => Promise<T>,
): Promise<T> {
  const tempRepoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-git-details-"));
  let added = false;
  try {
    const addRes = await runtime.runGitSpawnAsync(repoRoot, ["worktree", "add", "--detach", tempRepoRoot, startHash], 180_000);
    if (!addRes.ok)
      throw new Error(runtime.toGitErrorMessage(addRes, "创建临时重写工作树失败"));
    added = true;
    return await runAsync(tempRepoRoot);
  } finally {
    if (added) {
      try {
        await runtime.runGitSpawnAsync(repoRoot, ["worktree", "remove", "--force", tempRepoRoot], 180_000);
      } catch {}
    }
    try {
      await fsp.rm(tempRepoRoot, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * 读取 details 右键动作可用性，确保 edit/extract/drop 按 selected committed changes 语义 gating。
 */
export async function getCommitDetailsActionAvailabilityAsync(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  payload: GitCommitDetailsActionAvailabilityPayload,
): Promise<GitCommitDetailsActionAvailability> {
  const selectedChanges = normalizeSelectionChanges(payload.selectedChanges || []);
  const allChanges = normalizeSelectionChanges(payload.allChanges || []);
  const hash = String(payload.hash || "").trim();
  const allSelected = isAllChangesSelected(selectedChanges, allChanges);
  const firstSelection = selectedChanges[0] || null;
  const hasSelection = selectedChanges.length > 0;
  const currentBranch = await readCurrentBranchAsync(runtime, repoRoot);
  const operationState = await runtime.getRepositoryOperationStateAsync(repoRoot);
  const headNodes = hash ? await runtime.getHeadFirstParentNodesAsync(repoRoot) : [];
  const targetNode = headNodes.find((node) => node.hash === hash) || null;
  const inHeadHistory = !!targetNode;
  const isMergeCommit = (targetNode?.parentCount || 0) > 1;
  const isRootCommit = (targetNode?.parentCount || 0) === 0 && !!targetNode;
  const editSourceEnabled = hasSelection
    && selectedChanges.length === 1
    && !!firstSelection
    && await fileExistsAsync(repoRoot, firstSelection.path);
  const openRepositoryVersionEnabled = hasSelection && selectedChanges.some(hasRepositoryVersion);
  const blockedReason = !currentBranch
    ? "当前处于 Detached HEAD，无法执行该操作"
    : operationState !== "normal"
      ? "当前仓库已有进行中的 Git 操作"
      : !inHeadHistory
        ? "提交不在当前 HEAD 历史线上"
        : isMergeCommit
          ? "合并提交不支持该操作"
          : isRootCommit
            ? "根提交不支持该操作"
            : "";
  const selectedAllReason = "已选中该提交中的全部更改，无法继续拆分或删除部分更改";

  return {
    actions: {
      editSource: buildAvailabilityItem(editSourceEnabled, editSourceEnabled),
      openRepositoryVersion: hasSelection
        ? buildAvailabilityItem(true, openRepositoryVersionEnabled, openRepositoryVersionEnabled ? undefined : "所选更改在仓库版本中不存在")
        : buildAvailabilityItem(false, false),
      revertSelectedChanges: hasSelection
        ? buildAvailabilityItem(true, !!hash)
        : buildAvailabilityItem(false, false),
      applySelectedChanges: hasSelection
        ? buildAvailabilityItem(true, !!hash)
        : buildAvailabilityItem(false, false),
      extractSelectedChanges: hasSelection
        ? buildAvailabilityItem(true, !allSelected && !blockedReason, allSelected ? selectedAllReason : blockedReason || undefined)
        : buildAvailabilityItem(false, false),
      dropSelectedChanges: hasSelection
        ? buildAvailabilityItem(true, !allSelected && !blockedReason, allSelected ? selectedAllReason : blockedReason || undefined)
        : buildAvailabilityItem(false, false),
      showHistoryForRevision: buildAvailabilityItem(hasSelection, hasSelection && selectedChanges.length === 1, selectedChanges.length === 1 ? undefined : "仅支持单个已选文件"),
    },
  };
}

/**
 * 把 committed file 的仓库版本导出到临时文件，供前端按只读文件语义打开。
 */
export async function openCommitDetailsRepositoryVersionAsync(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  payload: GitCommitDetailsOpenRepositoryVersionPayload,
): Promise<{ ok: true; data: GitCommitDetailsOpenRepositoryVersionResult } | { ok: false; error: string }> {
  const hash = String(payload.hash || "").trim();
  const selectedChanges = normalizeSelectionChanges(payload.selectedChanges || []).filter(hasRepositoryVersion);
  if (!hash) return { ok: false, error: "缺少提交哈希" };
  if (selectedChanges.length <= 0) return { ok: false, error: "所选更改在仓库版本中不存在" };

  const files: GitCommitDetailsOpenRepositoryVersionResult["files"] = [];
  for (const change of selectedChanges) {
    const showRes = await runtime.runGitExecAsync(repoRoot, ["show", `${hash}:${change.path}`], 20_000);
    if (!showRes.ok)
      return { ok: false, error: runtime.toGitErrorMessage(showRes, "读取仓库版本失败") };
    const tempPath = await runtime.writeTempFileAsync("git-details-repository-version", String(showRes.stdout || ""), {
      fileNameHint: change.path,
    });
    files.push({
      path: change.path,
      tempPath,
    });
  }
  return {
    ok: true,
    data: { files },
  };
}

/**
 * 把 selected committed changes 以正向/反向 patch 形式应用到当前工作区，对齐 IDEA 的 Apply/Revert Selected Changes。
 */
export async function applyCommitDetailsSelectionPatchAsync(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  mode: GitCommitDetailsPatchApplyMode,
  payload: GitCommitDetailsPatchApplyPayload,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hash = String(payload.hash || "").trim();
  const selectedChanges = normalizeSelectionChanges(payload.selectedChanges || []);
  if (!hash) return { ok: false, error: "缺少提交哈希" };
  if (selectedChanges.length <= 0) return { ok: false, error: "缺少所选更改" };

  const parentHash = await readFirstParentHashAsync(runtime, repoRoot, hash);
  const patchRes = await buildCommitPatchAsync(runtime, repoRoot, parentHash || EMPTY_TREE_HASH, hash, buildPatchPathspecs(selectedChanges));
  if (!patchRes.ok) return patchRes;
  if (!String(patchRes.patch || "").trim())
    return { ok: false, error: "所选更改无法生成有效补丁" };

  const patchFile = await runtime.writeTempFileAsync(
    mode === "revert" ? "git-details-revert-selected-changes" : "git-details-apply-selected-changes",
    patchRes.patch,
    { fileNameHint: mode === "revert" ? "revert-selected-changes.patch" : "apply-selected-changes.patch" },
  );
  try {
    return await applyPatchToWorkspaceAsync(
      runtime,
      repoRoot,
      patchFile,
      mode,
      mode === "revert" ? "还原所选更改失败" : "优选所选更改失败",
    );
  } finally {
    try {
      await fsp.rm(patchFile, { force: true });
    } catch {}
  }
}

/**
 * 执行“提取到单独提交 / 删除所选更改”的 committed changes 历史重写。
 * 这里不再碰 working tree 当前文件，而是在隔离 worktree 中按原提交链重放，再一次性回写当前分支。
 */
export async function runCommitDetailsHistoryRewriteAsync(
  runtime: GitCommitDetailsRuntime,
  repoRoot: string,
  mode: GitCommitDetailsHistoryRewriteMode,
  payload: GitCommitDetailsHistoryRewritePayload,
): Promise<{ ok: true; newHead: string } | { ok: false; error: string }> {
  const hash = String(payload.hash || "").trim();
  const selectedChanges = normalizeSelectionChanges(payload.selectedChanges || []);
  const allChanges = normalizeSelectionChanges(payload.allChanges || []);
  const extractMessage = String(payload.message || "").trim();
  if (!hash) return { ok: false, error: "缺少提交哈希" };
  if (selectedChanges.length <= 0) return { ok: false, error: "缺少所选更改" };
  if (mode === "extract" && !extractMessage) return { ok: false, error: "提取提交信息不能为空" };
  if (isAllChangesSelected(selectedChanges, allChanges))
    return { ok: false, error: "已选中该提交中的全部更改，无法继续拆分或删除部分更改" };

  const currentBranch = await readCurrentBranchAsync(runtime, repoRoot);
  if (!currentBranch) return { ok: false, error: "当前处于 Detached HEAD，无法执行该操作" };

  const headNodes = await runtime.getHeadFirstParentNodesAsync(repoRoot);
  const targetIndex = headNodes.findIndex((node) => node.hash === hash);
  if (targetIndex < 0) return { ok: false, error: "提交不在当前 HEAD 历史线上" };
  if ((headNodes[targetIndex]?.parentCount || 0) <= 0) return { ok: false, error: "根提交不支持该操作" };
  if (headNodes.slice(0, targetIndex + 1).some((node) => node.parentCount !== 1))
    return { ok: false, error: "提交路径包含合并提交，当前操作仅支持线性历史" };

  const parentHash = await readFirstParentHashAsync(runtime, repoRoot, hash);
  if (!parentHash) return { ok: false, error: "读取目标提交父提交失败" };
  const selectedPatchRes = await buildCommitPatchAsync(runtime, repoRoot, parentHash, hash, buildPatchPathspecs(selectedChanges));
  if (!selectedPatchRes.ok) return selectedPatchRes;
  if (!String(selectedPatchRes.patch || "").trim())
    return { ok: false, error: "所选更改无法生成有效补丁" };

  const chainOldestToNewest = headNodes
    .slice(0, targetIndex + 1)
    .map((node) => node.hash)
    .reverse();
  try {
    const replayRes = await withTemporaryWorktreeAsync(runtime, repoRoot, parentHash, async (tempRepoRoot) => {
      return await replayHistoryAsync(
        runtime,
        tempRepoRoot,
        chainOldestToNewest,
        hash,
        selectedPatchRes.patch,
        mode,
        extractMessage,
      );
    });
    if (!replayRes.ok) return replayRes;
    const resetRes = await runtime.runGitSpawnAsync(repoRoot, ["reset", "--hard", replayRes.newHead], 180_000);
    if (!resetRes.ok)
      return { ok: false, error: runtime.toGitErrorMessage(resetRes, "更新当前分支失败") };
    return replayRes;
  } catch (error) {
    return {
      ok: false,
      error: String((error as Error)?.message || error || "提交历史改写失败"),
    };
  }
}
