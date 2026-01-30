// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { execGitAsync } from "./exec";
import { toFsPathAbs } from "./pathKey";
import { resolveRepoMainPathFromWorktreeAsync } from "./worktreeMetaResolve";
import { getWorktreeMeta, type WorktreeMeta } from "../stores/worktreeMetaStore";

export type WorktreeForkPointSource = "recorded" | "merge-base";

export type GitCommitSummary = {
  /** 完整提交号。 */
  sha: string;
  /** 短提交号（用于 UI 辅助展示）。 */
  shortSha: string;
  /** 提交标题（subject，单行）。 */
  subject: string;
  /** 作者时间戳（Unix 秒）。 */
  authorDateUnix: number;
};

export type WorktreeForkPointSnapshot = {
  /** 主 worktree 路径（用于 UI 打开外部工具/终端时定位仓库）。 */
  repoMainPath: string;
  /** 创建记录中的分叉点（可选）。 */
  recordedSha?: string;
  /** 创建记录对应的提交摘要（尽力解析；失败则为空）。 */
  recordedCommit?: GitCommitSummary;
  /** 创建记录中的分叉点是否适用于当前 base/wt 选择（baseBranch/wtBranch 与创建记录一致）。 */
  recordedApplies?: boolean;
  /** 自动推断（默认会优先使用创建记录；不适用时使用 merge-base）。 */
  sha: string;
  /** 自动推断对应的提交摘要（成功时必有）。 */
  autoCommit?: GitCommitSummary;
  source: WorktreeForkPointSource;
};

export type ResolveWorktreeForkPointResult =
  | { ok: true; forkPoint: WorktreeForkPointSnapshot }
  | { ok: false; error: string; forkPoint?: Partial<WorktreeForkPointSnapshot> };

/**
 * 中文说明：解析 worktree 的“分叉点”。
 *
 * 规则：
 * - 若存在创建记录分叉点（baseRefAtCreate）且 baseBranch/wtBranch 与创建记录一致，并且该提交仍为源分支祖先，则优先使用。
 * - 否则自动推断：git merge-base <baseBranch> <wtBranch>。
 * - 失败时不做“自动回退到完整回收”，只返回错误供 UI 展示/引导用户手动指定。
 */
export async function resolveWorktreeForkPointAsync(req: {
  worktreePath: string;
  baseBranch: string;
  wtBranch: string;
  gitPath?: string;
}): Promise<ResolveWorktreeForkPointResult> {
  const wt = toFsPathAbs(req.worktreePath);
  const baseBranch = String(req.baseBranch || "").trim();
  const wtBranch = String(req.wtBranch || "").trim();
  const gitPath = req.gitPath;
  if (!wt || !baseBranch || !wtBranch) return { ok: false, error: "missing args" };

  const meta = getWorktreeMeta(wt);
  let repoMainPath = toFsPathAbs(String(meta?.repoMainPath || ""));
  if (!repoMainPath) {
    const inferred = await resolveRepoMainPathFromWorktreeAsync({ worktreePath: wt, gitPath, timeoutMs: 12_000 });
    if (!inferred.ok) return { ok: false, error: inferred.error };
    repoMainPath = inferred.repoMainPath;
  }

  const recordedSha = String(meta?.baseRefAtCreate || "").trim() || undefined;
  const recordedApplies = isRecordedForkPointApplicable(meta, baseBranch, wtBranch);

  const resolveCommitSha = async (ref: string): Promise<string> => {
    const r = String(ref || "").trim();
    if (!r) return "";
    const res = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", "--verify", `${r}^{commit}`], timeoutMs: 12_000 });
    if (!res.ok) return "";
    return String(res.stdout || "").trim();
  };

  const isAncestor = async (maybeAncestorSha: string): Promise<boolean> => {
    const sha = String(maybeAncestorSha || "").trim();
    if (!sha) return false;
    const res = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "merge-base", "--is-ancestor", sha, wtBranch], timeoutMs: 12_000 });
    return res.exitCode === 0;
  };

  const recordedCommit = recordedSha ? (await getCommitSummaryAsync({ repoMainPath, gitPath, ref: recordedSha })) || undefined : undefined;

  // 1) 优先使用“创建记录”的分叉点（仅当它适用于当前分支选择）
  if (recordedApplies && recordedSha) {
    const sha = await resolveCommitSha(recordedSha);
    if (sha && (await isAncestor(sha))) {
      const autoCommit = (recordedCommit && recordedCommit.sha === sha) ? recordedCommit : ((await getCommitSummaryAsync({ repoMainPath, gitPath, ref: sha })) || undefined);
      return { ok: true, forkPoint: { repoMainPath, recordedSha, recordedCommit, recordedApplies, sha, autoCommit, source: "recorded" } };
    }
  }

  // 2) 自动推断：merge-base
  const mb = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "merge-base", baseBranch, wtBranch], timeoutMs: 12_000 });
  if (!mb.ok) {
    const msg = String(mb.error || mb.stderr || mb.stdout || "").trim() || "git merge-base failed";
    return { ok: false, error: msg, forkPoint: { repoMainPath, recordedSha, recordedCommit, recordedApplies } };
  }
  const mbSha = String(mb.stdout || "").trim();
  const verified = await resolveCommitSha(mbSha);
  if (!verified) {
    return { ok: false, error: "merge-base sha is not a valid commit", forkPoint: { repoMainPath, recordedSha, recordedCommit, recordedApplies } };
  }
  const autoCommit = (await getCommitSummaryAsync({ repoMainPath, gitPath, ref: verified })) || undefined;
  return { ok: true, forkPoint: { repoMainPath, recordedSha, recordedCommit, recordedApplies, sha: verified, autoCommit, source: "merge-base" } };
}

/**
 * 中文说明：在主仓库中搜索源分支可达的提交列表（用于分叉点下拉框候选项）。
 * - 默认按提交时间倒序返回，条数受 limit 限制，避免大仓库卡顿。
 * - query 非空时使用 --grep 做主题过滤（fixed-string + ignore-case）。
 */
export async function searchForkPointCommitsAsync(args: {
  worktreePath: string;
  wtBranch: string;
  query?: string;
  limit?: number;
  gitPath?: string;
}): Promise<{ ok: true; items: GitCommitSummary[] } | { ok: false; error: string }> {
  const wt = toFsPathAbs(args.worktreePath);
  const wtBranch = String(args.wtBranch || "").trim();
  const query = String(args.query || "").trim();
  const gitPath = args.gitPath;
  const limitRaw = Number.isFinite(Number(args.limit)) ? Math.floor(Number(args.limit)) : 200;
  const limit = Math.max(20, Math.min(500, limitRaw || 200));
  if (!wt || !wtBranch) return { ok: false, error: "missing args" };

  const meta = getWorktreeMeta(wt);
  let repoMainPath = toFsPathAbs(String(meta?.repoMainPath || ""));
  if (!repoMainPath) {
    const inferred = await resolveRepoMainPathFromWorktreeAsync({ worktreePath: wt, gitPath, timeoutMs: 12_000 });
    if (!inferred.ok) return { ok: false, error: inferred.error };
    repoMainPath = inferred.repoMainPath;
  }

  const argv = ["-C", repoMainPath, "log", wtBranch, `--max-count=${limit}`, "--format=%H%x00%h%x00%s%x00%ct"];
  if (query) argv.push("--fixed-strings", "--regexp-ignore-case", `--grep=${query}`);
  const res = await execGitAsync({ gitPath, argv, timeoutMs: 12_000 });
  if (!res.ok) return { ok: false, error: String(res.error || res.stderr || res.stdout || "git log failed").trim() || "git log failed" };

  const text = String(res.stdout || "");
  const seen = new Set<string>();
  const items: GitCommitSummary[] = [];
  for (const line of text.split(/\r?\n/)) {
    const one = parseCommitSummaryLine(line);
    if (!one) continue;
    if (seen.has(one.sha)) continue;
    seen.add(one.sha);
    items.push(one);
  }
  return { ok: true, items };
}

/**
 * 中文说明：校验用户输入的分叉点引用（提交号/引用名），并返回可用于 UI 展示的提交摘要。
 * - 必须满足：ref 可解析为 commit，且该 commit 必须为源分支（wtBranch）的祖先。
 */
export async function validateForkPointRefAsync(args: {
  worktreePath: string;
  wtBranch: string;
  ref: string;
  gitPath?: string;
}): Promise<{ ok: true; commit: GitCommitSummary } | { ok: false; error: string }> {
  const wt = toFsPathAbs(args.worktreePath);
  const wtBranch = String(args.wtBranch || "").trim();
  const ref = String(args.ref || "").trim();
  const gitPath = args.gitPath;
  if (!wt || !wtBranch || !ref) return { ok: false, error: "missing args" };

  const meta = getWorktreeMeta(wt);
  let repoMainPath = toFsPathAbs(String(meta?.repoMainPath || ""));
  if (!repoMainPath) {
    const inferred = await resolveRepoMainPathFromWorktreeAsync({ worktreePath: wt, gitPath, timeoutMs: 12_000 });
    if (!inferred.ok) return { ok: false, error: inferred.error };
    repoMainPath = inferred.repoMainPath;
  }

  const rp = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", "--verify", `${ref}^{commit}`], timeoutMs: 12_000 });
  if (!rp.ok) return { ok: false, error: String(rp.error || rp.stderr || "invalid ref").trim() || "invalid ref" };
  const sha = String(rp.stdout || "").trim();
  if (!sha) return { ok: false, error: "invalid ref" };

  const anc = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "merge-base", "--is-ancestor", sha, wtBranch], timeoutMs: 12_000 });
  if (anc.exitCode !== 0) {
    const msg = anc.exitCode === 1 ? "分叉点不是源分支的祖先" : String(anc.error || anc.stderr || "validate fork point failed").trim() || "validate fork point failed";
    return { ok: false, error: msg };
  }

  const summary = await getCommitSummaryAsync({ repoMainPath, gitPath, ref: sha });
  if (!summary) return { ok: false, error: "无法读取提交信息" };
  return { ok: true, commit: summary };
}

/**
 * 中文说明：判断创建记录中的分叉点是否适用于当前 base/wt 分支选择。
 */
function isRecordedForkPointApplicable(meta: WorktreeMeta | null, baseBranch: string, wtBranch: string): boolean {
  if (!meta) return false;
  const b = String(meta.baseBranch || "").trim();
  const w = String(meta.wtBranch || "").trim();
  return b === String(baseBranch || "").trim() && w === String(wtBranch || "").trim();
}

/**
 * 中文说明：读取指定提交（ref/sha）的摘要信息，用于 UI 展示（subject + short sha）。
 */
async function getCommitSummaryAsync(args: { repoMainPath: string; gitPath?: string; ref: string }): Promise<GitCommitSummary | null> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const ref = String(args.ref || "").trim();
  if (!repoMainPath || !ref) return null;
  const res = await execGitAsync({
    gitPath: args.gitPath,
    argv: ["-C", repoMainPath, "show", "-s", "--format=%H%x00%h%x00%s%x00%ct", `${ref}^{commit}`],
    timeoutMs: 12_000,
  });
  if (!res.ok) return null;
  const line = String(res.stdout || "").split(/\r?\n/).find((x) => !!String(x || "").trim()) || "";
  return parseCommitSummaryLine(line);
}

/**
 * 中文说明：解析 `%H%x00%h%x00%s%x00%ct` 格式的一行输出为提交摘要。
 */
function parseCommitSummaryLine(line: string): GitCommitSummary | null {
  const raw = String(line || "");
  if (!raw) return null;
  const parts = raw.split("\u0000");
  if (parts.length < 4) return null;
  const sha = String(parts[0] || "").trim();
  const shortSha = String(parts[1] || "").trim();
  const subject = String(parts[2] || "").trim();
  const tsRaw = String(parts[3] || "").trim();
  const authorDateUnix = Math.max(0, Math.floor(Number(tsRaw) || 0));
  if (!sha) return null;
  return { sha, shortSha: shortSha || sha.slice(0, 7), subject: subject || "(no subject)", authorDateUnix };
}
